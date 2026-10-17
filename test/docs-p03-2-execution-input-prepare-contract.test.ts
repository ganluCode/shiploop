/**
 * P03-2 / F-006 文档核验：`docs/p03-2-execution-input-prepare-contract.md` 记录的
 * 执行输入准备契约必须与仓库实现事实一致（三阶段结构与事务边界、制品组身份、
 * 最终重核与不误报纪律、失败证据与幂等、失败原因词汇与公开错误映射、装配与
 * 预算），避免「文档另立一套」与后续 Host/CLI 接线任务（F-007/F-008）及
 * P03-3/4 绑定任务各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET,
  DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS,
  EXECUTION_INPUT_PREPARE_IMPACT,
  EXECUTION_INPUT_PREPARE_OPERATION,
} from '../packages/core/src/application/execution-input-prepare.ts';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
} from '../packages/core/src/ports/commands.ts';
import {
  EXECUTION_INPUT_PREPARED_EVENT_TYPE,
  PLAN_EVENT_TYPES,
} from '../packages/core/src/ports/plan-store.ts';
import { PUBLIC_STATE_EVENT_TYPES } from '../packages/core/src/ports/events.ts';
import {
  EXECUTION_GROUP_JSON_MEDIA_TYPE,
  EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
  EXECUTION_INPUT_GROUP_LOCATOR_PREFIX,
  EXECUTION_MANIFEST_ARTIFACT_KIND,
  EXECUTION_PROMPT_ARTIFACT_KIND,
  EXECUTION_SNAPSHOT_ARTIFACT_KIND,
  EXECUTION_INPUT_PREPARE_FAILURE_REASONS,
  TRUSTED_PROJECT_PERMISSIONS_READER,
  computeExecutionPermissionsDigest,
  computeExecutionStrategyCopyDigest,
} from '../packages/core/src/ports/execution-input-prepare.ts';
import { CONTEXT_INPUT_SCHEMA_VERSION } from '../packages/core/src/ports/context-build.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-2-execution-input-prepare-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-2 / F-006 执行输入准备契约文档', () => {
  it('命令面与实现常量一致（操作/能力位/创建类无 CAS/payload 面）', () => {
    const doc = readContractDoc();
    expect(COMMAND_OPERATIONS).toContain(EXECUTION_INPUT_PREPARE_OPERATION);
    expect(APP_CAPABILITIES).toContain(COMMAND_OPERATION_SPECS[EXECUTION_INPUT_PREPARE_OPERATION].capability);
    expect(COMMAND_OPERATION_SPECS[EXECUTION_INPUT_PREPARE_OPERATION]).toEqual({
      scopeKind: 'project',
      mutation: 'create',
      capability: 'execution.input.prepare',
    });
    for (const keyword of [
      EXECUTION_INPUT_PREPARE_OPERATION,
      'execution.input.prepare',
      '不携带 expectedRevision',
      'featureId',
      'taskId',
      'items',
      'createExecutionInputPrepareService',
      'submitExecutionInputPrepare',
      'ports/execution-input-prepare.ts',
      'application/execution-input-prepare.ts',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('制品组受控词汇与三阶段结构在文档中可核对', () => {
    const doc = readContractDoc();
    expect(EXECUTION_SNAPSHOT_ARTIFACT_KIND).toBe('execution-snapshot');
    expect(EXECUTION_MANIFEST_ARTIFACT_KIND).toBe('execution-manifest');
    expect(EXECUTION_PROMPT_ARTIFACT_KIND).toBe('execution-prompt');
    expect(EXECUTION_INPUT_GROUP_LOCATOR_PREFIX).toBe('execution-input-groups');
    expect(EXECUTION_GROUP_JSON_MEDIA_TYPE).toBe('application/json');
    expect(EXECUTION_GROUP_PROMPT_MEDIA_TYPE).toBe('text/plain');
    expect(CONTEXT_INPUT_SCHEMA_VERSION).toBe(3);
    for (const keyword of [
      EXECUTION_SNAPSHOT_ARTIFACT_KIND,
      EXECUTION_MANIFEST_ARTIFACT_KIND,
      EXECUTION_PROMPT_ARTIFACT_KIND,
      `${EXECUTION_INPUT_GROUP_LOCATOR_PREFIX}/<taskId>/snapshot`,
      EXECUTION_GROUP_JSON_MEDIA_TYPE,
      EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
      'stableStringify',
      'readVerifiedContent',
      'readExecutionInputPreparationView',
      'BEGIN IMMEDIATE',
      '不宣称文件系统与 SQLite 存在跨介质原子事务',
      'execution.input.prepared',
    ]) {
      expect(doc).toContain(keyword);
    }
    // 事件面：新事件进入计划域白名单与公开事件流白名单（脱敏 payload 恒形）。
    expect(PLAN_EVENT_TYPES).toContain(EXECUTION_INPUT_PREPARED_EVENT_TYPE);
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(EXECUTION_INPUT_PREPARED_EVENT_TYPE);
    expect(doc).toContain('{prepared:true}');
  });

  it('最终重核不误报纪律（内容身份而非裸 revision）与影响面纯规则在文档中可核对', () => {
    const doc = readContractDoc();
    expect(EXECUTION_INPUT_PREPARE_IMPACT).toEqual({
      publishesImmutableGroupArtifacts: true,
      capturesFromConsistentReadView: true,
      assemblesOutsideTransactions: true,
      finalRecheckInsideWriteTransaction: true,
      changesPlanEntities: false,
      changesTaskStrategyCopies: false,
      createsExecutionEntities: false,
      startsRuntimeGitOrChecks: false,
      rewritesHistoricalArtifacts: false,
      credentialsRemainReferencesOnly: true,
    });
    // 策略副本身份摘要与 F-005 manifest task-strategy 摘要同一公式（设计相等）。
    const strategyDigest = computeExecutionStrategyCopyDigest({
      executionConfig: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      configSource: 'project_default',
      configSourceKey: 'modelMap.low',
    });
    expect(strategyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeExecutionPermissionsDigest([])).toMatch(/^[0-9a-f]{64}$/);
    expect(computeExecutionPermissionsDigest([])).not.toBe(computeExecutionPermissionsDigest(['repo.read']));
    for (const keyword of [
      'strategyCopyDigest',
      'permissionsDigest',
      'task_strategy_changed',
      'permissions_changed',
      'plan_changed',
      'check_policy_changed',
      '纯标签编辑',
      'modelMap',
      '内容身份',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('失败证据与幂等纪律、失败原因词汇在文档中可核对', () => {
    const doc = readContractDoc();
    expect(EXECUTION_INPUT_PREPARE_FAILURE_REASONS).toContain('publish_failed');
    expect(EXECUTION_INPUT_PREPARE_FAILURE_REASONS).toContain('limit_exceeded');
    expect(EXECUTION_INPUT_PREPARE_FAILURE_REASONS).toContain('published_body_mismatch');
    for (const keyword of [
      '不留下可绑定',
      '半完整制品组',
      '逐字节不变',
      '不代表该输入仍满足',
      '重复 `commandId`',
      'artifact_not_ready',
      'artifact_missing',
      'artifact_changed',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('装配与预算缺省（inputSourceRoots/空权限面/冻结预算）在文档中可核对', () => {
    const doc = readContractDoc();
    expect(DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS).toEqual({ maxRequiredItems: 16 });
    expect(DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET.maxPromptBytes).toBe(400_000);
    expect(TRUSTED_PROJECT_PERMISSIONS_READER({ projectId: 'p', featureId: 'f', taskId: 't' })).toEqual({
      grants: [],
    });
    for (const keyword of [
      'inputSourceRoots',
      'TRUSTED_PROJECT_PERMISSIONS_READER',
      'DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS',
      'DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET',
      'unsupported',
      'openCoreApplication',
      'P03-3/4',
    ]) {
      expect(doc).toContain(keyword);
    }
  });
});
