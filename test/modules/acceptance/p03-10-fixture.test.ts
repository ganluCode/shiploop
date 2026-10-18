import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, expect, test } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { COMMAND_SAMPLE_SCRIPT } from '../../helpers/p02-3/command-samples.ts';
import { withP03AcceptanceFixture, type P03Fixture } from '../../helpers/p03-10/acceptance-fixture.ts';

function evidenceBox() {
  const box = createTempSandbox('shiploop-p03-evidence-');
  return { path: box.path, cleanup() {
    const destination = process.env.P03_EVIDENCE_DIR;
    if (destination) {
      mkdirSync(destination, { recursive: true });
      cpSync(box.path, join(destination, box.path.split('/').at(-1)!), { recursive: true });
    }
    box.cleanup();
  } };
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { timeout: 540_000, stdio: 'inherit' });
}, 570_000);

test('[case:prepare-interrupted] 初始化中断仍导出证据并清理已分配资源', async () => {
  const evidence = evidenceBox();
  let root = '';
  try {
    await expect(withP03AcceptanceFixture({
      evidenceDir: evidence.path,
      onStage(stage, fixture) {
        root = fixture.root;
        if (stage === 'allocated') throw new Error('controlled initialization interruption');
      },
    }, async () => { throw new Error('body must not execute'); })).rejects.toThrow('controlled initialization interruption');
    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
    expect(JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'passed', resourcesRemoved: true });
    expect(existsSync(join(evidence.path, 'evidence.json'))).toBe(true);
  } finally { evidence.cleanup(); }
});

test('[case:built-resources] 构建入口授权真实资源、导出关联只读证据及有界输出', async () => {
  const evidence = evidenceBox();
  let root = '';
  try {
    await withP03AcceptanceFixture({ evidenceDir: evidence.path, secrets: ['p03-fixture-private-marker'] }, async f => {
      root = f.root;
      expect(f.ids.projectId).toBeTruthy();
      expect(f.ids.featureId).toBeTruthy();
      await f.startExecution();
      try {
        await expect.poll(() => f.rows('attempts').length, { timeout: 20_000 }).toBeGreaterThan(0);
      } catch (error) { throw new Error(`attempt not created: ${JSON.stringify(f.rows('runs'))}`, { cause: error }); }
      expect(f.ids.batchId).toBeTruthy();
      expect(f.ids.runId).toBeTruthy();
      await expect.poll(() => f.rows('sessions').some(row => row.status === 'stopped'), { timeout: 20_000 }).toBe(true);
      const detail = await f.cli<{ acceptance: { runtimeCompleted: boolean; taskAccepted: boolean } }>([
        'execution', 'session', String(f.rows('attempts')[0]!.id), '--project', f.ids.projectId!,
      ]);
      expect(detail.acceptance).toMatchObject({ runtimeCompleted: true, taskAccepted: false });
      const probe = f.storageProbe();
      try {
        expect(probe.readonly).toBe(true);
        expect(() => probe.selectAll("UPDATE tasks SET status = 'passed'")).toThrow();
      } finally { probe.close(); }
      expect(() => f.safeRemove(evidence.path)).toThrow();
      expect(() => f.input('../escape.json', {})).toThrow();
      symlinkSync(join(evidence.path, 'external.json'), join(root, 'linked.json'));
      try {
        expect(() => f.input('linked.json', {})).toThrow('symlink');
        expect(existsSync(join(evidence.path, 'external.json'))).toBe(false);
      } finally { rmSync(join(root, 'linked.json')); }
      f.input('redaction.json', { note: 'p03-fixture-private-marker' });
      const sample = f.spawnSample('largeOutput', { stdoutLimitBytes: 2048, stderrLimitBytes: 2048 });
      expect(await sample.waitExit(10_000)).not.toBeNull();
      expect(sample.outputOverflow).toBe(true);
      expect(Buffer.byteLength(sample.stdout)).toBeLessThanOrEqual(2048);
      expect(sample.stdoutBytes).toBeGreaterThan(2048);
    });
    expect(existsSync(root)).toBe(false);
    const text = readFileSync(join(evidence.path, 'evidence.json'), 'utf8');
    const exported = JSON.parse(text);
    expect(exported.database.readonly).toBe(true);
    expect(exported.database.tables.attempts.rows.length).toBeGreaterThan(0);
    expect(exported.database.tables.command_receipts.rows.length).toBeGreaterThan(0);
    const attempt = exported.database.tables.attempts.rows[0];
    expect(attempt).toMatchObject({ project_id: exported.ids.projectId, feature_id: exported.ids.featureId, run_id: exported.ids.runId });
    expect(exported.database.tables.runs.rows[0]).toMatchObject({ id: attempt.run_id, batch_id: exported.ids.batchId });
    expect(exported.database.tables.sessions.rows[0]).toMatchObject({ id: attempt.session_id, attempt_id: attempt.id });
    expect(exported.database.tables.workspace_operations.rows).toContainEqual(expect.objectContaining({
      project_id: exported.ids.projectId, feature_id: exported.ids.featureId, run_id: exported.ids.runId, attempt_id: attempt.id,
    }));
    expect(exported.database.tables.command_receipts.rows).toContainEqual(expect.objectContaining({
      operation: 'execution.start', operation_id: exported.ids.batchId, batch_id: exported.ids.batchId, run_id: exported.ids.runId,
    }));
    expect(exported.git.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(exported.usage).toEqual({ source: 'fake', tokens: 'unknown', cache: 'unknown', cost: 'unknown' });
    expect(exported.samples[0]).toMatchObject({ outputOverflow: true, stdoutBytes: expect.any(Number) });
    expect(exported.database.tables.tasks.rows[0].status).not.toBe('passed');
    expect(text).not.toContain(root);
    expect(text).not.toContain('p03-fixture-private-marker');
    expect(text).not.toContain(process.env.HOME!);
    expect(JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'passed', processTreeStopped: true });
  } finally { evidence.cleanup(); }
}, 90_000);

