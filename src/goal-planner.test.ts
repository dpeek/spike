import { describe, expect, test } from "bun:test";
import { createGoal } from "./goal.ts";
import { goalPlannerIdentity, goalPlannerOperations } from "./goal-planner.ts";
import type { HerdrAgentStatus, HerdrHandles, HerdrOperations } from "./herdr.ts";
import { temporaryRepository } from "../test/support/repository.ts";


function fakeHerdr(resources: Array<HerdrHandles & { label: string; status: HerdrAgentStatus }>) {
  const calls: string[] = [];
  let created = 0;
  const herdr: HerdrOperations = {
    async createTab(input) {
      calls.push(`create:${input.label}`);
      created += 1;
      const suffix = created === 1 ? "" : `-${created}`;
      const resource = { tab: `new-tab${suffix}`, pane: `new-pane${suffix}`, label: input.label, status: "working" as const };
      resources.push(resource);
      return resource;
    },
    async splitPane() { throw new Error("not called"); },
    async run(pane, command) { calls.push(`run:${pane}:${command}`); },
    async status(pane) { return resources.find((resource) => resource.pane === pane)?.status ?? "unavailable"; },
    async read() { return ""; },
    async attach(pane) { calls.push(`attach:${pane}`); return 0; },
    async closePane() { throw new Error("not called"); },
    async closeTab(tab) {
      calls.push(`close:${tab}`);
      const index = resources.findIndex((resource) => resource.tab === tab);
      if (index >= 0) resources.splice(index, 1);
    },
    async findTabsByLabel(label) {
      calls.push(`find:${label}`);
      return resources.filter((resource) => resource.label === label).map((resource) => ({ ...resource, paneCount: 1 }));
    },
  };
  return { herdr, calls };
}

async function fixture() {
  const repository = await temporaryRepository();
  const created = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Goal", outcome: "Bound planners.", approval: "Approved." });
  return { repository, goalId: created.goal.metadata.goalId };
}

