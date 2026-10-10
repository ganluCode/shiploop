/** Cooperative repository exclusion, independent of a Core data root. */
export interface BaselineRepositoryLease {
  /** Release only after durable finalization; uncertain owners must retain the lease. */
  release(): Promise<void>;
}
export interface BaselineRepositoryGuard {
  acquire(input: { canonicalPath: string; gitCommonDir: string; operationId: string }): Promise<BaselineRepositoryLease>;
}
