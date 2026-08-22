import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abandonChange, createChange, landChange, rejectChange } from "../../src/change.ts";
import { applicationDecisionPath, applicationEvidence, applicationPath, createSquashCandidate, listApplicationIds, listProjectApplications, loadApplicationDecisionIfPresent, publishApplyDecision, queuedApplicationHead, recoverApplications } from "../../src/application.ts";
import { reconcileGoal, reconcileRepository, recoverInterruptedTicket, stopTicket } from "../../src/recovery.ts";
import { refreshChangeChurn, revisePlan } from "../../src/plan.ts";
import { publishBlockedReport } from "../../src/report.ts";
import { deriveRepositoryStatus } from "../../src/status.ts";
import { serializeDocument } from "../../src/durable-state.ts";
import { applyQueueHead, queueGoalIntegration } from "../../src/goal-apply.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { reportPath } from "../../src/ticket.ts";
import { issueReplacementTicket, issueTicket } from "../../src/ticket.ts";
import { temporaryRepository } from "../support/repository.ts";

setDefaultTimeout(15_000);


const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };
const timestamp = new Date(0).toISOString();

// Legacy scenarios exercise the new two-step production operations as one test helper.
async function applyGoalIntegration(input: Parameters<typeof queueGoalIntegration>[0]) {
  const queued = await queueGoalIntegration(input);
  return applyQueueHead({ cwd: input.cwd, hostPaths: input.hostPaths, goalId: queued.goalId, applicationId: queued.applicationId, ...(input.now === undefined ? {} : { now: input.now }), ...(input.crash === undefined ? {} : { crash: input.crash }) });
}

async function writeCompletedReport(repository: Awaited<ReturnType<typeof temporaryRepository>>, goalId: string, changeId: string, ticketId: string, metadata: { role: "implement" | "review" } & Record<string, unknown>) {
  const path = reportPath(repository.project, goalId, changeId, ticketId);
  const review = metadata.role === "review";
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeDocument({
    kind: "report", goalId, changeId, ticketId, publishedAt: timestamp, artifacts: [],
    execution: { adapter: "local-clone", isolation: "workspace", worker: "fixture-worker", model: review ? "review-model" : "implementation-model", thinking: review ? "high" : "medium", startedAt: timestamp, finishedAt: timestamp },
    outcome: "completed", ...metadata,
  }, "# Completed fixture report\n"));
}

/** Builds the same implementation-report, approval-report, and land-decision
 * evidence that durable integration derivation requires. */
async function completedGoal(existing?: Awaited<ReturnType<typeof temporaryRepository>>) {
  const repository = existing ?? await temporaryRepository();
  const goal = await createGoal({
    cwd: repository.root, hostPaths: repository.hostPaths, title: "Apply a reviewed integration", outcome: "Advance an explicit local target.", approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  const base = await repository.git("rev-parse", "HEAD");
  const change = await createChange({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId, title: "Reviewed integration", intent: "Create the exact integrated commit.",
    rationale: "The durable land decision must select it.", acceptanceCriteria: ["The reviewed commit is landed."],
  });
  const changeId = change.change.metadata.changeId;
  const implementation = await issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, instruction: "Implement fixture.", executionPolicy: policy });
  await writeFile(join(repository.root, "integrated.txt"), "reviewed\n");
  await repository.git("add", "integrated.txt");
  await repository.git("commit", "--quiet", "-m", "Reviewed integration");
  const integrated = await repository.git("rev-parse", "HEAD");
  await writeCompletedReport(repository, goalId, changeId, implementation.ticket.metadata.ticketId, {
    role: "implement", baseRevision: base, inputRevision: base, workerRevision: integrated, candidateRevision: integrated,
  });
  const review = await issueTicket({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId, role: "review", instruction: "Review fixture.", executionPolicy: policy,
  });
  await writeCompletedReport(repository, goalId, changeId, review.ticket.metadata.ticketId, {
    role: "review", reviewedRevision: integrated, producingImplementationTicketId: implementation.ticket.metadata.ticketId,
    findings: [], acceptanceAssessment: [{ criterion: "The reviewed commit is landed.", assessment: "met", evidence: "Fixture approval." }],
    reviewStatement: "The exact fixture Candidate is approved.", reviewer: "fixture-reviewer", verdict: "approve",
  });
  await landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId });
  expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(integrated);
  await repository.git("branch", `target-${goalId}`, base);
  await repository.git("checkout", "--quiet", `target-${goalId}`);
  await repository.git("branch", "-f", "main", base);
  await repository.git("checkout", "--quiet", "main");
  return { repository, goalId, base, integrated };
}

