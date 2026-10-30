import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { validateBackupManifest, type BackupFileEntry, type BackupManifest } from '../../ports/data-lifecycle.js';
import type {
  BackupPackageVerificationService,
  BackupStagingInput,
  BackupStagingResult,
  BackupVerificationCheck,
  BackupVerificationCheckStatus,
  BackupVerificationInput,
  BackupVerificationLimits,
  BackupVerificationReport,
} from '../../ports/backup-verification.js';
import { StorageError } from '../../ports/errors.js';

const OPERATION = 'data.backup.verify';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULTS = { maxFiles: 20_000, maxBytes: 512 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024, timeoutMs: 30_000 } as const;

type Row = Record<string, unknown>;

type MutableReport = {
  status: BackupVerificationReport['status'];
  backupId: string | null;
  manifestDigest: string | null;
  checks: BackupVerificationCheck[];
  reasons: string[];
  scannedFiles: number;
  verifiedFiles: number;
  totalBytes: number;
  durationMs: number;
  manifest?: BackupManifest;
  stagingRelativePath?: string;
};

export interface BackupPackageVerificationServiceOptions {
  /** Trusted target data root. Staging is always created beneath this root. */
  readonly dataRoot: string;
  readonly nowUtcMs?: () => number;
  readonly limits?: BackupVerificationLimits;
}

export class BackupPackageVerificationError extends Error {
  readonly reason: string;
  readonly report: BackupVerificationReport;
  constructor(message: string, reason: string, report: BackupVerificationReport, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BackupPackageVerificationError';
    this.reason = reason;
    this.report = report;
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function safeId(value: unknown): boolean {
  return typeof value === 'string' && ID.test(value);
}

function errorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function limitsOf(value: BackupVerificationLimits | undefined): Required<BackupVerificationLimits> {
  const result = {
    maxFiles: value?.maxFiles ?? DEFAULTS.maxFiles,
    maxBytes: value?.maxBytes ?? DEFAULTS.maxBytes,
    maxFileBytes: value?.maxFileBytes ?? DEFAULTS.maxFileBytes,
    timeoutMs: value?.timeoutMs ?? DEFAULTS.timeoutMs,
  };
  if (!Object.values(result).every(item => Number.isSafeInteger(item) && item > 0)) {
    throw new TypeError('BackupPackageVerificationService limits 非法');
  }
  return result;
}

function regularFile(path: string): { sizeBytes: number; nlink: number } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not_regular_file');
  // A package source with more than one link has an untrusted alias. Refuse it
  // rather than guessing whether the other link is inside the package.
  if (stat.nlink !== 1) throw new Error('hard_link_not_allowed');
  return { sizeBytes: stat.size, nlink: stat.nlink };
}

function safePackageEntry(packageRoot: string, logicalPath: string): string {
  if (!logicalPath || isAbsolute(logicalPath) || logicalPath.includes('\\') || logicalPath.includes('\0')) {
    throw new Error('unsafe_logical_path');
  }
  const candidate = resolve(packageRoot, ...logicalPath.split('/'));
  if (!inside(packageRoot, candidate)) throw new Error('unsafe_logical_path');
  const segments = logicalPath.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('unsafe_logical_path');
  }
  let current = packageRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('symlink_not_allowed');
  }
  return candidate;
}

function check(report: MutableReport, name: string, status: BackupVerificationCheckStatus, details?: Readonly<Record<string, unknown>>): void {
  report.checks.push({ name, status, ...(details === undefined ? {} : { details }) });
  if (status !== 'available') {
    const reason = typeof details?.reason === 'string' ? details.reason : `${name}_${status}`;
    report.reasons.push(reason);
  }
}

function finish(report: MutableReport, started: number): BackupVerificationReport {
  const reasons = [...new Set(report.reasons)];
  const hasRejected = report.checks.some(item => item.status === 'rejected');
  const hasProblem = report.checks.some(item => item.status !== 'available');
  const status = hasRejected
    ? 'rejected'
    : report.status === 'failed'
      ? 'failed'
      : hasProblem
        ? 'incomplete'
        : 'complete';
  return Object.freeze({
    status,
    backupId: report.backupId,
    manifestDigest: report.manifestDigest,
    checks: Object.freeze([...report.checks]),
    reasons: Object.freeze(reasons),
    scannedFiles: report.scannedFiles,
    verifiedFiles: report.verifiedFiles,
    totalBytes: report.totalBytes,
    durationMs: Math.max(0, Date.now() - started),
    ...(report.manifest === undefined ? {} : { manifest: report.manifest }),
  });
}

