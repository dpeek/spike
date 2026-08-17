import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// These deliberately mirror Herdr 0.8's live API: workspace summaries have no
// cwd/worktree identity, while pane records carry cwd and foreground_cwd.
type FakeWorkspace = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: string;
};

type FakePane = {
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  cwd: string;
  foreground_cwd: string | null;
};

class FakeHerdr {
  workspaces: FakeWorkspace[];
  panes: FakePane[];
  commands: string[][] = [];
  workspaceCreations = 0;
  tabCounter = 0;
  creationDelayMs = 0;

  constructor(workspaces: FakeWorkspace[] = [], panes: FakePane[] = []) {
    this.workspaces = workspaces;
    this.panes = panes;
  }

  command: HerdrCommand = async (args) => {
    this.commands.push([...args]);
    if (args[0] === "workspace" && args[1] === "list") {
      return { result: { type: "workspace_list", workspaces: this.workspaces.map((workspace) => ({ ...workspace })) } };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return { result: { type: "pane_list", panes: this.panes.map((pane) => ({ ...pane })) } };
    }
    if (args[0] === "workspace" && args[1] === "create") {
      this.workspaceCreations++;
      if (this.creationDelayMs) await Bun.sleep(this.creationDelayMs);
      const root = args[args.indexOf("--cwd") + 1];
      const label = args[args.indexOf("--label") + 1];
      const sequence = ++this.tabCounter;
      const workspaceId = `w-created-${this.workspaceCreations}`;
      const tabId = `${workspaceId}:t${sequence}`;
      const paneId = `${workspaceId}:p${sequence}`;
      const createdWorkspace = workspace(workspaceId, this.workspaces.length + 1, { label, active_tab_id: tabId });
      this.workspaces.push(createdWorkspace);
      this.panes.push(pane(workspaceId, tabId, paneId, root));
      return {
        result: {
          workspace: createdWorkspace,
          tab: { tab_id: tabId },
          root_pane: { pane_id: paneId },
        },
      };
    }
    if (args[0] === "tab" && args[1] === "create") {
      const workspaceId = args[args.indexOf("--workspace") + 1];
      const root = args[args.indexOf("--cwd") + 1];
      const sequence = ++this.tabCounter;
      const tabId = `${workspaceId}:t${sequence}`;
      const paneId = `${workspaceId}:p${sequence}`;
      this.panes.push(pane(workspaceId, tabId, paneId, root));
      return { result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } } };
    }
    if (args[0] === "tab" && args[1] === "rename") return { result: { type: "ok" } };
    throw new Error(`unexpected fake Herdr command: ${args.join(" ")}`);
  };
}

