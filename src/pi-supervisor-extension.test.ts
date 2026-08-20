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
    expect(tools.has("spike_issue_ticket")).toBe(false);
    expect(tools.get("spike_create_goal")!.parameters).toMatchObject({ required: ["title", "outcome", "approval"] });
    expect(tools.get("spike_issue_review")!.parameters).toMatchObject({
      required: ["goalId", "changeId", "instruction", "producingImplementationTicketId", "networkAccess"],
    });
    expect(tools.get("spike_issue_remediate")!.parameters).toMatchObject({
      required: ["goalId", "changeId", "instruction", "responseToReviewTicketId", "networkAccess"],
    });
    expect(tools.get("spike_dispatch_pi")!.promptGuidelines).toContain(
      "After an attended dispatch returns working, yield the planner turn and wait for the extension's one-shot operational recheck; do not poll spike_worker_status or spike_status.",
    );

    const identity = { goalId: "goal-1", changeId: "001" };
    const calls: Array<[string, unknown]> = [
      ["spike_status", { goalId: "goal-1" }],
      ["spike_begin_step", { step: "goal" }],
      ["spike_create_goal", { title: "Approved Goal", outcome: "Delegate safely.", approval: "Operator approved." }],
      ["spike_begin_step", { step: "plan", goalId: "goal-1" }],
      ["spike_revise_plan", { goalId: "goal-1", body: "# Revised Plan\n" }],
      ["spike_begin_step", { step: "change", goalId: "goal-1" }],
      ["spike_create_change", {
        goalId: "goal-1", title: "Boundary", intent: "Delegate through Spike.",
        rationale: "Keep workflow authority on the host.", acceptanceCriteria: ["Text is not parsed."],
      }],
      ["spike_begin_step", { step: "decide", ...identity }],
      ["spike_decide_change", { ...identity, disposition: "abandon", statement: "Stop." }],
      ["spike_begin_step", { step: "implement", ...identity }],
      ["spike_issue_implement", {
        ...identity, instruction: "Implement it.", networkAccess: "unrestricted", model: "worker-model", thinking: "medium",
      }],
      ["spike_begin_step", { step: "review", ...identity }],
      ["spike_issue_review", {
        ...identity, instruction: "Review it.", producingImplementationTicketId: "001", networkAccess: "unrestricted",
      }],
      ["spike_begin_step", { step: "remediate", ...identity }],
      ["spike_issue_remediate", {
        ...identity, instruction: "Close F-1.", responseToReviewTicketId: "002", networkAccess: "unrestricted",
      }],
      ["spike_dispatch_pi", { ...identity, ticketId: "003", worker: "pi-worker" }],
      ["spike_worker_status", { ...identity, ticketId: "003" }],
      ["spike_worker_read", { ...identity, ticketId: "003", lines: 80 }],
      ["spike_publish_report", { ...identity, ticketId: "003", commitSummary: "Complete boundary" }],
      ["spike_begin_step", { step: "recover", goalId: "goal-1" }],
      ["spike_recover", { goalId: "goal-1", reason: "Supervisor restarted." }],
    ];

    for (const [name, params] of calls) {
      const result = await tools.get(name)!.execute("call", params, undefined, undefined, { cwd: fake.directory });
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
      expect(result.details.ok).toBe(true);
    }

    const invocations = (await readFile(fake.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(calls.length);
    expect(invocations.every((call) => call.args.at(-1) === "--json")).toBe(true);
    expect(invocations[1].args).toEqual(["guidance", "show", "--step", "goal", "--json"]);
    expect(invocations[2].args).toContain("Operator approved.");
    expect(invocations[4]).toMatchObject({ args: ["plan", "revise", "--goal", "goal-1", "--json"], stdin: "# Revised Plan\n" });
    expect(invocations[10].args).toContain("worker-model");
    expect(invocations[12].args).toContain("--implementation-ticket");
    expect(invocations[12].args).toContain("review");
    expect(invocations[14].args).toContain("--response-to-review");
    expect(invocations[14].args).toContain("implement");
    expect(invocations[20].args).toEqual(["recover", "--goal", "goal-1", "--reason", "Supervisor restarted.", "--json"]);
  });

  test("registers Goal apply approval gating, forwards it exactly, preserves evidence, and propagates refusals", async () => {
    const calls: RunSpikeJsonInput[] = [];
    const evidence = {
      goalId: "goal-1",
      targetBranch: "main",
      previousTargetRevision: "a".repeat(40),
      appliedRevision: "b".repeat(40),
      resultingTargetRevision: "b".repeat(40),
    };
    const refusal = new Error("Spike rejected goal apply: target cannot fast-forward");
    let refuse = false;
    const tools: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];
    registerSupervisorExtension({
      registerTool(tool) { tools.push(tool); },
      on() {},
      sendMessage() {},
    }, {
      async invoke(input) {
        calls.push(input);
        if (refuse) throw refusal;
        return { ok: true, command: "goal apply", data: evidence };
      },
    });

    const apply = tools.find((tool) => tool.name === "spike_apply_goal")!;
    expect(apply.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["goalId", "targetBranch", "approval"],
      properties: {
        goalId: { type: "string", minLength: 1, pattern: "\\S" },
        targetBranch: { type: "string", minLength: 1, pattern: "\\S" },
        approval: { type: "string", minLength: 1, pattern: "\\S" },
      },
    });

    const params = { goalId: "goal-1", targetBranch: "main", approval: "I approve this apply." };
    const result = await apply.execute("call", params, undefined, undefined, { cwd: "/project" });
    expect(calls).toEqual([{
      cwd: "/project",
      args: ["goal", "apply", "--goal", "goal-1", "--target", "main", "--approval", "I approve this apply."],
      expectedCommand: "goal apply",
    }]);
    expect(result.details).toEqual({ ok: true, command: "goal apply", data: evidence });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);

    refuse = true;
    await expect(apply.execute("call", params, undefined, undefined, { cwd: "/project" })).rejects.toBe(refusal);
    expect(calls).toHaveLength(2);
  });

  test("rejects unselected or mismatched mutations, consumes one match, and forgets selection on restart", async () => {
    const calls: RunSpikeJsonInput[] = [];
    const tools: Array<Parameters<SupervisorExtensionApi["registerTool"]>[0]> = [];
    const handlers = new Map<string, (event: unknown, context: { cwd: string }) => void | Promise<void>>();
    registerSupervisorExtension({
      registerTool(tool) { tools.push(tool); },
      on(event, handler) { handlers.set(event, handler); },
      sendMessage() {},
    }, {
      async invoke(input) {
        calls.push(input);
        return {
          ok: true,
          command: input.expectedCommand,
          data: input.expectedCommand === "guidance show"
            ? { step: input.args[3], path: `spike/guidance/${input.args[3]}.md`, sourceRevision: "a".repeat(40), markdown: "# Guidance\n" }
            : {},
        };
      },
      waitForDone: () => new Promise(() => undefined),
    });
    const registered = new Map(tools.map((tool) => [tool.name, tool]));
    const context = { cwd: "/project" };
    const ticket = { goalId: "goal-1", changeId: "001", instruction: "Bounded work.", networkAccess: "unrestricted" };

    await expect(registered.get("spike_issue_implement")!.execute("call", ticket, undefined, undefined, context))
      .rejects.toThrow("Call spike_begin_step for implement on goal-1/001");
    expect(calls).toEqual([]);

    await registered.get("spike_begin_step")!.execute("call", { step: "implement", goalId: "goal-1", changeId: "001" }, undefined, undefined, context);
    expect(calls[0]!.args).toEqual(["guidance", "show", "--step", "implement", "--goal", "goal-1", "--change", "001"]);
    await expect(registered.get("spike_issue_review")!.execute("call", {
      ...ticket,
      producingImplementationTicketId: "001",
    }, undefined, undefined, context)).rejects.toThrow("Call spike_begin_step for review on goal-1/001");
    expect(calls).toHaveLength(1);

    await registered.get("spike_issue_implement")!.execute("call", ticket, undefined, undefined, context);
    expect(calls[1]!.args.slice(0, 2)).toEqual(["ticket", "issue"]);
    await expect(registered.get("spike_issue_implement")!.execute("call", ticket, undefined, undefined, context))
      .rejects.toThrow("Call spike_begin_step");
    expect(calls).toHaveLength(2);

    await registered.get("spike_begin_step")!.execute("call", { step: "plan", goalId: "goal-1" }, undefined, undefined, context);
    await handlers.get("session_start")!({}, context);
    await expect(registered.get("spike_revise_plan")!.execute("call", {
      goalId: "goal-1",
      body: "# Restarted\n",
    }, undefined, undefined, context)).rejects.toThrow("Call spike_begin_step for plan on goal-1");
    expect(calls.at(-1)!.args).toEqual(["status"]);
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
