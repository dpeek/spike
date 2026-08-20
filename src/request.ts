import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { documentExists, installImmutable, listDirectoryNames, readDocument, serializeDocument } from "./durable-state.ts";
import { projectSlugPattern } from "./identity.ts";

const requestIdPattern = /^request-(?!0+$)[0-9]{3,}$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const requestSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().regex(requestIdPattern),
  createdAt: timestamp,
  projects: z.array(z.string().regex(projectSlugPattern)).superRefine((value, context) => {
    if (new Set(value).size !== value.length) context.addIssue({ code: "custom", message: "Project slugs must be unique" });
  }),
}).strict();
const closureSchema = z.object({
  kind: z.literal("request-closure"),
  requestId: z.string().regex(requestIdPattern),
  closedAt: timestamp,
  disposition: z.enum(["addressed", "declined", "withdrawn"]),
}).strict();

export type ClosureDisposition = z.infer<typeof closureSchema>["disposition"];
export type Request = { metadata: z.infer<typeof requestSchema>; body: string };
export type RequestClosure = { metadata: z.infer<typeof closureSchema>; body: string };
export type RequestState = "open" | "closed";
export type RequestView = Request & { state: RequestState; closure: RequestClosure | null };
/** Lightweight Inbox projection; full documents remain available through loadRequest. */
export type RequestSummary = { metadata: Request["metadata"]; title: string; state: RequestState };

export function requestDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["SPIKE_DATA_DIR"];
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error("SPIKE_DATA_DIR must not be blank");
    return resolve(configured);
  }
  const xdg = environment["XDG_DATA_HOME"];
  if (xdg !== undefined) {
    if (!xdg.trim()) throw new Error("XDG_DATA_HOME must not be blank");
    return join(resolve(xdg), "spike");
  }
  const home = environment["HOME"];
  if (home === undefined || !home.trim()) throw new Error("HOME must be set to resolve the Spike data directory");
  return join(resolve(home), ".local", "share", "spike");
}

/** Ensure an absolute selected root is a real directory before it is used. */
async function prepareRoot(root: string, create = false): Promise<boolean> {
  const absolute = resolve(root);
  try {
    const existing = await lstat(absolute);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Request data root is not a directory: ${absolute}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!create) return false;
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Request data root is not a directory: ${absolute}`);
  return true;
}

export function requestPath(root: string, requestId: string): string {
  if (!requestIdPattern.test(requestId)) throw new Error(`invalid Request ID: ${requestId}`);
  return join(root, "requests", requestId, "request.md");
}
function closurePath(root: string, requestId: string): string {
  if (!requestIdPattern.test(requestId)) throw new Error(`invalid Request ID: ${requestId}`);
  return join(root, "requests", requestId, "closure.md");
}
function text(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

function requestTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Request title must be a string");
  if (/\r|\n/.test(value)) throw new Error("Request title must be a single line");
  const title = value.trim();
  if (!title) throw new Error("Request title must not be blank");
  if (Array.from(title).length > 200) throw new Error("Request title must be at most 200 characters");
  return title;
}

function titleFromBody(value: string): string {
  const firstLine = value.split(/\r\n|\r|\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("# ")) {
    throw new Error("Request body must start with a nonempty '# <title>' heading");
  }
  try {
    return requestTitle(firstLine.slice(2));
  } catch {
    throw new Error("Request body must start with a nonempty '# <title>' heading of at most 200 characters");
  }
}

function body(title: string, statement: string): string {
  return `# ${title}\n\n${statement}\n`;
}

async function allocatedIds(root: string): Promise<string[]> {
  const names = await listDirectoryNames(root, join(root, "requests"));
  return names.filter((name) => requestIdPattern.test(name)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
}
function nextId(ids: string[]): string {
  const highest = ids.reduce((maximum, id) => Math.max(maximum, Number(id.slice(8))), 0);
  if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER - 1) throw new Error("Request sequence exhausted");
  return `request-${String(highest + 1).padStart(3, "0")}`;
}

