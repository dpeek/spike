import { constants } from "node:fs";
import { access, lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const WORKFLOW_STATE_SCHEMA_VERSION = 1;
export const TICKET_RESULT_SCHEMA_VERSION = 1;
export const MIGRATION_RECEIPT_SCHEMA_VERSION = 1;
export const WORKFLOW_DOCTOR_SCHEMA_VERSION = 1;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const ticketIdPattern = /^ticket-[0-9a-f]{32}$/;
const runIdPattern = /^run-[0-9a-f]{32}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 512 * 1024;

export type WorkflowState = {
  schemaVersion: 1;
  goalId: string;
  acceptedCodeRevision: string;
  activeTicketId: string | null;
  stateRevision: number;
  lastTransitionAt: string;
  ticketOrder: string[];
};

export type ResultPublication = {
  agent: string;
  head: string;
  base: string;
  importedRef: string;
  bundlePath: string;
  manifestPath: string;
  publishedAt: string;
};

export type TicketResult = {
  schemaVersion: 1;
  ticketId: string;
  goalId: string;
  baseRevision: string;
  acceptedRevision: string;
  outcome: "accepted";
  review: "planner" | "hunk";
  statement?: string;
  acceptedAt: string;
  worker?: { name: string; slug: string };
  runId?: string;
  publication?: ResultPublication;
  provenanceMigrated: boolean;
};

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

export function validateWorkflowState(value: unknown, goalId: string): WorkflowState {
  const state = object(value, "workflow state");
  if (state.schemaVersion !== WORKFLOW_STATE_SCHEMA_VERSION) throw new Error(`unsupported workflow state schema: ${String(state.schemaVersion)}`);
  if (state.goalId !== goalId || !goalIdPattern.test(String(state.goalId))) throw new Error("workflow state does not match the active goal");
  if (typeof state.acceptedCodeRevision !== "string" || !objectIdPattern.test(state.acceptedCodeRevision)) throw new Error("workflow state has an invalid acceptedCodeRevision");
  if (state.activeTicketId !== null && (typeof state.activeTicketId !== "string" || !ticketIdPattern.test(state.activeTicketId))) throw new Error("workflow state has an invalid activeTicketId");
  if (!Number.isSafeInteger(state.stateRevision) || (state.stateRevision as number) < 1) throw new Error("workflow state has an invalid stateRevision");
  if (!validTimestamp(state.lastTransitionAt)) throw new Error("workflow state has an invalid lastTransitionAt");
  if (!Array.isArray(state.ticketOrder) || new Set(state.ticketOrder).size !== state.ticketOrder.length || state.ticketOrder.some((id) => typeof id !== "string" || !ticketIdPattern.test(id))) {
    throw new Error("workflow state has an invalid ticketOrder");
  }
  if (state.activeTicketId && !(state.ticketOrder as string[]).includes(state.activeTicketId)) throw new Error("workflow state active ticket is absent from ticketOrder");
  return state as WorkflowState;
}

export function validateTicketResult(value: unknown, expected?: { goalId?: string; ticketId?: string; baseRevision?: string }): TicketResult {
  const result = object(value, "ticket result");
  if (result.schemaVersion !== TICKET_RESULT_SCHEMA_VERSION) throw new Error(`unsupported ticket result schema: ${String(result.schemaVersion)}`);
  if (typeof result.goalId !== "string" || !goalIdPattern.test(result.goalId) || (expected?.goalId && result.goalId !== expected.goalId)) throw new Error("ticket result has an invalid goalId");
  if (typeof result.ticketId !== "string" || !ticketIdPattern.test(result.ticketId) || (expected?.ticketId && result.ticketId !== expected.ticketId)) throw new Error("ticket result has an invalid ticketId");
  for (const field of ["baseRevision", "acceptedRevision"] as const) if (typeof result[field] !== "string" || !objectIdPattern.test(result[field])) throw new Error(`ticket result has an invalid ${field}`);
  if (expected?.baseRevision && result.baseRevision !== expected.baseRevision) throw new Error("ticket result base does not match its ticket");
  if (result.baseRevision === result.acceptedRevision) throw new Error("ticket result accepted revision equals its base");
  if (result.outcome !== "accepted") throw new Error("ticket result has an invalid outcome");
  if (result.review !== "planner" && result.review !== "hunk") throw new Error("ticket result has an invalid review surface");
  if (result.statement !== undefined && (typeof result.statement !== "string" || !result.statement.trim())) throw new Error("ticket result has an invalid statement");
  if (!validTimestamp(result.acceptedAt)) throw new Error("ticket result has an invalid acceptedAt");
  if (typeof result.provenanceMigrated !== "boolean") throw new Error("ticket result has an invalid provenanceMigrated flag");
  if (result.worker !== undefined) {
    const worker = object(result.worker, "ticket result worker");
    if (typeof worker.name !== "string" || !worker.name || typeof worker.slug !== "string" || !/^[a-z0-9_.-]+$/.test(worker.slug)) throw new Error("ticket result has an invalid worker");
  }
  if (result.runId !== undefined && (typeof result.runId !== "string" || !runIdPattern.test(result.runId))) throw new Error("ticket result has an invalid runId");
  if (result.runId && !result.worker) throw new Error("ticket result run has no worker identity");
  if (result.publication !== undefined) {
    const publication = object(result.publication, "ticket result publication");
    if (typeof publication.agent !== "string" || !/^[a-z0-9_.-]+$/.test(publication.agent)) throw new Error("ticket result publication has an invalid agent");
    for (const field of ["head", "base"] as const) if (typeof publication[field] !== "string" || !objectIdPattern.test(publication[field])) throw new Error(`ticket result publication has an invalid ${field}`);
    for (const field of ["importedRef", "bundlePath", "manifestPath"] as const) if (typeof publication[field] !== "string" || !publication[field] || isAbsolute(publication[field]) || publication[field].includes("\0")) throw new Error(`ticket result publication has an invalid ${field}`);
    if (publication.importedRef !== `refs/spike/agents/${publication.agent}`) throw new Error("ticket result publication has an invalid importedRef");
    const publicationRoot = `.pi-swarm/output/branches/${publication.agent}/`;
    if (!publication.bundlePath.startsWith(publicationRoot) || !publication.manifestPath.startsWith(publicationRoot)) throw new Error("ticket result publication paths do not match its agent");
    if (!validTimestamp(publication.publishedAt)) throw new Error("ticket result publication has an invalid publishedAt");
    if (publication.head !== result.acceptedRevision) throw new Error("ticket result publication head does not match accepted revision");
    if (result.worker && publication.agent !== (result.worker as Record<string, unknown>).slug) throw new Error("ticket result publication does not match worker");
  }
  return result as TicketResult;
}

export function workflowStatePath(root: string, goalId: string): string { return join(root, ".pi-swarm", "goals", goalId, "workflow.v1.json"); }
export function ticketResultPath(root: string, goalId: string, ticketId: string): string { return join(root, ".pi-swarm", "goals", goalId, "tickets", ticketId, "result.v1.json"); }

export async function readJson(path: string, label: string, allowMissing = false): Promise<unknown | undefined> {
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} is missing`);
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error(`${label} is unexpectedly large`);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); }
}

export async function durableWrite(path: string, contents: string | Uint8Array): Promise<void> {
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { await durableWrite(temporary, contents); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function rejectSymlinks(root: string, path: string, label: string): Promise<void> {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} is outside the repository`);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} must not contain symbolic links: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}

export function projectPath(root: string, recorded: string, label: string): string {
  if (!recorded || isAbsolute(recorded) || recorded.includes("\0")) throw new Error(`${label} must be project-relative`);
  const absolute = resolve(root, recorded);
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || relative(root, absolute).split(sep).join("/") !== recorded) throw new Error(`${label} escapes the project repository or is not normalized`);
  return absolute;
}

export async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function sha256(bytes: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function validObjectId(value: unknown): value is string { return typeof value === "string" && objectIdPattern.test(value); }
export function validDigest(value: unknown): value is string { return typeof value === "string" && digestPattern.test(value); }
