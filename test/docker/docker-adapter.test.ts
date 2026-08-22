import { beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { issueTicket, type ExecutionPolicy } from "../../src/ticket.ts";
import { dispatchHerdrDockerTicket, dispatchPiTicket, dockerWorkerAdapter, exchangePath, loadRecordedWorkerIfPresent, observeWorker, waitForWorkerDone } from "../../src/worker.ts";
import type { HerdrOperations } from "../../src/herdr.ts";
import { publishImplementationReport } from "../../src/report.ts";
import { temporaryRepository } from "../support/repository.ts";
import { workerAdapterContract } from "../contract/worker-adapter.ts";

beforeAll(async () => {
  const build = Bun.spawn(["docker", "build", "--quiet", "-t", "spike-worker:local", "-f", "docker/Dockerfile", "."], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
}, 120_000);

async function fixture(policy: ExecutionPolicy = { isolation: "container", networkAccess: "none", credentialGrants: [] }, modelOverride?: string, instruction = "Execute Docker contract.") {
  const repository = await temporaryRepository();
  const model = modelOverride ?? (policy.credentialGrants.length === 1 ? `${policy.credentialGrants[0]}/test-model` : "contract-model");
  const goal = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Docker adapter", outcome: "Exercise Docker isolation.", approval: "Approved." });
  await createChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goal.metadata.goalId, title: "Docker", intent: "Run Docker.", rationale: "Exercise the adapter.", acceptanceCriteria: ["Docker runs."] });
  const issued = await issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goal.metadata.goalId, changeId: "001", instruction, executionPolicy: policy, model, thinking: "off" });
  return { root: repository.root, hostPaths: repository.hostPaths, project: repository.project, identity: { goalId: goal.goal.metadata.goalId, changeId: "001", ticketId: issued.ticket.metadata.ticketId }, revision: issued.ticket.metadata.inputRevision, remove: repository.remove };
}

workerAdapterContract({ name: "docker", adapter: dockerWorkerAdapter, createTicket: fixture });

function expectCodingTmpfsAreExecutable(inspected: any): void {
  for (const [location, size] of [["/tmp", "(?:64m|67108864)"], ["/work", "(?:256m|268435456)"]] as const) {
    const options = inspected[0].HostConfig.Tmpfs?.[location] as string | undefined;
    expect(options).toBeDefined();
    expect(options).toMatch(/(?:^|,)rw(?:,|$)/);
    expect(options).toMatch(/(?:^|,)exec(?:,|$)/);
    expect(options).toMatch(/(?:^|,)nosuid(?:,|$)/);
    expect(options).toMatch(new RegExp(`(?:^|,)size=${size}(?:,|$)`));
    expect(options).not.toMatch(/(?:^|,)noexec(?:,|$)/);
  }
}

function expectContainerBoundary(inspected: any, imageDigest: string, network = "none"): void {
  const mounts = inspected[0].Mounts as Array<{ Destination: string; RW: boolean }>;
  expect(mounts.map((mount) => mount.Destination).sort()).toEqual(["/exchange/input", "/exchange/output"]);
  expect(mounts.find((mount) => mount.Destination === "/exchange/input")?.RW).toBe(false);
  expect(mounts.find((mount) => mount.Destination === "/exchange/output")?.RW).toBe(true);
  expect(inspected[0].HostConfig.NetworkMode).toBe(network);
  expect(inspected[0].HostConfig.ReadonlyRootfs).toBe(true);
  expect(inspected[0].Image).toBe(imageDigest);
  expect((inspected[0].Config.Env as string[]).some((value) => value.startsWith("TMPDIR="))).toBe(false);
  expectCodingTmpfsAreExecutable(inspected);
}

