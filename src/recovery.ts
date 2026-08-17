import { discoverRepository } from "./git.ts";
import {
  loadReportIfPresent,
  publishInterruptedReport,
  type TerminalReport,
} from "./report.ts";
import { issueReplacementTicket, loadTicket, type IssuedTicket } from "./ticket.ts";
import {
  forgetFinalizedWorker,
  loadRecordedWorkerIfPresent,
  stopAndFinalizeRecordedWorker,
  type LocalWorkerResourceOperations,
  type TicketIdentity,
} from "./worker.ts";

export type RecoverInterruptedTicketInput = TicketIdentity & {
  cwd: string;
  role: "implement" | "review";
  reason: string;
  now?: Date;
};

export type InterruptedTicketRecovery = {
  root: string;
  report: TerminalReport;
  replacement: IssuedTicket["ticket"];
  cleanup: { status: "finalized" } | { status: "failed"; message: string };
};

function interruptionReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new Error("Interruption reason must not be blank");
  return normalized;
}

export async function recoverInterruptedTicket(
  input: RecoverInterruptedTicketInput,
  resourceOperations?: LocalWorkerResourceOperations,
): Promise<InterruptedTicketRecovery> {
  const repository = await discoverRepository(input.cwd);
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
  if (report === undefined && recordedWorker === undefined) {
    throw new Error(`open Ticket ${input.goalId}/${input.changeId}/${input.ticketId} has no recorded execution provenance`);
  }

  let cleanup: InterruptedTicketRecovery["cleanup"] = { status: "finalized" };
  if (recordedWorker !== undefined) {
    const result = await stopAndFinalizeRecordedWorker(
      repository.root,
      identity,
      now,
      resourceOperations,
    );
    cleanup = result.status === "failed"
      ? { status: "failed", message: result.message }
      : { status: "finalized" };

    if (report === undefined) {
      report = (
        await publishInterruptedReport({
          cwd: repository.root,
          ...identity,
          role: input.role,
          reason,
          execution: result.execution,
          now,
        })
      ).report;
    }
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

  const replacement = (
    await issueReplacementTicket({
      cwd: repository.root,
      goalId: input.goalId,
      changeId: input.changeId,
      interruptedTicketId: input.ticketId,
      now,
    })
  ).ticket;

  return { root: repository.root, report: interruptedReport, replacement, cleanup };
}