async function cli(repository: Awaited<ReturnType<typeof temporaryRepository>>, args: string[]) {
  const child = Bun.spawn([join(import.meta.dir, "..", "..", "bin", "spike"), ...args], {
    cwd: repository.root, env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

/** Assert both the checked-out ref and files Git projects for a recovery outcome. */
async function expectMainWorktree(repository: Awaited<ReturnType<typeof temporaryRepository>>, revision: string, integrated: boolean) {
  expect(await repository.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await repository.git("rev-parse", "main")).toBe(revision);
  expect(await repository.git("rev-parse", "HEAD")).toBe(revision);
  await repository.git("diff", "--quiet", revision);
  await repository.git("diff", "--cached", "--quiet", revision);
  expect(await Bun.file(join(repository.root, "integrated.txt")).exists()).toBe(integrated);
  if (integrated) expect(await Bun.file(join(repository.root, "integrated.txt")).text()).toBe("reviewed\n");
}


describe("Goal integration apply", () => {
  test("squashes the integrated tree onto checked-out clean-base main", async () => {
    const { repository, goalId, base, integrated } = await completedGoal();
    const applied = await applyGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, targetBranch: "main", approval: "I approve this apply." });
    expect(applied.goalId).toBe(goalId);
    expect(applied.applicationId).toBe("001");
    expect(applied.targetBranch).toBe("main");
    expect(applied.previousTargetRevision).toBe(base);
    expect(applied.appliedRevision).toBe(integrated);
    expect(typeof applied.resultingTargetRevision).toBe("string");
    expect(await repository.git("rev-parse", "main")).toBe(applied.resultingTargetRevision);
    expect((await repository.git("rev-list", "--parents", "-n", "1", applied.resultingTargetRevision)).split(" ").slice(1)).toEqual([base]);
    expect(await repository.git("rev-parse", `${applied.resultingTargetRevision}^{tree}`)).toBe(await repository.git("rev-parse", `${integrated}^{tree}`));
    expect((await cli(repository, ["status", "--goal", goalId])).stdout).toContain("Application 001 applied");
  });

  test("pre-publication crash burns only the Goal-relative ID and does not freeze admission or recovery", async () => {
    const { repository, goalId } = await completedGoal();
    await expect(queueGoalIntegration({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved.",
      crash: async ({ point, moment }) => { if (point === "application-publication" && moment === "before") throw new Error("publication crash"); },
    })).rejects.toThrow("publication crash");
    expect(await listApplicationIds(repository.project, goalId)).toEqual(["001"]);
    expect(await applicationEvidence(repository.project, goalId)).toEqual([]);
    await reconcileGoal({ cwd: repository.root, hostPaths: repository.hostPaths, goalId });
    const queued = await queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." });
    expect(queued.applicationId).toBe("002");
    await applyQueueHead({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, applicationId: queued.applicationId });
  });

  test("treats malformed Application documents as burned IDs rather than freeze or queue evidence", async () => {
    const { repository, goalId } = await completedGoal();
    const path = applicationPath(repository.project, goalId, "001");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "not an Application document\n");
    expect(await listApplicationIds(repository.project, goalId)).toEqual(["001"]);
    expect(await applicationEvidence(repository.project, goalId)).toEqual([]);
    const change = await createChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, title: "Still mutable", intent: "Invalid Application is not evidence.", rationale: "Only valid immutable documents freeze.", acceptanceCriteria: ["It is created."] });
    expect(change.change.metadata.changeId).toBe("002");
  });

  test("keeps malformed decisions and invalid Candidates closed", async () => {
    for (const evidence of ["malformed-decision", "invalid-candidate"] as const) {
      const { repository, goalId, base } = await completedGoal();
      const queued = await queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." });
      if (evidence === "malformed-decision") {
        await writeFile(applicationDecisionPath(repository.project, goalId, queued.applicationId), "not a decision document\n");
      } else {
        const invalidCandidate = await repository.git("commit-tree", `${base}^{tree}`, "-p", base, "-m", "Invalid Candidate tree");
        const application = (await listProjectApplications(repository.project))[0]!;
        await publishApplyDecision(repository.project, application, invalidCandidate, base);
      }

      if (evidence === "malformed-decision") {
        expect((await listProjectApplications(repository.project))[0]).toMatchObject({ invalidDecision: true });
        expect(await queuedApplicationHead(repository.project)).toMatchObject({ metadata: { goalId, applicationId: queued.applicationId, queuePosition: 1 } });
      } else {
        const status = await deriveRepositoryStatus(repository.root, repository.hostPaths);
        expect(status.applicationQueue[0]).toMatchObject({ state: "inconsistent", queueMember: true });
        expect(status.queueHead).toMatchObject({ goalId, applicationId: queued.applicationId, queuePosition: 1 });
      }
      await expect(recoverApplications(repository.project)).rejects.toThrow("invalid decision evidence");
      expect(await repository.git("rev-parse", "main")).toBe(base);
    }
  });

  test("classifies a published decision at expected main as recoverable incomplete, displays it, and recovers exactly", async () => {
    const { repository, goalId, base } = await completedGoal();
    await expect(applyGoalIntegration({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved.",
      crash: async ({ point, moment }) => { if (point === "application-decision-publication" && moment === "after") throw new Error("decision crash"); },
    })).rejects.toThrow("decision crash");
    expect(await applicationEvidence(repository.project, goalId)).toEqual([{ applicationId: "001", state: "incomplete" }]);
    const status = await cli(repository, ["status", "--goal", goalId]);
    expect(status.stdout).toContain("Application 001 incomplete");
    await reconcileGoal({ cwd: repository.root, hostPaths: repository.hostPaths, goalId });
    expect(await repository.git("rev-parse", "main")).not.toBe(base);
    expect(await applicationEvidence(repository.project, goalId)).toEqual([{ applicationId: "001", state: "applied" }]);
  });

  test("rejects a schema-valid diverged decision before status, later-head selection, and recovery mutate main", async () => {
    const first = await completedGoal();
    const second = await completedGoal(first.repository);
    const planners = { ...({} as any), release: async () => undefined };
    const one = await queueGoalIntegration({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: first.goalId, approval: "First.", planners });
    const two = await queueGoalIntegration({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: second.goalId, approval: "Second.", planners });
    await writeFile(join(first.repository.root, "later.txt"), "ordinary main advance\n");
    await first.repository.git("add", "later.txt");
    await first.repository.git("commit", "--quiet", "-m", "Ordinary main advance");
    const advanced = await first.repository.git("rev-parse", "main");
    const application = (await listProjectApplications(first.repository.project))[0]!;
    const candidate = await createSquashCandidate(first.repository.project, first.goalId, first.integrated, advanced);
    const decision = await publishApplyDecision(first.repository.project, application, candidate, advanced);
    expect(decision.metadata.expectedPreviousMainRevision).toBe(advanced);
    expect((await loadApplicationDecisionIfPresent(first.repository.project, first.goalId, one.applicationId))!.metadata).toEqual(decision.metadata);

    expect(await applicationEvidence(first.repository.project, first.goalId)).toEqual([{ applicationId: one.applicationId, state: "inconsistent" }]);
    const beforeRecovery = await deriveRepositoryStatus(first.repository.root, first.repository.hostPaths);
    expect(beforeRecovery.applicationQueue.map((entry) => entry.state)).toEqual(["inconsistent", "queued"]);
    expect(beforeRecovery.queueHead).toMatchObject({ goalId: first.goalId, applicationId: one.applicationId, queuePosition: 1 });
    expect(await queuedApplicationHead(first.repository.project)).toMatchObject({ metadata: { goalId: first.goalId, applicationId: one.applicationId } });
    await expect(applyQueueHead({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: second.goalId, applicationId: two.applicationId })).rejects.toThrow("not the exact FIFO queue head");

    await expect(reconcileRepository({ cwd: first.repository.root, hostPaths: first.repository.hostPaths }, undefined, planners)).rejects.toThrow("invalid decision evidence");
    expect(await first.repository.git("rev-parse", "main")).toBe(advanced);
    expect(await Bun.file(join(first.repository.root, "later.txt")).text()).toBe("ordinary main advance\n");
    const afterRecovery = await deriveRepositoryStatus(first.repository.root, first.repository.hostPaths);
    expect(afterRecovery.applicationQueue.map((entry) => entry.state)).toEqual(["inconsistent", "queued"]);
    expect(afterRecovery.queueHead).toMatchObject({ goalId: first.goalId, applicationId: one.applicationId, queuePosition: 1 });
  });

});



