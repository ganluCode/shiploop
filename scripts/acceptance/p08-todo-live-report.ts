/**
 * P08-2 / F-006 Todo live 结构化报告与证据聚合。
 *
 * 把一次 Todo live 演示的输入摘要（需求版本/摘要）、运行身份
 * （Project/Feature/Run、Task/Attempt）、最终代码 commit/tree、实际检查
 * 结果、人工待确认项与已知缺口聚合成一份可独立复验的报告。报告分别记录
 * passed/failed/not_run/inconclusive；缺少真实流程或负责人确认的项目保持
 * 原状态，绝不折算为通过。
 *
 * 边界：本模块只做纯数据聚合与校验，不打开 SQLite、不调用模型、不执行 Git
 * 命令。报告完整性不代替真实 Git/SQLite/Host/进程集成证据；跨层一致性由
 * Phase 集成验收负责。报告中的制品一律使用受控相对引用加 sha256 完整性
 * 摘要，不内嵌大输出，不携带凭据、完整认证内容或开发机绝对路径。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { validateTodoLiveReport, type TodoLiveDeliveryReport } from './p08-todo-live.ts';
import {
  P08_TODO_REQUIREMENTS_PATH,
  P08_TODO_REQUIREMENTS_VERSION,
  loadTodoDemoRequirements,
} from './p08-todo-requirements.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CREDENTIAL_KEY = /secret|token|password|passphrase|api[-_]?key|credential|private[-_]?key|auth[-_]?header/i;
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;
const MACHINE_PATH = /\/(Users|home)\//;

export type TodoLiveEvidenceStatus = 'passed' | 'failed' | 'not_run' | 'inconclusive';
export type TodoLiveDeliveryStatus = 'passed' | 'failed' | 'not_run';

export class TodoLiveReportError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'TodoLiveReportError';
  }
}

function fail(reason: string): never {
  throw new TodoLiveReportError(reason);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function todoLiveEvidenceDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** 受控制品引用：报告根内的相对 POSIX 路径 + sha256 内容摘要 + 字节数。 */
export interface TodoLiveArtifactRef {
  readonly ref: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface TodoLiveCheckEntry {
  readonly id: string;
  readonly status: TodoLiveEvidenceStatus;
  readonly exitCode: number | null;
  readonly command: readonly string[];
  readonly evidence: TodoLiveArtifactRef | null;
  readonly reason?: string;
}

export interface TodoLiveTaskEvidence {
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly verificationExitCode: number | null;
  readonly verificationRef: string | null;
}

export interface TodoLiveManualItem {
  readonly id: string;
  readonly item: string;
  readonly owner: string;
}

export interface TodoLiveKnownGap {
  readonly id: string;
  readonly status: 'not_run' | 'phase-required';
  readonly reason: string;
}

const PHASE_GAPS: readonly TodoLiveKnownGap[] = [
  { id: 'real-host', status: 'phase-required', reason: 'phase-integration-required' },
  { id: 'sqlite-concurrency', status: 'phase-required', reason: 'phase-integration-required' },
  { id: 'process-stop', status: 'phase-required', reason: 'phase-integration-required' },
  { id: 'recovery', status: 'phase-required', reason: 'phase-integration-required' },
];

export interface TodoLiveEvidenceReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.todo.live-evidence';
  readonly status: TodoLiveEvidenceStatus;
  readonly statusReason: string | null;
  readonly identity: {
    readonly projectId: string | null;
    readonly featureId: string | null;
    readonly runId: string | null;
    readonly requirementsVersion: number;
    readonly requirementsDigest: string;
  };
  readonly code: {
    readonly headCommit: string | null;
    readonly headTree: string | null;
  };
  readonly delivery: {
    readonly status: TodoLiveDeliveryStatus;
    readonly reportDigest: string;
  };
  readonly tasks: readonly TodoLiveTaskEvidence[];
  readonly checks: readonly TodoLiveCheckEntry[];
  readonly manualPending: readonly TodoLiveManualItem[];
  readonly knownGaps: readonly TodoLiveKnownGap[];
  readonly artifacts: readonly TodoLiveArtifactRef[];
  readonly reportDigest: string;
}

export interface TodoLiveCheckOutcome {
  readonly id: string;
  readonly exitCode: number | null;
  readonly command: readonly string[];
  readonly evidence?: { readonly ref: string; readonly content: string };
  readonly reason?: string;
}

