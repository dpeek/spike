import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type HerdrCommand = (args: string[]) => Promise<unknown>;

export type HerdrPlacement = {
  workspaceId: string;
  tabId: string;
  paneId: string;
};

export type HerdrPlacementEnvironment = {
  HERDR_ENV?: string;
  HERDR_WORKSPACE_ID?: string;
  HERDR_TAB_ID?: string;
  HERDR_PANE_ID?: string;
};

// Herdr 0.8 workspace summaries deliberately do not include a cwd. Repository
// identity comes from pane list records, never from labels or imagined fields.
type Workspace = {
  workspace_id?: unknown;
  number?: unknown;
  label?: unknown;
};

type Pane = {
  workspace_id?: unknown;
  tab_id?: unknown;
  pane_id?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
};

type PlacementRecord = {
  schemaVersion: 1;
  workspaceId: string;
};

const placementSchemaVersion = 1;
const lockTimeoutMs = 10_000;
const staleLockMs = 30_000;

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Herdr placement: ${label} is missing`);
  return value as Record<string, any>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Herdr placement: ${label} is missing`);
  return value;
}

function result(value: unknown, label: string): Record<string, any> {
  return object(object(value, `${label} response`).result, `${label} result`);
}

function workspaceId(workspace: Workspace): string | undefined {
  return typeof workspace.workspace_id === "string" && workspace.workspace_id ? workspace.workspace_id : undefined;
}

function pathBelongsToCheckout(value: unknown, root: string): boolean {
  if (typeof value !== "string" || !value || !isAbsolute(value)) return false;
  const candidate = resolve(value);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function paneBelongsToRepository(pane: Pane, root: string): boolean {
  // foreground_cwd is the live process cwd when Herdr can resolve it. Treat it
  // as authoritative so a pane currently operating in another checkout is not
  // claimed from its older terminal cwd.
  if (typeof pane.foreground_cwd === "string" && pane.foreground_cwd) {
    return pathBelongsToCheckout(pane.foreground_cwd, root);
  }
  return pathBelongsToCheckout(pane.cwd, root);
}

/** Labels are intentionally excluded: live pane cwd is project identity. */
function belongsToRepository(workspace: Workspace, panes: Pane[], root: string): boolean {
  const id = workspaceId(workspace);
  return Boolean(id && panes.some((pane) => pane.workspace_id === id && paneBelongsToRepository(pane, root)));
}

function workspaceOrder(left: Workspace, right: Workspace): number {
  const leftNumber = typeof left.number === "number" ? left.number : Number.MAX_SAFE_INTEGER;
  const rightNumber = typeof right.number === "number" ? right.number : Number.MAX_SAFE_INTEGER;
  return leftNumber - rightNumber || String(left.workspace_id).localeCompare(String(right.workspace_id));
}

async function readPlacement(path: string): Promise<PlacementRecord | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Herdr placement: saved project space is invalid JSON"); }
  const record = object(value, "saved project space");
  if (record.schemaVersion !== placementSchemaVersion || typeof record.workspaceId !== "string" || !record.workspaceId) {
    throw new Error("Herdr placement: saved project space is invalid");
  }
  return record as PlacementRecord;
}

async function writePlacement(path: string, workspaceId: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: placementSchemaVersion, workspaceId }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function withPlacementLock<T>(stateDir: string, operation: () => Promise<T>): Promise<T> {
  const directory = join(stateDir, "herdr");
  const path = join(directory, "project-space.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const information = await stat(path);
        if (Date.now() - information.mtimeMs > staleLockMs) {
          await rm(path, { force: true });
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      if (Date.now() >= deadline) throw new Error("Herdr placement: another project-space launch is still in progress");
      await sleep(20);
      continue;
    }
    try { return await operation(); }
    finally {
      await handle.close();
      await rm(path, { force: true });
    }
  }
}

function listedWorkspaces(value: unknown): Workspace[] {
  const workspaces = result(value, "workspace list").workspaces;
  if (!Array.isArray(workspaces)) throw new Error("Herdr placement: workspace list is invalid");
  return workspaces.filter((candidate): candidate is Workspace => Boolean(candidate && typeof candidate === "object" && workspaceId(candidate as Workspace)));
}

function listedPanes(value: unknown): Pane[] {
  const panes = result(value, "pane list").panes;
  if (!Array.isArray(panes)) throw new Error("Herdr placement: pane list is invalid");
  return panes.filter((candidate): candidate is Pane => Boolean(
    candidate && typeof candidate === "object" &&
    typeof (candidate as Pane).workspace_id === "string" &&
    typeof (candidate as Pane).tab_id === "string" &&
    typeof (candidate as Pane).pane_id === "string",
  ));
}

