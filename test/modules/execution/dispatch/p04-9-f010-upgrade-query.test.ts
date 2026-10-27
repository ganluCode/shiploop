/**
 * P04-9 / F-010：P04-8（v32）旧数据升级后仍可查询派发、Attempt、Git 与通过证据。
 *
 * 路径与 F-001 的真实 v32 逐表复制测试互补：这里先在真实生产组合根上产生
 * 一次「执行 → 验证通过 → 受控 Task 提交」的持久证据，再以 VACUUM INTO 复制
 * 到独立沙箱，移除 v33/v34 结构与迁移记录还原 P04-8 形态，随后按真实迁移
 * 升级并以生产 Core 查询端口读取。不断言旧库字节与生产实现相同，不断言
 * 阶段验收；旧 Run/Attempt/Git/通过证据的身份与内容必须逐项保持。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication, type CoreApplication } from '../../../../packages/core/src/adapters/composition.ts';
import { openFakeCoreApplication } from '../../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../../../../packages/core/src/adapters/process/command-process.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import { DATABASE_FILE_NAME } from '../../../../packages/core/src/ports/path-service.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import {
  BINDING_NOW,
  openBindingFixture,
  type BindingFixture,
} from '../../../helpers/p03-6/input-binding-fixture.ts';
import { seedApprovalWaitingVerification } from '../../../helpers/p03-7/approval-continue-seed.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);

const fixtures: BindingFixture[] = [];
const cores: CoreApplication[] = [];
const sandboxes: Array<ReturnType<typeof createTempSandbox>> = [];

afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.workExecution.close();
    core.close();
  }
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

const row = (fixture: BindingFixture, sql: string, ...params: unknown[]) =>
  fixture.query(sql, ...params) as Record<string, unknown>;
const count = (fixture: BindingFixture, sql: string, ...params: unknown[]) =>
  (row(fixture, sql, ...params) as { n: number }).n;

/** 在真实生产组合根产生一次通过证据（真实验证批次 + 受控 Task 提交）。 */
async function seedPassedEvidence(fixture: BindingFixture): Promise<{ attemptId: string; commit: string }> {
  const core = await openFakeCoreApplication({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: fakeCatalog(),
    nowUtcMs: () => BINDING_NOW,
    busyTimeoutMs: 5_000,
    fake: {
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
      toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
      script: { schemaVersion: 1, steps: [
        { op: 'write_file', path: 'src/f010-upgrade.txt', content: 'upgraded evidence\n' },
        { op: 'tool_command', name: 'probe' },
        { op: 'message', role: 'assistant', text: 'F-010 upgrade seed' },
      ] },
    },
  });
  cores.push(core);
  try {
    expect(await core.workExecution.scan()).toMatchObject({ runs: [{ claimed: true }] });
    await expect.poll(() => core.workExecution.activeAttemptIds(), { timeout: 15_000 }).toEqual([]);
    await seedApprovalWaitingVerification({
      fixture, completion: core.taskVerificationCompletion, taskId: 't-1', approvalItem: false,
    });
    expect(row(fixture, 'SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'passed' });
    const attempt = row(fixture, 'SELECT id FROM attempts WHERE task_id = ?', 't-1') as { id: string };
    const commit = row(fixture,
      "SELECT actual_commit, status FROM git_operations WHERE operation_type = 'task_commit' AND attempt_id = ?",
      attempt.id) as { actual_commit: string; status: string };
    expect(commit).toMatchObject({ status: 'succeeded', actual_commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    return { attemptId: attempt.id, commit: commit.actual_commit };
  } finally {
    await core.workExecution.close();
    core.close();
    cores.splice(cores.indexOf(core), 1);
  }
}

/** 还原 P04-8（v32）形态：移除 P04-9 新增结构与迁移记录，既有数据行不动。 */
function downgradeToP04_8(path: string): void {
  const session = openSqliteStorageSession({ path });
  session.database.pragma('foreign_keys = OFF');
  try {
    session.transactWrite('F-010.downgrade-to-p04-8', () => {
      session.database.exec([
        'DROP TABLE IF EXISTS execution_slot_claims;',
        'DROP TABLE IF EXISTS run_dispatch_claims;',
        'DROP TABLE IF EXISTS run_dispatch_intents;',
        // P05-1/P05-2 v35/v37 的规划上下文和 Feature DAG 也必须移除，才能真实还原 P04-8 v32。
        'DROP TABLE IF EXISTS planning_contexts;',
        'DROP TABLE IF EXISTS feature_dependencies;',
        'DROP TRIGGER IF EXISTS execution_batches_scope_member_anchor_check;',
        'DROP TRIGGER IF EXISTS execution_batches_scope_members_insert;',
        'DROP TRIGGER IF EXISTS execution_batch_members_immutable_update;',
        'DROP TRIGGER IF EXISTS execution_batch_members_immutable_delete;',
        'DROP INDEX IF EXISTS execution_batch_members_batch_feature_unique;',
        'DROP INDEX IF EXISTS execution_batch_members_batch_ordinal_unique;',
        'DROP INDEX IF EXISTS execution_batch_members_project_id_id_unique;',
        'DROP INDEX IF EXISTS execution_batch_members_batch_index;',
        'ALTER TABLE execution_batch_members RENAME TO execution_batch_members_p04_legacy;',
        'CREATE UNIQUE INDEX execution_batch_members_p04_legacy_scope_unique ON execution_batch_members_p04_legacy (project_id, batch_id, feature_id);',
        // v39 已把资源键索引改为普通索引，回退到 v32 要恢复 v38 的唯一索引，供 v39 正常重放。
        'DROP INDEX IF EXISTS workspace_leases_resource_key_index;',
        'CREATE UNIQUE INDEX workspace_leases_resource_key_unique ON workspace_leases (resource_key);',
        'DELETE FROM schema_migrations WHERE version >= 33;',
      ].join('\n'));
    });
    expect(session.database.prepare('SELECT max(version) AS version FROM schema_migrations').get())
      .toEqual({ version: 32 });
  } finally {
    session.database.pragma('foreign_keys = ON');
    session.close();
  }
}

describe('P04-9 F-010 P04-8 旧数据升级后的查询', () => {
  it('[case:p04-8-upgrade-queries] 升级保留 Run/Attempt/Git/通过证据，生产查询端口仍可读取', async () => {
    const fixture = await openBindingFixture({
      deliveryPolicy: {
        commitMode: 'task_and_feature',
        gitIdentity: { name: 'Confirmed Owner', email: 'owner@example.test', confirmed: true },
      },
    });
    fixtures.push(fixture);
    const evidence = await seedPassedEvidence(fixture);
    const before = {
      run: row(fixture, 'SELECT * FROM runs WHERE id = ?', fixture.runId),
      attempt: row(fixture, 'SELECT * FROM attempts WHERE id = ?', evidence.attemptId),
      git: row(fixture, 'SELECT * FROM git_operations WHERE operation_type = ?', 'task_commit'),
      batch: row(fixture, 'SELECT * FROM verification_batches WHERE task_id = ?', 't-1'),
    };

    // 独立沙箱 + 事务一致副本；随后删除原夹具也不影响升级演练。
    const sandbox = createTempSandbox('shiploop-p049-f010-upgrade-');
    sandboxes.push(sandbox);
    const dataRoot = join(sandbox.path, 'data-root');
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    const dbPath = join(dataRoot, DATABASE_FILE_NAME);
    fixture.session.database.prepare('VACUUM INTO ?').run(dbPath);
    fixture.close();
    fixtures.splice(fixtures.indexOf(fixture), 1);

    downgradeToP04_8(dbPath);
    const migrating = openSqliteStorageSession({ path: dbPath });
    let appliedVersions: readonly number[];
    try {
      appliedVersions = (await migrateSqliteStorage(migrating)).appliedVersions;
    } finally {
      migrating.close();
    }
    expect(appliedVersions).toEqual([33, 34, 35, 36, 37, 38, 39]);

    const core = await openCoreApplication({
      dataRoot,
      capabilityCatalog: fakeCatalog(),
      nowUtcMs: () => BINDING_NOW,
      busyTimeoutMs: 5_000,
    });
    cores.push(core);
    const owner = createLocalOwnerPrincipal();

    // 既有事实逐项保持身份与内容。
    const queried = await core.queryService.getRunScheduleStatus(owner, {
      projectId: fixture.projectId, runId: fixture.runId,
    });
    expect(queried.run).toMatchObject({ id: fixture.runId, featureId: fixture.featureId });
    expect(queried.tasks.find(task => task.taskId === 't-1')).toMatchObject({ status: 'passed' });

    const attempts = await core.queryService.listExecutionAttempts(owner, {
      projectId: fixture.projectId, taskId: 't-1',
    });
    expect(attempts.records).toHaveLength(1);
    expect(attempts.records[0]).toMatchObject({
      id: evidence.attemptId, status: 'succeeded', taskId: 't-1', number: 1,
    });

    const gitOperations = await core.queryService.listGitOperations(owner, {
      projectId: fixture.projectId, featureId: fixture.featureId,
    });
    const taskCommit = gitOperations.records.find(record => record.operationType === 'task_commit');
    expect(taskCommit).toMatchObject({
      status: 'succeeded', actualCommit: evidence.commit, attemptId: evidence.attemptId,
    });

    const verification = await core.queryService.getTaskVerification(owner, {
      projectId: fixture.projectId, taskId: 't-1',
    });
    expect(verification.machine).toMatchObject({ status: 'passed', attemptId: evidence.attemptId });
    expect(verification.task.effectivePassed).toBe(true);

    // v33/v34 升级不自动认领或改写旧 Run；队列查询仍解释同一 Run 的事实。
    const queue = await core.queryService.listExecutionDispatchQueue(owner, { projectId: fixture.projectId });
    const record = queue.records.find(item => item.runId === fixture.runId);
    expect(record).toMatchObject({ attemptCount: 1, claim: null });
    expect(before.run).toBeDefined();
    expect(before.attempt).toBeDefined();
    expect(before.git).toBeDefined();
    expect(before.batch).toBeDefined();
    expect(before.git).toMatchObject({ actual_commit: evidence.commit });
    expect(before.batch).toMatchObject({ status: 'passed' });
  }, 180_000);
});
