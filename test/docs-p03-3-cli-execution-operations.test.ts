/**
 * P03-3 / F-012 文档核验：`docs/p03-3-cli-execution-operations.md` 的 CLI 操作
 * 说明必须与实现事实一致（命令面、预算参数映射、四态结构化输出、失败退出、
 * accepted 语义与恢复语义），且示例只使用脱敏逻辑身份，避免文档另立一套。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_CLI_COMMAND_IDS, getAppCliHelp } from '../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = 'docs/p03-3-cli-execution-operations.md';

function readDoc(): string {
  const path = resolve(REPO_ROOT, DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function readSource(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

describe('P03-3 / F-012 执行授权 CLI 操作说明文档', () => {
  it('命令面与实现一致（四个子命令/命令身份/Core 操作同源）', () => {
    const doc = readDoc();
    for (const id of [
      'execution.preview',
      'execution.start',
      'execution.budget',
      'execution.revise',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
      expect(doc).toContain(`\`${id}\``);
    }
    for (const operation of ['execution.preview', 'execution.start', 'execution.budget.revise']) {
      expect(doc).toContain(operation);
      // 文档声称的命令操作必须真实存在于 Core 命令面。
      expect(readSource('packages/core/src/ports/commands.ts')).toContain(`'${operation}'`);
    }
    for (const cli of [
      'shiploop execution preview',
      'shiploop execution start',
      'shiploop execution budget',
      'shiploop execution revise',
    ]) {
      expect(doc).toContain(cli);
    }
  });

  it('失败词汇与实现同源（preview_stale/budget_exhausted/budget_revision_stale/参数校验 reason）', () => {
    const doc = readDoc();
    const startSource = readSource('packages/core/src/application/execution-start.ts');
    const reviseSource = readSource('packages/core/src/application/execution-budget-revise.ts');
    const argsSource = readSource('packages/cli/src/app/args.ts');
    const executionSource = readSource('packages/cli/src/app/execution.ts');
    expect(doc).toContain('preview_stale');
    expect(startSource).toContain("'preview_stale'");
    expect(doc).toContain('budget_exhausted');
    expect(startSource).toContain("'budget_exhausted'");
    expect(doc).toContain('budget_revision_stale');
    expect(reviseSource).toContain("'budget_revision_stale'");
    expect(doc).toContain('missing_budget');
    expect(argsSource).toContain('missing_budget');
    expect(doc).toContain('concurrency_not_supported');
    expect(executionSource).toContain('concurrency_not_supported');
    expect(doc).toContain('confirmation_required');
    expect(argsSource).toContain('confirmation_required');
    expect(doc).toContain('conflicting_options');
    expect(argsSource).toContain('conflicting_options');
    expect(doc).toContain('invalid_budget_date');
    expect(executionSource).toContain('invalid_budget_date');
  });

  it('四态输出与 accepted 语义：提交成功不冒充 Feature 验收通过、未知用量不填零', () => {
    const doc = readDoc();
    for (const state of ['not_executed', 'budget_exhausted', 'business_completed']) {
      expect(doc).toContain(state);
    }
    expect(doc).toContain('尚未执行');
    expect(doc).toContain('预算耗尽');
    expect(doc).toContain('业务完成');
    expect(doc).toContain('accepted 只是提交成功');
    expect(doc).toContain('不被描述为 Feature 已验收通过');
    expect(doc).toContain('不填零');
    expect(doc).toMatch(/退出码[^\n]*0\/1\/2\/3/);
    // 帮助文本与文档同一纪律。
    const startHelp = getAppCliHelp('execution.start');
    expect(startHelp).toContain('accepted');
    expect(startHelp).toContain('不代表');
    expect(startHelp).toContain('--confirm');
    expect(getAppCliHelp('execution.preview')).toContain('不是授权');
  });

  it('示例只使用脱敏逻辑身份与引用（无真实路径/秘密/凭据）', () => {
    const doc = readDoc();
    expect(doc).not.toMatch(/\/Users\//);
    expect(doc).not.toMatch(/\/home\//);
    expect(doc).not.toMatch(/\/private\/var\//);
    expect(doc).not.toContain('sk-secret-value');
    expect(doc).not.toContain('keychain://');
    expect(doc).not.toContain('Bearer');
  });
});
