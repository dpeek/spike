# Proposal: Goal, Change, Ticket, and Report Workflow

Status: Draft for review

## Summary

Spike should replace its current ticket-centric workflow with a smaller model built around four durable concepts:

- **Goal** — the high- or low-level outcome the operator wants.
- **Change** — one coherent integration unit that will land as one commit.
- **Ticket** — one bounded assignment executed in one fresh worker session.
- **Report** — the structured result returned by that worker to the planner.

A planner-owned **Plan** provides working memory: the intended Change sequence, current direction, progress, decisions, open findings, and churn indicators. The Plan is intentionally revisable. Tickets and Reports are immutable history.

The normal loop becomes:

```text
Goal
  Plan
    Change
      implementation Ticket -> evidence Report
      review Ticket         -> feedback Report
      remediation Ticket    -> evidence Report
      review Ticket         -> approved Report
    Change lands as one commit
```

This model preserves durable evidence, resumability, exact Git provenance, and independent review while deleting same-run remediation, report supersession, persistent conversational dependency, and most cross-transition locking.

## Motivation

Spike has accumulated strong local durability and provenance guarantees, but it currently conflates several different concerns:

- a Ticket is both planner intent and an integration unit;
- a Run is both a worker session and the continuation mechanism for remediation;
- the first completion Report becomes immutable before review is complete;
- remediation therefore requires report supersession and delivery provenance;
- review findings discovered after publication require another durable correction mechanism;
- planner transitions attempt to coordinate through a graph of filesystem locks;
- stale-lock recovery depends on process identity and platform-specific behavior;
- partial implementations sometimes have to be accepted merely to issue their correction.

The result is durable but difficult to reason about. Interruption safety has expanded into transparent recovery of arbitrary concurrent transitions, despite the intended workflow already having one planner, one active Goal, and serial integration.

The proposed model keeps durable facts and removes unnecessary coordination capability.

## Design principles

### Durable evidence is not planner working memory

Spike should distinguish two categories of state.

#### Authoritative evidence

Authoritative evidence is immutable and append-only:

- approved Goal;
- landed Change;
- Ticket assignment;
- Report;
- exact candidate revision;
- publication or candidate bundle;
- approval or rejection decision;
- worker retirement evidence.

These records prove what was requested, produced, reviewed, and landed.

#### Planner notebook

The Plan and per-Change summaries are planner-owned working memory. They are:

- atomically editable;
- compactable;
- allowed to evolve;
- reconstructable from authoritative evidence;
- not proof of approval or completion.

Working memory should not require evidence-grade locking, immutable history for every edit, or copied provenance from authoritative records.

### Fresh context by default

Every Ticket starts a fresh worker session. A session is not reused for later implementation, review, or remediation Tickets.

This makes context packaging an explicit part of the product and avoids:

- conversational drift;
- hidden assumptions retained only by one worker;
- review anchored to implementation reasoning;
- recovery depending on a Herdr conversation;
- accumulating inactive worker tabs and resources.

A worker may remain alive briefly while its Report is validated or corrected administratively. Once the Report is accepted into Change history, the worker is stopped and finalized.

Session reuse is a future optimization only if measured evidence shows fresh sessions are materially wasteful.

### One planner writer

Initially, Spike supports one planner process mutating workflow state for a repository.

Workers write only through their assigned output paths. The planner imports those outputs and performs workflow transitions serially.

Spike does not initially guarantee safe concurrent planner CLI mutation. This explicit capability cut removes the need for lock ordering across activation, issuance, remediation, publication, acceptance, completion, and cleanup.

### Recovery rewinds rather than resumes

Spike never resumes an interrupted worker session or attempts to recover work in progress. Recovery means:

1. identify the latest committed workflow state;
2. stop and remove any recorded worker processes, containers, aliases, tabs, volumes, and networks left by later incomplete work;
3. ignore or quarantine uncommitted output and partial projections;
4. start a fresh Ticket and fresh worker session from the latest committed Candidate.

Some rework is acceptable. A simple, deterministic restart is preferable to preserving uncertain session state.

Spike must not infer recoverability from PID liveness, process birth time, terminal output, or conversational state. It does not automatically replay ambiguous prompts or external effects. If cleanup is incomplete, workflow recovery still rewinds to the committed Candidate and surfaces cleanup as a separate retryable health problem.

## Domain model

## Goal

A Goal describes the operator-approved outcome and constraints.

A Goal owns:

- stable Goal ID;
- approved Goal document;
- operator approval statement;
- repository identity and initial revision;
- current integrated revision;
- Plan;
- ordered landed Changes;
- open operator decisions.

Only landing a Change advances the Goal's integrated revision.

## Plan

The Plan is the planner's durable notebook for accomplishing the Goal.

It contains:

- current Goal summary;
- ordered planned Change sequence;
- status of each Change;
- dependencies between Changes;
- rationale for ordering;
- current focus;
- planned next Tickets;
- progress summary;
- decisions and changed assumptions;
- open findings;
- churn indicators;
- deferred improvements.

The Plan may be rewritten atomically as understanding changes. It should include references to authoritative Ticket and Report IDs where useful, but it must not copy every digest or evidence field.

A compact history of meaningful Plan revisions may be retained, but this is diagnostic history rather than workflow authority.

## Change

A Change is one coherent unit that will land as exactly one commit.

A Change owns:

- stable Change ID;
- Goal ID;
- title and intent;
- rationale;
- acceptance criteria;
- non-goals;
- dependencies;
- exact base revision;
- planned Ticket sequence;
- actual Ticket history;
- immutable candidate versions;
- current candidate;
- current Change summary;
- approval or rejection decision;
- landed commit, when complete.

A Change exists before its first candidate commit, so its identity cannot be a commit hash.

### Change states

```text
draft
  -> implementing
  -> reviewing
  -> implementing
  -> approved
  -> landed

Any non-landed state may become rejected or abandoned by explicit planner decision.
```

The state is derived from authoritative Tickets and Reports plus the current planner decision. It should not require a separate complex state machine record when the facts already determine it.

## Candidate

A Candidate is an exact Git version of a Change.

Each Candidate is one commit whose:

- parent is the Change base revision;
- tree is the complete proposed product tree for the Change;
- message is the proposed landed commit message;
- trailers contain stable Goal and Change IDs.

Example commit message:

```text
Simplify durable workflow transitions

Replace same-run remediation with fresh ticket/report rounds while
preserving exact candidate review and interruption evidence.

Spike-Goal-Id: goal-...
Spike-Change-Id: change-...
```

Commit messages may store durable, human-facing Change information:

- summary;
- rationale;
- stable Goal and Change IDs;
- permanent decisions;
- contributor trailers.

Commit messages must not store:

- planner working memory;
- planned future Changes;
- mutable progress;
- review history;
- test logs;
- artifacts;
- workflow status.

### Candidate identity

The Change ID is stable across the entire Change. A commit hash identifies one exact Candidate version.

Candidates are retained under immutable refs:

```text
refs/spike/changes/<change-id>/candidates/001
refs/spike/changes/<change-id>/candidates/002
```

A mutable pointer identifies the current Candidate:

```text
refs/spike/changes/<change-id>/current
```

Reports always reference exact commit hashes, never only the moving pointer.

### Candidate normalization

Workers should not be required to maintain a single amended commit correctly during implementation. They may create whatever local commits help them work.

After importing an implementation or remediation Report at revision `R`, Spike creates a normalized Candidate commit using Git plumbing:

```text
parent  = Change base revision
tree    = tree of R
message = current proposed Change commit message
```

The resulting commit is retained as the next immutable Candidate version. This allows fresh workers to begin from one clean Candidate while preserving the worker's reported revision as evidence.

## Ticket

A Ticket is one bounded planner assignment performed by one fresh worker session.

A Ticket owns:

- stable Ticket ID;
- Goal ID;
- Change ID;
- role;
- intended outcome;
- exact input Candidate or base revision;
- curated context snapshot;
- worker/session correlation;
- resulting Report ID;
- terminal status.

Ticket roles initially include:

- `implement`;
- `review`;
- `remediate`;
- `investigate`;
- `verify`.

Roles describe intent and context packaging. They should not introduce separate transition machinery.

### Ticket context

Each Ticket automatically packages:

1. stable Goal summary;
2. current Change brief and acceptance criteria;
3. planner's current Change summary;
4. specific Ticket instruction;
5. exact starting revision;
6. relevant prior Reports;
7. unresolved findings;
8. decisions, constraints, assumptions, and non-goals.

The planner selects relevant Reports rather than passing an unbounded history to every worker.

### Ticket lifecycle

```text
issued -> running -> reported
                  -> failed
                  -> stopped
```

A reported Ticket does not advance the Goal's integrated revision. An implementation or remediation Report may produce a new Change Candidate. A review Report may request another Ticket, approve a Candidate, or reject the Change.

