import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadActiveGoal, loadReadyTicket, type GoalRecord, type TicketRecord } from "./goals.ts";

export const RUN_SCHEMA_VERSION = 1;
export const ACTIVE_RUN_POINTER_SCHEMA_VERSION = 1;
export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_STOP_INTENT_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 128 * 1024;
const runIdPattern = /^run-[0-9a-f]{32}$/;
const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const ticketIdPattern = /^ticket-[0-9a-f]{32}$/;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const workerPattern = /^[a-z0-9_.-]+$/;

export type RunStatus = "dispatching" | "running" | "launch_failed" | "stopping" | "stopped" | "failed" | "completed";
export type AgentLifecycle = "running" | "stopping" | "stopped" | "failed" | "completed";

export type RunRecord = {
  schemaVersion: 1;
  runId: string;
  goalId: string;
  ticketId: string;
  baseRevision: string;
  worker: { name: string; slug: string };
  backend: "herdr";
  requestedModel?: string;
  requestedThinking?: string;
  status: RunStatus;
  createdAt: string;
  launchedAt?: string;
  finishedAt?: string;
  runtime?: "apple" | "docker";
  container?: string;
  herdrName?: string;
  herdrWorkspaceId?: string;
  herdrTabId?: string;
  herdrPaneId?: string;
  stopRequestedAt?: string;
  stopRequester?: string;
  stopReason?: string;
  stopRunId?: string;
  exitCode?: number;
  signal?: string;
  expectedSignal?: string;
  terminationKind?: "requested" | "unexpected";
  outcome?: "stopped" | "failed" | "completed";
  launchError?: string;
};

export type ActiveRunPointer = {
  schemaVersion: 1;
  goalId: string;
  ticketId: string;
  runId: string;
  recordPath: string;
};

export type AgentStopIntent = {
  schemaVersion: 1;
  slug: string;
  startedAt: string;
  pid: number;
  container: string;
  runId?: string;
  stopRequestedAt: string;
  stopRequester?: string;
  stopReason: string;
};

export type AgentState = {
  schemaVersion: 1;
  name: string;
  slug: string;
  project: string;
  runtime: "apple" | "docker";
  container: string;
  workspaceVolume: string;
  network: string;
  alias?: string;
  hostPort?: number;
  containerPort: number;
  operatorUrl?: string;
  task?: string;
  owner?: string;
  log?: string;
  errorLog?: string;
  backend: "headless" | "herdr";
  herdrName?: string;
  herdrWorkspaceId?: string;
  herdrTabId?: string;
  herdrPaneId?: string;
  goalId?: string;
  ticketId?: string;
  runId?: string;
  baseRevision?: string;
  lifecycle: AgentLifecycle;
  startedAt: string;
  finishedAt?: string;
  stopRequestedAt?: string;
  stopRequester?: string;
  stopReason?: string;
  stopRunId?: string;
  exitCode?: number;
  signal?: string;
  expectedSignal?: string;
  terminationKind?: "requested" | "unexpected";
  outcome?: "stopped" | "failed" | "completed";
  pid: number;
};

export type DispatchLaunchRequest = {
  runId: string;
  goalId: string;
  ticketId: string;
  baseRevision: string;
  workerName: string;
  workerSlug: string;
  task: string;
  model?: string;
  thinking?: string;
};

export type LaunchMetadata = Pick<AgentState,
  "runtime" | "container" | "herdrName" | "herdrWorkspaceId" | "herdrTabId" | "herdrPaneId">;

export type TicketLauncher = (request: DispatchLaunchRequest) => Promise<LaunchMetadata>;

type RunContext = {
  root: string;
  stateDir: string;
  goal: GoalRecord;
  ticket: TicketRecord;
  ticketDirectory: string;
  runsDirectory: string;
};

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (!validTimestamp(value)) throw new Error(`${label} has an invalid timestamp`);
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function within(root: string, path: string, label: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) throw new Error(`${label} must be a project-relative path`);
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${label} escapes the project repository`);
  if (relative(root, absolute).split(sep).join("/") !== path) throw new Error(`${label} is not normalized`);
  return absolute;
}

async function rejectSymlinks(root: string, path: string, label: string): Promise<void> {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} is outside the repository`);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} must not contain symbolic links: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function smallJson(path: string, label: string): Promise<unknown> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} is missing`);
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error(`${label} is unexpectedly large`);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is invalid JSON`); }
}

