import type { GitCommitRequest } from './controlled-git-commit.js';
import type { GitOperationRecord } from './git-operations.js';

/** Historical facts are queried independently of current delivery authorization.
 * not_executed means no commit result is observed at the expected HEAD; it is NOT
 * permission to retry, nor proof that a process was never launched.
 */
export interface GitCommitReconciliation {
  readonly outcome: 'not_executed' | 'matched' | 'failed' | 'unknown';
  readonly reasonCode: string | null;
  readonly operation: GitOperationRecord;
}
export interface GitCommitReconciliationService {
  reconcile(request: GitCommitRequest): Promise<GitCommitReconciliation>;
}
