import { randomUUID } from "node:crypto";
import { chmod, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "./git.ts";

const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const goalIdPattern = /^goal-[0-9a-f]{32}$/;
const sequenceIdPattern = /^(?!000)[0-9]{3}$/;

function requireRevision(revision: string, label: string): void {
  if (!revisionPattern.test(revision)) throw new Error(`${label} must be an exact commit hash`);
}

function requireIdentity(goalId: string, changeId: string, ticketId: string): void {
  if (!goalIdPattern.test(goalId) || !sequenceIdPattern.test(changeId) || !sequenceIdPattern.test(ticketId)) {
    throw new Error(`invalid Ticket identity: ${goalId}/${changeId}/${ticketId}`);
  }
}

function zeroObjectId(revision: string): string {
  return "0".repeat(revision.length);
}

export function candidateRef(goalId: string, changeId: string, ticketId: string): string {
  requireIdentity(goalId, changeId, ticketId);
  return `refs/spike/goals/${goalId}/changes/${changeId}/tickets/${ticketId}`;
}

export async function createInputBundle(
  root: string,
  revision: string,
  bundlePath: string,
  identity: { goalId: string; changeId: string; ticketId: string },
): Promise<void> {
  requireRevision(revision, "Input revision");
  requireIdentity(identity.goalId, identity.changeId, identity.ticketId);
  const exactRevision = await git(root, ["rev-parse", "--verify", `${revision}^{commit}`]);
  if (exactRevision !== revision) throw new Error("Input revision must identify a commit exactly");

  const suffix = randomUUID().replaceAll("-", "");
  const stagingRef = `refs/heads/spike-input-${identity.changeId}-${identity.ticketId}-${suffix}`;
  const temporaryPath = join(dirname(bundlePath), `.repository.${suffix}.bundle.tmp`);
  try {
    await git(root, ["update-ref", stagingRef, revision, zeroObjectId(revision)]);
    await git(root, ["bundle", "create", temporaryPath, stagingRef]);
    await rename(temporaryPath, bundlePath);
    await chmod(bundlePath, 0o400);
  } finally {
    await git(root, ["update-ref", "-d", stagingRef]).catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

function advertisedRefForRevision(heads: string, revision: string): string | undefined {
  for (const line of heads.split("\n")) {
    const match = line.match(/^([0-9a-f]+)\s+(.+)$/);
    if (match?.[1] === revision) return match[2];
  }
  return undefined;
}

export async function withImportedWorkerRevision<T>(
  root: string,
  bundlePath: string,
  workerRevision: string,
  identity: { goalId: string; changeId: string; ticketId: string },
  use: (importedRevision: string) => Promise<T>,
): Promise<T> {
  requireRevision(workerRevision, "Worker revision");
  requireIdentity(identity.goalId, identity.changeId, identity.ticketId);

  try {
    await git(root, ["bundle", "verify", bundlePath]);
  } catch (error) {
    throw new Error(`output repository bundle is invalid: ${(error as Error).message}`);
  }

  const heads = await git(root, ["bundle", "list-heads", bundlePath]);
  const advertisedRef = advertisedRefForRevision(heads, workerRevision);
  if (advertisedRef === undefined) {
    throw new Error(`output repository bundle does not advertise worker revision ${workerRevision}`);
  }

  const suffix = randomUUID().replaceAll("-", "");
  const quarantineRef = `refs/spike/quarantine/goals/${identity.goalId}/changes/${identity.changeId}/tickets/${identity.ticketId}/${suffix}`;
  try {
    await git(root, ["fetch", "--quiet", "--no-tags", bundlePath, `${advertisedRef}:${quarantineRef}`]);
    const importedRevision = await git(root, ["rev-parse", "--verify", `${quarantineRef}^{commit}`]);
    if (importedRevision !== workerRevision) {
      throw new Error(`imported worker revision does not match Submission: ${importedRevision}`);
    }
    return await use(importedRevision);
  } finally {
    await git(root, ["update-ref", "-d", quarantineRef]).catch(() => undefined);
  }
}

export async function normalizeCandidate(
  root: string,
  workerRevision: string,
  baseRevision: string,
  message: string,
): Promise<string> {
  requireRevision(workerRevision, "Worker revision");
  requireRevision(baseRevision, "Change base revision");
  if (!message.trim()) throw new Error("Candidate commit message must not be blank");

  const tree = await git(root, ["rev-parse", "--verify", `${workerRevision}^{tree}`]);
  await git(root, ["rev-parse", "--verify", `${baseRevision}^{commit}`]);
  return git(root, ["commit-tree", tree, "-p", baseRevision, "-m", message]);
}

export async function retainCandidate(
  root: string,
  goalId: string,
  changeId: string,
  ticketId: string,
  revision: string,
): Promise<string> {
  requireRevision(revision, "Candidate revision");
  const ref = candidateRef(goalId, changeId, ticketId);
  try {
    await git(root, ["update-ref", ref, revision, zeroObjectId(revision)]);
  } catch (error) {
    throw new Error(`Candidate retention ref already exists: ${ref}`);
  }
  return ref;
}
