/**
 * F-006 持久 command_receipts、稳定请求摘要与授权回执/结果读取回归
 * （真实临时 SQLite，非 mock）。
 *
 * 覆盖（P02-2 / F-006 验收点，全部为真实断言）：
 * - §5.2 请求摘要：canonical JSON 键序无关、commandId 不进摘要、任一业务参数/
 *   revision/时间字段不同摘要不同、与 P02-1 Host stableCanonicalJson 逐字节一致
 *   （固定摘要向量锁定）；
 * - §5.6 resultRef：32 字节熵 → v1.+43 字符 base64url，非路径形态；
 * - 迁移 v3：空库与 P01 最新库（v2）两条路径迁移成功，既有项目/配置/事件
 *   sequence 保留，高版本/checksum 漂移继续拒写，升级前有一致性备份；
 * - CommandReceiptStore：completed/rejected 回执三态 scope 存取、唯一约束
 *   （principal+commandId / result_ref）、跨身份结构性隔离、关闭重开一致、
 *   损坏行显式 corrupt_state（不伪造回执）、端口输入 unknown 校验先于 SQL；
 * - §5.5 重放判定：同摘要 replay（replayed:true）、不同摘要 conflict
 *   （idempotency_key_reuse）；
 * - CommandReceiptsService：授权回执读取与 resultRef 解析（无能力 forbidden、
 *   跨身份/不可见/未知一律 not_found、注册回执新建项目可见性重核、固化结果
 *   不随后续项目修改变化、非法 commandId/resultRef 字段级 invalid_input）；
 * - 受控装配：openCoreApplication 暴露 commandReceiptStore/commandReceiptsService。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableCanonicalJson as hostStableCanonicalJson } from '../packages/host/src/contract/identifiers.ts';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  isValidResultRef,
  validateCommandEnvelope,
} from '../packages/core/src/ports/commands.ts';
import type {
  AppOperation,
  CommandReceipt,
  CommandScope,
  CompletedCommandReceipt,
} from '../packages/core/src/ports/commands.ts';
import {
  RECEIPT_READ_OPERATION,
  computeCommandRequestDigest,
  createResultRef,
  decideCommandReplay,
  mapPersistedCommandReceipt,
  stableCanonicalJson,
  validatePersistableCommandReceipt,
} from '../packages/core/src/ports/command-receipts.ts';
import type { PersistedCommandReceiptRow } from '../packages/core/src/ports/command-receipts.ts';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import { createLocalOwnerPrincipal as createProductLocalOwnerPrincipal } from '../packages/core/src/ports/authorization.ts';
import { createCommandReceiptsService } from '../packages/core/src/application/command-receipts-service.ts';
import type { CommandReceiptsService } from '../packages/core/src/application/command-receipts-service.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { createSqliteCommandReceiptStore } from '../packages/core/src/adapters/sqlite/command-receipts.ts';
import type { CommandReceiptStore } from '../packages/core/src/ports/command-receipts.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { createCommandsTestFixture } from './helpers/p02-2/index.ts';
import { createRestrictedPrincipal } from './helpers/p02-2/index.ts';

/* ------------------------------------------------------------------ *
 * 固定常量与构造器
 * ------------------------------------------------------------------ */

const NOW_ISO = '2026-10-08T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const COMPLETED_ISO = '2026-10-08T00:00:01.000Z';
const DIGEST_HEX = 'ab'.repeat(32);
const OTHER_DIGEST_HEX = 'cd'.repeat(32);

const PROJECT_UPDATE_ENVELOPE_RAW = {
  schemaVersion: 2,
  commandId: '11111111-1111-4111-8111-111111111111',
  operation: 'project.metadata.update',
  scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222222' },
  expectedRevision: 3,
  issuedAt: '2026-10-08T00:00:00.000Z',
  payload: { displayName: '示例项目', labels: ['alpha', 'beta'] },
} as const;

/** 固定摘要向量（实现无关；算法漂移立即失败）。 */
const PROJECT_UPDATE_DIGEST =
  '0682beef357b2203161f090858ce189f335fc68fd8f93f1c68d79609527bc3ba';

const REGISTER_ENVELOPE_RAW = {
  schemaVersion: 2,
  commandId: '33333333-3333-4333-8333-333333333333',
  operation: 'project.register',
  scope: { kind: 'registration' },
  issuedAt: '2026-10-08T01:02:03.000Z',
  expiresAt: '2026-10-08T01:03:03.000Z',
  payload: { repositoryPath: '/repo/a', displayName: '示例项目' },
} as const;

const REGISTER_DIGEST = '213a783d5c0032538ae1c9022aab7602b68af6e11cf060cec281acf4508581bb';

/** 确定性 resultRef（32 字节 0x07）。 */
const RESULT_REF = 'v1.BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';

