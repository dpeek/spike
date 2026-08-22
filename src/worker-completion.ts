import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { acceptanceCriteria } from "./acceptance.ts";
import { loadApplicationTicketDocument, type ApplicationTicket } from "./application-ticket.ts";
import { applicationReviewTicketSchema, type ApplicationReviewTicket } from "./application-review.ts";
import { installImmutable, readDocument, serializeDocument } from "./durable-state.ts";
import { loadTicketDocument, type Ticket } from "./ticket.ts";

const artifactPathSchema = z.string().refine(
  (value) =>
    value.startsWith("artifacts/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((component) => component !== "" && component !== "." && component !== ".."),
  "artifact path must be a canonical relative path below artifacts/",
);
const nonBlankString = z.string().trim().min(1);
const artifactsSchema = z.array(artifactPathSchema).default([]);
const blockedPayloadSchema = z
  .object({
    reason: nonBlankString,
    evidence: nonBlankString,
    artifacts: artifactsSchema,
  })
  .strict();
const implementationPayloadSchema = z
  .object({
    summary: nonBlankString,
    verification: nonBlankString,
    assumptions: nonBlankString,
    limitations: nonBlankString,
    risks: nonBlankString,
    followUp: nonBlankString,
    artifacts: artifactsSchema,
  })
  .strict();
const findingSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    severity: z.enum(["critical", "high", "medium", "low"]),
    statement: nonBlankString,
  })
  .strict();
const acceptanceAssessmentSchema = z
  .object({
    criterion: nonBlankString,
    assessment: z.enum(["met", "not-met", "unclear"]),
    evidence: nonBlankString,
  })
  .strict();
const reviewPayloadSchema = z
  .object({
    reviewStatement: nonBlankString,
    findings: z.array(findingSchema),
    acceptanceAssessment: z.array(acceptanceAssessmentSchema).min(1),
    verdict: z.enum(["remediate", "approve", "reject", "ask-operator"]),
    artifacts: artifactsSchema,
  })
  .strict();

const maximumPayloadBytes = 128 * 1024;
const maximumBundleBytes = 100 * 1024 * 1024;
const maximumArtifactBytes = 16 * 1024 * 1024;
const maximumArtifactsBytes = 64 * 1024 * 1024;

type Artifact = { path: string; sha256: string };
type GitResult = { exitCode: number; stdout: string; stderr: string };

export type WorkerCompletion = {
  goalId: string;
  /** Change Tickets use changeId; Application Tickets use applicationId. */
  changeId?: string;
  applicationId?: string;
  ticketId: string;
  role: "implement" | "review";
  outcome: "completed";
  workerRevision?: string;
  reviewedRevision?: string;
  artifacts: Artifact[];
};

export type WorkerBlocked = {
  goalId: string;
  changeId?: string;
  applicationId?: string;
  ticketId: string;
  role: "implement" | "review";
  outcome: "blocked";
  artifacts: Artifact[];
};

export type WorkerProtocolContext = {
  inputDirectory: string;
  outputDirectory: string;
  goalId: string | undefined;
  changeId: string | undefined;
  applicationId: string | undefined;
  ticketId: string | undefined;
  role: string | undefined;
  inputRevision: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
  inheritedEnvironment: NodeJS.ProcessEnv;
};

export function parseWorkerProtocolContext(environment: NodeJS.ProcessEnv): WorkerProtocolContext {
  const directory = (name: "SPIKE_INPUT_DIR" | "SPIKE_OUTPUT_DIR"): string => {
    const value = environment[name];
    if (value === undefined || !value.trim()) throw new Error(`${name} is required`);
    return resolve(value);
  };
  return {
    inputDirectory: directory("SPIKE_INPUT_DIR"),
    outputDirectory: directory("SPIKE_OUTPUT_DIR"),
    goalId: environment["SPIKE_GOAL_ID"],
    changeId: environment["SPIKE_CHANGE_ID"],
    applicationId: environment["SPIKE_APPLICATION_ID"],
    ticketId: environment["SPIKE_TICKET_ID"],
    role: environment["SPIKE_TICKET_ROLE"],
    inputRevision: environment["SPIKE_INPUT_REVISION"],
    model: environment["SPIKE_ACTUAL_MODEL"] ?? environment["SPIKE_MODEL"],
    thinking: environment["SPIKE_ACTUAL_THINKING"] ?? environment["SPIKE_THINKING"],
    inheritedEnvironment: { ...environment },
  };
}

