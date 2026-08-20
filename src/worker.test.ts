import { describe, expect, test } from "bun:test";
import { selectPiHost, stopDirectProcess, type DirectProcess } from "./worker.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Pi host selection", () => {
  test("defaults workspace Tickets to attended Herdr and container Tickets to direct dispatch", () => {
    expect(selectPiHost({ isolation: "workspace" })).toBe("herdr");
    expect(selectPiHost({ isolation: "container" })).toBe("direct");
  });

  test("preserves explicit direct dispatch for either isolation", () => {
    expect(selectPiHost({ isolation: "workspace" }, "direct")).toBe("direct");
    expect(selectPiHost({ isolation: "container" }, "direct")).toBe("direct");
  });

  test("refuses an attended override for container isolation without dispatching", () => {
    expect(() => selectPiHost({ isolation: "container" }, "herdr"))
      .toThrow("Herdr hosting is incompatible with container Ticket isolation");
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