A worker session is stopped and finalized after its Report is validated and incorporated into Change history.

## Report

A Report is the structured response from one Ticket to the planner.

Reports are immutable, append-only, and host-owned in their identity and provenance fields.

### Report kinds

#### Evidence Report

Typically returned by `implement`, `remediate`, or `verify` Tickets.

Worker-authored fields include:

- outcome;
- summary;
- verification results;
- artifacts;
- assumptions;
- limitations;
- risks;
- recommended follow-up.

Spike supplies:

- Goal, Change, Ticket, and worker identity;
- input revision;
- resulting revision;
- timestamps;
- candidate relationship;
- Git evidence;
- artifact paths and digests.

#### Feedback Report

Typically returned by a `review` Ticket.

It includes:

- exact Candidate and Evidence Report reviewed;
- findings with stable finding IDs;
- severity;
- actionable feedback;
- acceptance-criteria assessment;
- recommendation: remediate, approve, reject, or ask operator.

#### Approval Report

An approval is a review result that selects:

- exact Candidate hash;
- exact Evidence Report;
- satisfied acceptance criteria;
- review statement;
- reviewer identity.

Approval alone does not land the Change. Landing remains an explicit planner transition.

### No report supersession

Reports are never amended or superseded. A later Ticket produces a later Report.

Example:

```text
Ticket 1 implement  -> Report 1 evidence at Candidate A
Ticket 2 review     -> Report 2 feedback on Candidate A
Ticket 3 remediate  -> Report 3 evidence at Candidate B
Ticket 4 review     -> Report 4 approval of Candidate B
```

This removes schema-versioned supersession and remediation-specific provenance.

## Normal workflow

## Goal planning

1. Operator approves Goal.
2. Planner creates or updates Plan.
3. Planner identifies the first Change.
4. Planner records the intended Change sequence and rationale.

## Implementation

1. Planner creates Change at current integrated revision.
2. Planner issues an `implement` Ticket.
3. Spike launches a fresh worker at the exact Change base or current Candidate.
4. Worker implements and returns Evidence Report.
5. Spike validates the Report and worker Git evidence.
6. Spike normalizes the worker tree into Candidate A.
7. Planner updates the Change summary and finalizes the worker.

## Review

1. Planner issues a fresh `review` Ticket for Candidate A.
2. Reviewer receives Goal, Change, acceptance criteria, Evidence Report, and exact Candidate.
3. Reviewer returns Feedback or Approval Report.
4. Planner records findings and finalizes the reviewer.

## Remediation

1. Planner creates a `remediate` Ticket from Candidate A.
2. A fresh implementer receives relevant feedback and Change context.
3. Worker returns Evidence Report at revision R.
4. Spike normalizes R into Candidate B with the same Change base.
5. Another fresh review Ticket evaluates Candidate B.

Remediation is ordinary Ticket creation. It has no delivery state machine, same-session requirement, report amendment, or special lock.

## Landing

1. Planner verifies an Approval Report selecting the current Candidate.
2. Planner verifies the Change base still matches the Goal's integrated revision.
3. Planner records an immutable landing decision.
4. The approved Candidate becomes the landed Change commit.
5. Goal integrated revision advances to that commit.
6. Planner updates the Plan and selects the next Change.

If the integrated revision moved, Spike must explicitly rebase or recreate the Candidate and require review of the new hash. It must not silently land an unreviewed rewrite.

## Rejection and abandonment

A review may reject a Candidate or the entire Change.

- Rejecting a Candidate keeps it as evidence and permits another Ticket.
- Rejecting a Change closes it without advancing the Goal integrated revision.
- Abandonment is an explicit planner decision with a statement.
- Rejected and abandoned work remains inspectable.

Unlike the current model, a poor Ticket never has to be accepted merely to unblock subsequent work.

## Churn detection

The planner needs enough Change history to detect non-convergence.

Initial deterministic indicators should include:

- actual Ticket count materially exceeds planned Ticket count;
- review/remediation rounds exceed a threshold;
- the same finding ID is reopened;
- consecutive `partial` or `blocked` Evidence Reports;
- acceptance criteria repeatedly change;
- the Change summary repeatedly reverses the same decision;
- multiple Candidates show no progress against open findings.

Initial thresholds should be simple and configurable. For example:

```text
Change churn detected

- planned tickets: 3
- actual tickets: 8
- remediation rounds: 3
- finding concurrency-001 reopened twice

Recommendation: pause implementation and review the Change design with the operator.
```

