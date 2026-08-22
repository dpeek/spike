import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveHostPaths } from "./data-root.ts";

describe("host paths", () => {
  test("resolves one explicit host data root without ambient reads", () => {
    expect(resolveHostPaths({ SPIKE_DATA_DIR: "./selected" })).toEqual({ dataRoot: resolve("selected") });
    expect(() => resolveHostPaths({ SPIKE_DATA_DIR: "  " })).toThrow("SPIKE_DATA_DIR must not be blank");
  });

  test("uses XDG then HOME only when the higher-priority value is absent", () => {
    expect(resolveHostPaths({ XDG_DATA_HOME: "/xdg", HOME: "/home" })).toEqual({ dataRoot: "/xdg/spike" });
    expect(resolveHostPaths({ HOME: "/home" })).toEqual({ dataRoot: "/home/.local/share/spike" });
  });
});
