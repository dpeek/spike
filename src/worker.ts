import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import {
  documentExists,
  installImmutable,
  readDocument,
  replaceAtomic,
  serializeDocument,
} from "./durable-state.ts";
import { createInputBundle } from "./git-change.ts";
import { discoverRepository, git } from "./git.ts";
import {
  herdrOperations,
  type HerdrHandles,
  type HerdrOperations,
  type ReadHerdrTerminalInput,
} from "./herdr.ts";
import { loadTicket, ticketStatus } from "./ticket.ts";

export type TicketIdentity = {
  goalId: string;
  changeId: string;
  ticketId: string;
};

export type TicketExchange = TicketIdentity & {
  inputDirectory: string;
  outputDirectory: string;
};

export type LocalCloneExecution = TicketIdentity & {
  adapter: "local-clone";
  isolation: "workspace";
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

export type DispatchLocalTicketInput = TicketIdentity & {
  cwd: string;
  command: string[];
  worker: string;
  environmentDigest?: string;
  clock?: () => Date;
};

export type DispatchPiTicketInput = TicketIdentity & {
  cwd: string;
  worker: string;
  host?: "herdr" | "direct";
  piExecutable?: string;
  clock?: () => Date;
  herdr?: HerdrOperations;
};

export type PiDispatchClassification =
  | "accepted-submission"
  | "missing-submission"
  | "failed-execution";

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const nonBlankString = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const workerRecordSchema = z
  .object({
    kind: z.literal("worker"),
    goalId: nonBlankString,
    changeId: nonBlankString,
    ticketId: nonBlankString,
    role: z.enum(["implement", "review"]),
    adapter: z.literal("local-clone"),
    isolation: z.literal("workspace"),
    worker: nonBlankString,
    model: nonBlankString,
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    startedAt: timestamp,
    environmentDigest: nonBlankString.optional(),
    resource: z
      .discriminatedUnion("host", [
        z.object({
          host: z.literal("direct"),
          workspace: nonBlankString,
          pid: z.number().int().positive().optional(),
        }).strict(),
        z.object({
          host: z.literal("herdr"),
          workspace: nonBlankString,
          tab: nonBlankString,
          pane: nonBlankString,
        }).strict(),
      ])
      .optional(),
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

type LocalWorkerResource = NonNullable<RecordedWorker["metadata"]["resource"]>;

export type LocalWorkerResourceOperations = {
  stop: (pid: number | undefined, identity: TicketIdentity, herdr?: HerdrHandles) => Promise<void>;
  removeWorkspace: (workspace: string) => Promise<void>;
};

export type WorkerObservation = {
  hosting: "direct" | "herdr" | null;
  status: "working" | "blocked" | "done" | "unavailable";
};

type LiveDirectWorker = {
  process?: DirectProcess;
  stopRequested: boolean;
  completed: Promise<void>;
  complete: () => void;
};

const liveDirectWorkers = new Map<string, LiveDirectWorker>();

function workerKey(identity: TicketIdentity): string {
  return `${identity.goalId}/${identity.changeId}/${identity.ticketId}`;
}

export type WorkerCleanup =
  | { status: "finalized"; execution: LocalCloneExecution }
  | { status: "failed"; phase: "stop" | "cleanup"; execution: LocalCloneExecution; message: string };

export function exchangePath(root: string, identity: TicketIdentity): string {
  return join(
    root,
    ".spike",
    "exchange",
    "goals",
    identity.goalId,
    "changes",
    identity.changeId,
    "tickets",
    identity.ticketId,
  );
}

export function ticketOutputPath(root: string, identity: TicketIdentity): string {
  return join(exchangePath(root, identity), "output");
}

export function workerRecordPath(root: string, identity: TicketIdentity): string {
  return join(
    root,
    ".spike",
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

function localExecution(
  record: RecordedWorker["metadata"],
  finishedAt: string,
): LocalCloneExecution {
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

export async function loadRecordedWorkerIfPresent(
  root: string,
  identity: TicketIdentity,
): Promise<RecordedWorker | undefined> {
  const path = workerRecordPath(root, identity);
  if (!(await documentExists(root, path))) return undefined;
  const document = await readDocument(root, path);
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
  if (metadata.model !== ticket.metadata.model || metadata.thinking !== ticket.metadata.thinking) {
    throw new Error("Worker record model selection does not match its Ticket");
  }
  if (Date.parse(metadata.finishedAt ?? metadata.startedAt) < Date.parse(metadata.startedAt)) {
    throw new Error("Worker record finishedAt must not precede startedAt");
  }
  if (metadata.resource !== undefined) validateWorkspace(metadata.resource.workspace);
  return { metadata, body: document.body };
}

export async function recordLocalWorker(
  root: string,
  input: TicketIdentity & {
    role: "implement" | "review";
    worker: string;
    startedAt: string;
    workspace: string;
    pid?: number;
    herdr?: HerdrHandles;
    environmentDigest?: string;
  },
): Promise<RecordedWorker> {
  validateWorkspace(input.workspace);
  const ticket = await loadTicket(root, input.goalId, input.changeId, input.ticketId);
  const metadata = workerRecordSchema.parse({
    kind: "worker",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId: input.ticketId,
    role: input.role,
    adapter: "local-clone",
    isolation: "workspace",
    worker: input.worker,
    model: ticket.metadata.model,
    thinking: ticket.metadata.thinking,
    startedAt: input.startedAt,
    ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
    resource: input.herdr === undefined
      ? {
          host: "direct",
          workspace: input.workspace,
          ...(input.pid === undefined ? {} : { pid: input.pid }),
        }
      : {
          host: "herdr",
          workspace: input.workspace,
          tab: input.herdr.tab,
          pane: input.herdr.pane,
        },
  });
  if (ticket.metadata.role !== input.role) throw new Error("Worker record role does not match its Ticket");
  if (ticket.metadata.executionPolicy.isolation !== "workspace") {
    throw new Error("local-clone Worker record requires workspace isolation");
  }
  const body = "# Local-clone worker runtime\n";
  await installImmutable(root, workerRecordPath(root, input), serializeDocument(metadata, body));
  return { metadata, body };
}

async function replaceWorkerRecord(root: string, record: RecordedWorker): Promise<void> {
  await replaceAtomic(
    root,
    workerRecordPath(root, record.metadata),
    serializeDocument(record.metadata, record.body),
  );
}

const herdrExecutionSchema = z.object({
  exitCode: z.number().int(),
  finishedAt: timestamp,
}).strict();

function herdrExecutionPath(resource: Extract<LocalWorkerResource, { host: "herdr" }>): string {
  return join(resource.workspace, "herdr-execution.json");
}

async function refreshHerdrExecution(root: string, record: RecordedWorker): Promise<RecordedWorker> {
  const resource = record.metadata.resource;
  if (record.metadata.finishedAt !== undefined || resource?.host !== "herdr") return record;
  const path = herdrExecutionPath(resource);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error("Herdr execution marker must be a bounded regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return record;
    throw error;
  }
  const execution = herdrExecutionSchema.parse(JSON.parse(await readFile(path, "utf8")));
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

const localWorkerResourceOperations: LocalWorkerResourceOperations = {
  async stop(pid, identity, herdr) {
    if (herdr !== undefined) {
      await herdrOperations.closeTab(herdr.tab);
      return;
    }
    if (pid === undefined) return;
    const live = liveDirectWorkers.get(workerKey(identity));
    if (live === undefined) {
      throw new Error("direct worker session is unavailable after restart; refusing to signal a persisted PID");
    }
    if (live.process?.pid !== pid) {
      throw new Error("recorded direct worker PID does not match the live owned process");
    }

    live.stopRequested = true;
    if (live.process !== undefined) await stopDirectProcess(live.process);
    await live.completed;
  },
  removeWorkspace: (workspace) => rm(workspace, { recursive: true, force: true }),
};

export async function stopAndFinalizeRecordedWorker(
  root: string,
  identity: TicketIdentity,
  finishedAt: Date,
  operations: LocalWorkerResourceOperations = localWorkerResourceOperations,
): Promise<WorkerCleanup> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} has no Worker record`);
  const finish = record.metadata.finishedAt ?? finishedAt.toISOString();
  const execution = localExecution(record.metadata, finish);
  if (record.metadata.resource === undefined) return { status: "finalized", execution };

  const resource = record.metadata.resource;
  try {
    await operations.stop(
      resource.host === "direct" ? resource.pid : undefined,
      identity,
      resource.host === "herdr" ? { tab: resource.tab, pane: resource.pane } : undefined,
    );
  } catch (error) {
    return {
      status: "failed",
      phase: "stop",
      execution,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await operations.removeWorkspace(resource.workspace);
  } catch (error) {
    return {
      status: "failed",
      phase: "cleanup",
      execution,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const metadata = workerRecordSchema.parse({
    ...record.metadata,
    resource: undefined,
    finishedAt: finish,
  });
  try {
    await replaceWorkerRecord(root, { metadata, body: record.body });
  } catch (error) {
    return {
      status: "failed",
      phase: "cleanup",
      execution,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "finalized", execution };
}

export async function forgetFinalizedWorker(root: string, identity: TicketIdentity): Promise<void> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) return;
  if (record.metadata.resource !== undefined) throw new Error("cannot forget Worker record before resources are finalized");
  await rm(workerRecordPath(root, identity));
}

export async function loadFinishedLocalExecution(
  root: string,
  identity: TicketIdentity,
): Promise<LocalCloneExecution> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} has no Worker execution evidence`);
  }
  record = await refreshHerdrExecution(root, record);
  if (record.metadata.finishedAt === undefined || record.metadata.exitCode === undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} Worker has not finished`);
  }
  if (record.metadata.resource?.host === "direct" && record.metadata.resource.pid !== undefined) {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} Worker still has a live process handle`);
  }
  return localExecution(record.metadata, record.metadata.finishedAt);
}

export async function observeWorker(
  root: string,
  identity: TicketIdentity,
  herdr: HerdrOperations = herdrOperations,
): Promise<WorkerObservation> {
  let record = await loadRecordedWorkerIfPresent(root, identity);
  if (record === undefined) return { hosting: null, status: "unavailable" };
  record = await refreshHerdrExecution(root, record);
  const resource = record.metadata.resource;
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

export async function readWorkerTerminal(
  root: string,
  identity: TicketIdentity,
  input: ReadHerdrTerminalInput = {},
  herdr: HerdrOperations = herdrOperations,
): Promise<string> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record?.metadata.resource?.host !== "herdr") throw new Error("Ticket has no Herdr-hosted terminal");
  return herdr.read(record.metadata.resource.pane, input);
}

