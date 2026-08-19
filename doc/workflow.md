# Goal, Change, Ticket, and Report Workflow

Status: Active implementation

## Summary

Spike should replace its current ticket-centric workflow with a smaller model built around four durable concepts:

- **Goal** — the high- or low-level outcome the operator wants.
- **Change** — one coherent integration unit that will land as one commit.
- **Ticket** — one bounded assignment executed in one fresh worker session.
- **Report** — the canonical, host-published record of one Ticket's accepted outcome.

A **Project** is one Git repository configured by tracked `spike.json`. It has an operator-chosen stable slug, owns its Goals, and provides their sequence scope. A planner-owned **Plan** provides working memory: the next Change direction, tentative later ideas, progress, decisions, open findings, and churn indicators. The Plan is intentionally revisable. Tickets and Reports are immutable history. Workers write staging Submissions; Spike validates them and publishes canonical Reports.

The normal loop becomes:

```text
Goal
  Plan
    Change
      implementation Ticket -> Report with Candidate A
      review Ticket         -> Report: remediate
      implementation Ticket -> Report with Candidate B
      review Ticket         -> Report: approve
    Change lands as one commit
```

This model preserves durable evidence, resumability, exact Git provenance, and independent review with a small sequential workflow.

## Motivation

Spike needs a workflow that remains understandable across fresh planner and worker sessions while preserving exact evidence of what was requested, produced, reviewed, and landed.

The model separates five concerns:

- a Goal records the approved outcome;
- a Plan holds mutable planner working memory;
- a Change defines one integration unit;
- a Ticket assigns one bounded worker session;
- a Report records that Ticket's canonical outcome.

One planner, sequential Changes and Tickets, immutable evidence, and derived status make interruption recovery deterministic without requiring general concurrent transition coordination.

## Design principles

### Durable evidence is not planner working memory

Spike should distinguish two categories of state.

#### Authoritative evidence

Authoritative evidence is immutable and append-only:

- approved Goal;
- landed Change;
- Ticket assignment;
- published Report;
- exact proposed revision and its Git provenance;
- review approval or rejection decision;
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

### One durable document format

All durable workflow artefacts are Markdown documents with JSON frontmatter. This includes Goals, Plans, Changes, Tickets, Reports, and Change decisions. Review approval is represented by a published Report, not a separate document.

Machine-readable identity, relationships, state, revisions, timestamps, and digests live in the JSON frontmatter. Human-facing intent, rationale, findings, decisions, and summaries live in the Markdown body. For example:

```md
---
{
  "kind": "ticket",
  "goalId": "spike-001",
  "changeId": "001",
  "ticketId": "001"
}
---

# Implement candidate normalization

Create one normalized Candidate from the worker's reported tree.
```

Frontmatter metadata has no schema version initially. A `version` field and explicit migration should be introduced only when an incompatible format change requires one; filenames must not encode a speculative version.

Git objects remain the authority for proposed source trees. Reports are authoritative for how those revisions entered the workflow; Git refs are retention indexes derived from Reports. Report attachments may retain their native formats and are referenced, hashed payloads rather than workflow documents.

### Fresh context by default

Every Ticket starts a fresh worker session. A session is not reused for later implementation or review Tickets.

This makes context packaging an explicit part of the product and avoids:

- conversational drift;
- hidden assumptions retained only by one worker;
- review anchored to implementation reasoning;
- recovery depending on a live worker conversation;
- accumulating inactive worker tabs and resources.

A worker may remain alive briefly while its Submission is validated or corrected administratively. Once Spike publishes the corresponding Report into Change history, the worker is stopped and finalized.

In the host-local tracer bullet, Herdr may host each fresh worker session so the operator and planner can observe, read, or attach to its terminal while the Ticket runs. Herdr attachment is an operational observation surface, not permission to continue the worker into another Ticket or to treat terminal output as workflow evidence. Planner-to-worker follow-up and session reuse remain future optimizations only if measured evidence justifies them.

### Worker exchange is runtime-independent

The Worker module has one real seam: a host-local clone adapter proves the workflow first, and a Docker adapter later provides process isolation without changing Ticket, Submission, Report, or Git provenance semantics.

The adapters share one filesystem exchange contract:

1. Spike prepares a read-only input directory containing `ticket.md`, `context.md`, and `repository.bundle` at the Ticket's exact input revision.
2. The adapter creates a private checkout from that bundle and starts the worker there.
3. The worker writes only to its assigned output directory: `submission.md`, an output `repository.bundle` for a completed `implement` Ticket, and declared artifacts.
4. Spike imports the output bundle into a quarantine ref, verifies that it contains the submitted `workerRevision`, validates the Submission and artifact digests, and only then normalizes a Candidate.
5. Spike never publishes a Report by inspecting an unreported live checkout. The exchange output must contain everything required for publication after the worker stops.

Local paths, process IDs, container IDs, Herdr agent/tab/pane IDs, and adapter-specific cleanup details are operational projections, not workflow facts. A staging worker record correlates opaque runtime handles with the Ticket's full nested identity so stop and cleanup can be retried. Durable Ticket and Report formats remain adapter-independent.

The exchange importer treats all worker output as untrusted. It accepts only declared regular files, rejects symlinks, unexpected paths and path traversal, applies explicit size limits, verifies artifact digests, and validates Git bundles before importing them.

Ticket execution policy describes required capabilities rather than selecting an adapter. Credential grants contain identifiers, never secret values; the selected adapter resolves them at launch. An adapter must refuse a Ticket whose isolation, network, or credential policy it cannot satisfy.

