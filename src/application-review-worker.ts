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

export { applicationReviewWorkerRecordPath, loadApplicationReviewWorkerIfPresent };
export type { ApplicationReviewWorkerRecord, ApplicationReviewWorkerExecution };

export const observeApplicationReviewWorker = (root: string, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.observe(root, identity);
export const readApplicationReviewWorker = (root: string, identity: ApplicationReviewIdentity, maximumBytes?: number) => configuredApplicationAdapter.review.read(root, identity, maximumBytes);
export const loadFinishedApplicationReviewWorker = (root: string, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.loadFinished(root, identity);
export const stopApplicationReviewWorker = (root: string, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.stop(root, identity);
export const finalizeApplicationReviewWorker = (root: string, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.finalize(root, identity);
export const forgetFinalizedApplicationReviewWorker = (root: string, identity: ApplicationReviewIdentity) => configuredApplicationAdapter.review.forget(root, identity);
export async function cleanupApplicationReviewWorker(root: string, identity: ApplicationReviewIdentity) {
  await stopApplicationReviewWorker(root, identity);
  await finalizeApplicationReviewWorker(root, identity);
  await forgetFinalizedApplicationReviewWorker(root, identity);
}
export const dispatchApplicationReviewWorker = (input: ApplicationReviewIdentity & { cwd: string; command: string[]; worker: string; clock?: () => Date }) => configuredApplicationAdapter.review.dispatch(input);
export const dispatchApplicationReviewPiTicket = (input: ApplicationReviewIdentity & { cwd: string; worker: string; piExecutable?: string; clock?: () => Date }) => configuredApplicationAdapter.review.dispatchPi(input);
