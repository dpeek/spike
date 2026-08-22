import { join } from "node:path";
import { z } from "zod";
import { commitCrashHooks, type CrashInjector } from "./crash.ts";
import { documentExists, installImmutable, listDirectoryNames, readDocument, serializeDocument } from "./durable-state.ts";
import { git } from "./git.ts";
import { goalIdPattern, sequenceIdPattern } from "./identity.ts";
import { loadGoal } from "./goal.ts";
import { projectRoot } from "./project.ts";

const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const time = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const identity = z.object({ kind: z.literal("application"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), target: z.literal("main"), integratedRevision: revision, approval: z.string().trim().min(1), requestedAt: time, queuePosition: z.number().int().positive() }).strict();
const cleanDecisionSchema = z.object({ kind: z.literal("application-decision"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), candidateRevision: revision, expectedPreviousMainRevision: revision, resultingMainRevision: revision, decidedAt: time }).strict();
/** Reviewed intent is deliberately a different immutable document variant from
 * the historical clean-base decision. It contains every fact authorizing a
 * diverged Candidate rather than relying on a mutable status projection. */
const reviewedDecisionSchema = z.object({
  kind: z.literal("application-reviewed-apply-decision"),
  form: z.literal("reviewed-squash"),
  goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern),
  expectedPreviousMainRevision: revision, goalRevision: revision, mergeBase: revision,
  candidateRevision: revision, resultingMainRevision: revision,
  producingImplementationTicketId: z.string().regex(sequenceIdPattern),
  approvingReviewTicketId: z.string().regex(sequenceIdPattern),
  applicationApproval: z.string().trim().min(1), decidedAt: time,
}).strict();
const decisionSchema = z.union([cleanDecisionSchema, reviewedDecisionSchema]);
const resolutionIdentity = z.object({ kind: z.literal("application-resolution"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), expectedMainRevision: revision, goalRevision: revision, decidedAt: time }).strict();
const returnedResolutionSchema = resolutionIdentity.extend({ disposition: z.literal("return"), candidateRevision: revision, producingImplementationTicketId: z.string().regex(sequenceIdPattern), highestReviewTicketId: z.string().regex(sequenceIdPattern), statement: z.string().trim().min(1) }).strict();
// Stale provenance is deliberately all-or-nothing. A Candidate without its
// producer (or vice versa) cannot identify the evidence it purports to retain.
const staleResolutionWithoutCandidateSchema = resolutionIdentity.extend({ disposition: z.literal("stale"), observedMainRevision: revision }).strict();
const staleResolutionWithCandidateSchema = resolutionIdentity.extend({ disposition: z.literal("stale"), observedMainRevision: revision, candidateRevision: revision, producingImplementationTicketId: z.string().regex(sequenceIdPattern) }).strict();
const resolutionSchema = z.union([returnedResolutionSchema, staleResolutionWithoutCandidateSchema, staleResolutionWithCandidateSchema]);
export type Application = { metadata: z.infer<typeof identity>; body: string };
export type CleanApplicationDecision = { metadata: z.infer<typeof cleanDecisionSchema>; body: string };
export type ReviewedApplicationDecision = { metadata: z.infer<typeof reviewedDecisionSchema>; body: string };
export type ApplicationDecision = CleanApplicationDecision | ReviewedApplicationDecision;
export type ApplicationResolution = { metadata: z.infer<typeof resolutionSchema>; body: string };
export type QueuedApplication = Application & { decision?: ApplicationDecision; invalidDecision?: true };

