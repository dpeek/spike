import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export type SpikeJsonSuccess = { ok: true; command: string; data: unknown };
type SpikeJsonFailure = {
  ok: false;
  command: string;
  error: { code: "usage" | "workflow"; message: string };
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: SpikeJsonSuccess;
};

type RenderComponent = {
  render: (width: number) => string[];
  invalidate: () => void;
};

type ToolRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: SpikeJsonSuccess;
};

type ToolContext = { cwd: string };
type TicketIdentity = { goalId: string; changeId: string; ticketId: string };
type PlannerStep = "goal" | "plan" | "change" | "implement" | "review" | "remediate" | "decide" | "recover";
type SelectedStep = { step: PlannerStep; goalId?: string; changeId?: string };
type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  executionMode: "sequential";
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ) => Promise<ToolResult>;
  renderResult: (
    result: ToolRenderResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: unknown,
  ) => RenderComponent;
};

export type SupervisorExtensionApi = {
  registerTool: (tool: ToolDefinition) => void;
  on: (
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, context: ToolContext) => void | Promise<void>,
  ) => void;
  sendMessage: (
    message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    options: { deliverAs: "followUp"; triggerTurn: true },
  ) => void;
};

export type RunSpikeJsonInput = {
  cwd: string;
  args: string[];
  expectedCommand: string;
  stdin?: string;
  signal?: AbortSignal;
  command?: string;
  environment?: NodeJS.ProcessEnv;
};

export type RegisterSupervisorExtensionOptions = {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  invoke?: (input: RunSpikeJsonInput) => Promise<SpikeJsonSuccess>;
  waitForDone?: (input: RunSpikeJsonInput) => Promise<SpikeJsonSuccess>;
  /** Set only by the Goal-planner entrypoint. It is operational scope, never workflow evidence. */
  goalId?: string;
  /** Exact repository identity supplied by the Goal planner's immutable environment. */
  projectIdentity?: string;
  /** Application tools are enabled only for a supervisor launched with queued Application work. */
  applications?: boolean;
  /** Injection seam for the Node-compatible repository binding. */
  validateProject?: (cwd: string, projectIdentity: string) => Promise<void>;
};

export const goalPlannerToolNames = [
  "spike_begin_step",
  "spike_status",
  "spike_revise_plan",
  "spike_create_change",
  "spike_decide_change",
  "spike_issue_implement",
  "spike_issue_review",
  "spike_issue_remediate",
  "spike_dispatch_pi",
  "spike_worker_status",
  "spike_worker_read",
  "spike_publish_report",
  "spike_recover",
] as const;

export const applicationSupervisorToolNames = [
  "spike_issue_application_implement", "spike_prepare_application_ticket", "spike_dispatch_application_pi", "spike_application_worker_status", "spike_application_worker_read", "spike_publish_application_report", "spike_recover_application",
] as const;

export const supervisorToolNames = [
  "spike_begin_step",
  "spike_status",
  "spike_queue_goal",
  "spike_apply_queue_head",
  "spike_create_goal",
  "spike_create_request",
  "spike_list_requests",
  "spike_show_request",
  "spike_revise_plan",
  "spike_create_change",
  "spike_decide_change",
  "spike_issue_implement",
  "spike_issue_review",
  "spike_issue_remediate",
  "spike_dispatch_pi",
  "spike_worker_status",
  "spike_worker_read",
  "spike_publish_report",
  "spike_recover",
] as const;

