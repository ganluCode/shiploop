import { describe, expect, it } from 'vitest';
import {
  runTodoLiveDelivery,
  validateTodoLiveReport,
  type TodoLiveDeliveryPorts,
  type TodoLiveTask,
} from '../../../scripts/acceptance/p08-todo-live.ts';

const tasks: TodoLiveTask[] = [
  { id: 'F-001', title: '创建 Todo 数据层', dependsOn: [] },
  { id: 'F-002', title: '实现 Todo 命令', dependsOn: ['F-001'] },
  { id: 'F-003', title: '补齐 Todo 验证', dependsOn: ['F-002'] },
];

function ports(overrides: Partial<TodoLiveDeliveryPorts> = {}): TodoLiveDeliveryPorts {
  let sequence = 0;
  return {
    runTask: async task => ({
      executionMode: 'live', status: 'completed', taskId: task.id,
      attemptId: `attempt-${task.id}`, provider: 'authorized-provider', model: 'authorized-model',
      realCalls: 1,
    }),
    verifyTask: async task => ({
      status: 'passed', taskId: task.id, exitCode: 0,
      command: ['node', `verify-${task.id}.mjs`], evidenceRef: `checks/${task.id}.json`,
    }),
    commitTask: async task => ({
      status: 'succeeded', taskId: task.id, commitSha: `${String(++sequence).padStart(40, '0')}`,
      treeSha: `${String(sequence).padStart(40, '0')}`, message: `${task.id}: ${task.title}`,
    }),
    saveEvidence: async () => {},
    ...overrides,
  };
}

const authorization = {
  realPi: true as const, provider: 'authorized-provider', model: 'authorized-model',
  expiresAt: Date.now() + 60_000, maxTasks: 3,
};

describe('P08-2 F-004 Todo live 交付编排', () => {
  it('[case:p08-2-f004-dependent-task-gate] 每项 Task 通过真实 Pi 运行、局部检查和提交后才解锁后继', async () => {
    const calls: string[] = [];
    const result = await runTodoLiveDelivery({
      projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
      tasks, authorization, ports: ports({
        runTask: async task => { calls.push(`run:${task.id}`); return {
          executionMode: 'live', status: 'completed', taskId: task.id,
          attemptId: `attempt-${task.id}`, provider: authorization.provider, model: authorization.model, realCalls: 1,
        }; },
        verifyTask: async task => { calls.push(`verify:${task.id}`); return {
          status: 'passed', taskId: task.id, exitCode: 0,
          command: ['node', 'verify.mjs'], evidenceRef: `checks/${task.id}.json`,
        }; },
        commitTask: async task => { calls.push(`commit:${task.id}`); return {
          status: 'succeeded', taskId: task.id, commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40),
          message: `${task.id}: ${task.title}`,
        }; },
      }),
    });
    expect(result.status).toBe('passed');
    expect(result.taskResults.map(item => item.status)).toEqual(['passed', 'passed', 'passed']);
    expect(calls).toEqual([
      'run:F-001', 'verify:F-001', 'commit:F-001',
      'run:F-002', 'verify:F-002', 'commit:F-002',
      'run:F-003', 'verify:F-003', 'commit:F-003',
    ]);
    expect(result.taskResults.every(item => item.commit?.commitSha === 'a'.repeat(40))).toBe(true);
    expect(validateTodoLiveReport(result)).toEqual(result);
  });

  it('[case:p08-2-f004-runtime-mode-gate] Fake 或非 live Runtime 不得解锁后继', async () => {
    const runTask = async (task: TodoLiveTask) => ({
      executionMode: 'fake' as const, status: 'completed' as const, taskId: task.id,
      attemptId: `attempt-${task.id}`, provider: authorization.provider, model: authorization.model, realCalls: 0,
    });
    const result = await runTodoLiveDelivery({ projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
      tasks, authorization, ports: ports({ runTask }) });
    expect(result.status).toBe('failed');
    expect(result.taskResults[0]).toMatchObject({ status: 'failed', reason: 'runtime_not_live' });
    expect(result.taskResults.slice(1).every(item => item.status === 'skipped')).toBe(true);
  });

  it('[case:p08-2-f004-verification-failure-gate] Runtime 完成但检查失败时保留失败证据且不提交/不运行后继', async () => {
    const commits: string[] = [];
    const result = await runTodoLiveDelivery({ projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
      tasks, authorization, ports: ports({
        verifyTask: async task => ({ status: task.id === 'F-001' ? 'failed' : 'passed', taskId: task.id,
          exitCode: 1, command: ['node', 'verify.mjs'], evidenceRef: 'checks/F-001.json', reason: 'assertion_failed' }),
        commitTask: async task => { commits.push(task.id); return {
          status: 'succeeded', taskId: task.id, commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), message: task.title,
        }; },
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.taskResults[0]).toMatchObject({ status: 'failed', reason: 'verification_failed', verification: { status: 'failed' } });
    expect(result.taskResults.slice(1).every(item => item.status === 'skipped')).toBe(true);
    expect(commits).toEqual([]);
  });

  it('[case:p08-2-f004-commit-evidence-gate] 缺 commit/tree 或证据保存失败时不报告通过', async () => {
    const result = await runTodoLiveDelivery({ projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
      tasks, authorization, ports: ports({
        commitTask: async task => ({ status: 'succeeded', taskId: task.id, commitSha: null, treeSha: null, message: task.title }),
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.taskResults[0]).toMatchObject({ status: 'failed', reason: 'commit_evidence_missing' });
    expect(result.taskResults.slice(1).every(item => item.status === 'skipped')).toBe(true);
  });
});
