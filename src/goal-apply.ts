import type { HostPaths } from "./data-root.ts";
import { deriveGoalIntegratedRevision } from "./change.ts";
import { discoverRepository, git } from "./git.ts";
import { integratedRef, loadGoal } from "./goal.ts";
import { deriveGoalStatus } from "./status.ts";
import { advanceDecision, applicationRequeueEligibility, applicationState, createSquashCandidate, hasTerminalApplication, listPublishedApplicationIds, publishApplication, publishApplyDecision, publishReviewedApplyDecision, queuedApplicationHead, validDecision } from "./application.ts";
import { goalPlannerOperations, type GoalPlannerOperations } from "./goal-planner.ts";
import type { CrashInjector } from "./crash.ts";

export type QueueGoalIntegrationInput = { cwd: string; hostPaths: HostPaths; goalId: string; targetBranch?: string; approval: string; now?: Date; crash?: CrashInjector; planners?: GoalPlannerOperations };
export type QueuedGoalIntegration = { goalId: string; applicationId: string; targetBranch: "main"; integratedRevision: string; queuePosition: number; plannerCleanup: { status: "released" } | { status: "failed"; message: string } };
export type ApplyQueueHeadInput = { cwd: string; hostPaths: HostPaths; goalId: string; applicationId: string; now?: Date; crash?: CrashInjector };
export type AppliedQueueHead = { goalId: string; applicationId: string; targetBranch: "main"; previousTargetRevision: string; appliedRevision: string; resultingTargetRevision: string; form: "clean-base" | "reviewed" };
function refuse(message: string): never { throw new Error(`apply refused: ${message}`); }

/** Supervisor-only admission: publish durable queue evidence before optional planner cleanup. */
export async function queueGoalIntegration(input: QueueGoalIntegrationInput): Promise<QueuedGoalIntegration> {
  if (!input.approval.trim()) refuse("explicit operator approval is required");
  if (input.targetBranch !== undefined && input.targetBranch !== "main") refuse("main is the only supported target");
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const status = await deriveGoalStatus(repository.root, input.hostPaths, input.goalId);
  if (status.currentChange !== null) refuse(`Goal ${input.goalId} has an active Change ${status.currentChange.changeId}`);
  if (!status.cleanup.healthy) refuse(`Goal ${input.goalId} has unhealthy workflow cleanup`);
  const priorApplications = await listPublishedApplicationIds(repository, input.goalId);
  const requeue = await applicationRequeueEligibility(repository, input.goalId);
  if (priorApplications.length !== 0 && requeue === "none") refuse(`Goal ${input.goalId} is not eligible to requeue from its immutable Application evidence`);
  if (await hasTerminalApplication(repository, input.goalId)) refuse(`Goal ${input.goalId} is terminal after application`);
  if (status.application.some((entry) => entry.state === "inconsistent")) refuse(`Goal ${input.goalId} has an inconsistent Application; run recovery`);
  const integratedRevision = await deriveGoalIntegratedRevision(repository, input.goalId);
  const verified = await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]);
  if (verified !== integratedRevision) refuse("Goal integration ref does not match its durable landed revision; run recovery");
  // Every refusal above is before durable Application publication or Git mutation.
  const application = await publishApplication({ root: repository, goalId: input.goalId, integratedRevision, approval: input.approval, ...(input.now === undefined ? {} : { now: input.now }), ...(input.crash === undefined ? {} : { crash: input.crash }) });
  let plannerCleanup: QueuedGoalIntegration["plannerCleanup"] = { status: "released" };
  try { await (input.planners ?? goalPlannerOperations).release({ cwd: repository.root, hostPaths: input.hostPaths, goalId: input.goalId }); }
  catch (error) { plannerCleanup = { status: "failed", message: error instanceof Error ? error.message : String(error) }; }
  return { goalId: input.goalId, applicationId: application.metadata.applicationId, targetBranch: "main", integratedRevision, queuePosition: application.metadata.queuePosition, plannerCleanup };
}

