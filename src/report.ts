import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadChange } from "./change.ts";
import {
  documentExists,
  installImmutable,
  readDocument,
  serializeDocument,
} from "./durable-state.ts";
import { normalizeCandidate, retainCandidate, withImportedWorkerRevision } from "./git-change.ts";
import { discoverRepository } from "./git.ts";
import { loadTicket, reportPath } from "./ticket.ts";
import { implementationOutputPath, type LocalCloneExecution, type TicketIdentity } from "./worker.ts";

const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const sequenceIdPattern = /^(?!000)[0-9]{3}$/;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digestPattern = /^[0-9a-f]{64}$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
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
const submissionSchema = z
  .object({
    kind: z.literal("submission"),
    goalId: z.string().regex(goalIdPattern),
    changeId: z.string().regex(sequenceIdPattern),
    ticketId: z.string().regex(sequenceIdPattern),
    outcome: z.literal("completed"),
    workerRevision: z.string().regex(revisionPattern),
    artifacts: z.array(submittedArtifactSchema),
  })
  .strict();
const reportArtifactSchema = submittedArtifactSchema.extend({ bytes: z.number().int().nonnegative() }).strict();
const reportSchema = z
  .object({
    kind: z.literal("report"),
    goalId: z.string().regex(goalIdPattern),
    changeId: z.string().regex(sequenceIdPattern),
    ticketId: z.string().regex(sequenceIdPattern),
    role: z.literal("implement"),
    outcome: z.literal("completed"),
    publishedAt: timestamp,
    baseRevision: z.string().regex(revisionPattern),
    inputRevision: z.string().regex(revisionPattern),
    workerRevision: z.string().regex(revisionPattern),
    candidateRevision: z.string().regex(revisionPattern),
    artifacts: z.array(reportArtifactSchema),
    execution: z
      .object({
        adapter: z.string().min(1),
        isolation: z.enum(["workspace", "container"]),
        worker: z.string().min(1),
        model: z.string().min(1),
        startedAt: timestamp,
        finishedAt: timestamp,
        environmentDigest: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type ImplementationReport = {
  metadata: z.infer<typeof reportSchema>;
  body: string;
};

export type PublishImplementationReportInput = TicketIdentity & {
  cwd: string;
  execution: LocalCloneExecution;
  commitMessage: {
    summary: string;
    body?: string;
  };
  now?: Date;
};

const maximumBundleBytes = 100 * 1024 * 1024;
const maximumArtifactBytes = 16 * 1024 * 1024;
const maximumArtifactsBytes = 64 * 1024 * 1024;
const requiredSections = ["Summary", "Verification", "Assumptions", "Limitations", "Risks", "Follow-up"];

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

async function validateDeclaredPaths(outputDirectory: string, artifactPaths: Set<string>): Promise<void> {
  const outputStat = await lstat(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("Ticket output must be a regular directory");

  const allowedFiles = new Set(["submission.md", "repository.bundle", ...artifactPaths]);
  const allowedDirectories = new Set<string>(["artifacts"]);
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
}

async function validateSubmission(
  root: string,
  outputDirectory: string,
  identity: TicketIdentity,
): Promise<{
  metadata: z.infer<typeof submissionSchema>;
  body: string;
  artifacts: Array<z.infer<typeof reportArtifactSchema>>;
  bundlePath: string;
}> {
  const document = await readDocument(root, join(outputDirectory, "submission.md"));
  const metadata = submissionSchema.parse(document.metadata);
  if (
    metadata.goalId !== identity.goalId ||
    metadata.changeId !== identity.changeId ||
    metadata.ticketId !== identity.ticketId
  ) {
    throw new Error(
      `Submission belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`,
    );
  }
  const uniquePaths = new Set(metadata.artifacts.map((artifact) => artifact.path));
  if (uniquePaths.size !== metadata.artifacts.length) throw new Error("Submission declares an artifact path more than once");
  for (const section of requiredSections) {
    if (!new RegExp(`^## ${section}\\s*$`, "m").test(document.body)) {
      throw new Error(`completed implementation Submission is missing the ${section} section`);
    }
  }

  await validateDeclaredPaths(outputDirectory, uniquePaths);
  const bundlePath = join(outputDirectory, "repository.bundle");
  await regularFile(bundlePath, "output repository bundle", maximumBundleBytes);

  let totalBytes = 0;
  const artifacts: Array<z.infer<typeof reportArtifactSchema>> = [];
  for (const artifact of metadata.artifacts) {
    const path = join(outputDirectory, ...artifact.path.split("/"));
    const bytes = await regularFile(path, `artifact ${artifact.path}`, maximumArtifactBytes);
    totalBytes += bytes;
    if (totalBytes > maximumArtifactsBytes) throw new Error("declared artifacts exceed their total size limit");
    const actualDigest = await digest(path);
    if (actualDigest !== artifact.sha256) throw new Error(`artifact digest does not match: ${artifact.path}`);
    artifacts.push({ ...artifact, bytes });
  }

  return { metadata, body: document.body, artifacts, bundlePath };
}

function matchingExecution(execution: LocalCloneExecution, identity: TicketIdentity): void {
  if (
    execution.goalId !== identity.goalId ||
    execution.changeId !== identity.changeId ||
    execution.ticketId !== identity.ticketId
  ) {
    throw new Error("local-clone execution belongs to a different Ticket");
  }
  if (execution.exitCode !== 0) throw new Error(`worker exited with code ${execution.exitCode}`);
  if (!execution.startedAt || !execution.finishedAt) throw new Error("local-clone execution is missing timestamps");
}

export async function loadReport(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
): Promise<ImplementationReport> {
  const document = await readDocument(root, reportPath(root, goalId, changeId, ticketId));
  const metadata = reportSchema.parse(document.metadata);
  if (metadata.goalId !== goalId || metadata.changeId !== changeId || metadata.ticketId !== ticketId) {
    throw new Error(`Report document belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`);
  }
  return { metadata, body: document.body };
}

export async function publishImplementationReport(
  input: PublishImplementationReportInput,
): Promise<{ root: string; report: ImplementationReport }> {
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
  const outputDirectory = implementationOutputPath(repository.root, identity);
  const submission = await validateSubmission(repository.root, outputDirectory, identity);
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
      const metadata = reportSchema.parse({
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
        execution: {
          adapter: input.execution.adapter,
          isolation: input.execution.isolation,
          worker: input.execution.worker,
          model: input.execution.model,
          startedAt: input.execution.startedAt,
          finishedAt: input.execution.finishedAt,
          ...(input.execution.environmentDigest === undefined
            ? {}
            : { environmentDigest: input.execution.environmentDigest }),
        },
      });
      const report = { metadata, body: submission.body };

      await retainCandidate(repository.root, input.goalId, input.changeId, input.ticketId, candidateRevision);
      await installImmutable(repository.root, path, serializeDocument(metadata, submission.body));
      return { root: repository.root, report };
    },
  );
}
