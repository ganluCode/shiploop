import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';
import { git } from '../../helpers/git-repo.ts';

type Case = Awaited<ReturnType<typeof openDeliveryVertical>>;
const cases: Case[] = [];
afterEach(async () => { for (const f of cases.splice(0)) await f.close(); });
async function open(options: Parameters<typeof openDeliveryVertical>[0] = {}) {
  const f = await openDeliveryVertical(options); cases.push(f); return f;
}
function taskHistory(f: Case) {
  return {
    tasks: f.db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    attempts: f.db.prepare('SELECT * FROM attempts ORDER BY id').all(),
    sessions: f.db.prepare('SELECT * FROM sessions ORDER BY id').all(),
  };
}
async function assertEvidence(f: Case) {
  const batches = f.db.prepare("SELECT * FROM verification_batches WHERE operation = 'FeatureVerification.full'").all() as { id: string; status: string }[];
  expect(batches.length).toBeGreaterThan(0);
  const outputArtifacts: { artifactId: string; sha256: string; sizeBytes: number; text: string }[] = [];
  for (const batch of batches) {
    const results = f.db.prepare('SELECT * FROM check_results WHERE batch_id = ?').all(batch.id) as {
      id: string; output_artifact_id: string; status: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0].output_artifact_id).toBeTruthy();
    const artifact = await f.core.artifactStore.getArtifact(f.fixture.projectId, results[0].output_artifact_id);
    expect(artifact.status).toBe('ready');
    const content = await f.core.artifactFileStore.openFinalRead({ projectId: f.fixture.projectId, artifactId: artifact.id, locator: artifact.locator });
    const chunks: Buffer[] = [];
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.toString()).toContain('SHIPLOOP_NODE_CHECK_RESULT=');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.contentHash);
    expect(bytes.length).toBe(artifact.sizeBytes);
    outputArtifacts.push({ artifactId: artifact.id, sha256: artifact.contentHash!, sizeBytes: bytes.length, text: bytes.toString() });
  }
  const events = f.db.prepare('SELECT event_type, COUNT(*) AS count FROM state_events GROUP BY event_type').all();
  const snapshot = f.db.serialize(), view = await f.query();
  expect(view.axes.tasks).toMatchObject({ allPassed: true, passed: 2 });
  expect(await f.query()).toEqual(view);
  expect(f.db.serialize()).toEqual(snapshot);
  expect(events).toContainEqual(expect.objectContaining({ event_type: 'task.approval.decided' }));
  expect(events).toContainEqual(expect.objectContaining({ event_type: expect.stringMatching(/^feature\.finaliz/) }));
  const head = f.head(), tree = git(['rev-parse', 'HEAD^{tree}'], f.root).trim();
  const parent = git(['show', '-s', '--format=%P', 'HEAD'], f.root).trim();
  if (head !== f.initialHead) expect(parent).toBe(f.initialHead);
  const commits = Number(git(['rev-list', '--count', `${f.initialHead}..HEAD`], f.root).trim());
  expect(commits).toBe(head === f.initialHead ? 0 : 1);
  const operations = f.db.prepare('SELECT id, status, expected_head, candidate_tree, actual_commit, actual_tree FROM git_operations').all();
  for (const operation of operations as { actual_commit: string | null; actual_tree: string | null }[]) {
    if (operation.actual_commit !== null) {
      expect(operation.actual_commit).toBe(head);
      expect(operation.actual_tree).toBe(tree);
    }
  }
  const eventCounts = new Map((events as { event_type: string; count: number }[]).map(row => [row.event_type, row.count]));
  expect(eventCounts.get('git.operation.registered') ?? 0).toBe(operations.length);
  expect(eventCounts.get('git.operation.settled') ?? 0).toBe((operations as { status: string }[]).filter(row => row.status !== 'pending').length);
  expect((eventCounts.get('feature.finalized') ?? 0) + (eventCounts.get('feature.finalization_blocked') ?? 0)).toBe(1);
  const evidence = { schemaVersion: 1, taskId: 'F-012', scenario: expect.getState().currentTestName ?? 'unknown',
    git: { head, tree, parent, commits, status: git(['status', '--porcelain=v1'], f.root) },
    tasks: f.db.prepare('SELECT id, status, execution_version FROM tasks ORDER BY id').all(),
    attempts: f.db.prepare('SELECT id, status FROM attempts ORDER BY id').all(),
    sessions: f.db.prepare('SELECT id, attempt_id, status, stopped_at FROM sessions ORDER BY id').all(),
    feature: f.db.prepare('SELECT status, delivery_status FROM features').get(),
    run: f.db.prepare('SELECT status FROM runs').get(),
    approvals: f.db.prepare('SELECT id, kind, status, decision, code_digest, decision_code_digest, plan_digest FROM task_approval_items ORDER BY id').all(),
    operations, batches: batches.map(({ id, status }) => ({ id, status })),
    checks: f.db.prepare("SELECT r.id, r.status, r.exit_code, r.output_artifact_id FROM check_results r JOIN verification_batches b ON b.id = r.batch_id WHERE b.operation = 'FeatureVerification.full'").all(),
    artifacts: f.db.prepare("SELECT a.id, a.status, a.content_hash, a.size_bytes FROM artifacts a JOIN check_results r ON r.output_artifact_id = a.id JOIN verification_batches b ON b.id = r.batch_id WHERE b.operation = 'FeatureVerification.full'").all(),
    events, calls: f.counts(), outputArtifacts };
  // Explicit evidence destination is test-only; ordinary runs create no repository files.
  const evidenceDir = process.env.SHIPLOOP_F012_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    const name = createHash('sha256').update(evidence.scenario).digest('hex').slice(0, 16);
    writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
}