function safeGitEnvironment(inherited: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !name.startsWith("GIT_")) environment[name] = value;
  }
  return { ...environment, ...extra };
}

async function executeGit(cwd: string, args: string[], protocol: WorkerProtocolContext, extraEnvironment?: Record<string, string>): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: safeGitEnvironment(protocol.inheritedEnvironment, extraEnvironment),
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

async function git(cwd: string, args: string[], protocol: WorkerProtocolContext, extraEnvironment?: Record<string, string>): Promise<string> {
  const result = await executeGit(cwd, args, protocol, extraEnvironment);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git exited with code ${result.exitCode}`);
  return result.stdout;
}

async function regularDirectory(path: string, label: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  return realpath(path);
}

async function regularFile(path: string, label: string, maximumBytes: number): Promise<number> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maximumBytes) throw new Error(`${label} exceeds its size limit`);
  return stat.size;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertProtocolMatchesTicket(ticket: Ticket, protocol: WorkerProtocolContext): void {
  const expected: Array<[string, string | undefined, string]> = [
    ["SPIKE_GOAL_ID", protocol.goalId, ticket.metadata.goalId],
    ["SPIKE_CHANGE_ID", protocol.changeId, ticket.metadata.changeId],
    ["SPIKE_TICKET_ID", protocol.ticketId, ticket.metadata.ticketId],
    ["SPIKE_TICKET_ROLE", protocol.role, ticket.metadata.role],
    ["SPIKE_INPUT_REVISION", protocol.inputRevision, ticket.metadata.inputRevision],
  ];
  for (const [name, declared, value] of expected) {
    if (declared !== undefined && declared !== value) throw new Error(`${name} does not match SPIKE_INPUT_DIR/ticket.md`);
  }

  const actualModel = protocol.model;
  const actualThinking = protocol.thinking;
  if (!actualModel || !actualThinking) {
    throw new Error("worker completion requires observed model and thinking provenance");
  }
  if (actualModel !== ticket.metadata.model || actualThinking !== ticket.metadata.thinking) {
    throw new Error(
      `actual worker selection ${actualModel}/${actualThinking} does not match Ticket assignment ${ticket.metadata.model}/${ticket.metadata.thinking}`,
    );
  }
}

function validateReviewSemantics(
  payload: z.infer<typeof reviewPayloadSchema>,
  expectedCriteria: string[],
): void {
  const findingIds = payload.findings.map((finding) => finding.id);
  if (new Set(findingIds).size !== findingIds.length) throw new Error("review finding IDs must be unique");
  if (payload.verdict === "remediate" && payload.findings.length === 0) {
    throw new Error("remediate review completion must contain at least one finding");
  }

  const submittedCriteria = payload.acceptanceAssessment.map((assessment) => assessment.criterion);
  if (new Set(submittedCriteria).size !== submittedCriteria.length) {
    throw new Error("review completion assesses an acceptance criterion more than once");
  }
  if (
    submittedCriteria.length !== expectedCriteria.length ||
    expectedCriteria.some((criterion) => !submittedCriteria.includes(criterion))
  ) {
    throw new Error("review completion must assess every Change acceptance criterion exactly once");
  }
  if (
    payload.verdict === "approve" &&
    payload.acceptanceAssessment.some((assessment) => assessment.assessment !== "met")
  ) {
    throw new Error("approve review completion must assess every acceptance criterion as met");
  }
}

function allowedOutputPaths(artifactPaths: string[]): { files: Set<string>; directories: Set<string> } {
  const files = new Set(artifactPaths);
  const directories = new Set<string>();
  for (const path of artifactPaths) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index++) {
      directories.add(components.slice(0, index).join("/"));
    }
  }
  return { files, directories };
}

async function validateOutputAndDigestArtifacts(outputDirectory: string, artifactPaths: string[]): Promise<Artifact[]> {
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("worker completion declares an artifact path more than once");
  }
  if (await pathExists(join(outputDirectory, "submission.md"))) {
    throw new Error("worker completion was already published");
  }

  const allowed = allowedOutputPaths(artifactPaths);
  async function visit(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory ? join(outputDirectory, ...relativeDirectory.split("/")) : outputDirectory;
    for (const entry of await readdir(directory)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Ticket output must not contain symbolic links: ${relativePath}`);
      if (stat.isDirectory()) {
        if (!allowed.directories.has(relativePath)) throw new Error(`unexpected Ticket output path: ${relativePath}`);
        await visit(relativePath);
      } else if (stat.isFile()) {
        if (!allowed.files.has(relativePath)) throw new Error(`unexpected Ticket output path: ${relativePath}`);
      } else {
        throw new Error(`Ticket output must contain only regular files: ${relativePath}`);
      }
    }
  }
  await visit("");

  let totalBytes = 0;
  const artifacts: Artifact[] = [];
  for (const path of [...artifactPaths].sort()) {
    const absolutePath = join(outputDirectory, ...path.split("/"));
    const bytes = await regularFile(absolutePath, `artifact ${path}`, maximumArtifactBytes);
    totalBytes += bytes;
    if (totalBytes > maximumArtifactsBytes) throw new Error("declared artifacts exceed their total size limit");
    const sha256 = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
    artifacts.push({ path, sha256 });
  }
  return artifacts;
}

