import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withProcessMatrix, type CleanupManifest } from '../../helpers/process-matrix.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

describe.skipIf(process.platform !== 'darwin')('P04-7 cleanup manifest failure evidence', () => {
  it('[case:failed-assertion-retains-evidence] exports stop/exit/files and retains a failed scenario after confirmed cleanup', async () => {
    const expected = new Error('injected matrix assertion failure');
    let manifestPath = '';
    await expect(withProcessMatrix('expected-failed-observation', async matrix => {
      manifestPath = matrix.manifestPath;
      const handle = await matrix.start('graceful');
      await matrix.writersReady();
      writeFileSync(join(matrix.root, 'release'), 'release');
      await handle.result;
      matrix.record('unconfirmed', { reason: expected.message });
      throw expected;
    })).rejects.toBe(expected);
    const saved = JSON.parse(readFileSync(manifestPath, 'utf8')) as CleanupManifest;
    expect(saved).toMatchObject({ status: 'unconfirmed', confirmed: true, processesGone: true, removed: false });
    expect(saved.processes).toHaveLength(4);
    expect(saved.processes.every(row => row.absent)).toBe(true);
    expect(saved.processes.find(row => row.role === 'supervisor')?.exit).toMatchObject({ exitCode: 0, stop: { confirmed: true } });
    expect(saved.files.every(file => file.sha256.length === 64)).toBe(true);
    expect(existsSync(saved.root)).toBe(true);
    expect(saved.error).toContain(expected.message);
    const files = JSON.parse(readFileSync(join(dirname(manifestPath), 'files.json'), 'utf8'));
    expect(files['grandchild.writes'].length).toBeGreaterThan(0);
    expect(saved.live.status).toBe('not_run');
  }, 15_000);

  it('[case:unknown-resource-preserves-root] reports manual_required and never follows a link into an unrelated workspace', async () => {
    const external = createTempSandbox('shiploop-matrix-external-');
    const marker = join(external.path, 'user-workspace-marker');
    writeFileSync(marker, 'must survive matrix cleanup');
    let manifestPath = '';
    try {
      await expect(withProcessMatrix('expected-resource-uncertainty', async matrix => {
        manifestPath = matrix.manifestPath;
        const handle = await matrix.start('graceful');
        await matrix.writersReady();
        writeFileSync(join(matrix.root, 'release'), 'release');
        await handle.result;
        symlinkSync(external.path, join(matrix.root, 'unowned-workspace'), 'dir');
        matrix.retain('native-session-stop-unconfirmed');
        matrix.record('manual_required', { unknownResource: 'native-session', externalRoot: external.path });
      })).rejects.toThrow('Cleanup unconfirmed');
      const saved = JSON.parse(readFileSync(manifestPath, 'utf8')) as CleanupManifest;
      expect(saved).toMatchObject({ status: 'manual_required', confirmed: false, processesGone: true, removed: false });
      expect(saved.unconfirmed).toEqual(expect.arrayContaining(['native-session-stop-unconfirmed', 'unexpected-object:unowned-workspace']));
      expect(readFileSync(marker, 'utf8')).toBe('must survive matrix cleanup');
      expect(existsSync(saved.root)).toBe(true);
      expect(JSON.parse(readFileSync(join(dirname(manifestPath), 'cleanup.json'), 'utf8'))).toMatchObject({
        status: 'failed', matrixStatus: 'manual_required', resourcesRemoved: false, retainedRoot: saved.root,
      });
    } finally { external.cleanup(); }
  }, 15_000);
});