Churn detection produces planner guidance, not automatic rejection. The planner may:

- refine Ticket context;
- split the Change;
- revise acceptance criteria;
- request operator input;
- reject or abandon the Change;
- continue with an explicit rationale.

Semantic diff oscillation and automated design judgment are non-goals initially.

## Interruption and recovery

## Committed workflow state

Only a small set of immutable records advance authoritative workflow state:

- a Ticket record commits the assignment, but not any worker progress;
- a Ticket Result commits a validated Report and, for implementation work, its normalized Candidate;
- an Approval Report commits review approval of an exact Candidate;
- a landing record commits the Change to the Goal's integrated history.

Worker output, temporary Reports, candidate objects, candidate refs, mutable pointers, and planner summaries prepared before the relevant commit record are staging or projections. They do not advance workflow state by themselves.

For an implementation or remediation Ticket, Spike prepares and validates the Report and normalized Candidate first, then installs one immutable Ticket Result referencing both. The Ticket Result is the commit point. Git objects or refs left without a Ticket Result are uncommitted debris and may be retained for diagnosis or cleaned up.

## Rewind policy

On planner or supervisor restart:

1. load the latest valid Goal, landed Change, current Change, and committed Ticket Results;
2. derive the latest committed Candidate from those Results;
3. classify every issued Ticket without a committed Result as interrupted;
4. stop and finalize all worker resources correlated with interrupted Tickets;
5. ignore or quarantine their staged output;
6. issue a fresh replacement Ticket from the latest committed Candidate when the Plan still calls for that work.

Spike never reconnects to an interrupted session, resumes its conversation, imports its uncommitted output automatically, or retries an ambiguous prompt. The replacement Ticket may repeat work.

Cleanup is idempotent and independent from workflow progress. A failed container, tab, volume, network, or alias removal produces a visible health warning and can be retried, but does not make interrupted worker output authoritative.

## Locking

The initial workflow assumes one planner writer and does not support concurrent planner mutation.

Retain narrow coordination only where independent processes genuinely race:

- runtime stop versus runtime exit recording;
- Herdr workspace placement.

Do not add per-transition PID/start-time locks for Goal, Change, Ticket, Report, Candidate, review, or landing operations. Do not add automatic stale-lock recovery for planner work.

If concurrent planner mutation becomes a demonstrated requirement, design it later against this simpler model.

## Worker lifecycle and Herdr

Persistent Herdr is the only initial delegated worker backend.

For each Ticket:

1. create a fresh worker session and clone;
2. run the Ticket;
3. import and validate its Report;
4. retain the worker only for immediate administrative Report correction;
5. stop and finalize it;
6. close its Herdr tab and release runtime resources.

The Herdr Agents panel indexes active sessions. One tab per active worker is acceptable because terminal workers are finalized promptly.

Detached/headless free-form delegation and session reuse are non-goals for the initial model.

## Model configuration

Project configuration should distinguish planner and worker roles:

```json
{
  "models": {
    "planner": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "high"
    },
    "ticketWorker": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "medium"
    }
  }
}
```

Ticket workers never inherit the planner model implicitly. Explicit Ticket-level overrides remain one-session overrides and are retained as Ticket provenance.

## Proposed durable layout

This is illustrative rather than final:

```text
.spike/
  goals/
    <goal-id>/
      goal.md
      goal.v1.json
      plan.md
      plan.v1.json
      changes/
        <change-id>/
          change.md
          change.v1.json
          summary.md
          candidates/
            001.v1.json
            002.v1.json
          tickets/
            <ticket-id>/
              ticket.md
              ticket.v1.json
              report.v1.json
          approval.v1.json
          landing.v1.json
  output/
    goals/<goal-id>/changes/<change-id>/tickets/<ticket-id>/
      ticket.md
      context.md
      report-input.json
    artifacts/<ticket-id>/
```

Git remains authoritative for Candidate trees and commit objects. Durable records retain stable IDs, exact refs, hashes, and decisions.

## Module direction

The production implementation should concentrate behavior behind a few deep modules.

### Plan module

Owns planner notebook loading, atomic update, compact Change summaries, and churn indicators.

### Change module

Owns Change creation, Candidate progression, approval, rejection, abandonment, and landing invariants.

### Ticket module

Owns immutable Ticket context, fresh-session assignment, status, and Report correlation.

### Report module

Owns canonical host-generated Reports, worker-authored evidence input, review findings, and strict validation.

### Git Change module

Owns Candidate normalization, immutable refs, current Candidate pointer, commit messages, and landing.

