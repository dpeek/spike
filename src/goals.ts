import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const GOAL_SCHEMA_VERSION = 1;
export const ACTIVE_GOAL_POINTER_SCHEMA_VERSION = 1;

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export type GoalRecord = {
  schemaVersion: 1;
  goalId: string;
  status: "active";
  repositoryRoot: string;
  projectId: string;
  repositoryRevision: string;
  goalPath: string;
  approvedBlob: string;
  approvalStatement: string;
  activatedAt: string;
  acceptedCodeRevision: string;
  snapshotPath: string;
  snapshotSha256: string;
  snapshotBytes: number;
};

export type ActiveGoalPointer = {
  schemaVersion: 1;
  goalId: string;
  projectId: string;
  recordPath: string;
};

export type ActiveGoal = {
  record: GoalRecord;
  snapshot: Buffer;
};

export type ActivationResult = ActiveGoal & { idempotent: boolean };

type GitResult = { code: number; stdout: Buffer; stderr: string };

type GoalContext = {
  root: string;
  workingDirectory: string;
  stateDir: string;
  goalsDir: string;
  projectId: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobId(bytes: Uint8Array, objectId: string): string {
  const algorithm = objectId.length === 40 ? "sha1" : "sha256";
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function projectIdentity(root: string): string {
  return `project-${sha256(`spike-project\0${root}`).slice(0, 32)}`;
}

function goalIdentity(projectId: string, revision: string, blob: string, approval: string): string {
  const identity = JSON.stringify({ projectId, revision, blob, approval });
  return `goal-${sha256(`spike-goal-v1\0${identity}`).slice(0, 32)}`;
}

async function runGit(root: string, args: string[], input?: Uint8Array): Promise<GitResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["git", "-C", root, ...args], {
      stdin: input ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  } catch (error) {
    return { code: 127, stdout: Buffer.alloc(0), stderr: error instanceof Error ? error.message : String(error) };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: Buffer.from(stdout), stderr: stderr.trim() };
}

function output(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

function gitError(result: GitResult): string {
  return result.stderr || output(result) || `exit code ${result.code}`;
}

async function discoverContext(cwd: string): Promise<GoalContext> {
  const requested = resolve(cwd);
  const discovered = await runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (discovered.code !== 0) throw new Error(`${requested} is not a Git repository`);
  const root = await realpath(output(discovered));
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.code !== 0) throw new Error("the repository must have at least one commit");
  const workingDirectory = await realpath(requested);
  const stateDir = join(root, ".pi-swarm");
  return { root, workingDirectory, stateDir, goalsDir: join(stateDir, "goals"), projectId: projectIdentity(root) };
}

function toProjectRelative(root: string, path: string, label: string): string {
  const result = relative(root, path);
  if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error(`${label} is outside the current repository: ${path}`);
  }
  return result.split(sep).join("/");
}

function resolveRecordedPath(root: string, recordedPath: string, label: string, boundary?: string): string {
  if (typeof recordedPath !== "string" || !recordedPath || isAbsolute(recordedPath) || recordedPath.includes("\0")) {
    throw new Error(`${label} must be a project-relative path`);
  }
  const absolute = resolve(root, recordedPath);
  const rootPrefix = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(rootPrefix)) throw new Error(`${label} escapes the project repository`);
  if (boundary) {
    const boundaryPath = resolve(boundary);
    if (absolute !== boundaryPath && !absolute.startsWith(`${boundaryPath}${sep}`)) {
      throw new Error(`${label} is outside the active goal directory`);
    }
  }
  const normalized = relative(root, absolute).split(sep).join("/");
  if (normalized !== recordedPath) throw new Error(`${label} is not normalized`);
  return absolute;
}

