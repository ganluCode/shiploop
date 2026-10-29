import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlledGitCommitService } from '../../../packages/core/src/application/controlled-git-commit.ts';
import { createGitCommitDriver } from '../../../packages/core/src/adapters/fs/git-commit-driver.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import { GitCommitProcessError } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import type { GitCommitAuthorization, GitCommitDriver } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import type { WorkResourceSnapshot } from '../../../packages/core/src/ports/work-resources.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { git } from '../../helpers/git-repo.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const HASH = createHash('sha256').update('verified').digest('hex');
const confirm = async (identity: { launchId: string }) => ({ launchId: identity.launchId });
async function fixture() {
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

describe('F-003 controlled Git commit', () => {
  it('[case:task-commit-batch-boundary] batches by bytes and retains the single 1 MiB blob boundary', async () => {
    const f = await fixture();
    const paths = ['source.ts'];
    for (let i = 0; i < 16; i++) {
      const name = `blob-${i}.bin`;
      paths.push(name);
      writeFileSync(join(f.root, name), Buffer.alloc(80 * 1024, i));
    }
    paths.push('boundary.bin');
    writeFileSync(join(f.root, 'boundary.bin'), Buffer.alloc(1024 * 1024, 127));
    await f.recapture(paths);
    expect((await f.execute()).status).toBe('succeeded');
  }, 120_000);
  it('[case:task-commit-cancel] aborts a live Git hook through the supervised process group and reports stopped evidence', async () => {
    const f = await fixture();
    const marker = join(f.root, 'hook-started');
    f.hook(`printf started > '${marker}'\ntrap '' TERM\nwhile :; do sleep 1; done`);
    const controller = new AbortController();
    const observations: { stopConfirmed: boolean }[] = [];
    const driver = createGitCommitDriver({ confirmProcessIdentity: confirm, signal: controller.signal,
      observeStop: value => observations.push(value) }).open(f.baseline, () => {});
    await driver.stage(['source.ts']);
    const pending = driver.commit('cancelled hook', f.authorization.intent.gitIdentity);
    await expect.poll(() => existsSync(marker), { timeout: 5000 }).toBe(true);
    controller.abort();
    const result = await pending;
    expect(result.reason).not.toBeNull();
    expect(observations.at(-1)?.stopConfirmed).toBe(true);
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
  }, 15_000);
  it.each(['assume-unchanged', 'filemode'])('[case:task-commit-hidden-%s] rejects source hidden from the staging diff', async kind => {
    const f = await fixture();
    const readme = join(f.root, 'README.md');
    if (kind === 'assume-unchanged') {
      git(['update-index', '--assume-unchanged', 'README.md'], f.root);
      writeFileSync(readme, `${readFileSync(readme, 'utf8')}\nhidden source\n`);
    } else {
      git(['config', 'core.filemode', 'false'], f.root);
      chmodSync(readme, 0o755);
    }
    await f.recapture(['source.ts']);
    await expect(f.execute()).rejects.toMatchObject({ reason: 'index_source_mismatch' });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM git_operations').get()).toEqual({ n: 0 });
  });

  it('[case:task-commit-binary-source] verifies binary blob bytes through the bounded Git batch protocol', async () => {
    const f = await fixture();
    const body = Buffer.from([0, 10, 255, 13, 10, 65, 0, 66]);
    writeFileSync(join(f.root, 'source.ts'), body);
    await f.recapture();
    const result = await f.execute();
    expect(result.status).toBe('succeeded');
    expect(readFileSync(join(f.root, 'source.ts'))).toEqual(body);
  });
  it('[case:controlled-commit-normal] commits the verified tree using confirmed identity, persists actual facts, and leaves a clean source', async () => {
    const f = await fixture();
    const result = await f.execute();
    expect(result.status).toBe('succeeded');
    expect(result.actualCommit).toBe(git(['rev-parse', 'HEAD'], f.root).trim());
    expect(result.actualTree).toBe(result.intent.candidateTree);
    expect(git(['rev-parse', 'HEAD^'], f.root).trim()).toBe(f.baseline.baseCommit);
    expect(git(['show', '-s', '--format=%an <%ae>|%cn <%ce>'], f.root).trim())
      .toBe('Confirmed User <confirmed@example.com>|Confirmed User <confirmed@example.com>');
    expect(git(['status', '--porcelain'], f.root)).toBe('');
    expect(result.receipt?.deliveryStatus).toBe('succeeded');
    expect(git(['show', '-s', '--format=%B'], f.root)).toContain(`ShipLoop-Operation: ${result.intent.operationId}`);
    // A terminal replay only returns recorded facts, never creates an empty second commit.
    expect(await f.execute()).toEqual(result);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('stages only evidence-covered tracked edits, deletion, literal untracked paths and necessary config', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, 'README.md'), 'Verified documentation\n');
    unlinkSync(join(f.root, 'src/a.ts'));
    writeFileSync(join(f.root, ':(glob)*'), 'literal path\n');
    writeFileSync(join(f.root, '-config.json'), '{"required":true}\n');
    mkdirSync(join(f.root, '.shiploop'));
    writeFileSync(join(f.root, '.shiploop', 'audit.json'), 'preserve Core artifact\n');
    await f.recapture(['README.md', 'src/a.ts', 'source.ts', ':(glob)*', '-config.json']);
    const result = await f.execute();
    expect(result.status).toBe('succeeded');
    const names = git(['ls-tree', '-r', '--name-only', 'HEAD'], f.root);
    expect(names).toContain(':(glob)*'); expect(names).toContain('-config.json');
    expect(names).not.toContain('src/a.ts'); expect(names).not.toContain('.shiploop');
    expect(readFileSync(join(f.root, '.shiploop', 'audit.json'), 'utf8')).toBe('preserve Core artifact\n');
  });

  it('[case:controlled-commit-no-change] returns real HEAD/tree and no_change without creating an empty commit', async () => {
    const f = await fixture();
    unlinkSync(join(f.root, 'source.ts'));
    await f.recapture([]);
    const result = await f.execute();
    expect(result.status).toBe('no_change');
    expect(result.actualCommit).toBe(f.baseline.baseCommit);
    expect(result.actualTree).toBe(git(['rev-parse', 'HEAD^{tree}'], f.root).trim());
    expect(result.exitCode).toBeNull();
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('1');
  });

  it.each([undefined, { name: 'Unconfirmed', email: 'u@example.com', confirmed: false }])('rejects missing/unconfirmed Git identity before staging (%j)', async identity => {
    const f = await fixture();
    f.authorization = { ...f.authorization, intent: { ...f.authorization.intent, gitIdentity: identity as never } };
    await expect(f.execute()).rejects.toMatchObject({ kind: 'validation' });
    expect(git(['diff', '--cached', '--name-only'], f.root)).toBe('');
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
  });

  it('refuses source changed after verification without touching user bytes or the index', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, 'source.ts'), 'external edit\n');
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'source_changed' } });
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toBe('external edit\n');
    expect(git(['diff', '--cached', '--name-only'], f.root)).toBe('');
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
  });

  it('refuses external HEAD drift without reset/stash or overwriting user results', async () => {
    const f = await fixture();
    git(['-c', 'user.name=External User', '-c', 'user.email=external@example.com', 'commit', '--allow-empty', '-m', 'External progress'], f.root);
    const head = git(['rev-parse', 'HEAD'], f.root).trim();
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'head_drift' } });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(head);
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toContain('42');
    expect(git(['stash', 'list'], f.root)).toBe('');
  });

  it('does not mix or clear someone else\'s staged result', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, 'README.md'), 'another staged result\n');
    git(['add', '--', 'README.md'], f.root);
    await f.recapture();
    const index = git(['write-tree'], f.root);
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'unapproved_staged_files' } });
    expect(git(['write-tree'], f.root)).toBe(index);
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
  });

  it('cannot authorize Core artifacts even when included in evidence', async () => {
    const f = await fixture();
    mkdirSync(join(f.root, '.shiploop')); writeFileSync(join(f.root, '.shiploop', 'state.json'), '{}');
    await f.recapture(['source.ts', '.shiploop/state.json']);
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'invalid_allowed_paths' } });
  });

  it.each(['verificationPassed', 'approvalCurrent', 'commitAuthorized'] as const)('requires current %s before any Git mutation', async key => {
    const f = await fixture(); f.authorization = { ...f.authorization, [key]: false };
    await expect(f.execute()).rejects.toMatchObject({ kind: 'conflict' });
    expect(git(['diff', '--cached', '--name-only'], f.root)).toBe('');
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
  });

  it.each(['verificationPassed', 'approvalCurrent', 'commitAuthorized'] as const)('does not accept truthy non-boolean %s', async key => {
    const f = await fixture(); f.authorization = { ...f.authorization, [key]: 'yes' as never };
    await expect(f.execute()).rejects.toMatchObject({ kind: 'conflict' });
    expect(git(['diff', '--cached', '--name-only'], f.root)).toBe('');
  });

  it('[case:f008-blocked-replay] a settled replay cannot bypass a new human block or erase the original Git receipt', async () => {
    const f = await fixture(); const original = await f.execute();
    f.authorization = { ...f.authorization, approvalCurrent: false };
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'recorded_operation_not_current' } });
    expect(f.store.getGitOperation(f.box.projectId, f.authorization.intent.operationId)).toEqual(original);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('refuses an unconfirmed old writer and a mismatched/quarantined Work lease', async () => {
    const f = await fixture(); f.setStopped(false);
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'previous_writer_stop_unconfirmed' } });
    f.setStopped(true);
    f.occupancy = { ...f.occupancy, leases: f.occupancy.leases.map((lease, index) => index === 2 ? { ...lease, owner: 'old-owner' } : lease) };
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'workspace_not_held' } });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
  });

  it.each([
    ['staged', 'printf "hook staged edit\\n" > source.ts\ngit add -- source.ts', 'candidate_tree_mismatch'],
    ['working-only', 'printf "hook working edit\\n" > source.ts', 'source_changed'],
    ['reject', 'printf "hook failure edit\\n" > source.ts\nexit 1', 'git_commit_failed'],
  ])('keeps real Git facts and invalidates delivery after a %s hook', async (kind, hook, reason) => {
    const f = await fixture(); f.hook(hook);
    const result = await f.execute();
    expect(result.status).toBe('failed'); expect(result.reasonCode).toBe(reason);
    expect(result.actualCommit).toBe(git(['rev-parse', 'HEAD'], f.root).trim());
    expect(result.actualTree).toBe(git(['rev-parse', 'HEAD^{tree}'], f.root).trim());
    expect(result.deliveryStatus).toBe('failed');
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toContain('hook');
    if (kind === 'reject') {
      expect(result.exitCode).not.toBe(0); expect(result.actualCommit).toBe(f.baseline.baseCommit);
      expect(git(['diff', '--cached', '--name-only'], f.root)).toContain('source.ts');
    } else expect(result.actualCommit).not.toBe(f.baseline.baseCommit);
    expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(false);
  });

  it.each(['approval', 'version', 'owner'] as const)('[case:f008-late-commit-%s] preserves a legitimate commit but does not deliver after late %s change', async kind => {
    const f = await fixture();
    f.afterCommit(() => {
      if (kind === 'approval') f.authorization = { ...f.authorization, approvalCurrent: false };
      else f.authorization = { ...f.authorization, intent: { ...f.authorization.intent,
        ...(kind === 'version' ? { executionVersion: 2 } : { ownerId: 'new-owner' }) } };
    });
    const result = await f.execute();
    expect(result.status).toBe('failed'); expect(result.reasonCode).toBe('authorization_or_occupancy_changed');
    expect(result.actualCommit).not.toBe(f.baseline.baseCommit);
    expect(result.actualTree).toBe(result.intent.candidateTree);
    expect(result.deliveryStatus).toBe('failed');
    const feature = f.box.session.database.prepare('SELECT status, delivery_status FROM features WHERE id = ?').get(f.box.featureId);
    expect(feature).toMatchObject({ delivery_status: 'failed' });
    expect(feature).not.toMatchObject({ status: 'completed' });
    expect(f.occupancy.leases).toHaveLength(3);
  });

  it('retains pending intent and claim if the commit process stop is uncertain, and never blindly repeats it', async () => {
    const f = await fixture();
    f.afterCommit(() => { throw new GitCommitProcessError('stop_unconfirmed', false); });
    await expect(f.execute()).rejects.toMatchObject({ reason: 'stop_unconfirmed' });
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(f.store.getGitOperation(f.box.projectId, f.authorization.intent.operationId).status).toBe('pending');
    expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(true);
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'reconciliation_required' } });
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('[case:controlled-commit-receipt-failure] retains durable intent and actual Git side effects on receipt transaction failure', async () => {
    const f = await fixture();
    f.box.session.database.exec(`CREATE TRIGGER receipt_fault BEFORE UPDATE ON git_operations
      WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'injected receipt fault'); END`);
    await expect(f.execute()).rejects.toThrow('injected receipt fault');
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(f.store.getGitOperation(f.box.projectId, f.authorization.intent.operationId).status).toBe('pending');
    expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(true);
  });

  it('does not report no_change when verified source was omitted from the allowed paths', async () => {
    const f = await fixture(); await f.recapture([]);
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'undelivered_source' } });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toContain('42');
  });

  it('keeps an already-staged approved deletion and executable mode in the verified tree', async () => {
    const f = await fixture();
    git(['rm', '--', 'src/a.ts'], f.root);
    chmodSync(join(f.root, 'source.ts'), 0o755);
    await f.recapture(['source.ts', 'src/a.ts']);
    const result = await f.execute();
    expect(result.status).toBe('succeeded');
    expect(git(['ls-tree', 'HEAD', '--', 'source.ts'], f.root)).toMatch(/^100755 blob/);
    expect(git(['ls-tree', 'HEAD', '--', 'src/a.ts'], f.root)).toBe('');
  });

  it('refuses Git clean filters that make staged blobs differ from verified source', async () => {
    const f = await fixture();
    git(['config', 'filter.changed.clean', 'sed s/42/99/g'], f.root);
    writeFileSync(join(f.root, '.gitattributes'), 'source.ts filter=changed\n');
    await f.recapture(['source.ts', '.gitattributes']);
    await expect(f.execute()).rejects.toMatchObject({ reason: 'index_source_mismatch' });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toContain('42');
    expect(git(['show', ':source.ts'], f.root)).toContain('99');
  });

  it('rechecks source after intent persistence, without overwriting the newly changed bytes', async () => {
    const f = await fixture();
    const service = createControlledGitCommitService({ ...f.deps, operations: { ...f.store,
      registerGitOperation(input) {
        const result = f.store.registerGitOperation(input);
        writeFileSync(join(f.root, 'source.ts'), 'edit after durable intent\n');
        return result;
      },
    } });
    await expect(service.commit({ projectId: f.box.projectId, operationId: f.authorization.intent.operationId }))
      .rejects.toMatchObject({ details: { reason: 'source_changed' } });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(f.baseline.baseCommit);
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toBe('edit after durable intent\n');
    expect(f.store.getGitOperation(f.box.projectId, f.authorization.intent.operationId).status).toBe('pending');
  });

  it('rejects a new writer identity appearing while the old writer stop is being verified', async () => {
    const f = await fixture(); const old = f.occupancy;
    const service = createControlledGitCommitService({ ...f.deps, stopVerifier: {
      async verify() { f.occupancy = { ...old, invocationId: 'new-writer-launch' }; return {}; }, inspect: () => old,
    } });
    await expect(service.commit({ projectId: f.box.projectId, operationId: f.authorization.intent.operationId }))
      .rejects.toMatchObject({ details: { reason: 'writer_identity_changed' } });
    expect(git(['diff', '--cached', '--name-only'], f.root)).toBe('');
  });

  it('serializes commits from linked worktrees using the same baseline/Work common-dir claim', async () => {
    const f = await fixture();
    const linked = join(f.box.box.root, 'linked-commit');
    git(['worktree', 'add', '-b', 'linked-delivery', linked, 'HEAD'], f.root);
    const linkedRoot = realpathSync(linked);
    writeFileSync(join(linkedRoot, 'source.ts'), 'export const answer = 42;\n');
    const linkedBaseline = { ...f.baseline, canonicalPath: linkedRoot, branch: 'linked-delivery' };
    const linkedInspector = createWorkspaceInspector({ authorizedRoots: [linkedRoot], confirmProcessIdentity: confirm });
    const linkedAuthorization = { ...f.authorization, baseline: linkedBaseline, intent: { ...f.authorization.intent,
      operationId: randomUUID(), worktreePath: linkedRoot,
      codeDigest: verificationCodeIdentity(await linkedInspector.inspect(linkedBaseline)).codeDigest } };
    const linkedKey = `workspace:${createHash('sha256').update(JSON.stringify([f.baseline.repoIdentity, linkedRoot])).digest('hex')}`;
    const snapshot = { ...f.occupancy, leases: f.occupancy.leases.map((lease, index) => index === 2 ? { ...lease, resourceKey: linkedKey } : lease) };
    const other = createControlledGitCommitService({ ...f.deps, inspector: linkedInspector,
      readAuthorization: () => linkedAuthorization, resources: { read: () => snapshot },
      stopVerifier: { verify: async () => ({}), inspect: () => snapshot } });
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.beforeCommit(async () => { reached(); await barrier; });
    const first = f.execute();
    // Immediately attach a rejection handler, including if the first setup fails.
    const observed = first.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([entered, observed.then(result => { if ('error' in result) throw result.error; })]);
      await expect(other.commit({ projectId: f.box.projectId, operationId: linkedAuthorization.intent.operationId }))
        .rejects.toMatchObject({ code: 'resource_busy' });
      expect(git(['rev-parse', 'HEAD'], linkedRoot).trim()).toBe(f.baseline.baseCommit);
    } finally { release(); await observed; }
    expect(await observed).toHaveProperty('value.status', 'succeeded');
  });
});
