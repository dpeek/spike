import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { acceptanceCriteria } from "./acceptance.ts";
import { changePath, loadChange } from "./change.ts";
import { commitCrashHooks, type CrashInjector } from "./crash.ts";
import {
  documentExists,
  installImmutable,
  listDirectoryNames,
  readDocument,
  serializeDocument,
} from "./durable-state.ts";
import { normalizeCandidate, retainCandidate, withImportedWorkerRevision } from "./git-change.ts";
import { discoverRepository } from "./git.ts";
import { goalIdPattern, sequenceIdPattern } from "./identity.ts";
import { loadTicket, reportPath, ticketPath } from "./ticket.ts";
import {
  forgetFinalizedWorker,
  loadRecordedWorkerIfPresent,
  finalizeWorker,
  selectWorkerAdapter,
  ticketOutputPath,
  type WorkerExecution,
  type WorkerRuntimeOperations,
  type TicketIdentity,
} from "./worker.ts";

const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digestPattern = /^[0-9a-f]{64}$/;
const findingIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const nonBlankString = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const artifactPath = z.string().refine(
  (value) =>
    value.startsWith("artifacts/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((component) => component !== "" && component !== "." && component !== ".."),
  "artifact path must be a canonical relative path below artifacts/",
);
const submittedArtifactSchema = z
  .object({
    path: artifactPath,
    sha256: z.string().regex(digestPattern),
  })
  .strict();
const submissionIdentitySchema = z.object({
  kind: z.literal("submission"),
  goalId: z.string().regex(goalIdPattern),
  changeId: z.string().regex(sequenceIdPattern),
  ticketId: z.string().regex(sequenceIdPattern),
  artifacts: z.array(submittedArtifactSchema),
});
const completedSubmissionSchema = submissionIdentitySchema.extend({ outcome: z.literal("completed") });
const implementationSubmissionSchema = completedSubmissionSchema
  .extend({ workerRevision: z.string().regex(revisionPattern) })
  .strict();
const reviewFindingSchema = z
  .object({
    id: z.string().regex(findingIdPattern),
    severity: z.enum(["critical", "high", "medium", "low"]),
    statement: z.string().trim().min(1),
  })
  .strict();
const acceptanceAssessmentSchema = z
  .object({
    criterion: z.string().trim().min(1),
    assessment: z.enum(["met", "not-met", "unclear"]),
    evidence: z.string().trim().min(1),
  })
  .strict();
const reviewSubmissionSchema = completedSubmissionSchema
  .extend({
    reviewedRevision: z.string().regex(revisionPattern),
    producingImplementationTicketId: z.string().regex(sequenceIdPattern),
    findings: z.array(reviewFindingSchema),
    acceptanceAssessment: z.array(acceptanceAssessmentSchema).min(1),
    verdict: z.enum(["remediate", "approve", "reject", "ask-operator"]),
  })
  .strict();
const blockedSubmissionSchema = submissionIdentitySchema
  .extend({ outcome: z.literal("blocked") })
  .strict();
const submissionSchema = z.union([implementationSubmissionSchema, reviewSubmissionSchema, blockedSubmissionSchema]);
const reportArtifactSchema = submittedArtifactSchema.extend({ bytes: z.number().int().nonnegative() }).strict();
const executionSchema = z
  .object({
    adapter: nonBlankString,
    isolation: z.enum(["workspace", "container"]),
    worker: nonBlankString,
    model: nonBlankString,
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    startedAt: timestamp,
    finishedAt: timestamp,
    environmentDigest: nonBlankString.optional(),
  })
  .strict();
const reportIdentitySchema = z.object({
  kind: z.literal("report"),
  goalId: z.string().regex(goalIdPattern),
  changeId: z.string().regex(sequenceIdPattern),
  ticketId: z.string().regex(sequenceIdPattern),
  publishedAt: timestamp,
  artifacts: z.array(reportArtifactSchema),
  execution: executionSchema,
});
const completedReportSchema = reportIdentitySchema.extend({ outcome: z.literal("completed") });
const implementationReportSchema = completedReportSchema
  .extend({
    role: z.literal("implement"),
    baseRevision: z.string().regex(revisionPattern),
    inputRevision: z.string().regex(revisionPattern),
    workerRevision: z.string().regex(revisionPattern),
    candidateRevision: z.string().regex(revisionPattern),
  })
  .strict();
const reviewReportSchema = completedReportSchema
  .extend({
    role: z.literal("review"),
    reviewedRevision: z.string().regex(revisionPattern),
    producingImplementationTicketId: z.string().regex(sequenceIdPattern),
    findings: z.array(reviewFindingSchema),
    acceptanceAssessment: z.array(acceptanceAssessmentSchema).min(1),
    reviewStatement: z.string().trim().min(1),
    reviewer: z.string().trim().min(1),
    verdict: z.enum(["remediate", "approve", "reject", "ask-operator"]),
  })
  .strict();
const terminalReportSchema = reportIdentitySchema
  .extend({
    role: z.enum(["implement", "review"]),
    outcome: z.enum(["partial", "blocked", "failed", "stopped", "interrupted"]),
  })
  .strict();
const reportSchema = z.union([implementationReportSchema, reviewReportSchema, terminalReportSchema]);

export type ImplementationReport = {
  metadata: z.infer<typeof implementationReportSchema>;
  body: string;
};

export type ReviewReport = {
  metadata: z.infer<typeof reviewReportSchema>;
  body: string;
};

export type TerminalReport = {
  metadata: z.infer<typeof terminalReportSchema>;
  body: string;
};

export type Report = ImplementationReport | ReviewReport | TerminalReport;

export type ChangeReportHistory = {
  ticketCount: number;
  reports: Array<{
    ticketId: string;
    role: Report["metadata"]["role"];
    outcome: Report["metadata"]["outcome"];
    verdict?: ReviewReport["metadata"]["verdict"];
    findingIds: string[];
  }>;
};

function isImplementationReport(report: Report): report is ImplementationReport {
  return report.metadata.outcome === "completed" && report.metadata.role === "implement";
}

function isReviewReport(report: Report): report is ReviewReport {
  return report.metadata.outcome === "completed" && report.metadata.role === "review";
}

export type CurrentCandidate = {
  candidateRevision: string;
  producingImplementationTicketId: string;
  report: ImplementationReport;
};

export type CurrentReview = CurrentCandidate & {
  reviewTicketId: string;
  reviewReport: ReviewReport;
};

export type CurrentRemediation = CurrentReview;
export type CurrentApproval = CurrentReview;
export type CurrentRejection = CurrentReview;

export type ReportExecution = TicketIdentity & {
  adapter: string;
  isolation: "workspace" | "container";
  worker: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  environmentDigest?: string;
};

export type PublishImplementationReportInput = TicketIdentity & {
  cwd: string;
  execution: WorkerExecution;
  commitMessage: {
    summary: string;
    body?: string;
  };
  now?: Date;
  crash?: CrashInjector;
  runtimeOperations?: WorkerRuntimeOperations;
};

export type PublishReviewReportInput = TicketIdentity & {
  cwd: string;
  execution: WorkerExecution;
  now?: Date;
  crash?: CrashInjector;
  runtimeOperations?: WorkerRuntimeOperations;
};

export type PublishBlockedReportInput = TicketIdentity & {
  cwd: string;
  execution: WorkerExecution;
  now?: Date;
  crash?: CrashInjector;
  runtimeOperations?: WorkerRuntimeOperations;
};

export type PublishFailedReportInput = TicketIdentity & {
  cwd: string;
  role: "implement" | "review";
  reason: string;
  execution: WorkerExecution;
  now?: Date;
  crash?: CrashInjector;
  runtimeOperations?: WorkerRuntimeOperations;
};

export type PublishInterruptedReportInput = TicketIdentity & {
  cwd: string;
  role: "implement" | "review";
  reason: string;
  execution: ReportExecution;
  now?: Date;
  crash?: CrashInjector;
};

export type PublishStoppedReportInput = PublishInterruptedReportInput;

export type ReportPublicationCleanup =
  | { status: "finalized" }
  | { status: "failed"; phase: "stop" | "cleanup"; message: string };

const maximumBundleBytes = 100 * 1024 * 1024;
const maximumArtifactBytes = 16 * 1024 * 1024;
const maximumArtifactsBytes = 64 * 1024 * 1024;
const requiredImplementationSections = ["Summary", "Verification", "Assumptions", "Limitations", "Risks", "Follow-up"];

function requireCommitMessage(input: PublishImplementationReportInput["commitMessage"], identity: TicketIdentity): string {
  const summary = input.summary.trim();
  if (!summary || summary.includes("\n")) throw new Error("Candidate commit summary must be one non-blank line");
  const body = input.body?.trim() ?? "";
  if (/^Spike-[A-Za-z0-9-]+:/m.test(`${summary}\n${body}`)) {
    throw new Error("Candidate commit message must not provide Spike trailers");
  }
  return [
    summary,
    ...(body ? ["", body] : []),
    "",
    `Spike-Goal-Id: ${identity.goalId}`,
    `Spike-Change-Id: ${identity.changeId}`,
  ].join("\n");
}

async function regularFile(path: string, label: string, maximumBytes: number): Promise<number> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maximumBytes) throw new Error(`${label} exceeds its size limit`);
  return stat.size;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function validateDeclaredPaths(
  outputDirectory: string,
  artifactPaths: Set<string>,
  requiredFiles: string[],
): Promise<void> {
  const outputStat = await lstat(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("Ticket output must be a regular directory");

  const allowedFiles = new Set([...requiredFiles, ...artifactPaths]);
  const allowedDirectories = new Set<string>(artifactPaths.size === 0 ? [] : ["artifacts"]);
  for (const path of artifactPaths) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index++) {
      allowedDirectories.add(components.slice(0, index).join("/"));
    }
  }

  async function visit(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory ? join(outputDirectory, ...relativeDirectory.split("/")) : outputDirectory;
    for (const entry of await readdir(directory)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Ticket output must not contain symbolic links: ${relativePath}`);
      if (stat.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) throw new Error(`unexpected Ticket output path: ${relativePath}`);
        await visit(relativePath);
      } else if (stat.isFile()) {
        if (!allowedFiles.has(relativePath)) throw new Error(`unexpected Ticket output path: ${relativePath}`);
      } else {
        throw new Error(`Ticket output must contain only regular files: ${relativePath}`);
      }
    }
  }

  await visit("");
  for (const file of requiredFiles) await regularFile(join(outputDirectory, file), `output ${file}`, maximumBundleBytes);
}

async function validateArtifacts(
  outputDirectory: string,
  submitted: Array<z.infer<typeof submittedArtifactSchema>>,
): Promise<Array<z.infer<typeof reportArtifactSchema>>> {
  const uniquePaths = new Set(submitted.map((artifact) => artifact.path));
  if (uniquePaths.size !== submitted.length) throw new Error("Submission declares an artifact path more than once");

  let totalBytes = 0;
  const artifacts: Array<z.infer<typeof reportArtifactSchema>> = [];
  for (const artifact of submitted) {
    const path = join(outputDirectory, ...artifact.path.split("/"));
    const bytes = await regularFile(path, `artifact ${artifact.path}`, maximumArtifactBytes);
    totalBytes += bytes;
    if (totalBytes > maximumArtifactsBytes) throw new Error("declared artifacts exceed their total size limit");
    const actualDigest = await digest(path);
    if (actualDigest !== artifact.sha256) throw new Error(`artifact digest does not match: ${artifact.path}`);
    artifacts.push({ ...artifact, bytes });
  }
  return artifacts;
}

function assertSubmissionIdentity(
  metadata: { goalId: string; changeId: string; ticketId: string },
  identity: TicketIdentity,
): void {
  if (
    metadata.goalId !== identity.goalId ||
    metadata.changeId !== identity.changeId ||
    metadata.ticketId !== identity.ticketId
  ) {
    throw new Error(
      `Submission belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`,
    );
  }
}

async function validateImplementationSubmission(
  root: string,
  outputDirectory: string,
  identity: TicketIdentity,
): Promise<{
  metadata: z.infer<typeof implementationSubmissionSchema>;
  body: string;
  artifacts: Array<z.infer<typeof reportArtifactSchema>>;
  bundlePath: string;
}> {
  const document = await readDocument(root, join(outputDirectory, "submission.md"));
  const metadata = implementationSubmissionSchema.parse(document.metadata);
  assertSubmissionIdentity(metadata, identity);
  for (const section of requiredImplementationSections) {
    if (!new RegExp(`^## ${section}\\s*$`, "m").test(document.body)) {
      throw new Error(`completed implementation Submission is missing the ${section} section`);
    }
  }

  const artifactPaths = new Set(metadata.artifacts.map((artifact) => artifact.path));
  await validateDeclaredPaths(outputDirectory, artifactPaths, ["submission.md", "repository.bundle"]);
  const bundlePath = join(outputDirectory, "repository.bundle");
  await regularFile(bundlePath, "output repository bundle", maximumBundleBytes);
  const artifacts = await validateArtifacts(outputDirectory, metadata.artifacts);
  return { metadata, body: document.body, artifacts, bundlePath };
}

