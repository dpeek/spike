import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { documentExists, installImmutable, readDocument, replaceAtomic, serializeDocument } from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { projectRoot } from "./project.ts";
import { loadApplicationTicket, prepareApplicationTicketExchange, type ApplicationTicketIdentity } from "./application-ticket.ts";

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const recordSchema = z.object({
  kind: z.literal("application-worker"), goalId: z.string().min(1), applicationId: z.string().min(1), ticketId: z.string().min(1),
  adapter: z.literal("local-clone"), isolation: z.enum(["workspace", "container"]), worker: z.string().trim().min(1), model: z.string().trim().min(1),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]), startedAt: timestamp, finishedAt: timestamp.optional(), exitCode: z.number().int().optional(),
  runtime: z.object({ workspace: z.string().min(1) }).strict().optional(),
}).strict();
export type ApplicationWorkerExecution = ApplicationTicketIdentity & { adapter: "local-clone"; isolation: "workspace" | "container"; worker: string; model: string; thinking: z.infer<typeof recordSchema>["thinking"]; startedAt: string; finishedAt: string; exitCode: number; stdout: string; stderr: string };
export type ApplicationWorkerRecord = { metadata: z.infer<typeof recordSchema>; body: string };

export function applicationWorkerRecordPath(root: string, identity: ApplicationTicketIdentity): string {
  return join(projectRoot(root), "runtime", "application-workers", "goals", identity.goalId, "applications", identity.applicationId, "tickets", identity.ticketId, "worker.md");
}
export async function loadApplicationWorkerIfPresent(root: string, identity: ApplicationTicketIdentity): Promise<ApplicationWorkerRecord | undefined> {
  const path = applicationWorkerRecordPath(root, identity); if (!(await documentExists(root, path))) return undefined;
  const doc = await readDocument(root, path), metadata = recordSchema.parse(doc.metadata);
  if (metadata.goalId !== identity.goalId || metadata.applicationId !== identity.applicationId || metadata.ticketId !== identity.ticketId) throw new Error("Application Worker record belongs to a different Ticket");
  const ticket = await loadApplicationTicket(root, identity.goalId, identity.applicationId, identity.ticketId);
  if (metadata.isolation !== ticket.metadata.executionPolicy.isolation || metadata.model !== ticket.metadata.model || metadata.thinking !== ticket.metadata.thinking) throw new Error("Application Worker record does not match immutable Ticket selection");
  return { metadata, body: doc.body };
}
async function replaceRecord(root: string, record: ApplicationWorkerRecord) { await replaceAtomic(root, applicationWorkerRecordPath(root, record.metadata), serializeDocument(record.metadata, record.body)); }
function execution(record: ApplicationWorkerRecord): ApplicationWorkerExecution {
  if (record.metadata.finishedAt === undefined || record.metadata.exitCode === undefined) throw new Error(`Application Worker ${record.metadata.goalId}/${record.metadata.applicationId}/${record.metadata.ticketId} has not finished`);
  return { goalId: record.metadata.goalId, applicationId: record.metadata.applicationId, ticketId: record.metadata.ticketId, adapter: record.metadata.adapter, isolation: record.metadata.isolation, worker: record.metadata.worker, model: record.metadata.model, thinking: record.metadata.thinking, startedAt: record.metadata.startedAt, finishedAt: record.metadata.finishedAt, exitCode: record.metadata.exitCode, stdout: "", stderr: "" };
}
export async function observeApplicationWorker(root: string, identity: ApplicationTicketIdentity) {
  const record = await loadApplicationWorkerIfPresent(root, identity); return record === undefined ? { status: "unavailable" as const } : record.metadata.finishedAt === undefined ? { status: "working" as const } : { status: "done" as const };
}
export async function readApplicationWorker(root: string, identity: ApplicationTicketIdentity, maximumBytes = 64 * 1024): Promise<string> {
  const record = await loadApplicationWorkerIfPresent(root, identity); if (record === undefined) throw new Error("Application Worker has no runtime record");
  return record.body.slice(0, maximumBytes);
}
export async function loadFinishedApplicationWorker(root: string, identity: ApplicationTicketIdentity) { const record = await loadApplicationWorkerIfPresent(root, identity); if (record === undefined) throw new Error("Application Worker has no runtime record"); return execution(record); }
/** Finalization releases only external runtime. It is safe to retry and keeps
 * finished execution provenance available until Report publication. */
export async function finalizeApplicationWorker(root: string, identity: ApplicationTicketIdentity): Promise<void> {
  const record = await loadApplicationWorkerIfPresent(root, identity); if (record?.metadata.runtime === undefined) return;
  await rm(record.metadata.runtime.workspace, { recursive: true, force: true });
  await replaceRecord(root, { ...record, metadata: recordSchema.parse({ ...record.metadata, runtime: undefined }) });
}
/** Forgetting is deliberately separate from finalization: a Report is the
 * durable execution evidence once publication has succeeded. */