export async function createRequest(input: { title: string; statement: string; projects?: string[]; root?: string; now?: Date }): Promise<RequestView> {
  const title = requestTitle(input.title);
  const statement = text(input.statement, "Request statement");
  const projects = (input.projects ?? []).map((project) => text(project, "Project slug"));
  const root = input.root === undefined ? requestDataRoot() : resolve(input.root);
  const checkedProjects = requestSchema.shape.projects.parse(projects);
  await prepareRoot(root, true);
  const createdAt = (input.now ?? new Date()).toISOString();
  // A failed exclusive link means another creator won this identity: rescan and retry.
  for (;;) {
    const requestId = nextId(await allocatedIds(root));
    const metadata = requestSchema.parse({ kind: "request", requestId, createdAt, projects: checkedProjects });
    try {
      await installImmutable(root, requestPath(root, requestId), serializeDocument(metadata, body(title, statement)));
      return { metadata, body: body(title, statement), state: "open", closure: null };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("immutable workflow document already exists:")) continue;
      throw error;
    }
  }
}

export async function loadRequest(rootInput: string, requestId: string): Promise<RequestView> {
  const root = resolve(rootInput);
  if (!(await prepareRoot(root))) throw new Error(`Request data root does not exist: ${root}`);
  const requestDocument = await readDocument(root, requestPath(root, requestId));
  const metadata = requestSchema.parse(requestDocument.metadata);
  if (metadata.requestId !== requestId) throw new Error(`Request document belongs to a different Request: ${metadata.requestId}`);
  titleFromBody(requestDocument.body);
  const closureFile = closurePath(root, requestId);
  if (!(await documentExists(root, closureFile))) return { metadata, body: requestDocument.body, state: "open", closure: null };
  const closureDocument = await readDocument(root, closureFile);
  const closureMetadata = closureSchema.parse(closureDocument.metadata);
  if (closureMetadata.requestId !== requestId) throw new Error(`Request closure belongs to a different Request: ${closureMetadata.requestId}`);
  if (!closureDocument.body.trim()) throw new Error("Request closure statement must not be blank");
  return { metadata, body: requestDocument.body, state: "closed", closure: { metadata: closureMetadata, body: closureDocument.body } };
}

export async function listRequests(input: { root?: string; project?: string; unassigned?: boolean; closed?: boolean }): Promise<RequestSummary[]> {
  if (input.project !== undefined && input.unassigned) throw new Error("--project cannot be combined with --unassigned");
  const root = input.root === undefined ? requestDataRoot() : resolve(input.root);
  const project = input.project === undefined ? undefined : z.string().regex(projectSlugPattern).parse(input.project);
  if (!(await prepareRoot(root))) return [];
  const views = await Promise.all((await allocatedIds(root)).map((requestId) => loadRequest(root, requestId)));
  return views.filter((view) => (input.closed ? view.state === "closed" : view.state === "open"))
    .filter((view) => project === undefined || view.metadata.projects.includes(project))
    .filter((view) => !input.unassigned || view.metadata.projects.length === 0)
    .map((view) => ({ metadata: view.metadata, title: titleFromBody(view.body), state: view.state }));
}

export async function closeRequest(input: { requestId: string; disposition: ClosureDisposition; statement: string; root?: string; now?: Date }): Promise<RequestView> {
  const root = input.root === undefined ? requestDataRoot() : resolve(input.root);
  const statement = text(input.statement, "Closure statement");
  const disposition = closureSchema.shape.disposition.parse(input.disposition);
  const view = await loadRequest(root, input.requestId);
  if (view.closure !== null) throw new Error(`Request ${input.requestId} is already closed`);
  const metadata = closureSchema.parse({ kind: "request-closure", requestId: input.requestId, closedAt: (input.now ?? new Date()).toISOString(), disposition });
  try {
    await installImmutable(root, closurePath(root, input.requestId), serializeDocument(metadata, statement));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("immutable workflow document already exists:")) {
      throw new Error(`Request ${input.requestId} is already closed`);
    }
    throw error;
  }
  return { ...view, state: "closed", closure: { metadata, body: `${statement}\n` } };
}
