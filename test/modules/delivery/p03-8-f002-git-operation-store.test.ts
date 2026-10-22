import { currentSchemaVersion } from '../../helpers/current-schema.ts';
/**
 * P03-8 / F-002 受控 Git 提交意图与操作回执（真实 SQLite，非 mock）。
 *
 * 覆盖验收标准：
 * - 迁移 v26 从 v25 追加：空库、P02 v5 前序库与 v25 前序库均可升级，历史
 *   checksum 不变；features 追加 delivery_status（默认 not_requested）；
 * - 意图注册固定 operationId、Project/Feature/Run/适用 Attempt、executionVersion、
 *   仓库/worktree 身份、预期 HEAD、候选 tree、代码摘要、验证/审批引用、消息、
 *   用户身份、策略摘要、runtime 审计与执行归属；同 operationId 同意图幂等，
 *   不同意图/跨项目/陈旧 revision/陈旧 executionVersion 拒绝；
 * - 终态写回 CAS 一次：状态、actual commit/tree、操作回执、Feature deliveryStatus
 *   与 state_events 同事务；故障注入整组回滚；未知退出/耗时保持 null；
 * - 两条真实 SQLite 连接竞争登记/收尾只产生一个有效结果；意图列不可变，
 *   终态不可覆盖。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { installWriteFault, WRITE_FAULT_POINTS } from '../../helpers/p02-2/index.ts';

const HASH = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const FROZEN_V1_V25_CHECKSUMS =
  '2c4eb475c44b28bd1a784ed8429bd080424865a34ab3379286219cda3f8e28ff';

type StorageFailure = {
  kind?: string;
  details?: Record<string, unknown>;
  operation?: string;
};

function captureFailure(fn: () => unknown): StorageFailure {
  try {
    fn();
  } catch (error) {
    return error as StorageFailure;
  }
  throw new Error('expected a StorageError but the operation succeeded');
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  const db = box.session.database;
  const feature = db
    .prepare('SELECT revision FROM features WHERE project_id = ? AND id = ?')
    .get(box.projectId, box.featureId) as { revision: number };
  const binding = db
    .prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?')
    .get(box.projectId) as { id: string; repo_identity: string };
  // 第二个项目/Feature（真实行）用于跨项目关联负例。
  db.prepare(
    `INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels)
     VALUES ('project-b', ?, 1, ?, 'Project B', 'active', NULL, '[]')`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels)
     VALUES ('phase-b', ?, 'project-b', 1, ?, 'Phase B', 'open', NULL, '[]')`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status,
       plan_status, description, labels, source_refs, plan_digest)
     VALUES ('feature-b', ?, 'project-b', 1, ?, 'phase-b', 'Feature B', 'draft', 'draft', NULL, '[]', '[]', NULL)`,
  ).run(NOW, NOW);

  const head = box.box.gitHead('A');
  const store = () => createSqliteGitOperationStore(box.session, { nowUtcMs: () => NOW });

  const intent = (overrides: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    projectId: box.projectId,
    featureId: box.featureId,
    runId: ids.runId,
    attemptId: null,
    executionVersion: 1,
    operationType: 'feature_final_commit',
    repositoryBindingId: binding.id,
    repoIdentity: binding.repo_identity,
    worktreePath: box.box.repoDirA,
    expectedHead: head,
    candidateTree: 'b'.repeat(40),
    codeDigest: HASH,
    verificationRefs: [{ kind: 'verification_batch', id: 'vbatch-1', digest: HASH }],
    approvalRefs: [],
    message: 'P03-8 F-002 controlled commit',
    gitIdentity: { name: 'Test User', email: 'test@example.com', confirmed: true },
    deliveryPolicyDigest: HASH_B,
    runtimeSource: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      source: { kind: 'global_default', sourceKey: 'strategies.defaultStrategy' },
    },
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    expectedFeatureRevision: feature.revision,
    ...overrides,
  });

  const finalize = (operationId: string, overrides: Record<string, unknown> = {}) => ({
    operationId,
    projectId: box.projectId,
    expectedRevision: 1,
    status: 'succeeded',
    actualCommit: 'c'.repeat(40),
    actualTree: 'b'.repeat(40),
    exitCode: 0,
    durationMs: 250,
    reasonCode: null,
    deliveryStatus: 'succeeded',
    settledAtUtcMs: NOW + 1_000,
    ...overrides,
  });

  const gitEvents = () =>
    db
      .prepare(
        `SELECT event_type, aggregate_id, aggregate_revision, payload
         FROM state_events WHERE aggregate_type = 'git_operation' ORDER BY sequence`,
      )
      .all()
      .map((row) => {
        const typed = row as {
          event_type: string;
          aggregate_id: string;
          aggregate_revision: number;
          payload: string;
        };
        return { ...typed, payload: parseJson(typed.payload) };
      });

  const deliveryStatus = () =>
    (db
      .prepare('SELECT delivery_status FROM features WHERE project_id = ? AND id = ?')
      .get(box.projectId, box.featureId) as { delivery_status: string }).delivery_status;

  /** 插入一个真实 Attempt（验证 executionVersion 的适用关联）。 */
  const insertAttempt = () => {
    const ref = (artifactId: string) => ({
      artifactId,
      version: 1,
      contentHash: HASH,
      sizeBytes: 10,
      locator: `inputs/${artifactId}`,
      mediaType: 'application/json',
    });
    const inputSnapshot = {
      schemaVersion: 1,
      projectId: box.projectId,
      featureId: box.featureId,
      taskId: ids.taskId,
      group: { snapshot: ref('f002-snapshot'), manifest: ref('f002-manifest'), prompt: ref('f002-prompt') },
      requiredInputs: [],
      digests: {
        snapshotDigest: HASH,
        manifestDigest: HASH,
        promptDigest: HASH,
        strategyCopyDigest: HASH,
        permissionsDigest: HASH,
      },
      approval: { planDigest: HASH, checkPolicyDigest: HASH_B, decisionId: null, featureRevision: 1 },
      taskRevision: 1,
      promptBytes: 10,
      tokenEstimate: { value: 3, kind: 'estimation', method: 'utf8-bytes/4' },
      preparedAtUtcMs: NOW,
    };
    for (const refEntry of Object.values(inputSnapshot.group)) {
      db.prepare(
        `INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type,
          expected_hash, content_hash, size_bytes, storage_locator)
         VALUES (?, ?, ?, ?, 'execution-input', 'ready', 'application/json', ?, ?, 10, ?)`,
      ).run(refEntry.artifactId, NOW, NOW, box.projectId, HASH, HASH, refEntry.locator);
    }
    db.prepare(
      `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
        number, owner_id, host_instance_id, execution_version, lease_until, status,
        execution_stage, input_snapshot, input_digest, input_ref)
       VALUES ('f002-attempt', ?, ?, ?, ?, ?, ?, 1, 'owner-1', 'host-1', 1, ?, 'executing',
        'runtime', ?, ?, 'f002-snapshot')`,
    ).run(
      NOW,
      NOW,
      box.projectId,
      box.featureId,
      ids.runId,
      ids.taskId,
      NOW + 60_000,
      JSON.stringify(inputSnapshot),
      HASH,
    );
  };

  return {
    box,
    db,
    ids,
    feature,
    store,
    intent,
    finalize,
    gitEvents,
    deliveryStatus,
    insertAttempt,
  };
}

