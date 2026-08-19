import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSupervisorExtension,
  runSpikeJson,
  supervisorToolNames,
  type RunSpikeJsonInput,
  type SpikeJsonSuccess,
  type SupervisorExtensionApi,
} from "./pi-supervisor-extension.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeSpike(): Promise<{ directory: string; executable: string; calls: string }> {
  const directory = await mkdtemp(join(tmpdir(), "spike-supervisor-extension-"));
  directories.push(directory);
  const executable = join(directory, "fake-spike");
  const calls = join(directory, "calls.jsonl");
  await writeFile(executable, `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
await appendFile(process.env.FAKE_SPIKE_CALLS, JSON.stringify({ cwd: process.cwd(), args, stdin }) + "\\n");
if (process.env.FAKE_SPIKE_RESPONSE) {
  process.stdout.write(process.env.FAKE_SPIKE_RESPONSE);
  process.exit(Number(process.env.FAKE_SPIKE_EXIT || 0));
}
const command = args[0] === "status" || args[0] === "recover" ? args[0] : args.slice(0, 2).join(" ");
console.log(JSON.stringify({ ok: true, command, data: { arguments: args.slice(0, -1) } }));
process.exit(29);
`);
  await chmod(executable, 0o700);
  return { directory, executable, calls };
}

function registeredTools(command: string, environment: NodeJS.ProcessEnv) {
  const tools: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];
  registerSupervisorExtension({
    registerTool: (tool) => tools.push(tool),
    on() {},
    sendMessage() {},
  }, {
    command,
    environment,
    waitForDone: () => new Promise(() => undefined),
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Pi supervisor extension", () => {
  test("wakes the planner once with an operational recheck for a marker-backed open Ticket", async () => {
    const goalId = "goal-1";
    const identity = { goalId, changeId: "001", ticketId: "003" };
    const key = `worker-done:${goalId}/001/003`;
    const waiting = deferred<SpikeJsonSuccess>();
    const notified = deferred<void>();
    const waits: RunSpikeJsonInput[] = [];
    const messages: Array<{ message: any; options: any }> = [];
    const handlers = new Map<string, (event: unknown, context: { cwd: string }) => void | Promise<void>>();

    registerSupervisorExtension({
      registerTool() {},
      on(event, handler) { handlers.set(event, handler); },
      sendMessage(message, options) {
        messages.push({ message, options });
        notified.resolve();
      },
    }, {
      invoke: async (input) => ({
        ok: true,
        command: input.expectedCommand,
        data: {
          goals: [{ goalId, currentChange: { changeId: "001", openTicket: { ticketId: "003" } } }],
        },
      }),
      waitForDone(input) {
        waits.push(input);
        return waiting.promise;
      },
    });

    await handlers.get("session_start")!({}, { cwd: "/project" });
    expect(waits).toHaveLength(1);
    expect(waits[0]!.args).toEqual([
      "worker", "wait", "--goal", goalId, "--change", "001", "--ticket", "003",
    ]);
    expect(messages).toEqual([]);

    waiting.resolve({ ok: true, command: "worker wait", data: { ticket: identity, key, hosting: "herdr", status: "done" } });
    await notified.promise;
    expect(messages).toEqual([{
      message: {
        customType: "spike-worker-recheck",
        content: expect.stringContaining("Call spike_status now"),
        display: true,
        details: { key, ...identity },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    }]);
  });

  test("wakes the planner with an operational recheck when an attended waiter fails", async () => {
    const identity = { goalId: "goal-1", changeId: "001", ticketId: "003" };
    const key = `worker-done:${identity.goalId}/001/003`;
    const notified = deferred<void>();
    const messages: Array<{ message: any; options: any }> = [];
    const tools: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];

    registerSupervisorExtension({
      registerTool(tool) { tools.push(tool); },
      on() {},
      sendMessage(message, options) {
        messages.push({ message, options });
        notified.resolve();
      },
    }, {
      invoke: async (input) => ({
        ok: true,
        command: input.expectedCommand,
        data: input.expectedCommand === "ticket dispatch-pi"
          ? { ticket: identity, hosting: "herdr", status: "working" }
          : {},
      }),
      waitForDone: async () => { throw new Error("watcher unavailable"); },
    });

    const dispatch = tools.find((tool) => tool.name === "spike_dispatch_pi")!;
    await dispatch.execute("call", { ...identity, worker: "pi-worker" }, undefined, undefined, { cwd: "/project" });
    await notified.promise;

    expect(messages).toEqual([{
      message: {
        customType: "spike-worker-recheck",
        content: expect.stringContaining("waiter failed"),
        display: true,
        details: { key, ...identity, waiterFailed: true },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    }]);
  });

  test("cancels an open worker wait when the planner session shuts down", async () => {
    const handlers = new Map<string, (event: unknown, context: { cwd: string }) => void | Promise<void>>();
    let waitSignal: AbortSignal | undefined;
    registerSupervisorExtension({
      registerTool() {},
      on(event, handler) { handlers.set(event, handler); },
      sendMessage() {},
    }, {
      invoke: async (input) => ({
        ok: true,
        command: input.expectedCommand,
        data: { goals: [{ goalId: "goal-1", currentChange: { changeId: "001", openTicket: { ticketId: "001" } } }] },
      }),
      waitForDone(input) {
        waitSignal = input.signal;
        return new Promise(() => undefined);
      },
    });

    await handlers.get("session_start")!({}, { cwd: "/project" });
    expect(waitSignal?.aborted).toBe(false);
    await handlers.get("session_shutdown")!({}, { cwd: "/project" });
    expect(waitSignal?.aborted).toBe(true);
  });

  test("registers the complete sequential planner control plane", async () => {
    const fake = await fakeSpike();
    const tools = registeredTools(fake.executable, { ...process.env, FAKE_SPIKE_CALLS: fake.calls });

    expect([...tools.keys()]).toEqual([...supervisorToolNames]);
    for (const definition of tools.values()) expect(definition.executionMode).toBe("sequential");
    expect(tools.get("spike_issue_ticket")!.parameters).toMatchObject({
      required: ["goalId", "changeId", "instruction", "networkAccess"],
    });

    const calls: Array<[string, unknown]> = [
      ["spike_status", { goalId: "goal-1" }],
      ["spike_revise_plan", { goalId: "goal-1", body: "# Revised Plan\n" }],
      ["spike_create_change", {
        goalId: "goal-1",
        title: "Boundary",
        intent: "Delegate through Spike.",
        rationale: "Keep workflow authority on the host.",
        acceptanceCriteria: ["Structured calls are authoritative.", "Text is not parsed."],
        nonGoals: ["Herdr integration."],
        dependencies: ["Phase 2 CLI."],
      }],
      ["spike_decide_change", { goalId: "goal-1", changeId: "001", disposition: "abandon", statement: "Stop." }],
      ["spike_issue_ticket", {
        goalId: "goal-1",
        changeId: "001",
        instruction: "Implement it.",
        role: "implement",
        responseToReviewTicketId: "002",
        context: "Use the accepted design.",
        isolation: "workspace",
        networkAccess: "unrestricted",
        credentialGrants: ["github"],
        model: "worker-model",
        thinking: "medium",
      }],
      ["spike_dispatch_pi", { goalId: "goal-1", changeId: "001", ticketId: "003", worker: "pi-worker" }],
      ["spike_worker_status", { goalId: "goal-1", changeId: "001", ticketId: "003" }],
      ["spike_worker_read", { goalId: "goal-1", changeId: "001", ticketId: "003", lines: 80 }],
      ["spike_publish_report", {
        goalId: "goal-1",
        changeId: "001",
        ticketId: "003",
        commitSummary: "Complete boundary",
        commitBody: "Keep evidence structured.",
      }],
      ["spike_recover", { goalId: "goal-1", reason: "Supervisor restarted." }],
    ];

    for (const [name, params] of calls) {
      const result = await tools.get(name)!.execute("call", params, undefined, undefined, { cwd: fake.directory });
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
      expect(result.details.ok).toBe(true);
    }

    const invocations = (await readFile(fake.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(10);
    expect(invocations.every((call) => call.args.at(-1) === "--json")).toBe(true);
    expect(invocations[0].args).toEqual(["status", "--goal", "goal-1", "--json"]);
    expect(invocations[1]).toMatchObject({
      args: ["plan", "revise", "--goal", "goal-1", "--json"],
      stdin: "# Revised Plan\n",
    });
    expect(invocations[2].args).toEqual([
      "change", "create", "--goal", "goal-1", "--title", "Boundary", "--intent", "Delegate through Spike.",
      "--rationale", "Keep workflow authority on the host.", "--acceptance", "Structured calls are authoritative.",
      "--acceptance", "Text is not parsed.", "--non-goal", "Herdr integration.", "--dependency", "Phase 2 CLI.", "--json",
    ]);
    expect(invocations[3].args.slice(0, 4)).toEqual(["change", "abandon", "--goal", "goal-1"]);
    expect(invocations[4].args).toContain("worker-model");
    expect(invocations[5].args.slice(0, 2)).toEqual(["ticket", "dispatch-pi"]);
    expect(invocations[6].args.slice(0, 2)).toEqual(["worker", "status"]);
    expect(invocations[7].args).toEqual([
      "worker", "read", "--goal", "goal-1", "--change", "001", "--ticket", "003", "--lines", "80", "--json",
    ]);
    expect(invocations[8].args.slice(0, 2)).toEqual(["report", "publish"]);
    expect(invocations[9].args).toEqual([
      "recover", "--goal", "goal-1", "--reason", "Supervisor restarted.", "--json",
    ]);
  });

  test("trusts only Spike's parsed envelope, not process status, and rejects malformed or failed envelopes", async () => {
    const fake = await fakeSpike();
    const success = await runSpikeJson({
      cwd: fake.directory,
      command: fake.executable,
      environment: { ...process.env, FAKE_SPIKE_CALLS: fake.calls },
      args: ["status"],
      expectedCommand: "status",
    });
    expect(success).toMatchObject({ ok: true, command: "status" });

    await expect(runSpikeJson({
      cwd: fake.directory,
      command: fake.executable,
      environment: {
        ...process.env,
        FAKE_SPIKE_CALLS: fake.calls,
        FAKE_SPIKE_RESPONSE: '{"ok":false,"command":"status","error":{"code":"workflow","message":"durable state is invalid"}}\n',
        FAKE_SPIKE_EXIT: "0",
      },
      args: ["status"],
      expectedCommand: "status",
    })).rejects.toThrow("Spike rejected status: durable state is invalid");

    await expect(runSpikeJson({
      cwd: fake.directory,
      command: fake.executable,
      environment: {
        ...process.env,
        FAKE_SPIKE_CALLS: fake.calls,
        FAKE_SPIKE_RESPONSE: '{"ok":true,"command":"status","data":{}}\n{"planner":"claimed done"}\n',
      },
      args: ["status"],
      expectedCommand: "status",
    })).rejects.toThrow("single --json response");

    const controller = new AbortController();
    controller.abort();
    await expect(runSpikeJson({
      cwd: fake.directory,
      command: fake.executable,
      args: ["status"],
      expectedCommand: "status",
      signal: controller.signal,
    })).rejects.toThrow("Spike operation was cancelled");
  });
});
