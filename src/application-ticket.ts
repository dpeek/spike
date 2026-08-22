import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { applicationPath, loadApplication, loadApplicationResolutionIfPresent, queuedApplicationHead } from "./application.ts";
import { resolveTicketAssignment, type ThinkingLevel } from "./config.ts";
import { documentExists, ensureWorkflowDirectory, installImmutable, listDirectoryNames, readDocument, serializeDocument } from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { loadGuidance } from "./guidance.ts";
import { goalIdPattern, sequenceIdPattern } from "./identity.ts";
import { projectRoot } from "./project.ts";

const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const policy = z.object({ isolation: z.enum(["workspace", "container"]), networkAccess: z.enum(["none", "restricted", "unrestricted"]), credentialGrants: z.array(z.string().min(1)) }).strict();
export const applicationTicketSchema = z.object({
  kind: z.literal("application-ticket"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), ticketId: z.string().regex(sequenceIdPattern),
  issuedAt: timestamp, role: z.literal("implement"), targetRevision: revision, goalRevision: revision, mergeBase: revision,
  inputRevision: revision, integration: z.object({ classification: z.enum(["clean", "conflict"]), cleanTree: revision.optional(), conflictEvidence: z.string().trim().min(1).optional() }).strict(),
  model: z.string().trim().min(1), thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]), executionPolicy: policy,
  guidance: z.object({ step: z.literal("implement"), revision }).strict(), replacesTicketId: z.string().regex(sequenceIdPattern).optional(), responseToReviewTicketId: z.string().regex(sequenceIdPattern).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.integration.classification === "clean" && value.integration.cleanTree === undefined) ctx.addIssue({ code: "custom", message: "clean integration requires cleanTree" });
  if (value.integration.classification === "conflict" && value.integration.conflictEvidence === undefined) ctx.addIssue({ code: "custom", message: "conflict integration requires conflictEvidence" });
});
export const applicationReportSchema = z.object({
  kind: z.literal("application-report"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), ticketId: z.string().regex(sequenceIdPattern),
  role: z.literal("implement"), outcome: z.enum(["completed", "blocked", "partial", "interrupted"]), publishedAt: timestamp,
  targetRevision: revision, goalRevision: revision, mergeBase: revision, integrationClassification: z.enum(["clean", "conflict"]),
  inputRevision: revision, workerRevision: revision.optional(), candidateRevision: revision.optional(), artifacts: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() }).strict()),
  execution: z.object({ adapter: z.string().trim().min(1), isolation: z.enum(["workspace", "container"]), worker: z.string().trim().min(1), model: z.string().trim().min(1), thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]), startedAt: timestamp, finishedAt: timestamp }).strict(),
}).strict().superRefine((value, ctx) => { if (value.outcome === "completed" && (value.workerRevision === undefined || value.candidateRevision === undefined)) ctx.addIssue({ code: "custom", message: "completed Application Report requires worker and Candidate revisions" }); if (value.outcome !== "completed" && (value.workerRevision !== undefined || value.candidateRevision !== undefined)) ctx.addIssue({ code: "custom", message: "terminal Application Report must not contain Candidate revisions" }); });
export type ApplicationTicket = { metadata: z.infer<typeof applicationTicketSchema>; body: string };
export type ApplicationReport = { metadata: z.infer<typeof applicationReportSchema>; body: string };
export type ApplicationTicketIdentity = { goalId: string; applicationId: string; ticketId: string };

