import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChange } from "./change.ts";
import { createGoal } from "./goal.ts";
import type { HerdrOperations, SplitHerdrPaneInput } from "./herdr.ts";
import { publishFailedReport } from "./report.ts";
import { issueTicket } from "./ticket.ts";
import {
  dispatchPiTicket,
  dispatchWorkerTicket,
  finalizeWorker,
  forgetFinalizedWorker,
  loadFinishedWorkerExecution,
  loadRecordedWorkerIfPresent,
  type TicketIdentity,
} from "./worker.ts";
import { temporaryRepository } from "../test/support/repository.ts";

async function configuredTicket(setup: string[]) {
  const repository = await temporaryRepository();
  const path = join(repository.root, "spike.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.worker = { setup };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  await repository.git("add", "spike.json");
  await repository.git("commit", "--quiet", "-m", "Configure worker setup");
  const goal = await createGoal({
    cwd: repository.root,
    hostPaths: repository.hostPaths,
    title: "Prepare fresh workers",
    outcome: "Run setup before the worker command.",
    approval: "Approved.",
  });
  await createChange({
    cwd: repository.root,
    hostPaths: repository.hostPaths,
    goalId: goal.goal.metadata.goalId,
    title: "Run worker setup",
    intent: "Prepare the exact fresh checkout.",
    rationale: "Workers need dependencies before starting.",
    acceptanceCriteria: ["Setup completes before the worker starts."],
  });
  const issued = await issueTicket({
    cwd: repository.root,
    hostPaths: repository.hostPaths,
    goalId: goal.goal.metadata.goalId,
    changeId: "001",
    instruction: "Verify setup ordering.",
    executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
  });
  const identity = {
    goalId: goal.goal.metadata.goalId,
    changeId: "001",
    ticketId: issued.ticket.metadata.ticketId,
  } satisfies TicketIdentity;
  return { repository, issued, identity };
}

describe("frozen worker setup", () => {
  test("runs frozen argv in the fresh checkout before a direct worker", async () => {
    const setup = [
      "bun",
      "-e",
      "await Bun.write('setup-ready', 'ready'); await Bun.write(process.env.SPIKE_OUTPUT_DIR + '/setup-cwd', process.cwd()); console.log('setup complete')",
    ];
    const { repository, issued, identity } = await configuredTicket(setup);
    expect(issued.ticket.metadata.setupCommand).toEqual(setup);

    const configPath = join(repository.root, "spike.json");
    const changed = JSON.parse(await readFile(configPath, "utf8"));
    changed.worker.setup = ["bun", "-e", "process.exit(99)"];
    await writeFile(configPath, `${JSON.stringify(changed)}\n`);

    const dispatched = await dispatchWorkerTicket({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      ...identity,
      worker: "setup-order-worker",
      command: [
        "bun",
        "-e",
        "if (!(await Bun.file('setup-ready').exists())) process.exit(41); console.log('worker started')",
      ],
    });
    expect(dispatched.execution).toMatchObject({ exitCode: 0, stdout: "setup complete\nworker started\n", stderr: "" });
    expect(await readFile(join(dispatched.exchange.outputDirectory, "setup-cwd"), "utf8")).not.toBe(repository.root);
    expect(await Bun.file(join(repository.root, "setup-ready")).exists()).toBe(false);

    await finalizeWorker(repository.project, identity, new Date());
    await forgetFinalizedWorker(repository.project, identity);
  });

  test("runs setup before attended Pi starts", async () => {
    const setup = ["bun", "-e", "await Bun.write('setup-ready', 'ready'); console.log('attended setup complete')"];
    const { repository, identity } = await configuredTicket(setup);
    const directory = await mkdtemp(join(tmpdir(), "spike-setup-herdr-pi-"));
    const pi = join(directory, "pi");
    const marker = join(directory, "pi-started");
    await writeFile(pi, `#!/usr/bin/env bun\nif (!(await Bun.file('setup-ready').exists())) process.exit(42); await Bun.write(${JSON.stringify(marker)}, 'started');\n`);
    await chmod(pi, 0o700);

    let pane: SplitHerdrPaneInput | undefined;
    const herdr: HerdrOperations = {
      async createTab() { throw new Error("not called"); },
      async splitPane(input) { pane = input; return { pane: "setup-pane" }; },
      async run(_pane, command) {
        const child = Bun.spawn([command], { cwd: pane!.cwd, env: { ...process.env, ...pane!.environment }, stdout: "pipe", stderr: "pipe" });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(stderr || `attended wrapper exited ${code}`);
      },
      async status() { return "done"; },
      async read() { return ""; },
      async attach() { return 0; },
      async closePane() {},
      async closeTab() {},
    };
    const dispatched = await dispatchPiTicket({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      ...identity,
      worker: "attended-setup-worker",
      host: "herdr",
      piExecutable: pi,
      herdr,
    });
    expect(dispatched).toMatchObject({ hosting: "herdr", status: "working" });
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(await loadFinishedWorkerExecution(repository.project, identity)).toMatchObject({ exitCode: 0 });
    const record = await loadRecordedWorkerIfPresent(repository.project, identity);
    const workspace = (record!.metadata.runtime!.resource as { workspace: string }).workspace;
    await finalizeWorker(repository.project, identity, new Date(), {
      async stop() {},
      async cleanup() { await rm(workspace, { recursive: true, force: true }); },
    });
    await forgetFinalizedWorker(repository.project, identity);
  });

  test("records setup failure and never starts Pi", async () => {
    const setup = [
      "bun",
      "-e",
      "await Bun.write(process.env.SPIKE_OUTPUT_DIR + '/setup-failed', 'failed'); console.error('setup failed'); process.exit(27)",
    ];
    const { repository, identity } = await configuredTicket(setup);
    const directory = await mkdtemp(join(tmpdir(), "spike-setup-pi-"));
    const pi = join(directory, "pi");
    const marker = join(directory, "pi-started");
    await writeFile(pi, `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\n`);
    await chmod(pi, 0o700);

    const dispatched = await dispatchPiTicket({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      ...identity,
      worker: "setup-failure-worker",
      host: "direct",
      piExecutable: pi,
    });
    if (dispatched.hosting !== "direct") throw new Error("expected direct dispatch");
    expect(dispatched.classification).toBe("failed-execution");
    expect(dispatched.execution).toMatchObject({ exitCode: 27, stdout: "", stderr: "setup failed\n" });
    expect(await Bun.file(join(dispatched.exchange.outputDirectory, "setup-failed")).exists()).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);

    const publication = await publishFailedReport({
      cwd: repository.root,
      hostPaths: repository.hostPaths,
      ...identity,
      role: "implement",
      reason: "Worker setup exited with code 27 before Pi started.",
      execution: dispatched.execution,
    });
    expect(publication.report.metadata.outcome).toBe("failed");
    expect(publication.report.body).toContain("before Pi started");
  });
});
