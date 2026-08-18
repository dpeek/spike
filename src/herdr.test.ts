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
