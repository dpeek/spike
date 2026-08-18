# Workflow retrospective

**Evidence labels:** **Fact** = durable Spike evidence or retained artifact; **Inference** = evidence-backed interpretation; **Hypothesis** = requires measurement.

**Audit caveat:** this session exposed no command-execution/Git-show tool. I verified `spike_status`, all Goal/Plan/Change/Ticket/Report/decision documents, all retained artifacts, and the landed Change 001 source. Exact Change 002 diff conclusions rely on retained reviews/artifacts tied to the requested hashes; I could not independently rerun `git diff` against its bundle.

## 1. Executive diagnosis

1. **Tickets described whole Changes rather than executable stopping points.**  
   **Fact:** Change 002 Tickets 001 and 003 reported `completed` while explicitly stating that the image did not build or that the completed implement/review tracer was still absent. Later bounded Tickets 005, 007, and 009 converged with the same implementation model.  
   **Inference:** Ticket sizing and completion discipline were the main cause, not model capability.

2. **The worker completion interface only supports `completed`.**  
   **Fact:** `src/pi-worker-extension.ts` registers only `spike_complete_implementation` or `spike_complete_review`; `src/worker-completion.ts` always writes `outcome: "completed"`. The durable model defines `partial` and `blocked`, but workers cannot select them through structured completion.  
   **Inference:** Known blockers were forced into `Limitations` and `Follow-up`, preserving work but corrupting outcome meaning.

3. **Change 001 asked for an abstract adapter seam before the second adapter existed.**  
   **Fact:** three reviews repeatedly refined what “adapter-neutral” meant. Several findings were genuine, but contract and ownership expectations grew through review/remediation prompts.  
   **Inference:** folding the seam into the first concrete Docker vertical slice would likely have produced a smaller, evidence-driven abstraction.

4. **Deterministic churn existed but was structurally invisible.**  
   **Fact:** current status reports no churn warnings after nine Change 002 Tickets. `plan.md` has `changePlans: []`; landed `status.ts` suppresses all churn detection when no structured planned count exists. Planned counts were present only in prose, and stable finding IDs changed across reviews.  
   **Inference:** the operator saw history that the product could already derive, but an optional metadata field disabled the projection.

5. **Verification tested successful control flow without asserting external postconditions.**  
   **Fact:** Change 002’s nine Docker tests passed while real exited containers remained. Review 008 detected this independently; Ticket 009 added real cleanup retries and residual-container assertions.  
   **Inference:** cleanup contracts need resource-absence postconditions, not merely successful method returns.

## 2. Evidence-backed timeline

### Change 001 — Worker adapter seam

| Ticket | Outcome |
|---|---|
| 001 implement | Candidate `2509334…`; default checks passed. |
| 002 review | `remediate`: false adapter provenance, duplicated/local-only lifecycle seam, metadata-only contract; legacy migration suggestion conflicted with repository policy. |
| 003 implement | Candidate `e50987f…`; provenance and seam remediation. |
| 004 review | `remediate`: shared runtime still local-specific, host evidence could contradict launch evidence, contract gaps. |
| 005 implement | Candidate `cc2fccb…`; opaque runtime envelope and selected-adapter routing. |
| 006 review | `remediate`: concrete lookalike-adapter corruption and host-report loading mismatch; reusable cleanup/recovery expansion was optional scope growth. |
| 007 implement | Narrow Candidate `b0ef458…`; fixed the two accepted blockers. |
| 008 review | `approve`; only alias/sleep cleanup remained non-blocking. |
| Decision | Landed exact approved revision `b0ef458…`. |

**Assessment:** coherent intent, but abstract acceptance language made the Change too interpretation-heavy. Eight Tickets versus two planned was predictable churn.

### Change 002 — Scripted Docker tracer bullet

| Ticket | Outcome |
|---|---|
| 001 implement | Candidate `ee5477…`; marked completed despite unbuildable Bun artifact and no real Docker suite. |
| 002 review | `remediate`: six direct acceptance failures—unbuildable image, absent tracer/contract, digest race, hidden cleanup errors, orphan window, workspace regression. |
| 003 implement | Candidate `dd5ba4…`; buildable image and two Docker tests, but only failed-exit smoke. Again marked completed with acceptance-critical limitations. |
| 004 review | `remediate`: completed tracer, lifecycle matrix, and exact default check still absent. |
| 005 implement | Bounded Candidate `a1771c…`; container-local completion, implement/review tracer, five Docker tests. |
| 006 review | Predetermined intermediate `remediate`; verified tranche and recorded only intentionally deferred lifecycle work. |
| 007 implement | Candidate `b580871…`; lifecycle/recovery matrix, 59 default and nine Docker tests. |
| 008 review | `remediate`: genuine external resource leak despite passing suite. |
| 009 implement | Candidate `b2a9755…`; real cleanup retry, absence assertions, nine Docker tests, no residual suite containers. |
| Current | Open Change, no Ticket, no exact review of `b2a9755…`; cleanup status healthy. |

