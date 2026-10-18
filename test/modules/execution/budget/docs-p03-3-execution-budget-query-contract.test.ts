import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_BUDGET_BLOCK_REASONS,
  EXECUTION_BUDGET_GET_OPERATION,
  EXECUTION_BUDGET_QUERY_OPERATIONS,
  EXECUTION_BUDGET_REVISIONS_OPERATION,
} from '../../../../packages/core/src/ports/execution-budget-query.ts';
import {
  createPlanListCursorBinding,
  decodePlanListCursor,
  encodePlanListCursor,
} from '../../../../packages/core/src/ports/queries.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const doc = read('docs/p03-3-execution-budget-query-contract.md');

describe('F-010 execution budget query contract', () => {
  it('registers the contract doc and freezes the query operation/reason surfaces', () => {
    expect(read('README.md')).toContain('p03-3-execution-budget-query-contract.md');
    expect([...EXECUTION_BUDGET_QUERY_OPERATIONS]).toEqual([
      'execution.budget.get',
      'execution.budget.revisions',
    ]);
    expect(EXECUTION_BUDGET_GET_OPERATION).toBe('execution.budget.get');
    expect(EXECUTION_BUDGET_REVISIONS_OPERATION).toBe('execution.budget.revisions');
    expect([...EXECUTION_BUDGET_BLOCK_REASONS]).toEqual([
      'counter_exhausted',
      'deadline_reached',
      'resource_exhausted',
      'code_attempts_exhausted',
      'budget_exhausted',
      'scheduler_not_assembled',
      'runtime_not_found',
    ]);
    for (const word of [
      '本 Feature 不新增迁移',
      '历史 v1..v13 SQL/checksum 不变',
      'project.read',
      'execution_entity_not_found',
      'invalid_cursor',
      'unconfirmedDimensions',
      'runtimeStartsReserved',
      'scheduler_not_assembled',
      'accepted/queued 不显示为验收成功',
      '不填零',
      '绝对路径',
    ]) {
      expect(doc).toContain(word);
    }
  });

  it('keeps the bounded pagination rules and binds revision cursors to project + batch', () => {
    for (const word of ['默认 50 / 上限 200', 'plcur_v1_', 'version=1', 'nextCursor']) {
      expect(doc).toContain(word);
    }
    const binding = createPlanListCursorBinding({
      rootIdentity: 'a'.repeat(64),
      scope: { kind: 'budget-revisions', projectId: 'proj-1', batchId: 'batch-1' },
    });
    const cursor = encodePlanListCursor('rev-1', binding);
    expect(decodePlanListCursor(cursor, binding).lastId).toBe('rev-1');
    // 跨批次/跨项目游标重放一律 invalid_cursor（指纹绑定 Batch + 项目）。
    for (const scope of [
      { kind: 'budget-revisions', projectId: 'proj-1', batchId: 'batch-2' },
      { kind: 'budget-revisions', projectId: 'proj-2', batchId: 'batch-1' },
    ] as const) {
      const other = createPlanListCursorBinding({ rootIdentity: 'a'.repeat(64), scope });
      let thrown: unknown;
      try {
        decodePlanListCursor(cursor, other);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    }
    // 既有计划层级指纹公式不变（同输入游标往返仍成立）。
    const phases = createPlanListCursorBinding({
      rootIdentity: 'a'.repeat(64),
      scope: { kind: 'phases', projectId: 'proj-1' },
    });
    expect(decodePlanListCursor(encodePlanListCursor('phase-1', phases), phases).lastId).toBe('phase-1');
  });
});
