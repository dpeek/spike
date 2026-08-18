# Phase 2 dogfood

## Attended safety

Use only a disposable repository. The Phase 2 local-clone adapter provides workspace separation, not security isolation. Ticket issuance must explicitly acknowledge `--network-access unrestricted`. Do not grant valuable credentials.

## Real-Pi Goal procedure

From a Herdr-managed planner pane:

1. Create a temporary Git repository with one initial commit and a tracked `spike.json` containing planner, `implement`, and `review` model defaults.
2. Create the approved Goal:
   ```sh
   spike goal create --title "..." --outcome "..." --approval "..." --json
   ```
3. Create one Change with distinct single-line acceptance criteria:
   ```sh
   spike change create --goal <goal> --title "..." --intent "..." \
     --rationale "..." --acceptance "..." --json
   ```
4. Issue implementation Ticket `001`:
   ```sh
   spike ticket issue --goal <goal> --change 001 --role implement \
     --instruction "..." --network-access unrestricted --json
   ```
   Confirm `ticket.md` freezes the configured implementation model/thinking and exact Change base.
5. Dispatch a fresh real Pi worker in Herdr:
   ```sh
   spike ticket dispatch-pi --goal <goal> --change 001 --ticket 001 \
     --worker pi-implementer --json
   ```
6. Observe with `spike worker status` and `spike worker read`. Treat these as operational observations only. Wait for Spike to report `done`, which requires the local execution marker; terminal or Herdr agent state does not complete the Ticket.
7. Publish the implementation Report and normalized Candidate:
   ```sh
   spike report publish --goal <goal> --change 001 --ticket 001 \
     --commit-summary "..." --json
   ```
   Confirm the Candidate parent equals the Change base, the Report records worker and Candidate revisions, the host branch is unchanged, and worker cleanup is finalized.
8. Issue review Ticket `002` for the current Candidate and producing implementation Ticket:
   ```sh
   spike ticket issue --goal <goal> --change 001 --role review \
     --implementation-ticket 001 --instruction "..." \
     --network-access unrestricted --json
   ```
9. Dispatch a fresh real Pi reviewer, wait for Spike `done`, and inspect staging `submission.md`. Confirm it assesses every canonical criterion exactly once and selects the exact Candidate and implementation Ticket.
10. Publish the review Report:
    ```sh
    spike report publish --goal <goal> --change 001 --ticket 002 --json
    ```
    Confirm the verdict is `approve`, cleanup is finalized, and the ephemeral tab closes.
11. Land the approved Candidate:
    ```sh
    spike change land --goal <goal> --change 001 --statement "..." --json
    ```
12. Verify `status` has no current Change, `decision.md` selects the approved Candidate, the Goal integration ref equals that Candidate, the Candidate has exactly the Change base as parent, and host `HEAD` remains unchanged.

## Evidence: 2026-08-18 real-Pi Goal

Environment:

- Spike commit before fixes: `d76d989` (`Phase 2.8`)
- Bun `1.4.0`
- Node `v24.19.0`
- Pi `0.84.2`
- Herdr `0.8.0`
- planner: `openai-codex/gpt-5.6-sol`, thinking `high`
- implementer: `openai-codex/gpt-5.6-terra`, thinking `medium`
- reviewer: `openai-codex/gpt-5.6-sol`, thinking `high`

Workflow evidence:

- temporary repository: `/tmp/spike-pi-dogfood.WOLLb1`
- Goal: `goal-473202f1b8f54fae449ff7b17e4728a4`
- Change: `001`
- initial/integration base: `a470dc27a4184bfeea2d14ea7bf91b3f236d9fd2`
- implementation Ticket: `001`
- worker revision: `6a53e9085d924e29e3e31ed711c7cad7e0216ac1`
- normalized Candidate: `7fe1439181d36fdc0b55b601f1f2afef80fc78a0`
- defective review evidence retained in Ticket `002`
- complete approving review: Ticket `003`
- landed revision: `7fe1439181d36fdc0b55b601f1f2afef80fc78a0`
- host `HEAD` after landing: `a470dc27a4184bfeea2d14ea7bf91b3f236d9fd2`
- final cleanup: healthy; no Spike worker tabs remained

The implementation added a dependency-free `greet` function and three Bun tests. The independent reviewer ran `bun test` (3 pass, 0 fail), direct behavior assertions, `git diff --check`, and a clean-worktree check. The final approving Report assessed all four exact acceptance criteria as `met`.

## Findings fixed during the run

### Acceptance criteria parser stopped after the first criterion

