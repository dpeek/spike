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
};

export const supervisorToolNames = [
  "spike_status",
  "spike_revise_plan",
  "spike_create_change",
  "spike_decide_change",
  "spike_issue_ticket",
  "spike_dispatch_pi",
  "spike_publish_report",
  "spike_recover",
] as const;

const maximumProcessOutputBytes = 1024 * 1024;
const nonBlankString = { type: "string", minLength: 1 } as const;
const optionalIdentity = { type: "string", minLength: 1 } as const;
const thinking = { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh"] } as const;

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
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
  };
}

export function registerSupervisorExtension(
  pi: SupervisorExtensionApi,
  options: RegisterSupervisorExtensionOptions = {},
): void {
  const invoke = options.invoke ?? runSpikeJson;
  const tools: ToolDefinition[] = [
    tool({
      name: "spike_status",
      label: "Spike status",
      description: "Load workflow status derived by Spike from durable Goals, Changes, Tickets, Reports, and decisions.",
      promptSnippet: "Read Spike's authoritative derived workflow status",
      promptGuidelines: [
        "Use spike_status for workflow facts; never infer them from planner prose, worker terminal output, or a Pi process exit status.",
        "Treat spike_dispatch_pi output as operational staging evidence only; a Ticket remains open until spike_publish_report succeeds.",
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
    }, invoke, options),
    tool({
      name: "spike_issue_ticket",
      label: "Issue Ticket",
      description: "Issue the next sequential immutable Ticket with a frozen role model, thinking level, and execution policy.",
      promptSnippet: "Issue one bounded fresh-session Ticket",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["goalId", "changeId", "instruction"],
        properties: {
          goalId: nonBlankString,
          changeId: nonBlankString,
          instruction: nonBlankString,
          role: { type: "string", enum: ["implement", "review"] },
          producingImplementationTicketId: optionalIdentity,
          remediationReviewTicketId: optionalIdentity,
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
          "--instruction", params.instruction,
        ];
        optional(args, "--role", params.role);
        optional(args, "--implementation-ticket", params.producingImplementationTicketId);
        optional(args, "--remediation-review", params.remediationReviewTicketId);
        optional(args, "--context", params.context);
        optional(args, "--isolation", params.isolation);
        optional(args, "--network-access", params.networkAccess);
        repeated(args, "--credential", params.credentialGrants);
        optional(args, "--model", params.model);
        optional(args, "--thinking", params.thinking);
        return args;
      },
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
        properties: { goalId: optionalIdentity, reason: nonBlankString },
      },
      command: "recover",
      args(params) {
        const args = ["recover"];
        optional(args, "--goal", params.goalId);
        optional(args, "--reason", params.reason);
        return args;
      },
    }, invoke, options),
  ];

  for (const definition of tools) pi.registerTool(definition);
}

export default function spikeSupervisorExtension(pi: SupervisorExtensionApi): void {
  registerSupervisorExtension(pi);
}
