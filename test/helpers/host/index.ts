/**
 * F-005 Host/CLI 测试夹具公共面（仅测试，不进 packages/，不被 vitest 收集）。
 *
 * 构成：
 * - isolated-environment：临时沙箱 + 白名单 env + 规范数据根 + 统一回收；
 * - managed-child：真实 Node 子进程 ready/go 屏障、有界等待、退出核验与升级；
 * - child-runtime/fixture-child：子进程侧屏障运行时与标准异常场景；
 * - fake-host-server/http-probe：可编排伪 Host 与不跟随重定向的本机探针；
 * - fake-activity-gate（F-008）：以真实受管子进程充当已接受活动的 §10.2
 *   门控实现，与纯内存可放行门控（制造确定性的 quiescing 进行中窗口）；
 * - discovery-fixture：经生产存储路径发行伪凭据/发现；
 * - evidence：脱敏证据日志与请求头分类。
 */
export {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
  type IsolatedEnvironmentOptions,
  type SpawnFixtureChildOptions,
} from './isolated-environment.ts';
export {
  spawnManagedChild,
  createProcessSupervisor,
  confirmProcessExit,
  FixtureProcessError,
  type ManagedChild,
  type ProcessSupervisor,
  type SpawnManagedChildOptions,
  type StopConfirmationOptions,
  type ProcessExitResult,
  type ChildReadyMessage,
  type GenericIpcMessage,
  type ExitWaitable,
  type FixtureProcessFailureReason,
} from './managed-child.ts';
export {
  startFakeHostServer,
  type FakeHostServer,
  type FakeServerBehavior,
  type FakeRequestObservation,
  type HandshakeFault,
} from './fake-host-server.ts';
export {
  loopbackRequest,
  LoopbackProbeError,
  type LoopbackRequestOptions,
  type LoopbackResponse,
} from './http-probe.ts';
export {
  mintHostCredential,
  publishLoopbackDiscovery,
  writeRawDiscoveryFile,
  type MintedHostCredential,
  type PublishedLoopbackDiscovery,
  type PublishLoopbackDiscoveryInput,
} from './discovery-fixture.ts';
export {
  createEvidenceLog,
  redactRequestHeaders,
  EvidenceSecretLeakError,
  type EvidenceLog,
  type EvidenceEvent,
  type EvidenceLogOptions,
  type SanitizedRequestHeaders,
} from './evidence.ts';
export { runBarrierChild, readChildConfig, type BarrierContext, type BarrierScenario } from './child-runtime.ts';
export {
  createChildActivityGate,
  createDeferredActivityGate,
  type ChildActivityGate,
  type DeferredActivityGate,
} from './fake-activity-gate.ts';