const executeGeneratedTmpfsFiles = `
const { chmod } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
if (tmpdir() !== "/tmp") throw new Error("standard temporary directory was redirected: " + tmpdir());
for (const [path, output] of [["/tmp/generated-temp-proof.sh", "generated /tmp file executed"], ["/work/generated-work-proof.sh", "generated /work file executed"]]) {
  await Bun.write(path, "#!/bin/sh\\nprintf '" + output + "\\n'\\n");
  await chmod(path, 0o700);
  const proof = Bun.spawn([path], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proof.exited, new Response(proof.stdout).text(), new Response(proof.stderr).text()]);
  if (code !== 0) throw new Error(stderr || path + " generated proof failed");
  process.stdout.write(stdout);
}
`;

async function spikeRepositoryFixture() {
  const repository = await temporaryRepository();
  const sourceRoot = join(import.meta.dir, "../..");
  const tracked = (await Bun.$`git -C ${sourceRoot} ls-files -z`.text()).split("\0").filter(Boolean);
  for (const path of tracked) {
    const destination = join(repository.root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, path), destination, { recursive: true });
  }
  await repository.git("add", "--all");
  await repository.git("commit", "--quiet", "-m", "Spike repository Docker check fixture");
  const goal = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Repository check", outcome: "Run the complete Spike check in Docker.", approval: "Approved." });
  await createChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goal.metadata.goalId, title: "Repository check", intent: "Check Spike.", rationale: "Exercise the real repository.", acceptanceCriteria: ["The locked check passes."] });
  const issued = await issueTicket({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goal.metadata.goalId, changeId: "001", instruction: "Run the deterministic repository check.",
    executionPolicy: { isolation: "container", networkAccess: "unrestricted", credentialGrants: [] }, model: "contract-model", thinking: "off",
  });
  return { root: repository.root, hostPaths: repository.hostPaths, project: repository.project, identity: { goalId: goal.goal.metadata.goalId, changeId: "001", ticketId: issued.ticket.metadata.ticketId }, remove: repository.remove };
}

