import { describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, changeDecisionPath, landChange } from "../../src/change.ts";
import type { CrashInjector, CrashMoment, ImmutableCommitPoint } from "../../src/crash.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { candidateRef } from "../../src/git-change.ts";
import { reconcileRepository } from "../../src/recovery.ts";
import {
  deriveCurrentCandidate,
  publishImplementationReport,
  publishReviewReport,
} from "../../src/report.ts";
import { issueReplacementTicket, issueTicket, reportPath, ticketPath } from "../../src/ticket.ts";
import {
  dispatchLocalImplementation,
  dispatchLocalReview,
  workerRecordPath,
} from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";


function crashAt(point: ImmutableCommitPoint, moment: CrashMoment): CrashInjector {
  return (event) => {
    if (event.point === point && event.moment === moment) throw new Error(`injected crash ${moment} ${point}`);
  };
}

const implementationWorker = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
await git("config", "user.name", "Crash Worker");
await git("config", "user.email", "crash-worker@example.test");
await writeFile("candidate.txt", "reviewed candidate\n");
await git("add", "candidate.txt");
await git("commit", "--quiet", "-m", "worker checkpoint");
const workerRevision = await git("rev-parse", "HEAD");
const metadata = {
  kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
  ticketId: process.env.SPIKE_TICKET_ID, outcome: "completed", workerRevision, artifacts: [],
};
const body = "# Implementation evidence\n\n## Summary\n\nProduced the candidate.\n\n## Verification\n\nControlled check passed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nIndependent review.\n";
await writeFile(join(process.env.SPIKE_OUTPUT_DIR, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
const bundle = Bun.spawn(["git", "bundle", "create", join(process.env.SPIKE_OUTPUT_DIR, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
if (code !== 0) throw new Error(stderr);
`;

const reviewWorker = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const ticketSource = await readFile(join(process.env.SPIKE_INPUT_DIR, "ticket.md"), "utf8");
const ticket = JSON.parse(ticketSource.slice(4, ticketSource.indexOf("\n---\n", 4)));
const metadata = {
  kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
  ticketId: process.env.SPIKE_TICKET_ID, outcome: "completed", reviewedRevision: process.env.SPIKE_INPUT_REVISION,
  producingImplementationTicketId: ticket.producingImplementationTicketId, findings: [],
  acceptanceAssessment: [{ criterion: "The candidate is independently approved.", assessment: "met", evidence: "candidate.txt contains the reviewed behavior." }],
  verdict: "approve", artifacts: [],
};
const body = "# Review evidence\n\n## Review statement\n\nThe exact candidate satisfies the acceptance criterion.\n";
await writeFile(join(process.env.SPIKE_OUTPUT_DIR, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
`;

const policy = { isolation: "workspace" as const, credentialGrants: [] };

describe("crash-point recovery", () => {
  test("reconciles crashes immediately before and after every immutable commit point", async () => {
    const repository = await temporaryRepository();

    await writeFile(join(repository.root, "host-staged.txt"), "host index state\n");
    await repository.git("add", "host-staged.txt");
    await writeFile(join(repository.root, "README.md"), "dirty host worktree\n");
    const hostBranch = await repository.git("symbolic-ref", "HEAD");
    const hostHead = await repository.git("rev-parse", "HEAD");
    const hostIndex = await repository.git("write-tree");
    const hostDiff = await repository.git("diff", "HEAD");

    await expect(
      createGoal({
        cwd: repository.root, hostPaths: repository.hostPaths, title: "Unpublished Goal",
        outcome: "Must remain staging only.",
        approval: "Approved.",
        crash: crashAt("goal-publication", "before"),
      }),
    ).rejects.toThrow("injected crash before goal-publication");
    const beforeGoalRecovery = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(beforeGoalRecovery.goals).toHaveLength(0);
    expect(beforeGoalRecovery.ignoredUnpublishedGoalIds).toHaveLength(1);

    await expect(
      createGoal({
        cwd: repository.root, hostPaths: repository.hostPaths, title: "Recover every commit point",
        outcome: "Land only the exact reviewed Candidate after deterministic restart.",
        approval: "Approved.",
        crash: crashAt("goal-publication", "after"),
      }),
    ).rejects.toThrow("injected crash after goal-publication");
    const goalDirectories = await readdir(join(repository.projectRoot, "goals"));
    const goalId = goalDirectories.find((id) => id !== beforeGoalRecovery.ignoredUnpublishedGoalIds[0]);
    expect(goalId).toBeDefined();
    if (goalId === undefined) throw new Error("published Goal was not found");

    const goalRecovery = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(goalRecovery.goals.map((goal) => goal.goalId)).toEqual([goalId]);
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(repository.head);

    await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Recover one reviewed Candidate",
      intent: "Exercise every Ticket, Report, and Change decision crash boundary.",
      rationale: "Only immutable evidence may advance workflow authority.",
      acceptanceCriteria: ["The candidate is independently approved."],
    });

    await expect(
      issueTicket({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        instruction: "Produce the candidate.",
        executionPolicy: policy,
        crash: crashAt("ticket-issuance", "after"),
      }),
    ).rejects.toThrow("injected crash after ticket-issuance");
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "001")).exists()).toBe(true);

    const issuedRecovery = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths, now: new Date("2026-04-01T00:00:00.000Z") });
    expect(issuedRecovery.goals[0]?.interruptedTickets[0]?.report.metadata).toMatchObject({
      outcome: "interrupted",
      execution: { adapter: "host", worker: "not-launched", model: "implementation-model", thinking: "medium" },
    });
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "002")).exists()).toBe(false);
    const replacement002 = await issueReplacementTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      interruptedTicketId: "001",
    });
    expect(replacement002.ticket.metadata).toMatchObject({
      ticketId: "002",
      replacesTicketId: "001",
      inputRevision: repository.head,
    });

    const implementationBefore = await dispatchLocalImplementation({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", implementationWorker],
      worker: "implementation-before",
    });
    await expect(
      publishImplementationReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "002",
        execution: implementationBefore.execution,
        commitMessage: { summary: "Recover immutable commit points" },
        crash: crashAt("implementation-report-publication", "before"),
      }),
    ).rejects.toThrow("injected crash before implementation-report-publication");
    expect(await Bun.file(reportPath(repository.project, goalId, "001", "002")).exists()).toBe(false);
    const unpublishedCandidateRef = candidateRef(goalId, "001", "002");
    const unpublishedCandidate = await repository.git("rev-parse", unpublishedCandidateRef);
    const quarantineRef = `refs/spike/quarantine/goals/${goalId}/changes/001/tickets/002/test-debris`;
    await repository.git("update-ref", quarantineRef, unpublishedCandidate);
    const unpublishedSubmission = await readFile(join(implementationBefore.exchange.outputDirectory, "submission.md"), "utf8");

    const implementationBeforeRecovery = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(implementationBeforeRecovery.goals[0]?.discardedRefs).toEqual(
      expect.arrayContaining([unpublishedCandidateRef, quarantineRef]),
    );
    expect(implementationBeforeRecovery.goals[0]?.ignoredOutputPaths).toContain(implementationBefore.exchange.outputDirectory);
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "003")).exists()).toBe(false);
    const replacement003 = await issueReplacementTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      interruptedTicketId: "002",
    });
    expect(replacement003.ticket.metadata.ticketId).toBe("003");
    expect(await deriveCurrentCandidate(repository.project, goalId, "001")).toBeUndefined();
    expect(await readFile(join(implementationBefore.exchange.outputDirectory, "submission.md"), "utf8")).toBe(unpublishedSubmission);
    expect(await Bun.file(join(implementationBefore.exchange.outputDirectory, "repository.bundle")).exists()).toBe(true);
    const interruptedImplementationReport = await readFile(reportPath(repository.project, goalId, "001", "002"), "utf8");

    const implementationAfter = await dispatchLocalImplementation({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "003",
      command: ["bun", "-e", implementationWorker],
      worker: "implementation-after",
    });
    await expect(
      publishImplementationReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "003",
        execution: implementationAfter.execution,
        commitMessage: { summary: "Recover immutable commit points" },
        crash: crashAt("implementation-report-publication", "after"),
      }),
    ).rejects.toThrow("injected crash after implementation-report-publication");
    const implementationReportSource = await readFile(reportPath(repository.project, goalId, "001", "003"), "utf8");
    expect(await Bun.file(workerRecordPath(repository.project, { goalId, changeId: "001", ticketId: "003" })).exists()).toBe(true);

    const implementationAfterRecovery = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    const candidate = await deriveCurrentCandidate(repository.project, goalId, "001");
    expect(candidate?.producingImplementationTicketId).toBe("003");
    expect(implementationAfterRecovery.goals[0]?.currentCandidates[0]?.candidateRevision).toBe(candidate?.candidateRevision);
    expect(await Bun.file(workerRecordPath(repository.project, { goalId, changeId: "001", ticketId: "003" })).exists()).toBe(false);
    expect(await readFile(reportPath(repository.project, goalId, "001", "003"), "utf8")).toBe(implementationReportSource);

    const reviewBeforeTicket = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      role: "review",
      instruction: "Review the exact Candidate.",
      executionPolicy: policy,
    });
    expect(reviewBeforeTicket.ticket.metadata.ticketId).toBe("004");
    const reviewBefore = await dispatchLocalReview({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "004",
      command: ["bun", "-e", reviewWorker],
      worker: "review-before",
    });
    await expect(
      publishReviewReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "004",
        execution: reviewBefore.execution,
        crash: crashAt("review-report-publication", "before"),
      }),
    ).rejects.toThrow("injected crash before review-report-publication");
    await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "005")).exists()).toBe(false);
    const replacement005 = await issueReplacementTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      interruptedTicketId: "004",
    });
    expect(replacement005.ticket.metadata).toMatchObject({
      ticketId: "005",
      replacesTicketId: "004",
      inputRevision: candidate?.candidateRevision,
    });
    const interruptedReviewReport = await readFile(reportPath(repository.project, goalId, "001", "004"), "utf8");

    const reviewAfter = await dispatchLocalReview({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      goalId,
      changeId: "001",
      ticketId: "005",
      command: ["bun", "-e", reviewWorker],
      worker: "review-after",
    });
    await expect(
      publishReviewReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "005",
        execution: reviewAfter.execution,
        crash: crashAt("review-report-publication", "after"),
      }),
    ).rejects.toThrow("injected crash after review-report-publication");
    const reviewReportSource = await readFile(reportPath(repository.project, goalId, "001", "005"), "utf8");
    expect(await Bun.file(workerRecordPath(repository.project, { goalId, changeId: "001", ticketId: "005" })).exists()).toBe(true);
    await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(await Bun.file(workerRecordPath(repository.project, { goalId, changeId: "001", ticketId: "005" })).exists()).toBe(false);

    if (candidate === undefined) throw new Error("authoritative Candidate was not recovered");
    const candidateTree = await repository.git("rev-parse", `${candidate.candidateRevision}^{tree}`);
    const unreviewedRevision = await repository.git(
      "commit-tree",
      candidateTree,
      "-p",
      repository.head,
      "-m",
      "Unreviewed projection debris",
    );
    await repository.git("update-ref", integratedRef(goalId), unreviewedRevision);
    await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(repository.head);

    await expect(
      landChange({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        crash: crashAt("change-decision-publication", "before"),
      }),
    ).rejects.toThrow("injected crash before change-decision-publication");
    expect(await Bun.file(changeDecisionPath(repository.project, goalId, "001")).exists()).toBe(false);
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(repository.head);

    await expect(
      landChange({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        crash: crashAt("change-decision-publication", "after"),
      }),
    ).rejects.toThrow("injected crash after change-decision-publication");
    const decisionSource = await readFile(changeDecisionPath(repository.project, goalId, "001"), "utf8");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(repository.head);
    await expect(landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001" })).rejects.toThrow("already has a terminal decision");

    await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(candidate.candidateRevision);
    expect(await readFile(changeDecisionPath(repository.project, goalId, "001"), "utf8")).toBe(decisionSource);
    expect(await readFile(reportPath(repository.project, goalId, "001", "002"), "utf8")).toBe(interruptedImplementationReport);
    expect(await readFile(reportPath(repository.project, goalId, "001", "003"), "utf8")).toBe(implementationReportSource);
    expect(await readFile(reportPath(repository.project, goalId, "001", "004"), "utf8")).toBe(interruptedReviewReport);
    expect(await readFile(reportPath(repository.project, goalId, "001", "005"), "utf8")).toBe(reviewReportSource);
    await expect(
      publishReviewReport({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        ticketId: "005",
        execution: reviewAfter.execution,
      }),
    ).rejects.toThrow("immutable Report already exists");

    await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Reserve a crashed Ticket ID",
      intent: "Prove pre-publication Ticket IDs are not reused.",
      rationale: "A prepared immutable parent directory burns the sequence number.",
      acceptanceCriteria: ["Ticket retries allocate a later ID."],
    });
    await expect(
      issueTicket({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "002",
        instruction: "Crash immediately before Ticket publication.",
        executionPolicy: policy,
        crash: crashAt("ticket-issuance", "before"),
      }),
    ).rejects.toThrow("injected crash before ticket-issuance");
    expect(await Bun.file(ticketPath(repository.project, goalId, "002", "001")).exists()).toBe(false);
    await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths });
    const retriedTicket = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "002",
      instruction: "Retry in a fresh Ticket.",
      executionPolicy: policy,
    });
    expect(retriedTicket.ticket.metadata.ticketId).toBe("002");

    expect(await repository.git("symbolic-ref", "HEAD")).toBe(hostBranch);
    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(hostIndex);
    expect(await repository.git("diff", "HEAD")).toBe(hostDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host worktree\n");
  }, 30_000);
});
