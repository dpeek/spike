# Ticket 001: Publish and review worker branches

Goal: [`Goal 001: Durable local goal loop`](./goal.md)

Status: Ready for approval

## Outcome

Add a safe, repeatable way to bring a persistent worker's committed branch into
the host repository for inspection without changing the host working tree.

After this ticket, a supervisor can publish a worker's completed commits into a
namespaced host-side Git ref, inspect the exact change, and tell the operator how
to open it in Hunk. The operator should no longer need to type the manual Git
bundle recipe from the README for subsequent tickets.

This ticket deliberately stops before merge or rebase automation. Publication
and review must be trustworthy before Spike is allowed to integrate changes.

## Context

Each Spike worker has:

- a persistent clone in its workspace volume;
- a stable branch, normally `agent/<name>`;
- a running container with a known runtime and container name;
- `/output` bind-mounted to the host project's `.pi-swarm/output/` directory.

The current return path is documented in [`README.md`](../README.md): an agent
creates a bundle under `/output`, then the operator manually fetches the branch
from that bundle. It works, but it is easy to mistype, does not produce a durable
publication record, and requires the operator to reconstruct the appropriate
diff.

The in-progress Herdr integration keeps an interactive worker and its container
alive after a response. This makes it possible for the host-side Spike CLI to
ask the running container to inspect and bundle its repository without giving
the worker access to the host checkout.

Relevant code:

- [`src/cli.ts`](../src/cli.ts) owns agent state, runtime commands, the output
  mount, and the `spike agent` command surface.
- [`docker/agent-entrypoint.sh`](../docker/agent-entrypoint.sh) initializes and
  selects the worker branch.
- [`extensions/spike-supervisor.ts`](../extensions/spike-supervisor.ts) exposes
  agent actions to the supervisor.

## Required behavior

### Publish a worker branch

Add this operator-facing command:

```text
spike agent publish <name>
```

Publishing performs one safe operation composed of two internal stages:

1. Create and verify an immutable Git bundle from the worker clone.
2. Fetch the bundled branch into a namespaced ref in the host repository.

The command must:

- resolve the worker through its recorded `AgentState` rather than reconstructing
  container or volume names from user input;
- support both Apple Container and Docker through the existing runtime
  abstraction;
- execute Git inspection and bundle creation inside the worker's running
  container;
- determine and record the actual branch, base commit, and head commit rather
  than assuming them from the worker name;
- require the worker to be on a branch, have at least one commit beyond its
  recorded or derived base, and have a clean working tree;
- write the bundle and a small JSON manifest below
  `.pi-swarm/output/branches/<agent>/`;
- use content-addressed or head-addressed filenames so an earlier publication is
  not silently overwritten;
- verify the bundle on the host before importing it;
- fetch the worker head into `refs/spike/agents/<agent>`;
- leave the host index, current branch, and working tree untouched;
- print a concise human-readable result and provide a machine-readable result to
  callers, including the agent, worker branch, base, head, imported ref, bundle
  path, and manifest path;
- be idempotent when the same head has already been published;
- refuse a non-fast-forward update of an existing imported ref with a clear
  explanation rather than forcing it.

For this first publication primitive, the base may be the commit where the
persistent worker branch originally diverged from the seed repository. Later
goal-state work will associate exact bases with individual tickets and runs.
The base chosen here must nevertheless be an exact commit and must be recorded
in the publication manifest.

If the worker is stopped, missing, not Herdr-backed where live execution is
required, dirty, detached, has no publishable commits, or cannot be inspected,
the command must fail without changing a host ref. The error should identify the
condition and suggest a useful next action.

### Inspect the published change

Add:

```text
spike agent diff <name>
```

This command reads the latest successful publication record and shows the exact
`base...head` change from the imported host ref. It must not depend on the worker
still running.

Normal Git diff arguments after `--` should be forwarded where practical, for
example:

```text
spike agent diff frontend -- --stat
spike agent diff frontend -- src/
```

The default output should be suitable for a terminal and should state the base,
head, and imported ref before the patch or summary. It must fail clearly if the
worker has never been published or the recorded ref no longer points at the
published head.

### Open Hunk review

Add:

```text
spike agent review <name>
```

This command opens Hunk in the host repository for the same exact published
`base...head` range used by `diff`.

It must:

- run Hunk against the host repository, not inside the worker container;
- leave the host working tree untouched;
- fail with a short installation hint when Hunk is unavailable;
- fail clearly when there is no valid publication to review;
- print the reviewed base, head, and ref before handing over to Hunk.

