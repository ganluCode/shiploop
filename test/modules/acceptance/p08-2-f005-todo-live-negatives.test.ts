import { access, readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditTodoLiveNegative,
  runTodoLiveNegativeScenario,
  resumeTodoLiveNegative,
  type TodoLiveNegativeTask,
} from '../../../scripts/acceptance/p08-todo-live-negatives.ts';

const tasks: TodoLiveNegativeTask[] = [
  { id: 'F-001', title: '创建 Todo 数据层', dependsOn: [] },
  { id: 'F-002', title: '实现 Todo 命令', dependsOn: ['F-001'] },
  { id: 'F-003', title: '补齐 Todo 验证', dependsOn: ['F-002'] },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'shiploop-p08-negative-'));
  roots.push(value);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

describe('P08-2 F-005 Todo live 确定性负例夹具', () => {
  it('[case:p08-2-f005-auth-before-claim] 缺认证和未授权在认领前停止且不创建 worktree', async () => {
    const workspaceRoot = await root();
    const missing = await runTodoLiveNegativeScenario({ scenarioId: 'missing-auth', mode: 'missing-authorization', workspaceRoot, tasks });
    const unauthorized = await runTodoLiveNegativeScenario({ scenarioId: 'unauthorized', mode: 'unauthorized', workspaceRoot, tasks });

    expect(missing).toMatchObject({ status: 'not_run', reason: 'authorization_missing', attempts: [], budget: { used: 0 } });
    expect(unauthorized).toMatchObject({ status: 'failed', reason: 'authorization_rejected', attempts: [], budget: { used: 0 } });
    expect(missing.tasks.every(task => task.status === 'not_run')).toBe(true);
    expect(unauthorized.tasks.every(task => task.status === 'not_run')).toBe(true);
    expect(missing.resources.worktrees).toEqual([]);
    expect(unauthorized.resources.worktrees).toEqual([]);
    expect(await exists(join(workspaceRoot, 'worktrees'))).toBe(false);
    expect((await auditTodoLiveNegative(workspaceRoot, missing.scenarioId)).ok).toBe(true);
    expect((await auditTodoLiveNegative(workspaceRoot, unauthorized.scenarioId)).ok).toBe(true);
  });

  it('[case:p08-2-f005-dependency-failure-propagates] 前置失败只保留前置现场，后继不生成或提交', async () => {
    const workspaceRoot = await root();
    const report = await runTodoLiveNegativeScenario({ scenarioId: 'dependency-failure', mode: 'dependency-failure', workspaceRoot, tasks });

    expect(report).toMatchObject({ status: 'failed', reason: 'dependency_failed', budget: { used: 1 } });
    expect(report.tasks).toEqual([
      expect.objectContaining({ id: 'F-001', status: 'failed', committed: false }),
      expect.objectContaining({ id: 'F-002', status: 'blocked', reason: 'dependency_not_passed', generated: false, committed: false }),
      expect.objectContaining({ id: 'F-003', status: 'blocked', reason: 'dependency_not_passed', generated: false, committed: false }),
    ]);
    expect(report.attempts).toHaveLength(1);
    expect(report.resources.worktrees).toEqual(['worktrees/F-001']);
    expect(await exists(join(workspaceRoot, 'worktrees/F-001/partial.txt'))).toBe(true);
    expect(await exists(join(workspaceRoot, 'worktrees/F-002'))).toBe(false);
    expect(await exists(join(workspaceRoot, 'worktrees/F-003'))).toBe(false);
    expect((await auditTodoLiveNegative(workspaceRoot, report.scenarioId)).ok).toBe(true);
  });

  it('[case:p08-2-f005-budget-exhaustion-propagates] 预算耗尽不会启动依赖 Task', async () => {
    const workspaceRoot = await root();
    const report = await runTodoLiveNegativeScenario({ scenarioId: 'budget-exhausted', mode: 'budget-exhausted', workspaceRoot, tasks, maxAttempts: 1 });

    expect(report).toMatchObject({ status: 'failed', reason: 'budget_exhausted', budget: { limit: 1, used: 1, exhausted: true } });
    expect(report.tasks[0]).toMatchObject({ status: 'failed', reason: 'budget_exhausted', generated: true, committed: false });
    expect(report.tasks.slice(1).every(task => task.status === 'blocked' && task.reason === 'dependency_not_passed')).toBe(true);
    expect(report.attempts).toHaveLength(1);
    expect(report.resources.worktrees).toEqual(['worktrees/F-001']);
    expect(await exists(join(workspaceRoot, 'worktrees/F-002'))).toBe(false);
    expect(await exists(join(workspaceRoot, 'worktrees/F-003'))).toBe(false);
  });

  it('[case:p08-2-f005-cancel-preserves-evidence] 取消保留部分代码、Attempt、预算和失败证据', async () => {
    const workspaceRoot = await root();
    const report = await runTodoLiveNegativeScenario({ scenarioId: 'cancelled', mode: 'cancelled', workspaceRoot, tasks });

    expect(report).toMatchObject({ status: 'failed', reason: 'cancelled', budget: { used: 1 }, cleanup: { worktree: 'preserved', occupancy: 'released' } });
    expect(report.attempts[0]).toMatchObject({ status: 'cancelled', stop: { confirmed: true } });
    expect(report.tasks[0]).toMatchObject({ status: 'failed', reason: 'cancelled', generated: true, committed: false });
    expect(report.tasks.slice(1).every(task => task.status === 'blocked')).toBe(true);
    expect(await exists(join(workspaceRoot, 'worktrees/F-001/partial.txt'))).toBe(true);
    expect(await exists(join(workspaceRoot, 'evidence', 'cancelled.json'))).toBe(true);
    const persisted = JSON.parse(await readFile(join(workspaceRoot, 'state', 'cancelled.json'), 'utf8')) as typeof report;
    expect(persisted.attempts[0]).toMatchObject({ attemptId: 'attempt-cancelled-F-001' });
    expect((await auditTodoLiveNegative(workspaceRoot, report.scenarioId)).ok).toBe(true);
  });

  it('[case:p08-2-f005-interrupted-holds-occupancy] 未确认停止保留占用，恢复不会创建新 Attempt 或 worktree', async () => {
    const workspaceRoot = await root();
    const report = await runTodoLiveNegativeScenario({ scenarioId: 'interrupted', mode: 'interrupted', workspaceRoot, tasks });

    expect(report).toMatchObject({ status: 'failed', reason: 'stop_unconfirmed', cleanup: { worktree: 'preserved', occupancy: 'held' } });
    expect(report.attempts[0]).toMatchObject({ status: 'interrupted', stop: { confirmed: false } });
    const before = report.attempts.length;
    const resume = await resumeTodoLiveNegative(workspaceRoot, report.scenarioId);
    expect(resume).toMatchObject({ status: 'blocked', reason: 'old_process_not_confirmed', attemptsCreated: 0, worktreesCreated: 0 });
    expect((await auditTodoLiveNegative(workspaceRoot, report.scenarioId)).ok).toBe(true);
    expect(JSON.parse(await readFile(join(workspaceRoot, 'state', 'interrupted.json'), 'utf8')).attempts).toHaveLength(before);
    expect(await exists(join(workspaceRoot, 'worktrees/F-001/partial.txt'))).toBe(true);
  });
});
