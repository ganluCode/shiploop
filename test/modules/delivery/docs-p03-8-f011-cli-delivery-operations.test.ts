/**
 * P03-8 / F-011 文档核验：`docs/p03-8-f011-cli-delivery-operations.md` 的
 * CLI 操作说明必须与实现事实一致（命令面、Core 操作同源、状态折算、失败
 * 词汇、边界声明与帮助文本），且示例只使用脱敏逻辑身份，避免文档另立一套。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_CLI_COMMAND_IDS, getAppCliHelp } from '../../../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC_PATH = 'docs/p03-8-f011-cli-delivery-operations.md';

function readDoc(): string {
  const path = resolve(REPO_ROOT, DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function readSource(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

describe('P03-8 / F-011 Feature 交付 CLI 操作说明文档', () => {
  it('命令面与实现一致（五个子命令/命令身份/Core 操作同源）', () => {
    const doc = readDoc();
    for (const id of [
      'feature.delivery',
      'feature.final-approve',
      'feature.finalize',
      'git.operations',
      'git.operation',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
      expect(doc).toContain(`\`${id}\``);
    }
    for (const operation of [
      'features.delivery.get',
      'git.operations.list',
      'git.operations.get',
      'task.approval.approve',
      'feature.verification.continue',
    ]) {
      expect(doc).toContain(operation);
    }
    // 文档声称的 Core 操作真实存在于 Core 命令面/查询面。
    const commandsSource = readSource('packages/core/src/ports/commands.ts');
    expect(commandsSource).toContain("'task.approval.approve'");
    expect(commandsSource).toContain("'feature.verification.continue'");
    const gitQuerySource = readSource('packages/core/src/ports/git-operation-query.ts');
    expect(gitQuerySource).toContain("'git.operations.list'");
    expect(gitQuerySource).toContain("'git.operations.get'");
    const deliveryQuerySource = readSource('packages/core/src/ports/feature-delivery-query.ts');
    expect(deliveryQuerySource).toContain("'features.delivery.get'");
    for (const cli of [
      'shiploop feature delivery',
      'shiploop feature final-approve',
      'shiploop feature finalize',
      'shiploop git operations',
      'shiploop git operation',
    ]) {
      expect(doc).toContain(cli);
    }
  });

  it('失败词汇与实现同源（本地拒绝与服务端拒绝）', () => {
    const doc = readDoc();
    const argsSource = readSource('packages/cli/src/app/args.ts');
    expect(doc).toContain('confirmation_required');
    expect(argsSource).toContain('confirmation_required');
    expect(doc).toContain('missing_required_option');
    expect(doc).toContain('conflicting_options');
    expect(doc).toContain('invalid_operation_id');
    expect(argsSource).toContain('invalid_operation_id');
    expect(doc).toContain('unknown_argument');
    expect(doc).toContain('invalid_cursor');
    expect(doc).toContain('not_found');
    expect(doc).toContain('conflict');
    expect(doc).toContain('unsupported');
  });

  it('状态折算与边界声明同帮助文本一致', () => {
    const doc = readDoc();
    // 非完成绝不显示为 completed/已提交。
    for (const vocabulary of [
      'final_verification_failed',
      'awaiting_approval',
      'delivery_uncertain',
      'no_change',
      'completed=false',
      'committed=false',
      'delivered',
    ]) {
      expect(doc).toContain(vocabulary);
    }
    expect(doc).toContain('批准不自动运行');
    expect(doc).toContain('保留现场');
    expect(doc).toContain('获准');
    expect(doc).toContain('不打开 SQLite');
    expect(doc).toContain('不直接执行 Git');
    const finalizeHelp = getAppCliHelp('feature.finalize');
    expect(finalizeHelp).toContain('不自动');
    expect(finalizeHelp).toContain('保留现场');
    expect(finalizeHelp).toContain('获准');
    expect(getAppCliHelp('feature.final-approve')).toContain('不自动运行');
    expect(getAppCliHelp('git.operations')).toContain('不直接执行 Git');
    // 不添加 P03-9 新 Run 收尾重试控制。
    expect(doc).toContain('P03-9');
    expect(doc).not.toContain('--retry-batch');
  });

  it('示例只使用脱敏逻辑身份，不含开发机路径或真实凭据', () => {
    const doc = readDoc();
    expect(doc).not.toContain('/Users/');
    expect(doc).not.toContain('/home/');
    expect(doc).not.toContain('Authorization');
    expect(doc).not.toMatch(/Bearer\s+[0-9a-zA-Z]/);
  });
});
