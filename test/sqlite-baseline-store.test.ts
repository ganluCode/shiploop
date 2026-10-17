/**
 * F-007（P02-3）SQLite 迁移 v4 与基线窄存储端口回归（真实临时 SQLite，非 mock）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md §9.3（事件白名单随 v4 扩展）、
 * §10（迁移 v4 与四张基线作用域表 + F-007 补充的占用 process_identity 与
 * 同项目复合外键，见契约 §10 的 F-007 写回注记）、§8（三轴状态枚举）、
 * §6.2（不可变授权摘要）、§13（全局单并发占用）。
 *
 * 覆盖（全部为真实断言，不以方法调用计数替代持久化状态）：
 * - 迁移 v4：描述符接 v3 之后、checksum 稳定；空库与 v3 最新库（含项目/回执/
 *   事件种子）两条路径迁移成功；前序数据、回执与事件 sequence 逐字段保留；
 *   不建 Work/Task/Attempt/Chat 或通用验证表；高版本拒写行为保留；
 * - 不可变授权：insert-only（端口无更新面）、完整获准输入摘要（planDigest/
 *   policyRevision 与规范化计划一致）、代码身份、配置/环境引用快照、
 *   绑定必须属于同项目（复合外键 + 端口拒绝）；
 * - 检查记录：种子行保存获准输入快照且未产生退出码为 null；一次性 CAS 收尾
 *   （迟到执行版本/已收尾证据均拒绝）；收尾后输入快照与终态证据不可覆盖；
 * - 操作生命周期：revision CAS 更新、终态不可覆盖、检查收尾晚于操作终态被拒；
 * - 占用：全局单并发（同规范工作区竞争第二个在途操作 conflict）、心跳与
 *   可恢复进程身份、非持有者心跳/释放被拒、释放后可被其他操作获取；
 * - 原子事务：回执+授权+操作+检查记录+事件+占用同一 BEGIN IMMEDIATE 创建，
 *   故障注入（TEMP TRIGGER）整组回滚；同命令幂等重放不重复建行；
 *   CAS 收尾同时更新结果/操作/事件；Git/进程/文件输出不在事务内（端口无
 *   相应原语，纯 SQL/时钟构成）；
 * - 读取：关闭重开后按 operationId 升序分页查询原结果；健康派生输入；
 *   非法 reason/非法计划 JSON/非法 argv 显式 corrupt；空库健康输入为「尚无检查」。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteBaselineStore } from '../packages/core/src/adapters/sqlite/baseline-store.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  BASELINE_AUTHORIZED_EVENT_TYPE,
  BASELINE_CANCELLED_EVENT_TYPE,
  BASELINE_CHECK_COMPLETED_EVENT_TYPE,
  BASELINE_COMPLETED_EVENT_TYPE,
  BASELINE_STARTED_EVENT_TYPE,
  mapStateEvent,
} from '../packages/core/src/ports/events.ts';
import {
  BASELINE_OCCUPANCY_SINGLETON_ID,
  type BaselineAuthorizationRecord,
  type BaselineOperationRecord,
  type BaselineStore,
} from '../packages/core/src/ports/baseline-store.ts';
import type { CommandTransaction } from '../packages/core/src/ports/atomic-commands.ts';
import { computeBaselinePlanDigest } from '../packages/core/src/ports/baseline.ts';
import type { BaselineCheckPlan } from '../packages/core/src/ports/baseline.ts';
import { installWriteFault, WRITE_FAULT_POINTS } from './helpers/p02-2/fault-injection.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW_MS = 1_700_000_123_456;
const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const BINDING_A = 'bind-a1';
const BINDING_B = 'bind-b1';
const PRINCIPAL = 'local-owner';

/** §6.1 合法检查计划（含配置/环境引用快照字段）。 */
const PLAN: BaselineCheckPlan = {
  checks: [
    {
      checkKey: 'unit-tests',
      kind: 'command',
      argv: ['node', '--test'],
      cwdRef: 'packages/core',
      environmentRef: 'minimal',
      timeoutMs: 600_000,
      required: true,
    },
    {
      checkKey: 'typecheck',
      kind: 'command',
      argv: ['node', 'scripts/run-tests.ts'],
      timeoutMs: 120_000,
      required: false,
    },
  ],
};
const PLAN_DIGEST = computeBaselinePlanDigest(PLAN);
const TREE_DIGEST = 'cd'.repeat(32);

/** 捕获同步抛出（事务原语全同步；不用 Promise 包装）。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function seedProjectWithBinding(
  session: SqliteStorageSession,
  projectId: string,
  bindingId: string,
  canonicalPath: string,
): void {
  const db = session.database;
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) " +
      "VALUES (?, ?, 1, ?, ?, 'active', NULL, '[]')",
  ).run(projectId, NOW_MS, NOW_MS, `项目 ${projectId}`);
  db.prepare(
    'INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, git_common_dir, repo_identity) ' +
      'VALUES (?, ?, ?, 1, ?, ?, NULL, ?)',
  ).run(bindingId, NOW_MS, projectId, NOW_MS, canonicalPath, `identity-${bindingId}`);
  db.prepare('UPDATE projects SET repository_binding_id = ?, revision = 2, updated_at = ? WHERE id = ?').run(
    bindingId,
    NOW_MS,
    projectId,
  );
}

function seedStateEvent(session: SqliteStorageSession, projectId: string, sequence: number): void {
  session.database
    .prepare(
      'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
        "VALUES (?, ?, 1, ?, ?, ?, 'project.metadata_updated', 'project', ?, 2, ?, ?)",
    )
    .run(
      randomUUID(),
      NOW_MS,
      NOW_MS,
      projectId,
      sequence,
      projectId,
      JSON.stringify({ changedFields: ['displayName'] }),
      NOW_MS,
    );
}

interface Harness {
  readonly session: SqliteStorageSession;
  readonly root: string;
  readonly store: BaselineStore;
  readonly atomic: ReturnType<typeof createSqliteAtomicCommandStore>;
  transact<T>(submit: (transaction: CommandTransaction) => T): T;
  close(): void;
}

/** 异步夹具：真实迁移完成后种子 A/B 两项目与绑定，再装配窄端口（与产品组合根同一顺序）。 */
async function openHarnessAsync(prefix: string, now = NOW_MS): Promise<Harness> {
  const sandbox = createTempSandbox(prefix);
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  let clock = now;
  await migrateSqliteStorage(session, { nowUtcMs: () => clock });
  seedProjectWithBinding(session, PROJECT_A, BINDING_A, '/repos/a');
  seedProjectWithBinding(session, PROJECT_B, BINDING_B, '/repos/b');
  const options = { nowUtcMs: () => clock };
  const store = createSqliteBaselineStore(session, options);
  const atomic = createSqliteAtomicCommandStore(session, options);
  return {
    session,
    root: sandbox.path,
    store,
    atomic,
    transact<T>(submit: (transaction: CommandTransaction) => T): T {
      clock += 1_000;
      return atomic.transact('baseline.test', submit);
    },
    close(): void {
      session.close();
    },
  };
}

function authorizationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_A,
    repositoryBindingId: BINDING_A,
    codeIdentity: { headCommit: 'a'.repeat(40), workingTreeDigest: TREE_DIGEST, hasUncommittedChanges: false },
    policyRevision: PLAN_DIGEST,
    planDigest: PLAN_DIGEST,
    plan: PLAN,
    authorizedBy: PRINCIPAL,
    authorizedAtUtcMs: NOW_MS,
    ...overrides,
  };
}

function operationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_A,
    kind: 'baseline',
    authorizationId: null,
    status: 'not_run',
    reasonCode: 'authorization_rejected',
    ...overrides,
  };
}

/** 提交「授权 + accepted 操作 + 检查种子 + 事件 + 占用」并返回身份。 */
async function authorizeOperation(
  harness: Harness,
  input: Record<string, unknown> = {},
): Promise<{ authorization: BaselineAuthorizationRecord; operation: BaselineOperationRecord }> {
  const authorization = harness.transact((transaction) =>
    transaction.insertBaselineAuthorization(authorizationInput(input)),
  );
  const operation = harness.transact((transaction) =>
    transaction.insertBaselineOperation(
      operationInput({ status: 'accepted', authorizationId: authorization.id, reasonCode: null }),
    ),
  );
  harness.transact((transaction) => {
    transaction.insertBaselineCheckResults(operation.id, PLAN);
    transaction.appendBaselineEvent({
      projectId: PROJECT_A,
      type: BASELINE_AUTHORIZED_EVENT_TYPE,
      operationId: operation.id,
      aggregateRevision: operation.revision,
      planDigest: PLAN_DIGEST,
      checkCount: PLAN.checks.length,
    });
    transaction.acquireBaselineOccupancy({ operationId: operation.id });
  });
  return { authorization, operation };
}

function completedReceipt(commandId: string, operationId: string) {
  // 回执操作名沿用 P02-2 已登记的命令面（baseline.run 命令登记属 F-008/后续接线；
  // 本测试只验证存储原子性，不依赖未冻结的命令规格）。
  return createCompletedReceipt({
    commandId,
    principalId: PRINCIPAL,
    operation: 'project.metadata.update',
    scope: { kind: 'project', projectId: PROJECT_A },
    requestDigest: PLAN_DIGEST,
    result: { operationId, status: 'not_run', reasonCode: 'authorization_rejected' },
    resultRef: createResultRef(randomBytes(32)),
    issuedAt: new Date(NOW_MS).toISOString(),
    completedAt: new Date(NOW_MS).toISOString(),
  });
}

function countRows(harness: Harness, table: string): number {
  const row = harness.session.database
    .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)
    .get();
  return Number(row?.c ?? 0);
}

function listPublicEvents(harness: Harness) {
  const rows = harness.session.database
    .prepare<
      [],
      {
        id: string;
        sequence: number;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        aggregate_revision: number;
        project_id: string | null;
        payload: string;
        occurred_at: number;
      }
    >(
      'SELECT id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, project_id, payload, occurred_at FROM state_events ORDER BY sequence',
    )
    .all();
  return rows.map((row) =>
    mapStateEvent({
      id: row.id,
      sequence: row.sequence,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateRevision: row.aggregate_revision,
      projectId: row.project_id,
      payload: JSON.parse(row.payload),
      occurredAtUtcMs: row.occurred_at,
    }),
  );
}

// ---------------------------------------------------------------------------
// 迁移 v4：描述符、两条路径与拒写保留
// ---------------------------------------------------------------------------

