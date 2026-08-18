import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { issueTicket } from "../../src/ticket.ts";
import { localCloneWorkerAdapter } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";
import { workerAdapterContract } from "./worker-adapter.ts";

workerAdapterContract({
  name: "local-clone",
  adapter: localCloneWorkerAdapter,
  async createTicket() {
    const repository = await temporaryRepository();
    const goal = await createGoal({
      cwd: repository.root,
      title: "Worker adapter contract",
      outcome: "Exercise adapter-owned runtime behavior.",
      approval: "Approved.",
    });
    await createChange({
      cwd: repository.root,
      goalId: goal.goal.metadata.goalId,
      title: "Exercise local clone",
      intent: "Run the shared Worker adapter contract.",
      rationale: "The contract must use real dispatch and evidence.",
      acceptanceCriteria: ["The adapter contract is executable."],
    });
    const issued = await issueTicket({
      cwd: repository.root,
      goalId: goal.goal.metadata.goalId,
      changeId: "001",
      instruction: "Execute the scripted adapter contract.",
      executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
      model: "contract-model",
      thinking: "off",
    });
    return {
      root: repository.root,
      identity: { goalId: goal.goal.metadata.goalId, changeId: "001", ticketId: issued.ticket.metadata.ticketId },
      revision: issued.ticket.metadata.inputRevision,
      remove: repository.remove,
    };
  },
});
