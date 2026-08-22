import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

describe("Herdr terminal operations", () => {
  test("strips ANSI by default and preserves it when requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spike-herdr-read-"));
    try {
      const fakeHerdr = join(directory, "herdr");
      await Bun.write(fakeHerdr, "#!/bin/sh\nprintf '\\033[31mworking\\033[0m\\n'\n");
      await chmod(fakeHerdr, 0o755);
      const moduleUrl = pathToFileURL(`${import.meta.dir}/herdr.ts`).href;
      const script = `
import { createHerdrOperations } from ${JSON.stringify(moduleUrl)};
const herdr = createHerdrOperations({ executable: ${JSON.stringify(fakeHerdr)}, managed: false });
console.log(JSON.stringify([
  await herdr.read("opaque-pane"),
  await herdr.read("opaque-pane", { ansi: true }),
]));
`;
      const child = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual(["working\n", "\u001b[31mworking\u001b[0m\n"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconstructs exact matching planner panes from Herdr 0.8.2 list envelopes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spike-herdr-discovery-"));
    try {
      const fakeHerdr = join(directory, "herdr");
      const calls = join(directory, "calls");
      await Bun.write(fakeHerdr, `#!/bin/sh
printf '%s %s %s %s\\n' "$1" "$2" "$3" "$4" >> "$HERDR_CALLS"
case "$1:$2" in
  tab:list) printf '%s\\n' '{"result":{"tabs":[{"tab_id":"tab-match","label":"spike-goal-goal-1-identity","workspace_id":"workspace"},{"tab_id":"tab-other","label":"unrelated","workspace_id":"workspace"}]}}' ;;
  pane:list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"pane-match","tab_id":"tab-match"},{"pane_id":"pane-other","tab_id":"tab-other"}]}}' ;;
  *) exit 9 ;;
esac
`);
      await chmod(fakeHerdr, 0o755);
      const moduleUrl = pathToFileURL(`${import.meta.dir}/herdr.ts`).href;
      const script = `
import { createHerdrOperations } from ${JSON.stringify(moduleUrl)};
const herdr = createHerdrOperations({ executable: ${JSON.stringify(fakeHerdr)}, managed: true, workspaceId: "workspace" });
console.log(JSON.stringify(await herdr.findTabsByLabel("spike-goal-goal-1-identity")));
`;
      const child = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, HERDR_CALLS: calls },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([{ tab: "tab-match", pane: "pane-match", paneCount: 1 }]);
      expect((await Bun.file(calls).text()).trim().split("\n")).toEqual([
        "tab list --workspace workspace", "pane list --workspace workspace",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("splits a worker pane to the right of the calling planner and closes only that pane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spike-herdr-split-"));
    try {
      const fakeHerdr = join(directory, "herdr");
      const calls = join(directory, "calls");
      await Bun.write(fakeHerdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_CALLS"
case "$1:$2" in
  pane:split) printf '%s\\n' '{"result":{"pane":{"pane_id":"worker-pane"}}}' ;;
  pane:close) printf '%s\\n' '{"result":{}}' ;;
  *) exit 9 ;;
esac
`);
      await chmod(fakeHerdr, 0o755);
      const moduleUrl = pathToFileURL(`${import.meta.dir}/herdr.ts`).href;
      const script = `
import { createHerdrOperations } from ${JSON.stringify(moduleUrl)};
const herdr = createHerdrOperations({ executable: ${JSON.stringify(fakeHerdr)}, managed: true, workspaceId: "workspace", paneId: "planner-pane" });
const split = await herdr.splitPane({ cwd: "/tmp/checkout", environment: { SPIKE_GOAL_ID: "spike-001" } });
await herdr.closePane(split.pane);
console.log(JSON.stringify(split));
`;
      const child = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, HERDR_CALLS: calls },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ pane: "worker-pane" });
      expect((await Bun.file(calls).text()).trim().split("\n")).toEqual([
        "pane split --pane planner-pane --direction right --ratio 0.5 --cwd /tmp/checkout --no-focus --env SPIKE_GOAL_ID=spike-001",
        "pane close worker-pane",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconstructs the left planner when its exact tab has one right-side worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spike-herdr-planner-split-"));
    try {
      const fakeHerdr = join(directory, "herdr");
      await Bun.write(fakeHerdr, `#!/bin/sh
case "$1:$2" in
  tab:list) printf '%s\\n' '{"result":{"tabs":[{"tab_id":"goal-tab","label":"goal-label"}]}}' ;;
  pane:list) printf '%s\\n' '{"result":{"panes":[{"pane_id":"worker-pane","tab_id":"goal-tab"},{"pane_id":"planner-pane","tab_id":"goal-tab"}]}}' ;;
  pane:layout) printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"worker-pane","rect":{"x":50,"y":0,"width":50,"height":40}},{"pane_id":"planner-pane","rect":{"x":0,"y":0,"width":50,"height":40}}]}}}' ;;
  *) exit 9 ;;
esac
`);
      await chmod(fakeHerdr, 0o755);
      const moduleUrl = pathToFileURL(`${import.meta.dir}/herdr.ts`).href;
      const script = `
import { createHerdrOperations } from ${JSON.stringify(moduleUrl)};
const herdr = createHerdrOperations({ executable: ${JSON.stringify(fakeHerdr)}, managed: true, workspaceId: "workspace" });
console.log(JSON.stringify(await herdr.findTabsByLabel("goal-label")));
`;
      const child = Bun.spawn(["bun", "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([{ tab: "goal-tab", pane: "planner-pane", paneCount: 2 }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-interactive caller before invoking Herdr", async () => {
    const moduleUrl = pathToFileURL(`${import.meta.dir}/herdr.ts`).href;
    const script = `
import { createHerdrOperations } from ${JSON.stringify(moduleUrl)};
const herdr = createHerdrOperations({ executable: "false", managed: false });
try {
  await herdr.attach("opaque-pane");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;
    const child = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Herdr terminal attachment requires an interactive TTY");
  });
});
