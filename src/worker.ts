import { watch } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import {
  documentExists,
  ensureWorkflowDirectory,
  installImmutable,
  readDocument,
  replaceAtomic,
  serializeDocument,
} from "./durable-state.ts";
import { createInputBundle } from "./git-change.ts";
import { assertGoalNotFrozen } from "./application.ts";
import { discoverRepository, git } from "./git.ts";
import {
  herdrOperations,
  type HerdrOperations,
  type HerdrPaneHandle,
  type ReadHerdrTerminalInput,
} from "./herdr.ts";
import { loadTicket, ticketStatus } from "./ticket.ts";
import type { ProjectPaths } from "./project.ts";
import type { HostPaths } from "./data-root.ts";

export type TicketIdentity = {
  goalId: string;
  changeId: string;
  ticketId: string;
};

export type TicketExchange = TicketIdentity & {
  inputDirectory: string;
  outputDirectory: string;
};

/**
 * The intentionally small Worker seam.  Selection is made from an immutable
 * Ticket policy; adapters are passed directly rather than discovered from a
 * registry.
 */
export type WorkerAdapter = {
  adapter: string;
  isolation: "workspace" | "container";
  supports: (policy: { isolation: "workspace" | "container" }) => boolean;
  dispatch: (input: DispatchWorkerTicketInput) => Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }>;
  /** Optional attended dispatch remains adapter-owned (e.g. Herdr for workspace). */
  dispatchAttended?: (input: DispatchHerdrTicketInput) => Promise<{ root: string; exchange: TicketExchange; hosting: string; status: "working" }>;
  /** Adapter-owned runtime resource validation and lifecycle operations. */
  validateRuntime: (resource: unknown) => void;
  runtimeOperations?: WorkerRuntimeOperations;
  observe: (root: ProjectPaths, identity: TicketIdentity, options?: unknown) => Promise<WorkerObservation>;
  loadFinished: (root: ProjectPaths, identity: TicketIdentity, operations?: WorkerRuntimeOperations) => Promise<WorkerExecution>;
  readTerminal?: (root: ProjectPaths, identity: TicketIdentity, input?: unknown, options?: unknown) => Promise<string>;
  attachTerminal?: (root: ProjectPaths, identity: TicketIdentity, options?: unknown) => Promise<number>;
  finalize: (root: ProjectPaths, identity: TicketIdentity, finishedAt: Date, operations?: WorkerRuntimeOperations) => Promise<WorkerCleanup>;
};

export type WorkerExecution = TicketIdentity & {
  /** Adapter-selected, immutable Ticket isolation provenance. */
  adapter: string;
  isolation: "workspace" | "container";
  worker: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  environmentDigest?: string;
  stdout: string;
  stderr: string;
};


export type WorkerHostOptions = {
  dockerImage: string;
  spikeExecutable: string;
  piExecutable: string;
  herdrAvailable: boolean;
  piAuthFile?: string;
  piAgentDirectory?: string;
  homeDirectory?: string;
};

export function resolveWorkerHostOptions(environment: NodeJS.ProcessEnv): WorkerHostOptions {
  return {
    dockerImage: environment["SPIKE_DOCKER_IMAGE"] ?? "spike-worker:local",
    spikeExecutable: environment["SPIKE_BIN"] ?? resolve(import.meta.dir, "..", "bin", "spike"),
    piExecutable: environment["SPIKE_PI_BIN"] ?? "pi",
    herdrAvailable: environment["HERDR_ENV"] === "1",
    ...(environment["SPIKE_PI_AUTH_FILE"]?.trim() ? { piAuthFile: environment["SPIKE_PI_AUTH_FILE"]!.trim() } : {}),
    ...(environment["PI_CODING_AGENT_DIR"]?.trim() ? { piAgentDirectory: environment["PI_CODING_AGENT_DIR"]!.trim() } : {}),
    ...(environment["HOME"]?.trim() ? { homeDirectory: environment["HOME"]!.trim() } : {}),
  };
}

const defaultWorkerHostOptions: WorkerHostOptions = {
  dockerImage: "spike-worker:local",
  spikeExecutable: resolve(import.meta.dir, "..", "bin", "spike"),
  piExecutable: "pi",
  herdrAvailable: false,
};

export type DispatchWorkerTicketInput = TicketIdentity & {
  cwd: string;
  hostPaths: HostPaths;
  command: string[];
  worker: string;
  hostOptions?: WorkerHostOptions;
  /** Deliberate inherited subprocess environment; protocol values override it. */
  environment?: NodeJS.ProcessEnv;
  environmentDigest?: string;
  clock?: () => Date;
  /** Deterministic adapter-test seam, invoked after immutable image inspection. */
  afterDockerImageInspection?: (imageDigest: string) => Promise<void>;
};

/** @deprecated local-clone's command input; shared dispatch uses DispatchWorkerTicketInput. */
export type DispatchLocalTicketInput = DispatchWorkerTicketInput;

export type _DispatchLocalTicketInput = TicketIdentity & {
  cwd: string;
  command: string[];
  worker: string;
  environmentDigest?: string;
  clock?: () => Date;
};

export type DispatchPiTicketInput = TicketIdentity & {
  cwd: string;
  hostPaths: HostPaths;
  worker: string;
  host?: "herdr" | "direct";
  hostOptions?: WorkerHostOptions;
  piExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  clock?: () => Date;
  herdr?: HerdrOperations;
};

export type PiDispatchClassification =
  | "accepted-submission"
  | "missing-submission"
  | "failed-execution";

/**
 * Resolve Pi hosting from the Ticket's frozen isolation policy. Container
 * hosting is an operational choice.  Explicit direct dispatch always wins;
 * unattended planners never accidentally create a Herdr resource.
 */
export function selectPiHost(
  _policy: { isolation: "workspace" | "container" },
  requested?: "herdr" | "direct",
  herdrAvailable = false,
): "herdr" | "direct" {
  if (requested !== undefined) return requested;
  return herdrAvailable ? "herdr" : "direct";
}

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const nonBlankString = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const workerRecordSchema = z
  .object({
    kind: z.literal("worker"),
    goalId: nonBlankString,
    changeId: nonBlankString,
    ticketId: nonBlankString,
    role: z.enum(["implement", "review"]),
    adapter: nonBlankString,
    isolation: z.enum(["workspace", "container"]),
    worker: nonBlankString,
    model: nonBlankString,
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    startedAt: timestamp,
    environmentDigest: nonBlankString.optional(),
    /** One neutral envelope; only the selected adapter interprets resource. */
    runtime: z.object({
      adapter: nonBlankString,
      resource: z.unknown(),
    }).strict().optional(),
    finishedAt: timestamp.optional(),
    exitCode: z.number().int().optional(),
  })
  .strict();

export type RecordedWorker = {
  metadata: z.infer<typeof workerRecordSchema>;
  body: string;
};

export type DirectProcess = {
  pid: number;
  exited: Promise<number>;
  kill: (signal: NodeJS.Signals) => void;
};

export type StopDirectProcessOptions = {
  graceMilliseconds?: number;
  graceExpired?: Promise<void>;
};