async function repositoryRoot(cwd: string, protocol: WorkerProtocolContext): Promise<string> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"], protocol);
  return realpath(root);
}

async function assertInputRevision(repository: string, ticket: Ticket, protocol: WorkerProtocolContext): Promise<string> {
  const exactInput = await git(repository, ["rev-parse", "--verify", `${ticket.metadata.inputRevision}^{commit}`], protocol);
  if (exactInput !== ticket.metadata.inputRevision) throw new Error("Ticket input revision does not identify a commit exactly");
  const head = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], protocol);
  if (ticket.metadata.role === "review") {
    if (head !== ticket.metadata.inputRevision) {
      throw new Error(`review checkout is at ${head}, expected Ticket revision ${ticket.metadata.inputRevision}`);
    }
    const status = await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], protocol);
    if (status) throw new Error("review checkout must remain at the exact clean Ticket revision");
  }
  return head;
}

async function snapshotImplementation(repository: string, parentRevision: string, protocol: WorkerProtocolContext): Promise<string> {
  await git(repository, ["add", "-A"], protocol);
  const tree = await git(repository, ["write-tree"], protocol);
  return git(
    repository,
    ["commit-tree", tree, "-p", parentRevision, "-m", "Spike worker completion snapshot"],
    protocol,
    {
      GIT_AUTHOR_NAME: "Spike Worker",
      GIT_AUTHOR_EMAIL: "worker@spike.local",
      GIT_COMMITTER_NAME: "Spike Worker",
      GIT_COMMITTER_EMAIL: "worker@spike.local",
    },
  );
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function createOutputBundle(
  repository: string,
  outputDirectory: string,
  workerRevision: string,
  ticket: Ticket,
  protocol: WorkerProtocolContext,
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const stagingRef = `refs/spike/completion/${ticket.metadata.goalId}/${ticket.metadata.changeId}/${ticket.metadata.ticketId}/${suffix}`;
  const temporaryPath = join(outputDirectory, `.repository.${suffix}.bundle.tmp`);
  const bundlePath = join(outputDirectory, "repository.bundle");
  try {
    await git(repository, ["update-ref", stagingRef, workerRevision, "0".repeat(workerRevision.length)], protocol);
    await git(repository, ["bundle", "create", temporaryPath, stagingRef], protocol);
    await regularFile(temporaryPath, "output repository bundle", maximumBundleBytes);
    await syncFile(temporaryPath);
    try {
      await link(temporaryPath, bundlePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("worker completion output already contains repository.bundle");
      }
      throw error;
    }
    await rm(temporaryPath);
  } finally {
    await git(repository, ["update-ref", "-d", stagingRef], protocol).catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

function implementationBody(payload: z.infer<typeof implementationPayloadSchema>): string {
  return `# Implementation evidence

## Summary

${payload.summary}

## Verification

${payload.verification}

## Assumptions

${payload.assumptions}

## Limitations

${payload.limitations}

## Risks

${payload.risks}

## Follow-up

${payload.followUp}
`;
}

function reviewBody(payload: z.infer<typeof reviewPayloadSchema>): string {
  return `# Review evidence

## Review statement

${payload.reviewStatement}
`;
}

function blockedBody(payload: z.infer<typeof blockedPayloadSchema>): string {
  return `# Blocked evidence

## Reason

${payload.reason}

## Evidence

${payload.evidence}
`;
}

function parsePayload(source: string): unknown {
  if (Buffer.byteLength(source) > maximumPayloadBytes) throw new Error("worker completion payload exceeds its size limit");
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("worker completion payload is invalid JSON");
  }
}

function assertApplicationProtocol(ticket: ApplicationTicket, protocol: WorkerProtocolContext): void {
  const expected: Array<[string, string | undefined, string]> = [["SPIKE_GOAL_ID", protocol.goalId, ticket.metadata.goalId], ["SPIKE_APPLICATION_ID", protocol.applicationId, ticket.metadata.applicationId], ["SPIKE_TICKET_ID", protocol.ticketId, ticket.metadata.ticketId], ["SPIKE_TICKET_ROLE", protocol.role, "implement"], ["SPIKE_INPUT_REVISION", protocol.inputRevision, ticket.metadata.inputRevision]];
  for (const [name, declared, value] of expected) if (declared !== undefined && declared !== value) throw new Error(`${name} does not match SPIKE_INPUT_DIR/ticket.md`);
  if (!protocol.model || !protocol.thinking) throw new Error("worker completion requires observed model and thinking provenance");
  if (protocol.model !== ticket.metadata.model || protocol.thinking !== ticket.metadata.thinking) throw new Error("actual worker selection does not match Application Ticket assignment");
}

async function createApplicationOutputBundle(repository: string, outputDirectory: string, workerRevision: string, ticket: ApplicationTicket, protocol: WorkerProtocolContext): Promise<void> {
  const suffix = randomUUID().replaceAll("-", ""); const ref = `refs/spike/application-completion/${ticket.metadata.goalId}/${ticket.metadata.applicationId}/${ticket.metadata.ticketId}/${suffix}`;
  const temporary = join(outputDirectory, `.repository.${suffix}.bundle.tmp`), bundle = join(outputDirectory, "repository.bundle");
  try {
    await git(repository, ["update-ref", ref, workerRevision, "0".repeat(workerRevision.length)], protocol); await git(repository, ["bundle", "create", temporary, ref], protocol);
    await regularFile(temporary, "Application output repository bundle", maximumBundleBytes); await syncFile(temporary);
    await link(temporary, bundle); await rm(temporary);
  } finally { await git(repository, ["update-ref", "-d", ref], protocol).catch(() => undefined); await rm(temporary, { force: true }); }
}

async function completeApplicationReviewWorker(cwd: string, inputDirectory: string, outputDirectory: string, payloadSource: string, protocol: WorkerProtocolContext): Promise<WorkerCompletion> {
  const raw = await readDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  const metadata = applicationReviewTicketSchema.parse(raw.metadata);
  const ticket: ApplicationReviewTicket = { metadata, body: raw.body };
  const expected: Array<[string, string | undefined, string]> = [["SPIKE_GOAL_ID", protocol.goalId, metadata.goalId], ["SPIKE_APPLICATION_ID", protocol.applicationId, metadata.applicationId], ["SPIKE_TICKET_ID", protocol.ticketId, metadata.ticketId], ["SPIKE_TICKET_ROLE", protocol.role, "review"], ["SPIKE_INPUT_REVISION", protocol.inputRevision, metadata.candidateRevision]];
  for (const [name, declared, value] of expected) if (declared !== undefined && declared !== value) throw new Error(`${name} does not match SPIKE_INPUT_DIR/ticket.md`);
  if (!protocol.model || !protocol.thinking || protocol.model !== metadata.model || protocol.thinking !== metadata.thinking) throw new Error("actual worker selection does not match Application review Ticket assignment");
  const payload = reviewPayloadSchema.parse(parsePayload(payloadSource));
  const ids = payload.findings.map(item => item.id); if (new Set(ids).size !== ids.length) throw new Error("review finding IDs must be unique");
  if (payload.verdict === "remediate" && payload.findings.length === 0) throw new Error("remediate review completion must contain at least one finding");
  const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
  const repository = await repositoryRoot(cwd, protocol), head = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], protocol);
  if (head !== ticket.metadata.candidateRevision) throw new Error(`review checkout is at ${head}, expected Candidate ${ticket.metadata.candidateRevision}`);
  if (await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], protocol)) throw new Error("Application review checkout must remain at the exact clean Candidate");
  const submission = { kind: "application-review-submission", goalId: metadata.goalId, applicationId: metadata.applicationId, ticketId: metadata.ticketId, outcome: "completed", reviewedRevision: metadata.candidateRevision, producingImplementationTicketId: metadata.producingImplementationTicketId, verdict: payload.verdict, findings: payload.findings, acceptanceAssessment: payload.acceptanceAssessment, artifacts } as const;
  await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument(submission, reviewBody(payload)));
  return { goalId: metadata.goalId, applicationId: metadata.applicationId, ticketId: metadata.ticketId, role: "review", outcome: "completed", reviewedRevision: metadata.candidateRevision, artifacts };
}

