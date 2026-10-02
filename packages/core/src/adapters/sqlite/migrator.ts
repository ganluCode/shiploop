/**
 * F-005 SQLite 迁移执行器：带校验记录的迁移执行、高版本拒写、失败回滚证据与一致性备份。
 *
 * 设计依据：core-design/03 §6（Host 启动读取 Schema 版本，不支持的高版本拒绝写入；
 * 升级前使用 SQLite 支持的备份机制备份并验证，不复制正在写入的单个 db 文件当完整备份；
 * 迁移记录版本与校验摘要，失败保留原备份和可诊断状态）与 core-design/11 §9
 * （schema_migrations：version 唯一、checksum、applied_at）。backup API 与 WAL 在线备份
 * 已经 core-design/03 S2 实验在 macOS arm64 / Node 22.19.0 验证。
 *
 * 执行顺序与不变量：
 * 1. verify（最先，在任何写入之前；本执行器自身不变更任何 PRAGMA——会话打开时应用的
 *    F-004 固定 PRAGMA 策略跨版本一致且不含业务写入）：
 *    - 校验调用方提供的迁移清单：版本自 1 起连续递增、checksum 与 SQL 内容 SHA-256
 *      一致；非法清单在任何数据库接触前抛 StorageError(kind='validation')；
 *    - 库内无 schema_migrations 但存在其他用户表 → 未知库，抛 kind='corrupt' 拒绝
 *      （不擅自清空或接管无法识别的数据）；
 *    - 已应用记录必须自 1 起连续、每条 checksum 与对应迁移描述符一致；缺口/摘要漂移
 *      抛 kind='corrupt'；已应用最高版本高于支持版本抛 kind='unsupported_version'；
 *    - 以上拒写路径不执行任何 DDL/DML，实际行、版本与 Schema 不被自动降级或修改；
 * 2. backup（仅当库已有版本且存在待应用迁移时）：经 better-sqlite3 backup API（SQLite
 *    在线备份）生成独立一致性备份文件，随后以只读连接运行 integrity_check 核验；
 *    目标文件已存在时拒绝覆盖（恢复不自动覆盖用户数据，备份证据也不互相覆盖）；
 *    备份或其核验失败则不开始迁移，抛 SqliteMigrationError(step='backup')；
 * 3. apply：每个待应用迁移在 F-004 短同步写事务内执行 DDL 并写入 schema_migrations
 *    记录（版本、checksum、应用时间），失败整组回滚——DDL 片段与记录无半提交；
 *    抛 SqliteMigrationError(step='apply', version, backupPath)，保留版本/步骤/备份
 *    证据；修复后重开可从一致的原版本继续，不伪装初始化成功。
 *
 * 错误消息脱敏：不包含数据库文件路径或 SQL 原文；备份位置仅出现在结构化证据字段
 * （SqliteMigrationError.backupPath / MigrationResult.backupPath），供受控恢复使用。
 *
 * 边界（本 Feature 明确不做）：Host 停机升级编排、自动降级、桌面打包；数据库备份
 * 只覆盖 SQLite 状态库，不等于含制品正文的全量备份（关联限制见 F-014 文档）。
 * import 本模块无副作用：只有调用 migrateSqliteStorage 才接触文件系统。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import { SQLITE_MIGRATIONS, type SqliteMigration } from './migrations.js';
import type { SqliteStorageSession } from './session.js';

/** 迁移执行的阶段标签：verify=写入前核验；backup=升级前一致性备份；apply=事务内应用。 */
export type SqliteMigrationStep = 'verify' | 'backup' | 'apply';

export interface SqliteMigrationErrorOptions {
  readonly step: SqliteMigrationStep;
  /** 失败涉及的迁移版本；verify/backup 阶段无单一版本时为 null。 */
  readonly version: number | null;
  /** 已生成（或计划）的一致性备份位置；备份阶段之前的失败为 undefined。 */
  readonly backupPath?: string;
  readonly cause?: unknown;
}

/**
 * 迁移执行失败（备份或应用阶段）的结构化证据。
 * verify 阶段的拒写使用 StorageError（unsupported_version/corrupt/validation）表达；
 * 本类表达“已开始保护/变更流程但失败”的证据，保留版本、步骤与备份位置。
 */
export class SqliteMigrationError extends Error {
  readonly step: SqliteMigrationStep;
  readonly version: number | null;
  readonly backupPath: string | undefined;

