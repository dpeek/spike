import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, landChange } from "../../src/change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { applyQueueHead, queueGoalIntegration } from "../../src/goal-apply.ts";
import { issueTicket } from "../../src/ticket.ts";
import { publishImplementationReport, publishReviewReport } from "../../src/report.ts";
import { dispatchLocalImplementation, dispatchLocalReview } from "../../src/worker.ts";
import { issueApplicationTicket, publishApplicationImplementationReport, recoverApplicationTicket } from "../../src/application-ticket.ts";
import { dispatchApplicationWorker } from "../../src/application-worker.ts";
import { issueApplicationReviewTicket, publishApplicationReviewReport } from "../../src/application-review.ts";
import { dispatchApplicationReviewWorker } from "../../src/application-review-worker.ts";
import { listProjectApplications, loadApplicationDecisionIfPresent, recoverApplications, validDecision } from "../../src/application.ts";
import { deriveApplicationStatus } from "../../src/application-ticket.ts";
import { reconcileRepository } from "../../src/recovery.ts";
import { deriveGoalStatus, deriveRepositoryStatus, deriveSupervisorPlannerStatus } from "../../src/status.ts";
import { temporaryRepository } from "../support/repository.ts";

setDefaultTimeout(30_000);

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };
const completionModule = join(import.meta.dir, "../../src/worker-completion.ts");

function implementationCommand(file: string, value: string) {
  const payload = { summary: "Production worker completed.", verification: "Real Git worker completion.", assumptions: "None.", limitations: "None.", risks: "None.", followUp: "None.", artifacts: [] };
  const source = `
    await Bun.$\`git config user.name Scenario\`; await Bun.$\`git config user.email scenario@example.test\`;
    await Bun.write(${JSON.stringify(file)}, ${JSON.stringify(value)});
    await Bun.$\`git add ${file}\`; await Bun.$\`git commit --quiet -m worker-change\`;
    const completion = await import(${JSON.stringify(completionModule)});
    await completion.completeWorker(process.cwd(), ${JSON.stringify(JSON.stringify(payload))}, completion.parseWorkerProtocolContext(process.env));
  `;
  return ["bun", "-e", source];
}

function reviewCommand(criterion: string) {
  const payload = { reviewStatement: "Production review approved the exact Candidate.", verdict: "approve", findings: [], acceptanceAssessment: [{ criterion, assessment: "met", evidence: "Production worker reviewed the exact Candidate." }], artifacts: [] };
  return ["bun", "-e", `const completion = await import(${JSON.stringify(completionModule)}); await completion.completeWorker(process.cwd(), ${JSON.stringify(JSON.stringify(payload))}, completion.parseWorkerProtocolContext(process.env));`];
}

function appExecution(run: Awaited<ReturnType<typeof dispatchApplicationWorker>>) {
  const { adapter, isolation, worker, model, thinking, startedAt, finishedAt } = run.execution;
  return { adapter, isolation, worker, model, thinking, startedAt, finishedAt };
}
function reviewExecution(run: Awaited<ReturnType<typeof dispatchApplicationReviewWorker>>) {
  const { adapter, isolation, worker, model, thinking, startedAt, finishedAt } = run.execution;
  return { adapter, isolation, worker, model, thinking, startedAt, finishedAt };
}

