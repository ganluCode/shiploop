/**
 * F-004 P04-8 运行时访问故障矩阵（确定性离线库，不依赖模型与网络）。
 *
 * 三个矩阵组分别通过前序 P04 Feature 的公开接口组合：
 * - `runAdapterAccessFaults`：Pi 适配器启动边界（SDK 缺失、认证拒绝、
 *   资源未授权、越权工具、未获准 provider/model/凭据/临时项目）。每个场景
 *   在独立临时沙箱内用受控 assembly 与可观测 sessionFactory 执行；zero-call
 *   证据以会话工厂调用与模型请求（prompt）计数落盘。
 * - `runRetryBoundaryFaults`：Core 同 Attempt 请求重试控制器与备用策略
 *   决策的纯边界（限流/连接/服务端/协议/工具超时/绝对 deadline/累计故障）。
 * - `runCoreAccessFaults`：真实 SQLite Core（openCoreApplication + Fake
 *   Runtime）上的认证/限流/协议/预算场景，收集 attempts、runtime-settlement
 *   回执、runs、预算计数、工作区租约与实际文件副作用。
 *
 * 本文件是测试库（helpers），不是测试入口；不接触凭据、真实网络或模型。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempSandbox } from '../temp-sandbox.ts';
import { openCoreApplication, type WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { classifyRuntimeFailure, type RuntimeFailureCategory } from '../../../packages/core/src/ports/runtime-failure.ts';
import {
  isRuntimeError,
  RuntimeError,
  validateRuntimeExecutionRequest,
  type RuntimeExecutionRequest,
  type RuntimeWorkAccessSnapshot,
} from '../../../packages/core/src/ports/runtime-execution.ts';
import { createRuntimeRequestRetryController } from '../../../packages/core/src/application/runtime-request-retry.ts';
import { decideRuntimeFallback, validateRuntimeFallbackPlan } from '../../../packages/core/src/application/runtime-fallback.ts';
import { createPiRuntimeAdapter, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { BINDING_NOW, openBindingFixture } from '../p03-6/input-binding-fixture.ts';

export const ACCESS_FAULT_MATRIX_SCHEMA_VERSION = 1 as const;

export const ACCESS_FAULT_MATRIX_IDS = Object.freeze({
  adapter: Object.freeze([
    'sdk-missing', 'authentication-expired', 'authentication-drift', 'credential-source-missing',
    'resource-unauthorized', 'tool-grant-unauthorized', 'provider-unapproved', 'model-unapproved',
    'workspace-missing',
  ] as const),
  retry: Object.freeze([
    'rate-limit-429', 'connection-reset', 'server-503', 'protocol-invalid',
    'tool-timeout-uncertain', 'tool-timeout-known-safe', 'deadline-before-request', 'deadline-during-backoff',
  ] as const),
  core: Object.freeze([
    'core-authentication-refusal', 'core-quota-fallback', 'core-protocol-refusal', 'core-budget-zero-call',
  ] as const),
});

export interface AccessFaultMatrixEvidenceOptions {
  /** 可选证据目录；提供时每组矩阵写入一个 JSON 文件供阶段报告引用。 */
  readonly evidenceDir?: string;
}

/* ------------------------------------------------------------------ *
 * 适配器启动边界矩阵
 * ------------------------------------------------------------------ */

export interface AdapterFaultObservation {
  readonly scenarioId: string;
  readonly fault: string;
  readonly requestedStrategy: { readonly runtime: string; readonly provider: string; readonly model: string };
  readonly rejected: boolean;
  readonly errorKind: string | null;
  readonly errorReason: string | null;
  /** Core 分类投影（classifyRuntimeFailure 对受控错误的映射）。 */
  readonly category: string | null;
  readonly settlementKind: string | null;
  readonly sessionFactoryCalls: number;
  readonly promptCalls: number;
  readonly sessionStrategies: readonly { readonly provider: string; readonly model: string }[];
  /** 离线 zero-call 证据：没有任何模型请求被发出。 */
  readonly zeroModelCalls: boolean;
}

interface AdapterScenarioBuild {
  readonly providers?: readonly { providerId: string; models: readonly string[] }[];
  readonly permissionGrants?: readonly string[];
  readonly request: RuntimeExecutionRequest;
  readonly assembly: PiTrustedAssembly;
}

interface AdapterScenarioDefinition {
  readonly id: string;
  readonly fault: string;
  readonly sessionFactoryThrows?: boolean;
  readonly build: (base: AdapterBase) => AdapterScenarioBuild;
}

