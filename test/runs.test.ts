import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateGoal, issueTicket } from "../src/goals.ts";
import { agentOutcomeDescription } from "../src/lifecycle.ts";
import {
  dispatchTicket,
  loadActiveRun,
  readAgentState,
  recordAgentExit,
  requestAgentStop,
  validateActiveRunPointer,
  validateRunRecord,
  writeAgentState,
  type AgentState,
  type DispatchLaunchRequest,
} from "../src/runs.ts";

const temporaryDirectories: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function execute(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

async function must(command: string[], cwd: string): Promise<string> {
  const result = await execute(command, cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

type Fixture = { root: string; goalId: string; ticketId: string; base: string; stateDir: string };

async function fixture(): Promise<Fixture> {
  const created = await mkdtemp(join(tmpdir(), "spike-run-"));
  temporaryDirectories.push(created);
  const root = await realpath(created);
  await must(["git", "init", "-b", "main"], root);
  await must(["git", "config", "user.name", "Spike Test"], root);
  await must(["git", "config", "user.email", "spike@example.test"], root);
  await mkdir(join(root, "doc"), { recursive: true });
  await writeFile(join(root, "doc", "goal.md"), "# Durable goal\n");
  await writeFile(join(root, ".gitignore"), ".pi-swarm/\n");
  await must(["git", "add", "."], root);
  await must(["git", "commit", "-m", "goal"], root);
  const goal = await activateGoal({ cwd: root, goalFile: "doc/goal.md", approvalStatement: "Approved for run tests" });
  const ticketPath = join(root, ".pi-swarm", "drafts", "ticket.md");
  await mkdir(dirname(ticketPath), { recursive: true });
  await writeFile(ticketPath, "# Ticket\n\nImplement this.\n");
  const ticket = await issueTicket({ cwd: root, ticketFile: ticketPath });
  return { root, goalId: goal.record.goalId, ticketId: ticket.record.ticketId, base: ticket.record.baseRevision, stateDir: join(root, ".pi-swarm") };
}

function agent(item: Fixture, request: DispatchLaunchRequest): AgentState {
  return {
    schemaVersion: 1,
    name: request.workerName,
    slug: request.workerSlug,
    project: "test",
    runtime: "apple",
    container: `container-${request.workerSlug}`,
    workspaceVolume: `volume-${request.workerSlug}`,
    network: `network-${request.workerSlug}`,
    containerPort: 3000,
    backend: "herdr",
    herdrName: `herdr-${request.workerSlug}`,
    herdrWorkspaceId: "workspace-1",
    herdrTabId: "tab-1",
    herdrPaneId: "pane-1",
    task: request.task,
    goalId: request.goalId,
    ticketId: request.ticketId,
    runId: request.runId,
    baseRevision: request.baseRevision,
    lifecycle: "running",
    startedAt: "2026-08-17T10:11:12.000Z",
    pid: 1234,
  };
}

async function successfulDispatch(item: Fixture, name = "worker-a") {
  return dispatchTicket({
    cwd: item.root,
    workerName: name,
    model: "provider/model",
    thinking: "high",
    now: new Date("2026-08-17T10:11:12.000Z"),
    launcher: async (request) => {
      expect(request.task).toContain(`/output/workflow/${item.goalId}/tickets/${item.ticketId}/ticket.md`);
      expect(request.task).not.toContain("Implement this.");
      await writeAgentState(item.stateDir, agent(item, request));
      return { runtime: "apple", container: `container-${request.workerSlug}`, herdrName: `herdr-${request.workerSlug}`, herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", herdrPaneId: "pane-1" };
    },
  });
}

describe("durable ticket dispatch and recovery", () => {
  test("records dispatch before launch, correlates identities, and recovers in a fresh CLI", async () => {
    const item = await fixture();
    let observedDispatching = false;
    const record = await dispatchTicket({
      cwd: item.root,
      workerName: "Worker One",
      model: "provider/model",
      thinking: "high",
      now: new Date("2026-08-17T10:11:12.000Z"),
      launcher: async (request) => {
        const before = await loadActiveRun(item.root);
        observedDispatching = before.status === "dispatching";
        expect(before.runId).toBe(request.runId);
        expect(request.task).toContain(`/output/workflow/${item.goalId}/tickets/${item.ticketId}/ticket.md`);
        expect(request.task.length).toBeLessThan(500);
        await writeAgentState(item.stateDir, agent(item, request));
        return { runtime: "apple", container: "container-worker-one", herdrName: "herdr-worker-one", herdrPaneId: "pane-1" };
      },
    });
    expect(observedDispatching).toBe(true);
    expect(record.runId).toMatch(/^run-[0-9a-f]{32}$/);
    expect(record.runId).not.toBe(item.goalId);
    expect(record.runId).not.toBe(item.ticketId);
    expect(record.worker.slug).toBe("worker-one");
    expect(record.baseRevision).toBe(item.base);
    expect(record.status).toBe("running");
    expect(record.requestedModel).toBe("provider/model");
    expect((await readAgentState(item.stateDir, "worker-one"))?.runId).toBe(record.runId);

    const recovered = await loadActiveRun(item.root);
    expect(recovered).toEqual(record);
    const status = await execute([process.execPath, cli, "run", "status", "--json"], item.root);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).runId).toBe(record.runId);
    expect(JSON.parse(status.stdout).container).toBe("container-worker-one");
    await expect(successfulDispatch(item, "other-worker")).rejects.toThrow("automatic redispatch is refused");
  });

  test("durably classifies launch failure and refuses implicit retry", async () => {
    const item = await fixture();
    await expect(dispatchTicket({ cwd: item.root, workerName: "broken", launcher: async () => { throw new Error("runtime unavailable\nwith details"); } })).rejects.toThrow("launch failed");
    const record = await loadActiveRun(item.root);
    expect(record.status).toBe("launch_failed");
    expect(record.launchError).toBe("runtime unavailable with details");
    expect(record.finishedAt).toBeDefined();
    await expect(dispatchTicket({ cwd: item.root, workerName: "broken", launcher: async () => ({ runtime: "apple", container: "never" }) })).rejects.toThrow("automatic redispatch is refused");
  });

  test("rejects malformed schemas, stale pointers, and identity/path tampering without a runtime", async () => {
    const item = await fixture();
    const record = await successfulDispatch(item);
    const ticketDirectory = join(item.root, ".pi-swarm", "goals", item.goalId, "tickets", item.ticketId);
    const pointerPath = join(ticketDirectory, "active-run.json");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    expect(validateActiveRunPointer(pointer, { goalId: item.goalId, ticketId: item.ticketId }).runId).toBe(record.runId);
    expect(validateRunRecord(record, { goalId: item.goalId, ticketId: item.ticketId, baseRevision: item.base, runId: record.runId })).toEqual(record);
    expect(() => validateActiveRunPointer({ ...pointer, schemaVersion: 9 }, { goalId: item.goalId, ticketId: item.ticketId })).toThrow("unsupported");
    expect(() => validateActiveRunPointer({ ...pointer, recordPath: "../record.json" }, { goalId: item.goalId, ticketId: item.ticketId })).toThrow("recordPath");
    expect(() => validateRunRecord({ ...record, ticketId: `ticket-${"a".repeat(32)}` }, { goalId: item.goalId, ticketId: item.ticketId, baseRevision: item.base, runId: record.runId })).toThrow("identity/base");

    await writeFile(pointerPath, JSON.stringify({ ...pointer, runId: `run-${"f".repeat(32)}`, recordPath: `.pi-swarm/goals/${item.goalId}/tickets/${item.ticketId}/runs/run-${"f".repeat(32)}/record.v1.json` }));
    await expect(loadActiveRun(item.root)).rejects.toThrow("active run record is missing");
  });
});

describe("intentional shutdown classification", () => {
  test("persists matching run and agent intent before stop and classifies 143 as requested stopped", async () => {
    const item = await fixture();
    const run = await successfulDispatch(item);
    let called = false;
    await requestAgentStop({
      cwd: item.root,
      name: "worker-a",
      requester: "cli",
      now: new Date("2026-08-17T11:00:00.000Z"),
      stopRuntime: async (stopping) => {
        called = true;
        expect(stopping.lifecycle).toBe("stopping");
        expect(stopping.stopRunId).toBe(run.runId);
        expect((await readAgentState(item.stateDir, "worker-a"))?.lifecycle).toBe("stopping");
        const durableRun = await loadActiveRun(item.root);
        expect(durableRun.status).toBe("stopping");
        expect(durableRun.stopReason).toBe("operator-requested");
        expect(durableRun.stopRunId).toBe(run.runId);
      },
    });
    expect(called).toBe(true);
    const initial = (await readAgentState(item.stateDir, "worker-a"))!;
    const final = await recordAgentExit({ cwd: item.root, state: initial, exitCode: 143, now: new Date("2026-08-17T11:00:01.000Z") });
    expect(final.lifecycle).toBe("stopped");
    expect(final.terminationKind).toBe("requested");
    expect(final.signal).toBe("SIGTERM");
    expect(final.expectedSignal).toBe("SIGTERM");
    const finalRun = await loadActiveRun(item.root);
    expect(finalRun.status).toBe("stopped");
    expect(finalRun.exitCode).toBe(143);
    expect(finalRun.terminationKind).toBe("requested");
    expect(agentOutcomeDescription(final)).toBe("stopped by request");
  });

  test("classifies unexpected 143 and stale intent from another run as failed", async () => {
    const noIntent = await fixture();
    await successfulDispatch(noIntent);
    const first = (await readAgentState(noIntent.stateDir, "worker-a"))!;
    const failed = await recordAgentExit({ cwd: noIntent.root, state: first, exitCode: 143 });
    expect(failed.lifecycle).toBe("failed");
    expect(failed.terminationKind).toBe("unexpected");
    expect((await loadActiveRun(noIntent.root)).status).toBe("failed");
    expect(agentOutcomeDescription(failed)).toBe("failed with exit code 143");

    const stale = await fixture();
    const run = await successfulDispatch(stale);
    const state = (await readAgentState(stale.stateDir, "worker-a"))!;
    const staleState: AgentState = { ...state, stopRequestedAt: "2026-08-17T11:00:00.000Z", stopReason: "old request", stopRunId: `run-${"a".repeat(32)}` };
    await writeAgentState(stale.stateDir, staleState);
    const staleFailed = await recordAgentExit({ cwd: stale.root, state: staleState, exitCode: 143 });
    expect(staleFailed.runId).toBe(run.runId);
    expect(staleFailed.lifecycle).toBe("failed");
    expect(staleFailed.terminationKind).toBe("unexpected");
  });
});
