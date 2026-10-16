import { createHash } from 'node:crypto';
import type { ExecutionRetentionInput } from './execution-supervision.js';
import type { WorkspaceOperationAccess } from '../ports/workspace.js';
import type { createWorkspaceRetentionService } from './workspace-retention.js';

/** Connects supervised finalization to the existing, fenced retention/release transaction. */
export function createExecutionWorkspaceRetainer(options: {
  readonly workspaces: Pick<WorkspaceOperationAccess, 'readWorkspace'>;
  readonly retention: ReturnType<typeof createWorkspaceRetentionService>;
}): (input: ExecutionRetentionInput) => Promise<void> {
  return async ({ identity, runId, taskId, featureId, reason, evidenceRef }) => {
    const workspace = options.workspaces.readWorkspace(identity.projectId, featureId);
    if (!workspace) throw new Error('managed_workspace_missing');
    const digest = createHash('sha256').update(JSON.stringify([
      'execution-retention', identity.projectId, identity.attemptId, identity.executionVersion,
    ])).digest('hex');
    const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const result = await options.retention.retain({ identity, taskId, runId,
      workspaceId: workspace.id, operationId, expectedWorkspaceRevision: workspace.revision, reason, evidenceRefs: [evidenceRef] });
    if (result.operation.status !== 'succeeded' || result.workspace.status !== 'retained') throw new Error('workspace_retention_incomplete');
  };
}
