import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync, renameSync, realpathSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { validateBackupManifest, type BackupExternalDependency, type BackupFileEntry, type BackupManifest, type BackupNativeRecord, type BackupProjectEntry, type BackupRecorderWatermark, type BackupSourceSummary } from '../../ports/data-lifecycle.js';
import type { BackupPackageCreateInput, BackupPackageReport, BackupPackageResult, BackupPackageService } from '../../ports/backup-package.js';
import type { ArtifactFileStore } from '../../ports/artifact-files.js';
import type { MaintenanceWriteGate } from '../../ports/data-maintenance.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteBackup } from './backup.js';
import { StorageError } from '../../ports/errors.js';

const OPERATION = 'data.backup.create';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DEFAULTS = { pageSize: 64, maxFiles: 20_000, maxBytes: 512 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 } as const;

type Row = Record<string, unknown>;

export interface BackupPackageLimits {
  readonly pageSize?: number;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

export interface BackupPackageServiceOptions {
  readonly session: SqliteStorageSession;
  readonly dataRoot: string;
  readonly backupRoot: string;
  readonly files: ArtifactFileStore;
  readonly maintenanceGate: MaintenanceWriteGate;
  readonly nowUtcMs?: () => number;
  readonly limits?: BackupPackageLimits;
}

export class BackupPackageError extends Error {
  readonly reason: 'incomplete' | 'failed' | 'target_exists' | 'budget_exhausted';
  readonly backupId: string;
  readonly reportPath: string | null;
  readonly report: BackupPackageReport | null;
  constructor(message: string, reason: BackupPackageError['reason'], backupId: string, reportPath: string | null = null, report: BackupPackageReport | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BackupPackageError';
    this.reason = reason;
    this.backupId = backupId;
    this.reportPath = reportPath;
    this.report = report;
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new StorageError('validation', OPERATION, `${field} 非法`, { details: { field } });
  return value;
}
function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(root + sep); }
function ensureRoot(value: string, field: string): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new StorageError('validation', OPERATION, `${field} 必须是绝对路径`, { details: { field } });
  try { return realpathSync(value); } catch (cause) { throw new StorageError('not_found', OPERATION, `${field} 不存在`, { details: { field }, cause }); }
}
function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
function jsonArray(value: unknown, reason: string): unknown[] {
  if (typeof value !== 'string') throw new Error(reason);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(reason);
  return parsed;
}
function safeReason(value: unknown): string {
  if (typeof value !== 'string') return 'unknown_reference';
  const match = value.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  return match === null ? 'unverified_recording_gap' : value;
}
function classify(kind: string): BackupFileEntry['kind'] {
  const normalized = kind.toLowerCase();
  if (normalized.includes('attachment')) return 'attachment';
  if (normalized.includes('native') || normalized.includes('archive') || normalized.includes('checkpoint')) return 'native';
  if (normalized.includes('recording') || normalized.includes('session')) return 'recording';
  if (normalized.includes('input') || normalized.includes('snapshot')) return 'execution-input';
  if (normalized.includes('document') || normalized.includes('knowledge')) return 'document';
  return 'artifact';
}
function pageRows(db: Database.Database, table: string, projectId: string, cursor: string | undefined, limit: number): Row[] {
  return db.prepare<[string, string, number], Row>(`SELECT * FROM ${table} WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`).all(projectId, cursor ?? '', limit) as Row[];
}
function outputPath(root: string, backupId: string): string { return join(root, backupId); }

async function copyStream(source: NodeJS.ReadableStream, destination: string, maxBytes: number, signal?: AbortSignal): Promise<{ sizeBytes: number; sha256: string }> {
  let sizeBytes = 0;
  const hash = createHash('sha256');
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) { callback(new Error('file_size_limit')); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(source, transform, output, signal === undefined ? {} : { signal });
    return { sizeBytes, sha256: hash.digest('hex') };
  } catch (cause) {
    output.destroy();
    try { unlinkSync(destination); } catch { /* preserve original failure */ }
    throw cause;
  }
}

