/**
 * P07-3 / F-009：项目删除只读预览服务（application 层）。
 *
 * 编排纪律（与 workspace discard 预览同一先例）：
 * - 预览零写入：不发布证据、不登记 operation、不触碰业务状态或文件；授权
 *   （project.lifecycle.write + 项目可见）后只做只读清点与现场检查；
 * - 数据库事实与文件事实来自清点适配器（单只读一致读 + 事务外只读哈希）；
 *   retained/脏 worktree 的 tracked/untracked/ignored 内容与影响复用
 *   WorkspaceInspector 的同一口径列出；脏内容必须走既有 workspace.discard
 *   确认，项目删除确认不隐式丢弃未保存代码；
 * - 摘要绑定完整清点 + 策略 + 有效期；分页游标携带同一摘要/有效期，翻页时
 *   重算比对，内容/绑定/引用变化即 preview_content_changed 冲突（摘要失效）；
 * - 确认可行性由 assessProjectDeletePreviewConfirmability 纯函数判定（F-010
 *   确认事务复用同一口径）；被阻塞对象不省略，摘要不降级为可执行。
 */
import { PublicError } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import type { StorageError } from '../ports/errors.js';
import type { WorkspaceInspector } from '../ports/workspace-inspector.js';
import {
  PROJECT_DELETE_POLICY,
  PROJECT_DELETE_PREVIEW_MAX_PAGE_ENTRIES,
  PROJECT_DELETE_PREVIEW_MAX_WORKSPACE_CONTENT_ENTRIES,
  PROJECT_DELETE_PREVIEW_MAX_WORKSPACES,
  PROJECT_DELETE_PREVIEW_OPERATION,
  PROJECT_DELETE_PREVIEW_TTL_DEFAULT_MS,
  assessProjectDeletePreviewConfirmability,
  computeProjectDeletePreviewDigest,
  decodeProjectDeletePreviewCursor,
  encodeProjectDeletePreviewCursor,
  isProjectDeleteWorkspaceInspectable,
  projectDeleteObjectKey,
  validateProjectDeletePreviewInput,
  type ProjectDeleteInventory,
  type ProjectDeletePreviewCursor,
  type ProjectDeletePreviewPage,
  type ProjectDeleteWorkspaceFact,
  type ProjectDeleteWorkspaceInspectionFact,
} from '../ports/project-delete-preview.js';

/** porcelain v1 -z 输出中的未提交 tracked 修改路径（排除 ??/!!）。 */
function parseModifiedTrackedPaths(statusPorcelainBase64: string): string[] {
  const decoded = Buffer.from(statusPorcelainBase64, 'base64').toString('utf8');
  const paths: string[] = []
  for (const record of decoded.split('\u0000')) {
    if (record === '') continue;
    const match = record.match(/^([MADRCU?!. ]{2}) (.+)$/);
    if (match === null) continue; // 罕见改名条目的旧路径段：新路径已由主条目覆盖
    const code = match[1];
    if (code.trim() === '' || code === '??' || code === '!!') continue;
    paths.push(match[2]);
  }
  return [...new Set(paths)];
}

export interface ProjectDeletePreviewService {
  preview(raw: unknown): Promise<ProjectDeletePreviewPage>;
  captureForConfirmation(raw: unknown, expiresAtUtcMs: number): Promise<{ page: ProjectDeletePreviewPage; inventory: ProjectDeleteInventory }>;
}

