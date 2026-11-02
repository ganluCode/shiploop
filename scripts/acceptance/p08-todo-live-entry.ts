/**
 * P08-2 / F-009 `accept:p08:live` 正式入口编排。
 *
 * 入口只负责固定顺序、结果传播和证据封套；各场景的真实资源操作仍由
 * 已有窄适配器负责。报告保存脱敏的相对引用，人工门禁始终保持 pending。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPiTodoLivePorts,
  runTodoLiveDelivery,
  runTodoLiveProcess,
  saveTodoLiveReport,
  validateTodoLiveApproval,
  validateTodoLiveReport,
  type TodoLiveApprovalFile,
  type TodoLiveDeliveryReport,
  type TodoLiveTask,
} from './p08-todo-live.ts';
import {
  aggregateTodoLiveEvidence,
  saveTodoLiveEvidenceReport,
  todoLiveRequirementsIdentity,
  validateTodoLiveEvidenceReport,
} from './p08-todo-live-report.ts';
import { auditTodoLiveNegative, runTodoLiveNegativeScenario } from './p08-todo-live-negatives.ts';
import { validateTodoInstallSmokeReport } from './p08-todo-install-smoke.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const P08_TODO_LIVE_STAGE_ORDER = [
  'normal-live',
  'negative-fixtures',
  'report-validation',
  'clean-install',
  'existing-repository',
] as const;
export type TodoLiveAcceptanceStageId = (typeof P08_TODO_LIVE_STAGE_ORDER)[number];
export type TodoLiveAcceptanceStatus = 'passed' | 'failed' | 'not_run' | 'inconclusive';

export interface TodoLiveAcceptanceStageOutcome {
  readonly id: TodoLiveAcceptanceStageId;
  readonly status: TodoLiveAcceptanceStatus;
  readonly exitCode: number | null;
  readonly command: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
}

export interface TodoLiveAcceptanceManualItem {
  readonly id: 'todo-coverage' | 'real-model-participation' | 'commit-report-identity' | 'sensitive-boundary' | 'owner-signature';
  readonly status: 'pending';
  readonly owner: 'owner';
  readonly item: string;
}

export const P08_TODO_LIVE_MANUAL_ITEMS: readonly TodoLiveAcceptanceManualItem[] = [
  { id: 'todo-coverage', status: 'pending', owner: 'owner', item: '负责人核对 Todo 需求九类行为、正常路径和关键失败分支均有覆盖' },
  { id: 'real-model-participation', status: 'pending', owner: 'owner', item: '负责人核对正常交付由获准 provider/model 的真实 Pi 参与，未由 FakeRuntime 替代' },
  { id: 'commit-report-identity', status: 'pending', owner: 'owner', item: '负责人核对每个 Task 的提交、tree、Task/Feature/Run/Attempt 与报告身份一致' },
  { id: 'sensitive-boundary', status: 'pending', owner: 'owner', item: '负责人核对凭据、绝对路径和大输出未进入报告或普通日志' },
  { id: 'owner-signature', status: 'pending', owner: 'owner', item: '负责人依据完整证据填写签署记录；模型或脚本不得代签' },
];

export const P08_TODO_LIVE_PHASE_GAPS = [
  { id: 'real-host-sqlite-process', status: 'not_run' as const, owner: 'phase-integration' as const, reason: '真实 Host/SQLite/受管进程跨层组合由 Phase 集成入口执行' },
  { id: 'recovery-and-stop', status: 'not_run' as const, owner: 'phase-integration' as const, reason: '停止确认、孤儿进程、恢复与资源占用由 Phase 集成入口执行' },
  { id: 'registry-and-native-install', status: 'not_run' as const, owner: 'phase-integration' as const, reason: 'registry 安装和原生模块全新机器矩阵由 Phase 集成入口执行' },
  { id: 'existing-project-product-flow', status: 'not_run' as const, owner: 'phase-integration' as const, reason: '存量项目真实 project init/Host/SQLite/Pi 增量闭环由 Phase 集成入口执行' },
] as const;

export interface TodoLiveAcceptanceInput {
  readonly repository: string;
  readonly reportDirectory: string;
  readonly commit: string | null;
  readonly tree: string | null;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly platform: string;
  readonly budgets: { readonly taskTimeoutMs: number; readonly totalTimeoutMs: number; readonly maxTasks: number };
  readonly approval?: TodoLiveAcceptanceApproval;
  readonly runStage?: (stage: TodoLiveAcceptanceStageId, context: TodoLiveAcceptanceStageContext) => Promise<TodoLiveAcceptanceStageOutcome>;
}

export interface TodoLiveAcceptanceApproval extends TodoLiveApprovalFile {
  readonly repository?: string;
  readonly reportDirectory?: string;
  readonly secret?: string;
  readonly tasks?: readonly TodoLiveTask[];
  readonly verificationCommands?: Readonly<Record<string, readonly string[]>>;
  readonly distributionDir?: string;
}

export interface TodoLiveAcceptanceStageContext {
  readonly repository: string;
  readonly reportDirectory: string;
  readonly approval: TodoLiveAcceptanceApproval | undefined;
  readonly budgets: TodoLiveAcceptanceInput['budgets'];
}

export interface TodoLiveAcceptanceReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.todo.live-acceptance';
  readonly status: TodoLiveAcceptanceStatus;
  readonly statusReason: string | null;
  readonly code: { readonly headCommit: string | null; readonly headTree: string | null };
  readonly environment: { readonly nodeVersion: string; readonly npmVersion: string; readonly platform: string };
  readonly budgets: TodoLiveAcceptanceInput['budgets'];
  readonly stages: readonly TodoLiveAcceptanceStageOutcome[];
  readonly manualPending: readonly TodoLiveAcceptanceManualItem[];
  readonly knownGaps: typeof P08_TODO_LIVE_PHASE_GAPS;
  readonly evidenceRoot: 'relative-to-report-directory';
  readonly reportDigest: string;
}

export class TodoLiveAcceptanceError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'TodoLiveAcceptanceError';
  }
}

function fail(reason: string): never { throw new TodoLiveAcceptanceError(reason); }
function validText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function gitIdentity(repository: string): { readonly headCommit: string | null; readonly headTree: string | null } {
  try {
    const run = (args: readonly string[]) => execFileSync('git', ['-C', repository, ...args], { cwd: repository, encoding: 'utf8', timeout: 10_000 }).trim();
    const headCommit = run(['rev-parse', 'HEAD']);
    const headTree = run(['rev-parse', 'HEAD^{tree}']);
    return GIT_SHA.test(headCommit) && GIT_SHA.test(headTree) ? { headCommit, headTree } : { headCommit: null, headTree: null };
  } catch { return { headCommit: null, headTree: null }; }
}
function detectNpmVersion(): string {
  try { return execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim() || 'unknown'; } catch { return 'unknown'; }
}
function assertInput(input: TodoLiveAcceptanceInput): void {
  if (!isAbsolute(input.repository) || !isAbsolute(input.reportDirectory)) fail('entry_path_invalid');
  if (input.commit !== null && !GIT_SHA.test(input.commit)) fail('entry_commit_invalid');
  if (input.tree !== null && !GIT_SHA.test(input.tree)) fail('entry_tree_invalid');
  if (!validText(input.nodeVersion) || !validText(input.npmVersion) || !validText(input.platform)) fail('entry_environment_invalid');
  if (!input.budgets || !Number.isSafeInteger(input.budgets.taskTimeoutMs) || input.budgets.taskTimeoutMs < 1
      || !Number.isSafeInteger(input.budgets.totalTimeoutMs) || input.budgets.totalTimeoutMs < 1
      || !Number.isSafeInteger(input.budgets.maxTasks) || input.budgets.maxTasks < 3) fail('entry_budget_invalid');
}
function assertStage(value: TodoLiveAcceptanceStageOutcome, expected: TodoLiveAcceptanceStageId): void {
  if (!value || value.id !== expected || !['passed', 'failed', 'not_run', 'inconclusive'].includes(value.status)
      || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) || !Array.isArray(value.command)
      || value.command.some(item => !validText(item) || isAbsolute(item)) || !Array.isArray(value.evidenceRefs)
      || value.evidenceRefs.some(ref => !SAFE_REF.test(ref) || ref.includes('..'))
      || (value.status === 'passed' && value.exitCode !== 0)
      || (value.status === 'not_run' && value.exitCode !== null)
      || (value.status === 'failed' && value.exitCode === 0)
      || (value.reason !== undefined && !validText(value.reason))) fail('stage_outcome_invalid');
}
function deriveStatus(stages: readonly TodoLiveAcceptanceStageOutcome[]): { readonly status: TodoLiveAcceptanceStatus; readonly reason: string | null } {
  if (stages.some(stage => stage.status === 'failed')) return { status: 'failed', reason: 'stage_failed' };
  if (stages.some(stage => stage.status === 'not_run')) return { status: 'not_run', reason: 'stage_not_run' };
  if (stages.some(stage => stage.status === 'inconclusive')) return { status: 'inconclusive', reason: 'stage_inconclusive' };
  return { status: 'inconclusive', reason: 'manual_pending' };
}

export function acceptanceExitCode(status: TodoLiveAcceptanceStatus): 0 | 1 | 2 | 3 {
  return status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'not_run' ? 2 : 3;
}

export function runTodoLiveAcceptance(input: TodoLiveAcceptanceInput): Promise<TodoLiveAcceptanceReport> {
  assertInput(input);
  return (async () => {
    await mkdir(input.reportDirectory, { recursive: true, mode: 0o700 });
    const context: TodoLiveAcceptanceStageContext = { repository: input.repository, reportDirectory: input.reportDirectory, approval: input.approval, budgets: input.budgets };
    const stages: TodoLiveAcceptanceStageOutcome[] = [];
    for (const stage of P08_TODO_LIVE_STAGE_ORDER) {
      let result: TodoLiveAcceptanceStageOutcome;
      try {
        result = input.runStage === undefined ? await runDefaultStage(stage, context) : await input.runStage(stage, context);
      } catch (error) {
        result = { id: stage, status: 'failed', exitCode: 1, command: [`stage:${stage}`], evidenceRefs: [], reason: error instanceof TodoLiveAcceptanceError ? error.reason : 'stage_exception' };
      }
      assertStage(result, stage);
      stages.push(result);
    }
    const derived = deriveStatus(stages);
    const body = {
      schemaVersion: 1 as const,
      kind: 'shiploop.todo.live-acceptance' as const,
      status: derived.status,
      statusReason: derived.reason,
      code: { headCommit: input.commit, headTree: input.tree },
      environment: { nodeVersion: input.nodeVersion, npmVersion: input.npmVersion, platform: input.platform },
      budgets: input.budgets,
      stages,
      manualPending: P08_TODO_LIVE_MANUAL_ITEMS,
      knownGaps: P08_TODO_LIVE_PHASE_GAPS,
      evidenceRoot: 'relative-to-report-directory' as const,
    };
    return { ...body, reportDigest: digest(body) };
  })();
}

export function validateTodoLiveAcceptanceReport(value: unknown): TodoLiveAcceptanceReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('entry_report_invalid');
  const report = value as Partial<TodoLiveAcceptanceReport>;
  if (report.schemaVersion !== 1 || report.kind !== 'shiploop.todo.live-acceptance'
      || !['passed', 'failed', 'not_run', 'inconclusive'].includes(report.status ?? '')
      || (report.status === 'passed' && report.statusReason !== null)
      || (report.status !== 'passed' && !validText(report.statusReason))
      || !report.code || !report.environment || !report.budgets || !Array.isArray(report.stages)
      || !Array.isArray(report.manualPending) || !Array.isArray(report.knownGaps)
      || report.evidenceRoot !== 'relative-to-report-directory' || !SHA256.test(report.reportDigest ?? '')) fail('entry_report_invalid');
  if ((report.code.headCommit !== null && !GIT_SHA.test(report.code.headCommit ?? ''))
      || (report.code.headTree !== null && !GIT_SHA.test(report.code.headTree ?? ''))) fail('entry_report_code_invalid');
  const expected = P08_TODO_LIVE_STAGE_ORDER;
  if (report.stages.length !== expected.length) fail('entry_stage_count_invalid');
  report.stages.forEach((stage, index) => assertStage(stage!, expected[index]!));
  const derived = deriveStatus(report.stages as TodoLiveAcceptanceStageOutcome[]);
  if (derived.status !== report.status || derived.reason !== report.statusReason) fail('entry_status_propagation_invalid');
  if (canonical(report.manualPending) !== canonical(P08_TODO_LIVE_MANUAL_ITEMS)) fail('entry_manual_gate_invalid');
  if (canonical(report.knownGaps) !== canonical(P08_TODO_LIVE_PHASE_GAPS)) fail('entry_known_gap_invalid');
  const serialized = JSON.stringify(report);
  if (serialized.includes('/Users/') || serialized.includes('/home/') || /(?:token|secret|password|api[-_]?key)/i.test(serialized)) fail('entry_report_sensitive');
  const { reportDigest, ...body } = report;
  if (digest(body) !== reportDigest) fail('entry_report_digest_invalid');
  return report as TodoLiveAcceptanceReport;
}

export async function saveTodoLiveAcceptanceReport(path: string, report: TodoLiveAcceptanceReport): Promise<void> {
  if (!isAbsolute(path)) fail('entry_report_path_invalid');
  validateTodoLiveAcceptanceReport(report);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function runDefaultStage(stage: TodoLiveAcceptanceStageId, context: TodoLiveAcceptanceStageContext): Promise<TodoLiveAcceptanceStageOutcome> {
  if (stage === 'normal-live') return runNormalStage(context);
  if (stage === 'negative-fixtures') return runNegativeStage(context);
  if (stage === 'report-validation') return runReportValidationStage(context);
  if (stage === 'clean-install') return runInstallStage(context);
  return runExistingStage(context);
}

function notRun(stage: TodoLiveAcceptanceStageId, reason: string): TodoLiveAcceptanceStageOutcome {
  return { id: stage, status: 'not_run', exitCode: null, command: [`stage:${stage}`], evidenceRefs: [], reason };
}
function approvalConfig(context: TodoLiveAcceptanceStageContext): TodoLiveAcceptanceApproval | null {
  const approval = context.approval;
  if (approval === undefined || !validText(approval.repository) || !validText(approval.secret)
      || !Array.isArray(approval.tasks) || approval.tasks.length < 3 || approval.verificationCommands === undefined) return null;
  return approval;
}

async function runNormalStage(context: TodoLiveAcceptanceStageContext): Promise<TodoLiveAcceptanceStageOutcome> {
  const approval = approvalConfig(context);
  if (approval === null) return notRun('normal-live', 'explicit_approval_or_live_configuration_required');
  const repository = resolve(approval.repository!);
  const reportDirectory = resolve(context.reportDirectory, 'normal-live');
  const ports = createPiTodoLivePorts({ repository, reportDirectory, authorization: approval.authorization, secret: approval.secret!, verificationCommands: approval.verificationCommands!, timeoutMs: context.budgets.taskTimeoutMs });
  const delivery = await runTodoLiveDelivery({ projectId: approval.projectId, featureId: approval.featureId, runId: approval.runId, tasks: approval.tasks!, authorization: approval.authorization, ports });
  await saveTodoLiveReport(resolve(approval.reportFile), delivery);
  const evidenceReport = resolve(reportDirectory, 'delivery-report.json');
  await saveTodoLiveReport(evidenceReport, delivery);
  return { id: 'normal-live', status: delivery.status === 'passed' ? 'passed' : 'failed', exitCode: delivery.status === 'passed' ? 0 : 1, command: ['node', 'scripts/acceptance/p08-todo-live-runner.ts'], evidenceRefs: ['normal-live/delivery-report.json'], ...(delivery.status === 'passed' ? {} : { reason: 'delivery_gate_failed' }) };
}

async function runNegativeStage(context: TodoLiveAcceptanceStageContext): Promise<TodoLiveAcceptanceStageOutcome> {
  const tasks = context.approval?.tasks;
  if (!Array.isArray(tasks) || tasks.length < 3) return notRun('negative-fixtures', 'approved_task_plan_required');
  const root = resolve(context.reportDirectory, 'negative-fixtures');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const modes = ['auth-failure', 'budget-exhaustion', 'cancel', 'interruption-restart', 'dependency-failure'] as const;
  for (const mode of modes) {
    const scenarioRoot = join(root, mode);
    const report = await runTodoLiveNegativeScenario({ scenarioId: mode, mode, workspaceRoot: scenarioRoot, tasks: tasks.map(task => ({ id: task.id, title: task.title, dependsOn: task.dependsOn })) });
    const audit = await auditTodoLiveNegative(scenarioRoot, mode);
    if (!audit.ok || (mode === 'auth-failure' ? report.status !== 'failed' && report.status !== 'not_run' : report.status !== 'failed')) {
      return { id: 'negative-fixtures', status: 'failed', exitCode: 1, command: ['node', 'scripts/acceptance/p08-todo-live-negatives.ts'], evidenceRefs: [`negative-fixtures/${mode}/state/${mode}.json`], reason: audit.problems[0] ?? 'negative_expectation_failed' };
    }
  }
  return { id: 'negative-fixtures', status: 'passed', exitCode: 0, command: ['node', 'scripts/acceptance/p08-todo-live-negatives.ts'], evidenceRefs: modes.map(mode => `negative-fixtures/${mode}/state/${mode}.json`) };
}

async function runReportValidationStage(context: TodoLiveAcceptanceStageContext): Promise<TodoLiveAcceptanceStageOutcome> {
  const approval = context.approval;
  if (approval === undefined || !validText(approval.reportFile)) return notRun('report-validation', 'normal_live_report_not_available');
  let raw: string;
  let delivery: TodoLiveDeliveryReport;
  try { raw = await readFile(resolve(approval.reportFile), 'utf8'); delivery = validateTodoLiveReport(JSON.parse(raw)); } catch { return { id: 'report-validation', status: 'failed', exitCode: 1, command: ['node', 'scripts/acceptance/p08-todo-live-report.ts'], evidenceRefs: [], reason: 'delivery_report_invalid' }; }
  const code = gitIdentity(context.repository);
  const requirementIdentity = todoLiveRequirementsIdentity(context.repository);
  const artifactPath = join(context.reportDirectory, 'report-validation', 'delivery-report.json');
  const evidencePath = join(context.reportDirectory, 'report-validation', 'evidence-report.json');
  await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  await writeFile(artifactPath, raw, { flag: 'wx', mode: 0o600 });
  const evidence = aggregateTodoLiveEvidence({ delivery, requirements: requirementIdentity, code, checks: [{ id: 'delivery-report', exitCode: 0, command: ['node', 'scripts/acceptance/p08-todo-live.ts'], evidence: { ref: 'delivery-report.json', content: raw } }] });
  await saveTodoLiveEvidenceReport(evidencePath, evidence);
  validateTodoLiveEvidenceReport(JSON.parse(await readFile(evidencePath, 'utf8')), { delivery, artifactRoot: dirname(artifactPath) });
  return { id: 'report-validation', status: 'passed', exitCode: 0, command: ['node', 'scripts/acceptance/p08-todo-live-report.ts'], evidenceRefs: ['report-validation/evidence-report.json', 'report-validation/delivery-report.json'] };
}

async function runInstallStage(context: TodoLiveAcceptanceStageContext): Promise<TodoLiveAcceptanceStageOutcome> {
  const distribution = context.approval?.distributionDir;
  if (!validText(distribution)) return notRun('clean-install', 'local_distribution_input_required');
  const script = fileURLToPath(new URL('./p08-todo-install-smoke.ts', import.meta.url));
  const output = resolve(context.reportDirectory, 'clean-install', 'todo-install-smoke.json');
  const result = await runTodoLiveProcess({ command: [process.execPath, script, '--input', resolve(distribution), '--output', output, '--repo-root', context.repository, '--source-bin', resolve(context.repository, 'packages/cli/dist/bin.js')], cwd: context.repository, timeoutMs: context.budgets.totalTimeoutMs });
  if (result.exitCode !== 0) return { id: 'clean-install', status: 'failed', exitCode: result.exitCode, command: ['node', 'scripts/acceptance/p08-todo-install-smoke.ts'], evidenceRefs: [], reason: result.exitCode === null ? 'install_smoke_timeout' : 'install_smoke_failed' };
  let installReport: ReturnType<typeof validateTodoInstallSmokeReport>;
  try {
    installReport = validateTodoInstallSmokeReport(JSON.parse(await readFile(output, 'utf8')));
    if (!installReport.passed) return { id: 'clean-install', status: 'failed', exitCode: 1, command: ['node', 'scripts/acceptance/p08-todo-install-smoke.ts'], evidenceRefs: ['clean-install/todo-install-smoke.json'], reason: 'install_report_failed' };
  } catch { return { id: 'clean-install', status: 'failed', exitCode: 1, command: ['node', 'scripts/acceptance/p08-todo-install-smoke.ts'], evidenceRefs: [], reason: 'install_report_invalid' }; }
  return { id: 'clean-install', status: 'passed', exitCode: 0, command: ['node', 'scripts/acceptance/p08-todo-install-smoke.ts'], evidenceRefs: ['clean-install/todo-install-smoke.json'] };
}

async function runExistingStage(context: TodoLiveAcceptanceStageContext): Promise<TodoLiveAcceptanceStageOutcome> {
  const testFile = 'test/modules/acceptance/p08-2-f008-existing-demo.test.ts';
  const result = await runTodoLiveProcess({ command: [process.execPath, 'scripts/run-tests.ts', testFile], cwd: context.repository, timeoutMs: context.budgets.totalTimeoutMs });
  const evidence = join(context.reportDirectory, 'existing-repository', 'fixture-test.json');
  await mkdir(dirname(evidence), { recursive: true, mode: 0o700 });
  await writeFile(evidence, `${JSON.stringify({ testFile, exitCode: result.exitCode, outputDigest: digest({ stdout: result.stdout, stderr: result.stderr }) })}\n`, { flag: 'wx', mode: 0o600 });
  return { id: 'existing-repository', status: result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode, command: ['node', 'scripts/run-tests.ts', testFile], evidenceRefs: ['existing-repository/fixture-test.json'], ...(result.exitCode === 0 ? {} : { reason: 'existing_fixture_failed' }) };
}

export function parseTodoLiveAcceptanceApproval(value: unknown): TodoLiveAcceptanceApproval {
  const approval = validateTodoLiveApproval(value) as TodoLiveAcceptanceApproval;
  if (approval.repository !== undefined && !isAbsolute(approval.repository)) fail('approval_repository_invalid');
  if (approval.reportDirectory !== undefined && !isAbsolute(approval.reportDirectory)) fail('approval_report_directory_invalid');
  if (approval.secret !== undefined && (!validText(approval.secret) || approval.secret.length > 16_384)) fail('approval_secret_invalid');
  if (approval.distributionDir !== undefined && !isAbsolute(approval.distributionDir)) fail('approval_distribution_invalid');
  if (approval.tasks !== undefined && (!Array.isArray(approval.tasks) || approval.tasks.length < 3)) fail('approval_tasks_invalid');
  return approval;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const approvalIndex = args.indexOf('--approval');
  const outputIndex = args.indexOf('--output');
  const approvalPath = approvalIndex >= 0 ? args[approvalIndex + 1] : undefined;
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1]! : join(process.cwd(), 'artifacts', 'acceptance', 'p08-live', 'acceptance-report.json');
  const repository = resolve(process.cwd());
  const code = gitIdentity(repository);
  let approval: TodoLiveAcceptanceApproval | undefined;
  if (approvalPath !== undefined && !isAbsolute(approvalPath)) fail('approval_path_invalid');
  if (approvalPath === undefined) {
    const report = await runTodoLiveAcceptance({ repository, reportDirectory: resolve(dirname(outputPath), 'evidence', `run-${Date.now()}`), commit: code.headCommit, tree: code.headTree, nodeVersion: process.versions.node, npmVersion: detectNpmVersion(), platform: process.platform, budgets: { taskTimeoutMs: 600_000, totalTimeoutMs: 1_800_000, maxTasks: 3 } });
    await saveTodoLiveAcceptanceReport(resolve(outputPath), report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = acceptanceExitCode(report.status);
    return;
  }
  approval = parseTodoLiveAcceptanceApproval(JSON.parse(await readFile(approvalPath, 'utf8')));
  const report = await runTodoLiveAcceptance({ repository, reportDirectory: resolve(approval.reportDirectory ?? dirname(outputPath)), commit: code.headCommit, tree: code.headTree, nodeVersion: process.versions.node, npmVersion: detectNpmVersion(), platform: process.platform, budgets: { taskTimeoutMs: 600_000, totalTimeoutMs: 1_800_000, maxTasks: approval.authorization.maxTasks }, approval });
  await saveTodoLiveAcceptanceReport(resolve(outputPath), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = acceptanceExitCode(report.status);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, reason: error instanceof TodoLiveAcceptanceError ? error.reason : 'entry_failed' })}\n`); process.exitCode = 1; });
}
