/**
 * P03-3 / F-007 文档核验：`docs/p03-3-runtime-start-contract.md` 记录的 Runtime
 * 启动额度预占契约必须与仓库实现事实一致（迁移 v12 内容、原语面、受信边界与
 * 错误词汇、命令面不含自报入口、启动失败保守计数无退额），避免「文档另立一套」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { APP_CAPABILITIES, COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-3-runtime-start-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('P03-3 / F-007 Runtime 启动额度预占契约文档', () => {
  it('登记于 README 文档索引', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('p03-3-runtime-start-contract.md');
  });

  it('迁移事实一致：v12 为追加版本且包含启动预占账本表（幂等身份/外键链/无用量列）', () => {
    const doc = readContractDoc();
    const migrations = SQLITE_MIGRATIONS;
    expect(migrations.at(-1)?.version).toBe(25);
    expect(migrations).toHaveLength(25);
    const v12 = migrations[11];
    expect(v12?.sql).toContain('CREATE TABLE runtime_start_reservations');
    expect(v12?.sql).toContain('runtime_start_reservations_project_start_key_unique');
    expect(v12?.sql).toContain('ON DELETE RESTRICT');
    expect(v12?.sql).not.toContain('token_used');
    expect(v12?.sql).not.toContain('sdk_started');
    // 历史迁移不被改写（v1..v11 版本号连续）。
    for (let index = 0; index < 11; index += 1) {
      expect(migrations[index]?.version).toBe(index + 1);
    }
    expect(doc).toContain('迁移 v12');
    expect(doc).toContain('runtime_start_reservations');
  });

  it('原语面事实一致：CommandTransaction 暴露两个受信原语且无退额原语', () => {
    const doc = readContractDoc();
    expect(doc).toContain('reserveRuntimeStart');
    expect(doc).toContain('getRuntimeStartReservation');
    expect(doc).toContain('不提供任何');
    expect(doc).toContain('退额原语');
  });

  it('受信边界事实一致：命令面无自报入口、普通测试不调用 Pi/网络/模型', () => {
    const doc = readContractDoc();
    expect(COMMAND_OPERATIONS.filter((operation) => /runtime.?start|reserve/i.test(operation))).toEqual([]);
    expect(APP_CAPABILITIES.filter((capability) => /runtime.?start|reserve/i.test(capability))).toEqual([]);
    expect(doc).toContain('不经命令路由暴露');
    expect(doc).toContain('不调用 Pi、网络或模型');
    expect(doc).toContain('不实现 Runner、停止管理、会话记录');
  });

  it('错误与不变量词汇登记完整', () => {
    const doc = readContractDoc();
    for (const term of [
      'budget_exhausted',
      'maxRuntimeStarts',
      'deadlineUtcMs',
      'start_key_reused',
      'batch_not_active',
      'run_not_active',
      '保守保留一次启动计数',
      '不清空占用',
      '不假称进程已停止',
      '不重复计数',
      '不增加 runtimeStarts',
    ]) {
      expect(doc, `契约文档必须登记 ${term}`).toContain(term);
    }
  });
});
