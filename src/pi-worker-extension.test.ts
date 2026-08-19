import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorkerExtension,
  runWorkerCompletion,
  type RegisterWorkerExtensionOptions,
  type WorkerExtensionApi,
} from "./pi-worker-extension.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function captureTools(role: "implement" | "review", options: RegisterWorkerExtensionOptions = {}) {
  const tools: Array<Parameters<WorkerExtensionApi["registerTool"]>[0]> = [];
  registerWorkerExtension({ registerTool: (tool) => tools.push(tool) }, { role, ...options });
  expect(tools).toHaveLength(2);
  return tools;
}

function namedTool(
  tools: ReturnType<typeof captureTools>,
  name: string,
): ReturnType<typeof captureTools>[number] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("Pi worker extension", () => {
  test("registers the role-specific terminating implementation completion tool", async () => {
    const completion = {
      goalId: "goal-1",
      changeId: "001",
      ticketId: "001",
      role: "implement" as const,
      outcome: "completed" as const,
      workerRevision: "a".repeat(40),
      artifacts: [],
    };
    let received: unknown;
    const tool = namedTool(captureTools("implement", { complete: async (input) => {
      received = input;
      return completion;
    } }), "spike_complete_implementation");

    expect(tool.name).toBe("spike_complete_implementation");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["summary", "verification", "assumptions", "limitations", "risks", "followUp", "artifacts"],
    });
    const payload = {
      summary: "Implemented the Ticket.",
      verification: "Checks pass.",
      assumptions: "None.",
      limitations: "None.",
      risks: "None.",
      followUp: "Review independently.",
      artifacts: [],
    };
    let shutdowns = 0;
    const result = await tool.execute("call-1", payload, undefined, undefined, {
      cwd: "/worker/repository",
      model: { provider: "openai-codex", id: "gpt-5.6-terra" },
      thinkingLevel: "medium",
      shutdown: () => shutdowns++,
    });

    expect(shutdowns).toBe(1);
    expect(received).toEqual({
      cwd: "/worker/repository",
      payload,
      actualModel: "openai-codex/gpt-5.6-terra",
      actualThinking: "medium",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Spike accepted implement Ticket goal-1/001/001." }],
      details: completion,
      terminate: true,
    });
  });

  test("registers a role-specific blocked tool that terminates without completion evidence", async () => {
    const blocked = {
      goalId: "goal-1",
      changeId: "001",
      ticketId: "001",
      role: "implement" as const,
      outcome: "blocked" as const,
      artifacts: [],
    };
    let received: unknown;
    const tool = namedTool(captureTools("implement", { block: async (input) => {
      received = input;
      return blocked;
    } }), "spike_block_implementation");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["reason", "evidence", "artifacts"],
    });
    const payload = { reason: "Docker is unavailable.", evidence: "docker info exited 1.", artifacts: [] };
    let shutdowns = 0;
    const result = await tool.execute("blocked-1", payload, undefined, undefined, {
      cwd: "/worker/repository",
      model: { provider: "openai-codex", id: "gpt-5.6-terra" },
      thinkingLevel: "medium",
      shutdown: () => shutdowns++,
    });
    expect(received).toMatchObject({ payload, actualModel: "openai-codex/gpt-5.6-terra", actualThinking: "medium" });
    expect(result.details).toEqual(blocked);
    expect(result.terminate).toBe(true);
    expect(shutdowns).toBe(1);
  });

  test("registers the role-specific review completion tool and remains retryable after rejection", async () => {
    const rejected = new Error("Spike rejected worker completion: every criterion must be assessed");
    let shouldReject = true;
    const tool = namedTool(captureTools("review", { complete: async () => {
      if (shouldReject) throw rejected;
      return {
        goalId: "goal-1",
        changeId: "001",
        ticketId: "002",
        role: "review",
        outcome: "completed",
        reviewedRevision: "b".repeat(40),
        artifacts: [],
      };
    } }), "spike_complete_review");

    expect(tool.name).toBe("spike_complete_review");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["reviewStatement", "findings", "acceptanceAssessment", "verdict", "artifacts"],
    });
    let shutdowns = 0;
    const context = {
      cwd: "/worker/repository",
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "high" as const,
      shutdown: () => shutdowns++,
    };
    await expect(tool.execute("call-2", {}, undefined, undefined, context)).rejects.toBe(rejected);
    expect(shutdowns).toBe(0);

    shouldReject = false;
    expect((await tool.execute("call-3", {}, undefined, undefined, context)).terminate).toBe(true);
    expect(shutdowns).toBe(1);
  });

  test("rejects a completion response for a different Ticket role", async () => {
    const tool = namedTool(captureTools("review", { complete: async () => ({
      goalId: "goal-1",
      changeId: "001",
      ticketId: "002",
      role: "implement",
      outcome: "completed",
      artifacts: [],
    }) }), "spike_complete_review");

    await expect(tool.execute("call-3", {}, undefined, undefined, {
      cwd: "/worker/repository",
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinkingLevel: "high",
      shutdown: () => undefined,
    })).rejects.toThrow("Spike completed a different Ticket role or outcome");
  });

  test("delegates JSON to the Spike CLI process and parses its stable success response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spike-pi-extension-"));
    directories.push(directory);
    const executable = join(directory, "fake-spike");
    const payloadPath = join(directory, "payload.json");
    await writeFile(executable, `#!/bin/sh
set -eu
[ "$1" = worker ] && [ "$2" = complete ] && [ "$3" = --json ]
cat > "$SPIKE_FAKE_PAYLOAD"
printf '%s' "$SPIKE_ACTUAL_MODEL/$SPIKE_ACTUAL_THINKING" > "$SPIKE_FAKE_SELECTION"
printf '%s\\n' '{"ok":true,"command":"worker complete","data":{"goalId":"goal-1","changeId":"001","ticketId":"001","role":"implement","outcome":"completed","workerRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","artifacts":[]}}'
`);
    await chmod(executable, 0o700);
    const payload = { summary: "Delegated without formatting durable files." };

    const result = await runWorkerCompletion({
      cwd: directory,
      payload,
      command: executable,
      actualModel: "openai-codex/gpt-5.6-terra",
      actualThinking: "medium",
      environment: {
        ...process.env,
        SPIKE_FAKE_PAYLOAD: payloadPath,
        SPIKE_FAKE_SELECTION: join(directory, "selection.txt"),
      },
    });

    expect(JSON.parse(await readFile(payloadPath, "utf8"))).toEqual(payload);
    expect(await readFile(join(directory, "selection.txt"), "utf8")).toBe("openai-codex/gpt-5.6-terra/medium");
    expect(result).toMatchObject({ goalId: "goal-1", changeId: "001", ticketId: "001", role: "implement" });
  });

  test("surfaces structured Spike rejection and cancellation without a success result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spike-pi-extension-"));
    directories.push(directory);
    const executable = join(directory, "fake-spike");
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' '{"ok":false,"command":"worker complete","error":{"code":"workflow","message":"Submission is invalid"}}'
exit 1
`);
    await chmod(executable, 0o700);

    const selection = {
      actualModel: "openai-codex/gpt-5.6-terra",
      actualThinking: "medium" as const,
    };
    await expect(runWorkerCompletion({ cwd: directory, payload: {}, command: executable, ...selection })).rejects.toThrow(
      "Spike rejected worker completion: Submission is invalid",
    );
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' 'not-json'\n");
    await expect(runWorkerCompletion({ cwd: directory, payload: {}, command: executable, ...selection })).rejects.toThrow(
      "Spike worker completion returned invalid JSON",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(runWorkerCompletion({
      cwd: directory,
      payload: {},
      command: executable,
      ...selection,
      signal: controller.signal,
    })).rejects.toThrow("Spike worker completion was cancelled");
  });
});