Both worker completion and Report publication used a multiline regular expression whose `$` alternative matched the end of the first criterion line. A reviewer therefore produced, and the host accepted, an approval assessing only one of four criteria.

Fix: use one shared line-based acceptance-criteria parser for worker completion and Report publication. A four-criterion regression test covers the failure. Ticket `002` remains immutable defective evidence; fresh Ticket `003` produced the valid approval used for landing.

### Herdr `done` appeared before local execution finished

Worker observation mapped Herdr agent `idle`/`done` directly to Spike `done`. During both initial workers this appeared before `submission.md` and `herdr-execution.json` existed.

Fix: before the local execution marker exists, Herdr `idle`, `done`, `working`, and `unknown` all project as Spike `working`; `blocked` remains visible. Spike `done` now requires the execution marker. The Herdr contract test covers the race, and Ticket `003` verified the corrected behavior against real Pi/Herdr.

Validation after both fixes: `bun run check` passed with 51 tests.

## Evidence: 2026-08-18 planner restart and Herdr lifecycle

A second disposable repository exercised the real supervisor extension and actual Herdr process hosting:

- temporary repository: `/tmp/spike-herdr-dogfood.uC4J2N`
- Goal: `goal-28d5c5d49b60f28223433b5a5c1ea494`
- initial revision: `810452ba7a88ce205c4d5ac48ff0fd0dc6eab8be`
- planner tab: `w6:t7`, closed after verification
- first planner Pi session: `01a01318-161d-7383-8c4b-b36869fd651a`
- interrupted implementation Ticket: `001`
- replacement implementation Ticket: `002`
- replacement worker revision: `cb2d9c9bc8b468e12aaf3b695e3a0bcf80a9fe27`
- normalized and landed Candidate: `d6ee74d951eba7230a9a398ff6056b984990db0e`
- final approving review: Ticket `006`
- host `HEAD` after landing: `810452ba7a88ce205c4d5ac48ff0fd0dc6eab8be`

The first real supervisor planner used only `pi-supervisor-extension.ts` tools to inspect status, create Change `001`, issue Ticket `001`, and dispatch a real Pi implementation worker. The planner then exited cleanly. A fresh `spike planner` process started in the same Herdr pane and reconstructed the open Ticket and opaque worker handles from Spike state rather than conversational memory.

The restarted planner ran recovery. Ticket `001` received an `interrupted` Report, staged output was ignored, the worker tab and workspace were finalized, and no replacement Ticket was issued automatically. A second identical recovery was a successful no-op with no interrupted Tickets, finalized workers, cleanup warnings, discarded refs, or ignored output. The planner then explicitly issued replacement Ticket `002`.

The restarted planner observed and read Ticket `002`, then published its exact completed implementation Report through the supervisor extension. The Report selected worker revision `cb2d9c9bc8b468e12aaf3b695e3a0bcf80a9fe27` and normalized Candidate `d6ee74d951eba7230a9a398ff6056b984990db0e`; cleanup finalized and the prompt worker tab closed. Fresh reviews approved that exact Candidate, and landing advanced only the Goal integration ref.

Terminal attachment was exercised on live review Ticket `006` through the exact `spike worker attach` command in a temporary pseudo-TTY. Herdr attached and detached with exit code zero using its `Ctrl+B`, `q` binding. Bounded terminal read was also exercised through both the CLI and supervisor extension.

### Blocked-state scope

Spike's real Herdr projection returned `working`, `blocked`, `working`, then marker-backed `done` for Ticket `006`. The blocked state was induced through Herdr's real `pane.report_agent` socket API with a temporary lifecycle source and observed through both `herdr agent get` and `spike worker status`.

This proves the Herdr-to-Spike blocked-state seam, but it is not a naturally occurring Pi worker prompt. Spike launches workers in headless `--print` mode, while Herdr's installed Pi lifecycle extension deliberately emits blocked events only for interactive TUI root sessions. The current completion extension has no approval or question UI, so a natural blocked event is not reachable in the supported worker path. Treat this as a documented capability boundary unless a real blocking worker interaction is introduced.

### Attachment failure handling

Calling attachment from a non-TTY process caused Herdr 0.8.0 to panic while initializing its terminal. Spike now rejects non-interactive attachment before invoking Herdr with `Herdr terminal attachment requires an interactive TTY`; a focused subprocess regression test covers this. Interactive pseudo-TTY attachment still succeeds.

Final evidence:

- Report publication closed every ephemeral worker tab;
- repeated recovery/cleanup was idempotent;
- no dogfood planner or worker tabs remained;
- final Spike status reported healthy cleanup;
- host `HEAD` remained unchanged;
- the Goal integration ref equals the exact approved one-parent Candidate.
