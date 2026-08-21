import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, landChange } from "../../src/change.ts";
import { run as runCli } from "../../src/cli.ts";
import { serializeDocument } from "../../src/durable-state.ts";
import { applyQueueHead, queueGoalIntegration } from "../../src/goal-apply.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { reconcileGoal } from "../../src/recovery.ts";
import { applicationCandidateRef, applicationExchangePath, applicationReportPath, deriveApplicationStatus, issueApplicationTicket, loadApplicationReportIfPresent, prepareApplicationTicketExchange, publishApplicationImplementationReport, recoverApplicationTicket } from "../../src/application-ticket.ts";
import { applicationWorkerRecordPath, dispatchApplicationWorker } from "../../src/application-worker.ts";
import { applicationReviewWorkerRecordPath, dispatchApplicationReviewPiTicket, dispatchApplicationReviewWorker } from "../../src/application-review-worker.ts";
import { applicationReviewExchangePath, applicationReviewReportPath, deriveApplicationReviewStatus, issueApplicationReviewTicket, loadApplicationReviewReportIfPresent, publishApplicationReviewReport, recoverApplicationReviewTicket } from "../../src/application-review.ts";
import { issueTicket, reportPath } from "../../src/ticket.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => { await Promise.all(repositories.splice(0).map((repository) => repository.remove())); });
const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };
const timestamp = new Date(0).toISOString();
const workerCompletionModule = join(import.meta.dir, "../../src/worker-completion.ts");
/** Exercise the worker's production completion boundary inside its dispatched checkout. */
function reviewCompletionCommand(payload: Record<string, unknown>): string[] {
  return ["bun", "-e", `await (await import(${JSON.stringify(workerCompletionModule)})).completeWorker(process.cwd(), ${JSON.stringify(JSON.stringify(payload))});`];
}

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

