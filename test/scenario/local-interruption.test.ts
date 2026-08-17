import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { recoverInterruptedTicket } from "../../src/recovery.ts";
import { deriveCurrentCandidate, publishImplementationReport } from "../../src/report.ts";
import { issueTicket, reportPath, ticketStatus } from "../../src/ticket.ts";
import {
  prepareTicketExchange,
  recordLocalWorker,
  workerRecordPath,
  dispatchLocalImplementation,
} from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const replacementWorker = String.raw`
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
await git("commit", "--quiet", "-m", "candidate A checkpoint");
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

describe("interrupted Ticket recovery", () => {
  test("finalizes recorded resources, publishes interruption evidence, and issues 002 from the Change base", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Recover interrupted implementation",
      outcome: "Interrupt Ticket 001 and produce Candidate A from replacement Ticket 002.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root,
      goalId,
      title: "Produce Candidate A",
      intent: "Replace uncertain worker progress with a fresh implementation.",
      rationale: "Only committed Reports may advance Candidate history.",
      acceptanceCriteria: ["Candidate A is produced by replacement Ticket 002."],
    });
    const baseRevision = change.change.metadata.baseRevision;
    const first = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Produce Candidate A.",
      curatedContext: "Discard uncertain progress after interruption.",
      executionPolicy: policy,
    });
    expect(first.ticket.metadata.ticketId).toBe("001");

    const identity = { goalId, changeId: "001", ticketId: "001" };
    const exchange = await prepareTicketExchange(repository.root, identity);
    await writeFile(join(exchange.outputDirectory, "submission.md"), "incomplete, untrusted output\n");
    await writeFile(join(exchange.outputDirectory, "worker.tmp"), "preserve for diagnosis\n");
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    await writeFile(join(workspace, "uncertain.txt"), "uncertain worker state\n");
    await recordLocalWorker(repository.root, {
      ...identity,
      role: "implement",
      worker: "interrupted-worker",
      model: "controlled-model",
      startedAt: "2026-03-24T10:00:00.000Z",
      workspace,
      pid: 424242,
    });

    await writeFile(join(repository.root, "host-staged.txt"), "staged host state\n");
    await repository.git("add", "host-staged.txt");
    await writeFile(join(repository.root, "README.md"), "dirty host state\n");
    const hostBranch = await repository.git("symbolic-ref", "HEAD");
    const hostHead = await repository.git("rev-parse", "HEAD");
    const hostIndex = await repository.git("write-tree");
    const hostDiff = await repository.git("diff", "HEAD");

    const recover = (reason = "Supervisor restarted while Ticket 001 was running.", operations?: Parameters<typeof recoverInterruptedTicket>[1]) =>
      recoverInterruptedTicket(
        {
          cwd: repository.root,
          ...identity,
          role: "implement",
          reason,
          now: new Date("2026-03-24T10:05:00.000Z"),
        },
        operations,
      );

    await expect(recover("  ")).rejects.toThrow("Interruption reason must not be blank");
    await expect(
      recoverInterruptedTicket({
        cwd: repository.root,
        ...identity,
        role: "review",
        reason: "Wrong role.",
      }),
    ).rejects.toThrow("does not match Ticket role");

    const runtimePath = workerRecordPath(repository.root, identity);
    const validRuntimeRecord = await readFile(runtimePath, "utf8");
    await writeFile(runtimePath, validRuntimeRecord.replace('"ticketId": "001"', '"ticketId": "999"'));
    await expect(recover()).rejects.toThrow("Worker record belongs to a different Ticket");
    await writeFile(runtimePath, validRuntimeRecord.replace('"role": "implement"', '"role": "review"'));
    await expect(recover()).rejects.toThrow("Worker record role does not match its Ticket");
    await writeFile(runtimePath, validRuntimeRecord.replace('"worker": "interrupted-worker"', '"worker": "   "'));
    await expect(recover()).rejects.toThrow();
    await writeFile(runtimePath, validRuntimeRecord);

    let stopAttempts = 0;
    let removeAttempts = 0;
    const cleanupFailed = await recover(undefined, {
      async stop(pid) {
        expect(pid).toBe(424242);
        stopAttempts++;
      },
      async removeWorkspace(path) {
        expect(path).toBe(workspace);
        removeAttempts++;
        throw new Error("simulated adapter cleanup failure");
      },
    });

    expect(cleanupFailed.cleanup).toEqual({ status: "failed", message: "simulated adapter cleanup failure" });
    expect(stopAttempts).toBe(1);
    expect(removeAttempts).toBe(1);
    expect(cleanupFailed.report.metadata).toEqual({
      kind: "report",
      goalId,
      changeId: "001",
      ticketId: "001",
      role: "implement",
      outcome: "interrupted",
      publishedAt: "2026-03-24T10:05:00.000Z",
      artifacts: [],
      execution: {
        adapter: "local-clone",
        isolation: "workspace",
        worker: "interrupted-worker",
        model: "controlled-model",
        startedAt: "2026-03-24T10:00:00.000Z",
        finishedAt: "2026-03-24T10:05:00.000Z",
      },
    });
    expect(cleanupFailed.report.body).toContain("Supervisor restarted while Ticket 001 was running.");
    expect(cleanupFailed.replacement.metadata).toMatchObject({
      ticketId: "002",
      role: "implement",
      inputRevision: baseRevision,
      replacesTicketId: "001",
      executionPolicy: policy,
    });
    expect(cleanupFailed.replacement.body).toContain("## Instruction\n\nProduce Candidate A.");
    expect(cleanupFailed.replacement.body).toContain("Discard uncertain progress after interruption.");
    expect(await ticketStatus(repository.root, goalId, "001", "001")).toBe("reported");
    expect(await deriveCurrentCandidate(repository.root, goalId, "001")).toBeUndefined();
    expect(await Bun.file(workerRecordPath(repository.root, identity)).exists()).toBe(true);
    expect(await Bun.file(join(workspace, "uncertain.txt")).exists()).toBe(true);

    const reportSource = await readFile(reportPath(repository.root, goalId, "001", "001"), "utf8");
    const cleanupRetried = await recover(undefined, {
      async stop() {
        stopAttempts++;
      },
      async removeWorkspace(path) {
        removeAttempts++;
        await rm(path, { recursive: true, force: true });
      },
    });
    expect(cleanupRetried.cleanup).toEqual({ status: "finalized" });
    expect(cleanupRetried.replacement.metadata.ticketId).toBe("002");
    expect(stopAttempts).toBe(2);
    expect(removeAttempts).toBe(2);
    expect(await Bun.file(workerRecordPath(repository.root, identity)).exists()).toBe(false);
    expect(await Bun.file(join(workspace, "uncertain.txt")).exists()).toBe(false);
    expect(await readFile(reportPath(repository.root, goalId, "001", "001"), "utf8")).toBe(reportSource);
    expect(await readFile(join(exchange.outputDirectory, "submission.md"), "utf8")).toBe("incomplete, untrusted output\n");
    expect(await readFile(join(exchange.outputDirectory, "worker.tmp"), "utf8")).toBe("preserve for diagnosis\n");

    const replacementExecution = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      command: ["bun", "-e", replacementWorker],
      worker: "replacement-worker",
      model: "controlled-model",
    });
    const completed = await publishImplementationReport({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "002",
      execution: replacementExecution.execution,
      commitMessage: { summary: "Produce Candidate A" },
    });
    expect(await deriveCurrentCandidate(repository.root, goalId, "001")).toMatchObject({
      candidateRevision: completed.report.metadata.candidateRevision,
      producingImplementationTicketId: "002",
    });
    expect(await repository.git("show", `${completed.report.metadata.candidateRevision}:candidate.txt`)).toBe("candidate A");

    expect(await repository.git("symbolic-ref", "HEAD")).toBe(hostBranch);
    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(hostIndex);
    expect(await repository.git("diff", "HEAD")).toBe(hostDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host state\n");
  });
});
