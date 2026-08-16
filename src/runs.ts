import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadActiveGoal, loadReadyTicket, type GoalRecord, type TicketRecord } from "./goals.ts";

export const RUN_SCHEMA_VERSION = 1;
export const ACTIVE_RUN_POINTER_SCHEMA_VERSION = 1;
export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_STOP_INTENT_SCHEMA_VERSION = 1;
export const AGENT_FINALIZATION_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 128 * 1024;
export const MAX_RETRY_REASON_BYTES = 500;
const runIdPattern = /^run-[0-9a-f]{32}$/;
const finalizationIdPattern = /^(?:run|start)-[0-9a-f]{32}$/;
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
  retryOfRunId?: string;
  retryReason?: string;
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

export type RunAttemptHistory = {
  goalId: string;
  ticketId: string;
  baseRevision: string;
  activeRunId: string | null;
  attempts: RunRecord[];
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

export type AgentCorrelation = {
  goalId: string;
  ticketId: string;
  baseRevision: string;
  runId?: string;
};

export type AgentFinalizationResourceStatus = "pending" | "removed" | "absent" | "failed" | "not_configured";
export type AgentFinalizationResourceRecord = {
  status: AgentFinalizationResourceStatus;
  identifier?: string;
  detail?: string;
};

export type AgentFinalizationRecord = {
  schemaVersion: 1;
  finalizationId: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  agent: Pick<AgentState,
    "name" | "slug" | "project" | "runtime" | "container" | "workspaceVolume" | "network" | "alias" |
    "hostPort" | "containerPort" | "operatorUrl" | "backend" | "herdrName" | "herdrWorkspaceId" | "herdrTabId" |
    "herdrPaneId" | "startedAt" | "pid">;
  correlation?: AgentCorrelation;
  terminal: Pick<AgentState,
    "lifecycle" | "finishedAt" | "stopRequestedAt" | "stopRequester" | "stopReason" | "stopRunId" |
    "exitCode" | "signal" | "expectedSignal" | "terminationKind" | "outcome">;
  cleanup: {
    container: AgentFinalizationResourceRecord;
    workspaceVolume: AgentFinalizationResourceRecord;
    network: AgentFinalizationResourceRecord;
    alias: AgentFinalizationResourceRecord;
    herdrTab: AgentFinalizationResourceRecord;
  };
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

function validRetryReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_RETRY_REASON_BYTES;
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
  const identity = [record.goalId, record.ticketId, record.baseRevision];
  const present = identity.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== identity.length) throw new Error(`${label} has incomplete ticket correlation`);
  if (record.runId !== undefined && present !== identity.length) throw new Error(`${label} has a run without ticket correlation`);
  if (present) {
    if (typeof record.goalId !== "string" || !goalIdPattern.test(record.goalId)) throw new Error(`${label} has an invalid goalId`);
    if (typeof record.ticketId !== "string" || !ticketIdPattern.test(record.ticketId)) throw new Error(`${label} has an invalid ticketId`);
    if (typeof record.baseRevision !== "string" || !objectIdPattern.test(record.baseRevision)) throw new Error(`${label} has an invalid baseRevision`);
  }
  if (record.runId !== undefined && (typeof record.runId !== "string" || !runIdPattern.test(record.runId))) throw new Error(`${label} has an invalid runId`);
}

function finalizationIdentity(state: Pick<AgentState, "project" | "slug" | "container" | "startedAt" | "pid" | "runId">): string {
  if (state.runId) return state.runId;
  return `start-${new Bun.CryptoHasher("sha256").update(`spike-agent-finalization-v1\0${JSON.stringify({
    project: state.project,
    slug: state.slug,
    container: state.container,
    startedAt: state.startedAt,
    pid: state.pid,
  })}`).digest("hex").slice(0, 32)}`;
}

function correlationFromState(state: AgentState): AgentCorrelation | undefined {
  if (!state.goalId || !state.ticketId || !state.baseRevision) return undefined;
  return {
    goalId: state.goalId,
    ticketId: state.ticketId,
    baseRevision: state.baseRevision,
    ...(state.runId ? { runId: state.runId } : {}),
  };
}

function finalizationResource(status: AgentFinalizationResourceStatus, identifier?: string, detail?: string): AgentFinalizationResourceRecord {
  return { status, ...(identifier ? { identifier } : {}), ...(detail ? { detail } : {}) };
}

