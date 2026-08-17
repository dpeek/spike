import { dirname, join } from "node:path";
import { z } from "zod";
import { changePath, changeStatus, loadChange } from "./change.ts";
import {
  documentExists,
  installImmutable,
  listDirectoryNames,
  readDocument,
  serializeDocument,
} from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { loadGoal } from "./goal.ts";
import { loadPlan } from "./plan.ts";
import { deriveCurrentCandidate } from "./report.ts";

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
  executionPolicy: executionPolicySchema,
});
const ticketSchema = z.discriminatedUnion("role", [
  commonTicketSchema.extend({ role: z.literal("implement") }).strict(),
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
  inputRevision?: string;
  producingImplementationTicketId?: string;
  instruction: string;
  curatedContext?: string;
  executionPolicy: ExecutionPolicy;
  now?: Date;
};

export type IssuedTicket = {
  root: string;
  ticket: Ticket;
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
    await loadTicket(root, goalId, changeId, ticketId);
    if (!(await documentExists(root, reportPath(root, goalId, changeId, ticketId)))) return ticketId;
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
  producingReport?: string,
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

${producingReport === undefined ? "" : `### Producing implementation Report\n\n${producingReport.trimEnd()}\n`}`;
}

export async function loadTicket(root: string, goalId: string, changeId: string, ticketId: string): Promise<Ticket> {
  const document = await readDocument(root, ticketPath(root, goalId, changeId, ticketId));
  const metadata = ticketSchema.parse(document.metadata);
  if (metadata.goalId !== goalId || metadata.changeId !== changeId || metadata.ticketId !== ticketId) {
    throw new Error(
      `Ticket document belongs to a different Ticket: ${metadata.goalId}/${metadata.changeId}/${metadata.ticketId}`,
    );
  }
  return { metadata, body: document.body };
}

export async function ticketStatus(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
): Promise<TicketStatus> {
  await loadTicket(root, goalId, changeId, ticketId);
  return (await documentExists(root, reportPath(root, goalId, changeId, ticketId))) ? "reported" : "open";
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
  let requestedRevision: string;
  let producingImplementationTicketId: string | undefined;
  let producingReport: string | undefined;
  if (role === "review") {
    const candidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
    if (candidate === undefined) throw new Error(`Change ${input.goalId}/${input.changeId} has no completed implementation Candidate`);
    if (input.inputRevision !== undefined && input.inputRevision !== candidate.candidateRevision) {
      throw new Error(`review Ticket must use current Candidate ${candidate.candidateRevision}`);
    }
    if (
      input.producingImplementationTicketId !== undefined &&
      input.producingImplementationTicketId !== candidate.producingImplementationTicketId
    ) {
      throw new Error(
        `review Ticket must reference producing implementation Ticket ${candidate.producingImplementationTicketId}`,
      );
    }
    requestedRevision = candidate.candidateRevision;
    producingImplementationTicketId = candidate.producingImplementationTicketId;
    producingReport = serializeDocument(candidate.report.metadata, candidate.report.body);
  } else {
    if (input.producingImplementationTicketId !== undefined) {
      throw new Error("implement Ticket must not reference a producing implementation Ticket");
    }
    requestedRevision = input.inputRevision ?? change.metadata.baseRevision;
  }
  if (!revisionPattern.test(requestedRevision)) throw new Error("Ticket input revision must be an exact commit hash");
  const inputRevision = await git(repository.root, ["rev-parse", "--verify", `${requestedRevision}^{commit}`]);
  if (inputRevision !== requestedRevision) throw new Error("Ticket input revision must identify a commit exactly");

  const ticketId = nextTicketId(await allocatedTicketIds(repository.root, input.goalId, input.changeId));
  const metadata = ticketSchema.parse({
    kind: "ticket",
    goalId: input.goalId,
    changeId: input.changeId,
    ticketId,
    issuedAt: (input.now ?? new Date()).toISOString(),
    role,
    inputRevision,
    executionPolicy: policy,
    ...(producingImplementationTicketId === undefined ? {} : { producingImplementationTicketId }),
  });
  const body = ticketBody(role, instruction, goal.body, change.body, plan.body, input.curatedContext, producingReport);

  await installImmutable(
    repository.root,
    ticketPath(repository.root, input.goalId, input.changeId, ticketId),
    serializeDocument(metadata, body),
  );
  return { root: repository.root, ticket: { metadata, body } };
}