interface AdapterBase {
  readonly sandboxPath: string;
  readonly snapshot: RuntimeWorkAccessSnapshot;
  readonly request: (overrides?: Record<string, unknown>) => RuntimeExecutionRequest;
  readonly assembly: (overrides?: {
    /** null 表示显式移除该可选装配项。 */
    readonly prepareAccess?: PiTrustedAssembly['prepareAccess'] | null;
    readonly credentialRef?: PiTrustedAssembly['credentialRef'] | null;
    readonly resolveWorkingDirectory?: PiTrustedAssembly['resolveWorkingDirectory'];
  }) => PiTrustedAssembly;
}

const MATRIX_STRATEGY = { runtime: 'pi', provider: 'matrix-provider', model: 'matrix-model-a' } as const;
const MATRIX_BACKUP_MODEL = 'matrix-model-b';
const MATRIX_DIGEST = createHash('sha256').update('p04-8-access-fault-matrix').digest('hex');
const MATRIX_UUID = '55555555-5555-4555-8555-555555555555';

function matrixSnapshot(overrides: Record<string, unknown> = {}): RuntimeWorkAccessSnapshot {
  const snapshot = {
    schemaVersion: 1 as const,
    projectId: 'project-1', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1',
    invocationId: 'invocation-1', executionVersion: 1,
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    strategy: { ...MATRIX_STRATEGY },
    permissions: { grants: [], isolation: 'trusted_project' },
    grantId: MATRIX_UUID,
    policyDigest: MATRIX_DIGEST,
    authentication: { status: 'ready' as const, digest: MATRIX_DIGEST, sourceRef: MATRIX_UUID, kind: 'environment' as const },
    resources: {
      digest: MATRIX_DIGEST,
      entries: [{
        id: MATRIX_UUID, kind: 'tool' as const, sourceRef: MATRIX_UUID, version: '1.0.0', contentDigest: MATRIX_DIGEST,
        status: 'available' as const, capabilities: ['tool_interception'], transport: null,
      }],
    },
    ...overrides,
  };
  return snapshot as RuntimeWorkAccessSnapshot;
}


function adapterBase(sandboxPath: string): AdapterBase {
  const snapshot = matrixSnapshot();
  const inputRef = (purpose: string) => ({
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input' as const, purpose,
    version: 1, contentHash: MATRIX_DIGEST, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain', origin: { kind: 'artifact' as const },
  });
  const request = (overrides: Record<string, unknown> = {}): RuntimeExecutionRequest => {
    // workAccess 快照必须与请求策略一致；策略覆盖时同步重建快照，
    // 除非场景显式提供（或显式移除）workAccess。
    const strategyOverride = overrides.strategy as { runtime: string; provider: string; model: string } | undefined;
    const workAccess = 'workAccess' in overrides
      ? overrides.workAccess
      : strategyOverride === undefined ? snapshot : matrixSnapshot({ strategy: strategyOverride });
    return validateRuntimeExecutionRequest({
      schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1', executionVersion: 1,
      owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
      identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
      invocationId: 'invocation-1', strategy: strategyOverride ?? { ...MATRIX_STRATEGY },
      prompt: inputRef('prompt'), inputManifest: inputRef('manifest'),
      cwd: { root: 'workspace', relativePath: '.' },
      permissions: { grants: [], isolation: 'trusted_project' },
      limits: { timeoutMs: 1_000, maxEvents: 20, maxOutputBytes: 10_000 },
      recovery: { mode: 'new' }, workAccess, ...overrides,
    } as RuntimeExecutionRequest);
  };
  const assembly = (overrides: {
    /** null 表示显式移除该可选装配项。 */
    readonly prepareAccess?: PiTrustedAssembly['prepareAccess'] | null;
    readonly credentialRef?: PiTrustedAssembly['credentialRef'] | null;
    readonly resolveWorkingDirectory?: PiTrustedAssembly['resolveWorkingDirectory'];
  } = {}): PiTrustedAssembly => {
    const defaultPrepare = async () => ({
      snapshot, credentialRef: { kind: 'trusted-resolution' as const, id: 'matrix-credential' },
      resourceLoader: {} as never,
    });
    const credential = overrides.credentialRef === undefined
      ? { kind: 'trusted-resolution' as const, id: 'matrix-credential' }
      : overrides.credentialRef;
    const prepare = overrides.prepareAccess === undefined ? defaultPrepare : overrides.prepareAccess;
    return {
      agentDir: sandboxPath,
      resolveWorkingDirectory: overrides.resolveWorkingDirectory ?? (() => sandboxPath),
      inputReader: { read: async () => 'controlled prompt' },
      resourceLoader: {} as never,
      ...(credential === null ? {} : { credentialRef: credential }),
      ...(prepare === null ? {} : { prepareAccess: prepare }),
    };
  };
  return { sandboxPath, snapshot, request, assembly };
}

