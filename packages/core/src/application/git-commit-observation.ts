import type { GitCommitFacts } from '../ports/controlled-git-commit.js';
import { gitOperationCommitMessage } from '../ports/controlled-git-commit.js';
import type { GitOperationIntent } from '../ports/git-operations.js';
import type { WorkRecoveryGitOperationFacts } from '../ports/work-recovery-reconciliation.js';

/** One interpretation of external facts for startup diagnosis and receipt repair.
 * Neither a matching tree nor an unchanged HEAD proves that a command executed.
 */
export function observeGitCommit(intent: GitOperationIntent, facts: GitCommitFacts | null): WorkRecoveryGitOperationFacts {
  const unknown = (reasonCode: string): WorkRecoveryGitOperationFacts => ({
    operationId: intent.operationId, outcome: 'unknown', actualCommit: null, actualTree: null, reasonCode,
  });
  if (facts === null) return unknown('git_facts_unavailable');
  if (facts.head === intent.expectedHead) return {
    operationId: intent.operationId, outcome: 'not_executed', actualCommit: null, actualTree: null,
    reasonCode: 'commit_not_observed',
  };
  if (facts.parents.length !== 1 || facts.parents[0] !== intent.expectedHead) return unknown('unexplained_head_drift');
  if (facts.tree !== intent.candidateTree) return unknown('candidate_tree_mismatch');
  const sameIdentity = (identity: { name: string; email: string }) =>
    identity.name === intent.gitIdentity.name && identity.email === intent.gitIdentity.email;
  if (facts.message !== gitOperationCommitMessage(intent.message, intent.operationId)
    || !sameIdentity(facts.author) || !sameIdentity(facts.committer)) return unknown('commit_intent_mismatch');
  return { operationId: intent.operationId, outcome: 'matched', actualCommit: facts.head, actualTree: facts.tree, reasonCode: null };
}
