import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function fakes() {
  const directory = await mkdtemp(join(tmpdir(), "spike-pi-supervisor-"));
  directories.push(directory);
  const pi = join(directory, "fake-pi");
  const spike = join(directory, "fake-spike");
  const piRecord = join(directory, "pi.json");
  const spikeRecord = join(directory, "spike.json");
  const toolResult = join(directory, "tool-result.json");

  await writeFile(spike, `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
await writeFile(process.env.FAKE_SPIKE_RECORD, JSON.stringify({ cwd: process.cwd(), args, stdin }));
console.log(JSON.stringify({ ok: true, command: "status", data: { source: "durable-spike-response", goals: [] } }));
process.exit(17);
`);
  await writeFile(pi, `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const args = process.argv.slice(2);
await writeFile(process.env.FAKE_PI_RECORD, JSON.stringify({ cwd: process.cwd(), args, spikeBin: process.env.SPIKE_BIN }));
const extensionPath = args[args.indexOf("--extension") + 1];
const extension = await import(pathToFileURL(extensionPath).href);
const tools = [];
extension.default({ registerTool: (tool) => tools.push(tool), on() {}, sendMessage() {} });
const result = await tools.find((tool) => tool.name === "spike_status").execute("call", {}, undefined, undefined, { cwd: process.cwd() });
await writeFile(process.env.FAKE_TOOL_RESULT, JSON.stringify(result));
console.log('{"plannerText":"all Tickets completed","report":{"outcome":"completed"}}');
process.exit(23);
`);
  await Promise.all([chmod(pi, 0o700), chmod(spike, 0o700)]);
  return { pi, spike, piRecord, spikeRecord, toolResult };
}

describe("direct Pi supervisor", () => {
  test("launches the configured planner with only the supervisor extension and delegates facts to fake Spike", async () => {
    const repository = await temporaryRepository();
    repositories.push(repository);
    const fake = await fakes();

    const child = Bun.spawn([spikePath, "planner"], {
      cwd: repository.root,
      env: {
        ...process.env,
        SPIKE_PI_BIN: fake.pi,
        SPIKE_BIN: fake.spike,
        FAKE_PI_RECORD: fake.piRecord,
        FAKE_SPIKE_RECORD: fake.spikeRecord,
        FAKE_TOOL_RESULT: fake.toolResult,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(23);
    expect(stderr).toBe("");
    expect(stdout).toContain('"plannerText":"all Tickets completed"');

    const planner = JSON.parse(await readFile(fake.piRecord, "utf8"));
    expect(await realpath(planner.cwd)).toBe(await realpath(repository.root));
    expect(planner.spikeBin).toBe(fake.spike);
    expect(planner.args).toContain("--no-approve");
    expect(planner.args).toContain("--no-extensions");
    expect(planner.args.filter((arg: string) => arg === "--extension")).toHaveLength(1);
    expect(planner.args[planner.args.indexOf("--extension") + 1]).toEndWith("/src/pi-supervisor-extension.ts");
    expect(planner.args[planner.args.indexOf("--model") + 1]).toBe("planner-model");
    expect(planner.args[planner.args.indexOf("--thinking") + 1]).toBe("high");
    expect(planner.args[planner.args.indexOf("--tools") + 1]).toBe(
      "read,grep,find,ls,spike_begin_step,spike_status,spike_create_goal,spike_revise_plan,spike_create_change,spike_decide_change,spike_issue_implement,spike_issue_review,spike_issue_remediate,spike_dispatch_pi,spike_worker_status,spike_worker_read,spike_publish_report,spike_recover",
    );
    expect(planner.args).not.toContain("--print");

    const spikeInvocation = JSON.parse(await readFile(fake.spikeRecord, "utf8"));
    expect(await realpath(spikeInvocation.cwd)).toBe(await realpath(repository.root));
    expect(spikeInvocation).toMatchObject({ args: ["status", "--json"], stdin: "" });
    const result = JSON.parse(await readFile(fake.toolResult, "utf8"));
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      command: "status",
      data: { source: "durable-spike-response", goals: [] },
    });
    expect(await Bun.file(join(repository.root, ".spike")).exists()).toBe(false);
  });
});
