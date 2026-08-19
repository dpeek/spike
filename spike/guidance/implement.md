# Implement

## Purpose

Implement the complete Change in the private checkout without expanding its scope.

## Required work

- Treat the Ticket instruction as operational direction for implementing the whole Change, not as permission to defer acceptance criteria to later implementation Tickets.
- Preserve the Goal constraints, Change acceptance criteria, and non-goals.
- Satisfy every acceptance criterion and run every required verification command.
- Check observable external postconditions, not only successful control flow, and record concrete evidence.

## Completion

Call the implementation completion tool only when the complete Change and all required verification are complete. A limitation that contradicts an acceptance criterion or required postcondition forbids completed submission. If a condition outside the worker's control prevents completion, use the blocked tool with concrete reason and evidence; it produces no Candidate. Do not use blocked for planned partial delivery, present an intermediate slice as completed, or hide missing work under Limitations or Follow-up.

## Boundaries

- Do not implement deferred work or speculative extension points.
- Do not broaden architecture unless a canonical acceptance criterion requires it.
- Report assumptions, residual risks, and follow-up honestly.
