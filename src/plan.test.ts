import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialPlan, loadPlan, revisePlan } from "./plan.ts";

const goalId = "goal-00000000000000000000000000000001";

describe("Plan", () => {
  test("revises planner working memory without changing authoritative Goal evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-plan-"));
    const goalPath = join(root, ".spike", "goals", goalId, "goal.md");
    try {
      await createInitialPlan(
        root,
        goalId,
        "Plan a Goal",
        "Keep working memory durable.",
        "2026-03-19T10:00:00.000Z",
      );
      await writeFile(goalPath, "authoritative Goal evidence\n");

      const revised = await revisePlan(
        root,
        goalId,
        "# Revised Plan\n\nFirst create Change 001.",
        "2026-03-19T11:00:00.000Z",
      );

      expect(revised.metadata.updatedAt).toBe("2026-03-19T11:00:00.000Z");
      expect((await loadPlan(root, goalId)).body).toBe("# Revised Plan\n\nFirst create Change 001.\n");
      expect(await readFile(goalPath, "utf8")).toBe("authoritative Goal evidence\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
