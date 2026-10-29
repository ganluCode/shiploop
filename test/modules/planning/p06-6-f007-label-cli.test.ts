/**
 * P06-6 / F-007：四层标签查询 CLI 纯面层（参数解析/帮助/兼容性）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs`/`getAppCliHelp`），不接触真实 Host、
 * SQLite、文件或网络：
 * - phase/feature/task list 扩展可重复 `--label` 与 `--match any|all`，
 *   未提供时解析结果保持既有形状（兼容现有精确断言）；
 * - 新增 `execution runs`（Run 层列表；--feature/--featureId 与 --batch 可选）
 *   与 `project labels` 四层计数模式（--entity + 父级/标签/匹配筛选）；
 * - 非法 match/entity/limit 在解析层拒绝（退出码 2），错误不回显输入值；
 * - 帮助可查且包含关键参数名；顶层命令集合不新增 run/work 顶层命令。
 *
 * 纵向（真实 Host + HostClient + SQLite）见 p06-6-f007-label-cli-vertical.test.ts
 * 与 p06-6-f007-label-host-wiring.test.ts。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMANDS,
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  CLI_START_TIMEOUT_DEFAULT_MS,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';

const PROJECT_ID = randomUUID();

function expectParseError(args: readonly string[], reason: string, field?: string): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(AppCliParseError);
    const parsed = error as AppCliParseError;
    expect(parsed.code).toBe('invalid_input');
    expect(parsed.reason).toBe(reason);
    if (field !== undefined) {
      expect(parsed.field).toBe(field);
    }
    // 错误不回显用户输入值（标签原文不带回）。
    expect(parsed.message).not.toContain('not-a-label-value');
    return parsed;
  }
  throw new Error(`expected parse error ${reason} for args ${JSON.stringify(args)}`);
}

describe('F-007 四层标签查询命令面', () => {
  it('不新增 run/work 顶层命令；新命令身份落在既有顶层内且唯一', () => {
    expect([...APP_CLI_COMMANDS]).not.toContain('run');
    expect([...APP_CLI_COMMANDS]).not.toContain('work');
    for (const id of ['execution.runs', 'project.labels'] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
    }
    expect(new Set(APP_CLI_COMMAND_IDS).size).toBe(APP_CLI_COMMAND_IDS.length);
  });

  it('phase/feature/task list 解析可重复 --label 与 --match；缺省保持既有形状', () => {
    // 兼容：不带标签参数的既有形状不变（精确断言）。
    expect(parseAppCliArgs(['phase', 'list', '--project', PROJECT_ID])).toEqual({
      kind: 'command',
      command: 'phase',
      commandId: 'phase.list',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
    });
    expect(
      parseAppCliArgs([
        'phase', 'list', '--project', PROJECT_ID,
        '--label', ' Alpha ', '--label', 'alpha', '--match', 'all',
        '--limit', '20', '--cursor', 'plcur_v1_abc', '--json',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'phase',
      commandId: 'phase.list',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      labels: [' Alpha ', 'alpha'],
      match: 'all',
      limit: 20,
      cursor: 'plcur_v1_abc',
    });
    expect(
      parseAppCliArgs([
        'feature', 'list', '--project', PROJECT_ID, '--phase', 'phase-main',
        '--label', 'beta', '--match', 'any',
      ]),
    ).toMatchObject({ commandId: 'feature.list', labels: ['beta'], match: 'any' });
    expect(
      parseAppCliArgs([
        'task', 'list', '--project', PROJECT_ID, '--feature', 'feat-1', '--label', 'x',
      ]),
    ).toMatchObject({ commandId: 'task.list', labels: ['x'] });
    // match 缺省为 any（与项目列表一致）。
    expect(
      parseAppCliArgs(['phase', 'list', '--project', PROJECT_ID, '--label', 'x']),
    ).toMatchObject({ labels: ['x'], match: 'any' });
  });

  it('execution runs 解析：--project 必填，--feature/--batch/--label/--match/--limit/--cursor 可选', () => {
    expect(parseAppCliArgs(['execution', 'runs', '--project', PROJECT_ID, '--json'])).toEqual({
      kind: 'command',
      command: 'execution',
      commandId: 'execution.runs',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      labels: [],
      match: 'any',
    });
    expect(
      parseAppCliArgs([
        'execution', 'runs', '--project', PROJECT_ID,
        '--feature', 'feat-1', '--batch', randomUUID(),
        '--label', 'alpha', '--match', 'all', '--limit', '2',
        '--cursor', 'plcur_v1_x',
      ]),
    ).toMatchObject({
      commandId: 'execution.runs',
      featureId: 'feat-1',
      labels: ['alpha'],
      match: 'all',
      limit: 2,
      cursor: 'plcur_v1_x',
    });
    expectParseError(['execution', 'runs'], 'missing_required_option', 'project');
  });

  it('project labels 四层计数模式：--entity 与父级/标签/匹配；缺省保持项目层旧形状', () => {
    // 兼容：无任何参数的旧形状不变。
    expect(parseAppCliArgs(['project', 'labels', '--json'])).toEqual({
      kind: 'command',
      command: 'project',
      commandId: 'project.labels',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
    });
    expect(
      parseAppCliArgs([
        'project', 'labels', '--entity', 'run', '--project', PROJECT_ID,
        '--feature', 'feat-1', '--batch', randomUUID(),
        '--label', 'alpha', '--label', 'beta', '--match', 'all',
      ]),
    ).toMatchObject({
      commandId: 'project.labels',
      entity: 'run',
      projectId: PROJECT_ID,
      featureId: 'feat-1',
      labels: ['alpha', 'beta'],
      match: 'all',
    });
    for (const entity of ['phase', 'feature', 'task']) {
      expect(
        parseAppCliArgs(['project', 'labels', '--entity', entity, '--project', PROJECT_ID]),
      ).toMatchObject({ entity });
    }
    expectParseError(['project', 'labels', '--entity', 'blob', '--project', PROJECT_ID], 'invalid_entity', 'entity');
    expectParseError(['project', 'labels', '--entity', 'phase'], 'missing_required_option', 'project');
    expectParseError(['project', 'labels', '--project', PROJECT_ID, '--label', 'x'], 'unknown_argument');
  });

  it('非法 match/label/limit 在解析层拒绝且不回显输入值', () => {
    for (const args of [
      ['phase', 'list', '--project', PROJECT_ID, '--match', 'some'],
      ['feature', 'list', '--project', PROJECT_ID, '--phase', 'p', '--match', 'ANY'],
      ['execution', 'runs', '--project', PROJECT_ID, '--match', 'mix'],
    ] as const) {
      expectParseError([...args], 'invalid_match', 'match');
    }
    expectParseError(
      ['task', 'list', '--project', PROJECT_ID, '--feature', 'f', '--label', `not-a-label-value-${'x'.repeat(80)}`],
      'invalid_label', 'label',
    );
    expectParseError(
      ['phase', 'list', '--project', PROJECT_ID, '--label', 'x', '--limit', '0'],
      'invalid_limit', 'limit',
    );
  });

  it('帮助可查且包含标签筛选关键参数；不宣称执行/通过', () => {
    for (const scope of ['phase.list', 'feature.list', 'task.list', 'execution.runs', 'project.labels'] as const) {
      const help = getAppCliHelp(scope);
      expect(help.length).toBeGreaterThan(0);
      expect(help.endsWith('\n')).toBe(true);
      expect(help).toContain('usage: shiploop');
      expect(help).toContain('退出码');
    }
    expect(getAppCliHelp('phase.list')).toContain('--label');
    expect(getAppCliHelp('phase.list')).toContain('--match');
    expect(getAppCliHelp('task.list')).toContain('--label');
    expect(getAppCliHelp('execution.runs')).toContain('--batch');
    expect(getAppCliHelp('execution.runs')).toContain('--match');
    expect(getAppCliHelp('project.labels')).toContain('--entity');
    for (const scope of ['execution.runs', 'project.labels'] as const) {
      const help = getAppCliHelp(scope);
      for (const claim of ['已批准', '已通过', '已执行', 'passed', 'Work 已']) {
        expect(help, `${scope} 帮助不得宣称「${claim}」`).not.toContain(claim);
      }
    }
  });
});
