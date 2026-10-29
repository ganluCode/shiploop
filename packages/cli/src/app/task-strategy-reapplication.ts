import type { TaskStrategyReapplicationPreviewWire, TaskStrategyReapplicationResult } from 'shiploop-host';

export function formatTaskStrategyReapplicationPreview(preview: TaskStrategyReapplicationPreviewWire): string {
  const lines = [
    `shiploop task strategy-preview: ${preview.status} project=${preview.identity.projectId} tasks=${preview.items.length} changed=${preview.changedCount}`,
    `previewDigest=${preview.identity.candidateDigest} globalSettingsRevision=${preview.identity.globalSettingsRevision} projectSettingsRevision=${preview.identity.projectSettingsRevision}`,
    ...preview.items.map(item =>
      `task=${item.taskId} feature=${item.featureId} revision=${item.taskRevision} ` +
      `current=${item.current.configSource}/${item.current.configSourceKey} digest=${item.current.digest} ` +
      `candidate=${item.candidate?.configSource ?? null}/${item.candidate?.configSourceKey ?? null} digest=${item.candidate?.digest ?? null} ` +
      `changed=${item.diff?.changed ?? false} fields=${item.diff?.fields.join(',') ?? ''} blocked=${item.reasons.join(',')}`),
    `blockedReasons=${preview.blockedReasons.join(',')}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function formatTaskStrategyReapplicationResult(
  commandId: string,
  replayed: boolean,
  result: TaskStrategyReapplicationResult,
): string {
  return [
    `shiploop task strategy-reapply: completed commandId=${commandId} replayed=${replayed} updatedCount=${result.updatedCount}`,
    ...result.taskRevisions.map(entry => `task=${entry.taskId} revision=${entry.revision}`),
    '策略更新已记录；审批和执行需单独操作。',
    '',
  ].join('\n');
}
