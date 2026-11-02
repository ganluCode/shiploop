import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createTodoPlanningSnapshot,
  reviewTodoCandidate,
  initialTodoPlanningState,
  runTodoPlanningStep,
} from '../../../scripts/acceptance/p08-todo-planning.ts';
import type { TodoPlanningPorts } from '../../../scripts/acceptance/p08-todo-planning.ts';
import { buildPlanningDecisionView } from '../../../packages/cli/src/app/planning.ts';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import { computeExecutionStrategyCopyDigest } from '../../../packages/core/src/ports/execution-input-prepare.ts';

const requirementsText = readFileSync(new URL('../../../acceptance/p08.todo-requirements.json', import.meta.url), 'utf8');
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

function candidate(snapshot = createTodoPlanningSnapshot(options)) {
  const ref = snapshot.planningInput.requirementRefs[0];
  return {
    projectId: options.projectId, featureId: options.featureId, candidateId: 'candidate-1',
    runStatus: 'succeeded',
    candidate: {
      candidateDigest: 'a'.repeat(64),
      plan: {
        feature: { title: 'Todo CLI', sourceRefs: [ref] },
        tasks: ['storage', 'commands', 'verification'].map((id, index, ids) => ({
          id, title: id, acceptance: { criteria: ['Todo CLI frozen behavior'] },
          requirementsRefs: [ref], dependsOn: index === 0 ? [] : [ids[index - 1]],
        })),
      },
    },
  };
}

function fixture() {
  const snapshot = createTodoPlanningSnapshot(options);
  const state = initialTodoPlanningState(snapshot);
  const reviewed = reviewTodoCandidate(snapshot, candidate(snapshot));
  const calls: string[][] = [];
  const saved: typeof state[] = [];
  let failCommand: string | undefined;
  let malformed = false;
  let previewFeatures = [options.featureId];
  let route = options.route;
  let featureRevision = options.revision;
  const responses: Record<string, () => unknown> = {
    'config.effective': () => ({ strategies: { purposeStrategies: { planner: { strategy: route } } } }),
    'planning.start': () => ({ status: 'accepted', commandId: snapshot.commandIds.plan, candidateId: 'candidate-1', runId: 'plan-run', batchId: 'plan-batch' }),
    'planning.candidate': () => candidate(snapshot),
    'feature.get': () => ({
      feature: { id: options.featureId, projectId: options.projectId, phaseId: options.phaseId, revision: featureRevision,
        planStatus: 'approved', planDigest: reviewed.planDigest },
      tasks: reviewed.plan.tasks.map(task => ({ ...task, projectId: options.projectId, featureId: options.featureId, executionConfig: route, configSource: 'project_default', configSourceKey: null })),
      dependencies: reviewed.plan.tasks.flatMap(task => task.dependsOn.map(dependsOnId => ({ taskId: task.id, dependsOnId }))),
    }),
    'planning.approve': () => buildPlanningDecisionView(snapshot.commandIds.approve, false, 'approve', {
      candidateId: 'candidate-1', candidateDigest: reviewed.candidateDigest,
      approval: { id: 'approval-1', status: 'approved', subjectDigest: reviewed.planDigest, checkPolicyDigest: 'd'.repeat(64) },
      feature: { id: options.featureId, planStatus: 'approved', planDigest: reviewed.planDigest },
    }, 'trusted-owner'),
    'execution.preview': () => ({ status: 'ready', projectId: options.projectId, featureIds: previewFeatures,
      scope: { featureIds: previewFeatures, memberFeatureIds: previewFeatures }, previewDigest: 'b'.repeat(64),
      summary: { budget: snapshot.executionBudget, plan: { planDigest: reviewed.planDigest, taskCount: 3 },
        tasks: reviewed.taskIds.map(taskId => ({ taskId, strategyCopyDigest: computeExecutionStrategyCopyDigest({ executionConfig: route, configSource: 'project_default', configSourceKey: null }) })),
        approval: { planDigest: reviewed.planDigest, decisionId: 'approval-1', checkPolicyDigest: 'd'.repeat(64) },
        inputs: { refs: snapshot.planningInput.requirementRefs } },
    }),
    'execution.start': () => ({ status: 'accepted', commandId: snapshot.commandIds.start, featureIds: [options.featureId], runIds: ['delivery-run'], runId: 'delivery-run', batchId: 'delivery-batch' }),
  };
  const ports: TodoPlanningPorts = {
    save: async value => { saved.push(structuredClone(value)); },
    input: async name => `/tmp/${name}`,
    invoke: async argv => {
      // Every intent uses the real CLI argument parser, even with a scripted response.
      expect(() => parseAppCliArgs([...argv])).not.toThrow();
      calls.push([...argv]);
      const command = `${argv[0]}.${argv[1]}`;
      if (malformed) return { exitCode: 0, stdout: '{broken' };
      if (failCommand === command) return { exitCode: 1, stdout: JSON.stringify({ ok: false, command, error: { code: 'conflict', message: 'do not copy secret/path' } }) };
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, command, result: responses[command]() }) };
    },
  };
  return { snapshot, state, reviewed, calls, saved, ports, responses,
    fail: (command: string) => { failCommand = command; }, malformed: () => { malformed = true; },
    expandPreview: () => { previewFeatures = [options.featureId, 'unrelated-feature']; },
    changeRoute: () => { route = { ...route, model: 'unauthorized-model' }; },
    advanceRevision: () => { featureRevision++; },
  };
}

