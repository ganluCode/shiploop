import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const experiment = new URL('../../../../experiments/pi-durable/', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, experiment), 'utf8'));

describe('F-004 independent Pi Durable spike, not production capability evidence', () => {
  it('pins the candidate outside root workspaces and production dependencies', () => {
    const manifest = json('package.json');
    const lock = json('package-lock.json');
    const root = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));
    expect(manifest.engines).toEqual({ node: '22.19.0', npm: '10.9.3' });
    for (const name of ['pi-durable', 'pi-ai', 'chord']) {
      const dependency = `@earendil-works/${name}`;
      expect(manifest.dependencies[dependency]).toBe('1.2.0');
      expect(lock.packages[`node_modules/${dependency}`].version).toBe('1.2.0');
      expect(lock.packages[`node_modules/${dependency}`].integrity).toMatch(/^sha512-/);
      expect(root.dependencies?.[dependency]).toBeUndefined();
      // Pi production support pins its shared SDK packages independently of this spike.
      expect(root.devDependencies?.[dependency]).toBe(name === 'pi-durable' ? undefined : '1.0.4');
    }
    expect(root.workspaces).not.toContain('experiments/pi-durable');
    const sources = json('sources.json');
    expect(lock.packages['node_modules/@earendil-works/pi-durable'].integrity).toBe(sources.sdk.integrity);
    expect(createHash('sha256').update(readFileSync(new URL('package-lock.json', experiment))).digest('hex')).toBe(sources.lockSha256);
  });

  // Opt-in keeps ordinary Core tests independent of the experimental SDK installation.
  it.runIf(process.env.SHIPLOOP_PI_DURABLE_SPIKE === '1')('runs actual pinned SDK assertions through the project test entry', () => {
    const result = spawnSync(process.execPath, ['--test', 'probe-tests.mjs'], {
      cwd: fileURLToPath(experiment), encoding: 'utf8', timeout: 45000,
      env: { PATH: process.env.PATH, SHIPLOOP_PI_DURABLE_SPIKE: '1' },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# pass 14\b/);
    expect(result.stdout).toMatch(/# fail 0\b/);
  }, 50000);
});
