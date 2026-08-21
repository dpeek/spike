import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, landChange } from "../../src/change.ts";
import { serializeDocument } from "../../src/durable-state.ts";
import { applyQueueHead, queueGoalIntegration } from "../../src/goal-apply.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { reconcileGoal } from "../../src/recovery.ts";
import { applicationCandidateRef, applicationExchangePath, applicationReportPath, deriveApplicationStatus, issueApplicationTicket, loadApplicationReportIfPresent, prepareApplicationTicketExchange, publishApplicationImplementationReport, recoverApplicationTicket } from "../../src/application-ticket.ts";
import { applicationWorkerRecordPath, dispatchApplicationWorker } from "../../src/application-worker.ts";
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
  // A tracked common file gives the diverged Application scenarios both
  // non-overlapping same-file and true textual-conflict inputs.
  await writeFile(join(repository.root, "shared.txt"), "one\nbase-goal\nseparator\nbase-target\ntwo\n");
  await repository.git("add", "shared.txt"); await repository.git("commit", "--quiet", "-m", "Shared integration base");
  const goal = await createGoal({ cwd: repository.root, title: "Scenario Application", outcome: "Recover a squash Application.", approval: "Approved." });
  const goalId = goal.goal.metadata.goalId;
  const base = await repository.git("rev-parse", "HEAD");
  const change = await createChange({ cwd: repository.root, goalId, title: "Scenario change", intent: "Produce a reviewed tree.", rationale: "Application needs durable integration.", acceptanceCriteria: ["The scenario tree is approved."] });
  const implementation = await issueTicket({ cwd: repository.root, goalId, changeId: change.change.metadata.changeId, instruction: "Implement.", executionPolicy: policy });
  await writeFile(join(repository.root, "scenario.txt"), "squashed scenario\n");
  await writeFile(join(repository.root, "shared.txt"), "one\ngoal\nseparator\nbase-target\ntwo\n");
  await repository.git("add", "scenario.txt", "shared.txt"); await repository.git("commit", "--quiet", "-m", "Scenario candidate");
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
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Operator approves this scenario." });
  await expect(applyQueueHead({
    cwd: repository.root, goalId, applicationId: queued.applicationId,
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

const workerCommand = `
const out = process.env.SPIKE_OUTPUT_DIR;
const revision = (await Bun.$\`git rev-parse --verify HEAD\`.text()).trim();
if (revision !== process.env.SPIKE_INPUT_REVISION) process.exit(41);
const refs = await new Response(Bun.spawn(["git", "for-each-ref", "--format=%(refname)", \`refs/spike/application-input/\${process.env.SPIKE_GOAL_ID}/\${process.env.SPIKE_APPLICATION_ID}/\${process.env.SPIKE_TICKET_ID}/\`], { stdout: "pipe" }).stdout).text();
if (!refs.includes("/input")) process.exit(42);
await Bun.$\`git config user.name Scenario\`; await Bun.$\`git config user.email scenario@example.test\`;
await Bun.write("worker-result.txt", "completed\\n"); await Bun.$\`git add worker-result.txt\`; await Bun.$\`git commit -m worker-result\`;
const worker = (await Bun.$\`git rev-parse HEAD\`.text()).trim();
await Bun.$\`git bundle create \${out}/repository.bundle HEAD\`;
await Bun.write(\`\${out}/submission.md\`, "---\\n" + JSON.stringify({ kind: "application-submission", goalId: process.env.SPIKE_GOAL_ID, applicationId: process.env.SPIKE_APPLICATION_ID, ticketId: process.env.SPIKE_TICKET_ID, outcome: "completed", workerRevision: worker, artifacts: [] }, null, 2) + "\\n---\\n\\n## Summary\\n\\nDone.\\n\\n## Verification\\n\\nReal Git.\\n\\n## Assumptions\\n\\nNone.\\n\\n## Limitations\\n\\nNone.\\n\\n## Risks\\n\\nNone.\\n\\n## Follow-up\\n\\nNone.\\n");
`;

test("scenario: diverged Application uses supported content merges, verified custom refs, and recorded execution", async () => {
  const { repository, goalId, base } = await readyGoal();
  // M and G both edit shared.txt, but different lines: a real content merge
  // must be clean (read-tree index merging would not establish this).
  await writeFile(join(repository.root, "shared.txt"), "one\nbase-goal\nseparator\ntarget\ntwo\n");
  await repository.git("add", "shared.txt"); await repository.git("commit", "--quiet", "-m", "Target non-overlap");
  const target = await repository.git("rev-parse", "HEAD");
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Diverged candidate." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate.", executionPolicy: { ...policy, isolation: "container" } });
  const ticket = issued.ticket.metadata;
  expect(ticket.targetRevision).toBe(target);
  expect(ticket.mergeBase).toBe(base);
  expect(ticket.integration.classification).toBe("clean");
  expect(await repository.git("show", `${ticket.inputRevision}:shared.txt`)).toBe("one\ngoal\nseparator\ntarget\ntwo");

  const identity = { goalId, applicationId: queued.applicationId, ticketId: ticket.ticketId };
  const prepared = await prepareApplicationTicketExchange(repository.root, identity);
  // Explicit prepare followed by dispatch is one idempotent operational flow.
  expect((await prepareApplicationTicketExchange(repository.root, identity)).inputDirectory).toBe(prepared.inputDirectory);
  const dispatched = await dispatchApplicationWorker({ cwd: repository.root, ...identity, worker: "scenario-worker", command: ["bun", "-e", workerCommand] });
  expect(dispatched.execution.exitCode).toBe(0);
  const execution = dispatched.execution;
  await expect(publishApplicationImplementationReport({ cwd: repository.root, ...identity, message: { summary: "Deliver Goal candidate" }, execution: { adapter: "forged", isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } })).rejects.toThrow("exact recorded Worker");
  const published = await publishApplicationImplementationReport({ cwd: repository.root, ...identity, message: { summary: "Deliver Goal candidate" }, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
  expect(await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, ticket.ticketId))).toBe(published.report.metadata.candidateRevision!);
  expect(await Bun.file(applicationReportPath(repository.root, goalId, queued.applicationId, ticket.ticketId)).exists()).toBe(true);
  expect((await deriveApplicationStatus(repository.root, goalId, queued.applicationId)).cleanupWarnings.join(" ")).toContain("exchange remains");
  // Retention is a derived projection and supervisor recovery rebuilds it,
  // while cleanup independently forgets the completed runtime/exchange.
  await repository.git("update-ref", "-d", applicationCandidateRef(goalId, queued.applicationId, ticket.ticketId));
  expect((await deriveApplicationStatus(repository.root, goalId, queued.applicationId)).cleanupWarnings.join(" ")).toContain("missing");
  await reconcileGoal({ cwd: repository.root, goalId });
  expect(await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, ticket.ticketId))).toBe(published.report.metadata.candidateRevision!);
  expect((await deriveApplicationStatus(repository.root, goalId, queued.applicationId)).cleanupWarnings).toEqual([]);
  expect(await repository.git("rev-parse", "main")).toBe(target);
});