async function approve(f: ReturnType<typeof fixture>) {
  await runTodoPlanningStep(f.snapshot, f.state, { kind: 'plan' }, f.ports);
  await runTodoPlanningStep(f.snapshot, f.state, { kind: 'review' }, f.ports);
  await runTodoPlanningStep(f.snapshot, f.state, { kind: 'approve', candidateDigest: f.reviewed.candidateDigest, scopeConfirmed: true }, f.ports);
}

describe('Todo explicit CLI stages (scripted transport; live remains not_run)', () => {
  it('[case:approval-identity] CLI 决定人来自已认证回执身份', () => {
    expect(buildPlanningDecisionView('command', false, 'approve', {}, 'trusted-owner').decisionActor).toBe('trusted-owner');
  });

  it('[case:approval-gate] 仅规划和审阅不得创建实现 Run；批准/启动必须各自显式绑定摘要', async () => {
    const f = fixture();
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'plan' }, f.ports);
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'review' }, f.ports);
    await expect(runTodoPlanningStep(f.snapshot, f.state, { kind: 'start', previewDigest: 'b'.repeat(64) }, f.ports)).rejects.toThrow('human_approval_required');
    await expect(runTodoPlanningStep(f.snapshot, f.state, { kind: 'approve', candidateDigest: 'c'.repeat(64), scopeConfirmed: true }, f.ports)).rejects.toThrow('human_scope_review_required');
    expect(f.calls.some(argv => argv[0] === 'execution')).toBe(false);
    expect(f.state.delivery).toBeUndefined();
  });

  it('[case:fixed-start] 批准身份/输入/预算保存后只启动单个 Feature，accepted 不宣称通过', async () => {
    const f = fixture();
    await approve(f);
    expect(f.state.approval?.decisionActor).toBe('trusted-owner');
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'preview' }, f.ports);
    await expect(runTodoPlanningStep(f.snapshot, f.state, { kind: 'start', previewDigest: 'c'.repeat(64) }, f.ports)).rejects.toThrow('start_confirmation_required');
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'start', previewDigest: 'b'.repeat(64) }, f.ports);
    expect(f.state.delivery).toEqual({ batchId: 'delivery-batch', runId: 'delivery-run', status: 'accepted', productVerified: false });
    const intent = f.saved.find(value => value.intents.start !== undefined && value.delivery === undefined);
    expect(intent?.approval?.decisionActor).toBe('trusted-owner');
    expect(intent?.preview?.approvalId).toBe('approval-1');
    const start = f.calls.find(argv => argv[0] === 'execution' && argv[1] === 'start')!;
    expect(start).toContain('--confirm');
    expect(start).toContain(f.snapshot.commandIds.start);
    expect(start).not.toContain('--phase');
  });

  it('[case:failure-evidence] 规划/批准/启动拒绝和畸形响应保存结构化原因，无假通过', async () => {
    for (const command of ['planning.start', 'planning.approve', 'execution.start']) {
      const f = fixture();
      if (command !== 'planning.start') {
        await runTodoPlanningStep(f.snapshot, f.state, { kind: 'plan' }, f.ports);
        await runTodoPlanningStep(f.snapshot, f.state, { kind: 'review' }, f.ports);
      }
      if (command === 'execution.start') {
        await approve(f);
        await runTodoPlanningStep(f.snapshot, f.state, { kind: 'preview' }, f.ports);
      }
      f.fail(command);
      const action = command === 'planning.start' ? { kind: 'plan' as const }
        : command === 'planning.approve' ? { kind: 'approve' as const, candidateDigest: f.reviewed.candidateDigest, scopeConfirmed: true as const }
        : { kind: 'start' as const, previewDigest: 'b'.repeat(64) };
      await expect(runTodoPlanningStep(f.snapshot, f.state, action, f.ports)).rejects.toThrow('conflict');
      expect(f.state.failures.at(-1)).toMatchObject({ reason: 'conflict', exitCode: 1 });
      expect(JSON.stringify(f.saved)).not.toContain('secret/path');
      expect(f.state.delivery).toBeUndefined();
    }
    const f = fixture();
    f.malformed();
    await expect(runTodoPlanningStep(f.snapshot, f.state, { kind: 'plan' }, f.ports)).rejects.toThrow('cli_response_malformed');
    expect(f.state.failures.at(-1)?.reason).toBe('cli_response_malformed');
  });

  it('[case:replay] 重复规划/启动及回执丢失后的恢复使用原命令身份，不再授权第二次执行', async () => {
    const f = fixture();
    await approve(f);
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'preview' }, f.ports);
    let lost = true;
    const original = f.ports.invoke;
    f.ports.invoke = async argv => {
      const result = await original(argv);
      if (argv[0] === 'execution' && argv[1] === 'start' && lost) { lost = false; throw new Error('connection lost after commit'); }
      return result;
    };
    const action = { kind: 'start' as const, previewDigest: 'b'.repeat(64) };
    await expect(runTodoPlanningStep(f.snapshot, f.state, action, f.ports)).rejects.toThrow('local_or_transport_failure');
    const resumed = structuredClone(f.saved.at(-1)!);
    await runTodoPlanningStep(f.snapshot, resumed, action, f.ports);
    await runTodoPlanningStep(f.snapshot, resumed, { kind: 'plan' }, f.ports);
    await runTodoPlanningStep(f.snapshot, resumed, action, f.ports);
    const starts = f.calls.filter(argv => argv[0] === 'execution' && argv[1] === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual(starts[1]);
    expect(f.calls.filter(argv => argv[0] === 'planning' && argv[1] === 'start')).toHaveLength(1);
    expect(resumed.delivery?.runId).toBe('delivery-run');
  });

  it('[case:approval-replay] 批准已提交但回执丢失时，revision 已推进仍重放原批准信封', async () => {
    const f = fixture();
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'plan' }, f.ports);
    await runTodoPlanningStep(f.snapshot, f.state, { kind: 'review' }, f.ports);
    const original = f.ports.invoke;
    let lost = true;
    f.ports.invoke = async argv => {
      const response = await original(argv);
      if (argv[0] === 'planning' && argv[1] === 'approve' && lost) {
        lost = false;
        f.advanceRevision();
        throw new Error('lost approval reply');
      }
      return response;
    };
    const action = { kind: 'approve' as const, candidateDigest: f.reviewed.candidateDigest, scopeConfirmed: true as const };
    await expect(runTodoPlanningStep(f.snapshot, f.state, action, f.ports)).rejects.toThrow();
    const resumed = structuredClone(f.saved.at(-1)!);
    await runTodoPlanningStep(f.snapshot, resumed, action, f.ports);
    const approvals = f.calls.filter(argv => argv[0] === 'planning' && argv[1] === 'approve');
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toEqual(approvals[1]);
    expect(resumed.approval?.decisionActor).toBe('trusted-owner');
    expect(resumed.delivery).toBeUndefined();
  });

  it('[case:preview-identity] 预算、输入摘要或策略在预览中漂移均不得保存启动授权', async () => {
    for (const field of ['budget', 'inputs', 'tasks', 'approval']) {
      const f = fixture();
      await approve(f);
      const original = f.responses['execution.preview'];
      f.responses['execution.preview'] = () => {
        const value = structuredClone(original()) as { summary: Record<string, unknown> };
        if (field === 'budget') value.summary.budget = { ...f.snapshot.executionBudget, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 1000 } };
        if (field === 'inputs') value.summary.inputs = { refs: [] };
        if (field === 'approval') value.summary.approval = { planDigest: f.reviewed.planDigest, decisionId: 'different-owner-approval', checkPolicyDigest: 'e'.repeat(64) };
        if (field === 'tasks') value.summary.tasks = f.reviewed.taskIds.map(taskId => ({ taskId, strategyCopyDigest: 'f'.repeat(64) }));
        return value;
      };
      await expect(runTodoPlanningStep(f.snapshot, f.state, { kind: 'preview' }, f.ports)).rejects.toThrow();
      expect(f.state.preview).toBeUndefined();
      expect(f.calls.some(argv => argv[0] === 'execution' && argv[1] === 'start')).toBe(false);
    }
  });

  it('[case:preview-guards] 未授权路由和扩张范围拒绝；快照漂移不发写命令', async () => {
    const route = fixture();
    route.changeRoute();
    await expect(runTodoPlanningStep(route.snapshot, route.state, { kind: 'plan' }, route.ports)).rejects.toThrow('route_mismatch');
    expect(route.calls).toHaveLength(1);
    const scope = fixture();
    await approve(scope);
    scope.expandPreview();
    await expect(runTodoPlanningStep(scope.snapshot, scope.state, { kind: 'preview' }, scope.ports)).rejects.toThrow('preview_scope_blocked');
    expect(scope.state.preview).toBeUndefined();
    const changed = structuredClone(scope.snapshot);
    changed.executionBudget = { ...changed.executionBudget, batch: { ...changed.executionBudget.batch, maxTotalAttempts: 10 } };
    await expect(runTodoPlanningStep(changed, scope.state, { kind: 'plan' }, scope.ports)).rejects.toThrow('snapshot_drift');
  });
});

