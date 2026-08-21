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
import { herdrOperations } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify([
  await herdrOperations.read("opaque-pane"),
  await herdrOperations.read("opaque-pane", { ansi: true }),
]));
`;
      const child = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, SPIKE_HERDR_BIN: fakeHerdr },
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
import { herdrOperations } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify(await herdrOperations.findTabsByLabel("spike-goal-goal-1-identity")));
`;
      const child = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, SPIKE_HERDR_BIN: fakeHerdr, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_CALLS: calls },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual([{ tab: "tab-match", pane: "pane-match" }]);
      expect((await Bun.file(calls).text()).trim().split("\n")).toEqual([
        "tab list --workspace workspace", "pane list --workspace workspace",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-interactive caller before invoking Herdr", async () => {
    const moduleUrl = pathToFileURL(`${import.meta.dir}/herdr.ts`).href;
    const script = `
import { herdrOperations } from ${JSON.stringify(moduleUrl)};
try {
  await herdrOperations.attach("opaque-pane");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;
    const child = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, SPIKE_HERDR_BIN: "false" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Herdr terminal attachment requires an interactive TTY");
  });
});
