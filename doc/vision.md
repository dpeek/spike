# Spike vision

## Purpose

Spike is a system for turning an operator's intent into completed, reviewable
software changes while making effective use of multiple coding agents, models,
devices, and execution environments.

The operator's primary job should be to describe outcomes, provide product
direction when it matters, and review meaningful results. The system should own
the mechanics of investigating the repository, slicing work, briefing agents,
running and supervising them, verifying their output, requesting remediation,
and carrying the work forward until the desired outcome has been achieved.

This is a long-term vision, not a commitment to implement every part at once.
The system should grow toward it through small, useful vertical slices.

## The operator experience

The entry point is a conversation with a supervisor. It may begin with anything
from a precise request to a hand-wavy direction:

- Fix this bug.
- What if this screen worked differently?
- We should build this feature.
- This subsystem needs to be simplified.
- Investigate whether this idea is viable.

The supervisor helps turn that conversation into a single goal document. The
document captures what the operator wants, the relevant context, known
constraints, and what success should look like. It does not need to settle every
implementation detail. Decisions that are cheaper and better informed later
should be made later.

The first explicit approval gate is the operator reading the goal document and
saying "go". At that point, the system takes responsibility for progressing the
goal. The supervisor remains available as the operator's view into the system
and as the place where additional direction enters, but the work must not
depend on keeping the original conversation alive.

A new supervisor should be able to start at any time, discover the active goals
and outstanding questions, and become useful immediately. Supervisor sessions
are therefore clients of durable project state, not the owners of it.

## Core concepts

### Supervisor

The supervisor is the operator-facing part of Spike. It conducts the initial
conversation, drafts and revises goals, records approval, presents progress,
and manages the operator's attention queue.

There may be multiple supervisor sessions over the lifetime of a goal. They
must all be able to reconstruct the same state without relying on private chat
history.

### Goal

A goal is an operator-approved outcome. It may represent a tiny fix, a feature,
an investigation, or a large refactor. The goal document is deliberately
lighter than an exhaustive specification: it provides enough direction to
begin and makes important constraints explicit, while leaving room for
just-in-time decisions.

Approval seals a specific revision of the goal. Later operator decisions and
clarifications become durable additions to its context rather than invisible
changes buried in a conversation.

### Planner

A planner owns progress toward one goal. It combines product context from the
goal with the current state of the repository and the evidence produced by
previous work.

The planner repeatedly:

1. Reads the goal and all subsequent decisions.
2. Reviews the current code and the accepted work completed so far.
3. Chooses the next bounded ticket, which may advance the goal or remediate a
   problem in previous work.
4. Writes a context-efficient ticket and selects an appropriate implementer.
5. Evaluates the implementer's result and decides what should happen next.

The planner is responsible for convergence. Review and remediation must be
proportional to risk and must not devolve into endless stylistic iteration.

### Ticket

A ticket is a bounded instruction for an implementer. Its purpose is to make
implementation efficient: important decisions have been made, the scope is
clear, and the agent is given a strong starting point without loading the
entire planning history into context.

A ticket identifies its goal, the exact code state it starts from, the intended
outcome, relevant constraints, and the evidence expected on completion. Once
dispatched, it is immutable. If the required work changes materially, the
planner writes another ticket.

### Implementer

An implementer executes a ticket in an isolated workspace. It investigates as
needed, changes the code, verifies the result, and returns a structured
completion report. It should exercise judgment within the ticket's boundaries.
If blocked or forced to make a decision outside those boundaries, it returns to
the planner rather than escalating directly to the operator.

### Run

A run is one attempt by one agent to execute a ticket. Separating runs from
tickets allows retrying work on another device or with another model without
losing the history of what was attempted and learned.

### Operator request

An operator request is an explicit item requiring human attention. Examples
include goal approval, a product decision, a meaningful review checkpoint, a
security or cost trade-off, and final acceptance where it is required.

Requests should explain why input is needed now, recommend a default, describe
the alternatives, and state what work can continue while the request is open.

## The goal loop

After approval, the normal flow is:

```text
operator conversation
  -> approved goal
    -> planner selects and writes next ticket
      -> implementer executes and verifies it
        -> planner evaluates the result
          -> accept, remediate, request input, or finish
```

The planner should default to serial, comprehensible progress. Parallel work is
valuable when slices are genuinely independent, but concurrency is not itself
a goal. The system should favor a steady sequence of accepted changes over a
large fan-out that creates integration and rebase work.

Branching, rebasing, and merging are part of the planner's responsibility. The
strategy may differ between a tiny fix and a large atomic change. Spike should
provide safe primitives and record the chosen strategy, but should not force
every goal into one branching model.

## Human direction and just-in-time specification

Agents are often capable of making good technical decisions. Humans remain
especially valuable for product intent, taste, scope, risk, and trade-offs that
are expensive to reverse.

The central judgment is not simply whether an agent is uncertain. It is whether
operator input is worth interrupting progress. A useful default is:

> Make decisions that are cheap to reverse and remain inside the approved goal.
> Ask when a decision changes product meaning, expands scope, is destructive,
> affects security, privacy, or material cost, or would be expensive to undo.

The operator queue must distinguish blocking requests from questions needed
only by a later ticket. Planners should continue useful, unblocked work while
waiting for input. This enables just-in-time specification: the operator can
begin with a broad direction and make better decisions when concrete evidence
and working software are available.

## Durable and inspectable agent environments

