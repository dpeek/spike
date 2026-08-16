import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDurableLaunchEvidence,
  buildPersistentLaunchScript,
  canonicalBaseEnvironment,
  readLaunchEvidence,
} from "../src/durable-launch.ts";

const temporaryDirectories: string[] = [];
const entrypoint = join(import.meta.dir, "..", "docker", "agent-entrypoint.sh");
const goalId = `goal-${"1".repeat(32)}`;
const ticketId = `ticket-${"2".repeat(32)}`;
const runId = `run-${"3".repeat(32)}`;
const startedAt = "2026-08-18T12:00:00.000Z";
const pid = 4321;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function execute(command: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function must(command: string[], cwd: string, env?: Record<string, string | undefined>): Promise<string> {
  const result = await execute(command, cwd, env);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || command.join(" "));
  return result.stdout.trim();
}

type RepoFixture = { root: string; seed: string; workspace: string; evidencePath: string; base: string; head: string };

async function repoFixture(): Promise<RepoFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-durable-launch-")));
  temporaryDirectories.push(root);
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  await mkdir(seed, { recursive: true });
  await must(["git", "init", "-b", "main"], seed);
  await must(["git", "config", "user.name", "Spike Test"], seed);
  await must(["git", "config", "user.email", "spike@example.test"], seed);
  await writeFile(join(seed, "tracked.txt"), "base\n");
  await must(["git", "add", "tracked.txt"], seed);
  await must(["git", "commit", "-m", "base"], seed);
  const base = await must(["git", "rev-parse", "HEAD"], seed);
  await writeFile(join(seed, "tracked.txt"), "main\n");
  await must(["git", "add", "tracked.txt"], seed);
  await must(["git", "commit", "-m", "main advance"], seed);
  const head = await must(["git", "rev-parse", "HEAD"], seed);
  return { root, seed, workspace, evidencePath: join(root, "launch-evidence.json"), base, head };
}

async function runEntrypoint(
  item: RepoFixture,
  env: Record<string, string | undefined>,
  command = `git -C "$AGENT_REPO_DIR" rev-parse HEAD > "$AGENT_WORKSPACE/head.txt"\ngit -C "$AGENT_REPO_DIR" config --get spike.agentBase > "$AGENT_WORKSPACE/agent-base.txt"\n`,
) {
  return await execute(["bash", entrypoint, "sh", "-c", command], item.root, {
    ...process.env,
    AGENT_WORKSPACE: item.workspace,
    AGENT_REPO_DIR: join(item.workspace, "project"),
    AGENT_NAME: "worker-one",
    AGENT_BRANCH: "agent/worker-one",
    REPOSITORY_URL: item.seed,
    ...env,
  });
}

describe("Herdr launch script base propagation", () => {
  test("preserves canonical base variables and safely quotes paths and values", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "spike-launch-script-")));
    temporaryDirectories.push(root);
    const fakeDir = join(root, "bin with spaces");
    const fakeSpike = join(fakeDir, "fake spike's tool.sh");
    const capturePath = join(root, "captured.txt");
    const launchPath = join(root, "launch.sh");
    await mkdir(fakeDir, { recursive: true });
    await writeFile(fakeSpike, `#!/bin/sh\n{\n  printf 'AGENT_BASE_REF=%s\\n' "$AGENT_BASE_REF"\n  printf 'SPIKE_BASE_REVISION=%s\\n' "$SPIKE_BASE_REVISION"\n  printf 'SPIKE_TASK=%s\\n' "$SPIKE_TASK"\n  i=0\n  for arg in "$@"; do\n    i=$((i + 1))\n    printf 'ARG%d=%s\\n' "$i" "$arg"\n  done\n} > "$SPIKE_CAPTURE_PATH"\n`, { mode: 0o755 });
    const base = "a".repeat(40);
    const environment = {
      ...canonicalBaseEnvironment({ SPIKE_BASE_REVISION: base, AGENT_BASE_REF: base }),
      HERDR_AGENT: "pi",
      SPIKE_CAPTURE_PATH: capturePath,
      SPIKE_TASK: `quoted task '$HOME' \"value\"`,
    };
    const script = buildPersistentLaunchScript({
      environment,
      spikePath: fakeSpike,
      agent: "worker-one",
      piArgs: ["--model", "provider/model", `task with 'quotes' and $dollars`],
    });
    await writeFile(launchPath, script, { mode: 0o700 });

    const result = await execute(["sh", launchPath], root);
    expect(result.code).toBe(0);
    expect(script).toContain(`AGENT_BASE_REF='${base}'`);
    expect(script).toContain(`SPIKE_BASE_REVISION='${base}'`);
    const captured = await readFile(capturePath, "utf8");
    expect(captured).toContain(`AGENT_BASE_REF=${base}`);
    expect(captured).toContain(`SPIKE_BASE_REVISION=${base}`);
    expect(captured).toContain(`SPIKE_TASK=quoted task '$HOME' \"value\"`);
    expect(captured).toContain("ARG1=agent");
    expect(captured).toContain("ARG2=run");
    expect(captured).toContain("ARG3=worker-one");
    expect(captured).toContain("ARG4=--model");
    expect(captured).toContain("ARG5=provider/model");
    expect(captured).toContain("ARG6=task with 'quotes' and $dollars");
  });
});