function rootPath(root: string, goalId: string) { return join(projectRoot(root), "goals", goalId, "applications"); }
export function applicationPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "application.md"); }
export function applicationDecisionPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "decision.md"); }
export function applicationResolutionPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "resolution.md"); }
/** Allocated IDs include abandoned pre-publication directories and only burn IDs. */
export async function listApplicationIds(root: string, goalId: string): Promise<string[]> { return (await listDirectoryNames(root, rootPath(root, goalId))).filter((id) => sequenceIdPattern.test(id)).sort(); }
/** Only a published Application document is workflow evidence. */
export async function listPublishedApplicationIds(root: string, goalId: string): Promise<string[]> {
  const published: string[] = [];
  for (const id of await listApplicationIds(root, goalId)) {
    if (!(await documentExists(root, applicationPath(root, goalId, id)))) continue;
    // A partial, malformed, or mismatched document did not publish a valid
    // Application. Its directory still consumes this Goal-relative ID only.
    try { await loadApplication(root, goalId, id); }
    catch { continue; }
    published.push(id);
  }
  return published;
}
export async function loadApplication(root: string, goalId: string, applicationId: string): Promise<Application> {
  const doc = await readDocument(root, applicationPath(root, goalId, applicationId)); const metadata = identity.parse(doc.metadata);
  if (metadata.goalId !== goalId || metadata.applicationId !== applicationId) throw new Error("Application document belongs to a different Application");
  return { metadata, body: doc.body };
}
export async function loadApplicationDecisionIfPresent(root: string, goalId: string, applicationId: string): Promise<ApplicationDecision | undefined> {
  if (!(await documentExists(root, applicationDecisionPath(root, goalId, applicationId)))) return undefined;
  const doc = await readDocument(root, applicationDecisionPath(root, goalId, applicationId)); const metadata = decisionSchema.parse(doc.metadata);
  if (metadata.goalId !== goalId || metadata.applicationId !== applicationId) throw new Error("Application decision belongs to a different Application");
  return metadata.kind === "application-reviewed-apply-decision"
    ? { metadata: reviewedDecisionSchema.parse(metadata), body: doc.body }
    : { metadata: cleanDecisionSchema.parse(metadata), body: doc.body };
}
/** Resolution parsing is deliberately lazy: unrelated later evidence cannot
 * obstruct an earlier valid FIFO head. */
export async function loadApplicationResolutionIfPresent(root: string, goalId: string, applicationId: string): Promise<ApplicationResolution | undefined> {
  if (!(await documentExists(root, applicationResolutionPath(root, goalId, applicationId)))) return undefined;
  const doc = await readDocument(root, applicationResolutionPath(root, goalId, applicationId)); const metadata = resolutionSchema.parse(doc.metadata);
  if (metadata.goalId !== goalId || metadata.applicationId !== applicationId) throw new Error("Application resolution belongs to a different Application");
  const resolution = { metadata, body: doc.body };
  await validateApplicationResolution(root, goalId, applicationId, resolution);
  return resolution;
}
function next(ids: string[]) { const high = ids.reduce((n, id) => Math.max(n, Number(id)), 0); if (high >= 999) throw new Error("Application ID sequence is exhausted"); return String(high + 1).padStart(3, "0"); }
async function checkedOutMain(root: string) { const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); if (branch !== "main") throw new Error("apply refused: main must be the currently checked-out local branch"); }
async function main(root: string) { return git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]); }
function isReviewedDecision(decision: ApplicationDecision): decision is ReviewedApplicationDecision { return decision.metadata.kind === "application-reviewed-apply-decision"; }

