import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abandonChange, createChange } from "./change.ts";
import { createGoal, integratedRef } from "./goal.ts";
import { guidancePaths, guidanceSteps } from "./guidance.ts";
import { selectGuidance } from "./planner-guidance.ts";
import { fixtureGuidance, temporaryRepository } from "../test/support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("planner guidance revision selection", () => {
  test("selects HEAD, Goal integration, Change base, and recovery authority", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const initial = repository.head;
    const goal = await createGoal({
      cwd: repository.root,
      title: "Select committed guidance",
      outcome: "Use authority fixed by each planner step.",
      approval: "Operator approved this Goal.",
    });
    const goalId = goal.goal.metadata.goalId;

    for (const step of guidanceSteps) {
      await writeFile(join(repository.root, guidancePaths[step]), `# Head ${step}\n\nExact ${step} guidance from the newer commit.\n`);
    }
    await repository.git("add", "spike/guidance");
    await repository.git("commit", "--quiet", "-m", "Revise guidance");
    const head = await repository.git("rev-parse", "HEAD");

    expect(await selectGuidance({ cwd: repository.root, step: "goal" })).toEqual({
      step: "goal",
      path: guidancePaths.goal,
      revision: head,
      markdown: "# Head goal\n\nExact goal guidance from the newer commit.\n",
    });
    for (const step of ["plan", "change"] as const) {
      expect(await selectGuidance({ cwd: repository.root, step, goalId })).toEqual({
        step,
        path: guidancePaths[step],
        revision: initial,
        markdown: fixtureGuidance[step],
      });
    }

    const change = await createChange({
      cwd: repository.root,
      goalId,
      title: "Keep guidance fixed",
      intent: "Exercise Change-based selection.",
      rationale: "A newer host commit must not alter active guidance.",
      acceptanceCriteria: ["Every Change-based planner step uses the Change base."],
    });
    expect(change.change.metadata.baseRevision).toBe(initial);
    for (const step of ["implement", "review", "remediate", "decide"] as const) {
      expect(await selectGuidance({ cwd: repository.root, step, goalId, changeId: "001" })).toEqual({
        step,
        path: guidancePaths[step],
        revision: initial,
        markdown: fixtureGuidance[step],
      });
    }
    expect(await selectGuidance({ cwd: repository.root, step: "recover", goalId })).toMatchObject({
      step: "recover",
      revision: initial,
      markdown: fixtureGuidance.recover,
    });

    await abandonChange({ cwd: repository.root, goalId, changeId: "001", statement: "Resolve the fixture Change." });
    await repository.git("update-ref", integratedRef(goalId), head, initial);
    expect(await selectGuidance({ cwd: repository.root, step: "recover", goalId })).toMatchObject({
      step: "recover",
      revision: initial,
      markdown: fixtureGuidance.recover,
    });

    await repository.git("update-ref", "-d", integratedRef(goalId));
    expect(await selectGuidance({ cwd: repository.root, step: "recover", goalId })).toMatchObject({
      step: "recover",
      revision: initial,
      markdown: fixtureGuidance.recover,
    });
  });

  test("requires only the identity used by the selected authority", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    await expect(selectGuidance({ cwd: repository.root, step: "plan" })).rejects.toThrow("--goal is required");
    await expect(selectGuidance({ cwd: repository.root, step: "review", goalId: "goal-missing" })).rejects.toThrow("--change is required");
    await expect(selectGuidance({ cwd: repository.root, step: "goal", goalId: "goal-extra" })).rejects.toThrow(
      "goal guidance does not accept Goal or Change identity",
    );
  });
});
