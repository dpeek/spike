import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { finalizeAgentRemoval, finalizedAgentPath, finalizationRecordPath, type AgentFinalizationRecord } from "../src/finalization.ts";
import { agentStatePath, writeAgentState, type AgentState } from "../src/runs.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-finalization-")));
  roots.push(root);
  const stateDir = join(root, ".pi-swarm");
  await mkdir(join(stateDir, "agents"), { recursive: true });
  return { root, stateDir };
}

function state(slug: string, runtime: AgentState["runtime"] = "apple", extras: Partial<AgentState> = {}): AgentState {
  return {
    schemaVersion: 1,
    name: slug,
    slug,
    project: basename(slug),
    runtime,
    container: `container-${slug}`,
    workspaceVolume: `volume-${slug}`,
    network: `network-${slug}`,
    alias: `${slug}.project`,
    containerPort: 3000,
    backend: "herdr",
    lifecycle: "stopped",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:10:00.000Z",
    stopRequestedAt: "2026-09-01T00:09:59.000Z",
    stopRequester: "cli",
    stopReason: "operator-requested",
    outcome: "stopped",
    exitCode: 143,
    signal: "SIGTERM",
    expectedSignal: "SIGTERM",
    terminationKind: "requested",
    pid: 123,
    herdrTabId: `tab-${slug}`,
    ...extras,
  };
}

async function writePartialRecord(stateDir: string, record: Partial<AgentFinalizationRecord> & Pick<AgentFinalizationRecord, "slug" | "cleanup">) {
  await mkdir(join(stateDir, "agents", "finalization"), { recursive: true });
  await writeFile(finalizationRecordPath(stateDir, record.slug), `${JSON.stringify(record, null, 2)}\n`);
}

