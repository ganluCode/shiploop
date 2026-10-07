/**
 * F-004 P02-2 命令/事件测试夹具公共面（仅测试，不进 packages/，vitest 已排除 helpers）。
 *
 * 构成：
 * - principals：可信测试装配绑定的 local-owner / test-restricted 主体（冻结）；
 * - race-barrier：进程内 N 路同步起跑屏障（有界超时，只提高重叠不保证调度）；
 * - race-children + barrier-probe-child：跨进程 ready/go N 路竞争编排与退出核验；
 * - fault-injection：真实 SQLite TEMP TRIGGER RAISE(ABORT) 事务故障注入；
 * - storage-probe：独立只读真实连接（业务行/revision/回执/事件计数）；
 * - replay-watermark：保留下界水位测试缝（F-012 snapshot_required，不删审计）；
 * - sse-client：原始 loopback SSE 客户端（暂停消费/突然断开/Last-Event-ID 重连）；
 * - commands-fixture：临时沙箱 + 真实 Git 仓库 A/B + 数据根 + Core 装配组合夹具。
 */
export {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
  isTestRestrictedPrincipalId,
  scopeAll,
  scopeAllowlist,
  TEST_RESTRICTED_PRINCIPAL_PREFIX,
  type CreateRestrictedPrincipalOptions,
  type TestPrincipalScope,
  type TestTrustedPrincipal,
} from './principals.ts';
export {
  BarrierTimeoutError,
  createStartBarrier,
  runWithStartBarrier,
  type StartBarrier,
  type StartBarrierOptions,
  type StartBarrierState,
} from './race-barrier.ts';
export {
  installWriteFault,
  WRITE_FAULT_POINTS,
  type InstalledWriteFault,
  type InstallWriteFaultInput,
  type WriteFaultPoint,
} from './fault-injection.ts';
export {
  openStorageProbe,
  type ProjectProbeRow,
  type SettingsProbeRow,
  type StateEventProbeRow,
  type StorageProbe,
  type StorageTableCounts,
} from './storage-probe.ts';
export {
  createReplayLowerBoundController,
  type ReplayLowerBoundController,
  type ReplayWatermarkScope,
} from './replay-watermark.ts';
export {
  connectSseLoopback,
  SseClientError,
  type SseConnectOptions,
  type SseConnection,
  type SseFrame,
} from './sse-client.ts';
export {
  runBarrierChildren,
  BarrierChildrenError,
  type BarrierChildResult,
  type BarrierChildrenOptions,
} from './race-children.ts';
export {
  createCommandsTestFixture,
  type CommandsTestFixture,
  type CommandsTestFixtureOptions,
  type CommandsTransactionalHarness,
} from './commands-fixture.ts';