test("scenario: interruption before Application Report recovers moved target without changing host or Goal evidence", async () => {
  const { repository, goalId } = await readyGoal();
  await writeFile(join(repository.root, "target-only.txt"), "M\n"); await repository.git("add", "target-only.txt"); await repository.git("commit", "--quiet", "-m", "Diverged target");
  const target = await repository.git("rev-parse", "main");
  const goalRevision = await repository.git("rev-parse", integratedRef(goalId));
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Interrupted before Report." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate." });
  const identity = { goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId };
  await dispatchApplicationWorker({ cwd: repository.root, ...identity, worker: "interrupted-worker", command: ["bun", "-e", workerCommand] });
  const candidate = applicationCandidateRef(goalId, queued.applicationId, identity.ticketId);
  const quarantine = `refs/spike/quarantine/goals/${goalId}/applications/${queued.applicationId}/tickets/${identity.ticketId}/interrupted`;
  await repository.git("update-ref", candidate, target); await repository.git("update-ref", quarantine, target);
  await writeFile(join(repository.root, "moved.txt"), "later M\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "Main moved during worker interruption");
  const moved = await repository.git("rev-parse", "main");

  await recoverApplicationTicket(repository.root, goalId, queued.applicationId, identity.ticketId);

  const recovered = (await loadApplicationReportIfPresent(repository.root, goalId, queued.applicationId, identity.ticketId))!;
  expect(recovered.metadata.outcome).toBe("interrupted");
  expect(recovered.metadata.targetRevision).toBe(issued.ticket.metadata.targetRevision);
  expect(recovered.metadata.goalRevision).toBe(issued.ticket.metadata.goalRevision);
  expect(recovered.metadata.mergeBase).toBe(issued.ticket.metadata.mergeBase);
  expect(await Bun.file(applicationExchangePath(repository.root, identity)).exists()).toBe(false);
  expect(await Bun.file(applicationWorkerRecordPath(repository.root, identity)).exists()).toBe(false);
  await expect(repository.git("show-ref", "--verify", "--quiet", candidate)).rejects.toThrow();
  await expect(repository.git("show-ref", "--verify", "--quiet", quarantine)).rejects.toThrow();
  expect(await repository.git("rev-parse", "main")).toBe(moved);
  expect(await repository.git("rev-parse", "HEAD")).toBe(moved);
  expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(goalRevision);
  expect(await repository.git("status", "--porcelain")).toBe("");
});

