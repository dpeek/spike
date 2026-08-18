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

function captureTool(role: "implement" | "review", complete?: RegisterWorkerExtensionOptions["complete"]) {
  const tools: Array<Parameters<WorkerExtensionApi["registerTool"]>[0]> = [];
  registerWorkerExtension({ registerTool: (tool) => tools.push(tool) }, {
    role,
    ...(complete === undefined ? {} : { complete }),
  });
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

describe("Pi worker extension", () => {
  test("registers only the role-specific terminating implementation tool", async () => {
    const completion = {
      goalId: "goal-1",
      changeId: "001",
      ticketId: "001",
      role: "implement" as const,
      workerRevision: "a".repeat(40),
      artifacts: [],
    };
    let received: unknown;
    const tool = captureTool("implement", async (input) => {
      received = input;
      return completion;
    });

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
    const result = await tool.execute("call-1", payload, undefined, undefined, { cwd: "/worker/repository" });

    expect(received).toEqual({ cwd: "/worker/repository", payload });
    expect(result).toEqual({
      content: [{ type: "text", text: "Spike accepted implement Ticket goal-1/001/001." }],
      details: completion,
      terminate: true,
    });
  });

  test("registers only the role-specific terminating review tool and remains retryable after rejection", async () => {
    const rejected = new Error("Spike rejected worker completion: every criterion must be assessed");
    let shouldReject = false;
    const tool = captureTool("review", async () => {
      if (shouldReject) throw rejected;
      return {
        goalId: "goal-1",
        changeId: "001",
        ticketId: "002",
        role: "review",
        reviewedRevision: "b".repeat(40),
        artifacts: [],
      };
    });

    expect(tool.name).toBe("spike_complete_review");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["reviewStatement", "findings", "acceptanceAssessment", "verdict", "artifacts"],
    });
    expect((await tool.execute("call-2", {}, undefined, undefined, { cwd: "/worker/repository" })).terminate).toBe(true);
    shouldReject = true;
    await expect(tool.execute("call-3", {}, undefined, undefined, { cwd: "/worker/repository" })).rejects.toBe(rejected);
  });

  test("rejects a completion response for a different Ticket role", async () => {
    const tool = captureTool("review", async () => ({
      goalId: "goal-1",
      changeId: "001",
      ticketId: "002",
      role: "implement",
      artifacts: [],
    }));

    await expect(tool.execute("call-3", {}, undefined, undefined, { cwd: "/worker/repository" })).rejects.toThrow(
      "Spike completed a different Ticket role",
    );
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
printf '%s\\n' '{"ok":true,"command":"worker complete","data":{"goalId":"goal-1","changeId":"001","ticketId":"001","role":"implement","workerRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","artifacts":[]}}'
`);
    await chmod(executable, 0o700);
    const payload = { summary: "Delegated without formatting durable files." };

    const result = await runWorkerCompletion({
      cwd: directory,
      payload,
      command: executable,
      environment: { ...process.env, SPIKE_FAKE_PAYLOAD: payloadPath },
    });

    expect(JSON.parse(await readFile(payloadPath, "utf8"))).toEqual(payload);
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

    await expect(runWorkerCompletion({ cwd: directory, payload: {}, command: executable })).rejects.toThrow(
      "Spike rejected worker completion: Submission is invalid",
    );
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' 'not-json'\n");
    await expect(runWorkerCompletion({ cwd: directory, payload: {}, command: executable })).rejects.toThrow(
      "Spike worker completion returned invalid JSON",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(runWorkerCompletion({
      cwd: directory,
      payload: {},
      command: executable,
      signal: controller.signal,
    })).rejects.toThrow("Spike worker completion was cancelled");
  });
});
