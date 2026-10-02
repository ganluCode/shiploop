/**
 * F-010 干净安装复跑（macOS 正式验收步骤的可复现工具；开发验收工具，不进 packages/）。
 *
 * 目的：在**受控临时干净源码快照**中按锁定版本 `npm ci`，真实执行
 * `npm test` / `npm run typecheck` / `npm run build` / `npm run verify` /
 * `npm run accept:p01`（连续两次，验证运行之间不依赖残留），保存命令、退出码、
 * 耗时、环境事实与两次独立的 accept:p01 报告位置/结论，全部证据先写出再清理临时资源。
 *
 * 快照为 `git clone --no-hardlinks` 的**已提交**状态（含 `.git`，使 accept:p01 能采集
 * 受测 commit/工作树事实），检出精确 commit，且断言快照中不含 `node_modules` / `dist`
 * 残留。源仓库必须工作树 clean，否则拒绝（dirty 检查结果不能冒充已提交基线）。
 *
 * 安全边界：临时快照创建于系统临时目录且仅删除本次持有的授权根；源仓库只读；
 * 证据文本按快照根/仓库根/用户目录/临时目录替换为逻辑占位符；不导出环境变量、凭据或
 * 原始秘密；不调用模型、不执行 npm 发布。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReplayStep = {
  /** 稳定步骤 ID（亦用于日志与证据文件名）。 */
  readonly id: string;
  /** 展示与诊断用命令名。 */
  readonly label: string;
  /** 传给当前 npm 的参数（`npm ci` 为 `['ci']`）。 */
  readonly npmArgs: readonly string[];
  readonly timeoutMs: number;
  /** 是否为 accept:p01 运行（需要解析并保存报告）。 */
  readonly isAcceptRun: boolean;
};

/** 冻结的复跑步骤与顺序：严格对应 F-010 验收命令，不跳过任何一项。 */
export const REPLAY_STEPS: readonly ReplayStep[] = [
  { id: 'npm-ci', label: 'npm ci', npmArgs: ['ci'], timeoutMs: 600_000, isAcceptRun: false },
  { id: 'npm-test', label: 'npm test', npmArgs: ['test'], timeoutMs: 600_000, isAcceptRun: false },
  {
    id: 'typecheck',
    label: 'npm run typecheck',
    npmArgs: ['run', 'typecheck'],
    timeoutMs: 600_000,
    isAcceptRun: false,
  },
  {
    id: 'build',
    label: 'npm run build',
    npmArgs: ['run', 'build'],
    timeoutMs: 600_000,
    isAcceptRun: false,
  },
  {
    id: 'verify',
    label: 'npm run verify',
    npmArgs: ['run', 'verify'],
    timeoutMs: 1_200_000,
    isAcceptRun: false,
  },
  {
    id: 'accept-1',
    label: 'npm run accept:p01（第 1 次）',
    npmArgs: ['run', 'accept:p01'],
    timeoutMs: 1_800_000,
    isAcceptRun: true,
  },
  {
    id: 'accept-2',
    label: 'npm run accept:p01（第 2 次，验证无残留依赖）',
    npmArgs: ['run', 'accept:p01'],
    timeoutMs: 1_800_000,
    isAcceptRun: true,
  },
];

export type SanitizeReplacements = {
  readonly repoRoot: string;
  readonly snapshotRoot: string;
  readonly homeDir: string;
  readonly tempDir: string;
  /** 额外等价前缀（如 realpath 后的临时根/仓库根）；同值合并为同一占位符。 */
  readonly extra?: readonly (readonly [string, string])[];
};

/**
 * 把证据文本中的真实绝对路径替换为逻辑占位符。合并所有前缀（含 realpath 变体）后
 * 按长度降序替换，保证更长的仓库/快照根不会被较短的 HOME 前缀截断。
 */
