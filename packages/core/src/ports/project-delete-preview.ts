/**
 * P07-3 / F-009：项目删除只读预览端口（纯契约 + 确定性计算，无 I/O）。
 *
 * 设计依据：FR-2、core-design/03 §4/§6、04 §5.1、08 §2、T15；复用 F-008 的
 * 项目级活动占用口径与 P03-5 workspace discard 的内容摘要/丢弃保护先例。
 *
 * 契约要点：
 * - 预览是显式、只读、分页有界的授权依据：列出待删管理对象与正文、保留的
 *   源仓库/分支/备份/最小回执、活动执行与工作区占用、被引用证据及阻塞原因；
 *   不修改任何业务状态或文件，不登记破坏性 operation；
 * - 预览摘要绑定项目与 revision、仓库身份、对象与正文清单、引用关系、活动
 *   状态、策略与有效期；归档前（status<>'archived'）或存在活动/不确定执行、
 *   清点不完整、跨项目被引用、脏 worktree 未获独立丢弃确认、分页未完成时
 *   一律不可确认删除，且不得省略被阻塞对象生成可执行摘要；
 * - 删除目标只能由真实数据库关系（project_id 归属）与受管文件区推导；展示名、
 *   客户端 sourcePath、storage_locator 等展示字段不参与目标推导；
 * - retained/脏 worktree 的 tracked/untracked/需保留 ignored 内容与影响按
 *   workspace discard 同一口径列出；普通项目删除确认不得隐式丢弃未保存代码
 *   （确认门槛由 F-010 在写事务内复验，本端口提供确定性判定函数）；
 * - 分页游标绑定同一 previewDigest/有效期：翻页时服务端重算摘要，内容、绑定
 *   或引用变化即冲突（摘要失效），过期即拒绝。
 */
import { createHash } from 'node:crypto';
import { assertTrustedPrincipal, requireCapability, requireProjectVisible, type TrustedPrincipal } from './authorization.js';
import { stableStringify } from './feature-plan.js';
import type { ProjectArchiveBlockers } from './project-lifecycle.js';
import { hasProjectArchiveBlockers } from './project-lifecycle.js';
import type { ProjectStatus } from './state-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** P07-3 / F-009：只读删除预览命令操作身份（能力位复用 project.lifecycle.write）。 */
export const PROJECT_DELETE_PREVIEW_OPERATION = 'project.delete.preview' as const;
export const PROJECT_DELETE_PREVIEW_SCHEMA_VERSION = 1 as const;
/** 预览有效期默认 5 分钟（与 workspace discard 预览同一量级；确认前由 F-010 重算复验）。 */
export const PROJECT_DELETE_PREVIEW_TTL_DEFAULT_MS = 300_000;
/** 单页对象条目上限（默认；服务装配可注入更小值用于分页测试）。 */
export const PROJECT_DELETE_PREVIEW_MAX_PAGE_ENTRIES = 200;
/** 每个工作区在预览中列出的 tracked/untracked/ignored 条目上限。 */
export const PROJECT_DELETE_PREVIEW_MAX_WORKSPACE_CONTENT_ENTRIES = 64;
/** 对象/正文/引用清点的安全上限（超限视为清点不完整，阻止确认）。 */
export const PROJECT_DELETE_PREVIEW_MAX_OBJECTS = 20_000;
export const PROJECT_DELETE_PREVIEW_MAX_ARTIFACT_BODIES = 20_000;
export const PROJECT_DELETE_PREVIEW_MAX_TOTAL_BODY_BYTES = 512 * 1024 * 1024;
export const PROJECT_DELETE_PREVIEW_MAX_BODY_BYTES = 64 * 1024 * 1024;
export const PROJECT_DELETE_PREVIEW_MAX_WORKSPACES = 16;
export const PROJECT_DELETE_PREVIEW_MAX_REFERENCE_ROWS = 100_000;
export const PROJECT_DELETE_PREVIEW_MAX_RETAINED_LISTED = 64;

