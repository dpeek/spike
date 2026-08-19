import { spawn } from "node:child_process";

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
};

export const supervisorToolNames = [
  "spike_begin_step",
  "spike_status",
  "spike_apply_goal",
  "spike_create_goal",
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

function optional(args: string[], option: string, value: string | undefined): void {
  if (value !== undefined) args.push(option, value);
}

function repeated(args: string[], option: string, values: string[] | undefined): void {
  for (const value of values ?? []) args.push(option, value);
}

function tool(
  definition: Omit<ToolDefinition, "executionMode" | "execute"> & {
    command: string | ((params: any) => string);
    args: (params: any) => string[];
    stdin?: (params: any) => string | undefined;
    beforeInvoke?: (params: any, context: ToolContext) => void;
    afterSuccess?: (params: any, response: SpikeJsonSuccess, context: ToolContext) => void;
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
    async execute(_toolCallId, params, signal, _onUpdate, context) {
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
      definition.afterSuccess?.(params, response, context);
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
  const invoke = options.invoke ?? runSpikeJson;
  const waitForDone = options.waitForDone ?? runSpikeJson;
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

  const armWorkerWake = (
    cwd: string,
    identity: TicketIdentity,
    wakeOptions: { replace?: boolean; notifyUnavailableFailure?: boolean } = {},
  ): void => {
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
      const status = await invoke({
        cwd: context.cwd,
        args: ["status"],
        expectedCommand: "status",
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      for (const identity of openTicketIdentities(status.data)) armWorkerWake(context.cwd, identity);
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
        "Use Spike tools rather than editing files under .spike directly.",
      ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { goalId: optionalIdentity },
      },
      command: "status",
      args(params) {
        const args = ["status"];
        optional(args, "--goal", params.goalId);
        return args;
      },
    }, invoke, options),
    tool({
      name: "spike_apply_goal",
      label: "Apply completed Goal",
      description: "Apply a completed Goal's reviewed integration revision to an explicitly selected local target branch after explicit operator approval.",
      promptSnippet: "Apply one completed Goal only with explicit operator approval",
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
      command: "goal apply",
      args: (params) => [
        "goal", "apply", "--goal", params.goalId, "--target", params.targetBranch, "--approval", params.approval,
      ],
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
          repositoryIdentity: nonBlankString,
        },
      },
      command: "goal create",
      args(params) {
        const args = ["goal", "create", "--title", params.title, "--outcome", params.outcome, "--approval", params.approval];
        repeated(args, "--constraint", params.constraints);
        optional(args, "--repository-id", params.repositoryIdentity);
        return args;
      },
      beforeInvoke: (params) => requireStep("goal", params),
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
        required: ["goalId", "changeId", "instruction", "networkAccess"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          context: { type: "string" },
          isolation: { type: "string", enum: ["workspace", "container"] },
          networkAccess: { type: "string", enum: ["none", "restricted", "unrestricted"] },
          credentialGrants: { type: "array", items: nonBlankString },
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
        required: ["goalId", "changeId", "instruction", "producingImplementationTicketId", "networkAccess"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          producingImplementationTicketId: nonBlankString,
          context: { type: "string" },
          isolation: { type: "string", enum: ["workspace", "container"] },
          networkAccess: { type: "string", enum: ["none", "restricted", "unrestricted"] },
          credentialGrants: { type: "array", items: nonBlankString },
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
        required: ["goalId", "changeId", "instruction", "responseToReviewTicketId", "networkAccess"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          responseToReviewTicketId: nonBlankString,
          context: { type: "string" },
          isolation: { type: "string", enum: ["workspace", "container"] },
          networkAccess: { type: "string", enum: ["none", "restricted", "unrestricted"] },
          credentialGrants: { type: "array", items: nonBlankString },
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
      afterSuccess: (params, response, context) => {
        const data = response.data as { hosting?: unknown; status?: unknown } | undefined;
        if (data?.hosting !== "herdr" || data.status !== "working") return;
        armWorkerWake(context.cwd, {
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
        const args = ["recover"];
        optional(args, "--goal", params.goalId);
        optional(args, "--reason", params.reason);
        return args;
      },
      beforeInvoke: (params) => requireStep("recover", params),
    }, invoke, options),
  ];

  for (const definition of tools) pi.registerTool(definition);
}

export default function spikeSupervisorExtension(pi: SupervisorExtensionApi): void {
  registerSupervisorExtension(pi);
}