function applicationDirectory(root: string, goalId: string, applicationId: string) { return dirname(applicationPath(root, goalId, applicationId)); }
function ticketsDirectory(root: string, goalId: string, applicationId: string) { return join(applicationDirectory(root, goalId, applicationId), "tickets"); }
export function applicationTicketPath(root: string, goalId: string, applicationId: string, ticketId: string) { return join(ticketsDirectory(root, goalId, applicationId), ticketId, "ticket.md"); }
export function applicationReportPath(root: string, goalId: string, applicationId: string, ticketId: string) { return join(ticketsDirectory(root, goalId, applicationId), ticketId, "report.md"); }
export function applicationCandidateRef(goalId: string, applicationId: string, ticketId: string) { return `refs/spike/goals/${goalId}/applications/${applicationId}/tickets/${ticketId}`; }
export function applicationExchangePath(root: string, identity: ApplicationTicketIdentity) { return join(projectRoot(root), "exchange", "goals", identity.goalId, "applications", identity.applicationId, "tickets", identity.ticketId); }
function text(value: string, label: string) { const result = value.trim(); if (!result) throw new Error(`${label} must not be blank`); return result; }
function next(ids: string[]) { const high = ids.reduce((n, id) => Math.max(n, Number(id)), 0); if (high >= 999) throw new Error("Application Ticket ID sequence is exhausted"); return String(high + 1).padStart(3, "0"); }
async function ids(root: string, goalId: string, applicationId: string) { return (await listDirectoryNames(root, ticketsDirectory(root, goalId, applicationId))).filter((id) => sequenceIdPattern.test(id)).sort(); }
export async function loadApplicationTicketDocument(directory: string, path: string): Promise<ApplicationTicket> {
  const doc = await readDocument(directory, path); const metadata = applicationTicketSchema.parse(doc.metadata);
  return { metadata, body: doc.body };
}
export async function loadApplicationTicket(root: string, goalId: string, applicationId: string, ticketId: string): Promise<ApplicationTicket> {
  const doc = await loadApplicationTicketDocument(root, applicationTicketPath(root, goalId, applicationId, ticketId)); const metadata = doc.metadata;
  if (metadata.goalId !== goalId || metadata.applicationId !== applicationId || metadata.ticketId !== ticketId) throw new Error("Application Ticket document belongs to a different identity");
  return doc;
}
export async function listApplicationTicketIds(root: string, goalId: string, applicationId: string) { const result: string[] = []; for (const id of await ids(root, goalId, applicationId)) if (await documentExists(root, applicationTicketPath(root, goalId, applicationId, id))) { await loadApplicationTicket(root, goalId, applicationId, id); result.push(id); } return result; }
export async function loadApplicationReportIfPresent(root: string, goalId: string, applicationId: string, ticketId: string): Promise<ApplicationReport | undefined> {
  const path = applicationReportPath(root, goalId, applicationId, ticketId); if (!(await documentExists(root, path))) return undefined;
  const doc = await readDocument(root, path); const metadata = applicationReportSchema.parse(doc.metadata);
  if (metadata.goalId !== goalId || metadata.applicationId !== applicationId || metadata.ticketId !== ticketId) throw new Error("Application Report document belongs to a different identity");
  const ticket = await loadApplicationTicket(root, goalId, applicationId, ticketId);
  if (metadata.targetRevision !== ticket.metadata.targetRevision || metadata.goalRevision !== ticket.metadata.goalRevision || metadata.mergeBase !== ticket.metadata.mergeBase || metadata.inputRevision !== ticket.metadata.inputRevision || metadata.integrationClassification !== ticket.metadata.integration.classification) throw new Error("Application Report does not preserve Ticket provenance");
  if (metadata.execution.isolation !== ticket.metadata.executionPolicy.isolation || metadata.execution.model !== ticket.metadata.model || metadata.execution.thinking !== ticket.metadata.thinking) throw new Error("Application Report execution does not match Ticket selection");
  return { metadata, body: doc.body };
}
async function main(root: string) { return git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]); }
async function integration(root: string, base: string, target: string, goal: string): Promise<{ classification: "clean"; tree: string } | { classification: "conflict"; evidence: string }> {
  // Production Git supports --write-tree with two commits, not three
  // positional revisions. Verify B first, making this exact B/M/G merge.
  const bases = (await git(root, ["merge-base", "--all", target, goal])).split("\n").filter(Boolean);
  if (bases.length !== 1 || bases[0] !== base) throw new Error("Git could not establish the exact three-way merge base");
  // Unlike read-tree -m, merge-tree performs recursive content merging and
  // handles non-overlapping edits in the same file.
  const child = Bun.spawn(["git", "-C", root, "merge-tree", "--write-tree", target, goal], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdoutRaw, stderrRaw] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const stdout = stdoutRaw.trim(), stderr = stderrRaw.trim();
  if (code === 0 && revision.safeParse(stdout).success) return { classification: "clean", tree: stdout };
  if (code === 1) return { classification: "conflict", evidence: `${stderr}\n${stdout}`.trim().slice(0, 32 * 1024) || "Git reported a three-way integration conflict." };
  throw new Error(`Git could not calculate exact three-way integration: ${(stderr || stdout).slice(0, 32 * 1024)}`);
}
const maximumRemediationReviewContextBytes = 64 * 1024;

/** A response is authorized by one immutable review Report, not a summary of it. */
function canonicalRemediationReviewContext(report: { metadata: Record<string, unknown>; body: string }): string {
  const serialized = serializeDocument(report.metadata, report.body);
  if (Buffer.byteLength(serialized, "utf8") > maximumRemediationReviewContextBytes) {
    throw new Error(`Application remediation response review Report exceeds the ${maximumRemediationReviewContextBytes}-byte context limit`);
  }
  return serialized;
}