export async function stopDirectProcess(
  process: DirectProcess,
  options: StopDirectProcessOptions = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired =
    options.graceExpired ??
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.graceMilliseconds ?? 1_000);
    });
  let exited = false;
  const exit = process.exited.then(() => {
    exited = true;
  });

  try {
    process.kill("SIGTERM");
    const result = await Promise.race([
      exit.then(() => "exited" as const),
      graceExpired.then(() => "expired" as const),
    ]);
    if (result === "expired" && !exited) process.kill("SIGKILL");
    await exit;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type WorkerRuntimeEnvelope = NonNullable<RecordedWorker["metadata"]["runtime"]>;
/** Opaque adapter-owned data. Shared workflow code must only pass it back to the selected adapter. */
export type WorkerRuntimeResource = unknown;
type LocalCloneRuntime = { host: "direct"; workspace: string; pid?: number } | { host: "herdr"; workspace: string; pane: string };
type DockerRuntime = { containerId: string; imageDigest: string; host?: "herdr"; workspace?: string; pane?: string };

/** Adapter-owned operations over its canonical runtime resource. */
export type WorkerRuntimeOperations = {
  stop: (runtime: WorkerRuntimeResource, identity: TicketIdentity) => Promise<void>;
  cleanup: (runtime: WorkerRuntimeResource) => Promise<void>;
  /** Injected only by Docker-free lifecycle tests; undefined means still live. */
  terminalExitCode?: (runtime: WorkerRuntimeResource) => Promise<number | undefined>;
  /** Wait for the exact Docker resource; aborting this operational wait is safe. */
  waitForTerminalExit?: (runtime: WorkerRuntimeResource, signal?: AbortSignal) => Promise<number>;
};

export type WorkerObservation = {
  hosting: "direct" | "herdr" | null;
  status: "working" | "blocked" | "done" | "unavailable";
};

export type WorkerDoneNotification = {
  ticket: TicketIdentity;
  key: string;
  hosting: "herdr";
  status: "done";
};

type LiveDirectWorker = {
  process?: DirectProcess;
  stopRequested: boolean;
  completed: Promise<void>;
  complete: () => void;
};

const liveDirectWorkers = new Map<string, LiveDirectWorker>();
// Docker finalization shares this in-process completion barrier with dispatch
// so cleanup cannot remove logs or overwrite terminal evidence mid-dispatch.
const liveDockerWorkers = new Map<string, Promise<void>>();

function workerKey(identity: TicketIdentity): string {
  return `${identity.goalId}/${identity.changeId}/${identity.ticketId}`;
}

export type WorkerCleanup =
  | { status: "finalized"; execution: WorkerExecution }
  | { status: "failed"; phase: "stop" | "cleanup"; execution: WorkerExecution; message: string };

/** The existing attended-workspace adapter, deliberately not a registry entry. */
export const localCloneWorkerAdapter: WorkerAdapter = {
  adapter: "local-clone",
  isolation: "workspace",
  supports: (policy) => policy.isolation === "workspace",
  dispatch: (input) => dispatchLocalTicket(input),
  dispatchAttended: (input) => dispatchHerdrTicket(input),
  validateRuntime: validateLocalCloneRuntime,
  observe: (root, identity, options) => observeLocalCloneWorker(root, identity, options as HerdrOperations | undefined),
  loadFinished: (root, identity) => loadFinishedLocalCloneWorker(root, identity),
  readTerminal: (root, identity, input, options) => readLocalCloneWorkerTerminal(root, identity, input as ReadHerdrTerminalInput, options as HerdrOperations | undefined),
  attachTerminal: (root, identity, options) => attachLocalCloneWorkerTerminal(root, identity, options as HerdrOperations | undefined),
  finalize: (root, identity, finishedAt, operations) => stopAndFinalizeRecordedWorker(root, identity, finishedAt, operations),
};

/** The sole container adapter; its mounts and Docker resources never enter shared workflow state. */
export const dockerWorkerAdapter: WorkerAdapter = {
  adapter: "docker",
  isolation: "container",
  supports: (policy) => policy.isolation === "container",
  dispatch: (input) => dispatchDockerTicket(input),
  dispatchAttended: (input) => dispatchHerdrDockerTicket(input),
  validateRuntime: validateDockerRuntime,
  runtimeOperations: {
    async stop(runtime) {
      const dockerRuntime = runtime as DockerRuntime;
      // Stop the actual container first; closing its attach pane is not a stop.
      await dockerStop(dockerRuntime.containerId);
      if (dockerRuntime.host === "herdr" && dockerRuntime.pane !== undefined) await herdrOperations.closePane(dockerRuntime.pane);
    },
    async cleanup(runtime) {
      const dockerRuntime = runtime as DockerRuntime;
      await dockerRemove(dockerRuntime.containerId);
      if (dockerRuntime.workspace !== undefined) await rm(dockerRuntime.workspace, { recursive: true, force: true });
    },
    terminalExitCode: (runtime) => dockerTerminalExitCode((runtime as DockerRuntime).containerId),
    waitForTerminalExit: (runtime, signal) => dockerWaitForTerminalExit((runtime as DockerRuntime).containerId, signal),
  },
  observe: (root, identity) => observeDockerWorker(root, identity),
  loadFinished: (root, identity, operations) => loadFinishedDockerWorker(root, identity, operations),
  readTerminal: (root, identity, input, options) => readDockerWorkerTerminal(root, identity, input as ReadHerdrTerminalInput, options as HerdrOperations | undefined),
  attachTerminal: (root, identity, options) => attachDockerWorkerTerminal(root, identity, options as HerdrOperations | undefined),
  finalize: (root, identity, finishedAt, operations) => stopAndFinalizeRecordedWorker(root, identity, finishedAt, operations),
};

export function selectWorkerAdapter(policy: { isolation: "workspace" | "container" }): WorkerAdapter {
  if (localCloneWorkerAdapter.supports(policy)) return localCloneWorkerAdapter;
  if (dockerWorkerAdapter.supports(policy)) return dockerWorkerAdapter;
  throw new Error(`no Worker adapter supports ${policy.isolation} isolation`);
}

export function exchangePath(project: ProjectPaths, identity: TicketIdentity): string {
  return join(
    project.controlRoot,
    "exchange",
    "goals",
    identity.goalId,
    "changes",
    identity.changeId,
    "tickets",
    identity.ticketId,
  );
}

export function ticketOutputPath(project: ProjectPaths, identity: TicketIdentity): string {
  return join(exchangePath(project, identity), "output");
}

export function workerRecordPath(project: ProjectPaths, identity: TicketIdentity): string {
  return join(
    project.controlRoot,
    "runtime",
    "workers",
    "goals",
    identity.goalId,
    "changes",
    identity.changeId,
    "tickets",
    identity.ticketId,
    "worker.md",
  );
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function recordedExecution(
  record: RecordedWorker["metadata"],
  finishedAt: string,
): WorkerExecution {
  return {
    goalId: record.goalId,
    changeId: record.changeId,
    ticketId: record.ticketId,
    adapter: record.adapter,
    isolation: record.isolation,
    worker: record.worker,
    model: record.model,
    thinking: record.thinking,
    startedAt: record.startedAt,
    finishedAt,
    exitCode: record.exitCode ?? -1,
    ...(record.environmentDigest === undefined ? {} : { environmentDigest: record.environmentDigest }),
    stdout: "",
    stderr: "",
  };
}

function validateWorkspace(workspace: string): void {
  const temporaryRoot = resolve(tmpdir());
  const resolved = resolve(workspace);
  if (!resolved.startsWith(`${temporaryRoot}/`) || !basename(resolved).startsWith("spike-local-clone-")) {
    throw new Error(`recorded local-clone workspace is invalid: ${workspace}`);
  }
}

function validateLocalCloneRuntime(resource: unknown): asserts resource is LocalCloneRuntime {
  const runtime = z.discriminatedUnion("host", [
    z.object({ host: z.literal("direct"), workspace: nonBlankString, pid: z.number().int().positive().optional() }).strict(),
    z.object({ host: z.literal("herdr"), workspace: nonBlankString, pane: nonBlankString }).strict(),
  ]).parse(resource);
  validateWorkspace(runtime.workspace);
}

export async function loadRecordedWorkerIfPresent(
  root: ProjectPaths,
  identity: TicketIdentity,
): Promise<RecordedWorker | undefined> {
  const path = workerRecordPath(root, identity);
  if (!(await documentExists(root.controlRoot, path))) return undefined;
  const document = await readDocument(root.controlRoot, path);
  const metadata = workerRecordSchema.parse(document.metadata);
  if (
    metadata.goalId !== identity.goalId ||
    metadata.changeId !== identity.changeId ||
    metadata.ticketId !== identity.ticketId
  ) {
    throw new Error(
      `Worker record belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`,
    );
  }
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  if (metadata.role !== ticket.metadata.role) throw new Error("Worker record role does not match its Ticket");
  if (metadata.isolation !== ticket.metadata.executionPolicy.isolation) {
    throw new Error("Worker record isolation does not match its Ticket execution policy");
  }
  if (metadata.adapter !== selectWorkerAdapter(ticket.metadata.executionPolicy).adapter) {
    throw new Error("Worker record adapter does not match its Ticket execution policy");
  }
  if (metadata.model !== ticket.metadata.model || metadata.thinking !== ticket.metadata.thinking) {
    throw new Error("Worker record model selection does not match its Ticket");
  }
  if (Date.parse(metadata.finishedAt ?? metadata.startedAt) < Date.parse(metadata.startedAt)) {
    throw new Error("Worker record finishedAt must not precede startedAt");
  }
  if (metadata.runtime !== undefined) {
    const adapter = selectWorkerAdapter(ticket.metadata.executionPolicy);
    if (metadata.runtime.adapter !== adapter.adapter) {
      throw new Error("Worker runtime adapter does not match its Ticket execution policy");
    }
    adapter.validateRuntime(metadata.runtime.resource);
  }
  return { metadata, body: document.body };
}

export async function recordWorker(
  root: ProjectPaths,
  input: TicketIdentity & {
    role: "implement" | "review"; worker: string; startedAt: string;
    runtime: WorkerRuntimeResource; environmentDigest?: string;
  },
): Promise<RecordedWorker> {
  const ticket = await loadTicket(root, input.goalId, input.changeId, input.ticketId);
  const selected = selectWorkerAdapter(ticket.metadata.executionPolicy);
  if (ticket.metadata.role !== input.role) throw new Error("Worker record role does not match its Ticket");
  // The immutable Ticket selects the sole authority for accepting durable runtime data.
  selected.validateRuntime(input.runtime);
  const metadata = workerRecordSchema.parse({
    kind: "worker", goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId, role: input.role,
    adapter: selected.adapter, isolation: ticket.metadata.executionPolicy.isolation, worker: input.worker,
    model: ticket.metadata.model, thinking: ticket.metadata.thinking, startedAt: input.startedAt,
    ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
    runtime: { adapter: selected.adapter, resource: input.runtime },
  });
  const body = "# Worker runtime\n";
  await installImmutable(root.controlRoot, workerRecordPath(root, input), serializeDocument(metadata, body));
  return { metadata, body };
}

/** Docker lifecycle tests may record opaque attended resources without a daemon. */
export function recordDockerWorker(
  root: ProjectPaths,
  input: TicketIdentity & { role: "implement" | "review"; worker: string; startedAt: string; containerId: string; imageDigest: string; workspace?: string; herdr?: HerdrPaneHandle; environmentDigest?: string },
): Promise<RecordedWorker> {
  return recordWorker(root, {
    ...input,
    runtime: input.herdr === undefined
      ? { containerId: input.containerId, imageDigest: input.imageDigest }
      : { containerId: input.containerId, imageDigest: input.imageDigest, host: "herdr", workspace: input.workspace!, pane: input.herdr.pane },
  });
}

/** Local adapter's resource constructor; generic recording retains it opaquely. */
export function recordLocalCloneWorker(
  root: ProjectPaths,
  input: TicketIdentity & { role: "implement" | "review"; worker: string; startedAt: string; workspace: string; pid?: number; herdr?: HerdrPaneHandle; environmentDigest?: string },
): Promise<RecordedWorker> {
  return recordWorker(root, {
    ...input,
    runtime: input.herdr === undefined
      ? { host: "direct", workspace: input.workspace, ...(input.pid === undefined ? {} : { pid: input.pid }) }
      : { host: "herdr", workspace: input.workspace, pane: input.herdr.pane },
  });
}

async function replaceWorkerRecord(root: ProjectPaths, record: RecordedWorker): Promise<void> {
  await replaceAtomic(
    root.controlRoot,
    workerRecordPath(root, record.metadata),
    serializeDocument(record.metadata, record.body),
  );
}

const herdrExecutionSchema = z.object({
  exitCode: z.number().int(),
  finishedAt: timestamp,
}).strict();

type HerdrExecutionMarker = z.infer<typeof herdrExecutionSchema>;

type AttendedRuntime = { host: "herdr"; workspace: string; pane: string };

function attendedRuntime(resource: unknown): AttendedRuntime | undefined {
  if (typeof resource !== "object" || resource === null) return undefined;
  const value = resource as Record<string, unknown>;
  return value["host"] === "herdr" && typeof value["workspace"] === "string" && typeof value["pane"] === "string"
    ? value as AttendedRuntime : undefined;
}

function herdrExecutionPath(resource: AttendedRuntime): string {
  return join(resource.workspace, "herdr-execution.json");
}

async function loadHerdrExecutionMarker(
  resource: AttendedRuntime,
): Promise<HerdrExecutionMarker | undefined> {
  const path = herdrExecutionPath(resource);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error("Herdr execution marker must be a bounded regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return herdrExecutionSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function refreshHerdrExecution(root: ProjectPaths, record: RecordedWorker): Promise<RecordedWorker> {
  const resource = attendedRuntime(record.metadata.runtime?.resource);
  if (record.metadata.finishedAt !== undefined || resource === undefined) return record;
  const execution = await loadHerdrExecutionMarker(resource);
  if (execution === undefined) return record;
  const started = Date.parse(record.metadata.startedAt);
  const observedFinish = Date.parse(execution.finishedAt);
  const finishedAt = observedFinish < started && started - observedFinish < 1_000
    ? record.metadata.startedAt
    : execution.finishedAt;
  const metadata = workerRecordSchema.parse({
    ...record.metadata,
    finishedAt,
    exitCode: execution.exitCode,
  });
  const refreshed = { metadata, body: record.body };
  await replaceWorkerRecord(root, refreshed);
  return refreshed;
}

/** Materialize bounded operational completion only after Docker reports this exact ID terminal. */
async function installDockerExecutionMarker(resource: DockerRuntime, exitCode: number): Promise<void> {
  const attended = attendedRuntime(resource);
  if (attended === undefined) return;
  const marker = herdrExecutionPath(attended);
  const temporary = `${marker}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const body = JSON.stringify({ exitCode, finishedAt: new Date().toISOString() }) + "\n";
  await writeFile(temporary, body, { mode: 0o600 });
  try {
    await rename(temporary, marker);
  } catch (error) {
    await rm(temporary, { force: true });
    // Concurrent restart observers may have won the atomic installation.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function refreshDockerExecution(root: ProjectPaths, record: RecordedWorker, operations: WorkerRuntimeOperations = dockerWorkerAdapter.runtimeOperations!): Promise<RecordedWorker> {
  if (record.metadata.finishedAt !== undefined) return record;
  const runtime = record.metadata.runtime?.resource as DockerRuntime | undefined;
  if (runtime === undefined) return record;
  let exitCode: number | undefined;
  try {
    exitCode = await (operations.terminalExitCode?.(runtime) ?? dockerTerminalExitCode(runtime.containerId));
  } catch (error) {
    // An absent resource is not terminal evidence (it may have been retired
    // by a racing finalizer); leave the Worker projected unfinished.
    if ((error as Error).message.includes("no such object")) return record;
    throw error;
  }
  if (exitCode === undefined) return record;
  await installDockerExecutionMarker(runtime, exitCode);
  const finishedAt = new Date().toISOString();
  const refreshed = {
    metadata: workerRecordSchema.parse({ ...record.metadata, finishedAt, exitCode }),
    body: record.body,
  };
  await replaceWorkerRecord(root, refreshed);
  return refreshed;
}

const localCloneRuntimeOperations: WorkerRuntimeOperations = {
  async stop(runtime, identity) {
    const resource = runtime as LocalCloneRuntime;
    if (resource.host === "herdr") {
      await herdrOperations.closePane(resource.pane);
      return;
    }
    if (resource.pid === undefined) return;
    const live = liveDirectWorkers.get(workerKey(identity));
    if (live === undefined) {
      throw new Error("direct worker session is unavailable after restart; refusing to signal a persisted PID");
    }
    if (live.process?.pid !== resource.pid) {
      throw new Error("recorded direct worker PID does not match the live owned process");
    }

    live.stopRequested = true;
    if (live.process !== undefined) await stopDirectProcess(live.process);
    await live.completed;
  },
  cleanup: (runtime) => rm((runtime as LocalCloneRuntime).workspace, { recursive: true, force: true }),
};
localCloneWorkerAdapter.runtimeOperations = localCloneRuntimeOperations;

export async function stopAndFinalizeRecordedWorker(
  root: ProjectPaths,
  identity: TicketIdentity,
  finishedAt: Date,
  operations?: WorkerRuntimeOperations,
): Promise<WorkerCleanup> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} has no Worker record`);
  const finish = record.metadata.finishedAt ?? finishedAt.toISOString();
  const execution = recordedExecution(record.metadata, finish);
  if (record.metadata.runtime === undefined) return { status: "finalized", execution };

  const resource = record.metadata.runtime.resource as WorkerRuntimeResource;
  const adapter = selectWorkerAdapter((await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId)).metadata.executionPolicy);
  const runtimeOperations = operations ?? adapter.runtimeOperations;
  if (runtimeOperations === undefined) throw new Error(`no runtime operations for Worker adapter ${adapter.adapter}`);
  try {
    await runtimeOperations.stop(resource, identity);
  } catch (error) {
    return {
      status: "failed",
      phase: "stop",
      execution,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // A live Docker stop has a terminal exit that must outlive resource cleanup.
  // Reload rather than writing the pre-stop snapshot: dispatch may have observed
  // the same exit while stop was in progress.
  let durable = await loadRecordedWorkerIfPresent(root, identity) ?? record;
  let stoppedExitCode: number | undefined;
  if (adapter.adapter === "docker" && (durable.metadata.finishedAt === undefined || durable.metadata.exitCode === undefined)) {
    try {
      stoppedExitCode = await (runtimeOperations.terminalExitCode?.(resource) ?? dockerExitCode((resource as DockerRuntime).containerId));
    } catch (error) {
      return { status: "failed", phase: "stop", execution, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const terminalMetadata = workerRecordSchema.parse({
    ...durable.metadata,
    finishedAt: durable.metadata.finishedAt ?? finish,
    ...(durable.metadata.exitCode === undefined && stoppedExitCode !== undefined ? { exitCode: stoppedExitCode } : {}),
  });
  durable = { metadata: terminalMetadata, body: durable.body };
  try {
    await replaceWorkerRecord(root, durable);
    if (adapter.adapter === "docker") await liveDockerWorkers.get(workerKey(identity));
    await runtimeOperations.cleanup(resource);
  } catch (error) {
    return {
      status: "failed",
      phase: "cleanup",
      execution: recordedExecution(durable.metadata, durable.metadata.finishedAt!),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Dispatch completion can race cleanup; retain any terminal fields it wrote
  // and only clear the owned runtime resource.
  durable = await loadRecordedWorkerIfPresent(root, identity) ?? durable;
  const metadata = workerRecordSchema.parse({ ...durable.metadata, runtime: undefined });
  try {
    await replaceWorkerRecord(root, { metadata, body: durable.body });
  } catch (error) {
    return {
      status: "failed",
      phase: "cleanup",
      execution: recordedExecution(durable.metadata, durable.metadata.finishedAt!),
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "finalized", execution: recordedExecution(metadata, metadata.finishedAt!) };
}

/** Finalize through the adapter selected by immutable Ticket policy. */
export async function finalizeWorker(
  root: ProjectPaths,
  identity: TicketIdentity,
  finishedAt: Date,
  operations?: WorkerRuntimeOperations,
): Promise<WorkerCleanup> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  return selectWorkerAdapter(ticket.metadata.executionPolicy).finalize(root, identity, finishedAt, operations);
}

export async function forgetFinalizedWorker(root: ProjectPaths, identity: TicketIdentity): Promise<void> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) return;
  if (record.metadata.runtime !== undefined) throw new Error("cannot forget Worker record before resources are finalized");
  await rm(workerRecordPath(root, identity));
}

async function loadFinishedLocalCloneWorker(
  root: ProjectPaths,
  identity: TicketIdentity,
): Promise<WorkerExecution> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} has no Worker execution evidence`);
  }
  record = await refreshHerdrExecution(root, record);
  if (record.metadata.finishedAt === undefined || record.metadata.exitCode === undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} Worker has not finished`);
  }
  const runtime = record.metadata.runtime?.resource as LocalCloneRuntime | undefined;
  if (runtime?.host === "direct" && runtime.pid !== undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} Worker still has a live process handle`);
  }
  return recordedExecution(record.metadata, record.metadata.finishedAt);
}

/** Load completion evidence through the adapter selected by immutable Ticket policy. */
export async function loadFinishedWorkerExecution(
  root: ProjectPaths,
  identity: TicketIdentity,
  operations?: WorkerRuntimeOperations,
): Promise<WorkerExecution> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  return selectWorkerAdapter(ticket.metadata.executionPolicy).loadFinished(root, identity, operations);
}

export async function observeLocalCloneWorker(
  root: ProjectPaths,
  identity: TicketIdentity,
  herdr: HerdrOperations = herdrOperations,
): Promise<WorkerObservation> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) return { hosting: null, status: "unavailable" };
  record = await refreshHerdrExecution(root, record);
  const resource = record.metadata.runtime?.resource as LocalCloneRuntime | undefined;
  const hosting = resource?.host ?? "direct";
  if (record.metadata.finishedAt !== undefined) return { hosting, status: "done" };
  if (resource === undefined) return { hosting, status: "done" };
  if (resource.host === "direct") return { hosting: "direct", status: resource.pid === undefined ? "unavailable" : "working" };

  const status = await herdr.status(resource.pane);
  if (status === "blocked") return { hosting: "herdr", status: "blocked" };
  if (status === "idle" || status === "done" || status === "working" || status === "unknown") {
    return { hosting: "herdr", status: "working" };
  }
  return { hosting: "herdr", status: "unavailable" };
}

/** Observe through the adapter selected by immutable Ticket policy. */
export async function observeWorker(
  root: ProjectPaths,
  identity: TicketIdentity,
  herdr?: HerdrOperations,
): Promise<WorkerObservation> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  return selectWorkerAdapter(ticket.metadata.executionPolicy).observe(root, identity, herdr);
}

function workerDoneKey(identity: TicketIdentity): string {
  return `worker-done:${identity.goalId}/${identity.changeId}/${identity.ticketId}`;
}

async function markerBackedHerdrDone(
  root: ProjectPaths,
  identity: TicketIdentity,
): Promise<WorkerDoneNotification | undefined> {
  if ((await ticketStatus(root, identity.goalId, identity.changeId, identity.ticketId)) !== "open") {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} is already reported`);
  }
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} has no Worker record`);
  const resource = attendedRuntime(record.metadata.runtime?.resource);
  if (resource === undefined) throw new Error("Ticket has no attended Herdr worker");
  if ((await loadHerdrExecutionMarker(resource)) === undefined) return undefined;
  return { ticket: identity, key: workerDoneKey(identity), hosting: "herdr", status: "done" };
}

/** Docker completion is owned by the adapter, never by the Herdr attach pane. */
async function waitForDockerWorkerDone(root: ProjectPaths, identity: TicketIdentity, signal?: AbortSignal): Promise<WorkerDoneNotification> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} has no Worker record`);
  const runtime = record.metadata.runtime?.resource as DockerRuntime | undefined;
  if (runtime === undefined || attendedRuntime(runtime) === undefined) throw new Error("Ticket has no attended Herdr worker");
  const operations = dockerWorkerAdapter.runtimeOperations!;
  // Retain compatibility with an already materialized operational marker,
  // while all new markers are installed only by the Docker observer below.
  record = await refreshHerdrExecution(root, record);
  record = await refreshDockerExecution(root, record, operations);
  if (record.metadata.finishedAt === undefined) {
    const exitCode = await (operations.waitForTerminalExit?.(runtime, signal) ?? dockerWaitForTerminalExit(runtime.containerId, signal));
    await installDockerExecutionMarker(runtime, exitCode);
    record = await refreshHerdrExecution(root, record);
  }
  if (record.metadata.finishedAt === undefined) throw new Error("Docker completion marker was not installed");
  return { ticket: identity, key: workerDoneKey(identity), hosting: "herdr", status: "done" };
}

