/**
 * P03-3 / F-005 文档核验：`docs/p03-3-execution-start-contract.md` 记录的显式
 * 执行启动契约必须与仓库实现事实一致（命令面/能力位、payload 形态、workKey 成分、
 * 拒绝/冲突词汇、回执形态、事件白名单、唤醒与排队原因），避免「文档另立一套」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
  WORK_ACCEPTED_SCHEMA_VERSION,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from '../../../../packages/core/src/ports/commands.ts';
import {
  EXECUTION_RUN_NOT_READY_REASON,
  EXECUTION_RUN_PURPOSE,
  EXECUTION_START_OPERATION,
  EXECUTION_START_REJECTED_REASONS,
  EXECUTION_WORK_KEY_DOMAIN,
  computeExecutionWorkKey,
} from '../../../../packages/core/src/ports/execution-start.ts';
import { EXECUTION_RUN_DISPATCHED_EVENT_TYPE } from '../../../../packages/core/src/ports/execution-store.ts';
import { PUBLIC_STATE_EVENT_TYPES, STATE_EVENT_TYPE_SPECS } from '../../../../packages/core/src/ports/events.ts';
import { EXECUTION_START_IMPACT } from '../../../../packages/core/src/application/execution-start.ts';
import { APPLICATION_COMMAND_CAPABILITIES } from '../../../../packages/host/src/contract/lifecycle.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT_DOC_PATH = 'docs/p03-3-execution-start-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-3 / F-005 显式执行启动契约文档', () => {
  it('登记于 README 文档索引', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8');
    expect(readme).toContain('p03-3-execution-start-contract.md');
  });

  it('命令面与授权事实一致：操作白名单、能力位、Host 接线宣告、线版本不变', () => {
    const doc = readContractDoc();
    expect(COMMAND_OPERATIONS).toContain(EXECUTION_START_OPERATION);
    expect(COMMAND_OPERATION_SPECS['execution.start']).toEqual({
      scopeKind: 'project',
      mutation: 'create',
      capability: 'execution.start',
    });
    expect(APP_CAPABILITIES).toContain('execution.start');
    // Host 通用命令路由接线宣告与 Core 白名单一致（v5 内增量，升版随 F-011 评估）。
    expect([...APPLICATION_COMMAND_CAPABILITIES]).toEqual([...COMMAND_OPERATIONS]);
    expect(WIRE_MESSAGE_SCHEMA_VERSION).toBe(5);
    expect(doc).toContain('execution.start');
    expect(doc).toContain('与 `execution.preview` 共享');
  });

  it('拒绝/冲突词汇与实现冻结面一致', () => {
    const doc = readContractDoc();
    for (const reason of EXECUTION_START_REJECTED_REASONS) {
      expect(doc).toContain(`\`${reason}\``);
    }
    expect(doc).toContain('`execution_in_progress`');
    expect(doc).toContain('`baseline_in_progress`');
    expect(doc).toContain('`empty_scope`');
    expect(doc).toContain('`multi_feature_scope_unsupported`');
    expect(doc).toContain('`invalid_budget`');
    // 退役词汇不再宣称（F-003 契约预期的后续接线已落地）。
    expect(doc).not.toContain('work_command_not_wired');
  });

  it('workKey 契约：领域前缀、用途常量与纯函数确定性（代码/预算不参与）', () => {
    const doc = readContractDoc();
    expect(doc).toContain('computeExecutionWorkKey');
    const base = {
      featureId: 'feature-1',
      purpose: EXECUTION_RUN_PURPOSE,
      planDigest: 'a'.repeat(64),
      inputs: [
        { artifactId: 'art-2', version: 1, contentHash: 'c'.repeat(64), sizeBytes: 1 },
        { artifactId: 'art-1', version: 2, contentHash: 'b'.repeat(64), sizeBytes: 2 },
      ],
    };
    const first = computeExecutionWorkKey(base);
    expect(computeExecutionWorkKey(base)).toBe(first);
    // 输入排序稳定性。
    expect(
      computeExecutionWorkKey({ ...base, inputs: [...base.inputs].reverse() }),
    ).toBe(first);
    // 计划摘要变化 → 新工作。
    expect(
      computeExecutionWorkKey({ ...base, planDigest: 'd'.repeat(64) }),
    ).not.toBe(first);
    expect(EXECUTION_WORK_KEY_DOMAIN).toBe('shiploop:execution-work-key:v1');
  });

  it('回执形态事实：首次 Work accepted v6（operationId=batchId）、重试 completed v5', () => {
    const doc = readContractDoc();
    expect(WORK_ACCEPTED_SCHEMA_VERSION).toBe(6);
    expect(doc).toContain('operationId=batchId');
    expect(doc).toContain('completed v5');
    expect(doc).toContain('runtimeExecution:false');
  });

  it('事件白名单事实：execution.run.dispatched、聚合 run、恒定脱敏 payload', () => {
    const doc = readContractDoc();
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(EXECUTION_RUN_DISPATCHED_EVENT_TYPE);
    expect(STATE_EVENT_TYPE_SPECS[EXECUTION_RUN_DISPATCHED_EVENT_TYPE]).toEqual({
      aggregateType: 'run',
      scopeKind: 'project',
      payloadKind: 'executionRunDispatched',
    });
    expect(doc).toContain('execution.run.dispatched');
    expect(doc).toContain('{dispatched:true}');
  });

  it('排队原因与影响面事实：scheduler_not_assembled、runtime_starts 恒 0', () => {
    const doc = readContractDoc();
    expect(EXECUTION_RUN_NOT_READY_REASON).toBe('scheduler_not_assembled');
    expect(doc).toContain('scheduler_not_assembled');
    expect(EXECUTION_START_IMPACT.startsRuntimeGitOrChecks).toBe(false);
    expect(EXECUTION_START_IMPACT.keepsRuntimeStartsZero).toBe(true);
    expect(EXECUTION_START_IMPACT.changesPlanEntities).toBe(false);
    expect(EXECUTION_START_IMPACT.incrementsRunsCreated).toBe(true);
  });
});