const ADAPTER_SCENARIOS: readonly AdapterScenarioDefinition[] = Object.freeze([
  Object.freeze({
    id: 'sdk-missing',
    fault: 'SDK 包缺失（模块导入失败）',
    sessionFactoryThrows: true,
    build: (base: AdapterBase) => ({ request: base.request(), assembly: base.assembly() }),
  }),
  Object.freeze({
    id: 'authentication-expired',
    fault: '认证预检过期（authentication 非 ready）',
    build: (base: AdapterBase) => ({
      request: base.request(),
      assembly: base.assembly({
        prepareAccess: async () => ({
          snapshot: matrixSnapshot({ authentication: { status: 'expired', digest: MATRIX_DIGEST, sourceRef: MATRIX_UUID, kind: 'environment' } }),
          credentialRef: { kind: 'trusted-resolution', id: 'matrix-credential' },
          resourceLoader: {} as never,
        }),
      }),
    }),
  }),
  Object.freeze({
    id: 'authentication-drift',
    fault: '装配快照与 Attempt 绑定的授权快照不一致',
    build: (base: AdapterBase) => ({
      request: base.request(),
      assembly: base.assembly({
        prepareAccess: async () => ({
          snapshot: matrixSnapshot({ policyDigest: createHash('sha256').update('drift').digest('hex') }),
          credentialRef: { kind: 'trusted-resolution', id: 'matrix-credential' },
          resourceLoader: {} as never,
        }),
      }),
    }),
  }),
  Object.freeze({
    id: 'credential-source-missing',
    fault: '没有可信凭据来源（credentialRef 缺失）',
    build: (base: AdapterBase) => ({
      request: base.request({ workAccess: undefined }),
      assembly: base.assembly({ prepareAccess: null, credentialRef: null }),
    }),
  }),
  Object.freeze({
    id: 'resource-unauthorized',
    fault: '批准资源清单中的工具未获授权（omitted）',
    build: (base: AdapterBase) => {
      const omitted = matrixSnapshot({
        resources: {
          digest: MATRIX_DIGEST,
          entries: [{
            id: MATRIX_UUID, kind: 'tool', sourceRef: MATRIX_UUID, version: '1.0.0', contentDigest: MATRIX_DIGEST,
            status: 'omitted', capabilities: ['tool_interception'], transport: null,
          }],
        },
      });
      return {
        request: base.request({ workAccess: omitted }),
        assembly: base.assembly({
          prepareAccess: async () => ({
            snapshot: omitted, credentialRef: { kind: 'trusted-resolution', id: 'matrix-credential' },
            resourceLoader: {} as never,
          }),
        }),
      };
    },
  }),
  Object.freeze({
    id: 'tool-grant-unauthorized',
    fault: '越权工具通道（描述符必需 grant 未获批准）',
    build: (base: AdapterBase) => ({
      providers: [{ providerId: MATRIX_STRATEGY.provider, models: [MATRIX_STRATEGY.model, MATRIX_BACKUP_MODEL] }],
      permissionGrants: ['tool:matrix.business-write'],
      request: base.request(),
      assembly: base.assembly(),
    }),
  }),
  Object.freeze({
    id: 'provider-unapproved',
    fault: '策略引用了未获准的厂商',
    build: (base: AdapterBase) => ({ request: base.request({ strategy: { ...MATRIX_STRATEGY, provider: 'other-vendor' } }), assembly: base.assembly() }),
  }),
  Object.freeze({
    id: 'model-unapproved',
    fault: '策略引用了未获准的模型',
    build: (base: AdapterBase) => ({ request: base.request({ strategy: { ...MATRIX_STRATEGY, model: 'unapproved-model' } }), assembly: base.assembly() }),
  }),
  Object.freeze({
    id: 'workspace-missing',
    fault: '没有获准的临时项目工作区',
    build: (base: AdapterBase) => ({
      request: base.request(),
      assembly: base.assembly({
        resolveWorkingDirectory: () => {
          throw new RuntimeError('permission', 'work_workspace_unavailable');
        },
      }),
    }),
  }),
] as const);

