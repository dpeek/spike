# Change

Define one coherent, independently safe integration unit that can land as exactly one commit.

- State observable acceptance criteria as distinct single-line assertions.
- Include explicit rationale, dependencies, and non-goals.
- Avoid architectural adjectives unless each has executable evidence.
- For each safety-sensitive criterion, identify the authoritative fact rather than a mutable projection, trusted and untrusted inputs, allowed side effects, concurrency or time-of-check/time-of-use windows, the environmental threat boundary, and concrete success and refusal evidence.
- Keep the Change small enough for one fresh implementer to satisfy every criterion and verify all required external postconditions in one session.
- Do not use several planned implementation Tickets to deliver one Change. Later implementation Tickets are only retries or remediation of review findings.
- If the work spans independent behavioral, risk, or verification fronts, split it into smaller Changes before issuance.

Create the Change only when its criteria describe the complete landable result, exclude deferred work, and fit one initial implementation Ticket followed by exact independent review.