### Worker module

Owns fresh worker launch, exact revision setup, status, stop, finalization eligibility, and cleanup.

### Durable-state module

Owns concrete shared filesystem behavior only:

- bounded JSON reads;
- canonical timestamps, IDs, and digests;
- project-relative path resolution;
- component symlink rejection;
- immutable file installation;
- atomic pointer replacement.

Record validators remain with their owning modules. Avoid creating a broad abstract repository interface.

## Implementation strategy

## Phase 1: Model prototype

Build a disposable Bun terminal prototype using a temporary Git repository.

The prototype should demonstrate:

- Goal and Plan creation;
- Change creation;
- implementation Ticket and Evidence Report;
- Candidate normalization;
- review Ticket and Feedback Report;
- remediation Ticket from current Candidate;
- Approval Report;
- one-commit landing;
- failed Ticket;
- rejected Change;
- Plan revision;
- churn warning;
- interruption before and after each immutable commit point.

The prototype should not launch containers or Herdr.

## Phase 2: Production tracer bullet

Implement one complete vertical workflow:

```text
change create
  -> ticket issue
  -> ticket dispatch
  -> report import
  -> candidate record
  -> review ticket
  -> change approve
  -> change land
```

Do not implement session reuse, concurrent Changes, semantic churn analysis, or multiple backends.

## Phase 3: One-way migration

Do not dual-write the current and proposed models.

- Store all new durable workflow state under `.spike/`.
- Preserve existing `.pi-swarm/` v1 state as read-only legacy evidence.
- Keep Ticket 022 unaccepted.
- Record a migration receipt under `.spike/` explaining that the unresolved v1 Ticket was superseded by the workflow migration.
- Seed the new Goal from the current integrated revision.
- Seed the Plan with remaining model-configuration, cleanup, smoke-test, and Goal-completion Changes.
- Switch commands to the new model only after tracer-bullet verification.

Historical v1 records do not need to be rewritten into every new concept. They remain inspectable through legacy status/history commands or an archived snapshot.

## Phase 4: Delete replaced capability

Once the new tracer bullet and migration pass:

- delete same-run remediation;
- delete report supersession;
- delete remediation delivery state;
- delete remediation PID/start-time lock recovery;
- delete cross-transition lock ordering;
- simplify Goal completion to one immutable marker;
- delete mutable completed-history advancement and recovery;
- delete headless supervisor delegation;
- delete recursive CLI orchestration;
- consolidate duplicated durable-state primitives;
- shrink CLI to parsing and presentation.

The migrated implementation should be materially smaller than the code it replaces.

## Testing strategy

Tests should exercise the same deep module interfaces used by production callers.

Prioritize scenario tests:

1. implement -> review -> approve -> land;
2. implement -> review -> remediate -> approve -> land;
3. failed Ticket -> replacement Ticket;
4. rejected Change;
5. crash around each immutable commit point;
6. stale mutable projections rebuilt from immutable facts;
7. fresh worker context contains all required information;
8. worker finalization preserves Reports, Candidates, and artifacts;
9. churn warning after repeated feedback;
10. dirty host checkout remains untouched.

Avoid tests for unsupported arbitrary concurrent planner mutation. Retain focused tests for genuine runtime stop/exit and Herdr placement races.

## Success criteria

The proposal succeeds when:

- one Goal can execute an evolving ordered Plan of Changes;
- each Change lands as exactly one reviewed commit;
- multiple fresh-session Tickets can contribute to one Change;
- Reports provide sufficient context for planner recovery and fresh workers;
- review and remediation require no same-session continuation;
- planner can detect and surface obvious churn;
- interruption rewinds to the latest committed Candidate, abandons in-progress sessions, and cleans their resources without PID-based workflow locks;
- terminal workers are finalized promptly;
- model defaults are project-configured;
- current v1 evidence remains inspectable;
- the production implementation is smaller and easier to navigate than the workflow it replaces.

## Open decisions

The following should be resolved during review of this proposal:

- whether the Plan is Markdown with small JSON metadata, JSON with rendered Markdown, or both;
- whether review, approval, and feedback share one Report schema with a discriminated kind;
- how candidate commit authorship and contributor trailers are assigned;
- whether landing updates `main` directly or advances a dedicated integration ref for explicit operator application;
- exact churn thresholds;
- whether rejected Changes may later be reopened;
- how much legacy v1 history remains queryable through normal CLI commands;
- whether multiple active Changes should ever be supported.
