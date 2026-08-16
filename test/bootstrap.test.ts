import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { activateGoal, issueTicket, loadWorkflowState, type TicketRecord } from "../src/goals.ts";
import { migrateBootstrap, ticketHistory, workflowDoctor } from "../src/workflow.ts";
import { sha256 } from "../src/workflow-state.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function exec(args: string[], cwd: string) { const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { code, stdout: stdout.trim(), stderr: stderr.trim() }; }
async function git(root: string, ...args: string[]) { const result = await exec(["git", ...args], root); if (result.code) throw new Error(result.stderr || result.stdout); return result.stdout; }
function ticketId(goalId: string, baseRevision: string, digest: string) { return `ticket-${new Bun.CryptoHasher("sha256").update(`spike-ticket-v1\0${JSON.stringify({ goalId, baseRevision, digest })}`).digest("hex").slice(0, 32)}`; }

async function publication(root: string, worker: string, base: string, head: string) {
  const directory = join(root, ".pi-swarm", "output", "branches", worker); await mkdir(directory, { recursive: true });
  const branch = `bootstrap-${worker}`; await git(root, "branch", branch, head);
  const bundlePath = `.pi-swarm/output/branches/${worker}/${head}.bundle`; await git(root, "bundle", "create", join(root, bundlePath), branch); await git(root, "branch", "-D", branch);
  const importedRef = `refs/spike/agents/${worker}`; await git(root, "update-ref", importedRef, head);
  const project = basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  const manifest = { schemaVersion: 1, project, agent: worker, workerBranch: branch, base, head, importedRef, bundlePath, publishedAt: "2026-08-16T00:00:00.000Z" };
  await writeFile(join(directory, `${head}.json`), `${JSON.stringify(manifest, null, 2)}\n`); await writeFile(join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
async function generatedTicket(root: string, goalId: string, base: string, ordinal: string, bytes: Buffer, issuedAt: string): Promise<TicketRecord> {
  const digest = sha256(bytes); const id = ticketId(goalId, base, digest); const sourcePath = `.pi-swarm/drafts/${ordinal}.md`;
  const record: TicketRecord = { schemaVersion: 1, ticketId: id, goalId, status: "ready", baseRevision: base, snapshotPath: `.pi-swarm/goals/${goalId}/tickets/${id}/ticket.md`, snapshotSha256: digest, snapshotBytes: bytes.length, sourcePath, workerPath: `.pi-swarm/output/workflow/${goalId}/tickets/${id}/ticket.md`, issuedAt };
  for (const path of [join(root, dirname(record.snapshotPath)), join(root, dirname(record.workerPath)), join(root, ".pi-swarm", "drafts")]) await mkdir(path, { recursive: true });
  await writeFile(join(root, record.snapshotPath), bytes); await writeFile(join(root, record.workerPath), bytes); await writeFile(join(root, sourcePath), bytes); await writeFile(join(root, dirname(record.snapshotPath), "record.v1.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
function stoppedAgent(root: string, slug: string, extras: Record<string, unknown> = {}) {
  return { schemaVersion: 1, name: slug, slug, project: basename(root), runtime: "apple", container: `container-${slug}`, workspaceVolume: `volume-${slug}`, network: `network-${slug}`, containerPort: 3000, backend: "herdr", lifecycle: "stopped", startedAt: "2026-08-16T00:00:00.000Z", pid: 100, stopRequestedAt: "2026-08-16T00:10:00.000Z", stopRequester: "cli", stopReason: "operator-requested", outcome: "stopped", finishedAt: "2026-08-16T00:10:01.000Z", exitCode: 143, terminationKind: "requested", signal: "SIGTERM", expectedSignal: "SIGTERM", ...extras };
}
async function actualLayoutFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-bootstrap-"))); roots.push(root);
  await git(root, "init", "-b", "main"); await git(root, "config", "user.name", "Spike Test"); await git(root, "config", "user.email", "spike@example.test");
  await mkdir(join(root, "doc"), { recursive: true }); await writeFile(join(root, "doc", "goal.md"), "# Goal\n"); await writeFile(join(root, "doc", "ticket.md"), "# Ticket 001\n"); await writeFile(join(root, ".gitignore"), ".pi-swarm/\n"); await git(root, "add", "."); await git(root, "commit", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD"); const blob = await git(root, "rev-parse", "HEAD:doc/goal.md"); const ticketBlob = await git(root, "rev-parse", "HEAD:doc/ticket.md");
  const goal = await activateGoal({ cwd: root, goalFile: "doc/goal.md", approvalStatement: "go", now: new Date("2026-08-15T23:55:12.000Z") });
  const heads: string[] = []; for (let i = 1; i <= 5; i++) { await writeFile(join(root, `work-${i}`), `${i}\n`); await git(root, "add", `work-${i}`); await git(root, "commit", "-m", `ticket ${i}`); heads.push(await git(root, "rev-parse", "HEAD")); }
  const bases = [base, heads[0], heads[1], heads[2], heads[3]];
  const goalRecordPath = join(root, `.pi-swarm/goals/${goal.record.goalId}/record.v1.json`); const goalRecord = JSON.parse(await readFile(goalRecordPath, "utf8")); goalRecord.acceptedCodeRevision = heads[4]; await writeFile(goalRecordPath, `${JSON.stringify(goalRecord, null, 2)}\n`);
  const workflowPath = join(root, `.pi-swarm/goals/${goal.record.goalId}/workflow.v1.json`); const workflow = JSON.parse(await readFile(workflowPath, "utf8")); workflow.acceptedCodeRevision = heads[4]; workflow.stateRevision++; workflow.lastTransitionAt = "2026-08-16T04:38:46.000Z"; await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  const ticket4 = await generatedTicket(root, goal.record.goalId, bases[3], "004", Buffer.from("# Ticket 004\n"), "2026-08-16T03:21:00.000Z");
  const ticket5 = await generatedTicket(root, goal.record.goalId, bases[4], "005", Buffer.from("# Ticket 005\n"), "2026-08-16T03:57:00.000Z");
  const activeSource = join(root, ".pi-swarm", "drafts", "006.md"); await writeFile(activeSource, "# Ticket 006\n"); const active = await issueTicket({ cwd: root, ticketFile: activeSource, now: new Date("2026-08-16T04:40:00.000Z") });
  const workers = ["ticket-001-publish-review", "ticket-002-durable-goal-state", "ticket-003-ready-ticket-state", "ticket-004-run-lifecycle", "ticket-005-stop-intent-compat"];
  for (let i = 0; i < 5; i++) await publication(root, workers[i], bases[i], heads[i]);
  const legacy = join(root, ".pi-swarm", "goals", "001"); for (let i = 1; i <= 5; i++) await mkdir(join(legacy, "tickets", String(i).padStart(3, "0")), { recursive: true });
  await writeFile(join(legacy, "approval.md"), `# Goal 001 approval\n\nStatus: Approved\n\n- Goal: \`doc/goal.md\`\n- Approved goal blob: \`${blob}\`\n- Repository revision at approval: \`${base}\`\n- Approved at: \`2026-08-15T23:55:12Z\`\n- Operator statement: \`go\`\n`);
  const ticket2 = Buffer.from("# Ticket 002\n"), ticket3 = Buffer.from("# Ticket 003\n"); await writeFile(join(legacy, "tickets", "002", "ticket.md"), ticket2); await writeFile(join(legacy, "tickets", "003", "ticket.md"), ticket3);
  const acceptedAt = ["2026-08-16T00:52:28Z", "2026-08-16T01:16:09Z", "2026-08-16T03:20:32Z", "2026-08-16T03:56:14Z", "2026-08-16T04:38:46Z"];
  for (let i = 1; i <= 5; i++) {
    const number = String(i).padStart(3, "0"); let identity = i === 1 ? `- Ticket: \`doc/ticket.md\`\n- Ticket blob: \`${ticketBlob}\`` : i <= 3 ? `- Ticket: \`.pi-swarm/goals/001/tickets/${number}/ticket.md\`\n- Ticket digest (SHA-256): \`${sha256(i === 2 ? ticket2 : ticket3)}\`` : `- Durable ticket ID: \`${i === 4 ? ticket4.ticketId : ticket5.ticketId}\``;
    const run = i === 5 ? `\n- Run ID: \`run-${"5".repeat(32)}\`` : ""; const review = i === 4 ? "\n- Review surface: Hunk" : "";
    await writeFile(join(legacy, "tickets", number, "acceptance.md"), `# Ticket ${number} acceptance\n\nStatus: Accepted\n\n${identity}${run}\n- Base revision: \`${bases[i - 1]}\`\n- Accepted revision: \`${heads[i - 1]}\`\n- Accepted at: \`${acceptedAt[i - 1]}\`\n- Decision: Planner accepted after review.\n${review}\n## Evidence\n\n- Worker: \`${workers[i - 1]}\`\n`);
  }
  const agentsDir = join(root, ".pi-swarm", "agents"); await mkdir(join(agentsDir, "stop-intents"), { recursive: true });
  for (let i = 0; i < 4; i++) await writeFile(join(agentsDir, `${workers[i]}.json`), `${JSON.stringify(stoppedAgent(root, workers[i]), null, 2)}\n`);
  const runId = `run-${"5".repeat(32)}`; const fifthAgent = stoppedAgent(root, workers[4], { goalId: goal.record.goalId, ticketId: ticket5.ticketId, runId, baseRevision: bases[4], stopRunId: runId }); await writeFile(join(agentsDir, `${workers[4]}.json`), `${JSON.stringify(fifthAgent, null, 2)}\n`);
  const runDirectory = join(root, `.pi-swarm/goals/${goal.record.goalId}/tickets/${ticket5.ticketId}/runs/${runId}`); await mkdir(runDirectory, { recursive: true });
  const runRecord = { schemaVersion: 1, runId, goalId: goal.record.goalId, ticketId: ticket5.ticketId, baseRevision: bases[4], worker: { name: workers[4], slug: workers[4] }, backend: "herdr", status: "stopped", createdAt: "2026-08-16T03:57:00.000Z", launchedAt: "2026-08-16T03:57:01.000Z", finishedAt: fifthAgent.finishedAt, runtime: "apple", container: fifthAgent.container, stopRequestedAt: fifthAgent.stopRequestedAt, stopRequester: fifthAgent.stopRequester, stopReason: fifthAgent.stopReason, stopRunId: runId, exitCode: 143, signal: "SIGTERM", expectedSignal: "SIGTERM", terminationKind: "requested", outcome: "stopped" };
  const ticket5Directory = dirname(dirname(runDirectory));
  await writeFile(join(runDirectory, "record.v1.json"), `${JSON.stringify(runRecord, null, 2)}\n`); await writeFile(join(ticket5Directory, "active-run.json"), `${JSON.stringify({ schemaVersion: 1, goalId: goal.record.goalId, ticketId: ticket5.ticketId, runId, recordPath: `.pi-swarm/goals/${goal.record.goalId}/tickets/${ticket5.ticketId}/runs/${runId}/record.v1.json` }, null, 2)}\n`);
  const intent = { schemaVersion: 1, slug: workers[4], startedAt: fifthAgent.startedAt, pid: fifthAgent.pid, container: fifthAgent.container, runId, stopRequestedAt: fifthAgent.stopRequestedAt, stopRequester: fifthAgent.stopRequester, stopReason: fifthAgent.stopReason }; await writeFile(join(agentsDir, "stop-intents", `${workers[4]}.v1.json`), `${JSON.stringify(intent, null, 2)}\n`);
  await writeFile(join(ticket5Directory, "acceptance.bootstrap.json"), `${JSON.stringify({ schemaVersion: 1, ticketId: ticket5.ticketId, goalId: goal.record.goalId, runId, baseRevision: bases[4], acceptedRevision: heads[4], acceptedAt: acceptedAt[4], worker: workers[4] }, null, 2)}\n`);
  const reconciliation = join(root, ".pi-swarm", "reconciliation"); await mkdir(reconciliation, { recursive: true }); await writeFile(join(reconciliation, "historical-stops.v1.json"), `${JSON.stringify({ schemaVersion: 1, reconciledAt: "2026-08-16T04:38:00Z", agents: workers.slice(0, 4).map((slug, i) => ({ slug, ticketAcceptance: `.pi-swarm/goals/001/tickets/${String(i + 1).padStart(3, "0")}/acceptance.md` })) }, null, 2)}\n`);
  const mirrorDir = join(root, ".pi-swarm", "output", "tickets"); await mkdir(mirrorDir, { recursive: true }); await writeFile(join(mirrorDir, "002.md"), ticket2); await writeFile(join(mirrorDir, "003.md"), ticket3);
  await rm(workflowPath); // Actual bootstrap checkout predates Ticket 006 workflow state.
  return { root, goalId: goal.record.goalId, activeId: active.record.ticketId, accepted: heads[4], workers, ticket5 };
}

describe("actual bootstrap layout migration", () => {
  test("plans directly, preserves active Ticket 006, migrates correlations and cleans only validated evidence", async () => {
    const item = await actualLayoutFixture(); const workflowPath = join(item.root, `.pi-swarm/goals/${item.goalId}/workflow.v1.json`);
    const first = await migrateBootstrap({ cwd: item.root }); const second = await migrateBootstrap({ cwd: item.root });
    expect(first).toEqual(second); expect(first.applicable).toBe(true); expect(first.errors).toEqual([]); expect(first.actions.some((action) => action.action === "retain" && action.source?.includes(item.activeId))).toBe(true); expect(await Bun.file(workflowPath).exists()).toBe(false);
    const applied = await migrateBootstrap({ cwd: item.root, apply: true, now: new Date("2026-08-16T05:00:00.000Z") }); expect(applied.applied).toBe(true);
    const state = await loadWorkflowState(item.root); expect(state.activeTicketId).toBe(item.activeId); expect(state.acceptedCodeRevision).toBe(item.accepted);
    const history = await ticketHistory(item.root); expect(history.map((entry) => entry.status)).toEqual(["migrated", "migrated", "migrated", "migrated", "migrated", "ready"]);
    for (const worker of item.workers.slice(0, 4)) { const agent = JSON.parse(await readFile(join(item.root, ".pi-swarm", "agents", `${worker}.json`), "utf8")); expect(agent.goalId).toBe(item.goalId); expect(agent.runId).toBeUndefined(); }
    expect(await Bun.file(join(item.root, ".pi-swarm", "agents", "stop-intents", `${item.workers[4]}.v1.json`)).exists()).toBe(false);
    expect(await Bun.file(join(item.root, ".pi-swarm", "output", "tickets", "002.md")).exists()).toBe(false); expect(await Bun.file(join(item.root, ".pi-swarm", "drafts", "006.md")).exists()).toBe(true);
    expect(await Bun.file(join(item.root, ".pi-swarm", "archive", "bootstrap-001", "goals-001", "approval.md")).exists()).toBe(true);
    expect((await workflowDoctor(item.root)).ok).toBe(true); expect((await migrateBootstrap({ cwd: item.root, apply: true })).applied).toBe(true);
  });

  test("reports all preflight conflicts and leaves a tampered layout untouched", async () => {
    const item = await actualLayoutFixture();
    const workflowPath = join(item.root, `.pi-swarm/goals/${item.goalId}/workflow.v1.json`);
    await writeFile(join(item.root, ".pi-swarm", "output", "tickets", "002.md"), "tampered\n");
    const plan = await migrateBootstrap({ cwd: item.root });
    expect(plan.applicable).toBe(true);
    expect(plan.errors.join(" ")).toContain("differs from authoritative snapshot");
    await expect(migrateBootstrap({ cwd: item.root, apply: true })).rejects.toThrow("bootstrap migration refused");
    expect(await Bun.file(workflowPath).exists()).toBe(false);
    expect(await Bun.file(join(item.root, ".pi-swarm", "goals", "001", "approval.md")).exists()).toBe(true);
    expect(await Bun.file(join(item.root, ".pi-swarm", "archive", "bootstrap-001", "migration-receipt.v1.json")).exists()).toBe(false);
    const agent = JSON.parse(await readFile(join(item.root, ".pi-swarm", "agents", `${item.workers[0]}.json`), "utf8"));
    expect(agent.goalId).toBeUndefined();
  });
});