export async function attachWorkerTerminal(
  root: string,
  identity: TicketIdentity,
  herdr: HerdrOperations = herdrOperations,
): Promise<number> {
  const record = await loadRecordedWorkerIfPresent(root, identity);
  if (record?.metadata.resource?.host !== "herdr") throw new Error("Ticket has no Herdr-hosted terminal");
  return herdr.attach(record.metadata.resource.pane);
}

function contextBody(role: "implement" | "review", inputRevision: string): string {
  if (role === "review") {
    return `# Review worker context

The private checkout starts at the exact Candidate \`${inputRevision}\`.

## Declared output

Write artifacts only below \`SPIKE_OUTPUT_DIR/artifacts/\`. In Pi, finish with the terminating \`spike_complete_review\` tool. Scripted workers may instead use \`spike worker complete --file payload.json\` or stdin. The review payload contains:

- non-blank \`reviewStatement\`;
- \`findings\` with unique kebab-case \`id\`, severity \`critical\`, \`high\`, \`medium\`, or \`low\`, and non-blank \`statement\`;
- \`acceptanceAssessment\` covering every criterion exactly once with assessment \`met\`, \`not-met\`, or \`unclear\`, and evidence;
- verdict \`remediate\`, \`approve\`, \`reject\`, or \`ask-operator\`;
- \`artifacts\`, an array of declared paths below \`artifacts/\`.

Spike validates and digests artifacts and atomically writes the canonical \`submission.md\`. Do not write a Submission or Git bundle yourself.
`;
  }
  return `# Implementation worker context

The private checkout starts at exact revision \`${inputRevision}\`.

## Declared output

Implement in the private checkout and write artifacts only below \`SPIKE_OUTPUT_DIR/artifacts/\`. In Pi, finish with the terminating \`spike_complete_implementation\` tool. Scripted workers may instead use \`spike worker complete --file payload.json\` or stdin. The implementation payload contains non-blank \`summary\`, \`verification\`, \`assumptions\`, \`limitations\`, \`risks\`, and \`followUp\` strings plus \`artifacts\`, an array of declared paths below \`artifacts/\`.

Spike snapshots the checkout, creates \`repository.bundle\`, validates and digests artifacts, and atomically writes the canonical \`submission.md\` last. Do not write a Submission or Git bundle yourself.
`;
}

