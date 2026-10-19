import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { withP03AcceptanceFixture, type P03Fixture } from '../../helpers/p03-10/acceptance-fixture.ts';

// Reuse the explicitly built Node 22 artifacts; this file never builds or seeds state.
function select<T extends object = Record<string, unknown>>(f: P03Fixture, sql: string, parameters: readonly string[] = []): T[] {
  const probe = f.storageProbe();
  try { return probe.selectAll<T>(sql, [...parameters]); } finally { probe.close(); }
}

function snapshot(f: P03Fixture) {
  return { tasks: f.rows('tasks'), attempts: f.rows('attempts'), runs: f.rows('runs'),
    batches: f.rows('execution_batches'), leases: f.rows('workspace_leases'),
    operations: f.rows('git_operations'), verification: f.rows('verification_batches'),
    checks: f.rows('check_results'), sessions: f.rows('sessions'),
    starts: existsSync(join(f.root, 'chain-starts.json'))
      ? JSON.parse(readFileSync(join(f.root, 'chain-starts.json'), 'utf8')) : [],
  };
}

async function withNegativeFixture(name: string, body: (f: P03Fixture) => Promise<void>) {
  expect(process.versions.node, 'Run with the pinned Node 22.19.0 PATH').toBe('22.19.0');
  const temporary = createTempSandbox('shiploop-f003-negative-evidence-');
  const evidenceDir = process.env.P03_EVIDENCE_DIR
    ? resolve(process.env.P03_EVIDENCE_DIR, `task-commit-${name}-${randomUUID()}`) : temporary.path;
  mkdirSync(evidenceDir, { recursive: true });
  let root = '';
  try {
    await withP03AcceptanceFixture({ evidenceDir, threeTaskChain: true }, async f => {
      root = f.root;
      try { await body(f); }
      finally {
        let hostDiagnostics: unknown;
        try { hostDiagnostics = await f.cli(['execution', 'schedule', f.ids.runId!, '--project', f.ids.projectId!]); }
        catch (error) { hostDiagnostics = { error: String(error) }; }
        f.saveEvidence('negative-final-state.json', { node: process.version, name, ...snapshot(f), hostDiagnostics });
      }
    });
    expect(existsSync(root)).toBe(false);
    const cleanup = JSON.parse(readFileSync(join(evidenceDir, 'cleanup.json'), 'utf8'));
    expect(cleanup).toMatchObject({ status: 'passed', resourcesRemoved: true,
      processTreeStopped: true, processGroupsStopped: true });
    process.stdout.write(`${JSON.stringify({ case: `P03-10 F003 ${name}`, status: 'passed', node: process.version,
      evidenceDir: process.env.P03_EVIDENCE_DIR ? evidenceDir : '<temporary>', cleanup })}\n`);
  } finally { temporary.cleanup(); }
}

async function prepareFirst(f: P03Fixture) {
  await f.startExecution();
  await expect.poll(() => f.rows('attempts').filter(attempt => attempt.task_id === 'chain-1'
    && attempt.status === 'verifying').length, { timeout: 25_000 }).toBe(1);
  const workspace = select<{ canonical_path: string; git_common_dir: string }>(f,
    'SELECT canonical_path, git_common_dir FROM managed_workspaces')[0]!;
  const git = (args: string[]) => execFileSync('git', args, { cwd: workspace.canonical_path,
    encoding: 'utf8', timeout: 5000 }).trimEnd();
  const retained = join(workspace.canonical_path, 'negative-retained.txt');
  writeFileSync(retained, 'retain untracked negative evidence\n');
  const initial = { head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
    tracked: readFileSync(join(workspace.canonical_path, 'README.md'), 'utf8'),
    untracked: readFileSync(retained, 'utf8'), state: snapshot(f) };
  expect(initial.tracked).toBe('chain-1\n');
  expect(initial.state.leases).toHaveLength(3);
  return { workspace, git, retained, initial };
}

async function completeFirst(f: P03Fixture) {
  const id = randomUUID();
  f.input('chain-control.json', { id, taskId: 'chain-1' });
  const resultPath = join(f.root, `chain-result-${id}.json`);
  await expect.poll(() => existsSync(resultPath), { timeout: 40_000 }).toBe(true);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  f.saveEvidence('negative-completion.json', result);
  // A commit failure must not be confused with the checker failing or not running.
  const verification = f.rows('verification_batches');
  expect(verification).toHaveLength(1);
  expect(verification[0]).toMatchObject({ task_id: 'chain-1', operation: 'task.verify.checks', status: 'passed' });
  const checks = f.rows('check_results');
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ batch_id: verification[0]!.id, status: 'passed' });
  return result;
}

