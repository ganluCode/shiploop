import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateTodoLiveEvidence,
  aggregateTodoLiveNotRunEvidence,
  normalizeTodoLiveCheckOutcome,
  saveTodoLiveEvidenceReport,
  todoLiveArtifactFromContent,
  todoLiveEvidenceDigest,
  todoLiveRequirementsIdentity,
  validateTodoLiveEvidenceReport,
  type TodoLiveEvidenceReport,
} from '../../../scripts/acceptance/p08-todo-live-report.ts';
import {
  runTodoLiveDelivery,
  todoLiveNotRunEntryReport,
  type TodoLiveDeliveryPorts,
  type TodoLiveDeliveryReport,
  type TodoLiveTask,
} from '../../../scripts/acceptance/p08-todo-live.ts';
import { P08_TODO_REQUIREMENTS_PATH, P08_TODO_REQUIREMENTS_VERSION } from '../../../scripts/acceptance/p08-todo-requirements.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const tasks: TodoLiveTask[] = [
  { id: 'F-001', title: '创建 Todo 数据层', dependsOn: [] },
  { id: 'F-002', title: '实现 Todo 命令', dependsOn: ['F-001'] },
  { id: 'F-003', title: '补齐 Todo 验证', dependsOn: ['F-002'] },
];

const authorization = {
  realPi: true as const, provider: 'authorized-provider', model: 'authorized-model',
  expiresAt: Date.now() + 60_000, maxTasks: 3,
};

function ports(): TodoLiveDeliveryPorts {
  let sequence = 0;
  return {
    runTask: async task => ({
      executionMode: 'live', status: 'completed', taskId: task.id,
      attemptId: `attempt-${task.id}`, provider: authorization.provider, model: authorization.model, realCalls: 1,
    }),
    verifyTask: async task => ({
      status: 'passed', taskId: task.id, exitCode: 0,
      command: ['node', `verify-${task.id}.mjs`], evidenceRef: `checks/${task.id}.json`,
    }),
    commitTask: async task => {
      sequence += 1;
      return {
        status: 'succeeded', taskId: task.id, commitSha: `${String(sequence).padStart(40, '0')}`,
        treeSha: `${String(sequence + 10).padStart(40, '0')}`, message: `${task.id}: ${task.title}`,
      };
    },
    saveEvidence: async () => {},
  };
}

async function passedDelivery(): Promise<TodoLiveDeliveryReport> {
  return runTodoLiveDelivery({
    projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
    tasks, authorization, ports: ports(),
  });
}

const requirements = { version: 1, digest: 'a'.repeat(64) };
const code = { headCommit: 'c'.repeat(40), headTree: 'd'.repeat(40) };
const checkEvidence = todoLiveArtifactFromContent('checks/todo-delivery.json', '{"exitCode":0,"tests":7,"failed":0}\n');
const passingCheck = {
  id: 'todo-delivery-check', exitCode: 0, command: ['node', 'verify.mjs'] as const,
  evidence: { ref: 'checks/todo-delivery.json', content: '{"exitCode":0,"tests":7,"failed":0}\n' },
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'shiploop-p08-report-'));
  roots.push(value);
  return value;
}

function reseal(report: Record<string, unknown>): Record<string, unknown> {
  const { reportDigest: _ignored, ...body } = report;
  return { ...body, reportDigest: todoLiveEvidenceDigest(body) };
}