describe('P03-8 F-002 migration v26 git operations', () => {
  it('appends v26 without changing delivered v1-v25 checksums', () => {
    expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(currentSchemaVersion);
    expect(SQLITE_MIGRATIONS).toHaveLength(currentSchemaVersion);
    const frozen = createHash('sha256')
      .update(SQLITE_MIGRATIONS.slice(0, 25).map((migration) => migration.checksum).join('\n'))
      .digest('hex');
    expect(frozen).toBe(FROZEN_V1_V25_CHECKSUMS);
    const v26 = SQLITE_MIGRATIONS[25]!;
    expect(v26.version).toBe(26);
    expect(v26.checksum).toBe(createHash('sha256').update(v26.sql).digest('hex'));
    expect(v26.sql).toContain('CREATE TABLE git_operations');
    expect(v26.sql).toContain("ALTER TABLE features ADD COLUMN delivery_status");
    // 通用 operations 表仍属后续设计；本任务使用专用 git_operations。
    expect(v26.sql).not.toMatch(/CREATE TABLE operations\b/);
  });

  it.each([0, 5, 25])(
    'upgrades v%s (including P02 v5) to v26 and preserves prior data/checksums',
    async (version) => {
      const sandbox = createTempSandbox('shiploop-p038-f002-upgrade-');
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        if (version > 0) {
          await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version) });
          session.database
            .prepare(
              `INSERT INTO projects (id, created_at, updated_at, display_name, status, labels)
               VALUES ('old-project', ?, ?, 'Preserved', 'active', '[]')`,
            )
            .run(NOW, NOW);
          if (version >= 6) {
            session.database
              .prepare(
                `INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels)
                 VALUES ('old-phase', ?, 'old-project', 1, ?, 'Preserved Phase', 'open', NULL, '[]')`,
              )
              .run(NOW, NOW);
            session.database
              .prepare(
                `INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title,
                   status, plan_status, description, labels, source_refs, plan_digest)
                 VALUES ('old-feature', ?, 'old-project', 1, ?, 'old-phase', 'Preserved Feature',
                   'draft', 'draft', NULL, '[]', '[]', NULL)`,
              )
              .run(NOW, NOW);
          }
        }
        const before =
          version > 0
            ? session.database
                .prepare('SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version')
                .all(version)
            : [];
        const result = await migrateSqliteStorage(session);
        expect(result.toVersion).toBe(currentSchemaVersion);
        expect(result.appliedVersions).toEqual(
          version === 0
            ? Array.from({ length: currentSchemaVersion }, (_, index) => index + 1)
            : Array.from({ length: currentSchemaVersion - version }, (_, index) => version + 1 + index),
        );
        expect(
          session.database
            .prepare('SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version')
            .all(version),
        ).toEqual(before);
        const tables = session.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => (row as { name: string }).name);
        expect(tables).toContain('git_operations');
        if (version > 0) {
          expect(
            session.database
              .prepare("SELECT display_name FROM projects WHERE id = 'old-project'")
              .get(),
          ).toEqual({ display_name: 'Preserved' });
          if (version >= 6) {
            expect(
              session.database
                .prepare("SELECT title, delivery_status FROM features WHERE id = 'old-feature'")
                .get(),
            ).toEqual({ title: 'Preserved Feature', delivery_status: 'not_requested' });
          }
        }
        expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
        expect(
          session.database.prepare('SELECT count(*) AS n FROM schema_migrations').get(),
        ).toEqual({ n: currentSchemaVersion });
        session.close();
        const reopened = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
        try {
          expect(
            reopened.database
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'git_operations'",
              )
              .all(),
          ).toHaveLength(1);
        } finally {
          reopened.close();
        }
      } finally {
        session.isOpen() && session.close();
        sandbox.cleanup();
      }
    },
  );

  it('creates the operations table with immutable intent/terminal triggers and delivery column', async () => {
    const f = await fixture();
    try {
      const columns = f.db
        .prepare('PRAGMA table_xinfo(git_operations)')
        .all()
        .map((row) => (row as { name: string }).name);
      for (const column of [
        'id',
        'project_id',
        'feature_id',
        'run_id',
        'attempt_id',
        'execution_version',
        'repository_binding_id',
        'repo_identity',
        'worktree_path',
        'expected_head',
        'candidate_tree',
        'code_digest',
        'verification_refs',
        'approval_refs',
        'message',
        'identity_name',
        'identity_email',
        'delivery_policy_digest',
        'runtime_source',
        'intent_digest',
        'status',
        'actual_commit',
        'actual_tree',
        'exit_code',
        'duration_ms',
        'reason_code',
        'receipt',
        'delivery_status',
        'settled_at',
      ]) {
        expect(columns).toContain(column);
      }
      const triggers = f.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(triggers).toEqual(
        expect.arrayContaining([
          'git_operations_insert_pending',
          'git_operations_attempt_identity_check',
          'git_operations_intent_immutable',
          'git_operations_terminal_immutable',
        ]),
      );
      const featureColumns = f.db
        .prepare('PRAGMA table_xinfo(features)')
        .all()
        .map((row) => (row as { name: string }).name);
      expect(featureColumns).toContain('delivery_status');
      expect(f.deliveryStatus()).toBe('not_requested');
    } finally {
      f.box.close();
    }
  });
});