/**
 * Wait for an attended operational completion notification. This never
 * publishes a Report or closes a Ticket.
 */
export async function waitForWorkerDone(
  root: ProjectPaths,
  identity: TicketIdentity,
  signal?: AbortSignal,
): Promise<WorkerDoneNotification> {
  signal?.throwIfAborted();
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  if (selectWorkerAdapter(ticket.metadata.executionPolicy).adapter === "docker") {
    return waitForDockerWorkerDone(root, identity, signal);
  }
  const initial = await markerBackedHerdrDone(root, identity);
  if (initial !== undefined) return initial;

  const record = await loadRecordedWorkerIfPresent(root, identity);
  const resource = attendedRuntime(record?.metadata.runtime?.resource);
  if (resource === undefined) throw new Error("Ticket has no attended Herdr worker");

  return new Promise<WorkerDoneNotification>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let checkAgain = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      watcher.close();
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => finish(() => reject(new Error("Worker wait was cancelled")));
    const check = async () => {
      if (settled) return;
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      try {
        do {
          checkAgain = false;
          const notification = await markerBackedHerdrDone(root, identity);
          if (notification !== undefined) {
            finish(() => resolve(notification));
            return;
          }
        } while (checkAgain && !settled);
      } catch (error) {
        finish(() => reject(error));
      } finally {
        checking = false;
      }
    };
    const watcher = watch(resource.workspace, (_event, filename) => {
      if (filename === null || filename === "herdr-execution.json") void check();
    });
    watcher.on("error", (error) => finish(() => reject(error)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else void check(); // Close the race between the initial check and watcher installation.
  });
}