export function createProjectDeletePreviewService(options: {
  /** 只读清点适配器（SQLite 一致读 + 受管文件区事实）。 */
  readonly inventory: { readInventory(projectId: string): Promise<ProjectDeleteInventory> };
  /** 按项目构造受界工作区检查器（数据根 + 项目绑定路径；与既有恢复/丢弃同一先例）。 */
  readonly inspectorFor: (projectId: string) => Promise<WorkspaceInspector>;
  readonly nowUtcMs?: () => number;
  readonly ttlMs?: number;
  readonly maxPageEntries?: number;
  readonly maxWorkspaceContentEntries?: number;
  readonly maxInspectedWorkspaces?: number;
}): ProjectDeletePreviewService {
  const now = options.nowUtcMs ?? Date.now;
  const ttlMs = options.ttlMs ?? PROJECT_DELETE_PREVIEW_TTL_DEFAULT_MS;
  const maxPageEntries = options.maxPageEntries ?? PROJECT_DELETE_PREVIEW_MAX_PAGE_ENTRIES;
  const maxWorkspaceContentEntries = options.maxWorkspaceContentEntries ?? PROJECT_DELETE_PREVIEW_MAX_WORKSPACE_CONTENT_ENTRIES;
  const maxInspectedWorkspaces = options.maxInspectedWorkspaces ?? PROJECT_DELETE_PREVIEW_MAX_WORKSPACES;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1
    || !Number.isSafeInteger(maxPageEntries) || maxPageEntries < 1
    || !Number.isSafeInteger(maxWorkspaceContentEntries) || maxWorkspaceContentEntries < 1
    || !Number.isSafeInteger(maxInspectedWorkspaces) || maxInspectedWorkspaces < 1) {
    throw new TypeError('ProjectDeletePreviewService 参数非法');
  }

  const operation = PROJECT_DELETE_PREVIEW_OPERATION;

  /** 现场检查单个受管 worktree（只读；失败返回受控原因，绝不 partial digest）。 */
  async function inspectWorkspace(projectId: string, input: ProjectDeleteInventory['workspaceInspectionInputs'][number]): Promise<ProjectDeleteWorkspaceFact['inspection']> {
    try {
      const inspector = await options.inspectorFor(projectId);
      const inspection = await inspector.inspect({
        repositoryBindingId: input.repositoryBindingId,
        repositoryBindingRevision: input.repositoryBindingRevision,
        repoIdentity: input.repoIdentity,
        canonicalPath: input.canonicalPath,
        gitCommonDir: input.gitCommonDir,
        branch: input.branch,
        baseCommit: input.baseCommit,
      });
      const cap = (entries: ReadonlyArray<{ path: string }>): string[] => entries.slice(0, maxWorkspaceContentEntries).map(entry => entry.path);
      const truncated = inspection.contents.tracked.length > maxWorkspaceContentEntries
        || inspection.contents.untracked.length > maxWorkspaceContentEntries
        || inspection.contents.ignored.length > maxWorkspaceContentEntries;
      // 未提交 tracked 修改：来自 porcelain 状态（非 ??/!! 条目）；这些内容的丢失
      // 不可从分支找回，是“未保存代码”的准确边界。
      const modifiedTracked = parseModifiedTrackedPaths(inspection.statusPorcelainBase64);
      const fact: ProjectDeleteWorkspaceInspectionFact = {
        headCommit: inspection.repository.headCommit,
        codeDigest: inspection.codeDigest,
        ignoredDigest: inspection.ignoredDigest,
        counts: {
          tracked: inspection.contents.tracked.length,
          modifiedTracked: modifiedTracked.length,
          untracked: inspection.contents.untracked.length,
          ignored: inspection.contents.ignored.length,
          bytes: inspection.observedBytes,
        },
        truncated,
        contents: {
          tracked: cap(inspection.contents.tracked),
          modifiedTracked: modifiedTracked.slice(0, maxWorkspaceContentEntries),
          untracked: cap(inspection.contents.untracked),
          ignored: cap(inspection.contents.ignored),
        },
        impact: {
          irreversible: true,
          discardsUncommittedTrackedChanges: modifiedTracked.length,
          discardsUntrackedFiles: inspection.contents.untracked.length,
          discardsIgnoredFiles: inspection.contents.ignored.length,
          discardsBytes: inspection.observedBytes,
          preserves: ['source_repository', 'feature_branch', 'committed_work', 'audit_records'],
        },
      };
      return fact;
    } catch {
      // 检查失败（目录缺失/Git 失败/越界等）一律不确定：不提供部分摘要。
      return { unavailableReason: 'workspace_inspection_unavailable' };
    }
  }

  return Object.freeze({
    async preview(raw: unknown): Promise<ProjectDeletePreviewPage> {
      try {
        return (await previewInternal(raw)).page;
      } catch (error) {
        // 入参校验（游标结构等）折算为公开 invalid_input；其余错误原样上抛。
        if (isStorageError(error) && (error as StorageError).kind === 'validation') {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'cursor', reason: 'invalid_cursor' },
          });
        }
        throw error;
      }
    },
    captureForConfirmation: (raw: unknown, expiresAtUtcMs: number) => previewInternal(raw, expiresAtUtcMs),
  });

  async function previewInternal(raw: unknown, confirmationExpiry?: number): Promise<{ page: ProjectDeletePreviewPage; inventory: ProjectDeleteInventory }> {
    const input = validateProjectDeletePreviewInput(raw);
      const observedAtUtcMs = now();
      let inventory: ProjectDeleteInventory;
      try {
        inventory = await options.inventory.readInventory(input.projectId);
      } catch (error) {
        if (isStorageError(error) && error.kind === 'not_found') {
          throw new PublicError('not_found', operation, undefined, { details: { entityType: 'project' } });
        }
        throw error;
      }

      // 工作区现场检查：cleaned 无目录无内容；超出检查上限保持不确定（fail-closed）。
      const inspected = new Map<string, ProjectDeleteWorkspaceFact['inspection']>();
      let inspectedCount = 0;
      for (const workspaceInput of inventory.workspaceInspectionInputs) {
        if (!isProjectDeleteWorkspaceInspectable(workspaceInput.status)) {
          inspected.set(workspaceInput.workspaceId, { unavailableReason: 'workspace_cleaned' });
          continue;
        }
        if (inspectedCount >= maxInspectedWorkspaces) {
          inspected.set(workspaceInput.workspaceId, { unavailableReason: 'workspace_inspection_skipped' });
          continue;
        }
        inspectedCount += 1;
        inspected.set(workspaceInput.workspaceId, await inspectWorkspace(input.projectId, workspaceInput));
      }
      const workspaces: ProjectDeleteWorkspaceFact[] = inventory.workspaces.map(workspace => ({
        ...workspace,
        inspection: inspected.get(workspace.workspaceId) ?? { unavailableReason: 'workspace_inspection_skipped' },
      }));
      const inventoried: ProjectDeleteInventory = { ...inventory, workspaces };

      // 游标会话：同一摘要/有效期；重算不匹配即摘要失效。
      let cursor: ProjectDeletePreviewCursor | undefined;
      let expiresAtUtcMs: number;
      if (input.cursor === undefined) {
        expiresAtUtcMs = confirmationExpiry ?? observedAtUtcMs + ttlMs;
      } else {
        cursor = decodeProjectDeletePreviewCursor(input.cursor);
        expiresAtUtcMs = cursor.expiresAtUtcMs;
      }
      const previewDigest = computeProjectDeletePreviewDigest(inventoried, PROJECT_DELETE_POLICY, expiresAtUtcMs);
      if (cursor !== undefined) {
        if (cursor.previewDigest !== previewDigest) {
          throw new PublicError('conflict', operation, undefined, { details: { reason: 'preview_content_changed' } });
        }
        if (!(observedAtUtcMs < expiresAtUtcMs)) {
          throw new PublicError('conflict', operation, undefined, { details: { reason: 'preview_expired' } });
        }
      }

      // 分页：按 [kind,id] 排序切片；未到末页即不可确认（分页未完成拒绝确认）。
      const sorted = [...inventoried.objects].sort((left, right) => {
        const leftKey = projectDeleteObjectKey(left.kind, left.id);
        const rightKey = projectDeleteObjectKey(right.kind, right.id);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      const startIndex = cursor === undefined ? 0 : sorted.findIndex(object => projectDeleteObjectKey(object.kind, object.id) > cursor.lastKey);
      const pageEntries = sorted.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + maxPageEntries);
      const paginationComplete = startIndex >= 0 && Math.max(startIndex, 0) + maxPageEntries >= sorted.length;
      const nextCursor = paginationComplete || pageEntries.length === 0
        ? null
        : encodeProjectDeletePreviewCursor({
          previewDigest,
          expiresAtUtcMs,
          lastKey: projectDeleteObjectKey(pageEntries.at(-1)!.kind, pageEntries.at(-1)!.id),
        });

      const byKind: Record<string, number> = {};
      let deletions = 0;
      let retainedMinimal = 0;
      for (const object of sorted) {
        byKind[object.kind] = (byKind[object.kind] ?? 0) + 1;
        if (object.disposition === 'delete') deletions += 1;
        else retainedMinimal += 1;
      }
      const totalBodyBytes = inventoried.artifactBodies.reduce((sum, body) => sum + body.sizeBytes, 0);
      const summary: ProjectDeletePreviewPage['summary'] = {
        objects: { total: inventoried.totalObjects, listed: sorted.length, deletions, retainedMinimal, byKind },
        artifactBodies: {
          count: inventoried.artifactBodies.length,
          totalBytes: totalBodyBytes,
          listed: inventoried.artifactBodies.slice(0, maxPageEntries),
        },
        repositoryBindings: inventoried.repositoryBindings,
        workspaces,
        references: inventoried.references,
        retained: inventoried.retained,
        activity: inventoried.activity,
      };
      const verdict = assessProjectDeletePreviewConfirmability({
        projectStatus: inventoried.projectStatus,
        pagination: { complete: paginationComplete, nextCursor },
        inventoryComplete: inventoried.complete,
        summary,
        expiresAtUtcMs,
      }, observedAtUtcMs);
      return { inventory: inventoried, page: {
        schemaVersion: 1 as const,
        projectId: inventoried.projectId,
        projectRevision: inventoried.projectRevision,
        projectStatus: inventoried.projectStatus,
        previewDigest,
        observedAtUtcMs,
        expiresAtUtcMs,
        policy: PROJECT_DELETE_POLICY,
        summary,
        entries: pageEntries,
        pagination: { complete: paginationComplete, nextCursor },
        inventoryComplete: inventoried.complete,
        inventoryReasons: [...inventoried.reasons],
        blockers: verdict.blockers,
        confirmable: verdict.confirmable,
      } };
  }
}