async function completeApplicationWorker(cwd: string, inputDirectory: string, outputDirectory: string, payloadSource: string, protocol: WorkerProtocolContext): Promise<WorkerCompletion> {
  const ticket = await loadApplicationTicketDocument(inputDirectory, join(inputDirectory, "ticket.md")); assertApplicationProtocol(ticket, protocol);
  const payload = implementationPayloadSchema.parse(parsePayload(payloadSource)); const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
  const repository = await repositoryRoot(cwd, protocol); const inputRevision = await git(repository, ["rev-parse", "--verify", `${ticket.metadata.inputRevision}^{commit}`], protocol);
  if (inputRevision !== ticket.metadata.inputRevision) throw new Error("Application Ticket input revision does not identify a commit exactly");
  const workerRevision = await snapshotImplementation(repository, await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], protocol), protocol);
  await createApplicationOutputBundle(repository, outputDirectory, workerRevision, ticket, protocol);
  const metadata = { kind: "application-submission", goalId: ticket.metadata.goalId, applicationId: ticket.metadata.applicationId, ticketId: ticket.metadata.ticketId, outcome: "completed", workerRevision, artifacts } as const;
  await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument(metadata, implementationBody(payload)));
  return { goalId: ticket.metadata.goalId, applicationId: ticket.metadata.applicationId, ticketId: ticket.metadata.ticketId, role: "implement", outcome: "completed", workerRevision, artifacts };
}

