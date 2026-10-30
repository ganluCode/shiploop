import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import { createMaintenanceWriteGate } from '../../ports/data-maintenance.js';
import { validateWorkProcessIdentity } from '../../ports/work-resources.js';
import type { CommandProcessIdentity } from '../../ports/command-process.js';
import { createArtifactFileStore } from '../fs/artifact-files.js';
import { createBackupPackageVerificationService } from '../fs/backup-verification.js';
import { realStopProbe } from '../process/command-process.js';
import { matchesSupervisorIdentity, type StopEscalationProbe } from '../process/stop-escalation.js';
import { createBackupPackageService } from './backup-package.js';
import { inspectSqliteSchema, migrateSqliteStorage, SqliteMigrationError } from './migrator.js';
import { SQLITE_MIGRATIONS, type SqliteMigration } from './migrations.js';
import { openSqliteStorageSession, type SqliteStorageSession, type SqliteStorageSessionOptions } from './session.js';

type Row = Record<string, unknown>;
const LIMIT = 256;
const OPERATION = 'storage.upgrade';
function blocked(reason: string): never {
  throw new StorageError('busy', OPERATION, '升级前执行停止核验未通过', { details: { reason } });
}
function table(db: Database.Database, name: string): boolean {
  return db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name) !== undefined;
}
function rows(db: Database.Database, sql: string): Row[] {
  const result = db.prepare(`${sql} LIMIT ${LIMIT + 1}`).all() as Row[];
  if (result.length > LIMIT) blocked('process_census_incomplete');
  return result;
}
function identity(raw: unknown, envelope: boolean): CommandProcessIdentity {
  try {
    const parsed = JSON.parse(String(raw)) as Row;
    if (!envelope) return validateWorkProcessIdentity(parsed);
    if (parsed.schemaVersion !== 2) return blocked('process_identity_unsupported');
    const { schemaVersion: _schema, ...value } = parsed;
    return validateWorkProcessIdentity(value);
  } catch { return blocked('process_identity_unknown'); }
}

/** No fencing writes, signals or lease expiry shortcuts. Standard Pi native writers run in
 * the recorded Runner group; unbound native sessions are uncertain and block upgrading. */
export async function assertUpgradeProcessesStopped(db: Database.Database, options: {
  readonly probe?: StopEscalationProbe;
  readonly budgetMs?: number;
} = {}): Promise<void> {
  const probe = options.probe ?? realStopProbe;
  const budgetMs = options.budgetMs ?? 10_000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10_000) throw new TypeError('Invalid upgrade stop budget');
  const deadline = Date.now() + budgetMs;
  const identities = new Map<string, CommandProcessIdentity>();
  const add = (raw: unknown, envelope = false) => {
    if (raw === null || raw === undefined) blocked('process_identity_missing');
    const value = identity(raw, envelope);
    identities.set(JSON.stringify(value), value);
    if (identities.size > LIMIT) blocked('process_census_incomplete');
  };
  const owners = new Set<string>();
  const leaseGroups = new Map<string, Array<string>>();
  // All retained leases count, including expired/quarantined and terminal Attempts.
  if (table(db, 'workspace_leases')) for (const row of rows(db, 'SELECT owner_id, process_identity FROM workspace_leases ORDER BY id')) {
    add(row.process_identity, true); owners.add(String(row.owner_id));
    const group = leaseGroups.get(String(row.owner_id)) ?? [];
    group.push(String(row.process_identity)); leaseGroups.set(String(row.owner_id), group);
  }
  for (const group of leaseGroups.values()) {
    if (group.length !== 3 || group.some(raw => raw !== group[0])) blocked('runner_census_incomplete');
  }
  if (table(db, 'attempts')) for (const row of rows(db, "SELECT id FROM attempts WHERE status IN ('preparing', 'executing', 'verifying') ORDER BY id")) {
    if (!owners.has(String(row.id))) blocked('runner_census_incomplete');
  }
  const baselineOwners = new Set<string>();
  if (table(db, 'baseline_occupancy')) for (const row of rows(db, 'SELECT holder_operation_id, process_identity FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL')) {
    baselineOwners.add(String(row.holder_operation_id));
    // Baseline snapshots also contain publication/workspace facts; only the exact process keys are probed.
    if (row.process_identity === null) blocked('baseline_stop_unknown');
    try {
      const value = JSON.parse(String(row.process_identity)) as Row;
      add(JSON.stringify({ launchId: value.launchId, pid: value.pid, processGroupId: value.processGroupId, startTime: value.startTime }));
    } catch { blocked('baseline_stop_unknown'); }
  }
  if (table(db, 'baseline_operations')) for (const row of rows(db, "SELECT id FROM baseline_operations WHERE status IN ('accepted', 'running', 'cancelling') ORDER BY id")) {
    if (!baselineOwners.has(String(row.id))) blocked('baseline_census_incomplete');
  }
  const verificationBatches = new Set<string>();
  if (table(db, 'verification_processes')) for (const row of rows(db, 'SELECT batch_id, process_identity FROM verification_processes ORDER BY batch_id, check_key')) {
    add(row.process_identity); verificationBatches.add(String(row.batch_id));
  }
  if (table(db, 'verification_batches')) for (const row of rows(db, "SELECT id FROM verification_batches WHERE status = 'running' ORDER BY id")) {
    if (!verificationBatches.has(String(row.id))) blocked('verifier_census_incomplete');
  }
  // A pre-v54 verifier cannot supply the persisted process census. Do not infer stopped from a result row.
  if (table(db, 'verification_batches') && !table(db, 'verification_processes')
    && rows(db, 'SELECT id FROM verification_batches ORDER BY id').length > 0) blocked('verifier_census_unavailable');
  if (table(db, 'sessions')) for (const row of rows(db, "SELECT attempt_id, native_ref, status FROM sessions WHERE native_ref IS NOT NULL OR status = 'started' ORDER BY id")) {
    if (!owners.has(String(row.attempt_id))) blocked('native_writer_stop_unknown');
  }
  // An interrupted maintenance operation needs its own recovery, never an implicit release here.
  if (table(db, 'maintenance_occupancy') && rows(db, "SELECT id FROM maintenance_occupancy WHERE state <> 'idle'").length > 0) blocked('maintenance_stop_unknown');
  // GitAgent repair writers are not ordinary Work Runners. Retain uncertainty rather than reuse a parent PID.
  if (table(db, 'git_agent_repair_attempts') && rows(db, "SELECT id FROM git_agent_repair_attempts WHERE stopped_at IS NULL").length > 0) blocked('repair_stop_unknown');

  async function bounded<T>(action: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) blocked('stop_confirmation_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([action(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StorageError('busy', OPERATION, '升级前停止确认超时', { details: { reason: 'stop_confirmation_timeout' } })), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  for (const value of identities.values()) {
    const row = await bounded(() => probe.readSupervisorRow(value.pid));
    if (row === undefined || (row !== null && !matchesSupervisorIdentity(row, value))) blocked('process_stop_unknown');
    const members = await bounded(() => probe.listGroupMembers(value.processGroupId));
    if (members === undefined) blocked('process_stop_unknown');
    if (members.length !== 0) blocked('process_group_active');
    // Even an empty group does not override a live or reused supervisor identity.
    if (row !== null) blocked('process_group_active');
  }
}

