import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange, loadChangeDecision } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { loadPlan } from "../../src/plan.ts";
import { issueTicket } from "../../src/ticket.ts";
import { workerRecordPath } from "../../src/worker.ts";
import { usage, version } from "../../src/cli.ts";
import { fixtureGuidance, temporaryRepository } from "../support/repository.ts";

const root = join(import.meta.dir, "..", "..");


async function spikeAt(cwd: string, args: string[], stdin?: string, env?: NodeJS.ProcessEnv) {
  const child = Bun.spawn([join(root, "bin", "spike"), ...args], {
    cwd,
    env: env ?? { ...process.env },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    child.stdin!.write(stdin);
    child.stdin!.end();
  }
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

function spikeIn(repository: Awaited<ReturnType<typeof temporaryRepository>>, args: string[], stdin?: string, env?: NodeJS.ProcessEnv) {
  return spikeAt(repository.root, args, stdin, env ?? { ...process.env, SPIKE_DATA_DIR: repository.dataRoot });
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
    const repository = await temporaryRepository();
    const canonicalRoot = await realpath(repository.root);
    const status = await spikeIn(repository, ["status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(status.stdout)).toEqual({
      ok: true,
      command: "status",
      data: { root: canonicalRoot, project: { slug: "spike" }, goals: [], cleanup: { healthy: true, warnings: [] }, applicationQueue: [], queueHead: null },
    });

    const failed = await spikeIn(repository, ["change", "reject", "--json"]);
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toBe("");
    expect(JSON.parse(failed.stdout)).toEqual({
      ok: false,
      command: "change reject",
      error: { code: "usage", message: "--goal is required" },
    });

    const duplicate = await spikeIn(repository, ["status", "--json", "--json"]);
    expect(duplicate.exitCode).toBe(2);
    expect(duplicate.stderr).toBe("");
    expect(JSON.parse(duplicate.stdout)).toEqual({
      ok: false,
      command: "status",
      error: { code: "usage", message: "--json may be specified only once" },
    });
  });

  test("operates Request JSON commands outside Git with an isolated data root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spike-request-cwd-"));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "spike-request-data-")));
    try {
      const gitProbe = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], { cwd, stdout: "pipe", stderr: "pipe" });
      expect(await gitProbe.exited).not.toBe(0);
      const env = { ...process.env, SPIKE_DATA_DIR: dataRoot };

      const create = await spikeAt(cwd, ["request", "create", "--title", "Outside Git", "--statement", "Keep this work.", "--project", "spike", "--json"], undefined, env);
      expect(create).toMatchObject({ exitCode: 0, stderr: "" });
      const created = JSON.parse(create.stdout);
      expect(created).toEqual({
        ok: true,
        command: "request create",
        data: expect.objectContaining({
          metadata: expect.objectContaining({ requestId: "request-001", projects: ["spike"] }),
          body: "# Outside Git\n\nKeep this work.\n",
          state: "open",
          closure: null,
        }),
      });

      const listed = await spikeAt(cwd, ["request", "list", "--json"], undefined, env);
      expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(listed.stdout)).toEqual({
        ok: true,
        command: "request list",
        data: [{ metadata: created.data.metadata, title: "Outside Git", state: "open" }],
      });

      const shown = await spikeAt(cwd, ["request", "show", "--request", "request-001", "--json"], undefined, env);
      expect(shown).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(shown.stdout)).toEqual({ ok: true, command: "request show", data: created.data });

      const closed = await spikeAt(cwd, ["request", "close", "--request", "request-001", "--disposition", "addressed", "--statement", "Completed outside Git.", "--json"], undefined, env);
      expect(closed).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(closed.stdout)).toEqual({
        ok: true,
        command: "request close",
        data: expect.objectContaining({
          metadata: created.data.metadata,
          state: "closed",
          closure: expect.objectContaining({
            metadata: expect.objectContaining({ requestId: "request-001", disposition: "addressed" }),
            body: "Completed outside Git.\n",
          }),
        }),
      });

      expect(await Bun.file(join(dataRoot, "requests", "request-001", "request.md")).exists()).toBe(true);
      expect(await Bun.file(join(dataRoot, "requests", "request-001", "closure.md")).exists()).toBe(true);
      const closedList = await spikeAt(cwd, ["request", "list", "--closed", "--json"], undefined, env);
      expect(JSON.parse(closedList.stdout)).toEqual({
        ok: true,
        command: "request list",
        data: [{ metadata: created.data.metadata, title: "Outside Git", state: "closed" }],
      });
      const humanList = await spikeAt(cwd, ["request", "list", "--closed"], undefined, env);
      expect(humanList.stdout).toBe("request-001 Outside Git closed spike\n");
      expect(await Bun.file(join(cwd, ".git")).exists()).toBe(false);
    } finally {
      await Promise.all([rm(cwd, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]);
    }
  });

  test("shows exact committed guidance with its selected source revision", async () => {
    const repository = await temporaryRepository();

    const shown = await spikeIn(repository, ["guidance", "show", "--step", "goal", "--json"]);
    expect(shown).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(shown.stdout)).toEqual({
      ok: true,
      command: "guidance show",
      data: {
        step: "goal",
        path: "spike/guidance/goal.md",
        sourceRevision: repository.head,
        markdown: fixtureGuidance.goal,
      },
    });

    const rejected = await spikeIn(repository, ["guidance", "show", "--step", "review", "--json"]);
    expect(rejected.exitCode).toBe(2);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      command: "guidance show",
      error: { code: "usage", message: "--goal is required for review guidance" },
    });
  });

  test("revises the Plan from a user file or stdin without changing the source file", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Operate through the CLI",
      outcome: "Revise planner working memory.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const sourcePath = join(repository.root, "operator-plan.md");
    const fileBody = "# Revised Plan\n\nKeep immutable evidence.\n";
    await writeFile(sourcePath, fileBody);

    const fromFile = await spikeIn(repository, ["plan", "revise", "--goal", goalId, "--file", "operator-plan.md", "--json"]);
    expect(fromFile.exitCode).toBe(0);
    expect(JSON.parse(fromFile.stdout)).toMatchObject({
      ok: true,
      command: "plan revise",
      data: { body: fileBody },
    });
    expect(await readFile(sourcePath, "utf8")).toBe(fileBody);
    expect((await loadPlan(repository.project, goalId)).body).toBe(fileBody);

    const stdinBody = "# Revised Again\n\nRead from stdin.\n";
    const fromStdin = await spikeIn(repository, ["plan", "revise", "--goal", goalId, "--json"], stdinBody);
    expect(fromStdin.exitCode).toBe(0);
    expect(JSON.parse(fromStdin.stdout)).toMatchObject({ ok: true, command: "plan revise", data: { body: stdinBody } });
    expect((await loadPlan(repository.project, goalId)).body).toBe(stdinBody);
  });

  test("dispatches with frozen Ticket execution policy and publishes failure evidence after exit", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Publish direct failure evidence",
      outcome: "Seal a failed controlled worker execution.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Exercise failed publication",
      intent: "Preserve execution evidence between CLI processes.",
      rationale: "Publication must not depend on a live worker.",
      acceptanceCriteria: ["The failed Report records the frozen model selection."],
    });
    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Exit with a controlled failure.",
      executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
      model: "frozen-model",
      thinking: "low",
    });
    await writeFile(
      join(repository.root, "spike.json"),
      // Dispatch must use the assignment frozen in Ticket 001, not attempt to
      // resolve these now-incomplete mutable agent defaults.
      '{"project":{"slug":"spike"},"agents":{"planner":{"model":"changed","thinking":"minimal"}}}\n',
    );

    const rejectedOverride = await spikeIn(repository, [
      "ticket", "dispatch-test", "--goal", goalId, "--change", "001", "--ticket", "001",
      "--worker", "scripted-failure", "--model", "dispatch-override", "--json", "--", "bun", "-e", "process.exit(19)",
    ]);
    expect(rejectedOverride.exitCode).toBe(2);
    expect(JSON.parse(rejectedOverride.stdout)).toEqual({
      ok: false,
      command: "ticket dispatch-test",
      error: { code: "usage", message: "unknown option: --model" },
    });

    const dispatched = await spikeIn(repository, [
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
    expect(await Bun.file(workerRecordPath(repository.project, identity)).exists()).toBe(true);

    const published = await spikeIn(repository, [
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
    expect(await Bun.file(workerRecordPath(repository.project, identity)).exists()).toBe(false);
  });

  test("delegates abandonment and repository recovery to workflow modules", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Resolve a Change",
      outcome: "Preserve its terminal decision.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Abandon this direction",
      intent: "Exercise the terminal command.",
      rationale: "The planner changed direction.",
      acceptanceCriteria: ["The decision remains immutable."],
    });

    const rejected = await spikeIn(repository, [
      "change", "reject", "--goal", goalId, "--change", "001", "--statement", "Reject this direction.", "--json",
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      command: "change reject",
      error: { code: "workflow", message: `Change ${goalId}/001 has no completed implementation Candidate` },
    });

    const abandoned = await spikeIn(repository, [
      "change", "abandon", "--goal", goalId, "--change", "001", "--statement", "Operator changed direction.", "--json",
    ]);
    expect(abandoned.exitCode).toBe(0);
    expect(JSON.parse(abandoned.stdout)).toMatchObject({
      ok: true,
      command: "change abandon",
      data: { goalId, changeId: "001", disposition: "abandon", statement: "Operator changed direction." },
    });
    expect((await loadChangeDecision(repository.project, goalId, "001")).metadata.disposition).toBe("abandon");

    const recovered = await spikeIn(repository, ["recover", "--json"]);
    expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      command: "recover",
      data: { goals: [{ goalId, cleanupWarnings: [] }], ignoredUnpublishedGoalIds: [] },
    });
  });

  test("creates zero-source Goals in the isolated Project root without Request-store access", async () => {
    const repository = await temporaryRepository();
    const env = { ...process.env, SPIKE_DATA_DIR: repository.dataRoot, XDG_DATA_HOME: "/dev/null/spike-request-store", HOME: "/dev/null/spike-home" };

    const created = await spikeIn(repository, ["goal", "create", "--title", "No requests", "--outcome", "Preserve central authority.", "--approval", "Approved.", "--json"], undefined, env);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, command: "goal create", data: { goal: { goalId: "spike-001" } } });
    expect(await Bun.file(join(repository.projectRoot, "goals", "spike-001", "goal.md")).exists()).toBe(true);
    expect(await Bun.file(join(repository.projectRoot, "goals", "spike-001", "plan.md")).exists()).toBe(true);
    expect(await Bun.file(join(repository.root, ".spike")).exists()).toBe(false);

    const refused = await spikeIn(repository, ["goal", "create", "--title", "With request", "--outcome", "Validate request root.", "--approval", "Approved.", "--request", "request-001", "--json"], undefined, env);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, command: "goal create", error: { code: "workflow", message: "Source Request does not exist: request-001" } });
    expect(await Bun.file(join(repository.projectRoot, "goals", "spike-002", "goal.md")).exists()).toBe(false);
    expect(await Bun.file(join(repository.projectRoot, "goals", "spike-002", "plan.md")).exists()).toBe(false);
  });

  test("creates cited Goals through CLI JSON and refuses duplicate source IDs without mutations", async () => {
    const repository = await temporaryRepository();
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "spike-goal-cli-data-")));
    try {
      const env = { ...process.env, SPIKE_DATA_DIR: dataRoot };
      const request = await spikeIn(repository, ["request", "create", "--title", "Source", "--statement", "Future work.", "--project", "spike", "--json"], undefined, env);
      const requestId = JSON.parse(request.stdout).data.metadata.requestId;
      const requestFile = await readFile(join(dataRoot, "requests", requestId, "request.md"), "utf8");
      const created = await spikeIn(repository, ["goal", "create", "--title", "Cite", "--outcome", "Keep provenance.", "--approval", "Approved.", "--request", requestId, "--json"], undefined, env);
      expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, command: "goal create", data: { goal: { goalId: "spike-001" } } });
      expect(await readFile(join(dataRoot, "projects", "spike", "goals", "spike-001", "goal.md"), "utf8")).toContain(`## Source Requests\n\n- ${requestId}`);
      const refused = await spikeIn(repository, ["goal", "create", "--title", "Duplicate", "--outcome", "Refuse.", "--approval", "Approved.", "--request", requestId, "--request", requestId, "--json"], undefined, env);
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, command: "goal create", error: { code: "workflow", message: `duplicate Source Request ID: ${requestId}` } });
      expect(await Bun.file(join(dataRoot, "projects", "spike", "goals", "spike-002", "goal.md")).exists()).toBe(false);
      expect(await Bun.file(join(dataRoot, "projects", "spike", "goals", "spike-002", "plan.md")).exists()).toBe(false);
      expect(await readFile(join(dataRoot, "requests", requestId, "request.md"), "utf8")).toBe(requestFile);
    } finally { await rm(dataRoot, { recursive: true, force: true }); }
  });
});