async function durableWrite(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await durableWrite(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function cleanError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return (text || "unknown launch error").slice(0, 500);
}

function workerSlug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result || !/[a-z0-9]/.test(result)) throw new Error("worker name must contain a letter or number");
  return result;
}

function validateCorrelation(record: Record<string, unknown>, label: string): void {
  const values = [record.goalId, record.ticketId, record.runId, record.baseRevision];
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== values.length) throw new Error(`${label} has incomplete run correlation`);
  if (present) {
    if (typeof record.goalId !== "string" || !goalIdPattern.test(record.goalId)) throw new Error(`${label} has an invalid goalId`);
    if (typeof record.ticketId !== "string" || !ticketIdPattern.test(record.ticketId)) throw new Error(`${label} has an invalid ticketId`);
    if (typeof record.runId !== "string" || !runIdPattern.test(record.runId)) throw new Error(`${label} has an invalid runId`);
    if (typeof record.baseRevision !== "string" || !objectIdPattern.test(record.baseRevision)) throw new Error(`${label} has an invalid baseRevision`);
  }
}

export function validateAgentState(value: unknown, expectedSlug?: string): AgentState {
  const state = requireObject(value, "agent state");
  if (state.schemaVersion !== AGENT_SCHEMA_VERSION) throw new Error(`unsupported agent state schema: ${String(state.schemaVersion)}`);
  if (typeof state.slug !== "string" || !workerPattern.test(state.slug) || (expectedSlug && state.slug !== expectedSlug)) throw new Error("agent state has an invalid slug");
  if (typeof state.name !== "string" || !state.name || typeof state.project !== "string" || !state.project) throw new Error("agent state has invalid identity");
  if (state.runtime !== "apple" && state.runtime !== "docker") throw new Error("agent state has an invalid runtime");
  for (const field of ["container", "workspaceVolume", "network"] as const) if (typeof state[field] !== "string" || !state[field]) throw new Error(`agent state has an invalid ${field}`);
  for (const field of ["alias", "operatorUrl", "task", "owner", "log", "errorLog", "herdrName", "herdrWorkspaceId", "herdrTabId", "herdrPaneId", "stopRequester", "stopReason", "signal", "expectedSignal"] as const) {
    if (!validOptionalString(state[field])) throw new Error(`agent state has an invalid ${field}`);
  }
  if (state.hostPort !== undefined && (!Number.isSafeInteger(state.hostPort) || (state.hostPort as number) < 1 || (state.hostPort as number) > 65535)) throw new Error("agent state has an invalid hostPort");
  if (!Number.isSafeInteger(state.containerPort) || (state.containerPort as number) < 1 || (state.containerPort as number) > 65535) throw new Error("agent state has an invalid containerPort");
  if (state.backend !== "headless" && state.backend !== "herdr") throw new Error("agent state has an invalid backend");
  if (!["running", "stopping", "stopped", "failed", "completed"].includes(String(state.lifecycle))) throw new Error("agent state has an invalid lifecycle");
  requireTimestamp(state.startedAt, "agent state startedAt");
  if (state.finishedAt !== undefined) requireTimestamp(state.finishedAt, "agent state finishedAt");
  if (state.stopRequestedAt !== undefined) requireTimestamp(state.stopRequestedAt, "agent state stopRequestedAt");
  if (!Number.isSafeInteger(state.pid) || (state.pid as number) < 1) throw new Error("agent state has an invalid pid");
  if (state.exitCode !== undefined && !Number.isSafeInteger(state.exitCode)) throw new Error("agent state has an invalid exitCode");
  if (state.terminationKind !== undefined && state.terminationKind !== "requested" && state.terminationKind !== "unexpected") throw new Error("agent state has an invalid terminationKind");
  if (state.outcome !== undefined && !["stopped", "failed", "completed"].includes(String(state.outcome))) throw new Error("agent state has an invalid outcome");
  validateCorrelation(state, "agent state");
  if (state.runId && state.backend !== "herdr") throw new Error("correlated ticket agent must be Herdr-backed");
  if (state.lifecycle === "running" && (state.finishedAt !== undefined || state.exitCode !== undefined || state.outcome !== undefined || state.terminationKind !== undefined)) throw new Error("running agent state must not have termination data");
  if (state.stopRunId !== undefined && (typeof state.stopRunId !== "string" || !runIdPattern.test(state.stopRunId))) throw new Error("agent state has an invalid stopRunId");
  if (state.lifecycle === "stopping" && (!state.stopRequestedAt || (state.runId ? state.stopRunId !== state.runId : state.stopRunId !== undefined))) throw new Error("stopping agent state has invalid stop intent");
  if (["stopped", "failed", "completed"].includes(String(state.lifecycle)) && (!state.finishedAt || state.exitCode === undefined || state.outcome !== state.lifecycle || !state.terminationKind)) throw new Error("terminal agent state has incomplete termination data");
  if (state.lifecycle === "stopped" && (state.terminationKind !== "requested" || !state.stopRequestedAt)) throw new Error("stopped agent state has no matching requested termination");
  return state as AgentState;
}

