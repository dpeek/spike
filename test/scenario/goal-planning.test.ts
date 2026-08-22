import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChange, loadChange } from "../../src/change.ts";
import { createGoal, integratedRef, loadGoal } from "../../src/goal.ts";
import { loadPlan, planPath, revisePlan } from "../../src/plan.ts";
import { loadTicket } from "../../src/ticket.ts";
import { temporaryRepository } from "../support/repository.ts";


describe("Goal planning", () => {
  test("creates an approved Goal, initial Plan, and integration ref at HEAD", async () => {
    const repository = await temporaryRepository();
    const nested = join(repository.root, "somewhere", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(repository.root, "operator-notes.txt"), "leave me dirty\n");

    const created = await createGoal({
      cwd: nested,
      hostPaths: repository.hostPaths,
      title: "Replace the workflow",
      outcome: "Spike lands reviewed Changes as one commit each.",
      approval: "Approved by the operator.",
      constraints: ["Keep the default suite fast."],
      repositoryIdentity: "example/spike",
      now: new Date("2026-03-19T10:00:00.000Z"),
    });
    const goalId = created.goal.metadata.goalId;

    expect(goalId).toBe("spike-001");
    expect(created.goal.metadata).toEqual({
      kind: "goal",
      goalId,
      approvedAt: "2026-03-19T10:00:00.000Z",
      repository: { identity: "example/spike", initialRevision: repository.head },
    });
    expect((await loadGoal(repository.project, goalId)).body).toContain("## Operator approval\n\nApproved by the operator.");

    const plan = await loadPlan(repository.project, goalId);
    expect(plan.metadata).toEqual({
      kind: "plan",
      goalId,
      updatedAt: "2026-03-19T10:00:00.000Z",
    });
    expect(plan.body).toContain("## Change direction\n\nNo Change selected yet; later ideas remain tentative.");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(repository.head);
    expect(await readFile(join(repository.root, "operator-notes.txt"), "utf8")).toBe("leave me dirty\n");
  });

  test("allocates Project-qualified Goal IDs monotonically and rejects a changed slug", async () => {
    const repository = await temporaryRepository();

    const first = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "First Goal",
      outcome: "Allocate the first Project Goal.",
      approval: "Approved.",
    });
    expect(first.goal.metadata.goalId).toBe("spike-001");

    await mkdir(join(repository.projectRoot, "goals", "spike-002"), { recursive: true });
    const third = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Third Goal",
      outcome: "Do not reuse an interrupted allocation.",
      approval: "Approved.",
    });
    expect(third.goal.metadata.goalId).toBe("spike-003");

    await mkdir(join(repository.projectRoot, "goals", "spike-999"), { recursive: true });
    await expect(
      createGoal({
        cwd: repository.root, hostPaths: repository.hostPaths, title: "Exhausted Goal",
        outcome: "Do not widen the sequence silently.",
        approval: "Approved.",
      }),
    ).rejects.toThrow("Project spike has exhausted its three-digit Goal sequence");

    const configPath = join(repository.root, "spike.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.project.slug = "renamed";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await expect(loadGoal(repository.project, "spike-001")).rejects.toThrow(
      "Goal spike-001 does not belong to Project renamed",
    );
  });

  test("rejects durable access after the Project slug changes", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Stable Project identity",
      outcome: "Keep the Goal associated with its allocating Project.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const change = await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Protect durable access",
      intent: "Reject access through a renamed Project.",
      rationale: "Project identity is stable after Goal allocation.",
      acceptanceCriteria: ["Durable aggregate access validates the configured Project slug."],
    });
    const originalPlan = await readFile(planPath(repository.project, goalId), "utf8");

    const configPath = join(repository.root, "spike.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.project.slug = "renamed";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const mismatch = "Goal spike-001 does not belong to Project renamed";
    await expect(loadGoal(repository.project, goalId)).rejects.toThrow(mismatch);
    await expect(loadPlan(repository.project, goalId)).rejects.toThrow(mismatch);
    await expect(loadChange(repository.project, goalId, change.change.metadata.changeId)).rejects.toThrow(mismatch);
    await expect(revisePlan(repository.project, goalId, "# Invalid revision\n")).rejects.toThrow(mismatch);
    expect(await readFile(planPath(repository.project, goalId), "utf8")).toBe(originalPlan);
  });

  test("starts Goal sequences independently for different Projects", async () => {
    const repository = await temporaryRepository();
    const configPath = join(repository.root, "spike.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.project.slug = "formless";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Formless Goal",
      outcome: "Allocate within the Formless Project.",
      approval: "Approved.",
    });
    expect(goal.goal.metadata.goalId).toBe("formless-001");
  });

  test("creates the first slice through the terminal", async () => {
    const repository = await temporaryRepository();
    const spike = join(import.meta.dir, "..", "..", "bin", "spike");
    const child = Bun.spawn(
      [spike, "goal", "create", "--title", "Terminal Goal", "--outcome", "Create durable records.", "--approval", "Approved."],
      { cwd: repository.root, env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot }, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const goalId = stdout.match(/spike-[0-9]{3}/)?.[0];
    expect(goalId).toBeDefined();
    expect(await Bun.file(join(repository.projectRoot, "goals", goalId!, "goal.md")).exists()).toBe(true);
    expect(await Bun.file(join(repository.projectRoot, "goals", goalId!, "plan.md")).exists()).toBe(true);
    expect(await Bun.file(join(repository.root, ".spike")).exists()).toBe(false);

    const change = Bun.spawn(
      [
        spike,
        "change",
        "create",
        "--goal",
        goalId!,
        "--title",
        "Terminal Change",
        "--intent",
        "Freeze worker selection.",
        "--rationale",
        "Dispatch must reproduce the assignment.",
        "--acceptance",
        "The Ticket records its model selection.",
      ],
      { cwd: repository.root, env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot }, stdout: "ignore", stderr: "pipe" },
    );
    expect(await change.exited).toBe(0);

    const ticket = Bun.spawn(
      [
        spike,
        "ticket",
        "issue",
        "--goal",
        goalId!,
        "--change",
        "001",
        "--instruction",
        "Implement the selection.",
        "--network-access",
        "none",
        "--model",
        "one-ticket-model",
        "--thinking",
        "low",
      ],
      { cwd: repository.root, env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot }, stdout: "ignore", stderr: "pipe" },
    );
    expect(await ticket.exited).toBe(0);
    expect((await loadTicket(repository.project, goalId!, "001", "001")).metadata).toMatchObject({
      model: "one-ticket-model",
      thinking: "low",
    });
  });
});
