import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDockerCredential, selectPiHost, stopDirectProcess, type DirectProcess } from "./worker.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Pi host selection", () => {
  test("uses Herdr availability for either isolation and direct otherwise", () => {
    expect(selectPiHost({ isolation: "workspace" }, undefined, true)).toBe("herdr");
    expect(selectPiHost({ isolation: "container" }, undefined, true)).toBe("herdr");
    expect(selectPiHost({ isolation: "container" }, undefined, false)).toBe("direct");
  });

  test("preserves explicit direct dispatch for either isolation", () => {
    expect(selectPiHost({ isolation: "workspace" }, "direct")).toBe("direct");
    expect(selectPiHost({ isolation: "container" }, "direct")).toBe("direct");
  });

  test("permits explicit attended container dispatch", () => {
    expect(selectPiHost({ isolation: "container" }, "herdr", false)).toBe("herdr");
  });
});

describe("Docker Pi credential discovery", () => {
  const ticket = { metadata: { model: "openai-codex/test", executionPolicy: { credentialGrants: ["openai-codex"] } } } as any;
  const auth = { "openai-codex": { type: "oauth", access: "access", refresh: "refresh", expires: 1 }, unrelated: { key: "never-copy" } };

  test("prefers an explicit override, then Pi configuration and normal home fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-auth-"));
    const prior = { override: process.env["SPIKE_PI_AUTH_FILE"], directory: process.env["PI_CODING_AGENT_DIR"], home: process.env["HOME"] };
    try {
      await writeFile(join(root, "auth.json"), JSON.stringify(auth));
      await Bun.write(join(root, "override.json"), JSON.stringify({ ...auth, "openai-codex": { ...auth["openai-codex"], access: "override" } }));
      process.env["PI_CODING_AGENT_DIR"] = root;
      process.env["HOME"] = join(root, "no-home");
      process.env["SPIKE_PI_AUTH_FILE"] = join(root, "override.json");
      expect(Buffer.from((await resolveDockerCredential(ticket))!.encodedAuth, "base64").toString()).toContain("override");
      delete process.env["SPIKE_PI_AUTH_FILE"];
      expect(Buffer.from((await resolveDockerCredential(ticket))!.encodedAuth, "base64").toString()).toContain("access");
      await rm(join(root, "auth.json"));
      await mkdir(join(root, ".pi", "agent"), { recursive: true });
      await Bun.write(join(root, ".pi", "agent", "auth.json"), JSON.stringify(auth));
      process.env["HOME"] = root;
      expect(Buffer.from((await resolveDockerCredential(ticket))!.encodedAuth, "base64").toString()).toContain("access");
    } finally {
      for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key === "override" ? "SPIKE_PI_AUTH_FILE" : key === "directory" ? "PI_CODING_AGENT_DIR" : "HOME"] : process.env[key === "override" ? "SPIKE_PI_AUTH_FILE" : key === "directory" ? "PI_CODING_AGENT_DIR" : "HOME"] = value;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses missing, malformed, and symlinked discovered credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-auth-"));
    const prior = { directory: process.env["PI_CODING_AGENT_DIR"], home: process.env["HOME"], override: process.env["SPIKE_PI_AUTH_FILE"] };
    try {
      delete process.env["SPIKE_PI_AUTH_FILE"];
      process.env["PI_CODING_AGENT_DIR"] = root;
      process.env["HOME"] = join(root, "missing-home");
      await expect(resolveDockerCredential(ticket)).rejects.toThrow("unavailable or invalid");
      await writeFile(join(root, "auth.json"), "{");
      await expect(resolveDockerCredential(ticket)).rejects.toThrow("malformed");
      await rm(join(root, "auth.json"));
      await writeFile(join(root, "real.json"), JSON.stringify(auth));
      await symlink(join(root, "real.json"), join(root, "auth.json"));
      await expect(resolveDockerCredential(ticket)).rejects.toThrow("unavailable or invalid");
    } finally {
      for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key === "directory" ? "PI_CODING_AGENT_DIR" : key === "home" ? "HOME" : "SPIKE_PI_AUTH_FILE"] : process.env[key === "directory" ? "PI_CODING_AGENT_DIR" : key === "home" ? "HOME" : "SPIKE_PI_AUTH_FILE"] = value;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("direct worker termination", () => {
  test("waits for graceful exit after SIGTERM", async () => {
    const exit = deferred<number>();
    const signals: NodeJS.Signals[] = [];
    const process: DirectProcess = {
      pid: 123,
      exited: exit.promise,
      kill(signal) {
        signals.push(signal);
      },
    };

    const stopped = stopDirectProcess(process, { graceExpired: new Promise(() => undefined) });
    expect(signals).toEqual(["SIGTERM"]);

    exit.resolve(0);
    await stopped;
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("escalates to SIGKILL and waits when the grace period expires", async () => {
    const exit = deferred<number>();
    const signals: NodeJS.Signals[] = [];
    const process: DirectProcess = {
      pid: 456,
      exited: exit.promise,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") exit.resolve(137);
      },
    };

    await stopDirectProcess(process, { graceExpired: Promise.resolve() });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
