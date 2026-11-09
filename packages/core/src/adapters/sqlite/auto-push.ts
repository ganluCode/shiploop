import { StorageError } from '../../ports/errors.js';
import type { SqliteStorageSession } from './session.js';
import type { GitCommitDriverSession } from '../../ports/controlled-git-commit.js';
import type { DeliveryPolicySection } from '../../ports/delivery-policy.js';

/** An acknowledged local commit remains authoritative even if remote delivery fails. */
export async function autoPushVerifiedCommit(input: {
  session: SqliteStorageSession; projectId: string; runId: string; operationId: string;
  boundary: 'task' | 'feature'; branch: string; commit: string;
  policy: DeliveryPolicySection; driver: GitCommitDriverSession; assertCurrent(): void;
}) {
  if (input.policy.auto_push !== true) return;
  const fail = (reason: string): never => { throw new StorageError('conflict', 'Git.autoPush', 'Automatic push requires reconciliation', { details: { reason } }); };
  if (!input.driver.remoteHead || !input.driver.pushCommit || !input.driver.remoteIdentity) fail('auto_push_driver_not_assembled');
  const remote = input.policy.push_remote ?? 'origin';
  const remoteDigest = await input.driver.remoteIdentity!(remote);
  const id = `${input.operationId}:push`;
  const read = () => input.session.database.prepare('SELECT * FROM git_pushes WHERE operation_id=?').get(id) as
    { project_id: string; run_id: string; remote: string; remote_digest: string; branch: string; commit_sha: string; status: string } | undefined;
  input.assertCurrent();
  input.session.transactWrite('Git.autoPush.intent', () => {
    const previous = read();
    if (previous) {
      if (previous.project_id !== input.projectId || previous.run_id !== input.runId || previous.remote !== remote
        || previous.remote_digest !== remoteDigest || previous.branch !== input.branch || previous.commit_sha !== input.commit) fail('auto_push_intent_changed');
      return;
    }
    input.session.database.prepare(`INSERT INTO git_pushes
      (operation_id,project_id,run_id,boundary,remote,remote_digest,branch,commit_sha,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, input.projectId, input.runId, input.boundary, remote, remoteDigest, input.branch, input.commit, Date.now(), Date.now());
  });
  if (read()?.status === 'succeeded') return;
  const settle = (status: string) => input.session.transactWrite('Git.autoPush.settle', () => {
    input.session.database.prepare('UPDATE git_pushes SET status=?,updated_at=? WHERE operation_id=?').run(status, Date.now(), id);
  });
  try {
    input.assertCurrent();
    const before = await input.driver.remoteHead!(remote, input.branch);
    input.assertCurrent();
    if (before !== input.commit) await input.driver.pushCommit!(remote, input.branch, input.commit);
    const after = await input.driver.remoteHead!(remote, input.branch);
    if (after !== input.commit) { settle('unknown'); fail('auto_push_remote_not_confirmed'); }
    settle('succeeded');
  } catch {
    if (read()?.status !== 'succeeded') settle('unknown');
    fail('auto_push_failed_or_unknown');
  }
}
