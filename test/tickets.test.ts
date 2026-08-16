import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_TICKET_BYTES,
  activateGoal,
  issueTicket,
  loadReadyTicket,
  validateActiveTicketPointer,
  validateTicketRecord,
  type TicketRecord,
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

type Fixture = { root: string; goal: string; head: string; ticket: string; bytes: Buffer; goalId: string };

async function fixture(): Promise<Fixture> {
  const createdRoot = await mkdtemp(join(tmpdir(), "spike-ticket-"));
  temporaryDirectories.push(createdRoot);
  const root = await realpath(createdRoot);
  await must(["git", "init", "-b", "main"], root);
  await must(["git", "config", "user.name", "Spike Test"], root);
  await must(["git", "config", "user.email", "spike@example.test"], root);
  const goal = join(root, "doc", "goal.md");
  await mkdir(dirname(goal), { recursive: true });
  await writeFile(goal, "# Approved goal\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), ".pi-swarm/\n");
  await must(["git", "add", "."], root);
  await must(["git", "commit", "-m", "approved goal"], root);
  const active = await activateGoal({ cwd: root, goalFile: goal, approvalStatement: "Approved for ticket tests" });
  const ticket = join(root, ".pi-swarm", "drafts", "003.md");
  const bytes = Buffer.from("# Ticket 003\n\nImplement the exact bounded task.\n", "utf8");
  await mkdir(dirname(ticket), { recursive: true });
  await writeFile(ticket, bytes);
  return { root, goal, head: await must(["git", "rev-parse", "HEAD"], root), ticket, bytes, goalId: active.record.goalId };
}

async function hostSnapshot(root: string) {
  return {
    head: await must(["git", "rev-parse", "HEAD"], root),
    branch: await must(["git", "symbolic-ref", "HEAD"], root),
    refs: (await execute(["git", "for-each-ref", "--format=%(refname)%00%(objectname)"], root)).stdout,
    status: (await execute(["git", "status", "--porcelain=v2", "-z", "--untracked-files=all"], root)).stdout,
    index: await readFile(join(root, ".git", "index")),
    tracked: await readFile(join(root, "tracked.txt")),
  };
}

describe("ready ticket issuance and recovery", () => {
  test("issues exact ignored bytes without touching dirty Git state and is idempotent", async () => {
    const item = await fixture();
    await writeFile(join(item.root, "tracked.txt"), "staged\n");
    await must(["git", "add", "tracked.txt"], item.root);
    await writeFile(join(item.root, "tracked.txt"), "unstaged\n");
    await writeFile(join(item.root, "host-only.txt"), "untracked\n");
    const before = await hostSnapshot(item.root);

    const first = await issueTicket({ cwd: item.root, ticketFile: ".pi-swarm/drafts/003.md", now: new Date("2026-08-17T10:11:12.000Z") });
    expect(first.idempotent).toBe(false);
    expect(first.record.ticketId).toMatch(/^ticket-[0-9a-f]{32}$/);
    expect(first.record.ticketId).not.toContain(item.goalId);
    expect(first.record.goalId).toBe(item.goalId);
    expect(first.record.status).toBe("ready");
    expect(first.record.baseRevision).toBe(item.head);
    expect(first.record.sourcePath).toBe(".pi-swarm/drafts/003.md");
    expect(first.record.issuedAt).toBe("2026-08-17T10:11:12.000Z");
    expect(first.snapshot).toEqual(item.bytes);
    expect(await readFile(join(item.root, first.record.snapshotPath))).toEqual(item.bytes);
    expect(await readFile(join(item.root, first.record.workerPath))).toEqual(item.bytes);
    expect(await hostSnapshot(item.root)).toEqual(before);

    const second = await issueTicket({ cwd: item.root, ticketFile: item.ticket, now: new Date("2030-01-01T00:00:00.000Z") });
    expect(second.idempotent).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(await hostSnapshot(item.root)).toEqual(before);
  });

  test("fresh CLI processes recover snapshot after source edit and removal", async () => {
    const item = await fixture();
    const issued = await execute([process.execPath, cli, "ticket", "issue", ".pi-swarm/drafts/003.md"], item.root);
    expect(issued.code).toBe(0);
    expect(issued.stdout.toString()).toContain("Issued ticket");
    await writeFile(item.ticket, "# Later edit\n");

    const status = await execute([process.execPath, cli, "ticket", "status", "--json"], item.root);
    expect(status.code).toBe(0);
    const record = JSON.parse(status.stdout.toString()) as TicketRecord;
    expect(record.goalId).toBe(item.goalId);
    expect(record.baseRevision).toBe(item.head);
    expect(record.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.workerPath).toContain(`/tickets/${record.ticketId}/ticket.md`);
    await rm(item.ticket);

    const show = await execute([process.execPath, cli, "ticket", "show"], item.root);
    expect(show.code).toBe(0);
    expect(show.stdout).toEqual(item.bytes);
    const text = await execute([process.execPath, cli, "ticket", "status"], item.root);
    expect(text.stdout.toString()).toContain(`Ticket ID: ${record.ticketId}`);
    expect(text.stdout.toString()).toContain(`Goal ID: ${item.goalId}`);
    expect(text.stdout.toString()).toContain(`Worker-visible path: ${record.workerPath}`);
  });

  test("refuses a conflicting ticket without changing the ready ticket or pointer", async () => {
    const item = await fixture();
    const first = await issueTicket({ cwd: item.root, ticketFile: item.ticket });
    const pointerPath = join(item.root, `.pi-swarm/goals/${item.goalId}/active-ticket.json`);
    const recordPath = join(item.root, `.pi-swarm/goals/${item.goalId}/tickets/${first.record.ticketId}/record.v1.json`);
    const pointerBefore = await readFile(pointerPath);
    const recordBefore = await readFile(recordPath);
    const snapshotBefore = await readFile(join(item.root, first.record.snapshotPath));
    await writeFile(item.ticket, "# A conflicting ticket\n");

    await expect(issueTicket({ cwd: item.root, ticketFile: item.ticket })).rejects.toThrow("different ticket is already ready");
    expect(await readFile(pointerPath)).toEqual(pointerBefore);
    expect(await readFile(recordPath)).toEqual(recordBefore);
    expect(await readFile(join(item.root, first.record.snapshotPath))).toEqual(snapshotBefore);
    expect((await loadReadyTicket(item.root)).record.ticketId).toBe(first.record.ticketId);
  });

  test("accepts a canonical repository alias but rejects symlinked paths and escapes", async () => {
    const item = await fixture();
    const aliasParent = await mkdtemp(join(tmpdir(), "spike-ticket-alias-"));
    temporaryDirectories.push(aliasParent);
    const aliasRoot = join(aliasParent, "repository");
    await symlink(item.root, aliasRoot);
    const issued = await issueTicket({ cwd: aliasRoot, ticketFile: ".pi-swarm/drafts/003.md" });
    expect(issued.record.sourcePath).toBe(".pi-swarm/drafts/003.md");

    const linked = await fixture();
    await symlink(linked.ticket, join(linked.root, "linked.md"));
    await expect(issueTicket({ cwd: linked.root, ticketFile: "linked.md" })).rejects.toThrow("symbolic link");
    const outsideDirectory = await mkdtemp(join(tmpdir(), "spike-ticket-outside-"));
    temporaryDirectories.push(outsideDirectory);
    await writeFile(join(outsideDirectory, "outside.md"), "# Outside\n");
    await symlink(outsideDirectory, join(linked.root, "escape"));
    await expect(issueTicket({ cwd: linked.root, ticketFile: "escape/outside.md" })).rejects.toThrow("symbolic links");
    const subAliasParent = await mkdtemp(join(tmpdir(), "spike-ticket-subalias-"));
    temporaryDirectories.push(subAliasParent);
    const subAlias = join(subAliasParent, "drafts");
    await symlink(dirname(linked.ticket), subAlias);
    await expect(issueTicket({ cwd: linked.root, ticketFile: join(subAlias, "003.md") })).rejects.toThrow("symbolic-link alias");
    await expect(issueTicket({ cwd: linked.root, ticketFile: join(outsideDirectory, "outside.md") })).rejects.toThrow("outside the current repository");
  });

  test("rejects missing goal, invalid input, oversize input, and unavailable base", async () => {
    const noGoalRoot = await mkdtemp(join(tmpdir(), "spike-ticket-no-goal-"));
    temporaryDirectories.push(noGoalRoot);
    await must(["git", "init", "-b", "main"], noGoalRoot);
    await must(["git", "config", "user.name", "Spike Test"], noGoalRoot);
    await must(["git", "config", "user.email", "spike@example.test"], noGoalRoot);
    await writeFile(join(noGoalRoot, ".gitignore"), ".pi-swarm/\n");
    await writeFile(join(noGoalRoot, "seed"), "seed\n");
    await must(["git", "add", "."], noGoalRoot);
    await must(["git", "commit", "-m", "seed"], noGoalRoot);
    await writeFile(join(noGoalRoot, "ticket.md"), "# ticket\n");
    await expect(issueTicket({ cwd: noGoalRoot, ticketFile: "ticket.md" })).rejects.toThrow("no active goal");

    const item = await fixture();
    await expect(issueTicket({ cwd: item.root, ticketFile: "missing.md" })).rejects.toThrow("does not exist");
    await writeFile(join(item.root, "ticket.txt"), "# ticket\n");
    await expect(issueTicket({ cwd: item.root, ticketFile: "ticket.txt" })).rejects.toThrow("must be Markdown");
    await writeFile(item.ticket, " \n\t");
    await expect(issueTicket({ cwd: item.root, ticketFile: item.ticket })).rejects.toThrow("must not be empty");
    await mkdir(join(item.root, "directory.md"));
    await expect(issueTicket({ cwd: item.root, ticketFile: "directory.md" })).rejects.toThrow("not a regular file");
    await writeFile(item.ticket, Buffer.alloc(MAX_TICKET_BYTES + 1, 97));
    await expect(issueTicket({ cwd: item.root, ticketFile: item.ticket })).rejects.toThrow("exceeds");

    const unavailable = await fixture();
    const goalRecordPath = join(unavailable.root, `.pi-swarm/goals/${unavailable.goalId}/record.v1.json`);
    const goalRecord = JSON.parse(await readFile(goalRecordPath, "utf8"));
    goalRecord.acceptedCodeRevision = "f".repeat(40);
    await writeFile(goalRecordPath, JSON.stringify(goalRecord));
    await expect(issueTicket({ cwd: unavailable.root, ticketFile: unavailable.ticket })).rejects.toThrow("not an available commit");
  });
});

describe("ready ticket state validation", () => {
  test("pure validators reject schema, path, goal, base, and stable identity corruption", async () => {
    const item = await fixture();
    const ready = await issueTicket({ cwd: item.root, ticketFile: item.ticket });
    const goalDirectory = join(item.root, ".pi-swarm", "goals", item.goalId);
    const expected = { root: item.root, goalId: item.goalId, goalDirectory, acceptedCodeRevision: item.head };
    expect(validateTicketRecord(ready.record, expected)).toEqual(ready.record);
    expect(() => validateTicketRecord({ ...ready.record, schemaVersion: 2 }, expected)).toThrow("unsupported ticket record schema");
    expect(() => validateTicketRecord({ ...ready.record, goalId: `goal-${"a".repeat(32)}` }, expected)).toThrow("active goal");
    expect(() => validateTicketRecord({ ...ready.record, baseRevision: "e".repeat(40) }, expected)).toThrow("base revision");
    expect(() => validateTicketRecord({ ...ready.record, snapshotPath: "../ticket.md" }, expected)).toThrow("snapshotPath");
    expect(() => validateTicketRecord({ ...ready.record, workerPath: "ticket.md" }, expected)).toThrow("workerPath");
    expect(() => validateTicketRecord({ ...ready.record, snapshotSha256: "0".repeat(64) }, expected)).toThrow("stable identity");

    const pointer = JSON.parse(await readFile(join(goalDirectory, "active-ticket.json"), "utf8"));
    expect(validateActiveTicketPointer(pointer, { root: item.root, goalId: item.goalId, goalDirectory })).toEqual(pointer);
    expect(() => validateActiveTicketPointer({ ...pointer, schemaVersion: 8 }, { root: item.root, goalId: item.goalId, goalDirectory })).toThrow("unsupported");
    expect(() => validateActiveTicketPointer({ ...pointer, goalId: `goal-${"b".repeat(32)}` }, { root: item.root, goalId: item.goalId, goalDirectory })).toThrow("active goal");
    expect(() => validateActiveTicketPointer({ ...pointer, recordPath: "../record.json" }, { root: item.root, goalId: item.goalId, goalDirectory })).toThrow("recordPath");
  });

  test("fails closed for no ticket and corrupt pointer, record, snapshots, worker copy, and symlinked state", async () => {
    const empty = await fixture();
    await expect(loadReadyTicket(empty.root)).rejects.toThrow("no ready ticket");

    const badPointer = await fixture();
    await writeFile(join(badPointer.root, `.pi-swarm/goals/${badPointer.goalId}/active-ticket.json`), "not json\n");
    await expect(loadReadyTicket(badPointer.root)).rejects.toThrow("invalid JSON");

    const corruptRecord = await fixture();
    const corruptReady = await issueTicket({ cwd: corruptRecord.root, ticketFile: corruptRecord.ticket });
    const recordPath = join(corruptRecord.root, `.pi-swarm/goals/${corruptRecord.goalId}/tickets/${corruptReady.record.ticketId}/record.v1.json`);
    await writeFile(recordPath, JSON.stringify({ ...corruptReady.record, status: "running" }));
    await expect(loadReadyTicket(corruptRecord.root)).rejects.toThrow("invalid status");

    const tamperedSnapshot = await fixture();
    const snapshotReady = await issueTicket({ cwd: tamperedSnapshot.root, ticketFile: tamperedSnapshot.ticket });
    await writeFile(join(tamperedSnapshot.root, snapshotReady.record.snapshotPath), "tampered snapshot\n");
    await expect(loadReadyTicket(tamperedSnapshot.root)).rejects.toThrow("snapshot integrity check failed");

    const tamperedWorker = await fixture();
    const workerReady = await issueTicket({ cwd: tamperedWorker.root, ticketFile: tamperedWorker.ticket });
    await writeFile(join(tamperedWorker.root, workerReady.record.workerPath), "tampered worker\n");
    await expect(loadReadyTicket(tamperedWorker.root)).rejects.toThrow("worker-visible ticket copy integrity check failed");

    const symlinked = await fixture();
    const symlinkReady = await issueTicket({ cwd: symlinked.root, ticketFile: symlinked.ticket });
    const workerPath = join(symlinked.root, symlinkReady.record.workerPath);
    await rm(workerPath);
    await symlink(symlinked.ticket, workerPath);
    await expect(loadReadyTicket(symlinked.root)).rejects.toThrow("symbolic links");
  });
});
