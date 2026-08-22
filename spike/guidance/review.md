# Review

## Purpose

Independently assess the exact Candidate against the canonical Change criteria and workflow invariants.

## Ticket assignment

- Use the Project's configured execution-policy defaults. Do not override isolation or credential grants speculatively.
- Override policy only when the approved Goal or Change explicitly requires a different supported isolation boundary. Before overriding, verify the complete frozen setup, selected-model, credential-resolution, dispatch, completion-observation, Report-publication, and cleanup lifecycle in that boundary.

## Required work

- Review the exact Candidate and producing implementation Report named by the Ticket.
- Assess every canonical acceptance criterion exactly once.
- Reproduce important behavior where practical; reject projection-only evidence and require concrete external postconditions for resource order, partial failure, supervisor restart, Report publication, and final resource absence when applicable.
- Reuse immutable evidence for unchanged criteria in a narrow remediation review. Block only on concrete regression, recurrence, or an unmet canonical criterion, not verified architecture, wording preferences, or optional hardening.
- Select reviewer model and thinking strength for Change risk. Cheap low-thinking review is allowed only for narrowly scoped late remediation; after any executable change, reset the next review to strong model and thinking strength.
- Reuse a stable finding ID when the same material defect recurs.
- If a condition outside the worker's control prevents review, use the blocked tool with concrete reason and evidence; it produces no verdict.

## Blocking findings

Every blocking finding must identify the affected criterion, regression, security invariant, or evidence invariant; cite concrete code or evidence; give reproduction steps or deterministic reasoning; and state the smallest required remediation.

## Boundaries

- Do not turn architectural preference, optional hardening, deferred work, or an ideal extension point into a blocker.
- If a blocking conclusion depends on an unstated threat model or interpretation of an absolute constraint, assess the affected criterion as unclear and use `ask-operator` rather than requesting implementation remediation.
- Label non-required improvements as non-blocking.
- Approve only the exact Candidate that satisfies every criterion; never infer approval from implementation confidence or passing tests alone.