**Assessment:** coherent integration unit, but eight acceptance criteria combined image construction, security policy, completion, provenance, lifecycle, recovery, and cross-adapter contracts. That was too broad for the original “one implementation, one review” plan.

## 3. What worked and should be preserved

- **Exact Candidate provenance and immutable Reports.** Reviews caught false provenance, digest races, contradictory host evidence, and an external cleanup leak.
- **Fresh independent review.** Reviewers reproduced failures rather than trusting implementation claims.
- **Review before landing.** Neither Change could land based solely on passing tests or implementation confidence.
- **Operator pause and bounded remediation.** Change 002 began converging after work was split into completion, lifecycle, and cleanup Tickets.
- **Canonical acceptance assessment.** Review Reports assess every criterion exactly once and approval requires all `met`.
- **Explicit non-goals and minimal adapter selection.** Evidence shows no registry, persistent runtime framework, or broad Docker mounting architecture.
- **Cleanup independence from workflow authority.** Current status is healthy and Reports remain authoritative rather than container/process state.

## 4. Failures ranked by impact

1. **Implementation outcome semantics are not executable.** `partial` and `blocked` exist durably but not in worker tools.
2. **Tickets lacked executable completion gates.** “Implement Change completely” was paired with large multi-system criteria and no rule forbidding completed submission with unmet required behavior.
3. **Churn projection depends on unavailable structured planning metadata.**
4. **Change 001 deepened an abstraction before concrete Docker pressure existed.**
5. **The exact-review-before-next-implementation invariant forced a synthetic intermediate review.** Ticket 006 was explicitly instructed to verify a tranche and return `remediate` for known deferred work.
6. **Cleanup verification asserted calls rather than resulting resource absence.**
7. **Review prompts sometimes promoted ideal architecture into requirements.** This was most pronounced in Change 001; Change 002 findings were overwhelmingly canonical and concrete.
8. **Worker completion does not wake the planner.** This creates polling and publication latency without adding integrity.

## 5. Recommended workflow changes

### Immediate, before continuing this Goal

1. **Give Candidate `b2a9755…` one final narrow review.** Verify:
   - Ticket 009’s exact diff;
   - real cleanup retry for completion and interruption;
   - durable record retained until actual removal;
   - repeated finalization;
   - exact `bun run check`;
   - full Docker suite;
   - no suite-owned containers afterward.
2. **If approved, land it.** Do not reject or abandon otherwise-sound work merely because it required nine Tickets.
3. **If the same cleanup invariant still fails, stop the Change.** Reject or abandon and replan rather than issue a tenth implementation cycle.
4. **Do not start Change 003 until this retrospective’s workflow decisions are accepted.**

### Next Goal

1. Add structured worker completion paths for `completed`, `partial`, and `blocked`.
2. Require implementation completion to map Ticket stop conditions to executable evidence; known unmet required work must reject `completed`.
3. Make churn indicators independent of planned Ticket count; expose planned counts through planner/CLI.
4. Support an explicitly planned implementation continuation from the current Candidate without a synthetic review. Final exact review remains mandatory before landing.
5. Add first-class step-specific Markdown guidance.
6. Make external cleanup postconditions part of every adapter contract.
7. Add marker-backed planner wake-up as an operational notification.

### Later

- Record model usage, duration, cost, outcome, and churn before changing routing policy.
- Add adapter-owned orphan-resource health checks where deterministic identities make them safe.
- Consider candidate-bearing `partial` implementation Reports only if loss of useful blocked work is repeatedly observed. Do not add this complexity preemptively.

## 6. Markdown workflow guidance

Each document should be short, operational, and state what makes the step complete.

