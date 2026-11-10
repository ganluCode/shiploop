/**
 * P08 / F-013 DAG 交付展示上下文只读窄端口的 SQLite 装配（adapters 层）。
 *
 * 事实来源：features/phases 持久行 + entity_display_codes 展示别名（display-only，
 * 创建期固化；tombstone 后缺失保持 null）。全部读取以 BEGIN DEFERRED 一致读
 * 事务执行（已处于读事务内时直接复用，避免嵌套 BEGIN）；本模块无任何写原语。
 *
 * 跨项目/不存在 Feature 统一 undefined（存在性折叠由应用层完成）；批量读取
 * 有界（超限 validation 拒绝）；持久行损坏 fail-closed（corrupt），不泄漏原始内容。
 */
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import {
  DELIVERY_DISPLAY_CONTEXT_BATCH_LIMIT,
  type DeliveryDisplayContextReadStore,
  type PublicDeliveryEntityDisplay,
} from '../../ports/delivery-display-context.js';
import { isDeliveryDisplayCodeShape } from '../../ports/delivery-display-context.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'DeliveryDisplayContextStore';

interface DisplaySqlRow {
  feature_id: string;
  feature_title: string;
  branch_name: string | null;
  phase_id: string;
  phase_title: string;
  feature_code: string | null;
  phase_code: string | null;
}

const DISPLAY_COLUMNS = `f.id AS feature_id, f.title AS feature_title, f.branch_name AS branch_name,
  f.phase_id AS phase_id, p.title AS phase_title,
  fc.code AS feature_code, pc.code AS phase_code`;

const DISPLAY_FROM = `FROM features f
  JOIN phases p ON p.project_id = f.project_id AND p.id = f.phase_id
  LEFT JOIN entity_display_codes fc ON fc.project_id = f.project_id AND fc.entity_kind = 'feature' AND fc.entity_id = f.id
  LEFT JOIN entity_display_codes pc ON pc.project_id = p.project_id AND pc.entity_kind = 'phase' AND pc.entity_id = p.id`;

function requireTitle(operation: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new StorageError('corrupt', operation, `${field} 展示标题损坏`);
  }
  return value;
}

function nullableCode(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  if (!isDeliveryDisplayCodeShape(value)) {
    throw new StorageError('corrupt', operation, `${field} 展示编码损坏`, {
      details: { reason: 'invalid_display_code' },
    });
  }
  return value;
}

function nullableBranch(operation: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 255
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.includes('..') || value.includes('@{')) {
    throw new StorageError('corrupt', operation, 'branchName 展示事实损坏', {
      details: { reason: 'invalid_branch_name' },
    });
  }
  return value;
}

function rowToDisplay(operation: string, row: DisplaySqlRow): PublicDeliveryEntityDisplay {
  return {
    featureId: row.feature_id,
    displayCode: nullableCode(operation, row.feature_code, 'feature'),
    title: requireTitle(operation, row.feature_title, 'feature'),
    branchName: nullableBranch(operation, row.branch_name),
    phaseId: row.phase_id,
    phaseDisplayCode: nullableCode(operation, row.phase_code, 'phase'),
    phaseTitle: requireTitle(operation, row.phase_title, 'phase'),
  };
}

/** SQLite 装配：只读展示上下文（同事务可复用；身份校验 fail-closed）。 */
export function createSqliteDeliveryDisplayContextStore(
  session: SqliteStorageSession,
): DeliveryDisplayContextReadStore {
  if (session === null || typeof session !== 'object' || typeof session.isOpen !== 'function') {
    throw new TypeError('createSqliteDeliveryDisplayContextStore: session 必须是 SqliteStorageSession');
  }
  const context: ValidationContext = { operation: OPERATION };

  function readRow(db: SqliteStorageSession['database'], projectId: string, featureId: string): PublicDeliveryEntityDisplay | undefined {
    const row = db
      .prepare<[string, string], DisplaySqlRow>(
        `SELECT ${DISPLAY_COLUMNS} ${DISPLAY_FROM} WHERE f.project_id = ? AND f.id = ?`,
      )
      .get(projectId, featureId);
    return row === undefined ? undefined : rowToDisplay(OPERATION, row);
  }

  return {
    readFeatureDeliveryDisplay(projectId: unknown, featureId: unknown): PublicDeliveryEntityDisplay | undefined {
      const validProjectId = validateStableId(projectId, context, 'projectId');
      const validFeatureId = validateStableId(featureId, context, 'featureId');
      const assemble = (): PublicDeliveryEntityDisplay | undefined =>
        readRow(session.database, validProjectId, validFeatureId);
      return session.database.inTransaction
        ? assemble()
        : transactSqliteConsistentRead(session, OPERATION, assemble);
    },
    listFeatureDeliveryDisplays(
      projectId: unknown,
      featureIds: readonly unknown[],
    ): ReadonlyMap<string, PublicDeliveryEntityDisplay> {
      const validProjectId = validateStableId(projectId, context, 'projectId');
      if (!Array.isArray(featureIds) || featureIds.length === 0) {
        throw new StorageError('validation', OPERATION, 'featureIds 必须是非空数组');
      }
      if (featureIds.length > DELIVERY_DISPLAY_CONTEXT_BATCH_LIMIT) {
        throw new StorageError('validation', OPERATION, `featureIds 超过批量上限 ${DELIVERY_DISPLAY_CONTEXT_BATCH_LIMIT}`, {
          details: { reason: 'display_batch_out_of_range', count: featureIds.length },
        });
      }
      const validIds = featureIds.map(id => validateStableId(id, context, 'featureIds'));
      const assemble = (): ReadonlyMap<string, PublicDeliveryEntityDisplay> => {
        const output = new Map<string, PublicDeliveryEntityDisplay>();
        for (const id of validIds) {
          const display = readRow(session.database, validProjectId, id);
          if (display !== undefined) output.set(id, display);
        }
        return output;
      };
      return session.database.inTransaction
        ? assemble()
        : transactSqliteConsistentRead(session, OPERATION, assemble);
    },
  };
}
