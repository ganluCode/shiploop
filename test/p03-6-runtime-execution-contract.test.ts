/**
 * P03-6 / F-001 异步 Runtime 执行契约测试（请求/事件/结果/停止证据校验 + 可信注册）。
 *
 * 验收依据：
 * - RuntimeRequest 固定 Project/Feature/Run/Task/Attempt/Session、owner/hostInstanceId、
 *   executionVersion、完整实际策略、prompt/inputManifest 引用、受控 cwd、权限与
 *   有限超时/输出政策；恢复选择沿用 P03-3A 契约，不重建第二套；
 * - 请求、描述符、事件、结果和停止证据均有运行时校验及明确版本；未知终态拒绝为
 *   protocol 错误；未知公开事件保留受限诊断；缺少退出码/信号/用量/耗时为 null；
 * - 错误分类至少区分配置、缺 Runtime、权限、协议、进程、超时、认证、供应商及
 *   真实限流；信息型限流告警（rate_limit_notice 警告事件）不是硬限流错误；
 * - 可信注册沿用 RuntimeCapabilityCatalog 的稳定 ID 静态解析：重复/未知 ID、
 *   契约版本不兼容、provider/model 与目录不一致、适配器模块路径/热加载形态均拒绝，
 *   不默认 Claude/Pi。
 */
import { describe, expect, it } from 'vitest';
import {
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRegistry,
  classifyRuntimeEvent,
  isRuntimeError,
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RUNTIME_ERROR_KINDS,
  RUNTIME_EVENT_KINDS,
  RUNTIME_EXECUTION_SCHEMA_VERSION,
  RUNTIME_TERMINAL_STATES,
  RUNTIME_WARNING_CODES,
  RuntimeError,
  validateRuntimeAdapterDescriptor,
  validateRuntimeCancelReceipt,
  validateRuntimeEvent,
  validateRuntimeExecutionRequest,
  validateRuntimeExecutionResult,
  validateRuntimeStopEvidence,
} from '../packages/core/src/index.ts';

const digest = 'a'.repeat(64);

function inputRef(purpose: string) {
  return {
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'application/json', origin: { kind: 'artifact' },
  };
}

function validRequest() {
  return {
    schemaVersion: RUNTIME_EXECUTION_SCHEMA_VERSION,
    projectId: 'project-1',
    featureId: 'feature-1',
    sessionId: 'session-1',
    executionVersion: 1,
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1',
    strategy: { runtime: 'fake', provider: 'provider', model: 'model' },
    prompt: inputRef('prompt'),
    inputManifest: inputRef('manifest'),
    cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.write', 'process.exec'], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 },
    recovery: { mode: 'new' },
  };
}

function recoverySource() {
  return {
    schemaVersion: 1, purpose: 'work', kind: 'conversation', sourceProjectId: 'project-1',
    sourceSessionId: 'session-old', sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old',
    runtime: 'fake', provider: 'provider', model: 'model', providerSessionId: 'native-1',
    nativeArchiveRef: 'artifact-native', nativeFormat: 'synthetic-json',
    nativeFormatVersion: '1', sourceDigest: digest,
  };
}

const ts = '2026-10-15T00:00:00.000Z';

function validEvent() {
  return {
    schemaVersion: 1, eventId: 'event-1', kind: 'message', sequence: 1, occurredAtUtc: ts,
    payload: { messageId: 'message-1', role: 'assistant', preview: 'hello' },
  };
}

function validResult() {
  return {
    schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
    durationMs: 1234, usage: { basis: 'synthetic', inputTokens: 10, outputTokens: 5, costUsdMicros: null },
    lastEventSequence: 2,
  };
}

function configuration() {
  return createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'provider', models: ['model'] }] },
  ]);
}

function fakeDescriptor() {
  return {
    schemaVersion: 1, runtimeId: 'fake', contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterVersion: '1.0', providers: [{ providerId: 'provider', models: ['model'] }],
    permissionGrants: ['fs.write', 'process.exec'], isolationModes: ['trusted_project'],
  };
}

function fakeAdapter() {
  return { start: async () => { throw new Error('not used in contract tests'); } };
}

