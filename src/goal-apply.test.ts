import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, landChange } from "./change.ts";
import { applicationEvidence, applicationPath, listApplicationIds, loadApplication, loadApplicationDecisionIfPresent } from "./application.ts";
import { reconcileGoal } from "./recovery.ts";
import { serializeDocument } from "./durable-state.ts";
import { applyGoalIntegration } from "./goal-apply.ts";
import { createGoal, integratedRef } from "./goal.ts";
import { reportPath } from "./ticket.ts";
import { issueTicket } from "./ticket.ts";
import { temporaryRepository } from "../test/support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };
const timestamp = new Date(0).toISOString();

async function writeCompletedReport(root: string, goalId: string, changeId: string, ticketId: string, metadata: { role: "implement" | "review" } & Record<string, unknown>) {
  const path = reportPath(root, goalId, changeId, ticketId);
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
async function completedGoal() {
  const repository = await temporaryRepository();
  repositories.push(repository);
  const goal = await createGoal({
    cwd: repository.root, title: "Apply a reviewed integration", outcome: "Advance an explicit local target.", approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  const base = await repository.git("rev-parse", "HEAD");
  const change = await createChange({
    cwd: repository.root, goalId, title: "Reviewed integration", intent: "Create the exact integrated commit.",
    rationale: "The durable land decision must select it.", acceptanceCriteria: ["The reviewed commit is landed."],
  });
  const changeId = change.change.metadata.changeId;
  const implementation = await issueTicket({ cwd: repository.root, goalId, changeId, instruction: "Implement fixture.", executionPolicy: policy });
  await writeFile(join(repository.root, "integrated.txt"), "reviewed\n");
  await repository.git("add", "integrated.txt");
  await repository.git("commit", "--quiet", "-m", "Reviewed integration");
  const integrated = await repository.git("rev-parse", "HEAD");
  await writeCompletedReport(repository.root, goalId, changeId, implementation.ticket.metadata.ticketId, {
    role: "implement", baseRevision: base, inputRevision: base, workerRevision: integrated, candidateRevision: integrated,
  });
  const review = await issueTicket({
    cwd: repository.root, goalId, changeId, role: "review", instruction: "Review fixture.", executionPolicy: policy,
  });
  await writeCompletedReport(repository.root, goalId, changeId, review.ticket.metadata.ticketId, {
    role: "review", reviewedRevision: integrated, producingImplementationTicketId: implementation.ticket.metadata.ticketId,
    findings: [], acceptanceAssessment: [{ criterion: "The reviewed commit is landed.", assessment: "met", evidence: "Fixture approval." }],
    reviewStatement: "The exact fixture Candidate is approved.", reviewer: "fixture-reviewer", verdict: "approve",
  });
  await landChange({ cwd: repository.root, goalId, changeId });
  expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(integrated);
  await repository.git("branch", "target", base);
  await repository.git("checkout", "--quiet", "target");
  await repository.git("branch", "-f", "main", base);
  await repository.git("checkout", "--quiet", "main");
  return { repository, goalId, base, integrated };
}

async function cli(cwd: string, args: string[]) {
  const child = Bun.spawn([join(import.meta.dir, "..", "bin", "spike"), ...args], {
    cwd, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
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
    const applied = await applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "main", approval: "I approve this apply." });
    expect(applied.goalId).toBe(goalId);
    expect(applied.applicationId).toBe("001");
    expect(applied.targetBranch).toBe("main");
    expect(applied.previousTargetRevision).toBe(base);
    expect(applied.appliedRevision).toBe(integrated);
    expect(typeof applied.resultingTargetRevision).toBe("string");
    expect(await repository.git("rev-parse", "main")).toBe(applied.resultingTargetRevision);
    expect((await repository.git("rev-list", "--parents", "-n", "1", applied.resultingTargetRevision)).split(" ").slice(1)).toEqual([base]);
    expect(await repository.git("rev-parse", `${applied.resultingTargetRevision}^{tree}`)).toBe(await repository.git("rev-parse", `${integrated}^{tree}`));
    expect((await cli(repository.root, ["status", "--goal", goalId])).stdout).toContain("Application 001 applied");
  });

  test("burns an intent ID after an intent-publication crash and persists exact intent and decision evidence", async () => {
    const { repository, goalId, integrated, base } = await completedGoal();
    await expect(applyGoalIntegration({
      cwd: repository.root, goalId, approval: "Approved.",
      crash: async ({ point, moment }) => { if (point === "application-publication" && moment === "after") throw new Error("intent crash"); },
    })).rejects.toThrow("intent crash");
    expect((await applicationEvidence(repository.root, goalId))[0]).toEqual({ applicationId: "001", state: "incomplete" });
    const applied = await applyGoalIntegration({ cwd: repository.root, goalId, approval: "Approved." });
    expect(applied.applicationId).toBe("002");
    const intent = await loadApplication(repository.root, goalId, "002");
    const decision = await loadApplicationDecisionIfPresent(repository.root, goalId, "002");
    expect(intent.metadata).toMatchObject({ goalId, applicationId: "002", target: "main", integratedRevision: integrated, approval: "Approved." });
    expect(decision?.metadata).toMatchObject({ goalId, applicationId: "002", expectedPreviousMainRevision: base, candidateRevision: applied.resultingTargetRevision, resultingMainRevision: applied.resultingTargetRevision });
    expect(applicationPath(repository.root, goalId, "001")).toContain("applications/001/application.md");
  });

  test("classifies a published decision at expected main as recoverable incomplete, displays it, and recovers exactly", async () => {
    const { repository, goalId, base } = await completedGoal();
    await expect(applyGoalIntegration({
      cwd: repository.root, goalId, approval: "Approved.",
      crash: async ({ point, moment }) => { if (point === "application-decision-publication" && moment === "after") throw new Error("decision crash"); },
    })).rejects.toThrow("decision crash");
    expect(await applicationEvidence(repository.root, goalId)).toEqual([{ applicationId: "001", state: "incomplete" }]);
    const status = await cli(repository.root, ["status", "--goal", goalId]);
    expect(status.stdout).toContain("Application 001 incomplete");
    await reconcileGoal({ cwd: repository.root, goalId });
    expect(await repository.git("rev-parse", "main")).not.toBe(base);
    expect(await applicationEvidence(repository.root, goalId)).toEqual([{ applicationId: "001", state: "applied" }]);
  });

  test("recovers both moments of every Application commit point with exact main and worktree projections", async () => {
    const cases: Array<{
      point: "application-publication" | "application-decision-publication" | "application-target-advance";
      moment: "before" | "after";
      decided: boolean;
    }> = [
      { point: "application-publication", moment: "before", decided: false },
      { point: "application-publication", moment: "after", decided: false },
      { point: "application-decision-publication", moment: "before", decided: false },
      { point: "application-decision-publication", moment: "after", decided: true },
      { point: "application-target-advance", moment: "before", decided: true },
      { point: "application-target-advance", moment: "after", decided: true },
    ];
    for (const { point, moment, decided } of cases) {
      const { repository, goalId, base } = await completedGoal();
      await expect(applyGoalIntegration({
        cwd: repository.root, goalId, approval: "Approved.",
        crash: async (event) => { if (event.point === point && event.moment === moment) throw new Error(`${point}-${moment}`); },
      })).rejects.toThrow(`${point}-${moment}`);

      // Before recovery, a target-after crash is already at its exact result;
      // every other decision-bearing crash remains at the expected base.
      const before = await applicationEvidence(repository.root, goalId);
      expect(before).toEqual([{ applicationId: "001", state: point === "application-target-advance" && moment === "after" ? "applied" : "incomplete" }]);
      await reconcileGoal({ cwd: repository.root, goalId });
      const decision = await loadApplicationDecisionIfPresent(repository.root, goalId, "001");
      expect(decision !== undefined).toBe(decided);
      const result = decision?.metadata.resultingMainRevision;
      await expectMainWorktree(repository, decided ? result! : base, decided);
      expect(await applicationEvidence(repository.root, goalId)).toEqual([{ applicationId: "001", state: decided ? "applied" : "incomplete" }]);
    }
  });

  test("refuses an ordinarily advanced clean base before publishing an Application or changing Git", async () => {
    const { repository, goalId } = await completedGoal();
    await writeFile(join(repository.root, "later.txt"), "ordinary main advance\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Ordinary main advance");
    const advanced = await repository.git("rev-parse", "main");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, approval: "Approved." })).rejects.toThrow("does not equal Goal initial revision");
    expect(await listApplicationIds(repository.root, goalId)).toEqual([]);
    expect(await Bun.file(applicationPath(repository.root, goalId, "001")).exists()).toBe(false);
    await expectMainWorktree(repository, advanced, false);
    expect(await Bun.file(join(repository.root, "later.txt")).text()).toBe("ordinary main advance\n");
  });

  test("refuses a conflicting untracked worktree update without overwriting it", async () => {
    const { repository, goalId, base } = await completedGoal();
    await writeFile(join(repository.root, "integrated.txt"), "untracked local work\n");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, approval: "Approved." })).rejects.toThrow();
    expect(await repository.git("rev-parse", "main")).toBe(base);
    expect(await Bun.file(join(repository.root, "integrated.txt")).text()).toBe("untracked local work\n");
  });

  test("does not overwrite unexpected target movement during decision recovery", async () => {
    const { repository, goalId } = await completedGoal();
    await expect(applyGoalIntegration({
      cwd: repository.root, goalId, approval: "Approved.",
      crash: async ({ point, moment }) => { if (point === "application-target-advance" && moment === "before") throw new Error("advance crash"); },
    })).rejects.toThrow("advance crash");
    await writeFile(join(repository.root, "later.txt"), "later\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Unexpected movement");
    const moved = await repository.git("rev-parse", "main");
    await expect(reconcileGoal({ cwd: repository.root, goalId })).rejects.toThrow("apply recovery refused");
    expect(await repository.git("rev-parse", "main")).toBe(moved);
  });

  test("keeps a valid decided Goal terminal after later main movement while status remains projection-sensitive", async () => {
    const { repository, goalId } = await completedGoal();
    await applyGoalIntegration({ cwd: repository.root, goalId, approval: "Approved." });
    await writeFile(join(repository.root, "later.txt"), "later\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Later main movement");
    expect(await applicationEvidence(repository.root, goalId)).toEqual([{ applicationId: "001", state: "inconsistent" }]);
    expect((await cli(repository.root, ["status", "--goal", goalId])).stdout).toContain("Application 001 inconsistent");
    await expect(createChange({
      cwd: repository.root, goalId, title: "Must not be created", intent: "Terminal goals cannot change.", rationale: "A valid decision is immutable.", acceptanceCriteria: ["It is refused."],
    })).rejects.toThrow("terminal after application");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, approval: "Again." })).rejects.toThrow("terminal after application");
  });

  test("requires approval and refuses a non-main target before publication", async () => {
    const { repository, goalId, base } = await completedGoal();
    const missing = await cli(repository.root, ["goal", "apply", "--goal", goalId, "--target", "main", "--json"]);
    expect(missing.exitCode).toBe(2);
    expect(await repository.git("rev-parse", "main")).toBe(base);
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("only supported target");
    expect(await repository.git("rev-parse", "main")).toBe(base);
  });
});