  constructor(message: string, options: SqliteMigrationErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SqliteMigrationError';
    this.step = options.step;
    this.version = options.version;
    this.backupPath = options.backupPath;
  }
}

export interface MigrateSqliteStorageOptions {
  /**
   * 迁移清单，默认 SQLITE_MIGRATIONS；必须版本自 1 起连续递增且 checksum 与 SQL
   * 内容一致（测试可注入含故障的迁移验证回滚与恢复）。
   */
  readonly migrations?: readonly SqliteMigration[];
  /**
   * 升级备份的显式文件位置（受控路径）；已存在时拒绝覆盖。与 backupDirectory
   * 二选一；都未提供时默认派生到数据库文件同目录（即受控数据根）。
   */
  readonly backupPath?: string;
  /** 派生备份文件名时使用的目录；默认 dirname(session.path)。 */
  readonly backupDirectory?: string;
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性 applied_at 与文件名。 */
  readonly nowUtcMs?: () => number;
}

export interface SqliteMigrationResult {
  /** 迁移前已应用的版本（空库为 0）。 */
  readonly fromVersion: number;
  /** 迁移后当前版本（等于清单最高版本）。 */
  readonly toVersion: number;
  /** 本次实际应用的版本序列（幂等重跑时为空）。 */
  readonly appliedVersions: readonly number[];
  /** 升级前一致性备份位置；空库初始化或无可应用迁移时为 undefined。 */
  readonly backupPath?: string;
}

const MIGRATE_OPERATION = 'storage.migrate';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly checksum: string;
}

function listUserTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return rows.map((row) => row.name);
}

/** 校验调用方提供的迁移清单：连续递增版本 + checksum 与内容一致；失败在接触库前抛出。 */
function verifyProvidedMigrations(migrations: readonly SqliteMigration[]): void {
  const seen = new Set<number>();
  migrations.forEach((migration, index) => {
    const context = { index, version: migration.version };
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new StorageError('validation', MIGRATE_OPERATION, '迁移版本必须是 ≥1 的整数', {
        entity: { type: 'migration' },
        details: context,
      });
    }
    if (migration.version !== index + 1 || seen.has(migration.version)) {
      throw new StorageError(
        'validation',
        MIGRATE_OPERATION,
        '迁移清单必须自版本 1 起连续递增且无重复',
        { entity: { type: 'migration', id: `v${migration.version}` }, details: context },
      );
    }
    seen.add(migration.version);
    if (migration.checksum !== sha256Hex(migration.sql)) {
      throw new StorageError(
        'validation',
        MIGRATE_OPERATION,
        '迁移描述符 checksum 与 SQL 内容的 SHA-256 不一致',
        { entity: { type: 'migration', id: `v${migration.version}` }, details: context },
      );
    }
  });
}

function readAppliedMigrations(db: Database.Database): AppliedMigrationRow[] {
  if (!listUserTableNames(db).includes('schema_migrations')) {
    return [];
  }
  return db
    .prepare<[], AppliedMigrationRow>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    )
    .all();
}

/**
 * 写入前核验已应用记录与迁移清单的一致性；任何不一致都拒写且不修改库。
 */
function verifyAppliedAgainstProvided(
  db: Database.Database,
  migrations: readonly SqliteMigration[],
): AppliedMigrationRow[] {
  const applied = readAppliedMigrations(db);
  if (applied.length === 0) {
    const otherTables = listUserTableNames(db);
    if (otherTables.length > 0) {
      throw new StorageError(
        'corrupt',
        MIGRATE_OPERATION,
        '数据库存在用户表但缺少迁移记录，拒绝接管无法识别的库',
        { entity: { type: 'migration' }, details: { userTables: otherTables.length } },
      );
    }
    return applied;
  }

  const appliedVersion = Math.max(...applied.map((row) => row.version));
  const supportedVersion = migrations.length;
  if (appliedVersion > supportedVersion) {
    throw new StorageError(
      'unsupported_version',
      MIGRATE_OPERATION,
      '数据库由更高版本的 Schema 创建，本版本拒绝写入（不自动降级）',
      {
        entity: { type: 'migration', id: `v${appliedVersion}` },
        details: { appliedVersion, supportedVersion },
      },
    );
  }

  applied.forEach((row, index) => {
    if (row.version !== index + 1) {
      throw new StorageError(
        'corrupt',
        MIGRATE_OPERATION,
        '已应用迁移记录存在版本缺口或乱序（非法迁移序列），拒绝写入',
        {
          entity: { type: 'migration', id: `v${row.version}` },
          details: { version: row.version, expectedPosition: index + 1 },
        },
      );
    }
  });

  for (const row of applied) {
    const descriptor = migrations[row.version - 1]!;
    if (row.checksum !== descriptor.checksum) {
      throw new StorageError(
        'corrupt',
        MIGRATE_OPERATION,
        '已应用迁移的 checksum 与版本控制的迁移描述符不一致，拒绝写入',
        {
          entity: { type: 'migration', id: `v${row.version}` },
          details: { version: row.version },
        },
      );
    }
  }
  return applied;
}

