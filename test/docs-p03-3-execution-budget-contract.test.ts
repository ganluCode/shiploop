/**
 * P03-3 / F-001 文档核验：`docs/p03-3-execution-budget-contract.md` 记录的执行预算
 * 契约必须与仓库实现事实一致（前序核对记录、分层校验词汇与 reason 码、数值范围、
 * maxCodeAttempts 兼容规则、配置版本决策、Task 快照捕获路径、并发授权规则与
 * 纯预算判定语义），避免「文档另立一套」与后续任务（F-002..F-012）各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_NO_PROGRESS_RUNS_MAX,
  BATCH_MAX_RUNS_MAX,
  BATCH_MAX_RUNTIME_STARTS_MAX,
  BATCH_MAX_TOTAL_ATTEMPTS_MAX,
  BUDGET_SNAPSHOT_SCHEMA_VERSION,
  DEFAULT_TASK_MAX_CODE_ATTEMPTS,
  resolveTaskAttemptCaps,
  RUN_MAX_ATTEMPTS_MAX,
  RUN_TIME_LIMIT_MS_MAX,
  TASK_MAX_CODE_ATTEMPTS_MAX,
  validateExecutionBudgetSnapshot,
} from '../packages/core/src/ports/execution-budget.ts';
import { StorageError } from '../packages/core/src/ports/errors.ts';
import type { ValidationContext } from '../packages/core/src/ports/validation.ts';
import {
  SETTINGS_SCHEMA_VERSION,
  validateSettingsPayload,
} from '../packages/core/src/ports/settings-schema.ts';
import {
  assertSingleWorkConcurrencyAuthorization,
  EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT,
} from '../packages/core/src/application/execution-authorization-policy.ts';
import { selectTaskStrategy } from '../packages/core/src/application/task-strategy-selection.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-3-execution-budget-contract.md';
const CONTEXT: ValidationContext = { operation: 'DocsP033ExecutionBudgetContract.test' };

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-3 / F-001 执行预算契约文档', () => {
  it('前序核对记录与仓库事实一致：迁移到 v8（F-002 接续 v9）、main 基线 0e76ad8、未重建计划导入/审批', () => {
    const doc = readContractDoc();
    const versions = SQLITE_MIGRATIONS.map((migration) => migration.version);
    // §1 开工事实为 v1..v8（原文保留）；P03-3 / F-002 接续 v9 并在 §1 登记。
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(doc).toContain('v1..v8');
    expect(doc).toContain('v9');
    expect(doc).toContain('0e76ad8');
    expect(doc).toContain('不重建计划导入\n  或审批');
    expect(doc).toContain('前序未缺失、未发现契约冲突');
  });

  it('分层词汇与数值范围和实现常量一致', () => {
    const doc = readContractDoc();
    expect(DEFAULT_TASK_MAX_CODE_ATTEMPTS).toBe(3);
    expect(BUDGET_SNAPSHOT_SCHEMA_VERSION).toBe(1);
    expect(doc).toContain(`maxRuns\` 1..1 000`);
    expect(doc).toContain(`${BATCH_MAX_TOTAL_ATTEMPTS_MAX / 1000} 000`);
    expect(BATCH_MAX_TOTAL_ATTEMPTS_MAX).toBe(100_000);
    expect(BATCH_MAX_RUNTIME_STARTS_MAX).toBe(100_000);
    expect(BATCH_MAX_RUNS_MAX).toBe(1_000);
    expect(BATCH_MAX_NO_PROGRESS_RUNS_MAX).toBe(1_000);
    expect(RUN_MAX_ATTEMPTS_MAX).toBe(100);
    expect(RUN_TIME_LIMIT_MS_MAX).toBe(604_800_000);
    expect(TASK_MAX_CODE_ATTEMPTS_MAX).toBe(100);
    expect(doc).toContain('maxTokenTotal` 正安全整数');
    expect(doc).toContain('maxCostTotal` 有限正数');
  });

  it('快照版本门槛与实现一致（schemaVersion=1；未知版本拒绝）', () => {
    const doc = readContractDoc();
    expect(doc).toContain('BUDGET_SNAPSHOT_SCHEMA_VERSION');
    const valid = { schemaVersion: 1, batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: 2 }, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 1_000 } };
    expect(validateExecutionBudgetSnapshot(valid, CONTEXT).schemaVersion).toBe(1);
    expect(() => validateExecutionBudgetSnapshot({ ...valid, schemaVersion: 2 }, CONTEXT)).toThrow(StorageError);
  });

  it('maxCodeAttempts 兼容规则词汇与实现一致（默认含首次共三次；min 解析与 rule 标记）', () => {
    const doc = readContractDoc();
    expect(doc).toContain('含首次共三次');
    expect(doc).toContain('总 Attempt 上限');
    for (const rule of ['code_cap_only', 'total_cap_binds', 'code_cap_binds', 'equal'] as const) {
      expect(doc).toContain(rule);
      expect(resolveTaskAttemptCaps({ maxCodeAttempts: 2, maxAttemptsPerTask: 2 }, CONTEXT).rule).toBeTruthy();
    }
    expect(resolveTaskAttemptCaps({}, CONTEXT)).toMatchObject({
      maxCodeAttempts: 3,
      maxAttemptsPerTask: null,
      effectiveMaxCodeAttempts: 3,
    });
    expect(resolveTaskAttemptCaps({ maxAttemptsPerTask: 2 }, CONTEXT).effectiveMaxCodeAttempts).toBe(2);
  });

  it('配置版本决策与实现一致：schemaVersion 维持 2；新政策键可存可校；旧 payload 不变', () => {
    const doc = readContractDoc();
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    expect(doc).toContain('schemaVersion 维持 2');
    const legacy = { schemaVersion: 2, policies: { executionLimits: { maxAttemptsPerTask: 2 } } };
    expect(validateSettingsPayload(legacy, CONTEXT)).toEqual(legacy);
    const explicit = { schemaVersion: 2, policies: { executionLimits: { maxCodeAttempts: 4 } } };
    expect(validateSettingsPayload(explicit, CONTEXT)).toEqual(explicit);
    expect(() => validateSettingsPayload({ schemaVersion: 3, policies: { executionLimits: { maxCodeAttempts: 4 } } }, CONTEXT)).toThrow(StorageError);
  });

  it('Task 快照捕获路径与文档一致：配置了才捕获；未配置不注入字段', () => {
    const doc = readContractDoc();
    expect(doc).toContain('配置了才捕获');
    const strategy = { runtime: 'pi', provider: 'anthropic', model: 'm' };
    const captured = selectTaskStrategy({
      global: {
        scopeRevision: 1,
        payload: { schemaVersion: 2, strategies: { defaultStrategy: strategy }, policies: { executionLimits: { maxCodeAttempts: 5 } } },
      },
    });
    expect(captured.executionConfig.maxCodeAttempts).toBe(5);
    const absent = selectTaskStrategy({
      global: { scopeRevision: 1, payload: { schemaVersion: 2, strategies: { defaultStrategy: strategy } } },
    });
    expect(absent.executionConfig).not.toHaveProperty('maxCodeAttempts');
  });

  it('并发授权规则与实现一致：缺省单并发；有效并发大于一结构化拒绝', () => {
    const doc = readContractDoc();
    expect(EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT).toBe(1);
    expect(doc).toContain('concurrency_not_supported');
    expect(doc).toContain('保存政策不等于\n  执行支持');
    expect(() => assertSingleWorkConcurrencyAuthorization({})).not.toThrow();
    let rejected: StorageError | undefined;
    try {
      assertSingleWorkConcurrencyAuthorization({
        executionLimits: { value: { maxConcurrentWorks: 2 }, source: { kind: 'global_default', scopeRevision: 1, sourceKey: 'policies.executionLimits' } },
      });
    } catch (error) {
      rejected = error as StorageError;
    }
    expect(rejected?.details?.reason).toBe('concurrency_not_supported');
  });

  it('纯预算判定语义与守护测试文件登记一致', () => {
    const doc = readContractDoc();
    expect(doc).toContain('deadline_reached');
    expect(doc).toContain('unconfirmedDimensions');
    expect(doc).toContain('不用零费用证明仍有额度');
    expect(doc).toContain('p03-3-execution-budget.test.ts');
    expect(doc).toContain('p03-3-budget-policy-config.test.ts');
    expect(doc).toContain('check:boundaries');
  });
});
