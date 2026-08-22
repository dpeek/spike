# Remediate

## Purpose

Close the explicit accepted findings from the selected review Report in a fresh implementation Ticket.

## Required work

- Address the finding set and stop conditions named by the Ticket.
- State the root cause for each stable finding ID, reproduce each accepted lifecycle failure through the exact production lifecycle seams before changing code, verify its concrete reproduction no longer holds, and test adjacent members of the same defect class. Hand-written markers or callback counts do not substitute for the failing lifecycle.
- For validation defects, cover applicable blank or whitespace-only, missing, wrong-type, malformed, unknown, and mismatched cases. For side-effect defects, inspect every path that invokes the same external mechanism.
- For multi-resource side effects, exercise cleanup after every resource-creating side-effect prefix, retry cleanup, and assert each final resource is concretely absent.
- Run required regression checks and verify affected external postconditions, including that refusals occur before side effects.
- Keep unrelated Candidate behavior intact.

## Completion

Call the implementation completion tool only when every accepted finding assigned to this Ticket is closed and all required verification passes. A limitation that leaves an assigned finding open forbids completed submission. If a condition outside the worker's control prevents remediation, use the blocked tool with concrete reason and evidence; it produces no Candidate.

## Boundaries

- Make the smallest coherent changes needed to close the accepted findings.
- Do not add new architecture, hardening, or deferred work unless a finding or canonical criterion requires it.
- Surface contradictory findings or a design-level blocker instead of guessing or expanding scope.