describe('P08-2 F-006 Todo live 结构化报告与证据聚合', () => {
  it('[case:p08-2-f006-identity-binding] 报告绑定需求版本/摘要、运行身份、代码 commit/tree 与检查结果', async () => {
    const delivery = await passedDelivery();
    const report = aggregateTodoLiveEvidence({
      delivery, requirements, code,
      checks: [passingCheck],
      manualPending: [{ id: 'owner-review', item: '负责人核对需求覆盖', owner: 'owner' }],
    });
    expect(report.identity).toEqual({
      projectId: 'project-1', featureId: 'feature-1', runId: 'run-1',
      requirementsVersion: 1, requirementsDigest: requirements.digest,
    });
    expect(report.code).toEqual(code);
    expect(report.delivery).toEqual({ status: 'passed', reportDigest: delivery.reportDigest });
    expect(report.tasks.map(task => task.taskId)).toEqual(['F-001', 'F-002', 'F-003']);
    expect(report.tasks[0]).toMatchObject({
      attemptId: 'attempt-F-001', status: 'passed',
      commitSha: '1'.padStart(40, '0'), verificationExitCode: 0, verificationRef: 'checks/F-001.json',
    });
    expect(report.checks[0]).toMatchObject({ id: 'todo-delivery-check', status: 'passed', exitCode: 0 });
    expect(report.checks[0]!.evidence).toEqual(checkEvidence);
    expect(report.artifacts).toContainEqual(checkEvidence);
    expect(validateTodoLiveEvidenceReport(report, { delivery })).toEqual(report);

    const tampered = reseal({ ...report, identity: { ...report.identity, runId: 'run-other' } });
    expect(() => validateTodoLiveEvidenceReport(tampered, { delivery })).toThrow(/identity_mismatch/);
  });

  it('[case:p08-2-f006-status-propagation] 通过、失败、not_run、inconclusive 与人工待确认分别记录且互不折算', async () => {
    const delivery = await passedDelivery();
    const failedCheck = { id: 'todo-delivery-check', exitCode: 1, command: ['node', 'verify.mjs'] as const };
    const failed = aggregateTodoLiveEvidence({ delivery, requirements, code, checks: [failedCheck] });
    expect(failed.status).toBe('failed');
    expect(failed.statusReason).toBe('check_failed');
    expect(failed.checks[0]).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(() => validateTodoLiveEvidenceReport(failed, { delivery })).not.to.throw();

    const clean = aggregateTodoLiveEvidence({ delivery, requirements, code, checks: [passingCheck] });
    expect(clean.status).toBe('passed');
    expect(clean.statusReason).toBeNull();

    const pendingOwner = aggregateTodoLiveEvidence({
      delivery, requirements, code, checks: [passingCheck],
      manualPending: [{ id: 'owner-review', item: '负责人核对需求覆盖', owner: 'owner' }],
    });
    expect(pendingOwner.status).toBe('inconclusive');
    expect(pendingOwner.statusReason).toBe('manual_pending');
    expect(pendingOwner.checks[0]!.status).toBe('passed');

    const notRun = aggregateTodoLiveNotRunEvidence({
      requirements, reason: 'explicit_approval_required',
      manualPending: [{ id: 'owner-review', item: '负责人批准真实流程', owner: 'owner' }],
    });
    expect(notRun.status).toBe('not_run');
    expect(notRun.statusReason).toBe('explicit_approval_required');
    expect(notRun.identity.projectId).toBeNull();
    expect(notRun.tasks).toEqual([]);
    expect(notRun.knownGaps.every(gap => gap.status === 'phase-required')).toBe(true);
    expect(() => validateTodoLiveEvidenceReport(notRun)).not.to.throw();

    const folded = reseal({ ...clean, status: 'not_run', statusReason: 'check_not_run', checks: clean.checks });
    expect(() => validateTodoLiveEvidenceReport(folded, { delivery })).toThrow(/status_propagation_invalid/);
  });

  it('[case:p08-2-f006-sensitive-boundary] 报告拒绝凭据、敏感键与开发机绝对路径', async () => {
    const delivery = await passedDelivery();
    const report = aggregateTodoLiveEvidence({ delivery, requirements, code, checks: [passingCheck] });
    expect(() => validateTodoLiveEvidenceReport(report, {
      delivery, forbiddenValues: ['SHIPLOOP_P08_LIVE_KEY_VALUE'],
    })).not.to.throw();

    const leaky = reseal({
      ...report,
      manualPending: [{ id: 'owner-review', item: '密钥 SHIPLOOP_P08_LIVE_KEY_VALUE 待回收', owner: 'owner' }],
    });
    expect(() => validateTodoLiveEvidenceReport(leaky, {
      delivery, forbiddenValues: ['SHIPLOOP_P08_LIVE_KEY_VALUE'],
    })).toThrow(/credential_leak/);

    const withToken = reseal({ ...report, accessToken: 'ghp_demo' });
    expect(() => validateTodoLiveEvidenceReport(withToken, { delivery })).toThrow(/credential_leak/);

    const absolute = reseal({ ...report, checks: report.checks.map(check => ({
      ...check, evidence: { ...checkEvidence, ref: '/Users/dev/shiploop/checks/todo-delivery.json' },
    })) });
    expect(() => validateTodoLiveEvidenceReport(absolute, { delivery })).toThrow(/absolute_path/);
  });

  it('[case:p08-2-f006-evidence-missing-inconclusive] 成功退出但缺证据时为 inconclusive 而非 passed', async () => {
    expect(normalizeTodoLiveCheckOutcome({ id: 'c1', exitCode: 0, command: ['node', 'v.mjs'] }))
      .toMatchObject({ id: 'c1', status: 'inconclusive', reason: 'evidence_missing' });
    expect(normalizeTodoLiveCheckOutcome({ id: 'c2', exitCode: 0, command: ['node', 'v.mjs'],
      evidence: { ref: 'checks/c2.json', content: 'ok' } }))
      .toMatchObject({ id: 'c2', status: 'passed' });
    expect(normalizeTodoLiveCheckOutcome({ id: 'c3', exitCode: 2, command: ['node', 'v.mjs'] }))
      .toMatchObject({ id: 'c3', status: 'failed' });
    expect(normalizeTodoLiveCheckOutcome({ id: 'c4', exitCode: null, command: ['node', 'v.mjs'] }))
      .toMatchObject({ id: 'c4', status: 'inconclusive', reason: 'exit_code_unavailable' });

    const delivery = await passedDelivery();
    const noCode = aggregateTodoLiveEvidence({
      delivery, requirements, code: { headCommit: null, headTree: null }, checks: [passingCheck],
    });
    expect(noCode.status).toBe('inconclusive');
    expect(noCode.statusReason).toBe('code_evidence_missing');
    expect(() => validateTodoLiveEvidenceReport(noCode, { delivery })).not.to.throw();

    const stripped = reseal({
      ...noCode, status: 'passed', statusReason: null,
      code: { headCommit: code.headCommit, headTree: code.headTree },
      tasks: noCode.tasks.map(task => ({ ...task, verificationRef: null })),
    });
    expect(() => validateTodoLiveEvidenceReport(stripped, { delivery })).toThrow(/status_propagation_invalid/);
  });

  it('[case:p08-2-f006-entry-not-run-report] 入口未授权时产出绑定需求身份的结构化 not_run 报告', () => {
    const entry = todoLiveNotRunEntryReport('explicit_approval_required');
    expect(entry).toMatchObject({ status: 'not_run', statusReason: 'explicit_approval_required' });
    const report = entry as TodoLiveEvidenceReport;
    expect(report.identity.projectId).toBeNull();
    expect(report.identity.requirementsVersion).toBe(P08_TODO_REQUIREMENTS_VERSION);
    expect(report.identity.requirementsDigest).toBe(
      createHash('sha256').update(readFileSync(join(REPO_ROOT, P08_TODO_REQUIREMENTS_PATH), 'utf8'), 'utf8').digest('hex'),
    );
    expect(report.manualPending).toEqual([
      { id: 'owner-live-approval', item: '负责人显式授权真实 Pi live 流程与预算', owner: 'owner' },
    ]);
    expect(() => validateTodoLiveEvidenceReport(report, {
      forbiddenValues: [readFileSync(join(REPO_ROOT, P08_TODO_REQUIREMENTS_PATH), 'utf8')],
    })).not.to.throw();
    expect(todoLiveRequirementsIdentity(REPO_ROOT).version).toBe(P08_TODO_REQUIREMENTS_VERSION);
  });

  it('[case:p08-2-f006-artifact-integrity] 制品以受控相对引用加完整性摘要登记并可复验', async () => {
    const root = await tempRoot();
    const delivery = await passedDelivery();
    const report = aggregateTodoLiveEvidence({
      delivery, requirements, code, checks: [passingCheck],
      artifacts: [{ ref: 'delivery-report.json', content: `${JSON.stringify(delivery)}\n` }],
    });
    for (const artifact of report.artifacts) {
      await mkdir(join(root, artifact.ref, '..'), { recursive: true });
      await writeFile(join(root, artifact.ref), artifact.ref === 'delivery-report.json'
        ? `${JSON.stringify(delivery)}\n` : '{"exitCode":0,"tests":7,"failed":0}\n');
    }
    expect(() => validateTodoLiveEvidenceReport(report, { delivery, artifactRoot: root })).not.to.throw();

    const saved = join(root, 'evidence-report.json');
    await saveTodoLiveEvidenceReport(saved, report);
    expect(JSON.parse(await readFile(saved, 'utf8'))).toEqual(report);

    await writeFile(join(root, 'checks', 'todo-delivery.json'), '{"exitCode":0,"tests":7,"failed":1}\n');
    expect(() => validateTodoLiveEvidenceReport(report, { delivery, artifactRoot: root }))
      .toThrow(/artifact_integrity_invalid/);
  });
});
