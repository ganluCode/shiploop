/**
 * F-002 Core 应用命令契约（纯模块）运行时校验测试。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md
 * - §3.1 线消息 schemaVersion=3（P02-3/F-006 起；与发现/线协议/配置 payload 版本独立）；
 * - §4.2 九项能力冻结清单与 local-owner；
 * - §5.1 命令信封三态 scope、expectedRevision 单一权威来源；
 * - §5.3 回执 accepted/completed/rejected（本版本只产生 completed/rejected）；
 * - §5.4 时效（±60 000 ms 偏差、默认 TTL 60 000 ms、最大寿命 300 000 ms）；
 * - §5.7 StorageError/仓库检查错误/未预期异常 → 稳定公开错误映射；
 * - §6 六个命令与 payload 白名单（复用 P01 校验器）。
 *
 * 本套件只测纯数据与纯函数：不打开数据库、不发 HTTP、不起子进程。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { RepositoryInspectionError } from '../packages/core/src/ports/repository-inspector.ts';
import type { RepositoryInspectionErrorKind } from '../packages/core/src/ports/repository-inspector.ts';
import {
  APP_CAPABILITIES,
  COMMAND_CLOCK_SKEW_MS,
  COMMAND_DEFAULT_TTL_MS,
  COMMAND_MAX_LIFESPAN_MS,
  COMMAND_OPERATIONS,
  COMMAND_OPERATION_SPECS,
  COMMANDS_SUBMIT_OPERATION,
  LOCAL_OWNER_CAPABILITIES,
  LOCAL_OWNER_PRINCIPAL_ID,
  PUBLIC_ERROR_CODES,
  PublicError,
  RECEIPT_RESULT_MAX_BYTES,
  RECEIPT_STATUSES,
  RESULT_REF_PREFIX,
  WIRE_MESSAGE_SCHEMA_VERSION,
  createCompletedReceipt,
  createRejectedReceipt,
  evaluateCommandTiming,
  isPublicError,
  isValidResultRef,
  mapRepositoryInspectionError,
  mapStorageError,
  mapToPublicError,
  mapUnexpectedError,
  validateCommandEnvelope,
  validateResultRef,
} from '../packages/core/src/ports/commands.ts';

const UUID_A = '12345678-1234-4123-8234-1234567890ab';
const UUID_B = '12345678-1234-4123-8234-1234567890cd';
const DIGEST_A = 'a'.repeat(64);
const ISSUED_AT = '2026-10-08T00:00:00.000Z';
const ISSUED_MS = Date.parse(ISSUED_AT);
const SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};
type EnvelopeInput = Record<string, unknown>;

function envelope(overrides: EnvelopeInput = {}): EnvelopeInput {
  return {
    schemaVersion: 5,
    commandId: UUID_A,
    operation: 'project.register',
    scope: { kind: 'registration' },
    issuedAt: ISSUED_AT,
    payload: { repositoryPath: '/srv/git/demo', displayName: 'Demo' },
    ...overrides,
  };
}
function resultRefOf(char: string): string {
  return `${RESULT_REF_PREFIX}${char.repeat(43)}`;
}
function expectPublicError(fn: () => unknown, code: string, field?: string): PublicError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicError);
    const publicError = error as PublicError;
    expect(publicError.code).toBe(code);
    if (field !== undefined) {
      expect(publicError.details?.field).toBe(field);
    }
    return publicError;
  }
  throw new Error(`expected PublicError(${code}) to be thrown`);
}

describe('F-002 冻结版本、能力与命令白名单', () => {
  it('线消息 schemaVersion 为 5（P03-2/F-007 起；独立于发现版本 1 与配置 payload 版本 2）', () => {
    expect(WIRE_MESSAGE_SCHEMA_VERSION).toBe(5);
  });

  it('冻结二十项能力（P02-2 九项 + P02-3 基线两项 + P03-1 计划域三项 + P03-2 三项 + P03-3 执行授权面与预算修订两项），local-owner 持全部', () => {
    expect([...APP_CAPABILITIES]).toEqual([
      'project.register',
      'project.read',
      'project.metadata.write',
      'settings.global.read',
      'settings.global.write',
      'settings.project.read',
      'settings.project.write',
      'receipts.read',
      'events.read',
      'baseline.read',
      'baseline.run',
      // P03-1 / F-004：Phase 创建能力位。
      'phase.write',
      // P03-1 / F-005：计划导入能力位。
      'feature.plan.import',
      // P03-1 / F-007：纯标签 CAS 编辑能力位。
      'plan.labels.write',
      // P03-1 / F-008：实质计划修订能力位。
      'feature.plan.revise',
      // P03-2 / F-001：Task 策略副本 CAS 编辑能力位。
      'task.strategy.write',
      // P03-2 / F-002：计划批准/拒绝决策能力位。
      'feature.plan.decide',
      // P03-2 / F-006：执行输入制品组准备能力位。
      'execution.input.prepare',
      // P03-3 / F-004：执行授权面能力位（execution.preview 预览使用；
      // execution.start 启动随后续控制器任务接线）。
      'execution.start',
      // P03-3 / F-009：批次预算显式修订能力位（增额/延期是新的明确授权，
      // 与启动能力分离；修订不自动启动或恢复 Run）。
      'execution.budget.revise',
    ]);
    expect(LOCAL_OWNER_PRINCIPAL_ID).toBe('local-owner');
    expect(LOCAL_OWNER_CAPABILITIES.size).toBe(APP_CAPABILITIES.length);
    for (const capability of APP_CAPABILITIES) {
      expect(LOCAL_OWNER_CAPABILITIES.has(capability)).toBe(true);
    }
  });

  it('冻结命令白名单及其 scope/变更类型/能力描述，与契约 §6 一致', () => {
    expect([...COMMAND_OPERATIONS]).toEqual([
      'project.register',
      'project.metadata.update',
      'settings.global.create',
      'settings.global.update',
      'settings.project.create',
      'settings.project.update',
      // P02-3 / F-008：基线 preview/run；F-014：cancel 随停止核验执行端口进白名单。
      'baseline.preview',
      'baseline.run',
      'baseline.cancel',
      // P03-1 / F-004：Phase 创建（project scope + phase.write）。
      'phase.create',
      // P03-1 / F-005：计划导入（project scope + feature.plan.import；Phase 聚合 CAS）。
      'feature.plan.import',
      // P03-1 / F-007：纯标签 CAS 编辑（project scope + plan.labels.write；实体自身 revision CAS）。
      'plan.labels.update',
      // P03-1 / F-008：实质计划修订（project scope + feature.plan.revise；Feature 聚合 CAS）。
      'feature.plan.revise',
      // P03-2 / F-001：Task 策略副本 CAS 编辑（project scope + task.strategy.write；Task 自身 revision CAS）。
      'task.strategy.update',
      // P03-2 / F-002：计划批准/拒绝决策（project scope + feature.plan.decide；Feature 聚合 CAS）。
      'feature.plan.decide',
      'task.approval.block',
      // P03-2 / F-006：执行输入制品组准备（project scope + execution.input.prepare；
      // 创建类不携带 expectedRevision；采集/组装/发布为事务外 I/O）。
      'execution.input.prepare',
      // P03-3 / F-004：单 Feature 执行 prepare 预览（project scope +
      // execution.start；只读预览不 CAS 任何实体）。
      'execution.preview',
      // P03-3 / F-005：显式执行启动（project scope + execution.start；创建类
      // 不携带 expectedRevision；事务外准备 + 短写事务内重核与原子提交）。
      'execution.start',
      // P03-3 / F-009：批次预算显式修订（project scope + execution.budget.revise；
      // 更新类 expectedRevision=目标 Batch 当前 budget_revision；仅增额或延期）。
      'execution.budget.revise',
    ]);
    expect(COMMAND_OPERATION_SPECS).toEqual({
      'project.register': { scopeKind: 'registration', mutation: 'create', capability: 'project.register' },
      'project.metadata.update': { scopeKind: 'project', mutation: 'update', capability: 'project.metadata.write' },
      'settings.global.create': { scopeKind: 'global', mutation: 'create', capability: 'settings.global.write' },
      'settings.global.update': { scopeKind: 'global', mutation: 'update', capability: 'settings.global.write' },
      'settings.project.create': { scopeKind: 'project', mutation: 'create', capability: 'settings.project.write' },
      'settings.project.update': { scopeKind: 'project', mutation: 'update', capability: 'settings.project.write' },
      'baseline.preview': { scopeKind: 'project', mutation: 'create', capability: 'baseline.run' },
      'baseline.run': { scopeKind: 'project', mutation: 'create', capability: 'baseline.run' },
      'baseline.cancel': { scopeKind: 'project', mutation: 'create', capability: 'baseline.run' },
      'phase.create': { scopeKind: 'project', mutation: 'create', capability: 'phase.write' },
      'feature.plan.import': { scopeKind: 'project', mutation: 'update', capability: 'feature.plan.import' },
      'plan.labels.update': { scopeKind: 'project', mutation: 'update', capability: 'plan.labels.write' },
      'feature.plan.revise': { scopeKind: 'project', mutation: 'update', capability: 'feature.plan.revise' },
      'task.strategy.update': { scopeKind: 'project', mutation: 'update', capability: 'task.strategy.write' },
      'task.approval.block': { scopeKind: 'project', mutation: 'update', capability: 'feature.plan.decide' },
      'feature.plan.decide': { scopeKind: 'project', mutation: 'update', capability: 'feature.plan.decide' },
      'execution.input.prepare': { scopeKind: 'project', mutation: 'create', capability: 'execution.input.prepare' },
      'execution.preview': { scopeKind: 'project', mutation: 'create', capability: 'execution.start' },
      'execution.start': { scopeKind: 'project', mutation: 'create', capability: 'execution.start' },
      'execution.budget.revise': { scopeKind: 'project', mutation: 'update', capability: 'execution.budget.revise' },
    });
    for (const spec of Object.values(COMMAND_OPERATION_SPECS)) {
      expect(APP_CAPABILITIES).toContain(spec.capability);
    }
  });
});

describe('F-002 合法信封（六个操作的正例）', () => {
  it('project.register：registration scope、无 expectedRevision、复用 P01 注册字段校验', () => {
    const validated = validateCommandEnvelope(
      envelope({
        payload: {
          repositoryPath: '/srv/git/demo',
          displayName: '  Demo  ',
          description: '  ',
          labels: [' Web ', 'web'],
        },
      }),
    );
    expect(validated.scope).toEqual({ kind: 'registration' });
    expect(validated.expectedRevision).toBeNull();
    expect(validated.expiresAt).toBeNull();
    if (validated.operation !== 'project.register') {
      throw new Error('narrowed');
    }
    expect(validated.payload).toEqual({
      repositoryPath: '/srv/git/demo',
      displayName: 'Demo',
      description: null,
      labels: ['web'],
    });
  });

  it('project.metadata.update：project scope、expectedRevision 必填', () => {
    const validated = validateCommandEnvelope(
      envelope({
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: UUID_A },
        expectedRevision: 3,
        payload: { displayName: 'New name', labels: ['P1'] },
      }),
    );
    if (validated.operation !== 'project.metadata.update') {
      throw new Error('narrowed');
    }
    expect(validated.scope).toEqual({ kind: 'project', projectId: UUID_A });
    expect(validated.expectedRevision).toBe(3);
    expect(validated.payload).toEqual({ displayName: 'New name', labels: ['p1'] });
  });

  it('settings.global.create/update：global scope、payload 即 SettingsPayloadV2（非包裹）', () => {
    const created = validateCommandEnvelope(
      envelope({ operation: 'settings.global.create', scope: { kind: 'global' }, payload: SETTINGS_PAYLOAD }),
    );
    if (created.operation !== 'settings.global.create') {
      throw new Error('narrowed');
    }
    expect(created.expectedRevision).toBeNull();
    expect(created.payload).toEqual(SETTINGS_PAYLOAD);
    const updated = validateCommandEnvelope(
      envelope({
        operation: 'settings.global.update',
        scope: { kind: 'global' },
        expectedRevision: 7,
        expiresAt: '2026-10-08T00:00:30.000Z',
        payload: SETTINGS_PAYLOAD,
      }),
    );
    if (updated.operation !== 'settings.global.update') {
      throw new Error('narrowed');
    }
    expect(updated.expectedRevision).toBe(7);
    expect(updated.expiresAt).toBe('2026-10-08T00:00:30.000Z');
  });

  it('settings.project.create / update：project scope 与 payload 直通校验', () => {
    for (const operation of ['settings.project.create', 'settings.project.update'] as const) {
      const isUpdate = operation === 'settings.project.update';
      const validated = validateCommandEnvelope(
        envelope({
          operation,
          scope: { kind: 'project', projectId: UUID_B },
          ...(isUpdate ? { expectedRevision: 1 } : {}),
          payload: { schemaVersion: 2 },
        }),
      );
      if (validated.operation !== operation) {
        throw new Error('narrowed');
      }
      expect(validated.scope).toEqual({ kind: 'project', projectId: UUID_B });
      expect(validated.expectedRevision).toBe(isUpdate ? 1 : null);
      expect(validated.payload).toEqual({ schemaVersion: 2 });
    }
  });

  it('校验不修改输入对象且每次返回独立副本（纯函数）', () => {
    const input = envelope({
      payload: { repositoryPath: '/srv/git/demo', displayName: 'Demo', labels: ['A', 'a'] },
    });
    const snapshot = structuredClone(input);
    const first = validateCommandEnvelope(input);
    const second = validateCommandEnvelope(input);
    expect(input).toEqual(snapshot);
    expect(first).toEqual(second);
    if (first.operation !== 'project.register' || second.operation !== 'project.register') {
      throw new Error('narrowed');
    }
    expect(first.payload).not.toBe(input.payload);
  });
});

interface InvalidRow {
  readonly name: string;
  readonly mutate: (base: EnvelopeInput) => unknown;
  readonly code: string;
  readonly field: string;
}
const INVALID_ENVELOPE_ROWS: InvalidRow[] = [
  { name: '信封为 null', mutate: () => null, code: 'invalid_input', field: 'envelope' },
  { name: '信封为数组', mutate: () => [], code: 'invalid_input', field: 'envelope' },
  { name: '信封为字符串', mutate: () => '{}', code: 'invalid_input', field: 'envelope' },
  { name: '缺 schemaVersion', mutate: (b) => ({ ...b, schemaVersion: undefined }), code: 'invalid_input', field: 'schemaVersion' },
  { name: '缺 commandId', mutate: (b) => ({ ...b, commandId: undefined }), code: 'invalid_input', field: 'commandId' },
  { name: '缺 operation', mutate: (b) => ({ ...b, operation: undefined }), code: 'invalid_input', field: 'operation' },
  { name: '缺 scope', mutate: (b) => ({ ...b, scope: undefined }), code: 'invalid_input', field: 'scope' },
  { name: '缺 issuedAt', mutate: (b) => ({ ...b, issuedAt: undefined }), code: 'invalid_input', field: 'issuedAt' },
  { name: '缺 payload', mutate: (b) => ({ ...b, payload: undefined }), code: 'invalid_input', field: 'payload' },
  { name: '顶层 projectId', mutate: (b) => ({ ...b, projectId: UUID_A }), code: 'invalid_input', field: 'projectId' },
  { name: '顶层 actorId', mutate: (b) => ({ ...b, actorId: 'me' }), code: 'invalid_input', field: 'actorId' },
  { name: '顶层 principal', mutate: (b) => ({ ...b, principal: { id: 'x' } }), code: 'invalid_input', field: 'principal' },
  { name: '顶层 principalId', mutate: (b) => ({ ...b, principalId: 'local-owner' }), code: 'invalid_input', field: 'principalId' },
  { name: '顶层 capabilities', mutate: (b) => ({ ...b, capabilities: ['project.read'] }), code: 'invalid_input', field: 'capabilities' },
  { name: '顶层 digest', mutate: (b) => ({ ...b, digest: DIGEST_A }), code: 'invalid_input', field: 'digest' },
  { name: 'schemaVersion 为字符串', mutate: (b) => ({ ...b, schemaVersion: '2' }), code: 'invalid_input', field: 'schemaVersion' },
  { name: 'commandId 为数字', mutate: (b) => ({ ...b, commandId: 42 }), code: 'invalid_input', field: 'commandId' },
  { name: 'operation 为数字', mutate: (b) => ({ ...b, operation: 7 }), code: 'invalid_input', field: 'operation' },
  { name: 'scope 为字符串', mutate: (b) => ({ ...b, scope: 'global' }), code: 'invalid_input', field: 'scope' },
  { name: 'issuedAt 为数字', mutate: (b) => ({ ...b, issuedAt: 0 }), code: 'invalid_input', field: 'issuedAt' },
  { name: 'payload 为数组', mutate: (b) => ({ ...b, payload: [] }), code: 'invalid_input', field: 'payload' },
  { name: 'commandId 非 UUID v4', mutate: (b) => ({ ...b, commandId: '12345678-1234-1123-8234-1234567890ab' }), code: 'invalid_input', field: 'commandId' },
  { name: 'commandId 大写', mutate: (b) => ({ ...b, commandId: UUID_A.toUpperCase() }), code: 'invalid_input', field: 'commandId' },
  { name: 'issuedAt 带时区偏移', mutate: (b) => ({ ...b, issuedAt: '2026-10-08T08:00:00+08:00' }), code: 'invalid_input', field: 'issuedAt' },
  { name: 'issuedAt 非真实日期', mutate: (b) => ({ ...b, issuedAt: '2026-13-40T99:99:99Z' }), code: 'invalid_input', field: 'issuedAt' },
  { name: 'expiresAt 非 ISO', mutate: (b) => ({ ...b, expiresAt: 1700000000000 }), code: 'invalid_input', field: 'expiresAt' },
  { name: 'expiresAt 显式 null', mutate: (b) => ({ ...b, expiresAt: null }), code: 'invalid_input', field: 'expiresAt' },
  { name: 'schemaVersion=1', mutate: (b) => ({ ...b, schemaVersion: 1 }), code: 'unsupported_schema_version', field: 'schemaVersion' },
  { name: 'schemaVersion=2（P02-3 起为 v3）', mutate: (b) => ({ ...b, schemaVersion: 2 }), code: 'unsupported_schema_version', field: 'schemaVersion' },
  { name: 'schemaVersion=2.5', mutate: (b) => ({ ...b, schemaVersion: 2.5 }), code: 'unsupported_schema_version', field: 'schemaVersion' },
  { name: '未知操作 work.run', mutate: (b) => ({ ...b, operation: 'work.run' }), code: 'unsupported', field: 'operation' },
  { name: '未知操作 chat.sendTurn', mutate: (b) => ({ ...b, operation: 'chat.sendTurn' }), code: 'unsupported', field: 'operation' },
];

describe('F-002 信封表驱动负例（结构/版本/操作）', () => {
  it.each(INVALID_ENVELOPE_ROWS)('$name → $code（$field）', ({ mutate, code, field }) => {
    const error = expectPublicError(() => validateCommandEnvelope(mutate(envelope())), code, field);
    expect(error.httpStatus).toBeGreaterThanOrEqual(400);
  });

  it('未知操作返回 supportedOperations 只列六个已实现命令（501）', () => {
    const error = expectPublicError(
      () => validateCommandEnvelope(envelope({ operation: 'phase.accept' })),
      'unsupported',
      'operation',
    );
    expect(error.httpStatus).toBe(501);
    expect(error.details?.supportedOperations).toEqual([...COMMAND_OPERATIONS]);
  });

  it('结构/版本/未知操作错误在命令定位前使用 commands.submit 身份，定位后用命令名', () => {
    const structural = expectPublicError(() => validateCommandEnvelope(null), 'invalid_input');
    expect(structural.operation).toBe(COMMANDS_SUBMIT_OPERATION);
    const payloadError = expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: '/x' } })),
      'invalid_input',
      'payload.displayName',
    );
    expect(payloadError.operation).toBe('project.register');
  });

  it('schemaVersion=1 的 HTTP 映射为 400，不猜测降级', () => {
    const error = expectPublicError(
      () => validateCommandEnvelope(envelope({ schemaVersion: 1 })),
      'unsupported_schema_version',
    );
    expect(error.httpStatus).toBe(400);
    expect(error.details?.supportedVersion).toBe(5);
  });
});

describe('F-002 scope 匹配与 expectedRevision 单一权威来源', () => {
  const mismatchRows: Array<{ name: string; overrides: EnvelopeInput; field: string }> = [
    { name: 'register 用 global scope', overrides: { operation: 'project.register', scope: { kind: 'global' } }, field: 'scope.kind' },
    {
      name: 'register 用 project scope',
      overrides: { operation: 'project.register', scope: { kind: 'project', projectId: UUID_A } },
      field: 'scope.kind',
    },
    {
      name: 'metadata.update 用 global scope',
      overrides: { operation: 'project.metadata.update', scope: { kind: 'global' }, expectedRevision: 1, payload: { displayName: 'x' } },
      field: 'scope.kind',
    },
    {
      name: 'settings.global.create 用 project scope',
      overrides: { operation: 'settings.global.create', scope: { kind: 'project', projectId: UUID_A }, payload: SETTINGS_PAYLOAD },
      field: 'scope.kind',
    },
    {
      name: 'settings.project.update 用 global scope',
      overrides: { operation: 'settings.project.update', scope: { kind: 'global' }, expectedRevision: 1, payload: SETTINGS_PAYLOAD },
      field: 'scope.kind',
    },
    { name: 'scope.kind 未知', overrides: { scope: { kind: 'personal' } }, field: 'scope.kind' },
    {
      name: 'project scope 缺 projectId',
      overrides: { operation: 'project.metadata.update', scope: { kind: 'project' }, expectedRevision: 1, payload: { displayName: 'x' } },
      field: 'scope.projectId',
    },
    {
      name: 'global scope 多带 projectId',
      overrides: { operation: 'settings.global.create', scope: { kind: 'global', projectId: UUID_A }, payload: SETTINGS_PAYLOAD },
      field: 'scope.projectId',
    },
    { name: 'registration scope 多带 projectId', overrides: { scope: { kind: 'registration', projectId: UUID_A } }, field: 'scope.projectId' },
    { name: 'scope 含未知字段', overrides: { scope: { kind: 'registration', actorId: 'z' } }, field: 'scope.actorId' },
    {
      name: 'projectId 形态非法',
      overrides: {
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: '../etc/passwd' },
        expectedRevision: 1,
        payload: { displayName: 'x' },
      },
      field: 'scope.projectId',
    },
  ];
  it.each(mismatchRows)('$name', ({ overrides, field }) => {
    expectPublicError(() => validateCommandEnvelope(envelope(overrides)), 'invalid_input', field);
  });

  const revision = (value: unknown): EnvelopeInput => ({
    operation: 'settings.global.update',
    scope: { kind: 'global' },
    expectedRevision: value,
    payload: SETTINGS_PAYLOAD,
  });
  const revisionRows: Array<{ name: string; overrides: EnvelopeInput; field: string }> = [
    {
      name: '更新命令缺 expectedRevision',
      overrides: { operation: 'settings.global.update', scope: { kind: 'global' }, payload: SETTINGS_PAYLOAD },
      field: 'expectedRevision',
    },
    { name: '注册携带 expectedRevision', overrides: { expectedRevision: 1 }, field: 'expectedRevision' },
    {
      name: 'global.create 携带 expectedRevision',
      overrides: { operation: 'settings.global.create', scope: { kind: 'global' }, expectedRevision: 1, payload: SETTINGS_PAYLOAD },
      field: 'expectedRevision',
    },
    { name: 'expectedRevision=0', overrides: revision(0), field: 'expectedRevision' },
    { name: 'expectedRevision=-2', overrides: revision(-2), field: 'expectedRevision' },
    { name: 'expectedRevision=1.5', overrides: revision(1.5), field: 'expectedRevision' },
    { name: 'expectedRevision 为字符串', overrides: revision('3'), field: 'expectedRevision' },
  ];
  it.each(revisionRows)('$name → invalid_input', ({ overrides, field }) => {
    expectPublicError(() => validateCommandEnvelope(envelope(overrides)), 'invalid_input', field);
  });

  it('payload 内重复 expectedRevision 按未知字段拒绝（revision 只有信封一个权威来源）', () => {
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope({
            operation: 'project.metadata.update',
            scope: { kind: 'project', projectId: UUID_A },
            expectedRevision: 2,
            payload: { displayName: 'x', expectedRevision: 2 },
          }),
        ),
      'invalid_input',
      'payload.expectedRevision',
    );
  });

  it('settings payload 出现 consistency.globalRevision 按未知字段拒绝（服务端自推导）', () => {
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope({
            operation: 'settings.global.update',
            scope: { kind: 'global' },
            expectedRevision: 2,
            payload: { schemaVersion: 2, consistency: { globalRevision: 1 } },
          }),
        ),
      'invalid_input',
      'payload',
    );
  });
});

describe('F-002 复用 P01 注册/元数据/配置校验器', () => {
  const settingsCreate = (payload: unknown): EnvelopeInput => ({
    operation: 'settings.global.create',
    scope: { kind: 'global' },
    payload: payload as EnvelopeInput,
  });

  it('注册 payload：非法 repositoryPath 类型与未知字段定位到字段', () => {
    expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: 42, displayName: 'x' } })),
      'invalid_input',
      'payload.repositoryPath',
    );
    expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: '/x', displayName: 'x', baseline: true } })),
      'invalid_input',
      'payload.baseline',
    );
  });

  it('缺/空 displayName 由 P01 校验器拒绝并定位到 payload 字段', () => {
    expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: '/x' } })),
      'invalid_input',
      'payload.displayName',
    );
    expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: '/x', displayName: '   ' } })),
      'invalid_input',
      'payload.displayName',
    );
  });

  it('非法标签（空、过长、超量）经同一 normalizeLabels 拒绝', () => {
    expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: '/x', displayName: 'x', labels: [''] } })),
      'invalid_input',
      'payload.labels[0]',
    );
    expectPublicError(
      () => validateCommandEnvelope(envelope({ payload: { repositoryPath: '/x', displayName: 'x', labels: ['a'.repeat(65)] } })),
      'invalid_input',
      'payload.labels[0]',
    );
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope({
            payload: { repositoryPath: '/x', displayName: 'x', labels: Array.from({ length: 51 }, (_, i) => `l${i}`) },
          }),
        ),
      'invalid_input',
      'payload.labels',
    );
  });

  it('元数据更新 payload 至少一个字段', () => {
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope({
            operation: 'project.metadata.update',
            scope: { kind: 'project', projectId: UUID_A },
            expectedRevision: 1,
            payload: {},
          }),
        ),
      'invalid_input',
      'payload',
    );
  });

  it('settings payload v1、未知键、未知政策段拒绝（复用配置校验器）', () => {
    expectPublicError(
      () => validateCommandEnvelope(envelope(settingsCreate({ schemaVersion: 1 }))),
      'invalid_input',
      'payload.schemaVersion',
    );
    expectPublicError(
      () => validateCommandEnvelope(envelope(settingsCreate({ schemaVersion: 2, memoryPolicy: {} }))),
      'invalid_input',
      'payload',
    );
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope(settingsCreate({ schemaVersion: 2, policies: { deliveryPolicy: {} } })),
        ),
      'invalid_input',
      'payload.policies',
    );
  });

  it('非法政策值与强隔离策略拒绝', () => {
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope(settingsCreate({ schemaVersion: 2, policies: { executionLimits: { workTimeoutMs: 0 } } })),
        ),
      'invalid_input',
      'payload.policies.executionLimits.workTimeoutMs',
    );
    expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope(settingsCreate({ schemaVersion: 2, policies: { securityPolicy: { isolation: 'strong_sandbox' } } })),
        ),
      'invalid_input',
      'payload.policies.securityPolicy.isolation',
    );
  });

  it('明文秘密字段不能进入：未知键 apiKey 与携带凭据的 URL 均拒绝且不回显', () => {
    const secretValue = 'sk-live-1234567890abcdef';
    const error = expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope(
            settingsCreate({
              schemaVersion: 2,
              strategies: {
                defaultStrategy: { runtime: 'pi', provider: 'p', model: 'm', apiKey: secretValue },
              },
            }),
          ),
        ),
      'invalid_input',
      'payload.strategies.defaultStrategy',
    );
    expect(JSON.stringify(error)).not.toContain(secretValue);
    const credentialError = expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope(
            settingsCreate({
              schemaVersion: 2,
              strategies: {
                defaultStrategy: {
                  runtime: 'pi',
                  provider: 'p',
                  model: 'm',
                  credentialRef: 'https://user:hunter2@example.example/v1',
                },
              },
            }),
          ),
        ),
      'invalid_input',
      'payload.strategies.defaultStrategy.credentialRef',
    );
    expect(credentialError.details?.reason).toBe('credential_in_url');
    expect(JSON.stringify(credentialError)).not.toContain('hunter2');
  });

  it('错误 details 不回显输入值（最多 receivedType）', () => {
    const error = expectPublicError(
      () =>
        validateCommandEnvelope(
          envelope({ payload: { repositoryPath: { deep: '/secret/path' }, displayName: 'x' } }),
        ),
      'invalid_input',
      'payload.repositoryPath',
    );
    expect(JSON.stringify(error)).not.toContain('/secret/path');
    expect(error.details?.receivedType).toBe('object');
  });
});

describe('F-002 命令时效纯函数（时钟由调用方注入）', () => {
  const valid = validateCommandEnvelope(envelope());

  it('偏差与预算常量冻结为契约值', () => {
    expect(COMMAND_CLOCK_SKEW_MS).toBe(60_000);
    expect(COMMAND_DEFAULT_TTL_MS).toBe(60_000);
    expect(COMMAND_MAX_LIFESPAN_MS).toBe(300_000);
  });

  it('有效期内 fresh；缺省 expiresAt 按 issuedAt+60 000 判定（边界过期）', () => {
    expect(evaluateCommandTiming(valid, ISSUED_MS).kind).toBe('fresh');
    expect(evaluateCommandTiming(valid, ISSUED_MS + 59_999).kind).toBe('fresh');
    expect(evaluateCommandTiming(valid, ISSUED_MS + 60_000).kind).toBe('expired');
  });

  it('issuedAt 超前服务端时钟超过 +60 000 ms 判 clock_skew', () => {
    expect(evaluateCommandTiming(valid, ISSUED_MS - 60_001).kind).toBe('clock_skew');
    expect(evaluateCommandTiming(valid, ISSUED_MS - 60_000).kind).toBe('fresh');
  });

  it('显式 expiresAt 决定有效期', () => {
    const withExpiry = validateCommandEnvelope(envelope({ expiresAt: '2026-10-08T00:00:30.000Z' }));
    expect(evaluateCommandTiming(withExpiry, ISSUED_MS + 30_000).kind).toBe('expired');
    expect(evaluateCommandTiming(withExpiry, ISSUED_MS + 29_999).kind).toBe('fresh');
  });

  it('结构校验：expiresAt 必须晚于 issuedAt；寿命不超过 300 000 ms（边界含）', () => {
    expectPublicError(() => validateCommandEnvelope(envelope({ expiresAt: ISSUED_AT })), 'invalid_input', 'expiresAt');
    const boundary = validateCommandEnvelope(envelope({ expiresAt: '2026-10-08T00:05:00.000Z' }));
    expect(boundary.expiresAt).toBe('2026-10-08T00:05:00.000Z');
    expectPublicError(
      () => validateCommandEnvelope(envelope({ expiresAt: '2026-10-08T00:05:00.001Z' })),
      'invalid_input',
      'expiresAt',
    );
  });
});

describe('F-002 resultRef 形态', () => {
  it('v1. 前缀 + 43 个 base64url 字符', () => {
    for (const char of ['a', 'A', '0', '_', '-']) {
      expect(isValidResultRef(resultRefOf(char))).toBe(true);
    }
    for (const bad of [
      '',
      'v2.abc',
      `${RESULT_REF_PREFIX}${'a'.repeat(42)}`,
      `${RESULT_REF_PREFIX}${'a'.repeat(44)}`,
      `v1/${'a'.repeat(42)}`,
      `${RESULT_REF_PREFIX}${'/'.repeat(43)}`,
      `${RESULT_REF_PREFIX}${'+'.repeat(43)}`,
      UUID_A,
      '/etc/passwd',
      `..${resultRefOf('a')}`,
    ]) {
      expect(isValidResultRef(bad)).toBe(false);
    }
  });

  it('validateResultRef 对非法值抛字段级公开错误，不接受路径形态', () => {
    expectPublicError(() => validateResultRef('../x', 'results.resolve'), 'invalid_input', 'resultRef');
    expect(validateResultRef(resultRefOf('z'), 'results.resolve')).toBe(resultRefOf('z'));
  });
});

describe('F-002 回执形态与不变量', () => {
  const completedBase = {
    commandId: UUID_A,
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    operation: 'project.register' as const,
    scope: { kind: 'registration' as const },
    requestDigest: DIGEST_A,
    result: { status: 'registered', project: { id: UUID_B } },
    resultRef: resultRefOf('a'),
    issuedAt: ISSUED_AT,
    completedAt: '2026-10-08T00:00:00.500Z',
  };

  it('枚举保留 accepted 但不导出 createAcceptedReceipt，回执无 operationId 字段', () => {
    expect([...RECEIPT_STATUSES]).toEqual(['accepted', 'completed', 'rejected']);
    const moduleApi: Record<string, unknown> = { createCompletedReceipt, createRejectedReceipt };
    expect(moduleApi.createAcceptedReceipt).toBeUndefined();
  });

  it('completed 回执携带 commandId/result/resultRef，不含 error/operationId；默认不重放', () => {
    const receipt = createCompletedReceipt(completedBase);
    expect(receipt.schemaVersion).toBe(5);
    expect(receipt.status).toBe('completed');
    expect(receipt.replayed).toBe(false);
    expect(receipt.resultRef).toBe(resultRefOf('a'));
    expect(receipt.result).toEqual({ status: 'registered', project: { id: UUID_B } });
    expect(receipt).not.toHaveProperty('error');
    expect(receipt).not.toHaveProperty('operationId');
  });

  it('replayed:true 表示幂等取回（回执形态不含 expectedRevision/operationId）', () => {
    const receipt = createCompletedReceipt({
      commandId: UUID_A,
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      operation: 'settings.global.update',
      scope: { kind: 'global' },
      requestDigest: DIGEST_A,
      result: { scope: 'global', schemaVersion: 2, revision: 5, payload: SETTINGS_PAYLOAD },
      resultRef: resultRefOf('b'),
      issuedAt: ISSUED_AT,
      completedAt: '2026-10-08T00:00:00.500Z',
      replayed: true,
    });
    expect(receipt.replayed).toBe(true);
    expect(receipt).not.toHaveProperty('expectedRevision');
    expect(receipt).not.toHaveProperty('operationId');
  });

  it('result 序列化超过 16 384 字节是服务端不变量违规（TypeError）', () => {
    expect(RECEIPT_RESULT_MAX_BYTES).toBe(16_384);
    expect(() => createCompletedReceipt({ ...completedBase, result: { blob: 'x'.repeat(16_384) } })).toThrow(TypeError);
  });

  it('completed 回执非法摘要/resultRef/时间/scope 不匹配/commandId 均为编程错误', () => {
    expect(() => createCompletedReceipt({ ...completedBase, requestDigest: 'z'.repeat(64) })).toThrow(TypeError);
    expect(() => createCompletedReceipt({ ...completedBase, resultRef: 'not-a-ref' })).toThrow(TypeError);
    expect(() => createCompletedReceipt({ ...completedBase, completedAt: 'later' })).toThrow(TypeError);
    expect(() => createCompletedReceipt({ ...completedBase, scope: { kind: 'global' } })).toThrow(TypeError);
    expect(() => createCompletedReceipt({ ...completedBase, commandId: 'not-uuid' })).toThrow(TypeError);
  });

  it('rejected 回执携带脱敏公开错误，不携带 result/resultRef', () => {
    const error = new PublicError('conflict', 'project.metadata.update', undefined, {
      details: { reason: 'cas_revision', expectedRevision: 2, actualRevision: 3 },
      cause: new Error('internal db detail that must not leak'),
    });
    const receipt = createRejectedReceipt({
      commandId: UUID_A,
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId: UUID_B },
      requestDigest: DIGEST_A,
      error,
      issuedAt: ISSUED_AT,
      completedAt: '2026-10-08T00:00:00.500Z',
    });
    expect(receipt.status).toBe('rejected');
    expect(receipt.error.code).toBe('conflict');
    expect(receipt.error.details).toEqual({ reason: 'cas_revision', expectedRevision: 2, actualRevision: 3 });
    expect(receipt).not.toHaveProperty('result');
    expect(receipt).not.toHaveProperty('resultRef');
    expect(JSON.stringify(receipt)).not.toContain('internal db detail');
  });
});

describe('F-002 公开错误码与 HTTP 映射唯一', () => {
  it('错误码集合与 §5.7 一致（不含事件专属 snapshot_required/stream_overflow）', () => {
    expect([...PUBLIC_ERROR_CODES].sort()).toEqual(
      [
        'invalid_input',
        'unsupported_schema_version',
        'command_expired',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'resource_busy',
        'unsupported',
        'corrupt_state',
        'internal',
      ].sort(),
    );
  });

  it('每个码有唯一 HTTP 状态映射', () => {
    const expected: Record<string, number> = {
      invalid_input: 400,
      unsupported_schema_version: 400,
      command_expired: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      resource_busy: 409,
      unsupported: 501,
      corrupt_state: 500,
      internal: 500,
    };
    for (const code of PUBLIC_ERROR_CODES) {
      expect(new PublicError(code, 'commands.submit').httpStatus).toBe(expected[code]);
    }
  });

  it('toErrorShape 只含 code/message/details，不含 stack/cause', () => {
    const error = new PublicError('forbidden', 'project.register', undefined, {
      details: { reason: 'invisible_project' },
      cause: new Error('secret'),
    });
    expect(error.toErrorShape()).toEqual({
      code: 'forbidden',
      message: '授权被拒绝',
      details: { reason: 'invisible_project' },
    });
    expect(JSON.stringify(error.toErrorShape())).not.toContain('secret');
  });

  it('isPublicError 守卫可按码收窄', () => {
    const error: unknown = new PublicError('conflict', 'x');
    expect(isPublicError(error)).toBe(true);
    expect(isPublicError(error, 'conflict')).toBe(true);
    expect(isPublicError(error, 'forbidden')).toBe(false);
    expect(isPublicError(new Error('x'))).toBe(false);
  });
});

describe('F-002 StorageError → 公开错误映射', () => {
  function storageError(kind: StorageErrorKind, details?: Record<string, unknown>): StorageError {
    return new StorageError(kind, 'StateStore.secretInternalMethod', '内部文案不应外泄', {
      entity: { type: 'project', id: UUID_A, projectId: UUID_B },
      details,
    });
  }
  const rows: Array<{ kind: StorageErrorKind; code: string; status: number; reason?: string }> = [
    { kind: 'validation', code: 'invalid_input', status: 400 },
    { kind: 'not_found', code: 'not_found', status: 404 },
    { kind: 'conflict', code: 'conflict', status: 409 },
    { kind: 'ownership', code: 'forbidden', status: 403, reason: 'ownership_denied' },
    { kind: 'busy', code: 'resource_busy', status: 409, reason: 'storage_busy' },
    { kind: 'corrupt', code: 'corrupt_state', status: 500 },
    { kind: 'unsupported_version', code: 'corrupt_state', status: 500, reason: 'unsupported_version' },
  ];
  it.each(rows)('$kind → $code ($status)', ({ kind, code, status, reason }) => {
    const mapped = mapStorageError(storageError(kind, { reason: 'whatever' }), {
      operation: 'project.metadata.update',
    });
    expect(mapped.code).toBe(code);
    expect(mapped.httpStatus).toBe(status);
    expect(mapped.operation).toBe('project.metadata.update');
    if (reason !== undefined) {
      expect(mapped.details?.reason).toBe(reason);
    }
  });

  it('validation 保留 field/reason/receivedType 定位', () => {
    const mapped = mapStorageError(
      new StorageError('validation', 'StateStore.updateProject', 'm', {
        details: { field: 'displayName', reason: '必须是字符串', receivedType: 'number' },
      }),
      { operation: 'project.metadata.update' },
    );
    expect(mapped.code).toBe('invalid_input');
    expect(mapped.details).toEqual({
      field: 'displayName',
      reason: '必须是字符串',
      receivedType: 'number',
    });
  });

  it('conflict 保留受控 stale_dependency 与 revision，脏 details 键剔除', () => {
    const mapped = mapStorageError(
      storageError('conflict', {
        reason: 'stale_dependency',
        expectedRevision: 2,
        actualRevision: 5,
        sql: 'SELECT * FROM projects',
        path: '/Users/secret/repo',
        stackTrace: 'boom',
      }),
      { operation: 'settings.project.update' },
    );
    expect(mapped.details).toEqual({
      reason: 'stale_dependency',
      expectedRevision: 2,
      actualRevision: 5,
      entityType: 'project',
    });
    const body = JSON.stringify(mapped.toErrorShape());
    expect(body).not.toContain('/Users/secret/repo');
    expect(body).not.toContain('SELECT');
  });

  it('corrupt 不回显持久 JSON 原文', () => {
    const mapped = mapStorageError(
      new StorageError('corrupt', 'StateStore.getGlobalSettings', '损坏原文', {
        details: { raw: '{"apiKey":"sk-secret"}', reason: 'invalid_json' },
      }),
      { operation: 'settings.global.get' },
    );
    expect(mapped.code).toBe('corrupt_state');
    expect(JSON.stringify(mapped)).not.toContain('sk-secret');
  });

  it('保留实体类型身份但不泄漏实体 id/projectId 与内部方法名', () => {
    const mapped = mapStorageError(storageError('not_found'), { operation: 'projects.get' });
    expect(mapped.details?.entityType).toBe('project');
    expect(JSON.stringify(mapped)).not.toContain(UUID_A);
    expect(JSON.stringify(mapped)).not.toContain(UUID_B);
    expect(JSON.stringify(mapped)).not.toContain('secretInternalMethod');
  });
});

describe('F-002 RepositoryInspectionError → 公开错误映射', () => {
  const rows: Array<{ kind: RepositoryInspectionErrorKind; code: string; status: number; reason: string }> = [
    { kind: 'invalid_input', code: 'invalid_input', status: 400, reason: 'path_not_absolute' },
    { kind: 'not_found', code: 'invalid_input', status: 400, reason: 'repository_path_not_found' },
    { kind: 'not_a_directory', code: 'invalid_input', status: 400, reason: 'repository_not_a_directory' },
    { kind: 'not_a_repository', code: 'invalid_input', status: 400, reason: 'repository_not_a_repository' },
    { kind: 'timeout', code: 'resource_busy', status: 409, reason: 'repository_timeout' },
    { kind: 'io', code: 'resource_busy', status: 409, reason: 'repository_io' },
    { kind: 'unavailable', code: 'internal', status: 500, reason: 'git_unavailable' },
    { kind: 'permission', code: 'internal', status: 500, reason: 'repository_permission' },
  ];
  it.each(rows)('$kind → $code ($status, $reason)', ({ kind, code, status, reason }) => {
    const error = new RepositoryInspectionError(
      kind,
      'RepositoryInspector.inspect',
      `git failed on /secret/repo with stderr`,
      { details: { reason: kind === 'invalid_input' ? 'path_not_absolute' : 'git_timeout', exitCode: 128, stderr: 'fatal: /secret' } },
    );
    const mapped = mapRepositoryInspectionError(error, { operation: 'project.register' });
    expect(mapped.code).toBe(code);
    expect(mapped.httpStatus).toBe(status);
    expect(mapped.details?.reason).toBe(reason);
    const body = JSON.stringify(mapped);
    expect(body).not.toContain('/secret/repo');
    expect(body).not.toContain('fatal:');
    expect(body).not.toContain('128');
  });
});

describe('F-002 未预期异常 → internal（脱敏固定文案，不吞错）', () => {
  it('普通 Error / 字符串 / null / 对象都映射为 internal 且映射器自身不抛', () => {
    for (const cause of [
      new Error('boom with secret payload xyz'),
      'string failure',
      null,
      { code: 'weird' },
      undefined,
    ]) {
      const mapped = mapUnexpectedError(cause, { operation: 'project.register' });
      expect(mapped.code).toBe('internal');
      expect(mapped.httpStatus).toBe(500);
      expect(mapped.operation).toBe('project.register');
      expect(JSON.stringify(mapped.toErrorShape())).not.toContain('xyz');
    }
  });

  it('mapToPublicError：PublicError 原样传递，Storage/仓库错误分类映射，其余 internal', () => {
    const publicError = new PublicError('forbidden', 'project.register');
    expect(mapToPublicError(publicError, { operation: 'other' })).toBe(publicError);
    expect(
      mapToPublicError(new StorageError('busy', 'x', 'm'), { operation: 'project.register' }).code,
    ).toBe('resource_busy');
    expect(
      mapToPublicError(
        new RepositoryInspectionError('timeout', 'x', 'm'),
        { operation: 'project.register' },
      ).code,
    ).toBe('resource_busy');
    expect(mapToPublicError(new Error('x'), { operation: 'project.register' }).code).toBe('internal');
  });
});

describe('F-002 契约模块纯度（无 HTTP/SSE/ORM/Pi SDK/适配器导入）', () => {
  it('commands.ts 源码不导入基础设施与适配层', () => {
    const modulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'packages/core/src/ports/commands.ts',
    );
    const source = readFileSync(modulePath, 'utf-8');
    expect(source).not.toMatch(/from 'node:(http|https|net|dgram|fs|child_process|worker_threads)'/);
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('drizzle-orm');
    expect(source).not.toContain('adapters/');
    expect(source).not.toContain('pi-coding-agent');
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });
});