function validCurrentWorkspace(environment: HerdrPlacementEnvironment, workspaces: Workspace[], panes: Pane[], root: string): Workspace | undefined {
  if (environment.HERDR_ENV !== "1") return undefined;
  const currentWorkspaceId = environment.HERDR_WORKSPACE_ID?.trim();
  const currentTabId = environment.HERDR_TAB_ID?.trim();
  const currentPaneId = environment.HERDR_PANE_ID?.trim();
  if (!currentWorkspaceId || !currentTabId || !currentPaneId) return undefined;
  const workspace = workspaces.find((candidate) => workspaceId(candidate) === currentWorkspaceId);
  if (!workspace) return undefined;
  const currentPane = panes.find((pane) =>
    pane.workspace_id === currentWorkspaceId && pane.tab_id === currentTabId && pane.pane_id === currentPaneId);
  return currentPane && paneBelongsToRepository(currentPane, root) ? workspace : undefined;
}

function createdPlacement(value: unknown): HerdrPlacement {
  const creation = result(value, "workspace create");
  return {
    workspaceId: identifier(object(creation.workspace, "created workspace").workspace_id, "created workspace ID"),
    tabId: identifier(object(creation.tab, "created tab").tab_id, "created tab ID"),
    paneId: identifier(object(creation.root_pane, "created root pane").pane_id, "created pane ID"),
  };
}

function createdTab(value: unknown, expectedWorkspaceId: string): HerdrPlacement {
  const creation = result(value, "tab create");
  return {
    workspaceId: expectedWorkspaceId,
    tabId: identifier(object(creation.tab, "created tab").tab_id, "created tab ID"),
    paneId: identifier(object(creation.root_pane, "created root pane").pane_id, "created pane ID"),
  };
}

/**
 * Select the canonical project space and create one labelled tab in it.
 * This is the only reconciliation performed: existing spaces/tabs/panes are
 * never closed, focused, moved, or renamed (apart from a newly-created first tab).
 */
export async function placeHerdrTab(options: {
  root: string;
  stateDir: string;
  project: string;
  label: string;
  environment?: HerdrPlacementEnvironment;
  command: HerdrCommand;
}): Promise<HerdrPlacement> {
  const root = resolve(options.root);
  const recordPath = join(options.stateDir, "herdr", "project-space.v1.json");
  return withPlacementLock(options.stateDir, async () => {
    const workspaces = listedWorkspaces(await options.command(["workspace", "list"]));
    const panes = listedPanes(await options.command(["pane", "list"]));
    const saved = await readPlacement(recordPath);
    const environment = options.environment ?? {};
    const current = validCurrentWorkspace(environment, workspaces, panes, root);
    const recorded = saved
      ? workspaces.find((candidate) => workspaceId(candidate) === saved.workspaceId && belongsToRepository(candidate, panes, root))
      : undefined;
    const discovered = workspaces.filter((candidate) => belongsToRepository(candidate, panes, root)).sort(workspaceOrder)[0];
    const selected = current ?? recorded ?? discovered;

    if (!selected) {
      const placement = createdPlacement(await options.command([
        "workspace", "create", "--cwd", root, "--label", `spike:${options.project}`, "--no-focus",
      ]));
      await writePlacement(recordPath, placement.workspaceId);
      await options.command(["tab", "rename", placement.tabId, options.label]);
      return placement;
    }

    const selectedId = workspaceId(selected)!;
    await writePlacement(recordPath, selectedId);
    return createdTab(await options.command([
      "tab", "create", "--workspace", selectedId, "--cwd", root, "--label", options.label, "--no-focus",
    ]), selectedId);
  });
}

export function herdrPlacementEnvironment(name: string, placement: HerdrPlacement): Record<string, string> {
  return {
    SPIKE_HERDR_NAME: name,
    SPIKE_HERDR_WORKSPACE_ID: placement.workspaceId,
    SPIKE_HERDR_TAB_ID: placement.tabId,
    SPIKE_HERDR_PANE_ID: placement.paneId,
  };
}

export function herdrPlacementMetadata(placement: HerdrPlacement): {
  herdrWorkspaceId: string;
  herdrTabId: string;
  herdrPaneId: string;
} {
  return {
    herdrWorkspaceId: placement.workspaceId,
    herdrTabId: placement.tabId,
    herdrPaneId: placement.paneId,
  };
}
