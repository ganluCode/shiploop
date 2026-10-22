/**
 * P04-8 / F-004 运行时访问故障矩阵（不依赖模型与网络）。
 *
 * 矩阵经由前序 P04 Feature 的公开接口组合出确定性离线场景：
 * - 适配器边界：SDK 缺失、认证拒绝、资源未授权、越权工具、未获准
 *   provider/model/凭据/临时项目在进入任何会话或模型请求前被明确拒绝，
 *   并留下 zero-call 计数证据；
 * - 同 Attempt 重试边界：限流、连接、服务端、协议与工具超时分别核验
 *   可重试类别、绝对 deadline、累计故障计数与单次启动预算（runtimeStarts
 *   不随请求重试增长）；备用策略只对已批准计划中的类别切换；
 * - Core 集成：故障经真实 SQLite Core 落到 attempts/sessions/runs/回执与
 *   工作区实际副作用，而不是只看日志或调用次数。
 */
import { describe, expect, it } from 'vitest';
import {
  ACCESS_FAULT_MATRIX_IDS,
  runAdapterAccessFaults,
  runCoreAccessFaults,
  runRetryBoundaryFaults,
  type AdapterFaultObservation,
} from '../../helpers/p04-8/access-fault-matrix.ts';

const adapterById = (rows: readonly AdapterFaultObservation[], id: string): AdapterFaultObservation => {
  const found = rows.find(row => row.scenarioId === id);
  if (found === undefined) throw new Error(`适配器故障矩阵缺少场景 ${id}`);
  return found;
};

