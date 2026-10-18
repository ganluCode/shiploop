/**
 * F-003 P02-3 基线检查夹具套件自测（夹具能力的真实回归，不是产品实现）。
 *
 * 验收来源（F-003 四条验收标准）：
 * 1. 复用临时沙箱/SQLite/Git/Host-CLI 夹具，准备有 HEAD、无初始 commit、
 *    tracked/untracked 脏文件、同 remote 不同 clone、路径别名仓库；不读真实凭据、
 *    不操作开发仓库或用户 HOME；
 * 2. 提供实际 Node 命令样例（成功/非零/缺命令/未知 script/挂起/忽略 SIGTERM/
 *    派生持续写入子进程/大量输出/修改受检源码）；恶意初始化脚本仅写临时哨兵，
 *    断言静态 inspect 绝不执行它；
 * 3. 提供有界竞争屏障、进程身份/退出核验、文件内容摘要与脱敏证据工具；断言失败
 *    或外层超时也只回收已核验的自有资源，绝不把探测失败当作进程已停止；
 * 4. 夹具自测覆盖启动失败、屏障超时及子进程退出；故障注入可验证输出发布/
 *    数据库收尾失败；普通测试不调用真实模型。
 *
 * 本文件只使用 test/helpers 夹具面（p02-3 / p02-2 / host / git-repo），
 * 不连接真实模型、不要求 dist，spawn 的真实子进程均带重定向 HOME/TMPDIR。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASELINE_CHECK_OUTPUT_MAX_BYTES,
  baselineCheckStatusForReason,
  validateBaselineCheckPlan,
} from '../../../packages/core/src/ports/baseline.ts';
import { isArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';
import {
  COMMAND_SAMPLES,
  COMMAND_SAMPLE_KEYS,
  COMMAND_SAMPLE_SCRIPT,
  BarrierTimeoutError,
  commandSampleCheck,
  commandSampleExpectation,
  confirmProcessExit,
  createBaselineFixture,
  createStartBarrier,
  digestFile,
  digestWorkingTree,
  installDatabaseFinalizationFault,
  isMissingCommandExecutableAbsent,
  runWithStartBarrier,
  spawnSampleProcess,
  type BaselineFixture,
} from '../../helpers/p02-3/index.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { EvidenceSecretLeakError } from '../../helpers/host/index.ts';
import { git } from '../../helpers/git-repo.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 合成凭据哨兵：任何错误/证据文本都不得回显。 */
const SECRET_SENTINEL = 'credref-f003-top-secret-sentinel';

/** 有界轮询等待（不用固定 sleep）；超时即失败。 */
async function viWaitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`viWaitFor 条件在 ${timeoutMs}ms 内未满足`);
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

let fixture: BaselineFixture | undefined;
function useFixture(): BaselineFixture {
  fixture = createBaselineFixture({ prefix: 'shiploop-p02-3-kit-', stepMs: 100 });
  return fixture;
}

afterEach(async () => {
  const active = fixture;
  fixture = undefined;
  await active?.dispose();
});

/* ------------------------------------------------------------------ *
 * 1. 临时沙箱与真实仓库变体
 * ------------------------------------------------------------------ */