/** 生成独立一致性备份并运行 integrity_check；失败抛 step='backup' 证据错误。 */
async function createVerifiedBackup(
  session: SqliteStorageSession,
  backupPath: string,
): Promise<void> {
  if (existsSync(backupPath)) {
    throw new SqliteMigrationError('升级备份目标已存在，拒绝覆盖已有备份或用户数据', {
      step: 'backup',
      version: null,
      backupPath,
    });
  }
  try {
    await session.database.backup(backupPath);
  } catch (error) {
    throw new SqliteMigrationError('升级前一致性备份失败，不开始迁移', {
      step: 'backup',
      version: null,
      backupPath,
      cause: error,
    });
  }
  let backupCheck: Database.Database | undefined;
  try {
    backupCheck = new Database(backupPath, { readonly: true, fileMustExist: true });
    const integrity = backupCheck.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new SqliteMigrationError('升级备份未通过 integrity_check，不开始迁移', {
        step: 'backup',
        version: null,
        backupPath,
      });
    }
  } catch (error) {
    if (error instanceof SqliteMigrationError) {
      throw error;
    }
    throw new SqliteMigrationError('升级备份核验失败，不开始迁移', {
      step: 'backup',
      version: null,
      backupPath,
      cause: error,
    });
  } finally {
    backupCheck?.close();
  }
}

/**
 * 对给定会话执行带校验记录与备份保护的 SQLite 迁移。
 *
 * - 版本/checksum 核验在任何业务写入前完成；高版本、checksum 不匹配与非法序列拒写；
 * - 已有库升级前生成独立一致性备份（backup API + integrity_check），备份失败不迁移；
 * - 每个迁移在短同步事务内应用并记录，失败整组回滚并保留版本/步骤/备份证据；
 * - 幂等：已是最新版本时不重复应用、不产生备份。
 */
export async function migrateSqliteStorage(
  session: SqliteStorageSession,
  options: MigrateSqliteStorageOptions = {},
): Promise<SqliteMigrationResult> {
  if (!session.isOpen()) {
    throw new Error('SQLite 存储会话已关闭，拒绝执行迁移（operation: storage.migrate）');
  }
  const migrations = options.migrations ?? SQLITE_MIGRATIONS;
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  // 1. verify：清单合法性先于数据库接触；已应用记录核验先于任何写入。
  verifyProvidedMigrations(migrations);
  const applied = verifyAppliedAgainstProvided(session.database, migrations);
  const fromVersion = applied.length;
  const toVersion = migrations.length;
  const pending = migrations.slice(fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion, appliedVersions: [] };
  }

  // 2. backup：已有库升级前生成独立一致性备份（空库初始化无既有数据，不需要备份）。
  let backupPath: string | undefined;
  if (fromVersion >= 1) {
    backupPath =
      options.backupPath ??
      join(
        options.backupDirectory ?? dirname(session.path),
        `state-backup-v${fromVersion}-to-v${toVersion}-${nowUtcMs()}.db`,
      );
    await createVerifiedBackup(session, backupPath);
  }

  // 3. apply：逐迁移在短同步写事务内执行 DDL + 写入迁移记录；失败整组回滚。
  const appliedNow: number[] = [];
  for (const migration of pending) {
    const appliedAt = nowUtcMs();
    try {
      session.transactWrite(MIGRATE_OPERATION, (db) => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) ' +
            'VALUES (?, ?, ?, ?, ?)',
        ).run(`migration-v${migration.version}`, appliedAt, migration.version, migration.checksum, appliedAt);
      });
    } catch (error) {
      throw new SqliteMigrationError(
        `迁移应用失败已整组回滚（step=apply, version=${migration.version}）`,
        { step: 'apply', version: migration.version, backupPath, cause: error },
      );
    }
    appliedNow.push(migration.version);
  }

  return { fromVersion, toVersion, appliedVersions: appliedNow, backupPath };
}
