/**
 * F-015 基线 CLI 纯面层（契约 §6.1/§7.4/§7.5/§7.6/§8、§12.1/§12.2/§12.3）。
 *
 * 本任务只交付「输入文件/argv + 独立授权 + 查询/取消参数 + 结果格式化」纯函数层：
 * - `parseAppCliArgs` 仍是同步纯函数：基线预览、确认、启动、状态、历史分页与
 *   显式取消参数解析失败在发现 Host/联网/启动进程之前抛 AppCliParseError；
 * - 命令输入无损表达带空格/中文/特殊字符的 argv（JSON 字符串数组原样保留），
 *   绝不把用户字符串重新拼接为 shell 命令行；
 * - 独立授权：`--confirm`/`--decline` 互斥且必居其一，确认注册不隐含确认基线，
 *   非交互必须显式批准，EOF/拒绝不默认执行；
 * - JSON 输出区分 accepted、活动、passed、failed、not_run、timeout、cancelled
 *   与停止未确认，保留 operationId/结果引用；not_run 不折算成功检查；
 * - 解析/校验失败不启动 Host 或进程；不从配置/仓库文本提取凭据、不自动追加
 *   安装命令。
 *
 * 除「零副作用」一节显式驱动 runAppCli 外，全部为纯函数表驱动用例，
 * 不接触真实 Host、SQLite、Git 或网络。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
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
  baselineCliExitCode,
  buildBaselineCommandResult,
  buildBaselineEvidenceResult,
  buildBaselineListResult,
  buildBaselineOperationResult,
  buildBaselinePreviewResult,
  buildBaselineRunConfirmationNotice,
  classifyBaselineState,
  describeBaselineState,
  exitCodeForAppErrorCode,
  formatArgvLossless,
  formatBaselineCommandResult,
  formatBaselineListResult,
  formatBaselineOperationResult,
  formatBaselinePreview,
  getAppCliHelp,
  parseAppCliArgs,
  parseBaselineCheckPlanText,
  resolveBaselineAuthorization,
  composeAppCliStreams,
  toBaselineDecision,
  validateBaselineCancelObject,
  validateBaselineCheckPlanObject,
  type BaselineCheckInputView,
  type BaselineCheckPlanView,
  type BaselineCheckResultView,
  type BaselineCheckStatusView,
  type BaselineDisplayState,
  type BaselineOperationStatusView,
  type BaselineOperationView,
  type BaselinePreviewWireView,
} from '../../../packages/cli/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const PROJECT_ID = randomUUID();
const OPERATION_ID = randomUUID();
const COMMAND_ID = randomUUID();

/* ------------------------------------------------------------------ *
 * 参数解析（§12.1/§12.2）
 * ------------------------------------------------------------------ */