async function readLocalCloneWorkerTerminal(
  root: ProjectPaths,
  identity: TicketIdentity,
  input: ReadHerdrTerminalInput = {},
  herdr: HerdrOperations = herdrOperations,
): Promise<string> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  const runtime = record?.metadata.runtime?.resource as LocalCloneRuntime | undefined;
  if (runtime?.host !== "herdr") throw new Error("Ticket has no Herdr-hosted terminal");
  return herdr.read(runtime.pane, input);
}

async function attachLocalCloneWorkerTerminal(
  root: ProjectPaths,
  identity: TicketIdentity,
  herdr: HerdrOperations = herdrOperations,
): Promise<number> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  const runtime = record?.metadata.runtime?.resource as LocalCloneRuntime | undefined;
  if (runtime?.host !== "herdr") throw new Error("Ticket has no Herdr-hosted terminal");
  return herdr.attach(runtime.pane);
}

export async function readWorkerTerminal(
  root: ProjectPaths,
  identity: TicketIdentity,
  input: ReadHerdrTerminalInput = {},
  herdr: HerdrOperations = herdrOperations,
): Promise<string> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  const adapter = selectWorkerAdapter(ticket.metadata.executionPolicy);
  if (adapter.readTerminal === undefined) throw new Error(`Worker adapter ${adapter.adapter} has no attended terminal`);
  return adapter.readTerminal(root, identity, input, herdr);
}

