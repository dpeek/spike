#!/usr/bin/env bun

export const version = "2.0.0-dev";

export function usage(): string {
  return `spike ${version}

Usage:
  spike --help
  spike --version
`;
}

export function run(args = process.argv.slice(2)): number {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    process.stdout.write(usage());
    return 0;
  }

  if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  process.stderr.write(`spike: unknown command: ${args.join(" ")}\n`);
  return 2;
}

if (import.meta.main) process.exit(run());