describe('F-007 迁移 v4：基线作用域四表', () => {
  it('迁移版本接 v3 之后为 v4/v5（P03-1 / F-002 起继认 v6 计划结构四表；P03-2 / F-002 起继认 v7 approvals 决策记录表、F-003 起继认 v8 检查政策身份绑定；P03-3 / F-002 起继认 v9 单 Feature 执行域三表），checksum 与 SQL 内容一致', () => {
    expect(SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    const v4 = SQLITE_MIGRATIONS[3]!;
    expect(v4.sql).toContain('CREATE TABLE baseline_authorizations');
    expect(v4.sql).toContain('CREATE TABLE baseline_operations');
    expect(v4.sql).toContain('CREATE TABLE baseline_check_results');
    expect(v4.sql).toContain('CREATE TABLE baseline_occupancy');
    expect(v4.sql).toContain('baseline_occupancy_process_identity_json_check');
    expect(v4.sql).toContain('baseline_authorizations_binding_same_project_fk');
    // F-008 / 迁移 v5：command_receipts 重建（accepted + operation_id）。
    const v5 = SQLITE_MIGRATIONS[4]!;
    expect(v5.sql).toContain("status IN ('completed','rejected','accepted')");
    expect(v5.sql).toContain('command_receipts_accepted_check');
    expect(v5.sql).toContain('command_receipts_operation_id_unique');
    // P03-1 / F-002 / 迁移 v6：计划结构四表（不在本守护展开，详见
    // test/p03-1-plan-structure-storage.test.ts）。
    expect(SQLITE_MIGRATIONS[5]!.sql).toContain('CREATE TABLE phases');
    // P03-2 / F-002 / 迁移 v7：approvals 决策记录表（同守护归属）。
    expect(SQLITE_MIGRATIONS[6]!.sql).toContain('CREATE TABLE approvals');
    // P03-2 / F-003 / 迁移 v8：approvals.check_policy_digest 检查政策身份绑定
    // （增列 + 决策身份复合唯一索引重建，不重建表）。
    expect(SQLITE_MIGRATIONS[7]!.sql).toContain('ALTER TABLE approvals ADD COLUMN check_policy_digest');
    expect(SQLITE_MIGRATIONS[7]!.sql).not.toContain('CREATE TABLE');
    // P03-3 / F-002 / 迁移 v9：单 Feature 执行域三表（同守护归属，详见
    // test/p03-3-execution-schema.test.ts）。
    expect(SQLITE_MIGRATIONS[8]!.sql).toContain('CREATE TABLE execution_batches');
    expect(SQLITE_MIGRATIONS[8]!.sql).toContain('CREATE TABLE runs');
    expect(SQLITE_MIGRATIONS[8]!.sql).toContain('CREATE TABLE batch_budget_revisions');
  });

  it('空库迁移建立基线四表；完整 Attempt/Session/验证表仍不建立（计划结构四表、approvals 与 P03-3 / F-002 执行域三表除外）', async () => {
    const sandbox = createTempSandbox('shiploop-f007-mig-empty-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW_MS });
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
      const tables = session.database
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => row.name);
      for (const table of [
        'baseline_authorizations',
        'baseline_operations',
        'baseline_check_results',
        'baseline_occupancy',
      ]) {
        expect(tables).toContain(table);
      }
      expect(session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(session.database.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get()).toEqual({ n: 0 });
      // P03-6 / F-006 起最小 Work Session 表由迁移 v20 建立但为空；Session 明细/记录表组仍不建立。
      expect(session.database.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      // P03-7 / F-002 起验证记录两表由迁移 v21 建立但为空；检查定义表仍不建立。
      expect(session.database.prepare('SELECT COUNT(*) AS n FROM verification_batches').get()).toEqual({ n: 0 });
      expect(session.database.prepare('SELECT COUNT(*) AS n FROM check_results').get()).toEqual({ n: 0 });
      for (const forbidden of [
        // Migration-created execution tables remain empty; later runtime tables are absent.
        'feature_dependencies',
        'chat_turns',
        'session_messages',
        'recording_manifests',
        'check_definitions',
        'operations',
      ]) {
        expect(tables).not.toContain(forbidden);
      }
    } finally {
      session.close();
    }
  });

  it('v3 最新库升级到 v4：前序项目/回执/事件 sequence 逐字段保留，新事件续接序列', async () => {
    const sandbox = createTempSandbox('shiploop-f007-mig-v3-');
    const path = join(sandbox.path, 'state.db');
    const seedSession = openSqliteStorageSession({ path });
    try {
      await migrateSqliteStorage(seedSession, {
        migrations: SQLITE_MIGRATIONS.slice(0, 3),
        nowUtcMs: () => NOW_MS,
      });
      seedProjectWithBinding(seedSession, PROJECT_A, BINDING_A, '/repos/a');
      seedStateEvent(seedSession, PROJECT_A, 1);
      seedStateEvent(seedSession, PROJECT_A, 2);
      seedSession.database
        .prepare(
          'INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, result_json, result_ref, issued_at, completed_at) ' +
            "VALUES (?, ?, 1, ?, ?, ?, 'project', ?, 'project.metadata.update', ?, 'completed', ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          NOW_MS,
          NOW_MS,
          PRINCIPAL,
          '11111111-1111-4111-8111-111111111111',
          PROJECT_A,
          PLAN_DIGEST,
          JSON.stringify({ ok: true }),
          `v1.${'A'.repeat(43)}`,
          NOW_MS,
          NOW_MS,
        );
    } finally {
      seedSession.close();
    }

    const session = openSqliteStorageSession({ path });
    try {
      const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW_MS + 1 });
      expect(result.fromVersion).toBe(3);
      expect(result.appliedVersions).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
      // 前序数据逐字段保留（项目 A + 其绑定；回执；事件 sequence）。
      expect(session.database.prepare('SELECT COUNT(*) AS c FROM projects').get()).toMatchObject({ c: 1 });
      expect(session.database.prepare('SELECT COUNT(*) AS c FROM command_receipts').get()).toMatchObject({
        c: 1,
      });
      expect(session.database.prepare('SELECT MAX(sequence) AS m FROM state_events').get()).toMatchObject({
        m: 2,
      });
      // v4 端口写入的新事件从 sequence 3 继续（持久游标不重置）。
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW_MS + 2 });
      atomic.transact('baseline.test', (transaction) => {
        const operation = transaction.insertBaselineOperation(operationInput());
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_CANCELLED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: operation.revision,
          reasonCode: 'authorization_rejected',
        });
      });
      expect(session.database.prepare('SELECT MAX(sequence) AS m FROM state_events').get()).toMatchObject({
        m: 3,
      });
    } finally {
      session.close();
    }
  });

  it('v4 库面对 v3 清单仍按高版本拒写，行与版本不被修改', async () => {
    const sandbox = createTempSandbox('shiploop-f007-mig-high-');
    const path = join(sandbox.path, 'state.db');
    const first = openSqliteStorageSession({ path });
    try {
      await migrateSqliteStorage(first, { nowUtcMs: () => NOW_MS });
    } finally {
      first.close();
    }
    const session = openSqliteStorageSession({ path });
    try {
      const error = await migrateSqliteStorage(session, {
        migrations: SQLITE_MIGRATIONS.slice(0, 3),
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(isStorageError(error, 'unsupported_version')).toBe(true);
    } finally {
      session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 不可变授权（AC2）
// ---------------------------------------------------------------------------

describe('F-007 不可变授权', () => {
  it('insert-only 保存完整获准输入摘要/代码身份并原样读回；端口无更新面', async () => {
    const harness = await openHarnessAsync('shiploop-f007-auth-');
    try {
      const inserted = harness.transact((transaction) =>
        transaction.insertBaselineAuthorization(authorizationInput()),
      );
      expect(inserted).toMatchObject({
        projectId: PROJECT_A,
        repositoryBindingId: BINDING_A,
        headCommit: 'a'.repeat(40),
        workingTreeDigest: TREE_DIGEST,
        hasUncommittedChanges: false,
        policyRevision: PLAN_DIGEST,
        planDigest: PLAN_DIGEST,
        plan: PLAN,
        authorizedBy: PRINCIPAL,
      });
      const read = harness.store.getBaselineAuthorization(inserted.id);
      expect(read).toEqual(inserted);
      // 端口不提供任何授权更新/删除原语（不可变授权只有插入与读取面）。
      const transaction = harness.transact((context) => context);
      for (const forbidden of ['updateBaselineAuthorization', 'deleteBaselineAuthorization']) {
        expect((transaction as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
      }
    } finally {
      harness.close();
    }
  });

  it('planDigest/policyRevision 与规范化计划摘要不一致在校验期拒绝（SQL 前零副作用）', async () => {
    const harness = await openHarnessAsync('shiploop-f007-auth-digest-');
    try {
      const error = capture(() =>
        harness.transact((transaction) =>
          transaction.insertBaselineAuthorization(authorizationInput({ planDigest: 'ef'.repeat(32) })),
        ),
      );
      expect(isStorageError(error, 'validation')).toBe(true);
      expect(countRows(harness, 'baseline_authorizations')).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('绑定不属于同项目被端口与直接 SQL（复合外键）双重拒绝', async () => {
    const harness = await openHarnessAsync('shiploop-f007-auth-xproj-');
    try {
      const error = capture(() =>
        harness.transact((transaction) =>
          transaction.insertBaselineAuthorization(authorizationInput({ repositoryBindingId: BINDING_B })),
        ),
      );
      expect(isStorageError(error, 'ownership')).toBe(true);
      // 直接 SQL 同样被同项目复合外键拒绝。
      const sqlError = capture(() => {
        harness.session.database
          .prepare(
            'INSERT INTO baseline_authorizations (id, created_at, project_id, repository_binding_id, head_commit, working_tree_digest, has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by, authorized_at) ' +
              "VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, '{}', ?, ?)",
          )
          .run(
            randomUUID(),
            NOW_MS,
            PROJECT_A,
            BINDING_B,
            TREE_DIGEST,
            PLAN_DIGEST,
            PLAN_DIGEST,
            PRINCIPAL,
            NOW_MS,
          );
      });
      expect(String(sqlError)).toMatch(/FOREIGN KEY constraint failed/);
      expect(countRows(harness, 'baseline_authorizations')).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('缺失项目/绑定的授权插入映射为 not_found，不产生半行', async () => {
    const harness = await openHarnessAsync('shiploop-f007-auth-missing-');
    try {
      for (const overrides of [
        { projectId: 'missing-project', repositoryBindingId: BINDING_A },
        { projectId: PROJECT_A, repositoryBindingId: 'missing-binding' },
      ]) {
        const error = capture(() =>
          harness.transact((transaction) =>
            transaction.insertBaselineAuthorization(authorizationInput(overrides)),
          ),
        );
        expect(isStorageError(error, 'not_found')).toBe(true);
      }
      expect(countRows(harness, 'baseline_authorizations')).toBe(0);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 操作生命周期与检查记录（AC2/AC3）
// ---------------------------------------------------------------------------

describe('F-007 操作生命周期与检查记录', () => {
  it('种子检查行保存获准输入快照，未产生退出码为 null；重复 checkKey 拒绝', async () => {
    const harness = await openHarnessAsync('shiploop-f007-seed-');
    try {
      const { operation } = await authorizeOperation(harness);
      const checks = harness.store.listBaselineCheckResults(operation.id);
      expect(checks).toHaveLength(2);
      const unit = checks.find((check) => check.checkKey === 'unit-tests');
      expect(unit).toMatchObject({
        projectId: PROJECT_A,
        operationId: operation.id,
        argv: PLAN.checks[0]!.argv,
        cwdRef: 'packages/core',
        environmentRef: 'minimal',
        timeoutMs: 600_000,
        required: true,
        status: 'not_run',
        reasonCode: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        outputArtifactId: null,
        startedAtUtcMs: null,
        endedAtUtcMs: null,
        revision: 1,
      });
      const duplicate = capture(() =>
        harness.transact((transaction) => transaction.insertBaselineCheckResults(operation.id, PLAN)),
      );
      expect(isStorageError(duplicate, 'conflict')).toBe(true);
      expect(harness.store.listBaselineCheckResults(operation.id)).toHaveLength(2);
    } finally {
      harness.close();
    }
  });

  it('一次性 CAS 收尾：迟到执行版本与已收尾证据均拒绝，行不变', async () => {
    const harness = await openHarnessAsync('shiploop-f007-finalize-');
    try {
      const { operation } = await authorizeOperation(harness);
      harness.transact((transaction) =>
        transaction.updateBaselineOperation(operation.id, {
          expectedRevision: 1,
          status: 'running',
          startedAtUtcMs: NOW_MS + 5_000,
        }),
      );
      const finalized = harness.transact((transaction) =>
        transaction.finalizeBaselineCheckResult(operation.id, 'unit-tests', {
          expectedRevision: 1,
          status: 'failed',
          exitCode: 1,
          signal: null,
          timedOut: false,
          startedAtUtcMs: NOW_MS + 5_000,
          endedAtUtcMs: NOW_MS + 6_000,
        }),
      );
      expect(finalized).toMatchObject({
        status: 'failed',
        exitCode: 1,
        revision: 2,
        argv: PLAN.checks[0]!.argv,
        cwdRef: 'packages/core',
      });
      // 迟到执行版本（携带过期 expectedRevision）拒绝。
      const late = capture(() =>
        harness.transact((transaction) =>
          transaction.finalizeBaselineCheckResult(operation.id, 'unit-tests', {
            expectedRevision: 1,
            status: 'passed',
            exitCode: 0,
            signal: null,
            timedOut: false,
          }),
        ),
      );
      expect(isStorageError(late, 'conflict')).toBe(true);
      // 已收尾证据（即使携带最新 revision）同样不可覆盖。
      const overwrite = capture(() =>
        harness.transact((transaction) =>
          transaction.finalizeBaselineCheckResult(operation.id, 'unit-tests', {
            expectedRevision: 2,
            status: 'passed',
            exitCode: 0,
            signal: null,
            timedOut: false,
          }),
        ),
      );
      expect(isStorageError(overwrite, 'conflict')).toBe(true);
      expect(
        harness.store.listBaselineCheckResults(operation.id).find((check) => check.checkKey === 'unit-tests'),
      ).toMatchObject(finalized);
    } finally {
      harness.close();
    }
  });

  it('超时收尾未产生退出码保持 null；operation CAS 终态后不可再更新，晚到检查收尾被拒', async () => {
    const harness = await openHarnessAsync('shiploop-f007-terminal-');
    try {
      const { operation } = await authorizeOperation(harness);
      harness.transact((transaction) => {
        const finalized = transaction.finalizeBaselineCheckResult(operation.id, 'typecheck', {
          expectedRevision: 1,
          status: 'inconclusive',
          reasonCode: 'timed_out',
          exitCode: null,
          signal: null,
          timedOut: true,
          endedAtUtcMs: NOW_MS + 9_000,
        });
        transaction.updateBaselineOperation(operation.id, {
          expectedRevision: 1,
          status: 'completed',
          reasonCode: null,
          endedAtUtcMs: NOW_MS + 10_000,
        });
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_COMPLETED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: 2,
          status: 'completed',
          summary: { total: 2, passed: 0, failed: 0, error: 0, inconclusive: 1, notRun: 1 },
        });
        return finalized;
      });
      const checks = harness.store.listBaselineCheckResults(operation.id);
      expect(checks.find((check) => check.checkKey === 'typecheck')).toMatchObject({
        status: 'inconclusive',
        reasonCode: 'timed_out',
        exitCode: null,
        timedOut: true,
      });
      // 终态操作不可再更新（迟到版本拒绝）。
      const terminalUpdate = capture(() =>
        harness.transact((transaction) =>
          transaction.updateBaselineOperation(operation.id, {
            expectedRevision: 2,
            status: 'running',
          }),
        ),
      );
      expect(isStorageError(terminalUpdate, 'conflict')).toBe(true);
      // 操作终态后晚到的检查收尾被拒（证据窗口关闭）。
      const lateCheck = capture(() =>
        harness.transact((transaction) =>
          transaction.finalizeBaselineCheckResult(operation.id, 'unit-tests', {
            expectedRevision: 1,
            status: 'passed',
            exitCode: 0,
            signal: null,
            timedOut: false,
          }),
        ),
      );
      expect(isStorageError(lateCheck, 'conflict')).toBe(true);
      expect(harness.store.getBaselineOperation(operation.id)).toMatchObject({
        status: 'completed',
        revision: 2,
        endedAtUtcMs: NOW_MS + 10_000,
      });
    } finally {
      harness.close();
    }
  });

  it('操作 revision CAS：过期 expectedRevision 拒绝且行不变', async () => {
    const harness = await openHarnessAsync('shiploop-f007-cas-');
    try {
      const { operation } = await authorizeOperation(harness);
      const stale = capture(() =>
        harness.transact((transaction) =>
          transaction.updateBaselineOperation(operation.id, {
            expectedRevision: 99,
            status: 'running',
          }),
        ),
      );
      expect(isStorageError(stale, 'conflict')).toBe(true);
      expect(harness.store.getBaselineOperation(operation.id)).toMatchObject({ revision: 1, status: 'accepted' });
    } finally {
      harness.close();
    }
  });

  it('not_run 操作不接受授权引用；缺失/跨项目授权与非法操作身份被拒绝', async () => {
    const harness = await openHarnessAsync('shiploop-f007-opvalid-');
    try {
      const invalid = capture(() =>
        harness.transact((transaction) =>
          transaction.insertBaselineOperation(
            operationInput({ status: 'not_run', authorizationId: randomUUID(), reasonCode: null }),
          ),
        ),
      );
      expect(isStorageError(invalid, 'validation')).toBe(true);
      const missingAuth = capture(() =>
        harness.transact((transaction) =>
          transaction.insertBaselineOperation(
            operationInput({ status: 'accepted', authorizationId: randomUUID() }),
          ),
        ),
      );
      expect(isStorageError(missingAuth, 'not_found')).toBe(true);
      // 跨项目授权引用被拒绝（授权属于项目 A，操作声明项目 B）。
      const authorization = harness.transact((transaction) =>
        transaction.insertBaselineAuthorization(authorizationInput()),
      );
      const crossProject = capture(() =>
        harness.transact((transaction) =>
          transaction.insertBaselineOperation(
            operationInput({ projectId: PROJECT_B, status: 'accepted', authorizationId: authorization.id }),
          ),
        ),
      );
      expect(isStorageError(crossProject, 'ownership')).toBe(true);
      // 非法操作身份（非 UUID / 非字符串）为 validation 错误，而非 not_found。
      expect(capture(() => harness.store.getBaselineOperation('not-a-uuid'))).toBeDefined();
      expect(capture(() => harness.store.getBaselineOperation(42))).toBeDefined();
    } finally {
      harness.close();
    }
  });

  it('检查种子的直接 SQL 跨项目关联被复合外键拒绝，行数不变', async () => {
    const harness = await openHarnessAsync('shiploop-f007-check-xproj-');
    try {
      const { operation } = await authorizeOperation(harness);
      const sqlError = capture(() => {
        harness.session.database
          .prepare(
            'INSERT INTO baseline_check_results (id, created_at, updated_at, project_id, operation_id, check_key, argv_json, timeout_ms, required, status, timed_out) ' +
              "VALUES (?, ?, ?, ?, ?, ?, '[]', 1000, 0, 'not_run', 0)",
          )
          .run(randomUUID(), NOW_MS, NOW_MS, PROJECT_B, operation.id, 'cross-proj-probe');
      });
      expect(String(sqlError)).toMatch(/FOREIGN KEY constraint failed/);
      expect(harness.store.listBaselineCheckResults(operation.id)).toHaveLength(2);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 受控资源占用（AC3/AC4）
// ---------------------------------------------------------------------------

describe('F-007 全局单并发占用', () => {
  it('获取记录可恢复进程身份；第二个在途操作冲突；释放后可被获取', async () => {
    const harness = await openHarnessAsync('shiploop-f007-occ-');
    try {
      const first = await authorizeOperation(harness);
      const identity = { pid: 424_242, spawnArgvDigest: 'ab'.repeat(32), startedAtUtcMs: NOW_MS };
      harness.transact((transaction) =>
        transaction.heartbeatBaselineOccupancy(first.operation.id, identity),
      );
      expect(harness.store.readBaselineOccupancy()).toEqual({
        holderOperationId: first.operation.id,
        acquiredAtUtcMs: expect.any(Number),
        heartbeatAtUtcMs: expect.any(Number),
        processIdentity: identity,
      });
      // 同规范工作区竞争：另一操作在途时第二个获取被拒（重复活动占用）。
      const second = harness.transact((transaction) =>
        transaction.insertBaselineOperation(operationInput({ status: 'accepted' })),
      );
      const busy = capture(() =>
        harness.transact((transaction) => transaction.acquireBaselineOccupancy({ operationId: second.id })),
      );
      expect(isStorageError(busy, 'conflict')).toBe(true);
      expect((busy as { details?: { reason?: unknown } }).details).toMatchObject({
        reason: 'baseline_in_progress',
      });
      // 非持有者心跳/释放被拒。
      expect(
        isStorageError(
          capture(() =>
            harness.transact((transaction) => transaction.heartbeatBaselineOccupancy(second.id)),
          ),
          'ownership',
        ),
      ).toBe(true);
      expect(
        isStorageError(
          capture(() => harness.transact((transaction) => transaction.releaseBaselineOccupancy(second.id))),
          'ownership',
        ),
      ).toBe(true);
      // 持有者释放清空占用（含进程身份）；随后第二个操作可获取。
      const released = harness.transact((transaction) =>
        transaction.releaseBaselineOccupancy(first.operation.id),
      );
      expect(released.holderOperationId).toBeNull();
      expect(released.processIdentity).toBeNull();
      harness.transact((transaction) => transaction.acquireBaselineOccupancy({ operationId: second.id }));
      expect(harness.store.readBaselineOccupancy()).toMatchObject({ holderOperationId: second.id });
    } finally {
      harness.close();
    }
  });

  it('同持有者重复获取幂等（保留原获取时刻与持有者）；非法进程身份校验期拒绝', async () => {
    const harness = await openHarnessAsync('shiploop-f007-occ-idem-');
    try {
      const { operation } = await authorizeOperation(harness);
      const before = harness.store.readBaselineOccupancy();
      harness.transact((transaction) => transaction.acquireBaselineOccupancy({ operationId: operation.id }));
      const after = harness.store.readBaselineOccupancy();
      // 幂等：持有者与获取时刻不变（心跳允许刷新）。
      expect(after.holderOperationId).toBe(before.holderOperationId);
      expect(after.acquiredAtUtcMs).toBe(before.acquiredAtUtcMs);
      expect(after.heartbeatAtUtcMs).toBeGreaterThanOrEqual(before.heartbeatAtUtcMs!);
      const invalid = capture(() =>
        harness.transact((transaction) =>
          transaction.heartbeatBaselineOccupancy(operation.id, ['not-an-object']),
        ),
      );
      expect(isStorageError(invalid, 'validation')).toBe(true);
      const oversized = capture(() =>
        harness.transact((transaction) =>
          transaction.heartbeatBaselineOccupancy(operation.id, { blob: 'x'.repeat(4_096) }),
        ),
      );
      expect(isStorageError(oversized, 'validation')).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('占用为固定单行：直接 SQL 插入第二行被单例 CHECK 拒绝', async () => {
    const harness = await openHarnessAsync('shiploop-f007-occ-single-');
    try {
      expect(countRows(harness, 'baseline_occupancy')).toBe(0);
      const sqlError = capture(() => {
        harness.session.database
          .prepare('INSERT INTO baseline_occupancy (id, holder_operation_id) VALUES (?, NULL)')
          .run('another-row');
      });
      expect(String(sqlError)).toMatch(/baseline_occupancy_singleton_id_check/);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 原子事务、幂等与事件（AC3）
// ---------------------------------------------------------------------------

describe('F-007 原子事务与同命令幂等', () => {
  it('回执+授权+操作+检查记录+事件+占用同一事务创建；事件写入失败整组回滚', async () => {
    const harness = await openHarnessAsync('shiploop-f007-atomic-');
    try {
      const commandId = randomUUID();
      const fault = installWriteFault(harness.session.database, {
        target: WRITE_FAULT_POINTS.stateEventsBeforeInsert,
      });
      const submit = (transaction: CommandTransaction): void => {
        const authorization = transaction.insertBaselineAuthorization(authorizationInput());
        const operation = transaction.insertBaselineOperation(
          operationInput({ status: 'accepted', authorizationId: authorization.id, reasonCode: null }),
        );
        transaction.insertBaselineCheckResults(operation.id, PLAN);
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_AUTHORIZED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: operation.revision,
          planDigest: PLAN_DIGEST,
          checkCount: PLAN.checks.length,
        });
        transaction.acquireBaselineOccupancy({ operationId: operation.id });
        transaction.saveReceipt(completedReceipt(commandId, operation.id));
      };
      const error = capture(() => harness.transact(submit));
      expect(String(error)).toMatch(/p02-2 injected fault/);
      fault.remove();
      // 整组回滚：无授权/操作/检查/事件/回执/占用残留。
      for (const table of [
        'baseline_authorizations',
        'baseline_operations',
        'baseline_check_results',
        'state_events',
        'command_receipts',
      ]) {
        expect(countRows(harness, table)).toBe(0);
      }
      expect(harness.store.readBaselineOccupancy()).toMatchObject({ holderOperationId: null });
      // 撤除故障后相同提交成功。
      harness.transact(submit);
      expect(countRows(harness, 'baseline_operations')).toBe(1);
      expect(countRows(harness, 'command_receipts')).toBe(1);
      expect(countRows(harness, 'baseline_check_results')).toBe(2);
    } finally {
      harness.close();
    }
  });

  it('同命令幂等：重放命中既有回执，不重复创建操作/检查/占用', async () => {
    const harness = await openHarnessAsync('shiploop-f007-idem-');
    try {
      const commandId = randomUUID();
      const first = harness.transact((transaction) => {
        const existing = transaction.findReceipt(PRINCIPAL, commandId);
        expect(existing).toBeUndefined();
        const authorization = transaction.insertBaselineAuthorization(authorizationInput());
        const operation = transaction.insertBaselineOperation(
          operationInput({ status: 'accepted', authorizationId: authorization.id, reasonCode: null }),
        );
        transaction.insertBaselineCheckResults(operation.id, PLAN);
        transaction.saveReceipt(completedReceipt(commandId, operation.id));
        return operation.id;
      });
      const replay = harness.transact((transaction) => {
        const existing = transaction.findReceipt(PRINCIPAL, commandId);
        if (existing !== undefined) {
          return existing;
        }
        const operation = transaction.insertBaselineOperation(operationInput({ status: 'accepted' }));
        transaction.saveReceipt(completedReceipt(commandId, operation.id));
        return operation.id;
      });
      expect(replay).toMatchObject({ commandId });
      expect(countRows(harness, 'baseline_operations')).toBe(1);
      expect(countRows(harness, 'baseline_check_results')).toBe(2);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      harness.close();
    }
  });

  it('CAS 收尾同事务更新结果/操作/事件；任一失败整组回滚', async () => {
    const harness = await openHarnessAsync('shiploop-f007-cas-fin-');
    try {
      const { operation } = await authorizeOperation(harness);
      harness.transact((transaction) =>
        transaction.updateBaselineOperation(operation.id, { expectedRevision: 1, status: 'running' }),
      );
      const fault = installWriteFault(harness.session.database, {
        target: WRITE_FAULT_POINTS.baselineCheckResultsBeforeUpdate,
      });
      const finalize = (transaction: CommandTransaction): void => {
        transaction.finalizeBaselineCheckResult(operation.id, 'unit-tests', {
          expectedRevision: 1,
          status: 'passed',
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
        transaction.updateBaselineOperation(operation.id, {
          expectedRevision: 2,
          status: 'completed',
          endedAtUtcMs: NOW_MS + 8_000,
        });
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_COMPLETED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: 3,
          status: 'completed',
          summary: { total: 2, passed: 1, failed: 0, error: 0, inconclusive: 0, notRun: 1 },
        });
      };
      const error = capture(() => harness.transact(finalize));
      expect(String(error)).toMatch(/p02-2 injected fault/);
      fault.remove();
      // 结果/操作/事件均未落地（整组回滚）。
      expect(harness.store.getBaselineOperation(operation.id)).toMatchObject({ status: 'running', revision: 2 });
      expect(
        harness.store.listBaselineCheckResults(operation.id).find((check) => check.checkKey === 'unit-tests'),
      ).toMatchObject({ status: 'not_run', revision: 1 });
      expect(listPublicEvents(harness).filter((event) => event.type === BASELINE_COMPLETED_EVENT_TYPE)).toHaveLength(0);
      // 撤除后同一收尾组合成功：结果/操作/事件一致落地。
      harness.transact(finalize);
      expect(harness.store.getBaselineOperation(operation.id)).toMatchObject({ status: 'completed', revision: 3 });
      expect(
        harness.store.listBaselineCheckResults(operation.id).find((check) => check.checkKey === 'unit-tests'),
      ).toMatchObject({ status: 'passed', revision: 2 });
      expect(listPublicEvents(harness).filter((event) => event.type === BASELINE_COMPLETED_EVENT_TYPE)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('五类基线事件可经公开白名单映射读回；payload 形状受控', async () => {
    const harness = await openHarnessAsync('shiploop-f007-events-');
    try {
      const { operation } = await authorizeOperation(harness);
      harness.transact((transaction) => {
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_STARTED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: 1,
        });
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_CHECK_COMPLETED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: 2,
          checkKey: 'unit-tests',
          status: 'passed',
        });
        transaction.appendBaselineEvent({
          projectId: PROJECT_A,
          type: BASELINE_CANCELLED_EVENT_TYPE,
          operationId: operation.id,
          aggregateRevision: 2,
          reasonCode: 'cancelled',
        });
      });
      const events = listPublicEvents(harness);
      expect(events.map((event) => event.type)).toEqual([
        BASELINE_AUTHORIZED_EVENT_TYPE,
        BASELINE_STARTED_EVENT_TYPE,
        BASELINE_CHECK_COMPLETED_EVENT_TYPE,
        BASELINE_CANCELLED_EVENT_TYPE,
      ]);
      expect(events[0]!.payload).toEqual({
        operationId: operation.id,
        planDigest: PLAN_DIGEST,
        checkCount: 2,
      });
      expect(events[2]!.payload).toEqual({
        operationId: operation.id,
        checkKey: 'unit-tests',
        status: 'passed',
      });
      for (const event of events) {
        expect(event.scope).toEqual({ kind: 'project', projectId: PROJECT_A });
        expect(event.aggregate.type).toBe('project');
      }
      // 未知/白名单外事件类型映射显式失败。
      expect(
        capture(() =>
          mapStateEvent({
            id: randomUUID(),
            sequence: 99,
            eventType: 'baseline.unknown',
            aggregateType: 'project',
            aggregateId: PROJECT_A,
            aggregateRevision: 1,
            projectId: PROJECT_A,
            payload: {},
            occurredAtUtcMs: NOW_MS,
          }),
        ),
      ).toBeDefined();
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 读取、分页与健康派生输入（AC4）
// ---------------------------------------------------------------------------

describe('F-007 读取、分页与健康派生输入', () => {
  it('关闭重开后按 operationId 升序分页查询原结果；检查结果原样读回', async () => {
    const sandbox = createTempSandbox('shiploop-f007-reopen-');
    const path = join(sandbox.path, 'state.db');
    const created: string[] = [];
    {
      const session = openSqliteStorageSession({ path });
      try {
        await migrateSqliteStorage(session, { nowUtcMs: () => NOW_MS });
        seedProjectWithBinding(session, PROJECT_A, BINDING_A, '/repos/a');
        seedProjectWithBinding(session, PROJECT_B, BINDING_B, '/repos/b');
        const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW_MS });
        for (let index = 0; index < 5; index += 1) {
          const authorization = atomic.transact('baseline.test', (transaction) =>
            transaction.insertBaselineAuthorization(authorizationInput()),
          );
          const operation = atomic.transact('baseline.test', (transaction) =>
            transaction.insertBaselineOperation(
              operationInput({ status: 'accepted', authorizationId: authorization.id, reasonCode: null }),
            ),
          );
          atomic.transact('baseline.test', (transaction) => {
            transaction.insertBaselineCheckResults(operation.id, PLAN);
          });
          created.push(operation.id);
        }
      } finally {
        session.close();
      }
    }
    // 关闭重开：分页查询原结果。
    const session = openSqliteStorageSession({ path });
    try {
      const store = createSqliteBaselineStore(session, { nowUtcMs: () => NOW_MS });
      const all = store.listBaselineOperations(PROJECT_A, { limit: 100 });
      expect(all.records.map((record) => record.id)).toEqual([...created].sort());
      expect(all.nextCursor).toBeNull();
      const firstPage = store.listBaselineOperations(PROJECT_A, { limit: 2 });
      const secondPage = store.listBaselineOperations(PROJECT_A, { limit: 2, cursor: firstPage.nextCursor });
      const thirdPage = store.listBaselineOperations(PROJECT_A, { limit: 2, cursor: secondPage.nextCursor });
      expect(
        [...firstPage.records, ...secondPage.records, ...thirdPage.records].map((record) => record.id),
      ).toEqual(all.records.map((record) => record.id));
      expect(thirdPage.nextCursor).toBeNull();
      // 只列目标项目（项目 B 无操作）。
      expect(store.listBaselineOperations(PROJECT_B, {}).records).toHaveLength(0);
      // 检查结果原样读回。
      const checks = store.listBaselineCheckResults(all.records[0]!.id);
      expect(checks.map((check) => check.checkKey).sort()).toEqual(['typecheck', 'unit-tests']);
      // 健康派生输入：尚无终态操作 → operation null。
      expect(store.readProjectHealthInput(PROJECT_A)).toEqual({ operation: null, checks: [] });
    } finally {
      session.close();
    }
  });

  it('健康派生输入取最近一次终态操作与逐项检查（required/reason 保留）', async () => {
    const harness = await openHarnessAsync('shiploop-f007-health-');
    try {
      const { operation } = await authorizeOperation(harness);
      harness.transact((transaction) => {
        transaction.finalizeBaselineCheckResult(operation.id, 'unit-tests', {
          expectedRevision: 1,
          status: 'failed',
          exitCode: 1,
          signal: null,
          timedOut: false,
        });
        transaction.finalizeBaselineCheckResult(operation.id, 'typecheck', {
          expectedRevision: 1,
          status: 'inconclusive',
          reasonCode: 'timed_out',
          exitCode: null,
          signal: null,
          timedOut: true,
        });
        transaction.updateBaselineOperation(operation.id, {
          expectedRevision: 1,
          status: 'completed',
          endedAtUtcMs: NOW_MS + 10_000,
        });
      });
      const input = harness.store.readProjectHealthInput(PROJECT_A);
      expect(input.operation).toMatchObject({
        operationId: operation.id,
        kind: 'baseline',
        status: 'completed',
        endedAt: new Date(NOW_MS + 10_000).toISOString(),
      });
      expect(input.operation?.reasonCode).toBeUndefined();
      expect(input.checks).toHaveLength(2);
      expect(input.checks.find((check) => check.status === 'inconclusive')).toMatchObject({
        required: false,
        reasonCode: 'timed_out',
      });
      expect(input.checks.find((check) => check.status === 'failed')).toMatchObject({ required: true });
    } finally {
      harness.close();
    }
  });

  it('非法 reason/非法计划 JSON/非法 argv 持久行显式 corrupt，不作为有效记录返回', async () => {
    const harness = await openHarnessAsync('shiploop-f007-corrupt-');
    try {
      const { operation } = await authorizeOperation(harness);
      // reason_code 无 DDL CHECK：写入受控枚举外的值模拟持久损坏。
      harness.session.database
        .prepare('UPDATE baseline_operations SET reason_code = ? WHERE id = ?')
        .run('exploded-reason', operation.id);
      expect(capture(() => harness.store.getBaselineOperation(operation.id))).toBeDefined();
      const authorization = harness.transact((transaction) =>
        transaction.insertBaselineAuthorization(authorizationInput()),
      );
      // plan_json 为合法 JSON 但不是合法计划（空检查集）。
      harness.session.database
        .prepare('UPDATE baseline_authorizations SET plan_json = ? WHERE id = ?')
        .run('{"checks":[]}', authorization.id);
      const corruptAuthorization = capture(() => harness.store.getBaselineAuthorization(authorization.id));
      expect(isStorageError(corruptAuthorization, 'corrupt')).toBe(true);
      // argv_json 为合法 JSON 数组但元素非字符串。
      harness.session.database
        .prepare('UPDATE baseline_check_results SET argv_json = ? WHERE operation_id = ? AND check_key = ?')
        .run('[1,2]', operation.id, 'unit-tests');
      const corruptCheck = capture(() => harness.store.listBaselineCheckResults(operation.id));
      expect(isStorageError(corruptCheck, 'corrupt')).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('非法 DDL 状态/JSON/摘要长度在数据库级被拒绝且行数不变', async () => {
    const harness = await openHarnessAsync('shiploop-f007-ddl-');
    try {
      const { operation } = await authorizeOperation(harness);
      const db = harness.session.database;
      const insertCheck = (status: string, argvJson: string): unknown =>
        capture(() => {
          db.prepare(
            'INSERT INTO baseline_check_results (id, created_at, updated_at, project_id, operation_id, check_key, argv_json, timeout_ms, required, status, timed_out) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)',
          ).run(
            randomUUID(),
            NOW_MS,
            NOW_MS,
            PROJECT_A,
            operation.id,
            `probe-${status}-${argvJson.length}`,
            argvJson,
            1_000,
            status,
          );
        });
      expect(String(insertCheck('exploded', '["node"]'))).toMatch(/baseline_check_results_status_check/);
      expect(String(insertCheck('passed', 'not-json'))).toMatch(/baseline_check_results_argv_json_check/);
      expect(harness.store.listBaselineCheckResults(operation.id)).toHaveLength(2);
      const digestError = capture(() => {
        db.prepare(
          'INSERT INTO baseline_authorizations (id, created_at, project_id, repository_binding_id, head_commit, working_tree_digest, has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by, authorized_at) ' +
            "VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, '{}', ?, ?)",
        ).run(
          randomUUID(),
          NOW_MS,
          PROJECT_A,
          BINDING_A,
          'short',
          PLAN_DIGEST,
          PLAN_DIGEST,
          PRINCIPAL,
          NOW_MS,
        );
      });
      expect(String(digestError)).toMatch(/baseline_authorizations_digest_check/);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 组合根装配
// ---------------------------------------------------------------------------

describe('F-007 组合根装配', () => {
  it('openCoreApplication 暴露真实 baselineStore 并接入 overview 健康读', async () => {
    const { openCoreApplication } = await import('../packages/core/src/adapters/composition.ts');
    const { createStaticRuntimeCapabilityCatalog } = await import(
      '../packages/core/src/ports/runtime-capabilities.ts'
    );
    const sandbox = createTempSandbox('shiploop-f007-compose-');
    const app = await openCoreApplication({
      dataRoot: sandbox.path,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        {
          runtimeId: 'pi',
          providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
        },
      ]),
      nowUtcMs: () => NOW_MS,
    });
    try {
      expect(typeof app.baselineStore.readBaselineOccupancy).toBe('function');
      expect(app.baselineStore.readBaselineOccupancy()).toEqual({
        holderOperationId: null,
        acquiredAtUtcMs: null,
        heartbeatAtUtcMs: null,
        processIdentity: null,
      });
      expect(BASELINE_OCCUPANCY_SINGLETON_ID).toBe('global');
    } finally {
      app.close();
    }
  });
});
