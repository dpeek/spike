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

The Phase 1 prototype can create an approved Goal and Plan, allocate a Change,
and issue its first implementation Ticket in any Git repository with a commit:

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
  --context "Preserve the current filesystem contract"
```
