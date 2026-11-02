import { describe, expect, it } from 'vitest';
import {
  P08_TODO_LIVE_STAGE_ORDER,
  acceptanceExitCode,
  runTodoLiveAcceptance,
  validateTodoLiveAcceptanceReport,
  type TodoLiveAcceptanceStageOutcome,
} from '../../../scripts/acceptance/p08-todo-live-entry.ts';

const base = {
  repository: '/tmp/shiploop-todo-repository',
  reportDirectory: '/tmp/shiploop-todo-evidence',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  nodeVersion: '22.19.0',
  npmVersion: '10.9.3',
  platform: 'darwin',
  budgets: { taskTimeoutMs: 600_000, totalTimeoutMs: 1_800_000, maxTasks: 3 },
};

function outcome(stage: (typeof P08_TODO_LIVE_STAGE_ORDER)[number], status: TodoLiveAcceptanceStageOutcome['status']): TodoLiveAcceptanceStageOutcome {
  return { id: stage, status, exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null,
    command: [`stage:${stage}`], evidenceRefs: [`evidence/${stage}.json`], ...(status === 'passed' ? {} : { reason: `${status}_fixture` }) };
}

describe('P08-2 F-009 accept:p08:live 入口编排', () => {
  it('[case:p08-2-f009-fixed-order] 按固定顺序运行五个场景并记录阶段退出码与证据引用', async () => {
    const calls: string[] = [];
    const report = await runTodoLiveAcceptance({ ...base,
      runStage: async stage => { calls.push(stage); return outcome(stage, 'passed'); },
    });
    expect(calls).toEqual([...P08_TODO_LIVE_STAGE_ORDER]);
    expect(report.stages.map(stage => stage.id)).toEqual([...P08_TODO_LIVE_STAGE_ORDER]);
    expect(report.stages.every(stage => stage.exitCode === 0 && stage.evidenceRefs.length > 0)).toBe(true);
    expect(report.manualPending.map(item => item.id)).toEqual([
      'todo-coverage', 'real-model-participation', 'commit-report-identity', 'sensitive-boundary', 'owner-signature',
    ]);
    expect(report.status).toBe('inconclusive');
    expect(acceptanceExitCode(report.status)).toBe(3);
    expect(() => validateTodoLiveAcceptanceReport(report)).not.toThrow();
  });

  it('[case:p08-2-f009-status-exit-mapping] failed、not_run 与人工待确认不会被折算成通过', async () => {
    const report = await runTodoLiveAcceptance({ ...base,
      runStage: async stage => outcome(stage, stage === 'negative-fixtures' ? 'failed' : stage === 'report-validation' ? 'not_run' : 'passed'),
    });
    expect(report.status).toBe('failed');
    expect(acceptanceExitCode(report.status)).toBe(1);
    const notRun = await runTodoLiveAcceptance({ ...base,
      runStage: async stage => outcome(stage, 'not_run'),
    });
    expect(notRun.status).toBe('not_run');
    expect(acceptanceExitCode(notRun.status)).toBe(2);
    expect(notRun.stages.every(stage => stage.status === 'not_run')).toBe(true);
  });

  it('[case:p08-2-f009-report-hygiene] 报告绑定代码与工具事实且拒绝绝对路径或凭据键', async () => {
    const report = await runTodoLiveAcceptance({ ...base,
      runStage: async stage => outcome(stage, 'not_run'),
    });
    expect(JSON.stringify(report)).not.toContain(base.repository);
    expect(JSON.stringify(report)).not.toContain(base.reportDirectory);
    expect(JSON.stringify(report)).not.toContain('token');
    expect(report.code).toEqual({ headCommit: base.commit, headTree: base.tree });
    expect(report.environment).toEqual({ nodeVersion: base.nodeVersion, npmVersion: base.npmVersion, platform: base.platform });
    expect(() => validateTodoLiveAcceptanceReport(report)).not.toThrow();
  });
});
