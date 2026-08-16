import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateGoal,
  loadActiveGoal,
  validateActiveGoalPointer,
  validateGoalRecord,
  type GoalRecord,
} from "../src/goals.ts";

const temporaryDirectories: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type CommandResult = { code: number; stdout: Buffer; stderr: string };

async function execute(command: string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: Buffer.from(stdout), stderr: stderr.trim() };
}

async function must(command: string[], cwd: string): Promise<string> {
  const result = await execute(command, cwd);
  if (result.code !== 0) throw new Error(`${command.join(" ")}: ${result.stderr || result.stdout.toString()}`);
  return result.stdout.toString("utf8").trim();
}

type Fixture = { root: string; goal: string; head: string; blob: string; approved: Buffer };

async function fixture(): Promise<Fixture> {
  const createdRoot = await mkdtemp(join(tmpdir(), "spike-goal-"));
  temporaryDirectories.push(createdRoot);
  const root = await realpath(createdRoot);
  await must(["git", "init", "-b", "main"], root);
  await must(["git", "config", "user.name", "Spike Test"], root);
  await must(["git", "config", "user.email", "spike@example.test"], root);
  const approved = Buffer.from("# Approved goal\n\nPreserve these exact bytes.\n", "utf8");
  const goal = join(root, "docs", "goal.md");
  await mkdir(dirname(goal), { recursive: true });
  await writeFile(goal, approved);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), ".pi-swarm/\n");
  await must(["git", "add", ".gitignore", "docs/goal.md", "tracked.txt"], root);
  await must(["git", "commit", "-m", "approved goal"], root);
  return {
    root,
    goal,
    head: await must(["git", "rev-parse", "HEAD"], root),
    blob: await must(["git", "rev-parse", "HEAD:docs/goal.md"], root),
    approved,
  };
}

async function hostSnapshot(root: string) {
  return {
    head: await must(["git", "rev-parse", "HEAD"], root),
    branch: await must(["git", "symbolic-ref", "HEAD"], root),
    status: (await execute(["git", "status", "--porcelain=v2", "-z", "--untracked-files=all"], root)).stdout,
    index: await readFile(join(root, ".git", "index")),
    tracked: await readFile(join(root, "tracked.txt")),
  };
}

async function activateWithCli(item: Fixture, approval = "Operator approves this exact revision.") {
  return execute([process.execPath, cli, "goal", "activate", "docs/goal.md", "--approval", approval], item.root);
}

