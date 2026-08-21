import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changeDecisionPath, createChange, landChange } from "./change.ts";
import { serializeDocument } from "./durable-state.ts";
import { applyGoalIntegration } from "./goal-apply.ts";
import { createGoal, integratedRef } from "./goal.ts";
import { reportPath } from "./ticket.ts";
import { issueTicket } from "./ticket.ts";
import { workerRecordPath } from "./worker.ts";
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
  return { repository, goalId, base, integrated };
}

async function cli(cwd: string, args: string[]) {
  const child = Bun.spawn([join(import.meta.dir, "..", "bin", "spike"), ...args], {
    cwd, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe("Goal integration apply", () => {
  test("fast-forwards only the checked-out clean local target to the durably landed revision", async () => {
    const { repository, goalId, base, integrated } = await completedGoal();
    const applied = await applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "I approve this apply." });
    expect(applied).toEqual({ goalId, targetBranch: "target", previousTargetRevision: base, appliedRevision: integrated, resultingTargetRevision: integrated });
    expect(await repository.git("rev-parse", "target")).toBe(integrated);
    expect(await repository.git("rev-parse", "HEAD")).toBe(integrated);
    expect(await repository.git("status", "--porcelain=v1")).toBe("");
  });

  test("returns JSON evidence and requires explicit approval before mutation", async () => {
    const { repository, goalId, base, integrated } = await completedGoal();
    const missing = await cli(repository.root, ["goal", "apply", "--goal", goalId, "--target", "target", "--json"]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout)).toEqual({ ok: false, command: "goal apply", error: { code: "usage", message: "--approval is required" } });
    expect(await repository.git("rev-parse", "target")).toBe(base);
    const success = await cli(repository.root, ["goal", "apply", "--goal", goalId, "--target", "target", "--approval", "Approved.", "--json"]);
    expect(success.exitCode).toBe(0);
    expect(JSON.parse(success.stdout)).toEqual({ ok: true, command: "goal apply", data: { goalId, targetBranch: "target", previousTargetRevision: base, appliedRevision: integrated, resultingTargetRevision: integrated } });
  });

  test("refuses integration-ref drift from the durable land decision without moving refs", async () => {
    const { repository, goalId, base, integrated } = await completedGoal();
    await repository.git("checkout", "--quiet", "-b", "drift", integrated);
    await writeFile(join(repository.root, "drift.txt"), "not reviewed\n");
    await repository.git("add", "drift.txt");
    await repository.git("commit", "--quiet", "-m", "Unreviewed descendant");
    const drift = await repository.git("rev-parse", "HEAD");
    await repository.git("update-ref", integratedRef(goalId), drift);
    await repository.git("checkout", "--quiet", "target");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("does not match its durable landed revision");
    expect(await repository.git("rev-parse", "target")).toBe(base);
    expect(await repository.git("rev-parse", "HEAD")).toBe(base);
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(drift);
  });

  test("refuses divergence, dirty state, unsuitable targets, incomplete Goals, and unhealthy cleanup without mutation", async () => {
    const { repository, goalId, base } = await completedGoal();
    await writeFile(join(repository.root, "target.txt"), "diverged\n");
    await repository.git("add", "target.txt"); await repository.git("commit", "--quiet", "-m", "Target-only commit");
    const diverged = await repository.git("rev-parse", "HEAD");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("cannot fast-forward");
    expect(await repository.git("rev-parse", "HEAD")).toBe(diverged);
    await repository.git("reset", "--hard", base);
    await writeFile(join(repository.root, "untracked.txt"), "dirty\n");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("worktree and index must be clean");
    expect(await repository.git("rev-parse", "target")).toBe(base);
    await repository.git("clean", "-fd"); await repository.git("branch", "other", "target"); await repository.git("checkout", "--quiet", "other");
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("not the currently checked-out local branch");
    expect(await repository.git("rev-parse", "target")).toBe(base);
    await repository.git("checkout", "--quiet", "target");
    await createChange({ cwd: repository.root, goalId, title: "Still active", intent: "Keep incomplete.", rationale: "It blocks application.", acceptanceCriteria: ["Application is refused."] });
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("active Change");
    expect(await repository.git("rev-parse", "target")).toBe(base);
    await issueTicket({ cwd: repository.root, goalId, changeId: "002", instruction: "Leave cleanup evidence.", executionPolicy: policy });
    await writeFile(changeDecisionPath(repository.root, goalId, "002"), serializeDocument({ kind: "change-decision", goalId, changeId: "002", disposition: "abandon", decidedAt: timestamp }, "# Staged resolution\n"));
    const identity = { goalId, changeId: "002", ticketId: "001" }; const path = workerRecordPath(repository.root, identity);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, serializeDocument({ kind: "worker", ...identity, role: "implement", adapter: "local-clone", isolation: "workspace", worker: "left-behind-worker", model: "implementation-model", thinking: "medium", startedAt: timestamp }, "# Cleanup warning\n"));
    await expect(applyGoalIntegration({ cwd: repository.root, goalId, targetBranch: "target", approval: "Approved." })).rejects.toThrow("unhealthy workflow cleanup");
    expect(await repository.git("rev-parse", "target")).toBe(base);
  });
});
