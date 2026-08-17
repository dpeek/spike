import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import {
  deriveCurrentCandidate,
  loadReviewReport,
  publishImplementationReport,
  publishReviewReport,
} from "../../src/report.ts";
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

const implementationWorker = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
await git("config", "user.name", "Implementer");
await git("config", "user.email", "implementer@example.test");
await writeFile("candidate.txt", "candidate A\n");
await git("add", "candidate.txt");
await git("commit", "--quiet", "-m", "candidate A checkpoint");
const workerRevision = await git("rev-parse", "HEAD");
const metadata = {
  kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
  ticketId: process.env.SPIKE_TICKET_ID, outcome: "completed", workerRevision, artifacts: [],
};
const body = "# Implementation evidence\n\n## Summary\n\nProduced Candidate A.\n\n## Verification\n\nPassed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nReview.\n";
await writeFile(join(process.env.SPIKE_OUTPUT_DIR, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
const bundle = Bun.spawn(["git", "bundle", "create", join(process.env.SPIKE_OUTPUT_DIR, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
if (code !== 0) throw new Error(stderr);
`;

const reviewWorker = String.raw`
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
const reviewedRevision = await git("rev-parse", "HEAD");
const artifact = "reviewed " + reviewedRevision + "\n";
await mkdir(join(process.env.SPIKE_OUTPUT_DIR, "artifacts"));
await writeFile(join(process.env.SPIKE_OUTPUT_DIR, "artifacts", "review.txt"), artifact);
const metadata = {
  kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
  ticketId: process.env.SPIKE_TICKET_ID, outcome: "completed", reviewedRevision,
  producingImplementationTicketId: "001",
  findings: [{ id: "correctness-001", severity: "high", statement: "Candidate needs remediation." }],
  acceptanceAssessment: [{ criterion: "Candidate A is independently reviewed.", assessment: "not-met", evidence: "correctness-001 remains open." }],
  verdict: "remediate",
  artifacts: [{ path: "artifacts/review.txt", sha256: createHash("sha256").update(artifact).digest("hex") }],
};
const body = "# Review evidence\n\n## Review statement\n\nCandidate A requires remediation before approval.\n";
await writeFile(join(process.env.SPIKE_OUTPUT_DIR, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
`;

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

async function makeInputRemovable(inputDirectory: string): Promise<void> {
  await chmod(inputDirectory, 0o700);
  await Promise.all([
    chmod(join(inputDirectory, "ticket.md"), 0o600),
    chmod(join(inputDirectory, "context.md"), 0o600),
    chmod(join(inputDirectory, "repository.bundle"), 0o600),
  ]);
}

describe("exact Candidate review", () => {
  test("implements 001, reviews Candidate A as remediate in 002, and publishes only declared exited-worker output", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Review Candidate A",
      outcome: "Record independent remediation findings.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root,
      goalId,
      title: "Produce and review Candidate A",
      intent: "Review the exact normalized implementation Candidate.",
      rationale: "Review evidence must select one immutable revision.",
      acceptanceCriteria: ["Candidate A is independently reviewed."],
    });
    const implementationTicket = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Produce Candidate A.",
      executionPolicy: policy,
    });
    expect(implementationTicket.ticket.metadata.ticketId).toBe("001");
    const implementation = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      command: ["bun", "-e", implementationWorker],
      worker: "controlled-implementer",
      model: "none",
    });
    const implementationReport = await publishImplementationReport({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      execution: implementation.execution,
      commitMessage: { summary: "Produce Candidate A" },
    });
    const candidateA = implementationReport.report.metadata.candidateRevision;
    expect(await deriveCurrentCandidate(repository.root, goalId, "001")).toMatchObject({
      candidateRevision: candidateA,
      producingImplementationTicketId: "001",
    });

    await expect(
      issueTicket({
        cwd: repository.root,
        goalId,
        changeId: "001",
        role: "review",
        inputRevision: repository.head,
        instruction: "Review the wrong revision.",
        executionPolicy: policy,
      }),
    ).rejects.toThrow("must use current Candidate");
    await expect(
      issueTicket({
        cwd: repository.root,
        goalId,
        changeId: "001",
        role: "review",
        producingImplementationTicketId: "999",
        instruction: "Review with the wrong producer.",
        executionPolicy: policy,
      }),
    ).rejects.toThrow("must reference producing implementation Ticket 001");

    const reviewTicket = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      role: "review",
      instruction: "Review Candidate A and report remediation findings.",
      executionPolicy: policy,
    });
    expect(reviewTicket.ticket.metadata).toMatchObject({
      role: "review",
      ticketId: "002",
      inputRevision: candidateA,
      producingImplementationTicketId: "001",
    });
    expect(reviewTicket.ticket.body).toContain("### Producing implementation Report");
    expect(reviewTicket.ticket.body).toContain(`"candidateRevision": "${candidateA}"`);

    await writeFile(join(repository.root, "host-only.txt"), "host moved\n");
    await repository.git("add", "host-only.txt");
    await repository.git("commit", "--quiet", "-m", "Move host after Candidate A");
    const hostHead = await repository.git("rev-parse", "HEAD");
    await writeFile(join(repository.root, "README.md"), "dirty host review edit\n");
    const dirtyDiff = await repository.git("diff", "--", "README.md");
    const indexTree = await repository.git("write-tree");

    const review = await dispatchLocalReview({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", reviewWorker],
      worker: "independent-reviewer",
      model: "none",
    });
    expect(review.execution.exitCode).toBe(0);
    const output = review.exchange.outputDirectory;
    const validSubmission = await readFile(join(output, "submission.md"), "utf8");
    const publication = () =>
      publishReviewReport({
        cwd: repository.root,
        goalId,
        changeId: "001",
        ticketId: "002",
        execution: review.execution,
        now: new Date("2026-03-21T10:00:00.000Z"),
      });

    await writeFile(join(output, "submission.md"), validSubmission.replace("correctness-001", "INVALID ID"));
    await expect(publication()).rejects.toThrow();
    await writeFile(join(output, "submission.md"), validSubmission.replace('"severity": "high"', '"severity": "urgent"'));
    await expect(publication()).rejects.toThrow();
    await writeFile(
      join(output, "submission.md"),
      validSubmission.replace("Candidate A is independently reviewed.", "An undeclared criterion."),
    );
    await expect(publication()).rejects.toThrow("assess every Change acceptance criterion");
    await writeFile(join(output, "submission.md"), validSubmission.replace('"verdict": "remediate"', '"verdict": "approve"'));
    await expect(publication()).rejects.toThrow();
    await writeFile(
      join(output, "submission.md"),
      validSubmission.replace(`"reviewedRevision": "${candidateA}"`, `"reviewedRevision": "${repository.head}"`),
    );
    await expect(publication()).rejects.toThrow("expected Candidate");
    await writeFile(
      join(output, "submission.md"),
      validSubmission.replace('"producingImplementationTicketId": "001"', '"producingImplementationTicketId": "999"'),
    );
    await expect(publication()).rejects.toThrow("expected 001");
    await writeFile(join(output, "submission.md"), validSubmission);
    await writeFile(join(output, "repository.bundle"), "review must not return Git output\n");
    await expect(publication()).rejects.toThrow("unexpected Ticket output path: repository.bundle");
    await rm(join(output, "repository.bundle"));
    expect(await Bun.file(reportPath(repository.root, goalId, "001", "002")).exists()).toBe(false);

    await makeInputRemovable(review.exchange.inputDirectory);
    await rm(review.exchange.inputDirectory, { recursive: true });
    const published = await publication();
    expect(published.report.metadata).toMatchObject({
      role: "review",
      reviewedRevision: candidateA,
      producingImplementationTicketId: "001",
      reviewer: "independent-reviewer",
      verdict: "remediate",
      findings: [{ id: "correctness-001", severity: "high", statement: "Candidate needs remediation." }],
    });
    expect(published.report.metadata.artifacts[0]?.sha256).toBe(
      createHash("sha256").update(`reviewed ${candidateA}\n`).digest("hex"),
    );
    expect((await loadReviewReport(repository.root, goalId, "001", "002")).body).toContain(
      "Candidate A requires remediation",
    );
    await expect(publication()).rejects.toThrow("immutable Report already exists");

    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(indexTree);
    expect(await repository.git("diff", "--", "README.md")).toBe(dirtyDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host review edit\n");
  });
});