describe("durable goal activation", () => {
  test("records Git provenance and exact approved bytes without touching a dirty host checkout", async () => {
    const item = await fixture();
    await writeFile(join(item.root, "tracked.txt"), "staged host change\n");
    await must(["git", "add", "tracked.txt"], item.root);
    await writeFile(join(item.root, "tracked.txt"), "unstaged host change\n");
    await writeFile(join(item.root, "untracked.txt"), "untracked host change\n");
    const before = await hostSnapshot(item.root);
    const approval = "  Approved verbatim.\nSecond line.  ";

    const first = await activateGoal({
      cwd: item.root,
      goalFile: "docs/goal.md",
      approvalStatement: approval,
      now: new Date("2026-08-16T12:00:00.000Z"),
    });
    expect(first.idempotent).toBe(false);
    expect(first.record.goalId).toMatch(/^goal-[0-9a-f]{32}$/);
    expect(first.record.goalId).not.toContain(item.blob);
    expect(first.record.status).toBe("active");
    expect(first.record.repositoryRoot).toBe(item.root);
    expect(first.record.repositoryRevision).toBe(item.head);
    expect(first.record.acceptedCodeRevision).toBe(item.head);
    expect(first.record.goalPath).toBe("docs/goal.md");
    expect(first.record.approvedBlob).toBe(item.blob);
    expect(first.record.approvalStatement).toBe(approval);
    expect(first.record.activatedAt).toBe("2026-08-16T12:00:00.000Z");
    expect(first.snapshot).toEqual(item.approved);
    expect(await hostSnapshot(item.root)).toEqual(before);
    expect((await execute(["git", "status", "--short"], item.root)).stdout.toString()).not.toContain(".pi-swarm");

    const second = await activateGoal({ cwd: item.root, goalFile: item.goal, approvalStatement: approval });
    expect(second.idempotent).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(await hostSnapshot(item.root)).toEqual(before);

    const pointer = JSON.parse(await readFile(join(item.root, ".pi-swarm", "goals", "active.json"), "utf8"));
    expect(pointer.goalId).toBe(first.record.goalId);
    expect(pointer.recordPath).toBe(`.pi-swarm/goals/${first.record.goalId}/record.v1.json`);
  });

  test("accepts absolute and relative paths through a canonical repository alias", async () => {
    const item = await fixture();
    const aliasParent = await mkdtemp(join(tmpdir(), "spike-goal-alias-"));
    temporaryDirectories.push(aliasParent);
    const aliasRoot = join(aliasParent, "repository");
    await symlink(item.root, aliasRoot);

    const first = await activateGoal({
      cwd: item.root,
      goalFile: join(aliasRoot, "docs", "goal.md"),
      approvalStatement: "approved through canonical alias",
    });
    expect(first.record.repositoryRoot).toBe(await realpath(item.root));
    expect(first.record.goalPath).toBe("docs/goal.md");

    const second = await activateGoal({
      cwd: aliasRoot,
      goalFile: "docs/goal.md",
      approvalStatement: "approved through canonical alias",
    });
    expect(second.idempotent).toBe(true);
    expect(second.record.goalId).toBe(first.record.goalId);
  });

  test("fresh CLI processes recover metadata and show the snapshot after the source changes", async () => {
    const item = await fixture();
    const approval = "Operator explicitly approved goal 002.";
    const activation = await activateWithCli(item, approval);
    expect(activation.code).toBe(0);
    expect(activation.stdout.toString()).toContain("Activated goal");

    await writeFile(item.goal, "# A later unapproved edit\n");
    const status = await execute([process.execPath, cli, "goal", "status", "--json"], item.root);
    expect(status.code).toBe(0);
    const metadata = JSON.parse(status.stdout.toString());
    expect(metadata.approvalStatement).toBe(approval);
    expect(metadata.approvedBlob).toBe(item.blob);
    expect(metadata.repositoryRevision).toBe(item.head);
    expect(metadata.acceptedCodeRevision).toBe(item.head);

    const show = await execute([process.execPath, cli, "goal", "show"], item.root);
    expect(show.code).toBe(0);
    expect(show.stdout).toEqual(item.approved);
    const textStatus = await execute([process.execPath, cli, "goal", "status"], item.root);
    expect(textStatus.stdout.toString()).toContain(`Goal ID: ${metadata.goalId}`);
    expect(textStatus.stdout.toString()).toContain(`Approval statement: ${approval}`);
  });

  test("refuses a conflicting active goal without changing durable state", async () => {
    const item = await fixture();
    const first = await activateGoal({ cwd: item.root, goalFile: item.goal, approvalStatement: "Approve first" });
    const pointerPath = join(item.root, ".pi-swarm", "goals", "active.json");
    const pointerBefore = await readFile(pointerPath);
    const recordBefore = await readFile(join(item.root, `.pi-swarm/goals/${first.record.goalId}/record.v1.json`));

    const conflict = await activateWithCli(item, "A different approval creates a different goal");
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("different goal is already active");
    expect(await readFile(pointerPath)).toEqual(pointerBefore);
    expect(await readFile(join(item.root, `.pi-swarm/goals/${first.record.goalId}/record.v1.json`))).toEqual(recordBefore);
    expect((await loadActiveGoal(item.root)).record.goalId).toBe(first.record.goalId);
  });

  test("rejects dirty, untracked, outside, symlink, missing, non-file, and non-Markdown inputs", async () => {
    const dirty = await fixture();
    await writeFile(dirty.goal, "dirty\n");
    await expect(activateGoal({ cwd: dirty.root, goalFile: dirty.goal, approvalStatement: "approved" })).rejects.toThrow("uncommitted changes");

    const untracked = await fixture();
    await writeFile(join(untracked.root, "untracked.md"), "# no\n");
    await expect(activateGoal({ cwd: untracked.root, goalFile: "untracked.md", approvalStatement: "approved" })).rejects.toThrow("not tracked");

    const outside = await fixture();
    const outsideFile = join(dirname(outside.root), "outside-goal.md");
    await writeFile(outsideFile, "# outside\n");
    await expect(activateGoal({ cwd: outside.root, goalFile: outsideFile, approvalStatement: "approved" })).rejects.toThrow("outside the current repository");
    await rm(outsideFile, { force: true });

    const linked = await fixture();
    await symlink("docs/goal.md", join(linked.root, "linked.md"));
    await expect(activateGoal({ cwd: linked.root, goalFile: "linked.md", approvalStatement: "approved" })).rejects.toThrow("symbolic link");
    await symlink("docs", join(linked.root, "linked-docs"));
    await expect(activateGoal({ cwd: linked.root, goalFile: "linked-docs/goal.md", approvalStatement: "approved" })).rejects.toThrow("symbolic links");
    const escapeTarget = await mkdtemp(join(tmpdir(), "spike-goal-escape-"));
    temporaryDirectories.push(escapeTarget);
    await writeFile(join(escapeTarget, "outside.md"), "# outside\n");
    await symlink(escapeTarget, join(linked.root, "escape"));
    await expect(activateGoal({ cwd: linked.root, goalFile: "escape/outside.md", approvalStatement: "approved" })).rejects.toThrow("symbolic links");
    const subdirectoryAliasParent = await mkdtemp(join(tmpdir(), "spike-goal-subdir-alias-"));
    temporaryDirectories.push(subdirectoryAliasParent);
    const subdirectoryAlias = join(subdirectoryAliasParent, "docs");
    await symlink(join(linked.root, "docs"), subdirectoryAlias);
    await expect(activateGoal({ cwd: linked.root, goalFile: join(subdirectoryAlias, "goal.md"), approvalStatement: "approved" })).rejects.toThrow("symbolic-link alias");

    const nonMarkdown = await fixture();
    await expect(activateGoal({ cwd: nonMarkdown.root, goalFile: "tracked.txt", approvalStatement: "approved" })).rejects.toThrow("must be Markdown");
    await expect(activateGoal({ cwd: nonMarkdown.root, goalFile: "missing.md", approvalStatement: "approved" })).rejects.toThrow("does not exist");
    await mkdir(join(nonMarkdown.root, "directory.md"));
    await expect(activateGoal({ cwd: nonMarkdown.root, goalFile: "directory.md", approvalStatement: "approved" })).rejects.toThrow("not a regular file");
    await expect(activateGoal({ cwd: nonMarkdown.root, goalFile: nonMarkdown.goal, approvalStatement: "  " })).rejects.toThrow("non-empty");

    const notIgnored = await fixture();
    await writeFile(join(notIgnored.root, ".gitignore"), "");
    await expect(activateGoal({ cwd: notIgnored.root, goalFile: notIgnored.goal, approvalStatement: "approved" })).rejects.toThrow("is not ignored");
    expect(await Bun.file(join(notIgnored.root, ".pi-swarm")).exists()).toBe(false);
  });

  test("rejects dirty goal bytes even when Git marks the path assume-unchanged", async () => {
    const item = await fixture();
    await must(["git", "update-index", "--assume-unchanged", "docs/goal.md"], item.root);
    await writeFile(item.goal, "# hidden dirty goal\n");
    expect((await execute(["git", "diff", "--quiet", "HEAD", "--", "docs/goal.md"], item.root)).code).toBe(0);

    await expect(activateGoal({
      cwd: item.root,
      goalFile: item.goal,
      approvalStatement: "must not approve hidden changes",
    })).rejects.toThrow("uncommitted changes");
    expect(await Bun.file(join(item.root, ".pi-swarm")).exists()).toBe(false);
  });
});