The local-clone adapter provides workspace separation only and may run controlled, attended workers. It is not security isolation. While the direct supervisor owns the live process handle, stopping waits for graceful exit and escalates to forced termination before finalization. After supervisor restart, the adapter never signals a persisted PID because PID identity is unsafe; it publishes interruption evidence and surfaces orphan cleanup as a health warning. Durable cross-restart session reclamation belongs to Herdr. Autonomous workers must use the Docker adapter before Spike is used against valuable repositories.

### Sequential work and nested identity

Initially, Spike supports one planner process mutating workflow state for a Project repository. A Goal has at most one active Change, and a Change has at most one active Ticket. Workers write only through their assigned output paths; the planner imports those outputs and performs workflow transitions serially.

Goal, Change, and Ticket IDs reflect this ordering:

- Goal IDs combine the stable Project slug and a zero-padded decimal sequence, such as `spike-001`, allocated monotonically within one Project.
- Goal sequences are never reused, including directories left by interrupted publication.
- Change IDs are zero-padded decimal sequences such as `001`, allocated monotonically within one Goal.
- Ticket IDs are zero-padded decimal sequences such as `001`, allocated monotonically within one Change.
- IDs are never reused, including after rejection, abandonment, failure, or interruption.
- A Change ID is unique only within its Goal; a Ticket ID is unique only within its Change. Durable references therefore include their parent IDs or use a parent-relative path.

Spike does not initially guarantee safe concurrent planner CLI mutation. This explicit capability cut removes the need for lock ordering across activation, issuance, publication, acceptance, completion, and cleanup.

### Recovery rewinds rather than resumes

Spike never resumes an interrupted worker session or attempts to recover work in progress. Recovery means:

1. identify the latest committed workflow state;
2. ask the recorded Worker adapter to stop and remove any runtime resources left by later incomplete work;
3. ignore or quarantine uncommitted output and partial projections;
4. start a fresh Ticket and fresh worker session from the latest committed Candidate.

Some rework is acceptable. A simple, deterministic restart is preferable to preserving uncertain session state.

Spike must not infer recoverability from PID liveness, process birth time, terminal output, or conversational state. It does not automatically replay ambiguous prompts or external effects. If cleanup is incomplete, workflow recovery still rewinds to the committed Candidate and surfaces cleanup as a separate retryable health problem.

## Domain model

## Project

A Project is one Git repository configured for Spike by tracked `spike.json`. Its required lowercase kebab-case slug is operator-chosen rather than inferred from a checkout directory or Git remote. The slug is stable after the first Goal allocation and is the human-facing namespace for that Project's Goals. Project slugs are expected to be unique within a future shared control plane; discovery and central registration are deferred.

The Project owns Goal sequence allocation. While workflow authority is repository-local, allocation scans all matching `.spike/goals/<goal-id>/` directories, including unpublished staging directories, and selects the next three-digit sequence. The existing single-planner-writer constraint applies. A future central Spike store may take over this allocation without changing Goal IDs.

Project configuration is not another workflow evidence document. Today its complete identity definition is the tracked configuration entry:

```json
{
  "project": {
    "slug": "spike"
  }
}
```

## Goal

A Goal describes the operator-approved outcome and constraints.

A Goal owns:

- stable Project-qualified Goal ID such as `spike-001`;
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
- next Change direction;
- tentative later Change ideas and dependencies;
- rationale for the current ordering;
- current focus and next Ticket;
- progress summary;
- decisions and changed assumptions;
- open findings;
- churn indicators;
- deferred improvements.

The planner selects the next independently safe Change from the Goal's current integrated revision and accumulated evidence. It does not need to decompose the whole Goal upfront, and later Change ideas remain tentative.

The Plan may be rewritten atomically as understanding changes. It owns all mutable Change summaries and tentative direction. It should reference authoritative Tickets where useful, but it must not copy every digest or evidence field.

## Change

A Change is one coherent unit that will land as exactly one commit.

A Change owns:

- Goal-relative Change ID such as `001`;
- Goal ID;
- title and intent;
- rationale;
- acceptance criteria;
- non-goals;
- dependencies;
- exact base revision;
- authoritative Ticket and Report history;
- current candidate revision and review verdict, derived from that history;
- terminal Change decision, when resolved.

Acceptance criteria are distinct, canonical single-line assertions. Review Reports identify and assess them by their exact text, so blank, multiline, or duplicate criteria are invalid.

A Change must be small enough for one fresh implementer to satisfy every criterion and verify its external postconditions in one session. The initial implementation Ticket covers the complete Change. Later implementation Tickets are retries or remediation of review findings, not planned delivery tranches. If several implementation sessions are predictably necessary, the planner splits the work into smaller Changes before issuance.

The full identity of a Change is its Goal ID plus Change ID. A Change exists before its first candidate commit, so its identity cannot be a commit hash.

### Derived status and terminal decision

Spike does not persist a Change state enum or transition graph. It derives status for presentation from the latest candidate-producing Ticket, the review verdict for that exact revision, any active runtime Ticket, and the terminal Change decision.

One immutable `decision.md` resolves a Change with a disposition of `land`, `reject`, or `abandon`. A terminal decision is permitted only when every issued Ticket has a published Report. A landing decision records the exact approved commit and advances the Goal's integrated revision. Rejection and abandonment record a statement without advancing it. To abandon active work, the planner first stops the worker and publishes a `stopped` Ticket Report, then records the `abandon` decision. A resolved Change is never reopened; later work receives the next Change ID.

### Candidate revisions

A Candidate is not a separate durable entity or document. It is the role played by an exact normalized Git commit proposed for the Change. Its identity is its commit hash.

