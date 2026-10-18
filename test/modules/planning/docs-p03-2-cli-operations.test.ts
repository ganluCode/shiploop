/**
 * P03-2 / F-008 文档核验：`docs/p03-2-cli-approval-input-operations.md` 的 CLI
 * 操作说明必须与实现事实一致（命令面、参数、结构化输出、失败退出、恢复语义），
 * 且示例只使用脱敏逻辑身份（不含真实路径/秘密），避免文档另立一套。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_CLI_COMMAND_IDS, getAppCliHelp } from '../../../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC_PATH = 'docs/p03-2-cli-approval-input-operations.md';

function readDoc(): string {
  const path = resolve(REPO_ROOT, DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function readSource(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

describe('P03-2 / F-008 CLI 操作说明文档', () => {
  it('命令面与实现一致（五个子命令/命令身份/Core 操作同源）', () => {
    const doc = readDoc();
    for (const id of [
      'feature.approve',
      'feature.reject',
      'task.strategy',
      'task.prepare',
      'task.inputs',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
      expect(doc).toContain(`\`${id}\``);
    }
    for (const operation of ['feature.plan.decide', 'task.strategy.update', 'execution.input.prepare']) {
      expect(doc).toContain(operation);
      // 文档声称的操作必须真实存在于 Core 命令面。
      expect(readSource('packages/core/src/ports/commands.ts')).toContain(`'${operation}'`);
    }
    for (const cli of [
      'shiploop feature approve',
      'shiploop feature reject',
      'shiploop task strategy',
      'shiploop task prepare',
      'shiploop task inputs',
    ]) {
      expect(doc).toContain(cli);
    }
  });

  it('失败词汇与实现同源（摘要绑定/重复决定/回执错配/秘密字段/空清单）', () => {
    const doc = readDoc();
    const decideSource = readSource('packages/core/src/application/feature-plan-decide.ts');
    const inputSource = readSource('packages/core/src/application/execution-input.ts');
    const argsSource = readSource('packages/cli/src/app/args.ts');
    const executeSource = readSource('packages/cli/src/app-execute.ts');
    expect(doc).toContain('plan_digest_mismatch');
    expect(decideSource).toContain("'plan_digest_mismatch'");
    expect(doc).toContain('approval_already_decided');
    expect(decideSource).toContain("'approval_already_decided'");
    expect(doc).toContain('receipt_operation_mismatch');
    expect(executeSource).toContain("'receipt_operation_mismatch'");
    expect(doc).toContain('input_secret_field_rejected');
    expect(argsSource).toContain('input_secret_field_rejected');
    expect(doc).toContain('empty_items');
    expect(inputSource).toContain("'empty_items'");
  });

  it('退出码与输出纪律：未启动执行/未知执行能力不显示为可运行、正文永不内联', () => {
    const doc = readDoc();
    expect(doc).toContain('未启动执行');
    expect(doc).toContain('未知执行能力不显示为可运行');
    expect(doc).toContain('正文永不内联');
    expect(doc).toMatch(/退出码[^\n]*0\/1\/2\/3/);
    // 帮助文本与文档同一纪律。
    for (const scope of ['feature.approve', 'feature.reject'] as const) {
      const help = getAppCliHelp(scope);
      expect(help).toContain('未启动执行');
      expect(help).toContain('未知执行能力不显示为可运行');
    }
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
