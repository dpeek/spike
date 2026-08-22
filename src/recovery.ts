import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { changePath, deriveGoalIntegratedRevision } from "./change.ts";
import { documentExists, listDirectoryNames } from "./durable-state.ts";
import { candidateRef } from "./git-change.ts";
import { discoverRepository, git } from "./git.ts";
import { goalPath, integratedRef, listAllocatedGoalIds, loadGoal } from "./goal.ts";
import { sequenceIdPattern } from "./identity.ts";
import { projectRoot } from "./project.ts";
import { assertGoalNotFrozen, goalApplicationFreeze, listProjectApplications, listPublishedApplicationIds, loadApplicationResolutionIfPresent, recoverApplications } from "./application.ts";
import { listApplicationTicketIds, recoverApplicationTicket } from "./application-ticket.ts";
import { listApplicationReviewTicketIds, recoverApplicationReviewTicket } from "./application-review.ts";
import { goalPlannerOperations, type GoalPlannerOperations } from "./goal-planner.ts";
import {
  deriveCurrentCandidate,
  loadReportIfPresent,
  publishInterruptedReport,
  publishStoppedReport,
  type ReportExecution,
  type TerminalReport,
} from "./report.ts";
import { loadTicket, ticketPath } from "./ticket.ts";
import {
  forgetFinalizedWorker,
  loadRecordedWorkerIfPresent,
  finalizeWorker,
  type WorkerRuntimeOperations,
  type TicketIdentity,
  exchangePath,
} from "./worker.ts";

export type StopTicketInput = TicketIdentity & {
  cwd: string;
  role: "implement" | "review";
  reason: string;
  now?: Date;
};

export type StoppedTicket = {
  root: string;
  report: TerminalReport;
  cleanup: { status: "finalized" } | { status: "failed"; message: string };
};

export type RecoverInterruptedTicketInput = StopTicketInput;

export type InterruptedTicketRecovery = {
  root: string;
  report: TerminalReport;
  cleanup: { status: "finalized" } | { status: "failed"; message: string };
};

function terminalReason(reason: string, label: "Interruption" | "Stop"): string {
  const normalized = reason.trim();
  if (!normalized) throw new Error(`${label} reason must not be blank`);
  return normalized;
}

function interruptionReason(reason: string): string {
  return terminalReason(reason, "Interruption");
}

