import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialPlan, detectChangeChurn, loadPlan, revisePlan } from "./plan.ts";

const goalId = "goal-00000000000000000000000000000001";

describe("Plan", () => {
  test("detects only the documented deterministic churn thresholds", () => {
    const quiet = detectChangeChurn(3, {
      ticketCount: 5,
      reports: [
        { ticketId: "001", role: "review", outcome: "completed", verdict: "remediate", findingIds: ["repeat-001"] },
        { ticketId: "002", role: "implement", outcome: "partial", findingIds: [] },
        { ticketId: "003", role: "implement", outcome: "failed", findingIds: [] },
        { ticketId: "004", role: "review", outcome: "completed", verdict: "remediate", findingIds: ["repeat-001"] },
      ],
    });
    expect(quiet).toEqual([]);

    const churn = detectChangeChurn(3, {
      ticketCount: 6,
      reports: [
        { ticketId: "001", role: "review", outcome: "completed", verdict: "remediate", findingIds: ["repeat-001"] },
        { ticketId: "002", role: "implement", outcome: "partial", findingIds: [] },
        { ticketId: "003", role: "review", outcome: "blocked", findingIds: [] },
        { ticketId: "004", role: "review", outcome: "completed", verdict: "remediate", findingIds: ["repeat-001"] },
        { ticketId: "005", role: "review", outcome: "completed", verdict: "remediate", findingIds: ["other-001", "repeat-001"] },
      ],
    });
    expect(churn).toEqual([
      { kind: "ticket-count", planned: 3, actual: 6 },
      { kind: "remediation-rounds", count: 3 },
      { kind: "reopened-finding", findingId: "repeat-001", reportCount: 3 },
      { kind: "consecutive-non-progress", ticketIds: ["002", "003"], outcomes: ["partial", "blocked"] },
    ]);
  });

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
