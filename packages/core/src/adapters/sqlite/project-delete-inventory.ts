/**
 * P07-3 / F-009：项目删除预览的 SQLite 只读清点适配器。
 *
 * 纪律：
 * - 数据库事实全部来自单只读一致事务（transactSqliteConsistentRead）；文件
 *   正文哈希与目录扫描在事务外只读执行（不占 SQLite 读事务）；
 * - 对象目标只按 project_id 归属与受管文件区推导；展示名、storage_locator、
 *   客户端路径不参与目标推导；
 * - 未知 project 表、扫描上限、pending/缺失/漂移正文、损坏引用 JSON 一律记为
 *   清点不完整（complete=false），由预览层阻止确认（fail-closed）；
 * - 活动占用复用 F-008 readProjectArchiveCloseoutInDatabase 的同一口径；
 * - 本模块零写入、零进程副作用。
 */
import { computeProjectDeleteDatabaseDigest, projectDeleteOwnershipPredicate } from './project-delete-snapshot.js';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import type { ArtifactFileStore } from '../../ports/artifact-files.js';
import {
  PROJECT_DELETE_PREVIEW_MAX_ARTIFACT_BODIES,
  PROJECT_DELETE_PREVIEW_MAX_BODY_BYTES,
  PROJECT_DELETE_PREVIEW_MAX_OBJECTS,
  PROJECT_DELETE_PREVIEW_MAX_REFERENCE_ROWS,
  PROJECT_DELETE_PREVIEW_MAX_RETAINED_LISTED,
  PROJECT_DELETE_PREVIEW_MAX_TOTAL_BODY_BYTES,
  PROJECT_DELETE_PREVIEW_MAX_WORKSPACES,
  type ProjectDeleteArtifactBodyFact,
  type ProjectDeleteInventory,
  type ProjectDeleteObjectFact,
  type ProjectDeleteReferenceSummary,
  type ProjectDeleteRepositoryBindingFact,
  type ProjectDeleteRetainedFact,
  type ProjectDeleteWorkspaceFact,
  type ProjectDeleteWorkspaceInspectionInput,
} from '../../ports/project-delete-preview.js';
import type { ProjectStatus } from '../../ports/state-store.js';
import { validateStableId } from '../../ports/validation.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { readProjectArchiveCloseoutInDatabase } from './project-lifecycle.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'ProjectDeleteInventory.read';
const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'archiving', 'archived', 'deleting'];

/**
 * 当前 schema 中带 project_id 归属的全部受管表及其枚举游标列与处置。
 * disposition='retain-minimal' 的表只保留最小回执（F-010 定义最小化），其余
 * 随项目删除；未知新表会被 sqlite_master 巡检发现并置清点不完整。
 */