describe("goal state validation", () => {
  test("pure validators reject unsupported schemas, bad paths, and identity mismatches", async () => {
    const item = await fixture();
    const active = await activateGoal({ cwd: item.root, goalFile: item.goal, approvalStatement: "approved" });
    const record = active.record;
    const goalsDir = join(item.root, ".pi-swarm", "goals");
    const expected = { root: item.root, projectId: record.projectId, goalId: record.goalId, goalsDir };
    expect(validateGoalRecord(record, expected)).toEqual(record);
    expect(() => validateGoalRecord({ ...record, schemaVersion: 9 }, expected)).toThrow("unsupported goal record schema");
    expect(() => validateGoalRecord({ ...record, goalPath: "../outside.md" }, expected)).toThrow("escapes");
    expect(() => validateGoalRecord({ ...record, snapshotPath: "docs/goal.md" }, expected)).toThrow("snapshotPath");
    expect(() => validateGoalRecord({ ...record, approvalStatement: "changed" }, expected)).toThrow("stable identity");

    const pointer = JSON.parse(await readFile(join(goalsDir, "active.json"), "utf8"));
    expect(validateActiveGoalPointer(pointer, { root: item.root, projectId: record.projectId, goalsDir })).toEqual(pointer);
    expect(() => validateActiveGoalPointer({ ...pointer, schemaVersion: 2 }, { root: item.root, projectId: record.projectId, goalsDir })).toThrow("unsupported");
    expect(() => validateActiveGoalPointer({ ...pointer, recordPath: "../record.json" }, { root: item.root, projectId: record.projectId, goalsDir })).toThrow("recordPath");
    expect(() => validateActiveGoalPointer({ ...pointer, goalId: `goal-${"f".repeat(32)}` }, { root: item.root, projectId: record.projectId, goalsDir })).toThrow("recordPath");
  });

  test("fails closed for no state, corrupt JSON, pointer mismatch, record corruption, and snapshot tampering", async () => {
    const empty = await fixture();
    await expect(loadActiveGoal(empty.root)).rejects.toThrow("no active goal");

    const badPointer = await fixture();
    await mkdir(join(badPointer.root, ".pi-swarm", "goals"), { recursive: true });
    await writeFile(join(badPointer.root, ".pi-swarm", "goals", "active.json"), "not json\n");
    await expect(loadActiveGoal(badPointer.root)).rejects.toThrow("invalid JSON");

    const mismatch = await fixture();
    const mismatchActive = await activateGoal({ cwd: mismatch.root, goalFile: mismatch.goal, approvalStatement: "approved" });
    const mismatchPointer = join(mismatch.root, ".pi-swarm", "goals", "active.json");
    const pointer = JSON.parse(await readFile(mismatchPointer, "utf8"));
    pointer.goalId = `goal-${"e".repeat(32)}`;
    await writeFile(mismatchPointer, JSON.stringify(pointer));
    await expect(loadActiveGoal(mismatch.root)).rejects.toThrow("recordPath");
    expect(mismatchActive.record.goalId).not.toBe(pointer.goalId);

    const corruptRecord = await fixture();
    const corruptActive = await activateGoal({ cwd: corruptRecord.root, goalFile: corruptRecord.goal, approvalStatement: "approved" });
    const recordPath = join(corruptRecord.root, `.pi-swarm/goals/${corruptActive.record.goalId}/record.v1.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as GoalRecord;
    await writeFile(recordPath, JSON.stringify({ ...record, status: "complete" }));
    await expect(loadActiveGoal(corruptRecord.root)).rejects.toThrow("invalid status");

    const tampered = await fixture();
    const tamperedActive = await activateGoal({ cwd: tampered.root, goalFile: tampered.goal, approvalStatement: "approved" });
    await writeFile(join(tampered.root, tamperedActive.record.snapshotPath), "tampered\n");
    await expect(loadActiveGoal(tampered.root)).rejects.toThrow("integrity check failed");
  });

  test("rejects symlinks in recorded state paths", async () => {
    const item = await fixture();
    const active = await activateGoal({ cwd: item.root, goalFile: item.goal, approvalStatement: "approved" });
    const snapshotPath = join(item.root, active.record.snapshotPath);
    await rm(snapshotPath);
    await symlink(item.goal, snapshotPath);
    await expect(loadActiveGoal(item.root)).rejects.toThrow("symbolic links");
  });
});
