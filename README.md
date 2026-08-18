# Spike

Spike is a local, Git-native workflow for planning, implementing, reviewing, and landing agent-authored changes.

Version 2 is starting from a deliberately small foundation.

## Documentation

- [Workflow design](doc/workflow.md)

## Development

Requires [Bun](https://bun.sh/).

```bash
bun run test
bun run check
bin/spike --help
```

Spike reads tracked project model defaults from `spike.json`. Ticket issuance
freezes the selected model and thinking level into `ticket.md`; later dispatch
never rereads configuration or accepts model overrides.

The workflow can create an approved Goal and Plan, allocate a Change, and issue
its first implementation Ticket in any Git repository with a commit:

```bash
spike goal create \
  --title "Ship the workflow" \
  --outcome "Land reviewed Changes as one commit each" \
  --approval "Approved to proceed"

spike change create \
  --goal <goal-id> \
  --title "Add allocation" \
  --intent "Allocate sequential Changes and Tickets" \
  --rationale "Durable work needs stable nested identity" \
  --acceptance "IDs are monotonic and never reused"

spike ticket issue \
  --goal <goal-id> \
  --change 001 \
  --instruction "Implement the Change" \
  --context "Preserve the current filesystem contract" \
  --network-access unrestricted \
  --model "openai-codex/gpt-5.6-terra" \
  --thinking medium
```

`--model` and `--thinking` are optional one-Ticket overrides. Without them, the
Ticket uses its role's `implement` or `review` selection from `spike.json`.
`--network-access unrestricted` is the explicit acknowledgement required by the
Phase 2 local-clone adapter, which provides workspace separation but cannot
restrict host networking.
Pi dispatch accepts no model, thinking, role, prompt, or extension overrides. It
launches one fresh non-interactive Pi process with the immutable selection from
`ticket.md`, the role-specific completion extension, and the exact Ticket input
revision. Attended dispatch defaults to one named ephemeral Herdr tab. Spike
persists only its opaque tab and pane handles as Herdr state; status and terminal
text remain observational. Dispatch returns after launch so the planner can
observe `working` or `blocked` workers. Exchange output remains staging until a
separate publication command:

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
spike worker read --goal <goal-id> --change 001 --ticket 001 --lines 120
spike worker attach --goal <goal-id> --change 001 --ticket 001
```

Herdr `working`, `blocked`, `done`, or unavailable status and terminal output
cannot complete the Ticket or publish a Report. Report publication validates only
the standard exchange and then closes the tab; stop and cleanup can be retried.

Direct Pi launch is an explicit controlled-test fallback:

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

Inside the private worker checkout, structured completion reads the Ticket from
`SPIKE_INPUT_DIR/ticket.md` and accepts JSON from a file or stdin:

```bash
spike worker complete --file payload.json
# or: printf '%s' "$payload" | spike worker complete
```

Implementation payloads contain `summary`, `verification`, `assumptions`,
`limitations`, `risks`, `followUp`, and an `artifacts` path array. Review
payloads contain `reviewStatement`, `findings`, `acceptanceAssessment`,
`verdict` (`remediate`, `approve`, `reject`, or `ask-operator`), and
`artifacts`. Spike computes artifact digests, snapshots an
implementation checkout, creates its bundle, and publishes canonical
`submission.md` last.

The Pi worker extension is `src/pi-worker-extension.ts`. Ticket launchers load
it with exactly one terminating tool selected by the immutable Ticket role:
`spike_complete_implementation` or `spike_complete_review`. The extension sends
tool arguments to `spike worker complete --json`; it does not import Spike
internals or format durable files. A rejected payload remains retryable and
only an accepted completion terminates the agent turn.

A completed review Report needs no commit message options. To seal a worker
failure instead, use `--failure "<reason>"`. Report publication returns worker
cleanup status and retains a warning when finalization must be retried.

The direct planner launcher starts interactive Pi with the configured `planner`
model and thinking level. It disables extension discovery, explicitly loads only
`src/pi-supervisor-extension.ts`, and passes Spike's executable to that extension:

```bash
spike planner
```

The supervisor extension exposes sequential structured tools for status, Plan
revision, Change creation and decisions, Ticket issuance and Pi dispatch, Report
publication, and recovery. Every tool invokes Spike with an argument array and
parses its single `--json` response. Planner prose, worker terminal output, and
Pi exit status never become workflow facts; a successful Report publication or
Change decision remains the relevant immutable commit point.

Planner-facing commands derive status from durable documents, atomically revise
the Plan, resolve Changes, and reconcile interrupted repository state:

```bash
spike status [--goal <goal-id>] [--json]
spike plan revise --goal <goal-id> [--file plan.md] [--json] # stdin when omitted
spike change land --goal <goal-id> --change 001 [--json]
spike change reject --goal <goal-id> --change 001 --statement "..." [--json]
spike change abandon --goal <goal-id> --change 001 --statement "..." [--json]
spike recover [--goal <goal-id>] [--json]
```

JSON mode emits exactly one `{ ok, command, data }` success object or one
`{ ok, command, error }` failure object.