export async function attachWorkerTerminal(
  root: ProjectPaths,
  identity: TicketIdentity,
  herdr: HerdrOperations = herdrOperations,
): Promise<number> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  const adapter = selectWorkerAdapter(ticket.metadata.executionPolicy);
  if (adapter.attachTerminal === undefined) throw new Error(`Worker adapter ${adapter.adapter} has no attended terminal`);
  return adapter.attachTerminal(root, identity, herdr);
}

function contextBody(role: "implement" | "review", inputRevision: string): string {
  if (role === "review") {
    return `# Review worker context

The private checkout starts at the exact Candidate \`${inputRevision}\`.

## Declared output

Write artifacts only below \`SPIKE_OUTPUT_DIR/artifacts/\`. In Pi, finish with either \`spike_complete_review\` or, when a condition outside the worker's control prevents review, \`spike_block_review\`. Scripted workers may instead use \`spike worker complete\` or \`spike worker block\` with \`--file payload.json\` or stdin. The completed review payload contains:

- non-blank \`reviewStatement\`;
- \`findings\` with unique kebab-case \`id\`, severity \`critical\`, \`high\`, \`medium\`, or \`low\`, and non-blank \`statement\`;
- \`acceptanceAssessment\` covering every criterion exactly once with assessment \`met\`, \`not-met\`, or \`unclear\`, and evidence;
- verdict \`remediate\`, \`approve\`, \`reject\`, or \`ask-operator\`;
- \`artifacts\`, an array of declared paths below \`artifacts/\`.

A blocked payload contains non-blank \`reason\` and \`evidence\` plus declared \`artifacts\`; it produces no verdict. Spike validates and digests artifacts and atomically writes the canonical \`submission.md\`. Do not write a Submission or Git bundle yourself.
`;
  }
  return `# Implementation worker context

The private checkout starts at exact revision \`${inputRevision}\`.

## Declared output

Implement in the private checkout and write artifacts only below \`SPIKE_OUTPUT_DIR/artifacts/\`. In Pi, finish with either \`spike_complete_implementation\` or, when a condition outside the worker's control prevents implementation, \`spike_block_implementation\`. Scripted workers may instead use \`spike worker complete\` or \`spike worker block\` with \`--file payload.json\` or stdin. The completed implementation payload contains non-blank \`summary\`, \`verification\`, \`assumptions\`, \`limitations\`, \`risks\`, and \`followUp\` strings plus \`artifacts\`, an array of declared paths below \`artifacts/\`. A blocked payload contains non-blank \`reason\` and \`evidence\` plus declared \`artifacts\`; it produces no Candidate.

For completed work, Spike snapshots the checkout and creates \`repository.bundle\`. For either outcome, Spike validates and digests artifacts and atomically writes the canonical \`submission.md\` last. Do not write a Submission or Git bundle yourself.
`;
}