export async function completeWorker(cwd: string, payloadSource: string, protocol: WorkerProtocolContext): Promise<WorkerCompletion> {
  const [inputDirectory, outputDirectory] = await Promise.all([
    regularDirectory(protocol.inputDirectory, "SPIKE_INPUT_DIR"),
    regularDirectory(protocol.outputDirectory, "SPIKE_OUTPUT_DIR"),
  ]);
  const rawTicket = await readDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  if (typeof rawTicket.metadata === "object" && rawTicket.metadata !== null && (rawTicket.metadata as { kind?: unknown }).kind === "application-ticket") return completeApplicationWorker(cwd, inputDirectory, outputDirectory, payloadSource, protocol);
  if (typeof rawTicket.metadata === "object" && rawTicket.metadata !== null && (rawTicket.metadata as { kind?: unknown }).kind === "application-review-ticket") return completeApplicationReviewWorker(cwd, inputDirectory, outputDirectory, payloadSource, protocol);
  const ticket = await loadTicketDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  assertProtocolMatchesTicket(ticket, protocol);
  const payloadValue = parsePayload(payloadSource);
  const repository = await repositoryRoot(cwd, protocol);
  const head = await assertInputRevision(repository, ticket, protocol);
  const identity = {
    goalId: ticket.metadata.goalId,
    changeId: ticket.metadata.changeId,
    ticketId: ticket.metadata.ticketId,
  };

  if (ticket.metadata.role === "implement") {
    const payload = implementationPayloadSchema.parse(payloadValue);
    const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
    const workerRevision = await snapshotImplementation(repository, head, protocol);
    await createOutputBundle(repository, outputDirectory, workerRevision, ticket, protocol);
    const metadata = {
      kind: "submission",
      ...identity,
      outcome: "completed",
      workerRevision,
      artifacts,
    } as const;
    await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument(metadata, implementationBody(payload)));
    return { ...identity, role: "implement", outcome: "completed", workerRevision, artifacts };
  }

  const payload = reviewPayloadSchema.parse(payloadValue);
  validateReviewSemantics(payload, acceptanceCriteria(ticket.body));
  const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
  const metadata = {
    kind: "submission",
    ...identity,
    outcome: "completed",
    reviewedRevision: ticket.metadata.inputRevision,
    producingImplementationTicketId: ticket.metadata.producingImplementationTicketId,
    findings: payload.findings,
    acceptanceAssessment: payload.acceptanceAssessment,
    verdict: payload.verdict,
    artifacts,
  } as const;
  await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument(metadata, reviewBody(payload)));
  return { ...identity, role: "review", outcome: "completed", reviewedRevision: ticket.metadata.inputRevision, artifacts };
}