This ticket does not need to import Hunk comments back into Spike. It establishes
the stable review target that later comment integration will use.

### Make publication available to the supervisor

Extend the supervisor's `spike_agents` tool with a `publish` action. It should
invoke the same CLI behavior and return the structured publication result to the
supervisor.

The tool description should tell the supervisor to publish only after the
worker says it has committed its intended changes and completed verification.
The supervisor may summarize or inspect the publication, but it must not merge
it as part of this ticket.

Interactive Hunk review remains an operator CLI action; the supervisor tool does
not need to launch or control the Hunk TUI.

## Publication manifest

Use a versioned JSON document containing at least:

- schema version;
- project identity;
- agent identity;
- worker branch;
- exact base commit;
- exact head commit;
- imported host ref;
- bundle path;
- publication timestamp.

The implementation may add fields that make validation and later migration
safer. Host paths recorded in the manifest should be project-relative where
possible so moving the repository does not unnecessarily invalidate the record.

The latest successful publication must also be discoverable from durable agent
state or a stable per-agent pointer. Do not infer "latest" solely from directory
ordering.

## Safety requirements

- Do not check out, reset, merge, rebase, cherry-pick, or modify a host branch.
- Do not require the host working tree to be clean; publication and review are
  ref-only operations and must coexist with unrelated operator changes.
- Do not force-update an existing publication ref.
- Do not publish dirty or uncommitted worker changes.
- Do not construct shell command strings from untrusted values. Use argument
  arrays and the existing slug validation where applicable.
- Validate recorded paths before reading bundles or manifests from the host.
- Do not broaden host mounts or expose the host Git directory to the worker.
- Preserve existing one-shot and Herdr-backed agent behavior.
- A failure before the final validated fetch must leave the existing imported
  ref and latest-publication pointer unchanged.

## Acceptance criteria

- `spike agent publish <name>` publishes a clean committed branch from a running
  Apple Container worker.
- The same behavior is implemented for Docker, even if the main smoke test is
  performed with Apple Container.
- The created bundle passes `git bundle verify` on the host.
- The imported ref resolves to the reported worker head.
- The manifest records the exact base/head range and is retained on disk.
- Publishing the same head twice succeeds without creating inconsistent state.
- A non-fast-forward publication is rejected without moving the existing ref.
- A dirty worker is rejected without producing a successful publication record.
- Publishing does not change the host `HEAD`, index, current branch, staged
  changes, or unstaged changes.
- `spike agent diff <name>` works after the worker has stopped.
- `spike agent review <name>` opens Hunk for the recorded range and gives a
  useful error when Hunk is unavailable.
- The supervisor can invoke `spike_agents` with `action: "publish"` and receives
  the publication metadata.
- Existing `bun run check` validation passes.
- Automated tests cover manifest validation, idempotency, dirty-worker refusal,
  ref update protection, and preservation of a dirty host checkout without
  requiring a live container runtime.
- A documented smoke test uses a disposable repository and a real persistent
  worker to publish, diff, and review a small committed change.
- The README replaces the manual branch-return recipe as the primary workflow,
  while retaining a concise recovery recipe for troubleshooting.
- The implementing worker commits all intentional repository changes and leaves
  its working tree clean.

## Non-goals

- merging, rebasing, cherry-picking, or deleting branches;
- deciding whether a publication should be accepted;
- ticket-specific base revisions from the future goal store;
- publishing from a stopped container or mounting its volume into a second VM;
- synchronizing branches between devices;
- creating pull requests or pushing to a canonical remote;
- importing or resolving Hunk comments;
- storing goals, tickets, runs, or operator requests;
- changing the planner loop;
- redesigning the current worker branch naming strategy.

## Verification notes

Tests should use temporary Git repositories and an injectable or fake runtime
command boundary for deterministic coverage. They must not depend on Herdr,
Docker, Apple Container, Hunk, or Portless being installed in the test
environment.

The real smoke test is intentionally separate. It should demonstrate:

1. Start a persistent worker in a disposable seed repository.
2. Have it make and commit a small change.
3. Leave unrelated uncommitted changes in the host checkout.
4. Publish the worker.
5. Confirm the host working tree is byte-for-byte and index-for-index unchanged.
6. Inspect the imported ref and diff.
7. Open the range in Hunk.
8. Stop the worker and confirm `spike agent diff` still works.

If the current Herdr slice cannot complete this smoke test reliably, report the
blocking defect rather than weakening the publication safety requirements.
