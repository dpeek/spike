import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { documentExists, installImmutable, readDocument, replaceAtomic, serializeDocument } from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import type { ProjectPaths } from "./project.ts";
import type { HostPaths } from "./data-root.ts";
import { loadApplicationTicket, prepareApplicationTicketExchange, type ApplicationTicketIdentity } from "./application-ticket.ts";

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const recordSchema = z.object({
  kind: z.literal("application-worker"), goalId: z.string().min(1), applicationId: z.string().min(1), ticketId: z.string().min(1),
  adapter: z.literal("local-clone"), isolation: z.enum(["workspace", "container"]), worker: z.string().trim().min(1), model: z.string().trim().min(1),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]), startedAt: timestamp, finishedAt: timestamp.optional(), exitCode: z.number().int().optional(),
  runtime: z.object({ workspace: z.string().min(1), pid: z.number().int().positive().optional() }).strict().optional(),
}).strict();
export type ApplicationWorkerExecution = ApplicationTicketIdentity & { adapter: "local-clone"; isolation: "workspace" | "container"; worker: string; model: string; thinking: z.infer<typeof recordSchema>["thinking"]; startedAt: string; finishedAt: string; exitCode: number; stdout: string; stderr: string };
export type ApplicationWorkerRecord = { metadata: z.infer<typeof recordSchema>; body: string };

export function applicationWorkerRecordPath(project: ProjectPaths, identity: ApplicationTicketIdentity): string {
  return join(project.controlRoot, "runtime", "application-workers", "goals", identity.goalId, "applications", identity.applicationId, "tickets", identity.ticketId, "worker.md");
}
export async function loadApplicationWorkerIfPresent(root: ProjectPaths, identity: ApplicationTicketIdentity): Promise<ApplicationWorkerRecord | undefined> {
  const path = applicationWorkerRecordPath(root, identity); if (!(await documentExists(root.controlRoot, path))) return undefined;
  const doc = await readDocument(root.controlRoot, path), metadata = recordSchema.parse(doc.metadata);
  if (metadata.goalId !== identity.goalId || metadata.applicationId !== identity.applicationId || metadata.ticketId !== identity.ticketId) throw new Error("Application Worker record belongs to a different Ticket");
  const ticket = await loadApplicationTicket(root, identity.goalId, identity.applicationId, identity.ticketId);
  if (metadata.isolation !== ticket.metadata.executionPolicy.isolation || metadata.model !== ticket.metadata.model || metadata.thinking !== ticket.metadata.thinking) throw new Error("Application Worker record does not match immutable Ticket selection");
  return { metadata, body: doc.body };
}
async function replaceRecord(root: ProjectPaths, record: ApplicationWorkerRecord) { await replaceAtomic(root.controlRoot, applicationWorkerRecordPath(root, record.metadata), serializeDocument(record.metadata, record.body)); }
function execution(record: ApplicationWorkerRecord): ApplicationWorkerExecution {
  if (record.metadata.finishedAt === undefined || record.metadata.exitCode === undefined) throw new Error(`Application Worker ${record.metadata.goalId}/${record.metadata.applicationId}/${record.metadata.ticketId} has not finished`);
  return { goalId: record.metadata.goalId, applicationId: record.metadata.applicationId, ticketId: record.metadata.ticketId, adapter: record.metadata.adapter, isolation: record.metadata.isolation, worker: record.metadata.worker, model: record.metadata.model, thinking: record.metadata.thinking, startedAt: record.metadata.startedAt, finishedAt: record.metadata.finishedAt, exitCode: record.metadata.exitCode, stdout: "", stderr: "" };
}
export async function observeApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity) {
  const record = await loadApplicationWorkerIfPresent(root, identity); return record === undefined ? { status: "unavailable" as const } : record.metadata.finishedAt === undefined ? { status: "working" as const } : { status: "done" as const };
}
export async function readApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity, maximumBytes = 64 * 1024): Promise<string> {
  const record = await loadApplicationWorkerIfPresent(root, identity); if (record === undefined) throw new Error("Application Worker has no runtime record");
  return record.body.slice(0, maximumBytes);
}
export async function loadFinishedApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity) { const record = await loadApplicationWorkerIfPresent(root, identity); if (record === undefined) throw new Error("Application Worker has no runtime record"); return execution(record); }