export async function forgetFinalizedApplicationWorker(root: string, identity: ApplicationTicketIdentity): Promise<void> {
  const record = await loadApplicationWorkerIfPresent(root, identity);
  if (record === undefined) return;
  if (record.metadata.runtime !== undefined) throw new Error("Application Worker runtime must be finalized before it is forgotten");
  await rm(applicationWorkerRecordPath(root, identity), { force: true });
}
export async function cleanupApplicationWorker(root: string, identity: ApplicationTicketIdentity): Promise<void> {
  await finalizeApplicationWorker(root, identity);
  await forgetFinalizedApplicationWorker(root, identity);
}

/** Local test/automation dispatcher. It has a distinct Application identity and never touches Change runtime paths. */
export async function dispatchApplicationPiTicket(input: ApplicationTicketIdentity & { cwd: string; worker: string; piExecutable?: string; clock?: () => Date }) {
  const repository = await discoverRepository(input.cwd), ticket = await loadApplicationTicket(repository.root, input.goalId, input.applicationId, input.ticketId);
  const extension = join(import.meta.dir, "pi-worker-extension.ts");
  return dispatchApplicationWorker({ ...input, command: [input.piExecutable ?? "pi", "--print", "--no-session", "--no-approve", "--model", ticket.metadata.model, "--thinking", ticket.metadata.thinking, "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,bash,edit,write,spike_complete_implementation,spike_block_implementation", "Execute the attached immutable Application implementation Ticket in this exact checkout. Finish with spike_complete_implementation, or use spike_block_implementation only when blocked." ] });
}

export async function dispatchApplicationWorker(input: ApplicationTicketIdentity & { cwd: string; command: string[]; worker: string; clock?: () => Date }): Promise<{ root: string; exchange: Awaited<ReturnType<typeof prepareApplicationTicketExchange>>; execution: ApplicationWorkerExecution }> {
  if (input.command.length === 0) throw new Error("Application Worker command must not be empty");
  const repository = await discoverRepository(input.cwd), ticket = await loadApplicationTicket(repository.root, input.goalId, input.applicationId, input.ticketId);
  // local-clone is the configured adapter contract in this runtime. Isolation
  // is carried through unchanged for both workspace and container Tickets.
  const exchange = await prepareApplicationTicketExchange(repository.root, input), workspace = await mkdtemp(join(tmpdir(), "spike-application-worker-")), checkout = join(workspace, "repository"), startedAt = (input.clock ?? (() => new Date()))().toISOString();
  if (await loadApplicationWorkerIfPresent(repository.root, input) !== undefined) throw new Error("Application Worker already has a runtime record");
  const metadata = recordSchema.parse({ kind: "application-worker", goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, adapter: "local-clone", isolation: ticket.metadata.executionPolicy.isolation, worker: input.worker, model: ticket.metadata.model, thinking: ticket.metadata.thinking, startedAt, runtime: { workspace } });
  let record: ApplicationWorkerRecord = { metadata, body: "# Application Worker runtime\n" };
  await installImmutable(repository.root, applicationWorkerRecordPath(repository.root, input), serializeDocument(metadata, record.body));
  try {
    await git(workspace, ["clone", "--quiet", "--no-checkout", join(exchange.inputDirectory, "repository.bundle"), checkout]);
    // Bundles intentionally advertise only identity-qualified custom refs;
    // clone does not install those refs. Import exactly the declared heads
    // before resolving the pinned input revision.
    const heads = (await git(repository.root, ["bundle", "list-heads", join(exchange.inputDirectory, "repository.bundle")]))
      .split("\n").filter(Boolean).map((line) => line.split(/\s+/, 2));
    const prefix = `refs/spike/application-input/${input.goalId}/${input.applicationId}/${input.ticketId}/`;
    if (heads.length !== 4 || heads.some(([hash, ref]) => !hash || !ref?.startsWith(prefix))) throw new Error("Application input bundle does not expose exactly the declared refs");
    for (const [, ref] of heads) await git(checkout, ["fetch", "--quiet", "--no-tags", join(exchange.inputDirectory, "repository.bundle"), `${ref}:${ref}`]);
    if (!heads.some(([hash]) => hash === ticket.metadata.inputRevision)) throw new Error("Application input bundle does not expose the pinned input revision");
    await git(checkout, ["checkout", "--quiet", "--detach", ticket.metadata.inputRevision]);
    const child = Bun.spawn(input.command, { cwd: checkout, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, SPIKE_INPUT_DIR: exchange.inputDirectory, SPIKE_OUTPUT_DIR: exchange.outputDirectory, SPIKE_INPUT_REVISION: ticket.metadata.inputRevision, SPIKE_GOAL_ID: input.goalId, SPIKE_APPLICATION_ID: input.applicationId, SPIKE_TICKET_ID: input.ticketId, SPIKE_TICKET_ROLE: "implement", SPIKE_MODEL: ticket.metadata.model, SPIKE_THINKING: ticket.metadata.thinking } });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    record = { metadata: recordSchema.parse({ ...record.metadata, finishedAt: (input.clock ?? (() => new Date()))().toISOString(), exitCode }), body: `# Application Worker runtime\n\n## stdout\n\n${stdout}\n\n## stderr\n\n${stderr}\n` }; await replaceRecord(repository.root, record);
    return { root: repository.root, exchange, execution: { ...execution(record), stdout, stderr } };
  } catch (error) { await cleanupApplicationWorker(repository.root, input).catch(() => undefined); throw error; }
}
