import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PUBLICATION_SCHEMA_VERSION = 1;

export type Runtime = "apple" | "docker";

export type PublicationAgentState = {
  slug: string;
  project: string;
  runtime: Runtime;
  container: string;
  backend?: "headless" | "herdr";
  finishedAt?: string;
};

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (command: string[], cwd?: string) => Promise<CommandResult>;

export type PublicationManifest = {
  schemaVersion: 1;
  project: string;
  agent: string;
  workerBranch: string;
  base: string;
  head: string;
  importedRef: string;
  bundlePath: string;
  publishedAt: string;
};

export type PublicationResult = PublicationManifest & {
  manifestPath: string;
  latestManifestPath: string;
  idempotent: boolean;
};

export type PublicationContext = {
  root: string;
  stateDir: string;
  project: string;
};

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function commandText(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

async function checked(run: CommandRunner, command: string[], cwd: string | undefined, label: string): Promise<string> {
  const result = await run(command, cwd);
  if (result.code !== 0) throw new Error(`${label}: ${commandText(result)}`);
  return result.stdout.trim();
}

function assertObjectId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !objectIdPattern.test(value)) {
    throw new Error(`publication manifest has an invalid ${field} commit`);
  }
}

function assertPlainString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value) throw new Error(`publication manifest has an invalid ${field}`);
}

export function resolveProjectPath(root: string, recordedPath: string, expectedDirectory?: string): string {
  if (!recordedPath || isAbsolute(recordedPath)) throw new Error("publication manifest path must be project-relative");
  const absolute = resolve(root, recordedPath);
  const rootPrefix = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(rootPrefix)) throw new Error("publication manifest path escapes the project repository");
  if (expectedDirectory) {
    const expectedPrefix = `${resolve(expectedDirectory)}${sep}`;
    if (!absolute.startsWith(expectedPrefix)) throw new Error("publication manifest path is outside the agent publication directory");
  }
  return absolute;
}

export function validatePublicationManifest(
  value: unknown,
  expected: { root: string; project: string; agent: string; publicationDirectory: string },
): PublicationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("publication manifest is not a JSON object");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    throw new Error(`unsupported publication manifest schema: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.project !== expected.project) throw new Error("publication manifest belongs to a different project");
  if (manifest.agent !== expected.agent) throw new Error("publication manifest belongs to a different agent");
  assertPlainString(manifest.workerBranch, "workerBranch");
  assertObjectId(manifest.base, "base");
  assertObjectId(manifest.head, "head");
  const expectedRef = `refs/spike/agents/${expected.agent}`;
  if (manifest.importedRef !== expectedRef) throw new Error(`publication manifest imported ref must be ${expectedRef}`);
  assertPlainString(manifest.bundlePath, "bundlePath");
  resolveProjectPath(expected.root, manifest.bundlePath, expected.publicationDirectory);
  assertPlainString(manifest.publishedAt, "publishedAt");
  if (!Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error("publication manifest has an invalid publishedAt timestamp");
  return manifest as PublicationManifest;
}

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readManifest(path: string, expected: Parameters<typeof validatePublicationManifest>[1]): Promise<PublicationManifest> {
  await rejectSymlink(path, "publication manifest");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no successful publication exists for agent ${expected.agent}; run spike agent publish ${expected.agent}`);
    throw error;
  }
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("publication manifest is unexpectedly large");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`publication manifest is invalid JSON: ${relative(expected.root, path)}`); }
  return validatePublicationManifest(value, expected);
}

function publicationPaths(context: PublicationContext, agent: string) {
  const directory = join(context.stateDir, "output", "branches", agent);
  return { directory, latest: join(directory, "latest.json") };
}

