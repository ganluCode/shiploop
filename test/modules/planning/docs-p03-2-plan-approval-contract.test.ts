/**
 * P03-2 / F-002 文档核验：`docs/p03-2-plan-approval-contract.md` 记录的计划
 * 批准/拒绝决策契约必须与仓库实现事实一致（命令面、决策记录存储与约束、
 * 决策语义、事件与查询、迁移接续与白名单边界），避免「文档另立一套」与
 * 后续 Host/CLI 接线任务（F-007/F-008）各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_PLAN_DECIDE_OPERATION,
  PLAN_DECIDE_IMPACT,
  decideFeaturePlanOutcome,
} from '../../../packages/core/src/application/feature-plan-decide.ts';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
} from '../../../packages/core/src/ports/commands.ts';
import {
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
  PLAN_APPROVAL_REASON_MAX_CODE_POINTS,
  PLAN_APPROVAL_STATUSES,
  PLAN_APPROVAL_SUBJECT_TYPES,
  PLAN_EVENT_TYPES,
  validateFeaturePlanDecideFields,
  validateInsertPlanApprovalInput,
  validateUpdateFeaturePlanStatusInput,
} from '../../../packages/core/src/ports/plan-store.ts';
import { PUBLIC_STATE_EVENT_TYPES } from '../../../packages/core/src/ports/events.ts';
import {
  PLAN_APPROVAL_QUERY_OPERATION,
} from '../../../packages/core/src/ports/queries.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { approvals as approvalsTable } from '../../../packages/core/src/adapters/sqlite/schema.ts';
import { getTableName } from 'drizzle-orm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT_DOC_PATH = 'docs/p03-2-plan-approval-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-2 / F-002 计划决策契约文档', () => {
  it('命令面与实现常量一致（操作/能力位/CAS 权威/payload 面/身份不可伪造）', () => {
    const doc = readContractDoc();
    expect(COMMAND_OPERATIONS).toContain(FEATURE_PLAN_DECIDE_OPERATION);
    expect(APP_CAPABILITIES).toContain(COMMAND_OPERATION_SPECS[FEATURE_PLAN_DECIDE_OPERATION].capability);
    expect(COMMAND_OPERATION_SPECS[FEATURE_PLAN_DECIDE_OPERATION]).toEqual({
      scopeKind: 'project',
      mutation: 'update',
      capability: 'feature.plan.decide',
    });
    for (const keyword of [
      FEATURE_PLAN_DECIDE_OPERATION,
      'feature.plan.decide',
      'expectedRevision',
      'featureId',
      'planDigest',
      'decision',
      'reason',
      'Feature 聚合 revision',
      'principalId',
      '不能伪造身份',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('决策记录存储与 DDL 契约在文档中可核对（v7/约束/不建历史版本表）', () => {
    const doc = readContractDoc();
    // v7 建立 approvals 表（v8 属 F-003 检查政策身份绑定，由
    // test/modules/planning/docs-p03-2-plan-approval-verification-contract.test.ts 守护）。
    expect(SQLITE_MIGRATIONS[6]!.version).toBe(7);
    expect(SQLITE_MIGRATIONS[6]!.sql).toContain('CREATE TABLE approvals');
    expect(SQLITE_MIGRATIONS[6]!.sql).toContain('approvals_subject_decision_unique');
    expect(SQLITE_MIGRATIONS[6]!.sql).toContain('approvals_feature_same_project_fk');
    expect(SQLITE_MIGRATIONS[6]!.sql).toContain('approvals_decided_shape_check');
    // Drizzle Schema 与迁移同源（表存在；列/约束交叉核对由迁移测试覆盖）。
    expect(getTableName(approvalsTable)).toBe('approvals');
    expect([...PLAN_APPROVAL_SUBJECT_TYPES]).toEqual(['feature_plan']);
    expect([...PLAN_APPROVAL_STATUSES]).toEqual(['pending', 'approved', 'rejected', 'superseded']);
    for (const keyword of [
      'v7',
      'approvals',
      'feature_plan',
      'subject_digest',
      'decision_actor',
      'decided_at',
      'UNIQUE(project_id, subject_type, subject_id, subject_digest)',
      '不创建计划或配置历史版本表',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('决策语义与影响面纯规则在文档中可核对（批准≠启动执行/拒绝不提供依据）', () => {
    const doc = readContractDoc();
    expect(PLAN_DECIDE_IMPACT).toEqual({
      recordsDecisionBoundToCurrentPlanDigest: true,
      // P03-2 / F-003：决策同时绑定当前适用检查政策身份（复合决策身份）。
      bindsCurrentCheckPolicyIdentity: true,
      changesFeaturePlanStatus: true,
      changesFeatureOwnRevision: true,
      preservesPlanDigest: true,
      preservesPlanContent: true,
      preservesTaskIdsDependenciesStrategyAndSources: true,
      rereadsDefaultRouting: false,
      makesPlanBasisForExplicitExecution: 'approve_only',
      propagatesToParentOrChild: false,
      createsExecutionEntities: false,
      startsRuntimeGitOrChecks: false,
      allowsAtMostOneDecisionPerDigest: true,
    });
    expect(decideFeaturePlanOutcome('approve')).toEqual({
      recordStatus: 'approved',
      planStatusAfter: 'approved',
    });
    expect(decideFeaturePlanOutcome('reject')).toEqual({
      recordStatus: 'rejected',
      planStatusAfter: 'draft',
    });
    for (const keyword of [
      '不启动执行',
      '不提供该依据',
      '保留所有既有 Task ID',
      '不把拒绝显示为已批准',
      'approval_already_decided',
      'plan_digest_mismatch',
      'no_tasks',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('事件白名单与决策查询操作身份在文档中可核对', () => {
    const doc = readContractDoc();
    expect(FEATURE_PLAN_APPROVED_EVENT_TYPE).toBe('feature.plan.approved');
    expect(FEATURE_PLAN_REJECTED_EVENT_TYPE).toBe('feature.plan.rejected');
    expect(PLAN_EVENT_TYPES).toContain(FEATURE_PLAN_APPROVED_EVENT_TYPE);
    expect(PLAN_EVENT_TYPES).toContain(FEATURE_PLAN_REJECTED_EVENT_TYPE);
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(FEATURE_PLAN_APPROVED_EVENT_TYPE);
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(FEATURE_PLAN_REJECTED_EVENT_TYPE);
    expect(PLAN_APPROVAL_QUERY_OPERATION).toBe('features.approvals');
    for (const keyword of [
      FEATURE_PLAN_APPROVED_EVENT_TYPE,
      FEATURE_PLAN_REJECTED_EVENT_TYPE,
      '{approved:true}',
      '{rejected:true}',
      'features.approvals',
      'currentDecision',
      'F-007',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('校验器拒绝矩阵与文档一致（身份/状态字段未知键、原因上限、已决定形态）', () => {
    const doc = readContractDoc();
    expect(() =>
      validateFeaturePlanDecideFields(
        { featureId: 'f-1', planDigest: 'ab'.repeat(32), decision: 'approve', decisionActor: 'attacker' },
        'doc',
      ),
    ).toThrow(/decisionActor/);
    expect(() =>
      validateFeaturePlanDecideFields(
        { featureId: 'f-1', planDigest: 'ab'.repeat(32), decision: 'approve', reason: 'x'.repeat(PLAN_APPROVAL_REASON_MAX_CODE_POINTS + 1) },
        'doc',
      ),
    ).toThrow(/reason/);
    expect(() =>
      validateInsertPlanApprovalInput(
        {
          projectId: 'p-1',
          subjectType: 'feature_plan',
          subjectId: 'f-1',
          subjectDigest: 'ab'.repeat(32),
          status: 'pending',
          decisionActor: 'local-owner',
          reason: null,
          decidedAtUtcMs: 1,
        },
        'doc',
      ),
    ).toThrow(/approved \/ rejected/);
    expect(() =>
      validateUpdateFeaturePlanStatusInput(
        { projectId: 'p-1', featureId: 'f-1', planStatus: 'running', expectedRevision: 1 },
        'doc',
      ),
    ).toThrow(/planStatus/);
    for (const keyword of [
      'decisionActor',
      String(PLAN_APPROVAL_REASON_MAX_CODE_POINTS),
      '2000',
    ]) {
      expect(doc).toContain(keyword);
    }
  });
});
