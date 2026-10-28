import { validateBrownfieldMovePreview, type BrownfieldMovePreview } from 'shiploop-core';
import type { AppCliCommand, AppCliCommandId, AppCliParseError } from './args.js';
import { AppCliParseError as AppCliParseErrorClass } from './args.js';

export interface RepositoryMoveInputContext {
  readonly command: AppCliCommand;
  readonly commandId?: AppCliCommandId | null;
  readonly json?: boolean;
}

function previewFileError(
  context: RepositoryMoveInputContext,
  reason: 'invalid_preview_file',
): AppCliParseError {
  return new AppCliParseErrorClass(
    'invalid_input',
    reason,
    {
      command: context.command,
      commandId: context.commandId ?? null,
      json: context.json ?? false,
    },
    'preview-file',
  );
}

export function parseRepositoryMovePreviewDocument(
  payload: Record<string, unknown>,
  context: RepositoryMoveInputContext,
  projectId: string,
): BrownfieldMovePreview {
  try {
    const preview = validateBrownfieldMovePreview(payload);
    if (preview.projectId !== projectId) {
      throw previewFileError(context, 'invalid_preview_file');
    }
    return preview;
  } catch (error) {
    if (error instanceof AppCliParseErrorClass) throw error;
    throw previewFileError(context, 'invalid_preview_file');
  }
}

function headText(headCommit: string | null): string {
  return headCommit === null ? '无 HEAD（尚无初始 commit）' : headCommit;
}

export function formatRepositoryMovePreview(preview: BrownfieldMovePreview): string {
  const dirty = preview.newRepository.hasUncommittedChanges
    ? '有未提交改动（原样保留）'
    : '干净';
  const identity = preview.identityRelation === 'same' ? '相同（仍需确认）' : '不同';
  return [
    'project repository move 预览（只读；尚未更新绑定）：',
    `  projectId=${preview.projectId}`,
    `  旧路径=${preview.oldBinding.canonicalPath}`,
    `  新路径=${preview.newRepository.canonicalPath}`,
    `  旧 repoIdentity=${preview.oldBinding.repoIdentity}`,
    `  新 repoIdentity=${preview.newRepository.repoIdentity}`,
    `  身份关系=${identity}`,
    `  新仓库 HEAD=${headText(preview.newRepository.headCommit)}`,
    `  新仓库工作区=${dirty}`,
    `  previewDigest=${preview.previewDigest}`,
    '  风险：必须显式确认；不会按 remote 自动选择或合并项目；不会 stash/reset/提交文件。',
    '  确认：使用同一 previewDigest、目标和 projectId 的 --preview-file，并显式提供 --confirm。',
    '',
  ].join('\n');
}

export function formatRepositoryMoveConfirmation(receipt: {
  readonly status: string;
  readonly commandId: string;
  readonly result?: unknown;
}): string {
  const result = receipt.result as {
    project?: { id?: unknown };
    previousBinding?: { canonicalPath?: unknown; repoIdentity?: unknown };
    binding?: { canonicalPath?: unknown; repoIdentity?: unknown };
  } | undefined;
  return [
    'project repository move 确认结果：',
    `  status=${receipt.status}`,
    `  commandId=${receipt.commandId}`,
    `  projectId=${String(result?.project?.id ?? 'unknown')}`,
    `  旧身份=${String(result?.previousBinding?.repoIdentity ?? 'unknown')} path=${String(result?.previousBinding?.canonicalPath ?? 'unknown')}`,
    `  新身份=${String(result?.binding?.repoIdentity ?? 'unknown')} path=${String(result?.binding?.canonicalPath ?? 'unknown')}`,
    '  原仓库文件与历史检查不会由移动确认改写；健康状态需另行基线检查。',
    '',
  ].join('\n');
}
