#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  abandonChange,
  changePath,
  createChange,
  landChange,
  rejectChange,
  type ChangeDecision,
} from "./change.ts";
import type { ThinkingLevel } from "./config.ts";
import { discoverRepository } from "./git.ts";
import { activateProject } from "./project.ts";
import { createGoal, goalPath } from "./goal.ts";
import { applyQueueHead, queueGoalIntegration } from "./goal-apply.ts";
import { deriveApplicationStatus, issueApplicationTicket, prepareApplicationTicketExchange, publishApplicationImplementationReport, publishApplicationPartialReport, recoverApplicationTicket } from "./application-ticket.ts";
import { deriveApplicationReviewStatus, issueApplicationReviewTicket, prepareApplicationReviewExchange, publishApplicationReviewReport, recoverApplicationReviewTicket } from "./application-review.ts";
import { dispatchApplicationReviewPiTicket, dispatchApplicationReviewWorker, loadFinishedApplicationReviewWorker, observeApplicationReviewWorker, readApplicationReviewWorker } from "./application-review-worker.ts";
import { dispatchApplicationPiTicket, dispatchApplicationWorker, loadFinishedApplicationWorker, observeApplicationWorker, readApplicationWorker } from "./application-worker.ts";
import { guidanceStepSchema, type GuidanceStep } from "./guidance.ts";
import { selectGuidance } from "./planner-guidance.ts";
import { planPath, revisePlan } from "./plan.ts";
import { closeRequest, createRequest, listRequests, loadRequest, requestDataRoot, type ClosureDisposition } from "./request.ts";
import { launchPlanner } from "./planner.ts";
import { goalPlannerOperations } from "./goal-planner.ts";
import {
  loadSubmissionOutcome,
  publishBlockedReport,
  publishFailedReport,
  publishImplementationReport,
  publishReviewReport,
  type ReportPublicationCleanup,
} from "./report.ts";
import { reconcileGoal, reconcileRepository, type ReconciledGoal } from "./recovery.ts";
import {
  deriveGoalStatus,
  deriveRepositoryStatus,
  deriveSupervisorPlannerStatus,
  type DerivedGoalStatus,
  type DerivedRepositoryStatus,
} from "./status.ts";
import { issueTicket, loadTicket, reportPath, ticketPath, type ExecutionPolicy } from "./ticket.ts";
import { blockWorker, completeWorker, readWorkerPayload } from "./worker-completion.ts";
import {
  attachWorkerTerminal,
  dispatchWorkerTicket,
  dispatchPiTicket,
  loadFinishedWorkerExecution,
  observeWorker,
  readWorkerTerminal,
  waitForWorkerDone,
} from "./worker.ts";

export const version = "2.0.0-dev";

export function usage(): string {
  return `spike ${version}

Usage:
  spike planner
  spike planner start-or-reattach --goal <goal-id> [--json]
  spike planner observe --goal <goal-id> [--json]
  spike planner attach --goal <goal-id>
  spike planner replace --goal <goal-id> [--json]
  spike project activate
  spike status [--goal <goal-id>] [--operational] [--json]
  spike guidance show --step <step> [--goal <goal-id>] [--change <change-id>] [--json]
  spike goal create --title <title> --outcome <outcome> --approval <statement> [options]
  spike goal queue --goal <goal-id> --target main --approval <statement> [--json]
  spike application apply-head --goal <goal-id> --application <application-id> [--json]
  spike application ticket issue --goal <goal-id> --application <application-id> --instruction <instruction> [options]
  spike application ticket prepare --goal <goal-id> --application <application-id> --ticket <ticket-id> [--json]
  spike application review issue --goal <goal-id> --application <application-id> --instruction <instruction> [--json]
  spike application review prepare --goal <goal-id> --application <application-id> --ticket <ticket-id> [--json]
  spike application review status --goal <goal-id> --application <application-id> [--json]
  spike application review recover --goal <goal-id> --application <application-id> --ticket <ticket-id> [--reason <reason>] [--json]
  spike application ticket dispatch-test --goal <goal-id> --application <application-id> --ticket <ticket-id> --worker <identity> -- <command> [args...]
  spike application ticket dispatch-pi --goal <goal-id> --application <application-id> --ticket <ticket-id> --worker <identity> [--json]
  spike application worker status --goal <goal-id> --application <application-id> --ticket <ticket-id> [--json]
  spike application worker read --goal <goal-id> --application <application-id> --ticket <ticket-id> [--json]
  spike application status --goal <goal-id> --application <application-id> [--json]
  spike application report publish --goal <goal-id> --application <application-id> --ticket <ticket-id> --worker <identity> --commit-summary <summary> [--json]
  spike application report blocked --goal <goal-id> --application <application-id> --ticket <ticket-id> --worker <identity> [--json]
  spike application report partial --goal <goal-id> --application <application-id> --ticket <ticket-id> --worker <identity> --reason <reason> [--json]
  spike application recover --goal <goal-id> --application <application-id> --ticket <ticket-id> [--reason <reason>] [--json]
  spike plan revise --goal <goal-id> [--file <path>] [--json]
  spike request create --title <title> --statement <statement> [--project <slug>] [--json]
  spike request list [--project <slug> | --unassigned] [--closed] [--json]
  spike request show --request <request-id> [--json]
  spike request close --request <request-id> --disposition <addressed|declined|withdrawn> --statement <statement> [--json]
  spike change create --goal <goal-id> --title <title> --intent <intent> --rationale <rationale> --acceptance <criterion> [options]
  spike change land --goal <goal-id> --change <change-id> [--statement <statement>] [--json]
  spike change reject --goal <goal-id> --change <change-id> --statement <statement> [--json]
  spike change abandon --goal <goal-id> --change <change-id> --statement <statement> [--json]
  spike ticket issue --goal <goal-id> --change <change-id> --instruction <instruction> [options]
  spike ticket dispatch-pi --goal <goal-id> --change <change-id> --ticket <ticket-id> --worker <identity> [--host herdr|direct]
  spike ticket dispatch-test --goal <goal-id> --change <change-id> --ticket <ticket-id> --worker <identity> -- <command> [args...]
  spike worker status --goal <goal-id> --change <change-id> --ticket <ticket-id> [--json]
  spike worker wait --goal <goal-id> --change <change-id> --ticket <ticket-id> [--json]
  spike worker read --goal <goal-id> --change <change-id> --ticket <ticket-id> [--lines <count>] [--ansi] [--json]
  spike worker attach --goal <goal-id> --change <change-id> --ticket <ticket-id>
  spike worker complete [--file <payload.json>] [--json]
  spike worker block [--file <payload.json>] [--json]
  spike report publish --goal <goal-id> --change <change-id> --ticket <ticket-id> [options]
  spike recover [--goal <goal-id>] [--reason <reason>] [--json]
  spike --help
  spike --version

Global options:
  --json                         Emit one JSON object on success or failure

Guidance options:
  --step <step>                  goal, plan, change, implement, review, remediate, decide, or recover
  --goal <goal-id>               Required except for Goal guidance
  --change <change-id>           Required for Implement, Review, Remediate, and Decide guidance

Plan revision options:
  --file <path>                  Read the Plan body from a file; omit or use - for stdin

Goal creation options:
  --constraint <constraint>      Repeat for each constraint
  --request <request-id>         Repeat for each source Request
  --repository-id <identity>     Override the inferred repository identity

Goal queue options:
  --goal <goal-id>               Completed Goal to admit to the FIFO queue
  --target main                  The only supported target
  --approval <statement>         Separate explicit operator approval for this Application

Application apply-head options:
  --goal <goal-id>               Exact Goal owning the FIFO head
  --application <application-id> Exact FIFO-head Application ID

Request options:
  --project <slug>              Repeat for each Project affinity
  --unassigned                  Select Requests with no Project affinity
  --closed                      Select closed Requests (list defaults to open)
  --disposition <value>         addressed, declined, or withdrawn

Change creation options:
  --acceptance <criterion>       Repeat for each acceptance criterion
  --non-goal <non-goal>          Repeat for each non-goal
  --dependency <dependency>      Repeat for each dependency

Ticket issuance options:
  --role <role>                  implement (default) or review
  --implementation-ticket <id>   Producing Ticket; derived for review when omitted
  --response-to-review <id>      Prior review Ticket being addressed; derived for implementation
  --context <context>            Additional planner-curated context
  --isolation <level>            Override isolation: workspace or container
  --network-access <access>      Override network access: none, restricted, or unrestricted
  --credential <grant-id>        Repeat to override credential grant identifiers
  --clear-credentials            Override configured credential grants with none
  --model <model>                Override the role's configured model for this Ticket
  --thinking <level>             Override thinking: off, minimal, low, medium, high, or xhigh

Goal planner options:
  --goal <goal-id>             Existing Goal owned by the planner

Pi dispatch options:
  --worker <identity>             Worker identity recorded in Report provenance
  --host <herdr|direct>           Override hosting (HERDR_ENV selects Herdr automatically; direct is fallback)

Worker observation options:
  --lines <count>                 Terminal rows to read (default 120)
  --ansi                          Preserve terminal styling when reading

Controlled-test dispatch options:
  --worker <identity>             Worker identity recorded in Report provenance
  --environment-digest <digest>  Optional immutable environment identity
  -- <command> [args...]          Explicit controlled-test worker command

Worker submission options:
  --file <path>                  Read JSON payload from a file; omit or use - for stdin

Report publication options:
  --commit-summary <summary>      Required for a completed implementation Report
  --commit-body <body>            Optional Candidate commit message body
  --failure <reason>              Publish a failed Report instead of a completed Report
`;
}

