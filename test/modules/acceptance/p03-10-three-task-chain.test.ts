import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { withP03AcceptanceFixture, type P03Fixture } from '../../helpers/p03-10/acceptance-fixture.ts';

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { timeout: 540_000, stdio: 'inherit' });
}, 570_000);

function select(f: P03Fixture, sql: string) {
  const probe = f.storageProbe();
  try { return probe.selectAll(sql); } finally { probe.close(); }
}

async function verify(f: P03Fixture, taskId: string) {
  await expect.poll(() => select(f, `SELECT id FROM attempts WHERE task_id = '${taskId}' AND status = 'verifying'`).length,
    { timeout: 20_000 }).toBe(1);
  const before = {
    tasks: f.rows('tasks'), attempts: f.rows('attempts'), runs: f.rows('runs'),
    verificationBatches: f.rows('verification_batches'), events: f.rows('state_events'),
  };
  expect(before.tasks.find(task => task.id === taskId)?.status).toBe('running');
  const successor = taskId === 'chain-1' ? 'chain-2' : taskId === 'chain-2' ? 'chain-3' : null;
  if (successor) expect(before.attempts.filter(attempt => attempt.task_id === successor)).toEqual([]);
  const id = randomUUID();
  f.input('chain-control.json', { id, taskId });
  const resultPath = join(f.root, `chain-result-${id}.json`);
  await expect.poll(() => existsSync(resultPath), { timeout: 20_000 }).toBe(true);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  f.saveEvidence(`stage-${id}.json`, { before, ...result });
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  return result;
}

