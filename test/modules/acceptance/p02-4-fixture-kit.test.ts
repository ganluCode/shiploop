/**
 * F-002 P02-4 验收场景隔离夹具与证据快照自测（夹具能力的真实回归，不是产品实现）。
 *
 * 验收来源（F-002 四条验收标准）：
 * 1. 扩展既有 test/helpers：本次专属临时数据根、真实 Git 仓库及干净/脏文件变体；
 *    基线成功/固定非零退出/拒绝授权/可控挂起命令复用 P02-3 样例；不调用模型、
 *    不访问真实 HOME 或用户凭据；
 * 2. 两个真实 dist CLI 可通过现有同步屏障竞争连接同根：ready、身份查询、有限等待、
 *    实际退出核验；stdout/stderr 采集有大小上限，不只按成功文本判断业务完成；
 * 3. 可取得规范仓库身份、HEAD、Git 状态、tracked/untracked 文件内容摘要、非秘密
 *    Host 身份、操作/检查状态与输出制品摘要（供断言与报告导出）；数据库只经受控
 *    只读探针核对，不插入或修改业务状态；
 * 4. 夹具自测证明启动失败、屏障超时、断言失败仍回收已核验的自有进程；只清理本次
 *    授权临时根，拒绝未知路径/符号链接逃逸；停止未确认时保留资源与诊断，不删除
 *    仍可能被写入的目录。
 *
 * 本文件只使用 test/helpers 夹具面（p02-4 / p02-3 / p02-2 / host / git-repo）；
 * 竞争用例运行真实 `packages/cli/dist/bin.js`（beforeAll 构建），不连接真实模型。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  BarrierTimeoutError,
  COMMAND_SAMPLE_SCRIPT,
  NONZERO_EXIT_CODE,
  SafeCleanupError,
  createAcceptanceFixture,
  createStartBarrier,
  artifactContentDigest,
  assertDistCliBuilt,
  extractHostIdentity,
  extractOperationSnapshot,
  exportEvidenceDocument,
  openDataRootStorageProbe,
  scanForCredentialShapes,
  singleEnvelope,
  snapshotRepository,
  type AcceptanceFixture,
  type DistCliInput,
  type DistCliResult,
} from '../../helpers/p02-4/index.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

/** 有界轮询等待（不用固定 sleep）；超时即失败。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor 条件在 ${timeoutMs}ms 内未满足`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const activeFixtures: AcceptanceFixture[] = [];

function useFixture(): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix: 'shiploop-p02-4-kit-', stepMs: 200 });
  activeFixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  const pending = activeFixtures.splice(0);
  for (const fixture of pending) {
    if (!fixture.disposed) {
      await fixture.dispose();
    }
  }
});

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  assertDistCliBuilt();
}, 570_000);

/* ------------------------------------------------------------------ *
 * 验收 1：专属临时数据根、真实 Git 变体、P02-3 样例场景预设
 * ------------------------------------------------------------------ */

