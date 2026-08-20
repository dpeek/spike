import { deriveGoalIntegratedRevision } from "./change.ts";
import { discoverRepository, git } from "./git.ts";
import { integratedRef } from "./goal.ts";
import { deriveGoalStatus } from "./status.ts";

export type ApplyGoalIntegrationInput = {
  cwd: string;
  goalId: string;
  targetBranch: string;
  approval: string;
};

export type AppliedGoalIntegration = {
  goalId: string;
  targetBranch: string;
  previousTargetRevision: string;
  appliedRevision: string;
  resultingTargetRevision: string;
};

function refuse(message: string): never {
  throw new Error(`apply refused: ${message}`);
}

async function checkedOutBranch(root: string): Promise<string> {
  try {
    return await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    refuse("HEAD is detached; the target must be the currently checked-out local branch");
  }
}

async function cleanWorktree(root: string): Promise<void> {
  const changes = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (changes) refuse("the target worktree and index must be clean");
}

/**
 * Applies the durably landed Goal revision only to the checked-out local
 * branch. All refusal checks precede Git's sole mutating command.
 */
export async function applyGoalIntegration(input: ApplyGoalIntegrationInput): Promise<AppliedGoalIntegration> {
  if (!input.approval.trim()) refuse("explicit operator approval is required");
  if (!input.targetBranch.trim()) refuse("a target branch is required");

  const repository = await discoverRepository(input.cwd);
  try {
    await git(repository.root, ["check-ref-format", "--branch", input.targetBranch]);
  } catch {
    refuse(`target is not a valid local branch name: ${input.targetBranch}`);
  }

  const status = await deriveGoalStatus(repository.root, input.goalId);
  if (status.currentChange !== null) refuse(`Goal ${input.goalId} has an active Change ${status.currentChange.changeId}`);
  if (!status.cleanup.healthy) refuse(`Goal ${input.goalId} has unhealthy workflow cleanup`);

  const currentBranch = await checkedOutBranch(repository.root);
  if (currentBranch !== input.targetBranch) {
    refuse(`target ${input.targetBranch} is not the currently checked-out local branch (${currentBranch})`);
  }

  let previousTargetRevision: string;
  try {
    previousTargetRevision = await git(repository.root, ["rev-parse", "--verify", `refs/heads/${input.targetBranch}^{commit}`]);
  } catch {
    refuse(`target local branch does not exist: ${input.targetBranch}`);
  }
  await cleanWorktree(repository.root);

  const appliedRevision = await deriveGoalIntegratedRevision(repository.root, input.goalId);
  const ref = integratedRef(input.goalId);
  const verifiedIntegrationRevision = await git(repository.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (verifiedIntegrationRevision !== appliedRevision) {
    refuse(`Goal ${input.goalId} integration ref does not match its durable landed revision; run recovery`);
  }
  try {
    await git(repository.root, ["merge-base", "--is-ancestor", previousTargetRevision, appliedRevision]);
  } catch {
    refuse(`target ${input.targetBranch} cannot fast-forward to Goal ${input.goalId} integrated revision`);
  }

  try {
    await git(repository.root, ["merge", "--ff-only", appliedRevision]);
  } catch {
    throw new Error(`apply failed: target ${input.targetBranch} could not be fast-forwarded to the verified integrated revision`);
  }

  const resultingTargetRevision = await git(repository.root, ["rev-parse", "--verify", `refs/heads/${input.targetBranch}^{commit}`]);
  if (resultingTargetRevision !== appliedRevision) {
    throw new Error(`apply failed: target ${input.targetBranch} is not at the exact integrated revision`);
  }
  if ((await checkedOutBranch(repository.root)) !== input.targetBranch) {
    throw new Error(`apply failed: target ${input.targetBranch} is no longer checked out`);
  }
  await cleanWorktree(repository.root);
  return { goalId: input.goalId, targetBranch: input.targetBranch, previousTargetRevision, appliedRevision, resultingTargetRevision };
}