const KNOWN_PROJECT_TABLES: Readonly<Record<string, { readonly cursorColumn: string; readonly disposition: 'delete' | 'retain-minimal' }>> = Object.freeze({
  approvals: { cursorColumn: 'id', disposition: 'delete' },
  artifacts: { cursorColumn: 'id', disposition: 'delete' },
  attempt_notification_diagnostics: { cursorColumn: 'id', disposition: 'delete' },
  attempt_notifications: { cursorColumn: 'id', disposition: 'delete' },
  attempts: { cursorColumn: 'id', disposition: 'delete' },
  baseline_authorizations: { cursorColumn: 'id', disposition: 'delete' },
  baseline_check_results: { cursorColumn: 'id', disposition: 'delete' },
  baseline_operations: { cursorColumn: 'id', disposition: 'delete' },
  batch_budget_revisions: { cursorColumn: 'id', disposition: 'delete' },
  capability_modules: { cursorColumn: 'id', disposition: 'delete' },
  check_results: { cursorColumn: 'id', disposition: 'delete' },
  command_receipts: { cursorColumn: 'id', disposition: 'retain-minimal' },
  document_versions: { cursorColumn: 'id', disposition: 'delete' },
  documents: { cursorColumn: 'id', disposition: 'delete' },
  execution_batch_members: { cursorColumn: 'id', disposition: 'delete' },
  execution_batches: { cursorColumn: 'id', disposition: 'delete' },
  execution_slot_claims: { cursorColumn: 'id', disposition: 'delete' },
  execution_stop_operations: { cursorColumn: 'id', disposition: 'delete' },
  feature_dependencies: { cursorColumn: 'id', disposition: 'delete' },
  feature_resource_leases: { cursorColumn: 'id', disposition: 'delete' },
  features: { cursorColumn: 'id', disposition: 'delete' },
  git_agent_repair_attempts: { cursorColumn: 'id', disposition: 'delete' },
  git_agent_repair_commands: { cursorColumn: 'command_id', disposition: 'delete' },
  git_agent_repairs: { cursorColumn: 'repair_id', disposition: 'delete' },
  git_integration_commands: { cursorColumn: 'id', disposition: 'delete' },
  git_integration_observations: { cursorColumn: 'id', disposition: 'delete' },
  git_operations: { cursorColumn: 'id', disposition: 'delete' },
  integration_plans: { cursorColumn: 'id', disposition: 'delete' },
  integration_predecessor_snapshots: { cursorColumn: 'id', disposition: 'delete' },
  managed_workspaces: { cursorColumn: 'id', disposition: 'delete' },
  memory_records: { cursorColumn: 'id', disposition: 'delete' },
  phase_delivery_approvals: { cursorColumn: 'id', disposition: 'delete' },
  phase_delivery_candidates: { cursorColumn: 'id', disposition: 'delete' },
  phases: { cursorColumn: 'id', disposition: 'delete' },
  planning_contexts: { cursorColumn: 'id', disposition: 'delete' },
  project_profiles: { cursorColumn: 'id', disposition: 'delete' },
  project_settings: { cursorColumn: 'id', disposition: 'delete' },
  recording_manifests: { cursorColumn: 'id', disposition: 'delete' },
  repository_binding_snapshots: { cursorColumn: 'id', disposition: 'delete' },
  repository_bindings: { cursorColumn: 'id', disposition: 'delete' },
  run_dispatch_claims: { cursorColumn: 'id', disposition: 'delete' },
  run_dispatch_intents: { cursorColumn: 'id', disposition: 'delete' },
  run_outcome_settlements: { cursorColumn: 'id', disposition: 'delete' },
  runs: { cursorColumn: 'id', disposition: 'delete' },
  runtime_start_reservations: { cursorColumn: 'id', disposition: 'delete' },
  session_messages: { cursorColumn: 'id', disposition: 'delete' },
  sessions: { cursorColumn: 'id', disposition: 'delete' },
  state_events: { cursorColumn: 'id', disposition: 'delete' },
  task_approval_items: { cursorColumn: 'id', disposition: 'delete' },
  task_attempt_reservations: { cursorColumn: 'id', disposition: 'delete' },
  task_claim_receipts: { cursorColumn: 'id', disposition: 'delete' },
  task_dependencies: { cursorColumn: 'id', disposition: 'delete' },
  tasks: { cursorColumn: 'id', disposition: 'delete' },
  verification_batches: { cursorColumn: 'id', disposition: 'delete' },
  workspace_leases: { cursorColumn: 'id', disposition: 'delete' },
  workspace_operations: { cursorColumn: 'id', disposition: 'delete' },
});

/** 制品引用列（与 F-004 备份包同一清单 + 标量输出制品列；引用安全同一口径）。json=true 表示 TEXT 列为 JSON 数组（元素 {artifactId}）。
 * artifactShapedOnly=true 表示该列除制品引用外还合法携带 builtin: 等不透明引用
 * （P06 画像能力模块；无制品正文），非制品稳定 ID 形态不参与引用分类，
 * 不凭空制造 unknown_reference 阻塞（F-016，与备份包同口径）。 */
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REFERENCE_COLUMNS: ReadonlyArray<{ readonly table: string; readonly column: string; readonly json?: true; readonly artifactShapedOnly?: true }> = Object.freeze([
  { table: 'attempts', column: 'input_ref' },
  { table: 'attempts', column: 'code_ref' },
  { table: 'attempts', column: 'diagnostic_ref' },
  { table: 'sessions', column: 'input_ref' },
  { table: 'sessions', column: 'result_ref' },
  { table: 'session_messages', column: 'content_ref' },
  { table: 'recording_manifests', column: 'manifest_ref' },
  { table: 'document_versions', column: 'content_ref' },
  { table: 'memory_records', column: 'content_ref' },
  { table: 'capability_modules', column: 'content_ref', artifactShapedOnly: true },
  { table: 'baseline_check_results', column: 'output_artifact_id' },
  { table: 'check_results', column: 'output_artifact_id' },
  { table: 'planning_contexts', column: 'candidate_artifact_id' },
  { table: 'document_versions', column: 'source_refs', json: true },
  { table: 'memory_records', column: 'source_refs', json: true },
  { table: 'session_messages', column: 'source_refs', json: true },
  { table: 'session_messages', column: 'attachment_refs', json: true },
]);

