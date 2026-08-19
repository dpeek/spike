import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeDocument } from "../../src/durable-state.ts";
import { candidateRef } from "../../src/git-change.ts";
import { loadReport, publishImplementationReport } from "../../src/report.ts";
import { reportPath } from "../../src/ticket.ts";
import { dispatchLocalImplementation } from "../../src/worker.ts";
import { temporaryRepository } from "../support/repository.ts";

const repositories: Array<{ root: string; remove: () => Promise<void> }> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await Bun.spawn(["chmod", "-R", "u+w", repository.root], { stdout: "ignore", stderr: "ignore" }).exited;
    await repository.remove();
  }
});

const workerSource = String.raw`
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function git(...args) {
  const child = Bun.spawn(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

const output = process.env.SPIKE_OUTPUT_DIR;
await git("config", "user.name", "Controlled Worker");
await git("config", "user.email", "worker@example.test");
await writeFile("implemented.txt", "started at " + process.env.SPIKE_INPUT_REVISION + "\n");
await git("add", "implemented.txt");
await git("commit", "--quiet", "-m", "worker checkpoint");
const workerRevision = await git("rev-parse", "HEAD");
await mkdir(join(output, "artifacts"), { recursive: true });
const artifact = "verification passed\n";
await writeFile(join(output, "artifacts", "verification.txt"), artifact);
const sha256 = createHash("sha256").update(artifact).digest("hex");
const metadata = {
  kind: "submission",
  goalId: process.env.SPIKE_GOAL_ID,
  changeId: process.env.SPIKE_CHANGE_ID,
  ticketId: process.env.SPIKE_TICKET_ID,
  outcome: "completed",
  workerRevision,
  artifacts: [{ path: "artifacts/verification.txt", sha256 }],
};
const body = "# Implementation evidence\n\n## Summary\n\nAdded the requested product file.\n\n## Verification\n\nControlled verification passed.\n\n## Assumptions\n\nNone.\n\n## Limitations\n\nNone.\n\n## Risks\n\nNone.\n\n## Follow-up\n\nNone.\n";
await writeFile(join(output, "submission.md"), "---\n" + JSON.stringify(metadata, null, 2) + "\n---\n\n" + body);
const bundle = Bun.spawn(["git", "bundle", "create", join(output, "repository.bundle"), "HEAD"], {
  cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
});
const [bundleCode, bundleError] = await Promise.all([bundle.exited, new Response(bundle.stderr).text()]);
if (bundleCode !== 0) throw new Error(bundleError);
`;

async function fixture() {
  const repository = await temporaryRepository();
  repositories.push(repository);
  const goalId = "spike-001";
  const ticketId = "001";
  const baseRevision = repository.head;
  const ticketDirectory = join(repository.root, ".spike", "goals", goalId, "changes", "001", "tickets", ticketId);
  await mkdir(ticketDirectory, { recursive: true });
  await writeFile(
    join(ticketDirectory, "..", "..", "change.md"),
    serializeDocument(
      {
        kind: "change",
        goalId,
        changeId: "001",
        createdAt: "2026-03-20T10:01:00.000Z",
        baseRevision,
      },
      "# Implement the exchange\n\n## Acceptance criteria\n\n- Publish a normalized Candidate and immutable Report.\n",
    ),
  );
  await writeFile(
    join(ticketDirectory, "ticket.md"),
    serializeDocument(
      {
        kind: "ticket",
        goalId,
        changeId: "001",
        ticketId,
        issuedAt: "2026-03-20T10:02:00.000Z",
        role: "implement",
        inputRevision: baseRevision,
        model: "implementation-model",
        thinking: "medium",
        executionPolicy: { isolation: "workspace", networkAccess: "unrestricted", credentialGrants: [] },
        guidance: { step: "implement", revision: baseRevision },
      },
      "# Implement Change\n\n## Instruction\n\nAdd the implementation marker.\n",
    ),
  );

  await writeFile(join(repository.root, "host-only.txt"), "newer host commit\n");
  await repository.git("add", "host-only.txt");
  await repository.git("commit", "--quiet", "-m", "Host moved after Change creation");
  const hostHead = await repository.git("rev-parse", "HEAD");
  await writeFile(join(repository.root, "README.md"), "dirty host edit\n");
  await writeFile(
    join(repository.root, "spike.json"),
    '{"project":{"slug":"spike"},"models":{"planner":{"model":"changed","thinking":"minimal"},"implement":{"model":"changed","thinking":"minimal"},"review":{"model":"changed","thinking":"minimal"}}}\n',
  );
  const dirtyDiff = await repository.git("diff", "--", "README.md");
  const indexTree = await repository.git("write-tree");

  const dispatched = await dispatchLocalImplementation({
    cwd: repository.root,
    goalId,
    changeId: "001",
    ticketId,
    command: ["bun", "-e", workerSource],
    worker: "controlled-script",
    clock: (() => {
      const times = [new Date("2026-03-20T10:03:00.000Z"), new Date("2026-03-20T10:04:00.000Z")];
      return () => times.shift()!;
    })(),
  });

  return { repository, goalId, ticketId, baseRevision, hostHead, dirtyDiff, indexTree, dispatched };
}

