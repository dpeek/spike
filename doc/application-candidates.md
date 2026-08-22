# Diverged Application Candidates

When the immutable FIFO head targets `main` after `main` has moved from that Goal's initial revision, the Project supervisor may issue an Application implementation Ticket:

```sh
spike application ticket issue --goal spike-001 --application 001 --instruction "Resolve the exact integration"
spike application ticket prepare --goal spike-001 --application 001 --ticket 001
```

Its identity is **Goal/Application/Ticket** (`spike-001/001/001`), not a Change Ticket identity. Application Ticket IDs are three-digit, Goal/Application-relative monotonic allocations. Change Tickets and their exchanges, runtime records, and retention refs remain in their existing Goal/Change/Ticket namespace.

The first Ticket pins target `M`, the Application's Goal revision `G`, and merge base `B`. Later Tickets retain those values. Production and review refuse target movement rather than silently rebuilding a Candidate. Application Candidates are immutable Report evidence and are retained only at `refs/spike/goals/<goal>/applications/<application>/tickets/<ticket>`; production never updates `main` or a Goal integration ref.

## Review and recovery

After a completed implementation Candidate and healthy cleanup, the supervisor may issue an exact-Candidate review Ticket. Approval is usable only for the highest fully reported exact review while every Application Ticket is reported, cleanup is healthy, and `main` still equals pinned `M`. Review workers and implementation workers are operational observations; their terminal reports and Candidate provenance are durable workflow evidence.

Application recovery interrupts open Application Tickets and rebuilds operational projections without changing `M`, `G`, Candidate refs, Goal refs, host worktree, or `main`. Target-decision recovery is supervisor-owned: it skips valid terminal return/stale attempts and advances only the earliest unresolved published decision owner. Malformed terminal evidence blocks only when that entry is reached; an unrelated later entry is not preflight-scanned.

## Reviewed apply by compare-and-swap

A diverged head is applied only after its highest fully reported review is an exact `approve` for the current Candidate and producing implementation Ticket, every implementation and review Ticket is reported, cleanup is healthy, and the separate immutable Application approval remains present. The supervisor then writes an immutable **reviewed apply decision** binding Application/Goal identity, squash form, pinned `M`, `G`, `B`, Candidate `C`, producer Ticket, approving review Ticket, approval text, and decision time.

Decision publication precedes target mutation. The supervisor advances only `refs/heads/main`, with Git `update-ref` compare-and-swap from exact `M` to exact `C`; it does not inspect, check out, merge, reset, or otherwise alter the host worktree, Goal refs, or unrelated refs. A moved target is never overwritten.

A reviewed decision is a FIFO barrier until `main == C`: `main == M` is **decision-pending** and recovery retries the CAS; `main == C` is **applied** and releases the next unresolved head; any other `main` is visible as **target-mismatch** and recovery makes no mutation. No decision with `main == M` has work to recover. Candidate retention is rebuildable evidence and never defines applied state. Target mismatch requires explicit operator intervention; it is not automatically resolved.

The Project supervisor exposes reviewed apply, status, and target recovery. Goal planners and workers cannot mutate `main`. Every Application still requires its own separate operator approval, including two disjoint Goals delivered in FIFO order as two sole-parent squash commits.

## Return and stale resolution

Only the supervisor can resolve the unresolved FIFO head, after every implementation/review Ticket is reported and cleanup is healthy. Both documents are immutable and bind identity, pinned `M`, `G`, and decision time. They never apply to `main` or mutate Goal/Candidate refs or the host worktree.

- `return` also binds the exact current Candidate/producer, completed highest review Ticket, and a nonblank statement. It requires current `main == M`, releases Goal planning immediately, and invalidates approval. Requeue waits until a landed Change advances integrated `G` beyond the returned `G`.
- `stale` requires current `main != M` and records both expected `M` and the distinct observed `main`. Candidate provenance is exact **neither-or-both**: no Candidate/producer when none exists, otherwise both must match the current completed Candidate. It removes the attempt from FIFO and invalidates approval, but freezes Goal planning. The same `G` can requeue with a new Application ID and Project queue position; its fresh `M` is selected only when it becomes head and receives its first Ticket.

A Goal's freeze/planner state is derived from its latest Application attempt. Thus stale history remains visible but cannot keep a Goal frozen after a later valid return. Resolved attempts never reopen, regain queue position, receive later Tickets/reviews, or own recovery. Strict schema, identity, pinned-fact, Candidate/producer, and stale-target checks are evaluated lazily at the affected queue entry.

`spike application status`, Goal/repository status, and supervisor status derive queue membership, terminal disposition, freeze/requeue state, Candidate/review history, cleanup, and separate worker observation from this durable evidence.
