import { beforeAll, describe, expect, test } from "bun:test";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { issueTicket, type ExecutionPolicy } from "../../src/ticket.ts";
import { dockerWorkerAdapter, loadRecordedWorkerIfPresent } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";
import { workerAdapterContract } from "../contract/worker-adapter.ts";

beforeAll(async () => {
  const build = Bun.spawn(["docker", "build", "--quiet", "-t", "spike-worker:local", "-f", "docker/Dockerfile", "."], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
}, 120_000);

async function fixture(policy: ExecutionPolicy = { isolation: "container", networkAccess: "none", credentialGrants: [] }) {
  const repository = await temporaryRepository();
  const goal = await createGoal({ cwd: repository.root, title: "Docker adapter", outcome: "Exercise Docker isolation.", approval: "Approved." });
  await createChange({ cwd: repository.root, goalId: goal.goal.metadata.goalId, title: "Docker", intent: "Run Docker.", rationale: "Exercise the adapter.", acceptanceCriteria: ["Docker runs."] });
  const issued = await issueTicket({ cwd: repository.root, goalId: goal.goal.metadata.goalId, changeId: "001", instruction: "Execute Docker contract.", executionPolicy: policy, model: "contract-model", thinking: "off" });
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
});
