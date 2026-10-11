/**
 * P03-2 / F-003 文档核验：`docs/p03-2-plan-approval-verification-contract.md`
 * 记录的有效批准核验与失效处理契约必须与仓库实现事实一致（检查政策身份
 * 摘要、复合决策身份与迁移 v8、评估纯规则原因词汇、失效语义与边界），
 * 避免「文档另立一套」与后续执行授权任务（P03-3/4）各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHECK_POLICY_DIGEST_DOMAIN,
  PLAN_APPROVAL_VERIFICATION_REASONS,
  computeFeatureCheckPolicyDigest,
  evaluatePlanApprovalValidity,
} from '../packages/core/src/ports/plan-approval-verification.ts';
import {
  resolveCurrentCheckPolicyDigest,
  verifyFeaturePlanApprovalInTransaction,
} from '../packages/core/src/application/plan-approval-verification.ts';
import { PLAN_DECIDE_IMPACT } from '../packages/core/src/application/feature-plan-decide.ts';
import { validateInsertPlanApprovalInput } from '../packages/core/src/ports/plan-store.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { approvals as approvalsTable } from '../packages/core/src/adapters/sqlite/schema.ts';
import { getTableColumns, getTableName } from 'drizzle-orm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-2-plan-approval-verification-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-2 / F-003 有效批准核验契约文档', () => {
  it('检查政策身份摘要在文档中可核对（领域前缀/确定性/不依赖路径与 revision）', () => {
    const doc = readContractDoc();
    expect(CHECK_POLICY_DIGEST_DOMAIN).toBe('shiploop:feature-plan-check-policy:v1');
    expect(computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: true })).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFeatureCheckPolicyDigest(undefined)).not.toBe(
      computeFeatureCheckPolicyDigest({ requireChecksBeforeDone: true }),
    );
    // 纯函数服务入口存在（公共导出可引用）。
    expect(typeof resolveCurrentCheckPolicyDigest).toBe('function');
    expect(typeof verifyFeaturePlanApprovalInTransaction).toBe('function');
    for (const keyword of [
      CHECK_POLICY_DIGEST_DOMAIN,
      'computeFeatureCheckPolicyDigest',
      'policies.verification',
      '不得仅依赖可变配置路径、通用配置 revision 或 labels',
      'modelMap',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('复合决策身份与迁移 v8 在文档中可核对（不重建表/不改写既有行）', () => {
    const doc = readContractDoc();
    const v8 = SQLITE_MIGRATIONS[7];
    expect(v8?.version).toBe(8);
    expect(v8?.sql).toContain('ALTER TABLE approvals ADD COLUMN check_policy_digest');
    expect(v8?.sql).toContain('approvals_check_policy_digest_sha256_check');
    expect(v8?.sql).toContain('DROP INDEX approvals_subject_decision_unique');
    expect(v8?.sql).not.toContain('CREATE TABLE');
    // Drizzle Schema 同源：列与五列唯一索引。
    expect(getTableName(approvalsTable)).toBe('approvals');
    expect(Object.values(getTableColumns(approvalsTable)).map((column) => column.name)).toContain(
      'check_policy_digest',
    );
    // 决策插入输入必须携带检查政策摘要（服务端定值，64 位小写 hex）。
    expect(() =>
      validateInsertPlanApprovalInput(
        {
          projectId: 'p-1',
          subjectType: 'feature_plan',
          subjectId: 'f-1',
          subjectDigest: 'ab'.repeat(32),
          status: 'approved',
          decisionActor: 'local-owner',
          reason: null,
          decidedAtUtcMs: 1,
        },
        'doc',
      ),
    ).toThrow(/checkPolicyDigest/);
    expect(PLAN_DECIDE_IMPACT.bindsCurrentCheckPolicyIdentity).toBe(true);
    for (const keyword of [
      'check_policy_digest',
      'v8',
      '不重建表',
      '旧视图不得提交为当前有效依据',
      'bindsCurrentCheckPolicyIdentity',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('评估原因词汇与 fail-closed 语义在文档中可核对', () => {
    const doc = readContractDoc();
    expect([...PLAN_APPROVAL_VERIFICATION_REASONS]).toEqual([
      'approved',
      'no_plan',
      'no_tasks',
      'not_approved',
      'rejected',
      'plan_changed',
      'check_policy_changed',
      'approval_state_inconsistent',
    ]);
    // 纯规则可引用且 fail-closed（未批准即 invalid）。
    expect(
      evaluatePlanApprovalValidity({
        planDigest: 'ab'.repeat(32),
        planStatus: 'draft',
        taskCount: 1,
        decisions: [],
        currentCheckPolicyDigest: computeFeatureCheckPolicyDigest(undefined),
      }),
    ).toMatchObject({ valid: false, reason: 'not_approved' });
    for (const keyword of [
      'no_plan',
      'no_tasks',
      'not_approved',
      'rejected',
      'plan_changed',
      'check_policy_changed',
      'approval_state_inconsistent',
      'features.approvals',
      'validity',
      'verifyFeaturePlanApprovalInTransaction',
      '不创建 Batch/Run/Attempt',
      '不是启动授权',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('失效与边界语义在文档中可核对（证据保留/重批/标签与路由不波及）', () => {
    const doc = readContractDoc();
    for (const keyword of [
      '重新批准当前身份',
      '旧行作为历史证据保留',
      'plan.labels.update',
      'task.strategy.update',
      'approval_already_decided',
      'schemaVersion 仍为 4',
      'F-007',
    ]) {
      expect(doc).toContain(keyword);
    }
  });
});