Each Candidate commit has:

- the Change base revision as its parent;
- the complete proposed product tree as its tree;
- the proposed landed commit message;
- stable Goal and Change IDs in its trailers.

Example commit message:

```text
Simplify durable workflow transitions

Use fresh ticket/report rounds while preserving exact candidate
review and interruption evidence.

Spike-Goal-Id: spike-001
Spike-Change-Id: change-...
```

Commit messages may store durable, human-facing Change information:

- summary;
- rationale;
- stable Goal and Change IDs;
- permanent decisions.

Commit messages must not store:

- planner working memory;
- planned future Changes;
- mutable progress;
- review history;
- test logs;
- artifacts;
- workflow status.

Candidate commits use the operator's configured Git identity for both author and committer. Worker and model identity remain in the Report rather than contributor trailers. The only workflow trailers are the stable Goal and Change IDs.

A completed implementation Report records the Change base revision, Ticket input revision, worker-reported revision, and normalized candidate revision. A completed review Report records the exact candidate revision and implementation Ticket it reviewed. Reports always use exact commit hashes. For example:

```md
---
{
  "kind": "report",
  "goalId": "spike-001",
  "changeId": "001",
  "ticketId": "001",
  "outcome": "completed",
  "baseRevision": "<change-base-hash>",
  "inputRevision": "<ticket-input-hash>",
  "workerRevision": "<worker-reported-hash>",
  "candidateRevision": "<normalized-commit-hash>"
}
---

# Implementation evidence

Implemented candidate normalization and ran the focused tests.
```

Candidate commits are retained under refs keyed by the producing Ticket's full nested identity:

```text
refs/spike/goals/<goal-id>/changes/<change-id>/tickets/<ticket-id>
```

There is no mutable current-Candidate ref. The current Candidate is the `candidateRevision` from the highest-numbered completed implementation Ticket in the Change. Spike passes that exact hash directly to the next worker.

#### Normalization

Workers should not be required to maintain a single amended commit correctly during implementation. They may create whatever local commits help them work.

After importing the output bundle into a quarantine ref and validating a completed implementation Submission at worker revision `R`, Spike creates a normalized Candidate commit using Git plumbing:

```text
parent  = Change base revision
tree    = tree of R
message = current proposed Change commit message
```

Spike then publishes the Report containing both `workerRevision` and `candidateRevision`. Report publication makes the Candidate authoritative. Git objects or refs left without a published Report are staging debris.

## Ticket

A Ticket is one bounded planner assignment performed by one fresh worker session.

A Ticket owns:

- Change-relative Ticket ID such as `001`;
- Goal ID and Change ID;
- role;
- intended outcome;
- exact input Candidate or base revision;
- curated context snapshot;
- adapter-independent execution policy for isolation, network access, and credential grants;
- effective model and thinking selection, resolved from the Ticket role default plus any explicit one-Ticket override when the Ticket is issued.

The full identity of a Ticket is its Goal ID, Change ID, and Ticket ID. The Ticket ID is also its sequence within the Change.

Ticket roles initially include:

- `implement`;
- `review`;
- `investigate`.

A remediation is another `implement` Ticket with prior review findings in its context. Verification performed while changing code belongs in implementation evidence; independent verification uses a `review` Ticket. Roles describe intent and context packaging, not separate transition machinery.

### Workflow guidance

Project-owned workflow guidance lives at the fixed tracked paths `spike/guidance/{goal,plan,change,implement,review,remediate,decide,recover}.md`. Guidance is loaded as bounded, non-blank Markdown from a regular Git blob rather than from the mutable worktree. `spike guidance show --step <step>` returns the selected step, path, source revision, and exact Markdown; it requires Goal and Change identity when the selection authority needs them.

Guidance source authority is fixed by step:

- Goal uses repository `HEAD`;
- Plan and Change use the Goal integrated revision;
- Implement, Review, Remediate, and Decide use the Change base;
- Recover uses the active Change base, or the Goal integrated revision when no Change is active.

The supervisor calls `spike_begin_step` immediately before every guided mutation. That tool loads guidance through the Spike CLI before the planner forms mutation arguments and selects one matching Goal, Plan, Change, Implement, Review, Remediate, Decide, or Recover operation. The extension rejects an unselected or mismatched operation and consumes a matching selection on the mutation attempt. Selection is operational in-memory context, is discarded on supervisor restart, and is never durable workflow state.

Supervisor Ticket issuance is split into focused Implement, Review, and Remediate tools. They continue to issue the existing `implement` and `review` Ticket roles: Remediate issues an `implement` Ticket tied to the exact review Report it addresses. The supervisor can also create a Goal only with the operator's explicit approval statement. Raw operator CLI commands remain available without supervisor selection gating.

Worker guidance is selected when a Ticket is issued: an initial implementation Ticket selects Implement, a review Ticket selects Review, and an implementation Ticket responding to a review selects Remediate. Worker guidance always comes from the Change base revision. A Candidate therefore cannot alter the instructions used to review or remediate itself. The Ticket frontmatter records the selected step and source revision, and the exact Markdown is embedded in the immutable Ticket body before exchange preparation. Later guidance edits cannot change an issued or replacement Ticket. Once a guidance Change lands, later Changes based on the advanced Goal integration revision use the new guidance.

Guidance is operational policy, not workflow evidence and not mutable workflow state. Changes to guidance use the ordinary operator-approved Change and review workflow. Spike does not rewrite guidance automatically or provide fallback guidance layers.

### Ticket context

Each Ticket automatically packages:

1. stable Goal summary;
2. current Change brief and acceptance criteria;
3. planner's current Change summary from the Plan;
4. specific Ticket instruction;
5. exact starting revision;
6. relevant prior Reports;
7. unresolved findings;
8. decisions, constraints, assumptions, and non-goals;
9. execution policy and expected output contract.

The planner selects relevant Reports rather than passing an unbounded history to every worker.

### Ticket lifecycle

The durable lifecycle has one transition:

```text
issued -> reported
```

A Ticket is open while `report.md` is absent and terminal once Spike publishes it. Running, stopping, and cleanup status are operational projections rather than workflow states.

Every issued Ticket eventually receives exactly one Report. Its outcome is `completed`, `partial`, `blocked`, `failed`, `stopped`, or `interrupted`. Spike may publish `failed`, `stopped`, or `interrupted` Reports from host evidence without a worker Submission. A Report does not advance the Goal's integrated revision.

On normal completion, a worker session is stopped and finalized after Spike publishes its Report. For explicit stop or recovery, Spike stops the runtime first and then publishes the host-generated terminal Report.

## Submission and Report

A Submission is the worker-authored, untrusted response to a Ticket. It exists only in staging, may be corrected before Report publication, and does not advance workflow state. A worker may submit `blocked` when a condition outside its control prevents completion, with concrete reason and evidence; that Submission contains no Candidate or review verdict. A terminal host-generated Report does not require a Submission.

A Report is the canonical, host-sealed outcome Spike publishes for one Ticket. Reports are immutable and append-only. A Report has no separate ID: its full identity and path are those of its Ticket. Spike owns its provenance, timestamps, exact revisions, artifact digests, and worker correlation while preserving any accepted worker-authored content.

Every Report records common execution provenance: adapter name, isolation level, worker identity, actual model and thinking selection, start and finish timestamps, and an optional immutable environment digest such as a Docker image digest. Spike verifies that the actual model and thinking selection match the immutable Ticket assignment. Reports do not retain local clone paths, process IDs, container IDs, Herdr handles, or other cleanup details.

Publishing `report.md` is the Ticket's commit point. There is no separate Result artefact.

### Report content by Ticket role

Every Report uses `kind: "report"` and records its terminal `outcome`. The Ticket role determines additional validation:

- A completed `implement` Report records worker-authored summary, verification, assumptions, limitations, risks, follow-up, artifacts, and Git evidence. It also records the Change base, Ticket input, worker, and normalized candidate revisions.
- A completed `review` Report records the exact candidate revision and producing implementation Ticket, findings with stable IDs and severity, acceptance-criteria assessment, review statement, reviewer identity, and verdict: `remediate`, `approve`, `reject`, or `ask-operator`.
- A completed `investigate` Report records findings, evidence, conclusions, remaining uncertainty, and recommended follow-up without producing a candidate revision.
- Non-completed Reports record the available evidence and reason for their terminal outcome. They do not produce a candidate revision or review verdict.

A completed review Report with an `approve` verdict is the approval evidence for that exact candidate revision. There is no separate approval document. Approval does not land the Change; landing remains an explicit planner transition.

### One Report per Ticket

Reports are never amended. A later Ticket produces a later Report.

Example:

```text
Ticket 001 implement -> Report with Candidate A
Ticket 002 review    -> Report on A: remediate
Ticket 003 implement -> Report with Candidate B
Ticket 004 review    -> Report on B: approve
```

Each Report remains a permanent, self-contained record of one Ticket outcome.

## Normal workflow

## Goal planning

1. Operator approves Goal.
2. Planner creates or updates Plan.
3. Planner selects the next independently safe Change from current evidence.
4. Planner records the current direction and rationale while keeping later Change ideas tentative.

## Implementation

1. Planner creates the next sequential Change at the Goal's current integrated revision.
2. Planner issues the next sequential `implement` Ticket.
3. Spike launches a fresh worker at the exact Change base or current Candidate.
4. Worker implements and writes a Submission, output Git bundle, and declared artifacts.
5. Spike imports the bundle into a quarantine ref and validates the submitted revision, evidence, and artifact digests.
6. Spike normalizes the imported worker tree into Candidate A.
7. Spike publishes the Ticket's Report referencing the worker revision and Candidate A. This is the commit point.
8. Planner updates the Change summary in the Plan and finalizes the worker.

## Review

1. Planner issues the next sequential `review` Ticket for Candidate A.
2. Reviewer receives Goal, Change, acceptance criteria, producing implementation Report, and exact Candidate.
3. Reviewer writes a Submission with findings and a verdict.
4. Spike validates the Submission and publishes the Ticket's Report.
5. Planner records findings in the Plan and finalizes the reviewer.

## Remediation

1. Planner issues another `implement` Ticket from Candidate A.
2. A fresh implementer receives relevant review findings and Change context.
3. Worker writes a Submission and output bundle at revision R.
4. Spike imports and validates the bundle, then normalizes R into Candidate B with the same Change base.
5. Spike publishes the Ticket's Report referencing R and Candidate B.
6. Another fresh `review` Ticket evaluates Candidate B.

Remediation is ordinary implementation: a review verdict leads to another fresh `implement` Ticket.

## Landing

Each Goal has a dedicated integration ref:

```text
refs/spike/goals/<goal-id>/integrated
```

It begins at the Goal's initial revision and is a rebuildable projection of landed Change decisions. Landing never updates `main` or the host worktree.

1. Planner verifies a completed `review` Report with an `approve` verdict selecting the current Candidate.
2. Planner verifies the Change base still matches the Goal's integrated revision.
3. Planner atomically installs `decision.md` with disposition `land` and the exact approved commit.
4. The approved Candidate becomes the landed Change commit.
5. Goal integrated revision and its dedicated integration ref advance to that commit.
6. Planner updates the Plan and selects the next Change.

