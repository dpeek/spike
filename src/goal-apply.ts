import { deriveGoalIntegratedRevision } from "./change.ts";
import { discoverRepository, git } from "./git.ts";
import { integratedRef, loadGoal } from "./goal.ts";
import { deriveGoalStatus } from "./status.ts";
import { advanceDecision, applicationRequeueEligibility, applicationState, createSquashCandidate, hasTerminalApplication, listPublishedApplicationIds, publishApplication, publishApplyDecision, queuedApplicationHead, validDecision } from "./application.ts";
import { goalPlannerOperations, type GoalPlannerOperations } from "./goal-planner.ts";
import type { CrashInjector } from "./crash.ts";

export type QueueGoalIntegrationInput = { cwd: string; goalId: string; targetBranch?: string; approval: string; now?: Date; crash?: CrashInjector; planners?: GoalPlannerOperations };
export type QueuedGoalIntegration = { goalId: string; applicationId: string; targetBranch: "main"; integratedRevision: string; queuePosition: number; plannerCleanup: { status: "released" } | { status: "failed"; message: string } };
export type ApplyQueueHeadInput = { cwd: string; goalId: string; applicationId: string; now?: Date; crash?: CrashInjector };
export type AppliedQueueHead = { goalId: string; applicationId: string; targetBranch: "main"; previousTargetRevision: string; appliedRevision: string; resultingTargetRevision: string };
function refuse(message: string): never { throw new Error(`apply refused: ${message}`); }

/** Supervisor-only admission: publish durable queue evidence before optional planner cleanup. */
export async function queueGoalIntegration(input: QueueGoalIntegrationInput): Promise<QueuedGoalIntegration> {
  if (!input.approval.trim()) refuse("explicit operator approval is required");
  if (input.targetBranch !== undefined && input.targetBranch !== "main") refuse("main is the only supported target");
  const repository = await discoverRepository(input.cwd);
  const status = await deriveGoalStatus(repository.root, input.goalId);
  if (status.currentChange !== null) refuse(`Goal ${input.goalId} has an active Change ${status.currentChange.changeId}`);
  if (!status.cleanup.healthy) refuse(`Goal ${input.goalId} has unhealthy workflow cleanup`);
  const priorApplications = await listPublishedApplicationIds(repository.root, input.goalId);
  const requeue = await applicationRequeueEligibility(repository.root, input.goalId);
  if (priorApplications.length !== 0 && requeue === "none") refuse(`Goal ${input.goalId} is not eligible to requeue from its immutable Application evidence`);
  if (await hasTerminalApplication(repository.root, input.goalId)) refuse(`Goal ${input.goalId} is terminal after application`);
  if (status.application.some((entry) => entry.state === "inconsistent")) refuse(`Goal ${input.goalId} has an inconsistent Application; run recovery`);
  const integratedRevision = await deriveGoalIntegratedRevision(repository.root, input.goalId);
  const verified = await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]);
  if (verified !== integratedRevision) refuse("Goal integration ref does not match its durable landed revision; run recovery");
  // Every refusal above is before durable Application publication or Git mutation.
  const application = await publishApplication({ root: repository.root, goalId: input.goalId, integratedRevision, approval: input.approval, ...(input.now === undefined ? {} : { now: input.now }), ...(input.crash === undefined ? {} : { crash: input.crash }) });
  let plannerCleanup: QueuedGoalIntegration["plannerCleanup"] = { status: "released" };
  try { await (input.planners ?? goalPlannerOperations).release({ cwd: repository.root, goalId: input.goalId }); }
  catch (error) { plannerCleanup = { status: "failed", message: error instanceof Error ? error.message : String(error) }; }
  return { goalId: input.goalId, applicationId: application.metadata.applicationId, targetBranch: "main", integratedRevision, queuePosition: application.metadata.queuePosition, plannerCleanup };
}

/** Only the immutable FIFO head is allowed to create target intent or touch main. */
export async function applyQueueHead(input: ApplyQueueHeadInput): Promise<AppliedQueueHead> {
  const repository = await discoverRepository(input.cwd);
  const head = await queuedApplicationHead(repository.root);
  if (head === undefined) refuse("there is no unresolved Application queue head");
  if (head.metadata.goalId !== input.goalId || head.metadata.applicationId !== input.applicationId) refuse(`Application ${input.goalId}/${input.applicationId} is not the exact FIFO queue head`);
  if (head.invalidDecision === true) refuse("Application has invalid decision evidence or an unexpected main projection");
  if (head.decision !== undefined) {
    const state = await applicationState(repository.root, head);
    if (state === "inconsistent" || !(await validDecision(repository.root, head, head.decision))) refuse("Application has invalid decision evidence or an unexpected main projection");
    refuse("Application has a published decision awaiting exact target recovery");
  }
  let branch: string; try { branch = await git(repository.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch { refuse("main must be the currently checked-out local branch"); }
  if (branch !== "main") refuse("main must be the currently checked-out local branch");
  const goal = await loadGoal(repository.root, input.goalId);
  const previousTargetRevision = await git(repository.root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
  if (previousTargetRevision !== goal.metadata.repository.initialRevision) refuse(`main ${previousTargetRevision} does not equal queue-head Goal initial revision ${goal.metadata.repository.initialRevision}`);
  const rebuilt = await deriveGoalIntegratedRevision(repository.root, input.goalId);
  const ref = await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]);
  if (rebuilt !== head.metadata.integratedRevision || ref !== head.metadata.integratedRevision) refuse("queue-head Application integration revision no longer matches durable Goal evidence");
  // Refusals are complete; the first target side effect is the detached squash object.
  const candidate = await createSquashCandidate(repository.root, input.goalId, head.metadata.integratedRevision, previousTargetRevision);
  const decision = await publishApplyDecision(repository.root, head, candidate, previousTargetRevision, input.now, input.crash);
  await advanceDecision(repository.root, decision, input.crash);
  return { goalId: input.goalId, applicationId: input.applicationId, targetBranch: "main", previousTargetRevision, appliedRevision: head.metadata.integratedRevision, resultingTargetRevision: candidate };
}
