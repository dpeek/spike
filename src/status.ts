import {
  changeStatus,
  listChangeIds,
  loadChange,
  loadChangeDecisionIfPresent,
  type ChangeDecision,
} from "./change.ts";
import { loadProjectIdentity } from "./config.ts";
import { git, discoverRepository } from "./git.ts";
import { integratedRef, listGoalIds, loadGoal } from "./goal.ts";
import { detectChangeChurn, loadPlan, type ChurnIndicator } from "./plan.ts";
import {
  deriveCurrentCandidate,
  deriveCurrentReview,
  loadChangeReportHistory,
  loadReportIfPresent,
} from "./report.ts";
import { listTicketIds, loadOpenTicket } from "./ticket.ts";
import { loadRecordedWorkerIfPresent, type TicketIdentity } from "./worker.ts";
import { applicationEvidence, applicationState, listProjectApplications, queuedApplicationHead } from "./application.ts";
import { deriveApplicationStatus, type ApplicationChurnWarning } from "./application-ticket.ts";
import { goalPlannerIdentity, goalPlannerOperations, type GoalPlannerObservation } from "./goal-planner.ts";
import { herdrOperations, type HerdrOperations } from "./herdr.ts";

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
    findingCounts: {
      critical: number;
      high: number;
      medium: number;
      low: number;
    };
  };
  openTicket: null | {
    ticketId: string;
    role: "implement" | "review";
    inputRevision: string;
  };
  latestReport: null | {
    ticketId: string;
    role: "implement" | "review";
    outcome: "completed" | "partial" | "blocked" | "failed" | "stopped" | "interrupted";
    verdict?: "remediate" | "approve" | "reject" | "ask-operator";
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
  application: Array<{ applicationId: string; state: "incomplete" | "inconsistent" | "applied"; review: unknown; churnWarnings: ApplicationChurnWarning[] }>;
  frozen: boolean;
};

export type DerivedRepositoryStatus = {
  root: string;
  project: { slug: string };
  goals: DerivedGoalStatus[];
  cleanup: CleanupHealth;
  applicationQueue: Array<{ goalId: string; applicationId: string; queuePosition: number; integratedRevision: string; state: "queued" | "applied" | "inconsistent"; review: unknown; churnWarnings: ApplicationChurnWarning[] }>;
  queueHead: null | { goalId: string; applicationId: string; queuePosition: number };
};

/** Operational attachment observations deliberately sit beside, never inside,
 * durable Goal phase. A failed or ambiguous terminal query cannot influence
 * Goal completion, cleanup health, or any recovery decision. */
export type SupervisorPlannerStatus = {
  durable: DerivedRepositoryStatus;
  planners: GoalPlannerObservation[];
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
    } else if (worker.metadata.runtime === undefined) {
      warnings.push({ identity, message: "finalized Worker record awaits removal" });
    }
  }
  return warnings;
}

async function deriveActiveChangeStatus(
  root: string,
  goalId: string,
  changeId: string,
): Promise<DerivedChangeStatus> {
  const [change, candidate, review, openTicket, history] = await Promise.all([
    loadChange(root, goalId, changeId),
    deriveCurrentCandidate(root, goalId, changeId),
    deriveCurrentReview(root, goalId, changeId),
    loadOpenTicket(root, goalId, changeId),
    loadChangeReportHistory(root, goalId, changeId),
  ]);
  const latestReport = history.reports.at(-1);
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
            findingCounts: {
              critical: review.reviewReport.metadata.findings.filter((finding) => finding.severity === "critical").length,
              high: review.reviewReport.metadata.findings.filter((finding) => finding.severity === "high").length,
              medium: review.reviewReport.metadata.findings.filter((finding) => finding.severity === "medium").length,
              low: review.reviewReport.metadata.findings.filter((finding) => finding.severity === "low").length,
            },
          },
    openTicket:
      openTicket === undefined
        ? null
        : {
            ticketId: openTicket.metadata.ticketId,
            role: openTicket.metadata.role,
            inputRevision: openTicket.metadata.inputRevision,
          },
    latestReport:
      latestReport === undefined
        ? null
        : {
            ticketId: latestReport.ticketId,
            role: latestReport.role,
            outcome: latestReport.outcome,
            ...(latestReport.verdict === undefined ? {} : { verdict: latestReport.verdict }),
          },
    churnWarnings: detectChangeChurn(history),
  };
}

