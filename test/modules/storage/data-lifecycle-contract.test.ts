import { describe, expect, it } from 'vitest';
import {
  BACKUP_MANIFEST_SCHEMA_VERSION,
  DATA_LIFECYCLE_OPERATIONS,
  PROJECT_LIFECYCLE_TRANSITIONS,
  assertRestoreConfirmationMatchesManifest,
  assertDeleteConfirmationMatchesPreview,
  projectLifecycleTransition,
  validateBackupManifest,
  validateDataLifecycleIntent,
  validateDataLifecycleStep,
  validateDataLifecycleResult,
  validateDataLifecycleQuery,
  validateProjectLifecycleRequest,
  validateRestoreConfirmation,
} from '../../../packages/core/src/ports/data-lifecycle.ts';
import {
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
  WORK_TOOL_OPERATION_SPECS,
  validateCommandEnvelopeFields,
  authorizeCommand,
  createLocalOwnerPrincipal,
  createDataLifecycleError,
  validateCommandEnvelope,
} from '../../../packages/core/src/index.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';

const PROJECT_ID = 'project-1';
const BACKUP_ID = 'backup-1';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const UUID = '12345678-1234-4123-8234-1234567890ab';
const ISSUED_AT = '2026-10-30T00:00:00.000Z';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    packageVersion: 1,
    backupId: BACKUP_ID,
    createdAtUtc: ISSUED_AT,
    database: {
      logicalPath: 'core.sqlite',
      schemaVersion: 35,
      migrationDigest: DIGEST_A,
      contentDigest: DIGEST_B,
      integrity: { integrityCheck: 'ok', foreignKeyCheck: 'ok' },
    },
    projects: [{ projectId: PROJECT_ID, status: 'active', entityDigest: DIGEST_A }],
    files: [{ logicalPath: 'projects/project-1/artifacts/a/content', sizeBytes: 12, sha256: DIGEST_B, kind: 'artifact' }],
    nativeRecords: [{
      logicalPath: 'projects/project-1/sessions/s1/native/archive.json',
      format: 'json', version: '1.0', sdkVersion: 'sdk-1',
      sourceDigest: DIGEST_A, availability: 'readable', resumability: 'unsupported',
    }],
    sources: [{ kind: 'artifact', logicalPath: 'projects/project-1/artifacts/a/content', digest: DIGEST_B }],
    checkpoints: { status: 'unsupported', reason: 'adapter_does_not_support_checkpoint' },
    recorder: [{ sessionId: 'session-1', watermark: 3, coverage: 'partial', gaps: ['native_event_4'] }],
    externalDependencies: [{ projectId: PROJECT_ID, kind: 'repository', logicalLocation: 'repository-binding',
      retention: 'preserved', runnable: false, reason: 'repository_identity_unverified' }],
    ...overrides,
  };
}

function command(operation: string, scope: Record<string, unknown>, payload: Record<string, unknown>, expectedRevision?: number) {
  return {
    schemaVersion: 5,
    commandId: UUID,
    operation,
    scope,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    issuedAt: ISSUED_AT,
    payload,
  };
}