function assertArtifactRef(ref: unknown): string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512
      || ABSOLUTE_PATH.test(ref) || ref.includes('\\') || ref.split('/').some(part => !REF_SEGMENT.test(part))) {
    fail('artifact_ref_invalid');
  }
  return ref;
}

export function todoLiveArtifactFromContent(ref: string, content: string): TodoLiveArtifactRef {
  assertArtifactRef(ref);
  if (typeof content !== 'string' || content.length === 0) fail('artifact_content_invalid');
  return { ref, digest: createHash('sha256').update(content, 'utf8').digest('hex'), bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * 把一次检查的原始退出结果规范成结构化条目。退出码为 0 但缺少受控制品时
 * 记为 inconclusive（不能靠空输出掩盖未执行的检查）；非 0 记为 failed；
 * 退出码不可得（超时/未运行完成）记为 inconclusive。
 */
export function normalizeTodoLiveCheckOutcome(outcome: TodoLiveCheckOutcome): TodoLiveCheckEntry {
  if (!outcome || !SAFE_ID.test(outcome.id)) fail('check_id_invalid');
  if (!Array.isArray(outcome.command) || outcome.command.length === 0
      || outcome.command.some(item => !validText(item))) fail('check_command_invalid');
  if (outcome.exitCode !== null && (!Number.isSafeInteger(outcome.exitCode))) fail('check_exit_code_invalid');
  const evidence = outcome.evidence === undefined ? null : todoLiveArtifactFromContent(outcome.evidence.ref, outcome.evidence.content);
  if (outcome.exitCode === null) return { id: outcome.id, status: 'inconclusive', exitCode: null,
    command: [...outcome.command], evidence, reason: outcome.reason ?? 'exit_code_unavailable' };
  if (outcome.exitCode !== 0) return { id: outcome.id, status: 'failed', exitCode: outcome.exitCode,
    command: [...outcome.command], evidence, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) };
  if (evidence === null) return { id: outcome.id, status: 'inconclusive', exitCode: 0,
    command: [...outcome.command], evidence: null, reason: 'evidence_missing' };
  return { id: outcome.id, status: 'passed', exitCode: 0, command: [...outcome.command], evidence };
}

function taskEvidenceFrom(result: TodoLiveDeliveryReport['taskResults'][number]): TodoLiveTaskEvidence {
  return {
    taskId: result.taskId,
    attemptId: result.runtime?.attemptId ?? null,
    status: result.status === 'skipped' ? 'skipped' : result.status === 'passed' ? 'passed' : 'failed',
    commitSha: result.commit?.commitSha ?? null,
    treeSha: result.commit?.treeSha ?? null,
    verificationExitCode: result.verification?.exitCode ?? null,
    verificationRef: result.verification?.evidenceRef ?? null,
  };
}

interface DerivedStatus {
  readonly status: TodoLiveEvidenceStatus;
  readonly statusReason: string | null;
}

/**
 * 从报告内容推导整体状态。优先级：检查失败/交付失败 > 检查不确定/证据缺失
 * > 未运行（真实流程或检查）> 人工待确认 > 全部通过。已通过声明缺少代码、
 * 测试、Git 或状态证据时降级为 inconclusive；not_run 与人工待确认永不折算
 * 为通过。
 */
function deriveStatus(report: Omit<TodoLiveEvidenceReport, 'schemaVersion' | 'kind' | 'status' | 'statusReason' | 'reportDigest'>): DerivedStatus {
  const checks = report.checks;
  const tasks = report.tasks;
  if (checks.some(check => check.status === 'failed')) return { status: 'failed', statusReason: 'check_failed' };
  if (report.delivery.status === 'failed') return { status: 'failed', statusReason: 'delivery_failed' };
  if (checks.some(check => check.status === 'inconclusive')) return { status: 'inconclusive', statusReason: 'check_inconclusive' };
  if (report.delivery.status === 'passed') {
    if (report.code.headCommit === null || report.code.headTree === null) {
      return { status: 'inconclusive', statusReason: 'code_evidence_missing' };
    }
    if (tasks.some(task => task.status !== 'passed')) {
      return { status: 'inconclusive', statusReason: 'task_status_inconsistent' };
    }
    if (tasks.some(task => task.commitSha === null || task.treeSha === null
        || task.verificationExitCode !== 0 || task.verificationRef === null)) {
      return { status: 'inconclusive', statusReason: 'task_evidence_missing' };
    }
    if (checks.some(check => check.status === 'passed' && check.evidence === null)) {
      return { status: 'inconclusive', statusReason: 'check_evidence_missing' };
    }
  }
  if (report.delivery.status === 'not_run') return { status: 'not_run', statusReason: 'delivery_not_run' };
  if (checks.some(check => check.status === 'not_run')) return { status: 'not_run', statusReason: 'check_not_run' };
  if (report.manualPending.length > 0) return { status: 'inconclusive', statusReason: 'manual_pending' };
  return { status: 'passed', statusReason: null };
}

function validateManualItems(items: unknown): TodoLiveManualItem[] {
  if (!Array.isArray(items)) fail('manual_pending_invalid');
  return items.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail('manual_pending_invalid');
    const value = item as Partial<TodoLiveManualItem>;
    if (!SAFE_ID.test(value.id ?? '') || !validText(value.item) || !validText(value.owner)) fail('manual_pending_invalid');
    return { id: value.id!, item: value.item!, owner: value.owner! };
  });
}

