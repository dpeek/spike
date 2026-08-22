// Review workers are a role of the configured Application adapter. Keep this
// review-facing API so workflow callers cannot reach implementation lifecycle
// operations or create a parallel local-clone runtime.
import {
  applicationReviewWorkerRecordPath,
  configuredApplicationAdapter,
  loadApplicationReviewWorkerIfPresent,
  type ApplicationReviewWorkerExecution,
  type ApplicationReviewWorkerRecord,
} from "./application-worker.ts";
import type { ApplicationReviewIdentity } from "./application-review.ts";
import type { HostPaths } from "./data-root.ts";
import type { ProjectPaths } from "./project.ts";

export { applicationReviewWorkerRecordPath, loadApplicationReviewWorkerIfPresent };
export type { ApplicationReviewWorkerRecord, ApplicationReviewWorkerExecution };

export const observeApplicationReviewWorker = (root: ProjectPaths, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.observe(root, identity);
export const readApplicationReviewWorker = (root: ProjectPaths, identity: ApplicationReviewIdentity, maximumBytes?: number) => configuredApplicationAdapter.review.read(root, identity, maximumBytes);
export const loadFinishedApplicationReviewWorker = (root: ProjectPaths, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.loadFinished(root, identity);
export const stopApplicationReviewWorker = (root: ProjectPaths, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.stop(root, identity);
export const finalizeApplicationReviewWorker = (root: ProjectPaths, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.finalize(root, identity);
export const forgetFinalizedApplicationReviewWorker = (root: ProjectPaths, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.forget(root, identity);
export async function cleanupApplicationReviewWorker(root: ProjectPaths, identity: ApplicationReviewIdentity) {
  await stopApplicationReviewWorker(root, identity);
  await finalizeApplicationReviewWorker(root, identity);
  await forgetFinalizedApplicationReviewWorker(root, identity);
}
export const dispatchApplicationReviewWorker = (input: ApplicationReviewIdentity & { cwd: string; hostPaths: HostPaths; command: string[]; worker: string; clock?: () => Date }) => configuredApplicationAdapter.review.dispatch(input);
export const dispatchApplicationReviewPiTicket = (input: ApplicationReviewIdentity & { cwd: string; hostPaths: HostPaths; worker: string; piExecutable?: string; clock?: () => Date }) => configuredApplicationAdapter.review.dispatchPi(input);