type ActiveApplicationWorker = { cancelled: boolean; settled: boolean; child?: ReturnType<typeof Bun.spawn>; terminal: Promise<void>; settle: () => void };
const activeApplicationWorkers = new Map<string, ActiveApplicationWorker>();
function applicationWorkerKey(root: ProjectPaths, identity: ApplicationTicketIdentity) { return `${root.controlRoot}\u0000${identity.goalId}\u0000${identity.applicationId}\u0000${identity.ticketId}`; }
function activeWorker(): ActiveApplicationWorker {
  let settle!: () => void;
  const terminal = new Promise<void>((resolve) => { settle = resolve; });
  return { cancelled: false, settled: false, terminal, settle };
}
function settleActiveWorker(active: ActiveApplicationWorker) { if (!active.settled) { active.settled = true; active.settle(); } }
async function waitForStoppedProcess(pid: number): Promise<void> {
  // A recovery process may not be the dispatcher process.  In that case the
  // PID recorded by this adapter is its ownership handle.  Do not release its
  // workspace until the child has actually gone away.
  for (let attempts = 0; attempts < 500; attempts++) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Application Worker ${pid} did not terminate after stop`);
}
/** Stop is adapter-owned and waits for the child terminal state before a
 * recovery caller can finalize its workspace. */
export async function stopApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity): Promise<void> {
  const record = await loadApplicationWorkerIfPresent(root, identity);
  const active = activeApplicationWorkers.get(applicationWorkerKey(root, identity));
  if (active) active.cancelled = true;
  const pid = active?.child?.pid ?? record?.metadata.runtime?.pid;
  if (pid !== undefined && record?.metadata.finishedAt === undefined) {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  if (active) await active.terminal;
  else if (pid !== undefined && record?.metadata.finishedAt === undefined) await waitForStoppedProcess(pid);
}
/** Finalization releases only an already stopped adapter-owned runtime. */
export async function finalizeApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity): Promise<void> {
  const record = await loadApplicationWorkerIfPresent(root, identity); if (record?.metadata.runtime === undefined) return;
  if (record.metadata.finishedAt === undefined && record.metadata.runtime.pid !== undefined) {
    // stopApplicationWorker is the only legal transition for a live process.
    try { process.kill(record.metadata.runtime.pid, 0); throw new Error("Application Worker must be stopped before finalization"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  await rm(record.metadata.runtime.workspace, { recursive: true, force: true });
  await replaceRecord(root, { ...record, metadata: recordSchema.parse({ ...record.metadata, runtime: undefined }) });
}
/** Forgetting is deliberately separate from finalization: a Report is the
 * durable execution evidence once publication has succeeded. */
export async function forgetFinalizedApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity): Promise<void> {
  const record = await loadApplicationWorkerIfPresent(root, identity);
  if (record === undefined) return;
  if (record.metadata.runtime !== undefined) throw new Error("Application Worker runtime must be finalized before it is forgotten");
  await rm(applicationWorkerRecordPath(root, identity), { force: true });
}
export async function cleanupApplicationWorker(root: ProjectPaths, identity: ApplicationTicketIdentity): Promise<void> {
  await stopApplicationWorker(root, identity);
  await finalizeApplicationWorker(root, identity);
  await forgetFinalizedApplicationWorker(root, identity);
}

/** Local test/automation dispatcher. It has a distinct Application identity and never touches Change runtime paths. */
export type ApplicationWorkerHostInput = {
  environment?: NodeJS.ProcessEnv;
  spikeExecutable?: string;
};

function applicationProtocolEnvironment(
  inherited: NodeJS.ProcessEnv,
  spikeExecutable: string,
  values: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...inherited, ...values, SPIKE_BIN: spikeExecutable };
}

export async function dispatchApplicationPiTicket(input: ApplicationTicketIdentity & { cwd: string; hostPaths: HostPaths; worker: string; piExecutable?: string; clock?: () => Date } & ApplicationWorkerHostInput) {
  const repository = await discoverRepository(input.cwd, input.hostPaths), ticket = await loadApplicationTicket(repository, input.goalId, input.applicationId, input.ticketId);
  const extension = join(import.meta.dir, "pi-worker-extension.ts");
  return dispatchApplicationWorker({ ...input, command: [input.piExecutable ?? "pi", "--print", "--no-session", "--no-approve", "--model", ticket.metadata.model, "--thinking", ticket.metadata.thinking, "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,bash,edit,write,spike_complete_implementation,spike_block_implementation", "Execute the attached immutable Application implementation Ticket in this exact checkout. Finish with spike_complete_implementation, or use spike_block_implementation only when blocked." ] });
}

export async function dispatchApplicationWorker(input: ApplicationTicketIdentity & { cwd: string; hostPaths: HostPaths; command: string[]; worker: string; clock?: () => Date } & ApplicationWorkerHostInput): Promise<{ root: string; exchange: Awaited<ReturnType<typeof prepareApplicationTicketExchange>>; execution: ApplicationWorkerExecution }> {
  if (input.command.length === 0) throw new Error("Application Worker command must not be empty");
  const repository = await discoverRepository(input.cwd, input.hostPaths), ticket = await loadApplicationTicket(repository, input.goalId, input.applicationId, input.ticketId);
  // local-clone is the configured adapter contract in this runtime. Isolation
  // is carried through unchanged for both workspace and container Tickets.
  const exchange = await prepareApplicationTicketExchange(repository, input), workspace = await mkdtemp(join(tmpdir(), "spike-application-worker-")), checkout = join(workspace, "repository"), startedAt = (input.clock ?? (() => new Date()))().toISOString();
  if (await loadApplicationWorkerIfPresent(repository, input) !== undefined) throw new Error("Application Worker already has a runtime record");
  const metadata = recordSchema.parse({ kind: "application-worker", goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, adapter: "local-clone", isolation: ticket.metadata.executionPolicy.isolation, worker: input.worker, model: ticket.metadata.model, thinking: ticket.metadata.thinking, startedAt, runtime: { workspace } });
  let record: ApplicationWorkerRecord = { metadata, body: "# Application Worker runtime\n" };
  const active = activeWorker(), key = applicationWorkerKey(repository, input);
  activeApplicationWorkers.set(key, active);
  await installImmutable(repository.controlRoot, applicationWorkerRecordPath(repository, input), serializeDocument(metadata, record.body));
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
    if (active.cancelled) throw new Error("Application Worker dispatch was interrupted");
    const child = Bun.spawn(input.command, { cwd: checkout, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: applicationProtocolEnvironment(input.environment ?? process.env, input.spikeExecutable ?? join(import.meta.dir, "..", "bin", "spike"), { SPIKE_INPUT_DIR: exchange.inputDirectory, SPIKE_OUTPUT_DIR: exchange.outputDirectory, SPIKE_INPUT_REVISION: ticket.metadata.inputRevision, SPIKE_GOAL_ID: input.goalId, SPIKE_APPLICATION_ID: input.applicationId, SPIKE_TICKET_ID: input.ticketId, SPIKE_TICKET_ROLE: "implement", SPIKE_MODEL: ticket.metadata.model, SPIKE_THINKING: ticket.metadata.thinking }) });
    active.child = child;
    record = { ...record, metadata: recordSchema.parse({ ...record.metadata, runtime: { workspace, pid: child.pid } }) };
    await replaceRecord(repository, record);
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    settleActiveWorker(active);
    // Recovery may have removed the runtime record while this dispatcher was
    // awaiting its child.  Never recreate it with a late completion update.
    if (active.cancelled || await loadApplicationWorkerIfPresent(repository, input) === undefined) throw new Error("Application Worker dispatch was interrupted");
    record = { metadata: recordSchema.parse({ ...record.metadata, finishedAt: (input.clock ?? (() => new Date()))().toISOString(), exitCode }), body: `# Application Worker runtime\n\n## stdout\n\n${stdout}\n\n## stderr\n\n${stderr}\n` };
    await replaceRecord(repository, record);
    return { root: repository.root, exchange, execution: { ...execution(record), stdout, stderr } };
  } catch (error) {
    // If setup failed after spawn, make the adapter's terminal promise mean
    // process termination too; recovery must never finalize a live child.
    if (active.child && !active.settled) {
      active.cancelled = true;
      try { process.kill(active.child.pid, "SIGTERM"); } catch (stopError) { if ((stopError as NodeJS.ErrnoException).code !== "ESRCH") throw stopError; }
      try { await active.child.exited; } finally { settleActiveWorker(active); }
    } else settleActiveWorker(active);
    await cleanupApplicationWorker(repository, input).catch(() => undefined);
    throw error;
  } finally { activeApplicationWorkers.delete(key); }
}