/** Build Goal, Change, Tickets, worker completions, Reports, review, and landed G through production APIs. */
async function landedGoal(repository: Awaited<ReturnType<typeof temporaryRepository>>, file: string, value: string) {
  const outcome = `Deliver ${file}.`;
  const goal = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: `Goal ${file}`, outcome, approval: "Approved.", constraints: [] });
  const goalId = goal.goal.metadata.goalId;
  const change = await createChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, title: `Change ${file}`, intent: `Add ${file}.`, rationale: "Production scenario.", acceptanceCriteria: [`${file} is delivered.`] });
  const changeId = change.change.metadata.changeId;
  const implementation = await issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, instruction: `Add ${file}.`, executionPolicy: policy });
  const implementationRun = await dispatchLocalImplementation({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, ticketId: implementation.ticket.metadata.ticketId, worker: `implement-${file}`, command: implementationCommand(file, value) });
  expect(implementationRun.execution.exitCode).toBe(0);
  await publishImplementationReport({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, ticketId: implementation.ticket.metadata.ticketId, execution: implementationRun.execution, commitMessage: { summary: `Implement ${file}` } });
  const review = await issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, role: "review", instruction: `Review ${file}.`, executionPolicy: policy });
  const reviewRun = await dispatchLocalReview({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, ticketId: review.ticket.metadata.ticketId, worker: `review-${file}`, command: reviewCommand(`${file} is delivered.`) });
  expect(reviewRun.execution.exitCode).toBe(0);
  await publishReviewReport({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, ticketId: review.ticket.metadata.ticketId, execution: reviewRun.execution });
  await landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId });
  return { goalId, base: goal.goal.metadata.repository.initialRevision, outcome, changeId, implementationTicketId: implementation.ticket.metadata.ticketId, reviewTicketId: review.ticket.metadata.ticketId };
}

async function moveMain(repository: Awaited<ReturnType<typeof temporaryRepository>>, file = "target-only.txt") {
  await writeFile(join(repository.root, file), "target content\n");
  await repository.git("add", file); await repository.git("commit", "--quiet", "-m", "Diverge main");
  return repository.git("rev-parse", "main");
}

/** Drive the production Application implementation, cleanup, review, and approval seams. */
async function reviewedApplication(repository: Awaited<ReturnType<typeof temporaryRepository>>, goal: Awaited<ReturnType<typeof landedGoal>>, marker: string, existingQueue?: Awaited<ReturnType<typeof queueGoalIntegration>>) {
  const queued = existingQueue ?? await queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goalId, approval: `Approve ${goal.goalId}.` });
  const issued = await issueApplicationTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goalId, applicationId: queued.applicationId, instruction: "Produce reviewed Candidate.", executionPolicy: policy });
  const identity = { goalId: goal.goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId };
  const run = await dispatchApplicationWorker({ cwd: repository.root, hostPaths: repository.hostPaths, ...identity, worker: `application-${marker}`, command: implementationCommand(`application-${marker}.txt`, `${marker}\n`) });
  expect(run.execution.exitCode).toBe(0);
  const published = await publishApplicationImplementationReport({ cwd: repository.root, hostPaths: repository.hostPaths, ...identity, message: { summary: `Candidate ${marker}` }, execution: appExecution(run) });
  await recoverApplicationTicket(repository.root, repository.hostPaths, identity.goalId, identity.applicationId, identity.ticketId);
  const review = await issueApplicationReviewTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goalId, applicationId: queued.applicationId, instruction: "Review exact Candidate.", executionPolicy: policy });
  const reviewIdentity = { goalId: goal.goalId, applicationId: queued.applicationId, ticketId: review.ticket.metadata.ticketId };
  const reviewRun = await dispatchApplicationReviewWorker({ cwd: repository.root, hostPaths: repository.hostPaths, ...reviewIdentity, worker: `application-review-${marker}`, command: reviewCommand(goal.outcome) });
  expect(reviewRun.execution.exitCode).toBe(0);
  await publishApplicationReviewReport({ cwd: repository.root, hostPaths: repository.hostPaths, ...reviewIdentity, execution: reviewExecution(reviewRun) });
  return { queued, identity, reviewIdentity, candidate: published.report.metadata.candidateRevision! };
}

async function repository() {
  const result = await temporaryRepository(); await result.git("branch", "-M", "main"); return result;
}


