import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateGoal, issueTicket } from "../src/goals.ts";
import { agentOutcomeDescription } from "../src/lifecycle.ts";
import { publishBranch } from "../src/publication.ts";
import {
  agentStopIntentPath,
  dispatchTicket,
  loadActiveRun,
  normalizeAgentState,
  readAgentState,
  recordAgentExit,
  requestAgentStop,
  validateActiveRunPointer,
  validateAgentStopIntent,
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

async function execute(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
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

function legacyAgent(item: Fixture, name: string, options: { backend?: "headless" | "herdr"; finished?: boolean } = {}) {
  const slug = name.toLowerCase();
  return {
    name,
    slug,
    project: item.root.split("/").at(-1)!,
    runtime: "apple",
    container: `container-${slug}`,
    workspaceVolume: `volume-${slug}`,
    network: `network-${slug}`,
    containerPort: 3000,
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.backend === "herdr" ? { herdrName: `herdr-${slug}`, herdrPaneId: `pane-${slug}` } : {}),
    startedAt: "2026-08-17T10:11:12.000Z",
    ...(options.finished ? { finishedAt: "2026-08-17T10:12:12.000Z", exitCode: 0 } : {}),
    pid: 1234,
  };
}

async function writeLegacyAgent(item: Fixture, name: string, options: { backend?: "headless" | "herdr"; finished?: boolean } = {}) {
  const directory = join(item.stateDir, "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name.toLowerCase()}.json`), `${JSON.stringify(legacyAgent(item, name, options), null, 2)}\n`);
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

describe("legacy agent state compatibility", () => {
  test("normalizes existing one-shot and Herdr records for list, stop, publication, and reuse", async () => {
    const item = await fixture();
    await writeLegacyAgent(item, "legacy-headless");
    await writeLegacyAgent(item, "legacy-herdr", { backend: "herdr" });
    await writeLegacyAgent(item, "legacy-finished", { finished: true });

    const listed = await execute([process.execPath, cli, "agent", "list"], join(import.meta.dir, ".."), { ...process.env, REPO_SEED: item.root });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("legacy-headless\trunning\theadless");
    expect(listed.stdout).toContain("legacy-herdr\trunning\therdr");
    expect(listed.stdout).toContain("legacy-finished\tcompleted\theadless");

    const herdr = (await readAgentState(item.stateDir, "legacy-herdr"))!;
    expect(herdr.schemaVersion).toBe(1);
    expect(herdr.backend).toBe("herdr");
    expect(herdr.herdrName).toBe("herdr-legacy-herdr");
    expect(herdr.finishedAt).toBeUndefined();
    // These are the fields publication consumes; normalization must preserve
    // them exactly for an applicable live persistent worker.
    expect({ slug: herdr.slug, project: herdr.project, runtime: herdr.runtime, container: herdr.container, backend: herdr.backend, finishedAt: herdr.finishedAt }).toEqual({
      slug: "legacy-herdr", project: item.root.split("/").at(-1)!, runtime: "apple", container: "container-legacy-herdr", backend: "herdr", finishedAt: undefined,
    });
    const publicationCommands: string[][] = [];
    await expect(publishBranch(
      { root: item.root, stateDir: item.stateDir, project: herdr.project },
      herdr,
      async (command) => { publicationCommands.push(command); return { code: 1, stdout: "", stderr: "worker is detached" }; },
    )).rejects.toThrow("detached");
    expect(publicationCommands[0]).toEqual(["container", "exec", "--user", "node", "container-legacy-herdr", "git", "-C", "/workspace/project", "symbolic-ref", "--quiet", "--short", "HEAD"]);

    let stopCalled = false;
    await requestAgentStop({
      cwd: item.root,
      name: "legacy-headless",
      stopRuntime: async (state) => {
        stopCalled = true;
        expect(state.schemaVersion).toBe(1);
        expect(state.lifecycle).toBe("stopping");
        const persisted = JSON.parse(await readFile(join(item.stateDir, "agents", "legacy-headless.json"), "utf8"));
        expect(persisted.schemaVersion).toBe(1);
        expect(persisted.lifecycle).toBe("stopping");
      },
    });
    expect(stopCalled).toBe(true);

    const finished = (await readAgentState(item.stateDir, "legacy-finished"))!;
    expect(finished.lifecycle).toBe("completed");
    expect(finished.finishedAt).toBeDefined();
    expect(JSON.parse(await readFile(join(item.stateDir, "agents", "legacy-finished.json"), "utf8")).schemaVersion).toBe(1);
    // Existing dispatch/persistent reuse gates on finishedAt, retained by the
    // migration, and can safely replace this terminal record.
    expect(finished.finishedAt).toBe("2026-08-17T10:12:12.000Z");
  });

  test("fails closed for malformed legacy records and unknown current schemas", async () => {
    const item = await fixture();
    const valid = legacyAgent(item, "legacy");
    expect(normalizeAgentState(valid, "legacy").state.lifecycle).toBe("running");
    expect(() => normalizeAgentState({ ...valid, runtime: "podman" }, "legacy")).toThrow("invalid runtime");
    expect(() => normalizeAgentState({ ...valid, pid: 0 }, "legacy")).toThrow("invalid pid");
    expect(() => normalizeAgentState({ ...valid, container: "" }, "legacy")).toThrow("invalid container");
    expect(() => normalizeAgentState({ ...valid, herdrPaneId: 42 }, "legacy")).toThrow("invalid herdrPaneId");
    expect(() => normalizeAgentState({ ...valid, lifecycle: "running" }, "legacy")).toThrow("unexpected lifecycle");
    expect(() => normalizeAgentState({ ...valid, schemaVersion: 2 }, "legacy")).toThrow("unsupported agent state schema: 2");
    expect(() => normalizeAgentState({ ...valid, finishedAt: "2026-08-17T10:12:12.000Z" }, "legacy")).toThrow("no exitCode");
  });

  test("validates the narrow stop-intent schema and start identity", () => {
    const valid = {
      schemaVersion: 1 as const,
      slug: "legacy",
      startedAt: "2026-08-17T10:11:12.000Z",
      pid: 1234,
      container: "container-legacy",
      stopRequestedAt: "2026-08-17T11:00:00.000Z",
      stopRequester: "cli",
      stopReason: "operator-requested",
    };
    expect(validateAgentStopIntent(valid, "legacy")).toEqual(valid);
    expect(() => validateAgentStopIntent({ ...valid, schemaVersion: 2 }, "legacy")).toThrow("unsupported agent stop intent schema");
    expect(() => validateAgentStopIntent({ ...valid, startedAt: "yesterday" }, "legacy")).toThrow("invalid timestamp");
    expect(() => validateAgentStopIntent({ ...valid, pid: 0 }, "legacy")).toThrow("invalid pid");
    expect(() => validateAgentStopIntent({ ...valid, runId: "other-run" }, "legacy")).toThrow("invalid runId");
  });
});

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
  test("reconciles a live schema-less launcher's terminal overwrite after runtime stop", async () => {
    const item = await fixture();
    const original = legacyAgent(item, "legacy-worker");
    await writeLegacyAgent(item, "legacy-worker");
    const intentPath = agentStopIntentPath(item.stateDir, "legacy-worker");

    const final = await requestAgentStop({
      cwd: item.root,
      name: "legacy-worker",
      requester: "operator@example.test",
      reason: "maintenance window",
      now: new Date("2026-08-17T11:00:00.000Z"),
      stopRuntime: async (stopping) => {
        expect(stopping.schemaVersion).toBe(1);
        expect(stopping.lifecycle).toBe("stopping");
        const intent = JSON.parse(await readFile(intentPath, "utf8"));
        expect(validateAgentStopIntent(intent, "legacy-worker").startedAt).toBe(original.startedAt);
        // This is the real pre-lifecycle finally block: it still owns its
        // schema-less launch snapshot and replaces all newly added stop fields.
        await writeFile(join(item.stateDir, "agents", "legacy-worker.json"), `${JSON.stringify({
          ...original,
          finishedAt: "2026-08-17T11:00:01.000Z",
          exitCode: 143,
        }, null, 2)}\n`);
      },
    });

    expect(final).toMatchObject({
      schemaVersion: 1,
      lifecycle: "stopped",
      outcome: "stopped",
      exitCode: 143,
      signal: "SIGTERM",
      expectedSignal: "SIGTERM",
      terminationKind: "requested",
      stopRequestedAt: "2026-08-17T11:00:00.000Z",
      stopRequester: "operator@example.test",
      stopReason: "maintenance window",
    });
    expect(await readAgentState(item.stateDir, "legacy-worker")).toEqual(final);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });

  test("reconciles correlated agent and run state after a terminal overwrite", async () => {
    const item = await fixture();
    const run = await successfulDispatch(item);
    const original = (await readAgentState(item.stateDir, "worker-a"))!;
    const final = await requestAgentStop({
      cwd: item.root,
      name: "worker-a",
      requester: "cli",
      reason: "operator-requested",
      now: new Date("2026-08-17T11:00:00.000Z"),
      stopRuntime: async () => {
        await writeAgentState(item.stateDir, {
          ...original,
          lifecycle: "failed",
          outcome: "failed",
          finishedAt: "2026-08-17T11:00:01.000Z",
          exitCode: 143,
          signal: "SIGTERM",
          terminationKind: "unexpected",
        });
      },
    });
    expect(final.lifecycle).toBe("stopped");
    expect(final.runId).toBe(run.runId);
    expect(final.stopRunId).toBe(run.runId);
    const finalRun = await loadActiveRun(item.root);
    expect(finalRun).toMatchObject({
      status: "stopped",
      outcome: "stopped",
      exitCode: 143,
      signal: "SIGTERM",
      expectedSignal: "SIGTERM",
      terminationKind: "requested",
      stopRequestedAt: "2026-08-17T11:00:00.000Z",
      stopRequester: "cli",
      stopReason: "operator-requested",
      stopRunId: run.runId,
    });
    expect(await Bun.file(agentStopIntentPath(item.stateDir, "worker-a")).exists()).toBe(false);
  });

  test("does not apply pending intent to changed starts, runs, or replacement processes", async () => {
    for (const replacement of [
      { startedAt: "2026-08-17T10:11:13.000Z" },
      { pid: 5678 },
      { runId: `run-${"a".repeat(32)}` },
    ]) {
      const item = await fixture();
      await successfulDispatch(item);
      const original = (await readAgentState(item.stateDir, "worker-a"))!;
      await requestAgentStop({
        cwd: item.root,
        name: "worker-a",
        stopRuntime: async () => {
          await writeAgentState(item.stateDir, {
            ...original,
            ...replacement,
            lifecycle: "failed",
            outcome: "failed",
            finishedAt: "2026-08-17T11:00:01.000Z",
            exitCode: 143,
            signal: "SIGTERM",
            terminationKind: "unexpected",
          });
        },
      });
      const persisted = (await readAgentState(item.stateDir, "worker-a"))!;
      expect(persisted.lifecycle).toBe("failed");
      expect(persisted.terminationKind).toBe("unexpected");
      expect(persisted.expectedSignal).toBeUndefined();
      expect(await Bun.file(agentStopIntentPath(item.stateDir, "worker-a")).exists()).toBe(false);
    }
  });

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

  test("releases the lifecycle lock before runtime stop waits for foreground exit", async () => {
    const item = await fixture();
    await successfulDispatch(item);
    const initial = (await readAgentState(item.stateDir, "worker-a"))!;
    let enteredRuntime!: () => void;
    let releaseRuntime!: () => void;
    const entered = new Promise<void>((resolve) => { enteredRuntime = resolve; });
    const release = new Promise<void>((resolve) => { releaseRuntime = resolve; });

    const stopPromise = requestAgentStop({
      cwd: item.root,
      name: "worker-a",
      stopRuntime: async () => {
        enteredRuntime();
        // A real runtime stop may wait here for runAgent's process to exit.
        await release;
      },
    });
    await entered;
    await expect(requestAgentStop({ cwd: item.root, name: "worker-a", stopRuntime: async () => {} })).rejects.toThrow("already stopping");

    let exit: AgentState;
    try {
      exit = await Promise.race([
        recordAgentExit({ cwd: item.root, state: initial, exitCode: 143 }),
        Bun.sleep(1_000).then(() => { throw new Error("recordAgentExit deadlocked behind stopRuntime"); }),
      ]);
    } finally {
      releaseRuntime();
    }
    expect(exit.lifecycle).toBe("stopped");
    expect((await loadActiveRun(item.root)).status).toBe("stopped");
    await stopPromise;
    expect((await readAgentState(item.stateDir, "worker-a"))?.lifecycle).toBe("stopped");
  });

  test("classifies unexpected 143 and stale intent from another run as failed", async () => {
    const legacyNoIntent = await fixture();
    await writeLegacyAgent(legacyNoIntent, "legacy-unexpected");
    await writeFile(join(legacyNoIntent.stateDir, "agents", "legacy-unexpected.json"), `${JSON.stringify({
      ...legacyAgent(legacyNoIntent, "legacy-unexpected"),
      finishedAt: "2026-08-17T11:00:01.000Z",
      exitCode: 143,
    }, null, 2)}\n`);
    const legacyFailed = (await readAgentState(legacyNoIntent.stateDir, "legacy-unexpected"))!;
    expect(legacyFailed.lifecycle).toBe("failed");
    expect(legacyFailed.terminationKind).toBe("unexpected");
    expect(legacyFailed.signal).toBe("SIGTERM");
    expect(legacyFailed.expectedSignal).toBeUndefined();

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
