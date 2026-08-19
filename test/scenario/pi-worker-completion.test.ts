import { afterEach, describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { loadReport, publishImplementationReport } from "../../src/report.ts";
import { deriveGoalStatus } from "../../src/status.ts";
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
const spikePath = `${import.meta.dir}/../../bin/spike`;
const blockedWorker = `
import { registerWorkerExtension } from ${JSON.stringify(extensionUrl)};
const tools = [];
registerWorkerExtension({ registerTool: (tool) => tools.push(tool) });
const blocked = tools.find((tool) => tool.name === "spike_block_implementation");
if (!blocked) throw new Error("implementation blocked tool was not selected");
let shutdowns = 0;
const result = await blocked.execute("blocked-1", {
  reason: "Required Docker daemon is unavailable.",
  evidence: "docker info exited with status 1.",
  artifacts: [],
}, undefined, undefined, {
  cwd: process.cwd(),
  model: { provider: "openai-codex", id: "gpt-5.6-terra" },
  thinkingLevel: "medium",
  shutdown: () => shutdowns++,
});
if (result.terminate !== true || shutdowns !== 1) throw new Error("accepted blocked outcome did not terminate");
`;

const worker = `
import { writeFile } from "node:fs/promises";
import { registerWorkerExtension } from ${JSON.stringify(extensionUrl)};
const tools = [];
registerWorkerExtension({ registerTool: (tool) => tools.push(tool) });
if (tools.length !== 2 || tools[0].name !== "spike_complete_implementation" || tools[1].name !== "spike_block_implementation") {
  throw new Error("implementation terminal tools were not selected");
}
await writeFile("pi-completed.txt", "completed through the Pi extension\\n");
let shutdowns = 0;
const result = await tools[0].execute("completion-1", {
  summary: "Completed through the Pi extension.",
  verification: "The focused extension scenario passed.",
  assumptions: "None.",
  limitations: "None.",
  risks: "None.",
  followUp: "Review independently.",
  artifacts: [],
}, undefined, undefined, {
  cwd: process.cwd(),
  model: { provider: "openai-codex", id: "gpt-5.6-terra" },
  thinkingLevel: "medium",
  shutdown: () => shutdowns++,
});
if (result.terminate !== true) throw new Error("accepted completion did not terminate the agent turn");
if (shutdowns !== 1) throw new Error("accepted completion did not request graceful shutdown");
`;

describe("Pi worker completion boundary", () => {
  test("rejects completion when Pi's observed selection differs from the Ticket assignment", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Verify actual Pi provenance",
      outcome: "Reject execution that does not match immutable Ticket provenance.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root,
      goalId,
      title: "Verify Pi selection",
      intent: "Compare observed execution with the Ticket assignment.",
      rationale: "Reports must record actual rather than requested model provenance.",
      acceptanceCriteria: ["Mismatched Pi execution cannot produce an accepted Submission."],
    });
    const issued = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Attempt completion with mismatched observed provenance.",
      executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
      model: "openai-codex/gpt-5.6-terra",
      thinking: "medium",
    });

    const dispatched = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: issued.ticket.metadata.ticketId,
      worker: "mismatched-pi-extension-worker",
      command: ["bun", "-e", worker.replace("gpt-5.6-terra", "gpt-5.6-sol")],
    });

    expect(dispatched.execution.exitCode).not.toBe(0);
    expect(dispatched.execution.stderr).toContain(
      "actual worker selection openai-codex/gpt-5.6-sol/medium does not match Ticket assignment openai-codex/gpt-5.6-terra/medium",
    );
    expect(await Bun.file(`${dispatched.exchange.outputDirectory}/submission.md`).exists()).toBe(false);
  });

  test("publishes a blocked implementation without a Candidate or repository bundle", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Report an implementation blocker",
      outcome: "Retain truthful blocked evidence without accepting partial work.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root,
      goalId,
      title: "Exercise blocked completion",
      intent: "Publish worker-authored blocked evidence.",
      rationale: "A blocker must not produce a Candidate.",
      acceptanceCriteria: ["Blocked implementation evidence produces no Candidate."],
    });
    await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Report the external Docker blocker.",
      executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
      model: "openai-codex/gpt-5.6-terra",
      thinking: "medium",
    });

    const dispatched = await dispatchLocalImplementation({
      cwd: repository.root,
      goalId,
      changeId: "001",
      ticketId: "001",
      worker: "blocked-pi-extension-worker",
      command: ["bun", "-e", blockedWorker],
    });
    expect(dispatched.execution.exitCode).toBe(0);
    expect(await Bun.file(`${dispatched.exchange.outputDirectory}/repository.bundle`).exists()).toBe(false);

    const publication = Bun.spawn([
      spikePath,
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "001", "--json",
    ], { cwd: repository.root, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      publication.exited,
      new Response(publication.stdout).text(),
      new Response(publication.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { report: { outcome: "blocked", role: "implement" } } });
    const report = await loadReport(repository.root, goalId, "001", "001");
    expect(report.body).toContain("Required Docker daemon is unavailable.");
    expect(report.metadata).not.toHaveProperty("candidateRevision");
    expect((await deriveGoalStatus(repository.root, goalId)).currentChange?.latestReport).toEqual({
      ticketId: "001",
      role: "implement",
      outcome: "blocked",
    });
  });

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
      model: "openai-codex/gpt-5.6-terra",
      thinking: "medium",
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