const maximumProcessOutputBytes = 1024 * 1024;
const nonBlankString = { type: "string", minLength: 1 } as const;
const requiredNonBlankString = { type: "string", minLength: 1, pattern: "\\S" } as const;
const optionalIdentity = { type: "string", minLength: 1 } as const;
const thinking = { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh"] } as const;
const plannerSteps = ["goal", "plan", "change", "implement", "review", "remediate", "decide", "recover"] as const;
const requestId = { type: "string", pattern: "^request-(?!0+$)[0-9]{3,}$", maxLength: 64 } as const;
const projectSlug = { type: "string", pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", minLength: 1, maxLength: 63 } as const;
const requestTitle = { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$" } as const;
const requestBody = { type: "string", minLength: 1, maxLength: 20000, pattern: "\\S" } as const;

function object(value: unknown): any {
  return typeof value === "object" && value !== null ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function identity(value: unknown): string | undefined {
  const record = object(value);
  const parts = [record?.goalId, record?.changeId, record?.ticketId];
  return parts.every((part) => typeof part === "string")
    ? (parts as string[]).join("/")
    : parts.slice(0, 2).every((part) => typeof part === "string")
      ? (parts.slice(0, 2) as string[]).join("/")
      : typeof parts[0] === "string" ? parts[0] : undefined;
}

function shortRevision(value: unknown): string {
  const revision = string(value);
  return revision === undefined ? "none" : revision.slice(0, 10);
}

function findingSummary(findings: unknown): string | undefined {
  const severities = ["critical", "high", "medium", "low"] as const;
  const counts = Object.fromEntries(severities.map((severity) => [severity, 0])) as Record<typeof severities[number], number>;
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      const severity = string(object(finding)?.severity);
      if (severity !== undefined && severity in counts) counts[severity as keyof typeof counts] += 1;
    }
  } else {
    const recorded = object(findings);
    if (recorded === undefined) return undefined;
    for (const severity of severities) {
      if (typeof recorded[severity] === "number") counts[severity] = recorded[severity];
    }
  }
  const total = severities.reduce((sum, severity) => sum + counts[severity], 0);
  if (total === 0) return "no findings";
  const breakdown = severities.filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(", ");
  return `${total} finding${total === 1 ? "" : "s"} (${breakdown})`;
}

function goalStatusLines(value: unknown): string[] {
  const goal = object(value);
  if (goal === undefined) return ["Invalid Goal status"];
  const goalId = string(goal.goalId) ?? "unknown Goal";
  const cleanup = object(goal.cleanup);
  const cleanupText = cleanup?.healthy === true
    ? "cleanup healthy"
    : `${Array.isArray(cleanup?.warnings) ? cleanup.warnings.length : "?"} cleanup warning(s)`;
  const change = object(goal.currentChange);
  if (change === undefined) {
    const decisions = Array.isArray(goal.decisions) ? goal.decisions.length : 0;
    return [`Goal ${goalId}`, `No active Change · ${decisions} resolved · ${cleanupText}`];
  }

  const lines = [`Goal ${goalId} · Change ${string(change.changeId) ?? "unknown"}`];
  const openTicket = object(change.openTicket);
  lines.push(openTicket === undefined
    ? "Open Ticket none"
    : `Open Ticket ${string(openTicket.ticketId) ?? "unknown"} (${string(openTicket.role) ?? "unknown"})`);
  const candidate = object(change.candidate);
  lines.push(candidate === undefined
    ? "Candidate none"
    : `Candidate ${shortRevision(candidate.revision)} (Ticket ${string(candidate.producingImplementationTicketId) ?? "unknown"})`);
  const review = object(change.review);
  if (review !== undefined) {
    const findings = findingSummary(review.findingCounts);
    lines.push(`Review ${string(review.verdict) ?? "unknown"} (Ticket ${string(review.ticketId) ?? "unknown"})${findings === undefined ? "" : ` · ${findings}`}`);
  } else {
    const latest = object(change.latestReport);
    lines.push(latest === undefined
      ? "Latest Report none"
      : `Latest Report ${string(latest.ticketId) ?? "unknown"} ${string(latest.outcome) ?? "unknown"}`);
  }
  const churn = Array.isArray(change.churnWarnings) ? change.churnWarnings.length : 0;
  if (churn > 0) lines.push(`${churn} churn warning(s)`);
  lines.push(cleanupText);
  return lines;
}

function statusText(data: unknown): string {
  const envelope = object(data);
  if (envelope === undefined) return "Invalid Spike status";
  const status = object(envelope.durable) ?? envelope;
  if (typeof status.goalId === "string") return goalStatusLines(status).join("\n");
  const project = object(status.project);
  const goals = Array.isArray(status.goals) ? status.goals : [];
  const lines = [`Project ${string(project?.slug) ?? "unknown"}`];
  if (goals.length === 0) lines.push("No Goals");
  for (const goal of goals) lines.push(...goalStatusLines(goal));
  const cleanup = object(status.cleanup);
  if (cleanup?.healthy === false) {
    lines.push(`${Array.isArray(cleanup.warnings) ? cleanup.warnings.length : "?"} repository cleanup warning(s)`);
  }
  const planners = Array.isArray(envelope.planners) ? envelope.planners : [];
  for (const planner of planners) {
    const observed = object(planner);
    lines.push(`Planner ${string(observed?.goalId) ?? "unknown Goal"} · ${string(observed?.state) ?? "unavailable"} (operational)`);
  }
  return lines.join("\n");
}

function readableLabel(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function readableLines(value: unknown, indent = ""): string[] {
  if (value === null) return [`${indent}none`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}none`];
    return value.flatMap((item) => {
      const lines = readableLines(item, `${indent}  `);
      return [`${indent}- ${lines[0]!.slice(indent.length + 2)}`, ...lines.slice(1)];
    });
  }
  const record = object(value);
  if (record !== undefined) {
    const entries = Object.entries(record);
    if (entries.length === 0) return [`${indent}none`];
    return entries.flatMap(([key, item]) => {
      const label = readableLabel(key);
      if (item !== null && typeof item === "object") {
        return [`${indent}${label}:`, ...readableLines(item, `${indent}  `)];
      }
      const itemText = String(item);
      if (itemText.includes("\n")) {
        return [`${indent}${label}:`, ...itemText.replace(/\n$/, "").split("\n").map((line) => `${indent}  ${line}`)];
      }
      return [`${indent}${label}: ${itemText}`];
    });
  }
  return [`${indent}${String(value)}`];
}

function commandSummary(response: SpikeJsonSuccess): string {
  const data = object(response.data);
  switch (response.command) {
    case "status": return statusText(response.data);
    case "guidance show": return `Loaded ${string(data?.step) ?? "workflow"} guidance`;
    case "goal queue": return `Queued Goal ${string(data?.goalId) ?? "unknown"} at FIFO position ${String(data?.queuePosition ?? "unknown")}`;
    case "application apply-head": return `Applied FIFO head ${string(data?.goalId) ?? "unknown"}/${string(data?.applicationId) ?? "unknown"}`;
    case "goal create": return `Created Goal ${identity(object(data?.goal)) ?? "unknown"}`;
    case "request create":
    case "request show": {
      const request = object(data);
      const id = string(request?.metadata && object(request.metadata)?.requestId) ?? "unknown";
      const state = string(request?.state) ?? "unknown";
      const projects = Array.isArray(object(request?.metadata)?.projects) ? object(request?.metadata)?.projects : [];
      const affinity = projects.filter((project: unknown): project is string => typeof project === "string").join(", ") || "unassigned";
      return `${response.command === "request create" ? "Created" : "Request"} Request ${id} · ${state} · ${affinity}`;
    }
    case "request list": {
      const requests = Array.isArray(response.data) ? response.data : [];
      if (requests.length === 0) return "Inbox empty";
      return [`Inbox ${requests.length} Request${requests.length === 1 ? "" : "s"}`, ...requests.map((value) => {
        const request = object(value);
        const id = string(object(request?.metadata)?.requestId) ?? "unknown";
        const title = string(request?.title) ?? "untitled";
        const state = string(request?.state) ?? "unknown";
        const projects = Array.isArray(object(request?.metadata)?.projects) ? object(request?.metadata)?.projects : [];
        const affinity = projects.filter((project: unknown): project is string => typeof project === "string").join(", ") || "unassigned";
        return `${id} · ${title} · ${state} · ${affinity}`;
      })].join("\n");
    }
    case "plan revise": return `Revised Plan ${identity(object(data?.metadata)) ?? "unknown"}`;
    case "change create": return `Created Change ${identity(object(data?.change)) ?? "unknown"}`;
    case "change land":
    case "change reject":
    case "change abandon":
      return `${readableLabel(response.command.split(" ")[1]!)}ed Change ${identity(data) ?? "unknown"}`;
    case "ticket issue": {
      const ticket = object(data?.ticket);
      const role = string(ticket?.role);
      return `Issued${role === undefined ? "" : ` ${readableLabel(role)}`} Ticket ${identity(ticket) ?? "unknown"}`;
    }
    case "ticket dispatch-pi":
      return `Dispatched Ticket ${identity(data?.ticket) ?? "unknown"} · ${string(data?.status) ?? string(data?.classification) ?? "started"}`;
    case "worker status":
      return `Worker ${identity(data?.ticket) ?? "unknown"} · ${string(data?.status) ?? "unknown"}`;
    case "worker read": return `Read worker terminal ${identity(data?.ticket) ?? "unknown"}`;
    case "report publish": {
      const report = object(data?.report);
      const outcome = string(report?.outcome) ?? "unknown";
      const verdict = string(report?.verdict);
      const candidate = report?.candidateRevision;
      const findings = findingSummary(report?.findings);
      const suffix = verdict !== undefined
        ? ` · ${verdict}${findings === undefined ? "" : ` · ${findings}`}`
        : candidate !== undefined ? ` · Candidate ${shortRevision(candidate)}` : "";
      return `Published ${outcome} Report ${identity(report) ?? "unknown"}${suffix}`;
    }
    case "recover": return "Reconciled Spike workflow state";
    default: return readableLabel(response.command);
  }
}

export function renderSupervisorResponse(response: SpikeJsonSuccess, expanded: boolean): string {
  const summary = commandSummary(response);
  if (response.command === "status") return summary;
  const data = object(response.data);
  if (response.command === "guidance show" && expanded) {
    const markdown = string(data?.markdown) ?? "";
    return `${summary}\n${string(data?.path) ?? ""}\nSource ${shortRevision(data?.sourceRevision)}\n\n${markdown}`.trimEnd();
  }
  if (response.command === "plan revise" && expanded && typeof data?.body === "string") {
    return `${summary}\n\n${data.body}`.trimEnd();
  }
  if (response.command === "worker read" && expanded && typeof data?.terminal === "string") {
    return `${summary}\n\n${data.terminal}`.trimEnd();
  }
  return expanded ? `${summary}\n\n${readableLines(response.data).join("\n")}` : summary;
}

function wrapLine(line: string, width: number): string[] {
  const characters = Array.from(line);
  if (characters.length <= width) return [line];
  const lines: string[] = [];
  let remaining = characters;
  while (remaining.length > width) {
    let cut = width;
    for (let index = width; index > Math.floor(width / 2); index--) {
      if (/\s/.test(remaining[index - 1] ?? "")) {
        cut = index;
        break;
      }
    }
    lines.push(remaining.slice(0, cut).join("").trimEnd());
    remaining = remaining.slice(cut);
    while (/\s/.test(remaining[0] ?? "")) remaining = remaining.slice(1);
  }
  lines.push(remaining.join(""));
  return lines;
}

function textComponent(text: string): RenderComponent {
  return {
    render(width) {
      const available = Math.max(1, width);
      return text.split("\n").flatMap((line) => wrapLine(line, available));
    },
    invalidate() {},
  };
}

function renderToolResult(result: ToolRenderResult, options: { expanded: boolean; isPartial: boolean }): RenderComponent {
  if (options.isPartial) return textComponent("Working…");
  if (result.details?.ok === true) {
    return textComponent(renderSupervisorResponse(result.details, options.expanded));
  }
  const fallback = result.content.find((content) => content.type === "text")?.text ?? "Spike tool completed";
  return textComponent(fallback);
}

function parseResponse(stdout: string, expectedCommand: string): SpikeJsonSuccess | SpikeJsonFailure {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Spike returned invalid JSON instead of its single --json response");
  }
  if (typeof value !== "object" || value === null || !("ok" in value) || !("command" in value)) {
    throw new Error("Spike returned an invalid --json response");
  }
  const response = value as {
    ok?: unknown;
    command?: unknown;
    data?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (response.command !== expectedCommand) {
    throw new Error(`Spike returned command ${String(response.command)}, expected ${expectedCommand}`);
  }
  if (response.ok === true && "data" in response) return response as SpikeJsonSuccess;
  if (
    response.ok === false &&
    typeof response.error === "object" &&
    response.error !== null &&
    typeof response.error.message === "string"
  ) {
    return response as SpikeJsonFailure;
  }
  throw new Error("Spike returned an invalid --json response");
}

export async function runSpikeJson(input: RunSpikeJsonInput): Promise<SpikeJsonSuccess> {
  if (input.signal?.aborted) throw new Error("Spike operation was cancelled");
  const environment = input.environment ?? process.env;
  const command = input.command ?? environment["SPIKE_BIN"] ?? process.env["SPIKE_BIN"] ?? "spike";

  return new Promise<SpikeJsonSuccess>((resolve, reject) => {
    const child = spawn(command, [...input.args, "--json"], {
      cwd: input.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let settled = false;

    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();

    const collect = (chunks: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > maximumProcessOutputBytes) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(buffer);
    };
    child.stdout.on("data", (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => collect(stderr, chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) {
        reject(new Error("Spike operation was cancelled"));
        return;
      }
      if (outputLimitExceeded) {
        reject(new Error("Spike process output exceeded its size limit"));
        return;
      }
      try {
        const response = parseResponse(Buffer.concat(stdout).toString("utf8"), input.expectedCommand);
        if (!response.ok) {
          reject(new Error(`Spike rejected ${response.command}: ${response.error.message}`));
          return;
        }
        resolve(response);
      } catch (error) {
        const evidence = Buffer.concat(stderr).toString("utf8").trim();
        if (evidence && error instanceof Error) error.message = `${error.message}: ${evidence}`;
        reject(error);
      }
    });
    child.stdin.end(input.stdin);
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git exited with code ${code}`));
    });
  });
}

