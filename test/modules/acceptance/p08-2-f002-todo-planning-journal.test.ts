import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareTodoPlanningSession, executeTodoPlanningCliStep, todoPlanningMain } from '../../../scripts/acceptance/p08-todo-planning-cli.ts';

// Local file journal checks only. No Host, SQLite, child processes or model calls.
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'shiploop-p08-todo-journal-'));
  directories.push(directory);
  const requirementsText = await readFile(new URL('../../../acceptance/p08.todo-requirements.json', import.meta.url), 'utf8');
  const budget = {
    batch: { maxRuns: 1, maxTotalAttempts: 9, maxRuntimeStarts: 9, maxNoProgressRuns: 1, deadlineUtcMs: 2_000_000_000_000 },
    run: { maxAttemptsPerRun: 9, runTimeLimitMs: 120_000 },
  };
  const options = {
    requirementsText, requirementArtifactId: 'todo-requirements',
    projectId: '3c408343-40b9-4ea8-8658-6e391b086f79', phaseId: 'todo-phase', featureId: 'todo-feature',
    revision: 1, route: { runtime: 'pi', provider: 'authorized-provider', model: 'authorized-model' },
    planningBudget: budget, executionBudget: budget, taskLimit: 6,
  };
  return { directory, options };
}

describe('Todo demo durable local journal', () => {
  it('[case:immutable-session] 重复准备保留已有失败和批准记录，输入变化拒绝覆盖', async () => {
    const { directory, options } = await setup();
    const snapshot = await prepareTodoPlanningSession(directory, options);
    const statePath = join(directory, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.failures.push({ action: 'plan', reason: 'authorization_required', exitCode: 1 });
    state.approval = { decisionActor: 'preserved-owner', candidateDigest: 'a'.repeat(64) };
    await writeFile(statePath, JSON.stringify(state));
    await prepareTodoPlanningSession(directory, options);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(state);
    expect(JSON.parse(await readFile(join(directory, 'planning-input.json'), 'utf8'))).toEqual(snapshot.planningInput);
    expect(JSON.parse(await readFile(join(directory, 'execution-budget.json'), 'utf8'))).toEqual(snapshot.executionBudget);
    await expect(prepareTodoPlanningSession(directory, { ...options, route: { ...options.route, model: 'changed' } })).rejects.toThrow('input_file_drift');
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(state);
  });

  it('[case:journal-gate] 未批准的启动在本地拒绝、写入失败原因并释放锁，完全不创建 CLI 进程', async () => {
    const { directory, options } = await setup();
    await prepareTodoPlanningSession(directory, options);
    // This path deliberately does not exist: the gate must reject before spawning.
    await expect(executeTodoPlanningCliStep({ directory, cliBin: join(directory, 'must-not-execute.js'), dataRoot: join(directory, 'host'),
      action: { kind: 'start', previewDigest: 'b'.repeat(64) } })).rejects.toThrow('human_approval_required');
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    expect(state.delivery).toBeUndefined();
    expect(state.failures.at(-1)).toEqual({ action: 'start', reason: 'human_approval_required', exitCode: null });
    await expect(readFile(join(directory, '.stage-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('[case:journal-lock] 未知存活者持锁时拒绝接管，不删除旧锁或清空现场', async () => {
    const { directory, options } = await setup();
    await prepareTodoPlanningSession(directory, options);
    await mkdir(join(directory, '.stage-lock'));
    await expect(prepareTodoPlanningSession(directory, options)).rejects.toThrow('session_busy_or_recovery_required');
    await expect(mkdir(join(directory, '.stage-lock'))).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('[case:explicit-cli-confirmation] 演示入口缺少规划/批准/启动的显式确认时拒绝，不读取或启动其他资源', async () => {
    for (const stage of ['plan', 'approve', 'start']) {
      await expect(todoPlanningMain([stage, 'absent-session', 'absent-cli', 'absent-data-root'])).rejects.toThrow('explicit_confirmation_required');
    }
  });
});