async function blockApplicationWorker(cwd: string, inputDirectory: string, outputDirectory: string, payloadSource: string, protocol: WorkerProtocolContext): Promise<WorkerBlocked> {
  const ticket = await loadApplicationTicketDocument(inputDirectory, join(inputDirectory, "ticket.md")); assertApplicationProtocol(ticket, protocol);
  const payload = blockedPayloadSchema.parse(parsePayload(payloadSource)); const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
  const repository = await repositoryRoot(cwd, protocol); if ((await git(repository, ["rev-parse", "--verify", `${ticket.metadata.inputRevision}^{commit}`], protocol)) !== ticket.metadata.inputRevision) throw new Error("Application Ticket input revision does not identify a commit exactly");
  const metadata = { kind: "application-submission", goalId: ticket.metadata.goalId, applicationId: ticket.metadata.applicationId, ticketId: ticket.metadata.ticketId, outcome: "blocked", artifacts } as const;
  await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument(metadata, blockedBody(payload)));
  return { goalId: ticket.metadata.goalId, applicationId: ticket.metadata.applicationId, ticketId: ticket.metadata.ticketId, role: "implement", outcome: "blocked", artifacts };
}

async function blockApplicationReviewWorker(_cwd: string, inputDirectory: string, outputDirectory: string, payloadSource: string, protocol: WorkerProtocolContext): Promise<WorkerBlocked> {
  const raw = await readDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  const ticket = applicationReviewTicketSchema.parse(raw.metadata);
  const expected: Array<[string, string | undefined, string]> = [["SPIKE_GOAL_ID", protocol.goalId, ticket.goalId], ["SPIKE_APPLICATION_ID", protocol.applicationId, ticket.applicationId], ["SPIKE_TICKET_ID", protocol.ticketId, ticket.ticketId], ["SPIKE_TICKET_ROLE", protocol.role, "review"]];
  for (const [name, declared, value] of expected) if (declared !== undefined && declared !== value) throw new Error(`${name} does not match SPIKE_INPUT_DIR/ticket.md`);
  if (protocol.model !== ticket.model || protocol.thinking !== ticket.thinking) throw new Error("actual worker selection does not match Application review Ticket assignment");
  const payload = blockedPayloadSchema.parse(parsePayload(payloadSource));
  const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
  await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument({ kind: "application-review-submission", goalId: ticket.goalId, applicationId: ticket.applicationId, ticketId: ticket.ticketId, outcome: "blocked", artifacts }, blockedBody(payload)));
  return { goalId: ticket.goalId, applicationId: ticket.applicationId, ticketId: ticket.ticketId, role: "review", outcome: "blocked", artifacts };
}

export async function blockWorker(cwd: string, payloadSource: string, protocol: WorkerProtocolContext): Promise<WorkerBlocked> {
  const [inputDirectory, outputDirectory] = await Promise.all([
    regularDirectory(protocol.inputDirectory, "SPIKE_INPUT_DIR"),
    regularDirectory(protocol.outputDirectory, "SPIKE_OUTPUT_DIR"),
  ]);
  const rawTicket = await readDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  if (typeof rawTicket.metadata === "object" && rawTicket.metadata !== null && (rawTicket.metadata as { kind?: unknown }).kind === "application-ticket") return blockApplicationWorker(cwd, inputDirectory, outputDirectory, payloadSource, protocol);
  if (typeof rawTicket.metadata === "object" && rawTicket.metadata !== null && (rawTicket.metadata as { kind?: unknown }).kind === "application-review-ticket") return blockApplicationReviewWorker(cwd, inputDirectory, outputDirectory, payloadSource, protocol);
  const ticket = await loadTicketDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  assertProtocolMatchesTicket(ticket, protocol);
  const payload = blockedPayloadSchema.parse(parsePayload(payloadSource));
  const repository = await repositoryRoot(cwd, protocol);
  await assertInputRevision(repository, ticket, protocol);
  const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
  const identity = {
    goalId: ticket.metadata.goalId,
    changeId: ticket.metadata.changeId,
    ticketId: ticket.metadata.ticketId,
  };
  const metadata = {
    kind: "submission",
    ...identity,
    outcome: "blocked",
    artifacts,
  } as const;
  await installImmutable(
    outputDirectory,
    join(outputDirectory, "submission.md"),
    serializeDocument(metadata, blockedBody(payload)),
  );
  return { ...identity, role: ticket.metadata.role, outcome: "blocked", artifacts };
}

export async function readWorkerPayload(cwd: string, file: string | undefined, stdin: () => Promise<string>): Promise<string> {
  if (file === undefined || file === "-") return stdin();
  const path = resolve(cwd, file);
  await regularFile(path, "worker completion payload", maximumPayloadBytes);
  return readFile(path, "utf8");
}
