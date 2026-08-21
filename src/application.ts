import { join } from "node:path";
import { z } from "zod";
import { commitCrashHooks, type CrashInjector } from "./crash.ts";
import { documentExists, installImmutable, listDirectoryNames, readDocument, serializeDocument } from "./durable-state.ts";
import { git } from "./git.ts";
import { goalIdPattern, sequenceIdPattern } from "./identity.ts";
import { projectRoot } from "./project.ts";

const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const time = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const identity = z.object({ kind: z.literal("application"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), target: z.literal("main"), integratedRevision: revision, approval: z.string().min(1), requestedAt: time }).strict();
const decisionSchema = z.object({ kind: z.literal("application-decision"), goalId: z.string().regex(goalIdPattern), applicationId: z.string().regex(sequenceIdPattern), candidateRevision: revision, expectedPreviousMainRevision: revision, resultingMainRevision: revision, decidedAt: time }).strict();
export type Application = { metadata: z.infer<typeof identity>; body: string };
export type ApplicationDecision = { metadata: z.infer<typeof decisionSchema>; body: string };

function rootPath(root: string, goalId: string) { return join(projectRoot(root), "goals", goalId, "applications"); }
export function applicationPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "application.md"); }
export function applicationDecisionPath(root: string, goalId: string, applicationId: string) { return join(rootPath(root, goalId), applicationId, "decision.md"); }
export async function listApplicationIds(root: string, goalId: string): Promise<string[]> {
  return (await listDirectoryNames(root, rootPath(root, goalId))).filter((id) => sequenceIdPattern.test(id)).sort();
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

/** Create the immutable squash object without changing any ref or worktree. */
export async function createSquashCandidate(root: string, goalId: string, integratedRevision: string, previousMain: string): Promise<string> {
  const tree = await git(root, ["rev-parse", "--verify", `${integratedRevision}^{tree}`]);
  return git(root, ["commit-tree", tree, "-p", previousMain, "-m", `Apply Goal ${goalId} as a squash`]);
}

export type PublishApplicationInput = { root: string; goalId: string; integratedRevision: string; approval: string; now?: Date; crash?: CrashInjector };
export async function publishApplication(input: PublishApplicationInput): Promise<Application> {
  const approval = input.approval.trim(); if (!approval) throw new Error("apply refused: explicit operator approval is required");
  const applicationId = next(await listApplicationIds(input.root, input.goalId));
  const metadata = identity.parse({ kind: "application", goalId: input.goalId, applicationId, target: "main", integratedRevision: input.integratedRevision, approval, requestedAt: (input.now ?? new Date()).toISOString() });
  const body = `# Apply Goal ${input.goalId}\n\nOperator approval: ${approval}\n`;
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
  await checkedOutMain(root);
  const current = await main(root);
  if (current === decision.metadata.resultingMainRevision) return;
  if (current !== decision.metadata.expectedPreviousMainRevision) throw new Error(`apply recovery refused: main is ${current}, expected ${decision.metadata.expectedPreviousMainRevision} or ${decision.metadata.resultingMainRevision}`);
  await crash?.({ point: "application-target-advance", moment: "before" });
  // merge --ff-only updates the checked-out worktree and lets Git reject local conflicts.
  await git(root, ["merge", "--ff-only", decision.metadata.candidateRevision]);
  if ((await main(root)) !== decision.metadata.resultingMainRevision) throw new Error("apply failed: main did not reach the decided revision");
  await crash?.({ point: "application-target-advance", moment: "after" });
}
async function validDecision(root: string, application: Application, decision: ApplicationDecision): Promise<boolean> {
  if (decision.metadata.candidateRevision !== decision.metadata.resultingMainRevision) return false;
  if (application.metadata.goalId !== decision.metadata.goalId || application.metadata.applicationId !== decision.metadata.applicationId) return false;
  try {
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", decision.metadata.candidateRevision])).split(/\s+/);
    if (parents.length !== 2 || parents[0] !== decision.metadata.candidateRevision || parents[1] !== decision.metadata.expectedPreviousMainRevision) return false;
    const [candidateTree, integratedTree] = await Promise.all([
      git(root, ["rev-parse", "--verify", `${decision.metadata.candidateRevision}^{tree}`]),
      git(root, ["rev-parse", "--verify", `${application.metadata.integratedRevision}^{tree}`]),
    ]);
    return candidateTree === integratedTree;
  } catch { return false; }
}
export async function recoverApplications(root: string, goalId: string): Promise<void> {
  for (const id of await listApplicationIds(root, goalId)) {
    if (!(await documentExists(root, applicationPath(root, goalId, id)))) continue;
    const application = await loadApplication(root, goalId, id);
    const decision = await loadApplicationDecisionIfPresent(root, goalId, id);
    if (decision !== undefined) {
      if (!(await validDecision(root, application, decision))) throw new Error(`apply recovery refused: Application ${goalId}/${id} has invalid decision evidence`);
      await advanceDecision(root, decision);
    }
  }
}
export type ApplicationEvidenceState = "incomplete" | "inconsistent" | "applied";

/** A valid decision is terminal intent even if main subsequently moves. */
export async function hasTerminalApplication(root: string, goalId: string): Promise<boolean> {
  for (const id of await listApplicationIds(root, goalId)) {
    if (!(await documentExists(root, applicationPath(root, goalId, id)))) continue;
    const application = await loadApplication(root, goalId, id);
    const decision = await loadApplicationDecisionIfPresent(root, goalId, id);
    if (decision !== undefined && await validDecision(root, application, decision)) return true;
  }
  return false;
}

export async function applicationEvidence(root: string, goalId: string) {
  const result: Array<{ applicationId: string; state: ApplicationEvidenceState }> = [];
  for (const id of await listApplicationIds(root, goalId)) {
    if (!(await documentExists(root, applicationPath(root, goalId, id)))) { result.push({ applicationId: id, state: "incomplete" }); continue; }
    const application = await loadApplication(root, goalId, id);
    const decision = await loadApplicationDecisionIfPresent(root, goalId, id);
    if (decision === undefined) { result.push({ applicationId: id, state: "incomplete" }); continue; }
    let current = ""; try { current = await main(root); } catch { /* inconsistent */ }
    if (!(await validDecision(root, application, decision)) || !current) {
      result.push({ applicationId: id, state: "inconsistent" });
    } else if (current === decision.metadata.resultingMainRevision) {
      result.push({ applicationId: id, state: "applied" });
    } else if (current === decision.metadata.expectedPreviousMainRevision) {
      // The decision was published but its target advance has not completed.
      result.push({ applicationId: id, state: "incomplete" });
    } else {
      result.push({ applicationId: id, state: "inconsistent" });
    }
  }
  return result;
}
