import { StorageError } from '../../ports/errors.js';
import type { FeatureDagInput, FeatureDagStore } from '../../ports/feature-dag.js';
import { validateStableId } from '../../ports/validation.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'FeatureDagStore.read';

interface FeatureRow {
  readonly id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly status: string;
}

interface DependencyRow {
  readonly id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly feature_id: string;
  readonly depends_on_id: string;
  readonly code_baseline_ref: string | null;
}

/**
 * P05-4 的 Feature DAG 一致读适配器。
 *
 * 这里只读取 P05-2 的 Feature/依赖事实并交给统一纯规则评估；没有独立的
 * 调度图状态，也不会把 delivery_status 或 Task 通过推断成代码集成证据。
 * 因此缺少后续集成证据时，依赖候选保持 fail-closed。
 */
export function createSqliteFeatureDagStore(session: SqliteStorageSession): FeatureDagStore {
  return {
    readFeatureDag(project: unknown, phase: unknown): FeatureDagInput {
      const projectId = validateStableId(project, { operation: OPERATION }, 'projectId');
      const phaseId = validateStableId(phase, { operation: OPERATION }, 'phaseId');
      if (!session.isOpen()) throw new StorageError('corrupt', OPERATION, 'Storage session is closed');
      return transactSqliteConsistentRead(session, OPERATION, (db) => {
        const phase = db.prepare<[string, string], { id: string }>(
          'SELECT id FROM phases WHERE project_id = ? AND id = ?',
        ).get(projectId, phaseId);
        if (phase === undefined) {
          throw new StorageError('not_found', OPERATION, 'Feature DAG Phase not found', {
            entity: { type: 'phase', projectId, id: phaseId },
          });
        }
        const features = db.prepare<[string, string], FeatureRow>(
          'SELECT id, project_id, phase_id, status FROM features WHERE project_id = ? AND phase_id = ? ORDER BY id',
        ).all(projectId, phaseId);
        if (features.some(feature => feature.project_id !== projectId || feature.phase_id !== phaseId)) {
          throw new StorageError('corrupt', OPERATION, 'Feature DAG contains an ownership mismatch', {
            details: { reason: 'cross_project_or_phase_feature' },
          });
        }
        const featureIds = new Set(features.map(feature => feature.id));
        const dependencies = db.prepare<[string, string], DependencyRow>(
          'SELECT id, project_id, phase_id, feature_id, depends_on_id, code_baseline_ref ' +
            'FROM feature_dependencies WHERE project_id = ? AND phase_id = ? ORDER BY feature_id, depends_on_id',
        ).all(projectId, phaseId);
        if (dependencies.some(edge => edge.project_id !== projectId || edge.phase_id !== phaseId
          || !featureIds.has(edge.feature_id) || !featureIds.has(edge.depends_on_id))) {
          throw new StorageError('corrupt', OPERATION, 'Feature DAG contains an invalid dependency projection', {
            details: { reason: 'invalid_dependency_projection' },
          });
        }
        return {
          projectId,
          phaseId,
          features: features.map(feature => ({
            id: feature.id,
            projectId: feature.project_id,
            phaseId: feature.phase_id,
            status: feature.status,
            // Integration evidence is a separate P05-6 fact. Do not infer it from status.
            integrationEvidence: null,
          })),
          existingEdges: dependencies.map(edge => ({
            id: edge.id,
            projectId: edge.project_id,
            phaseId: edge.phase_id,
            featureId: edge.feature_id,
            dependsOnId: edge.depends_on_id,
            codeBaselineRef: edge.code_baseline_ref,
          })),
        };
      });
    },
  };
}
