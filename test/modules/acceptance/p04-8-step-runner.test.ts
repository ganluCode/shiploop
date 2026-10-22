/**
 * P04-8 / F-003 有界顺序步骤执行与证据落盘组件的行为验证。
 *
 * 覆盖验收标准：
 * 1. 步骤按声明顺序执行，启动即记录运行身份和日志位置，完成后保存真实
 *    退出码、信号、耗时、超时和停止核验结果；
 * 2. 入口缺失、参数或 cwd 不符合预期、步骤超时、未知退出状态、证据写入失败
 *    和停止不确定均以非零结果结束；
 * 3. 非空证据目录、受测 commit 不匹配或资源输入不匹配时拒绝覆盖和复用旧成功证据；
 * 4. 前序成功步骤的日志和证据在后续步骤失败时保留，不能通过后台化、子 Shell
 *    或重启整套流程绕过预算。
 *
 * 测试只使用注入的受控执行器或亚秒级真实 node -e 子进程，不递归执行阶段入口，
 * 不调用模型或网络。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';
import {
  P04StepError,
  runP04StepSequence,
  type P04StepSequenceOptions,
  type P04StepSpec,
} from '../../../scripts/acceptance/p04-steps.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const IDENTITY = {
  runId: 'p04-steps-run-0001',
  commit: 'a'.repeat(40),
  inputsDigest: 'b'.repeat(64),
} as const;

const PASS_OUTCOME: P02BoundedRunOutcome = {
  kind: 'exit',
  exitCode: 0,
  signal: null,
  durationMs: 12,
  timedOut: false,
  stdout: '',
  stderr: '',
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  spawnError: null,
  stoppedVerified: true,
};

function baseOptions(evidenceDir: string, overrides: Partial<P04StepSequenceOptions> = {}): P04StepSequenceOptions {
  return {
    evidenceDir,
    identity: IDENTITY,
    stepTimeoutMs: 5_000,
    overallTimeoutMs: 30_000,
    maxOutputBytes: 4_096,
    ...overrides,
  };
}

function step(id: string, overrides: Partial<P04StepSpec> = {}): P04StepSpec {
  return {
    id,
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    cwd: process.cwd(),
    ...overrides,
  };
}

function readJson(evidenceDir: string, relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(evidenceDir, relPath), 'utf8')) as Record<string, unknown>;
}

describe('P04-8 bounded step runner records ordered evidence', () => {
  it('[case:ordered-evidence-and-identity] runs steps in declared order and persists identity, logs and watermarks', async () => {
    const root = tempDir('p04-steps-order-');
    const evidenceDir = join(root, 'run');
    const marker = join(root, 'order.log');
    const makeStep = (id: string, letter: string): P04StepSpec => ({
      id,
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').appendFileSync(process.argv[1], '${letter}');` +
          "process.stdout.write(process.cwd() + ' ' + process.env.P04_STEP_PROBE)",
        marker,
      ],
      cwd: root,
    });
    const steps = [makeStep('alpha', 'A'), makeStep('beta', 'B'), makeStep('gamma', 'C')];
    const result = await runP04StepSequence(
      steps,
      baseOptions(evidenceDir, { env: { P04_STEP_PROBE: 'p04-steps-env-marker' } }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.problems).toEqual([]);
    // 顺序执行：marker 内容证明 A→B→C。
    expect(readFileSync(marker, 'utf8')).toBe('ABC');

    const runJson = readJson(evidenceDir, 'run.json');
    expect(runJson.identity).toEqual(IDENTITY);
    expect((runJson.plannedSteps as { id: string }[]).map((entry) => entry.id)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);

    for (const [index, id] of ['alpha', 'beta', 'gamma'].entries()) {
      const record = result.steps[index]!;
      expect(record.status).toBe('pass');
      expect(record.exitCode).toBe(0);
      expect(record.endKind).toBe('exit');
      expect(record.signal).toBeNull();
      expect(record.timedOut).toBe(false);
      expect(record.stoppedVerified).toBe(true);
      expect(typeof record.durationMs).toBe('number');
      const relPath = `steps/0${index + 1}-${id}.json`;
      expect(record.evidencePath).toBe(relPath);
      const onDisk = readJson(evidenceDir, relPath);
      expect(onDisk.status).toBe('pass');
      expect(onDisk.runId).toBe(IDENTITY.runId);
      expect(onDisk.argv).toEqual([process.execPath, ...steps[index]!.args]);
      expect(onDisk.cwd).toBe(root);
      expect(onDisk.logPath).toBe(`logs/0${index + 1}-${id}.log`);
      const log = readFileSync(join(evidenceDir, onDisk.logPath as string), 'utf8');
      expect(log).toContain(root);
      expect(log).toContain('p04-steps-env-marker');
      expect(log).toContain('--- end kind=exit exitCode=0');
    }

    const state = readJson(evidenceDir, 'state.json') as { entries: { evidencePath: string; evidenceSha256: string }[] };
    expect(state.entries).toHaveLength(3);
    for (const entry of state.entries) {
      expect(sha256(readFileSync(join(evidenceDir, entry.evidencePath), 'utf8'))).toBe(entry.evidenceSha256);
    }
  });

  it('[case:start-record-before-completion] persists a running record with identity and log location before the process settles', async () => {
    const root = tempDir('p04-steps-start-');
    const evidenceDir = join(root, 'run');
    let observed: Record<string, unknown> | null = null;
    const result = await runP04StepSequence([step('first')], baseOptions(evidenceDir, {
      runProcess: async () => {
        observed = readJson(evidenceDir, 'steps/01-first.json');
        return PASS_OUTCOME;
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(observed).not.toBeNull();
    expect(observed!.status).toBe('running');
    expect(observed!.runId).toBe(IDENTITY.runId);
    expect(observed!.logPath).toBe('logs/01-first.log');
    expect(observed!.evidencePath).toBe('steps/01-first.json');
    // 日志文件在启动时即创建（头部包含 argv 与超时）。
    const header = readFileSync(join(evidenceDir, 'logs/01-first.log'), 'utf8');
    expect(header).toContain(`# run ${IDENTITY.runId}`);
    expect(header).toContain('# timeoutMs 5000');
    // 完成后同一文件改为终态记录，保留真实退出状态。
    const final = readJson(evidenceDir, 'steps/01-first.json');
    expect(final.status).toBe('pass');
    expect(final.exitCode).toBe(0);
    expect(final.durationMs).toBe(12);
    expect(final.stoppedVerified).toBe(true);
  });
});

describe('P04-8 bounded step runner is fail-closed', () => {
  it('[case:real-exit-code-preserved] preserves prior evidence and the real exit code when a later step fails', async () => {
    const root = tempDir('p04-steps-prior-');
    const evidenceDir = join(root, 'run');
    const okStep = step('first', { args: ['-e', 'process.stdout.write("FIRST-OK")'] });
    const badStep = step('second', { args: ['-e', 'process.exit(3)'], label: 'bad' });
    const laterStep = step('third');
    const runProcess = async (
      command: string,
      args: readonly string[],
      options: Parameters<typeof runBoundedProcess>[2],
    ): Promise<P02BoundedRunOutcome> => {
      if (args.includes('FAIL-NOW')) return { ...PASS_OUTCOME, exitCode: 3, stderr: 'boom' };
      return runBoundedProcess(command, args, options);
    };
    const result = await runP04StepSequence(
      [okStep, { ...badStep, args: ['FAIL-NOW'] }, laterStep],
      baseOptions(evidenceDir, { runProcess }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.haltedStepId).toBe('second');
    expect(result.steps[0]!.status).toBe('pass');
    expect(result.steps[1]!.status).toBe('fail');
    // 真实退出码原样记录，不伪造 0/1。
    expect(result.steps[1]!.exitCode).toBe(3);
    expect(result.steps[2]!.status).toBe('not_run');
    expect(result.steps[2]!.notRunReason).toBe('halted_by_prior_failure');

    // 前序成功步骤的证据与日志保留，且水位一致。
    const firstRecord = readJson(evidenceDir, 'steps/01-first.json');
    expect(firstRecord.status).toBe('pass');
    expect(readFileSync(join(evidenceDir, 'logs/01-first.log'), 'utf8')).toContain('FIRST-OK');
    const state = readJson(evidenceDir, 'state.json') as { entries: { status: string; evidenceSha256: string; evidencePath: string }[] };
    expect(state.entries.map((entry) => entry.status)).toEqual(['pass', 'fail']);
    expect(sha256(readFileSync(join(evidenceDir, 'steps/01-first.json'), 'utf8'))).toBe(state.entries[0]!.evidenceSha256);
    const secondRecord = readJson(evidenceDir, 'steps/02-second.json');
    expect(secondRecord.status).toBe('fail');
    expect(secondRecord.exitCode).toBe(3);
  });

  it('[case:timeout-fail-closed] a step timeout ends the run non-zero and skips the rest', async () => {
    const root = tempDir('p04-steps-timeout-');
    const evidenceDir = join(root, 'run');
    const result = await runP04StepSequence([step('slow'), step('never')], baseOptions(evidenceDir, {
      runProcess: async () => ({ ...PASS_OUTCOME, kind: 'timeout', timedOut: true, exitCode: null }),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[0]!.endKind).toBe('timeout');
    expect(result.steps[0]!.timedOut).toBe(true);
    expect(result.steps[1]!.status).toBe('not_run');
    expect(result.problems.join('\n')).toContain('有限超时');
    const log = readFileSync(join(evidenceDir, 'logs/01-slow.log'), 'utf8');
    expect(log).toContain('timedOut=true');
  });

  it('[case:unknown-exit-status] unknown exit states are recorded as unknown and never coerced to 0/1', async () => {
    const root = tempDir('p04-steps-unknown-');
    const dirA = join(root, 'run-a');
    const resultA = await runP04StepSequence([step('weird')], baseOptions(dirA, {
      runProcess: async () =>
        ({ ...PASS_OUTCOME, kind: 'exit', exitCode: null }) as unknown as P02BoundedRunOutcome,
    }));
    expect(resultA.exitCode).toBe(1);
    expect(resultA.steps[0]!.endKind).toBe('unknown');
    expect(resultA.steps[0]!.exitCode).toBeNull();
    expect(resultA.problems.join('\n')).toContain('未知退出状态');

    const dirB = join(root, 'run-b');
    const resultB = await runP04StepSequence([step('weird-kind')], baseOptions(dirB, {
      runProcess: async () =>
        ({ ...PASS_OUTCOME, kind: 'mystery' }) as unknown as P02BoundedRunOutcome,
    }));
    expect(resultB.exitCode).toBe(1);
    expect(resultB.steps[0]!.endKind).toBe('unknown');
  });

  it('[case:stop-uncertain-fails] an unverified stop cannot pass even with exit code zero', async () => {
    const root = tempDir('p04-steps-stop-');
    const evidenceDir = join(root, 'run');
    const result = await runP04StepSequence([step('ghost'), step('later')], baseOptions(evidenceDir, {
      runProcess: async () => ({ ...PASS_OUTCOME, stoppedVerified: false }),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[0]!.stoppedVerified).toBe(false);
    expect(result.stopConfirmed).toBe(false);
    expect(result.steps[1]!.status).toBe('not_run');
    expect(readJson(evidenceDir, 'steps/01-ghost.json').stoppedVerified).toBe(false);
  });

  it('[case:missing-entry] a missing entry fails closed before or at spawn without creating fake success', async () => {
    const root = tempDir('p04-steps-entry-');
    // 绝对路径入口缺失：启动前即拒绝，且不创建证据目录。
    const dirA = join(root, 'run-a');
    await expect(
      runP04StepSequence(
        [step('gone', { command: join(root, 'no-such-entry') })],
        baseOptions(dirA),
      ),
    ).rejects.toMatchObject({ name: 'P04StepError', kind: 'invalid_step' });
    expect(existsSync(dirA)).toBe(false);

    // PATH 上的命令不存在：真实 spawn 失败按 spawn_error 非零结束。
    const dirB = join(root, 'run-b');
    const result = await runP04StepSequence(
      [step('gone-path', { command: 'shiploop-definitely-missing-entry-xyz' }), step('later')],
      baseOptions(dirB),
    );
    expect(result.exitCode).toBe(1);
    expect(result.steps[0]!.endKind).toBe('spawn_error');
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[1]!.status).toBe('not_run');
  });

  it('[case:invalid-args-cwd-rejected] malformed args, cwd and budgets are rejected before any process starts', async () => {
    const root = tempDir('p04-steps-invalid-');
    const evidenceDir = join(root, 'run');
    await expect(
      runP04StepSequence([step('bad-args', { args: ['ok', null as unknown as string] })], baseOptions(evidenceDir)),
    ).rejects.toBeInstanceOf(P04StepError);
    await expect(
      runP04StepSequence([step('bad-arg-nul', { args: ['a\0b'] })], baseOptions(evidenceDir)),
    ).rejects.toMatchObject({ kind: 'invalid_step' });
    await expect(
      runP04StepSequence([step('bad-cwd-rel', { cwd: 'relative/dir' })], baseOptions(evidenceDir)),
    ).rejects.toMatchObject({ kind: 'invalid_step' });
    await expect(
      runP04StepSequence([step('bad-cwd-missing', { cwd: '/definitely/not/a/dir' })], baseOptions(evidenceDir)),
    ).rejects.toMatchObject({ kind: 'invalid_step' });
    await expect(
      runP04StepSequence([step('ok')], baseOptions(evidenceDir, { stepTimeoutMs: 5 })),
    ).rejects.toMatchObject({ kind: 'invalid_budget' });
    await expect(
      runP04StepSequence(
        [step('ok')],
        baseOptions(evidenceDir, {
          identity: { runId: IDENTITY.runId, commit: 'nothex', inputsDigest: IDENTITY.inputsDigest },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_identity' });
    expect(existsSync(evidenceDir)).toBe(false);
  });

  it('[case:evidence-write-failure] a mid-run evidence write failure keeps earlier evidence and fails the run', async () => {
    const root = tempDir('p04-steps-write-');
    const evidenceDir = join(root, 'run');
    const result = await runP04StepSequence([step('first'), step('second'), step('third')], baseOptions(evidenceDir, {
      runProcess: async () => {
        // 阻断第二步启动记录的写入路径。
        mkdirSync(join(evidenceDir, 'steps', '02-second.json'));
        return PASS_OUTCOME;
      },
    }));

    expect(result.exitCode).toBe(1);
    expect(result.evidenceWritesVerified).toBe(false);
    expect(result.steps[0]!.status).toBe('pass');
    expect(result.steps[1]!.status).toBe('fail');
    expect(result.steps[1]!.endKind).toBe('not_started');
    expect(result.steps[2]!.status).toBe('not_run');
    expect(result.steps[2]!.notRunReason).toBe('evidence_write_failed');
    expect(result.problems.join('\n')).toContain('证据写入失败');
    expect(readJson(evidenceDir, 'steps/01-first.json').status).toBe('pass');
  });

  it('[case:runner-rejection] a runner rejection has no stop proof and fails the whole run', async () => {
    const root = tempDir('p04-steps-reject-');
    const evidenceDir = join(root, 'run');
    const result = await runP04StepSequence([step('first'), step('second')], baseOptions(evidenceDir, {
      runProcess: async () => {
        throw new Error('runner rejected');
      },
    }));

    expect(result.exitCode).toBe(1);
    expect(result.steps[0]!.endKind).toBe('runner_error');
    expect(result.steps[0]!.stoppedVerified).toBe(false);
    expect(result.stopConfirmed).toBe(false);
    expect(result.steps[1]!.status).toBe('not_run');
    expect(result.problems.join('\n')).toContain('步骤执行器异常');
  });
});

describe('P04-8 bounded step runner refuses evidence reuse and budget bypass', () => {
  it('[case:nonempty-dir-reuse-rejected] fresh runs refuse to overwrite non-empty evidence directories', async () => {
    const root = tempDir('p04-steps-reuse-');
    const evidenceDir = join(root, 'run');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'stale.txt'), 'old success evidence\n');

    await expect(
      runP04StepSequence([step('first')], baseOptions(evidenceDir)),
    ).rejects.toMatchObject({ kind: 'evidence_dir_not_empty' });
    expect(readFileSync(join(evidenceDir, 'stale.txt'), 'utf8')).toBe('old success evidence\n');

    // 空目录可以开新运行；同一目录在完成后再 fresh 也会被拒绝。
    const emptyDir = join(root, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const result = await runP04StepSequence([step('first')], baseOptions(emptyDir));
    expect(result.exitCode).toBe(0);
    await expect(runP04StepSequence([step('first')], baseOptions(emptyDir))).rejects.toMatchObject({
      kind: 'evidence_dir_not_empty',
    });
  });

  it('[case:budget-exhausted-and-resume] budget exhaustion, identity/budget mismatch and verified resume', async () => {
    const root = tempDir('p04-steps-resume-');
    const evidenceDir = join(root, 'run');
    let clock = 1_700_000_000_000;
    const now = (): number => clock;
    const options = baseOptions(evidenceDir, { now, stepTimeoutMs: 2_000, overallTimeoutMs: 6_000 });
    const build: P04StepSpec = { id: 'build', command: process.execPath, args: ['-e', '0'], cwd: root };
    const testStep: P04StepSpec = { id: 'test', command: process.execPath, args: ['-e', '0'], cwd: root };

    // 第一次运行：build 通过但耗尽总预算，test 未启动。
    const run1 = await runP04StepSequence([build, testStep], {
      ...options,
      runProcess: async () => {
        clock += 6_000;
        return { ...PASS_OUTCOME, durationMs: 5_000 };
      },
    });
    expect(run1.exitCode).toBe(1);
    expect(run1.budgetExhausted).toBe(true);
    expect(run1.steps[0]!.status).toBe('pass');
    expect(run1.steps[1]!.status).toBe('not_run');
    expect(run1.steps[1]!.notRunReason).toBe('budget_exhausted');

    // 重启整套流程（fresh 同目录）被拒绝。
    await expect(runP04StepSequence([build, testStep], options)).rejects.toMatchObject({
      kind: 'evidence_dir_not_empty',
    });

    // identity 不匹配（commit / 输入摘要 / runId）拒绝复用旧成功证据。
    await expect(
      runP04StepSequence([build, testStep], {
        ...options,
        mode: 'resume',
        identity: { ...IDENTITY, commit: 'c'.repeat(40) },
      }),
    ).rejects.toMatchObject({ kind: 'identity_mismatch' });
    await expect(
      runP04StepSequence([build, testStep], {
        ...options,
        mode: 'resume',
        identity: { ...IDENTITY, inputsDigest: 'd'.repeat(64) },
      }),
    ).rejects.toMatchObject({ kind: 'identity_mismatch' });
    await expect(
      runP04StepSequence([build, testStep], {
        ...options,
        mode: 'resume',
        identity: { ...IDENTITY, runId: 'another-run' },
      }),
    ).rejects.toMatchObject({ kind: 'identity_mismatch' });

    // 放大总预算的续跑被拒绝：重启不得清零或放大预算。
    await expect(
      runP04StepSequence([build, testStep], { ...options, mode: 'resume', overallTimeoutMs: 60_000 }),
    ).rejects.toMatchObject({ kind: 'budget_mismatch' });

    // 证据被篡改后拒绝续跑。
    const firstEvidence = join(evidenceDir, 'steps/01-build.json');
    const originalEvidence = readFileSync(firstEvidence, 'utf8');
    writeFileSync(firstEvidence, `${originalEvidence} `);
    await expect(
      runP04StepSequence([build, testStep], { ...options, mode: 'resume' }),
    ).rejects.toMatchObject({ kind: 'evidence_corrupt' });
    writeFileSync(firstEvidence, originalEvidence);

    // 身份一致的显式续跑：build 不重跑、旧证据逐字节保留、预算结转。
    const requestedTimeouts: number[] = [];
    const run2 = await runP04StepSequence([build, testStep], {
      ...options,
      mode: 'resume',
      runProcess: async (_command, _args, runOptions) => {
        requestedTimeouts.push(runOptions.timeoutMs);
        return PASS_OUTCOME;
      },
    });
    expect(run2.exitCode).toBe(0);
    expect(run2.resumedFromCount).toBe(1);
    expect(run2.steps[0]!.fromVerifiedEvidence).toBe(true);
    expect(run2.steps[1]!.status).toBe('pass');
    expect(readFileSync(firstEvidence, 'utf8')).toBe(originalEvidence);
    // 已记录 5000ms 计入总预算：剩余 1000ms 成为下一步的实际上限。
    expect(requestedTimeouts).toEqual([1_000]);
    expect(run2.problems).toEqual([]);
  });

  it('[case:resume-rejects-failed-prefix] a run halted by failure cannot be resumed', async () => {
    const root = tempDir('p04-steps-failed-prefix-');
    const evidenceDir = join(root, 'run');
    const first = step('first');
    const second = step('second');
    const options = baseOptions(evidenceDir, {
      runProcess: async () => ({ ...PASS_OUTCOME, exitCode: 2 }),
    });
    const result = await runP04StepSequence([first, second], options);
    expect(result.exitCode).toBe(1);

    await expect(
      runP04StepSequence([first, second], { ...options, mode: 'resume', runProcess: async () => PASS_OUTCOME }),
    ).rejects.toMatchObject({ kind: 'not_resumable' });
  });

  it('[case:no-shell-joining] args with shell metacharacters stay literal and never reach a shell', async () => {
    const root = tempDir('p04-steps-shell-');
    const evidenceDir = join(root, 'run');
    const pwned = join(root, 'pwned');
    const result = await runP04StepSequence(
      [
        step('literal', {
          args: [
            '-e',
            'process.stdout.write(process.argv.slice(1).join("|"))',
            `; touch ${pwned}`,
            'b&&c $(pwd)',
          ],
        }),
      ],
      baseOptions(evidenceDir),
    );

    expect(result.exitCode).toBe(0);
    // 元字符作为字面 argv 传给子进程，输出中保留原文。
    const log = readFileSync(join(evidenceDir, 'logs/01-literal.log'), 'utf8');
    expect(log).toContain('; touch');
    expect(log).toContain('b&&c $(pwd)');
    // 没有任何 Shell 解释执行：目标文件未被创建。
    expect(existsSync(pwned)).toBe(false);
    expect(readJson(evidenceDir, 'steps/01-literal.json').argv).toEqual([
      process.execPath,
      '-e',
      'process.stdout.write(process.argv.slice(1).join("|"))',
      `; touch ${pwned}`,
      'b&&c $(pwd)',
    ]);
  });

  it('[case:redact-hook] step output is redacted before it reaches logs and evidence', async () => {
    const root = tempDir('p04-steps-redact-');
    const evidenceDir = join(root, 'run');
    const result = await runP04StepSequence([step('leaky')], baseOptions(evidenceDir, {
      redact: (text) => text.replaceAll('SECRET-42', '[redacted]'),
      runProcess: async () => ({
        ...PASS_OUTCOME,
        stdout: 'token SECRET-42 leaked',
        stderr: 'also SECRET-42 here',
        stdoutBytes: 19,
        stderrBytes: 19,
      }),
    }));

    expect(result.exitCode).toBe(0);
    const log = readFileSync(join(evidenceDir, 'logs/01-leaky.log'), 'utf8');
    expect(log).not.toContain('SECRET-42');
    expect(log).toContain('[redacted]');
    const evidence = readFileSync(join(evidenceDir, 'steps/01-leaky.json'), 'utf8');
    expect(evidence).not.toContain('SECRET-42');
    // 输出正文只进日志，证据记录字节数。
    expect(evidence).toContain('"stdoutBytes": 19');
  });
});