function relativeToRoot(root: string, path: string): string {
  const result = relative(root, path);
  if (!result || result.startsWith(`..${sep}`) || result === ".." || isAbsolute(result)) {
    throw new Error(`publication path is outside the project repository: ${path}`);
  }
  return result.split(sep).join("/");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function execCommand(state: PublicationAgentState, args: string[]): string[] {
  if (state.runtime !== "apple" && state.runtime !== "docker") throw new Error(`agent ${state.slug} has an invalid recorded runtime`);
  if (!state.container) throw new Error(`agent ${state.slug} has no recorded container`);
  return [state.runtime === "apple" ? "container" : "docker", "exec", state.container, ...args];
}

async function workerGit(run: CommandRunner, state: PublicationAgentState, args: string[], label: string): Promise<string> {
  const result = await run(execCommand(state, ["git", "-C", "/workspace/project", ...args]));
  if (result.code !== 0) {
    if (result.code === 127 || /(?:not found|no such container|not running|is not running)/i.test(commandText(result))) {
      throw new Error(`cannot inspect agent ${state.slug}'s running container; start or recover the persistent worker and retry (${commandText(result)})`);
    }
    throw new Error(`${label}: ${commandText(result)}`);
  }
  return result.stdout.trim();
}

async function deriveBase(run: CommandRunner, state: PublicationAgentState, branch: string, head: string): Promise<string> {
  const configured = await run(execCommand(state, ["git", "-C", "/workspace/project", "config", "--get", "spike.agentBase"]));
  let base = configured.code === 0 ? configured.stdout.trim() : "";
  if (!objectIdPattern.test(base)) {
    const reflog = await run(execCommand(state, ["git", "-C", "/workspace/project", "reflog", "show", "--reverse", "--format=%H", `refs/heads/${branch}`]));
    const creationCommit = reflog.code === 0 ? reflog.stdout.trim().split(/\r?\n/, 1)[0] : "";
    if (objectIdPattern.test(creationCommit)) base = creationCommit;
  }
  if (!objectIdPattern.test(base)) {
    const originHead = await run(execCommand(state, ["git", "-C", "/workspace/project", "rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"]));
    if (originHead.code === 0 && objectIdPattern.test(originHead.stdout.trim())) {
      base = await workerGit(run, state, ["merge-base", head, originHead.stdout.trim()], "could not derive the worker branch base");
    }
  }
  if (!objectIdPattern.test(base)) {
    throw new Error(`agent ${state.slug} has no recorded base and its origin default branch cannot be resolved; set spike.agentBase in the worker clone and retry`);
  }
  await workerGit(run, state, ["cat-file", "-e", `${base}^{commit}`], "the recorded worker base does not exist");
  const ancestor = await run(execCommand(state, ["git", "-C", "/workspace/project", "merge-base", "--is-ancestor", base, head]));
  if (ancestor.code !== 0) throw new Error(`agent ${state.slug}'s recorded base ${base} is not an ancestor of ${head}; repair the worker base before publishing`);
  return base;
}

async function verifyBundle(
  run: CommandRunner,
  root: string,
  bundlePath: string,
  workerBranch: string,
  head: string,
): Promise<void> {
  await rejectSymlink(bundlePath, "publication bundle");
  await checked(run, ["git", "bundle", "verify", bundlePath], root, "host bundle verification failed");
  const heads = await checked(run, ["git", "bundle", "list-heads", bundlePath], root, "could not inspect publication bundle");
  const expected = `${head} refs/heads/${workerBranch}`;
  if (!heads.split(/\r?\n/).includes(expected)) {
    throw new Error(`publication bundle does not contain the expected worker head ${expected}`);
  }
}

function samePublication(manifest: PublicationManifest, values: Pick<PublicationManifest, "workerBranch" | "base" | "head" | "importedRef" | "bundlePath">): boolean {
  return manifest.workerBranch === values.workerBranch && manifest.base === values.base && manifest.head === values.head &&
    manifest.importedRef === values.importedRef && manifest.bundlePath === values.bundlePath;
}

export async function loadLatestPublication(
  context: PublicationContext,
  agent: string,
  run: CommandRunner,
): Promise<PublicationResult> {
  const paths = publicationPaths(context, agent);
  await rejectSymlink(context.stateDir, "Spike state directory");
  await rejectSymlink(join(context.stateDir, "output"), "publication output directory");
  await rejectSymlink(join(context.stateDir, "output", "branches"), "publication branches directory");
  await rejectSymlink(paths.directory, "agent publication directory");
  const expected = { root: context.root, project: context.project, agent, publicationDirectory: paths.directory };
  const manifest = await readManifest(paths.latest, expected);
  const imported = await run(["git", "rev-parse", "--verify", `${manifest.importedRef}^{commit}`], context.root);
  if (imported.code !== 0 || imported.stdout.trim() !== manifest.head) {
    throw new Error(`published ref ${manifest.importedRef} no longer points at recorded head ${manifest.head}; republish or restore the ref before reviewing`);
  }
  const bundle = resolveProjectPath(context.root, manifest.bundlePath, paths.directory);
  if (!existsSync(bundle)) throw new Error(`recorded publication bundle is missing: ${manifest.bundlePath}`);
  const manifestPath = relativeToRoot(context.root, join(paths.directory, `${manifest.head}.json`));
  const retained = await readManifest(join(context.root, manifestPath), expected);
  if (!samePublication(retained, manifest)) throw new Error("latest publication pointer does not match its retained head manifest");
  return {
    ...manifest,
    manifestPath,
    latestManifestPath: relativeToRoot(context.root, paths.latest),
    idempotent: true,
  };
}

export async function publishBranch(
  context: PublicationContext,
  state: PublicationAgentState,
  run: CommandRunner,
  now = () => new Date(),
): Promise<PublicationResult> {
  const agent = state.slug;
  if (!agent || state.project !== context.project) throw new Error("recorded agent state does not belong to this project");
  if (state.backend !== "herdr") throw new Error(`agent ${agent} is not Herdr-backed; start it with spike agent persistent ${agent} before publishing`);
  if (state.finishedAt) throw new Error(`agent ${agent} is stopped; restart its persistent worker before publishing`);

  // Inspection completes before any bundle, ref, or publication pointer is changed.
  const branch = await workerGit(run, state, ["symbolic-ref", "--quiet", "--short", "HEAD"], `agent ${agent} is detached; switch it to the intended branch before publishing`);
  const branchFormat = await run(["git", "check-ref-format", "--branch", branch], context.root);
  if (branchFormat.code !== 0) throw new Error(`agent ${agent} is on an invalid branch: ${branch}`);
  const head = await workerGit(run, state, ["rev-parse", "--verify", "HEAD^{commit}"], "could not resolve the worker head");
  if (!objectIdPattern.test(head)) throw new Error(`agent ${agent} returned an invalid head commit`);
  const status = await workerGit(run, state, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "could not inspect the worker tree");
  if (status.length) throw new Error(`agent ${agent} has uncommitted or untracked changes; commit or discard them and rerun publish`);
  const base = await deriveBase(run, state, branch, head);
  if (base === head) throw new Error(`agent ${agent} has no commits beyond its base ${base}; commit the intended changes before publishing`);

  const importedRef = `refs/spike/agents/${agent}`;
  const paths = publicationPaths(context, agent);
  await rejectSymlink(context.stateDir, "Spike state directory");
  await rejectSymlink(join(context.stateDir, "output"), "publication output directory");
  await rejectSymlink(join(context.stateDir, "output", "branches"), "publication branches directory");
  await rejectSymlink(paths.directory, "agent publication directory");
  await mkdir(paths.directory, { recursive: true });
  const bundle = join(paths.directory, `${head}.bundle`);
  const bundlePath = relativeToRoot(context.root, bundle);
  const manifestFile = join(paths.directory, `${head}.json`);
  const manifestPath = relativeToRoot(context.root, manifestFile);
  const latestManifestPath = relativeToRoot(context.root, paths.latest);
  const expected = { root: context.root, project: context.project, agent, publicationDirectory: paths.directory };

  await rejectSymlink(bundle, "publication bundle");
  let createdBundle = false;
  if (!existsSync(bundle)) {
    createdBundle = true;
    const containerBundle = `/output/branches/${agent}/${head}.bundle`;
    const result = await run(execCommand(state, ["git", "-C", "/workspace/project", "bundle", "create", containerBundle, `refs/heads/${branch}`]));
    if (result.code !== 0) {
      await rm(bundle, { force: true });
      throw new Error(`could not create worker bundle: ${commandText(result)}`);
    }
  }
  try {
    await verifyBundle(run, context.root, bundle, branch, head);
  } catch (error) {
    if (createdBundle) await rm(bundle, { force: true });
    throw error;
  }

  const publicationValues = { workerBranch: branch, base, head, importedRef, bundlePath };
  if (existsSync(manifestFile) && existsSync(paths.latest)) {
    const retained = await readManifest(manifestFile, expected);
    const latest = await readManifest(paths.latest, expected);
    if (samePublication(retained, publicationValues) && samePublication(latest, publicationValues)) {
      const ref = await run(["git", "rev-parse", "--verify", `${importedRef}^{commit}`], context.root);
      if (ref.code === 0 && ref.stdout.trim() === head) {
        return { ...retained, manifestPath, latestManifestPath, idempotent: true };
      }
    }
  }

  const existingRef = await run(["git", "rev-parse", "--verify", `${importedRef}^{commit}`], context.root);
  if (existingRef.code === 0 && existingRef.stdout.trim() !== head) {
    const fastForward = await run(["git", "fetch", "--dry-run", "--no-write-fetch-head", bundle, `refs/heads/${branch}:${importedRef}`], context.root);
    if (fastForward.code !== 0) {
      throw new Error(`refusing to move ${importedRef} from ${existingRef.stdout.trim()} to non-fast-forward head ${head}; publish from a descendant or use a different agent identity`);
    }
  }

  if (existingRef.code !== 0 || existingRef.stdout.trim() !== head) {
    const fetched = await run(["git", "fetch", "--no-write-fetch-head", bundle, `refs/heads/${branch}:${importedRef}`], context.root);
    if (fetched.code !== 0) {
      if (/non-fast-forward|rejected/i.test(commandText(fetched))) {
        throw new Error(`refusing a non-fast-forward update of ${importedRef}: ${commandText(fetched)}`);
      }
      throw new Error(`could not import the verified worker bundle: ${commandText(fetched)}`);
    }
  }
  const imported = await checked(run, ["git", "rev-parse", "--verify", `${importedRef}^{commit}`], context.root, "could not validate imported ref");
  if (imported !== head) throw new Error(`imported ref ${importedRef} resolved to ${imported}, expected ${head}`);

  const manifest: PublicationManifest = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    project: context.project,
    agent,
    workerBranch: branch,
    base,
    head,
    importedRef,
    bundlePath,
    publishedAt: now().toISOString(),
  };
  validatePublicationManifest(manifest, expected);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(manifestFile)) {
    const retained = await readManifest(manifestFile, expected);
    if (!samePublication(retained, manifest)) throw new Error(`immutable publication manifest already exists with different contents: ${manifestPath}`);
  } else {
    await writeFile(manifestFile, serialized, { flag: "wx", mode: 0o600 });
  }
  await atomicWrite(paths.latest, serialized);
  return { ...manifest, manifestPath, latestManifestPath, idempotent: false };
}
