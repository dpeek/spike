import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { activateGoal, issueTicket, loadActiveGoal, loadWorkflowState } from "../src/goals.ts";
import {
  completionReportStagingPath,
  dispatchTicket,
  importCompletionReport,
  readAgentState,
  recordAgentExit,
  requestAgentStop,
  writeAgentState,
  type AgentState,
  type DispatchLaunchRequest,
} from "../src/runs.ts";
import { acceptTicket, ticketHistory, workflowDoctor } from "../src/workflow.ts";
import { ticketResultPath } from "../src/workflow-state.ts";

const temporaryDirectories: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function execute(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
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

async function publishExplicit(item: Fixture, head: string, agent = "freeform-worker") {
  const directory = join(item.root, ".pi-swarm", "output", "branches", agent);
  await mkdir(directory, { recursive: true });
  const bundlePath = `.pi-swarm/output/branches/${agent}/${head}.bundle`;
  await must(["git", "bundle", "create", join(item.root, bundlePath), "main"], item.root);
  const importedRef = `refs/spike/agents/${agent}`;
  await must(["git", "update-ref", importedRef, head], item.root);
  const project = basename(item.root).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  const manifest = { schemaVersion: 1, project, agent, workerBranch: "main", base: item.base, head, importedRef, bundlePath, publishedAt: "2026-01-03T00:00:00.000Z" };
  await writeFile(join(directory, `${head}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function agent(item: Fixture, request: DispatchLaunchRequest): AgentState {
  return {
    schemaVersion: 1, name: request.workerName, slug: request.workerSlug, project: item.root.split("/").at(-1)!, runtime: "apple",
    container: "container", workspaceVolume: "volume", network: "network", containerPort: 3000, backend: "herdr",
    goalId: request.goalId, ticketId: request.ticketId, runId: request.runId, baseRevision: request.baseRevision,
    lifecycle: "running", startedAt: "2026-01-03T00:00:00.000Z", pid: 123,
  };
}

async function acceptedWorker(item: Fixture, name = "worker") {
  const head = await commit(item, `accepted-${name}`);
  const run = await dispatchTicket({ cwd: item.root, workerName: name, launcher: async (request) => {
    await writeAgentState(item.stateDir, {
      ...agent(item, request),
      container: `container-${request.workerSlug}`,
      workspaceVolume: `volume-${request.workerSlug}`,
      network: `network-${request.workerSlug}`,
      alias: `${request.workerSlug}.workflow-test`,
      herdrName: `herdr-${request.workerSlug}`,
      herdrTabId: `tab-${request.workerSlug}`,
      herdrPaneId: `pane-${request.workerSlug}`,
    });
    return { runtime: "apple", container: `container-${request.workerSlug}`, herdrName: `herdr-${request.workerSlug}`, herdrTabId: `tab-${request.workerSlug}`, herdrPaneId: `pane-${request.workerSlug}` };
  } });
  const running = (await readAgentState(item.stateDir, run.worker.slug))!;
  await publishExplicit(item, head, run.worker.slug);
  const staging = completionReportStagingPath(item.root, item.goalId, item.ticketId, run.runId);
  await writeFile(staging, `${JSON.stringify({
    schemaVersion: 1, goalId: item.goalId, ticketId: item.ticketId, runId: run.runId, worker: run.worker,
    baseRevision: item.base, resultingRevision: head, producedCommitIds: [head], dirtyWorktree: false,
    outcome: "completed", summary: `completed ${name}`, verification: [], services: [], artifacts: [], assumptions: [], limitations: [], risks: [],
    followUp: { state: "ready" }, createdAt: "2026-01-03T00:30:00.000Z",
  }, null, 2)}\n`);
  await importCompletionReport(item.root);
  await requestAgentStop({ cwd: item.root, name: run.worker.slug, requester: "cli", reason: "operator-requested", now: new Date("2026-01-03T01:00:00.000Z"), stopRuntime: async () => {} });
  await recordAgentExit({ cwd: item.root, state: running, exitCode: 143, now: new Date("2026-01-03T01:00:01.000Z") });
  const accepted = await acceptTicket({ cwd: item.root, revision: head, review: "planner", statement: `accepted ${name}`, now: new Date("2026-01-04T00:00:00.000Z") });
  return { run, head, result: accepted.result, slug: run.worker.slug };
}

async function installFinalizationFakes(root: string, state: AgentState, behavior: Partial<Record<"container" | "workspace" | "network" | "alias" | "herdr", "ok" | "absent" | "fail" | "fail-once">> = {}) {
  const fakeBin = join(root, "fake-bin");
  const logPath = join(root, "cleanup.log");
  const onceDir = join(root, "cleanup-once");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(onceDir, { recursive: true });
  const outcome = (name: string, mode: string | undefined, missing: string, failed: string) => {
    if (mode === "absent") return `echo ${JSON.stringify(missing)} >&2\nexit 1`;
    if (mode === "fail") return `echo ${JSON.stringify(failed)} >&2\nexit 1`;
    if (mode === "fail-once") return `if [ ! -f ${JSON.stringify(join(onceDir, name))} ]; then touch ${JSON.stringify(join(onceDir, name))}; echo ${JSON.stringify(failed)} >&2; exit 1; fi\nexit 0`;
    return "exit 0";
  };
  await writeFile(join(fakeBin, "container"), `#!/bin/sh
printf 'container\t%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  ${JSON.stringify(`rm ${state.container}`)})
    ${outcome("container", behavior.container, `No such container: ${state.container}`, "container removal failed")}
    ;;
  ${JSON.stringify(`volume rm ${state.workspaceVolume}`)})
    ${outcome("workspace", behavior.workspace, `${state.workspaceVolume} not found`, "volume removal failed")}
    ;;
  ${JSON.stringify(`network rm ${state.network}`)})
    ${outcome("network", behavior.network, `${state.network} not found`, "network removal failed")}
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  await writeFile(join(fakeBin, "portless"), `#!/bin/sh
printf 'portless\t%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  ${JSON.stringify(`alias --remove ${state.alias}`)})
    ${outcome("alias", behavior.alias, `${state.alias} not found`, "alias removal failed")}
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  await writeFile(join(fakeBin, "herdr"), `#!/bin/sh
printf 'herdr\t%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  ${JSON.stringify(`tab close ${state.herdrTabId}`)})
    ${outcome("herdr", behavior.herdr, `${state.herdrTabId} not found`, "Herdr close failed")}
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  return { logPath, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, REPO_SEED: root } };
}

describe("durable ticket acceptance", () => {
  test("advances workflow state, is idempotent, records ordered history, and permits the next ticket", async () => {
    const item = await fixture();
    const head = await commit(item, "accepted");
    await publishExplicit(item, head);
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

    const unpublished = await fixture();
    const unpublishedHead = await commit(unpublished, "unpublished");
    await expect(acceptTicket({ cwd: unpublished.root, revision: unpublishedHead, review: "planner" })).rejects.toThrow("requires an explicit validated publication");

    const running = await fixture();
    const head = await commit(running, "work");
    await dispatchTicket({ cwd: running.root, workerName: "worker", launcher: async (request) => {
      await writeAgentState(running.stateDir, agent(running, request));
      return { runtime: "apple", container: "container" };
    }});
    await expect(acceptTicket({ cwd: running.root, revision: head, review: "planner" })).rejects.toThrow("nonterminal");
  });

  test("requires an imported report matching the durable publication and accepted revision", async () => {
    const missing = await fixture();
    const missingHead = await commit(missing, "missing-report");
    const missingRun = await dispatchTicket({ cwd: missing.root, workerName: "missing-worker", launcher: async (request) => {
      await writeAgentState(missing.stateDir, agent(missing, request));
      return { runtime: "apple", container: "container" };
    } });
    const missingState = (await readAgentState(missing.stateDir, missingRun.worker.slug))!;
    const blockedPublication = await execute([process.execPath, cli, "agent", "publish", missingRun.worker.slug, "--json"], missing.root, { ...process.env, REPO_SEED: missing.root });
    expect(blockedPublication.code).not.toBe(0);
    expect(blockedPublication.stderr).toContain("no imported completion report");
    await publishExplicit(missing, missingHead, missingRun.worker.slug);
    await requestAgentStop({ cwd: missing.root, name: missingRun.worker.slug, requester: "cli", reason: "done", stopRuntime: async () => {} });
    await recordAgentExit({ cwd: missing.root, state: missingState, exitCode: 143 });
    await expect(acceptTicket({ cwd: missing.root, revision: missingHead, review: "planner" })).rejects.toThrow("no imported completion report");

    const mismatch = await fixture();
    const publishedHead = await commit(mismatch, "published-head");
    const mismatchRun = await dispatchTicket({ cwd: mismatch.root, workerName: "mismatch-worker", launcher: async (request) => {
      await writeAgentState(mismatch.stateDir, agent(mismatch, request));
      return { runtime: "apple", container: "container" };
    } });
    const mismatchState = (await readAgentState(mismatch.stateDir, mismatchRun.worker.slug))!;
    await publishExplicit(mismatch, publishedHead, mismatchRun.worker.slug);
    const staging = completionReportStagingPath(mismatch.root, mismatch.goalId, mismatch.ticketId, mismatchRun.runId);
    await writeFile(staging, `${JSON.stringify({
      schemaVersion: 1, goalId: mismatch.goalId, ticketId: mismatch.ticketId, runId: mismatchRun.runId, worker: mismatchRun.worker,
      baseRevision: mismatch.base, resultingRevision: mismatch.base, producedCommitIds: [], dirtyWorktree: false,
      outcome: "completed", summary: "stale report", verification: [], services: [], artifacts: [], assumptions: [], limitations: [], risks: [],
      followUp: { state: "ready" }, createdAt: "2026-01-03T00:30:00.000Z",
    }, null, 2)}\n`);
    await importCompletionReport(mismatch.root);
    await requestAgentStop({ cwd: mismatch.root, name: mismatchRun.worker.slug, requester: "cli", reason: "done", stopRuntime: async () => {} });
    await recordAgentExit({ cwd: mismatch.root, state: mismatchState, exitCode: 143 });
    await expect(acceptTicket({ cwd: mismatch.root, revision: publishedHead, review: "planner" })).rejects.toThrow("does not match publication and accepted revision");
  });

  test("recovers a validated acceptance interrupted after immutable result creation", async () => {
    const item = await fixture();
    const head = await commit(item, "recover");
    await publishExplicit(item, head);
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

describe("agent finalization and provenance", () => {
  test("finalizes an accepted worker, preserves doctor provenance, and allows slug reuse", async () => {
    const item = await fixture();
    const accepted = await acceptedWorker(item, "Worker One");
    const state = (await readAgentState(item.stateDir, accepted.slug))!;
    const fake = await installFinalizationFakes(item.root, state);
    const removed = await execute([process.execPath, cli, "agent", "remove", accepted.slug, "--force"], item.root, fake.env);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(`Finalized ${accepted.slug}`);
    expect((await readAgentState(item.stateDir, accepted.slug))).toBeUndefined();
    expect((await readFile(fake.logPath, "utf8")).trim().split("\n")).toEqual([
      `container\trm ${state.container}`,
      `container\tvolume rm ${state.workspaceVolume}`,
      `container\tnetwork rm ${state.network}`,
      `portless\talias --remove ${state.alias}`,
      `herdr\ttab close ${state.herdrTabId}`,
    ]);
    expect((await workflowDoctor(item.root)).ok).toBe(true);

    const repeated = await execute([process.execPath, cli, "agent", "remove", accepted.slug, "--force"], item.root, fake.env);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain(`Already finalized ${accepted.slug}`);

    const nextPath = join(item.root, ".pi-swarm", "drafts", "next.md");
    await writeFile(nextPath, "# Next\n");
    await issueTicket({ cwd: item.root, ticketFile: nextPath, now: new Date("2026-01-05T00:00:00.000Z") });
    const redispatched = await dispatchTicket({ cwd: item.root, workerName: "Worker One", launcher: async (request) => {
      await writeAgentState(item.stateDir, agent(item, request));
      return { runtime: "apple", container: "container-reused", herdrName: "herdr-reused", herdrPaneId: "pane-reused" };
    } });
    expect(redispatched.worker.slug).toBe(accepted.slug);
    expect(redispatched.runId).not.toBe(accepted.run.runId);
    expect((await workflowDoctor(item.root)).ok).toBe(true);
  });

  test("doctor detects an integrity-consistent report/publication/result mismatch", async () => {
    const item = await fixture();
    const accepted = await acceptedWorker(item, "report-mismatch");
    const runDirectory = join(item.stateDir, "goals", item.goalId, "tickets", item.ticketId, "runs", accepted.run.runId);
    const reportPath = join(runDirectory, "report.v1.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.resultingRevision = item.base;
    report.producedCommitIds = [];
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await writeFile(reportPath, bytes);
    const recordPath = join(runDirectory, "record.v1.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.report.sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    record.report.byteLength = bytes.byteLength;
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    const diagnosis = await workflowDoctor(item.root);
    expect(diagnosis.ok).toBe(false);
    expect(diagnosis.errors.join(" ")).toContain("completion report/publication/result provenance");
  });

  test("doctor fails closed on tampered finalization evidence", async () => {
    const item = await fixture();
    const accepted = await acceptedWorker(item, "tampered");
    const state = (await readAgentState(item.stateDir, accepted.slug))!;
    const fake = await installFinalizationFakes(item.root, state);
    expect((await execute([process.execPath, cli, "agent", "remove", accepted.slug, "--force"], item.root, fake.env)).code).toBe(0);
    const finalizationPath = join(item.stateDir, "finalized-agents", `${accepted.run.runId}.v1.json`);
    const tampered = JSON.parse(await readFile(finalizationPath, "utf8"));
    tampered.correlation.runId = `run-${"f".repeat(32)}`;
    await writeFile(finalizationPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const report = await workflowDoctor(item.root);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("finalization");
  });
});

describe("bootstrap migration and doctor", () => {
  test("doctor detects snapshot tampering", async () => {
    const item = await fixture();
    await writeFile(join(item.root, `.pi-swarm/goals/${item.goalId}/tickets/${item.ticketId}/ticket.md`), "tampered\n");
    const report = await workflowDoctor(item.root);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("integrity");
  });
});
