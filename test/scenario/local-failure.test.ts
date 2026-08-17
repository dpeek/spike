import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { candidateRef } from "../../src/git-change.ts";
import { createGoal } from "../../src/goal.ts";
import {
  deriveCurrentApproval,
  deriveCurrentCandidate,
  deriveCurrentRemediation,
  loadReport,
  publishFailedReport,
  publishImplementationReport,
} from "../../src/report.ts";
import { issueTicket, reportPath, ticketStatus } from "../../src/ticket.ts";
import { dispatchLocalImplementation } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const failedWorker = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const output = process.env.SPIKE_OUTPUT_DIR;
await writeFile("abandoned-worker-edit.txt", "never submitted\n");
await writeFile(join(output, "partial-output.tmp"), "incomplete worker output\n");
await writeFile(join(output, "diagnostic.log"), "worker failed after staging output\n");
process.exit(23);
`;

const successfulWorker = String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
await git("config", "user.name", "Replacement Worker");
await git("config", "user.email", "replacement@example.test");
await writeFile("candidate.txt", "candidate A\n");
await git("add", "candidate.txt");
await git("commit", "--quiet", "-m", "replacement checkpoint");
const workerRevision = await git("rev-parse", "HEAD");
const metadata = {
  kind: "submission", goalId: process.env.SPIKE_GOAL_ID, changeId: process.env.SPIKE_CHANGE_ID,
  ticketId: process.env.SPIKE_TICKET_ID, outcome: "completed", workerRevision, artifacts: [],
};
const body = "# Implementation evidence\n\n## Summary\n\nProduced Candidate A.\n\n## Verification\n\nControlled check passed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nIndependent review.\n";
await writeFile(join(process.env.SPIKE_OUTPUT_DIR, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
const bundle = Bun.spawn(["git", "bundle", "create", join(process.env.SPIKE_OUTPUT_DIR, "repository.bundle"), "HEAD"], { cwd: process.cwd(), stdout: "ignore", stderr: "pipe" });
const [code, stderr] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
if (code !== 0) throw new Error(stderr);
`;

const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

function clock(...timestamps: string[]): () => Date {
  const values = timestamps.map((value) => new Date(value));
  return () => values.shift()!;
}

