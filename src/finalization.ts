import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentStatePath, agentStopIntentPath, type AgentState } from "./runs.ts";
import { atomicWrite, readJson, validTimestamp } from "./workflow-state.ts";

export const AGENT_FINALIZATION_SCHEMA_VERSION = 1;
export type CleanupStatus = "pending" | "removed" | "absent" | "not_configured" | "failed";
export type CleanupKey = "container" | "alias" | "workspaceVolume" | "network" | "herdrTab";
export type CleanupEntry = {
  status: CleanupStatus;
  resource?: string;
  detail?: string;
  command?: string[];
  probeCommand?: string[];
  attemptedAt?: string;
  settledAt?: string;
};
export type AgentFinalizationRecord = {
  schemaVersion: 1;
  slug: string;
  runtime: "apple" | "docker";
  startedAt: string;
  pid: number;
  container: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  cleanup: Record<CleanupKey, CleanupEntry>;
  completedAt?: string;
};
export type CommandResult = { code: number; stdout: string; stderr: string };
export type FinalizationCommandRunner = (command: string[]) => Promise<CommandResult>;
export type CommandAvailability = (command: string) => Promise<boolean>;
export type FinalizationResult = { record: AgentFinalizationRecord; completed: boolean; failedResources: CleanupKey[] };

const cleanupKeys: CleanupKey[] = ["container", "alias", "workspaceVolume", "network", "herdrTab"];
const completedStatuses = new Set<CleanupStatus>(["removed", "absent", "not_configured"]);

function runtimeCommand(runtime: AgentState["runtime"]): string {
  return runtime === "apple" ? "container" : "docker";
}

export function finalizationRecordPath(stateDir: string, slug: string): string {
  return join(stateDir, "agents", "finalization", `${slug}.v1.json`);
}