describe('P07-3 F-001 data lifecycle contracts', () => {
  it('validates a complete manifest and keeps logical locations separate from host paths', () => {
    const value = validateBackupManifest(manifest());
    expect(value.backupId).toBe(BACKUP_ID);
    expect(value.database.logicalPath).toBe('core.sqlite');
    expect(value.checkpoints).toEqual({ status: 'unsupported', reason: 'adapter_does_not_support_checkpoint' });
    expect(value.recorder[0]?.gaps).toEqual(['native_event_4']);
  });

  it.each([
    ['unknown manifest field', { unexpected: true }],
    ['duplicate file target', { files: [
      { logicalPath: 'projects/project-1/a', sizeBytes: 1, sha256: DIGEST_A, kind: 'artifact' },
      { logicalPath: 'projects/project-1/a', sizeBytes: 1, sha256: DIGEST_A, kind: 'artifact' },
    ] }],
    ['absolute database path', { database: { ...manifest().database as object, logicalPath: '/Users/me/core.sqlite' } }],
    ['path traversal file', { files: [{ logicalPath: '../secret', sizeBytes: 1, sha256: DIGEST_A, kind: 'artifact' }] }],
    ['unsupported checkpoint pretending success', { checkpoints: { status: 'available', archiveFile: 'checkpoint.json' } }],
  ])('rejects %s without exposing input values', (_name, override) => {
    expect(() => validateBackupManifest({ ...manifest(), ...override })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    try {
      validateBackupManifest({ ...manifest(), ...override });
    } catch (error) {
      expect(String(error)).not.toContain('/Users/me');
      expect(String(error)).not.toContain('secret');
    }
  });

  it('rejects an unknown package version deterministically', () => {
    expect(() => validateBackupManifest(manifest({ packageVersion: 2 })))
      .toThrowError(expect.objectContaining({ kind: 'unsupported_version' }));
  });

  it('requires explicit confirmation and binds restore to the exact manifest and isolated target', () => {
    const checked = validateBackupManifest(manifest());
    const confirmation = validateRestoreConfirmation({
      schemaVersion: 1,
      backupId: BACKUP_ID,
      manifestDigest: DIGEST_A,
      verificationDigest: DIGEST_B,
      targetDataRootId: 'restore-root-1',
      targetMode: 'empty-isolated',
      confirmed: true,
    });
    expect(() => assertRestoreConfirmationMatchesManifest(confirmation, checked, DIGEST_A, DIGEST_B, 'restore-root-1')).not.toThrow();
    expect(() => assertRestoreConfirmationMatchesManifest(confirmation, checked, DIGEST_B, DIGEST_B, 'restore-root-1'))
      .toThrowError(expect.objectContaining({ kind: 'conflict' }));
    expect(() => assertRestoreConfirmationMatchesManifest(confirmation, checked, DIGEST_A, DIGEST_A, 'restore-root-1'))
      .toThrowError(expect.objectContaining({ kind: 'conflict' }));
    expect(() => assertRestoreConfirmationMatchesManifest(confirmation, checked, DIGEST_A, DIGEST_B, 'other-root'))
      .toThrowError(expect.objectContaining({ kind: 'conflict' }));
    expect(() => validateRestoreConfirmation({ ...confirmation, confirmed: false }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRestoreConfirmation({ ...confirmation, targetMode: 'replace-active-root' }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
  });

  it('freezes lifecycle transitions and forbids deletion before archive', () => {
    expect(PROJECT_LIFECYCLE_TRANSITIONS).toEqual({
      archive: { from: 'active', to: 'archiving' },
      archiveComplete: { from: 'archiving', to: 'archived' },
      restore: { from: 'archived', to: 'active' },
      delete: { from: 'archived', to: 'deleting' },
    });
    expect(projectLifecycleTransition('archive', 'active')).toBe('archiving');
    expect(projectLifecycleTransition('archiveComplete', 'archiving')).toBe('archived');
    expect(projectLifecycleTransition('restore', 'archived')).toBe('active');
    expect(projectLifecycleTransition('delete', 'active')).toBeNull();
    expect(() => assertDeleteConfirmationMatchesPreview(DIGEST_A, DIGEST_A)).not.toThrow();
    expect(() => assertDeleteConfirmationMatchesPreview(DIGEST_A, DIGEST_B)).toThrowError(expect.objectContaining({ kind: 'conflict' }));
    expect(() => validateProjectLifecycleRequest({ operation: 'delete', projectId: PROJECT_ID, expectedRevision: 0 }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(validateProjectLifecycleRequest({ operation: 'archive', projectId: PROJECT_ID, expectedRevision: 1 }))
      .toMatchObject({ operation: 'archive', projectId: PROJECT_ID, expectedRevision: 1 });
  });

  it('validates narrow operation queries and redacts host paths from public errors', () => {
    expect(validateDataLifecycleQuery({ kind: 'backup', backupId: BACKUP_ID })).toEqual({ kind: 'backup', backupId: BACKUP_ID });
    expect(validateDataLifecycleQuery({ kind: 'project', projectId: PROJECT_ID })).toEqual({ kind: 'project', projectId: PROJECT_ID });
    const error = createDataLifecycleError('corrupt_state', 'backup.verify', 'manifest_hash_mismatch', { hostPath: '/private/key' });
    expect(error).toBeInstanceOf(PublicError);
    expect(error.details).toEqual({ reason: 'manifest_hash_mismatch' });
    expect(String(error)).not.toContain('/private/key');
  });

  it('validates versioned intents, steps and results without allowing arbitrary fields or paths', () => {
    expect(validateDataLifecycleIntent({ schemaVersion: 1, operationId: 'op-1', kind: 'restore', targetId: 'backup-1', intentDigest: DIGEST_A }).kind).toBe('restore');
    expect(validateDataLifecycleStep({ schemaVersion: 1, operationId: 'op-1', step: 'verify', status: 'running' }).status).toBe('running');
    expect(validateDataLifecycleResult({ schemaVersion: 1, operationId: 'op-1', status: 'failed', reason: 'hash_mismatch' }).status).toBe('failed');
    expect(() => validateDataLifecycleResult({ schemaVersion: 1, operationId: 'op-1', status: 'completed', reason: '/private/key' })).toThrow();
    expect(() => validateDataLifecycleIntent({ schemaVersion: 2, operationId: 'op-1', kind: 'backup', targetId: 'backup-1', intentDigest: DIGEST_A })).toThrow();
  });

  it('routes lifecycle commands through the existing envelope and owner authorization', () => {
    for (const operation of DATA_LIFECYCLE_OPERATIONS) {
      expect(COMMAND_OPERATIONS).toContain(operation);
      expect(COMMAND_OPERATION_SPECS[operation]).toBeDefined();
    }
    const archive = validateCommandEnvelope(command('project.archive', { kind: 'project', projectId: PROJECT_ID }, { projectId: PROJECT_ID }, 1));
    expect(archive.operation).toBe('project.archive');
    const backup = validateCommandEnvelope(command('data.backup.create', { kind: 'global' }, { backupId: BACKUP_ID, target: 'managed-backup' }));
    expect(backup.operation).toBe('data.backup.create');
    const owner = createLocalOwnerPrincipal();
    expect(() => authorizeCommand(owner, archive)).not.toThrow();
    expect(() => authorizeCommand({ ...owner, principalId: 'runner', capabilities: new Set(owner.capabilities) }, backup))
      .toThrowError(expect.objectContaining({ code: 'forbidden' }));
    expect(() => validateCommandEnvelopeFields(command('data.backup.create', { kind: 'global' }, { backupId: BACKUP_ID, target: 'managed-backup' }), WORK_TOOL_OPERATION_SPECS))
      .toThrowError(expect.objectContaining({ code: 'unsupported' }));
    expect(() => validateCommandEnvelope(command('project.archive', { kind: 'project', projectId: PROJECT_ID }, { projectId: 'project-2' }, 1)))
      .toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    const manager = { ...owner, principalId: 'manager', capabilities: new Set(owner.capabilities) };
    expect(() => authorizeCommand(manager, archive)).not.toThrow();
    expect(() => authorizeCommand({ ...manager, capabilities: new Set() }, archive))
      .toThrowError(expect.objectContaining({ code: 'forbidden' }));
  });
});