async function makeInputRemovable(inputDirectory: string): Promise<void> {
  await chmod(inputDirectory, 0o700);
  await Promise.all([
    chmod(join(inputDirectory, "ticket.md"), 0o600),
    chmod(join(inputDirectory, "context.md"), 0o600),
    chmod(join(inputDirectory, "repository.bundle"), 0o600),
  ]);
}

describe("host-local implementation exchange", () => {
  test("validates exchange output, then publishes exact Git evidence after the ephemeral worker exits", async () => {
    const fixtureValue = await fixture();
    const { repository, goalId, ticketId, baseRevision, hostHead, dirtyDiff, indexTree, dispatched } = fixtureValue;
    expect(dispatched.execution.exitCode).toBe(0);

    const output = dispatched.exchange.outputDirectory;
    const validBundle = await readFile(join(output, "repository.bundle"));
    const validSubmission = await readFile(join(output, "submission.md"), "utf8");
    const publication = () =>
      publishImplementationReport({
        cwd: repository.root,
        goalId,
        changeId: "001",
        ticketId,
        execution: dispatched.execution,
        commitMessage: {
          summary: "Implement the host-local exchange",
          body: "Normalize the complete worker tree from its declared output bundle.",
        },
        now: new Date("2026-03-20T10:05:00.000Z"),
      });

    const configPath = join(repository.root, "spike.json");
    const configured = await readFile(configPath, "utf8");
    const renamed = JSON.parse(configured);
    renamed.project.slug = "renamed";
    await writeFile(configPath, `${JSON.stringify(renamed)}\n`);
    await expect(publication()).rejects.toThrow("Goal spike-001 does not belong to Project renamed");
    expect(await Bun.file(reportPath(repository.root, goalId, "001", ticketId)).exists()).toBe(false);
    await writeFile(configPath, configured);

    await writeFile(join(output, "repository.bundle"), "not a Git bundle\n");
    await expect(publication()).rejects.toThrow("output repository bundle is invalid");
    await writeFile(join(output, "repository.bundle"), validBundle);
    await writeFile(
      join(output, "submission.md"),
      validSubmission.replace(/"workerRevision": "[0-9a-f]+"/, `"workerRevision": "${baseRevision}"`),
    );
    await expect(publication()).rejects.toThrow("does not advertise worker revision");
    expect(await Bun.file(reportPath(repository.root, goalId, "001", ticketId)).exists()).toBe(false);
    await expect(repository.git("rev-parse", "--verify", candidateRef(goalId, "001", ticketId))).rejects.toThrow();
    await writeFile(join(output, "submission.md"), validSubmission);

    // Publication cannot inspect the worker checkout or even its prepared input.
    await makeInputRemovable(dispatched.exchange.inputDirectory);
    await rm(dispatched.exchange.inputDirectory, { recursive: true });

    const published = await publication();
    const report = published.report;

    expect(report.metadata.baseRevision).toBe(baseRevision);
    expect(report.metadata.inputRevision).toBe(baseRevision);
    expect(report.metadata.workerRevision).not.toBe(report.metadata.candidateRevision);
    expect(await repository.git("rev-parse", `${report.metadata.workerRevision}^`)).toBe(baseRevision);
    expect(await repository.git("rev-parse", `${report.metadata.candidateRevision}^`)).toBe(baseRevision);
    expect(await repository.git("rev-parse", `${report.metadata.workerRevision}^{tree}`)).toBe(
      await repository.git("rev-parse", `${report.metadata.candidateRevision}^{tree}`),
    );
    expect(await repository.git("show", "-s", "--format=%B", report.metadata.candidateRevision)).toContain(
      `Spike-Goal-Id: ${goalId}\nSpike-Change-Id: 001`,
    );
    expect(await repository.git("rev-parse", candidateRef(goalId, "001", ticketId))).toBe(
      report.metadata.candidateRevision,
    );
    expect((await loadReport(repository.root, goalId, "001", ticketId)).body).toContain(
      "## Verification\n\nControlled verification passed.",
    );
    expect(report.metadata.artifacts).toHaveLength(1);
    expect(report.metadata.execution).toEqual({
      adapter: "local-clone",
      isolation: "workspace",
      worker: "controlled-script",
      model: "implementation-model",
      thinking: "medium",
      startedAt: "2026-03-20T10:03:00.000Z",
      finishedAt: "2026-03-20T10:04:00.000Z",
    });

    await expect(
      publishImplementationReport({
        cwd: repository.root,
        goalId,
        changeId: "001",
        ticketId,
        execution: dispatched.execution,
        commitMessage: { summary: "Try to replace immutable evidence" },
      }),
    ).rejects.toThrow("immutable Report already exists");

    expect(await repository.git("rev-parse", "HEAD")).toBe(hostHead);
    expect(await repository.git("write-tree")).toBe(indexTree);
    expect(await repository.git("diff", "--", "README.md")).toBe(dirtyDiff);
    expect(await readFile(join(repository.root, "README.md"), "utf8")).toBe("dirty host edit\n");
  });
});
