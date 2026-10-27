import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeCoveredInputDigest,
  createIntegrationExecutionPlan,
} from '../../../packages/core/src/ports/integration-execution-plan.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import { createIntegrationGitWorkspace } from '../../../packages/core/src/adapters/fs/integration-git-workspace.ts';

const roots: string[] = [];
const SHA = /^[0-9a-f]{40}$/;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  } }).trim();
}
function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, ['add', file]);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message]);
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  expect(SHA.test(sha)).toBe(true);
  return sha;
}
function fixture(conflict = false) {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-p05-7-f003-'));
  roots.push(root);
  const repo = join(realpathSync(root), 'source');
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repo], { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  commit(repo, 'base.txt', 'base\n', 'base');
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'feature-a']);
  const a = commit(repo, conflict ? 'shared.txt' : 'a.txt', conflict ? 'a\n' : 'a\n', 'feature a');
  git(repo, ['checkout', '-q', base]);
  git(repo, ['checkout', '-q', '-b', 'feature-b']);
  const b = commit(repo, conflict ? 'shared.txt' : 'b.txt', conflict ? 'b\n' : 'b\n', 'feature b');
  git(repo, ['checkout', '-q', 'main']);
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repoIdentity = deriveRepoIdentity(common);
  const approvedInputs = [{ inputId: 'input-a', digest: digest(a) }, { inputId: 'input-b', digest: digest(b) }];
  const plan = createIntegrationExecutionPlan({
    projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1', successorFeatureId: 'feature-c',
    target: { baseCommit: base, repoIdentity, canonicalPath: repo, gitCommonDir: common },
    predecessors: [
      { projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1', featureId: 'feature-a', dependencyPassed: true,
        delivery: { commitSha: a, repoIdentity, inputDigest: computeCoveredInputDigest([approvedInputs[0]!]), evidenceId: 'e-a', evidenceDigest: digest('e-a') }, coveredInputIds: ['input-a'] },
      { projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'run-1', featureId: 'feature-b', dependencyPassed: true,
        delivery: { commitSha: b, repoIdentity, inputDigest: computeCoveredInputDigest([approvedInputs[1]!]), evidenceId: 'e-b', evidenceDigest: digest('e-b') }, coveredInputIds: ['input-b'] },
    ],
    approvedInputs, mergeOrder: ['feature-a', 'feature-b'], verificationScope: ['typecheck'], integrationResult: null,
  });
  const integrationPath = join(realpathSync(root), 'integration');
  const workspace = createIntegrationGitWorkspace({ confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
  return { root, repo, common, base, a, b, plan, integrationPath, workspace };
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('P05-7 F-003 deterministic integration Git workspace', () => {
  it('[case:integration-clean-merge-preserves-source] creates an owned detached workspace and merges frozen inputs in order', async () => {
    const f = fixture();
    const beforeRefs = git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const beforeIndex = digest(Buffer.from(readFileSync(join(f.repo, '.git', 'index'))));
    const prepared = await f.workspace.prepare({ plan: f.plan, integrationPath: f.integrationPath,
      owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } });
    expect(prepared.status).toBe('ready');
    expect(prepared.workspace?.ownerId).toBe('owner-1');
    const merged = await f.workspace.merge(prepared.workspace!);
    expect(merged.status).toBe('succeeded');
    expect(merged.steps.map(step => step.inputSha)).toEqual([f.a, f.b]);
    expect(merged.steps.every(step => step.parents.includes(step.parentBefore))).toBe(true);
    expect(readFileSync(join(f.integrationPath, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(f.integrationPath, 'b.txt'), 'utf8')).toBe('b\n');
    expect(git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(beforeRefs);
    expect(digest(Buffer.from(readFileSync(join(f.repo, '.git', 'index'))))).toBe(beforeIndex);
    const cleaned = await f.workspace.cleanup(merged.workspace!);
    expect(cleaned.status).toBe('cleaned');
    expect(existsSync(f.integrationPath)).toBe(false);
  });

  it('[case:integration-conflict-retains-owned-workspace] blocks on an unresolved merge and never auto-resolves or cleans it', async () => {
    const f = fixture(true);
    const prepared = await f.workspace.prepare({ plan: f.plan, integrationPath: f.integrationPath,
      owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } });
    const merged = await f.workspace.merge(prepared.workspace!);
    expect(merged.status).toBe('blocked');
    expect(merged.reason).toBe('merge_conflict');
    expect(git(f.integrationPath, ['ls-files', '-u'])).not.toBe('');
    expect(readFileSync(join(f.integrationPath, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
    const cleanup = await f.workspace.cleanup(merged.workspace!);
    expect(cleanup.status).toBe('blocked');
    expect(cleanup.reason).toBe('workspace_not_clean');
    expect(existsSync(f.integrationPath)).toBe(true);
  });

  it('[case:integration-lock-and-missing-input-retain-facts] blocks on a native lock or missing approved object without destructive recovery', async () => {
    const locked = fixture();
    writeFileSync(join(locked.repo, '.git', 'index.lock'), 'held');
    const lockedResult = await locked.workspace.prepare({ plan: locked.plan, integrationPath: locked.integrationPath,
      owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } });
    expect(lockedResult.status).toBe('blocked');
    expect(lockedResult.reason).toBe('git_lock_present');
    rmSync(join(locked.repo, '.git', 'index.lock'));

    const missing = fixture();
    const missingPlan = { ...missing.plan, predecessors: missing.plan.predecessors.map((item, index) => index === 0
      ? { ...item, delivery: item.delivery ? { ...item.delivery, commitSha: 'f'.repeat(40) } : null } : item) };
    const prepared = await missing.workspace.prepare({ plan: missingPlan, integrationPath: missing.integrationPath,
      owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } });
    expect(prepared.status).toBe('ready');
    const merged = await missing.workspace.merge(prepared.workspace!);
    expect(merged.status).toBe('blocked');
    expect(merged.reason).toBe('input_missing');
    expect(existsSync(missing.integrationPath)).toBe(true);
  });

  it('[case:integration-rejects-dirty-source-and-head-drift] blocks before creating an integration worktree', async () => {
    const dirty = fixture();
    writeFileSync(join(dirty.repo, 'untracked.txt'), 'dirty\n');
    const dirtyResult = await dirty.workspace.prepare({ plan: dirty.plan, integrationPath: dirty.integrationPath,
      owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } });
    expect(dirtyResult.status).toBe('blocked');
    expect(dirtyResult.reason).toBe('source_dirty');
    expect(existsSync(dirty.integrationPath)).toBe(false);

    const drift = fixture();
    commit(drift.repo, 'drift.txt', 'drift\n', 'drift');
    const driftResult = await drift.workspace.prepare({ plan: drift.plan, integrationPath: drift.integrationPath,
      owner: { ownerId: 'owner-1', ownerVersion: 1 }, gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } });
    expect(driftResult.status).toBe('blocked');
    expect(driftResult.reason).toBe('target_head_drift');
    expect(existsSync(drift.integrationPath)).toBe(false);
  });
});