function validateKnownGaps(gaps: unknown): TodoLiveKnownGap[] {
  if (!Array.isArray(gaps)) fail('known_gaps_invalid');
  return gaps.map(gap => {
    if (gap === null || typeof gap !== 'object' || Array.isArray(gap)) fail('known_gaps_invalid');
    const value = gap as Partial<TodoLiveKnownGap>;
    if (!SAFE_ID.test(value.id ?? '') || (value.status !== 'not_run' && value.status !== 'phase-required')
        || !validText(value.reason)) fail('known_gaps_invalid');
    return { id: value.id!, status: value.status!, reason: value.reason! };
  });
}

export interface TodoLiveEvidenceInput {
  /** F-004 交付报告原文；先经 validateTodoLiveReport 校验再聚合。 */
  readonly delivery: unknown;
  readonly requirements: { readonly version: number; readonly digest: string };
  readonly code: { readonly headCommit: string | null; readonly headTree: string | null };
  readonly checks: readonly TodoLiveCheckOutcome[];
  readonly manualPending?: readonly TodoLiveManualItem[];
  readonly knownGaps?: readonly TodoLiveKnownGap[];
  readonly artifacts?: readonly { readonly ref: string; readonly content: string }[];
}

function assertRequirements(requirements: TodoLiveEvidenceInput['requirements']): void {
  if (!requirements || !Number.isSafeInteger(requirements.version) || requirements.version < 1
      || !SHA256.test(requirements.digest ?? '')) fail('requirements_identity_invalid');
}

function assertCode(code: TodoLiveEvidenceInput['code']): void {
  if (!code) fail('code_identity_invalid');
  const { headCommit, headTree } = code;
  for (const sha of [headCommit, headTree]) {
    if (sha !== null && !GIT_SHA.test(sha)) fail('code_identity_invalid');
  }
  if ((headCommit === null) !== (headTree === null)) fail('code_identity_invalid');
}

function buildReport(
  fields: Omit<TodoLiveEvidenceReport, 'schemaVersion' | 'kind' | 'reportDigest' | 'status' | 'statusReason'>,
  statusReasonOverride?: string,
): TodoLiveEvidenceReport {
  const base = { schemaVersion: 1 as const, kind: 'shiploop.todo.live-evidence' as const, ...fields };
  const derived = deriveStatus(fields);
  const statusReason = derived.statusReason === null ? null : statusReasonOverride ?? derived.statusReason;
  const body = { ...base, status: derived.status, statusReason };
  return { ...body, reportDigest: todoLiveEvidenceDigest(body) };
}

/**
 * 聚合一次已执行的 Todo live 交付。交付报告必须先通过 F-004 的完整性校验，
 * 身份与 Task 结果从该报告绑定，不接受调用方另行声明。整体状态由内容推导：
 * 成功退出但缺少代码、测试、Git 或状态证据时结果为 inconclusive/failed，
 * 不产生 passed。
 */
