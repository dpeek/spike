import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGoal, goalPath, integratedRef } from "./goal.ts";
import { createRequest, closeRequest, requestPath } from "./request.ts";
import { planPath } from "./plan.ts";
import { temporaryRepository } from "../test/support/repository.ts";


async function absentGoalWorkflow(repository: Awaited<ReturnType<typeof temporaryRepository>>) {
  expect(await Bun.file(goalPath(repository.project, "spike-001")).exists()).toBe(false);
  expect(await Bun.file(planPath(repository.project, "spike-001")).exists()).toBe(false);
  await expect(repository.git("rev-parse", "--verify", integratedRef("spike-001"))).rejects.toThrow();
}

describe("Goal source Request provenance", () => {
  test("renders zero, one, and many eligible Request IDs without metadata changes", async () => {
    const repository = await temporaryRepository();
    const unassigned = await createRequest({ hostPaths: repository.hostPaths, title: "Unassigned", statement: "Future work." });
      const local = await createRequest({ hostPaths: repository.hostPaths, title: "Local", statement: "Future work.", projects: ["spike"] });
      const zero = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Zero", outcome: "No citations.", approval: "Approved." });
      const one = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "One", outcome: "One citation.", approval: "Approved.", sourceRequests: [unassigned.metadata.requestId] });
      const many = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Many", outcome: "Many citations.", approval: "Approved.", sourceRequests: [unassigned.metadata.requestId, local.metadata.requestId] });
      expect(zero.goal.body).toContain("## Source Requests\n\nNone.");
      expect(one.goal.body).toContain(`## Source Requests\n\n- ${unassigned.metadata.requestId}`);
      expect(many.goal.body).toContain(`- ${unassigned.metadata.requestId}\n- ${local.metadata.requestId}`);
      expect(many.goal.metadata).not.toHaveProperty("sourceRequests");
  });

  test("rejects an unusable shared data root before Goal workflow effects", async () => {
    const repository = await temporaryRepository();
    const hostPaths = { dataRoot: "/dev/null/spike-request-store" };
    await expect(createGoal({ cwd: repository.root, hostPaths, title: "No sources", outcome: "Preserve existing workflow.", approval: "Approved." })).rejects.toThrow();
    await expect(createGoal({ cwd: repository.root, hostPaths, title: "Has source", outcome: "Must validate root.", approval: "Approved.", sourceRequests: ["request-001"] })).rejects.toThrow();
    await expect(repository.git("rev-parse", "--verify", integratedRef("spike-001"))).rejects.toThrow();
  });

  test("refuses malformed, duplicate, missing, and other-Project IDs before Goal workflow effects", async () => {
    const repository = await temporaryRepository();
    const local = await createRequest({ hostPaths: repository.hostPaths, title: "Local", statement: "Future work.", projects: ["spike"] });
      const foreign = await createRequest({ hostPaths: repository.hostPaths, title: "Foreign", statement: "Future work.", projects: ["other"] });
      for (const sourceRequests of [["bad"], [local.metadata.requestId, local.metadata.requestId], ["request-999"], [foreign.metadata.requestId]]) {
        await expect(createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Refused", outcome: "No workflow effects.", approval: "Approved.", sourceRequests })).rejects.toThrow();
        await absentGoalWorkflow(repository);
      }
  });

  test("accepts closed local Requests as immutable historical provenance", async () => {
    const repository = await temporaryRepository();
    const root = repository.dataRoot;
    const request = await createRequest({ hostPaths: repository.hostPaths, title: "Closed", statement: "Future work.", projects: ["spike"] });
      await closeRequest({ hostPaths: repository.hostPaths, requestId: request.metadata.requestId, disposition: "declined", statement: "Not now." });
      const requestFile = await readFile(requestPath(root, request.metadata.requestId), "utf8");
      const closureFile = await readFile(join(root, "requests", request.metadata.requestId, "closure.md"), "utf8");
      const goal = await createGoal({ cwd: repository.root, hostPaths: repository.hostPaths, title: "Historical", outcome: "Retain provenance.", approval: "Approved.", sourceRequests: [request.metadata.requestId] });
      expect(goal.goal.body).toContain(`- ${request.metadata.requestId}`);
      expect(await readFile(requestPath(root, request.metadata.requestId), "utf8")).toBe(requestFile);
      expect(await readFile(join(root, "requests", request.metadata.requestId, "closure.md"), "utf8")).toBe(closureFile);
  });
});
