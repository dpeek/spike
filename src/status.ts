import {
  changeStatus,
  listChangeIds,
  loadChange,
  loadChangeDecisionIfPresent,
  type ChangeDecision,
} from "./change.ts";
import { git, discoverRepository } from "./git.ts";
import { integratedRef, listGoalIds, loadGoal } from "./goal.ts";
import { detectChangeChurn, loadPlan, type ChurnIndicator } from "./plan.ts";
import {
  deriveCurrentApproval,
  deriveCurrentCandidate,
  deriveCurrentRejection,
  deriveCurrentRemediation,
  loadChangeReportHistory,
  loadReportIfPresent,
} from "./report.ts";
import { listTicketIds, loadOpenTicket } from "./ticket.ts";
import { loadRecordedWorkerIfPresent, type TicketIdentity } from "./worker.ts";

export type CleanupWarning = {
  identity: TicketIdentity;
  message: string;
};

export type CleanupHealth = {
  healthy: boolean;
  warnings: CleanupWarning[];
};

export type DerivedChangeStatus = {
  changeId: string;
  baseRevision: string;
  candidate: null | {
    revision: string;
    producingImplementationTicketId: string;
  };
  review: null | {
    ticketId: string;
    verdict: "remediate" | "approve" | "reject" | "ask-operator";
    reviewedRevision: string;
    producingImplementationTicketId: string;
  };
  openTicket: null | {
    ticketId: string;
    role: "implement" | "review";
    inputRevision: string;
  };
  churnWarnings: ChurnIndicator[];
};

export type DerivedDecision = {
  changeId: string;
  disposition: "land" | "reject" | "abandon";
  decidedAt: string;
  approvedRevision?: string;
  statement: string;
};

export type DerivedGoalStatus = {
  goalId: string;
  integratedRevision: string;
  plan: {
    updatedAt: string;
  };
  currentChange: DerivedChangeStatus | null;
  decisions: DerivedDecision[];
  cleanup: CleanupHealth;
};

export type DerivedRepositoryStatus = {
  root: string;
  goals: DerivedGoalStatus[];
  cleanup: CleanupHealth;
};

function decisionStatus(decision: ChangeDecision): DerivedDecision {
  return {
    changeId: decision.metadata.changeId,
    disposition: decision.metadata.disposition,
    decidedAt: decision.metadata.decidedAt,
    ...(decision.metadata.disposition === "land"
      ? { approvedRevision: decision.metadata.approvedRevision }
      : {}),
    statement: decision.body.trim(),
  };
}

async function cleanupWarningsForChange(
  root: string,
  goalId: string,
  changeId: string,
): Promise<CleanupWarning[]> {
  const warnings: CleanupWarning[] = [];
  for (const ticketId of await listTicketIds(root, goalId, changeId)) {
    const identity = { goalId, changeId, ticketId };
    const worker = await loadRecordedWorkerIfPresent(root, identity);
    if (worker === undefined) continue;
    const report = await loadReportIfPresent(root, goalId, changeId, ticketId);
    if (report !== undefined) {
      warnings.push({ identity, message: "reported Ticket retains a Worker record requiring cleanup" });
    } else if (worker.metadata.resource === undefined) {
      warnings.push({ identity, message: "finalized Worker record awaits removal" });
    }
  }
  return warnings;
}

async function deriveActiveChangeStatus(
  root: string,
  goalId: string,
  changeId: string,
  plannedTicketCount: number | undefined,
): Promise<DerivedChangeStatus> {
  const [change, candidate, approval, remediation, rejection, openTicket, history] = await Promise.all([
    loadChange(root, goalId, changeId),
    deriveCurrentCandidate(root, goalId, changeId),
    deriveCurrentApproval(root, goalId, changeId),
    deriveCurrentRemediation(root, goalId, changeId),
    deriveCurrentRejection(root, goalId, changeId),
    loadOpenTicket(root, goalId, changeId),
    loadChangeReportHistory(root, goalId, changeId),
  ]);
  const review = approval ?? remediation ?? rejection;
  return {
    changeId,
    baseRevision: change.metadata.baseRevision,
    candidate:
      candidate === undefined
        ? null
        : {
            revision: candidate.candidateRevision,
            producingImplementationTicketId: candidate.producingImplementationTicketId,
          },
    review:
      review === undefined
        ? null
        : {
            ticketId: review.reviewTicketId,
            verdict: review.reviewReport.metadata.verdict,
            reviewedRevision: review.reviewReport.metadata.reviewedRevision,
            producingImplementationTicketId: review.producingImplementationTicketId,
          },
    openTicket:
      openTicket === undefined
        ? null
        : {
            ticketId: openTicket.metadata.ticketId,
            role: openTicket.metadata.role,
            inputRevision: openTicket.metadata.inputRevision,
          },
    churnWarnings: plannedTicketCount === undefined ? [] : detectChangeChurn(plannedTicketCount, history),
  };
}

export async function deriveGoalStatus(cwd: string, goalId: string): Promise<DerivedGoalStatus> {
  const repository = await discoverRepository(cwd);
  const [goal, plan, changeIds, integratedRevision] = await Promise.all([
    loadGoal(repository.root, goalId),
    loadPlan(repository.root, goalId),
    listChangeIds(repository.root, goalId),
    git(repository.root, ["rev-parse", "--verify", `${integratedRef(goalId)}^{commit}`]),
  ]);
  if (goal.metadata.goalId !== plan.metadata.goalId) throw new Error(`Plan does not belong to Goal ${goalId}`);

  const decisions: DerivedDecision[] = [];
  const activeChangeIds: string[] = [];
  const cleanupWarnings: CleanupWarning[] = [];
  for (const changeId of changeIds) {
    if ((await changeStatus(repository.root, goalId, changeId)) === "active") activeChangeIds.push(changeId);
    const decision = await loadChangeDecisionIfPresent(repository.root, goalId, changeId);
    if (decision !== undefined) decisions.push(decisionStatus(decision));
    cleanupWarnings.push(...(await cleanupWarningsForChange(repository.root, goalId, changeId)));
  }
  if (activeChangeIds.length > 1) throw new Error(`Goal ${goalId} has more than one active Change`);

  const activeChangeId = activeChangeIds[0];
  const plannedTicketCount =
    activeChangeId === undefined
      ? undefined
      : plan.metadata.changePlans.find((entry) => entry.changeId === activeChangeId)?.plannedTicketCount;
  const currentChange =
    activeChangeId === undefined
      ? null
      : await deriveActiveChangeStatus(repository.root, goalId, activeChangeId, plannedTicketCount);

  return {
    goalId,
    integratedRevision,
    plan: { updatedAt: plan.metadata.updatedAt },
    currentChange,
    decisions,
    cleanup: { healthy: cleanupWarnings.length === 0, warnings: cleanupWarnings },
  };
}

export async function deriveRepositoryStatus(cwd: string): Promise<DerivedRepositoryStatus> {
  const repository = await discoverRepository(cwd);
  const goals: DerivedGoalStatus[] = [];
  for (const goalId of await listGoalIds(repository.root)) {
    goals.push(await deriveGoalStatus(repository.root, goalId));
  }
  const warnings = goals.flatMap((goal) => goal.cleanup.warnings);
  return {
    root: repository.root,
    goals,
    cleanup: { healthy: warnings.length === 0, warnings },
  };
}