async function rejectSymlinkComponents(root: string, path: string, label: string): Promise<void> {
  const relativePath = relative(root, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} is outside the expected boundary`);
  }
  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readSmallJson(path: string, label: string, limit: number): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} is missing`);
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > limit) throw new Error(`${label} is unexpectedly large`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, options: { nonBlank?: boolean; pattern?: RegExp } = {}): asserts value is string {
  if (typeof value !== "string" || !value || (options.nonBlank && !value.trim()) || (options.pattern && !options.pattern.test(value))) {
    throw new Error(`goal record has an invalid ${field}`);
  }
}

function requireObjectId(value: unknown, field: string): asserts value is string {
  requireString(value, field, { pattern: objectIdPattern });
}

export function validateActiveGoalPointer(value: unknown, expected: { root: string; goalsDir: string; projectId: string }): ActiveGoalPointer {
  const pointer = requireObject(value, "active goal pointer");
  if (pointer.schemaVersion !== ACTIVE_GOAL_POINTER_SCHEMA_VERSION) {
    throw new Error(`unsupported active goal pointer schema: ${String(pointer.schemaVersion)}`);
  }
  if (typeof pointer.goalId !== "string" || !goalIdPattern.test(pointer.goalId)) throw new Error("active goal pointer has an invalid goalId");
  if (pointer.projectId !== expected.projectId) throw new Error("active goal pointer belongs to a different project");
  const expectedRecord = `.pi-swarm/goals/${pointer.goalId}/record.v1.json`;
  if (pointer.recordPath !== expectedRecord) throw new Error("active goal pointer has an invalid recordPath");
  resolveRecordedPath(expected.root, expectedRecord, "active goal record path", join(expected.goalsDir, pointer.goalId));
  return pointer as ActiveGoalPointer;
}

export function validateGoalRecord(value: unknown, expected: { root: string; projectId: string; goalId: string; goalsDir: string }): GoalRecord {
  const record = requireObject(value, "goal record");
  if (record.schemaVersion !== GOAL_SCHEMA_VERSION) throw new Error(`unsupported goal record schema: ${String(record.schemaVersion)}`);
  if (record.goalId !== expected.goalId || typeof record.goalId !== "string" || !goalIdPattern.test(record.goalId)) {
    throw new Error("goal record identity does not match the active pointer");
  }
  if (record.status !== "active") throw new Error("goal record has an invalid status");
  if (record.repositoryRoot !== expected.root) throw new Error("goal record belongs to a different repository root");
  if (record.projectId !== expected.projectId) throw new Error("goal record belongs to a different project");
  requireObjectId(record.repositoryRevision, "repositoryRevision");
  requireString(record.goalPath, "goalPath");
  resolveRecordedPath(expected.root, record.goalPath, "recorded goal path");
  requireObjectId(record.approvedBlob, "approvedBlob");
  requireString(record.approvalStatement, "approvalStatement", { nonBlank: true });
  requireString(record.activatedAt, "activatedAt");
  const activatedAt = new Date(record.activatedAt);
  if (!Number.isFinite(activatedAt.getTime()) || activatedAt.toISOString() !== record.activatedAt) {
    throw new Error("goal record has an invalid activatedAt timestamp");
  }
  requireObjectId(record.acceptedCodeRevision, "acceptedCodeRevision");
  const expectedSnapshot = `.pi-swarm/goals/${record.goalId}/approved.md`;
  if (record.snapshotPath !== expectedSnapshot) throw new Error("goal record has an invalid snapshotPath");
  resolveRecordedPath(expected.root, expectedSnapshot, "approved goal snapshot path", join(expected.goalsDir, record.goalId));
  requireString(record.snapshotSha256, "snapshotSha256", { pattern: /^[0-9a-f]{64}$/ });
  if (!Number.isSafeInteger(record.snapshotBytes) || (record.snapshotBytes as number) < 0 || (record.snapshotBytes as number) > MAX_SNAPSHOT_BYTES) {
    throw new Error("goal record has an invalid snapshotBytes");
  }
  const identity = goalIdentity(record.projectId as string, record.repositoryRevision, record.approvedBlob, record.approvalStatement);
  if (identity !== record.goalId) throw new Error("goal record stable identity is invalid");
  return record as GoalRecord;
}

