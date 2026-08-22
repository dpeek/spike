import { realpath } from "node:fs/promises";
import type { HostPaths } from "./data-root.ts";
import { resolveProject } from "./project.ts";

export type Repository = {
  root: string;
  controlRoot: string;
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

export async function readGitBlob(cwd: string, object: string, maximumBytes: number): Promise<string> {
  const size = Number(await git(cwd, ["cat-file", "-s", object]));
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Git blob has an invalid size: ${object}`);
  if (size > maximumBytes) throw new Error(`Git blob exceeds ${maximumBytes} bytes: ${object}`);

  const child = Bun.spawn(["git", "-C", cwd, "cat-file", "blob", object], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git exited with code ${exitCode}`);
  if (stdout.byteLength !== size) throw new Error(`Git blob size changed while reading: ${object}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new Error(`Git blob is not valid UTF-8: ${object}`);
  }
}

export async function discoverRepository(cwd: string, hostPaths: HostPaths): Promise<Repository> {
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

  const project = await resolveProject(root, hostPaths);
  return {
    root,
    controlRoot: project.controlRoot,
    head,
    identity: project.registration.identity,
  };
}