/** Recreate Project.repositoryIdentity without importing Bun-only core modules into Pi. */
async function validateProjectIdentity(cwd: string, expected: string): Promise<void> {
  if (typeof expected !== "string" || !expected.trim()) throw new Error("Goal planner Project identity must not be blank");
  let actual: string | undefined;
  try {
    const remote = await gitOutput(cwd, ["config", "--get", "remote.origin.url"]);
    if (remote) actual = remote;
  } catch {
    // A local repository identity is its canonical shared Git directory.
  }
  if (actual === undefined) {
    const common = await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    actual = `file://${await realpath(common)}`;
  }
  if (actual !== expected) throw new Error("Goal planner Project identity does not match this checkout");
}

function optional(args: string[], option: string, value: string | undefined): void {
  if (value !== undefined) args.push(option, value);
}

function repeated(args: string[], option: string, values: string[] | undefined): void {
  for (const value of values ?? []) args.push(option, value);
}

function tool(
  definition: Omit<ToolDefinition, "executionMode" | "execute" | "renderResult"> & {
    command: string | ((params: any) => string);
    args: (params: any) => string[];
    stdin?: (params: any) => string | undefined;
    beforeInvoke?: (params: any, context: ToolContext) => void;
    afterSuccess?: (params: any, response: SpikeJsonSuccess, context: ToolContext) => void | Promise<void>;
  },
  invoke: (input: RunSpikeJsonInput) => Promise<SpikeJsonSuccess>,
  options: RegisterSupervisorExtensionOptions,
): ToolDefinition {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    ...(definition.promptGuidelines === undefined ? {} : { promptGuidelines: definition.promptGuidelines }),
    parameters: definition.parameters,
    executionMode: "sequential",
    renderResult: (result, renderOptions) => renderToolResult(result, renderOptions),
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (options.goalId !== undefined) {
        await (options.validateProject ?? validateProjectIdentity)(context.cwd, options.projectIdentity!);
        if (typeof params !== "object" || params === null || Array.isArray(params)) {
          throw new Error("Goal-scoped planner tool arguments must be an object");
        }
        if (definition.name === "spike_status") {
          if (params.goalId === undefined) params.goalId = options.goalId;
        }
        if (definition.name === "spike_begin_step" && params.step === "goal") {
          throw new Error("Goal-scoped planners cannot select Project-wide Goal guidance");
        }
        if (params.goalId !== options.goalId || typeof params.goalId !== "string") {
          throw new Error(`Goal-scoped planner is restricted to Goal ${options.goalId}`);
        }
      }
      definition.beforeInvoke?.(params, context);
      const stdin = definition.stdin?.(params);
      const response = await invoke({
        cwd: context.cwd,
        args: definition.args(params),
        expectedCommand: typeof definition.command === "string" ? definition.command : definition.command(params),
        ...(stdin === undefined ? {} : { stdin }),
        ...(signal === undefined ? {} : { signal }),
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      await definition.afterSuccess?.(params, response, context);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
  };
}

function ticketKey(identity: TicketIdentity): string {
  return `worker-done:${identity.goalId}/${identity.changeId}/${identity.ticketId}`;
}

function workerWaitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableWorkerWait(error: unknown): boolean {
  const message = workerWaitErrorMessage(error);
  return message.includes("has no Worker record") || message.includes("has no attended Herdr worker");
}

function openTicketIdentities(data: unknown): TicketIdentity[] {
  if (typeof data !== "object" || data === null) return [];
  const status = data as Record<string, unknown>;
  const goals = Array.isArray(status["goals"]) ? status["goals"] : [status];
  const identities: TicketIdentity[] = [];
  for (const value of goals) {
    if (typeof value !== "object" || value === null) continue;
    const goal = value as Record<string, unknown>;
    const change = goal["currentChange"];
    if (typeof goal["goalId"] !== "string" || typeof change !== "object" || change === null) continue;
    const current = change as Record<string, unknown>;
    const ticket = current["openTicket"];
    if (typeof current["changeId"] !== "string" || typeof ticket !== "object" || ticket === null) continue;
    const open = ticket as Record<string, unknown>;
    if (typeof open["ticketId"] !== "string") continue;
    identities.push({ goalId: goal["goalId"], changeId: current["changeId"], ticketId: open["ticketId"] });
  }
  return identities;
}

export function registerSupervisorExtension(
  pi: SupervisorExtensionApi,
  options: RegisterSupervisorExtensionOptions = {},
): void {
  if (options.goalId !== undefined && (typeof options.projectIdentity !== "string" || !options.projectIdentity.trim())) {
    throw new Error("Goal planner Project identity must not be blank");
  }
  const invoke = options.invoke ?? runSpikeJson;
  const waitForDone = options.waitForDone ?? runSpikeJson;
  const assertProjectScope = async (cwd: string): Promise<void> => {
    if (options.goalId !== undefined) await (options.validateProject ?? validateProjectIdentity)(cwd, options.projectIdentity!);
  };
  const waiters = new Map<string, AbortController>();
  const notified = new Set<string>();
  let shuttingDown = false;
  let selectedStep: SelectedStep | undefined;

  const selectStep = (params: any): void => {
    selectedStep = undefined;
    const step = params.step as PlannerStep;
    selectedStep = {
      step,
      ...(params.goalId === undefined ? {} : { goalId: params.goalId }),
      ...(params.changeId === undefined ? {} : { changeId: params.changeId }),
    };
  };

  const requireStep = (step: PlannerStep, params: any): void => {
    const required: SelectedStep = {
      step,
      ...(params.goalId === undefined ? {} : { goalId: params.goalId }),
      ...(params.changeId === undefined ? {} : { changeId: params.changeId }),
    };
    if (
      selectedStep?.step !== required.step ||
      selectedStep.goalId !== required.goalId ||
      selectedStep.changeId !== required.changeId
    ) {
      const identity = [required.goalId, required.changeId].filter(Boolean).join("/");
      throw new Error(
        `Call spike_begin_step for ${step}${identity ? ` on ${identity}` : ""} before this mutation`,
      );
    }
    selectedStep = undefined;
  };

  const armWorkerWake = async (
    cwd: string,
    identity: TicketIdentity,
    wakeOptions: { replace?: boolean; notifyUnavailableFailure?: boolean } = {},
  ): Promise<void> => {
    // A waiter invokes Spike too, so rebind the exact Project immediately
    // before arming it rather than inheriting a prior tool/startup check.
    await assertProjectScope(cwd);
    const key = ticketKey(identity);
    if (notified.has(key)) return;
    const existing = waiters.get(key);
    if (existing !== undefined) {
      if (!wakeOptions.replace) return;
      existing.abort();
    }

    const controller = new AbortController();
    waiters.set(key, controller);
    void waitForDone({
      cwd,
      args: ["worker", "wait", "--goal", identity.goalId, "--change", identity.changeId, "--ticket", identity.ticketId],
      expectedCommand: "worker wait",
      signal: controller.signal,
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    }).then((response) => {
      const data = response.data as { key?: unknown; status?: unknown } | undefined;
      if (shuttingDown || controller.signal.aborted || data?.key !== key || data.status !== "done" || notified.has(key)) return;
      notified.add(key);
      pi.sendMessage({
        customType: "spike-worker-recheck",
        content: `Operational worker notification ${key}. Call spike_status now. If this exact Ticket remains open, explicitly call spike_publish_report. Do not treat this notification, the worker marker, Herdr state, terminal output, or process exit as workflow evidence.`,
        display: true,
        details: { key, ...identity },
      }, { deliverAs: "followUp", triggerTurn: true });
    }).catch((error) => {
      if (
        shuttingDown || controller.signal.aborted || notified.has(key) ||
        workerWaitErrorMessage(error).includes("is already reported") ||
        (!wakeOptions.notifyUnavailableFailure && unavailableWorkerWait(error))
      ) return;
      notified.add(key);
      pi.sendMessage({
        customType: "spike-worker-recheck",
        content: `Operational worker waiter failed for ${key}. Call spike_status now, then spike_worker_status for this exact Ticket if it remains open. Do not treat this message, Herdr state, terminal output, or process exit as workflow evidence.`,
        display: true,
        details: { key, ...identity, waiterFailed: true },
      }, { deliverAs: "followUp", triggerTurn: true });
    }).finally(() => {
      if (waiters.get(key) === controller) waiters.delete(key);
    });
  };

  pi.on("session_start", async (_event, context) => {
    shuttingDown = false;
    selectedStep = undefined;
    notified.clear();
    try {
      await assertProjectScope(context.cwd);
      const status = await invoke({
        cwd: context.cwd,
        args: options.goalId === undefined ? ["status"] : ["status", "--goal", options.goalId],
        expectedCommand: "status",
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      for (const identity of openTicketIdentities(status.data)) await armWorkerWake(context.cwd, identity);
    } catch {
      // The planner can still recover explicitly through spike_status.
    }
  });
  pi.on("session_shutdown", () => {
    shuttingDown = true;
    selectedStep = undefined;
    for (const controller of waiters.values()) controller.abort();
    waiters.clear();
  });

  const tools: ToolDefinition[] = [
    tool({
      name: "spike_begin_step",
      label: "Begin guided step",
      description: "Load the tracked Markdown guidance for one planner step from Spike's committed authority. This selects exactly one matching supervisor mutation and is consumed by that attempt.",
      promptSnippet: "Load committed guidance immediately before a planner mutation",
      promptGuidelines: [
        "Call this immediately before every Goal, Plan, Change, Implement, Review, Remediate, Decide, or Recover mutation.",
        "Read and follow the returned Markdown before forming mutation arguments. A selection is operational, one-use, and lost on supervisor restart.",
      ],
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["step"],
        properties: {
          step: { type: "string", enum: plannerSteps },
          goalId: optionalIdentity,
          changeId: optionalIdentity,
        },
      },
      command: "guidance show",
      args(params) {
        const args = ["guidance", "show", "--step", params.step];
        optional(args, "--goal", params.goalId);
        optional(args, "--change", params.changeId);
        return args;
      },
      beforeInvoke: () => { selectedStep = undefined; },
      afterSuccess: (params) => selectStep(params),
    }, invoke, options),
    tool({
      name: "spike_status",
      label: "Spike status",
      description: "Load workflow status derived by Spike from durable Goals, Changes, Tickets, Reports, and decisions.",
      promptSnippet: "Read Spike's authoritative derived workflow status",
      promptGuidelines: [
        "Use spike_status for workflow facts; never infer them from planner prose, worker terminal output, or a Pi process exit status.",
        "Treat spike_dispatch_pi output and spike-worker-recheck messages as operational only; on a wake call spike_status, then explicitly use spike_publish_report if the Ticket remains open.",
        "Use Spike tools rather than editing host control-plane files directly.",
      ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { goalId: optionalIdentity },
      },
      command: "status",
      args(params) {
        const args = ["status"];
        if (options.goalId === undefined) args.push("--operational");
        optional(args, "--goal", params.goalId);
        return args;
      },
    }, invoke, options),
    tool({
      name: "spike_queue_goal",
      label: "Queue completed Goal",
      description: "Supervisor-only immutable FIFO admission for a completed Goal after explicit operator approval.",
      promptSnippet: "Queue one completed Goal only with explicit operator approval",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "targetBranch", "approval"],
        properties: {
          goalId: requiredNonBlankString,
          targetBranch: requiredNonBlankString,
          approval: requiredNonBlankString,
        },
      },
      command: "goal queue",
      args: (params) => [
        "goal", "queue", "--goal", params.goalId, "--target", params.targetBranch, "--approval", params.approval,
      ],
    }, invoke, options),
    tool({
      name: "spike_apply_queue_head",
      label: "Apply FIFO queue head",
      description: "Supervisor-only clean-base application of one exact unresolved FIFO head.",
      promptSnippet: "Apply only the exact FIFO head",
      parameters: {
        type: "object", additionalProperties: false, required: ["goalId", "applicationId"],
        properties: { goalId: requiredNonBlankString, applicationId: requiredNonBlankString },
      },
      command: "application apply-head",
      args: (params) => ["application", "apply-head", "--goal", params.goalId, "--application", params.applicationId],
    }, invoke, options),
    tool({
      name: "spike_issue_application_implement",
      label: "Issue Application Implement Ticket",
      description: "Supervisor-only issue of an implementation Ticket for the exact diverged FIFO Application head.",
      promptSnippet: "Issue the exact FIFO Application implementation Ticket",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "instruction"], properties: { goalId: nonBlankString, applicationId: nonBlankString, instruction: nonBlankString } },
      command: "application ticket issue", args: (params) => ["application", "ticket", "issue", "--goal", params.goalId, "--application", params.applicationId, "--instruction", params.instruction],
    }, invoke, options),
    tool({
      name: "spike_prepare_application_ticket", label: "Prepare Application Ticket", description: "Prepare the bounded immutable Application worker exchange.", promptSnippet: "Prepare one exact Application Ticket exchange",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "ticketId"], properties: { goalId: nonBlankString, applicationId: nonBlankString, ticketId: nonBlankString } }, command: "application ticket prepare",
      args: (params) => ["application", "ticket", "prepare", "--goal", params.goalId, "--application", params.applicationId, "--ticket", params.ticketId],
    }, invoke, options),
    tool({
      name: "spike_dispatch_application_pi", label: "Dispatch Application Pi Ticket", description: "Dispatch one exact Application Ticket to a fresh worker; dispatch output remains operational only.", promptSnippet: "Dispatch the exact Application Ticket worker",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "ticketId", "worker"], properties: { goalId: nonBlankString, applicationId: nonBlankString, ticketId: nonBlankString, worker: nonBlankString } }, command: "application ticket dispatch-pi",
      args: (params) => ["application", "ticket", "dispatch-pi", "--goal", params.goalId, "--application", params.applicationId, "--ticket", params.ticketId, "--worker", params.worker],
    }, invoke, options),
    tool({
      name: "spike_application_worker_status", label: "Application worker status", description: "Observe only the exact Application worker runtime.", promptSnippet: "Observe Application worker operational state",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "ticketId"], properties: { goalId: nonBlankString, applicationId: nonBlankString, ticketId: nonBlankString } }, command: "application worker status",
      args: (params) => ["application", "worker", "status", "--goal", params.goalId, "--application", params.applicationId, "--ticket", params.ticketId],
    }, invoke, options),
    tool({
      name: "spike_application_worker_read", label: "Read Application worker", description: "Read bounded Application worker operational output; it is not workflow evidence.", promptSnippet: "Read Application worker output without treating it as evidence",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "ticketId"], properties: { goalId: nonBlankString, applicationId: nonBlankString, ticketId: nonBlankString } }, command: "application worker read",
      args: (params) => ["application", "worker", "read", "--goal", params.goalId, "--application", params.applicationId, "--ticket", params.ticketId],
    }, invoke, options),
    tool({
      name: "spike_publish_application_report", label: "Publish Application Report", description: "Validate exact Application output and publish its Report before rebuildable Candidate retention.", promptSnippet: "Publish one exact Application Report",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "ticketId", "worker", "commitSummary"], properties: { goalId: nonBlankString, applicationId: nonBlankString, ticketId: nonBlankString, worker: nonBlankString, commitSummary: nonBlankString } }, command: "application report publish",
      args: (params) => ["application", "report", "publish", "--goal", params.goalId, "--application", params.applicationId, "--ticket", params.ticketId, "--worker", params.worker, "--commit-summary", params.commitSummary],
    }, invoke, options),
    tool({
      name: "spike_recover_application", label: "Recover Application", description: "Goal-scoped supervisor recovery for one Application Ticket.", promptSnippet: "Recover one exact Application Ticket",
      parameters: { type: "object", additionalProperties: false, required: ["goalId", "applicationId", "ticketId"], properties: { goalId: nonBlankString, applicationId: nonBlankString, ticketId: nonBlankString, reason: nonBlankString } }, command: "application recover",
      args: (params) => { const args = ["application", "recover", "--goal", params.goalId, "--application", params.applicationId, "--ticket", params.ticketId]; optional(args, "--reason", params.reason); return args; },
    }, invoke, options),
    tool({
      name: "spike_create_goal",
      label: "Create approved Goal",
      description: "Create a Goal only after the operator explicitly approves its outcome and constraints. Pass the operator's exact approval statement; never infer or invent approval.",
      promptSnippet: "Create one explicitly operator-approved Goal",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "outcome", "approval"],
        properties: {
          title: nonBlankString,
          outcome: nonBlankString,
          approval: { type: "string", minLength: 1, description: "The operator's explicit approval statement." },
          constraints: { type: "array", items: nonBlankString },
          sourceRequestIds: { type: "array", maxItems: 100, uniqueItems: true, items: requestId },
          repositoryIdentity: nonBlankString,
        },
      },
      command: "goal create",
      args(params) {
        const args = ["goal", "create", "--title", params.title, "--outcome", params.outcome, "--approval", params.approval];
        repeated(args, "--constraint", params.constraints);
        repeated(args, "--request", params.sourceRequestIds);
        optional(args, "--repository-id", params.repositoryIdentity);
        return args;
      },
      beforeInvoke: (params) => requireStep("goal", params),
    }, invoke, options),
    tool({
      name: "spike_create_request",
      label: "Capture Request",
      description: "Capture unapproved future work in the host-local Request inbox. Capturing a Request does not approve or start work.",
      promptSnippet: "Capture unapproved future work without changing workflow state",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body"],
        properties: {
          title: requestTitle,
          body: requestBody,
          projectSlugs: { type: "array", maxItems: 20, uniqueItems: true, items: projectSlug },
        },
      },
      command: "request create",
      args(params) {
        const args = ["request", "create", "--title", params.title, "--statement", params.body];
        repeated(args, "--project", params.projectSlugs);
        return args;
      },
      stdin: (params) => params.body,
    }, invoke, options),
    tool({
      name: "spike_list_requests",
      label: "Request Inbox",
      description: "List host-local Requests. The Inbox shows open Requests by default.",
      promptSnippet: "Inspect unapproved Request inbox without changing workflow state",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          projectSlug,
          unassigned: { type: "boolean" },
          closed: { type: "boolean" },
        },
      },
      command: "request list",
      args(params) {
        const args = ["request", "list"];
        optional(args, "--project", params.projectSlug);
        if (params.unassigned === true) args.push("--unassigned");
        if (params.closed === true) args.push("--closed");
        return args;
      },
    }, invoke, options),
    tool({
      name: "spike_show_request",
      label: "Show Request",
      description: "Show one host-local Request without approving, closing, or starting work.",
      promptSnippet: "Inspect one unapproved Request without changing workflow state",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["requestId"],
        properties: { requestId },
      },
      command: "request show",
      args: (params) => ["request", "show", "--request", params.requestId],
    }, invoke, options),
    tool({
      name: "spike_revise_plan",
      label: "Revise Plan",
      description: "Atomically replace one Goal's mutable Plan body through Spike.",
      promptSnippet: "Revise the planner-owned Plan notebook",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "body"],
        properties: { goalId: nonBlankString, body: nonBlankString },
      },
      command: "plan revise",
      args: (params) => ["plan", "revise", "--goal", params.goalId],
      stdin: (params) => params.body,
      beforeInvoke: (params) => requireStep("plan", params),
    }, invoke, options),
    tool({
      name: "spike_create_change",
      label: "Create Change",
      description: "Create the next sequential Change at the Goal's integrated revision.",
      promptSnippet: "Create one coherent Change integration unit",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "title", "intent", "rationale", "acceptanceCriteria"],
        properties: {
          goalId: nonBlankString,
          title: nonBlankString,
          intent: nonBlankString,
          rationale: nonBlankString,
          acceptanceCriteria: { type: "array", minItems: 1, items: nonBlankString },
          nonGoals: { type: "array", items: nonBlankString },
          dependencies: { type: "array", items: nonBlankString },
        },
      },
      command: "change create",
      args(params) {
        const args = [
          "change", "create", "--goal", params.goalId, "--title", params.title,
          "--intent", params.intent, "--rationale", params.rationale,
        ];
        repeated(args, "--acceptance", params.acceptanceCriteria);
        repeated(args, "--non-goal", params.nonGoals);
        repeated(args, "--dependency", params.dependencies);
        return args;
      },
      beforeInvoke: (params) => requireStep("change", params),
    }, invoke, options),
    tool({
      name: "spike_decide_change",
      label: "Decide Change",
      description: "Land, reject, or abandon a Change after Spike verifies the durable preconditions.",
      promptSnippet: "Record an immutable terminal Change decision",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "disposition"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          disposition: { type: "string", enum: ["land", "reject", "abandon"] },
          statement: nonBlankString,
        },
      },
      command: (params) => `change ${params.disposition}`,
      args(params) {
        const args = ["change", params.disposition, "--goal", params.goalId, "--change", params.changeId];
        optional(args, "--statement", params.statement);
        return args;
      },
      beforeInvoke: (params) => requireStep("decide", params),
    }, invoke, options),
    tool({
      name: "spike_issue_implement",
      label: "Issue Implement Ticket",
      description: "Issue the initial implementation Ticket for the complete Change with frozen execution policy and model selection.",
      promptSnippet: "Issue one Implement Ticket for the complete Change",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "instruction"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          context: { type: "string" },
          isolation: { type: "string", enum: ["workspace", "container"] },
          networkAccess: { type: "string", enum: ["none", "restricted", "unrestricted"] },
          credentialGrants: { type: "array", items: nonBlankString },
          clearCredentialGrants: { type: "boolean" },
          model: nonBlankString,
          thinking,
        },
      },
      command: "ticket issue",
      args(params) {
        const args = [
          "ticket", "issue", "--goal", params.goalId, "--change", params.changeId,
          "--instruction", params.instruction, "--role", "implement",
        ];
        optional(args, "--context", params.context);
        optional(args, "--isolation", params.isolation);
        optional(args, "--network-access", params.networkAccess);
        repeated(args, "--credential", params.credentialGrants);
        if (params.clearCredentialGrants === true) args.push("--clear-credentials");
        optional(args, "--model", params.model);
        optional(args, "--thinking", params.thinking);
        return args;
      },
      beforeInvoke: (params) => requireStep("implement", params),
    }, invoke, options),
    tool({
      name: "spike_issue_review",
      label: "Issue Review Ticket",
      description: "Issue a fresh independent review Ticket for one exact producing implementation Ticket.",
      promptSnippet: "Issue one exact-Candidate Review Ticket",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "instruction", "producingImplementationTicketId"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          producingImplementationTicketId: nonBlankString,
          context: { type: "string" },
          isolation: { type: "string", enum: ["workspace", "container"] },
          networkAccess: { type: "string", enum: ["none", "restricted", "unrestricted"] },
          credentialGrants: { type: "array", items: nonBlankString },
          clearCredentialGrants: { type: "boolean" },
          model: nonBlankString,
          thinking,
        },
      },
      command: "ticket issue",
      args(params) {
        const args = [
          "ticket", "issue", "--goal", params.goalId, "--change", params.changeId,
          "--instruction", params.instruction, "--role", "review",
          "--implementation-ticket", params.producingImplementationTicketId,
        ];
        optional(args, "--context", params.context);
        optional(args, "--isolation", params.isolation);
        optional(args, "--network-access", params.networkAccess);
        repeated(args, "--credential", params.credentialGrants);
        if (params.clearCredentialGrants === true) args.push("--clear-credentials");
        optional(args, "--model", params.model);
        optional(args, "--thinking", params.thinking);
        return args;
      },
      beforeInvoke: (params) => requireStep("review", params),
    }, invoke, options),
    tool({
      name: "spike_issue_remediate",
      label: "Issue Remediate Ticket",
      description: "Issue a fresh implementation-role Ticket focused on one exact review Report's accepted findings.",
      promptSnippet: "Issue one finding-focused Remediate Ticket",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "instruction", "responseToReviewTicketId"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          responseToReviewTicketId: nonBlankString,
          context: { type: "string" },
          isolation: { type: "string", enum: ["workspace", "container"] },
          networkAccess: { type: "string", enum: ["none", "restricted", "unrestricted"] },
          credentialGrants: { type: "array", items: nonBlankString },
          clearCredentialGrants: { type: "boolean" },
          model: nonBlankString,
          thinking,
        },
      },
      command: "ticket issue",
      args(params) {
        const args = [
          "ticket", "issue", "--goal", params.goalId, "--change", params.changeId,
          "--instruction", params.instruction, "--role", "implement",
          "--response-to-review", params.responseToReviewTicketId,
        ];
        optional(args, "--context", params.context);
        optional(args, "--isolation", params.isolation);
        optional(args, "--network-access", params.networkAccess);
        repeated(args, "--credential", params.credentialGrants);
        if (params.clearCredentialGrants === true) args.push("--clear-credentials");
        optional(args, "--model", params.model);
        optional(args, "--thinking", params.thinking);
        return args;
      },
      beforeInvoke: (params) => requireStep("remediate", params),
    }, invoke, options),
    tool({
      name: "spike_dispatch_pi",
      label: "Dispatch Pi Ticket",
      description: "Ask Spike to launch a fresh Pi worker for an issued Ticket. Output is operational staging evidence, never a Report.",
      promptSnippet: "Dispatch an issued Ticket to a fresh Pi worker",
      promptGuidelines: [
        "After an attended dispatch returns working, yield the planner turn and wait for the extension's one-shot operational recheck; do not poll spike_worker_status or spike_status.",
        "When the recheck arrives, call spike_status and explicitly publish the Report if the exact Ticket remains open.",
      ],
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "ticketId", "worker"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          ticketId: nonBlankString,
          worker: nonBlankString,
        },
      },
      command: "ticket dispatch-pi",
      args: (params) => [
        "ticket", "dispatch-pi", "--goal", params.goalId, "--change", params.changeId,
        "--ticket", params.ticketId, "--worker", params.worker,
      ],
      afterSuccess: async (params, response, context) => {
        const data = response.data as { hosting?: unknown; status?: unknown } | undefined;
        if (data?.hosting !== "herdr" || data.status !== "working") return;
        await armWorkerWake(context.cwd, {
          goalId: params.goalId,
          changeId: params.changeId,
          ticketId: params.ticketId,
        }, { replace: true, notifyUnavailableFailure: true });
      },
    }, invoke, options),
    tool({
      name: "spike_worker_status",
      label: "Worker status",
      description: "Observe a Ticket worker's Herdr lifecycle projection. This status is never workflow evidence.",
      promptSnippet: "Observe attended worker status without changing Ticket state",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "ticketId"],
        properties: { goalId: nonBlankString, changeId: nonBlankString, ticketId: nonBlankString },
      },
      command: "worker status",
      args: (params) => [
        "worker", "status", "--goal", params.goalId, "--change", params.changeId, "--ticket", params.ticketId,
      ],
    }, invoke, options),
    tool({
      name: "spike_worker_read",
      label: "Read worker terminal",
      description: "Read bounded attended worker terminal output for observation only. Terminal text cannot complete a Ticket or publish a Report.",
      promptSnippet: "Read attended worker terminal output without treating it as evidence",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "ticketId"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          ticketId: nonBlankString,
          lines: { type: "integer", minimum: 1, maximum: 10000 },
        },
      },
      command: "worker read",
      args(params) {
        const args = [
          "worker", "read", "--goal", params.goalId, "--change", params.changeId, "--ticket", params.ticketId,
        ];
        if (params.lines !== undefined) args.push("--lines", String(params.lines));
        return args;
      },
    }, invoke, options),
    tool({
      name: "spike_publish_report",
      label: "Publish Report",
      description: "Validate staged exchange output or host failure evidence and publish the Ticket's canonical immutable Report.",
      promptSnippet: "Publish the canonical Report for one Ticket",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "ticketId"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          ticketId: nonBlankString,
          commitSummary: nonBlankString,
          commitBody: { type: "string" },
          failure: nonBlankString,
        },
      },
      command: "report publish",
      args(params) {
        const args = [
          "report", "publish", "--goal", params.goalId, "--change", params.changeId,
          "--ticket", params.ticketId,
        ];
        optional(args, "--commit-summary", params.commitSummary);
        optional(args, "--commit-body", params.commitBody);
        optional(args, "--failure", params.failure);
        return args;
      },
    }, invoke, options),
    tool({
      name: "spike_recover",
      label: "Recover Spike",
      description: "Reconcile committed workflow state, interrupt open Tickets, and retry cleanup without issuing replacement work.",
      promptSnippet: "Recover from interrupted supervisor or worker execution",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId"],
        properties: { goalId: nonBlankString, reason: nonBlankString },
      },
      command: "recover",
      args(params) {
        // The Goal-scoped extension must not reach Application/main recovery.
        const args = ["recover"];
        if (options.goalId !== undefined) args.push("--goal-local");
        optional(args, "--goal", params.goalId);
        optional(args, "--reason", params.reason);
        return args;
      },
      beforeInvoke: (params) => requireStep("recover", params),
    }, invoke, options),
  ];

  const visible = options.goalId === undefined
    ? tools.filter((definition) => options.applications === true || !(applicationSupervisorToolNames as readonly string[]).includes(definition.name))
    : tools.filter((definition) => (goalPlannerToolNames as readonly string[]).includes(definition.name));
  for (const definition of visible) pi.registerTool(definition);
}

/** Register the fail-closed subset used by a planner owned by one Goal. */
export function registerGoalPlannerExtension(
  pi: SupervisorExtensionApi,
  goalId: string,
  projectIdentity: string,
  options: Omit<RegisterSupervisorExtensionOptions, "goalId" | "projectIdentity"> = {},
): void {
  if (typeof goalId !== "string" || !goalId.trim()) throw new Error("SPIKE_GOAL_ID must be a non-blank Goal ID");
  if (typeof projectIdentity !== "string" || !projectIdentity.trim()) throw new Error("SPIKE_PROJECT_IDENTITY must be a non-blank Project identity");
  registerSupervisorExtension(pi, { ...options, goalId, projectIdentity });
}

export default function spikeSupervisorExtension(pi: SupervisorExtensionApi): void {
  registerSupervisorExtension(pi, { applications: process.env["SPIKE_APPLICATION_TOOLS"] === "1" });
}
