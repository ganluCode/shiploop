/**
 * F-009 工作区清理 operation 端口（ports 契约层，纯类型 + 运行时校验，无 I/O）。
 *
 * 验收边界：
 * - 清理是获准安全成功后的非强制 worktree 删除：输入必须携带 F-008 cleanable
 *   决策（全门槛通过且新鲜）与决策时核验的 HEAD/代码摘要/ignored 摘要；
 * - 存储端口负责意图登记、owner/revision/writer fencing、审批与停止/释放证据
 *   重核；清理器端口负责路径/登记/内容复核与非强制 `git worktree remove`；
 * - Git/文件 I/O 永远不在 SQLite 事务内；删除已发生而回执未提交时按受管意图
 *   与实际 Git/文件状态核对补写，不重复删除、不假报成功；
 * - 本层不实现：强制删除、递归删除、源仓库清理、分支删除、Task/Feature 状态
 *   变更、人工丢弃（F-010）。
 */
import type { CommandProcessIdentity } from './command-process.js';
import type { RepositoryBindingRecord } from './state-store.js';
import type { WorkResourceIdentity } from './work-resources.js';
import { validateWorkResourceIdentity } from './work-resources.js';
import { WORKSPACE_CLEANUP_GATES, WORKSPACE_CLEANUP_REASONS } from './workspace-cleanup.js';
import type { WorkspaceCleanupDecision } from './workspace-cleanup.js';
import type { WorkspaceBaseline, WorkspaceOperationCommit, WorkspaceOperationResult, WorkspaceStatus } from './workspace.js';
import { validateWorkspaceCommit } from './workspace.js';
import {
  rejectUnknownKeys, requirePlainObject, validateStableId, validatePositiveInteger,
  validateSha256Digest, validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** Store gate refusals re-checked after intent registration, right before any deletion. */
export const WORKSPACE_CLEANER_GATE_REFUSALS = ['decision_not_cleanable', 'decision_expired',
  'execution_not_succeeded', 'release_evidence_missing', 'occupancy_active', 'approval_changed'] as const;
export type WorkspaceCleanerGateRefusal = typeof WORKSPACE_CLEANER_GATE_REFUSALS[number];

/** The HEAD/content summary the F-008 decision was based on; re-verified before deletion. */
export interface WorkspaceCleanerExpected {
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
}
export interface WorkspaceCleanerInput {
  readonly identity: WorkResourceIdentity;
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedWorkspaceRevision: number;
  readonly decision: WorkspaceCleanupDecision;
  readonly expected: WorkspaceCleanerExpected;
  readonly evidenceRefs: readonly string[];
}
export interface WorkspaceCleanerDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
/** Protected source-checkout facts captured before removal and re-verified after. */
export interface WorkspaceCleanerSourceState {
  readonly headCommit: string;
  readonly branch: string;
  readonly refsDigest: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
  readonly indexDigest: string;
}
/** Durable admission facts recorded before the mutating removal is allowed to start. */
export interface WorkspaceCleanerVerified {
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
  readonly directoryIdentity: WorkspaceCleanerDirectoryIdentity;
  readonly source: WorkspaceCleanerSourceState;
}
export interface WorkspaceCleanerJournal {
  readonly verified: WorkspaceCleanerVerified | null;
  readonly unfinishedProcesses: readonly CommandProcessIdentity[];
}
export interface WorkspaceCleanerCheckpoint extends WorkspaceCleanerJournal {
  recordVerified(value: WorkspaceCleanerVerified): void;
  recordProcess(identity: CommandProcessIdentity): void;
  recordStop(identity: CommandProcessIdentity): void;
}
/**
 * gates.fence() re-checks owner/revision/writer fencing and throws StorageError on
 * violation; gates.authorize() re-runs the full gate set and returns a refusal
 * reason (never throws for gate failures). Both run outside Git process lifetimes.
 */
export interface WorkspaceCleanerGates {
  fence(): void;
  authorize(): string | null;
}
export interface WorkspaceCleanerOutcome {
  /** True only when the registered worktree directory and registration are verifiably gone. */
  readonly removed: boolean;
  /** True when removal was reconciled from a prior interrupted attempt of the same operation. */
  readonly recovered: boolean;
  readonly removedHeadCommit: string | null;
  readonly removedCodeDigest: string | null;
  /** Structured refusal reason; null on success. */
  readonly reason: string | null;
  /** A mutating Git command may still be running; the workspace must be quarantined. */
  readonly isolated: boolean;
  readonly result: Omit<WorkspaceOperationResult, 'evidenceRefs' | 'errorRef'>;
}
export interface FeatureWorktreeCleaner {
  clean(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline, expected: WorkspaceCleanerExpected,
    gates: WorkspaceCleanerGates, checkpoint: WorkspaceCleanerCheckpoint): Promise<WorkspaceCleanerOutcome>;
  /** Post-publication recheck that the removal state, branch and protected source still hold. */
  confirmRemoval(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline, verified: WorkspaceCleanerVerified): Promise<void>;
}
export interface WorkspaceCleanerIntent {
  readonly commit: WorkspaceOperationCommit;
  readonly binding: RepositoryBindingRecord;
  readonly baseline: WorkspaceBaseline;
  /** Status to restore when the operation refuses before any deletion. */
  readonly priorStatus: WorkspaceStatus;
}
export interface WorkspaceCleanerStore {
  begin(input: WorkspaceCleanerInput): WorkspaceCleanerIntent;
  readJournal(input: WorkspaceCleanerInput, intent: WorkspaceCleanerIntent): WorkspaceCleanerJournal;
  recordCheckpoint(input: WorkspaceCleanerInput, intent: WorkspaceCleanerIntent,
    kind: 'verified' | 'process' | 'stop', value: WorkspaceCleanerVerified | CommandProcessIdentity): void;
  assertCurrent(input: WorkspaceCleanerInput, intent: WorkspaceCleanerIntent): void;
  recheckAuthorization(input: WorkspaceCleanerInput, intent: WorkspaceCleanerIntent): string | null;
  finish(input: WorkspaceCleanerInput, intent: WorkspaceCleanerIntent, outcome: WorkspaceCleanerOutcome,
    evidenceRef: string): WorkspaceOperationCommit;
  quarantine(input: WorkspaceCleanerInput, intent?: WorkspaceCleanerIntent): void;
}

function decision(value: unknown): WorkspaceCleanupDecision {
  const context: ValidationContext = { operation: 'Workspace.clean.decision' };
  const raw = requirePlainObject(value, context, 'decision');
  rejectUnknownKeys(raw, ['schemaVersion', 'outcome', 'reasons', 'gates', 'checkedAtUtcMs'], context, 'decision');
  if (raw.schemaVersion !== 1) throw validationError(context, 'decision.schemaVersion', '必须是 1');
  if (!['retain', 'quarantine', 'cleanable'].includes(String(raw.outcome))) {
    throw validationError(context, 'decision.outcome', '必须是 retain/quarantine/cleanable', raw.outcome);
  }
  if (!Array.isArray(raw.reasons) || raw.reasons.length < 1 || raw.reasons.length > 16
    || raw.reasons.some(r => typeof r !== 'string' || !WORKSPACE_CLEANUP_REASONS.includes(r as typeof WORKSPACE_CLEANUP_REASONS[number]))) {
    throw validationError(context, 'decision.reasons', '必须是已知清理原因的非空数组');
  }
  if (!Array.isArray(raw.gates) || raw.gates.length !== WORKSPACE_CLEANUP_GATES.length) {
    throw validationError(context, 'decision.gates', '必须包含全部清理门槛');
  }
  const gates = raw.gates.map((entry, index) => {
    const gate = requirePlainObject(entry, context, `decision.gates[${index}]`);
    rejectUnknownKeys(gate, ['gate', 'status', 'reasons'], context, `decision.gates[${index}]`);
    if (gate.gate !== WORKSPACE_CLEANUP_GATES[index]) throw validationError(context, `decision.gates[${index}].gate`, '门槛顺序不符');
    if (!['passed', 'refused'].includes(String(gate.status))) throw validationError(context, `decision.gates[${index}].status`, '必须是 passed/refused');
    if (!Array.isArray(gate.reasons)
      || gate.reasons.some(r => typeof r !== 'string' || !WORKSPACE_CLEANUP_REASONS.includes(r as typeof WORKSPACE_CLEANUP_REASONS[number]))) {
      throw validationError(context, `decision.gates[${index}].reasons`, '必须是已知清理原因数组');
    }
    return { gate: gate.gate as WorkspaceCleanupDecision['gates'][number]['gate'],
      status: gate.status as 'passed' | 'refused', reasons: gate.reasons as WorkspaceCleanupDecision['gates'][number]['reasons'] };
  });
  return { schemaVersion: 1, outcome: raw.outcome as WorkspaceCleanupDecision['outcome'],
    reasons: raw.reasons as WorkspaceCleanupDecision['reasons'], gates,
    checkedAtUtcMs: validatePositiveInteger(raw.checkedAtUtcMs, context, 'decision.checkedAtUtcMs') };
}

/** 结构校验 fail-closed：非法输入拒绝；语义门槛由存储层在登记与删除前重核。 */
export function validateWorkspaceCleanerInput(value: unknown): WorkspaceCleanerInput {
  const context: ValidationContext = { operation: 'Workspace.clean' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['identity', 'runId', 'taskId', 'workspaceId', 'operationId',
    'expectedWorkspaceRevision', 'decision', 'expected', 'evidenceRefs'], context, 'input');
  const expected = requirePlainObject(raw.expected, context, 'expected');
  rejectUnknownKeys(expected, ['headCommit', 'codeDigest', 'ignoredDigest'], context, 'expected');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length < 1 || raw.evidenceRefs.length > 49) {
    throw validationError(context, 'evidenceRefs', 'Expected bounded evidence references');
  }
  return {
    identity: validateWorkResourceIdentity(raw.identity),
    runId: validateStableId(raw.runId, context, 'runId'),
    taskId: validateStableId(raw.taskId, context, 'taskId'),
    workspaceId: validateStableId(raw.workspaceId, context, 'workspaceId'),
    operationId: validateStableId(raw.operationId, context, 'operationId'),
    expectedWorkspaceRevision: validatePositiveInteger(raw.expectedWorkspaceRevision, context, 'expectedWorkspaceRevision'),
    decision: decision(raw.decision),
    expected: {
      headCommit: validateWorkspaceCommit(expected.headCommit),
      codeDigest: validateSha256Digest(expected.codeDigest, context, 'expected.codeDigest'),
      ignoredDigest: validateSha256Digest(expected.ignoredDigest, context, 'expected.ignoredDigest'),
    },
    evidenceRefs: raw.evidenceRefs.map(v => validateStableId(v, context, 'evidenceRef')),
  };
}

