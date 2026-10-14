/**
 * F-010 独立人工丢弃预览与确认端口（ports 契约层，纯类型 + 确定性计算 + 运行时校验，无 I/O）。
 *
 * 验收边界：
 * - 预览是显式、只读、有界的授权依据：展示受管 workspace/branch、当前 HEAD、
 *   tracked/untracked/ignored 待丢弃内容、不可逆影响与预览摘要；不携带绝对路径，
 *   不因失败状态自动触发；
 * - 确认必须经既有可信主体（TrustedPrincipal）、项目可见性与 commandId 幂等通道，
 *   绑定当前 workspace revision、HEAD、内容摘要与明确丢弃范围（worktree_only）；
 *   未确认（摘要不符）、不同主体越权、过期预览或确认期间内容/HEAD 变化一律拒绝
 *   且零删除；
 * - 丢弃只处理已预览的受管工作区目录与 Git 登记：不删除源仓库、Feature 分支、
 *   已提交成果或审计记录；人工丢弃授权与 F-008/F-009 自动清理授权互不通用；
 * - 存储端口负责意图登记、previewDigest 重算、有效期/占用/停止证据门槛与
 *   fencing；删除器端口负责路径/登记/内容复核与限定范围的 `git worktree remove`；
 * - 本层不实现：任意目录删除、分支回滚、项目永久删除、自动清理、Host 接线
 *   （F-011）与 CLI 展示（F-012）。
 */
