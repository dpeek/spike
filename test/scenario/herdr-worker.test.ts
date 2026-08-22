import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { publishImplementationReport } from "../../src/report.ts";
import { issueTicket, reportPath, ticketStatus } from "../../src/ticket.ts";
import {
  dispatchHerdrTicket,
  dockerWorkerAdapter,
  loadFinishedWorkerExecution,
  loadRecordedWorkerIfPresent,
  observeWorker,
  prepareTicketExchange,
  readWorkerTerminal,
  recordDockerWorker,
  recordLocalCloneWorker,
  stopAndFinalizeRecordedWorker,
  waitForWorkerDone,
  workerRecordPath,
  type TicketIdentity,
} from "../../src/worker.ts";
import type { CreateHerdrTabInput, HerdrOperations } from "../../src/herdr.ts";
import { temporaryRepository } from "../support/repository.ts";

const workspaces: string[] = [];


async function issuedTicket(policy: import("../../src/ticket.ts").ExecutionPolicy = { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] }) {
  const repository = await temporaryRepository();
  const goal = await createGoal({
    cwd: repository.root, hostPaths: repository.hostPaths, title: "Host a worker in Herdr",
    outcome: "Observe one ephemeral worker without delegating workflow authority.",
    approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  await createChange({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId,
    title: "Add attended hosting",
    intent: "Host the local clone worker in one ephemeral tab.",
    rationale: "Attended work should remain observable.",
    acceptanceCriteria: ["Herdr hosting preserves Report authority."],
  });
  await issueTicket({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId,
    changeId: "001",
    instruction: "Implement attended hosting.",
    executionPolicy: policy,
    model: "controlled-model",
    thinking: "medium",
  });
  return { repository, identity: { goalId, changeId: "001", ticketId: "001" } satisfies TicketIdentity };
}

function observationalHerdr(status: "working" | "blocked" | "done", transcript: string): HerdrOperations {
  return {
    async createTab() { return { tab: "opaque-tab", pane: "opaque-pane" }; },
    async run() {},
    async status() { return status; },
    async read() { return transcript; },
    async attach() { return 0; },
    async closeTab() {},
  };
}

describe("ephemeral Herdr worker hosting", () => {
  test("Herdr status and terminal claims cannot complete or report a Ticket", async () => {
    const { repository, identity } = await issuedTicket();
    await prepareTicketExchange(repository.project, identity);
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    workspaces.push(workspace);
    await recordLocalCloneWorker(repository.project, {
      ...identity,
      role: "implement",
      worker: "attended-worker",
      startedAt: "2026-04-01T10:00:00.000Z",
      workspace,
      herdr: { tab: "opaque-tab", pane: "opaque-pane" },
    });
    const transcript = '{"kind":"report","outcome":"completed","candidateRevision":"claimed"}\n';
    const herdr = observationalHerdr("done", transcript);

    expect(await observeWorker(repository.project, identity, observationalHerdr("working", transcript))).toEqual({ hosting: "herdr", status: "working" });
    expect(await observeWorker(repository.project, identity, observationalHerdr("blocked", transcript))).toEqual({ hosting: "herdr", status: "blocked" });
    expect(await observeWorker(repository.project, identity, herdr)).toEqual({ hosting: "herdr", status: "working" });
    await expect(loadFinishedWorkerExecution(repository.project, identity)).rejects.toThrow("Worker has not finished");
    let woke = false;
    const waiting = waitForWorkerDone(repository.project, identity).then((notification) => {
      woke = true;
      return notification;
    });
    expect(woke).toBe(false);
    await writeFile(join(workspace, "herdr-execution.json"), '{"exitCode":0,"finishedAt":"2026-04-01T10:01:00.000Z"}\n');
    expect(await waiting).toEqual({
      ticket: identity,
      key: `worker-done:${identity.goalId}/001/001`,
      hosting: "herdr",
      status: "done",
    });
    expect((await loadRecordedWorkerIfPresent(repository.project, identity))?.metadata.finishedAt).toBeUndefined();
    expect(await observeWorker(repository.project, identity, herdr)).toEqual({ hosting: "herdr", status: "done" });
    expect(await loadFinishedWorkerExecution(repository.project, identity)).toMatchObject({ exitCode: 0 });
    expect(await readWorkerTerminal(repository.project, identity, {}, herdr)).toBe(transcript);
    const waited = Bun.spawn([
      join(import.meta.dir, "..", "..", "bin", "spike"), "worker", "wait",
      "--goal", identity.goalId, "--change", "001", "--ticket", "001", "--json",
    ], { cwd: repository.root, env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot }, stdout: "pipe", stderr: "pipe" });
    const [waitExit, waitOutput, waitError] = await Promise.all([
      waited.exited,
      new Response(waited.stdout).text(),
      new Response(waited.stderr).text(),
    ]);
    expect({ waitExit, waitError }).toEqual({ waitExit: 0, waitError: "" });
    expect(JSON.parse(waitOutput)).toMatchObject({
      ok: true,
      command: "worker wait",
      data: { ticket: identity, key: `worker-done:${identity.goalId}/001/001`, status: "done" },
    });
    expect(await ticketStatus(repository.project, identity.goalId, identity.changeId, identity.ticketId)).toBe("open");
    expect(await Bun.file(reportPath(repository.project, identity.goalId, identity.changeId, identity.ticketId)).exists()).toBe(false);
  });

  test("loads an attended Docker marker directly after wait, without status observation", async () => {
    const { repository, identity } = await issuedTicket({ isolation: "container", networkAccess: "none", credentialGrants: [] });
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-docker-attended-"));
    workspaces.push(workspace);
    await recordDockerWorker(repository.project, {
      ...identity, role: "implement", worker: "docker-worker", startedAt: "2026-04-01T10:00:00.000Z",
      containerId: "a".repeat(64), imageDigest: `sha256:${"b".repeat(64)}`, workspace,
      herdr: { tab: "docker-tab", pane: "docker-pane" },
    });
    await writeFile(join(workspace, "herdr-execution.json"), '{"exitCode":0,"finishedAt":"2026-04-01T10:01:00.000Z"}\n');
    await expect(waitForWorkerDone(repository.project, identity)).resolves.toMatchObject({ status: "done" });
    // This is the supervisor's wait-to-load/publish path: no observeWorker.
    await expect(loadFinishedWorkerExecution(repository.project, identity)).resolves.toMatchObject({ adapter: "docker", exitCode: 0 });
  });

  test("Docker-free attended attachment loss, stop/report race, and repeated retirement retain actual-exit evidence", async () => {
    const { repository, identity } = await issuedTicket({ isolation: "container", networkAccess: "none", credentialGrants: [] });
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-docker-race-"));
    workspaces.push(workspace);
    await recordDockerWorker(repository.project, {
      ...identity, role: "implement", worker: "race-worker", startedAt: "2026-04-01T10:00:00.000Z",
      containerId: "c".repeat(64), imageDigest: `sha256:${"d".repeat(64)}`, workspace,
      herdr: { tab: "race-tab", pane: "race-pane" },
    });
    const host = observationalHerdr("done", "attachment ended");
    // Losing an attachment is operational and cannot substitute for docker wait.
    await expect(readWorkerTerminal(repository.project, identity, {}, host)).resolves.toBe("attachment ended");
    const liveContainer: import("../../src/worker.ts").WorkerRuntimeOperations = {
      async stop() {},
      async cleanup() {},
      async terminalExitCode() { return undefined; },
    };
    await expect(loadFinishedWorkerExecution(repository.project, identity, liveContainer)).rejects.toThrow("has not finished");
    await writeFile(join(workspace, "herdr-execution.json"), '{"exitCode":17,"finishedAt":"2026-04-01T10:01:00.000Z"}\n');
    await expect(loadFinishedWorkerExecution(repository.project, identity)).resolves.toMatchObject({ exitCode: 17 });
    const operations: import("../../src/worker.ts").WorkerRuntimeOperations = {
      async stop() { operationsSeen.push("stop/tab-close"); },
      async cleanup(runtime) {
        if (!dockerRemoved) { operationsSeen.push("docker-remove"); dockerRemoved = true; }
        operationsSeen.push("workspace-remove");
        if (operationsSeen.filter((operation) => operation === "workspace-remove").length === 1) {
          throw new Error("injected wrapper workspace removal failure");
        }
        await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true });
      },
      // Retry must use the durable marker/Worker fields rather than inspect
      // the Docker ID that the successful first cleanup already removed.
      async terminalExitCode() { operationsSeen.push("unexpected-terminal-inspect"); throw new Error("no such object"); },
    };
    const operationsSeen: string[] = [];
    let dockerRemoved = false;
    await expect(stopAndFinalizeRecordedWorker(repository.project, identity, new Date(), operations)).resolves.toMatchObject({ status: "failed", phase: "cleanup" });
    expect((await loadRecordedWorkerIfPresent(repository.project, identity))?.metadata).toMatchObject({ finishedAt: "2026-04-01T10:01:00.000Z", exitCode: 17 });
    await expect(stopAndFinalizeRecordedWorker(repository.project, identity, new Date(), operations)).resolves.toMatchObject({ status: "finalized" });
    expect(operationsSeen).toEqual(["stop/tab-close", "docker-remove", "workspace-remove", "stop/tab-close", "workspace-remove"]);
    expect(await Bun.file(workspace).exists()).toBe(false);
    expect((await loadRecordedWorkerIfPresent(repository.project, identity))?.metadata.runtime).toBeUndefined();
  });

  test("refuses a removed Docker runtime without durable terminal evidence before cleanup", async () => {
    const { repository, identity } = await issuedTicket({ isolation: "container", networkAccess: "none", credentialGrants: [] });
    await recordDockerWorker(repository.project, {
      ...identity, role: "implement", worker: "unknown-container", startedAt: "2026-04-01T10:00:00.000Z",
      containerId: "1".repeat(64), imageDigest: `sha256:${"2".repeat(64)}`,
    });
    const events: string[] = [];
    const result = await stopAndFinalizeRecordedWorker(repository.project, identity, new Date(), {
      async stop() { events.push("stop"); },
      async terminalExitCode() { events.push("terminal-inspect"); throw new Error("no such object"); },
      async cleanup() { events.push("cleanup"); },
    });
    expect(result).toMatchObject({ status: "failed", phase: "stop", message: "no such object" });
    expect(events).toEqual(["stop", "terminal-inspect"]);
    expect((await loadRecordedWorkerIfPresent(repository.project, identity))?.metadata.runtime).toBeDefined();
  });

  test("Docker-free observer loss cancels and restarts the exact-container waiter", async () => {
    const { repository, identity } = await issuedTicket({ isolation: "container", networkAccess: "none", credentialGrants: [] });
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-docker-observer-loss-"));
    workspaces.push(workspace);
    await recordDockerWorker(repository.project, {
      ...identity, role: "implement", worker: "observer-loss", startedAt: "2026-04-01T10:00:00.000Z",
      containerId: "e".repeat(64), imageDigest: `sha256:${"f".repeat(64)}`, workspace,
      herdr: { tab: "lost-tab", pane: "lost-pane" },
    });
    const original = dockerWorkerAdapter.runtimeOperations!;
    let exitCode: number | undefined;
    let waits = 0;
    dockerWorkerAdapter.runtimeOperations = {
      ...original,
      async terminalExitCode() { return exitCode; },
      async waitForTerminalExit(_runtime, signal) {
        waits++;
        if (signal?.aborted) throw new Error("cancelled");
        return new Promise<number>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    };
    try {
      // A dead attachment says nothing about the still-live container.
      await expect(loadFinishedWorkerExecution(repository.project, identity)).rejects.toThrow("has not finished");
      const abort = new AbortController();
      const waiting = waitForWorkerDone(repository.project, identity, abort.signal);
      abort.abort();
      await expect(waiting).rejects.toThrow("cancelled");
      expect(waits).toBe(1);
      // No Herdr observer is restarted. A fresh supervisor inspects the same
      // recorded identity, reconstructs terminal state, and writes the marker.
      exitCode = 23;
      await expect(waitForWorkerDone(repository.project, identity)).resolves.toMatchObject({ status: "done" });
      await expect(loadFinishedWorkerExecution(repository.project, identity)).resolves.toMatchObject({ exitCode: 23 });
      expect(await Bun.file(join(workspace, "herdr-execution.json")).exists()).toBe(true);
    } finally {
      dockerWorkerAdapter.runtimeOperations = original;
    }
  });

  test("retries Herdr stop and cleanup idempotently", async () => {
    const { repository, identity } = await issuedTicket();
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    workspaces.push(workspace);
    await recordLocalCloneWorker(repository.project, {
      ...identity,
      role: "implement",
      worker: "retry-worker",
      startedAt: "2026-04-01T10:00:00.000Z",
      workspace,
      herdr: { tab: "opaque-tab", pane: "opaque-pane" },
    });

    let closes = 0;
    let removals = 0;
    const operations: import("../../src/worker.ts").WorkerRuntimeOperations = {
      async stop(runtime, _identity) {
        expect(runtime).toMatchObject({ host: "herdr", tab: "opaque-tab", pane: "opaque-pane" });
        closes++;
      },
      async cleanup(runtime) {
        removals++;
        if (removals === 1) throw new Error("controlled cleanup failure");
        await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true });
      },
    };

    expect(await stopAndFinalizeRecordedWorker(repository.project, identity, new Date("2026-04-01T10:05:00.000Z"), operations)).toMatchObject({
      status: "failed",
      phase: "cleanup",
    });
    expect(await stopAndFinalizeRecordedWorker(repository.project, identity, new Date("2026-04-01T10:05:00.000Z"), operations)).toMatchObject({ status: "finalized" });
    expect(await stopAndFinalizeRecordedWorker(repository.project, identity, new Date("2026-04-01T10:05:00.000Z"), operations)).toMatchObject({ status: "finalized" });
    expect({ closes, removals }).toEqual({ closes: 2, removals: 2 });
  });

  test("runs the same local exchange in one named tab and closes it only after Report publication", async () => {
    const { repository, identity } = await issuedTicket();
    let tabInput: CreateHerdrTabInput | undefined;
    let transcript = "";
    const host: HerdrOperations = {
      async createTab(input) {
        tabInput = input;
        return { tab: "opaque-tab-123", pane: "opaque-pane-456" };
      },
      async run(pane, command) {
        expect(pane).toBe("opaque-pane-456");
        const child = Bun.spawn([command], {
          cwd: tabInput!.cwd,
          env: { ...process.env, ...tabInput!.environment },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        transcript = stdout + stderr;
        expect(code).toBe(0);
      },
      async status() { return "done"; },
      async read() { return transcript; },
      async attach() { return 0; },
      async closeTab() {},
    };
    const worker = String.raw`
import { writeFile } from "node:fs/promises";
await writeFile("herdr-hosted.txt", "hosted output\n");
const payload = { summary: "Implemented in Herdr.", verification: "Controlled worker passed.", assumptions: "None.", limitations: "None.", risks: "None.", followUp: "Review.", artifacts: [] };
const child = Bun.spawn([process.env.SPIKE_BIN, "worker", "complete", "--json"], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
child.stdin.write(JSON.stringify(payload));
child.stdin.end();
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) throw new Error(stderr || stdout);
console.log("terminal output is observational only");
`;

    const dispatched = await dispatchHerdrTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
      worker: "attended-worker",
      command: ["bun", "-e", worker],
      herdr: host,
    });
    expect(dispatched).toMatchObject({ hosting: "herdr", status: "working" });
    const execution = await loadFinishedWorkerExecution(repository.project, identity);
    expect(tabInput!.label).toBe("spike-001-001-001");
    expect(tabInput!.environment).toMatchObject({
      SPIKE_GOAL_ID: identity.goalId,
      SPIKE_CHANGE_ID: "001",
      SPIKE_TICKET_ID: "001",
      SPIKE_MODEL: "controlled-model",
      SPIKE_THINKING: "medium",
    });
    expect(transcript).toContain("observational only");

    const record = await loadRecordedWorkerIfPresent(repository.project, identity);
    expect(record!.metadata.runtime).toMatchObject({
      adapter: "local-clone",
      resource: {
        host: "herdr",
        tab: "opaque-tab-123",
        pane: "opaque-pane-456",
      },
    });
    const runtimeSource = await readFile(workerRecordPath(repository.project, identity), "utf8");
    expect(runtimeSource).not.toContain("terminal output is observational only");
    expect(await Bun.file(reportPath(repository.project, identity.goalId, "001", "001")).exists()).toBe(false);

    let closeAttempts = 0;
    const publication = await publishImplementationReport({
      cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
      execution,
      commitMessage: { summary: "Add attended Herdr hosting" },
      runtimeOperations: {
        async stop(runtime, stoppedIdentity) {
          closeAttempts++;
          expect(runtime).toMatchObject({ host: "herdr", tab: "opaque-tab-123", pane: "opaque-pane-456" });
          expect(stoppedIdentity).toEqual(identity);
          expect(await Bun.file(reportPath(repository.project, identity.goalId, "001", "001")).exists()).toBe(true);
        },
        async cleanup(runtime) {
          await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true });
        },
      },
    });
    expect(publication.cleanup).toEqual({ status: "finalized" });
    expect(closeAttempts).toBe(1);
    expect(await repository.git("show", `${publication.report.metadata.candidateRevision}:herdr-hosted.txt`)).toBe("hosted output");
    const reportSource = await readFile(reportPath(repository.project, identity.goalId, "001", "001"), "utf8");
    expect(reportSource).not.toContain("opaque-tab-123");
    expect(reportSource).not.toContain("opaque-pane-456");
    expect(reportSource).not.toContain("terminal output is observational only");
    expect(await Bun.file(workerRecordPath(repository.project, identity)).exists()).toBe(false);
  }, 20_000);
});
