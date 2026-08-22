import { describe, expect, test } from "bun:test";
import { createGoal } from "./goal.ts";
import { goalPlannerIdentity } from "./goal-planner.ts";
import { deriveSupervisorPlannerStatus } from "./status.ts";
import type { HerdrOperations } from "./herdr.ts";
import { temporaryRepository } from "../test/support/repository.ts";


describe("supervisor planner status", () => {
  test("keeps durable multi-Goal state separate from exact operational observations", async () => {
    const repository = await temporaryRepository();
    const first = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "First", outcome: "First outcome.", approval: "Approved." });
    const second = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Second", outcome: "Second outcome.", approval: "Approved." });
    const firstIdentity = goalPlannerIdentity(`file://${repository.root}/.git`, first.goal.metadata.goalId);
    const herdr: HerdrOperations = {
      async findTabsByLabel(label) { return label === firstIdentity.name ? [{ tab: "tab-1", pane: "pane-1" }] : []; },
      async status() { return "working"; }, async createTab() { throw new Error("not called"); },
      async run() { throw new Error("not called"); }, async read() { return ""; }, async attach() { return 0; }, async closeTab() {},
    };
    const status = await deriveSupervisorPlannerStatus(repository.root, repository.hostPaths, herdr);
    expect(status.durable.goals.map((goal) => goal.goalId)).toEqual([first.goal.metadata.goalId, second.goal.metadata.goalId]);
    expect(status.durable.goals.every((goal) => goal.cleanup.healthy)).toBe(true);
    expect(status.planners).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalId: first.goal.metadata.goalId, state: "live" }),
      expect.objectContaining({ goalId: second.goal.metadata.goalId, state: "absent" }),
    ]));
  });

  test("Herdr discovery failure is unavailable operational data, not durable cleanup failure", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Only", outcome: "Preserve durable state.", approval: "Approved." });
    const herdr: HerdrOperations = {
      async findTabsByLabel() { throw new Error("Herdr unavailable"); }, async status() { return "unavailable"; },
      async createTab() { throw new Error("not called"); }, async run() { throw new Error("not called"); },
      async read() { return ""; }, async attach() { return 0; }, async closeTab() {},
    };
    const status = await deriveSupervisorPlannerStatus(repository.root, repository.hostPaths, herdr);
    expect(status.planners[0]).toMatchObject({ goalId: goal.goal.metadata.goalId, state: "unavailable", resources: [] });
    expect(status.durable.goals[0]!.cleanup.healthy).toBe(true);
    expect(status.durable.cleanup.healthy).toBe(true);
  });
});
