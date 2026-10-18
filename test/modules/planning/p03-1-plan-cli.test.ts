/**
 * P03-1 / F-010 计划 CLI 纯面层（参数解析/帮助/不宣称纪律）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs`/`getAppCliHelp`），不接触真实 Host、
 * SQLite、文件或网络：
 * - Phase 建立、单 Feature 计划导入、层级/DAG 查询、草稿修订与标签编辑的
 *   命令身份与参数在解析层可得、在 help 中可查；
 * - expectedRevision 是唯一 CAS 入口（缺 `--revision` 属输入错误，退出码 2）；
 * - 计划实体 ID/分页/命令 ID/标签沿用既有校验口径，解析失败不回显参数值；
 * - help 与命令输出纪律：导入/修订只保存草稿（planStatus=draft），帮助文本
 *   不宣称已有审批批准、Task passed 或 Work 执行。
 *
 * 纵向（真实 Host + HostClient + SQLite）见 `p03-1-plan-cli-vertical.test.ts`。
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

function expectParseError(
  args: readonly string[],
  reason: string,
  field?: string,
  code: 'invalid_input' | 'bind_address_override_rejected' = 'invalid_input',
): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(
      AppCliParseError,
    );
    const parsed = error as AppCliParseError;
    expect(parsed.code).toBe(code);
    expect(parsed.reason).toBe(reason);
    if (field !== undefined) {
      expect(parsed.field).toBe(field);
    }
    // 错误不回显用户输入值（不把 title/路径/ID 原文带回）。
    expect(parsed.message).not.toContain(PROJECT_ID);
    return parsed;
  }
  throw new Error(`expected parse error ${reason} for args ${JSON.stringify(args)}`);
}

/* ------------------------------------------------------------------ *
 * 命令面
 * ------------------------------------------------------------------ */