export function validateWorkspaceCleanerVerified(value: unknown): WorkspaceCleanerVerified {
  const context: ValidationContext = { operation: 'Workspace.clean.verified' };
  const raw = requirePlainObject(value, context, 'verified');
  rejectUnknownKeys(raw, ['headCommit', 'codeDigest', 'ignoredDigest', 'directoryIdentity', 'source'], context, 'verified');
  const directory = requirePlainObject(raw.directoryIdentity, context, 'verified.directoryIdentity');
  rejectUnknownKeys(directory, ['device', 'inode', 'birthtimeNs'], context, 'verified.directoryIdentity');
  if ([directory.device, directory.inode, directory.birthtimeNs].some(v => typeof v !== 'string' || !/^\d{1,30}$/.test(v))) {
    throw validationError(context, 'verified.directoryIdentity', 'Invalid directory identity');
  }
  const source = requirePlainObject(raw.source, context, 'verified.source');
  rejectUnknownKeys(source, ['headCommit', 'branch', 'refsDigest', 'codeDigest', 'ignoredDigest', 'indexDigest'], context, 'verified.source');
  const branch = source.branch;
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 256 || /[\0-\x1f\x7f]/.test(branch)) {
    throw validationError(context, 'verified.source.branch', 'Invalid source branch');
  }
  return {
    headCommit: validateWorkspaceCommit(raw.headCommit),
    codeDigest: validateSha256Digest(raw.codeDigest, context, 'verified.codeDigest'),
    ignoredDigest: validateSha256Digest(raw.ignoredDigest, context, 'verified.ignoredDigest'),
    directoryIdentity: directory as unknown as WorkspaceCleanerDirectoryIdentity,
    source: {
      headCommit: validateWorkspaceCommit(source.headCommit),
      branch,
      refsDigest: validateSha256Digest(source.refsDigest, context, 'verified.source.refsDigest'),
      codeDigest: validateSha256Digest(source.codeDigest, context, 'verified.source.codeDigest'),
      ignoredDigest: validateSha256Digest(source.ignoredDigest, context, 'verified.source.ignoredDigest'),
      indexDigest: validateSha256Digest(source.indexDigest, context, 'verified.source.indexDigest'),
    },
  };
}