describe('F-003 临时沙箱与真实仓库变体', () => {
  it('沙箱在系统临时目录内且独立于开发仓库/HOME', () => {
    const f = useFixture();
    const realTmp = realpathSync(tmpdir());
    const realHome = realpathSync(homedir());
    const root = realpathSync(f.root);
    expect(root === realTmp || root.startsWith(realTmp + '/')).toBe(true);
    expect(root.startsWith(realHome + '/')).toBe(false);
    expect(root.startsWith(realpathSync(REPO_ROOT) + '/')).toBe(false);
    expect(realpathSync(f.homeDir).startsWith(root + '/')).toBe(true);
    expect(realpathSync(f.dataRoot()).startsWith(root + '/')).toBe(true);
  });

  it('仓库变体：HEAD/无 commit/脏工作区/同 remote clone/路径别名/恶意初始化脚本', () => {
    const f = useFixture();
    const { repos } = f;
    const gitOptions = { home: f.homeDir };

    // 有 HEAD：干净、真实 commit。
    expect(repos.headOf('withHead')).toMatch(/^[0-9a-f]{40}$/);
    expect(git(['status', '--porcelain'], repos.withHead, gitOptions).trim()).toBe('');

    // 无初始 commit：不猜分支，headCommit=null。
    expect(repos.headOf('noInitialCommit')).toBeNull();

    // 脏工作区：有 HEAD，且含已跟踪改动 + 未跟踪新文件（原样保留）。
    expect(repos.headOf('dirty')).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(repos.dirtyTrackedFile, 'utf8')).toContain('modified');
    expect(existsSync(repos.dirtyUntrackedFile)).toBe(true);
    expect(git(['status', '--porcelain'], repos.dirty, gitOptions).trim().length).toBeGreaterThan(0);

    // 同 remote 的两个 clone：remote URL 相同，真实目录不同。
    expect(repos.remoteOf('cloneA')).toBe(repos.remoteOf('cloneB'));
    expect(repos.remoteOf('cloneA')).toContain('origin.git');
    expect(realpathSync(repos.cloneA)).not.toBe(realpathSync(repos.cloneB));

    // 路径别名：符号链接解析为同一仓库。
    expect(realpathSync(repos.alias)).toBe(realpathSync(repos.withHead));

    // 恶意初始化脚本：脚本与 hooks 真实存在；哨兵尚未产生（未被执行）。
    expect(existsSync(repos.maliciousScriptPath)).toBe(true);
    expect(readFileSync(join(repos.malicious, 'package.json'), 'utf8')).toContain('postinstall');
    expect(existsSync(repos.maliciousSentinelPath)).toBe(false);
  });

  it('自建沙箱 dispose 后核验消失且幂等；复用外部沙箱只删除自建 repos 子目录', async () => {
    const f = createBaselineFixture({ prefix: 'shiploop-p02-3-dispose-' });
    const root = f.root;
    const reposDir = join(root, 'repos');
    expect(existsSync(reposDir)).toBe(true);
    await f.dispose();
    expect(existsSync(root)).toBe(false);
    await expect(f.dispose()).resolves.toBeUndefined();

    // 复用外部沙箱：repos.dispose 只删自建 repos 子目录，外部根保留（由外部负责）。
    const external = createBaselineFixture({ prefix: 'shiploop-p02-3-reuse-' });
    const externalRoot = external.root;
    expect(existsSync(join(externalRoot, 'repos'))).toBe(true);
    external.repos.dispose();
    expect(existsSync(join(externalRoot, 'repos'))).toBe(false);
    expect(existsSync(externalRoot)).toBe(true);
    await external.dispose();
  });
});

/* ------------------------------------------------------------------ *
 * 2. 命令样例（真实 Node 命令）
 * ------------------------------------------------------------------ */

