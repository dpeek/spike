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
  --model "openai-codex/gpt-5.6-terra" \
  --thinking medium
```

`--model` and `--thinking` are optional one-Ticket overrides. Without them, the
Ticket uses its role's `implement` or `review` selection from `spike.json`.
Dispatch accepts no model overrides: it runs a controlled direct command with
the immutable selection from `ticket.md`, then preserves execution provenance
and exchange output for a later publication process:

```bash
spike ticket dispatch \
  --goal <goal-id> --change 001 --ticket 001 \
  --worker scripted-implementer \
  -- ./scripted-worker

spike report publish \
  --goal <goal-id> --change 001 --ticket 001 \
  --commit-summary "Implement the Change"
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

A completed review Report needs no commit message options. To seal a worker
failure instead, use `--failure "<reason>"`. Report publication returns worker
cleanup status and retains a warning when finalization must be retried.

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
