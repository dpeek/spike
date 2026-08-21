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

## Exact Application review

After the producing implementation Report is complete and cleanup is healthy, only the Project supervisor may issue `spike application review issue`. The immutable review Ticket pins the same M/G/B, the exact current Candidate and producing implementation Ticket, configured review model/policy, and review guidance selected from M. Its context is bounded to the Goal outcome and constraints, current Plan, producing Report, and landed evidence.

A review worker is dispatched through the configured Application adapter into a fresh exact-Candidate checkout. Its runtime record, terminal output, stop/finalize/forget lifecycle, and exchange cleanup are operational observations, never workflow evidence. A review worker stages an untrusted Submission; it never writes a Report or mutates `main`. The supervisor validates identity, Candidate/producer, canonical Outcome/Constraint assessment coverage, unique findings, output allowlist, contained artifact paths, and exact digests before publishing an immutable review Report. Cleanup debris gates both later review issuance and approval usability; a published Report remains durable while cleanup is retried. Approval is usable only for the highest fully reported exact review while every Application Ticket is reported, cleanup is healthy, and `main` still equals M. A later review, any non-approve verdict, an open review, or target movement makes it unusable. Non-approve verdicts are durable pause evidence only: they do not issue work, unfreeze the Goal, replace the Candidate, reorder FIFO, or advance `main`.

The single local Project supervisor, Spike store, Git/filesystem, and configured Application runtime adapter are trusted. Repository content and worker-authored Submissions/artifacts are untrusted. Recovery records identity-preserving interrupted review evidence when possible and performs best-effort adapter cleanup without changing M/G/B, Candidate refs, Goal refs, host worktree, or `main`.

## One remediation response

When the highest exact review Report is `remediate`, the supervisor may issue exactly one further `application ticket issue` response. The Ticket records the response review Ticket, the immediately replaced implementation Ticket and Candidate, and the original immutable M/G/B. Its input starts at that Candidate; its bounded Ticket context includes the exact review Report, stable findings, Goal outcome/constraints, replacement contract, and guidance selected from M. It still receives only M/G/B/input refs and publication uses the same strict Submission validation and one-parent-M normalization.

A response review can authorize only one implementation Ticket, including one that later publishes `blocked` or `partial` terminal evidence. A completed replacement Report is the only way to replace the current Candidate. Consequently all earlier approval is unusable and a fresh exact review of the replacement Candidate and response Ticket is required. Blocked and partial Reports preserve Ticket identity and M/G/B but contain no Candidate; interrupted recovery remains a separate outcome and asks the configured adapter to clean up.

`spike application status`, Goal/repository status, and supervisor status derive three warning-only churn indicators from ordered immutable history: two remediate review verdicts, a stable finding ID that recurs in a later remediate review, and two consecutive blocked/partial implementation Reports. Interrupted Reports and nonconsecutive terminal outcomes do not satisfy the latter rule. Warnings never issue work, select a model, resolve/reorder an Application, unfreeze a Goal, or mutate `main`.
