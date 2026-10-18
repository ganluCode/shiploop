import { describe, expect, it } from 'vitest';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { randomUUID } from 'node:crypto';
import { NOW, budgetServices } from '../../helpers/p03-3/budget-fixture.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { WorkResourceStopVerifier } from '../../../packages/core/src/ports/work-resources.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { ATTEMPT_DIAGNOSTICS_LIMIT } from '../../../packages/core/src/ports/attempt-lifecycle.ts';

async function fixture(stopVerifier?: WorkResourceStopVerifier) {
  const f = await openClaimFixture([[], ['t-1']]);
  const attempt = f.store().claimTask(f.input()).receipt.attempt;
  const identity = { projectId: attempt.projectId, attemptId: attempt.id, taskId: attempt.taskId,
    runId: attempt.runId, owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
  const store = () => createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1, ...(stopVerifier ? { stopVerifier } : {}) });
  const resources = () => createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
  const resourceIdentity = { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
  const launch = () => f.box.session.transactWrite('launch', () => {
    createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt.projectId, batchId: f.ids.batchId, runId: attempt.runId, startKey: attempt.id,
    });
    resources().beginLaunchInTransaction(resourceIdentity);
    resources().confirmLaunchInTransaction(resourceIdentity, { launchId: '10000000-0000-4000-8000-000000000001', pid: 123, processGroupId: 123, startTime: 'start-1' });
  });
  const executing = () => store().apply({ ...identity, notificationId: 'started', kind: 'executing' });
  const complete = () => store().apply({ ...identity, notificationId: 'complete', kind: 'runtime_completed',
    exitCode: 0, evidenceRef: attempt.inputRef });
  const snapshot = () => ({ ...f.snapshot(), notifications: f.box.session.database.prepare('SELECT * FROM attempt_notifications ORDER BY id').all() });
  return { ...f, snapshot, attempt, identity, resourceIdentity, lifecycle: store, resources, launch, executing, complete };
}

