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

function executable(): string {
  return process.env["SPIKE_HERDR_BIN"] ?? "herdr";
}

async function command(
  args: string[],
  options: { raw?: boolean; inherit?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable(), ...args], {
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

export const herdrOperations: HerdrOperations = {
  async createTab(input) {
    if (process.env["HERDR_ENV"] !== "1") throw new Error("Herdr worker hosting requires a Herdr-managed planner pane");
    const workspace = process.env["HERDR_WORKSPACE_ID"];
    if (!workspace) throw new Error("Herdr worker hosting cannot identify the planner workspace");
    const args = ["tab", "create", "--workspace", workspace, "--cwd", input.cwd, "--label", input.label, "--no-focus"];
    for (const [key, value] of Object.entries(input.environment)) args.push("--env", `${key}=${value}`);
    const response = envelope((await command(args)).stdout);
    return {
      tab: requireHandle(response.result?.["tab"]?.tab_id, "tab"),
      pane: requireHandle(response.result?.["root_pane"]?.pane_id, "pane"),
    };
  },

  async run(pane, launchedCommand) {
    await command(["pane", "run", pane, launchedCommand]);
  },

  async status(pane) {
    try {
      const response = envelope((await command(["agent", "get", pane])).stdout);
      const status = response.result?.["agent"]?.agent_status;
      return ["idle", "working", "blocked", "done", "unknown"].includes(status) ? status : "unavailable";
    } catch {
      return "unavailable";
    }
  },

  async read(pane, input = {}) {
    const args = ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(input.lines ?? 120), "--raw"];
    if (input.ansi) args.push("--ansi");
    const result = await command(args, { raw: true });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Herdr terminal read exited with code ${result.code}`);
    return result.stdout;
  },

  async attach(pane) {
    return (await command(["agent", "attach", pane], { inherit: true })).code;
  },

  async closeTab(tab) {
    try {
      await command(["tab", "close", tab]);
    } catch (error) {
      if (error instanceof HerdrCommandError && error.code === "tab_not_found") return;
      throw error;
    }
  },
};