export function aggregateTodoLiveEvidence(input: TodoLiveEvidenceInput): TodoLiveEvidenceReport {
  if (!input) fail('aggregate_input_invalid');
  const delivery = validateTodoLiveReport(input.delivery);
  assertRequirements(input.requirements);
  assertCode(input.code);
  if (!Array.isArray(input.checks)) fail('checks_invalid');

  const artifacts: TodoLiveArtifactRef[] = [];
  const registered = new Set<string>();
  const register = (artifact: TodoLiveArtifactRef): void => {
    if (registered.has(artifact.ref)) fail('artifact_ref_duplicated');
    registered.add(artifact.ref);
    artifacts.push(artifact);
  };
  const checks = input.checks.map(outcome => {
    const entry = normalizeTodoLiveCheckOutcome(outcome);
    if (entry.evidence !== null) register(entry.evidence);
    return entry;
  });
  for (const extra of input.artifacts ?? []) {
    if (!extra || typeof extra !== 'object') fail('artifact_input_invalid');
    register(todoLiveArtifactFromContent(extra.ref, extra.content));
  }

  return buildReport({
    identity: {
      projectId: delivery.projectId, featureId: delivery.featureId, runId: delivery.runId,
      requirementsVersion: input.requirements.version, requirementsDigest: input.requirements.digest,
    },
    code: { headCommit: input.code.headCommit, headTree: input.code.headTree },
    delivery: { status: delivery.status, reportDigest: delivery.reportDigest },
    tasks: delivery.taskResults.map(taskEvidenceFrom),
    checks,
    manualPending: validateManualItems(input.manualPending ?? []),
    knownGaps: input.knownGaps === undefined ? PHASE_GAPS : validateKnownGaps(input.knownGaps),
    artifacts,
  });
}

/**
 * 聚合未获授权/未运行的路径：没有真实流程、代码或 Task 结果，全部保持
 * not_run；人工待确认项照常记录，不因整体未运行而消失。
 */
export function aggregateTodoLiveNotRunEvidence(input: {
  readonly requirements: TodoLiveEvidenceInput['requirements'];
  readonly reason: string;
  readonly manualPending?: readonly TodoLiveManualItem[];
  readonly knownGaps?: readonly TodoLiveKnownGap[];
}): TodoLiveEvidenceReport {
  if (!input || !validText(input.reason)) fail('not_run_reason_invalid');
  assertRequirements(input.requirements);
  return buildReport({
    identity: {
      projectId: null, featureId: null, runId: null,
      requirementsVersion: input.requirements.version, requirementsDigest: input.requirements.digest,
    },
    code: { headCommit: null, headTree: null },
    delivery: { status: 'not_run', reportDigest: todoLiveEvidenceDigest({ status: 'not_run', reason: input.reason }) },
    tasks: [],
    checks: [{ id: 'todo-live-delivery', status: 'not_run', exitCode: null, command: [], evidence: null, reason: input.reason }],
    manualPending: validateManualItems(input.manualPending ?? []),
    knownGaps: input.knownGaps === undefined ? PHASE_GAPS : validateKnownGaps(input.knownGaps),
    artifacts: [],
  }, input.reason);
}

function validateIdentity(value: unknown): TodoLiveEvidenceReport['identity'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('report_invalid');
  const identity = value as Partial<TodoLiveEvidenceReport['identity']>;
  const ids = [identity.projectId, identity.featureId, identity.runId];
  if (ids.some(id => id !== null && id !== undefined && !SAFE_ID.test(id))) fail('identity_invalid');
  if (ids.some(id => id === null || id === undefined) && ids.some(id => id !== null && id !== undefined)) fail('identity_invalid');
  if (!Number.isSafeInteger(identity.requirementsVersion) || (identity.requirementsVersion ?? 0) < 1
      || !SHA256.test(identity.requirementsDigest ?? '')) fail('identity_invalid');
  return identity as TodoLiveEvidenceReport['identity'];
}

function validateCheckEntries(checks: unknown): TodoLiveCheckEntry[] {
  if (!Array.isArray(checks)) fail('report_invalid');
  return checks.map(check => {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) fail('check_invalid');
    const value = check as Partial<TodoLiveCheckEntry>;
    if (!SAFE_ID.test(value.id ?? '')) fail('check_invalid');
    if (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'not_run'
        && value.status !== 'inconclusive') fail('check_invalid');
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) fail('check_invalid');
    if (!Array.isArray(value.command) || value.command.some(item => !validText(item))) fail('check_invalid');
    if (value.status !== 'not_run' && value.command.length === 0) fail('check_invalid');
    if (value.status === 'not_run' && (value.exitCode !== null || value.command.length > 0)) fail('check_invalid');
    if (value.reason !== undefined && !validText(value.reason)) fail('check_invalid');
    let evidence: TodoLiveArtifactRef | null = null;
    if (value.evidence !== null && value.evidence !== undefined) {
      if (typeof value.evidence !== 'object') fail('check_invalid');
      const artifact = value.evidence as Partial<TodoLiveArtifactRef>;
      assertArtifactRef(artifact.ref);
      if (!SHA256.test(artifact.digest ?? '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes! < 1) fail('check_invalid');
      evidence = { ref: artifact.ref!, digest: artifact.digest!, bytes: artifact.bytes! };
    }
    if (value.status === 'passed' && evidence === null) fail('check_invalid');
    return { id: value.id!, status: value.status!, exitCode: value.exitCode ?? null,
      command: [...value.command!], evidence, ...(value.reason === undefined ? {} : { reason: value.reason }) };
  });
}