test("scenario: Application review approves only the exact current Candidate and a later review invalidates it", async () => {
  const { repository, goalId } = await readyGoal();
  await writeFile(join(repository.root, "target-only.txt"), "M\n"); await repository.git("add", "target-only.txt"); await repository.git("commit", "--quiet", "-m", "Diverged target");
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Review candidate." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate.", executionPolicy: policy });
  const identity = { goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId };
  const dispatched = await dispatchApplicationWorker({ cwd: repository.root, ...identity, worker: "review-source", command: ["bun", "-e", workerCommand] });
  const execution = dispatched.execution;
  const implementation = await publishApplicationImplementationReport({ cwd: repository.root, ...identity, message: { summary: "Review source" }, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
  await recoverApplicationTicket(repository.root, goalId, queued.applicationId, identity.ticketId);
  const review = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Review exact candidate.", executionPolicy: policy });
  const assessment = "Recover a squash Application.";
  const dispatchedReview = await dispatchApplicationReviewWorker({ cwd: repository.root, goalId, applicationId: queued.applicationId, ticketId: review.ticket.metadata.ticketId, worker: "reviewer", command: reviewCompletionCommand({ reviewStatement: "Approved exact Candidate.", verdict: "approve", findings: [], acceptanceAssessment: [{ criterion: assessment, assessment: "met", evidence: "Real Git candidate reviewed." }], artifacts: [] }) });
  const reviewExecution = dispatchedReview.execution;
  expect(await runCli(["--json", "application", "review", "publish", "--goal", goalId, "--application", queued.applicationId, "--ticket", review.ticket.metadata.ticketId, "--worker", reviewExecution.worker], repository.root)).toBe(0);
  expect(await Bun.file(applicationReviewWorkerRecordPath(repository.root, { goalId, applicationId: queued.applicationId, ticketId: review.ticket.metadata.ticketId })).exists()).toBe(false);
  expect((await deriveApplicationReviewStatus(repository.root, goalId, queued.applicationId)).approvalUsable).toBe(true);
  // Retained operational cleanup immediately gates otherwise-valid approval.
  await mkdir(applicationReviewExchangePath(repository.root, { goalId, applicationId: queued.applicationId, ticketId: review.ticket.metadata.ticketId }), { recursive: true });
  expect((await deriveApplicationReviewStatus(repository.root, goalId, queued.applicationId)).approvalUsable).toBe(false);
  await Bun.$`rm -rf ${applicationReviewExchangePath(repository.root, { goalId, applicationId: queued.applicationId, ticketId: review.ticket.metadata.ticketId })}`;
  const later = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Reconsider exact candidate.", executionPolicy: policy });
  const piArguments = join(repository.root, ".review-pi-arguments.json"), fakePi = join(repository.root, ".review-pi");
  await writeFile(fakePi, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(piArguments)}, JSON.stringify(process.argv.slice(2)));\nawait (await import(${JSON.stringify(workerCompletionModule)})).completeWorker(process.cwd(), ${JSON.stringify(JSON.stringify({ reviewStatement: "Pause.", verdict: "ask-operator", findings: [], acceptanceAssessment: [{ criterion: assessment, assessment: "unclear", evidence: "Operator decision needed." }], artifacts: [] }))});\n`);
  await chmod(fakePi, 0o755);
  const laterDispatched = await dispatchApplicationReviewPiTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, ticketId: later.ticket.metadata.ticketId, worker: "reviewer", piExecutable: fakePi });
  const productionPiArguments = JSON.parse(await Bun.file(piArguments).text()) as string[];
  expect(productionPiArguments.join(" ")).toContain("spike_complete_review,spike_block_review");
  expect(productionPiArguments.join(" ")).not.toContain("spike_complete_implementation");
  await rm(fakePi); await rm(piArguments);
  await publishApplicationReviewReport({ cwd: repository.root, goalId, applicationId: queued.applicationId, ticketId: later.ticket.metadata.ticketId, execution: { adapter: laterDispatched.execution.adapter, isolation: laterDispatched.execution.isolation, worker: laterDispatched.execution.worker, model: laterDispatched.execution.model, thinking: laterDispatched.execution.thinking, startedAt: laterDispatched.execution.startedAt, finishedAt: laterDispatched.execution.finishedAt } });
  expect((await deriveApplicationReviewStatus(repository.root, goalId, queued.applicationId)).approvalUsable).toBe(false);
  expect(await Bun.file(applicationReviewReportPath(repository.root, goalId, queued.applicationId, later.ticket.metadata.ticketId)).exists()).toBe(true);
  // Recovery is identity-preserving and does not repair a moved target by changing refs or the host worktree.
  const interrupted = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Interrupted review.", executionPolicy: policy });
  const interruptedIdentity = { goalId, applicationId: queued.applicationId, ticketId: interrupted.ticket.metadata.ticketId };
  await dispatchApplicationReviewWorker({ cwd: repository.root, ...interruptedIdentity, worker: "interrupted-reviewer", command: ["bun", "-e", "process.exit(0)"] });
  const candidateRef = await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId));
  const goalRef = await repository.git("rev-parse", integratedRef(goalId));
  await writeFile(join(repository.root, "review-moved.txt"), "later M\n"); await repository.git("add", "review-moved.txt"); await repository.git("commit", "--quiet", "-m", "Main moved during review");
  const moved = await repository.git("rev-parse", "main");
  await recoverApplicationReviewTicket(repository.root, goalId, queued.applicationId, interrupted.ticket.metadata.ticketId);
  const recovered = (await loadApplicationReviewReportIfPresent(repository.root, goalId, queued.applicationId, interrupted.ticket.metadata.ticketId))!;
  expect(recovered.metadata.outcome).toBe("interrupted"); expect(recovered.metadata.candidateRevision).toBe(implementation.report.metadata.candidateRevision); expect(recovered.metadata.producingImplementationTicketId).toBe(identity.ticketId);
  expect(await repository.git("rev-parse", "main")).toBe(moved); expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(goalRef); expect(await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId))).toBe(candidateRef);
  expect(await Bun.file(applicationReviewWorkerRecordPath(repository.root, interruptedIdentity)).exists()).toBe(false);
});

test("scenario: Application review retains remediate and reject as durable non-approvals through the adapter seam", async () => {
  const { repository, goalId } = await readyGoal();
  await writeFile(join(repository.root, "target-only.txt"), "M\n"); await repository.git("add", "target-only.txt"); await repository.git("commit", "--quiet", "-m", "Diverged target");
  const queued = await queueGoalIntegration({ cwd: repository.root, goalId, approval: "Review verdicts." });
  const issued = await issueApplicationTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Produce candidate.", executionPolicy: policy });
  const identity = { goalId, applicationId: queued.applicationId, ticketId: issued.ticket.metadata.ticketId };
  const implementationRun = await dispatchApplicationWorker({ cwd: repository.root, ...identity, worker: "review-verdict-source", command: ["bun", "-e", workerCommand] });
  const implementation = await publishApplicationImplementationReport({ cwd: repository.root, ...identity, message: { summary: "Review verdict source" }, execution: { adapter: implementationRun.execution.adapter, isolation: implementationRun.execution.isolation, worker: implementationRun.execution.worker, model: implementationRun.execution.model, thinking: implementationRun.execution.thinking, startedAt: implementationRun.execution.startedAt, finishedAt: implementationRun.execution.finishedAt } });
  await recoverApplicationTicket(repository.root, goalId, queued.applicationId, identity.ticketId);
  for (const verdict of ["remediate", "reject"] as const) {
    const review = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: `Review ${verdict}.`, executionPolicy: policy });
    const reviewIdentity = { goalId, applicationId: queued.applicationId, ticketId: review.ticket.metadata.ticketId };
    const findings = verdict === "remediate" ? [{ id: "needs-remediation", severity: "high" as const, statement: "Remediate this Candidate." }] : [{ id: "rejected", severity: "high" as const, statement: "Reject this Candidate." }];
    const run = await dispatchApplicationReviewWorker({ cwd: repository.root, ...reviewIdentity, worker: "review-verdict-worker", command: reviewCompletionCommand({ reviewStatement: `${verdict} exact Candidate.`, verdict, findings, acceptanceAssessment: [{ criterion: "Recover a squash Application.", assessment: "not-met", evidence: `${verdict} exact Candidate.` }], artifacts: [] }) });
    await publishApplicationReviewReport({ cwd: repository.root, ...reviewIdentity, execution: { adapter: run.execution.adapter, isolation: run.execution.isolation, worker: run.execution.worker, model: run.execution.model, thinking: run.execution.thinking, startedAt: run.execution.startedAt, finishedAt: run.execution.finishedAt } });
    const status = await deriveApplicationReviewStatus(repository.root, goalId, queued.applicationId);
    expect(status.verdict).toBe(verdict); expect(status.approvalUsable).toBe(false); expect(status.findings).toEqual(findings);
  }
  // Worker-authored identity and artifact failures are refused before a Report
  // or any Candidate/Goal/main/worktree side effect.  These start from real
  // dispatched production completions rather than hand-staged happy paths.
  const before = { main: await repository.git("rev-parse", "main"), goal: await repository.git("rev-parse", integratedRef(goalId)), goalRefs: await repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/spike/goals"), candidate: await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId)), status: await repository.git("status", "--porcelain") };
  const mismatched = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Reject mismatched identity.", executionPolicy: policy });
  const mismatchIdentity = { goalId, applicationId: queued.applicationId, ticketId: mismatched.ticket.metadata.ticketId };
  const mismatchRun = await dispatchApplicationReviewWorker({ cwd: repository.root, ...mismatchIdentity, worker: "identity-worker", command: reviewCompletionCommand({ reviewStatement: "Exact candidate.", verdict: "approve", findings: [], acceptanceAssessment: [{ criterion: "Recover a squash Application.", assessment: "met", evidence: "Exact." }], artifacts: [] }) });
  await writeFile(join(mismatchRun.exchange.outputDirectory, "submission.md"), serializeDocument({ kind: "application-review-submission", ...mismatchIdentity, ticketId: "999", outcome: "completed", reviewedRevision: implementation.report.metadata.candidateRevision, producingImplementationTicketId: identity.ticketId, verdict: "approve", findings: [], acceptanceAssessment: [{ criterion: "Recover a squash Application.", assessment: "met", evidence: "Wrong identity." }], artifacts: [] }, "# Review evidence\n\n## Review statement\n\nWrong identity.\n"));
  await expect(publishApplicationReviewReport({ cwd: repository.root, ...mismatchIdentity, execution: { adapter: mismatchRun.execution.adapter, isolation: mismatchRun.execution.isolation, worker: mismatchRun.execution.worker, model: mismatchRun.execution.model, thinking: mismatchRun.execution.thinking, startedAt: mismatchRun.execution.startedAt, finishedAt: mismatchRun.execution.finishedAt } })).rejects.toThrow("identity");
  expect(await Bun.file(applicationReviewReportPath(repository.root, goalId, queued.applicationId, mismatchIdentity.ticketId)).exists()).toBe(false);
  expect({ main: await repository.git("rev-parse", "main"), goal: await repository.git("rev-parse", integratedRef(goalId)), goalRefs: await repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/spike/goals"), candidate: await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId)), status: await repository.git("status", "--porcelain") }).toEqual(before);
  await recoverApplicationReviewTicket(repository.root, goalId, queued.applicationId, mismatchIdentity.ticketId);

  const digest = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Reject changed artifact.", executionPolicy: policy });
  const digestIdentity = { goalId, applicationId: queued.applicationId, ticketId: digest.ticket.metadata.ticketId };
  const digestPayload = { reviewStatement: "Artifact declared.", verdict: "approve", findings: [], acceptanceAssessment: [{ criterion: "Recover a squash Application.", assessment: "met", evidence: "Exact." }], artifacts: ["artifacts/evidence.txt"] };
  const digestRun = await dispatchApplicationReviewWorker({ cwd: repository.root, ...digestIdentity, worker: "digest-worker", command: ["bun", "-e", `const { mkdir } = await import("node:fs/promises"); await mkdir(process.env.SPIKE_OUTPUT_DIR + "/artifacts", { recursive: true }); await Bun.write(process.env.SPIKE_OUTPUT_DIR + "/artifacts/evidence.txt", "before"); await (await import(${JSON.stringify(workerCompletionModule)})).completeWorker(process.cwd(), ${JSON.stringify(JSON.stringify(digestPayload))});`] });
  await writeFile(join(digestRun.exchange.outputDirectory, "artifacts", "evidence.txt"), "after");
  await expect(publishApplicationReviewReport({ cwd: repository.root, ...digestIdentity, execution: { adapter: digestRun.execution.adapter, isolation: digestRun.execution.isolation, worker: digestRun.execution.worker, model: digestRun.execution.model, thinking: digestRun.execution.thinking, startedAt: digestRun.execution.startedAt, finishedAt: digestRun.execution.finishedAt } })).rejects.toThrow("digest");
  expect(await Bun.file(applicationReviewReportPath(repository.root, goalId, queued.applicationId, digestIdentity.ticketId)).exists()).toBe(false);
  expect({ main: await repository.git("rev-parse", "main"), goal: await repository.git("rev-parse", integratedRef(goalId)), goalRefs: await repository.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/spike/goals"), candidate: await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId)), status: await repository.git("status", "--porcelain") }).toEqual(before);
  await recoverApplicationReviewTicket(repository.root, goalId, queued.applicationId, digestIdentity.ticketId);

  const escaped = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Reject escaped artifact.", executionPolicy: policy });
  const escapedIdentity = { goalId, applicationId: queued.applicationId, ticketId: escaped.ticket.metadata.ticketId };
  const escapedRun = await dispatchApplicationReviewWorker({ cwd: repository.root, ...escapedIdentity, worker: "escape-worker", command: reviewCompletionCommand({ reviewStatement: "This must not stage.", verdict: "approve", findings: [], acceptanceAssessment: [{ criterion: "Recover a squash Application.", assessment: "met", evidence: "Exact." }], artifacts: ["artifacts/../escape.txt"] }) });
  expect(escapedRun.execution.exitCode).not.toBe(0);
  await expect(publishApplicationReviewReport({ cwd: repository.root, ...escapedIdentity, execution: { adapter: escapedRun.execution.adapter, isolation: escapedRun.execution.isolation, worker: escapedRun.execution.worker, model: escapedRun.execution.model, thinking: escapedRun.execution.thinking, startedAt: escapedRun.execution.startedAt, finishedAt: escapedRun.execution.finishedAt } })).rejects.toThrow("did not complete successfully");
  expect(await Bun.file(applicationReviewReportPath(repository.root, goalId, queued.applicationId, escapedIdentity.ticketId)).exists()).toBe(false);
  await recoverApplicationReviewTicket(repository.root, goalId, queued.applicationId, escapedIdentity.ticketId);

  // Blocking uses the same production worker boundary, but cannot publish a
  // completed review Report; recovery records the identity-preserving result.
  const blocked = await issueApplicationReviewTicket({ cwd: repository.root, goalId, applicationId: queued.applicationId, instruction: "Block exact review.", executionPolicy: policy });
  const blockedIdentity = { goalId, applicationId: queued.applicationId, ticketId: blocked.ticket.metadata.ticketId };
  const blockedRun = await dispatchApplicationReviewWorker({ cwd: repository.root, ...blockedIdentity, worker: "blocked-worker", command: ["bun", "-e", `await (await import(${JSON.stringify(workerCompletionModule)})).blockWorker(process.cwd(), ${JSON.stringify(JSON.stringify({ reason: "External review service unavailable.", evidence: "Scenario block.", artifacts: [] }))});`] });
  expect(blockedRun.execution.exitCode).toBe(0);
  await expect(publishApplicationReviewReport({ cwd: repository.root, ...blockedIdentity, execution: { adapter: blockedRun.execution.adapter, isolation: blockedRun.execution.isolation, worker: blockedRun.execution.worker, model: blockedRun.execution.model, thinking: blockedRun.execution.thinking, startedAt: blockedRun.execution.startedAt, finishedAt: blockedRun.execution.finishedAt } })).rejects.toThrow();
  expect(await Bun.file(applicationReviewReportPath(repository.root, goalId, queued.applicationId, blockedIdentity.ticketId)).exists()).toBe(false);
  await recoverApplicationReviewTicket(repository.root, goalId, queued.applicationId, blockedIdentity.ticketId);

  expect(await repository.git("rev-parse", "main")).toBe(issued.ticket.metadata.targetRevision);
  expect(await repository.git("rev-parse", applicationCandidateRef(goalId, queued.applicationId, identity.ticketId))).toBe(implementation.report.metadata.candidateRevision!);
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
