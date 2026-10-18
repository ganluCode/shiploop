/**
 * P03-5 / F-012 文档核验：`docs/p03-5-cli-workspace-operations.md` 的 CLI 操作
 * 说明必须与实现事实一致（命令面、Core 操作同源、状态分类、失败词汇、边界
 * 声明与帮助文本），且示例只使用脱敏逻辑身份，避免文档另立一套。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_CLI_COMMAND_IDS, getAppCliHelp } from '../../../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC_PATH = 'docs/p03-5-cli-workspace-operations.md';

function readDoc(): string {
  const path = resolve(REPO_ROOT, DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function readSource(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf8');
}

describe('P03-5 / F-012 工作区 CLI 操作说明文档', () => {
  it('命令面与实现一致（六个子命令/命令身份/Core 操作同源）', () => {
    const doc = readDoc();
    for (const id of [
      'workspace.list',
      'workspace.get',
      'workspace.operations',
      'workspace.operation',
      'workspace.discard-preview',
      'workspace.discard',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
      expect(doc).toContain(`\`${id}\``);
    }
    for (const operation of [
      'workspaces.list',
      'workspaces.get',
      'workspace.operations.list',
      'workspace.operations.get',
      'workspace.discard.preview',
      'workspace.discard',
    ]) {
      expect(doc).toContain(operation);
    }
    // 文档声称的命令操作必须真实存在于 Core 命令面/查询面。
    const commandsSource = readSource('packages/core/src/ports/commands.ts');
    expect(commandsSource).toContain("'workspace.discard'");
    expect(commandsSource).toContain("'workspace.discard.preview'");
    const querySource = readSource('packages/core/src/ports/workspace-query.ts');
    for (const operation of [
      'workspaces.list',
      'workspaces.get',
      'workspace.operations.list',
      'workspace.operations.get',
    ]) {
      expect(querySource).toContain(`'${operation}'`);
    }
    for (const cli of [
      'shiploop workspace list',
      'shiploop workspace get',
      'shiploop workspace operations',
      'shiploop workspace operation',
      'shiploop workspace discard-preview',
      'shiploop workspace discard',
    ]) {
      expect(doc).toContain(cli);
    }
  });

  it('失败词汇与实现同源（本地拒绝与服务端拒绝）', () => {
    const doc = readDoc();
    const argsSource = readSource('packages/cli/src/app/args.ts');
    const workspaceSource = readSource('packages/cli/src/app/workspace.ts');
    expect(doc).toContain('confirmation_required');
    expect(argsSource).toContain('confirmation_required');
    expect(doc).toContain('missing_required_option');
    expect(doc).toContain('invalid_preview_file');
    expect(argsSource).toContain('invalid_preview_file');
    expect(doc).toContain('preview_feature_mismatch');
    expect(workspaceSource).toContain('preview_feature_mismatch');
    expect(doc).toContain('invalid_cursor');
    expect(doc).toContain('not_found');
    expect(doc).toContain('conflict');
    expect(doc).toContain('outcome_unknown');
  });

  it('状态分类、不交付声明与帮助文本同源', () => {
    const doc = readDoc();
    for (const state of [
      'preparing',
      'prepared',
      'retained',
      'quarantined',
      'cleanable',
      'cleaned',
    ]) {
      expect(doc).toContain(state);
    }
    expect(doc).toContain('featureVerified=false');
    expect(doc).toContain('completed 不等于丢弃成功');
    expect(doc).toContain('可信项目模式不提供强 OS 隔离');
    expect(doc).toContain('失败默认保留');
    expect(doc).toContain('尚无完整 Runtime/提交闭环');
    const help = getAppCliHelp('workspace.discard');
    expect(help).toContain('completed 不等于丢弃成功');
    expect(help).toContain('强 OS 隔离');
    expect(help).toContain('失败默认保留');
    expect(help).toContain('尚无完整 Runtime/提交闭环');
  });

  it('示例只使用脱敏逻辑身份，不含开发机路径或真实凭据', () => {
    const doc = readDoc();
    expect(doc).not.toContain('/Users/');
    expect(doc).not.toContain('Authorization');
  });
});
