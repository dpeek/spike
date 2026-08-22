import { describe, expect, test } from "bun:test";
import { detectApplicationChurn } from "./application-ticket.ts";

const review = (finding: string) => ({ outcome: "completed", verdict: "remediate", findings: [{ id: finding }] });
const kinds = (reviews: Parameters<typeof detectApplicationChurn>[0], reports: Parameters<typeof detectApplicationChurn>[1]) =>
  detectApplicationChurn(reviews, reports).map((warning) => warning.kind);

describe("Application churn", () => {
  test("detects only the documented durable thresholds", () => {
    expect(kinds([review("first")], [])).toEqual([]);
    expect(kinds([review("first"), review("different")], [])).toEqual(["remediation-rounds"]);
    expect(kinds([review("repeat"), review("repeat")], [])).toEqual(["remediation-rounds", "reopened-finding"]);
    expect(kinds([], [{ outcome: "partial" }, { outcome: "blocked" }])).toEqual(["non-progress"]);
    expect(kinds([], [{ outcome: "partial" }, { outcome: "interrupted" }, { outcome: "blocked" }])).toEqual([]);
  });
});
