export const projectSlugPattern = /^(?=.{1,63}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const sequenceIdPattern = /^(?!000)[0-9]{3}$/;
export const goalIdPattern = /^(?=.{5,67}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?!000)[0-9]{3}$/;

export function formatGoalId(projectSlug: string, sequence: number): string {
  if (!projectSlugPattern.test(projectSlug)) throw new Error(`invalid Project slug: ${projectSlug}`);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new Error(`invalid Goal sequence: ${sequence}`);
  }
  return `${projectSlug}-${String(sequence).padStart(3, "0")}`;
}

export function goalSequence(goalId: string, projectSlug: string): number | undefined {
  if (!projectSlugPattern.test(projectSlug) || !goalIdPattern.test(goalId)) return undefined;
  const prefix = `${projectSlug}-`;
  if (!goalId.startsWith(prefix)) return undefined;
  const sequence = goalId.slice(prefix.length);
  if (!sequenceIdPattern.test(sequence)) return undefined;
  return Number(sequence);
}
