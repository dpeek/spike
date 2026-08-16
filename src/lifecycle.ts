export function agentOutcomeDescription(state: { lifecycle?: string; outcome?: string; exitCode?: number }): string {
  if (state.outcome === "stopped" || state.lifecycle === "stopped") return "stopped by request";
  if (state.outcome === "completed" || state.exitCode === 0) return "completed";
  return `failed with exit code ${state.exitCode ?? "unknown"}`;
}