function workspace(id: string, number: number, extras: Partial<FakeWorkspace> = {}): FakeWorkspace {
  return {
    workspace_id: id,
    number,
    label: "display-only",
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${id}:t1`,
    agent_status: "unknown",
    ...extras,
  };
}

function pane(workspaceId: string, tabId: string, paneId: string, cwd: string, extras: Partial<FakePane> = {}): FakePane {
  return {
    workspace_id: workspaceId,
    tab_id: tabId,
    pane_id: paneId,
    cwd,
    foreground_cwd: cwd,
    ...extras,
  };
}

describe("canonical Herdr project-space placement", () => {
  test("selects the current real-shape w2 supervisor without creating a workspace", async () => {
    const item = await fixture();
    const unrelatedRoot = join(item.root, "..", "unrelated");
    const herdr = new FakeHerdr(
      [workspace("w1", 1), workspace("w2", 2, { focused: true, label: "spike" })],
      [
        pane("w1", "w1:t1", "w1:p1", unrelatedRoot),
        pane("w2", "w2:t1", "w2:p1", item.root, { foreground_cwd: join(item.root, "src") }),
      ],
    );

    const placement = await placeHerdrTab({
      ...item,
      project: "repo",
      label: "worker-a",
      environment: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w2",
        HERDR_TAB_ID: "w2:t1",
        HERDR_PANE_ID: "w2:p1",
      },
      command: herdr.command,
    });

    expect(placement.workspaceId).toBe("w2");
    expect(herdr.workspaceCreations).toBe(0);
    expect(herdr.commands.slice(0, 2)).toEqual([["workspace", "list"], ["pane", "list"]]);
    expect(herdr.commands).toContainEqual([
      "tab", "create", "--workspace", "w2", "--cwd", item.root,
      "--label", "worker-a", "--no-focus",
    ]);
  });

  test("supervisor and direct worker launch paths select the same canonical workspace", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr();

    const supervisor = await placeHerdrTab({ ...item, project: "repo", label: "supervisor", command: herdr.command });
    const worker = await placeHerdrTab({ ...item, project: "repo", label: "worker-a", command: herdr.command });

    expect(supervisor.workspaceId).toBe("w-created-1");
    expect(worker.workspaceId).toBe(supervisor.workspaceId);
    expect(supervisor.tabId).not.toBe(worker.tabId);
    expect(herdr.workspaceCreations).toBe(1);
  });

  test("stale current and recorded workspaces fall back through live pane cwd", async () => {
    const item = await fixture();
    const herdr = new FakeHerdr(
      [workspace("w-live", 1)],
      [pane("w-live", "w-live:t1", "w-live:p1", item.root)],
    );
    await mkdir(join(item.stateDir, "herdr"), { recursive: true });
    await writeFile(join(item.stateDir, "herdr", "project-space.v1.json"), JSON.stringify({
      schemaVersion: 1,
      workspaceId: "w-recorded-stale",
    }));

    const placement = await placeHerdrTab({
      ...item,
      project: "repo",
      label: "worker-a",
      environment: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w-current-stale",
        HERDR_TAB_ID: "w-current-stale:t1",
        HERDR_PANE_ID: "w-current-stale:p1",
      },
      command: herdr.command,
    });

    expect(placement.workspaceId).toBe("w-live");
    expect(herdr.workspaceCreations).toBe(0);
  });

  test("rejects mismatched current workspace, tab, and pane identities", async () => {
    const item = await fixture();
    const unrelatedRoot = join(item.root, "..", "unrelated");
    const herdr = new FakeHerdr(
      [workspace("w2", 1), workspace("w3", 2)],
      [
        pane("w2", "w2:t1", "w2:p1", unrelatedRoot),
        pane("w3", "w3:t1", "w3:p1", item.root),
      ],
    );

    const placement = await placeHerdrTab({
      ...item,
      project: "repo",
      label: "worker-a",
      environment: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w2",
        HERDR_TAB_ID: "w3:t1",
        HERDR_PANE_ID: "w3:p1",
      },
      command: herdr.command,
    });

    expect(placement.workspaceId).toBe("w3");
    expect(herdr.workspaceCreations).toBe(0);
  });

  test("does not reuse an unrelated matching-label workspace or sibling linked checkout", async () => {
    const item = await fixture();
    const linkedCheckout = join(item.root, "..", "repo-feature");
    const herdr = new FakeHerdr(
      [workspace("w-linked", 1, { label: "spike:repo" })],
      [pane("w-linked", "w-linked:t1", "w-linked:p1", linkedCheckout)],
    );

    const placement = await placeHerdrTab({ ...item, project: "repo", label: "supervisor", command: herdr.command });

    expect(placement.workspaceId).toBe("w-created-1");
    expect(placement.workspaceId).not.toBe("w-linked");
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
    const herdr = new FakeHerdr(
      [
        workspace("w-canonical", 1, { agent_status: "working" }),
        workspace("w-legacy", 2, { agent_status: "unknown" }),
      ],
      [
        pane("w-canonical", "w-canonical:t1", "w-canonical:p1", item.root),
        pane("w-legacy", "w-legacy:t1", "w-legacy:p1", item.root),
      ],
    );

    await placeHerdrTab({ ...item, project: "repo", label: "worker-a", command: herdr.command });

    expect(herdr.commands.some((args) => ["close", "move", "focus"].includes(args[1]))).toBe(false);
    expect(herdr.commands.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
  });

  test("placement environment and durable metadata preserve exact runtime IDs", () => {
    const placement = {
      workspaceId: "w9",
      tabId: "w9:t27",
      paneId: "w9:p43",
    };

    expect(herdrPlacementEnvironment("repo-worker", placement)).toEqual({
      SPIKE_HERDR_NAME: "repo-worker",
      SPIKE_HERDR_WORKSPACE_ID: "w9",
      SPIKE_HERDR_TAB_ID: "w9:t27",
      SPIKE_HERDR_PANE_ID: "w9:p43",
    });
    expect(herdrPlacementMetadata(placement)).toEqual({
      herdrWorkspaceId: "w9",
      herdrTabId: "w9:t27",
      herdrPaneId: "w9:p43",
    });
  });
});
