/**
 * F-005 project init/overview CLI 纯面层（契约 §12.1/§12.2/§12.3）。
 *
 * 本任务只交付「参数解析 + 静态预览 + 确认文案 + 结构化格式化」纯函数层：
 * - 解析与执行分离：`parseAppCliArgs` 仍是同步纯函数（env/cwd 显式注入），
 *   错误参数、缺值、非法标签/ID 在发现 Host 或联网之前抛 AppCliParseError；
 * - 确认语义按契约 §12.1 冻结：注册只有显式 `--confirm`（非交互授权）才同意，
 *   且只覆盖预览展示的这一次注册请求；无输入或非交互模式绝不默认同意，
 *   取消确认得到 not_run（未注册，绝不伪装成 passed）；
 * - 注册确认与运行基线确认严格分开（init 不接受 baseline run 的确认参数）；
 * - 本测试全部为纯函数表驱动用例，不接触真实 Host、SQLite、Git 或网络。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  CLI_EXIT_CONNECTION,
  CLI_EXIT_INPUT,
  CLI_EXIT_OK,
  buildAppCliFailureEnvelope,
  buildInitCliResult,
  buildInitConfirmationNotice,
  composeAppCliStreams,
  describeHealthStatus,
  exitCodeForAppErrorCode,
  formatInitCliResult,
  formatInitPreview,
  formatOverviewResult,
  getAppCliHelp,
  initCliExitCode,
  parseAppCliArgs,
  resolveInitConfirmation,
  type InspectedRepositoryView,
  type InitRequestView,
  type ProjectHealthView,
  type ProjectOverviewView,
} from '../packages/cli/src/index.ts';

const PROJECT_ID = randomUUID();
const FIXTURE_ROOT = '/tmp/shiploop-fixture';

function inspection(overrides: Partial<InspectedRepositoryView> = {}): InspectedRepositoryView {
  return {
    canonicalPath: `${FIXTURE_ROOT}/repo`,
    repoIdentity: 'gitdir-sha256:fixture-identity',
    headCommit: null,
    hasInitialCommit: false,
    hasUncommittedChanges: false,
    alreadyRegistered: null,
    ...overrides,
  };
}

const REQUEST: InitRequestView = {
  repositoryPath: `${FIXTURE_ROOT}/repo`,
  displayName: '演示项目',
  description: '说明',
  labels: ['backend', 'Docs'],
};

function expectParseError(
  args: readonly string[],
  reason: string,
  context: { env?: Record<string, string | undefined>; cwd?: string } = {},
): AppCliParseError {
  try {
    parseAppCliArgs(args, context.env ?? {}, { cwd: context.cwd });
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(
      AppCliParseError,
    );
    const parsed = error as AppCliParseError;
    expect(parsed.reason).toBe(reason);
    expect(parsed.code).toBe('invalid_input');
    return parsed;
  }
  throw new Error(`expected parse error ${reason} for args ${JSON.stringify(args)}`);
}

describe('F-005 project init 参数解析（§12.1/§12.2，解析先于任何 I/O）', () => {
  it('表驱动：合法形态解析出绝对路径、元数据与确认开关', () => {
    const explicit = randomUUID();
    const cases: ReadonlyArray<{
      name: string;
      args: readonly string[];
      cwd?: string;
      expected: Record<string, unknown>;
    }> = [
      {
        name: '相对路径按注入 cwd 解析为绝对输入',
        args: ['project', 'init', './repo'],
        cwd: '/work/app',
        expected: {
          commandId: 'project.init',
          repositoryPathInput: './repo',
          repositoryPath: '/work/app/repo',
          confirm: false,
          labels: [],
        },
      },
      {
        name: '相对路径回溯段被规范化',
        args: ['project', 'init', 'sub/../repo'],
        cwd: '/work/app',
        expected: { repositoryPath: '/work/app/repo', repositoryPathInput: 'sub/../repo' },
      },
      {
        name: '绝对路径原样作为输入',
        args: ['project', 'init', '/srv/other'],
        expected: { repositoryPath: '/srv/other', repositoryPathInput: '/srv/other' },
      },
      {
        name: '完整元数据与显式确认',
        args: [
          'project',
          'init',
          '/srv/other',
          '--name',
          '演示项目',
          '--description',
          '说明',
          '--label',
          'backend',
          '--label',
          'docs',
          '--confirm',
          '--command-id',
          explicit,
        ],
        expected: {
          displayName: '演示项目',
          description: '说明',
          labels: ['backend', 'docs'],
          confirm: true,
          explicitCommandId: explicit,
        },
      },
      {
        name: 'overview 解析项目选择',
        args: ['project', 'overview', PROJECT_ID],
        expected: { commandId: 'project.overview', projectId: PROJECT_ID },
      },
    ];
    for (const testCase of cases) {
      const parsed = parseAppCliArgs(testCase.args, {}, { cwd: testCase.cwd }) as unknown as Record<
        string,
        unknown
      >;
      expect(parsed.kind, testCase.name).toBe('command');
      for (const [key, value] of Object.entries(testCase.expected)) {
        expect(parsed[key], `${testCase.name} → ${key}`).toEqual(value);
      }
    }
  });

  it('表驱动：错误参数/缺值/非法标签/非法 ID 在解析期失败且不回显参数值', () => {
    const cases: ReadonlyArray<{
      name: string;
      args: readonly string[];
      reason: string;
      field?: string;
      secret?: string;
      cwd?: string;
    }> = [
      {
        name: '缺位置路径',
        args: ['project', 'init'],
        reason: 'missing_positional',
      },
      {
        name: '多余位置参数',
        args: ['project', 'init', '/a', '/b'],
        reason: 'too_many_positionals',
      },
      {
        name: '缺值',
        args: ['project', 'init', '/a', '--name'],
        reason: 'missing_value',
        field: 'name',
      },
      {
        name: '空标签',
        args: ['project', 'init', '/a', '--label', ''],
        reason: 'empty_label',
        field: 'label',
      },
      {
        name: '标签含 NUL',
        args: ['project', 'init', '/a', '--label', 'ok\u0000bad'],
        reason: 'invalid_label',
        field: 'label',
        secret: 'ok\u0000bad',
      },
      {
        name: '标签超长',
        args: ['project', 'init', '/a', '--label', 'x'.repeat(65)],
        reason: 'invalid_label',
        field: 'label',
        secret: 'x'.repeat(65),
      },
      {
        name: '标签超量',
        args: [
          'project',
          'init',
          '/a',
          ...Array.from({ length: 51 }, (_, index) => ['--label', `label-${index}`]).flat(),
        ],
        reason: 'too_many_labels',
        field: 'labels',
        secret: 'label-50',
      },
      {
        name: '非法命令 ID',
        args: ['project', 'init', '/a', '--command-id', 'not-a-uuid'],
        reason: 'invalid_command_id',
        field: 'command-id',
        secret: 'not-a-uuid',
      },
      {
        name: '非法 overview 项目 ID',
        args: ['project', 'overview', 'not-a-uuid'],
        reason: 'invalid_project_id',
      },
      {
        name: 'overview 缺项目 ID',
        args: ['project', 'overview'],
        reason: 'missing_positional',
      },
      {
        name: '相对路径缺少解析基准',
        args: ['project', 'init', './repo'],
        reason: 'repository_path_requires_cwd',
        field: 'repositoryPath',
      },
      {
        name: '仓库路径含 NUL',
        args: ['project', 'init', '/a\u0000b'],
        reason: 'invalid_repository_path',
        secret: '/a\u0000b',
      },
      {
        name: '名称超长',
        args: ['project', 'init', '/a', '--name', '名'.repeat(201)],
        reason: 'invalid_name',
        field: 'name',
        secret: '名'.repeat(201),
      },
    ];
    for (const testCase of cases) {
      const error = expectParseError(testCase.args, testCase.reason, { cwd: testCase.cwd });
      if (testCase.field !== undefined) {
        expect(error.field, testCase.name).toBe(testCase.field);
      }
      if (testCase.secret !== undefined) {
        expect(error.message, testCase.name).not.toContain(testCase.secret);
      }
    }
  });

  it('注册确认与运行基线确认分开：init 不接受 baseline run 的确认/输入参数', () => {
    for (const flag of ['--decline', '--wait', '--follow', '--input']) {
      expectParseError(['project', 'init', '/a', flag, 'value'], 'unknown_argument');
    }
  });

  it('未知参数与非法值仍在解析期失败（不触达 Host）', () => {
    expectParseError(['project', 'init', '/a', '--unknown'], 'unknown_argument');
    expectParseError(['project', 'overview', PROJECT_ID, 'extra'], 'too_many_positionals');
    expectParseError(['project', 'init', '/a', '--confirm=yes'], 'bool_flag_takes_no_value');
  });
});

describe('F-005 帮助文案（准确说明不自动运行脚本/安装依赖）', () => {
  const SCOPES = ['project', 'project.init', 'project.overview'] as const;

  it('表驱动：帮助以换行结尾、不含开发机固定路径或凭据', () => {
    for (const scope of SCOPES) {
      const text = getAppCliHelp(scope);
      expect(text.length, scope).toBeGreaterThan(20);
      expect(text.endsWith('\n'), scope).toBe(true);
      expect(text, scope).not.toMatch(/\/Users\//);
      expect(text, scope).not.toMatch(/\/home\//);
      expect(text, scope).not.toMatch(/[0-9a-f]{64}/);
      expect(text, scope).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
    }
  });

  it('project init 帮助说明：不执行脚本、不安装依赖、不运行基线', () => {
    const text = getAppCliHelp('project.init');
    expect(text).toMatch(/不执行.*脚本|不运行.*脚本/);
    expect(text).toMatch(/不安装/);
    expect(text).toMatch(/基线/);
    expect(text).toContain('--confirm');
    expect(text).toMatch(/not_run/);
  });

  it('project overview 帮助说明注册与健康分开、not_run 不折算成功', () => {
    const text = getAppCliHelp('project.overview');
    expect(text).toMatch(/注册.*健康.*分开|注册状态.*健康状态/);
    expect(text).toMatch(/not_run/);
    expect(text).not.toMatch(/\bpassed\b/);
  });

  it('help 令牌返回 init/overview 帮助作用域', () => {
    expect(parseAppCliArgs(['project', 'init', '--help'])).toEqual({
      kind: 'help',
      scope: 'project.init',
    });
    expect(parseAppCliArgs(['project', 'overview', '-h'])).toEqual({
      kind: 'help',
      scope: 'project.overview',
    });
  });
});

describe('F-005 静态预览（空仓库/脏仓库表驱动输出）', () => {
  it('表驱动：预览显示规范路径、HEAD/null、脏状态与注册确认内容', () => {
    const cases: ReadonlyArray<{
      name: string;
      view: InspectedRepositoryView;
      expected: readonly string[];
      forbidden: readonly RegExp[];
    }> = [
      {
        name: '空仓库（无 HEAD）',
        view: inspection(),
        expected: [
          `${FIXTURE_ROOT}/repo`,
          '无 HEAD',
          '初始 commit',
          '注册确认内容',
          '演示项目',
          'backend',
        ],
        forbidden: [/\bpassed\b/],
      },
      {
        name: '脏仓库（有 HEAD、未提交改动）',
        view: inspection({
          canonicalPath: `${FIXTURE_ROOT}/dirty`,
          headCommit: 'a'.repeat(40),
          hasInitialCommit: true,
          hasUncommittedChanges: true,
        }),
        expected: ['a'.repeat(40), '有未提交改动'],
        forbidden: [/\bpassed\b/],
      },
      {
        name: '干净仓库',
        view: inspection({
          canonicalPath: `${FIXTURE_ROOT}/clean`,
          headCommit: 'b'.repeat(40),
          hasInitialCommit: true,
          hasUncommittedChanges: false,
        }),
        expected: ['b'.repeat(40), '干净'],
        forbidden: [/\bpassed\b/],
      },
      {
        name: '已有绑定显示既有项目身份',
        view: inspection({ alreadyRegistered: { projectId: PROJECT_ID } }),
        expected: [PROJECT_ID, '已注册'],
        forbidden: [/\bpassed\b/],
      },
    ];
    for (const testCase of cases) {
      const text = formatInitPreview(REQUEST, testCase.view);
      expect(text.endsWith('\n'), testCase.name).toBe(true);
      for (const fragment of testCase.expected) {
        expect(text, `${testCase.name} → ${fragment}`).toContain(fragment);
      }
      for (const pattern of testCase.forbidden) {
        expect(text, testCase.name).not.toMatch(pattern);
      }
    }
  });

  it('空仓库预览不猜分支、不自动提交；脏仓库预览声明原样保留', () => {
    const empty = formatInitPreview(REQUEST, inspection());
    expect(empty).toMatch(/不猜测|不猜/);
    expect(empty).toMatch(/不自动|不创建/);
    const dirty = formatInitPreview(
      REQUEST,
      inspection({ headCommit: 'a'.repeat(40), hasInitialCommit: true, hasUncommittedChanges: true }),
    );
    expect(dirty).toMatch(/原样保留|不 stash|不 reset/);
  });

  it('预览输出不含真实凭据或开发机固定路径（只呈现夹具给出的路径）', () => {
    const text = formatInitPreview(REQUEST, inspection());
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).toContain(`${FIXTURE_ROOT}/repo`);
  });
});

describe('F-005 注册确认（与运行基线确认分开；无输入/非交互不默认同意）', () => {
  it('表驱动：确认决策', () => {
    const cases: ReadonlyArray<{
      name: string;
      input: { confirmFlag: boolean; interactive: boolean; answer?: string | null };
      expected: Record<string, unknown>;
    }> = [
      {
        name: '显式 --confirm 是非交互授权',
        input: { confirmFlag: true, interactive: false },
        expected: { outcome: 'register', source: 'explicit_flag', scope: 'project.register' },
      },
      {
        name: '--confirm 只覆盖展示的实际请求，不因交互应答改变',
        input: { confirmFlag: true, interactive: true, answer: 'n' },
        expected: { outcome: 'register', source: 'explicit_flag' },
      },
      {
        name: '无 TTY 且无 --confirm：即使有输入也不默认同意',
        input: { confirmFlag: false, interactive: false, answer: 'y' },
        expected: { outcome: 'not_run', reason: 'non_interactive' },
      },
      {
        name: '无 TTY 且无输入',
        input: { confirmFlag: false, interactive: false, answer: null },
        expected: { outcome: 'not_run', reason: 'non_interactive' },
      },
      {
        name: '交互但无输入不默认同意',
        input: { confirmFlag: false, interactive: true, answer: null },
        expected: { outcome: 'not_run', reason: 'no_input' },
      },
      {
        name: '交互空输入不默认同意',
        input: { confirmFlag: false, interactive: true, answer: '  ' },
        expected: { outcome: 'not_run', reason: 'no_input' },
      },
      {
        name: '交互明确取消',
        input: { confirmFlag: false, interactive: true, answer: 'n' },
        expected: { outcome: 'not_run', reason: 'declined' },
      },
      {
        name: '交互肯定应答但缺显式授权仍不注册',
        input: { confirmFlag: false, interactive: true, answer: 'y' },
        expected: { outcome: 'not_run', reason: 'confirm_flag_required' },
      },
    ];
    for (const testCase of cases) {
      const decision = resolveInitConfirmation(testCase.input) as Record<string, unknown>;
      for (const [key, value] of Object.entries(testCase.expected)) {
        expect(decision[key], `${testCase.name} → ${key}`).toEqual(value);
      }
    }
  });

  it('确认文案声明授权范围只含注册，不含脚本/安装/基线', () => {
    const notice = buildInitConfirmationNotice();
    expect(notice).toContain('--confirm');
    expect(notice).toMatch(/不执行.*脚本|不运行.*脚本/);
    expect(notice).toMatch(/不安装/);
    expect(notice).toMatch(/基线/);
    expect(notice).toMatch(/分开|独立/);
    expect(notice).toMatch(/not_run/);
    expect(notice).not.toMatch(/\bpassed\b/);
    expect(notice).not.toMatch(/\/Users\//);
  });
});

describe('F-005 结构化格式化（not_run/注册成功/健康分开显示）', () => {
  it('表驱动：init 结果把注册状态与健康状态分开呈现', () => {
    const cases: ReadonlyArray<{
      name: string;
      registration: Parameters<typeof buildInitCliResult>[2];
      expected: readonly string[];
    }> = [
      {
        name: '未确认注册 → not_run（未注册）',
        registration: { status: 'not_run', reason: 'declined' },
        expected: ['not_run', 'declined', '未注册', '健康状态'],
      },
      {
        name: '注册成功 → registered 且健康未检查',
        registration: { status: 'registered', projectId: PROJECT_ID },
        expected: ['registered', PROJECT_ID, 'not_run', '尚无基线'],
      },
      {
        name: '复用既有项目 → already_registered 且健康未检查',
        registration: { status: 'already_registered', projectId: PROJECT_ID },
        expected: ['already_registered', PROJECT_ID, 'not_run'],
      },
    ];
    for (const testCase of cases) {
      const result = buildInitCliResult(
        REQUEST,
        inspection(),
        testCase.registration,
      );
      const text = formatInitCliResult(result);
      expect(text.endsWith('\n'), testCase.name).toBe(true);
      for (const fragment of testCase.expected) {
        expect(text, `${testCase.name} → ${fragment}`).toContain(fragment);
      }
      expect(text, testCase.name).not.toMatch(/\bpassed\b/);
      expect(text, testCase.name).not.toMatch(/通过/);
      expect(initCliExitCode(result), testCase.name).toBe(CLI_EXIT_OK);
    }
  });

  it('init 结果对象保留三轴事实：注册 not_run 与健康 not_run 各自建模', () => {
    const result = buildInitCliResult(REQUEST, inspection(), {
      status: 'not_run',
      reason: 'non_interactive',
    });
    expect(result.registration).toEqual({ status: 'not_run', reason: 'non_interactive' });
    expect(result.health.status).toBe('not_run');
    expect(result.health.reasonCode).toBe('no_baseline');
    expect(result.preview.headCommit).toBeNull();
    expect(result.preview.hasUncommittedChanges).toBe(false);
  });

  it('表驱动：overview 把注册状态与健康状态分开呈现', () => {
    const health = (
      status: ProjectHealthView['status'],
      reasonCode?: string,
    ): ProjectHealthView => ({
      status,
      lastBaselineOperationId: null,
      lastCompletedAt: null,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    });
    const cases: ReadonlyArray<{
      name: string;
      overview: ProjectOverviewView;
      expected: readonly string[];
    }> = [
      {
        name: '已注册但尚无基线 → 健康 not_run（未检查）',
        overview: {
          project: { id: PROJECT_ID, displayName: '演示项目', description: null, labels: [] },
          binding: { canonicalPath: `${FIXTURE_ROOT}/repo` },
          registration: { status: 'registered' },
          settings: { configured: false },
          health: health('not_run', 'no_baseline'),
          readAt: '2026-10-10T00:00:00.000Z',
        },
        expected: ['registered', 'not_run', 'no_baseline', PROJECT_ID],
      },
      {
        name: '健康失败单独显示原因',
        overview: {
          project: { id: PROJECT_ID, displayName: '演示项目', description: null, labels: [] },
          binding: null,
          registration: { status: 'registered' },
          settings: { configured: true, revision: 2, schemaVersion: 3 },
          health: health('unhealthy', 'timed_out'),
          readAt: '2026-10-10T00:00:00.000Z',
        },
        expected: ['unhealthy', 'timed_out', 'registered'],
      },
      {
        name: '未注册项目不显示健康通过',
        overview: {
          project: { id: PROJECT_ID, displayName: '演示项目', description: null, labels: [] },
          binding: null,
          registration: { status: 'not_registered' },
          settings: { configured: false },
          health: health('not_run', 'no_baseline'),
          readAt: '2026-10-10T00:00:00.000Z',
        },
        expected: ['not_registered', 'not_run'],
      },
    ];
    for (const testCase of cases) {
      const text = formatOverviewResult(testCase.overview);
      expect(text.endsWith('\n'), testCase.name).toBe(true);
      for (const fragment of testCase.expected) {
        expect(text, `${testCase.name} → ${fragment}`).toContain(fragment);
      }
      expect(text, testCase.name).not.toMatch(/\bpassed\b/);
      expect(text, testCase.name).not.toMatch(/通过/);
      expect(text, testCase.name).not.toMatch(/\/Users\//);
    }
  });

  it('describeHealthStatus 不把 not_run 折算为成功', () => {
    expect(describeHealthStatus({ status: 'not_run', lastBaselineOperationId: null, lastCompletedAt: null, reasonCode: 'no_baseline' })).toMatch(/not_run/);
    expect(describeHealthStatus({ status: 'healthy', lastBaselineOperationId: null, lastCompletedAt: null })).toMatch(/healthy/);
    expect(describeHealthStatus({ status: 'unhealthy', lastBaselineOperationId: null, lastCompletedAt: null, reasonCode: 'stop_unconfirmed' })).toMatch(/unhealthy/);
    for (const status of ['not_run', 'healthy', 'unhealthy'] as const) {
      const text = describeHealthStatus({
        status,
        lastBaselineOperationId: null,
        lastCompletedAt: null,
      });
      expect(text).not.toMatch(/\bpassed\b/);
    }
  });
});

describe('F-005 输出路由与退出码（§12.2/§12.3）', () => {
  const result = buildInitCliResult(REQUEST, inspection(), {
    status: 'not_run',
    reason: 'non_interactive',
  });

  it('JSON 模式 stdout 只有可解析结果，提示进入 stderr', () => {
    const streams = composeAppCliStreams({
      json: true,
      command: 'project.init',
      result,
      humanText: formatInitCliResult(result),
      notices: [buildInitConfirmationNotice()],
    });
    const parsed = JSON.parse(streams.stdout) as {
      ok: boolean;
      command: string;
      result: unknown;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('project.init');
    expect(parsed.result).toEqual(result);
    expect(streams.stdout).not.toContain('注册确认');
    expect(streams.stderr).toContain('注册确认');
    expect(streams.stderr.endsWith('\n')).toBe(true);
  });

  it('人类模式 stdout 只有结果文本，提示仍走 stderr', () => {
    const streams = composeAppCliStreams({
      json: false,
      command: 'project.init',
      result,
      humanText: formatInitCliResult(result),
      notices: [buildInitConfirmationNotice()],
    });
    expect(streams.stdout).toContain('not_run');
    expect(streams.stdout).not.toContain('注册确认');
    expect(streams.stderr).toContain('注册确认');
  });

  it('表驱动：not_run/注册成功与连接错误按前序退出码契约分别展示', () => {
    expect(initCliExitCode(result)).toBe(CLI_EXIT_OK);
    expect(
      initCliExitCode(
        buildInitCliResult(REQUEST, inspection(), { status: 'registered', projectId: PROJECT_ID }),
      ),
    ).toBe(CLI_EXIT_OK);
    const connectionEnvelope = buildAppCliFailureEnvelope('project.init', 'host_not_found', '无法连接 Host');
    expect(connectionEnvelope.error.code).toBe('host_not_found');
    expect(exitCodeForAppErrorCode(connectionEnvelope.error.code)).toBe(CLI_EXIT_CONNECTION);
    expect(exitCodeForAppErrorCode('unreachable')).toBe(CLI_EXIT_CONNECTION);
    expect(exitCodeForAppErrorCode('forbidden')).toBe(1);
    expect(exitCodeForAppErrorCode('invalid_input')).toBe(CLI_EXIT_INPUT);
    expect(exitCodeForAppErrorCode('invalid_input')).toBe(2);
  });

  it('失败信封保留 commandId 以便查回执，且不泄漏路径', () => {
    const envelope = buildAppCliFailureEnvelope('project.overview', 'host_not_found', '无法连接 Host', {
      commandId: randomUUID(),
    });
    expect(envelope.error.commandId).toBeDefined();
    expect(JSON.stringify(envelope)).not.toMatch(/\/Users\//);
  });
});
