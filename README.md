# Spike

Spike is a local, Git-native workflow for planning, implementing, reviewing, and landing agent-authored changes.

Version 2 is starting from a deliberately small foundation.

## Documentation

- [Workflow design](doc/workflow.md)
- [Phase 2 dogfood procedure and evidence](doc/dogfood.md)
- [Diverged Application Candidates](doc/application-candidates.md)

## Development

Requires [Bun](https://bun.sh/).

```bash
bun run check             # focused tests + one complete CLI tracer bullet
bun run test:integration  # scenario and adapter-contract suites
bun run check:full        # all non-Docker tests
# Explicit Docker coverage (requires a safe local daemon)
bun test test/docker/
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

## Attended container workers

When a planner is running under Herdr (`HERDR_ENV=1`), container Tickets launch a fresh interactive Docker TTY in one ephemeral Herdr tab. The tab can be read or attached through the existing worker status/read/attach operations. Outside Herdr, and with `--host direct`, Docker remains the explicit headless path. Terminal output and attachment are operational only: the adapter's restartable Docker observer records the actual-exit marker only after `docker wait` observes container exit; the Herdr wrapper owns attachment only. Normal validated exchange output and Report publication remain authoritative. Containers retain the declared read-only filesystem, exchange-only mounts, network policy, pinned image, and credential injection boundary. Their bounded `/tmp` and `/work` tmpfs locations are writable and executable for generated coding tools while remaining `nosuid`.

## Request inbox

Requests are host-local, Git-independent unapproved intake. `spike request create`
uses `SPIKE_DATA_DIR`, then `${XDG_DATA_HOME}/spike`, then
`${HOME}/.local/share/spike`. Projects use this exact same root: their control plane is
`projects/<slug>/` alongside `requests/`; no second `SPIKE_DATA_ROOT` selector exists.
It stores immutable Markdown under that root; no Project checkout is required. A Request may have no `--project` flags (unassigned)
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
isolation in configuration resolves to `container`. When the planner has
`HERDR_ENV=1`, both workspace and container dispatch are attended; otherwise both
use direct execution. Use `--host direct` as the explicit container fallback.
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
cannot complete the Ticket or publish a Report. Planner ownership follows the same
rule: it is an operational projection, not durable workflow evidence or a lease. `worker wait` emits one operational
notification only after the attended execution marker exists: for workspace
hosting, the wrapper records local Pi exit; for Docker, the adapter-owned,
restartable exact-container observer records actual exit after `docker wait` and
installs the operational marker; the Herdr pane hosts attachment only. The supervisor extension waits in the
background and queues a full-identity recheck
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
supported graceful shutdown. For workspace hosting, the Herdr wrapper then
records local Pi exit; for Docker, the Herdr pane hosts attachment only and the
adapter-owned, restartable exact-container observer records actual container exit
and installs the operational marker.

A completed review or blocked Report needs no commit message options. To seal a
worker failure instead, use `--failure "<reason>"`. Report publication returns
worker cleanup status and retains a warning when finalization must be retried.

A Project supervisor owns Project-wide workflow operations. It can own at most two
replaceable Herdr-hosted planners for two distinct existing Goals by default. Goal
creation and allocation, planner admission, Application operations, target mutation,
and repository-wide recovery remain supervisor-owned and serialized. Its deterministic human-readable
name includes the exact repository identity digest and Goal ID, so matching labels
cannot be confused merely because two repositories share a Project slug. The same
name is used for Herdr tab discovery, the tab label, and Pi's persistent `--name`.

```bash
spike planner start-or-reattach --goal spike-001 --json
spike planner observe --goal spike-001 --json
spike planner attach --goal spike-001
spike planner replace --goal spike-001 --json
```

Start-or-reattach reconstructs admission from exact live Herdr discovery and returns
one exact live planner without launching another Pi. At most two distinct Goal labels
are admitted; a third is refused before stale cleanup, tab creation, Pi launch, or
workflow mutation. Duplicate live labels are refused without closing either pane;
`replace` is the explicit operation that idempotently closes only the selected Goal's
exact matching tabs and starts a fresh named Pi session, including at two-Goal
capacity. Done or unavailable matching resources are stale operational projections
and are cleaned only after admission. Reattachment preserves the live Pi
conversation; replacement begins only from durable Goal, Plan, Ticket, Report,
decision, and Git evidence. Neither operation reads Pi JSONL, terminal text, process
exit, or Herdr state as workflow evidence, and neither invokes Spike recovery.

The launched Pi disables extension discovery, loads only
`src/pi-goal-planner-extension.ts`, allows only read/grep/find/ls plus Goal-scoped
planner tools, and receives its exact Goal ID through the launch environment. Those
Goal-local tools may overlap only across distinct Goals: their documents, candidate
and integration refs, exchanges, and runtime records are nested by Goal ID. Each Goal
still has one active Change and each Change one active Ticket. Those
tools reject a different Goal before invoking `spike`; they omit Project-wide Goal
creation, Request inbox, and Goal application operations. `spike planner` remains
the direct Project-supervisor launcher for interactive local operation.

Repository status is a durable projection of every Goal's documents, Reports,
decisions, Applications, and Git evidence; it remains available without planners.
Supervisor planner observations are a separate operational projection and never alter
durable phase, cleanup health, or recovery. The supervisor extension exposes
sequential structured tools for committed guidance selection, explicitly approved Goal creation, status, Plan revision,
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
spike status [--goal <goal-id>] [--operational] [--json]
spike plan revise --goal <goal-id> [--file plan.md] [--json] # stdin when omitted
spike change land --goal <goal-id> --change 001 [--json]
spike change reject --goal <goal-id> --change 001 --statement "..." [--json]
spike change abandon --goal <goal-id> --change 001 --statement "..." [--json]
spike recover [--goal <goal-id>] [--json]
```

## Queue and apply completed Goals

The Project supervisor admits a completed healthy Goal with separate approval:

```bash
spike goal queue --goal spike-001 --target main --approval "I approve queueing this Goal" --json
```

Admission publishes immutable Application evidence with the pinned integrated revision, `main`, approval, request time, and Project-wide monotonic FIFO position. Position comes from published evidence rather than timestamps, so tied clocks cannot reorder Goals. Publication freezes every Goal-local Plan, Change, Ticket, Report, decision, and recovery mutation; read-only status and worker observation remain available. The matching Goal planner is released operationally afterward, and cleanup failure is reported without changing queue evidence.

Only the immutable unresolved FIFO head can be selected by the supervisor:

```bash
spike application apply-head --goal spike-001 --application 001 --json
```

It refuses missing, resolved, non-head, mismatched, stale, or non-`main` work before a Candidate, decision, ref, or worktree mutation. If checked-out `main` exactly equals the head Goal base, Spike creates the single-parent deterministic squash Candidate, publishes its exact decision, then uses `merge --ff-only` so Git preserves user changes. No model review is needed on this clean-base path. For a diverged head, all implementation/review Tickets must be reported, cleanup healthy, the separate Application approval present, and the highest review must exactly approve the current Candidate/producer. Spike publishes a distinct reviewed decision binding M/G/B, Candidate, producer, approving review, approval, squash form, and time before CAS-updating only `refs/heads/main` from M to C. It never checks out, merges, resets, or inspects the host worktree in that reviewed path. A reviewed decision is a FIFO barrier: M is decision-pending and retried on recovery, C is applied and releases the next head, and any other main is visible target-mismatch with no mutation or automatic intervention. Two Goals therefore require two approvals and land as FIFO squash commits. There is no `goal apply` compatibility command.

## Diverged Application Candidates

A diverged FIFO head (`main` no longer equals the queued Goal base) remains frozen but can receive one supervisor-issued implementation Ticket in the separate Goal/Application/Ticket namespace. The first Ticket pins exact target `M`, Goal revision `G`, merge base `B`, and Implement guidance loaded from the Git blob at `M`; retries cannot repin them. Prepare it with `spike application ticket prepare`, which supplies a bounded bundle containing only `M`, `G`, `B`, and its declared input. Clean three-way integration starts from the computed tree; conflicts start from `M` with exact bounded conflict evidence. The accepted worker tree is normalized to a single-parent Candidate on `M`, retained under the producing Application Ticket ref, and made authoritative only by an immutable Application Report. Candidate production never changes `main`, Goal integration refs, or an Application decision. `spike application status` surfaces a later target mismatch without hiding the pinned evidence; `spike application recover` interrupts open work and rebuilds retention without issuing a replacement or mutating `main`. See [Diverged Application Candidates](doc/application-candidates.md).

JSON mode emits exactly one `{ ok, command, data }` success object or one
`{ ok, command, error }` failure object.
