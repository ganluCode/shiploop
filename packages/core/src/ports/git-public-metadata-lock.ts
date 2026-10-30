/** Short-lived cooperative lock for Core-owned Git public metadata operations. */
export interface GitPublicMetadataLockInput {
  /** Stable local repository identity derived from the real Git common directory. */
  readonly repoIdentity: string;
  /** Real workspace root on which the Git operation will run. */
  readonly workspacePath: string;
  /** Real Git common directory shared by all worktrees of the repository. */
  readonly gitCommonDir: string;
  /** Durable operation owner, normally a UUID v4. */
  readonly operationId: string;
}

export interface GitPublicMetadataLease {
  /** Recheck pinned directories, claim identity and native locks before a side effect. */
  assertCurrent?(): void;
  /** Releases only the claim acquired by this lease. Repeated release is harmless. */
  release(): Promise<void>;
}

export interface GitPublicMetadataLock {
  acquire(input: GitPublicMetadataLockInput): Promise<GitPublicMetadataLease>;
  /** Removes a claim only after the caller has independently confirmed its owner stopped. */
  releaseRecovered(input: GitPublicMetadataLockInput): Promise<boolean>;
  /** Read-only check of a retained exact-owner claim, including native Git locks.
   * Caller must independently confirm all previous writers stopped before using it.
   * Concurrent reconciliation readers are allowed; receipt writes remain CAS guarded.
   */
  inspectRecovered?(input: GitPublicMetadataLockInput): Promise<boolean>;
}

/** The historical filename is retained so existing baseline recovery evidence remains valid. */
export const GIT_PUBLIC_METADATA_CLAIM_FILE = 'shiploop-baseline.claim';
