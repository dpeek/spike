import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadChangeDecision } from "../../src/change.ts";
import { integratedRef } from "../../src/goal.ts";
import { loadImplementationReport, loadReviewReport } from "../../src/report.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const spikePath = join(import.meta.dir, "..", "..", "bin", "spike");
const worker = String.raw`
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
async function complete(payload, file = false) {
  const path = file ? join(tmpdir(), "spike-completion-" + randomUUID() + ".json") : undefined;
  if (path) await writeFile(path, JSON.stringify(payload));
  const child = Bun.spawn([${JSON.stringify(spikePath)}, "worker", "complete", ...(path ? ["--file", path] : [])], {
    cwd: process.cwd(), stdin: path ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (!path) { child.stdin.write(JSON.stringify(payload)); child.stdin.end(); }
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (path) await rm(path);
  if (code !== 0) throw new Error(stderr || stdout);
}
const ticketId = process.env.SPIKE_TICKET_ID;
const head = await git("rev-parse", "HEAD");
if (head !== process.env.SPIKE_INPUT_REVISION) throw new Error("wrong input revision");
if (ticketId === "001") {
  if (process.env.SPIKE_MODEL !== "implementation-model" || process.env.SPIKE_THINKING !== "medium") {
    throw new Error("dispatch did not use the frozen implementation selection");
  }
  if (process.env.SPIKE_TICKET_ROLE !== "implement" || process.env.SPIKE_BIN !== ${JSON.stringify(spikePath)}) {
    throw new Error("dispatch did not expose the implementation completion environment");
  }
  await writeFile("direct-cli.txt", "approved through direct CLI\n");
  await complete({
    summary: "Added direct CLI behavior.",
    verification: "Scripted verification passed.",
    assumptions: "None.", limitations: "None.", risks: "None.",
    followUp: "Independent review.", artifacts: [],
  }, true);
} else if (ticketId === "002") {
  if (process.env.SPIKE_MODEL !== "review-model" || process.env.SPIKE_THINKING !== "high") {
    throw new Error("dispatch did not use the frozen review selection");
  }
  if (process.env.SPIKE_TICKET_ROLE !== "review" || process.env.SPIKE_BIN !== ${JSON.stringify(spikePath)}) {
    throw new Error("dispatch did not expose the review completion environment");
  }
  await complete({
    reviewStatement: "The exact Candidate is approved.",
    findings: [], acceptanceAssessment: [{
      criterion: "The direct CLI Candidate is independently approved.", assessment: "met",
      evidence: "The exact Candidate contains direct-cli.txt with the expected content.",
    }], verdict: "approve", artifacts: [],
  });
} else {
  throw new Error("unexpected Ticket " + ticketId);
}
`;

async function spike(cwd: string, args: string[]): Promise<any> {
  const separator = args.indexOf("--");
  const jsonArgs = separator === -1
    ? [...args, "--json"]
    : [...args.slice(0, separator), "--json", ...args.slice(separator)];
  const child = Bun.spawn([spikePath, ...jsonArgs], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const output = JSON.parse(stdout);
  if (exitCode !== 0 || output.ok !== true) throw new Error(stdout);
  return output;
}

describe("direct CLI tracer bullet", () => {
  test("issues, dispatches, publishes implementation and approval Reports, then lands", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const hostHead = repository.head;

    const createdGoal = await spike(repository.root, [
      "goal", "create",
      "--title", "Complete the direct CLI tracer bullet",
      "--outcome", "Land one directly dispatched and reviewed Candidate.",
      "--approval", "Approved.",
    ]);
    const goalId = createdGoal.data.goal.goalId as string;
    await spike(repository.root, [
      "change", "create", "--goal", goalId,
      "--title", "Add direct CLI behavior",
      "--intent", "Exercise the complete local-clone command path.",
      "--rationale", "The CLI must preserve workflow authority across process exits.",
      "--acceptance", "The direct CLI Candidate is independently approved.",
    ]);

    const issuedImplementation = await spike(repository.root, [
      "ticket", "issue", "--goal", goalId, "--change", "001",
      "--instruction", "Implement the direct CLI Candidate.",
      "--network-access", "unrestricted",
    ]);
    expect(issuedImplementation.data.ticket).toMatchObject({
      ticketId: "001", role: "implement", model: "implementation-model", thinking: "medium",
    });

    const config = JSON.parse(await readFile(join(repository.root, "spike.json"), "utf8"));
    config.models.implement = { model: "changed-after-issuance", thinking: "minimal" };
    await writeFile(join(repository.root, "spike.json"), `${JSON.stringify(config, null, 2)}\n`);

    const implementationDispatch = await spike(repository.root, [
      "ticket", "dispatch", "--goal", goalId, "--change", "001", "--ticket", "001",
      "--worker", "direct-cli-implementer", "--", "bun", "-e", worker,
    ]);
    expect(implementationDispatch.data.execution).toMatchObject({
      exitCode: 0, model: "implementation-model", thinking: "medium",
    });
    expect(await readFile(join(repository.root, implementationDispatch.data.paths.input, "context.md"), "utf8"))
      .toContain("spike_complete_implementation");

    const implementationPublication = await spike(repository.root, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "001",
      "--commit-summary", "Add direct CLI behavior",
      "--commit-body", "Complete the direct local-clone tracer bullet.",
    ]);
    expect(implementationPublication.data).toMatchObject({
      report: { role: "implement", outcome: "completed" },
      cleanup: { status: "finalized" },
    });
    const candidateRevision = implementationPublication.data.report.candidateRevision as string;
    expect(await repository.git("show", `${candidateRevision}:direct-cli.txt`)).toBe("approved through direct CLI");

    const issuedReview = await spike(repository.root, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--role", "review",
      "--instruction", "Independently review the exact Candidate.",
      "--network-access", "unrestricted",
    ]);
    expect(issuedReview.data.ticket).toMatchObject({
      ticketId: "002", role: "review", inputRevision: candidateRevision,
      producingImplementationTicketId: "001", model: "review-model", thinking: "high",
    });

    const reviewDispatch = await spike(repository.root, [
      "ticket", "dispatch", "--goal", goalId, "--change", "001", "--ticket", "002",
      "--worker", "direct-cli-reviewer", "--", "bun", "-e", worker,
    ]);
    expect(reviewDispatch.data.execution).toMatchObject({ exitCode: 0, model: "review-model", thinking: "high" });
    expect(await readFile(join(repository.root, reviewDispatch.data.paths.input, "context.md"), "utf8"))
      .toContain("spike_complete_review");

    const reviewPublication = await spike(repository.root, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "002",
    ]);
    expect(reviewPublication.data).toMatchObject({
      report: {
        role: "review", outcome: "completed", verdict: "approve", reviewedRevision: candidateRevision,
        producingImplementationTicketId: "001",
      },
      cleanup: { status: "finalized" },
    });

    const landed = await spike(repository.root, ["change", "land", "--goal", goalId, "--change", "001"]);
    expect(landed.data).toMatchObject({ disposition: "land", approvedRevision: candidateRevision });
    expect((await loadImplementationReport(repository.root, goalId, "001", "001")).metadata.candidateRevision).toBe(candidateRevision);
    expect((await loadReviewReport(repository.root, goalId, "001", "002")).metadata.verdict).toBe("approve");
    expect((await loadChangeDecision(repository.root, goalId, "001")).metadata.disposition).toBe("land");
    expect(await repository.git("rev-parse", integratedRef(goalId))).toBe(candidateRevision);
    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
  }, 30_000);
});
