Minimalism and simplicity above all else. Follow `doc/workflow.md` and use its domain terms consistently.

## Runtime and tooling

- Bun is the only Spike application runtime. Use `bun`, `bun:test`, and `bun run check`.
- Pi remains a Node process behind CLI/RPC; keep Pi extensions thin and Node-compatible.
- Keep dependencies few. Use Zod for document shape; keep schemas internal to owning modules.
- Prefer deep modules and a thin CLI. Add abstractions only when they remove demonstrated complexity.

## Workflow

- No backwards compatibility, dual writes, legacy readers, or migrations unless explicitly requested.
- No speculative contract, schema, or metadata versioning.
- Durable workflow documents are Markdown with unversioned JSON frontmatter.
- Work is sequential: one active Change per Goal and one active Ticket per Change.
- Change and Ticket IDs are parent-relative, monotonic three-digit sequences (`001`) and are never reused.
- Derive status from durable facts; do not duplicate it in state machines or mutable records.
- Preserve user changes.

## Tests

- Keep the default suite useful and fast enough for frequent use. Reserve integration tests for complete workflows and high-risk seams; prefer focused tests where they provide equivalent confidence.
- Collocate focused tests as `src/**/*.test.ts`.
- Put scenarios in `test/scenario/`, adapter contracts in `test/contract/`, Docker tests in `test/docker/`, and helpers in `test/support/`.
- Use real temporary filesystems and real Git. Do not add in-memory filesystem or Git implementations.
- No sleeps, network, Docker, Pi, Herdr, or model calls in the default suite.
- Keep Docker and external integration smoke tests explicit and minimal.

# Rules

- Keep responses concise
- Prefer Bun over Node + NPM
- Automate using Bun scripts
- Preserve user changes
- Tests + checks should be fast + useful