describe("Docker worker isolation", () => {
  test("provides Debian fdfind to Pi's managed fd resolver while offline", async () => {
    const probe = `
const statuses = [];
const { ensureTool } = await import("file:///usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js");
const resolved = await ensureTool("fd", (status) => statuses.push(status));
if (resolved !== "fdfind") throw new Error("Pi resolved fd as " + JSON.stringify(resolved));
if (statuses.length > 0) throw new Error("Pi emitted managed-tool startup status: " + JSON.stringify(statuses));
process.stdout.write(resolved + "\\n");
`;
    const process = Bun.spawn([
      "docker", "run", "--rm", "--entrypoint", "node", "--env", "PI_OFFLINE=1",
      "spike-worker:local", "--input-type=module", "--eval", probe,
    ], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe("fdfind\n");
    expect(stderr).toBe("");
  }, 30_000);

  test("mounts only the declared exchange, records immutable image provenance, and enforces policy before launch", async () => {
    const active = await fixture();
    try {
      const dispatching = dockerWorkerAdapter.dispatch({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "isolation-worker", command: ["bun", "-e", "await Bun.sleep(300)"] });
      let record;
      for (let attempt = 0; !record && attempt < 50; attempt++) {
        record = await loadRecordedWorkerIfPresent(active.project, active.identity);
        if (!record) await Bun.sleep(10);
      }
      expect(record).toBeDefined();
      const runtime = record!.metadata.runtime!.resource as { containerId: string; imageDigest: string };
      const inspected = await Bun.$`docker inspect ${runtime.containerId}`.json();
      expect(runtime.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expectContainerBoundary(inspected, runtime.imageDigest);
      await dispatching;
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }

    const unsupported = await fixture({ isolation: "container", networkAccess: "restricted", credentialGrants: [] });
    try {
      await expect(dockerWorkerAdapter.dispatch({ cwd: unsupported.root, hostPaths: unsupported.hostPaths, ...unsupported.identity, worker: "policy-worker", command: ["true"] })).rejects.toThrow("restricted network");
      expect(await loadRecordedWorkerIfPresent(unsupported.project, unsupported.identity)).toBeUndefined();
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", unsupported.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await unsupported.remove();
    }
  }, 30_000);

  test("directly executes generated files under /tmp and /work with the complete direct boundary", async () => {
    const active = await fixture();
    try {
      const dispatched = await dockerWorkerAdapter.dispatch({
        cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "tmpfs-execution-regression", command: ["bun", "-e", executeGeneratedTmpfsFiles],
      });
      expect(dispatched.execution).toMatchObject({ exitCode: 0, stdout: "generated /tmp file executed\ngenerated /work file executed\n", stderr: "" });
      const record = await loadRecordedWorkerIfPresent(active.project, active.identity);
      const runtime = record!.metadata.runtime!.resource as { containerId: string; imageDigest: string };
      expect(record!.metadata.environmentDigest).toBe(runtime.imageDigest);
      expectContainerBoundary(await Bun.$`docker inspect ${runtime.containerId}`.json(), runtime.imageDigest);
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
      expect(await Bun.spawn(["docker", "container", "inspect", runtime.containerId], { stdout: "ignore", stderr: "ignore" }).exited).not.toBe(0);
      expect((await loadRecordedWorkerIfPresent(active.project, active.identity))?.metadata.runtime).toBeUndefined();
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

  test("resolves only the declared Pi credential before creation without mounting its source", async () => {
    const auth = `/tmp/spike-docker-auth-${crypto.randomUUID()}.json`;
    const prior = process.env["SPIKE_PI_AUTH_FILE"];
    await Bun.write(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "test-secret", refresh: "test-refresh", expires: 4_102_444_800_000 }, other: { type: "api_key", key: "other-secret" } }));
    process.env["SPIKE_PI_AUTH_FILE"] = auth;
    const active = await fixture({ isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] });
    try {
      await dockerWorkerAdapter.dispatch({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "credential-worker", command: ["true"] });
      const record = await loadRecordedWorkerIfPresent(active.project, active.identity);
      const runtime = record!.metadata.runtime!.resource as { containerId: string };
      const inspected = await Bun.$`docker inspect ${runtime.containerId}`.json();
      expect((inspected[0].Mounts as Array<{ Destination: string }>).map((mount) => mount.Destination)).not.toContain(auth);
      expect(JSON.stringify(record)).not.toContain("test-secret");
      await dockerWorkerAdapter.finalize(active.project, active.identity, new Date());
    } finally {
      if (prior === undefined) delete process.env["SPIKE_PI_AUTH_FILE"];
      else process.env["SPIKE_PI_AUTH_FILE"] = prior;
      await Bun.file(auth).delete();
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }

    const absent = await fixture({ isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] });
    const sourceForLater = process.env["SPIKE_PI_AUTH_FILE"];
    const configuredForLater = process.env["PI_CODING_AGENT_DIR"];
    const homeForLater = process.env["HOME"];
    delete process.env["SPIKE_PI_AUTH_FILE"];
    process.env["PI_CODING_AGENT_DIR"] = `/tmp/spike-missing-auth-${crypto.randomUUID()}`;
    process.env["HOME"] = `/tmp/spike-missing-home-${crypto.randomUUID()}`;
    try {
      let inspected = false;
      await expect(dockerWorkerAdapter.dispatch({
        cwd: absent.root, hostPaths: absent.hostPaths, ...absent.identity, worker: "missing-credential", command: ["true"],
        afterDockerImageInspection: async () => { inspected = true; },
      })).rejects.toThrow("unavailable or invalid");
      expect(inspected).toBe(false);
      expect(await loadRecordedWorkerIfPresent(absent.project, absent.identity)).toBeUndefined();
      expect(await Bun.file(`${exchangePath(absent.project, absent.identity)}/input/ticket.md`).exists()).toBe(false);
    } finally {
      if (sourceForLater === undefined) delete process.env["SPIKE_PI_AUTH_FILE"];
      else process.env["SPIKE_PI_AUTH_FILE"] = sourceForLater;
      if (configuredForLater === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = configuredForLater;
      if (homeForLater === undefined) delete process.env["HOME"];
      else process.env["HOME"] = homeForLater;
      await Bun.spawn(["chmod", "-R", "u+w", absent.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await absent.remove();
    }
  }, 30_000);

  test("refuses unsupported or malformed credential grants before any Docker or exchange side effect", async () => {
    const auth = `/tmp/spike-docker-auth-${crypto.randomUUID()}.json`;
    const prior = process.env["SPIKE_PI_AUTH_FILE"];
    process.env["SPIKE_PI_AUTH_FILE"] = auth;
    const valid = { "openai-codex": { type: "oauth", access: "test-secret", refresh: "test-refresh", expires: 4_102_444_800_000 } };
    const cases: Array<{ name: string; policy: ExecutionPolicy; model?: string; document: unknown; error: string; secrets?: string[] }> = [
      { name: "absent provider", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] }, document: {}, error: "absent or malformed" },
      { name: "unknown provider", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["unknown-provider"] }, document: valid, error: "supports only" },
      { name: "malformed credential", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] }, document: { "openai-codex": { nonsense: true } }, error: "absent or malformed" },
      { name: "whitespace-only access", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] }, document: { "openai-codex": { type: "oauth", access: "\t \n  ", refresh: "test-refresh", expires: 4_102_444_800_000 } }, error: "absent or malformed", secrets: ["test-refresh"] },
      { name: "whitespace-only refresh", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] }, document: { "openai-codex": { type: "oauth", access: "test-secret", refresh: " \n\t ", expires: 4_102_444_800_000 } }, error: "absent or malformed", secrets: ["test-secret"] },
      { name: "provider model mismatch", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] }, model: "openai/test-model", document: valid, error: "supports only" },
      { name: "multiple grants", policy: { isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex", "openai-codex"] }, document: valid, error: "exactly one" },
    ];
    try {
      for (const refusal of cases) {
        await Bun.write(auth, JSON.stringify(refusal.document));
        const active = await fixture(refusal.policy, refusal.model);
        let inspected = false;
        const containersBefore = await Bun.$`docker container ls --all --quiet`.text();
        try {
          let diagnostic: unknown;
          try {
            await dockerWorkerAdapter.dispatch({
              cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: `refusal-${refusal.name}`, command: ["true"],
              afterDockerImageInspection: async () => { inspected = true; },
            });
          } catch (error) {
            diagnostic = error;
          }
          expect(diagnostic).toBeInstanceOf(Error);
          expect((diagnostic as Error).message).toContain(refusal.error);
          for (const secret of refusal.secrets ?? []) expect((diagnostic as Error).message).not.toContain(secret);
          expect(inspected).toBe(false);
          expect(await loadRecordedWorkerIfPresent(active.project, active.identity)).toBeUndefined();
          expect(await Bun.file(`${exchangePath(active.project, active.identity)}/input/ticket.md`).exists()).toBe(false);
          expect(await Bun.$`docker container ls --all --quiet`.text()).toBe(containersBefore);
        } finally {
          await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
          await active.remove();
        }
      }
    } finally {
      if (prior === undefined) delete process.env["SPIKE_PI_AUTH_FILE"];
      else process.env["SPIKE_PI_AUTH_FILE"] = prior;
      await Bun.file(auth).delete();
    }
  }, 30_000);

  test("creates from the inspected digest when its mutable tag changes", async () => {
    const active = await fixture();
    const previousImage = process.env["SPIKE_DOCKER_IMAGE"];
    const original = (await Bun.$`docker image inspect --format {{.Id}} spike-worker:local`.text()).trim();
    const source = (await Bun.$`docker create spike-worker:local`.text()).trim();
    try {
      await Bun.$`docker commit ${source} spike-worker:retag-regression`.quiet();
      process.env["SPIKE_DOCKER_IMAGE"] = "spike-worker:local";
      const dispatched = await dockerWorkerAdapter.dispatch({
        cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "provenance-worker", command: ["true"],
        afterDockerImageInspection: async () => { await Bun.$`docker tag spike-worker:retag-regression spike-worker:local`.quiet(); },
      });
      const record = await loadRecordedWorkerIfPresent(active.project, active.identity);
      expect(record!.metadata.environmentDigest).toBe(original);
      expect(dispatched.execution.environmentDigest).toBe(original);
      await dockerWorkerAdapter.finalize(active.project, active.identity, new Date());
    } finally {
      await Bun.$`docker tag ${original} spike-worker:local`.quiet();
      await Bun.$`docker rm --force ${source}`.quiet();
      if (previousImage === undefined) delete process.env["SPIKE_DOCKER_IMAGE"];
      else process.env["SPIKE_DOCKER_IMAGE"] = previousImage;
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

  test("attends a TTY container, wakes only after docker exit, and retires tab resources", async () => {
    const active = await fixture();
    const closed: string[] = [];
    const host: HerdrOperations = {
      async createTab() { return { tab: "docker-tab", pane: "docker-pane" }; },
      async run(_pane, command) { Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "ignore" }); },
      async status() { return "done"; }, async read() { return "operational terminal"; }, async attach() { return 0; },
      async closeTab(tab) { closed.push(tab); },
    };
    try {
      const dispatched = await dispatchHerdrDockerTicket({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "attended-worker", command: ["bun", "-e", `${executeGeneratedTmpfsFiles}\nawait Bun.sleep(500);`], herdr: host });
      expect(dispatched.status).toBe("working");
      const record = await loadRecordedWorkerIfPresent(active.project, active.identity);
      const runtime = record!.metadata.runtime!.resource as { containerId: string; host: string; imageDigest: string; workspace: string }; 
      const inspected = await Bun.$`docker inspect ${runtime.containerId}`.json();
      expect(inspected[0].Config.Tty).toBe(true);
      expect(inspected[0].Config.OpenStdin).toBe(true);
      expect(record!.metadata.environmentDigest).toBe(runtime.imageDigest);
      expectContainerBoundary(inspected, runtime.imageDigest);
      expect((await observeWorker(active.project, active.identity, host)).status).toBe("working");
      await waitForWorkerDone(active.project, active.identity);
      expect((await observeWorker(active.project, active.identity, host)).status).toBe("done");
      expect((await Bun.$`docker logs ${runtime.containerId}`.text()).replaceAll("\r\n", "\n")).toBe("generated /tmp file executed\ngenerated /work file executed\n");
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date(), {
        async stop(runtime) { await Bun.$`docker stop --time 1 ${(runtime as { containerId: string }).containerId}`.quiet(); await host.closeTab("docker-tab"); },
        async cleanup(runtime) {
          await Bun.$`docker rm --force ${(runtime as { containerId: string }).containerId}`.quiet();
          await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true });
        },
      })).status).toBe("finalized");
      expect(closed).toEqual(["docker-tab"]);
      expect(await Bun.file(runtime.workspace).exists()).toBe(false);
      expect(await Bun.spawn(["docker", "container", "inspect", runtime.containerId], { stdout: "ignore", stderr: "ignore" }).exited).not.toBe(0);
      expect((await loadRecordedWorkerIfPresent(active.project, active.identity))?.metadata.runtime).toBeUndefined();
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
      expect(closed).toEqual(["docker-tab"]);
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

  test("retries attended Docker cleanup after removal succeeds but wrapper workspace removal fails", async () => {
    const active = await fixture();
    const closed: string[] = [];
    const host: HerdrOperations = {
      async createTab() { return { tab: "cleanup-race-tab", pane: "cleanup-race-pane" }; },
      async run(_pane, command) { Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "ignore" }); },
      async status() { return "done"; }, async read() { return "attachment is operational"; }, async attach() { return 0; },
      async closeTab(tab) { closed.push(tab); },
    };
    try {
      await dispatchHerdrDockerTicket({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "cleanup-race", command: ["true"], herdr: host });
      await waitForWorkerDone(active.project, active.identity);
      const durable = (await loadRecordedWorkerIfPresent(active.project, active.identity))!;
      expect(durable.metadata).toMatchObject({ finishedAt: expect.any(String), exitCode: 0 });
      const runtime = durable.metadata.runtime!.resource as { containerId: string; workspace: string };
      await mkdir(runtime.workspace, { recursive: true });
      await writeFile(`${runtime.workspace}/cleanup-race-proof`, "wrapper workspace remains until successful retry\n");
      const events: string[] = [];
      let removed = false;
      const operations = {
        async stop(resource: unknown) {
          events.push("stop/tab-close");
          const id = (resource as { containerId: string }).containerId;
          if ((await Bun.spawn(["docker", "container", "inspect", id], { stdout: "ignore", stderr: "ignore" }).exited) === 0) {
            await Bun.$`docker stop --time 1 ${id}`.quiet();
          }
          await host.closeTab("cleanup-race-tab");
        },
        async terminalExitCode(resource: unknown) {
          events.push("terminal-inspect");
          const id = (resource as { containerId: string }).containerId;
          return Number((await Bun.$`docker inspect --format {{.State.ExitCode}} ${id}`.text()).trim());
        },
        async cleanup(resource: unknown) {
          const value = resource as { containerId: string; workspace: string };
          if (!removed) { events.push("docker-remove"); await Bun.$`docker rm --force ${value.containerId}`.quiet(); removed = true; }
          events.push("workspace-remove");
          if (events.filter((event) => event === "workspace-remove").length === 1) throw new Error("injected wrapper removal failure");
          await rm(value.workspace, { recursive: true, force: true });
        },
      };
      await expect(dockerWorkerAdapter.finalize(active.project, active.identity, new Date(), operations)).resolves.toMatchObject({ status: "failed", phase: "cleanup" });
      expect(await Bun.file(`${runtime.workspace}/cleanup-race-proof`).exists()).toBe(true);
      await expect(dockerWorkerAdapter.finalize(active.project, active.identity, new Date(), operations)).resolves.toMatchObject({ status: "finalized" });
      expect(events).toEqual(["stop/tab-close", "docker-remove", "workspace-remove", "stop/tab-close", "workspace-remove"]);
      expect(await Bun.file(`${runtime.workspace}/cleanup-race-proof`).exists()).toBe(false);
      expect(await Bun.spawn(["docker", "container", "inspect", runtime.containerId], { stdout: "ignore", stderr: "ignore" }).exited).not.toBe(0);
      expect(closed).toEqual(["cleanup-race-tab", "cleanup-race-tab"]);
      expect((await loadRecordedWorkerIfPresent(active.project, active.identity))?.metadata.runtime).toBeUndefined();
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

  test("stopping a live worker retains terminal evidence through repeated finalization", async () => {
    const active = await fixture();
    try {
      const dispatching = dockerWorkerAdapter.dispatch({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "stop-worker", command: ["bun", "-e", "await Bun.sleep(5000)"] });
      for (let attempt = 0; ; attempt++) {
        if (await loadRecordedWorkerIfPresent(active.project, active.identity)) break;
        if (attempt > 50) throw new Error("Docker worker was not recorded");
        await Bun.sleep(10);
      }
      const finalizing = dockerWorkerAdapter.finalize(active.project, active.identity, new Date());
      const dispatched = await dispatching;
      const finalized = await finalizing;
      expect(dispatched.execution.exitCode).toBe(137);
      expect(finalized.status).toBe("finalized");
      const finished = await dockerWorkerAdapter.loadFinished(active.project, active.identity);
      expect(finished.exitCode).toBe(137);
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

  test("installs the unchanged lockfile and completes literal bun run check in the real Spike repository", async () => {
    const active = await spikeRepositoryFixture();
    try {
      const command = ["sh", "-c", [
        "set -eu",
        "before=$(sha256sum bun.lock | cut -d ' ' -f 1)",
        "bun install --frozen-lockfile",
        "after=$(sha256sum bun.lock | cut -d ' ' -f 1)",
        "[ \"$before\" = \"$after\" ]",
        "git diff --exit-code -- bun.lock",
        "printf 'locked install left bun.lock unchanged\\n'",
        "unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG SPIKE_DOCKER_IMAGE HERDR_ENV HERDR_WORKSPACE_ID HERDR_PANE_ID SPIKE_WORKER_IMAGE_DIGEST IMAGE_DIGEST CONTAINER_ID",
        "! command -v docker >/dev/null 2>&1",
        "[ ! -e /var/run/docker.sock ]",
        "bun run check",
        "printf 'literal bun run check completed\\n'",
      ].join("\n")];
      const dispatched = await dockerWorkerAdapter.dispatch({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "repository-check-regression", command });
      expect(dispatched.execution.exitCode).toBe(0);
      expect(dispatched.execution.stdout).toContain("locked install left bun.lock unchanged\n");
      expect(dispatched.execution.stdout).toContain("literal bun run check completed\n");
      const record = await loadRecordedWorkerIfPresent(active.project, active.identity);
      const runtime = record!.metadata.runtime!.resource as { containerId: string; imageDigest: string };
      expectContainerBoundary(await Bun.$`docker inspect ${runtime.containerId}`.json(), runtime.imageDigest, "bridge");
      expect((await dockerWorkerAdapter.finalize(active.project, active.identity, new Date())).status).toBe("finalized");
      expect(await Bun.spawn(["docker", "container", "inspect", runtime.containerId], { stdout: "ignore", stderr: "ignore" }).exited).not.toBe(0);
      expect((await loadRecordedWorkerIfPresent(active.project, active.identity))?.metadata.runtime).toBeUndefined();
    } finally {
      await dockerWorkerAdapter.finalize(active.project, active.identity, new Date()).catch(() => undefined);
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 180_000);

  const realSmoke = process.env["SPIKE_DOCKER_REAL_PI"] === "1" ? test : test.skip;
  realSmoke("completes an implementation Ticket through Pi and publishes a cleaned Report", async () => {
    const model = process.env["SPIKE_DOCKER_REAL_PI_MODEL"];
    const auth = process.env["SPIKE_PI_AUTH_FILE"];
    if (!model?.trim() || !auth?.trim()) throw new Error("SPIKE_DOCKER_REAL_PI_MODEL and SPIKE_PI_AUTH_FILE are required");
    const provider = model.split("/", 1)[0]!;
    const active = await fixture(
      { isolation: "container", networkAccess: "unrestricted", credentialGrants: [provider] },
      model,
      "Create real-pi-smoke.txt containing exactly 'completed by real Pi'. Run bun run check. Then complete this implementation Ticket through spike_complete_implementation with concise non-blank evidence and no artifacts.",
    );
    try {
      // The environment-selected model is frozen into the issued Ticket, then
      // passed back to the pinned Pi process by the Docker dispatcher.
      const dispatched = await dispatchPiTicket({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, worker: "real-pi-smoke", host: "direct" });
      if (dispatched.hosting !== "direct" || dispatched.classification !== "accepted-submission") {
        throw new Error(`real Pi did not submit successfully: ${dispatched.hosting === "direct" ? dispatched.classification : dispatched.status}`);
      }
      const published = await publishImplementationReport({ cwd: active.root, hostPaths: active.hostPaths, ...active.identity, execution: dispatched.execution, commitMessage: { summary: "Real Pi Docker smoke" } });
      expect(published.report.metadata.execution.environmentDigest).toMatch(/^sha256:/);
      expect(published.report.metadata.execution.model).toBe(model);
      expect(await loadRecordedWorkerIfPresent(active.project, active.identity)).toBeUndefined();
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 600_000);
});