export function finalizedAgentPath(stateDir: string, slug: string): string {
  return join(stateDir, "agents", "finalized", `${slug}.v1.json`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

function validCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function validStatus(value: unknown): value is CleanupStatus {
  return value === "pending" || value === "removed" || value === "absent" || value === "not_configured" || value === "failed";
}

function iso(now = new Date()): string {
  return now.toISOString();
}

function cleanupEntry(resource: string | undefined, status: CleanupStatus = resource ? "pending" : "not_configured"): CleanupEntry {
  return { status, ...(resource ? { resource } : {}) };
}

function initializeRecord(state: AgentState, now: string): AgentFinalizationRecord {
  return {
    schemaVersion: AGENT_FINALIZATION_SCHEMA_VERSION,
    slug: state.slug,
    runtime: state.runtime,
    startedAt: state.startedAt,
    pid: state.pid,
    container: state.container,
    ...(state.runId ? { runId: state.runId } : {}),
    createdAt: now,
    updatedAt: now,
    cleanup: {
      container: cleanupEntry(state.container),
      alias: cleanupEntry(state.alias),
      workspaceVolume: cleanupEntry(state.workspaceVolume),
      network: cleanupEntry(state.network),
      herdrTab: cleanupEntry(state.herdrTabId),
    },
  };
}

function normalizeCleanupEntry(value: unknown, fallback: CleanupEntry): CleanupEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const entry = value as Record<string, unknown>;
  const status = validStatus(entry.status) ? entry.status : fallback.status;
  const resource = typeof entry.resource === "string" && entry.resource ? entry.resource : fallback.resource;
  const detail = typeof entry.detail === "string" && entry.detail ? entry.detail : undefined;
  const command = validCommand(entry.command) ? entry.command : undefined;
  const probeCommand = validCommand(entry.probeCommand) ? entry.probeCommand : undefined;
  const attemptedAt = validTimestamp(entry.attemptedAt) ? entry.attemptedAt : undefined;
  const settledAt = validTimestamp(entry.settledAt) ? entry.settledAt : undefined;
  return { status, ...(resource ? { resource } : {}), ...(detail ? { detail } : {}), ...(command ? { command } : {}), ...(probeCommand ? { probeCommand } : {}), ...(attemptedAt ? { attemptedAt } : {}), ...(settledAt ? { settledAt } : {}) };
}

export function validateFinalizationRecord(value: unknown, state: AgentState): AgentFinalizationRecord {
  const fallback = initializeRecord(state, iso());
  const record = object(value, "agent finalization record");
  const cleanup = object(record.cleanup, "agent finalization cleanup");
  const normalized: AgentFinalizationRecord = {
    schemaVersion: record.schemaVersion === AGENT_FINALIZATION_SCHEMA_VERSION ? AGENT_FINALIZATION_SCHEMA_VERSION : AGENT_FINALIZATION_SCHEMA_VERSION,
    slug: typeof record.slug === "string" && record.slug ? record.slug : state.slug,
    runtime: record.runtime === "apple" || record.runtime === "docker" ? record.runtime : state.runtime,
    startedAt: typeof record.startedAt === "string" && record.startedAt ? record.startedAt : state.startedAt,
    pid: Number.isInteger(record.pid) ? record.pid as number : state.pid,
    container: typeof record.container === "string" && record.container ? record.container : state.container,
    ...(typeof record.runId === "string" && record.runId ? { runId: record.runId } : state.runId ? { runId: state.runId } : {}),
    createdAt: validTimestamp(record.createdAt) ? record.createdAt as string : fallback.createdAt,
    updatedAt: validTimestamp(record.updatedAt) ? record.updatedAt as string : fallback.updatedAt,
    cleanup: {
      container: normalizeCleanupEntry(cleanup.container, fallback.cleanup.container),
      alias: normalizeCleanupEntry(cleanup.alias, fallback.cleanup.alias),
      workspaceVolume: normalizeCleanupEntry(cleanup.workspaceVolume, fallback.cleanup.workspaceVolume),
      network: normalizeCleanupEntry(cleanup.network, fallback.cleanup.network),
      herdrTab: normalizeCleanupEntry(cleanup.herdrTab, fallback.cleanup.herdrTab),
    },
    ...(validTimestamp(record.completedAt) ? { completedAt: record.completedAt as string } : {}),
  };
  if (normalized.slug !== state.slug || normalized.runtime !== state.runtime || normalized.startedAt !== state.startedAt || normalized.pid !== state.pid || normalized.container !== state.container || normalized.runId !== state.runId) {
    throw new Error(`agent finalization record for ${state.slug} does not match the active agent identity`);
  }
  return normalized;
}

async function loadRecord(stateDir: string, state: AgentState, now: string): Promise<AgentFinalizationRecord> {
  const path = finalizationRecordPath(stateDir, state.slug);
  const value = await readJson(path, "agent finalization record", true);
  return value === undefined ? initializeRecord(state, now) : validateFinalizationRecord(value, state);
}

async function writeRecord(stateDir: string, record: AgentFinalizationRecord): Promise<void> {
  const path = finalizationRecordPath(stateDir, record.slug);
  await mkdir(join(stateDir, "agents", "finalization"), { recursive: true, mode: 0o700 });
  await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function writeFinalized(stateDir: string, record: AgentFinalizationRecord): Promise<void> {
  const path = finalizedAgentPath(stateDir, record.slug);
  await mkdir(join(stateDir, "agents", "finalized"), { recursive: true, mode: 0o700 });
  await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
}

function settled(status: CleanupStatus): boolean {
  return completedStatuses.has(status);
}

function complete(record: AgentFinalizationRecord): boolean {
  return cleanupKeys.every((key) => settled(record.cleanup[key].status));
}

function summarize(result: CommandResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function missingPattern(kind: "container" | "volume" | "network", message: string): boolean {
  const text = message.toLowerCase();
  if (!text) return false;
  if (kind === "container") return /no such container/.test(text) || /container .* not found/.test(text) || /container .* does not exist/.test(text);
  if (kind === "volume") return /no such volume/.test(text) || /volume .* not found/.test(text) || /volume .* does not exist/.test(text);
  return /no such network/.test(text) || /network .* not found/.test(text) || /network .* does not exist/.test(text);
}

function portlessAliasMissing(message: string): boolean {
  return /no alias found for\s+"[^"]+"\.?/i.test(message);
}

function herdrTabMissing(message: string): boolean {
  const text = message.toLowerCase();
  return /no such tab/.test(text) || /tab .* not found/.test(text);
}

function deletionDetail(message: string, fallback: string): string {
  return message || fallback;
}

async function removeRuntimeResource(options: {
  state: AgentState;
  kind: "container" | "volume" | "network";
  resource: string;
  runCommand: FinalizationCommandRunner;
}): Promise<Pick<CleanupEntry, "status" | "detail" | "command" | "probeCommand">> {
  const cli = runtimeCommand(options.state.runtime);
  const command = options.kind === "container" ? [cli, "rm", "-f", options.resource] : [cli, options.kind, "rm", options.resource];
  const removed = await options.runCommand(command);
  const message = summarize(removed);
  if (removed.code === 0) return { status: "removed", ...(message ? { detail: message } : {}), command };
  if (missingPattern(options.kind, message)) return { status: "absent", detail: deletionDetail(message, `${options.kind} is already absent`), command };
  if (options.kind === "volume" || options.kind === "network") {
    const probeCommand = [cli, options.kind, "inspect", options.resource];
    const probe = await options.runCommand(probeCommand);
    const probeMessage = summarize(probe);
    if (probe.code !== 0 && missingPattern(options.kind, probeMessage)) {
      return {
        status: "absent",
        detail: `${deletionDetail(message, `${options.kind} removal failed`)}\nVerified absent via exact ${options.kind} inspect: ${probeMessage || `exit ${probe.code}`}`,
        command,
        probeCommand,
      };
    }
    if (probe.code === 0) {
      return {
        status: "failed",
        detail: `${deletionDetail(message, `${options.kind} removal failed`)}\nExact ${options.kind} inspect still found ${options.resource}.`,
        command,
        probeCommand,
      };
    }
    return {
      status: "failed",
      detail: `${deletionDetail(message, `${options.kind} removal failed`)}\nExact ${options.kind} inspect was inconclusive: ${probeMessage || `exit ${probe.code}`}`,
      command,
      probeCommand,
    };
  }
  return { status: "failed", detail: deletionDetail(message, `${options.kind} removal failed`), command };
}

async function removeAlias(options: {
  alias: string | undefined;
  available: CommandAvailability;
  runCommand: FinalizationCommandRunner;
}): Promise<Pick<CleanupEntry, "status" | "detail" | "command">> {
  if (!options.alias) return { status: "not_configured" };
  if (!await options.available("portless")) return { status: "failed", detail: "Portless is unavailable" };
  const command = ["portless", "alias", "--remove", options.alias];
  const result = await options.runCommand(command);
  const message = summarize(result);
  if (result.code === 0) return { status: "removed", ...(message ? { detail: message } : {}), command };
  if (portlessAliasMissing(message)) return { status: "absent", detail: deletionDetail(message, "alias is already absent"), command };
  return { status: "failed", detail: deletionDetail(message, "alias removal failed"), command };
}

async function closeHerdrTab(options: {
  tabId: string | undefined;
  available: CommandAvailability;
  runCommand: FinalizationCommandRunner;
}): Promise<Pick<CleanupEntry, "status" | "detail" | "command">> {
  if (!options.tabId) return { status: "not_configured" };
  if (!await options.available("herdr")) return { status: "failed", detail: "Herdr is unavailable" };
  const command = ["herdr", "tab", "close", options.tabId];
  const result = await options.runCommand(command);
  const message = summarize(result);
  if (result.code === 0) return { status: "removed", ...(message ? { detail: message } : {}), command };
  if (herdrTabMissing(message)) return { status: "absent", detail: deletionDetail(message, "Herdr tab is already absent"), command };
  return { status: "failed", detail: deletionDetail(message, "Herdr tab removal failed"), command };
}

async function applyCleanup(options: {
  record: AgentFinalizationRecord;
  key: CleanupKey;
  stateDir: string;
  now: string;
  operation: () => Promise<Pick<CleanupEntry, "status" | "detail" | "command" | "probeCommand">>;
}): Promise<AgentFinalizationRecord> {
  const current = options.record.cleanup[options.key];
  if (settled(current.status)) return options.record;
  const next = await options.operation();
  const updated: AgentFinalizationRecord = {
    ...options.record,
    updatedAt: options.now,
    cleanup: {
      ...options.record.cleanup,
      [options.key]: {
        ...current,
        ...next,
        attemptedAt: options.now,
        ...(settled(next.status) ? { settledAt: options.now } : {}),
      },
    },
  };
  await writeRecord(options.stateDir, updated);
  return updated;
}

export async function finalizeAgentRemoval(options: {
  stateDir: string;
  state: AgentState;
  runCommand: FinalizationCommandRunner;
  available: CommandAvailability;
  now?: Date;
}): Promise<FinalizationResult> {
  const now = iso(options.now);
  let record = await loadRecord(options.stateDir, options.state, now);
  await writeRecord(options.stateDir, record);

  record = await applyCleanup({
    record,
    key: "container",
    stateDir: options.stateDir,
    now,
    operation: async () => await removeRuntimeResource({ state: options.state, kind: "container", resource: options.state.container, runCommand: options.runCommand }),
  });
  record = await applyCleanup({
    record,
    key: "alias",
    stateDir: options.stateDir,
    now,
    operation: async () => await removeAlias({ alias: options.state.alias, available: options.available, runCommand: options.runCommand }),
  });
  record = await applyCleanup({
    record,
    key: "workspaceVolume",
    stateDir: options.stateDir,
    now,
    operation: async () => await removeRuntimeResource({ state: options.state, kind: "volume", resource: options.state.workspaceVolume, runCommand: options.runCommand }),
  });
  record = await applyCleanup({
    record,
    key: "network",
    stateDir: options.stateDir,
    now,
    operation: async () => await removeRuntimeResource({ state: options.state, kind: "network", resource: options.state.network, runCommand: options.runCommand }),
  });
  record = await applyCleanup({
    record,
    key: "herdrTab",
    stateDir: options.stateDir,
    now,
    operation: async () => await closeHerdrTab({ tabId: options.state.herdrTabId, available: options.available, runCommand: options.runCommand }),
  });

  if (!complete(record)) {
    const failedResources = cleanupKeys.filter((key) => record.cleanup[key].status === "failed");
    return { record, completed: false, failedResources };
  }

  const finalized = record.completedAt ? record : { ...record, updatedAt: now, completedAt: now };
  await writeRecord(options.stateDir, finalized);
  await writeFinalized(options.stateDir, finalized);
  await rm(agentStopIntentPath(options.stateDir, options.state.slug), { force: true });
  await rm(agentStatePath(options.stateDir, options.state.slug), { force: true });
  await rm(finalizationRecordPath(options.stateDir, options.state.slug), { force: true });
  return { record: finalized, completed: true, failedResources: [] };
}