describe('P04-8 F-004 运行时访问故障矩阵', () => {
  it('[case:f004-access-fault-classes] SDK 缺失、认证、资源与越权产生可区分的状态、分类与证据', async () => {
    const observations = await runAdapterAccessFaults();
    expect(observations.map(row => row.scenarioId).sort()).toEqual([...ACCESS_FAULT_MATRIX_IDS.adapter].sort());

    // 每个故障族都有机器可读的拒绝身份与 Core 分类投影，互不混淆。
    expect(adapterById(observations, 'sdk-missing')).toMatchObject({
      rejected: true, errorKind: 'configuration', errorReason: 'sdk_initialization_failed',
      category: 'configuration', settlementKind: 'configuration',
    });
    expect(adapterById(observations, 'authentication-expired')).toMatchObject({
      errorKind: 'authentication', errorReason: 'work_authentication_not_ready',
      category: 'authentication', settlementKind: 'authentication',
    });
    expect(adapterById(observations, 'authentication-drift')).toMatchObject({
      errorKind: 'authentication', errorReason: 'work_access_snapshot_mismatch',
    });
    expect(adapterById(observations, 'resource-unauthorized')).toMatchObject({
      errorKind: 'permission', errorReason: 'resource_not_authorized',
      category: 'unknown', settlementKind: 'permission',
    });
    expect(adapterById(observations, 'tool-grant-unauthorized')).toMatchObject({
      errorKind: 'permission', errorReason: 'required_permission_not_granted',
      category: 'unknown', settlementKind: 'permission',
    });
    expect(adapterById(observations, 'workspace-missing')).toMatchObject({
      errorKind: 'permission', errorReason: 'work_workspace_unavailable',
    });

    // 三族 (RuntimeError kind, Core 分类 category) 签名互不相同。
    expect(new Set(observations.map(row => `${row.errorKind}/${row.category}`)))
      .toEqual(new Set(['configuration/configuration', 'authentication/authentication', 'permission/unknown']));

    // 不静默切换厂商或资源：到达会话工厂的策略就是请求策略本身，失败后没有别的厂商被尝试。
    for (const row of observations) {
      expect(row.rejected).toBe(true);
      expect(row.zeroModelCalls).toBe(true);
      expect(row.sessionStrategies).toEqual(row.sessionStrategies.filter(strategy =>
        strategy.provider === row.requestedStrategy.provider && strategy.model === row.requestedStrategy.model));
      expect(row.sessionFactoryCalls).toBe(row.sessionStrategies.length);
    }
  }, 30_000);

  it('[case:f004-adapter-zero-call] 缺获准 provider/model/凭据/项目/资源清单时拒绝真实调用并留下 zero-call 证据', async () => {
    const observations = await runAdapterAccessFaults();
    for (const id of ['provider-unapproved', 'model-unapproved', 'credential-source-missing',
      'workspace-missing', 'resource-unauthorized', 'tool-grant-unauthorized',
      'authentication-expired', 'authentication-drift'] as const) {
      expect(adapterById(observations, id)).toMatchObject({
        rejected: true, sessionFactoryCalls: 0, promptCalls: 0, zeroModelCalls: true,
      });
    }
    expect(adapterById(observations, 'provider-unapproved')).toMatchObject({
      errorKind: 'configuration', errorReason: 'unknown_provider',
    });
    expect(adapterById(observations, 'model-unapproved')).toMatchObject({
      errorKind: 'configuration', errorReason: 'unsupported_model',
    });
    expect(adapterById(observations, 'credential-source-missing')).toMatchObject({
      errorKind: 'authentication', errorReason: 'credential_reference_missing',
    });
    // SDK 缺失：导入被尝试但没有获得任何会话，也没有任何模型请求。
    expect(adapterById(observations, 'sdk-missing')).toMatchObject({
      sessionFactoryCalls: 1, promptCalls: 0, zeroModelCalls: true,
    });
  }, 30_000);

  it('[case:f004-retry-boundary] 限流/连接/服务端/协议/工具超时分别核验重试边界、deadline 与累计故障', async () => {
    const { scenarios } = await runRetryBoundaryFaults();
    const by = (id: string) => {
      const found = scenarios.find(row => row.scenarioId === id);
      if (found === undefined) throw new Error(`重试边界矩阵缺少场景 ${id}`);
      return found;
    };

    // 限流（quota_blocked）不做同 Attempt 重试，交给已批准的备用策略处理。
    expect(by('rate-limit-429')).toMatchObject({ requests: 1, outcome: 'failed', stopReason: 'non_retryable_category' });
    expect(by('rate-limit-429').counters).toMatchObject({ retryCount: 0, runtimeStarts: 1, cumulativeFailures: 1 });

    // 连接故障在边界内重试并恢复；有效成功重置连续故障，累计故障只增不清。
    expect(by('connection-reset')).toMatchObject({ requests: 4, outcome: 'complete', stopReason: null });
    expect(by('connection-reset').counters).toMatchObject({
      requestCount: 4, retryCount: 2, runtimeStarts: 1,
      cumulativeFailures: 2, consecutiveFailures: 0, peakConsecutiveFailures: 1,
    });

    // 服务端故障耗尽重试上限后停止；SDK 内部重试不放大外层预算。
    expect(by('server-503')).toMatchObject({ requests: 3, outcome: 'failed', stopReason: 'retry_limit_exhausted' });
    expect(by('server-503').counters).toMatchObject({
      requestCount: 3, retryCount: 2, runtimeStarts: 1,
      cumulativeFailures: 3, consecutiveFailures: 3, peakConsecutiveFailures: 3,
    });

    // 协议故障不可重试。
    expect(by('protocol-invalid')).toMatchObject({ requests: 1, outcome: 'failed', stopReason: 'non_retryable_category' });

    // 工具超时：副作用不确定立即停止；明确无副作用才允许同 Attempt 重试。
    expect(by('tool-timeout-uncertain')).toMatchObject({ requests: 1, outcome: 'failed', stopReason: 'side_effect_uncertain' });
    expect(by('tool-timeout-known-safe')).toMatchObject({ requests: 3, outcome: 'complete' });
    expect(by('tool-timeout-known-safe').counters).toMatchObject({ retryCount: 2, runtimeStarts: 1 });

    // 绝对 deadline：到期后不再发起请求；退避会跨过 deadline 时同样停止。
    expect(by('deadline-before-request')).toMatchObject({ requests: 0, outcome: 'not-started', stopReason: 'deadline_reached' });
    expect(by('deadline-during-backoff')).toMatchObject({ requests: 1, outcome: 'failed', stopReason: 'deadline_reached' });
    expect(by('deadline-during-backoff').counters).toMatchObject({ retryCount: 0 });

    // 同一存活 Attempt 内的全部重试只占用一次启动预算。
    for (const row of scenarios) expect(row.counters.runtimeStarts).toBe(1);
  }, 30_000);

  it('[case:f004-fallback-policy] 备用策略只按已批准计划切换，认证与协议故障不切换厂商', async () => {
    const { fallback } = await runRetryBoundaryFaults();
    expect(fallback.unapprovedPlanRejected).toBe(true);
    expect(fallback.decisions.quota_blocked).toMatchObject({ mode: 'switch', model: 'backup-model', source: 'task.backup' });
    expect(fallback.decisions.transient_server).toMatchObject({ mode: 'switch', model: 'backup-model' });
    expect(fallback.decisions.transient_connection_before_retry_exhausted)
      .toMatchObject({ mode: 'stop', stopReason: 'same_attempt_retry_not_exhausted', model: null });
    expect(fallback.decisions.authentication).toMatchObject({ mode: 'stop', stopReason: 'category_not_switchable', model: null });
    expect(fallback.decisions.protocol).toMatchObject({ mode: 'stop', stopReason: 'category_not_switchable', model: null });
    expect(fallback.decisions.quota_blocked.previousFailures).toEqual([{ category: 'quota_blocked' }]);
  }, 30_000);

  it('[case:f004-core-authentication-refusal] 认证失败落到 Attempt/Run 回执与副作用，不切换备用厂商', async () => {
    const [observation] = await runCoreAccessFaults({ only: ['core-authentication-refusal'] });
    expect(observation.starts).toEqual(['fake-model']);
    expect(observation.attempts).toEqual([{ number: 1, status: 'failed', errorKind: 'authentication' }]);
    expect(observation.counters).toEqual({ attemptsCreated: 1, runtimeStarts: 1 });
    expect(observation.settlements).toHaveLength(1);
    expect(observation.settlements[0]).toMatchObject({
      artifactKind: 'runtime-settlement',
      // 回执保留受控 reason 词汇；分类投影独立记录 category。
      failure: { kind: 'authentication', reason: 'authentication' },
      category: 'authentication',
      routing: { selected: null },
    });
    expect(observation.run).toEqual({ status: 'paused', reason: 'category_not_switchable' });
    expect(observation.fallback).toBeNull();
    expect(observation.leases).toEqual([]);
    expect(observation.activeAttempts).toBe(0);
    expect(observation.sessions).toBe(1);
    // 实际副作用：失败 Attempt 的工作区写入被保留，运行时成功不等于验收通过。
    expect(observation.sideEffectFile).toEqual({ relativePath: 'access-matrix-side-effect.txt', content: 'preferred-failed' });
    expect(observation.commandReceipts).toContainEqual({ operation: 'execution.start', status: 'completed' });
  }, 120_000);

  it('[case:f004-core-quota-fallback] 限流触发已批准备用策略，每次启动只记一次预算', async () => {
    const [observation] = await runCoreAccessFaults({ only: ['core-quota-fallback'] });
    expect(observation.starts).toEqual(['fake-model', 'backup-model']);
    expect(observation.attempts).toEqual([
      { number: 1, status: 'failed', errorKind: 'rate_limited' },
      { number: 2, status: 'verifying', errorKind: null },
    ]);
    // 两次启动各记一次，不重复计算预算。
    expect(observation.counters).toEqual({ attemptsCreated: 2, runtimeStarts: 2 });
    expect(observation.settlements).toHaveLength(2);
    expect(observation.settlements[0]).toMatchObject({
      artifactKind: 'runtime-settlement',
      failure: { kind: 'rate_limited', reason: 'quota_blocked' },
      category: 'quota_blocked',
      routing: { category: 'quota_blocked', selected: null },
    });
    expect(observation.settlements[1]).toMatchObject({
      failure: null,
      routing: { selected: { model: 'backup-model', source: 'task.backup' } },
    });
    expect(observation.fallback).toEqual({
      triggerCategory: 'quota_blocked', model: 'backup-model',
      previousFailures: [{ category: 'quota_blocked' }],
    });
    // 替换 Attempt 真正执行并写入工作区（实际副作用，不是调用计数）。
    expect(observation.sideEffectFile).toEqual({ relativePath: 'access-matrix-side-effect.txt', content: 'backup-started' });
    expect(observation.leases).toEqual([{ state: 'held', count: 3 }]);
    // 切换后 Run 因未组装验证而暂停（不是因备用策略缺失），备用链没有静默继续。
    expect(observation.run).toEqual({ status: 'paused', reason: 'verification_not_assembled' });
    expect(observation.commandReceipts).toContainEqual({ operation: 'execution.start', status: 'completed' });
  }, 120_000);

  it('[case:f004-core-protocol-refusal] 协议故障保留独立分类回执，不切换备用厂商', async () => {
    const [observation] = await runCoreAccessFaults({ only: ['core-protocol-refusal'] });
    expect(observation.starts).toEqual(['fake-model']);
    expect(observation.attempts).toEqual([{ number: 1, status: 'failed', errorKind: 'protocol' }]);
    expect(observation.counters).toEqual({ attemptsCreated: 1, runtimeStarts: 1 });
    expect(observation.settlements).toHaveLength(1);
    expect(observation.settlements[0]).toMatchObject({
      failure: { kind: 'protocol', reason: 'protocol' },
      category: 'protocol',
    });
    expect(observation.run).toEqual({ status: 'paused', reason: 'category_not_switchable' });
    expect(observation.fallback).toBeNull();
    expect(observation.sideEffectFile).toEqual({ relativePath: 'access-matrix-side-effect.txt', content: 'preferred-failed' });
  }, 120_000);

  it('[case:f004-core-budget-zero-call] 无预算时明确拒绝真实调用并留下 zero-call 回执', async () => {
    const [observation] = await runCoreAccessFaults({ only: ['core-budget-zero-call'] });
    expect(observation.starts).toEqual([]);
    expect(observation.attempts).toEqual([]);
    expect(observation.settlements).toEqual([]);
    expect(observation.sessions).toBe(0);
    // 预算不被重复消耗：预耗尽后保持不变，也没有新的启动被记账。
    expect(observation.counters).toEqual({ attemptsCreated: 0, runtimeStarts: 4 });
    // 预算耗尽的 Run 回执：保持排队并记录阻断原因，不发起任何真实调用。
    expect(observation.run).toEqual({ status: 'queued', reason: 'budget_exhausted' });
    expect(observation.taskStatus).toBe('pending');
    expect(observation.sideEffectFile).toBeNull();
    // Run 回执：execution.start 命令被接受，但没有产生任何启动或结算。
    expect(observation.commandReceipts).toContainEqual({ operation: 'execution.start', status: 'accepted' });
  }, 120_000);
});
