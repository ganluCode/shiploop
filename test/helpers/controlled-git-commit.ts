import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlledGitCommitService } from '../../packages/core/src/application/controlled-git-commit.ts';
import { createGitCommitDriver } from '../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createWorkspaceInspector } from '../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createGitPublicMetadataLock } from '../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createSqliteGitOperationStore } from '../../packages/core/src/adapters/sqlite/git-operations.ts';
import { verificationCodeIdentity } from '../../packages/core/src/ports/verification-aggregate.ts';
import { GitCommitProcessError } from '../../packages/core/src/ports/controlled-git-commit.ts';
import type { GitCommitAuthorization, GitCommitDriver } from '../../packages/core/src/ports/controlled-git-commit.ts';
import type { WorkResourceSnapshot } from '../../packages/core/src/ports/work-resources.ts';
import { openBudgetFixture, NOW } from './p03-3/budget-fixture.ts';
import { git } from './git-repo.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const HASH = createHash('sha256').update('verified').digest('hex');
const confirm = async (identity: { launchId: string }) => ({ launchId: identity.launchId });
export async function gitCommitFixture(): Promise<any> {
  const box = await openBudgetFixture();
  cleanups.push(() => box.close());
  const ids = await box.start(), db = box.session.database;
  const root = realpathSync(box.box.repoDirA);
  const binding = db.prepare('SELECT id, repo_identity, binding_revision FROM repository_bindings WHERE project_id = ?')
    .get(box.projectId) as { id: string; repo_identity: string; binding_revision: number };
  writeFileSync(join(root, 'source.ts'), 'export const answer = 42;\n');
  const baseline = { repositoryBindingId: binding.id, repositoryBindingRevision: binding.binding_revision,
    repoIdentity: binding.repo_identity, canonicalPath: root, gitCommonDir: realpathSync(join(root, '.git')),
    branch: git(['branch', '--show-current'], root).trim(), baseCommit: git(['rev-parse', 'HEAD'], root).trim() };
  const inspector = createWorkspaceInspector({ authorizedRoots: [root], confirmProcessIdentity: confirm });
  const identity = { projectId: box.projectId, attemptId: 'last-attempt', owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1 };
  const workspaceKey = `workspace:${createHash('sha256').update(JSON.stringify([binding.repo_identity, root])).digest('hex')}`;
  let occupancy: WorkResourceSnapshot = { identity, invocationId: null, processIdentity: null,
    leases: ['global:execution', `project:${box.projectId}:work`, workspaceKey].map((resourceKey, index) => ({
      id: `lease-${index}`, createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1, projectId: box.projectId,
      resourceKey, resourceKind: (['global', 'project', 'workspace'] as const)[index]!, ownerKind: 'attempt',
      owner: identity.attemptId, hostInstanceId: identity.hostInstanceId, executionVersion: 1,
      state: 'held', leaseUntilUtcMs: NOW + 60_000, processIdentity: null,
    })) };
  let stopped = true;
  const resources = { read: () => occupancy };
  const feature = db.prepare('SELECT revision FROM features WHERE id = ?').get(box.featureId) as { revision: number };
  let authorization: GitCommitAuthorization = {
    intent: { operationId: randomUUID(), projectId: box.projectId, featureId: box.featureId, runId: ids.runId,
      attemptId: null, executionVersion: 1, operationType: 'feature_final_commit', repositoryBindingId: binding.id,
      repoIdentity: binding.repo_identity, worktreePath: root, expectedHead: baseline.baseCommit,
      codeDigest: verificationCodeIdentity(await inspector.inspect(baseline)).codeDigest,
      verificationRefs: [{ kind: 'verification_batch', id: 'verified-final', digest: HASH }], approvalRefs: [],
      message: 'Deliver verified source', gitIdentity: { name: 'Confirmed User', email: 'confirmed@example.com', confirmed: true },
      deliveryPolicyDigest: HASH, runtimeSource: null, ownerId: identity.owner, hostInstanceId: identity.hostInstanceId,
      expectedFeatureRevision: feature.revision },
    baseline, resourceIdentity: identity, allowedPaths: ['source.ts'],
    verificationPassed: true, approvalCurrent: true, commitAuthorized: true,
  };
  const store = createSqliteGitOperationStore(box.session, { nowUtcMs: () => NOW });
  let beforeCommit: (() => void | Promise<void>) | undefined;
  let afterCommit: (() => void | Promise<void>) | undefined;
  const realDriver = createGitCommitDriver({ confirmProcessIdentity: confirm });
  const driver: GitCommitDriver = { open(baseline, admit) {
    const session = realDriver.open(baseline, admit);
    return { ...session, async commit(message, identity) {
      await beforeCommit?.();
      const result = await session.commit(message, identity);
      await afterCommit?.();
      return result;
    } };
  } };
  const deps: Parameters<typeof createControlledGitCommitService>[0] = {
    operations: store, inspector, resources,
    stopVerifier: { verify: async () => stopped ? {} : null, inspect: () => occupancy },
    lock: createGitPublicMetadataLock(), driver,
    readAuthorization: () => authorization,
    transact: callback => box.session.transactWrite('test.commit', callback), nowMs: () => NOW,
    excludedPaths: ['.shiploop'],
  };
  const service = createControlledGitCommitService(deps);
  return { box, root, baseline, inspector, service, store, deps,
    beforeCommit(callback: () => void | Promise<void>) { beforeCommit = callback; },
    afterCommit(callback: () => void | Promise<void>) { afterCommit = callback; },
    get authorization() { return authorization; }, set authorization(value: GitCommitAuthorization) { authorization = value; },
    get occupancy() { return occupancy; }, set occupancy(value: WorkResourceSnapshot) { occupancy = value; },
    setStopped(value: boolean) { stopped = value; },
    async recapture(paths = authorization.allowedPaths) {
      authorization = { ...authorization, allowedPaths: paths, intent: { ...authorization.intent,
        codeDigest: verificationCodeIdentity(await inspector.inspect(baseline)).codeDigest } };
    },
    hook(body: string, name = 'pre-commit') {
      const path = join(baseline.gitCommonDir, 'hooks', name);
      mkdirSync(join(baseline.gitCommonDir, 'hooks'), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755);
    },
    execute() { return service.commit({ projectId: box.projectId, operationId: authorization.intent.operationId }); },
  };
}

