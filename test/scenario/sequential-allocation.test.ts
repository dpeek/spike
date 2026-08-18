import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changeDecisionPath, changeStatus, createChange } from "../../src/change.ts";
import { installImmutable, serializeDocument } from "../../src/durable-state.ts";
import { createGoal, integratedRef } from "../../src/goal.ts";
import { issueTicket, reportPath, ticketStatus } from "../../src/ticket.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

async function fixture() {
  const repository = await temporaryRepository();
  repositories.push(repository);
  const createdGoal = await createGoal({
    cwd: repository.root,
    title: "Sequential workflow",
    outcome: "Allocate durable Changes and Tickets.",
    approval: "Approved.",
    now: new Date("2026-03-19T10:00:00.000Z"),
  });
  return { repository, goalId: createdGoal.goal.metadata.goalId };
}

async function firstChange(repository: Awaited<ReturnType<typeof temporaryRepository>>, goalId: string) {
  return createChange({
    cwd: repository.root,
    goalId,
    title: "Create allocation",
    intent: "Issue parent-relative IDs.",
    rationale: "Sequential work needs deterministic identity.",
    acceptanceCriteria: ["Allocate the next monotonic ID."],
    nonGoals: ["Concurrent planner mutation."],
    now: new Date("2026-03-19T10:10:00.000Z"),
  });
}

const executionPolicy = {
  isolation: "workspace" as const,
  networkAccess: "restricted" as const,
  credentialGrants: ["source-repository"],
};

