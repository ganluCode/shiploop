/**
 * P08-2 / F-005 deterministic live negative fixtures.
 *
 * These fixtures model the controller boundary around a live Todo run. They do
 * not call Pi, alter task metadata, or turn a fake runtime result into a
 * successful delivery. Each scenario writes a bounded state and evidence
 * record, while the fixture workspace represents the resources that a real
 * controller would have to retain or release.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateTodoTaskPlan } from './p08-todo-requirements.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NEGATIVE_MODES = [
  'missing-authorization', 'unauthorized', 'auth-failure',
  'dependency-failure', 'budget-exhausted', 'budget-exhaustion',
  'cancelled', 'cancel', 'interrupted', 'interruption-restart',
] as const;

export type TodoLiveNegativeMode = typeof NEGATIVE_MODES[number];
export type TodoLiveNegativeTaskStatus = 'not_run' | 'failed' | 'blocked';
export type TodoLiveNegativeScenarioStatus = 'not_run' | 'failed';

export const P08_TODO_NEGATIVE_FAULT_FIXTURES = Object.freeze([
  { id: 'auth-failure', summary: '缺认证或认证失败时在认领前阻塞' },
  { id: 'budget-exhaustion', summary: '预算耗尽后停止并阻塞后继 Task' },
  { id: 'cancel', summary: '显式取消后保留工作和失败证据' },
  { id: 'interruption-restart', summary: '未确认中断时保留占用并拒绝重启' },
  { id: 'dependency-failure', summary: '依赖 Task 失败后不继续执行后继 Task' },
] as const);

export interface TodoLiveNegativeTask {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
}

export interface TodoLiveNegativeInput {
  readonly scenarioId: string;
  readonly mode: TodoLiveNegativeMode;
  readonly workspaceRoot: string;
  readonly tasks: readonly TodoLiveNegativeTask[];
  readonly maxAttempts?: number;
}

export interface TodoLiveNegativeTaskResult {
  readonly id: string;
  readonly status: TodoLiveNegativeTaskStatus;
  readonly reason: string;
  readonly generated: boolean;
  readonly committed: boolean;
}

export interface TodoLiveNegativeAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly status: 'failed' | 'cancelled' | 'interrupted';
  readonly reason: string;
  readonly codeRetained: boolean;
  readonly stop: { readonly confirmed: boolean };
}

export interface TodoLiveNegativeReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.todo.live-negative';
  readonly scenarioId: string;
  readonly mode: TodoLiveNegativeMode;
  readonly status: TodoLiveNegativeScenarioStatus;
  readonly exitCode: 1 | null;
  readonly reason: string;
  readonly tasks: readonly TodoLiveNegativeTaskResult[];
  readonly attempts: readonly TodoLiveNegativeAttempt[];
  readonly budget: {
    readonly limit: number;
    readonly used: number;
    readonly exhausted: boolean;
  };
  readonly resources: {
    readonly worktrees: readonly string[];
    readonly stateRef: string;
    readonly evidenceRef: string;
  };
  readonly cleanup: {
    readonly worktree: 'none' | 'preserved';
    readonly occupancy: 'none' | 'released' | 'held';
  };
  readonly reportDigest: string;
}

export interface TodoLiveNegativeAudit {
  readonly ok: boolean;
  readonly scenarioId: string;
  readonly status: TodoLiveNegativeScenarioStatus | 'unknown';
  readonly problems: readonly string[];
}

export interface TodoLiveNegativeResumeResult {
  readonly status: 'blocked';
  readonly reason: 'old_process_not_confirmed';
  readonly attemptsCreated: 0;
  readonly worktreesCreated: 0;
}

function fail(message: string): never {
  throw new Error(message);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stateFile(workspaceRoot: string, scenarioId: string): string {
  return join(workspaceRoot, 'state', `${scenarioId}.json`);
}

function evidenceFile(workspaceRoot: string, scenarioId: string): string {
  return join(workspaceRoot, 'evidence', `${scenarioId}.json`);
}

function relativeRef(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).split('\\').join('/');
}

function assertInput(input: TodoLiveNegativeInput): void {
  if (!isAbsolute(input.workspaceRoot)) fail('negative_workspace_root_invalid');
  if (!SAFE_ID.test(input.scenarioId)) fail('negative_scenario_id_invalid');
  if (!NEGATIVE_MODES.includes(input.mode)) fail('negative_mode_invalid');
  if (!Array.isArray(input.tasks) || input.tasks.length < 3) fail('negative_task_plan_invalid');
  try {
    validateTodoTaskPlan(input.tasks.map(task => ({ id: task.id, dependsOn: task.dependsOn })));
  } catch {
    fail('negative_task_plan_invalid');
  }
  for (const task of input.tasks) {
    if (!SAFE_ID.test(task.id) || task.title.trim().length === 0) fail('negative_task_identity_invalid');
  }
  if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    fail('negative_budget_invalid');
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function createPartialWorktree(workspaceRoot: string, taskId: string): Promise<string> {
  const path = join(workspaceRoot, 'worktrees', taskId);
  await ensureDirectory(path);
  await writeFile(join(path, 'partial.txt'), `deterministic partial output for ${taskId}\n`, { flag: 'wx', mode: 0o600 });
  return relativeRef(workspaceRoot, path);
}

function taskResults(tasks: readonly TodoLiveNegativeTask[], first: TodoLiveNegativeTaskResult): TodoLiveNegativeTaskResult[] {
  return tasks.map((task, index) => index === 0 ? first : {
    id: task.id, status: 'blocked', reason: 'dependency_not_passed', generated: false, committed: false,
  });
}

function reportDigestBase(report: Omit<TodoLiveNegativeReport, 'reportDigest'>): string {
  return digest(report);
}

async function persistReport(workspaceRoot: string, report: TodoLiveNegativeReport): Promise<void> {
  await ensureDirectory(join(workspaceRoot, 'state'));
  await ensureDirectory(join(workspaceRoot, 'evidence'));
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(stateFile(workspaceRoot, report.scenarioId), serialized, { flag: 'wx', mode: 0o600 });
  await writeFile(evidenceFile(workspaceRoot, report.scenarioId), serialized, { flag: 'wx', mode: 0o600 });
}

function makeReport(
  input: TodoLiveNegativeInput,
  fields: Omit<TodoLiveNegativeReport, 'schemaVersion' | 'kind' | 'scenarioId' | 'mode' | 'reportDigest'>,
): TodoLiveNegativeReport {
  const base = {
    schemaVersion: 1 as const,
    kind: 'shiploop.todo.live-negative' as const,
    scenarioId: input.scenarioId,
    mode: input.mode,
    ...fields,
  };
  return { ...base, reportDigest: reportDigestBase(base) };
}

/** Execute one deterministic failure mode and persist its complete evidence. */
export async function runTodoLiveNegativeScenario(input: TodoLiveNegativeInput): Promise<TodoLiveNegativeReport> {
  assertInput(input);
  const statePath = stateFile(input.workspaceRoot, input.scenarioId);
  const evidencePath = evidenceFile(input.workspaceRoot, input.scenarioId);
  const references = {
    stateRef: relativeRef(input.workspaceRoot, statePath),
    evidenceRef: relativeRef(input.workspaceRoot, evidencePath),
  };
  if (await fileExists(statePath) || await fileExists(evidencePath)) fail('negative_scenario_already_exists');

  if (input.mode === 'missing-authorization' || input.mode === 'unauthorized' || input.mode === 'auth-failure') {
    const missingAuthorization = input.mode === 'missing-authorization';
    const report = makeReport(input, {
      status: missingAuthorization ? 'not_run' : 'failed',
      exitCode: missingAuthorization ? null : 1,
      reason: missingAuthorization ? 'authorization_missing' : 'authorization_rejected',
      tasks: input.tasks.map(task => ({ id: task.id, status: 'not_run', reason: missingAuthorization ? 'authorization_missing' : 'authorization_rejected', generated: false, committed: false })),
      attempts: [],
      budget: { limit: input.maxAttempts ?? 1, used: 0, exhausted: false },
      resources: { worktrees: [], ...references },
      cleanup: { worktree: 'none', occupancy: 'none' },
    });
    await persistReport(input.workspaceRoot, report);
    return report;
  }

  const firstTask = input.tasks[0]!;
  const worktree = await createPartialWorktree(input.workspaceRoot, firstTask.id);
  const budgetExhausted = input.mode === 'budget-exhausted' || input.mode === 'budget-exhaustion';
  const cancelled = input.mode === 'cancelled' || input.mode === 'cancel';
  const controlledInterruption = input.mode === 'interruption-restart';
  const modeState = input.mode === 'dependency-failure'
    ? { status: 'failed' as const, reason: 'dependency_failed', attemptStatus: 'failed' as const, confirmed: true }
    : budgetExhausted
      ? { status: 'failed' as const, reason: 'budget_exhausted', attemptStatus: 'failed' as const, confirmed: true }
      : cancelled
        ? { status: 'failed' as const, reason: 'cancelled', attemptStatus: 'cancelled' as const, confirmed: true }
        : controlledInterruption
          ? { status: 'failed' as const, reason: 'interrupted', attemptStatus: 'interrupted' as const, confirmed: true }
          : { status: 'failed' as const, reason: 'stop_unconfirmed', attemptStatus: 'interrupted' as const, confirmed: false };
  const attempt: TodoLiveNegativeAttempt = {
    attemptId: `attempt-${input.scenarioId}-${firstTask.id}`,
    taskId: firstTask.id,
    status: modeState.attemptStatus,
    reason: modeState.reason,
    codeRetained: true,
    stop: { confirmed: modeState.confirmed },
  };
  const firstResult: TodoLiveNegativeTaskResult = {
    id: firstTask.id, status: 'failed', reason: modeState.reason, generated: true, committed: false,
  };
  const report = makeReport(input, {
    status: modeState.status,
    exitCode: 1,
    reason: modeState.reason,
    tasks: taskResults(input.tasks, firstResult),
    attempts: [attempt],
    budget: { limit: input.maxAttempts ?? 1, used: 1, exhausted: budgetExhausted },
    resources: { worktrees: [worktree], ...references },
    cleanup: { worktree: 'preserved', occupancy: modeState.confirmed ? 'released' : 'held' },
  });
  await persistReport(input.workspaceRoot, report);
  return report;
}

