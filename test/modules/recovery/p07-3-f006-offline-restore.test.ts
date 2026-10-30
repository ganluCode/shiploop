import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createOfflineRestoreService } from '../../../packages/host/src/runtime/offline-restore.ts';
import { createBackupPackageService } from '../../../packages/core/src/adapters/sqlite/backup-package.ts';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { spawnManagedChild } from '../../helpers/host/managed-child.ts';
import { startHost } from '../../../packages/host/src/runtime/host-startup.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openBindingFixture, publishReadyArtifact } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';

const scriptPath = fileURLToPath(new URL('../../helpers/offline-restore-child.ts', import.meta.url));
const catalog = createStaticRuntimeCapabilityCatalog([]);
function child(root: string, config: Record<string, unknown>) {
  return spawnManagedChild({ scriptPath, config, cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, requireInside: root });
}
async function runChild(root: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const process = child(root, config);
  try {
    await process.waitReady(); process.releaseGo();
    const message = await process.waitMessage('result', 20_000);
    expect((await process.exited).code).toBe(0);
    return message.result as Record<string, unknown>;
  } finally { await process.verifyStopped(); }
}

async function fixture() {
  const box = createTempSandbox('shiploop-restore-');
  const source = join(box.path, 'source');
  const target = join(box.path, 'target');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(target, { mode: 0o700 });
  const session = openSqliteStorageSession({ path: join(source, 'core.sqlite') });
  await migrateSqliteStorage(session);
  session.database.prepare("INSERT INTO projects (id, created_at, updated_at, revision, display_name, status, labels) VALUES ('project-a', 1, 1, 1, 'A', 'active', '[]')").run();
  const body = Buffer.from('restore evidence');
  const hash = createHash('sha256').update(body).digest('hex');
  session.database.prepare("INSERT INTO artifacts (id, created_at, updated_at, revision, project_id, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator) VALUES ('artifact-a', 1, 1, 1, 'project-a', 'document', 'ready', 'text/plain', ?, ?, ?, 1, 'ignored')").run(hash, hash, body.length);
  mkdirSync(join(source, 'projects/project-a/artifacts/artifact-a'), { recursive: true });
  writeFileSync(join(source, 'projects/project-a/artifacts/artifact-a/content'), body);
  const backup = await createBackupPackageService({ session, dataRoot: source, backupRoot: join(source, 'backups'),
    files: createArtifactFileStore({ dataRoot: source }), maintenanceGate: createSqliteMaintenanceWriteGate(session),
  }).create({ backupId: 'backup-a', owner: 'owner-a', hostInstanceId: 'host-a' });
  session.close();
  return { box, source, target, backup, body };
}

