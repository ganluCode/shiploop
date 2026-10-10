/**
 * F-002 P02-4 验收场景隔离夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 在既有积木之上为 P02-4 验收场景（F-003 ~ F-008 复用）提供集中持有的一处资源：
 * - 复用 p02-3 createBaselineFixture：临时沙箱 + 白名单 env + 规范数据根 + 真实
 *   Git 仓库变体（干净/脏文件）+ P02-3 命令样例 + 受管进程 + 脱敏证据日志；
 * - 本次专属临时数据根（dataRoot()，每次夹具实例全新、互不复用）；
 * - 场景预设：基线成功 / 固定非零退出 / 拒绝授权 / 可控挂起——命令全部复用
 *   P02-3 样例（单一事实来源），拒绝授权以 decision='decline' 表达（期望 not_run）；
 * - 真实 dist CLI 会话（spawnDistCli / runDistCli / raceDistClis）：ready、身份
 *   查询、有限等待、实际退出核验、有界输出采集、同步屏障竞争连接同根；
 * - 证据快照：仓库身份/HEAD/Git 状态/tracked+untracked 摘要、非秘密 Host 身份、
 *   操作/检查状态、输出制品摘要与稳定报告导出；数据库只经受控只读探针核对。
 *
 * 回收（fail-closed，F-002 验收 4）：
 * - 样例进程 → dist CLI 会话（driver + grandchild）→ 受管进程 → 数据根存活 Host
 *   逐项**核验退出**；任一未确认（exit_unconfirmed）即写 fixture-retained-diagnostics.json
 *   保留资源与诊断后聚合抛出——绝不删除仍可能被写入的目录；
 * - 全部停止确认后才经 safe-cleanup 删除本次授权临时根：拒绝未知路径（not_authorized）
 *   与符号链接逃逸（symlink_escape），删除后核验消失；
 * - dispose 失败后可修复原因再次 dispose（幂等重试）；成功后 disposed=true。
 *
 * 不调用模型、不访问真实 HOME/用户凭据、不触碰受测开发仓库。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BaselineCheckPlan,
  BaselineCheckStatus,
  BaselineReasonCode,
} from '../../../packages/core/src/ports/baseline.ts';
import { FixtureProcessError } from '../host/managed-child.ts';
import type { StopConfirmationOptions } from '../host/managed-child.ts';
import type { StorageProbe } from '../p02-2/storage-probe.ts';
import { createBaselineFixture, type BaselineFixture } from '../p02-3/baseline-fixture.ts';
import {
  commandSampleCheck,
  commandSampleExpectation,
  type CommandSampleKey,
} from '../p02-3/command-samples.ts';
import type { SampleProcess, SampleProcessOptions } from '../p02-3/process-tools.ts';
import { SafeCleanupError, safeRemoveTempRoot } from '../safe-cleanup.ts';
import {
  spawnDistCliSession,
  raceDistCliSessions,
  type DistCliInput,
  type DistCliRaceOptions,
  type DistCliResult,
  type DistCliSession,
} from './dist-cli-session.ts';
import {
  openDataRootStorageProbe,
  snapshotRepository,
  type RepositorySnapshot,
  type SnapshotRepositoryOptions,
} from './evidence-snapshot.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/* ------------------------------------------------------------------ *
 * 场景预设（命令复用 P02-3 样例；拒绝授权以 decline 决策表达）
 * ------------------------------------------------------------------ */

export type P024ScenarioKey = 'baselineSuccess' | 'nonzeroExit' | 'deniedAuthorization' | 'hang';

export const P024_SCENARIO_KEYS: readonly P024ScenarioKey[] = Object.freeze([
  'baselineSuccess',
  'nonzeroExit',
  'deniedAuthorization',
  'hang',
]);

export interface ScenarioPlanOptions {
  readonly checkKey?: string;
  /** 检查超时（挂起样例默认 2 000ms，其余默认 60 000ms；可控）。 */
  readonly timeoutMs?: number;
}

