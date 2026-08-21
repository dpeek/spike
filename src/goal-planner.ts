import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadProjectConfig } from "./config.ts";
import { discoverRepository } from "./git.ts";
import { listGoalIds, loadGoal } from "./goal.ts";
import { type HerdrAgentStatus, herdrOperations, type HerdrHandles, type HerdrOperations } from "./herdr.ts";
import { goalPlannerToolNames } from "./pi-supervisor-extension.ts";

export type GoalPlannerIdentity = { projectIdentity: string; goalId: string; name: string };
export type GoalPlannerObservation = GoalPlannerIdentity & {
  resources: Array<HerdrHandles & { status: HerdrAgentStatus }>;
  state: "live" | "stale" | "absent" | "duplicate" | "unavailable";
};

/** The fixed Project-supervisor admission limit. It is deliberately not config. */
export const maximumActiveGoalPlanners = 2;
export type GoalPlannerOperations = {
  startOrReattach(input: GoalPlannerInput): Promise<GoalPlannerObservation>;
  observe(input: GoalPlannerInput): Promise<GoalPlannerObservation>;
  attach(input: GoalPlannerInput): Promise<number>;
  replace(input: GoalPlannerInput): Promise<GoalPlannerObservation>;
};
export type GoalPlannerInput = {
  cwd: string;
  goalId: string;
  herdr?: HerdrOperations;
  piExecutable?: string;
  spikeExecutable?: string;
};

const liveStatuses = new Set<HerdrAgentStatus>(["idle", "working", "blocked", "unknown"]);

function opaque(value: string, field: string): string {
  if (!/^\S+$/.test(value)) throw new Error(`Goal planner has an invalid ${field} handle`);
  return value;
}

/** This display name is also Pi's session name and Herdr's exact tab label.
 * The digest prevents slug collisions while retaining a readable Goal prefix. */
export function goalPlannerIdentity(projectIdentity: string, goalId: string): GoalPlannerIdentity {
  if (typeof projectIdentity !== "string" || !projectIdentity.trim()) throw new Error("Project identity must not be blank");
  if (typeof goalId !== "string" || !goalId.trim()) throw new Error("Goal ID must not be blank");
  const digest = createHash("sha256").update(projectIdentity, "utf8").digest("hex").slice(0, 16);
  return { projectIdentity, goalId, name: `spike-goal-${goalId}-${digest}` };
}

async function selected(input: GoalPlannerInput): Promise<{ root: string; identity: GoalPlannerIdentity }> {
  if (typeof input.goalId !== "string" || !input.goalId.trim()) throw new Error("Goal ID must not be blank");
  const repository = await discoverRepository(input.cwd);
  // Loading proves both existence and Project qualification before Herdr lookup.
  await loadGoal(repository.root, input.goalId);
  return { root: repository.root, identity: goalPlannerIdentity(repository.identity, input.goalId) };
}

async function observation(identity: GoalPlannerIdentity, herdr: HerdrOperations): Promise<GoalPlannerObservation> {
  if (herdr.findTabsByLabel === undefined) throw new Error("Herdr does not support exact planner discovery");
  const handles = await herdr.findTabsByLabel(identity.name);
  const resources = await Promise.all(handles.map(async (resource) => {
    const tab = opaque(resource.tab, "tab");
    const pane = opaque(resource.pane, "pane");
    let status: HerdrAgentStatus;
    try { status = await herdr.status(pane); } catch { status = "unavailable"; }
    return { tab, pane, status };
  }));
  const live = resources.filter((resource) => liveStatuses.has(resource.status));
  return {
    ...identity,
    resources,
    state: live.length > 1
      ? "duplicate"
      : live.length === 1
        ? "live"
        : resources.length === 0
          ? "absent"
          : resources.every((resource) => resource.status === "unavailable")
            ? "unavailable"
            : "stale",
  };
}

async function otherPlannerObservations(
  root: string,
  identity: GoalPlannerIdentity,
  herdr: HerdrOperations,
): Promise<GoalPlannerObservation[]> {
  // Enumerate only durable, Project-qualified Goal IDs and derive each exact
  // label. Prefix matching a mutable terminal label would grant cross-Goal
  // authority, so it is never used for admission.
  const observations: GoalPlannerObservation[] = [];
  for (const goalId of await listGoalIds(root)) {
    if (goalId === identity.goalId) continue;
    observations.push(await observation(goalPlannerIdentity(identity.projectIdentity, goalId), herdr));
  }
  return observations;
}