export interface ProjectDeleteInventoryLimits {
  readonly pageSize?: number;
  readonly maxObjects?: number;
  readonly maxArtifactBodies?: number;
  readonly maxTotalBodyBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxWorkspaces?: number;
  readonly maxReferenceRows?: number;
  readonly maxRetainedListed?: number;
}

interface ArtifactRow {
  readonly id: string;
  readonly status: string;
  readonly content_hash: string | null;
  readonly expected_hash: string | null;
  readonly size_bytes: number | null;
}

interface DatabaseInventory {
  readonly databaseDigest: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectStatus: ProjectStatus;
  readonly objects: ProjectDeleteObjectFact[];
  readonly totalObjects: number;
  readonly artifactRows: ArtifactRow[];
  readonly artifactIds: ReadonlySet<string>;
  readonly repositoryBindings: ProjectDeleteRepositoryBindingFact[];
  readonly workspaceRows: Array<Record<string, unknown>>;
  readonly workspaceInspectionInputs: ProjectDeleteWorkspaceInspectionInput[];
  readonly references: ProjectDeleteReferenceSummary;
  readonly retained: ProjectDeleteRetainedFact[];
  readonly activity: ProjectDeleteInventory['activity'];
  readonly reasons: string[];
  readonly complete: boolean;
}

type Row = Record<string, unknown>;

