import type { EntityLabelFilter } from '../../ports/entity-label-query.js';
import { validateProjectListFilter } from '../../ports/state-store.js';

/** Shared SQL predicate: no row multiplication, and duplicate stored labels count once. */
export function entityLabelCondition(column: string, filter: Partial<EntityLabelFilter>) {
  const valid = validateProjectListFilter({ labels: filter.labels, match: filter.match }, 'labels.query');
  if (valid.labels.length === 0) return { condition: '1 = 1', params: [] as unknown[] };
  const placeholders = valid.labels.map(() => '?').join(', ');
  return valid.match === 'any'
    ? { condition: `EXISTS (SELECT 1 FROM json_each(${column}) l WHERE l.value IN (${placeholders}))`, params: valid.labels }
    : { condition: `(SELECT COUNT(DISTINCT l.value) FROM json_each(${column}) l WHERE l.value IN (${placeholders})) = ?`,
      params: [...valid.labels, valid.labels.length] };
}
