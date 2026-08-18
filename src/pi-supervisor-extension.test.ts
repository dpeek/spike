import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSupervisorExtension,
  runSpikeJson,
  supervisorToolNames,
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
  registerSupervisorExtension({ registerTool: (tool) => tools.push(tool) }, { command, environment });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

describe("Pi supervisor extension", () => {
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
    expect(invocations).toHaveLength(8);
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
    expect(invocations[6].args.slice(0, 2)).toEqual(["report", "publish"]);
    expect(invocations[7].args).toEqual([
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
