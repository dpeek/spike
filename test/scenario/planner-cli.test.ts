import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, loadChangeDecision } from "../../src/change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { loadPlan } from "../../src/plan.ts";
import { publishImplementationReport, publishReviewReport } from "../../src/report.ts";
import { issueTicket, reportPath } from "../../src/ticket.ts";
import { dispatchLocalImplementation, dispatchLocalReview } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";


const worker = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
const output = process.env.SPIKE_OUTPUT_DIR;
const ticketId = process.env.SPIKE_TICKET_ID;
const head = await git("rev-parse", "HEAD");
if (head !== process.env.SPIKE_INPUT_REVISION) throw new Error("wrong input revision");
if (ticketId === "001") {
  await git("config", "user.name", "Scripted Implementer");
  await git("config", "user.email", "implementer@example.test");
  await writeFile("landed.txt", "approved candidate\n");
  await git("add", "landed.txt");
  await git("commit", "--quiet", "-m", "scripted checkpoint");
  const workerRevision = await git("rev-parse", "HEAD");
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId, outcome: "completed", workerRevision, artifacts: [],
  };
  const body = "# Implementation evidence\n\n## Summary\n\nAdded the approved candidate.\n\n## Verification\n\nScripted check passed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nIndependent review.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
  const bundle = Bun.spawn(["git", "bundle", "create", join(output, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
} else if (ticketId === "002") {
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId, outcome: "completed", reviewedRevision: head, producingImplementationTicketId: "001",
    findings: [], acceptanceAssessment: [{
      criterion: "The approved Candidate lands as one commit.", assessment: "met", evidence: "The exact tree contains landed.txt.",
    }], verdict: "approve", artifacts: [],
  };
  const body = "# Review evidence\n\n## Review statement\n\nThe exact Candidate is approved.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
} else throw new Error("unexpected Ticket " + ticketId);
`;

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

async function spike(repository: Awaited<ReturnType<typeof temporaryRepository>>, args: string[], stdin?: string) {
  const child = Bun.spawn([join(import.meta.dir, "..", "..", "bin", "spike"), ...args], {
    cwd: repository.root,
    env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    child.stdin!.write(stdin);
    child.stdin!.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (stderr) throw new Error(stderr);
  return { exitCode, output: JSON.parse(stdout) };
}

describe("planner CLI", () => {
  test("derives status, revises the Plan, and lands an approved Change", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Land through the planner CLI",
      outcome: "Advance only the dedicated integration ref.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Add approved behavior",
      intent: "Produce and independently review one Candidate.",
      rationale: "The CLI must derive readiness from Reports.",
      acceptanceCriteria: ["The approved Candidate lands as one commit."],
    });
    const baseRevision = change.change.metadata.baseRevision;

    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Produce the Candidate.",
      executionPolicy: policy,
    });
    const issuedStatus = await spike(repository, ["status", "--goal", goalId, "--json"]);
    expect(issuedStatus.output).toMatchObject({
      ok: true,
      data: {
        currentChange: {
          candidate: null,
          review: null,
          openTicket: { ticketId: "001", role: "implement", inputRevision: baseRevision },
          latestReport: null,
        },
      },
    });
    const implementation = await dispatchLocalImplementation({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "001",
      command: ["bun", "-e", worker],
      worker: "scripted-implementer",
    });
    const implemented = await publishImplementationReport({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      ticketId: "001",
      execution: implementation.execution,
      commitMessage: { summary: "Add approved behavior" },
    });
    const candidateRevision = implemented.report.metadata.candidateRevision;

    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      role: "review",
      instruction: "Review the exact Candidate.",
      executionPolicy: policy,
    });
    const review = await dispatchLocalReview({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", worker],
      worker: "scripted-reviewer",
    });
    await publishReviewReport({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      ticketId: "002",
      execution: review.execution,
    });

    await writeFile(join(repository.root, "operator-notes.txt"), "preserve this user file\n");
    const implementationEvidence = await readFile(reportPath(repository.project, goalId, "001", "001"), "utf8");
    const reviewEvidence = await readFile(reportPath(repository.project, goalId, "001", "002"), "utf8");

    const before = await spike(repository, ["status", "--goal", goalId, "--json"]);
    expect(before.exitCode).toBe(0);
    expect(before.output).toMatchObject({
      ok: true,
      command: "status",
      data: {
        goalId,
        integratedRevision: baseRevision,
        currentChange: {
          changeId: "001",
          candidate: { revision: candidateRevision, producingImplementationTicketId: "001" },
          review: { ticketId: "002", verdict: "approve", reviewedRevision: candidateRevision },
          openTicket: null,
          latestReport: { ticketId: "002", role: "review", outcome: "completed", verdict: "approve" },
          churnWarnings: [],
        },
        decisions: [],
        cleanup: { healthy: true, warnings: [] },
      },
    });

    const revisedBody = "# Plan: approved landing\n\n## Current focus\n\nLand reviewed Change 001.\n";
    const revised = await spike(repository, ["plan", "revise", "--goal", goalId, "--json"], revisedBody);
    expect(revised.output).toMatchObject({ ok: true, command: "plan revise", data: { body: revisedBody } });
    expect((await loadPlan(repository.project, goalId)).body).toBe(revisedBody);

    const landed = await spike(repository, ["change", "land", "--goal", goalId, "--change", "001", "--json"]);
    expect(landed.output).toMatchObject({
      ok: true,
      command: "change land",
      data: { goalId, changeId: "001", disposition: "land", approvedRevision: candidateRevision },
    });
    expect((await loadChangeDecision(repository.project, goalId, "001")).metadata.disposition).toBe("land");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(candidateRevision);

    const after = await spike(repository, ["status", "--goal", goalId, "--json"]);
    expect(after.output).toMatchObject({
      ok: true,
      data: {
        integratedRevision: candidateRevision,
        currentChange: null,
        decisions: [{ changeId: "001", disposition: "land", approvedRevision: candidateRevision }],
      },
    });
    expect(await readFile(reportPath(repository.project, goalId, "001", "001"), "utf8")).toBe(implementationEvidence);
    expect(await readFile(reportPath(repository.project, goalId, "001", "002"), "utf8")).toBe(reviewEvidence);
    expect(await readFile(join(repository.root, "operator-notes.txt"), "utf8")).toBe("preserve this user file\n");
    expect(await repository.git("rev-parse", "HEAD")).toBe(repository.head);
  }, 15_000);
});
