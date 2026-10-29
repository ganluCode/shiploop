import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteWorkRecoveryReconciliationStore } from '../../../packages/core/src/adapters/sqlite/work-recovery-reconciliation.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { BINDING_NOW, openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';

async function publishEvidence(fixture: Awaited<ReturnType<typeof openBindingFixture>>): Promise<string> {
  const body = Buffer.from(JSON.stringify({ kind: 'work-recovery-reconciliation', marker: randomUUID() }));
  return (await fixture.publisher.publishArtifact({
    projectId: fixture.projectId,
    kind: 'workspace_evidence',
    mediaType: 'application/json',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `evidence/${randomUUID()}.json`,
    content: [body],
  })).artifact.id;
}

describe.skipIf(process.platform !== 'darwin')('P07-1 / F-004 SQLite recovery fencing', () => {
  it('[case:recovery-observation-identity-cas] rejects a late observation for another Run without appending an event', async () => {
    const fixture = await openBindingFixture();
    try {
      fixture.claimTask('t-1');
      const store = createSqliteWorkStartupRecoveryStore(fixture.session, { nowUtcMs: () => BINDING_NOW });
      const census = store.fence();
      const target = census.targets[0]!;
      const beforeEvents = fixture.query('SELECT COUNT(*) AS n FROM state_events') as { n: number };

      expect(() => store.observed({
        ...target,
        runId: randomUUID(),
        schemaVersion: 1,
        kind: 'work-startup-recovery',
        stopConfirmed: false,
        observedAtUtcMs: BINDING_NOW,
        workspaceReconciled: false,
        gaps: [...target.gaps],
      }, null)).toThrow('Recovery observation identity changed');

      expect(fixture.query('SELECT COUNT(*) AS n FROM state_events')).toEqual(beforeEvents);
      expect(fixture.query('SELECT execution_version FROM tasks WHERE id = ?', 't-1'))
        .toEqual({ execution_version: target.executionVersion + 1 });
      expect(fixture.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'"))
        .toEqual({ n: 3 });
    } finally {
      fixture.session.database.prepare('DELETE FROM workspace_leases').run();
      fixture.close();
    }
  });

  it('[case:recovery-result-identity-cas] keeps fenced state when published evidence has a late owner identity', async () => {
    const fixture = await openBindingFixture();
    try {
      fixture.claimTask('t-1');
      const startup = createSqliteWorkStartupRecoveryStore(fixture.session, { nowUtcMs: () => BINDING_NOW });
      const target = startup.fence().targets[0]!;
      const source = {
        ...target,
        schemaVersion: 1 as const,
        kind: 'work-startup-recovery' as const,
        stopConfirmed: false,
        observedAtUtcMs: BINDING_NOW,
        workspaceReconciled: false as const,
      };
      const resources = createSqliteWorkResourceAccess(fixture.session, { workspaceAuthority: fixture.authority, nowUtcMs: () => BINDING_NOW });
      const store = createSqliteWorkRecoveryReconciliationStore(fixture.session, { resources, nowUtcMs: () => BINDING_NOW });
      const snapshot = store.load(source);
      const evidenceRef = await publishEvidence(fixture);
      const before = {
        attempt: fixture.query('SELECT status, diagnostic_ref, revision FROM attempts WHERE id = ?', target.attemptId),
        run: fixture.query('SELECT status, revision FROM runs WHERE id = ?', target.runId),
        task: fixture.query('SELECT status, execution_version, revision FROM tasks WHERE id = ?', 't-1'),
        leases: fixture.query('SELECT state, revision FROM workspace_leases ORDER BY resource_key'),
      };
      const evidence = {
        schemaVersion: 1,
        kind: 'work-recovery-reconciliation',
        projectId: target.projectId,
        featureId: snapshot.attempt.featureId,
        runId: target.runId,
        taskId: snapshot.attempt.taskId,
        attemptId: target.attemptId,
        owner: 'late-owner',
        hostInstanceId: target.hostInstanceId,
        executionVersion: target.executionVersion,
        status: 'reconciled',
        gaps: [],
        startupGaps: [],
        workspace: null,
        recording: { sessionId: null, status: null, watermark: null, gaps: [], artifactsChecked: 0 },
        runtime: { launchReceipt: 'missing', stopReceipt: 'not_applicable', sessionId: null, sessionStatus: null,
          providerSessionId: null, nativeSessionOccupied: false, processIdentity: 'not_applicable', lastActivityAtUtcMs: null },
        native: { sessionStorageKind: null, sessionFormatVersion: null, sourceArchiveRef: null, sourceDigest: null,
          sourceVerified: false, singleWriter: 'never_started', opened: false },
        gitOperations: [],
        taskPassed: false,
        newAttemptCreated: false,
        manualNextSteps: [],
        observedAtUtcMs: BINDING_NOW,
      } as never;

      expect(() => store.finish(source, evidence, evidenceRef, { mode: 'none' }, snapshot.recoveryFingerprint))
        .toThrow('recovery_evidence_identity_changed');
      expect(fixture.query('SELECT status, diagnostic_ref, revision FROM attempts WHERE id = ?', target.attemptId))
        .toEqual(before.attempt);
      expect(fixture.query('SELECT status, revision FROM runs WHERE id = ?', target.runId)).toEqual(before.run);
      expect(fixture.query('SELECT status, execution_version, revision FROM tasks WHERE id = ?', 't-1')).toEqual(before.task);
      expect(fixture.query('SELECT state, revision FROM workspace_leases ORDER BY resource_key')).toEqual(before.leases);
      expect(fixture.query('SELECT id FROM artifacts WHERE id = ?', evidenceRef)).toEqual({ id: evidenceRef });
    } finally {
      fixture.session.database.prepare('DELETE FROM workspace_leases').run();
      fixture.close();
    }
  });
});