describe('F-006 isolated offline restore', () => {
  it('[case:confirmed-restore] requires a bound confirmation and publishes verified SQLite and Artifact bytes', async () => {
    const f = await fixture();
    try {
      const service = createOfflineRestoreService({ dataRoot: f.target });
      const preview = await service.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath });
      await expect(service.confirm({ operationId: 'restore-a', confirmation: 'wrong' })).rejects.toThrow('confirmation_mismatch');
      const result = await service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation });
      expect(result.status).toBe('published');
      expect(result.cleanup).toBe('retained');
      expect(await createOfflineRestoreService({ dataRoot: f.target }).confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).toEqual(result);
      const db = new Database(join(f.target, 'core.sqlite'), { readonly: true });
      try { expect(db.prepare('SELECT id FROM projects').all()).toEqual([{ id: 'project-a' }]); } finally { db.close(); }
      expect(readFileSync(join(f.target, 'projects/project-a/artifacts/artifact-a/content'))).toEqual(f.body);
      expect(readFileSync(join(f.backup.packagePath, 'core.sqlite'))).toEqual(readFileSync(join(f.target, 'core.sqlite')));
    } finally { f.box.cleanup(); }
  });

  it('[case:rejects-target-and-confirmation-drift] refuses existing data, changed target identity, extra files, changed backup and missing confirmation', async () => {
    const f = await fixture();
    try {
      const busy = join(f.box.path, 'busy'); mkdirSync(busy, { mode: 0o700 });
      writeFileSync(join(busy, 'core.sqlite'), 'original');
      await expect(createOfflineRestoreService({ dataRoot: busy }).prepare({ operationId: 'restore-b', packagePath: f.backup.packagePath })).rejects.toThrow('target_not_empty');
      expect(readFileSync(join(busy, 'core.sqlite'), 'utf8')).toBe('original');
      const service = createOfflineRestoreService({ dataRoot: f.target });
      const preview = await service.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath });
      await expect(service.confirm({ operationId: 'restore-a', confirmation: '' })).rejects.toThrow('confirmation_mismatch');
      for (const change of [{ confirmed: false }, { backupId: 'other-backup' }, { manifestDigest: 'b'.repeat(64) },
        { verificationDigest: 'c'.repeat(64) }, { targetDataRootId: 'other-target' }]) {
        await expect(service.confirm({ operationId: 'restore-a', confirmation: { ...preview.confirmation, ...change } })).rejects.toThrow('confirmation_mismatch');
      }
      await expect(service.prepare({ operationId: 'restore-other', packagePath: f.backup.packagePath })).rejects.toThrow('another_restore_operation');
      const manifest = join(f.backup.packagePath, 'manifest.json');
      writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\n');
      await expect(service.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath })).rejects.toThrow('backup_identity_drift');
      writeFileSync(join(f.target, 'new-business-file'), 'keep');
      await expect(service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toThrow('target_not_empty');
      renameSync(f.target, join(f.box.path, 'old-target'));
      mkdirSync(f.target, { mode: 0o700 });
      await expect(service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toThrow('target_drift');
      expect(existsSync(join(f.target, 'core.sqlite'))).toBe(false);
    } finally { f.box.cleanup(); }
  });

  it('[case:staged-content-drift] checks staging again and retains original data and backup on corruption or symlinks', async () => {
    const f = await fixture();
    try {
      const service = createOfflineRestoreService({ dataRoot: f.target });
      const preview = await service.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath });
      const intent = JSON.parse(readFileSync(join(f.target, 'restore-operation.json'), 'utf8'));
      writeFileSync(join(f.target, intent.stagingRelativePath, 'core.sqlite'), 'truncated');
      await expect(service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toThrow('content_drift');
      expect(existsSync(join(f.target, 'core.sqlite'))).toBe(false);
      expect(readFileSync(join(f.source, 'core.sqlite')).length).toBeGreaterThan(100);
      expect(readFileSync(join(f.backup.packagePath, 'core.sqlite')).length).toBeGreaterThan(100);
      const other = join(f.box.path, 'linked'); mkdirSync(other, { mode: 0o700 });
      symlinkSync(f.source, join(other, 'restore-staging'));
      await expect(createOfflineRestoreService({ dataRoot: other }).prepare({ operationId: 'restore-linked', packagePath: f.backup.packagePath })).rejects.toThrow('unsafe_directory');
    } finally { f.box.cleanup(); }
  });

  it('[case:publish-failure-retains-evidence] reports a failed publication and refuses to overwrite changed published bytes on retry', async () => {
    const f = await fixture();
    try {
      const service = createOfflineRestoreService({ dataRoot: f.target,
        async boundary(point) { if (point === 'after-publish') throw new Error('injected-publish-receipt-fault'); } });
      const preview = await service.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath });
      await expect(service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toThrow('injected-publish-receipt-fault');
      expect(JSON.parse(readFileSync(join(f.target, 'restore-operation.json'), 'utf8')).step).toBe('publishing');
      const path = join(f.target, 'projects/project-a/artifacts/artifact-a/content');
      writeFileSync(path, 'changed-by-another-writer');
      await expect(createOfflineRestoreService({ dataRoot: f.target }).confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toThrow('content_drift');
      expect(readFileSync(path, 'utf8')).toBe('changed-by-another-writer');
      expect(readFileSync(join(f.source, 'projects/project-a/artifacts/artifact-a/content'))).toEqual(f.body);
      expect(readFileSync(join(f.backup.packagePath, 'artifacts/project-a/artifact-a'))).toEqual(f.body);
    } finally { f.box.cleanup(); }
  });

  for (const boundary of ['after-file-copy', 'after-copy', 'before-publish', 'after-publish-group', 'after-publish'] as const) {
    it(`[case:crash-${boundary}] resumes the same operation in a new process after SIGKILL at ${boundary}`, async () => {
      const f = await fixture();
      let process: ReturnType<typeof child> | undefined;
      try {
        const copying = boundary === 'after-copy' || boundary === 'after-file-copy';
        let preview: Record<string, unknown> | undefined;
        if (!copying) preview = await runChild(f.box.path, { mode: 'prepare', dataRoot: f.target,
          operationId: 'restore-a', packagePath: f.backup.packagePath });
        process = child(f.box.path, { mode: copying ? 'prepare' : 'confirm', boundary,
          dataRoot: f.target, operationId: 'restore-a', packagePath: f.backup.packagePath, confirmation: preview?.confirmation });
        await process.waitReady(); process.releaseGo();
        await process.waitMessage('boundary', 20_000);
        const competitor = createOfflineRestoreService({ dataRoot: f.target });
        await expect(competitor.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath })).rejects.toMatchObject({ code: 'owner_unknown' });
        await expect(startHost({ dataRoot: f.target, capabilityCatalog: catalog, env: {}, lockTimeoutMs: 0 })).rejects.toMatchObject({ code: 'owner_unknown' });
        process.kill('SIGKILL');
        expect((await process.exited).signal).toBe('SIGKILL');
        // No Host connection or migration may inspect a half-published root.
        await expect(startHost({ dataRoot: f.target, capabilityCatalog: catalog, env: {}, lockTimeoutMs: 0 })).rejects.toThrow('restore_incomplete');
        if (copying) preview = await runChild(f.box.path, { mode: 'prepare', dataRoot: f.target,
          operationId: 'restore-a', packagePath: f.backup.packagePath });
        const inode = boundary === 'after-publish' ? lstatSync(join(f.target, 'core.sqlite')).ino : null;
        const receipt = await runChild(f.box.path, { mode: 'confirm', dataRoot: f.target, operationId: 'restore-a', confirmation: preview!.confirmation });
        expect(receipt.status).toBe('published');
        if (inode !== null) expect(lstatSync(join(f.target, 'core.sqlite')).ino).toBe(inode);
        expect(readFileSync(join(f.target, 'projects/project-a/artifacts/artifact-a/content'))).toEqual(f.body);
        expect(readFileSync(join(f.target, 'core.sqlite'))).toEqual(readFileSync(join(f.backup.packagePath, 'core.sqlite')));
      } finally { await process?.verifyStopped(); f.box.cleanup(); }
    }, 40_000);
  }

  it('[case:business-budget-and-recording-facts] preserves business facts and quarantines restored authority without reusing historical stop proof', async () => {
    const f = await openBindingFixture();
    let app: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
    try {
      const bound = f.claimAndLaunch('t-1');
      const binding = await f.bindingService.bind(f.bindingInput(bound));
      const request = binding.request;
      const identity = { projectId: f.projectId, sessionId: request.sessionId, attemptId: bound.receipt.attempt.id,
        owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
      const sessions = createSqliteWorkSessionStore(f.session);
      const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'restore-test' });
      sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
      const native = await publishReadyArtifact(f, { kind: 'native-archive', locator: 'native/archive', content: '{"history":"retained"}' });
      f.session.database.prepare(`INSERT INTO recording_manifests (id, created_at, updated_at, project_id, revision,
        session_id, run_id, attempt_id, invocation_id, execution_version, version, watermark, final_sequence,
        sequence_reconciliation, coverage, source, scope, missing_reasons, diagnostics, truncation, redaction,
        sdk_version, format_version, native_ref, unknown_event_count, finalized)
        VALUES ('manifest-a', 1, 1, ?, 1, ?, ?, ?, ?, ?, 1, 0, 0, 'match', 'complete', 'native', '{"covers":["public_events"],"excludes":["hidden_reasoning","native_private_storage","unified_audit"]}', '[]', '[]',
          '{"applied":false,"reasons":[]}', '{"applied":false,"reasons":[]}', 'offline', '1', ?, 0, 1)`)
        .run(f.projectId, request.sessionId, f.runId, identity.attemptId, request.invocationId, identity.executionVersion,
          JSON.stringify({ schemaVersion: 1, storageKind: 'artifact', formatVersion: '1' }));
      const store = createSqliteWorkStartupRecoveryStore(f.session);
      const scan = store.fence();
      const old = scan.targets[0]!;
      store.observed({ ...old, schemaVersion: 1, kind: 'work-startup-recovery', stopConfirmed: true,
        workspaceReconciled: false, observedAtUtcMs: Date.now(), gaps: [] }, null);
      const packageResult = await createBackupPackageService({ session: f.session, dataRoot: f.box.dataRoot,
        backupRoot: join(f.box.dataRoot, 'backups'), files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
        maintenanceGate: createSqliteMaintenanceWriteGate(f.session),
      }).create({ backupId: 'business-backup', owner: 'owner-a', hostInstanceId: 'host-a' });
      expect(packageResult.report.status).toBe('complete');
      const target = join(f.box.root, 'restored'); mkdirSync(target, { mode: 0o700 });
      const service = createOfflineRestoreService({ dataRoot: target });
      const preview = await service.prepare({ operationId: 'business-restore', packagePath: packageResult.packagePath });
      await service.confirm({ operationId: 'business-restore', confirmation: preview.confirmation });
      const snapshot = new Database(join(packageResult.packagePath, 'core.sqlite'), { readonly: true });
      const restored = new Database(join(target, 'core.sqlite'), { readonly: true });
      const tables = ['projects', 'phases', 'features', 'tasks', 'runs', 'attempts', 'approvals',
        'execution_batches', 'task_attempt_reservations', 'runtime_start_reservations', 'sessions', 'recording_manifests', 'artifacts'];
      try {
        for (const table of tables) expect(restored.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table)
          .toEqual(snapshot.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      } finally { restored.close(); snapshot.close(); }
      for (const suffix of ['-wal', '-shm']) {
        const path = join(target, `core.sqlite${suffix}`);
        if (existsSync(path)) unlinkSync(path);
      }
      const budgets = f.session.database.prepare('SELECT * FROM execution_batches').all();
      const attemptCount = f.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get();
      let factories = 0;
      app = await openCoreApplication({ dataRoot: target, capabilityCatalog: f.box.capabilityCatalog,
        workRuntimeFactory() { factories++; throw new Error('must-not-assemble-runtime'); } });
      expect((await app.workExecution.scan()).runs).toEqual([]);
      await app.workExecution.recover();
      await app.workExecution.scan();
      expect(factories).toBe(0);
      expect(app.workExecution.recoveryState()).toEqual({ status: 'blocked', reason: 'restored_data_requires_current_facts' });
      expect(() => app!.maintenanceGate!.assertCanWrite('work')).toThrow();
      const after = new Database(join(target, 'core.sqlite'), { readonly: true });
      try {
        expect(after.prepare('SELECT * FROM execution_batches').all()).toEqual(budgets);
        expect(after.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual(attemptCount);
        expect(after.prepare('SELECT status FROM attempts').all()).toEqual([{ status: 'interrupted' }]);
        expect(after.prepare('SELECT DISTINCT state FROM workspace_leases').all()).toEqual([{ state: 'quarantined' }]);
        expect(after.prepare('SELECT native_ref FROM recording_manifests').get()).toEqual(f.session.database.prepare('SELECT native_ref FROM recording_manifests').get());
      } finally { after.close(); }
      const nativeFile = await app.artifactFileStore.openFinalRead({ projectId: f.projectId, artifactId: native.artifactId });
      const chunks: Buffer[] = [];
      for await (const chunk of nativeFile.stream) chunks.push(Buffer.from(chunk));
      expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(native.contentHash);
      // Even a trusted owner cannot turn restored authorization into a new Run.
      await expect(app.commandService.submit(createLocalOwnerPrincipal(), { schemaVersion: 5,
        commandId: 'restore-no-resume', issuedAt: new Date().toISOString(), operation: 'execution.resume',
        scope: { projectId: f.projectId }, payload: { runId: f.runId } } as never)).rejects.toBeDefined();
      await app.workExecution.close();
    } finally { await app?.workExecution.close(); app?.close(); f.close(); }
  }, 30_000);

  it('[case:first-host-identity-and-isolation] creates fresh Host credentials and keeps restored roots blocked across restarts', async () => {
    const f = await fixture();
    let process: ReturnType<typeof child> | undefined;
    try {
      const service = createOfflineRestoreService({ dataRoot: f.target });
      const preview = await service.prepare({ operationId: 'restore-a', packagePath: f.backup.packagePath });
      await service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation });
      expect(existsSync(join(f.target, 'host/auth.token'))).toBe(false);
      let priorInstance: unknown;
      let priorToken: string | undefined;
      for (let generation = 0; generation < 2; generation++) {
        process = child(f.box.path, { mode: 'host', dataRoot: f.target });
        await process.waitReady(); process.releaseGo();
        const ready = await process.waitMessage('host_ready', 20_000);
        expect(ready.isolated).toBe(true);
        expect(ready.recovery).toMatchObject({ status: 'blocked', reason: 'restored_data_requires_current_facts' });
        const token = readFileSync(join(f.target, 'host/auth.token'), 'utf8');
        expect(ready.hostInstanceId).not.toBe(priorInstance);
        expect(token).not.toBe(priorToken);
        await expect(service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toMatchObject({ code: 'owner_unknown' });
        priorInstance = ready.hostInstanceId; priorToken = token;
        process.send({ kind: 'close' });
        expect((await process.exited).code).toBe(0);
      }
      await expect(service.confirm({ operationId: 'restore-a', confirmation: preview.confirmation })).rejects.toThrow('target_already_activated');
    } finally { await process?.verifyStopped(); f.box.cleanup(); }
  }, 40_000);
});