async function loadActiveFromContext(context: GoalContext, allowMissing: boolean): Promise<ActiveGoal | undefined> {
  await rejectSymlinkComponents(context.root, context.stateDir, "Spike state path");
  await rejectSymlinkComponents(context.root, context.goalsDir, "goal state path");
  const pointerPath = join(context.goalsDir, "active.json");
  await rejectSymlinkComponents(context.root, pointerPath, "active goal pointer path");
  try {
    await access(pointerPath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("no active goal; activate one with spike goal activate <goal-file> --approval <statement>");
    throw error;
  }
  const pointer = validateActiveGoalPointer(await readSmallJson(pointerPath, "active goal pointer", MAX_RECORD_BYTES), context);
  const goalDirectory = join(context.goalsDir, pointer.goalId);
  const recordPath = resolveRecordedPath(context.root, pointer.recordPath, "active goal record path", goalDirectory);
  await rejectSymlinkComponents(context.root, goalDirectory, "active goal directory");
  await rejectSymlinkComponents(context.root, recordPath, "active goal record path");
  const record = validateGoalRecord(await readSmallJson(recordPath, "active goal record", MAX_RECORD_BYTES), {
    ...context,
    goalId: pointer.goalId,
  });
  const snapshotPath = resolveRecordedPath(context.root, record.snapshotPath, "approved goal snapshot path", goalDirectory);
  await rejectSymlinkComponents(context.root, snapshotPath, "approved goal snapshot path");
  let snapshot: Buffer;
  try {
    const snapshotStat = await lstat(snapshotPath);
    if (!snapshotStat.isFile()) throw new Error("approved goal snapshot is not a regular file");
    if (snapshotStat.size !== record.snapshotBytes) throw new Error("approved goal snapshot integrity check failed");
    snapshot = await readFile(snapshotPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("approved goal snapshot is missing");
    if (error instanceof Error && error.message.startsWith("approved goal snapshot")) throw error;
    throw new Error(`cannot read approved goal snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (snapshot.byteLength !== record.snapshotBytes || sha256(snapshot) !== record.snapshotSha256 || gitBlobId(snapshot, record.approvedBlob) !== record.approvedBlob) {
    throw new Error("approved goal snapshot integrity check failed");
  }
  return { record, snapshot };
}

export async function loadActiveGoal(cwd = process.cwd()): Promise<ActiveGoal> {
  const context = await discoverContext(cwd);
  return (await loadActiveFromContext(context, false))!;
}

async function ensureStateDirectories(context: GoalContext): Promise<void> {
  await rejectSymlinkComponents(context.root, context.stateDir, "Spike state path");
  await mkdir(context.stateDir, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(context.root, context.stateDir, "Spike state path");
  await mkdir(context.goalsDir, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(context.root, context.goalsDir, "goal state path");
}

async function durableWrite(path: string, contents: string | Uint8Array): Promise<void> {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await durableWrite(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function inspectCandidate(context: GoalContext, goalFile: string, approvalStatement: string): Promise<{ record: GoalRecord; snapshot: Buffer }> {
  if (!approvalStatement || !approvalStatement.trim()) throw new Error("approval statement must be non-empty");
  if (!goalFile) throw new Error("goal activate requires a Markdown goal file");
  const absolute = resolve(context.workingDirectory, goalFile);
  const goalPath = toProjectRelative(context.root, absolute, "goal file");
  if (!/\.(?:md|markdown)$/i.test(goalPath)) throw new Error("goal file must be Markdown (.md or .markdown)");
  await rejectSymlinkComponents(context.root, absolute, "goal file");
  let stat;
  try { stat = await lstat(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`goal file does not exist: ${goalFile}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`goal file must not be a symbolic link: ${goalFile}`);
  if (!stat.isFile()) throw new Error(`goal file is not a regular file: ${goalFile}`);

  const literalPathspec = `:(literal)${goalPath}`;
  const tracked = await runGit(context.root, ["ls-files", "--error-unmatch", "--", literalPathspec]);
  if (tracked.code !== 0) throw new Error(`goal file is not tracked by Git: ${goalPath}`);
  const clean = await runGit(context.root, ["diff", "--quiet", "--no-ext-diff", "HEAD", "--", literalPathspec]);
  if (clean.code === 1) throw new Error(`goal file has uncommitted changes: ${goalPath}`);
  if (clean.code !== 0) throw new Error(`cannot compare goal file with HEAD: ${gitError(clean)}`);
  const revisionResult = await runGit(context.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const repositoryRevision = output(revisionResult);
  if (revisionResult.code !== 0 || !objectIdPattern.test(repositoryRevision)) throw new Error(`cannot resolve repository HEAD: ${gitError(revisionResult)}`);
  const blobResult = await runGit(context.root, ["rev-parse", "--verify", `${repositoryRevision}:${goalPath}`]);
  const approvedBlob = output(blobResult);
  if (blobResult.code !== 0 || !objectIdPattern.test(approvedBlob)) throw new Error(`goal file is not represented by a Git object at HEAD: ${goalPath}`);
  const typeResult = await runGit(context.root, ["cat-file", "-t", approvedBlob]);
  if (typeResult.code !== 0 || output(typeResult) !== "blob") throw new Error(`goal file is not represented by a Git blob at HEAD: ${goalPath}`);
  const contentResult = await runGit(context.root, ["cat-file", "blob", approvedBlob]);
  if (contentResult.code !== 0) throw new Error(`cannot read approved Git blob: ${gitError(contentResult)}`);
  if (contentResult.stdout.byteLength > MAX_SNAPSHOT_BYTES) throw new Error(`approved goal exceeds ${MAX_SNAPSHOT_BYTES} bytes`);

  // Recheck the input after reading the object so a normal concurrent edit is
  // rejected rather than silently approving a now-dirty source path.
  await rejectSymlinkComponents(context.root, absolute, "goal file");
  const finalStat = await lstat(absolute);
  if (!finalStat.isFile() || finalStat.isSymbolicLink()) throw new Error("goal file changed type during activation");
  const finalClean = await runGit(context.root, ["diff", "--quiet", "--no-ext-diff", "HEAD", "--", literalPathspec]);
  if (finalClean.code === 1) throw new Error(`goal file has uncommitted changes: ${goalPath}`);
  if (finalClean.code !== 0) throw new Error(`cannot compare goal file with HEAD: ${gitError(finalClean)}`);
  const finalRevision = await runGit(context.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (finalRevision.code !== 0 || output(finalRevision) !== repositoryRevision) throw new Error("repository HEAD changed during goal activation; retry");

  const goalId = goalIdentity(context.projectId, repositoryRevision, approvedBlob, approvalStatement);
  const snapshotPath = `.pi-swarm/goals/${goalId}/approved.md`;
  const snapshot = contentResult.stdout;
  const record: GoalRecord = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    goalId,
    status: "active",
    repositoryRoot: context.root,
    projectId: context.projectId,
    repositoryRevision,
    goalPath,
    approvedBlob,
    approvalStatement,
    activatedAt: new Date().toISOString(),
    acceptedCodeRevision: repositoryRevision,
    snapshotPath,
    snapshotSha256: sha256(snapshot),
    snapshotBytes: snapshot.byteLength,
  };
  validateGoalRecord(record, { ...context, goalId });
  return { record, snapshot };
}

async function installRecord(context: GoalContext, candidate: { record: GoalRecord; snapshot: Buffer }): Promise<void> {
  const finalDirectory = join(context.goalsDir, candidate.record.goalId);
  try {
    await access(finalDirectory, constants.F_OK);
    const existingRecordPath = join(finalDirectory, "record.v1.json");
    await rejectSymlinkComponents(context.root, existingRecordPath, "existing goal record path");
    const existing = validateGoalRecord(await readSmallJson(existingRecordPath, "existing goal record", MAX_RECORD_BYTES), {
      ...context,
      goalId: candidate.record.goalId,
    });
    const existingSnapshotPath = join(finalDirectory, "approved.md");
    await rejectSymlinkComponents(context.root, existingSnapshotPath, "existing approved goal snapshot path");
    const existingSnapshotStat = await lstat(existingSnapshotPath);
    if (!existingSnapshotStat.isFile()) throw new Error("existing approved goal snapshot is not a regular file");
    const existingSnapshot = await readFile(existingSnapshotPath);
    if (existing.snapshotSha256 !== sha256(existingSnapshot) || existing.snapshotBytes !== existingSnapshot.byteLength ||
      gitBlobId(existingSnapshot, existing.approvedBlob) !== existing.approvedBlob) {
      throw new Error("existing approved goal snapshot integrity check failed");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staging = join(context.goalsDir, `.tmp-${candidate.record.goalId}-${process.pid}-${crypto.randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    await durableWrite(join(staging, "approved.md"), candidate.snapshot);
    await durableWrite(join(staging, "record.v1.json"), `${JSON.stringify(candidate.record, null, 2)}\n`);
    try {
      await rename(staging, finalDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      // Another activation with the same stable identity completed first.
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function activateGoal(options: { goalFile: string; approvalStatement: string; cwd?: string; now?: Date }): Promise<ActivationResult> {
  const context = await discoverContext(options.cwd ?? process.cwd());
  const candidate = await inspectCandidate(context, options.goalFile, options.approvalStatement);
  const trackedState = await runGit(context.root, ["ls-files", "--", ".pi-swarm"]);
  if (trackedState.code !== 0) throw new Error(`cannot inspect tracked Spike state: ${gitError(trackedState)}`);
  if (trackedState.stdout.byteLength) throw new Error("refusing to write goal state because .pi-swarm contains tracked files");
  const ignored = await runGit(context.root, ["check-ignore", "--quiet", "--", ".pi-swarm/goals/active.json"]);
  if (ignored.code !== 0) throw new Error(".pi-swarm/ is not ignored; run spike init or add .pi-swarm/ to .gitignore before activating a goal");
  if (options.now) {
    if (!Number.isFinite(options.now.getTime())) throw new Error("activation time is invalid");
    candidate.record.activatedAt = options.now.toISOString();
  }
  await ensureStateDirectories(context);
  const lockPath = join(context.goalsDir, "activation.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another goal activation is in progress (remove .pi-swarm/goals/activation.lock only if no activation process is running)");
    throw error;
  }
  try {
    const active = await loadActiveFromContext(context, true);
    if (active) {
      const same = active.record.goalId === candidate.record.goalId &&
        active.record.approvedBlob === candidate.record.approvedBlob &&
        active.record.repositoryRevision === candidate.record.repositoryRevision &&
        active.record.approvalStatement === candidate.record.approvalStatement;
      if (!same) throw new Error(`a different goal is already active: ${active.record.goalId}`);
      return { ...active, idempotent: true };
    }
    await installRecord(context, candidate);
    const pointer: ActiveGoalPointer = {
      schemaVersion: ACTIVE_GOAL_POINTER_SCHEMA_VERSION,
      goalId: candidate.record.goalId,
      projectId: context.projectId,
      recordPath: `.pi-swarm/goals/${candidate.record.goalId}/record.v1.json`,
    };
    validateActiveGoalPointer(pointer, context);
    await atomicWrite(join(context.goalsDir, "active.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    const loaded = await loadActiveFromContext(context, false);
    return { ...loaded!, idempotent: false };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
