#!/usr/bin/env bun

import { relative } from "node:path";
import { changePath, createChange } from "./change.ts";
import { createGoal, goalPath } from "./goal.ts";
import { planPath } from "./plan.ts";
import { issueTicket, ticketPath, type ExecutionPolicy } from "./ticket.ts";

export const version = "2.0.0-dev";

export function usage(): string {
  return `spike ${version}

Usage:
  spike goal create --title <title> --outcome <outcome> --approval <statement> [options]
  spike change create --goal <goal-id> --title <title> --intent <intent> --rationale <rationale> --acceptance <criterion> [options]
  spike ticket issue --goal <goal-id> --change <change-id> --instruction <instruction> [options]
  spike --help
  spike --version

Goal creation options:
  --constraint <constraint>       Repeat for each constraint
  --repository-id <identity>      Override the inferred repository identity

Change creation options:
  --acceptance <criterion>        Repeat for each acceptance criterion
  --non-goal <non-goal>           Repeat for each non-goal
  --dependency <dependency>       Repeat for each dependency

Ticket issuance options:
  --role <role>                  implement (default) or review
  --input-revision <commit>       Exact commit; review must use the current Candidate
  --implementation-ticket <id>   Producing Ticket; derived for review when omitted
  --context <context>             Additional planner-curated context
  --isolation <level>             workspace (default) or container
  --network-access <access>       none (default), restricted, or unrestricted
  --credential <grant-id>         Repeat for each credential grant identifier
`;
}

class UsageError extends Error {}

function valueAfter(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function parseGoalCreate(args: string[]): {
  title: string;
  outcome: string;
  approval: string;
  constraints: string[];
  repositoryIdentity?: string;
} {
  let title: string | undefined;
  let outcome: string | undefined;
  let approval: string | undefined;
  let repositoryIdentity: string | undefined;
  const constraints: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    switch (option) {
      case "--title":
        title = value;
        break;
      case "--outcome":
        outcome = value;
        break;
      case "--approval":
        approval = value;
        break;
      case "--constraint":
        constraints.push(value);
        break;
      case "--repository-id":
        repositoryIdentity = value;
        break;
      default:
        throw new UsageError(`unknown option: ${option}`);
    }
  }

  if (title === undefined) throw new UsageError("--title is required");
  if (outcome === undefined) throw new UsageError("--outcome is required");
  if (approval === undefined) throw new UsageError("--approval is required");
  return { title, outcome, approval, constraints, ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }) };
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
      case "--goal":
        goalId = value;
        break;
      case "--title":
        title = value;
        break;
      case "--intent":
        intent = value;
        break;
      case "--rationale":
        rationale = value;
        break;
      case "--acceptance":
        acceptanceCriteria.push(value);
        break;
      case "--non-goal":
        nonGoals.push(value);
        break;
      case "--dependency":
        dependencies.push(value);
        break;
      default:
        throw new UsageError(`unknown option: ${option}`);
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
  inputRevision?: string;
  producingImplementationTicketId?: string;
  executionPolicy: ExecutionPolicy;
} {
  let goalId: string | undefined;
  let changeId: string | undefined;
  let instruction: string | undefined;
  let curatedContext: string | undefined;
  let inputRevision: string | undefined;
  let producingImplementationTicketId: string | undefined;
  let role: "implement" | "review" = "implement";
  let isolation: ExecutionPolicy["isolation"] = "workspace";
  let networkAccess: ExecutionPolicy["networkAccess"] = "none";
  const credentialGrants: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = valueAfter(args, index, option);
    switch (option) {
      case "--goal":
        goalId = value;
        break;
      case "--change":
        changeId = value;
        break;
      case "--instruction":
        instruction = value;
        break;
      case "--context":
        curatedContext = value;
        break;
      case "--input-revision":
        inputRevision = value;
        break;
      case "--role":
        if (value !== "implement" && value !== "review") throw new UsageError(`unsupported Ticket role: ${value}`);
        role = value;
        break;
      case "--implementation-ticket":
        producingImplementationTicketId = value;
        break;
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
      case "--credential":
        credentialGrants.push(value);
        break;
      default:
        throw new UsageError(`unknown option: ${option}`);
    }
  }

  if (goalId === undefined) throw new UsageError("--goal is required");
  if (changeId === undefined) throw new UsageError("--change is required");
  if (instruction === undefined) throw new UsageError("--instruction is required");
  return {
    goalId,
    changeId,
    instruction,
    role,
    executionPolicy: { isolation, networkAccess, credentialGrants },
    ...(curatedContext === undefined ? {} : { curatedContext }),
    ...(inputRevision === undefined ? {} : { inputRevision }),
    ...(producingImplementationTicketId === undefined ? {} : { producingImplementationTicketId }),
  };
}

export async function run(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    process.stdout.write(usage());
    return 0;
  }

  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  try {
    if (args[0] === "goal" && args[1] === "create") {
      const input = parseGoalCreate(args.slice(2));
      const created = await createGoal({ cwd, ...input });
      const goalId = created.goal.metadata.goalId;
      process.stdout.write(
        `Created Goal ${goalId}\n` +
          `  ${relative(created.root, goalPath(created.root, goalId))}\n` +
          `  ${relative(created.root, planPath(created.root, goalId))}\n`,
      );
      return 0;
    }

    if (args[0] === "change" && args[1] === "create") {
      const input = parseChangeCreate(args.slice(2));
      const created = await createChange({ cwd, ...input });
      const { goalId, changeId } = created.change.metadata;
      process.stdout.write(
        `Created Change ${goalId}/${changeId}\n` +
          `  ${relative(created.root, changePath(created.root, goalId, changeId))}\n`,
      );
      return 0;
    }

    if (args[0] === "ticket" && args[1] === "issue") {
      const input = parseTicketIssue(args.slice(2));
      const issued = await issueTicket({ cwd, ...input });
      const { goalId, changeId, ticketId } = issued.ticket.metadata;
      process.stdout.write(
        `Issued Ticket ${goalId}/${changeId}/${ticketId}\n` +
          `  ${relative(issued.root, ticketPath(issued.root, goalId, changeId, ticketId))}\n`,
      );
      return 0;
    }
  } catch (error) {
    process.stderr.write(`spike: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }

  process.stderr.write(`spike: unknown command: ${args.join(" ")}\n`);
  return 2;
}

if (import.meta.main) process.exit(await run());