class UsageError extends Error {}

type JsonSuccess = { ok: true; command: string; data: unknown };
type JsonFailure = { ok: false; command: string; error: { code: "usage" | "workflow"; message: string } };

function emitJson(value: JsonSuccess | JsonFailure): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function success(json: boolean, command: string, data: unknown, human: string): number {
  if (json) emitJson({ ok: true, command, data });
  else process.stdout.write(human);
  return 0;
}

function failure(json: boolean, command: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof UsageError ? "usage" : "workflow";
  if (json) emitJson({ ok: false, command, error: { code, message } });
  else process.stderr.write(`spike: ${message}\n`);
  return code === "usage" ? 2 : 1;
}

function extractJson(args: string[]): { args: string[]; json: boolean } {
  const separator = args.indexOf("--");
  const boundary = separator === -1 ? args.length : separator;
  const count = args.slice(0, boundary).filter((arg) => arg === "--json").length;
  if (count > 1) throw new UsageError("--json may be specified only once");
  return {
    args: args.filter((arg, index) => index >= boundary || arg !== "--json"),
    json: count === 1,
  };
}

function commandName(args: string[]): string {
  if (args.length === 0 || ["--help", "-h"].includes(args[0]!)) return "help";
  if (["--version", "-V"].includes(args[0]!)) return "version";
  if (args[0] === "status" || args[0] === "recover") return args[0];
  return args.slice(0, 2).join(" ");
}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function parseRequestCreate(args: string[]): { title: string; statement: string; projects: string[] } {
  let title: string | undefined;
  let statement: string | undefined;
  const projects: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--title") title = value;
    else if (option === "--statement") statement = value;
    else if (option === "--project") projects.push(value);
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (title === undefined) throw new UsageError("--title is required");
  if (statement === undefined) throw new UsageError("--statement is required");
  return { title, statement, projects };
}

function parseRequestList(args: string[]): { project?: string; unassigned?: boolean; closed?: boolean } {
  let project: string | undefined;
  let unassigned = false;
  let closed = false;
  for (let index = 0; index < args.length;) {
    const option = args[index]!;
    if (option === "--unassigned") { unassigned = true; index++; continue; }
    if (option === "--closed") { closed = true; index++; continue; }
    const value = valueAfter(args, index, option);
    if (option === "--project") project = value;
    else throw new UsageError(`unknown option: ${option}`);
    index += 2;
  }
  if (project !== undefined && unassigned) throw new UsageError("--project cannot be combined with --unassigned");
  return { ...(project === undefined ? {} : { project }), ...(unassigned ? { unassigned: true } : {}), ...(closed ? { closed: true } : {}) };
}

function parseRequestShow(args: string[]): { requestId: string } {
  if (args.length !== 2 || args[0] !== "--request") throw new UsageError(args.length === 0 ? "--request is required" : `unknown option: ${args[0]}`);
  return { requestId: valueAfter(args, 0, "--request") };
}

function parseRequestClose(args: string[]): { requestId: string; disposition: ClosureDisposition; statement: string } {
  let requestId: string | undefined;
  let disposition: ClosureDisposition | undefined;
  let statement: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--request") requestId = value;
    else if (option === "--statement") statement = value;
    else if (option === "--disposition") {
      if (!["addressed", "declined", "withdrawn"].includes(value)) throw new UsageError(`invalid Request disposition: ${value}`);
      disposition = value as ClosureDisposition;
    } else throw new UsageError(`unknown option: ${option}`);
  }
  if (requestId === undefined) throw new UsageError("--request is required");
  if (disposition === undefined) throw new UsageError("--disposition is required");
  if (statement === undefined) throw new UsageError("--statement is required");
  return { requestId, disposition, statement };
}

function parseGoalCreate(args: string[]): {
  title: string;
  outcome: string;
  approval: string;
  constraints: string[];
  sourceRequests: string[];
  repositoryIdentity?: string;
} {
  let title: string | undefined;
  let outcome: string | undefined;
  let approval: string | undefined;
  let repositoryIdentity: string | undefined;
  const constraints: string[] = [];
  const sourceRequests: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    switch (option) {
      case "--title": title = value; break;
      case "--outcome": outcome = value; break;
      case "--approval": approval = value; break;
      case "--constraint": constraints.push(value); break;
      case "--request": sourceRequests.push(value); break;
      case "--repository-id": repositoryIdentity = value; break;
      default: throw new UsageError(`unknown option: ${option}`);
    }
  }

  if (title === undefined) throw new UsageError("--title is required");
  if (outcome === undefined) throw new UsageError("--outcome is required");
  if (approval === undefined) throw new UsageError("--approval is required");
  return { title, outcome, approval, constraints, sourceRequests, ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }) };
}

function parseGoalQueue(args: string[]): { goalId: string; targetBranch: string; approval: string } {
  let goalId: string | undefined;
  let targetBranch: string | undefined;
  let approval: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--target") targetBranch = value;
    else if (option === "--approval") approval = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (targetBranch === undefined) throw new UsageError("--target is required");
  if (approval === undefined) throw new UsageError("--approval is required");
  return { goalId, targetBranch, approval };
}