test('[case:task-commit-boundary] 构建三 Task 链的真实检查与返工；缺少 Task 提交证据必须判演示失败', async () => {
  const temporaryEvidence = createTempSandbox('shiploop-f003-evidence-');
  const evidenceDir = process.env.P03_EVIDENCE_DIR
    ? resolve(process.env.P03_EVIDENCE_DIR, `three-task-chain-${randomUUID()}`) : temporaryEvidence.path;
  mkdirSync(evidenceDir, { recursive: true });
  let root = '';
  try {
    await withP03AcceptanceFixture({ evidenceDir, threeTaskChain: true }, async f => {
      root = f.root;
      expect(f.rows('tasks').map(row => row.id).sort()).toEqual(['chain-1', 'chain-2', 'chain-3']);
      expect(f.rows('attempts')).toEqual([]);
      await f.startExecution();
      const first = await verify(f, 'chain-1');
      expect(first.verification.status).toBe('passed');
      expect(first.completion.receipt, JSON.stringify(first.completion)).toMatchObject({ disposition: 'applied', status: 'succeeded' });
      const failed = await verify(f, 'chain-2');
      expect(failed.verification.status).toBe('failed');
      expect(failed.completion).toMatchObject({ outcome: 'code_failure', stopConfirmed: true });
      expect(failed.beforeGit.status).toContain(' M README.md');
      expect(failed.beforeGit.status).toContain('?? chain-2.txt');
      expect(failed.outputs.join('\n')).toContain('expected repaired chain-2');
      expect(select(f, "SELECT id FROM attempts WHERE task_id = 'chain-3'")).toEqual([]);
      const repaired = await verify(f, 'chain-2');
      expect(repaired.attemptId).not.toBe(failed.attemptId);
      expect(repaired.workspaceId).toBe(failed.workspaceId);
      expect(repaired.beforeFiles['chain-2.txt']).toBe('retained marker\nrepaired\n');
      expect(repaired.beforeFiles['README.md']).toBe('chain-1\nchain-2-first\nchain-2-repaired\n');
      expect(repaired.verification.status).toBe('passed');
      const third = await verify(f, 'chain-3');
      expect(third.verification.status).toBe('passed');
      expect(first.completion.stopConfirmed).toBe(true);
      expect(repaired.completion.stopConfirmed).toBe(true);
      expect(third.completion.stopConfirmed).toBe(true);
      const startsPath = join(f.root, 'chain-starts.json');
      const starts = JSON.parse(readFileSync(startsPath, 'utf8'));
      expect(starts.map((start: { taskId: string }) => start.taskId)).toEqual(['chain-1', 'chain-2', 'chain-2', 'chain-3']);
      await expect.poll(() => f.rows('runs')[0]?.reason, { timeout: 5000 }).toBe('scheduler_capability_missing');
      const counts = () => ({
        attempts: f.rows('attempts').length, sessions: f.rows('sessions').length,
        events: f.rows('state_events').length, commits: f.rows('git_operations').length,
        receipts: f.rows('command_receipts').length,
        batches: f.rows('execution_batches').length, runs: f.rows('runs').length,
        starts: JSON.parse(readFileSync(startsPath, 'utf8')).length,
      });
      const beforeReplay = counts();
      await f.replayExecutionStart();
      const afterReplay = counts();
      expect(afterReplay).toEqual(beforeReplay);
      expect(f.rows('tasks').map(row => row.status)).toEqual(['passed', 'passed', 'passed']);
      expect(select(f, 'SELECT id, attempt_counter, code_attempts_used FROM tasks ORDER BY id')).toEqual([
        { id: 'chain-1', attempt_counter: 1, code_attempts_used: 1 },
        { id: 'chain-2', attempt_counter: 2, code_attempts_used: 2 },
        { id: 'chain-3', attempt_counter: 1, code_attempts_used: 1 },
      ]);
      const inputs = select(f, "SELECT id, input_ref, input_snapshot FROM attempts WHERE task_id = 'chain-2' ORDER BY number");
      expect(inputs).toHaveLength(2);
      expect(inputs[0]!.input_ref).not.toBe(inputs[1]!.input_ref);
      expect(failed.inputManifest).not.toEqual(repaired.inputManifest);
      expect(repaired.inputText).toContain('retained marker');
      const operations = f.rows('git_operations');
      const missingTaskCommits = [first, repaired, third].filter(stage =>
        !operations.some(operation => operation.attempt_id === stage.attemptId && operation.status === 'succeeded'));
      const workspace = select(f, 'SELECT canonical_path FROM managed_workspaces')[0]!;
      const git = (args: string[]) => execFileSync('git', args, {
        cwd: String(workspace.canonical_path), encoding: 'utf8', timeout: 5000,
      }).trimEnd();
      const finalGit = { head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
        status: git(['status', '--porcelain=v1']) };
      const missingEvidence = [
        ...missingTaskCommits.map(stage => `task_commit:${stage.attemptId}`),
        'feature_full_verification', 'feature_finalization',
      ];
      const report = {
        taskId: 'F-003', status: missingEvidence.length > 0 ? 'failed' : 'passed',
        missingEvidence, finalGit,
        reason: 'task_passed_without_controlled_commit',
        stages: [first, failed, repaired, third], starts, executionStartReplay: { before: beforeReplay, after: afterReplay },
        missingTaskCommitAttemptIds: missingTaskCommits.map(stage => stage.attemptId),
        featureVerification: 'not_run', featureFinalization: 'not_run',
        tasks: f.rows('tasks'), attempts: f.rows('attempts'), runs: f.rows('runs'),
        batches: f.rows('execution_batches'), gitOperations: operations,
      };
      // This is a blocker regression, not a successful F-003 acceptance. Never
      // reinterpret the real Core's premature passed state as demonstration success.
      expect(report.status).toBe('failed');
      expect(missingTaskCommits).toHaveLength(3);
      expect(operations).toEqual([]);
      expect(finalGit.head).toBe(first.beforeGit.head);
      expect(finalGit.tree).toBe(first.beforeGit.tree);
      expect(finalGit.status).toContain(' M README.md');
      expect(finalGit.status).toContain('?? chain-2.txt');
      expect(finalGit.status).toContain('?? chain-3.txt');
      f.saveEvidence('three-task-chain.json', report);
    });
    expect(existsSync(root)).toBe(false);
    expect(JSON.parse(readFileSync(join(evidenceDir, 'cleanup.json'), 'utf8')))
      .toMatchObject({ status: 'passed', resourcesRemoved: true, processTreeStopped: true, processGroupsStopped: true });
  } finally { temporaryEvidence.cleanup(); }
}, 150_000);