// Application review uses this same configured Application adapter seam.  The
// review role has a different immutable Ticket/exchange shape, but it does not
// get a second clone/process lifecycle.
const reviewRecordSchema = z.object({
  kind: z.literal("application-review-worker"), goalId: z.string().min(1), applicationId: z.string().min(1), ticketId: z.string().min(1),
  adapter: z.literal("local-clone"), isolation: z.enum(["workspace", "container"]), worker: z.string().trim().min(1), model: z.string().trim().min(1),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]), startedAt: timestamp, finishedAt: timestamp.optional(), exitCode: z.number().int().optional(),
  runtime: z.object({ workspace: z.string().min(1), pid: z.number().int().positive().optional() }).strict().optional(),
}).strict();
export type ApplicationReviewWorkerRecord = { metadata: z.infer<typeof reviewRecordSchema>; body: string };
export type ApplicationReviewWorkerIdentity = { goalId: string; applicationId: string; ticketId: string };
export type ApplicationReviewWorkerExecution = ApplicationReviewWorkerIdentity & { adapter: "local-clone"; isolation: "workspace" | "container"; worker: string; model: string; thinking: z.infer<typeof reviewRecordSchema>["thinking"]; startedAt: string; finishedAt: string; exitCode: number; stdout: string; stderr: string };