function parseApplicationIdentity(args: string[], options: { ticket?: boolean; instruction?: boolean; reason?: boolean } = {}): { goalId: string; applicationId: string; ticketId?: string; instruction?: string; reason?: string } {
  let goalId: string | undefined; let applicationId: string | undefined; let ticketId: string | undefined; let instruction: string | undefined; let reason: string | undefined;
  for (let index = 0; index < args.length; index += 2) { const option = args[index]!; const value = valueAfter(args, index, option); if (option === "--goal") goalId = value; else if (option === "--application") applicationId = value; else if (option === "--ticket" && options.ticket) ticketId = value; else if (option === "--instruction" && options.instruction) instruction = value; else if (option === "--reason" && options.reason) reason = value; else throw new UsageError(`unknown option: ${option}`); }
  if (goalId === undefined) throw new UsageError("--goal is required"); if (applicationId === undefined) throw new UsageError("--application is required"); if (options.ticket && ticketId === undefined) throw new UsageError("--ticket is required"); if (options.instruction && instruction === undefined) throw new UsageError("--instruction is required"); return { goalId, applicationId, ...(ticketId === undefined ? {} : { ticketId }), ...(instruction === undefined ? {} : { instruction }), ...(reason === undefined ? {} : { reason }) };
}

function parseApplicationReportPublish(args: string[]): { goalId: string; applicationId: string; ticketId: string; worker: string; summary: string } {
  let goalId: string | undefined; let applicationId: string | undefined; let ticketId: string | undefined; let worker: string | undefined; let summary: string | undefined;
  for (let index = 0; index < args.length; index += 2) { const option = args[index]!; const value = valueAfter(args, index, option); if (option === "--goal") goalId = value; else if (option === "--application") applicationId = value; else if (option === "--ticket") ticketId = value; else if (option === "--worker") worker = value; else if (option === "--commit-summary") summary = value; else throw new UsageError(`unknown option: ${option}`); }
  if (goalId === undefined) throw new UsageError("--goal is required"); if (applicationId === undefined) throw new UsageError("--application is required"); if (ticketId === undefined) throw new UsageError("--ticket is required"); if (worker === undefined) throw new UsageError("--worker is required"); if (summary === undefined) throw new UsageError("--commit-summary is required"); return { goalId, applicationId, ticketId, worker, summary };
}

function parseApplicationPartialPublish(args: string[]): { goalId: string; applicationId: string; ticketId: string; worker: string; reason: string } {
  let goalId: string | undefined, applicationId: string | undefined, ticketId: string | undefined, worker: string | undefined, reason: string | undefined;
  for (let index = 0; index < args.length; index += 2) { const option = args[index]!, value = valueAfter(args, index, option); if (option === "--goal") goalId = value; else if (option === "--application") applicationId = value; else if (option === "--ticket") ticketId = value; else if (option === "--worker") worker = value; else if (option === "--reason") reason = value; else throw new UsageError(`unknown option: ${option}`); }
  if (!goalId) throw new UsageError("--goal is required"); if (!applicationId) throw new UsageError("--application is required"); if (!ticketId) throw new UsageError("--ticket is required"); if (!worker) throw new UsageError("--worker is required"); if (!reason) throw new UsageError("--reason is required"); return { goalId, applicationId, ticketId, worker, reason };
}

function parseApplicationApplyHead(args: string[]): { goalId: string; applicationId: string } {
  let goalId: string | undefined;
  let applicationId: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!; const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--application") applicationId = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (applicationId === undefined) throw new UsageError("--application is required");
  return { goalId, applicationId };
}

function parseChangeCreate(args: string[]): {
  goalId: string;
  title: string;
  intent: string;
  rationale: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  dependencies: string[];
} {
  let goalId: string | undefined;
  let title: string | undefined;
  let intent: string | undefined;
  let rationale: string | undefined;
  const acceptanceCriteria: string[] = [];
  const nonGoals: string[] = [];
  const dependencies: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    switch (option) {
      case "--goal": goalId = value; break;
      case "--title": title = value; break;
      case "--intent": intent = value; break;
      case "--rationale": rationale = value; break;
      case "--acceptance": acceptanceCriteria.push(value); break;
      case "--non-goal": nonGoals.push(value); break;
      case "--dependency": dependencies.push(value); break;
      default: throw new UsageError(`unknown option: ${option}`);
    }
  }

  if (goalId === undefined) throw new UsageError("--goal is required");
  if (title === undefined) throw new UsageError("--title is required");
  if (intent === undefined) throw new UsageError("--intent is required");
  if (rationale === undefined) throw new UsageError("--rationale is required");
  if (acceptanceCriteria.length === 0) throw new UsageError("--acceptance is required");
  return { goalId, title, intent, rationale, acceptanceCriteria, nonGoals, dependencies };
}

function parseTicketIssue(args: string[]): {
  goalId: string;
  changeId: string;
  instruction: string;
  curatedContext?: string;
  role: "implement" | "review";
  producingImplementationTicketId?: string;
  responseToReviewTicketId?: string;
  executionPolicy?: Partial<ExecutionPolicy>;
  model?: string;
  thinking?: ThinkingLevel;
} {
  let goalId: string | undefined;
  let changeId: string | undefined;
  let instruction: string | undefined;
  let curatedContext: string | undefined;
  let producingImplementationTicketId: string | undefined;
  let responseToReviewTicketId: string | undefined;
  let role: "implement" | "review" = "implement";
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;
  let isolation: ExecutionPolicy["isolation"] | undefined;
  let networkAccess: ExecutionPolicy["networkAccess"] | undefined;
  let clearCredentials = false;
  const credentialGrants: string[] = [];

  for (let index = 0; index < args.length;) {
    const option = args[index]!;
    if (option === "--clear-credentials") {
      clearCredentials = true;
      index++;
      continue;
    }
    const value = valueAfter(args, index, option);
    switch (option) {
      case "--goal": goalId = value; break;
      case "--change": changeId = value; break;
      case "--instruction": instruction = value; break;
      case "--context": curatedContext = value; break;
      case "--role":
        if (value !== "implement" && value !== "review") throw new UsageError(`unsupported Ticket role: ${value}`);
        role = value;
        break;
      case "--implementation-ticket": producingImplementationTicketId = value; break;
      case "--response-to-review": responseToReviewTicketId = value; break;
      case "--isolation":
        if (value !== "workspace" && value !== "container") throw new UsageError(`invalid isolation level: ${value}`);
        isolation = value;
        break;
      case "--network-access":
        if (value !== "none" && value !== "restricted" && value !== "unrestricted") {
          throw new UsageError(`invalid network access: ${value}`);
        }
        networkAccess = value;
        break;
      case "--credential": credentialGrants.push(value); break;
      case "--model": model = value; break;
      case "--thinking":
        if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
          throw new UsageError(`invalid thinking level: ${value}`);
        }
        thinking = value as ThinkingLevel;
        break;
      default: throw new UsageError(`unknown option: ${option}`);
    }
    index += 2;
  }

  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (instruction === undefined) throw new UsageError("--instruction is required");
  if (clearCredentials && credentialGrants.length > 0) throw new UsageError("--clear-credentials cannot be combined with --credential");
  const executionPolicy = {
    ...(isolation === undefined ? {} : { isolation }),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    ...(clearCredentials ? { credentialGrants: [] } : credentialGrants.length === 0 ? {} : { credentialGrants }),
  };
  return {
    goalId,
    changeId,
    instruction,
    role,
    ...(Object.keys(executionPolicy).length === 0 ? {} : { executionPolicy }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(curatedContext === undefined ? {} : { curatedContext }),
    ...(producingImplementationTicketId === undefined ? {} : { producingImplementationTicketId }),
    ...(responseToReviewTicketId === undefined ? {} : { responseToReviewTicketId }),
  };
}

