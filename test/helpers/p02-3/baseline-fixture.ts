/**
 * F-003 P02-3 基线检查组合夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 在**同一个**临时沙箱内组合既有积木（不重写资源管理），为基线检查相关测试
 * 提供一处集中持有的全部资源：
 * - 复用 helpers/host/isolated-environment：临时沙箱 + 白名单 env + 规范数据根 +
 *   受管子进程监督器 + 脱敏证据日志；真实 HOME/受测仓库自动登记为受保护串；
 * - 复用 helpers/p02-3/repo-variants：有 HEAD / 无初始 commit / 脏工作区 /
 *   同 remote 不同 clone / 路径别名 / 恶意初始化脚本仓库（真实 git 进程）；
 * - 复用 helpers/p02-3/command-samples：成功/非零/缺命令/未知 script/挂起/
 *   忽略 SIGTERM/派生写入子进程/大量输出/修改源码等真实 Node 命令样例；
 * - 复用 adapters/fs/artifact-files：真实制品文件端口（输出发布/证据核对），
 *   并可经 evidence-faults 装饰为「输出发布失败」注入。
 *
 * 回收顺序（fail-closed）：样例进程 → 仓库变体子目录 → host 受管进程/伪服务 →
 * 沙箱目录（核验消失）。任一步未确认都聚合抛出，绝不把探测失败当成已停止。
 *
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME。
 */
import { realpathSync } from 'node:fs';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import type { ArtifactFileStore } from '../../../packages/core/src/ports/artifact-files.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from '../host/isolated-environment.ts';
import type { EvidenceLog } from '../host/evidence.ts';
import type { ProcessSupervisor } from '../host/managed-child.ts';
import { createRepoVariants, type RepoVariants } from './repo-variants.ts';
import { COMMAND_SAMPLES, type CommandSampleKey } from './command-samples.ts';
import {
  createFaultyArtifactFileStore,
  type ArtifactPublishFaultOptions,
  type FaultyArtifactFileStore,
} from './evidence-faults.ts';
import {
  createSampleProcessGuard,
  type SampleProcess,
  type SampleProcessGuard,
  type SampleProcessOptions,
} from './process-tools.ts';

export interface BaselineFixtureOptions {
  readonly prefix?: string;
  readonly stepMs?: number;
  readonly extraSecrets?: readonly string[];
}

export interface BaselineFixture {
  readonly root: string;
  readonly homeDir: string;
  readonly evidence: EvidenceLog;
  readonly repos: RepoVariants;
  /** 受管 IPC 子进程监督器（host 夹具积木）。 */
  readonly hostProcesses: ProcessSupervisor;
  /** 普通样例命令进程（有界输出采集 + 身份/退出核验）。 */
  readonly samples: SampleProcessGuard;
  /** 白名单 env（HOME/TMPDIR 指向沙箱）；真实凭据环境不透传。 */
  childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  /** 规范数据根绝对路径（在沙箱 data/<name> 下）。 */
  dataRoot(name?: string): string;
  /** 真实制品文件端口（按数据根缓存）。 */
  artifactStore(name?: string): ArtifactFileStore;
  /** 输出发布失败注入：装饰后的端口 + 可撤除的故障控制器。 */
  faultyArtifactStore(name?: string, options?: ArtifactPublishFaultOptions): FaultyArtifactFileStore;
  /** 运行命令样例：自动采用沙箱 env，默认 cwd 为沙箱根（可局部覆盖）。 */
  spawnSample(key: CommandSampleKey, options?: Partial<SampleProcessOptions>): SampleProcess;
  dispose(): Promise<void>;
}

export function createBaselineFixture(options: BaselineFixtureOptions = {}): BaselineFixture {
  const hostEnv: IsolatedHostEnvironment = createIsolatedHostEnvironment({
    prefix: options.prefix ?? 'shiploop-p02-3-',
    ...(options.stepMs !== undefined ? { stepMs: options.stepMs } : {}),
    ...(options.extraSecrets !== undefined ? { extraSecrets: options.extraSecrets } : {}),
  });
  const root = hostEnv.sandboxRoot;
  const homeDir = hostEnv.childEnv().HOME ?? root;

  // 复用同一沙箱：仓库变体只持有 repos 子目录，整体删除交给 host 环境。
  const repos = createRepoVariants({ root, homeDir });
  const samples = createSampleProcessGuard();
  const stores = new Map<string, ArtifactFileStore>();
  let disposed = false;

  return {
    root,
    homeDir,
    evidence: hostEnv.evidence,
    repos,
    hostProcesses: hostEnv.processes,
    samples,

    childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
      return hostEnv.childEnv(overrides);
    },

    dataRoot(name = 'default'): string {
      return realpathSync(hostEnv.dataRoot(name).canonicalRoot);
    },

    artifactStore(name = 'default'): ArtifactFileStore {
      const existing = stores.get(name);
      if (existing) {
        return existing;
      }
      const store = createArtifactFileStore({ dataRoot: this.dataRoot(name) });
      stores.set(name, store);
      return store;
    },

    faultyArtifactStore(name = 'default', faultOptions: ArtifactPublishFaultOptions = {}): FaultyArtifactFileStore {
      return createFaultyArtifactFileStore(this.artifactStore(name), faultOptions);
    },

    spawnSample(key: CommandSampleKey, spawnOptions: Partial<SampleProcessOptions> = {}): SampleProcess {
      const descriptor = COMMAND_SAMPLES[key];
      // 经 guard.spawn 登记：dispose 时逐个核验退出（只回收自有资源）。
      return samples.spawn({
        argv: spawnOptions.argv ?? descriptor.argv(),
        cwd: spawnOptions.cwd ?? root,
        env: spawnOptions.env ?? hostEnv.childEnv(),
        label: spawnOptions.label ?? `p02-3-sample-${key}`,
        ...(spawnOptions.stdoutLimitBytes !== undefined
          ? { stdoutLimitBytes: spawnOptions.stdoutLimitBytes }
          : {}),
        ...(spawnOptions.stderrLimitBytes !== undefined
          ? { stderrLimitBytes: spawnOptions.stderrLimitBytes }
          : {}),
      });
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      const failures: unknown[] = [];
      try {
        await samples.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        repos.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await hostEnv.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'P02-3 组合夹具回收存在未确认项');
      }
    },
  };
}
