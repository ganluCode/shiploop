/**
 * F-014 应用命令 CLI 参数面（契约 §12.1/§12.2/§12.3）。
 *
 * 本任务只交付「纯解析 + 帮助 + JSON 格式化 + 退出码」层：
 * - `parseAppCliArgs` 是同步纯函数：不读 process.argv/env（env 必须显式注入）、
 *   不读文件、不发现 Host、不联网、不启动进程、不生成 commandId；
 * - 业务命令纵向接线（HostClient/正式 dist 入口）属 F-015/F-016/F-017，本
 *   任务不实现、不冒充；
 * - 只认 F-001 契约白名单（project/config/receipt/events），不新增基线、
 *   Run、模型、Profile、Skills 参数。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BIND_OVERRIDE_ENV_KEYS, isUuidV4 } from '../../../packages/host/src/index.ts';
import {
  APP_CLI_COMMANDS,
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  CLI_EXIT_CONNECTION,
  CLI_EXIT_INPUT,
  CLI_EXIT_OBSERVATION_INTERRUPTED,
  CLI_EXIT_OK,
  CLI_EXIT_REJECTED,
  CLI_START_TIMEOUT_DEFAULT_MS,
  buildAppCliFailureEnvelope,
  buildAppCliSuccessEnvelope,
  exitCodeForAppErrorCode,
  exitCodeForReceiptStatus,
  formatAppCliParseError,
  getAppCliHelp,
  parseAppCliArgs,
  parseAppInputJson,
} from '../../../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_SRC_DIR = resolve(REPO_ROOT, 'packages/cli/src');

function listTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTsFiles(child));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(child);
    }
  }
  return result.sort();
}

function expectParseError(
  args: readonly string[],
  reason: string,
  env: Record<string, string | undefined> = {},
  code: 'invalid_input' | 'bind_address_override_rejected' = 'invalid_input',
): AppCliParseError {
  try {
    parseAppCliArgs(args, env);
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(
      AppCliParseError,
    );
    const parsed = error as AppCliParseError;
    expect(parsed.code).toBe(code);
    expect(parsed.reason).toBe(reason);
    return parsed;
  }
  throw new Error(`expected parse error ${reason} for args ${JSON.stringify(args)}`);
}

const PROJECT_ID = randomUUID();
const OTHER_PROJECT_ID = randomUUID();
const RECEIPT_ID = randomUUID();

describe('F-014 应用命令面（§12.1）', () => {
  it('只暴露 project/config/receipt/events/baseline/phase/feature/task/planning/execution/workspace/git 十二个命令，不新增 run/work', () => {
    // P03-5 / F-012 追加 workspace（工作区状态展示与人工丢弃预览/确认）；
    // P03-8 / F-011 追加 git（Git 意图/实际提交/操作回执只读查询）；
    // P05-1 / F-013 已交付 planning（一次性规划与候选审批）。
    expect([...APP_CLI_COMMANDS]).toEqual([
      'project',
      'config',
      'receipt',
      'events',
      'baseline',
      'phase',
      'feature',
      'task',
      'planning',
      'execution',
      'workspace',
      'git',
    ]);
  });

  it('命令身份集合唯一且为点分 CLI 路径', () => {
    expect(new Set(APP_CLI_COMMAND_IDS).size).toBe(APP_CLI_COMMAND_IDS.length);
    for (const id of APP_CLI_COMMAND_IDS) {
      expect(id).toMatch(/^(project|config|receipt|events|baseline|phase|feature|task|planning|execution|workspace|git)\.[a-z-]+$/);
    }
  });

  it('project register：位置仓库路径 + 必填 --name + 可选描述/标签/命令 ID', () => {
    const explicit = randomUUID();
    const parsed = parseAppCliArgs([
      'project',
      'register',
      '/tmp/repo',
      '--name',
      '演示项目',
      '--description',
      '说明',
      '--label',
      'alpha',
      '--label',
      'beta',
      '--command-id',
      explicit,
      '--json',
    ]);
    expect(parsed).toEqual({
      kind: 'command',
      command: 'project',
      commandId: 'project.register',
      operation: 'project.register',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      repositoryPath: '/tmp/repo',
      displayName: '演示项目',
      description: '说明',
      labels: ['alpha', 'beta'],
      explicitCommandId: explicit,
    });
  });

  it('project list：默认 match=any、无 limit/cursor、空标签；支持分页与标签过滤', () => {
    const defaults = parseAppCliArgs(['project', 'list']);
    expect(defaults.kind).toBe('command');
    if (defaults.kind === 'command' && defaults.commandId === 'project.list') {
      expect(defaults.match).toBe('any');
      expect(defaults.labels).toEqual([]);
      expect(defaults.limit).toBeUndefined();
      expect(defaults.cursor).toBeUndefined();
    }
    const parsed = parseAppCliArgs([
      'project',
      'list',
      '--label',
      'alpha',
      '--match',
      'all',
      '--limit',
      '25',
      '--cursor',
      'last-id',
    ]);
    if (parsed.kind === 'command' && parsed.commandId === 'project.list') {
      expect(parsed.labels).toEqual(['alpha']);
      expect(parsed.match).toBe('all');
      expect(parsed.limit).toBe(25);
      expect(parsed.cursor).toBe('last-id');
    } else {
      throw new Error('expected project.list');
    }
  });

  it('project get/labels：只读详情与标签计数', () => {
    const get = parseAppCliArgs(['project', 'get', PROJECT_ID]);
    if (get.kind === 'command' && get.commandId === 'project.get') {
      expect(get.projectId).toBe(PROJECT_ID);
    } else {
      throw new Error('expected project.get');
    }
    const labels = parseAppCliArgs(['project', 'labels']);
    expect(labels.kind === 'command' && labels.commandId === 'project.labels').toBe(true);
  });

  it('project edit：位置 projectId + 必填 --revision + 可选元数据/命令 ID', () => {
    const explicit = randomUUID();
    const parsed = parseAppCliArgs([
      'project',
      'edit',
      PROJECT_ID,
      '--revision',
      '3',
      '--name',
      '新名称',
      '--label',
      'gamma',
      '--command-id',
      explicit,
    ]);
    expect(parsed).toEqual({
      kind: 'command',
      command: 'project',
      commandId: 'project.edit',
      operation: 'project.metadata.update',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      revision: 3,
      displayName: '新名称',
      labels: ['gamma'],
      explicitCommandId: explicit,
    });
  });

  it('config create：global 与 project scope 的 operation 与必填参数', () => {
    const globalCreate = parseAppCliArgs(['config', 'create', '--scope', 'global', '--input', '/tmp/c.json']);
    expect(globalCreate).toEqual({
      kind: 'command',
      command: 'config',
      commandId: 'config.create',
      operation: 'settings.global.create',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      scope: 'global',
      inputFile: '/tmp/c.json',
    });
    const explicit = randomUUID();
    const projectCreate = parseAppCliArgs([
      'config',
      'create',
      '--scope',
      'project',
      '--project',
      PROJECT_ID,
      '--input',
      '/tmp/c.json',
      '--command-id',
      explicit,
    ]);
    expect(projectCreate).toEqual({
      kind: 'command',
      command: 'config',
      commandId: 'config.create',
      operation: 'settings.project.create',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      scope: 'project',
      projectId: PROJECT_ID,
      inputFile: '/tmp/c.json',
      explicitCommandId: explicit,
    });
  });

  it('config update：必填 --revision，global/project operation 区分', () => {
    const parsed = parseAppCliArgs([
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '2',
      '--input',
      '/tmp/c.json',
    ]);
    if (parsed.kind === 'command' && parsed.commandId === 'config.update') {
      expect(parsed.operation).toBe('settings.global.update');
      expect(parsed.revision).toBe(2);
      expect(parsed.scope).toBe('global');
    } else {
      throw new Error('expected config.update');
    }
  });

  it('config get/export：scope 二态；config effective 只接受 --project', () => {
    const globalGet = parseAppCliArgs(['config', 'get', '--scope', 'global']);
    expect(globalGet.kind === 'command' && globalGet.commandId === 'config.get').toBe(true);
    const projectGet = parseAppCliArgs(['config', 'get', '--scope', 'project', '--project', PROJECT_ID]);
    if (projectGet.kind === 'command' && projectGet.commandId === 'config.get') {
      expect(projectGet.scope).toBe('project');
      expect(projectGet.projectId).toBe(PROJECT_ID);
    } else {
      throw new Error('expected config.get');
    }
    const effective = parseAppCliArgs(['config', 'effective', '--project', PROJECT_ID]);
    if (effective.kind === 'command' && effective.commandId === 'config.effective') {
      expect(effective.projectId).toBe(PROJECT_ID);
    } else {
      throw new Error('expected config.effective');
    }
    const exported = parseAppCliArgs(['config', 'export', '--scope', 'project', '--project', OTHER_PROJECT_ID]);
    expect(exported.kind === 'command' && exported.commandId === 'config.export').toBe(true);
  });

  it('receipt get：位置 commandId（UUID v4）', () => {
    const parsed = parseAppCliArgs(['receipt', 'get', RECEIPT_ID]);
    expect(parsed).toEqual({
      kind: 'command',
      command: 'receipt',
      commandId: 'receipt.get',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      targetCommandId: RECEIPT_ID,
    });
  });

  it('events：默认跟随；支持 project/global、恢复游标与 snapshot-only', () => {
    const defaults = parseAppCliArgs(['events', '--project', PROJECT_ID]);
    if (defaults.kind === 'command' && defaults.commandId === 'events.observe') {
      expect(defaults.scope).toBe('project');
      expect(defaults.projectId).toBe(PROJECT_ID);
      expect(defaults.follow).toBe(true);
      expect(defaults.snapshotOnly).toBe(false);
      expect(defaults.cursor).toBeUndefined();
    } else {
      throw new Error('expected events.observe');
    }

    const global = parseAppCliArgs(['events', '--global', '--cursor', 'evcur_v1_abc']);
    if (global.kind === 'command' && global.commandId === 'events.observe') {
      expect(global.scope).toBe('global');
      expect(global.projectId).toBeUndefined();
      expect(global.cursor).toBe('evcur_v1_abc');
      expect(global.follow).toBe(true);
    } else {
      throw new Error('expected events.observe');
    }

    const snapshot = parseAppCliArgs(['events', '--global', '--snapshot-only']);
    if (snapshot.kind === 'command' && snapshot.commandId === 'events.observe') {
      expect(snapshot.snapshotOnly).toBe(true);
      expect(snapshot.follow).toBe(false);
    } else {
      throw new Error('expected events.observe');
    }
  });

  it('--data-root 与 --start-timeout-ms 对所有应用命令可用', () => {
    const parsed = parseAppCliArgs([
      'project',
      'get',
      PROJECT_ID,
      '--data-root',
      '/srv/shiploop',
      '--start-timeout-ms',
      '2000',
    ]);
    if (parsed.kind === 'command' && parsed.commandId === 'project.get') {
      expect(parsed.dataRoot).toBe('/srv/shiploop');
      expect(parsed.startTimeoutMs).toBe(2000);
    } else {
      throw new Error('expected project.get');
    }
  });

  it('解析是同步纯函数：不读隐式环境、不返回 Promise', () => {
    const parsed = parseAppCliArgs(['project', 'labels']);
    expect(typeof (parsed as unknown as Promise<unknown>).then).not.toBe('function');
    expect(parseAppCliArgs(['project', 'labels'], { SHIPLOOP_HOST_BIND: undefined })).toEqual(parsed);
  });
});

describe('F-014 应用命令结构错误（§12.2）', () => {
  it.each([
    [['run'], 'unknown_command'],
    [['work'], 'unknown_command'],
    [['workflow'], 'unknown_command'],
    // P03-1 §12.1：feature/phase/task 已是正式子命令组（F-010）；缺子命令仍在解析期拒绝。
    [['feature'], 'missing_subcommand'],
    [['phase'], 'missing_subcommand'],
    [['task'], 'missing_subcommand'],
    // P02-3 §12.1：baseline 已是正式子命令组（F-015）；缺子命令仍在解析期拒绝。
    [['baseline'], 'missing_subcommand'],
    [['project'], 'missing_subcommand'],
    // P02-3 §12.1：project init/overview 已是正式子命令；缺位置参数仍在解析期拒绝。
    [['project', 'init'], 'missing_positional'],
    [['project', 'overview'], 'missing_positional'],
    [['project', 'rebind'], 'unknown_subcommand'],
    [['project', 'archive'], 'unknown_subcommand'],
    [['config', 'delete'], 'unknown_subcommand'],
    [['receipt', 'list'], 'unknown_subcommand'],
    [['events', 'list'], 'too_many_positionals'],
    [['project', '--json'], 'missing_subcommand'],
    [['project', 'labels', 'extra'], 'too_many_positionals'],
    [['project', 'get'], 'missing_positional'],
    [['project', 'get', PROJECT_ID, 'extra'], 'too_many_positionals'],
    [['receipt', 'get'], 'missing_positional'],
    [['project', 'register'], 'missing_positional'],
    [['-x'], 'unknown_command'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'register', '/tmp/repo', '--name', 'x', '--baseline'], 'unknown_argument'],
    [['project', 'register', '/tmp/repo', '--name', 'x', '--model', 'gpt'], 'unknown_argument'],
    [['project', 'list', '--profile', 'default'], 'unknown_argument'],
    [['project', 'list', '--skills', 'ts'], 'unknown_argument'],
    [['project', 'get', PROJECT_ID, '--revision', '1'], 'unknown_argument'],
    [['config', 'get', '--scope', 'global', '--input', '/tmp/x'], 'unknown_argument'],
  ] as const)('未支持/未知参数 %j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'register', '/tmp/repo', '--name'], 'missing_value'],
    [['project', 'list', '--limit'], 'missing_value'],
    [['project', 'edit', PROJECT_ID, '--revision'], 'missing_value'],
    [['config', 'create', '--scope'], 'missing_value'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'list', '--limit', '1', '--limit', '2'], 'duplicate_option'],
    [['project', 'list', '--match', 'any', '--match', 'all'], 'duplicate_option'],
    [['project', 'edit', PROJECT_ID, '--revision', '1', '--revision', '2'], 'duplicate_option'],
    [['config', 'create', '--scope', 'global', '--scope', 'project'], 'duplicate_option'],
    [['project', 'labels', '--json', '--json'], 'duplicate_option'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'labels', '--json=true'], 'bool_flag_takes_no_value'],
    [['events', '--global', '--global=true'], 'bool_flag_takes_no_value'],
    [['project', 'list', '--help=1'], 'bool_flag_takes_no_value'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'get', 'not-a-uuid'], 'invalid_project_id'],
    [['project', 'get', '123E4567-E89B-41D1-A456-426614174000'], 'invalid_project_id'],
    [['config', 'create', '--scope', 'project', '--project', 'nope', '--input', '/tmp/x'], 'invalid_project_id'],
    [['config', 'effective', '--project', 'nope'], 'invalid_project_id'],
    [['receipt', 'get', 'nope'], 'invalid_command_id'],
    [['project', 'edit', PROJECT_ID, '--revision', '1', '--command-id', 'nope'], 'invalid_command_id'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'edit', PROJECT_ID, '--revision', '0'], 'invalid_revision'],
    [['project', 'edit', PROJECT_ID, '--revision', '-1'], 'missing_value'],
    [['project', 'edit', PROJECT_ID, '--revision', '1.5'], 'invalid_revision'],
    [['project', 'edit', PROJECT_ID, '--revision', 'abc'], 'invalid_revision'],
    [['config', 'update', '--scope', 'global', '--revision', '0', '--input', '/tmp/x'], 'invalid_revision'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'list', '--limit', '0'], 'invalid_limit'],
    [['project', 'list', '--limit', '201'], 'invalid_limit'],
    [['project', 'list', '--limit', '1.5'], 'invalid_limit'],
    [['project', 'list', '--limit', 'abc'], 'invalid_limit'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'list', '--match', 'some'], 'invalid_match'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'list', '--cursor='], 'invalid_cursor'],
    [['events', '--global', '--cursor', ''], 'invalid_cursor'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it.each([
    [['project', 'register', '/tmp/repo', '--name='], 'invalid_name'],
    [['project', 'register', '/tmp/repo', '--name', 'x', '--label='], 'empty_label'],
    [['config', 'create', '--scope', 'global', '--input='], 'invalid_input_file'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it('缺少必填选项得到具体 field', () => {
    const noName = expectParseError(['project', 'register', '/tmp/repo'], 'missing_required_option');
    expect(noName.field).toBe('name');
    const noScope = expectParseError(['config', 'create', '--input', '/tmp/x'], 'missing_required_option');
    expect(noScope.field).toBe('scope');
    const noInput = expectParseError(['config', 'create', '--scope', 'global'], 'missing_required_option');
    expect(noInput.field).toBe('input');
    const noRevision = expectParseError(
      ['config', 'update', '--scope', 'global', '--input', '/tmp/x'],
      'missing_required_option',
    );
    expect(noRevision.field).toBe('revision');
    const noProject = expectParseError(['config', 'effective'], 'missing_required_option');
    expect(noProject.field).toBe('project');
  });

  it('scope 三态冲突：global 带 --project / project 缺 --project / 非法 scope 值', () => {
    const globalWithProject = expectParseError(
      ['config', 'create', '--scope', 'global', '--project', PROJECT_ID, '--input', '/tmp/x'],
      'scope_conflict',
    );
    expect(globalWithProject.field).toBe('project');
    expectParseError(
      ['config', 'create', '--scope', 'project', '--input', '/tmp/x'],
      'project_required_for_scope',
    );
    expectParseError(['config', 'get', '--scope', 'team'], 'invalid_scope');
    expectParseError(['events', '--global', '--project', PROJECT_ID], 'scope_conflict');
    expectParseError(['events'], 'missing_required_option');
  });

  it('events --snapshot-only 与 --follow 冲突', () => {
    expectParseError(
      ['events', '--global', '--snapshot-only', '--follow'],
      'conflicting_options',
    );
  });

  it.each([
    [['project', 'get', PROJECT_ID, '--data-root', 'relative'], 'data_root_not_absolute'],
    [['project', 'get', PROJECT_ID, '--data-root='], 'data_root_empty'],
    [['project', 'get', PROJECT_ID, '--data-root', '/'], 'data_root_is_filesystem_root'],
    [['project', 'get', PROJECT_ID, '--start-timeout-ms', '999'], 'integer_out_of_range'],
    [['project', 'get', PROJECT_ID, '--start-timeout-ms', 'abc'], 'invalid_integer'],
  ] as const)('%j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], reason);
  });

  it('错误不回显用户提供的值（脱敏）', () => {
    const secret = '/tmp/do-not-echo-secret';
    const error = expectParseError(
      ['project', 'get', PROJECT_ID, '--data-root', `relative${secret}`],
      'data_root_not_absolute',
    );
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(formatAppCliParseError(error)).not.toContain(secret);
  });

  it('未知顶层命令即使带 --json 也是输入错误（command=null）', () => {
    const error = expectParseError(['run', '--json'], 'unknown_command');
    expect(error.command).toBeNull();
    expect(error.commandId).toBeNull();
  });
});

describe('F-014 监听地址覆盖零容忍（§12.2）', () => {
  const overrideArguments = [
    '--bind=0.0.0.0',
    '--host=example.com',
    '--hostname=::',
    '--address=192.168.1.1',
    '--port=8080',
    '--listen-foo',
  ] as const;

  it('任何覆盖参数在应用命令都被拒绝（退出码 2），不回显覆盖值', () => {
    for (const argument of overrideArguments) {
      const error = expectParseError(
        ['project', 'get', PROJECT_ID, argument],
        'listen_override_argument_rejected',
        {},
        'bind_address_override_rejected',
      );
      expect(error.code).toBe('bind_address_override_rejected');
      expect(JSON.stringify(error)).not.toContain('192.168.1.1');
      expect(JSON.stringify(error)).not.toContain('0.0.0.0');
      expect(exitCodeForAppErrorCode(error.code)).toBe(CLI_EXIT_INPUT);
    }
  });

  it.each([...BIND_OVERRIDE_ENV_KEYS])('非空环境变量覆盖 %s 被拒绝', (name) => {
    const error = expectParseError(
      ['project', 'labels'],
      'listen_override_env_rejected',
      { [name]: name.endsWith('PORT') ? '8080' : '0.0.0.0' },
      'bind_address_override_rejected',
    );
    expect(error.code).toBe('bind_address_override_rejected');
    expect(error.field).toBe(name);
    expect(JSON.stringify(error)).not.toContain('8080');
  });
});

describe('F-014 输入 JSON 与输出信封（§12.2/§12.3）', () => {
  it('parseAppInputJson 接受 JSON 普通对象', () => {
    expect(parseAppInputJson('{"strategies":{"runtime":{"provider":"pi","model":"x"}}}')).toEqual({
      strategies: { runtime: { provider: 'pi', model: 'x' } },
    });
  });

  it.each([
    ['{'],
    ['not json'],
    ['null'],
    ['[1,2,3]'],
    ['"text"'],
    ['42'],
  ])('非法输入 JSON %j → invalid_input_json', (text) => {
    try {
      parseAppInputJson(text);
    } catch (error) {
      expect(error).toBeInstanceOf(AppCliParseError);
      expect((error as AppCliParseError).reason).toBe('invalid_input_json');
      return;
    }
    throw new Error(`expected invalid_input_json for ${text}`);
  });

  it('成功信封：单行可解析 JSON，命令名使用应用命令身份', () => {
    const line = JSON.stringify(buildAppCliSuccessEnvelope('project.list', { records: [] }));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: true, command: 'project.list', result: { records: [] } });
    expect(line).not.toContain('\n');
  });

  it('失败信封：保留 commandId 便于查回执，错误只含受控字段', () => {
    const line = JSON.stringify(
      buildAppCliFailureEnvelope('project.register', 'conflict', '命令 ID 已用于不同参数', {
        commandId: RECEIPT_ID,
        details: { reason: 'idempotency_key_reuse' },
      }),
    );
    const parsed = JSON.parse(line) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string; commandId?: string; details?: Record<string, unknown> };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe('project.register');
    expect(parsed.error.code).toBe('conflict');
    expect(parsed.error.commandId).toBe(RECEIPT_ID);
    expect(parsed.error.details).toEqual({ reason: 'idempotency_key_reuse' });
    expect(line).not.toContain('stack');
  });

  it('退出码复用 P02-1 四档；观察中断/溢出为第五档 4', () => {
    expect(CLI_EXIT_OBSERVATION_INTERRUPTED).toBe(4);
    expect(exitCodeForAppErrorCode('observation_interrupted')).toBe(4);
    expect(exitCodeForAppErrorCode('stream_overflow')).toBe(4);
    expect(exitCodeForAppErrorCode('forbidden')).toBe(CLI_EXIT_REJECTED);
    expect(exitCodeForAppErrorCode('conflict')).toBe(CLI_EXIT_REJECTED);
    expect(exitCodeForAppErrorCode('invalid_input')).toBe(CLI_EXIT_INPUT);
    expect(exitCodeForAppErrorCode('host_not_found')).toBe(CLI_EXIT_CONNECTION);
    expect(exitCodeForAppErrorCode('some_future_code')).toBe(CLI_EXIT_REJECTED);
  });

  it('accepted 与 rejected 不得折算为成功（只有 completed 是 0）', () => {
    expect(exitCodeForReceiptStatus('completed')).toBe(CLI_EXIT_OK);
    expect(exitCodeForReceiptStatus('accepted')).toBe(CLI_EXIT_REJECTED);
    expect(exitCodeForReceiptStatus('rejected')).toBe(CLI_EXIT_REJECTED);
  });
});

describe('F-014 帮助文案（§12.1/§12.2/§12.3）', () => {
  const SCOPES = [
    'project',
    'project.register',
    'project.list',
    'project.get',
    'project.edit',
    'project.labels',
    'config',
    'config.create',
    'config.update',
    'config.get',
    'config.effective',
    'config.export',
    'receipt',
    'receipt.get',
    'events',
  ] as const;

  it('每个作用域帮助非空、以换行结尾、不含开发机路径或凭据', () => {
    for (const scope of SCOPES) {
      const text = getAppCliHelp(scope);
      expect(text.length).toBeGreaterThan(20);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toMatch(/\/Users\//);
      expect(text).not.toMatch(/[0-9a-f]{64}/);
      expect(text).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
    }
  });

  it('help 令牌返回帮助作用域', () => {
    expect(parseAppCliArgs(['project', '--help'])).toEqual({ kind: 'help', scope: 'project' });
    expect(parseAppCliArgs(['project', 'register', '--help'])).toEqual({
      kind: 'help',
      scope: 'project.register',
    });
    expect(parseAppCliArgs(['config', 'create', '-h'])).toEqual({
      kind: 'help',
      scope: 'config.create',
    });
    expect(parseAppCliArgs(['events', '--help'])).toEqual({ kind: 'help', scope: 'events' });
  });

  it('project register 帮助说明显式命令 ID、非 project init、注册与健康分离', () => {
    const text = getAppCliHelp('project.register');
    expect(text).toMatch(/--command-id/);
    expect(text).toMatch(/不是.*project init|非.*project init|project init/);
    expect(text).toMatch(/基线|健康/);
  });

  it('project edit 帮助说明显式 revision 用法', () => {
    const text = getAppCliHelp('project.edit');
    expect(text).toContain('--revision');
    expect(text).toMatch(/至少.*revision|revision.*至少|显式/);
  });

  it('config 帮助说明 --input 只是本次请求输入，不监听文件变化、不覆盖式配置', () => {
    const text = getAppCliHelp('config.create');
    expect(text).toContain('--input');
    expect(text).toMatch(/请求输入/);
    expect(text).toMatch(/不监听/);
  });

  it('events 帮助说明观察中断不停止 Host、不取消已提交命令', () => {
    const text = getAppCliHelp('events');
    expect(text).toMatch(/中断|Ctrl\+C/);
    expect(text).toMatch(/不停止\s*Host/);
    expect(text).toMatch(/观察中断/);
  });

  it('帮助请求不做 env 覆盖检查（帮助短路于启动检查之前）', () => {
    expect(
      parseAppCliArgs(['events', '--help'], { SHIPLOOP_HOST_PORT: '80' }),
    ).toEqual({ kind: 'help', scope: 'events' });
  });
});

describe('F-014 纯面层边界（解析/执行分离）', () => {
  it('应用面源码不直接导入任何 node 内置模块', () => {
    const appFiles = listTsFiles(resolve(CLI_SRC_DIR, 'app'));
    expect(appFiles.length).toBeGreaterThanOrEqual(2);
    for (const file of appFiles) {
      const code = readFileSync(file, 'utf-8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\bfrom\s*['"]node:/);
      expect(code, file).not.toMatch(/\bimport\s*['"]node:/);
    }
  });

  it('应用面不读 argv/env、不退出进程、不打印、不联网、不 spawn', () => {
    const banned = [
      'process.argv',
      'process.env',
      'process.exit',
      'console.',
      'createServer',
      '.listen(',
      'spawn',
      'fetch(',
      'connectToHost',
      'ensureHostRunning',
      'readFileSync',
      'readFile(',
    ];
    for (const file of listTsFiles(resolve(CLI_SRC_DIR, 'app'))) {
      const code = readFileSync(file, 'utf-8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of banned) {
        expect(code, `${file} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it('公共入口导出应用命令面（纯 re-export，无副作用）', () => {
    const barrel = readFileSync(resolve(CLI_SRC_DIR, 'index.ts'), 'utf-8');
    expect(barrel).toMatch(/app\/index\.js/);
    expect(barrel).not.toMatch(/(?:from|import)\s+['"][^'\"]*(?:execute|bin)\.js['"]/);
  });

  it('UUID 校验复用 Host 单一实现（与契约同一 isUuidV4）', () => {
    expect(isUuidV4(randomUUID())).toBe(true);
    expect(parseAppCliArgs(['project', 'get', randomUUID()]).kind).toBe('command');
  });
});
