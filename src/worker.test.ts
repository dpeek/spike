import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDockerCredential, selectPiHost, stopDirectProcess, type DirectProcess, type WorkerHostOptions } from "./worker.ts";

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

  const host = (values: Partial<WorkerHostOptions>): WorkerHostOptions => ({
    dockerImage: "spike-worker:local",
    spikeExecutable: "spike",
    piExecutable: "pi",
    herdrAvailable: false,
    ...values,
  });

  test("prefers an explicit override, then Pi configuration and normal home fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-auth-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "auth.json"), JSON.stringify(auth));
    await Bun.write(join(root, "override.json"), JSON.stringify({ ...auth, "openai-codex": { ...auth["openai-codex"], access: "override" } }));
    expect(Buffer.from((await resolveDockerCredential(ticket, host({ piAuthFile: join(root, "override.json") })))!.encodedAuth, "base64").toString()).toContain("override");
    expect(Buffer.from((await resolveDockerCredential(ticket, host({ piAgentDirectory: root, homeDirectory: join(root, "no-home") })))!.encodedAuth, "base64").toString()).toContain("access");
    await rm(join(root, "auth.json"));
    await mkdir(join(root, ".pi", "agent"), { recursive: true });
    await Bun.write(join(root, ".pi", "agent", "auth.json"), JSON.stringify(auth));
    expect(Buffer.from((await resolveDockerCredential(ticket, host({ homeDirectory: root })))!.encodedAuth, "base64").toString()).toContain("access");
  });

  test("refuses missing, malformed, and symlinked discovered credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "spike-auth-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const options = host({ piAgentDirectory: root, homeDirectory: join(root, "missing-home") });
    await expect(resolveDockerCredential(ticket, options)).rejects.toThrow("unavailable or invalid");
    await writeFile(join(root, "auth.json"), "{");
    await expect(resolveDockerCredential(ticket, options)).rejects.toThrow("malformed");
    await rm(join(root, "auth.json"));
    await writeFile(join(root, "real.json"), JSON.stringify(auth));
    await symlink(join(root, "real.json"), join(root, "auth.json"));
    await expect(resolveDockerCredential(ticket, options)).rejects.toThrow("unavailable or invalid");
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
