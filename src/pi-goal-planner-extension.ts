import { registerGoalPlannerExtension, supervisorExtensionOptions, type SupervisorExtensionApi } from "./pi-supervisor-extension.ts";

/** Loaded only by the Herdr Goal-planner launcher. The immutable process
 * environment supplies scope; this module intentionally imports no core state. */
export default function spikeGoalPlannerExtension(pi: SupervisorExtensionApi): void {
  const goalId = process.env["SPIKE_GOAL_ID"];
  const projectIdentity = process.env["SPIKE_PROJECT_IDENTITY"];
  if (typeof goalId !== "string" || !goalId.trim()) throw new Error("SPIKE_GOAL_ID must be a non-blank Goal ID");
  if (typeof projectIdentity !== "string" || !projectIdentity.trim()) throw new Error("SPIKE_PROJECT_IDENTITY must be a non-blank Project identity");
  registerGoalPlannerExtension(pi, goalId, projectIdentity, supervisorExtensionOptions(process.env));
}
