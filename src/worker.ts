import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installImmutable, serializeDocument } from "./durable-state.ts";
import { createInputBundle } from "./git-change.ts";
import { discoverRepository, git } from "./git.ts";
import { loadTicket, reportPath } from "./ticket.ts";

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

export type DispatchLocalImplementationInput = TicketIdentity & {
  cwd: string;
  command: string[];
  worker: string;
  model: string;
  environmentDigest?: string;
  clock?: () => Date;
};

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

export function implementationOutputPath(root: string, identity: TicketIdentity): string {
  return join(exchangePath(root, identity), "output");
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

function contextBody(inputRevision: string): string {
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

export async function prepareImplementationExchange(root: string, identity: TicketIdentity): Promise<TicketExchange> {
  const ticket = await loadTicket(root, identity.goalId, identity.changeId, identity.ticketId);
  if (ticket.metadata.role !== "implement") throw new Error("local implementation dispatch requires an implement Ticket");
  if (await pathExists(reportPath(root, identity.goalId, identity.changeId, identity.ticketId))) {
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
      contextBody(ticket.metadata.inputRevision),
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

export async function dispatchLocalImplementation(
  input: DispatchLocalImplementationInput,
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
  const exchange = await prepareImplementationExchange(repository.root, identity);
  const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
  const checkout = join(workspace, "repository");
  const clock = input.clock ?? (() => new Date());
  let startedAt = "";
  let finishedAt = "";
  let exitCode = -1;
  let stdout = "";
  let stderr = "";

  try {
    const inputBundle = join(exchange.inputDirectory, "repository.bundle");
    await git(workspace, ["clone", "--quiet", "--no-checkout", inputBundle, checkout]);
    await git(checkout, ["checkout", "--quiet", "--detach", ticket.metadata.inputRevision]);
    const checkoutRevision = await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (checkoutRevision !== ticket.metadata.inputRevision) {
      throw new Error(`local clone started at ${checkoutRevision}, expected ${ticket.metadata.inputRevision}`);
    }

    startedAt = clock().toISOString();
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
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    finishedAt = clock().toISOString();
  } finally {
    await rm(workspace, { recursive: true, force: true });
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
