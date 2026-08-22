import { describe, expect, onTestFinished, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { publishImplementationReport } from "../../src/report.ts";
import { reportPath } from "../../src/ticket.ts";
import { dispatchPiTicket, loadFinishedWorkerExecution, observeWorker } from "../../src/worker.ts";
import type { HerdrOperations, SplitHerdrPaneInput } from "../../src/herdr.ts";
import { temporaryRepository } from "../support/repository.ts";

const spikePath = join(import.meta.dir, "..", "..", "bin", "spike");

async function fakePi(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "spike-fake-pi-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "pi");
  await writeFile(executable, `#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await writeFile(process.env.FAKE_PI_ARGS, JSON.stringify(args));
const value = (name) => args[args.indexOf(name) + 1];
const role = process.env.SPIKE_TICKET_ROLE;
const completion = role === "implement" ? "spike_complete_implementation" : "spike_complete_review";
const blocked = role === "implement" ? "spike_block_implementation" : "spike_block_review";
const otherCompletion = role === "implement" ? "spike_complete_review" : "spike_complete_implementation";
const otherBlocked = role === "implement" ? "spike_block_review" : "spike_block_implementation";
const headed = process.env.FAKE_PI_HOST === "herdr";
if (headed ? args.includes("--print") : !args.includes("--print")) throw new Error("Pi mode does not match its host");
if (!args.includes("--no-session") || !args.includes("--no-approve")) throw new Error("Pi session is not fresh");
if (!args.includes("--no-extensions") || !args.includes("--no-context-files") || !args.includes("--no-skills") || !args.includes("--no-prompt-templates")) throw new Error("Pi discovery is not disabled");
if (value("--model") !== process.env.SPIKE_MODEL || value("--thinking") !== process.env.SPIKE_THINKING) throw new Error("Pi selection is not frozen");
if (value("--tools") !== "read,bash,edit,write," + completion + "," + blocked || value("--tools").includes(otherCompletion) || value("--tools").includes(otherBlocked)) throw new Error("wrong terminal tool exposure");
for (const name of ["ticket.md", "context.md"]) {
  const path = process.env.SPIKE_INPUT_DIR + "/" + name;
  if (!args.includes("@" + path)) throw new Error("missing attached " + name);
  await readFile(path, "utf8");
}
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: process.cwd() }).stdout.toString().trim();
if (head !== process.env.SPIKE_INPUT_REVISION) throw new Error("wrong checkout revision");
if (process.env.FAKE_PI_MODE === "failed") {
  console.log('{"kind":"report","outcome":"completed"}');
  process.exit(23);
}
if (process.env.FAKE_PI_MODE === "missing") {
  console.log('{"kind":"report","outcome":"completed"}');
  process.exit(0);
}
let payload;
if (role === "implement") {
  await writeFile("pi-dispatched.txt", "completed by controlled Pi dispatch\\n");
  payload = { summary: "Implemented through Pi.", verification: "Fake Pi verified launcher arguments.", assumptions: "None.", limitations: "None.", risks: "None.", followUp: "Review independently.", artifacts: [] };
} else {
  payload = { reviewStatement: "The exact Pi Candidate is approved.", findings: [], acceptanceAssessment: [{ criterion: "Pi dispatch produces publishable exchange output.", assessment: "met", evidence: "The exact Candidate contains pi-dispatched.txt." }], verdict: "approve", artifacts: [] };
}
const child = Bun.spawn([process.env.SPIKE_BIN, "worker", "complete", "--json"], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
child.stdin.write(JSON.stringify(payload));
child.stdin.end();
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) throw new Error(stderr || stdout);
console.log('{"kind":"report","outcome":"completed"}');
`);
  await chmod(executable, 0o700);
  return executable;
}

async function spike(repository: Awaited<ReturnType<typeof temporaryRepository>>, args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([spikePath, ...args, "--json"], {
    cwd: repository.root,
    env: { ...process.env, SPIKE_DATA_DIR: repository.dataRoot, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, output: JSON.parse(stdout) };
}

async function issuedRepository() {
  const repository = await temporaryRepository();
  const goal = await createGoal({
    cwd: repository.root, hostPaths: repository.hostPaths, title: "Dispatch a controlled Pi worker",
    outcome: "Produce exchange output through one frozen launcher.",
    approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  await createChange({
    cwd: repository.root, hostPaths: repository.hostPaths, goalId,
    title: "Add Pi dispatch",
    intent: "Launch one fresh Pi worker.",
    rationale: "The planner must not assemble Pi commands.",
    acceptanceCriteria: ["Pi dispatch produces publishable exchange output."],
  });
  return { repository, goalId };
}

describe("controlled Pi dispatch", () => {
  test("uses headed Pi in Herdr with the immutable prompt and publishes through the standard exchange", async () => {
    const { repository, goalId } = await issuedRepository();
    const pi = await fakePi();
    const argsPath = join(dirname(pi), "headed-args.json");
    const identity = { goalId, changeId: "001", ticketId: "001" };
    const issued = await spike(repository, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--instruction", "Implement through headed Pi.",
      "--model", "frozen-headed-model", "--thinking", "high",
    ]);
    expect(issued.exitCode).toBe(0);
    // Pi dispatch shares frozen Ticket loading with controlled worker dispatch.
    // Incomplete agent defaults after issuance must not prevent the frozen
    // workspace assignment from reaching the worker.
    await writeFile(
      join(repository.root, "spike.json"),
      '{"project":{"slug":"spike"},"agents":{"planner":{"model":"changed","thinking":"minimal"}}}\n',
    );

    let paneInput: SplitHerdrPaneInput | undefined;
    let closes = 0;
    const herdr: HerdrOperations = {
      async createTab() { throw new Error("not called"); },
      async splitPane(input) {
        paneInput = input;
        return { pane: "headed-pane" };
      },
      async run(pane, command) {
        expect(pane).toBe("headed-pane");
        const child = Bun.spawn([command], {
          cwd: paneInput!.cwd,
          env: {
            ...process.env,
            ...paneInput!.environment,
            FAKE_PI_ARGS: argsPath,
            FAKE_PI_HOST: "herdr",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
      },
      async status() { return "done"; },
      async read() { return "headed Pi transcript"; },
      async attach() { return 0; },
      async closePane() { closes++; },
      async closeTab() { throw new Error("not called"); },
    };

    const dispatched = await dispatchPiTicket({
      cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
      worker: "headed-pi-implementer",
      host: "herdr",
      piExecutable: pi,
      herdr,
    });
    expect(dispatched).toMatchObject({ hosting: "herdr", status: "working" });
    const headedArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(headedArgs).not.toContain("--print");
    expect(headedArgs).toContain("--no-session");
    expect(headedArgs).toContain("--no-approve");
    expect(headedArgs).toContain("--no-extensions");
    expect(headedArgs).toContain("--no-skills");
    expect(headedArgs).toContain("--no-prompt-templates");
    expect(headedArgs).toContain("--no-context-files");
    expect(headedArgs[headedArgs.indexOf("--model") + 1]).toBe("frozen-headed-model");
    expect(headedArgs[headedArgs.indexOf("--thinking") + 1]).toBe("high");
    expect(headedArgs[headedArgs.indexOf("--tools") + 1]).toBe("read,bash,edit,write,spike_complete_implementation,spike_block_implementation");
    expect(headedArgs.filter((arg) => arg === "--extension")).toHaveLength(1);
    expect(headedArgs[headedArgs.indexOf("--extension") + 1]).toEndWith("/src/pi-worker-extension.ts");
    expect(headedArgs.at(-1)).toBe(
      "Execute the attached immutable implement Ticket in this exact checkout. Finish with spike_complete_implementation, or use spike_block_implementation only when a condition outside the worker's control prevents completion.",
    );
    expect(headedArgs).toContain(`@${dispatched.exchange.inputDirectory}/ticket.md`);
    expect(headedArgs).toContain(`@${dispatched.exchange.inputDirectory}/context.md`);
    expect(await Bun.file(reportPath(repository.project, goalId, "001", "001")).exists()).toBe(false);

    expect(await observeWorker(repository.project, identity, herdr)).toEqual({ hosting: "herdr", status: "done" });
    const execution = await loadFinishedWorkerExecution(repository.project, identity);
    expect(execution.exitCode).toBe(0);
    const publication = await publishImplementationReport({
      cwd: repository.root, hostPaths: repository.hostPaths, ...identity,
      execution,
      commitMessage: { summary: "Complete headed Pi dispatch" },
      runtimeOperations: {
        async stop(runtime, _identity) {
          expect(runtime).toMatchObject({ host: "herdr", pane: "headed-pane" });
          expect(await Bun.file(reportPath(repository.project, goalId, "001", "001")).exists()).toBe(true);
          if ((runtime as { host: string }).host !== "herdr") throw new Error("expected Herdr runtime");
          await herdr.closePane((runtime as { pane: string }).pane);
        },
        async cleanup(runtime) { await rm((runtime as { workspace: string }).workspace, { recursive: true, force: true }); },
      },
    });
    expect(closes).toBe(1);
    expect(publication.cleanup).toEqual({ status: "finalized" });
    expect(publication.report.metadata).toMatchObject({
      role: "implement",
      outcome: "completed",
      inputRevision: issued.output.data.ticket.inputRevision,
      execution: { model: "frozen-headed-model", thinking: "high" },
    });
    expect(await repository.git("show", `${publication.report.metadata.candidateRevision}:pi-dispatched.txt`))
      .toBe("completed by controlled Pi dispatch");
  }, 30_000);

  test("uses the immutable Ticket selection and role tools, then leaves publication explicit", async () => {
    const { repository, goalId } = await issuedRepository();
    const pi = await fakePi();
    const argsPath = join(dirname(pi), "args.json");
    const environment = { SPIKE_PI_BIN: pi, FAKE_PI_ARGS: argsPath };

    const issued = await spike(repository, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--instruction", "Implement through Pi.",
      "--model", "frozen-implementation-model", "--thinking", "medium",
    ]);
    expect(issued.exitCode).toBe(0);
    await writeFile(join(repository.root, "spike.json"), '{"project":{"slug":"spike"},"agents":{"planner":{"model":"changed","thinking":"minimal"},"implement":{"model":"changed","thinking":"minimal","isolation":"workspace","credentialGrants":[]},"review":{"model":"changed","thinking":"minimal","isolation":"workspace","credentialGrants":[]}}}\n');

    for (const override of ["--model", "--thinking", "--role", "--prompt", "--extension"]) {
      const rejected = await spike(repository, [
        "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "001", "--worker", "pi-implementer", override, "override",
      ], environment);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.output.error.message).toBe(`unknown option: ${override}`);
    }

    const implemented = await spike(repository, [
      "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "001", "--worker", "pi-implementer", "--host", "direct",
    ], environment);
    expect(implemented.exitCode).toBe(0);
    expect(implemented.stderr).toBe("");
    expect(implemented.output).toMatchObject({
      ok: true,
      command: "ticket dispatch-pi",
      data: {
        classification: "accepted-submission",
        execution: { model: "frozen-implementation-model", thinking: "medium", exitCode: 0 },
      },
    });
    const implementationArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(implementationArgs).toContain("--print");
    expect(implementationArgs).toContain("--no-session");
    expect(implementationArgs.join(" ")).toContain("spike_complete_implementation");
    expect(implementationArgs.join(" ")).toContain("spike_block_implementation");
    expect(implementationArgs).not.toContain("--continue");
    expect(await Bun.file(reportPath(repository.project, goalId, "001", "001")).exists()).toBe(false);

    const publication = await spike(repository, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "001", "--commit-summary", "Add controlled Pi dispatch",
    ]);
    expect(publication.exitCode).toBe(0);
    const candidate = publication.output.data.report.candidateRevision as string;
    expect(await repository.git("show", `${candidate}:pi-dispatched.txt`)).toBe("completed by controlled Pi dispatch");

    const reviewIssue = await spike(repository, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--role", "review", "--instruction", "Review through Pi.",
      "--model", "frozen-review-model", "--thinking", "high",
    ]);
    expect(reviewIssue.exitCode).toBe(0);
    await writeFile(join(repository.root, "spike.json"), '{"project":{"slug":"spike"},"agents":{"planner":{"model":"later","thinking":"off"},"implement":{"model":"later","thinking":"off","isolation":"workspace","credentialGrants":[]},"review":{"model":"later","thinking":"off","isolation":"workspace","credentialGrants":[]}}}\n');

    const reviewed = await spike(repository, [
      "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "002", "--worker", "pi-reviewer", "--host", "direct",
    ], environment);
    expect(reviewed.output).toMatchObject({
      ok: true,
      data: { classification: "accepted-submission", execution: { model: "frozen-review-model", thinking: "high" } },
    });
    const reviewArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(reviewArgs.join(" ")).toContain("spike_complete_review");
    expect(reviewArgs.join(" ")).toContain("spike_block_review");
    expect(reviewArgs.join(" ")).not.toContain("spike_complete_implementation");
    expect(reviewArgs.join(" ")).not.toContain("spike_block_implementation");
    expect(await Bun.file(reportPath(repository.project, goalId, "001", "002")).exists()).toBe(false);

    const reviewPublication = await spike(repository, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "002",
    ]);
    expect(reviewPublication.output).toMatchObject({ ok: true, data: { report: { outcome: "completed", verdict: "approve" } } });
  }, 30_000);

  test("classifies missing Submission and failed execution without treating terminal text as a Report", async () => {
    for (const [mode, classification] of [["missing", "missing-submission"], ["failed", "failed-execution"]] as const) {
      const { repository, goalId } = await issuedRepository();
      const pi = await fakePi();
      await spike(repository, [
        "ticket", "issue", "--goal", goalId, "--change", "001", "--instruction", "Do not complete.",
      ]);
      const dispatched = await spike(repository, [
        "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "001", "--worker", `pi-${mode}`, "--host", "direct",
      ], { SPIKE_PI_BIN: pi, FAKE_PI_ARGS: join(dirname(pi), "args.json"), FAKE_PI_MODE: mode });
      expect(dispatched.exitCode).toBe(0);
      expect(dispatched.output).toMatchObject({
        ok: true,
        data: { classification, execution: { exitCode: mode === "failed" ? 23 : 0 } },
      });
      expect(dispatched.output.data.execution.stdout).toContain('"outcome":"completed"');
      expect(await Bun.file(reportPath(repository.project, goalId, "001", "001")).exists()).toBe(false);
    }
  }, 30_000);
});
