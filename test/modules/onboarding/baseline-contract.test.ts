/**
 * F-002 P02-3 静态接入与基线命令纯契约（ports 契约层）测试。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md
 * - §3.2 路由与 §6 命令 payload 白名单（preview/run/cancel）；
 * - §5.7 公开错误码与受控 reason（invalid_input 定位字段）；
 * - §6.1 检查计划（非空 argv 数组、cwdRef 仓库内、environmentRef、timeoutMs、
 *   required、checkKey 唯一）；
 * - §6.2/§6.3 授权摘要与代码身份；
 * - §7.4 基线分页（默认 20、上限 100、游标为上一页最后 operationId）；
 * - §8 三轴状态（operation / check / reason）与 §8.2 健康派生（not_run 不折算通过）。
 *
 * 本套件只测纯数据与纯函数：不打开数据库、不发 HTTP、不起子进程、不读时钟。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PublicError, isPublicError } from '../../../packages/core/src/ports/commands.ts';
import {
  BASELINE_CAPABILITIES,
  BASELINE_CHECK_OUTPUT_MAX_BYTES,
  BASELINE_CHECK_STATUSES,
  BASELINE_CHECK_TAIL_MAX_BYTES,
  BASELINE_CHECK_TIMEOUT_DEFAULT_MS,
  BASELINE_CHECK_TIMEOUT_MAX_MS,
  BASELINE_CHECK_TIMEOUT_MIN_MS,
  BASELINE_CHECKS_MAX,
  BASELINE_CHECKS_MIN,
  BASELINE_COMMAND_OPERATIONS,
  BASELINE_LIST_DEFAULT_LIMIT,
  BASELINE_LIST_MAX_LIMIT,
  BASELINE_OPERATION_STATUSES,
  BASELINE_QUERY_OPERATIONS,
  BASELINE_REASON_CODES,
  PROJECT_HEALTH_STATUSES,
  PROJECT_REGISTRATION_STATUSES,
  baselineCheckStatusForReason,
  computeBaselinePlanDigest,
  deriveProjectHealth,
  summarizeBaselineChecks,
  summarizeBaselineOperation,
  validateBaselineAuthorizationSummary,
  validateBaselineCancelPayload,
  validateBaselineCapability,
  validateBaselineCheckPlan,
  validateBaselineCodeIdentity,
  validateBaselineListQuery,
  validateBaselinePreviewPayload,
  validateBaselineRunPayload,
  validateProjectInitRequest,
  validateRepositoryRootPath,
} from '../../../packages/core/src/ports/baseline.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const UUID_A = '12345678-1234-4123-8234-1234567890ab';
const UUID_B = '12345678-1234-4123-8234-1234567890cd';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function expectInvalidInput(run: () => unknown, field: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isPublicError(caught, 'invalid_input')).toBe(true);
  const details = (caught as PublicError).details as Record<string, unknown>;
  expect(details.field).toBe(field);
  // 错误体不回显输入原文/秘密/路径。
  expect(JSON.stringify(details)).not.toContain('SECRET');
}

function validCheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkKey: 'unit-tests',
    kind: 'command',
    argv: ['node', '--test'],
    timeoutMs: 600_000,
    required: true,
    ...overrides,
  };
}

function validPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { checks: [validCheck()], ...overrides };
}

describe('F-002 基线契约常量与枚举（冻结值）', () => {
  it('冻结命令/查询/能力与三轴枚举', () => {
    expect([...BASELINE_COMMAND_OPERATIONS]).toEqual([
      'baseline.preview',
      'baseline.run',
      'baseline.cancel',
    ]);
    expect([...BASELINE_QUERY_OPERATIONS]).toEqual([
      'projects.inspect',
      'projects.overview',
      'baselines.list',
      'baselines.get',
      'artifacts.get',
    ]);
    expect([...BASELINE_CAPABILITIES]).toEqual(['baseline.read', 'baseline.run']);
    expect([...BASELINE_OPERATION_STATUSES]).toEqual([
      'accepted',
      'running',
      'cancelling',
      'completed',
      'cancelled',
      'failed',
      'interrupted',
      'not_run',
    ]);
    expect([...BASELINE_CHECK_STATUSES]).toEqual([
      'passed',
      'failed',
      'error',
      'inconclusive',
      'not_run',
    ]);
    for (const reason of [
      'missing_command',
      'unknown_script',
      'spawn_failed',
      'permission_denied',
      'timed_out',
      'cancelled',
      'stop_unconfirmed',
      'source_changed',
      'evidence_incomplete',
      'output_overflow',
      'restart_recovery',
      'authorization_rejected',
      'empty_check_set',
      'baseline_in_progress',
      'preview_stale',
    ]) {
      expect(BASELINE_REASON_CODES).toContain(reason);
    }
  });

  it('冻结资源上限（有限默认值，非用户可配）', () => {
    expect(BASELINE_CHECKS_MIN).toBe(1);
    expect(BASELINE_CHECKS_MAX).toBe(64);
    expect(BASELINE_CHECK_TIMEOUT_MIN_MS).toBe(1);
    expect(BASELINE_CHECK_TIMEOUT_MAX_MS).toBe(3_600_000);
    expect(BASELINE_CHECK_TIMEOUT_DEFAULT_MS).toBe(600_000);
    expect(BASELINE_CHECK_OUTPUT_MAX_BYTES).toBe(8_388_608);
    expect(BASELINE_CHECK_TAIL_MAX_BYTES).toBe(16_384);
    expect(BASELINE_LIST_DEFAULT_LIMIT).toBe(20);
    expect(BASELINE_LIST_MAX_LIMIT).toBe(100);
  });
});

describe('F-002 检查计划校验（§6.1，表驱动）', () => {
  it('接受最小与完整计划并规范化省略字段', () => {
    const minimal = validateBaselineCheckPlan(validPlan(), 'baseline.preview');
    expect(minimal.checks).toHaveLength(1);
    expect(minimal.checks[0]).toEqual({
      checkKey: 'unit-tests',
      kind: 'command',
      argv: ['node', '--test'],
      timeoutMs: 600_000,
      required: true,
    });
    // 省略 cwdRef/environmentRef 不产生 undefined 值键（保证规范 JSON 摘要稳定）。
    expect(Object.prototype.hasOwnProperty.call(minimal.checks[0], 'cwdRef')).toBe(false);

    const full = validateBaselineCheckPlan(
      {
        checks: [
          validCheck({ cwdRef: 'packages/core', environmentRef: 'ci-minimal', required: false }),
          validCheck({ checkKey: 'lint', argv: ['npm', 'run', 'lint'] }),
        ],
      },
      'baseline.preview',
    );
    expect(full.checks).toHaveLength(2);
    expect(full.checks[0]!.cwdRef).toBe('packages/core');
    expect(full.checks[0]!.environmentRef).toBe('ci-minimal');
    expect(full.checks[0]!.required).toBe(false);
  });

  const invalidCases: Array<[string, Record<string, unknown>, string]> = [
    ['计划非对象', { checks: 'nope' } as unknown as Record<string, unknown>, 'plan.checks'],
    ['空检查集', { checks: [] }, 'plan.checks'],
    ['超过上限', { checks: Array.from({ length: BASELINE_CHECKS_MAX + 1 }, (_, i) => validCheck({ checkKey: `c${i}` })) }, 'plan.checks'],
    ['检查项非对象', { checks: ['x'] }, 'plan.checks[0]'],
    ['重复检查 ID', { checks: [validCheck(), validCheck()] }, 'plan.checks[1].checkKey'],
    ['checkKey 含大写', { checks: [validCheck({ checkKey: 'Unit' })] }, 'plan.checks[0].checkKey'],
    ['checkKey 以连字符开头', { checks: [validCheck({ checkKey: '-bad' })] }, 'plan.checks[0].checkKey'],
    ['checkKey 超长', { checks: [validCheck({ checkKey: 'a'.repeat(65) })] }, 'plan.checks[0].checkKey'],
    ['kind 非 command', { checks: [validCheck({ kind: 'human' })] }, 'plan.checks[0].kind'],
    ['空 argv', { checks: [validCheck({ argv: [] })] }, 'plan.checks[0].argv'],
    ['argv 非数组', { checks: [validCheck({ argv: 'node --test' })] }, 'plan.checks[0].argv'],
    ['argv 非字符串参数', { checks: [validCheck({ argv: ['node', 7] })] }, 'plan.checks[0].argv[1]'],
    ['argv 空字符串参数', { checks: [validCheck({ argv: ['node', '  '] })] }, 'plan.checks[0].argv[1]'],
    ['argv 含 NUL', { checks: [validCheck({ argv: ['node', 'a\0b'] })] }, 'plan.checks[0].argv[1]'],
    ['cwdRef 绝对路径', { checks: [validCheck({ cwdRef: '/etc' })] }, 'plan.checks[0].cwdRef'],
    ['cwdRef 目录穿越', { checks: [validCheck({ cwdRef: '../escape' })] }, 'plan.checks[0].cwdRef'],
    ['cwdRef 反斜杠', { checks: [validCheck({ cwdRef: 'a\\b' })] }, 'plan.checks[0].cwdRef'],
    ['cwdRef 含 NUL', { checks: [validCheck({ cwdRef: 'a\0b' })] }, 'plan.checks[0].cwdRef'],
    ['environmentRef 非字符串', { checks: [validCheck({ environmentRef: 1 })] }, 'plan.checks[0].environmentRef'],
    ['environmentRef 含 NUL', { checks: [validCheck({ environmentRef: 'a\0b' })] }, 'plan.checks[0].environmentRef'],
    ['timeout 为 0', { checks: [validCheck({ timeoutMs: 0 })] }, 'plan.checks[0].timeoutMs'],
    ['timeout 为负', { checks: [validCheck({ timeoutMs: -1 })] }, 'plan.checks[0].timeoutMs'],
    ['timeout 非整数', { checks: [validCheck({ timeoutMs: 1.5 })] }, 'plan.checks[0].timeoutMs'],
    ['timeout 超上限', { checks: [validCheck({ timeoutMs: BASELINE_CHECK_TIMEOUT_MAX_MS + 1 })] }, 'plan.checks[0].timeoutMs'],
    ['timeout 非数字', { checks: [validCheck({ timeoutMs: '600000' })] }, 'plan.checks[0].timeoutMs'],
    ['required 非布尔', { checks: [validCheck({ required: 'yes' })] }, 'plan.checks[0].required'],
    ['检查项未知字段', { checks: [validCheck({ env: { A: '1' } })] }, 'plan.checks[0].env'],
    ['计划未知字段', { checks: [validCheck()], extra: 1 }, 'plan.extra'],
    ['明文秘密字段', { checks: [validCheck({ token: 'SECRET' })] }, 'plan.checks[0].token'],
  ];

  it.each(invalidCases)('拒绝非法计划：%s', (_name, plan, field) => {
    expectInvalidInput(() => validateBaselineCheckPlan(plan, 'baseline.preview'), field);
  });

  it('拒绝客户端提权字段（actor/principal/scope/capabilities）', () => {
    for (const key of ['actorId', 'principal', 'principalId', 'capabilities', 'scope']) {
      expectInvalidInput(
        () => validateBaselineCheckPlan({ checks: [validCheck()], [key]: 'x' }, 'baseline.preview'),
        `plan.${key}`,
      );
    }
  });

  it('planDigest 对等价键序稳定、对内容变化敏感', () => {
    const a = validateBaselineCheckPlan(validPlan(), 'baseline.preview');
    const reordered = validateBaselineCheckPlan(
      { checks: [validCheck({ timeoutMs: 600_000 })] },
      'baseline.preview',
    );
    expect(computeBaselinePlanDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBaselinePlanDigest(a)).toBe(computeBaselinePlanDigest(reordered));
    const changed = validateBaselineCheckPlan(
      { checks: [validCheck({ argv: ['node', '--test', '--watch'] })] },
      'baseline.preview',
    );
    expect(computeBaselinePlanDigest(changed)).not.toBe(computeBaselinePlanDigest(a));
  });
});

describe('F-002 基线命令 payload 校验（§6）', () => {
  it('preview payload：仅 {plan}，拒绝未知/提权字段', () => {
    const ok = validateBaselinePreviewPayload({ plan: validPlan() });
    expect(ok.plan.checks).toHaveLength(1);
    expectInvalidInput(() => validateBaselinePreviewPayload({ plan: validPlan(), decision: 'authorize' }), 'payload.decision');
    expectInvalidInput(() => validateBaselinePreviewPayload({ plan: validPlan(), actorId: 'root' }), 'payload.actorId');
    expectInvalidInput(() => validateBaselinePreviewPayload({}), 'payload.plan');
  });

  it('run payload：authorize/decline + plan + previewDigest', () => {
    const authorize = validateBaselineRunPayload({
      decision: 'authorize',
      plan: validPlan(),
      previewDigest: DIGEST_A,
    });
    expect(authorize.decision).toBe('authorize');
    expect(authorize.previewDigest).toBe(DIGEST_A);
    const decline = validateBaselineRunPayload({
      decision: 'decline',
      plan: validPlan(),
      previewDigest: DIGEST_B,
    });
    expect(decline.decision).toBe('decline');
  });

  it.each([
    ['未知 decision', { decision: 'maybe', plan: validPlan(), previewDigest: DIGEST_A }, 'payload.decision'],
    ['previewDigest 非摘要', { decision: 'authorize', plan: validPlan(), previewDigest: 'xyz' }, 'payload.previewDigest'],
    ['缺少 plan', { decision: 'authorize', previewDigest: DIGEST_A }, 'payload.plan'],
    ['提权字段 principalId', { decision: 'authorize', plan: validPlan(), previewDigest: DIGEST_A, principalId: 'local-owner' }, 'payload.principalId'],
    ['明文秘密字段', { decision: 'authorize', plan: validPlan(), previewDigest: DIGEST_A, apiKey: 'SECRET' }, 'payload.apiKey'],
  ])('拒绝非法 run payload：%s', (_n, payload, field) => {
    expectInvalidInput(() => validateBaselineRunPayload(payload), field);
  });

  it('cancel payload：operationId 必须为 UUID v4', () => {
    expect(validateBaselineCancelPayload({ operationId: UUID_A })).toEqual({ operationId: UUID_A });
    expectInvalidInput(() => validateBaselineCancelPayload({ operationId: 'not-a-uuid' }), 'payload.operationId');
    expectInvalidInput(() => validateBaselineCancelPayload({}), 'payload.operationId');
    expectInvalidInput(() => validateBaselineCancelPayload({ operationId: UUID_A, scope: {} }), 'payload.scope');
  });
});

describe('F-002 仓库路径 / 项目元数据 / 授权摘要校验（§6.2/§7.2）', () => {
  it('repositoryPath 必须是绝对路径且不含 NUL', () => {
    expect(validateRepositoryRootPath('/Users/dev/repo', 'projects.inspect')).toBe('/Users/dev/repo');
    expectInvalidInput(() => validateRepositoryRootPath('relative/repo', 'projects.inspect'), 'path');
    expectInvalidInput(() => validateRepositoryRootPath('/a\0b', 'projects.inspect'), 'path');
    expectInvalidInput(() => validateRepositoryRootPath(7, 'projects.inspect'), 'path');
  });

  it('project init 请求复用元数据规则并校验路径', () => {
    const ok = validateProjectInitRequest({
      repositoryPath: '/Users/dev/repo',
      displayName: '  Demo  ',
      labels: ['Alpha', 'alpha'],
    });
    expect(ok.repositoryPath).toBe('/Users/dev/repo');
    expect(ok.displayName).toBe('Demo');
    expect(ok.labels).toEqual(['alpha']);
    expectInvalidInput(
      () => validateProjectInitRequest({ repositoryPath: 'relative', displayName: 'x' }),
      'payload.repositoryPath',
    );
    expectInvalidInput(
      () => validateProjectInitRequest({ repositoryPath: '/abs', displayName: '' }),
      'payload.displayName',
    );
  });

  it('代码身份与授权摘要按契约形状校验', () => {
    const identity = validateBaselineCodeIdentity({
      headCommit: null,
      workingTreeDigest: DIGEST_A,
      hasUncommittedChanges: true,
    });
    expect(identity.headCommit).toBeNull();
    expectInvalidInput(
      () => validateBaselineCodeIdentity({ headCommit: null, workingTreeDigest: 'short', hasUncommittedChanges: false }),
      'codeIdentity.workingTreeDigest',
    );

    const summary = validateBaselineAuthorizationSummary({
      projectId: UUID_A,
      repositoryBindingId: UUID_B,
      codeIdentity: { headCommit: null, workingTreeDigest: DIGEST_A, hasUncommittedChanges: false },
      policyRevision: DIGEST_A,
      planDigest: DIGEST_A,
      plan: validPlan(),
      authorizedBy: 'local-owner',
      authorizedAt: '2026-10-09T00:00:00.000Z',
    });
    expect(summary.planDigest).toBe(DIGEST_A);
    expect(summary.plan.checks).toHaveLength(1);
    expectInvalidInput(
      () =>
        validateBaselineAuthorizationSummary({
          projectId: UUID_A,
          repositoryBindingId: UUID_B,
          codeIdentity: { headCommit: null, workingTreeDigest: DIGEST_A, hasUncommittedChanges: false },
          policyRevision: DIGEST_A,
          planDigest: DIGEST_A,
          plan: validPlan(),
          authorizedBy: '',
          authorizedAt: '2026-10-09T00:00:00.000Z',
        }),
      'authorization.authorizedBy',
    );
  });

  it('能力校验只接受两项基线能力', () => {
    expect(validateBaselineCapability('baseline.read')).toBe('baseline.read');
    expect(validateBaselineCapability('baseline.run')).toBe('baseline.run');
    let caught: unknown;
    try {
      validateBaselineCapability('admin.root');
    } catch (error) {
      caught = error;
    }
    expect(isPublicError(caught, 'unsupported')).toBe(true);
    expect((caught as PublicError).details).toMatchObject({ field: 'capability' });
  });
});

describe('F-002 分页校验（§7.1/§7.4）', () => {
  it('默认与合法分页', () => {
    expect(validateBaselineListQuery(undefined)).toEqual({ limit: BASELINE_LIST_DEFAULT_LIMIT });
    expect(validateBaselineListQuery({ limit: 100 })).toEqual({ limit: 100 });
    expect(validateBaselineListQuery({ limit: 1, cursor: UUID_A })).toEqual({ limit: 1, cursor: UUID_A });
  });

  it.each([
    ['limit 为 0', { limit: 0 }, 'query.limit'],
    ['limit 超上限', { limit: 101 }, 'query.limit'],
    ['limit 非整数', { limit: 2.5 }, 'query.limit'],
    ['limit 为字符串', { limit: '20' }, 'query.limit'],
    ['cursor 非法', { cursor: 'not-a-uuid' }, 'query.cursor'],
    ['未知查询参数', { limit: 20, page: 2 }, 'query.page'],
  ])('拒绝非法分页：%s', (_n, query, field) => {
    expectInvalidInput(() => validateBaselineListQuery(query), field);
  });
});

describe('F-002 结果摘要与健康派生（§8，三轴分离）', () => {
  it('summarizeBaselineChecks 分桶计数', () => {
    const counts = summarizeBaselineChecks([
      { status: 'passed', required: true },
      { status: 'passed', required: false },
      { status: 'failed', required: true },
      { status: 'error', required: true },
      { status: 'inconclusive', required: true },
      { status: 'not_run', required: true },
    ]);
    expect(counts).toEqual({ total: 6, passed: 2, failed: 1, error: 1, inconclusive: 1, notRun: 1 });
  });

  it('reason 到检查状态分类可区分六类失败', () => {
    expect(baselineCheckStatusForReason('missing_command')).toBe('error');
    expect(baselineCheckStatusForReason('unknown_script')).toBe('error');
    expect(baselineCheckStatusForReason('spawn_failed')).toBe('error');
    expect(baselineCheckStatusForReason('permission_denied')).toBe('error');
    expect(baselineCheckStatusForReason('timed_out')).toBe('inconclusive');
    expect(baselineCheckStatusForReason('cancelled')).toBe('inconclusive');
    expect(baselineCheckStatusForReason('authorization_rejected')).toBe('not_run');
    expect(baselineCheckStatusForReason('empty_check_set')).toBe('not_run');
    // 非检查级 reason（占用/预览过期）不对应检查状态。
    expect(baselineCheckStatusForReason('baseline_in_progress')).toBeNull();
    expect(baselineCheckStatusForReason('preview_stale')).toBeNull();
  });

  const completedOp = {
    operationId: UUID_A,
    kind: 'baseline' as const,
    status: 'completed' as const,
    createdAt: '2026-10-09T00:00:00.000Z',
    startedAt: '2026-10-09T00:00:01.000Z',
    endedAt: '2026-10-09T00:00:05.000Z',
  };

  it('无终态操作 → not_run（no_baseline），绝不 healthy', () => {
    const health = deriveProjectHealth({ operation: null, checks: [] });
    expect(health.status).toBe('not_run');
    expect(health.reasonCode).toBe('no_baseline');
    expect(health.lastBaselineOperationId).toBeNull();
  });

  it('空检查集不能汇总为健康通过', () => {
    const health = deriveProjectHealth({ operation: completedOp, checks: [] });
    expect(health.status).toBe('unhealthy');
    expect(health.reasonCode).toBe('empty_check_set');
  });

  it('全部必需检查通过且无取消资格原因 → healthy', () => {
    const health = deriveProjectHealth({
      operation: completedOp,
      checks: [
        { status: 'passed', required: true, reasonCode: undefined },
        { status: 'passed', required: false, reasonCode: undefined },
      ],
    });
    expect(health.status).toBe('healthy');
    expect(health.lastBaselineOperationId).toBe(UUID_A);
    expect(health.lastCompletedAt).toBe('2026-10-09T00:00:05.000Z');
  });

  it('非必需检查失败不影响必需项通过时的健康（§8.2 只判必需）', () => {
    const health = deriveProjectHealth({
      operation: completedOp,
      checks: [
        { status: 'passed', required: true, reasonCode: undefined },
        { status: 'failed', required: false, reasonCode: undefined },
      ],
    });
    expect(health.status).toBe('healthy');
  });

  it.each([
    ['必需项失败', { status: 'failed' as const, required: true, reasonCode: undefined }, 'unhealthy'],
    ['必需项缺命令', { status: 'error' as const, required: true, reasonCode: 'missing_command' as const }, 'unhealthy'],
    ['必需项超时', { status: 'inconclusive' as const, required: true, reasonCode: 'timed_out' as const }, 'unhealthy'],
    ['必需项未执行', { status: 'not_run' as const, required: true, reasonCode: undefined }, 'unhealthy'],
  ])('必需检查非 passed → %s', (_n, check, expected) => {
    const health = deriveProjectHealth({ operation: completedOp, checks: [check] });
    expect(health.status).toBe(expected);
    expect(health.status).not.toBe('healthy');
  });

  it.each(['source_changed', 'evidence_incomplete', 'output_overflow'] as const)(
    '取消资格原因 %s 使健康失败',
    (reasonCode) => {
      const health = deriveProjectHealth({
        operation: completedOp,
        checks: [
          { status: 'passed', required: true, reasonCode: undefined },
          { status: 'inconclusive', required: false, reasonCode },
        ],
      });
      expect(health.status).toBe('unhealthy');
      expect(health.reasonCode).toBe(reasonCode);
    },
  );

  it('停止未确认（操作 failed）→ unhealthy，保留原因码', () => {
    const health = deriveProjectHealth({
      operation: {
        operationId: UUID_B,
        kind: 'baseline',
        status: 'failed',
        reasonCode: 'stop_unconfirmed',
        createdAt: '2026-10-09T00:00:00.000Z',
        startedAt: '2026-10-09T00:00:01.000Z',
        endedAt: null,
      },
      checks: [{ status: 'inconclusive', required: true, reasonCode: 'stop_unconfirmed' }],
    });
    expect(health.status).toBe('unhealthy');
    expect(health.reasonCode).toBe('stop_unconfirmed');
  });

  it('操作 not_run（授权被拒）→ not_run，不折算通过', () => {
    const health = deriveProjectHealth({
      operation: {
        operationId: UUID_A,
        kind: 'baseline',
        status: 'not_run',
        reasonCode: 'authorization_rejected',
        createdAt: '2026-10-09T00:00:00.000Z',
        startedAt: null,
        endedAt: null,
      },
      checks: [],
    });
    expect(health.status).toBe('not_run');
    expect(health.reasonCode).toBe('authorization_rejected');
  });

  it('summarizeBaselineOperation 汇总逐项计数', () => {
    const summary = summarizeBaselineOperation({
      operationId: UUID_A,
      kind: 'baseline',
      status: 'completed',
      createdAt: '2026-10-09T00:00:00.000Z',
      startedAt: '2026-10-09T00:00:01.000Z',
      endedAt: '2026-10-09T00:00:05.000Z',
      checks: [
        { status: 'passed', required: true },
        { status: 'failed', required: false },
      ],
    });
    expect(summary.operationId).toBe(UUID_A);
    expect(summary.summary).toEqual({ total: 2, passed: 1, failed: 1, error: 0, inconclusive: 0, notRun: 0 });
  });

  it('注册状态与健康状态枚举严格分开', () => {
    expect([...PROJECT_REGISTRATION_STATUSES]).toEqual(['registered', 'not_registered']);
    expect([...PROJECT_HEALTH_STATUSES]).toEqual(['healthy', 'unhealthy', 'not_run']);
    // 注册成功不蕴含健康通过：健康枚举不含 registered。
    expect(PROJECT_HEALTH_STATUSES).not.toContain('registered' as never);
  });
});

describe('F-002 纯契约模块无 I/O 副作用（AC4）', () => {
  it('源码不导入 HTTP/ORM/Pi/进程/文件系统/网络实现', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/core/src/ports/baseline.ts'), 'utf-8');
    const importLines = source
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '))
      .join('\n');
    for (const forbidden of [
      'node:fs',
      'node:child_process',
      'node:http',
      'node:https',
      'node:net',
      'node:worker_threads',
      'better-sqlite3',
      'drizzle-orm',
      'electron',
      '@anthropic',
      'shiploop-host',
      'shiploop-cli',
    ]) {
      expect(importLines).not.toContain(forbidden);
    }
  });
});
