import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { installImmutable, serializeDocument } from "./durable-state.ts";
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
  changeId: string;
  ticketId: string;
  role: "implement" | "review";
  workerRevision?: string;
  reviewedRevision?: string;
  artifacts: Artifact[];
};

function safeGitEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) environment[name] = value;
  }
  return { ...environment, ...extra };
}

async function executeGit(cwd: string, args: string[], extraEnvironment?: Record<string, string>): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: safeGitEnvironment(extraEnvironment),
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

async function git(cwd: string, args: string[], extraEnvironment?: Record<string, string>): Promise<string> {
  const result = await executeGit(cwd, args, extraEnvironment);
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

function assertEnvironmentMatchesTicket(ticket: Ticket): void {
  const expected: Array<[string, string]> = [
    ["SPIKE_GOAL_ID", ticket.metadata.goalId],
    ["SPIKE_CHANGE_ID", ticket.metadata.changeId],
    ["SPIKE_TICKET_ID", ticket.metadata.ticketId],
    ["SPIKE_TICKET_ROLE", ticket.metadata.role],
    ["SPIKE_INPUT_REVISION", ticket.metadata.inputRevision],
  ];
  for (const [name, value] of expected) {
    const declared = process.env[name];
    if (declared !== undefined && declared !== value) {
      throw new Error(`${name} does not match SPIKE_INPUT_DIR/ticket.md`);
    }
  }

  const actualModel = process.env["SPIKE_ACTUAL_MODEL"] ?? process.env["SPIKE_MODEL"];
  const actualThinking = process.env["SPIKE_ACTUAL_THINKING"] ?? process.env["SPIKE_THINKING"];
  if (!actualModel || !actualThinking) {
    throw new Error("worker completion requires observed model and thinking provenance");
  }
  if (actualModel !== ticket.metadata.model || actualThinking !== ticket.metadata.thinking) {
    throw new Error(
      `actual worker selection ${actualModel}/${actualThinking} does not match Ticket assignment ${ticket.metadata.model}/${ticket.metadata.thinking}`,
    );
  }
}

function acceptanceCriteria(ticketBody: string): string[] {
  const section = ticketBody.match(/^## Acceptance criteria\s*\n([\s\S]*?)(?=^## |$)/m)?.[1] ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
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

async function repositoryRoot(cwd: string): Promise<string> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return realpath(root);
}

async function assertInputRevision(repository: string, ticket: Ticket): Promise<string> {
  const exactInput = await git(repository, ["rev-parse", "--verify", `${ticket.metadata.inputRevision}^{commit}`]);
  if (exactInput !== ticket.metadata.inputRevision) throw new Error("Ticket input revision does not identify a commit exactly");
  const head = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (ticket.metadata.role === "review") {
    if (head !== ticket.metadata.inputRevision) {
      throw new Error(`review checkout is at ${head}, expected Ticket revision ${ticket.metadata.inputRevision}`);
    }
    const status = await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) throw new Error("review checkout must remain at the exact clean Ticket revision");
  }
  return head;
}

async function snapshotImplementation(repository: string, parentRevision: string): Promise<string> {
  await git(repository, ["add", "-A"]);
  const tree = await git(repository, ["write-tree"]);
  return git(
    repository,
    ["commit-tree", tree, "-p", parentRevision, "-m", "Spike worker completion snapshot"],
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
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const stagingRef = `refs/spike/completion/${ticket.metadata.goalId}/${ticket.metadata.changeId}/${ticket.metadata.ticketId}/${suffix}`;
  const temporaryPath = join(outputDirectory, `.repository.${suffix}.bundle.tmp`);
  const bundlePath = join(outputDirectory, "repository.bundle");
  try {
    await git(repository, ["update-ref", stagingRef, workerRevision, "0".repeat(workerRevision.length)]);
    await git(repository, ["bundle", "create", temporaryPath, stagingRef]);
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
    await git(repository, ["update-ref", "-d", stagingRef]).catch(() => undefined);
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

function parsePayload(source: string): unknown {
  if (Buffer.byteLength(source) > maximumPayloadBytes) throw new Error("worker completion payload exceeds its size limit");
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("worker completion payload is invalid JSON");
  }
}

function requireEnvironmentDirectory(name: "SPIKE_INPUT_DIR" | "SPIKE_OUTPUT_DIR"): string {
  const value = process.env[name];
  if (value === undefined || !value.trim()) throw new Error(`${name} is required`);
  return resolve(value);
}

export async function completeWorker(cwd: string, payloadSource: string): Promise<WorkerCompletion> {
  const inputPath = requireEnvironmentDirectory("SPIKE_INPUT_DIR");
  const outputPath = requireEnvironmentDirectory("SPIKE_OUTPUT_DIR");
  const [inputDirectory, outputDirectory] = await Promise.all([
    regularDirectory(inputPath, "SPIKE_INPUT_DIR"),
    regularDirectory(outputPath, "SPIKE_OUTPUT_DIR"),
  ]);
  const ticket = await loadTicketDocument(inputDirectory, join(inputDirectory, "ticket.md"));
  assertEnvironmentMatchesTicket(ticket);
  const payloadValue = parsePayload(payloadSource);
  const repository = await repositoryRoot(cwd);
  const head = await assertInputRevision(repository, ticket);
  const identity = {
    goalId: ticket.metadata.goalId,
    changeId: ticket.metadata.changeId,
    ticketId: ticket.metadata.ticketId,
  };

  if (ticket.metadata.role === "implement") {
    const payload = implementationPayloadSchema.parse(payloadValue);
    const artifacts = await validateOutputAndDigestArtifacts(outputDirectory, payload.artifacts);
    const workerRevision = await snapshotImplementation(repository, head);
    await createOutputBundle(repository, outputDirectory, workerRevision, ticket);
    const metadata = {
      kind: "submission",
      ...identity,
      outcome: "completed",
      workerRevision,
      artifacts,
    } as const;
    await installImmutable(outputDirectory, join(outputDirectory, "submission.md"), serializeDocument(metadata, implementationBody(payload)));
    return { ...identity, role: "implement", workerRevision, artifacts };
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
  return { ...identity, role: "review", reviewedRevision: ticket.metadata.inputRevision, artifacts };
}

export async function readWorkerPayload(cwd: string, file: string | undefined, stdin: () => Promise<string>): Promise<string> {
  if (file === undefined || file === "-") return stdin();
  const path = resolve(cwd, file);
  await regularFile(path, "worker completion payload", maximumPayloadBytes);
  return readFile(path, "utf8");
}
