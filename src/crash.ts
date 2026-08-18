export type ImmutableCommitPoint =
  | "goal-publication"
  | "ticket-issuance"
  | "implementation-report-publication"
  | "review-report-publication"
  | "change-decision-publication";

export type CrashMoment = "before" | "after";

export type CrashEvent = {
  point: ImmutableCommitPoint;
  moment: CrashMoment;
};

export type CrashInjector = (event: CrashEvent) => void | Promise<void>;

export function commitCrashHooks(
  injector: CrashInjector | undefined,
  point: ImmutableCommitPoint,
): { beforePublish?: () => void | Promise<void>; afterPublish?: () => void | Promise<void> } | undefined {
  if (injector === undefined) return undefined;
  return {
    beforePublish: () => injector({ point, moment: "before" }),
    afterPublish: () => injector({ point, moment: "after" }),
  };
}
