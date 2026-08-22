import { describe, expect, test } from "bun:test";
import { createChange } from "../../src/change.ts";
import { installImmutable, serializeDocument } from "../../src/durable-state.ts";
import { createGoal } from "../../src/goal.ts";
import { loadReport, publishFailedReport } from "../../src/report.ts";
import { issueTicket, reportPath } from "../../src/ticket.ts";
import { recordWorker } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";


const policy = { isolation: "workspace" as const, networkAccess: "unrestricted" as const, credentialGrants: [] };

async function fixture() {
  const repository = await temporaryRepository();
  const goal = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Worker seam", outcome: "Keep runtime authority selected.", approval: "Approved." });
  await createChange({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goal.metadata.goalId, title: "Validate seam", intent: "Reject false runtime evidence.",
    rationale: "Ticket policy selects the adapter.", acceptanceCriteria: ["Runtime evidence is authoritative."],
  });
  const ticket = await issueTicket({ cwd: repository.root, hostPaths: repository.hostPaths, goalId: goal.goal.metadata.goalId, changeId: "001", instruction: "Validate.", executionPolicy: policy });
  return { repository, identity: { goalId: goal.goal.metadata.goalId, changeId: "001", ticketId: ticket.ticket.metadata.ticketId }, ticket };
}

describe("Worker seam regressions", () => {
  test("recording ignores a name-matched lookalike and validates through the selected adapter", async () => {
    const { repository, identity } = await fixture();
    await expect(recordWorker(repository.project, {
      ...identity, role: "implement", worker: "lookalike", startedAt: "2026-08-18T06:00:00.000Z",
      runtime: { containerId: "not-a-local-runtime" },
      // A stale caller can supply this extra value, but it is not an authority.
      adapter: { adapter: "local-clone", supports: () => true, validateRuntime: () => undefined },
    } as any)).rejects.toThrow("host");
  });

  test("loading rejects failed host/not-launched provenance just as publication does", async () => {
    const { repository, identity, ticket } = await fixture();
    const execution = {
      ...identity, adapter: "host", isolation: "workspace" as const, worker: "not-launched",
      model: ticket.ticket.metadata.model, thinking: ticket.ticket.metadata.thinking,
      startedAt: ticket.ticket.metadata.issuedAt, finishedAt: "2026-08-18T06:01:00.000Z", exitCode: -1, stdout: "", stderr: "",
    };
    await expect(publishFailedReport({ cwd: repository.root, hostPaths: repository.hostPaths, ...identity, role: "implement", reason: "No launch.", execution })).rejects.toThrow("permitted only");
    await installImmutable(repository.project.controlRoot, reportPath(repository.project, identity.goalId, identity.changeId, identity.ticketId), serializeDocument({
      kind: "report", ...identity, role: "implement", outcome: "failed", publishedAt: "2026-08-18T06:02:00.000Z", artifacts: [],
      execution: (({ adapter, isolation, worker, model, thinking, startedAt, finishedAt }) => ({ adapter, isolation, worker, model, thinking, startedAt, finishedAt }))(execution),
    }, "# Ticket failed\n\nNo launch.\n"));
    await expect(loadReport(repository.project, identity.goalId, identity.changeId, identity.ticketId)).rejects.toThrow("permitted only");
  });
});
