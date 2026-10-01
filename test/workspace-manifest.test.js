import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8'));
}

function readText(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf-8');
}

const workspaceDirs = ['packages/core', 'packages/host', 'packages/cli'];
const workspaceNames = ['shiploop-core', 'shiploop-host', 'shiploop-cli'];
const pinnedNodeVersion = '22.19.0';
const pinnedNpmVersion = '10.9.3';

describe('root workspace manifest', () => {
  const root = readJson('package.json');

  it('declares exactly the core, host and cli workspaces', () => {
    expect(root.workspaces).toEqual(workspaceDirs);
  });

  it('is private and uses the common initial version', () => {
    expect(root.private).toBe(true);
    expect(root.version).toBe('0.0.0');
  });

  it('pins the verified Node and npm versions consistently', () => {
    expect(root.engines?.node).toBe(pinnedNodeVersion);
    expect(root.engines?.npm).toBe(pinnedNpmVersion);
    expect(root.packageManager).toBe(`npm@${pinnedNpmVersion}`);
  });

  it('pins the test tool to an exact version (no range prefix)', () => {
    expect(root.devDependencies?.vitest).toBe('5.0.3');
    expect(root.devDependencies.vitest).not.toMatch(/^[\^~]/);
  });

  it('does not pull in Pi SDK or storage stacks in this task', () => {
    const allDependencies = {
      ...root.dependencies,
      ...root.devDependencies,
    };
    for (const banned of ['better-sqlite3', 'drizzle-orm']) {
      expect(allDependencies, `unexpected dependency: ${banned}`).not.toHaveProperty(banned);
    }
  });
});

describe.each(workspaceDirs.map((dir, index) => [dir, workspaceNames[index]]))(
  'workspace package %s',
  (dir, expectedName) => {
    const pkg = readJson(`${dir}/package.json`);

    it('uses the private unscoped package name', () => {
      expect(pkg.name).toBe(expectedName);
      expect(pkg.name).not.toMatch(/^@/);
    });

    it('is private, unpublishable and shares the initial version', () => {
      expect(pkg.private).toBe(true);
      expect(pkg.version).toBe('0.0.0');
      expect(pkg.publishConfig).toBeUndefined();
    });

    it('declares the same Node engine pin as the root manifest', () => {
      expect(pkg.engines?.node).toBe(pinnedNodeVersion);
    });
  },
);

describe('pinned toolchain files', () => {
  it('records the Node version in .node-version and .nvmrc', () => {
    expect(readText('.node-version').trim()).toBe(pinnedNodeVersion);
    expect(readText('.nvmrc').trim()).toBe(pinnedNodeVersion);
  });

  it('enforces LF line endings for UTF-8 source files', () => {
    expect(readText('.gitattributes')).toContain('* text=auto eol=lf');
  });

  it('declares UTF-8 editor settings', () => {
    const editorconfig = readText('.editorconfig');
    expect(editorconfig).toMatch(/charset\s*=\s*utf-8/);
    expect(editorconfig).toMatch(/end_of_line\s*=\s*lf/);
  });
});
