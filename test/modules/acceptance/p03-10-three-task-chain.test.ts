import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { withP03AcceptanceFixture, type P03Fixture } from '../../helpers/p03-10/acceptance-fixture.ts';

beforeAll(() => {
  expect(process.versions.node, 'Run with the pinned Node 22.19.0 PATH').toBe('22.19.0');
  if (process.env.P03_USE_BUILT_DIST !== '1') {
    execFileSync('npm', ['run', 'build'], { timeout: 540_000, stdio: 'inherit' });
  }
}, 570_000);

function select(f: P03Fixture, sql: string, parameters: readonly unknown[] = []) {
  const probe = f.storageProbe();
  try { return probe.selectAll(sql, parameters); } finally { probe.close(); }
}

function exactCount(f: P03Fixture, table: 'artifacts' | 'state_events' | 'command_receipts') {
  return Number(select(f, `SELECT COUNT(*) AS n FROM ${table}`)[0]!.n);
}

async function verify(f: P03Fixture, taskId: string) {
  try {
    await expect.poll(() => select(f, `SELECT id FROM attempts WHERE task_id = '${taskId}' AND status = 'verifying'`).length,
      { timeout: 20_000 }).toBe(1);
  } catch (error) {
    let hostDiagnostics: unknown;
    try { hostDiagnostics = await f.cli(['execution', 'schedule', f.ids.runId!, '--project', f.ids.projectId!]); }
    catch (diagnosticError) { hostDiagnostics = { error: String(diagnosticError) }; }
    const diagnostic = { taskId, error: String(error), hostDiagnostics,
      tasks: f.rows('tasks'), runs: f.rows('runs'), attempts: f.rows('attempts'),
      workspaces: f.rows('managed_workspaces'), workspaceOperations: f.rows('workspace_operations'),
      gitOperations: f.rows('git_operations'), leases: f.rows('workspace_leases'),
      events: f.rows('state_events'),
    };
    f.saveEvidence(`wait-failed-${taskId}-${randomUUID()}.json`, diagnostic);
    process.stderr.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    throw error;
  }
  const before = {
    tasks: f.rows('tasks'), attempts: f.rows('attempts'), runs: f.rows('runs'),
    workspaces: f.rows('managed_workspaces'), leases: f.rows('workspace_leases'),
    verificationBatches: f.rows('verification_batches'), events: f.rows('state_events'),
  };
  expect(before.tasks.find(task => task.id === taskId)?.status).toBe('running');
  const successor = taskId === 'chain-1' ? 'chain-2' : taskId === 'chain-2' ? 'chain-3' : null;
  if (successor) expect(before.attempts.filter(attempt => attempt.task_id === successor)).toEqual([]);
  const id = randomUUID();
  f.input('chain-control.json', { id, taskId });
  const resultPath = join(f.root, `chain-result-${id}.json`);
  await expect.poll(() => existsSync(resultPath), { timeout: 40_000 }).toBe(true);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  f.saveEvidence(`stage-${id}.json`, { before, ...result });
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  return result;
}

