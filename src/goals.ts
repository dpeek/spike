import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  atomicWrite as atomicWorkflowWrite,
  durableWrite as durableWorkflowWrite,
  readJson as readWorkflowJson,
  ticketResultPath,
  validateTicketResult,
  validateWorkflowState,
  workflowStatePath,
  type WorkflowState,
} from "./workflow-state.ts";

export const GOAL_SCHEMA_VERSION = 1;
export const ACTIVE_GOAL_POINTER_SCHEMA_VERSION = 1;
export const TICKET_SCHEMA_VERSION = 1;
export const ACTIVE_TICKET_POINTER_SCHEMA_VERSION = 1;
export const MAX_TICKET_BYTES = 1024 * 1024;

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const ticketIdPattern = /^ticket-[0-9a-f]{32}$/;
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

export type TicketRecord = {
  schemaVersion: 1;
  ticketId: string;
  goalId: string;
  status: "ready";
  baseRevision: string;
  snapshotPath: string;
  snapshotSha256: string;
  snapshotBytes: number;
  sourcePath: string;
  workerPath: string;
  issuedAt: string;
};

export type ActiveTicketPointer = {
  schemaVersion: 1;
  goalId: string;
  ticketId: string;
  recordPath: string;
};

export type ReadyTicket = {
  record: TicketRecord;
  snapshot: Buffer;
};

export type TicketIssueResult = ReadyTicket & { idempotent: boolean };
export type { WorkflowState } from "./workflow-state.ts";

type GitResult = { code: number; stdout: Buffer; stderr: string };

