# Diverged Application Candidates

When the immutable FIFO head targets `main` after `main` has moved from that Goal's initial revision, the Project supervisor may issue an Application implementation Ticket:

```sh
spike application ticket issue --goal spike-001 --application 001 --instruction "Resolve the exact integration"
spike application ticket prepare --goal spike-001 --application 001 --ticket 001
```

Its identity is **Goal/Application/Ticket** (`spike-001/001/001`), not a Change Ticket identity. Application Ticket IDs are three-digit, Goal/Application-relative monotonic allocations. Change Tickets and their exchanges, runtime records, and retention refs remain in their existing Goal/Change/Ticket namespace.

The first Ticket pins target `M` (the exact current `main`), the Application's pinned Goal revision `G`, and merge base `B`. It embeds Implement guidance read from the Git blob at `M`, plus the selected model and execution policy. Later Tickets retain those values; if `main` no longer equals `M`, additional production is refused rather than silently rebuilding a Candidate. `spike application status` exposes that mismatch while preserving completed evidence.

Preparation produces a bounded, read-only Ticket and context plus an input bundle containing only declared refs for `M`, `G`, `B`, and the worker input. A mechanically clean three-way merge starts the worker from a host-computed integration tree. A conflicted merge starts at `M` and embeds bounded Git conflict evidence, with the same exact refs for reproduction and resolution.

Worker output remains untrusted. Publication validates declared regular output files, canonical artifact paths and digests, sizes, a verifiable bundle, and the advertised exact worker revision before importing under an Application-qualified quarantine ref. The host normalizes the accepted worker tree into a Candidate with exactly one parent `M` and a concise Goal delivery message. It retains that Candidate only at:

```text
refs/spike/goals/<goal>/applications/<application>/tickets/<ticket>
```

An immutable Application Report is the sole Candidate commit point and records `M`, `G`, `B`, clean/conflict classification, worker and Candidate revisions, artifacts, and execution provenance. Candidate production never updates `main` or a Goal integration ref and never makes an Application decision.

`spike application recover --goal … --application … --ticket …` interrupts an open Ticket, removes its exchange debris, clears unreported retention/quarantine debris, and rebuilds retention from Reports. It does not issue replacement work, change the pin, mutate `main`, or apply a decision.