export function createBackupPackageService(options: BackupPackageServiceOptions): BackupPackageService {
  const root = ensureRoot(options.dataRoot, 'dataRoot');
  const backupRootCandidate = resolve(options.backupRoot);
  mkdirSync(backupRootCandidate, { recursive: true, mode: 0o700 });
  const backupRoot = realpathSync(backupRootCandidate);
  if (!inside(root, backupRoot)) throw new StorageError('ownership', OPERATION, 'backupRoot 必须位于 dataRoot 内', { details: { field: 'backupRoot' } });
  const now = options.nowUtcMs ?? Date.now;
  const limits = {
    pageSize: options.limits?.pageSize ?? DEFAULTS.pageSize,
    maxFiles: options.limits?.maxFiles ?? DEFAULTS.maxFiles,
    maxBytes: options.limits?.maxBytes ?? DEFAULTS.maxBytes,
    maxFileBytes: options.limits?.maxFileBytes ?? DEFAULTS.maxFileBytes,
  };
  if (![limits.pageSize, limits.maxFiles, limits.maxBytes, limits.maxFileBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('BackupPackageService limits 非法');
  }
  let lastReport: BackupPackageReport | null = null;

  async function writeReport(backupId: string, report: BackupPackageReport): Promise<string | null> {
    const reportPath = join(backupRoot, `${backupId}.incomplete.json`);
    const temporary = `${reportPath}.${randomUUID()}.partial`;
    try {
      await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
      try { renameSync(temporary, reportPath); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST') { unlinkSync(temporary); return reportPath; }
        throw cause;
      }
      return reportPath;
    } catch { try { unlinkSync(temporary); } catch { /* no report path */ } return null; }
  }

  async function create(input: BackupPackageCreateInput): Promise<BackupPackageResult> {
    const backupId = validId(input?.backupId, 'backupId');
    const owner = validId(input?.owner, 'owner');
    const hostInstanceId = validId(input?.hostInstanceId, 'hostInstanceId');
    const finalPath = outputPath(backupRoot, backupId);
    if (existsSync(finalPath)) throw new BackupPackageError('备份包目标已存在，拒绝覆盖', 'target_exists', backupId);
    const started = now();
    const lease = options.maintenanceGate.acquire({ operation: 'backup', operationId: backupId, owner, hostInstanceId, nowUtcMs: started });
    let stagingPath: string | undefined;
    let snapshotPath: string | undefined;
    let released = false;
    const reasons: string[] = [];
    let scannedProjects = 0;
    let scannedArtifacts = 0;
    let copiedFiles = 0;
    let totalBytes = 0;
    try {
      stagingPath = join(backupRoot, `.${backupId}.${randomUUID()}.staging`);
      mkdirSync(stagingPath, { recursive: true, mode: 0o700 });
      const snapshotRelative = `backup-snapshots/${backupId}/${backupId}.db`;
      const snapshot = await createSqliteBackup(options.session, { dataRoot: root, operationId: backupId, relativePath: snapshotRelative });
      snapshotPath = snapshot.backupPath;
      const databasePath = join(stagingPath, 'core.sqlite');
      const databaseSource = createReadStream(snapshotPath, { flags: 'r' });
      const databaseCopy = await copyStream(databaseSource, databasePath, limits.maxFileBytes);
      copiedFiles += 1; totalBytes += databaseCopy.sizeBytes;
      const snapshotDb = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      const packageDb = new Database(databasePath, { readonly: true, fileMustExist: true });
      let manifest: BackupManifest;
      try {
        const integrity = packageDb.pragma('integrity_check', { simple: true });
        const foreignKeys = packageDb.pragma('foreign_key_check') as unknown[];
        if (integrity !== 'ok' || foreignKeys.length !== 0) throw new Error('snapshot_integrity_failed');
        const migrations = tableExists(snapshotDb, 'schema_migrations')
          ? snapshotDb.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Row[] : [];
        const migrationDigest = digest(stable(migrations));
        const schemaVersion = migrations.reduce((max, row) => Math.max(max, Number(row.version)), 0);
        const projectEntries: BackupProjectEntry[] = [];
        const artifactRows: Row[] = [];
        const artifactByProject = new Map<string, Map<string, Row>>();
        let projectCursor: string | undefined;
        do {
          const projectPage = snapshotDb.prepare<[string, number], Row>('SELECT * FROM projects WHERE id > ? ORDER BY id LIMIT ?').all(projectCursor ?? '', limits.pageSize + 1) as Row[];
          const selectedProjects = projectPage.slice(0, limits.pageSize);
          for (const project of selectedProjects) {
            const projectId = validId(project.id, 'project.id');
            const status = project.status;
            if (!['active', 'archiving', 'archived', 'deleting'].includes(String(status))) reasons.push(`project_status_unknown:${projectId}`);
            projectEntries.push({ projectId, status: status as BackupProjectEntry['status'], entityDigest: digest(stable(project)) });
            scannedProjects += 1;
            let cursor: string | undefined;
            const projectArtifacts = new Map<string, Row>();
            do {
              const page = pageRows(snapshotDb, 'artifacts', projectId, cursor, limits.pageSize + 1);
              const selected = page.slice(0, limits.pageSize);
              for (const row of selected) { artifactRows.push(row); projectArtifacts.set(String(row.id), row); scannedArtifacts += 1; }
              cursor = selected.length === limits.pageSize ? String(selected.at(-1)!.id) : undefined;
              if (page.length > limits.pageSize && selected.length === 0) reasons.push(`artifact_scan_incomplete:${projectId}`);
            } while (cursor !== undefined);
            artifactByProject.set(projectId, projectArtifacts);
          }
          projectCursor = selectedProjects.length === limits.pageSize ? String(selectedProjects.at(-1)!.id) : undefined;
        } while (projectCursor !== undefined);
        const requiredRefs: Array<{ projectId: string; artifactId: string; reason: string }> = [];
        const requireRef = (projectId: string, artifactId: unknown, reason: string): void => {
          if (typeof artifactId !== 'string' || !artifactByProject.get(projectId)?.has(artifactId)) requiredRefs.push({ projectId, artifactId: String(artifactId), reason });
        };
        const refColumns: Array<[string, string, string]> = [
          ['attempts', 'input_ref', 'execution-input'], ['attempts', 'code_ref', 'attempt-code'], ['attempts', 'diagnostic_ref', 'attempt-diagnostic'],
          ['sessions', 'input_ref', 'session-input'], ['sessions', 'result_ref', 'session-result'], ['session_messages', 'content_ref', 'recording-content'],
          ['recording_manifests', 'manifest_ref', 'recording-manifest'], ['document_versions', 'content_ref', 'document-content'],
          ['memory_records', 'content_ref', 'memory-content'], ['capability_modules', 'content_ref', 'capability-content'],
        ];
        for (const [table, column, reason] of refColumns) if (tableExists(snapshotDb, table)) {
          const rows = snapshotDb.prepare(`SELECT project_id, ${column} AS ref FROM ${table} WHERE ${column} IS NOT NULL`).all() as Row[];
          for (const row of rows) requireRef(String(row.project_id), row.ref, reason);
        }
        for (const [table, columns] of [['document_versions', ['source_refs']], ['memory_records', ['source_refs']], ['session_messages', ['source_refs', 'attachment_refs']]] as const) {
          if (!tableExists(snapshotDb, table)) continue;
          const rows = snapshotDb.prepare(`SELECT project_id, ${columns.join(', ')} FROM ${table}`).all() as Row[];
          for (const row of rows) for (const column of columns) {
            try {
              for (const item of jsonArray(row[column], `invalid_${table}_${column}`)) {
                if (item !== null && typeof item === 'object') requireRef(String(row.project_id), (item as Row).artifactId, `${table}.${column}`);
                else reasons.push(`invalid_reference_json:${table}.${column}`);
              }
            } catch { reasons.push(`invalid_reference_json:${table}.${column}`); }
          }
        }
        if (requiredRefs.length > 0) reasons.push(...requiredRefs.slice(0, 64).map(ref => `unknown_required_reference:${ref.projectId}:${ref.reason}`));
        const files: BackupFileEntry[] = [{ logicalPath: 'core.sqlite', sizeBytes: databaseCopy.sizeBytes, sha256: databaseCopy.sha256, kind: 'database' }];
        const sources: BackupSourceSummary[] = [];
        for (const row of artifactRows) {
          const projectId = String(row.project_id); const artifactId = String(row.id); const status = String(row.status);
          const expected = String(row.expected_hash); const actual = row.content_hash === null ? null : String(row.content_hash);
          const size = row.size_bytes === null ? null : Number(row.size_bytes);
          if (status !== 'ready' || actual === null || size === null) { reasons.push(`artifact_not_ready:${projectId}:${artifactId}`); continue; }
          if (!DIGEST.test(expected) || actual !== expected || !Number.isSafeInteger(size) || size < 0) { reasons.push(`artifact_identity_corrupt:${projectId}:${artifactId}`); continue; }
          if (size > limits.maxFileBytes) { reasons.push(`artifact_size_limit:${projectId}:${artifactId}`); continue; }
          if (copiedFiles >= limits.maxFiles || totalBytes >= limits.maxBytes) { reasons.push('backup_budget_exhausted'); continue; }
          if (totalBytes + size > limits.maxBytes) { reasons.push('backup_budget_exhausted'); continue; }
          const logicalPath = `artifacts/${projectId}/${artifactId}`;
          const destination = join(stagingPath, ...logicalPath.split('/'));
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          const source = await options.files.openFinalRead({ projectId, artifactId });
          const copied = await copyStream(source.stream, destination, limits.maxFileBytes);
          if (copied.sha256 !== actual || copied.sizeBytes !== size) { reasons.push(`artifact_content_drift:${projectId}:${artifactId}`); continue; }
          copiedFiles += 1; totalBytes += copied.sizeBytes;
          if (copiedFiles > limits.maxFiles || totalBytes > limits.maxBytes) reasons.push('backup_budget_exhausted');
          const kind = classify(String(row.kind));
          files.push({ logicalPath, sizeBytes: copied.sizeBytes, sha256: copied.sha256, kind, projectId, sourceDigest: actual });
          sources.push({ kind: 'artifact', logicalPath, digest: actual, revision: String(row.version), status: 'present' });
        }
        const recorder: BackupRecorderWatermark[] = [];
        const nativeRecords: BackupNativeRecord[] = [];
        if (tableExists(snapshotDb, 'sessions')) {
          const sessions = snapshotDb.prepare('SELECT id, project_id, native_ref, recording_watermark, recording_gaps FROM sessions ORDER BY id').all() as Row[];
          for (const session of sessions) {
            const sessionId = String(session.id);
            let gaps: string[] = [];
            if (session.recording_gaps !== null) { try { gaps = jsonArray(session.recording_gaps, 'recording_gaps').map(safeReason); } catch { gaps = ['recording_gaps_invalid']; reasons.push(`recording_gaps_invalid:${sessionId}`); } }
            const manifestRow = tableExists(snapshotDb, 'recording_manifests') ? snapshotDb.prepare('SELECT watermark, coverage, missing_reasons, sdk_version, format_version FROM recording_manifests WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(sessionId) as Row | undefined : undefined;
            let coverage: BackupRecorderWatermark['coverage'] = 'missing';
            let watermark = session.recording_watermark === null ? null : Number(session.recording_watermark);
            if (manifestRow !== undefined) {
              coverage = manifestRow.coverage === 'complete' ? 'complete' : manifestRow.coverage === 'partial' ? 'partial' : 'missing';
              if (manifestRow.watermark !== null) watermark = Number(manifestRow.watermark);
              try { gaps.push(...jsonArray(manifestRow.missing_reasons, 'missing_reasons').map(safeReason)); } catch { gaps.push('missing_reasons_invalid'); }
            } else if (watermark !== null) { coverage = 'partial'; gaps.push('recording_manifest_missing'); }
            gaps = [...new Set(gaps)].slice(0, 32);
            if (coverage !== 'complete') reasons.push(`recording_incomplete:${sessionId}`);
            recorder.push({ sessionId, watermark, coverage, gaps });
            if (session.native_ref !== null) {
              const sourceDigest = digest(String(session.native_ref));
              reasons.push(`native_archive_unavailable:${sessionId}`);
              nativeRecords.push({ logicalPath: `native/${sessionId}`, format: 'declared-native', version: '1', sdkVersion: manifestRow?.sdk_version === null || manifestRow?.sdk_version === undefined ? null : String(manifestRow.sdk_version), sourceDigest, availability: 'unsupported', resumability: 'unsupported', missingReason: 'native_archive_unavailable' });
            }
          }
        }
        const checkpointArtifact = artifactRows.find(row => String(row.status) === 'ready' && String(row.kind).toLowerCase().includes('checkpoint'));
        const checkpoints = checkpointArtifact !== undefined && checkpointArtifact.content_hash !== null
          ? { status: 'available' as const, logicalPath: `artifacts/${checkpointArtifact.project_id}/${checkpointArtifact.id}`, digest: String(checkpointArtifact.content_hash), format: String(checkpointArtifact.media_type), version: String(checkpointArtifact.version) }
          : { status: 'unsupported' as const, reason: 'checkpoint_not_exposed' };
        if (tableExists(snapshotDb, 'repository_bindings')) for (const row of snapshotDb.prepare('SELECT id, project_id FROM repository_bindings ORDER BY id').all() as Row[]) {
          sources.push({ kind: 'repository', logicalPath: `repository/${row.id}`, digest: digest(stable(row)), status: 'unverified' });
        }
        const externalDependencies: BackupExternalDependency[] = tableExists(snapshotDb, 'repository_bindings')
          ? (snapshotDb.prepare('SELECT id, project_id FROM repository_bindings ORDER BY id').all() as Row[]).map(row => ({ projectId: String(row.project_id), kind: 'repository' as const, logicalLocation: `repository/${row.id}`, retention: 'preserved' as const, runnable: false as const, reason: 'external_path_revalidation_required' }))
          : [];
        if (tableExists(snapshotDb, 'managed_workspaces')) externalDependencies.push(...(snapshotDb.prepare('SELECT id, project_id FROM managed_workspaces ORDER BY id').all() as Row[]).map(row => ({ projectId: String(row.project_id), kind: 'worktree' as const, logicalLocation: `worktree/${row.id}`, retention: 'preserved' as const, runnable: false as const, reason: 'external_path_revalidation_required' })));
        if (copiedFiles > limits.maxFiles || totalBytes > limits.maxBytes) reasons.push('backup_budget_exhausted');
        const createdAtUtc = new Date(now()).toISOString();
        const candidate = { schemaVersion: 1 as const, packageVersion: 1, backupId, createdAtUtc, database: { logicalPath: 'core.sqlite' as const, schemaVersion, migrationDigest, contentDigest: databaseCopy.sha256, integrity: { integrityCheck: 'ok' as const, foreignKeyCheck: 'ok' as const } }, projects: projectEntries, files, nativeRecords, sources, checkpoints, recorder, externalDependencies };
        manifest = validateBackupManifest(candidate, OPERATION);
      } finally { snapshotDb.close(); packageDb.close(); }
      await rm(join(stagingPath, 'core.sqlite-shm'), { force: true });
      await rm(join(stagingPath, 'core.sqlite-wal'), { force: true });
      if (reasons.length > 0) {
        const report: BackupPackageReport = { status: 'incomplete', backupId, scannedProjects, scannedArtifacts, copiedFiles, totalBytes, durationMs: Math.max(0, now() - started), reasons: [...new Set(reasons)] };
        lastReport = report;
        const reportPath = await writeReport(backupId, report);
        throw new BackupPackageError('备份包清单不完整，拒绝发布', 'incomplete', backupId, reportPath, report);
      }
      const manifestPath = join(stagingPath, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest!, null, 2), { mode: 0o600, flag: 'wx' });
      if (existsSync(finalPath)) throw new BackupPackageError('备份包目标已存在，拒绝覆盖', 'target_exists', backupId);
      renameSync(stagingPath, finalPath); stagingPath = undefined;
      const report: BackupPackageReport = { status: 'complete', backupId, scannedProjects, scannedArtifacts, copiedFiles, totalBytes, durationMs: Math.max(0, now() - started), reasons: [], manifest };
      lastReport = report;
      return { backupId, packagePath: finalPath, manifestPath: join(finalPath, 'manifest.json'), manifest, report };
    } catch (error) {
      if (error instanceof BackupPackageError) throw error;
      const report: BackupPackageReport = { status: 'failed', backupId, scannedProjects, scannedArtifacts, copiedFiles, totalBytes, durationMs: Math.max(0, now() - started), reasons: ['backup_failed'] };
      lastReport = report;
      throw new BackupPackageError('备份包生成失败，未发布结果', 'failed', backupId, await writeReport(backupId, report), report, error);
    } finally {
      if (snapshotPath !== undefined) { try { await rm(dirname(snapshotPath), { recursive: true, force: true }); } catch { /* cleanup evidence is represented by failure */ } }
      if (stagingPath !== undefined) { try { await rm(stagingPath, { recursive: true, force: true }); } catch { /* preserve old package */ } }
      try { options.maintenanceGate.release({ ...lease, confirmed: true }); released = true; } catch { if (!released) { try { options.maintenanceGate.release({ ...lease, confirmed: false, reason: 'cleanup_unconfirmed' }); } catch { /* blocked state is owned by the gate */ } } }
    }
  }

  return Object.freeze({ create, readLastReport: () => lastReport });
}

export const createDataBackupService = createBackupPackageService;
export const createBackupPackage = createBackupPackageService;
