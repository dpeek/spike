import { deriveGoalIntegratedRevision } from "./change.ts";
import { discoverRepository, git } from "./git.ts";
import { integratedRef, loadGoal } from "./goal.ts";
import { deriveGoalStatus } from "./status.ts";
import { advanceDecision, createSquashCandidate, hasTerminalApplication, publishApplication, publishApplyDecision } from "./application.ts";
import type { CrashInjector } from "./crash.ts";

export type ApplyGoalIntegrationInput = { cwd: string; goalId: string; targetBranch?: string; approval: string; now?: Date; crash?: CrashInjector };
export type AppliedGoalIntegration = { goalId: string; applicationId: string; targetBranch: string; previousTargetRevision: string; appliedRevision: string; resultingTargetRevision: string };
function refuse(message: string): never { throw new Error(`apply refused: ${message}`); }

/**
 * Records immutable Application intent and decision before Git advances main.
 * Git's checked-out-branch merge is intentionally the only worktree safety
 * mechanism: Spike performs no cleanliness scan or reset.
 */
export async function applyGoalIntegration(input: ApplyGoalIntegrationInput): Promise<AppliedGoalIntegration> {
  if (!input.approval.trim()) refuse("explicit operator approval is required");
  if (input.targetBranch !== undefined && input.targetBranch !== "main") refuse("main is the only supported target");
  const repository = await discoverRepository(input.cwd);
  const status = await deriveGoalStatus(repository.root, input.goalId);
  if (status.currentChange !== null) refuse(`Goal ${input.goalId} has an active Change ${status.currentChange.changeId}`);
  if (!status.cleanup.healthy) refuse(`Goal ${input.goalId} has unhealthy workflow cleanup`);
  if (await hasTerminalApplication(repository.root, input.goalId)) refuse(`Goal ${input.goalId} is terminal after application`);
  if (status.application.some((entry) => entry.state === "inconsistent")) refuse(`Goal ${input.goalId} has an inconsistent Application; run recovery`);

  let branch: string;
  try { branch = await git(repository.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch { refuse("main must be the currently checked-out local branch"); }
  if (branch !== "main") refuse("main must be the currently checked-out local branch");
  const goal = await loadGoal(repository.root, input.goalId);
  const previousTargetRevision = await git(repository.root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
  if (previousTargetRevision !== goal.metadata.repository.initialRevision) {
    refuse(`main ${previousTargetRevision} does not equal Goal initial revision ${goal.metadata.repository.initialRevision}`);
  }
  const appliedRevision = await deriveGoalIntegratedRevision(repository.root, input.goalId);
  const verified = await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]);
  if (verified !== appliedRevision) refuse("Goal integration ref does not match its durable landed revision; run recovery");

  // All refusal checks above occur before Application intent publication.
  const application = await publishApplication({ root: repository.root, goalId: input.goalId, integratedRevision: appliedRevision, approval: input.approval, ...(input.now === undefined ? {} : { now: input.now }), ...(input.crash === undefined ? {} : { crash: input.crash }) });
  const candidate = await createSquashCandidate(repository.root, input.goalId, appliedRevision, previousTargetRevision);
  const decision = await publishApplyDecision(repository.root, application, candidate, previousTargetRevision, input.now, input.crash);
  await advanceDecision(repository.root, decision, input.crash);
  return { goalId: input.goalId, applicationId: application.metadata.applicationId, targetBranch: "main", previousTargetRevision, appliedRevision, resultingTargetRevision: candidate };
}