If the integrated revision moved, Spike must explicitly recreate the Candidate and require review of the new hash. It must not silently land an unreviewed rewrite. Applying the integrated history to `main` is a separate explicit operator action.

## Rejection and abandonment

A review Report may recommend rejecting a Candidate or the entire Change.

- Rejecting a Candidate leaves its producing implementation Report as durable evidence and permits another Ticket.
- Rejecting or abandoning a Change installs `decision.md` with the corresponding disposition and statement without advancing the Goal integrated revision.
- Rejected and abandoned work remains inspectable and cannot be reopened. Related later work receives the next Change ID.

A poor Ticket never has to be approved merely to continue with a later Ticket.

## Churn detection

The planner needs enough Change history to detect non-convergence.

Initial deterministic indicators use only immutable Change history and fixed thresholds:

- two completed review Reports have a `remediate` verdict, meaning one remediation round failed to converge;
- the same finding ID appears in two review Reports requesting remediation, meaning it reopened once;
- two consecutive Reports have a `partial` or `blocked` outcome.

No indicator depends on an upfront Ticket or Change count. These thresholds become configurable only if observed workflows justify it. For example:

```text
Change churn detected

- remediation rounds: 2
- finding concurrency-001 reopened once

Recommendation: pause implementation and review the Change design with the operator.
```

Churn detection produces planner guidance, not automatic rejection. The planner may:

- refine Ticket context;
- split the Change;
- revise acceptance criteria;
- request operator input;
- reject or abandon the Change;
- continue with an explicit rationale.

Acceptance-criteria churn, summary reversals, semantic diff oscillation, automated progress judgment, and automated design judgment are non-goals initially.

## Interruption and recovery

## Committed workflow state

Only a small set of immutable records advance authoritative workflow state:

- a Ticket record commits the assignment, but not any worker progress;
- its published Report commits the Ticket's terminal outcome;
- a completed `implement` Report commits its normalized candidate revision;
- a completed `review` Report with an `approve` verdict commits review approval of an exact candidate revision;
- `decision.md` resolves the Change and, for `land`, commits it to the Goal's integrated history.

Submissions, input and output bundles, quarantine refs, candidate objects, candidate refs, runtime status, and planner summaries prepared before Report publication are staging or projections. They do not advance workflow state by themselves.

For a completed `implement` Ticket, Spike validates the Submission, imports and verifies the output bundle, and prepares the normalized Candidate first, then atomically installs the immutable Report referencing the worker and candidate revisions. For other outcomes and roles, it installs the Report after validating the available worker or host evidence. Report publication is always the Ticket commit point. Bundles, Git objects, or refs left without a published Report are uncommitted debris and may be retained for diagnosis or cleaned up.

## Rewind policy

On planner or supervisor restart:

1. load the latest valid Goal, resolved Changes, current Change, Tickets, Reports, and Change decisions;
2. derive the latest committed Candidate from the highest-numbered completed `implement` Ticket;
3. classify an issued Ticket without `report.md` as interrupted;
4. stop and finalize its worker resources;
5. ignore or quarantine its Submission and other staged output;
6. publish its host-generated Report with outcome `interrupted`;
7. return control to the planner without issuing another Ticket;
8. let the planner explicitly issue the next sequential Ticket from the latest committed Candidate only when the Plan still calls for that work.

Spike never reconnects to an interrupted session, resumes its conversation, imports its uncommitted output automatically, or retries an ambiguous prompt. Recovery and replacement issuance are separate operations; an explicitly issued replacement Ticket may repeat work.

Cleanup is idempotent and independent from workflow progress. A failed adapter cleanup produces a visible health warning and can be retried, but does not make interrupted worker output authoritative.

## Locking

The initial workflow assumes one planner writer and does not support concurrent planner mutation.

Retain narrow coordination only where runtime stop and runtime exit recording genuinely race.

Do not add workflow locks for Goal, Change, Ticket, Report publication, candidate normalization, review, or Change decision operations. The single planner writer makes them unnecessary.

If concurrent planner mutation becomes a demonstrated requirement, design it later against this simpler model.

## Worker execution and lifecycle

The initial adapter creates an ephemeral private clone from the Ticket input bundle. For attended host-local execution, Herdr is the default process host and launches Pi in headed interactive TUI mode in one ephemeral tab. Spike passes the immutable Ticket and context as Pi's initial prompt, disables extension, skill, prompt-template, and context-file discovery, explicitly loads only the role-specific completion extension, and keeps the Pi session ephemeral. An accepted completion both terminates the active turn and requests Pi's supported graceful session shutdown; a rejected completion leaves the same Ticket process alive for correction and retry. The wrapper records Pi's eventual exit, and only that execution marker—not Herdr idle, done, or terminal state—projects the worker as `done`.

Direct host-local Pi execution remains a separately selected, headless `--print --no-session` controlled-test fallback with the same exchange and Report semantics. The Phase 3 Docker adapter remains separately defined below: it runs the same checkout and exchange contract inside one container per Ticket and does not inherit Herdr hosting behavior.

For each Ticket, the Worker module:

1. prepares the input exchange and creates a fresh private checkout;
2. launches the worker and persists its opaque operational handle;
3. waits for a Submission or a terminal runtime outcome;
4. stops the worker when necessary;
5. imports and validates only the declared exchange output;
6. prepares any normalized Candidate and publishes the canonical Report;
7. finalizes the adapter resources and removes the operational record.

