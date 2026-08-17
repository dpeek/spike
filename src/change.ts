import { join } from "node:path";
import { z } from "zod";
import {
  documentExists,
  installImmutable,
  listDirectoryNames,
  readDocument,
  serializeDocument,
} from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { integratedRef, loadGoal } from "./goal.ts";
import { deriveCurrentApproval, deriveCurrentCandidate, deriveCurrentRejection } from "./report.ts";

const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const sequenceIdPattern = /^(?!000)[0-9]{3}$/;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const changeSchema = z
  .object({
    kind: z.literal("change"),
    goalId: z.string().regex(goalIdPattern),
    changeId: z.string().regex(sequenceIdPattern),
    createdAt: timestamp,
    baseRevision: z.string().regex(revisionPattern),
  })
  .strict();
const decisionIdentitySchema = z.object({
  kind: z.literal("change-decision"),
  goalId: z.string().regex(goalIdPattern),
  changeId: z.string().regex(sequenceIdPattern),
  decidedAt: timestamp,
});
const changeDecisionSchema = z.discriminatedUnion("disposition", [
  decisionIdentitySchema
    .extend({
      disposition: z.literal("land"),
      approvedRevision: z.string().regex(revisionPattern),
    })
    .strict(),
  decisionIdentitySchema.extend({ disposition: z.literal("reject") }).strict(),
  decisionIdentitySchema.extend({ disposition: z.literal("abandon") }).strict(),
]);

export type Change = {
  metadata: z.infer<typeof changeSchema>;
  body: string;
};

export type ChangeDecision = {
  metadata: z.infer<typeof changeDecisionSchema>;
  body: string;
};

export type ChangeStatus = "active" | "resolved";

export type CreateChangeInput = {
  cwd: string;
  goalId: string;
  title: string;
  intent: string;
  rationale: string;
  acceptanceCriteria: string[];
  nonGoals?: string[];
  dependencies?: string[];
  now?: Date;
};

export type CreatedChange = {
  root: string;
  change: Change;
};

export type LandChangeInput = {
  cwd: string;
  goalId: string;
  changeId: string;
  statement?: string;
  now?: Date;
};

export type LandedChange = {
  root: string;
  decision: ChangeDecision;
};

export type ResolveChangeInput = {
  cwd: string;
  goalId: string;
  changeId: string;
  statement: string;
  now?: Date;
};

export type ResolvedChange = {
  root: string;
  decision: ChangeDecision;
};

function changesPath(root: string, goalId: string): string {
  return join(root, ".spike", "goals", goalId, "changes");
}

export function changePath(root: string, goalId: string, changeId: string): string {
  return join(changesPath(root, goalId), changeId, "change.md");
}

