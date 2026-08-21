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
const decisionSchema = z.object({ kind: z.literal("application-decision"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), candidateRevision: revision, expectedPreviousMainRevision: revision, resultingMainRevision: revision, decidedAt: time }).strict();
export type Application = { metadata: z.infer<typeof identity>; body: string };
export type ApplicationDecision = { metadata: z.infer<typeof decisionSchema>; body: string };
export type QueuedApplication = Application & { decision?: ApplicationDecision; invalidDecision?: true };

function rootPath(root: string, goalId: string) { return join(projectRoot(root), "goals", goalId, "applications"); }
export function applicationPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "application.md"); }
export function applicationDecisionPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "decision.md"); }
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
  return { metadata, body: doc.body };
}
function next(ids: string[]) { const high = ids.reduce((n, id) => Math.max(n, Number(id)), 0); if (high >= 999) throw new Error("Application ID sequence is exhausted"); return String(high + 1).padStart(3, "0"); }
async function checkedOutMain(root: string) { const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); if (branch !== "main") throw new Error("apply refused: main must be the currently checked-out local branch"); }
async function main(root: string) { return git(root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]); }

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
  if (current === application.decision.metadata.expectedPreviousMainRevision) return "incomplete";
  return "inconsistent";
}

/** The first non-terminal entry is a barrier even when its decision is pending
 * target advancement or is invalid. Callers must never skip it. */
export async function queuedApplicationHead(root: string): Promise<QueuedApplication | undefined> {
  for (const application of await listProjectApplications(root)) {
    if ((await applicationState(root, application)) !== "applied") return application;
  }
  return undefined;
}
export async function assertGoalNotFrozen(root: string, goalId: string): Promise<void> {
  if ((await listPublishedApplicationIds(root, goalId)).length !== 0) throw new Error(`Goal ${goalId} is frozen by immutable Application evidence`);
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
export async function publishApplyDecision(root: string, application: Application, candidateRevision: string, expectedPreviousMainRevision: string, now?: Date, crash?: CrashInjector): Promise<ApplicationDecision> {
  const metadata = decisionSchema.parse({ kind: "application-decision", goalId: application.metadata.goalId, applicationId: application.metadata.applicationId, candidateRevision, expectedPreviousMainRevision, resultingMainRevision: candidateRevision, decidedAt: (now ?? new Date()).toISOString() });
  const body = `# Apply decision\n\nAdvance main from \`${expectedPreviousMainRevision}\` to \`${candidateRevision}\`.\n`;
  await installImmutable(root, applicationDecisionPath(root, metadata.goalId, metadata.applicationId), serializeDocument(metadata, body), commitCrashHooks(crash, "application-decision-publication"));
  return { metadata, body };
}
export async function advanceDecision(root: string, decision: ApplicationDecision, crash?: CrashInjector): Promise<void> {
  await checkedOutMain(root); const current = await main(root);
  if (current === decision.metadata.resultingMainRevision) return;
  if (current !== decision.metadata.expectedPreviousMainRevision) throw new Error(`apply recovery refused: main is ${current}, expected ${decision.metadata.expectedPreviousMainRevision} or ${decision.metadata.resultingMainRevision}`);
  await crash?.({ point: "application-target-advance", moment: "before" });
  await git(root, ["merge", "--ff-only", decision.metadata.candidateRevision]);
  if ((await main(root)) !== decision.metadata.resultingMainRevision) throw new Error("apply failed: main did not reach the decided revision");
  await crash?.({ point: "application-target-advance", moment: "after" });
}
export async function validDecision(root: string, application: Application, decision: ApplicationDecision): Promise<boolean> {
  if (decision.metadata.candidateRevision !== decision.metadata.resultingMainRevision || application.metadata.goalId !== decision.metadata.goalId || application.metadata.applicationId !== decision.metadata.applicationId) return false;
  try {
    // Only an uninterrupted clean-base apply is authorized by this decision
    // shape. Future reviewed diverged applies require distinct evidence.
    if (decision.metadata.expectedPreviousMainRevision !== (await loadGoal(root, application.metadata.goalId)).metadata.repository.initialRevision) return false;
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", decision.metadata.candidateRevision])).split(/\s+/);
    if (parents.length !== 2 || parents[0] !== decision.metadata.candidateRevision || parents[1] !== decision.metadata.expectedPreviousMainRevision) return false;
    const [candidateTree, integratedTree] = await Promise.all([git(root, ["rev-parse", "--verify", `${decision.metadata.candidateRevision}^{tree}`]), git(root, ["rev-parse", "--verify", `${application.metadata.integratedRevision}^{tree}`])]);
    return candidateTree === integratedTree;
  } catch { return false; }
}

/** Recovery is supervisor-owned and advances only decisions already in FIFO evidence. */
export async function recoverApplications(root: string, _goalId?: string): Promise<void> {
  for (const queued of await listProjectApplications(root)) {
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
export type ApplicationEvidenceState = "incomplete" | "inconsistent" | "applied";
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