/** All published Application documents are the authoritative Project FIFO. */
export async function listProjectApplications(root: string): Promise<QueuedApplication[]> {
  const goals = (await listDirectoryNames(root, join(projectRoot(root), "goals"))).filter((id) => goalIdPattern.test(id)).sort();
  const entries: QueuedApplication[] = [];
  for (const goalId of goals) for (const applicationId of await listPublishedApplicationIds(root, goalId)) {
    const application = await loadApplication(root, goalId, applicationId);
    try {
      const decision = await loadApplicationDecisionIfPresent(root, goalId, applicationId);
      entries.push({ ...application, ...(decision === undefined ? {} : { decision }) });
    } catch {
      // A decision file is immutable evidence too. Preserve an invalid one as
      // an inconsistent FIFO barrier instead of silently selecting later work.
      entries.push({ ...application, invalidDecision: true });
    }
  }
  entries.sort((left, right) => left.metadata.queuePosition - right.metadata.queuePosition);
  for (let index = 1; index < entries.length; index++) if (entries[index - 1]!.metadata.queuePosition === entries[index]!.metadata.queuePosition) throw new Error("Application queue has duplicate immutable positions");
  return entries;
}
/** Validate an Application's decision against the exact checked-out main projection. */
export async function applicationState(root: string, application: QueuedApplication): Promise<ApplicationEvidenceState> {
  if (application.invalidDecision === true) return "inconsistent";
  if (application.decision === undefined) return "incomplete";
  if (!(await validDecision(root, application, application.decision))) return "inconsistent";
  let current: string;
  try { current = await main(root); } catch { return "inconsistent"; }
  if (current === application.decision.metadata.resultingMainRevision) return "applied";
  if (current === application.decision.metadata.expectedPreviousMainRevision) return isReviewedDecision(application.decision) ? "decision-pending" : "incomplete";
  // After a reviewed CAS has reached C, a later FIFO squash necessarily makes
  // C an ancestor. Historical owners stay applied; only an unrelated target
  // movement while the owner is pending is a target mismatch.
  if (isReviewedDecision(application.decision) && await git(root, ["merge-base", "--is-ancestor", application.decision.metadata.resultingMainRevision, current]).then(() => true).catch(() => false)) return "applied";
  return isReviewedDecision(application.decision) ? "target-mismatch" : "inconsistent";
}

/** The first non-terminal entry is a barrier even when its decision is pending
 * target advancement or is invalid. Callers must never skip it. */
export async function queuedApplicationHead(root: string): Promise<QueuedApplication | undefined> {
  for (const application of await listProjectApplications(root)) {
    let resolution: ApplicationResolution | undefined;
    try { resolution = await loadApplicationResolutionIfPresent(root, application.metadata.goalId, application.metadata.applicationId); }
    catch { throw new Error(`Application ${application.metadata.goalId}/${application.metadata.applicationId} has malformed resolution evidence`); }
    // A valid terminal resolution removes precisely this attempt from FIFO.
    if (resolution !== undefined) continue;
    if ((await applicationState(root, application)) !== "applied") return application;
  }
  return undefined;
}

/** Return releases Goal planning immediately but only becomes requeue-eligible
 * after G advances. Stale and unresolved attempts always freeze. */
export async function goalApplicationFreeze(root: string, goalId: string): Promise<{ frozen: boolean; returnedRequeueEligible: boolean; stale: boolean }> {
  let latest: ApplicationResolution | undefined;
  for (const applicationId of await listPublishedApplicationIds(root, goalId)) {
    // Validate each reached historical boundary, but stop at an unresolved
    // owner exactly as FIFO selection does. A valid older stale result is
    // retained as history and is superseded by a later returned attempt.
    let resolution: ApplicationResolution | undefined;
    try { resolution = await loadApplicationResolutionIfPresent(root, goalId, applicationId); }
    catch { throw new Error(`Application ${goalId}/${applicationId} has malformed resolution evidence`); }
    if (resolution === undefined) return { frozen: true, returnedRequeueEligible: false, stale: false };
    latest = resolution;
  }
  if (latest === undefined) return { frozen: false, returnedRequeueEligible: false, stale: false };
  if (latest.metadata.disposition === "stale") return { frozen: true, returnedRequeueEligible: false, stale: true };
  const currentG = await git(root, ["rev-parse", "--verify", `refs/spike/goals/${goalId}/integrated^{commit}`]);
  return { frozen: false, returnedRequeueEligible: currentG !== latest.metadata.goalRevision, stale: false };
}
export async function applicationRequeueEligibility(root: string, goalId: string): Promise<"none" | "returned" | "stale"> {
  const ids = await listPublishedApplicationIds(root, goalId);
  if (ids.length === 0) return "none";
  const applicationId = ids.at(-1)!;
  const application = await loadApplication(root, goalId, applicationId);
  const resolution = await loadApplicationResolutionIfPresent(root, goalId, applicationId);
  if (resolution === undefined) return "none";
  const currentG = await git(root, ["rev-parse", "--verify", `refs/spike/goals/${goalId}/integrated^{commit}`]);
  if (resolution.metadata.disposition === "return") return currentG !== resolution.metadata.goalRevision ? "returned" : "none";
  return currentG === application.metadata.integratedRevision ? "stale" : "none";
}
export async function assertGoalNotFrozen(root: string, goalId: string): Promise<void> {
  if ((await goalApplicationFreeze(root, goalId)).frozen) throw new Error(`Goal ${goalId} is frozen by immutable Application evidence`);
}

