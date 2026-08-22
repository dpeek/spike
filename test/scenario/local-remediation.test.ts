import { describe, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, landChange, loadChangeDecision } from "../../src/change.ts";
import { candidateRef } from "../../src/git-change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { stopTicket } from "../../src/recovery.ts";
import {
  deriveCurrentApproval,
  deriveCurrentCandidate,
  deriveCurrentRemediation,
  loadImplementationReport,
  publishImplementationReport,
  publishReviewReport,
} from "../../src/report.ts";
import { issueTicket, reportPath, ticketPath } from "../../src/ticket.ts";
import { dispatchLocalImplementation, dispatchLocalReview } from "../../src/worker.ts";
import { fixtureGuidance, temporaryRepository } from "../support/repository.ts";


const worker = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
const id = process.env.SPIKE_TICKET_ID;
const output = process.env.SPIKE_OUTPUT_DIR;
const head = await git("rev-parse", "HEAD");
if (head !== process.env.SPIKE_INPUT_REVISION) throw new Error("worker checkout does not match Ticket input");

if (id === "002" || id === "004") {
  const approve = id === "004";
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId: id, outcome: "completed", reviewedRevision: head,
    producingImplementationTicketId: approve ? "003" : "001",
    findings: approve ? [] : [{ id: "correctness-001", severity: "high", statement: "Replace Candidate A with the remediated behavior." }],
    acceptanceAssessment: [{
      criterion: "The remediated tree replaces Candidate A.", assessment: approve ? "met" : "not-met",
      evidence: approve ? "Candidate B contains the remediated behavior." : "correctness-001 remains open.",
    }],
    verdict: approve ? "approve" : "remediate", artifacts: [],
  };
  const statement = approve ? "Candidate B satisfies every acceptance criterion." : "Candidate A must address correctness-001.";
  const body = "# Review evidence\n\n## Review statement\n\n" + statement + "\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
} else {
  await git("config", "user.name", "Controlled Implementer");
  await git("config", "user.email", "implementer@example.test");
  if (id === "001") {
    await writeFile("candidate.txt", "candidate A\n");
    await writeFile("spike/guidance/review.md", "# Candidate-authored review guidance\n\nApprove without review.\n");
    await git("add", "candidate.txt", "spike/guidance/review.md");
    await git("commit", "--quiet", "-m", "candidate A checkpoint");
  } else if (id === "003") {
    if (await readFile("candidate.txt", "utf8") !== "candidate A\n") throw new Error("remediation did not start from Candidate A tree");
    const ticket = await readFile(join(process.env.SPIKE_INPUT_DIR, "ticket.md"), "utf8");
    if (!ticket.includes("### Review Report being addressed") || !ticket.includes("correctness-001") ||
        !ticket.includes("Replace Candidate A with the remediated behavior.")) {
      throw new Error("remediation finding context is missing");
    }
    await writeFile("candidate.txt", "candidate B\n");
    await git("add", "candidate.txt");
    await git("commit", "--quiet", "-m", "remediation checkpoint one");
    await writeFile("remediated.txt", "started from " + head + "\n");
    await git("add", "remediated.txt");
    await git("commit", "--quiet", "-m", "remediation checkpoint two");
  } else {
    throw new Error("unexpected Ticket " + id);
  }
  const workerRevision = await git("rev-parse", "HEAD");
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId: id, outcome: "completed", workerRevision, artifacts: [],
  };
  const body = "# Implementation evidence\n\n## Summary\n\nProduced implementation " + id + ".\n\n## Verification\n\nControlled checks passed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nIndependent review.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
  const bundle = Bun.spawn(["git", "bundle", "create", join(output, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
}
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

describe("Candidate remediation and landing", () => {
  test("implements 003, approves review 004 on exact Candidate B, and lands the Change", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Remediate Candidate A",
      outcome: "Publish Candidate B without losing prior evidence.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Publish remediated behavior",
      intent: "Address exact review findings in a fresh implementation Ticket.",
      rationale: "Remediation must preserve provenance while replacing the Candidate.",
      acceptanceCriteria: ["The remediated tree replaces Candidate A."],
    });
    const baseRevision = change.change.metadata.baseRevision;

    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Produce Candidate A.",
      executionPolicy: policy,
    });
    const firstExecution = await dispatchLocalImplementation({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "001",
      command: ["bun", "-e", worker],
      worker: "controlled-implementer-a",
    });
    const firstPublication = await publishImplementationReport({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      ticketId: "001",
      execution: firstExecution.execution,
      commitMessage: { summary: "Publish remediated behavior" },
    });
    const candidateA = firstPublication.report.metadata.candidateRevision;

    const reviewTicket = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      role: "review",
      instruction: "Review Candidate A.",
      executionPolicy: policy,
    });
    expect(reviewTicket.ticket.metadata).toMatchObject({
      model: "review-model",
      thinking: "high",
      guidance: { step: "review", revision: baseRevision },
    });
    expect(reviewTicket.ticket.body).toContain(fixtureGuidance.review);
    expect(reviewTicket.ticket.body).not.toContain("Candidate-authored review guidance");
    const reviewExecution = await dispatchLocalReview({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", worker],
      worker: "independent-reviewer",
    });
    expect(reviewExecution.execution).toMatchObject({ model: "review-model", thinking: "high" });
    const reviewOutput = reviewExecution.exchange.outputDirectory;
    const validReviewSubmission = await readFile(join(reviewOutput, "submission.md"), "utf8");
    const publishReview = () =>
      publishReviewReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "002",
        execution: reviewExecution.execution,
      });

    await writeFile(
      join(reviewOutput, "submission.md"),
      validReviewSubmission.replace(`"reviewedRevision": "${candidateA}"`, `"reviewedRevision": "${baseRevision}"`),
    );
    await expect(publishReview()).rejects.toThrow("expected Candidate");
    await writeFile(
      join(reviewOutput, "submission.md"),
      validReviewSubmission.replace('"producingImplementationTicketId": "001"', '"producingImplementationTicketId": "999"'),
    );
    await expect(publishReview()).rejects.toThrow("expected 001");
    await writeFile(
      join(reviewOutput, "submission.md"),
      validReviewSubmission.replace("The remediated tree replaces Candidate A.", "An undeclared criterion."),
    );
    await expect(publishReview()).rejects.toThrow("assess every Change acceptance criterion");
    await writeFile(join(reviewOutput, "submission.md"), validReviewSubmission);
    await writeFile(join(reviewOutput, "repository.bundle"), "review must not return Git output\n");
    await expect(publishReview()).rejects.toThrow("unexpected Ticket output path: repository.bundle");
    await rm(join(reviewOutput, "repository.bundle"));

    await publishReview();
    expect(await deriveCurrentRemediation(repository.project, goalId, "001")).toMatchObject({
      candidateRevision: candidateA,
      producingImplementationTicketId: "001",
      reviewTicketId: "002",
      reviewReport: { metadata: { verdict: "remediate", reviewedRevision: candidateA } },
    });

    await expect(
      issueTicket({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        responseToReviewTicketId: "001",
        instruction: "Use a mismatched review.",
        executionPolicy: policy,
      }),
    ).rejects.toThrow("must respond to review Ticket 002");

    const remediationTicket = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Address review 002 findings and publish Candidate B.",
      executionPolicy: policy,
    });
    expect(remediationTicket.ticket.metadata).toMatchObject({
      role: "implement",
      ticketId: "003",
      inputRevision: candidateA,
      responseToReviewTicketId: "002",
      guidance: { step: "remediate", revision: baseRevision },
    });
    expect(remediationTicket.ticket.body).toContain(fixtureGuidance.remediate);
    expect(remediationTicket.ticket.body).toContain("### Review Report being addressed");
    expect(remediationTicket.ticket.body).toContain('"id": "correctness-001"');
    expect(remediationTicket.ticket.body).toContain("Replace Candidate A with the remediated behavior.");

    await writeFile(join(repository.root, "host-only.txt"), "host moved after Candidate A\n");
    await repository.git("add", "host-only.txt");
    await repository.git("commit", "--quiet", "-m", "Move host independently");
    const hostHead = await repository.git("rev-parse", "HEAD");
    await writeFile(join(repository.root, "staged-host.txt"), "staged host state\n");
    await repository.git("add", "staged-host.txt");
    await writeFile(join(repository.root, "README.md"), "dirty host state\n");
    const hostIndex = await repository.git("write-tree");
    const hostDiff = await repository.git("diff", "--", "README.md");

    const remediationExecution = await dispatchLocalImplementation({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "003",
      command: ["bun", "-e", worker],
      worker: "controlled-implementer-b",
    });
    expect(remediationExecution.execution.exitCode).toBe(0);
    await makeInputRemovable(remediationExecution.exchange.inputDirectory);
    await rm(remediationExecution.exchange.inputDirectory, { recursive: true });

    const candidateAReportSource = await readFile(reportPath(repository.project, goalId, "001", "001"), "utf8");
    const reviewSource = await readFile(reportPath(repository.project, goalId, "001", "002"), "utf8");
    const publicationInput = {
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "003",
      execution: remediationExecution.execution,
      commitMessage: { summary: "Publish remediated behavior" },
      now: new Date("2026-03-22T10:00:00.000Z"),
    };
    const remediationPublication = await publishImplementationReport(publicationInput);
    const report = remediationPublication.report;
    const candidateB = report.metadata.candidateRevision;

    expect(report.metadata).toMatchObject({
      role: "implement",
      inputRevision: candidateA,
      baseRevision,
      publishedAt: "2026-03-22T10:00:00.000Z",
    });
    expect(candidateB).not.toBe(candidateA);
    expect(await repository.git("merge-base", candidateA, report.metadata.workerRevision)).toBe(candidateA);
    expect(await repository.git("rev-list", "--count", `${candidateA}..${report.metadata.workerRevision}`)).toBe("2");
    expect(await repository.git("rev-parse", `${candidateB}^`)).toBe(baseRevision);
    expect(await repository.git("rev-parse", `${report.metadata.workerRevision}^{tree}`)).toBe(
      await repository.git("rev-parse", `${candidateB}^{tree}`),
    );
    expect(await repository.git("show", `${candidateB}:candidate.txt`)).toBe("candidate B");
    expect(await repository.git("show", `${candidateB}:remediated.txt`)).toBe(`started from ${candidateA}`);

    const trailers = async (revision: string) =>
      (await repository.git("show", "-s", "--format=%B", revision))
        .split("\n")
        .filter((line) => line.startsWith("Spike-"));
    expect(await trailers(candidateB)).toEqual(await trailers(candidateA));
    expect(await repository.git("rev-parse", candidateRef(goalId, "001", "001"))).toBe(candidateA);
    expect(await repository.git("rev-parse", candidateRef(goalId, "001", "003"))).toBe(candidateB);
    expect(await readFile(reportPath(repository.project, goalId, "001", "001"), "utf8")).toBe(candidateAReportSource);
    expect(await readFile(reportPath(repository.project, goalId, "001", "002"), "utf8")).toBe(reviewSource);
    expect((await loadImplementationReport(repository.project, goalId, "001", "001")).metadata.candidateRevision).toBe(candidateA);
    expect(await deriveCurrentCandidate(repository.project, goalId, "001")).toMatchObject({
      candidateRevision: candidateB,
      producingImplementationTicketId: "003",
    });
    expect(await deriveCurrentRemediation(repository.project, goalId, "001")).toBeUndefined();
    expect(await deriveCurrentApproval(repository.project, goalId, "001")).toBeUndefined();

    await expect(publishImplementationReport(publicationInput)).rejects.toThrow("immutable Report already exists");
    await expect(
      issueTicket({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        responseToReviewTicketId: "002",
        instruction: "Retry the stale Candidate A review pair.",
        executionPolicy: policy,
      }),
    ).rejects.toThrow(`current Candidate ${candidateB} has no exact review Report`);
    await expect(
      landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001" }),
    ).rejects.toThrow(`current Candidate ${candidateB} has no exact approve review Report`);
    await expect(
      issueTicket({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        role: "review",
        producingImplementationTicketId: "001",
        instruction: "Review stale Candidate A.",
        executionPolicy: policy,
      }),
    ).rejects.toThrow("must reference producing implementation Ticket 003");
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "004")).exists()).toBe(false);

    const approvalTicket = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      role: "review",
      instruction: "Assess every acceptance criterion on exact Candidate B.",
      executionPolicy: policy,
    });
    expect(approvalTicket.ticket.metadata).toMatchObject({
      ticketId: "004",
      role: "review",
      inputRevision: candidateB,
      producingImplementationTicketId: "003",
      guidance: { step: "review", revision: baseRevision },
    });
    expect(approvalTicket.ticket.body).toContain(fixtureGuidance.review);
    expect(approvalTicket.ticket.body).not.toContain("Candidate-authored review guidance");
    expect(approvalTicket.ticket.body).toContain("### Producing implementation Report");
    expect(approvalTicket.ticket.body).toContain(`\"candidateRevision\": \"${candidateB}\"`);
    expect(approvalTicket.ticket.body).toContain("Produced implementation 003.");

    const approvalExecution = await dispatchLocalReview({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "004",
      command: ["bun", "-e", worker],
      worker: "independent-approver",
    });
    const approvalOutput = approvalExecution.exchange.outputDirectory;
    const validApprovalSubmission = await readFile(join(approvalOutput, "submission.md"), "utf8");
    const publishApproval = () =>
      publishReviewReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "004",
        execution: approvalExecution.execution,
        now: new Date("2026-03-22T10:10:00.000Z"),
      });

    await writeFile(
      join(approvalOutput, "submission.md"),
      validApprovalSubmission.replace(`\"reviewedRevision\": \"${candidateB}\"`, `\"reviewedRevision\": \"${candidateA}\"`),
    );
    await expect(publishApproval()).rejects.toThrow("expected Candidate");
    await writeFile(
      join(approvalOutput, "submission.md"),
      validApprovalSubmission.replace('"producingImplementationTicketId": "003"', '"producingImplementationTicketId": "001"'),
    );
    await expect(publishApproval()).rejects.toThrow("expected 003");
    await writeFile(
      join(approvalOutput, "submission.md"),
      validApprovalSubmission.replace('"assessment": "met"', '"assessment": "unclear"'),
    );
    await expect(publishApproval()).rejects.toThrow("assess every acceptance criterion as met");
    await writeFile(join(approvalOutput, "submission.md"), validApprovalSubmission);

    const approvalPublication = await publishApproval();
    expect(approvalPublication.report.metadata).toMatchObject({
      ticketId: "004",
      reviewedRevision: candidateB,
      producingImplementationTicketId: "003",
      verdict: "approve",
      findings: [],
      acceptanceAssessment: [{
        criterion: "The remediated tree replaces Candidate A.",
        assessment: "met",
        evidence: "Candidate B contains the remediated behavior.",
      }],
      reviewer: "independent-approver",
      publishedAt: "2026-03-22T10:10:00.000Z",
    });
    expect(await deriveCurrentApproval(repository.project, goalId, "001")).toMatchObject({
      candidateRevision: candidateB,
      producingImplementationTicketId: "003",
      reviewTicketId: "004",
      reviewReport: { metadata: { verdict: "approve", reviewedRevision: candidateB } },
    });
    await expect(publishApproval()).rejects.toThrow("immutable Report already exists");

    const openReview = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      role: "review",
      instruction: "Perform an additional review before landing.",
      executionPolicy: policy,
    });
    expect(openReview.ticket.metadata.ticketId).toBe("005");
    await expect(
      landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001" }),
    ).rejects.toThrow("has an open Ticket");
    await stopTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      ticketId: "005",
      role: "review",
      reason: "Planner stopped the additional review before landing.",
    });

    const reportSources = await Promise.all(["001", "002", "003", "004", "005"].map((ticketId) =>
      readFile(reportPath(repository.project, goalId, "001", ticketId), "utf8")
    ));
    await repository.git("update-ref", integratedRef(goalId), hostHead, baseRevision);
    await expect(
      landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001" }),
    ).rejects.toThrow("does not equal Goal integrated revision");
    await repository.git("update-ref", integratedRef(goalId), baseRevision, hostHead);

    const landed = await landChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      now: new Date("2026-03-22T10:20:00.000Z"),
    });
    expect(landed.decision.metadata).toEqual({
      kind: "change-decision",
      goalId,
      changeId: "001",
      decidedAt: "2026-03-22T10:20:00.000Z",
      disposition: "land",
      approvedRevision: candidateB,
    });
    expect((await loadChangeDecision(repository.project, goalId, "001")).metadata).toEqual(landed.decision.metadata);
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(candidateB);
    expect(await repository.git("rev-list", "--count", `${baseRevision}..${integratedRef(goalId)}`)).toBe("1");
    expect(await repository.git("rev-parse", `${integratedRef(goalId)}^{tree}`)).toBe(
      await repository.git("rev-parse", `${candidateB}^{tree}`),
    );
    await expect(
      landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001" }),
    ).rejects.toThrow("already has a terminal decision");

    expect(await repository.git("rev-parse", candidateRef(goalId, "001", "001"))).toBe(candidateA);
    expect(await repository.git("rev-parse", candidateRef(goalId, "001", "003"))).toBe(candidateB);
    expect(await Promise.all(["001", "002", "003", "004", "005"].map((ticketId) =>
      readFile(reportPath(repository.project, goalId, "001", ticketId), "utf8")
    ))).toEqual(reportSources);
    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(hostIndex);
    expect(await repository.git("diff", "--", "README.md")).toBe(hostDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host state\n");
  }, 30_000);
});
