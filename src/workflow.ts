import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { loadActiveGoal, loadReadyTicket, loadWorkflowState, validateTicketRecord, type TicketRecord } from "./goals.ts";
import { loadActiveRun, normalizeAgentState, validateAgentStopIntent, validateRunRecord, type AgentState, type RunRecord } from "./runs.ts";
import { loadLatestPublication, type CommandRunner, type PublicationResult } from "./publication.ts";
import {
  MIGRATION_RECEIPT_SCHEMA_VERSION,
  TICKET_RESULT_SCHEMA_VERSION,
  WORKFLOW_DOCTOR_SCHEMA_VERSION,
  atomicWrite,
  durableWrite,
  exists,
  projectPath,
  readJson,
  rejectSymlinks,
  sha256,
  ticketResultPath,
  validObjectId,
  validateTicketResult,
  validateWorkflowState,
  workflowStatePath,
  type TicketResult,
  type WorkflowState,
} from "./workflow-state.ts";

const terminalRuns = new Set(["launch_failed", "stopped", "failed", "completed"]);

type GitResult = { code: number; stdout: string; stderr: string };

async function run(command: string[], cwd?: string): Promise<GitResult> {
  try {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) { return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
}

const commandRunner: CommandRunner = run;

async function verifyCommit(root: string, base: string, revision: string): Promise<void> {
  const type = await run(["git", "cat-file", "-t", revision], root);
  if (type.code !== 0 || type.stdout !== "commit") throw new Error(`accepted revision is not an available commit: ${revision}`);
  if (revision === base) throw new Error("accepted revision must differ from the ticket base");
  const ancestor = await run(["git", "merge-base", "--is-ancestor", base, revision], root);
  if (ancestor.code !== 0) throw new Error(`accepted revision ${revision} is not a descendant of ticket base ${base}`);
}

async function verifyPublication(root: string, publication: PublicationResult, expectedHead: string, expectedBase: string): Promise<void> {
  if (publication.head !== expectedHead) throw new Error(`accepted revision must equal worker ${publication.agent}'s latest validated publication head ${publication.head}`);
  if (publication.base !== expectedBase) throw new Error(`worker publication base ${publication.base} does not match ticket base ${expectedBase}`);
  const bundle = projectPath(root, publication.bundlePath, "publication bundle path");
  await rejectSymlinks(root, bundle, "publication bundle path");
  const verified = await run(["git", "bundle", "verify", bundle], root);
  if (verified.code !== 0) throw new Error(`publication bundle verification failed: ${verified.stderr || verified.stdout}`);
  const heads = await run(["git", "bundle", "list-heads", bundle], root);
  if (heads.code !== 0 || !heads.stdout.split(/\r?\n/).some((line) => line.startsWith(`${expectedHead} `))) throw new Error("publication bundle does not contain the accepted head");
}

async function findExplicitPublication(root: string, revision: string, base: string): Promise<PublicationResult | undefined> {
  const branches = join(root, ".pi-swarm", "output", "branches");
  if (!await exists(branches)) return undefined;
  const project = basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  const matches: PublicationResult[] = [];
  for (const agent of (await readdir(branches)).sort()) {
    const latest = await readJson(join(branches, agent, "latest.json"), "publication latest manifest", true) as Record<string, unknown> | undefined;
    if (latest?.head !== revision || latest?.base !== base || latest?.agent !== agent) continue;
    const publication = await loadLatestPublication({ root, stateDir: join(root, ".pi-swarm"), project }, agent, commandRunner);
    await verifyPublication(root, publication, revision, base);
    matches.push(publication);
  }
  if (matches.length > 1) throw new Error("multiple validated publications match this free-form ticket; retain only one explicit latest publication identity");
  return matches[0];
}

function publicationProvenance(publication: PublicationResult) {
  return {
    agent: publication.agent,
    head: publication.head,
    base: publication.base,
    importedRef: publication.importedRef,
    bundlePath: publication.bundlePath,
    manifestPath: publication.manifestPath,
    publishedAt: publication.publishedAt,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sameRequestedResult(result: TicketResult, options: { revision: string; review: "planner" | "hunk"; statement?: string }): boolean {
  return result.acceptedRevision === options.revision && result.review === options.review && result.statement === options.statement;
}

async function existingLatestResult(root: string, state: WorkflowState, options: { revision: string; review: "planner" | "hunk"; statement?: string }): Promise<TicketResult | undefined> {
  for (let index = state.ticketOrder.length - 1; index >= 0; index--) {
    const ticketId = state.ticketOrder[index];
    const value = await readJson(ticketResultPath(root, state.goalId, ticketId), "ticket result", true);
    if (value === undefined) continue;
    const result = validateTicketResult(value, { goalId: state.goalId, ticketId });
    if (!sameRequestedResult(result, options)) throw new Error(`ticket ${ticketId} already has a conflicting terminal result`);
    return result;
  }
}

export async function acceptTicket(options: {
  cwd?: string;
  revision: string;
  review: "planner" | "hunk";
  statement?: string;
  now?: Date;
  afterResultWritten?: () => void | Promise<void>;
}): Promise<{ result: TicketResult; idempotent: boolean }> {
  const cwd = options.cwd ?? process.cwd();
  if (!validObjectId(options.revision)) throw new Error("ticket accept requires a full commit object ID for --revision");
  if (options.review !== "planner" && options.review !== "hunk") throw new Error("ticket accept --review must be planner or hunk");
  if (options.statement !== undefined && !options.statement.trim()) throw new Error("ticket accept statement must not be blank");
  if (options.now && !Number.isFinite(options.now.getTime())) throw new Error("acceptance time is invalid");
  const active = await loadActiveGoal(cwd);
  const root = await realpath(active.record.repositoryRoot);
  const goalDirectory = join(root, ".pi-swarm", "goals", active.record.goalId);
  const lockPath = join(goalDirectory, "workflow.lock");
  await rejectSymlinks(root, lockPath, "workflow lock path");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another workflow transition is in progress"); throw error; }
  try {
    const state = await loadWorkflowState(root);
    if (!state.activeTicketId) {
      const prior = await existingLatestResult(root, state, options);
      if (prior) {
        const stalePointer = join(goalDirectory, "active-ticket.json");
        const pointer = await readJson(stalePointer, "active ticket pointer", true) as Record<string, unknown> | undefined;
        if (pointer !== undefined) {
          if (pointer.goalId !== state.goalId || pointer.ticketId !== prior.ticketId) throw new Error("stale active-ticket pointer conflicts with accepted workflow state");
          await rm(stalePointer);
        }
        return { result: prior, idempotent: true };
      }
      throw new Error("no ready ticket to accept");
    }
    const ready = await loadReadyTicket(root);
    if (ready.record.ticketId !== state.activeTicketId || ready.record.baseRevision !== state.acceptedCodeRevision) throw new Error("ready ticket is inconsistent with workflow state");
    await verifyCommit(root, ready.record.baseRevision, options.revision);

    let durableRun: RunRecord | undefined;
    try { durableRun = await loadActiveRun(root); }
    catch (error) { if (!(error instanceof Error) || !error.message.startsWith("no run for the ready ticket")) throw error; }
    let publication: PublicationResult | undefined;
    if (durableRun) {
      if (!terminalRuns.has(durableRun.status)) throw new Error(`ticket run ${durableRun.runId} is nonterminal (${durableRun.status})`);
      const project = basename(root).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
      publication = await loadLatestPublication({ root, stateDir: join(root, ".pi-swarm"), project, }, durableRun.worker.slug, commandRunner);
      await verifyPublication(root, publication, options.revision, ready.record.baseRevision);
    } else publication = await findExplicitPublication(root, options.revision, ready.record.baseRevision);

    const acceptedAt = (options.now ?? new Date()).toISOString();
    const candidate = validateTicketResult({
      schemaVersion: TICKET_RESULT_SCHEMA_VERSION,
      ticketId: ready.record.ticketId,
      goalId: ready.record.goalId,
      baseRevision: ready.record.baseRevision,
      acceptedRevision: options.revision,
      outcome: "accepted",
      review: options.review,
      ...(options.statement !== undefined ? { statement: options.statement } : {}),
      acceptedAt,
      ...(durableRun ? { worker: durableRun.worker, runId: durableRun.runId } : {}),
      ...(publication ? { publication: publicationProvenance(publication) } : {}),
      provenanceMigrated: false,
    }, { goalId: ready.record.goalId, ticketId: ready.record.ticketId, baseRevision: ready.record.baseRevision });
    const resultPath = ticketResultPath(root, ready.record.goalId, ready.record.ticketId);
    const existingValue = await readJson(resultPath, "ticket result", true);
    let result = candidate;
    let idempotent = false;
    if (existingValue !== undefined) {
      const existing = validateTicketResult(existingValue, { goalId: ready.record.goalId, ticketId: ready.record.ticketId, baseRevision: ready.record.baseRevision });
      if (!sameRequestedResult(existing, options) || canonical({ ...existing, acceptedAt: candidate.acceptedAt }) !== canonical(candidate)) throw new Error("ticket already has a conflicting terminal result");
      result = existing;
      idempotent = true;
    } else {
      await durableWrite(resultPath, `${JSON.stringify(candidate, null, 2)}\n`);
    }
    if (options.afterResultWritten) await options.afterResultWritten();
    const current = validateWorkflowState(await readJson(workflowStatePath(root, state.goalId), "workflow state"), state.goalId);
    if (current.activeTicketId === ready.record.ticketId) {
      if (current.stateRevision !== state.stateRevision || current.acceptedCodeRevision !== ready.record.baseRevision) throw new Error("workflow state changed while acceptance was prepared; retry to recover");
      const transitioned = validateWorkflowState({
        ...current,
        acceptedCodeRevision: result.acceptedRevision,
        activeTicketId: null,
        stateRevision: current.stateRevision + 1,
        lastTransitionAt: result.acceptedAt,
      }, state.goalId);
      await atomicWrite(workflowStatePath(root, state.goalId), `${JSON.stringify(transitioned, null, 2)}\n`);
      await rm(join(goalDirectory, "active-ticket.json"), { force: true });
    } else if (current.activeTicketId !== null || current.acceptedCodeRevision !== result.acceptedRevision) {
      throw new Error("prepared acceptance conflicts with current workflow state");
    }
    return { result, idempotent };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export type TicketHistoryEntry = {
  issuance: number;
  ticket: TicketRecord;
  status: "ready" | "accepted" | "migrated";
  result?: TicketResult;
};

async function readTicket(root: string, state: WorkflowState, ticketId: string): Promise<TicketRecord> {
  const goalDirectory = join(root, ".pi-swarm", "goals", state.goalId);
  const value = await readJson(join(goalDirectory, "tickets", ticketId, "record.v1.json"), "ticket record");
  const record = validateTicketRecord(value, { root, goalId: state.goalId, goalDirectory });
  const snapshot = projectPath(root, record.snapshotPath, "ticket snapshot path");
  const worker = projectPath(root, record.workerPath, "worker ticket path");
  await rejectSymlinks(root, snapshot, "ticket snapshot path");
  await rejectSymlinks(root, worker, "worker ticket path");
  const [snapshotBytes, workerBytes] = await Promise.all([readFile(snapshot), readFile(worker)]);
  if (snapshotBytes.byteLength !== record.snapshotBytes || sha256(snapshotBytes) !== record.snapshotSha256) throw new Error(`ticket ${ticketId} snapshot integrity check failed`);
  if (!snapshotBytes.equals(workerBytes)) throw new Error(`ticket ${ticketId} worker copy integrity check failed`);
  return record;
}

export async function ticketHistory(cwd = process.cwd(), options: { readOnly?: boolean } = {}): Promise<TicketHistoryEntry[]> {
  const active = await loadActiveGoal(cwd, options);
  const root = active.record.repositoryRoot;
  const state = await loadWorkflowState(root, options);
  const entries: TicketHistoryEntry[] = [];
  for (let index = 0; index < state.ticketOrder.length; index++) {
    const ticketId = state.ticketOrder[index];
    const ticket = await readTicket(root, state, ticketId);
    const value = await readJson(ticketResultPath(root, state.goalId, ticketId), "ticket result", true);
    if (value === undefined) {
      if (state.activeTicketId !== ticketId) throw new Error(`ticket ${ticketId} has no terminal result and is not active`);
      entries.push({ issuance: index + 1, ticket, status: "ready" });
    } else {
      const result = validateTicketResult(value, { goalId: state.goalId, ticketId, baseRevision: ticket.baseRevision });
      await verifyCommit(root, result.baseRevision, result.acceptedRevision);
      entries.push({ issuance: index + 1, ticket, status: result.provenanceMigrated ? "migrated" : "accepted", result });
    }
  }
  return entries;
}

async function readAgentReadonly(stateDir: string, slug: string): Promise<AgentState | undefined> {
  const value = await readJson(join(stateDir, "agents", `${slug}.json`), "agent state", true);
  return value === undefined ? undefined : normalizeAgentState(value, slug).state;
}

export type DoctorReport = {
  schemaVersion: 1;
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: { goalId?: string; acceptedCodeRevision?: string; activeTicketId?: string | null; activeRunId?: string | null; tickets: number; results: number };
};

async function inspectResultPublication(root: string, result: TicketResult): Promise<void> {
  if (!result.publication) return;
  const manifestPath = projectPath(root, result.publication.manifestPath, "result publication manifest path");
  const bundlePath = projectPath(root, result.publication.bundlePath, "result publication bundle path");
  await rejectSymlinks(root, manifestPath, "result publication manifest path");
  await rejectSymlinks(root, bundlePath, "result publication bundle path");
  const manifest = await readJson(manifestPath, "result publication manifest") as Record<string, unknown>;
  if (manifest.head !== result.acceptedRevision || manifest.base !== result.publication.base || manifest.agent !== result.publication.agent || manifest.bundlePath !== result.publication.bundlePath) throw new Error(`publication manifest for ${result.ticketId} does not match its result`);
  const ref = await run(["git", "rev-parse", "--verify", `${result.publication.importedRef}^{commit}`], root);
  if (ref.code !== 0 || ref.stdout !== result.acceptedRevision) throw new Error(`publication ref for ${result.ticketId} is missing or inconsistent`);
  const bundle = await run(["git", "bundle", "verify", bundlePath], root);
  if (bundle.code !== 0) throw new Error(`publication bundle for ${result.ticketId} is invalid or missing`);
}

export async function workflowDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const report: DoctorReport = { schemaVersion: WORKFLOW_DOCTOR_SCHEMA_VERSION, ok: false, errors: [], warnings: [], summary: { tickets: 0, results: 0 } };
  let root: string;
  try {
    const active = await loadActiveGoal(cwd, { readOnly: true });
    root = active.record.repositoryRoot;
    const state = await loadWorkflowState(root, { readOnly: true });
    report.summary.goalId = state.goalId;
    report.summary.acceptedCodeRevision = state.acceptedCodeRevision;
    report.summary.activeTicketId = state.activeTicketId;
    const history = await ticketHistory(root, { readOnly: true });
    report.summary.tickets = history.length;
    report.summary.results = history.filter((entry) => entry.result).length;
    for (const entry of history) {
      if (entry.result) {
        try { await inspectResultPublication(root, entry.result); } catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); }
        if (entry.result.runId) {
          const runPath = join(root, `.pi-swarm/goals/${state.goalId}/tickets/${entry.ticket.ticketId}/runs/${entry.result.runId}/record.v1.json`);
          try {
            const runRecord = validateRunRecord(await readJson(runPath, "result run record"), { goalId: state.goalId, ticketId: entry.ticket.ticketId, baseRevision: entry.ticket.baseRevision, runId: entry.result.runId });
            if (!terminalRuns.has(runRecord.status) || runRecord.worker.slug !== entry.result.worker?.slug) throw new Error(`run provenance for ${entry.ticket.ticketId} is inconsistent`);
            const agent = await readAgentReadonly(join(root, ".pi-swarm"), runRecord.worker.slug);
            if (!agent || agent.runId !== runRecord.runId || agent.goalId !== runRecord.goalId || agent.ticketId !== runRecord.ticketId || agent.baseRevision !== runRecord.baseRevision || !agent.finishedAt) {
              throw new Error(`agent/run correlation for ${entry.ticket.ticketId} is missing or inconsistent`);
            }
          } catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); }
        } else if (!entry.result.provenanceMigrated && entry.result.worker) report.errors.push(`ticket ${entry.ticket.ticketId} has worker provenance without a run`);
      }
    }
    if (state.activeTicketId) {
      const activeEntry = history.find((entry) => entry.ticket.ticketId === state.activeTicketId)!;
      const ticketDirectory = join(root, ".pi-swarm", "goals", state.goalId, "tickets", state.activeTicketId);
      const pointerValue = await readJson(join(ticketDirectory, "active-run.json"), "active run pointer", true);
      if (pointerValue === undefined) report.summary.activeRunId = null;
      else try {
        const pointer = pointerValue as Record<string, unknown>;
        if (typeof pointer.runId !== "string" || typeof pointer.recordPath !== "string") throw new Error("active run pointer has invalid identity");
        const record = validateRunRecord(await readJson(projectPath(root, pointer.recordPath, "active run record path"), "active run record"), {
          goalId: state.goalId, ticketId: state.activeTicketId, baseRevision: activeEntry.ticket.baseRevision, runId: pointer.runId,
        });
        report.summary.activeRunId = record.runId;
      } catch (error) { report.errors.push(error instanceof Error ? error.message : String(error)); }
    } else report.summary.activeRunId = null;

    const pointerPath = join(root, ".pi-swarm", "goals", state.goalId, "active-ticket.json");
    const ticketPointer = await readJson(pointerPath, "active ticket pointer", true);
    if (!state.activeTicketId && ticketPointer !== undefined) report.errors.push("active-ticket pointer remains although workflow state has no active ticket");
    if (state.activeTicketId && (ticketPointer as Record<string, unknown> | undefined)?.ticketId !== state.activeTicketId) report.errors.push("active-ticket pointer is missing or inconsistent with workflow state");
    for (const entry of history) {
      const ticketDirectory = join(root, ".pi-swarm", "goals", state.goalId, "tickets", entry.ticket.ticketId);
      for (const lock of ["dispatch.lock"]) if (await exists(join(ticketDirectory, lock))) report.warnings.push(`stale ticket lock: ${relative(root, join(ticketDirectory, lock)).split(sep).join("/")}`);
    }
    const agentsDirectory = join(root, ".pi-swarm", "agents");
    if (await exists(agentsDirectory)) {
      for (const file of (await readdir(agentsDirectory)).filter((name) => name.endsWith(".json")).sort()) {
        const slug = file.slice(0, -5);
        try { await readAgentReadonly(join(root, ".pi-swarm"), slug); } catch (error) { report.errors.push(`agent ${slug}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const intents = join(agentsDirectory, "stop-intents");
      if (await exists(intents)) for (const file of (await readdir(intents)).filter((name) => name.endsWith(".json")).sort()) {
        try {
          const intent = validateAgentStopIntent(await readJson(join(intents, file), "agent stop intent"));
          const agent = await readAgentReadonly(join(root, ".pi-swarm"), intent.slug);
          if (!agent || agent.finishedAt) report.warnings.push(`stale stop intent for terminal or missing agent ${intent.slug}`);
        } catch (error) { report.errors.push(`stop intent ${file}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      for (const file of (await readdir(agentsDirectory)).filter((name) => name.endsWith(".lock")).sort()) report.warnings.push(`stale lifecycle lock: .pi-swarm/agents/${file}`);
    }
    for (const lock of ["activation.lock", `${state.goalId}/ticket-issuance.lock`, `${state.goalId}/workflow.lock`]) if (await exists(join(root, ".pi-swarm", "goals", lock))) report.warnings.push(`stale workflow lock: .pi-swarm/goals/${lock}`);
    const legacy = [join(root, ".pi-swarm", "goals", "001"), join(root, ".pi-swarm", "reconciliation")];
    if ((await Promise.all(legacy.map((path) => exists(path)))).some(Boolean)) report.warnings.push("legacy bootstrap state remains; run spike workflow migrate-bootstrap");
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  report.ok = report.errors.length === 0;
  return report;
}

export type MigrationAction = { action: "import" | "archive" | "remove" | "retain" | "receipt"; source?: string; destination?: string; sha256?: string; reason?: string };

function migratedTicketId(goalId: string, baseRevision: string, digest: string): string {
  return `ticket-${new Bun.CryptoHasher("sha256").update(`spike-ticket-v1\0${JSON.stringify({ goalId, baseRevision, digest })}`).digest("hex").slice(0, 32)}`;
}
export type MigrationPlan = { schemaVersion: 1; migration: "bootstrap-001"; applicable: boolean; applied: boolean; actions: MigrationAction[]; errors: string[] };

/*
 * Bootstrap layouts predate a single machine schema.  The importer deliberately
 * accepts only an explicit, independently-checkable bootstrap manifest.  Old
 * installations can create it from their Markdown evidence without modifying
 * that evidence; unsupported prose is reported and retained rather than guessed.
 */
type BootstrapManifest = {
  schemaVersion: 1;
  goalId: string;
  tickets: Array<{
    snapshotPath: string; baseRevision: string; acceptedRevision: string; issuedAt: string; acceptedAt: string;
    review: "planner" | "hunk"; statement?: string; worker?: { name: string; slug: string }; runId?: string;
    publicationManifestPath?: string; sourcePaths?: string[];
  }>;
  archivePaths?: string[];
  removeMirrors?: Array<{ path: string; equivalentTo: string }>;
  removeStopIntents?: string[];
};

async function evidenceDigest(root: string, path: string): Promise<string> {
  await rejectSymlinks(root, path, "bootstrap evidence path");
  const info = await lstat(path);
  if (info.isFile()) return sha256(await readFile(path));
  if (!info.isDirectory()) throw new Error(`bootstrap evidence is not a regular file or directory: ${relative(root, path)}`);
  const parts: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const child = join(directory, name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) throw new Error(`bootstrap evidence contains a symbolic link: ${relative(root, child)}`);
      const key = prefix ? `${prefix}/${name}` : name;
      if (childStat.isDirectory()) await walk(child, key);
      else if (childStat.isFile()) parts.push(`${key}\0${sha256(await readFile(child))}`);
      else throw new Error(`bootstrap evidence contains an unsupported entry: ${relative(root, child)}`);
    }
  }
  await walk(path, "");
  return sha256(parts.join("\n"));
}

async function migrationPlan(cwd: string, readOnly: boolean): Promise<{ root: string; state: WorkflowState; manifest?: BootstrapManifest; plan: MigrationPlan }> {
  const active = await loadActiveGoal(cwd, { readOnly });
  const root = active.record.repositoryRoot;
  const state = await loadWorkflowState(root, { readOnly });
  const manifestPath = join(root, ".pi-swarm", "goals", "001", "migration.v1.json");
  const receiptPath = join(root, ".pi-swarm", "archive", "bootstrap-001", "migration-receipt.v1.json");
  const plan: MigrationPlan = { schemaVersion: 1, migration: "bootstrap-001", applicable: false, applied: false, actions: [], errors: [] };
  if (await exists(receiptPath)) {
    plan.applied = true;
    plan.actions.push({ action: "receipt", destination: relative(root, receiptPath).split(sep).join("/") });
    return { root, state, plan };
  }
  const value = await readJson(manifestPath, "bootstrap migration manifest", true);
  if (value === undefined) {
    const legacy = join(root, ".pi-swarm", "goals", "001");
    if (await exists(legacy)) plan.errors.push("unsupported bootstrap layout: goals/001/migration.v1.json is absent; legacy evidence was retained");
    return { root, state, plan };
  }
  const manifest = value as BootstrapManifest;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.goalId !== state.goalId || !Array.isArray(manifest.tickets)) {
    plan.errors.push("bootstrap migration manifest is invalid or belongs to another active goal");
    return { root, state, plan };
  }
  plan.applicable = true;
  for (const item of manifest.tickets) {
    try {
      if (!validObjectId(item.baseRevision) || !validObjectId(item.acceptedRevision) || !item.snapshotPath || !item.issuedAt || !item.acceptedAt) throw new Error("invalid ticket identity or revision metadata");
      await verifyCommit(root, item.baseRevision, item.acceptedRevision);
      const source = projectPath(root, item.snapshotPath, "bootstrap snapshot path");
      await rejectSymlinks(root, source, "bootstrap snapshot path");
      const bytes = await readFile(source);
      const digest = sha256(bytes);
      const ticketId = migratedTicketId(state.goalId, item.baseRevision, digest);
      plan.actions.push({ action: "import", source: item.snapshotPath, destination: `.pi-swarm/goals/${state.goalId}/tickets/${ticketId}/ticket.md`, sha256: digest });
    } catch (error) { plan.errors.push(`${item.snapshotPath ?? "ticket"}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const path of manifest.archivePaths ?? [".pi-swarm/goals/001"]) {
    try {
      const source = projectPath(root, path, "bootstrap archive source");
      plan.actions.push({ action: "archive", source: path, destination: `.pi-swarm/archive/bootstrap-001/${basename(path)}`, sha256: await evidenceDigest(root, source) });
    } catch (error) { plan.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const mirror of manifest.removeMirrors ?? []) {
    try {
      const source = projectPath(root, mirror.path, "bootstrap mirror path");
      const authoritative = projectPath(root, mirror.equivalentTo, "bootstrap authoritative path");
      const [sourceBytes, authoritativeBytes] = await Promise.all([readFile(source), readFile(authoritative)]);
      if (!sourceBytes.equals(authoritativeBytes)) throw new Error(`not byte-equivalent to ${mirror.equivalentTo}`);
      plan.actions.push({ action: "remove", source: mirror.path, destination: mirror.equivalentTo, sha256: sha256(sourceBytes), reason: `byte-equivalent to ${mirror.equivalentTo}` });
    } catch (error) { plan.errors.push(`${mirror.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const intentPath of manifest.removeStopIntents ?? []) {
    try {
      const absolute = projectPath(root, intentPath, "bootstrap stop intent path");
      const intent = validateAgentStopIntent(await readJson(absolute, "bootstrap stop intent"));
      const agent = await readAgentReadonly(join(root, ".pi-swarm"), intent.slug);
      if (!agent || agent.startedAt !== intent.startedAt || agent.pid !== intent.pid || agent.container !== intent.container || agent.runId !== intent.runId ||
        agent.lifecycle !== "stopped" || agent.outcome !== "stopped" || agent.terminationKind !== "requested" || agent.stopRequestedAt !== intent.stopRequestedAt) {
        throw new Error("intent does not match a terminal requested-stop agent outcome");
      }
      plan.actions.push({ action: "remove", source: intentPath, sha256: await evidenceDigest(root, absolute), reason: "validated terminal requested-stop intent" });
    } catch (error) { plan.errors.push(`${intentPath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  plan.actions.push({ action: "receipt", destination: ".pi-swarm/archive/bootstrap-001/migration-receipt.v1.json" });
  return { root, state, manifest, plan };
}

export async function migrateBootstrap(options: { cwd?: string; apply?: boolean; now?: Date }): Promise<MigrationPlan> {
  const { root, state, manifest, plan } = await migrationPlan(options.cwd ?? process.cwd(), !options.apply);
  if (!options.apply || plan.applied || !manifest) return plan;
  if (plan.errors.length) throw new Error(`bootstrap migration refused: ${plan.errors.join("; ")}`);
  const lockPath = join(root, ".pi-swarm", "goals", state.goalId, "workflow.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another workflow transition is in progress"); throw error; }
  try {
    let current = validateWorkflowState(await readJson(workflowStatePath(root, state.goalId), "workflow state"), state.goalId);
    const created: string[] = [];
    const importedIds: string[] = [];
    let finalAcceptedRevision = current.acceptedCodeRevision;
    let finalTransitionAt = current.lastTransitionAt;
    for (const item of manifest.tickets) {
      const source = projectPath(root, item.snapshotPath, "bootstrap snapshot path");
      const bytes = await readFile(source);
      const digest = sha256(bytes);
      const ticketId = migratedTicketId(state.goalId, item.baseRevision, digest);
      const directory = join(root, ".pi-swarm", "goals", state.goalId, "tickets", ticketId);
      const workerDirectory = join(root, ".pi-swarm", "output", "workflow", state.goalId, "tickets", ticketId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
      const recordPath = join(directory, "record.v1.json");
      let record: TicketRecord = {
        schemaVersion: 1, ticketId, goalId: state.goalId, status: "ready", baseRevision: item.baseRevision,
        snapshotPath: `.pi-swarm/goals/${state.goalId}/tickets/${ticketId}/ticket.md`, snapshotSha256: digest, snapshotBytes: bytes.byteLength,
        sourcePath: item.snapshotPath, workerPath: `.pi-swarm/output/workflow/${state.goalId}/tickets/${ticketId}/ticket.md`, issuedAt: item.issuedAt,
      };
      const goalDirectory = join(root, ".pi-swarm", "goals", state.goalId);
      if (await exists(recordPath)) {
        record = validateTicketRecord(await readJson(recordPath, "existing generated ticket record"), { root, goalId: state.goalId, goalDirectory, baseRevision: item.baseRevision });
        if (record.ticketId !== ticketId || record.snapshotSha256 !== digest || record.snapshotBytes !== bytes.byteLength) throw new Error(`existing generated ticket conflicts with bootstrap evidence: ${ticketId}`);
      } else validateTicketRecord(record, { root, goalId: state.goalId, goalDirectory, baseRevision: item.baseRevision });
      for (const [path, content] of [[join(directory, "ticket.md"), bytes], [join(workerDirectory, "ticket.md"), bytes], [recordPath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`)] ] as const) {
        if (await exists(path)) { if (!(await readFile(path)).equals(content)) throw new Error(`migration destination conflicts: ${relative(root, path)}`); }
        else { await durableWrite(path, content); created.push(path); }
      }
      let publication;
      if (item.publicationManifestPath) {
        const p = await readJson(projectPath(root, item.publicationManifestPath, "bootstrap publication manifest"), "bootstrap publication manifest") as Record<string, unknown>;
        if (p.head !== item.acceptedRevision || p.base !== item.baseRevision || typeof p.agent !== "string") throw new Error(`publication evidence conflicts for ${item.snapshotPath}`);
        publication = { agent: p.agent, head: p.head, base: p.base, importedRef: p.importedRef, bundlePath: p.bundlePath, manifestPath: item.publicationManifestPath, publishedAt: p.publishedAt };
      }
      const result = validateTicketResult({
        schemaVersion: 1, ticketId, goalId: state.goalId, baseRevision: item.baseRevision, acceptedRevision: item.acceptedRevision,
        outcome: "accepted", review: item.review, ...(item.statement ? { statement: item.statement } : {}), acceptedAt: item.acceptedAt,
        ...(item.worker ? { worker: item.worker } : {}), ...(item.runId ? { runId: item.runId } : {}), ...(publication ? { publication } : {}), provenanceMigrated: true,
      }, { goalId: state.goalId, ticketId, baseRevision: item.baseRevision });
      const resultPath = ticketResultPath(root, state.goalId, ticketId);
      if (await exists(resultPath)) {
        if (canonical(validateTicketResult(await readJson(resultPath, "ticket result"))) !== canonical(result)) throw new Error(`migration result conflicts: ${ticketId}`);
      } else { await durableWrite(resultPath, `${JSON.stringify(result, null, 2)}\n`); created.push(resultPath); }
      importedIds.push(ticketId);
      finalAcceptedRevision = item.acceptedRevision;
      finalTransitionAt = item.acceptedAt;
    }
    if (new Set(importedIds).size !== importedIds.length) throw new Error("bootstrap manifest contains duplicate ticket identities");
    const unknownExisting = current.ticketOrder.filter((ticketId) => !importedIds.includes(ticketId));
    if (unknownExisting.length) throw new Error(`workflow contains tickets absent from bootstrap evidence: ${unknownExisting.join(", ")}`);
    current = validateWorkflowState({
      ...current,
      acceptedCodeRevision: finalAcceptedRevision,
      activeTicketId: null,
      stateRevision: current.stateRevision + importedIds.filter((ticketId) => !current.ticketOrder.includes(ticketId)).length + (current.activeTicketId ? 1 : 0),
      lastTransitionAt: finalTransitionAt,
      ticketOrder: importedIds,
    }, state.goalId);
    await atomicWrite(workflowStatePath(root, state.goalId), `${JSON.stringify(current, null, 2)}\n`);

    // Destructive cleanup starts only after every destination validates.
    for (const entry of await ticketHistory(root)) if (!entry.result) throw new Error(`imported ticket ${entry.ticket.ticketId} has no result`);
    for (const mirror of manifest.removeMirrors ?? []) {
      const source = projectPath(root, mirror.path, "bootstrap mirror path");
      const authoritative = projectPath(root, mirror.equivalentTo, "bootstrap authoritative path");
      if (!(await readFile(source)).equals(await readFile(authoritative))) throw new Error(`refusing to remove non-equivalent mirror ${mirror.path}`);
    }
    const archiveRoot = join(root, ".pi-swarm", "archive", "bootstrap-001");
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    for (const mirror of manifest.removeMirrors ?? []) await rm(projectPath(root, mirror.path, "bootstrap mirror path"));
    for (const intentPath of manifest.removeStopIntents ?? []) await rm(projectPath(root, intentPath, "bootstrap stop intent path"));
    for (const sourcePath of manifest.archivePaths ?? [".pi-swarm/goals/001"]) {
      const source = projectPath(root, sourcePath, "bootstrap archive source");
      if (!await exists(source)) continue;
      const destination = join(archiveRoot, basename(source));
      if (await exists(destination)) throw new Error(`archive destination already exists: ${relative(root, destination)}`);
      await rename(source, destination);
    }
    const receipt = { schemaVersion: MIGRATION_RECEIPT_SCHEMA_VERSION, migration: "bootstrap-001", goalId: state.goalId, appliedAt: (options.now ?? new Date()).toISOString(), actions: plan.actions };
    await durableWrite(join(archiveRoot, "migration-receipt.v1.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return { ...plan, applied: true };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