function tableExists(db: Database, name: string): boolean {
  return db.prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function countProjectRows(db: Database, table: string, projectId: string): number {
  const row = db.prepare<[string], { n: unknown }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${projectDeleteOwnershipPredicate(table)}${table === 'command_receipts' ? " AND operation <> 'project.delete.preview'" : ''}`).get(projectId);
  const value = row?.n;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageError('corrupt', OPERATION, `表 ${table} 的项目行计数超出契约形态`, { details: { reason: 'invalid_object_count' } });
  }
  return value;
}

function parseJsonArray(value: unknown, reasons: string[], reasonKey: string): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not_array');
    return parsed;
  } catch {
    reasons.push(`invalid_reference_json:${reasonKey}`);
    return [];
  }
}

/** 只读清点：数据库一致读事实 + 事务外的正文哈希/目录扫描/备份清点。 */
export function createSqliteProjectDeleteInventory(options: {
  readonly session: SqliteStorageSession;
  readonly files: ArtifactFileStore;
  /** 备份包根（数据根内）；只列目录名，不读取包内容。 */
  readonly backupRoot: string;
  readonly limits?: ProjectDeleteInventoryLimits;
}): { readInventory(projectId: string): Promise<ProjectDeleteInventory> } {
  const { session, files, backupRoot } = options;
  const limits = {
    pageSize: options.limits?.pageSize ?? 128,
    maxObjects: options.limits?.maxObjects ?? PROJECT_DELETE_PREVIEW_MAX_OBJECTS,
    maxArtifactBodies: options.limits?.maxArtifactBodies ?? PROJECT_DELETE_PREVIEW_MAX_ARTIFACT_BODIES,
    maxTotalBodyBytes: options.limits?.maxTotalBodyBytes ?? PROJECT_DELETE_PREVIEW_MAX_TOTAL_BODY_BYTES,
    maxBodyBytes: options.limits?.maxBodyBytes ?? PROJECT_DELETE_PREVIEW_MAX_BODY_BYTES,
    maxWorkspaces: options.limits?.maxWorkspaces ?? PROJECT_DELETE_PREVIEW_MAX_WORKSPACES,
    maxReferenceRows: options.limits?.maxReferenceRows ?? PROJECT_DELETE_PREVIEW_MAX_REFERENCE_ROWS,
    maxRetainedListed: options.limits?.maxRetainedListed ?? PROJECT_DELETE_PREVIEW_MAX_RETAINED_LISTED,
  };
  if (![limits.pageSize, limits.maxObjects, limits.maxArtifactBodies, limits.maxTotalBodyBytes,
    limits.maxBodyBytes, limits.maxWorkspaces, limits.maxReferenceRows, limits.maxRetainedListed]
    .every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('ProjectDeleteInventory limits 非法');
  }

  function readDatabaseInventory(projectId: string): DatabaseInventory {
    return transactSqliteConsistentRead(session, OPERATION, db => {
      const reasons: string[] = [];
      const projectRow = db.prepare<[string], Row>('SELECT revision, status FROM projects WHERE id = ?').get(projectId);
      if (projectRow === undefined) {
        throw new StorageError('not_found', OPERATION, `项目 ${projectId} 不存在`, { entity: { type: 'project', id: projectId } });
      }
      const statusValue = String(projectRow.status);
      if (!(PROJECT_STATUSES as readonly string[]).includes(statusValue)) {
        throw new StorageError('corrupt', OPERATION, '项目状态列超出契约枚举', {
          entity: { type: 'project', id: projectId }, details: { reason: 'unknown_status' },
        });
      }
      const projectStatus = statusValue as ProjectStatus;
      const projectRevision = Number(projectRow.revision);
      if (!Number.isSafeInteger(projectRevision) || projectRevision < 1) {
        throw new StorageError('corrupt', OPERATION, '项目 revision 超出契约形态', {
          entity: { type: 'project', id: projectId }, details: { reason: 'invalid_revision' },
        });
      }

      // 未知带 project_id 的表：清点不完整（fail-closed，未知管理数据不可安全删除）。
      const presentTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      for (const { name } of presentTables) {
        if (Object.hasOwn(KNOWN_PROJECT_TABLES, name)) continue;
        const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
        if (columns.some(column => column.name === 'project_id')) {
          reasons.push(`unknown_project_table:${name}`);
        }
      }

      // 对象清点：逐表 keyset 分页；超限记不完整。
      const objects: ProjectDeleteObjectFact[] = [];
      let totalObjects = 0;
      for (const [table, spec] of Object.entries(KNOWN_PROJECT_TABLES)) {
        if (!tableExists(db, table)) continue;
        const count = countProjectRows(db, table, projectId);
        totalObjects += count;
        if (count === 0) continue;
        if (objects.length >= limits.maxObjects) {
          reasons.push(`object_scan_limit:${table}`);
          continue;
        }
        let cursor: string | undefined;
        do {
          const page = db.prepare<[string, string, number], Row>(
            `SELECT ${spec.cursorColumn} AS object_id FROM ${table} WHERE ${projectDeleteOwnershipPredicate(table)} AND ${spec.cursorColumn} > ?${table === 'command_receipts' ? " AND operation <> 'project.delete.preview'" : ''} ORDER BY ${spec.cursorColumn} LIMIT ?`,
          ).all(projectId, cursor ?? '', limits.pageSize) as Row[];
          for (const row of page) {
            const id = row.object_id;
            if (typeof id !== 'string' || id.length === 0) {
              reasons.push(`invalid_object_id:${table}`);
              continue;
            }
            if (objects.length >= limits.maxObjects) {
              reasons.push(`object_scan_limit:${table}`);
              break;
            }
            objects.push({ kind: table, id, disposition: spec.disposition });
          }
          cursor = page.length === limits.pageSize ? String(page.at(-1)!.object_id) : undefined;
        } while (cursor !== undefined && objects.length < limits.maxObjects);
      }

      // 制品行（正文事实在事务外哈希）。
      const artifactRows: ArtifactRow[] = [];
      const artifactIds = new Set<string>();
      let artifactCursor: string | undefined;
      do {
        const page = db.prepare<[string, string, number], Row>(
          'SELECT id, status, content_hash, expected_hash, size_bytes FROM artifacts WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?',
        ).all(projectId, artifactCursor ?? '', limits.pageSize) as Row[];
        for (const row of page) {
          artifactIds.add(String(row.id));
          artifactRows.push({
            id: String(row.id),
            status: String(row.status),
            content_hash: row.content_hash === null ? null : String(row.content_hash),
            expected_hash: row.expected_hash === null ? null : String(row.expected_hash),
            size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
          });
        }
        artifactCursor = page.length === limits.pageSize ? String(page.at(-1)!.id) : undefined;
      } while (artifactCursor !== undefined);
      if (artifactRows.length >= limits.maxArtifactBodies) {
        reasons.push('artifact_scan_limit');
      }

      // 仓库绑定身份（不含路径）与保留事实。
      const repositoryBindings: ProjectDeleteRepositoryBindingFact[] = (db.prepare<[string], Row>(
        'SELECT id, repo_identity, revision, binding_revision FROM repository_bindings WHERE project_id = ? ORDER BY id',
      ).all(projectId) as Row[]).map(row => ({
        bindingId: String(row.id),
        repoIdentity: String(row.repo_identity),
        revision: Number(row.revision),
        bindingRevision: Number(row.binding_revision),
      }));
      const retained: ProjectDeleteRetainedFact[] = [];
      for (const binding of repositoryBindings) {
        retained.push({ kind: 'source-repository', id: binding.bindingId, detail: binding.repoIdentity });
        retained.push({ kind: 'branches', id: binding.bindingId, detail: 'preserved_with_source_repository' });
      }
      const receiptCount = Object.hasOwn(KNOWN_PROJECT_TABLES, 'command_receipts') && tableExists(db, 'command_receipts')
        ? countProjectRows(db, 'command_receipts', projectId) : 0;
      retained.push({ kind: 'minimal-receipt', id: 'command_receipts', detail: String(receiptCount) });

      // 工作区行（现场检查由应用层在事务外执行）。
      const workspaceRows: Array<Record<string, unknown>> = db.prepare<[string], Row>(
        'SELECT * FROM managed_workspaces WHERE project_id = ? ORDER BY id',
      ).all(projectId) as Array<Record<string, unknown>>;
      if (workspaceRows.length > limits.maxWorkspaces) {
        reasons.push(`workspace_scan_limit:${workspaceRows.length}`);
      }

      // 引用清点：本项目未知引用 + 其他项目指向本项目制品的跨项目引用。
      const referenceCounters = { inProject: 0, incomingCrossProject: 0, unknown: 0 };
      const examples: string[] = [];
      const note = (reason: string): void => {
        if (examples.length < 32) examples.push(reason);
      };
      let scannedReferenceRows = 0;
      for (const ref of REFERENCE_COLUMNS) {
        if (!tableExists(db, ref.table)) continue;
        const rows = db.prepare(
          `SELECT project_id, ${ref.column} AS ref FROM ${ref.table} WHERE ${ref.column} IS NOT NULL`,
        ).all() as Row[];
        for (const row of rows) {
          scannedReferenceRows += 1;
          if (scannedReferenceRows > limits.maxReferenceRows) {
            reasons.push('reference_scan_limit');
            break;
          }
          const owner = String(row.project_id);
          const value = row.ref;
          if (typeof value !== 'string') continue;
          if (ref.json === true) {
            // JSON 数组列（source_refs/attachment_refs）：仅对象元素 {artifactId} 是制品引用；
            // 非对象元素不是制品引用（与 F-004 同口径，不凭空制造阻塞）。
            for (const item of parseJsonArray(value, reasons, `${ref.table}.${ref.column}`)) {
              if (item !== null && typeof item === 'object' && typeof (item as Row).artifactId === 'string') {
                classifyReference(owner, (item as Row).artifactId as string, `${ref.table}.${ref.column}`, artifactIds, projectId, referenceCounters, note);
              }
            }
          } else {
            if (ref.artifactShapedOnly === true && !ARTIFACT_ID_PATTERN.test(value)) continue;
            classifyReference(owner, value, `${ref.table}.${ref.column}`, artifactIds, projectId, referenceCounters, note);
          }
        }
        if (scannedReferenceRows > limits.maxReferenceRows) break;
      }

      const activity = readProjectArchiveCloseoutInDatabase(db, projectId).blockers;
      const complete = reasons.length === 0;
      const workspaceInspectionInputs = workspaceRows.map(row => ({
        workspaceId: String(row.id),
        status: String(row.status),
        repositoryBindingId: String(row.repository_binding_id),
        repositoryBindingRevision: Number(row.repository_binding_revision),
        repoIdentity: String(row.repo_identity),
        canonicalPath: String(row.canonical_path),
        gitCommonDir: String(row.git_common_dir),
        branch: String(row.branch),
        baseCommit: String(row.base_commit),
      }));
      return {
        databaseDigest: computeProjectDeleteDatabaseDigest(db, projectId),
        projectId, projectRevision, projectStatus,
        objects: [...objects].sort((left, right) => (left.kind === right.kind ? (left.id < right.id ? -1 : 1) : (left.kind < right.kind ? -1 : 1))),
        totalObjects, artifactRows, artifactIds, repositoryBindings, workspaceRows, workspaceInspectionInputs,
        references: { ...referenceCounters, examples },
        retained, activity, reasons, complete,
      };
    });
  }

  function classifyReference(
    ownerProjectId: string,
    artifactId: string,
    source: string,
    artifactIds: ReadonlySet<string>,
    projectId: string,
    counters: { inProject: number; incomingCrossProject: number; unknown: number },
    note: (reason: string) => void,
  ): void {
    if (ownerProjectId === projectId) {
      if (artifactIds.has(artifactId)) {
        counters.inProject += 1;
      } else {
        counters.unknown += 1;
        note(`unknown:${source}:${artifactId}`);
      }
      return;
    }
    if (artifactIds.has(artifactId)) {
      counters.incomingCrossProject += 1;
      note(`incoming:${source}:${ownerProjectId}:${artifactId}`);
    }
    // 其他项目指向自身制品的引用与本预览无关（项目隔离）。
  }

  /** 事务外：正文只读哈希 + 受管区扫描 + 备份清点。 */
  async function readFileFacts(database: DatabaseInventory): Promise<{
    readonly bodies: ProjectDeleteArtifactBodyFact[];
    readonly extraObjects: ProjectDeleteObjectFact[];
    readonly retainedBackups: ProjectDeleteRetainedFact[];
    readonly reasons: string[];
  }> {
    const reasons: string[] = [];
    const bodies: ProjectDeleteArtifactBodyFact[] = [];
    let totalBytes = 0;
    for (const row of database.artifactRows) {
      if (row.status !== 'ready' || row.content_hash === null || row.size_bytes === null) {
        reasons.push(`artifact_not_ready:${row.id}`);
        continue;
      }
      try {
        const stat = await files.statFinal({ projectId: database.projectId, artifactId: row.id });
        const observedSize = stat.sizeBytes;
        const observedHash = await hashArtifactBody(database.projectId, row.id);
        bodies.push({ artifactId: row.id, sizeBytes: observedSize, sha256: observedHash });
        if (observedHash !== row.content_hash || observedSize !== row.size_bytes) {
          reasons.push(`artifact_body_drift:${row.id}`);
        }
        if (observedSize > limits.maxBodyBytes) {
          reasons.push(`artifact_body_limit:${row.id}`);
        }
        totalBytes += observedSize;
        if (totalBytes > limits.maxTotalBodyBytes) {
          reasons.push('body_budget_exhausted');
          break;
        }
      } catch {
        reasons.push(`artifact_body_unavailable:${row.id}`);
      }
    }

    // 受管区扫描：staging 残留与正式区孤儿目录一并列为待删对象（超限记不完整）。
    const extraObjects: ProjectDeleteObjectFact[] = [];
    try {
      let stagingCursor: string | undefined;
      for (;;) {
        const page = await files.scanStagingArea(database.projectId, { limit: limits.pageSize, ...(stagingCursor === undefined ? {} : { cursor: stagingCursor }) });
        for (const entry of page.entries) {
          if (extraObjects.length >= limits.maxObjects) {
            reasons.push('file_scan_limit');
            break;
          }
          if (entry.kind !== 'file' || entry.sizeBytes === null || entry.sizeBytes > limits.maxBodyBytes) {
            reasons.push('staging_body_unavailable');
            continue;
          }
          const content = await files.openStagingRead({ relativePath: entry.relativePath });
          const hash = createHash('sha256');
          let size = 0;
          try {
            for await (const chunk of content.stream) {
              const bytes = chunk as Buffer;
              size += bytes.length;
              if (size > limits.maxBodyBytes || totalBytes + size > limits.maxTotalBodyBytes) throw new Error('staging_body_limit');
              hash.update(bytes);
            }
          } finally { content.stream.destroy(); }
          totalBytes += size;
          if (size !== entry.sizeBytes || size !== content.sizeBytes) reasons.push('staging_body_changed');
          extraObjects.push({ kind: 'artifact-staging-entry', id: entry.relativePath, disposition: 'delete',
            file: { sizeBytes: size, sha256: hash.digest('hex') } });
        }
        stagingCursor = page.nextCursor ?? undefined;
        if (stagingCursor === undefined || reasons.includes('file_scan_limit')) break;
      }
      let finalCursor: string | undefined;
      for (;;) {
        const page = await files.scanFinalArea(database.projectId, { limit: limits.pageSize, ...(finalCursor === undefined ? {} : { cursor: finalCursor }) });
        for (const entry of page.entries) {
          if (extraObjects.length >= limits.maxObjects) {
            reasons.push('file_scan_limit');
            break;
          }
          if (!database.artifactIds.has(entry.name)) {
            extraObjects.push({ kind: 'artifact-final-orphan', id: entry.relativePath, disposition: 'delete' });
            reasons.push(`artifact_orphan_entry:${entry.name}`);
          }
        }
        finalCursor = page.nextCursor ?? undefined;
        if (finalCursor === undefined || reasons.includes('file_scan_limit')) break;
      }
    } catch {
      reasons.push('artifact_area_scan_unavailable');
    }

    // 备份清点：只列目录名（保留项；不读取内容）。
    const retainedBackups: ProjectDeleteRetainedFact[] = [];
    try {
      const entries = readdirSync(backupRoot, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
        if (!entry.isDirectory()) continue;
        if (retainedBackups.length >= limits.maxRetainedListed) {
          reasons.push('retained_backup_listing_limit');
          break;
        }
        retainedBackups.push({ kind: 'backup', id: entry.name });
      }
    } catch {
      reasons.push('backup_listing_unavailable');
    }
    return { bodies, extraObjects, retainedBackups, reasons };
  }

  async function hashArtifactBody(projectId: string, artifactId: string): Promise<string> {
    const content = await files.openFinalRead({ projectId, artifactId });
    const hash = createHash('sha256');
    // 只读流波式消费（与 F-004 备份包同一处置：流自然结束即释放，不写任何文件）。
    for await (const chunk of content.stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  return Object.freeze({
    async readInventory(rawProjectId: string): Promise<ProjectDeleteInventory> {
      const projectId = validateStableId(rawProjectId, { operation: OPERATION, entity: { type: 'project' } }, 'projectId');
      const database = readDatabaseInventory(projectId);
      const fileFacts = await readFileFacts(database);
      const retained = [...database.retained, ...fileFacts.retainedBackups];
      const objects = [...database.objects, ...fileFacts.extraObjects]
        .sort((left, right) => (left.kind === right.kind ? (left.id < right.id ? -1 : 1) : (left.kind < right.kind ? -1 : 1)));
      const reasons = [...new Set([...database.reasons, ...fileFacts.reasons])];
      const workspaceFacts: ProjectDeleteWorkspaceFact[] = database.workspaceRows.map(row => ({
        workspaceId: String(row.id),
        featureId: String(row.feature_id),
        branch: String(row.branch),
        status: String(row.status),
        revision: Number(row.revision),
        repositoryBindingId: String(row.repository_binding_id),
        repositoryBindingRevision: Number(row.repository_binding_revision),
        baseCommit: String(row.base_commit),
        registeredHeadCommit: row.head_commit === null ? null : String(row.head_commit),
        registeredCodeDigest: row.code_digest === null ? null : String(row.code_digest),
        inspection: { unavailableReason: 'workspace_inspection_pending' },
      }));
      return {
        databaseDigest: database.databaseDigest,
        projectId,
        projectRevision: database.projectRevision,
        projectStatus: database.projectStatus,
        objects,
        totalObjects: database.totalObjects + fileFacts.extraObjects.length,
        artifactBodies: fileFacts.bodies,
        repositoryBindings: database.repositoryBindings,
        workspaces: workspaceFacts,
        workspaceInspectionInputs: database.workspaceInspectionInputs,
        references: database.references,
        retained,
        activity: database.activity,
        complete: reasons.length === 0,
        reasons,
      };
    },
  });
}

export type SqliteProjectDeleteInventory = ReturnType<typeof createSqliteProjectDeleteInventory>;
