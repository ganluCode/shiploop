/**
 * P08-2 / F-004 Todo 正常 live 交付编排。
 *
 * 这里是正常交付的门禁核心：规划/批准/启动仍经正式 ShipLoop CLI，Task 的
 * Runtime、局部检查和本地提交通过窄端口注入。生产装配只能提供真实 Pi 结果；
 * 测试可以注入确定性端口，但不能把 fake 结果当作 live 通过。
 *
 * 本模块不直接打开 SQLite、不修改 Nezha 元数据，也不自行切换 Git 分支。
 * 每个 Task 的结果都在后继解锁前保存；Runtime 完成、检查通过或提交成功任一
 * 单项都不能代替另外两项。真实 Host/SQLite/进程/恢复组合场景由 Phase 集成验收。
 */
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawnSync, type ExecFileOptions } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTodoTaskPlan } from './p08-todo-requirements.ts';
import {
  aggregateTodoLiveNotRunEvidence,
  todoLiveRequirementsIdentity,
  type TodoLiveEvidenceReport,
} from './p08-todo-live-report.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface TodoLiveTask {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly prompt?: string;
  readonly acceptance?: readonly string[];
}

export interface TodoLiveAuthorization {
  readonly realPi: true;
  readonly provider: string;
  readonly model: string;
  readonly expiresAt: number;
  readonly maxTasks: number;
  readonly liveLimits?: {
    readonly maxRequestsPerTask: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly allowedFiles: Readonly<Record<string, string>>;
    readonly customModel: { readonly api: string; readonly baseUrl: string };
  };
}

export interface TodoLiveRuntimeResult {
  readonly executionMode: 'live' | 'fake';
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly taskId: string;
  readonly attemptId: string;
  readonly provider: string;
  readonly model: string;
  readonly realCalls: number | null;
  readonly codeDigest?: string;
  readonly outputRef?: string;
  readonly reason?: string;
}

export interface TodoLiveVerificationResult {
  readonly status: 'passed' | 'failed' | 'not_run' | 'inconclusive';
  readonly taskId: string;
  readonly exitCode: number | null;
  readonly command: readonly string[];
  readonly evidenceRef: string | null;
  readonly outputDigest?: string;
  readonly reason?: string;
}

export interface TodoLiveCommitResult {
  readonly status: 'succeeded' | 'failed';
  readonly taskId: string;
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly message: string;
  readonly reason?: string;
}

export interface TodoLiveTaskResult {
  readonly taskId: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly reason?: string;
  readonly runtime?: TodoLiveRuntimeResult;
  readonly verification?: TodoLiveVerificationResult;
  readonly commit?: TodoLiveCommitResult;
}

export interface TodoLiveDeliveryReport {
  readonly schemaVersion: 1;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly authorization: {
    readonly realPi: true;
    readonly provider: string;
    readonly model: string;
    readonly maxTasks: number;
  };
  readonly taskResults: readonly TodoLiveTaskResult[];
  readonly outOfScope: readonly {
    readonly id: 'real-host' | 'sqlite-concurrency' | 'process-stop' | 'recovery';
    readonly status: 'phase-required';
  }[];
  readonly reportDigest: string;
}

export interface TodoLiveDeliveryPorts {
  /** Must invoke the approved real Pi runtime; no FakeRuntime fallback is allowed. */
  runTask(task: TodoLiveTask, context: TodoLiveTaskContext): Promise<TodoLiveRuntimeResult>;
  /** Runs the fixed, task-local verification selected by the trusted controller. */
  verifyTask(task: TodoLiveTask, context: TodoLiveTaskContext): Promise<TodoLiveVerificationResult>;
  /** Performs the Core-controlled local commit and returns verified Git identities. */
  commitTask(task: TodoLiveTask, context: TodoLiveTaskContext): Promise<TodoLiveCommitResult>;
  /** Persists a bounded, redacted task result before any dependent task is released. */
  saveEvidence(result: TodoLiveTaskResult, context: TodoLiveTaskContext): Promise<void>;
}

export interface TodoLiveTaskContext {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly task: TodoLiveTask;
  readonly authorization: TodoLiveAuthorization;
  readonly completedDependencies: Readonly<Record<string, TodoLiveTaskResult>>;
}

export interface TodoLiveDeliveryInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly tasks: readonly TodoLiveTask[];
  readonly authorization: TodoLiveAuthorization;
  readonly ports: TodoLiveDeliveryPorts;
}