import { createHash } from 'node:crypto';
import type { CommandProcessIdentity } from './command-process.js';
import { isUuidV4 } from './commands.js';
import { assertTrustedPrincipal, type TrustedPrincipal } from './authorization.js';
import { stableStringify } from './feature-plan.js';
import type { RepositoryBindingRecord } from './state-store.js';
import type { WorkspaceBaseline, WorkspaceOperationCommit, WorkspaceOperationResult, WorkspaceStatus, ManagedWorkspaceRecord } from './workspace.js';
import { validateWorkspaceCommit } from './workspace.js';
import {
  rejectUnknownKeys, requirePlainObject, validateStableId, validatePositiveInteger,
  validateSha256Digest, validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const WORKSPACE_DISCARD_OPERATION = 'workspace.discard' as const;
/** 丢弃范围固定为受管工作区目录与其 Git 登记；分支/源仓库/审计永远不在范围内。 */
export const WORKSPACE_DISCARD_SCOPE = 'worktree_only' as const;
export const WORKSPACE_DISCARD_PREVIEW_TTL_DEFAULT_MS = 300_000;
export const WORKSPACE_DISCARD_PREVIEW_MAX_ENTRIES = 256;

/** 预览展示的当前确认阻碍（信息性；确认时由存储层重新强制）。 */
export const WORKSPACE_DISCARD_BLOCKERS = ['workspace_status_not_discardable', 'occupancy_active',
  'stop_evidence_missing', 'unfinished_workspace_operation'] as const;
export type WorkspaceDiscardBlocker = typeof WORKSPACE_DISCARD_BLOCKERS[number];

/** 登记后、删除前重核的门禁拒绝原因（记录为 failed operation，零删除）。 */
export const WORKSPACE_DISCARD_GATE_REFUSALS = ['workspace_status_not_discardable', 'preview_expired',
  'occupancy_active', 'stop_evidence_missing'] as const;
export type WorkspaceDiscardGateRefusal = typeof WORKSPACE_DISCARD_GATE_REFUSALS[number];

export interface WorkspaceDiscardPreviewEntry {
  readonly path: string;
  readonly state: 'present' | 'deleted';
  readonly sizeBytes: number | null;
  readonly protection: 'preserve' | 'tracked';
}
/** 预览绑定：确认输入必须携带并由存储层重算 previewDigest 核验。 */
export interface WorkspaceDiscardPreviewBinding {
  readonly previewDigest: string;
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
  readonly workspaceRevision: number;
  readonly expiresAtUtcMs: number;
}
export interface WorkspaceDiscardPreview extends WorkspaceDiscardPreviewBinding {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly featureId: string;
  readonly workspaceId: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: WorkspaceStatus;
  readonly scope: typeof WORKSPACE_DISCARD_SCOPE;
  readonly contents: {
    readonly tracked: readonly WorkspaceDiscardPreviewEntry[];
    readonly untracked: readonly WorkspaceDiscardPreviewEntry[];
    readonly ignored: readonly WorkspaceDiscardPreviewEntry[];
    readonly counts: { readonly tracked: number; readonly untracked: number; readonly ignored: number; readonly bytes: number };
    readonly truncated: boolean;
  };
  readonly impact: {
    readonly irreversible: true;
    readonly discardsUncommittedTrackedChanges: number;
    readonly discardsUntrackedFiles: number;
    readonly discardsIgnoredFiles: number;
    readonly discardsBytes: number;
    readonly preserves: readonly ['source_repository', 'feature_branch', 'committed_work', 'audit_records'];
  };
  readonly blockers: readonly WorkspaceDiscardBlocker[];
  readonly observedAtUtcMs: number;
  /** 预览证据 Artifact 引用（不可变 JSON；确认经 evidenceRefs 关联）。 */
  readonly evidenceRef: string;
}

/** 预览摘要摘要的确定性计算：确认时按同一字段集合重算比对（防篡改绑定）。 */
export function computeWorkspaceDiscardPreviewDigest(fields: {
  readonly projectId: string;
  readonly featureId: string;
  readonly workspaceId: string;
  readonly branch: string;
  readonly workspaceRevision: number;
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
  readonly expiresAtUtcMs: number;
}): string {
  return createHash('sha256').update(stableStringify({
    schemaVersion: 1, projectId: fields.projectId, featureId: fields.featureId, workspaceId: fields.workspaceId,
    branch: fields.branch, workspaceRevision: fields.workspaceRevision, headCommit: fields.headCommit,
    codeDigest: fields.codeDigest, ignoredDigest: fields.ignoredDigest,
    scope: WORKSPACE_DISCARD_SCOPE, expiresAtUtcMs: fields.expiresAtUtcMs,
  })).digest('hex');
}

export interface WorkspaceDiscardPreviewInput {
  readonly principal: TrustedPrincipal;
  readonly projectId: string;
  readonly featureId: string;
}

export interface WorkspaceDiscardConfirmInput {
  readonly principal: TrustedPrincipal;
  readonly commandId: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedWorkspaceRevision: number;
  readonly preview: WorkspaceDiscardPreviewBinding;
  readonly evidenceRefs: readonly string[];
}

/** 存储层输入：授权已在应用层完成，主体只剩不可伪造的 principalId。 */
export interface WorkspaceDiscardInput extends Omit<WorkspaceDiscardConfirmInput, 'principal'> {
  readonly principalId: string;
}

/** 预览存储只读视图：目标工作区、仓库绑定与当前确认阻碍。 */
export interface WorkspaceDiscardPreviewTarget {
  readonly workspace: ManagedWorkspaceRecord;
  readonly binding: RepositoryBindingRecord;
  readonly blockers: readonly WorkspaceDiscardBlocker[];
}
export interface WorkspaceDiscardPreviewStore {
  loadPreviewTarget(projectId: unknown, featureId: unknown): WorkspaceDiscardPreviewTarget | null;
}

export interface WorkspaceDiscardOutcome {
  /** True 仅当登记的工作区目录与 Git 登记均确证消失。 */
  readonly removed: boolean;
  /** True 当本次是对同一 operation 先前中断删除的事实核对补写。 */
  readonly recovered: boolean;
  readonly removedHeadCommit: string | null;
  readonly removedCodeDigest: string | null;
  /** 结构化拒绝原因；成功为 null。 */
  readonly reason: string | null;
  /** 变更性 Git 进程可能仍在运行：工作区必须隔离。 */
  readonly isolated: boolean;
  readonly result: Omit<WorkspaceOperationResult, 'evidenceRefs' | 'errorRef'>;
}

export interface WorkspaceDiscardIntent {
  readonly commit: WorkspaceOperationCommit;
  readonly binding: RepositoryBindingRecord;
  readonly baseline: WorkspaceBaseline;
  /** 拒绝（未删除）时恢复的 workspace 状态。 */
  readonly priorStatus: WorkspaceStatus;
}

export interface WorkspaceDiscarderGates {
  fence(): void;
  /** 删除前最后重核门禁；返回拒绝原因（门槛失败绝不抛异常）。 */
  authorize(): string | null;
}

export interface WorkspaceDiscardJournal {
  readonly verified: import('./workspace-cleaner.js').WorkspaceCleanerVerified | null;
  readonly unfinishedProcesses: readonly CommandProcessIdentity[];
}
export interface WorkspaceDiscardCheckpoint extends WorkspaceDiscardJournal {
  recordVerified(value: import('./workspace-cleaner.js').WorkspaceCleanerVerified): void;
  recordProcess(identity: CommandProcessIdentity): void;
  recordStop(identity: CommandProcessIdentity): void;
}

export interface FeatureWorktreeDiscarder {
  discard(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline, expected: WorkspaceDiscardExpected,
    gates: WorkspaceDiscarderGates, checkpoint: WorkspaceDiscardCheckpoint): Promise<WorkspaceDiscardOutcome>;
  /** 回执提交前复核：删除事实、分支与受保护源仓库仍然成立。 */
  confirmDiscard(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline,
    verified: import('./workspace-cleaner.js').WorkspaceCleanerVerified): Promise<void>;
}
/** 删除前必须与预览绑定逐项一致的实际内容摘要。 */
export interface WorkspaceDiscardExpected {
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
}

export interface WorkspaceDiscardStore {
  begin(input: WorkspaceDiscardInput): WorkspaceDiscardIntent;
  readJournal(input: WorkspaceDiscardInput, intent: WorkspaceDiscardIntent): WorkspaceDiscardJournal;
  recordCheckpoint(input: WorkspaceDiscardInput, intent: WorkspaceDiscardIntent,
    kind: 'verified' | 'process' | 'stop', value: import('./workspace-cleaner.js').WorkspaceCleanerVerified | CommandProcessIdentity): void;
  assertCurrent(input: WorkspaceDiscardInput, intent: WorkspaceDiscardIntent): void;
  recheckAuthorization(input: WorkspaceDiscardInput, intent: WorkspaceDiscardIntent): string | null;
  finish(input: WorkspaceDiscardInput, intent: WorkspaceDiscardIntent, outcome: WorkspaceDiscardOutcome,
    evidenceRef: string): WorkspaceOperationCommit;
  quarantine(input: WorkspaceDiscardInput, intent?: WorkspaceDiscardIntent): void;
}

function validatePreviewBinding(value: unknown, context: ValidationContext): WorkspaceDiscardPreviewBinding {
  const raw = requirePlainObject(value, context, 'preview');
  rejectUnknownKeys(raw, ['previewDigest', 'headCommit', 'codeDigest', 'ignoredDigest', 'workspaceRevision', 'expiresAtUtcMs'], context, 'preview');
  return {
    previewDigest: validateSha256Digest(raw.previewDigest, context, 'preview.previewDigest'),
    headCommit: validateWorkspaceCommit(raw.headCommit),
    codeDigest: validateSha256Digest(raw.codeDigest, context, 'preview.codeDigest'),
    ignoredDigest: validateSha256Digest(raw.ignoredDigest, context, 'preview.ignoredDigest'),
    workspaceRevision: validatePositiveInteger(raw.workspaceRevision, context, 'preview.workspaceRevision'),
    expiresAtUtcMs: validatePositiveInteger(raw.expiresAtUtcMs, context, 'preview.expiresAtUtcMs'),
  };
}

/** 结构校验 fail-closed；principal 形状非法是可信装配编程错误（TypeError）。 */
export function validateWorkspaceDiscardPreviewInput(value: unknown): WorkspaceDiscardPreviewInput {
  const context: ValidationContext = { operation: 'Workspace.discard.preview' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['principal', 'projectId', 'featureId'], context, 'input');
  assertTrustedPrincipal(raw.principal);
  return {
    principal: raw.principal,
    projectId: validateStableId(raw.projectId, context, 'projectId'),
    featureId: validateStableId(raw.featureId, context, 'featureId'),
  };
}

export function validateWorkspaceDiscardConfirmInput(value: unknown): WorkspaceDiscardConfirmInput {
  const context: ValidationContext = { operation: 'Workspace.discard.confirm' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['principal', 'commandId', 'projectId', 'featureId', 'workspaceId', 'operationId',
    'expectedWorkspaceRevision', 'preview', 'evidenceRefs'], context, 'input');
  assertTrustedPrincipal(raw.principal);
  if (!isUuidV4(raw.commandId)) throw validationError(context, 'commandId', '必须是 RFC 4122 UUID v4（小写）');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length < 1 || raw.evidenceRefs.length > 49) {
    throw validationError(context, 'evidenceRefs', 'Expected bounded evidence references');
  }
  return {
    principal: raw.principal,
    commandId: raw.commandId,
    projectId: validateStableId(raw.projectId, context, 'projectId'),
    featureId: validateStableId(raw.featureId, context, 'featureId'),
    workspaceId: validateStableId(raw.workspaceId, context, 'workspaceId'),
    operationId: validateStableId(raw.operationId, context, 'operationId'),
    expectedWorkspaceRevision: validatePositiveInteger(raw.expectedWorkspaceRevision, context, 'expectedWorkspaceRevision'),
    preview: validatePreviewBinding(raw.preview, context),
    evidenceRefs: raw.evidenceRefs.map(v => validateStableId(v, context, 'evidenceRef')),
  };
}