describe("reviewed application production scenarios", () => {
  test("reviewed diverged apply advances only main by CAS", async () => {
    const repo = await repository();
    const goal = await landedGoal(repo, "goal-one.txt", "goal one\n");
    const target = await moveMain(repo);
    const beforeTargetFile = await readFile(join(repo.root, "target-only.txt"), "utf8");
    const beforeGoalRef = await repo.git("rev-parse", integratedRef(goal.goalId));
    const app = await reviewedApplication(repo, goal, "one");
    const applied = await applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: goal.goalId, applicationId: app.queued.applicationId });
    expect(applied).toMatchObject({ form: "reviewed", previousTargetRevision: target, resultingTargetRevision: app.candidate });
    expect((await loadApplicationDecisionIfPresent(repo.project, goal.goalId, app.queued.applicationId))?.metadata).toMatchObject({ kind: "application-reviewed-apply-decision", expectedPreviousMainRevision: target, candidateRevision: app.candidate, producingImplementationTicketId: app.identity.ticketId, approvingReviewTicketId: app.reviewIdentity.ticketId });
    expect(await repo.git("rev-parse", "main")).toBe(app.candidate);
    expect((await repo.git("rev-list", "--parents", "-n", "1", app.candidate)).split(" ").slice(1)).toEqual([target]);
    expect(await repo.git("rev-parse", integratedRef(goal.goalId))).toBe(beforeGoalRef);
    expect(await readFile(join(repo.root, "target-only.txt"), "utf8")).toBe(beforeTargetFile);
    expect(await Bun.file(join(repo.root, "application-one.txt")).exists()).toBe(false);
    const status = await deriveApplicationStatus(repo.root, repo.hostPaths, goal.goalId, app.queued.applicationId);
    expect(status).toMatchObject({ evidenceState: "applied", targetMismatch: false, candidate: { ticketId: app.identity.ticketId, revision: app.candidate }, decision: { candidateRevision: app.candidate }, cleanupWarnings: [] });
  });

  test("recovery completes decision-before-CAS interruption", async () => {
    const repo = await repository(); const goal = await landedGoal(repo, "goal-one.txt", "goal one\n"); const target = await moveMain(repo); const app = await reviewedApplication(repo, goal, "recover");
    const hostTarget = await readFile(join(repo.root, "target-only.txt"), "utf8");
    await expect(applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: goal.goalId, applicationId: app.queued.applicationId, crash: async event => { if (event.point === "application-decision-publication" && event.moment === "after") throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
    expect((await deriveRepositoryStatus(repo.root, repo.hostPaths)).applicationQueue[0]).toMatchObject({ state: "decision-pending", evidenceState: "decision-pending", candidate: { revision: app.candidate }, decision: { candidateRevision: app.candidate }, cleanup: { healthy: true } });
    expect(await repo.git("rev-parse", "main")).toBe(target);
    await recoverApplications(repo.project);
    expect(await repo.git("rev-parse", "main")).toBe(app.candidate);
    expect(await readFile(join(repo.root, "target-only.txt"), "utf8")).toBe(hostTarget);
    const supervisor = await deriveSupervisorPlannerStatus(repo.root, repo.hostPaths);
    expect(supervisor.durable.applicationQueue[0]).toMatchObject({ state: "applied", evidenceState: "applied", decision: { candidateRevision: app.candidate }, cleanup: { healthy: true } });
  });

});



