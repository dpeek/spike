import { spawn } from "node:child_process";

export type WorkerRole = "implement" | "review";

type CompletionData = {
  goalId: string;
  changeId?: string;
  applicationId?: string;
  ticketId: string;
  role: WorkerRole;
  outcome: "completed" | "blocked";
  workerRevision?: string;
  reviewedRevision?: string;
  artifacts: Array<{ path: string; sha256: string }>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: CompletionData;
  terminate: true;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ToolContext = {
  cwd: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  shutdown: () => void;
};
type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: Record<string, unknown>;
  executionMode: "sequential";
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ) => Promise<ToolResult>;
};

export type WorkerExtensionApi = {
  registerTool: (tool: ToolDefinition) => void;
};

export type RunWorkerCompletionInput = {
  cwd: string;
  payload: unknown;
  actualModel: string;
  actualThinking: ThinkingLevel;
  signal?: AbortSignal;
  command?: string;
  environment?: NodeJS.ProcessEnv;
};

export type RegisterWorkerExtensionOptions = {
  role?: WorkerRole;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  complete?: (input: RunWorkerCompletionInput) => Promise<CompletionData>;
  block?: (input: RunWorkerCompletionInput) => Promise<CompletionData>;
};

const maximumProcessOutputBytes = 1024 * 1024;
const nonBlankString = { type: "string", minLength: 1 } as const;
const artifactPath = {
  type: "string",
  minLength: 11,
  pattern: "^artifacts/",
  description: "Canonical relative path below artifacts/; Spike performs authoritative path validation",
} as const;
const artifacts = { type: "array", items: artifactPath } as const;
const finding = {
  type: "object",
  additionalProperties: false,
  required: ["id", "severity", "statement"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    statement: nonBlankString,
  },
} as const;
const acceptanceAssessment = {
  type: "object",
  additionalProperties: false,
  required: ["criterion", "assessment", "evidence"],
  properties: {
    criterion: nonBlankString,
    assessment: { type: "string", enum: ["met", "not-met", "unclear"] },
    evidence: nonBlankString,
  },
} as const;

const blockedParameters = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "evidence", "artifacts"],
  properties: {
    reason: nonBlankString,
    evidence: nonBlankString,
    artifacts,
  },
} as const;

const implementationParameters = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "verification", "assumptions", "limitations", "risks", "followUp", "artifacts"],
  properties: {
    summary: nonBlankString,
    verification: nonBlankString,
    assumptions: nonBlankString,
    limitations: nonBlankString,
    risks: nonBlankString,
    followUp: nonBlankString,
    artifacts,
  },
} as const;

const reviewParameters = {
  type: "object",
  additionalProperties: false,
  required: ["reviewStatement", "findings", "acceptanceAssessment", "verdict", "artifacts"],
  properties: {
    reviewStatement: nonBlankString,
    findings: { type: "array", items: finding },
    acceptanceAssessment: { type: "array", minItems: 1, items: acceptanceAssessment },
    verdict: { type: "string", enum: ["remediate", "approve", "reject", "ask-operator"] },
    artifacts,
  },
} as const;

function completionError(stdout: string, stderr: string): Error {
  try {
    const response = JSON.parse(stdout) as { error?: { message?: unknown } };
    if (typeof response.error?.message === "string" && response.error.message.trim()) {
      return new Error(`Spike rejected worker completion: ${response.error.message}`);
    }
  } catch {
    // Fall through to bounded process output.
  }
  const evidence = stderr.trim() || stdout.trim();
  return new Error(evidence ? `Spike rejected worker completion: ${evidence}` : "Spike rejected worker completion");
}

function parseCompletion(stdout: string): CompletionData {
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error("Spike worker completion returned invalid JSON");
  }
  if (typeof response !== "object" || response === null || !("ok" in response) || response.ok !== true || !("data" in response)) {
    throw new Error("Spike worker completion returned an invalid success response");
  }
  const data = response.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("goalId" in data) ||
    typeof data.goalId !== "string" ||
    (typeof (data as { changeId?: unknown }).changeId !== "string" && typeof (data as { applicationId?: unknown }).applicationId !== "string") ||
    !("ticketId" in data) ||
    typeof data.ticketId !== "string" ||
    !("role" in data) ||
    (data.role !== "implement" && data.role !== "review") ||
    !("artifacts" in data) ||
    !Array.isArray(data.artifacts) ||
    !("outcome" in data) ||
    (data.outcome !== "completed" && data.outcome !== "blocked")
  ) {
    throw new Error("Spike worker completion returned invalid completion data");
  }
  return data as CompletionData;
}