/** 应用层授权通过后构造存储输入；principal 不再下行。 */
export function toWorkspaceDiscardStoreInput(input: WorkspaceDiscardConfirmInput): WorkspaceDiscardInput {
  return {
    principalId: input.principal.principalId,
    commandId: input.commandId,
    projectId: input.projectId,
    featureId: input.featureId,
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    preview: input.preview,
    evidenceRefs: input.evidenceRefs,
  };
}

export function validateWorkspaceDiscardInput(value: unknown): WorkspaceDiscardInput {
  const context: ValidationContext = { operation: 'Workspace.discard' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['principalId', 'commandId', 'projectId', 'featureId', 'workspaceId', 'operationId',
    'expectedWorkspaceRevision', 'preview', 'evidenceRefs'], context, 'input');
  if (!isUuidV4(raw.commandId)) throw validationError(context, 'commandId', '必须是 RFC 4122 UUID v4（小写）');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length < 1 || raw.evidenceRefs.length > 49) {
    throw validationError(context, 'evidenceRefs', 'Expected bounded evidence references');
  }
  return {
    principalId: validateStableId(raw.principalId, context, 'principalId'),
    commandId: raw.commandId,
    projectId: validateStableId(raw.projectId, context, 'projectId'),
    featureId: validateStableId(raw.featureId, context, 'featureId'),
    workspaceId: validateStableId(raw.workspaceId, context, 'workspaceId'),
    operationId: validateStableId(raw.operationId, context, 'operationId'),
    expectedWorkspaceRevision: validatePositiveInteger(raw.expectedWorkspaceRevision, context, 'expectedWorkspaceRevision'),
    preview: validatePreviewBinding(raw.preview, context),
    evidenceRefs: raw.evidenceRefs.map(v => validateStableId(v, context, 'evidenceRef')),
  };
}
