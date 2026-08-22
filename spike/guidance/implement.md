# Implement

## Purpose

Implement the complete Change in the private checkout without expanding its scope.

## Required work

- Treat the Ticket instruction as operational direction for implementing the whole Change, not as permission to defer acceptance criteria to later implementation Tickets.
- Preserve the Goal constraints, Change acceptance criteria, and non-goals.
- Satisfy every acceptance criterion and run every required verification command.
- Check observable external postconditions, not only successful control flow, and record concrete evidence.
- For multi-resource side effects, exercise cleanup after every resource-creating side-effect prefix, retry cleanup, and assert each final resource is concretely absent.

## Pre-completion audit

- Assess every canonical acceptance criterion against concrete code and verification evidence before completing.
- Expand enumerated negative requirements into representative boundary cases, including blank or whitespace-only, missing, wrong-type, malformed, unknown, and mismatched inputs where applicable.
- Prove refusals occur before filesystem, runtime, external-command, or durable workflow side effects.
- Challenge mutable projections against their authoritative facts, in-flight lifecycle behavior rather than only settled states, concurrency or time-of-check/time-of-use windows, and configured external-command side effects within the stated threat boundary.

## Completion

Call the implementation completion tool only when the complete Change and all required verification are complete. A limitation that contradicts an acceptance criterion or required postcondition forbids completed submission. If a condition outside the worker's control prevents completion, use the blocked tool with concrete reason and evidence; it produces no Candidate. Do not use blocked for planned partial delivery, present an intermediate slice as completed, or hide missing work under Limitations or Follow-up.

## Boundaries

- Do not implement deferred work or speculative extension points.
- Do not broaden architecture unless a canonical acceptance criterion requires it.
- Report assumptions, residual risks, and follow-up honestly.