export async function deriveGoalStatus(cwd: string, goalId: string): Promise<DerivedGoalStatus> {
  const repository = await discoverRepository(cwd);
  const [goal, plan, changeIds, integratedRevision, application] = await Promise.all([
    loadGoal(repository.root, goalId),
    loadPlan(repository.root, goalId),
    listChangeIds(repository.root, goalId),
    git(repository.root, ["rev-parse", "--verify", `${integratedRef(goalId)}^{commit}`]),
    applicationEvidence(repository.root, goalId),
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
  const currentChange =
    activeChangeId === undefined
      ? null
      : await deriveActiveChangeStatus(repository.root, goalId, activeChangeId);

  const applicationWithReview = await Promise.all(application.map(async entry => { const status = await deriveApplicationStatus(repository.root, goalId, entry.applicationId); return { ...entry, review: status.review, churnWarnings: status.churnWarnings }; }));
  return {
    goalId,
    integratedRevision,
    plan: { updatedAt: plan.metadata.updatedAt },
    currentChange,
    decisions,
    cleanup: { healthy: cleanupWarnings.length === 0, warnings: cleanupWarnings },
    application: applicationWithReview,
    frozen: application.length !== 0,
  };
}

export async function deriveRepositoryStatus(cwd: string): Promise<DerivedRepositoryStatus> {
  const repository = await discoverRepository(cwd);
  const project = await loadProjectIdentity(repository.root);
  const goals: DerivedGoalStatus[] = [];
  for (const goalId of await listGoalIds(repository.root)) {
    goals.push(await deriveGoalStatus(repository.root, goalId));
  }
  const queue = await listProjectApplications(repository.root);
  // Decision publication alone is never terminal: only its exact main target
  // projection marks an entry applied. Invalid or unexpected evidence remains
  // visible as the FIFO barrier rather than allowing a later entry to lead.
  const queueStates = await Promise.all(queue.map((application) => applicationState(repository.root, application)));
  const head = await queuedApplicationHead(repository.root);
  const warnings = goals.flatMap((goal) => goal.cleanup.warnings);
  return {
    root: repository.root,
    project,
    goals,
    cleanup: { healthy: warnings.length === 0, warnings },
    applicationQueue: await Promise.all(queue.map(async (application, index) => { const status = await deriveApplicationStatus(repository.root, application.metadata.goalId, application.metadata.applicationId); return {
      goalId: application.metadata.goalId,
      applicationId: application.metadata.applicationId,
      queuePosition: application.metadata.queuePosition,
      integratedRevision: application.metadata.integratedRevision,
      state: queueStates[index] === "applied" ? "applied" : queueStates[index] === "inconsistent" ? "inconsistent" : "queued",
      review: status.review,
      churnWarnings: status.churnWarnings,
    }; })),
    queueHead: head === undefined ? null : { goalId: head.metadata.goalId, applicationId: head.metadata.applicationId, queuePosition: head.metadata.queuePosition },
  };
}

export async function deriveSupervisorPlannerStatus(
  cwd: string,
  herdr: HerdrOperations = herdrOperations,
): Promise<SupervisorPlannerStatus> {
  const [durable, repository] = await Promise.all([deriveRepositoryStatus(cwd), discoverRepository(cwd)]);
  const planners = await Promise.all(durable.goals.map(async ({ goalId }) => {
    try {
      return await goalPlannerOperations.observe({ cwd: repository.root, goalId, herdr });
    } catch {
      // Keep the exact durable identity visible even when Herdr discovery is
      // unavailable. This is an operational observation, not a health error.
      return { ...goalPlannerIdentity(repository.identity, goalId), resources: [], state: "unavailable" as const };
    }
  }));
  return { durable, planners };
}