function body(ticket: z.infer<typeof applicationTicketSchema>, instruction: string, guidance: string) {
  return `# Implement Application Candidate\n\n## Instruction\n\n${instruction}\n\n## Pinned provenance\n\nTarget main M: \`${ticket.targetRevision}\`\n\nGoal G: \`${ticket.goalRevision}\`\n\nMerge base B: \`${ticket.mergeBase}\`\n\nIntegration: \`${ticket.integration.classification}\`\n\n${ticket.integration.conflictEvidence === undefined ? "" : `### Conflict evidence\n\n${ticket.integration.conflictEvidence}\n\n`}## Workflow guidance\n\nSelected \`${ticket.guidance.step}\` guidance from exact target M \`${ticket.guidance.revision}\`.\n\n${guidance.trimEnd()}\n`;
}
export type IssueApplicationTicketInput = ApplicationTicketIdentity & { cwd: string; instruction: string; executionPolicy?: Partial<z.infer<typeof policy>>; model?: string; thinking?: ThinkingLevel; now?: Date };
/** Supervisor-only issuance for the exact diverged FIFO head. No Application Ticket may ever repin M/G/B. */
export async function issueApplicationTicket(input: Omit<IssueApplicationTicketInput, "ticketId">): Promise<{ root: string; ticket: ApplicationTicket }> {
  const repository = await discoverRepository(input.cwd);
  // Every refusal below precedes assignment, guidance loading, input-commit
  // creation, and the sole durable Ticket write.
  const head = await queuedApplicationHead(repository.root);
  if (head === undefined || head.metadata.goalId !== input.goalId || head.metadata.applicationId !== input.applicationId || head.decision !== undefined || head.invalidDecision) throw new Error("Application Ticket issuance requires the exact unresolved FIFO head");
  const application = await loadApplication(repository.root, input.goalId, input.applicationId);
  const existingIds = await listApplicationTicketIds(repository.root, input.goalId, input.applicationId);
  for (const id of existingIds) if ((await loadApplicationReportIfPresent(repository.root, input.goalId, input.applicationId, id)) === undefined) throw new Error(`Application ${input.goalId}/${input.applicationId} already has open Ticket ${id}`);
  const warnings = await applicationCleanupWarnings(repository.root, input.goalId, input.applicationId); if (warnings.length) throw new Error(`Application issuance blocked by cleanup health: ${warnings.join("; ")}`);
  const currentMain = await main(repository.root);
  const first = existingIds.length === 0 ? undefined : await loadApplicationTicket(repository.root, input.goalId, input.applicationId, existingIds[0]!);
  const targetRevision = first?.metadata.targetRevision ?? currentMain;
  const goalRevision = first?.metadata.goalRevision ?? application.metadata.integratedRevision;
  if (currentMain !== targetRevision) throw new Error(`Application target mismatch: main is ${currentMain}, pinned target is ${targetRevision}`);

  const reviews = await import("./application-review.ts");
  const reviewIds = await reviews.listApplicationReviewTicketIds(repository.root, input.goalId, input.applicationId);
  const reviewReports = await Promise.all(reviewIds.map(id => reviews.loadApplicationReviewReportIfPresent(repository.root, input.goalId, input.applicationId, id)));
  if (reviewReports.some(report => report === undefined)) throw new Error("Application remediation requires every prior review Ticket to be reported");
  const highest = reviewReports.filter(Boolean).at(-1);
  const latestCandidate = await (async () => {
    for (const id of [...existingIds].reverse()) {
      const report = await loadApplicationReportIfPresent(repository.root, input.goalId, input.applicationId, id);
      if (report?.metadata.outcome === "completed" && report.metadata.candidateRevision) return { ticketId: id, revision: report.metadata.candidateRevision };
    }
    return undefined;
  })();
  const remediation = highest?.metadata.outcome === "completed" && highest.metadata.verdict === "remediate";
  // Validate the complete canonical authorizing Report before any operation
  // that can create Ticket/runtime/exchange state (including an input commit).
  // A response must never receive a silently shortened authorization context.
  const responseReviewContext = remediation ? canonicalRemediationReviewContext(highest!) : undefined;
  if (remediation) {
    if (!latestCandidate || highest.metadata.candidateRevision !== latestCandidate.revision || highest.metadata.producingImplementationTicketId !== latestCandidate.ticketId) throw new Error("Application remediation requires the highest remediate review for the exact current Candidate and producer");
    for (const ticketId of existingIds) {
      const ticket = await loadApplicationTicket(repository.root, input.goalId, input.applicationId, ticketId);
      if (ticket.metadata.responseToReviewTicketId === highest.metadata.ticketId) throw new Error("Application review already authorizes a remediation response");
    }
  } else if (first !== undefined) {
    throw new Error("Application Ticket issuance requires the highest exact review verdict to be remediate");
  } else {
    const goal = await (await import("./goal.ts")).loadGoal(repository.root, input.goalId);
    if (targetRevision === goal.metadata.repository.initialRevision) throw new Error("Application Ticket issuance requires main to differ from the Goal base");
  }

  await git(repository.root, ["rev-parse", "--verify", `${goalRevision}^{commit}`]);
  const mergeBase = first?.metadata.mergeBase ?? await git(repository.root, ["merge-base", targetRevision, goalRevision]);
  const result = remediation ? undefined : await integration(repository.root, mergeBase, targetRevision, goalRevision);
  const inputRevision = remediation ? latestCandidate!.revision : result!.classification === "clean" ? await git(repository.root, ["commit-tree", result!.tree, "-p", targetRevision, "-m", "Spike Application integration input"]) : targetRevision;
  const assignment = await resolveTicketAssignment(repository.root, "implement", { ...(input.model === undefined ? {} : { model: input.model }), ...(input.thinking === undefined ? {} : { thinking: input.thinking }), ...(input.executionPolicy?.isolation === undefined ? {} : { isolation: input.executionPolicy.isolation }), ...(input.executionPolicy?.networkAccess === undefined ? {} : { networkAccess: input.executionPolicy.networkAccess }), ...(input.executionPolicy?.credentialGrants === undefined ? {} : { credentialGrants: input.executionPolicy.credentialGrants }) });
  const guidance = await loadGuidance(repository.root, "implement", targetRevision);
  const ticketId = next(await ids(repository.root, input.goalId, input.applicationId));
  const metadata = applicationTicketSchema.parse({ kind: "application-ticket", goalId: input.goalId, applicationId: input.applicationId, ticketId, issuedAt: (input.now ?? new Date()).toISOString(), role: "implement", targetRevision, goalRevision, mergeBase, inputRevision, integration: remediation ? { classification: "clean", cleanTree: await git(repository.root, ["rev-parse", "--verify", `${inputRevision}^{tree}`]) } : result!.classification === "clean" ? { classification: "clean", cleanTree: result!.tree } : { classification: "conflict", conflictEvidence: result!.evidence }, model: assignment.model, thinking: assignment.thinking, executionPolicy: { isolation: assignment.isolation, networkAccess: assignment.networkAccess, credentialGrants: assignment.credentialGrants }, guidance: { step: "implement", revision: targetRevision }, ...(remediation ? { replacesTicketId: latestCandidate!.ticketId, responseToReviewTicketId: highest!.metadata.ticketId } : {}) });
  let document = body(metadata, text(input.instruction, "Application Ticket instruction"), guidance.markdown);
  if (remediation) {
    const goal = await (await import("./goal.ts")).loadGoal(repository.root, input.goalId);
    const report = highest!;
    document += `\n## Remediation response contract\n\nRespond only to exact review Ticket \`${report.metadata.ticketId}\` for Candidate \`${latestCandidate!.revision}\` produced by implementation Ticket \`${latestCandidate!.ticketId}\`. Replace that Candidate through one normalized sole-parent-M Candidate; do not mutate main, Goal refs, or the host worktree. A fresh exact review is required after publication.\n\n## Exact response review Report\n\n${responseReviewContext}\n## Goal outcome and constraints\n\n${goal.body.slice(0, 32768)}\n`;
  }
  await installImmutable(repository.root, applicationTicketPath(repository.root, input.goalId, input.applicationId, ticketId), serializeDocument(metadata, document));
  return { root: repository.root, ticket: { metadata, body: document } };
}
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
export async function applicationCleanupWarnings(root: string, goalId: string, applicationId: string): Promise<string[]> {
  const warnings: string[] = [];
  for (const ticketId of await listApplicationTicketIds(root, goalId, applicationId)) {
    const exchange = applicationExchangePath(root, { goalId, applicationId, ticketId });
    const report = await loadApplicationReportIfPresent(root, goalId, applicationId, ticketId);
    if (await exists(exchange)) warnings.push(`Application exchange remains for Ticket ${ticketId}${report === undefined ? "" : " after Report publication"}`);
    const workerPath = join(projectRoot(root), "runtime", "application-workers", "goals", goalId, "applications", applicationId, "tickets", ticketId, "worker.md");
    if (await exists(workerPath)) {
      try { await (await import("./application-worker.ts")).loadApplicationWorkerIfPresent(root, { goalId, applicationId, ticketId }); warnings.push(`Application Worker runtime remains for Ticket ${ticketId}`); }
      catch { warnings.push(`Application Worker runtime is missing or mismatched for Ticket ${ticketId}`); }
    }
    const ref = applicationCandidateRef(goalId, applicationId, ticketId);
    const retained = await git(root, ["show-ref", "--verify", "--quiet", ref]).then(() => true).catch(() => false);
    if (report?.metadata.outcome === "completed") {
      if (!retained || report.metadata.candidateRevision !== await git(root, ["rev-parse", ref])) warnings.push(`Application retention ref for Ticket ${ticketId} is missing or mismatched`);
    } else if (retained) warnings.push(`Application retention ref for Ticket ${ticketId} is unreported or mismatched`);
  }
  const reviews = await import("./application-review.ts");
  for (const ticketId of await reviews.listApplicationReviewTicketIds(root, goalId, applicationId)) {
    const identity = { goalId, applicationId, ticketId };
    const exchange = reviews.applicationReviewExchangePath(root, identity);
    const report = await reviews.loadApplicationReviewReportIfPresent(root, goalId, applicationId, ticketId);
    if (await exists(exchange)) warnings.push(`Application review exchange remains for Ticket ${ticketId}${report === undefined ? "" : " after Report publication"}`);
    const workerPath = (await import("./application-review-worker.ts")).applicationReviewWorkerRecordPath(root, identity);
    if (await exists(workerPath)) {
      try { await (await import("./application-review-worker.ts")).loadApplicationReviewWorkerIfPresent(root, identity); warnings.push(`Application review Worker runtime remains for Ticket ${ticketId}`); }
      catch { warnings.push(`Application review Worker runtime is missing or mismatched for Ticket ${ticketId}`); }
    }
  }
  const quarantines = await git(root, ["for-each-ref", "--format=%(refname)", `refs/spike/quarantine/goals/${goalId}/applications/${applicationId}/`]);
  if (quarantines.trim()) warnings.push("Application quarantine refs remain");
  return warnings;
}
const maximumApplicationInputBundleBytes = 100 * 1024 * 1024;
async function applicationBundle(root: string, ticket: ApplicationTicket, path: string) {
  const suffix = randomUUID().replaceAll("-", ""); const prefix = `refs/spike/application-input/${ticket.metadata.goalId}/${ticket.metadata.applicationId}/${ticket.metadata.ticketId}/${suffix}`;
  const refs: Array<[string, string]> = [[`${prefix}/target`, ticket.metadata.targetRevision], [`${prefix}/goal`, ticket.metadata.goalRevision], [`${prefix}/base`, ticket.metadata.mergeBase], [`${prefix}/input`, ticket.metadata.inputRevision]];
  const temporary = `${path}.${suffix}.tmp`;
  try {
    for (const [ref, value] of refs) await git(root, ["update-ref", ref, value, "0".repeat(value.length)]);
    await git(root, ["bundle", "create", temporary, ...refs.map(([ref]) => ref)]);
    const stat = await lstat(temporary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumApplicationInputBundleBytes) throw new Error("Application input bundle exceeds its size limit");
    await git(root, ["bundle", "verify", temporary]);
    const heads = (await git(root, ["bundle", "list-heads", temporary])).split("\n").filter(Boolean).map((line) => line.split(/\s+/, 2));
    if (heads.length !== refs.length || refs.some(([ref, value]) => !heads.some(([head, name]) => head === value && name === ref))) throw new Error("Application input bundle does not contain exactly its declared refs");
    await chmod(temporary, 0o400); await rename(temporary, path);
  } finally { await Promise.all(refs.map(([ref]) => git(root, ["update-ref", "-d", ref]).catch(() => undefined))); await rm(temporary, { force: true }); }
}
export async function prepareApplicationTicketExchange(root: string, identity: ApplicationTicketIdentity) {
  const ticket = await loadApplicationTicket(root, identity.goalId, identity.applicationId, identity.ticketId); if ((await main(root)) !== ticket.metadata.targetRevision) throw new Error(`Application target mismatch: main differs from pinned target ${ticket.metadata.targetRevision}`); if (await loadApplicationReportIfPresent(root, identity.goalId, identity.applicationId, identity.ticketId)) throw new Error("Application Ticket is already reported");
  const exchange = applicationExchangePath(root, identity);
  const input = join(exchange, "input"), output = join(exchange, "output");
  // Preparation is a retryable operational projection. Dispatch can consume a
  // previously prepared, verified exchange.
  if (await exists(exchange)) {
    await regular(join(input, "ticket.md"), "Application Ticket exchange ticket", 256 * 1024);
    await regular(join(input, "context.md"), "Application Ticket exchange context", 256 * 1024);
    await regular(join(input, "repository.bundle"), "Application Ticket exchange bundle");
    await git(root, ["bundle", "verify", join(input, "repository.bundle")]);
    if (!(await exists(output))) throw new Error(`Application Ticket exchange output is missing: ${exchange}`);
    return { ...identity, inputDirectory: input, outputDirectory: output };
  }
  await ensureWorkflowDirectory(root, input);
  await installImmutable(root, join(input, "ticket.md"), serializeDocument(ticket.metadata, ticket.body));
  await installImmutable(root, join(input, "context.md"), serializeDocument({ kind: "application-ticket-context", ...identity, inputRevision: ticket.metadata.inputRevision, targetRevision: ticket.metadata.targetRevision, goalRevision: ticket.metadata.goalRevision, mergeBase: ticket.metadata.mergeBase, integration: ticket.metadata.integration.classification }, `# Application implementation worker context\n\nStart from exact \`${ticket.metadata.inputRevision}\`. The input bundle exposes only declared target M, Goal G, merge base B, and input refs. Worker output is untrusted; write artifacts only below \`SPIKE_OUTPUT_DIR/artifacts/\`. Complete through the exact Application Ticket worker completion surface; the completion payload contains non-blank summary, verification, assumptions, limitations, risks, follow-up, and declared artifacts. Do not create a Report or retention ref.\n`));
  await applicationBundle(root, ticket, join(input, "repository.bundle")); await Promise.all([chmod(join(input, "ticket.md"), 0o400), chmod(join(input, "context.md"), 0o400), chmod(input, 0o500)]); await ensureWorkflowDirectory(root, output);
  return { ...identity, inputDirectory: input, outputDirectory: output };
}