describe('P03-8 F-002 immutable commit intent registration', () => {
  it('persists every intent field and records one registration event', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      const result = f.store().registerGitOperation(input);
      expect(result.created).toBe(true);
      expect(result.operation.status).toBe('pending');
      expect(result.operation.revision).toBe(1);
      expect(result.operation.intentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.operation.intent).toMatchObject({
        operationId: input.operationId,
        projectId: f.box.projectId,
        featureId: f.box.featureId,
        runId: f.ids.runId,
        attemptId: null,
        executionVersion: 1,
        operationType: 'feature_final_commit',
        repositoryBindingId: input.repositoryBindingId,
        repoIdentity: input.repoIdentity,
        worktreePath: f.box.box.repoDirA,
        expectedHead: input.expectedHead,
        candidateTree: input.candidateTree,
        codeDigest: HASH,
        message: 'P03-8 F-002 controlled commit',
        deliveryPolicyDigest: HASH_B,
        ownerId: 'owner-1',
        hostInstanceId: 'host-1',
      });
      expect(result.operation.intent.gitIdentity).toEqual({
        name: 'Test User',
        email: 'test@example.com',
        confirmed: true,
      });
      expect(result.operation.intent.runtimeSource).toMatchObject({ runtime: 'pi', provider: 'anthropic' });
      expect(result.operation.deliveryStatus).toBeNull();
      expect(result.operation.receipt).toBeNull();
      expect(f.deliveryStatus()).toBe('not_requested');
      const events = f.gitEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'git.operation.registered',
        aggregate_id: input.operationId,
        aggregate_revision: 1,
        payload: { operationId: input.operationId },
      });
    } finally {
      f.box.close();
    }
  });

  it('returns the original record for the same operationId and identical intent', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      const first = f.store().registerGitOperation(input);
      const second = f.store().registerGitOperation(input);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.operation).toEqual(first.operation);
      expect(f.gitEvents()).toHaveLength(1);
      expect(
        f.db.prepare('SELECT count(*) AS n FROM git_operations').get(),
      ).toEqual({ n: 1 });
    } finally {
      f.box.close();
    }
  });

  it('rejects a different intent reused under the same operationId without changing the original', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      const first = f.store().registerGitOperation(input);
      const failure = captureFailure(() =>
        f.store().registerGitOperation({ ...input, message: 'different commit message' }),
      );
      expect(failure).toMatchObject({
        kind: 'conflict',
        details: { reason: 'intent_conflict' },
      });
      const stored = f.store().getGitOperation(f.box.projectId, input.operationId);
      expect(stored).toEqual(first.operation);
      expect(stored.intent.message).toBe('P03-8 F-002 controlled commit');
      expect(f.gitEvents()).toHaveLength(1);
    } finally {
      f.box.close();
    }
  });

  it('rejects cross-project association, stale feature revision and stale executionVersion', async () => {
    const f = await fixture();
    try {
      const crossProject = captureFailure(() =>
        f.store().registerGitOperation(
          f.intent({ featureId: 'feature-b', expectedFeatureRevision: 1 }),
        ),
      );
      expect(crossProject).toMatchObject({ kind: 'ownership' });

      const staleRevision = captureFailure(() =>
        f.store().registerGitOperation(
          f.intent({ expectedFeatureRevision: f.feature.revision + 1 }),
        ),
      );
      expect(staleRevision).toMatchObject({
        kind: 'conflict',
        details: { reason: 'stale_revision' },
      });

      f.insertAttempt();
      const attemptIntent = f.intent({ attemptId: 'f002-attempt', executionVersion: 1 });
      const registered = f.store().registerGitOperation(attemptIntent);
      expect(registered.operation.intent.attemptId).toBe('f002-attempt');
      const staleVersion = captureFailure(() =>
        f.store().registerGitOperation(
          f.intent({
            operationId: randomUUID(),
            attemptId: 'f002-attempt',
            executionVersion: 2,
          }),
        ),
      );
      expect(staleVersion).toMatchObject({
        kind: 'conflict',
        details: { reason: 'stale_execution_version' },
      });
      expect(f.gitEvents()).toHaveLength(1);
    } finally {
      f.box.close();
    }
  });

  it('keeps intent columns immutable at the database boundary', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const failure = captureFailure(() =>
        f.db
          .prepare('UPDATE git_operations SET message = ? WHERE id = ?')
          .run('tampered message', input.operationId),
      );
      expect(String(failure)).toContain('immutable');
      expect(
        f.store().getGitOperation(f.box.projectId, input.operationId).intent.message,
      ).toBe('P03-8 F-002 controlled commit');
    } finally {
      f.box.close();
    }
  });
});

