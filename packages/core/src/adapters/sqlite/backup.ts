/**
 * P07-3 / F-003 SQLite 在线备份适配器。
 *
 * 数据库快照只能通过 better-sqlite3 backup API 生成；目标先在受控根内解析，
 * 备份完成并通过只读完整性核验后才以不覆盖的 hard-link 发布。临时文件失败时
 * 始终清理，因此残缺文件不会成为可恢复目标。
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

const BACKUP_OPERATION = 'storage.backup';
export const SQLITE_BACKUP_DEFAULT_MAX_DURATION_MS = 60_000;
export const SQLITE_BACKUP_MAX_DURATION_MS = 600_000;

export type SqliteBackupFailureReason =
  | 'target_exists'
  | 'backup_failed'
  | 'integrity_failed'
  | 'foreign_key_failed'
  | 'budget_exhausted';

export class SqliteBackupError extends Error {
  readonly reason: SqliteBackupFailureReason;
  readonly backupPath: string;

  constructor(message: string, reason: SqliteBackupFailureReason, backupPath: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SqliteBackupError';
    this.reason = reason;
    this.backupPath = backupPath;
  }
}

export interface SqliteBackupVerification {
  readonly backupPath: string;
  readonly integrityCheck: 'ok';
  readonly foreignKeyCheck: 'ok';
}

export interface CreateSqliteBackupOptions {
  readonly dataRoot: string;
  readonly operationId: string;
  /** 受控根内相对目标；默认 backups/<operationId>.db。 */
  readonly relativePath?: string;
  /** backup API 进度预算；0 表示调用前即耗尽。 */
  readonly maxDurationMs?: number;
  readonly nowUtcMs?: () => number;
  readonly signal?: AbortSignal;
}

export interface SqliteBackupResult extends SqliteBackupVerification {
  readonly relativePath: string;
}

function fsCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function pathError(kind: 'validation' | 'ownership' | 'conflict', field: string, reason: string): StorageError {
  return new StorageError(kind, BACKUP_OPERATION, `storage.backup: ${field} ${reason}`, {
    entity: { type: 'backup' },
    details: { field, reason },
  });
}

function resolveRoot(dataRoot: string): string {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0 || !isAbsolute(dataRoot) || dataRoot.includes('\0')) {
    throw pathError('validation', 'dataRoot', '必须是无 NUL 字节的绝对路径');
  }
  let root: string;
  try {
    root = realpathSync(dataRoot);
  } catch (error) {
    throw new StorageError('not_found', BACKUP_OPERATION, 'storage.backup: 受控数据根不存在', {
      entity: { type: 'backup' },
      details: { reason: fsCode(error) ?? 'root_unavailable' },
      cause: error,
    });
  }
  try {
    if (!lstatSync(root).isDirectory()) throw pathError('validation', 'dataRoot', '必须是目录');
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('validation', BACKUP_OPERATION, 'storage.backup: dataRoot 必须是目录', {
      entity: { type: 'backup' },
      details: { reason: 'data_root_not_directory' },
      cause: error,
    });
  }
  return root;
}

function validateRelativeTarget(value: unknown, operationId: string): string {
  if (value === undefined) return `backups/${operationId}.db`;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || isAbsolute(value)) {
    throw pathError('validation', 'relativePath', '必须是受控根内的相对路径');
  }
  const parts = value.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
    throw pathError('validation', 'relativePath', '包含非法路径段');
  }
  if (parts.at(-1) !== `${operationId}.db`) {
    throw pathError('validation', 'relativePath', '目标文件名必须绑定操作身份');
  }
  return value;
}

function assertParentInside(root: string, target: string, relativePath: string): void {
  const parent = resolve(target, '..');
  if (!inside(root, parent)) {
    throw pathError('ownership', 'relativePath', '目标越出受控数据根');
  }
  const parts = relative(root, parent).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw pathError('ownership', 'relativePath', '祖先包含符号链接');
      if (!stat.isDirectory()) throw pathError('conflict', 'relativePath', '目标祖先不是目录');
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (fsCode(error) !== 'ENOENT') throw new StorageError('ownership', BACKUP_OPERATION, 'storage.backup: 目标祖先不可用', {
        entity: { type: 'backup' }, details: { relativePath, reason: fsCode(error) ?? 'ancestor_unavailable' }, cause: error,
      });
      try { mkdirSync(current, { mode: 0o700 }); } catch (mkdirError) {
        if (fsCode(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      const created = lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw pathError('ownership', 'relativePath', '创建后的目标祖先不是受控目录');
      }
    }
  }
}

function assertSourceInside(root: string, session: SqliteStorageSession): void {
  let source: string;
  try {
    const stat = lstatSync(session.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw pathError('ownership', 'source', '源数据库必须是受控普通文件');
    source = realpathSync(session.path);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('ownership', BACKUP_OPERATION, 'storage.backup: 源数据库不可用', {
      entity: { type: 'backup' }, details: { reason: fsCode(error) ?? 'source_unavailable' }, cause: error,
    });
  }
  if (!inside(root, source)) throw pathError('ownership', 'source', '源数据库越出受控数据根');
}

function assertTargetVacant(target: string, relativePath: string, sourcePath: string): void {
  if (resolve(target) === resolve(sourcePath)) throw pathError('conflict', 'relativePath', '目标不能与源数据库相同');
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw pathError('ownership', 'relativePath', '目标不能是符号链接');
    throw pathError('conflict', 'relativePath', '目标已存在，拒绝覆盖');
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (fsCode(error) !== 'ENOENT') throw new StorageError('conflict', BACKUP_OPERATION, 'storage.backup: 目标不可用', {
      entity: { type: 'backup' }, details: { relativePath, reason: fsCode(error) ?? 'target_unavailable' }, cause: error,
    });
  }
}

