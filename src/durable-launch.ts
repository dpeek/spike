import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const ticketIdPattern = /^ticket-[0-9a-f]{32}$/;
const runIdPattern = /^run-[0-9a-f]{32}$/;
const workerPattern = /^[a-z0-9_.-]+$/;

export const LAUNCH_EVIDENCE_SCHEMA_VERSION = 1;

export type LaunchEvidenceRecord = {
  schemaVersion: 1;
  token: string;
  status: "ready" | "launch_failed";
  workerSlug: string;
  runId?: string;
  goalId?: string;
  ticketId?: string;
  baseRevision?: string;
  container?: string;
  startedAt?: string;
  pid?: number;
  head?: string;
  agentBase?: string;
  commitType?: string;
  recordedAt: string;
  error?: string;
};

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function canonicalBaseEnvironment(environment: { SPIKE_BASE_REVISION?: string; AGENT_BASE_REF?: string }): Record<string, string> {
  const durableBase = environment.SPIKE_BASE_REVISION?.trim();
  const requestedBase = environment.AGENT_BASE_REF?.trim();
  if (durableBase && requestedBase && durableBase !== requestedBase) {
    throw new Error(`SPIKE_BASE_REVISION and AGENT_BASE_REF disagree (${durableBase} != ${requestedBase})`);
  }
  if (durableBase) return { SPIKE_BASE_REVISION: durableBase, AGENT_BASE_REF: durableBase };
  if (requestedBase) return { AGENT_BASE_REF: requestedBase };
  return { AGENT_BASE_REF: "HEAD" };
}

export function createLaunchEvidenceToken(): string {
  return randomUUID();
}

export function launchEvidencePath(stateDir: string, token: string): string {
  return join(stateDir, "output", "launch", `${token}.json`);
}

export function buildPersistentLaunchScript(options: { environment: Record<string, string>; spikePath: string; agent: string; piArgs: string[] }): string {
  const assignments = Object.entries(options.environment).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const invocation = [
    "exec",
    "env",
    ...assignments,
    shellQuote(options.spikePath),
    "agent",
    "run",
    shellQuote(options.agent),
    ...options.piArgs.map(shellQuote),
  ].join(" ");
  return `#!/bin/sh\n${invocation}\n`;
}

export function validateLaunchEvidence(value: unknown, expectedToken?: string): LaunchEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("launch evidence is not a JSON object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== LAUNCH_EVIDENCE_SCHEMA_VERSION) throw new Error(`unsupported launch evidence schema: ${String(record.schemaVersion)}`);
  if (typeof record.token !== "string" || !record.token || (expectedToken && record.token !== expectedToken)) throw new Error("launch evidence has an invalid token");
  if (record.status !== "ready" && record.status !== "launch_failed") throw new Error("launch evidence has an invalid status");
  if (typeof record.workerSlug !== "string" || !workerPattern.test(record.workerSlug)) throw new Error("launch evidence has an invalid workerSlug");
  if (record.runId !== undefined && (typeof record.runId !== "string" || !runIdPattern.test(record.runId))) throw new Error("launch evidence has an invalid runId");
  if (record.goalId !== undefined && (typeof record.goalId !== "string" || !goalIdPattern.test(record.goalId))) throw new Error("launch evidence has an invalid goalId");
  if (record.ticketId !== undefined && (typeof record.ticketId !== "string" || !ticketIdPattern.test(record.ticketId))) throw new Error("launch evidence has an invalid ticketId");
  if (record.baseRevision !== undefined && (typeof record.baseRevision !== "string" || !objectIdPattern.test(record.baseRevision))) throw new Error("launch evidence has an invalid baseRevision");
  if (!validOptionalString(record.container)) throw new Error("launch evidence has an invalid container");
  if (record.startedAt !== undefined && !validTimestamp(record.startedAt)) throw new Error("launch evidence has an invalid startedAt");
  if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1)) throw new Error("launch evidence has an invalid pid");
  if (!validOptionalString(record.head)) throw new Error("launch evidence has an invalid head");
  if (!validOptionalString(record.agentBase)) throw new Error("launch evidence has an invalid agentBase");
  if (!validOptionalString(record.commitType)) throw new Error("launch evidence has an invalid commitType");
  if (!validTimestamp(record.recordedAt)) throw new Error("launch evidence has an invalid recordedAt");
  if (!validOptionalString(record.error)) throw new Error("launch evidence has an invalid error");
  if (record.status === "ready") {
    if (!objectIdPattern.test(String(record.head))) throw new Error("ready launch evidence has an invalid head commit");
    if (!objectIdPattern.test(String(record.agentBase))) throw new Error("ready launch evidence has an invalid agentBase commit");
    if (record.commitType !== "commit") throw new Error("ready launch evidence must report a commit object");
  }
  if (record.status === "launch_failed" && !record.error) throw new Error("failed launch evidence has no error");
  return record as LaunchEvidenceRecord;
}

export async function readLaunchEvidence(path: string, expectedToken?: string): Promise<LaunchEvidenceRecord> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`launch evidence is missing: ${path}`);
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`launch evidence is invalid JSON: ${path}`); }
  return validateLaunchEvidence(value, expectedToken);
}

export async function waitForLaunchEvidence(path: string, expectedToken: string, timeoutMs = 15_000): Promise<LaunchEvidenceRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readLaunchEvidence(path, expectedToken); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("launch evidence is missing:")) throw error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`launch evidence was not written before timeout: ${path}`);
}

export function assertDurableLaunchEvidence(
  record: LaunchEvidenceRecord,
  expected: { token: string; workerSlug: string; runId: string; goalId: string; ticketId: string; baseRevision: string; container: string; startedAt: string; pid: number },
): LaunchEvidenceRecord {
  const mismatch = (field: string, actual: unknown, wanted: unknown) => {
    throw new Error(`launch evidence ${field} mismatch (${String(actual)} != ${String(wanted)})`);
  };
  if (record.token !== expected.token) mismatch("token", record.token, expected.token);
  if (record.workerSlug !== expected.workerSlug) mismatch("workerSlug", record.workerSlug, expected.workerSlug);
  if (record.runId !== expected.runId) mismatch("runId", record.runId, expected.runId);
  if (record.goalId !== expected.goalId) mismatch("goalId", record.goalId, expected.goalId);
  if (record.ticketId !== expected.ticketId) mismatch("ticketId", record.ticketId, expected.ticketId);
  if (record.baseRevision !== expected.baseRevision) mismatch("baseRevision", record.baseRevision, expected.baseRevision);
  if (record.container !== expected.container) mismatch("container", record.container, expected.container);
  if (record.startedAt !== expected.startedAt) mismatch("startedAt", record.startedAt, expected.startedAt);
  if (record.pid !== expected.pid) mismatch("pid", record.pid, expected.pid);
  if (record.status !== "ready") throw new Error(record.error ? `launch evidence reports launch_failed: ${record.error}` : "launch evidence did not report readiness");
  if (record.commitType !== "commit") throw new Error(`launch evidence did not verify a commit object: ${String(record.commitType)}`);
  if (record.head !== expected.baseRevision) mismatch("head", record.head, expected.baseRevision);
  if (record.agentBase !== expected.baseRevision) mismatch("agentBase", record.agentBase, expected.baseRevision);
  return record;
}
