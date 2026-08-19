# Remediate

## Purpose

Close the explicit accepted findings from the selected review Report in a fresh implementation Ticket.

## Required work

- Address the finding set and stop conditions named by the Ticket.
- Preserve stable finding IDs in evidence and verify each finding's concrete reproduction no longer holds.
- Run required regression checks and verify affected external postconditions.
- Keep unrelated Candidate behavior intact.

## Completion

Call the implementation completion tool only when every accepted finding assigned to this Ticket is closed and all required verification passes. A limitation that leaves an assigned finding open forbids completed submission.

## Boundaries

- Make the smallest coherent changes needed to close the accepted findings.
- Do not add new architecture, hardening, or deferred work unless a finding or canonical criterion requires it.
- Surface contradictory findings or a design-level blocker instead of guessing or expanding scope.