function budgetExceeded(report: MutableReport, started: number, limits: Required<BackupVerificationLimits>, now: () => number): boolean {
  if (report.scannedFiles >= limits.maxFiles || report.totalBytes >= limits.maxBytes || now() - started > limits.timeoutMs) {
    check(report, 'verification-budget', 'incomplete', { reason: 'verification_budget_exhausted' });
    return true;
  }
  return false;
}

async function hashFile(path: string, maxBytes: number, report: MutableReport, started: number, limits: Required<BackupVerificationLimits>, now: () => number): Promise<string> {
  const hash = createHash('sha256');
  let size = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.byteLength;
      if (size > maxBytes || report.totalBytes + chunk.byteLength > limits.maxBytes || now() - started > limits.timeoutMs) {
        callback(new Error('verification_budget_exhausted'));
        return;
      }
      hash.update(chunk);
      report.totalBytes += chunk.byteLength;
      callback();
    },
  });
  await pipeline(createReadStream(path, { flags: 'r' }), transform);
  return hash.digest('hex');
}

function manifestFileFor(manifest: BackupManifest, logicalPath: string): BackupFileEntry | undefined {
  return manifest.files.find(file => file.logicalPath === logicalPath);
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare<[string], { name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function scanPackageEntries(packageRoot: string, allowed: ReadonlySet<string>): void {
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const logicalPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink_not_allowed');
      if (entry.isDirectory()) {
        visit(absolutePath, logicalPath);
      } else if (entry.isFile()) {
        regularFile(absolutePath);
        if (logicalPath !== 'manifest.json' && !allowed.has(logicalPath)) throw new Error('unexpected_package_file');
      } else {
        throw new Error('non_regular_package_entry');
      }
    }
  };
  visit(packageRoot, '');
}

function artifactKey(logicalPath: string): { projectId: string; artifactId: string } | null {
  const parts = logicalPath.split('/');
  if (parts.length !== 3 || parts[0] !== 'artifacts') return null;
  return { projectId: parts[1]!, artifactId: parts[2]! };
}

function reportFor(report: BackupVerificationReport): MutableReport {
  return {
    status: report.status,
    backupId: report.backupId,
    manifestDigest: report.manifestDigest,
    checks: [...report.checks],
    reasons: [...report.reasons],
    scannedFiles: report.scannedFiles,
    verifiedFiles: report.verifiedFiles,
    totalBytes: report.totalBytes,
    durationMs: report.durationMs,
    ...(report.manifest === undefined ? {} : { manifest: report.manifest }),
  };
}

