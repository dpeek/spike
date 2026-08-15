import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

  const scan = async (ctx: ExtensionContext) => {
    if (scanning || !owner) return;
    scanning = true;
    try {
      const states = (await workerStates(ctx.cwd)).filter((state) => state.owner === owner);
      const active = states.filter((state) => !state.finishedAt).length;
      ctx.ui.setStatus("spike", active ? `spike: ${active} worker${active === 1 ? "" : "s"}` : undefined);

      for (const state of states) {
        const key = `${state.slug}:${state.startedAt}`;
        if (!state.finishedAt || notified.has(key)) continue;
        notified.add(key);
        pi.appendEntry(NOTIFIED_ENTRY, { key });
        const reply = await finalReply(state);
        const outcome = state.exitCode === 0 ? "completed" : `failed with exit code ${state.exitCode ?? "unknown"}`;
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
    timer = setInterval(() => void scan(ctx), 1_000);
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
    description: "Dispatch and manage isolated containerized Pi workers. Dispatch returns immediately; completion reports arrive asynchronously in this conversation.",
    promptSnippet: "Dispatch, list, stop, or open isolated container workers",
    promptGuidelines: [
      "Use spike_agents to delegate independent coding, investigation, testing, and review tasks that can run concurrently.",
      "Give every spike_agents dispatch a unique stable agent name and a focused, self-contained task.",
      "After dispatching with spike_agents, continue useful coordination rather than polling; completion reports arrive automatically.",
    ],
    parameters: Type.Object({
      action: StringEnum(["dispatch", "list", "stop", "open"] as const),
      name: Type.Optional(Type.String({ description: "Worker name for dispatch, stop, or open" })),
      task: Type.Optional(Type.String({ description: "Focused task for dispatch" })),
      model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["agent", params.action];
      if (params.action === "dispatch") {
        if (!params.name || !params.task) throw new Error("dispatch requires name and task");
        args.push(params.name, "--task", params.task, "--owner", ctx.sessionManager.getSessionId());
        const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
        if (model) args.push("--model", model);
        const thinking = params.thinking ?? ctx.thinkingLevel;
        if (thinking) args.push("--thinking", thinking);
      } else if (params.action === "list") {
        // No additional arguments.
      } else {
        if (!params.name) throw new Error(`${params.action} requires a name`);
        args.push(params.name);
      }

      const result = await pi.exec(spikeBin, args, { signal, timeout: 15_000 });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || `spike exited ${result.code}`);
      if (params.action === "dispatch") setTimeout(() => void scan(ctx), 250).unref();
      return {
        content: [{ type: "text", text: result.stdout.trim() || `${params.action} completed` }],
        details: { action: params.action, name: params.name, stdout: result.stdout, stderr: result.stderr },
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