describe("Goal planner ownership", () => {
  test("uses a stable repository-qualified identity and reattaches without launch", async () => {
    const { repository, goalId } = await fixture();
    const identity = goalPlannerIdentity("file://other/repository", goalId);
    expect(identity.name).toContain(goalId);
    expect(goalPlannerIdentity("file://other/repository", goalId)).toEqual(identity);
    expect(goalPlannerIdentity("file://different/repository", goalId).name).not.toBe(identity.name);

    const actual = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    // Local test repository identity is its canonical git-common directory.
    const { herdr, calls } = fakeHerdr([{ tab: "tab-1", pane: "pane-1", label: actual.name, status: "working" }]);
    const result = await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    expect(result.state).toBe("live");
    expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("run:"))).toBe(false);
  });

  test("launches one persistent named scoped Pi and cleans stale resources", async () => {
    const { repository, goalId } = await fixture();
    const identity = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    const { herdr, calls } = fakeHerdr([{ tab: "old-tab", pane: "old-pane", label: identity.name, status: "done" }]);
    const result = await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr, piExecutable: "pi binary'; touch never" });
    expect(result).toMatchObject({ state: "live", resources: [{ tab: "new-tab", pane: "new-pane" }] });
    expect(calls).toContain("close:old-tab");
    const command = calls.find((call) => call.startsWith("run:"))!;
    expect(command).toContain("--name");
    expect(command).toContain(identity.name);
    expect(command).toContain("'pi binary'\\''; touch never'");
    expect(command).toContain("pi-goal-planner-extension.ts");
    expect(command).toContain("spike_create_change");
    expect(command).not.toContain("spike_create_goal");
  });

  test("refuses duplicate live resources without close or launch and replacement closes all", async () => {
    const { repository, goalId } = await fixture();
    const identity = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    const { herdr, calls } = fakeHerdr([
      { tab: "tab-1", pane: "pane-1", label: identity.name, status: "working" },
      { tab: "tab-2", pane: "pane-2", label: identity.name, status: "idle" },
    ]);
    await expect(goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr })).rejects.toThrow("multiple live Goal planners");
    expect(calls.some((call) => call.startsWith("close:") || call.startsWith("create:"))).toBe(false);
    await goalPlannerOperations.replace({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    expect(calls).toEqual(expect.arrayContaining(["close:tab-1", "close:tab-2"]));
  });

  test("admits two distinct Goals and replaces one at capacity without disturbing the other", async () => {
    const { repository, goalId } = await fixture();
    const other = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Other", outcome: "Run independently.", approval: "Approved." });
    const identity = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    const otherIdentity = goalPlannerIdentity(`file://${repository.root}/.git`, other.goal.metadata.goalId);
    const { herdr, calls } = fakeHerdr([
      { tab: "selected-tab", pane: "selected-pane", label: identity.name, status: "working" },
      { tab: "other-tab", pane: "other-pane", label: otherIdentity.name, status: "working" },
    ]);

    expect((await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr })).state).toBe("live");
    await goalPlannerOperations.replace({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    expect(calls).toContain("close:selected-tab");
    expect(calls).not.toContain("close:other-tab");
    expect(calls.some((call) => call.startsWith(`create:${identity.name}`))).toBe(true);
  });

  test("reconstructs zero, one, and two admissions after restart before refusing a third", async () => {
    const { repository, goalId } = await fixture();
    const second = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Second", outcome: "Run independently.", approval: "Approved." });
    const third = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Third", outcome: "Be refused.", approval: "Approved." });
    const { herdr, calls } = fakeHerdr([]);
    await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: second.goal.metadata.goalId, herdr });
    const createsAtCapacity = calls.filter((call) => call.startsWith("create:")).length;
    // A fresh operation object has no remembered admission record; discovery
    // finds the two exact labels and reattaches the selected one.
    expect((await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr })).state).toBe("live");
    expect(calls.filter((call) => call.startsWith("create:")).length).toBe(createsAtCapacity);
    await expect(goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: third.goal.metadata.goalId, herdr }))
      .rejects.toThrow("admission limit of 2");
  });

  test("refuses a third planner before stale cleanup, creation, launch, or workflow mutation", async () => {
    const { repository, goalId } = await fixture();
    const second = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Second", outcome: "Run independently.", approval: "Approved." });
    const third = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Third", outcome: "Be refused.", approval: "Approved." });
    const identity = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    const secondIdentity = goalPlannerIdentity(`file://${repository.root}/.git`, second.goal.metadata.goalId);
    const thirdIdentity = goalPlannerIdentity(`file://${repository.root}/.git`, third.goal.metadata.goalId);
    const { herdr, calls } = fakeHerdr([
      { tab: "stale-selected", pane: "stale-pane", label: identity.name, status: "done" },
      { tab: "second-tab", pane: "second-pane", label: secondIdentity.name, status: "working" },
      { tab: "third-tab", pane: "third-pane", label: thirdIdentity.name, status: "idle" },
    ]);

    await expect(goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr }))
      .rejects.toThrow("admission limit of 2");
    await expect(goalPlannerOperations.replace({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr }))
      .rejects.toThrow("admission limit of 2");
    expect(calls.filter((call) => call.startsWith("close:") || call.startsWith("create:") || call.startsWith("run:"))).toEqual([]);
  });

  test("repeated stale cleanup and replacement close only matching resources once", async () => {
    const { repository, goalId } = await fixture();
    const identity = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    const { herdr, calls } = fakeHerdr([{ tab: "stale-tab", pane: "stale-pane", label: identity.name, status: "done" }]);
    await goalPlannerOperations.startOrReattach({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    await goalPlannerOperations.replace({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    await goalPlannerOperations.replace({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr });
    expect(calls.filter((call) => call === "close:stale-tab")).toEqual(["close:stale-tab"]);
    expect(calls.filter((call) => call.startsWith("close:new-tab"))).toEqual(["close:new-tab", "close:new-tab-2"]);
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(3);
  });

  test("does not replace a planner while its Goal tab owns a worker pane", async () => {
    const { repository, goalId } = await fixture();
    const identity = goalPlannerIdentity(`file://${repository.root}/.git`, goalId);
    const { herdr, calls } = fakeHerdr([{ tab: "goal-tab", pane: "planner-pane", label: identity.name, status: "working" }]);
    const withWorker: HerdrOperations = {
      ...herdr,
      async findTabsByLabel(label) {
        return label === identity.name ? [{ tab: "goal-tab", pane: "planner-pane", paneCount: 2 }] : [];
      },
    };

    await expect(goalPlannerOperations.replace({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr: withWorker }))
      .rejects.toThrow("active sibling pane");
    expect(calls.some((call) => call.startsWith("close:") || call.startsWith("create:") || call.startsWith("run:"))).toBe(false);
  });

  test("refuses unknown Goals before Herdr side effects and malformed handles", async () => {
    const { repository } = await fixture();
    const { herdr, calls } = fakeHerdr([]);
    await expect(goalPlannerOperations.observe({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: "spike-999", herdr })).rejects.toThrow();
    expect(calls).toEqual([]);
    const goalId = "spike-001";
    const bad: HerdrOperations = { ...herdr, findTabsByLabel: async () => [{ tab: "bad tab", pane: "pane", paneCount: 1 }] };
    await expect(goalPlannerOperations.observe({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, herdr: bad })).rejects.toThrow("invalid tab handle");
  });
});