/** Create the immutable squash object without changing any ref or worktree. */
export async function createSquashCandidate(root: string, goalId: string, integratedRevision: string, previousMain: string): Promise<string> {
  const tree = await git(root, ["rev-parse", "--verify", `${integratedRevision}^{tree}`]);
  return git(root, ["commit-tree", tree, "-p", previousMain, "-m", `Apply Goal ${goalId} as a squash`]);
}

export type PublishApplicationInput = { root: string; goalId: string; integratedRevision: string; approval: string; now?: Date; crash?: CrashInjector };
export async function publishApplication(input: PublishApplicationInput): Promise<Application> {
  const approval = input.approval.trim(); if (!approval) throw new Error("apply refused: explicit operator approval is required");
  // Queue allocation deliberately uses only durable published evidence, never timestamps.
  const published = await listProjectApplications(input.root);
  const queuePosition = published.reduce((maximum, application) => Math.max(maximum, application.metadata.queuePosition), 0) + 1;
  if (!Number.isSafeInteger(queuePosition)) throw new Error("Application queue position is exhausted");
  const applicationId = next(await listApplicationIds(input.root, input.goalId));
  const metadata = identity.parse({ kind: "application", goalId: input.goalId, applicationId, target: "main", integratedRevision: input.integratedRevision, approval, requestedAt: (input.now ?? new Date()).toISOString(), queuePosition });
  const body = `# Queue Goal ${input.goalId} for main\n\nOperator approval: ${approval}\n\nFIFO position: ${queuePosition}\n`;
  await installImmutable(input.root, applicationPath(input.root, input.goalId, applicationId), serializeDocument(metadata, body), commitCrashHooks(input.crash, "application-publication"));
  return { metadata, body };
}
async function validateApplicationResolution(root: string, goalId: string, applicationId: string, resolution: ApplicationResolution): Promise<void> {
  const tickets = await import("./application-ticket.ts");
  const reviews = await import("./application-review.ts");
  const application = await loadApplication(root, goalId, applicationId);
  const implementationIds = await tickets.listApplicationTicketIds(root, goalId, applicationId);
  if (implementationIds.length === 0) throw new Error("Application resolution has no pinned first implementation Ticket");
  const first = await tickets.loadApplicationTicket(root, goalId, applicationId, implementationIds[0]!);
  if (resolution.metadata.expectedMainRevision !== first.metadata.targetRevision || resolution.metadata.goalRevision !== first.metadata.goalRevision || first.metadata.goalRevision !== application.metadata.integratedRevision) {
    throw new Error("Application resolution does not preserve pinned M/G facts");
  }
  let currentCandidate: { revision: string; ticketId: string } | undefined;
  for (let index = implementationIds.length - 1; index >= 0; index--) {
    const report = await tickets.loadApplicationReportIfPresent(root, goalId, applicationId, implementationIds[index]!);
    if (report?.metadata.outcome === "completed" && report.metadata.candidateRevision) {
      currentCandidate = { revision: report.metadata.candidateRevision, ticketId: implementationIds[index]! };
      break;
    }
  }
  if (resolution.metadata.disposition === "stale") {
    if (resolution.metadata.observedMainRevision === resolution.metadata.expectedMainRevision) throw new Error("Stale Application resolution must record a moved main");
    if (currentCandidate === undefined) {
      if ("candidateRevision" in resolution.metadata || "producingImplementationTicketId" in resolution.metadata) throw new Error("Stale Application resolution has unexpected Candidate provenance");
    } else if (!("candidateRevision" in resolution.metadata) || resolution.metadata.candidateRevision !== currentCandidate.revision || resolution.metadata.producingImplementationTicketId !== currentCandidate.ticketId) {
      throw new Error("Stale Application resolution Candidate provenance does not match pinned facts");
    }
    return;
  }
  if (currentCandidate === undefined || resolution.metadata.candidateRevision !== currentCandidate.revision || resolution.metadata.producingImplementationTicketId !== currentCandidate.ticketId) throw new Error("Return Application resolution Candidate provenance does not match pinned facts");
  const reviewIds = await reviews.listApplicationReviewTicketIds(root, goalId, applicationId);
  const highestReviewId = reviewIds.at(-1);
  if (highestReviewId === undefined || resolution.metadata.highestReviewTicketId !== highestReviewId) throw new Error("Return Application resolution does not identify the highest review Ticket");
  const review = await reviews.loadApplicationReviewReportIfPresent(root, goalId, applicationId, highestReviewId);
  if (!review || review.metadata.outcome !== "completed" || review.metadata.candidateRevision !== currentCandidate.revision || review.metadata.producingImplementationTicketId !== currentCandidate.ticketId) throw new Error("Return Application resolution review provenance does not match pinned facts");
}