function parsePiDispatch(args: string[]): {
  goalId: string;
  changeId: string;
  ticketId: string;
  worker: string;
  host?: "herdr" | "direct";
} {
  let goalId: string | undefined;
  let changeId: string | undefined;
  let ticketId: string | undefined;
  let worker: string | undefined;
  let host: "herdr" | "direct" | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--change") changeId = value;
    else if (option === "--ticket") ticketId = value;
    else if (option === "--worker") worker = value;
    else if (option === "--host") {
      if (value !== "herdr" && value !== "direct") throw new UsageError(`unsupported Pi worker host: ${value}`);
      host = value;
    } else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (ticketId === undefined) throw new UsageError("--ticket is required");
  if (worker === undefined) throw new UsageError("--worker is required");
  return { goalId, changeId, ticketId, worker, ...(host === undefined ? {} : { host }) };
}

function parseApplicationPiDispatch(args: string[]): { goalId: string; applicationId: string; ticketId: string; worker: string } {
  let goalId: string | undefined, applicationId: string | undefined, ticketId: string | undefined, worker: string | undefined;
  for (let index = 0; index < args.length; index += 2) { const option = args[index]!, value = valueAfter(args, index, option); if (option === "--goal") goalId = value; else if (option === "--application") applicationId = value; else if (option === "--ticket") ticketId = value; else if (option === "--worker") worker = value; else throw new UsageError(`unknown option: ${option}`); }
  if (!goalId) throw new UsageError("--goal is required"); if (!applicationId) throw new UsageError("--application is required"); if (!ticketId) throw new UsageError("--ticket is required"); if (!worker) throw new UsageError("--worker is required"); return { goalId, applicationId, ticketId, worker };
}

function parseApplicationTestDispatch(args: string[]): { goalId: string; applicationId: string; ticketId: string; worker: string; command: string[] } {
  const separator = args.indexOf("--"); if (separator === -1) throw new UsageError("application ticket dispatch-test requires -- before the worker command");
  const options = args.slice(0, separator), command = args.slice(separator + 1); if (!command.length) throw new UsageError("application ticket dispatch-test requires a worker command after --");
  let goalId: string | undefined, applicationId: string | undefined, ticketId: string | undefined, worker: string | undefined;
  for (let index = 0; index < options.length; index += 2) { const option = options[index]!, value = valueAfter(options, index, option); if (option === "--goal") goalId = value; else if (option === "--application") applicationId = value; else if (option === "--ticket") ticketId = value; else if (option === "--worker") worker = value; else throw new UsageError(`unknown option: ${option}`); }
  if (!goalId) throw new UsageError("--goal is required"); if (!applicationId) throw new UsageError("--application is required"); if (!ticketId) throw new UsageError("--ticket is required"); if (!worker) throw new UsageError("--worker is required"); return { goalId, applicationId, ticketId, worker, command };
}

function parseTestDispatch(args: string[]): {
  goalId: string;
  changeId: string;
  ticketId: string;
  worker: string;
  environmentDigest?: string;
  command: string[];
} {
  const separator = args.indexOf("--");
  if (separator === -1) throw new UsageError("ticket dispatch-test requires -- before the worker command");
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (command.length === 0) throw new UsageError("ticket dispatch-test requires a worker command after --");

  let goalId: string | undefined;
  let changeId: string | undefined;
  let ticketId: string | undefined;
  let worker: string | undefined;
  let environmentDigest: string | undefined;
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index]!;
    const value = valueAfter(options, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--change") changeId = value;
    else if (option === "--ticket") ticketId = value;
    else if (option === "--worker") worker = value;
    else if (option === "--environment-digest") environmentDigest = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (ticketId === undefined) throw new UsageError("--ticket is required");
  if (worker === undefined) throw new UsageError("--worker is required");
  return {
    goalId,
    changeId,
    ticketId,
    worker,
    command,
    ...(environmentDigest === undefined ? {} : { environmentDigest }),
  };
}

function parseWorkerIdentity(args: string[]): { goalId: string; changeId: string; ticketId: string } {
  let goalId: string | undefined;
  let changeId: string | undefined;
  let ticketId: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--change") changeId = value;
    else if (option === "--ticket") ticketId = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (ticketId === undefined) throw new UsageError("--ticket is required");
  return { goalId, changeId, ticketId };
}

function parseWorkerRead(args: string[]): { goalId: string; changeId: string; ticketId: string; lines?: number; ansi?: boolean } {
  const identity: string[] = [];
  let lines: number | undefined;
  let ansi = false;
  for (let index = 0; index < args.length;) {
    const option = args[index]!;
    if (option === "--ansi") {
      ansi = true;
      index++;
      continue;
    }
    const value = valueAfter(args, index, option);
    if (option === "--lines") {
      lines = Number(value);
      if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) throw new UsageError("--lines must be an integer from 1 to 10000");
    } else if (["--goal", "--change", "--ticket"].includes(option)) {
      identity.push(option, value);
    } else throw new UsageError(`unknown option: ${option}`);
    index += 2;
  }
  return { ...parseWorkerIdentity(identity), ...(lines === undefined ? {} : { lines }), ...(ansi ? { ansi: true } : {}) };
}

function parseWorkerSubmission(args: string[], command: "complete" | "block"): { file?: string } {
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== "--file") throw new UsageError(`unknown worker ${command} option: ${args[0]}`);
  return { file: valueAfter(args, 0, "--file") };
}