describe('F-010 计划命令面（phase/feature/task 顶层命令）', () => {
  it('顶层命令集合包含 phase/feature/task，身份为点分 CLI 路径且唯一', () => {
    for (const command of ['phase', 'feature', 'task'] as const) {
      expect([...APP_CLI_COMMANDS]).toContain(command);
    }
    expect(new Set(APP_CLI_COMMAND_IDS).size).toBe(APP_CLI_COMMAND_IDS.length);
    for (const id of APP_CLI_COMMAND_IDS) {
      expect(id).toMatch(/^(project|config|receipt|events|baseline|phase|feature|task|execution|workspace|git)\.[a-z-]+$/);
    }
  });

  it('计划命令身份齐全（建立/导入/查询/修订/标签）', () => {
    for (const id of [
      'phase.create',
      'phase.list',
      'phase.get',
      'phase.labels',
      'feature.import',
      'feature.list',
      'feature.get',
      'feature.revise',
      'feature.labels',
      'task.list',
      'task.get',
      'task.labels',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 参数解析（§12.2 纪律：解析先于任何 I/O）
 * ------------------------------------------------------------------ */

describe('F-010 计划命令参数解析', () => {
  it('phase create：项目 + 标题 + 可选描述/标签/命令 ID', () => {
    const explicit = randomUUID();
    expect(
      parseAppCliArgs([
        'phase',
        'create',
        '--project',
        PROJECT_ID,
        '--title',
        '阶段一',
        '--description',
        '阶段说明',
        '--label',
        'alpha',
        '--label',
        'beta',
        '--command-id',
        explicit,
        '--json',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'phase',
      commandId: 'phase.create',
      operation: 'phase.create',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      title: '阶段一',
      description: '阶段说明',
      labels: ['alpha', 'beta'],
      explicitCommandId: explicit,
    });
    expect(
      parseAppCliArgs(['phase', 'create', '--project', PROJECT_ID, '--title', '阶段一']),
    ).toEqual({
      kind: 'command',
      command: 'phase',
      commandId: 'phase.create',
      operation: 'phase.create',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      title: '阶段一',
      labels: [],
    });
  });

  it('feature import：Phase 聚合 expectedRevision + --input 计划文件', () => {
    expect(
      parseAppCliArgs([
        'feature',
        'import',
        '--project',
        PROJECT_ID,
        '--phase',
        'phase-main',
        '--revision',
        '1',
        '--input',
        '/tmp/计划 文件.json',
        '--json',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'feature',
      commandId: 'feature.import',
      operation: 'feature.plan.import',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      phaseId: 'phase-main',
      revision: 1,
      inputFile: '/tmp/计划 文件.json',
    });
  });

  it('feature revise：Feature 聚合 expectedRevision + 位置 featureId + --input', () => {
    const explicit = randomUUID();
    expect(
      parseAppCliArgs([
        'feature',
        'revise',
        'feat-1',
        '--project',
        PROJECT_ID,
        '--revision',
        '2',
        '--input',
        '/tmp/plan.json',
        '--command-id',
        explicit,
      ]),
    ).toEqual({
      kind: 'command',
      command: 'feature',
      commandId: 'feature.revise',
      operation: 'feature.plan.revise',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      featureId: 'feat-1',
      revision: 2,
      inputFile: '/tmp/plan.json',
      explicitCommandId: explicit,
    });
  });

  it('标签编辑：位置实体 ID + 自身 revision CAS + 整体替换标签集合（可为空）', () => {
    expect(
      parseAppCliArgs([
        'task',
        'labels',
        't-1',
        '--project',
        PROJECT_ID,
        '--revision',
        '1',
        '--label',
        'wired',
        '--json',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'task',
      commandId: 'task.labels',
      operation: 'plan.labels.update',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      entityType: 'task',
      id: 't-1',
      projectId: PROJECT_ID,
      revision: 1,
      labels: ['wired'],
    });
    // 省略 --label = 清空标签集合（整体替换语义）。
    expect(
      parseAppCliArgs([
        'phase',
        'labels',
        'phase-main',
        '--project',
        PROJECT_ID,
        '--revision',
        '3',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'phase',
      commandId: 'phase.labels',
      operation: 'plan.labels.update',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      entityType: 'phase',
      id: 'phase-main',
      projectId: PROJECT_ID,
      revision: 3,
      labels: [],
    });
    expect(
      parseAppCliArgs([
        'feature',
        'labels',
        'feat-1',
        '--project',
        PROJECT_ID,
        '--revision',
        '1',
      ]),
    ).toMatchObject({ commandId: 'feature.labels', entityType: 'feature', id: 'feat-1' });
  });

  it('层级查询：按 ID 详情与稳定分页列表（limit/cursor）', () => {
    expect(parseAppCliArgs(['phase', 'get', 'phase-main'])).toMatchObject({
      commandId: 'phase.get',
      phaseId: 'phase-main',
    });
    expect(parseAppCliArgs(['feature', 'get', 'feat-1'])).toMatchObject({
      commandId: 'feature.get',
      featureId: 'feat-1',
    });
    expect(parseAppCliArgs(['task', 'get', 't-1'])).toMatchObject({
      commandId: 'task.get',
      taskId: 't-1',
    });
    expect(
      parseAppCliArgs([
        'phase',
        'list',
        '--project',
        PROJECT_ID,
        '--limit',
        '20',
        '--cursor',
        'plcur_v1_abc',
        '--json',
      ]),
    ).toEqual({
      kind: 'command',
      command: 'phase',
      commandId: 'phase.list',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      limit: 20,
      cursor: 'plcur_v1_abc',
    });
    expect(
      parseAppCliArgs(['feature', 'list', '--project', PROJECT_ID, '--phase', 'phase-main']),
    ).toMatchObject({ commandId: 'feature.list', projectId: PROJECT_ID, phaseId: 'phase-main' });
    expect(
      parseAppCliArgs(['task', 'list', '--project', PROJECT_ID, '--feature', 'feat-1', '--limit', '2']),
    ).toMatchObject({ commandId: 'task.list', featureId: 'feat-1', limit: 2 });
    // 边界值：limit 1/200 通过。
    for (const limit of ['1', '200']) {
      expect(
        parseAppCliArgs(['task', 'list', '--project', PROJECT_ID, '--feature', 'feat-1', '--limit', limit]),
      ).toMatchObject({ limit: Number(limit) });
    }
  });

  it('缺必要 CAS：写修订/标签命令缺 --revision 一律拒绝', () => {
    expectParseError(
      ['feature', 'import', '--project', PROJECT_ID, '--phase', 'phase-main', '--input', '/tmp/p.json'],
      'missing_required_option',
      'revision',
    );
    expectParseError(
      ['feature', 'revise', 'feat-1', '--project', PROJECT_ID, '--input', '/tmp/p.json'],
      'missing_required_option',
      'revision',
    );
    expectParseError(
      ['task', 'labels', 't-1', '--project', PROJECT_ID, '--label', 'x'],
      'missing_required_option',
      'revision',
    );
  });

  it('无效 ID/分页/标题/输入路径按既有 reason 拒绝', () => {
    expectParseError(
      ['phase', 'create', '--project', 'not-a-uuid', '--title', 'x'],
      'invalid_project_id',
    );
    expectParseError(['phase', 'create', '--project', PROJECT_ID], 'missing_required_option', 'title');
    expectParseError(
      ['phase', 'create', '--project', PROJECT_ID, '--title', '   '],
      'invalid_title',
    );
    expectParseError(['task', 'get', 'bad/id'], 'invalid_plan_id');
    expectParseError(
      [
        'feature',
        'revise',
        'bad id',
        '--project',
        PROJECT_ID,
        '--revision',
        '1',
        '--input',
        '/tmp/p.json',
      ],
      'invalid_plan_id',
    );
    expectParseError(
      ['feature', 'import', '--project', PROJECT_ID, '--phase', 'bad/id', '--revision', '1', '--input', '/tmp/p.json'],
      'invalid_plan_id',
    );
    expectParseError(
      ['task', 'labels', 't-1', '--project', PROJECT_ID, '--revision', '0'],
      'invalid_revision',
    );
    expectParseError(
      ['feature', 'import', '--project', PROJECT_ID, '--phase', 'p-1', '--revision', 'x', '--input', '/tmp/p.json'],
      'invalid_revision',
    );
    expectParseError(
      ['task', 'list', '--project', PROJECT_ID, '--feature', 'feat-1', '--limit', '201'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['phase', 'list', '--project', PROJECT_ID, '--limit', '0'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['phase', 'list', '--project', PROJECT_ID, '--cursor', ''],
      'invalid_cursor',
    );
    expectParseError(
      ['feature', 'import', '--project', PROJECT_ID, '--phase', 'p-1', '--revision', '1'],
      'missing_required_option',
      'input',
    );
    expectParseError(
      ['feature', 'import', '--project', PROJECT_ID, '--phase', 'p-1', '--revision', '1', '--input', ''],
      'invalid_input_file',
    );
  });

  it('未知参数/未知子命令/多余位置参数仍拒绝，监听地址覆盖零容忍不变', () => {
    expectParseError(['phase', 'create', '--project', PROJECT_ID, '--title', 'x', '--run'], 'unknown_argument');
    expectParseError(['phase', 'approve', '--project', PROJECT_ID], 'unknown_subcommand');
    expectParseError(['feature', 'import', 'positional'], 'too_many_positionals');
    expectParseError(
      ['task', 'get', 't-1', '--port', '9999'],
      'listen_override_argument_rejected',
      undefined,
      'bind_address_override_rejected',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 帮助与「不宣称」纪律
 * ------------------------------------------------------------------ */

describe('F-010 计划命令帮助（可查且不宣称审批/通过/执行）', () => {
  const scopes = [
    'phase',
    'phase.create',
    'phase.list',
    'phase.get',
    'phase.labels',
    'feature',
    'feature.import',
    'feature.list',
    'feature.get',
    'feature.revise',
    'feature.labels',
    'task',
    'task.list',
    'task.get',
    'task.labels',
  ] as const;

  it('每个计划命令作用域都有帮助，含 usage 与关键参数名', () => {
    for (const scope of scopes) {
      const help = getAppCliHelp(scope);
      expect(help.length, `${scope} 帮助不能为空`).toBeGreaterThan(0);
      expect(help.endsWith('\n')).toBe(true);
      expect(help, `${scope} 帮助须含 usage`).toContain('usage: shiploop');
      expect(help, `${scope} 帮助须含退出码说明`).toContain('退出码');
    }
    expect(getAppCliHelp('feature.import')).toContain('--input');
    expect(getAppCliHelp('feature.import')).toContain('--revision');
    expect(getAppCliHelp('feature.revise')).toContain('--revision');
    expect(getAppCliHelp('phase.create')).toContain('--title');
    expect(getAppCliHelp('task.list')).toContain('--limit');
    expect(getAppCliHelp('task.labels')).toContain('--label');
  });

  it('帮助传达草稿语义与计划文件边界，不宣称已有审批批准、Task passed 或 Work 执行', () => {
    for (const scope of ['feature', 'feature.import', 'feature.revise'] as const) {
      const help = getAppCliHelp(scope);
      expect(help, `${scope} 帮助须写明草稿语义`).toContain('planStatus=draft');
      expect(help, `${scope} 帮助须写明不构成审批批准`).toContain('不构成审批批准');
    }
    // 计划文件只作受控读取：有界 UTF-8 JSON，不执行文件内容。
    for (const scope of ['feature.import', 'feature.revise'] as const) {
      const help = getAppCliHelp(scope);
      expect(help).toContain('有界');
      expect(help).toContain('UTF-8');
      expect(help).toContain('不执行');
    }
    // 「不宣称」负面守卫：帮助不得出现任何完成态/批准态/执行态声称。
    for (const scope of scopes) {
      const help = getAppCliHelp(scope);
      for (const claim of ['已批准', '已通过', '已执行', 'approved', 'passed', 'Work 已']) {
        expect(help, `${scope} 帮助不得宣称「${claim}」`).not.toContain(claim);
      }
    }
  });
});
