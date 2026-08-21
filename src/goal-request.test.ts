import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoal, goalPath, integratedRef } from "./goal.ts";
import { createRequest, closeRequest, requestPath } from "./request.ts";
import { planPath } from "./plan.ts";
import { temporaryRepository } from "../test/support/repository.ts";

const repositories: Array<{ remove: () => Promise<void> }> = [];
const dataRoots: string[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
  await Promise.all(dataRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spike-goal-requests-")));
  dataRoots.push(root);
  return root;
}

async function absentGoalWorkflow(repository: Awaited<ReturnType<typeof temporaryRepository>>) {
  expect(await Bun.file(goalPath(repository.root, "spike-001")).exists()).toBe(false);
  expect(await Bun.file(planPath(repository.root, "spike-001")).exists()).toBe(false);
  await expect(repository.git("rev-parse", "--verify", integratedRef("spike-001"))).rejects.toThrow();
}

describe("Goal source Request provenance", () => {
  test("renders zero, one, and many eligible Request IDs without metadata changes", async () => {
    const repository = await temporaryRepository(); repositories.push(repository);
    const root = await dataRoot();
    const previous = process.env["SPIKE_DATA_DIR"]; process.env["SPIKE_DATA_DIR"] = root;
    try {
      const unassigned = await createRequest({ title: "Unassigned", statement: "Future work." });
      const local = await createRequest({ title: "Local", statement: "Future work.", projects: ["spike"] });
      const zero = await createGoal({ cwd: repository.root, title: "Zero", outcome: "No citations.", approval: "Approved." });
      const one = await createGoal({ cwd: repository.root, title: "One", outcome: "One citation.", approval: "Approved.", sourceRequests: [unassigned.metadata.requestId] });
      const many = await createGoal({ cwd: repository.root, title: "Many", outcome: "Many citations.", approval: "Approved.", sourceRequests: [unassigned.metadata.requestId, local.metadata.requestId] });
      expect(zero.goal.body).toContain("## Source Requests\n\nNone.");
      expect(one.goal.body).toContain(`## Source Requests\n\n- ${unassigned.metadata.requestId}`);
      expect(many.goal.body).toContain(`- ${unassigned.metadata.requestId}\n- ${local.metadata.requestId}`);
      expect(many.goal.metadata).not.toHaveProperty("sourceRequests");
    } finally { previous === undefined ? delete process.env["SPIKE_DATA_DIR"] : process.env["SPIKE_DATA_DIR"] = previous; }
  });

  test("rejects an unusable shared data root before Goal workflow effects", async () => {
    const repository = await temporaryRepository(); repositories.push(repository);
    const saved = Object.fromEntries(["SPIKE_DATA_DIR", "XDG_DATA_HOME", "HOME"].map((name) => [name, process.env[name]]));
    process.env["SPIKE_DATA_DIR"] = "";
    process.env["XDG_DATA_HOME"] = "/dev/null/spike-request-store";
    process.env["HOME"] = "/dev/null/spike-home";
    try {
      await expect(createGoal({ cwd: repository.root, title: "No sources", outcome: "Preserve existing workflow.", approval: "Approved." })).rejects.toThrow("SPIKE_DATA_DIR must not be blank");
      await expect(createGoal({ cwd: repository.root, title: "Has source", outcome: "Must validate root.", approval: "Approved.", sourceRequests: ["request-001"] })).rejects.toThrow("SPIKE_DATA_DIR must not be blank");
      await expect(repository.git("rev-parse", "--verify", integratedRef("spike-001"))).rejects.toThrow();
    } finally {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  });

  test("refuses malformed, duplicate, missing, and other-Project IDs before Goal workflow effects", async () => {
    const repository = await temporaryRepository(); repositories.push(repository);
    const root = await dataRoot();
    const previous = process.env["SPIKE_DATA_DIR"]; process.env["SPIKE_DATA_DIR"] = root;
    try {
      const local = await createRequest({ title: "Local", statement: "Future work.", projects: ["spike"] });
      const foreign = await createRequest({ title: "Foreign", statement: "Future work.", projects: ["other"] });
      for (const sourceRequests of [["bad"], [local.metadata.requestId, local.metadata.requestId], ["request-999"], [foreign.metadata.requestId]]) {
        await expect(createGoal({ cwd: repository.root, title: "Refused", outcome: "No workflow effects.", approval: "Approved.", sourceRequests })).rejects.toThrow();
        await absentGoalWorkflow(repository);
      }
    } finally { previous === undefined ? delete process.env["SPIKE_DATA_DIR"] : process.env["SPIKE_DATA_DIR"] = previous; }
  });

  test("accepts closed local Requests as immutable historical provenance", async () => {
    const repository = await temporaryRepository(); repositories.push(repository);
    const root = await dataRoot();
    const previous = process.env["SPIKE_DATA_DIR"]; process.env["SPIKE_DATA_DIR"] = root;
    try {
      const request = await createRequest({ title: "Closed", statement: "Future work.", projects: ["spike"] });
      await closeRequest({ requestId: request.metadata.requestId, disposition: "declined", statement: "Not now." });
      const requestFile = await readFile(requestPath(root, request.metadata.requestId), "utf8");
      const closureFile = await readFile(join(root, "requests", request.metadata.requestId, "closure.md"), "utf8");
      const goal = await createGoal({ cwd: repository.root, title: "Historical", outcome: "Retain provenance.", approval: "Approved.", sourceRequests: [request.metadata.requestId] });
      expect(goal.goal.body).toContain(`- ${request.metadata.requestId}`);
      expect(await readFile(requestPath(root, request.metadata.requestId), "utf8")).toBe(requestFile);
      expect(await readFile(join(root, "requests", request.metadata.requestId, "closure.md"), "utf8")).toBe(closureFile);
    } finally { previous === undefined ? delete process.env["SPIKE_DATA_DIR"] : process.env["SPIKE_DATA_DIR"] = previous; }
  });
});
