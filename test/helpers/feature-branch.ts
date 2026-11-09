import type { SqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';

export function readFeatureBranch(session: SqliteStorageSession, projectId: string, featureId: string): string {
  const feature = session.database.prepare<[string, string], { branch_name: string | null }>(
    'SELECT branch_name FROM features WHERE project_id=? AND id=?').get(projectId, featureId);
  if (!feature?.branch_name) throw new Error('fixture_feature_branch_missing');
  return feature.branch_name;
}
