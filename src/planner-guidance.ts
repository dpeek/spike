import { deriveGoalIntegratedRevision, listChangeIds, loadChange, loadChangeDecisionIfPresent } from "./change.ts";
import type { HostPaths } from "./data-root.ts";
import type { ProjectPaths } from "./project.ts";
import { discoverRepository } from "./git.ts";
import { loadGoal } from "./goal.ts";
import { loadGuidance, guidanceStepSchema, type Guidance, type GuidanceStep } from "./guidance.ts";

export type SelectGuidanceInput = {
  cwd: string;
  hostPaths: HostPaths;
  step: GuidanceStep;
  goalId?: string;
  changeId?: string;
};

const goalSteps = new Set<GuidanceStep>(["plan", "change", "recover"]);
const changeSteps = new Set<GuidanceStep>(["implement", "review", "remediate", "decide"]);

function requireIdentity(value: string | undefined, option: "--goal" | "--change"): string {
  if (value === undefined) throw new Error(`${option} is required for this guidance step`);
  return value;
}

async function integratedRevision(root: ProjectPaths, goalId: string): Promise<string> {
  return deriveGoalIntegratedRevision(root, goalId);
}

async function recoverRevision(root: ProjectPaths, goalId: string): Promise<string> {
  await loadGoal(root, goalId);
  const active: string[] = [];
  for (const changeId of await listChangeIds(root, goalId)) {
    if ((await loadChangeDecisionIfPresent(root, goalId, changeId)) === undefined) active.push(changeId);
  }
  if (active.length > 1) throw new Error(`Goal ${goalId} has multiple active Changes`);
  return active[0] === undefined
    ? integratedRevision(root, goalId)
    : (await loadChange(root, goalId, active[0])).metadata.baseRevision;
}

export async function selectGuidance(input: SelectGuidanceInput): Promise<Guidance> {
  const step = guidanceStepSchema.parse(input.step);
  const repository = await discoverRepository(input.cwd, input.hostPaths);

  let revision: string;
  if (step === "goal") {
    if (input.goalId !== undefined || input.changeId !== undefined) {
      throw new Error("goal guidance does not accept Goal or Change identity");
    }
    revision = repository.head;
  } else if (goalSteps.has(step)) {
    if (input.changeId !== undefined) throw new Error(`${step} guidance does not accept --change`);
    const goalId = requireIdentity(input.goalId, "--goal");
    revision = step === "recover"
      ? await recoverRevision(repository, goalId)
      : await integratedRevision(repository, goalId);
  } else if (changeSteps.has(step)) {
    const goalId = requireIdentity(input.goalId, "--goal");
    const changeId = requireIdentity(input.changeId, "--change");
    revision = (await loadChange(repository, goalId, changeId)).metadata.baseRevision;
  } else {
    throw new Error(`unsupported guidance step: ${step}`);
  }

  return loadGuidance(repository.root, step, revision);
}