describe("durable launch evidence verification", () => {
  test("rejects mismatched base variables and stale or failed readiness evidence", () => {
    expect(() => canonicalBaseEnvironment({ SPIKE_BASE_REVISION: "a".repeat(40), AGENT_BASE_REF: "b".repeat(40) })).toThrow("disagree");

    const record = {
      schemaVersion: 1 as const,
      token: "token-1",
      status: "ready" as const,
      workerSlug: "worker-one",
      runId,
      goalId,
      ticketId,
      baseRevision: "c".repeat(40),
      container: "container-worker-one",
      startedAt,
      pid,
      head: "c".repeat(40),
      agentBase: "c".repeat(40),
      commitType: "commit",
      recordedAt: "2026-08-18T12:00:01.000Z",
    };
    expect(() => assertDurableLaunchEvidence(record, {
      token: "token-1",
      workerSlug: "worker-one",
      runId,
      goalId,
      ticketId,
      baseRevision: "c".repeat(40),
      container: "container-worker-one",
      startedAt,
      pid,
    })).not.toThrow();
    expect(() => assertDurableLaunchEvidence({ ...record, pid: pid + 1 }, {
      token: "token-1",
      workerSlug: "worker-one",
      runId,
      goalId,
      ticketId,
      baseRevision: "c".repeat(40),
      container: "container-worker-one",
      startedAt,
      pid,
    })).toThrow("pid mismatch");
    expect(() => assertDurableLaunchEvidence({ ...record, status: "launch_failed", error: "missing commit" }, {
      token: "token-1",
      workerSlug: "worker-one",
      runId,
      goalId,
      ticketId,
      baseRevision: "c".repeat(40),
      container: "container-worker-one",
      startedAt,
      pid,
    })).toThrow("missing commit");
  });
});

describe("agent entrypoint exact-base bootstrap", () => {
  test("starts a durable worker exactly at the accepted base and records readiness evidence", async () => {
    const item = await repoFixture();
    const token = "launch-token-success";
    const result = await runEntrypoint(item, {
      SPIKE_GOAL_ID: goalId,
      SPIKE_TICKET_ID: ticketId,
      SPIKE_RUN_ID: runId,
      SPIKE_BASE_REVISION: item.base,
      AGENT_BASE_REF: item.base,
      SPIKE_LAUNCH_EVIDENCE_TOKEN: token,
      SPIKE_LAUNCH_EVIDENCE_PATH: item.evidencePath,
      SPIKE_AGENT_CONTAINER: "container-worker-one",
      SPIKE_AGENT_STARTED_AT: startedAt,
      SPIKE_AGENT_PID: String(pid),
    });
    expect(result.code).toBe(0);
    expect(await readFile(join(item.workspace, "head.txt"), "utf8")).toBe(`${item.base}\n`);
    expect(await readFile(join(item.workspace, "agent-base.txt"), "utf8")).toBe(`${item.base}\n`);

    const evidence = await readLaunchEvidence(item.evidencePath, token);
    expect(evidence.status).toBe("ready");
    assertDurableLaunchEvidence(evidence, {
      token,
      workerSlug: "worker-one",
      runId,
      goalId,
      ticketId,
      baseRevision: item.base,
      container: "container-worker-one",
      startedAt,
      pid,
    });
  });

  test("fails closed when the base variables disagree", async () => {
    const item = await repoFixture();
    const token = "launch-token-mismatch";
    const result = await runEntrypoint(item, {
      SPIKE_GOAL_ID: goalId,
      SPIKE_TICKET_ID: ticketId,
      SPIKE_RUN_ID: runId,
      SPIKE_BASE_REVISION: item.base,
      AGENT_BASE_REF: item.head,
      SPIKE_LAUNCH_EVIDENCE_TOKEN: token,
      SPIKE_LAUNCH_EVIDENCE_PATH: item.evidencePath,
      SPIKE_AGENT_CONTAINER: "container-worker-one",
      SPIKE_AGENT_STARTED_AT: startedAt,
      SPIKE_AGENT_PID: String(pid),
    });
    expect(result.code).not.toBe(0);
    const evidence = await readLaunchEvidence(item.evidencePath, token);
    expect(evidence.status).toBe("launch_failed");
    expect(evidence.error).toContain("disagree");
  });

  test("fails closed when the durable base commit is unavailable", async () => {
    const item = await repoFixture();
    const token = "launch-token-missing";
    const missingBase = "d".repeat(40);
    const result = await runEntrypoint(item, {
      SPIKE_GOAL_ID: goalId,
      SPIKE_TICKET_ID: ticketId,
      SPIKE_RUN_ID: runId,
      SPIKE_BASE_REVISION: missingBase,
      AGENT_BASE_REF: missingBase,
      SPIKE_LAUNCH_EVIDENCE_TOKEN: token,
      SPIKE_LAUNCH_EVIDENCE_PATH: item.evidencePath,
      SPIKE_AGENT_CONTAINER: "container-worker-one",
      SPIKE_AGENT_STARTED_AT: startedAt,
      SPIKE_AGENT_PID: String(pid),
    });
    expect(result.code).not.toBe(0);
    const evidence = await readLaunchEvidence(item.evidencePath, token);
    expect(evidence.status).toBe("launch_failed");
    expect(evidence.error).toContain("not available");
  });

  test("retains HEAD fallback for free-form workers without a durable base", async () => {
    const item = await repoFixture();
    const result = await runEntrypoint(item, {});
    expect(result.code).toBe(0);
    expect(await readFile(join(item.workspace, "head.txt"), "utf8")).toBe(`${item.head}\n`);
    expect(await readFile(join(item.workspace, "agent-base.txt"), "utf8")).toBe(`${item.head}\n`);
  });
});
