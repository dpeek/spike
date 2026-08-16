import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadActiveGoal, loadWorkflowState, validateTicketRecord, type TicketRecord } from "./goals.ts";
import { normalizeAgentState, validateActiveRunPointer, validateAgentStopIntent, validateRunRecord, type AgentState, type RunRecord } from "./runs.ts";
import { validatePublicationManifest } from "./publication.ts";
import {
  atomicWrite, durableWrite, exists, projectPath, readJson, rejectSymlinks, sha256, ticketResultPath,
  validateTicketResult, validateWorkflowState, workflowStatePath, type ResultPublication, type TicketResult, type WorkflowState,
} from "./workflow-state.ts";

export type BootstrapAction = { action: "import" | "correlate" | "archive" | "remove" | "retain" | "receipt"; source?: string; destination?: string; sha256?: string; reason?: string };
export type BootstrapPlan = { schemaVersion: 1; migration: "bootstrap-001"; applicable: boolean; applied: boolean; actions: BootstrapAction[]; errors: string[] };

type ParsedTicket = {
  ordinal: number;
  ticket: TicketRecord;
  snapshot: Buffer;
  result: TicketResult;
  agentPath: string;
  agent: AgentState;
  run?: RunRecord;
};

type Prepared = {
  root: string;
  state: WorkflowState;
  tickets: ParsedTicket[];
  activeTicket?: TicketRecord;
  intentPath: string;
  mirrors: string[];
  archivePaths: Array<{ source: string; destination: string }>;
  plan: BootstrapPlan;
};