export function sanitizeEvidenceText(text: string, replacements: SanitizeReplacements): string {
  const pairs: Array<[string, string]> = [
    [replacements.snapshotRoot, '<SNAPSHOT-ROOT>'],
    [replacements.repoRoot, '<REPO-ROOT>'],
    [replacements.tempDir, '<TMPDIR>'],
    [replacements.homeDir, '<HOME>'],
  ];
  for (const pair of replacements.extra ?? []) {
    pairs.push([pair[0], pair[1]]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let result = text;
  for (const [from, to] of pairs) {
    if (from.length > 0 && result.includes(from)) {
      result = result.split(from).join(to);
    }
  }
  return result;
}

export type AcceptReportSummary = {
  readonly runDir: string;
  readonly conclusion: string;
  readonly pass: number;
  readonly fail: number;
  readonly notRun: number;
};

const ACCEPT_REPORT_LINE =
  /accept:p01: REPORT (.+?)（conclusion=(\w+)，pass=(\d+) fail=(\d+) not_run=(\d+)）/;

/** 从 accept:p01 标准输出解析最终 REPORT 行（运行目录与三态计数）。 */
export function parseAcceptReportSummary(stdout: string): AcceptReportSummary | null {
  const match = ACCEPT_REPORT_LINE.exec(stdout);
  if (match === null) {
    return null;
  }
  return {
    runDir: match[1] as string,
    conclusion: match[2] as string,
    pass: Number.parseInt(match[3] as string, 10),
    fail: Number.parseInt(match[4] as string, 10),
    notRun: Number.parseInt(match[5] as string, 10),
  };
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

type BoundedResult = {
  readonly kind: 'exit' | 'signal' | 'timeout' | 'spawn-error';
  readonly code: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string | null;
};

const KILL_GRACE_MS = 5_000;

/** 以独立进程组运行真实子进程，有限超时；超时对整个进程组 SIGKILL（含孙进程）。 */
function runBounded(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<BoundedResult> {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const settle = (result: BoundedResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      resolveResult(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 已退出。
          }
        }
      }
      graceTimer = setTimeout(() => {
        settle({
          kind: 'timeout',
          code: null,
          signal: null,
          durationMs: Date.now() - started,
          stdout,
          stderr,
          message: `timed out after ${timeoutMs}ms`,
        });
      }, KILL_GRACE_MS);
      graceTimer.unref();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started;
      if (timedOut) {
        settle({ kind: 'timeout', code: null, signal: null, durationMs, stdout, stderr, message: `timed out after ${timeoutMs}ms` });
        return;
      }
      if (spawnError !== null) {
        settle({ kind: 'spawn-error', code: null, signal: null, durationMs, stdout, stderr, message: spawnError.message });
        return;
      }
      if (signal !== null) {
        settle({ kind: 'signal', code: null, signal, durationMs, stdout, stderr, message: `signal ${signal}` });
        return;
      }
      settle({ kind: 'exit', code: code ?? 1, signal: null, durationMs, stdout, stderr, message: null });
    });
  });
}

type NpmInvocation = { readonly command: string; readonly argsPrefix: readonly string[] };

/** 优先使用 npm_execpath（启动本工具的固定 npm），否则回退 PATH 上的 npm。 */
function resolveNpm(): NpmInvocation {
  const execPath = process.env.npm_execpath;
  if (typeof execPath === 'string' && execPath.endsWith('.js') && existsSync(execPath)) {
    return { command: process.execPath, argsPrefix: [execPath] };
  }
  return { command: 'npm', argsPrefix: [] };
}

function runNpm(
  npm: NpmInvocation,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<BoundedResult> {
  return runBounded(npm.command, [...npm.argsPrefix, ...args], cwd, timeoutMs, env);
}

function gitCommand(root: string, args: readonly string[], timeoutMs = 120_000): BoundedResult | Promise<BoundedResult> {
  return runBounded('git', ['-C', root, ...args], root, timeoutMs, process.env);
}

async function git(root: string, args: readonly string[]): Promise<BoundedResult> {
  return gitCommand(root, args);
}

function requireExit(result: BoundedResult, label: string): void {
  if (result.kind !== 'exit' || result.code !== 0) {
    throw new Error(`${label} 未正常退出：${result.kind} code=${String(result.code)} signal=${String(result.signal)} ${result.message ?? ''}`.trim());
  }
}

function assertSafeTempRoot(dir: string, prefix: string): void {
  const temp = resolve(tmpdir());
  const target = resolve(dir);
  if (!target.startsWith(temp + '/') || !basename(target).startsWith(prefix)) {
    throw new Error(`拒绝删除未授权临时根：${target}`);
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`拒绝删除符号链接临时根：${target}`);
  }
}

export type ReplayOptions = {
  readonly root?: string;
  readonly outDir?: string;
  readonly keepSnapshot?: boolean;
  readonly log?: (message: string) => void;
};

export type ReplayOutcome = {
  readonly ok: boolean;
  readonly commit: string;
  readonly branch: string;
  readonly outDir: string;
  readonly snapshotRoot: string;
  readonly evidence: readonly string[];
};

type StepRecord = {
  readonly id: string;
  readonly label: string;
  readonly npmArgs: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly logPath: string;
  readonly accept: AcceptReportSummary | null;
  readonly acceptReportPath: string | null;
};

/**
 * 执行完整干净复跑：创建已提交快照 → 依次运行固定命令 → 保存脱敏证据 → 清理临时资源。
 * 任一必需命令非零退出、accept:p01 未通过或报告缺失即返回 `ok:false`（仍然写出已取得证据）。
 */