function defaultFinalizationCleanup(state: AgentState): AgentFinalizationRecord["cleanup"] {
  return {
    container: finalizationResource("pending", state.container),
    workspaceVolume: finalizationResource("pending", state.workspaceVolume),
    network: finalizationResource("pending", state.network),
    alias: state.alias ? finalizationResource("pending", state.alias) : finalizationResource("not_configured"),
    herdrTab: state.herdrTabId ? finalizationResource("pending", state.herdrTabId) : finalizationResource("not_configured"),
  };
}

function finalizationComplete(cleanup: AgentFinalizationRecord["cleanup"]): boolean {
  return Object.values(cleanup).every((resource) => ["removed", "absent", "not_configured"].includes(resource.status));
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

export function agentFinalizationPath(stateDir: string, finalizationId: string): string {
  return join(stateDir, "finalized-agents", `${finalizationId}.v1.json`);
}

function validateFinalizationResource(value: unknown, label: string): AgentFinalizationResourceRecord {
  const resource = requireObject(value, label);
  if (!["pending", "removed", "absent", "failed", "not_configured"].includes(String(resource.status))) throw new Error(`${label} has an invalid status`);
  if (!validOptionalString(resource.identifier)) throw new Error(`${label} has an invalid identifier`);
  if (!validOptionalString(resource.detail)) throw new Error(`${label} has an invalid detail`);
  return resource as AgentFinalizationResourceRecord;
}

export function validateAgentFinalizationRecord(value: unknown, expected: { finalizationId?: string; slug?: string } = {}): AgentFinalizationRecord {
  const record = requireObject(value, "agent finalization record");
  if (record.schemaVersion !== AGENT_FINALIZATION_SCHEMA_VERSION) throw new Error(`unsupported agent finalization schema: ${String(record.schemaVersion)}`);
  if (typeof record.finalizationId !== "string" || !finalizationIdPattern.test(record.finalizationId) || (expected.finalizationId && record.finalizationId !== expected.finalizationId)) {
    throw new Error("agent finalization record has an invalid finalizationId");
  }
  requireTimestamp(record.createdAt, "agent finalization record createdAt");
  requireTimestamp(record.updatedAt, "agent finalization record updatedAt");
  if (record.finalizedAt !== undefined) requireTimestamp(record.finalizedAt, "agent finalization record finalizedAt");
  const agent = requireObject(record.agent, "agent finalization record agent");
  const validatedAgent = validateAgentState({
    schemaVersion: AGENT_SCHEMA_VERSION,
    name: agent.name,
    slug: agent.slug,
    project: agent.project,
    runtime: agent.runtime,
    container: agent.container,
    workspaceVolume: agent.workspaceVolume,
    network: agent.network,
    ...(agent.alias !== undefined ? { alias: agent.alias } : {}),
    ...(agent.hostPort !== undefined ? { hostPort: agent.hostPort } : {}),
    containerPort: agent.containerPort,
    ...(agent.operatorUrl !== undefined ? { operatorUrl: agent.operatorUrl } : {}),
    backend: agent.backend,
    ...(agent.herdrName !== undefined ? { herdrName: agent.herdrName } : {}),
    ...(agent.herdrWorkspaceId !== undefined ? { herdrWorkspaceId: agent.herdrWorkspaceId } : {}),
    ...(agent.herdrTabId !== undefined ? { herdrTabId: agent.herdrTabId } : {}),
    ...(agent.herdrPaneId !== undefined ? { herdrPaneId: agent.herdrPaneId } : {}),
    lifecycle: "completed",
    startedAt: agent.startedAt,
    finishedAt: record.updatedAt,
    exitCode: 0,
    terminationKind: "unexpected",
    outcome: "completed",
    pid: agent.pid,
  }, expected.slug);
  const correlation = record.correlation === undefined ? undefined : (() => {
    const value = requireObject(record.correlation, "agent finalization record correlation");
    validateCorrelation(value, "agent finalization record correlation");
    return value as AgentCorrelation;
  })();
  const terminal = requireObject(record.terminal, "agent finalization record terminal");
  if (!["stopped", "failed", "completed"].includes(String(terminal.lifecycle))) throw new Error("agent finalization record terminal has an invalid lifecycle");
  if (terminal.outcome !== terminal.lifecycle) throw new Error("agent finalization record terminal outcome does not match lifecycle");
  requireTimestamp(terminal.finishedAt, "agent finalization record terminal finishedAt");
  for (const field of ["stopRequestedAt"] as const) if (terminal[field] !== undefined) requireTimestamp(terminal[field], `agent finalization record terminal ${field}`);
  for (const field of ["stopRequester", "stopReason", "stopRunId", "signal", "expectedSignal"] as const) if (!validOptionalString(terminal[field])) throw new Error(`agent finalization record terminal has an invalid ${field}`);
  if (terminal.stopRunId !== undefined && (typeof terminal.stopRunId !== "string" || !runIdPattern.test(terminal.stopRunId))) throw new Error("agent finalization record terminal has an invalid stopRunId");
  if (!Number.isSafeInteger(terminal.exitCode)) throw new Error("agent finalization record terminal has an invalid exitCode");
  if (terminal.terminationKind !== "requested" && terminal.terminationKind !== "unexpected") throw new Error("agent finalization record terminal has an invalid terminationKind");
  const cleanup = requireObject(record.cleanup, "agent finalization record cleanup");
  const validatedCleanup = {
    container: validateFinalizationResource(cleanup.container, "agent finalization record cleanup container"),
    workspaceVolume: validateFinalizationResource(cleanup.workspaceVolume, "agent finalization record cleanup workspaceVolume"),
    network: validateFinalizationResource(cleanup.network, "agent finalization record cleanup network"),
    alias: validateFinalizationResource(cleanup.alias, "agent finalization record cleanup alias"),
    herdrTab: validateFinalizationResource(cleanup.herdrTab, "agent finalization record cleanup herdrTab"),
  };
  if (validatedCleanup.container.identifier !== validatedAgent.container) throw new Error("agent finalization cleanup container does not match agent state");
  if (validatedCleanup.workspaceVolume.identifier !== validatedAgent.workspaceVolume) throw new Error("agent finalization cleanup workspace volume does not match agent state");
  if (validatedCleanup.network.identifier !== validatedAgent.network) throw new Error("agent finalization cleanup network does not match agent state");
  if (validatedAgent.alias) {
    if (validatedCleanup.alias.identifier !== validatedAgent.alias || validatedCleanup.alias.status === "not_configured") throw new Error("agent finalization cleanup alias does not match agent state");
  } else if (validatedCleanup.alias.status !== "not_configured") throw new Error("agent finalization cleanup alias is inconsistent with agent state");
  if (validatedAgent.herdrTabId) {
    if (validatedCleanup.herdrTab.identifier !== validatedAgent.herdrTabId || validatedCleanup.herdrTab.status === "not_configured") throw new Error("agent finalization cleanup Herdr tab does not match agent state");
  } else if (validatedCleanup.herdrTab.status !== "not_configured") throw new Error("agent finalization cleanup Herdr tab is inconsistent with agent state");
  if (correlation) {
    if (validatedAgent.runId !== undefined) throw new Error("agent finalization record agent unexpectedly retained a runId");
    if (correlation.runId && record.finalizationId !== correlation.runId) throw new Error("agent finalization run correlation does not match its key");
  }
  if (record.finalizationId.startsWith("run-") && correlation?.runId !== record.finalizationId) throw new Error("agent finalization run key does not match its correlation");
  if (record.finalizationId.startsWith("start-") && correlation?.runId) throw new Error("agent finalization start key conflicts with run correlation");
  if (record.finalizationId !== finalizationIdentity({
    project: validatedAgent.project,
    slug: validatedAgent.slug,
    container: validatedAgent.container,
    startedAt: validatedAgent.startedAt,
    pid: validatedAgent.pid,
    ...(correlation?.runId ? { runId: correlation.runId } : {}),
  })) throw new Error("agent finalization key does not match the retired start identity");
  if (record.finalizedAt !== undefined && !finalizationComplete(validatedCleanup)) throw new Error("agent finalization finalizedAt conflicts with pending cleanup");
  return record as AgentFinalizationRecord;
}

function finalizationFromState(state: AgentState, now: string, existing?: AgentFinalizationRecord): AgentFinalizationRecord {
  if (!state.finishedAt || !state.outcome || !state.terminationKind) throw new Error(`agent ${state.slug} is not terminal`);
  const finalizationId = finalizationIdentity(state);
  const cleanup = existing?.cleanup ?? defaultFinalizationCleanup(state);
  return validateAgentFinalizationRecord({
    schemaVersion: AGENT_FINALIZATION_SCHEMA_VERSION,
    finalizationId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.finalizedAt ? { finalizedAt: existing.finalizedAt } : {}),
    agent: {
      name: state.name,
      slug: state.slug,
      project: state.project,
      runtime: state.runtime,
      container: state.container,
      workspaceVolume: state.workspaceVolume,
      network: state.network,
      ...(state.alias ? { alias: state.alias } : {}),
      ...(state.hostPort ? { hostPort: state.hostPort } : {}),
      containerPort: state.containerPort,
      ...(state.operatorUrl ? { operatorUrl: state.operatorUrl } : {}),
      backend: state.backend,
      ...(state.herdrName ? { herdrName: state.herdrName } : {}),
      ...(state.herdrWorkspaceId ? { herdrWorkspaceId: state.herdrWorkspaceId } : {}),
      ...(state.herdrTabId ? { herdrTabId: state.herdrTabId } : {}),
      ...(state.herdrPaneId ? { herdrPaneId: state.herdrPaneId } : {}),
      startedAt: state.startedAt,
      pid: state.pid,
    },
    ...(correlationFromState(state) ? { correlation: correlationFromState(state) } : {}),
    terminal: {
      lifecycle: state.lifecycle,
      finishedAt: state.finishedAt,
      ...(state.stopRequestedAt ? { stopRequestedAt: state.stopRequestedAt } : {}),
      ...(state.stopRequester ? { stopRequester: state.stopRequester } : {}),
      ...(state.stopReason ? { stopReason: state.stopReason } : {}),
      ...(state.stopRunId ? { stopRunId: state.stopRunId } : {}),
      exitCode: state.exitCode!,
      ...(state.signal ? { signal: state.signal } : {}),
      ...(state.expectedSignal ? { expectedSignal: state.expectedSignal } : {}),
      terminationKind: state.terminationKind,
      outcome: state.outcome,
    },
    cleanup,
  }, { finalizationId, slug: state.slug });
}