function budgetError(backupPath: string): SqliteBackupError {
  return new SqliteBackupError('SQLite 备份预算已耗尽，未发布备份', 'budget_exhausted', backupPath);
}

/** 共享给迁移器的受目标路径备份内核；调用方负责路径安全时也可直接复用。 */
export async function createVerifiedSqliteBackup(
  session: SqliteStorageSession,
  backupPath: string,
  options: Pick<CreateSqliteBackupOptions, 'maxDurationMs' | 'nowUtcMs' | 'signal'> = {},
): Promise<SqliteBackupVerification> {
  if (existsSync(backupPath)) {
    throw new SqliteBackupError('SQLite 备份目标已存在，拒绝覆盖', 'target_exists', backupPath);
  }
  const now = options.nowUtcMs ?? Date.now;
  const maxDurationMs = options.maxDurationMs ?? SQLITE_BACKUP_DEFAULT_MAX_DURATION_MS;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > SQLITE_BACKUP_MAX_DURATION_MS) {
    throw new StorageError('validation', BACKUP_OPERATION, 'storage.backup: maxDurationMs 超出有限预算', {
      entity: { type: 'backup' }, details: { field: 'maxDurationMs', reason: 'invalid_budget' },
    });
  }
  const deadline = now() + maxDurationMs;
  const checkBudget = (): void => {
    if (options.signal?.aborted === true || now() >= deadline) throw budgetError(backupPath);
  };
  checkBudget();
  const temporaryPath = `${backupPath}.${randomUUID()}.partial`;
  let temporaryOwned = false;
  try {
    const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    temporaryOwned = true;
    closeSync(fd);
    await session.database.backup(temporaryPath, {
      progress: () => {
        checkBudget();
        return 100;
      },
    });
    checkBudget();
    let check: Database.Database | undefined;
    try {
      check = new Database(temporaryPath, { readonly: true, fileMustExist: true });
      const integrity = check.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new SqliteBackupError('SQLite 备份 integrity_check 未通过', 'integrity_failed', backupPath);
      const foreignKeys = check.pragma('foreign_key_check') as unknown[];
      if (foreignKeys.length !== 0) throw new SqliteBackupError('SQLite 备份 foreign_key_check 未通过', 'foreign_key_failed', backupPath);
    } catch (error) {
      if (error instanceof SqliteBackupError) throw error;
      throw new SqliteBackupError('SQLite 备份只读完整性核验失败', 'integrity_failed', backupPath, error);
    } finally {
      check?.close();
    }
    const walPath = `${temporaryPath}-wal`;
    if (existsSync(walPath) && lstatSync(walPath).size > 0) {
      throw new SqliteBackupError('SQLite 备份存在未合并 WAL，拒绝发布', 'backup_failed', backupPath);
    }
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${temporaryPath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    checkBudget();
    const stat = lstatSync(temporaryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new SqliteBackupError('SQLite 备份临时文件类型非法', 'backup_failed', backupPath);
    try {
      linkSync(temporaryPath, backupPath);
    } catch (error) {
      if (fsCode(error) === 'EEXIST') throw new SqliteBackupError('SQLite 备份目标已被其他操作占用，拒绝覆盖', 'target_exists', backupPath, error);
      throw new SqliteBackupError('SQLite 备份发布失败', 'backup_failed', backupPath, error);
    }
    unlinkSync(temporaryPath);
    return { backupPath, integrityCheck: 'ok', foreignKeyCheck: 'ok' };
  } catch (error) {
    if (temporaryOwned) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { if (existsSync(temporaryPath + suffix)) unlinkSync(temporaryPath + suffix); } catch { /* keep original failure */ }
      }
    }
    if (error instanceof SqliteBackupError) throw error;
    throw new SqliteBackupError('SQLite 在线备份失败，未发布备份', 'backup_failed', backupPath, error);
  }
}

function mapBackupFailure(error: SqliteBackupError): StorageError {
  const kind = error.reason === 'budget_exhausted' ? 'busy' : error.reason === 'integrity_failed' || error.reason === 'foreign_key_failed' ? 'corrupt' : 'conflict';
  return new StorageError(kind, BACKUP_OPERATION, 'storage.backup: SQLite 备份未发布', {
    entity: { type: 'backup' },
    details: { reason: error.reason },
    cause: error,
  });
}

export async function createSqliteBackup(
  session: SqliteStorageSession,
  options: CreateSqliteBackupOptions,
): Promise<SqliteBackupResult> {
  const operationId = validateStableId(options.operationId, { operation: BACKUP_OPERATION, entity: { type: 'backup' } }, 'operationId');
  const root = resolveRoot(options.dataRoot);
  assertSourceInside(root, session);
  const relativePath = validateRelativeTarget(options.relativePath, operationId);
  const target = resolve(root, relativePath);
  if (!inside(root, target)) throw pathError('ownership', 'relativePath', '目标越出受控数据根');
  assertParentInside(root, target, relativePath);
  assertTargetVacant(target, relativePath, session.path);
  try {
    return { relativePath, ...(await createVerifiedSqliteBackup(session, target, options)) };
  } catch (error) {
    if (error instanceof SqliteBackupError) throw mapBackupFailure(error);
    throw error;
  }
}
