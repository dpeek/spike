import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  abandonChange,
  changeStatus,
  createChange,
  loadChangeDecision,
  rejectChange,
} from "../../src/change.ts";
import { candidateRef } from "../../src/git-change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import {
  deriveCurrentRejection,
  publishImplementationReport,
  publishReviewReport,
} from "../../src/report.ts";
import { issueTicket, reportPath, ticketPath } from "../../src/ticket.ts";
import { dispatchLocalImplementation, dispatchLocalReview } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const worker = String.raw`
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
const output = process.env.SPIKE_OUTPUT_DIR;
const ticketId = process.env.SPIKE_TICKET_ID;
const head = await git("rev-parse", "HEAD");
if (head !== process.env.SPIKE_INPUT_REVISION) throw new Error("worker checkout does not match Ticket input");

if (ticketId === "002") {
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId, outcome: "completed", reviewedRevision: head, producingImplementationTicketId: "001",
    findings: [{ id: "design-001", severity: "high", statement: "The proposed direction should not become Goal history." }],
    acceptanceAssessment: [{
      criterion: "The proposal is suitable for integration.", assessment: "not-met",
      evidence: "design-001 makes remediation inappropriate.",
    }],
    verdict: "reject", artifacts: [],
  };
  const body = "# Review evidence\n\n## Review statement\n\nReject this Change rather than remediate the Candidate.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
} else if (ticketId === "001") {
  await git("config", "user.name", "Controlled Implementer");
  await git("config", "user.email", "implementer@example.test");
  await writeFile("candidate.txt", "candidate proposal\n");
  await git("add", "candidate.txt");
  await git("commit", "--quiet", "-m", "candidate checkpoint");
  const workerRevision = await git("rev-parse", "HEAD");
  await mkdir(join(output, "artifacts"), { recursive: true });
  const artifact = "candidate verification evidence\n";
  await writeFile(join(output, "artifacts", "verification.txt"), artifact);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const metadata = {
    kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
    ticketId, outcome: "completed", workerRevision,
    artifacts: [{ path: "artifacts/verification.txt", sha256 }],
  };
  const body = "# Implementation evidence\n\n## Summary\n\nProduced a candidate.\n\n## Verification\n\nRecorded evidence.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nDirection may be rejected.\n\n## Follow-up\n\nIndependent review.\n";
  await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
  const bundle = Bun.spawn(["git", "bundle", "create", join(output, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
} else {
  throw new Error("unexpected Ticket " + ticketId);
}
`;

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