describe('F-001 RuntimeRequest 校验（固定身份/策略/引用/受控 cwd/有限政策）', () => {
  it('接受合法请求并返回与调用方对象分离的结果', () => {
    const request = validRequest();
    const validated = validateRuntimeExecutionRequest(request);
    expect(validated.projectId).toBe('project-1');
    expect(validated.identity).toEqual({ purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' });
    expect(validated.recovery).toEqual({ mode: 'new' });
    (request.strategy as { model: string }).model = 'mutated';
    (request.permissions.grants as string[]).push('kernel');
    expect(validated.strategy.model).toBe('model');
    expect(validated.permissions.grants).toEqual(['fs.write', 'process.exec']);
  });
  it('拒绝未知键、缺字段、错误 schemaVersion 与非法 executionVersion', () => {
    expect(() => validateRuntimeExecutionRequest({ ...validRequest(), extra: true }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    const missing = validRequest() as Record<string, unknown>;
    delete missing.featureId;
    expect(() => validateRuntimeExecutionRequest(missing))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRuntimeExecutionRequest({ ...validRequest(), schemaVersion: 2 }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRuntimeExecutionRequest({ ...validRequest(), executionVersion: 0 }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
  it('要求 Work 身份与 owner/hostInstanceId，Chat 身份不在本阶段执行请求中', () => {
    expect(() => validateRuntimeExecutionRequest({
      ...validRequest(), identity: { purpose: 'chat', sessionId: 'session-1', turnId: 'turn-1' },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    const noHost = validRequest();
    (noHost.owner as Record<string, unknown>) = { principalId: 'principal-1' };
    expect(() => validateRuntimeExecutionRequest(noHost))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
  it('沿用 P03-3A 恢复选择校验：required 缺来源拒绝，来源 kind 不匹配拒绝', () => {
    expect(() => validateRuntimeExecutionRequest({
      ...validRequest(), recovery: { mode: 'required', kind: 'conversation' },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRuntimeExecutionRequest({
      ...validRequest(), recovery: { mode: 'auto', kind: 'checkpoint', source: recoverySource() },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    const resumed = validateRuntimeExecutionRequest({
      ...validRequest(), executionVersion: 2, invocationId: 'invocation-2',
      identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-2' },
      recovery: { mode: 'required', kind: 'conversation', source: recoverySource() },
    });
    expect(resumed.recovery.mode).toBe('required');
  });
  it('prompt/inputManifest 必须是合法不可变引用（摘要/版本非法拒绝）', () => {
    const bad = validRequest();
    bad.prompt = { ...inputRef('prompt'), contentHash: 'not-a-digest' };
    expect(() => validateRuntimeExecutionRequest(bad))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    const badVersion = validRequest();
    badVersion.inputManifest = { ...inputRef('manifest'), version: 0 };
    expect(() => validateRuntimeExecutionRequest(badVersion))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
  it('受控 cwd：只允许获准根 ID + 相对位置，绝对路径/穿越拒绝', () => {
    for (const relativePath of ['..', '/abs/path', 'a/../b', 'C:\\temp']) {
      expect(() => validateRuntimeExecutionRequest({
        ...validRequest(), cwd: { root: 'workspace', relativePath },
      })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    }
    expect(validateRuntimeExecutionRequest({
      ...validRequest(), cwd: { root: 'workspace', relativePath: 'sub/dir' },
    }).cwd.relativePath).toBe('sub/dir');
  });
  it('有限超时/输出政策：越界一律拒绝，不静默截断', () => {
    for (const limits of [
      { timeoutMs: 0, maxEvents: 10, maxOutputBytes: 10 },
      { timeoutMs: 86_400_001, maxEvents: 10, maxOutputBytes: 10 },
      { timeoutMs: 1000, maxEvents: 0, maxOutputBytes: 10 },
      { timeoutMs: 1000, maxEvents: 100_001, maxOutputBytes: 10 },
      { timeoutMs: 1000, maxEvents: 10, maxOutputBytes: 0 },
      { timeoutMs: 1000, maxEvents: 10, maxOutputBytes: 8_388_609 },
    ]) {
      expect(() => validateRuntimeExecutionRequest({ ...validRequest(), limits }))
        .toThrowError(expect.objectContaining({ kind: 'validation' }));
    }
  });
  it('权限政策：grants 必须有界字符串，isolation 必须是非空 token', () => {
    expect(() => validateRuntimeExecutionRequest({
      ...validRequest(), permissions: { grants: ['fs.write', 7], isolation: 'trusted_project' },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRuntimeExecutionRequest({
      ...validRequest(), permissions: { grants: [], isolation: '' },
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
});

describe('F-001 事件/结果/停止证据/取消回执校验与版本', () => {
  it('公开事件白名单：六种已知 kind 均可校验，缺身份/序列/时间拒绝', () => {
    expect([...RUNTIME_EVENT_KINDS].sort()).toEqual(
      ['diagnostic', 'message', 'tool_finished', 'tool_started', 'usage', 'warning'],
    );
    expect(validateRuntimeEvent(validEvent()).kind).toBe('message');
    expect(validateRuntimeEvent({
      ...validEvent(), kind: 'tool_started', payload: { toolCallId: 'call-1', toolName: 'shell' },
    }).kind).toBe('tool_started');
    expect(validateRuntimeEvent({
      ...validEvent(), kind: 'tool_finished',
      payload: { toolCallId: 'call-1', exitCode: null, signal: 'SIGTERM' },
    }).kind).toBe('tool_finished');
    expect(validateRuntimeEvent({
      ...validEvent(), kind: 'usage',
      payload: { basis: 'synthetic', inputTokens: null, outputTokens: null, costUsdMicros: null },
    }).kind).toBe('usage');
    expect(() => validateRuntimeEvent({ ...validEvent(), eventId: '' })).toThrowError(
      expect.objectContaining({ kind: 'protocol' }));
    expect(() => validateRuntimeEvent({ ...validEvent(), sequence: 0 })).toThrowError(
      expect.objectContaining({ kind: 'protocol' }));
    expect(() => validateRuntimeEvent({ ...validEvent(), occurredAtUtc: 'not-a-date' })).toThrowError(
      expect.objectContaining({ kind: 'protocol' }));
  });
  it('未知公开事件分类为 unknown（保留受限诊断素材），畸形事件为 invalid', () => {
    const unknown = classifyRuntimeEvent({ ...validEvent(), kind: 'vendor_metric', payload: { huge: 'x' } });
    expect(unknown).toEqual({ outcome: 'unknown', observedKind: 'vendor_metric' });
    expect(classifyRuntimeEvent({ ...validEvent(), sequence: -1 }).outcome).toBe('invalid');
    expect(classifyRuntimeEvent('not-an-object').outcome).toBe('invalid');
    expect(classifyRuntimeEvent({ ...validEvent(), schemaVersion: 9 }).outcome).toBe('invalid');
  });
  it('信息型限流告警是 warning 事件而不是硬限流错误', () => {
    expect(RUNTIME_WARNING_CODES).toContain('rate_limit_notice');
    const warning = validateRuntimeEvent({
      ...validEvent(), kind: 'warning', payload: { code: 'rate_limit_notice', message: 'provider nearing limit' },
    });
    expect(warning.kind).toBe('warning');
    expect(RUNTIME_ERROR_KINDS).toContain('rate_limited');
  });
  it('终态白名单：四种已知终态，未知终态拒绝为 protocol 错误', () => {
    expect([...RUNTIME_TERMINAL_STATES].sort()).toEqual(['cancelled', 'completed', 'failed', 'timed_out']);
    for (const terminal of RUNTIME_TERMINAL_STATES) {
      expect(validateRuntimeExecutionResult({ ...validResult(), terminal }).terminal).toBe(terminal);
    }
    expect(() => validateRuntimeExecutionResult({ ...validResult(), terminal: 'exploded' })).toThrowError(
      expect.objectContaining({ kind: 'protocol', reason: 'unknown_terminal' }));
  });
  it('缺少退出码/信号/用量/耗时必须为 null；键缺席或非 null 非法值拒绝', () => {
    const minimal = validateRuntimeExecutionResult({
      schemaVersion: 1, terminal: 'failed', reason: 'adapter_crashed', exitCode: null,
      signal: null, durationMs: null, usage: null, lastEventSequence: null,
    });
    expect(minimal.exitCode).toBeNull();
    expect(minimal.usage).toBeNull();
    expect(minimal.durationMs).toBeNull();
    const missing = validResult() as Record<string, unknown>;
    delete missing.exitCode;
    expect(() => validateRuntimeExecutionResult(missing)).toThrowError(
      expect.objectContaining({ kind: 'protocol' }));
    expect(() => validateRuntimeExecutionResult({
      ...validResult(), usage: { basis: 'synthetic', inputTokens: -1, outputTokens: 0, costUsdMicros: null },
    })).toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => validateRuntimeExecutionResult({ ...validResult(), schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ kind: 'protocol' }));
  });
  it('停止证据与取消回执：结构校验，confirmed/accepted 必须为显式布尔', () => {
    expect(validateRuntimeStopEvidence({
      schemaVersion: 1, confirmed: true, checkedAtUtc: ts, detail: null,
    }).confirmed).toBe(true);
    expect(validateRuntimeStopEvidence({
      schemaVersion: 1, confirmed: false, checkedAtUtc: ts, detail: 'child still alive',
    }).confirmed).toBe(false);
    expect(() => validateRuntimeStopEvidence({ schemaVersion: 1, confirmed: 'yes', checkedAtUtc: ts, detail: null }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(() => validateRuntimeStopEvidence({ schemaVersion: 1, confirmed: true, detail: null }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
    expect(validateRuntimeCancelReceipt({ accepted: true, reason: null }).accepted).toBe(true);
    expect(validateRuntimeCancelReceipt({ accepted: false, reason: 'already_finished' }).accepted).toBe(false);
    expect(() => validateRuntimeCancelReceipt({ accepted: 'true', reason: null }))
      .toThrowError(expect.objectContaining({ kind: 'protocol' }));
  });
  it('错误分类固定为九类：配置/缺 Runtime/权限/协议/进程/超时/认证/供应商/真实限流', () => {
    expect([...RUNTIME_ERROR_KINDS].sort()).toEqual([
      'authentication', 'configuration', 'missing_runtime', 'permission',
      'process', 'protocol', 'provider', 'rate_limited', 'timeout',
    ]);
    const error = new RuntimeError('protocol', 'unknown_terminal');
    expect(isRuntimeError(error, 'protocol')).toBe(true);
    expect(isRuntimeError(error, 'timeout')).toBe(false);
    expect(isRuntimeError(new Error('x'))).toBe(false);
  });
});

describe('F-001 适配器描述符与可信静态注册', () => {
  it('描述符校验：未知键/空 runtimeId/非法契约版本/重复权限授予拒绝', () => {
    expect(validateRuntimeAdapterDescriptor(fakeDescriptor()).runtimeId).toBe('fake');
    expect(() => validateRuntimeAdapterDescriptor({ ...fakeDescriptor(), extra: 1 })).toThrowError(
      expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRuntimeAdapterDescriptor({
      ...fakeDescriptor(), permissionGrants: ['fs.write', 'fs.write'],
    })).toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateRuntimeAdapterDescriptor({ ...fakeDescriptor(), runtimeId: '' })).toThrowError(
      expect.objectContaining({ kind: 'validation' }));
  });
  it('与配置目录一致的注册可解析；解析结果包含描述符与适配器', () => {
    const adapter = fakeAdapter();
    const registry = createStaticRuntimeRegistry(
      [{ descriptor: fakeDescriptor(), adapter }], configuration());
    const resolved = registry.resolve('fake');
    expect(resolved?.descriptor.runtimeId).toBe('fake');
    expect(resolved?.adapter).toBe(adapter);
    expect(registry.resolve('ghost')).toBeUndefined();
  });
  it('重复/未知 runtime ID 拒绝，不默认 Claude/Pi', () => {
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: fakeDescriptor(), adapter: fakeAdapter() },
       { descriptor: fakeDescriptor(), adapter: fakeAdapter() }], configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'duplicate_runtime_id' }) }));
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: { ...fakeDescriptor(), runtimeId: 'claude' }, adapter: fakeAdapter() }], configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'unknown_runtime' }) }));
    expect(createStaticRuntimeRegistry([], configuration()).resolve('claude')).toBeUndefined();
  });
  it('契约版本不兼容拒绝', () => {
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: { ...fakeDescriptor(), contractVersion: 99 }, adapter: fakeAdapter() }], configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'contract_version_incompatible' }) }));
  });
  it('provider/model 与配置目录不一致拒绝', () => {
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: { ...fakeDescriptor(), providers: [{ providerId: 'other' }] }, adapter: fakeAdapter() }],
      configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'provider_mismatch' }) }));
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: { ...fakeDescriptor(), providers: [{ providerId: 'provider', models: ['model', 'extra'] }] },
        adapter: fakeAdapter() }], configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'provider_mismatch' }) }));
  });
  it('适配器必须是注入对象：模块路径/脚本字符串与缺 start 拒绝（不热加载）', () => {
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: fakeDescriptor(), adapter: './node_modules/fake-runtime/index.js' }], configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'adapter_must_be_injected' }) }));
    expect(() => createStaticRuntimeRegistry(
      [{ descriptor: fakeDescriptor(), adapter: {} }], configuration()),
    ).toThrowError(expect.objectContaining({ kind: 'validation',
      details: expect.objectContaining({ reason: 'adapter_must_be_injected' }) }));
    expect(() => createStaticRuntimeRegistry('not-an-array', configuration())).toThrowError(
      expect.objectContaining({ kind: 'validation' }));
  });
});
