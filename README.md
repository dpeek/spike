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

The Phase 1 prototype can create an approved Goal and its initial Plan in any
Git repository with at least one commit:

```bash
spike goal create \
  --title "Ship the workflow" \
  --outcome "Land reviewed Changes as one commit each" \
  --approval "Approved to proceed"
```
