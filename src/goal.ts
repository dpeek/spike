import { join } from "node:path";
import { z } from "zod";
import { commitCrashHooks, type CrashInjector } from "./crash.ts";
import { assertGoalBelongsToProject, loadProjectConfig } from "./config.ts";
import {
  documentExists,
  installImmutable,
  listDirectoryNames,
  readDocument,
  serializeDocument,
} from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { formatGoalId, goalIdPattern, goalSequence } from "./identity.ts";
import { createInitialPlan, type Plan } from "./plan.ts";
import { loadRequest, requestDataRoot } from "./request.ts";

const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const goalSchema = z
  .object({
    kind: z.literal("goal"),
    goalId: z.string().regex(goalIdPattern),
    approvedAt: timestamp,
    repository: z
      .object({
        identity: z.string().min(1),
        initialRevision: z.string().regex(revisionPattern),
      })
      .strict(),
  })
  .strict();

export type Goal = {
  metadata: z.infer<typeof goalSchema>;
  body: string;
};

export type CreatedGoal = {
  root: string;
  goal: Goal;
  plan: Plan;
};

export type CreateGoalInput = {
  cwd: string;
  title: string;
  outcome: string;
  approval: string;
  constraints?: string[];
  sourceRequests?: string[];
  repositoryIdentity?: string;
  now?: Date;
  crash?: CrashInjector;
};

export function goalPath(root: string, goalId: string): string {
  return join(root, ".spike", "goals", goalId, "goal.md");
}

export function integratedRef(goalId: string): string {
  if (!goalIdPattern.test(goalId)) throw new Error(`invalid Goal ID: ${goalId}`);
  return `refs/spike/goals/${goalId}/integrated`;
}

async function allocatedGoalIdsForProject(root: string, projectSlug: string): Promise<string[]> {
  const names = await listDirectoryNames(root, join(root, ".spike", "goals"));
  const foreignGoalId = names.find((name) => goalIdPattern.test(name) && goalSequence(name, projectSlug) === undefined);
  if (foreignGoalId !== undefined) {
    throw new Error(`Goal ${foreignGoalId} does not belong to Project ${projectSlug}`);
  }
  return names.filter((name) => goalSequence(name, projectSlug) !== undefined).sort();
}

async function nextGoalId(root: string, projectSlug: string): Promise<string> {
  const allocated = await allocatedGoalIdsForProject(root, projectSlug);
  const highest = allocated.reduce((maximum, goalId) => Math.max(maximum, goalSequence(goalId, projectSlug)!), 0);
  if (highest === 999) throw new Error(`Project ${projectSlug} has exhausted its three-digit Goal sequence`);
  return formatGoalId(projectSlug, highest + 1);
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

function goalBody(title: string, outcome: string, approval: string, constraints: string[], sourceRequests: string[]): string {
  const constraintList = constraints.length > 0 ? constraints.map((constraint) => `- ${constraint}`).join("\n") : "None.";
  const sourceRequestList = sourceRequests.length > 0 ? sourceRequests.map((requestId) => `- ${requestId}`).join("\n") : "None.";
  return `# ${title}

## Outcome

${outcome}

## Constraints

${constraintList}

## Source Requests

${sourceRequestList}

## Operator approval

${approval}
`;
}

/** Validate host-local provenance before any Goal workflow document is staged. */
async function validateSourceRequests(sourceRequests: unknown, projectSlug: string): Promise<string[]> {
  if (!Array.isArray(sourceRequests)) throw new Error("Source Requests must be an array");
  const requestIds: string[] = [];
  for (const requestId of sourceRequests) {
    if (typeof requestId !== "string") throw new Error("Source Request ID must be a string");
    if (new Set(requestIds).has(requestId)) throw new Error(`duplicate Source Request ID: ${requestId}`);
    requestIds.push(requestId);
  }
  // Zero-source Goals preserve the pre-Request-inbox workflow and must not
  // consult host Request-store configuration.
  if (requestIds.length === 0) return requestIds;
  const root = requestDataRoot();
  const requests = await Promise.all(requestIds.map((requestId) => loadRequest(root, requestId)));
  for (const request of requests) {
    const projects = request.metadata.projects;
    if (projects.length > 0 && !projects.includes(projectSlug)) {
      throw new Error(`Source Request ${request.metadata.requestId} is not eligible for Project ${projectSlug}`);
    }
  }
  return requestIds;
}

export async function createGoal(input: CreateGoalInput): Promise<CreatedGoal> {
  const title = requireText(input.title, "Goal title");
  const outcome = requireText(input.outcome, "Goal outcome");
  const approval = requireText(input.approval, "Operator approval");
  const constraints = (input.constraints ?? []).map((constraint) => requireText(constraint, "Constraint"));
  const repository = await discoverRepository(input.cwd);
  const { slug } = (await loadProjectConfig(repository.root)).project;
  // This is deliberately before allocation, Plan staging, Goal publication, and ref creation.
  const sourceRequests = await validateSourceRequests(input.sourceRequests ?? [], slug);
  const goalId = await nextGoalId(repository.root, slug);
  const approvedAt = (input.now ?? new Date()).toISOString();
  const metadata = goalSchema.parse({
    kind: "goal",
    goalId,
    approvedAt,
    repository: {
      identity:
        input.repositoryIdentity === undefined
          ? repository.identity
          : requireText(input.repositoryIdentity, "Repository identity"),
      initialRevision: repository.head,
    },
  });
  const body = goalBody(title, outcome, approval, constraints, sourceRequests);

  // The Goal document is the authoritative commit point. The Plan prepared
  // before it is staging; the integration ref written after it is rebuildable.
  const plan = await createInitialPlan(repository.root, goalId, title, outcome, approvedAt);
  await installImmutable(
    repository.root,
    goalPath(repository.root, goalId),
    serializeDocument(metadata, body),
    commitCrashHooks(input.crash, "goal-publication"),
  );
  await git(repository.root, ["update-ref", integratedRef(goalId), repository.head]);

  return { root: repository.root, goal: { metadata, body }, plan };
}

export async function listAllocatedGoalIds(root: string): Promise<string[]> {
  const { slug } = (await loadProjectConfig(root)).project;
  return allocatedGoalIdsForProject(root, slug);
}

export async function listGoalIds(root: string): Promise<string[]> {
  const goalIds = await listAllocatedGoalIds(root);
  const published: string[] = [];
  for (const goalId of goalIds) {
    if (!(await documentExists(root, goalPath(root, goalId)))) continue;
    await loadGoal(root, goalId);
    published.push(goalId);
  }
  return published;
}

export async function loadGoal(root: string, goalId: string): Promise<Goal> {
  await assertGoalBelongsToProject(root, goalId);
  const document = await readDocument(root, goalPath(root, goalId));
  const metadata = goalSchema.parse(document.metadata);
  if (metadata.goalId !== goalId) throw new Error(`Goal document belongs to a different Goal: ${metadata.goalId}`);
  return { metadata, body: document.body };
}
