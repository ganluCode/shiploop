import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntegrationGitRecoveryReader } from '../../../packages/core/src/adapters/fs/recovery-git-reader.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';

const fs = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock('node:fs', () => ({
  realpathSync: (path: string) => path,
  lstatSync: (path: string) => {
    if (path === '/repo/.git') return { isDirectory: () => true, isFile: () => false };
    if (!fs.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isDirectory: () => false, isFile: () => true, size: Buffer.byteLength(fs.files.get(path)!), nlink: 1 };
  },
  readFileSync: (path: string) => {
    if (!fs.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fs.files.get(path)!;
  },
  statSync: () => ({ dev: 1, ino: 2, birthtimeNs: 3n }),
}));
const sha = (letter: string) => letter.repeat(40);
function fixture() {
  const plan = { integrationId: 'a'.repeat(64), target: { baseCommit: sha('b'), canonicalPath: '/repo',
    gitCommonDir: '/repo/.git', repoIdentity: deriveRepoIdentity('/repo/.git') }, mergeOrder: ['feature-a'],
    predecessors: [{ featureId: 'feature-a', delivery: { commitSha: sha('c') } }] } as any;
  const intent = { operationId: plan.integrationId, repositoryBindingId: 'binding-1', repoIdentity: plan.target.repoIdentity,
    worktreePath: '/integration', ownerId: 'owner-1', budgetSnapshot: { ownerVersion: 1 }, integrationPlan: plan,
    gitIdentity: { name: 'ShipLoop', email: 'shiploop@example.test', confirmed: true } } as any;
  const workspaceFacts = { head: sha('d'), tree: sha('e'), parents: [sha('b'), sha('c')],
    message: `Merge ${sha('c')} into ShipLoop integration ${plan.integrationId}\n`,
    author: intent.gitIdentity, committer: intent.gitIdentity };
  const isAncestor = vi.fn(async () => false);
  const driver = { open: vi.fn((baseline: any) => ({
    facts: async () => baseline.canonicalPath === '/repo' ? { ...workspaceFacts, head: sha('b') } : workspaceFacts,
    stagedPaths: async () => [], unstagedPaths: async () => [], isAncestor,
  })) };
  const privateDir = '/repo/.git/worktrees/integration';
  fs.files.set('/integration/.git', `gitdir: ${privateDir}\n`);
  fs.files.set(`${privateDir}/commondir`, '../..\n');
  fs.files.set(`${privateDir}/HEAD`, `${workspaceFacts.head}\n`);
  fs.files.set(`${privateDir}/shiploop-integration-owner.json`, JSON.stringify({ workspaceId: plan.integrationId,
    ownerId: intent.ownerId, ownerVersion: 1, planId: plan.integrationId, targetBase: sha('b') }));
  const inspect = () => createIntegrationGitRecoveryReader({ driverFor: () => driver as any }).inspect({
    projectId: 'project-1', operation: { intent } as any, observation: null,
  });
  return { inspect, workspaceFacts, isAncestor, privateDir, driver, plan };
}

beforeEach(() => fs.files.clear());
describe('integration recovery Git facts', () => {
  it('[case:integration-recovery-exact-merge-message] reconstructs a committed merge whose journal response was lost', async () => {
    const f = fixture();
    const result = await f.inspect();
    expect(result.steps).toEqual([expect.objectContaining({ ordinal: 1, status: 'succeeded', commitSha: sha('d') })]);
  });

  it('[case:integration-recovery-included-ancestry] reconstructs an already-included input using read-only ancestry', async () => {
    const f = fixture();
    f.workspaceFacts.head = sha('b');
    f.workspaceFacts.parents = [];
    f.isAncestor.mockResolvedValue(true);
    const result = await f.inspect();
    expect(result.steps).toEqual([expect.objectContaining({ status: 'already_included', commitSha: sha('b') })]);
    expect(f.isAncestor).toHaveBeenCalledWith(sha('c'), sha('b'));
  });

  it.each(['branch', 'owner', 'lock', 'foreign-repo'] as const)(
    '[case:integration-recovery-identity-%s] rejects unexpected worktree identity and retained locks', async reason => {
      const f = fixture();
      if (reason === 'branch') fs.files.set(`${f.privateDir}/HEAD`, 'ref: refs/heads/foreign\n');
      if (reason === 'owner') fs.files.delete(`${f.privateDir}/shiploop-integration-owner.json`);
      if (reason === 'lock') fs.files.set('/repo/.git/shiploop-baseline.claim', 'retained');
      if (reason === 'foreign-repo') fs.files.set('/integration/.git', 'gitdir: /elsewhere/.git\n');
      await expect(f.inspect()).rejects.toMatchObject({ reason: reason === 'branch' ? 'workspace_branch_changed'
        : reason === 'owner' ? 'workspace_not_owned' : reason === 'lock' ? 'git_lock_present' : 'repo_identity_changed' });
    });
});