- **Goal:** approved outcome, constraints, evidence expected, and how to split independently safe Changes.
- **Plan:** structured planned Ticket count, current focus, planned continuations/reviews, stop conditions, decisions, and churn gate.
- **Change:** one safe landable commit; observable criteria; explicit non-goals; avoid architectural adjectives without executable evidence.
- **Implement:** bounded instruction, exact starting revision, required commands/postconditions, evidence per stop condition, and outcome selection rules.
- **Review:** assess canonical criteria only; blockers must identify a criterion, regression, or evidence/security invariant with concrete reproduction. Optional hardening is non-blocking.
- **Remediate:** address an explicit accepted finding set; preserve stable IDs; no new architecture unless required to close those findings.
- **Decide:** verify current Candidate, exact review, cleanup health, and Change base; then land, reject, or abandon explicitly.
- **Recover:** reconstruct only from durable facts, clean operational resources, publish interruption evidence, and never issue replacement work automatically.

Global principles:

- `completed` means the Ticket’s bounded instruction is complete.
- A limitation that contradicts a required stop condition forbids `completed`.
- Two recurrences of the same material finding trigger operator/design review.
- Verification includes resource postconditions, not only passing command output.
- Planner prose and operational markers remain non-authoritative.

## 7. Prompt discipline

### Implementation prompts

- Replace “implement the Change completely” with one bounded deliverable.
- List exact required verification and external postconditions.
- Require evidence for each Ticket stop condition.
- State: “If any required condition remains unmet, submit `partial` or `blocked`; do not place it only under Limitations or Follow-up.”
- Do not prescribe broad architecture unless a canonical criterion demands it.
- After one remediation, narrow the next Ticket to accepted findings only.

### Review prompts

- Review the exact Candidate against canonical criteria once.
- Every blocking finding must include:
  1. affected criterion or invariant;
  2. concrete code/evidence;
  3. reproduction or deterministic reasoning;
  4. smallest required remediation.
- Reuse stable finding IDs when the same defect recurs.
- Label optional hardening as non-blocking.
- Do not require deferred work or idealized extension points.
- Do not issue a review whose verdict is predetermined solely to authorize planned implementation continuation.

### Model policy

**Fact:** all implementation Tickets used Terra/medium; later bounded Tickets succeeded with that same policy.  
**Inference:** model policy was secondary to scope and outcome tooling.  
**Hypothesis:** high thinking might help the first architecture/lifecycle Ticket, but usage and duration data should be collected before adding automatic escalation.

## 8. Recommendation for Change 002

**Final review, then land if approved.**

Durable evidence says Candidate `b2a9755…` is a narrow response to the sole remaining concrete finding. Ticket 009 reports exact default and Docker suites passing, real adapter cleanup, repeated-finalization assertions, and zero residual suite containers. Cleanup is currently healthy.

It cannot land yet because no review approves that exact hash. Rejection or abandonment now would be disproportionate. The final review should not reopen image, credential, networking, real-Pi, or general architecture questions unless it demonstrates a regression.

## 9. Exact `doc/goals.md` backlog changes

### Revise existing watcher entry

- Wake the planner once when an open Ticket reaches marker-backed `done`. Emit an idempotent operational recheck notification keyed by full Ticket identity; on wake the planner must call `spike_status` and explicitly publish the Report. The marker, notification, Herdr state, terminal output, and process exit never become workflow evidence.

### Revise existing guidance entry

- Make workflow guidance first-class Markdown selected for Goal, Plan, Change, Implement, Review, Remediate, Decide, and Recover. State executable completion conditions, outcome semantics, blocker discipline, churn stop rules, evidence requirements, and cleanup postconditions; inject planner guidance explicitly and snapshot worker guidance into immutable Ticket context.

### Add

- Make churn projection independent of optional planned Ticket counts. Always surface remediation-round, reopened-finding, and consecutive non-progress warnings; expose structured planned Ticket counts through planner and CLI so ticket-count variance is also deterministic.
- Give workers structured `completed`, `partial`, and `blocked` completion paths. Reject completed implementation evidence when declared limitations or criterion assessments identify unmet Ticket stop conditions; keep non-completed Reports candidate-free initially.
- Support an explicitly planned sequential implementation Ticket from the current Candidate without requiring a synthetic intermediate review. Preserve exact Candidate provenance and require a fresh exact review before landing.
- Strengthen Worker adapter contracts with executable external postconditions: real resource absence after successful cleanup, durable retry state after failure, repeated-finalization idempotence, and full-suite residual-resource checks.
- Record model usage, duration, cost, terminal outcome, and remediation count with Report provenance so future model/thinking escalation is based on observed convergence rather than anecdote.