describe("reviewed application production scenarios", () => {
  test("CAS mismatch never overwrites moved main", async () => {
    const repo = await repository(); const goal = await landedGoal(repo, "goal-one.txt", "goal one\n"); const target = await moveMain(repo); const app = await reviewedApplication(repo, goal, "mismatch");
    await expect(applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: goal.goalId, applicationId: app.queued.applicationId, crash: async event => { if (event.point === "application-target-advance" && event.moment === "before") throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
    await writeFile(join(repo.root, "operator-moved.txt"), "operator movement\n");
    await repo.git("add", "operator-moved.txt"); await repo.git("commit", "--quiet", "-m", "operator movement");
    const moved = await repo.git("rev-parse", "main");
    await expect(recoverApplications(repo.project)).rejects.toThrow("apply recovery refused");
    expect(await repo.git("rev-parse", "main")).toBe(moved);
    const status = await deriveRepositoryStatus(repo.root, repo.hostPaths);
    expect(status.applicationQueue[0]).toMatchObject({ state: "target-mismatch", evidenceState: "target-mismatch", candidate: { revision: app.candidate }, decision: { expectedPreviousMainRevision: target }, cleanup: { healthy: true } });
  });

});



describe("reviewed application production scenarios", () => {
  test("two disjoint Goals deliver FIFO as two squash commits", async () => {
    const repo = await repository();
    const first = await landedGoal(repo, "goal-one.txt", "one\n");
    const second = await landedGoal(repo, "goal-two.txt", "two\n");
    const initial = await repo.git("rev-parse", "main"); const target = await moveMain(repo);
    // Both completed, disjoint Goals are queued before the first Application applies.
    const firstApp = await reviewedApplication(repo, first, "one");
    // Queue Goal two now, but its Application work cannot issue until FIFO head one applies.
    const secondQueued = await queueGoalIntegration({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: second.goalId, approval: `Approve ${second.goalId}.` });
    expect((await deriveRepositoryStatus(repo.root, repo.hostPaths)).applicationQueue.map(entry => [entry.goalId, entry.queuePosition, entry.state])).toEqual([[first.goalId, 1, "queued"], [second.goalId, 2, "queued"]]);
    const firstApplied = await applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: first.goalId, applicationId: firstApp.queued.applicationId });
    const secondApp = await (async () => {
      const issued = await issueApplicationTicket({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: second.goalId, applicationId: secondQueued.applicationId, instruction: "Produce second reviewed Candidate.", executionPolicy: policy });
      const identity = { goalId: second.goalId, applicationId: secondQueued.applicationId, ticketId: issued.ticket.metadata.ticketId };
      const run = await dispatchApplicationWorker({ cwd: repo.root, hostPaths: repo.hostPaths, ...identity, worker: "application-two", command: implementationCommand("application-two.txt", "two app\n") });
      const published = await publishApplicationImplementationReport({ cwd: repo.root, hostPaths: repo.hostPaths, ...identity, message: { summary: "Candidate two" }, execution: appExecution(run) });
      await recoverApplicationTicket(repo.root, repo.hostPaths, identity.goalId, identity.applicationId, identity.ticketId);
      const review = await issueApplicationReviewTicket({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: second.goalId, applicationId: secondQueued.applicationId, instruction: "Review second Candidate.", executionPolicy: policy });
      const reviewIdentity = { goalId: second.goalId, applicationId: secondQueued.applicationId, ticketId: review.ticket.metadata.ticketId };
      const reviewRun = await dispatchApplicationReviewWorker({ cwd: repo.root, hostPaths: repo.hostPaths, ...reviewIdentity, worker: "application-review-two", command: reviewCommand(second.outcome) });
      await publishApplicationReviewReport({ cwd: repo.root, hostPaths: repo.hostPaths, ...reviewIdentity, execution: reviewExecution(reviewRun) });
      return { identity, reviewIdentity, candidate: published.report.metadata.candidateRevision! };
    })();
    const secondApplied = await applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: second.goalId, applicationId: secondQueued.applicationId });
    expect((await repo.git("rev-list", "--parents", "-n", "1", firstApplied.resultingTargetRevision)).split(" ").slice(1)).toEqual([target]);
    expect((await repo.git("rev-list", "--parents", "-n", "1", secondApplied.resultingTargetRevision)).split(" ").slice(1)).toEqual([firstApplied.resultingTargetRevision]);
    expect(await repo.git("rev-parse", "main")).toBe(secondApplied.resultingTargetRevision);
    expect(await repo.git("show", `${secondApplied.resultingTargetRevision}:goal-one.txt`)).toBe("one");
    expect(await repo.git("show", `${secondApplied.resultingTargetRevision}:goal-two.txt`)).toBe("two");
    expect(await repo.git("show", `${secondApplied.resultingTargetRevision}:application-one.txt`)).toBe("one");
    expect(await repo.git("show", `${secondApplied.resultingTargetRevision}:application-two.txt`)).toBe("two app");
    const queue = await deriveRepositoryStatus(repo.root, repo.hostPaths);
    expect(queue.applicationQueue.map(entry => entry.state)).toEqual(["applied", "applied"]);
    expect(queue.queueHead).toBeNull();
    expect(await repo.git("merge-base", "--is-ancestor", initial, secondApplied.resultingTargetRevision)).toBe("");
    expect(secondApp.candidate).toBe(secondApplied.resultingTargetRevision);
  });

});