async function assertRetained(f: P03Fixture, scene: Awaited<ReturnType<typeof prepareFirst>>) {
  // Observe beyond two scheduler intervals: no delayed dependency admission is allowed.
  await delay(2200);
  const after = snapshot(f);
  expect(after.tasks.find(task => task.id === 'chain-1')?.status).toBe('running');
  expect(after.tasks.filter(task => task.id !== 'chain-1').map(task => task.status)).toEqual(['pending', 'pending']);
  expect(after.attempts).toHaveLength(1);
  expect(after.attempts[0]).toMatchObject({ task_id: 'chain-1', status: 'verifying' });
  expect(after.starts.map((start: { taskId: string }) => start.taskId)).toEqual(['chain-1']);
  expect(after.sessions).toHaveLength(1);
  expect(after.sessions[0]?.status).toBe('stopped');
  expect(after.leases).toHaveLength(3);
  expect(after.leases.map(lease => lease.id).sort()).toEqual(scene.initial.state.leases.map(lease => lease.id).sort());
  expect(after.leases.every(lease => lease.owner_id === after.attempts[0]!.id && lease.state === 'held')).toBe(true);
  expect(scene.git(['rev-parse', 'HEAD'])).toBe(scene.initial.head);
  expect(scene.git(['rev-parse', 'HEAD^{tree}'])).toBe(scene.initial.tree);
  expect(readFileSync(join(scene.workspace.canonical_path, 'README.md'), 'utf8')).toBe(scene.initial.tracked);
  expect(readFileSync(scene.retained, 'utf8')).toBe(scene.initial.untracked);
  expect(scene.git(['status', '--porcelain=v1'])).toContain('README.md');
  expect(scene.git(['status', '--porcelain=v1'])).toContain('negative-retained.txt');
  f.saveEvidence('negative-retained-scene.json', { initial: scene.initial, after,
    git: { head: scene.git(['rev-parse', 'HEAD']), tree: scene.git(['rev-parse', 'HEAD^{tree}']),
      status: scene.git(['status', '--porcelain=v1']) } });
  return after;
}

test('真实 pre-commit exit 1：绿色检查不得完成 Task，保留 leases/现场且后继零启动', async () => {
  await withNegativeFixture('hook-rejected', async f => {
    const scene = await prepareFirst(f);
    const marker = join(f.root, 'commit-hook-invoked');
    const hooks = join(scene.workspace.git_common_dir, 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-commit');
    const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
    writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' invoked > ${quotedMarker}\nprintf '%s\\n' P03_TASK_COMMIT_HOOK_REJECTED >&2\nexit 1\n`);
    chmodSync(hook, 0o755);
    const result = await completeFirst(f);
    expect(result.error).toContain('task_commit_failed');
    expect(readFileSync(marker, 'utf8')).toBe('invoked\n');
    const after = await assertRetained(f, scene);
    expect(after.operations).toHaveLength(1);
    expect(after.operations[0]).toMatchObject({ operation_type: 'task_commit', status: 'failed', actual_commit: scene.initial.head });
  });
}, 110_000);

test('验证前经 CLI 撤掉确认 Git 身份：拒绝提交，不使用本机隐式身份', async () => {
  await withNegativeFixture('identity-missing', async f => {
    const scene = await prepareFirst(f);
    const payload = JSON.parse(readFileSync(join(f.root, 'project-config.json'), 'utf8'));
    delete payload.policies.deliveryPolicy.gitIdentity;
    const settings = select<{ revision: number }>(f,
      'SELECT revision FROM project_settings WHERE project_id = ?', [f.ids.projectId!])[0]!;
    await f.cli(['config', 'update', '--scope', 'project', '--project', f.ids.projectId!,
      '--revision', String(settings.revision), '--input', f.input('missing-git-identity.json', payload)]);
    const result = await completeFirst(f);
    expect(result.error).toContain('git_identity_missing');
    expect((await assertRetained(f, scene)).operations).toEqual([]);
  });
}, 110_000);

