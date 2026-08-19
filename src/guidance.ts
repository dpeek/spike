import { z } from "zod";
import { git, readGitBlob } from "./git.ts";

export const guidanceSteps = [
  "goal",
  "plan",
  "change",
  "implement",
  "review",
  "remediate",
  "decide",
  "recover",
] as const;

export const guidanceStepSchema = z.enum(guidanceSteps);
export type GuidanceStep = z.infer<typeof guidanceStepSchema>;

export const guidancePaths: Record<GuidanceStep, string> = {
  goal: "spike/guidance/goal.md",
  plan: "spike/guidance/plan.md",
  change: "spike/guidance/change.md",
  implement: "spike/guidance/implement.md",
  review: "spike/guidance/review.md",
  remediate: "spike/guidance/remediate.md",
  decide: "spike/guidance/decide.md",
  recover: "spike/guidance/recover.md",
};

export type Guidance = {
  step: GuidanceStep;
  path: string;
  revision: string;
  markdown: string;
};

const maximumGuidanceBytes = 32 * 1024;
const treeEntryPattern = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/;

export async function loadGuidance(root: string, stepInput: GuidanceStep, revision: string): Promise<Guidance> {
  const step = guidanceStepSchema.parse(stepInput);
  const exactRevision = await git(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (exactRevision !== revision) throw new Error("guidance revision must identify a commit exactly");

  const path = guidancePaths[step];
  const entry = await git(root, ["ls-tree", exactRevision, "--", path]);
  if (!entry) throw new Error(`guidance does not exist at ${path} in revision ${exactRevision}`);
  const match = treeEntryPattern.exec(entry);
  if (match === null || match[3] !== path) {
    throw new Error(`guidance must be a regular Git file: ${path} in revision ${exactRevision}`);
  }

  const markdown = await readGitBlob(root, match[2]!, maximumGuidanceBytes);
  if (!markdown.trim()) throw new Error(`guidance must not be blank: ${path} in revision ${exactRevision}`);
  return { step, path, revision: exactRevision, markdown };
}