An agent's useful output is more than its final prose response. A completed run
may produce:

- a branch or set of commits;
- verification results and logs;
- one or more running HTTP or API services;
- screenshots captured with the agent's browser;
- generated files and other artifacts;
- unresolved risks, assumptions, or questions.

These outputs should be structured, durable, and accessible to the operator and
planner. Services should have stable links for as long as their environment is
alive. Screenshots and files should be published through a known artifact
boundary rather than referenced by arbitrary paths that exist only inside a
container.

Initially, implementer sessions and their containers should remain alive after
a response so the planner or supervisor can ask follow-up questions and the
reported services remain available. Explicit lifecycle actions should stop or
remove them. Later, Spike may learn to sleep and reconstruct environments,
including restarting declared services and resuming agent sessions.

Herdr is the intended terminal and live-session substrate. It should own
persistent panes, attachment, and terminal-level agent interaction. Spike
should own the higher-level relationship between goals, tickets, runs,
containers, artifacts, and services.

## Review

Review exists to improve confidence and guide the next decision, not to create
an unbounded ritual around every change.

The planner decides when an adversarial agent review is worthwhile based on
risk, scope, test coverage, and uncertainty. It may accept a result, request a
bounded remediation, or escalate a meaningful decision. Review should have a
clear stopping rule.

Hunk is the intended human code-review surface. Spike should be able to open the
exact change associated with a ticket or checkpoint, preserve human review
notes, and return actionable feedback to the planner. Humans should review
coherent outcomes rather than reconstructing changes from container logs and
manually exported bundles.

## Devices and networking

All participating devices belong to the same Tailscale network and have stable,
human-readable names. A supervisor started on any suitable device should know
which execution devices are available and be able to dispatch work to them,
subject to policy and capability.

Each execution device eventually runs a small Spike service that reports its
identity, capabilities, runtime availability, load, and active environments.
The system can choose a sensible default device while allowing the planner or
operator to override placement when location, architecture, data, or available
tools matter.

Tailscale provides private connectivity and device identity. It is not the
workflow database or scheduler. Durable goal and run state belongs to a Spike
control plane that supervisors and execution devices can reach.

Local Portless URLs remain useful for same-device ergonomics. Remote access to
services and artifacts requires a canonical tailnet-accessible route rather
than assuming a local hostname will work everywhere.

## Isolation and placement

The operator-facing supervisor runs close to the operator and needs access to
the control plane, Herdr, Tailscale, and review tools. It should remain
stateless even if it runs outside a container.

Planners and implementers should normally run in containers with explicit
capabilities. Implementers receive isolated writable workspaces and only the
credentials, repository access, network access, and host mounts required for
their ticket. Planner environments can be more restricted because they usually
need to inspect code and write workflow state rather than modify the canonical
checkout directly.

The exact placement is allowed to evolve, but security boundaries should be
intentional and visible. Convenience must not silently turn into mounting an
operator's entire home directory or sharing unrelated secrets between agents.

## Model intelligence and capacity

The workflow naturally fans out from a small number of difficult decisions to
a larger amount of well-specified execution:

```text
supervisor: broad context, product conversation, high intelligence
  -> planner: one goal, sequencing and evaluation
    -> implementer: one bounded ticket with decisions prepared
      -> optional narrower helpers or reviewers
```

Roles should request capability profiles rather than permanently hard-coding a
specific model. A configuration may initially map the supervisor to a highly
capable model, the planner to a strong reasoning model, and implementers to
faster or less expensive models. Every run should record the model, reasoning
level, duration, usage, result, and remediation history so those policies can
be tuned with evidence.

Longer term, Spike should use available model capacity intelligently. It may
schedule useful background work around usage limits and resets, but only after
the core workflow is reliable and measurable. Maximizing usage is subordinate
to producing valuable changes.

## Proactive improvement

The system should eventually suggest useful work: refactors, cleanup, missing
tests, documentation improvements, dependency updates, and other technical-debt
retirement.

Suggestions enter an operator inbox as proposals, not silently as approved
goals. The operator can discuss, reshape, approve, defer, or reject them. Some
well-understood low-risk maintenance may eventually be governed by standing
policies, but autonomous activity must not become wheel-spinning or a source of
unreviewed scope expansion.

## Durable state and documents

Goal and ticket documents should exist on disk or be materializable as ordinary
Markdown because they are easy for both humans and agents to inspect and bring
back into context. They should not accumulate as stale, committed documentation
inside every product repository.

During early development, ignored project-local storage is acceptable. In the
longer-term design, a Spike control plane is the source of truth and exposes
immutable document revisions, decisions, events, and artifacts. Repositories
contain only deliberate project configuration; runtime workflow history remains
available without becoming part of the product's permanent documentation.

## What success feels like

The operator can start a conversation from any device, describe an outcome at
the level that is natural, approve a concise goal, and trust Spike to keep
making visible progress. The system uses strong reasoning where it has the most
leverage, gives implementers crisp work, preserves every important artifact and
decision, and asks for human direction at useful moments.

At any point the operator can answer:

- What goals are active?
- What is running, and on which device?
- What changed, and how was it verified?
- What can I open, inspect, or try right now?
- What needs my attention, and why?
- What will the system do next if I provide no input?

The result is not an autonomous black box. It is a durable collaboration loop
that lets one operator guide a large amount of high-quality agent work without
becoming the scheduler, process monitor, context courier, or integration layer.