async function resolutionPrerequisites(root: string, goalId: string, applicationId: string) {
  const tickets = await import("./application-ticket.ts");
  const reviews = await import("./application-review.ts");
  const implementationIds = await tickets.listApplicationTicketIds(root, goalId, applicationId);
  if (implementationIds.length === 0) throw new Error("Application resolution requires a pinned first implementation Ticket");
  const reports = await Promise.all(implementationIds.map(id => tickets.loadApplicationReportIfPresent(root, goalId, applicationId, id)));
  if (reports.some(report => report === undefined)) throw new Error("Application resolution requires every implementation Ticket to be reported");
  const reviewIds = await reviews.listApplicationReviewTicketIds(root, goalId, applicationId);
  const reviewReports = await Promise.all(reviewIds.map(id => reviews.loadApplicationReviewReportIfPresent(root, goalId, applicationId, id)));
  if (reviewReports.some(report => report === undefined)) throw new Error("Application resolution requires every review Ticket to be reported");
  const cleanup = await tickets.applicationCleanupWarnings(root, goalId, applicationId);
  if (cleanup.length) throw new Error(`Application resolution requires healthy cleanup: ${cleanup.join("; ")}`);
  let currentCandidate: { revision: string; ticketId: string } | undefined;
  for (let index = implementationIds.length - 1; index >= 0; index--) {
    const report = reports[index]!;
    if (report?.metadata.outcome === "completed" && report.metadata.candidateRevision) { currentCandidate = { revision: report.metadata.candidateRevision, ticketId: implementationIds[index]! }; break; }
  }
  return { first: await tickets.loadApplicationTicket(root, goalId, applicationId, implementationIds[0]!), currentCandidate, highestReviewId: reviewIds.at(-1), highestReview: reviewReports.at(-1) };
}