describe('P03-8 F-002 atomic terminal settlement', () => {
  it('writes status, actual commit/tree, receipt, deliveryStatus and event in one transaction', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const result = f.store().finalizeGitOperation(f.finalize(input.operationId));
      expect(result.settled).toBe(true);
      expect(result.operation).toMatchObject({
        status: 'succeeded',
        actualCommit: 'c'.repeat(40),
        actualTree: 'b'.repeat(40),
        exitCode: 0,
        durationMs: 250,
        reasonCode: null,
        deliveryStatus: 'succeeded',
        revision: 2,
      });
      expect(result.operation.receipt).toMatchObject({
        schemaVersion: 1,
        operationId: input.operationId,
        status: 'succeeded',
        expectedHead: input.expectedHead,
        candidateTree: input.candidateTree,
        actualCommit: 'c'.repeat(40),
        actualTree: 'b'.repeat(40),
        exitCode: 0,
        durationMs: 250,
        deliveryStatus: 'succeeded',
        recordedAtUtcMs: NOW + 1_000,
      });
      expect(f.deliveryStatus()).toBe('succeeded');
      const events = f.gitEvents();
      expect(events.map((event) => event.event_type)).toEqual([
        'git.operation.registered',
        'git.operation.settled',
      ]);
      expect(events[1]).toMatchObject({
        aggregate_id: input.operationId,
        aggregate_revision: 2,
        payload: { operationId: input.operationId, status: 'succeeded' },
      });
      expect(f.store().getGitOperation(f.box.projectId, input.operationId)).toEqual(
        result.operation,
      );
    } finally {
      f.box.close();
    }
  });

  it('records no_change without inventing a commit', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const result = f.store().finalizeGitOperation(
        f.finalize(input.operationId, {
          status: 'no_change',
          actualCommit: input.expectedHead,
          actualTree: input.candidateTree,
          exitCode: 0,
          durationMs: 5,
          reasonCode: 'no_change',
        }),
      );
      expect(result.operation).toMatchObject({
        status: 'no_change',
        actualCommit: input.expectedHead,
        actualTree: input.candidateTree,
        deliveryStatus: 'succeeded',
      });
      expect(result.operation.receipt?.status).toBe('no_change');
      expect(f.deliveryStatus()).toBe('succeeded');
    } finally {
      f.box.close();
    }
  });

  it('keeps unknown exit code and duration unknown instead of filling zero', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const result = f.store().finalizeGitOperation(
        f.finalize(input.operationId, {
          status: 'unknown',
          actualCommit: null,
          actualTree: null,
          exitCode: null,
          durationMs: null,
          reasonCode: 'unknown_outcome',
          deliveryStatus: 'pending',
        }),
      );
      expect(result.operation).toMatchObject({
        status: 'unknown',
        actualCommit: null,
        actualTree: null,
        exitCode: null,
        durationMs: null,
        reasonCode: 'unknown_outcome',
        deliveryStatus: 'pending',
      });
      expect(result.operation.receipt?.exitCode).toBeNull();
      expect(result.operation.receipt?.durationMs).toBeNull();
      expect(f.deliveryStatus()).toBe('pending');
      expect(f.gitEvents()[1]).toMatchObject({ payload: { status: 'unknown' } });
    } finally {
      f.box.close();
    }
  });

  it('requires a fixed pending intent before any terminal write', async () => {
    const f = await fixture();
    try {
      const missing = f.intent();
      const failure = captureFailure(() =>
        f.store().finalizeGitOperation(f.finalize(missing.operationId)),
      );
      expect(failure).toMatchObject({ kind: 'not_found' });
      expect(f.gitEvents()).toHaveLength(0);
    } finally {
      f.box.close();
    }
  });

  it('rejects stale expectedRevision and keeps the pending intent unchanged', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const failure = captureFailure(() =>
        f.store().finalizeGitOperation(f.finalize(input.operationId, { expectedRevision: 2 })),
      );
      expect(failure).toMatchObject({
        kind: 'conflict',
        details: { reason: 'stale_revision' },
      });
      expect(f.store().getGitOperation(f.box.projectId, input.operationId)).toMatchObject({
        status: 'pending',
        revision: 1,
      });
      expect(f.deliveryStatus()).toBe('not_requested');
      expect(f.gitEvents()).toHaveLength(1);
    } finally {
      f.box.close();
    }
  });

  it('replays identical terminal facts idempotently and rejects conflicting facts', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const finalizeInput = f.finalize(input.operationId);
      const first = f.store().finalizeGitOperation(finalizeInput);
      const replay = f.store().finalizeGitOperation(finalizeInput);
      expect(first.settled).toBe(true);
      expect(replay.settled).toBe(false);
      expect(replay.operation).toEqual(first.operation);
      expect(f.gitEvents()).toHaveLength(2);
      const conflict = captureFailure(() =>
        f.store().finalizeGitOperation(
          f.finalize(input.operationId, { actualCommit: 'd'.repeat(40) }),
        ),
      );
      expect(conflict).toMatchObject({
        kind: 'conflict',
        details: { reason: 'terminal_operation_conflict' },
      });
      expect(f.store().getGitOperation(f.box.projectId, input.operationId)).toEqual(
        first.operation,
      );
      expect(f.gitEvents()).toHaveLength(2);
    } finally {
      f.box.close();
    }
  });

  it('rolls back the whole group when the event write fails after business updates', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store().registerGitOperation(input);
      const fault = installWriteFault(f.db, {
        target: WRITE_FAULT_POINTS.stateEventsBeforeInsert,
      });
      try {
        expect(() =>
          f.store().finalizeGitOperation(f.finalize(input.operationId)),
        ).toThrowError(/injected fault/);
      } finally {
        fault.remove();
      }
      expect(f.store().getGitOperation(f.box.projectId, input.operationId)).toMatchObject({
        status: 'pending',
        revision: 1,
        actualCommit: null,
        receipt: null,
      });
      expect(f.deliveryStatus()).toBe('not_requested');
      expect(f.gitEvents()).toHaveLength(1);
    } finally {
      f.box.close();
    }
  });

  it('serializes registration and settlement across two real SQLite connections', async () => {
    const f = await fixture();
    const second = openSqliteStorageSession({ path: f.box.box.dbPath });
    try {
      const input = f.intent();
      const first = f.store().registerGitOperation(input);
      const secondStore = createSqliteGitOperationStore(second, { nowUtcMs: () => NOW });
      const replay = secondStore.registerGitOperation(input);
      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.operation).toEqual(first.operation);
      expect(f.gitEvents()).toHaveLength(1);

      const finalizeInput = f.finalize(input.operationId);
      const settled = f.store().finalizeGitOperation(finalizeInput);
      const raced = secondStore.finalizeGitOperation(finalizeInput);
      expect(settled.settled).toBe(true);
      expect(raced.settled).toBe(false);
      expect(raced.operation).toEqual(settled.operation);
      expect(f.gitEvents()).toHaveLength(2);
      expect(
        f.db.prepare('SELECT count(*) AS n FROM git_operations').get(),
      ).toEqual({ n: 1 });
    } finally {
      second.close();
      f.box.close();
    }
  });
});
