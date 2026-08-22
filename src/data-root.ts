import { join, resolve } from "node:path";

/** Host-owned paths resolved once by a process composition boundary. */
export type HostPaths = {
  dataRoot: string;
};

export function resolveHostPaths(environment: NodeJS.ProcessEnv): HostPaths {
  const configured = environment["SPIKE_DATA_DIR"];
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error("SPIKE_DATA_DIR must not be blank");
    return { dataRoot: resolve(configured) };
  }
  const xdg = environment["XDG_DATA_HOME"];
  if (xdg !== undefined) {
    if (!xdg.trim()) throw new Error("XDG_DATA_HOME must not be blank");
    return { dataRoot: join(resolve(xdg), "spike") };
  }
  const home = environment["HOME"];
  if (home === undefined || !home.trim()) throw new Error("HOME must be set to resolve the Spike data directory");
  return { dataRoot: join(resolve(home), ".local", "share", "spike") };
}