describe("failed Ticket replacement", () => {
  test("publishes a host-generated failed Report and replaces it from the latest committed revision", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Recover from failed implementation",
      outcome: "Preserve failure evidence and produce Candidate A from a replacement Ticket.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root,
      goalId,
      title: "Publish Candidate A",
      intent: "Replace a failed implementation Ticket without accepting its staging output.",
      rationale: "Terminal failure evidence must not become a Candidate.",
      acceptanceCriteria: ["Candidate A is produced only by the replacement Ticket."],
    });
    const baseRevision = change.change.metadata.baseRevision;

    const first = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Attempt Candidate A.",
      executionPolicy: policy,
    });
    expect(first.ticket.metadata).toMatchObject({ ticketId: "001", role: "implement", inputRevision: baseRevision });

    await writeFile(join(repository.root, "host-commit.txt"), "host advanced\n");
    await repository.git("add", "host-commit.txt");
    await repository.git("commit", "--quiet", "-m", "Advance host independently");
    await writeFile(join(repository.root, "host-staged.txt"), "staged host state\n");
    await repository.git("add", "host-staged.txt");
    await writeFile(join(repository.root, "README.md"), "dirty host state\n");
    const hostBranch = await repository.git("symbolic-ref", "HEAD");
    const hostHead = await repository.git("rev-parse", "HEAD");
    const hostIndex = await repository.git("write-tree");
    const hostDiff = await repository.git("diff", "HEAD");

    const failed = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      command: ["bun", "-e", failedWorker],
      worker: "controlled-failing-worker",
      model: "none",
      clock: clock("2026-03-23T10:00:00.000Z", "2026-03-23T10:01:00.000Z"),
    });
    expect(failed.execution.exitCode).toBe(23);
    const stagedPartialOutput = await readFile(join(failed.exchange.outputDirectory, "partial-output.tmp"), "utf8");
    const stagedDiagnostic = await readFile(join(failed.exchange.outputDirectory, "diagnostic.log"), "utf8");
    expect(await Bun.file(join(failed.exchange.outputDirectory, "submission.md")).exists()).toBe(false);

    const publishFailure = (overrides: Partial<Parameters<typeof publishFailedReport>[0]> = {}) =>
      publishFailedReport({
        cwd: repository.root,
        goalId,
        changeId: "001",
        ticketId: "001",
        role: "implement",
        reason: "Worker exited with code 23 before producing a valid Submission.",
        execution: failed.execution,
        now: new Date("2026-03-23T10:02:00.000Z"),
        ...overrides,
      });

    await expect(publishFailure({ reason: "  " })).rejects.toThrow("Failure reason must not be blank");
    await expect(publishFailure({ role: "review" })).rejects.toThrow("does not match its Ticket role");
    await expect(
      publishFailure({ execution: { ...failed.execution, ticketId: "999" } }),
    ).rejects.toThrow("execution belongs to a different Ticket");
    await expect(
      publishFailure({ execution: { ...failed.execution, worker: " " } }),
    ).rejects.toThrow();
    expect(await Bun.file(reportPath(repository.root, goalId, "001", "001")).exists()).toBe(false);

    const publication = await publishFailure();
    expect(publication.report.metadata).toEqual({
      kind: "report",
      goalId,
      changeId: "001",
      ticketId: "001",
      role: "implement",
      outcome: "failed",
      publishedAt: "2026-03-23T10:02:00.000Z",
      artifacts: [],
      execution: {
        adapter: "local-clone",
        isolation: "workspace",
        worker: "controlled-failing-worker",
        model: "none",
        startedAt: "2026-03-23T10:00:00.000Z",
        finishedAt: "2026-03-23T10:01:00.000Z",
      },
    });
    expect(publication.report.metadata).not.toHaveProperty("candidateRevision");
    expect(publication.report.metadata).not.toHaveProperty("workerRevision");
    expect(publication.report.metadata).not.toHaveProperty("verdict");
    expect(publication.report.body).toContain("Worker exited with code 23 before producing a valid Submission.");
    expect((await loadReport(repository.root, goalId, "001", "001")).metadata.outcome).toBe("failed");
    expect(await ticketStatus(repository.root, goalId, "001", "001")).toBe("reported");
    expect(await deriveCurrentCandidate(repository.root, goalId, "001")).toBeUndefined();
    expect(await deriveCurrentRemediation(repository.root, goalId, "001")).toBeUndefined();
    expect(await deriveCurrentApproval(repository.root, goalId, "001")).toBeUndefined();
    await expect(repository.git("rev-parse", "--verify", candidateRef(goalId, "001", "001"))).rejects.toThrow();

    const failedReportSource = await readFile(reportPath(repository.root, goalId, "001", "001"), "utf8");
    await expect(publishFailure()).rejects.toThrow("immutable Report already exists");
    expect(await readFile(reportPath(repository.root, goalId, "001", "001"), "utf8")).toBe(failedReportSource);
    expect(await readFile(join(failed.exchange.outputDirectory, "partial-output.tmp"), "utf8")).toBe(stagedPartialOutput);
    expect(await readFile(join(failed.exchange.outputDirectory, "diagnostic.log"), "utf8")).toBe(stagedDiagnostic);

    const replacement = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Produce Candidate A in a fresh worker.",
      executionPolicy: policy,
    });
    expect(replacement.ticket.metadata).toMatchObject({
      ticketId: "002",
      role: "implement",
      inputRevision: baseRevision,
    });

    const replacementExecution = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", successfulWorker],
      worker: "controlled-replacement-worker",
      model: "none",
      clock: clock("2026-03-23T10:03:00.000Z", "2026-03-23T10:04:00.000Z"),
    });
    const completed = await publishImplementationReport({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      execution: replacementExecution.execution,
      commitMessage: { summary: "Publish Candidate A" },
      now: new Date("2026-03-23T10:05:00.000Z"),
    });
    const candidateA = completed.report.metadata.candidateRevision;
    expect(await deriveCurrentCandidate(repository.root, goalId, "001")).toMatchObject({
      candidateRevision: candidateA,
      producingImplementationTicketId: "002",
    });
    expect(await repository.git("show", `${candidateA}:candidate.txt`)).toBe("candidate A");
    expect(await readFile(reportPath(repository.root, goalId, "001", "001"), "utf8")).toBe(failedReportSource);
    expect(await readFile(join(failed.exchange.outputDirectory, "partial-output.tmp"), "utf8")).toBe(stagedPartialOutput);
    expect(await readFile(join(failed.exchange.outputDirectory, "diagnostic.log"), "utf8")).toBe(stagedDiagnostic);

    expect(await repository.git("symbolic-ref", "HEAD")).toBe(hostBranch);
    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(hostIndex);
    expect(await repository.git("diff", "HEAD")).toBe(hostDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host state\n");
  });
});