export async function stopTicket(
  input: StopTicketInput,
  runtimeOperations?: WorkerRuntimeOperations,
): Promise<StoppedTicket> {
  const repository = await discoverRepository(input.cwd);
  await assertGoalNotFrozen(repository.root, input.goalId);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const reason = terminalReason(input.reason, "Stop");
  const now = input.now ?? new Date();
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  if (ticket.metadata.role !== input.role) {
    throw new Error(`stop role ${input.role} does not match Ticket role ${ticket.metadata.role}`);
  }

  let report = await loadReportIfPresent(repository.root, input.goalId, input.changeId, input.ticketId);
  if (report !== undefined && report.metadata.outcome !== "stopped") {
    throw new Error(`Ticket ${input.goalId}/${input.changeId}/${input.ticketId} is already reported as ${report.metadata.outcome}`);
  }
  if (report !== undefined && report.body !== `# Ticket stopped\n\n${reason}\n`) {
    throw new Error("immutable stopped Report records a different stop reason");
  }

  const recordedWorker = await loadRecordedWorkerIfPresent(repository.root, identity);
  let cleanup: StoppedTicket["cleanup"] = { status: "finalized" };
  let execution: ReportExecution;
  if (recordedWorker === undefined) {
    const finishedAt = now.toISOString();
    execution = {
      ...identity,
      adapter: "host",
      isolation: ticket.metadata.executionPolicy.isolation,
      worker: "not-launched",
      model: ticket.metadata.model,
      thinking: ticket.metadata.thinking,
      startedAt: ticket.metadata.issuedAt,
      finishedAt: Date.parse(finishedAt) < Date.parse(ticket.metadata.issuedAt) ? ticket.metadata.issuedAt : finishedAt,
      exitCode: -1,
    };
  } else {
    const result = await finalizeWorker(repository.root, identity, now, runtimeOperations);
    if (result.status === "failed" && result.phase === "stop") {
      throw new Error(`direct worker could not be stopped: ${result.message}`);
    }
    cleanup = result.status === "failed"
      ? { status: "failed", message: result.message }
      : { status: "finalized" };
    execution = result.execution;
  }

  if (report === undefined) {
    report = (
      await publishStoppedReport({
        cwd: repository.root,
        ...identity,
        role: input.role,
        reason,
        execution,
        now,
      })
    ).report;
  }
  const stoppedReport = report as TerminalReport;

  if (cleanup.status === "finalized") {
    try {
      await forgetFinalizedWorker(repository.root, identity);
    } catch (error) {
      cleanup = { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }
  return { root: repository.root, report: stoppedReport, cleanup };
}

export async function recoverInterruptedTicket(
  input: RecoverInterruptedTicketInput,
  runtimeOperations?: WorkerRuntimeOperations,
): Promise<InterruptedTicketRecovery> {
  const repository = await discoverRepository(input.cwd);
  await assertGoalNotFrozen(repository.root, input.goalId);
  const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
  const reason = interruptionReason(input.reason);
  const now = input.now ?? new Date();
  const ticket = await loadTicket(repository.root, input.goalId, input.changeId, input.ticketId);
  if (ticket.metadata.role !== input.role) {
    throw new Error(`recovery role ${input.role} does not match Ticket role ${ticket.metadata.role}`);
  }

  let report = await loadReportIfPresent(repository.root, input.goalId, input.changeId, input.ticketId);
  if (report !== undefined && report.metadata.outcome !== "interrupted") {
    throw new Error(`Ticket ${input.goalId}/${input.changeId}/${input.ticketId} is already reported as ${report.metadata.outcome}`);
  }
  if (report !== undefined) {
    if (report.metadata.role !== input.role) throw new Error("interrupted Report role does not match recovery role");
    if (report.body !== `# Ticket interrupted\n\n${reason}\n`) {
      throw new Error("immutable interrupted Report records a different interruption reason");
    }
  }

  const recordedWorker = await loadRecordedWorkerIfPresent(repository.root, identity);
  let cleanup: InterruptedTicketRecovery["cleanup"] = { status: "finalized" };
  let execution: ReportExecution;
  if (recordedWorker === undefined) {
    const finishedAt = now.toISOString();
    execution = {
      ...identity,
      adapter: "host",
      isolation: ticket.metadata.executionPolicy.isolation,
      worker: "not-launched",
      model: ticket.metadata.model,
      thinking: ticket.metadata.thinking,
      startedAt: ticket.metadata.issuedAt,
      finishedAt: Date.parse(finishedAt) < Date.parse(ticket.metadata.issuedAt) ? ticket.metadata.issuedAt : finishedAt,
      exitCode: -1,
    };
  } else {
    const result = await finalizeWorker(
      repository.root,
      identity,
      now,
      runtimeOperations,
    );
    cleanup = result.status === "failed"
      ? { status: "failed", message: result.message }
      : { status: "finalized" };
    execution = result.execution;
  }

  if (report === undefined) {
    report = (
      await publishInterruptedReport({
        cwd: repository.root,
        ...identity,
        role: input.role,
        reason,
        execution,
        now,
      })
    ).report;
  }

  if (report === undefined || report.metadata.outcome !== "interrupted") {
    throw new Error("recovery did not publish an interrupted Report");
  }
  const interruptedReport = report as TerminalReport;
  if (cleanup.status === "finalized") {
    try {
      await forgetFinalizedWorker(repository.root, identity);
    } catch (error) {
      cleanup = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { root: repository.root, report: interruptedReport, cleanup };
}

export type ReconcileRepositoryInput = {
  cwd: string;
  reason?: string;
  now?: Date;
  /** Goal planners use local reconciliation only; Application/main recovery is supervisor-owned. */
  recoverApplications?: boolean;
};

export type ReconciledGoal = {
  goalId: string;
  integratedRevision: string;
  currentCandidates: Array<{ changeId: string; candidateRevision: string; producingImplementationTicketId: string }>;
  interruptedTickets: Array<InterruptedTicketRecovery>;
  finalizedWorkers: TicketIdentity[];
  cleanupWarnings: Array<{ identity: TicketIdentity; message: string }>;
  discardedRefs: string[];
  ignoredOutputPaths: string[];
};

export type PlannerCleanupWarning = { goalId: string; applicationId: string; message: string };

export type RepositoryReconciliation = {
  root: string;
  goals: ReconciledGoal[];
  ignoredUnpublishedGoalIds: string[];
  /** Operational release failures never alter immutable Application evidence. */
  plannerCleanupWarnings: PlannerCleanupWarning[];
};

/** Project-supervisor recovery retries release for durable queue entries only.
 * It intentionally neither admits Applications nor changes their documents. */
export async function recoverPublishedApplicationPlanners(
  cwd: string,
  planners: GoalPlannerOperations = goalPlannerOperations,
): Promise<PlannerCleanupWarning[]> {
  const repository = await discoverRepository(cwd);
  const warnings: PlannerCleanupWarning[] = [];
  for (const application of await listProjectApplications(repository.root)) {
    // Resolved history never owns a planner. A malformed resolution remains a
    // durable barrier for its own operation, not a reason to touch runtime.
    try { if (await loadApplicationResolutionIfPresent(repository.root, application.metadata.goalId, application.metadata.applicationId)) continue; }
    catch { continue; }
    try {
      await planners.release({ cwd: repository.root, goalId: application.metadata.goalId });
    } catch (error) {
      warnings.push({
        goalId: application.metadata.goalId,
        applicationId: application.metadata.applicationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return warnings;
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

async function publishedChangeIds(root: string, goalId: string): Promise<string[]> {
  const directory = join(projectRoot(root), "goals", goalId, "changes");
  const ids = (await listDirectoryNames(root, directory)).filter((name) => sequenceIdPattern.test(name)).sort();
  const published: string[] = [];
  for (const changeId of ids) {
    if (await documentExists(root, changePath(root, goalId, changeId))) published.push(changeId);
  }
  return published;
}

async function publishedTicketIds(root: string, goalId: string, changeId: string): Promise<string[]> {
  const directory = join(dirname(changePath(root, goalId, changeId)), "tickets");
  const ids = (await listDirectoryNames(root, directory)).filter((name) => sequenceIdPattern.test(name)).sort();
  const published: string[] = [];
  for (const ticketId of ids) {
    if (await documentExists(root, ticketPath(root, goalId, changeId, ticketId))) published.push(ticketId);
  }
  return published;
}

async function refsBelow(root: string, prefix: string): Promise<string[]> {
  const source = await git(root, ["for-each-ref", "--format=%(refname)", prefix]);
  return source ? source.split("\n").filter(Boolean) : [];
}

async function reconcileCandidateRefs(root: string, goalId: string, changeIds: string[]): Promise<string[]> {
  const expected = new Map<string, string>();
  for (const changeId of changeIds) {
    for (const ticketId of await publishedTicketIds(root, goalId, changeId)) {
      const report = await loadReportIfPresent(root, goalId, changeId, ticketId);
      if (report?.metadata.outcome === "completed" && report.metadata.role === "implement") {
        expected.set(candidateRef(goalId, changeId, ticketId), report.metadata.candidateRevision);
      }
    }
  }

  const discarded: string[] = [];
  const candidatePrefix = `refs/spike/goals/${goalId}/changes/`;
  for (const ref of await refsBelow(root, candidatePrefix)) {
    if (!expected.has(ref)) {
      await git(root, ["update-ref", "-d", ref]);
      discarded.push(ref);
    }
  }
  for (const [ref, revision] of expected) {
    await git(root, ["update-ref", "--no-deref", ref, revision]);
  }

  const quarantinePrefix = `refs/spike/quarantine/goals/${goalId}/`;
  for (const ref of await refsBelow(root, quarantinePrefix)) {
    await git(root, ["update-ref", "-d", ref]);
    discarded.push(ref);
  }
  return discarded;
}

async function rebuildIntegrationRef(root: string, goalId: string): Promise<string> {
  const integratedRevision = await deriveGoalIntegratedRevision(root, goalId);
  await git(root, ["update-ref", "--no-deref", integratedRef(goalId), integratedRevision]);
  return integratedRevision;
}

export async function reconcileGoal(
  input: ReconcileRepositoryInput & { goalId: string },
  runtimeOperations?: WorkerRuntimeOperations,
): Promise<ReconciledGoal> {
  const repository = await discoverRepository(input.cwd);
  await loadGoal(repository.root, input.goalId);
  // Application evidence freezes Goal-local recovery. The Project supervisor
  // may still recover its already-published target decision, without replaying
  // any Goal ref or workflow mutation.
  if ((await listPublishedApplicationIds(repository.root, input.goalId)).length !== 0 && (await goalApplicationFreeze(repository.root, input.goalId)).frozen) {
    // A resolved attempt has no active runtime ownership: return/stale preconditions
    // require all reports and healthy cleanup. Unresolved attempts retain the
    // existing projection-rebuild recovery, but terminal history is never revived.
    for (const application of await listProjectApplications(repository.root)) {
      if (application.metadata.goalId !== input.goalId) continue;
      let resolution;
      try { resolution = await loadApplicationResolutionIfPresent(repository.root, input.goalId, application.metadata.applicationId); } catch { continue; }
      if (resolution !== undefined) continue;
      for (const ticketId of await listApplicationTicketIds(repository.root, input.goalId, application.metadata.applicationId)) await recoverApplicationTicket(repository.root, input.goalId, application.metadata.applicationId, ticketId, input.reason);
      for (const reviewId of await listApplicationReviewTicketIds(repository.root, input.goalId, application.metadata.applicationId)) await recoverApplicationReviewTicket(repository.root, input.goalId, application.metadata.applicationId, reviewId, input.reason);
    }
    if (input.recoverApplications !== false) await recoverApplications(repository.root);
    return {
      goalId: input.goalId,
      integratedRevision: await git(repository.root, ["rev-parse", "--verify", `${integratedRef(input.goalId)}^{commit}`]),
      currentCandidates: [], interruptedTickets: [], finalizedWorkers: [], cleanupWarnings: [], discardedRefs: [], ignoredOutputPaths: [],
    };
  }
  const now = input.now ?? new Date();
  const reason = interruptionReason(input.reason ?? "Supervisor restart interrupted an open Ticket before its Report was published.");
  const changeIds = await publishedChangeIds(repository.root, input.goalId);
  const discardedRefs = await reconcileCandidateRefs(repository.root, input.goalId, changeIds);
  const integratedRevision = await rebuildIntegrationRef(repository.root, input.goalId);
  // Application decisions can advance checked-out main and are Project-wide.
  // A Goal-scoped planner therefore never invokes this branch.
  if (input.recoverApplications !== false) await recoverApplications(repository.root, input.goalId);
  const interruptedTickets: InterruptedTicketRecovery[] = [];
  const finalizedWorkers: TicketIdentity[] = [];
  const cleanupWarnings: Array<{ identity: TicketIdentity; message: string }> = [];
  const ignoredOutputPaths: string[] = [];

  for (const changeId of changeIds) {
    const ticketIds = await publishedTicketIds(repository.root, input.goalId, changeId);
    for (const ticketId of ticketIds) {
      const identity = { goalId: input.goalId, changeId, ticketId };
      const report = await loadReportIfPresent(repository.root, input.goalId, changeId, ticketId);
      const worker = await loadRecordedWorkerIfPresent(repository.root, identity);
      if (report === undefined) {
        const output = join(exchangePath(repository.root, { goalId: input.goalId, changeId, ticketId }), "output");
        if (await pathExists(output)) ignoredOutputPaths.push(output);
        const ticket = await loadTicket(repository.root, input.goalId, changeId, ticketId);
        const recovered = await recoverInterruptedTicket(
          {
            cwd: repository.root,
            ...identity,
            role: ticket.metadata.role,
            reason,
            now,
          },
          runtimeOperations,
        );
        interruptedTickets.push(recovered);
        if (recovered.cleanup.status === "failed") {
          cleanupWarnings.push({ identity, message: recovered.cleanup.message });
        } else if (worker !== undefined) {
          finalizedWorkers.push(identity);
        }
        continue;
      }

      if (worker === undefined) continue;
      const cleanup = await finalizeWorker(repository.root, identity, now, runtimeOperations);
      if (cleanup.status === "failed") {
        cleanupWarnings.push({ identity, message: cleanup.message });
        continue;
      }
      try {
        await forgetFinalizedWorker(repository.root, identity);
        finalizedWorkers.push(identity);
      } catch (error) {
        cleanupWarnings.push({ identity, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const currentCandidates: ReconciledGoal["currentCandidates"] = [];
  for (const changeId of changeIds) {
    const candidate = await deriveCurrentCandidate(repository.root, input.goalId, changeId);
    if (candidate !== undefined) {
      currentCandidates.push({
        changeId,
        candidateRevision: candidate.candidateRevision,
        producingImplementationTicketId: candidate.producingImplementationTicketId,
      });
    }
  }

  return {
    goalId: input.goalId,
    integratedRevision,
    currentCandidates,
    interruptedTickets,
    finalizedWorkers,
    cleanupWarnings,
    discardedRefs,
    ignoredOutputPaths,
  };
}

export async function reconcileRepository(
  input: ReconcileRepositoryInput,
  runtimeOperations?: WorkerRuntimeOperations,
  planners: GoalPlannerOperations = goalPlannerOperations,
): Promise<RepositoryReconciliation> {
  const repository = await discoverRepository(input.cwd);
  // Run operational cleanup from published evidence before any Goal-local
  // recovery can encounter a target barrier. This is idempotent and is the
  // only retry path needed after a crash just after Application publication.
  const plannerCleanupWarnings = await recoverPublishedApplicationPlanners(repository.root, planners);
  const goalIds = await listAllocatedGoalIds(repository.root);
  const goals: ReconciledGoal[] = [];
  const ignoredUnpublishedGoalIds: string[] = [];
  for (const goalId of goalIds) {
    if (!(await documentExists(repository.root, goalPath(repository.root, goalId)))) {
      ignoredUnpublishedGoalIds.push(goalId);
      continue;
    }
    goals.push(
      await reconcileGoal(
        {
          cwd: repository.root,
          goalId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.now === undefined ? {} : { now: input.now }),
          ...(input.recoverApplications === undefined ? {} : { recoverApplications: input.recoverApplications }),
        },
        runtimeOperations,
      ),
    );
  }
  return { root: repository.root, goals, ignoredUnpublishedGoalIds, plannerCleanupWarnings };
}