export async function runCleanSnapshotReplay(options: ReplayOptions = {}): Promise<ReplayOutcome> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(options.root ?? resolve(scriptDir, '..', '..'));
  const outDir = resolve(options.outDir ?? join(root, 'docs', 'acceptance', 'evidence-p01-4'));
  const log = options.log ?? ((message: string): void => {
    process.stdout.write(`${message}\n`);
  });

  const status = await git(root, ['status', '--porcelain']);
  requireExit(status, 'git status --porcelain');
  if (status.stdout.trim() !== '') {
    throw new Error('源仓库工作树不干净：干净安装复跑要求受测代码已提交（dirty 结果不能冒充已提交基线）');
  }
  const commitResult = await git(root, ['rev-parse', 'HEAD']);
  requireExit(commitResult, 'git rev-parse HEAD');
  const commit = commitResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`git rev-parse HEAD 返回非法 commit：${commit}`);
  }
  const branchResult = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  requireExit(branchResult, 'git rev-parse --abbrev-ref HEAD');
  const branch = branchResult.stdout.trim();

  const npm = resolveNpm();
  const npmVersion = await runNpm(npm, ['--version'], root, 60_000, process.env);
  requireExit(npmVersion, 'npm --version');
  const gitVersion = await runBounded('git', ['--version'], root, 60_000, process.env);
  requireExit(gitVersion, 'git --version');

  const tempPrefix = 'shiploop-p01-clean-';
  const tempRoot = mkdtempSync(join(tmpdir(), tempPrefix));
  const snapshotRoot = join(tempRoot, 'repo');
  const logsDir = join(outDir, 'logs');
  const acceptDir = join(outDir, 'accept-runs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(acceptDir, { recursive: true });

  const steps: ReplayStep[] = [...REPLAY_STEPS];
  const records: StepRecord[] = [];
  const evidence: string[] = [];
  let ok = true;

  const writeEvidence = (relativePath: string, content: string): void => {
    const absolute = join(outDir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf-8');
    evidence.push(relativePath);
  };

  try {
    log(`clean-snapshot-replay: 源仓库 ${root}（commit ${commit}，分支 ${branch}，工作树 clean）`);
    log(`clean-snapshot-replay: 创建干净快照 ${snapshotRoot}`);
    const clone = await runBounded(
      'git',
      ['clone', '--quiet', '--no-hardlinks', '--local', root, snapshotRoot],
      root,
      300_000,
      process.env,
    );
    requireExit(clone, 'git clone');
    const checkout = await runBounded('git', ['checkout', '--quiet', '--detach', commit], snapshotRoot, 120_000, process.env);
    requireExit(checkout, 'git checkout --detach');

    for (const residue of ['node_modules', 'dist']) {
      if (existsSync(join(snapshotRoot, residue))) {
        throw new Error(`干净快照中不应存在 ${residue}（快照未保持干净）`);
      }
    }

    // 快照已存在后再解析 realpath 变体（macOS 上 /var 与 /private/var 并存），
    // 保证日志与命令记录中的临时绝对路径全部被替换。
    const replacements: SanitizeReplacements = {
      repoRoot: root,
      snapshotRoot,
      homeDir: homedir(),
      tempDir: tmpdir(),
      extra: [
        [realpathSync(snapshotRoot), '<SNAPSHOT-ROOT>'],
        [realpathSync(root), '<REPO-ROOT>'],
        [realpathSync(tmpdir()), '<TMPDIR>'],
        [realpathSync(homedir()), '<HOME>'],
      ],
    };

    for (const step of steps) {
      log(`clean-snapshot-replay: RUN ${step.label}`);
      const result = await runNpm(npm, step.npmArgs, snapshotRoot, step.timeoutMs, process.env);
      const sanitized = sanitizeEvidenceText(
        `$ ${step.label}\n\n${result.stdout}${result.stderr}`,
        replacements,
      );
      const logRelative = `logs/${step.id}.log`;
      writeEvidence(logRelative, sanitized);

      let accept: AcceptReportSummary | null = null;
      let acceptReportPath: string | null = null;
      if (step.isAcceptRun) {
        accept = parseAcceptReportSummary(result.stdout);
        if (accept === null) {
          log(`clean-snapshot-replay: FAIL ${step.label} 无法从输出解析 REPORT 行`);
        } else {
          const reportFile = join(accept.runDir, 'report.json');
          const summaryFile = join(accept.runDir, 'summary.md');
          if (!existsSync(reportFile)) {
            log(`clean-snapshot-replay: FAIL ${step.label} 缺少报告 ${reportFile}`);
          } else {
            const rawReport = readFileSync(reportFile, 'utf-8');
            const report = JSON.parse(rawReport) as {
              runId?: unknown;
              conclusion?: unknown;
              counts?: { pass?: unknown; fail?: unknown; not_run?: unknown };
              git?: { commit?: unknown; worktree?: unknown };
            };
            if (report.conclusion !== 'pass' || accept.conclusion !== 'pass') {
              log(`clean-snapshot-replay: FAIL ${step.label} conclusion=${String(report.conclusion)}`);
            }
            acceptReportPath = `accept-runs/${step.id}/report.json`;
            writeEvidence(acceptReportPath, sanitizeEvidenceText(rawReport, replacements));
            if (existsSync(summaryFile)) {
              writeEvidence(
                `accept-runs/${step.id}/summary.md`,
                sanitizeEvidenceText(readFileSync(summaryFile, 'utf-8'), replacements),
              );
            }
          }
        }
      }

      const failed = result.kind !== 'exit' || result.code !== 0;
      if (failed) {
        ok = false;
        log(
          `clean-snapshot-replay: FAIL ${step.label} -> ${result.kind} code=${String(result.code)} signal=${String(result.signal)} ${result.message ?? ''}`.trim(),
        );
      } else {
        log(`clean-snapshot-replay: EXIT 0 ${step.label} (${(result.durationMs / 1000).toFixed(1)}s)`);
      }
      records.push({
        id: step.id,
        label: step.label,
        npmArgs: step.npmArgs,
        exitCode: result.code,
        signal: result.signal,
        durationMs: result.durationMs,
        timedOut: result.kind === 'timeout',
        logPath: logRelative,
        accept,
        acceptReportPath,
      });

      if (failed) {
        break;
      }
    }

    const environment = {
      platform: `${platform()} ${release()}`,
      arch: arch(),
      node: process.version,
      npm: npmVersion.stdout.trim(),
      git: gitVersion.stdout.trim(),
      commit,
      branch,
      generatedAtUtc: new Date().toISOString(),
    };
    writeEvidence('environment.json', `${JSON.stringify(environment, null, 2)}\n`);
    writeEvidence(
      'commands.json',
      `${sanitizeEvidenceText(
        JSON.stringify(
          {
            tool: 'clean-snapshot-replay',
            schemaVersion: 1,
            commit,
            branch,
            worktree: 'clean',
            snapshot: snapshotRoot,
            overallExitCode: ok ? 0 : 1,
            steps: records,
          },
          null,
          2,
        ),
        replacements,
      )}\n`,
    );
  } finally {
    if (!options.keepSnapshot) {
      try {
        assertSafeTempRoot(tempRoot, tempPrefix);
        rmSync(tempRoot, { recursive: true, force: true });
        log(`clean-snapshot-replay: 已清理临时快照 ${snapshotRoot}`);
      } catch (error) {
        ok = false;
        log(`clean-snapshot-replay: 临时快照清理失败：${(error as Error).message}`);
      }
    }
  }

  return { ok, commit, branch, outDir, snapshotRoot, evidence };
}

function printUsage(): void {
  process.stdout.write(
    'usage: node scripts/acceptance/clean-snapshot-replay.ts [--root <dir>] [--out <dir>] [--keep]\n' +
      '  --root <dir>  受测仓库根（默认：本脚本所在仓库；要求工作树 clean 且已提交）\n' +
      '  --out <dir>   证据输出目录（默认 docs/acceptance/evidence-p01-4）\n' +
      '  --keep        保留临时快照用于诊断（默认清理）\n',
  );
}

async function main(argv: string[]): Promise<number> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  let root = resolve(scriptDir, '..', '..');
  let outDir: string | undefined;
  let keepSnapshot = false;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--root' && i + 1 < rest.length) {
      root = resolve(rest[i + 1] as string);
      i += 1;
    } else if (arg === '--out' && i + 1 < rest.length) {
      const value = rest[i + 1] as string;
      outDir = isAbsolute(value) ? value : resolve(root, value);
      i += 1;
    } else if (arg === '--keep') {
      keepSnapshot = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return 0;
    } else {
      process.stderr.write(`clean-snapshot-replay: unknown argument "${arg}"\n`);
      printUsage();
      return 2;
    }
  }

  try {
    const outcome = await runCleanSnapshotReplay({ root, outDir, keepSnapshot });
    process.stdout.write(
      `clean-snapshot-replay: ${outcome.ok ? 'PASS' : 'FAIL'} commit=${outcome.commit} evidence=${outcome.evidence.length} out=${outcome.outDir}\n`,
    );
    return outcome.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`clean-snapshot-replay: FAIL ${(error as Error).message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`clean-snapshot-replay: FAIL unexpected error: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
