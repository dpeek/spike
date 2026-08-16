import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateGoal, issueTicket, loadActiveGoal, loadWorkflowState } from "../src/goals.ts";
import { dispatchTicket, writeAgentState, type AgentState, type DispatchLaunchRequest } from "../src/runs.ts";
import { acceptTicket, migrateBootstrap, ticketHistory, workflowDoctor } from "../src/workflow.ts";
import { ticketResultPath } from "../src/workflow-state.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function execute(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function must(command: string[], cwd: string): Promise<string> {
  const result = await execute(command, cwd);
  if (result.code) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

type Fixture = { root: string; goalId: string; base: string; ticketId: string; stateDir: string };
async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-workflow-")));
  temporaryDirectories.push(root);
  await must(["git", "init", "-b", "main"], root);
  await must(["git", "config", "user.name", "Spike Test"], root);
  await must(["git", "config", "user.email", "spike@example.test"], root);
  await mkdir(join(root, "doc"), { recursive: true });
  await writeFile(join(root, "doc", "goal.md"), "# Goal\n");
  await writeFile(join(root, ".gitignore"), ".pi-swarm/\n");
  await must(["git", "add", "."], root);
  await must(["git", "commit", "-m", "base"], root);
  const goal = await activateGoal({ cwd: root, goalFile: "doc/goal.md", approvalStatement: "approved", now: new Date("2026-01-01T00:00:00.000Z") });
  const ticketPath = join(root, ".pi-swarm", "drafts", "ticket.md");
  await mkdir(dirname(ticketPath), { recursive: true });
  await writeFile(ticketPath, "# Ticket\n\nImplement it.\n");
  const ticket = await issueTicket({ cwd: root, ticketFile: ticketPath, now: new Date("2026-01-02T00:00:00.000Z") });
  return { root, goalId: goal.record.goalId, base: ticket.record.baseRevision, ticketId: ticket.record.ticketId, stateDir: join(root, ".pi-swarm") };
}
async function commit(item: Fixture, name: string): Promise<string> {
  await writeFile(join(item.root, `${name}.txt`), `${name}\n`);
  await must(["git", "add", `${name}.txt`], item.root);
  await must(["git", "commit", "-m", name], item.root);
  return must(["git", "rev-parse", "HEAD"], item.root);
}

function agent(item: Fixture, request: DispatchLaunchRequest): AgentState {
  return {
    schemaVersion: 1, name: request.workerName, slug: request.workerSlug, project: item.root.split("/").at(-1)!, runtime: "apple",
    container: "container", workspaceVolume: "volume", network: "network", containerPort: 3000, backend: "herdr",
    goalId: request.goalId, ticketId: request.ticketId, runId: request.runId, baseRevision: request.baseRevision,
    lifecycle: "running", startedAt: "2026-01-03T00:00:00.000Z", pid: 123,
  };
}

describe("durable ticket acceptance", () => {
  test("advances workflow state, is idempotent, records ordered history, and permits the next ticket", async () => {
    const item = await fixture();
    const head = await commit(item, "accepted");
    const first = await acceptTicket({ cwd: item.root, revision: head, review: "planner", statement: "reviewed", now: new Date("2026-01-04T00:00:00.000Z") });
    expect(first.idempotent).toBe(false);
    expect((await loadActiveGoal(item.root)).record.acceptedCodeRevision).toBe(head);
    expect((await loadWorkflowState(item.root)).activeTicketId).toBeNull();
    const duplicate = await acceptTicket({ cwd: item.root, revision: head, review: "planner", statement: "reviewed" });
    expect(duplicate.idempotent).toBe(true);
    await expect(acceptTicket({ cwd: item.root, revision: head, review: "hunk" })).rejects.toThrow("conflicting");

    const nextPath = join(item.root, ".pi-swarm", "drafts", "next.md");
    await writeFile(nextPath, "# Next\n");
    const next = await issueTicket({ cwd: item.root, ticketFile: nextPath, now: new Date("2026-01-05T00:00:00.000Z") });
    expect(next.record.baseRevision).toBe(head);
    const history = await ticketHistory(item.root);
    expect(history.map((entry) => entry.status)).toEqual(["accepted", "ready"]);
    expect(history.map((entry) => entry.ticket.ticketId)).toEqual([item.ticketId, next.record.ticketId]);
    expect((await workflowDoctor(item.root)).ok).toBe(true);
  });

  test("refuses equal/non-descendant commits and a nonterminal durable run", async () => {
    const equal = await fixture();
    await expect(acceptTicket({ cwd: equal.root, revision: equal.base, review: "planner" })).rejects.toThrow("must differ");
    const unrelated = await must(["git", "commit-tree", `${equal.base}^{tree}`, "-m", "unrelated"], equal.root);
    await expect(acceptTicket({ cwd: equal.root, revision: unrelated, review: "planner" })).rejects.toThrow("not a descendant");

    const running = await fixture();
    const head = await commit(running, "work");
    await dispatchTicket({ cwd: running.root, workerName: "worker", launcher: async (request) => {
      await writeAgentState(running.stateDir, agent(running, request));
      return { runtime: "apple", container: "container" };
    }});
    await expect(acceptTicket({ cwd: running.root, revision: head, review: "planner" })).rejects.toThrow("nonterminal");
  });

  test("recovers a validated acceptance interrupted after immutable result creation", async () => {
    const item = await fixture();
    const head = await commit(item, "recover");
    await expect(acceptTicket({
      cwd: item.root, revision: head, review: "hunk", now: new Date("2026-01-04T00:00:00.000Z"),
      afterResultWritten: () => { throw new Error("simulated interruption"); },
    })).rejects.toThrow("simulated interruption");
    expect(await Bun.file(ticketResultPath(item.root, item.goalId, item.ticketId)).exists()).toBe(true);
    const recovered = await loadActiveGoal(item.root);
    expect(recovered.record.acceptedCodeRevision).toBe(head);
    expect((await loadWorkflowState(item.root)).activeTicketId).toBeNull();
    expect((await acceptTicket({ cwd: item.root, revision: head, review: "hunk" })).idempotent).toBe(true);
  });
});

