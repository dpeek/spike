import { afterEach, describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { publishImplementationReport } from "../../src/report.ts";
import { issueTicket } from "../../src/ticket.ts";
import { dispatchLocalImplementation } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void>; git: (...args: string[]) => Promise<string> }> = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const extensionUrl = pathToFileURL(`${import.meta.dir}/../../src/pi-worker-extension.ts`).href;
const worker = `
import { writeFile } from "node:fs/promises";
import { registerWorkerExtension } from ${JSON.stringify(extensionUrl)};
const tools = [];
registerWorkerExtension({ registerTool: (tool) => tools.push(tool) });
if (tools.length !== 1 || tools[0].name !== "spike_complete_implementation") {
  throw new Error("implementation completion tool was not selected");
}
await writeFile("pi-completed.txt", "completed through the Pi extension\\n");
const result = await tools[0].execute("completion-1", {
  summary: "Completed through the Pi extension.",
  verification: "The focused extension scenario passed.",
  assumptions: "None.",
  limitations: "None.",
  risks: "None.",
  followUp: "Review independently.",
  artifacts: [],
}, undefined, undefined, { cwd: process.cwd() });
if (result.terminate !== true) throw new Error("accepted completion did not terminate the agent turn");
`;

describe("Pi worker completion boundary", () => {
  test("produces a publishable implementation exchange through only the terminating tool", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Complete a Ticket through Pi",
      outcome: "Produce canonical exchange output through the worker extension.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root,
      goalId,
      title: "Add Pi completion evidence",
      intent: "Exercise the Node-compatible worker boundary.",
      rationale: "Workers should not format workflow documents or Git bundles.",
      acceptanceCriteria: ["The accepted completion produces a publishable Candidate."],
    });
    const issued = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Implement and complete through the role-specific Pi tool.",
      executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
    });

    const dispatched = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: issued.ticket.metadata.ticketId,
      worker: "scripted-pi-extension-worker",
      command: ["bun", "-e", worker],
    });
    expect(dispatched.execution.exitCode).toBe(0);
    expect(dispatched.execution.stderr).toBe("");

    const published = await publishImplementationReport({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      execution: dispatched.execution,
      commitMessage: { summary: "Add Pi completion evidence" },
    });

    expect(published.report.metadata.outcome).toBe("completed");
    expect(await repository.git("show", `${published.report.metadata.candidateRevision}:pi-completed.txt`))
      .toBe("completed through the Pi extension");
  });
});