describe("Goal integration apply", () => {
  test("covers every queue and apply crash commit point with exact target projection recovery", async () => {
    const cases: Array<{ point: "application-publication" | "application-decision-publication" | "application-target-advance"; moment: "before" | "after" }> = [
      { point: "application-publication", moment: "before" }, { point: "application-publication", moment: "after" },
      { point: "application-decision-publication", moment: "before" }, { point: "application-decision-publication", moment: "after" },
      { point: "application-target-advance", moment: "before" }, { point: "application-target-advance", moment: "after" },
    ];
    for (const { point, moment } of cases) {
      const { repository, goalId, base } = await completedGoal();
      const crash = async (event: { point: string; moment: string }) => { if (event.point === point && event.moment === moment) throw new Error(`${point}-${moment}`); };
      if (point === "application-publication") {
        await expect(queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved.", crash })).rejects.toThrow(`${point}-${moment}`);
        expect(await applicationEvidence(repository.project, goalId)).toEqual(moment === "before" ? [] : [{ applicationId: "001", state: "incomplete" }]);
        if (moment === "before") {
          const retry = await queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." });
          expect(retry.applicationId).toBe("002");
        }
      } else {
        const queued = await queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." });
        await expect(applyQueueHead({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, applicationId: queued.applicationId, crash })).rejects.toThrow(`${point}-${moment}`);
        const expectedState = point === "application-target-advance" && moment === "after" ? "applied" : "incomplete";
        expect(await applicationEvidence(repository.project, goalId)).toEqual([{ applicationId: "001", state: expectedState }]);
      }
      await reconcileGoal({ cwd: repository.root, hostPaths: repository.hostPaths, goalId });
      let decision = await loadApplicationDecisionIfPresent(repository.project, goalId, "001");
      if (point === "application-publication" && moment === "before") {
        expect(await repository.git("rev-parse", "main")).toBe(base);
      } else if (point === "application-publication") {
        expect(decision).toBeUndefined();
      } else {
        if (decision === undefined) {
          await applyQueueHead({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, applicationId: "001" });
          decision = await loadApplicationDecisionIfPresent(repository.project, goalId, "001");
        }
        await expectMainWorktree(repository, decision!.metadata.resultingMainRevision, true);
      }
    }
  }, 30_000);

  test("refuses clean-base application only at apply after durable admission", async () => {
    const { repository, goalId } = await completedGoal();
    await writeFile(join(repository.root, "later.txt"), "ordinary main advance\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Ordinary main advance");
    const advanced = await repository.git("rev-parse", "main");
    await expect(applyGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." })).rejects.toThrow("does not equal queue-head Goal initial revision");
    expect(await listApplicationIds(repository.project, goalId)).toEqual(["001"]);
    expect(await Bun.file(applicationPath(repository.project, goalId, "001")).exists()).toBe(true);
    await expectMainWorktree(repository, advanced, false);
    expect(await Bun.file(join(repository.root, "later.txt")).text()).toBe("ordinary main advance\n");
  });

  test("refuses a conflicting untracked worktree update without overwriting it", async () => {
    const { repository, goalId, base } = await completedGoal();
    await writeFile(join(repository.root, "integrated.txt"), "untracked local work\n");
    await expect(applyGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." })).rejects.toThrow();
    expect(await repository.git("rev-parse", "main")).toBe(base);
    expect(await Bun.file(join(repository.root, "integrated.txt")).text()).toBe("untracked local work\n");
  });

  test("does not overwrite unexpected target movement during decision recovery", async () => {
    const { repository, goalId } = await completedGoal();
    await expect(applyGoalIntegration({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved.",
      crash: async ({ point, moment }) => { if (point === "application-target-advance" && moment === "before") throw new Error("advance crash"); },
    })).rejects.toThrow("advance crash");
    await writeFile(join(repository.root, "later.txt"), "later\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Unexpected movement");
    const moved = await repository.git("rev-parse", "main");
    await expect(reconcileGoal({ cwd: repository.root, hostPaths: repository.hostPaths, goalId })).rejects.toThrow("apply recovery refused");
    expect(await repository.git("rev-parse", "main")).toBe(moved);
  });

  test("marks a decision inconsistent when main moves to unrelated history", async () => {
    const { repository, goalId, base } = await completedGoal();
    await applyGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved." });
    await repository.git("checkout", "--quiet", "-b", "unrelated-main", base);
    await writeFile(join(repository.root, "later.txt"), "later\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Unrelated main movement");
    await repository.git("branch", "-f", "main", "HEAD");
    await repository.git("checkout", "--quiet", "main");
    expect(await applicationEvidence(repository.project, goalId)).toEqual([{ applicationId: "001", state: "inconsistent" }]);
    expect((await cli(repository, ["status", "--goal", goalId])).stdout).toContain("Application 001 inconsistent");
    await expect(createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId, title: "Must not be created", intent: "Terminal goals cannot change.", rationale: "A valid decision is immutable.", acceptanceCriteria: ["It is refused."],
    })).rejects.toThrow("frozen");
    await expect(applyGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Again." })).rejects.toThrow("immutable Application evidence");
  });

});



describe("Goal integration apply", () => {
  test("freezes every Goal-local Plan, Change, Ticket, Report, decision, and recovery mutation surface", async () => {
    const { repository, goalId } = await completedGoal();
    await queueGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Freeze.", planners: { ...({} as any), release: async () => undefined } });
    const frozen = "frozen by immutable Application evidence";
    await expect(revisePlan(repository.project, goalId, "Changed plan.")).rejects.toThrow(frozen);
    await expect(refreshChangeChurn(repository.project, goalId, "001")).rejects.toThrow(frozen);
    await expect(createChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, title: "No", intent: "No", rationale: "No", acceptanceCriteria: ["No"] })).rejects.toThrow(frozen);
    await expect(landChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001" })).rejects.toThrow(frozen);
    await expect(rejectChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", statement: "No." })).rejects.toThrow(frozen);
    await expect(abandonChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", statement: "No." })).rejects.toThrow(frozen);
    await expect(issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", instruction: "No.", executionPolicy: policy })).rejects.toThrow(frozen);
    await expect(issueReplacementTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", interruptedTicketId: "001" })).rejects.toThrow(frozen);
    await expect(publishBlockedReport({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", ticketId: "001" } as any)).rejects.toThrow(frozen);
    await expect(stopTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", ticketId: "001", role: "implement", reason: "No." })).rejects.toThrow(frozen);
    await expect(recoverInterruptedTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", ticketId: "001", role: "implement", reason: "No." })).rejects.toThrow(frozen);
    const before = await repository.git("rev-parse", integratedRef(goalId));
    await reconcileGoal({ cwd: repository.root, hostPaths: repository.hostPaths, goalId });
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(before);
  });

  test("keeps a decision-published first Application as the target barrier through status, apply, and restart", async () => {
    const first = await completedGoal();
    const second = await completedGoal(first.repository);
    const one = await queueGoalIntegration({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: first.goalId, approval: "First.", now: new Date(1), planners: { ...({} as any), release: async () => undefined } });
    const two = await queueGoalIntegration({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: second.goalId, approval: "Second.", now: new Date(0), planners: { ...({} as any), release: async () => undefined } });
    const unrelatedRef = await first.repository.git("rev-parse", integratedRef(second.goalId));
    await expect(applyQueueHead({
      cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: one.goalId, applicationId: one.applicationId,
      crash: async ({ point, moment }) => { if (point === "application-decision-publication" && moment === "after") throw new Error("decision boundary"); },
    })).rejects.toThrow("decision boundary");
    const before = await deriveRepositoryStatus(first.repository.root, first.repository.hostPaths);
    expect(before.applicationQueue.map((entry) => entry.state)).toEqual(["queued", "queued"]);
    expect(before.queueHead).toMatchObject({ goalId: one.goalId, applicationId: one.applicationId, queuePosition: 1 });
    await expect(applyQueueHead({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: two.goalId, applicationId: two.applicationId })).rejects.toThrow("not the exact FIFO queue head");
    await reconcileRepository({ cwd: first.repository.root, hostPaths: first.repository.hostPaths }, undefined, { ...({} as any), release: async () => undefined });
    const after = await deriveRepositoryStatus(first.repository.root, first.repository.hostPaths);
    expect(after.applicationQueue.map((entry) => entry.state)).toEqual(["applied", "queued"]);
    expect(after.queueHead).toMatchObject({ goalId: two.goalId, applicationId: two.applicationId, queuePosition: 2 });
    expect(await first.repository.git("rev-parse", integratedRef(second.goalId))).toBe(unrelatedRef);
    expect(await first.repository.git("rev-parse", `target-${second.goalId}`)).toBe(second.base);
    await expect(applyQueueHead({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: two.goalId, applicationId: two.applicationId })).rejects.toThrow("does not equal queue-head Goal initial revision");
  });

  test("retries planner release from published queue evidence without replaying admission", async () => {
    const { repository, goalId } = await completedGoal();
    await expect(queueGoalIntegration({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId, approval: "Approved.", planners: { ...({} as any), release: async () => undefined },
      crash: async ({ point, moment }) => { if (point === "application-publication" && moment === "after") throw new Error("publication boundary"); },
    })).rejects.toThrow("publication boundary");
    let releases = 0;
    const failing = { ...({} as any), release: async () => { releases += 1; throw new Error("planner offline"); } };
    const first = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths }, undefined, failing);
    expect(releases).toBe(1);
    expect(first.plannerCleanupWarnings).toEqual([expect.objectContaining({ goalId, applicationId: "001", message: "planner offline" })]);
    const succeeding = { ...({} as any), release: async () => { releases += 1; } };
    const second = await reconcileRepository({ cwd: repository.root, hostPaths: repository.hostPaths }, undefined, succeeding);
    expect(releases).toBe(2);
    expect(second.plannerCleanupWarnings).toEqual([]);
    expect((await listProjectApplications(repository.project)).map((entry) => entry.metadata.queuePosition)).toEqual([1]);
  });

  test("queues two same-time Goals FIFO, freezes them, and applies only the head", async () => {
    const first = await completedGoal();
    const second = await completedGoal(first.repository);
    const same = new Date(0);
    const one = await queueGoalIntegration({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: first.goalId, approval: "Queue first.", now: same, planners: { ...({} as any), release: async () => undefined } });
    const two = await queueGoalIntegration({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: second.goalId, approval: "Queue second.", now: same, planners: { ...({} as any), release: async () => { throw new Error("Herdr unavailable"); } } });
    expect([one.queuePosition, two.queuePosition]).toEqual([1, 2]);
    expect(two.plannerCleanup.status).toBe("failed");
    expect((await listProjectApplications(first.repository.project)).map((entry) => entry.metadata.goalId)).toEqual([first.goalId, second.goalId]);
    await expect(applyQueueHead({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: second.goalId, applicationId: two.applicationId })).rejects.toThrow("not the exact FIFO queue head");
    await expect(createChange({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: first.goalId, title: "Frozen", intent: "No mutation.", rationale: "Queued.", acceptanceCriteria: ["Refused."] })).rejects.toThrow("frozen");
    const applied = await applyQueueHead({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: first.goalId, applicationId: one.applicationId });
    expect(await first.repository.git("rev-parse", "main")).toBe(applied.resultingTargetRevision);
    await expect(applyQueueHead({ cwd: first.repository.root, hostPaths: first.repository.hostPaths, goalId: second.goalId, applicationId: two.applicationId })).rejects.toThrow("does not equal queue-head Goal initial revision");
  });

  test("requires approval and refuses a non-main target before publication", async () => {
    const { repository, goalId, base } = await completedGoal();
    const missing = await cli(repository, ["goal", "apply", "--goal", goalId, "--target", "main", "--json"]);
    expect(missing.exitCode).toBe(2);
    expect(await repository.git("rev-parse", "main")).toBe(base);
    await expect(applyGoalIntegration({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("only supported target");
    expect(await repository.git("rev-parse", "main")).toBe(base);
  });
});

