import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import {
  createPlanningCandidateDecisionPort,
} from '../../../packages/core/src/application/planning-candidate-decision.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { openPlanningSubmitFixture, SUBMIT_NOW } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';
import type { PlanningSubmitFixture } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';

let fixture: PlanningSubmitFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

function completed(value: CommandReceipt): CommandReceipt & { status: 'completed'; result: Record<string, unknown> } {
  if (value.status !== 'completed') throw new Error(`expected completed: ${JSON.stringify(value)}`);
  return value as CommandReceipt & { status: 'completed'; result: Record<string, unknown> };
}

function terminalizePlanningRun(f: PlanningSubmitFixture): void {
  f.session.transactWrite('f008.fixture.terminalize', () => {
    f.session.database.prepare("UPDATE attempts SET status = 'succeeded', ended_at = ? WHERE id = ?").run(SUBMIT_NOW, f.attemptId);
    f.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?").run(SUBMIT_NOW, f.runId);
    f.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = (SELECT batch_id FROM runs WHERE id = ?)").run(f.runId);
  });
}

function candidateWithHistory(f: PlanningSubmitFixture): string {
  return f.candidateBody({
    plan: {
      schemaVersion: 1,
      feature: { title: '规划后的交付计划', description: null, labels: [], sourceRefs: [] },
      tasks: [
        { id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] },
        { id: 'p-1', title: '实现候选提交', acceptance: { criteria: ['候选可提交并通过校验'] }, dependsOn: [] },
        { id: 'p-2', title: '回归候选重放', acceptance: { criteria: ['重放不重复发布'] }, dependsOn: ['p-1'] },
      ],
    },
    taskVerification: [{ taskId: 't-1', checkRefs: ['unit-core'], moduleRefs: ['core'], impactScope: ['packages/core'] }],
  });
}

async function decide(f: PlanningSubmitFixture, candidateDigest: string, decision: 'approve' | 'reject'): Promise<CommandReceipt> {
  const atomicStore = createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => SUBMIT_NOW });
  const verifier = createArtifactVerifier({ artifacts: f.artifacts, files: f.files, limits: { maxReadBytes: 16_000_000 } });
  const commands = createCommandService({
    atomicStore,
    planningCandidateDecision: createPlanningCandidateDecisionPort({ atomicStore, verifier }),
    nowUtcMs: () => SUBMIT_NOW,
  });
  return commands.submit(f.binding.principal, {
    schemaVersion: 5,
    commandId: randomUUID(),
    issuedAt: new Date(SUBMIT_NOW).toISOString(),
    operation: 'planning.candidate.decide',
    scope: { kind: 'project', projectId: f.projectId },
    expectedRevision: 1,
    payload: {
      candidateId: f.candidateId,
      candidateDigest,
      decision,
      reason: decision === 'reject' ? '需要重新规划' : null,
    },
  });
}

describe('P05-1 / F-008 候选批准与拒绝', () => {
  it('[case:candidate-reject-preserves-history] 拒绝保留候选摘要与规划事实，不导入 coding Task', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const published = completed(await f.bridge.invoke(f.request()) as CommandReceipt);
    terminalizePlanningRun(f);
    const beforeTaskCount = Number((f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = \'coding\'').get(f.featureId) as { n: number }).n);
    const receipt = completed(await decide(f, published.result.candidateDigest as string, 'reject'));
    expect(receipt.result).toMatchObject({ decision: 'reject', candidateId: f.candidateId, applied: false });
    expect(f.planningContext()).toMatchObject({ status: 'rejected', decision: 'rejected', decision_reason: '需要重新规划' });
    expect((f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = \'coding\'').get(f.featureId) as { n: number }).n).toBe(beforeTaskCount);
    expect(f.session.database.prepare('SELECT plan_status FROM features WHERE id = ?').get(f.featureId)).toEqual({ plan_status: 'draft' });
    expect(f.session.database.prepare('SELECT status FROM runs WHERE id = ?').get(f.runId)).toEqual({ status: 'succeeded' });
  });

  it('[case:candidate-approve-applies-atomically] 批准一次性应用 Task/依赖/策略并保留 planning Task', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const published = completed(await f.bridge.invoke(f.request({ candidate: candidateWithHistory(f) })) as CommandReceipt);
    terminalizePlanningRun(f);
    const receipt = completed(await decide(f, published.result.candidateDigest as string, 'approve'));
    expect(receipt.result).toMatchObject({ decision: 'approve', candidateId: f.candidateId });
    expect(f.planningContext()).toMatchObject({ status: 'applied', decision: 'approved', applied_revision: 2 });
    expect(f.session.database.prepare('SELECT plan_status, revision FROM features WHERE id = ?').get(f.featureId)).toEqual({ plan_status: 'approved', revision: 2 });
    expect(f.session.database.prepare('SELECT id FROM tasks WHERE feature_id = ? AND kind = \'planning\'').get(f.featureId)).toBeTruthy();
    expect(f.session.database.prepare('SELECT id FROM tasks WHERE feature_id = ? AND kind = \'coding\' ORDER BY id').all(f.featureId)).toEqual([{ id: 'p-1' }, { id: 'p-2' }, { id: 't-1' }]);
    expect(f.session.database.prepare('SELECT task_id, depends_on_id FROM task_dependencies WHERE feature_id = ?').all(f.featureId)).toEqual([{ task_id: 'p-2', depends_on_id: 'p-1' }]);
    expect(f.session.database.prepare('SELECT status, decision_actor FROM approvals WHERE subject_id = ? ORDER BY created_at DESC LIMIT 1').get(f.featureId)).toMatchObject({ status: 'approved', decision_actor: f.binding.principal.principalId });
  });

  it('[case:candidate-command-replay] 相同 commandId 的批准命令只返回原回执', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const published = completed(await f.bridge.invoke(f.request({ candidate: candidateWithHistory(f) })) as CommandReceipt);
    terminalizePlanningRun(f);
    const commandId = randomUUID();
    const input = {
      schemaVersion: 5, commandId, issuedAt: new Date(SUBMIT_NOW).toISOString(),
      operation: 'planning.candidate.decide', scope: { kind: 'project' as const, projectId: f.projectId }, expectedRevision: 1,
      payload: { candidateId: f.candidateId, candidateDigest: published.result.candidateDigest as string, decision: 'approve' as const, reason: null },
    };
    const atomicStore = createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => SUBMIT_NOW });
    const verifier = createArtifactVerifier({ artifacts: f.artifacts, files: f.files, limits: { maxReadBytes: 16_000_000 } });
    const commands = createCommandService({ atomicStore, planningCandidateDecision: createPlanningCandidateDecisionPort({ atomicStore, verifier }), nowUtcMs: () => SUBMIT_NOW });
    const first = await commands.submit(f.binding.principal, input);
    const replay = await commands.submit(f.binding.principal, input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(f.session.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = \'coding\'').get(f.featureId)).toEqual({ n: 3 });
  });
});
