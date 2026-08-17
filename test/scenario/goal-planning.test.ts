import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGoal, integratedRef, loadGoal } from "../../src/goal.ts";
import { loadPlan } from "../../src/plan.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("Goal planning", () => {
  test("creates an approved Goal, initial Plan, and integration ref at HEAD", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const nested = join(repository.root, "somewhere", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(repository.root, "operator-notes.txt"), "leave me dirty\n");

    const created = await createGoal({
      cwd: nested,
      title: "Replace the workflow",
      outcome: "Spike lands reviewed Changes as one commit each.",
      approval: "Approved by the operator.",
      constraints: ["Keep the default suite fast."],
      repositoryIdentity: "example/spike",
      now: new Date("2026-03-19T10:00:00.000Z"),
    });
    const goalId = created.goal.metadata.goalId;

    expect(goalId).toMatch(/^goal-[0-9a-f]{32}$/);
    expect(created.goal.metadata).toEqual({
      kind: "goal",
      goalId,
      approvedAt: "2026-03-19T10:00:00.000Z",
      repository: { identity: "example/spike", initialRevision: repository.head },
    });
    expect((await loadGoal(repository.root, goalId)).body).toContain("## Operator approval\n\nApproved by the operator.");

    const plan = await loadPlan(repository.root, goalId);
    expect(plan.metadata).toEqual({ kind: "plan", goalId, updatedAt: "2026-03-19T10:00:00.000Z" });
    expect(plan.body).toContain("## Planned Changes\n\nNo Changes planned yet.");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(repository.head);
    expect(await readFile(join(repository.root, "operator-notes.txt"), "utf8")).toBe("leave me dirty\n");
  });

  test("creates the first slice through the terminal", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const spike = join(import.meta.dir, "..", "..", "bin", "spike");
    const child = Bun.spawn(
      [spike, "goal", "create", "--title", "Terminal Goal", "--outcome", "Create durable records.", "--approval", "Approved."],
      { cwd: repository.root, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const goalId = stdout.match(/goal-[0-9a-f]{32}/)?.[0];
    expect(goalId).toBeDefined();
    expect(await Bun.file(join(repository.root, ".spike", "goals", goalId!, "goal.md")).exists()).toBe(true);
    expect(await Bun.file(join(repository.root, ".spike", "goals", goalId!, "plan.md")).exists()).toBe(true);
  });
});
