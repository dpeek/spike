import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentOutcomeDescription } from "../src/lifecycle.ts";

const spikeBin = fileURLToPath(new URL("../bin/spike", import.meta.url));
const NOTIFIED_ENTRY = "spike-worker-notified";
const MAX_REPORT_BYTES = 50 * 1024;

type WorkerState = {
  slug: string;
  owner?: string;
  task?: string;
  log?: string;
  errorLog?: string;
  operatorUrl?: string;
  backend?: "headless" | "herdr";
  herdrName?: string;
  herdrPaneId?: string;
  goalId?: string;
  ticketId?: string;
  runId?: string;
  lifecycle?: "running" | "stopping" | "stopped" | "failed" | "completed";
  outcome?: "stopped" | "failed" | "completed";
  terminationKind?: "requested" | "unexpected";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
};

function textFromMessage(message: any): string {
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

async function finalReply(state: WorkerState): Promise<string> {
  let reply = "";
  if (state.log) {
    try {
      for (const line of (await readFile(state.log, "utf8")).split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event?.type === "message_end") reply = textFromMessage(event.message) || reply;
        } catch {
          // Container progress and spike lifecycle lines are intentionally ignored.
        }
      }
    } catch {
      // Fall through to stderr.
    }
  }
  if (!reply && state.errorLog) {
    try { reply = (await readFile(state.errorLog, "utf8")).trim(); } catch { /* no stderr */ }
  }
  if (!reply) reply = "Worker exited without a final textual response.";
  if (Buffer.byteLength(reply, "utf8") > MAX_REPORT_BYTES) {
    reply = `${reply.slice(0, MAX_REPORT_BYTES)}\n\n[Worker report truncated; full output: ${state.log ?? "unavailable"}]`;
  }
  return reply;
}

async function workerStates(cwd: string): Promise<WorkerState[]> {
  const directory = join(cwd, ".pi-swarm", "agents");
  const states: WorkerState[] = [];
  try {
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      try { states.push(JSON.parse(await readFile(join(directory, file), "utf8")) as WorkerState); } catch { /* partial write */ }
    }
  } catch {
    // No workers yet.
  }
  return states;
}