function reviewStatement(body: string): string {
  const match = body.match(/^## Review statement\s*\n\s*([\s\S]*?)(?=\n## |$)/m);
  const statement = match?.[1]?.trim() ?? "";
  if (!statement) throw new Error("completed review Submission is missing the Review statement section");
  return statement;
}

function validateAcceptanceAssessment(
  submitted: Array<z.infer<typeof acceptanceAssessmentSchema>>,
  expected: string[],
  source = "review Submission",
): void {
  const submittedCriteria = submitted.map((item) => item.criterion);
  if (new Set(submittedCriteria).size !== submittedCriteria.length) {
    throw new Error(`${source} assesses an acceptance criterion more than once`);
  }
  if (
    submittedCriteria.length !== expected.length ||
    expected.some((criterion) => !submittedCriteria.includes(criterion))
  ) {
    throw new Error(`${source} must assess every Change acceptance criterion exactly once`);
  }
}

async function validateBlockedSubmission(
  root: string,
  outputDirectory: string,
  identity: TicketIdentity,
): Promise<{
  metadata: z.infer<typeof blockedSubmissionSchema>;
  body: string;
  artifacts: Array<z.infer<typeof reportArtifactSchema>>;
}> {
  const document = await readDocument(root, join(outputDirectory, "submission.md"));
  const metadata = blockedSubmissionSchema.parse(document.metadata);
  assertSubmissionIdentity(metadata, identity);
  for (const section of ["Reason", "Evidence"]) {
    const match = document.body.match(new RegExp(`^## ${section}\\s*\\n\\s*([\\s\\S]*?)(?=\\n## |$)`, "m"));
    if (!match?.[1]?.trim()) throw new Error(`blocked Submission is missing the ${section} section`);
  }
  const artifactPaths = new Set(metadata.artifacts.map((artifact) => artifact.path));
  await validateDeclaredPaths(outputDirectory, artifactPaths, ["submission.md"]);
  const artifacts = await validateArtifacts(outputDirectory, metadata.artifacts);
  return { metadata, body: document.body, artifacts };
}

async function validateReviewSubmission(
  root: string,
  outputDirectory: string,
  identity: TicketIdentity,
  reviewedRevision: string,
  producingImplementationTicketId: string,
  expectedAcceptanceCriteria: string[],
): Promise<{
  metadata: z.infer<typeof reviewSubmissionSchema>;
  body: string;
  reviewStatement: string;
  artifacts: Array<z.infer<typeof reportArtifactSchema>>;
}> {
  const document = await readDocument(root, join(outputDirectory, "submission.md"));
  const metadata = reviewSubmissionSchema.parse(document.metadata);
  assertSubmissionIdentity(metadata, identity);
  if (metadata.reviewedRevision !== reviewedRevision) {
    throw new Error(`review Submission reviewed ${metadata.reviewedRevision}, expected Candidate ${reviewedRevision}`);
  }
  if (metadata.producingImplementationTicketId !== producingImplementationTicketId) {
    throw new Error(
      `review Submission references implementation Ticket ${metadata.producingImplementationTicketId}, expected ${producingImplementationTicketId}`,
    );
  }
  const findingIds = metadata.findings.map((finding) => finding.id);
  if (new Set(findingIds).size !== findingIds.length) throw new Error("review finding IDs must be unique");
  if (metadata.verdict === "remediate" && metadata.findings.length === 0) {
    throw new Error("remediate review Submission must contain at least one finding");
  }
  validateAcceptanceAssessment(metadata.acceptanceAssessment, expectedAcceptanceCriteria);
  if (
    metadata.verdict === "approve" &&
    metadata.acceptanceAssessment.some((assessment) => assessment.assessment !== "met")
  ) {
    throw new Error("approve review Submission must assess every acceptance criterion as met");
  }

  const artifactPaths = new Set(metadata.artifacts.map((artifact) => artifact.path));
  await validateDeclaredPaths(outputDirectory, artifactPaths, ["submission.md"]);
  const artifacts = await validateArtifacts(outputDirectory, metadata.artifacts);
  return { metadata, body: document.body, reviewStatement: reviewStatement(document.body), artifacts };
}

function matchingExecution(
  execution: WorkerExecution,
  identity: TicketIdentity,
  requireSuccessfulExit = true,
): void {
  if (
    execution.goalId !== identity.goalId ||
    execution.changeId !== identity.changeId ||
    execution.ticketId !== identity.ticketId
  ) {
    throw new Error("local-clone execution belongs to a different Ticket");
  }
  if (!execution.adapter.trim()) throw new Error("Worker execution adapter must not be blank");
  if (!Number.isInteger(execution.exitCode)) throw new Error("Worker execution has an invalid exit code");
  if (requireSuccessfulExit && execution.exitCode !== 0) throw new Error(`worker exited with code ${execution.exitCode}`);
  if (!execution.startedAt || !execution.finishedAt) throw new Error("Worker execution is missing timestamps");
}

function matchingReportExecution(execution: ReportExecution, identity: TicketIdentity): void {
  if (
    execution.goalId !== identity.goalId ||
    execution.changeId !== identity.changeId ||
    execution.ticketId !== identity.ticketId
  ) {
    throw new Error("Report execution belongs to a different Ticket");
  }
  if (!Number.isInteger(execution.exitCode)) throw new Error("Report execution has an invalid exit code");
  if (!execution.startedAt || !execution.finishedAt) throw new Error("Report execution is missing timestamps");
}

function executionMetadata(execution: ReportExecution): z.infer<typeof executionSchema> {
  const metadata = executionSchema.parse({
    adapter: execution.adapter,
    isolation: execution.isolation,
    worker: execution.worker,
    model: execution.model,
    thinking: execution.thinking,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    ...(execution.environmentDigest === undefined ? {} : { environmentDigest: execution.environmentDigest }),
  });
  if (Date.parse(metadata.finishedAt) < Date.parse(metadata.startedAt)) {
    throw new Error("execution finishedAt must not precede startedAt");
  }
  return metadata;
}

function matchingTicketModelSelection(
  ticket: Awaited<ReturnType<typeof loadTicket>>,
  execution: Pick<ReportExecution, "model" | "thinking">,
): void {
  if (execution.model !== ticket.metadata.model || execution.thinking !== ticket.metadata.thinking) {
    throw new Error("Report execution model selection does not match its Ticket assignment");
  }
}

/** Validate immutable Ticket provenance before an execution becomes a Report. */
async function matchingTicketExecutionProvenance(
  root: string,
  ticket: Awaited<ReturnType<typeof loadTicket>>,
  execution: Pick<ReportExecution, "adapter" | "isolation" | "worker">,
  outcome: Report["metadata"]["outcome"],
): Promise<void> {
  if (execution.isolation !== ticket.metadata.executionPolicy.isolation) {
    throw new Error("Report execution isolation does not match its Ticket execution policy");
  }
  if (execution.adapter === "host") {
    if (outcome !== "stopped" && outcome !== "interrupted") {
      throw new Error("host terminal execution is permitted only for stopped or interrupted Reports");
    }
    if (execution.worker !== "not-launched") {
      throw new Error("host terminal execution must identify a not-launched worker");
    }
    // Host provenance is only true before any Worker adapter has durable launch evidence.
    if (await loadRecordedWorkerIfPresent(root, {
      goalId: ticket.metadata.goalId,
      changeId: ticket.metadata.changeId,
      ticketId: ticket.metadata.ticketId,
    }) !== undefined) {
      throw new Error("host terminal execution contradicts a recorded Worker launch");
    }
    return;
  }
  const adapter = selectWorkerAdapter(ticket.metadata.executionPolicy);
  if (execution.adapter !== adapter.adapter) {
    throw new Error("Report execution adapter does not match its Ticket execution policy");
  }
}

function requireTerminalReason(reason: string, outcome: "Failure" | "Interruption" | "Stop"): string {
  const normalized = reason.trim();
  if (!normalized) throw new Error(`${outcome} reason must not be blank`);
  return normalized;
}

async function finalizePublishedWorker(
  root: string,
  identity: TicketIdentity,
  finishedAt: Date,
  operations?: WorkerRuntimeOperations,
): Promise<ReportPublicationCleanup> {
  if ((await loadRecordedWorkerIfPresent(root, identity)) === undefined) return { status: "finalized" };
  const result = await finalizeWorker(root, identity, finishedAt, operations);
  if (result.status === "failed") {
    return { status: "failed", phase: result.phase, message: result.message };
  }
  try {
    await forgetFinalizedWorker(root, identity);
    return { status: "finalized" };
  } catch (error) {
    return {
      status: "failed",
      phase: "cleanup",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadReportDocument(root: string, goalId: string, changeId: string, ticketId: string): Promise<Report> {
  const document = await readDocument(root, reportPath(root, goalId, changeId, ticketId));
  const metadata = reportSchema.parse(document.metadata);
  if (metadata.goalId !== goalId || metadata.changeId !== changeId || metadata.ticketId !== ticketId) {
    throw new Error(`Report document belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`);
  }
  const ticket = await loadTicket(root, goalId, changeId, ticketId);
  if (metadata.role !== ticket.metadata.role) {
    throw new Error(`Report ${goalId}/${changeId}/${ticketId} role does not match its Ticket`);
  }
  matchingTicketModelSelection(ticket, metadata.execution);
  await matchingTicketExecutionProvenance(root, ticket, metadata.execution, metadata.outcome);
  if (metadata.outcome !== "completed" && !document.body.trim()) {
    throw new Error(`terminal Report ${goalId}/${changeId}/${ticketId} must explain its outcome`);
  }
  if (metadata.outcome === "completed" && metadata.role === "implement") {
    return { metadata, body: document.body };
  }
  if (metadata.outcome === "completed" && metadata.role === "review") {
    return { metadata, body: document.body };
  }
  return { metadata, body: document.body };
}

export async function loadSubmissionOutcome(
  root: string,
  identity: TicketIdentity,
): Promise<"completed" | "blocked"> {
  const document = await readDocument(root, join(ticketOutputPath(root, identity), "submission.md"));
  const metadata = submissionSchema.parse(document.metadata);
  assertSubmissionIdentity(metadata, identity);
  return metadata.outcome;
}

export async function loadReport(root: string, goalId: string, changeId: string, ticketId: string): Promise<Report> {
  return loadReportDocument(root, goalId, changeId, ticketId);
}

export async function loadReportIfPresent(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
): Promise<Report | undefined> {
  if (!(await documentExists(root, reportPath(root, goalId, changeId, ticketId)))) return undefined;
  return loadReportDocument(root, goalId, changeId, ticketId);
}

export async function loadChangeReportHistory(
  root: string,
  goalId: string,
  changeId: string,
): Promise<ChangeReportHistory> {
  const ticketsDirectory = join(dirname(changePath(root, goalId, changeId)), "tickets");
  const ticketIds = (await listDirectoryNames(root, ticketsDirectory))
    .filter((name) => sequenceIdPattern.test(name))
    .sort();
  const reports: ChangeReportHistory["reports"] = [];
  let ticketCount = 0;

  for (const ticketId of ticketIds) {
    if (!(await documentExists(root, ticketPath(root, goalId, changeId, ticketId)))) continue;
    await loadTicket(root, goalId, changeId, ticketId);
    ticketCount++;
    const report = await loadReportIfPresent(root, goalId, changeId, ticketId);
    if (report === undefined) continue;
    reports.push({
      ticketId,
      role: report.metadata.role,
      outcome: report.metadata.outcome,
      ...(isReviewReport(report) ? { verdict: report.metadata.verdict } : {}),
      findingIds: isReviewReport(report) ? report.metadata.findings.map((finding) => finding.id) : [],
    });
  }

  return { ticketCount, reports };
}

export async function loadImplementationReport(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
): Promise<ImplementationReport> {
  const report = await loadReportDocument(root, goalId, changeId, ticketId);
  if (!isImplementationReport(report)) {
    throw new Error(`Report ${goalId}/${changeId}/${ticketId} is not a completed implementation Report`);
  }
  return { metadata: report.metadata, body: report.body };
}

export async function loadReviewReport(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
): Promise<ReviewReport> {
  const report = await loadReportDocument(root, goalId, changeId, ticketId);
  if (!isReviewReport(report)) {
    throw new Error(`Report ${goalId}/${changeId}/${ticketId} is not a completed review Report`);
  }
  return { metadata: report.metadata, body: report.body };
}

export async function deriveCurrentCandidate(
  root: string,
  goalId: string,
  changeId: string,
): Promise<CurrentCandidate | undefined> {
  const ticketsDirectory = join(dirname(changePath(root, goalId, changeId)), "tickets");
  const ticketIds = (await listDirectoryNames(root, ticketsDirectory))
    .filter((name) => sequenceIdPattern.test(name))
    .sort()
    .reverse();
  for (const ticketId of ticketIds) {
    const report = await loadReportIfPresent(root, goalId, changeId, ticketId);
    if (report === undefined || !isImplementationReport(report)) continue;
    return {
      candidateRevision: report.metadata.candidateRevision,
      producingImplementationTicketId: ticketId,
      report,
    };
  }
  return undefined;
}

export async function deriveCurrentReview(
  root: string,
  goalId: string,
  changeId: string,
): Promise<CurrentReview | undefined> {
  const [candidate, change] = await Promise.all([
    deriveCurrentCandidate(root, goalId, changeId),
    loadChange(root, goalId, changeId),
  ]);
  if (candidate === undefined) return undefined;

  const ticketsDirectory = join(dirname(changePath(root, goalId, changeId)), "tickets");
  const ticketIds = (await listDirectoryNames(root, ticketsDirectory))
    .filter((name) => sequenceIdPattern.test(name))
    .sort()
    .reverse();
  for (const ticketId of ticketIds) {
    const reviewReport = await loadReportIfPresent(root, goalId, changeId, ticketId);
    if (reviewReport === undefined || !isReviewReport(reviewReport)) continue;

    const reviewTicket = await loadTicket(root, goalId, changeId, ticketId);
    if (
      reviewTicket.metadata.role !== "review" ||
      reviewTicket.metadata.inputRevision !== reviewReport.metadata.reviewedRevision ||
      reviewTicket.metadata.producingImplementationTicketId !==
        reviewReport.metadata.producingImplementationTicketId
    ) {
      throw new Error(`review Report ${goalId}/${changeId}/${ticketId} does not match its Ticket Candidate selection`);
    }

    validateAcceptanceAssessment(
      reviewReport.metadata.acceptanceAssessment,
      acceptanceCriteria(change.body),
      `review Report ${goalId}/${changeId}/${ticketId}`,
    );
    if (
      reviewReport.metadata.verdict === "approve" &&
      reviewReport.metadata.acceptanceAssessment.some((assessment) => assessment.assessment !== "met")
    ) {
      throw new Error(`approve review Report ${goalId}/${changeId}/${ticketId} must assess every acceptance criterion as met`);
    }

    const producingReport = await loadImplementationReport(
      root,
      goalId,
      changeId,
      reviewReport.metadata.producingImplementationTicketId,
    );
    if (producingReport.metadata.candidateRevision !== reviewReport.metadata.reviewedRevision) {
      throw new Error(
        `review Report ${goalId}/${changeId}/${ticketId} Candidate does not match its producing implementation Report`,
      );
    }
    if (
      reviewReport.metadata.reviewedRevision === candidate.candidateRevision &&
      reviewReport.metadata.producingImplementationTicketId === candidate.producingImplementationTicketId
    ) {
      return { ...candidate, reviewTicketId: ticketId, reviewReport };
    }
  }
  return undefined;
}

async function deriveCurrentReviewWithVerdict(
  root: string,
  goalId: string,
  changeId: string,
  verdict: ReviewReport["metadata"]["verdict"],
): Promise<CurrentReview | undefined> {
  const review = await deriveCurrentReview(root, goalId, changeId);
  return review?.reviewReport.metadata.verdict === verdict ? review : undefined;
}

export function deriveCurrentRemediation(
  root: string,
  goalId: string,
  changeId: string,
): Promise<CurrentRemediation | undefined> {
  return deriveCurrentReviewWithVerdict(root, goalId, changeId, "remediate");
}

export function deriveCurrentApproval(
  root: string,
  goalId: string,
  changeId: string,
): Promise<CurrentApproval | undefined> {
  return deriveCurrentReviewWithVerdict(root, goalId, changeId, "approve");
}

export function deriveCurrentRejection(
  root: string,
  goalId: string,
  changeId: string,
): Promise<CurrentRejection | undefined> {
  return deriveCurrentReviewWithVerdict(root, goalId, changeId, "reject");
}

export async function publishBlockedReport(
  input: PublishBlockedReportInput,
): Promise<{ root: string; report: TerminalReport; cleanup: ReportPublicationCleanup }> {
  const repository = await discoverRepository(input.cwd);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const path = reportPath(repository.root, input.goalId, input.changeId, input.ticketId);
  if (await documentExists(repository.root, path)) {
    throw new Error(`immutable Report already exists for Ticket ${input.goalId}/${input.changeId}/${input.ticketId}`);
  }
  matchingExecution(input.execution, identity);

  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  matchingTicketModelSelection(ticket, input.execution);
  await matchingTicketExecutionProvenance(repository.root, ticket, input.execution, "blocked");
  const submission = await validateBlockedSubmission(
    repository.root,
    ticketOutputPath(repository.root, identity),
    identity,
  );
  const metadata = terminalReportSchema.parse({
    kind: "report",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId: input.ticketId,
    role: ticket.metadata.role,
    outcome: "blocked",
    publishedAt: (input.now ?? new Date()).toISOString(),
    artifacts: submission.artifacts,
    execution: executionMetadata(input.execution),
  });
  const report = { metadata, body: submission.body };
  await installImmutable(
    repository.root,
    path,
    serializeDocument(metadata, submission.body),
    commitCrashHooks(input.crash, ticket.metadata.role === "implement" ? "implementation-report-publication" : "review-report-publication"),
  );
  const cleanup = await finalizePublishedWorker(repository.root, identity, input.now ?? new Date(), input.runtimeOperations);
  return { root: repository.root, report, cleanup };
}

export async function publishFailedReport(
  input: PublishFailedReportInput,
): Promise<{ root: string; report: TerminalReport; cleanup: ReportPublicationCleanup }> {
  const repository = await discoverRepository(input.cwd);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const path = reportPath(repository.root, input.goalId, input.changeId, input.ticketId);
  if (await documentExists(repository.root, path)) {
    throw new Error(`immutable Report already exists for Ticket ${input.goalId}/${input.changeId}/${input.ticketId}`);
  }

  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  if (input.role !== ticket.metadata.role) {
    throw new Error(`failed Report role ${input.role} does not match its Ticket role ${ticket.metadata.role}`);
  }
  matchingExecution(input.execution, identity, false);
  matchingTicketModelSelection(ticket, input.execution);
  await matchingTicketExecutionProvenance(repository.root, ticket, input.execution, "failed");
  const execution = executionMetadata(input.execution);
  const reason = requireTerminalReason(input.reason, "Failure");
  const metadata = terminalReportSchema.parse({
    kind: "report",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId: input.ticketId,
    role: input.role,
    outcome: "failed",
    publishedAt: (input.now ?? new Date()).toISOString(),
    artifacts: [],
    execution,
  });
  const body = `# Ticket failed\n\n${reason}\n`;
  const report = { metadata, body };

  await installImmutable(
    repository.root,
    path,
    serializeDocument(metadata, body),
    commitCrashHooks(input.crash, input.role === "implement" ? "implementation-report-publication" : "review-report-publication"),
  );
  const cleanup = await finalizePublishedWorker(repository.root, identity, input.now ?? new Date(), input.runtimeOperations);
  return { root: repository.root, report, cleanup };
}

async function publishHostTerminalReport(
  input: PublishInterruptedReportInput,
  outcome: "interrupted" | "stopped",
): Promise<{ root: string; report: TerminalReport }> {
  const repository = await discoverRepository(input.cwd);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const path = reportPath(repository.root, input.goalId, input.changeId, input.ticketId);
  if (await documentExists(repository.root, path)) {
    throw new Error(`immutable Report already exists for Ticket ${input.goalId}/${input.changeId}/${input.ticketId}`);
  }

  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  if (input.role !== ticket.metadata.role) {
    throw new Error(`${outcome} Report role ${input.role} does not match its Ticket role ${ticket.metadata.role}`);
  }
  matchingReportExecution(input.execution, identity);
  matchingTicketModelSelection(ticket, input.execution);
  await matchingTicketExecutionProvenance(repository.root, ticket, input.execution, outcome);
  const execution = executionMetadata(input.execution);
  const label = outcome === "interrupted" ? "Interruption" : "Stop";
  const reason = requireTerminalReason(input.reason, label);
  const metadata = terminalReportSchema.parse({
    kind: "report",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId: input.ticketId,
    role: input.role,
    outcome,
    publishedAt: (input.now ?? new Date()).toISOString(),
    artifacts: [],
    execution,
  });
  const body = `# Ticket ${outcome}\n\n${reason}\n`;
  const report = { metadata, body };
  await installImmutable(
    repository.root,
    path,
    serializeDocument(metadata, body),
    commitCrashHooks(input.crash, input.role === "implement" ? "implementation-report-publication" : "review-report-publication"),
  );
  return { root: repository.root, report };
}

export function publishInterruptedReport(
  input: PublishInterruptedReportInput,
): Promise<{ root: string; report: TerminalReport }> {
  return publishHostTerminalReport(input, "interrupted");
}

export function publishStoppedReport(
  input: PublishStoppedReportInput,
): Promise<{ root: string; report: TerminalReport }> {
  return publishHostTerminalReport(input, "stopped");
}

export async function publishImplementationReport(
  input: PublishImplementationReportInput,
): Promise<{ root: string; report: ImplementationReport; cleanup: ReportPublicationCleanup }> {
  const repository = await discoverRepository(input.cwd);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const path = reportPath(repository.root, input.goalId, input.changeId, input.ticketId);
  if (await documentExists(repository.root, path)) {
    throw new Error(`immutable Report already exists for Ticket ${input.goalId}/${input.changeId}/${input.ticketId}`);
  }
  matchingExecution(input.execution, identity);

  const [ticket, change] = await Promise.all([
    loadTicket(repository.root, input.goalId, input.changeId, input.ticketId),
    loadChange(repository.root, input.goalId, input.changeId),
  ]);
  if (ticket.metadata.role !== "implement") throw new Error("implementation Report requires an implement Ticket");
  matchingTicketModelSelection(ticket, input.execution);
  await matchingTicketExecutionProvenance(repository.root, ticket, input.execution, "completed");

  const currentCandidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
  if (ticket.metadata.responseToReviewTicketId === undefined) {
    if (currentCandidate !== undefined) {
      throw new Error("implementation Ticket omits the current Candidate's review Report");
    }
  } else {
    const responseToReview = await deriveCurrentReview(repository.root, input.goalId, input.changeId);
    if (
      responseToReview === undefined ||
      responseToReview.reviewReport.metadata.verdict === "approve" ||
      ticket.metadata.inputRevision !== responseToReview.candidateRevision ||
      ticket.metadata.responseToReviewTicketId !== responseToReview.reviewTicketId
    ) {
      throw new Error("implementation Ticket does not select the current Candidate and its exact review Report");
    }
  }

  const outputDirectory = ticketOutputPath(repository.root, identity);
  const submission = await validateImplementationSubmission(repository.root, outputDirectory, identity);
  const message = requireCommitMessage(input.commitMessage, identity);

  return withImportedWorkerRevision(
    repository.root,
    submission.bundlePath,
    submission.metadata.workerRevision,
    identity,
    async (workerRevision) => {
      const candidateRevision = await normalizeCandidate(
        repository.root,
        workerRevision,
        change.metadata.baseRevision,
        message,
      );
      const metadata = implementationReportSchema.parse({
        kind: "report",
        goalId: input.goalId,
        changeId: input.changeId,
        ticketId: input.ticketId,
        role: "implement",
        outcome: "completed",
        publishedAt: (input.now ?? new Date()).toISOString(),
        baseRevision: change.metadata.baseRevision,
        inputRevision: ticket.metadata.inputRevision,
        workerRevision,
        candidateRevision,
        artifacts: submission.artifacts,
        execution: executionMetadata(input.execution),
      });
      const report = { metadata, body: submission.body };

      await retainCandidate(repository.root, input.goalId, input.changeId, input.ticketId, candidateRevision);
      await installImmutable(
        repository.root,
        path,
        serializeDocument(metadata, submission.body),
        commitCrashHooks(input.crash, "implementation-report-publication"),
      );
      const cleanup = await finalizePublishedWorker(repository.root, identity, input.now ?? new Date(), input.runtimeOperations);
      return { root: repository.root, report, cleanup };
    },
  );
}

export async function publishReviewReport(
  input: PublishReviewReportInput,
): Promise<{ root: string; report: ReviewReport; cleanup: ReportPublicationCleanup }> {
  const repository = await discoverRepository(input.cwd);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const path = reportPath(repository.root, input.goalId, input.changeId, input.ticketId);
  if (await documentExists(repository.root, path)) {
    throw new Error(`immutable Report already exists for Ticket ${input.goalId}/${input.changeId}/${input.ticketId}`);
  }
  matchingExecution(input.execution, identity);

  const [ticket, change, candidate] = await Promise.all([
    loadTicket(repository.root, input.goalId, input.changeId, input.ticketId),
    loadChange(repository.root, input.goalId, input.changeId),
    deriveCurrentCandidate(repository.root, input.goalId, input.changeId),
  ]);
  if (ticket.metadata.role !== "review") throw new Error("review Report requires a review Ticket");
  matchingTicketModelSelection(ticket, input.execution);
  await matchingTicketExecutionProvenance(repository.root, ticket, input.execution, "completed");
  if (candidate === undefined) throw new Error(`Change ${input.goalId}/${input.changeId} has no completed implementation Candidate`);
  if (
    ticket.metadata.inputRevision !== candidate.candidateRevision ||
    ticket.metadata.producingImplementationTicketId !== candidate.producingImplementationTicketId
  ) {
    throw new Error("review Ticket does not select the current Candidate and its producing implementation Ticket");
  }

  const producingReport = await loadImplementationReport(
    repository.root,
    input.goalId,
    input.changeId,
    ticket.metadata.producingImplementationTicketId,
  );
  if (producingReport.metadata.candidateRevision !== ticket.metadata.inputRevision) {
    throw new Error("review Ticket Candidate does not match its producing implementation Report");
  }

  const submission = await validateReviewSubmission(
    repository.root,
    ticketOutputPath(repository.root, identity),
    identity,
    ticket.metadata.inputRevision,
    ticket.metadata.producingImplementationTicketId,
    acceptanceCriteria(change.body),
  );
  const metadata = reviewReportSchema.parse({
    kind: "report",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId: input.ticketId,
    role: "review",
    outcome: "completed",
    publishedAt: (input.now ?? new Date()).toISOString(),
    reviewedRevision: submission.metadata.reviewedRevision,
    producingImplementationTicketId: submission.metadata.producingImplementationTicketId,
    findings: submission.metadata.findings,
    acceptanceAssessment: submission.metadata.acceptanceAssessment,
    reviewStatement: submission.reviewStatement,
    reviewer: input.execution.worker,
    verdict: submission.metadata.verdict,
    artifacts: submission.artifacts,
    execution: executionMetadata(input.execution),
  });
  const report = { metadata, body: submission.body };
  await installImmutable(
    repository.root,
    path,
    serializeDocument(metadata, submission.body),
    commitCrashHooks(input.crash, "review-report-publication"),
  );
  const cleanup = await finalizePublishedWorker(repository.root, identity, input.now ?? new Date(), input.runtimeOperations);
  return { root: repository.root, report, cleanup };
}