export interface ScenarioPreset {
  readonly key: P024ScenarioKey;
  /** 复用的 P02-3 命令样例键（拒绝授权为 success 样例 + decline 决策）。 */
  readonly sampleKey: CommandSampleKey;
  /** 授权决策：decline = 用户拒绝授权（检查 not_run、零启动）。 */
  readonly decision: 'authorize' | 'decline';
  readonly expectedCheckStatus: BaselineCheckStatus;
  readonly expectedReason: BaselineReasonCode | null;
  /** 组装 §6.1 检查计划（argv 来自 P02-3 样例描述符）。 */
  plan(options?: ScenarioPlanOptions): BaselineCheckPlan;
}

const SCENARIO_SAMPLE: Readonly<Record<P024ScenarioKey, CommandSampleKey>> = Object.freeze({
  baselineSuccess: 'success',
  nonzeroExit: 'nonzeroExit',
  deniedAuthorization: 'success',
  hang: 'hang',
});

function scenarioFor(key: P024ScenarioKey): ScenarioPreset {
  const sampleKey = SCENARIO_SAMPLE[key];
  const declined = key === 'deniedAuthorization';
  const expectation = declined
    ? { status: 'not_run' as BaselineCheckStatus, reason: undefined }
    : commandSampleExpectation(sampleKey);
  return {
    key,
    sampleKey,
    decision: declined ? 'decline' : 'authorize',
    expectedCheckStatus: expectation.status,
    expectedReason: expectation.reason ?? null,
    plan(options: ScenarioPlanOptions = {}): BaselineCheckPlan {
      return {
        checks: [
          commandSampleCheck(sampleKey, {
            timeoutMs: options.timeoutMs ?? (key === 'hang' ? 2_000 : 60_000),
            ...(options.checkKey !== undefined ? { checkKey: options.checkKey } : {}),
          }),
        ],
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 组合夹具
 * ------------------------------------------------------------------ */

export interface AcceptanceFixtureOptions {
  readonly prefix?: string;
  readonly stepMs?: number;
  readonly extraSecrets?: readonly string[];
  /** 本次专属数据根名（默认 'p02-4'；每个夹具实例的沙箱全新）。 */
  readonly dataRootName?: string;
}

export interface DisposeOptions {
  /** 停止/退出核验选项（默认 {stepMs} 有界升级）。 */
  readonly stop?: StopConfirmationOptions;
}

export interface RunDistCliOptions extends Omit<DistCliInput, 'args'> {
  readonly readyTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
}

export interface AcceptanceFixture {
  readonly root: string;
  readonly homeDir: string;
  readonly repos: BaselineFixture['repos'];
  readonly evidence: BaselineFixture['evidence'];
  readonly sessions: readonly DistCliSession[];
  readonly disposed: boolean;
  /** 白名单 env（HOME/TMPDIR 指向沙箱）；真实凭据环境不透传。 */
  childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  /** 本次专属临时数据根（规范 realpath）。 */
  dataRoot(name?: string): string;
  /** 场景预设（复用 P02-3 样例）。 */
  scenario(key: P024ScenarioKey): ScenarioPreset;
  /** 运行 P02-3 命令样例（有界采集 + 退出核验）。 */
  spawnSample(key: CommandSampleKey, options?: Partial<SampleProcessOptions>): SampleProcess;
  /** 准备一个真实 dist CLI 会话（ready/go 屏障由调用方控制）。 */
  spawnDistCli(input: DistCliInput): DistCliSession;
  /** 单个真实 dist CLI 调用：ready → 放行 → 有限等待结果 → 实际退出核验。 */
  runDistCli(args: readonly string[], options?: RunDistCliOptions): Promise<DistCliResult>;
  /** 多个真实 dist CLI 同步竞争连接同根；结果收齐后逐一实际退出核验。 */
  raceDistClis(inputs: readonly DistCliInput[], options?: DistCliRaceOptions): Promise<DistCliResult[]>;
  /** 数据根发现文件中的存活 Host pid（非秘密；无/已退出为 null）。 */
  liveHostPid(name?: string): number | null;
  /** 经产品命令受控停止数据根 Host（三证据）。 */
  stopHost(name?: string): Promise<DistCliResult>;
  /** 仓库证据快照（注入沙箱隔离 HOME）。 */
  snapshotRepository(repoPath: string, options?: SnapshotRepositoryOptions): RepositorySnapshot;
  /** 受控只读数据库探针（绝不写业务状态）。 */
  storageProbe(name?: string): StorageProbe;
  /** 只清理本次授权临时根：拒绝未知路径/符号链接逃逸。 */
  safeRemove(target: string): void;
  /** 回收（失败即保留资源与诊断，可修复后重试）。 */
  dispose(options?: DisposeOptions): Promise<void>;
}

function describeFailures(failures: readonly unknown[]): string[] {
  const lines: string[] = [];
  const visit = (error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) {
        visit(nested);
      }
      return;
    }
    if (error instanceof FixtureProcessError) {
      lines.push(`${error.reason}: ${error.message}`);
      return;
    }
    if (error instanceof SafeCleanupError) {
      lines.push(`${error.kind}: ${error.message}`);
      return;
    }
    if (error instanceof Error) {
      lines.push(`${error.name}: ${error.message}`);
      return;
    }
    lines.push(String(error));
  };
  for (const error of failures) {
    visit(error);
  }
  return lines;
}

export function createAcceptanceFixture(options: AcceptanceFixtureOptions = {}): AcceptanceFixture {
  const inner = createBaselineFixture({
    prefix: options.prefix ?? 'shiploop-p02-4-',
    ...(options.stepMs !== undefined ? { stepMs: options.stepMs } : {}),
    ...(options.extraSecrets !== undefined ? { extraSecrets: options.extraSecrets } : {}),
  });
  const root = inner.root;
  const defaultStop: StopConfirmationOptions = { stepMs: options.stepMs ?? 1_000 };
  const defaultDataRootName = options.dataRootName ?? 'p02-4';
  const touchedDataRoots = new Set<string>();
  const sessions: DistCliSession[] = [];
  let disposed = false;

  function dataRootPath(name: string): string {
    touchedDataRoots.add(name);
    return inner.dataRoot(name);
  }

  function liveHostPid(name: string): number | null {
    const discoveryFile = join(dataRootPath(name), 'host', 'discovery.json');
    if (!existsSync(discoveryFile)) {
      return null;
    }
    try {
      const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as { pid?: unknown };
      const pid = discovery.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return null;
      }
      process.kill(pid, 0);
      return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return null;
      }
      return null;
    }
  }

  function writeRetainedDiagnostics(failures: readonly unknown[]): string {
    const path = join(root, 'fixture-retained-diagnostics.json');
    const diagnostics = {
      retainedAt: new Date().toISOString(),
      sandboxRoot: root,
      reasons: describeFailures(failures),
    };
    writeFileSync(path, JSON.stringify(diagnostics, null, 2), 'utf8');
    // 证据事件脱敏后记录（REPO_ROOT/真实 HOME 为受保护串）；脱敏拒绝不得
    // 覆盖真实回收失败——诊断文件已保留原文。
    try {
      inner.evidence.record('fixture.retained', {
        reasons: diagnostics.reasons.map((line) =>
          line.split(REPO_ROOT).join('<protected>').split(homedir()).join('<protected>'),
        ),
      });
    } catch {
      // 脱敏拒绝：只影响证据事件，不影响保留/抛错语义。
    }
    return path;
  }

  const fixture: AcceptanceFixture = {
    root,
    homeDir: inner.homeDir,
    repos: inner.repos,
    evidence: inner.evidence,
    sessions,
    get disposed(): boolean {
      return disposed;
    },

    childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
      return inner.childEnv(overrides);
    },

    dataRoot(name: string = defaultDataRootName): string {
      return dataRootPath(name);
    },

    scenario(key: P024ScenarioKey): ScenarioPreset {
      return scenarioFor(key);
    },

    spawnSample(key: CommandSampleKey, spawnOptions: Partial<SampleProcessOptions> = {}): SampleProcess {
      return inner.spawnSample(key, spawnOptions);
    },

    spawnDistCli(input: DistCliInput): DistCliSession {
      const session = spawnDistCliSession(inner.hostProcesses, {
        ...input,
        cwd: input.cwd ?? root,
        childEnv: input.childEnv ?? inner.childEnv(),
        requireInside: input.requireInside ?? root,
      });
      sessions.push(session);
      return session;
    },

    async runDistCli(args: readonly string[], runOptions: RunDistCliOptions = {}): Promise<DistCliResult> {
      const { readyTimeoutMs, resultTimeoutMs, ...input } = runOptions;
      const session = fixture.spawnDistCli({ ...input, args });
      await session.waitReady(readyTimeoutMs ?? 15_000);
      session.releaseGo();
      const result = await session.waitResult(resultTimeoutMs ?? 120_000);
      await session.verifyStopped(defaultStop);
      return result;
    },

    async raceDistClis(
      inputs: readonly DistCliInput[],
      raceOptions: DistCliRaceOptions = {},
    ): Promise<DistCliResult[]> {
      const prepared = inputs.map((input) => fixture.spawnDistCli(input));
      const results = await raceDistCliSessions(prepared, raceOptions);
      await Promise.all(prepared.map((session) => session.verifyStopped(defaultStop)));
      return results;
    },

    liveHostPid(name: string = defaultDataRootName): number | null {
      return liveHostPid(name);
    },

    async stopHost(name: string = defaultDataRootName): Promise<DistCliResult> {
      return fixture.runDistCli(['host', 'stop', '--data-root', dataRootPath(name), '--json']);
    },

    snapshotRepository(repoPath: string, snapshotOptions: SnapshotRepositoryOptions = {}): RepositorySnapshot {
      return snapshotRepository(repoPath, { homeDir: inner.homeDir, ...snapshotOptions });
    },

    storageProbe(name: string = defaultDataRootName): StorageProbe {
      return openDataRootStorageProbe(dataRootPath(name));
    },

    safeRemove(target: string): void {
      safeRemoveTempRoot(target, {
        authorizedRoot: root,
        protectedPaths: [REPO_ROOT, homedir()],
      });
    },

    async dispose(disposeOptions: DisposeOptions = {}): Promise<void> {
      if (disposed) {
        return;
      }
      const stop = disposeOptions.stop ?? defaultStop;
      const failures: unknown[] = [];

      // 1) 样例命令进程（有界升级并核验退出）。
      try {
        await inner.samples.dispose(stop);
      } catch (error) {
        failures.push(error);
      }
      // 2) 真实 dist CLI 会话：driver + grandchild 逐一实际退出核验。
      for (const session of sessions) {
        try {
          await session.verifyStopped(stop);
        } catch (error) {
          failures.push(error);
        }
      }
      // 3) 其余受管 IPC 子进程。
      try {
        await inner.hostProcesses.dispose(stop);
      } catch (error) {
        failures.push(error);
      }
      // 4) 数据根仍有存活 Host（可能继续写入）＝停止未确认。
      for (const name of touchedDataRoots) {
        const pid = liveHostPid(name);
        if (pid !== null) {
          failures.push(
            new FixtureProcessError(
              'exit_unconfirmed',
              `数据根 ${name} 的 Host 进程 ${pid} 仍在运行（目录仍可能被写入）`,
              { label: 'host', pid },
            ),
          );
        }
      }

      if (failures.length > 0) {
        writeRetainedDiagnostics(failures);
        throw new AggregateError(
          failures,
          'P02-4 夹具回收未确认：已保留临时根与诊断（目录仍可能被写入，不删除）',
        );
      }

      // 全部自有进程核验退出后，才经安全清理守卫删除本次授权临时根。
      try {
        safeRemoveTempRoot(root, { authorizedRoot: root, protectedPaths: [REPO_ROOT, homedir()] });
      } catch (error) {
        writeRetainedDiagnostics([error]);
        throw error;
      }
      await inner.dispose(); // 沙箱已删：内部按幂等收尾（不重复删除）。
      disposed = true;
    },
  };

  return fixture;
}
