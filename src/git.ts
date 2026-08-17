import { realpath } from "node:fs/promises";

export type Repository = {
  root: string;
  identity: string;
  head: string;
};

type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function execute(cwd: string, args: string[]): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited with code ${result.exitCode}`);
  }
  return result.stdout;
}

export async function discoverRepository(cwd: string): Promise<Repository> {
  let root: string;
  try {
    root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`${cwd} is not inside a Git repository`);
  }

  let head: string;
  try {
    head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new Error("the repository must have at least one commit");
  }

  const remote = await execute(root, ["config", "--get", "remote.origin.url"]);
  return {
    root,
    head,
    identity: remote.exitCode === 0 && remote.stdout ? remote.stdout : `file://${root}`,
  };
}