export function validateTodoLiveNegativeReport(value: unknown): TodoLiveNegativeReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('negative_report_invalid');
  const report = value as Partial<TodoLiveNegativeReport>;
  if (report.schemaVersion !== 1 || report.kind !== 'shiploop.todo.live-negative'
      || !validId(report.scenarioId) || !NEGATIVE_MODES.includes(report.mode as TodoLiveNegativeMode)
      || (report.status !== 'failed' && report.status !== 'not_run') || typeof report.reason !== 'string'
      || !Array.isArray(report.tasks) || !Array.isArray(report.attempts) || !report.budget
      || !report.resources || !report.cleanup || typeof report.reportDigest !== 'string') fail('negative_report_invalid');
  const { reportDigest, ...body } = report;
  if (digest(body) !== reportDigest) fail('negative_report_identity_mismatch');
  return report as TodoLiveNegativeReport;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Re-read persisted state and the fixture workspace; no status is inferred from text alone. */
export async function auditTodoLiveNegative(workspaceRoot: string, scenarioId: string): Promise<TodoLiveNegativeAudit> {
  const problems: string[] = [];
  let report: TodoLiveNegativeReport | null = null;
  try {
    report = validateTodoLiveNegativeReport(JSON.parse(await readFile(stateFile(workspaceRoot, scenarioId), 'utf8')));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'negative_state_invalid');
  }
  let evidence: TodoLiveNegativeReport | null = null;
  try {
    evidence = validateTodoLiveNegativeReport(JSON.parse(await readFile(evidenceFile(workspaceRoot, scenarioId), 'utf8')));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'negative_evidence_invalid');
  }
  if (report === null || evidence === null) return { ok: false, scenarioId, status: report?.status ?? 'unknown', problems };
  if (JSON.stringify(report) !== JSON.stringify(evidence)) problems.push('state_evidence_mismatch');
  if (report.scenarioId !== scenarioId) problems.push('scenario_identity_mismatch');
  if (report.status === 'not_run' && (report.attempts.length !== 0 || report.resources.worktrees.length !== 0)) problems.push('not_run_has_execution_side_effect');
  if (report.tasks.some(task => task.status === 'blocked' && (task.generated || task.committed))) problems.push('blocked_task_has_side_effect');
  if (report.budget.used > report.budget.limit) problems.push('budget_over_limit');
  for (const worktree of report.resources.worktrees) {
    if (!worktree.startsWith('worktrees/') || isAbsolute(worktree) || worktree.includes('..')) problems.push('worktree_reference_invalid');
    if (!(await fileExists(join(workspaceRoot, worktree, 'partial.txt')))) problems.push('retained_worktree_missing');
  }
  if (report.cleanup.occupancy === 'held' && report.attempts.every(attempt => attempt.stop.confirmed)) problems.push('held_occupancy_without_unconfirmed_stop');
  if (report.cleanup.occupancy === 'held' && report.status === 'not_run') problems.push('not_run_holds_occupancy');
  return { ok: problems.length === 0, scenarioId, status: report.status, problems };
}

/** The only allowed recovery result for an unconfirmed old process. */
export async function resumeTodoLiveNegative(workspaceRoot: string, scenarioId: string): Promise<TodoLiveNegativeResumeResult> {
  const report = validateTodoLiveNegativeReport(JSON.parse(await readFile(stateFile(workspaceRoot, scenarioId), 'utf8')));
  if (report.cleanup.occupancy !== 'held' || report.attempts.every(attempt => attempt.stop.confirmed)) {
    fail('negative_resume_requires_unconfirmed_process');
  }
  return { status: 'blocked', reason: 'old_process_not_confirmed', attemptsCreated: 0, worktreesCreated: 0 };
}
