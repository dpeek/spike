import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { goalSequence, projectSlugPattern } from "./identity.ts";

const nonBlankString = z.string().trim().min(1);
const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modelSelectionSchema = z.object({ model: nonBlankString, thinking: thinkingSchema }).strict();
const isolationSchema = z.enum(["workspace", "container"]);
const networkAccessSchema = z.enum(["none", "restricted", "unrestricted"]);
const workerAgentSchema = modelSelectionSchema.extend({
  isolation: isolationSchema.optional().default("container"),
  networkAccess: networkAccessSchema,
  credentialGrants: z.array(nonBlankString),
}).strict();
const projectIdentitySchema = z.object({
  project: z.object({ slug: z.string().regex(projectSlugPattern) }).strict(),
}).passthrough();
const projectConfigSchema = z.object({
  project: z.object({ slug: z.string().regex(projectSlugPattern) }).strict(),
  agents: z.object({
    planner: modelSelectionSchema,
    implement: workerAgentSchema,
    review: workerAgentSchema,
  }).strict(),
}).strict();

export type ThinkingLevel = z.infer<typeof thinkingSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ExecutionPolicyDefaults = Pick<z.infer<typeof workerAgentSchema>, "isolation" | "networkAccess" | "credentialGrants">;
export type WorkerAgent = z.infer<typeof workerAgentSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ExecutableTicketRole = "implement" | "review";

export function configPath(root: string): string { return join(root, "spike.json"); }

async function readProjectConfigValue(root: string): Promise<unknown> {
  let source: string;
  try { source = await readFile(configPath(root), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Spike project configuration does not exist: ${configPath(root)}`);
    throw error;
  }
  try { return JSON.parse(source); } catch { throw new Error(`Spike project configuration is not valid JSON: ${configPath(root)}`); }
}

export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  return projectConfigSchema.parse(await readProjectConfigValue(root));
}

/** Read only the tracked Project identity. Existing workflow and frozen-Ticket
 * operations must not depend on mutable agent defaults remaining complete. */
export async function loadProjectIdentity(root: string): Promise<{ slug: string }> {
  return projectIdentitySchema.parse(await readProjectConfigValue(root)).project;
}

/**
 * Frozen Ticket paths require only immutable workflow provenance plus the
 * Project slug. Do not parse mutable agent defaults here: those are consulted
 * exclusively when assigning a new Ticket.
 */
export async function assertGoalBelongsToProject(root: string, goalId: string): Promise<void> {
  const { slug } = await loadProjectIdentity(root);
  if (goalSequence(goalId, slug) === undefined) throw new Error(`Goal ${goalId} does not belong to Project ${slug}`);
}

export async function resolveTicketAssignment(
  root: string,
  role: ExecutableTicketRole,
  override: Partial<ModelSelection & ExecutionPolicyDefaults> = {},
): Promise<ModelSelection & ExecutionPolicyDefaults> {
  const configured = (await loadProjectConfig(root)).agents[role];
  return workerAgentSchema.parse({ ...configured, ...override });
}
