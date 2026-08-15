#!/usr/bin/env bun
import { closeSync, existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.3.1";
const setupRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Runtime = "apple" | "docker";
type Config = {
  runtime?: "auto" | Runtime;
  image?: string;
  containerPort?: number;
  portless?: boolean;
  cpus?: number;
  memory?: string;
  shmSize?: string;
  pids?: number;
};

type AgentState = {
  name: string;
  slug: string;
  project: string;
  runtime: Runtime;
  container: string;
  workspaceVolume: string;
  network: string;
  alias?: string;
  hostPort?: number;
  containerPort: number;
  operatorUrl?: string;
  task?: string;
  owner?: string;
  log?: string;
  errorLog?: string;
  backend?: "headless" | "herdr";
  herdrName?: string;
  herdrWorkspaceId?: string;
  herdrTabId?: string;
  herdrPaneId?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  pid: number;
};

const help = `spike ${VERSION} — isolated Pi agents

Usage:
  spike init
  spike doctor
  spike up
  spike build
  spike supervisor [--herdr] [pi arguments...]
  spike herdr setup|status|attach
  spike agent run <name> [pi arguments...]
  spike agent run <name> -- <command> [arguments...]
  spike agent dispatch <name> --task <task> [--model <model>]
  spike agent persistent <name> --task <task> [--model <model>]
  spike agent send <name> --task <follow-up>
  spike agent read <name>
  spike agent attach <name>
  spike agent list
  spike agent stop <name>
  spike agent remove <name> [--force]
  spike agent open <name>
  spike down

Environment:
  SPIKE_RUNTIME       auto (default), apple, or docker
  SPIKE_IMAGE         Image name (default: pi-agent:0.1)
  SPIKE_PORTLESS      1 (default when installed) or 0
  SPIKE_CONTAINER_PORT  Container service port (default: 3000)
  SPIKE_HOST_PORT     Fixed host port instead of automatic allocation
  SPIKE_PORTLESS_TLD  Override detected Portless TLD
  REPOSITORY_URL      Clone a remote instead of the current repository
  AGENT_CPUS          CPU limit (default: 2)
  AGENT_MEMORY        Memory limit (default: 4g)

Examples:
  spike up
  spike supervisor
  spike agent run frontend
  spike agent dispatch tests --task "Run the test suite and fix failures"
  spike agent open frontend
`;

function fail(message: string, code = 1): never {
  console.error(`spike: ${message}`);
  process.exit(code);
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result || !/[a-z0-9]/.test(result)) fail("name must contain a letter or number", 2);
  return result;
}

