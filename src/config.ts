import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const nonBlankString = z.string().trim().min(1);
const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modelSelectionSchema = z
  .object({
    model: nonBlankString,
    thinking: thinkingSchema,
  })
  .strict();
const projectConfigSchema = z
  .object({
    models: z
      .object({
        planner: modelSelectionSchema,
        implement: modelSelectionSchema,
        review: modelSelectionSchema,
      })
      .strict(),
  })
  .strict();

export type ThinkingLevel = z.infer<typeof thinkingSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ExecutableTicketRole = "implement" | "review";

export function configPath(root: string): string {
  return join(root, "spike.json");
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  let source: string;
  try {
    source = await readFile(configPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Spike project configuration does not exist: ${configPath(root)}`);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Spike project configuration is not valid JSON: ${configPath(root)}`);
  }
  return projectConfigSchema.parse(value);
}

export async function resolveTicketModelSelection(
  root: string,
  role: ExecutableTicketRole,
  override: Partial<ModelSelection> = {},
): Promise<ModelSelection> {
  const configured = (await loadProjectConfig(root)).models[role];
  return modelSelectionSchema.parse({ ...configured, ...override });
}