function parseReportPublish(args: string[]): {
  goalId: string;
  changeId: string;
  ticketId: string;
  commitSummary?: string;
  commitBody?: string;
  failure?: string;
} {
  let goalId: string | undefined;
  let changeId: string | undefined;
  let ticketId: string | undefined;
  let commitSummary: string | undefined;
  let commitBody: string | undefined;
  let failure: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--change") changeId = value;
    else if (option === "--ticket") ticketId = value;
    else if (option === "--commit-summary") commitSummary = value;
    else if (option === "--commit-body") commitBody = value;
    else if (option === "--failure") failure = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (ticketId === undefined) throw new UsageError("--ticket is required");
  if (failure !== undefined && (commitSummary !== undefined || commitBody !== undefined)) {
    throw new UsageError("--failure cannot be combined with Candidate commit message options");
  }
  return {
    goalId,
    changeId,
    ticketId,
    ...(commitSummary === undefined ? {} : { commitSummary }),
    ...(commitBody === undefined ? {} : { commitBody }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function parseGoalPlanner(args: string[]): { goalId: string } {
  if (args.length !== 2 || args[0] !== "--goal") throw new UsageError(args.length === 0 ? "--goal is required" : `unknown planner option: ${args[0]}`);
  return { goalId: valueAfter(args, 0, "--goal") };
}

function parseStatus(args: string[]): { goalId?: string; operational?: boolean } {
  let goalId: string | undefined;
  let operational = false;
  for (let index = 0; index < args.length;) {
    const option = args[index]!;
    if (option === "--operational") { operational = true; index += 1; continue; }
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else throw new UsageError(`unknown status option: ${option}`);
    index += 2;
  }
  if (operational && goalId !== undefined) throw new UsageError("--operational is available only for repository status");
  return { ...(goalId === undefined ? {} : { goalId }), ...(operational ? { operational: true } : {}) };
}

function parseGuidanceShow(args: string[]): { step: GuidanceStep; goalId?: string; changeId?: string } {
  let step: GuidanceStep | undefined;
  let goalId: string | undefined;
  let changeId: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--step") {
      const parsed = guidanceStepSchema.safeParse(value);
      if (!parsed.success) throw new UsageError(`unsupported guidance step: ${value}`);
      step = parsed.data;
    } else if (option === "--goal") goalId = value;
    else if (option === "--change") changeId = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (step === undefined) throw new UsageError("--step is required");
  const needsGoal = step !== "goal";
  const needsChange = ["implement", "review", "remediate", "decide"].includes(step);
  if (needsGoal && goalId === undefined) throw new UsageError(`--goal is required for ${step} guidance`);
  if (needsChange && changeId === undefined) throw new UsageError(`--change is required for ${step} guidance`);
  if (step === "goal" && (goalId !== undefined || changeId !== undefined)) {
    throw new UsageError("goal guidance does not accept Goal or Change identity");
  }
  if (!needsChange && changeId !== undefined) throw new UsageError(`${step} guidance does not accept --change`);
  return {
    step,
    ...(goalId === undefined ? {} : { goalId }),
    ...(changeId === undefined ? {} : { changeId }),
  };
}

function parsePlanRevise(args: string[]): { goalId: string; file?: string } {
  let goalId: string | undefined;
  let file: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--file") file = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  return { goalId, ...(file === undefined ? {} : { file }) };
}

function parseChangeDecision(
  args: string[],
  disposition: "land" | "reject" | "abandon",
): { goalId: string; changeId: string; statement?: string } {
  let goalId: string | undefined;
  let changeId: string | undefined;
  let statement: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--change") changeId = value;
    else if (option === "--statement") statement = value;
    else throw new UsageError(`unknown option: ${option}`);
  }
  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (disposition !== "land" && statement === undefined) throw new UsageError("--statement is required");
  return { goalId, changeId, ...(statement === undefined ? {} : { statement }) };
}

function parseRecover(args: string[]): { goalId?: string; reason?: string; goalLocal?: boolean } {
  let goalId: string | undefined;
  let reason: string | undefined;
  let goalLocal = false;
  for (let index = 0; index < args.length;) {
    const option = args[index]!;
    if (option === "--goal-local") { goalLocal = true; index += 1; continue; }
    const value = valueAfter(args, index, option);
    if (option === "--goal") goalId = value;
    else if (option === "--reason") reason = value;
    else throw new UsageError(`unknown option: ${option}`);
    index += 2;
  }
  if (goalLocal && goalId === undefined) throw new UsageError("--goal-local requires --goal");
  return {
    ...(goalId === undefined ? {} : { goalId }),
    ...(reason === undefined ? {} : { reason }),
    ...(goalLocal ? { goalLocal: true } : {}),
  };
}

async function stdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

async function planBody(cwd: string, file: string | undefined): Promise<string> {
  return file === undefined || file === "-" ? stdinText() : readFile(resolve(cwd, file), "utf8");
}

function humanGoalStatus(status: DerivedGoalStatus): string {
  const lines = [`Goal ${status.goalId}`, `  Integrated ${status.integratedRevision}`];
  const change = status.currentChange;
  if (change === null) lines.push("  Current Change none");
  else {
    lines.push(`  Current Change ${change.changeId}`);
    lines.push(`  Candidate ${change.candidate?.revision ?? "none"}`);
    lines.push(change.review === null ? "  Review none" : `  Review ${change.review.verdict} (Ticket ${change.review.ticketId})`);
    lines.push(change.openTicket === null ? "  Open Ticket none" : `  Open Ticket ${change.openTicket.ticketId} (${change.openTicket.role})`);
    lines.push(change.latestReport === null
      ? "  Latest Report none"
      : `  Latest Report ${change.latestReport.ticketId} ${change.latestReport.outcome}`);
    if (change.churnWarnings.length > 0) lines.push(`  Churn warnings ${change.churnWarnings.length}`);
  }
  for (const decision of status.decisions) lines.push(`  Decision ${decision.changeId} ${decision.disposition}`);
  if (status.application.length === 0) lines.push("  Applications none");
  else for (const application of status.application) lines.push(`  Application ${application.applicationId} ${application.state}${application.churnWarnings.length ? `; churn warnings ${application.churnWarnings.length}` : ""}`);
  lines.push(status.frozen ? "  Goal frozen by Application evidence" : "  Goal unfrozen");
  lines.push(status.cleanup.healthy ? "  Cleanup healthy" : `  Cleanup warnings ${status.cleanup.warnings.length}`);
  return `${lines.join("\n")}\n`;
}

function humanRepositoryStatus(status: DerivedRepositoryStatus): string {
  const heading = `Project ${status.project.slug}\nRepository ${status.root}\n`;
  if (status.goals.length === 0) return `${heading}  No Goals\n  Cleanup healthy\n`;
  const queue = status.applicationQueue.length === 0 ? "  Application queue empty\n" : `${status.applicationQueue.map((entry) => `  Queue ${entry.queuePosition} ${entry.goalId}/${entry.applicationId} ${entry.state}${entry.churnWarnings.length ? `; churn warnings ${entry.churnWarnings.length}` : ""}`).join("\n")}\n`;
  const head = status.queueHead === null ? "  Queue head none\n" : `  Queue head ${status.queueHead.goalId}/${status.queueHead.applicationId} (${status.queueHead.queuePosition})\n`;
  return `${heading}${queue}${head}${status.goals.map(humanGoalStatus).join("")}`;
}

function decisionData(decision: ChangeDecision): unknown {
  return { ...decision.metadata, statement: decision.body.trim() };
}

function humanCleanup(cleanup: ReportPublicationCleanup): string {
  return cleanup.status === "finalized"
    ? "  Worker resources finalized\n"
    : `  Cleanup warning (${cleanup.phase}): ${cleanup.message}\n`;
}

function humanReconciliation(goals: ReconciledGoal[], ignored = 0): string {
  const lines = [`Reconciled ${goals.length} Goal${goals.length === 1 ? "" : "s"}`];
  for (const goal of goals) {
    lines.push(
      `  ${goal.goalId}: ${goal.integratedRevision}; interrupted ${goal.interruptedTickets.length}; cleanup warnings ${goal.cleanupWarnings.length}`,
    );
  }
  if (ignored > 0) lines.push(`Ignored unpublished Goals ${ignored}`);
  return `${lines.join("\n")}\n`;
}

export async function run(rawArgs = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let args = rawArgs.filter((arg) => arg !== "--json");
  let json = rawArgs.includes("--json");
  let command = commandName(args);
  try {
    ({ args, json } = extractJson(rawArgs));
    command = commandName(args);

    if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
      return success(json, "help", { version, usage: usage() }, usage());
    }
    if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) {
      return success(json, "version", { version }, `${version}\n`);
    }

    if (args[0] === "project" && args[1] === "activate") {
      if (args.length !== 2) throw new UsageError(`unknown project option: ${args[2]}`);
      const project = await activateProject(cwd);
      return success(json, "project activate", { slug: project.slug, root: project.root, activeCheckout: project.registration.activeCheckout }, `Activated Project ${project.slug}\n`);
    }

    if (args[0] === "request" && args[1] === "create") {
      const created = await createRequest(parseRequestCreate(args.slice(2)));
      return success(json, "request create", created, `Created Request ${created.metadata.requestId}\n`);
    }

    if (args[0] === "request" && args[1] === "list") {
      const requests = await listRequests(parseRequestList(args.slice(2)));
      const human = requests.map((request) => `${request.metadata.requestId} ${request.title} ${request.state} ${request.metadata.projects.join(",") || "unassigned"}`).join("\n");
      return success(json, "request list", requests, human ? `${human}\n` : "");
    }

    if (args[0] === "request" && args[1] === "show") {
      const request = await loadRequest(requestDataRoot(), parseRequestShow(args.slice(2)).requestId);
      return success(json, "request show", request, `Request ${request.metadata.requestId} (${request.state})\n\n${request.body}`);
    }

    if (args[0] === "request" && args[1] === "close") {
      const closed = await closeRequest(parseRequestClose(args.slice(2)));
      return success(json, "request close", closed, `Closed Request ${closed.metadata.requestId} (${closed.closure!.metadata.disposition})\n`);
    }

    if (args[0] === "planner") {
      if (args.length === 1) {
        if (json) throw new UsageError("planner does not support --json");
        return launchPlanner({
          cwd,
          ...(process.env["SPIKE_PI_BIN"] === undefined ? {} : { piExecutable: process.env["SPIKE_PI_BIN"] }),
        });
      }
      const action = args[1];
      if (!["start-or-reattach", "observe", "attach", "replace"].includes(action ?? "")) {
        throw new UsageError(`unknown planner option: ${action}`);
      }
      if (action === "attach" && json) throw new UsageError("planner attach does not support --json");
      const input = { cwd, ...parseGoalPlanner(args.slice(2)) };
      if (action === "attach") return goalPlannerOperations.attach(input);
      const result = action === "observe"
        ? await goalPlannerOperations.observe(input)
        : action === "replace"
          ? await goalPlannerOperations.replace(input)
          : await goalPlannerOperations.startOrReattach(input);
      return success(json, `planner ${action}`, result, `Goal planner ${result.name}: ${result.state}\n`);
    }

    if (args[0] === "status") {
      const input = parseStatus(args.slice(1));
      if (input.goalId !== undefined) {
        const status = await deriveGoalStatus(cwd, input.goalId);
        return success(json, "status", status, humanGoalStatus(status));
      }
      if (input.operational) {
        const status = await deriveSupervisorPlannerStatus(cwd);
        const plannerLines = `${status.planners.map((planner) => `  Planner ${planner.goalId} ${planner.state}`).join("\n")}${status.planners.length === 0 ? "" : "\n"}`;
        return success(json, "status", status, `${humanRepositoryStatus(status.durable)}${plannerLines}`);
      }
      const status = await deriveRepositoryStatus(cwd);
      return success(json, "status", status, humanRepositoryStatus(status));
    }

    if (args[0] === "guidance" && args[1] === "show") {
      const input = parseGuidanceShow(args.slice(2));
      const guidance = await selectGuidance({ cwd, ...input });
      return success(
        json,
        "guidance show",
        {
          step: guidance.step,
          path: guidance.path,
          sourceRevision: guidance.revision,
          markdown: guidance.markdown,
        },
        `Guidance ${guidance.step}\n  ${guidance.path}\n  Source ${guidance.revision}\n\n${guidance.markdown}`,
      );
    }

    if (args[0] === "goal" && args[1] === "queue") {
      const input = parseGoalQueue(args.slice(2));
      const queued = await queueGoalIntegration({ cwd, ...input });
      return success(json, "goal queue", queued,
        `Queued Goal ${queued.goalId} for main at FIFO position ${queued.queuePosition}\n` +
        `  Application ${queued.applicationId}\n` +
        `  Planner cleanup ${queued.plannerCleanup.status}\n`);
    }

    if (args[0] === "application" && args[1] === "review" && args[2] === "issue") {
      const input = parseApplicationIdentity(args.slice(3), { instruction: true });
      const issued = await issueApplicationReviewTicket({ cwd, goalId: input.goalId, applicationId: input.applicationId, instruction: input.instruction! });
      return success(json, "application review issue", { ticket: issued.ticket.metadata }, `Issued Application review Ticket ${input.goalId}/${input.applicationId}/${issued.ticket.metadata.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "prepare") {
      const input = parseApplicationIdentity(args.slice(3), { ticket: true }); const repository = await discoverRepository(cwd);
      const exchange = await prepareApplicationReviewExchange(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId! });
      return success(json, "application review prepare", exchange, `Prepared Application review Ticket ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "dispatch-pi") {
      const input = parseApplicationPiDispatch(args.slice(3)); const dispatched = await dispatchApplicationReviewPiTicket({ cwd, ...input });
      return success(json, "application review dispatch-pi", { ticket: input, execution: dispatched.execution }, `Dispatched Application review ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "dispatch-test") {
      const input = parseApplicationTestDispatch(args.slice(3)); const dispatched = await dispatchApplicationReviewWorker({ cwd, ...input });
      return success(json, "application review dispatch-test", { ticket: { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId }, execution: dispatched.execution }, `Dispatched Application review ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "worker" && args[3] === "status") {
      const input = parseApplicationIdentity(args.slice(4), { ticket: true }), repository = await discoverRepository(cwd), observed = await observeApplicationReviewWorker(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId! });
      return success(json, "application review worker status", { ticket: input, ...observed }, `Application review Worker ${input.ticketId} ${observed.status}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "worker" && args[3] === "read") {
      const input = parseApplicationIdentity(args.slice(4), { ticket: true }), repository = await discoverRepository(cwd), terminal = await readApplicationReviewWorker(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId! });
      return success(json, "application review worker read", { ticket: input, terminal }, terminal);
    }
    if (args[0] === "application" && args[1] === "review" && (args[2] === "publish" || (args[2] === "report" && args[3] === "publish"))) {
      const input = parseApplicationPiDispatch(args.slice(args[2] === "report" ? 4 : 3)); const repository = await discoverRepository(cwd), execution = await loadFinishedApplicationReviewWorker(repository.root, input);
      if (execution.worker !== input.worker) throw new UsageError("application review publish worker does not match recorded Application review Worker");
      const published = await publishApplicationReviewReport({ cwd: repository.root, ...input, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
      return success(json, "application review publish", { report: published.report.metadata }, `Published Application review Report ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "status") {
      const input = parseApplicationIdentity(args.slice(3)); const status = await deriveApplicationReviewStatus(cwd, input.goalId, input.applicationId);
      return success(json, "application review status", status, `Application review approval ${status.approvalUsable ? "usable" : "unusable"}\n`);
    }
    if (args[0] === "application" && args[1] === "review" && args[2] === "recover") {
      const input = parseApplicationIdentity(args.slice(3), { ticket: true, reason: true }); const result = await recoverApplicationReviewTicket(cwd, input.goalId, input.applicationId, input.ticketId!, input.reason);
      return success(json, "application review recover", result, `Recovered Application review Ticket ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "ticket" && args[2] === "issue") {
      const input = parseApplicationIdentity(args.slice(3), { instruction: true });
      const issued = await issueApplicationTicket({ cwd, goalId: input.goalId, applicationId: input.applicationId, instruction: input.instruction! });
      return success(json, "application ticket issue", { ticket: issued.ticket.metadata, path: relative(issued.root, `goals/${input.goalId}/applications/${input.applicationId}/tickets/${issued.ticket.metadata.ticketId}/ticket.md`) }, `Issued Application Ticket ${input.goalId}/${input.applicationId}/${issued.ticket.metadata.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "ticket" && args[2] === "dispatch-pi") {
      const input = parseApplicationPiDispatch(args.slice(3)); const dispatched = await dispatchApplicationPiTicket({ cwd, ...input });
      return success(json, "application ticket dispatch-pi", { ticket: { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId }, execution: dispatched.execution }, `Dispatched Application Pi Ticket ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "ticket" && args[2] === "dispatch-test") {
      const input = parseApplicationTestDispatch(args.slice(3)); const dispatched = await dispatchApplicationWorker({ cwd, ...input });
      return success(json, "application ticket dispatch-test", { ticket: { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId }, execution: dispatched.execution, paths: { input: relative(dispatched.root, dispatched.exchange.inputDirectory), output: relative(dispatched.root, dispatched.exchange.outputDirectory) } }, `Dispatched Application Ticket ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }
    if (args[0] === "application" && args[1] === "worker" && args[2] === "status") {
      const input = parseApplicationIdentity(args.slice(3), { ticket: true }); const repository = await discoverRepository(cwd); const observed = await observeApplicationWorker(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId! });
      return success(json, "application worker status", { ticket: { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId }, ...observed }, `Application Worker ${input.goalId}/${input.applicationId}/${input.ticketId} ${observed.status}\n`);
    }
    if (args[0] === "application" && args[1] === "worker" && args[2] === "read") {
      const input = parseApplicationIdentity(args.slice(3), { ticket: true }); const repository = await discoverRepository(cwd); const terminal = await readApplicationWorker(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId! });
      return success(json, "application worker read", { ticket: { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId }, terminal }, terminal);
    }
    if (args[0] === "application" && args[1] === "ticket" && args[2] === "prepare") {
      const input = parseApplicationIdentity(args.slice(3), { ticket: true }); const repository = await discoverRepository(cwd);
      const exchange = await prepareApplicationTicketExchange(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId! });
      return success(json, "application ticket prepare", exchange, `Prepared Application Ticket ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "report" && args[2] === "blocked") {
      const input = parseApplicationPiDispatch(args.slice(3)); const repository = await discoverRepository(cwd), execution = await loadFinishedApplicationWorker(repository.root, input);
      if (execution.worker !== input.worker) throw new UsageError("application blocked publish worker does not match the recorded Application Worker");
      const published = await publishApplicationImplementationReport({ cwd: repository.root, ...input, message: { summary: "Blocked Application Ticket" }, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
      return success(json, "application report blocked", { report: published.report.metadata }, `Published blocked Application Report ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "report" && args[2] === "partial") {
      const input = parseApplicationPartialPublish(args.slice(3)); const repository = await discoverRepository(cwd);
      const execution = await loadFinishedApplicationWorker(repository.root, input);
      if (execution.worker !== input.worker) throw new UsageError("application partial publish worker does not match the recorded Application Worker");
      const published = await publishApplicationPartialReport({ cwd: repository.root, ...input, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
      return success(json, "application report partial", { report: published.report.metadata }, `Published partial Application Report ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "report" && args[2] === "publish") {
      const input = parseApplicationReportPublish(args.slice(3)); const repository = await discoverRepository(cwd);
      const execution = await loadFinishedApplicationWorker(repository.root, { goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId });
      if (execution.worker !== input.worker) throw new UsageError("application report publish worker does not match the recorded Application Worker");
      const published = await publishApplicationImplementationReport({ cwd: repository.root, goalId: input.goalId, applicationId: input.applicationId, ticketId: input.ticketId, message: { summary: input.summary }, execution: { adapter: execution.adapter, isolation: execution.isolation, worker: execution.worker, model: execution.model, thinking: execution.thinking, startedAt: execution.startedAt, finishedAt: execution.finishedAt } });
      return success(json, "application report publish", { report: published.report.metadata }, `Published Application Report ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "status") {
      const input = parseApplicationIdentity(args.slice(2)); const status = await deriveApplicationStatus(cwd, input.goalId, input.applicationId);
      return success(json, "application status", status, `Application ${input.goalId}/${input.applicationId}\n  Open Ticket ${status.openTicketId ?? "none"}\n  Candidate ${status.candidate?.revision ?? "none"}\n  Target mismatch ${status.targetMismatch ? "yes" : "no"}\n  Review ${status.review === null ? "unavailable" : JSON.stringify(status.review)}\n  Churn warnings ${status.churnWarnings.length}\n`);
    }

    if (args[0] === "application" && args[1] === "recover") {
      const input = parseApplicationIdentity(args.slice(2), { ticket: true, reason: true }); const recovered = await recoverApplicationTicket(cwd, input.goalId, input.applicationId, input.ticketId!, input.reason);
      return success(json, "application recover", recovered, `Recovered Application Ticket ${input.goalId}/${input.applicationId}/${input.ticketId}\n`);
    }

    if (args[0] === "application" && args[1] === "apply-head") {
      const input = parseApplicationApplyHead(args.slice(2));
      const applied = await applyQueueHead({ cwd, ...input });
      return success(json, "application apply-head", applied,
        `Applied FIFO head ${applied.goalId}/${applied.applicationId} to main\n` +
        `  Previous target revision ${applied.previousTargetRevision}\n` +
        `  Resulting target revision ${applied.resultingTargetRevision}\n`);
    }

    if (args[0] === "goal" && args[1] === "create") {
      const input = parseGoalCreate(args.slice(2));
      const created = await createGoal({ cwd, ...input });
      const goalId = created.goal.metadata.goalId;
      return success(
        json,
        "goal create",
        {
          goal: created.goal.metadata,
          paths: {
            goal: relative(created.root, goalPath(created.root, goalId)),
            plan: relative(created.root, planPath(created.root, goalId)),
          },
        },
        `Created Goal ${goalId}\n` +
          `  ${relative(created.root, goalPath(created.root, goalId))}\n` +
          `  ${relative(created.root, planPath(created.root, goalId))}\n`,
      );
    }

    if (args[0] === "plan" && args[1] === "revise") {
      const input = parsePlanRevise(args.slice(2));
      const repository = await discoverRepository(cwd);
      const revised = await revisePlan(repository.root, input.goalId, await planBody(cwd, input.file));
      return success(
        json,
        "plan revise",
        { metadata: revised.metadata, body: revised.body },
        `Revised Plan ${input.goalId}\n`,
      );
    }

    if (args[0] === "change" && args[1] === "create") {
      const input = parseChangeCreate(args.slice(2));
      const created = await createChange({ cwd, ...input });
      const { goalId, changeId } = created.change.metadata;
      return success(
        json,
        "change create",
        {
          change: created.change.metadata,
          path: relative(created.root, changePath(created.root, goalId, changeId)),
        },
        `Created Change ${goalId}/${changeId}\n` +
          `  ${relative(created.root, changePath(created.root, goalId, changeId))}\n`,
      );
    }

    if (args[0] === "change" && ["land", "reject", "abandon"].includes(args[1] ?? "")) {
      const disposition = args[1] as "land" | "reject" | "abandon";
      const input = parseChangeDecision(args.slice(2), disposition);
      const resolved = disposition === "land"
        ? await landChange({ cwd, goalId: input.goalId, changeId: input.changeId, ...(input.statement === undefined ? {} : { statement: input.statement }) })
        : disposition === "reject"
          ? await rejectChange({ cwd, goalId: input.goalId, changeId: input.changeId, statement: input.statement! })
          : await abandonChange({ cwd, goalId: input.goalId, changeId: input.changeId, statement: input.statement! });
      return success(
        json,
        `change ${disposition}`,
        decisionData(resolved.decision),
        `${disposition === "land" ? "Landed" : disposition === "reject" ? "Rejected" : "Abandoned"} Change ${input.goalId}/${input.changeId}\n`,
      );
    }

    if (args[0] === "ticket" && args[1] === "issue") {
      const input = parseTicketIssue(args.slice(2));
      const issued = await issueTicket({ cwd, ...input });
      const { goalId, changeId, ticketId } = issued.ticket.metadata;
      return success(
        json,
        "ticket issue",
        {
          ticket: issued.ticket.metadata,
          path: relative(issued.root, ticketPath(issued.root, goalId, changeId, ticketId)),
        },
        `Issued Ticket ${goalId}/${changeId}/${ticketId}\n` +
          `  ${relative(issued.root, ticketPath(issued.root, goalId, changeId, ticketId))}\n`,
      );
    }

    if (args[0] === "ticket" && args[1] === "dispatch-pi") {
      const input = parsePiDispatch(args.slice(2));
      const dispatched = await dispatchPiTicket({
        cwd,
        ...input,
        ...(process.env["SPIKE_PI_BIN"] === undefined ? {} : { piExecutable: process.env["SPIKE_PI_BIN"] }),
      });
      const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
      const paths = {
        input: relative(dispatched.root, dispatched.exchange.inputDirectory),
        output: relative(dispatched.root, dispatched.exchange.outputDirectory),
      };
      return dispatched.hosting === "herdr"
        ? success(
            json,
            "ticket dispatch-pi",
            { ticket: identity, hosting: "herdr", status: dispatched.status, paths },
            `Dispatched Pi Ticket ${input.goalId}/${input.changeId}/${input.ticketId}\n  working in Herdr\n`,
          )
        : success(
            json,
            "ticket dispatch-pi",
            { ticket: identity, hosting: "direct", classification: dispatched.classification, execution: dispatched.execution, paths },
            `Dispatched Pi Ticket ${input.goalId}/${input.changeId}/${input.ticketId}\n  ${dispatched.classification}\n`,
          );
    }

    if (args[0] === "ticket" && args[1] === "dispatch-test") {
      const input = parseTestDispatch(args.slice(2));
      const dispatched = await dispatchWorkerTicket({ cwd, ...input });
      const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
      return success(
        json,
        "ticket dispatch-test",
        {
          ticket: identity,
          execution: dispatched.execution,
          paths: {
            input: relative(dispatched.root, dispatched.exchange.inputDirectory),
            output: relative(dispatched.root, dispatched.exchange.outputDirectory),
          },
        },
        `Dispatched controlled-test Ticket ${input.goalId}/${input.changeId}/${input.ticketId}\n` +
          `  Worker exited ${dispatched.execution.exitCode}\n`,
      );
    }

    if (args[0] === "worker" && args[1] === "status") {
      const identity = parseWorkerIdentity(args.slice(2));
      const repository = await discoverRepository(cwd);
      const observation = await observeWorker(repository.root, identity);
      return success(
        json,
        "worker status",
        { ticket: identity, ...observation },
        `Worker ${identity.goalId}/${identity.changeId}/${identity.ticketId}: ${observation.status}\n`,
      );
    }

    if (args[0] === "worker" && args[1] === "wait") {
      const identity = parseWorkerIdentity(args.slice(2));
      const repository = await discoverRepository(cwd);
      const notification = await waitForWorkerDone(repository.root, identity);
      return success(
        json,
        "worker wait",
        notification,
        `Worker ${identity.goalId}/${identity.changeId}/${identity.ticketId}: marker-backed done\n`,
      );
    }

    if (args[0] === "worker" && args[1] === "read") {
      const input = parseWorkerRead(args.slice(2));
      const repository = await discoverRepository(cwd);
      const terminal = await readWorkerTerminal(repository.root, input, {
        ...(input.lines === undefined ? {} : { lines: input.lines }),
        ...(input.ansi === undefined ? {} : { ansi: input.ansi }),
      });
      return success(json, "worker read", { ticket: { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId }, terminal }, terminal);
    }

    if (args[0] === "worker" && args[1] === "attach") {
      if (json) throw new UsageError("worker attach does not support --json");
      const identity = parseWorkerIdentity(args.slice(2));
      const repository = await discoverRepository(cwd);
      return attachWorkerTerminal(repository.root, identity);
    }

    if (args[0] === "worker" && (args[1] === "complete" || args[1] === "block")) {
      const action = args[1];
      const input = parseWorkerSubmission(args.slice(2), action);
      const payload = await readWorkerPayload(cwd, input.file, stdinText);
      const submission = action === "complete" ? await completeWorker(cwd, payload) : await blockWorker(cwd, payload);
      return success(
        json,
        `worker ${action}`,
        submission,
        `${action === "complete" ? "Completed" : "Blocked"} ${submission.role} Ticket ${submission.goalId}/${submission.changeId}/${submission.ticketId}\n`,
      );
    }

    if (args[0] === "report" && args[1] === "publish") {
      const input = parseReportPublish(args.slice(2));
      const repository = await discoverRepository(cwd);
      const identity = { goalId: input.goalId, changeId: input.changeId, ticketId: input.ticketId };
      const [ticket, execution] = await Promise.all([
        loadTicket(repository.root, input.goalId, input.changeId, input.ticketId),
        loadFinishedWorkerExecution(repository.root, identity),
      ]);

      let publication;
      if (input.failure !== undefined) {
        publication = await publishFailedReport({
          cwd: repository.root,
          ...identity,
          role: ticket.metadata.role,
          reason: input.failure,
          execution,
        });
      } else if (await loadSubmissionOutcome(repository.root, identity) === "blocked") {
        publication = await publishBlockedReport({ cwd: repository.root, ...identity, execution });
      } else if (ticket.metadata.role === "implement") {
        if (input.commitSummary === undefined) {
          throw new UsageError("--commit-summary is required for a completed implementation Report");
        }
        publication = await publishImplementationReport({
          cwd: repository.root,
          ...identity,
          execution,
          commitMessage: {
            summary: input.commitSummary,
            ...(input.commitBody === undefined ? {} : { body: input.commitBody }),
          },
        });
      } else {
        if (input.commitSummary !== undefined || input.commitBody !== undefined) {
          throw new UsageError("review Reports do not accept Candidate commit message options");
        }
        publication = await publishReviewReport({ cwd: repository.root, ...identity, execution });
      }

      return success(
        json,
        "report publish",
        {
          report: publication.report.metadata,
          cleanup: publication.cleanup,
          path: relative(repository.root, reportPath(repository.root, input.goalId, input.changeId, input.ticketId)),
        },
        `Published ${publication.report.metadata.outcome} Report ${input.goalId}/${input.changeId}/${input.ticketId}\n` +
          humanCleanup(publication.cleanup),
      );
    }

    if (args[0] === "recover") {
      const input = parseRecover(args.slice(1));
      if (input.goalId === undefined) {
        const reconciled = await reconcileRepository({ cwd, ...(input.reason === undefined ? {} : { reason: input.reason }) });
        return success(
          json,
          "recover",
          reconciled,
          humanReconciliation(reconciled.goals, reconciled.ignoredUnpublishedGoalIds.length),
        );
      }
      const reconciled = await reconcileGoal({
        cwd,
        goalId: input.goalId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.goalLocal ? { recoverApplications: false } : {}),
      });
      return success(json, "recover", reconciled, humanReconciliation([reconciled]));
    }

    throw new UsageError(`unknown command: ${args.join(" ")}`);
  } catch (error) {
    return failure(json, command, error);
  }
}

if (import.meta.main) process.exit(await run());
