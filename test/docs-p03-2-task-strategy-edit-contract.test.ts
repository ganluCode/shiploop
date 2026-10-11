/**
 * P03-2 / F-001 文档核验：`docs/p03-2-task-strategy-edit-contract.md` 记录的
 * Task 策略副本授权 CAS 编辑契约必须与仓库实现事实一致（命令面、副本与来源
 * 语义、能力校验、影响面纯规则、活动保护边界、原子性/幂等与拒绝矩阵），
 * 避免「文档另立一套」与后续 Host/CLI 接线任务（F-007/F-008）各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TASK_STRATEGY_EDIT_CONFIG_SOURCE,
  TASK_STRATEGY_EDIT_IMPACT,
  TASK_STRATEGY_EDIT_SOURCE_KEY,
  TASK_STRATEGY_UPDATE_OPERATION,
} from '../packages/core/src/application/task-strategy-update.ts';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
} from '../packages/core/src/ports/commands.ts';
import {
  PLAN_EVENT_TYPES,
  TASK_STRATEGY_UPDATED_EVENT_TYPE,
  validateUpdateTaskStrategyInput,
} from '../packages/core/src/ports/plan-store.ts';
import { PUBLIC_STATE_EVENT_TYPES } from '../packages/core/src/ports/events.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-2-task-strategy-edit-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-2 / F-001 Task 策略编辑契约文档', () => {
  it('命令面与实现常量一致（操作/能力位/CAS 权威/payload 面）', () => {
    const doc = readContractDoc();
    expect(COMMAND_OPERATIONS).toContain(TASK_STRATEGY_UPDATE_OPERATION);
    expect(APP_CAPABILITIES).toContain(COMMAND_OPERATION_SPECS[TASK_STRATEGY_UPDATE_OPERATION].capability);
    expect(COMMAND_OPERATION_SPECS[TASK_STRATEGY_UPDATE_OPERATION]).toEqual({
      scopeKind: 'project',
      mutation: 'update',
      capability: 'task.strategy.write',
    });
    for (const keyword of [
      TASK_STRATEGY_UPDATE_OPERATION,
      'task.strategy.write',
      'expectedRevision',
      'taskId',
      'executionConfig',
      'Task 自身 revision',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('来源词汇与影响面纯规则在文档中可核对（task_edit/taskEdit + 不重读默认路由）', () => {
    const doc = readContractDoc();
    expect(TASK_STRATEGY_EDIT_CONFIG_SOURCE).toBe('task_edit');
    expect(TASK_STRATEGY_EDIT_SOURCE_KEY).toBe('taskEdit');
    expect(TASK_STRATEGY_EDIT_IMPACT).toEqual({
      changesTaskStrategy: true,
      changesTaskOwnRevision: true,
      rereadsDefaultRouting: false,
      retroactiveOnConfigOrComplexityChanges: false,
      changesPlanDigest: false,
      changesPlanStatus: false,
      changesOtherTasksOrFeature: false,
      invalidatesDigestBoundApprovals: false,
      propagatesToParentOrChild: false,
      requiresSameTransactionActivityGuard: true,
      createsExecutionEntities: false,
    });
    for (const keyword of [
      TASK_STRATEGY_EDIT_CONFIG_SOURCE,
      TASK_STRATEGY_EDIT_SOURCE_KEY,
      '不重读',
      '不追溯',
      'planDigest',
      '词汇扩展记录',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('能力校验复用可信目录与 fail-closed 边界在文档中可核对', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'validateRuntimeStrategyCapabilities',
      'unknown_runtime',
      'incompatible_provider',
      'unsupported_model',
      'unsupported',
      '空目录',
      '不伪装',
      '合法 ≠ 可执行',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('活动执行输入保护边界与 not_run 证据分类在文档中可核对', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'active_execution_inputs',
      'fail-closed',
      'NO_ACTIVE_TASK_EXECUTION_INPUTS_PROBE',
      '暂停不视为',
      'not_run',
      '能力边界宣告',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('事件白名单扩展与公开事件流同源', () => {
    const doc = readContractDoc();
    expect(TASK_STRATEGY_UPDATED_EVENT_TYPE).toBe('task.strategy.updated');
    expect(PLAN_EVENT_TYPES).toContain(TASK_STRATEGY_UPDATED_EVENT_TYPE);
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(TASK_STRATEGY_UPDATED_EVENT_TYPE);
    expect(doc).toContain(TASK_STRATEGY_UPDATED_EVENT_TYPE);
    expect(doc).toContain('{strategyUpdated:true}');
  });

  it('事务写入原语输入校验与文档分层纪律一致', () => {
    const doc = readContractDoc();
    expect(() =>
      validateUpdateTaskStrategyInput(
        {
          projectId: '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1',
          taskId: 't-1',
          executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          configSource: TASK_STRATEGY_EDIT_CONFIG_SOURCE,
          configSourceKey: TASK_STRATEGY_EDIT_SOURCE_KEY,
          expectedRevision: 1,
          extra: true,
        },
        'docs-check',
      ),
    ).toThrow(/extra/);
    expect(doc).toContain('validateUpdateTaskStrategyInput');
    expect(doc).toContain('getTask');
    expect(doc).toContain('updateTaskStrategy');
  });
});