async function runAdapterScenario(
  definition: AdapterScenarioDefinition,
  prefix: string,
): Promise<AdapterFaultObservation> {
  const sandbox = createTempSandbox(`${prefix}adapter-`);
  try {
    const base = adapterBase(sandbox.path);
    const built = definition.build(base);
    const sessionStrategies: { provider: string; model: string }[] = [];
    let promptCalls = 0;
    const sessionFactory = async (options: { provider: string; model: string }) => {
      sessionStrategies.push({ provider: options.provider, model: options.model });
      if (definition.sessionFactoryThrows === true) {
        throw Object.assign(
          new Error(`Cannot find package '@earendil-works/pi-coding-agent' imported from ${sandbox.path}/runner.js`),
          { code: 'ERR_MODULE_NOT_FOUND' },
        );
      }
      return {
        subscribe: () => () => undefined,
        prompt: async () => {
          promptCalls += 1;
        },
        abort: async () => undefined,
        dispose: () => undefined,
      };
    };
    const registration = createPiRuntimeAdapter({
      providers: built.providers ?? [{ providerId: MATRIX_STRATEGY.provider, models: [MATRIX_STRATEGY.model, MATRIX_BACKUP_MODEL] }],
      permissionGrants: built.permissionGrants ?? [],
      isolationModes: ['trusted_project'],
      assembly: built.assembly,
      sessionFactory,
    });
    let rejected = false;
    let errorKind: string | null = null;
    let errorReason: string | null = null;
    try {
      await registration.adapter.start(built.request);
    } catch (error) {
      rejected = true;
      if (isRuntimeError(error)) {
        errorKind = error.kind;
        errorReason = error.reason;
      } else {
        errorReason = error instanceof Error ? error.name : 'unknown_error';
      }
    }
    const classification = errorKind === null || errorReason === null
      ? null
      : classifyRuntimeFailure({ existingRuntimeError: { kind: errorKind as never, reason: errorReason } });
    return {
      scenarioId: definition.id,
      fault: definition.fault,
      requestedStrategy: { ...built.request.strategy },
      rejected,
      errorKind,
      errorReason,
      category: classification?.category ?? null,
      settlementKind: classification?.settlementKind ?? null,
      sessionFactoryCalls: sessionStrategies.length,
      promptCalls,
      sessionStrategies: Object.freeze(sessionStrategies),
      zeroModelCalls: promptCalls === 0,
    };
  } finally {
    sandbox.cleanup();
  }
}

export async function runAdapterAccessFaults(
  options: AccessFaultMatrixEvidenceOptions = {},
): Promise<readonly AdapterFaultObservation[]> {
  const prefix = 'shiploop-p048-f004-';
  const observations: AdapterFaultObservation[] = [];
  for (const definition of ADAPTER_SCENARIOS) {
    observations.push(await runAdapterScenario(definition, prefix));
  }
  writeEvidence(options.evidenceDir, 'access-fault-matrix-adapter.json', {
    schemaVersion: ACCESS_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', observations,
  });
  return Object.freeze(observations);
}

/* ------------------------------------------------------------------ *
 * 同 Attempt 重试边界与备用策略矩阵
 * ------------------------------------------------------------------ */

export interface RetryFaultObservation {
  readonly scenarioId: string;
  readonly fault: string;
  readonly requests: number;
  readonly outcome: 'complete' | 'failed' | 'not-started';
  readonly stopReason: string | null;
  readonly counters: Readonly<Record<string, number>>;
}

export interface FallbackPolicyObservation {
  readonly unapprovedPlanRejected: boolean;
  readonly decisions: Readonly<Record<string, { mode: string; stopReason: string | null; model: string | null; source: string | null; previousFailures: readonly { category: string }[] }>>;
}

const RETRY_POLICY = Object.freeze({ maxRetries: 2, maxTotalRetries: 3, baseBackoffMs: 5, maxBackoffMs: 10 });

function retryHarness(policy: { maxRetries: number; maxTotalRetries: number; baseBackoffMs: number; maxBackoffMs: number }, deadlineOffsetMs: number) {
  const now = 1_000;
  const stopReasons: string[] = [];
  const controller = createRuntimeRequestRetryController({
    policy, deadlineUtcMs: now + deadlineOffsetMs, nowUtcMs: () => now,
    runnerAlive: () => true, wait: async () => undefined,
    observe: event => {
      if (event.kind === 'stop') stopReasons.push(event.stopReason ?? event.decision?.stopReason ?? 'unknown');
    },
  });
  return { controller, stopReasons, now };
}

type RetryOutcome = { value: string; failure?: { category: RuntimeFailureCategory; sideEffect?: 'none' | 'known_safe' | 'uncertain' } };