export default function spikeSupervisor(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let scanning = false;
  let owner = "";
  const notified = new Set<string>();
  const herdrStatuses = new Map<string, string>();

  const scan = async (ctx: ExtensionContext) => {
    if (scanning || !owner) return;
    scanning = true;
    try {
      const states = (await workerStates(ctx.cwd)).filter((state) => state.owner === owner);
      const active = states.filter((state) => !state.finishedAt).length;
      ctx.ui.setStatus("spike", active ? `spike: ${active} worker${active === 1 ? "" : "s"}` : undefined);

      let herdrAgents: any[] = [];
      if (states.some((state) => state.backend === "herdr" && !state.finishedAt)) {
        const listed = await pi.exec("herdr", ["agent", "list"], { timeout: 5_000 });
        if (listed.code === 0) {
          try { herdrAgents = JSON.parse(listed.stdout)?.result?.agents ?? []; } catch { /* retry next scan */ }
        }
      }

      for (const state of states) {
        const key = `${state.slug}:${state.startedAt}`;
        if (state.backend === "herdr" && !state.finishedAt) {
          const agent = herdrAgents.find((candidate) =>
            candidate.name === state.herdrName || candidate.pane_id === state.herdrPaneId);
          if (!agent) continue;
          const status = String(agent.agent_status ?? "unknown");
          const previous = herdrStatuses.get(key);
          herdrStatuses.set(key, status);
          const settled = status === "idle" || status === "done";
          const blocked = status === "blocked" && previous !== "blocked";
          if ((settled && previous === "working") || blocked) {
            const read = await pi.exec("herdr", ["agent", "read", state.herdrName ?? state.herdrPaneId!, "--source", "recent-unwrapped", "--lines", "160"], { timeout: 5_000 });
            let reply = (read.stdout || read.stderr || "Worker settled without readable terminal output.").trim();
            if (Buffer.byteLength(reply, "utf8") > MAX_REPORT_BYTES) reply = `${reply.slice(-MAX_REPORT_BYTES)}\n\n[Earlier terminal output truncated]`;
            const reportKey = `${key}:${agent.state_change_seq ?? status}`;
            if (!notified.has(reportKey)) {
              notified.add(reportKey);
              pi.appendEntry(NOTIFIED_ENTRY, { key: reportKey });
              pi.sendMessage({
                customType: "spike-worker-report",
                display: true,
                content: [
                  `Persistent Spike worker **${state.slug}** is ${status}.`,
                  state.task ? `Original task: ${state.task}` : "",
                  state.operatorUrl ? `Operator route: ${state.operatorUrl}` : "",
                  blocked ? "The worker needs input." : "The worker is ready for follow-up work.",
                  "",
                  "Recent terminal output:",
                  reply,
                ].filter(Boolean).join("\n"),
                details: { ...state, herdrStatus: status },
              }, { deliverAs: "followUp", triggerTurn: true });
            }
          }
          continue;
        }

        if (!state.finishedAt || notified.has(key)) continue;
        notified.add(key);
        pi.appendEntry(NOTIFIED_ENTRY, { key });
        const reply = await finalReply(state);
        const outcome = agentOutcomeDescription(state);
        pi.sendMessage({
          customType: "spike-worker-report",
          display: true,
          content: [
            `Spike worker **${state.slug}** ${outcome}.`,
            state.task ? `Task: ${state.task}` : "",
            state.operatorUrl ? `Operator URL: ${state.operatorUrl}` : "",
            "",
            "Final response:",
            reply,
          ].filter(Boolean).join("\n"),
          details: state,
        }, { deliverAs: "followUp", triggerTurn: true });
      }
    } finally {
      scanning = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    owner = ctx.sessionManager.getSessionId();
    notified.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === NOTIFIED_ENTRY) {
        const key = (entry.data as { key?: unknown } | undefined)?.key;
        if (typeof key === "string") notified.add(key);
      }
    }
    if (timer) clearInterval(timer);
    await scan(ctx);
    timer = setInterval(() => void scan(ctx), 500);
    timer.unref();
    ctx.ui.notify("Spike supervisor ready", "info");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx.ui.setStatus("spike", undefined);
  });

  pi.registerTool({
    name: "spike_agents",
    label: "Spike Agents",
    description: "Dispatch and manage isolated containerized Pi workers. dispatch_ticket launches the one durable ready ticket through its durable run record; dispatch remains free-form. Inside Herdr, free-form dispatch creates persistent interactive workers that accept follow-ups; otherwise it creates one-shot workers. Publish imports a verified committed worker branch into a host review ref without merging it. Reports arrive asynchronously.",
    promptSnippet: "Dispatch durable tickets or free-form work, message, read, publish, list, stop, or open isolated container workers",
    promptGuidelines: [
      "Inspect existing durable goal state with spike goal status --json before drafting or activating a new goal, and never silently replace an active goal.",
      "Before dispatch_ticket, inspect both spike ticket status --json and spike run status --json. A ready ticket and its run survive supervisor restarts; never redispatch merely because the supervisor restarted or a live runtime cannot be found.",
      "Before drafting a ticket, inspect spike ticket status --json and spike ticket show.",
      "Ticket issuance records planner intent but does not dispatch a worker; use dispatch_ticket exactly once for the durable ready ticket.",
      "Never treat conversational intent, chat history, or terminal output as goal approval; activation requires an explicit operator approval statement at the CLI boundary.",
      "Use spike_agents to delegate independent coding, investigation, testing, and review tasks that can run concurrently.",
      "Give every spike_agents dispatch a unique stable agent name and a focused, self-contained task.",
      "After dispatching with spike_agents, continue useful coordination rather than polling; completion reports arrive automatically.",
      "Use spike_agents send for follow-up work when the supervisor is running inside Herdr.",
      "Publish only after a persistent worker reports that it committed its intended changes and completed verification.",
      "Publication creates a stable review target. Inspect or summarize it, but do not merge it.",
    ],
    parameters: Type.Object({
      action: StringEnum(["dispatch_ticket", "dispatch", "send", "read", "publish", "list", "stop", "open"] as const),
      name: Type.Optional(Type.String({ description: "Worker name for dispatch_ticket, dispatch, send, read, publish, stop, or open" })),
      task: Type.Optional(Type.String({ description: "Focused task for dispatch or follow-up text for send" })),
      model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const commandAction = params.action === "dispatch" && process.env.HERDR_ENV === "1" ? "persistent" : params.action;
      const args = params.action === "dispatch_ticket" ? ["ticket", "dispatch"] : ["agent", commandAction];
      if (params.action === "dispatch_ticket") {
        if (!params.name) throw new Error("dispatch_ticket requires name");
        if (params.task) throw new Error("dispatch_ticket reads the durable ticket and does not accept free-form task text");
        args.push(params.name);
        const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
        if (model) args.push("--model", model);
        const thinking = params.thinking ?? ctx.thinkingLevel;
        if (thinking) args.push("--thinking", thinking);
      } else if (params.action === "dispatch") {
        if (!params.name || !params.task) throw new Error("dispatch requires name and task");
        args.push(params.name, "--task", params.task, "--owner", ctx.sessionManager.getSessionId());
        const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
        if (model) args.push("--model", model);
        const thinking = params.thinking ?? ctx.thinkingLevel;
        if (thinking) args.push("--thinking", thinking);
      } else if (params.action === "send") {
        if (!params.name || !params.task) throw new Error("send requires name and task");
        args.push(params.name, "--task", params.task);
      } else if (params.action === "list") {
        // No additional arguments.
      } else if (params.action === "publish") {
        if (!params.name) throw new Error("publish requires a name");
        args.push(params.name, "--json");
      } else {
        if (!params.name) throw new Error(`${params.action} requires a name`);
        args.push(params.name);
      }

      const executable = params.action === "dispatch_ticket" ? "env" : spikeBin;
      const commandArgs = params.action === "dispatch_ticket"
        ? [`SPIKE_OWNER=${ctx.sessionManager.getSessionId()}`, spikeBin, ...args]
        : args;
      const longRunning = params.action === "publish" || params.action === "dispatch_ticket";
      const result = await pi.exec(executable, commandArgs, { signal, timeout: longRunning ? 120_000 : 45_000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || `spike exited ${result.code}`);
      if (params.action === "dispatch_ticket" || params.action === "dispatch" || params.action === "send") {
        setTimeout(() => void scan(ctx), 100).unref();
        setTimeout(() => void scan(ctx), 350).unref();
      }
      let publication: unknown;
      if (params.action === "publish") {
        try { publication = JSON.parse(result.stdout); }
        catch { throw new Error("spike publish returned invalid structured metadata"); }
      }
      return {
        content: [{ type: "text", text: result.stdout.trim() || `${params.action} completed` }],
        details: { action: params.action, name: params.name, ...(publication ? { publication } : {}), stdout: result.stdout, stderr: result.stderr },
      };
    },
  });

  pi.registerCommand("spike-agents", {
    description: "List Spike container workers",
    handler: async (_args, ctx) => {
      const result = await pi.exec(spikeBin, ["agent", "list"], { timeout: 10_000 });
      ctx.ui.notify(result.stdout.trim() || result.stderr.trim(), result.code === 0 ? "info" : "error");
    },
  });
}
