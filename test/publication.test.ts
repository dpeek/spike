import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLatestPublication,
  publishBranch,
  validatePublicationManifest,
  type CommandResult,
  type CommandRunner,
  type PublicationAgentState,
  type PublicationContext,
} from "../src/publication.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function execute(command: string[], cwd?: string): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function executeWithEnv(command: string[], cwd: string, env: Record<string, string | undefined>): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function must(command: string[], cwd?: string): Promise<string> {
  const result = await execute(command, cwd);
  if (result.code !== 0) throw new Error(`${command.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

type Fixture = {
  root: string;
  worker: string;
  context: PublicationContext;
  state: PublicationAgentState;
  run: CommandRunner;
  runtimeCommands: string[][];
  base: string;
};

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "spike-publication-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "host");
  const worker = join(directory, "worker");
  await mkdir(root);
  await must(["git", "init", "-b", "main"], root);
  await must(["git", "config", "user.name", "Spike Test"], root);
  await must(["git", "config", "user.email", "spike@example.test"], root);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, ".gitignore"), ".pi-swarm/\n");
  await must(["git", "add", "tracked.txt", ".gitignore"], root);
  await must(["git", "commit", "-m", "base"], root);
  const base = await must(["git", "rev-parse", "HEAD"], root);

  await must(["git", "clone", root, worker], directory);
  await must(["git", "config", "user.name", "Worker"], worker);
  await must(["git", "config", "user.email", "worker@example.test"], worker);
  await must(["git", "switch", "-c", "agent/frontend"], worker);
  await must(["git", "config", "spike.agentBase", base], worker);
  await writeFile(join(worker, "worker.txt"), "published\n");
  await must(["git", "add", "worker.txt"], worker);
  await must(["git", "commit", "-m", "worker change"], worker);

  const stateDir = join(root, ".pi-swarm");
  await mkdir(join(stateDir, "output"), { recursive: true });
  const runtimeCommands: string[][] = [];
  const run: CommandRunner = async (command, cwd) => {
    if ((command[0] === "docker" || command[0] === "container") && command[1] === "exec") {
      runtimeCommands.push(command);
      if (command[2] !== "--user" || command[3] !== "node" || command[4] !== "recorded-container") {
        return { code: 2, stdout: "", stderr: "invalid runtime exec command shape" };
      }
      const translated = command.slice(5).map((argument) => {
        if (argument === "/workspace/project") return worker;
        if (argument.startsWith("/output/")) return join(stateDir, "output", argument.slice("/output/".length));
        return argument;
      });
      return execute(translated, cwd);
    }
    return execute(command, cwd);
  };
  return {
    root,
    worker,
    context: { root, stateDir, project: "host" },
    state: {
      slug: "frontend",
      project: "host",
      runtime: "docker",
      container: "recorded-container",
      backend: "herdr",
    },
    run,
    runtimeCommands,
    base,
  };
}

async function hostSnapshot(root: string) {
  return {
    head: await must(["git", "rev-parse", "HEAD"], root),
    branch: await must(["git", "symbolic-ref", "HEAD"], root),
    status: (await execute(["git", "status", "--porcelain=v2", "-z", "--untracked-files=all"], root)).stdout,
    index: await readFile(join(root, ".git", "index")),
    tracked: await readFile(join(root, "tracked.txt"), "utf8"),
  };
}

describe("publication manifests", () => {
  test("validates identity, schema, commits, and confined paths", async () => {
    const root = "/tmp/project";
    const directory = "/tmp/project/.pi-swarm/output/branches/frontend";
    const valid = {
      schemaVersion: 1,
      project: "project",
      agent: "frontend",
      workerBranch: "agent/frontend",
      base: "1".repeat(40),
      head: "2".repeat(40),
      importedRef: "refs/spike/agents/frontend",
      bundlePath: ".pi-swarm/output/branches/frontend/" + "2".repeat(40) + ".bundle",
      publishedAt: "2026-08-16T00:00:00.000Z",
    };
    expect(validatePublicationManifest(valid, { root, project: "project", agent: "frontend", publicationDirectory: directory })).toEqual(valid);
    expect(() => validatePublicationManifest({ ...valid, schemaVersion: 2 }, { root, project: "project", agent: "frontend", publicationDirectory: directory })).toThrow("unsupported");
    expect(() => validatePublicationManifest({ ...valid, bundlePath: "../escape.bundle" }, { root, project: "project", agent: "frontend", publicationDirectory: directory })).toThrow("escapes");
    expect(() => validatePublicationManifest({ ...valid, importedRef: "refs/heads/main" }, { root, project: "project", agent: "frontend", publicationDirectory: directory })).toThrow("imported ref");
  });
});

describe("worker branch publication", () => {
  test("publishes a verified bundle without touching a dirty host checkout and is idempotent", async () => {
    const item = await fixture();
    await writeFile(join(item.root, "tracked.txt"), "staged host edit\n");
    await must(["git", "add", "tracked.txt"], item.root);
    await writeFile(join(item.root, "tracked.txt"), "unstaged host edit\n");
    await writeFile(join(item.root, "untracked.txt"), "untracked host edit\n");
    const before = await hostSnapshot(item.root);

    const first = await publishBranch(item.context, item.state, item.run, () => new Date("2026-08-16T01:00:00.000Z"));
    expect(first.idempotent).toBe(false);
    expect(item.runtimeCommands.length > 0).toBe(true);
    expect(item.runtimeCommands.every((command) => command.slice(0, 5).join("\0") === ["docker", "exec", "--user", "node", "recorded-container"].join("\0"))).toBe(true);
    expect(first.base).toBe(item.base);
    expect(first.head).toBe(await must(["git", "rev-parse", "HEAD"], item.worker));
    expect(await must(["git", "rev-parse", first.importedRef], item.root)).toBe(first.head);
    expect((await execute(["git", "bundle", "verify", join(item.root, first.bundlePath)], item.root)).code).toBe(0);
    expect(await hostSnapshot(item.root)).toEqual(before);

    const second = await publishBranch(item.context, item.state, item.run, () => new Date("2027-01-01T00:00:00.000Z"));
    expect(second.idempotent).toBe(true);
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(second.manifestPath).toBe(first.manifestPath);
    expect(await hostSnapshot(item.root)).toEqual(before);

    const loaded = await loadLatestPublication(item.context, "frontend", item.run);
    expect(loaded.head).toBe(first.head);
    expect(loaded.base).toBe(first.base);

    // Diff and review use only the durable host publication, even if agent state
    // says the worker has stopped.
    const stateDirectory = join(item.context.stateDir, "agents");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "frontend.json"), JSON.stringify({ ...item.state, finishedAt: new Date().toISOString() }));
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const diff = await executeWithEnv([process.execPath, cli, "agent", "diff", "frontend", "--", "--stat"], item.root, { ...process.env, REPO_SEED: item.root });
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain(`Published change: ${first.base}...${first.head}`);
    expect(diff.stdout).toContain("worker.txt");

    const fakeBin = join(item.root, "fake-bin");
    const hunkLog = join(item.root, "hunk.log");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "hunk"), "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$*\" > \"$HUNK_LOG\"\n", { mode: 0o755 });
    const review = await executeWithEnv([process.execPath, cli, "agent", "review", "frontend"], item.root, {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      REPO_SEED: item.root,
      HUNK_LOG: hunkLog,
    });
    expect(review.code).toBe(0);
    expect(review.stdout).toContain(`Reviewing: ${first.base}...${first.head}`);
    const [hunkCwd, hunkArguments] = (await readFile(hunkLog, "utf8")).trimEnd().split("\n");
    expect(await realpath(hunkCwd)).toBe(await realpath(item.root));
    expect(hunkArguments).toBe(`diff ${first.base}...${first.importedRef}`);
  });

  test("uses the Apple runtime boundary and advances only to a fast-forward worker head", async () => {
    const item = await fixture();
    item.state.runtime = "apple";
    const first = await publishBranch(item.context, item.state, item.run);
    expect(item.runtimeCommands.length > 0).toBe(true);
    expect(item.runtimeCommands.every((command) => command.slice(0, 5).join("\0") === ["container", "exec", "--user", "node", "recorded-container"].join("\0"))).toBe(true);
    await writeFile(join(item.worker, "second.txt"), "second\n");
    await must(["git", "add", "second.txt"], item.worker);
    await must(["git", "commit", "-m", "second worker change"], item.worker);
    const second = await publishBranch(item.context, item.state, item.run);
    expect(second.head).not.toBe(first.head);
    expect(second.base).toBe(first.base);
    expect(await must(["git", "merge-base", "--is-ancestor", first.head, second.head], item.root)).toBe("");
    expect(await must(["git", "rev-parse", second.importedRef], item.root)).toBe(second.head);
    expect((await loadLatestPublication(item.context, "frontend", item.run)).head).toBe(second.head);
  });

  test("refuses a dirty worker before creating a successful publication record", async () => {
    const item = await fixture();
    await writeFile(join(item.worker, "dirty.txt"), "not committed\n");
    await expect(publishBranch(item.context, item.state, item.run)).rejects.toThrow("uncommitted or untracked");
    expect((await execute(["git", "rev-parse", "--verify", "refs/spike/agents/frontend"], item.root)).code).not.toBe(0);
    expect(await Bun.file(join(item.context.stateDir, "output", "branches", "frontend", "latest.json")).exists()).toBe(false);
  });

  test("rejects a non-fast-forward publication without moving the ref or latest pointer", async () => {
    const item = await fixture();
    const first = await publishBranch(item.context, item.state, item.run, () => new Date("2026-08-16T01:00:00.000Z"));
    const latestBefore = await readFile(join(item.root, first.latestManifestPath), "utf8");

    await must(["git", "reset", "--hard", item.base], item.worker);
    await writeFile(join(item.worker, "replacement.txt"), "divergent\n");
    await must(["git", "add", "replacement.txt"], item.worker);
    await must(["git", "commit", "-m", "divergent worker change"], item.worker);
    const divergentHead = await must(["git", "rev-parse", "HEAD"], item.worker);
    expect(divergentHead).not.toBe(first.head);

    await expect(publishBranch(item.context, item.state, item.run)).rejects.toThrow("non-fast-forward");
    expect(await must(["git", "rev-parse", first.importedRef], item.root)).toBe(first.head);
    expect(await readFile(join(item.root, first.latestManifestPath), "utf8")).toBe(latestBefore);
  });

  test("refuses detached, stopped, non-persistent, and empty worker branches", async () => {
    const detached = await fixture();
    await must(["git", "checkout", "--detach"], detached.worker);
    await expect(publishBranch(detached.context, detached.state, detached.run)).rejects.toThrow("detached");

    const stopped = await fixture();
    await expect(publishBranch(stopped.context, { ...stopped.state, finishedAt: new Date().toISOString() }, stopped.run)).rejects.toThrow("stopped");
    await expect(publishBranch(stopped.context, { ...stopped.state, backend: "headless" }, stopped.run)).rejects.toThrow("not Herdr-backed");

    const empty = await fixture();
    await must(["git", "reset", "--hard", empty.base], empty.worker);
    await expect(publishBranch(empty.context, empty.state, empty.run)).rejects.toThrow("no commits beyond its base");
  });
});
