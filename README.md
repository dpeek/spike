# spike

`spike` runs isolated [Pi](https://github.com/badlogic/pi-mono) coding agents
against container-local Git clones. It supports Apple `container` and Docker
without Compose.

Each named agent gets its own persistent clone, branch, network, container, and
resource limits. Agents share settings, packages, and sessions through the
project's narrowly mounted `.pi-swarm/shared-pi-state/` directory. Workers link
only Pi's `auth.json` from the host supervisor's Pi state, keeping OAuth refreshes
consistent without mounting the host home.

## What is included

- Pi 0.84.2, configured to install packages with Bun
- Bun 1.3.14 and Node.js 24.14.0
- agent-browser 0.34.0 and Debian Chromium
- Git, ripgrep, curl, jq, Python 3, tmux, and essential shell tools
- No npm, Corepack, compiler toolchain, sudo, Docker socket, or host home mount

Agent commands run as the unprivileged `node` user. Only the seed repository is
mounted from the host, read-only.

## Install the repo-local CLI

Bun is the only host JavaScript requirement:

```bash
bun link
spike --help
```

It can also be run without linking:

```bash
bin/spike --help
```

The old `scripts/pi-build` and `scripts/pi-agent` entrypoints are compatibility
wrappers around `spike`.

## Runtime setup

### Apple container

Install Apple container and configure its recommended kernel once:

```bash
container system start
container system kernel set --recommended
```

### Docker

Start Docker and select it in `.spike.json` or with:

```bash
export SPIKE_RUNTIME=docker
```

`auto` prefers a running Apple container and then Docker. Their images and
volumes are separate.

## Initialize and check a project

Run from the Git repository the agents should modify:

```bash
spike init
spike doctor
```

The repository must have at least one commit. Agents clone committed content;
uncommitted host changes are deliberately excluded.

`spike init` creates `.spike.json` and ensures `.pi-swarm/` is ignored. A full
example is available in `.spike.json.example`.

When invoking this development checkout against another repository, use:

```bash
REPO_SEED=/path/to/project /path/to/spike/bin/spike doctor
```

## Build and start services

```bash
spike build
spike up
```

`spike up` verifies the selected container runtime and starts Portless when it is
installed and enabled. Portless remains a host service and owns TLS and route
management; it is never installed in an agent.

Install Portless on macOS with:

```bash
brew install portless
```

## Start the supervisor

Run the host-side Pi supervisor from the target repository. The default backend
uses detached one-shot workers:

```bash
spike supervisor
```

For persistent interactive workers, install Herdr 0.8 or newer and its Pi
integration once, then keep its server running:

```bash
brew install herdr
spike herdr setup
spike supervisor --herdr
```

`spike herdr setup` installs Herdr's official Pi integration and starts the
Homebrew service when needed. `spike herdr status` shows server and integration
state, while `spike herdr attach` opens the full workspace UI.

The Herdr supervisor is placed in a project workspace and attached directly to
your terminal. Detach with `ctrl+b q`; its terminal and workers keep running.
Running `spike supervisor --herdr` again reattaches to the existing supervisor.

The supervisor loads the repo-local `spike_agents` extension tool. It can
dispatch focused tasks, send persistent workers follow-ups, read their terminals,
list or stop them, and open their service URLs. Working, blocked, idle, done, and
exit transitions are watched asynchronously and injected back into the
supervisor conversation.

Example request:

```text
Delegate the frontend implementation and test investigation to separate workers.
```

Each dispatch inherits the supervisor's model and thinking level unless it
specifies an override. `/spike-agents` lists workers from the TUI.

## Run agents manually

```bash
spike agent run frontend
spike agent run tests
spike agent run reviewer
```

Each agent receives:

- branch `agent/<name>`
- persistent volume `spike-<project>-<name>-workspace`
- isolated network and temporary container
- 2 CPUs, 4 GB memory, and 1 GB shared memory by default
- Docker PID limit of 512

Override resources with `.spike.json` or environment variables:

```bash
AGENT_CPUS=4 AGENT_MEMORY=8g spike agent run frontend
```

Clone a canonical remote instead of the local seed:

```bash
REPOSITORY_URL=https://github.com/org/project.git spike agent run reviewer
```

Do not run the same named agent twice concurrently because both processes would
write to the same clone.

### Dispatch a detached task

The non-Herdr supervisor uses this lower-level command internally:

```bash
spike agent dispatch tests --task "Run the tests and fix failures"
```

It starts Pi in JSON/print mode, returns immediately, and records output under
`.pi-swarm/logs/`. The persistent workspace remains available for later tasks.

### Persistent Herdr workers

The Herdr supervisor dispatches through `persistent` instead. These commands are
also available to operators:

```bash
spike agent persistent frontend --task "Build the UI and keep the preview running"
spike agent send frontend --task "Now add dark mode"
spike agent read frontend
spike agent attach frontend
```

Detach a direct worker attachment with `ctrl+b q`. Herdr sees Pi through the
host-visible `HERDR_AGENT=pi` wrapper and derives worker lifecycle from Pi's live
terminal. The host supervisor itself uses Herdr's official Pi lifecycle
integration. Portless aliases remain registered for the full persistent worker
lifetime.

### Run a command instead of Pi

```bash
spike agent run frontend -- git status
spike agent run frontend -- bun test
spike agent run frontend -- bash
```

Arguments without `--` are passed to Pi:

```bash
spike agent run reviewer --model openai-codex/gpt-5.4
```

## Stable preview URLs

When Portless is installed, `spike agent run` allocates a free host port,
publishes the configured container port, and registers an identity-based alias:

```text
https://<agent>.<project>.<portless-tld>
```

The normal suffix is `.localhost`. If the global Portless proxy is in LAN mode,
Spike detects its persisted `.local` suffix instead. For example:

```text
https://frontend.my-app.localhost
https://frontend.my-app.local
```

Override detection with `SPIKE_PORTLESS_TLD` if the proxy was started with a
custom TLD.

The container receives both URL forms:

```text
INTERNAL_URL=http://127.0.0.1:3000
OPERATOR_URL=https://frontend.my-app.<portless-tld>
```

A development server must listen on `0.0.0.0:3000`. Agents should use the
internal URL with Chromium; operators use the HTTPS URL. Open it with:

```bash
spike agent open frontend
```

The alias is removed when the foreground agent exits. Disable Portless or choose
ports explicitly with:

```bash
SPIKE_PORTLESS=0 spike agent run frontend
SPIKE_HOST_PORT=4101 spike agent run frontend
SPIKE_CONTAINER_PORT=8000 spike agent run docs
```

## Agent lifecycle

```bash
spike agent list
spike agent stop frontend
spike agent remove frontend --force
spike down
```

`remove --force` deletes that agent's persistent clone and network. It does not
delete `.pi-swarm/shared-pi-state/`. `spike down` stops this project's active agents and
removes their aliases, but deliberately leaves the global Portless proxy running
for other projects.

State and exported work live under `.pi-swarm/`.

## Return work to the host

Agents should commit their changes. Export a branch through the mounted output
directory:

```bash
spike agent run frontend -- \
  git bundle create /output/frontend.bundle agent/frontend

git fetch .pi-swarm/output/frontend.bundle agent/frontend:agent/frontend
git log agent/frontend
git merge agent/frontend
```

Review the branch before merging.

## Authentication and browser testing

Workers use the host supervisor's `~/.pi/agent/auth.json` through a targeted
bind and keep other worker state in `.pi-swarm/shared-pi-state/`. This shares
Codex login and token refreshes without exposing the rest of the host home. A
bind directory is used for worker state because Apple container cannot attach
one writable block volume to multiple VMs. Provider keys exported in the host
environment are also
forwarded when present; `.env` files are not loaded automatically.

Inside an agent:

```bash
agent-browser open https://example.com
agent-browser snapshot
agent-browser close
```

Apple Chromium can briefly report `ERR_NETWORK_CHANGED` immediately after a new
VM starts. Retrying succeeds.

## Roadmap

Spike now supports both one-shot and Herdr-backed persistent workers. The next
slice is automated branch review and import (`diff`, `bundle`, and guarded merge)
plus richer worker-response extraction than terminal snapshots. Container and
Portless policy remain owned by Spike; Herdr owns durable terminals and lifecycle
presentation.