const artifactPath = z.string().refine((value) => value.startsWith("artifacts/") && !value.endsWith("/") && !value.includes("\\") && value.split("/").every((component) => component !== "" && component !== "." && component !== ".."), "artifact path must be a canonical relative path below artifacts/");
const artifact = z.object({ path: artifactPath, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const submission = z.discriminatedUnion("outcome", [
  z.object({ kind: z.literal("application-submission"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), ticketId: z.string().regex(sequenceIdPattern), outcome: z.literal("completed"), workerRevision: revision, artifacts: z.array(artifact) }).strict(),
  z.object({ kind: z.literal("application-submission"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), ticketId: z.string().regex(sequenceIdPattern), outcome: z.literal("blocked"), artifacts: z.array(artifact) }).strict(),
  z.object({ kind: z.literal("application-submission"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), ticketId: z.string().regex(sequenceIdPattern), outcome: z.literal("partial"), artifacts: z.array(artifact) }).strict(),
]);
async function regular(path: string, label: string, maximum = 100 * 1024 * 1024) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error(`${label} must be a bounded regular file`); return stat.size; }
async function validateOutput(output: string, declared: z.infer<typeof artifact>[]) {
  const allowed = new Set(["submission.md", "repository.bundle", ...declared.map((a) => a.path)]); const dirs = new Set<string>(); for (const a of declared) { const p = a.path.split("/"); for (let i = 1; i < p.length; i++) dirs.add(p.slice(0, i).join("/")); }
  async function visit(relative = ""): Promise<void> { for (const name of await readdir(relative ? join(output, relative) : output)) { const value = relative ? `${relative}/${name}` : name, stat = await lstat(join(output, value)); if (stat.isSymbolicLink()) throw new Error(`Application output contains symbolic link: ${value}`); if (stat.isDirectory()) { if (!dirs.has(value)) throw new Error(`unexpected Application output path: ${value}`); await visit(value); } else if (!stat.isFile() || !allowed.has(value)) throw new Error(`unexpected Application output path: ${value}`); } }
  await visit(); const seen = new Set<string>(); let total = 0; const artifacts = []; for (const item of declared) { if (seen.has(item.path)) throw new Error("Application Submission declares duplicate artifact path"); seen.add(item.path); const bytes = await regular(join(output, item.path), `artifact ${item.path}`, 16 * 1024 * 1024); total += bytes; if (total > 64 * 1024 * 1024) throw new Error("Application artifacts exceed total size limit"); if (createHash("sha256").update(await readFile(join(output, item.path))).digest("hex") !== item.sha256) throw new Error(`artifact digest does not match: ${item.path}`); artifacts.push({ ...item, bytes }); } return artifacts;
}
export type PublishApplicationReportInput = ApplicationTicketIdentity & { cwd: string; execution: { adapter: string; isolation: "workspace" | "container"; worker: string; model: string; thinking: z.infer<typeof applicationTicketSchema>["thinking"]; startedAt: string; finishedAt: string }; message: { summary: string; body?: string }; now?: Date };
export async function publishApplicationImplementationReport(input: PublishApplicationReportInput): Promise<{ root: string; report: ApplicationReport }> {
  const repository = await discoverRepository(input.cwd); const ticket = await loadApplicationTicket(repository.root, input.goalId, input.applicationId, input.ticketId); const path = applicationReportPath(repository.root, input.goalId, input.applicationId, input.ticketId);
  if ((await main(repository.root)) !== ticket.metadata.targetRevision) throw new Error(`Application target mismatch: main differs from pinned target ${ticket.metadata.targetRevision}`);
  if (await documentExists(repository.root, path)) throw new Error("immutable Application Report already exists");
  // Execution provenance is host-recorded runtime evidence, never caller
  // metadata. Require the exact successful execution for this identity.
  const recorded = await (await import("./application-worker.ts")).loadFinishedApplicationWorker(repository.root, input);
  if (recorded.exitCode !== 0) throw new Error("Application Worker did not complete successfully");
  const exactExecution = { adapter: recorded.adapter, isolation: recorded.isolation, worker: recorded.worker, model: recorded.model, thinking: recorded.thinking, startedAt: recorded.startedAt, finishedAt: recorded.finishedAt };
  if (input.execution.adapter !== exactExecution.adapter || input.execution.isolation !== exactExecution.isolation || input.execution.worker !== exactExecution.worker || input.execution.model !== exactExecution.model || input.execution.thinking !== exactExecution.thinking || input.execution.startedAt !== exactExecution.startedAt || input.execution.finishedAt !== exactExecution.finishedAt) throw new Error("Application execution is not the exact recorded Worker execution");
  if (recorded.model !== ticket.metadata.model || recorded.thinking !== ticket.metadata.thinking || recorded.isolation !== ticket.metadata.executionPolicy.isolation) throw new Error("Application execution does not match immutable Ticket selection");
  const output = join(applicationExchangePath(repository.root, input), "output"); const document = await readDocument(repository.root, join(output, "submission.md")); const accepted = submission.parse(document.metadata);
  if (accepted.goalId !== input.goalId || accepted.applicationId !== input.applicationId || accepted.ticketId !== input.ticketId) throw new Error("Application Submission belongs to a different Ticket");
  const artifacts = await validateOutput(output, accepted.artifacts);
  if (accepted.outcome !== "completed") {
    for (const heading of ["Reason", "Evidence"]) if (!new RegExp(`^## ${heading}\\s*$`, "m").test(document.body)) throw new Error(`${accepted.outcome} Application Submission is missing ${heading}`);
    const metadata = applicationReportSchema.parse({ kind: "application-report", goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, role: "implement", outcome: accepted.outcome, publishedAt: (input.now ?? new Date()).toISOString(), targetRevision: ticket.metadata.targetRevision, goalRevision: ticket.metadata.goalRevision, mergeBase: ticket.metadata.mergeBase, integrationClassification: ticket.metadata.integration.classification, inputRevision: ticket.metadata.inputRevision, artifacts, execution: exactExecution });
    await installImmutable(repository.root, path, serializeDocument(metadata, document.body));
    await (await import("./application-worker.ts")).cleanupApplicationWorker(repository.root, input).catch(() => undefined);
    return { root: repository.root, report: { metadata, body: document.body } };
  }
  for (const heading of ["Summary", "Verification", "Assumptions", "Limitations", "Risks", "Follow-up"]) if (!new RegExp(`^## ${heading}\\s*$`, "m").test(document.body)) throw new Error(`Application Submission is missing ${heading}`);
  const bundle = join(output, "repository.bundle"); await regular(bundle, "Application output bundle"); await git(repository.root, ["bundle", "verify", bundle]);
  const heads = await git(repository.root, ["bundle", "list-heads", bundle]); const advertised = heads.split("\n").map((line) => line.split(/\s+/, 2)).find(([hash]) => hash === accepted.workerRevision)?.[1]; if (!advertised) throw new Error("Application output bundle does not advertise exact worker revision");
  const quarantine = `refs/spike/quarantine/goals/${input.goalId}/applications/${input.applicationId}/tickets/${input.ticketId}/${randomUUID()}`;
  try { await git(repository.root, ["fetch", "--quiet", "--no-tags", bundle, `${advertised}:${quarantine}`]); const worker = await git(repository.root, ["rev-parse", "--verify", `${quarantine}^{commit}`]); if (worker !== accepted.workerRevision) throw new Error("imported Application worker revision mismatches Submission"); const tree = await git(repository.root, ["rev-parse", "--verify", `${worker}^{tree}`]); const summary = text(input.message.summary, "Application Candidate summary"); if (summary.includes("\n")) throw new Error("Application Candidate summary must be one line"); const candidate = await git(repository.root, ["commit-tree", tree, "-p", ticket.metadata.targetRevision, "-m", `${summary}\n\nSpike-Goal-Id: ${input.goalId}`]); const metadata = applicationReportSchema.parse({ kind: "application-report", goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, role: "implement", outcome: "completed", publishedAt: (input.now ?? new Date()).toISOString(), targetRevision: ticket.metadata.targetRevision, goalRevision: ticket.metadata.goalRevision, mergeBase: ticket.metadata.mergeBase, integrationClassification: ticket.metadata.integration.classification, inputRevision: ticket.metadata.inputRevision, workerRevision: worker, candidateRevision: candidate, artifacts, execution: exactExecution });
    // Report installation is the Candidate commit point. Retention follows and is rebuildable.
    if ((await main(repository.root)) !== ticket.metadata.targetRevision) throw new Error(`Application target mismatch: main differs from pinned target ${ticket.metadata.targetRevision}`);
    const report = { metadata, body: document.body }; await installImmutable(repository.root, path, serializeDocument(metadata, document.body));
    await git(repository.root, ["update-ref", applicationCandidateRef(input.goalId, input.applicationId, input.ticketId), candidate, "0".repeat(candidate.length)]);
    // Runtime state is operational only. Forget it after its exact finished
    // execution has been durably recorded in the immutable Report.
    await (await import("./application-worker.ts")).cleanupApplicationWorker(repository.root, input).catch(() => undefined);
    return { root: repository.root, report };
  } finally { await git(repository.root, ["update-ref", "-d", quarantine]).catch(() => undefined); }
}
export async function publishApplicationPartialReport(input: ApplicationTicketIdentity & { cwd: string; execution: PublishApplicationReportInput["execution"]; reason: string; now?: Date }): Promise<{ root: string; report: ApplicationReport }> {
  const repository = await discoverRepository(input.cwd), ticket = await loadApplicationTicket(repository.root, input.goalId, input.applicationId, input.ticketId), path = applicationReportPath(repository.root, input.goalId, input.applicationId, input.ticketId);
  if ((await main(repository.root)) !== ticket.metadata.targetRevision) throw new Error(`Application target mismatch: main differs from pinned target ${ticket.metadata.targetRevision}`);
  if (await documentExists(repository.root, path)) throw new Error("immutable Application Report already exists");
  const reason = text(input.reason, "Partial reason");
  const recorded = await (await import("./application-worker.ts")).loadFinishedApplicationWorker(repository.root, input);
  const execution = { adapter: recorded.adapter, isolation: recorded.isolation, worker: recorded.worker, model: recorded.model, thinking: recorded.thinking, startedAt: recorded.startedAt, finishedAt: recorded.finishedAt };
  if (recorded.exitCode !== 0 || JSON.stringify(execution) !== JSON.stringify(input.execution)) throw new Error("Application partial publication requires the exact successful Worker execution");
  const metadata = applicationReportSchema.parse({ kind: "application-report", goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, role: "implement", outcome: "partial", publishedAt: (input.now ?? new Date()).toISOString(), targetRevision: ticket.metadata.targetRevision, goalRevision: ticket.metadata.goalRevision, mergeBase: ticket.metadata.mergeBase, integrationClassification: ticket.metadata.integration.classification, inputRevision: ticket.metadata.inputRevision, artifacts: [], execution });
  await installImmutable(repository.root, path, serializeDocument(metadata, `# Application Ticket partial\n\n## Reason\n\n${reason}\n`));
  await (await import("./application-worker.ts")).cleanupApplicationWorker(repository.root, input).catch(() => undefined);
  return { root: repository.root, report: { metadata, body: `# Application Ticket partial\n\n## Reason\n\n${reason}\n` } };
}
export type ApplicationChurnWarning = { kind: "remediation-rounds" | "reopened-finding" | "non-progress"; message: string };
export async function deriveApplicationChurn(root: string, goalId: string, applicationId: string): Promise<ApplicationChurnWarning[]> {
  const review = await import("./application-review.ts");
  const reviewReports = await Promise.all((await review.listApplicationReviewTicketIds(root, goalId, applicationId)).map(id => review.loadApplicationReviewReportIfPresent(root, goalId, applicationId, id)));
  const remediate = reviewReports.filter((report): report is NonNullable<typeof report> => report?.metadata.outcome === "completed" && report.metadata.verdict === "remediate");
  const warnings: ApplicationChurnWarning[] = [];
  if (remediate.length >= 2) warnings.push({ kind: "remediation-rounds", message: "two or more remediate review verdicts are recorded" });
  const seen = new Set<string>(); let reopened = false;
  for (const report of remediate) { for (const finding of report.metadata.findings) { if (seen.has(finding.id)) reopened = true; seen.add(finding.id); } }
  if (reopened) warnings.push({ kind: "reopened-finding", message: "a stable finding ID recurred in a later remediation review" });
  const reports = await Promise.all((await listApplicationTicketIds(root, goalId, applicationId)).map(id => loadApplicationReportIfPresent(root, goalId, applicationId, id)));
  for (let index = 1; index < reports.length; index++) if (["partial", "blocked"].includes(reports[index - 1]?.metadata.outcome ?? "") && ["partial", "blocked"].includes(reports[index]?.metadata.outcome ?? "")) { warnings.push({ kind: "non-progress", message: "two consecutive partial or blocked implementation Reports are recorded" }); break; }
  return warnings;
}
export async function deriveApplicationStatus(cwd: string, goalId: string, applicationId: string) { const repository = await discoverRepository(cwd); const application = await loadApplication(repository.root, goalId, applicationId); let resolution: "return" | "stale" | "malformed" | null = null; try { resolution = (await loadApplicationResolutionIfPresent(repository.root, goalId, applicationId))?.metadata.disposition ?? null; } catch { resolution = "malformed"; } const ticketIds = await listApplicationTicketIds(repository.root, goalId, applicationId); const reports = await Promise.all(ticketIds.map((ticketId) => loadApplicationReportIfPresent(repository.root, goalId, applicationId, ticketId))); const open = ticketIds.find((_id, i) => reports[i] === undefined) ?? null; const completed = reports.map((report, i) => ({ report, ticketId: ticketIds[i]! })).filter((value): value is { report: ApplicationReport; ticketId: string } => value.report?.metadata.outcome === "completed").at(-1); const pinned = ticketIds.length ? (await loadApplicationTicket(repository.root, goalId, applicationId, ticketIds[0]!)).metadata.targetRevision : null; let current: string | null = null; try { current = await main(repository.root); } catch { /* status remains inspectable */ } const review = await (await import("./application-review.ts")).deriveApplicationReviewStatus(cwd, goalId, applicationId); const worker = open === null ? null : await (await import("./application-worker.ts")).observeApplicationWorker(repository.root, { goalId, applicationId, ticketId: open }); return { goalId, applicationId, queuePosition: application.metadata.queuePosition, resolution, openTicketId: open, latestReport: reports.filter(Boolean).at(-1)?.metadata ?? null, candidate: completed === undefined ? null : { ticketId: completed.ticketId, revision: completed.report.metadata.candidateRevision }, pinnedTargetRevision: pinned, integrationClassification: ticketIds.length ? (await loadApplicationTicket(repository.root, goalId, applicationId, ticketIds[0]!)).metadata.integration.classification : null, targetMismatch: pinned !== null && current !== null && pinned !== current, cleanupWarnings: await applicationCleanupWarnings(repository.root, goalId, applicationId), churnWarnings: await deriveApplicationChurn(repository.root, goalId, applicationId), worker, review }; }
/** Retryable operational cleanup does not publish or rewrite any Application evidence. */
export async function cleanupApplicationTicketRuntime(cwd: string, goalId: string, applicationId: string, ticketId: string): Promise<{ root: string }> {
  const repository = await discoverRepository(cwd);
  await rm(applicationExchangePath(repository.root, { goalId, applicationId, ticketId }), { recursive: true, force: true });
  await (await import("./application-worker.ts")).cleanupApplicationWorker(repository.root, { goalId, applicationId, ticketId });
  const quarantines = await git(repository.root, ["for-each-ref", "--format=%(refname)", `refs/spike/quarantine/goals/${goalId}/applications/${applicationId}/tickets/${ticketId}/`]);
  for (const ref of quarantines.split("\n").filter(Boolean)) await git(repository.root, ["update-ref", "-d", ref]);
  return { root: repository.root };
}
export async function recoverApplicationTicket(cwd: string, goalId: string, applicationId: string, ticketId: string, reason = "Supervisor recovery interrupted the open Application Ticket.") {
  const repository = await discoverRepository(cwd);
  const ticket = await loadApplicationTicket(repository.root, goalId, applicationId, ticketId);
  const identity = { goalId, applicationId, ticketId };
  const path = applicationReportPath(repository.root, goalId, applicationId, ticketId);
  // Runtime is owned by the configured implementation adapter.  Stop and wait
  // before removing its workspace or recording an interruption; a late
  // dispatcher completion must not resurrect the operational record.
  const adapter = (await import("./application-worker.ts")).configuredApplicationAdapter;
  await adapter.stop(repository.root, identity);
  await adapter.finalize(repository.root, identity);
  await adapter.forget(repository.root, identity);
  // Target movement blocks production, never recovery: interruption evidence
  // and operational projections are independent of current main.
  if (!(await documentExists(repository.root, path))) {
    const metadata = applicationReportSchema.parse({ kind: "application-report", goalId, applicationId, ticketId, role: "implement", outcome: "interrupted", publishedAt: new Date().toISOString(), targetRevision: ticket.metadata.targetRevision, goalRevision: ticket.metadata.goalRevision, mergeBase: ticket.metadata.mergeBase, integrationClassification: ticket.metadata.integration.classification, inputRevision: ticket.metadata.inputRevision, artifacts: [], execution: { adapter: "configured-application-adapter", isolation: ticket.metadata.executionPolicy.isolation, worker: "interrupted", model: ticket.metadata.model, thinking: ticket.metadata.thinking, startedAt: ticket.metadata.issuedAt, finishedAt: new Date().toISOString() } });
    await installImmutable(repository.root, path, serializeDocument(metadata, `# Application Ticket interrupted\n\n${text(reason, "Interruption reason")}\n`));
  }
  await rm(applicationExchangePath(repository.root, identity), { recursive: true, force: true });
  // Retention is derived from Reports: clear an unreported ref left between
  // normalization and Report publication, then rebuild only reported objects.
  const prefix = `refs/spike/goals/${goalId}/applications/${applicationId}/`;
  const retained = await git(repository.root, ["for-each-ref", "--format=%(refname)", prefix]);
  for (const ref of retained.split("\n").filter(Boolean)) await git(repository.root, ["update-ref", "-d", ref]);
  const reports = await Promise.all((await listApplicationTicketIds(repository.root, goalId, applicationId)).map(async (id) => ({ id, report: await loadApplicationReportIfPresent(repository.root, goalId, applicationId, id) })));
  for (const { id, report } of reports) if (report?.metadata.outcome === "completed") await git(repository.root, ["update-ref", applicationCandidateRef(goalId, applicationId, id), report.metadata.candidateRevision!]);
  const quarantines = await git(repository.root, ["for-each-ref", "--format=%(refname)", `refs/spike/quarantine/goals/${goalId}/applications/${applicationId}/`]);
  for (const ref of quarantines.split("\n").filter(Boolean)) await git(repository.root, ["update-ref", "-d", ref]);
  return { root: repository.root };
}
