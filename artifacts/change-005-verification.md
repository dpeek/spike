# Change 005 verification

Implemented the final Application Candidate remediation.

- Supported Git 2.39 merge-tree operation now verifies the unique exact merge base and invokes `git merge-tree --write-tree M G`.
- Application exchanges are idempotently prepared; worker clones import the declared custom bundle refs before checking out the pinned input revision and accept both workspace/container policy contracts.
- Publication requires an exact, successful recorded Application Worker execution. Runtime finalization and forgetting are independent; retention/ref health and recovery are derived from Reports.
- Supervisor recovery reconciles completed Application Reports as well as open Tickets, rebuilding all reported retention refs.
- Added real-filesystem/real-Git scenarios for clean disjoint and same-file non-overlapping integration, textual conflict, prepared-then-dispatched custom refs, container policy, forged provenance refusal, retention deletion/rebuild, cleanup, and unchanged main.

Verification: final `bun run check` passed (143 tests, typecheck, and all production builds).
