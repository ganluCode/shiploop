/**
 * P03-3 / F-006 文档核验：`docs/p03-3-attempt-budget-contract.md` 记录的 Task
 * 尝试预算预占与分类记账契约必须与仓库实现事实一致（迁移 v11 内容、原语面、
 * 受信边界与错误词汇、命令面不含自报入口），避免「文档另立一套」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { APP_CAPABILITIES, COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';
import {
  TASK_ATTEMPT_CLASSIFICATIONS,
  TASK_ATTEMPT_CLASSIFIED_BY_CORE,
} from '../packages/core/src/ports/execution-store.ts';
import { DEFAULT_TASK_MAX_CODE_ATTEMPTS } from '../packages/core/src/ports/execution-budget.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-3-attempt-budget-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('P03-3 / F-006 Task 尝试预算预占契约文档', () => {
  it('登记于 README 文档索引', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('p03-3-attempt-budget-contract.md');
  });

  it('迁移事实一致：v11 为追加版本且包含 tasks 双计数列与预占账本表', () => {
    const doc = readContractDoc();
    const migrations = SQLITE_MIGRATIONS;
    expect(migrations.at(-1)?.version).toBe(22);
    expect(migrations).toHaveLength(22);
    const v11 = migrations[10];
    expect(v11?.sql).toContain('ALTER TABLE tasks ADD COLUMN attempt_counter');
    expect(v11?.sql).toContain('ALTER TABLE tasks ADD COLUMN code_attempts_used');
    expect(v11?.sql).toContain('CREATE TABLE task_attempt_reservations');
    expect(v11?.sql).toContain("classification IN ('code', 'infrastructure')");
    expect(v11?.sql).toContain("classified_by = 'core'");
    expect(v11?.sql).toContain('task_attempt_reservations_task_attempt_key_unique');
    // 历史迁移不被改写（v1..v10 版本号连续）。
    for (let index = 0; index < 11; index += 1) {
      expect(migrations[index]?.version).toBe(index + 1);
    }
    expect(doc).toContain('迁移 v11');
    expect(doc).toContain('attempt_counter');
    expect(doc).toContain('code_attempts_used');
  });

  it('原语面事实一致：CommandTransaction 暴露五个受信原语', () => {
    const doc = readContractDoc();
    expect(doc).toContain('reserveTaskAttempt');
    expect(doc).toContain('reclassifyTaskAttemptAsInfrastructure');
    expect(doc).toContain('getTaskAttemptReservation');
    expect(doc).toContain('getTaskExecutionCounters');
    expect(doc).toContain('getExecutionRun');
  });

  it('受信边界事实一致：分类定值/枚举与命令面无自报入口', () => {
    const doc = readContractDoc();
    expect(TASK_ATTEMPT_CLASSIFICATIONS).toEqual(['code', 'infrastructure']);
    expect(TASK_ATTEMPT_CLASSIFIED_BY_CORE).toBe('core');
    expect(DEFAULT_TASK_MAX_CODE_ATTEMPTS).toBe(3);
    // Cancellation is authorized control, never client-supplied budget accounting.
    expect(COMMAND_OPERATIONS.filter((operation) => /attempt|reserve|reclassify/i.test(operation)))
      .toEqual(['execution.attempt.cancel']);
    expect(APP_CAPABILITIES.filter((capability) => /attempt|reserve|reclassify/i.test(capability))).toEqual([]);
    expect(doc).toContain('客户端/模型不能自报');
    expect(doc).toContain('P03-4');
    expect(doc).toContain('不允许先提交扣额再');
  });

  it('错误与不变量词汇登记完整', () => {
    const doc = readContractDoc();
    for (const term of [
      'budget_exhausted',
      'attempt_key_reused',
      'batch_not_active',
      'run_not_active',
      'maxTotalAttempts',
      'maxAttemptsPerRun',
      'runTimeLimitMs',
      'maxCodeAttempts',
      'maxAttemptsPerTask',
      '重复分类不重复调账',
      '成功代码尝试不退次数',
    ]) {
      expect(doc, `契约文档必须登记 ${term}`).toContain(term);
    }
  });
});
