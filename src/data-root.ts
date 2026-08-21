import { join, resolve } from "node:path";

/** The single host-owned root for Requests and Project control-plane state. */
export function spikeDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["SPIKE_DATA_DIR"];
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error("SPIKE_DATA_DIR must not be blank");
    return resolve(configured);
  }
  const xdg = environment["XDG_DATA_HOME"];
  if (xdg !== undefined) {
    if (!xdg.trim()) throw new Error("XDG_DATA_HOME must not be blank");
    return join(resolve(xdg), "spike");
  }
  const home = environment["HOME"];
  if (home === undefined || !home.trim()) throw new Error("HOME must be set to resolve the Spike data directory");
  return join(resolve(home), ".local", "share", "spike");
}
