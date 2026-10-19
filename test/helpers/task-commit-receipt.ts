import { randomUUID } from 'node:crypto';
import { createSqliteGitOperationStore } from '../../packages/core/src/adapters/sqlite/git-operations.ts';
import type { AttemptRecord } from '../../packages/core/src/ports/attempt-store.ts';
import type { BudgetFixture } from './p03-3/budget-fixture.ts';
import { NOW } from './p03-3/budget-fixture.ts';
import { git } from './git-repo.ts';

/** State-machine fixture only: persist a matching no-change receipt via the real store. */
export function recordTaskCommitFixture(f: { box: BudgetFixture }, attempt: AttemptRecord, batchId: string, codeDigest: string): void {
  const db = f.box.session.database;
  const binding = db.prepare('SELECT id, repo_identity, canonical_path FROM repository_bindings WHERE project_id = ?')
    .get(attempt.projectId) as { id: string; repo_identity: string; canonical_path: string };
  const feature = db.prepare('SELECT revision FROM features WHERE id = ?').get(attempt.featureId) as { revision: number };
  const head = f.box.box.gitHead('A');
  const tree = git(['rev-parse', 'HEAD^{tree}'], binding.canonical_path, { home: f.box.box.homeDir }).trim();
  const operationId = randomUUID();
  const store = createSqliteGitOperationStore(f.box.session, { nowUtcMs: () => NOW + 2 });
  const registered = store.registerGitOperation({ operationId, projectId: attempt.projectId,
    featureId: attempt.featureId, runId: attempt.runId, attemptId: attempt.id,
    executionVersion: attempt.executionVersion, operationType: 'task_commit',
    repositoryBindingId: binding.id, repoIdentity: binding.repo_identity, worktreePath: binding.canonical_path,
    expectedHead: head, candidateTree: tree, codeDigest,
    verificationRefs: [{ kind: 'verification_batch', id: batchId, digest: codeDigest }], approvalRefs: [],
    message: 'fixture unchanged Task delivery', gitIdentity: { name: 'fixture', email: 'fixture@example.test', confirmed: true },
    deliveryPolicyDigest: 'ab'.repeat(32), runtimeSource: null, ownerId: attempt.owner,
    hostInstanceId: attempt.hostInstanceId, expectedFeatureRevision: feature.revision });
  store.finalizeGitOperation({ operationId, projectId: attempt.projectId, expectedRevision: registered.operation.revision,
    status: 'no_change', actualCommit: head, actualTree: tree, exitCode: 0, durationMs: 1,
    reasonCode: null, deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 2 });
}
