export type HerdrHandles = {
  tab: string;
  pane: string;
};

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "unavailable";

export type CreateHerdrTabInput = {
  cwd: string;
  label: string;
  environment: Record<string, string>;
};

export type ReadHerdrTerminalInput = {
  lines?: number;
  ansi?: boolean;
};

export type HerdrOperations = {
  createTab: (input: CreateHerdrTabInput) => Promise<HerdrHandles>;
  run: (pane: string, command: string) => Promise<void>;
  status: (pane: string) => Promise<HerdrAgentStatus>;
  read: (pane: string, input?: ReadHerdrTerminalInput) => Promise<string>;
  attach: (pane: string) => Promise<number>;
  closeTab: (tab: string) => Promise<void>;
  /** Exact label discovery is operational only; callers must not infer state from terminal text. */
  findTabsByLabel?: (label: string) => Promise<HerdrHandles[]>;
};

export type HerdrContext = {
  executable: string;
  managed: boolean;
  workspaceId?: string;
};

type HerdrEnvelope = {
  result?: Record<string, any>;
  error?: { code?: unknown; message?: unknown };
};

const maximumOutputBytes = 1024 * 1024;

class HerdrCommandError extends Error {
  constructor(readonly code: string | undefined, message: string) {
    super(message);
  }
}

async function command(
  context: HerdrContext,
  args: string[],
  options: { raw?: boolean; inherit?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([context.executable, ...args], {
    stdin: options.inherit ? "inherit" : "ignore",
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
  });
  if (options.inherit) return { code: await child.exited, stdout: "", stderr: "" };
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maximumOutputBytes) {
    throw new Error("Herdr command output exceeded its size limit");
  }
  if (code === 0 || options.raw) return { code, stdout, stderr };

  let envelope: HerdrEnvelope | undefined;
  try {
    envelope = JSON.parse(stderr || stdout) as HerdrEnvelope;
  } catch {
    // Use bounded textual evidence below.
  }
  const error = envelope?.error;
  throw new HerdrCommandError(
    typeof error?.code === "string" ? error.code : undefined,
    typeof error?.message === "string" ? error.message : (stderr || stdout).trim() || `Herdr exited with code ${code}`,
  );
}

function envelope(source: string): HerdrEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Herdr returned invalid JSON");
  }
  if (typeof value !== "object" || value === null) throw new Error("Herdr returned an invalid response");
  return value as HerdrEnvelope;
}

function requireHandle(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Herdr did not return an opaque ${label} handle`);
  return value;
}

function workspace(context: HerdrContext, operation: string): string {
  if (!context.managed) throw new Error(`Herdr ${operation} requires a Herdr-managed planner pane`);
  if (!context.workspaceId) throw new Error(`Herdr ${operation} cannot identify the planner workspace`);
  return context.workspaceId;
}

/** Bind host configuration once at the process composition boundary. */
export function createHerdrOperations(context: HerdrContext): HerdrOperations {
  return {
    async createTab(input) {
      const args = ["tab", "create", "--workspace", workspace(context, "worker hosting"), "--cwd", input.cwd, "--label", input.label, "--no-focus"];
      for (const [key, value] of Object.entries(input.environment)) args.push("--env", `${key}=${value}`);
      const response = envelope((await command(context, args)).stdout);
      return {
        tab: requireHandle(response.result?.["tab"]?.tab_id, "tab"),
        pane: requireHandle(response.result?.["root_pane"]?.pane_id, "pane"),
      };
    },

    async run(pane, launchedCommand) {
      await command(context, ["pane", "run", pane, launchedCommand]);
    },

    async status(pane) {
      try {
        const response = envelope((await command(context, ["agent", "get", pane])).stdout);
        const status = response.result?.["agent"]?.agent_status;
        return ["idle", "working", "blocked", "done", "unknown"].includes(status) ? status : "unavailable";
      } catch {
        return "unavailable";
      }
    },

    async read(pane, input = {}) {
      const args = ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(input.lines ?? 120), "--raw"];
      if (input.ansi) args.push("--ansi");
      const result = await command(context, args, { raw: true });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Herdr terminal read exited with code ${result.code}`);
      return input.ansi ? result.stdout : Bun.stripANSI(result.stdout);
    },

    async attach(pane) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Herdr terminal attachment requires an interactive TTY");
      }
      return (await command(context, ["agent", "attach", pane], { inherit: true })).code;
    },

    async closeTab(tab) {
      try {
        await command(context, ["tab", "close", tab]);
      } catch (error) {
        if (error instanceof HerdrCommandError && error.code === "tab_not_found") return;
        throw error;
      }
    },

    async findTabsByLabel(label) {
      if (typeof label !== "string" || !label.trim()) throw new Error("Herdr label must not be blank");
      const workspaceId = workspace(context, "planner discovery");
      const response = envelope((await command(context, ["tab", "list", "--workspace", workspaceId])).stdout);
      const tabs = response.result?.["tabs"];
      if (!Array.isArray(tabs)) throw new Error("Herdr did not return tab listings");
      const matchingTabs = tabs.filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["label"] === label,
      ).map((tab) => requireHandle(tab["tab_id"], "tab"));
      if (matchingTabs.length === 0) return [];
      const paneResponse = envelope((await command(context, ["pane", "list", "--workspace", workspaceId])).stdout);
      const panes = paneResponse.result?.["panes"];
      if (!Array.isArray(panes)) throw new Error("Herdr did not return pane listings");
      return matchingTabs.map((tab) => {
        const matchingPanes = panes.filter((entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["tab_id"] === tab,
        );
        if (matchingPanes.length !== 1) throw new Error(`Herdr could not reconstruct one planner pane for tab ${tab}`);
        return { tab, pane: requireHandle(matchingPanes[0]!["pane_id"], "pane") };
      });
    },
  };
}

/** Default executable for callers that do not need workspace operations. */
export const herdrOperations = createHerdrOperations({ executable: "herdr", managed: false });