type GoalContext = {
  root: string;
  invocationDirectory: string;
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

function ticketIdentity(goalId: string, baseRevision: string, digest: string): string {
  const identity = JSON.stringify({ goalId, baseRevision, digest });
  return `ticket-${sha256(`spike-ticket-v1\0${identity}`).slice(0, 32)}`;
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
  const stateDir = join(root, ".pi-swarm");
  return { root, invocationDirectory: requested, stateDir, goalsDir: join(stateDir, "goals"), projectId: projectIdentity(root) };
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

async function rejectInputSymlinks(context: GoalContext, inputPath: string, label: string): Promise<void> {
  const parsed = parse(inputPath);
  let current = parsed.root;
  let repositoryAlias: string | undefined;
  for (const part of inputPath.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const canonicalPrefix = await realpath(current);
      if (canonicalPrefix === context.root) {
        repositoryAlias = current;
        break;
      }
      if (canonicalPrefix.startsWith(`${context.root}${sep}`)) {
        throw new Error(`${label} must not enter the repository through a symbolic-link alias: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  if (repositoryAlias) await rejectSymlinkComponents(repositoryAlias, inputPath, label);
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

function requireTicketString(value: unknown, field: string, options: { pattern?: RegExp } = {}): asserts value is string {
  if (typeof value !== "string" || !value || (options.pattern && !options.pattern.test(value))) {
    throw new Error(`ticket record has an invalid ${field}`);
  }
}

export function validateActiveTicketPointer(
  value: unknown,
  expected: { root: string; goalId: string; goalDirectory: string },
): ActiveTicketPointer {
  const pointer = requireObject(value, "active ticket pointer");
  if (pointer.schemaVersion !== ACTIVE_TICKET_POINTER_SCHEMA_VERSION) {
    throw new Error(`unsupported active ticket pointer schema: ${String(pointer.schemaVersion)}`);
  }
  if (pointer.goalId !== expected.goalId) throw new Error("active ticket pointer does not match the active goal");
  if (typeof pointer.ticketId !== "string" || !ticketIdPattern.test(pointer.ticketId)) {
    throw new Error("active ticket pointer has an invalid ticketId");
  }
  const expectedRecord = `.pi-swarm/goals/${expected.goalId}/tickets/${pointer.ticketId}/record.v1.json`;
  if (pointer.recordPath !== expectedRecord) throw new Error("active ticket pointer has an invalid recordPath");
  resolveRecordedPath(expected.root, expectedRecord, "active ticket record path", join(expected.goalDirectory, "tickets", pointer.ticketId));
  return pointer as ActiveTicketPointer;
}

export function validateTicketRecord(
  value: unknown,
  expected: { root: string; goalId: string; goalDirectory: string; acceptedCodeRevision?: string; baseRevision?: string },
): TicketRecord {
  const record = requireObject(value, "ticket record");
  if (record.schemaVersion !== TICKET_SCHEMA_VERSION) throw new Error(`unsupported ticket record schema: ${String(record.schemaVersion)}`);
  if (record.goalId !== expected.goalId) throw new Error("ticket record does not match the active goal");
  if (typeof record.ticketId !== "string" || !ticketIdPattern.test(record.ticketId)) throw new Error("ticket record has an invalid ticketId");
  if (record.status !== "ready") throw new Error("ticket record has an invalid status");
  const expectedBase = expected.baseRevision ?? expected.acceptedCodeRevision;
  if ((expectedBase !== undefined && record.baseRevision !== expectedBase) || typeof record.baseRevision !== "string" || !objectIdPattern.test(record.baseRevision)) {
    throw new Error("ticket record base revision does not match the active goal");
  }
  requireTicketString(record.snapshotSha256, "snapshotSha256", { pattern: /^[0-9a-f]{64}$/ });
  if (!Number.isSafeInteger(record.snapshotBytes) || (record.snapshotBytes as number) < 1 || (record.snapshotBytes as number) > MAX_TICKET_BYTES) {
    throw new Error("ticket record has an invalid snapshotBytes");
  }
  requireTicketString(record.sourcePath, "sourcePath");
  resolveRecordedPath(expected.root, record.sourcePath, "ticket source path");
  if (record.sourcePath === ".git" || record.sourcePath.startsWith(".git/") || !/\.(?:md|markdown)$/i.test(record.sourcePath)) {
    throw new Error("ticket record has an invalid sourcePath");
  }
  requireTicketString(record.issuedAt, "issuedAt");
  const issuedAt = new Date(record.issuedAt as string);
  if (!Number.isFinite(issuedAt.getTime()) || issuedAt.toISOString() !== record.issuedAt) {
    throw new Error("ticket record has an invalid issuedAt timestamp");
  }

  const expectedSnapshot = `.pi-swarm/goals/${record.goalId}/tickets/${record.ticketId}/ticket.md`;
  if (record.snapshotPath !== expectedSnapshot) throw new Error("ticket record has an invalid snapshotPath");
  resolveRecordedPath(expected.root, expectedSnapshot, "ticket snapshot path", join(expected.goalDirectory, "tickets", record.ticketId as string));
  const expectedWorker = `.pi-swarm/output/workflow/${record.goalId}/tickets/${record.ticketId}/ticket.md`;
  if (record.workerPath !== expectedWorker) throw new Error("ticket record has an invalid workerPath");
  resolveRecordedPath(expected.root, expectedWorker, "worker-visible ticket path", join(expected.root, ".pi-swarm", "output", "workflow", record.goalId as string, "tickets", record.ticketId as string));

  const identity = ticketIdentity(record.goalId as string, record.baseRevision as string, record.snapshotSha256 as string);
  if (identity !== record.ticketId) throw new Error("ticket record stable identity is invalid");
  return record as TicketRecord;
}

async function commitIsDescendant(context: GoalContext, base: string, revision: string): Promise<boolean> {
  const commit = await runGit(context.root, ["cat-file", "-t", revision]);
  if (commit.code !== 0 || output(commit) !== "commit") return false;
  return (await runGit(context.root, ["merge-base", "--is-ancestor", base, revision])).code === 0;
}

async function initialWorkflowState(context: GoalContext, record: GoalRecord): Promise<WorkflowState> {
  const goalDirectory = join(context.goalsDir, record.goalId);
  const pointerValue = await readWorkflowJson(join(goalDirectory, "active-ticket.json"), "active ticket pointer", true);
  let activeTicketId: string | null = null;
  let transitionedAt = record.activatedAt;
  if (pointerValue !== undefined) {
    const pointer = validateActiveTicketPointer(pointerValue, { root: context.root, goalId: record.goalId, goalDirectory });
    const ticketValue = await readWorkflowJson(join(goalDirectory, "tickets", pointer.ticketId, "record.v1.json"), "active ticket record");
    const ticket = validateTicketRecord(ticketValue, { root: context.root, goalId: record.goalId, goalDirectory, baseRevision: record.acceptedCodeRevision });
    activeTicketId = ticket.ticketId;
    transitionedAt = ticket.issuedAt;
  }
  return validateWorkflowState({
    schemaVersion: 1,
    goalId: record.goalId,
    acceptedCodeRevision: record.acceptedCodeRevision,
    activeTicketId,
    stateRevision: 1,
    lastTransitionAt: transitionedAt,
    ticketOrder: activeTicketId ? [activeTicketId] : [],
  }, record.goalId);
}

async function loadWorkflowFromContext(context: GoalContext, record: GoalRecord, readOnly = false): Promise<WorkflowState> {
  const path = workflowStatePath(context.root, record.goalId);
  await rejectSymlinkComponents(context.root, path, "workflow state path");
  let value = await readWorkflowJson(path, "workflow state", true);
  if (value === undefined) {
    const initial = await initialWorkflowState(context, record);
    if (readOnly) value = initial;
    else {
      try { await durableWorkflowWrite(path, `${JSON.stringify(initial, null, 2)}\n`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      value = await readWorkflowJson(path, "workflow state");
    }
  }
  let state = validateWorkflowState(value, record.goalId);
  if (state.activeTicketId) {
    const resultPath = ticketResultPath(context.root, record.goalId, state.activeTicketId);
    const prepared = await readWorkflowJson(resultPath, "prepared ticket result", true);
    if (prepared !== undefined) {
      const goalDirectory = join(context.goalsDir, record.goalId);
      const ticket = validateTicketRecord(
        await readWorkflowJson(join(goalDirectory, "tickets", state.activeTicketId, "record.v1.json"), "ticket record"),
        { root: context.root, goalId: record.goalId, goalDirectory, baseRevision: state.acceptedCodeRevision },
      );
      const result = validateTicketResult(prepared, { goalId: record.goalId, ticketId: ticket.ticketId, baseRevision: ticket.baseRevision });
      if (!await commitIsDescendant(context, result.baseRevision, result.acceptedRevision)) {
        throw new Error(`recoverable acceptance for ${ticket.ticketId} cannot be completed: accepted revision is unavailable or not a descendant of its base`);
      }
      // A prepared result cannot bypass run/publication validation merely by
      // surviving a crash. Revalidate any durable run correlation before the
      // normal state load completes the transition.
      const runPointerValue = await readWorkflowJson(join(goalDirectory, "tickets", ticket.ticketId, "active-run.json"), "active run pointer", true);
      if (runPointerValue !== undefined) {
        const { validateActiveRunPointer, validateRunRecord } = await import("./runs.ts");
        const runPointer = validateActiveRunPointer(runPointerValue, { goalId: record.goalId, ticketId: ticket.ticketId });
        const run = validateRunRecord(await readWorkflowJson(resolveRecordedPath(context.root, runPointer.recordPath, "active run record path"), "active run record"), {
          goalId: record.goalId, ticketId: ticket.ticketId, baseRevision: ticket.baseRevision, runId: runPointer.runId,
        });
        if (!["launch_failed", "stopped", "failed", "completed"].includes(run.status) || result.runId !== run.runId || result.worker?.slug !== run.worker.slug || !result.publication) {
          throw new Error(`recoverable acceptance for ${ticket.ticketId} has invalid run/publication provenance`);
        }
        const publicationManifest = await readWorkflowJson(resolveRecordedPath(context.root, result.publication.manifestPath, "result publication manifest path"), "result publication manifest") as Record<string, unknown>;
        if (publicationManifest.head !== result.acceptedRevision || publicationManifest.base !== ticket.baseRevision || publicationManifest.agent !== run.worker.slug) {
          throw new Error(`recoverable acceptance for ${ticket.ticketId} has conflicting publication provenance`);
        }
        const publicationRef = await runGit(context.root, ["rev-parse", "--verify", `${result.publication.importedRef}^{commit}`]);
        if (publicationRef.code !== 0 || output(publicationRef) !== result.acceptedRevision) throw new Error(`recoverable acceptance for ${ticket.ticketId} has invalid publication ref`);
        const bundle = resolveRecordedPath(context.root, result.publication.bundlePath, "result publication bundle path");
        if ((await runGit(context.root, ["bundle", "verify", bundle])).code !== 0) throw new Error(`recoverable acceptance for ${ticket.ticketId} has invalid publication bundle`);
      } else if (result.runId) throw new Error(`recoverable acceptance for ${ticket.ticketId} references a missing durable run`);
      if (readOnly) throw new Error(`recoverable acceptance for ${ticket.ticketId} is prepared and requires a normal state load or ticket accept retry`);
      state = validateWorkflowState({
        ...state,
        acceptedCodeRevision: result.acceptedRevision,
        activeTicketId: null,
        stateRevision: state.stateRevision + 1,
        lastTransitionAt: result.acceptedAt,
      }, record.goalId);
      await atomicWorkflowWrite(path, `${JSON.stringify(state, null, 2)}\n`);
      await rm(join(goalDirectory, "active-ticket.json"), { force: true });
    }
  }
  return state;
}

export async function loadWorkflowState(cwd = process.cwd(), options: { readOnly?: boolean } = {}): Promise<WorkflowState> {
  const context = await discoverContext(cwd);
  const active = (await loadActiveFromContext(context, false, options.readOnly))!;
  return loadWorkflowFromContext(context, active.record, options.readOnly);
}

async function loadActiveFromContext(context: GoalContext, allowMissing: boolean, readOnly = false): Promise<ActiveGoal | undefined> {
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
  // The legacy goal record may carry the last pre-workflow accepted revision;
  // it remains provenance and must still name a real commit even though current
  // acceptance is now owned by workflow state.
  await verifyCommitAvailable(context, record.acceptedCodeRevision);
  const workflow = await loadWorkflowFromContext(context, record, readOnly);
  await verifyCommitAvailable(context, workflow.acceptedCodeRevision);
  return { record: { ...record, acceptedCodeRevision: workflow.acceptedCodeRevision }, snapshot };
}

export async function loadActiveGoal(cwd = process.cwd(), options: { readOnly?: boolean } = {}): Promise<ActiveGoal> {
  const context = await discoverContext(cwd);
  return (await loadActiveFromContext(context, false, options.readOnly))!;
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
  const inputPath = resolve(context.invocationDirectory, goalFile);
  let inputStat;
  try { inputStat = await lstat(inputPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`goal file does not exist: ${goalFile}`);
    throw error;
  }
  if (inputStat.isSymbolicLink()) throw new Error(`goal file must not be a symbolic link: ${goalFile}`);
  await rejectInputSymlinks(context, inputPath, "goal file");
  const absolute = await realpath(inputPath);
  const goalPath = toProjectRelative(context.root, absolute, "goal file");
  if (!/\.(?:md|markdown)$/i.test(goalPath)) throw new Error("goal file must be Markdown (.md or .markdown)");
  await rejectSymlinkComponents(context.root, absolute, "goal file");
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`goal file is not a regular file: ${goalFile}`);

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
  const worktreeBlob = await runGit(context.root, ["hash-object", `--path=${goalPath}`, "--", goalPath]);
  if (worktreeBlob.code !== 0) throw new Error(`cannot hash goal file through Git filters: ${gitError(worktreeBlob)}`);
  if (output(worktreeBlob) !== approvedBlob) throw new Error(`goal file has uncommitted changes: ${goalPath}`);
  const contentResult = await runGit(context.root, ["cat-file", "blob", approvedBlob]);
  if (contentResult.code !== 0) throw new Error(`cannot read approved Git blob: ${gitError(contentResult)}`);
  if (contentResult.stdout.byteLength > MAX_SNAPSHOT_BYTES) throw new Error(`approved goal exceeds ${MAX_SNAPSHOT_BYTES} bytes`);

  // Recheck the input and its filtered worktree bytes after reading the object
  // so concurrent edits and assume-unchanged index flags cannot bypass approval.
  await rejectInputSymlinks(context, inputPath, "goal file");
  await rejectSymlinkComponents(context.root, absolute, "goal file");
  const finalInputStat = await lstat(inputPath);
  const finalStat = await lstat(absolute);
  if (finalInputStat.isSymbolicLink() || !finalStat.isFile() || finalStat.isSymbolicLink() || await realpath(inputPath) !== absolute) {
    throw new Error("goal file changed type or target during activation");
  }
  const finalClean = await runGit(context.root, ["diff", "--quiet", "--no-ext-diff", "HEAD", "--", literalPathspec]);
  if (finalClean.code === 1) throw new Error(`goal file has uncommitted changes: ${goalPath}`);
  if (finalClean.code !== 0) throw new Error(`cannot compare goal file with HEAD: ${gitError(finalClean)}`);
  const finalWorktreeBlob = await runGit(context.root, ["hash-object", `--path=${goalPath}`, "--", goalPath]);
  if (finalWorktreeBlob.code !== 0) throw new Error(`cannot hash goal file through Git filters: ${gitError(finalWorktreeBlob)}`);
  if (output(finalWorktreeBlob) !== approvedBlob) throw new Error(`goal file has uncommitted changes: ${goalPath}`);
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

async function verifyCommitAvailable(context: GoalContext, revision: string): Promise<void> {
  const result = await runGit(context.root, ["cat-file", "-t", revision]);
  if (result.code !== 0 || output(result) !== "commit") {
    throw new Error(`active goal accepted code revision is not an available commit: ${revision}`);
  }
}

async function readTicketCopy(path: string, label: string, record: TicketRecord): Promise<Buffer> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} is missing`);
    throw new Error(`cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (stat.size !== record.snapshotBytes) throw new Error(`${label} integrity check failed`);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) { throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`); }
  if (bytes.byteLength !== record.snapshotBytes || sha256(bytes) !== record.snapshotSha256) {
    throw new Error(`${label} integrity check failed`);
  }
  return bytes;
}

async function loadReadyFromContext(
  context: GoalContext,
  active: ActiveGoal,
  allowMissing: boolean,
): Promise<ReadyTicket | undefined> {
  const goalDirectory = join(context.goalsDir, active.record.goalId);
  const workflow = await loadWorkflowFromContext(context, active.record);
  const pointerPath = join(goalDirectory, "active-ticket.json");
  await rejectSymlinkComponents(context.root, pointerPath, "active ticket pointer path");
  const pointerValue = await readWorkflowJson(pointerPath, "active ticket pointer", true);
  // A stale compatibility pointer is never authoritative, but malformed state
  // still fails closed rather than being hidden by the workflow record.
  if (!workflow.activeTicketId) {
    if (pointerValue !== undefined) validateActiveTicketPointer(pointerValue, { root: context.root, goalId: active.record.goalId, goalDirectory });
    if (allowMissing) return undefined;
    throw new Error("no ready ticket; issue one with spike ticket issue <ticket-file>");
  }
  const pointer = pointerValue === undefined ? {
    schemaVersion: ACTIVE_TICKET_POINTER_SCHEMA_VERSION,
    goalId: active.record.goalId,
    ticketId: workflow.activeTicketId,
    recordPath: `.pi-swarm/goals/${active.record.goalId}/tickets/${workflow.activeTicketId}/record.v1.json`,
  } as ActiveTicketPointer : validateActiveTicketPointer(pointerValue, {
    root: context.root,
    goalId: active.record.goalId,
    goalDirectory,
  });
  if (pointer.ticketId !== workflow.activeTicketId) throw new Error("active ticket pointer is inconsistent with workflow state");
  const ticketDirectory = join(goalDirectory, "tickets", pointer.ticketId);
  const recordPath = resolveRecordedPath(context.root, pointer.recordPath, "active ticket record path", ticketDirectory);
  await rejectSymlinkComponents(context.root, ticketDirectory, "active ticket directory");
  await rejectSymlinkComponents(context.root, recordPath, "active ticket record path");
  const record = validateTicketRecord(await readSmallJson(recordPath, "active ticket record", MAX_RECORD_BYTES), {
    root: context.root,
    goalId: active.record.goalId,
    goalDirectory,
    acceptedCodeRevision: active.record.acceptedCodeRevision,
  });
  if (record.ticketId !== pointer.ticketId) throw new Error("ticket record identity does not match the active pointer");
  await verifyCommitAvailable(context, record.baseRevision);

  const snapshotPath = resolveRecordedPath(context.root, record.snapshotPath, "ticket snapshot path", ticketDirectory);
  const workerPath = resolveRecordedPath(context.root, record.workerPath, "worker-visible ticket path",
    join(context.stateDir, "output", "workflow", record.goalId, "tickets", record.ticketId));
  await rejectSymlinkComponents(context.root, snapshotPath, "ticket snapshot path");
  await rejectSymlinkComponents(context.root, workerPath, "worker-visible ticket path");
  const snapshot = await readTicketCopy(snapshotPath, "ticket snapshot", record);
  const workerCopy = await readTicketCopy(workerPath, "worker-visible ticket copy", record);
  if (!snapshot.equals(workerCopy)) throw new Error("worker-visible ticket copy integrity check failed");
  return { record, snapshot };
}

export async function loadReadyTicket(cwd = process.cwd()): Promise<ReadyTicket> {
  const context = await discoverContext(cwd);
  const active = (await loadActiveFromContext(context, false))!;
  return (await loadReadyFromContext(context, active, false))!;
}

async function inspectTicketInput(context: GoalContext, ticketFile: string): Promise<{ sourcePath: string; snapshot: Buffer }> {
  if (!ticketFile) throw new Error("ticket issue requires a Markdown ticket file");
  const inputPath = resolve(context.invocationDirectory, ticketFile);
  let initialPathStat;
  try { initialPathStat = await lstat(inputPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`ticket file does not exist: ${ticketFile}`);
    throw error;
  }
  if (initialPathStat.isSymbolicLink()) throw new Error(`ticket file must not be a symbolic link: ${ticketFile}`);
  await rejectInputSymlinks(context, inputPath, "ticket file");
  const absolute = await realpath(inputPath);
  const sourcePath = toProjectRelative(context.root, absolute, "ticket file");
  if (sourcePath === ".git" || sourcePath.startsWith(".git/")) throw new Error("ticket file must be in the repository working tree");
  if (!/\.(?:md|markdown)$/i.test(sourcePath)) throw new Error("ticket file must be Markdown (.md or .markdown)");
  await rejectSymlinkComponents(context.root, absolute, "ticket file");

  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`cannot open ticket file: ${error instanceof Error ? error.message : String(error)}`);
  }
  let snapshot: Buffer;
  let openedStat;
  try {
    openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`ticket file is not a regular file: ${ticketFile}`);
    if (openedStat.size > MAX_TICKET_BYTES) throw new Error(`ticket file exceeds ${MAX_TICKET_BYTES} bytes`);
    const bounded = Buffer.alloc(MAX_TICKET_BYTES + 1);
    let offset = 0;
    while (offset < bounded.byteLength) {
      const result = await handle.read(bounded, offset, bounded.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_TICKET_BYTES) throw new Error(`ticket file exceeds ${MAX_TICKET_BYTES} bytes`);
    snapshot = bounded.subarray(0, offset);
    const finalOpenedStat = await handle.stat();
    if (finalOpenedStat.dev !== openedStat.dev || finalOpenedStat.ino !== openedStat.ino || finalOpenedStat.size !== openedStat.size ||
      finalOpenedStat.mtimeMs !== openedStat.mtimeMs || finalOpenedStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error("ticket file changed while it was being read; retry");
    }
  } finally {
    await handle.close();
  }
  if (snapshot.byteLength === 0 || !snapshot.toString("utf8").trim()) throw new Error("ticket file must not be empty");

  await rejectInputSymlinks(context, inputPath, "ticket file");
  await rejectSymlinkComponents(context.root, absolute, "ticket file");
  const finalPathStat = await lstat(inputPath);
  if (!finalPathStat.isFile() || finalPathStat.isSymbolicLink() || await realpath(inputPath) !== absolute ||
    finalPathStat.dev !== openedStat.dev || finalPathStat.ino !== openedStat.ino || finalPathStat.size !== snapshot.byteLength ||
    finalPathStat.mtimeMs !== openedStat.mtimeMs || finalPathStat.ctimeMs !== openedStat.ctimeMs) {
    throw new Error("ticket file changed type or target during issuance");
  }
  return { sourcePath, snapshot };
}

async function ensureTicketStateDirectories(context: GoalContext, goalId: string): Promise<{ ticketsDirectory: string; workerTicketsDirectory: string }> {
  const goalDirectory = join(context.goalsDir, goalId);
  const ticketsDirectory = join(goalDirectory, "tickets");
  const workflowDirectory = join(context.stateDir, "output", "workflow", goalId);
  const workerTicketsDirectory = join(workflowDirectory, "tickets");
  await rejectSymlinkComponents(context.root, ticketsDirectory, "ticket state path");
  await mkdir(ticketsDirectory, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(context.root, ticketsDirectory, "ticket state path");
  await rejectSymlinkComponents(context.root, workerTicketsDirectory, "worker-visible ticket state path");
  await mkdir(workerTicketsDirectory, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(context.root, workerTicketsDirectory, "worker-visible ticket state path");
  return { ticketsDirectory, workerTicketsDirectory };
}

async function installWorkerCopy(context: GoalContext, record: TicketRecord, snapshot: Buffer, workerTicketsDirectory: string): Promise<void> {
  const finalDirectory = join(workerTicketsDirectory, record.ticketId);
  const finalPath = join(finalDirectory, "ticket.md");
  try {
    await access(finalDirectory, constants.F_OK);
    await rejectSymlinkComponents(context.root, finalPath, "existing worker-visible ticket path");
    const existing = await readTicketCopy(finalPath, "existing worker-visible ticket copy", record);
    if (!existing.equals(snapshot)) throw new Error("existing worker-visible ticket copy conflicts with ticket content");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = join(workerTicketsDirectory, `.tmp-${record.ticketId}-${process.pid}-${crypto.randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    await durableWrite(join(staging, "ticket.md"), snapshot);
    try { await rename(staging, finalDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await rejectSymlinkComponents(context.root, finalPath, "worker-visible ticket path");
  const installed = await readTicketCopy(finalPath, "worker-visible ticket copy", record);
  if (!installed.equals(snapshot)) throw new Error("worker-visible ticket copy conflicts with ticket content");
}

async function installTicketRecord(
  context: GoalContext,
  active: ActiveGoal,
  candidate: TicketRecord,
  snapshot: Buffer,
  ticketsDirectory: string,
): Promise<TicketRecord> {
  const goalDirectory = join(context.goalsDir, active.record.goalId);
  const finalDirectory = join(ticketsDirectory, candidate.ticketId);
  const recordPath = join(finalDirectory, "record.v1.json");
  const snapshotPath = join(finalDirectory, "ticket.md");
  try {
    await access(finalDirectory, constants.F_OK);
    await rejectSymlinkComponents(context.root, recordPath, "existing ticket record path");
    await rejectSymlinkComponents(context.root, snapshotPath, "existing ticket snapshot path");
    const existing = validateTicketRecord(await readSmallJson(recordPath, "existing ticket record", MAX_RECORD_BYTES), {
      root: context.root,
      goalId: active.record.goalId,
      goalDirectory,
      acceptedCodeRevision: active.record.acceptedCodeRevision,
    });
    const existingSnapshot = await readTicketCopy(snapshotPath, "existing ticket snapshot", existing);
    if (!existingSnapshot.equals(snapshot)) throw new Error("existing ticket record conflicts with ticket content");
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = join(ticketsDirectory, `.tmp-${candidate.ticketId}-${process.pid}-${crypto.randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    await durableWrite(join(staging, "ticket.md"), snapshot);
    await durableWrite(join(staging, "record.v1.json"), `${JSON.stringify(candidate, null, 2)}\n`);
    try { await rename(staging, finalDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await rejectSymlinkComponents(context.root, recordPath, "ticket record path");
  const installed = validateTicketRecord(await readSmallJson(recordPath, "ticket record", MAX_RECORD_BYTES), {
    root: context.root,
    goalId: active.record.goalId,
    goalDirectory,
    acceptedCodeRevision: active.record.acceptedCodeRevision,
  });
  const installedSnapshot = await readTicketCopy(snapshotPath, "ticket snapshot", installed);
  if (!installedSnapshot.equals(snapshot)) throw new Error("installed ticket record conflicts with ticket content");
  return installed;
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

export async function issueTicket(options: { ticketFile: string; cwd?: string; now?: Date }): Promise<TicketIssueResult> {
  const context = await discoverContext(options.cwd ?? process.cwd());
  const active = (await loadActiveFromContext(context, false))!;
  await verifyCommitAvailable(context, active.record.acceptedCodeRevision);
  const input = await inspectTicketInput(context, options.ticketFile);
  const trackedState = await runGit(context.root, ["ls-files", "--", ".pi-swarm"]);
  if (trackedState.code !== 0) throw new Error(`cannot inspect tracked Spike state: ${gitError(trackedState)}`);
  if (trackedState.stdout.byteLength) throw new Error("refusing to write ticket state because .pi-swarm contains tracked files");
  const ignored = await runGit(context.root, ["check-ignore", "--quiet", "--", ".pi-swarm/goals/active.json"]);
  if (ignored.code !== 0) throw new Error(".pi-swarm/ is not ignored; run spike init or add .pi-swarm/ to .gitignore before issuing a ticket");
  if (options.now && !Number.isFinite(options.now.getTime())) throw new Error("ticket issuance time is invalid");

  const digest = sha256(input.snapshot);
  const ticketId = ticketIdentity(active.record.goalId, active.record.acceptedCodeRevision, digest);
  const issuedAt = (options.now ?? new Date()).toISOString();
  const candidate: TicketRecord = {
    schemaVersion: TICKET_SCHEMA_VERSION,
    ticketId,
    goalId: active.record.goalId,
    status: "ready",
    baseRevision: active.record.acceptedCodeRevision,
    snapshotPath: `.pi-swarm/goals/${active.record.goalId}/tickets/${ticketId}/ticket.md`,
    snapshotSha256: digest,
    snapshotBytes: input.snapshot.byteLength,
    sourcePath: input.sourcePath,
    workerPath: `.pi-swarm/output/workflow/${active.record.goalId}/tickets/${ticketId}/ticket.md`,
    issuedAt,
  };
  const goalDirectory = join(context.goalsDir, active.record.goalId);
  validateTicketRecord(candidate, {
    root: context.root,
    goalId: active.record.goalId,
    goalDirectory,
    acceptedCodeRevision: active.record.acceptedCodeRevision,
  });

  const lockPath = join(goalDirectory, "ticket-issuance.lock");
  await rejectSymlinkComponents(context.root, lockPath, "ticket issuance lock path");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("another ticket issuance is in progress (remove the ticket-issuance.lock only if no issuance process is running)");
    }
    throw error;
  }
  try {
    const currentActive = (await loadActiveFromContext(context, false))!;
    if (currentActive.record.goalId !== active.record.goalId ||
      currentActive.record.acceptedCodeRevision !== active.record.acceptedCodeRevision) {
      throw new Error("active goal changed during ticket issuance; retry");
    }
    const existing = await loadReadyFromContext(context, currentActive, true);
    if (existing) {
      if (existing.record.baseRevision === candidate.baseRevision && existing.snapshot.equals(input.snapshot)) {
        return { ...existing, idempotent: true };
      }
      throw new Error(`a different ticket is already ready: ${existing.record.ticketId}`);
    }

    const { ticketsDirectory, workerTicketsDirectory } = await ensureTicketStateDirectories(context, active.record.goalId);
    await installWorkerCopy(context, candidate, input.snapshot, workerTicketsDirectory);
    const installedRecord = await installTicketRecord(context, currentActive, candidate, input.snapshot, ticketsDirectory);
    const workflow = await loadWorkflowFromContext(context, currentActive.record);
    if (workflow.acceptedCodeRevision !== installedRecord.baseRevision || workflow.activeTicketId !== null) {
      throw new Error("workflow state changed during ticket issuance; retry");
    }
    const transitioned = validateWorkflowState({
      ...workflow,
      activeTicketId: installedRecord.ticketId,
      stateRevision: workflow.stateRevision + 1,
      lastTransitionAt: installedRecord.issuedAt,
      ticketOrder: [...workflow.ticketOrder, installedRecord.ticketId],
    }, currentActive.record.goalId);
    await atomicWorkflowWrite(workflowStatePath(context.root, currentActive.record.goalId), `${JSON.stringify(transitioned, null, 2)}\n`);
    const pointer: ActiveTicketPointer = {
      schemaVersion: ACTIVE_TICKET_POINTER_SCHEMA_VERSION,
      goalId: currentActive.record.goalId,
      ticketId: installedRecord.ticketId,
      recordPath: `.pi-swarm/goals/${currentActive.record.goalId}/tickets/${installedRecord.ticketId}/record.v1.json`,
    };
    validateActiveTicketPointer(pointer, { root: context.root, goalId: currentActive.record.goalId, goalDirectory });
    await atomicWrite(join(goalDirectory, "active-ticket.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    const loaded = await loadReadyFromContext(context, currentActive, false);
    return { ...loaded!, idempotent: false };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