test('[case:task-commit-boundary] 三 Task 真实检查、受控提交、失败返工与 Feature 最终交付', async () => {
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
      expect(repaired.completion.receipt).toMatchObject({ disposition: 'applied', status: 'succeeded' });
      const third = await verify(f, 'chain-3');
      expect(third.verification.status).toBe('passed');
      expect(third.completion.receipt).toMatchObject({ disposition: 'applied', status: 'succeeded' });
      const approvalStage = third.finalization;
      expect(approvalStage).toMatchObject({ verification: { status: 'passed' },
        approval: { valid: false, reason: 'approval_required' },
        finalization: { outcome: 'awaiting_approval', deliveryStatus: 'not_requested' },
        delivery: null, reconciliation: null });
      const requested = approvalStage.approvalRequest;
      const approvalCreated = await f.cli<{ item: { id: string; revision: number } }>([
        'task', 'block', requested.taskId, '--project', f.ids.projectId!, '--kind', 'approval',
        '--digest', requested.planDigest, '--code-digest', requested.codeDigest,
        '--revision', String(f.rows('tasks').find(task => task.id === requested.taskId)!.revision),
        '--description', 'Explicit approval of the final verified three Task chain',
      ]);
      const item = approvalCreated.item;
      const holdCreated = await f.cli<{ item: { id: string; revision: number } }>([
        'task', 'block', requested.taskId, '--project', f.ids.projectId!, '--kind', 'block',
        '--digest', requested.planDigest, '--code-digest', requested.codeDigest,
        '--revision', String(f.rows('tasks').find(task => task.id === requested.taskId)!.revision),
        '--description', 'Explicit final delivery hold until human approval is confirmed',
      ]);
      const beforeApproval = { attempts: f.rows('attempts').length, sessions: f.rows('sessions').length,
        operations: f.rows('git_operations').length, verification: f.rows('verification_batches').length };
      const approved = await f.cli(['feature', 'final-approve', f.ids.featureId!, '--project', f.ids.projectId!,
        '--task', requested.taskId, '--item', item.id, '--digest', requested.planDigest,
        '--code-digest', requested.codeDigest, '--revision', String(item.revision), '--confirm']);
      expect(f.rows('runs')[0]?.status).toBe('paused');
      expect({ attempts: f.rows('attempts').length, sessions: f.rows('sessions').length,
        operations: f.rows('git_operations').length, verification: f.rows('verification_batches').length }).toEqual(beforeApproval);
      const unblocked = await f.cli(['task', 'unblock', requested.taskId, holdCreated.item.id,
        '--project', f.ids.projectId!, '--digest', requested.planDigest, '--code-digest', requested.codeDigest,
        '--revision', String(holdCreated.item.revision)]);
      expect(select(f, "SELECT manual_block FROM tasks WHERE id = 'chain-3'")[0]!.manual_block).toBe(0);
      const finalized = await f.cli(['feature', 'finalize', f.ids.featureId!, '--project', f.ids.projectId!,
        '--run', f.ids.runId!, '--batch', f.ids.batchId!, '--operation', approvalStage.finalization.operationId,
        '--revision', String(f.rows('features')[0]!.revision), '--confirm']);
      const finishId = randomUUID();
      f.input('chain-control.json', { id: finishId, taskId: 'chain-3', action: 'state' });
      const finishPath = join(f.root, `chain-result-${finishId}.json`);
      await expect.poll(() => existsSync(finishPath), { timeout: 40_000 }).toBe(true);
      const finished = JSON.parse(readFileSync(finishPath, 'utf8'));
      f.saveEvidence('feature-approval-and-finish.json', { approvalStage, approvalCreated, holdCreated,
        approved, unblocked, finalized, finished, beforeApproval });
      expect(finished.error, JSON.stringify(finished)).toBeUndefined();
      third.finalization = finished.finalization;
      expect(first.completion.stopConfirmed).toBe(true);
      expect(repaired.completion.stopConfirmed).toBe(true);
      expect(third.completion.stopConfirmed).toBe(true);
      const startsPath = join(f.root, 'chain-starts.json');
      const starts = JSON.parse(readFileSync(startsPath, 'utf8'));
      expect(starts.map((start: { taskId: string }) => start.taskId)).toEqual(['chain-1', 'chain-2', 'chain-2', 'chain-3']);
      await expect.poll(() => ({
        feature: f.rows('features')[0]?.status, run: f.rows('runs')[0]?.status,
        batch: f.rows('execution_batches')[0]?.status,
      }), { timeout: 20_000 }).toEqual({ feature: 'completed', run: 'succeeded', batch: 'succeeded' });
      expect(f.rows('features')[0]?.delivery_status).toBe('succeeded');
      expect(third.finalization).toMatchObject({
        verification: { status: 'passed', operation: 'FeatureVerification.full', invalidated: false,
          checks: [{ checkKey: 'chain', status: 'passed', testCount: 3 }] },
        approval: { valid: true }, reconciliation: { matched: true, reasonCode: null },
        finalization: { outcome: 'completed', deliveryStatus: 'succeeded' },
        codingConsumerStopped: { closed: true, pendingAttemptIds: [] },
        scheduler: { closed: false, runs: [{ reason: 'all_passed', capabilityGaps: [], claimed: false }] },
      });
      expect(third.finalization.verification.outputs.join('\n')).toContain('PASS chain checks');
      const counts = () => ({
        attempts: f.rows('attempts').length, sessions: f.rows('sessions').length,
        events: exactCount(f, 'state_events'), commits: f.rows('git_operations').length,
        receipts: exactCount(f, 'command_receipts'),
        batches: f.rows('execution_batches').length, runs: f.rows('runs').length,
        verificationBatches: f.rows('verification_batches').length, checks: f.rows('check_results').length,
        artifacts: exactCount(f, 'artifacts'),
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
      const taskCommits = operations.filter(operation => operation.operation_type === 'task_commit');
      expect(taskCommits).toHaveLength(3);
      expect(taskCommits.some(operation => operation.attempt_id === failed.attemptId)).toBe(false);
      for (const stage of [first, repaired, third]) {
        const matches = taskCommits.filter(operation => operation.attempt_id === stage.attemptId);
        expect(matches).toHaveLength(1);
        expect(['succeeded', 'no_change']).toContain(matches[0]!.status);
        expect(stage.afterGit.status).toBe('');
        expect(stage.afterGit.head).not.toBe(stage.beforeGit.head);
        expect(matches[0]!.actual_commit).toBe(stage.afterGit.head);
        expect(matches[0]!.actual_tree).toBe(stage.afterGit.tree);
        expect(matches[0]!.expected_head).toBe(stage.beforeGit.head);
      }
      expect(failed.afterGit.head).toBe(failed.beforeGit.head);
      expect(failed.afterGit.tree).toBe(failed.beforeGit.tree);
      expect(failed.afterGit.status).toBe(failed.beforeGit.status);
      expect(failed.beforeGit.head).toBe(first.afterGit.head);
      expect(repaired.beforeGit.head).toBe(first.afterGit.head);
      expect(third.beforeGit.head).toBe(repaired.afterGit.head);
      const featureCommits = operations.filter(operation => operation.operation_type === 'feature_final_commit');
      expect(featureCommits).toHaveLength(1);
      expect(featureCommits[0]!.status).toBe('no_change');
      expect(operations).toHaveLength(4);
      const workspace = select(f, 'SELECT canonical_path FROM managed_workspaces')[0]!;
      const git = (args: string[]) => execFileSync('git', args, {
        cwd: String(workspace.canonical_path), encoding: 'utf8', timeout: 5000,
      }).trimEnd();
      const finalGit = { head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
        status: git(['status', '--porcelain=v1']),
        commitsSinceStart: Number(git(['rev-list', '--count', `${first.beforeGit.head}..HEAD`])),
        files: Object.fromEntries(['README.md', 'chain-2.txt', 'chain-3.txt'].map(path => [path, git(['show', `HEAD:${path}`])])),
        parents: [first, repaired, third].map(stage => ({ commit: stage.afterGit.head,
          parent: git(['rev-parse', `${stage.afterGit.head}^`]), tree: git(['rev-parse', `${stage.afterGit.head}^{tree}`]) })),
      };
      expect(finalGit.head).toBe(third.afterGit.head);
      expect(finalGit.tree).toBe(third.afterGit.tree);
      expect(finalGit.status).toBe('');
      expect(finalGit.commitsSinceStart).toBe(3);
      expect(finalGit.files).toEqual({ 'README.md': 'chain-1\nchain-2-first\nchain-2-repaired',
        'chain-2.txt': 'retained marker\nrepaired', 'chain-3.txt': 'chain-3' });
      expect(finalGit.parents.map(entry => entry.parent)).toEqual([
        first.beforeGit.head, first.afterGit.head, repaired.afterGit.head,
      ]);
      expect(finalGit.parents.map(entry => entry.tree)).toEqual([first.afterGit.tree, repaired.afterGit.tree, third.afterGit.tree]);
      expect(featureCommits[0]!.candidate_tree).toBe(finalGit.tree);
      expect(featureCommits[0]!.expected_head).toBe(finalGit.head);
      expect(f.rows('workspace_leases')).toEqual([]);
      expect(f.rows('sessions')).toHaveLength(4);
      expect(f.rows('sessions').every(session => session.status === 'stopped')).toBe(true);
      const featureVerification = f.rows('verification_batches').filter(batch => batch.operation === 'FeatureVerification.full');
      expect(featureVerification).toHaveLength(1);
      expect(featureVerification[0]).toMatchObject({ id: third.finalization.verification.batchId,
        status: 'passed', run_id: f.ids.runId, feature_id: f.ids.featureId });
      const featureChecks = f.rows('check_results').filter(check => check.batch_id === featureVerification[0]!.id);
      const featureCheck = third.finalization.verification.checks[0];
      expect(featureChecks).toHaveLength(1);
      expect(featureChecks[0]).toMatchObject({ id: featureCheck.resultId,
        status: 'passed', output_artifact_id: featureCheck.outputArtifactId });
      const featureOutputArtifact = select(f, 'SELECT id, status FROM artifacts WHERE id = ?', [featureCheck.outputArtifactId]);
      expect(featureOutputArtifact).toEqual([{ id: featureCheck.outputArtifactId, status: 'ready' }]);
      const report = {
        taskId: 'F-003', status: 'passed', missingEvidence: [], finalGit,
        reason: 'three_tasks_committed_and_feature_finalized',
        stages: [first, failed, repaired, third], starts, executionStartReplay: { before: beforeReplay, after: afterReplay },
        missingTaskCommitAttemptIds: [], taskCommits,
        featureVerification, featureChecks, featureOutputArtifact, featureFinalization: third.finalization, approvalStage,
        tasks: f.rows('tasks'), attempts: f.rows('attempts'), runs: f.rows('runs'),
        batches: f.rows('execution_batches'), gitOperations: operations,
      };
      f.saveEvidence('three-task-chain.json', report);
    });
    expect(existsSync(root)).toBe(false);
    expect(JSON.parse(readFileSync(join(evidenceDir, 'cleanup.json'), 'utf8')))
      .toMatchObject({ status: 'passed', resourcesRemoved: true, processTreeStopped: true, processGroupsStopped: true });
    const report = JSON.parse(readFileSync(join(evidenceDir, 'three-task-chain.json'), 'utf8'));
    process.stdout.write(`${JSON.stringify({ case: 'P03-10 F003', status: report.status,
      evidenceDir: process.env.P03_EVIDENCE_DIR ? evidenceDir : '<temporary; removed after test>',
      taskCommits: report.taskCommits, finalGit: report.finalGit,
      featureVerification: report.featureVerification, featureDelivery: report.featureFinalization.delivery,
      reconciliation: report.featureFinalization.reconciliation,
      feature: report.featureFinalization.finalization.feature.status,
      run: report.runs[0].status, batch: report.batches[0].status,
      replay: report.executionStartReplay,
      cleanup: JSON.parse(readFileSync(join(evidenceDir, 'cleanup.json'), 'utf8')),
    }, null, 2)}\n`);
  } finally { temporaryEvidence.cleanup(); }
}, 300_000);