describe('F-012 real Git/SQLite/FakeRuntime delivery assembly', () => {
  it('finishes a two-Task Feature through public commands, approval, real check/commit and read-only axes', async () => {
    const f = await open();
    const parent = f.head(), history = taskHistory(f);
    await f.approve();
    const result = await f.finalize();
    expect(result, JSON.stringify({ result, checks: f.diagnostics() })).toMatchObject({ status: 'completed',
      result: { outcome: 'completed', deliveryStatus: 'succeeded', runtimeCalled: false } });
    const operation = f.operations.getGitOperation(f.fixture.projectId, f.operationId)!;
    expect(operation).toMatchObject({ status: 'succeeded', actualCommit: f.head(), deliveryStatus: 'succeeded' });
    expect(git(['show', '-s', '--format=%P', f.head()], f.root).trim()).toBe(parent);
    expect(git(['rev-parse', 'HEAD^{tree}'], f.root).trim()).toBe(operation.actualTree);
    expect(operation.actualTree).toBe(operation.intent.candidateTree);
    expect(git(['show', 'HEAD:src/upstream.ts'], f.root)).toBe('upstream\n');
    expect(git(['status', '--porcelain'], f.root).trim()).toBe('');
    expect(taskHistory(f)).toEqual(history);
    expect(f.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
    expect(f.db.prepare('SELECT status, delivery_status FROM features WHERE id = ?').get(f.fixture.featureId))
      .toMatchObject({ status: 'completed', delivery_status: 'succeeded' });
    expect(f.db.prepare('SELECT status FROM runs WHERE id = ?').get(f.fixture.runId)).toMatchObject({ status: 'succeeded' });
    await assertEvidence(f);
    const before = f.db.serialize();
    const view = await f.query();
    expect(view).toMatchObject({ feature: { status: 'completed', deliveryStatus: 'succeeded' },
      axes: { tasks: { allPassed: true, passed: 2 }, verification: { status: 'passed' },
        approval: { status: 'approved' }, delivery: { status: 'succeeded' } } });
    const queried = await f.core.queryService.getGitOperation(f.owner, { projectId: f.fixture.projectId, operationId: f.operationId });
    expect(queried.operation.actualCommit).toBe(f.head());
    expect(f.db.serialize()).toEqual(before);
  });

  it('detects downstream damage only at the real final check and preserves both passed Tasks and files', async () => {
    const f = await open({ brokenDownstream: true });
    await f.approve();
    const history = taskHistory(f), head = f.head();
    const result = await f.finalize();
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed',
      result: { outcome: 'partial', reason: 'execution_failed', runtimeCalled: false } });
    expect(f.head()).toBe(head);
    expect(taskHistory(f)).toEqual(history);
    expect(readFileSync(join(f.root, 'src/upstream.ts'), 'utf8')).toBe('broken\n');
    expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('downstream\n');
    expect(f.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
    expect(f.db.prepare('SELECT id FROM git_operations WHERE id = ?').get(f.operationId)).toBeUndefined();
    expect(f.db.prepare("SELECT status FROM verification_batches WHERE operation = 'FeatureVerification.full'").get()).toMatchObject({ status: 'failed' });
    expect(f.db.prepare('SELECT status FROM features WHERE id = ?').get(f.fixture.featureId)).toMatchObject({ status: 'partial' });
    expect(f.db.prepare('SELECT status FROM runs WHERE id = ?').get(f.fixture.runId)).toMatchObject({ status: 'failed' });
    expect(existsSync(f.root)).toBe(true);
    await assertEvidence(f);
  });

  it.each(['changed', 'head', 'hook', 'commit-failed', 'receipt-fault', 'approval-stale', 'new-block'] as const)(
    'preserves Task history and worktree without Runtime re-entry on %s', async kind => {
      const f = await open();
      await f.approve();
      const history = taskHistory(f), parent = f.head();
      if (kind === 'hook') f.hook("printf 'hook edit\\n' > src/upstream.ts");
      if (kind === 'commit-failed') f.hook('exit 7');
      if (kind === 'receipt-fault') f.db.exec(`CREATE TRIGGER receipt_fault BEFORE UPDATE ON git_operations
        WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'injected receipt fault'); END`);
      f.afterVerify(() => {
        if (kind === 'changed') writeFileSync(join(f.root, 'src/upstream.ts'), 'after verification\n');
        if (kind === 'head') git(['-c', 'user.name=External', '-c', 'user.email=external@example.test',
          'commit', '--allow-empty', '-m', 'external HEAD'], f.root);
        if (kind === 'approval-stale') f.db.prepare("UPDATE task_approval_items SET decision_code_digest = ? WHERE feature_id = ?")
          .run('ff'.repeat(32), f.fixture.featureId);
        if (kind === 'new-block') f.insertItem('block');
      });
      const result = await f.finalize();
      expect(result.status, JSON.stringify(result)).toBe('completed');
      if (result.status !== 'completed') throw new Error(`Unexpected receipt: ${JSON.stringify(result)}`);
      expect(result.result).toMatchObject({ outcome: ['approval-stale', 'new-block'].includes(kind) ? 'awaiting_approval' : 'partial',
        runtimeCalled: false, executionStarted: false });
      expect(taskHistory(f)).toEqual(history);
      expect(f.db.prepare('SELECT status FROM features WHERE id = ?').get(f.fixture.featureId)).toMatchObject({
        status: ['approval-stale', 'new-block'].includes(kind) ? 'awaiting_approval' : 'partial',
      });
      expect(f.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
      expect(existsSync(f.root)).toBe(true);
      expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('downstream\n');
      expect(readFileSync(join(f.root, 'src/upstream.ts'), 'utf8')).toBe(kind === 'hook' ? 'hook edit\n'
        : kind === 'changed' ? 'after verification\n' : 'upstream\n');
      const hasCommit = ['head', 'hook', 'receipt-fault'].includes(kind);
      expect(git(['rev-list', '--count', `${parent}..HEAD`], f.root).trim()).toBe(hasCommit ? '1' : '0');
      if (hasCommit) expect(git(['show', '-s', '--format=%P', f.head()], f.root).trim()).toBe(parent);
      else expect(f.head()).toBe(parent);
      const row = f.db.prepare('SELECT status, actual_commit, actual_tree, candidate_tree, reason_code FROM git_operations WHERE id = ?')
        .get(f.operationId) as { status: string; actual_commit: string | null; actual_tree: string | null; candidate_tree: string } | undefined;
      if (kind === 'hook' || kind === 'commit-failed') {
        expect(row).toMatchObject({ status: 'failed', actual_commit: f.head() });
        expect(git(['rev-parse', 'HEAD^{tree}'], f.root).trim()).toBe(row!.actual_tree);
      } else if (kind === 'receipt-fault') {
        expect(row).toMatchObject({ status: 'pending', actual_commit: null, actual_tree: null });
        expect(git(['rev-parse', 'HEAD^{tree}'], f.root).trim()).toBe(row!.candidate_tree);
      } else expect(row).toBeUndefined();
      const run = f.db.prepare('SELECT status FROM runs WHERE id = ?').get(f.fixture.runId);
      expect(run).toMatchObject({ status: ['approval-stale', 'new-block'].includes(kind) ? 'paused' : 'failed' });
      await assertEvidence(f);
      const before = f.db.serialize(), view = await f.query();
      expect(view.axes.tasks.allPassed).toBe(true);
      expect(view.outcome.status).not.toBe('completed');
      expect(f.db.serialize()).toEqual(before);
    });

  it('records no_change with the existing real HEAD/tree and creates no empty commit', async () => {
    const f = await open({ noChange: true }); await f.approve();
    const head = f.head(), history = taskHistory(f);
    expect(await f.finalize()).toMatchObject({ result: { outcome: 'completed', deliveryStatus: 'succeeded' } });
    expect(f.operations.getGitOperation(f.fixture.projectId, f.operationId)).toMatchObject({
      status: 'no_change', actualCommit: head, actualTree: git(['rev-parse', 'HEAD^{tree}'], f.root).trim(),
      exitCode: null, durationMs: null,
    });
    expect(f.head()).toBe(head);
    expect(taskHistory(f)).toEqual(history);
    expect(f.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
    await assertEvidence(f);
  });

  it('coalesces duplicate commands and rejects a competing stale command without another commit', async () => {
    const f = await open(); await f.approve();
    const parent = f.head(), id = randomUUID(), history = taskHistory(f);
    const first = f.finalize(id), duplicate = f.finalize(id), competing = f.finalize();
    const results = await Promise.all([first, duplicate, competing]);
    expect(results[0]).toMatchObject({ status: 'completed', result: { outcome: 'completed' }, replayed: false });
    expect(results[1]).toMatchObject({ status: 'completed', result: { outcome: 'completed' }, replayed: true });
    expect(results[2]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    expect(f.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
    expect(git(['rev-list', '--count', `${parent}..HEAD`], f.root).trim()).toBe('1');
    expect(taskHistory(f)).toEqual(history);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM git_operations').get()).toMatchObject({ n: 1 });
    await assertEvidence(f);
  });
});
