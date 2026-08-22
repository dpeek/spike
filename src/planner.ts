import { resolve } from "node:path";
import type { HostPaths } from "./data-root.ts";
import { loadProjectConfig } from "./config.ts";
import { discoverRepository } from "./git.ts";
import { applicationSupervisorToolNames, supervisorToolNames } from "./pi-supervisor-extension.ts";

export type LaunchPlannerInput = {
  cwd: string;
  hostPaths: HostPaths;
  piExecutable?: string;
  spikeExecutable?: string;
  environment?: Record<string, string | undefined>;
};

export async function launchPlanner(input: LaunchPlannerInput): Promise<number> {
  const repository = await discoverRepository(input.cwd, input.hostPaths);
  const selection = (await loadProjectConfig(repository.root)).agents.planner;
  const extension = resolve(import.meta.dir, "pi-supervisor-extension.ts");
  const spikeExecutable = input.spikeExecutable ?? input.environment?.["SPIKE_BIN"] ?? resolve(import.meta.dir, "..", "bin", "spike");
  const environment = { ...(input.environment ?? process.env), SPIKE_BIN: spikeExecutable, SPIKE_APPLICATION_TOOLS: "1" };
  const processHandle = Bun.spawn([
    input.piExecutable ?? input.environment?.["SPIKE_PI_BIN"] ?? "pi",
    "--model",
    selection.model,
    "--thinking",
    selection.thinking,
    "--no-approve",
    "--no-extensions",
    "--extension",
    extension,
    "--tools",
    ["read", "grep", "find", "ls", ...supervisorToolNames, ...applicationSupervisorToolNames].join(","),
  ], {
    cwd: repository.root,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return processHandle.exited;
}