describe("reviewed application production scenarios", () => {
  test("a clean-base Application remains terminal after the next FIFO Application advances main", async () => {
    const repo = await repository();
    const first = await landedGoal(repo, "clean-first.txt", "first\n");
    const second = await landedGoal(repo, "clean-second.txt", "second\n");
    const firstQueued = await queueGoalIntegration({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: first.goalId, approval: "Apply first Goal." });
    const secondQueued = await queueGoalIntegration({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: second.goalId, approval: "Apply second Goal." });
    expect([firstQueued.queuePosition, secondQueued.queuePosition]).toEqual([1, 2]);

    const firstApplied = await applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: first.goalId, applicationId: firstQueued.applicationId });
    expect(firstApplied.form).toBe("clean-base");
    const secondApplication = await reviewedApplication(repo, second, "after-clean", secondQueued);
    const secondApplied = await applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: second.goalId, applicationId: secondQueued.applicationId });
    expect(secondApplied.previousTargetRevision).toBe(firstApplied.resultingTargetRevision);
    expect(secondApplied.resultingTargetRevision).toBe(secondApplication.candidate);

    const applications = await listProjectApplications(repo.project);
    expect(await validDecision(repo.project, applications[0]!, applications[0]!.decision!)).toBe(true);
    expect(await repo.git("merge-base", "--is-ancestor", firstApplied.resultingTargetRevision, secondApplied.resultingTargetRevision)).toBe("");
    const status = await deriveRepositoryStatus(repo.root, repo.hostPaths);
    const beforeRecovery = await repo.git("rev-parse", "main");
    await reconcileRepository({ cwd: repo.root, hostPaths: repo.hostPaths }, undefined, { ...({} as any), release: async () => undefined });
    expect(await repo.git("rev-parse", "main")).toBe(beforeRecovery);
    expect(status.applicationQueue.map(entry => ({ state: entry.state, queueMember: entry.queueMember }))).toEqual([
      { state: "applied", queueMember: false },
      { state: "applied", queueMember: false },
    ]);
    expect(status.queueHead).toBeNull();
  });

  test("clean-base apply and Change review remain unchanged", async () => {
    const repo = await repository();
    const goal = await landedGoal(repo, "clean-goal.txt", "clean content\n");
    // landedGoal above runs an actual Change review publication before the clean-base Application.
    expect((await deriveGoalStatus(repo.root, repo.hostPaths, goal.goalId)).decisions).toMatchObject([{ changeId: goal.changeId, disposition: "land" }]);
    const queued = await queueGoalIntegration({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: goal.goalId, approval: "Apply clean Goal." });
    const applied = await applyQueueHead({ cwd: repo.root, hostPaths: repo.hostPaths, goalId: goal.goalId, applicationId: queued.applicationId });
    expect(applied.form).toBe("clean-base");
    expect((await loadApplicationDecisionIfPresent(repo.project, goal.goalId, queued.applicationId))?.metadata).toMatchObject({ kind: "application-decision", expectedPreviousMainRevision: goal.base, candidateRevision: applied.resultingTargetRevision });
    expect(await repo.git("rev-parse", "main")).toBe(applied.resultingTargetRevision);
    expect(await repo.git("show", `${applied.resultingTargetRevision}:clean-goal.txt`)).toBe("clean content");
    expect((await deriveRepositoryStatus(repo.root, repo.hostPaths)).applicationQueue[0]).toMatchObject({ state: "applied", evidenceState: "applied", candidate: null, decision: { kind: "application-decision" }, cleanup: { healthy: true } });
  });
});