describe("durable agent finalization", () => {
  test("retries only pending or failed cleanup and preserves completed statuses", async () => {
    const item = await fixture();
    const agent = state("skip-retry", "apple", { herdrTabId: undefined });
    await writeAgentState(item.stateDir, agent);
    await writePartialRecord(item.stateDir, {
      schemaVersion: 1,
      slug: agent.slug,
      runtime: agent.runtime,
      startedAt: agent.startedAt,
      pid: agent.pid,
      container: agent.container,
      createdAt: "2026-09-01T00:11:00.000Z",
      updatedAt: "2026-09-01T00:11:00.000Z",
      cleanup: {
        container: { status: "removed", resource: agent.container, settledAt: "2026-09-01T00:11:01.000Z" },
        alias: { status: "absent", resource: agent.alias, settledAt: "2026-09-01T00:11:02.000Z" },
        workspaceVolume: { status: "removed", resource: agent.workspaceVolume, settledAt: "2026-09-01T00:11:03.000Z" },
        network: { status: "failed", resource: agent.network, detail: "temporary runtime error" },
        herdrTab: { status: "not_configured" },
      },
    });

    const commands: string[][] = [];
    const result = await finalizeAgentRemoval({
      stateDir: item.stateDir,
      state: agent,
      available: async () => { throw new Error("availability should not be checked for settled cleanup"); },
      runCommand: async (command) => {
        commands.push(command);
        expect(command).toEqual(["container", "network", "rm", agent.network]);
        return { code: 0, stdout: "", stderr: "" };
      },
      now: new Date("2026-09-01T00:12:00.000Z"),
    });

    expect(result.completed).toBe(true);
    expect(commands).toEqual([["container", "network", "rm", agent.network]]);
    const finalized = JSON.parse(await readFile(finalizedAgentPath(item.stateDir, agent.slug), "utf8")) as AgentFinalizationRecord;
    expect(finalized.cleanup.container.status).toBe("removed");
    expect(finalized.cleanup.alias.status).toBe("absent");
    expect(finalized.cleanup.workspaceVolume.status).toBe("removed");
    expect(finalized.cleanup.network.status).toBe("removed");
    expect(finalized.cleanup.herdrTab.status).toBe("not_configured");
    expect(await Bun.file(agentStatePath(item.stateDir, agent.slug)).exists()).toBe(false);
    expect(await Bun.file(finalizationRecordPath(item.stateDir, agent.slug)).exists()).toBe(false);
  });

  test("accepts Apple runtime absent volume and network only after exact negative inspect", async () => {
    const item = await fixture();
    const agent = state("apple-absent", "apple", { herdrTabId: undefined });
    await writeAgentState(item.stateDir, agent);
    await writePartialRecord(item.stateDir, {
      slug: agent.slug,
      cleanup: {
        container: { status: "removed", resource: agent.container },
        alias: { status: "not_configured" },
        workspaceVolume: { status: "pending", resource: agent.workspaceVolume },
        network: { status: "pending", resource: agent.network },
        herdrTab: { status: "not_configured" },
      },
    });

    const commands: string[][] = [];
    const result = await finalizeAgentRemoval({
      stateDir: item.stateDir,
      state: agent,
      available: async () => false,
      runCommand: async (command) => {
        commands.push(command);
        if (command.join("\0") === ["container", "volume", "rm", agent.workspaceVolume].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: failed to delete one or more volumes: [\"${agent.workspaceVolume}\"]` };
        }
        if (command.join("\0") === ["container", "volume", "inspect", agent.workspaceVolume].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: no such volume: ${agent.workspaceVolume}` };
        }
        if (command.join("\0") === ["container", "network", "rm", agent.network].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: failed to delete one or more networks: [\"${agent.network}\"]` };
        }
        if (command.join("\0") === ["container", "network", "inspect", agent.network].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: no such network: ${agent.network}` };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
      now: new Date("2026-09-01T00:13:00.000Z"),
    });

    expect(result.completed).toBe(true);
    expect(commands).toEqual([
      ["container", "volume", "rm", agent.workspaceVolume],
      ["container", "volume", "inspect", agent.workspaceVolume],
      ["container", "network", "rm", agent.network],
      ["container", "network", "inspect", agent.network],
    ]);
    const finalized = JSON.parse(await readFile(finalizedAgentPath(item.stateDir, agent.slug), "utf8")) as AgentFinalizationRecord;
    expect(finalized.cleanup.workspaceVolume.status).toBe("absent");
    expect(finalized.cleanup.workspaceVolume.detail).toContain("failed to delete one or more volumes");
    expect(finalized.cleanup.workspaceVolume.probeCommand).toEqual(["container", "volume", "inspect", agent.workspaceVolume]);
    expect(finalized.cleanup.network.status).toBe("absent");
    expect(finalized.cleanup.network.detail).toContain("failed to delete one or more networks");
    expect(finalized.cleanup.network.probeCommand).toEqual(["container", "network", "inspect", agent.network]);
  });

  test("keeps runtime resources failed when exact inspect finds them or is inconclusive", async () => {
    const item = await fixture();
    const agent = state("apple-failed", "apple", { alias: undefined, herdrTabId: undefined });
    await writeAgentState(item.stateDir, agent);
    await writePartialRecord(item.stateDir, {
      slug: agent.slug,
      cleanup: {
        container: { status: "removed", resource: agent.container },
        alias: { status: "not_configured" },
        workspaceVolume: { status: "pending", resource: agent.workspaceVolume },
        network: { status: "pending", resource: agent.network },
        herdrTab: { status: "not_configured" },
      },
    });

    const result = await finalizeAgentRemoval({
      stateDir: item.stateDir,
      state: agent,
      available: async () => false,
      runCommand: async (command) => {
        if (command.join("\0") === ["container", "volume", "rm", agent.workspaceVolume].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: failed to delete one or more volumes: [\"${agent.workspaceVolume}\"]` };
        }
        if (command.join("\0") === ["container", "volume", "inspect", agent.workspaceVolume].join("\0")) {
          return { code: 0, stdout: JSON.stringify([{ name: agent.workspaceVolume }]), stderr: "" };
        }
        if (command.join("\0") === ["container", "network", "rm", agent.network].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: failed to delete one or more networks: [\"${agent.network}\"]` };
        }
        if (command.join("\0") === ["container", "network", "inspect", agent.network].join("\0")) {
          return { code: 1, stdout: "", stderr: "runtime unavailable" };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
      now: new Date("2026-09-01T00:14:00.000Z"),
    });

    expect(result.completed).toBe(false);
    expect(result.failedResources).toEqual(["workspaceVolume", "network"]);
    const partial = JSON.parse(await readFile(finalizationRecordPath(item.stateDir, agent.slug), "utf8")) as AgentFinalizationRecord;
    expect(partial.cleanup.workspaceVolume.status).toBe("failed");
    expect(partial.cleanup.workspaceVolume.detail).toContain("still found");
    expect(partial.cleanup.network.status).toBe("failed");
    expect(partial.cleanup.network.detail).toContain("inconclusive");
    expect(await Bun.file(agentStatePath(item.stateDir, agent.slug)).exists()).toBe(true);
  });

  test("constructs Docker exact remove and inspect commands without a live runtime", async () => {
    const item = await fixture();
    const agent = state("docker-probe", "docker", { alias: undefined, herdrTabId: undefined });
    await writeAgentState(item.stateDir, agent);
    await writePartialRecord(item.stateDir, {
      slug: agent.slug,
      cleanup: {
        container: { status: "removed", resource: agent.container },
        alias: { status: "not_configured" },
        workspaceVolume: { status: "pending", resource: agent.workspaceVolume },
        network: { status: "removed", resource: agent.network },
        herdrTab: { status: "not_configured" },
      },
    });

    const commands: string[][] = [];
    const result = await finalizeAgentRemoval({
      stateDir: item.stateDir,
      state: agent,
      available: async () => false,
      runCommand: async (command) => {
        commands.push(command);
        if (command.join("\0") === ["docker", "volume", "rm", agent.workspaceVolume].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: failed to delete one or more volumes: [\"${agent.workspaceVolume}\"]` };
        }
        if (command.join("\0") === ["docker", "volume", "inspect", agent.workspaceVolume].join("\0")) {
          return { code: 1, stdout: "", stderr: `Error: no such volume: ${agent.workspaceVolume}` };
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
      now: new Date("2026-09-01T00:15:00.000Z"),
    });

    expect(result.completed).toBe(true);
    expect(commands).toEqual([
      ["docker", "volume", "rm", agent.workspaceVolume],
      ["docker", "volume", "inspect", agent.workspaceVolume],
    ]);
    const finalized = JSON.parse(await readFile(finalizedAgentPath(item.stateDir, agent.slug), "utf8")) as AgentFinalizationRecord;
    expect(finalized.cleanup.workspaceVolume.status).toBe("absent");
  });

  test("preserves Portless absent remediation and keeps distinct alias failures retryable", async () => {
    const first = await fixture();
    const absent = state("portless-absent", "apple", { herdrTabId: undefined });
    await writeAgentState(first.stateDir, absent);
    await writePartialRecord(first.stateDir, {
      slug: absent.slug,
      cleanup: {
        container: { status: "removed", resource: absent.container },
        alias: { status: "pending", resource: absent.alias },
        workspaceVolume: { status: "removed", resource: absent.workspaceVolume },
        network: { status: "removed", resource: absent.network },
        herdrTab: { status: "not_configured" },
      },
    });
    const absentResult = await finalizeAgentRemoval({
      stateDir: first.stateDir,
      state: absent,
      available: async (command) => command === "portless",
      runCommand: async (command) => {
        expect(command).toEqual(["portless", "alias", "--remove", absent.alias!]);
        return { code: 1, stdout: "", stderr: `Error: No alias found for \"${absent.alias}.spike.local\".` };
      },
      now: new Date("2026-09-01T00:16:00.000Z"),
    });
    expect(absentResult.completed).toBe(true);
    const absentFinalized = JSON.parse(await readFile(finalizedAgentPath(first.stateDir, absent.slug), "utf8")) as AgentFinalizationRecord;
    expect(absentFinalized.cleanup.alias.status).toBe("absent");

    const second = await fixture();
    const failed = state("portless-failed", "apple", { herdrTabId: undefined });
    await writeAgentState(second.stateDir, failed);
    await writePartialRecord(second.stateDir, {
      slug: failed.slug,
      cleanup: {
        container: { status: "removed", resource: failed.container },
        alias: { status: "pending", resource: failed.alias },
        workspaceVolume: { status: "removed", resource: failed.workspaceVolume },
        network: { status: "removed", resource: failed.network },
        herdrTab: { status: "not_configured" },
      },
    });
    const failedResult = await finalizeAgentRemoval({
      stateDir: second.stateDir,
      state: failed,
      available: async (command) => command === "portless",
      runCommand: async () => ({ code: 1, stdout: "", stderr: "Error: authentication failed" }),
      now: new Date("2026-09-01T00:17:00.000Z"),
    });
    expect(failedResult.completed).toBe(false);
    const failedPartial = JSON.parse(await readFile(finalizationRecordPath(second.stateDir, failed.slug), "utf8")) as AgentFinalizationRecord;
    expect(failedPartial.cleanup.alias.status).toBe("failed");
    expect(failedPartial.cleanup.alias.detail).toContain("authentication failed");
  });
});
