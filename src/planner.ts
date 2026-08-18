import { resolve } from "node:path";
import { loadProjectConfig } from "./config.ts";
import { discoverRepository } from "./git.ts";
import { supervisorToolNames } from "./pi-supervisor-extension.ts";

export type LaunchPlannerInput = {
  cwd: string;
  piExecutable?: string;
  spikeExecutable?: string;
  environment?: Record<string, string | undefined>;
};

export async function launchPlanner(input: LaunchPlannerInput): Promise<number> {
  const repository = await discoverRepository(input.cwd);
  const selection = (await loadProjectConfig(repository.root)).models.planner;
  const extension = resolve(import.meta.dir, "pi-supervisor-extension.ts");
  const spikeExecutable = input.spikeExecutable ?? input.environment?.["SPIKE_BIN"] ?? process.env["SPIKE_BIN"] ?? resolve(import.meta.dir, "..", "bin", "spike");
  const environment = { ...process.env, ...input.environment, SPIKE_BIN: spikeExecutable };
  const processHandle = Bun.spawn([
    input.piExecutable ?? input.environment?.["SPIKE_PI_BIN"] ?? process.env["SPIKE_PI_BIN"] ?? "pi",
    "--model",
    selection.model,
    "--thinking",
    selection.thinking,
    "--no-approve",
    "--no-extensions",
    "--extension",
    extension,
    "--tools",
    ["read", "grep", "find", "ls", ...supervisorToolNames].join(","),
  ], {
    cwd: repository.root,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return processHandle.exited;
}
