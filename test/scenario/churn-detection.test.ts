import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { changeDecisionPath, createChange } from "../../src/change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { loadPlan, refreshChangeChurn, setPlannedTicketCount } from "../../src/plan.ts";
import { deriveCurrentCandidate, publishImplementationReport, publishReviewReport } from "../../src/report.ts";
import { issueTicket, reportPath } from "../../src/ticket.ts";
import { dispatchLocalImplementation, dispatchLocalReview } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const worker = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
const ticketId = process.env.SPIKE_TICKET_ID;
const output = process.env.SPIKE_OUTPUT_DIR;
const head = await git("rev-parse", "HEAD");
if (head !== process.env.SPIKE_INPUT_REVISION) throw new Error("worker checkout does not match Ticket input");
if (ticketId === "001") {
  await git("config", "user.name", "Controlled Implementer");
  await git("config", "user.email", "implementer@example.test");
  await writeFile("candidate.txt", "candidate A\n");
  await git("add", "candidate.txt");
  await git("commit", "--quiet", "-m", "candidate checkpoint");
  const workerRevision = await git("rev-parse", "HEAD");
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId, outcome: "completed", workerRevision, artifacts: [],
  };
  const body = "# Implementation evidence\n\n## Summary\n\nProduced Candidate A.\n\n## Verification\n\nControlled check passed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nIndependent review.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
  const bundle = Bun.spawn(["git", "bundle", "create", join(output, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
} else {
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId, outcome: "completed", reviewedRevision: head, producingImplementationTicketId: "001",
    findings: [{ id: "correctness-001", severity: "high", statement: "The same correctness issue remains open." }],
    acceptanceAssessment: [{
      criterion: "The Candidate is ready to land.", assessment: "not-met", evidence: "correctness-001 remains open.",
    }],
    verdict: "remediate", artifacts: [],
  };
  const body = "# Review evidence\n\n## Review statement\n\nCandidate A still requires remediation.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
}
`;

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

describe("deterministic Change churn guidance", () => {
  test("projects repeated review feedback into the mutable Plan without resolving the Change", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Detect non-convergence",
      outcome: "Warn the planner after repeated review feedback.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root,
      goalId,
      title: "Produce a reviewed Candidate",
      intent: "Exercise deterministic churn detection.",
      rationale: "Repeated findings should become planner guidance.",
      acceptanceCriteria: ["The Candidate is ready to land."],
    });
    const baseRevision = change.change.metadata.baseRevision;
    await setPlannedTicketCount(repository.root, goalId, "001", 1, "2026-03-25T10:00:00.000Z");

    await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Produce Candidate A.",
      executionPolicy: policy,
    });
    const implementation = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      command: ["bun", "-e", worker],
      worker: "controlled-implementer",
      model: "none",
    });
    const published = await publishImplementationReport({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      execution: implementation.execution,
      commitMessage: { summary: "Produce a reviewed Candidate" },
    });
    const candidateRevision = published.report.metadata.candidateRevision;

    for (const ticketId of ["002", "003", "004"]) {
      const reviewTicket = await issueTicket({
        cwd: repository.root,
        goalId,
        changeId: "001",
        role: "review",
        instruction: "Review exact Candidate A independently.",
        executionPolicy: policy,
      });
      expect(reviewTicket.ticket.metadata.ticketId).toBe(ticketId);
      const review = await dispatchLocalReview({
        cwd: repository.root,
        goalId,
        changeId: "001",
        ticketId,
        command: ["bun", "-e", worker],
        worker: `reviewer-${ticketId}`,
        model: "none",
      });
      await publishReviewReport({
        cwd: repository.root,
        goalId,
        changeId: "001",
        ticketId,
        execution: review.execution,
      });
    }

    const reportSources = await Promise.all(["001", "002", "003", "004"].map((ticketId) =>
      readFile(reportPath(repository.root, goalId, "001", ticketId), "utf8")
    ));
    const refreshed = await refreshChangeChurn(
      repository.root,
      goalId,
      "001",
      "2026-03-25T11:00:00.000Z",
    );

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
    expect(refreshed.plan.body).toContain("Recommendation: pause implementation and review the Change design with the operator.");
    expect((await loadPlan(repository.root, goalId)).body).toBe(refreshed.plan.body);

    expect(await deriveCurrentCandidate(repository.root, goalId, "001")).toMatchObject({ candidateRevision });
    expect(await Bun.file(changeDecisionPath(repository.root, goalId, "001")).exists()).toBe(false);
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(baseRevision);
    expect(await Promise.all(["001", "002", "003", "004"].map((ticketId) =>
      readFile(reportPath(repository.root, goalId, "001", ticketId), "utf8")
    ))).toEqual(reportSources);
  });
});
