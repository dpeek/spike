import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

export async function temporaryRepository(): Promise<{
  root: string;
  head: string;
  git: (...args: string[]) => Promise<string>;
  remove: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "spike-test-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Spike Test");
  await git(root, "config", "user.email", "spike@example.test");
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "--quiet", "-m", "Initial fixture");
  return {
    root,
    head: await git(root, "rev-parse", "HEAD"),
    git: (...args) => git(root, ...args),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