export function changeDecisionPath(root: string, goalId: string, changeId: string): string {
  return join(changesPath(root, goalId), changeId, "decision.md");
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

function requireItems(values: string[], label: string): string[] {
  return values.map((value) => requireText(value, label));
}

function list(items: string[]): string {
  return items.length === 0 ? "None." : items.map((item) => `- ${item}`).join("\n");
}

function changeBody(
  title: string,
  intent: string,
  rationale: string,
  acceptanceCriteria: string[],
  nonGoals: string[],
  dependencies: string[],
): string {
  return `# ${title}

## Intent

${intent}

## Rationale

${rationale}

## Acceptance criteria

${list(acceptanceCriteria)}

## Non-goals

${list(nonGoals)}

## Dependencies

${list(dependencies)}
`;
}

async function allocatedChangeIds(root: string, goalId: string): Promise<string[]> {
  return (await listDirectoryNames(root, changesPath(root, goalId))).filter((name) => sequenceIdPattern.test(name)).sort();
}

function nextId(ids: string[], label: string): string {
  const maximum = ids.reduce((current, id) => Math.max(current, Number(id)), 0);
  if (maximum >= 999) throw new Error(`${label} ID sequence is exhausted`);
  return String(maximum + 1).padStart(3, "0");
}

async function unresolvedChangeId(root: string, goalId: string): Promise<string | undefined> {
  for (const changeId of await allocatedChangeIds(root, goalId)) {
    if (!(await documentExists(root, changePath(root, goalId, changeId)))) continue;
    if ((await changeStatus(root, goalId, changeId)) === "active") return changeId;
  }
  return undefined;
}

export async function loadChange(root: string, goalId: string, changeId: string): Promise<Change> {
  const document = await readDocument(root, changePath(root, goalId, changeId));
  const metadata = changeSchema.parse(document.metadata);
  if (metadata.goalId !== goalId || metadata.changeId !== changeId) {
    throw new Error(`Change document belongs to a different Change: ${metadata.goalId}/${metadata.changeId}`);
  }
  return { metadata, body: document.body };
}

export async function loadChangeDecision(
  root: string,
  goalId: string,
  changeId: string,
): Promise<ChangeDecision> {
  const document = await readDocument(root, changeDecisionPath(root, goalId, changeId));
  const metadata = changeDecisionSchema.parse(document.metadata);
  if (metadata.goalId !== goalId || metadata.changeId !== changeId) {
    throw new Error(`Change decision belongs to a different Change: ${metadata.goalId}/${metadata.changeId}`);
  }
  if (!document.body.trim()) throw new Error(`Change decision ${goalId}/${changeId} must contain a statement`);
  return { metadata, body: document.body };
}

export async function loadChangeDecisionIfPresent(
  root: string,
  goalId: string,
  changeId: string,
): Promise<ChangeDecision | undefined> {
  if (!(await documentExists(root, changeDecisionPath(root, goalId, changeId)))) return undefined;
  return loadChangeDecision(root, goalId, changeId);
}

export async function changeStatus(root: string, goalId: string, changeId: string): Promise<ChangeStatus> {
  await loadChange(root, goalId, changeId);
  return (await loadChangeDecisionIfPresent(root, goalId, changeId)) === undefined ? "active" : "resolved";
}

export async function landChange(input: LandChangeInput): Promise<LandedChange> {
  const repository = await discoverRepository(input.cwd);
  const decisionDocumentPath = changeDecisionPath(repository.root, input.goalId, input.changeId);
  if (await documentExists(repository.root, decisionDocumentPath)) {
    throw new Error(`Change ${input.goalId}/${input.changeId} already has a terminal decision`);
  }

  await loadGoal(repository.root, input.goalId);
  const change = await loadChange(repository.root, input.goalId, input.changeId);
  const candidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
  if (candidate === undefined) {
    throw new Error(`Change ${input.goalId}/${input.changeId} has no completed implementation Candidate`);
  }
  const approval = await deriveCurrentApproval(repository.root, input.goalId, input.changeId);
  if (approval === undefined) {
    throw new Error(`current Candidate ${candidate.candidateRevision} has no exact approve review Report`);
  }
  if (
    approval.candidateRevision !== candidate.candidateRevision ||
    approval.producingImplementationTicketId !== candidate.producingImplementationTicketId ||
    approval.reviewReport.metadata.reviewedRevision !== candidate.candidateRevision ||
    approval.reviewReport.metadata.producingImplementationTicketId !== candidate.producingImplementationTicketId
  ) {
    throw new Error("approve review Report does not select the current Candidate and its producing implementation Ticket");
  }
  if (candidate.report.metadata.baseRevision !== change.metadata.baseRevision) {
    throw new Error("current Candidate implementation Report does not match the Change base revision");
  }

  const ref = integratedRef(input.goalId);
  const integratedRevision = await git(repository.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  let symbolicTarget: string | undefined;
  try {
    symbolicTarget = await git(repository.root, ["symbolic-ref", "-q", ref]);
  } catch {
    // A direct ref is required and makes symbolic-ref exit non-zero.
  }
  if (symbolicTarget !== undefined) {
    throw new Error(`Goal integration ref must be direct, not symbolic to ${symbolicTarget}`);
  }
  if (integratedRevision !== change.metadata.baseRevision) {
    throw new Error(
      `Change base ${change.metadata.baseRevision} does not equal Goal integrated revision ${integratedRevision}`,
    );
  }

  const commit = (await git(repository.root, ["rev-list", "--parents", "-n", "1", candidate.candidateRevision])).split(
    /\s+/,
  );
  if (
    commit.length !== 2 ||
    commit[0] !== candidate.candidateRevision ||
    commit[1] !== change.metadata.baseRevision
  ) {
    throw new Error("approved Candidate must be one commit directly on the Change base revision");
  }

  const metadata = changeDecisionSchema.parse({
    kind: "change-decision",
    goalId: input.goalId,
    changeId: input.changeId,
    decidedAt: (input.now ?? new Date()).toISOString(),
    disposition: "land",
    approvedRevision: candidate.candidateRevision,
  });
  const body =
    input.statement === undefined
      ? `# Land Change\n\nCandidate \`${candidate.candidateRevision}\` was approved by review Ticket ${approval.reviewTicketId}.\n`
      : `${requireText(input.statement, "Change decision statement")}\n`;
  const decision = { metadata, body };

  await installImmutable(repository.root, decisionDocumentPath, serializeDocument(metadata, body));
  await git(repository.root, ["update-ref", "--no-deref", ref, candidate.candidateRevision, change.metadata.baseRevision]);
  return { root: repository.root, decision };
}

async function resolveChangeWithoutLanding(
  input: ResolveChangeInput,
  disposition: "reject" | "abandon",
): Promise<ResolvedChange> {
  const repository = await discoverRepository(input.cwd);
  const decisionDocumentPath = changeDecisionPath(repository.root, input.goalId, input.changeId);
  if (await documentExists(repository.root, decisionDocumentPath)) {
    throw new Error(`Change ${input.goalId}/${input.changeId} already has a terminal decision`);
  }

  await loadGoal(repository.root, input.goalId);
  await loadChange(repository.root, input.goalId, input.changeId);
  const statement = requireText(input.statement, "Change decision statement");

  if (disposition === "reject") {
    const candidate = await deriveCurrentCandidate(repository.root, input.goalId, input.changeId);
    if (candidate === undefined) {
      throw new Error(`Change ${input.goalId}/${input.changeId} has no completed implementation Candidate`);
    }
    const rejection = await deriveCurrentRejection(repository.root, input.goalId, input.changeId);
    if (rejection === undefined) {
      throw new Error(`current Candidate ${candidate.candidateRevision} has no exact reject review Report`);
    }
    if (
      rejection.candidateRevision !== candidate.candidateRevision ||
      rejection.producingImplementationTicketId !== candidate.producingImplementationTicketId ||
      rejection.reviewReport.metadata.reviewedRevision !== candidate.candidateRevision ||
      rejection.reviewReport.metadata.producingImplementationTicketId !== candidate.producingImplementationTicketId
    ) {
      throw new Error("reject review Report does not select the current Candidate and its producing implementation Ticket");
    }
  }

  const metadata = changeDecisionSchema.parse({
    kind: "change-decision",
    goalId: input.goalId,
    changeId: input.changeId,
    decidedAt: (input.now ?? new Date()).toISOString(),
    disposition,
  });
  const decision = { metadata, body: `${statement}\n` };
  await installImmutable(repository.root, decisionDocumentPath, serializeDocument(metadata, decision.body));
  return { root: repository.root, decision };
}

export function rejectChange(input: ResolveChangeInput): Promise<ResolvedChange> {
  return resolveChangeWithoutLanding(input, "reject");
}

export function abandonChange(input: ResolveChangeInput): Promise<ResolvedChange> {
  return resolveChangeWithoutLanding(input, "abandon");
}

export async function createChange(input: CreateChangeInput): Promise<CreatedChange> {
  const repository = await discoverRepository(input.cwd);
  await loadGoal(repository.root, input.goalId);

  const activeChangeId = await unresolvedChangeId(repository.root, input.goalId);
  if (activeChangeId !== undefined) {
    throw new Error(`Goal ${input.goalId} already has unresolved Change ${activeChangeId}`);
  }

  const title = requireText(input.title, "Change title");
  const intent = requireText(input.intent, "Change intent");
  const rationale = requireText(input.rationale, "Change rationale");
  const acceptanceCriteria = requireItems(input.acceptanceCriteria, "Acceptance criterion");
  if (acceptanceCriteria.length === 0) throw new Error("Change must have at least one acceptance criterion");
  const nonGoals = requireItems(input.nonGoals ?? [], "Non-goal");
  const dependencies = requireItems(input.dependencies ?? [], "Dependency");
  const changeId = nextId(await allocatedChangeIds(repository.root, input.goalId), "Change");
  const baseRevision = await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]);
  const metadata = changeSchema.parse({
    kind: "change",
    goalId: input.goalId,
    changeId,
    createdAt: (input.now ?? new Date()).toISOString(),
    baseRevision,
  });
  const body = changeBody(title, intent, rationale, acceptanceCriteria, nonGoals, dependencies);

  await installImmutable(
    repository.root,
    changePath(repository.root, input.goalId, changeId),
    serializeDocument(metadata, body),
  );
  return { root: repository.root, change: { metadata, body } };
}
