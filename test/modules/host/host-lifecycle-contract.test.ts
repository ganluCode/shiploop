/**
 * F-002 Host 生命周期契约模块回归（纯类型 + 运行时校验，无任何 I/O 与副作用）。
 *
 * 协议依据（唯一）：docs/p02-1-host-lifecycle-contract.md
 * - §3.2 数据根身份 sha256hex(realpath)；
 * - §5 发现文件严格结构（schemaVersion/protocolVersion/hostInstanceId/
 *   dataRootIdentity/listenAddress/port/pid/startedAt，未知字段拒绝）；
 * - §7.1/§7.3 版本与结构化脱敏错误；
 * - §8 握手请求/响应；§9 状态响应；§10 stop 请求、requestDigest 与停止视图；
 * - §14 错误码与 HTTP 映射。
 *
 * 本套件只做纯函数正反例：不监听端口、不读用户目录、不启动进程。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertStopTargetsCurrentInstance,
  ACTIVITY_SCOPE_IDLE_ONLY,
  CURRENT_HOST_CAPABILITIES,
  hostCapabilitiesForDelivery,
  FEATURE_DELIVERY_COMMAND_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  DISCOVERY_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  HANDSHAKE_TIMEOUT_MS,
  HostProtocolError,
  IDEMPOTENCY_SCHEME,
  LIFECYCLE_STATES,
  LOCK_ACQUIRE_TIMEOUT_MS,
  LOOPBACK_LISTEN_ADDRESS,
  MAX_HTTP_BODY_BYTES,
  QUIESCE_BUDGET_MS,
  STATUS_ROUTE,
  STOP_MODE_GRACEFUL,
  STOP_ROUTE,
  STOP_TIMEOUT_MS,
  SUPPORTED_PROTOCOL_VERSIONS,
  SUPPORTED_STOP_MODES,
  TCP_CONNECT_TIMEOUT_MS,
  assertBodyWithinLimit,
  computeDataRootIdentity,
  computeStopRequestDigest,
  isHostProtocolError,
  isUuidV4,
  parseDiscoveryText,
  parseJsonBody,
  stableCanonicalJson,
  validateDiscoveryRecord,
  validateHandshakeRequest,
  validateHandshakeRequestShape,
  validateHandshakeResponse,
  validateStatusResponse,
  validateStopRequest,
  validateStopRequestShape,
  validateStopResultView,
  verifyStopRequestDigest,
} from '../../../packages/host/src/index.ts';
import { COMMAND_OPERATIONS, EXECUTION_CONTROL_QUERY_OPERATIONS, EXECUTION_SCHEDULE_QUERY_OPERATIONS, FEATURE_DELIVERY_QUERY_OPERATIONS, GIT_OPERATION_QUERY_OPERATIONS, PLAN_APPROVAL_QUERY_OPERATION, PLAN_QUERY_OPERATIONS, QUERY_OPERATIONS, TASK_EVIDENCE_QUERY_OPERATIONS } from '../../../packages/core/src/index.ts';
import type {
  HostDiscoveryRecord,
  HostErrorCode,
  HostOperation,
  StopOptions,
} from '../../../packages/host/src/index.ts';

const INSTANCE_ID = '0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10';
const COMMAND_ID = 'fa3d1b0e-4b6f-4b7a-9c0d-2e6a8f1b3d55';
const ROOT_IDENTITY = `9f2a${'0'.repeat(60)}`;
const STARTED_AT = '2026-10-05T00:20:00.000Z';
const PORT = 54321;
const PID = 48210;

function validDiscovery(): Record<string, unknown> {
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId: INSTANCE_ID,
    dataRootIdentity: ROOT_IDENTITY,
    listenAddress: LOOPBACK_LISTEN_ADDRESS,
    port: PORT,
    pid: PID,
    startedAt: STARTED_AT,
  };
}

function validHandshakeBody(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId: INSTANCE_ID,
    dataRootIdentity: ROOT_IDENTITY,
  };
}

function validHandshakeResponse(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId: INSTANCE_ID,
    dataRootIdentity: ROOT_IDENTITY,
    lifecycleState: 'ready',
    startedAt: STARTED_AT,
    capabilities: structuredClone(CURRENT_HOST_CAPABILITIES),
  };
}

function validStatusBody(stop: unknown = null): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    hostInstanceId: INSTANCE_ID,
    dataRootIdentity: ROOT_IDENTITY,
    lifecycleState: 'ready',
    pid: PID,
    startedAt: STARTED_AT,
    activities: { accepted: 0, quiescing: 0 },
    stop,
  };
}

function expectHostError(
  fn: () => unknown,
  code: HostErrorCode,
  operation: HostOperation,
): HostProtocolError {
  try {
    fn();
  } catch (error) {
    expect(isHostProtocolError(error), `expected HostProtocolError(${code}), got ${String(error)}`).toBe(
      true,
    );
    const protocolError = error as HostProtocolError;
    expect(protocolError.code).toBe(code);
    expect(protocolError.operation).toBe(operation);
    expect(typeof protocolError.message).toBe('string');
    expect(protocolError.message.length).toBeGreaterThan(0);
    return protocolError;
  }
  throw new Error(`expected HostProtocolError(${code}) to be thrown`);
}

describe('F-002 冻结常量与能力声明', () => {
  it('版本、回环地址、体积与预算均为契约冻结值', () => {
    expect(DISCOVERY_SCHEMA_VERSION).toBe(1);
    // P02-2 §3.1：线消息升 v2；P02-3 / F-006 起升 v3（能力集合扩张，见
    // docs/p02-3-onboarding-contract.md §3.1/§15.5）；P03-1 / F-009 起升 v4
    //（计划域命令/查询进入握手能力集合，见 docs/p03-1-plan-import-contract.md §5/§9.6）；
    // P03-2 / F-007 起升 v5（决策/策略/输入准备三命令与审批查询进入能力集合，
    // 见 docs/p03-2-plan-approval-contract.md）；发现 schemaVersion 与线协议版本不联动。
    expect(CURRENT_SCHEMA_VERSION).toBe(5);
    expect(CURRENT_PROTOCOL_VERSION).toBe(1);
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([1]);
    expect(LOOPBACK_LISTEN_ADDRESS).toBe('127.0.0.1');
    expect(MAX_HTTP_BODY_BYTES).toBe(16_384);
    expect(TCP_CONNECT_TIMEOUT_MS).toBe(2_000);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(10_000);
    expect(STOP_TIMEOUT_MS).toBe(15_000);
    expect(QUIESCE_BUDGET_MS).toBe(10_000);
    expect(LOCK_ACQUIRE_TIMEOUT_MS).toBe(10_000);
    expect(HANDSHAKE_ROUTE).toBe('/v1/host/handshake');
    expect(STATUS_ROUTE).toBe('/v1/host/status');
    expect(STOP_ROUTE).toBe('/v1/host/stop');
  });

  it('capabilities 只声明真实接线的能力（P02-2 §11.3 结构化视图；idle-only graceful stop，F-012 起 events 为 SSE 结构化视图）', () => {
    expect(CURRENT_HOST_CAPABILITIES).toEqual({
      lifecycleRoutes: ['handshake', 'status', 'stop'],
      stop: {
        modes: ['graceful'],
        idempotency: 'commandId+requestDigest',
        activityScope: 'idle-only',
      },
      application: {
        commands: [
          'execution.attempt.cancel',
          // P03-9 / F-001：Run/Batch Task 边界暂停经既有 /v1/commands 通用路由接线。
          'execution.pause',
          // P03-9 / F-002：Run/Batch 取消经同一命令路由接线。
          'execution.cancel',
          // P03-9 / F-008：显式工作流 resume 经同一命令路由接线。
          'execution.resume',
          // P03-9 / F-010：finalization-only retryFinal 经同一命令路由接线。
          'execution.retryFinal',
          'project.register',
          'project.metadata.update',
          'settings.global.create',
          'settings.global.update',
          'settings.project.create',
          'settings.project.update',
          // P02-3：基线 preview/run（F-008）与 cancel（F-014）经既有 /v1/commands 路由真实接线。
          'baseline.preview',
          'baseline.run',
          'baseline.cancel',
          // P03-1 / F-004：Phase 创建经既有 /v1/commands 通用路由接线。
          'phase.create',
          // P03-1 / F-005：计划导入经既有 /v1/commands 通用路由接线。
          'feature.plan.import',
          // P03-1 / F-007：纯标签 CAS 编辑经既有 /v1/commands 通用路由接线。
          'plan.labels.update',
          // P03-1 / F-008：实质计划修订经既有 /v1/commands 通用路由接线。
          'feature.plan.revise',
          // P03-2 / F-001：Task 策略副本 CAS 编辑经既有 /v1/commands 通用路由接线。
          'task.strategy.update',
          // P03-2 / F-002：计划批准/拒绝决策经既有 /v1/commands 通用路由接线。
          'feature.plan.decide',
          'task.approval.block',
          'task.approval.approve',
          'task.approval.reject',
          'task.approval.unblock',
          'task.verification.continue',
          // P03-2 / F-006：执行输入制品组准备经既有 /v1/commands 通用路由接线
          //（HostClient/CLI 入口属后续任务）。
          'execution.input.prepare',
          // P03-3 / F-004：单 Feature 执行 prepare 预览经既有 /v1/commands 通用
          // 路由接线（只读预览；HostClient/CLI 入口属后续任务）。
          'execution.preview',
          // P03-3 / F-005：显式执行启动经既有 /v1/commands 通用路由接线（同一
          // 命令面；HostClient/CLI 入口属 F-011/F-012）。
          'execution.start',
          // P03-3 / F-009：批次预算显式修订经既有 /v1/commands 通用路由接线
          //（仅增额不自动启动或恢复 Run；HostClient/CLI 入口属 F-011/F-012）。
          'execution.budget.revise',
          'workspace.discard',
          'workspace.discard.preview',
        ],
        queries: [
          'execution.sessions.list',
          'execution.session.get',
          'execution.session.evidence.get',
          'projects.list',
          'projects.get',
          'projects.binding.get',
          'projects.labelCounts',
          'projects.inspect',
          'projects.overview',
          'settings.global.get',
          'settings.global.export',
          'settings.project.get',
          'settings.project.effective',
          'settings.project.export',
          'receipts.get',
          'results.resolve',
          'snapshot.get',
          // P02-3 / F-014：基线分页/详情/证据正文查询真实接线。
          'baselines.list',
          'baselines.get',
          'artifacts.get',
          // P03-1 / F-009：计划域六项查询真实接线（能力位复用 project.read）。
          'phases.list',
          'phases.get',
          'features.list',
          'features.get',
          'tasks.list',
          'tasks.get',
          // P03-2 / F-007：审批决策查询真实接线（能力位复用 project.read）。
          'features.approvals',
          'execution.budget.get',
          'execution.budget.revisions',
          // P03-4 / F-008：调度诊断与 Attempt 审计三查询真实接线（同上能力位）。
          'execution.run.schedule',
          'execution.attempts.list',
          'execution.attempt.diagnostics',
          // P03-7 / F-013：Task 机器证据/人审/返工链查询真实接线。
          'execution.task.verification.get',
          'execution.task.approvals.list',
          'execution.task.rework-chain.list',
          'workspaces.list',
          'workspaces.get',
          'workspace.operations.list',
          'workspace.operations.get',
          // P03-8 / F-009：Git 意图/实际提交/操作回执查询真实接线。
          'git.operations.list',
          'git.operations.get',
          // P03-8 / F-010：Feature 分轴结果查询真实接线。
          'features.delivery.get',
          'features.report.get',
          // P03-9 / F-013：Run/Batch 控制进度、恢复诊断与 finalization 收尾结果查询真实接线。
          'execution.run.control.get',
          'execution.batch.control.get',
          'execution.run.recovery.get',
        ],
        events: { transport: 'sse', route: '/v1/events', scopes: ['project', 'global'] },
      },
    });
    // 接线宣告与 Core 支持面交叉核对（不漂移：Core 增删操作必须同步接线与宣告）。
    expect([...CURRENT_HOST_CAPABILITIES.application.commands]).toEqual(
      COMMAND_OPERATIONS.filter(operation => !(FEATURE_DELIVERY_COMMAND_CAPABILITIES as readonly string[]).includes(operation)));
    expect([...hostCapabilitiesForDelivery(true).application.commands]).toEqual([...COMMAND_OPERATIONS]);
    // P02-3：queries = P02-2 的 QUERY_OPERATIONS + 已接线的静态接入两项（F-006）
    // + 已接线的基线分页/详情/证据三项（F-014，与 BASELINE_QUERY_OPERATIONS 同步）
    // + P03-1 / F-009 计划域六项（与 PLAN_QUERY_OPERATIONS 同步，能力位复用 project.read）
    // + P03-2 / F-007 审批决策查询（与 PLAN_APPROVAL_QUERY_OPERATION 同步）
    // + P03-4 / F-008 调度诊断/Attempt 审计三项（与 EXECUTION_SCHEDULE_QUERY_OPERATIONS 同步）
    // + P03-7 / F-013 Task 证据/人审/返工链三项（与 TASK_EVIDENCE_QUERY_OPERATIONS 同步）
    // + P03-8 / F-009 Git 意图/实际提交/操作回执两项（与 GIT_OPERATION_QUERY_OPERATIONS 同步）
    // + P03-8 / F-010 Feature 分轴结果查询（与 FEATURE_DELIVERY_QUERY_OPERATIONS 同步）。
    // + P03-9 / F-013 控制进度/恢复诊断三项（与 EXECUTION_CONTROL_QUERY_OPERATIONS 同步）。
    expect([...CURRENT_HOST_CAPABILITIES.application.queries]).toEqual([
      'execution.sessions.list',
      'execution.session.get',
      'execution.session.evidence.get',
      ...QUERY_OPERATIONS.slice(0, 4),
      'projects.inspect',
      'projects.overview',
      ...QUERY_OPERATIONS.slice(4),
      'baselines.list',
      'baselines.get',
      'artifacts.get',
      ...PLAN_QUERY_OPERATIONS,
      PLAN_APPROVAL_QUERY_OPERATION,
      'execution.budget.get',
      'execution.budget.revisions',
      ...EXECUTION_SCHEDULE_QUERY_OPERATIONS,
      ...TASK_EVIDENCE_QUERY_OPERATIONS,
      'workspaces.list',
      'workspaces.get',
      'workspace.operations.list',
      'workspace.operations.get',
      ...GIT_OPERATION_QUERY_OPERATIONS,
      ...FEATURE_DELIVERY_QUERY_OPERATIONS,
      'features.report.get',
      ...EXECUTION_CONTROL_QUERY_OPERATIONS,
    ]);
    expect(CURRENT_HOST_CAPABILITIES.application.commands).toContain('baseline.cancel');
    expect(CURRENT_HOST_CAPABILITIES.application.queries).toContain('baselines.list');
    expect(CURRENT_HOST_CAPABILITIES.application.queries).toContain('baselines.get');
    expect(CURRENT_HOST_CAPABILITIES.application.queries).toContain('artifacts.get');
    expect(IDEMPOTENCY_SCHEME).toBe('commandId+requestDigest');
    expect(ACTIVITY_SCOPE_IDLE_ONLY).toBe('idle-only');
    expect([...SUPPORTED_STOP_MODES]).toEqual([STOP_MODE_GRACEFUL]);
    expect([...LIFECYCLE_STATES]).toEqual(['starting', 'ready', 'quiescing', 'stopping']);
  });
});

describe('F-002 §3.2 数据根身份', () => {
  it('对 realpath 原样字符串做 sha256，输出 64 位小写 hex', () => {
    const canonicalRoot = '/private/tmp/shiploop-root';
    const expected = createHash('sha256').update(canonicalRoot, 'utf8').digest('hex');
    expect(computeDataRootIdentity(canonicalRoot)).toBe(expected);
    expect(computeDataRootIdentity(canonicalRoot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('相同字符串身份相同；不同字符串身份不同；不做尾斜杠归一（归一责任只属于 realpath）', () => {
    const a = computeDataRootIdentity('/srv/root-a');
    const alias = computeDataRootIdentity('/srv/root-a');
    const trailing = computeDataRootIdentity('/srv/root-a/');
    const b = computeDataRootIdentity('/srv/root-b');
    expect(a).toBe(alias);
    expect(a).not.toBe(trailing);
    expect(a).not.toBe(b);
  });

  it('身份是纯计算：非字符串、空串或含 NUL 明确拒绝（不返回垃圾值）', () => {
    expect(() => computeDataRootIdentity(42 as unknown as string)).toThrow(TypeError);
    expect(() => computeDataRootIdentity('')).toThrow(TypeError);
    expect(() => computeDataRootIdentity('/srv/root\0')).toThrow(TypeError);
  });
});

describe('F-002 UUID v4 与摘要字符集', () => {
  it('接受 randomUUID() 形态的规范小写 UUID v4', () => {
    expect(isUuidV4(randomUUID())).toBe(true);
    expect(isUuidV4(INSTANCE_ID)).toBe(true);
    expect(isUuidV4(COMMAND_ID)).toBe(true);
  });

  it.each([
    ['大写', INSTANCE_ID.toUpperCase()],
    ['nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['v1', 'a87f4b00-12f3-11f0-8f2a-2b3c4d5e6f70'],
    ['版本位错误', '0c9c2e51-9a91-9f63-8d92-4b7b9a7c2f10'],
    ['变体位错误', '0c9c2e51-9a91-4f63-cd92-4b7b9a7c2f10'],
    ['缺段', '0c9c2e51-9a91-4f63-8d92'],
    ['非字符串', 123],
    ['空串', ''],
    ['带花括号', `{${INSTANCE_ID}}`],
  ])('拒绝非法 UUID：%s', (_label, value) => {
    expect(isUuidV4(value)).toBe(false);
  });
});

describe('F-002 §5 发现文件校验', () => {
  it('合法发现包含全部 8 个冻结字段并原样通过', () => {
    const record = validateDiscoveryRecord(validDiscovery());
    expect(record).toEqual({
      schemaVersion: 1,
      protocolVersion: 1,
      hostInstanceId: INSTANCE_ID,
      dataRootIdentity: ROOT_IDENTITY,
      listenAddress: '127.0.0.1',
      port: PORT,
      pid: PID,
      startedAt: STARTED_AT,
    } satisfies HostDiscoveryRecord);
  });

  it('端口接受 1 与 65535，拒绝 0/越界/小数/字符串（禁止 0，发布值必须等于实际端口）', () => {
    for (const port of [1, 65535]) {
      const body = validDiscovery();
      body.port = port;
      expect(validateDiscoveryRecord(body).port).toBe(port);
    }
    for (const port of [0, -1, 65536, 1.5, '54321', null, NaN]) {
      const body = validDiscovery();
      body.port = port;
      const error = expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
      expect(String(error.details?.field)).toMatch(/(^|\.)port$/);
    }
  });

  it('pid 接受 1..2^31-1，拒绝 0/负数/2^31/小数/字符串', () => {
    const maxPid = 2 ** 31 - 1;
    expect(validateDiscoveryRecord({ ...validDiscovery(), pid: 1 }).pid).toBe(1);
    expect(validateDiscoveryRecord({ ...validDiscovery(), pid: maxPid }).pid).toBe(maxPid);
    for (const pid of [0, -1, 2 ** 31, 1.5, '48210', null]) {
      const body = validDiscovery();
      body.pid = pid;
      const error = expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
      expect(String(error.details?.field)).toMatch(/(^|\.)pid$/);
    }
  });

  it.each([
    ['localhost', 'localhost'],
    ['::1', '::1'],
    ['0.0.0.0', '0.0.0.0'],
    ['其他回环 IP', '127.0.0.2'],
    ['外网 IP', '8.8.8.8'],
    ['域名', 'host.local'],
  ])('listenAddress 只接受精确的 127.0.0.1：%s', (_label, address) => {
    const body = validDiscovery();
    body.listenAddress = address;
    const error = expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
    expect(String(error.details?.field)).toMatch(/(^|\.)listenAddress$/);
  });

  it.each([
    ['缺字段 schemaVersion', { ...(({ schemaVersion: _v, ...rest }) => rest)(validDiscovery()) }],
    ['缺字段 hostInstanceId', { ...(({ hostInstanceId: _v, ...rest }) => rest)(validDiscovery()) }],
    ['缺字段 dataRootIdentity', { ...(({ dataRootIdentity: _v, ...rest }) => rest)(validDiscovery()) }],
    ['缺字段 startedAt', { ...(({ startedAt: _v, ...rest }) => rest)(validDiscovery()) }],
  ])('缺字段拒绝：%s', (_label, body) => {
    const error = expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
    expect(typeof error.details?.field).toBe('string');
  });

  it('未知字段一律拒绝（含原型污染键），不做前向宽容', () => {
    // __proto__ 经 JSON.parse 构造为自有数据属性（对象字面量形式只会改原型，不产生自有键）。
    for (const extra of [{ future: 1 }, JSON.parse('{"__proto__":{"x":1}}'), { constructor: { x: 1 } }]) {
      const body = { ...validDiscovery(), ...extra };
      expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
    }
  });

  it('未知发现 schemaVersion / protocolVersion 拒绝且不猜测降级', () => {
    const futureSchema = validDiscovery();
    futureSchema.schemaVersion = 2;
    const schemaError = expectHostError(
      () => validateDiscoveryRecord(futureSchema),
      'invalid_discovery',
      'host.discovery',
    );
    expect(schemaError.details?.reason).toBe('unsupported_schema_version');

    const futureProtocol = validDiscovery();
    futureProtocol.protocolVersion = 2;
    const protocolError = expectHostError(
      () => validateDiscoveryRecord(futureProtocol),
      'invalid_discovery',
      'host.discovery',
    );
    expect(protocolError.details?.reason).toBe('unsupported_protocol_version');
  });

  it('dataRootIdentity/hostInstanceId/版本类型非法逐项拒绝', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['identity-uppercase', { ...validDiscovery(), dataRootIdentity: 'A'.repeat(64) }],
      ['identity-short', { ...validDiscovery(), dataRootIdentity: 'a'.repeat(63) }],
      ['identity-long', { ...validDiscovery(), dataRootIdentity: 'a'.repeat(65) }],
      ['identity-nonhex', { ...validDiscovery(), dataRootIdentity: `${'a'.repeat(63)}g` }],
      ['instance-uuid', { ...validDiscovery(), hostInstanceId: 'not-a-uuid' }],
      ['schema-string', { ...validDiscovery(), schemaVersion: '1' }],
      ['protocol-string', { ...validDiscovery(), protocolVersion: '1' }],
    ];
    for (const [_label, body] of cases) {
      expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
    }
  });

  it.each([
    ['带时区偏移', '2026-10-05T08:20:00+08:00'],
    ['缺 Z', '2026-10-05T00:20:00.000'],
    ['非法日历', '2026-13-40T99:99:99.000Z'],
    ['日期形态', '2026-10-05'],
    ['数字', 1_234_567_890],
  ])('startedAt 只接受 ISO 8601 UTC：%s', (_label, value) => {
    const body = validDiscovery();
    body.startedAt = value;
    expectHostError(() => validateDiscoveryRecord(body), 'invalid_discovery', 'host.discovery');
  });

  it('接受秒与小数秒两种 UTC 形态', () => {
    expect(validateDiscoveryRecord({ ...validDiscovery(), startedAt: '2026-10-05T00:20:00Z' }).startedAt).toBe(
      '2026-10-05T00:20:00Z',
    );
  });

  it('非对象输入（null/数组/字符串/数字）拒绝', () => {
    for (const input of [null, [], 'text', 42, true]) {
      expectHostError(() => validateDiscoveryRecord(input), 'invalid_discovery', 'host.discovery');
    }
  });

  it('parseDiscoveryText：畸形 JSON 被拒且错误不回显原文', () => {
    const marker = 'SECRETMARKER-DO-NOT-ECHO';
    const error = expectHostError(
      () => parseDiscoveryText(`{ broken json ${marker}`),
      'invalid_discovery',
      'host.discovery',
    );
    expect(error.details?.reason).toBe('malformed_json');
    expect(error.message).not.toContain(marker);
    expect(JSON.stringify(error.toErrorBody())).not.toContain(marker);
  });

  it('parseDiscoveryText：合法 JSON 但结构非法同样拒绝；合法文本往返一致', () => {
    expectHostError(() => parseDiscoveryText('{"schemaVersion":2}'), 'invalid_discovery', 'host.discovery');
    const text = JSON.stringify(validDiscovery());
    expect(parseDiscoveryText(text).hostInstanceId).toBe(INSTANCE_ID);
  });
});

describe('F-002 §8 握手请求校验', () => {
  it('合法请求只含 4 个冻结字段，通过结构与版本校验', () => {
    const parsed = validateHandshakeRequest(validHandshakeBody());
    expect(parsed).toEqual({
      schemaVersion: 5,
      protocolVersion: 1,
      hostInstanceId: INSTANCE_ID,
      dataRootIdentity: ROOT_IDENTITY,
    });
  });

  it('未知字段/缺字段/类型错误/格式错误 → invalid_input（结构先于语义）', () => {
    const malformed: Array<[string, unknown]> = [
      ['unknown', { ...validHandshakeBody(), extra: 1 }],
      ['missing', { schemaVersion: 5, protocolVersion: 1 }],
      ['schema-type', { ...validHandshakeBody(), schemaVersion: '1' }],
      ['protocol-type', { ...validHandshakeBody(), protocolVersion: '1' }],
      ['instance', { ...validHandshakeBody(), hostInstanceId: 'nope' }],
      ['identity', { ...validHandshakeBody(), dataRootIdentity: 'z'.repeat(64) }],
      ['not-object', null],
      ['array', []],
    ];
    for (const [_label, body] of malformed) {
      expectHostError(() => validateHandshakeRequestShape(body), 'invalid_input', 'host.handshake');
    }
  });

  it('未知 schemaVersion → unsupported_schema_version（400 语义）', () => {
    const error = expectHostError(
      () => validateHandshakeRequest({ ...validHandshakeBody(), schemaVersion: 1 }),
      'unsupported_schema_version',
      'host.handshake',
    );
    expect(error.httpStatus).toBe(400);
  });

  it('不兼容 protocolVersion → protocol_incompatible 且 details 给支持版本', () => {
    const error = expectHostError(
      () => validateHandshakeRequest({ ...validHandshakeBody(), protocolVersion: 99 }),
      'protocol_incompatible',
      'host.handshake',
    );
    expect(error.httpStatus).toBe(426);
    expect(error.details?.supportedProtocolVersions).toEqual([1]);
  });
});

describe('F-002 §8 握手响应校验（客户端侧严格核验）', () => {
  const expectation = { expectedHostInstanceId: INSTANCE_ID, expectedDataRootIdentity: ROOT_IDENTITY };

  it('合法响应（含真实能力）通过', () => {
    const response = validateHandshakeResponse(validHandshakeResponse(), expectation);
    expect(response.hostInstanceId).toBe(INSTANCE_ID);
    expect(response.lifecycleState).toBe('ready');
    expect(response.capabilities.stop.activityScope).toBe('idle-only');
  });

  it('实例不符 → instance_mismatch；数据根不符 → data_root_mismatch（零业务请求前提）', () => {
    expectHostError(
      () => validateHandshakeResponse({ ...validHandshakeResponse(), hostInstanceId: randomUUID() }, expectation),
      'instance_mismatch',
      'host.handshake',
    );
    const wrongRoot = `1${'0'.repeat(63)}`;
    expectHostError(
      () => validateHandshakeResponse({ ...validHandshakeResponse(), dataRootIdentity: wrongRoot }, expectation),
      'data_root_mismatch',
      'host.handshake',
    );
  });

  it('对端高版本协议/Schema 被明确分类，不静默降级', () => {
    expectHostError(
      () =>
        validateHandshakeResponse(
          { ...validHandshakeResponse(), protocolVersion: 2 },
          expectation,
        ),
      'protocol_incompatible',
      'host.handshake',
    );
    expectHostError(
      () =>
        validateHandshakeResponse(
          { ...validHandshakeResponse(), schemaVersion: 1 },
          expectation,
        ),
      'unsupported_schema_version',
      'host.handshake',
    );
    expectHostError(
      () =>
        validateHandshakeResponse(
          { ...validHandshakeResponse(), schemaVersion: 99 },
          expectation,
        ),
      'unsupported_schema_version',
      'host.handshake',
    );
  });

  const applicationCapabilities = CURRENT_HOST_CAPABILITIES.application;
  const malformedResponseCases: Array<[string, Record<string, unknown>]> = [
    ['伪造生命周期状态', { lifecycleState: 'stopped' }],
    ['伪称支持事件', { capabilities: { ...CURRENT_HOST_CAPABILITIES, application: { ...applicationCapabilities, events: 'sse' } } }],
    ['伪称额外命令', { capabilities: { ...CURRENT_HOST_CAPABILITIES, application: { ...applicationCapabilities, commands: [...applicationCapabilities.commands, 'work.submit'] } } }],
    ['伪称额外查询', { capabilities: { ...CURRENT_HOST_CAPABILITIES, application: { ...applicationCapabilities, queries: [...applicationCapabilities.queries, 'runs.list'] } } }],
    ['伪称 force 模式', { capabilities: { ...CURRENT_HOST_CAPABILITIES, stop: { ...CURRENT_HOST_CAPABILITIES.stop, modes: ['graceful', 'force'] } } }],
    ['伪造路由表', { capabilities: { ...CURRENT_HOST_CAPABILITIES, lifecycleRoutes: ['handshake'] } }],
    ['能力含未知键', { capabilities: { ...CURRENT_HOST_CAPABILITIES, future: 'x' } }],
    ['应用能力缺 events', { capabilities: { lifecycleRoutes: CURRENT_HOST_CAPABILITIES.lifecycleRoutes, stop: CURRENT_HOST_CAPABILITIES.stop, application: { commands: applicationCapabilities.commands, queries: applicationCapabilities.queries } } }],
    ['顶层未知键', { future: 1 }],
    ['缺 startedAt', { startedAt: undefined }],
  ];
  it.each(malformedResponseCases)('假服务/畸形响应拒绝：%s', (_label, patch) => {
    const body = validHandshakeResponse();
    if (Object.prototype.hasOwnProperty.call(patch, 'startedAt') && patch.startedAt === undefined) {
      delete body.startedAt;
    } else {
      Object.assign(body, patch);
    }
    expectHostError(
      () => validateHandshakeResponse(body, expectation),
      // 身份冲突由上面的用例覆盖；这里均为畸形/伪造结构。
      'response_malformed',
      'host.handshake',
    );
  });
});

describe('F-002 §9 状态响应校验（只读零副作用）', () => {
  const expectation = { expectedHostInstanceId: INSTANCE_ID, expectedDataRootIdentity: ROOT_IDENTITY };

  it('stop 为 null 的空闲状态通过', () => {
    const status = validateStatusResponse(validStatusBody(), expectation);
    expect(status.activities).toEqual({ accepted: 0, quiescing: 0 });
    expect(status.stop).toBeNull();
  });

  it('带停止操作视图的状态通过（含受控 reasonCode）', () => {
    const view = {
      commandId: COMMAND_ID,
      status: 'accepted',
      stopState: 'quiescing',
      replayed: false,
      reasonCode: 'stop_in_progress',
    };
    const status = validateStatusResponse(validStatusBody(view), expectation);
    expect(status.stop).toEqual(view);
  });

  it('activities 必须是两个非负整数精确键', () => {
    const bad: unknown[] = [
      { accepted: -1, quiescing: 0 },
      { accepted: 1.5, quiescing: 0 },
      { accepted: 1 },
      { accepted: 0, quiescing: 0, extra: 1 },
      null,
    ];
    for (const activities of bad) {
      expectHostError(
        () => validateStatusResponse({ ...validStatusBody(), activities }, expectation),
        'response_malformed',
        'host.status',
      );
    }
  });

  it('stop 视图字段、枚举与 reasonCode 受控', () => {
    const bases = [
      { commandId: COMMAND_ID, status: 'accepted', stopState: 'quiescing', replayed: false },
      { commandId: COMMAND_ID, status: 'completed', stopState: 'stopping', replayed: false },
      { commandId: COMMAND_ID, status: 'rejected', stopState: 'resource_busy', replayed: false, reasonCode: 'quiesce_not_confirmed' },
    ];
    for (const view of bases) {
      expect(validateStatusResponse(validStatusBody(view), expectation).stop).toEqual(view);
    }
    const badViews: unknown[] = [
      { commandId: 'x', status: 'accepted', stopState: 'quiescing', replayed: false },
      { commandId: COMMAND_ID, status: 'done', stopState: 'quiescing', replayed: false },
      { commandId: COMMAND_ID, status: 'accepted', stopState: 'paused', replayed: false },
      { commandId: COMMAND_ID, status: 'accepted', stopState: 'quiescing', replayed: 'yes' },
      { commandId: COMMAND_ID, status: 'accepted', stopState: 'quiescing', replayed: false, reasonCode: 'mystery' },
      { commandId: COMMAND_ID, status: 'accepted', stopState: 'quiescing', replayed: false, extra: 1 },
    ];
    for (const view of badViews) {
      expectHostError(
        () => validateStatusResponse(validStatusBody(view), expectation),
        'response_malformed',
        'host.status',
      );
    }
  });

  it('身份/版本不符保持独立分类；stopped 不是线协议状态', () => {
    expectHostError(
      () => validateStatusResponse({ ...validStatusBody(), hostInstanceId: randomUUID() }, expectation),
      'instance_mismatch',
      'host.status',
    );
    expectHostError(
      () => validateStatusResponse({ ...validStatusBody(), protocolVersion: 2 }, expectation),
      'protocol_incompatible',
      'host.status',
    );
    expectHostError(
      () => validateStatusResponse({ ...validStatusBody(), lifecycleState: 'stopped' }, expectation),
      'response_malformed',
      'host.status',
    );
  });
});

describe('F-002 §10 stop 请求校验与摘要', () => {
  function stopBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const options: StopOptions = { mode: STOP_MODE_GRACEFUL };
    const requestDigest = computeStopRequestDigest(COMMAND_ID, INSTANCE_ID, options);
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      commandId: COMMAND_ID,
      hostInstanceId: INSTANCE_ID,
      requestDigest,
      options,
      ...overrides,
    };
  }

  it('stableCanonicalJson：键按 UTF-16 升序、无空白、数组保序', () => {
    const canonical = stableCanonicalJson({ b: 1, a: { z: 2, y: 3 }, n: [3, 1, 2] });
    expect(canonical).toBe('{"a":{"y":3,"z":2},"b":1,"n":[3,1,2]}');
  });

  it('摘要绑定 commandId+实例+选项，不含 token；缺省 options 与显式 graceful 同摘要', () => {
    const digest = computeStopRequestDigest(COMMAND_ID, INSTANCE_ID, { mode: STOP_MODE_GRACEFUL });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHash('sha256')
      .update(
        stableCanonicalJson({
          commandId: COMMAND_ID,
          hostInstanceId: INSTANCE_ID,
          options: { mode: STOP_MODE_GRACEFUL },
        }),
        'utf8',
      )
      .digest('hex');
    expect(digest).toBe(expected);
    expect(
      computeStopRequestDigest(randomUUID(), INSTANCE_ID, { mode: STOP_MODE_GRACEFUL }),
    ).not.toBe(digest);

    const bodyWithoutOptions = stopBody();
    delete bodyWithoutOptions.options;
    // 缺省补全后摘要仍自洽：stopBody() 的摘要按 {mode:graceful} 计算。
    expect(() => verifyStopRequestDigest(validateStopRequestShape(bodyWithoutOptions))).not.toThrow();
    expect(validateStopRequestShape(stopBody()).options).toEqual({ mode: STOP_MODE_GRACEFUL });
  });

  it('合法显式 stop 请求通过结构、版本与服务端重算摘要核对', () => {
    const parsed = validateStopRequest(stopBody());
    expect(parsed.commandId).toBe(COMMAND_ID);
    expect(parsed.hostInstanceId).toBe(INSTANCE_ID);
    expect(parsed.options).toEqual({ mode: 'graceful' });
  });

  it('服务端不接受客户端自报摘要：篡改任一绑定字段而摘要不变 → request_digest_mismatch', () => {
    for (const patch of [
      { commandId: randomUUID() },
      { hostInstanceId: randomUUID() },
      // options 形态变化（多一个被识别为结构非法的键不在此用例：这里改用 mode 值，
      // mode 非 graceful 会先命中 unsupported；因此只验证 commandId/实例两类绑定字段）。
    ]) {
      const body = stopBody();
      Object.assign(body, patch);
      expectHostError(() => validateStopRequest(body), 'request_digest_mismatch', 'host.stop');
    }
  });

  it('结构错误（缺字段/坏 UUID/坏摘要格式/未知键/options 类型）→ invalid_input', () => {
    const good = stopBody();
    const malformed: unknown[] = [
      { ...good, commandId: 'not-uuid' },
      { ...good, hostInstanceId: 'not-uuid' },
      { ...good, requestDigest: 'XYZ' },
      { ...good, schemaVersion: '1' },
      { ...good, unknown: 1 },
      { ...good, options: null },
      { ...good, options: 'graceful' },
      { ...good, options: [] },
      { ...good, options: { mode: 1 } },
      { ...good, options: { bogus: true } },
      null,
    ];
    for (const body of malformed) {
      expectHostError(() => validateStopRequestShape(body), 'invalid_input', 'host.stop');
    }
  });

  it('命名未实现的停止能力 → unsupported(501)，绝不默默执行其他控制行为', () => {
    const unsupportedCases: Array<[string, Record<string, unknown>]> = [
      ['force 模式', { options: { mode: 'force' } }],
      ['cancelWork 模式', { options: { mode: 'cancelWork' } }, ] ,
      ['options.cancelWorkers', { options: { mode: 'graceful', cancelWorkers: true } }],
      ['options.killProcessTree', { options: { mode: 'graceful', killProcessTree: true } }],
      ['顶层 cancelWorkers', { cancelWorkers: true }],
      ['顶层 killProcessTree', { killProcessTree: true }],
      ['顶层 cancelWork', { cancelWork: true }],
    ];
    for (const [_label, patch] of unsupportedCases) {
      const body = stopBody();
      Object.assign(body, patch);
      const error = expectHostError(() => validateStopRequestShape(body), 'unsupported', 'host.stop');
      expect(error.httpStatus).toBe(501);
      expect(error.details?.supportedModes).toEqual(['graceful']);
    }
  });

  it('预期实例核对：错误实例不能停止当前 Host（instance_mismatch/409），同实例通过', () => {
    const parsed = validateStopRequest(stopBody());
    expect(() => assertStopTargetsCurrentInstance(parsed, INSTANCE_ID)).not.toThrow();
    const other = randomUUID();
    const error = expectHostError(
      () => assertStopTargetsCurrentInstance(parsed, other),
      'instance_mismatch',
      'host.stop',
    );
    expect(error.httpStatus).toBe(409);
  });

  it('未知 schemaVersion → unsupported_schema_version（摘要核对之前的结构语义）', () => {
    const body = stopBody({ schemaVersion: 1 });
    const error = expectHostError(() => validateStopRequest(body), 'unsupported_schema_version', 'host.stop');
    expect(error.httpStatus).toBe(400);
  });

  it('§10.5 最终停止视图可被客户端严格校验', () => {
    const finalView = {
      commandId: COMMAND_ID,
      status: 'completed',
      stopState: 'stopping',
      replayed: false,
    };
    expect(validateStopResultView(finalView, { expectedCommandId: COMMAND_ID })).toEqual(finalView);
    // replayed 进度视图同样是合法形态。
    expect(
      validateStopResultView(
        { ...finalView, status: 'accepted', stopState: 'quiescing', replayed: true },
        { expectedCommandId: COMMAND_ID },
      ).replayed,
    ).toBe(true);
    expectHostError(
      () => validateStopResultView(finalView, { expectedCommandId: randomUUID() }),
      'response_malformed',
      'host.stop',
    );
  });
});

describe('F-002 §7.3/§14 结构化错误与脱敏', () => {
  it('HTTP 映射总表完整：16 个服务端码有状态码，12 个仅客户端码无 HTTP 状态', () => {
    const serverCodes: HostErrorCode[] = [
      'invalid_input',
      'unsupported_schema_version',
      'request_digest_mismatch',
      'request_too_large',
      'unauthorized',
      'forbidden',
      'instance_mismatch',
      'data_root_mismatch',
      'conflict',
      'resource_busy',
      'not_ready',
      'protocol_incompatible',
      'unsupported',
      'unknown_operation',
      'method_not_allowed',
      'internal',
    ];
    const expectedStatus: Partial<Record<HostErrorCode, number>> = {
      invalid_input: 400,
      unsupported_schema_version: 400,
      request_digest_mismatch: 400,
      request_too_large: 413,
      unauthorized: 401,
      forbidden: 403,
      instance_mismatch: 409,
      data_root_mismatch: 409,
      conflict: 409,
      resource_busy: 409,
      not_ready: 503,
      protocol_incompatible: 426,
      unsupported: 501,
      unknown_operation: 404,
      method_not_allowed: 405,
      internal: 500,
    };
    for (const code of serverCodes) {
      const error = new HostProtocolError(code, 'host.status');
      expect(error.httpStatus, code).toBe(expectedStatus[code]);
    }
    const clientCodes: HostErrorCode[] = [
      'host_not_found',
      'unreachable',
      'response_malformed',
      'redirect_rejected',
      'owner_active',
      'owner_unknown',
      'unsafe_discovery',
      'invalid_discovery',
      'start_timeout',
      'stop_not_confirmed',
      'bind_address_override_rejected',
      'unsupported_platform',
    ];
    for (const code of clientCodes) {
      expect(new HostProtocolError(code, 'host.status').httpStatus, code).toBeUndefined();
    }
  });

  it('错误保留操作身份与可理解原因，toErrorBody 不含堆栈/token/认证头', () => {
    const secret = 'deadbeef-token-that-must-never-appear';
    const error = new HostProtocolError('resource_busy', 'host.stop', undefined, {
      details: { reasonCode: 'quiesce_not_confirmed' },
    });
    const body = error.toErrorBody();
    expect(body).toEqual({
      error: {
        code: 'resource_busy',
        message: expect.stringMatching(/./) as unknown as string,
        operation: 'host.stop',
        details: { reasonCode: 'quiesce_not_confirmed' },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Authorization');
    // isHostProtocolError 收窄。
    expect(isHostProtocolError(error)).toBe(true);
    expect(isHostProtocolError(error, 'resource_busy')).toBe(true);
    expect(isHostProtocolError(error, 'unauthorized')).toBe(false);
    expect(isHostProtocolError(new Error('x'))).toBe(false);
  });

  it('unauthorized / owner_unknown / unsupported_platform 等关键码可构造且操作身份不丢', () => {
    expect(new HostProtocolError('unauthorized', 'host.handshake').operation).toBe('host.handshake');
    expect(new HostProtocolError('owner_unknown', 'host.discovery').code).toBe('owner_unknown');
    expect(new HostProtocolError('unsupported_platform', 'host.discovery').httpStatus).toBeUndefined();
  });

  it('parseJsonBody：畸形 JSON → invalid_input 且不回显原文；非字符串输入拒绝', () => {
    const marker = 'AUTHORIZATION-BEARER-SECRETMARKER';
    const error = expectHostError(
      () => parseJsonBody(`{"a":1 ${marker}`, 'host.stop'),
      'invalid_input',
      'host.stop',
    );
    expect(error.details?.reason).toBe('malformed_json');
    expect(JSON.stringify(error.toErrorBody())).not.toContain(marker);
    expectHostError(() => parseJsonBody(undefined as unknown as string, 'host.stop'), 'invalid_input', 'host.stop');
  });

  it('请求体超 16384 字节 → request_too_large(413)，details 只含非秘密数值', () => {
    expect(() => assertBodyWithinLimit(MAX_HTTP_BODY_BYTES, 'host.handshake')).not.toThrow();
    const error = expectHostError(
      () => assertBodyWithinLimit(MAX_HTTP_BODY_BYTES + 1, 'host.handshake'),
      'request_too_large',
      'host.handshake',
    );
    expect(error.httpStatus).toBe(413);
    expect(error.details?.limitBytes).toBe(16_384);
  });
});

describe('F-002 契约模块纯度（import 无端口/目录/进程副作用）', () => {
  const hostSrcDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../..',
    'packages',
    'host',
    'src',
  );
  const contractSrcDir = join(hostSrcDir, 'contract');
  const storageSrcDir = join(hostSrcDir, 'storage');

  function listTsFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules') {
        continue;
      }
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        result.push(...listTsFiles(child));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        result.push(child);
      }
    }
    return result;
  }

  it('host 源码存在且契约目录为纯模块', () => {
    const files = listTsFiles(hostSrcDir);
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.some((file) => file.includes(join('contract', 'errors.ts')))).toBe(true);
  });

  it('契约面源码不导入 HTTP/网络/文件系统/进程/ORM/SDK 模块（node:crypto 除外）', () => {
    // F-003 起 host 包新增非契约区 storage/（允许 node:fs/crypto/path）；本纯度
    // 门槛继续只冻结 contract/ 契约面。
    const forbiddenImport = /\bfrom\s+['"]node:(?:fs|fs\/promises|os|net|http|https|dgram|tls|child_process|cluster|worker_threads|readline|path)['"]/;
    const forbiddenSideEffect = /\bimport\s+['"]node:(?:fs|fs\/promises|os|net|http|https|dgram|tls|child_process|cluster|worker_threads)['"]/;
    const forbiddenPackage = /(?:better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono|shiploop-core)/;
    for (const file of listTsFiles(contractSrcDir)) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).not.toMatch(forbiddenImport);
      expect(source, file).not.toMatch(forbiddenSideEffect);
      expect(source, file).not.toMatch(forbiddenPackage);
    }
  });

  it('契约面源码不含监听端口、读写目录、启动进程或读取 argv 的调用', () => {
    const forbiddenCall = /(\.listen\s*\(|createServer\s*\(|spawn\s*\(|spawnSync\s*\(|execFile\s*\(|fork\s*\(|readFileSync\s*\(|writeFileSync\s*\(|mkdirSync\s*\(|rmSync\s*\(|homedir\s*\(|process\.argv|\bfetch\s*\()/;
    for (const file of listTsFiles(contractSrcDir)) {
      expect(readFileSync(file, 'utf-8'), file).not.toMatch(forbiddenCall);
    }
  });

  it('F-003 存储面只用 node:fs/crypto/path，不触网络/进程/argv，不依赖 shiploop-core', () => {
    const forbiddenImport = /\bfrom\s+['"]node:(?:net|http|https|dgram|tls|child_process|cluster|worker_threads|readline)['"]/;
    const forbiddenSideEffect = /\bimport\s+['"]node:/;
    const forbiddenPackage = /\bfrom\s+['"](?:better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono|shiploop-core)['"]/;
    const forbiddenCall = /(\.listen\s*\(|createServer\s*\(|spawn\s*\(|spawnSync\s*\(|execFile\s*\(|fork\s*\(|homedir\s*\(|process\.argv|\bfetch\s*\()/;
    const files = listTsFiles(storageSrcDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).not.toMatch(forbiddenImport);
      expect(source, file).not.toMatch(forbiddenSideEffect);
      expect(source, file).not.toMatch(forbiddenPackage);
      expect(source, file).not.toMatch(forbiddenCall);
    }
  });

  it('F-006 runtime 面隔离网络/进程/ORM，SDK 仅在 Pi 适配器和认证目录内延迟加载', () => {
    // runtime/ 允许 node:http 与 Core 公共入口。P04-1 Pi 适配器和 P04-2
    // 认证目录可延迟加载 SDK；其他模块不得加载，argv 只属于 start.ts。
    const runtimeSrcDir = join(hostSrcDir, 'runtime');
    const forbiddenImport = /\bfrom\s+['"]node:(?:net|https|dgram|tls|child_process|cluster|worker_threads|readline)['"]/;
    const forbiddenPackage = /\bfrom\s+['"](?:better-sqlite3|drizzle-orm|electron|express|fastify|koa|hono)['"]/;
    const files = listTsFiles(runtimeSrcDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).not.toMatch(forbiddenImport);
      expect(source, file).not.toMatch(forbiddenPackage);
      // type-only 引用擦除后不加载 SDK；禁止所有静态值导入（包括 side-effect）。
      const valueImports = source.replaceAll(/\bimport\s+type\b[^;]*;/g, '');
      expect(valueImports, file).not.toMatch(/(?:\bfrom\s+|\bimport\s*)['"]@earendil-works\/pi-coding-agent['"]/);
      const sdkLoads = [...source.matchAll(/\bimport\s*\(\s*['"]@earendil-works\/pi-coding-agent['"]\s*\)/g)];
      const sdkBoundary = file === join(runtimeSrcDir, 'pi-adapter.ts') || file === join(runtimeSrcDir, 'pi-authentication.ts');
      expect(sdkLoads, file).toHaveLength(sdkBoundary ? 1 : 0);
      // argv 只属于显式入口 start.ts；剔除注释后 runtime 模块不得直接读 process.argv。
      const codeOnly = source
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(codeOnly, file).not.toContain('process.argv');
    }
    // 显式执行入口（契约 §13.1）只经 runtime 公共面启动。
    const startEntry = readFileSync(join(hostSrcDir, 'start.ts'), 'utf-8');
    expect(startEntry).toContain("from './runtime/index.js'");
    expect(startEntry).toContain('runHostStartEntry');
  });

  it('F-009 client 面只允许 node:http 与 node:crypto，不触文件系统/进程/argv/ORM', () => {
    // client/ 承担 HostClient（允许 node:http 回环请求与 node:crypto 生成
    // commandId），发现/凭据读取一律经 storage/；禁止文件系统、其他网络、
    // 进程/线程模块、argv 与 shiploop-core。
    const clientSrcDir = join(hostSrcDir, 'client');
    const forbiddenImport = /\bfrom\s+['"]node:(?:fs|fs\/promises|os|net|https|dgram|tls|child_process|cluster|worker_threads|readline|path)['"]/;
    const forbiddenSideEffect = /\bimport\s+['"]node:/;
    const forbiddenPackage = /\bfrom\s+['"](?:better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono|shiploop-core)['"]/;
    const forbiddenCall = /(\.listen\s*\(|createServer\s*\(|spawn\s*\(|spawnSync\s*\(|execFile\s*\(|fork\s*\(|readFileSync\s*\(|writeFileSync\s*\(|homedir\s*\(|\bfetch\s*\()/;
    const files = listTsFiles(clientSrcDir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).not.toMatch(forbiddenImport);
      expect(source, file).not.toMatch(forbiddenSideEffect);
      expect(source, file).not.toMatch(forbiddenPackage);
      expect(source, file).not.toMatch(forbiddenCall);
      const codeOnly = source
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(codeOnly, file).not.toContain('process.argv');
      expect(codeOnly, file).not.toContain('process.env');
    }
  });

  it('F-010 launcher 面只允许 node:child_process/os/url/path/timers 与 shiploop-core 纯契约入口', () => {
    // launcher/ 承担 §12.4 连接或启动编排：唯一允许 spawn 的面（detached
    // 独立 argv）；不读文件系统（发现/凭据经 storage/）、不直连网络（连接经
    // client/）、不读 argv、不打开 SQLite（禁止 shiploop-core/assembly）。
    const launcherSrcDir = join(hostSrcDir, 'launcher');
    const forbiddenImport = /\bfrom\s+['"]node:(?:fs|fs\/promises|net|http|https|dgram|tls|cluster|worker_threads|readline|crypto|perf_hooks)['"]/;
    const forbiddenSideEffect = /\bimport\s+['"]node:/;
    const forbiddenPackage = /\bfrom\s+['"](?:better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono)['"]/;
    const forbiddenCall = /(\.listen\s*\(|createServer\s*\(|readFileSync\s*\(|writeFileSync\s*\(|mkdirSync\s*\(|rmSync\s*\(|\bfetch\s*\()/;
    const files = listTsFiles(launcherSrcDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).not.toMatch(forbiddenImport);
      expect(source, file).not.toMatch(forbiddenSideEffect);
      expect(source, file).not.toMatch(forbiddenPackage);
      expect(source, file).not.toMatch(forbiddenCall);
      // 不打开 SQLite：禁止 Core 装配子路径（只允许 shiploop-core 纯契约入口）。
      expect(source, file).not.toContain('shiploop-core/assembly');
      const codeOnly = source
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(codeOnly, file).not.toContain('process.argv');
    }
  });

  it('公共入口只做纯 re-export，自身无语句副作用', () => {
    const index = readFileSync(join(hostSrcDir, 'index.ts'), 'utf-8');
    expect(index).toContain("from './contract/index.js'");
    expect(index).toContain("from './launcher/index.js'");
    const codeLines = index
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
    for (const line of codeLines) {
      expect(line.startsWith('export')).toBe(true);
    }
  });
});