Stop and cleanup are idempotent. Report publication must not depend on the worker remaining live. Herdr observation and terminal attachment may wrap the local process launch without changing this seam. Service networking, planner-to-worker follow-up, and persistent interactive continuation are deferred until the Docker workflow is reliable.

## Model configuration

Project configuration records the stable Project slug and distinguishes the planner and Phase 2's executable Ticket roles using the workflow's role names:

```json
{
  "project": {
    "slug": "spike"
  },
  "models": {
    "planner": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "high"
    },
    "implement": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking": "medium"
    },
    "review": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "high"
    }
  }
}
```

When Spike issues a Ticket, it resolves the effective model and thinking selection from that Ticket role's project default and any explicit planner-specified override, then freezes the result into immutable Ticket provenance. Dispatch uses the frozen Ticket selection and does not reread mutable project defaults. A replacement Ticket preserves the interrupted Ticket's effective selection.

Ticket workers never inherit the planner model implicitly. Model and thinking command-line flags on Ticket issuance are explicit one-Ticket overrides. Dispatch-time overrides are rejected because they would change an already committed assignment. Change-level model policy, fallback lists, automatic routing, reviewer ensembles, cost budgets, and escalation policy are deferred until observed workflows justify them.

## Runtime policy

Spike is Bun-first and does not promise Node compatibility for its CLI, modules, or tests. Use Bun where it provides leverage, while continuing to use `node:` standard-library modules where they are equally convenient. Maintain one Bun test and build path rather than a Bun/Node compatibility matrix.

Integration runtimes remain explicit:

- Spike core, CLI, tests, and local Worker adapter run on a pinned Bun version.
- Pi runs on its supported Node runtime and is invoked through its CLI or JSONL RPC protocol. Spike does not run Pi under Bun or embed the Pi SDK into the Bun process initially.
- Any Pi extension remains thin, Node-compatible TypeScript. It communicates with Spike through its CLI or process protocol rather than importing Spike internals.
- Herdr hosts headed interactive Pi as the attended host-local default, exposes live agent status, and supports observation or attachment. It does not own Spike runtime semantics: Herdr lifecycle states and terminal output never complete a Ticket or publish a Report.
- Direct Pi dispatch is headless and ephemeral (`--print --no-session`) and remains the controlled-test fallback.
- Docker execution is a distinct production adapter using the standard exchange contract; the Docker worker image starts from a pinned Node base for Pi and installs a pinned Bun binary for Spike and project tooling.

Pin Bun, Node, and Pi versions in the Docker build. Record the immutable Docker image digest in Report execution provenance. A Docker smoke test must launch Pi under Node and complete one Ticket through the standard exchange contract.

## Durable layout

Every durable workflow file is one Markdown document with unversioned JSON frontmatter:

```text
.spike/
  goals/
    spike-001/
      goal.md
      plan.md
      changes/
        001/
          change.md
          tickets/
            001/
              ticket.md
              report.md
          decision.md
  exchange/
    goals/spike-001/changes/001/tickets/001/
      input/
        ticket.md
        context.md
        repository.bundle
      output/
        submission.md
        repository.bundle
        artifacts/
  runtime/
    workers/goals/spike-001/changes/001/tickets/001/worker.md
```

Git remains authoritative for Candidate trees and commit objects. Completed implementation Reports retain worker and candidate revisions plus their provenance; completed review Reports retain exact reviewed revisions and verdicts. The Goal directory illustrates a Project-qualified Goal ID; the other `001` directories illustrate parent-relative sequential IDs. Files under `exchange/` and `runtime/` are staging inputs and operational projections rather than authoritative workflow documents. Structured files use Markdown with JSON frontmatter; Git bundles and worker artifacts retain their native formats.

## Module direction

The production implementation should concentrate behavior behind a few deep modules.

### Plan module

Owns planner notebook loading, atomic update, compact Change summaries, and churn indicators.

### Change module

Owns sequential Change creation, Report-derived candidate progression and review status, and terminal Change decision invariants.

### Ticket module

Owns sequential Ticket issuance, immutable context, fresh-session assignment, and derivation of open versus reported status.

### Report module

Owns Submission import, host terminal evidence, role-specific validation, canonical Report publication, review findings, and verdicts.

### Git Change module

Owns input bundle creation, quarantine import and verification, Candidate normalization, Ticket-keyed retention refs, commit messages, and landing.

### Worker module

Owns the runtime-independent exchange contract, fresh worker launch at the exact revision, opaque operational handles, terminal outcome observation, stop, and idempotent cleanup. Its first adapter uses ephemeral private clones. Controlled tests may launch the worker process directly; attended use may host the same process in one ephemeral Herdr tab for observation. Herdr is a process host and observer within the local adapter, not another workflow backend. The production adapter uses Docker. Do not create a general adapter registry or expose adapter-specific types to callers.

### Durable-state module

Owns concrete shared filesystem behavior only:

- bounded Markdown and JSON-frontmatter reads;
- canonical frontmatter serialization, timestamps, IDs, and digests;
- project-relative path resolution;
- component symlink rejection;
- immutable file installation;
- atomic mutable-document replacement.

Record validators remain with their owning modules. Avoid creating a broad abstract repository interface.

## Dependency strategy

Use one initial production dependency: `zod` for structural validation of JSON frontmatter and inference of the corresponding TypeScript types. Keep schemas internal to the Goal, Change, Ticket, Report, and Change decision modules. Zod validates document shape; owning modules enforce cross-document workflow invariants such as sequential IDs, exact candidate selection, approval, and landing.

