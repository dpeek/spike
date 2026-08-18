import { dirname, join } from "node:path";
import { z } from "zod";
import { changePath, changeStatus, loadChange } from "./change.ts";
import { commitCrashHooks, type CrashInjector } from "./crash.ts";
import {
  resolveTicketModelSelection,
  type ModelSelection,
  type ThinkingLevel,
} from "./config.ts";
import {
  documentExists,
  installImmutable,
  listDirectoryNames,
  readDocument,
  serializeDocument,
  type MarkdownDocument,
} from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { loadGoal } from "./goal.ts";
import { loadPlan } from "./plan.ts";
import { deriveCurrentCandidate, deriveCurrentReview, loadReportIfPresent } from "./report.ts";

const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const sequenceIdPattern = /^(?!000)[0-9]{3}$/;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const executionPolicySchema = z
  .object({
    isolation: z.enum(["workspace", "container"]),
    networkAccess: z.enum(["none", "restricted", "unrestricted"]),
    credentialGrants: z.array(z.string().min(1)),
  })
  .strict();
const commonTicketSchema = z.object({
  kind: z.literal("ticket"),
  goalId: z.string().regex(goalIdPattern),
  changeId: z.string().regex(sequenceIdPattern),
  ticketId: z.string().regex(sequenceIdPattern),
  issuedAt: timestamp,
  inputRevision: z.string().regex(revisionPattern),
  replacesTicketId: z.string().regex(sequenceIdPattern).optional(),
  model: z.string().trim().min(1),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  executionPolicy: executionPolicySchema,
});
const ticketSchema = z.discriminatedUnion("role", [
  commonTicketSchema
    .extend({
      role: z.literal("implement"),
      responseToReviewTicketId: z.string().regex(sequenceIdPattern).optional(),
    })
    .strict(),
  commonTicketSchema
    .extend({
      role: z.literal("review"),
      producingImplementationTicketId: z.string().regex(sequenceIdPattern),
    })
    .strict(),
]);

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export type Ticket = {
  metadata: z.infer<typeof ticketSchema>;
  body: string;
};

export type TicketStatus = "open" | "reported";

export type IssueTicketInput = {
  cwd: string;
  goalId: string;
  changeId: string;
  role?: "implement" | "review";
  producingImplementationTicketId?: string;
  responseToReviewTicketId?: string;
  instruction: string;
  curatedContext?: string;
  executionPolicy: ExecutionPolicy;
  model?: string;
  thinking?: ThinkingLevel;
  now?: Date;
  crash?: CrashInjector;
};

export type IssuedTicket = {
  root: string;
  ticket: Ticket;
};

export type IssueReplacementTicketInput = {
  cwd: string;
  goalId: string;
  changeId: string;
  interruptedTicketId: string;
  now?: Date;
  crash?: CrashInjector;
};

function ticketsPath(root: string, goalId: string, changeId: string): string {
  return join(dirname(changePath(root, goalId, changeId)), "tickets");
}

export function ticketPath(root: string, goalId: string, changeId: string, ticketId: string): string {
  return join(ticketsPath(root, goalId, changeId), ticketId, "ticket.md");
}