describe("sequential Change and Ticket allocation", () => {
  test("allocates Change IDs monotonically from the Goal integrated revision and never reuses a burned ID", async () => {
    const { repository, goalId } = await fixture();
    await writeFile(join(repository.root, "later.txt"), "later revision\n");
    await repository.git("add", "later.txt");
    await repository.git("commit", "--quiet", "-m", "Later product revision");
    const laterRevision = await repository.git("rev-parse", "HEAD");

    const first = await firstChange(repository, goalId);
    expect(first.change.metadata).toEqual({
      kind: "change",
      goalId,
      changeId: "001",
      createdAt: "2026-03-19T10:10:00.000Z",
      baseRevision: repository.head,
    });
    expect(first.change.body).toContain("## Acceptance criteria\n\n- Allocate the next monotonic ID.");
    expect(await changeStatus(repository.root, goalId, "001")).toBe("active");
    expect(first.change.metadata).not.toHaveProperty("status");

    await expect(firstChange(repository, goalId)).rejects.toThrow(`already has unresolved Change 001`);

    const decisionPath = changeDecisionPath(repository.root, goalId, "001");
    await installImmutable(
      repository.root,
      decisionPath,
      serializeDocument({ kind: "change-decision", disposition: "abandon" }, "Invalid decision."),
    );
    await expect(changeStatus(repository.root, goalId, "001")).rejects.toThrow();
    await rm(decisionPath);

    await installImmutable(
      repository.root,
      decisionPath,
      serializeDocument(
        {
          kind: "change-decision",
          goalId,
          changeId: "001",
          decidedAt: "2026-03-19T10:15:00.000Z",
          disposition: "abandon",
        },
        "Superseded.",
      ),
    );
    expect(await changeStatus(repository.root, goalId, "001")).toBe("resolved");
    await expect(
      issueTicket({
        cwd: repository.root,
        goalId,
        changeId: "001",
        instruction: "Reopen resolved work.",
        executionPolicy,
      }),
    ).rejects.toThrow("is resolved");
    await repository.git("update-ref", integratedRef(goalId), laterRevision);

    // A directory left before immutable publication burns its sequence ID.
    await mkdir(join(repository.root, ".spike", "goals", goalId, "changes", "002"), { recursive: true });
    const third = await createChange({
      cwd: repository.root,
      goalId,
      title: "Continue allocation",
      intent: "Do not reuse interrupted allocation IDs.",
      rationale: "Nested identities remain stable.",
      acceptanceCriteria: ["Allocate 003."],
    });

    expect(third.change.metadata.changeId).toBe("003");
    expect(third.change.metadata.baseRevision).toBe(laterRevision);
  });

  test("issues immutable implement Tickets with exact provenance and derives open status from report presence", async () => {
    const { repository, goalId } = await fixture();
    const change = await firstChange(repository, goalId);
    await writeFile(join(repository.root, "candidate-input.txt"), "unrelated host change\n");
    await repository.git("add", "candidate-input.txt");
    await repository.git("commit", "--quiet", "-m", "Advance host after Change creation");
    const hostRevision = await repository.git("rev-parse", "HEAD");

    const first = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Implement monotonic Ticket allocation.",
      curatedContext: "Preserve directories left by interrupted publication.",
      executionPolicy,
      now: new Date("2026-03-19T10:20:00.000Z"),
    });

    expect(first.ticket.metadata).toEqual({
      kind: "ticket",
      goalId,
      changeId: "001",
      ticketId: "001",
      issuedAt: "2026-03-19T10:20:00.000Z",
      role: "implement",
      inputRevision: change.change.metadata.baseRevision,
      model: "implementation-model",
      thinking: "medium",
      executionPolicy,
    });
    expect(first.ticket.metadata.inputRevision).not.toBe(hostRevision);
    expect(first.ticket.metadata).not.toHaveProperty("status");
    expect(first.ticket.body).toContain("## Instruction\n\nImplement monotonic Ticket allocation.");
    expect(first.ticket.body).toContain("### Goal\n\n# Sequential workflow");
    expect(first.ticket.body).toContain("### Change\n\n# Create allocation");
    expect(first.ticket.body).toContain("### Current Plan\n\n# Plan: Sequential workflow");
    expect(first.ticket.body).toContain("### Planner-selected context\n\nPreserve directories");
    expect(await ticketStatus(repository.root, goalId, "001", "001")).toBe("open");

    await expect(
      issueTicket({
        cwd: repository.root,
        goalId,
        changeId: "001",
        instruction: "Issue another Ticket too early.",
        executionPolicy,
      }),
    ).rejects.toThrow("already has open Ticket 001");

    const interruptedReport = {
      kind: "report",
      goalId,
      changeId: "001",
      ticketId: "001",
      role: "implement",
      outcome: "interrupted",
      publishedAt: "2026-03-19T10:21:00.000Z",
      artifacts: [],
      execution: {
        adapter: "local-clone",
        isolation: "workspace",
        worker: "controlled-worker",
        model: "implementation-model",
        thinking: "medium",
        startedAt: "2026-03-19T10:20:00.000Z",
        finishedAt: "2026-03-19T10:21:00.000Z",
      },
    };
    const interruptedReportPath = reportPath(repository.root, goalId, "001", "001");
    await installImmutable(
      repository.root,
      interruptedReportPath,
      serializeDocument({ ...interruptedReport, role: "review" }, "Worker interrupted."),
    );
    await expect(ticketStatus(repository.root, goalId, "001", "001")).rejects.toThrow("role does not match");
    await rm(interruptedReportPath);
    await installImmutable(
      repository.root,
      interruptedReportPath,
      serializeDocument(interruptedReport, "Worker interrupted."),
    );
    expect(await ticketStatus(repository.root, goalId, "001", "001")).toBe("reported");

    await mkdir(join(repository.root, ".spike", "goals", goalId, "changes", "001", "tickets", "002"), {
      recursive: true,
    });
    const third = await issueTicket({
      cwd: repository.root,
      goalId,
      changeId: "001",
      instruction: "Retry from the Change base.",
      executionPolicy: { isolation: "container", networkAccess: "none", credentialGrants: [] },
    });

    expect(third.ticket.metadata.ticketId).toBe("003");
    expect(third.ticket.metadata.inputRevision).toBe(repository.head);
  });
});
