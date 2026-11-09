import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { autoPushVerifiedCommit } from '../../../packages/core/src/adapters/sqlite/auto-push.js';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.js';
import { validateDeliveryPolicySection, resolveDeliveryPolicyForUse } from '../../../packages/core/src/ports/delivery-policy.js';

it('validates explicit push policy; URL remotes and non-booleans are rejected', () => {
  expect(validateDeliveryPolicySection({ auto_push: true, push_remote: 'origin' }, { operation: 'test' }, 'policy'))
    .toEqual({ auto_push: true, push_remote: 'origin' });
  expect(() => validateDeliveryPolicySection({ auto_push: 'true' }, { operation: 'test' }, 'policy')).toThrow();
  expect(() => validateDeliveryPolicySection({ push_remote: 'https://example.com' }, { operation: 'test' }, 'policy')).toThrow();
  expect(resolveDeliveryPolicyForUse({ commitMode: 'task_and_feature',
    gitIdentity: { name: 'Test', email: 'test@example.com', confirmed: true }, auto_push: true, push_remote: 'origin' }))
    .toMatchObject({ status: 'ready', policy: { auto_push: true, push_remote: 'origin' } });
});

it('pushes an exact verified SHA to a local bare remote and replays the durable acknowledgement', async () => {
  const f = await openBindingFixture();
  try {
    const cwd = f.workspace.canonicalPath;
    const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const remote = join(f.box.root, 'remote.git');
    git(['init', '--bare', remote]);
    git(['remote', 'add', 'push-test', remote]);
    const branch = git(['symbolic-ref', '--short', 'HEAD']);
    const commit = git(['rev-parse', 'HEAD']);
    const binding = f.workspace.binding;
    const driver = createGitCommitDriver({ confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) }).open({
      repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision,
      repoIdentity: binding.repoIdentity, canonicalPath: cwd, gitCommonDir: binding.gitCommonDir!, branch, baseCommit: commit,
    }, () => {});
    const input = { session: f.session, projectId: f.projectId, runId: f.runId, operationId: 'verified-commit-1',
      boundary: 'task' as const, branch, commit, policy: { auto_push: true, push_remote: 'push-test' }, driver, assertCurrent() {} };
    let pushes = 0;
    await expect(autoPushVerifiedCommit({ ...input, driver: { ...driver, async pushCommit(...args) {
      pushes++;
      await driver.pushCommit!(...args);
      throw new Error('acknowledgement lost');
    } } })).rejects.toThrow();
    expect(f.session.database.prepare('SELECT status FROM git_pushes').get()).toEqual({ status: 'unknown' });
    await autoPushVerifiedCommit({ ...input, driver: { ...driver, async pushCommit() {
      pushes++; throw new Error('must reconcile existing remote SHA');
    } } });
    expect(pushes).toBe(1);
    expect(git(['ls-remote', '--heads', 'push-test', `refs/heads/${branch}`])).toContain(commit);
    expect(f.session.database.prepare('SELECT status FROM git_pushes').get()).toEqual({ status: 'succeeded' });
    await autoPushVerifiedCommit({ ...input, driver: { ...driver, pushCommit: async () => { throw new Error('must not repeat push'); } } });
    await expect(autoPushVerifiedCommit({ ...input, commit: '0'.repeat(40) })).rejects.toThrow();
    await autoPushVerifiedCommit({ ...input, operationId: 'disabled', policy: { auto_push: false }, driver: {
      ...driver, async remoteIdentity() { throw new Error('disabled push must not access remote'); },
    } });
    git(['remote', 'set-url', 'push-test', join(f.box.root, 'changed.git')]);
    await expect(autoPushVerifiedCommit(input)).rejects.toThrow();
  } finally { f.close(); }
}, 60000);