describe('F-015 基线 CLI 参数解析（§12.1，解析先于任何 I/O）', () => {
  it('暴露 baseline 顶层命令与六个子命令身份（点分 CLI 路径）', () => {
    expect([...APP_CLI_COMMANDS]).toContain('baseline');
    for (const id of [
      'baseline.preview',
      'baseline.run',
      'baseline.list',
      'baseline.status',
      'baseline.cancel',
      'baseline.evidence',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
    }
  });

  it('baseline preview：--project + --input', () => {
    expect(
      parseAppCliArgs(['baseline', 'preview', '--project', PROJECT_ID, '--input', '/tmp/plan.json']),
    ).toEqual({
      kind: 'command',
      command: 'baseline',
      commandId: 'baseline.preview',
      operation: 'baseline.preview',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      inputFile: '/tmp/plan.json',
    });
  });

  it('baseline run：独立决策参数 + --wait/--follow/--command-id（不与注册确认混用）', () => {
    const authorize = parseAppCliArgs([
      'baseline',
      'run',
      '--project',
      PROJECT_ID,
      '--input',
      '/tmp/计划 文件.json',
      '--confirm',
      '--wait',
      '--follow',
      '--command-id',
      COMMAND_ID,
      '--json',
    ]);
    expect(authorize).toEqual({
      kind: 'command',
      command: 'baseline',
      commandId: 'baseline.run',
      operation: 'baseline.run',
      json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      inputFile: '/tmp/计划 文件.json',
      decision: 'authorize',
      wait: true,
      follow: true,
      explicitCommandId: COMMAND_ID,
    });

    const decline = parseAppCliArgs([
      'baseline',
      'run',
      '--project',
      PROJECT_ID,
      '--input',
      '/tmp/plan.json',
      '--decline',
    ]);
    expect(decline).toMatchObject({ decision: 'decline', wait: false, follow: false });
  });

  it('baseline list/status/cancel/evidence：分页、显式取消与证据引用', () => {
    expect(
      parseAppCliArgs([
        'baseline',
        'list',
        '--project',
        PROJECT_ID,
        '--limit',
        '20',
        '--cursor',
        OPERATION_ID,
      ]),
    ).toEqual({
      kind: 'command',
      command: 'baseline',
      commandId: 'baseline.list',
      json: false,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
      projectId: PROJECT_ID,
      limit: 20,
      cursor: OPERATION_ID,
    });

    expect(parseAppCliArgs(['baseline', 'status', OPERATION_ID])).toMatchObject({
      commandId: 'baseline.status',
      operationId: OPERATION_ID,
    });

    expect(
      parseAppCliArgs(['baseline', 'cancel', OPERATION_ID, '--confirm', '--command-id', COMMAND_ID]),
    ).toMatchObject({
      commandId: 'baseline.cancel',
      operation: 'baseline.cancel',
      operationId: OPERATION_ID,
      explicitCommandId: COMMAND_ID,
    });

    expect(
      parseAppCliArgs(['baseline', 'evidence', 'artifact-1.a_b', '--json']),
    ).toMatchObject({ commandId: 'baseline.evidence', artifactId: 'artifact-1.a_b', json: true });
  });

  it.each([
    [['baseline'], 'missing_subcommand'],
    [['baseline', 'nope'], 'unknown_subcommand'],
    [['baseline', 'run'], 'missing_required_option'],
    [['baseline', 'preview', '--project', PROJECT_ID], 'missing_required_option'],
    [['baseline', 'preview', '--input', '/tmp/plan.json'], 'missing_required_option'],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json'],
      'missing_required_option',
    ],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--confirm', '--decline'],
      'conflicting_options',
    ],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--decline', '--confirm'],
      'conflicting_options',
    ],
    [
      ['baseline', 'run', '--project', 'not-a-uuid', '--input', '/tmp/p.json', '--confirm'],
      'invalid_project_id',
    ],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--confirm', '--confirm'],
      'duplicate_option',
    ],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--confirm', '--command-id', 'nope'],
      'invalid_command_id',
    ],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--confirm', '--model', 'x'],
      'unknown_argument',
    ],
    [
      ['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--confirm', '--skills', 'ts'],
      'unknown_argument',
    ],
    [['baseline', 'list', '--project', PROJECT_ID, '--limit', '0'], 'invalid_baseline_limit'],
    [['baseline', 'list', '--project', PROJECT_ID, '--limit', '101'], 'invalid_baseline_limit'],
    [['baseline', 'list', '--project', PROJECT_ID, '--limit', 'x'], 'invalid_baseline_limit'],
    [['baseline', 'list', '--project', PROJECT_ID, '--limit', '1.5'], 'invalid_baseline_limit'],
    [['baseline', 'list', '--project', PROJECT_ID, '--cursor', ''], 'invalid_cursor'],
    [['baseline', 'list', '--limit', '20'], 'missing_required_option'],
    [['baseline', 'status'], 'missing_positional'],
    [['baseline', 'status', 'not-a-uuid'], 'invalid_operation_id'],
    [['baseline', 'status', OPERATION_ID, 'extra'], 'too_many_positionals'],
    [['baseline', 'cancel', OPERATION_ID], 'missing_required_option'],
    [['baseline', 'cancel', 'not-a-uuid', '--confirm'], 'invalid_operation_id'],
    [['baseline', 'cancel', OPERATION_ID, '--confirm', '--confirm'], 'duplicate_option'],
    [['baseline', 'evidence'], 'missing_positional'],
    [['baseline', 'evidence', 'bad/id!'], 'invalid_artifact_id'],
    [['baseline', 'evidence', ''], 'invalid_artifact_id'],
    [
      ['baseline', 'preview', '--project', PROJECT_ID, '--input', '/tmp/p.json', '--bind', '0.0.0.0'],
      'listen_override_argument_rejected',
    ],
    [['baseline', 'run', '--json=1'], 'bool_flag_takes_no_value'],
    [['baseline', 'status', OPERATION_ID, '--follow'], 'unknown_argument'],
  ] as const)('非法参数 %j → invalid_input/%s', (args, reason) => {
    try {
      parseAppCliArgs([...args]);
      throw new Error(`expected parse error ${reason} for ${JSON.stringify(args)}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppCliParseError);
      const parsed = error as AppCliParseError;
      expect(parsed.reason).toBe(reason);
      if (reason === 'listen_override_argument_rejected') {
        expect(parsed.code).toBe('bind_address_override_rejected');
      } else {
        expect(parsed.code).toBe('invalid_input');
      }
    }
  });

  it('帮助令牌返回 baseline 作用域；帮助说明独立授权与观察纪律', () => {
    expect(parseAppCliArgs(['baseline', '--help'])).toEqual({ kind: 'help', scope: 'baseline' });
    expect(parseAppCliArgs(['baseline', 'run', '--help'])).toEqual({
      kind: 'help',
      scope: 'baseline.run',
    });
    const runHelp = getAppCliHelp('baseline.run');
    expect(runHelp).toMatch(/--confirm/);
    expect(runHelp).toMatch(/--decline/);
    expect(runHelp).toMatch(/确认注册不隐含确认基线/);
    expect(runHelp).toMatch(/观察中断/);
    expect(runHelp).toMatch(/baseline cancel/);
    expect(runHelp).toMatch(/不自动安装依赖/);
    for (const scope of [
      'baseline',
      'baseline.preview',
      'baseline.run',
      'baseline.list',
      'baseline.status',
      'baseline.cancel',
      'baseline.evidence',
    ] as const) {
      const text = getAppCliHelp(scope);
      expect(text.length).toBeGreaterThan(20);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toMatch(/\/Users\//);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 输入文件/argv（§6.1/§12.2；argv 无损、不 shell 拼接）
 * ------------------------------------------------------------------ */

const LOSSLESS_ARGV = [
  'node',
  './脚本 tool.js',
  '--标题=含 空格 与中文',
  "$(rm -rf /)",
  "it's \"quoted\"",
  'a\tb|c&&d',
  '--flag=值',
];

/** JSON 输入夹具：故意非法的字段/类型也需可表达，故用宽松对象（校验层负责拒绝）。 */
function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkKey: 'build',
    kind: 'command',
    argv: ['node', 'script.js'],
    timeoutMs: 60_000,
    required: true,
    ...overrides,
  };
}

describe('F-015 基线输入文件/argv 校验（错误 JSON/Schema、空命令、非法超时）', () => {
  it('argv 无损：带空格/中文/特殊字符的参数原样保留，不重新 shell 拼接', () => {
    const plan = parseBaselineCheckPlanText(
      JSON.stringify({ checks: [check({ argv: LOSSLESS_ARGV })] }),
      { commandId: 'baseline.run' },
    );
    expect([...plan.checks[0]!.argv]).toEqual(LOSSLESS_ARGV);
    const rendered = formatArgvLossless(plan.checks[0]!.argv);
    expect(rendered).toBe(JSON.stringify(LOSSLESS_ARGV));
    expect(rendered).not.toContain('sh -c');
    expect(rendered).not.toContain('bash -c');
    expect(rendered).not.toContain('node ./脚本 tool.js');
  });

  it.each([
    ['{ not json', 'invalid_input_json'],
    ['[]', 'invalid_input_json'],
    ['null', 'invalid_input_json'],
    ['"plan"', 'invalid_input_json'],
    [JSON.stringify({ checks: 'nope' }), 'invalid_check_plan'],
    [JSON.stringify({}), 'invalid_check_plan'],
    [JSON.stringify({ checks: [] }), 'invalid_check_plan'],
    [
      JSON.stringify({ checks: Array.from({ length: 65 }, (_, i) => check({ checkKey: `c${i}` })) }),
      'invalid_check_plan',
    ],
    [JSON.stringify({ checks: [check()], extra: 1 }), 'unknown_input_field'],
    [JSON.stringify({ checks: [check({ nope: 1 })] }), 'unknown_input_field'],
    [JSON.stringify({ checks: [check({ resultRef: 'v1.abc' })] }), 'unknown_input_field'],
    [JSON.stringify({ checks: [check({ databasePath: '/tmp/db.sqlite' })] }), 'unknown_input_field'],
    [JSON.stringify({ checks: [check({ token: 'secret-value' })] }), 'input_secret_field_rejected'],
    [JSON.stringify({ checks: [check({ environment: { TOKEN: 'x' } })] }), 'input_secret_field_rejected'],
    [JSON.stringify({ checks: [check({ credentials: 'x' })] }), 'input_secret_field_rejected'],
    [JSON.stringify({ checks: [check({ principal: 'admin' })] }), 'input_identity_field_rejected'],
    [JSON.stringify({ checks: [check({ capabilities: ['run'] })] }), 'input_identity_field_rejected'],
    [JSON.stringify({ checks: [{ kind: 'command', argv: ['x'], timeoutMs: 1, required: true }] }), 'invalid_check_key'],
    [JSON.stringify({ checks: [check({ checkKey: 'Bad Key' })] }), 'invalid_check_key'],
    [JSON.stringify({ checks: [check(), check()] }), 'duplicate_check_key'],
    [JSON.stringify({ checks: [check({ kind: 'script' })] }), 'invalid_check_kind'],
    [JSON.stringify({ checks: [check({ argv: [] })] }), 'empty_command'],
    [JSON.stringify({ checks: [check({ argv: ['  '] })] }), 'empty_command'],
    [JSON.stringify({ checks: [check({ argv: ['ok', ''] })] }), 'empty_command'],
    [JSON.stringify({ checks: [check({ argv: [42] })] }), 'invalid_argv'],
    [JSON.stringify({ checks: [check({ argv: ['a\0b'] })] }), 'invalid_argv'],
    [JSON.stringify({ checks: [check({ timeoutMs: 0 })] }), 'invalid_check_timeout'],
    [JSON.stringify({ checks: [check({ timeoutMs: 3_600_001 })] }), 'invalid_check_timeout'],
    [JSON.stringify({ checks: [check({ timeoutMs: '1000' })] }), 'invalid_check_timeout'],
    [JSON.stringify({ checks: [check({ timeoutMs: 1.5 })] }), 'invalid_check_timeout'],
    [JSON.stringify({ checks: [check({ required: 'yes' })] }), 'invalid_required'],
    [JSON.stringify({ checks: [check({ cwdRef: '../etc' })] }), 'invalid_cwd_ref'],
    [JSON.stringify({ checks: [check({ cwdRef: '/abs' })] }), 'invalid_cwd_ref'],
    [JSON.stringify({ checks: [check({ cwdRef: 'a/../b' })] }), 'invalid_cwd_ref'],
    [JSON.stringify({ checks: [check({ environmentRef: '' })] }), 'invalid_environment_ref'],
    [JSON.stringify({ checks: [check({ environmentRef: 'A\0B' })] }), 'invalid_environment_ref'],
  ] as const)('非法输入 %j → invalid_input/%s', (text, reason) => {
    try {
      parseBaselineCheckPlanText(text, { commandId: 'baseline.run' });
      throw new Error(`expected ${reason}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppCliParseError);
      const parsed = error as AppCliParseError;
      expect(parsed.reason).toBe(reason);
      expect(parsed.code).toBe('invalid_input');
    }
  });

  it('合法计划（含可选 cwdRef/environmentRef）规范化保留 argv 原文', () => {
    const plan = validateBaselineCheckPlanObject(
      {
        checks: [
          check({ checkKey: 'lint', argv: LOSSLESS_ARGV, cwdRef: 'packages/cli', environmentRef: 'ci-allowlist' }),
          check({ checkKey: 'test', required: false }),
        ],
      },
      { commandId: 'baseline.preview' },
    );
    expect(plan.checks).toHaveLength(2);
    expect([...plan.checks[0]!.argv]).toEqual(LOSSLESS_ARGV);
    expect(plan.checks[0]!.cwdRef).toBe('packages/cli');
    expect(plan.checks[0]!.environmentRef).toBe('ci-allowlist');
    expect(Object.keys(plan.checks[1]!)).toEqual(['checkKey', 'kind', 'argv', 'timeoutMs', 'required']);
  });
});

