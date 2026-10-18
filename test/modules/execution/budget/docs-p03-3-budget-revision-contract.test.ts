import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_CAPABILITIES, COMMAND_OPERATION_SPECS, COMMAND_OPERATIONS } from '../../../../packages/core/src/ports/commands.ts';
import {
  BATCH_BUDGET_REVISION_REASON_MAX_BYTES,
  EXECUTION_BUDGET_REVISED_EVENT_TYPE,
  EXECUTION_EVENT_TYPES,
} from '../../../../packages/core/src/ports/execution-store.ts';
import { PUBLIC_STATE_EVENT_TYPES } from '../../../../packages/core/src/ports/events.ts';
import { STATE_EVENT_TYPE_SPECS } from '../../../../packages/core/src/ports/events.ts';
import { evaluateBatchBudgetRevision } from '../../../../packages/core/src/ports/execution-budget.ts';
import { APPLICATION_COMMAND_CAPABILITIES } from '../../../../packages/host/src/contract/lifecycle.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const doc = read('docs/p03-3-budget-revision-contract.md');

describe('F-009 budget revision contract', () => {
  it('registers the contract doc and freezes the command/capability/event surfaces', () => {
    expect(read('README.md')).toContain('p03-3-budget-revision-contract.md');
    expect(COMMAND_OPERATIONS).toContain('execution.budget.revise');
    expect(APP_CAPABILITIES).toContain('execution.budget.revise');
    expect(COMMAND_OPERATION_SPECS['execution.budget.revise']).toEqual({
      scopeKind: 'project',
      mutation: 'update',
      capability: 'execution.budget.revise',
    });
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(EXECUTION_BUDGET_REVISED_EVENT_TYPE);
    expect(STATE_EVENT_TYPE_SPECS[EXECUTION_BUDGET_REVISED_EVENT_TYPE]).toEqual({
      aggregateType: 'execution_batch',
      scopeKind: 'project',
      payloadKind: 'executionBudgetRevised',
    });
    // Host 接线宣告与 Core 白名单同步（不漂移）。
    expect([...APPLICATION_COMMAND_CAPABILITIES]).toEqual([...COMMAND_OPERATIONS]);
    // 本 Feature 不新增迁移（v9 既有三列/修订表承担；历史迁移不变）。
    for (const word of ['本 Feature 不新增迁移', '历史 v1..v13 SQL/checksum 不变']) {
      expect(doc).toContain(word);
    }
  });

  it('documents the frozen payload, CAS semantics and rejected reasons', () => {
    for (const word of [
      'batchId',
      'expectedRevision',
      'budget_revision',
      'approvedBy=principalId',
      'deadline_passed',
      'budget_revision_stale',
      'batch_not_active',
      'revision_not_increased',
      'limit_below_used',
      String(BATCH_BUDGET_REVISION_REASON_MAX_BYTES),
      '仅增额不自动启动或恢复 Run',
      '失败无部分更新',
      '累计计数不清零',
      'previous',
      'revised',
      'requestDigest',
    ]) {
      expect(doc).toContain(word);
    }
    // 执行域事件白名单（Run 派发、预算修订与 Task 原子认领）。
    expect([...EXECUTION_EVENT_TYPES]).toEqual([
      'execution.run.dispatched',
      'execution.budget.revised',
      'execution.run.paused',
      'execution.batch.paused',
      'execution.run.cancelling',
      'execution.run.cancelled',
      'execution.batch.cancelling',
      'execution.batch.cancelled',
      'execution.run.resumed',
      'execution.batch.resumed',
      'task.claimed',
      'task.attempt.updated',
      'task.approval.blocked',
      'task.approval.decided',
      'feature.finalized',
      'feature.finalization_blocked',
    ]);
  });

  it('keeps monotonic increase-or-extend semantics and the task-cap single channel', () => {
    expect(
      evaluateBatchBudgetRevision({
        current: { schemaVersion: 1, batch: { maxRuns: 2, maxTotalAttempts: 8, maxRuntimeStarts: 8, maxNoProgressRuns: 2, deadlineUtcMs: 2_000 }, run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 } },
        proposed: { schemaVersion: 1, batch: { maxRuns: 1, maxTotalAttempts: 8, maxRuntimeStarts: 8, maxNoProgressRuns: 2, deadlineUtcMs: 2_000 }, run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 } },
      }).allowed,
    ).toBe(false);
    for (const word of [
      'task.strategy.update',
      '不追溯',
      '换 Run 不清',
      'active_execution_inputs',
      '不可中途引入或移除',
    ]) {
      expect(doc).toContain(word);
    }
  });
});