describe('F-005 fenced Attempt lifecycle', () => {
  it('atomically releases a passed verification and is idempotent across two lifecycle writers', async () => {
    const stopVerifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const f = await fixture(stopVerifier);
    const other = openSqliteStorageSession({ path: f.box.box.dbPath });
    try {
      f.box.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run(f.attempt.inputRef, f.attempt.id);
      f.launch(); f.executing();
      const runtimeNotification = { ...f.identity, notificationId: 'complete-for-release', kind: 'runtime_completed' as const,
        exitCode: 0, evidenceRef: f.attempt.inputRef };
      const token = await stopVerifier.verify(f.resources().read(f.resourceIdentity));
      expect(token).not.toBeNull();
      expect(f.lifecycle().apply(runtimeNotification, token)).toMatchObject({ status: 'verifying', stopConfirmed: true });
      const code = f.box.session.database.prepare('SELECT content_hash FROM artifacts WHERE id = ?').get(f.attempt.inputRef) as { content_hash: string };
      const batchId = '00000000-0000-4000-8000-000000000071';
      f.box.session.transactWrite('seed-verification', database => {
        database.prepare(`INSERT INTO verification_batches
          (id, created_at, project_id, updated_at, feature_id, run_id, task_id, attempt_id, execution_version,
           operation, code_digest, policy_digest, environment_summary, check_snapshot, selection, status, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tests', ?, ?, '{}', '[{"key":"tests"}]', '{}', 'passed', ?, ?)`)
          .run(batchId, NOW, f.attempt.projectId, NOW, f.attempt.featureId, f.attempt.runId, f.attempt.taskId, f.attempt.id,
            f.attempt.executionVersion, code.content_hash, f.attempt.inputSnapshot.approval.checkPolicyDigest, NOW, NOW + 1);
        database.prepare(`INSERT INTO check_results
          (id, created_at, project_id, updated_at, batch_id, check_key, argv_json, timeout_ms, required, status,
           exit_code, signal, timed_out, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, 'tests', '["tests"]', 1000, 1, 'passed', 0, NULL, 0, ?, ?)`)
          .run('00000000-0000-4000-8000-000000000072', NOW, f.attempt.projectId, NOW, batchId, NOW, NOW + 1);
      });
      const input = { ...f.identity, verificationBatchId: batchId, codeDigest: code.content_hash,
        observationDigest: 'a'.repeat(64), outcome: 'passed' as const };
      const first = (f.lifecycle() as any).submitVerification(input);
      expect(first).toMatchObject({ disposition: 'applied', status: 'succeeded', waitingFor: null });
      expect(f.box.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(f.attempt.id)).toEqual({ status: 'succeeded' });
      expect(f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get(f.attempt.taskId)).toEqual({ status: 'passed' });
      expect(f.box.session.database.prepare('SELECT status FROM runs WHERE id = ?').get(f.attempt.runId)).toEqual({ status: 'running' });
      expect(f.box.session.database.prepare('SELECT status FROM features WHERE id = ?').get(f.attempt.featureId)).toEqual({ status: 'draft' });
      const events = f.box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.attempt.updated'").get() as { count: number };
      const second = (createSqliteAttemptLifecycleStore(other, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 1 }) as any).submitVerification(input);
      expect(second.disposition).toBe('ignored');
      expect((f.box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.attempt.updated'").get() as { count: number }).count).toBe(events.count);
    } finally { other.close(); f.box.close(); }
  });

  it('keeps a machine pass pending when the current Task approval is absent, then releases after approval', async () => {
    const stopVerifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const f = await fixture(stopVerifier);
    try {
      f.box.session.database.prepare('UPDATE attempts SET code_ref = ? WHERE id = ?').run(f.attempt.inputRef, f.attempt.id);
      f.launch(); f.executing();
      const runtimeNotification = { ...f.identity, notificationId: 'complete-for-approval', kind: 'runtime_completed' as const,
        exitCode: 0, evidenceRef: f.attempt.inputRef };
      const token = await stopVerifier.verify(f.resources().read(f.resourceIdentity));
      f.lifecycle().apply(runtimeNotification, token);
      const code = f.box.session.database.prepare('SELECT content_hash FROM artifacts WHERE id = ?').get(f.attempt.inputRef) as { content_hash: string };
      const batchId = '00000000-0000-4000-8000-000000000073';
      f.box.session.transactWrite('seed-verification-approval', database => {
        database.prepare(`INSERT INTO verification_batches
          (id, created_at, project_id, updated_at, feature_id, run_id, task_id, attempt_id, execution_version,
           operation, code_digest, policy_digest, environment_summary, check_snapshot, selection, status, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'tests', ?, ?, '{}', '[{"key":"tests"}]', '{}', 'passed', ?, ?)`)
          .run(batchId, NOW, f.attempt.projectId, NOW, f.attempt.featureId, f.attempt.runId, f.attempt.taskId, f.attempt.id,
            f.attempt.executionVersion, code.content_hash, f.attempt.inputSnapshot.approval.checkPolicyDigest, NOW, NOW + 1);
        database.prepare(`INSERT INTO check_results
          (id, created_at, project_id, updated_at, batch_id, check_key, argv_json, timeout_ms, required, status,
           exit_code, signal, timed_out, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, 'tests', '["tests"]', 1000, 1, 'passed', 0, NULL, 0, ?, ?)`)
          .run('00000000-0000-4000-8000-000000000074', NOW, f.attempt.projectId, NOW, batchId, NOW, NOW + 1);
        database.prepare('UPDATE tasks SET manual_block = 1 WHERE id = ?').run(f.attempt.taskId);
      });
      const input = { ...f.identity, verificationBatchId: batchId, codeDigest: code.content_hash,
        observationDigest: 'b'.repeat(64), outcome: 'passed' as const };
      const blocked = (f.lifecycle() as any).submitVerification(input);
      expect(blocked).toMatchObject({ disposition: 'applied', status: 'verifying', waitingFor: 'approval' });
      const blockedEvents = (f.box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.attempt.updated'").get() as { count: number }).count;
      expect((f.lifecycle() as any).submitVerification(input)).toMatchObject({ disposition: 'replayed', status: 'verifying', waitingFor: 'approval' });
      expect((f.box.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'task.attempt.updated'").get() as { count: number }).count).toBe(blockedEvents);
      expect(f.box.session.database.prepare('SELECT status, reason FROM runs WHERE id = ?').get(f.attempt.runId)).toEqual({ status: 'paused', reason: 'approval' });
      expect(f.box.session.database.prepare('SELECT status FROM features WHERE id = ?').get(f.attempt.featureId)).toEqual({ status: 'awaiting_approval' });
      f.box.session.database.prepare('UPDATE tasks SET manual_block = 0 WHERE id = ?').run(f.attempt.taskId);
      expect((f.lifecycle() as any).submitVerification(input)).toMatchObject({ disposition: 'applied', status: 'succeeded' });
    } finally { f.box.close(); }
  });

  it('records execution completion without granting acceptance or assuming process stop, and replays after reopen', async () => {
    const f = await fixture();
    try {
      f.launch();
      expect(f.executing()).toMatchObject({ disposition: 'applied', status: 'executing' });
      const result = f.complete();
      expect(result).toMatchObject({ disposition: 'applied', status: 'verifying', waitingFor: 'verification_not_assembled',
        runtimeCompleted: true, resultSaved: true, stopConfirmed: false });
      expect(f.box.session.database.prepare('SELECT status, ended_at FROM attempts').get()).toEqual({ status: 'verifying', ended_at: NOW + 1 });
      expect(f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1')).toEqual({ status: 'running' });
      expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
      expect(f.box.session.database.prepare('SELECT runtime_starts, attempts_created FROM execution_batches').get())
        .toEqual({ runtime_starts: 1, attempts_created: 1 });
      expect(f.evaluate().readyTaskIds).toEqual([]);
      const before = f.snapshot();
      f.box.reopen();
      expect(f.complete()).toEqual({ ...result, disposition: 'replayed' });
      expect(f.snapshot()).toEqual(before);
      expect(f.box.session.database.prepare('SELECT status FROM runs').get()).not.toEqual({ status: 'succeeded' });
      expect(f.box.session.database.prepare('SELECT status FROM features').get()).not.toEqual({ status: 'completed' });
    } finally { f.box.close(); }
  });

  it('retains an unstarted preparation failure and total budget, safely releases and does not auto retry', async () => {
    const f = await fixture();
    try {
      const result = f.lifecycle().apply({ ...f.identity, notificationId: 'prep-failed', kind: 'preparation_failed',
        errorKind: 'configuration', evidenceRef: f.attempt.inputRef });
      expect(result).toMatchObject({ disposition: 'applied', status: 'failed', stopConfirmed: true, waitingFor: null });
      expect(f.box.session.database.prepare('SELECT status, error_kind, execution_stage, diagnostic_ref FROM attempts').get())
        .toEqual({ status: 'failed', error_kind: 'configuration', execution_stage: 'preflight', diagnostic_ref: f.attempt.inputRef });
      expect(f.box.session.database.prepare('SELECT attempt_counter, code_attempts_used, status FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ attempt_counter: 1, code_attempts_used: 0, status: 'failed' });
      expect(f.box.session.database.prepare('SELECT attempts_created FROM execution_batches').get()).toEqual({ attempts_created: 1 });
      expect(f.box.session.database.prepare('SELECT * FROM workspace_leases').all()).toEqual([]);
      expect(f.evaluate().readyTaskIds).toEqual([]);
    } finally { f.box.close(); }
  });

  it.each(['owner', 'hostInstanceId', 'executionVersion', 'taskId', 'runId'] as const)('ignores stale or crossed %s without touching business facts', async field => {
    const f = await fixture();
    try {
      f.launch(); f.executing();
      const before = f.snapshot();
      const bad = { ...f.identity, [field]: field === 'executionVersion' ? 2 : field === 'taskId' ? 't-2' : 'other', notificationId: 'late',
        kind: 'runtime_completed', exitCode: 0, evidenceRef: f.attempt.inputRef };
      expect(f.lifecycle().apply(bad)).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
      expect(f.snapshot()).toEqual(before);
      for (let i = 0; i < 50; i++) f.lifecycle().apply({ ...bad, notificationId: `late-${i}` });
      const diagnostics = f.box.session.database.prepare('SELECT * FROM attempt_notification_diagnostics').all();
      expect(diagnostics).toHaveLength(ATTEMPT_DIAGNOSTICS_LIMIT);
      expect(JSON.stringify(diagnostics)).not.toContain('other');
      expect(() => f.box.session.database.prepare('UPDATE attempt_notification_diagnostics SET reason = ?').run('invalid_transition')).toThrow(/immutable/);
      expect(() => f.box.session.database.prepare('DELETE FROM attempt_notification_diagnostics').run()).toThrow(/immutable/);
    } finally { f.box.close(); }
  });

  it.each(['block-first', 'result-first'])('preserves an authorized manual block (%s) without extra code attempts', async order => {
    const f = await fixture();
    const other = openSqliteStorageSession({ path: f.box.box.dbPath });
    try {
      f.launch(); f.executing();
      const block = async () => {
        const revision = other.database.prepare('SELECT revision FROM tasks WHERE id = ?').get('t-1') as { revision: number };
        const receipt = await budgetServices(other).commands.submit(f.box.owner,
          f.box.envelope('task.approval.block', { taskId: 't-1', planDigest: f.attempt.inputSnapshot.approval.planDigest },
            { scope: f.box.scope, expectedRevision: revision.revision, commandId: randomUUID() }));
        expect(receipt.status).toBe('completed');
      };
      if (order === 'block-first') await block();
      expect(f.complete()).toMatchObject({ waitingFor: order === 'block-first' ? 'approval' : 'verification_not_assembled' });
      if (order === 'result-first') await block();
      expect(f.box.session.database.prepare('SELECT manual_block, status, code_attempts_used FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ manual_block: 1, status: 'running', code_attempts_used: 1 });
      expect(f.evaluate().readyTaskIds).toEqual([]);
      expect(f.evaluate().tasks.find(t => t.taskId === 't-2')?.reason).toBe('waiting_approval');
    } finally { other.close(); f.box.close(); }
  });

  it('retains startup uncertainty in quarantine and makes a preparation failure terminal', async () => {
    const f = await fixture();
    try {
      f.box.session.transactWrite('authorize-only', () => f.resources().beginLaunchInTransaction(f.resourceIdentity));
      const input = { ...f.identity, notificationId: 'uncertain', kind: 'preparation_failed', errorKind: 'workspace', evidenceRef: f.attempt.inputRef };
      expect(f.lifecycle().apply(input)).toMatchObject({ disposition: 'applied', status: 'failed', stopConfirmed: false });
      expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
      expect(f.box.session.database.prepare('SELECT error_kind, execution_stage FROM attempts').get())
        .toEqual({ error_kind: 'workspace', execution_stage: 'runtime' });
      const before = f.snapshot();
      expect(f.lifecycle().apply({ ...input, notificationId: 'again' })).toMatchObject({ disposition: 'ignored', reason: 'invalid_transition' });
      expect(f.snapshot()).toEqual(before);
      expect(f.lifecycle().apply(input)).toMatchObject({ disposition: 'replayed' });
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('separately confirms stopped/finalized resources without granting acceptance', async () => {
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const f = await fixture(verifier);
    try {
      f.launch(); f.executing();
      const input = { ...f.identity, notificationId: 'stopped', kind: 'runtime_completed', exitCode: 0, evidenceRef: f.attempt.inputRef };
      const before = f.snapshot();
      expect(() => f.lifecycle().apply(input, { confirmed: true })).toThrow();
      expect(f.snapshot()).toEqual(before);
      const token = await verifier.verify(f.resources().read(f.resourceIdentity));
      expect(token).not.toBeNull();
      expect(f.lifecycle().apply(input, token)).toMatchObject({ status: 'verifying', runtimeCompleted: true, resultSaved: true,
        stopConfirmed: true, waitingFor: 'verification_not_assembled' });
      expect(f.box.session.database.prepare('SELECT * FROM workspace_leases').all()).toEqual([]);
      expect(f.evaluate().readyTaskIds).toEqual([]);
    } finally { f.box.close(); }
  });

  it.each(['executing', 'preparation_failed', 'runtime_completed'])('rolls back %s, counters and resources when its event cannot commit', async kind => {
    const f = await fixture();
    try {
      if (kind !== 'preparation_failed') f.launch();
      if (kind === 'runtime_completed') f.executing();
      const before = f.snapshot();
      f.box.session.database.exec(`CREATE TRIGGER fail_attempt_event BEFORE INSERT ON state_events
        WHEN NEW.event_type = 'task.attempt.updated' BEGIN SELECT RAISE(ABORT, 'event_failure'); END`);
      const input = kind === 'executing' ? { ...f.identity, kind, notificationId: 'event-fail' }
        : kind === 'preparation_failed' ? { ...f.identity, kind, notificationId: 'event-fail', errorKind: 'input', evidenceRef: f.attempt.inputRef }
        : { ...f.identity, kind, notificationId: 'event-fail', exitCode: 0, evidenceRef: f.attempt.inputRef };
      expect(() => f.lifecycle().apply(input)).toThrow();
      expect(f.snapshot()).toEqual(before);
      f.box.session.database.exec('DROP TRIGGER fail_attempt_event');
      expect(f.lifecycle().apply(input).disposition).toBe('applied');
    } finally { f.box.close(); }
  });

  it('does not overwrite a current Task fence, terminal Attempt or reused notification identity', async () => {
    const f = await fixture();
    try {
      expect(f.executing()).toMatchObject({ disposition: 'ignored' });
      f.launch(); f.executing(); f.complete();
      let before = f.snapshot();
      expect(f.lifecycle().apply({ ...f.identity, kind: 'runtime_completed', notificationId: 'complete', exitCode: 1, evidenceRef: f.attempt.inputRef }))
        .toMatchObject({ disposition: 'ignored', reason: 'notification_id_reused' });
      expect(f.snapshot()).toEqual(before);
      f.box.session.database.prepare('UPDATE tasks SET execution_version = execution_version + 1 WHERE id = ?').run('t-1');
      before = f.snapshot();
      expect(f.complete()).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it.each(['succeeded', 'failed', 'cancelled', 'interrupted'])('diagnoses a new completion against terminal %s without resource or budget writes', async status => {
    const f = await fixture();
    try {
      f.launch(); f.executing();
      f.box.session.database.prepare('UPDATE attempts SET status = ?').run(status);
      const before = f.snapshot();
      expect(f.complete()).toMatchObject({ disposition: 'ignored', reason: 'invalid_transition' });
      expect(f.snapshot()).toEqual(before);
      expect(f.box.session.database.prepare('SELECT attempt_id, reason FROM attempt_notification_diagnostics').all())
        .toEqual([{ attempt_id: f.attempt.id, reason: 'invalid_transition' }]);
    } finally { f.box.close(); }
  });

  it('persists a nonzero Runtime result as failed without retrying or fabricating usage', async () => {
    const f = await fixture();
    try {
      f.launch(); f.executing();
      expect(f.lifecycle().apply({ ...f.identity, kind: 'runtime_completed', notificationId: 'failed', exitCode: 17, evidenceRef: f.attempt.inputRef }))
        .toMatchObject({ status: 'failed', runtimeCompleted: true, resultSaved: true, stopConfirmed: false, waitingFor: null });
      expect(f.box.session.database.prepare('SELECT error_kind, execution_stage, exit_code, usage_summary, code_ref FROM attempts').get())
        .toEqual({ error_kind: 'runtime', execution_stage: 'runtime', exit_code: 17, usage_summary: null, code_ref: null });
      expect(f.evaluate().readyTaskIds).toEqual([]);
      expect(f.box.session.database.prepare('SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ attempt_counter: 1, code_attempts_used: 1 });
    } finally { f.box.close(); }
  });

  it('rolls back the result, event and quarantine when the notification receipt cannot commit', async () => {
    const f = await fixture();
    try {
      f.launch(); f.executing();
      const before = f.snapshot();
      f.box.session.database.exec(`CREATE TRIGGER fail_notification BEFORE INSERT ON attempt_notifications
        BEGIN SELECT RAISE(ABORT, 'notification_failure'); END`);
      expect(() => f.complete()).toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it.each([{ injected: true }, { resultSaved: false }, { waitingFor: null }, { status: 'executing' }])(
    'fails closed on a corrupted persisted receipt: %j', async patch => {
      const f = await fixture();
      try {
        f.launch(); f.executing();
        const result = f.complete();
        expect(() => f.box.session.database.prepare('UPDATE attempt_notifications SET receipt = ?').run('{}')).toThrow(/immutable/);
        expect(() => f.box.session.database.prepare('DELETE FROM attempt_notifications').run()).toThrow(/immutable/);
        f.box.session.database.exec('DROP TRIGGER attempt_notifications_immutable_update');
        f.box.session.database.prepare('UPDATE attempt_notifications SET receipt = ? WHERE notification_id = ?')
          .run(JSON.stringify({ ...result, ...patch }), 'complete');
        const before = f.snapshot();
        expect(() => f.complete()).toThrow(expect.objectContaining({ kind: 'corrupt' }));
        expect(f.snapshot()).toEqual(before);
      } finally { f.box.close(); }
    },
  );

  it('rechecks current check-policy identity rather than relying on the claim snapshot', async () => {
    const f = await fixture();
    try {
      f.launch(); f.executing();
      const updated = await f.box.submit('settings.global.update', { schemaVersion: 2,
        strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        policies: { verification: { requireChecksBeforeDone: true } } }, { scope: { kind: 'global' }, expectedRevision: 1 });
      expect(updated.status).toBe('completed');
      expect(f.complete()).toMatchObject({ status: 'verifying', waitingFor: 'approval' });
      expect(f.evaluate()).toMatchObject({ reason: 'waiting_approval', readyTaskIds: [] });
      expect(f.box.session.database.prepare('SELECT code_attempts_used FROM tasks WHERE id = ?').get('t-1')).toEqual({ code_attempts_used: 1 });
    } finally { f.box.close(); }
  });

  it('authorizes manual blocking, binds its digest and Task revision, and commits the event and receipt atomically', async () => {
    const f = await fixture();
    try {
      const revision = (f.box.session.database.prepare('SELECT revision FROM tasks WHERE id = ?').get('t-1') as { revision: number }).revision;
      const command = (planDigest = f.attempt.inputSnapshot.approval.planDigest, expectedRevision = revision) =>
        f.box.envelope('task.approval.block', { taskId: 't-1', planDigest }, { scope: f.box.scope, expectedRevision });
      const restricted = { principalId: 'test-denied', capabilities: new Set<'project.read'>(['project.read']), projectScope: { kind: 'all' as const } };
      const before = f.box.snapshot();
      await expect(f.box.services.commands.submit(restricted, command())).rejects.toMatchObject({ code: 'forbidden' });
      await expect(f.box.services.commands.submit(f.box.owner, command('a'.repeat(64)))).rejects.toMatchObject({ code: 'conflict' });
      await expect(f.box.services.commands.submit(f.box.owner, command(undefined, 1))).rejects.toMatchObject({ code: 'conflict' });
      expect(f.box.snapshot()).toEqual(before);
      f.box.session.database.exec(`CREATE TRIGGER fail_block_receipt BEFORE INSERT ON command_receipts
        WHEN NEW.operation = 'task.approval.block' BEGIN SELECT RAISE(ABORT, 'receipt_failure'); END`);
      await expect(f.box.services.commands.submit(f.box.owner, command())).rejects.toThrow();
      expect(f.box.snapshot()).toEqual(before);
      f.box.session.database.exec('DROP TRIGGER fail_block_receipt');
      const envelope = command();
      const receipt = await f.box.services.commands.submit(f.box.owner, envelope);
      expect(receipt.status).toBe('completed');
      const after = f.box.snapshot();
      expect(await f.box.services.commands.submit(f.box.owner, envelope)).toEqual({ ...receipt, replayed: true });
      expect(f.box.snapshot()).toEqual(after);
      expect(f.box.session.database.prepare('SELECT payload FROM state_events WHERE event_type = ?').all('task.approval.blocked'))
        .toEqual([{ payload: '{"blocked":true}' }]);
    } finally { f.box.close(); }
  });

  it('rejects missing evidence and forged result fields before business writes', async () => {
    const f = await fixture();
    try {
      f.launch(); f.executing();
      const before = f.snapshot();
      const input = { ...f.identity, notificationId: 'bad-result', kind: 'runtime_completed', exitCode: 0, evidenceRef: 'missing' };
      expect(() => f.lifecycle().apply(input)).toThrow(expect.objectContaining({ kind: 'not_found' }));
      for (const field of ['status', 'usage', 'manualBlock', 'codeRef', 'stopConfirmed']) {
        expect(() => f.lifecycle().apply({ ...input, [field]: true })).toThrow(expect.objectContaining({ kind: 'validation' }));
      }
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });
});
