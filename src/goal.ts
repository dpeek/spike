import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { commitCrashHooks, type CrashInjector } from "./crash.ts";
import {
  documentExists,
  installImmutable,
  listDirectoryNames,
  readDocument,
  serializeDocument,
} from "./durable-state.ts";
import { discoverRepository, git } from "./git.ts";
import { createInitialPlan, type Plan } from "./plan.ts";

const goalIdPattern = /^goal-[0-9a-f]{32}$/;
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

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  return normalized;
}

function goalBody(title: string, outcome: string, approval: string, constraints: string[]): string {
  const constraintList = constraints.length > 0 ? constraints.map((constraint) => `- ${constraint}`).join("\n") : "None.";
  return `# ${title}

## Outcome

${outcome}

## Constraints

${constraintList}

## Operator approval

${approval}
`;
}

export async function createGoal(input: CreateGoalInput): Promise<CreatedGoal> {
  const title = requireText(input.title, "Goal title");
  const outcome = requireText(input.outcome, "Goal outcome");
  const approval = requireText(input.approval, "Operator approval");
  const constraints = (input.constraints ?? []).map((constraint) => requireText(constraint, "Constraint"));
  const repository = await discoverRepository(input.cwd);
  const goalId = `goal-${randomBytes(16).toString("hex")}`;
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
  const body = goalBody(title, outcome, approval, constraints);

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

export async function listGoalIds(root: string): Promise<string[]> {
  const goals = join(root, ".spike", "goals");
  const goalIds = (await listDirectoryNames(root, goals)).filter((name) => goalIdPattern.test(name)).sort();
  const published: string[] = [];
  for (const goalId of goalIds) {
    if (!(await documentExists(root, goalPath(root, goalId)))) continue;
    await loadGoal(root, goalId);
    published.push(goalId);
  }
  return published;
}

export async function loadGoal(root: string, goalId: string): Promise<Goal> {
  const document = await readDocument(root, goalPath(root, goalId));
  const metadata = goalSchema.parse(document.metadata);
  if (metadata.goalId !== goalId) throw new Error(`Goal document belongs to a different Goal: ${metadata.goalId}`);
  return { metadata, body: document.body };
}
