import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { changeDecisionPath, createChange, landChange } from "../../src/change.ts";
import { candidateRef } from "../../src/git-change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { revisePlan } from "../../src/plan.ts";
import { publishImplementationReport, publishReviewReport } from "../../src/report.ts";
import { deriveRepositoryStatus } from "../../src/status.ts";
import { issueTicket, reportPath, ticketPath } from "../../src/ticket.ts";
import {
  dispatchLocalImplementation,
  dispatchLocalReview,
  exchangePath,
  loadRecordedWorkerIfPresent,
  workerRecordPath,
} from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };
const timestamp = new Date(0);
const completionUrl = pathToFileURL(join(import.meta.dir, "..", "..", "src", "worker-completion.ts")).href;

/** Explicit rendezvous proves overlap without timers or service processes. */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => { if (++arrived === parties) release(); await ready; };
}

/**
 * This is the worker-side production completion seam.  Implementations change
 * a Goal-qualified file; completeWorker snapshots it and writes the canonical
 * Submission/bundle. Reviews complete the exact Candidate without a checkout
 * mutation. Nothing in this scenario formats Submissions, Reports, or commits.
 */
const worker = String.raw`
import { writeFile } from "node:fs/promises";
import { completeWorker, parseWorkerProtocolContext } from ${JSON.stringify(completionUrl)};

const protocol = parseWorkerProtocolContext(process.env);
const goalId = process.env.SPIKE_GOAL_ID;
if (!goalId) throw new Error("missing Goal identity");
if (process.env.SPIKE_TICKET_ROLE === "implement") {
  await writeFile("candidate-" + goalId + ".txt", "Candidate isolated to " + goalId + "\n");
  await completeWorker(process.cwd(), JSON.stringify({
    summary: "Implemented " + goalId + " in its own worker tree.",
    verification: "The deterministic parallel scenario completed.",
    assumptions: "The immutable Ticket selects this Goal.",
    limitations: "No host worktree mutation is required.",
    risks: "None observed.",
    followUp: "Review the exact normalized Candidate.",
    artifacts: [],
  }), protocol);
} else {
  await completeWorker(process.cwd(), JSON.stringify({
    reviewStatement: "Candidate for " + goalId + " is isolated and approved.",
    findings: [],
    acceptanceAssessment: [{
      criterion: "The Goal-local workflow remains isolated.",
      assessment: "met",
      evidence: "The Candidate contains only " + goalId + "'s worker file.",
    }],
    verdict: "approve",
    artifacts: [],
  }), protocol);
}
`;

function workerWorkspace(record: NonNullable<Awaited<ReturnType<typeof loadRecordedWorkerIfPresent>>>) {
  const runtime = record.metadata.runtime?.resource as { workspace?: string } | undefined;
  expect(runtime?.workspace).toBeDefined();
  return runtime!.workspace!;
}

