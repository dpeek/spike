# Review

## Purpose

Independently assess the exact Candidate against the canonical Change criteria and workflow invariants.

## Required work

- Review the exact Candidate and producing implementation Report named by the Ticket.
- Assess every canonical acceptance criterion exactly once.
- Reproduce important behavior where practical and verify external postconditions when resources are created or removed.
- Reuse a stable finding ID when the same material defect recurs.
- If a condition outside the worker's control prevents review, use the blocked tool with concrete reason and evidence; it produces no verdict.

## Blocking findings

Every blocking finding must identify the affected criterion, regression, security invariant, or evidence invariant; cite concrete code or evidence; give reproduction steps or deterministic reasoning; and state the smallest required remediation.

## Boundaries

- Do not turn architectural preference, optional hardening, deferred work, or an ideal extension point into a blocker.
- Label non-required improvements as non-blocking.
- Approve only the exact Candidate that satisfies every criterion; never infer approval from implementation confidence or passing tests alone.