async function implementedChange() {
  const repository = await temporaryRepository();
  repositories.push(repository);
  const goal = await createGoal({
    cwd: repository.root,
    title: "Resolve a Change",
    outcome: "Resolve work without advancing integrated history.",
    approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  const change = await createChange({
    cwd: repository.root,
    goalId,
    title: "Evaluate a proposal",
    intent: "Produce durable evidence before resolving the Change.",
    rationale: "Terminal decisions must preserve attempted work.",
    acceptanceCriteria: ["The proposal is suitable for integration."],
  });
  await issueTicket({
    cwd: repository.root,
    goalId,
    changeId: "001",
    instruction: "Produce the proposal Candidate.",
    executionPolicy: policy,
  });
  const execution = await dispatchLocalImplementation({
    cwd: repository.root,
    goalId,
    changeId: "001",
    ticketId: "001",
    command: ["bun", "-e", worker],
    worker: "controlled-implementer",
  });
  const publication = await publishImplementationReport({
    cwd: repository.root,
    goalId,
    changeId: "001",
    ticketId: "001",
    execution: execution.execution,
    commitMessage: { summary: "Evaluate a proposal" },
  });
  return {
    repository,
    goalId,
    baseRevision: change.change.metadata.baseRevision,
    candidateRevision: publication.report.metadata.candidateRevision,
    artifactPath: join(execution.exchange.outputDirectory, "artifacts", "verification.txt"),
  };
}

async function dirtyHost(repository: Awaited<ReturnType<typeof temporaryRepository>>) {
  await writeFile(join(repository.root, "host-only.txt"), "host branch revision\n");
  await repository.git("add", "host-only.txt");
  await repository.git("commit", "--quiet", "-m", "Move host independently");
  await writeFile(join(repository.root, "staged-host.txt"), "staged host state\n");
  await repository.git("add", "staged-host.txt");
  await writeFile(join(repository.root, "README.md"), "dirty host state\n");
  return {
    branch: await repository.git("symbolic-ref", "--short", "HEAD"),
    head: await repository.git("rev-parse", "HEAD"),
    index: await repository.git("write-tree"),
    diff: await repository.git("diff", "--", "README.md"),
    readme: await readFile(join(repository.root, "README.md"), "utf8"),
  };
}

async function expectHostUnchanged(
  repository: Awaited<ReturnType<typeof temporaryRepository>>,
  host: Awaited<ReturnType<typeof dirtyHost>>,
) {
  expect(await repository.git("symbolic-ref", "--short", "HEAD")).toBe(host.branch);
  expect(await repository.git("rev-parse", "HEAD")).toBe(host.head);
  expect(await repository.git("write-tree")).toBe(host.index);
  expect(await repository.git("diff", "--", "README.md")).toBe(host.diff);
  expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe(host.readme);
}

async function nextChange(repository: Awaited<ReturnType<typeof temporaryRepository>>, goalId: string) {
  return createChange({
    cwd: repository.root,
    goalId,
    title: "Try a different direction",
    intent: "Continue under the next monotonic Change identity.",
    rationale: "Resolved Changes are never reopened.",
    acceptanceCriteria: ["Allocate Change 002 from unchanged integrated history."],
  });
}

describe("Change rejection and abandonment", () => {
  test("publishes a reject decision only after an exact reject review recommendation", async () => {
    const { repository, goalId, baseRevision, candidateRevision, artifactPath } = await implementedChange();

    await expect(
      rejectChange({ cwd: repository.root, goalId, changeId: "001", statement: "Reject the direction." }),
    ).rejects.toThrow(`current Candidate ${candidateRevision} has no exact reject review Report`);

    await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      role: "review",
      instruction: "Decide whether this Candidate should be integrated or rejected.",
      executionPolicy: policy,
    });
    const reviewExecution = await dispatchLocalReview({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", worker],
      worker: "independent-rejector",
    });
    const review = await publishReviewReport({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      execution: reviewExecution.execution,
    });
    expect(review.report.metadata.verdict).toBe("reject");
    expect(await deriveCurrentRejection(repository.root, goalId, "001")).toMatchObject({
      candidateRevision,
      producingImplementationTicketId: "001",
      reviewTicketId: "002",
      reviewReport: { metadata: { verdict: "reject" } },
    });

    await expect(
      rejectChange({
        cwd: repository.root,
        goalId: "goal-ffffffffffffffffffffffffffffffff",
        changeId: "001",
        statement: "Wrong Goal identity.",
      }),
    ).rejects.toThrow();
    await expect(
      rejectChange({ cwd: repository.root, goalId, changeId: "002", statement: "Wrong Change identity." }),
    ).rejects.toThrow();
    await expect(
      rejectChange({ cwd: repository.root, goalId, changeId: "001", statement: "   " }),
    ).rejects.toThrow("Change decision statement must not be blank");

    const ticketSources = await Promise.all(["001", "002"].map((ticketId) =>
      readFile(ticketPath(repository.root, goalId, "001", ticketId), "utf8")
    ));
    const reportSources = await Promise.all(["001", "002"].map((ticketId) =>
      readFile(reportPath(repository.root, goalId, "001", ticketId), "utf8")
    ));
    const artifact = await readFile(artifactPath, "utf8");
    const host = await dirtyHost(repository);
    const integratedBefore = await repository.git("rev-parse", integratedRef(goalId));

    const rejected = await rejectChange({
      cwd: repository.root,
      goalId,
      changeId: "001",
      statement: "The review shows this direction should not enter integrated history.",
      now: new Date("2026-03-23T10:00:00.000Z"),
    });
    expect(rejected.decision.metadata).toEqual({
      kind: "change-decision",
      goalId,
      changeId: "001",
      decidedAt: "2026-03-23T10:00:00.000Z",
      disposition: "reject",
    });
    expect((await loadChangeDecision(repository.root, goalId, "001")).body).toBe(
      "The review shows this direction should not enter integrated history.\n",
    );
    expect(await changeStatus(repository.root, goalId, "001")).toBe("resolved");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(integratedBefore);
    expect(integratedBefore).toBe(baseRevision);

    await expect(
      issueTicket({
        cwd: repository.root,
        goalId,
        changeId: "001",
        instruction: "Attempt to reopen rejected work.",
        executionPolicy: policy,
      }),
    ).rejects.toThrow("is resolved");
    await expect(
      abandonChange({ cwd: repository.root, goalId, changeId: "001", statement: "Duplicate terminal decision." }),
    ).rejects.toThrow("already has a terminal decision");

    expect(await Promise.all(["001", "002"].map((ticketId) =>
      readFile(ticketPath(repository.root, goalId, "001", ticketId), "utf8")
    ))).toEqual(ticketSources);
    expect(await Promise.all(["001", "002"].map((ticketId) =>
      readFile(reportPath(repository.root, goalId, "001", ticketId), "utf8")
    ))).toEqual(reportSources);
    expect(await readFile(artifactPath, "utf8")).toBe(artifact);
    expect(await repository.git("rev-parse", candidateRef(goalId, "001", "001"))).toBe(candidateRevision);
    await expectHostUnchanged(repository, host);

    const second = await nextChange(repository, goalId);
    expect(second.change.metadata.changeId).toBe("002");
    expect(second.change.metadata.baseRevision).toBe(baseRevision);
  });
});
