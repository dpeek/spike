import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { loadProjectIdentity } from "./config.ts";
import { spikeDataRoot } from "./data-root.ts";
import { documentExists, installImmutable, readDocument, replaceAtomic, serializeDocument } from "./durable-state.ts";
import { git } from "./git.ts";

const maximumRegistrationFieldLength = 4096;
const maximumRegistrationBytes = 128 * 1024;
const bounded = z.string().min(1).max(maximumRegistrationFieldLength);
const registrationSchema = z.object({
  kind: z.literal("project"), slug: bounded, identity: bounded, activeCheckout: bounded,
}).strict();
export type ProjectRegistration = z.infer<typeof registrationSchema>;
export type ProjectControlPlane = { repositoryRoot: string; root: string; slug: string; registration: ProjectRegistration };
const roots = new Map<string, string>();

export { spikeDataRoot } from "./data-root.ts";
export function projectDirectory(slug: string): string { return join(spikeDataRoot(), "projects", slug); }
export function projectRegistrationPath(slug: string): string { return join(projectDirectory(slug), "project.md"); }
export function projectRoot(repositoryRoot: string): string {
  const root = roots.get(resolve(repositoryRoot));
  if (root === undefined) throw new Error("Project control plane is not resolved; discover the repository first");
  return root;
}

/**
 * Build the selected root one component at a time.  `mkdir({recursive:true})`
 * follows an existing ancestor symlink, so it must never be used for this
 * boundary: a refusal has to happen before it can create anything outside it.
 */
async function prepareDataRoot(selected = spikeDataRoot()): Promise<string> {
  const root = resolve(selected);
  const parsed = parse(root);
  let current = parsed.root;
  for (const component of root.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Spike data root contains an unsafe component: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // This creates exactly one lexical component. Re-checking also closes a
      // replacement race before a caller can publish beneath it.
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Spike data root contains an unsafe component: ${current}`);
    }
  }
  return root;
}
async function canonicalCheckout(root: string): Promise<string> { return realpath(root); }
export async function repositoryIdentity(root: string): Promise<string> {
  try { const remote = await git(root, ["config", "--get", "remote.origin.url"]); if (remote.trim()) return remote.trim(); } catch { /* local identity */ }
  const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return `file://${await realpath(common)}`;
}
function registrationDocument(registration: ProjectRegistration): string {
  const document = serializeDocument(registration, "# Project\n\nHost control-plane registration.\n");
  if (Buffer.byteLength(document) > maximumRegistrationBytes) throw new Error("Project registration is too large");
  return document;
}
function registrationPath(dataRoot: string, slug: string): string { return join(dataRoot, "projects", slug, "project.md"); }
async function readRegistration(slug: string, selected?: string): Promise<ProjectRegistration | undefined> {
  const root = await prepareDataRoot(selected);
  const path = registrationPath(root, slug);
  if (!(await documentExists(root, path))) return undefined;
  const registration = registrationSchema.parse((await readDocument(root, path)).metadata);
  if (registration.slug !== slug) throw new Error(`Project registration slug does not match its path: ${slug}`);
  return registration;
}
async function claim(root: string, slug: string, identity: string, selected?: string): Promise<ProjectRegistration> {
  const activeCheckout = await canonicalCheckout(root);
  const registration = registrationSchema.parse({ kind: "project", slug, identity, activeCheckout });
  const dataRoot = await prepareDataRoot(selected);
  try {
    await installImmutable(dataRoot, registrationPath(dataRoot, slug), registrationDocument(registration));
    return registration;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const existing = await readRegistration(slug, dataRoot);
    if (existing === undefined) throw error;
    return existing;
  }
}
/** A selected checkout must contain every retained Spike ref before it becomes authoritative. */
async function verifyGitAuthority(current: string, selected: string): Promise<void> {
  const refs = (await git(current, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/spike/"]))
    .split("\n").filter(Boolean);
  for (const line of refs) {
    const [ref, object] = line.split(" ");
    try {
      const selectedObject = await git(selected, ["rev-parse", "--verify", `${ref}^{object}`]);
      if (selectedObject !== object) throw new Error("different object");
      await git(selected, ["cat-file", "-e", `${object}^{object}`]);
    } catch {
      throw new Error(`Checkout cannot be activated because it does not own retained Spike authority (${ref}); fetch or preserve Spike refs first`);
    }
  }
}
/** Resolve and enforce the single active checkout before any workflow side effect. */
export async function resolveProject(repositoryRoot: string): Promise<ProjectControlPlane> {
  const root = await canonicalCheckout(repositoryRoot);
  const { slug } = await loadProjectIdentity(root);
  const identity = await repositoryIdentity(root);
  let registration = await readRegistration(slug);
  if (registration === undefined) registration = await claim(root, slug, identity);
  if (registration.identity !== identity) throw new Error(`Project slug ${slug} is registered to a different repository; refusing to change Project state`);
  if (registration.activeCheckout !== root) throw new Error(`Checkout is related to Project ${slug} but inactive; run 'spike project activate' from this checkout`);
  const controlRoot = projectDirectory(slug); roots.set(root, controlRoot);
  return { repositoryRoot: root, root: controlRoot, slug, registration };
}
/** Explicitly claim or select an already-related checkout. */
export async function activateProject(repositoryRoot: string): Promise<ProjectControlPlane> {
  const root = await canonicalCheckout(repositoryRoot);
  const { slug } = await loadProjectIdentity(root);
  const identity = await repositoryIdentity(root);
  let registration = await readRegistration(slug);
  if (registration === undefined) registration = await claim(root, slug, identity);
  if (registration.identity !== identity) throw new Error(`Project slug ${slug} is registered to a different repository; activation refused`);
  if (registration.activeCheckout !== root) {
    // This check intentionally precedes both replacement and any project-root creation.
    await verifyGitAuthority(registration.activeCheckout, root);
    registration = registrationSchema.parse({ ...registration, activeCheckout: root });
    await replaceAtomic(await prepareDataRoot(), projectRegistrationPath(slug), registrationDocument(registration));
  }
  const controlRoot = projectDirectory(slug); roots.set(root, controlRoot);
  return { repositoryRoot: root, root: controlRoot, slug, registration };
}
