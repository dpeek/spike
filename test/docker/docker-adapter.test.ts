import { beforeAll, describe, expect, test } from "bun:test";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { issueTicket, type ExecutionPolicy } from "../../src/ticket.ts";
import { dispatchPiTicket, dockerWorkerAdapter, exchangePath, loadRecordedWorkerIfPresent } from "../../src/worker.ts";
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
  const goal = await createGoal({ cwd: repository.root, title: "Docker adapter", outcome: "Exercise Docker isolation.", approval: "Approved." });
  await createChange({ cwd: repository.root, goalId: goal.goal.metadata.goalId, title: "Docker", intent: "Run Docker.", rationale: "Exercise the adapter.", acceptanceCriteria: ["Docker runs."] });
  const issued = await issueTicket({ cwd: repository.root, goalId: goal.goal.metadata.goalId, changeId: "001", instruction, executionPolicy: policy, model, thinking: "off" });
  return { root: repository.root, identity: { goalId: goal.goal.metadata.goalId, changeId: "001", ticketId: issued.ticket.metadata.ticketId }, revision: issued.ticket.metadata.inputRevision, remove: repository.remove };
}

workerAdapterContract({ name: "docker", adapter: dockerWorkerAdapter, createTicket: fixture });

describe("Docker worker isolation", () => {
  test("mounts only the declared exchange, records immutable image provenance, and enforces policy before launch", async () => {
    const active = await fixture();
    try {
      const dispatching = dockerWorkerAdapter.dispatch({ cwd: active.root, ...active.identity, worker: "isolation-worker", command: ["bun", "-e", "await Bun.sleep(300)"] });
      let record;
      for (let attempt = 0; !record && attempt < 50; attempt++) {
        record = await loadRecordedWorkerIfPresent(active.root, active.identity);
        if (!record) await Bun.sleep(10);
      }
      expect(record).toBeDefined();
      const runtime = record!.metadata.runtime!.resource as { containerId: string; imageDigest: string };
      const inspected = await Bun.$`docker inspect ${runtime.containerId}`.json();
      const mounts = inspected[0].Mounts as Array<{ Destination: string; RW: boolean }>;
      expect(mounts.map((mount) => mount.Destination).sort()).toEqual(["/exchange/input", "/exchange/output"]);
      expect(mounts.find((mount) => mount.Destination === "/exchange/input")?.RW).toBe(false);
      expect(mounts.find((mount) => mount.Destination === "/exchange/output")?.RW).toBe(true);
      expect(inspected[0].HostConfig.NetworkMode).toBe("none");
      expect(inspected[0].HostConfig.ReadonlyRootfs).toBe(true);
      expect(runtime.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(inspected[0].Image).toBe(runtime.imageDigest);
      await dispatching;
      expect((await dockerWorkerAdapter.finalize(active.root, active.identity, new Date())).status).toBe("finalized");
      expect((await dockerWorkerAdapter.finalize(active.root, active.identity, new Date())).status).toBe("finalized");
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }

    const unsupported = await fixture({ isolation: "container", networkAccess: "restricted", credentialGrants: [] });
    try {
      await expect(dockerWorkerAdapter.dispatch({ cwd: unsupported.root, ...unsupported.identity, worker: "policy-worker", command: ["true"] })).rejects.toThrow("restricted network");
      expect(await loadRecordedWorkerIfPresent(unsupported.root, unsupported.identity)).toBeUndefined();
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", unsupported.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await unsupported.remove();
    }
  }, 30_000);

  test("resolves only the declared Pi credential before creation without mounting its source", async () => {
    const auth = `/tmp/spike-docker-auth-${crypto.randomUUID()}.json`;
    const prior = process.env["SPIKE_PI_AUTH_FILE"];
    await Bun.write(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "test-secret", refresh: "test-refresh", expires: 4_102_444_800_000 }, other: { type: "api_key", key: "other-secret" } }));
    process.env["SPIKE_PI_AUTH_FILE"] = auth;
    const active = await fixture({ isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] });
    try {
      await dockerWorkerAdapter.dispatch({ cwd: active.root, ...active.identity, worker: "credential-worker", command: ["true"] });
      const record = await loadRecordedWorkerIfPresent(active.root, active.identity);
      const runtime = record!.metadata.runtime!.resource as { containerId: string };
      const inspected = await Bun.$`docker inspect ${runtime.containerId}`.json();
      expect((inspected[0].Mounts as Array<{ Destination: string }>).map((mount) => mount.Destination)).not.toContain(auth);
      expect(JSON.stringify(record)).not.toContain("test-secret");
      await dockerWorkerAdapter.finalize(active.root, active.identity, new Date());
    } finally {
      if (prior === undefined) delete process.env["SPIKE_PI_AUTH_FILE"];
      else process.env["SPIKE_PI_AUTH_FILE"] = prior;
      await Bun.file(auth).delete();
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }

    const absent = await fixture({ isolation: "container", networkAccess: "none", credentialGrants: ["openai-codex"] });
    const sourceForLater = process.env["SPIKE_PI_AUTH_FILE"];
    delete process.env["SPIKE_PI_AUTH_FILE"];
    try {
      let inspected = false;
      await expect(dockerWorkerAdapter.dispatch({
        cwd: absent.root, ...absent.identity, worker: "missing-credential", command: ["true"],
        afterDockerImageInspection: async () => { inspected = true; },
      })).rejects.toThrow("SPIKE_PI_AUTH_FILE");
      expect(inspected).toBe(false);
      expect(await loadRecordedWorkerIfPresent(absent.root, absent.identity)).toBeUndefined();
      expect(await Bun.file(`${exchangePath(absent.root, absent.identity)}/input/ticket.md`).exists()).toBe(false);
    } finally {
      if (sourceForLater === undefined) delete process.env["SPIKE_PI_AUTH_FILE"];
      else process.env["SPIKE_PI_AUTH_FILE"] = sourceForLater;
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
              cwd: active.root, ...active.identity, worker: `refusal-${refusal.name}`, command: ["true"],
              afterDockerImageInspection: async () => { inspected = true; },
            });
          } catch (error) {
            diagnostic = error;
          }
          expect(diagnostic).toBeInstanceOf(Error);
          expect((diagnostic as Error).message).toContain(refusal.error);
          for (const secret of refusal.secrets ?? []) expect((diagnostic as Error).message).not.toContain(secret);
          expect(inspected).toBe(false);
          expect(await loadRecordedWorkerIfPresent(active.root, active.identity)).toBeUndefined();
          expect(await Bun.file(`${exchangePath(active.root, active.identity)}/input/ticket.md`).exists()).toBe(false);
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
        cwd: active.root, ...active.identity, worker: "provenance-worker", command: ["true"],
        afterDockerImageInspection: async () => { await Bun.$`docker tag spike-worker:retag-regression spike-worker:local`.quiet(); },
      });
      const record = await loadRecordedWorkerIfPresent(active.root, active.identity);
      expect(record!.metadata.environmentDigest).toBe(original);
      expect(dispatched.execution.environmentDigest).toBe(original);
      await dockerWorkerAdapter.finalize(active.root, active.identity, new Date());
    } finally {
      await Bun.$`docker tag ${original} spike-worker:local`.quiet();
      await Bun.$`docker rm --force ${source}`.quiet();
      if (previousImage === undefined) delete process.env["SPIKE_DOCKER_IMAGE"];
      else process.env["SPIKE_DOCKER_IMAGE"] = previousImage;
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

  test("stopping a live worker retains terminal evidence through repeated finalization", async () => {
    const active = await fixture();
    try {
      const dispatching = dockerWorkerAdapter.dispatch({ cwd: active.root, ...active.identity, worker: "stop-worker", command: ["bun", "-e", "await Bun.sleep(5000)"] });
      for (let attempt = 0; ; attempt++) {
        if (await loadRecordedWorkerIfPresent(active.root, active.identity)) break;
        if (attempt > 50) throw new Error("Docker worker was not recorded");
        await Bun.sleep(10);
      }
      const finalizing = dockerWorkerAdapter.finalize(active.root, active.identity, new Date());
      const dispatched = await dispatching;
      const finalized = await finalizing;
      expect(dispatched.execution.exitCode).toBe(137);
      expect(finalized.status).toBe("finalized");
      const finished = await dockerWorkerAdapter.loadFinished(active.root, active.identity);
      expect(finished.exitCode).toBe(137);
      expect((await dockerWorkerAdapter.finalize(active.root, active.identity, new Date())).status).toBe("finalized");
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 30_000);

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
      const dispatched = await dispatchPiTicket({ cwd: active.root, ...active.identity, worker: "real-pi-smoke", host: "direct" });
      if (dispatched.hosting !== "direct" || dispatched.classification !== "accepted-submission") {
        throw new Error(`real Pi did not submit successfully: ${dispatched.hosting === "direct" ? dispatched.classification : dispatched.status}`);
      }
      const published = await publishImplementationReport({ cwd: active.root, ...active.identity, execution: dispatched.execution, commitMessage: { summary: "Real Pi Docker smoke" } });
      expect(published.report.metadata.execution.environmentDigest).toMatch(/^sha256:/);
      expect(published.report.metadata.execution.model).toBe(model);
      expect(await loadRecordedWorkerIfPresent(active.root, active.identity)).toBeUndefined();
    } finally {
      await Bun.spawn(["chmod", "-R", "u+w", active.root], { stdout: "ignore", stderr: "ignore" }).exited;
      await active.remove();
    }
  }, 600_000);
});
