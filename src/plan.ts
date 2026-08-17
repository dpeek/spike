import { join } from "node:path";
import { z } from "zod";
import { installImmutable, readDocument, replaceAtomic, serializeDocument } from "./durable-state.ts";

const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const planSchema = z
  .object({
    kind: z.literal("plan"),
    goalId: z.string().regex(goalIdPattern),
    updatedAt: timestamp,
  })
  .strict();

export type Plan = {
  metadata: z.infer<typeof planSchema>;
  body: string;
};

export function planPath(root: string, goalId: string): string {
  return join(root, ".spike", "goals", goalId, "plan.md");
}

function initialBody(title: string, outcome: string): string {
  return `# Plan: ${title}

## Goal summary

${outcome}

## Planned Changes

No Changes planned yet.

## Current focus

Identify the first Change.

## Planned next Tickets

No Tickets planned yet.

## Progress

Goal approved; no Changes landed.

## Decisions and changed assumptions

None.

## Open findings

None.

## Churn indicators

None.

## Deferred improvements

None.`;
}

export async function createInitialPlan(
  root: string,
  goalId: string,
  title: string,
  outcome: string,
  now: string,
): Promise<Plan> {
  const metadata = planSchema.parse({ kind: "plan", goalId, updatedAt: now });
  const body = `${initialBody(title, outcome)}\n`;
  await installImmutable(root, planPath(root, goalId), serializeDocument(metadata, body));
  return { metadata, body };
}

export async function loadPlan(root: string, goalId: string): Promise<Plan> {
  const document = await readDocument(root, planPath(root, goalId));
  const metadata = planSchema.parse(document.metadata);
  if (metadata.goalId !== goalId) throw new Error(`Plan belongs to a different Goal: ${metadata.goalId}`);
  return { metadata, body: document.body };
}

export async function revisePlan(root: string, goalId: string, body: string, now = new Date().toISOString()): Promise<Plan> {
  if (!body.trim()) throw new Error("Plan body must not be blank");
  const current = await loadPlan(root, goalId);
  const metadata = planSchema.parse({ ...current.metadata, updatedAt: now });
  const revisedBody = `${body.trimEnd()}\n`;
  await replaceAtomic(root, planPath(root, goalId), serializeDocument(metadata, revisedBody));
  return { metadata, body: revisedBody };
}