Do not add a state-machine dependency. Durable status is derived from Tickets, Reports, and `decision.md`; encoding the same facts in XState or a similar library would recreate duplicate state and transition machinery.

Use Bun and platform primitives for the remaining small interfaces:

- strict frontmatter delimiters plus `JSON.parse` and a small sorted-key serializer built on `JSON.stringify`, rather than a Markdown/frontmatter package with YAML semantics;
- `Bun.spawn` with argument arrays for Git plumbing, rather than a Git wrapper;
- filesystem create-exclusive, rename, and sync primitives for immutable installation and atomic Plan replacement;
- built-in argument parsing, hashing, and `bun:test` rather than CLI, digest, or test frameworks.

Add another dependency only when repeated implementation inside one of these modules demonstrates that it would reduce the interface or materially improve correctness. Keep dependency-specific types behind the owning module so callers and tests use the workflow's domain language.

## Implementation strategy

## Phase 1: Core workflow foundation

Build the core workflow using a temporary host Git repository and controlled workers in ephemeral private clones. Each clone is created from the standard input bundle and returns the standard output bundle.

The foundation should demonstrate:

- Goal and Plan creation;
- sequential Change and Ticket allocation;
- implementation Ticket, Submission, Candidate normalization, and published Report;
- review Ticket, Submission, and Report with a `remediate` verdict;
- another implementation Ticket from the current Candidate;
- review Report with an `approve` verdict;
- one-commit landing through `decision.md`;
- failed and interrupted Tickets with host-generated Reports;
- rejected and abandoned Change decisions;
- Plan revision;
- churn warning;
- interruption before and after each immutable commit point;
- Report publication after the worker has stopped, using only exchange output.

Phase 1 does not launch containers or interactive session tooling. Local clones provide workspace separation but no security isolation.

## Phase 2: Attended host-local tracer bullet

Turn the core workflow foundation into one attended, dogfood-ready vertical workflow through the local-clone Worker adapter:

```text
planner starts or reattaches in Herdr
  -> change create 001
  -> ticket issue 001
  -> fresh implementation worker starts in an ephemeral Herdr tab
  -> worker writes a structured Submission through a completion or blocked tool
  -> submission import
  -> candidate normalize
  -> report publish
  -> worker finalizes and its Herdr tab closes
  -> review ticket 002 starts in a fresh Herdr tab
  -> review report approve
  -> reviewer finalizes and its Herdr tab closes
  -> change decision land
```

Implement the phase as a small sequence of vertical additions:

1. **Host CLI and configuration** — expose JSON-capable status, Plan revision, Change decision, Ticket dispatch, Report publication, and recovery commands. Add project defaults for planner, `implement`, and `review` model and thinking configuration. Ticket issuance accepts explicit one-Ticket model and thinking overrides, resolves and freezes the effective selection into `ticket.md`, and dispatch uses only that immutable selection. A Ticket worker never inherits the planner model or a later configuration change.
2. **Structured worker outcomes** — add a thin, Node-compatible Pi worker extension with role-specific terminating tools for completion and blocked outcomes. The extension delegates to worker-facing Spike CLI/process commands that validate the structured payload and verify Pi's observed effective model and thinking selection against the immutable Ticket assignment. Completed implementation snapshots create an exact worker revision and output bundle. A blocked Submission records concrete reason and evidence but creates no bundle, Candidate, or review verdict. Host tooling atomically writes the declared Submission; workers do not format JSON frontmatter or run Git-bundle commands themselves. Spike still treats and revalidates all worker output as untrusted. A worker that exits without an accepted Submission cannot produce a completed or blocked Report; it receives an appropriate host terminal Report and later work uses a fresh Ticket.
3. **Direct tracer-bullet verification** — run the complete CLI workflow with deterministic scripted workers and direct process launch. This remains the fast reference path for tests and proves that Herdr is not part of workflow authority.
4. **Supervisor and Herdr integration** — add a thin, Node-compatible Pi supervisor extension and planner launcher. The extension invokes Spike only through structured CLI/process output and exposes committed guidance selection, explicitly approved Goal creation, status, Plan update, Change creation, focused Implement/Review/Remediate Ticket issuance, dispatch, recovery, and Change decision operations. For attended execution, the local adapter defaults to headed interactive Pi in one named ephemeral Herdr tab, automatically submits the immutable Ticket/context prompt, records opaque Herdr handles only in staging runtime state, surfaces live `working`, `blocked`, marker-backed `done`, or unavailable status, and supports terminal read or attachment. The completion extension requests graceful Pi shutdown only after Spike accepts structured completion. The attended wrapper then writes its execution marker. A cancellable one-shot Spike waiter observes that marker without mutating Worker records, and the supervisor extension queues one operational planner recheck keyed by full Ticket identity. An unexpected attended-waiter failure queues a distinct operational failure recheck instead of silently disabling wake-up. The planner calls `spike_status` and explicitly publishes the Report; markers, waiter failures, and wake messages are never workflow evidence. A Herdr state or terminal transcript is never a Submission, Report, approval, or recovery fact. Direct Pi remains the separately selected headless controlled-test fallback.
5. **Attended smoke loop** — manually complete one real-Pi Goal in a temporary test repository through implement, review, approve, and land. Verify supervisor restart, marker-backed planner wake-up without model polling, worker observation, blocked-state visibility, exact Report publication, prompt closure of worker tabs, and idempotent cleanup.

Herdr integration in this phase is deliberately ephemeral and observational. Do not implement session reuse, remediation in the original implementation session, arbitrary free-form agents, planner-to-worker follow-up, concurrent Changes, semantic churn analysis, persistent worker tabs after Report publication, or a general runtime plugin system. Direct process launch remains available for controlled tests and as an explicit fallback.