function validateTaskEntries(tasks: unknown): TodoLiveTaskEvidence[] {
  if (!Array.isArray(tasks)) fail('report_invalid');
  return tasks.map(task => {
    if (task === null || typeof task !== 'object' || Array.isArray(task)) fail('task_evidence_invalid');
    const value = task as Partial<TodoLiveTaskEvidence>;
    if (!SAFE_ID.test(value.taskId ?? '') || (value.attemptId !== null && value.attemptId !== undefined && !SAFE_ID.test(value.attemptId))) fail('task_evidence_invalid');
    if (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'skipped') fail('task_evidence_invalid');
    if (value.commitSha !== null && value.commitSha !== undefined && !GIT_SHA.test(value.commitSha)) fail('task_evidence_invalid');
    if (value.treeSha !== null && value.treeSha !== undefined && !GIT_SHA.test(value.treeSha)) fail('task_evidence_invalid');
    if (value.verificationExitCode !== null && value.verificationExitCode !== undefined
        && !Number.isSafeInteger(value.verificationExitCode)) fail('task_evidence_invalid');
    if (value.verificationRef !== null && value.verificationRef !== undefined) assertArtifactRef(value.verificationRef);
    return {
      taskId: value.taskId!, attemptId: value.attemptId ?? null, status: value.status!,
      commitSha: value.commitSha ?? null, treeSha: value.treeSha ?? null,
      verificationExitCode: value.verificationExitCode ?? null, verificationRef: value.verificationRef ?? null,
    };
  });
}

function scanSensitive(reportBody: unknown, forbiddenValues: readonly string[]): void {
  const serialized = canonical(reportBody);
  for (const secret of forbiddenValues) {
    if (validText(secret) && serialized.includes(secret)) fail('credential_leak');
  }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (CREDENTIAL_KEY.test(key)) fail('credential_leak');
        walk(child);
      }
      return;
    }
    if (typeof value === 'string' && (ABSOLUTE_PATH.test(value) || MACHINE_PATH.test(value))) {
      fail('absolute_path_forbidden');
    }
  };
  walk(reportBody);
}

export interface TodoLiveEvidenceReportOptions {
  /** 可选的源交付报告，用于交叉核对身份与 Task 集合。 */
  readonly delivery?: unknown;
  /** 需要确保不出现在报告中的真实敏感值（如本次 live 密钥）。 */
  readonly forbiddenValues?: readonly string[];
  /** 提供时逐个复验制品内容摘要与字节数。 */
  readonly artifactRoot?: string;
}

/**
 * 校验一份 Todo live 证据报告：结构、身份绑定、状态传播、制品登记与敏感
 * 信息边界。整体状态必须等于按内容重新推导的结果，通过声明不能掩盖缺证
 * 据、未运行或人工待确认事实。
 */