export function applicationReviewWorkerRecordPath(project: ProjectPaths, identity: ApplicationReviewWorkerIdentity): string {
  return join(project.controlRoot, "runtime", "application-review-workers", "goals", identity.goalId, "applications", identity.applicationId, "reviews", identity.ticketId, "worker.md");
}
async function reviewTicket(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity) {
  return (await import("./application-review.ts")).loadApplicationReviewTicket(root, identity.goalId, identity.applicationId, identity.ticketId);
}
export async function loadApplicationReviewWorkerIfPresent(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity): Promise<ApplicationReviewWorkerRecord | undefined> {
  const path = applicationReviewWorkerRecordPath(root, identity);
  if (!(await documentExists(root.controlRoot, path))) return undefined;
  const document = await readDocument(root.controlRoot, path), metadata = reviewRecordSchema.parse(document.metadata);
  if (metadata.goalId !== identity.goalId || metadata.applicationId !== identity.applicationId || metadata.ticketId !== identity.ticketId) throw new Error("Application review Worker record belongs to a different Ticket");
  const ticket = await reviewTicket(root, identity);
  if (metadata.isolation !== ticket.metadata.executionPolicy.isolation || metadata.model !== ticket.metadata.model || metadata.thinking !== ticket.metadata.thinking) throw new Error("Application review Worker record does not match immutable Ticket selection");
  return { metadata, body: document.body };
}
async function replaceReviewRecord(root: ProjectPaths, record: ApplicationReviewWorkerRecord) {
  await replaceAtomic(root.controlRoot, applicationReviewWorkerRecordPath(root, record.metadata), serializeDocument(record.metadata, record.body));
}
function reviewExecution(record: ApplicationReviewWorkerRecord): ApplicationReviewWorkerExecution {
  if (record.metadata.finishedAt === undefined || record.metadata.exitCode === undefined) throw new Error("Application review Worker has not finished");
  return { goalId: record.metadata.goalId, applicationId: record.metadata.applicationId, ticketId: record.metadata.ticketId, adapter: record.metadata.adapter, isolation: record.metadata.isolation, worker: record.metadata.worker, model: record.metadata.model, thinking: record.metadata.thinking, startedAt: record.metadata.startedAt, finishedAt: record.metadata.finishedAt, exitCode: record.metadata.exitCode, stdout: "", stderr: "" };
}
export async function observeApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity) {
  const record = await loadApplicationReviewWorkerIfPresent(root, identity);
  return record === undefined ? { status: "unavailable" as const } : record.metadata.finishedAt === undefined ? { status: "working" as const } : { status: "done" as const };
}
export async function readApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity, maximumBytes = 64 * 1024): Promise<string> {
  const record = await loadApplicationReviewWorkerIfPresent(root, identity); if (!record) throw new Error("Application review Worker has no runtime record"); return record.body.slice(0, maximumBytes);
}
export async function loadFinishedApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity) {
  const record = await loadApplicationReviewWorkerIfPresent(root, identity); if (!record) throw new Error("Application review Worker has no runtime record"); return reviewExecution(record);
}
/** Ask the selected adapter-owned process to stop before finalization removes its workspace. */
export async function stopApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity): Promise<void> {
  const record = await loadApplicationReviewWorkerIfPresent(root, identity);
  const pid = record?.metadata.runtime?.pid;
  if (pid !== undefined && record?.metadata.finishedAt === undefined) {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}
export async function finalizeApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity): Promise<void> {
  const record = await loadApplicationReviewWorkerIfPresent(root, identity);
  if (!record?.metadata.runtime) return;
  await rm(record.metadata.runtime.workspace, { recursive: true, force: true });
  await replaceReviewRecord(root, { ...record, metadata: reviewRecordSchema.parse({ ...record.metadata, runtime: undefined }) });
}
export async function forgetFinalizedApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity): Promise<void> {
  const record = await loadApplicationReviewWorkerIfPresent(root, identity);
  if (!record) return;
  if (record.metadata.runtime !== undefined) throw new Error("Application review Worker runtime must be finalized before it is forgotten");
  await rm(applicationReviewWorkerRecordPath(root, identity), { force: true });
}
export async function cleanupApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewWorkerIdentity): Promise<void> {
  await stopApplicationReviewWorker(root, identity);
  await finalizeApplicationReviewWorker(root, identity);
  await forgetFinalizedApplicationReviewWorker(root, identity);
}
export async function dispatchApplicationReviewWorker(input: ApplicationReviewWorkerIdentity & { cwd: string; hostPaths: HostPaths; command: string[]; worker: string; clock?: () => Date } & ApplicationWorkerHostInput): Promise<{ root: string; exchange: { inputDirectory: string; outputDirectory: string }; execution: ApplicationReviewWorkerExecution }> {
  if (!input.command.length) throw new Error("Application review Worker command must not be empty");
  const repository = await discoverRepository(input.cwd, input.hostPaths), ticket = await reviewTicket(repository, input);
  const review = await import("./application-review.ts");
  const exchange = await review.prepareApplicationReviewExchange(repository, input), workspace = await mkdtemp(join(tmpdir(), "spike-application-review-worker-")), checkout = join(workspace, "repository"), startedAt = (input.clock ?? (() => new Date()))().toISOString();
  if (await loadApplicationReviewWorkerIfPresent(repository, input) !== undefined) throw new Error("Application review Worker already has a runtime record");
  let record: ApplicationReviewWorkerRecord = { metadata: reviewRecordSchema.parse({ kind: "application-review-worker", goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, worker: input.worker, adapter: "local-clone", isolation: ticket.metadata.executionPolicy.isolation, model: ticket.metadata.model, thinking: ticket.metadata.thinking, startedAt, runtime: { workspace } }), body: "# Application review Worker runtime\n" };
  await installImmutable(repository.controlRoot, applicationReviewWorkerRecordPath(repository, input), serializeDocument(record.metadata, record.body));
  try {
    await git(workspace, ["clone", "--quiet", "--no-checkout", join(exchange.inputDirectory, "repository.bundle"), checkout]);
    const heads = (await git(repository.root, ["bundle", "list-heads", join(exchange.inputDirectory, "repository.bundle")])).split("\n").filter(Boolean).map(line => line.split(/\s+/, 2));
    const prefix = `refs/spike/application-review-input/${input.goalId}/${input.applicationId}/${input.ticketId}`;
    if (heads.length !== 1 || !heads[0]![1]?.startsWith(prefix) || heads[0]![0] !== ticket.metadata.candidateRevision) throw new Error("Application review input bundle does not expose exact Candidate");
    await git(checkout, ["fetch", "--quiet", "--no-tags", join(exchange.inputDirectory, "repository.bundle"), `${heads[0]![1]}:${heads[0]![1]}`]);
    await git(checkout, ["checkout", "--quiet", "--detach", ticket.metadata.candidateRevision]);
    const child = Bun.spawn(input.command, { cwd: checkout, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: applicationProtocolEnvironment(input.environment ?? process.env, input.spikeExecutable ?? join(import.meta.dir, "..", "bin", "spike"), { SPIKE_INPUT_DIR: exchange.inputDirectory, SPIKE_OUTPUT_DIR: exchange.outputDirectory, SPIKE_INPUT_REVISION: ticket.metadata.candidateRevision, SPIKE_GOAL_ID: input.goalId, SPIKE_APPLICATION_ID: input.applicationId, SPIKE_TICKET_ID: input.ticketId, SPIKE_TICKET_ROLE: "review", SPIKE_MODEL: ticket.metadata.model, SPIKE_THINKING: ticket.metadata.thinking }) });
    record = { ...record, metadata: reviewRecordSchema.parse({ ...record.metadata, runtime: { workspace, pid: child.pid } }) }; await replaceReviewRecord(repository, record);
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    record = { metadata: reviewRecordSchema.parse({ ...record.metadata, finishedAt: (input.clock ?? (() => new Date()))().toISOString(), exitCode }), body: `# Application review Worker runtime\n\n## stdout\n\n${stdout}\n\n## stderr\n\n${stderr}\n` };
    await replaceReviewRecord(repository, record);
    return { root: repository.root, exchange, execution: { ...reviewExecution(record), stdout, stderr } };
  } catch (error) { await cleanupApplicationReviewWorker(repository, input).catch(() => undefined); throw error; }
}
export async function dispatchApplicationReviewPiTicket(input: ApplicationReviewWorkerIdentity & { cwd: string; hostPaths: HostPaths; worker: string; piExecutable?: string; clock?: () => Date } & ApplicationWorkerHostInput) {
  const repository = await discoverRepository(input.cwd, input.hostPaths), ticket = await reviewTicket(repository, input), extension = join(import.meta.dir, "pi-worker-extension.ts");
  return dispatchApplicationReviewWorker({ ...input, command: [input.piExecutable ?? "pi", "--print", "--no-session", "--no-approve", "--model", ticket.metadata.model, "--thinking", ticket.metadata.thinking, "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,bash,edit,write,spike_complete_review,spike_block_review", "Execute the attached immutable Application review Ticket in this exact checkout. Finish with spike_complete_review, or use spike_block_review only when blocked."] });
}
/** The configured Application adapter exposes role-specific lifecycle methods. */
export const configuredApplicationAdapter = { dispatch: dispatchApplicationWorker, observe: observeApplicationWorker, read: readApplicationWorker, loadFinished: loadFinishedApplicationWorker, stop: stopApplicationWorker, finalize: finalizeApplicationWorker, forget: forgetFinalizedApplicationWorker, review: { dispatch: dispatchApplicationReviewWorker, dispatchPi: dispatchApplicationReviewPiTicket, observe: observeApplicationReviewWorker, read: readApplicationReviewWorker, loadFinished: loadFinishedApplicationReviewWorker, stop: stopApplicationReviewWorker, finalize: finalizeApplicationReviewWorker, forget: forgetFinalizedApplicationReviewWorker } };