export async function prepareTicketExchange(root: string, identity: TicketIdentity): Promise<TicketExchange> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  if ((await ticketStatus(root, identity.goalId, identity.changeId, identity.ticketId)) === "reported") {
    throw new Error(`Ticket ${identity.goalId}/${identity.changeId}/${identity.ticketId} is already reported`);
  }
  const exchange = exchangePath(root, identity);
  if (await pathExists(exchange)) throw new Error(`Ticket exchange already exists: ${exchange}`);
  const inputDirectory = join(exchange, "input");
  const outputDirectory = join(exchange, "output");
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });

  await installImmutable(
    root,
    join(inputDirectory, "ticket.md"),
    serializeDocument(ticket.metadata, ticket.body),
  );
  await installImmutable(
    root,
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
  await createInputBundle(root, ticket.metadata.inputRevision, join(inputDirectory, "repository.bundle"), identity);
  await Promise.all([
    chmod(join(inputDirectory, "ticket.md"), 0o400),
    chmod(join(inputDirectory, "context.md"), 0o400),
    chmod(inputDirectory, 0o500),
  ]);
  await mkdir(outputDirectory, { mode: 0o700 });
  return { ...identity, inputDirectory, outputDirectory };
}

function workerEnvironment(
  exchange: TicketExchange,
  checkoutRevision: string,
  ticket: Awaited<ReturnType<typeof loadTicket>>,
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
    SPIKE_BIN: process.env["SPIKE_BIN"] ?? resolve(import.meta.dir, "..", "bin", "spike"),
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type DispatchHerdrTicketInput = DispatchLocalTicketInput & {
  herdr?: HerdrOperations;
};

export async function dispatchHerdrTicket(
  input: DispatchHerdrTicketInput,
): Promise<{ root: string; exchange: TicketExchange; hosting: "herdr"; status: "working" }> {
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const repository = await discoverRepository(input.cwd);
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  validateLocalPolicy(ticket);

  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const exchange = await prepareTicketExchange(repository.root, identity);
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
  await writeFile(script, `#!/bin/sh\nset +e\n${launchedCommand}\nstatus=$?\nfinished=$(date -u '+%Y-%m-%dT%H:%M:%SZ')\ntmp=${shellQuote(marker)}.tmp.$$\nprintf '{"exitCode":%s,"finishedAt":"%s"}\\n' "$status" "$finished" > "$tmp"\nmv "$tmp" ${shellQuote(marker)}\nexit "$status"\n`, { mode: 0o700 });

  const clock = input.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  let handles: HerdrHandles | undefined;
  let workerRecord: RecordedWorker | undefined;
  try {
    handles = await host.createTab({
      cwd: checkout,
      label: `spike-${input.goalId.slice(-8)}-${input.changeId}-${input.ticketId}`,
      environment: workerEnvironment(exchange, ticket.metadata.inputRevision, ticket),
    });
    workerRecord = await recordLocalWorker(repository.root, {
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
      if (handles !== undefined) await host.closeTab(handles.tab).catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
    throw error;
  }

  return { root: repository.root, exchange, hosting: "herdr", status: "working" };
}

export async function dispatchLocalTicket(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: LocalCloneExecution }> {
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const repository = await discoverRepository(input.cwd);
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  validateLocalPolicy(ticket);

  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const exchange = await prepareTicketExchange(repository.root, identity);
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
    workerRecord = await recordLocalWorker(repository.root, {
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

    if (liveWorker.stopRequested) throw new Error("direct worker was stopped before launch");
    const child = Bun.spawn(input.command, {
      cwd: checkout,
      env: { ...process.env, ...workerEnvironment(exchange, ticket.metadata.inputRevision, ticket) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    liveWorker.process = child;
    workerRecord = {
      ...workerRecord,
      metadata: workerRecordSchema.parse({
        ...workerRecord.metadata,
        resource: { host: "direct", workspace, pid: child.pid },
      }),
    };
    await replaceWorkerRecord(repository.root, workerRecord);
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    finishedAt = clock().toISOString();
  } finally {
    try {
      if (workerRecord !== undefined) {
        finishedAt ||= new Date().toISOString();
        workerRecord = {
          ...workerRecord,
          metadata: workerRecordSchema.parse({
            ...workerRecord.metadata,
            resource: { host: "direct", workspace },
            finishedAt,
            exitCode,
          }),
        };
        await replaceWorkerRecord(repository.root, workerRecord);
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

function piCompletionTool(role: "implement" | "review"): string {
  return role === "implement" ? "spike_complete_implementation" : "spike_complete_review";
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
      execution: LocalCloneExecution;
      classification: PiDispatchClassification;
    }
  | {
      root: string;
      exchange: TicketExchange;
      hosting: "herdr";
      status: "working";
    }
> {
  const repository = await discoverRepository(input.cwd);
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const inputDirectory = join(exchangePath(repository.root, identity), "input");
  const completionTool = piCompletionTool(ticket.metadata.role);
  const extension = resolve(import.meta.dir, "pi-worker-extension.ts");
  const command = [
    input.piExecutable ?? "pi",
    "--print",
    "--no-session",
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
    `read,bash,edit,write,${completionTool}`,
    `@${join(inputDirectory, "ticket.md")}`,
    `@${join(inputDirectory, "context.md")}`,
    `Execute the attached immutable ${ticket.metadata.role} Ticket in this exact checkout. Finish only with ${completionTool}.`,
  ];
  if (input.host !== "direct") {
    return dispatchHerdrTicket({
      ...identity,
      cwd: repository.root,
      worker: input.worker,
      command,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(input.herdr === undefined ? {} : { herdr: input.herdr }),
    });
  }

  const dispatched = await dispatchLocalTicket({
    ...identity,
    cwd: repository.root,
    worker: input.worker,
    command,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const classification: PiDispatchClassification = dispatched.execution.exitCode !== 0
    ? "failed-execution"
    : await acceptedSubmission(dispatched.exchange.outputDirectory)
      ? "accepted-submission"
      : "missing-submission";
  return { ...dispatched, hosting: "direct", classification };
}

async function dispatchLocalRole(
  input: DispatchLocalTicketInput,
  role: "implement" | "review",
): Promise<{ root: string; exchange: TicketExchange; execution: LocalCloneExecution }> {
  const repository = await discoverRepository(input.cwd);
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  if (ticket.metadata.role !== role) throw new Error(`local ${role} dispatch requires a ${role} Ticket`);
  return dispatchLocalTicket(input);
}

export function dispatchLocalImplementation(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: LocalCloneExecution }> {
  return dispatchLocalRole(input, "implement");
}

export function dispatchLocalReview(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: LocalCloneExecution }> {
  return dispatchLocalRole(input, "review");
}
