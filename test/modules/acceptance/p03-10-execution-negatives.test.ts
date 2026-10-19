import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { withP03AcceptanceFixture, type P03Fixture } from '../../helpers/p03-10/acceptance-fixture.ts';

function select(f: P03Fixture, sql: string) {
  const probe = f.storageProbe();
  try { return probe.selectAll(sql); } finally { probe.close(); }
}

test('[case:persistent-check-failure] 首次及两次修复均失败后停止，保留代码、检查证据与父预算', async () => {
  expect(process.versions.node).toBe('22.19.0');
  const temporary = createTempSandbox('shiploop-f007-evidence-');
  const evidenceDir = process.env.P03_EVIDENCE_DIR
    ? resolve(process.env.P03_EVIDENCE_DIR, `persistent-check-failure-${randomUUID()}`) : temporary.path;
  mkdirSync(evidenceDir, { recursive: true });
  try {
    await withP03AcceptanceFixture({ evidenceDir, threeTaskChain: true, persistentCheckFailure: true }, async f => {
      await f.startExecution();
      const results = [];
      for (let number = 1; number <= 3; number++) {
        await expect.poll(() => f.rows('attempts').filter(attempt => attempt.task_id === 'chain-1'
          && attempt.number === number && attempt.status === 'verifying').length, { timeout: 25_000 }).toBe(1);
        const id = randomUUID();
        f.input('chain-control.json', { id, taskId: 'chain-1' });
        const path = join(f.root, `chain-result-${id}.json`);
        await expect.poll(() => existsSync(path), { timeout: 30_000 }).toBe(true);
        const result = JSON.parse(readFileSync(path, 'utf8'));
        f.saveEvidence(`failure-${number}.json`, result);
        expect(result.error, JSON.stringify(result)).toBeUndefined();
        expect(result.verification.status).toBe('failed');
        expect(result.completion).toMatchObject({ outcome: 'code_failure', stopConfirmed: true });
        expect(result.outputs.join('\n')).toContain('P03_PERSISTENT_CHECK_FAILURE');
        expect(result.beforeFiles['README.md']).toBe('chain-1\n' + 'repair\n'.repeat(number - 1));
        expect(result.beforeFiles['chain-2.txt']).toBe('retained marker\n' + 'repair\n'.repeat(number - 1));
        results.push(result);
      }
      await expect.poll(() => f.rows('tasks').find(task => task.id === 'chain-1')?.status,
        { timeout: 10_000 }).toBe('failed');
      const schedule = await f.cli<{ run: { status: string; reason: string };
        schedule: { reason: string; readyTaskIds: string[] }; readiness: { state: string };
        tasks: { taskId: string; status: string; reason: string; dependencyIds: string[]; latestAttempt: unknown }[] }>([
        'execution', 'schedule', f.ids.runId!, '--project', f.ids.projectId!]);
      expect(schedule.run).toMatchObject({ status: 'paused', reason: 'code_attempts_exhausted' });
      expect(schedule.schedule).toMatchObject({ reason: 'run_control_blocked', readyTaskIds: [] });
      expect(schedule.readiness.state).toBe('blocked');
      expect(schedule.tasks.find(task => task.taskId === 'chain-2')).toMatchObject({
        status: 'pending', reason: 'run_control_blocked', dependencyIds: ['chain-1'], latestAttempt: null });
      expect(f.rows('features')[0]?.status).not.toBe('completed');
      expect(f.rows('attempts')).toHaveLength(3);
      expect(f.rows('attempts').every(attempt => attempt.task_id === 'chain-1' && attempt.status === 'failed')).toBe(true);
      expect(new Set(results.map(result => result.attemptId)).size).toBe(3);
      expect(new Set(results.map(result => result.workspaceId)).size).toBe(1);
      expect(f.rows('verification_batches').map(batch => batch.status)).toEqual(['failed', 'failed', 'failed']);
      const checks = select(f, 'SELECT status, exit_code, timed_out, output_artifact_id FROM check_results');
      expect(checks).toHaveLength(3);
      for (const result of results) expect(checks).toContainEqual({ status: 'failed', exit_code: 1, timed_out: 0,
        output_artifact_id: result.verification.results[0].evidence.output.artifactId });
      const counters = select(f, 'SELECT runs_created, attempts_created, runtime_starts FROM execution_batches');
      expect(counters).toEqual([{ runs_created: 1, attempts_created: 3, runtime_starts: 3 }]);
      expect(select(f, "SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = 'chain-1'"))
        .toEqual([{ attempt_counter: 3, code_attempts_used: 3 }]);
      expect(f.rows('sessions')).toHaveLength(3);
      expect(f.rows('sessions').every(session => session.status === 'stopped')).toBe(true);
      expect(f.rows('workspace_leases')).toEqual([]);
      expect(f.rows('git_operations')).toEqual([]);
      const workspace = select(f, 'SELECT canonical_path FROM managed_workspaces')[0]!.canonical_path as string;
      expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('chain-1\nrepair\nrepair\n');
      expect(readFileSync(join(workspace, 'chain-2.txt'), 'utf8')).toBe('retained marker\nrepair\nrepair\n');
      const gitStatus = execFileSync('git', ['status', '--porcelain=v1'], { cwd: workspace, encoding: 'utf8' });
      expect(gitStatus).toContain(' M README.md');
      expect(gitStatus).toContain('?? chain-2.txt');
      const starts = JSON.parse(readFileSync(join(f.root, 'chain-starts.json'), 'utf8'));
      expect(starts.map((start: { taskId: string }) => start.taskId)).toEqual(['chain-1', 'chain-1', 'chain-1']);
      const replaySnapshot = () => ({ attempts: f.rows('attempts'), sessions: f.rows('sessions'),
        runs: f.rows('runs'), events: f.rows('state_events'), receipts: f.rows('command_receipts'),
        counters: select(f, 'SELECT runs_created, attempts_created, runtime_starts FROM execution_batches'),
        starts: JSON.parse(readFileSync(join(f.root, 'chain-starts.json'), 'utf8')) });
      const beforeReplay = replaySnapshot();
      await f.replayExecutionStart();
      expect(replaySnapshot()).toEqual(beforeReplay);
      f.saveEvidence('persistent-failure-summary.json', { schedule, counters, starts, gitStatus,
        attempts: f.rows('attempts'), tasks: f.rows('tasks'), checks: f.rows('check_results') });
    });
    expect(JSON.parse(readFileSync(join(evidenceDir, 'cleanup.json'), 'utf8'))).toMatchObject({
      status: 'passed', resourcesRemoved: true, processTreeStopped: true, processGroupsStopped: true });
  } finally { temporary.cleanup(); }
}, 150_000);
