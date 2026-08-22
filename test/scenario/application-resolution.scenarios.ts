import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applicationCandidateRef, applicationExchangePath, applicationReportPath, applicationTicketPath } from "../../src/application-ticket.ts";
import { applicationReviewReportPath, applicationReviewTicketPath, issueApplicationReviewTicket, recoverApplicationReviewTicket } from "../../src/application-review.ts";
import { applicationRequeueEligibility, applicationResolutionPath, createSquashCandidate, loadApplicationResolutionIfPresent, publishApplication, publishApplyDecision, queuedApplicationHead, recoverApplications, returnApplication, staleApplication } from "../../src/application.ts";
import { createChange, landChange } from "../../src/change.ts";
import { goalPlannerOperations } from "../../src/goal-planner.ts";
import type { HerdrOperations } from "../../src/herdr.ts";
import { registerGoalPlannerExtension, registerSupervisorExtension, type SupervisorExtensionApi } from "../../src/pi-supervisor-extension.ts";
import { issueTicket, reportPath } from "../../src/ticket.ts";
import { serializeDocument } from "../../src/durable-state.ts";
import { createGoal } from "../../src/goal.ts";
import { queueGoalIntegration } from "../../src/goal-apply.ts";
import { reconcileGoal } from "../../src/recovery.ts";
import { deriveGoalStatus } from "../../src/status.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ remove(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(repositories.splice(0).map(repository => repository.remove())); });
const stamp = new Date(0).toISOString();
const execution = { adapter: "fixture", isolation: "workspace" as const, worker: "fixture", model: "fixture", thinking: "medium" as const, startedAt: stamp, finishedAt: stamp };

async function recordImplementation(repository: Awaited<ReturnType<typeof temporaryRepository>>, goalId: string, applicationId: string, target: string, goalRevision: string, completed: boolean, reported = true) {
  const tree = await repository.git("rev-parse", `${target}^{tree}`);
  const ticket = { kind: "application-ticket", goalId, applicationId, ticketId: "001", issuedAt: stamp, role: "implement", targetRevision: target, goalRevision, mergeBase: goalRevision, inputRevision: target, integration: { classification: "clean", cleanTree: tree }, model: "fixture", thinking: "medium", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] }, guidance: { step: "implement", revision: target } };
  await mkdir(join(applicationTicketPath(repository.root, goalId, applicationId, "001"), ".."), { recursive: true });
  await writeFile(applicationTicketPath(repository.root, goalId, applicationId, "001"), serializeDocument(ticket, "# Ticket\n"));
  const report = { kind: "application-report", goalId, applicationId, ticketId: "001", role: "implement", outcome: completed ? "completed" : "partial", publishedAt: stamp, targetRevision: target, goalRevision, mergeBase: goalRevision, integrationClassification: "clean", inputRevision: target, ...(completed ? { workerRevision: target, candidateRevision: target } : {}), artifacts: [], execution };
  if (reported) {
    await writeFile(applicationReportPath(repository.root, goalId, applicationId, "001"), serializeDocument(report, "# Report\n"));
    if (completed) await repository.git("update-ref", applicationCandidateRef(goalId, applicationId, "001"), target);
  }
}

async function recordReview(repository: Awaited<ReturnType<typeof temporaryRepository>>, goalId: string, applicationId: string, target: string, goalRevision: string) {
  const reviewTicket = { kind: "application-review-ticket", goalId, applicationId, ticketId: "001", role: "review", issuedAt: stamp, targetRevision: target, goalRevision, mergeBase: goalRevision, candidateRevision: target, producingImplementationTicketId: "001", model: "fixture", thinking: "medium", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] }, guidance: { step: "review", revision: target } };
  await mkdir(join(applicationReviewTicketPath(repository.root, goalId, applicationId, "001"), ".."), { recursive: true });
  await writeFile(applicationReviewTicketPath(repository.root, goalId, applicationId, "001"), serializeDocument(reviewTicket, "# Review\n"));
  const reviewReport = { kind: "application-review-report", goalId, applicationId, ticketId: "001", role: "review", outcome: "completed", publishedAt: stamp, targetRevision: target, goalRevision, mergeBase: goalRevision, candidateRevision: target, producingImplementationTicketId: "001", verdict: "approve", findings: [], acceptanceAssessment: [], reviewStatement: "Reviewed.", artifacts: [], execution };
  await writeFile(applicationReviewReportPath(repository.root, goalId, applicationId, "001"), serializeDocument(reviewReport, "# Review report\n"));
}

