import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openFaultBarrierFixture, RUNTIME_TARGET } from '../../helpers/p07-1/fault-barrier-host.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { git } from '../../helpers/git-repo.ts';

for (const stopUnconfirmed of [false, true]) {
 it.skipIf(process.platform !== 'darwin')(`[case:default-host-${stopUnconfirmed ? 'quarantine' : 'recording-gate'}] 默认 Host 缺口阻止交付与依赖派发，停止未确认保留执行槽位`, async () => {
  const f = await openFaultBarrierFixture({ dependentTask: true, prefix: 'shiploop-p07f005-public-' });
  try {
    const config = f.buildChildConfig('normal');
    const script = config.script as Record<string, unknown>;
    config.script = { ...script, lifecycle: { events: { drop: [1] }, ...(stopUnconfirmed ? { stopped: { unconfirmed: true } } : {}) } };
    // No verifier process is needed: the assertion is that the production
    // settlement never admits this completed Runtime to verification at all.
    config.verifier = null;
    await f.spawnHost(config, 'p07f005-recording-gate');
    await expect.poll(() => f.q('SELECT status FROM attempts')?.status, { timeout: 40_000 }).toBe(stopUnconfirmed ? 'interrupted' : 'failed');
    if (stopUnconfirmed) {
      await expect.poll(() => f.q('SELECT state FROM execution_slot_claims')?.state, { timeout: 10_000 }).toBe('quarantined');
      expect(f.q("SELECT count(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
    } else {
      await expect.poll(() => f.workspaceRow()?.status, { timeout: 10_000 }).toBe('retained');
    }
    const workspace = f.workspaceRow()!;
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(f.q('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: stopUnconfirmed ? 'running' : 'failed' });
    expect(f.q('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
    expect(f.q('SELECT count(*) AS n FROM verification_batches')).toEqual({ n: 0 });
    expect(f.q('SELECT count(*) AS n FROM git_operations')).toEqual({ n: 0 });
    expect(f.q('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({ runtime_starts: 1, attempts_created: 1 });
    expect(readFileSync(join(workspace.canonical_path, RUNTIME_TARGET.path), 'utf8')).toBe(RUNTIME_TARGET.content);
    expect(git(['rev-parse', 'HEAD'], workspace.canonical_path).trim()).toBe(workspace.base_commit);
    const resultRef = f.q('SELECT result_ref FROM sessions').result_ref as string;
    const settlement = JSON.parse(readFileSync(join(f.fixture.box.dataRoot, deriveArtifactFinalRelativePath({
      projectId: f.fixture.projectId, artifactId: resultRef })), 'utf8'));
    expect(settlement).toMatchObject({ execution: { result: { terminal: 'completed' } }, recording: { complete: false } });
    expect(f.q('SELECT coverage, finalized FROM recording_manifests ORDER BY revision DESC LIMIT 1')).toEqual({ coverage: 'failed', finalized: 1 });
    const evidence = await f.collectEvidence('recording-required', 'after');
    expect(evidence.codeVersion.repoHead).toMatch(/^[a-f0-9]{40}$/);
    expect(f.q('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
  } finally {
    const cleanup = await f.cleanup();
    if (!cleanup.ok) { await f.forceDispose(); throw new Error(`cleanup_unconfirmed: ${JSON.stringify(cleanup)}`); }
  }
}, 90_000);
}
