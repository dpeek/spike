import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  model: string;
  environmentDigest?: string;
  clock?: () => Date;
};

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
    startedAt: timestamp,
    environmentDigest: nonBlankString.optional(),
    resource: z
      .object({
        workspace: nonBlankString,
        pid: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    finishedAt: timestamp.optional(),
    exitCode: z.number().int().optional(),
  })
  .strict();

export type RecordedWorker = {
  metadata: z.infer<typeof workerRecordSchema>;
  body: string;
};

export type LocalWorkerResourceOperations = {
  stop: (pid: number) => Promise<void>;
  removeWorkspace: (workspace: string) => Promise<void>;
};

export type WorkerCleanup =
  | { status: "finalized"; execution: LocalCloneExecution }
  | { status: "failed"; execution: LocalCloneExecution; message: string };

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
    model: string;
    startedAt: string;
    workspace: string;
    pid?: number;
    environmentDigest?: string;
  },
): Promise<RecordedWorker> {
  validateWorkspace(input.workspace);
  const metadata = workerRecordSchema.parse({
    kind: "worker",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId: input.ticketId,
    role: input.role,
    adapter: "local-clone",
    isolation: "workspace",
    worker: input.worker,
    model: input.model,
    startedAt: input.startedAt,
    ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
    resource: {
      workspace: input.workspace,
      ...(input.pid === undefined ? {} : { pid: input.pid }),
    },
  });
  const ticket = await loadTicket(root, input.goalId, input.changeId, input.ticketId);
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

const localWorkerResourceOperations: LocalWorkerResourceOperations = {
  async stop(pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
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

  try {
    if (record.metadata.resource.pid !== undefined) await operations.stop(record.metadata.resource.pid);
    await operations.removeWorkspace(record.metadata.resource.workspace);
  } catch (error) {
    return {
      status: "failed",
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

function contextBody(role: "implement" | "review", inputRevision: string): string {
  if (role === "review") {
    return `# Review worker context

The private checkout starts at the exact Candidate \`${inputRevision}\`.

## Declared output

Write only to \`SPIKE_OUTPUT_DIR\`:

- \`submission.md\` — JSON-frontmatter Markdown with kind \`submission\`, the full Ticket identity, outcome \`completed\`, \`reviewedRevision\`, \`producingImplementationTicketId\`, \`findings\`, \`acceptanceAssessment\`, verdict \`remediate\`, \`approve\`, or \`reject\`, and declared \`artifacts\`;
- files below \`artifacts/\` that are declared by path and SHA-256 digest in the Submission.

Each finding requires a stable kebab-case \`id\`, severity \`critical\`, \`high\`, \`medium\`, or \`low\`, and a non-blank \`statement\`. Assess every acceptance criterion exactly once as \`met\`, \`not-met\`, or \`unclear\`, with evidence. Do not write an output Git bundle. The completed Submission body must contain a non-blank Review statement section.
`;
  }
  return `# Implementation worker context

The private checkout starts at exact revision \`${inputRevision}\`.

## Declared output

Write only to \`SPIKE_OUTPUT_DIR\`:

- \`submission.md\` — JSON-frontmatter Markdown with kind \`submission\`, the full Ticket identity, outcome \`completed\`, the exact \`workerRevision\`, and declared artifacts;
- \`repository.bundle\` — a valid Git bundle advertising \`workerRevision\`;
- files below \`artifacts/\` that are declared by path and SHA-256 digest in the Submission.

The completed Submission body must contain Summary, Verification, Assumptions, Limitations, Risks, and Follow-up sections.
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

export async function dispatchLocalTicket(
  input: DispatchLocalTicketInput,
): Promise<{ root: string; exchange: TicketExchange; execution: LocalCloneExecution }> {
  if (input.command.length === 0) throw new Error("Worker command must not be empty");
  const worker = requireText(input.worker, "Worker identity");
  const model = requireText(input.model, "Model identity");
  const repository = await discoverRepository(input.cwd);
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  if (ticket.metadata.executionPolicy.isolation !== "workspace") {
    throw new Error("local-clone adapter supports only workspace isolation");
  }
  if (ticket.metadata.executionPolicy.networkAccess !== "unrestricted") {
    throw new Error("local-clone adapter cannot enforce restricted network access");
  }
  if (ticket.metadata.executionPolicy.credentialGrants.length > 0) {
    throw new Error("local-clone adapter does not resolve credential grants");
  }

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

  try {
    startedAt = clock().toISOString();
    workerRecord = await recordLocalWorker(repository.root, {
      ...identity,
      role: ticket.metadata.role,
      worker,
      model,
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

    const child = Bun.spawn(input.command, {
      cwd: checkout,
      env: {
        ...process.env,
        SPIKE_INPUT_DIR: exchange.inputDirectory,
        SPIKE_OUTPUT_DIR: exchange.outputDirectory,
        SPIKE_INPUT_REVISION: ticket.metadata.inputRevision,
        SPIKE_GOAL_ID: input.goalId,
        SPIKE_CHANGE_ID: input.changeId,
        SPIKE_TICKET_ID: input.ticketId,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    workerRecord = {
      ...workerRecord,
      metadata: workerRecordSchema.parse({
        ...workerRecord.metadata,
        resource: { ...workerRecord.metadata.resource!, pid: child.pid },
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
    await rm(workspace, { recursive: true, force: true });
    if (workerRecord !== undefined) {
      finishedAt ||= new Date().toISOString();
      workerRecord = {
        ...workerRecord,
        metadata: workerRecordSchema.parse({
          ...workerRecord.metadata,
          resource: undefined,
          finishedAt,
          exitCode,
        }),
      };
      await replaceWorkerRecord(repository.root, workerRecord);
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
      model,
      startedAt,
      finishedAt,
      exitCode,
      ...(input.environmentDigest === undefined ? {} : { environmentDigest: input.environmentDigest }),
      stdout,
      stderr,
    },
  };
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