/* ------------------------------------------------------------------ *
 * 取消对象（§6；显式取消的请求对象）
 * ------------------------------------------------------------------ */

describe('F-015 取消对象校验（显式取消）', () => {
  it('接受 {operationId}（UUID v4）', () => {
    expect(validateBaselineCancelObject({ operationId: OPERATION_ID }, { commandId: 'baseline.cancel' })).toEqual({
      operationId: OPERATION_ID,
    });
  });

  it.each([
    ['null', 'invalid_input_json'],
    ['[]', 'invalid_input_json'],
    ['"id"', 'invalid_input_json'],
    [JSON.stringify({}), 'invalid_operation_id'],
    [JSON.stringify({ operationId: 'not-a-uuid' }), 'invalid_operation_id'],
    [JSON.stringify({ operationId: 42 }), 'invalid_operation_id'],
    [JSON.stringify({ operationId: OPERATION_ID, extra: 1 }), 'unknown_input_field'],
    [JSON.stringify({ operationId: OPERATION_ID, token: 'x' }), 'input_secret_field_rejected'],
    [JSON.stringify({ operationId: OPERATION_ID, principal: 'root' }), 'input_identity_field_rejected'],
  ] as const)('非法取消对象 %s → invalid_input/%s', (text, reason) => {
    try {
      validateBaselineCancelObject(JSON.parse(text), { commandId: 'baseline.cancel' });
      throw new Error(`expected ${reason}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppCliParseError);
      expect((error as AppCliParseError).reason).toBe(reason);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 独立授权（§12.1：确认注册不隐含确认基线；EOF/拒绝不默认执行）
 * ------------------------------------------------------------------ */

describe('F-015 基线独立授权（非交互显式批准）', () => {
  it.each([
    [{ confirmFlag: true, declineFlag: false, interactive: false }, 'authorize'],
    [{ confirmFlag: false, declineFlag: true, interactive: false }, 'decline'],
    [{ confirmFlag: true, declineFlag: true, interactive: false }, 'not_run:conflicting_flags'],
    [{ confirmFlag: false, declineFlag: false, interactive: false }, 'not_run:non_interactive'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: null }, 'not_run:no_input'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: '' }, 'not_run:no_input'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: 'y' }, 'not_run:confirm_flag_required'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: 'yes' }, 'not_run:confirm_flag_required'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: 'n' }, 'not_run:declined'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: 'no' }, 'not_run:declined'],
    [{ confirmFlag: false, declineFlag: false, interactive: true, answer: '是' }, 'not_run:declined'],
  ] as const)('决策表 %j → %s', (input, expected) => {
    const outcome = resolveBaselineAuthorization({ ...input });
    if (expected === 'authorize') {
      expect(outcome).toEqual({ outcome: 'authorize', source: 'explicit_flag', scope: 'baseline.run' });
      expect(toBaselineDecision(outcome)).toBe('authorize');
    } else if (expected === 'decline') {
      expect(outcome).toEqual({ outcome: 'decline', source: 'explicit_flag' });
      expect(toBaselineDecision(outcome)).toBe('decline');
    } else {
      expect(outcome).toEqual({
        outcome: 'not_run',
        reason: expected.slice('not_run:'.length),
      });
      expect(toBaselineDecision(outcome)).toBe('decline');
    }
  });

  it('确认注册不隐含确认基线；EOF/拒绝不默认执行（文案与解析入口一致）', () => {
    const notice = buildBaselineRunConfirmationNotice();
    expect(notice).toMatch(/确认注册（project init --confirm）不隐含确认基线/);
    expect(notice).toMatch(/EOF/);
    expect(notice).toMatch(/绝不默认执行/);
    // project init 的确认旗不产生任何基线决策；baseline run 必须自带决策。
    expect(() =>
      parseAppCliArgs(['baseline', 'run', '--project', PROJECT_ID, '--input', '/tmp/p.json']),
    ).toThrow(AppCliParseError);
    const initParsed = parseAppCliArgs(['project', 'init', '/tmp/repo', '--confirm']);
    expect(initParsed).toMatchObject({ commandId: 'project.init', confirm: true });
    expect(initParsed).not.toHaveProperty('decision');
  });
});

/* ------------------------------------------------------------------ *
 * 结果格式化（§8/§12.3：八态区分、operationId/结果引用、码表）
 * ------------------------------------------------------------------ */

function checkResult(overrides: Partial<BaselineCheckResultView> = {}): BaselineCheckResultView {
  return {
    checkKey: 'build',
    argv: ['node', 'script.js'],
    cwdRef: null,
    environmentRef: null,
    timeoutMs: 60_000,
    required: true,
    status: 'passed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    output: { artifactId: randomUUID(), byteSize: 12, truncated: false },
    tail: 'ok',
    startedAt: '2026-10-10T00:00:00.000Z',
    endedAt: '2026-10-10T00:00:01.000Z',
    durationMs: 1000,
    ...overrides,
  };
}

function operation(overrides: Partial<BaselineOperationView> = {}): BaselineOperationView {
  return {
    operationId: OPERATION_ID,
    kind: 'baseline',
    status: 'completed',
    createdAt: '2026-10-10T00:00:00.000Z',
    startedAt: '2026-10-10T00:00:00.000Z',
    endedAt: '2026-10-10T00:00:01.000Z',
    summary: { total: 1, passed: 1, failed: 0, error: 0, inconclusive: 0, notRun: 0 },
    ...overrides,
  };
}

describe('F-015 基线结果格式化（八态区分 + 保留引用 + not_run 不折算）', () => {
  it.each([
    ['accepted', { status: 'accepted' as BaselineOperationStatusView }, 'accepted'],
    ['活动(running)', { status: 'running' as BaselineOperationStatusView }, 'active'],
    ['活动(cancelling)', { status: 'cancelling' as BaselineOperationStatusView }, 'active'],
    [
      'passed',
      { status: 'completed' as BaselineOperationStatusView, checks: [checkResult()] },
      'passed',
    ],
    ['failed', { status: 'failed' as BaselineOperationStatusView }, 'failed'],
    ['failed(interrupted)', { status: 'interrupted' as BaselineOperationStatusView }, 'failed'],
    [
      'not_run',
      { status: 'not_run' as BaselineOperationStatusView, reasonCode: 'authorization_rejected' },
      'not_run',
    ],
    ['timeout', { status: 'failed' as BaselineOperationStatusView, reasonCode: 'timed_out' }, 'timeout'],
    ['cancelled', { status: 'cancelled' as BaselineOperationStatusView }, 'cancelled'],
    [
      '停止未确认',
      { status: 'failed' as BaselineOperationStatusView, reasonCode: 'stop_unconfirmed' },
      'stop_unconfirmed',
    ],
  ] as const)('分类表 %s → %s', (_label, input, expected) => {
    expect(classifyBaselineState(input)).toBe(expected);
  });

  it('not_run/非 passed 检查不折算成功；超时/取消/停止未确认优先于一般失败', () => {
    // 必需检查 not_run → 不是 passed。
    expect(
      classifyBaselineState({
        status: 'completed',
        checks: [checkResult({ status: 'not_run' }), checkResult({ required: false, status: 'passed' })],
      }),
    ).toBe('failed');
    // 仅摘要时任何非 passed 检查都不折算。
    expect(
      classifyBaselineState({
        status: 'completed',
        summary: { total: 2, passed: 1, failed: 0, error: 0, inconclusive: 0, notRun: 1 },
      }),
    ).toBe('failed');
    // 无检查证据的 completed 不折算 passed。
    expect(classifyBaselineState({ status: 'completed' })).toBe('failed');
    // 检查级超时/停止未确认显式区分。
    expect(
      classifyBaselineState({ status: 'completed', checks: [checkResult({ timedOut: true, status: 'inconclusive' })] }),
    ).toBe('timeout');
    expect(
      classifyBaselineState({
        status: 'completed',
        checks: [checkResult({ reasonCode: 'stop_unconfirmed', status: 'inconclusive' })],
      }),
    ).toBe('stop_unconfirmed');
    // 可选检查失败不影响必需项判定，但摘要计数保真。
    const detail = buildBaselineOperationResult(operation(), [
      checkResult(),
      checkResult({ checkKey: 'optional', required: false, status: 'failed', exitCode: 1, output: null }),
    ]);
    expect(detail.state).toBe('passed');
    expect(detail.checks[1]).toMatchObject({ checkKey: 'optional', status: 'failed', output: null });
  });

  it('JSON 结果保留 operationId 与结果引用（artifactId/byteSize/truncated）', () => {
    const artifactId = randomUUID();
    const detail = buildBaselineOperationResult(
      operation({ status: 'failed', reasonCode: 'timed_out' }),
      [checkResult({ status: 'inconclusive', reasonCode: 'timed_out', timedOut: true, output: { artifactId, byteSize: 4096, truncated: true } })],
    );
    expect(detail.operationId).toBe(OPERATION_ID);
    expect(detail.state).toBe('timeout');
    expect(detail.checks[0]!.output).toEqual({ artifactId, byteSize: 4096, truncated: true });

    const command = buildBaselineCommandResult({ operationId: OPERATION_ID, status: 'accepted' });
    expect(command).toEqual({ operationId: OPERATION_ID, state: 'accepted', status: 'accepted' });
    expect(buildBaselineCommandResult({ operationId: OPERATION_ID, status: 'not_run', reasonCode: 'authorization_rejected' })).toMatchObject({
      state: 'not_run',
      reasonCode: 'authorization_rejected',
    });

    const list = buildBaselineListResult({
      projectId: PROJECT_ID,
      records: [
        operation({ status: 'accepted', summary: { total: 1, passed: 0, failed: 0, error: 0, inconclusive: 0, notRun: 1 } }),
        operation({ status: 'cancelled', reasonCode: 'cancelled' }),
      ],
      nextCursor: OPERATION_ID,
      limit: 20,
    });
    expect(list.records.map((record) => record.state)).toEqual(['accepted', 'cancelled']);
    expect(list.nextCursor).toBe(OPERATION_ID);
    expect(list.limit).toBe(20);

    const evidence = buildBaselineEvidenceResult(artifactId, '输出正文');
    expect(evidence).toEqual({ artifactId, byteSize: 4, content: '输出正文' });
  });

  it('人类格式化区分状态且不折算 not_run；预览展示项目/argv/cwd/环境引用/timeout/政策/代码范围', () => {
    const preview = buildBaselinePreviewResult(PROJECT_ID, {
      previewDigest: 'a'.repeat(64),
      policyRevision: 'b'.repeat(64),
      codeIdentity: { headCommit: null, workingTreeDigest: 'c'.repeat(64), hasUncommittedChanges: true },
      workspace: { excludedDirNames: ['.git', 'node_modules'], fileCount: 7 },
      checks: [
        {
          checkKey: 'build',
          kind: 'command',
          argv: LOSSLESS_ARGV,
          cwdRef: 'packages/cli',
          cwd: '/tmp/repo/packages/cli',
          environmentRef: 'ci-allowlist',
          allowedVariables: ['CI_TOKEN_NAME_ONLY'],
          timeoutMs: 60_000,
          required: true,
        },
      ],
      warnings: [{ code: 'working_tree_dirty' }, { code: 'no_initial_commit', checkKey: 'build' }],
    });
    const text = formatBaselinePreview(preview);
    expect(text).toContain(PROJECT_ID);
    expect(text).toContain(formatArgvLossless(LOSSLESS_ARGV));
    expect(text).toContain('cwdRef=packages/cli');
    expect(text).toContain('cwd=/tmp/repo/packages/cli');
    expect(text).toContain('environmentRef=ci-allowlist');
    expect(text).toContain('timeoutMs=60000');
    expect(text).toContain(`policyRevision=${'b'.repeat(64)}`);
    expect(text).toMatch(/null（无 HEAD/);
    expect(text).toMatch(/有未提交改动/);
    expect(text).toContain('working_tree_dirty');
    expect(text).toContain('no_initial_commit');
    // 不拼接 shell、不追加安装命令、不回显凭据。
    expect(text).not.toContain('sh -c');
    expect(text).not.toMatch(/npm (install|ci)/);
    expect(text).not.toContain('Bearer');

    const states = [
      'accepted',
      'active',
      'passed',
      'failed',
      'not_run',
      'timeout',
      'cancelled',
      'stop_unconfirmed',
    ] as const satisfies readonly BaselineDisplayState[];
    const labels = states.map((state) => describeBaselineState(state));
    expect(new Set(labels).size).toBe(states.length);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }

    const operationText = formatBaselineOperationResult(
      buildBaselineOperationResult(operation({ status: 'not_run', reasonCode: 'authorization_rejected' }), [
        checkResult({ status: 'not_run', reasonCode: 'authorization_rejected', exitCode: null, output: null }),
      ]),
    );
    expect(operationText).toContain('not_run');
    expect(operationText).toContain('not_run 不折算成功');
    expect(operationText).toContain(OPERATION_ID);

    const listText = formatBaselineListResult(
      buildBaselineListResult({ projectId: PROJECT_ID, records: [], nextCursor: null, limit: 20 }),
    );
    expect(listText).toContain(PROJECT_ID);
    expect(listText).toContain('（无记录）');

    const commandText = formatBaselineCommandResult(
      buildBaselineCommandResult({ operationId: OPERATION_ID, status: 'failed', reasonCode: 'stop_unconfirmed' }),
    );
    expect(commandText).toContain(OPERATION_ID);
    expect(commandText).toContain('stop_unconfirmed');
  });

  it('退出码与前序码表一致（§12.3 五档）', () => {
    // 查询与显式取消成功 → 0。
    for (const command of ['preview', 'list', 'status', 'cancel', 'evidence'] as const) {
      expect(baselineCliExitCode({ command })).toBe(CLI_EXIT_OK);
    }
    // run：accepted/decline → 0；--wait 仅 completed 且必需项全 passed → 0。
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', state: 'accepted' })).toBe(CLI_EXIT_OK);
    expect(baselineCliExitCode({ command: 'run', decision: 'decline', state: 'not_run' })).toBe(CLI_EXIT_OK);
    expect(baselineCliExitCode({ command: 'run', decision: 'authorize', state: 'passed', waited: true })).toBe(CLI_EXIT_OK);
    for (const state of ['failed', 'cancelled', 'not_run', 'timeout', 'stop_unconfirmed'] as const) {
      expect(
        baselineCliExitCode({ command: 'run', decision: 'authorize', state, waited: true }),
        state,
      ).toBe(CLI_EXIT_REJECTED);
    }
    // 错误映射复用五档（输入 2、连接 3、观察中断 4）。
    expect(exitCodeForAppErrorCode('invalid_input')).toBe(CLI_EXIT_INPUT);
    expect(exitCodeForAppErrorCode('host_not_found')).toBe(CLI_EXIT_CONNECTION);
    expect(exitCodeForAppErrorCode('observation_interrupted')).toBe(CLI_EXIT_OBSERVATION_INTERRUPTED);
    expect(exitCodeForAppErrorCode('preview_stale')).toBe(CLI_EXIT_REJECTED);
  });

  it('JSON 模式 stdout 只有可解析结果信封；提示与诊断进 stderr', () => {
    const result = buildBaselineCommandResult({ operationId: OPERATION_ID, status: 'accepted' });
    const notice = buildBaselineRunConfirmationNotice();
    const json = composeAppCliStreams({
      json: true,
      command: 'baseline.run',
      result,
      humanText: '不应出现',
      notices: [notice],
    });
    expect(json.stderr).toBe(notice);
    const envelope = JSON.parse(json.stdout) as {
      ok: boolean;
      command: string;
      result: { operationId: string; state: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('baseline.run');
    expect(envelope.result.operationId).toBe(OPERATION_ID);
    expect(envelope.result.state).toBe('accepted');

    const human = composeAppCliStreams({
      json: false,
      command: 'baseline.status',
      result,
      humanText: '人类摘要\n',
      notices: [notice],
    });
    expect(human.stdout).toBe('人类摘要\n');
    expect(human.stderr).toBe(notice);
  });
});

/* ------------------------------------------------------------------ *
 * 零副作用（解析失败/未接线前不启动 Host 或进程）
 * ------------------------------------------------------------------ */

const sandboxes: ReturnType<typeof createTempSandbox>[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) {
    sandbox.cleanup();
  }
});

describe('F-015 解析失败前不启动 Host 或进程', () => {
  it('runAppCli：基线参数/输入 JSON 校验失败退出 2，零数据根副作用、零进程', async () => {
    const sandbox = createTempSandbox('shiploop-f015-cli-', { outside: [process.cwd()] });
    sandboxes.push(sandbox);
    const dataRoot = join(sandbox.path, 'data-root');
    const stdout: string[] = [];
    const stderr: string[] = [];
    let spawned = 0;

    // 非法参数：在任何 I/O 之前拒绝。
    const badArgs = await runAppCli({
      args: ['baseline', 'run', '--project', 'not-a-uuid', '--input', '/tmp/p.json', '--confirm', '--data-root', dataRoot, '--json'],
      env: {},
      platform: 'darwin',
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      launch: {
        onCandidateSpawned: () => {
          spawned += 1;
        },
      },
    });
    expect(badArgs.exitCode).toBe(2);
    expect(existsSync(join(dataRoot, 'host', 'discovery.json'))).toBe(false);

    // 输入文件缺失/畸形 JSON：同样在连接 Host 之前拒绝（退出码 2）。
    const missing = await runAppCli({
      args: ['baseline', 'run', '--project', PROJECT_ID, '--input', join(sandbox.path, 'absent.json'), '--confirm', '--data-root', dataRoot, '--json'],
      env: {},
      platform: 'darwin',
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      launch: {
        onCandidateSpawned: () => {
          spawned += 1;
        },
      },
    });
    expect(missing.exitCode).toBe(2);

    const planPath = join(sandbox.path, 'bad-plan.json');
    writeFileSync(planPath, '{ checks: [] }');
    const malformed = await runAppCli({
      args: ['baseline', 'preview', '--project', PROJECT_ID, '--input', planPath, '--data-root', dataRoot, '--json'],
      env: {},
      platform: 'darwin',
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      launch: {
        onCandidateSpawned: () => {
          spawned += 1;
        },
      },
    });
    expect(malformed.exitCode).toBe(2);
    const envelope = JSON.parse(stdout.at(-1) ?? '{}') as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('invalid_input');

    // 解析/校验失败绝不启动 Host 或进程、不创建数据根。
    expect(spawned).toBe(0);
    expect(existsSync(dataRoot)).toBe(false);
  });

  it('输入计划含凭据/安装意图字段被拒绝：不提取凭据、不自动追加安装命令', async () => {
    const sandbox = createTempSandbox('shiploop-f015-plan-', { outside: [process.cwd()] });
    sandboxes.push(sandbox);
    const planPath = join(sandbox.path, 'credential-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        checks: [
          {
            checkKey: 'build',
            kind: 'command',
            argv: ['npm', 'test'],
            timeoutMs: 60_000,
            required: true,
            token: 'credref-sentinel',
          },
        ],
      }),
    );
    const stdout: string[] = [];
    let spawned = 0;
    const run = await runAppCli({
      args: ['baseline', 'preview', '--project', PROJECT_ID, '--input', planPath, '--json'],
      env: {},
      platform: 'darwin',
      userHomeDir: sandbox.path,
      io: {
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      },
      launch: {
        onCandidateSpawned: () => {
          spawned += 1;
        },
      },
    });
    expect(run.exitCode).toBe(2);
    const text = stdout.join('');
    expect(text).toContain('input_secret_field_rejected');
    expect(text).not.toContain('credref-sentinel');
    expect(spawned).toBe(0);
    expect(readFileSync(planPath, 'utf8')).toContain('npm');
    expect(existsSync(join(sandbox.path, 'host', 'discovery.json'))).toBe(false);
  });
});