export async function readAgentFinalization(stateDir: string, finalizationId: string): Promise<AgentFinalizationRecord | undefined> {
  if (!finalizationIdPattern.test(finalizationId)) throw new Error("agent finalization lookup has an invalid finalizationId");
  const path = agentFinalizationPath(stateDir, finalizationId);
  try {
    await rejectSymlinks(stateDir, path, "agent finalization path");
    return validateAgentFinalizationRecord(await smallJson(path, "agent finalization record"), { finalizationId });
  } catch (error) {
    if (error instanceof Error && error.message === "agent finalization record is missing") return undefined;
    throw error;
  }
}

export async function writeAgentFinalization(stateDir: string, record: AgentFinalizationRecord): Promise<void> {
  validateAgentFinalizationRecord(record, { finalizationId: record.finalizationId, slug: record.agent.slug });
  const path = agentFinalizationPath(stateDir, record.finalizationId);
  await mkdir(join(stateDir, "finalized-agents"), { recursive: true, mode: 0o700 });
  await rejectSymlinks(stateDir, path, "agent finalization path");
  await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
}

export async function listAgentFinalizations(stateDir: string, slug?: string): Promise<AgentFinalizationRecord[]> {
  const directory = join(stateDir, "finalized-agents");
  try { await rejectSymlinks(stateDir, directory, "agent finalization directory"); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("agent finalization directory must not contain symbolic links")) throw error;
  }
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".v1.json")).sort();
    const finalizations: AgentFinalizationRecord[] = [];
    for (const file of files) {
      const finalizationId = file.slice(0, -8);
      const record = await readAgentFinalization(stateDir, finalizationId);
      if (record && (!slug || record.agent.slug === slug)) finalizations.push(record);
    }
    return finalizations;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function ensureAgentFinalization(stateDir: string, state: AgentState, now = iso()): Promise<AgentFinalizationRecord> {
  const finalizationId = finalizationIdentity(state);
  const existing = await readAgentFinalization(stateDir, finalizationId);
  const record = finalizationFromState(state, now, existing);
  await writeAgentFinalization(stateDir, record);
  return record;
}