export type ResolveApplicationInput = { cwd: string; goalId: string; applicationId: string; statement?: string; now?: Date };
/** Supervisor-only terminal return. Every check precedes immutable publication. */
export async function returnApplication(input: ResolveApplicationInput): Promise<{ root: string; resolution: ApplicationResolution }> {
  const statement = input.statement?.trim(); if (!statement) throw new Error("Application return statement must not be blank");
  const repository = await (await import("./git.ts")).discoverRepository(input.cwd);
  const head = await queuedApplicationHead(repository.root);
  if (!head || head.metadata.goalId !== input.goalId || head.metadata.applicationId !== input.applicationId) throw new Error("Application return requires the exact unresolved FIFO head");
  if (head.decision !== undefined || head.invalidDecision === true) throw new Error("Application return cannot bypass a published apply decision");
  if (await documentExists(repository.root, applicationResolutionPath(repository.root, input.goalId, input.applicationId))) throw new Error("Application already has immutable resolution evidence");
  const facts = await resolutionPrerequisites(repository.root, input.goalId, input.applicationId);
  const review = facts.highestReview;
  if (!review || review.metadata.outcome !== "completed" || !facts.currentCandidate || review.metadata.candidateRevision !== facts.currentCandidate.revision || review.metadata.producingImplementationTicketId !== facts.currentCandidate.ticketId || facts.highestReviewId === undefined) throw new Error("Application return requires the completed highest review for the exact current Candidate and producer");
  const observed = await main(repository.root);
  if (observed !== facts.first.metadata.targetRevision) throw new Error(`Application return requires main ${facts.first.metadata.targetRevision}`);
  const metadata = resolutionSchema.parse({ kind: "application-resolution", disposition: "return", goalId: input.goalId, applicationId: input.applicationId, expectedMainRevision: facts.first.metadata.targetRevision, goalRevision: facts.first.metadata.goalRevision, candidateRevision: facts.currentCandidate.revision, producingImplementationTicketId: facts.currentCandidate.ticketId, highestReviewTicketId: facts.highestReviewId, decidedAt: (input.now ?? new Date()).toISOString(), statement });
  const body = `# Return Application\n\n${statement}\n`;
  await installImmutable(repository.root, applicationResolutionPath(repository.root, input.goalId, input.applicationId), serializeDocument(metadata, body));
  return { root: repository.root, resolution: { metadata, body } };
}
/** Supervisor-only terminal stale resolution. It records target movement, never repairs it. */
export async function staleApplication(input: ResolveApplicationInput): Promise<{ root: string; resolution: ApplicationResolution }> {
  const repository = await (await import("./git.ts")).discoverRepository(input.cwd);
  const head = await queuedApplicationHead(repository.root);
  if (!head || head.metadata.goalId !== input.goalId || head.metadata.applicationId !== input.applicationId) throw new Error("Application stale requires the exact unresolved FIFO head");
  if (head.decision !== undefined || head.invalidDecision === true) throw new Error("Application stale cannot bypass a published apply decision");
  if (await documentExists(repository.root, applicationResolutionPath(repository.root, input.goalId, input.applicationId))) throw new Error("Application already has immutable resolution evidence");
  const facts = await resolutionPrerequisites(repository.root, input.goalId, input.applicationId);
  const observed = await main(repository.root);
  if (observed === facts.first.metadata.targetRevision) throw new Error("Application stale requires main to differ from pinned M");
  const metadata = resolutionSchema.parse({ kind: "application-resolution", disposition: "stale", goalId: input.goalId, applicationId: input.applicationId, expectedMainRevision: facts.first.metadata.targetRevision, observedMainRevision: observed, goalRevision: facts.first.metadata.goalRevision, ...(facts.currentCandidate === undefined ? {} : { candidateRevision: facts.currentCandidate.revision, producingImplementationTicketId: facts.currentCandidate.ticketId }), decidedAt: (input.now ?? new Date()).toISOString() });
  const body = `# Stale Application\n\nPinned main \`${facts.first.metadata.targetRevision}\` moved to \`${observed}\`.\n`;
  await installImmutable(repository.root, applicationResolutionPath(repository.root, input.goalId, input.applicationId), serializeDocument(metadata, body));
  return { root: repository.root, resolution: { metadata, body } };
}

export async function publishApplyDecision(root: string, application: Application, candidateRevision: string, expectedPreviousMainRevision: string, now?: Date, crash?: CrashInjector): Promise<CleanApplicationDecision> {
  const metadata = cleanDecisionSchema.parse({ kind: "application-decision", goalId: application.metadata.goalId, applicationId: application.metadata.applicationId, candidateRevision, expectedPreviousMainRevision, resultingMainRevision: candidateRevision, decidedAt: (now ?? new Date()).toISOString() });
  const body = `# Apply decision\n\nAdvance main from \`${expectedPreviousMainRevision}\` to \`${candidateRevision}\`.\n`;
  await installImmutable(root, applicationDecisionPath(root, metadata.goalId, metadata.applicationId), serializeDocument(metadata, body), commitCrashHooks(crash, "application-decision-publication"));
  return { metadata, body };
}

/** Publish reviewed intent only after the caller has checked the exact durable
 * ticket/review/cleanup facts. Publication is the commit point before CAS. */
