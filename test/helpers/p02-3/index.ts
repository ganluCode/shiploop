/**
 * F-003 P02-3 基线检查测试夹具公共面（仅测试，不进 packages/，vitest 已排除 helpers）。
 *
 * 构成：
 * - command-samples：真实 Node 命令样例描述符（成功/非零/缺命令/未知 script/
 *   挂起/忽略 SIGTERM/派生写入子进程/大量输出/修改源码），绑定 §8.3 状态映射；
 * - command-scripts/*.mjs：样例脚本本体（含仅写临时哨兵的恶意初始化脚本）；
 * - repo-variants：真实 Git 仓库变体（HEAD/无 commit/脏工作区/同 remote clone/
 *   路径别名/恶意初始化脚本仓库）；
 * - process-tools：有界竞争屏障 + 进程身份/退出核验 + 文件内容摘要 +
 *   只回收已核验自有资源的样例进程守护；
 * - evidence-faults：输出发布失败（ArtifactFileStore 装饰器）与数据库收尾失败
 *   （复用真实 SQLite TEMP TRIGGER）注入；
 * - baseline-fixture：在同一沙箱内组合上述全部资源的组合夹具。
 */
export {
  COMMAND_SAMPLE_SCRIPTS_DIR,
  COMMAND_SAMPLE_SCRIPT,
  COMMAND_SAMPLES,
  COMMAND_SAMPLE_KEYS,
  MISSING_COMMAND_EXECUTABLE,
  UNKNOWN_PACKAGE_SCRIPT,
  NONZERO_EXIT_CODE,
  commandSampleCheck,
  commandSampleExpectation,
  isMissingCommandExecutableAbsent,
  type CommandSample,
  type CommandSampleCheckOptions,
  type CommandSampleKey,
  type CommandSampleKind,
} from './command-samples.ts';
export {
  createRepoVariants,
  type CreateRepoVariantsOptions,
  type RepoVariantKey,
  type RepoVariants,
} from './repo-variants.ts';
export {
  createStartBarrier,
  runWithStartBarrier,
  BarrierTimeoutError,
  DEFAULT_BARRIER_TIMEOUT_MS,
  confirmProcessExit,
  FixtureProcessError,
  spawnSampleProcess,
  createSampleProcessGuard,
  digestFile,
  digestWorkingTree,
  DEFAULT_DIGEST_EXCLUDED_DIRS,
  type StartBarrier,
  type StartBarrierOptions,
  type StartBarrierState,
  type ExitWaitable,
  type ProcessExitResult,
  type StopConfirmationOptions,
  type FixtureProcessFailureReason,
  type SampleProcess,
  type SampleProcessOptions,
  type SampleProcessExit,
  type SampleProcessGuard,
  type DigestTreeOptions,
  type TreeDigest,
  type TreeDigestEntry,
} from './process-tools.ts';
export {
  createFaultyArtifactFileStore,
  installDatabaseFinalizationFault,
  DEFAULT_FINALIZATION_FAULT_POINT,
  WRITE_FAULT_POINTS,
  type ArtifactFaultPoint,
  type ArtifactPublishFault,
  type ArtifactPublishFaultOptions,
  type DatabaseFinalizationFaultOptions,
  type FaultyArtifactFileStore,
  type InstalledWriteFault,
  type WriteFaultPoint,
} from './evidence-faults.ts';
export {
  createBaselineFixture,
  type BaselineFixture,
  type BaselineFixtureOptions,
} from './baseline-fixture.ts';
