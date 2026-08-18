import { afterEach, describe, expect, test } from "bun:test";
import { createChange } from "./change.ts";
import { createGoal } from "./goal.ts";
import { temporaryRepository } from "../test/support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.remove();
});

function createWithCriteria(root: string, goalId: string, acceptanceCriteria: string[]) {
  return createChange({
    cwd: root,
    goalId,
    title: "Canonical criteria",
    intent: "Keep review assessment unambiguous.",
    rationale: "Review Reports identify criteria by their canonical text.",
    acceptanceCriteria,
  });
}

describe("Change acceptance criteria", () => {
  test("rejects ambiguous criteria and preserves distinct canonical criteria", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Validate acceptance criteria",
      outcome: "Create Changes whose criteria can be assessed exactly once.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;

    await expect(
      createWithCriteria(repository.root, goalId, ["The workflow lands.", "  The workflow lands.  "]),
    ).rejects.toThrow("Acceptance criteria must be unique");
    await expect(
      createWithCriteria(repository.root, goalId, ["The workflow lands.\nEvidence is retained."]),
    ).rejects.toThrow("Acceptance criterion must be one line");
    await expect(
      createWithCriteria(repository.root, goalId, ["The workflow lands.\rEvidence is retained."]),
    ).rejects.toThrow("Acceptance criterion must be one line");

    const created = await createWithCriteria(repository.root, goalId, [
      "The workflow lands.",
      "Evidence is retained.",
    ]);
    expect(created.change.body).toContain("- The workflow lands.\n- Evidence is retained.");
  });
});