export class SqliteUpgradeError extends Error {
  constructor(
    readonly step: 'backup' | 'apply',
    readonly fromVersion: number,
    readonly toVersion: number,
    readonly packagePath: string | undefined,
    readonly version: number | null,
    cause: unknown,
  ) {
    super(`SQLite 升级失败（step=${step}, from=${fromVersion}, to=${toVersion}, version=${version ?? 'unknown'}）`, { cause });
    this.name = 'SqliteUpgradeError';
  }
}

/** Trusted assembly only: Host holds its data-root lock throughout this function and
 * subsequent Core use. No Runtime/owner request can inject migrations or stop probes. */
export async function openUpgradedSqliteStorage(options: SqliteStorageSessionOptions & {
  readonly dataRoot: string;
  readonly migrations?: readonly SqliteMigration[];
  readonly stopProbe?: StopEscalationProbe;
  readonly stopBudgetMs?: number;
}): Promise<SqliteStorageSession> {
  const migrations = options.migrations ?? SQLITE_MIGRATIONS;
  let fromVersion = 0;
  if (existsSync(options.path)) {
    const db = new Database(options.path, { readonly: true, fileMustExist: true });
    try {
      fromVersion = inspectSqliteSchema(db, migrations).fromVersion;
      if (fromVersion > 0 && fromVersion < migrations.length) await assertUpgradeProcessesStopped(db, { probe: options.stopProbe, budgetMs: options.stopBudgetMs });
    } finally { db.close(); }
  }
  const session = openSqliteStorageSession(options);
  let packagePath: string | undefined;
  try {
    if (fromVersion > 0 && fromVersion < migrations.length) {
      try {
        const service = createBackupPackageService({ session, dataRoot: options.dataRoot,
          backupRoot: join(options.dataRoot, 'backups'), files: createArtifactFileStore({ dataRoot: options.dataRoot }),
          // Startup holds the OS lock, no adapters/listeners exist yet, and this gate never writes the old schema.
          maintenanceGate: createMaintenanceWriteGate() });
        const result = await service.create({ backupId: `upgrade-v${fromVersion}-${randomUUID()}`, owner: 'host-upgrade', hostInstanceId: randomUUID() });
        packagePath = result.packagePath;
        const report = await createBackupPackageVerificationService({ dataRoot: options.dataRoot }).verify({ packagePath });
        if (report.status !== 'complete') throw new Error('upgrade_backup_verification_failed');
        // Recheck the entire census after asynchronous backup, still before migration writes.
        await assertUpgradeProcessesStopped(session.database, { probe: options.stopProbe, budgetMs: options.stopBudgetMs });
      } catch (cause) { throw new SqliteUpgradeError('backup', fromVersion, migrations.length, packagePath, null, cause); }
    }
    try { await migrateSqliteStorage(session, { migrations }); }
    catch (cause) {
      if (cause instanceof SqliteMigrationError) throw new SqliteUpgradeError(cause.step === 'apply' ? 'apply' : 'backup', fromVersion, migrations.length, packagePath, cause.version, cause);
      throw cause;
    }
    return session;
  } catch (cause) { session.close(); throw cause; }
}
