import { describe, expect, test } from "bun:test";
import { abandonChange, changeDecisionPath, createChange } from "../../src/change.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { reconcileRepository, stopTicket } from "../../src/recovery.ts";
import { loadReport } from "../../src/report.ts";
import { issueTicket, ticketPath } from "../../src/ticket.ts";
import { temporaryRepository } from "../support/repository.ts";


const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

describe("Change abandonment", () => {
  test("requires a terminal Ticket Report and never replaces interrupted work automatically", async () => {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root, hostPaths: repository.hostPaths, title: "Abandon active work",
      outcome: "Resolve unwanted work only after its active Ticket becomes terminal.",
      approval: "Approved.",
    });
    const goalId = goal.goal.metadata.goalId;
    const firstChange = await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Explicitly stopped direction",
      intent: "Exercise orderly abandonment.",
      rationale: "Every issued Ticket must receive a Report before its Change resolves.",
      acceptanceCriteria: ["The open Ticket is stopped before abandonment."],
    });
    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      instruction: "Perform work that the operator may stop.",
      executionPolicy: policy,
    });

    await expect(
      abandonChange({ cwd: repository.root, hostPaths: repository.hostPaths, goalId, changeId: "001", statement: "Stop this direction." }),
    ).rejects.toThrow("has an open Ticket");
    expect(await Bun.file(changeDecisionPath(repository.project, goalId, "001")).exists()).toBe(false);

    const stopped = await stopTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      ticketId: "001",
      role: "implement",
      reason: "Operator abandoned this direction before the worker launched.",
      now: new Date("2026-03-25T10:00:00.000Z"),
    });
    expect(stopped.report.metadata).toMatchObject({
      role: "implement",
      outcome: "stopped",
      execution: { adapter: "host", worker: "not-launched", model: "implementation-model", thinking: "medium" },
    });
    expect((await loadReport(repository.project, goalId, "001", "001")).metadata.outcome).toBe("stopped");

    const firstAbandonment = await abandonChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "001",
      statement: "Operator abandoned this direction after stopping its active Ticket.",
      now: new Date("2026-03-25T10:01:00.000Z"),
    });
    expect(firstAbandonment.decision.metadata.disposition).toBe("abandon");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(firstChange.change.metadata.baseRevision);

    await createChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      title: "Interrupted direction",
      intent: "Exercise restart recovery followed by abandonment.",
      rationale: "Recovery must not decide whether the Plan should continue.",
      acceptanceCriteria: ["No replacement Ticket is issued automatically."],
    });
    await issueTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "002",
      instruction: "Start work before the supervisor restarts.",
      executionPolicy: policy,
    });

    const reconciliation = await reconcileRepository({
      cwd: repository.root, hostPaths: repository.hostPaths, reason: "Supervisor restarted before the Ticket produced a Report.",
      now: new Date("2026-03-25T11:00:00.000Z"),
    });
    expect(reconciliation.goals[0]?.interruptedTickets[0]?.report.metadata.outcome).toBe("interrupted");
    expect(await Bun.file(ticketPath(repository.project, goalId, "002", "002")).exists()).toBe(false);

    const secondAbandonment = await abandonChange({
      cwd: repository.root, hostPaths: repository.hostPaths, goalId,
      changeId: "002",
      statement: "Operator abandoned the interrupted direction instead of replacing its Ticket.",
      now: new Date("2026-03-25T11:01:00.000Z"),
    });
    expect(secondAbandonment.decision.metadata.disposition).toBe("abandon");
  });
});
