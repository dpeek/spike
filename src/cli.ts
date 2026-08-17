#!/usr/bin/env bun

import { relative } from "node:path";
import { createGoal, goalPath } from "./goal.ts";
import { planPath } from "./plan.ts";

export const version = "2.0.0-dev";

export function usage(): string {
  return `spike ${version}

Usage:
  spike goal create --title <title> --outcome <outcome> --approval <statement> [options]
  spike --help
  spike --version

Goal creation options:
  --constraint <constraint>       Repeat for each constraint
  --repository-id <identity>      Override the inferred repository identity
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

export async function run(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    process.stdout.write(usage());
    return 0;
  }

  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  if (args[0] === "goal" && args[1] === "create") {
    try {
      const input = parseGoalCreate(args.slice(2));
      const created = await createGoal({ cwd, ...input });
      const goalId = created.goal.metadata.goalId;
      process.stdout.write(
        `Created Goal ${goalId}\n` +
          `  ${relative(created.root, goalPath(created.root, goalId))}\n` +
          `  ${relative(created.root, planPath(created.root, goalId))}\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(`spike: ${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
  }

  process.stderr.write(`spike: unknown command: ${args.join(" ")}\n`);
  return 2;
}

if (import.meta.main) process.exit(await run());