describe("bootstrap migration and doctor", () => {
  test("dry-run is deterministic/read-only, apply imports verifiable evidence, archives sources, and is idempotent", async () => {
    const item = await fixture();
    // This fixture models a bootstrap project before its generated ready ticket:
    // retain the generated ticket files but reset its explicit workflow order.
    const workflowPath = join(item.root, `.pi-swarm/goals/${item.goalId}/workflow.v1.json`);
    const state = JSON.parse(await readFile(workflowPath, "utf8"));
    state.activeTicketId = null;
    state.ticketOrder = [];
    await writeFile(workflowPath, `${JSON.stringify(state, null, 2)}\n`);
    await rm(join(item.root, `.pi-swarm/goals/${item.goalId}/active-ticket.json`));
    const accepted = await commit(item, "bootstrap-accepted");
    const legacy = join(item.root, ".pi-swarm", "goals", "001");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "ticket.md"), "# Bootstrap ticket\n");
    await writeFile(join(legacy, "approval.md"), "Approved bootstrap goal.\n");
    await writeFile(join(legacy, "migration.v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      goalId: item.goalId,
      tickets: [{ snapshotPath: ".pi-swarm/goals/001/ticket.md", baseRevision: item.base, acceptedRevision: accepted,
        issuedAt: "2026-01-02T00:00:00.000Z", acceptedAt: "2026-01-03T00:00:00.000Z", review: "planner", statement: "accepted bootstrap" }],
      archivePaths: [".pi-swarm/goals/001"],
    }, null, 2)}\n`);
    const before = await readFile(workflowPath);
    const dryOne = await migrateBootstrap({ cwd: item.root });
    const dryTwo = await migrateBootstrap({ cwd: item.root });
    expect(dryOne).toEqual(dryTwo);
    expect(dryOne.applicable).toBe(true);
    expect(await readFile(workflowPath)).toEqual(before);

    const applied = await migrateBootstrap({ cwd: item.root, apply: true, now: new Date("2026-01-06T00:00:00.000Z") });
    expect(applied.applied).toBe(true);
    expect(await Bun.file(join(item.root, ".pi-swarm", "goals", "001")).exists()).toBe(false);
    expect(await Bun.file(join(item.root, ".pi-swarm", "archive", "bootstrap-001", "001", "approval.md")).exists()).toBe(true);
    expect((await ticketHistory(item.root)).at(-1)?.status).toBe("migrated");
    expect((await loadActiveGoal(item.root)).record.acceptedCodeRevision).toBe(accepted);
    expect((await migrateBootstrap({ cwd: item.root, apply: true })).applied).toBe(true);
    expect((await workflowDoctor(item.root)).ok).toBe(true);
  });

  test("doctor detects snapshot tampering", async () => {
    const item = await fixture();
    await writeFile(join(item.root, `.pi-swarm/goals/${item.goalId}/tickets/${item.ticketId}/ticket.md`), "tampered\n");
    const report = await workflowDoctor(item.root);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("integrity");
  });
});
