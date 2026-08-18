import { describe, expect, test } from "bun:test";
import { acceptanceCriteria } from "./acceptance.ts";

describe("acceptance criteria parsing", () => {
  test("reads every criterion through the next section", () => {
    const body = `# Change

## Acceptance criteria

- First criterion.
- Second criterion.
- Third criterion.
- Fourth criterion.

## Non-goals

None.
`;

    expect(acceptanceCriteria(body)).toEqual([
      "First criterion.",
      "Second criterion.",
      "Third criterion.",
      "Fourth criterion.",
    ]);
  });
});