function entropy(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

interface ReceiptOverrides {
  readonly commandId?: string;
  readonly principalId?: string;
  readonly operation?: AppOperation;
  readonly scope?: CommandScope;
  readonly requestDigest?: string;
  readonly result?: unknown;
  readonly resultRef?: string;
}

function makeCompletedReceipt(overrides: ReceiptOverrides = {}): CompletedCommandReceipt {
  return createCompletedReceipt({
    commandId: overrides.commandId ?? randomUUID(),
    principalId: overrides.principalId ?? 'local-owner',
    operation: overrides.operation ?? 'project.register',
    scope: overrides.scope ?? { kind: 'registration' },
    requestDigest: overrides.requestDigest ?? DIGEST_HEX,
    issuedAt: NOW_ISO,
    completedAt: COMPLETED_ISO,
    result: overrides.result ?? { status: 'registered', project: { id: randomUUID() } },
    // 默认随机熵保证每个回执的 resultRef 唯一；需要固定引用时经 overrides 显式传入。
    resultRef: overrides.resultRef ?? createResultRef(randomBytes(32)),
  });
}

function makeRejectedReceipt(overrides: ReceiptOverrides = {}) {
  return createRejectedReceipt({
    commandId: overrides.commandId ?? randomUUID(),
    principalId: overrides.principalId ?? 'local-owner',
    operation: overrides.operation ?? 'project.register',
    scope: overrides.scope ?? { kind: 'registration' },
    requestDigest: overrides.requestDigest ?? DIGEST_HEX,
    issuedAt: NOW_ISO,
    completedAt: COMPLETED_ISO,
    error: new PublicError('conflict', overrides.operation ?? 'project.register', undefined, {
      details: { reason: 'stale_dependency' },
    }),
  });
}

/** 与 completed 回执对应的持久行列形态（应用侧 camelCase + 已解析 JSON）。 */
function persistedRowOf(receipt: CommandReceipt): PersistedCommandReceiptRow {
  const base = {
    principalId: receipt.principalId,
    commandId: receipt.commandId,
    scopeKind: receipt.scope.kind,
    projectId: receipt.scope.kind === 'project' ? receipt.scope.projectId : null,
    operation: receipt.operation,
    requestDigest: receipt.requestDigest,
    status: receipt.status,
    issuedAtUtcMs: Date.parse(receipt.issuedAt),
    completedAtUtcMs: Date.parse(receipt.completedAt),
  };
  if (receipt.status === 'completed') {
    return {
      ...base,
      result: receipt.result,
      resultRef: receipt.resultRef,
      errorCode: null,
      errorMessage: null,
      errorDetails: null,
    };
  }
  return {
    ...base,
    result: undefined,
    resultRef: null,
    errorCode: receipt.error.code,
    errorMessage: receipt.error.message,
    errorDetails: receipt.error.details ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 真实 SQLite 夹具
 * ------------------------------------------------------------------ */

function createClock(start = 1_760_000_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

interface Harness {
  readonly session: SqliteStorageSession;
  readonly receiptStore: CommandReceiptStore;
  readonly stateStore: StateStore;
  readonly receipts: CommandReceiptsService;
  readonly dbPath: string;
  close(): void;
}

function openHarness(dbPath: string, clock: Clock): Harness {
  const session = openSqliteStorageSession({ path: dbPath });
  const options = { nowUtcMs: () => clock.next() };
  const receiptStore = createSqliteCommandReceiptStore(session, options);
  const stateStore = createSqliteStateStore(session, options);
  const receipts = createCommandReceiptsService({ receiptStore });
  return {
    session,
    receiptStore,
    stateStore,
    receipts,
    dbPath,
    close(): void {
      session.close();
    },
  };
}

async function withMigratedDb(
  fn: (harness: Harness, paths: { root: string; dbPath: string }) => Promise<void>,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p02-2-f006-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    const harness = openHarness(dbPath, createClock());
    try {
      await fn(harness, { root: sandbox.path, dbPath });
    } finally {
      harness.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

async function expectStorageValidation(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `应为 StorageError(validation)，实际 ${String(error)}`).toBe(true);
    return;
  }
  throw new Error('预期 StorageError(validation)，实际未抛出');
}

async function expectPublicError(
  code: PublicError['code'],
  fn: () => Promise<unknown> | unknown,
  reason?: string,
): Promise<PublicError> {
  try {
    await fn();
  } catch (error) {
    expect(error, `应为 PublicError(${code})，实际 ${String(error)}`).toBeInstanceOf(PublicError);
    const publicError = error as PublicError;
    expect(publicError.code).toBe(code);
    if (reason !== undefined) {
      expect(publicError.details?.reason).toBe(reason);
    }
    return publicError;
  }
  throw new Error(`预期 PublicError(${code})，实际未抛出`);
}

/* ------------------------------------------------------------------ *
 * §5.2 请求摘要
 * ------------------------------------------------------------------ */

describe('F-006 §5.2 computeCommandRequestDigest', () => {
  it('固定摘要向量与 P02-1 Host stableCanonicalJson 逐字节一致', () => {
    const envelope = validateCommandEnvelope(PROJECT_UPDATE_ENVELOPE_RAW);
    expect(computeCommandRequestDigest(envelope)).toBe(PROJECT_UPDATE_DIGEST);
    const register = validateCommandEnvelope(REGISTER_ENVELOPE_RAW);
    expect(computeCommandRequestDigest(register)).toBe(REGISTER_DIGEST);
    // 与 P02-1 Host 实现共用同一算法（规范 JSON 文本逐字节相同）。
    const canonicalInput = {
      schemaVersion: 2,
      operation: envelope.operation,
      scope: envelope.scope,
      expectedRevision: envelope.expectedRevision,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      payload: envelope.payload,
    };
    expect(stableCanonicalJson(canonicalInput)).toBe(hostStableCanonicalJson(canonicalInput));
    expect(computeCommandRequestDigest(envelope)).toBe(
      createHash('sha256').update(hostStableCanonicalJson(canonicalInput), 'utf8').digest('hex'),
    );
  });

  it('键顺序不同的等价 JSON 摘要相同；commandId 不进摘要', () => {
    const a = validateCommandEnvelope(PROJECT_UPDATE_ENVELOPE_RAW);
    const reordered = validateCommandEnvelope({
      payload: { labels: ['alpha', 'beta'], displayName: '示例项目' },
      issuedAt: '2026-10-08T00:00:00.000Z',
      expectedRevision: 3,
      scope: { projectId: '22222222-2222-4222-8222-222222222222', kind: 'project' },
      operation: 'project.metadata.update',
      commandId: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 2,
    });
    expect(computeCommandRequestDigest(a)).toBe(computeCommandRequestDigest(reordered));
    const otherCommandId = validateCommandEnvelope({
      ...PROJECT_UPDATE_ENVELOPE_RAW,
      commandId: '99999999-9999-4999-8999-999999999999',
    });
    expect(computeCommandRequestDigest(a)).toBe(computeCommandRequestDigest(otherCommandId));
  });

  it('expiresAt 缺席与 null 归一化一致；缺席与显式值不同', () => {
    const absent = validateCommandEnvelope(REGISTER_ENVELOPE_RAW);
    const explicit = validateCommandEnvelope({ ...REGISTER_ENVELOPE_RAW });
    expect(computeCommandRequestDigest(absent)).toBe(computeCommandRequestDigest(explicit));
    const laterExpiry = validateCommandEnvelope({
      ...REGISTER_ENVELOPE_RAW,
      expiresAt: '2026-10-08T01:04:03.000Z',
    });
    expect(computeCommandRequestDigest(absent)).not.toBe(computeCommandRequestDigest(laterExpiry));
  });

  it.each([
    ['scope.projectId', { scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222223' } }],
    ['expectedRevision', { expectedRevision: 4 }],
    ['issuedAt', { issuedAt: '2026-10-08T00:00:01.000Z' }],
    ['expiresAt', { expiresAt: '2026-10-08T00:01:00.000Z' }],
    ['payload.displayName', { payload: { displayName: '另一个项目', labels: ['alpha', 'beta'] } }],
    ['payload.labels', { payload: { displayName: '示例项目', labels: ['alpha'] } }],
  ] as const)('任一业务参数不同摘要不同：%s', (_field, patch) => {
    const base = validateCommandEnvelope(PROJECT_UPDATE_ENVELOPE_RAW);
    const mutated = validateCommandEnvelope({ ...PROJECT_UPDATE_ENVELOPE_RAW, ...patch });
    expect(computeCommandRequestDigest(base)).not.toBe(computeCommandRequestDigest(mutated));
  });

  it('操作不同摘要不同（settings.project.update vs project.metadata.update）', () => {
    const metadata = validateCommandEnvelope(PROJECT_UPDATE_ENVELOPE_RAW);
    const settings = validateCommandEnvelope({
      schemaVersion: 2,
      commandId: '11111111-1111-4111-8111-111111111111',
      operation: 'settings.project.update',
      scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222222' },
      expectedRevision: 3,
      issuedAt: '2026-10-08T00:00:00.000Z',
      payload: { schemaVersion: 2 },
    });
    expect(computeCommandRequestDigest(metadata)).not.toBe(computeCommandRequestDigest(settings));
  });

  it('非 JSON 安全数据是调用方编程错误（TypeError），不静默序列化', () => {
    expect(() => stableCanonicalJson({ bad: Number.NaN })).toThrow(TypeError);
    expect(() => stableCanonicalJson({ bad: 10n })).toThrow(TypeError);
    expect(() => stableCanonicalJson({ bad: () => 1 })).toThrow(TypeError);
    expect(() => stableCanonicalJson(new Date(0))).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ *
 * §5.6 resultRef 生成
 * ------------------------------------------------------------------ */

describe('F-006 §5.6 createResultRef', () => {
  it('32 字节熵生成 v1.+43 字符 base64url 引用（确定、非路径形态）', () => {
    const ref = createResultRef(entropy(7));
    expect(ref).toBe(RESULT_REF);
    expect(isValidResultRef(ref)).toBe(true);
    expect(ref).not.toContain('/');
    expect(ref).not.toContain('..');
    expect(ref).not.toContain('\\');
    expect(createResultRef(entropy(8))).not.toBe(ref);
  });

  it.each([31, 33, 0])('熵长度 %d 字节是编程错误（TypeError）', (length) => {
    expect(() => createResultRef(new Uint8Array(length))).toThrow(TypeError);
  });

  it('非字节数组输入是编程错误（TypeError）', () => {
    expect(() => createResultRef('0'.repeat(64) as unknown as Uint8Array)).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ *
 * 写入边界校验（端口输入 unknown）
 * ------------------------------------------------------------------ */

describe('F-006 validatePersistableCommandReceipt（写入边界，先于任何 SQL）', () => {
  it('工厂产出的 completed/rejected 回执通过校验', () => {
    expect(validatePersistableCommandReceipt(makeCompletedReceipt(), 'test.op')).toMatchObject({
      status: 'completed',
      replayed: false,
    });
    expect(validatePersistableCommandReceipt(makeRejectedReceipt(), 'test.op')).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict' },
    });
  });

  const BASE = makeCompletedReceipt({ commandId: '11111111-1111-4111-8111-111111111111' });

  const INVALID_CASES: readonly { name: string; mutate: (receipt: Record<string, unknown>) => void }[] = [
    { name: '未知键', mutate: (r) => Object.assign(r, { actorId: 'x' }) },
    { name: 'schemaVersion 非 2', mutate: (r) => Object.assign(r, { schemaVersion: 1 }) },
    { name: 'replayed=true 不入库', mutate: (r) => Object.assign(r, { replayed: true }) },
    { name: 'commandId 非 UUID', mutate: (r) => Object.assign(r, { commandId: 'not-uuid' }) },
    { name: 'principalId 空串', mutate: (r) => Object.assign(r, { principalId: '' }) },
    { name: 'principalId 含控制字符', mutate: (r) => Object.assign(r, { principalId: 'a\nb' }) },
    { name: 'principalId 超长', mutate: (r) => Object.assign(r, { principalId: 'x'.repeat(129) }) },
    { name: '未知操作', mutate: (r) => Object.assign(r, { operation: 'work.start' }) },
    {
      name: 'scope 与操作不匹配',
      mutate: (r) => Object.assign(r, { operation: 'project.metadata.update' }),
    },
    {
      name: 'registration scope 携带 projectId',
      mutate: (r) => Object.assign(r, { scope: { kind: 'registration', projectId: randomUUID() } }),
    },
    { name: '摘要非 64hex', mutate: (r) => Object.assign(r, { requestDigest: 'AB'.repeat(32) }) },
    { name: 'issuedAt 非 ISO UTC', mutate: (r) => Object.assign(r, { issuedAt: '2026-10-08 08:00:00' }) },
    { name: 'completed 缺 result', mutate: (r) => Object.assign(r, { result: undefined }) },
    { name: 'completed 缺 resultRef', mutate: (r) => Object.assign(r, { resultRef: undefined }) },
    { name: 'completed 携带 error', mutate: (r) => Object.assign(r, { error: { code: 'conflict', message: 'x' } }) },
    {
      name: 'resultRef 形态非法',
      mutate: (r) => Object.assign(r, { resultRef: '/etc/passwd' }),
    },
    {
      name: 'result 超 16384 字节',
      mutate: (r) => Object.assign(r, { result: { blob: 'x'.repeat(17_000) } }),
    },
  ];

  it.each(INVALID_CASES.map((c) => [c.name, c] as const))('拒绝非法回执：%s', (_name, testCase) => {
    const draft: Record<string, unknown> = { ...BASE };
    testCase.mutate(draft);
    for (const key of Object.keys(draft)) {
      if (draft[key] === undefined) {
        delete draft[key];
      }
    }
    let caught: unknown;
    try {
      validatePersistableCommandReceipt(draft, 'test.op');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught, 'validation'), `应为 StorageError(validation)，实际 ${String(caught)}`).toBe(true);
    expect((caught as StorageError).entity?.type).toBe('command_receipt');
  });

  it.each([
    ['status=accepted', { status: 'accepted' }],
    ['status 未知', { status: 'pending' }],
    ['rejected 缺 error', { status: 'rejected', result: undefined, resultRef: undefined }],
    ['rejected 携带 result', { status: 'rejected' }],
  ] as const)('拒绝非法状态组合：%s', (_name, patch) => {
    const draft: Record<string, unknown> = { ...BASE, ...patch };
    for (const key of Object.keys(draft)) {
      if (draft[key] === undefined) {
        delete draft[key];
      }
    }
    let caught: unknown;
    try {
      validatePersistableCommandReceipt(draft, 'test.op');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught, 'validation'), `应为 StorageError(validation)，实际 ${String(caught)}`).toBe(true);
  });

  it.each([
    ['未知错误码', { code: 'mystery', message: 'x' }],
    ['message 空串', { code: 'conflict', message: '' }],
    ['message 含控制字符', { code: 'conflict', message: 'a\nb' }],
    ['message 超长', { code: 'conflict', message: 'x'.repeat(201) }],
    ['details 非对象', { code: 'conflict', message: 'x', details: ['reason'] }],
    ['details 白名单外键', { code: 'conflict', message: 'x', details: { stack: 'trace' } }],
    ['error 未知键', { code: 'conflict', message: 'x', cause: 'secret' }],
  ] as const)('拒绝非法错误形状：%s', (_name, errorShape) => {
    const draft = { ...makeRejectedReceipt(), error: errorShape };
    let caught: unknown;
    try {
      validatePersistableCommandReceipt(draft, 'test.op');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught, 'validation'), `应为 StorageError(validation)，实际 ${String(caught)}`).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 持久行列映射
 * ------------------------------------------------------------------ */

describe('F-006 mapPersistedCommandReceipt（行列映射，显式失败不伪造）', () => {
  it('completed/rejected 行列正确映射（毫秒 → ISO UTC，replayed=false）', () => {
    const completed = makeCompletedReceipt();
    expect(mapPersistedCommandReceipt(persistedRowOf(completed))).toEqual(completed);
    const rejected = makeRejectedReceipt();
    expect(mapPersistedCommandReceipt(persistedRowOf(rejected))).toEqual(rejected);
  });

  const VALID_ROW = persistedRowOf(makeCompletedReceipt({ commandId: '11111111-1111-4111-8111-111111111111' }));

  it.each([
    ['非对象行', null],
    ['未知键', { ...VALID_ROW, internalNote: 'x' }],
    ['commandId 非法', { ...VALID_ROW, commandId: 'x' }],
    ['principalId 非法', { ...VALID_ROW, principalId: '  ' }],
    ['持久化 accepted', { ...VALID_ROW, status: 'accepted' }],
    ['未知操作', { ...VALID_ROW, operation: 'work.start' }],
    [
      'scope 与操作不匹配',
      { ...persistedRowOf(makeCompletedReceipt({ operation: 'settings.global.create', scope: { kind: 'global' } })), scopeKind: 'project', projectId: randomUUID() },
    ],
    ['project scope 缺 projectId', { ...persistedRowOf(makeCompletedReceipt({ operation: 'project.metadata.update', scope: { kind: 'project', projectId: randomUUID() } })), projectId: null }],
    ['registration scope 携带 projectId', { ...VALID_ROW, projectId: randomUUID() }],
    ['摘要非法', { ...VALID_ROW, requestDigest: 'zz' }],
    ['completed 缺 result', { ...VALID_ROW, result: undefined }],
    ['completed 缺 resultRef', { ...VALID_ROW, resultRef: null }],
    ['completed 携带 errorCode', { ...VALID_ROW, errorCode: 'conflict' }],
    ['completed result 超界', { ...VALID_ROW, result: { blob: 'x'.repeat(17_000) } }],
    ['时间非法', { ...VALID_ROW, issuedAtUtcMs: -1 }],
  ] as const)('拒绝损坏行列：%s', (_name, row) => {
    let caught: unknown;
    try {
      mapPersistedCommandReceipt(row);
    } catch (error) {
      caught = error;
    }
    expect(caught, `应为 corrupt_state，实际 ${String(caught)}`).toBeInstanceOf(PublicError);
    expect((caught as PublicError).code).toBe('corrupt_state');
    expect((caught as PublicError).operation).toBe(RECEIPT_READ_OPERATION);
    expect((caught as PublicError).details?.reason).toBe('corrupt_receipt_row');
  });

  const REJECTED_ROW = persistedRowOf(makeRejectedReceipt({ commandId: '11111111-1111-4111-8111-111111111111' }));

  it.each([
    ['rejected 缺 errorCode', { ...REJECTED_ROW, errorCode: null }],
    ['rejected 未知错误码', { ...REJECTED_ROW, errorCode: 'mystery' }],
    ['rejected 缺 message', { ...REJECTED_ROW, errorMessage: null }],
    ['rejected message 含控制字符', { ...REJECTED_ROW, errorMessage: 'a\nb' }],
    ['rejected 携带 resultRef', { ...REJECTED_ROW, resultRef: RESULT_REF }],
    ['rejected details 白名单外键', { ...REJECTED_ROW, errorDetails: { secret: 'x' } }],
    ['rejected details 非对象', { ...REJECTED_ROW, errorDetails: ['reason'] }],
  ] as const)('拒绝损坏 rejected 行列：%s', (_name, row) => {
    let caught: unknown;
    try {
      mapPersistedCommandReceipt(row);
    } catch (error) {
      caught = error;
    }
    expect(caught, `应为 corrupt_state，实际 ${String(caught)}`).toBeInstanceOf(PublicError);
    expect((caught as PublicError).code).toBe('corrupt_state');
    expect((caught as PublicError).details?.reason).toBe('corrupt_receipt_row');
  });
});

/* ------------------------------------------------------------------ *
 * §5.5 重放判定
 * ------------------------------------------------------------------ */

describe('F-006 §5.5 decideCommandReplay', () => {
  it('无既有回执 → new；同摘要 → replay（replayed:true，不改写原回执）', () => {
    expect(decideCommandReplay(undefined, DIGEST_HEX, 'op')).toEqual({ kind: 'new' });
    const existing = makeCompletedReceipt({ requestDigest: DIGEST_HEX });
    const decision = decideCommandReplay(existing, DIGEST_HEX, 'op');
    expect(decision.kind).toBe('replay');
    if (decision.kind === 'replay') {
      expect(decision.receipt.replayed).toBe(true);
      expect(decision.receipt.requestDigest).toBe(DIGEST_HEX);
      // 原对象不被改写。
      expect(existing.replayed).toBe(false);
    }
  });

  it('同 commandId 不同摘要 → 409 conflict（idempotency_key_reuse）', () => {
    const existing = makeCompletedReceipt({ requestDigest: DIGEST_HEX });
    let caught: unknown;
    try {
      decideCommandReplay(existing, OTHER_DIGEST_HEX, 'project.register');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PublicError);
    expect((caught as PublicError).code).toBe('conflict');
    expect((caught as PublicError).httpStatus).toBe(409);
    expect((caught as PublicError).details).toEqual({ reason: 'idempotency_key_reuse' });
    // 既有回执不变。
    expect(existing.requestDigest).toBe(DIGEST_HEX);
    expect(existing.replayed).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * SQLite 适配器：存取、唯一约束、跨身份隔离、关闭重开
 * ------------------------------------------------------------------ */

describe('F-006 CommandReceiptStore SQLite 适配器（真实临时库）', () => {
  it('completed/rejected 回执三态 scope 存取往返一致', async () => {
    await withMigratedDb(async ({ receiptStore, stateStore }) => {
      const project = await stateStore.createProject({ displayName: '回执宿主项目' });
      const registration = makeCompletedReceipt({ result: { status: 'registered', project: { id: project.id } } });
      const globalRejected = makeRejectedReceipt({
        operation: 'settings.global.create',
        scope: { kind: 'global' },
      });
      const projectReceipt = makeCompletedReceipt({
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: project.id },
        result: { project: { id: project.id, revision: 2 } },
      });
      await receiptStore.saveReceipt(registration);
      await receiptStore.saveReceipt(globalRejected);
      await receiptStore.saveReceipt(projectReceipt);

      expect(await receiptStore.findReceiptByCommandId(registration.principalId, registration.commandId)).toEqual(registration);
      expect(await receiptStore.findReceiptByCommandId(globalRejected.principalId, globalRejected.commandId)).toEqual(globalRejected);
      expect(await receiptStore.findReceiptByCommandId(projectReceipt.principalId, projectReceipt.commandId)).toEqual(projectReceipt);
      expect(await receiptStore.findReceiptByResultRef(registration.resultRef)).toEqual(registration);
      // rejected 回执无 resultRef。
      expect(globalRejected.status).toBe('rejected');
    });
  });

  it('缺失返回 undefined；非法输入先于 SQL 拒绝', async () => {
    await withMigratedDb(async ({ receiptStore }) => {
      expect(await receiptStore.findReceiptByCommandId('local-owner', randomUUID())).toBeUndefined();
      expect(await receiptStore.findReceiptByResultRef(RESULT_REF)).toBeUndefined();
      await expectStorageValidation(() => receiptStore.findReceiptByCommandId('local-owner', 'not-uuid'));
      await expectStorageValidation(() => receiptStore.findReceiptByCommandId('', randomUUID()));
      // 路径形态/伪 resultRef 一律字段级校验拒绝，不做任何文件/定位解析。
      await expectStorageValidation(() => receiptStore.findReceiptByResultRef('/etc/passwd'));
      await expectStorageValidation(() => receiptStore.findReceiptByResultRef('v1.too-short'));
    });
  });

  it('唯一约束：同 principal/commandId 冲突；不同 principal 各自独立；result_ref 唯一', async () => {
    await withMigratedDb(async ({ receiptStore }) => {
      const first = makeCompletedReceipt({ requestDigest: DIGEST_HEX });
      await receiptStore.saveReceipt(first);

      // 同 (principal, commandId)：即使摘要相同也不重复写入（防御纵深）。
      const duplicate = makeCompletedReceipt({
        commandId: first.commandId,
        requestDigest: DIGEST_HEX,
        resultRef: createResultRef(entropy(9)),
      });
      let conflictError: unknown;
      try {
        await receiptStore.saveReceipt(duplicate);
      } catch (error) {
        conflictError = error;
      }
      expect(isStorageError(conflictError, 'conflict'), `应为 conflict，实际 ${String(conflictError)}`).toBe(true);
      expect((conflictError as StorageError).details?.reason).toBe('duplicate_command_id');
      // 既有回执不变。
      expect(await receiptStore.findReceiptByCommandId(first.principalId, first.commandId)).toEqual(first);

      // 不同 principal 使用同一 commandId：互相独立（复合唯一键）。
      const otherPrincipal = makeCompletedReceipt({
        commandId: first.commandId,
        principalId: 'other-principal',
        requestDigest: OTHER_DIGEST_HEX,
        resultRef: createResultRef(entropy(11)),
      });
      await receiptStore.saveReceipt(otherPrincipal);
      expect(await receiptStore.findReceiptByCommandId('other-principal', first.commandId)).toEqual(otherPrincipal);
      expect(await receiptStore.findReceiptByCommandId(first.principalId, first.commandId)).toEqual(first);

      // result_ref 全库唯一。
      const dupRef = makeCompletedReceipt({ resultRef: first.resultRef });
      let refConflict: unknown;
      try {
        await receiptStore.saveReceipt(dupRef);
      } catch (error) {
        refConflict = error;
      }
      expect(isStorageError(refConflict, 'conflict'), `应为 conflict，实际 ${String(refConflict)}`).toBe(true);
      expect((refConflict as StorageError).details?.reason).toBe('duplicate_result_ref');
    });
  });

  it('关闭重开后回执内容逐字段一致', async () => {
    const sandbox = createTempSandbox('shiploop-p02-2-f006-reopen-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const firstSession = openSqliteStorageSession({ path: dbPath });
      await migrateSqliteStorage(firstSession);
      firstSession.close();

      const first = openHarness(dbPath, createClock());
      const receipt = makeCompletedReceipt({ result: { note: '多字节内容 🚢', nested: { a: [1, 2] } } });
      await first.receiptStore.saveReceipt(receipt);
      first.close();

      const second = openHarness(dbPath, createClock());
      try {
        expect(await second.receiptStore.findReceiptByCommandId(receipt.principalId, receipt.commandId)).toEqual(receipt);
        expect(await second.receiptStore.findReceiptByResultRef(receipt.resultRef)).toEqual(receipt);
      } finally {
        second.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('会话关闭后端口操作明确拒绝', async () => {
    await withMigratedDb(async ({ receiptStore, session }) => {
      session.close();
      await expect(receiptStore.saveReceipt(makeCompletedReceipt())).rejects.toThrow(/已关闭/);
      await expect(receiptStore.findReceiptByCommandId('local-owner', randomUUID())).rejects.toThrow(/已关闭/);
      await expect(receiptStore.findReceiptByResultRef(RESULT_REF)).rejects.toThrow(/已关闭/);
    });
  });

  it('损坏持久行显式 corrupt_state，不作为有效回执返回', async () => {
    await withMigratedDb(async ({ receiptStore, session }) => {
      const receipt = makeCompletedReceipt();
      await receiptStore.saveReceipt(receipt);

      // 未知操作（DDL 不约束 operation 枚举——读取端口必须显式失败）。
      session.database
        .prepare("UPDATE command_receipts SET operation = 'work.start' WHERE command_id = ?")
        .run(receipt.commandId);
      await expectPublicError('corrupt_state', () =>
        receiptStore.findReceiptByCommandId(receipt.principalId, receipt.commandId),
      );

      // result_json 损坏（DDL 无 json_valid——适配器解析失败即 corrupt）。
      session.database
        .prepare("UPDATE command_receipts SET operation = 'project.register', result_json = '{broken' WHERE command_id = ?")
        .run(receipt.commandId);
      let caught: unknown;
      try {
        await receiptStore.findReceiptByCommandId(receipt.principalId, receipt.commandId);
      } catch (error) {
        caught = error;
      }
      expect(isStorageError(caught, 'corrupt'), `应为 StorageError(corrupt)，实际 ${String(caught)}`).toBe(true);
      expect((caught as StorageError).details?.reason).toBe('invalid_result_json');
    });
  });
});

/* ------------------------------------------------------------------ *
 * 迁移 v3：空库 / v2 库升级 / 高版本与 checksum 漂移拒写
 * ------------------------------------------------------------------ */

describe('F-006 迁移 v3 command_receipts', () => {
  it('空库迁移建立 v1..v3 与 command_receipts 表', async () => {
    const sandbox = createTempSandbox('shiploop-p02-2-f006-empty-');
    try {
      const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
      try {
        const result = await migrateSqliteStorage(session);
        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(3);
        expect(result.appliedVersions).toEqual([1, 2, 3]);
        const tables = session.database
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => row.name);
        expect(tables).toContain('command_receipts');
        // 不建 operations 表（无悬空外键）。
        expect(tables).not.toContain('operations');
        const versions = session.database
          .prepare<[], { version: number }>('SELECT version FROM schema_migrations ORDER BY version')
          .all();
        expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('从 P01 最新库（v2）升级：既有项目/配置/事件 sequence 保留，回执表可用，升级前有一致性备份', async () => {
    const sandbox = createTempSandbox('shiploop-p02-2-f006-upgrade-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      // 先只应用 v1/v2（模拟 P01 最新库），写入真实业务数据。
      const legacySession = openSqliteStorageSession({ path: dbPath });
      const legacy = await migrateSqliteStorage(legacySession, {
        migrations: SQLITE_MIGRATIONS.slice(0, 2),
      });
      expect(legacy.appliedVersions).toEqual([1, 2]);
      const clock = createClock();
      const legacyStore = createSqliteStateStore(legacySession, { nowUtcMs: () => clock.next() });
      const project = await legacyStore.createProject({ displayName: '升级前项目', labels: ['p01'] });
      await legacyStore.updateProject(project.id, { expectedRevision: 1, displayName: '升级前项目（改）' });
      const globalSettings = await legacyStore.createGlobalSettings({
        payload: { schemaVersion: 2 },
      });
      legacySession.close();

      // 升级至 v3。
      const upgradedSession = openSqliteStorageSession({ path: dbPath });
      const upgraded = await migrateSqliteStorage(upgradedSession);
      expect(upgraded.fromVersion).toBe(2);
      expect(upgraded.toVersion).toBe(3);
      expect(upgraded.appliedVersions).toEqual([3]);
      expect(upgraded.backupPath).toBeDefined();
      expect(existsSync(upgraded.backupPath as string)).toBe(true);

      const store = createSqliteStateStore(upgradedSession, { nowUtcMs: () => clock.next() });
      // 既有数据逐字段保留（revision/标签/事件 sequence）。
      const projectAfter = await store.getProject(project.id);
      expect(projectAfter.displayName).toBe('升级前项目（改）');
      expect(projectAfter.revision).toBe(2);
      expect(projectAfter.labels).toEqual(['p01']);
      const globalAfter = await store.getGlobalSettings();
      expect(globalAfter).toEqual(globalSettings);
      const events = upgradedSession.database
        .prepare<[], { sequence: number; event_type: string }>(
          'SELECT sequence, event_type FROM state_events ORDER BY sequence',
        )
        .all();
      expect(events).toEqual([{ sequence: 1, event_type: 'project.metadata_updated' }]);

      // 回执端口在升级后的库上可用。
      const receiptStore = createSqliteCommandReceiptStore(upgradedSession, {
        nowUtcMs: () => clock.next(),
      });
      const receipt = makeCompletedReceipt();
      await receiptStore.saveReceipt(receipt);
      expect(await receiptStore.findReceiptByCommandId(receipt.principalId, receipt.commandId)).toEqual(receipt);
      upgradedSession.close();
    } finally {
      sandbox.cleanup();
    }
  });

  it('高版本库与 checksum 漂移继续拒写', async () => {
    const sandbox = createTempSandbox('shiploop-p02-2-f006-drift-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const session = openSqliteStorageSession({ path: dbPath });
      await migrateSqliteStorage(session);
      // 高版本：插入 v4 迁移记录。
      session.database
        .prepare('INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)')
        .run('migration-v4', 1, 4, DIGEST_HEX, 1);
      session.close();
      const highVersion = openSqliteStorageSession({ path: dbPath });
      let caught: unknown;
      try {
        await migrateSqliteStorage(highVersion);
      } catch (error) {
        caught = error;
      }
      highVersion.close();
      expect(isStorageError(caught, 'unsupported_version'), `实际 ${String(caught)}`).toBe(true);

      // checksum 漂移：篡改 v3 记录。
      const driftPath = join(sandbox.path, 'drift.db');
      const driftBase = openSqliteStorageSession({ path: driftPath });
      await migrateSqliteStorage(driftBase);
      driftBase.database
        .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 3')
        .run(OTHER_DIGEST_HEX);
      driftBase.close();
      const drifted = openSqliteStorageSession({ path: driftPath });
      let driftError: unknown;
      try {
        await migrateSqliteStorage(drifted);
      } catch (error) {
        driftError = error;
      }
      drifted.close();
      expect(isStorageError(driftError, 'corrupt'), `实际 ${String(driftError)}`).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * CommandReceiptsService：授权回执读取与结果引用解析
 * ------------------------------------------------------------------ */

describe('F-006 CommandReceiptsService（授权回执/结果读取）', () => {
  it('local-owner 读取自己的回执；未知 commandId/非法形态明确失败', async () => {
    await withMigratedDb(async ({ receipts, receiptStore }) => {
      const owner = createProductLocalOwnerPrincipal();
      const receipt = makeCompletedReceipt();
      await receiptStore.saveReceipt(receipt);
      expect(await receipts.getReceipt(owner, receipt.commandId)).toEqual(receipt);
      await expectPublicError('not_found', () => receipts.getReceipt(owner, randomUUID()), 'receipt_not_found');
      await expectPublicError('invalid_input', () => receipts.getReceipt(owner, 'not-a-uuid'));
    });
  });

  it('跨身份读取结构性 not_found；无 receipts.read 能力 forbidden', async () => {
    await withMigratedDb(async ({ receipts, receiptStore }) => {
      const receipt = makeCompletedReceipt({ principalId: 'local-owner' });
      await receiptStore.saveReceipt(receipt);
      const stranger = createRestrictedPrincipal({
        capabilities: ['receipts.read'],
        projectScope: { kind: 'all' },
      });
      // 他人 commandId：不区分不存在与无权。
      await expectPublicError('not_found', () => receipts.getReceipt(stranger, receipt.commandId), 'receipt_not_found');
      await expectPublicError('not_found', () => receipts.resolveResult(stranger, receipt.resultRef), 'receipt_not_found');
      const noCapability = createRestrictedPrincipal({
        capabilities: ['project.read'],
        projectScope: { kind: 'all' },
      });
      await expectPublicError('forbidden', () => receipts.getReceipt(noCapability, receipt.commandId));
      await expectPublicError('forbidden', () => receipts.resolveResult(noCapability, receipt.resultRef));
    });
  });

  it('项目 scope 回执按当前可见范围核验；注册回执核验新建项目可见性', async () => {
    await withMigratedDb(async ({ receipts, receiptStore, stateStore }) => {
      const projectA = await stateStore.createProject({ displayName: '项目 A' });
      const projectB = await stateStore.createProject({ displayName: '项目 B' });
      const restrictedId = `test-restricted:${randomUUID()}`;
      const restrictedToB = createRestrictedPrincipal({
        capabilities: ['receipts.read'],
        projectScope: { kind: 'allowlist', projectIds: [projectB.id] },
        principalId: restrictedId,
      });
      const restrictedToA = createRestrictedPrincipal({
        capabilities: ['receipts.read'],
        projectScope: { kind: 'allowlist', projectIds: [projectA.id] },
        principalId: restrictedId,
      });

      // 回执归属同一受限主体；目标项目 A 对其当前范围不可见 → not_found。
      const projectReceipt = makeCompletedReceipt({
        principalId: restrictedId,
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: projectA.id },
        result: { project: { id: projectA.id, revision: 2 } },
      });
      await receiptStore.saveReceipt(projectReceipt);
      expect(await receipts.getReceipt(restrictedToA, projectReceipt.commandId)).toEqual(projectReceipt);
      // 目标项目不可见 → not_found（不回显存在性）。
      await expectPublicError('not_found', () => receipts.getReceipt(restrictedToB, projectReceipt.commandId), 'receipt_not_found');

      // 注册回执：completed 结果内的新建项目当前可见性重核。
      const registration = makeCompletedReceipt({
        principalId: restrictedId,
        result: { status: 'registered', project: { id: projectA.id }, binding: { id: 'b' } },
      });
      await receiptStore.saveReceipt(registration);
      expect(await receipts.getReceipt(restrictedToA, registration.commandId)).toEqual(registration);
      await expectPublicError('not_found', () => receipts.getReceipt(restrictedToB, registration.commandId), 'receipt_not_found');
      await expectPublicError('not_found', () => receipts.resolveResult(restrictedToB, registration.resultRef), 'receipt_not_found');
      expect(await receipts.resolveResult(restrictedToA, registration.resultRef)).toEqual(registration);

      // rejected 注册回执无项目实体：仅归属核验（拥有者可读）。
      const rejected = makeRejectedReceipt();
      await receiptStore.saveReceipt(rejected);
      expect(await receipts.getReceipt(createProductLocalOwnerPrincipal(), rejected.commandId)).toEqual(rejected);
    });
  });

  it('completed 注册回执结果形状损坏 → corrupt_state（不跳过可见性核验）', async () => {
    await withMigratedDb(async ({ receipts, receiptStore }) => {
      const malformed = makeCompletedReceipt({ result: { status: 'registered' } });
      await receiptStore.saveReceipt(malformed);
      await expectPublicError('corrupt_state', () =>
        receipts.getReceipt(createProductLocalOwnerPrincipal(), malformed.commandId),
      );
    });
  });

  it('resultRef 解析返回固化结果：项目后续修改不改变该次结果；伪引用一律拒绝', async () => {
    await withMigratedDb(async ({ receipts, receiptStore, stateStore }) => {
      const owner = createProductLocalOwnerPrincipal();
      const project = await stateStore.createProject({ displayName: '固化前名称' });
      const receipt = makeCompletedReceipt({
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: project.id },
        result: { project: { id: project.id, revision: 2, displayName: '固化前名称' } },
      });
      await receiptStore.saveReceipt(receipt);

      // 项目后续被编辑：解析结果仍是提交时固化的内容。
      await stateStore.updateProject(project.id, { expectedRevision: 1, displayName: '后来的名称' });
      const resolved = await receipts.resolveResult(owner, receipt.resultRef);
      expect(resolved.status).toBe('completed');
      if (resolved.status === 'completed') {
        expect(resolved.result).toEqual({ project: { id: project.id, revision: 2, displayName: '固化前名称' } });
      }
      const current = await stateStore.getProject(project.id);
      expect(current.displayName).toBe('后来的名称');

      // 伪造/路径形态/未知引用：非法形态 invalid_input，未知引用 not_found。
      await expectPublicError('invalid_input', () => receipts.resolveResult(owner, '/etc/passwd'));
      await expectPublicError('invalid_input', () => receipts.resolveResult(owner, 'v1.short'));
      await expectPublicError('not_found', () => receipts.resolveResult(owner, RESULT_REF), 'receipt_not_found');
    });
  });
});

/* ------------------------------------------------------------------ *
 * 受控装配
 * ------------------------------------------------------------------ */

describe('F-006 受控装配（openCoreApplication）', () => {
  it('装配暴露 commandReceiptStore/commandReceiptsService；空库回执读取为 not_found', async () => {
    const fixture = createCommandsTestFixture();
    try {
      const app = await fixture.openApplication();
      expect(typeof app.commandReceiptStore.saveReceipt).toBe('function');
      expect(typeof app.commandReceiptsService.getReceipt).toBe('function');
      await expectPublicError('not_found', () =>
        app.commandReceiptsService.getReceipt(fixture.localOwner(), randomUUID()),
      );
      app.close();
    } finally {
      fixture.cleanup();
    }
  });
});
