import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

describe("Herdr terminal attachment", () => {
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
