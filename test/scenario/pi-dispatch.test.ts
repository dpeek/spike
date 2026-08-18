import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChange } from "../../src/change.ts";
import { createGoal } from "../../src/goal.ts";
import { publishImplementationReport } from "../../src/report.ts";
import { reportPath } from "../../src/ticket.ts";
import { dispatchPiTicket, loadFinishedLocalExecution, observeWorker } from "../../src/worker.ts";
import type { CreateHerdrTabInput, HerdrOperations } from "../../src/herdr.ts";
import { temporaryRepository } from "../support/repository.ts";

const spikePath = join(import.meta.dir, "..", "..", "bin", "spike");
const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakePi(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "spike-fake-pi-"));
  directories.push(directory);
  const executable = join(directory, "pi");
  await writeFile(executable, `#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await writeFile(process.env.FAKE_PI_ARGS, JSON.stringify(args));
const value = (name) => args[args.indexOf(name) + 1];
const role = process.env.SPIKE_TICKET_ROLE;
const completion = role === "implement" ? "spike_complete_implementation" : "spike_complete_review";
const other = role === "implement" ? "spike_complete_review" : "spike_complete_implementation";
const headed = process.env.FAKE_PI_HOST === "herdr";
if (headed ? args.includes("--print") : !args.includes("--print")) throw new Error("Pi mode does not match its host");
if (!args.includes("--no-session") || !args.includes("--no-approve")) throw new Error("Pi session is not fresh");
if (!args.includes("--no-extensions") || !args.includes("--no-context-files") || !args.includes("--no-skills") || !args.includes("--no-prompt-templates")) throw new Error("Pi discovery is not disabled");
if (value("--model") !== process.env.SPIKE_MODEL || value("--thinking") !== process.env.SPIKE_THINKING) throw new Error("Pi selection is not frozen");
if (value("--tools") !== "read,bash,edit,write," + completion || value("--tools").includes(other)) throw new Error("wrong completion tool exposure");
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

async function spike(cwd: string, args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([spikePath, ...args, "--json"], {
    cwd,
    env: { ...process.env, ...environment },
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
  repositories.push(repository);
  const goal = await createGoal({
    cwd: repository.root,
    title: "Dispatch a controlled Pi worker",
    outcome: "Produce exchange output through one frozen launcher.",
    approval: "Approved.",
  });
  const goalId = goal.goal.metadata.goalId;
  await createChange({
    cwd: repository.root,
    goalId,
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
    const argsPath = join(directories[0]!, "headed-args.json");
    const identity = { goalId, changeId: "001", ticketId: "001" };
    const issued = await spike(repository.root, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--instruction", "Implement through headed Pi.",
      "--network-access", "unrestricted", "--model", "frozen-headed-model", "--thinking", "high",
    ]);
    expect(issued.exitCode).toBe(0);

    let tabInput: CreateHerdrTabInput | undefined;
    let closes = 0;
    const herdr: HerdrOperations = {
      async createTab(input) {
        tabInput = input;
        return { tab: "headed-tab", pane: "headed-pane" };
      },
      async run(pane, command) {
        expect(pane).toBe("headed-pane");
        const child = Bun.spawn([command], {
          cwd: tabInput!.cwd,
          env: {
            ...process.env,
            ...tabInput!.environment,
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
      async closeTab() { closes++; },
    };

    const dispatched = await dispatchPiTicket({
      cwd: repository.root,
      ...identity,
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
    expect(headedArgs[headedArgs.indexOf("--tools") + 1]).toBe("read,bash,edit,write,spike_complete_implementation");
    expect(headedArgs.filter((arg) => arg === "--extension")).toHaveLength(1);
    expect(headedArgs[headedArgs.indexOf("--extension") + 1]).toEndWith("/src/pi-worker-extension.ts");
    expect(headedArgs.at(-1)).toBe(
      "Execute the attached immutable implement Ticket in this exact checkout. Finish only with spike_complete_implementation.",
    );
    expect(headedArgs).toContain(`@${dispatched.exchange.inputDirectory}/ticket.md`);
    expect(headedArgs).toContain(`@${dispatched.exchange.inputDirectory}/context.md`);
    expect(await Bun.file(reportPath(repository.root, goalId, "001", "001")).exists()).toBe(false);

    expect(await observeWorker(repository.root, identity, herdr)).toEqual({ hosting: "herdr", status: "done" });
    const execution = await loadFinishedLocalExecution(repository.root, identity);
    expect(execution.exitCode).toBe(0);
    const publication = await publishImplementationReport({
      cwd: repository.root,
      ...identity,
      execution,
      commitMessage: { summary: "Complete headed Pi dispatch" },
      resourceOperations: {
        async stop(_pid, _identity, handles) {
          expect(handles).toEqual({ tab: "headed-tab", pane: "headed-pane" });
          expect(await Bun.file(reportPath(repository.root, goalId, "001", "001")).exists()).toBe(true);
          await herdr.closeTab(handles!.tab);
        },
        async removeWorkspace(path) { await rm(path, { recursive: true, force: true }); },
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
    const argsPath = join(directories[0]!, "args.json");
    const environment = { SPIKE_PI_BIN: pi, FAKE_PI_ARGS: argsPath };

    const issued = await spike(repository.root, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--instruction", "Implement through Pi.",
      "--network-access", "unrestricted", "--model", "frozen-implementation-model", "--thinking", "medium",
    ]);
    expect(issued.exitCode).toBe(0);
    await writeFile(join(repository.root, "spike.json"), '{"models":{"planner":{"model":"changed","thinking":"minimal"},"implement":{"model":"changed","thinking":"minimal"},"review":{"model":"changed","thinking":"minimal"}}}\n');

    for (const override of ["--model", "--thinking", "--role", "--prompt", "--extension"]) {
      const rejected = await spike(repository.root, [
        "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "001", "--worker", "pi-implementer", override, "override",
      ], environment);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.output.error.message).toBe(`unknown option: ${override}`);
    }

    const implemented = await spike(repository.root, [
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
    expect(implementationArgs).not.toContain("--continue");
    expect(await Bun.file(reportPath(repository.root, goalId, "001", "001")).exists()).toBe(false);

    const publication = await spike(repository.root, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "001", "--commit-summary", "Add controlled Pi dispatch",
    ]);
    expect(publication.exitCode).toBe(0);
    const candidate = publication.output.data.report.candidateRevision as string;
    expect(await repository.git("show", `${candidate}:pi-dispatched.txt`)).toBe("completed by controlled Pi dispatch");

    const reviewIssue = await spike(repository.root, [
      "ticket", "issue", "--goal", goalId, "--change", "001", "--role", "review", "--instruction", "Review through Pi.",
      "--network-access", "unrestricted", "--model", "frozen-review-model", "--thinking", "high",
    ]);
    expect(reviewIssue.exitCode).toBe(0);
    await writeFile(join(repository.root, "spike.json"), '{"models":{"planner":{"model":"later","thinking":"off"},"implement":{"model":"later","thinking":"off"},"review":{"model":"later","thinking":"off"}}}\n');

    const reviewed = await spike(repository.root, [
      "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "002", "--worker", "pi-reviewer", "--host", "direct",
    ], environment);
    expect(reviewed.output).toMatchObject({
      ok: true,
      data: { classification: "accepted-submission", execution: { model: "frozen-review-model", thinking: "high" } },
    });
    const reviewArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(reviewArgs.join(" ")).toContain("spike_complete_review");
    expect(reviewArgs.join(" ")).not.toContain("spike_complete_implementation");
    expect(await Bun.file(reportPath(repository.root, goalId, "001", "002")).exists()).toBe(false);

    const reviewPublication = await spike(repository.root, [
      "report", "publish", "--goal", goalId, "--change", "001", "--ticket", "002",
    ]);
    expect(reviewPublication.output).toMatchObject({ ok: true, data: { report: { outcome: "completed", verdict: "approve" } } });
  }, 30_000);

  test("classifies missing Submission and failed execution without treating terminal text as a Report", async () => {
    for (const [mode, classification] of [["missing", "missing-submission"], ["failed", "failed-execution"]] as const) {
      const { repository, goalId } = await issuedRepository();
      const pi = await fakePi();
      await spike(repository.root, [
        "ticket", "issue", "--goal", goalId, "--change", "001", "--instruction", "Do not complete.", "--network-access", "unrestricted",
      ]);
      const dispatched = await spike(repository.root, [
        "ticket", "dispatch-pi", "--goal", goalId, "--change", "001", "--ticket", "001", "--worker", `pi-${mode}`, "--host", "direct",
      ], { SPIKE_PI_BIN: pi, FAKE_PI_ARGS: join(directories.at(-1)!, "args.json"), FAKE_PI_MODE: mode });
      expect(dispatched.exitCode).toBe(0);
      expect(dispatched.output).toMatchObject({
        ok: true,
        data: { classification, execution: { exitCode: mode === "failed" ? 23 : 0 } },
      });
      expect(dispatched.output.data.execution.stdout).toContain('"outcome":"completed"');
      expect(await Bun.file(reportPath(repository.root, goalId, "001", "001")).exists()).toBe(false);
    }
  }, 30_000);
});
