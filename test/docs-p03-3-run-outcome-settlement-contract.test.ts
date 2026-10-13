import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { APP_CAPABILITIES, COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';
import { RUN_OUTCOME_SETTLEMENT_OUTCOMES, RUN_PROGRESS_EVIDENCE_TYPES } from '../packages/core/src/ports/execution-store.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const doc = read('docs/p03-3-run-outcome-settlement-contract.md');

describe('F-008 Run outcome settlement contract', () => {
  it('registers v13, immutable evidence and first-pass provenance', () => {
    expect(read('README.md')).toContain('p03-3-run-outcome-settlement-contract.md');
    const migration = SQLITE_MIGRATIONS.find((item) => item.version === 13)!;
    expect(migration.sql).toContain('CREATE TABLE run_outcome_settlements');
    expect(migration.sql).toContain('ALTER TABLE tasks ADD COLUMN first_passed_at');
    expect(migration.sql).toContain('run_outcome_settlements_run_id_unique');
    expect(migration.sql).toContain('tasks_first_passed_at_immutable');
    expect(doc).toContain('v13');
    expect(doc).toContain('first_passed_at');
    expect(doc).toContain('历史 v1..v12 SQL/checksum 不变');
  });

  it('documents the actual input, evidence, outcomes and controlled reasons', () => {
    expect(RUN_PROGRESS_EVIDENCE_TYPES).toEqual(['new_valid_task_passed']);
    expect(RUN_OUTCOME_SETTLEMENT_OUTCOMES).toEqual(['succeeded', 'failed', 'cancelled']);
    for (const word of [
      ...RUN_OUTCOME_SETTLEMENT_OUTCOMES, ...RUN_PROGRESS_EVIDENCE_TYPES,
      'settleExecutionRunOutcome', 'getRunOutcomeSettlement', 'progress_evidence_not_verified',
      'result_key_reused', 'run_revision_stale', 'run_already_settled', 'budget_exhausted',
      'maxNoProgressRuns', 'work_key_succeeded', 'trustedFixtureMarkTaskPassed',
      '严格晚于 Run.created_at', '不重置计数', '不自动延期', '不退款',
    ]) expect(doc, word).toContain(word);
  });

  it('keeps settlement outside the client/model command and capability surfaces', () => {
    expect(COMMAND_OPERATIONS.filter((operation) => /settle|outcome|progress/i.test(operation))).toEqual([]);
    expect(APP_CAPABILITIES.filter((capability) => /settle|outcome|progress/i.test(capability))).toEqual([]);
    expect(doc).toContain('不经命令路由暴露');
    expect(doc).toContain('不代替后续 Verifier');
    expect(doc).toContain('不实现 token/cost 用量结算');
  });
});