export function validateTodoLiveEvidenceReport(value: unknown, options: TodoLiveEvidenceReportOptions = {}): TodoLiveEvidenceReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('report_invalid');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.kind !== 'shiploop.todo.live-evidence'
      || !SHA256.test(typeof raw.reportDigest === 'string' ? raw.reportDigest : '')) fail('report_invalid');
  const { reportDigest: declaredDigest, ...body } = raw;
  if (todoLiveEvidenceDigest(body) !== declaredDigest) fail('report_digest_mismatch');
  if (raw.status !== 'passed' && raw.status !== 'failed' && raw.status !== 'not_run' && raw.status !== 'inconclusive') {
    fail('report_invalid');
  }
  if (typeof raw.statusReason !== 'string' && raw.statusReason !== null) fail('report_invalid');
  if ((raw.status === 'passed') !== (raw.statusReason === null)) fail('report_invalid');

  // 敏感信息边界优先于其他语义校验：含凭据或开发机绝对路径的报告直接拒绝。
  scanSensitive(body, options.forbiddenValues ?? []);

  const identity = validateIdentity(raw.identity);
  const code = raw.code as Partial<TodoLiveEvidenceReport['code']> | undefined;
  if (!code || (code.headCommit !== null && code.headCommit !== undefined && !GIT_SHA.test(code.headCommit))
      || (code.headTree !== null && code.headTree !== undefined && !GIT_SHA.test(code.headTree))
      || ((code.headCommit ?? null) === null) !== ((code.headTree ?? null) === null)) fail('code_identity_invalid');
  const delivery = raw.delivery as Partial<TodoLiveEvidenceReport['delivery']> | undefined;
  if (!delivery || (delivery.status !== 'passed' && delivery.status !== 'failed' && delivery.status !== 'not_run')
      || !SHA256.test(delivery.reportDigest ?? '')) fail('delivery_binding_invalid');

  const tasks = validateTaskEntries(raw.tasks);
  const checks = validateCheckEntries(raw.checks);
  const manualPending = validateManualItems(raw.manualPending);
  validateKnownGaps(raw.knownGaps);

  if (!Array.isArray(raw.artifacts)) fail('report_invalid');
  const artifactRefs = new Set<string>();
  for (const artifact of raw.artifacts) {
    if (artifact === null || typeof artifact !== 'object') fail('artifact_invalid');
    const entry = artifact as Partial<TodoLiveArtifactRef>;
    const ref = assertArtifactRef(entry.ref);
    if (!SHA256.test(entry.digest ?? '') || !Number.isSafeInteger(entry.bytes) || entry.bytes! < 1) fail('artifact_invalid');
    if (artifactRefs.has(ref)) fail('artifact_ref_duplicated');
    artifactRefs.add(ref);
  }
  for (const check of checks) {
    if (check.evidence !== null && !artifactRefs.has(check.evidence.ref)) fail('artifact_ref_unregistered');
  }

  const fields: Omit<TodoLiveEvidenceReport, 'schemaVersion' | 'kind' | 'status' | 'statusReason' | 'reportDigest'> = {
    identity, code: { headCommit: code.headCommit ?? null, headTree: code.headTree ?? null },
    delivery: { status: delivery.status!, reportDigest: delivery.reportDigest! },
    tasks, checks, manualPending, knownGaps: validateKnownGaps(raw.knownGaps),
    artifacts: raw.artifacts as TodoLiveArtifactRef[],
  };
  const derived = deriveStatus(fields);
  if (derived.status !== raw.status) fail('status_propagation_invalid');

  if (options.delivery !== undefined) {
    const source = validateTodoLiveReport(options.delivery);
    if (identity.projectId !== source.projectId || identity.featureId !== source.featureId
        || identity.runId !== source.runId || fields.delivery.reportDigest !== source.reportDigest
        || fields.delivery.status !== source.status
        || tasks.map(task => task.taskId).join(',') !== source.taskResults.map(task => task.taskId).join(',')) {
      fail('identity_mismatch');
    }
  }

  if (options.artifactRoot !== undefined) {
    if (!isAbsolute(options.artifactRoot)) fail('artifact_root_invalid');
    for (const artifact of fields.artifacts) {
      let content: string;
      try { content = readFileSync(join(options.artifactRoot, artifact.ref), 'utf8'); } catch { fail('artifact_integrity_invalid'); }
      const digest = createHash('sha256').update(content, 'utf8').digest('hex');
      if (digest !== artifact.digest || Buffer.byteLength(content, 'utf8') !== artifact.bytes) fail('artifact_integrity_invalid');
    }
  }

  return { schemaVersion: 1 as const, kind: 'shiploop.todo.live-evidence' as const, ...fields,
    status: raw.status as TodoLiveEvidenceStatus,
    statusReason: (raw.statusReason as string | null), reportDigest: declaredDigest as string };
}

/** 保存前先完整校验；路径必须绝对，文件以 0600 独占创建，不覆盖已有报告。 */
export async function saveTodoLiveEvidenceReport(path: string, report: TodoLiveEvidenceReport): Promise<void> {
  if (!isAbsolute(path)) fail('report_path_invalid');
  validateTodoLiveEvidenceReport(report);
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/**
 * 从仓库根读取冻结的 Todo 演示需求契约，返回报告绑定用的需求身份：
 * 固定版本号 + 需求文件正文的 sha256 摘要。契约缺失或无效时 fail-closed。
 */
export function todoLiveRequirementsIdentity(root: string): { readonly version: number; readonly digest: string } {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('requirements_root_invalid');
  loadTodoDemoRequirements(root);
  let content: string;
  try {
    content = readFileSync(join(root, P08_TODO_REQUIREMENTS_PATH), 'utf8');
  } catch {
    fail('requirements_root_invalid');
  }
  return {
    version: P08_TODO_REQUIREMENTS_VERSION,
    digest: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}
