import type {
  EntityLabelQueryReadStore, EntityLabelSelector, EntityLabelFilter, PublicLabelRunRecord,
} from '../../ports/entity-label-query.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import { validateStableId } from '../../ports/validation.js';
import { visibilityCondition } from './state-store.js';
import { entityLabelCondition } from './entity-label-condition.js';
import { parseStoredRunLabels } from './run-labels.js';
import type { SqliteStorageSession } from './session.js';

const TABLES = { phase: 'phases', feature: 'features', task: 'tasks', run: 'runs' } as const;

/** All visibility, ownership and label predicates precede LIMIT/GROUP BY in SQLite. */
export function createSqliteEntityLabelQueryStore(session: SqliteStorageSession): EntityLabelQueryReadStore {
  function predicate(visibility: unknown, selector: EntityLabelSelector, filter: EntityLabelFilter) {
    if (!session.isOpen()) throw new TypeError('labels.query: session closed');
    if (session.database.inTransaction) throw new TypeError('labels.query: must not nest in write transaction');
    assertPrincipalVisibility(visibility);
    if (!Object.hasOwn(TABLES, selector.entity)) throw new TypeError('labels.query: invalid entity');
    const table = TABLES[selector.entity];
    const conditions = ['e.project_id = ?'];
    const params: unknown[] = [validateStableId(selector.projectId, { operation: 'labels.query' }, 'projectId')];
    const visible = visibilityCondition(visibility, 'e.project_id');
    if (visible.condition !== undefined) { conditions.push(visible.condition); params.push(...visible.params); }
    if (selector.entity === 'task') conditions.push("e.kind = 'coding'");
    for (const [field, column, allowed] of [
      ['phaseId', 'phase_id', selector.entity === 'feature'],
      ['featureId', 'feature_id', selector.entity === 'task' || selector.entity === 'run'],
      ['batchId', 'batch_id', selector.entity === 'run'],
    ] as const) {
      if (selector[field] === undefined) continue;
      if (!allowed) throw new TypeError('labels.query: invalid parent for entity');
      conditions.push(`e.${column} = ?`);
      params.push(validateStableId(selector[field], { operation: 'labels.query' }, field));
    }
    const labels = entityLabelCondition('e.labels', filter);
    conditions.push(labels.condition); params.push(...labels.params);
    return { table, where: conditions.join(' AND '), params };
  }
  return {
    countEntityLabels(visibility, selector, filter) {
      const { table, where, params } = predicate(visibility, selector, filter);
      return session.database.prepare<unknown[], { label: string; count: number }>(
        `SELECT l.value AS label, COUNT(DISTINCT e.id) AS count FROM ${table} e, json_each(e.labels) l ` +
        `WHERE ${where} GROUP BY l.value ORDER BY l.value`,
      ).all(...params);
    },
    listLabelRunRecords(visibility, selector, request) {
      if (selector.entity !== 'run') throw new TypeError('labels.query: expected run selector');
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200) throw new TypeError('labels.query: invalid limit');
      if (request.afterId !== null) validateStableId(request.afterId, { operation: 'runs.list' }, 'afterId');
      const { table, where, params } = predicate(visibility, selector, request);
      const rows = session.database.prepare<unknown[], {
        id: string; project_id: string; feature_id: string; batch_id: string; labels: string;
        status: string; purpose: string; revision: number; created_at: number; updated_at: number;
      }>(`SELECT e.id, e.project_id, e.feature_id, e.batch_id, e.labels, e.status, e.purpose, e.revision, e.created_at, e.updated_at ` +
        `FROM ${table} e WHERE ${where} AND e.id > ? ORDER BY e.id LIMIT ?`).all(...params, request.afterId ?? '', request.limit + 1);
      const records: PublicLabelRunRecord[] = rows.slice(0, request.limit).map(row => ({
        id: row.id, projectId: row.project_id, featureId: row.feature_id, batchId: row.batch_id,
        labels: parseStoredRunLabels(row.labels, 'runs.list'), status: row.status, purpose: row.purpose,
        revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      }));
      return { records, nextId: rows.length > request.limit ? records.at(-1)!.id : null };
    },
  };
}