export async function publishReviewedApplyDecision(root: string, application: Application, facts: { expectedPreviousMainRevision: string; goalRevision: string; mergeBase: string; candidateRevision: string; producingImplementationTicketId: string; approvingReviewTicketId: string }, now?: Date, crash?: CrashInjector): Promise<ReviewedApplicationDecision> {
  const metadata = reviewedDecisionSchema.parse({ kind: "application-reviewed-apply-decision", form: "reviewed-squash", goalId: application.metadata.goalId, applicationId: application.metadata.applicationId, applicationApproval: application.metadata.approval, resultingMainRevision: facts.candidateRevision, decidedAt: (now ?? new Date()).toISOString(), ...facts });
  const body = `# Reviewed apply decision\n\nApproved Application \`${application.metadata.goalId}/${application.metadata.applicationId}\` advances main from \`${facts.expectedPreviousMainRevision}\` to reviewed Candidate \`${facts.candidateRevision}\`.\n`;
  await installImmutable(root, applicationDecisionPath(root, metadata.goalId, metadata.applicationId), serializeDocument(metadata, body), commitCrashHooks(crash, "application-decision-publication"));
  return { metadata, body };
}
export async function advanceDecision(root: string, decision: ApplicationDecision, crash?: CrashInjector): Promise<void> {
  const current = await main(root);
  if (current === decision.metadata.resultingMainRevision) return;
  if (current !== decision.metadata.expectedPreviousMainRevision) throw new Error(`apply recovery refused: main is ${current}, expected ${decision.metadata.expectedPreviousMainRevision} or ${decision.metadata.resultingMainRevision}`);
  await crash?.({ point: "application-target-advance", moment: "before" });
  if (isReviewedDecision(decision)) {
    // Plumbing CAS changes only this ref. It deliberately never checks out,
    // resets, merges, or reads the host worktree.
    await git(root, ["update-ref", "refs/heads/main", decision.metadata.candidateRevision, decision.metadata.expectedPreviousMainRevision]);
  } else {
    await checkedOutMain(root);
    await git(root, ["merge", "--ff-only", decision.metadata.candidateRevision]);
  }
  if ((await main(root)) !== decision.metadata.resultingMainRevision) throw new Error("apply failed: main did not reach the decided revision");
  await crash?.({ point: "application-target-advance", moment: "after" });
}
export async function validDecision(root: string, application: Application, decision: ApplicationDecision): Promise<boolean> {
  if (decision.metadata.candidateRevision !== decision.metadata.resultingMainRevision || application.metadata.goalId !== decision.metadata.goalId || application.metadata.applicationId !== decision.metadata.applicationId) return false;
  try {
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", decision.metadata.candidateRevision])).split(/\s+/);
    if (parents.length !== 2 || parents[0] !== decision.metadata.candidateRevision || parents[1] !== decision.metadata.expectedPreviousMainRevision) return false;
    if (!isReviewedDecision(decision)) {
      if (decision.metadata.expectedPreviousMainRevision !== (await loadGoal(root, application.metadata.goalId)).metadata.repository.initialRevision) return false;
      const [candidateTree, integratedTree] = await Promise.all([git(root, ["rev-parse", "--verify", `${decision.metadata.candidateRevision}^{tree}`]), git(root, ["rev-parse", "--verify", `${application.metadata.integratedRevision}^{tree}`])]);
      return candidateTree === integratedTree;
    }
    if (decision.metadata.applicationApproval !== application.metadata.approval || decision.metadata.goalRevision !== application.metadata.integratedRevision) return false;
    const tickets = await import("./application-ticket.ts"); const reviews = await import("./application-review.ts");
    const ids = await tickets.listApplicationTicketIds(root, application.metadata.goalId, application.metadata.applicationId);
    if (ids.length === 0) return false;
    const first = await tickets.loadApplicationTicket(root, application.metadata.goalId, application.metadata.applicationId, ids[0]!);
    if (first.metadata.targetRevision !== decision.metadata.expectedPreviousMainRevision || first.metadata.goalRevision !== decision.metadata.goalRevision || first.metadata.mergeBase !== decision.metadata.mergeBase) return false;
    const reports = await Promise.all(ids.map(id => tickets.loadApplicationReportIfPresent(root, application.metadata.goalId, application.metadata.applicationId, id)));
    if (reports.some(report => report === undefined)) return false;
    let current: { ticketId: string; revision: string } | undefined;
    for (let index = ids.length - 1; index >= 0; index--) { const report = reports[index]!; if (report.metadata.outcome === "completed" && report.metadata.candidateRevision) { current = { ticketId: ids[index]!, revision: report.metadata.candidateRevision }; break; } }
    if (!current || current.ticketId !== decision.metadata.producingImplementationTicketId || current.revision !== decision.metadata.candidateRevision) return false;
    const reviewIds = await reviews.listApplicationReviewTicketIds(root, application.metadata.goalId, application.metadata.applicationId);
    if (reviewIds.length === 0 || reviewIds.at(-1) !== decision.metadata.approvingReviewTicketId) return false;
    const reviewReports = await Promise.all(reviewIds.map(id => reviews.loadApplicationReviewReportIfPresent(root, application.metadata.goalId, application.metadata.applicationId, id)));
    const review = reviewReports.at(-1);
    const reviewTicket = await reviews.loadApplicationReviewTicket(root, application.metadata.goalId, application.metadata.applicationId, decision.metadata.approvingReviewTicketId);
    if (reviewReports.some(report => report === undefined) || !review || review.metadata.outcome !== "completed" || review.metadata.verdict !== "approve" || reviewTicket.metadata.candidateRevision !== current.revision || reviewTicket.metadata.producingImplementationTicketId !== current.ticketId || review.metadata.candidateRevision !== current.revision || review.metadata.producingImplementationTicketId !== current.ticketId) return false;
    // Cleanup was an admission precondition before immutable decision
    // publication. Retention/runtime cleanup is rebuildable afterwards and
    // must never revoke an already-published reviewed intent or applied fact.
    return true;
  } catch { return false; }
}