export async function prepareTicketExchange(root: ProjectPaths, identity: TicketIdentity): Promise<TicketExchange> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  if ((await ticketStatus(root, identity.goalId, identity.changeId, identity.ticketId)) === "reported") {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} is already reported`);
  }
  const exchange = exchangePath(root, identity);
  if (await pathExists(exchange)) throw new Error(`Ticket exchange already exists: ${exchange}`);
  const inputDirectory = join(exchange, "input");
  const outputDirectory = join(exchange, "output");
  // Validate the complete central path before mkdir can follow an exchange symlink.
  await ensureWorkflowDirectory(root.controlRoot, inputDirectory);

  await installImmutable(
    root.controlRoot,
    join(inputDirectory, "ticket.md"),
    serializeDocument(ticket.metadata, ticket.body),
  );
  await installImmutable(
    root.controlRoot,
    join(inputDirectory, "context.md"),
    serializeDocument(
      {
        kind: "ticket-context",
        goalId: identity.goalId,
        changeId: identity.changeId,
        ticketId: identity.ticketId,
        inputRevision: ticket.metadata.inputRevision,
      },
      contextBody(ticket.metadata.role, ticket.metadata.inputRevision),
    ),
  );
  await createInputBundle(root.root, ticket.metadata.inputRevision, join(inputDirectory, "repository.bundle"), identity);
  await Promise.all([
    chmod(join(inputDirectory, "ticket.md"), 0o400),
    chmod(join(inputDirectory, "context.md"), 0o400),
    chmod(inputDirectory, 0o500),
  ]);
  await ensureWorkflowDirectory(root.controlRoot, outputDirectory);
  return { ...identity, inputDirectory, outputDirectory };
}

function workerEnvironment(
  exchange: TicketExchange,
  checkoutRevision: string,
  ticket: Awaited<ReturnType<typeof loadTicket>>,
  spikeExecutable: string,
): Record<string, string> {
  return {
    SPIKE_INPUT_DIR: exchange.inputDirectory,
    SPIKE_OUTPUT_DIR: exchange.outputDirectory,
    SPIKE_INPUT_REVISION: checkoutRevision,
    SPIKE_GOAL_ID: exchange.goalId,
    SPIKE_CHANGE_ID: exchange.changeId,
    SPIKE_TICKET_ID: exchange.ticketId,
    SPIKE_TICKET_ROLE: ticket.metadata.role,
    SPIKE_MODEL: ticket.metadata.model,
    SPIKE_THINKING: ticket.metadata.thinking,
    SPIKE_BIN: spikeExecutable,
  };
}

function validateLocalPolicy(ticket: Awaited<ReturnType<typeof loadTicket>>): void {
  if (ticket.metadata.executionPolicy.isolation !== "workspace") {
    throw new Error("local-clone adapter supports only workspace isolation");
  }
  if (ticket.metadata.executionPolicy.networkAccess !== "unrestricted") {
    throw new Error("local-clone adapter cannot enforce restricted network access");
  }
  if (ticket.metadata.executionPolicy.credentialGrants.length > 0) {
    throw new Error("local-clone adapter does not resolve credential grants");
  }
}

function validateDockerRuntime(resource: unknown): asserts resource is DockerRuntime {
  const runtime = z.object({
    containerId: z.string().regex(/^[0-9a-f]{64}$/),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    host: z.literal("herdr").optional(), workspace: nonBlankString.optional(), pane: nonBlankString.optional(),
  }).strict().parse(resource);
  if (runtime.host !== undefined) {
    if (runtime.workspace === undefined || runtime.pane === undefined) throw new Error("attended Docker runtime is incomplete");
    validateWorkspace(runtime.workspace);
  } else if (runtime.workspace !== undefined || runtime.pane !== undefined) throw new Error("Docker runtime hosting fields are inconsistent");
}

type DockerCredential = { encodedAuth: string };

// Docker Pi dispatch intentionally supports only the credential required by
// the frozen OpenAI Codex worker model.  This is Pi's stored OAuth shape;
// retain provider-specific fields (such as accountId) when serializing it.
const dockerPiCredentialSchema = z.object({
  type: z.literal("oauth"),
  access: z.string().trim().min(1),
  refresh: z.string().trim().min(1),
  expires: z.number().finite(),
}).passthrough();
const dockerPiProvider = "openai-codex";

/**
 * Read one Pi credential from an operator-named auth source.  The source is
 * deliberately never mounted: only a newly serialized one-provider document
 * crosses the Docker boundary, and it exists there only on tmpfs.
 */
export async function resolveDockerCredential(
  ticket: Awaited<ReturnType<typeof loadTicket>>,
  hostOptions: WorkerHostOptions = defaultWorkerHostOptions,
): Promise<DockerCredential | undefined> {
  const grants = ticket.metadata.executionPolicy.credentialGrants;
  if (grants.length === 0) return undefined;
  if (grants.length !== 1) throw new Error("docker adapter supports exactly one declared credential grant");
  const provider = ticket.metadata.model.split("/", 1)[0];
  const grant = grants[0]!.trim();
  if (provider !== dockerPiProvider || grant !== dockerPiProvider) {
    throw new Error("docker adapter supports only the openai-codex credential grant and model provider");
  }
  // An explicit source is an override, not a hint: a bad override must fail
  // before Docker/exchange side effects rather than silently using another login.
  const override = hostOptions.piAuthFile;
  const candidates = override !== undefined
    ? [override]
    : [
      ...(hostOptions.piAgentDirectory === undefined ? [] : [join(hostOptions.piAgentDirectory, "auth.json")]),
      ...(hostOptions.homeDirectory === undefined ? [] : [join(hostOptions.homeDirectory, ".pi", "agent", "auth.json")]),
    ];
  let raw: string | undefined;
  for (const source of candidates) {
    try {
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("invalid");
      raw = await readFile(source, "utf8");
      break;
    } catch (error) {
      // Normal Pi fallback only skips a missing configured location. Any file
      // that is unsafe or unreadable is a refusal, as is an explicit override.
      if (override === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("declared Docker credential source is unavailable or invalid");
    }
  }
  if (raw === undefined) throw new Error("declared Docker credential source is unavailable or invalid");
  let document: unknown;
  try { document = JSON.parse(raw); } catch { throw new Error("declared Docker credential source is malformed"); }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("declared Docker credential source is malformed");
  }
  const credential = (document as Record<string, unknown>)[provider];
  if (!dockerPiCredentialSchema.safeParse(credential).success) {
    throw new Error("declared Docker credential grant is absent or malformed");
  }
  return { encodedAuth: Buffer.from(JSON.stringify({ [provider]: credential })).toString("base64") };
}

function validateDockerPolicy(ticket: Awaited<ReturnType<typeof loadTicket>>): void {
  if (ticket.metadata.executionPolicy.isolation !== "container") throw new Error("docker adapter supports only container isolation");
  if (ticket.metadata.executionPolicy.networkAccess === "restricted") throw new Error("docker adapter does not support restricted network access");
}

async function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
}

async function dockerRequired(args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function dockerExists(containerId: string): Promise<boolean> {
  return (await docker(["container", "inspect", containerId])).code === 0;
}

async function dockerStop(containerId: string): Promise<void> {
  if (!(await dockerExists(containerId))) return;
  await dockerRequired(["stop", "--time", "1", containerId]);
}

async function dockerTerminalExitCode(containerId: string): Promise<number | undefined> {
  const value = await dockerRequired(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", containerId]);
  const [running, rawExitCode] = value.split(/\s+/, 2);
  if (running === "true") return undefined;
  const exitCode = Number(rawExitCode);
  if (!Number.isInteger(exitCode)) throw new Error(`Docker container has no terminal exit code: ${containerId}`);
  return exitCode;
}

async function dockerExitCode(containerId: string): Promise<number> {
  const exitCode = await dockerTerminalExitCode(containerId);
  if (exitCode === undefined) throw new Error(`Docker container has not finished: ${containerId}`);
  return exitCode;
}

async function dockerWaitForTerminalExit(containerId: string, signal?: AbortSignal): Promise<number> {
  const already = await dockerTerminalExitCode(containerId);
  if (already !== undefined) return already;
  signal?.throwIfAborted();
  const process = Bun.spawn(["docker", "wait", containerId], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const abort = () => process.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`docker wait failed: ${(stderr || stdout).trim()}`);
    const exitCode = Number(stdout.trim());
    if (!Number.isInteger(exitCode)) throw new Error(`Docker container has no terminal exit code: ${containerId}`);
    return exitCode;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function dockerRemove(containerId: string): Promise<void> {
  if (!(await dockerExists(containerId))) return;
  await dockerRequired(["rm", "--force", containerId]);
}

function dockerEnvironment(exchange: TicketExchange, revision: string, ticket: Awaited<ReturnType<typeof loadTicket>>, credential?: DockerCredential): string[] {
  const values = {
    ...workerEnvironment(exchange, revision, ticket, "/opt/spike/bin/spike"),
    SPIKE_INPUT_DIR: "/exchange/input",
    SPIKE_OUTPUT_DIR: "/exchange/output",
    SPIKE_BIN: "/opt/spike/bin/spike",
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...(ticket.metadata.setupCommand.length === 0
      ? {}
      : { SPIKE_WORKER_SETUP_B64: Buffer.from(JSON.stringify(ticket.metadata.setupCommand)).toString("base64") }),
    ...(credential === undefined ? {} : { SPIKE_PI_AUTH_B64: credential.encodedAuth }),
  };
  return Object.entries(values).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

async function observeDockerWorker(root: ProjectPaths, identity: TicketIdentity): Promise<WorkerObservation> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) return { hosting: null, status: "unavailable" };
  record = await refreshHerdrExecution(root, record);
  record = await refreshDockerExecution(root, record);
  const runtime = record.metadata.runtime?.resource as DockerRuntime | undefined;
  const hosting = runtime?.host === "herdr" ? "herdr" : "direct";
  if (record.metadata.finishedAt !== undefined) return { hosting, status: "done" };
  if (runtime === undefined || !(await dockerExists(runtime.containerId))) return { hosting, status: "unavailable" };
  // A stopped-but-not-yet-reaped container remains working until the adapter-owned
  // exact-container observer has observed its actual exit and atomically written the marker.
  return { hosting, status: "working" };
}

async function readDockerWorkerTerminal(root: ProjectPaths, identity: TicketIdentity, input: ReadHerdrTerminalInput = {}, herdr: HerdrOperations = herdrOperations): Promise<string> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  const runtime = attendedRuntime(record?.metadata.runtime?.resource);
  if (runtime === undefined) throw new Error("Ticket has no Herdr-hosted terminal");
  return herdr.read(runtime.pane, input);
}

async function attachDockerWorkerTerminal(root: ProjectPaths, identity: TicketIdentity, herdr: HerdrOperations = herdrOperations): Promise<number> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  const runtime = attendedRuntime(record?.metadata.runtime?.resource);
  if (runtime === undefined) throw new Error("Ticket has no Herdr-hosted terminal");
  return herdr.attach(runtime.pane);
}

async function loadFinishedDockerWorker(root: ProjectPaths, identity: TicketIdentity, operations?: WorkerRuntimeOperations): Promise<WorkerExecution> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record !== undefined) {
    record = await refreshHerdrExecution(root, record);
    record = await refreshDockerExecution(root, record, operations ?? dockerWorkerAdapter.runtimeOperations!);
  }
  if (record === undefined || record.metadata.finishedAt === undefined || record.metadata.exitCode === undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} Worker has not finished`);
  }
  return recordedExecution(record.metadata, record.metadata.finishedAt);
}

export async function dispatchDockerTicket(input: DispatchWorkerTicketInput): Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }> {
  const frozenRepository = await discoverRepository(input.cwd, input.hostPaths);
  await assertGoalNotFrozen(frozenRepository, input.goalId);
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  if (selectWorkerAdapter(ticket.metadata.executionPolicy) !== dockerWorkerAdapter) throw new Error("selected Worker adapter cannot host a Docker Ticket");
  // Validate and resolve before preparing an exchange or invoking Docker create.
  validateDockerPolicy(ticket);
  const hostOptions = input.hostOptions ?? defaultWorkerHostOptions;
  const credential = await resolveDockerCredential(ticket, hostOptions);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const image = hostOptions.dockerImage;
  const imageDigest = await dockerRequired(["image", "inspect", "--format", "{{.Id}}", image]);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error(`Docker image has no immutable digest: ${image}`);
  await input.afterDockerImageInspection?.(imageDigest);
  const exchange = await prepareTicketExchange(repository, identity);
  const network = ticket.metadata.executionPolicy.networkAccess === "none" ? "none" : "bridge";
  let containerId: string | undefined;
  let record: RecordedWorker | undefined;
  let completeDispatch: (() => void) | undefined;
  const startedAt = (input.clock ?? (() => new Date()))().toISOString();
  try {
    containerId = await dockerRequired([
      "create", "--read-only", "--network", network, "--tmpfs", "/tmp:rw,exec,nosuid,size=64m", "--tmpfs", "/work:rw,exec,nosuid,size=256m",
      "--mount", `type=bind,src=${exchange.inputDirectory},dst=/exchange/input,readonly`,
      "--mount", `type=bind,src=${exchange.outputDirectory},dst=/exchange/output`,
      "--workdir", "/work/repository", ...dockerEnvironment(exchange, ticket.metadata.inputRevision, ticket, credential), imageDigest, ...input.command,
    ]);
    validateDockerRuntime({ containerId, imageDigest });
    const createdImageDigest = await dockerRequired(["inspect", "--format", "{{.Image}}", containerId]);
    if (createdImageDigest !== imageDigest) {
      throw new Error(`Docker container image does not match inspected provenance: ${createdImageDigest}`);
    }
    record = await recordWorker(repository, {
      ...identity, role: ticket.metadata.role, worker, startedAt, runtime: { containerId, imageDigest }, environmentDigest: imageDigest,
    });
    const completion = new Promise<void>((resolve) => { completeDispatch = resolve; });
    liveDockerWorkers.set(workerKey(identity), completion);
    await dockerRequired(["start", containerId]);
    const exitCode = Number(await dockerRequired(["wait", containerId]));
    const finishedAt = (input.clock ?? (() => new Date()))().toISOString();
    // Finalization may have stopped and removed the runtime while wait was
    // pending. Merge terminal evidence into the current durable record rather
    // than resurrecting this dispatch-time runtime snapshot.
    const current = await loadRecordedWorkerIfPresent(repository, identity) ?? record;
    record = {
      metadata: workerRecordSchema.parse({
        ...current.metadata,
        finishedAt: current.metadata.finishedAt ?? finishedAt,
        ...(current.metadata.exitCode === undefined ? { exitCode } : {}),
      }),
      body: current.body,
    };
    await replaceWorkerRecord(repository, record);
    const logs = await docker(["logs", containerId]);
    if (logs.code !== 0) throw new Error(`docker logs failed: ${(logs.stderr || logs.stdout).trim()}`);
    return { root: repository.root, exchange, execution: { ...identity, adapter: "docker", isolation: "container", worker, model: ticket.metadata.model, thinking: ticket.metadata.thinking, startedAt, finishedAt, exitCode, environmentDigest: imageDigest, stdout: logs.stdout, stderr: logs.stderr } };
  } catch (error) {
    if (record === undefined && containerId !== undefined) await dockerRemove(containerId).catch(() => undefined);
    throw error;
  } finally {
    completeDispatch?.();
    liveDockerWorkers.delete(workerKey(identity));
  }
}

