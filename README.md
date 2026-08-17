# spike

`spike` runs isolated [Pi](https://github.com/badlogic/pi-mono) coding agents
against container-local Git clones. It supports Apple `container` and Docker
without Compose.

Each named agent gets its own persistent clone, branch, network, container, and
resource limits. Agents share settings, packages, and sessions through the
project's narrowly mounted `.pi-swarm/shared-pi-state/` directory. From the host
Pi agent directory, workers link only `auth.json` and Herdr's Pi integration
when present, keeping OAuth refreshes consistent without mounting the host home.

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

## Activate and recover an approved goal

Spike can preserve one operator-approved Markdown goal as durable project-local
state. Commit the exact goal document first, then activate it from anywhere in
that repository:

```bash
git add doc/goal.md
git commit -m "Approve implementation goal"
spike goal status                         # clearly reports that no goal is active
spike goal activate doc/goal.md \
  --approval "Approved by Casey for implementation"
```

Activation requires a tracked Markdown file whose index and working-tree form
are unchanged from `HEAD`. It rejects symlinks, files outside the repository,
untracked files, and a second active goal. Unrelated staged, unstaged, and
untracked host changes are allowed and are not modified. Repeating the exact
same file revision and approval statement is idempotent.

Inspect or recover the active goal in any later Spike process:

```bash
spike goal status
spike goal status --json
spike goal show
```

`status` reports the stable goal ID, approval, approved Git blob, repository
revision at approval, and current accepted code revision. `show` emits the
preserved bytes from the approved Git blob, not the source path's current
contents. Consequently both commands continue to work if the source file is
later edited. The schema-versioned record, snapshot, and atomic active pointer
live under the ignored `.pi-swarm/goals/` directory; malformed records, unknown
schemas, path escapes, pointer mismatches, and snapshot tampering are rejected.
Do not commit `.pi-swarm/`.

Approval is currently supplied **only and explicitly at the CLI boundary** with
`--approval`. Spike records that argument verbatim, but does not infer approval
from conversation, chat logs, terminal output, or a goal document. Before
planning a new goal, supervisors should run `spike goal status --json`; they
must not draft or activate a replacement while another goal is active, and must
not treat conversational intent as operator approval.

## Issue and recover the ready planner ticket

With an active goal, the current manual planner flow is:

```bash
spike goal status --json
# Write an ignored local Markdown ticket, for example .pi-swarm/drafts/ticket.md
spike ticket issue .pi-swarm/drafts/ticket.md
spike ticket status --json
spike ticket show
```

`ticket issue` accepts one non-empty, bounded Markdown file inside the
repository, including ignored files under `.pi-swarm/`. It binds the exact bytes
to the active goal and that goal's `acceptedCodeRevision`; callers cannot supply
a different base. Reissuing the same bytes is idempotent, while a different
ready ticket is refused. Issuing a ticket **does not dispatch or start a
worker**.

The immutable snapshot and schema-versioned record are stored under the active
generated goal directory. A validated, read-only-by-convention worker copy is
exported at
`.pi-swarm/output/workflow/<goal-id>/tickets/<ticket-id>/ticket.md`; workers and
operators must not edit it. `status` and `show` recover solely from durable
state, so they continue to work after the
source is edited or removed. `show` always emits the authoritative snapshot,
not the source or exported copy. Corrupt pointers, records, paths, schemas,
snapshots, and worker copies fail closed.

Before drafting another ticket, supervisors must inspect
`spike ticket status --json` and `spike ticket show`. A ready ticket survives a
supervisor restart: never redispatch work merely because the supervisor process
restarted.

## Dispatch and recover the durable ticket run

Dispatch the one ready ticket to one persistent Herdr worker without copying the
ticket text into a command:

```bash
spike ticket status --json
spike run status --json       # reports clearly when no run exists
spike ticket dispatch ticket-004-worker \
  --model openai-codex/gpt-5.4 --thinking high
```

Spike briefs Pi with the existing worker-visible
`/output/workflow/<goal-id>/tickets/<ticket-id>/ticket.md` path. Before launch it
creates a distinct run ID, schema-versioned run record, and atomic active-run
pointer under the ticket directory. Durable dispatch starts the worker clone at
that ticket's exact accepted base revision, verifies the clone `HEAD` and
`spike.agentBase` before `pi` begins, and fails closed instead of falling back
to `HEAD`. The correlated agent record carries the goal, ticket, run, worker,
backend, and exact base identities. Requested model and thinking overrides are
provenance, not part of the ticket snapshot.

Recover the association from any later CLI process, even when Herdr or the
container is unavailable:

```bash
spike run status
spike run status --json
spike run history
spike run history --json
```

Status validates the active goal, ready ticket, pointer, record, identities,
paths, schema, and snapshot provenance before reporting launch/runtime IDs,
timestamps, stop intent, and observed process termination. Redispatch remains
refused once an active-run pointer exists. An active `launch_failed` run can be
retried only with an explicit acknowledgement of that exact run ID:

```bash
spike run retry ticket-004-worker \
  --acknowledge <launch-failed-run-id> \
  --model openai-codex/gpt-5.4 --thinking high
```

An active terminal `stopped` or `failed` run requires the same exact active run
ID acknowledgement **and** an operator-supplied, nonblank reason of at most
500 UTF-8 bytes. The reason is immutable provenance on the new retry attempt:

```bash
spike run retry ticket-004-worker \
  --acknowledge <stopped-or-failed-run-id> \
  --reason "Verified the terminal worker was recovered; retry after fixing the dependency" \
  --model openai-codex/gpt-5.4 --thinking high
```

Retry preserves every immutable prior attempt, creates a distinct new run ID,
and atomically advances the active-run pointer only through that explicit CLI
transition. Running, dispatching, and stopping runs, stale acknowledgements,
corrupt state, implicit redispatch, and concurrent transitions are refused.
Supervisor restarts or missing live runtime are never implicit reasons to
redispatch or infer a retry.

The supervisor tool exposes `spike_agents` action `dispatch_ticket`. It requires
checking both `spike ticket status --json` and `spike run status --json` first.
The existing `dispatch` action remains available only for free-form work not
represented by a durable ready ticket.

## Accept and inspect ticket history

After the worker run is terminal and its latest publication has been reviewed,
accept the exact published commit:

```bash
spike ticket accept --revision <commit> --review planner \
  --statement "Reviewed the published implementation"
spike ticket history
spike ticket history --json
spike goal status
```

Acceptance verifies ancestry, rejects nonterminal runs, and requires a
correlated worker's latest validated publication head. It writes an immutable
result before atomically advancing per-goal workflow state. An interrupted
transition is completed by a retry or normal state load. Repeating the exact
acceptance is idempotent; conflicting terminal results fail closed. Ticket
snapshots and issuance records are never rewritten.

Workflow state owns the accepted revision, active ticket, monotonic state
revision, transition time, and explicit issuance order. Existing pre-workflow
goal records are upgraded on normal load. Inspect state and local evidence with:

```bash
spike workflow doctor
spike workflow doctor --json
spike workflow migrate-bootstrap          # deterministic, read-only plan
spike workflow migrate-bootstrap --apply  # only after reviewing the plan
```

Bootstrap migration directly parses the supported Goal 001 `approval.md`,
ticket acceptance Markdown, generated ticket/run records, publication
manifests/refs/bundles, historical agent reconciliation, and matching stop
intent; it does not require an operator-authored migration manifest. It imports
only independently verifiable records and writes a versioned receipt before
legacy evidence is considered migrated. The current ready ticket is retained on
its accepted base. Unknown, missing, or conflicting evidence is retained and
reported rather than guessed.

Current workflow limitations remain intentional: Spike does not parse a
structured completion report, remediate/cancel a ticket, or associate detached
one-shot work with durable runs.

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

`spike agent stop` first atomically records `stopping` intent on the agent and,
for ticket workers, its matching run. The CLI reason defaults to
`operator-requested`; only then does Spike ask the runtime to send its stop
signal and remove the Portless alias. When the foreground runtime observes the
exit, it preserves the raw code and signal. A matching same-run stop followed by
SIGTERM/143 is semantically `stopped`, while 143 without matching intent (or
with stale intent from another run) is `failed`. Exit code 143 is never treated
as success by itself. `spike agent list`, run status, and asynchronous supervisor
notifications use that semantic outcome; a live persistent Pi session may still
show Herdr's `done` after completing a turn because it remains available.
Schema-less agent records created by earlier Spike versions are validated and
normalized on read (terminal records are migrated eagerly), so existing
one-shot and Herdr workers remain manageable; unknown schemas and malformed
legacy records still fail closed. While a stop is in flight, Spike also retains
a narrow schema-versioned record under `.pi-swarm/agents/stop-intents/`, scoped
to the worker's start identity and optional run. This lets the stop caller repair
a legacy launcher's terminal overwrite; the record is removed after terminal
reconciliation and cannot apply to a replacement process or run.

`stop` releases active execution while preserving the worker's persistent clone,
network identity, shared Pi state, publications, artifacts, and durable
workflow records for follow-up work.

`remove --force` is a terminal-only finalization step. Stop the worker first,
wait for `spike agent list` to show a terminal state (`stopped`, `failed`, or
`completed`), then run `spike agent remove <name> --force`. Finalization
atomically retains a validated retirement record under
`.pi-swarm/finalized-agents/`, then releases the worker container (if still
present), workspace volume, dedicated network, Portless alias, and Herdr tab.
Accepted ticket/run/result history, publication manifests and bundles, imported
refs, exported artifacts, and `.pi-swarm/shared-pi-state/` remain in place.
Retries are safe: already-absent resources count as released, while any failed
cleanup leaves the active record in place so the command can be rerun without
losing provenance.

After finalization the retired worker no longer appears in `spike agent list`,
and its name can be reused for a later run without overwriting the preserved
historical evidence.

`spike down` stops this project's active agents and removes their aliases, but
deliberately leaves the global Portless proxy running for other projects.

State and exported work live under `.pi-swarm/`.

## Publish and review worker changes

After a persistent worker has committed its intended changes and completed its
verification, publish its current branch into a namespaced host ref:

```bash
spike agent publish frontend
spike agent diff frontend -- --stat
spike agent diff frontend -- src/
spike agent review frontend
```

Publication inspects the live worker through its recorded runtime and container,
rejects detached, dirty, empty, stopped, or non-Herdr workers, creates and
host-verifies an immutable bundle, and imports it as
`refs/spike/agents/frontend`. It does not check out, merge, reset, rebase, stage,
or otherwise change the host branch, index, or working tree. A dirty host
checkout is supported.

The manifest and bundle are retained under
`.pi-swarm/output/branches/frontend/`; `latest.json` is the durable pointer used
by `diff` and `review`. Re-publishing the same head is idempotent, while a
non-fast-forward move of the imported ref is refused. `diff` continues to work
after the worker stops. Hunk is an optional operator tool; install it with
`brew install hunk` or `npm install -g hunkdiff`.

Publication deliberately does **not** merge work. Inspect the reported ref and
leave integration to the planner or operator at a later, explicit step.

### Emergency bundle recovery

The automated command is the primary return path. If publication itself is
broken, the old manual bundle flow remains only as a troubleshooting/bootstrap
escape hatch. Resolve the container from recorded state, then use an entirely
new recovery ref:

```bash
state=.pi-swarm/agents/frontend.json
container_name=$(jq -r .container "$state")
case $(jq -r .runtime "$state") in
  apple) runtime_cli=container ;;
  docker) runtime_cli=docker ;;
  *) echo "invalid recorded runtime" >&2; exit 1 ;;
esac
worker_branch=$($runtime_cli exec --user node "$container_name" \
  git -C /workspace/project symbolic-ref --short HEAD)
$runtime_cli exec --user node "$container_name" git -C /workspace/project bundle create \
  /output/frontend-recovery.bundle "refs/heads/$worker_branch"
git bundle verify .pi-swarm/output/frontend-recovery.bundle
git fetch --no-write-fetch-head .pi-swarm/output/frontend-recovery.bundle \
  "refs/heads/$worker_branch:refs/spike/recovery/frontend"
```

Never force an existing ref, and do not merge as part of recovery. Preserve the
failed bundle and agent state when reporting the defect.

### Real-runtime publication smoke test

Use a disposable repository and a real Herdr-backed worker. Set `SPIKE_BIN` to
this checkout's `bin/spike`, choose a running Apple Container or Docker runtime,
and keep Herdr running:

```bash
export SPIKE_BIN=/path/to/spike/bin/spike
export SPIKE_RUNTIME=apple                 # or docker
smoke_repo=$(mktemp -d)/publish-smoke
mkdir -p "$smoke_repo" && cd "$smoke_repo"
git init -b main
git config user.name "Spike Smoke"
git config user.email "spike-smoke@example.test"
printf 'seed\n' > seed.txt
git add seed.txt && git commit -m seed
"$SPIKE_BIN" init

"$SPIKE_BIN" agent persistent publish-smoke --task \
  'Create worker.txt containing "published", commit it, run git status --short, and report when clean.'
"$SPIKE_BIN" agent read publish-smoke       # repeat until Pi reports completion

# Deliberately leave both staged and unstaged host changes, then snapshot them.
printf 'staged\n' > host-only.txt
git add host-only.txt
printf 'unstaged\n' >> host-only.txt
git status --porcelain=v2 -z > /tmp/spike-smoke-status.before
cp .git/index /tmp/spike-smoke-index.before
host_head=$(git rev-parse HEAD)
host_branch=$(git symbolic-ref HEAD)

"$SPIKE_BIN" agent publish publish-smoke
"$SPIKE_BIN" agent publish publish-smoke    # idempotency check
cmp /tmp/spike-smoke-status.before <(git status --porcelain=v2 -z)
cmp /tmp/spike-smoke-index.before .git/index
test "$host_head" = "$(git rev-parse HEAD)"
test "$host_branch" = "$(git symbolic-ref HEAD)"
manifest=.pi-swarm/output/branches/publish-smoke/latest.json
git bundle verify "$(jq -r .bundlePath "$manifest")"
test "$(git rev-parse refs/spike/agents/publish-smoke)" = "$(jq -r .head "$manifest")"
"$SPIKE_BIN" agent diff publish-smoke -- --stat
"$SPIKE_BIN" agent review publish-smoke    # inspect the range, then quit Hunk
"$SPIKE_BIN" agent stop publish-smoke
"$SPIKE_BIN" agent diff publish-smoke -- --stat
```

Remove the disposable directory and temporary snapshot files afterward. This
smoke test requires real Herdr, Hunk, and a running container runtime; automated
unit tests use temporary Git repositories and a fake runtime boundary instead.

## Authentication and browser testing

Workers use the host supervisor's `~/.pi/agent/auth.json` through a targeted
bind and keep other worker state in `.pi-swarm/shared-pi-state/`. The same bind
supplies `extensions/herdr-agent-state.ts` when installed; no other host Pi
files are linked into worker state. At startup, both Docker and Apple Container
repair stale machine-absolute links before dropping from the setup user to
unprivileged `node`. Missing optional files remove dangling managed links rather
than fabricating replacements. This shares Codex login and token refreshes
without exposing the rest of the host home. A bind directory is used for worker
state because Apple container cannot attach one writable block volume to
multiple VMs. Provider keys exported in the host environment are also forwarded
when present; `.env` files are not loaded automatically.

Inside an agent:

```bash
agent-browser open https://example.com
agent-browser snapshot
agent-browser close
```

Apple Chromium can briefly report `ERR_NETWORK_CHANGED` immediately after a new
VM starts. Retrying succeeds.

## Roadmap

Spike now supports one-shot and Herdr-backed persistent workers plus verified,
ref-only publication and exact-range review of persistent worker branches. Merge
and rebase automation remain intentionally out of scope. The next slices add
durable workflow state and richer worker-response extraction than terminal
snapshots. Container and Portless policy remain owned by Spike; Herdr owns
durable terminals and lifecycle presentation.
