/**
 * F-004 独立只读存储探针（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 用途：以**另一条真实 better-sqlite3 只读连接**打开同一临时状态库，从事务
 * 外部核对真实业务行、revision 与事件计数——竞争参与者的独立视角，也是
 * 「整组回滚」断言的权威来源。只读连接在驱动层打开（readonly），夹具代码
 * 即使有 bug 也无法改动业务库；绝不以 mock 方法调用代替事务结果。
 *
 * - v1/v2 表计数始终给出；command_receipts 在 F-006 迁移 v3 之前为 null
 *   （显式「表不存在」，不伪装成 0 行空表）；
 * - 通用查询只允许 SELECT/WITH，参数走绑定；探针不暴露驱动写能力；
 * - stateEvents 按持久 sequence 升序返回行列形态（F-003 的 mapStateEvent
 *   可直接消费）；receiptRow 在 v3 前抛错而非返回 undefined 伪造。
 */
import Database from 'better-sqlite3';

export interface StorageTableCounts {
  readonly projects: number;
  readonly repository_bindings: number;
  readonly project_settings: number;
  readonly global_settings: number;
  readonly state_events: number;
  readonly artifacts: number;
  /** null：command_receipts 表尚不存在（迁移 v3 未到）。 */
  readonly command_receipts: number | null;
}

export interface ProjectProbeRow {
  readonly id: string;
  readonly revision: number;
  readonly display_name: string;
  readonly description: string | null;
  readonly labels: string;
  readonly status: string;
  readonly repository_binding_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SettingsProbeRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly revision: number;
  readonly schema_version: number;
  readonly payload: string;
  readonly updated_at: number;
}

export interface StateEventProbeRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_revision: number;
  readonly payload: string;
  readonly occurred_at: number;
}

const COUNTED_TABLES = [
  'projects',
  'repository_bindings',
  'project_settings',
  'global_settings',
  'state_events',
  'artifacts',
] as const;

const READ_STATEMENT_PATTERN = /^\s*(?:--[^\n]*\n\s*)*(SELECT|WITH)\b/i;

export interface StorageProbe {
  /** 探针读取的状态库文件路径（受控临时数据根内）。 */
  readonly path: string;
  /** true：连接以 readonly 模式打开，驱动拒绝任何写语句。 */
  readonly readonly: true;
  counts(): StorageTableCounts;
  tableExists(table: string): boolean;
  /** MAX(sequence)，空库为 0。 */
  maxSequence(): number;
  projectRow(projectId: string): ProjectProbeRow | undefined;
  settingsRow(kind: 'global'): SettingsProbeRow | undefined;
  settingsRow(kind: 'project', projectId: string): SettingsProbeRow | undefined;
  /** 按 sequence 升序读取全部 state_events 行列（真实持久审计）。 */
  stateEvents(): StateEventProbeRow[];
  /** F-006 起可用；v3 之前抛错（不返回伪造行）。按 (principal,command) 唯一索引读取。 */
  receiptRow(principalId: string, commandId: string): Record<string, unknown> | undefined;
  selectOne<T extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): T | undefined;
  selectAll<T extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): T[];
  close(): void;
}

/**
 * 以只读模式打开独立探针连接。文件必须已由产品装配迁移创建；缺失即失败
 * （探针不隐式建库、不迁移，避免把「库不存在」误读成「空库」）。
 */
export function openStorageProbe(dbPath: string): StorageProbe {
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  let closed = false;
  database.pragma('busy_timeout = 2000');

  const assertOpen = (operation: string): void => {
    if (closed) {
      throw new Error(`StorageProbe 已关闭，拒绝继续读取（operation: ${operation}）`);
    }
  };

  const assertReadOnlyStatement = (sql: string): void => {
    if (typeof sql !== 'string' || !READ_STATEMENT_PATTERN.test(sql)) {
      throw new TypeError('StorageProbe 只允许 SELECT/WITH 只读查询');
    }
  };

  const countTable = (table: string): number => {
    const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  };

  return {
    path: dbPath,
    readonly: true,

    counts(): StorageTableCounts {
      assertOpen('counts');
      const result = {} as Record<string, number>;
      for (const table of COUNTED_TABLES) {
        result[table] = countTable(table);
      }
      const receipts = this.tableExists('command_receipts') ? countTable('command_receipts') : null;
      return {
        projects: result.projects!,
        repository_bindings: result.repository_bindings!,
        project_settings: result.project_settings!,
        global_settings: result.global_settings!,
        state_events: result.state_events!,
        artifacts: result.artifacts!,
        command_receipts: receipts,
      };
    },

    tableExists(table: string): boolean {
      assertOpen('tableExists');
      if (!/^[a-z_]+$/.test(table)) {
        throw new TypeError(`StorageProbe.tableExists: 非法表名 ${table}`);
      }
      const row = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { present: number } | undefined;
      return row !== undefined;
    },

    maxSequence(): number {
      assertOpen('maxSequence');
      const row = database.prepare('SELECT MAX(sequence) AS m FROM state_events').get() as {
        m: number | null;
      };
      return row.m ?? 0;
    },

    projectRow(projectId: string): ProjectProbeRow | undefined {
      assertOpen('projectRow');
      return this.selectOne<ProjectProbeRow>(
        'SELECT id, revision, display_name, description, labels, status, ' +
          'repository_binding_id, created_at, updated_at FROM projects WHERE id = ?',
        [projectId],
      );
    },

    settingsRow(kind: 'global' | 'project', projectId?: string): SettingsProbeRow | undefined {
      assertOpen('settingsRow');
      if (kind === 'global') {
        return this.selectOne<SettingsProbeRow>(
          'SELECT id, project_id, revision, schema_version, payload, updated_at ' +
            "FROM global_settings WHERE id = 'global'",
        );
      }
      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new TypeError('StorageProbe.settingsRow: project scope 需要 projectId');
      }
      return this.selectOne<SettingsProbeRow>(
        'SELECT id, project_id, revision, schema_version, payload, updated_at ' +
          'FROM project_settings WHERE project_id = ?',
        [projectId],
      );
    },

    stateEvents(): StateEventProbeRow[] {
      assertOpen('stateEvents');
      return this.selectAll<StateEventProbeRow>(
        'SELECT id, project_id, sequence, event_type, aggregate_type, aggregate_id, ' +
          'aggregate_revision, payload, occurred_at FROM state_events ORDER BY sequence ASC',
      );
    },

    receiptRow(principalId: string, commandId: string): Record<string, unknown> | undefined {
      assertOpen('receiptRow');
      if (!this.tableExists('command_receipts')) {
        throw new Error(
          'StorageProbe.receiptRow: command_receipts 表尚不存在（F-006 迁移 v3 未到）',
        );
      }
      return this.selectOne(
        'SELECT * FROM command_receipts WHERE principal_id = ? AND command_id = ?',
        [principalId, commandId],
      );
    },

    selectOne<T extends object = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): T | undefined {
      assertOpen('selectOne');
      assertReadOnlyStatement(sql);
      return database.prepare(sql).get(...params) as T | undefined;
    },

    selectAll<T extends object = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): T[] {
      assertOpen('selectAll');
      assertReadOnlyStatement(sql);
      return database.prepare(sql).all(...params) as T[];
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },
  };
}