type GitResult = { code: number; stdout: string; stderr: string };
async function git(root: string, args: string[]): Promise<GitResult> {
  try {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) { return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
}

function rel(root: string, path: string): string { return relative(root, path).split(sep).join("/"); }
function markdownField(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^[-*]\\s+${escaped}:\\s*(?:\\x60([^\\x60]+)\\x60|(.+?))\\s*$`, "im"));
  return (match?.[1] ?? match?.[2])?.trim();
}
function requireField(text: string, label: string, source: string): string {
  const value = markdownField(text, label);
  if (!value) throw new Error(`${source} has no ${label}`);
  return value;
}
function migratedTicketId(goalId: string, baseRevision: string, digest: string): string {
  return `ticket-${new Bun.CryptoHasher("sha256").update(`spike-ticket-v1\0${JSON.stringify({ goalId, baseRevision, digest })}`).digest("hex").slice(0, 32)}`;
}
async function verifyCommit(root: string, base: string, head: string): Promise<void> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) || base === head) throw new Error("invalid or equal base/accepted revision");
  if ((await git(root, ["cat-file", "-e", `${base}^{commit}`])).code || (await git(root, ["cat-file", "-e", `${head}^{commit}`])).code) throw new Error("base or accepted revision is unavailable");
  if ((await git(root, ["merge-base", "--is-ancestor", base, head])).code) throw new Error(`${head} is not a descendant of ${base}`);
}
async function treeDigest(root: string, path: string): Promise<string> {
  await rejectSymlinks(root, path, "bootstrap evidence");
  const info = await lstat(path);
  if (info.isFile()) return sha256(await readFile(path));
  if (!info.isDirectory()) throw new Error(`unsupported bootstrap evidence: ${rel(root, path)}`);
  const entries: string[] = [];
  async function walk(directory: string, prefix: string) {
    for (const name of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(directory, name.name);
      const key = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isSymbolicLink()) throw new Error(`bootstrap evidence contains symbolic link: ${rel(root, child)}`);
      if (name.isDirectory()) await walk(child, key);
      else if (name.isFile()) entries.push(`${key}\0${sha256(await readFile(child))}`);
      else throw new Error(`unsupported bootstrap evidence: ${rel(root, child)}`);
    }
  }
  await walk(path, "");
  return sha256(entries.join("\n"));
}
async function publication(root: string, worker: string, base: string, head: string): Promise<ResultPublication> {
  const directory = join(root, ".pi-swarm", "output", "branches", worker);
  const manifestPath = join(directory, `${head}.json`);
  const latestPath = join(directory, "latest.json");
  await rejectSymlinks(root, manifestPath, "bootstrap publication manifest");
  await rejectSymlinks(root, latestPath, "bootstrap publication latest");
  const raw = await readJson(manifestPath, "bootstrap publication manifest") as Record<string, unknown>;
  if (typeof raw.project !== "string") throw new Error(`publication for ${worker} has no project`);
  const expected = { root, project: raw.project, agent: worker, publicationDirectory: directory };
  const manifest = validatePublicationManifest(raw, expected);
  const latest = validatePublicationManifest(await readJson(latestPath, "bootstrap publication latest"), expected);
  if (manifest.base !== base || manifest.head !== head || latest.base !== manifest.base || latest.head !== manifest.head || latest.agent !== manifest.agent || latest.importedRef !== manifest.importedRef || latest.bundlePath !== manifest.bundlePath || latest.workerBranch !== manifest.workerBranch || latest.publishedAt !== manifest.publishedAt) throw new Error(`publication for ${worker} does not match accepted base/head or latest pointer`);
  const ref = await git(root, ["rev-parse", "--verify", `${manifest.importedRef}^{commit}`]);
  if (ref.code || ref.stdout !== head) throw new Error(`publication ref for ${worker} does not resolve to accepted head`);
  const bundle = projectPath(root, manifest.bundlePath, "bootstrap publication bundle");
  if ((await git(root, ["bundle", "verify", bundle])).code) throw new Error(`publication bundle for ${worker} is invalid`);
  const heads = await git(root, ["bundle", "list-heads", bundle]);
  if (heads.code || !heads.stdout.split(/\r?\n/).some((line) => line.startsWith(`${head} `))) throw new Error(`publication bundle for ${worker} omits accepted head`);
  return { agent: worker, head, base, importedRef: manifest.importedRef, bundlePath: manifest.bundlePath, manifestPath: rel(root, manifestPath), publishedAt: manifest.publishedAt };
}
async function readGeneratedTicket(root: string, state: WorkflowState, ticketId: string): Promise<{ ticket: TicketRecord; snapshot: Buffer }> {
  const goalDirectory = join(root, ".pi-swarm", "goals", state.goalId);
  const directory = join(goalDirectory, "tickets", ticketId);
  const ticket = validateTicketRecord(await readJson(join(directory, "record.v1.json"), "generated bootstrap ticket"), { root, goalId: state.goalId, goalDirectory });
  const snapshot = await readFile(join(directory, "ticket.md"));
  if (snapshot.byteLength !== ticket.snapshotBytes || sha256(snapshot) !== ticket.snapshotSha256) throw new Error(`generated ticket ${ticketId} snapshot integrity failed`);
  const worker = await readFile(projectPath(root, ticket.workerPath, "generated worker ticket"));
  if (!snapshot.equals(worker)) throw new Error(`generated ticket ${ticketId} worker copy differs`);
  return { ticket, snapshot };
}
async function findFiles(directory: string, fileName: string): Promise<string[]> {
  const found: string[] = [];
  if (!await exists(directory)) return found;
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`bootstrap state contains symbolic link: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name === fileName) found.push(child);
    }
  }
  await walk(directory);
  return found;
}