export function normalizeAgentState(value: unknown, expectedSlug?: string): { state: AgentState; migrated: boolean } {
  const source = requireObject(value, "agent state");
  if (source.schemaVersion !== undefined) return { state: validateAgentState(source, expectedSlug), migrated: false };

  // Schema-less records are the one supported legacy shape. Reject new
  // lifecycle/correlation fields without a schema so removing schemaVersion
  // cannot downgrade a current record past validation.
  for (const field of [
    "goalId", "ticketId", "runId", "baseRevision", "lifecycle", "stopRequestedAt", "stopRequester",
    "stopReason", "stopRunId", "signal", "expectedSignal", "terminationKind", "outcome",
  ]) {
    if (source[field] !== undefined) throw new Error(`legacy agent state has an unexpected ${field}`);
  }
  const backend = source.backend === undefined
    ? (source.herdrName !== undefined || source.herdrWorkspaceId !== undefined || source.herdrTabId !== undefined || source.herdrPaneId !== undefined ? "herdr" : "headless")
    : source.backend;
  const terminal = source.finishedAt !== undefined;
  if (terminal && source.exitCode === undefined) throw new Error("legacy terminal agent state has no exitCode");
  const outcome = terminal ? source.exitCode === 0 ? "completed" : "failed" : undefined;
  const migrated = {
    ...source,
    schemaVersion: AGENT_SCHEMA_VERSION,
    backend,
    lifecycle: outcome ?? "running",
    ...(outcome ? { outcome, terminationKind: "unexpected" as const } : {}),
    ...(source.exitCode === 143 ? { signal: "SIGTERM" } : {}),
  };
  return { state: validateAgentState(migrated, expectedSlug), migrated: true };
}

export function validateAgentStopIntent(value: unknown, expectedSlug?: string): AgentStopIntent {
  const intent = requireObject(value, "agent stop intent");
  if (intent.schemaVersion !== AGENT_STOP_INTENT_SCHEMA_VERSION) throw new Error(`unsupported agent stop intent schema: ${String(intent.schemaVersion)}`);
  if (typeof intent.slug !== "string" || !workerPattern.test(intent.slug) || (expectedSlug && intent.slug !== expectedSlug)) throw new Error("agent stop intent has an invalid slug");
  requireTimestamp(intent.startedAt, "agent stop intent startedAt");
  requireTimestamp(intent.stopRequestedAt, "agent stop intent stopRequestedAt");
  if (!Number.isSafeInteger(intent.pid) || (intent.pid as number) < 1) throw new Error("agent stop intent has an invalid pid");
  if (typeof intent.container !== "string" || !intent.container) throw new Error("agent stop intent has an invalid container");
  if (intent.runId !== undefined && (typeof intent.runId !== "string" || !runIdPattern.test(intent.runId))) throw new Error("agent stop intent has an invalid runId");
  if (!validOptionalString(intent.stopRequester)) throw new Error("agent stop intent has an invalid stopRequester");
  if (typeof intent.stopReason !== "string" || !intent.stopReason) throw new Error("agent stop intent has an invalid stopReason");
  return intent as AgentStopIntent;
}

export function validateActiveRunPointer(value: unknown, expected: { goalId: string; ticketId: string }): ActiveRunPointer {
  const pointer = requireObject(value, "active run pointer");
  if (pointer.schemaVersion !== ACTIVE_RUN_POINTER_SCHEMA_VERSION) throw new Error(`unsupported active run pointer schema: ${String(pointer.schemaVersion)}`);
  if (pointer.goalId !== expected.goalId || pointer.ticketId !== expected.ticketId) throw new Error("active run pointer identity does not match the ready ticket");
  if (typeof pointer.runId !== "string" || !runIdPattern.test(pointer.runId)) throw new Error("active run pointer has an invalid runId");
  const expectedPath = `.pi-swarm/goals/${expected.goalId}/tickets/${expected.ticketId}/runs/${pointer.runId}/record.v1.json`;
  if (pointer.recordPath !== expectedPath) throw new Error("active run pointer has an invalid recordPath");
  return pointer as ActiveRunPointer;
}

