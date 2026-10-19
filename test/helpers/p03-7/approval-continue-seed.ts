/**
 * P03-7 / F-014 测试共用种子：真实 worktree 执行后的「机器通过 + 等待人审」状态。
 *
 * 只用于测试装配（不进 packages/）：
 * - 复用 p03-6 绑定夹具的真实执行（FakeRuntime message-only：无工具进程，
 *   停止经整组缺席普查可证明）产生 verifying Attempt 与受管 worktree；
 * - 发布真实检查输出/诊断制品，定版 passed VerificationBatch（代码身份取
 *   受管 worktree 的真实检查摘要，环境身份为当前 Node Host）；
 * - 播种 pending 人审事项后经受信完成入口结算：passed + 人审缺失 →
 *   等待批准（waitingFor='approval'），保存机器证据与 observationDigest。
 */
import { createHash } from 'node:crypto';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION,
  RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../../../packages/core/src/ports/runtime-execution.ts';
import { BINDING_NOW, type BindingFixture } from '../p03-6/input-binding-fixture.ts';

export interface VerificationCompletionLike {
  complete(input: unknown): Promise<{
    readonly outcome: string;
    readonly observationDigest: string;
    readonly receipt: {
      readonly waitingFor: string | null;
      readonly disposition: string;
      readonly reason?: string | null;
    };
  }>;
}

