import { join } from "node:path";
import { z } from "zod";
import { assertGoalBelongsToProject } from "./config.ts";
import { installImmutable, readDocument, replaceAtomic, serializeDocument } from "./durable-state.ts";
import { goalIdPattern, sequenceIdPattern } from "./identity.ts";
import { loadChangeReportHistory, type ChangeReportHistory } from "./report.ts";

const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const changePlanSchema = z
  .object({
    changeId: z.string().regex(sequenceIdPattern),
    plannedTicketCount: z.number().int().positive(),
  })
  .strict();
const planSchema = z
  .object({
    kind: z.literal("plan"),
    goalId: z.string().regex(goalIdPattern),
    updatedAt: timestamp,
    changePlans: z.array(changePlanSchema),
  })
  .strict();

export type Plan = {
  metadata: z.infer<typeof planSchema>;
  body: string;
};

export type ChurnIndicator =
  | { kind: "ticket-count"; planned: number; actual: number }
  | { kind: "remediation-rounds"; count: number }
  | { kind: "reopened-finding"; findingId: string; reportCount: number }
  | {
      kind: "consecutive-non-progress";
      ticketIds: [string, string];
      outcomes: ["partial" | "blocked", "partial" | "blocked"];
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
  const metadata = planSchema.parse({ kind: "plan", goalId, updatedAt: now, changePlans: [] });
  const body = `${initialBody(title, outcome)}\n`;
  await installImmutable(root, planPath(root, goalId), serializeDocument(metadata, body));
  return { metadata, body };
}

export async function loadPlan(root: string, goalId: string): Promise<Plan> {
  await assertGoalBelongsToProject(root, goalId);
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

export async function setPlannedTicketCount(
  root: string,
  goalId: string,
  changeId: string,
  plannedTicketCount: number,
  now = new Date().toISOString(),
): Promise<Plan> {
  const planned = changePlanSchema.parse({ changeId, plannedTicketCount });
  const current = await loadPlan(root, goalId);
  const changePlans = current.metadata.changePlans
    .filter((entry) => entry.changeId !== changeId)
    .concat(planned)
    .sort((left, right) => left.changeId.localeCompare(right.changeId));
  const metadata = planSchema.parse({ ...current.metadata, updatedAt: now, changePlans });
  await replaceAtomic(root, planPath(root, goalId), serializeDocument(metadata, current.body));
  return { metadata, body: current.body };
}

export function detectChangeChurn(
  plannedTicketCount: number,
  history: ChangeReportHistory,
): ChurnIndicator[] {
  if (!Number.isInteger(plannedTicketCount) || plannedTicketCount < 1) {
    throw new Error("planned Ticket count must be a positive integer");
  }
  if (!Number.isInteger(history.ticketCount) || history.ticketCount < 0) {
    throw new Error("actual Ticket count must be a non-negative integer");
  }

  const indicators: ChurnIndicator[] = [];
  if (history.ticketCount > plannedTicketCount + 2) {
    indicators.push({ kind: "ticket-count", planned: plannedTicketCount, actual: history.ticketCount });
  }

  const remediationReports = history.reports.filter(
    (report) => report.role === "review" && report.outcome === "completed" && report.verdict === "remediate",
  );
  if (remediationReports.length >= 3) {
    indicators.push({ kind: "remediation-rounds", count: remediationReports.length });
  }

  const findingCounts = new Map<string, number>();
  for (const report of history.reports) {
    if (report.role !== "review" || report.outcome !== "completed") continue;
    for (const findingId of new Set(report.findingIds)) {
      findingCounts.set(findingId, (findingCounts.get(findingId) ?? 0) + 1);
    }
  }
  for (const [findingId, reportCount] of [...findingCounts].sort(([left], [right]) => left.localeCompare(right))) {
    if (reportCount >= 3) indicators.push({ kind: "reopened-finding", findingId, reportCount });
  }

  let consecutive: Extract<ChurnIndicator, { kind: "consecutive-non-progress" }> | undefined;
  for (let index = 1; index < history.reports.length; index++) {
    const previous = history.reports[index - 1]!;
    const current = history.reports[index]!;
    if (
      (previous.outcome === "partial" || previous.outcome === "blocked") &&
      (current.outcome === "partial" || current.outcome === "blocked")
    ) {
      consecutive = {
        kind: "consecutive-non-progress",
        ticketIds: [previous.ticketId, current.ticketId],
        outcomes: [previous.outcome, current.outcome],
      };
    }
  }
  if (consecutive !== undefined) indicators.push(consecutive);
  return indicators;
}

function churnBody(changeId: string, indicators: ChurnIndicator[]): string {
  if (indicators.length === 0) return "None.";
  const lines = indicators.map((indicator) => {
    switch (indicator.kind) {
      case "ticket-count":
        return `- planned Tickets: ${indicator.planned}; actual Tickets: ${indicator.actual} (more than two over plan)`;
      case "remediation-rounds":
        return `- ${indicator.count} completed review Reports requested remediation`;
      case "reopened-finding":
        return `- finding \`${indicator.findingId}\` appeared in ${indicator.reportCount} review Reports`;
      case "consecutive-non-progress":
        return `- Reports for Tickets ${indicator.ticketIds[0]} and ${indicator.ticketIds[1]} had consecutive \`${indicator.outcomes[0]}\` and \`${indicator.outcomes[1]}\` outcomes`;
    }
  });
  return `Change ${changeId} churn detected\n\n${lines.join("\n")}\n\nRecommendation: pause implementation and review the Change design with the operator.`;
}

function replaceChurnSection(body: string, content: string): string {
  const heading = /^## Churn indicators[ \t]*$/m.exec(body);
  if (heading === null) return `${body.trimEnd()}\n\n## Churn indicators\n\n${content}\n`;
  const contentStart = body.indexOf("\n", heading.index) + 1;
  const nextHeading = /^## [^\n]+$/m.exec(body.slice(contentStart));
  const sectionEnd = nextHeading === null ? body.length : contentStart + nextHeading.index;
  const before = body.slice(0, heading.index).trimEnd();
  const after = body.slice(sectionEnd).trim();
  return `${before}\n\n## Churn indicators\n\n${content}${after ? `\n\n${after}` : ""}\n`;
}

export async function refreshChangeChurn(
  root: string,
  goalId: string,
  changeId: string,
  now = new Date().toISOString(),
): Promise<{ plan: Plan; indicators: ChurnIndicator[] }> {
  const current = await loadPlan(root, goalId);
  const changePlan = current.metadata.changePlans.find((entry) => entry.changeId === changeId);
  if (changePlan === undefined) throw new Error(`Plan has no planned Ticket count for Change ${changeId}`);
  const history = await loadChangeReportHistory(root, goalId, changeId);
  const indicators = detectChangeChurn(changePlan.plannedTicketCount, history);
  const metadata = planSchema.parse({ ...current.metadata, updatedAt: now });
  const body = replaceChurnSection(current.body, churnBody(changeId, indicators));
  await replaceAtomic(root, planPath(root, goalId), serializeDocument(metadata, body));
  return { plan: { metadata, body }, indicators };
}