export function validateRunRecord(value: unknown, expected: { goalId: string; ticketId: string; baseRevision: string; runId: string }): RunRecord {
  const record = requireObject(value, "run record");
  if (record.schemaVersion !== RUN_SCHEMA_VERSION) throw new Error(`unsupported run record schema: ${String(record.schemaVersion)}`);
  if (record.runId !== expected.runId || typeof record.runId !== "string" || !runIdPattern.test(record.runId)) throw new Error("run record identity does not match the active pointer");
  if (record.goalId !== expected.goalId || record.ticketId !== expected.ticketId || record.baseRevision !== expected.baseRevision) throw new Error("run record identity/base does not match the ready ticket");
  if (record.backend !== "herdr") throw new Error("run record has an invalid backend");
  const worker = requireObject(record.worker, "run worker identity");
  if (typeof worker.name !== "string" || !worker.name || typeof worker.slug !== "string" || !workerPattern.test(worker.slug) || workerSlug(worker.name) !== worker.slug) throw new Error("run record has an invalid worker identity");
  if (!["dispatching", "running", "launch_failed", "stopping", "stopped", "failed", "completed"].includes(String(record.status))) throw new Error("run record has an invalid status");
  requireTimestamp(record.createdAt, "run record createdAt");
  for (const field of ["launchedAt", "finishedAt", "stopRequestedAt"] as const) if (record[field] !== undefined) requireTimestamp(record[field], `run record ${field}`);
  for (const field of ["requestedModel", "requestedThinking", "container", "herdrName", "herdrWorkspaceId", "herdrTabId", "herdrPaneId", "stopRequester", "stopReason", "signal", "expectedSignal", "launchError"] as const) {
    if (!validOptionalString(record[field])) throw new Error(`run record has an invalid ${field}`);
  }
  if (record.runtime !== undefined && record.runtime !== "apple" && record.runtime !== "docker") throw new Error("run record has an invalid runtime");
  if (record.stopRunId !== undefined && record.stopRunId !== record.runId) throw new Error("run record stop intent belongs to another run");
  if (record.exitCode !== undefined && !Number.isSafeInteger(record.exitCode)) throw new Error("run record has an invalid exitCode");
  if (record.terminationKind !== undefined && record.terminationKind !== "requested" && record.terminationKind !== "unexpected") throw new Error("run record has an invalid terminationKind");
  if (record.outcome !== undefined && !["stopped", "failed", "completed"].includes(String(record.outcome))) throw new Error("run record has an invalid outcome");
  if (record.status === "running" && (!record.launchedAt || !record.runtime || !record.container || record.finishedAt !== undefined)) throw new Error("running run record has incomplete launch data");
  if (record.status === "launch_failed" && (!record.finishedAt || !record.launchError || record.outcome !== "failed")) throw new Error("launch-failed run record has incomplete failure data");
  if (record.status === "stopping" && (!record.stopRequestedAt || record.stopRunId !== record.runId)) throw new Error("stopping run record has invalid stop intent");
  if (["stopped", "failed", "completed"].includes(String(record.status)) && (!record.finishedAt || record.exitCode === undefined || record.outcome !== record.status || !record.terminationKind)) throw new Error("terminal run record has incomplete termination data");
  return record as RunRecord;
}

async function context(cwd: string): Promise<RunContext> {
  const [active, ready] = await Promise.all([loadActiveGoal(cwd), loadReadyTicket(cwd)]);
  if (ready.record.goalId !== active.record.goalId || ready.record.baseRevision !== active.record.acceptedCodeRevision) throw new Error("ready ticket base does not match the active goal accepted code revision");
  const root = await realpath(active.record.repositoryRoot);
  const stateDir = join(root, ".pi-swarm");
  const ticketDirectory = join(stateDir, "goals", active.record.goalId, "tickets", ready.record.ticketId);
  return { root, stateDir, goal: active.record, ticket: ready.record, ticketDirectory, runsDirectory: join(ticketDirectory, "runs") };
}

