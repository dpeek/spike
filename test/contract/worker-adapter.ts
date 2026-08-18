import { describe, expect, test } from "bun:test";
import { publishFailedReport, publishImplementationReport } from "../../src/report.ts";
import { loadRecordedWorkerIfPresent } from "../../src/worker.ts";
import type { TicketIdentity, WorkerAdapter } from "../../src/worker.ts";

/**
 * Reusable Docker-free contract for a concrete adapter. It deliberately uses
 * the public adapter operations, exchange, runtime record, and Report seam
 * rather than hand-written execution evidence.
 */
export function workerAdapterContract(input: {
  name: string;
  adapter: WorkerAdapter;
  createTicket: () => Promise<{ root: string; identity: TicketIdentity; revision: string; remove: () => Promise<void> }>;
}): void {
  describe(`Worker adapter contract: ${input.name}`, () => {
    test("dispatches exact immutable input, records observation, and finalizes idempotently", async () => {
      const fixture = await input.createTicket();
      try {
        const script = `
if (process.env.SPIKE_INPUT_REVISION !== ${JSON.stringify(fixture.revision)}) process.exit(31);
await Bun.sleep(150);
const input = process.env.SPIKE_INPUT_DIR;
const ticket = await Bun.file(input + "/ticket.md").text();
const context = await Bun.file(input + "/context.md").text();
if (!ticket.includes(${JSON.stringify(fixture.identity.ticketId)}) || !context.includes(${JSON.stringify(fixture.revision)}) || !(await Bun.file(input + "/repository.bundle").exists())) process.exit(32);
if ((await Bun.$\`git rev-parse --verify HEAD\`.text()).trim() !== ${JSON.stringify(fixture.revision)}) process.exit(33);
const child = Bun.spawn([process.env.SPIKE_BIN, "worker", "complete", "--json"], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
child.stdin.write(JSON.stringify({ summary: "contract", verification: "contract", assumptions: "none", limitations: "none", risks: "none", followUp: "none", artifacts: [] }));
child.stdin.end();
const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) throw new Error(err || out);
`;
        const dispatching = input.adapter.dispatch({
          cwd: fixture.root,
          ...fixture.identity,
          worker: "contract-worker",
          command: ["bun", "-e", script],
        });
        for (let attempt = 0; ; attempt++) {
          const record = await loadRecordedWorkerIfPresent(fixture.root, fixture.identity);
          const observation = await input.adapter.observe(fixture.root, fixture.identity);
          if (record !== undefined && observation.status === "working") break;
          if (attempt > 50) throw new Error("adapter did not durably expose an in-progress Worker");
          await Bun.sleep(10);
        }
        expect(await input.adapter.observe(fixture.root, fixture.identity)).toEqual({ hosting: "direct", status: "working" });
        const dispatched = await dispatching;
        expect(dispatched.execution).toMatchObject({
          adapter: input.adapter.adapter,
          isolation: input.adapter.isolation,
          exitCode: 0,
        });
        expect(await input.adapter.observe(fixture.root, fixture.identity)).toEqual({ hosting: "direct", status: "done" });
        expect(await Bun.file(`${dispatched.exchange.outputDirectory}/submission.md`).exists()).toBe(true);
        // Finalization is idempotent before Report publication.
        expect((await input.adapter.finalize(fixture.root, fixture.identity, new Date())).status).toBe("finalized");
        expect((await input.adapter.finalize(fixture.root, fixture.identity, new Date())).status).toBe("finalized");
        // Publication happens after process exit and removes the finalized record.
        const published = await publishImplementationReport({
          cwd: fixture.root, ...fixture.identity, execution: dispatched.execution,
          commitMessage: { summary: "Publish contract worker result" },
        });
        expect(published.report.metadata.outcome).toBe("completed");
        expect(published.cleanup.status).toBe("finalized");
        expect(await loadRecordedWorkerIfPresent(fixture.root, fixture.identity)).toBeUndefined();
      } finally {
        await Bun.spawn(["chmod", "-R", "u+w", fixture.root], { stdout: "ignore", stderr: "ignore" }).exited;
        await fixture.remove();
      }
    });

    test("records failed execution and permits publication after worker exit with idempotent cleanup", async () => {
      const fixture = await input.createTicket();
      try {
        const dispatched = await input.adapter.dispatch({
          cwd: fixture.root,
          ...fixture.identity,
          worker: "contract-worker",
          command: ["bun", "-e", "process.exit(23)"],
        });
        expect(dispatched.execution.exitCode).toBe(23);
        const published = await publishFailedReport({
          cwd: fixture.root,
          ...fixture.identity,
          role: "implement",
          reason: "scripted contract failure",
          execution: dispatched.execution,
        });
        expect(published.report.metadata.outcome).toBe("failed");
        expect(published.cleanup.status).toBe("finalized");
      } finally {
        await Bun.spawn(["chmod", "-R", "u+w", fixture.root], { stdout: "ignore", stderr: "ignore" }).exited;
        await fixture.remove();
      }
    });
  });
}