export function finalizedAgentIdentity(state: Pick<AgentState, "project" | "slug" | "container" | "startedAt" | "pid" | "runId">): string {
  return finalizationIdentity(state);
}

export function finalizedAgentComplete(record: AgentFinalizationRecord): boolean {
  return finalizationComplete(record.cleanup);
}

export function finalizedAgentMatchesState(record: AgentFinalizationRecord, state: AgentState): boolean {
  return record.finalizationId === finalizationIdentity(state) && record.agent.slug === state.slug && record.agent.project === state.project &&
    record.agent.container === state.container && record.agent.startedAt === state.startedAt && record.agent.pid === state.pid &&
    record.agent.workspaceVolume === state.workspaceVolume && record.agent.network === state.network &&
    record.correlation?.goalId === state.goalId && record.correlation?.ticketId === state.ticketId && record.correlation?.baseRevision === state.baseRevision &&
    record.correlation?.runId === state.runId;
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
  if (record.retryOfRunId !== undefined && (typeof record.retryOfRunId !== "string" || !runIdPattern.test(record.retryOfRunId) || record.retryOfRunId === record.runId)) {
    throw new Error("run record has an invalid retryOfRunId");
  }
  if (record.retryReason !== undefined && !validRetryReason(record.retryReason)) throw new Error("run record has an invalid retryReason");
  if (record.retryReason !== undefined && record.retryOfRunId === undefined) throw new Error("run record retryReason has no retryOfRunId");
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

async function readActiveRunPointer(ctx: RunContext, allowMissing = false): Promise<ActiveRunPointer | undefined> {
  const pointerPath = join(ctx.ticketDirectory, "active-run.json");
  await rejectSymlinks(ctx.root, pointerPath, "active run pointer path");
  try { await access(pointerPath, constants.F_OK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("no run for the ready ticket; dispatch it with spike ticket dispatch <worker-name>");
    throw error;
  }
  return validateActiveRunPointer(await smallJson(pointerPath, "active run pointer"), { goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId });
}

function runRecordPath(ctx: RunContext, runId: string): string {
  return join(ctx.runsDirectory, runId, "record.v1.json");
}

function activeRunPointer(runId: string, ctx: RunContext): ActiveRunPointer {
  const pointer: ActiveRunPointer = {
    schemaVersion: ACTIVE_RUN_POINTER_SCHEMA_VERSION,
    goalId: ctx.goal.goalId,
    ticketId: ctx.ticket.ticketId,
    runId,
    recordPath: `.pi-swarm/goals/${ctx.goal.goalId}/tickets/${ctx.ticket.ticketId}/runs/${runId}/record.v1.json`,
  };
  return validateActiveRunPointer(pointer, { goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId });
}

async function loadRunById(ctx: RunContext, runId: string, label = "run record"): Promise<RunRecord> {
  if (!runIdPattern.test(runId)) throw new Error(`${label} has an invalid runId`);
  const directory = join(ctx.runsDirectory, runId);
  const path = runRecordPath(ctx, runId);
  await rejectSymlinks(ctx.root, directory, `${label} directory`);
  await rejectSymlinks(ctx.root, path, `${label} path`);
  return validateRunRecord(await smallJson(path, label), {
    goalId: ctx.goal.goalId,
    ticketId: ctx.ticket.ticketId,
    baseRevision: ctx.ticket.baseRevision,
    runId,
  });
}

async function loadRunFromContext(ctx: RunContext): Promise<RunRecord> {
  const pointer = await readActiveRunPointer(ctx);
  const path = within(ctx.root, pointer.recordPath, "active run record path");
  const expectedDirectory = join(ctx.runsDirectory, pointer.runId);
  if (path !== join(expectedDirectory, "record.v1.json")) throw new Error("active run pointer resolves outside its run directory");
  return loadRunById(ctx, pointer.runId, "active run record");
}

async function listRunAttemptsFromContext(ctx: RunContext): Promise<RunRecord[]> {
  await rejectSymlinks(ctx.root, ctx.runsDirectory, "run state path");
  let entries: string[];
  try { entries = (await readdir(ctx.runsDirectory)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const attempts: RunRecord[] = [];
  for (const entry of entries) {
    if (!runIdPattern.test(entry)) throw new Error(`run state contains an unexpected entry: ${entry}`);
    attempts.push(await loadRunById(ctx, entry));
  }
  return attempts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
}

async function ensureRunsDirectory(ctx: RunContext): Promise<void> {
  await rejectSymlinks(ctx.root, ctx.runsDirectory, "run state path");
  await mkdir(ctx.runsDirectory, { recursive: true, mode: 0o700 });
  await rejectSymlinks(ctx.root, ctx.runsDirectory, "run state path");
}

async function withRunTransitionLock<T>(ctx: RunContext, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(ctx.ticketDirectory, "dispatch.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another ticket dispatch or retry is in progress");
    throw error;
  }
  try { return await operation(); }
  finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function retryLineage(attempts: RunRecord[], failedRunId: string): RunRecord[] {
  return attempts.filter((attempt) => attempt.retryOfRunId === failedRunId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
}

function workerTask(ctx: RunContext): string {
  const workerPath = `/output/workflow/${ctx.goal.goalId}/tickets/${ctx.ticket.ticketId}/ticket.md`;
  return `Implement durable ticket ${ctx.ticket.ticketId} from ${workerPath}. Follow every requirement, test and commit the work, and report verification, blockers, and risks.`;
}

async function createDispatchingRun(ctx: RunContext, options: {
  workerName: string;
  workerSlug: string;
  model?: string;
  thinking?: string;
  now?: Date;
  retryOfRunId?: string;
  retryReason?: string;
  runId?: string;
}): Promise<RunRecord> {
  const runId = options.runId ?? `run-${randomUUID().replaceAll("-", "")}`;
  const record: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    goalId: ctx.goal.goalId,
    ticketId: ctx.ticket.ticketId,
    baseRevision: ctx.ticket.baseRevision,
    worker: { name: options.workerName, slug: options.workerSlug },
    backend: "herdr",
    ...(options.model ? { requestedModel: options.model } : {}),
    ...(options.thinking ? { requestedThinking: options.thinking } : {}),
    ...(options.retryOfRunId ? { retryOfRunId: options.retryOfRunId } : {}),
    ...(options.retryReason ? { retryReason: options.retryReason } : {}),
    status: "dispatching",
    createdAt: iso(options.now),
  };
  await mkdir(join(ctx.runsDirectory, runId), { mode: 0o700 });
  await durableWrite(runRecordPath(ctx, runId), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function pointActiveRun(ctx: RunContext, runId: string): Promise<void> {
  await atomicWrite(join(ctx.ticketDirectory, "active-run.json"), `${JSON.stringify(activeRunPointer(runId, ctx), null, 2)}\n`);
}

async function launchPreparedRun(ctx: RunContext, record: RunRecord, options: { launcher: TicketLauncher; model?: string; thinking?: string; now?: Date }): Promise<RunRecord> {
  const request: DispatchLaunchRequest = {
    runId: record.runId,
    goalId: ctx.goal.goalId,
    ticketId: ctx.ticket.ticketId,
    baseRevision: ctx.ticket.baseRevision,
    workerName: record.worker.name,
    workerSlug: record.worker.slug,
    task: workerTask(ctx),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
  };
  try {
    const launch = await options.launcher(request);
    const current = await loadRunById(ctx, record.runId, "prepared run record");
    const launched: RunRecord = {
      ...current,
      ...launch,
      ...(!current.launchedAt ? { launchedAt: iso(options.now) } : {}),
      ...(current.status === "dispatching" ? { status: "running" as const } : {}),
    };
    await writeRun(ctx, launched);
    return launched;
  } catch (error) {
    const current = await loadRunById(ctx, record.runId, "prepared run record");
    const failed: RunRecord = {
      ...current,
      status: "launch_failed",
      finishedAt: iso(options.now),
      launchError: cleanError(error),
      outcome: "failed",
      terminationKind: "unexpected",
    };
    await writeRun(ctx, failed);
    throw new Error(`ticket run ${record.runId} launch failed: ${failed.launchError}`);
  }
}

export async function loadActiveRun(cwd = process.cwd()): Promise<RunRecord> {
  return loadRunFromContext(await context(cwd));
}

export async function loadRunAttemptHistory(cwd = process.cwd()): Promise<RunAttemptHistory> {
  const ctx = await context(cwd);
  const pointer = await readActiveRunPointer(ctx, true);
  const attempts = await listRunAttemptsFromContext(ctx);
  return {
    goalId: ctx.goal.goalId,
    ticketId: ctx.ticket.ticketId,
    baseRevision: ctx.ticket.baseRevision,
    activeRunId: pointer?.runId ?? null,
    attempts,
  };
}

async function writeRun(ctx: RunContext, record: RunRecord): Promise<void> {
  validateRunRecord(record, { goalId: ctx.goal.goalId, ticketId: ctx.ticket.ticketId, baseRevision: ctx.ticket.baseRevision, runId: record.runId });
  await atomicWrite(runRecordPath(ctx, record.runId), `${JSON.stringify(record, null, 2)}\n`);
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
  await ensureRunsDirectory(ctx);
  return withRunTransitionLock(ctx, async () => {
    try {
      const existing = await loadRunFromContext(ctx);
      throw new Error(`ticket already has run ${existing.runId} (${existing.status}); automatic redispatch is refused`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("no run for the ready ticket")) throw error;
    }
    const record = await createDispatchingRun(ctx, {
      workerName: options.workerName,
      workerSlug: slug,
      model: options.model,
      thinking: options.thinking,
      now: options.now,
    });
    await pointActiveRun(ctx, record.runId);
    return launchPreparedRun(ctx, record, options);
  });
}

export async function retryActiveRun(options: {
  cwd?: string;
  acknowledgedRunId: string;
  workerName: string;
  model?: string;
  thinking?: string;
  reason?: string;
  now?: Date;
  launcher: TicketLauncher;
}): Promise<RunRecord> {
  const cwd = options.cwd ?? process.cwd();
  if (!runIdPattern.test(options.acknowledgedRunId)) throw new Error("run retry requires an exact acknowledged run ID");
  if (!options.workerName.trim()) throw new Error("run retry requires a worker name");
  if (options.model !== undefined && !options.model) throw new Error("model must not be empty");
  if (options.thinking !== undefined && !options.thinking) throw new Error("thinking level must not be empty");
  if (options.reason !== undefined && !validRetryReason(options.reason)) throw new Error(`run retry reason must be nonblank text of at most ${MAX_RETRY_REASON_BYTES} UTF-8 bytes`);
  const ctx = await context(cwd);
  const slug = workerSlug(options.workerName);
  await ensureRunsDirectory(ctx);
  return withRunTransitionLock(ctx, async () => {
    const current = await loadRunFromContext(ctx);
    if (current.runId !== options.acknowledgedRunId) {
      if (current.retryOfRunId === options.acknowledgedRunId) throw new Error(`active run ${current.runId} already retried failed run ${options.acknowledgedRunId}; stale acknowledgement is refused`);
      throw new Error(`active run ${current.runId} does not match acknowledged failed run ${options.acknowledgedRunId}`);
    }
    if (["dispatching", "running", "stopping"].includes(current.status)) throw new Error(`active run ${current.runId} is live (${current.status}); explicit retry is refused`);
    const retryableTerminal = current.status === "stopped" || current.status === "failed";
    if (current.status !== "launch_failed" && !retryableTerminal) {
      throw new Error(`active run ${current.runId} is ${current.status}; only launch_failed, stopped, or failed runs can be retried`);
    }
    if (retryableTerminal && !validRetryReason(options.reason)) {
      throw new Error(`run retry of ${current.status} run ${current.runId} requires a nonblank --reason of at most ${MAX_RETRY_REASON_BYTES} UTF-8 bytes`);
    }

    const lineage = retryLineage(await listRunAttemptsFromContext(ctx), current.runId);
    if (lineage.length > 1) throw new Error(`multiple retry records already acknowledge failed run ${current.runId}; concurrent retry recovery is required`);
    let record = lineage[0];
    if (record) {
      if (record.status !== "dispatching" || record.launchedAt || record.finishedAt || record.runtime || record.container || record.launchError) {
        throw new Error(`retry record ${record.runId} for failed run ${current.runId} is not resumable`);
      }
      if (record.worker.name !== options.workerName || record.worker.slug !== slug || record.requestedModel !== options.model || record.requestedThinking !== options.thinking || record.retryReason !== options.reason) {
        throw new Error(`retry record ${record.runId} for run ${current.runId} conflicts with the requested worker or launch provenance`);
      }
    } else {
      record = await createDispatchingRun(ctx, {
        workerName: options.workerName,
        workerSlug: slug,
        model: options.model,
        thinking: options.thinking,
        ...(options.reason !== undefined ? { retryReason: options.reason } : {}),
        now: options.now,
        retryOfRunId: current.runId,
      });
    }
    await pointActiveRun(ctx, record.runId);
    return launchPreparedRun(ctx, record, options);
  });
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