async function loadRunFromContext(ctx: RunContext): Promise<RunRecord> {
  const pointerPath = join(ctx.ticketDirectory, "active-run.json");
  await rejectSymlinks(ctx.root, pointerPath, "active run pointer path");
  try { await access(pointerPath, constants.F_OK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("no run for the ready ticket; dispatch it with spike ticket dispatch <worker-name>");
    throw error;
  }
  const pointer = validateActiveRunPointer(await smallJson(pointerPath, "active run pointer"), { goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId });
  const path = within(ctx.root, pointer.recordPath, "active run record path");
  const expectedDirectory = join(ctx.runsDirectory, pointer.runId);
  if (path !== join(expectedDirectory, "record.v1.json")) throw new Error("active run pointer resolves outside its run directory");
  await rejectSymlinks(ctx.root, expectedDirectory, "active run directory");
  await rejectSymlinks(ctx.root, path, "active run record path");
  return validateRunRecord(await smallJson(path, "active run record"), {
    goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId, baseRevision: ctx.ticket.baseRevision, runId: pointer.runId,
  });
}

export async function loadActiveRun(cwd = process.cwd()): Promise<RunRecord> {
  return loadRunFromContext(await context(cwd));
}

async function writeRun(ctx: RunContext, record: RunRecord): Promise<void> {
  validateRunRecord(record, { goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId, baseRevision: ctx.ticket.baseRevision, runId: record.runId });
  await atomicWrite(join(ctx.runsDirectory, record.runId, "record.v1.json"), `${JSON.stringify(record, null, 2)}\n`);
}

function iso(now?: Date): string {
  const value = now ?? new Date();
  if (!Number.isFinite(value.getTime())) throw new Error("lifecycle timestamp is invalid");
  return value.toISOString();
}

export async function dispatchTicket(options: { cwd?: string; workerName: string; model?: string; thinking?: string; now?: Date; launcher: TicketLauncher }): Promise<RunRecord> {
  const cwd = options.cwd ?? process.cwd();
  const ctx = await context(cwd);
  const slug = workerSlug(options.workerName);
  if (!options.workerName.trim()) throw new Error("ticket dispatch requires a worker name");
  if (options.model !== undefined && !options.model) throw new Error("model must not be empty");
  if (options.thinking !== undefined && !options.thinking) throw new Error("thinking level must not be empty");
  await rejectSymlinks(ctx.root, ctx.runsDirectory, "run state path");
  await mkdir(ctx.runsDirectory, { recursive: true, mode: 0o700 });
  await rejectSymlinks(ctx.root, ctx.runsDirectory, "run state path");
  const lockPath = join(ctx.ticketDirectory, "dispatch.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another ticket dispatch is in progress");
    throw error;
  }
  try {
    try {
      const existing = await loadRunFromContext(ctx);
      throw new Error(`ticket already has run ${existing.runId} (${existing.status}); automatic redispatch is refused`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("no run for the ready ticket")) throw error;
    }
    const runId = `run-${randomUUID().replaceAll("-", "")}`;
    const createdAt = iso(options.now);
    let record: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION, runId, goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId,
      baseRevision: ctx.ticket.baseRevision, worker: { name: options.workerName, slug }, backend: "herdr",
      ...(options.model ? { requestedModel: options.model } : {}), ...(options.thinking ? { requestedThinking: options.thinking } : {}),
      status: "dispatching", createdAt,
    };
    const runDirectory = join(ctx.runsDirectory, runId);
    await mkdir(runDirectory, { mode: 0o700 });
    await durableWrite(join(runDirectory, "record.v1.json"), `${JSON.stringify(record, null, 2)}\n`);
    const pointer: ActiveRunPointer = {
      schemaVersion: ACTIVE_RUN_POINTER_SCHEMA_VERSION, goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId, runId,
      recordPath: `.pi-swarm/goals/${ctx.goal.goalId}/tickets/${ctx.ticket.ticketId}/runs/${runId}/record.v1.json`,
    };
    validateActiveRunPointer(pointer, { goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId });
    await atomicWrite(join(ctx.ticketDirectory, "active-run.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    const workerPath = `/output/workflow/${ctx.goal.goalId}/tickets/${ctx.ticket.ticketId}/ticket.md`;
    const task = `Implement durable ticket ${ctx.ticket.ticketId} from ${workerPath}. Follow every requirement, test and commit the work, and report verification, blockers, and risks.`;
    try {
      const launch = await options.launcher({ runId, goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId, baseRevision: ctx.ticket.baseRevision, workerName: options.workerName, workerSlug: slug, task, model: options.model, thinking: options.thinking });
      const current = await loadRunFromContext(ctx);
      record = {
        ...current, ...launch,
        ...(!current.launchedAt ? { launchedAt: iso() } : {}),
        ...(current.status === "dispatching" ? { status: "running" as const } : {}),
      };
      await writeRun(ctx, record);
      return record;
    } catch (error) {
      const current = await loadRunFromContext(ctx);
      record = { ...current, status: "launch_failed", finishedAt: iso(), launchError: cleanError(error), outcome: "failed", terminationKind: "unexpected" };
      await writeRun(ctx, record);
      throw new Error(`ticket run ${runId} launch failed: ${record.launchError}`);
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export function agentStatePath(stateDir: string, name: string): string {
  return join(stateDir, "agents", `${workerSlug(name)}.json`);
}

export function agentStopIntentPath(stateDir: string, name: string): string {
  return join(stateDir, "agents", "stop-intents", `${workerSlug(name)}.v1.json`);
}

async function readAgentStopIntent(stateDir: string, name: string): Promise<AgentStopIntent | undefined> {
  const slug = workerSlug(name);
  const path = agentStopIntentPath(stateDir, slug);
  try {
    await rejectSymlinks(stateDir, path, "agent stop intent path");
    return validateAgentStopIntent(await smallJson(path, "agent stop intent"), slug);
  } catch (error) {
    if (error instanceof Error && error.message === "agent stop intent is missing") return undefined;
    throw error;
  }
}

async function writeAgentStopIntent(stateDir: string, intent: AgentStopIntent): Promise<void> {
  validateAgentStopIntent(intent, intent.slug);
  const directory = join(stateDir, "agents", "stop-intents");
  const path = agentStopIntentPath(stateDir, intent.slug);
  await rejectSymlinks(stateDir, path, "agent stop intent path");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlinks(stateDir, path, "agent stop intent path");
  await atomicWrite(path, `${JSON.stringify(intent, null, 2)}\n`);
}

async function removeAgentStopIntent(stateDir: string, name: string): Promise<void> {
  const path = agentStopIntentPath(stateDir, name);
  await rejectSymlinks(stateDir, path, "agent stop intent path");
  await rm(path, { force: true });
}

function sameStopIntent(left: AgentStopIntent, right: AgentStopIntent): boolean {
  return left.schemaVersion === right.schemaVersion && left.slug === right.slug && left.startedAt === right.startedAt &&
    left.pid === right.pid && left.container === right.container && left.runId === right.runId &&
    left.stopRequestedAt === right.stopRequestedAt && left.stopRequester === right.stopRequester && left.stopReason === right.stopReason;
}

function stopIntentMatchesAgent(intent: AgentStopIntent, state: AgentState): boolean {
  return intent.slug === state.slug && intent.startedAt === state.startedAt && intent.pid === state.pid &&
    intent.container === state.container && intent.runId === state.runId;
}

function runMatchesAgent(run: RunRecord, state: AgentState): boolean {
  return run.runId === state.runId && run.goalId === state.goalId && run.ticketId === state.ticketId &&
    run.baseRevision === state.baseRevision && run.worker.slug === state.slug;
}

function runMatchesStopIntent(run: RunRecord, intent: AgentStopIntent): boolean {
  return run.runId === intent.runId && run.stopRunId === intent.runId && run.stopRequestedAt === intent.stopRequestedAt &&
    run.stopRequester === intent.stopRequester && run.stopReason === intent.stopReason;
}

function applyStopIntent<T extends AgentState | RunRecord>(record: T, intent: AgentStopIntent): T {
  const result = {
    ...record,
    stopRequestedAt: intent.stopRequestedAt,
    stopReason: intent.stopReason,
    ...(intent.stopRequester ? { stopRequester: intent.stopRequester } : {}),
    ...(intent.runId ? { stopRunId: intent.runId } : {}),
  } as T;
  if (!intent.stopRequester) delete result.stopRequester;
  if (!intent.runId) delete result.stopRunId;
  return result;
}

export async function readAgentState(stateDir: string, name: string): Promise<AgentState | undefined> {
  const slug = workerSlug(name);
  try {
    const path = agentStatePath(stateDir, slug);
    const normalized = normalizeAgentState(await smallJson(path, "agent state"), slug);
    // Active legacy launchers may still write their final schema-less state.
    // Normalize them in memory and migrate only terminal records eagerly;
    // lifecycle mutations (stop/open) persist the normalized v1 shape.
    if (normalized.migrated && normalized.state.finishedAt) await atomicWrite(path, `${JSON.stringify(normalized.state, null, 2)}\n`);
    return normalized.state;
  } catch (error) {
    if (error instanceof Error && error.message === "agent state is missing") return undefined;
    throw error;
  }
}

export async function writeAgentState(stateDir: string, state: AgentState): Promise<void> {
  validateAgentState(state, state.slug);
  const path = agentStatePath(stateDir, state.slug);
  await mkdir(join(stateDir, "agents"), { recursive: true, mode: 0o700 });
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function withAgentLock<T>(stateDir: string, slug: string, operation: () => Promise<T>, wait = false): Promise<T> {
  const lockPath = join(stateDir, "agents", `${slug}.lifecycle.lock`);
  await mkdir(join(stateDir, "agents"), { recursive: true, mode: 0o700 });
  let lock;
  const deadline = Date.now() + 30_000;
  while (!lock) {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!wait || Date.now() >= deadline) throw new Error(`another lifecycle operation for agent ${slug} is in progress`);
      await Bun.sleep(50);
    }
  }
  try { return await operation(); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function reconcileAgentStop(options: {
  cwd: string; stateDir: string; stopping: AgentState; intent: AgentStopIntent;
}): Promise<AgentState> {
  return withAgentLock(options.stateDir, options.stopping.slug, async () => {
    const [current, persistedIntent] = await Promise.all([
      readAgentState(options.stateDir, options.stopping.slug),
      readAgentStopIntent(options.stateDir, options.stopping.slug),
    ]);
    // A current launcher can finalize and consume the intent while runtime stop
    // is returning. In that case only report its result; never rewrite it.
    if (!persistedIntent) return current && stopIntentMatchesAgent(options.intent, current) ? current : options.stopping;
    if (!sameStopIntent(persistedIntent, options.intent) || !current || !stopIntentMatchesAgent(persistedIntent, current)) {
      if (sameStopIntent(persistedIntent, options.intent)) await removeAgentStopIntent(options.stateDir, persistedIntent.slug);
      return options.stopping;
    }
    if (!current.finishedAt) return current;

    let run: RunRecord | undefined;
    let runContext: RunContext | undefined;
    if (persistedIntent.runId) {
      run = await loadActiveRun(options.cwd);
      if (!runMatchesAgent(run, current) || !runMatchesStopIntent(run, persistedIntent)) {
        await removeAgentStopIntent(options.stateDir, persistedIntent.slug);
        return current;
      }
      runContext = await context(options.cwd);
    }

    const requested = applyStopIntent(current, persistedIntent);
    requested.lifecycle = "stopped";
    requested.outcome = "stopped";
    requested.terminationKind = "requested";
    requested.expectedSignal = "SIGTERM";
    if (requested.exitCode === 143) requested.signal = "SIGTERM";
    await writeAgentState(options.stateDir, requested);
    if (run && runContext) {
      const requestedRun = applyStopIntent(run, persistedIntent);
      requestedRun.status = "stopped";
      requestedRun.outcome = "stopped";
      requestedRun.finishedAt = requested.finishedAt;
      requestedRun.exitCode = requested.exitCode;
      requestedRun.terminationKind = "requested";
      requestedRun.expectedSignal = "SIGTERM";
      if (requested.exitCode === 143) requestedRun.signal = "SIGTERM";
      await writeRun(runContext, requestedRun);
    }
    await removeAgentStopIntent(options.stateDir, persistedIntent.slug);
    return requested;
  }, true);
}

export async function requestAgentStop(options: {
  cwd?: string; name: string; requester?: string; reason?: string; now?: Date;
  stopRuntime: (state: AgentState) => Promise<void>;
}): Promise<AgentState> {
  const cwd = options.cwd ?? process.cwd();
  const active = await loadActiveGoal(cwd).catch(() => undefined);
  const root = active ? active.record.repositoryRoot : await gitRoot(cwd);
  const stateDir = join(root, ".pi-swarm");
  const slug = workerSlug(options.name);
  const prepared = await withAgentLock(stateDir, slug, async () => {
    const state = await readAgentState(stateDir, slug);
    if (!state) throw new Error(`unknown agent: ${options.name}`);
    if (state.finishedAt) throw new Error(`agent ${slug} is already ${state.lifecycle}`);
    if (state.lifecycle === "stopping") throw new Error(`agent ${slug} is already stopping`);
    const requestedAt = iso(options.now);
    const reason = options.reason?.trim() || "operator-requested";
    const intent: AgentStopIntent = {
      schemaVersion: AGENT_STOP_INTENT_SCHEMA_VERSION,
      slug: state.slug,
      startedAt: state.startedAt,
      pid: state.pid,
      container: state.container,
      ...(state.runId ? { runId: state.runId } : {}),
      stopRequestedAt: requestedAt,
      ...(options.requester ? { stopRequester: options.requester } : {}),
      stopReason: reason,
    };
    let originalRun: RunRecord | undefined;
    let runContext: RunContext | undefined;
    if (state.runId) {
      originalRun = await loadActiveRun(cwd);
      if (!runMatchesAgent(originalRun, state)) throw new Error("agent/run identity mismatch; refusing to stop without correlated durable intent");
      runContext = await context(cwd);
    }
    const stopping = applyStopIntent({ ...state, lifecycle: "stopping" as const }, intent);
    await writeAgentStopIntent(stateDir, intent);
    try {
      if (originalRun && runContext) await writeRun(runContext, applyStopIntent({ ...originalRun, status: "stopping" as const }, intent));
      await writeAgentState(stateDir, stopping);
    } catch (error) {
      await removeAgentStopIntent(stateDir, slug);
      if (originalRun && runContext) await writeRun(runContext, originalRun);
      throw error;
    }
    return { stopping, intent };
  });
  // Runtime stop may wait for the foreground launcher to finish. Release the
  // lifecycle lock first so its finally block can record that exit.
  await options.stopRuntime(prepared.stopping);
  return reconcileAgentStop({ cwd, stateDir, ...prepared });
}

async function gitRoot(cwd: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", resolve(cwd), "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${cwd} is not a Git repository`);
  return realpath(stdout.trim());
}

export async function recordAgentExit(options: { cwd?: string; state: AgentState; exitCode: number; now?: Date }): Promise<AgentState> {
  const cwd = options.cwd ?? process.cwd();
  const root = await gitRoot(cwd);
  const stateDir = join(root, ".pi-swarm");
  return withAgentLock(stateDir, options.state.slug, async () => {
    const current = await readAgentState(stateDir, options.state.slug) ?? options.state;
    if (current.startedAt !== options.state.startedAt || current.pid !== options.state.pid || current.container !== options.state.container || current.runId !== options.state.runId) {
      throw new Error("agent identity changed before exit was recorded");
    }
    let run: RunRecord | undefined;
    if (current.runId) {
      run = await loadActiveRun(cwd);
      if (!runMatchesAgent(run, current)) throw new Error("agent/run identity changed before exit was recorded");
    }
    const durableIntent = await readAgentStopIntent(stateDir, current.slug);
    const durableMatch = Boolean(durableIntent && stopIntentMatchesAgent(durableIntent, current));
    const mutableMatch = Boolean(!durableIntent && current.stopRequestedAt && current.stopRunId === current.runId);
    const runIntentMatches = !run || Boolean(
      durableMatch && durableIntent ? runMatchesStopIntent(run, durableIntent) :
        mutableMatch && run.stopRequestedAt === current.stopRequestedAt && run.stopRunId === current.runId
    );
    const matchingIntent = (durableMatch || mutableMatch) && runIntentMatches;
    const outcome = matchingIntent ? "stopped" : options.exitCode === 0 ? "completed" : "failed";
    const finishedAt = iso(options.now);
    const signal = options.exitCode === 143 ? "SIGTERM" : undefined;
    const terminationKind = matchingIntent ? "requested" : "unexpected";
    let final: AgentState = {
      ...current, lifecycle: outcome, outcome, finishedAt, exitCode: options.exitCode, terminationKind,
      ...(signal ? { signal } : {}), ...(matchingIntent ? { expectedSignal: "SIGTERM" } : {}),
    };
    if (matchingIntent && durableIntent) final = applyStopIntent(final, durableIntent);
    await writeAgentState(stateDir, final);
    if (run) {
      const launchFailed = run.status === "launch_failed";
      let finalRun: RunRecord = {
        ...run, status: launchFailed ? "launch_failed" : outcome, outcome: launchFailed ? "failed" : outcome,
        finishedAt, exitCode: options.exitCode, terminationKind,
        ...(signal ? { signal } : {}), ...(matchingIntent ? { expectedSignal: "SIGTERM" } : {}),
      };
      if (matchingIntent && durableIntent) finalRun = applyStopIntent(finalRun, durableIntent);
      await writeRun(await context(cwd), finalRun);
    }
    if (durableIntent) await removeAgentStopIntent(stateDir, current.slug);
    return final;
  }, true);
}
