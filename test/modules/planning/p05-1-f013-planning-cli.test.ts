import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  CLI_START_TIMEOUT_DEFAULT_MS,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';
import {
  buildPlanningCandidateView,
  buildPlanningContextDetailView,
  buildPlanningStartView,
  formatPlanningCandidateView,
} from '../../../packages/cli/src/app/planning.ts';

const projectId = randomUUID();
const featureId = 'feature-draft';
const candidateId = 'candidate-1';
const digest = 'a'.repeat(64);
const budget = {
  batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, deadlineUtcMs: '2030-01-01T00:00:00.000Z' },
  run: { maxAttempts: 1, runTimeLimitMs: 60_000 },
  concurrency: { maxConcurrentWorks: 1 },
};

const startInput = {
  requirementRefs: [{ artifactId: 'requirements', contentHash: digest }],
  constraints: ['保持单次规划'],
  acceptance: { criteria: ['候选包含 Task 与 verification'] },
  strategy: { approvalMode: 'manual', taskLimit: 10 },
  budget,
};

describe('F-013 planning CLI 参数与帮助', () => {
  it('规划启动解析完整输入文件参数，候选列表/详情/审批身份明确', () => {
    expect(parseAppCliArgs([
      'planning', 'start', featureId,
      '--project', projectId,
      '--phase', 'phase-1',
      '--revision', '2',
      '--input', '/tmp/planning.json',
      '--command-id', randomUUID(),
      '--json',
    ])).toMatchObject({
      kind: 'command', command: 'planning', commandId: 'planning.start',
      projectId, phaseId: 'phase-1', featureId, revision: 2,
      inputFile: '/tmp/planning.json', json: true,
      startTimeoutMs: CLI_START_TIMEOUT_DEFAULT_MS,
    });
    expect(parseAppCliArgs(['planning', 'list', '--project', projectId, '--feature', featureId])).toMatchObject({
      commandId: 'planning.list', projectId, featureId,
    });
    expect(parseAppCliArgs(['planning', 'candidate', candidateId, '--project', projectId])).toMatchObject({
      commandId: 'planning.candidate', candidateId, projectId,
    });
    expect(parseAppCliArgs([
      'planning', 'approve', candidateId, '--project', projectId, '--digest', digest,
      '--revision', '3', '--reason', '人工确认', '--command-id', randomUUID(),
    ])).toMatchObject({
      commandId: 'planning.approve', candidateId, candidateDigest: digest, revision: 3,
    });
  });

  it('规划审批缺摘要或 CAS 在连接 Host 前拒绝，且不回显输入正文', () => {
    expect(() => parseAppCliArgs(['planning', 'approve', candidateId, '--project', projectId, '--revision', '1']))
      .toThrowError(AppCliParseError);
    expect(() => parseAppCliArgs(['planning', 'approve', candidateId, '--project', projectId, '--digest', 'secret-plan', '--revision', '1']))
      .toThrowError(AppCliParseError);
  });

  it('帮助明确输入来源、候选摘要、revision 和人工决策边界', () => {
    const help = getAppCliHelp('planning');
    expect(help).toContain('planning start');
    expect(help).toContain('requirementRefs');
    expect(help).toContain('candidateDigest');
    expect(help).toContain('revision');
    expect(help).toContain('不自动开始编码');
  });
});

describe('F-013 planning CLI 结构化视图', () => {
  it('启动结果保留四重稳定身份并明确尚未生成/未授权编码', () => {
    const result = {
      commandId: randomUUID(), principalId: 'owner', operation: 'planning.start', schemaVersion: 7,
      status: 'accepted', operationId: randomUUID(), batchId: randomUUID(), runId: randomUUID(),
      planningTaskId: randomUUID(), candidateId: randomUUID(), replayed: false,
    } as const;
    const view = buildPlanningStartView(result);
    expect(view).toMatchObject({
      status: 'accepted', batchId: result.batchId, runId: result.runId, candidateId: result.candidateId,
      planningTaskId: result.planningTaskId,
      planning: { candidateState: 'pending_generation', encodingAuthorized: false },
    });
  });

  it('候选审阅输出 Task 描述/难度/依赖/verification 和摘要，不宣称交付成功', () => {
    const context = {
      id: 'context-1', projectId, phaseId: 'phase-1', featureId, runId: 'run-1', planningTaskId: 'task-1',
      candidateId, inputDigest: digest, targetRevision: 2, planDigest: digest, status: 'candidate_published',
      candidate: { state: 'published', artifactId: 'artifact-1', contentHash: digest, candidateDigest: digest, summary: '候选摘要' },
      decision: null, planningTask: { id: 'task-1', status: 'passed', strategy: { runtime: 'fake', provider: 'local', model: 'test' } },
      createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:01.000Z',
    } as const;
    const candidate = {
      schemaVersion: 5, scope: 'planning-candidate', context,
      runStatus: 'succeeded',
      candidate: { state: 'published', artifact: { artifactId: 'artifact-1', contentHash: digest, sizeBytes: 100 },
        candidateDigest: digest, summary: '候选摘要',
        plan: { feature: { title: 'Feature', description: null, labels: [] }, tasks: [{ id: 'task-a', title: '实现', complexity: 'medium', dependsOn: [] }], taskCount: 1, dependencyEdgeCount: 0 },
        taskVerification: [{ taskId: 'task-a', checkRefs: ['unit'], moduleRefs: ['planning'], impactScope: ['packages/cli'] }] },
    } as const;
    const view = buildPlanningCandidateView(candidate as never);
    const candidateView = view.candidate;
    expect(candidateView).not.toBeNull();
    if (candidateView === null) throw new Error('candidate view missing');
    expect(candidateView.summary).toBe('候选摘要');
    expect(candidateView.tasks[0]).toMatchObject({ title: '实现', complexity: 'medium', dependsOn: [] });
    expect(candidateView.taskVerification[0].checkRefs).toEqual(['unit']);
    expect(view.execution).toEqual({ started: false, capability: 'unknown', runnable: false });
    expect(formatPlanningCandidateView(view)).toContain('candidateDigest');
  });

  it('规划上下文详情保留 Run/预算/状态来源', () => {
    const detail = { context: { candidateId, featureId, status: 'open' }, run: { id: 'run-1', status: 'queued' }, executionState: 'queued', outcomeAxes: { runSucceeded: false, codingExecutable: false, notExecutableReasons: ['candidate_pending'] }, attempts: [], attemptsTruncated: false, budget: { batch: { id: 'batch-1' } } };
    expect(buildPlanningContextDetailView(detail as never)).toMatchObject({
      candidateId, featureId, status: 'open', runId: 'run-1', executionState: 'queued', batchId: 'batch-1',
    });
  });
});

it('planning input fixture shape documents the bounded request fields', () => {
  expect(Object.keys(startInput)).toEqual(['requirementRefs', 'constraints', 'acceptance', 'strategy', 'budget']);
});
