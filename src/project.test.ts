import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkflowDirectory } from "./durable-state.ts";
import { git } from "./git.ts";
import { activateProject, projectDirectory, projectRegistrationPath, repositoryIdentity, resolveProject } from "./project.ts";
import { exchangePath, workerRecordPath } from "./worker.ts";
import { temporaryRepository } from "../test/support/repository.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function isolatedRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-project-data-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function withDataRoot<T>(data: string, operation: () => Promise<T>): Promise<T> {
  const old = process.env["SPIKE_DATA_DIR"];
  process.env["SPIKE_DATA_DIR"] = data;
  try { return await operation(); }
  finally { old === undefined ? delete process.env["SPIKE_DATA_DIR"] : process.env["SPIKE_DATA_DIR"] = old; }
}

const identity = { goalId: "spike-001", changeId: "001", ticketId: "001" };
type TestRepository = Awaited<ReturnType<typeof temporaryRepository>>;

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = { ".": `directory:${(await lstat(root)).mode}` };
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (entry.isDirectory()) {
        snapshot[relative] = `directory:${stat.mode}`;
        await walk(path, relative);
      } else {
        snapshot[relative] = `file:${stat.mode}:${(await readFile(path)).toString("base64")}`;
      }
    }
  }
  await walk(root, "");
  return snapshot;
}

async function relevantGitState(...repositories: TestRepository[]): Promise<unknown> {
  return Promise.all(repositories.map(async (repository) => ({
    head: await repository.git("rev-parse", "HEAD"),
    refs: await repository.git("for-each-ref", "--format=%(refname) %(objectname)"),
    status: await repository.git("status", "--porcelain=v1", "--untracked-files=all"),
  })));
}

