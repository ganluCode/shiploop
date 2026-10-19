/**
 * P03-10 / F-018 阶段验收控制器。
 *
 * 控制器只编排既有工程门禁和确定性测试，不进入 packages/，不调用模型，
 * 不写业务数据库。所有命令使用显式 argv、隔离临时环境和有界进程执行；
 * 顺序中断、入口缺失、超时、报告或清理失败均 fail-closed。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { arch, homedir, platform, release } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P03_ACCEPT_CONFIG_PATH,
  P03_ACCEPT_MAX_TIMEOUT_MS,
  P03_ACCEPT_MIN_TIMEOUT_MS,
  P03_CHECKLIST_PATH,
  P03_REQUIRED_CHECK_IDS,
  loadP03AcceptanceConfig,
  loadP03Checklist,
  validateP03AcceptanceConfig,
  type P03AcceptanceConfig,
  type P03Checklist,
  type P03EvidenceCategory,
} from './p03-config.ts';
import {
  assertValidRunId,
  buildP03AcceptanceReport,
  computeP03PhaseExitCode,
  generateP03RunId,
  verifyP03ReportDirectory,
  writeP03AcceptanceReport,
} from './p03-report.ts';
import type {
  P03CheckResultInput,
  P03CommandRecord,
  P03EvidenceFileInput,
  P03PhaseReportInput,
  P03WrittenReport,
} from './p03-report.ts';
import { runBoundedProcess, type P02BoundedRunOutcome } from './p02-accept.ts';
import { evaluateP03TestEvidence, requiredP03TestBindings, type P03TestProof } from './p03-test-evidence.ts';

export const P03_ACCEPT_SCRIPT_NAME = 'accept:p03';
export const P03_ACCEPT_USAGE =
  `usage: ${P03_ACCEPT_SCRIPT_NAME} [--run-id <id>] [--report-dir <dir>] ` +
  '[--step-timeout-ms <ms>] [--overall-timeout-ms <ms>] [--help]';

export type P03AcceptErrorKind = 'invalid_usage' | 'invalid_config' | 'preparation_failed' | 'report_write_failed';
export class P03AcceptError extends Error {
  readonly kind: P03AcceptErrorKind;
  constructor(kind: P03AcceptErrorKind, message: string) {
    super(message);
    this.name = 'P03AcceptError';
    this.kind = kind;
  }
}

export interface P03AcceptanceRunOptions {
  readonly repoRoot: string;
  readonly config: P03AcceptanceConfig;
  readonly checklist?: P03Checklist;
  readonly runId?: string;
  readonly reportRoot?: string;
  readonly stepTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly log?: (message: string) => void;
  readonly runProcess?: typeof runBoundedProcess;
  readonly testFiles?: readonly string[];
}

export interface P03AcceptanceRunResult {
  readonly runId: string;
  readonly runDir: string | null;
  readonly exitCode: number;
  readonly conclusion: 'pass' | 'fail' | null;
  readonly problems: readonly string[];
  readonly reportWritten: boolean;
  readonly evidenceOk: boolean;
  readonly written: P03WrittenReport | null;
}

type Step = {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly checkIds: readonly string[];
};

const HEX_40 = /^[0-9a-f]{40}$/;
const DEFAULT_TEST_INDEX_ROOTS = [
  'test/index/phases/P03/features/P03-10/tasks',
  'test/index/phases/P03/features/P03-9/tasks',
] as const;

function fail(kind: P03AcceptErrorKind, message: string): never {
  throw new P03AcceptError(kind, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function runText(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
}

function safeRunText(command: string, args: readonly string[], cwd: string, fallback: string): string {
  try {
    return runText(command, args, cwd) || fallback;
  } catch {
    return fallback;
  }
}

function gitFacts(repoRoot: string): P03PhaseReportInput['git'] {
  const commit = safeRunText('git', ['rev-parse', 'HEAD'], repoRoot, '');
  if (!HEX_40.test(commit)) fail('preparation_failed', '无法取得当前 Git commit');
  const status = runText('git', ['status', '--porcelain'], repoRoot);
  const branch = safeRunText('git', ['branch', '--show-current'], repoRoot, '') || null;
  return {
    commit,
    worktree: status === '' ? 'clean' : 'dirty',
    branch,
    priorBaselines: [{ phase: 'P03', branch: branch ?? '<detached>', tipCommit: commit }],
  };
}

function packageVersion(repoRoot: string, packageName: string): string {
  try {
    const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
    const manifest = requireFromRepo(`${packageName}/package.json`) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function collectTestFiles(repoRoot: string): string[] {
  const files = new Set<string>();
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as {
            projects?: { tests?: { file?: unknown }[] }[];
          };
          for (const project of raw.projects ?? []) {
            for (const test of project.tests ?? []) {
              if (typeof test.file === 'string' && /^test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(test.file)) {
                files.add(test.file);
              }
            }
          }
        } catch {
          // Invalid task index is reported by the preparation check below.
        }
      }
    }
  };
  for (const root of DEFAULT_TEST_INDEX_ROOTS) visit(join(repoRoot, root));
  return [...files].sort();
}

function checkFileSet(repoRoot: string, files: readonly string[]): string | null {
  for (const file of files) {
    if (!existsSync(join(repoRoot, file)) || !statSync(join(repoRoot, file)).isFile()) {
      return file;
    }
  }
  return null;
}

function buildSteps(config: P03AcceptanceConfig, repoRoot: string, testFiles: readonly string[], stepTimeoutMs: number, jsonReport: string): Step[] {
  if (config.requiredChecks.join('\u0000') !== P03_REQUIRED_CHECK_IDS.join('\u0000')) {
    fail('invalid_config', 'requiredChecks 与冻结 P03 检查顺序不一致');
  }
  const checks = [...P03_REQUIRED_CHECK_IDS];
  const testArgs = ['test', '--', ...testFiles, '--reporter=json', `--outputFile=${jsonReport}`];
  return [
    { id: 'verify', label: '工程门禁 verify', command: 'npm', args: ['run', 'verify'], checkIds: checks },
    { id: 'deterministic-tests', label: 'P03 全部确定性场景', command: 'npm', args: testArgs, checkIds: checks },
  ];
}

function logicalArg(value: string, repoRoot: string): string {
  const absolute = resolve(repoRoot, value);
  return value.startsWith(repoRoot) ? `<repo>/${relative(repoRoot, absolute)}` : value;
}

function stepEvidence(step: Step, outcome: P02BoundedRunOutcome, commandPath: string): string {
  return JSON.stringify({
    stepId: step.id,
    label: step.label,
    argv: [step.command, ...step.args],
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    kind: outcome.kind,
    timedOut: outcome.timedOut,
    stoppedVerified: outcome.stoppedVerified,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    commandPath,
  }, null, 2) + '\n';
}

function checkEvidence(checkId: string, status: string, detail: string, category: P03EvidenceCategory, proof?: P03TestProof): string {
  return JSON.stringify({ checkId, status, category, detail, executionMode: 'fake',
    evidenceKind: 'indexed-test-assertions', proof: proof ?? null,
    note: 'Assertions from the actual test run, not a fabricated SQLite/Git/process snapshot.' }, null, 2) + '\n';
}

function resultFor(checkId: string, status: 'pass' | 'fail' | 'not_run', detail: string, evidenceRefs: readonly string[], durationMs?: number, proof?: P03TestProof): P03CheckResultInput {
  return {
    checkId,
    status,
    executionMode: 'fake',
    ...(status === 'not_run' ? { notRunReason: detail.includes('超时') ? 'timeout' as const : 'skipped' as const } : {}),
    assertions: proof?.bindings.map((binding, index) => ({ id: `indexed-assertion-${index + 1}`, satisfied: binding.passed })) ?? [],
    sideEffectVerified: status === 'pass' && proof?.passed === true,
    ...(durationMs === undefined ? {} : { durationMs }),
    detail,
    evidenceRefs,
  };
}

function createReportInput(
  repoRoot: string,
  config: P03AcceptanceConfig,
  checklist: P03Checklist,
  runId: string,
  commands: readonly P03CommandRecord[],
  results: readonly P03CheckResultInput[],
  cleanup: P03PhaseReportInput['cleanup'],
  productReports: P03PhaseReportInput['productReports'],
  facts: P03PhaseReportInput['git'],
): P03PhaseReportInput {
  const planPath = join(repoRoot, config.plan.contractDoc);
  const checklistPath = join(repoRoot, config.checklist);
  return {
    runId,
    generatedAtUtc: new Date().toISOString(),
    plan: {
      phaseId: config.plan.phaseId,
      stepId: config.plan.stepId,
      title: config.plan.title,
      scope: config.plan.scope,
      version: config.plan.version,
      contractDoc: config.plan.contractDoc,
      digestSha256: sha256(existsSync(planPath) ? readFileSync(planPath) : config.plan.title),
      checklistDigestSha256: sha256(existsSync(checklistPath) ? readFileSync(checklistPath) : JSON.stringify(checklist)),
    },
    git: facts,
    platform: { system: platform(), release: release(), arch: arch() },
    tools: {
      node: safeRunText(process.execPath, ['--version'], repoRoot, process.version),
      npm: safeRunText('npm', ['--version'], repoRoot, 'unknown'),
      git: safeRunText('git', ['--version'], repoRoot, 'unknown'),
      sqlite: safeRunText('sqlite3', ['--version'], repoRoot, 'unknown'),
      betterSqlite3: packageVersion(repoRoot, 'better-sqlite3'),
      drizzleOrm: packageVersion(repoRoot, 'drizzle-orm'),
    },
    commands,
    results,
    cleanup,
    productReports,
    knownLimitations: ['P03 deferred 项保持 not_run，不计入通过数；报告只记录确定性 Fake 执行。',
      '各检查的证据为实际测试断言映射，不冒充逐项数据库快照；夹具原始证据另存 evidence/scenarios。',
      '现有产品 Feature 门禁仍使用 full_fallback；task_union 策略贯通不在本次验收修补范围。'],
    stateDigests: { codeSha256: sha256(runText('git', ['rev-parse', 'HEAD^{tree}'], repoRoot)) },
  };
}

/** 运行一次 P03 阶段验收；可注入 runProcess 供控制器失败语义测试使用。 */
export async function runP03Acceptance(options: P03AcceptanceRunOptions): Promise<P03AcceptanceRunResult> {
  const log = options.log ?? (() => undefined);
  const checklist = options.checklist ?? loadP03Checklist(join(options.repoRoot, options.config.checklist));
  const runId = options.runId ?? generateP03RunId(new Date(), randomBytes(4).toString('hex'));
  assertValidRunId(runId);
  validateP03AcceptanceConfig(options.config);
  const reportRoot = resolve(options.repoRoot, options.reportRoot ?? options.config.reportRoot);
  const stepTimeoutMs = options.stepTimeoutMs ?? options.config.timeouts.stepMs;
  const overallTimeoutMs = options.overallTimeoutMs ?? options.config.timeouts.overallMs;
  if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs < P03_ACCEPT_MIN_TIMEOUT_MS || stepTimeoutMs > P03_ACCEPT_MAX_TIMEOUT_MS) {
    fail('invalid_config', `stepTimeoutMs 超出有限范围：${stepTimeoutMs}`);
  }
  if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < stepTimeoutMs || overallTimeoutMs > P03_ACCEPT_MAX_TIMEOUT_MS) {
    fail('invalid_config', `overallTimeoutMs 超出有限范围：${overallTimeoutMs}`);
  }

  const testFiles = options.testFiles ?? [...new Set([...collectTestFiles(options.repoRoot), ...requiredP03TestBindings(options.repoRoot).map(b => b.file)])].sort();
  if (testFiles.length === 0) fail('preparation_failed', 'empty/空测试选择不能退化为全仓测试');
  const missing = checkFileSet(options.repoRoot, testFiles);
  if (missing !== null) fail('preparation_failed', `确定性测试入口不存在：${missing}`);
  const acceptanceTempParent = process.env.TMPDIR ?? '/tmp';
  mkdirSync(acceptanceTempParent, { recursive: true });
  const tempRoot = mkdtempSync(join(acceptanceTempParent, 'shiploop-p03-'));
  const jsonReport = join(tempRoot, 'actual-test-results.json');
  const rawEvidence = join(tempRoot, 'scenario-evidence');
  const steps = buildSteps(options.config, options.repoRoot, testFiles, stepTimeoutMs, jsonReport);
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(tempRoot, 'home'),
    TMPDIR: join(tempRoot, 'tmp'),
    npm_config_cache: join(tempRoot, 'npm-cache'),
    SHIPLOOP_FAKE_PROVIDER: 'fake-provider',
    SHIPLOOP_FAKE_MODEL: 'fake-model',
    NO_COLOR: '1',
    P03_EVIDENCE_DIR: rawEvidence,
  };
  for (const directory of [baseEnv.HOME, baseEnv.TMPDIR, baseEnv.npm_config_cache, rawEvidence]) mkdirSync(directory!, { recursive: true });
  const commands: P03CommandRecord[] = [];
  const evidenceFiles: P03EvidenceFileInput[] = [];
  const results = new Map<string, P03CheckResultInput>();
  const recordResult = (result: P03CheckResultInput): void => {
    const previous = results.get(result.checkId);
    if (previous?.status === 'fail') return;
    if (previous?.status === 'not_run' && result.status === 'pass') return;
    results.set(result.checkId, result);
  };
  const problems: string[] = [];
  const sanitize = (value: string): string => value.replaceAll(options.repoRoot, '<repo>')
    .replaceAll(tempRoot, '<temp>').replaceAll(homedir(), '<home>');
  const proofs = new Map<string, P03TestProof>();
  let stopsConfirmed = true;
  let facts: P03PhaseReportInput['git'];
  const started = Date.now();
  let halt: string | null = null;
  try {
    facts = gitFacts(options.repoRoot);
    for (const [index, step] of steps.entries()) {
      const remaining = overallTimeoutMs - (Date.now() - started);
      const commandPath = `evidence/commands/${String(index + 1).padStart(2, '0')}-${step.id}.json`;
      if (halt !== null || remaining <= 0) {
        const detail = remaining <= 0 ? '阶段整体时间预算耗尽，步骤未启动' : `前序步骤失败，步骤未启动：${halt}`;
        for (const checkId of step.checkIds) {
          recordResult(resultFor(checkId, 'not_run', detail, []));
        }
        continue;
      }
      log(`${P03_ACCEPT_SCRIPT_NAME}: RUN ${step.label}`);
      const runner = options.runProcess ?? runBoundedProcess;
      const priorStopsConfirmed: boolean = stopsConfirmed;
      // A runner rejection gives no proof that its child tree has stopped.
      stopsConfirmed = false;
      const outcome = await runner(step.command, step.args, {
        cwd: options.repoRoot,
        env: step.id === 'deterministic-tests' ? { ...baseEnv, P03_USE_BUILT_DIST: '1' } : baseEnv,
        timeoutMs: Math.min(stepTimeoutMs, remaining),
        maxOutputBytes: options.config.maxCommandOutputBytes,
      });
      stopsConfirmed = priorStopsConfirmed && outcome.stoppedVerified;
      commands.push({ label: step.label, argv: [step.command, ...step.args].map((arg) => logicalArg(arg, options.repoRoot)), cwd: '<repo>', exitCode: outcome.exitCode, durationMs: outcome.durationMs, ...(outcome.timedOut ? { timedOut: true } : {}) });
      const diagnostic = sanitize(stepEvidence(step, outcome, commandPath));
      evidenceFiles.push({ path: commandPath, category: 'command-exit', checkId: null, content: diagnostic });
      log(diagnostic);
      const passed = outcome.kind === 'exit' && outcome.exitCode === 0 && outcome.stoppedVerified;
      const status = outcome.kind === 'timeout' ? 'not_run' : passed ? 'pass' : 'fail';
      const detail = outcome.kind === 'timeout' ? `步骤超过有限超时 ${Math.min(stepTimeoutMs, remaining)}ms` : passed ? `步骤退出 0：${step.label}` : `步骤失败：${outcome.kind}，退出码 ${String(outcome.exitCode)}`;
      if (passed && step.id === 'deterministic-tests') {
        let actual: unknown = null;
        try { actual = JSON.parse(readFileSync(jsonReport, 'utf8')); } catch { problems.push('Missing/invalid actual test JSON report'); }
        for (const proof of evaluateP03TestEvidence(options.repoRoot, actual)) {
          proofs.set(proof.checkId, proof);
          recordResult(resultFor(proof.checkId, proof.passed ? 'pass' : 'fail',
            proof.passed ? 'Indexed assertions actually executed and passed' : 'Required indexed assertions missing, skipped, failed or duplicated', [], outcome.durationMs, proof));
        }
      } else if (!passed) {
        for (const checkId of step.checkIds) recordResult(resultFor(checkId, status, detail, [], outcome.durationMs));
      }
      if (!passed) {
        halt = detail;
        problems.push(detail);
      }
    }
    for (const checkId of P03_REQUIRED_CHECK_IDS) {
      if (!results.has(checkId)) {
        const detail = '控制器未提交检查结果';
        recordResult(resultFor(checkId, 'not_run', detail, []));
        problems.push(`${checkId}: ${detail}`);
      }
    }
    for (const checkId of P03_REQUIRED_CHECK_IDS) {
      const current = results.get(checkId);
      const item = checklist.items.find((candidate) => candidate.id === checkId);
      const categories = item?.evidence ?? ['command-exit', 'report'];
      const detail = current?.detail ?? '控制器未提交检查结果';
      const status = current?.status ?? 'not_run';
      const refs = categories.map((category, categoryIndex) => `evidence/checks/${checkId}-${String(categoryIndex + 1).padStart(2, '0')}-${category}.json`);
      for (const [categoryIndex, category] of categories.entries()) {
        const path = refs[categoryIndex];
        if (path === undefined) continue;
        evidenceFiles.push({ path, category: category as P03EvidenceCategory, checkId, content: checkEvidence(checkId, status, detail, category as P03EvidenceCategory, proofs.get(checkId)) });
      }
      if (current !== undefined) results.set(checkId, { ...current, evidenceRefs: refs });
    }
    // Export real fixture evidence before deleting disposable resources. Never invent state rows.
    const exportRaw = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Symlink in scenario evidence');
        if (entry.isDirectory()) exportRaw(file);
        else if (entry.isFile()) {
          if (evidenceFiles.length > 2000 || statSync(file).size > 2 * 1024 * 1024) throw new Error('Scenario evidence limit exceeded');
          const content = sanitize(readFileSync(file, 'utf8'));
          evidenceFiles.push({ path: `evidence/scenarios/${relative(rawEvidence, file).replaceAll('\\', '/')}`, category: 'artifact', checkId: null, content });
        }
      }
    };
    exportRaw(rawEvidence);
    const actualProof = JSON.stringify({ evidenceKind: 'actual-indexed-test-assertions', checks: [...proofs.values()] }) + '\n';
    if (stopsConfirmed) rmSync(tempRoot, { recursive: true, force: true });
    const phaseEvidence: readonly { path: string; category: P03EvidenceCategory; content: string }[] = [
      { path: 'evidence/state/sqlite.json', category: 'sqlite', content: actualProof },
      { path: 'evidence/state/git.json', category: 'git', content: JSON.stringify({ runId, commit: facts.commit }) + '\n' },
      { path: 'evidence/state/process.json', category: 'process', content: JSON.stringify({ runId, processesGone: stopsConfirmed, commands }) + '\n' },
    ];
    for (const file of phaseEvidence) evidenceFiles.push({ ...file, checkId: null });
    const productPath = 'evidence/product/feature-execution-report.json';
    const manifestPath = 'evidence/cleanup/manifest.json';
    evidenceFiles.push({ path: productPath, category: 'report', checkId: null, content: JSON.stringify({ layer: 'product-report-test-evidence', runId, checks: [...proofs.values()].filter(p => p.checkId.startsWith('P03-FR3')) }) + '\n' });
    const removed = !existsSync(tempRoot);
    evidenceFiles.push({ path: manifestPath, category: 'manifest', checkId: null, content: JSON.stringify({ runId, tempRoot: '<temp>', cleanedBeforeReport: removed, processesGone: stopsConfirmed }) + '\n' });
    const cleanup: P03PhaseReportInput['cleanup'] = { confirmed: removed && stopsConfirmed, processesGone: stopsConfirmed, manifestEvidenceRefs: [manifestPath], notes: ['据真实受监督进程结果核验；未确认停止时保留现场，不假设清理成功。'] };
    const input = createReportInput(options.repoRoot, options.config, checklist, runId, commands, [...results.values()], cleanup, [{ featureId: 'shiploop-p03', label: 'P03 产品报告查询测试的实际断言证据', command: 'npm test -- <indexed product report test files>', evidenceRef: productPath }], facts);
    let written: P03WrittenReport;
    try {
      buildP03AcceptanceReport(checklist, input, evidenceFiles.map((file) => ({ identity: file.path, category: file.category, path: file.path, sha256: sha256(typeof file.content === 'string' ? file.content : file.content), sizeBytes: typeof file.content === 'string' ? Buffer.byteLength(file.content) : file.content.byteLength, checkId: file.checkId ?? null, capturedBeforeCleanup: true })));
      written = writeP03AcceptanceReport({ reportRoot, checklist, input, evidenceFiles });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`报告写入失败：${message}`);
      return { runId, runDir: null, exitCode: 1, conclusion: null, problems, reportWritten: false, evidenceOk: false, written: null };
    }
    const verification = verifyP03ReportDirectory(written.runDir, checklist);
    problems.push(...verification.problems);
    const exitCode = computeP03PhaseExitCode({ conclusion: written.conclusion, evidenceOk: verification.ok, reportWritten: true, cleanupConfirmed: cleanup.confirmed && cleanup.processesGone });
    log(`${P03_ACCEPT_SCRIPT_NAME}: ${exitCode === 0 ? 'PASS' : 'FAIL'} exit ${exitCode}`);
    return { runId, runDir: written.runDir, exitCode, conclusion: written.conclusion, problems, reportWritten: true, evidenceOk: verification.ok, written };
  } finally {
    if (stopsConfirmed) rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function resolveP03Args(argv: readonly string[], repoRoot: string): { config: P03AcceptanceConfig; runId?: string; reportRoot?: string; stepTimeoutMs?: number; overallTimeoutMs?: number; help?: boolean } {
  const config = loadP03AcceptanceConfig(join(repoRoot, P03_ACCEPT_CONFIG_PATH));
  let runId: string | undefined;
  let reportRoot: string | undefined;
  let stepTimeoutMs: number | undefined;
  let overallTimeoutMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return { config, help: true };
    if (!['--run-id', '--report-dir', '--step-timeout-ms', '--overall-timeout-ms'].includes(arg)) fail('invalid_usage', `未知参数：${arg}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) fail('invalid_usage', `参数缺少值：${arg}`);
    if (arg === '--run-id') { runId = value; assertValidRunId(value); }
    else if (arg === '--report-dir') { reportRoot = value; }
    else if (arg === '--step-timeout-ms') stepTimeoutMs = Number(value);
    else overallTimeoutMs = Number(value);
  }
  for (const [label, value] of [['step-timeout-ms', stepTimeoutMs], ['overall-timeout-ms', overallTimeoutMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < P03_ACCEPT_MIN_TIMEOUT_MS || value > P03_ACCEPT_MAX_TIMEOUT_MS)) fail('invalid_usage', `${label} 必须是有限毫秒预算`);
  }
  if (stepTimeoutMs !== undefined && overallTimeoutMs !== undefined && overallTimeoutMs < stepTimeoutMs) fail('invalid_usage', 'overall-timeout-ms 不得小于 step-timeout-ms');
  return { config, ...(runId === undefined ? {} : { runId }), ...(reportRoot === undefined ? {} : { reportRoot }), ...(stepTimeoutMs === undefined ? {} : { stepTimeoutMs }), ...(overallTimeoutMs === undefined ? {} : { overallTimeoutMs }) };
}

function isDirectInvocation(): boolean {
  try { return resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isDirectInvocation()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const invocation = resolveP03Args(process.argv.slice(2), repoRoot);
  if (invocation.help) { process.stdout.write(`${P03_ACCEPT_USAGE}\n`); }
  else {
    runP03Acceptance({ repoRoot, ...invocation, log: message => process.stdout.write(`${message}\n`) }).then(result => {
      for (const problem of result.problems) process.stderr.write(`${P03_ACCEPT_SCRIPT_NAME}: problem: ${problem}\n`);
      process.exit(result.exitCode);
    }).catch(error => {
      process.stderr.write(`${P03_ACCEPT_SCRIPT_NAME}: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  }
}