export function reportPath(root: string, goalId: string, changeId: string, ticketId: string): string {
  return join(ticketsPath(root, goalId, changeId), ticketId, "report.md");
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

async function allocatedTicketIds(root: string, goalId: string, changeId: string): Promise<string[]> {
  return (await listDirectoryNames(root, ticketsPath(root, goalId, changeId)))
    .filter((name) => sequenceIdPattern.test(name))
    .sort();
}

function nextTicketId(ids: string[]): string {
  const maximum = ids.reduce((current, id) => Math.max(current, Number(id)), 0);
  if (maximum >= 999) throw new Error("Ticket ID sequence is exhausted");
  return String(maximum + 1).padStart(3, "0");
}

async function openTicketId(root: string, goalId: string, changeId: string): Promise<string | undefined> {
  for (const ticketId of await allocatedTicketIds(root, goalId, changeId)) {
    if (!(await documentExists(root, ticketPath(root, goalId, changeId, ticketId)))) continue;
    if ((await ticketStatus(root, goalId, changeId, ticketId)) === "open") return ticketId;
  }
  return undefined;
}

function ticketBody(
  role: "implement" | "review",
  instruction: string,
  goalBody: string,
  changeBody: string,
  planBody: string,
  context?: string,
  relevantReport?: { heading: string; document: string },
): string {
  return `# ${role === "implement" ? "Implement Change" : "Review Candidate"}

## Instruction

${instruction}

## Curated context

### Goal

${goalBody.trimEnd()}

### Change

${changeBody.trimEnd()}

### Current Plan

${planBody.trimEnd()}

### Planner-selected context

${context === undefined || !context.trim() ? "None." : context.trim()}

${relevantReport === undefined ? "" : `### ${relevantReport.heading}\n\n${relevantReport.document.trimEnd()}\n`}`;
}

export async function listTicketIds(root: string, goalId: string, changeId: string): Promise<string[]> {
  const ticketIds = await allocatedTicketIds(root, goalId, changeId);
  const published: string[] = [];
  for (const ticketId of ticketIds) {
    if (!(await documentExists(root, ticketPath(root, goalId, changeId, ticketId)))) continue;
    await loadTicket(root, goalId, changeId, ticketId);
    published.push(ticketId);
  }
  return published;
}

export function parseTicketDocument(document: MarkdownDocument): Ticket {
  return { metadata: ticketSchema.parse(document.metadata), body: document.body };
}

export async function loadTicketDocument(root: string, path: string): Promise<Ticket> {
  return parseTicketDocument(await readDocument(root, path));
}

export async function loadTicket(root: string, goalId: string, changeId: string, ticketId: string): Promise<Ticket> {
  const ticket = await loadTicketDocument(root, ticketPath(root, goalId, changeId, ticketId));
  const { metadata } = ticket;
  if (metadata.goalId !== goalId || metadata.changeId !== changeId || metadata.ticketId !== ticketId) {
    throw new Error(
      `Ticket document belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`,
    );
  }
  return ticket;
}

export async function ticketStatus(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
): Promise<TicketStatus> {
  await loadTicket(root, goalId, changeId, ticketId);
  return (await loadReportIfPresent(root, goalId, changeId, ticketId)) === undefined ? "open" : "reported";
}

export async function loadOpenTicket(
  root: string,
  goalId: string,
  changeId: string,
): Promise<Ticket | undefined> {
  const ticketId = await openTicketId(root, goalId, changeId);
  return ticketId === undefined ? undefined : loadTicket(root, goalId, changeId, ticketId);
}

export async function loadReplacementTicketIfPresent(
  root: string,
  goalId: string,
  changeId: string,
  interruptedTicketId: string,
): Promise<Ticket | undefined> {
  let replacement: Ticket | undefined;
  for (const ticketId of await allocatedTicketIds(root, goalId, changeId)) {
    if (!(await documentExists(root, ticketPath(root, goalId, changeId, ticketId)))) continue;
    const ticket = await loadTicket(root, goalId, changeId, ticketId);
    if (ticket.metadata.replacesTicketId !== interruptedTicketId) continue;
    if (replacement !== undefined) {
      throw new Error(`Ticket ${goalId}/${changeId}/${interruptedTicketId} has more than one replacement`);
    }
    replacement = ticket;
  }
  return replacement;
}

export async function issueReplacementTicket(input: IssueReplacementTicketInput): Promise<IssuedTicket> {
  const repository = await discoverRepository(input.cwd);
  const [change, interrupted] = await Promise.all([
    loadChange(repository.root, input.goalId, input.changeId),
    loadTicket(repository.root, input.goalId, input.changeId, input.interruptedTicketId),
  ]);
  if ((await changeStatus(repository.root, input.goalId, input.changeId)) === "resolved") {
    throw new Error(`Change ${input.goalId}/${input.changeId} is resolved`);
  }
  const interruptedReport = await loadReportIfPresent(
    repository.root,
    input.goalId,
    input.changeId,
    input.interruptedTicketId,
  );
  if (interruptedReport === undefined) {
    throw new Error(`Ticket ${input.goalId}/${input.changeId}/${input.interruptedTicketId} is still open`);
  }
  if (interruptedReport.metadata.outcome !== "interrupted") {
    throw new Error(`Ticket ${input.goalId}/${input.changeId}/${input.interruptedTicketId} was not interrupted`);
  }

  const candidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
  const inputRevision = candidate?.candidateRevision ?? change.metadata.baseRevision;
  if (interrupted.metadata.inputRevision !== inputRevision) {
    throw new Error("interrupted Ticket does not start from the latest committed Candidate or Change base");
  }
  if (interrupted.metadata.role === "review") {
    if (
      candidate === undefined ||
      interrupted.metadata.producingImplementationTicketId !== candidate.producingImplementationTicketId
    ) {
      throw new Error("interrupted review Ticket does not select the latest committed Candidate");
    }
  } else if (candidate !== undefined) {
    const responseToReview = await deriveCurrentReview(repository.root, input.goalId, input.changeId);
    if (
      responseToReview === undefined ||
      responseToReview.reviewReport.metadata.verdict === "approve" ||
      interrupted.metadata.responseToReviewTicketId !== responseToReview.reviewTicketId ||
      responseToReview.candidateRevision !== inputRevision
    ) {
      throw new Error("interrupted implementation Ticket does not select the latest committed review context");
    }
  }

  const existing = await loadReplacementTicketIfPresent(
    repository.root,
    input.goalId,
    input.changeId,
    input.interruptedTicketId,
  );
  if (existing !== undefined) {
    if (
      existing.metadata.role !== interrupted.metadata.role ||
      existing.metadata.inputRevision !== inputRevision ||
      JSON.stringify(existing.metadata.executionPolicy) !== JSON.stringify(interrupted.metadata.executionPolicy) ||
      existing.body !== interrupted.body
    ) {
      throw new Error("existing replacement Ticket does not reproduce the interrupted assignment");
    }
    if (
      existing.metadata.role === "review" &&
      (interrupted.metadata.role !== "review" ||
        existing.metadata.producingImplementationTicketId !== interrupted.metadata.producingImplementationTicketId)
    ) {
      throw new Error("existing replacement review Ticket selects different implementation provenance");
    }
    if (
      existing.metadata.role === "implement" &&
      (interrupted.metadata.role !== "implement" ||
        existing.metadata.responseToReviewTicketId !== interrupted.metadata.responseToReviewTicketId)
    ) {
      throw new Error("existing replacement implementation Ticket selects different review provenance");
    }
    return { root: repository.root, ticket: existing };
  }

  const currentOpenTicket = await openTicketId(repository.root, input.goalId, input.changeId);
  if (currentOpenTicket !== undefined) {
    throw new Error(`Change ${input.goalId}/${input.changeId} already has open Ticket ${currentOpenTicket}`);
  }
  const ticketId = nextTicketId(await allocatedTicketIds(repository.root, input.goalId, input.changeId));
  const metadata = ticketSchema.parse({
    ...interrupted.metadata,
    ticketId,
    issuedAt: (input.now ?? new Date()).toISOString(),
    inputRevision,
    replacesTicketId: input.interruptedTicketId,
  });
  await installImmutable(
    repository.root,
    ticketPath(repository.root, input.goalId, input.changeId, ticketId),
    serializeDocument(metadata, interrupted.body),
    commitCrashHooks(input.crash, "ticket-issuance"),
  );
  return { root: repository.root, ticket: { metadata, body: interrupted.body } };
}

export async function issueTicket(input: IssueTicketInput): Promise<IssuedTicket> {
  const repository = await discoverRepository(input.cwd);
  const [goal, change, plan] = await Promise.all([
    loadGoal(repository.root, input.goalId),
    loadChange(repository.root, input.goalId, input.changeId),
    loadPlan(repository.root, input.goalId),
  ]);

  if ((await changeStatus(repository.root, input.goalId, input.changeId)) === "resolved") {
    throw new Error(`Change ${input.goalId}/${input.changeId} is resolved`);
  }
  const currentOpenTicket = await openTicketId(repository.root, input.goalId, input.changeId);
  if (currentOpenTicket !== undefined) {
    throw new Error(`Change ${input.goalId}/${input.changeId} already has open Ticket ${currentOpenTicket}`);
  }

  const instruction = requireText(input.instruction, "Ticket instruction");
  const policy = executionPolicySchema.parse({
    ...input.executionPolicy,
    credentialGrants: input.executionPolicy.credentialGrants.map((grant) => requireText(grant, "Credential grant")),
  });
  const role = input.role ?? "implement";
  const modelSelection: ModelSelection = await resolveTicketModelSelection(repository.root, role, {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
  });
  let derivedRevision: string;
  let producingImplementationTicketId: string | undefined;
  let responseToReviewTicketId: string | undefined;
  let relevantReport: { heading: string; document: string } | undefined;
  if (role === "review") {
    const candidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
    if (candidate === undefined) throw new Error(`Change ${input.goalId}/${input.changeId} has no completed implementation Candidate`);
    if (
      input.producingImplementationTicketId !== undefined &&
      input.producingImplementationTicketId !== candidate.producingImplementationTicketId
    ) {
      throw new Error(
        `review Ticket must reference producing implementation Ticket ${candidate.producingImplementationTicketId}`,
      );
    }
    derivedRevision = candidate.candidateRevision;
    if (input.responseToReviewTicketId !== undefined) {
      throw new Error("review Ticket must not reference a prior review Ticket");
    }
    producingImplementationTicketId = candidate.producingImplementationTicketId;
    relevantReport = {
      heading: "Producing implementation Report",
      document: serializeDocument(candidate.report.metadata, candidate.report.body),
    };
  } else {
    if (input.producingImplementationTicketId !== undefined) {
      throw new Error("implement Ticket must not reference a producing implementation Ticket");
    }
    const candidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
    if (candidate === undefined) {
      if (input.responseToReviewTicketId !== undefined) {
        throw new Error("initial implement Ticket must not reference a prior review Ticket");
      }
      derivedRevision = change.metadata.baseRevision;
    } else {
      const responseToReview = await deriveCurrentReview(repository.root, input.goalId, input.changeId);
      if (responseToReview === undefined) {
        throw new Error(`current Candidate ${candidate.candidateRevision} has no exact review Report`);
      }
      if (responseToReview.reviewReport.metadata.verdict === "approve") {
        throw new Error(`current Candidate ${candidate.candidateRevision} is already approved`);
      }
      if (
        input.responseToReviewTicketId !== undefined &&
        input.responseToReviewTicketId !== responseToReview.reviewTicketId
      ) {
        throw new Error(`implementation Ticket must respond to review Ticket ${responseToReview.reviewTicketId}`);
      }
      derivedRevision = responseToReview.candidateRevision;
      responseToReviewTicketId = responseToReview.reviewTicketId;
      relevantReport = {
        heading: "Review Report being addressed",
        document: serializeDocument(responseToReview.reviewReport.metadata, responseToReview.reviewReport.body),
      };
    }
  }
  if (!revisionPattern.test(derivedRevision)) throw new Error("Ticket input revision must be an exact commit hash");
  const inputRevision = await git(repository.root, ["rev-parse", "--verify", `${derivedRevision}^{commit}`]);
  if (inputRevision !== derivedRevision) throw new Error("Ticket input revision must identify a commit exactly");

  const ticketId = nextTicketId(await allocatedTicketIds(repository.root, input.goalId, input.changeId));
  const metadata = ticketSchema.parse({
    kind: "ticket",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId,
    issuedAt: (input.now ?? new Date()).toISOString(),
    role,
    inputRevision,
    model: modelSelection.model,
    thinking: modelSelection.thinking,
    executionPolicy: policy,
    ...(producingImplementationTicketId === undefined ? {} : { producingImplementationTicketId }),
    ...(responseToReviewTicketId === undefined ? {} : { responseToReviewTicketId }),
  });
  const body = ticketBody(role, instruction, goal.body, change.body, plan.body, input.curatedContext, relevantReport);

  await installImmutable(
    repository.root,
    ticketPath(repository.root, input.goalId, input.changeId, ticketId),
    serializeDocument(metadata, body),
    commitCrashHooks(input.crash, "ticket-issuance"),
  );
  return { root: repository.root, ticket: { metadata, body } };
}
