import type { SqliteStorageSession } from './session.js';
import { PublicError } from '../../ports/commands.js';
import { requireCapability, requireProjectVisible } from '../../ports/authorization.js';
import type { TrustedPrincipal } from '../../ports/authorization.js';
import {
  computePlanningMigrationPreviewDigest,
  validatePlanningMigrationConfirmPayload,
  type PlanningMigrationConfirmPayload,
  type PlanningMigrationPreview,
} from '../../ports/planning-migration.js';
import type { WorkspaceInspection } from '../../ports/workspace-inspector.js';

interface MigrationOptions {
  readonly session: SqliteStorageSession;
  readonly inspectorFor: (projectId: string) => Promise<{ inspect(baseline: unknown): Promise<WorkspaceInspection> }>;
  readonly nowUtcMs?: () => number;
}

interface ContextRow { id: string; feature_id: string; candidate_id: string; run_id: string; status: string }
interface WorkspaceRow {
  id: string; canonical_path: string; branch: string; base_commit: string; revision: number; status: string;
  repository_binding_id: string; repository_binding_revision: number; repo_identity: string; git_common_dir: string;
  owner_id: string; attempt_id: string; execution_version: number;
}

function conflict(reason: string): never {
  throw new PublicError('conflict', 'planning.migration', undefined, { details: { reason } });
}

export function createSqlitePlanningMigrationService(options: MigrationOptions) {
  const db = options.session.database;
  const now = options.nowUtcMs ?? Date.now;

  async function previewFor(projectId: string, featureId: string): Promise<PlanningMigrationPreview> {
    const feature = db.prepare<[string, string], { revision: number }>('SELECT revision FROM features WHERE project_id=? AND id=?').get(projectId, featureId);
    if (!feature) throw new PublicError('not_found', 'planning.migration.preview', undefined, { details: { entityType: 'feature' } });
    const context = db.prepare<[string, string], ContextRow>(`SELECT id,feature_id,candidate_id,run_id,status
      FROM planning_contexts WHERE project_id=? AND feature_id=? ORDER BY created_at DESC, id DESC LIMIT 1`).get(projectId, featureId);
    if (!context) throw new PublicError('not_found', 'planning.migration.preview', undefined, { details: { entityType: 'planning_context' } });
    const workspace = db.prepare<[string, string], WorkspaceRow>('SELECT * FROM managed_workspaces WHERE project_id=? AND feature_id=? LIMIT 1').get(projectId, featureId);
    if (!workspace) throw new PublicError('not_found', 'planning.migration.preview', undefined, { details: { entityType: 'workspace' } });
    const baseline = {
      repositoryBindingId: workspace.repository_binding_id, repositoryBindingRevision: workspace.repository_binding_revision,
      repoIdentity: workspace.repo_identity, canonicalPath: workspace.canonical_path, gitCommonDir: workspace.git_common_dir,
      branch: workspace.branch, baseCommit: workspace.base_commit,
    };
    let inspection: WorkspaceInspection;
    try { inspection = await (await options.inspectorFor(projectId)).inspect(baseline); }
    catch { conflict('planning_migration_workspace_inspection_failed'); }
    const dirty = inspection.statusPorcelainBase64.length > 0;
    const unfinishedOperations = (db.prepare<[string, string], { id: string }>(`SELECT id FROM workspace_operations
      WHERE project_id=? AND workspace_id=? AND status='pending' ORDER BY id LIMIT 64`).all(projectId, workspace.id)).map(row => row.id);
    const leases = db.prepare<[string, string], { id: string; state: string; owner_id: string; execution_version: number }>(`SELECT id,state,owner_id,execution_version
      FROM workspace_leases WHERE project_id=? AND owner_id=? ORDER BY id LIMIT 16`).all(projectId, workspace.attempt_id)
      .map(row => ({ id: row.id, state: row.state, ownerId: row.owner_id, executionVersion: row.execution_version }));
    const session = db.prepare<[string], { status: string; recording_watermark: number | null; recording_gaps: string | null }>(
      'SELECT status,recording_watermark,recording_gaps FROM sessions WHERE attempt_id=? ORDER BY id DESC LIMIT 1').get(workspace.attempt_id);
    const processStopProof = session?.status === 'stopped' && session.recording_watermark !== null && session.recording_gaps === '[]';
    const blockers: string[] = [];
    if (inspection.repository.headCommit !== workspace.base_commit) blockers.push('workspace_has_commits');
    if (dirty) blockers.push('workspace_dirty');
    if (unfinishedOperations.length > 0) blockers.push('unfinished_workspace_operation');
    if (leases.some(lease => lease.state === 'held')) blockers.push('occupancy_active');
    if (workspace.owner_id !== workspace.attempt_id) blockers.push('workspace_owner_mismatch');
    if (!processStopProof) blockers.push('stop_evidence_missing');
    const observedAtUtcMs = now();
    const withoutDigest = {
      schemaVersion: 1 as const, projectId, featureId, featureRevision: feature.revision,
      context: { contextId: context.id, candidateId: context.candidate_id, runId: context.run_id, status: context.status },
      workspace: { workspaceId: workspace.id, path: workspace.canonical_path, branch: workspace.branch,
        baseCommit: workspace.base_commit, headCommit: inspection.repository.headCommit, revision: workspace.revision, status: workspace.status },
      facts: { dirty, unfinishedOperations, leases, processStopProof: { present: processStopProof, source: session ? 'session' : 'absent' } },
      blockers, observedAtUtcMs,
    };
    return { ...withoutDigest, previewDigest: computePlanningMigrationPreviewDigest(withoutDigest) };
  }

  return {
    async preview(principal: TrustedPrincipal, projectId: string, featureId: string) {
      requireCapability(principal, 'execution.start', 'planning.migration.preview');
      requireProjectVisible(principal, projectId, 'planning.migration.preview');
      return previewFor(projectId, featureId);
    },
    async confirm(input: PlanningMigrationConfirmPayload & { readonly projectId: string; readonly expectedFeatureRevision: number }) {
      const payload = validatePlanningMigrationConfirmPayload({
        featureId: input.featureId, contextId: input.contextId, candidateId: input.candidateId, runId: input.runId,
        targetRole: input.targetRole, workspaceId: input.workspaceId, workspaceRevision: input.workspaceRevision,
        headCommit: input.headCommit, previewDigest: input.previewDigest,
      });
      const preview = await previewFor(input.projectId, payload.featureId);
      if (preview.previewDigest !== payload.previewDigest) conflict('planning_migration_preview_stale');
      if (preview.featureRevision !== input.expectedFeatureRevision) conflict('stale_revision');
      if (preview.workspace.workspaceId !== payload.workspaceId || preview.workspace.revision !== payload.workspaceRevision
        || preview.workspace.headCommit !== payload.headCommit) conflict('planning_migration_workspace_changed');
      if (preview.blockers.length > 0) conflict(preview.blockers[0]!);
      return undefined;
    },
  };
}