The local-clone adapter provides workspace separation, not security isolation. Use it only for controlled tests and trusted, attended dogfooding with explicit unrestricted-network acknowledgement. Do not use it to run unattended autonomous workers against valuable repositories or provide valuable credentials. Docker isolation remains required for production use.

## Phase 3: Docker isolation

Implement one Docker adapter behind the existing Worker module seam before production use:

- use a pinned Node base image, run Pi under Node, and install a pinned Bun binary for Spike and project tooling;
- consume the same read-only input exchange;
- create the private repository inside the container;
- write only the declared output exchange;
- do not mount the host checkout, `.spike/` authority, Docker socket, unrelated credentials, or the operator's home directory;
- make network access and credentials explicit Ticket execution policy;
- retain the same Submission, bundle import, Report publication, stop, and cleanup behavior;
- pass the same Worker module contract tests as the local-clone adapter.

This phase should add isolation only. Interactive sessions, service networking, multiple container runtimes, and runtime plugin discovery remain out of scope.

## Testing strategy

Tests should exercise the same deep module interfaces used by production callers.

### Layout

Focused module tests are collocated as `src/**/*.test.ts`. Cross-module tests live by purpose:

```text
test/
  scenario/   # complete workflow and recovery paths
  contract/   # reusable Worker adapter contract suites
  docker/     # explicit slow isolation smoke tests
  support/    # scripted workers and Git fixtures
```

Do not create a mirrored unit-test tree under `test/`.

### Fast default suite

The default Bun suite should remain fast enough for frequent use and contain no network, Docker, Pi, Herdr, or model calls. Use real filesystem and Git integration tests deliberately for complete workflows and high-risk seams; prefer focused tests for parsing, schema, derivation, allocation, and churn where they provide equivalent confidence. Pure focused tests may run concurrently.

Filesystem and Git behavior uses temporary directories and the real Git CLI. Do not introduce an in-memory filesystem or Git implementation: atomic rename, exclusive creation, symlink handling, bundles, refs, and commit identity are part of the production behavior under test. Use Git plumbing, deterministic scripted workers, injected clocks and crash points, and the production modules. Do not sleep or poll in default tests.

Repository scenarios remain isolated and use bounded file-level parallelism; measurement of the Phase 1 suite showed that eight workers reduce default runtime without shared-state failures. Tests within each repository scenario remain sequential. Docker tests run explicitly from `test/docker/`; Herdr and real model execution remain manual smoke tests initially.

### Scenarios

Prioritize scenario tests:

1. sequential Change and Ticket IDs are allocated monotonically and never reused;
2. implement -> review -> approve -> land decision;
3. implement -> review -> implement -> approve -> land decision;
4. failed Ticket Report -> replacement Ticket;
5. interrupted Ticket Report -> replacement Ticket;
6. rejected or abandoned Change decision;
7. crash around each immutable commit point;
8. Worker adapter starts at the exact revision from the input bundle;
9. Report publication succeeds after worker exit using only declared exchange output;
10. missing, malformed, or revision-mismatched output bundles are rejected;
11. stop and cleanup are idempotent;
12. fresh worker context contains all required information;
13. role-specific model defaults and explicit issuance overrides are frozen into Ticket provenance, used by dispatch, verified in Reports, and preserved by replacement Tickets;
14. worker finalization preserves Reports, referenced Candidate commits, and artifacts;
15. deterministic churn warning after repeated feedback;
16. dirty host checkout remains untouched;
17. direct and Herdr-hosted local workers produce identical exchange and Report semantics;
18. Herdr worker status and terminal output cannot complete a Ticket, and Herdr cleanup is idempotent;
19. a real-Pi attended smoke loop completes one Goal in a temporary test repository through the supervisor and worker extensions;
20. Docker exposes only declared inputs, outputs, network, and credentials;
21. Docker launches Pi under Node and completes one Ticket through the standard exchange contract.

Run the same Worker module contract suite against the local-clone adapter in Phase 2 and the Docker adapter in Phase 3. Avoid tests for unsupported arbitrary concurrent planner mutation. Retain focused tests for the genuine runtime stop/exit race.

## Success criteria

The implementation succeeds when:

- one Goal can execute an evolving ordered Plan of sequential Changes;
- Goal IDs combine a stable Project slug with a monotonic Project-relative `nnn` sequence;
- Change and Ticket IDs are monotonic parent-relative `nnn` sequences;
- each landed Change is exactly one reviewed commit;
- multiple sequential fresh-session Tickets can contribute to one Change;
- Reports and exchange output provide sufficient context for publication, planner recovery, and fresh workers after the producing worker has stopped;
- the local-clone and Docker adapters satisfy the same Worker module contract;
- review and remediation require no same-session continuation;
- planner can detect and surface obvious churn;
- interruption rewinds to the latest committed Candidate, abandons in-progress sessions, and cleans their resources without PID-based workflow locks;
- terminal workers are finalized promptly, including closure of ephemeral Herdr tabs after Report publication;
- Herdr makes attended planner and worker progress observable without becoming workflow authority or enabling session reuse;
- structured worker completion and blocked tools make a valid accepted Submission the only path to a worker-authored completed or blocked Report;
- Docker isolation is required before unattended autonomous workers run against valuable repositories;
- Spike uses Bun as its sole application runtime while Pi remains on Node behind process protocols;
- planner, implementation, and review model defaults are project-configured, while explicit Ticket overrides are frozen at issuance;
- the production implementation remains small and easy to navigate.