async function runWorkerSubmission(
  input: RunWorkerCompletionInput,
  action: "complete" | "block",
): Promise<CompletionData> {
  const actionLabel = action === "complete" ? "completion" : "block";
  if (input.signal?.aborted) throw new Error(`Spike worker ${actionLabel} was cancelled`);
  const command = input.command ?? input.environment?.["SPIKE_BIN"] ?? "spike";

  return new Promise<CompletionData>((resolve, reject) => {
    const child = spawn(command, ["worker", action, "--json"], {
      cwd: input.cwd,
      env: {
        ...(input.environment ?? process.env),
        SPIKE_ACTUAL_MODEL: input.actualModel,
        SPIKE_ACTUAL_THINKING: input.actualThinking,
      },
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
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (input.signal?.aborted) {
        reject(new Error(`Spike worker ${actionLabel} was cancelled`));
      } else if (outputLimitExceeded) {
        reject(new Error(`Spike worker ${actionLabel} process output exceeded its size limit`));
      } else if (code !== 0) {
        reject(completionError(stdoutText, stderrText));
      } else {
        try {
          resolve(parseCompletion(stdoutText));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(JSON.stringify(input.payload));
  });
}

export function runWorkerCompletion(input: RunWorkerCompletionInput): Promise<CompletionData> {
  return runWorkerSubmission(input, "complete");
}

export function runWorkerBlocked(input: RunWorkerCompletionInput): Promise<CompletionData> {
  return runWorkerSubmission(input, "block");
}

function requiredRole(role: string | undefined): WorkerRole {
  if (role === "implement" || role === "review") return role;
  throw new Error("SPIKE_TICKET_ROLE must be implement or review");
}

function actualSelection(context: ToolContext): { actualModel: string; actualThinking: ThinkingLevel } {
  const provider = context.model?.provider?.trim();
  const id = context.model?.id?.trim();
  if (!provider || !id) throw new Error("Pi worker completion cannot observe the active model");
  // Pi 0.73 reports disabled reasoning as "none" while newer Pi releases
  // report the Ticket vocabulary's "off". Normalize only that documented
  // spelling; every enabled level remains exact provenance.
  const reportedThinking = context.thinkingLevel;
  const actualThinking = reportedThinking === "none" || reportedThinking === undefined ? "off" : reportedThinking;
  if (!actualThinking || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(actualThinking)) {
    throw new Error("Pi worker completion cannot observe a supported effective thinking level");
  }
  return { actualModel: `${provider}/${id}`, actualThinking: actualThinking as ThinkingLevel };
}

function completionToolForRole(
  role: WorkerRole,
  complete: (input: RunWorkerCompletionInput) => Promise<CompletionData>,
  options: RegisterWorkerExtensionOptions,
): ToolDefinition {
  const implementation = role === "implement";
  const name = implementation ? "spike_complete_implementation" : "spike_complete_review";
  return {
    name,
    label: implementation ? "Complete implementation" : "Complete review",
    description: implementation
      ? "Submit final implementation evidence to Spike. Call this exactly once as the final action after implementation and verification are complete."
      : "Submit final independent review evidence to Spike. Call this exactly once as the final action after reviewing the exact Candidate.",
    promptSnippet: implementation
      ? "Complete the implementation Ticket with structured evidence"
      : "Complete the review Ticket with findings, criteria assessment, and verdict",
    promptGuidelines: [
      `Use ${name} as the final action for this Ticket; do not create submission.md or repository.bundle directly.`,
      `If ${name} reports an error, correct the payload or checkout and call it again.`,
    ],
    parameters: implementation ? implementationParameters : reviewParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const completion = await complete({
        cwd: context.cwd,
        payload: params,
        ...actualSelection(context),
        ...(signal === undefined ? {} : { signal }),
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (completion.role !== role || completion.outcome !== "completed") {
        throw new Error("Spike completed a different Ticket role or outcome than the active worker tool");
      }
      context.shutdown();
      return {
        content: [{
          type: "text",
          text: `Spike accepted ${role} Ticket ${completion.goalId}/${completion.applicationId ?? completion.changeId}/${completion.ticketId}.`,
        }],
        details: completion,
        terminate: true,
      };
    },
  };
}

function blockedToolForRole(
  role: WorkerRole,
  block: (input: RunWorkerCompletionInput) => Promise<CompletionData>,
  options: RegisterWorkerExtensionOptions,
): ToolDefinition {
  const implementation = role === "implement";
  const name = implementation ? "spike_block_implementation" : "spike_block_review";
  return {
    name,
    label: implementation ? "Report implementation blocked" : "Report review blocked",
    description: "Submit a blocked outcome with concrete reason and evidence. Use only when a condition outside the worker's control prevents completing this Ticket.",
    promptSnippet: "Report that the Ticket is blocked without producing a Candidate or verdict",
    promptGuidelines: [
      `Use ${name} instead of the completion tool when a condition outside your control prevents completion.`,
      "Do not use a blocked outcome for planned partial delivery or work that can be completed in this session.",
      `If ${name} reports an error, correct the payload and call it again.`,
    ],
    parameters: blockedParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const blocked = await block({
        cwd: context.cwd,
        payload: params,
        ...actualSelection(context),
        ...(signal === undefined ? {} : { signal }),
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (blocked.role !== role || blocked.outcome !== "blocked") {
        throw new Error("Spike blocked a different Ticket role or outcome than the active worker tool");
      }
      context.shutdown();
      return {
        content: [{
          type: "text",
          text: `Spike accepted blocked ${role} Ticket ${blocked.goalId}/${blocked.applicationId ?? blocked.changeId}/${blocked.ticketId}.`,
        }],
        details: blocked,
        terminate: true,
      };
    },
  };
}

export function workerExtensionOptions(environment: NodeJS.ProcessEnv): RegisterWorkerExtensionOptions {
  return {
    role: requiredRole(environment["SPIKE_TICKET_ROLE"]),
    command: environment["SPIKE_BIN"] ?? "spike",
    environment,
  };
}

export function registerWorkerExtension(
  pi: WorkerExtensionApi,
  options: RegisterWorkerExtensionOptions,
): void {
  const role = requiredRole(options.role);
  pi.registerTool(completionToolForRole(role, options.complete ?? runWorkerCompletion, options));
  pi.registerTool(blockedToolForRole(role, options.block ?? runWorkerBlocked, options));
}

export default function spikeWorkerExtension(pi: WorkerExtensionApi): void {
  registerWorkerExtension(pi, workerExtensionOptions(process.env));
}