/** 固定删除策略：这些受管数据类别随项目删除；其余显式保留。 */
export const PROJECT_DELETE_POLICY = Object.freeze({
  deletes: Object.freeze(['managed_database_rows', 'artifact_bodies', 'artifact_staging_residue', 'managed_worktree_directories'] as const),
  retains: Object.freeze(['source_repositories', 'git_branches', 'committed_work', 'backups', 'minimal_command_receipts'] as const),
  worktreeContents: 'dirty_contents_require_separate_discard_confirmation',
} as const);

export type ProjectDeleteDisposition = 'delete' | 'retain-minimal';

/** 清点出的待删/保留管理对象（kind 为稳定表名；id 为主键身份，绝非展示名）。 */
export interface ProjectDeleteObjectFact {
  readonly kind: string;
  readonly id: string;
  readonly disposition: ProjectDeleteDisposition;
}

/** 制品正文文件事实：摘要由预览现场重新哈希得出（只读），并与登记身份核对。 */
export interface ProjectDeleteArtifactBodyFact {
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** 仓库绑定身份（不含规范路径等敏感位置；路径只用于受界检查器）。 */
export interface ProjectDeleteRepositoryBindingFact {
  readonly bindingId: string;
  readonly repoIdentity: string;
  readonly revision: number;
  readonly bindingRevision: number;
}

export interface ProjectDeleteWorkspaceContentCounts {
  /** 全部受 Git 索引/HEAD 管理的 tracked 工作副本（与丢弃预览同一展示口径）。 */
  readonly tracked: number;
  /** 有未提交修改的 tracked 路径（porcelain 非 ??/!! 条目；丢失即不可恢复）。 */
  readonly modifiedTracked: number;
  readonly untracked: number;
  readonly ignored: number;
  readonly bytes: number;
}

/** 工作区现场检查（复用 WorkspaceInspector 的只读口径；不携带绝对路径）。 */
export interface ProjectDeleteWorkspaceInspectionFact {
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly ignoredDigest: string;
  readonly counts: ProjectDeleteWorkspaceContentCounts;
  readonly truncated: boolean;
  readonly contents: {
    readonly tracked: readonly string[];
    readonly modifiedTracked: readonly string[];
    readonly untracked: readonly string[];
    readonly ignored: readonly string[];
  };
  readonly impact: {
    readonly irreversible: true;
    readonly discardsUncommittedTrackedChanges: number;
    readonly discardsUntrackedFiles: number;
    readonly discardsIgnoredFiles: number;
    readonly discardsBytes: number;
    readonly preserves: readonly string[];
  };
}

export interface ProjectDeleteWorkspaceFact {
  readonly workspaceId: string;
  readonly featureId: string;
  readonly branch: string;
  readonly status: string;
  readonly revision: number;
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly baseCommit: string;
  readonly registeredHeadCommit: string | null;
  readonly registeredCodeDigest: string | null;
  /** 现场检查成功时的内容事实；失败/目录缺失时给出受控原因（一律视为不确定并阻塞）。 */
  readonly inspection: ProjectDeleteWorkspaceInspectionFact | { readonly unavailableReason: string };
}

export interface ProjectDeleteReferenceSummary {
  /** 本项目内部对制品的引用数（将随对象一并删除）。 */
  readonly inProject: number;
  /** 其他项目行引用本项目制品（跨项目被引用证据；阻塞删除）。 */
  readonly incomingCrossProject: number;
  /** 指向未知制品的引用（数据不完整；阻塞删除）。 */
  readonly unknown: number;
  /** 有界示例（稳定原因串，如 `incoming:memory_records:<projectId>`）。 */
  readonly examples: readonly string[];
}

/** 显式保留项（源仓库/分支/备份/最小回执）。 */
export interface ProjectDeleteRetainedFact {
  readonly kind: 'source-repository' | 'branches' | 'backup' | 'minimal-receipt';
  readonly id: string;
  readonly detail?: string;
}

/** 只读清点结果（数据库一致读 + 受管文件区/正文现场事实）。 */
export interface ProjectDeleteInventory {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectStatus: ProjectStatus;
  /** 按 [kind,id] 排序的全部对象（含保留最小回执的条目；受清点上限约束）。 */
  readonly objects: readonly ProjectDeleteObjectFact[];
  readonly artifactBodies: readonly ProjectDeleteArtifactBodyFact[];
  readonly repositoryBindings: readonly ProjectDeleteRepositoryBindingFact[];
  readonly workspaces: readonly ProjectDeleteWorkspaceFact[];
  /** 工作区现场检查输入（含规范路径；仅供受界检查器，绝不进入预览输出/摘要）。 */
  readonly workspaceInspectionInputs: readonly ProjectDeleteWorkspaceInspectionInput[];
  readonly references: ProjectDeleteReferenceSummary;
  readonly retained: readonly ProjectDeleteRetainedFact[];
  readonly activity: ProjectArchiveBlockers;
  /** 数据库对象总数（不受上限截断的 COUNT；与 objects.length 不一致即不完整）。 */
  readonly totalObjects: number;
  /** 清点是否完整（扫描上限、未知表、缺失/漂移正文都会置 false）。 */
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

/** 现场检查输入：受管 worktree 的受界检查基线（内部事实，不对外输出）。 */
export interface ProjectDeleteWorkspaceInspectionInput {
  readonly workspaceId: string;
  readonly status: string;
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly repoIdentity: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string;
  readonly branch: string;
  readonly baseCommit: string;
}

/** 预览单页：绑定摘要与策略的分页有界只读视图。 */
export interface ProjectDeletePreviewPage {
  readonly schemaVersion: typeof PROJECT_DELETE_PREVIEW_SCHEMA_VERSION;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectStatus: ProjectStatus;
  readonly previewDigest: string;
  readonly observedAtUtcMs: number;
  readonly expiresAtUtcMs: number;
  readonly policy: typeof PROJECT_DELETE_POLICY;
  readonly summary: {
    readonly objects: {
      readonly total: number;
      readonly listed: number;
      readonly deletions: number;
      readonly retainedMinimal: number;
      readonly byKind: Readonly<Record<string, number>>;
    };
    readonly artifactBodies: {
      readonly count: number;
      readonly totalBytes: number;
      /** 有界正文清单（完整清单只进入摘要绑定；超出分页上限截断）。 */
      readonly listed: readonly ProjectDeleteArtifactBodyFact[];
    };
    readonly repositoryBindings: readonly ProjectDeleteRepositoryBindingFact[];
    readonly workspaces: readonly ProjectDeleteWorkspaceFact[];
    readonly references: ProjectDeleteReferenceSummary;
    readonly retained: readonly ProjectDeleteRetainedFact[];
    readonly activity: ProjectArchiveBlockers;
  };
  readonly entries: readonly ProjectDeleteObjectFact[];
  readonly pagination: { readonly complete: boolean; readonly nextCursor: string | null };
  readonly inventoryComplete: boolean;
  readonly inventoryReasons: readonly string[];
  readonly blockers: readonly ProjectDeleteConfirmBlocker[];
  readonly confirmable: boolean;
}

/** 确认阻碍（F-010 确认事务复用同一判定；任何一项存在即不可确认）。 */
export const PROJECT_DELETE_CONFIRM_BLOCKERS = [
  'project_not_archived',
  'pagination_incomplete',
  'inventory_incomplete',
  'active_execution',
  'incoming_cross_project_reference',
  'unknown_reference',
  'workspace_discard_confirmation_required',
  'workspace_state_uncertain',
  'preview_expired',
] as const;
export type ProjectDeleteConfirmBlocker = (typeof PROJECT_DELETE_CONFIRM_BLOCKERS)[number];

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function workspaceInspectionDigestSource(fact: ProjectDeleteWorkspaceFact): unknown {
  if ('unavailableReason' in fact.inspection) {
    return { unavailable: fact.inspection.unavailableReason };
  }
  const inspection = fact.inspection;
  return {
    headCommit: inspection.headCommit,
    codeDigest: inspection.codeDigest,
    ignoredDigest: inspection.ignoredDigest,
    counts: inspection.counts,
    truncated: inspection.truncated,
    contents: inspection.contents,
  };
}

/**
 * 预览摘要：绑定项目与 revision、仓库身份、对象与正文清单、引用关系、活动
 * 状态、工作区现场、保留项、策略与有效期。任何输入变化都改变摘要（确认前
 * 重算比对即失效）。
 */
export function computeProjectDeletePreviewDigest(
  inventory: ProjectDeleteInventory,
  policy: typeof PROJECT_DELETE_POLICY,
  expiresAtUtcMs: number,
): string {
  return hashStable({
    schemaVersion: PROJECT_DELETE_PREVIEW_SCHEMA_VERSION,
    projectId: inventory.projectId,
    projectRevision: inventory.projectRevision,
    projectStatus: inventory.projectStatus,
    repositoryBindings: inventory.repositoryBindings.map(binding => [
      binding.bindingId, binding.repoIdentity, binding.revision, binding.bindingRevision,
    ]),
    objects: inventory.objects.map(object => [object.kind, object.id, object.disposition]),
    totalObjects: inventory.totalObjects,
    artifactBodies: inventory.artifactBodies.map(body => [body.artifactId, body.sizeBytes, body.sha256]),
    workspaces: inventory.workspaces.map(workspace => [
      workspace.workspaceId, workspace.featureId, workspace.status, workspace.revision,
      workspace.repositoryBindingId, workspace.repositoryBindingRevision,
      workspace.registeredHeadCommit, workspace.registeredCodeDigest,
      workspaceInspectionDigestSource(workspace),
    ]),
    references: inventory.references,
    retained: inventory.retained.map(item => [item.kind, item.id, item.detail ?? null]),
    activity: inventory.activity,
    inventoryComplete: inventory.complete,
    policy,
    expiresAtUtcMs,
  });
}

/** 分页游标：同一预览会话的身份（摘要+有效期）与边界键； opaque base64url。 */
export interface ProjectDeletePreviewCursor {
  readonly previewDigest: string;
  readonly expiresAtUtcMs: number;
  readonly lastKey: string;
}

const CURSOR_KEY_SEPARATOR = '\u001f';

export function projectDeleteObjectKey(kind: string, id: string): string {
  return `${kind}${CURSOR_KEY_SEPARATOR}${id}`;
}

export function encodeProjectDeletePreviewCursor(cursor: ProjectDeletePreviewCursor): string {
  const json = JSON.stringify([cursor.previewDigest, cursor.expiresAtUtcMs, cursor.lastKey]);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeProjectDeletePreviewCursor(raw: unknown): ProjectDeletePreviewCursor {
  const context: ValidationContext = { operation: PROJECT_DELETE_PREVIEW_OPERATION };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw validationError(context, 'cursor', '必须是有效的分页游标');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw validationError(context, 'cursor', '必须是有效的分页游标');
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw validationError(context, 'cursor', '必须是有效的分页游标');
  }
  const [digestValue, expiresValue, lastKey] = parsed as [unknown, unknown, unknown];
  if (typeof expiresValue !== 'number' || !Number.isSafeInteger(expiresValue) || expiresValue < 1
    || typeof lastKey !== 'string' || lastKey.length === 0 || lastKey.length > 512
    || lastKey.includes(CURSOR_KEY_SEPARATOR) === false) {
    throw validationError(context, 'cursor', '必须是有效的分页游标');
  }
  return {
    previewDigest: validateSha256Digest(digestValue, context, 'cursor.previewDigest'),
    expiresAtUtcMs: expiresValue,
    lastKey,
  };
}

/** 服务输入（命令面与直接调用共用；principal 由命令层传入）。 */
export interface ProjectDeletePreviewInput {
  readonly principal: TrustedPrincipal;
  readonly projectId: string;
  readonly cursor?: string;
}

export function validateProjectDeletePreviewInput(raw: unknown): ProjectDeletePreviewInput {
  const context: ValidationContext = { operation: PROJECT_DELETE_PREVIEW_OPERATION };
  const object = requirePlainObject(raw, context, 'input');
  rejectUnknownKeys(object, ['principal', 'projectId', 'cursor'], context, 'input');
  // 游标结构先行校验（decode 抛受控校验错误）；原样字符串交给服务重算比对。
  if (object.cursor !== undefined) decodeProjectDeletePreviewCursor(object.cursor);
  assertTrustedPrincipal(object.principal);
  const input: ProjectDeletePreviewInput = {
    principal: object.principal,
    projectId: validateStableId(object.projectId, { ...context, entity: { type: 'project' } }, 'input.projectId'),
    ...(object.cursor === undefined ? {} : { cursor: object.cursor as string }),
  };
  requireCapability(input.principal, 'project.lifecycle.write', PROJECT_DELETE_PREVIEW_OPERATION);
  requireProjectVisible(input.principal, input.projectId, PROJECT_DELETE_PREVIEW_OPERATION);
  return input;
}

/** 确认可行性判定（纯函数；F-010 确认事务与本 Task 测试共用同一口径）。 */
export function assessProjectDeletePreviewConfirmability(
  page: Pick<ProjectDeletePreviewPage,
    'projectStatus' | 'pagination' | 'inventoryComplete' | 'summary' | 'expiresAtUtcMs'>,
  nowUtcMs: number,
): { readonly confirmable: boolean; readonly blockers: readonly ProjectDeleteConfirmBlocker[] } {
  const blockers = new Set<ProjectDeleteConfirmBlocker>();
  if (page.projectStatus !== 'archived') blockers.add('project_not_archived');
  if (!page.pagination.complete) blockers.add('pagination_incomplete');
  if (!page.inventoryComplete) blockers.add('inventory_incomplete');
  if (hasProjectArchiveBlockers(page.summary.activity)) blockers.add('active_execution');
  if (page.summary.references.incomingCrossProject > 0) blockers.add('incoming_cross_project_reference');
  if (page.summary.references.unknown > 0) blockers.add('unknown_reference');
  for (const workspace of page.summary.workspaces) {
    if ('unavailableReason' in workspace.inspection) {
      // cleaned 是确定状态：无目录、无未保存内容，不固不确定。
      if (workspace.inspection.unavailableReason !== 'workspace_cleaned') {
        blockers.add('workspace_state_uncertain');
      }
      continue;
    }
    if (workspace.inspection.counts.modifiedTracked + workspace.inspection.counts.untracked + workspace.inspection.counts.ignored > 0) {
      blockers.add('workspace_discard_confirmation_required');
    }
  }
  if (!(nowUtcMs < page.expiresAtUtcMs)) blockers.add('preview_expired');
  const ordered = PROJECT_DELETE_CONFIRM_BLOCKERS.filter(blocker => blockers.has(blocker));
  return { confirmable: ordered.length === 0, blockers: ordered };
}

/** 工作区是否需要现场检查（cleaned 视为无目录、无未保存内容）。 */
export function isProjectDeleteWorkspaceInspectable(status: string): boolean {
  return status !== 'cleaned';
}

/** 工作区是否有未保存代码/待保留内容（未提交 tracked 修改 + untracked + ignored；与 F-011 待保留内容同口径）。 */
export function isProjectDeleteWorkspaceDirty(workspace: ProjectDeleteWorkspaceFact): boolean {
  return 'unavailableReason' in workspace.inspection
    || workspace.inspection.counts.modifiedTracked + workspace.inspection.counts.untracked + workspace.inspection.counts.ignored > 0;
}