describe('Todo planning scope and fixed authorization', () => {
  it('[case:snapshot-scope] 固定输入正文摘要、Pi 路由和两份有限预算；不同调用保持同一命令身份', () => {
    const snapshot = createTodoPlanningSnapshot(options);
    expect(snapshot).toEqual(createTodoPlanningSnapshot(structuredClone(options)));
    expect(snapshot.planningInput.strategy).toEqual({ approvalMode: 'manual', taskLimit: 6 });
    expect(snapshot.planningInput.requirementRefs[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.route).toEqual(options.route);
    expect(snapshot.executionBudget.batch.maxRuns).toBe(1);
    expect(snapshot.planningInput.acceptance.criteria.join('\n')).toContain('unknown-id');
  });

  it('[case:finite-budget] 拒绝 Fake 路由、缺限额、非有限时间或第二份 Run 预算', () => {
    for (const changed of [
      { ...options, route: { ...options.route, runtime: 'fake' } },
      { ...options, executionBudget: { ...budget, batch: { ...budget.batch, maxRuns: 2 } } },
      { ...options, planningBudget: {} },
      { ...options, planningBudget: { ...budget, run: { ...budget.run, runTimeLimitMs: Infinity } } },
      { ...options, taskLimit: 2 },
    ]) expect(() => createTodoPlanningSnapshot(changed)).toThrow();
  });

  it('[case:candidate-dag] 真实 CLI 候选形状至少三 Task 且唯一无环、引用只限固定输入', () => {
    const snapshot = createTodoPlanningSnapshot(options);
    const result = reviewTodoCandidate(snapshot, candidate(snapshot));
    expect(result.taskIds).toEqual(['commands', 'storage', 'verification']);
    expect(result.longestChain).toBe(3);
    for (const mutate of [
      (v: ReturnType<typeof candidate>) => { v.candidate.plan.tasks[2].dependsOn = ['missing']; },
      (v: ReturnType<typeof candidate>) => { v.candidate.plan.tasks[0].dependsOn = ['verification']; },
      (v: ReturnType<typeof candidate>) => { v.candidate.plan.tasks[2].id = 'storage'; },
      (v: ReturnType<typeof candidate>) => { v.candidate.plan.tasks[0].requirementsRefs = [{ artifactId: 'outside', contentHash: 'b'.repeat(64) }]; },
      (v: ReturnType<typeof candidate>) => { v.featureId = 'other-feature'; },
    ]) {
      const bad = candidate(snapshot);
      mutate(bad);
      expect(() => reviewTodoCandidate(snapshot, bad)).toThrow();
    }
  });
});
