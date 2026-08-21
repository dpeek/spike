# Spike

Spike is a local, Git-native workflow for planning, implementing, reviewing, and landing agent-authored changes.

Version 2 is starting from a deliberately small foundation.

## Documentation

- [Workflow design](doc/workflow.md)
- [Phase 2 dogfood procedure and evidence](doc/dogfood.md)

## Development

Requires [Bun](https://bun.sh/).

```bash
bun run test
bun run check
bin/spike --help
```

Spike reads the stable Project slug and strict agent defaults from tracked `spike.json`:

```json
{
  "project": { "slug": "spike" },
  "agents": {
    "planner": { "model": "...", "thinking": "high" },
    "implement": { "model": "...", "thinking": "medium", "isolation": "container", "networkAccess": "unrestricted", "credentialGrants": ["openai-codex"] },
    "review": { "model": "...", "thinking": "high", "isolation": "container", "networkAccess": "unrestricted", "credentialGrants": ["openai-codex"] }
  }
}
```

The Project slug qualifies monotonic Project-local Goal sequences, producing IDs
such as `spike-001`. It is operator-chosen rather than inferred and cannot change
after Goal allocation. Ticket issuance freezes the selected model and thinking
level and execution policy into `ticket.md`; later dispatch never rereads configuration or accepts overrides. Planner agents have only model and thinking because planner policy is not enforceable.

Workflow guidance is tracked as Markdown at
`spike/guidance/{goal,plan,change,implement,review,remediate,decide,recover}.md`.
Planner guidance is selected from committed authority with `spike guidance show`;
Ticket issuance loads Implement, Review, or Remediate guidance from the Change
base and embeds it in the immutable Ticket. There is no built-in fallback.

The workflow can create an approved Goal and Plan, allocate a Change, and issue
its first implementation Ticket in any Git repository with a commit:

```bash
spike goal create \
  --title "Ship the workflow" \
  --outcome "Land reviewed Changes as one commit each" \
  --approval "Approved to proceed"

spike change create \
  --goal spike-001 \
  --title "Add allocation" \
  --intent "Allocate sequential Changes and Tickets" \
  --rationale "Durable work needs stable nested identity" \
  --acceptance "IDs are monotonic and never reused"

spike ticket issue \
  --goal spike-001 \
  --change 001 \
  --instruction "Implement the Change" \
  --context "Preserve the current filesystem contract" \
  --model "openai-codex/gpt-5.6-terra" \
  --thinking medium
```

## Request inbox

Requests are host-local, Git-independent unapproved intake. `spike request create`
uses `SPIKE_DATA_DIR`, then `${XDG_DATA_HOME}/spike`, then
`${HOME}/.local/share/spike`. It stores immutable Markdown under that root; no
Project checkout is required. A Request may have no `--project` flags (unassigned)
or several stable Project slugs.

```bash
spike request create --title "Consider faster checks" --statement "Measure the slow suite." --project spike
spike request list --project spike
spike request show --request request-001
spike request close --request request-001 --disposition declined --statement "Not needed now."
```

A Request title is its required first Markdown line, `# <title>`: it must be
nonblank, single-line, and at most 200 characters. `list` shows open Requests by
default; use `--closed` or `--unassigned` to filter. List JSON and Inbox views
return only Request metadata, this derived title, and state—not Request or closure
bodies—while `show`, `create`, and `close` retain complete individual documents.
Closures are immutable and use one of `addressed`, `declined`, or `withdrawn`.
Capturing or selecting a Request neither approves nor starts Project work. In the
Pi supervisor, use `spike_create_request`, `spike_list_requests`, and
`spike_show_request` to capture and inspect this intake; the Inbox is the
open-Request view. During explicitly approved Goal creation,
`spike_create_goal` can cite selected source Request IDs. Approval approves the
Goal's outcome and constraints only: an approved Goal may remain queued without
an active Change.

`--model`, `--thinking`, `--isolation`, `--network-access`, and repeated
`--credential` are optional one-Ticket overrides. Without them, a Ticket uses its
role's `implement` or `review` agent defaults from `spike.json`. Use
`--clear-credentials` to explicitly replace configured grants with an empty list,
for example when overriding a Ticket to workspace isolation. Omitted worker
isolation in configuration resolves to `container`; workspace dispatch is attended
by default, while container dispatch is direct by default.
Pi dispatch accepts no model, thinking, role, prompt, or extension overrides.
Attended dispatch defaults to one headed interactive Pi TUI in a named ephemeral
Herdr tab. It uses the immutable selection from `ticket.md`, automatically
submits the Ticket/context prompt, disables extension, skill, prompt-template,
and context-file discovery, explicitly loads only the role-specific completion
extension, and starts at the exact Ticket
input revision. Spike persists only opaque tab and pane handles as Herdr state;
status and terminal text remain observational. Dispatch returns after launch so
the planner can observe `working` or `blocked` workers. Exchange output remains
staging until a separate publication command:

```bash
spike ticket dispatch-pi \
  --goal <goal-id> --change 001 --ticket 001 \
  --worker pi-implementer

spike report publish \
  --goal <goal-id> --change 001 --ticket 001 \
  --commit-summary "Implement the Change"
```

Inspect or attach to the attended terminal by Ticket identity:

```bash
spike worker status --goal <goal-id> --change 001 --ticket 001 --json
spike worker wait --goal <goal-id> --change 001 --ticket 001 --json
spike worker read --goal <goal-id> --change 001 --ticket 001 --lines 120
spike worker attach --goal <goal-id> --change 001 --ticket 001
```

Herdr `working`, `blocked`, `done`, or unavailable status and terminal output
cannot complete the Ticket or publish a Report. `worker wait` emits one operational
notification only after the attended wrapper's execution marker exists. The
supervisor extension waits in the background and queues a full-identity recheck
message that wakes an idle planner. If an attended waiter fails unexpectedly, it
queues a distinct operational failure recheck instead of silently disabling wake-up.
The planner must call `spike_status` and then explicitly publish the Report; either
notification remains non-authoritative. Report
publication validates only the standard exchange and then closes the tab; stop
and cleanup can be retried.

Direct Pi launch is an explicit headless `--print --no-session` controlled-test fallback:

```bash
spike ticket dispatch-pi \
  --goal <goal-id> --change 001 --ticket 001 \
  --worker controlled-pi --host direct
```

Arbitrary commands remain available only as the explicit controlled-test fallback:

```bash
spike ticket dispatch-test \
  --goal <goal-id> --change 001 --ticket 001 \
  --worker scripted-implementer -- ./scripted-worker
```

Inside the private worker checkout, structured outcomes read the Ticket from
`SPIKE_INPUT_DIR/ticket.md` and accept JSON from a file or stdin:

```bash
spike worker complete --file payload.json
spike worker block --file blocked.json
```

Completed implementation payloads contain `summary`, `verification`,
`assumptions`, `limitations`, `risks`, `followUp`, and an `artifacts` path
array. Completed review payloads contain `reviewStatement`, `findings`,
`acceptanceAssessment`, `verdict` (`remediate`, `approve`, `reject`, or
`ask-operator`), and `artifacts`. Blocked payloads contain `reason`, `evidence`,
and `artifacts`. Spike computes artifact digests and publishes canonical
`submission.md` last. Only completed implementation snapshots create a bundle
and Candidate.

The Pi worker extension is `src/pi-worker-extension.ts`. Ticket launchers load
role-specific completion and blocked tools. The extension sends tool arguments
to `spike worker complete --json` or `spike worker block --json`; it does not
import Spike internals or format durable files. A rejected payload remains
retryable. An accepted outcome terminates the agent turn and requests Pi's
supported graceful shutdown; the Herdr wrapper then records the process exit.

A completed review or blocked Report needs no commit message options. To seal a
worker failure instead, use `--failure "<reason>"`. Report publication returns
worker cleanup status and retains a warning when finalization must be retried.

The direct planner launcher starts interactive Pi with the configured `planner`
model and thinking level. It disables extension discovery, explicitly loads only
`src/pi-supervisor-extension.ts`, and passes Spike's executable to that extension:

```bash
spike planner
```

The supervisor extension exposes sequential structured tools for committed
guidance selection, explicitly approved Goal creation, status, Plan revision,
Change creation and decisions, focused Implement/Review/Remediate Ticket issuance,
Pi dispatch, Report publication, and recovery. `spike_begin_step` must run
immediately before each guided mutation. It loads the selected Markdown through
the CLI; one matching mutation consumes the in-memory selection, and restart
discards it. Raw operator CLI commands are not gated. Every tool invokes Spike
with an argument array and parses its single `--json` response. While a Ticket worker runs, the extension
owns a cancellable one-shot `worker wait`; marker-backed completion queues an
operational follow-up keyed by full Ticket identity, while unexpected waiter failure
queues a distinct recheck. Planner prose, wake messages, worker terminal output,
and Pi exit status never become workflow facts; a successful Report publication or
Change decision remains the relevant immutable commit point.

Planner-facing commands select exact guidance, derive status from durable
documents, atomically revise the Plan, resolve Changes, and reconcile interrupted
repository state:

```bash
spike guidance show --step goal [--json]
spike guidance show --step plan --goal <goal-id> [--json]
spike guidance show --step implement --goal <goal-id> --change 001 [--json]
spike status [--goal <goal-id>] [--json]
spike plan revise --goal <goal-id> [--file plan.md] [--json] # stdin when omitted
spike change land --goal <goal-id> --change 001 [--json]
spike change reject --goal <goal-id> --change 001 --statement "..." [--json]
spike change abandon --goal <goal-id> --change 001 --statement "..." [--json]
spike recover [--goal <goal-id>] [--json]
```

## Apply a completed Goal locally

After every Change is resolved and workflow cleanup is healthy, an operator may
fast-forward the currently checked-out local branch to the Goal's exact
integration revision. This is a separate, explicit local action:

```bash
spike goal apply --goal spike-001 --target main \
  --approval "I approve applying this completed Goal" --json
```

The command requires all three arguments. It first refuses if the Goal has an
active Change or Ticket, cleanup warnings, a detached or different checked-out
branch, a dirty index/worktree, a missing local target, or a target that cannot
fast-forward. A refusal changes no target ref or worktree state through Spike's
apply logic and JSON reports a machine-readable `workflow` error with the
refusal reason.

On success, Spike's only mutation command is Git's local, verified
`merge --ff-only`. The JSON data contains `goalId`, `targetBranch`,
`previousTargetRevision`, `appliedRevision`, and `resultingTargetRevision`; the
latter two are the exact Goal integration commit. Goal apply does not invoke
`git push`, check out branches, create merge commits, rebase, cherry-pick,
force-update, or resolve conflicts.

JSON mode emits exactly one `{ ok, command, data }` success object or one
`{ ok, command, error }` failure object.
