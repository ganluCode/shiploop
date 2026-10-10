/**
 * F-002 P02-4 验收场景夹具公共面（仅测试，不进 packages/，vitest 已排除 helpers）。
 *
 * 构成：
 * - acceptance-fixture：本次专属临时数据根 + 真实 Git 干净/脏变体 + P02-3 样例
 *   场景预设 + 真实 dist CLI 会话 + 证据快照 + fail-closed 回收（停止未确认保留
 *   资源与诊断；只清理本次授权临时根，拒绝未知路径/符号链接逃逸）；
 * - dist-cli-session / dist-cli-driver-child：managed-child ready/go 同步屏障内
 *   启动真实 `packages/cli/dist/bin.js`——ready、身份查询、有限等待、实际退出
 *   核验、有界 stdout/stderr 采集、同点放行竞争；
 * - evidence-snapshot：仓库身份/HEAD/Git 状态/tracked+untracked 摘要、非秘密 Host
 *   身份、操作/检查状态、输出制品摘要、稳定报告导出、凭据形状扫描、受控只读
 *   SQLite 探针（不插入或修改业务状态）。
 *
 * 复用而不重写：temp-sandbox / safe-cleanup / git-repo / managed-child /
 * race-barrier / storage-probe / p02-3 基线组合夹具与命令样例。
 */
export {
  createAcceptanceFixture,
  P024_SCENARIO_KEYS,
  type AcceptanceFixture,
  type AcceptanceFixtureOptions,
  type DisposeOptions,
  type P024ScenarioKey,
  type RunDistCliOptions,
  type ScenarioPlanOptions,
  type ScenarioPreset,
} from './acceptance-fixture.ts';
export {
  DIST_CLI_BIN,
  assertDistCliBuilt,
  parseJsonEnvelopes,
  raceDistCliSessions,
  singleEnvelope,
  spawnDistCliSession,
  type CliEnvelope,
  type DistCliIdentity,
  type DistCliInput,
  type DistCliRaceOptions,
  type DistCliResult,
  type DistCliSession,
  type SpawnDistCliSessionOptions,
} from './dist-cli-session.ts';
export {
  artifactContentDigest,
  assertNoCredentialShapes,
  exportEvidenceDocument,
  extractHostIdentity,
  extractOperationSnapshot,
  openDataRootStorageProbe,
  scanForCredentialShapes,
  snapshotRepository,
  CREDENTIAL_KEY_PATTERN,
  type ArtifactDigestSnapshot,
  type EvidenceDocumentInput,
  type FileContentDigest,
  type HostIdentitySnapshot,
  type OperationCheckOutputSnapshot,
  type OperationCheckSnapshot,
  type OperationSnapshot,
  type RepositorySnapshot,
  type SnapshotRepositoryOptions,
} from './evidence-snapshot.ts';
/* 复用面（同一实现，不重写）： */
export {
  BarrierTimeoutError,
  createStartBarrier,
  runWithStartBarrier,
  type StartBarrier,
} from '../p02-2/race-barrier.ts';
export { SafeCleanupError, safeRemoveTempRoot, type SafeCleanupErrorKind } from '../safe-cleanup.ts';
export {
  COMMAND_SAMPLES,
  COMMAND_SAMPLE_SCRIPT,
  NONZERO_EXIT_CODE,
  commandSampleCheck,
  commandSampleExpectation,
  type CommandSample,
  type CommandSampleKey,
} from '../p02-3/command-samples.ts';
export { digestFile, digestWorkingTree, type TreeDigest } from '../p02-3/process-tools.ts';
export type { SampleProcess, SampleProcessOptions } from '../p02-3/process-tools.ts';
export type { RepoVariants, RepoVariantKey } from '../p02-3/repo-variants.ts';
export type { StorageProbe, StorageTableCounts } from '../p02-2/storage-probe.ts';
export type { ChildReadyMessage, ProcessExitResult, StopConfirmationOptions } from '../host/managed-child.ts';
export { FixtureProcessError } from '../host/managed-child.ts';
