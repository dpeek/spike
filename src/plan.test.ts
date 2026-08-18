import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installImmutable, serializeDocument } from "./durable-state.ts";
import {
  createInitialPlan,
  detectChangeChurn,
  loadPlan,
  refreshChangeChurn,
  revisePlan,
  setPlannedTicketCount,
} from "./plan.ts";
import { reportPath, ticketPath } from "./ticket.ts";

const goalId = "goal-00000000000000000000000000000001";
const baseRevision = "0".repeat(40);
const candidateRevision = "1".repeat(40);
const workerRevision = "2".repeat(40);
const execution = {
  adapter: "fixture",
  isolation: "workspace" as const,
  worker: "controlled-worker",
  model: "none",
  startedAt: "2026-03-25T10:00:00.000Z",
  finishedAt: "2026-03-25T10:01:00.000Z",
};

async function installChurnHistory(root: string): Promise<string[]> {
  const ticketIds = ["001", "002", "003", "004"];
  for (const ticketId of ticketIds) {
    const implement = ticketId === "001";
    await installImmutable(
      root,
      ticketPath(root, goalId, "001", ticketId),
      serializeDocument(
        implement
          ? {
              kind: "ticket",
              goalId,
              changeId: "001",
              ticketId,
              issuedAt: "2026-03-25T10:00:00.000Z",
              inputRevision: baseRevision,
              executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
              role: "implement",
            }
          : {
              kind: "ticket",
              goalId,
              changeId: "001",
              ticketId,
              issuedAt: "2026-03-25T10:00:00.000Z",
              inputRevision: candidateRevision,
              executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
              role: "review",
              producingImplementationTicketId: "001",
            },
        implement ? "# Implement Candidate A" : "# Review Candidate A",
      ),
    );

    await installImmutable(
      root,
      reportPath(root, goalId, "001", ticketId),
      serializeDocument(
        implement
          ? {
              kind: "report",
              goalId,
              changeId: "001",
              ticketId,
              role: "implement",
              outcome: "completed",
              publishedAt: "2026-03-25T10:01:00.000Z",
              baseRevision,
              inputRevision: baseRevision,
              workerRevision,
              candidateRevision,
              artifacts: [],
              execution,
            }
          : {
              kind: "report",
              goalId,
              changeId: "001",
              ticketId,
              role: "review",
              outcome: "completed",
              publishedAt: "2026-03-25T10:01:00.000Z",
              reviewedRevision: candidateRevision,
              producingImplementationTicketId: "001",
              findings: [
                {
                  id: "correctness-001",
                  severity: "high",
                  statement: "The same correctness issue remains open.",
                },
              ],
              acceptanceAssessment: [
                {
                  criterion: "The Candidate is ready to land.",
                  assessment: "not-met",
                  evidence: "correctness-001 remains open.",
                },
              ],
              reviewStatement: "Candidate A still requires remediation.",
              reviewer: `reviewer-${ticketId}`,
              verdict: "remediate",
              artifacts: [],
              execution,
            },
        implement ? "# Implementation evidence" : "# Review evidence",
      ),
    );
  }
  return ticketIds;
}

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

  test("refreshes churn guidance from durable Ticket and Report history", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-plan-"));
    try {
      await createInitialPlan(root, goalId, "Detect churn", "Warn after repeated feedback.", "2026-03-25T09:00:00.000Z");
      await setPlannedTicketCount(root, goalId, "001", 1, "2026-03-25T09:01:00.000Z");
      const ticketIds = await installChurnHistory(root);
      const reportSources = await Promise.all(
        ticketIds.map((ticketId) => readFile(reportPath(root, goalId, "001", ticketId), "utf8")),
      );

      const refreshed = await refreshChangeChurn(root, goalId, "001", "2026-03-25T11:00:00.000Z");
      expect(refreshed.indicators).toEqual([
        { kind: "ticket-count", planned: 1, actual: 4 },
        { kind: "remediation-rounds", count: 3 },
        { kind: "reopened-finding", findingId: "correctness-001", reportCount: 3 },
      ]);
      expect(refreshed.plan.metadata.updatedAt).toBe("2026-03-25T11:00:00.000Z");
      expect(refreshed.plan.body).toContain("Change 001 churn detected");
      expect(refreshed.plan.body).toContain("planned Tickets: 1; actual Tickets: 4");
      expect(refreshed.plan.body).toContain("3 completed review Reports requested remediation");
      expect(refreshed.plan.body).toContain("`correctness-001` appeared in 3 review Reports");
      expect((await loadPlan(root, goalId)).body).toBe(refreshed.plan.body);
      expect(
        await Promise.all(ticketIds.map((ticketId) => readFile(reportPath(root, goalId, "001", ticketId), "utf8"))),
      ).toEqual(reportSources);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
