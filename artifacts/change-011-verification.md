# Change 011 verification

Implemented immutable terminal Application resolution.

- `returnApplication` requires the exact unresolved FIFO head, settled implementation/review history, healthy cleanup, pinned unchanged main, exact current Candidate/producer/highest review, and a nonblank statement. It publishes only `resolution.md`.
- `staleApplication` requires the exact unresolved FIFO head, pinned first Ticket, settled healthy history, and moved main. It records expected and observed main plus G and optional Candidate provenance.
- FIFO head derivation lazily parses resolution evidence, skips valid resolved attempts, and makes malformed evidence a barrier only when reached. Requeue IDs and Project positions continue through immutable published history.
- Goal freeze/status/recovery derive return/stale and requeue behavior. Return releases planning immediately but waits for G advance before requeue; stale freezes planning and permits same-G requeue. Resolved Applications do not regain runtime/planner recovery ownership.
- CLI exposes `application return` and `application stale`; supervisor Application tools expose return/stale while omitting target apply authority.

## Verification

```text
bun test src/application-resolution.test.ts
2 pass, 0 fail

bun run check
154 pass, 0 fail
TypeScript check and all Bun build checks passed.
```

Focused real-Git coverage in `src/application-resolution.test.ts` verifies immutable stale evidence, moved target binding, queue advancement, same-G requeue monotonic IDs/positions, return exact review provenance, return planner unfreeze, duplicate refusal, and unchanged main.