describe('F-003 命令样例（真实 Node 命令）', () => {
  it('全部样例可组装为合法 §6.1 检查计划，且期望状态与 §8.3 映射一致', () => {
    const checks = COMMAND_SAMPLE_KEYS.map((key) => commandSampleCheck(key));
    const plan = validateBaselineCheckPlan({ checks });
    expect(plan.checks).toHaveLength(COMMAND_SAMPLE_KEYS.length);
    // checkKey 默认取描述符的规范 checkKey（§6.1 小写模式），非原始 camelCase key。
    expect(plan.checks.map((check) => check.checkKey)).toEqual(
      COMMAND_SAMPLE_KEYS.map((key) => COMMAND_SAMPLES[key].checkKey),
    );
    for (const check of plan.checks) {
      expect(check.checkKey).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    }
    for (const key of COMMAND_SAMPLE_KEYS) {
      const expectation = commandSampleExpectation(key);
      if (expectation.reason !== undefined) {
        expect(baselineCheckStatusForReason(expectation.reason)).toBe(expectation.status);
      }
    }
  });

  it('成功命令：退出码 0，stdout=sample-ok，期望 passed', async () => {
    const f = useFixture();
    const process_ = f.spawnSample('success');
    const exit = await process_.waitExit(10_000);
    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(process_.stdout).toContain('sample-ok');
    expect(commandSampleExpectation('success')).toEqual({ status: 'passed' });
  });

  it('非零退出：真实退出码被记录（默认 3，可覆盖），期望 failed 且无原因码', async () => {
    const f = useFixture();
    const process_ = f.spawnSample('nonzeroExit');
    expect(await process_.waitExit(10_000)).toMatchObject({ code: 3, signal: null });
    expect(process_.stderr).toContain('sample-nonzero-exit:3');

    const overridden = spawnSampleProcess({
      argv: COMMAND_SAMPLES.nonzeroExit.argv(['7']),
      cwd: f.root,
      env: f.childEnv(),
    });
    expect(await overridden.waitExit(10_000)).toMatchObject({ code: 7, signal: null });
    expect(commandSampleExpectation('nonzeroExit')).toEqual({ status: 'failed' });
  });

  it('缺命令：spawn ENOENT（启动失败），期望 error + missing_command', async () => {
    const f = useFixture();
    expect(isMissingCommandExecutableAbsent()).toBe(true);
    const process_ = f.spawnSample('missingCommand');
    await process_.waitExit(5_000);
    expect(process_.spawnError?.code).toBe('ENOENT');
    expect(process_.isAlive()).toBe(false);
    expect(commandSampleExpectation('missingCommand')).toEqual({ status: 'error', reason: 'missing_command' });
  });

  it('未知 package script：node --run <未知>，期望 error + unknown_script', async () => {
    const f = useFixture();
    const process_ = f.spawnSample('unknownPackageScript', { cwd: f.repos.withHead });
    const exit = await process_.waitExit(10_000);
    expect(exit).toMatchObject({ code: 1 });
    expect(process_.stderr).toContain('Missing script');
    expect(commandSampleExpectation('unknownPackageScript')).toEqual({
      status: 'error',
      reason: 'unknown_script',
    });
  });

  it('挂起：永不退出，超时判 inconclusive/timed_out；探测超时不杀进程', async () => {
    const f = useFixture();
    const process_ = f.spawnSample('hang');
    await viWaitFor(() => process_.stdout.includes('sample-hang'), 5_000);
    expect(await process_.waitExit(300)).toBeNull();
    expect(process_.isAlive()).toBe(true);
    const stopped = await process_.verifyStopped({ stepMs: 200 });
    expect(stopped.signal).toBe('SIGTERM');
    expect(process_.isAlive()).toBe(false);
    expect(commandSampleExpectation('hang')).toEqual({ status: 'inconclusive', reason: 'timed_out' });
  });

  it('忽略 SIGTERM：SIGTERM 无效后升级到 SIGKILL 并核验退出', async () => {
    const f = useFixture();
    const process_ = f.spawnSample('ignoreSigterm');
    await viWaitFor(() => process_.stdout.includes('sample-ignore-sigterm'), 5_000);
    const stopped = await process_.verifyStopped({ stepMs: 120 });
    expect(stopped.escalated).toContain('SIGTERM');
    expect(stopped.signal).toBe('SIGKILL');
    expect(process_.isAlive()).toBe(false);
    expect(commandSampleExpectation('ignoreSigterm')).toEqual({
      status: 'inconclusive',
      reason: 'stop_unconfirmed',
    });
  });

  it('派生持续写入子进程：杀父进程不停孙进程，须核验整棵进程树', async () => {
    const f = useFixture();
    const writeDir = join(f.root, 'spawn-writer-dir');
    const parent = spawnSampleProcess({
      argv: COMMAND_SAMPLES.spawnWriter.argv([writeDir]),
      cwd: f.root,
      env: f.childEnv(),
    });
    let grandchildPid = -1;
    try {
      await viWaitFor(() => /spawn-writer-child-pid:\d+/.test(parent.stdout), 5_000);
      grandchildPid = Number(/spawn-writer-child-pid:(\d+)/.exec(parent.stdout)![1]);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(grandchildPid).not.toBe(parent.pid);

      // 父进程对 SIGTERM 敏感 → 可被停止；但孙进程不受影响，仍在持续写入。
      const parentExit = await parent.verifyStopped({ stepMs: 200 });
      expect(parentExit.signal).toBe('SIGTERM');
      expect(parent.isAlive()).toBe(false);

      // 孙进程仍在写入（杀掉父进程不足以停止进程树）。
      await viWaitFor(() => existsSync(join(writeDir, 'child-write-1.txt')), 5_000);
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();

      // 显式终止孙进程并核验其确实退出（不把探测失败当作已停止）。
      process.kill(grandchildPid, 'SIGKILL');
      await viWaitFor(() => {
        try {
          process.kill(grandchildPid, 0);
          return false;
        } catch {
          return true;
        }
      }, 5_000);
      grandchildPid = -1;
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // 已退出。
        }
      }
    }
  });

  it('大量输出：真实产出字节数；有界采集截断并标记溢出（含超过契约上限）', async () => {
    const f = useFixture();
    // 1) 采集上限充足：字节数精确。
    const exact = f.spawnSample('largeOutput', {
      argv: COMMAND_SAMPLES.largeOutput.argv(['200000', '200000']),
      stdoutLimitBytes: 262_144,
      stderrLimitBytes: 262_144,
    });
    expect(await exact.waitExit(15_000)).toMatchObject({ code: 0 });
    expect(exact.stdoutBytes).toBe(200_000);
    expect(exact.stderrBytes).toBe(200_000);
    expect(exact.outputOverflow).toBe(false);

    // 2) 采集上限很小：有界截断 + 溢出标记（内存不随输出增长）。
    const bounded = f.spawnSample('largeOutput', {
      argv: COMMAND_SAMPLES.largeOutput.argv(['100000', '100000']),
      stdoutLimitBytes: 4_096,
      stderrLimitBytes: 4_096,
    });
    expect(await bounded.waitExit(15_000)).toMatchObject({ code: 0 });
    expect(bounded.stdoutBytes).toBe(100_000);
    expect(bounded.stdout.length).toBeLessThanOrEqual(4_096);
    expect(bounded.outputOverflow).toBe(true);

    // 3) 超过契约单检查输出上限（8 MiB）的场景可复现。
    const overLimit = f.spawnSample('largeOutput', {
      argv: COMMAND_SAMPLES.largeOutput.argv([String(BASELINE_CHECK_OUTPUT_MAX_BYTES + 1), '0']),
      stdoutLimitBytes: 1_024,
      stderrLimitBytes: 1_024,
    });
    expect(await overLimit.waitExit(30_000)).toMatchObject({ code: 0 });
    expect(overLimit.stdoutBytes).toBeGreaterThan(BASELINE_CHECK_OUTPUT_MAX_BYTES);
    expect(overLimit.outputOverflow).toBe(true);
    expect(commandSampleExpectation('largeOutput')).toEqual({
      status: 'inconclusive',
      reason: 'output_overflow',
    });
  }, 60_000);

  it('修改受检源码：运行期间工作区变化 → 代码身份摘要变化', async () => {
    const f = useFixture();
    const target = join(f.repos.withHead, 'src', 'index.ts');
    const before = digestWorkingTree(f.repos.withHead);
    const fileBefore = digestFile(target);

    const process_ = spawnSampleProcess({
      argv: COMMAND_SAMPLES.modifySource.argv([target]),
      cwd: f.root,
      env: f.childEnv(),
    });
    expect(await process_.waitExit(10_000)).toMatchObject({ code: 0 });

    expect(digestFile(target)).not.toBe(fileBefore);
    const after = digestWorkingTree(f.repos.withHead);
    expect(after.digest).not.toBe(before.digest);
    expect(commandSampleExpectation('modifySource')).toEqual({
      status: 'inconclusive',
      reason: 'source_changed',
    });
  });

  it('恶意初始化脚本：仅在显式运行并给出哨兵路径时写哨兵；静态 inspect 绝不执行它', async () => {
    const f = useFixture();
    // 准备阶段未执行：仓库内哨兵不存在。
    expect(existsSync(f.repos.maliciousSentinelPath)).toBe(false);

    // 显式运行（传入沙箱内哨兵路径）→ 才写哨兵。使用命令样例脚本（哨兵写入
    // argv[2]）；仓库内嵌脚本只写它自己仓库内的哨兵，两者刻意不同，用以证明
    // 「显式运行才写、静态 inspect 从不执行」。
    const sentinel = join(f.root, 'malicious-sentinel.txt');
    const process_ = spawnSampleProcess({
      argv: [process.execPath, COMMAND_SAMPLE_SCRIPT.maliciousInit, sentinel],
      cwd: f.root,
      env: f.childEnv(),
    });
    expect(await process_.waitExit(10_000)).toMatchObject({ code: 0 });
    expect(existsSync(sentinel)).toBe(true);

    // 仓库内哨兵仍不存在：静态 inspect 从未执行仓库脚本。
    expect(existsSync(f.repos.maliciousSentinelPath)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 屏障 / 身份与退出核验 / 摘要 / 脱敏证据
 * ------------------------------------------------------------------ */

describe('F-003 有界屏障、退出核验、内容摘要与脱敏证据', () => {
  it('起跑屏障：全部到达后同点放行；一方缺席时有界超时拒绝全部等待', async () => {
    const order: string[] = [];
    const outcomes = await runWithStartBarrier(
      [
        () => {
          order.push('a');
          return 'A';
        },
        () => {
          order.push('b');
          return 'B';
        },
      ],
      { timeoutMs: 2_000 },
    );
    expect(order).toHaveLength(2);
    expect(outcomes.map((o) => (o.status === 'fulfilled' ? o.value : 'rejected'))).toEqual(['A', 'B']);

    const barrier = createStartBarrier(3, { timeoutMs: 60 });
    const first = barrier.arrive();
    const second = barrier.arrive();
    await expect(first).rejects.toBeInstanceOf(BarrierTimeoutError);
    await expect(second).rejects.toBeInstanceOf(BarrierTimeoutError);
    expect(barrier.state).toBe('timed_out');
    await expect(barrier.arrive()).rejects.toBeInstanceOf(BarrierTimeoutError);
  });

  it('无法确认退出的句柄：confirmProcessExit 拒绝 exit_unconfirmed，绝不报 stopped', async () => {
    const signals: string[] = [];
    const synthetic = {
      pid: 424242,
      isAlive: () => true,
      kill: (signal?: string | number) => {
        signals.push(String(signal));
        return true;
      },
      send: () => {},
      exited: new Promise<never>(() => {}),
    };
    await expect(confirmProcessExit(synthetic, { stepMs: 30 })).rejects.toMatchObject({
      reason: 'exit_unconfirmed',
      pid: 424242,
    });
    // IPC close（无 send 通道则跳过）→ SIGTERM → SIGKILL 全部尝试后仍无法确认。
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('样例进程守护：dispose 只回收自有进程并核验退出，幂等', async () => {
    const f = useFixture();
    const finished = f.spawnSample('success');
    const hanging = f.spawnSample('hang');
    await viWaitFor(() => hanging.stdout.includes('sample-hang'), 5_000);
    const hangingPid = hanging.pid;

    await f.samples.dispose();
    expect(finished.isAlive()).toBe(false);
    expect(hanging.isAlive()).toBe(false);
    expect(() => process.kill(hangingPid, 0)).toThrow();
    await expect(f.samples.dispose()).resolves.toBeUndefined();
  });

  it('文件内容摘要：确定性、内容敏感、排除构建/依赖目录、可限定子集', () => {
    const f = useFixture();
    const probe = join(f.root, 'digest-probe');
    mkdirSync(join(probe, 'src'), { recursive: true });
    mkdirSync(join(probe, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(probe, 'dist'), { recursive: true });
    writeFileSync(join(probe, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(probe, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(probe, 'dist', 'out.js'), 'built\n');

    const first = digestWorkingTree(probe);
    const second = digestWorkingTree(probe);
    expect(first.digest).toBe(second.digest); // 确定性
    expect(first.entries.map((entry) => entry.relativePath)).toEqual(['src/a.ts']); // 排除依赖/产物
    expect(first.entries[0]!.digest).toBe(digestFile(join(probe, 'src', 'a.ts')));

    writeFileSync(join(probe, 'src', 'a.ts'), 'export const a = 2;\n');
    expect(digestWorkingTree(probe).digest).not.toBe(first.digest); // 内容敏感

    // include：只摘要指定相对路径。
    const subset = digestWorkingTree(probe, { include: ['src/a.ts'] });
    expect(subset.entries.map((entry) => entry.relativePath)).toEqual(['src/a.ts']);
  });

  it('脱敏证据：登记秘密/受保护串后 fail-closed 拒绝，序列化不含秘密', () => {
    const f = useFixture();
    const evidence = f.evidence;
    evidence.registerSecret(SECRET_SENTINEL);
    expect(() =>
      evidence.record('baseline.check', { authorization: `Bearer ${SECRET_SENTINEL}` }),
    ).toThrow(EvidenceSecretLeakError);
    expect(() => evidence.record('baseline.check', { value: SECRET_SENTINEL })).toThrow(
      EvidenceSecretLeakError,
    );
    // 受保护串（真实 HOME）同样被拒绝。
    expect(() => evidence.record('baseline.check', { path: homedir() })).toThrow(
      EvidenceSecretLeakError,
    );
    // 允许的非秘密字段。
    expect(() => evidence.record('baseline.check', { status: 'passed', exitCode: 0 })).not.toThrow();
    expect(evidence.serialize()).not.toContain(SECRET_SENTINEL);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 故障注入：输出发布失败 / 数据库收尾失败
 * ------------------------------------------------------------------ */

describe('F-003 故障注入（输出发布 / 数据库收尾）', () => {
  it('输出发布失败：真实文件系统上发布被中止、正式位置未发布、staging 残留保留；撤除后成功', async () => {
    const f = useFixture();
    const { store, fault } = f.faultyArtifactStore('fault-artifacts', { point: 'publishStaging', kind: 'io' });
    const key = { projectId: randomUUID(), artifactId: randomUUID() };
    const body = 'artifact-body-p02-3';

    const write = await store.openStagingWrite(key);
    write.stream.end(body);
    const staging = await store.finishStaging(write);
    expect(staging.sizeBytes).toBe(body.length);

    const failure = await store.publishStaging(staging, key).then(
      () => new Error('预期注入失败，但发布成功返回'),
      (caught: unknown) => caught,
    );
    expect(isArtifactFileError(failure, 'io')).toBe(true);
    expect(fault.firedCount).toBe(1);
    expect(fault.exhausted).toBe(true);

    // 正式位置未发布（真实 lstat 核对）；staging 残留保留供核对。
    const statFailure = await store.statFinal(key).then(
      () => new Error('预期正式位置不存在，但 statFinal 成功返回'),
      (caught: unknown) => caught,
    );
    expect(isArtifactFileError(statFailure, 'not_found')).toBe(true);
    const stagingPage = await store.scanStagingArea(key.projectId);
    expect(stagingPage.entries.some((entry) => entry.name === basename(staging.relativePath))).toBe(true);

    // 撤除注入后同一 staging 可正常发布，正文可读回。
    fault.remove();
    expect(fault.removed).toBe(true);
    const published = await store.publishStaging(staging, key);
    expect(published.sizeBytes).toBe(body.length);
    const content = await store.openFinalRead(key);
    expect(await readStream(content.stream)).toBe(body);
  });

  it('数据库收尾失败：业务写后事件写前中止 → 整组回滚；撤除后恢复', async () => {
    const commands = createCommandsTestFixture({ prefix: 'shiploop-p02-3-db-' });
    try {
      const harness = await commands.openTransactionalHarness();
      const probe = commands.openProbe();
      try {
        const payload = {
          schemaVersion: 2,
          strategies: {
            defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          },
          policies: { verification: { requireChecksBeforeDone: true } },
        };
        await harness.configurationService.createSettings({ kind: 'global' }, { payload });
        const rowBefore = probe.settingsRow('global');
        expect(rowBefore?.revision).toBe(1);
        expect(probe.stateEvents()).toHaveLength(0);

        const fault = installDatabaseFinalizationFault(harness.session.database, {
          message: 'p02-2 injected fault: p023_finalization',
        });
        const error = await harness.configurationService
          .updateSettings(
            { kind: 'global' },
            {
              expectedRevision: 1,
              payload: { ...payload, policies: { verification: { requireChecksBeforeDone: false } } },
            },
          )
          .then(
            () => new Error('预期注入失败，但更新成功返回'),
            (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
          );
        expect(error.message).toContain(fault.message);

        // 独立只读连接核对：业务行/事件均整组回滚。
        expect(probe.settingsRow('global')).toEqual(rowBefore);
        expect(probe.stateEvents()).toHaveLength(0);

        fault.remove();
        const recovered = await harness.configurationService.updateSettings(
          { kind: 'global' },
          { expectedRevision: 1, payload },
        );
        expect(recovered.revision).toBe(2);
        expect(probe.settingsRow('global')?.revision).toBe(2);
        expect(probe.stateEvents()).toHaveLength(1);
      } finally {
        probe.close();
        harness.close();
      }
    } finally {
      commands.cleanup();
    }
  });
});
