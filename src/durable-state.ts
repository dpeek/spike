import { randomUUID } from "node:crypto";
import { link, open, lstat, mkdir, readFile, readdir, rename, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spikeDataRoot } from "./data-root.ts";

const defaultMaximumBytes = 128 * 1024;

export type MarkdownDocument = {
  metadata: unknown;
  body: string;
};

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sorted(child)]),
  );
}

export function serializeDocument(metadata: Record<string, unknown>, body: string): string {
  const markdown = body.trimEnd();
  return `---\n${JSON.stringify(sorted(metadata), null, 2)}\n---\n\n${markdown}\n`;
}

export function parseDocument(source: string): MarkdownDocument {
  if (!source.startsWith("---\n")) throw new Error("document must start with JSON frontmatter");
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("document has unterminated JSON frontmatter");

  let metadata: unknown;
  try {
    metadata = JSON.parse(source.slice(4, end));
  } catch {
    throw new Error("document frontmatter is invalid JSON");
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("document frontmatter must be a JSON object");
  }

  return { metadata, body: source.slice(end + 5).replace(/^\n/, "") };
}

async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  let absoluteRoot = resolve(root);
  const centralRoot = resolve(spikeDataRoot());
  const targetAbsolute = resolve(target);
  // Durable control-plane paths are deliberately outside the active repository.
  if (targetAbsolute === centralRoot || targetAbsolute.startsWith(`${centralRoot}${sep}`)) absoluteRoot = centralRoot;
  const relativePath = relative(absoluteRoot, targetAbsolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`workflow path is outside the repository: ${target}`);
  }

  let current = await realpath(absoluteRoot);
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`workflow path must not contain symbolic links: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function prepareParent(root: string, path: string): Promise<void> {
  await rejectSymlinkComponents(root, path);
  await mkdir(dirname(path), { recursive: true });
  await rejectSymlinkComponents(root, path);
}

/** Safely create a workflow directory after checking its entire central path. */
export async function ensureWorkflowDirectory(root: string, path: string): Promise<void> {
  await rejectSymlinkComponents(root, path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(root, path);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeSynced(path: string, contents: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export type ImmutableInstallHooks = {
  beforePublish?: () => void | Promise<void>;
  afterPublish?: () => void | Promise<void>;
};

export async function installImmutable(
  root: string,
  path: string,
  contents: string,
  hooks?: ImmutableInstallHooks,
): Promise<void> {
  await prepareParent(root, path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeSynced(temporary, contents);
    await hooks?.beforePublish?.();
    try {
      // A same-directory hard link publishes the fully synced file without
      // replacing an existing immutable document.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`immutable workflow document already exists: ${path}`);
      }
      throw error;
    }
    await rm(temporary);
    await syncDirectory(dirname(path));
    await hooks?.afterPublish?.();
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function replaceAtomic(root: string, path: string, contents: string): Promise<void> {
  await prepareParent(root, path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeSynced(temporary, contents);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function documentExists(root: string, path: string): Promise<boolean> {
  await rejectSymlinkComponents(root, path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`workflow document is not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function listDirectoryNames(root: string, path: string): Promise<string[]> {
  await rejectSymlinkComponents(root, path);
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`workflow path is not a directory: ${path}`);
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readDocument(root: string, path: string, maximumBytes = defaultMaximumBytes): Promise<MarkdownDocument> {
  await rejectSymlinkComponents(root, path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`workflow document is not a regular file: ${path}`);
  if (stat.size > maximumBytes) throw new Error(`workflow document is unexpectedly large: ${path}`);
  return parseDocument(await readFile(path, "utf8"));
}
