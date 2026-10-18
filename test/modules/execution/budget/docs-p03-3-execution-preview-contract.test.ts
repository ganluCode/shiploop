/**
 * P03-3 / F-004 文档核验：`docs/p03-3-execution-preview-contract.md` 记录的执行
 * 预览契约必须与仓库实现事实一致（命令面/能力位、范围语义、状态与原因词汇、
 * 编排顺序、previewDigest 成分、结果边界），避免「文档另立一套」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from '../../../../packages/core/src/ports/commands.ts';
import {
  ACTIVE_EXECUTION_STATUSES,
  EXECUTION_PREVIEW_BLOCKED_REASON_KINDS,
  EXECUTION_PREVIEW_DIGEST_DOMAIN,
  EXECUTION_PREVIEW_NO_WORK_REASONS,
  EXECUTION_PREVIEW_OPERATION,
  EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES,
  EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION,
} from '../../../../packages/core/src/ports/execution-preview.ts';
import { EXECUTION_PREVIEW_IMPACT } from '../../../../packages/core/src/application/execution-preview.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT_DOC_PATH = 'docs/p03-3-execution-preview-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-3 / F-004 执行预览契约文档', () => {
  it('命令面与授权事实一致：操作白名单、能力位、Host 接线宣告', () => {
    const doc = readContractDoc();
    expect(COMMAND_OPERATIONS).toContain(EXECUTION_PREVIEW_OPERATION);
    expect(COMMAND_OPERATION_SPECS['execution.preview']).toEqual({
      scopeKind: 'project',
      mutation: 'create',
      capability: 'execution.start',
    });
    expect(APP_CAPABILITIES).toContain('execution.start');
    expect(doc).toContain('`execution.preview`');
    expect(doc).toContain('`execution.start`');
    expect(doc).toContain('packages/core/src/ports/commands.ts');
    expect(doc).toContain('packages/host/src/contract/lifecycle.ts');
    // 线消息版本维持 5（v5 内增量；升版随 HostClient/CLI 接线任务评估）。
    expect(WIRE_MESSAGE_SCHEMA_VERSION).toBe(5);
    expect(doc).toContain('v5 内增量');
  });

  it('范围与状态词汇和 ports 冻结常量一致', () => {
    const doc = readContractDoc();
    expect(EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION).toBe(1);
    expect([...EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES]).toEqual(['pending', 'failed']);
    expect([...EXECUTION_PREVIEW_NO_WORK_REASONS]).toEqual(['empty_scope', 'no_pending_tasks']);
    for (const kind of EXECUTION_PREVIEW_BLOCKED_REASON_KINDS) {
      expect(doc, `文档必须记录阻塞原因 ${kind}`).toContain(`\`${kind}\``);
    }
    expect([...ACTIVE_EXECUTION_STATUSES]).toEqual([
      'queued',
      'running',
      'pausing',
      'paused',
      'cancelling',
      'interrupted',
    ]);
    expect(doc).toContain('`empty_scope`');
    expect(doc).toContain('`multi_feature_scope_unsupported`');
    expect(doc).toContain('不自动加入');
    expect(doc).toContain('不静默截断');
  });

  it('previewDigest 域前缀与身份成分记录一致；结果边界不宣称 Runtime 能力', () => {
    const doc = readContractDoc();
    expect(EXECUTION_PREVIEW_DIGEST_DOMAIN).toBe('shiploop:execution-preview:v1');
    expect(doc).toContain('shiploop:execution-preview:v1');
    for (const identityPart of [
      'computeExecutionStrategyCopyDigest',
      'computeFeatureCheckPolicyDigest',
      'computeExecutionPermissionsDigest',
    ]) {
      expect(doc).toContain(identityPart);
    }
    expect(EXECUTION_PREVIEW_IMPACT.runtimeExecutionClaimed).toBe(false);
    expect(EXECUTION_PREVIEW_IMPACT.createsExecutionEntities).toBe(false);
    expect(EXECUTION_PREVIEW_IMPACT.reservesOrSpendsBudget).toBe(false);
    expect(EXECUTION_PREVIEW_IMPACT.startsRuntimeGitOrChecks).toBe(false);
    expect(EXECUTION_PREVIEW_IMPACT.loadsUnselectedGlobalResources).toBe(false);
    expect(doc).toContain('`runtimeExecution` 恒 `false`');
    expect(doc).toContain('preview_stale');
    expect(doc).toContain('RECEIPT_RESULT_MAX_BYTES');
  });

  it('编排顺序与受控端口复用记录一致；范围边界不提前实现启动/调度', () => {
    const doc = readContractDoc();
    expect(doc).toContain('授权先于仓库或制品 I/O');
    expect(doc).toContain('RepositoryInspector');
    expect(doc).toContain('BaselineWorkspaceReader');
    expect(doc).toContain('readExecutionPreviewView');
    expect(doc).toContain('单一 DEFERRED 读事务');
    // 范围边界：启动命令/预算预占/HostClient/CLI 属后续任务。
    expect(doc).toContain('F-005');
    expect(doc).toContain('HostClient/CLI');
    expect(doc).toContain('P05 多 Feature');
    // 权威实现与守护测试路径必须可解析。
    for (const path of [
      'packages/core/src/ports/execution-preview.ts',
      'packages/core/src/application/execution-preview.ts',
      'packages/core/src/adapters/sqlite/plan-store.ts',
      'packages/core/src/adapters/composition.ts',
      'test/modules/execution/budget/p03-3-execution-preview.test.ts',
      'test/modules/execution/budget/docs-p03-3-execution-preview-contract.test.ts',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path)), `文档引用路径必须存在：${path}`).toBe(true);
    }
  });
});