export const P08_TODO_LIVE_OUT_OF_SCOPE = Object.freeze([
  { id: 'real-host', status: 'phase-required' },
  { id: 'sqlite-concurrency', status: 'phase-required' },
  { id: 'process-stop', status: 'phase-required' },
  { id: 'recovery', status: 'phase-required' },
] as const);

export class TodoLiveDeliveryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'TodoLiveDeliveryError';
  }
}

function fail(reason: string): never {
  throw new TodoLiveDeliveryError(reason);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertInput(input: TodoLiveDeliveryInput): void {
  if (!validText(input.projectId) || !SAFE_ID.test(input.projectId)) fail('invalid_project_id');
  if (!validText(input.featureId) || !SAFE_ID.test(input.featureId)) fail('invalid_feature_id');
  if (!validText(input.runId) || !SAFE_ID.test(input.runId)) fail('invalid_run_id');
  if (!input.authorization || input.authorization.realPi !== true) fail('real_pi_authorization_required');
  if (!validText(input.authorization.provider) || !validText(input.authorization.model)) fail('invalid_pi_route');
  if (!Number.isSafeInteger(input.authorization.expiresAt) || input.authorization.expiresAt <= Date.now()) fail('authorization_expired');
  if (!Number.isSafeInteger(input.authorization.maxTasks) || input.authorization.maxTasks < 1) fail('invalid_task_budget');
  if (!Array.isArray(input.tasks) || input.tasks.length < 3 || input.tasks.length > input.authorization.maxTasks) fail('task_budget_or_count_invalid');
  if (!input.ports || typeof input.ports.runTask !== 'function' || typeof input.ports.verifyTask !== 'function'
      || typeof input.ports.commitTask !== 'function' || typeof input.ports.saveEvidence !== 'function') fail('live_ports_required');
  try {
    validateTodoTaskPlan(input.tasks.map(task => ({ id: task.id, dependsOn: task.dependsOn })));
  } catch { fail('invalid_task_plan'); }
  for (const task of input.tasks) {
    if (!SAFE_ID.test(task.id) || !validText(task.title)) fail('invalid_task_identity');
    if (task.prompt !== undefined && typeof task.prompt !== 'string') fail('invalid_task_prompt');
    if (task.acceptance !== undefined && (!Array.isArray(task.acceptance) || task.acceptance.some((item: unknown) => !validText(item)))) fail('invalid_task_acceptance');
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeRuntime(value: TodoLiveRuntimeResult, task: TodoLiveTask, authorization: TodoLiveAuthorization): void {
  if (!value || value.taskId !== task.id || value.executionMode !== 'live') fail('runtime_not_live');
  if (value.provider !== authorization.provider || value.model !== authorization.model) fail('runtime_identity_mismatch');
  if (!validText(value.attemptId) || (value.realCalls !== null && (!Number.isSafeInteger(value.realCalls) || value.realCalls < 1))) {
    fail('runtime_evidence_invalid');
  }
}

function safeVerification(value: TodoLiveVerificationResult, task: TodoLiveTask): void {
  if (!value || value.taskId !== task.id || !Array.isArray(value.command) || value.command.length === 0
      || value.command.some(item => !validText(item))) fail('verification_evidence_invalid');
  if (value.status !== 'passed' || value.exitCode !== 0 || !validText(value.evidenceRef)) fail('verification_failed');
  if (value.outputDigest !== undefined && !SHA256.test(value.outputDigest)) fail('verification_evidence_invalid');
}

function safeCommit(value: TodoLiveCommitResult, task: TodoLiveTask): void {
  if (!value || value.taskId !== task.id || value.status !== 'succeeded'
      || value.commitSha === null || value.treeSha === null || !GIT_SHA.test(value.commitSha)
      || !GIT_SHA.test(value.treeSha)) fail('commit_evidence_missing');
  if (value.message !== `${task.id}: ${task.title}`) fail('commit_message_invalid');
}

function resultDigest(results: readonly TodoLiveTaskResult[]): string {
  return digest(results.map(result => ({
    taskId: result.taskId, status: result.status, reason: result.reason ?? null,
    runtime: result.runtime === undefined ? null : {
      taskId: result.runtime.taskId, attemptId: result.runtime.attemptId,
      executionMode: result.runtime.executionMode, status: result.runtime.status,
      provider: result.runtime.provider, model: result.runtime.model, realCalls: result.runtime.realCalls,
      codeDigest: result.runtime.codeDigest ?? null, outputRef: result.runtime.outputRef ?? null,
      reason: result.runtime.reason ?? null,
    },
    verification: result.verification === undefined ? null : {
      taskId: result.verification.taskId, status: result.verification.status,
      exitCode: result.verification.exitCode, command: result.verification.command,
      evidenceRef: result.verification.evidenceRef, outputDigest: result.verification.outputDigest ?? null,
      reason: result.verification.reason ?? null,
    },
    commit: result.commit === undefined ? null : result.commit,
  })));
}

async function persist(
  result: TodoLiveTaskResult, context: TodoLiveTaskContext, ports: TodoLiveDeliveryPorts,
): Promise<TodoLiveTaskResult> {
  try {
    await ports.saveEvidence(result, context);
    return result;
  } catch {
    return { ...result, status: 'failed', reason: 'evidence_persist_failed' };
  }
}

/**
 * Execute a fixed Task DAG. Tasks are visited in declared order, but a Task is
 * admitted only after every dependency has a passed result. A failed or skipped
 * dependency permanently blocks that dependent in this run.
 */
export async function runTodoLiveDelivery(input: TodoLiveDeliveryInput): Promise<TodoLiveDeliveryReport> {
  assertInput(input);
  const results = new Map<string, TodoLiveTaskResult>();
  const remaining = new Set(input.tasks.map(task => task.id));
  const ordered: TodoLiveTaskResult[] = [];

  while (remaining.size > 0) {
    let progressed = false;
    for (const task of input.tasks) {
      if (!remaining.has(task.id)) continue;
      const dependencies = task.dependsOn.map(id => results.get(id));
      if (dependencies.some(value => value === undefined)) continue;
      progressed = true;
      remaining.delete(task.id);
      const completedDependencies = Object.fromEntries(task.dependsOn.map(id => [id, results.get(id)!]));
      const context: TodoLiveTaskContext = {
        projectId: input.projectId, featureId: input.featureId, runId: input.runId, task,
        authorization: input.authorization, completedDependencies,
      };
      if (dependencies.some(value => value!.status !== 'passed')) {
        const skipped = await persist({ taskId: task.id, status: 'skipped', reason: 'dependency_not_passed' }, context, input.ports);
        results.set(task.id, skipped); ordered.push(skipped); continue;
      }
      let runtime: TodoLiveRuntimeResult;
      try { runtime = await input.ports.runTask(task, context); }
      catch { runtime = {
        executionMode: 'live', status: 'unknown', taskId: task.id, attemptId: 'unknown',
        provider: input.authorization.provider, model: input.authorization.model, realCalls: null, reason: 'runtime_error',
      }; }
      let record: TodoLiveTaskResult = { taskId: task.id, status: 'failed', runtime };
      try {
        safeRuntime(runtime, task, input.authorization);
        if (runtime.status !== 'completed') fail('runtime_not_completed');
        const verification = await input.ports.verifyTask(task, context);
        record = { ...record, verification };
        safeVerification(verification, task);
        const commit = await input.ports.commitTask(task, context);
        record = { ...record, commit };
        safeCommit(commit, task);
        record = { ...record, status: 'passed' };
      } catch (error) {
        const reason = error instanceof TodoLiveDeliveryError ? error.reason
          : error instanceof Error && error.message === 'runtime_not_completed' ? 'runtime_not_completed' : 'delivery_gate_failed';
        if (record.verification?.status === 'failed' || record.verification?.status === 'not_run'
            || record.verification?.status === 'inconclusive') record = { ...record, reason: 'verification_failed' };
        else if (record.commit !== undefined && record.commit.status !== 'succeeded') record = { ...record, reason: 'commit_failed' };
        else record = { ...record, reason };
      }
      const saved = await persist(record, context, input.ports);
      results.set(task.id, saved); ordered.push(saved);
    }
    if (!progressed) {
      for (const task of input.tasks) {
        if (!remaining.delete(task.id)) continue;
        const context: TodoLiveTaskContext = {
          projectId: input.projectId, featureId: input.featureId, runId: input.runId, task,
          authorization: input.authorization, completedDependencies: {},
        };
        const skipped = await persist({ taskId: task.id, status: 'skipped', reason: 'dependency_cycle_or_unresolved' }, context, input.ports);
        results.set(task.id, skipped); ordered.push(skipped);
      }
    }
  }

  const status: TodoLiveDeliveryReport['status'] = ordered.length === input.tasks.length && ordered.every(item => item.status === 'passed') ? 'passed' : 'failed';
  const reportBase = {
    schemaVersion: 1 as const, status, projectId: input.projectId, featureId: input.featureId, runId: input.runId,
    authorization: { realPi: true as const, provider: input.authorization.provider, model: input.authorization.model, maxTasks: input.authorization.maxTasks },
    taskResults: ordered, outOfScope: P08_TODO_LIVE_OUT_OF_SCOPE,
  };
  return { ...reportBase, reportDigest: digest(reportBase) };
}

export interface TodoLiveProcessOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

/** Run a fixed argv without a shell; used by the real live verifier/commit adapter. */
export function runTodoLiveProcess(options: TodoLiveProcessOptions): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  if (!isAbsolute(options.cwd) || !Array.isArray(options.command) || options.command.length === 0
      || options.command.some(item => !validText(item)) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    return Promise.reject(new TodoLiveDeliveryError('process_input_invalid'));
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(options.environment ?? {}) };
  return new Promise((resolveResult, reject) => {
    const execOptions: ExecFileOptions = { cwd: resolve(options.cwd), env, timeout: options.timeoutMs, shell: false, encoding: 'utf8', maxBuffer: 1_048_576 };
    execFile(options.command[0]!, options.command.slice(1), execOptions, (error, stdout, stderr) => {
      if (error && error.killed && error.code === null) {
        resolveResult({ exitCode: null, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      if (error && typeof error.code !== 'number' && error.code !== null) {
        reject(new TodoLiveDeliveryError('process_unrunnable'));
        return;
      }
      resolveResult({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Validate the compact, redacted live report before persisting it. The function
 * intentionally accepts no credential/path fields, so a report cannot become an
 * alternate authorization channel.
 */
export function validateTodoLiveReport(value: unknown): TodoLiveDeliveryReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('report_invalid');
  const report = value as Partial<TodoLiveDeliveryReport>;
  if (report.schemaVersion !== 1 || !['passed', 'failed', 'not_run'].includes(report.status ?? '')
      || !validText(report.projectId) || !validText(report.featureId) || !validText(report.runId)
      || !report.authorization || report.authorization.realPi !== true
      || !validText(report.authorization.provider) || !validText(report.authorization.model)
      || !Array.isArray(report.taskResults) || !Array.isArray(report.outOfScope)
      || !SHA256.test(report.reportDigest ?? '')) fail('report_invalid');
  const { reportDigest, ...reportBody } = report;
  if (digest(reportBody) !== reportDigest) fail('report_identity_mismatch');
  return report as TodoLiveDeliveryReport;
}

export interface TodoLiveApprovalFile {
  readonly schemaVersion: 1;
  readonly authorization: TodoLiveAuthorization & { readonly id: string };
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly reportFile: string;
}

export function validateTodoLiveApproval(value: unknown): TodoLiveApprovalFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('approval_invalid');
  const approval = value as Partial<TodoLiveApprovalFile>;
  if (approval.schemaVersion !== 1 || !validText(approval.authorization?.id)
      || approval.authorization.realPi !== true || !validText(approval.projectId)
      || !validText(approval.featureId) || !validText(approval.runId)
      || typeof approval.reportFile !== 'string' || !isAbsolute(approval.reportFile)) fail('approval_invalid');
  assertInput({ projectId: approval.projectId, featureId: approval.featureId, runId: approval.runId,
    tasks: [{ id: 'F-001', title: 'placeholder', dependsOn: [] }, { id: 'F-002', title: 'placeholder', dependsOn: ['F-001'] }, { id: 'F-003', title: 'placeholder', dependsOn: ['F-002'] }],
    authorization: approval.authorization, ports: { runTask: async () => { throw new Error(); }, verifyTask: async () => { throw new Error(); }, commitTask: async () => { throw new Error(); }, saveEvidence: async () => {} } });
  return approval as TodoLiveApprovalFile;
}

export async function saveTodoLiveReport(path: string, report: TodoLiveDeliveryReport): Promise<void> {
  if (!isAbsolute(path)) fail('report_path_invalid');
  validateTodoLiveReport(report);
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export interface TodoPiLivePortsOptions {
  readonly repository: string;
  readonly reportDirectory: string;
  readonly authorization: TodoLiveAuthorization;
  readonly secret: string;
  readonly verificationCommands: Readonly<Record<string, readonly string[]>>;
  readonly timeoutMs: number;
}

function gitText(repository: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    cwd: repository, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Trusted live adapter for the normal path. It launches the fixed child runner,
 * executes the explicitly selected verifier, and commits only after both facts
 * are present. The secret is passed to the child environment once and never to
 * a prompt, argv, report or evidence file.
 */
export function createPiTodoLivePorts(options: TodoPiLivePortsOptions): TodoLiveDeliveryPorts {
  if (!isAbsolute(options.repository) || !isAbsolute(options.reportDirectory) || !validText(options.secret)
      || options.secret.length > 16_384 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TodoLiveDeliveryError('live_adapter_input_invalid');
  }
  const runner = fileURLToPath(new URL('./p08-todo-live-runner.ts', import.meta.url));
  const limits = options.authorization.liveLimits;
  if (!limits || !Number.isSafeInteger(options.authorization.maxTasks) || options.authorization.maxTasks < 1
      || !Number.isSafeInteger(limits.maxRequestsPerTask) || limits.maxRequestsPerTask < 1
      || !Number.isSafeInteger(limits.maxInputTokens) || limits.maxInputTokens < 1
      || !Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens < 1
      || options.authorization.maxTasks * limits.maxRequestsPerTask > 8
      || options.authorization.maxTasks * limits.maxRequestsPerTask * (limits.maxInputTokens + limits.maxOutputTokens) > 200_000
      || options.timeoutMs > 900_000) throw new TodoLiveDeliveryError('live_budget_required');
  return {
    async runTask(task, context) {
      await mkdir(options.reportDirectory, { recursive: true, mode: 0o700 });
      const attemptId = `${context.runId}-${task.id}`;
      const reportFile = join(options.reportDirectory, `runner-${task.id}.json`);
      const inputFile = join(options.reportDirectory, `runner-${task.id}.input.json`);
      const prompt = task.prompt ?? [
        `Implement the approved Todo task ${task.id}: ${task.title}.`,
        ...(task.acceptance ?? []).map(item => `Acceptance: ${item}`),
        'Work only in the current repository. Add or update the implementation and its tests as required.',
        'Do not change Git history; the trusted controller performs the commit after verification.',
      ].join('\n');
      await writeFile(inputFile, `${JSON.stringify({ schemaVersion: 1, taskId: task.id, attemptId,
        repository: options.repository, provider: options.authorization.provider, model: options.authorization.model,
        prompt, reportFile, timeoutMs: options.timeoutMs, maxRequests: limits.maxRequestsPerTask,
        maxInputTokens: limits.maxInputTokens, maxOutputTokens: limits.maxOutputTokens,
        allowedFile: limits.allowedFiles[task.id], customModel: limits.customModel,
        expiresAt: options.authorization.expiresAt })}\n`, { flag: 'wx', mode: 0o600 });
      let outcome: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string };
      try {
        outcome = await runTodoLiveProcess({ command: [process.execPath, runner, inputFile], cwd: options.repository,
          environment: { SHIPLOOP_P08_LIVE_KEY: options.secret }, timeoutMs: options.timeoutMs });
      } catch {
        return { executionMode: 'live', status: 'unknown', taskId: task.id, attemptId,
          provider: options.authorization.provider, model: options.authorization.model, realCalls: null, reason: 'runner_unrunnable' };
      }
      let evidence: Record<string, unknown> | null = null;
      try { evidence = JSON.parse(await readFile(reportFile, 'utf8')) as Record<string, unknown>; } catch { /* fail closed */ }
      const completed = evidence?.executionMode === 'live' && evidence.taskId === task.id
        && evidence.attemptId === attemptId && evidence.provider === options.authorization.provider
        && evidence.model === options.authorization.model && evidence.terminal === 'completed'
        && evidence.stopped === true && Number.isSafeInteger(evidence.realCalls) && Number(evidence.realCalls) > 0;
      let codeDigest: string | undefined;
      try {
        const tracked = gitText(options.repository, ['diff', '--binary', 'HEAD']);
        const untracked = gitText(options.repository, ['ls-files', '--others', '--exclude-standard']);
        codeDigest = digest({ tracked, untracked });
      } catch { /* verification will fail if the workspace cannot be inspected */ }
      return { executionMode: 'live', status: completed && outcome.exitCode === 0 ? 'completed' : 'failed', taskId: task.id,
        attemptId, provider: options.authorization.provider, model: options.authorization.model,
        realCalls: completed ? Number(evidence!.realCalls) : null, ...(codeDigest === undefined ? {} : { codeDigest }),
        outputRef: `runner-${task.id}.json`, ...(completed ? {} : { reason: 'runner_evidence_invalid' }) };
    },
    async verifyTask(task) {
      const command = options.verificationCommands[task.id];
      if (command === undefined) return { status: 'not_run', taskId: task.id, exitCode: null, command: [], evidenceRef: null, reason: 'verification_command_missing' };
      const outcome = await runTodoLiveProcess({ command, cwd: options.repository, timeoutMs: options.timeoutMs });
      const outputDigest = digest({ stdout: outcome.stdout, stderr: outcome.stderr });
      const evidenceRef = `checks/${task.id}.json`;
      await mkdir(join(options.reportDirectory, 'checks'), { recursive: true, mode: 0o700 });
      await writeFile(join(options.reportDirectory, 'checks', `${task.id}.json`), `${JSON.stringify({ taskId: task.id,
        command, exitCode: outcome.exitCode, outputDigest })}\n`, { flag: 'wx', mode: 0o600 });
      return { status: outcome.exitCode === 0 ? 'passed' : 'failed', taskId: task.id, exitCode: outcome.exitCode,
        command: [...command], evidenceRef, outputDigest, ...(outcome.exitCode === 0 ? {} : { reason: 'verification_exit_nonzero' }) };
    },
    async commitTask(task) {
      const message = `${task.id}: ${task.title}`;
      try {
        const approvedFile = limits.allowedFiles[task.id];
        if (!approvedFile || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(approvedFile)) throw new Error('approved_file_required');
        if (gitText(options.repository, ['status', '--porcelain']) === '') return {
          status: 'failed', taskId: task.id, commitSha: null, treeSha: null, message, reason: 'no_code_change',
        };
        execFileSync('git', ['-C', options.repository, 'add', '--', approvedFile], {
          cwd: options.repository, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
          encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        execFileSync('git', ['-C', options.repository, '-c', 'user.name=ShipLoop Todo live', '-c', 'user.email=todo-live@shiploop.invalid', 'commit', '--only', '-m', message, '--', approvedFile], {
          cwd: options.repository, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
          encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const commitSha = gitText(options.repository, ['rev-parse', 'HEAD']);
        const treeSha = gitText(options.repository, ['rev-parse', 'HEAD^{tree}']);
        if (!GIT_SHA.test(commitSha) || !GIT_SHA.test(treeSha)
            || gitText(options.repository, ['status', '--porcelain', '--', approvedFile]) !== '') throw new Error('commit_postcondition_failed');
        return { status: 'succeeded', taskId: task.id, commitSha, treeSha, message };
      } catch { return { status: 'failed', taskId: task.id, commitSha: null, treeSha: null, message, reason: 'git_commit_failed' }; }
    },
    async saveEvidence(result) {
      await mkdir(options.reportDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(options.reportDirectory, `task-${result.taskId}.json`), `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 });
    },
  };
}

export type TodoLiveNotRunReason = 'explicit_approval_required' | 'live_adapter_configuration_required';

/**
 * 入口未获授权/未装配真实适配器时的结构化 not_run 证据报告：绑定冻结需求身份
 * 与人工待确认项，整体保持 not_run。需求契约无法读取时退回紧凑 not_run 输出，
 * 不伪造结构化报告，也不把缺授权折算为通过。
 */
export function todoLiveNotRunEntryReport(reason: TodoLiveNotRunReason): TodoLiveEvidenceReport | { readonly status: 'not_run'; readonly reason: string } {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    return aggregateTodoLiveNotRunEvidence({
      requirements: todoLiveRequirementsIdentity(repository),
      reason,
      manualPending: [{ id: 'owner-live-approval', item: '负责人显式授权真实 Pi live 流程与预算', owner: 'owner' }],
    });
  } catch {
    return { status: 'not_run', reason };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = fileURLToPath(new URL('./p08-todo-live-entry.ts', import.meta.url));
  const child = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
  process.exitCode = child.status ?? 1;
}
