import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  herdrPlacementEnvironment,
  herdrPlacementMetadata,
  placeHerdrTab,
  type HerdrCommand,
} from "../src/herdr-placement.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "spike-herdr-placement-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "repo");
  const stateDir = join(root, ".pi-swarm");
  await mkdir(stateDir, { recursive: true });
  return { root, stateDir };
}

type FakeWorkspace = {
  workspace_id: string;
  number: number;
  label: string;
  worktree?: { checkout_path: string; repo_root: string };
  agent_status?: string;
};

class FakeHerdr {
  workspaces: FakeWorkspace[];
  commands: string[][] = [];
  workspaceCreations = 0;
  tabCounter = 0;
  creationDelayMs = 0;

  constructor(workspaces: FakeWorkspace[] = []) {
    this.workspaces = workspaces;
  }

  command: HerdrCommand = async (args) => {
    this.commands.push([...args]);
    if (args[0] === "workspace" && args[1] === "list") {
      return { result: { workspaces: this.workspaces.map((workspace) => ({ ...workspace })) } };
    }
    if (args[0] === "workspace" && args[1] === "create") {
      this.workspaceCreations++;
      if (this.creationDelayMs) await Bun.sleep(this.creationDelayMs);
      const root = args[args.indexOf("--cwd") + 1];
      const label = args[args.indexOf("--label") + 1];
      const workspace = {
        workspace_id: `workspace-${this.workspaceCreations}`,
        number: this.workspaces.length + 1,
        label,
        worktree: { checkout_path: root, repo_root: root },
      };
      this.workspaces.push(workspace);
      const sequence = ++this.tabCounter;
      return {
        result: {
          workspace,
          tab: { tab_id: `tab-${sequence}` },
          root_pane: { pane_id: `pane-${sequence}` },
        },
      };
    }
    if (args[0] === "tab" && args[1] === "create") {
      const sequence = ++this.tabCounter;
      return { result: { tab: { tab_id: `tab-${sequence}` }, root_pane: { pane_id: `pane-${sequence}` } } };
    }
    if (args[0] === "tab" && args[1] === "rename") return { result: { type: "ok" } };
    throw new Error(`unexpected fake Herdr command: ${args.join(" ")}`);
  };
}

function workspace(id: string, root: string, extras: Partial<FakeWorkspace> = {}): FakeWorkspace {
  return {
    workspace_id: id,
    number: 1,
    label: "display-only",
    worktree: { checkout_path: root, repo_root: root },
    ...extras,
  };
}

describe("canonical Herdr project-space placement", () => {
  test("a worker launched by a Herdr supervisor reuses the validated current workspace", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr([
      workspace("workspace-other", item.root, { number: 1 }),
      workspace("workspace-supervisor", item.root, { number: 2 }),
    ]);

    const placement = await placeHerdrTab({
      ...item,
      project: "repo",
      label: "worker-a",
      environment: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "workspace-supervisor",
        HERDR_TAB_ID: "workspace-supervisor:t1",
        HERDR_PANE_ID: "workspace-supervisor:p1",
      },
      command: herdr.command,
    });

    expect(placement.workspaceId).toBe("workspace-supervisor");
    expect(herdr.workspaceCreations).toBe(0);
    expect(herdr.commands).toContainEqual([
      "tab", "create", "--workspace", "workspace-supervisor", "--cwd", item.root,
      "--label", "worker-a", "--no-focus",
    ]);
  });

  test("supervisor and direct worker launch paths select the same canonical workspace", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr();

    const supervisor = await placeHerdrTab({ ...item, project: "repo", label: "supervisor", command: herdr.command });
    const worker = await placeHerdrTab({ ...item, project: "repo", label: "worker-a", command: herdr.command });

    expect(supervisor.workspaceId).toBe("workspace-1");
    expect(worker.workspaceId).toBe(supervisor.workspaceId);
    expect(supervisor.tabId).not.toBe(worker.tabId);
    expect(herdr.workspaceCreations).toBe(1);
  });

  test("a stale current and recorded workspace fall back to a live repository workspace", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr([workspace("workspace-live", item.root)]);
    await mkdir(join(item.stateDir, "herdr"), { recursive: true });
    await writeFile(join(item.stateDir, "herdr", "project-space.v1.json"), JSON.stringify({
      schemaVersion: 1,
      workspaceId: "workspace-recorded-stale",
    }));

    const placement = await placeHerdrTab({
      ...item,
      project: "repo",
      label: "worker-a",
      environment: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-stale" },
      command: herdr.command,
    });

    expect(placement.workspaceId).toBe("workspace-live");
    expect(herdr.workspaceCreations).toBe(0);
  });

  test("does not reuse an unrelated workspace solely because its label matches", async () => {
    const item = await fixture();
    const unrelatedRoot = join(item.root, "..", "unrelated");
    const herdr = new FakeHerdr([
      workspace("workspace-unrelated", unrelatedRoot, { label: "spike:repo" }),
    ]);

    const placement = await placeHerdrTab({ ...item, project: "repo", label: "supervisor", command: herdr.command });

    expect(placement.workspaceId).toBe("workspace-1");
    expect(placement.workspaceId).not.toBe("workspace-unrelated");
    expect(herdr.workspaceCreations).toBe(1);
  });

  test("concurrent first launches create one workspace and separate tabs", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr();
    herdr.creationDelayMs = 60;

    const [first, second] = await Promise.all([
      placeHerdrTab({ ...item, project: "repo", label: "worker-a", command: herdr.command }),
      placeHerdrTab({ ...item, project: "repo", label: "worker-b", command: herdr.command }),
    ]);

    expect(herdr.workspaceCreations).toBe(1);
    expect(first.workspaceId).toBe(second.workspaceId);
    expect(new Set([first.tabId, second.tabId]).size).toBe(2);
  });

  test("reconciliation never closes, moves, or focuses active or unknown spaces", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr([
      workspace("workspace-canonical", item.root, { agent_status: "working" }),
      workspace("workspace-legacy", item.root, { number: 2, agent_status: "unknown" }),
    ]);

    await placeHerdrTab({ ...item, project: "repo", label: "worker-a", command: herdr.command });

    expect(herdr.commands.some((args) => ["close", "move", "focus"].includes(args[1]))).toBe(false);
    expect(herdr.commands.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
  });

  test("placement environment and durable metadata preserve exact runtime IDs", () => {
    const placement = {
      workspaceId: "w9:runtime",
      tabId: "w9:t27",
      paneId: "w9:p43",
    };

    expect(herdrPlacementEnvironment("repo-worker", placement)).toEqual({
      SPIKE_HERDR_NAME: "repo-worker",
      SPIKE_HERDR_WORKSPACE_ID: "w9:runtime",
      SPIKE_HERDR_TAB_ID: "w9:t27",
      SPIKE_HERDR_PANE_ID: "w9:p43",
    });
    expect(herdrPlacementMetadata(placement)).toEqual({
      herdrWorkspaceId: "w9:runtime",
      herdrTabId: "w9:t27",
      herdrPaneId: "w9:p43",
    });
  });
});