export async function runRetryBoundaryFaults(
  options: AccessFaultMatrixEvidenceOptions = {},
): Promise<{ readonly scenarios: readonly RetryFaultObservation[]; readonly fallback: FallbackPolicyObservation }> {
  const scenarios: RetryFaultObservation[] = [];

  const record = (scenarioId: string, fault: string, requests: number, outcome: RetryFaultObservation['outcome'],
    stopReasons: readonly string[], counters: Record<string, number>) => {
    scenarios.push({
      scenarioId, fault, requests, outcome,
      stopReason: stopReasons.length === 0 ? null : stopReasons[stopReasons.length - 1] ?? null,
      counters: Object.freeze({ ...counters }),
    });
  };

  {
    // 限流（quota_blocked）：信息为硬性额度阻断，不做同 Attempt 重试。
    const harness = retryHarness(RETRY_POLICY, 60_000);
    let requests = 0;
    const outcome = await harness.controller.execute(async (): Promise<RetryOutcome> => {
      requests += 1;
      return { value: 'failed-terminal', failure: { category: 'quota_blocked' } };
    });
    record('rate-limit-429', '限流/额度阻断（429）', requests, outcome === 'failed-terminal' ? 'failed' : 'complete',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 连接故障重试后恢复；累计故障只增不清，连续故障被有效成功重置。
    const harness = retryHarness(RETRY_POLICY, 60_000);
    let requests = 0;
    const failing = async (): Promise<RetryOutcome> => {
      requests += 1;
      return requests % 2 === 1
        ? { value: 'interrupted', failure: { category: 'transient_connection' } }
        : { value: 'complete' };
    };
    const first = await harness.controller.execute(failing);
    const second = await harness.controller.execute(failing);
    record('connection-reset', '连接中断（ECONNRESET）后恢复', requests,
      first === 'complete' && second === 'complete' ? 'complete' : 'failed',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 服务端故障耗尽重试上限。
    const harness = retryHarness(RETRY_POLICY, 60_000);
    let requests = 0;
    const outcome = await harness.controller.execute(async (): Promise<RetryOutcome> => {
      requests += 1;
      return { value: 'failed-terminal', failure: { category: 'transient_server' } };
    });
    record('server-503', '服务端 5xx 连续故障', requests, outcome === 'failed-terminal' ? 'failed' : 'complete',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 协议故障不可重试。
    const harness = retryHarness(RETRY_POLICY, 60_000);
    let requests = 0;
    const outcome = await harness.controller.execute(async (): Promise<RetryOutcome> => {
      requests += 1;
      return { value: 'failed-terminal', failure: { category: 'protocol' } };
    });
    record('protocol-invalid', '协议违规（无效响应结构）', requests, outcome === 'failed-terminal' ? 'failed' : 'complete',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 工具超时且副作用不确定：立即停止，不重放工具。
    const harness = retryHarness(RETRY_POLICY, 60_000);
    let requests = 0;
    const outcome = await harness.controller.execute(async (): Promise<RetryOutcome> => {
      requests += 1;
      return { value: 'failed-terminal', failure: { category: 'timeout', sideEffect: 'uncertain' } };
    });
    record('tool-timeout-uncertain', '工具超时（副作用不确定）', requests, outcome === 'failed-terminal' ? 'failed' : 'complete',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 工具超时且明确无副作用：允许在边界内重试并恢复。
    const harness = retryHarness(RETRY_POLICY, 60_000);
    let requests = 0;
    const outcome = await harness.controller.execute(async (): Promise<RetryOutcome> => {
      requests += 1;
      return requests < 3
        ? { value: 'interrupted', failure: { category: 'timeout', sideEffect: 'none' } }
        : { value: 'complete' };
    });
    record('tool-timeout-known-safe', '工具超时（已知无副作用）', requests, outcome === 'complete' ? 'complete' : 'failed',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 绝对 deadline 已到：不发起任何请求。
    const harness = retryHarness(RETRY_POLICY, 0);
    let requests = 0;
    let started = false;
    try {
      await harness.controller.execute(async (): Promise<RetryOutcome> => {
        requests += 1;
        return { value: 'complete' };
      });
      started = true;
    } catch {
      started = false;
    }
    record('deadline-before-request', '绝对 deadline 已到（请求前）', requests, started ? 'complete' : 'not-started',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }
  {
    // 退避等待会跨过绝对 deadline：不再开始下一次重试。
    const harness = retryHarness({ ...RETRY_POLICY, baseBackoffMs: 5_000, maxBackoffMs: 5_000 }, 100);
    let requests = 0;
    const outcome = await harness.controller.execute(async (): Promise<RetryOutcome> => {
      requests += 1;
      return { value: 'failed-terminal', failure: { category: 'transient_server' } };
    });
    record('deadline-during-backoff', '退避将跨过绝对 deadline', requests, outcome === 'failed-terminal' ? 'failed' : 'complete',
      harness.stopReasons, harness.controller.counters() as unknown as Record<string, number>);
  }

  const fallback = runFallbackPolicyMatrix();
  writeEvidence(options.evidenceDir, 'access-fault-matrix-retry.json', {
    schemaVersion: ACCESS_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', scenarios, fallback,
  });
  return { scenarios: Object.freeze(scenarios), fallback };
}

function runFallbackPolicyMatrix(): FallbackPolicyObservation {
  const preferred = { runtime: 'fake', provider: 'test-provider', model: 'preferred-model' };
  const backup = { ...preferred, model: 'backup-model' };
  const planInput = {
    schemaVersion: 1,
    preferred: { strategy: preferred, source: 'task.preferred', approved: true },
    fallbacks: [{ strategy: backup, source: 'task.backup', approved: true }],
    policy: { switchOn: ['transient_server', 'transient_connection', 'quota_blocked'] },
  };
  const plan = validateRuntimeFallbackPlan(planInput);
  const capabilities = createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: preferred.provider, models: [preferred.model, backup.model] }] },
  ]);
  const decide = (category: string, sameAttemptRetryExhausted = true) => {
    const decision = decideRuntimeFallback({
      plan, failure: { category, reason: 'matrix-probe' }, nowUtcMs: 1_000, capabilities,
      sameAttemptRetryExhausted,
    });
    return {
      mode: decision.mode,
      stopReason: decision.mode === 'stop' ? decision.stopReason : null,
      model: decision.mode === 'switch' ? decision.strategySnapshot.model : null,
      source: decision.mode === 'switch' ? decision.strategySource : null,
      previousFailures: decision.previousFailures.map(failure => ({ category: failure.category })),
    };
  };
  let unapprovedPlanRejected = false;
  try {
    validateRuntimeFallbackPlan({
      ...planInput,
      fallbacks: [{ strategy: backup, source: 'task.unapproved', approved: false }],
    });
  } catch {
    unapprovedPlanRejected = true;
  }
  return {
    unapprovedPlanRejected,
    decisions: Object.freeze({
      quota_blocked: decide('quota_blocked'),
      transient_server: decide('transient_server'),
      transient_connection_before_retry_exhausted: decide('transient_connection', false),
      authentication: decide('authentication'),
      protocol: decide('protocol'),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Core 集成矩阵（真实 SQLite Core + Fake Runtime）
 * ------------------------------------------------------------------ */

export interface CoreFaultObservation {
  readonly scenarioId: string;
  readonly fault: string;
  readonly starts: readonly string[];
  readonly attempts: readonly { number: number; status: string; errorKind: string | null }[];
  readonly counters: { attemptsCreated: number; runtimeStarts: number };
  readonly settlements: readonly {
    artifactKind: string;
    failure: { kind: string; reason: string } | null;
    category: string | null;
    routing: { category: string | null; selected: { model: string; source: string } | null } | null;
    recordingComplete: boolean;
  }[];
  readonly run: { status: string; reason: string | null };
  readonly taskStatus: string | null;
  readonly sessions: number;
  readonly activeAttempts: number;
  readonly leases: readonly { state: string; count: number }[];
  readonly fallback: { triggerCategory: string; model: string; previousFailures: { category: string }[] } | null;
  readonly sideEffectFile: { relativePath: string; content: string } | null;
  readonly commandReceipts: readonly { operation: string; status: string }[];
}

export interface CoreFaultMatrixOptions extends AccessFaultMatrixEvidenceOptions {
  /** 只运行指定场景（缺省运行全部）。 */
  readonly only?: readonly string[];
}

const CORE_PREFERRED = { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } as const;
const CORE_BACKUP = { ...CORE_PREFERRED, model: 'backup-model' } as const;
const CORE_PROVIDERS = [{ providerId: CORE_PREFERRED.provider, models: [CORE_PREFERRED.model, CORE_BACKUP.model] }];
const CORE_SIDE_EFFECT_FILE = 'access-matrix-side-effect.txt';
const CORE_EVIDENCE_DIGESTS = {
  catalogDigest: 'a'.repeat(64), registryDigest: 'b'.repeat(64), authorizationDigest: 'c'.repeat(64),
};
const CORE_MAX_RUNTIME_STARTS = 4;

interface CoreScenarioConfig {
  readonly id: string;
  readonly fault: string;
  /** Fake Runtime 首选策略的失败 reason；缺省表示没有故障（或不会启动）。 */
  readonly failureReason?: string;
  readonly preExhaustBudget?: boolean;
}

const CORE_SCENARIOS: readonly CoreScenarioConfig[] = Object.freeze([
  Object.freeze({ id: 'core-authentication-refusal', fault: '认证失败：不切换备用厂商', failureReason: 'authentication' }),
  Object.freeze({ id: 'core-quota-fallback', fault: '限流：按已批准策略切换备用模型', failureReason: 'quota_blocked' }),
  Object.freeze({ id: 'core-protocol-refusal', fault: '协议故障：不切换备用厂商', failureReason: 'protocol' }),
  Object.freeze({ id: 'core-budget-zero-call', fault: '预算耗尽：明确拒绝真实调用', preExhaustBudget: true }),
] as const);

async function waitUntil(read: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (read()) return true;
    if (Date.now() >= deadline) return read();
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function runCoreScenario(config: CoreScenarioConfig): Promise<CoreFaultObservation> {
  const f = await openBindingFixture();
  let core: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
  try {
    const starts: string[] = [];
    const failureRoutingPlan = validateRuntimeFallbackPlan({
      schemaVersion: 1,
      preferred: { strategy: { ...CORE_PREFERRED }, source: 'task.preferred', approved: true },
      fallbacks: [{ strategy: { ...CORE_BACKUP }, source: 'task.backup', approved: true }],
      policy: { switchOn: ['transient_server', 'transient_connection', 'quota_blocked'] },
    });
    const factory: WorkRuntimeFactory = context => {
      // 使用真实组合根提供的 context（workspaceRoots/reader/commitCommandIdentity），
      // 让 Fake Runtime 走与生产一致的输入读取与工作区路径解析。
      const makeFake = (failed: boolean, marker: string) => createFakeWorkRuntimeFactory({
        providers: CORE_PROVIDERS,
        script: {
          schemaVersion: 1,
          steps: [
            { op: 'read_input', purpose: 'requirements' },
            { op: 'write_file', path: CORE_SIDE_EFFECT_FILE, content: marker },
          ],
          result: {
            terminal: failed ? 'failed' : 'completed',
            reason: failed ? config.failureReason ?? 'temporary_server_failure' : null,
            exitCode: failed ? 1 : 0, signal: null, durationMs: 1,
            usage: { inputTokens: 2, outputTokens: 1, costUsdMicros: null },
          },
        },
      })(context);
      const bad = makeFake(true, 'preferred-failed');
      const good = makeFake(false, 'backup-started');
      return {
        eventIdentityPrefix: bad.eventIdentityPrefix,
        entries: [{
          descriptor: bad.entries[0]!.descriptor,
          adapter: {
            async start(request) {
              starts.push(request.strategy.model);
              const delegate = request.strategy.model === CORE_PREFERRED.model || config.failureReason === undefined
                ? bad
                : good;
              return delegate.entries[0]!.adapter.start(request);
            },
          },
        }],
        failureRouting: {
          select: () => ({ plan: failureRoutingPlan, policyVersion: 'matrix-policy-v1', capabilityEvidence: CORE_EVIDENCE_DIGESTS }),
          authorize: async () => true,
        },
      };
    };
    core = await openCoreApplication({
      dataRoot: f.box.dataRoot,
      workRuntimeFactory: factory,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: CORE_PROVIDERS }]),
      nowUtcMs: () => BINDING_NOW,
    });
    if (config.preExhaustBudget === true) {
      f.session.database.prepare('UPDATE execution_batches SET runtime_starts = ?').run(CORE_MAX_RUNTIME_STARTS);
    }
    await core.workExecution.scan();

    if (config.preExhaustBudget === true) {
      await waitUntil(() => (f.query('SELECT reason FROM runs') as { reason: string | null }).reason === 'budget_exhausted', 15_000);
    } else if (config.failureReason === 'quota_blocked') {
      await waitUntil(() => {
        const attempts = f.session.database.prepare('SELECT number, status FROM attempts ORDER BY number').all() as
          { number: number; status: string }[];
        const held = f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'held'") as { n: number };
        return attempts.length === 2 && attempts[1]?.status === 'verifying' && held.n === 3;
      }, 15_000);
    } else {
      const settled = await waitUntil(() => {
        const settlements = f.query("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'runtime-settlement'") as { n: number };
        const leases = f.query('SELECT COUNT(*) AS n FROM workspace_leases') as { n: number };
        const run = f.query('SELECT status FROM runs') as { status: string };
        // Settlement quarantines leases before retention safely releases them.
        return settlements.n >= 1 && leases.n === 0 && run.status === 'paused'
          && core!.workExecution.activeAttemptIds().length === 0;
      }, 15_000);
      if (!settled) throw new Error(`${config.id}: finalization_not_confirmed`);
    }

    const attemptRows = f.session.database.prepare(
      'SELECT number, status, error_kind AS errorKind, input_snapshot AS inputSnapshot FROM attempts ORDER BY number',
    ).all() as { number: number; status: string; errorKind: string | null; inputSnapshot: string }[];
    const settlementRows = f.session.database.prepare(
      "SELECT id FROM artifacts WHERE kind = 'runtime-settlement' ORDER BY rowid",
    ).all() as { id: string }[];
    const settlements = [];
    for (const row of settlementRows) {
      const body = JSON.parse(Buffer.from(
        (await f.verifier.readVerifiedContent(f.projectId, row.id)).content).toString('utf8')) as {
        kind: string; execution?: { failure?: { kind: string; reason: string } | null; classification?: { category: string | null } };
        failure?: { kind: string; reason: string } | null;
        routing?: { category: string | null; selected: { model: string; source: string } | null };
        recording?: { complete: boolean };
      };
      settlements.push({
        artifactKind: body.kind,
        failure: body.execution?.failure ?? body.failure ?? null,
        category: body.execution?.classification?.category ?? null,
        routing: body.routing === undefined ? null : {
          category: body.routing.category,
          selected: body.routing.selected === null || body.routing.selected === undefined
            ? null
            : { model: body.routing.selected.model, source: body.routing.selected.source },
        },
        recordingComplete: body.recording?.complete ?? false,
      });
    }
    const lastAttempt = attemptRows[attemptRows.length - 1];
    const runtimeFallback = lastAttempt === undefined ? undefined
      : (JSON.parse(lastAttempt.inputSnapshot) as { runtimeFallback?: {
        triggerCategory: string; strategy: { model: string }; previousFailures: { category: string }[] } }).runtimeFallback;
    const workspaceRows = f.session.database.prepare(
      'SELECT canonical_path AS canonicalPath FROM managed_workspaces ORDER BY rowid',
    ).all() as { canonicalPath: string }[];
    let sideEffectFile: { relativePath: string; content: string } | null = null;
    for (const workspace of workspaceRows.reverse()) {
      const target = join(workspace.canonicalPath, CORE_SIDE_EFFECT_FILE);
      if (existsSync(target)) {
        sideEffectFile = { relativePath: CORE_SIDE_EFFECT_FILE, content: readFileSync(target, 'utf8') };
        break;
      }
    }
    const observation: CoreFaultObservation = {
      scenarioId: config.id,
      fault: config.fault,
      starts: Object.freeze([...starts]),
      attempts: Object.freeze(attemptRows.map(row => ({ number: row.number, status: row.status, errorKind: row.errorKind }))),
      counters: f.query('SELECT attempts_created AS attemptsCreated, runtime_starts AS runtimeStarts FROM execution_batches') as {
        attemptsCreated: number; runtimeStarts: number;
      },
      settlements: Object.freeze(settlements),
      run: f.query('SELECT status, reason FROM runs') as { status: string; reason: string | null },
      taskStatus: (f.query("SELECT status AS status FROM tasks WHERE id = 't-1'") as { status: string } | undefined)?.status ?? null,
      sessions: (f.query('SELECT COUNT(*) AS n FROM sessions') as { n: number }).n,
      activeAttempts: core.workExecution.activeAttemptIds().length,
      leases: Object.freeze((f.session.database.prepare(
        'SELECT state, COUNT(*) AS count FROM workspace_leases GROUP BY state ORDER BY state',
      ).all() as { state: string; count: number }[]).map(row => ({ state: row.state, count: row.count }))),
      fallback: runtimeFallback === undefined ? null : {
        triggerCategory: runtimeFallback.triggerCategory,
        model: runtimeFallback.strategy.model,
        previousFailures: runtimeFallback.previousFailures.map(failure => ({ category: failure.category })),
      },
      sideEffectFile,
      commandReceipts: Object.freeze((f.session.database.prepare(
        'SELECT operation, status FROM command_receipts ORDER BY rowid',
      ).all() as { operation: string; status: string }[]).map(row => ({ operation: row.operation, status: row.status }))),
    };
    return observation;
  } finally {
    if (core !== undefined) {
      await core.workExecution.close();
      core.close();
    }
    f.close();
  }
}

export async function runCoreAccessFaults(
  options: CoreFaultMatrixOptions = {},
): Promise<readonly CoreFaultObservation[]> {
  const selected = CORE_SCENARIOS.filter(scenario => options.only === undefined || options.only.includes(scenario.id));
  if (selected.length === 0) throw new TypeError('runCoreAccessFaults: 没有匹配的场景');
  const observations: CoreFaultObservation[] = [];
  for (const scenario of selected) {
    observations.push(await runCoreScenario(scenario));
  }
  writeEvidence(options.evidenceDir, 'access-fault-matrix-core.json', {
    schemaVersion: ACCESS_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', observations,
  });
  return Object.freeze(observations);
}

/* ------------------------------------------------------------------ *
 * 证据落盘
 * ------------------------------------------------------------------ */

function writeEvidence(directory: string | undefined, name: string, body: unknown): void {
  if (directory === undefined || directory === '') return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}