function assertAdmissionCapacity(
  current: GoalPlannerObservation,
  others: GoalPlannerObservation[],
): void {
  const duplicate = others.find((other) => other.state === "duplicate");
  if (duplicate !== undefined) {
    throw new Error(`multiple live Goal planners found for ${duplicate.name}; refusing ambiguous Project planner admission`);
  }
  const liveOthers = others.filter((other) => other.state === "live");
  const activeCount = liveOthers.length + (current.state === "live" ? 1 : 0);
  if (activeCount >= maximumActiveGoalPlanners && current.state !== "live") {
    throw new Error(`Goal planner admission limit of ${maximumActiveGoalPlanners} is reached; refusing another Project planner`);
  }
  if (activeCount > maximumActiveGoalPlanners) {
    throw new Error(`more than ${maximumActiveGoalPlanners} live Goal planners found; refusing ambiguous Project planner admission`);
  }
}

async function close(resources: GoalPlannerObservation["resources"], herdr: HerdrOperations): Promise<void> {
  // Herdr closeTab is idempotent. Sequential closing makes an operator-visible
  // replacement deterministic and never closes an unrelated label.
  for (const resource of resources) await herdr.closeTab(opaque(resource.tab, "tab"));
}

function shellArgument(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("planner launch argument is invalid");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function launch(selectedGoal: { root: string; identity: GoalPlannerIdentity }, input: GoalPlannerInput, herdr: HerdrOperations): Promise<GoalPlannerObservation> {
  const selection = (await loadProjectConfig(selectedGoal.root)).agents.planner;
  const tab = await herdr.createTab({
    cwd: selectedGoal.root,
    label: selectedGoal.identity.name,
    environment: {
      SPIKE_GOAL_ID: selectedGoal.identity.goalId,
      SPIKE_PROJECT_IDENTITY: selectedGoal.identity.projectIdentity,
      SPIKE_PLANNER_NAME: selectedGoal.identity.name,
      SPIKE_BIN: input.spikeExecutable ?? process.env["SPIKE_BIN"] ?? resolve(import.meta.dir, "..", "bin", "spike"),
    },
  });
  const handles = { tab: opaque(tab.tab, "tab"), pane: opaque(tab.pane, "pane") };
  const extension = resolve(import.meta.dir, "pi-goal-planner-extension.ts");
  const pi = input.piExecutable ?? process.env["SPIKE_PI_BIN"] ?? "pi";
  const command = [
    pi, "--name", selectedGoal.identity.name, "--model", selection.model, "--thinking", selection.thinking,
    "--no-approve", "--no-extensions", "--extension", extension,
    "--tools", ["read", "grep", "find", "ls", ...goalPlannerToolNames].join(","),
  ].map(shellArgument).join(" ");
  try {
    await herdr.run(handles.pane, command);
  } catch (error) {
    await herdr.closeTab(handles.tab).catch(() => undefined);
    throw error;
  }
  // The just-created opaque handles are an operational projection; no terminal
  // text, Pi session data, or process exit is consulted.
  let status: HerdrAgentStatus;
  try { status = await herdr.status(handles.pane); } catch { status = "unavailable"; }
  return { ...selectedGoal.identity, resources: [{ ...handles, status }], state: liveStatuses.has(status) ? "live" : "stale" };
}

export const goalPlannerOperations: GoalPlannerOperations = {
  async observe(input) {
    const target = await selected(input);
    return observation(target.identity, input.herdr ?? herdrOperations);
  },
  async startOrReattach(input) {
    const target = await selected(input);
    const herdr = input.herdr ?? herdrOperations;
    const current = await observation(target.identity, herdr);
    if (current.state === "duplicate") throw new Error(`multiple live Goal planners found for ${target.identity.name}; refusing to choose or close either`);
    // Admission is fully derived from exact Herdr discovery. In particular it
    // happens before selected stale tabs are closed, a tab is created, Pi is
    // launched, or any workflow path/ref is touched.
    assertAdmissionCapacity(current, await otherPlannerObservations(target.root, target.identity, herdr));
    if (current.state === "live") return current;
    if (current.state === "stale" || current.state === "unavailable") await close(current.resources, herdr);
    return launch(target, input, herdr);
  },
  async attach(input) {
    const target = await selected(input);
    const current = await observation(target.identity, input.herdr ?? herdrOperations);
    if (current.state === "duplicate") throw new Error(`multiple live Goal planners found for ${target.identity.name}; refusing to attach`);
    const live = current.resources.find((resource) => liveStatuses.has(resource.status));
    if (live === undefined) throw new Error(`Goal planner ${target.identity.name} is not live`);
    return (input.herdr ?? herdrOperations).attach(live.pane);
  },
  async replace(input) {
    const target = await selected(input);
    const herdr = input.herdr ?? herdrOperations;
    const current = await observation(target.identity, herdr);
    // Replacement keeps the selected Goal's one owner. At capacity its old
    // owner counts as the selected slot, so closing it then launching its
    // replacement is permitted without touching the other Goal's resources.
    assertAdmissionCapacity(current, await otherPlannerObservations(target.root, target.identity, herdr));
    await close(current.resources, herdr);
    return launch(target, input, herdr);
  },
};
