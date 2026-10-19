/**
 * P03-10 / F-018 干净源码快照连续双次复跑。
 *
 * 这是阶段验收的显式长流程入口，不由 npm test/verify 递归调用。它只接受
 * 已提交且干净的受测仓库，创建精确 commit 的临时 clone，安装锁定依赖并构建，
 * 然后从非开发 cwd 连续两次调用公共 `npm run accept:p03`。两轮使用独立的
 * HOME/TMP/XDG/报告根，报告在快照清理前复制到证据目录并逐目录重验。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeTempRoot,
  createCleanSnapshot,
  killTrackedProcessGroups,
  resolveNpm,
  runNpm,
  sanitizeEvidenceText,
  sha256Hex,
  type BoundedResult,
  type CleanSnapshot,
} from './clean-snapshot-replay.ts';
import { loadP03Checklist } from './p03-config.ts';
import { verifyP03ReportDirectory } from './p03-report.ts';

export const P03_CLEAN_REPLAY_STEPS = ['npm-ci', 'build', 'accept-p03-1', 'accept-p03-2'] as const;
export type P03CleanReplayStep = (typeof P03_CLEAN_REPLAY_STEPS)[number];

const TEMP_PREFIX = 'shiploop-p03-clean-';
const DEFAULT_OUT_DIR = 'artifacts/acceptance/p03-clean-replay';
const ACCEPT_TIMEOUT_MS = 7_200_000;
const PREPARE_TIMEOUT_MS = 1_200_000;
const OUTPUT_LIMIT_BYTES = 512 * 1024;

export interface P03CleanReplayOptions {
  readonly root?: string;
  readonly outDir?: string;
  readonly round?: 1 | 2;
  readonly log?: (message: string) => void;
}

interface StepRecord {
  readonly id: P03CleanReplayStep;
  readonly argv: readonly string[];
  readonly cwd: '<snapshot>' | '<outside-snapshot>';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly kind: BoundedResult['kind'];
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly logPath: string;
}

interface ReplayRunRecord {
  readonly index: 1 | 2;
  readonly runId: string;
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly reportSizeBytes: number;
  readonly reportVerification: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly step: StepRecord;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isolatedBaseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // npm lifecycle/prefix variables belong to the launching checkout, not the clone.
  for (const key of Object.keys(env)) {
    if (/^npm_(?:config_|package_|lifecycle_)/i.test(key) || ['INIT_CWD', 'PWD', 'OLDPWD'].includes(key)) delete env[key];
  }
  return env;
}

function recordLog(
  outDir: string,
  step: P03CleanReplayStep,
  result: BoundedResult,
  replacements: CleanSnapshot['replacements'],
): string {
  const path = join(outDir, 'logs', `${step}.log`);
  const text = sanitizeEvidenceText(
    `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`,
    replacements,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  writeFileSync(`${path}.exitcode`, `${result.code === null ? 'unknown' : result.code}\n`, 'utf8');
  writeJson(`${path}.json`, {
    step,
    kind: result.kind,
    exitCode: result.code,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.kind === 'timeout',
    message: result.message,
  });
  return relative(outDir, path).replaceAll('\\', '/');
}

function hashDirectory(root: string): { sha256: string; sizeBytes: number; files: string[] } {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  const digestParts: string[] = [];
  let sizeBytes = 0;
  for (const path of files) {
    const bytes = readFileSync(path);
    const rel = relative(root, path).replaceAll('\\', '/');
    sizeBytes += bytes.byteLength;
    digestParts.push(`${rel}\0${sha256Hex(bytes)}\0${bytes.byteLength}`);
  }
  return { sha256: sha256Hex(digestParts.join('\n')), sizeBytes, files: files.map((path) => relative(root, path).replaceAll('\\', '/')) };
}

function makeRunId(index: 1 | 2): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `p03-clean-${stamp}-${index}`;
}

function runSucceeded(result: BoundedResult): boolean {
  return result.kind === 'exit' && result.code === 0;
}

async function runPrepare(snapshot: CleanSnapshot, outDir: string, records: StepRecord[]): Promise<StepRecord[]> {
  const npm = resolveNpm();
  const env: NodeJS.ProcessEnv = {
    ...isolatedBaseEnv(),
    HOME: join(snapshot.tempRoot, 'prepare-home'),
    TMPDIR: join(snapshot.tempRoot, 'prepare-tmp'),
    npm_config_cache: join(snapshot.tempRoot, 'prepare-npm-cache'),
    XDG_CONFIG_HOME: join(snapshot.tempRoot, 'prepare-xdg-config'),
    XDG_CACHE_HOME: join(snapshot.tempRoot, 'prepare-xdg-cache'),
    XDG_DATA_HOME: join(snapshot.tempRoot, 'prepare-xdg-data'),
    XDG_STATE_HOME: join(snapshot.tempRoot, 'prepare-xdg-state'),
    NO_COLOR: '1',
  };
  for (const directory of [env.HOME, env.TMPDIR, env.npm_config_cache, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
    if (directory !== undefined) mkdirSync(directory, { recursive: true });
  }
  for (const [id, args] of [['npm-ci', ['ci']] as const, ['build', ['run', 'build']] as const]) {
    const result = await runNpm(npm, args, snapshot.snapshotRoot, PREPARE_TIMEOUT_MS, env);
    records.push({
      id,
      argv: ['npm', ...args],
      cwd: '<snapshot>',
      exitCode: result.code,
      signal: result.signal,
      kind: result.kind,
      durationMs: result.durationMs,
      timedOut: result.kind === 'timeout',
      logPath: recordLog(outDir, id, result, snapshot.replacements),
    });
    writeJson(join(outDir, 'prepare.json'), { commit: snapshot.commit, steps: records });
    if (!runSucceeded(result)) break;
  }
  return records;
}

async function runAccept(
  snapshot: CleanSnapshot,
  outDir: string,
  index: 1 | 2,
): Promise<ReplayRunRecord> {
  const runRoot = join(snapshot.tempRoot, `accept-${index}`);
  const reportRoot = join(runRoot, 'reports');
  const env: NodeJS.ProcessEnv = {
    ...isolatedBaseEnv(),
    HOME: join(runRoot, 'home'),
    TMPDIR: join(runRoot, 'tmp'),
    npm_config_cache: join(runRoot, 'npm-cache'),
    XDG_CONFIG_HOME: join(runRoot, 'xdg-config'),
    XDG_CACHE_HOME: join(runRoot, 'xdg-cache'),
    XDG_DATA_HOME: join(runRoot, 'xdg-data'),
    XDG_STATE_HOME: join(runRoot, 'xdg-state'),
    SHIPLOOP_FAKE_PROVIDER: 'fake-provider',
    SHIPLOOP_FAKE_MODEL: 'fake-model',
    NO_COLOR: '1',
  };
  for (const directory of [env.HOME, env.TMPDIR, env.npm_config_cache, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, reportRoot]) {
    if (directory !== undefined) mkdirSync(directory, { recursive: true });
  }
  const runId = makeRunId(index);
  const args = ['run', 'accept:p03', '--', '--run-id', runId, '--report-dir', reportRoot];
  const result = await runNpm(resolveNpm(), args, snapshot.snapshotRoot, ACCEPT_TIMEOUT_MS, env);
  const step: StepRecord = {
    id: index === 1 ? 'accept-p03-1' : 'accept-p03-2',
    argv: ['npm', ...args],
    cwd: '<snapshot>',
    exitCode: result.code,
    signal: result.signal,
    kind: result.kind,
    durationMs: result.durationMs,
    timedOut: result.kind === 'timeout',
    logPath: recordLog(outDir, index === 1 ? 'accept-p03-1' : 'accept-p03-2', result, snapshot.replacements),
  };
  const reportDir = join(reportRoot, runId);
  const reportPath = join(reportDir, 'report.json');
  if (!existsSync(reportPath)) {
    return {
      index,
      runId,
      reportPath: `reports/run-${index}/report.json`,
      reportSha256: '',
      reportSizeBytes: 0,
      reportVerification: { ok: false, problems: ['accept:p03 未写出 report.json'] },
      step,
    };
  }
  const verification = verifyP03ReportDirectory(reportDir, loadP03Checklist(join(snapshot.snapshotRoot, 'acceptance/p03.checklist.json')));
  const reportBytes = readFileSync(reportPath);
  const copiedDir = join(outDir, `reports/run-${index}`);
  cpSync(reportDir, copiedDir, { recursive: true, force: false });
  return {
    index,
    runId,
    reportPath: relative(outDir, join(copiedDir, 'report.json')).replaceAll('\\', '/'),
    reportSha256: sha256Hex(reportBytes),
    reportSizeBytes: reportBytes.byteLength,
    reportVerification: verification,
    step,
  };
}

export async function runP03CleanReplay(options: P03CleanReplayOptions = {}): Promise<{ readonly ok: boolean; readonly commit: string | null; readonly problems: readonly string[] }> {
  if (options.round !== undefined && options.round !== 1 && options.round !== 2) throw new Error('round must be 1 or 2');
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(options.root ?? join(scriptDir, '..', '..'));
  const outDir = resolve(options.outDir ?? join(root, DEFAULT_OUT_DIR));
  const log = options.log ?? ((message: string): void => {
    process.stdout.write(`${message}\n`);
  });
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error('Evidence directory must be empty; choose a new output directory');
  mkdirSync(outDir, { recursive: true });
  const problems: string[] = [];
  let snapshot: CleanSnapshot | null = null;
  let prepared = false;
  let stopConfirmed = true;
  const prepare: StepRecord[] = [];
  const runs: ReplayRunRecord[] = [];
  try {
    snapshot = await createCleanSnapshot({
      root,
      tempPrefix: TEMP_PREFIX,
      log,
      ignorePorcelainPrefixes: ['artifacts'],
    });
    log(`p03-clean-replay: commit ${snapshot.commit}`);
    await runPrepare(snapshot, outDir, prepare);
    if (prepare.some(step => step.kind === 'spawn-error')) stopConfirmed = false;
    prepared = prepare.length === 2 && prepare.every((entry) => entry.exitCode === 0 && entry.kind === 'exit');
    writeJson(join(outDir, 'prepare.json'), { commit: snapshot.commit, steps: prepare });
    if (!prepared) problems.push('npm ci/build 未全部成功，后续 accept:p03 未具备可运行前提');

    const indices: readonly (1 | 2)[] = options.round === undefined ? [1, 2] : [options.round];
    for (const index of indices) {
      if (!prepared) break;
      const run = await runAccept(snapshot, outDir, index);
      runs.push(run);
      log(`p03-clean-replay: accept:p03-${index} exit ${String(run.step.exitCode)}`);
      if (run.step.exitCode !== 0) problems.push(`第 ${index} 次 accept:p03 退出码为 ${String(run.step.exitCode)}`);
      if (!run.reportVerification.ok) problems.push(...run.reportVerification.problems.map((problem) => `第 ${index} 次报告：${problem}`));
      if (run.reportSha256 === '') problems.push(`第 ${index} 次缺少完整报告`);
      if (run.step.kind === 'spawn-error') stopConfirmed = false;
      writeJson(join(outDir, 'replay.json'), { schemaVersion: 1, commit: snapshot.commit, steps: [...prepare, ...runs.map(item => item.step)], runs, problems });
      if (run.step.exitCode !== 0 || run.step.kind !== 'exit' || !run.reportVerification.ok || run.reportSha256 === '') break;
    }
    if (runs.length !== indices.length) problems.push(`实际完成 ${runs.length}/${indices.length} 次 accept:p03`);
    writeJson(join(outDir, 'replay.json'), {
      schemaVersion: 1,
      commit: snapshot.commit,
      branch: snapshot.branch,
      steps: [...prepare, ...runs.map((run) => run.step)],
      runs,
      independentResources: indices.map((index) => ({ index, home: `<TMPDIR>/accept-${index}/home`, tmp: `<TMPDIR>/accept-${index}/tmp`, reportRoot: `<TMPDIR>/accept-${index}/reports` })),
      problems,
    });
  } catch (error) {
    if (snapshot !== null) stopConfirmed = false;
    problems.push(error instanceof Error ? error.message : String(error));
    writeJson(join(outDir, 'replay.json'), { schemaVersion: 1, commit: snapshot?.commit ?? null, steps: [...prepare, ...runs.map(run => run.step)], runs, problems });
  } finally {
    killTrackedProcessGroups();
    if (snapshot !== null && stopConfirmed) {
      try {
        assertSafeTempRoot(snapshot.tempRoot, TEMP_PREFIX);
        rmSync(snapshot.tempRoot, { recursive: true, force: true });
      } catch (error) {
        problems.push(`临时快照清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const replayPath = join(outDir, 'replay.json');
  const cleanup = {
    confirmed: stopConfirmed && (snapshot === null || !existsSync(snapshot.tempRoot)),
    processesGone: stopConfirmed,
    ownedTempRoot: '<TMPDIR>',
  };
  if (!stopConfirmed) problems.push('进程停止未确认，保留临时快照；需要核验后再处置');
  writeJson(join(outDir, 'cleanup-manifest.json'), cleanup);
  if (!cleanup.confirmed) problems.push('cleanup manifest 未确认临时快照删除');
  const replay = existsSync(replayPath) ? JSON.parse(readFileSync(replayPath, 'utf8')) as Record<string, unknown> : {};
  writeJson(replayPath, { ...replay, problems, cleanup });
  const digest = hashDirectory(outDir);
  writeJson(join(outDir, 'evidence-manifest.json'), { commit: snapshot?.commit ?? null, directory: digest, cleanup });
  return { ok: problems.length === 0, commit: snapshot?.commit ?? null, problems };
}

function parseArgs(argv: readonly string[]): { root?: string; outDir?: string; round?: 1 | 2; help: boolean } {
  let root: string | undefined;
  let outDir: string | undefined;
  let round: 1 | 2 | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--root' || arg === '--out-dir' || arg === '--round') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
      if (arg === '--root') root = value;
      else if (arg === '--out-dir') outDir = value;
      else if (value === '1' || value === '2') round = Number(value) as 1 | 2;
      else throw new Error('--round 只能是 1 或 2');
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { root, outDir, round, help: false };
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write('usage: npm run accept:p03:clean-replay -- [--root <repo>] [--out-dir <dir>] [--round 1|2]\n');
      process.exit(0);
    }
    runP03CleanReplay(args).then((result) => {
      for (const problem of result.problems) process.stderr.write(`p03-clean-replay: problem: ${problem}\n`);
      process.exit(result.ok ? 0 : 1);
    }).catch((error: unknown) => {
      process.stderr.write(`p03-clean-replay: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  } catch (error) {
    process.stderr.write(`p03-clean-replay: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