describe("Project control plane", () => {
  test("creates a missing selected root component by component before claim", async () => {
    const repository = await temporaryRepository(); cleanup.push(repository.remove);
    const data = join(await isolatedRoot(), "missing", "selected");
    await withDataRoot(data, async () => {
      await activateProject(repository.root);
      expect(await Bun.file(projectRegistrationPath("spike")).exists()).toBe(true);
    });
  });

  test("refuses direct and ancestor selected-root symlinks before outside publication", async () => {
    const repository = await temporaryRepository(); cleanup.push(repository.remove);
    const holder = await isolatedRoot(); const outside = await isolatedRoot();
    await symlink(outside, join(holder, "alias"));
    await withDataRoot(join(holder, "alias", "selected"), async () => {
      await expect(activateProject(repository.root)).rejects.toThrow("unsafe component");
      expect(await Bun.file(join(outside, "selected", "projects", "spike", "project.md")).exists()).toBe(false);
    });
    await withDataRoot(join(holder, "direct"), async () => {
      await symlink(outside, join(holder, "direct"));
      await expect(resolveProject(repository.root)).rejects.toThrow("unsafe component");
      expect(await Bun.file(join(outside, "projects", "spike", "project.md")).exists()).toBe(false);
    });
  });

  test("rejects projects, exchange, and runtime symlinks before durable writes", async () => {
    const rejectedRepository = await temporaryRepository(); cleanup.push(rejectedRepository.remove);
    const rejectedData = await isolatedRoot(); const outside = await isolatedRoot();
    await withDataRoot(rejectedData, async () => {
      await mkdir(join(rejectedData, "projects"));
      await rm(join(rejectedData, "projects"), { recursive: true });
      await symlink(outside, join(rejectedData, "projects"));
      await expect(activateProject(rejectedRepository.root)).rejects.toThrow("symbolic links");
      expect(await Bun.file(join(outside, "spike", "project.md")).exists()).toBe(false);
    });
    const repository = await temporaryRepository(); cleanup.push(repository.remove);
    const data = await isolatedRoot();
    await withDataRoot(data, async () => {
      await activateProject(repository.root);
      await symlink(outside, join(data, "projects", "spike", "exchange"));
      await expect(ensureWorkflowDirectory(repository.root, exchangePath(repository.root, identity))).rejects.toThrow("symbolic links");
      expect(await Bun.file(join(outside, "goals")).exists()).toBe(false);
      await rm(join(data, "projects", "spike", "exchange"));
      await symlink(outside, join(data, "projects", "spike", "runtime"));
      await expect(ensureWorkflowDirectory(repository.root, join(workerRecordPath(repository.root, identity), ".."))).rejects.toThrow("symbolic links");
      expect(await Bun.file(join(outside, "workers")).exists()).toBe(false);
    });
  });

  test("rejects missing, malformed, wrong-type, and mismatched registration metadata", async () => {
    const repository = await temporaryRepository(); cleanup.push(repository.remove);
    const data = await isolatedRoot();
    await withDataRoot(data, async () => {
      await activateProject(repository.root);
      const registration = projectRegistrationPath("spike");
      for (const source of [
        "not a document\n",
        "---\n[]\n---\n",
        "---\n{\"kind\":\"project\",\"slug\":\"different-project\",\"identity\":\"x\",\"activeCheckout\":\"x\"}\n---\n",
      ]) {
        await writeFile(registration, source);
        await expect(resolveProject(repository.root)).rejects.toThrow();
      }
      await writeFile(registration, "---\n{\"kind\":\"project\",\"slug\":\"different-project\",\"identity\":\"x\",\"activeCheckout\":\"x\"}\n---\n");
      await expect(resolveProject(repository.root)).rejects.toThrow("does not match its path");
    });
  });

  test("requires explicit activation when switching between related same-identity checkouts", async () => {
    const first = await temporaryRepository(); const second = await temporaryRepository();
    cleanup.push(first.remove, second.remove);
    const data = await isolatedRoot();
    await first.git("remote", "add", "origin", "https://example.test/shared.git");
    await second.git("remote", "add", "origin", "https://example.test/shared.git");

    await withDataRoot(data, async () => {
      await resolveProject(first.root);
      await expect(resolveProject(second.root)).rejects.toThrow("run 'spike project activate' from this checkout");

      const activated = await activateProject(second.root);
      expect(activated.registration.activeCheckout).toBe(await realpath(second.root));
      expect((await resolveProject(second.root)).repositoryRoot).toBe(await realpath(second.root));
      await expect(resolveProject(first.root)).rejects.toThrow("run 'spike project activate' from this checkout");
    });
  });

  test("refuses unrelated slug claims and activation without Project or Git side effects", async () => {
    const registered = await temporaryRepository(); const unrelated = await temporaryRepository();
    cleanup.push(registered.remove, unrelated.remove);
    const data = await isolatedRoot();

    await withDataRoot(data, async () => {
      await resolveProject(registered.root);
      const registrationPath = projectRegistrationPath("spike");
      const registrationBefore = await readFile(registrationPath, "utf8");
      const treeBefore = await treeSnapshot(projectDirectory("spike"));
      const gitBefore = await relevantGitState(registered, unrelated);

      await expect(resolveProject(unrelated.root)).rejects.toThrow("registered to a different repository");
      expect(await readFile(registrationPath, "utf8")).toBe(registrationBefore);
      expect(await treeSnapshot(projectDirectory("spike"))).toEqual(treeBefore);
      expect(await relevantGitState(registered, unrelated)).toEqual(gitBefore);

      await expect(activateProject(unrelated.root)).rejects.toThrow("activation refused");
      expect(await readFile(registrationPath, "utf8")).toBe(registrationBefore);
      expect(await treeSnapshot(projectDirectory("spike"))).toEqual(treeBefore);
      expect(await relevantGitState(registered, unrelated)).toEqual(gitBefore);
    });
  });

  test("uses the canonical Git common directory to relate no-remote linked worktrees", async () => {
    const repository = await temporaryRepository(); cleanup.push(repository.remove);
    const worktreeHolder = await isolatedRoot();
    const linked = join(worktreeHolder, "linked");
    await repository.git("worktree", "add", "--quiet", "-b", "project-linked-test", linked, "HEAD");
    const data = await isolatedRoot();

    await withDataRoot(data, async () => {
      await expect(repository.git("config", "--get", "remote.origin.url")).rejects.toThrow();
      const commonDirectory = await realpath(await git(linked, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
      const fallbackIdentity = `file://${commonDirectory}`;
      expect(await repositoryIdentity(repository.root)).toBe(fallbackIdentity);
      expect(await repositoryIdentity(linked)).toBe(fallbackIdentity);

      const claimed = await resolveProject(repository.root);
      expect(claimed.registration.identity).toBe(fallbackIdentity);
      await expect(resolveProject(linked)).rejects.toThrow("run 'spike project activate' from this checkout");
      await activateProject(linked);
      expect((await resolveProject(linked)).registration.activeCheckout).toBe(await realpath(linked));
    });
  });

  test("refuses activation into a same-remote checkout missing retained Spike refs", async () => {
    const first = await temporaryRepository(); const second = await temporaryRepository();
    cleanup.push(first.remove, second.remove);
    const data = await isolatedRoot();
    await withDataRoot(data, async () => {
      await first.git("remote", "add", "origin", "https://example.test/shared.git");
      await second.git("remote", "add", "origin", "https://example.test/shared.git");
      await activateProject(first.root);
      await first.git("update-ref", "refs/spike/goals/spike-001/integrated", "HEAD");
      const before = await readFile(projectRegistrationPath("spike"), "utf8");
      await expect(activateProject(second.root)).rejects.toThrow("does not own retained Spike authority");
      expect(await readFile(projectRegistrationPath("spike"), "utf8")).toBe(before);
    });
  });

  test("bounds generated registration fields before publication", async () => {
    const repository = await temporaryRepository(); cleanup.push(repository.remove);
    const data = await isolatedRoot();
    await withDataRoot(data, async () => {
      await repository.git("remote", "add", "origin", `https://example.test/${"x".repeat(5000)}`);
      await expect(activateProject(repository.root)).rejects.toThrow();
      expect(await Bun.file(join(projectDirectory("spike"), "project.md")).exists()).toBe(false);
    });
  });
});
