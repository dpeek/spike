import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { usage, version } from "./cli.ts";

const root = join(import.meta.dir, "..");

async function spike(...args: string[]) {
  const process = Bun.spawn([join(root, "bin", "spike"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

describe("spike CLI", () => {
  test("shows help", async () => {
    const result = await spike("--help");
    expect(result).toEqual({ exitCode: 0, stdout: usage(), stderr: "" });
  });

  test("shows version", async () => {
    const result = await spike("--version");
    expect(result).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  });

  test("rejects unknown commands", async () => {
    const result = await spike("goal", "status");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("spike: unknown command: goal status\n");
  });
});
