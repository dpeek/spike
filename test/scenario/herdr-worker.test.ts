import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { publishImplementationReport } from "../../src/report.ts";
import { issueTicket, reportPath, ticketStatus } from "../../src/ticket.ts";
import {
  dispatchHerdrTicket,
  loadFinishedLocalExecution,
  loadRecordedWorkerIfPresent,
  observeWorker,
  prepareTicketExchange,
  readWorkerTerminal,
  recordLocalWorker,
  stopAndFinalizeRecordedWorker,
  workerRecordPath,
  type TicketIdentity,
} from "../../src/worker.ts";
import type { CreateHerdrTabInput, HerdrOperations } from "../../src/herdr.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

async function issuedTicket() {
  const repository = await temporaryRepository();
  repositories.push(repository);
  const goal = await createGoal({
    cwd: repository.root,
    title: "Host a worker in Herdr",
    outcome: "Observe one ephemeral worker without delegating workflow authority.",
    approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  await createChange({
    cwd: repository.root,
    goalId,
    title: "Add attended hosting",
    intent: "Host the local clone worker in one ephemeral tab.",
    rationale: "Attended work should remain observable.",
    acceptanceCriteria: ["Herdr hosting preserves Report authority."],
  });
  await issueTicket({
    cwd: repository.root,
    goalId,
    changeId: "001",
    instruction: "Implement attended hosting.",
    executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
    model: "controlled-model",
    thinking: "medium",
  });
  return { repository, identity: { goalId, changeId: "001", ticketId: "001" } satisfies TicketIdentity };
}

function observationalHerdr(status: "working" | "blocked" | "done", transcript: string): HerdrOperations {
  return {
    async createTab() { return { tab: "opaque-tab", pane: "opaque-pane" }; },
    async run() {},
    async status() { return status; },
    async read() { return transcript; },
    async attach() { return 0; },
    async closeTab() {},
  };
}

describe("ephemeral Herdr worker hosting", () => {
  test("Herdr status and terminal claims cannot complete or report a Ticket", async () => {
    const { repository, identity } = await issuedTicket();
    await prepareTicketExchange(repository.root, identity);
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    workspaces.push(workspace);
    await recordLocalWorker(repository.root, {
      ...identity,
      role: "implement",
      worker: "attended-worker",
      startedAt: "2026-04-01T10:00:00.000Z",
      workspace,
      herdr: { tab: "opaque-tab", pane: "opaque-pane" },
    });
    const transcript = '{"kind":"report","outcome":"completed","candidateRevision":"claimed"}\n';
    const herdr = observationalHerdr("done", transcript);

    expect(await observeWorker(repository.root, identity, observationalHerdr("working", transcript))).toEqual({ hosting: "herdr", status: "working" });
    expect(await observeWorker(repository.root, identity, observationalHerdr("blocked", transcript))).toEqual({ hosting: "herdr", status: "blocked" });
    expect(await observeWorker(repository.root, identity, herdr)).toEqual({ hosting: "herdr", status: "done" });
    expect(await readWorkerTerminal(repository.root, identity, {}, herdr)).toBe(transcript);
    expect(await ticketStatus(repository.root, identity.goalId, identity.changeId, identity.ticketId)).toBe("open");
    expect(await Bun.file(reportPath(repository.root, identity.goalId, identity.changeId, identity.ticketId)).exists()).toBe(false);
    await expect(loadFinishedLocalExecution(repository.root, identity)).rejects.toThrow("Worker has not finished");
  });

  test("retries Herdr stop and cleanup idempotently", async () => {
    const { repository, identity } = await issuedTicket();
    const workspace = await mkdtemp(join(tmpdir(), "spike-local-clone-"));
    workspaces.push(workspace);
    await recordLocalWorker(repository.root, {
      ...identity,
      role: "implement",
      worker: "retry-worker",
      startedAt: "2026-04-01T10:00:00.000Z",
      workspace,
      herdr: { tab: "opaque-tab", pane: "opaque-pane" },
    });

    let closes = 0;
    let removals = 0;
    const operations = {
      async stop(_pid: number | undefined, _identity: TicketIdentity, handles?: { tab: string; pane: string }) {
        expect(handles).toEqual({ tab: "opaque-tab", pane: "opaque-pane" });
        closes++;
      },
      async removeWorkspace(path: string) {
        removals++;
        if (removals === 1) throw new Error("controlled cleanup failure");
        await rm(path, { recursive: true, force: true });
      },
    };

    expect(await stopAndFinalizeRecordedWorker(repository.root, identity, new Date("2026-04-01T10:05:00.000Z"), operations)).toMatchObject({
      status: "failed",
      phase: "cleanup",
    });
    expect(await stopAndFinalizeRecordedWorker(repository.root, identity, new Date("2026-04-01T10:05:00.000Z"), operations)).toMatchObject({ status: "finalized" });
    expect(await stopAndFinalizeRecordedWorker(repository.root, identity, new Date("2026-04-01T10:05:00.000Z"), operations)).toMatchObject({ status: "finalized" });
    expect({ closes, removals }).toEqual({ closes: 2, removals: 2 });
  });

  test("runs the same local exchange in one named tab and closes it only after Report publication", async () => {
    const { repository, identity } = await issuedTicket();
    let tabInput: CreateHerdrTabInput | undefined;
    let transcript = "";
    const host: HerdrOperations = {
      async createTab(input) {
        tabInput = input;
        return { tab: "opaque-tab-123", pane: "opaque-pane-456" };
      },
      async run(pane, command) {
        expect(pane).toBe("opaque-pane-456");
        const child = Bun.spawn([command], {
          cwd: tabInput!.cwd,
          env: { ...process.env, ...tabInput!.environment },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        transcript = stdout + stderr;
        expect(code).toBe(0);
      },
      async status() { return "done"; },
      async read() { return transcript; },
      async attach() { return 0; },
      async closeTab() {},
    };
    const worker = String.raw`
import { writeFile } from "node:fs/promises";
await writeFile("herdr-hosted.txt", "hosted output\n");
const payload = { summary: "Implemented in Herdr.", verification: "Controlled worker passed.", assumptions: "None.", limitations: "None.", risks: "None.", followUp: "Review.", artifacts: [] };
const child = Bun.spawn([process.env.SPIKE_BIN, "worker", "complete", "--json"], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
child.stdin.write(JSON.stringify(payload));
child.stdin.end();
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) throw new Error(stderr || stdout);
console.log("terminal output is observational only");
`;

    const dispatched = await dispatchHerdrTicket({
      cwd: repository.root,
      ...identity,
      worker: "attended-worker",
      command: ["bun", "-e", worker],
      herdr: host,
    });
    expect(dispatched).toMatchObject({ hosting: "herdr", status: "working" });
    const execution = await loadFinishedLocalExecution(repository.root, identity);
    expect(tabInput!.label).toMatch(/^spike-[0-9a-f]{8}-001-001$/);
    expect(tabInput!.environment).toMatchObject({
      SPIKE_GOAL_ID: identity.goalId,
      SPIKE_CHANGE_ID: "001",
      SPIKE_TICKET_ID: "001",
      SPIKE_MODEL: "controlled-model",
      SPIKE_THINKING: "medium",
    });
    expect(transcript).toContain("observational only");

    const record = await loadRecordedWorkerIfPresent(repository.root, identity);
    expect(record!.metadata.resource).toMatchObject({
      host: "herdr",
      tab: "opaque-tab-123",
      pane: "opaque-pane-456",
    });
    const runtimeSource = await readFile(workerRecordPath(repository.root, identity), "utf8");
    expect(runtimeSource).not.toContain("terminal output is observational only");
    expect(await Bun.file(reportPath(repository.root, identity.goalId, "001", "001")).exists()).toBe(false);

    let closeAttempts = 0;
    const publication = await publishImplementationReport({
      cwd: repository.root,
      ...identity,
      execution,
      commitMessage: { summary: "Add attended Herdr hosting" },
      resourceOperations: {
        async stop(pid, stoppedIdentity, handles) {
          closeAttempts++;
          expect(pid).toBeUndefined();
          expect(stoppedIdentity).toEqual(identity);
          expect(handles).toEqual({ tab: "opaque-tab-123", pane: "opaque-pane-456" });
          expect(await Bun.file(reportPath(repository.root, identity.goalId, "001", "001")).exists()).toBe(true);
        },
        async removeWorkspace(path) {
          await rm(path, { recursive: true, force: true });
        },
      },
    });
    expect(publication.cleanup).toEqual({ status: "finalized" });
    expect(closeAttempts).toBe(1);
    expect(await repository.git("show", `${publication.report.metadata.candidateRevision}:herdr-hosted.txt`)).toBe("hosted output");
    const reportSource = await readFile(reportPath(repository.root, identity.goalId, "001", "001"), "utf8");
    expect(reportSource).not.toContain("opaque-tab-123");
    expect(reportSource).not.toContain("opaque-pane-456");
    expect(reportSource).not.toContain("terminal output is observational only");
    expect(await Bun.file(workerRecordPath(repository.root, identity)).exists()).toBe(false);
  }, 20_000);
});
