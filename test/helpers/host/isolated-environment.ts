/**
 * F-005 隔离 Host 测试环境（仅测试夹具）。
 *
 * 一个 createIsolatedHostEnvironment 调用集中持有本次测试的全部资源：
 * - 临时沙箱（复用 test/helpers/temp-sandbox.ts，拒绝落在受测仓库/HOME 内），
 *   独立的 home/tmp/data 子目录；数据根经 F-003 resolveCanonicalDataRoot 固定；
 * - 白名单构造的子进程 env：只保留 PATH，HOME/TMPDIR 重定向到沙箱，不透传
 *   NODE_OPTIONS、API key 等任何父进程环境；
 * - 受管子进程监督器与伪服务列表，dispose() 按「服务 → 进程（有界升级并核验
 *   退出）→ 沙箱目录（核验消失）」顺序回收，断言失败的 finally 同样适用；
 * - 脱敏证据日志：真实 HOME、受测仓库路径自动登记为受保护字符串，发行的
 *   伪凭据自动登记为秘密。
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolveCanonicalDataRoot, type CanonicalDataRoot } from '../../../packages/host/src/index.ts';
import { createTempSandbox, type TempSandbox } from '../temp-sandbox.ts';
import {
  createProcessSupervisor,
  type ManagedChild,
  type ProcessSupervisor,
  type StopConfirmationOptions,
} from './managed-child.ts';
import { createEvidenceLog, type EvidenceLog } from './evidence.ts';
import {
  startFakeHostServer,
  type FakeHostServer,
  type FakeServerBehavior,
} from './fake-host-server.ts';
import {
  mintHostCredential,
  publishLoopbackDiscovery,
  type MintedHostCredential,
  type PublishedLoopbackDiscovery,
  type PublishLoopbackDiscoveryInput,
} from './discovery-fixture.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_CHILD_SCRIPT = fileURLToPath(new URL('./fixture-child.ts', import.meta.url));

export interface IsolatedEnvironmentOptions {
  readonly prefix?: string;
  readonly extraSecrets?: readonly string[];
  readonly stepMs?: number;
}

export interface SpawnFixtureChildOptions {
  readonly label?: string;
  readonly config?: Record<string, unknown>;
  readonly cwd?: string;
  readonly readyTimeoutMs?: number;
}

export interface IsolatedHostEnvironment {
  readonly sandboxRoot: string;
  readonly evidence: EvidenceLog;
  readonly processes: ProcessSupervisor;
  /** 在沙箱 data/<name> 下创建并固定规范数据根。 */
  dataRoot(name?: string): CanonicalDataRoot;
  /** 白名单 env（默认 HOME/TMPDIR 指向沙箱）；任何真实凭据环境都不透传。 */
  childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  spawnFixtureChild(scenario: string, options?: SpawnFixtureChildOptions): ManagedChild;
  mintHostCredential(canonicalRoot: string): MintedHostCredential;
  /** 经生产存储路径发布合法发现（透传夹具完整入参，含诊断 pid）。 */
  publishLoopbackDiscovery(input: PublishLoopbackDiscoveryInput): PublishedLoopbackDiscovery;
  startFakeServer(behavior: FakeServerBehavior): Promise<FakeHostServer>;
  dispose(): Promise<void>;
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function createIsolatedHostEnvironment(
  options: IsolatedEnvironmentOptions = {},
): IsolatedHostEnvironment {
  const sandbox: TempSandbox = createTempSandbox(options.prefix ?? 'shiploop-host-test-', {
    outside: [REPO_ROOT],
  });
  const sandboxRoot = realpathSync(sandbox.path);
  const homeDir = join(sandboxRoot, 'home');
  const tmpDir = join(sandboxRoot, 'tmp');
  const dataDir = join(sandboxRoot, 'data');
  mkdirSync(homeDir, { mode: 0o700 });
  mkdirSync(tmpDir, { mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });

  const protectedStrings = [REPO_ROOT];
  const realHome = realPathOrUndefined(homedir());
  if (realHome && realHome !== sandboxRoot) {
    protectedStrings.push(realHome);
  }
  const evidence = createEvidenceLog({
    secrets: options.extraSecrets,
    protectedStrings,
  });

  const defaultStop: StopConfirmationOptions = { stepMs: options.stepMs ?? 1_000 };
  const processes = createProcessSupervisor({ evidence, defaultStop });
  const servers: FakeHostServer[] = [];
  const dataRoots = new Map<string, CanonicalDataRoot>();
  let disposed = false;

  return {
    sandboxRoot,
    evidence,
    processes,

    dataRoot(name = 'default'): CanonicalDataRoot {
      const existing = dataRoots.get(name);
      if (existing) {
        return existing;
      }
      const path = join(dataDir, name);
      mkdirSync(path, { mode: 0o700 });
      const canonical = resolveCanonicalDataRoot({ dataRoot: path });
      dataRoots.set(name, canonical);
      return canonical;
    },

    childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
      // 显式白名单：不展开 ...process.env，避免真实凭据/NODE_OPTIONS 泄漏给子进程。
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: homeDir,
        TMPDIR: tmpDir,
        NODE_NO_WARNINGS: '1',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
      return env;
    },

    spawnFixtureChild(scenario: string, spawnOptions: SpawnFixtureChildOptions = {}): ManagedChild {
      return processes.spawn({
        scriptPath: FIXTURE_CHILD_SCRIPT,
        config: { scenario, ...spawnOptions.config },
        cwd: spawnOptions.cwd ?? sandboxRoot,
        env: this.childEnv(),
        label: spawnOptions.label ?? scenario,
        readyTimeoutMs: spawnOptions.readyTimeoutMs,
        requireInside: sandboxRoot,
        evidence,
      });
    },

    mintHostCredential(canonicalRoot: string): MintedHostCredential {
      const credential = mintHostCredential(canonicalRoot);
      evidence.registerSecret(credential.token);
      return credential;
    },

    publishLoopbackDiscovery(input): PublishedLoopbackDiscovery {
      const published = publishLoopbackDiscovery(input);
      return published;
    },

    async startFakeServer(behavior: FakeServerBehavior): Promise<FakeHostServer> {
      evidence.registerSecret(behavior.expectedToken);
      const server = await startFakeHostServer(behavior, { evidence });
      servers.push(server);
      return server;
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      const failures: unknown[] = [];
      await Promise.all(
        servers.map(async (server) => {
          try {
            await server.close();
          } catch (error) {
            failures.push(error);
          }
        }),
      );
      try {
        await processes.dispose(defaultStop);
      } catch (error) {
        failures.push(error);
      }
      // 所有进程退出后才删除沙箱：删除成功即核验目录消失（temp-sandbox fail-closed）。
      if (existsSync(sandboxRoot)) {
        try {
          sandbox.cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, '隔离环境回收存在未确认项');
      }
    },
  };
}
