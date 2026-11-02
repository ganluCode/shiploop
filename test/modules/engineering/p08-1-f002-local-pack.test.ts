import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createArtifactRecord,
  createDistributionManifest,
  packStagedPackage,
  stagePackage,
  validateDistributionManifest,
  validatePackageManifest,
} from '../../../scripts/pack-local.ts';

function sandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFixturePackage(root: string, name = 'shiploop-fixture'): string {
  const source = join(root, 'source');
  mkdirSync(join(source, 'dist'), { recursive: true });
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      files: ['dist'],
      dependencies: {},
    }),
  );
  writeFileSync(join(source, 'dist/index.js'), 'export const ok = true;\n');
  writeFileSync(join(source, 'dist/index.d.ts'), 'export declare const ok: boolean;\n');
  writeFileSync(join(source, 'src/index.ts'), 'throw new Error("source must not ship");\n');
  return source;
}

describe('P08-1 local packaging', () => {
  it('[case:stage-and-pack] stages only declared build files and records the real tarball files', () => {
    const root = sandbox('shiploop-f002-pack-');
    const source = createFixturePackage(root);
    const stage = join(root, 'stage');
    const output = join(root, 'out');
    stagePackage(source, stage);

    expect(readFileSync(join(stage, 'package.json'), 'utf8')).toContain('shiploop-fixture');
    expect(() => readFileSync(join(stage, 'src/index.ts'), 'utf8')).toThrow();

    const tarball = packStagedPackage(stage, output);
    const artifact = createArtifactRecord(tarball, 'shiploop-fixture', '0.0.0');
    expect(artifact.filename).toBe('shiploop-fixture-0.0.0.tgz');
    expect(artifact.files).toEqual(['dist/index.d.ts', 'dist/index.js', 'package.json']);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[case:manifest-identity] creates and verifies a commit/toolchain/compatibility manifest', () => {
    const root = sandbox('shiploop-f002-manifest-');
    const artifacts: ReturnType<typeof createArtifactRecord>[] = [];
    const output = join(root, 'out');
    for (const packageName of ['shiploop-core', 'shiploop-host', 'shiploop-cli']) {
      const source = createFixturePackage(root, packageName);
      const stage = join(root, `${packageName}-stage`);
      stagePackage(source, stage);
      const tarball = packStagedPackage(stage, output);
      artifacts.push(createArtifactRecord(tarball, packageName, '0.0.0'));
    }
    const artifact = artifacts[0] as ReturnType<typeof createArtifactRecord>;
    const manifest = createDistributionManifest({
      gitCommit: '0123456789abcdef0123456789abcdef01234567',
      nodeVersion: '22.19.0',
      npmVersion: '10.9.3',
      platform: 'darwin',
      lockfileVersion: 3,
      compatibility: {
        hostProtocol: { wireSchemaVersion: 6, wireProtocolVersions: [1] },
        databaseSchema: { readableAppliedVersions: { min: 1, max: 64 }, writableTargetVersion: 64 },
      },
      artifacts,
    });

    expect(manifest.artifacts).toHaveLength(3);
    expect(() => validateDistributionManifest(manifest, output)).not.toThrow();

    const changed = {
      ...manifest,
      artifacts: manifest.artifacts.map((entry, index) => index === 0 ? { ...entry, sha256: 'f'.repeat(64) } : entry),
    };
    expect(() => validateDistributionManifest(changed, output)).toThrow(/digest|摘要|sha/i);
  });

  it('[case:reject-unsafe-dependencies] rejects workspace/file/absolute runtime dependency specs', () => {
    for (const value of ['workspace:*', 'file:../core', '/Users/dev/core']) {
      expect(() => validatePackageManifest({
        name: 'shiploop-fixture',
        version: '0.0.0',
        files: ['dist'],
        main: './dist/index.js',
        dependencies: { 'shiploop-core': value },
      })).toThrow(/dependency|依赖|workspace|file/i);
    }
  });

  it('[case:reject-non-executable-bin] rejects a CLI package whose declared bin is not executable', () => {
    const root = sandbox('shiploop-f002-bin-');
    const source = createFixturePackage(root, 'shiploop-cli-fixture');
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'shiploop-cli-fixture',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        bin: { shiploop: './dist/bin.js' },
        files: ['dist'],
      }),
    );
    writeFileSync(join(source, 'dist/bin.js'), '#!/usr/bin/env node\n');
    chmodSync(join(source, 'dist/bin.js'), 0o644);
    const stage = join(root, 'stage');
    expect(() => stagePackage(source, stage)).toThrow(/executable|可执行/i);
  });
});