export function createBackupPackageVerificationService(options: BackupPackageVerificationServiceOptions): BackupPackageVerificationService {
  if (!isAbsolute(options.dataRoot) || options.dataRoot.includes('\0')) {
    throw new StorageError('validation', OPERATION, 'dataRoot 必须是绝对路径', { entity: { type: 'backup' } });
  }
  const dataRoot = realpathSync(options.dataRoot);
  const defaultLimits = limitsOf(options.limits);
  const now = options.nowUtcMs ?? Date.now;
  const defaultStagingRoot = join(dataRoot, 'restore-staging');
  mkdirSync(defaultStagingRoot, { recursive: true, mode: 0o700 });

  async function verify(input: BackupVerificationInput): Promise<BackupVerificationReport> {
    const started = now();
    const report: MutableReport = {
      status: 'incomplete', backupId: null, manifestDigest: null, checks: [], reasons: [],
      scannedFiles: 0, verifiedFiles: 0, totalBytes: 0, durationMs: 0,
    };
    const limits = limitsOf(input?.limits ?? defaultLimits);
    let packageRoot: string;
    try {
      if (typeof input?.packagePath !== 'string' || !isAbsolute(input.packagePath) || input.packagePath.includes('\0')) {
        check(report, 'package-path', 'rejected', { reason: 'package_path_invalid' });
        return finish(report, started);
      }
      packageRoot = realpathSync(input.packagePath);
      const packageStat = lstatSync(input.packagePath);
      if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error('package_root_not_directory');
      const manifestPath = safePackageEntry(packageRoot, 'manifest.json');
      const manifestBytes = readFileSync(manifestPath);
      report.manifestDigest = digest(manifestBytes);
      let parsed: unknown;
      try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new StorageError('corrupt', OPERATION, '备份 manifest JSON 损坏', { entity: { type: 'backup' } }); }
      let manifest: BackupManifest;
      try { manifest = validateBackupManifest(parsed, OPERATION); } catch (error) {
        const reason = error instanceof StorageError && error.kind === 'unsupported_version'
          ? 'unsupported_manifest_version'
          : error instanceof StorageError && error.kind === 'corrupt'
            ? 'manifest_corrupt'
            : 'manifest_rejected';
        check(report, 'manifest', 'rejected', { reason });
        return finish(report, started);
      }
      report.manifest = manifest;
      report.backupId = manifest.backupId;
      if (input.expectedBackupId !== undefined && input.expectedBackupId !== manifest.backupId) {
        check(report, 'backup-identity', 'rejected', { reason: 'backup_id_mismatch' });
        return finish(report, started);
      }
      check(report, 'manifest', 'available', { reason: 'manifest_valid' });
      check(report, 'backup-version', 'available', { reason: 'format_supported' });

      const projectIds = new Set(manifest.projects.map(project => project.projectId));
      if (projectIds.size !== manifest.projects.length) check(report, 'project-ownership', 'corrupt', { reason: 'duplicate_project' });
      const databaseEntry = manifestFileFor(manifest, manifest.database.logicalPath);
      if (databaseEntry === undefined) {
        check(report, 'database-file', 'missing', { reason: 'database_file_missing_from_manifest' });
        return finish(report, started);
      }
      let databasePath: string;
      try {
        databasePath = safePackageEntry(packageRoot, databaseEntry.logicalPath);
      } catch (error) {
        check(report, 'database-file', errorCode(error) === 'ENOENT' ? 'missing' : 'rejected', { reason: errorCode(error) === 'ENOENT' ? 'database_file_missing' : 'unsafe_database_path' });
        return finish(report, started);
      }
      report.scannedFiles += 1;
      const databaseStat = regularFile(databasePath);
      if (databaseStat.sizeBytes !== databaseEntry.sizeBytes || databaseStat.sizeBytes > limits.maxFileBytes) {
        check(report, 'database-file', 'corrupt', { reason: 'database_size_mismatch' });
        return finish(report, started);
      }
      const databaseDigest = await hashFile(databasePath, limits.maxFileBytes, report, started, limits, now);
      if (databaseDigest !== databaseEntry.sha256 || databaseDigest !== manifest.database.contentDigest) {
        check(report, 'database-file', 'corrupt', { reason: 'database_hash_mismatch' });
        return finish(report, started);
      }
      report.verifiedFiles += 1;
      check(report, 'database-file', 'available', { reason: 'database_hash_verified' });
      if (budgetExceeded(report, started, limits, now)) return finish(report, started);

      const packageHadShm = existsSync(join(packageRoot, 'core.sqlite-shm'));
      const packageHadWal = existsSync(join(packageRoot, 'core.sqlite-wal'));
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const integrity = db.pragma('integrity_check', { simple: true });
        const foreignKeys = db.pragma('foreign_key_check') as unknown[];
        if (integrity !== 'ok' || foreignKeys.length !== 0) {
          check(report, 'database-integrity', 'corrupt', { reason: 'database_integrity_failed' });
          return finish(report, started);
        }
        check(report, 'database-integrity', 'available', { reason: 'database_integrity_verified' });

        const migrationRows = tableExists(db, 'schema_migrations')
          ? db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Row[]
          : [];
        if (!tableExists(db, 'schema_migrations')) {
          check(report, 'schema-migrations', 'corrupt', { reason: 'schema_migrations_missing' });
        }
        const actualMigrationDigest = digest(stable(migrationRows));
        const schemaVersion = migrationRows.reduce((max, row) => Math.max(max, Number(row.version)), 0);
        if (schemaVersion !== manifest.database.schemaVersion || actualMigrationDigest !== manifest.database.migrationDigest) {
          check(report, 'schema-migrations', 'corrupt', { reason: 'schema_or_migration_digest_mismatch' });
        } else {
          check(report, 'schema-migrations', 'available', { reason: 'schema_and_migration_verified' });
        }
        if (migrationRows.some((row, index) => Number(row.version) !== index + 1 || !safeId(row.checksum) && typeof row.checksum !== 'string')) {
          check(report, 'schema-migrations-sequence', 'corrupt', { reason: 'migration_sequence_invalid' });
        }

        const projects = db.prepare('SELECT * FROM projects ORDER BY id').all() as Row[];
        if (projects.length !== manifest.projects.length || projects.some(row => !projectIds.has(String(row.id)))) {
          check(report, 'project-ownership', 'corrupt', { reason: 'project_set_mismatch' });
        } else if (manifest.projects.some(entry => {
          const row = projects.find(candidate => String(candidate.id) === entry.projectId);
          return row === undefined || digest(stable(row)) !== entry.entityDigest;
        })) {
          check(report, 'project-ownership', 'corrupt', { reason: 'project_entity_digest_mismatch' });
        } else {
          check(report, 'project-ownership', 'available', { reason: 'project_entities_verified' });
        }

        const artifacts = db.prepare('SELECT * FROM artifacts ORDER BY id').all() as Row[];
        const manifestArtifactFiles = new Map<string, BackupFileEntry>();
        for (const file of manifest.files) {
          const key = artifactKey(file.logicalPath);
          if (key !== null) {
            if (file.projectId !== key.projectId || !projectIds.has(key.projectId)) {
              check(report, 'entity-references', 'corrupt', { reason: 'cross_project_artifact_reference' });
            }
            manifestArtifactFiles.set(`${key.projectId}:${key.artifactId}`, file);
          }
        }
        if (artifacts.some(row => !projectIds.has(String(row.project_id)))) {
          check(report, 'entity-references', 'corrupt', { reason: 'artifact_project_missing' });
        }
        for (const row of artifacts) {
          if (String(row.status) !== 'ready') continue;
          const file = manifestArtifactFiles.get(`${row.project_id}:${row.id}`);
          if (file !== undefined && (file.sourceDigest !== String(row.content_hash) || file.sha256 !== String(row.content_hash) || file.sizeBytes !== Number(row.size_bytes))) {
            check(report, 'entity-references', 'corrupt', { reason: 'artifact_identity_mismatch', artifactId: String(row.id) });
          }
        }
        for (const dependency of manifest.externalDependencies) {
          if (!projectIds.has(dependency.projectId)) check(report, 'entity-references', 'corrupt', { reason: 'external_dependency_project_missing' });
        }
        if (artifacts.some(row => String(row.status) === 'ready' && !manifestArtifactFiles.has(`${row.project_id}:${row.id}`))) {
          check(report, 'entity-references', 'missing', { reason: 'ready_artifact_body_missing' });
        } else {
          check(report, 'entity-references', 'available', { reason: 'artifact_project_references_verified' });
        }

        if (manifest.recorder.some(record => record.coverage !== 'complete' || record.gaps.length > 0)) {
          check(report, 'recorder', 'incomplete', { reason: 'recorder_coverage_partial' });
        } else if (tableExists(db, 'sessions')) {
          const sessionIds = new Set((db.prepare('SELECT id FROM sessions').all() as Row[]).map(row => String(row.id)));
          if (manifest.recorder.some(record => !sessionIds.has(record.sessionId))) {
            check(report, 'recorder', 'missing', { reason: 'recorder_session_missing' });
          } else {
            check(report, 'recorder', 'available', { reason: 'recorder_watermarks_complete' });
          }
        } else {
          check(report, 'recorder', 'available', { reason: 'recorder_watermarks_complete' });
        }
        if (manifest.nativeRecords.some(record => record.availability !== 'readable' || record.resumability === 'unsupported' || record.resumability === 'unverified')) {
          check(report, 'native-records', 'incomplete', { reason: 'native_record_unavailable' });
        } else {
          check(report, 'native-records', 'available', { reason: 'native_records_verified' });
        }
        if (manifest.checkpoints.status !== 'available') {
          if (manifest.checkpoints.status === 'unsupported') {
            check(report, 'checkpoint', 'available', { reason: 'checkpoint_unsupported_explicitly' });
          } else {
            check(report, 'checkpoint', 'incomplete', { reason: 'checkpoint_unavailable' });
          }
        } else if (manifestFileFor(manifest, manifest.checkpoints.logicalPath) === undefined) {
          check(report, 'checkpoint', 'missing', { reason: 'checkpoint_body_missing' });
        } else {
          check(report, 'checkpoint', 'available', { reason: 'checkpoint_reference_verified' });
        }

        for (const file of manifest.files) {
          if (budgetExceeded(report, started, limits, now)) return finish(report, started);
          if (file.logicalPath === manifest.database.logicalPath) continue;
          if (!safeId(file.projectId) && file.projectId !== undefined) {
            check(report, 'file-ownership', 'corrupt', { reason: 'file_project_invalid' });
            continue;
          }
          let filePath: string;
          try { filePath = safePackageEntry(packageRoot, file.logicalPath); } catch (error) {
            const missing = errorCode(error) === 'ENOENT';
            check(report, 'file-content', missing ? 'missing' : 'rejected', { reason: missing ? 'file_missing' : (error instanceof Error ? error.message : 'unsafe_logical_path'), logicalPath: file.logicalPath });
            continue;
          }
          report.scannedFiles += 1;
          if (file.sizeBytes > limits.maxFileBytes || report.totalBytes + file.sizeBytes > limits.maxBytes) {
            check(report, 'file-content', 'incomplete', { reason: 'verification_budget_exhausted', logicalPath: file.logicalPath });
            return finish(report, started);
          }
          try {
            const stat = regularFile(filePath);
            const actual = await hashFile(filePath, limits.maxFileBytes, report, started, limits, now);
            if (stat.sizeBytes !== file.sizeBytes || actual !== file.sha256) {
              check(report, 'file-content', 'corrupt', { reason: 'file_hash_or_size_mismatch', logicalPath: file.logicalPath });
            } else {
              report.verifiedFiles += 1;
              check(report, 'file-content', 'available', { reason: 'file_hash_verified', logicalPath: file.logicalPath });
            }
          } catch (error) {
            check(report, 'file-content', error instanceof Error && error.message === 'verification_budget_exhausted' ? 'incomplete' : 'corrupt', { reason: error instanceof Error ? error.message : 'file_read_failed', logicalPath: file.logicalPath });
            if (error instanceof Error && error.message === 'verification_budget_exhausted') return finish(report, started);
          }
        }
      } finally {
        db.close();
        if (!packageHadShm) {
          try { unlinkSync(join(packageRoot, 'core.sqlite-shm')); } catch { /* SQLite read-only sidecar cleanup */ }
        }
        if (!packageHadWal) {
          try { unlinkSync(join(packageRoot, 'core.sqlite-wal')); } catch { /* SQLite read-only sidecar cleanup */ }
        }
      }
      scanPackageEntries(packageRoot, new Set(manifest.files.map(file => file.logicalPath)));
      return finish(report, started);
    } catch (error) {
      report.status = 'failed';
      if (error instanceof StorageError && error.kind === 'unsupported_version') {
        check(report, 'manifest', 'rejected', { reason: 'unsupported_manifest_version' });
      } else if (error instanceof Error && ['unsafe_logical_path', 'symlink_not_allowed', 'hard_link_not_allowed', 'package_root_not_directory', 'package_root_invalid', 'unexpected_package_file', 'non_regular_package_entry', 'not_regular_file'].includes(error.message)) {
        check(report, 'package-safety', 'rejected', { reason: error.message });
      } else {
        check(report, 'verification', 'corrupt', { reason: 'verification_failed' });
      }
      return finish(report, started);
    }
  }

  async function stage(input: BackupStagingInput): Promise<BackupStagingResult> {
    const verification = await verify(input);
    const report = reportFor(verification);
    if (verification.status !== 'complete' || verification.manifest === undefined) {
      return Object.freeze({ ...verification, status: verification.status === 'complete' ? 'rejected' : verification.status });
    }
    if (input.verification !== undefined && (input.verification.status !== 'complete' || input.verification.manifestDigest !== verification.manifestDigest)) {
      check(report, 'verification-token', 'rejected', { reason: 'verification_report_mismatch' });
      return finish(report, now());
    }
    const limits = limitsOf(input.limits ?? defaultLimits);
    const started = now();
    const stagingRoot = realpathSync(defaultStagingRoot);
    if (!inside(dataRoot, stagingRoot)) {
      check(report, 'staging-root', 'rejected', { reason: 'staging_root_escape' });
      return finish(report, started);
    }
    report.scannedFiles = 0;
    report.verifiedFiles = 0;
    report.totalBytes = 0;
    const stagingName = `${verification.manifest.backupId}-${digest(`${verification.manifest.backupId}:${started}:${Math.random()}`).slice(0, 16)}`;
    const stagingPath = join(stagingRoot, stagingName);
    const stagingRelativePath = relative(dataRoot, stagingPath).split(sep).join('/');
    try {
      await mkdir(stagingPath, { recursive: true, mode: 0o700 });
      for (const file of verification.manifest.files) {
        if (report.scannedFiles >= limits.maxFiles || report.totalBytes + file.sizeBytes > limits.maxBytes || now() - started > limits.timeoutMs) {
          throw new BackupPackageVerificationError('恢复 staging 预算耗尽', 'staging_budget_exhausted', finish(report, started));
        }
        const source = safePackageEntry(realpathSync(input.packagePath), file.logicalPath);
        const sourceStat = regularFile(source);
        if (sourceStat.sizeBytes !== file.sizeBytes) throw new Error('source_changed_during_staging');
        const destination = safePackageEntryForStaging(stagingPath, file.logicalPath);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const sourceFd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
          await pipeline(createReadStream(source, { fd: sourceFd, autoClose: true }), output);
        } catch (error) {
          try { outputCleanup(destination); } catch { /* retain original error */ }
          throw error;
        }
        const destinationStat = regularFile(destination);
        if (destinationStat.sizeBytes !== file.sizeBytes || digest(readFileSync(destination)) !== file.sha256) throw new Error('staged_file_mismatch');
        report.scannedFiles += 1;
        report.verifiedFiles += 1;
        report.totalBytes += file.sizeBytes;
      }
      report.status = 'complete';
      report.stagingRelativePath = stagingRelativePath;
      report.durationMs = Math.max(0, now() - started);
      return Object.freeze({ ...finish(report, started), status: 'complete', stagingRelativePath });
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof BackupPackageVerificationError) {
        const incomplete = reportFor(error.report);
        incomplete.status = 'incomplete';
        incomplete.reasons.push('staging_budget_exhausted');
        return finish(incomplete, started);
      }
      check(report, 'staging', 'corrupt', { reason: error instanceof Error ? error.message : 'staging_failed' });
      return finish(report, started);
    }
  }

  async function verifyAndStage(input: BackupStagingInput): Promise<BackupStagingResult> {
    return stage(input);
  }

  return Object.freeze({ verify, stage, verifyAndStage });
}

function safePackageEntryForStaging(stagingRoot: string, logicalPath: string): string {
  if (!logicalPath || isAbsolute(logicalPath) || logicalPath.includes('\\') || logicalPath.includes('\0')) throw new Error('unsafe_logical_path');
  if (logicalPath.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) throw new Error('unsafe_logical_path');
  const destination = resolve(stagingRoot, ...logicalPath.split('/'));
  if (!inside(stagingRoot, destination)) throw new Error('unsafe_logical_path');
  let current = stagingRoot;
  for (const segment of logicalPath.split('/').slice(0, -1)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('symlink_not_allowed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return destination;
}

function outputCleanup(path: string): void {
  try { unlinkSync(path); } catch { /* best effort */ }
}

export const createBackupVerifier = createBackupPackageVerificationService;
export const createBackupStagingService = createBackupPackageVerificationService;