test("scenario: interruption after Application Report cleans projections and rebuilds reported retention after target movement", async () => {
  const { repository, goalId } = await readyGoal();
  await writeFile(join(repository.root, "target-only.txt"), "M\n"); await repository.git("add", "target-only.txt"); await repository.git("commit", "--quiet", "-m", "Diverged target");
  const target = await repository.git("rev-parse", "main");
  const goalRevision = await repository.git("rev-parse", integratedRef(goalId));
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Interrupted after Report." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate." });
  const identity = { goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId };
  const dispatched = await dispatchApplicationWorker({ cwd: repository.root, ...identity, worker: "reported-worker", command: ["bun", "-e", workerCommand] });
  const execution = dispatched.execution;
  const published = await publishApplicationImplementationReport({ cwd: repository.root, ...identity, message: { summary: "Deliver interrupted Goal candidate" }, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
  const candidate = applicationCandidateRef(goalId, queued.applicationId, identity.ticketId);
  const debris = `refs/spike/goals/${goalId}/applications/${queued.applicationId}/tickets/999`;
  const quarantine = `refs/spike/quarantine/goals/${goalId}/applications/${queued.applicationId}/tickets/${identity.ticketId}/reported`;
  await repository.git("update-ref", candidate, target); await repository.git("update-ref", debris, target); await repository.git("update-ref", quarantine, target);
  await writeFile(join(repository.root, "moved.txt"), "later M\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "Main moved after Report");
  const moved = await repository.git("rev-parse", "main");

  await recoverApplicationTicket(repository.root, goalId, queued.applicationId, identity.ticketId);

  const recovered = (await loadApplicationReportIfPresent(repository.root, goalId, queued.applicationId, identity.ticketId))!;
  expect(recovered.metadata).toEqual(published.report.metadata);
  expect(await Bun.file(applicationExchangePath(repository.root, identity)).exists()).toBe(false);
  expect(await Bun.file(applicationWorkerRecordPath(repository.root, identity)).exists()).toBe(false);
  expect(await repository.git("rev-parse", candidate)).toBe(published.report.metadata.candidateRevision!);
  await expect(repository.git("show-ref", "--verify", "--quiet", debris)).rejects.toThrow();
  await expect(repository.git("show-ref", "--verify", "--quiet", quarantine)).rejects.toThrow();
  expect(await repository.git("rev-parse", "main")).toBe(moved);
  expect(await repository.git("rev-parse", "HEAD")).toBe(moved);
  expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(goalRevision);
  expect(await repository.git("status", "--porcelain")).toBe("");
});

test("scenario: target movement refuses prepared Application production before Report effects", async () => {
  const { repository, goalId } = await readyGoal();
  await writeFile(join(repository.root, "target-only.txt"), "M\n"); await repository.git("add", "target-only.txt"); await repository.git("commit", "--quiet", "-m", "Diverged target");
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Movement candidate." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate." });
  await writeFile(join(repository.root, "moved.txt"), "later M\n"); await repository.git("add", "moved.txt"); await repository.git("commit", "--quiet", "-m", "Main moved");
  await expect(prepareApplicationTicketExchange(repository.root, { goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId })).rejects.toThrow("target mismatch");
  expect(await Bun.file(applicationReportPath(repository.root, goalId, queued.applicationId, issued.ticket.metadata.ticketId)).exists()).toBe(false);
});

test("scenario: malformed output is refused before Application Report or retention effects", async () => {
  const { repository, goalId } = await readyGoal();
  await writeFile(join(repository.root, "target-only.txt"), "M\n"); await repository.git("add", "target-only.txt"); await repository.git("commit", "--quiet", "-m", "Diverged target");
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Invalid-output candidate." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate." });
  const identity = { goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId };
  const dispatched = await dispatchApplicationWorker({ cwd: repository.root, ...identity, worker: "invalid-output", command: ["bun", "-e", "process.exit(0)"] });
  await writeFile(join(dispatched.exchange.outputDirectory, "submission.md"), "not an Application Submission\n");
  const execution = dispatched.execution;
  await expect(publishApplicationImplementationReport({ cwd: repository.root, ...identity, message: { summary: "Invalid output" }, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } })).rejects.toThrow("document must start");
  expect(await Bun.file(applicationReportPath(repository.root, goalId, queued.applicationId, identity.ticketId)).exists()).toBe(false);
  await expect(repository.git("show-ref", "--verify", "--quiet", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId))).rejects.toThrow();
});

test("scenario: diverged Application records a true textual conflict without moving main", async () => {
  const { repository, goalId, base } = await readyGoal();
  await writeFile(join(repository.root, "shared.txt"), "one\ntarget-conflict\nseparator\nbase-target\ntwo\n");
  await repository.git("add", "shared.txt"); await repository.git("commit", "--quiet", "-m", "Target conflict");
  const target = await repository.git("rev-parse", "HEAD");
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Conflict candidate." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Resolve conflict." });
  expect(issued.ticket.metadata.mergeBase).toBe(base);
  expect(issued.ticket.metadata.integration.classification).toBe("conflict");
  expect(issued.ticket.metadata.inputRevision).toBe(target);
  expect(issued.ticket.metadata.integration.conflictEvidence).toContain("shared.txt");
  // The workspace contract also consumes the declared refs and starts exactly
  // from M for a conflict (the container contract is exercised above).
  const execution = await dispatchApplicationWorker({ cwd: repository.root, goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId, worker: "workspace-scenario", command: ["bun", "-e", "if ((await Bun.$`git rev-parse HEAD`.text()).trim() !== process.env.SPIKE_INPUT_REVISION) process.exit(51)"] });
  expect(execution.execution.exitCode).toBe(0);
  expect(await repository.git("rev-parse", "main")).toBe(target);
});