test('[case:host-interrupted] Host 就绪后异常仍核验自有进程树退出', async () => {
  const evidence = evidenceBox();
  let root = '';
  try {
    await expect(withP03AcceptanceFixture({ evidenceDir: evidence.path, onStage(stage, f) {
      root = f.root;
      if (stage === 'host-ready') throw new Error('controlled host interruption');
    } }, async () => undefined)).rejects.toThrow('controlled host interruption');
    expect(existsSync(root)).toBe(false);
    expect(JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'passed', processTreeStopped: true });
  } finally { evidence.cleanup(); }
}, 45_000);

test('[case:cleanup-unconfirmed] 停止核验失败保留资源和诊断，允许确定停止后重试', async () => {
  const evidence = evidenceBox();
  let fixture: P03Fixture | undefined;
  let unconfirmed = true;
  try {
    await expect(withP03AcceptanceFixture({ evidenceDir: evidence.path,
      confirmStopped: () => !unconfirmed,
      onStage(stage, f) {
        fixture = f;
        if (stage === 'host-ready') throw new Error('controlled body failure');
      },
    }, async () => undefined)).rejects.toThrow('cleanup');
    expect(existsSync(fixture!.root)).toBe(true);
    expect(JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'))).toMatchObject({ status: 'failed', resourcesRemoved: false });
    expect(existsSync(join(evidence.path, 'evidence.json'))).toBe(true);
  } finally {
    unconfirmed = false;
    await fixture?.teardown();
    const cleanup = JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'));
    expect(cleanup.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(['failed', 'passed']);
    expect(cleanup.elapsedMs).toBeGreaterThanOrEqual(0);
    evidence.cleanup();
  }
}, 45_000);

test('[case:owned-tool-tree] 工具派生进程运行期间异常，清理核验整棵树和持久组身份', async () => {
  const evidence = evidenceBox();
  let root = '';
  const toolCommands: Record<string, unknown> = {};
  try {
    await expect(withP03AcceptanceFixture({ evidenceDir: evidence.path,
      script: { schemaVersion: 1, steps: [{ op: 'tool_command', name: 'tree' }],
        result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null } },
      toolCommands,
      onStage(stage, f) {
        root = f.root;
        if (stage === 'allocated') toolCommands.tree = {
          argv: [process.execPath, COMMAND_SAMPLE_SCRIPT.spawnWriter, join(root, 'tool-output')], timeoutMs: 30_000,
        };
      },
    }, async f => {
      await f.startExecution();
      await expect.poll(() => existsSync(join(root, 'tool-output', 'child-write-1.txt')), { timeout: 20_000 }).toBe(true);
      const lease = f.rows('workspace_leases').find(row => typeof row.process_identity === 'string');
      expect(lease).toBeDefined();
      const identity = JSON.parse(String(lease!.process_identity));
      expect(() => process.kill(-identity.processGroupId, 0)).not.toThrow();
      throw new Error('controlled active tree interruption');
    })).rejects.toThrow('controlled active tree interruption');
    expect(existsSync(root)).toBe(false);
    const snapshot = JSON.parse(readFileSync(join(evidence.path, 'evidence.json'), 'utf8'));
    expect(snapshot.processGroups.length).toBeGreaterThan(0);
    const cleanup = JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'));
    expect(cleanup).toMatchObject({ status: 'passed', processTreeStopped: true, processGroupsStopped: true });
    expect(cleanup.processGroups[0]).toMatchObject({ pid: expect.any(Number), processGroupId: expect.any(Number), startTime: expect.any(String) });
    for (const identity of cleanup.processGroups) {
      expect(() => process.kill(-identity.processGroupId, 0)).toThrow();
    }
  } finally { evidence.cleanup(); }
}, 60_000);

test('[case:export-failure] 导出失败仍停止 Host，保留资源直至证据可导出', async () => {
  const evidence = evidenceBox();
  let fixture: P03Fixture | undefined;
  try {
    await expect(withP03AcceptanceFixture({ evidenceDir: evidence.path, onStage(stage, f) {
      fixture = f;
      if (stage === 'host-ready') {
        mkdirSync(join(evidence.path, 'evidence.json'));
        throw new Error('controlled evidence failure');
      }
    } }, async () => undefined)).rejects.toThrow('cleanup');
    expect(existsSync(fixture!.root)).toBe(true);
    expect(JSON.parse(readFileSync(join(evidence.path, 'cleanup.json'), 'utf8'))).toMatchObject({
      status: 'failed', resourcesRemoved: false, processTreeStopped: true,
    });
  } finally {
    rmSync(join(evidence.path, 'evidence.json'), { recursive: true, force: true });
    await fixture?.teardown();
    evidence.cleanup();
  }
}, 45_000);