describe("two Goal-local workflows", () => {
  test("uses isolated production exchanges, workers, Candidates, Reports, and refs through barrier-controlled real Git mutations", async () => {
    const repository = await temporaryRepository();
    const first = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "First", outcome: "Deliver first independently.", approval: "Approved." });
    const second = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Second", outcome: "Deliver second independently.", approval: "Approved." });
    const goals = [first.goal.metadata.goalId, second.goal.metadata.goalId] as const;
    const base = await repository.git("rev-parse", "HEAD");
    const worktreeHead = await repository.git("rev-parse", "HEAD");

    let rendezvous = barrier(2);
    await Promise.all(goals.map(async (goalId) => { await rendezvous(); await revisePlan(repository.project, goalId, `# ${goalId}\n\nConcurrent local Plan revision.`); }));
    rendezvous = barrier(2);
    const changes = await Promise.all(goals.map(async (goalId) => {
      await rendezvous();
      return createChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, title: `Change ${goalId}`, intent: "Publish isolated workflow evidence.", rationale: "Paths and refs are Goal qualified.", acceptanceCriteria: ["The Goal-local workflow remains isolated."] });
    }));
    expect(changes.map((change) => change.change.metadata.changeId)).toEqual(["001", "001"]);

    rendezvous = barrier(2);
    const implementations = await Promise.all(changes.map(async (change) => {
      await rendezvous();
      return issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: change.change.metadata.goalId, changeId: change.change.metadata.changeId, instruction: "Implement the entire isolated Change.", executionPolicy: policy });
    }));
    expect(implementations.map((ticket) => ticket.ticket.metadata.ticketId)).toEqual(["001", "001"]);

    // Dispatch prepares independent exchanges, records independent runtimes,
    // and runs completion in two fresh local-clone worker trees.
    rendezvous = barrier(2);
    const implementationDispatches = await Promise.all(implementations.map(async (issued) => {
      await rendezvous();
      return dispatchLocalImplementation({
        cwd: repository.root,
        hostPaths: repository.hostPaths,
        goalId: issued.ticket.metadata.goalId,
        changeId: "001",
        ticketId: "001",
        command: ["bun", "-e", worker],
        worker: `barrier-implement-${issued.ticket.metadata.goalId}`,
        clock: () => timestamp,
      });
    }));
    expect(implementationDispatches.map((dispatch) => dispatch.execution.exitCode)).toEqual([0, 0]);
    expect(implementationDispatches.map((dispatch) => dispatch.execution.stdout)).toEqual(["", ""]);
    const implementationWorkspaces = await Promise.all(goals.map(async (goalId) => {
      const identity = { goalId, changeId: "001", ticketId: "001" };
      const record = await loadRecordedWorkerIfPresent(repository.project, identity);
      expect(record).toBeDefined();
      expect(await Bun.file(join(exchangePath(repository.project, identity), "input", "ticket.md")).exists()).toBe(true);
      expect(await Bun.file(join(exchangePath(repository.project, identity), "output", "submission.md")).exists()).toBe(true);
      expect(await Bun.file(join(exchangePath(repository.project, identity), "output", "repository.bundle")).exists()).toBe(true);
      return workerWorkspace(record!);
    }));
    expect(new Set(implementationWorkspaces).size).toBe(2);
    expect(implementationDispatches.map((dispatch) => dispatch.exchange.outputDirectory)).toEqual(
      goals.map((goalId) => join(exchangePath(repository.project, { goalId, changeId: "001", ticketId: "001" }), "output")),
    );

    rendezvous = barrier(2);
    const implementationPublications = await Promise.all(implementationDispatches.map(async (dispatch, index) => {
      await rendezvous();
      return publishImplementationReport({
        cwd: repository.root,
        hostPaths: repository.hostPaths,
        goalId: goals[index]!,
        changeId: "001",
        ticketId: "001",
        execution: dispatch.execution,
        commitMessage: { summary: `Candidate ${goals[index]}` },
        now: timestamp,
      });
    }));
    expect(implementationPublications.map((publication) => publication.cleanup.status)).toEqual(["finalized", "finalized"]);
    const candidates = implementationPublications.map((publication) => publication.report.metadata.candidateRevision);
    expect(new Set(candidates).size).toBe(2);
    for (const [index, goalId] of goals.entries()) {
      const report = implementationPublications[index]!.report;
      expect(report.metadata).toMatchObject({ baseRevision: base, inputRevision: base, candidateRevision: candidates[index] });
      expect(await repository.git("rev-parse", `${candidates[index]}^`)).toBe(base);
      expect(await repository.git("show", `${candidates[index]}:candidate-${goalId}.txt`)).toBe(`Candidate isolated to ${goalId}`);
      await expect(repository.git("cat-file", "-e", `${candidates[index]}:candidate-${goals[1 - index]}.txt`)).rejects.toThrow();
      expect(await repository.git("rev-parse", candidateRef(goalId, "001", "001"))).toBe(candidates[index]!);
      expect(await Bun.file(workerRecordPath(repository.project, { goalId, changeId: "001", ticketId: "001" })).exists()).toBe(false);
    }

    rendezvous = barrier(2);
    const reviews = await Promise.all(goals.map(async (goalId) => {
      await rendezvous();
      return issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", role: "review", instruction: "Review the exact Candidate.", executionPolicy: policy });
    }));
    expect(reviews.map((ticket) => ticket.ticket.metadata.ticketId)).toEqual(["002", "002"]);

    rendezvous = barrier(2);
    const reviewDispatches = await Promise.all(reviews.map(async (issued) => {
      await rendezvous();
      return dispatchLocalReview({
        cwd: repository.root,
        hostPaths: repository.hostPaths,
        goalId: issued.ticket.metadata.goalId,
        changeId: "001",
        ticketId: "002",
        command: ["bun", "-e", worker],
        worker: `barrier-review-${issued.ticket.metadata.goalId}`,
        clock: () => timestamp,
      });
    }));
    expect(reviewDispatches.map((dispatch) => dispatch.execution.exitCode)).toEqual([0, 0]);
    const reviewWorkspaces = await Promise.all(goals.map(async (goalId, index) => {
      const identity = { goalId, changeId: "001", ticketId: "002" };
      const record = await loadRecordedWorkerIfPresent(repository.project, identity);
      expect(record).toBeDefined();
      expect(await Bun.file(join(exchangePath(repository.project, identity), "input", "ticket.md")).exists()).toBe(true);
      expect(await Bun.file(join(exchangePath(repository.project, identity), "output", "submission.md")).exists()).toBe(true);
      expect(await Bun.file(join(exchangePath(repository.project, identity), "output", "repository.bundle")).exists()).toBe(false);
      expect(reviewDispatches[index]!.exchange.outputDirectory).toBe(join(exchangePath(repository.project, identity), "output"));
      return workerWorkspace(record!);
    }));
    expect(new Set(reviewWorkspaces).size).toBe(2);
    expect([...reviewWorkspaces, ...implementationWorkspaces].length).toBe(new Set([...reviewWorkspaces, ...implementationWorkspaces]).size);

    rendezvous = barrier(2);
    const reviewPublications = await Promise.all(reviewDispatches.map(async (dispatch, index) => {
      await rendezvous();
      return publishReviewReport({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goals[index]!, changeId: "001", ticketId: "002", execution: dispatch.execution, now: timestamp });
    }));
    expect(reviewPublications.map((publication) => publication.cleanup.status)).toEqual(["finalized", "finalized"]);

    rendezvous = barrier(2);
    await Promise.all(goals.map(async (goalId) => { await rendezvous(); await landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", now: timestamp }); }));
    for (const [index, goalId] of goals.entries()) {
      expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(candidates[index]!);
      expect(await Bun.file(ticketPath(repository.project, goalId, "001", "001")).exists()).toBe(true);
      expect(await Bun.file(ticketPath(repository.project, goalId, "001", "002")).exists()).toBe(true);
      expect(await Bun.file(reportPath(repository.project, goalId, "001", "001")).exists()).toBe(true);
      expect(await Bun.file(reportPath(repository.project, goalId, "001", "002")).exists()).toBe(true);
      expect(await Bun.file(changeDecisionPath(repository.project, goalId, "001")).exists()).toBe(true);
      expect(await Bun.file(workerRecordPath(repository.project, { goalId, changeId: "001", ticketId: "002" })).exists()).toBe(false);
    }
    const status = await deriveRepositoryStatus(repository.root, repository.hostPaths);
    expect(status.goals.map((goal) => [goal.goalId, goal.currentChange, goal.decisions[0]?.disposition])).toEqual([
      [goals[0], null, "land"], [goals[1], null, "land"],
    ]);
    expect(await repository.git("rev-parse", "HEAD")).toBe(worktreeHead);
    expect(await repository.git("status", "--porcelain")).toBe("");
  });
});
