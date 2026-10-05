/**
 * F-011 CLI 参数解析、帮助、JSON 信封与退出码回归（契约 §13.1–§13.3）。
 *
 * 本任务只交付「纯解析 + 帮助 + 输出形状」层：
 * - 解析与执行分离：parseHostCliArgs 是同步纯函数（不读 process.argv/env、
 *   不读发现、不访问网络、不启动 Host、不生成 commandId）；
 * - 显式可执行入口（src/bin.ts → dist/bin.js）与 package.json bin 字段属
 *   F-012，本任务不得提前创建；
 * - JSON 模式的 stdout/stderr 路由由 F-012 接线；本任务冻结信封形状、
 *   脱敏纪律与 §13.3 四档退出码映射。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BIND_OVERRIDE_ENV_KEYS,
  CLIENT_ONLY_ERROR_CODES,
  DEFAULT_START_BUDGET_MS,
  SERVER_ERROR_CODES,
  isUuidV4,
} from '../packages/host/src/index.ts';
import {
  CLI_CONFIRM_TIMEOUT_DEFAULT_MS,
  CLI_CONFIRM_TIMEOUT_MAX_MS,
  CLI_CONFIRM_TIMEOUT_MIN_MS,
  CLI_EXIT_CONNECTION,
  CLI_EXIT_INPUT,
  CLI_EXIT_OK,
  CLI_EXIT_REJECTED,
  CLI_START_TIMEOUT_DEFAULT_MS,
  CLI_START_TIMEOUT_MAX_MS,
  CLI_START_TIMEOUT_MIN_MS,
  HOST_CLI_SUBCOMMANDS,
  HostCliParseError,
  buildHostCliFailureEnvelope,
  buildHostCliSuccessEnvelope,
  exitCodeForHostErrorCode,
  formatHostCliParseError,
  getHostCliHelp,
  parseHostCliArgs,
} from '../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

function readCliPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/cli/package.json'), 'utf-8'));
}

function expectParseError(
  args: readonly string[],
  code: 'invalid_input' | 'bind_address_override_rejected',
  reason: string,
  env: Record<string, string | undefined> = {},
): HostCliParseError {
  try {
    parseHostCliArgs(args, env);
  } catch (error) {
    expect(error).toBeInstanceOf(HostCliParseError);
    const parsedError = error as HostCliParseError;
    expect(parsedError.code).toBe(code);
    expect(parsedError.reason).toBe(reason);
    return parsedError;
  }
  throw new Error(`expected parse error ${code}/${reason} for args ${JSON.stringify(args)}`);
}

describe('F-011 命令面（§13.1）', () => {
  it('只暴露 start/status/stop 三个生命周期子命令，不新增 project/run 等命令', () => {
    expect([...HOST_CLI_SUBCOMMANDS]).toEqual(['start', 'status', 'stop']);
    for (const subcommand of HOST_CLI_SUBCOMMANDS) {
      const parsed = parseHostCliArgs(['host', subcommand, '--data-root', '/tmp/root']);
      expect(parsed.kind).toBe('command');
      if (parsed.kind !== 'command') {
        throw new Error('unreachable');
      }
      expect(parsed.command).toBe(subcommand);
      expect(parsed.commandId).toBe(`host.${subcommand}` as const);
    }
  });

  it('解析是同步纯函数：返回值不是 Promise，不隐式读取环境', () => {
    const parsed = parseHostCliArgs(['host', 'status']);
    expect(typeof (parsed as unknown as Promise<unknown>).then).not.toBe('function');
    expect(parseHostCliArgs(['host', 'status'], { SHIPLOOP_HOST_BIND: undefined })).toEqual(parsed);
  });

  it('无参数 = 缺少命令（输入错误），不返回帮助成功', () => {
    const error = expectParseError([], 'invalid_input', 'missing_command');
    expect(error.command).toBeNull();
    expect(error.json).toBe(false);
    expect(exitCodeForHostErrorCode(error.code)).toBe(CLI_EXIT_INPUT);
  });

  it.each([
    [['project'], 'unknown_command'],
    [['run'], 'unknown_command'],
    [['feature'], 'unknown_command'],
    [['start'], 'unknown_command'],
    [['status'], 'unknown_command'],
    [['stop'], 'unknown_command'],
    [['host', 'project'], 'unknown_subcommand'],
    [['host', 'run'], 'unknown_subcommand'],
    [['host', 'start', 'extra'], 'unexpected_positional'],
    [['host', 'status', 'x', 'y'], 'unexpected_positional'],
    [['host', 'stop', '--'], 'unexpected_positional'],
    [['host'], 'missing_subcommand'],
    [['host', '--json'], 'host_level_option'],
    [['host', '--data-root', '/tmp/x', 'start'], 'host_level_option'],
    [['-x'], 'unknown_command'],
  ] as const)('命令结构错误 %j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], 'invalid_input', reason);
  });

  it('未知顶层命令即使带 --json 也是输入错误（command=null，json 尽力识别）', () => {
    const error = expectParseError(['project', '--json'], 'invalid_input', 'unknown_command');
    expect(error.command).toBeNull();
    expect(error.json).toBe(true);
  });
});

describe('F-011 帮助面（§13.1/§13.3）', () => {
  it.each([
    [['--help'], 'top'],
    [['-h'], 'top'],
    [['host', '--help'], 'host'],
    [['host', '-h'], 'host'],
    [['host', 'start', '--help'], 'start'],
    [['host', 'status', '-h'], 'status'],
    [['host', 'stop', '--help'], 'stop'],
    [['host', 'start', '--help', '--json'], 'start'],
  ] as const)('帮助请求 %j → help(scope=%s) 且退出码 0', (args, scope) => {
    const parsed = parseHostCliArgs([...args]);
    expect(parsed).toEqual({ kind: 'help', scope });
  });

  it('帮助文本必须含全部作用域且为非空字符串', () => {
    for (const scope of ['top', 'host', 'start', 'status', 'stop'] as const) {
      const text = getHostCliHelp(scope);
      expect(text.length).toBeGreaterThan(20);
      expect(text.endsWith('\n')).toBe(true);
    }
  });

  it.each(['top', 'host', 'start', 'status', 'stop'] as const)(
    '%s 帮助准确说明客户端退出不停止 Host、显式停止语义、macOS 与可信本机边界',
    (scope) => {
      const text = getHostCliHelp(scope);
      // 退出客户端不会停止 Host。
      expect(text).toMatch(/退出\s*CLI\s*客户端不会停止\s*Host/);
      // 显式停止语义。
      expect(text).toContain('host stop');
      // 首版仅 macOS、可信本机。
      expect(text).toMatch(/macOS/);
      expect(text).toMatch(/可信本机/);
      // token 不防所有同用户攻击。
      expect(text).toMatch(/同一(?:操作系统)?用户/);
      // 固定回环。
      expect(text).toContain('127.0.0.1');
    },
  );

  it('stop 帮助说明 HTTP 回执/连接断开不等于已退出，status 帮助说明不启动 Host', () => {
    const stopHelp = getHostCliHelp('stop');
    expect(stopHelp).toMatch(/不等于已退出|不等于.*退出/);
    expect(stopHelp).toContain('stop_not_confirmed');
    expect(getHostCliHelp('status')).toMatch(/不启动\s*Host/);
  });

  it('帮助列出每个参数的默认值与允许区间（与冻结常量一致）', () => {
    const startHelp = getHostCliHelp('start');
    expect(startHelp).toContain(String(CLI_START_TIMEOUT_DEFAULT_MS));
    expect(startHelp).toContain(String(CLI_START_TIMEOUT_MIN_MS));
    expect(startHelp).toContain(String(CLI_START_TIMEOUT_MAX_MS));
    const stopHelp = getHostCliHelp('stop');
    expect(stopHelp).toContain(String(CLI_CONFIRM_TIMEOUT_DEFAULT_MS));
    expect(stopHelp).toContain(String(CLI_CONFIRM_TIMEOUT_MIN_MS));
    expect(stopHelp).toContain(String(CLI_CONFIRM_TIMEOUT_MAX_MS));
    expect(stopHelp).toMatch(/UUID\s*v4/);
  });

  it('帮助与全部源码/测试文本不含真实 token 形态或开发机绝对路径', () => {
    for (const scope of ['top', 'host', 'start', 'status', 'stop'] as const) {
      const text = getHostCliHelp(scope);
      expect(text).not.toMatch(/[0-9a-f]{64}/);
      expect(text).not.toMatch(/\/Users\//);
      expect(text).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
    }
  });

  it('帮助请求不做 env 覆盖检查（帮助在启动检查之前短路）', () => {
    const parsed = parseHostCliArgs(['host', 'status', '--help'], {
      SHIPLOOP_HOST_PORT: '80',
    });
    expect(parsed).toEqual({ kind: 'help', scope: 'status' });
  });
});

describe('F-011 通用选项解析（§13.2）', () => {
  it('--data-root 接受绝对 POSIX 路径并原样保留（规范化/realpath 属执行层）', () => {
    const parsed = parseHostCliArgs(['host', 'status', '--data-root', '/srv/shiploop/data']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command') {
      expect(parsed.dataRoot).toBe('/srv/shiploop/data');
    }
  });

  it('支持 --option=value 形式', () => {
    const parsed = parseHostCliArgs(['host', 'start', '--data-root=/tmp/x', '--start-timeout-ms=2000']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command' && parsed.command === 'start') {
      expect(parsed.dataRoot).toBe('/tmp/x');
      expect(parsed.startTimeoutMs).toBe(2000);
    }
  });

  it.each([
    [['host', 'status', '--data-root', 'relative/path'], 'data_root_not_absolute'],
    [['host', 'status', '--data-root', './x'], 'data_root_not_absolute'],
    [['host', 'status', '--data-root', '../x'], 'data_root_not_absolute'],
    [['host', 'status', '--data-root='], 'data_root_empty'],
    [['host', 'status', '--data-root', ''], 'data_root_empty'],
    [['host', 'status', '--data-root', '/'], 'data_root_is_filesystem_root'],
    [['host', 'status', '--data-root=/'], 'data_root_is_filesystem_root'],
    [['host', 'status', '--data-root', '/tmp/\0bad'], 'data_root_contains_nul'],
    [['host', 'status', '--data-root'], 'missing_value'],
    [['host', 'status', '--data-root', '--json'], 'missing_value'],
    [['host', 'status', '--data-root', '/a', '--data-root', '/b'], 'duplicate_option'],
  ] as const)('非法数据根 %j → invalid_input/%s', (args, reason) => {
    const error = expectParseError([...args], 'invalid_input', reason);
    expect(error.field).toBe('dataRoot');
  });

  it('数据根错误不回显提供的值（脱敏）', () => {
    const secretish = '/tmp/do-not-echo-this-value';
    const error = expectParseError(
      ['host', 'status', '--data-root', `relative${secretish}`],
      'invalid_input',
      'data_root_not_absolute',
    );
    expect(JSON.stringify(error)).not.toContain(secretish);
    expect(formatHostCliParseError(error)).not.toContain(secretish);
  });

  it('--json 是布尔开关：解析标记 json；带值被拒绝；重复被拒绝', () => {
    const parsed = parseHostCliArgs(['host', 'status', '--json']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command') {
      expect(parsed.json).toBe(true);
    }
    expect(parseHostCliArgs(['host', 'status']).kind === 'command' &&
      (parseHostCliArgs(['host', 'status']) as { json: boolean }).json,
    ).toBe(false);
    expectParseError(['host', 'status', '--json=true'], 'invalid_input', 'bool_flag_takes_no_value');
    expectParseError(['host', 'status', '--json', '--json'], 'invalid_input', 'duplicate_option');
  });

  it.each([
    [['host', 'status', '--unknown'], 'unknown_argument'],
    [['host', 'status', '--unknown=1'], 'unknown_argument'],
    [['host', 'status', '-x'], 'unknown_argument'],
    [['host', 'status', '-'], 'unknown_argument'],
  ] as const)('未知参数 %j → invalid_input/%s', (args, reason) => {
    expectParseError([...args], 'invalid_input', reason);
  });
});

describe('F-011 start 专有选项（§13.2）', () => {
  it('默认 startTimeoutMs 与启动器预算常量一致（15000）', () => {
    expect(CLI_START_TIMEOUT_DEFAULT_MS).toBe(DEFAULT_START_BUDGET_MS);
    expect(CLI_START_TIMEOUT_DEFAULT_MS).toBe(15_000);
    const parsed = parseHostCliArgs(['host', 'start']);
    if (parsed.kind === 'command' && parsed.command === 'start') {
      expect(parsed.startTimeoutMs).toBe(15_000);
    } else {
      throw new Error('expected start command');
    }
  });

  it.each([
    ['1000', 1000],
    ['60000', 60_000],
    ['2500', 2500],
  ])('接受边界内整数 --start-timeout-ms=%s', (value, expected) => {
    const parsed = parseHostCliArgs(['host', 'start', '--start-timeout-ms', value]);
    if (parsed.kind !== 'command' || parsed.command !== 'start') {
      throw new Error('expected start command');
    }
    expect(parsed.startTimeoutMs).toBe(expected);
  });

  it.each([
    ['999', 'integer_out_of_range'],
    ['60001', 'integer_out_of_range'],
    ['0', 'integer_out_of_range'],
    ['-1', 'missing_value'],
    ['1.5', 'invalid_integer'],
    ['abc', 'invalid_integer'],
    ['1e3', 'invalid_integer'],
    ['0x10', 'invalid_integer'],
    ['+5', 'invalid_integer'],
    ['', 'invalid_integer'],
  ] as const)('拒绝非法 --start-timeout-ms=%j → %s', (value, reason) => {
    const args =
      value === ''
        ? (['host', 'start', '--start-timeout-ms='] as const)
        : (['host', 'start', '--start-timeout-ms', value] as const);
    const error = expectParseError([...args], 'invalid_input', reason);
    expect(error.field).toBe('startTimeoutMs');
  });

  it('--start-timeout-ms 缺值与重复拒绝', () => {
    expectParseError(['host', 'start', '--start-timeout-ms'], 'invalid_input', 'missing_value');
    expectParseError(
      ['host', 'start', '--start-timeout-ms', '2000', '--start-timeout-ms', '3000'],
      'invalid_input',
      'duplicate_option',
    );
  });

  it.each(['status', 'stop'] as const)('--start-timeout-ms 不能用于 %s', (subcommand) => {
    const error = expectParseError(
      ['host', subcommand, '--start-timeout-ms', '2000'],
      'invalid_input',
      'option_not_allowed_for_command',
    );
    expect(error.field).toBe('startTimeoutMs');
    expect(error.command).toBe(subcommand);
  });
});

describe('F-011 stop 专有选项（§13.2/§10）', () => {
  it('默认 confirmTimeoutMs=10000；stopCommandId 省略（执行层生成），解析层不生成 UUID', () => {
    const parsed = parseHostCliArgs(['host', 'stop']);
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command' && parsed.command === 'stop') {
      expect(parsed.confirmTimeoutMs).toBe(CLI_CONFIRM_TIMEOUT_DEFAULT_MS);
      expect(parsed.stopCommandId).toBeUndefined();
    }
    expect(CLI_CONFIRM_TIMEOUT_DEFAULT_MS).toBe(10_000);
    expect(CLI_CONFIRM_TIMEOUT_MIN_MS).toBe(0);
    expect(CLI_CONFIRM_TIMEOUT_MAX_MS).toBe(30_000);
  });

  it('--stop-command-id 接受 UUID v4（与契约同一 isUuidV4 实现）', () => {
    const commandId = randomUUID();
    expect(isUuidV4(commandId)).toBe(true);
    const parsed = parseHostCliArgs(['host', 'stop', '--stop-command-id', commandId]);
    if (parsed.kind !== 'command' || parsed.command !== 'stop') {
      throw new Error('expected stop command');
    }
    expect(parsed.stopCommandId).toBe(commandId);
  });

  it.each([
    ['not-a-uuid'],
    ['00000000-0000-0000-0000-000000000000'], // nil UUID
    ['123e4567-e89b-11d1-a456-426614174000'], // v1（版本位不是 4）
    ['123E4567-E89B-41D1-A456-426614174000'], // 大写
    ['123e4567e89b41d1a456426614174000'],
  ])('--stop-command-id 拒绝非 UUID v4：%j', (value) => {
    const error = expectParseError(
      ['host', 'stop', '--stop-command-id', value],
      'invalid_input',
      'invalid_stop_command_id',
    );
    expect(error.field).toBe('stopCommandId');
  });

  it.each([
    [['host', 'stop', '--stop-command-id'], 'missing_value'],
    [['host', 'stop', '--stop-command-id', randomUUID(), '--stop-command-id', randomUUID()], 'duplicate_option'],
  ] as const)('%j → %s', (args, reason) => {
    expectParseError([...args], 'invalid_input', reason);
  });

  it.each(['start', 'status'] as const)('--stop-command-id 不能用于 %s', (subcommand) => {
    const error = expectParseError(
      ['host', subcommand, '--stop-command-id', randomUUID()],
      'invalid_input',
      'option_not_allowed_for_command',
    );
    expect(error.field).toBe('stopCommandId');
  });

  it.each([
    ['0', 0],
    ['30000', 30_000],
    ['1500', 1500],
  ])('--confirm-timeout-ms 接受边界值 %s', (value, expected) => {
    const parsed = parseHostCliArgs(['host', 'stop', '--confirm-timeout-ms', value]);
    if (parsed.kind !== 'command' || parsed.command !== 'stop') {
      throw new Error('expected stop command');
    }
    expect(parsed.confirmTimeoutMs).toBe(expected);
  });

  it.each([
    ['-1', 'missing_value'],
    ['30001', 'integer_out_of_range'],
    ['1.0', 'invalid_integer'],
    ['abc', 'invalid_integer'],
  ] as const)('拒绝非法 --confirm-timeout-ms=%j → %s', (value, reason) => {
    const error = expectParseError(
      ['host', 'stop', '--confirm-timeout-ms', value],
      'invalid_input',
      reason,
    );
    expect(error.field).toBe('confirmTimeoutMs');
  });

  it.each(['start', 'status'] as const)('--confirm-timeout-ms 不能用于 %s', (subcommand) => {
    expectParseError(
      ['host', subcommand, '--confirm-timeout-ms', '1000'],
      'invalid_input',
      'option_not_allowed_for_command',
    );
  });
});

describe('F-011 监听地址覆盖零容忍（§13.2/T23）', () => {
  const overrideArguments = [
    '--bind',
    '--bind=0.0.0.0',
    '--bind-address',
    '--bind-address=0.0.0.0',
    '--host',
    '--host=example.com',
    '--hostname',
    '--hostname=::',
    '--address',
    '--address=192.168.1.1',
    '--port',
    '--port=8080',
    '--listen',
    '--listen-address=0.0.0.0',
    '--listen-foo',
  ] as const;

  it.each(['start', 'status', 'stop'] as const)('任何覆盖参数在 %s 都被拒绝（退出码 2）', (subcommand) => {
    for (const argument of overrideArguments) {
      const args =
        argument === '--bind' || argument === '--host' || argument === '--address' || argument === '--port' || argument === '--listen' || argument === '--hostname' || argument === '--bind-address'
          ? ['host', subcommand, argument, argument === '--port' ? '8080' : '0.0.0.0']
          : ['host', subcommand, argument];
      const error = expectParseError(args, 'bind_address_override_rejected', 'listen_override_argument_rejected');
      expect(error.command).toBe(subcommand);
      // 覆盖值不回显。
      expect(JSON.stringify(error)).not.toContain('192.168.1.1');
      expect(exitCodeForHostErrorCode(error.code)).toBe(CLI_EXIT_INPUT);
    }
  });

  it('覆盖参数检测先于未知参数（安全 fail-closed），且不回显覆盖值', () => {
    const error = expectParseError(
      ['host', 'status', '--bind', '0.0.0.0', '--totally-unknown'],
      'bind_address_override_rejected',
      'listen_override_argument_rejected',
    );
    expect(JSON.stringify(error)).not.toContain('0.0.0.0');
  });

  it('CLI 使用的 env 覆盖键表与 Host 启动器冻结表单一来源', () => {
    expect([...BIND_OVERRIDE_ENV_KEYS]).toEqual([
      'SHIPLOOP_HOST_BIND',
      'SHIPLOOP_HOST_HOST',
      'SHIPLOOP_HOST_PORT',
      'SHIPLOOP_HOST_ADDRESS',
      'SHIPLOOP_HOST_LISTEN',
      'SHIPLOOP_HOST_LISTEN_ADDRESS',
    ]);
  });

  it.each([...BIND_OVERRIDE_ENV_KEYS])('非空环境变量覆盖 %s 在三个命令均拒绝', (name) => {
    for (const subcommand of ['start', 'status', 'stop'] as const) {
      const error = expectParseError(
        ['host', subcommand],
        'bind_address_override_rejected',
        'listen_override_env_rejected',
        { [name]: name.endsWith('PORT') ? '8080' : '0.0.0.0' },
      );
      expect(error.field).toBe(name);
      expect(JSON.stringify(error)).not.toContain('0.0.0.0');
      expect(JSON.stringify(error)).not.toContain('8080');
    }
  });

  it('空/未设置的覆盖键不拒绝（非空才是覆盖尝试）', () => {
    expect(
      parseHostCliArgs(['host', 'status'], {
        SHIPLOOP_HOST_BIND: '',
        SHIPLOOP_HOST_PORT: undefined,
      }).kind,
    ).toBe('command');
  });
});

describe('F-011 JSON 信封与 §13.3 退出码', () => {
  it('成功信封：单行可解析 JSON，形状固定', () => {
    const line = JSON.stringify(buildHostCliSuccessEnvelope('host.start', { outcome: 'already_running' }));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: true, command: 'host.start', result: { outcome: 'already_running' } });
    expect(line).not.toContain('\n');
  });

  it('失败信封：command 可为 null（命令未知时），错误只含受控字段', () => {
    const line = JSON.stringify(
      buildHostCliFailureEnvelope(null, 'invalid_input', '参数未通过校验', { reason: 'missing_command' }),
    );
    const parsed = JSON.parse(line) as {
      ok: boolean;
      command: string | null;
      error: Record<string, unknown>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBeNull();
    expect(parsed.error.code).toBe('invalid_input');
    expect(parsed.error.message).toBe('参数未通过校验');
    expect(parsed.error.details).toEqual({ reason: 'missing_command' });
    expect(line).not.toContain('stack');
  });

  it('解析失败带 --json 时错误携带 json 路由标记（stdout 信封）；否则走 stderr 人类诊断', () => {
    const withoutJson = expectParseError(['host', 'status', '--bad'], 'invalid_input', 'unknown_argument');
    expect(withoutJson.json).toBe(false);
    const withJson = expectParseError(
      ['host', 'status', '--json', '--bad'],
      'invalid_input',
      'unknown_argument',
    );
    expect(withJson.json).toBe(true);
    expect(withJson.command).toBe('status');
    const human = formatHostCliParseError(withoutJson);
    expect(human).toContain('invalid_input');
    expect(human).toContain('unknown_argument');
    expect(human.endsWith('\n')).toBe(true);
  });

  it('§13.3 退出码 0 = 成功', () => {
    expect(CLI_EXIT_OK).toBe(0);
  });

  const EXIT_2_CODES = [
    'invalid_input',
    'unsafe_discovery',
    'invalid_discovery',
    'bind_address_override_rejected',
  ] as const;
  const EXIT_3_CODES = [
    'host_not_found',
    'unreachable',
    'response_malformed',
    'redirect_rejected',
    'start_timeout',
    'protocol_incompatible',
    'unsupported_schema_version',
  ] as const;

  it('退出码映射穷尽 §14 全部错误码（新增码必须显式归类）', () => {
    const allCodes = [...SERVER_ERROR_CODES, ...CLIENT_ONLY_ERROR_CODES] as readonly string[];
    expect(new Set(allCodes).size).toBe(allCodes.length);
    const classified = new Set<string>([...EXIT_2_CODES, ...EXIT_3_CODES]);
    for (const code of allCodes) {
      const exitCode = exitCodeForHostErrorCode(code);
      expect([CLI_EXIT_REJECTED, CLI_EXIT_INPUT, CLI_EXIT_CONNECTION]).toContain(exitCode);
      if (!classified.has(code)) {
        expect(exitCode, `${code} 未显式归类时按业务失败（1）`).toBe(CLI_EXIT_REJECTED);
      }
    }
  });

  it.each([...EXIT_2_CODES])('%s → 退出码 2（输入错误/本地不安全发现）', (code) => {
    expect(exitCodeForHostErrorCode(code)).toBe(CLI_EXIT_INPUT);
  });

  it.each([...EXIT_3_CODES])('%s → 退出码 3（连接/协议错误）', (code) => {
    expect(exitCodeForHostErrorCode(code)).toBe(CLI_EXIT_CONNECTION);
  });

  it('其余 §14 错误码全部 → 退出码 1（业务拒绝/操作失败）', () => {
    const exit1Codes = [
      ...SERVER_ERROR_CODES,
      ...CLIENT_ONLY_ERROR_CODES,
    ].filter((code) => ![...EXIT_2_CODES, ...EXIT_3_CODES].includes(code as never));
    expect(exit1Codes.length).toBeGreaterThan(0);
    for (const code of exit1Codes) {
      expect(exitCodeForHostErrorCode(code)).toBe(CLI_EXIT_REJECTED);
    }
  });

  it('未知错误码不折算成功/输入/连接，fail-closed → 1', () => {
    expect(exitCodeForHostErrorCode('some_future_code')).toBe(CLI_EXIT_REJECTED);
  });
});

describe('F-011 公共模块边界（解析/执行分离、零副作用）', () => {
  it('F-012 之前不存在显式执行入口 bin.ts，package.json 也不预声明 bin', () => {
    for (const file of listTsFiles(CLI_SRC_DIR)) {
      expect(file.endsWith('bin.ts')).toBe(false);
    }
    const pkg = readCliPackageJson();
    expect(pkg.bin).toBeUndefined();
    // 仅声明 shiploop-host 工作区依赖（公共面），不直连 core，无第三方依赖。
    expect(pkg.dependencies).toEqual({ 'shiploop-host': '0.0.0' });
  });

  it('CLI 生产源码不直接导入任何 node 内置模块（纯解析/帮助/输出层）', () => {
    const files = listTsFiles(CLI_SRC_DIR);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const code = readFileSync(file, 'utf-8');
      const withoutComments = code
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(withoutComments, file).not.toMatch(/\bfrom\s*['"]node:/);
      expect(withoutComments, file).not.toMatch(/\bimport\s*['"]node:/);
    }
  });

  it('CLI 生产源码唯一外部包依赖是 shiploop-host 公共面（不引用内部子路径、不直连 core）', () => {
    const specifierPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
    for (const file of listTsFiles(CLI_SRC_DIR)) {
      const code = readFileSync(file, 'utf-8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const match of code.matchAll(specifierPattern)) {
        const specifier = match[1] as string;
        if (specifier.startsWith('.')) {
          continue;
        }
        expect(specifier, `${file} -> ${specifier}`).toBe('shiploop-host');
      }
    }
  });

  it('CLI 生产源码不读 argv/env、不退出进程、不打印、不联网、不 spawn', () => {
    const bannedTokens = [
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
      'startHost',
    ];
    for (const file of listTsFiles(CLI_SRC_DIR)) {
      const code = readFileSync(file, 'utf-8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      for (const token of bannedTokens) {
        expect(code, `${file} must not contain ${token}`).not.toContain(token);
      }
      expect(statSync(file).isFile()).toBe(true);
    }
  });
});
