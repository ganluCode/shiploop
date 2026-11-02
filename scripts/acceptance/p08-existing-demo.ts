/**
 * P08-2 / F-008 存量仓库增量证据契约。
 *
 * 这里仅保存和校验脱敏的基线/增量结果，不执行 project init、SQLite、Host、Pi
 * 或进程操作。真实跨层接入由 P08 Phase 集成执行；本模块把「原有失败仍是缺口」
 * 和「本次增量是否通过」分开，避免注册成功或新测试通过掩盖旧失败。
 */
import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const P08_EXISTING_DEMO_NOT_RUN = [
  { id: 'real-project-init', status: 'not_run' as const, owner: 'phase-integration', reason: 'real_cli_init_host_sqlite' },
  { id: 'real-incremental-pi', status: 'not_run' as const, owner: 'phase-integration', reason: 'real_pi_incremental_execution' },
  { id: 'real-process-combination', status: 'not_run' as const, owner: 'phase-integration', reason: 'real_host_sqlite_process_combination' },
  { id: 'archive-and-reopen', status: 'not_run' as const, owner: 'phase-integration', reason: 'archive_reopen_lifecycle' },
] as const;

export class ExistingRepoReportError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'ExistingRepoReportError';
    this.reason = reason;
  }
}

function fail(reason: string): never {
  throw new ExistingRepoReportError(reason);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safePath(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PATH.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function gitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA.test(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function existingRepoEvidenceDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export type ExistingDirtyState = 'modified_unstaged' | 'modified_staged' | 'untracked';

export interface ExistingRepoDirtyFile {
  readonly path: string;
  readonly state: ExistingDirtyState;
  readonly digest: string;
}

export interface ExistingRepoTestResult {
  readonly id: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly knownFailure: boolean;
  readonly evidenceRef: string | null;
}

export interface ExistingRepoSnapshot {
  readonly repository: {
    readonly kind: 'non-nezha';
    readonly projectId: string;
    readonly pathDigest: string;
  };
  readonly headCommit: string;
  readonly statusPorcelain: string;
  readonly dirtyFiles: readonly ExistingRepoDirtyFile[];
  readonly fileSnapshots: readonly { readonly path: string; readonly digest: string }[];
  readonly existingTests: readonly ExistingRepoTestResult[];
  readonly knownFailures: readonly string[];
}

export interface ExistingRepoInitialization {
  readonly status: 'passed' | 'failed';
  readonly ownershipVerified: boolean;
  readonly pathScopeVerified: boolean;
  readonly headPreserved: boolean;
  readonly dirtyFilesPreserved: boolean;
  readonly automaticCommit: boolean;
  readonly beforeSnapshot: ExistingRepoSnapshot;
  readonly afterSnapshot: ExistingRepoSnapshot;
  readonly reasons: readonly string[];
}

export interface ExistingRepoChange {
  readonly path: string;
  readonly kind: 'code' | 'test';
  readonly digest: string;
}

export interface ExistingRepoReport {
  readonly schemaVersion: 1;
  readonly kind: 'shiploop.existing-repo.incremental-evidence';
  readonly status: 'passed' | 'failed' | 'inconclusive' | 'not_run';
  readonly statusReason: string | null;
  readonly identity: {
    readonly projectId: string;
    readonly repositoryLabel: string;
    readonly repositoryKind: 'non-nezha';
    readonly repositoryPathDigest: string;
  };
  readonly baseline: ExistingRepoSnapshot;
  readonly initialization: ExistingRepoInitialization;
  readonly request: {
    readonly id: string;
    readonly description: string;
    readonly approvedPaths: readonly string[];
  };
  readonly increment: {
    readonly scope: { readonly status: 'passed' | 'failed'; readonly outOfScopePaths: readonly string[] };
    readonly changes: readonly ExistingRepoChange[];
    readonly verification: {
      readonly command: readonly string[];
      readonly exitCode: number;
      readonly evidenceRef: string;
    };
  };
  readonly git: {
    readonly headBefore: string;
    readonly commitSha: string;
    readonly treeSha: string;
    readonly committedPaths: readonly string[];
    readonly originalDirtyPathsPreserved: boolean;
  };
  readonly baselineGaps: readonly { readonly id: string; readonly status: 'unresolved'; readonly reason: string }[];
  readonly checks: readonly {
    readonly id: string;
    readonly status: 'passed' | 'failed' | 'known_failure' | 'inconclusive';
    readonly reason: string | null;
  }[];
  readonly notRun: typeof P08_EXISTING_DEMO_NOT_RUN;
  readonly reportDigest: string;
}

export interface ExistingRepoInitializationInput {
  readonly baseline: ExistingRepoSnapshot;
  readonly after: ExistingRepoSnapshot;
  readonly authorization: {
    readonly confirmed: boolean;
    readonly projectId: string;
    readonly repositoryPathDigest: string;
    readonly approvedPaths: readonly string[];
  };
  readonly automaticCommit: boolean;
}

function validateSnapshot(snapshot: ExistingRepoSnapshot): void {
  if (snapshot.repository?.kind !== 'non-nezha' || !safeId(snapshot.repository.projectId) || !digest(snapshot.repository.pathDigest)) {
    fail('baseline_identity_invalid');
  }
  if (!gitSha(snapshot.headCommit) || typeof snapshot.statusPorcelain !== 'string') fail('baseline_git_invalid');
  if (!Array.isArray(snapshot.dirtyFiles) || snapshot.dirtyFiles.length === 0) fail('baseline_dirty_files_missing');
  for (const file of snapshot.dirtyFiles) {
    if (!safePath(file.path) || !['modified_unstaged', 'modified_staged', 'untracked'].includes(file.state) || !digest(file.digest)) {
      fail('baseline_dirty_file_invalid');
    }
  }
  if (!Array.isArray(snapshot.fileSnapshots) || snapshot.fileSnapshots.length === 0
      || snapshot.fileSnapshots.some(file => !safePath(file.path) || !digest(file.digest))) fail('baseline_file_snapshot_invalid');
  if (!Array.isArray(snapshot.existingTests) || snapshot.existingTests.length === 0) fail('baseline_tests_missing');
  for (const test of snapshot.existingTests) {
    if (!safeId(test.id) || !Array.isArray(test.command) || test.command.length === 0
        || test.command.some((item: unknown) => !text(item)) || !['passed', 'failed', 'not_run'].includes(test.status)
        || typeof test.knownFailure !== 'boolean'
        || (test.evidenceRef !== null && !safePath(test.evidenceRef))) fail('baseline_test_invalid');
    if (test.exitCode !== null && !Number.isSafeInteger(test.exitCode)) fail('baseline_test_exit_invalid');
  }
  if (!Array.isArray(snapshot.knownFailures) || snapshot.knownFailures.length === 0
      || snapshot.knownFailures.some(id => !safeId(id) || !snapshot.existingTests.some(test => test.id === id && test.knownFailure && test.status === 'failed'))) {
    fail('known_failure_baseline_missing');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

export function evaluateExistingRepoInitialization(input: ExistingRepoInitializationInput): ExistingRepoInitialization {
  validateSnapshot(input.baseline);
  validateSnapshot(input.after);
  const ownershipVerified = input.authorization.confirmed
    && input.authorization.projectId === input.baseline.repository.projectId
    && input.authorization.projectId === input.after.repository.projectId
    && input.authorization.repositoryPathDigest === input.baseline.repository.pathDigest
    && input.authorization.repositoryPathDigest === input.after.repository.pathDigest;
  const pathScopeVerified = input.authorization.approvedPaths.length > 0
    && input.authorization.approvedPaths.every(safePath)
    && new Set(input.authorization.approvedPaths).size === input.authorization.approvedPaths.length;
  const headPreserved = input.baseline.headCommit === input.after.headCommit;
  const dirtyFilesPreserved = sameJson(input.baseline.dirtyFiles, input.after.dirtyFiles)
    && input.baseline.statusPorcelain === input.after.statusPorcelain;
  const reasons: string[] = [];
  if (!ownershipVerified) reasons.push('project_ownership_or_path_mismatch');
  if (!pathScopeVerified) reasons.push('approved_path_scope_invalid');
  if (!headPreserved) reasons.push('init_changed_head');
  if (!dirtyFilesPreserved) reasons.push('init_changed_dirty_state');
  if (input.automaticCommit) reasons.push('automatic_commit_forbidden');
  return {
    status: reasons.length === 0 ? 'passed' : 'failed', ownershipVerified, pathScopeVerified,
    headPreserved, dirtyFilesPreserved, automaticCommit: input.automaticCommit,
    beforeSnapshot: input.baseline, afterSnapshot: input.after, reasons,
  };
}

export interface ExistingRepoReportInput {
  readonly projectId: string;
  readonly repositoryLabel: string;
  readonly baseline: ExistingRepoSnapshot;
  readonly initialization: ExistingRepoInitialization;
  readonly request: { readonly id: string; readonly description: string; readonly approvedPaths: readonly string[] };
  readonly changes: readonly ExistingRepoChange[];
  readonly verification: { readonly command: readonly string[]; readonly exitCode: number; readonly evidenceRef: string };
  readonly git: {
    readonly headBefore: string;
    readonly commitSha: string;
    readonly treeSha: string;
    readonly committedPaths: readonly string[];
    readonly originalDirtyPathsPreserved: boolean;
  };
}

function validateChange(change: ExistingRepoChange): void {
  if (!safePath(change.path) || !['code', 'test'].includes(change.kind) || !digest(change.digest)) fail('increment_change_invalid');
}

function validateReportInput(input: ExistingRepoReportInput): void {
  validateSnapshot(input.baseline);
  if (!input.initialization || !input.initialization.beforeSnapshot || !input.initialization.afterSnapshot) fail('initialization_snapshot_missing');
  validateSnapshot(input.initialization.beforeSnapshot);
  validateSnapshot(input.initialization.afterSnapshot);
  if (!sameJson(input.initialization.beforeSnapshot, input.baseline)
      || input.initialization.beforeSnapshot.repository.pathDigest !== input.baseline.repository.pathDigest) fail('initialization_before_snapshot_mismatch');
  if (!safeId(input.projectId) || input.projectId !== input.baseline.repository.projectId
      || !text(input.repositoryLabel) || input.repositoryLabel.includes('/')) fail('report_identity_invalid');
  if (!safeId(input.request.id) || !text(input.request.description) || !Array.isArray(input.request.approvedPaths)
      || input.request.approvedPaths.length === 0 || input.request.approvedPaths.some(path => !safePath(path))
      || new Set(input.request.approvedPaths).size !== input.request.approvedPaths.length) fail('increment_request_invalid');
  if (!Array.isArray(input.changes) || input.changes.length < 2) fail('increment_changes_missing');
  for (const change of input.changes) validateChange(change);
  const approved = new Set(input.request.approvedPaths);
  const outOfScope = input.changes.filter(change => !approved.has(change.path)).map(change => change.path);
  if (outOfScope.length > 0 || !input.changes.some(change => change.kind === 'code') || !input.changes.some(change => change.kind === 'test')) fail('increment_scope_invalid');
  if (!Array.isArray(input.verification.command) || input.verification.command.length === 0
      || input.verification.command.some(item => !text(item)) || input.verification.exitCode !== 0 || !safePath(input.verification.evidenceRef)) fail('increment_verification_invalid');
  if (!gitSha(input.git.headBefore) || !gitSha(input.git.commitSha) || !gitSha(input.git.treeSha)
      || !input.git.originalDirtyPathsPreserved || input.git.headBefore !== input.baseline.headCommit) fail('git_evidence_invalid');
  if (!Array.isArray(input.git.committedPaths) || input.git.committedPaths.some(path => !safePath(path))
      || new Set(input.git.committedPaths).size !== input.git.committedPaths.length) fail('git_evidence_invalid');
  const changedPaths = input.changes.map(change => change.path);
  if (new Set(changedPaths).size !== changedPaths.length
      || canonical([...input.git.committedPaths].sort()) !== canonical([...changedPaths].sort())) fail('git_commit_scope_invalid');
  const dirtyPaths = new Set(input.baseline.dirtyFiles.map(file => file.path));
  if (input.git.committedPaths.some(path => dirtyPaths.has(path))) fail('original_dirty_file_was_committed');
}

function buildChecks(input: ExistingRepoReportInput, outOfScopePaths: readonly string[]) {
  return [
    { id: 'baseline-preserved', status: input.initialization.headPreserved && input.initialization.dirtyFilesPreserved ? 'passed' as const : 'failed' as const, reason: input.initialization.reasons[0] ?? null },
    { id: 'init-authorization', status: input.initialization.status === 'passed' && input.initialization.ownershipVerified && input.initialization.pathScopeVerified && !input.initialization.automaticCommit ? 'passed' as const : 'failed' as const, reason: input.initialization.reasons[0] ?? null },
    { id: 'increment-scope', status: outOfScopePaths.length === 0 ? 'passed' as const : 'failed' as const, reason: outOfScopePaths.length === 0 ? null : 'out_of_scope_change' },
    { id: 'increment-verification', status: input.verification.exitCode === 0 ? 'passed' as const : 'failed' as const, reason: input.verification.exitCode === 0 ? null : 'new_requirement_check_failed' },
    { id: 'git-commit-evidence', status: input.git.originalDirtyPathsPreserved ? 'passed' as const : 'failed' as const, reason: input.git.originalDirtyPathsPreserved ? null : 'original_dirty_file_was_committed' },
    ...input.baseline.knownFailures.map(id => ({ id, status: 'known_failure' as const, reason: 'known_baseline_failure' })),
  ];
}

function deriveStatus(checks: ExistingRepoReport['checks'], initialization: ExistingRepoInitialization, outOfScopePaths: readonly string[]): { status: ExistingRepoReport['status']; statusReason: string | null } {
  if (initialization.status !== 'passed' || outOfScopePaths.length > 0 || checks.some(check => check.status === 'failed')) return { status: 'failed', statusReason: 'increment_or_initialization_failed' };
  if (checks.some(check => check.status === 'known_failure')) return { status: 'inconclusive', statusReason: 'known_baseline_failure' };
  if (P08_EXISTING_DEMO_NOT_RUN.length > 0) return { status: 'not_run', statusReason: 'phase_integration_not_run' };
  return { status: 'passed', statusReason: null };
}

export function createExistingRepoReport(input: ExistingRepoReportInput): ExistingRepoReport {
  validateReportInput(input);
  const outOfScopePaths = input.changes.filter(change => !input.request.approvedPaths.includes(change.path)).map(change => change.path);
  const checks = buildChecks(input, outOfScopePaths);
  const derived = deriveStatus(checks, input.initialization, outOfScopePaths);
  const reportBody = {
    schemaVersion: 1 as const,
    kind: 'shiploop.existing-repo.incremental-evidence' as const,
    status: derived.status,
    statusReason: derived.statusReason,
    identity: { projectId: input.projectId, repositoryLabel: input.repositoryLabel, repositoryKind: 'non-nezha' as const, repositoryPathDigest: input.baseline.repository.pathDigest },
    baseline: input.baseline,
    initialization: input.initialization,
    request: { id: input.request.id, description: input.request.description, approvedPaths: [...input.request.approvedPaths] },
    increment: {
      scope: { status: outOfScopePaths.length === 0 ? 'passed' as const : 'failed' as const, outOfScopePaths },
      changes: input.changes.map(change => ({ ...change })),
      verification: { command: [...input.verification.command], exitCode: input.verification.exitCode, evidenceRef: input.verification.evidenceRef },
    },
    git: { ...input.git, committedPaths: [...input.git.committedPaths] },
    baselineGaps: input.baseline.knownFailures.map(id => ({ id, status: 'unresolved' as const, reason: 'known_baseline_failure' })),
    checks,
    notRun: P08_EXISTING_DEMO_NOT_RUN,
  } satisfies Omit<ExistingRepoReport, 'reportDigest'>;
  return { ...reportBody, reportDigest: existingRepoEvidenceDigest(reportBody) };
}

export function validateExistingRepoReport(value: unknown): ExistingRepoReport {
  if (value === null || typeof value !== 'object') fail('report_invalid');
  const report = value as ExistingRepoReport;
  if (report.schemaVersion !== 1 || report.kind !== 'shiploop.existing-repo.incremental-evidence') fail('report_identity_invalid');
  try {
    validateReportInput({
      projectId: report.identity.projectId,
      repositoryLabel: report.identity.repositoryLabel,
      baseline: report.baseline,
      initialization: report.initialization,
      request: report.request,
      changes: report.increment.changes,
      verification: report.increment.verification,
      git: report.git,
    });
  } catch (error) {
    if (error instanceof ExistingRepoReportError && error.reason === 'increment_scope_invalid') throw error;
    fail(error instanceof ExistingRepoReportError ? error.reason : 'report_input_invalid');
  }
  if (!Array.isArray(report.baselineGaps) || report.baselineGaps.length !== report.baseline.knownFailures.length
      || report.baselineGaps.some(gap => !safeId(gap.id) || gap.status !== 'unresolved' || gap.reason !== 'known_baseline_failure')) fail('baseline_gap_invalid');
  if (!Array.isArray(report.checks) || report.checks.length !== report.baseline.knownFailures.length + 5) fail('checks_invalid');
  if (!sameJson(report.initialization.beforeSnapshot, report.baseline)
      || report.initialization.afterSnapshot.repository.pathDigest !== report.baseline.repository.pathDigest) fail('initialization_snapshot_mismatch');
  if (report.identity.repositoryPathDigest !== report.baseline.repository.pathDigest
      || report.identity.repositoryKind !== 'non-nezha') fail('report_identity_invalid');
  if (!sameJson(report.notRun, P08_EXISTING_DEMO_NOT_RUN)) fail('not_run_scope_invalid');
  const expectedOutOfScope = report.increment.changes
    .filter(change => !report.request.approvedPaths.includes(change.path)).map(change => change.path);
  if (!sameJson(report.increment.scope.outOfScopePaths, expectedOutOfScope)
      || report.increment.scope.status !== (expectedOutOfScope.length === 0 ? 'passed' : 'failed')) fail('increment_scope_invalid');
  const knownCheckIds = report.checks.filter(check => check.status === 'known_failure').map(check => check.id);
  if (!sameJson(knownCheckIds, report.baseline.knownFailures)) fail('known_failure_check_invalid');
  const expectedStatus = deriveStatus(report.checks, report.initialization, expectedOutOfScope);
  if (report.status !== expectedStatus.status || report.statusReason !== expectedStatus.statusReason) fail('status_propagation_invalid');
  const { reportDigest, ...body } = report;
  if (!digest(reportDigest) || existingRepoEvidenceDigest(body) !== reportDigest) fail('report_digest_invalid');
  return report;
}

export function renderExistingRepoText(report: ExistingRepoReport): string {
  validateExistingRepoReport(report);
  return [
    `existing-repo: status=${report.status} reason=${report.statusReason ?? 'none'}`,
    `increment: changes=${report.increment.changes.length} committed=${report.git.committedPaths.length}`,
    `baseline-gaps: ${report.baselineGaps.map(gap => gap.id).join(',') || 'none'}`,
    `not-run: ${report.notRun.map(item => item.id).join(',')}`,
  ].join('\n');
}
