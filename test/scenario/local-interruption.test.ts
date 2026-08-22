import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { recoverInterruptedTicket } from "../../src/recovery.ts";
import { deriveCurrentCandidate, publishInterruptedReport } from "../../src/report.ts";
import { issueReplacementTicket, issueTicket, reportPath, ticketPath, ticketStatus } from "../../src/ticket.ts";
import { prepareTicketExchange, recordLocalCloneWorker, workerRecordPath } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";


const policy = { isolation: "workspace" as const, credentialGrants: [] };

describe("interrupted Ticket recovery", () => {
  test("finalizes recorded resources, publishes interruption evidence, and lets the planner issue 002", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Recover interrupted implementation",
      outcome: "Interrupt Ticket 001 and produce Candidate A from replacement Ticket 002.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Produce Candidate A",
      intent: "Replace uncertain worker progress with a fresh implementation.",
      rationale: "Only committed Reports may advance Candidate history.",
      acceptanceCriteria: ["Candidate A is produced by replacement Ticket 002."],
    });
    const baseRevision = change.change.metadata.baseRevision;
    const configPath = join(repository.root, "spike.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.worker = { setup: ["bun", "install", "--frozen-lockfile"] };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const first = await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Produce Candidate A.",
      curatedContext: "Discard uncertain progress after interruption.",
      executionPolicy: policy,
      model: "controlled-model",
      thinking: "low",
    });
    expect(first.ticket.metadata).toMatchObject({
      ticketId: "001",
      model: "controlled-model",
      thinking: "low",
      setupCommand: ["bun", "install", "--frozen-lockfile"],
    });
    await writeFile(
      join(repository.root, "spike.json"),
      // Replacement reproduces the interrupted Ticket; it must not resolve
      // this malformed post-issuance agent configuration.
      '{"project":{"slug":"spike"},"agents":{"planner":{"model":"changed","thinking":"minimal"}}}\n',
    );

    const identity = { goalId, changeId: "001", ticketId: "001" };
    const exchange = await prepareTicketExchange(repository.project, identity);
    await writeFile(join(exchange.outputDirectory, "submission.md"), "incomplete, untrusted output\n");
    await writeFile(join(exchange.outputDirectory, "worker.tmp"), "preserve for diagnosis\n");
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    await writeFile(join(workspace, "uncertain.txt"), "uncertain worker state\n");
    await recordLocalCloneWorker(repository.project, {
      ...identity,
      role: "implement",
      worker: "interrupted-worker",
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
          hostPaths: repository.hostPaths,
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
        cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
        role: "review",
        reason: "Wrong role.",
      }),
    ).rejects.toThrow("does not match Ticket role");

    const runtimePath = workerRecordPath(repository.project, identity);
    const validRuntimeRecord = await readFile(runtimePath, "utf8");
    await writeFile(runtimePath, validRuntimeRecord.replace('"ticketId": "001"', '"ticketId": "999"'));
    await expect(recover()).rejects.toThrow("Worker record belongs to a different Ticket");
    await writeFile(runtimePath, validRuntimeRecord.replace('"role": "implement"', '"role": "review"'));
    await expect(recover()).rejects.toThrow("Worker record role does not match its Ticket");
    await writeFile(runtimePath, validRuntimeRecord.replace('"worker": "interrupted-worker"', '"worker": "   "'));
    await expect(recover()).rejects.toThrow();
    await writeFile(runtimePath, validRuntimeRecord);

    await expect(publishInterruptedReport({
      cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
      role: "implement",
      reason: "False host provenance.",
      execution: {
        ...identity, adapter: "host", isolation: "workspace", worker: "not-launched",
        model: "controlled-model", thinking: "low", startedAt: first.ticket.metadata.issuedAt,
        finishedAt: new Date("2026-03-24T10:05:00.000Z").toISOString(), exitCode: -1,
      },
    })).rejects.toThrow("contradicts a recorded Worker launch");

    let stopAttempts = 0;
    let removeAttempts = 0;
    const cleanupFailed = await recover(undefined, {
      async stop(runtime) {
        expect(runtime).toMatchObject({ pid: 424242 });
        stopAttempts++;
      },
      async cleanup(runtime) {
        expect((runtime as { workspace: string }).workspace).toBe(workspace);
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
        thinking: "low",
        startedAt: "2026-03-24T10:00:00.000Z",
        finishedAt: "2026-03-24T10:05:00.000Z",
      },
    });
    expect(cleanupFailed.report.body).toContain("Supervisor restarted while Ticket 001 was running.");
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "002")).exists()).toBe(false);
    const replacement = (
      await issueReplacementTicket({
        cwd: repository.root, hostPaths: repository.hostPaths, goalId,
        changeId: "001",
        interruptedTicketId: "001",
        now: new Date("2026-03-24T10:05:00.000Z"),
      })
    ).ticket;
    expect(replacement.metadata).toMatchObject({
      ticketId: "002",
      role: "implement",
      inputRevision: baseRevision,
      replacesTicketId: "001",
      model: "controlled-model",
      thinking: "low",
      setupCommand: ["bun", "install", "--frozen-lockfile"],
      executionPolicy: policy,
    });
    expect(replacement.body).toContain("## Instruction\n\nProduce Candidate A.");
    expect(replacement.body).toContain("Discard uncertain progress after interruption.");
    expect(await ticketStatus(repository.project, goalId, "001", "001")).toBe("reported");
    expect(await deriveCurrentCandidate(repository.project, goalId, "001")).toBeUndefined();
    expect(await Bun.file(workerRecordPath(repository.project, identity)).exists()).toBe(true);
    expect(await Bun.file(join(workspace, "uncertain.txt")).exists()).toBe(true);

    const reportSource = await readFile(reportPath(repository.project, goalId, "001", "001"), "utf8");
    const cleanupRetried = await recover(undefined, {
      async stop() {
        stopAttempts++;
      },
      async cleanup(runtime) {
        removeAttempts++;
        await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true });
      },
    });
    expect(cleanupRetried.cleanup).toEqual({ status: "finalized" });
    expect(stopAttempts).toBe(2);
    expect(removeAttempts).toBe(2);
    expect(await Bun.file(workerRecordPath(repository.project, identity)).exists()).toBe(false);
    expect(await Bun.file(join(workspace, "uncertain.txt")).exists()).toBe(false);
    expect(await readFile(reportPath(repository.project, goalId, "001", "001"), "utf8")).toBe(reportSource);
    expect(await readFile(join(exchange.outputDirectory, "submission.md"), "utf8")).toBe("incomplete, untrusted output\n");
    expect(await readFile(join(exchange.outputDirectory, "worker.tmp"), "utf8")).toBe("preserve for diagnosis\n");

    expect(await repository.git("symbolic-ref", "HEAD")).toBe(hostBranch);
    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(hostIndex);
    expect(await repository.git("diff", "HEAD")).toBe(hostDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host state\n");
  });

  test("refuses to signal a persisted direct-worker PID after restart", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Recover a stale direct worker",
      outcome: "Publish interruption evidence without signalling an unowned PID.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Interrupt stale direct work",
      intent: "Treat persisted direct runtime state as unsafe to signal.",
      rationale: "A PID does not prove process identity after restart.",
      acceptanceCriteria: ["Recovery surfaces a cleanup warning without signalling the persisted PID."],
    });
    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Remain interrupted across supervisor restart.",
      executionPolicy: policy,
    });

    const identity = { goalId, changeId: "001", ticketId: "001" };
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    const workspaceMarker = join(workspace, "stale-worker.txt");
    await writeFile(workspaceMarker, "stale direct worker state\n");
    await recordLocalCloneWorker(repository.project, {
      ...identity,
      role: "implement",
      worker: "stale-direct-worker",
      startedAt: "2026-03-24T12:00:00.000Z",
      workspace,
      pid: 2_147_483_647,
    });

    const recovered = await recoverInterruptedTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
      role: "implement",
      reason: "Supervisor restarted and no longer owns the direct process handle.",
      now: new Date("2026-03-24T12:05:00.000Z"),
    });
    expect(recovered.cleanup).toEqual({
      status: "failed",
      message: "direct worker session is unavailable after restart; refusing to signal a persisted PID",
    });
    expect(recovered.report.metadata.outcome).toBe("interrupted");
    expect(await Bun.file(ticketPath(repository.project, goalId, "001", "002")).exists()).toBe(false);
    const replacement = await issueReplacementTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      interruptedTicketId: "001",
      now: new Date("2026-03-24T12:05:00.000Z"),
    });
    expect(replacement.ticket.metadata.ticketId).toBe("002");
    expect(await Bun.file(workspaceMarker).exists()).toBe(true);

    const cleanupRetried = await recoverInterruptedTicket(
      {
        cwd: repository.root,
        hostPaths: repository.hostPaths,
        ...identity,
        role: "implement",
        reason: "Supervisor restarted and no longer owns the direct process handle.",
        now: new Date("2026-03-24T12:05:00.000Z"),
      },
      {
        async stop(runtime) {
          expect(runtime).toMatchObject({ pid: 2_147_483_647 });
        },
        async cleanup(runtime) {
          await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true });
        },
      },
    );
    expect(cleanupRetried.cleanup).toEqual({ status: "finalized" });
    expect(await Bun.file(workspaceMarker).exists()).toBe(false);
  });
});
