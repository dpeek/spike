import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, loadChangeDecision } from "./change.ts";
import { createGoal } from "./goal.ts";
import { loadPlan } from "./plan.ts";
import { issueTicket } from "./ticket.ts";
import { workerRecordPath } from "./worker.ts";
import { usage, version } from "./cli.ts";
import { temporaryRepository } from "../test/support/repository.ts";

const root = join(import.meta.dir, "..");
const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(async (repository) => {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }));
});

async function spikeAt(cwd: string, args: string[], stdin?: string) {
  const process = Bun.spawn([join(root, "bin", "spike"), ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    process.stdin!.write(stdin);
    process.stdin!.end();
  }
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

function spike(...args: string[]) {
  return spikeAt(root, args);
}

describe("spike CLI", () => {
  test("shows help", async () => {
    const result = await spike("--help");
    expect(result).toEqual({ exitCode: 0, stdout: usage(), stderr: "" });
  });

  test("shows version", async () => {
    const result = await spike("--version");
    expect(result).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  });

  test("rejects unknown commands", async () => {
    const result = await spike("goal", "unknown");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("spike: unknown command: goal unknown\n");
  });

  test("emits one stable JSON object for success and failure", async () => {
    const status = await spike("status", "--json");
    expect(status.exitCode).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(status.stdout)).toEqual({
      ok: true,
      command: "status",
      data: { root, goals: [], cleanup: { healthy: true, warnings: [] } },
    });

    const failed = await spike("change", "reject", "--json");
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toBe("");
    expect(JSON.parse(failed.stdout)).toEqual({
      ok: false,
      command: "change reject",
      error: { code: "usage", message: "--goal is required" },
    });

    const duplicate = await spike("status", "--json", "--json");
    expect(duplicate.exitCode).toBe(2);
    expect(duplicate.stderr).toBe("");
    expect(JSON.parse(duplicate.stdout)).toEqual({
      ok: false,
      command: "status",
      error: { code: "usage", message: "--json may be specified only once" },
    });
  });

  test("revises the Plan from a user file or stdin without changing the source file", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Operate through the CLI",
      outcome: "Revise planner working memory.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const sourcePath = join(repository.root, "operator-plan.md");
    const fileBody = "# Revised Plan\n\nKeep immutable evidence.\n";
    await writeFile(sourcePath, fileBody);

    const fromFile = await spikeAt(repository.root, ["plan", "revise", "--goal", goalId, "--file", "operator-plan.md", "--json"]);
    expect(fromFile.exitCode).toBe(0);
    expect(JSON.parse(fromFile.stdout)).toMatchObject({
      ok: true,
      command: "plan revise",
      data: { body: fileBody },
    });
    expect(await readFile(sourcePath, "utf8")).toBe(fileBody);
    expect((await loadPlan(repository.root, goalId)).body).toBe(fileBody);

    const stdinBody = "# Revised Again\n\nRead from stdin.\n";
    const fromStdin = await spikeAt(repository.root, ["plan", "revise", "--goal", goalId, "--json"], stdinBody);
    expect(fromStdin.exitCode).toBe(0);
    expect(JSON.parse(fromStdin.stdout)).toMatchObject({ ok: true, command: "plan revise", data: { body: stdinBody } });
    expect((await loadPlan(repository.root, goalId)).body).toBe(stdinBody);
  });

  test("dispatches with frozen Ticket execution policy and publishes failure evidence after exit", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Publish direct failure evidence",
      outcome: "Seal a failed controlled worker execution.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root,
      goalId,
      title: "Exercise failed publication",
      intent: "Preserve execution evidence between CLI processes.",
      rationale: "Publication must not depend on a live worker.",
      acceptanceCriteria: ["The failed Report records the frozen model selection."],
    });
    await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Exit with a controlled failure.",
      executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
      model: "frozen-model",
      thinking: "low",
    });
    await writeFile(
      join(repository.root, "spike.json"),
      '{"models":{"planner":{"model":"changed","thinking":"minimal"},"implement":{"model":"changed","thinking":"minimal"},"review":{"model":"changed","thinking":"minimal"}}}\n',
    );

    const rejectedOverride = await spikeAt(repository.root, [
      "ticket", "dispatch-test", "--goal", goalId, "--change", "001", "--ticket", "001",
      "--worker", "scripted-failure", "--model", "dispatch-override", "--json", "--", "bun", "-e", "process.exit(19)",
    ]);
    expect(rejectedOverride.exitCode).toBe(2);
    expect(JSON.parse(rejectedOverride.stdout)).toEqual({
      ok: false,
      command: "ticket dispatch-test",
      error: { code: "usage", message: "unknown option: --model" },
    });

    const dispatched = await spikeAt(repository.root, [
      "ticket", "dispatch-test", "--goal", goalId, "--change", "001", "--ticket", "001",
      "--worker", "scripted-failure", "--json", "--", "bun", "-e",
      'if (process.env.SPIKE_MODEL !== "frozen-model" || process.env.SPIKE_THINKING !== "low") process.exit(99); console.log("controlled failure"); process.exit(19)',
    ]);
    expect(dispatched.exitCode).toBe(0);
    expect(dispatched.stderr).toBe("");
    expect(JSON.parse(dispatched.stdout)).toMatchObject({
      ok: true,
      command: "ticket dispatch-test",
      data: {
        execution: {
          worker: "scripted-failure",
          model: "frozen-model",
          thinking: "low",
          exitCode: 19,
          stdout: "controlled failure\n",
        },
      },
    });
    const identity = { goalId, changeId: "001", ticketId: "001" };
    expect(await Bun.file(workerRecordPath(repository.root, identity)).exists()).toBe(true);

    const published = await spikeAt(repository.root, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "001",
      "--failure", "Controlled worker exited with code 19.", "--json",
    ]);
    expect(published.exitCode).toBe(0);
    expect(published.stderr).toBe("");
    expect(JSON.parse(published.stdout)).toMatchObject({
      ok: true,
      command: "report publish",
      data: {
        report: {
          role: "implement",
          outcome: "failed",
          execution: { worker: "scripted-failure", model: "frozen-model", thinking: "low" },
        },
        cleanup: { status: "finalized" },
      },
    });
    expect(await Bun.file(workerRecordPath(repository.root, identity)).exists()).toBe(false);
  });

  test("delegates abandonment and repository recovery to workflow modules", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const goal = await createGoal({
      cwd: repository.root,
      title: "Resolve a Change",
      outcome: "Preserve its terminal decision.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root,
      goalId,
      title: "Abandon this direction",
      intent: "Exercise the terminal command.",
      rationale: "The planner changed direction.",
      acceptanceCriteria: ["The decision remains immutable."],
    });

    const rejected = await spikeAt(repository.root, [
      "change", "reject", "--goal", goalId, "--change", "001", "--statement", "Reject this direction.", "--json",
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      command: "change reject",
      error: { code: "workflow", message: `Change ${goalId}/001 has no completed implementation Candidate` },
    });

    const abandoned = await spikeAt(repository.root, [
      "change", "abandon", "--goal", goalId, "--change", "001", "--statement", "Operator changed direction.", "--json",
    ]);
    expect(abandoned.exitCode).toBe(0);
    expect(JSON.parse(abandoned.stdout)).toMatchObject({
      ok: true,
      command: "change abandon",
      data: { goalId, changeId: "001", disposition: "abandon", statement: "Operator changed direction." },
    });
    expect((await loadChangeDecision(repository.root, goalId, "001")).metadata.disposition).toBe("abandon");

    const recovered = await spikeAt(repository.root, ["recover", "--json"]);
    expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      command: "recover",
      data: { goals: [{ goalId, cleanupWarnings: [] }], ignoredUnpublishedGoalIds: [] },
    });
  });
});
