import { StorageError } from '../../ports/errors.js';
import type { FeatureDagInput, FeatureDagStore } from '../../ports/feature-dag.js';
import { featureDagEdgeEvidenceKey } from '../../ports/feature-dag.js';
import { validateStableId } from '../../ports/validation.js';
import { readFeatureDagIntegrationEvidenceInView } from './feature-dag-integration-projection.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'FeatureDagStore.read';

interface FeatureRow {
  readonly id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly status: string;
  readonly revision: number;
}

interface DependencyRow {
  readonly id: string;
  readonly project_id: string;
  readonly phase_id: string;
  readonly feature_id: string;
  readonly depends_on_id: string;
  readonly code_baseline_ref: string | null;
  readonly revision: number;
}

/**
 * P05-4 的 Feature DAG 一致读适配器（P07 DAG / F-004 扩展）。
 *
 * 在单一 DEFERRED 读事务内读取 Feature/依赖边和权威 integration plan，并投影
 * 边级/节点级集成证据：边集、Feature revision、integration plan revision 与证据
 * 摘要在同一一致读视图中核对；跨项目/跨 Phase/损坏 JSON fail-closed。证据只来自
 * 已冻结的计划事实（固定 integrationId、交付 commit、目标基线与摘要），不从分支名、
 * 当前 HEAD 或完成先后推导，也不把 delivery_status 或 Task 通过推断成代码集成证据。
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
          'SELECT id, project_id, phase_id, status, revision FROM features WHERE project_id = ? AND phase_id = ? ORDER BY id',
        ).all(projectId, phaseId);
        if (features.some(feature => feature.project_id !== projectId || feature.phase_id !== phaseId)) {
          throw new StorageError('corrupt', OPERATION, 'Feature DAG contains an ownership mismatch', {
            details: { reason: 'cross_project_or_phase_feature' },
          });
        }
        const featureIds = new Set(features.map(feature => feature.id));
        const dependencies = db.prepare<[string, string], DependencyRow>(
          'SELECT id, project_id, phase_id, feature_id, depends_on_id, code_baseline_ref, revision ' +
            'FROM feature_dependencies WHERE project_id = ? AND phase_id = ? ORDER BY feature_id, depends_on_id',
        ).all(projectId, phaseId);
        if (dependencies.some(edge => edge.project_id !== projectId || edge.phase_id !== phaseId
          || !featureIds.has(edge.feature_id) || !featureIds.has(edge.depends_on_id))) {
          throw new StorageError('corrupt', OPERATION, 'Feature DAG contains an invalid dependency projection', {
            details: { reason: 'invalid_dependency_projection' },
          });
        }
        const evidence = readFeatureDagIntegrationEvidenceInView(db, {
          projectId, phaseId, operation: OPERATION, featureIds,
          edges: dependencies.map(edge => ({ featureId: edge.feature_id, dependsOnId: edge.depends_on_id })),
        });
        return {
          projectId,
          phaseId,
          features: features.map(feature => ({
            id: feature.id,
            projectId: feature.project_id,
            phaseId: feature.phase_id,
            status: feature.status,
            revision: feature.revision,
            // 集成证据只由权威 integration plan 投影；缺失即 fail-closed 为 null。
            integrationEvidence: evidence.nodeEvidence.get(feature.id) ?? null,
          })),
          existingEdges: dependencies.map(edge => ({
            id: edge.id,
            projectId: edge.project_id,
            phaseId: edge.phase_id,
            featureId: edge.feature_id,
            dependsOnId: edge.depends_on_id,
            codeBaselineRef: edge.code_baseline_ref,
            revision: edge.revision,
            integrationEvidence: evidence.edgeEvidence.get(featureDagEdgeEvidenceKey(edge.feature_id, edge.depends_on_id)) ?? null,
          })),
        };
      });
    },
  };
}