/** Launch an interactive Docker container beside its planner in one fresh Herdr pane. The
 * adapter-owned restartable exact-container observer waits after attachment;
 * attachment loss is never completion evidence. */
export async function dispatchHerdrDockerTicket(input: DispatchHerdrTicketInput): Promise<{ root: string; exchange: TicketExchange; hosting: "herdr"; status: "working" }> {
  const frozenRepository = await discoverRepository(input.cwd, input.hostPaths);
  await assertGoalNotFrozen(frozenRepository, input.goalId);
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  if (selectWorkerAdapter(ticket.metadata.executionPolicy) !== dockerWorkerAdapter) throw new Error("selected Worker adapter cannot host a Docker Ticket");
  validateDockerPolicy(ticket);
  const hostOptions = input.hostOptions ?? defaultWorkerHostOptions;
  const credential = await resolveDockerCredential(ticket, hostOptions);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const imageDigest = await dockerRequired(["image", "inspect", "--format", "{{.Id}}", hostOptions.dockerImage]);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error(`Docker image has no immutable digest: ${hostOptions.dockerImage}`);
  const exchange = await prepareTicketExchange(repository, identity);
  const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
  const host = input.herdr ?? herdrOperations;
  const network = ticket.metadata.executionPolicy.networkAccess === "none" ? "none" : "bridge";
  let containerId: string | undefined;
  let handles: HerdrPaneHandle | undefined;
  let recorded = false;
  try {
    containerId = await dockerRequired([
      "create", "--tty", "--interactive", "--read-only", "--network", network, "--tmpfs", "/tmp:rw,exec,nosuid,size=64m", "--tmpfs", "/work:rw,exec,nosuid,size=256m",
      "--mount", `type=bind,src=${exchange.inputDirectory},dst=/exchange/input,readonly`,
      "--mount", `type=bind,src=${exchange.outputDirectory},dst=/exchange/output`,
      "--workdir", "/work/repository", ...dockerEnvironment(exchange, ticket.metadata.inputRevision, ticket, credential), imageDigest, ...input.command,
    ]);
    const createdImageDigest = await dockerRequired(["inspect", "--format", "{{.Image}}", containerId]);
    if (createdImageDigest !== imageDigest) throw new Error("Docker container image does not match inspected provenance");
    handles = await host.splitPane({ cwd: workspace, environment: {} });
    await recordWorker(repository, { ...identity, role: ticket.metadata.role, worker, startedAt: (input.clock ?? (() => new Date()))().toISOString(), environmentDigest: imageDigest, runtime: { containerId, imageDigest, host: "herdr", workspace, pane: handles.pane } });
    recorded = true;
    // Start is adapter-owned. Herdr owns only this interactive attachment;
    // losing its shell cannot prevent a later supervisor from observing exit.
    await dockerRequired(["start", containerId]);
    await host.run(handles.pane, `docker attach ${shellQuote(containerId)}`);
    return { root: repository.root, exchange, hosting: "herdr", status: "working" };
  } catch (error) {
    if (!recorded) {
      if (handles !== undefined) await host.closePane(handles.pane).catch(() => undefined);
      if (containerId !== undefined) await dockerRemove(containerId).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type DispatchHerdrTicketInput = DispatchLocalTicketInput & {
  herdr?: HerdrOperations;
};

export async function dispatchHerdrTicket(
  input: DispatchHerdrTicketInput,
): Promise<{ root: string; exchange: TicketExchange; hosting: "herdr"; status: "working" }> {
  const frozenRepository = await discoverRepository(input.cwd, input.hostPaths);
  await assertGoalNotFrozen(frozenRepository, input.goalId);
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  if (selectWorkerAdapter(ticket.metadata.executionPolicy) !== localCloneWorkerAdapter) {
    throw new Error("selected Worker adapter cannot host a local-clone Ticket");
  }
  validateLocalPolicy(ticket);

  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const exchange = await prepareTicketExchange(repository, identity);
  const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
  const checkout = join(workspace, "repository");
  const inputBundle = join(exchange.inputDirectory, "repository.bundle");
  await git(workspace, ["clone", "--quiet", "--no-checkout", inputBundle, checkout]);
  await git(checkout, ["checkout", "--quiet", "--detach", ticket.metadata.inputRevision]);
  const checkoutRevision = await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (checkoutRevision !== ticket.metadata.inputRevision) {
    throw new Error(`local clone started at ${checkoutRevision}, expected ${ticket.metadata.inputRevision}`);
  }

  const host = input.herdr ?? herdrOperations;
  const marker = join(workspace, "herdr-execution.json");
  const script = join(workspace, "run-worker");
  const launchedCommand = input.command.map(shellQuote).join(" ");
  const setupCommand = ticket.metadata.setupCommand.map(shellQuote).join(" ");
  await writeFile(script, `#!/bin/sh\nset +e\nstatus=0\n${setupCommand === "" ? "" : `${setupCommand}\nstatus=$?\n`}if [ "$status" -eq 0 ]; then\n  ${launchedCommand}\n  status=$?\nfi\nfinished=$(date -u '+%Y-%m-%dT%H:%M:%SZ')\ntmp=${shellQuote(marker)}.tmp.$$\nprintf '{"exitCode":%s,"finishedAt":"%s"}\\n' "$status" "$finished" > "$tmp"\nmv "$tmp" ${shellQuote(marker)}\nexit "$status"\n`, { mode: 0o700 });

  const clock = input.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  let handles: HerdrPaneHandle | undefined;
  let workerRecord: RecordedWorker | undefined;
  try {
    handles = await host.splitPane({
      cwd: checkout,
      environment: workerEnvironment(exchange, ticket.metadata.inputRevision, ticket, (input.hostOptions ?? defaultWorkerHostOptions).spikeExecutable),
    });
    workerRecord = await recordLocalCloneWorker(repository, {
      ...identity,
      role: ticket.metadata.role,
      worker,
      startedAt,
      workspace,
      herdr: handles,
      ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
    });
    await host.run(handles.pane, script);
  } catch (error) {
    if (workerRecord === undefined) {
      if (handles !== undefined) await host.closePane(handles.pane).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
    throw error;
  }

  return { root: repository.root, exchange, hosting: "herdr", status: "working" };
}

export async function dispatchLocalTicket(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }> {
  const frozenRepository = await discoverRepository(input.cwd, input.hostPaths);
  await assertGoalNotFrozen(frozenRepository, input.goalId);
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  if (selectWorkerAdapter(ticket.metadata.executionPolicy) !== localCloneWorkerAdapter) {
    throw new Error("selected Worker adapter cannot host a local-clone Ticket");
  }
  validateLocalPolicy(ticket);

  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const exchange = await prepareTicketExchange(repository, identity);
  const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
  const checkout = join(workspace, "repository");
  const clock = input.clock ?? (() => new Date());
  let startedAt = "";
  let finishedAt = "";
  let exitCode = -1;
  let stdout = "";
  let stderr = "";
  let workerRecord: RecordedWorker | undefined;
  let completeLiveWorker!: () => void;
  const liveWorker: LiveDirectWorker = {
    stopRequested: false,
    completed: new Promise<void>((resolve) => {
      completeLiveWorker = resolve;
    }),
    complete: () => completeLiveWorker(),
  };
  const liveWorkerKey = workerKey(identity);
  if (liveDirectWorkers.has(liveWorkerKey)) throw new Error(`direct worker is already live for Ticket ${liveWorkerKey}`);
  liveDirectWorkers.set(liveWorkerKey, liveWorker);

  try {
    startedAt = clock().toISOString();
    workerRecord = await recordLocalCloneWorker(repository, {
      ...identity,
      role: ticket.metadata.role,
      worker,
      startedAt,
      workspace,
      ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
    });

    const inputBundle = join(exchange.inputDirectory, "repository.bundle");
    await git(workspace, ["clone", "--quiet", "--no-checkout", inputBundle, checkout]);
    await git(checkout, ["checkout", "--quiet", "--detach", ticket.metadata.inputRevision]);
    const checkoutRevision = await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (checkoutRevision !== ticket.metadata.inputRevision) {
      throw new Error(`local clone started at ${checkoutRevision}, expected ${ticket.metadata.inputRevision}`);
    }

    const environment = {
      ...(input.environment ?? process.env),
      ...workerEnvironment(exchange, ticket.metadata.inputRevision, ticket, (input.hostOptions ?? defaultWorkerHostOptions).spikeExecutable),
    };
    const run = async (command: string[]) => {
      const child = Bun.spawn(command, {
        cwd: checkout,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      liveWorker.process = child;
      workerRecord = {
        ...workerRecord!,
        metadata: workerRecordSchema.parse({
          ...workerRecord!.metadata,
          runtime: { adapter: "local-clone", resource: { host: "direct", workspace, pid: child.pid } },
        }),
      };
      await replaceWorkerRecord(repository, workerRecord);
      const [code, commandStdout, commandStderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout: commandStdout, stderr: commandStderr };
    };

    if (ticket.metadata.setupCommand.length > 0) {
      try {
        const setup = await run(ticket.metadata.setupCommand);
        exitCode = setup.code;
        stdout = setup.stdout;
        stderr = setup.stderr;
      } catch (error) {
        exitCode = -1;
        stderr = `Worker setup could not start: ${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
    if (exitCode === 0 || ticket.metadata.setupCommand.length === 0) {
      if (liveWorker.stopRequested) throw new Error("direct worker was stopped before launch");
      const execution = await run(input.command);
      exitCode = execution.code;
      stdout += execution.stdout;
      stderr += execution.stderr;
    }
    finishedAt = clock().toISOString();
  } finally {
    try {
      if (workerRecord !== undefined) {
        finishedAt ||= new Date().toISOString();
        workerRecord = {
          ...workerRecord,
          metadata: workerRecordSchema.parse({
            ...workerRecord.metadata,
            runtime: { adapter: "local-clone", resource: { host: "direct", workspace } },
            finishedAt,
            exitCode,
          }),
        };
        await replaceWorkerRecord(repository, workerRecord);
      }
    } finally {
      liveDirectWorkers.delete(liveWorkerKey);
      liveWorker.complete();
    }
  }

  return {
    root: repository.root,
    exchange,
    execution: {
      ...identity,
      adapter: "local-clone",
      isolation: "workspace",
      worker,
      model: ticket.metadata.model,
      thinking: ticket.metadata.thinking,
      startedAt,
      finishedAt,
      exitCode,
      ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
      stdout,
      stderr,
    },
  };
}

function piTerminalTools(role: "implement" | "review"): { complete: string; blocked: string } {
  return role === "implement"
    ? { complete: "spike_complete_implementation", blocked: "spike_block_implementation" }
    : { complete: "spike_complete_review", blocked: "spike_block_review" };
}

export function piWorkerPrompt(role: "implement" | "review", isolation: "workspace" | "container"): string {
  const terminalTools = piTerminalTools(role);
  const instruction = `Execute the attached immutable ${role} Ticket in this exact checkout. Finish with ${terminalTools.complete}, or use ${terminalTools.blocked} only when a condition outside the worker's control prevents completion.`;
  if (isolation === "workspace") return instruction;
  return `${instruction}\n\nContainer tools available: Bun, Node.js, Git, ripgrep (\`rg\`), fd (\`fdfind\`), jq, and curl. Their installation does not grant network access; the immutable Ticket execution policy remains authoritative.`;
}

async function acceptedSubmission(outputDirectory: string): Promise<boolean> {
  try {
    const stat = await lstat(join(outputDirectory, "submission.md"));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function dispatchPiTicket(
  input: DispatchPiTicketInput,
): Promise<
  | {
      root: string;
      exchange: TicketExchange;
      hosting: "direct";
      execution: WorkerExecution;
      classification: PiDispatchClassification;
    }
  | {
      root: string;
      exchange: TicketExchange;
      hosting: "herdr";
      status: "working";
    }
> {
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  await assertGoalNotFrozen(repository, input.goalId);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const hostOptions = input.hostOptions ?? defaultWorkerHostOptions;
  const host = selectPiHost(ticket.metadata.executionPolicy, input.host, hostOptions.herdrAvailable);
  const container = selectWorkerAdapter(ticket.metadata.executionPolicy) === dockerWorkerAdapter;
  // Docker receives no host checkout paths. The pinned image contains both Pi
  // and this extension, while its entrypoint clones the immutable input bundle.
  const inputDirectory = container ? "/exchange/input" : join(exchangePath(repository, identity), "input");
  const terminalTools = piTerminalTools(ticket.metadata.role);
  const extension = container ? "/opt/spike/src/pi-worker-extension.ts" : resolve(import.meta.dir, "pi-worker-extension.ts");
  const command = [
    container ? "/usr/local/bin/pi" : input.piExecutable ?? hostOptions.piExecutable,
    ...(host === "direct" ? ["--print"] : []),
    "--no-session",
    // Never prompt for project trust: the immutable checkout is established
    // by the pinned container entrypoint (or local-clone dispatcher).
    "--no-approve",
    "--model",
    ticket.metadata.model,
    "--thinking",
    ticket.metadata.thinking,
    "--no-extensions",
    "--extension",
    extension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools",
    `read,bash,edit,write,${terminalTools.complete},${terminalTools.blocked}`,
    `@${join(inputDirectory, "ticket.md")}`,
    `@${join(inputDirectory, "context.md")}`,
    piWorkerPrompt(ticket.metadata.role, ticket.metadata.executionPolicy.isolation),
  ];
  const adapter = selectWorkerAdapter(ticket.metadata.executionPolicy);
  if (host === "herdr") {
    if (adapter.dispatchAttended === undefined) throw new Error(`Worker adapter ${adapter.adapter} does not support attended dispatch`);
    const attended = await adapter.dispatchAttended({
      ...identity,
      cwd: repository.root,
      hostPaths: input.hostPaths,
      worker: input.worker,
      command,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      hostOptions,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      ...(input.herdr === undefined ? {} : { herdr: input.herdr }),
    });
    return { ...attended, hosting: "herdr" as const };
  }

  const dispatched = await adapter.dispatch({
    ...identity,
    cwd: repository.root,
    hostPaths: input.hostPaths,
    worker: input.worker,
    command,
    hostOptions,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const classification: PiDispatchClassification = dispatched.execution.exitCode !== 0
    ? "failed-execution"
    : await acceptedSubmission(dispatched.exchange.outputDirectory)
      ? "accepted-submission"
      : "missing-submission";
  return { ...dispatched, hosting: "direct", classification };
}

/** Dispatch through the adapter selected by immutable Ticket capabilities. */
export async function dispatchWorkerTicket(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }> {
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  const adapter = selectWorkerAdapter(ticket.metadata.executionPolicy);
  return adapter.dispatch(input);
}

async function dispatchLocalRole(
  input: DispatchLocalTicketInput,
  role: "implement" | "review",
): Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }> {
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const ticket = await loadTicket(repository, input.goalId, input.changeId, input.ticketId);
  if (ticket.metadata.role !== role) throw new Error(`local ${role} dispatch requires a ${role} Ticket`);
  return dispatchLocalTicket(input);
}

export function dispatchLocalImplementation(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }> {
  return dispatchLocalRole(input, "implement");
}

export function dispatchLocalReview(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: WorkerExecution }> {
  return dispatchLocalRole(input, "review");
}