export interface SeededApprovalWaitingState {
  readonly attemptId: string;
  readonly batchId: string;
  readonly codeDigest: string;
  readonly policyDigest: string;
  readonly observationDigest: string;
  readonly planDigest: string;
  readonly taskRevision: number;
  /** 无审批事项时为 null（F-016：机器通过直接放行路径）。 */
  readonly approvalItemId: string | null;
  readonly approvalItemRevision: number | null;
  readonly approvalItemKind: 'block' | 'approval' | null;
  readonly responsibleParty: string | null;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly runId: string;
  readonly headCommit: string;
  readonly codeAttemptsUsed: number;
  readonly runtimeStarts: number;
  readonly taskId: string;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** 在真实执行完成（attempt=verifying）后播种验证证据与等待人审状态。
 *
 * F-016 通用化：taskId 可选（默认 't-1'，对应绑定夹具中的指定 Task）；
 * approvalItem=false 时不播种 pending 事项，机器通过直接完成验证收尾
 * （期望 outcome='passed'、Attempt succeeded、Task passed）。 */
export async function seedApprovalWaitingVerification(options: {
  readonly fixture: BindingFixture;
  readonly completion: VerificationCompletionLike;
  readonly itemId?: string;
  readonly itemKind?: 'block' | 'approval';
  readonly responsibleParty?: string;
  readonly taskId?: string;
  readonly approvalItem?: boolean;
}): Promise<SeededApprovalWaitingState> {
  const fixture = options.fixture;
  const taskId = options.taskId ?? 't-1';
  const withApprovalItem = options.approvalItem !== false;
  const db = fixture.session.database;
  const attempt = db.prepare(
    "SELECT id, owner_id, host_instance_id, execution_version, input_snapshot FROM attempts WHERE task_id = ? AND status = 'verifying'",
  ).get(taskId) as {
    id: string;
    owner_id: string;
    host_instance_id: string;
    execution_version: number;
    input_snapshot: string;
  };
  const snapshot = JSON.parse(attempt.input_snapshot) as {
    approval: { checkPolicyDigest: string };
  };
  const managed = db.prepare(
    'SELECT repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit FROM managed_workspaces WHERE project_id = ? AND feature_id = ?',
  ).get(fixture.projectId, fixture.featureId) as {
    repository_binding_id: string;
    repository_binding_revision: number;
    repo_identity: string;
    canonical_path: string;
    git_common_dir: string;
    branch: string;
    base_commit: string;
  };
  const inspection = await createWorkspaceInspector({
    authorizedRoots: [fixture.box.root],
    confirmProcessIdentity: async (identity) => ({ launchId: identity.launchId }),
  }).inspect({
    repositoryBindingId: managed.repository_binding_id,
    repositoryBindingRevision: managed.repository_binding_revision,
    repoIdentity: managed.repo_identity,
    canonicalPath: managed.canonical_path,
    gitCommonDir: managed.git_common_dir,
    branch: managed.branch,
    baseCommit: managed.base_commit,
  });
  const codeDigest = verificationCodeIdentity(inspection).codeDigest;
  const headCommit = inspection.repository.headCommit;
  const policyDigest = snapshot.approval.checkPolicyDigest;
  const planDigest = (
    db.prepare('SELECT plan_digest FROM features WHERE id = ?').get(fixture.featureId) as {
      plan_digest: string;
    }
  ).plan_digest;

  /* 真实检查输出 + 诊断制品（ready + 可核验）。 */
  const outputBody = 'PASS tests\n1 passed\n';
  const output = await fixture.publisher.publishArtifact({
    projectId: fixture.projectId,
    kind: 'verification_output',
    mediaType: 'text/plain',
    expectedHash: sha256(outputBody),
    locator: `verification/${attempt.id}/tests-output.txt`,
    content: [Buffer.from(outputBody, 'utf8')],
  });
  const diagnosticBody = JSON.stringify({ schemaVersion: 1, kind: 'verification-diagnostic', attemptId: attempt.id });
  const diagnostic = await fixture.publisher.publishArtifact({
    projectId: fixture.projectId,
    kind: 'diagnostic',
    mediaType: 'application/json',
    expectedHash: sha256(diagnosticBody),
    locator: `attempts/${attempt.id}/diagnostic.json`,
    content: [Buffer.from(diagnosticBody, 'utf8')],
  });

  const batchId = `verification-${attempt.id}`;
  const verification = createSqliteVerificationStore(fixture.session, { nowUtcMs: () => BINDING_NOW });
  const atomic = createSqliteAtomicCommandStore(fixture.session, { nowUtcMs: () => BINDING_NOW });
  await atomic.transact('F-014.seed-passed-verification', (transaction) => {
    verification.createVerificationBatchInTransaction(transaction, {
      batchId,
      projectId: fixture.projectId,
      featureId: fixture.featureId,
      runId: fixture.runId,
      taskId,
      attemptId: attempt.id,
      executionVersion: attempt.execution_version,
      operation: 'task.verify.checks',
      codeDigest,
      policyDigest,
      environmentSummary: {
        runner: 'node',
        nodeVersion: process.version,
        platform: process.platform,
      },
      checkSnapshot: [
        {
          checkKey: 'tests',
          scope: 'task',
          kind: 'command',
          argv: ['npm', 'test'],
          cwdRef: null,
          environmentRef: null,
          timeout: 60_000,
          required: true,
          requirementRefs: [],
        },
      ],
      selection: {
        schemaVersion: 1,
        mode: 'candidates',
        reason: '受影响范围选择',
        selectedCheckKeys: ['tests'],
      },
      startedAtUtcMs: BINDING_NOW,
    });
    verification.saveCheckResultInTransaction(transaction, {
      resultId: `vres-${attempt.id}`,
      projectId: fixture.projectId,
      batchId,
      checkKey: 'tests',
      status: 'passed',
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputArtifactId: output.artifact.id,
      outputTail: '1 passed',
      startedAtUtcMs: BINDING_NOW,
      endedAtUtcMs: BINDING_NOW + 1000,
    });
    verification.finalizeVerificationBatchInTransaction(transaction, {
      projectId: fixture.projectId,
      batchId,
      expectedRevision: 1,
      status: 'passed',
    });
    /* 诊断引用（成功路径必需；已有则复用不覆盖）。 */
    db.prepare(
      'UPDATE attempts SET diagnostic_ref = ? WHERE id = ? AND diagnostic_ref IS NULL',
    ).run(diagnostic.artifact.id, attempt.id);
  });

  /* pending 人审事项：approve/reject 用 approval、解除用 block；F-016 免审批
   * 路径（approvalItem=false）不播种事项，机器通过直接放行。 */
  const itemId = options.itemId ?? `item-${attempt.id}`;
  const itemKind = options.itemKind ?? 'approval';
  const responsibleParty = options.responsibleParty ?? 'owner';
  /* 调度诊断会把暂停原因覆写为 run_control_blocked；验证收尾契约认定的常态是
   * 等待人审暂停（reason='approval'），播种前恢复该受信状态。 */
  db.prepare(
    `UPDATE runs SET status = 'paused', reason = 'approval'
      WHERE id = ? AND status = 'paused'`,
  ).run(fixture.runId);
  if (withApprovalItem) {
    db.prepare(
      `INSERT INTO task_approval_items
        (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
         responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'F-014 人工复核', ?, ?, ?, '[]', 'pending', 'local-owner', '[]')`,
    ).run(
      itemId,
      BINDING_NOW,
      fixture.projectId,
      fixture.featureId,
      taskId,
      BINDING_NOW,
      itemKind,
      responsibleParty,
      planDigest,
      codeDigest,
    );
  }

  const completion = await options.completion.complete({    identity: {
      projectId: fixture.projectId,
      attemptId: attempt.id,
      owner: attempt.owner_id,
      hostInstanceId: attempt.host_instance_id,
      executionVersion: attempt.execution_version,
    },
    taskId,
    runId: fixture.runId,
    verificationBatchId: batchId,
    observation: {
      runtime: {
        result: {
          schemaVersion: RUNTIME_RESULT_SCHEMA_VERSION,
          terminal: 'completed',
          reason: null,
          exitCode: 0,
          signal: null,
          durationMs: 12,
          usage: null,
          lastEventSequence: null,
        },
        stopped: {
          schemaVersion: RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
          confirmed: true,
          checkedAtUtc: new Date(BINDING_NOW).toISOString(),
          detail: null,
        },
      },
      workspaceHeld: true,
      beforeIdentity: { headCommit, codeDigest, executionDigest: policyDigest },
      afterIdentity: { headCommit, codeDigest, executionDigest: policyDigest },
      testCounts: { tests: 1 },
    },
    failures: {},
  });
  if (withApprovalItem) {
    if (
      completion.outcome !== 'passed' ||
      completion.receipt.waitingFor !== 'approval' ||
      completion.receipt.disposition !== 'applied'
    ) {
      const state = db.prepare(
        `SELECT a.status AS attempt_status, a.execution_stage AS stage, a.exit_code, a.diagnostic_ref, a.code_ref,
                t.status AS task_status, t.execution_version AS task_ev, r.status AS run_status, r.reason AS run_reason
           FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN runs r ON r.id = a.run_id WHERE a.id = ?`,
      ).get(attempt.id);
      throw new Error(
        `种子未进入等待人审状态：outcome=${completion.outcome} receipt=${JSON.stringify(completion.receipt)} state=${JSON.stringify(state)}`,
      );
    }
  } else if (
    completion.outcome !== 'passed' ||
    completion.receipt.disposition !== 'applied' ||
    completion.receipt.waitingFor !== null
  ) {
    throw new Error(
      `免审批种子未直接放行：outcome=${completion.outcome} receipt=${JSON.stringify(completion.receipt)}`,
    );
  }

  const task = db.prepare('SELECT revision, code_attempts_used FROM tasks WHERE id = ?').get(taskId) as {
    revision: number;
    code_attempts_used: number;
  };
  const item = withApprovalItem
    ? (db
        .prepare('SELECT revision FROM task_approval_items WHERE id = ?')
        .get(itemId) as { revision: number })
    : null;
  const run = db
    .prepare('SELECT runtime_starts FROM execution_batches WHERE id = (SELECT batch_id FROM runs WHERE id = ?)')
    .get(fixture.runId) as { runtime_starts: number };
  return {
    attemptId: attempt.id,
    batchId,
    codeDigest,
    policyDigest,
    observationDigest: completion.observationDigest,
    planDigest,
    taskRevision: task.revision,
    approvalItemId: withApprovalItem ? itemId : null,
    approvalItemRevision: item?.revision ?? null,
    approvalItemKind: withApprovalItem ? itemKind : null,
    responsibleParty: withApprovalItem ? responsibleParty : null,
    owner: attempt.owner_id,
    hostInstanceId: attempt.host_instance_id,
    executionVersion: attempt.execution_version,
    runId: fixture.runId,
    headCommit,
    codeAttemptsUsed: task.code_attempts_used,
    runtimeStarts: run.runtime_starts,
    taskId,
  };
}