async function capture(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function inherit(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

async function available(command: string): Promise<boolean> {
  return (await capture(["sh", "-c", `command -v "$1" >/dev/null 2>&1`, "sh", command])).code === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function herdrJson(args: string[]): Promise<any> {
  const result = await capture(["herdr", ...args]);
  if (result.code !== 0) fail(`Herdr ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout); }
  catch { fail(`Herdr returned invalid JSON for ${args.join(" ")}`); }
}

async function requireHerdr() {
  if (!await available("herdr")) fail("Herdr 0.8 or newer is required; install it with: brew install herdr");
  const status = await capture(["herdr", "status", "server"]);
  if (status.code !== 0 || !status.stdout.includes("status: running")) {
    fail("Herdr server is not running; start it with: brew services start herdr");
  }
}

function herdrAgentName(value: string): string {
  let result = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!/^[a-z]/.test(result)) result = `s-${result}`;
  return result.slice(0, 32).replace(/-+$/g, "") || "spike-agent";
}

async function createHerdrPane(root: string, project: string, label: string) {
  await requireHerdr();
  const workspaceLabel = `spike:${project}`;
  const listed = await herdrJson(["workspace", "list"]);
  const workspaces = listed?.result?.workspaces ?? [];
  let workspace = workspaces.find((candidate: any) => candidate.label === workspaceLabel);
  if (!workspace) {
    const created = await herdrJson(["workspace", "create", "--cwd", root, "--label", workspaceLabel, "--no-focus"]);
    workspace = created.result.workspace;
    const tabId = created.result.tab.tab_id as string;
    await herdrJson(["tab", "rename", tabId, label]);
    return { workspaceId: workspace.workspace_id as string, tabId, paneId: created.result.root_pane.pane_id as string };
  }
  const created = await herdrJson(["tab", "create", "--workspace", workspace.workspace_id, "--cwd", root, "--label", label, "--no-focus"]);
  return {
    workspaceId: workspace.workspace_id as string,
    tabId: created.result.tab.tab_id as string,
    paneId: created.result.root_pane.pane_id as string,
  };
}

async function waitForHerdrAgent(paneId: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await herdrJson(["agent", "list"]);
    const agents = listed?.result?.agents ?? [];
    const found = agents.find((candidate: any) => candidate.pane_id === paneId);
    if (found) return found;
    await Bun.sleep(250);
  }
  fail(`Herdr did not detect Pi in pane ${paneId} within ${timeoutMs / 1000}s`);
}

async function gitRoot(): Promise<string> {
  const requested = process.env.REPO_SEED ? resolve(process.env.REPO_SEED) : process.cwd();
  const result = await capture(["git", "-C", requested, "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) fail(`${requested} is not a Git repository`);
  const commit = await capture(["git", "-C", result.stdout, "rev-parse", "--verify", "HEAD"]);
  if (commit.code !== 0) fail("the seed repository must have at least one commit");
  return result.stdout;
}

async function loadContext() {
  const root = await gitRoot();
  let config: Config = {};
  const configPath = join(root, ".spike.json");
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(await readFile(configPath, "utf8")) as Config;
    } catch (error) {
      fail(`cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const project = slug(process.env.SPIKE_PROJECT ?? root.split("/").at(-1) ?? "project");
  const stateDir = join(root, ".pi-swarm");
  return { root, project, stateDir, config };
}

async function runtimeFor(config: Config): Promise<Runtime> {
  const requested = process.env.SPIKE_RUNTIME ?? process.env.PI_CONTAINER_RUNTIME ?? config.runtime ?? "auto";
  if (!['auto', 'apple', 'docker'].includes(requested)) fail("SPIKE_RUNTIME must be auto, apple, or docker", 2);
  if (requested === "apple" || requested === "auto") {
    const status = await capture(["container", "system", "status"]);
    if (status.code === 0) return "apple";
    if (requested === "apple") fail(`Apple container is unavailable${status.stderr ? `: ${status.stderr}` : ""}`);
  }
  if (requested === "docker" || requested === "auto") {
    const status = await capture(["docker", "info"]);
    if (status.code === 0) return "docker";
    if (requested === "docker") fail(`Docker is unavailable${status.stderr ? `: ${status.stderr}` : ""}`);
  }
  fail("neither Apple container nor Docker is installed and running");
}

function imageFor(config: Config): string {
  return process.env.SPIKE_IMAGE ?? process.env.PI_AGENT_IMAGE ?? config.image ?? "pi-agent:0.1";
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function usePortless(config: Config): Promise<boolean> {
  const installed = await available("portless");
  return envBool(process.env.SPIKE_PORTLESS, config.portless ?? installed) && installed;
}

async function portlessTld(): Promise<string> {
  if (process.env.SPIKE_PORTLESS_TLD) return process.env.SPIKE_PORTLESS_TLD.replace(/^\./, "");
  const home = process.env.HOME;
  if (home) {
    try {
      const configured = (await readFile(join(home, ".portless", "proxy.tld"), "utf8")).trim();
      if (configured) return configured.replace(/^\./, "");
    } catch {
      // Portless defaults to .localhost before it has persisted proxy state.
    }
  }
  return "localhost";
}

function runtimeCommand(runtime: Runtime): string {
  return runtime === "apple" ? "container" : "docker";
}

async function ensureResource(runtime: Runtime, kind: "volume" | "network", name: string) {
  const cli = runtimeCommand(runtime);
  const inspect = await capture([cli, kind, "inspect", name]);
  if (inspect.code === 0) return;
  const created = await capture([cli, kind, "create", name]);
  if (created.code !== 0) fail(`could not create ${kind} ${name}: ${created.stderr}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate a host port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

function statePath(stateDir: string, name: string): string {
  return join(stateDir, "agents", `${slug(name)}.json`);
}

async function readState(stateDir: string, name: string): Promise<AgentState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(stateDir, name), "utf8")) as AgentState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeState(stateDir: string, state: AgentState) {
  const path = statePath(stateDir, state.slug);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function removeAlias(alias?: string) {
  if (alias && await available("portless")) await capture(["portless", "alias", "--remove", alias]);
}

async function initProject() {
  const { root } = await loadContext();
  const configPath = join(root, ".spike.json");
  if (!existsSync(configPath)) {
    await writeFile(configPath, `${JSON.stringify({ runtime: "auto", image: "pi-agent:0.1", containerPort: 3000, portless: true }, null, 2)}\n`);
    console.log(`Created ${configPath}`);
  } else {
    console.log(`${configPath} already exists`);
  }
  const ignorePath = join(root, ".gitignore");
  const ignore = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  if (!ignore.split(/\r?\n/).includes(".pi-swarm/")) {
    await writeFile(ignorePath, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.pi-swarm/\n`);
    console.log(`Updated ${ignorePath}`);
  }
}

async function doctor() {
  const context = await loadContext();
  let failed = false;
  const report = (ok: boolean, label: string, detail: string) => {
    console.log(`${ok ? "✓" : "✗"} ${label}: ${detail}`);
    failed ||= !ok;
  };
  report(true, "repository", context.root);
  report(await available("bun"), "Bun", Bun.version);
  const apple = await capture(["container", "system", "status"]);
  const docker = await capture(["docker", "info"]);
  report(apple.code === 0 || docker.code === 0, "container runtime", apple.code === 0 ? "Apple container" : docker.code === 0 ? "Docker" : "not running");
  const portless = await capture(["portless", "--version"]);
  console.log(`${portless.code === 0 ? "✓" : "-"} Portless: ${portless.code === 0 ? portless.stdout : "optional; not installed"}`);
  const herdr = await capture(["herdr", "--version"]);
  if (herdr.code === 0) {
    const server = await capture(["herdr", "status", "server"]);
    const integration = await capture(["herdr", "integration", "status"]);
    const piIntegration = integration.stdout.split("\n").find((line) => line.startsWith("pi:")) ?? "Pi integration unknown";
    console.log(`✓ Herdr: ${herdr.stdout}; ${server.stdout.includes("status: running") ? "server running" : "server stopped"}`);
    console.log(`${piIntegration.includes("current") ? "✓" : "-"} Herdr Pi integration: ${piIntegration}`);
  } else {
    console.log("- Herdr: optional; not installed");
  }
  process.exitCode = failed ? 1 : 0;
}

async function build() {
  const { config } = await loadContext();
  const runtime = await runtimeFor(config);
  const archName = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : fail(`unsupported architecture: ${process.arch}`);
  const cli = runtimeCommand(runtime);
  const command = runtime === "apple"
    ? [cli, "build", "--tag", imageFor(config), "--build-arg", `TARGETARCH=${archName}`, setupRoot]
    : [cli, "build", "--tag", imageFor(config), "--build-arg", `TARGETARCH=${archName}`, setupRoot];
  const code = await inherit(command);
  if (code !== 0) process.exit(code);
}

async function herdrCommand(action: string | undefined) {
  if (action === "setup") {
    if (!await available("herdr")) fail("install Herdr first with: brew install herdr");
    const integration = await inherit(["herdr", "integration", "install", "pi"]);
    if (integration !== 0) fail("could not install the Herdr Pi integration");
    let status = await capture(["herdr", "status", "server"]);
    if (!status.stdout.includes("status: running")) {
      if (process.platform === "darwin" && await available("brew")) {
        const started = await inherit(["brew", "services", "start", "herdr"]);
        if (started !== 0) fail("could not start the Herdr service");
        await Bun.sleep(1_000);
        status = await capture(["herdr", "status", "server"]);
      }
    }
    if (!status.stdout.includes("status: running")) fail("Herdr is installed but its server is stopped; start it with: herdr server");
    console.log("✓ Herdr server and Pi integration are ready");
    return;
  }
  if (action === "status") {
    if (!await available("herdr")) fail("Herdr is not installed");
    await inherit(["herdr", "status"]);
    await inherit(["herdr", "integration", "status"]);
    return;
  }
  if (action === "attach") {
    await requireHerdr();
    const code = await inherit(["herdr"]);
    if (code !== 0) process.exit(code);
    return;
  }
  fail("expected herdr setup, status, or attach", 2);
}

async function supervisor(args: string[]) {
  const context = await loadContext();
  if (!await available("pi")) fail("Pi is not installed on the host");
  const extension = join(setupRoot, "extensions", "spike-supervisor.ts");
  const systemPrompt = [
    "You are the Spike supervisor for this repository.",
    "Delegate independent implementation, investigation, testing, and review tasks to isolated workers with spike_agents.",
    "Give each worker a focused task and a unique stable name. Workers have persistent clones and should commit completed work.",
    "Continue coordinating while workers run; their completion reports will arrive asynchronously.",
    "Do not ask workers to access host secrets or modify the host checkout directly.",
  ].join(" ");
  const useHerdr = args.includes("--herdr");
  const piArgs = args.filter((arg) => arg !== "--herdr");
  if (!useHerdr || process.env.HERDR_ENV === "1") {
    const code = await inherit(["pi", "-e", extension, "--append-system-prompt", systemPrompt, ...piArgs]);
    if (code !== 0) process.exit(code);
    return;
  }

  await requireHerdr();
  const name = herdrAgentName(`${context.project}-supervisor`);
  const existing = await capture(["herdr", "agent", "get", name]);
  if (existing.code === 0) {
    const code = await inherit(["herdr", "agent", "attach", name]);
    if (code !== 0) process.exit(code);
    return;
  }

  const placement = await createHerdrPane(context.root, context.project, "supervisor");
  const command = [
    "env", "HERDR_AGENT=pi",
    shellQuote(fileURLToPath(new URL("../bin/spike", import.meta.url))),
    "supervisor",
    ...piArgs.map(shellQuote),
  ].join(" ");
  const launched = await capture(["herdr", "pane", "run", placement.paneId, command]);
  if (launched.code !== 0) fail(`Herdr could not launch the supervisor: ${launched.stderr || launched.stdout}`);
  await waitForHerdrAgent(placement.paneId);
  await herdrJson(["agent", "rename", placement.paneId, name]);
  const code = await inherit(["herdr", "agent", "attach", name]);
  if (code !== 0) process.exit(code);
}

async function up() {
  const { config } = await loadContext();
  const requested = process.env.SPIKE_RUNTIME ?? process.env.PI_CONTAINER_RUNTIME ?? config.runtime ?? "auto";
  if ((requested === "auto" || requested === "apple") && await available("container")) {
    const status = await capture(["container", "system", "status"]);
    if (status.code !== 0) {
      console.log("Starting Apple container...");
      const code = await inherit(["container", "system", "start"]);
      if (code !== 0 && requested === "apple") fail("Apple container failed to start");
    }
  }
  const runtime = await runtimeFor(config);
  console.log(`✓ ${runtime === "apple" ? "Apple container" : "Docker"} is running`);
  if (await usePortless(config)) {
    const code = await inherit(["portless", "proxy", "start"]);
    if (code !== 0) fail("Portless proxy failed to start");
    console.log(`✓ Portless URL suffix: .${await portlessTld()}`);
  } else {
    console.log("- Portless disabled or not installed");
  }
  if (await available("herdr")) {
    const status = await capture(["herdr", "status", "server"]);
    console.log(`${status.stdout.includes("status: running") ? "✓" : "-"} Herdr server: ${status.stdout.includes("status: running") ? "running" : "stopped (start with brew services start herdr)"}`);
  }
}

async function runAgent(name: string | undefined, args: string[]) {
  if (!name) fail("agent run requires a name", 2);
  const context = await loadContext();
  const runtime = await runtimeFor(context.config);
  const agent = slug(name);
  const prefix = `spike-${context.project}-${agent}`;
  const container = prefix;
  const workspaceVolume = `${prefix}-workspace`;
  const network = prefix;
  // Apple container cannot attach one writable block volume to multiple VMs.
  // Use a narrowly scoped host directory for concurrent worker state.
  const sharedState = join(context.stateDir, "shared-pi-state");
  const existing = await readState(context.stateDir, agent);
  if (existing && !existing.finishedAt) fail(`agent ${agent} is already running`);
  const output = join(context.stateDir, "output");
  await mkdir(output, { recursive: true });
  await mkdir(sharedState, { recursive: true });

  await ensureResource(runtime, "volume", workspaceVolume);
  await ensureResource(runtime, "network", network);

  const portless = await usePortless(context.config);
  const configuredPort = process.env.SPIKE_HOST_PORT ?? process.env.PI_PORT;
  const hostPort = configuredPort ? Number(configuredPort) : portless ? await freePort() : undefined;
  if (hostPort !== undefined && (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)) fail("host port must be between 1 and 65535", 2);
  const containerPort = Number(process.env.SPIKE_CONTAINER_PORT ?? process.env.CONTAINER_PORT ?? context.config.containerPort ?? 3000);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) fail("container port must be between 1 and 65535", 2);
  const alias = portless ? `${agent}.${context.project}` : undefined;
  const operatorUrl = alias ? `https://${alias}.${await portlessTld()}` : hostPort ? `http://localhost:${hostPort}` : undefined;

  if (alias && hostPort) {
    const result = await capture(["portless", "alias", alias, String(hostPort), "--force"]);
    if (result.code !== 0) fail(`could not register Portless alias: ${result.stderr}`);
  }

  const command = args[0] === "--" ? args.slice(1) : ["pi", ...args];
  if (command.length === 0) fail("expected a command after --", 2);
  if (command[0] === "pi" && operatorUrl) {
    command.splice(1, 0, "--append-system-prompt", [
      `Service networking: use http://127.0.0.1:${containerPort} from inside this container.`,
      `The operator-facing route is ${operatorUrl}.`,
      "When you start or verify a service, report the operator-facing route rather than only the container-local URL.",
      "Do not claim the operator route is serving unless your internal service check succeeds.",
    ].join(" "));
  }
  const cli = runtimeCommand(runtime);
  const run = [cli, "run"];
  if (runtime === "apple") run.push("--user", "root");
  const hostPiState = process.env.SPIKE_HOST_PI_STATE ?? join(process.env.HOME ?? "", ".pi", "agent");
  run.push(
    "--rm", "--name", container, "--network", network,
    "--cpus", String(process.env.AGENT_CPUS ?? context.config.cpus ?? 2),
    "--memory", process.env.AGENT_MEMORY ?? context.config.memory ?? "4g",
    "--shm-size", process.env.AGENT_SHM_SIZE ?? context.config.shmSize ?? "1g",
    "--label", `dev.spike.project=${context.project}`,
    "--label", `dev.spike.agent=${agent}`,
    "--mount", `type=bind,source=${context.root},target=/seed,readonly`,
    "--mount", `type=volume,source=${workspaceVolume},target=/workspace`,
    "--mount", `type=bind,source=${output},target=/output`,
    "--mount", `type=bind,source=${sharedState},target=/home/node/.pi/agent`,
  );
  // Apple container only supports directory bind sources. Mount the narrowly
  // scoped host Pi directory at a neutral path, then the entrypoint links only
  // auth.json into the worker state. OAuth refreshes stay consistent without
  // exposing the rest of the host home as worker configuration.
  if (hostPiState && existsSync(join(hostPiState, "auth.json"))) {
    run.push(
      "--mount", `type=bind,source=${hostPiState},target=/host-pi-agent`,
      "--env", "HOST_PI_AUTH_FILE=/host-pi-agent/auth.json",
    );
    if (existsSync(join(hostPiState, "extensions", "herdr-agent-state.ts"))) {
      run.push("--env", "HOST_HERDR_PI_EXTENSION=/host-pi-agent/extensions/herdr-agent-state.ts");
    }
  }
  run.push(
    "--env", `AGENT_NAME=${agent}`,
    "--env", `AGENT_BRANCH=${process.env.AGENT_BRANCH ?? `agent/${agent}`}`,
    "--env", `AGENT_BASE_REF=${process.env.AGENT_BASE_REF ?? "HEAD"}`,
    "--env", `INTERNAL_URL=http://127.0.0.1:${containerPort}`,
  );
  if (operatorUrl) run.push("--env", `OPERATOR_URL=${operatorUrl}`);
  if (process.env.REPOSITORY_URL) run.push("--env", `REPOSITORY_URL=${process.env.REPOSITORY_URL}`);
  for (const key of ["GIT_USER_NAME", "GIT_USER_EMAIL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    if (process.env[key]) run.push("--env", `${key}=${process.env[key]}`);
  }
  if (hostPort) run.push("--publish", `${hostPort}:${containerPort}`);
  if (runtime === "docker") run.push("--pids-limit", String(process.env.AGENT_PIDS ?? context.config.pids ?? 512));
  if (process.stdin.isTTY) run.push("--interactive");
  if (process.stdin.isTTY && process.stdout.isTTY) run.push("--tty");
  run.push(imageFor(context.config), ...command);

  const state: AgentState = {
    name, slug: agent, project: context.project, runtime, container, workspaceVolume, network,
    ...(alias ? { alias } : {}), ...(hostPort ? { hostPort } : {}), containerPort,
    ...(operatorUrl ? { operatorUrl } : {}),
    ...(process.env.SPIKE_TASK ? { task: process.env.SPIKE_TASK } : {}),
    ...(process.env.SPIKE_OWNER ? { owner: process.env.SPIKE_OWNER } : {}),
    ...(process.env.SPIKE_LOG_PATH ? { log: process.env.SPIKE_LOG_PATH } : {}),
    ...(process.env.SPIKE_ERROR_LOG_PATH ? { errorLog: process.env.SPIKE_ERROR_LOG_PATH } : {}),
    ...(process.env.SPIKE_BACKEND === "herdr" ? { backend: "herdr" as const } : { backend: "headless" as const }),
    ...(process.env.SPIKE_HERDR_NAME ? { herdrName: process.env.SPIKE_HERDR_NAME } : {}),
    ...(process.env.SPIKE_HERDR_WORKSPACE_ID ? { herdrWorkspaceId: process.env.SPIKE_HERDR_WORKSPACE_ID } : {}),
    ...(process.env.SPIKE_HERDR_TAB_ID ? { herdrTabId: process.env.SPIKE_HERDR_TAB_ID } : {}),
    ...(process.env.SPIKE_HERDR_PANE_ID ? { herdrPaneId: process.env.SPIKE_HERDR_PANE_ID } : {}),
    startedAt: new Date().toISOString(), pid: process.pid,
  };
  await writeState(context.stateDir, state);
  console.log(`Starting ${agent} with ${runtime}`);
  if (operatorUrl) console.log(`Operator URL: ${operatorUrl}`);
  console.log(`Internal URL: http://127.0.0.1:${containerPort}`);

  let exitCode = 1;
  try {
    exitCode = await inherit(run);
  } finally {
    await removeAlias(alias);
    await writeState(context.stateDir, { ...state, finishedAt: new Date().toISOString(), exitCode });
  }
  if (exitCode !== 0) process.exit(exitCode);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function dispatchAgent(name: string | undefined, args: string[]) {
  if (!name) fail("agent dispatch requires a name", 2);
  const task = flagValue(args, "--task");
  if (!task) fail("agent dispatch requires --task <task>", 2);
  const model = flagValue(args, "--model");
  const thinking = flagValue(args, "--thinking");
  const owner = flagValue(args, "--owner");
  const { stateDir } = await loadContext();
  const agent = slug(name);
  const previous = await readState(stateDir, agent);
  if (previous && !previous.finishedAt) fail(`agent ${agent} is already running`);
  await rm(statePath(stateDir, agent), { force: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(stateDir, "logs");
  await mkdir(logDir, { recursive: true });
  const log = join(logDir, `${agent}-${stamp}.jsonl`);
  const errorLog = join(logDir, `${agent}-${stamp}.stderr.log`);
  const stdout = openSync(log, "a", 0o600);
  const stderr = openSync(errorLog, "a", 0o600);
  const workerArgs = [process.argv[1], "agent", "run", agent, "--", "pi", "--mode", "json", "-p", "--name", `spike/${agent}`];
  if (model) workerArgs.push("--model", model);
  if (thinking) workerArgs.push("--thinking", thinking);
  workerArgs.push(task);
  const child = spawn(process.execPath, workerArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env: {
      ...process.env,
      SPIKE_TASK: task,
      SPIKE_LOG_PATH: log,
      SPIKE_ERROR_LOG_PATH: errorLog,
      ...(owner ? { SPIKE_OWNER: owner } : {}),
    },
  });
  closeSync(stdout);
  closeSync(stderr);
  child.unref();
  console.log(JSON.stringify({ agent, pid: child.pid, task, log, errorLog }));
}

async function persistentAgent(name: string | undefined, args: string[]) {
  if (!name) fail("agent persistent requires a name", 2);
  const task = flagValue(args, "--task");
  if (!task) fail("agent persistent requires --task <task>", 2);
  const model = flagValue(args, "--model");
  const thinking = flagValue(args, "--thinking");
  const owner = flagValue(args, "--owner");
  const context = await loadContext();
  const agent = slug(name);
  const previous = await readState(context.stateDir, agent);
  if (previous && !previous.finishedAt) fail(`agent ${agent} is already running`);
  await rm(statePath(context.stateDir, agent), { force: true });

  const herdrName = herdrAgentName(`${context.project}-${agent}`);
  const placement = await createHerdrPane(context.root, context.project, agent);
  const piArgs: string[] = [];
  if (model) piArgs.push("--model", model);
  if (thinking) piArgs.push("--thinking", thinking);
  piArgs.push(task);
  const environment: Record<string, string> = {
    HERDR_AGENT: "pi",
    SPIKE_BACKEND: "herdr",
    SPIKE_TASK: task,
    SPIKE_HERDR_NAME: herdrName,
    SPIKE_HERDR_WORKSPACE_ID: placement.workspaceId,
    SPIKE_HERDR_TAB_ID: placement.tabId,
    SPIKE_HERDR_PANE_ID: placement.paneId,
    ...(owner ? { SPIKE_OWNER: owner } : {}),
  };
  const assignments = Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = ["env", ...assignments, shellQuote(fileURLToPath(new URL("../bin/spike", import.meta.url))), "agent", "run", shellQuote(agent), ...piArgs.map(shellQuote)].join(" ");
  const launched = await capture(["herdr", "pane", "run", placement.paneId, command]);
  if (launched.code !== 0) fail(`Herdr could not launch ${agent}: ${launched.stderr || launched.stdout}`);
  await waitForHerdrAgent(placement.paneId);
  await herdrJson(["agent", "rename", placement.paneId, herdrName]);

  // Let the foreground launcher persist its complete runtime state.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !await readState(context.stateDir, agent)) await Bun.sleep(100);
  console.log(JSON.stringify({ agent, backend: "herdr", herdrName, ...placement, operatorUrl: (await readState(context.stateDir, agent))?.operatorUrl }));
}

async function herdrTarget(name: string | undefined): Promise<{ state: AgentState; target: string }> {
  if (!name) fail("agent name is required", 2);
  const { stateDir } = await loadContext();
  const state = await readState(stateDir, name);
  if (!state) fail(`unknown agent: ${name}`);
  if (state.backend !== "herdr" || (!state.herdrName && !state.herdrPaneId)) fail(`agent ${name} is not Herdr-backed`);
  return { state, target: state.herdrName ?? state.herdrPaneId! };
}

async function sendAgent(name: string | undefined, args: string[]) {
  const task = flagValue(args, "--task");
  if (!task) fail("agent send requires --task <follow-up>", 2);
  const { target } = await herdrTarget(name);
  const result = await capture(["herdr", "agent", "prompt", target, task]);
  if (result.code !== 0) fail(result.stderr || result.stdout);
  console.log(result.stdout);
}

async function readAgent(name: string | undefined) {
  const { target } = await herdrTarget(name);
  const code = await inherit(["herdr", "agent", "read", target, "--source", "recent-unwrapped", "--lines", "160"]);
  if (code !== 0) process.exit(code);
}

async function attachAgent(name: string | undefined) {
  const { target } = await herdrTarget(name);
  const code = await inherit(["herdr", "agent", "attach", target]);
  if (code !== 0) process.exit(code);
}

async function listAgents() {
  const { stateDir } = await loadContext();
  const directory = join(stateDir, "agents");
  if (!existsSync(directory)) {
    console.log("No agents have been started.");
    return;
  }
  const glob = new Bun.Glob("*.json");
  const states: AgentState[] = [];
  for await (const file of glob.scan({ cwd: directory })) {
    try { states.push(JSON.parse(await readFile(join(directory, file), "utf8")) as AgentState); } catch { /* ignore corrupt state */ }
  }
  if (!states.length) return console.log("No agents have been started.");
  let herdrAgents: any[] = [];
  if (states.some((state) => state.backend === "herdr" && !state.finishedAt) && await available("herdr")) {
    const listed = await capture(["herdr", "agent", "list"]);
    if (listed.code === 0) {
      try { herdrAgents = JSON.parse(listed.stdout)?.result?.agents ?? []; } catch { /* server may be restarting */ }
    }
  }
  console.log("AGENT\tSTATUS\tBACKEND\tRUNTIME\tURL");
  for (const state of states.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const herdrAgent = herdrAgents.find((candidate) => candidate.name === state.herdrName || candidate.pane_id === state.herdrPaneId);
    const status = state.finishedAt ? `exited (${state.exitCode})` : herdrAgent?.agent_status ?? "running";
    console.log(`${state.slug}\t${status}\t${state.backend ?? "headless"}\t${state.runtime}\t${state.operatorUrl ?? "-"}`);
  }
}

async function stopAgent(name: string | undefined) {
  if (!name) fail("agent stop requires a name", 2);
  const { stateDir } = await loadContext();
  const state = await readState(stateDir, name);
  if (!state) fail(`unknown agent: ${name}`);
  const result = await capture([runtimeCommand(state.runtime), "stop", state.container]);
  if (result.code !== 0 && !state.finishedAt) fail(`could not stop ${state.slug}: ${result.stderr}`);
  await removeAlias(state.alias);
  console.log(`Stopped ${state.slug}`);
}

async function removeAgent(name: string | undefined, force: boolean) {
  if (!name) fail("agent remove requires a name", 2);
  if (!force) fail("agent remove deletes its persistent clone; repeat with --force", 2);
  const { stateDir } = await loadContext();
  const state = await readState(stateDir, name);
  if (!state) fail(`unknown agent: ${name}`);
  await capture([runtimeCommand(state.runtime), "stop", state.container]);
  await removeAlias(state.alias);
  for (const [kind, resource] of [["volume", state.workspaceVolume], ["network", state.network]] as const) {
    const result = await capture([runtimeCommand(state.runtime), kind, "rm", resource]);
    if (result.code !== 0 && !result.stderr.toLowerCase().includes("not found")) console.warn(`warning: ${result.stderr}`);
  }
  if (state.herdrTabId && await available("herdr")) await capture(["herdr", "tab", "close", state.herdrTabId]);
  await rm(statePath(stateDir, state.slug), { force: true });
  console.log(`Removed ${state.slug}`);
}

async function openAgent(name: string | undefined) {
  if (!name) fail("agent open requires a name", 2);
  const { stateDir } = await loadContext();
  const state = await readState(stateDir, name);
  if (!state?.operatorUrl) fail(`agent ${name} has no operator URL`);
  if (state.finishedAt) fail(`agent ${name} is no longer running`);
  const operatorUrl = state.alias ? `https://${state.alias}.${await portlessTld()}` : state.operatorUrl;
  if (operatorUrl !== state.operatorUrl) await writeState(stateDir, { ...state, operatorUrl });
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await capture([opener, operatorUrl]);
  if (result.code !== 0) fail(`could not open ${operatorUrl}: ${result.stderr}`);
  console.log(operatorUrl);
}

async function down() {
  const { stateDir } = await loadContext();
  const directory = join(stateDir, "agents");
  if (!existsSync(directory)) return;
  const glob = new Bun.Glob("*.json");
  for await (const file of glob.scan({ cwd: directory })) {
    const state = JSON.parse(await readFile(join(directory, file), "utf8")) as AgentState;
    if (!state.finishedAt) await capture([runtimeCommand(state.runtime), "stop", state.container]);
    await removeAlias(state.alias);
  }
  console.log("Stopped project agents. Portless remains available for other projects.");
}

const args = process.argv.slice(2);
const command = args.shift();
if (!command || command === "help" || command === "-h" || command === "--help") console.log(help);
else if (command === "--version" || command === "version") console.log(VERSION);
else if (command === "init") await initProject();
else if (command === "doctor") await doctor();
else if (command === "up") await up();
else if (command === "build") await build();
else if (command === "supervisor" || command === "start") await supervisor(args);
else if (command === "herdr") await herdrCommand(args.shift());
else if (command === "down") await down();
else if (command === "agent") {
  const action = args.shift();
  if (action === "run" || action === "start") await runAgent(args.shift(), args);
  else if (action === "dispatch") await dispatchAgent(args.shift(), args);
  else if (action === "persistent" || action === "herdr") await persistentAgent(args.shift(), args);
  else if (action === "send") await sendAgent(args.shift(), args);
  else if (action === "read") await readAgent(args.shift());
  else if (action === "attach") await attachAgent(args.shift());
  else if (action === "list" || action === "ls") await listAgents();
  else if (action === "stop") await stopAgent(args.shift());
  else if (action === "remove" || action === "rm") {
    const name = args.find((arg) => !arg.startsWith("-"));
    await removeAgent(name, args.includes("--force"));
  } else if (action === "open") await openAgent(args.shift());
  else fail("expected agent run, dispatch, persistent, send, read, attach, list, stop, remove, or open", 2);
} else fail(`unknown command: ${command}`, 2);