async function gitSnapshot(repository: Awaited<ReturnType<typeof temporaryRepository>>) {
  return {
    main: await repository.git("rev-parse", "main"),
    head: await repository.git("rev-parse", "HEAD"),
    branch: await repository.git("symbolic-ref", "--short", "HEAD"),
    goalAndCandidateRefs: await repository.git("for-each-ref", "--format=%(refname):%(objectname)", "refs/spike/goals/"),
    worktree: await repository.git("status", "--porcelain"),
  };
}

async function writeCompletedChangeReport(root: string, goalId: string, changeId: string, ticketId: string, metadata: Record<string, unknown>) {
  const path = reportPath(root, goalId, changeId, ticketId);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeDocument({
    kind: "report", goalId, changeId, ticketId, publishedAt: stamp, artifacts: [], outcome: "completed",
    execution: { adapter: "local-clone", isolation: "workspace", worker: "fixture-worker", model: "fixture", thinking: "medium", startedAt: stamp, finishedAt: stamp },
    ...metadata,
  }, "# Completed fixture report\n"));
}

/** Land a real Goal Change after return, advancing G without touching main. */
async function landChangeAfterReturn(repository: Awaited<ReturnType<typeof temporaryRepository>>, goalId: string) {
  const base = await repository.git("rev-parse", `refs/spike/goals/${goalId}/integrated`);
  const change = await createChange({ cwd: repository.root, goalId, title: "Post-return product work", intent: "Advance G before requeue.", rationale: "Returned Applications require later landed work.", acceptanceCriteria: ["G advances."] });
  const implementation = await issueTicket({ cwd: repository.root, goalId, changeId: change.change.metadata.changeId, instruction: "Create fixture Candidate.", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] }, model: "fixture", thinking: "medium" });
  const candidate = await repository.git("commit-tree", `${base}^{tree}`, "-p", base, "-m", "Advance Goal after return");
  await writeCompletedChangeReport(repository.root, goalId, "001", implementation.ticket.metadata.ticketId, { role: "implement", baseRevision: base, inputRevision: base, workerRevision: candidate, candidateRevision: candidate });
  const review = await issueTicket({ cwd: repository.root, goalId, changeId: "001", role: "review", instruction: "Approve fixture Candidate.", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] }, model: "fixture", thinking: "medium" });
  await writeCompletedChangeReport(repository.root, goalId, "001", review.ticket.metadata.ticketId, { role: "review", reviewedRevision: candidate, producingImplementationTicketId: implementation.ticket.metadata.ticketId, findings: [], acceptanceAssessment: [{ criterion: "G advances.", assessment: "met", evidence: "Fixture approval." }], reviewStatement: "Approved.", reviewer: "fixture", verdict: "approve" });
  await landChange({ cwd: repository.root, goalId, changeId: "001" });
  return candidate;
}

function fakePlanner(calls: string[]): HerdrOperations {
  const resources: Array<{ tab: string; pane: string; label: string }> = [];
  return {
    async createTab(input) { calls.push(`create:${input.label}`); const resource = { tab: "planner-tab", pane: "planner-pane", label: input.label }; resources.push(resource); return resource; },
    async run(pane) { calls.push(`run:${pane}`); }, async status() { return "working"; }, async read() { return ""; }, async attach() { return 0; },
    async closeTab(tab) { calls.push(`close:${tab}`); }, async findTabsByLabel(label) { calls.push(`find:${label}`); return resources.filter((resource) => resource.label === label); },
  };
}