describe('F-002 隔离夹具：专属数据根、真实 Git 变体、P02-3 样例场景', () => {
  it('专属临时数据根与仓库位于本次沙箱内；子进程 env 不含真实 HOME/凭据', () => {
    const f = useFixture();
    const root = realpathSync(f.root);
    const realTmp = realpathSync(tmpdir());
    const realHome = realpathSync(homedir());

    expect(root === realTmp || root.startsWith(realTmp + '/')).toBe(true);
    expect(root.startsWith(realHome + '/')).toBe(false);
    expect(root.startsWith(REPO_ROOT + '/')).toBe(false);

    // 本次专属临时数据根：沙箱内、独立于其他夹具实例。
    const dataRoot = realpathSync(f.dataRoot());
    expect(dataRoot.startsWith(root + '/')).toBe(true);
    expect(existsSync(dataRoot)).toBe(true);

    // 白名单 env：HOME/TMPDIR 指向沙箱；真实 HOME 与任何凭据形状都不得出现。
    const env = f.childEnv();
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_NO_WARNINGS', 'PATH', 'TMPDIR']);
    expect(realpathSync(env.HOME as string).startsWith(root + '/')).toBe(true);
    expect(realpathSync(env.TMPDIR as string).startsWith(root + '/')).toBe(true);
    expect(Object.values(env)).not.toContain(realHome);
    for (const value of Object.values(env)) {
      expect(String(value)).not.toMatch(/api[_-]?key|token|credential/i);
    }

    // 仓库变体真实存在：干净（有 HEAD）与脏（tracked 修改 + untracked）各一。
    expect(f.repos.headOf('withHead')).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(f.repos.dirtyTrackedFile)).toBe(true);
    expect(existsSync(f.repos.dirtyUntrackedFile)).toBe(true);
  });

  it('干净/脏仓库快照：规范身份、HEAD、Git 状态原文、tracked/untracked 摘要真实且确定', () => {
    const f = useFixture();

    const clean = f.snapshotRepository(f.repos.withHead);
    expect(clean.canonicalPath).toBe(realpathSync(f.repos.withHead));
    expect(clean.headCommit).toBe(f.repos.headOf('withHead'));
    expect(clean.statusPorcelain.trim()).toBe('');
    expect(clean.untracked).toEqual([]);
    expect(clean.tracked.map((entry) => entry.relativePath)).toContain('src/index.ts');
    expect(clean.treeDigest).toMatch(/^[0-9a-f]{64}$/);

    const dirty = f.snapshotRepository(f.repos.dirty);
    expect(dirty.headCommit).toBe(f.repos.headOf('dirty'));
    expect(dirty.headCommit).not.toBe(clean.headCommit);
    // Git 状态原文：脏工作区含已跟踪修改与未跟踪文件。
    expect(dirty.statusPorcelain).toContain('src/tracked.ts');
    expect(dirty.statusPorcelain).toContain('untracked.txt');
    const trackedEntry = dirty.tracked.find((entry) => entry.relativePath === 'src/tracked.ts');
    expect(trackedEntry?.digest).toBe(
      snapshotRepository(f.repos.dirty).tracked.find(
        (entry) => entry.relativePath === 'src/tracked.ts',
      )?.digest,
    );
    // 摘要按文件真实字节计算（工作区内容，而非索引）。
    expect(trackedEntry?.digest).toMatch(/^[0-9a-f]{64}$/);
    const untrackedEntry = dirty.untracked.find((entry) => entry.relativePath === 'untracked.txt');
    expect(untrackedEntry?.sizeBytes).toBe('untracked\n'.length);

    // 确定性：同一仓库两次快照逐字段一致。
    expect(f.snapshotRepository(f.repos.dirty)).toEqual(dirty);
  });

  it('场景预设复用 P02-3 样例：成功/非零退出/拒绝授权/挂起映射期望检查状态', () => {
    const f = useFixture();

    const success = f.scenario('baselineSuccess');
    expect(success.sampleKey).toBe('success');
    expect(success.decision).toBe('authorize');
    expect(success.expectedCheckStatus).toBe('passed');
    expect(success.plan().checks[0]?.argv[1]).toBe(COMMAND_SAMPLE_SCRIPT.exitZero);

    const nonzero = f.scenario('nonzeroExit');
    expect(nonzero.sampleKey).toBe('nonzeroExit');
    expect(nonzero.expectedCheckStatus).toBe('failed');
    expect(nonzero.expectedReason).toBeNull();
    expect(nonzero.plan().checks[0]?.argv[1]).toBe(COMMAND_SAMPLE_SCRIPT.exitNonzero);
    expect(NONZERO_EXIT_CODE).toBeGreaterThan(0);

    const denied = f.scenario('deniedAuthorization');
    expect(denied.sampleKey).toBe('success');
    expect(denied.decision).toBe('decline');
    expect(denied.expectedCheckStatus).toBe('not_run');

    const hang = f.scenario('hang');
    expect(hang.sampleKey).toBe('hang');
    expect(hang.expectedCheckStatus).toBe('inconclusive');
    expect(hang.expectedReason).toBe('timed_out');
    expect(hang.plan().checks[0]?.argv[1]).toBe(COMMAND_SAMPLE_SCRIPT.hang);
    // 挂起命令超时可控（调用方决定预算）。
    expect(hang.plan({ timeoutMs: 1_500 }).checks[0]?.timeoutMs).toBe(1_500);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 2：两个真实 dist CLI 同步屏障竞争 + 有界输出 + 结构化完成判定
 * ------------------------------------------------------------------ */

describe('F-002 双真实 dist CLI 竞争（同步屏障、有界采集、结构化判定）', () => {
  it('两个真实 dist CLI 经同步屏障竞争连接同一数据根：唯一 Host、同一实例身份', async () => {
    const f = useFixture();
    const root = f.dataRoot();
    const inputs: DistCliInput[] = [0, 1].map((index) => ({
      args: ['host', 'start', '--data-root', root, '--json'],
      label: `race-cli-${index}`,
    }));

    const results = await f.raceDistClis(inputs);
    expect(results).toHaveLength(2);

    // ready/身份：两个真实 dist CLI 子进程身份互异且被核验。
    const identities = f.sessions.map((session) => session.identity());
    expect(identities[0]?.driverPid).not.toBe(identities[1]?.driverPid);
    expect(identities[0]?.grandchildPid).not.toBe(identities[1]?.grandchildPid);
    for (const identity of identities) {
      expect(identity.ready).toBeDefined();
      expect(pidAlive(identity.driverPid)).toBe(false); // 结果收齐后已核验退出
    }

    // 业务完成以退出码 + 结构化信封判定（不是成功文本）。
    const envelopes = results.map((result) => {
      expect(result.exitCode, result.stderr).toBe(0);
      return singleEnvelope(result);
    });
    for (const envelope of envelopes) {
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('host.start');
    }
    const hostResults = envelopes.map((envelope) => envelope.result as Record<string, unknown>);
    const instanceIds = new Set(hostResults.map((result) => result.hostInstanceId as string));
    const rootIdentities = new Set(hostResults.map((result) => result.dataRootIdentity as string));
    expect(instanceIds.size).toBe(1);
    expect(rootIdentities.size).toBe(1);
    const outcomes = hostResults.map((result) => result.outcome as string).sort();
    expect(['already_running', 'started']).toContain(outcomes[0]);
    expect(outcomes).toContain('started');
    for (const result of hostResults) {
      expect(result.listenAddress).toBe('127.0.0.1');
    }

    // 竞争后恰一个存活 Host（发现文件 pid 真实存活）。
    const hostPid = f.liveHostPid();
    expect(hostPid).not.toBeNull();
    expect(pidAlive(hostPid as number)).toBe(true);

    // 产品命令受控停止（三证据）后才允许回收临时根。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  });

  it('stdout/stderr 采集有大小上限并标记溢出；业务完成以退出码+信封判定而非成功文本', async () => {
    const f = useFixture();

    // 大量输出样例（复用 P02-3 largeOutput）：同一采集机制有界截断。
    const noisy: DistCliInput = {
      entryArgv: [process.execPath, COMMAND_SAMPLE_SCRIPT.largeOutput],
      args: [],
      label: 'bounded-capture',
      stdoutLimitBytes: 4_096,
      stderrLimitBytes: 4_096,
    };
    const noisyResult = await f.runDistCli(noisy.args, noisy);
    expect(noisyResult.exitCode, noisyResult.stderr).toBe(0);
    expect(noisyResult.outputOverflow).toBe(true);
    expect(noisyResult.stdoutBytes).toBeGreaterThan(4_096);
    expect(noisyResult.stdout.length).toBeLessThanOrEqual(4_096);
    expect(noisyResult.stderr.length).toBeLessThanOrEqual(4_096);

    // 业务完成判定：文本不作依据；以实际退出码 + 结构化信封为准。
    const f2 = useFixture();
    const missingPath = join(f2.root, 'missing-repo');
    const failed = await f2.runDistCli([
      'project',
      'init',
      missingPath,
      '--confirm',
      '--data-root',
      f2.dataRoot(),
      '--json',
    ]);
    expect(failed.exitCode).toBe(2); // 输入错误档（五档退出码冻结值）
    const envelope = singleEnvelope(failed);
    expect(envelope.ok).toBe(false);
    expect(typeof envelope.error?.code).toBe('string');
  });
});

/* ------------------------------------------------------------------ *
 * 验收 3：证据快照（仓库/Host/操作/制品/只读数据库）与报告导出
 * ------------------------------------------------------------------ */

describe('F-002 证据快照与受控只读核对', () => {
  it('非秘密 Host 身份快照可导出报告：不含 token/认证头/凭据形状', async () => {
    const f = useFixture();
    const root = f.dataRoot();

    const start = await f.runDistCli(['host', 'start', '--data-root', root, '--json']);
    expect(start.exitCode, start.stderr).toBe(0);
    const startEnvelope = singleEnvelope(start);
    const identity = extractHostIdentity(startEnvelope.result as Record<string, unknown>);
    expect(identity.hostInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity.dataRootIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.listenAddress).toBe('127.0.0.1');
    expect(Number.isInteger(identity.port)).toBe(true);

    // status 只读查询取得同一非秘密身份。
    const status = await f.runDistCli(['host', 'status', '--data-root', root, '--json']);
    const statusIdentity = extractHostIdentity(
      (singleEnvelope(status).result ?? {}) as Record<string, unknown>,
    );
    expect(statusIdentity.hostInstanceId).toBe(identity.hostInstanceId);
    expect(statusIdentity.dataRootIdentity).toBe(identity.dataRootIdentity);

    // 报告导出：结构化证据 + 凭据形状扫描 + 真实 token 不出现在导出文本。
    const document = exportEvidenceDocument({ hostIdentity: identity, notes: ['p02-4 kit'] });
    expect(scanForCredentialShapes(JSON.parse(document))).toEqual([]);
    const token = readFileSync(join(root, 'host', 'auth.token'), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(document).not.toContain(token);

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
  });

  it('操作/检查状态与输出制品摘要可取得；数据库只经受控只读探针核对', async () => {
    const f = useFixture();
    const root = f.dataRoot();

    const projectId = (
      (
        singleEnvelope(
          (
            await f.runDistCli([
              'project',
              'init',
              f.repos.withHead,
              '--confirm',
              '--name',
              'p02-4-kit',
              '--data-root',
              root,
              '--json',
            ])
          ),
        ).result as { registration: { projectId: string } }
      ).registration
    ).projectId;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    const planDir = join(f.root, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planFile = join(planDir, `smoke-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(
      planFile,
      JSON.stringify({ checks: f.scenario('baselineSuccess').plan().checks }),
      'utf8',
    );

    const run = await f.runDistCli([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      planFile,
      '--confirm',
      '--wait',
      '--data-root',
      root,
      '--json',
    ]);
    expect(run.exitCode, run.stderr).toBe(0);
    const runResult = singleEnvelope(run).result as Record<string, unknown>;
    const operationId = runResult.operationId as string;

    // 操作/检查状态快照（来自独立 status 查询）。
    const status = await f.runDistCli([
      'baseline',
      'status',
      operationId,
      '--data-root',
      root,
      '--json',
    ]);
    const operation = extractOperationSnapshot(
      singleEnvelope(status).result as Record<string, unknown>,
    );
    expect(operation.operationId).toBe(operationId);
    expect(operation.status).toBe('completed');
    expect(operation.state).toBe('passed');
    expect(operation.codeIdentity.headCommit).toBe(f.repos.headOf('withHead'));
    expect(operation.checks).toHaveLength(1);
    expect(operation.checks[0]?.status).toBe('passed');
    expect(operation.checks[0]?.exitCode).toBe(0);
    const artifact = operation.checks[0]?.output;
    expect(artifact?.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(artifact?.byteSize).toBeGreaterThan(0);

    // 输出制品摘要：正文经 artifacts.get 读取后稳定 sha256（两次一致）。
    const evidence = await f.runDistCli([
      'baseline',
      'evidence',
      artifact!.artifactId,
      '--data-root',
      root,
      '--json',
    ]);
    const content = (singleEnvelope(evidence).result as { content: string }).content;
    const digestA = artifactContentDigest(artifact!.artifactId, content);
    const digestB = artifactContentDigest(artifact!.artifactId, content);
    expect(digestA).toEqual(digestB);
    expect(digestA.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestA.sizeBytes).toBeGreaterThan(0);

    // 受控只读数据库核对：只读连接、只允许 SELECT/WITH，不插入或修改业务状态。
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.readonly).toBe(true);
      expect(probe.counts().projects).toBe(1);
      expect(probe.counts().repository_bindings).toBe(1);
      expect(() =>
        probe.selectAll("INSERT INTO projects (id) VALUES ('mutated')"),
      ).toThrow(TypeError);
    } finally {
      probe.close();
    }

    // 报告导出：仓库身份 + 操作/检查 + 制品摘要，凭据形状扫描为空。
    const repository = f.snapshotRepository(f.repos.withHead);
    const document = exportEvidenceDocument({
      repositories: [repository],
      operation,
      artifacts: [digestA],
    });
    const parsed = JSON.parse(document) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(scanForCredentialShapes(parsed)).toEqual([]);
    expect(document).not.toContain(readFileSync(join(root, 'host', 'auth.token'), 'utf8').trim());

    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 4：失败路径回收与安全清理（夹具自测）
 * ------------------------------------------------------------------ */

describe('F-002 夹具自测：失败回收、授权清理、停止未确认保留', () => {
  it('启动失败仍回收已核验的自有进程（driver 与失败的 dist 入口）', async () => {
    const f = useFixture();
    const badEntry = join(f.root, 'missing-dist-entry.js');
    const session = f.spawnDistCli({
      args: ['--json'],
      entryArgv: [process.execPath, badEntry],
      label: 'startup-failure',
    });
    const driverPid = session.identity().driverPid;

    // ready/身份核验后经同步屏障放行：真实入口启动失败仍产生实际退出结果。
    await session.waitReady(30_000);
    session.releaseGo();
    const result = await session.waitResult(30_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.spawnError ?? result.stderr.length).toBeTruthy();

    await f.dispose();
    expect(f.disposed).toBe(true);
    expect(pidAlive(driverPid)).toBe(false);
  });

  it('屏障超时后仍回收已核验的自有进程（不把未放行当作已退出）', async () => {
    const f = useFixture();
    const sessions = [0, 1].map((index) =>
      f.spawnDistCli({
        args: ['host', 'status', '--data-root', f.dataRoot(), '--json'],
        label: `barrier-timeout-${index}`,
      }),
    );
    await Promise.all(sessions.map((session) => session.waitReady(30_000)));

    // 第三方缺席：现有同步屏障有界超时，拒绝全部等待者。
    const barrier = createStartBarrier(3, { timeoutMs: 300 });
    await expect(barrier.arrive()).rejects.toBeInstanceOf(BarrierTimeoutError);
    expect(barrier.state).toBe('timed_out');

    const pids = sessions.map((session) => session.identity().driverPid);
    await f.dispose();
    for (const pid of pids) {
      expect(pidAlive(pid)).toBe(false);
    }
  });

  it('断言失败路径仍回收已核验的自有进程（finally 语义）', async () => {
    const f = useFixture();
    let samplePid = -1;
    try {
      const sample = f.spawnSample('hang');
      samplePid = sample.pid;
      // 模拟用例断言失败：错误抛出后由 finally 回收。
      expect({ ok: false }).toMatchObject({ ok: true });
    } catch (error) {
      expect((error as Error).name).toBe('AssertionError');
    } finally {
      await f.dispose();
    }
    expect(f.disposed).toBe(true);
    expect(samplePid).toBeGreaterThan(0);
    expect(pidAlive(samplePid)).toBe(false);
  });

  it('只清理本次授权临时根：拒绝未知路径', async () => {
    const f = useFixture();
    const unknown = join(tmpdir(), `shiploop-p02-4-unknown-${randomUUID().slice(0, 8)}`);
    mkdirSync(unknown, { recursive: true });
    try {
      expect(() => f.safeRemove(unknown)).toThrow(SafeCleanupError);
      try {
        f.safeRemove(unknown);
      } catch (error) {
        expect((error as SafeCleanupError).kind).toBe('not_authorized');
      }
      expect(existsSync(unknown)).toBe(true);
    } finally {
      rmSync(unknown, { recursive: true, force: true });
    }
    expect(existsSync(unknown)).toBe(false);
  });

  it('拒绝符号链接逃逸：dispose 保留目录，排除逃逸后才清理', async () => {
    const f = useFixture();
    const escape = join(f.root, 'escape-link');
    symlinkSync(REPO_ROOT, escape);

    await expect(f.dispose()).rejects.toMatchObject({ name: 'SafeCleanupError' });
    try {
      await f.dispose();
    } catch (error) {
      expect((error as SafeCleanupError).kind).toBe('symlink_escape');
    }
    // 拒绝删除：本次授权临时根与诊断保留（目录仍可能被写入）。
    expect(existsSync(f.root)).toBe(true);
    expect(existsSync(join(f.root, 'fixture-retained-diagnostics.json'))).toBe(true);

    rmSync(escape);
    await f.dispose();
    expect(f.disposed).toBe(true);
    expect(existsSync(f.root)).toBe(false);
  });

  it('停止未确认时保留资源与诊断，不删除仍可能被写入的目录', async () => {
    const f = useFixture();
    const sample = f.spawnSample('ignoreSigterm');
    // 不协作、不升级：退出无法核验（exit_unconfirmed）。
    await expect(
      f.dispose({ stop: { ipcClose: false, escalate: false, stepMs: 50 } }),
    ).rejects.toThrow(/未确认|unconfirmed/);

    // 资源与诊断保留：进程仍在、目录不删。
    expect(f.disposed).toBe(false);
    expect(pidAlive(sample.pid)).toBe(true);
    expect(existsSync(f.root)).toBe(true);
    const diagnostics = JSON.parse(
      readFileSync(join(f.root, 'fixture-retained-diagnostics.json'), 'utf8'),
    ) as { retainedAt: string; reasons: string[] };
    expect(diagnostics.reasons.join('\n')).toContain('exit_unconfirmed');
    expect(typeof diagnostics.retainedAt).toBe('string');

    // 升级收尾并核验退出后才允许删除（忽略 SIGTERM → SIGKILL）。
    await f.dispose();
    expect(f.disposed).toBe(true);
    expect(pidAlive(sample.pid)).toBe(false);
    expect(existsSync(f.root)).toBe(false);
  });
});
