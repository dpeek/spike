# Goal 001: Durable local goal loop

Status: Draft

## Outcome

Build the first complete Spike workflow on a single device: an operator approves
a concise goal, a planner repeatedly chooses and writes the next bounded ticket,
an isolated implementer executes it, and the planner evaluates the result until
the goal is achieved or meaningful operator input is required.

The workflow must survive the original supervisor session. A newly started
supervisor should be able to recover the active goal, understand what has
happened, show what needs attention, and continue coordinating without relying
on private conversation history.

This goal is the local foundation for the wider system described in
[`vision.md`](./vision.md). It should produce a useful end-to-end loop before we
add distributed execution, aggressive parallelism, or capacity scheduling.

## Why this goal comes first

Spike already has most of the execution substrate: isolated container
workspaces, persistent repository volumes, browser tooling, Portless service
URLs, a host-side supervisor extension, and detached one-shot workers. There is
also an in-progress Herdr integration that adds persistent supervisors and
interactive workers with follow-up messaging and attachment.

What is missing is the durable coordination layer connecting those primitives.
Today, a supervisor can delegate tasks, but the conversation effectively owns
the plan; a worker response is mostly terminal text; branch return and review
are manual; and there is no durable representation of an approved goal, its
next ticket, accepted progress, or outstanding operator decisions.

Completing the local loop will clarify the contracts that later remote devices
and schedulers need, while remaining small enough to exercise with real work.

## Desired operator experience

The completed goal should support this walkthrough:

1. The operator and a supervisor produce a lightweight Markdown goal document.
2. The operator approves a specific revision by saying "go".
3. Spike records the approved goal and makes it visible as active project state.
4. A planner reads the goal, decisions, current repository state, and previous
   run evidence, then writes one bounded ticket.
5. Spike dispatches the ticket to an isolated, persistent implementer session.
6. The implementer changes the code, verifies it, and submits a structured
   completion report with the resulting Git state and useful artifacts.
7. The planner evaluates the result and chooses one next action:
   - accept it and prepare the next ticket;
   - issue bounded remediation;
   - create an operator request;
   - declare the goal achieved.
8. The operator can inspect meaningful changes and try any reported running
   services without reconstructing them from logs.
9. The supervisor can be closed and restarted at any point without losing the
   goal's state or making completed work unintelligible.

The happy path should not require the operator to act as a scheduler, copy
context between agents, manually export branches, or poll terminals for
completion.

## Scope

### Durable goal state

Spike can activate an approved goal document and persist its identity, approved
revision, status, repository, target code state, and accumulated context.

The goal's durable context includes:

- the approved goal revision;
- subsequent operator decisions and clarifications;
- tickets issued by the planner;
- runs attempted for each ticket;
- structured completion reports and verification evidence;
- accepted code state;
- open and resolved operator requests;
- enough event history to explain how the current state was reached.

Early storage may live in ignored project-local state. Documents must remain
readable or materializable as ordinary Markdown, and runtime history must not
accumulate as committed product documentation.

### Stateless supervisor recovery

A new supervisor can discover this project's active goal and outstanding
operator requests. It can summarize current progress, locate the planner and
implementer sessions that are still alive, and continue the workflow.

No important goal state may exist only in a supervisor's Pi session. Chat
history may improve conversational continuity, but it is not authoritative.

### One planner, one next ticket

One planner owns the goal loop. It operates serially by default and writes at
most one ready implementation ticket at a time.

The planner decides:

- what the next useful slice is;
- whether previous work is accepted or needs remediation;
- which code state the next ticket starts from;
- the appropriate branch and integration strategy for the current slice;
- whether an uncertainty can be resolved with best judgment or requires the
  operator;
- when the evidence is sufficient to declare the goal achieved.

The planner must converge. Review and remediation are bounded by their value;
stylistic disagreement alone must not generate an endless loop.

### Persistent implementation sessions

Implementers run in isolated container workspaces through Herdr-backed sessions.
Completing a response leaves the session and container available for follow-up
questions, remediation, running services, and inspection. Explicit lifecycle
actions stop or remove them.

The in-progress Herdr work should be completed and verified as part of this
goal. Herdr owns terminal persistence, attachment, and live agent status. Spike
owns worker identity, containers, networks, workspaces, service leases, and the
association between a worker, run, ticket, and goal.

The existing one-shot execution path should remain available unless removing it
is separately justified.

### Structured completion reports

An implementation run returns data rather than requiring the planner to infer
everything from the last screenful of terminal output. At minimum, a report
contains:

- outcome and concise summary;
- base and resulting Git revisions;
- commits and dirty-worktree status;
- verification commands and their outcomes;
- running services and their operator-facing URLs;
- screenshots, logs, generated files, and other exported artifacts;
- assumptions, known limitations, and unresolved risks;
- whether the implementer is ready for follow-up or genuinely blocked.

Terminal output remains available as supporting evidence, but it is not the
structured report.

Artifacts are exported through a known mounted boundary. Reports must not offer
links to arbitrary container paths that the operator cannot access.

### Code return, integration, and review

