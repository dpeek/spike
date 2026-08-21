import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, landChange } from "../../src/change.ts";
import { serializeDocument } from "../../src/durable-state.ts";
import { applyGoalIntegration } from "../../src/goal-apply.ts";
import { createGoal } from "../../src/goal.ts";
import { reconcileGoal } from "../../src/recovery.ts";
import { issueTicket, reportPath } from "../../src/ticket.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => { await Promise.all(repositories.splice(0).map((repository) => repository.remove())); });
const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };
const timestamp = new Date(0).toISOString();

async function report(root: string, goalId: string, changeId: string, ticketId: string, metadata: { role: "implement" | "review" } & Record<string, unknown>) {
  const path = reportPath(root, goalId, changeId, ticketId);
  const review = metadata.role === "review";
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, serializeDocument({
    kind: "report", goalId, changeId, ticketId, publishedAt: timestamp, artifacts: [],
    execution: { adapter: "local-clone", isolation: "workspace", worker: "scenario", model: review ? "review-model" : "implementation-model", thinking: review ? "high" : "medium", startedAt: timestamp, finishedAt: timestamp },
    outcome: "completed", ...metadata,
  }, "# Scenario fixture\n"));
}

/** Establishes real durable integration evidence, then restores checked-out main to its Goal base. */
async function readyGoal() {
  const repository = await temporaryRepository(); repositories.push(repository);
  const goal = await createGoal({ cwd: repository.root, title: "Scenario Application", outcome: "Recover a squash Application.", approval: "Approved." });
  const goalId = goal.goal.metadata.goalId;
  const base = await repository.git("rev-parse", "HEAD");
  const change = await createChange({ cwd: repository.root, goalId, title: "Scenario change", intent: "Produce a reviewed tree.", rationale: "Application needs durable integration.", acceptanceCriteria: ["The scenario tree is approved."] });
  const implementation = await issueTicket({ cwd: repository.root, goalId, changeId: change.change.metadata.changeId, instruction: "Implement.", executionPolicy: policy });
  await writeFile(join(repository.root, "scenario.txt"), "squashed scenario\n");
  await repository.git("add", "scenario.txt"); await repository.git("commit", "--quiet", "-m", "Scenario candidate");
  const integrated = await repository.git("rev-parse", "HEAD");
  await report(repository.root, goalId, "001", implementation.ticket.metadata.ticketId, { role: "implement", baseRevision: base, inputRevision: base, workerRevision: integrated, candidateRevision: integrated });
  const review = await issueTicket({ cwd: repository.root, goalId, changeId: "001", role: "review", instruction: "Review.", executionPolicy: policy });
  await report(repository.root, goalId, "001", review.ticket.metadata.ticketId, { role: "review", reviewedRevision: integrated, producingImplementationTicketId: implementation.ticket.metadata.ticketId, findings: [], acceptanceAssessment: [{ criterion: "The scenario tree is approved.", assessment: "met", evidence: "Scenario approval." }], reviewStatement: "Approved.", reviewer: "scenario", verdict: "approve" });
  await landChange({ cwd: repository.root, goalId, changeId: "001" });
  await repository.git("branch", "scenario-base", base); await repository.git("checkout", "--quiet", "scenario-base");
  await repository.git("branch", "-f", "main", base); await repository.git("checkout", "--quiet", "main");
  return { repository, goalId, base };
}

test("scenario: a decision-published Application recovers its checked-out main squash", async () => {
  const { repository, goalId, base } = await readyGoal();
  await expect(applyGoalIntegration({
    cwd: repository.root, goalId, approval: "Operator approves this scenario.",
    crash: async ({ point, moment }) => { if (point === "application-target-advance" && moment === "before") throw new Error("scenario crash"); },
  })).rejects.toThrow("scenario crash");
  expect(await repository.git("rev-parse", "main")).toBe(base);
  expect(await Bun.file(join(repository.root, "scenario.txt")).exists()).toBe(false);

  await reconcileGoal({ cwd: repository.root, goalId });
  const result = await repository.git("rev-parse", "main");
  expect(result).not.toBe(base);
  expect(await repository.git("rev-parse", "HEAD")).toBe(result);
  expect(await repository.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  await repository.git("diff", "--quiet", result);
  expect(await Bun.file(join(repository.root, "scenario.txt")).text()).toBe("squashed scenario\n");
});