/** Recovery is supervisor-owned and advances only decisions already in FIFO evidence. */
export async function recoverApplications(root: string, _goalId?: string): Promise<void> {
  for (const queued of await listProjectApplications(root)) {
    let resolution: ApplicationResolution | undefined;
    try { resolution = await loadApplicationResolutionIfPresent(root, queued.metadata.goalId, queued.metadata.applicationId); }
    catch { throw new Error(`apply recovery refused: Application ${queued.metadata.goalId}/${queued.metadata.applicationId} has malformed resolution evidence`); }
    // A valid terminal attempt has relinquished target ownership. Skip it
    // lazily, so later malformed evidence is reached only after it matters.
    if (resolution !== undefined) continue;
    if (queued.invalidDecision === true) throw new Error(`apply recovery refused: Application ${queued.metadata.goalId}/${queued.metadata.applicationId} has invalid decision evidence or an unexpected main projection`);
    if (queued.decision === undefined) break;
    const state = await applicationState(root, queued);
    if (state === "applied") continue;
    if (state === "inconsistent") throw new Error(`apply recovery refused: Application ${queued.metadata.goalId}/${queued.metadata.applicationId} has invalid decision evidence or an unexpected main projection`);
    // The earliest valid, decision-bearing entry still owns main until this
    // exact advance completes; later evidence is deliberately not considered.
    await advanceDecision(root, queued.decision);
  }
}
export type ApplicationEvidenceState = "incomplete" | "decision-pending" | "target-mismatch" | "inconsistent" | "applied";
export async function hasTerminalApplication(root: string, goalId: string): Promise<boolean> {
  for (const application of await listProjectApplications(root)) {
    if (application.metadata.goalId === goalId && (await applicationState(root, application)) === "applied") return true;
  }
  return false;
}
export async function applicationEvidence(root: string, goalId: string) {
  const result: Array<{ applicationId: string; state: ApplicationEvidenceState }> = [];
  for (const application of await listProjectApplications(root)) {
    if (application.metadata.goalId === goalId) {
      result.push({ applicationId: application.metadata.applicationId, state: await applicationState(root, application) });
    }
  }
  return result;
}