Completed code can be published from an implementer's persistent clone into a
host-accessible review and integration flow without manual Git bundle commands.
Every ticket records an exact base revision, and the planner can identify the
precise change produced by a run.

The operator can open a coherent diff or commit range in Hunk at a useful review
checkpoint. Human notes can be preserved and turned into planner-visible
feedback. The planner remains responsible for deciding whether that feedback
requires remediation, a later ticket, or no action.

This goal does not need to impose one universal branching strategy. It must
provide safe primitives and enough recorded provenance for the planner to use a
short-lived ticket branch, a rolling integration branch, or a direct small fix
deliberately.

### Operator request queue

Spike exposes a durable queue of items that need human attention. For this
goal, it is enough to support requests arising from the active goal, including:

- approval;
- a product or scope decision;
- a meaningful review checkpoint;
- a security, privacy, destructive-action, or material-cost decision;
- a completion question when operator acceptance is required.

Each request states:

- the question or requested action;
- why it is needed now;
- the planner's recommended default;
- relevant alternatives and trade-offs;
- whether it blocks the whole goal or only future work;
- what work can continue before it is answered.

Implementers escalate uncertainties to the planner. The planner decides whether
operator attention is warranted and avoids duplicating low-level questions in
the human queue.

## Success criteria

This goal is achieved when all of the following are demonstrated:

- An approved Markdown goal can be activated and inspected through Spike.
- Spike persists tickets, runs, reports, decisions, operator requests, and the
  accepted code revision for that goal.
- A planner can issue a ticket and dispatch it to a persistent isolated worker.
- The worker can be messaged again after its first response without recreating
  its workspace or losing its Pi conversation.
- A completion report includes Git provenance, verification, services, and
  exported artifacts in a structured form.
- A completed branch can be published and reviewed without the operator running
  the manual bundle recipe from the current README.
- The exact ticket change can be opened in Hunk or an explicit fallback diff
  when Hunk is unavailable.
- The planner can accept work, issue bounded remediation, request operator
  input, and mark the goal achieved.
- A second supervisor started after the first exits can accurately reconstruct
  and continue an in-progress goal.
- A blocking operator request is visible to the new supervisor, while
  non-blocking work can continue when available.
- Explicit worker shutdown invalidates its service leases and leaves its
  durable reports and artifacts inspectable.
- Automated tests cover the durable workflow state and adapters without
  requiring live Herdr or container runtimes for every test.
- An end-to-end smoke test exercises the loop against a disposable fixture
  repository using the real local Herdr and container runtime.
- The README documents the resulting operator workflow and its current
  limitations.

## Constraints and principles

- Optimize for one understandable, working vertical loop before generalizing.
- Keep goal, ticket, run, worker, and branch identities separate.
- Prefer explicit state transitions and structured records over parsing prose or
  terminal snapshots.
- Persist decisions and evidence, not a full duplicate of every agent context.
- Treat the approved goal as direction, not an exhaustive up-front design.
- Let the planner make reversible in-scope decisions and involve the operator
  when product meaning, scope, safety, or expensive-to-reverse choices are at
  stake.
- Keep credentials and host access narrowly scoped. Persistent sessions must not
  require broad host-home mounts.
- Preserve the existing container and Portless policy boundaries: Herdr manages
  terminals; Spike manages execution resources and operator-facing services.
- Prefer serial integration for the first loop. Parallel work is allowed only
  where it does not make the initial implementation materially more complex.
- Make failure states inspectable and recoverable. Restarting a supervisor must
  not silently redispatch completed work.

## Non-goals

The following are intentionally deferred:

- dispatching work across multiple Tailscale devices;
- a highly available or replicated control plane;
- multiple goals progressing concurrently;
- parallel implementer scheduling as a default;
- automatic model selection based on cost or quota;
- optimizing utilization around model usage resets;
- proactive generation and autonomous approval of maintenance goals;
- sleeping and restoring arbitrary running services after a host reboot;
- a web dashboard or mobile-specific operator interface;
- a universal Git branching policy for every type of repository;
- production-grade multi-user permissions and tenancy;
- preserving every supervisor or agent chat as workflow state.

The design should avoid making these directions unnecessarily difficult, but
they are not required to complete this goal.

## Known uncertainties

The planner may resolve these during the goal unless the choice becomes costly
or constrains the operator experience materially:

- the initial on-disk representation and whether it uses a small database, an
  append-only event log, ordinary files, or a combination;
- how the planner is awakened after a run settles;
- the exact structured-report transport between a container and the control
  state;
- how ticket branches are published into a host review checkout;
- how Hunk notes are imported and associated with a ticket;
- how much of the existing Pi supervisor extension remains the operator-facing
  adapter versus moving into a separate local coordinator process;
- the precise stopping rule for automated review and remediation.

These are implementation decisions, not prerequisites for approving the goal.

## Approval

Approval means the operator agrees that this is the next outcome Spike should
work toward. It does not approve the deferred multi-device or autonomous-work
features, and it does not require every implementation decision above to be
settled before the first ticket begins.