async function prepare(cwd: string): Promise<Prepared> {
  const active = await loadActiveGoal(cwd, { readOnly: true });
  const root = active.record.repositoryRoot;
  const state = await loadWorkflowState(root, { readOnly: true });
  const receipt = join(root, ".pi-swarm", "archive", "bootstrap-001", "migration-receipt.v1.json");
  if (await exists(receipt)) return { root, state, tickets: [], intentPath: "", mirrors: [], archivePaths: [], plan: { schemaVersion: 1, migration: "bootstrap-001", applicable: true, applied: true, actions: [{ action: "receipt", destination: rel(root, receipt) }], errors: [] } };
  const plan: BootstrapPlan = { schemaVersion: 1, migration: "bootstrap-001", applicable: false, applied: false, actions: [], errors: [] };
  const legacyRoot = join(root, ".pi-swarm", "goals", "001");
  const reconciliation = join(root, ".pi-swarm", "reconciliation");
  const approvalPath = join(legacyRoot, "approval.md");
  if (!await exists(approvalPath)) return { root, state, tickets: [], intentPath: "", mirrors: [], archivePaths: [], plan };
  plan.applicable = true;
  if (!await exists(join(legacyRoot, "tickets", "001", "acceptance.md"))) {
    plan.errors.push("unsupported bootstrap layout: Ticket 001 acceptance evidence is missing; legacy evidence was retained");
    return { root, state, tickets: [], intentPath: "", mirrors: [], archivePaths: [], plan };
  }
  const tickets: ParsedTicket[] = [];
  let activeTicket: TicketRecord | undefined;
  let intentPath = "";
  const mirrors: string[] = [];
  const archivePaths = [
    { source: legacyRoot, destination: join(root, ".pi-swarm", "archive", "bootstrap-001", "goals-001") },
    { source: reconciliation, destination: join(root, ".pi-swarm", "archive", "bootstrap-001", "reconciliation") },
  ];
  try {
    await rejectSymlinks(root, legacyRoot, "legacy Goal 001 evidence");
    await rejectSymlinks(root, reconciliation, "historical reconciliation evidence");
    const approval = await readFile(approvalPath, "utf8");
    if (!/^Status:\s*Approved\s*$/im.test(approval)) throw new Error("legacy goal approval is not Approved");
    const goalPath = requireField(approval, "Goal", rel(root, approvalPath));
    const approvedBlob = requireField(approval, "Approved goal blob", rel(root, approvalPath));
    const approvalRevision = requireField(approval, "Repository revision at approval", rel(root, approvalPath));
    const statement = requireField(approval, "Operator statement", rel(root, approvalPath));
    if (goalPath !== active.record.goalPath || approvedBlob !== active.record.approvedBlob || statement !== active.record.approvalStatement) throw new Error("legacy approval conflicts with generated active goal identity");
    const blob = await git(root, ["rev-parse", "--verify", `${approvalRevision}:${goalPath}`]);
    if (blob.code || blob.stdout !== approvedBlob) throw new Error("legacy approved blob is not present at its recorded revision");

    const reconciliationRecord = await readJson(join(reconciliation, "historical-stops.v1.json"), "historical stop reconciliation") as Record<string, unknown>;
    if (reconciliationRecord.schemaVersion !== 1 || !Array.isArray(reconciliationRecord.agents)) throw new Error("historical stop reconciliation is invalid");
    const reconciled = new Map((reconciliationRecord.agents as Array<Record<string, unknown>>).map((item) => [item.slug, item.ticketAcceptance]));

    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      const number = String(ordinal).padStart(3, "0");
      const acceptancePath = join(legacyRoot, "tickets", number, "acceptance.md");
      const acceptance = await readFile(acceptancePath, "utf8");
      if (!/^Status:\s*Accepted\s*$/im.test(acceptance)) throw new Error(`${rel(root, acceptancePath)} is not Accepted`);
      const base = requireField(acceptance, "Base revision", rel(root, acceptancePath));
      const head = requireField(acceptance, "Accepted revision", rel(root, acceptancePath));
      const acceptedAt = requireField(acceptance, "Accepted at", rel(root, acceptancePath));
      const workerSlug = requireField(acceptance, "Worker", rel(root, acceptancePath));
      await verifyCommit(root, base, head);
      let ticket: TicketRecord;
      let snapshot: Buffer;
      if (ordinal <= 3) {
        const sourcePath = requireField(acceptance, "Ticket", rel(root, acceptancePath));
        const source = projectPath(root, sourcePath, "legacy ticket snapshot");
        snapshot = await readFile(source);
        if (ordinal === 1) {
          const expectedBlob = requireField(acceptance, "Ticket blob", rel(root, acceptancePath));
          const child = Bun.spawn(["git", "hash-object", "--stdin"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          child.stdin.write(snapshot); child.stdin.end();
          const [blobText, blobCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          if (blobCode || blobText.trim() !== expectedBlob) throw new Error("Ticket 001 blob does not match its acceptance record");
        } else {
          const digest = requireField(acceptance, "Ticket digest (SHA-256)", rel(root, acceptancePath));
          if (sha256(snapshot) !== digest) throw new Error(`Ticket ${number} digest does not match its acceptance record`);
        }
        const digest = sha256(snapshot);
        const ticketId = migratedTicketId(state.goalId, base, digest);
        ticket = validateTicketRecord({
          schemaVersion: 1, ticketId, goalId: state.goalId, status: "ready", baseRevision: base,
          snapshotPath: `.pi-swarm/goals/${state.goalId}/tickets/${ticketId}/ticket.md`, snapshotSha256: digest, snapshotBytes: snapshot.byteLength,
          sourcePath, workerPath: `.pi-swarm/output/workflow/${state.goalId}/tickets/${ticketId}/ticket.md`, issuedAt: null, provenanceMigrated: true,
        }, { root, goalId: state.goalId, goalDirectory: join(root, ".pi-swarm", "goals", state.goalId), baseRevision: base });
      } else {
        const durableId = requireField(acceptance, "Durable ticket ID", rel(root, acceptancePath));
        ({ ticket, snapshot } = await readGeneratedTicket(root, state, durableId));
        if (ticket.baseRevision !== base) throw new Error(`Ticket ${number} generated base conflicts with acceptance`);
      }
      const publicationEvidence = await publication(root, workerSlug, base, head);
      const agentPath = join(root, ".pi-swarm", "agents", `${workerSlug}.json`);
      await rejectSymlinks(root, agentPath, "historical agent evidence");
      const agent = normalizeAgentState(await readJson(agentPath, "historical bootstrap agent"), workerSlug).state;
      if (!agent.finishedAt || agent.lifecycle !== "stopped" || agent.outcome !== "stopped" || agent.terminationKind !== "requested") throw new Error(`historical agent ${workerSlug} is not a terminal requested stop`);
      let run: RunRecord | undefined;
      const runId = markdownField(acceptance, "Run ID");
      if (ordinal <= 4) {
        if (runId) throw new Error(`Ticket ${number} unexpectedly claims a durable run`);
        if (reconciled.get(workerSlug) !== `.pi-swarm/goals/001/tickets/${number}/acceptance.md`) throw new Error(`historical reconciliation does not authorize ${workerSlug}`);
      } else {
        if (!runId || agent.runId !== runId || agent.goalId !== state.goalId || agent.ticketId !== ticket.ticketId || agent.baseRevision !== base) throw new Error("Ticket 005 agent correlation conflicts with acceptance");
        const ticketDirectory = join(root, ".pi-swarm", "goals", state.goalId, "tickets", ticket.ticketId);
        const pointer = validateActiveRunPointer(await readJson(join(ticketDirectory, "active-run.json"), "Ticket 005 run pointer"), { goalId: state.goalId, ticketId: ticket.ticketId });
        run = validateRunRecord(await readJson(projectPath(root, pointer.recordPath, "Ticket 005 run record"), "Ticket 005 run record"), { goalId: state.goalId, ticketId: ticket.ticketId, baseRevision: base, runId });
        if (run.status !== "stopped" || run.worker.slug !== workerSlug) throw new Error("Ticket 005 run is not the matching terminal stopped run");
      }
      const review = /^hunk$/i.test(markdownField(acceptance, "Review surface") ?? "") ? "hunk" : "planner";
      const statementValue = markdownField(acceptance, "Operator statement") ?? markdownField(acceptance, "Decision");
      const result = validateTicketResult({
        schemaVersion: 1, ticketId: ticket.ticketId, goalId: state.goalId, baseRevision: base, acceptedRevision: head, outcome: "accepted", review,
        ...(statementValue ? { statement: statementValue } : {}), acceptedAt, worker: { name: agent.name, slug: agent.slug }, ...(runId ? { runId } : {}),
        publication: publicationEvidence, provenanceMigrated: true,
      }, { goalId: state.goalId, ticketId: ticket.ticketId, baseRevision: base });
      tickets.push({ ordinal, ticket, snapshot, result, agentPath, agent, ...(run ? { run } : {}) });
    }
    for (let index = 1; index < tickets.length; index++) if (tickets[index].ticket.baseRevision !== tickets[index - 1].result.acceptedRevision) throw new Error("bootstrap ticket acceptance chain is discontinuous");
    if (tickets.at(-1)!.result.acceptedRevision !== state.acceptedCodeRevision) throw new Error("Ticket 005 accepted revision does not equal current workflow accepted revision");

    if (state.activeTicketId) {
      activeTicket = (await readGeneratedTicket(root, state, state.activeTicketId)).ticket;
      if (activeTicket.baseRevision !== state.acceptedCodeRevision) throw new Error("current active ticket does not retain the accepted Ticket 005 base");
    }
    const known = new Set([...tickets.map((item) => item.ticket.ticketId), ...(activeTicket ? [activeTicket.ticketId] : [])]);
    const unknown = state.ticketOrder.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`workflow contains unknown tickets: ${unknown.join(", ")}`);

    const bootstrapRecords = await findFiles(join(root, ".pi-swarm"), "acceptance.bootstrap.json");
    if (bootstrapRecords.length !== 1) throw new Error("expected exactly one generated acceptance.bootstrap.json for Ticket 005");
    archivePaths.push({ source: bootstrapRecords[0], destination: join(root, ".pi-swarm", "archive", "bootstrap-001", "ticket-005-acceptance.bootstrap.json") });
    const bootstrap = await readJson(bootstrapRecords[0], "Ticket 005 bootstrap acceptance") as Record<string, unknown>;
    const fifth = tickets[4];
    for (const [field, expected] of [["ticketId", fifth.ticket.ticketId], ["goalId", state.goalId], ["runId", fifth.result.runId], ["baseRevision", fifth.ticket.baseRevision], ["acceptedRevision", fifth.result.acceptedRevision], ["acceptedAt", fifth.result.acceptedAt], ["worker", fifth.agent.slug]] as const) {
      if (bootstrap[field] !== expected) throw new Error(`Ticket 005 bootstrap acceptance has conflicting ${field}`);
    }

    intentPath = join(root, ".pi-swarm", "agents", "stop-intents", `${fifth.agent.slug}.v1.json`);
    await rejectSymlinks(root, intentPath, "Ticket 005 stale stop intent");
    const intent = validateAgentStopIntent(await readJson(intentPath, "Ticket 005 stale stop intent"), fifth.agent.slug);
    if (intent.startedAt !== fifth.agent.startedAt || intent.pid !== fifth.agent.pid || intent.container !== fifth.agent.container || intent.runId !== fifth.agent.runId || intent.stopRequestedAt !== fifth.agent.stopRequestedAt || intent.stopRequester !== fifth.agent.stopRequester || intent.stopReason !== fifth.agent.stopReason) throw new Error("Ticket 005 stale stop intent does not match terminal requested-stop outcome");

    for (const number of ["002", "003"]) {
      const mirror = join(root, ".pi-swarm", "output", "tickets", `${number}.md`);
      const authoritative = join(legacyRoot, "tickets", number, "ticket.md");
      if (!await exists(mirror) || !(await readFile(mirror)).equals(await readFile(authoritative))) throw new Error(`legacy mirror ${rel(root, mirror)} is missing or differs from authoritative snapshot`);
      mirrors.push(mirror);
    }
    const drafts = join(root, ".pi-swarm", "drafts");
    if (await exists(drafts)) for (const entry of (await readdir(drafts, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue;
      const path = join(drafts, entry.name);
      const bytes = await readFile(path);
      if (tickets.some((item) => item.snapshot.equals(bytes))) mirrors.push(path);
    }

    const finalOrder = [...tickets.map((item) => item.ticket.ticketId), ...state.ticketOrder.filter((id) => !tickets.some((item) => item.ticket.ticketId === id))];
    for (const item of tickets) {
      const resultPath = ticketResultPath(root, state.goalId, item.ticket.ticketId);
      plan.actions.push({ action: "import", source: item.ticket.sourcePath, destination: item.ticket.snapshotPath, sha256: item.ticket.snapshotSha256 });
      plan.actions.push({ action: "import", source: rel(root, join(legacyRoot, "tickets", String(item.ordinal).padStart(3, "0"), "acceptance.md")), destination: rel(root, resultPath), sha256: sha256(await readFile(join(legacyRoot, "tickets", String(item.ordinal).padStart(3, "0"), "acceptance.md"))) });
      plan.actions.push({ action: "correlate", source: rel(root, item.agentPath), destination: rel(root, item.agentPath), sha256: sha256(await readFile(item.agentPath)), reason: item.run ? `authoritative run ${item.run.runId}` : "authoritative historical ticket/base identity; no durable run existed" });
      const publicationManifestPath = projectPath(root, item.result.publication!.manifestPath, "result publication manifest");
      const publicationBundlePath = projectPath(root, item.result.publication!.bundlePath, "result publication bundle");
      plan.actions.push({ action: "retain", source: rel(root, publicationManifestPath), destination: rel(root, publicationManifestPath), sha256: sha256(await readFile(publicationManifestPath)), reason: "validated publication manifest" });
      plan.actions.push({ action: "retain", source: rel(root, publicationBundlePath), destination: rel(root, publicationBundlePath), sha256: sha256(await readFile(publicationBundlePath)), reason: "validated immutable publication bundle" });
      if (item.ordinal >= 4) {
        const generatedRecord = join(root, ".pi-swarm", "goals", state.goalId, "tickets", item.ticket.ticketId, "record.v1.json");
        plan.actions.push({ action: "retain", source: rel(root, generatedRecord), destination: rel(root, generatedRecord), sha256: sha256(await readFile(generatedRecord)), reason: "validated generated ticket issuance record" });
      }
      if (item.run) {
        const runRecord = join(root, ".pi-swarm", "goals", state.goalId, "tickets", item.ticket.ticketId, "runs", item.run.runId, "record.v1.json");
        plan.actions.push({ action: "retain", source: rel(root, runRecord), destination: rel(root, runRecord), sha256: sha256(await readFile(runRecord)), reason: "validated Ticket 005 durable run" });
      }
    }
    if (activeTicket) plan.actions.push({ action: "retain", source: activeTicket.snapshotPath, destination: activeTicket.snapshotPath, sha256: activeTicket.snapshotSha256, reason: `current active ticket on accepted base ${state.acceptedCodeRevision}` });
    plan.actions.push({ action: "remove", source: rel(root, intentPath), sha256: sha256(await readFile(intentPath)), reason: "validated matching terminal Ticket 005 stop intent" });
    for (const mirror of mirrors.sort()) plan.actions.push({ action: "remove", source: rel(root, mirror), sha256: sha256(await readFile(mirror)), reason: "byte-equivalent legacy mirror or source draft" });
    for (const archive of archivePaths) {
      if (!await exists(archive.source)) throw new Error(`archive source is missing: ${rel(root, archive.source)}`);
      if (await exists(archive.destination)) throw new Error(`archive destination already exists: ${rel(root, archive.destination)}`);
      plan.actions.push({ action: "archive", source: rel(root, archive.source), destination: rel(root, archive.destination), sha256: await treeDigest(root, archive.source) });
    }
    plan.actions.push({ action: "receipt", destination: rel(root, receipt), reason: `issuance order ${finalOrder.join(",")}` });
  } catch (error) { plan.errors.push(error instanceof Error ? error.message : String(error)); }
  return { root, state, tickets, activeTicket, intentPath, mirrors, archivePaths, plan };
}

export async function migrateSupportedBootstrap(options: { cwd?: string; apply?: boolean; now?: Date }): Promise<BootstrapPlan> {
  let prepared = await prepare(options.cwd ?? process.cwd());
  if (!options.apply || prepared.plan.applied) return prepared.plan;
  if (!prepared.plan.applicable || prepared.plan.errors.length) throw new Error(`bootstrap migration refused: ${prepared.plan.errors.join("; ") || "layout is not applicable"}`);
  const lockPath = join(prepared.root, ".pi-swarm", "goals", prepared.state.goalId, "workflow.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another workflow transition is in progress"); throw error; }
  const created: string[] = [];
  const backups = new Map<string, Buffer>();
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    prepared = await prepare(prepared.root);
    if (prepared.plan.errors.length) throw new Error(`bootstrap migration refused: ${prepared.plan.errors.join("; ")}`);
    const root = prepared.root;
    const statePath = workflowStatePath(root, prepared.state.goalId);
    const stateExisted = await exists(statePath);
    if (!stateExisted) { await durableWrite(statePath, `${JSON.stringify(prepared.state, null, 2)}\n`); created.push(statePath); }
    const state = validateWorkflowState(await readJson(statePath, "workflow state"), prepared.state.goalId);
    if (state.activeTicketId !== prepared.state.activeTicketId || state.acceptedCodeRevision !== prepared.state.acceptedCodeRevision || state.stateRevision !== prepared.state.stateRevision) throw new Error("workflow changed after migration planning; retry");

    // Validate every immutable destination before the first write.
    for (const item of prepared.tickets) {
      const directory = join(root, ".pi-swarm", "goals", state.goalId, "tickets", item.ticket.ticketId);
      const workerDirectory = join(root, ".pi-swarm", "output", "workflow", state.goalId, "tickets", item.ticket.ticketId);
      const destinations: Array<[string, Buffer]> = [[join(directory, "ticket.md"), item.snapshot], [join(workerDirectory, "ticket.md"), item.snapshot], [ticketResultPath(root, state.goalId, item.ticket.ticketId), Buffer.from(`${JSON.stringify(item.result, null, 2)}\n`)]];
      if (item.ordinal <= 3) destinations.push([join(directory, "record.v1.json"), Buffer.from(`${JSON.stringify(item.ticket, null, 2)}\n`)]);
      for (const [path, bytes] of destinations) {
        await rejectSymlinks(root, path, "bootstrap migration destination");
        if (await exists(path) && !(await readFile(path)).equals(bytes)) throw new Error(`migration destination conflicts: ${rel(root, path)}`);
      }
    }

    for (const item of prepared.tickets) {
      const directory = join(root, ".pi-swarm", "goals", state.goalId, "tickets", item.ticket.ticketId);
      const workerDirectory = join(root, ".pi-swarm", "output", "workflow", state.goalId, "tickets", item.ticket.ticketId);
      await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
      const destinations: Array<[string, Buffer]> = [[join(directory, "ticket.md"), item.snapshot], [join(workerDirectory, "ticket.md"), item.snapshot], [ticketResultPath(root, state.goalId, item.ticket.ticketId), Buffer.from(`${JSON.stringify(item.result, null, 2)}\n`)]];
      if (item.ordinal <= 3) destinations.push([join(directory, "record.v1.json"), Buffer.from(`${JSON.stringify(item.ticket, null, 2)}\n`)]);
      for (const [path, bytes] of destinations) if (!await exists(path)) { await durableWrite(path, bytes); created.push(path); }
      const correlated: AgentState = { ...item.agent, goalId: state.goalId, ticketId: item.ticket.ticketId, baseRevision: item.ticket.baseRevision, ...(item.run ? { runId: item.run.runId } : {}) };
      if (!item.run) delete correlated.runId;
      normalizeAgentState(correlated, correlated.slug);
      backups.set(item.agentPath, await readFile(item.agentPath));
      await atomicWrite(item.agentPath, `${JSON.stringify(correlated, null, 2)}\n`);
    }
    const order = [...prepared.tickets.map((item) => item.ticket.ticketId), ...state.ticketOrder.filter((id) => !prepared.tickets.some((item) => item.ticket.ticketId === id))];
    const transitioned = validateWorkflowState({ ...state, ticketOrder: order, stateRevision: state.stateRevision + 1, lastTransitionAt: (options.now ?? new Date()).toISOString() }, state.goalId);
    if (stateExisted) backups.set(statePath, await readFile(statePath));
    await atomicWrite(statePath, `${JSON.stringify(transitioned, null, 2)}\n`);

    for (const path of [prepared.intentPath, ...prepared.mirrors]) { backups.set(path, await readFile(path)); await rm(path); }
    const archiveRoot = join(root, ".pi-swarm", "archive", "bootstrap-001"); await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    for (const archive of prepared.archivePaths) { await rename(archive.source, archive.destination); moved.push(archive); }
    const receiptPath = join(archiveRoot, "migration-receipt.v1.json");
    const receipt = { schemaVersion: 1, migration: "bootstrap-001", goalId: state.goalId, appliedAt: (options.now ?? new Date()).toISOString(), actions: prepared.plan.actions };
    await durableWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); created.push(receiptPath);
    return { ...prepared.plan, applied: true };
  } catch (error) {
    for (const move of moved.reverse()) { try { if (await exists(move.destination) && !await exists(move.source)) await rename(move.destination, move.source); } catch {} }
    for (const [path, bytes] of [...backups.entries()].reverse()) { try { await mkdir(join(path, ".."), { recursive: true }); await atomicWrite(path, bytes.toString("utf8")); } catch {} }
    for (const path of created.reverse()) { try { await rm(path, { force: true }); } catch {} }
    throw error;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