async function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([join(import.meta.dir, "..", "..", "bin", "spike"), ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

async function fixture(completed: boolean, reported = true) {
  const repository = await temporaryRepository(); repositories.push(repository);
  await repository.git("branch", "-M", "main");
  const goal = await createGoal({ cwd: repository.root, title: "Resolution", outcome: "Keep evidence immutable.", approval: "Approved." });
  const goalId = goal.goal.metadata.goalId, base = await repository.git("rev-parse", "HEAD");
  const application = await publishApplication({ root: repository.root, goalId, integratedRevision: base, approval: "Queue." });
  await recordImplementation(repository, goalId, application.metadata.applicationId, base, base, completed, reported);
  return { repository, goalId, base };
}

export function registerApplicationResolutionEvidenceScenarios() {
describe("Application terminal resolution", () => {
  test("records immutable stale evidence, advances FIFO, and permits same-G requeue without touching refs", async () => {
    const { repository, goalId, base } = await fixture(false);
    await writeFile(join(repository.root, "moved.txt"), "moved\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "move main");
    const observed = await repository.git("rev-parse", "HEAD");
    const beforeResolution = await gitSnapshot(repository);
    const stale = await staleApplication({ cwd: repository.root, goalId, applicationId: "001" });
    expect(await gitSnapshot(repository)).toEqual(beforeResolution);
    expect(stale.resolution.metadata.disposition).toBe("stale");
    if (stale.resolution.metadata.disposition === "stale") expect(stale.resolution.metadata.observedMainRevision).toBe(observed);
    expect(await queuedApplicationHead(repository.root)).toBeUndefined();
    expect((await loadApplicationResolutionIfPresent(repository.root, goalId, "001"))?.metadata.expectedMainRevision).toBe(base);
    expect(await applicationRequeueEligibility(repository.root, goalId)).toBe("stale");
    const requeued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Requeue stale work." });
    expect(requeued.applicationId).toBe("002"); expect(requeued.queuePosition).toBe(2);
    expect((await queuedApplicationHead(repository.root))?.metadata.applicationId).toBe("002");
    const status = await deriveGoalStatus(repository.root, goalId);
    expect(status.frozen).toBe(true); expect(status.application[0]?.resolution).toBe("stale");
  });

  test("uses the latest requeued attempt so stale history cannot override a later return", async () => {
    const { repository, goalId, base } = await fixture(false);
    await writeFile(join(repository.root, "moved.txt"), "moved\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "move main");
    const moved = await repository.git("rev-parse", "HEAD");
    await staleApplication({ cwd: repository.root, goalId, applicationId: "001" });
    const requeued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Requeue stale work." });
    expect(requeued.applicationId).toBe("002"); expect(requeued.queuePosition).toBe(2);
    await recordImplementation(repository, goalId, "002", moved, base, true);
    await recordReview(repository, goalId, "002", moved, base);
    await returnApplication({ cwd: repository.root, goalId, applicationId: "002", statement: "Resume Goal planning." });
    const status = await deriveGoalStatus(repository.root, goalId);
    expect(status.frozen).toBe(false); expect(status.stale).toBe(false);
    await createChange({ cwd: repository.root, goalId, title: "After stale then return", intent: "Resume product work.", rationale: "Latest returned Application releases planning.", acceptanceCriteria: ["Planning can continue."] });
  });

  test("rejects malformed reached stale evidence but does not preflight unrelated later evidence", async () => {
    const { repository, goalId, base } = await fixture(false);
    const malformed = { kind: "application-resolution", disposition: "stale", goalId, applicationId: "001", expectedMainRevision: base, observedMainRevision: base, goalRevision: base, decidedAt: stamp };
    await writeFile(applicationResolutionPath(repository.root, goalId, "001"), serializeDocument(malformed, "# Stale\n"));
    await expect(queuedApplicationHead(repository.root)).rejects.toThrow("malformed resolution evidence");

    const second = await publishApplication({ root: repository.root, goalId, integratedRevision: base, approval: "Later." });
    const unrelated = { kind: "application-resolution", disposition: "stale", goalId, applicationId: second.metadata.applicationId, expectedMainRevision: base, observedMainRevision: "f".repeat(40), goalRevision: base, candidateRevision: base, decidedAt: stamp };
    await writeFile(applicationResolutionPath(repository.root, goalId, second.metadata.applicationId), serializeDocument(unrelated, "# Stale\n"));
    // The first malformed item is reached before the later one. Rebuild a
    // fresh fixture to prove a valid earlier head does not inspect later data.
    const other = await fixture(false);
    const later = await publishApplication({ root: other.repository.root, goalId: other.goalId, integratedRevision: other.base, approval: "Later." });
    const laterMalformed = { kind: "application-resolution", disposition: "stale", goalId: other.goalId, applicationId: later.metadata.applicationId, expectedMainRevision: other.base, observedMainRevision: "f".repeat(40), goalRevision: other.base, candidateRevision: other.base, decidedAt: stamp };
    await writeFile(applicationResolutionPath(other.repository.root, other.goalId, later.metadata.applicationId), serializeDocument(laterMalformed, "# Stale\n"));
    expect((await queuedApplicationHead(other.repository.root))?.metadata.applicationId).toBe("001");

    const provenance = await fixture(false);
    await writeFile(join(provenance.repository.root, "moved.txt"), "moved\n"); await provenance.repository.git("add", "moved.txt"); await provenance.repository.git("commit", "--quiet", "-m", "move main");
    await staleApplication({ cwd: provenance.repository.root, goalId: provenance.goalId, applicationId: "001" });
    const reached = await publishApplication({ root: provenance.repository.root, goalId: provenance.goalId, integratedRevision: provenance.base, approval: "Later." });
    const oneSided = { kind: "application-resolution", disposition: "stale", goalId: provenance.goalId, applicationId: reached.metadata.applicationId, expectedMainRevision: provenance.base, observedMainRevision: "e".repeat(40), goalRevision: provenance.base, candidateRevision: provenance.base, decidedAt: stamp };
    await writeFile(applicationResolutionPath(provenance.repository.root, provenance.goalId, reached.metadata.applicationId), serializeDocument(oneSided, "# Stale\n"));
    await expect(queuedApplicationHead(provenance.repository.root)).rejects.toThrow("malformed resolution evidence");
  });

});
}

export function registerApplicationResolutionWorkflowScenarios() {
describe("Application terminal resolution", () => {
  test("recovery skips a resolved attempt and advances the earliest later decision owner", async () => {
    const { repository, goalId } = await fixture(false);
    await writeFile(join(repository.root, "moved.txt"), "moved\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "move main");
    const moved = await repository.git("rev-parse", "HEAD");
    await staleApplication({ cwd: repository.root, goalId, applicationId: "001" });
    const laterGoal = await createGoal({ cwd: repository.root, title: "Later", outcome: "Advance independently.", approval: "Approved." });
    const later = await publishApplication({ root: repository.root, goalId: laterGoal.goal.metadata.goalId, integratedRevision: moved, approval: "Queue later." });
    const candidate = await createSquashCandidate(repository.root, laterGoal.goal.metadata.goalId, moved, moved);
    await publishApplyDecision(repository.root, later, candidate, moved);
    await recoverApplications(repository.root);
    expect(await repository.git("rev-parse", "main")).toBe(candidate);
  });

  test("return then landed Goal Change requeues with monotonic IDs and positions without Git mutation", async () => {
    const { repository, goalId } = await fixture(true);
    const base = await repository.git("rev-parse", "main");
    await recordReview(repository, goalId, "001", base, base);
    const beforeReturn = await gitSnapshot(repository);
    await returnApplication({ cwd: repository.root, goalId, applicationId: "001", statement: "Resume Goal work." });
    expect(await gitSnapshot(repository)).toEqual(beforeReturn);
    expect(await applicationRequeueEligibility(repository.root, goalId)).toBe("none");

    const landed = await landChangeAfterReturn(repository, goalId);
    expect(await repository.git("rev-parse", `refs/spike/goals/${goalId}/integrated`)).toBe(landed);
    expect(await repository.git("rev-parse", "main")).toBe(base);
    const beforeRequeue = await gitSnapshot(repository);
    const requeued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Approve the later Goal revision." });
    expect(requeued).toMatchObject({ applicationId: "002", queuePosition: 2, integratedRevision: landed });
    expect(await gitSnapshot(repository)).toEqual(beforeRequeue);
    expect((await queuedApplicationHead(repository.root))?.metadata).toMatchObject({ applicationId: "002", queuePosition: 2, integratedRevision: landed });
  });

  test("refuses stale while review is open, recovers it, then requeues same G and returns", async () => {
    const { repository, goalId, base } = await fixture(true);
    const review = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: "001", instruction: "Review exact Candidate.", model: "fixture", thinking: "medium", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] } });
    await writeFile(join(repository.root, "moved.txt"), "moved\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "move main during review");
    const moved = await repository.git("rev-parse", "main");
    const beforeOpenReviewRefusal = await gitSnapshot(repository);
    await expect(staleApplication({ cwd: repository.root, goalId, applicationId: "001" })).rejects.toThrow("every review Ticket to be reported");
    expect(await gitSnapshot(repository)).toEqual(beforeOpenReviewRefusal);
    await recoverApplicationReviewTicket(repository.root, goalId, "001", review.ticket.metadata.ticketId, "Recover the interrupted review.");
    const beforeStale = await gitSnapshot(repository);
    await staleApplication({ cwd: repository.root, goalId, applicationId: "001" });
    expect(await gitSnapshot(repository)).toEqual(beforeStale);
    const requeued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Requeue unchanged G after stale." });
    expect(requeued).toMatchObject({ applicationId: "002", queuePosition: 2, integratedRevision: base });
    await recordImplementation(repository, goalId, "002", moved, base, true);
    await recordReview(repository, goalId, "002", moved, base);
    const beforeReturn = await gitSnapshot(repository);
    await returnApplication({ cwd: repository.root, goalId, applicationId: "002", statement: "Return the requeued Candidate." });
    expect(await gitSnapshot(repository)).toEqual(beforeReturn);
    expect(await applicationRequeueEligibility(repository.root, goalId)).toBe("none");
    const status = await deriveGoalStatus(repository.root, goalId);
    expect(status.application.map((entry) => entry.resolution)).toEqual(["stale", "return"]);
    expect(status.frozen).toBe(false);
  });

  test("refusal and cleanup preconditions leave every Git projection and resolution evidence unchanged", async () => {
    const unresolved = await fixture(false);
    const before = await gitSnapshot(unresolved.repository);
    await expect(staleApplication({ cwd: unresolved.repository.root, goalId: unresolved.goalId, applicationId: "001" })).rejects.toThrow("main to differ");
    await expect(returnApplication({ cwd: unresolved.repository.root, goalId: unresolved.goalId, applicationId: "001", statement: "   " })).rejects.toThrow("must not be blank");
    await expect(returnApplication({ cwd: unresolved.repository.root, goalId: unresolved.goalId, applicationId: "001", statement: "No completed review exists." })).rejects.toThrow("completed highest review");
    expect(await gitSnapshot(unresolved.repository)).toEqual(before);
    expect(await loadApplicationResolutionIfPresent(unresolved.repository.root, unresolved.goalId, "001")).toBeUndefined();
    const later = await publishApplication({ root: unresolved.repository.root, goalId: unresolved.goalId, integratedRevision: unresolved.base, approval: "Later head refusal." });
    const beforeWrongHead = await gitSnapshot(unresolved.repository);
    await expect(staleApplication({ cwd: unresolved.repository.root, goalId: unresolved.goalId, applicationId: later.metadata.applicationId })).rejects.toThrow("exact unresolved FIFO head");
    expect(await gitSnapshot(unresolved.repository)).toEqual(beforeWrongHead);

    const unreported = await fixture(false, false);
    await writeFile(join(unreported.repository.root, "moved.txt"), "moved\n"); await unreported.repository.git("add", "moved.txt"); await unreported.repository.git("commit", "--quiet", "-m", "move with open implementation");
    const beforeOpenImplementation = await gitSnapshot(unreported.repository);
    await expect(staleApplication({ cwd: unreported.repository.root, goalId: unreported.goalId, applicationId: "001" })).rejects.toThrow("every implementation Ticket to be reported");
    expect(await gitSnapshot(unreported.repository)).toEqual(beforeOpenImplementation);

    const reviewed = await fixture(true);
    await recordReview(reviewed.repository, reviewed.goalId, "001", reviewed.base, reviewed.base);
    const exchange = applicationExchangePath(reviewed.repository.root, { goalId: reviewed.goalId, applicationId: "001", ticketId: "001" });
    await mkdir(exchange, { recursive: true });
    const beforeCleanupRefusal = await gitSnapshot(reviewed.repository);
    await expect(returnApplication({ cwd: reviewed.repository.root, goalId: reviewed.goalId, applicationId: "001", statement: "Blocked cleanup." })).rejects.toThrow("healthy cleanup");
    await expect(staleApplication({ cwd: reviewed.repository.root, goalId: reviewed.goalId, applicationId: "001" })).rejects.toThrow("healthy cleanup");
    expect(await gitSnapshot(reviewed.repository)).toEqual(beforeCleanupRefusal);
    expect(await loadApplicationResolutionIfPresent(reviewed.repository.root, reviewed.goalId, "001")).toBeUndefined();
    await writeFile(join(reviewed.repository.root, "moved.txt"), "moved\n"); await reviewed.repository.git("add", "moved.txt"); await reviewed.repository.git("commit", "--quiet", "-m", "move main before return");
    const beforeMovedReturn = await gitSnapshot(reviewed.repository);
    // Remove only the synthetic cleanup projection after proving it blocked;
    // the moved-main refusal is independently checked below.
    await rm(exchange, { recursive: true, force: true });
    await expect(returnApplication({ cwd: reviewed.repository.root, goalId: reviewed.goalId, applicationId: "001", statement: "Main moved." })).rejects.toThrow("requires main");
    expect(await gitSnapshot(reviewed.repository)).toEqual(beforeMovedReturn);
  });

});
}

export function registerApplicationResolutionBoundaryScenarios() {
describe("Application terminal resolution", () => {
  test("return admits a real planner, stale refuses it before Herdr side effects, and active Change recovery continues", async () => {
    const returned = await fixture(true);
    await recordReview(returned.repository, returned.goalId, "001", returned.base, returned.base);
    await returnApplication({ cwd: returned.repository.root, goalId: returned.goalId, applicationId: "001", statement: "Planner may resume." });
    const returnCalls: string[] = [];
    const beforePlanner = await gitSnapshot(returned.repository);
    expect((await goalPlannerOperations.startOrReattach({ cwd: returned.repository.root, goalId: returned.goalId, herdr: fakePlanner(returnCalls) })).state).toBe("live");
    expect(returnCalls.some((call) => call.startsWith("create:") || call.startsWith("run:"))).toBe(true);
    expect(await gitSnapshot(returned.repository)).toEqual(beforePlanner);

    const change = await createChange({ cwd: returned.repository.root, goalId: returned.goalId, title: "Recover open work", intent: "Prove ordinary work resumes.", rationale: "Return released the Goal.", acceptanceCriteria: ["The open Ticket is recovered."] });
    await issueTicket({ cwd: returned.repository.root, goalId: returned.goalId, changeId: change.change.metadata.changeId, instruction: "Remain open for recovery.", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] }, model: "fixture", thinking: "medium" });
    const beforeRecovery = await gitSnapshot(returned.repository);
    const recovered = await reconcileGoal({ cwd: returned.repository.root, goalId: returned.goalId, recoverApplications: false });
    expect(recovered.interruptedTickets.map((entry) => entry.report.metadata.ticketId)).toEqual(["001"]);
    expect(await gitSnapshot(returned.repository)).toEqual(beforeRecovery);

    const stale = await fixture(false);
    await writeFile(join(stale.repository.root, "moved.txt"), "moved\n"); await stale.repository.git("add", "moved.txt"); await stale.repository.git("commit", "--quiet", "-m", "move main");
    await staleApplication({ cwd: stale.repository.root, goalId: stale.goalId, applicationId: "001" });
    const staleCalls: string[] = [];
    const beforeFrozenPlanner = await gitSnapshot(stale.repository);
    await expect(goalPlannerOperations.startOrReattach({ cwd: stale.repository.root, goalId: stale.goalId, herdr: fakePlanner(staleCalls) })).rejects.toThrow("frozen");
    expect(staleCalls).toEqual([]);
    expect(await gitSnapshot(stale.repository)).toEqual(beforeFrozenPlanner);
  });

  test("CLI status and conditional supervisor tools expose resolution operations without apply authority", async () => {
    const { repository, goalId, base } = await fixture(true);
    await recordReview(repository, goalId, "001", base, base);
    const env = { ...process.env, SPIKE_DATA_DIR: repository.dataRoot };
    const status = await cli(repository.root, ["application", "status", "--goal", goalId, "--application", "001", "--json"], env);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, command: "application status", data: { resolution: null, candidate: { ticketId: "001", revision: base } } });
    const beforeReturn = await gitSnapshot(repository);
    const returned = await cli(repository.root, ["application", "return", "--goal", goalId, "--application", "001", "--statement", "Return through CLI.", "--json"], env);
    expect(JSON.parse(returned.stdout)).toMatchObject({ ok: true, command: "application return", data: { resolution: { disposition: "return" } } });
    expect(await gitSnapshot(repository)).toEqual(beforeReturn);
    const after = await cli(repository.root, ["application", "status", "--goal", goalId, "--application", "001", "--json"], env);
    expect(JSON.parse(after.stdout)).toMatchObject({ ok: true, data: { resolution: "return", review: { approvalUsable: false } } });

    const withoutApplications: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];
    const withApplications: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];
    const api = (tools: typeof withApplications) => ({ registerTool(tool: typeof withApplications[number]) { tools.push(tool); }, on() {}, sendMessage() {} });
    registerSupervisorExtension(api(withoutApplications), { invoke: async (input) => ({ ok: true, command: input.expectedCommand, data: {} }) });
    registerSupervisorExtension(api(withApplications), { applications: true, invoke: async (input) => ({ ok: true, command: input.expectedCommand, data: {} }) });
    expect(withoutApplications.some((tool) => tool.name === "spike_return_application")).toBe(false);
    expect(withApplications.some((tool) => tool.name === "spike_return_application")).toBe(true);
    expect(withApplications.some((tool) => tool.name === "spike_stale_application")).toBe(true);
    expect(withApplications.some((tool) => tool.name === "spike_apply_queue_head")).toBe(true);
    expect(withApplications.some((tool) => tool.name === "spike_recover_application_apply")).toBe(true);

    const plannerTools: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];
    registerGoalPlannerExtension({ registerTool(tool) { plannerTools.push(tool); }, on() {}, sendMessage() {} }, goalId, "fixture-project", { validateProject: async () => undefined, invoke: async (input) => ({ ok: true, command: input.expectedCommand, data: {} }) });
    expect(plannerTools.some((tool) => tool.name.includes("application") || tool.name === "spike_apply_queue_head")).toBe(false);
  });

  test("returns only reviewed exact Candidate, unfreezes planning, and leaves main and Goal ref unchanged", async () => {
    const { repository, goalId, base } = await fixture(true);
    const reviewTicket = { kind: "application-review-ticket", goalId, applicationId: "001", ticketId: "001", role: "review", issuedAt: stamp, targetRevision: base, goalRevision: base, mergeBase: base, candidateRevision: base, producingImplementationTicketId: "001", model: "fixture", thinking: "medium", executionPolicy: { isolation: "workspace", networkAccess: "none", credentialGrants: [] }, guidance: { step: "review", revision: base } };
    await mkdir(join(applicationReviewTicketPath(repository.root, goalId, "001", "001"), ".."), { recursive: true });
    await writeFile(applicationReviewTicketPath(repository.root, goalId, "001", "001"), serializeDocument(reviewTicket, "# Review\n"));
    const reviewReport = { kind: "application-review-report", goalId, applicationId: "001", ticketId: "001", role: "review", outcome: "completed", publishedAt: stamp, targetRevision: base, goalRevision: base, mergeBase: base, candidateRevision: base, producingImplementationTicketId: "001", verdict: "approve", findings: [], acceptanceAssessment: [], reviewStatement: "Reviewed.", artifacts: [], execution };
    await writeFile(applicationReviewReportPath(repository.root, goalId, "001", "001"), serializeDocument(reviewReport, "# Review report\n"));
    const beforeResolution = await gitSnapshot(repository);
    const returned = await returnApplication({ cwd: repository.root, goalId, applicationId: "001", statement: "Plan product remediation." });
    expect(await gitSnapshot(repository)).toEqual(beforeResolution);
    expect(returned.resolution.metadata.disposition).toBe("return");
    expect(await repository.git("rev-parse", "main")).toBe(base);
    const status = await deriveGoalStatus(repository.root, goalId); expect(status.frozen).toBe(false);
    await createChange({ cwd: repository.root, goalId, title: "After return", intent: "Advance product work.", rationale: "Return released planning.", acceptanceCriteria: ["Planning can continue."] });
    // A returned historical Application has no runtime ownership and cannot
    // prevent ordinary active-Change reconciliation.
    await expect(reconcileGoal({ cwd: repository.root, goalId, recoverApplications: false })).resolves.toMatchObject({ goalId });
    await expect(returnApplication({ cwd: repository.root, goalId, applicationId: "001", statement: "Again." })).rejects.toThrow("exact unresolved FIFO head");
  });
});
}