/** Only the immutable FIFO head is allowed to create target intent or touch main. */
export async function applyQueueHead(input: ApplyQueueHeadInput): Promise<AppliedQueueHead> {
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const head = await queuedApplicationHead(repository);
  if (head === undefined) refuse("there is no unresolved Application queue head");
  if (head.metadata.goalId !== input.goalId || head.metadata.applicationId !== input.applicationId) refuse(`Application ${input.goalId}/${input.applicationId} is not the exact FIFO queue head`);
  if (head.invalidDecision === true) refuse("Application has invalid decision evidence or an unexpected main projection");
  if (head.decision !== undefined) {
    const state = await applicationState(repository, head);
    if (state === "inconsistent" || !(await validDecision(repository, head, head.decision))) refuse("Application has invalid decision evidence or an unexpected main projection");
    refuse("Application has a published decision awaiting exact target recovery");
  }
  const goal = await loadGoal(repository, input.goalId);
  const previousTargetRevision = await git(repository.root, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
  const rebuilt = await deriveGoalIntegratedRevision(repository, input.goalId);
  const ref = await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]);
  if (rebuilt !== head.metadata.integratedRevision || ref !== head.metadata.integratedRevision) refuse("queue-head Application integration revision no longer matches durable Goal evidence");
  if (previousTargetRevision === goal.metadata.repository.initialRevision) {
    // Preserve the existing clean-base workflow (including Git's checked-out
    // worktree safety semantics) unchanged.
    let branch: string; try { branch = await git(repository.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch { refuse("main must be the currently checked-out local branch"); }
    if (branch !== "main") refuse("main must be the currently checked-out local branch");
    const candidate = await createSquashCandidate(repository, input.goalId, head.metadata.integratedRevision, previousTargetRevision);
    const decision = await publishApplyDecision(repository, head, candidate, previousTargetRevision, input.now, input.crash);
    await advanceDecision(repository, decision, input.crash);
    return { goalId: input.goalId, applicationId: input.applicationId, targetBranch: "main", previousTargetRevision, appliedRevision: head.metadata.integratedRevision, resultingTargetRevision: candidate, form: "clean-base" };
  }
  // Diverged application: every authorization check is read-only and precedes
  // reviewed-decision publication and the sole refs/heads/main CAS.
  const tickets = await import("./application-ticket.ts"); const reviews = await import("./application-review.ts");
  const ticketIds = await tickets.listApplicationTicketIds(repository, input.goalId, input.applicationId);
  if (ticketIds.length === 0) refuse(`main ${previousTargetRevision} does not equal queue-head Goal initial revision ${goal.metadata.repository.initialRevision}`);
  const first = await tickets.loadApplicationTicket(repository, input.goalId, input.applicationId, ticketIds[0]!);
  if (first.metadata.targetRevision !== previousTargetRevision) refuse(`main ${previousTargetRevision} does not equal pinned M ${first.metadata.targetRevision}`);
  if (first.metadata.goalRevision !== head.metadata.integratedRevision) refuse("reviewed apply Goal revision does not match Application evidence");
  const reports = await Promise.all(ticketIds.map(id => tickets.loadApplicationReportIfPresent(repository, input.goalId, input.applicationId, id)));
  if (reports.some(report => report === undefined)) refuse("reviewed apply requires every implementation Ticket to be reported");
  let candidate: { ticketId: string; revision: string } | undefined;
  for (let index = ticketIds.length - 1; index >= 0; index--) { const report = reports[index]!; if (report.metadata.outcome === "completed" && report.metadata.candidateRevision) { candidate = { ticketId: ticketIds[index]!, revision: report.metadata.candidateRevision }; break; } }
  if (!candidate) refuse("reviewed apply requires a completed current Candidate");
  const reviewIds = await reviews.listApplicationReviewTicketIds(repository, input.goalId, input.applicationId);
  if (reviewIds.length === 0) refuse("reviewed apply requires an approving review Ticket");
  const reviewReports = await Promise.all(reviewIds.map(id => reviews.loadApplicationReviewReportIfPresent(repository, input.goalId, input.applicationId, id)));
  if (reviewReports.some(report => report === undefined)) refuse("reviewed apply requires every review Ticket to be reported");
  const reviewId = reviewIds.at(-1)!; const review = reviewReports.at(-1)!;
  const reviewTicket = await reviews.loadApplicationReviewTicket(repository, input.goalId, input.applicationId, reviewId);
  if (review.metadata.outcome !== "completed" || review.metadata.verdict !== "approve" || reviewTicket.metadata.candidateRevision !== candidate.revision || reviewTicket.metadata.producingImplementationTicketId !== candidate.ticketId || review.metadata.candidateRevision !== candidate.revision || review.metadata.producingImplementationTicketId !== candidate.ticketId) refuse("reviewed apply requires the usable highest approve Report for the exact current Candidate and producer");
  const cleanup = await tickets.applicationCleanupWarnings(repository, input.goalId, input.applicationId);
  if (cleanup.length) refuse(`reviewed apply requires healthy cleanup: ${cleanup.join("; ")}`);
  const parents = (await git(repository.root, ["rev-list", "--parents", "-n", "1", candidate.revision])).split(/\s+/);
  if (parents.length !== 2 || parents[0] !== candidate.revision || parents[1] !== previousTargetRevision) refuse("reviewed Candidate must have pinned M as its sole parent");
  const decision = await publishReviewedApplyDecision(repository, head, { expectedPreviousMainRevision: previousTargetRevision, goalRevision: first.metadata.goalRevision, mergeBase: first.metadata.mergeBase, candidateRevision: candidate.revision, producingImplementationTicketId: candidate.ticketId, approvingReviewTicketId: reviewId }, input.now, input.crash);
  await advanceDecision(repository, decision, input.crash);
  return { goalId: input.goalId, applicationId: input.applicationId, targetBranch: "main", previousTargetRevision, appliedRevision: head.metadata.integratedRevision, resultingTargetRevision: candidate.revision, form: "reviewed" };
}
