import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { computeCommandRequestDigest } from '../../../packages/core/src/ports/command-receipts.ts';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { createProjectDeleteExecutor } from '../../../packages/core/src/application/project-delete-executor.ts';
import { createProjectDeleteFiles } from '../../../packages/core/src/adapters/fs/project-delete-files.ts';
import { createSqliteProjectDeleteStore } from '../../../packages/core/src/adapters/sqlite/project-delete.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createProjectDeleteCommandHandler } from '../../../packages/core/src/application/project-delete.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createFeatureWorktreeCleaner } from '../../../packages/core/src/adapters/fs/feature-worktree-cleaner.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { openPreviewFixture, seedMemoryRecord, seedProjectRow } from '../../helpers/p07-3/delete-preview-fixture.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { git } from '../../helpers/git-repo.ts';

async function fixture() {
  const f = await openPreviewFixture();
  await f.archive();
  f.session.database.prepare("UPDATE feature_resource_leases SET state = 'released', released_at = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND state = 'held'")
    .run(f.clock.now, f.clock.now, f.projectId);
  const store = createSqliteProjectDeleteStore(f.session, { nowUtcMs: () => f.clock.now });
  const commands = createCommandService({ atomicStore: createSqliteAtomicCommandStore(f.session),
    projectDelete: createProjectDeleteCommandHandler({ store, preview: f.previewService(), nowUtcMs: () => f.clock.now }) });
  async function accept(publicEntry = false) {
    // Fault-window fixtures need one real filesystem snapshot. The internal
    // accepting store still rechecks authorization, timing, lifecycle and every
    // database/reference fence. The default-composition case also exercises the
    // public command handler's independent second capture.
    const { page, inventory } = await f.previewService().captureForConfirmation({ principal: f.owner, projectId: f.projectId }, f.clock.now + 600_000);
    const rawEnvelope = { schemaVersion: 5, commandId: randomUUID(), operation: 'project.delete.confirm',
      issuedAt: new Date(f.clock.now).toISOString(), scope: { kind: 'project', projectId: f.projectId }, expectedRevision: page.projectRevision,
      payload: { projectId: f.projectId, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs } };
    const envelope = validateCommandEnvelope(rawEnvelope);
    if (envelope.operation !== 'project.delete.confirm') throw new Error('invalid fixture envelope');
    const receipt = publicEntry ? await commands.submit(f.owner, rawEnvelope)
      : store.accept(f.owner, envelope, computeCommandRequestDigest(envelope), inventory);
    if (receipt.status !== 'accepted') throw new Error(JSON.stringify(receipt));
    const op = store.get(f.owner, receipt.operationId);
    return { principal: f.owner, operationId: op.operationId, owner: 'delete-executor', expectedFence: op.fence, previousExecutorStopped: false };
  }
  const files = createProjectDeleteFiles({ dataRoot: f.root });
  const inspector = createWorkspaceInspector({ authorizedRoots: [f.root, f.claim.box.box.repoDirA], confirmProcessIdentity: async p => ({ launchId: p.launchId }) });
  const cleaner = createFeatureWorktreeCleaner({ inspector, confirmProcessIdentity: async p => ({ launchId: p.launchId }) });
  function assemble(overrides: Partial<Parameters<typeof createProjectDeleteExecutor>[0]> = {}) {
    return createProjectDeleteExecutor({ store, files, gitLock: createGitPublicMetadataLock(),
      bindingFor: projectId => createSqliteStateAccess(f.session).getRepositoryBinding(projectId),
      cleanerFor: async () => cleaner, verifyProcessStop: async () => ({ confirmed: true }), ...overrides });
  }
  return { ...f, store, commands, accept, files, cleaner, assemble };
}

it('[case:delete-preserves-source] 删除固定对象与干净 worktree，重复执行不重复副作用，源仓库/分支/备份/他项目保持一致', async () => {
  const f = await fixture();
  seedProjectRow(f, 'survivor', 'keep project');
  const survivorBody = Buffer.from('other-project immutable evidence');
  const survivorHash = createHash('sha256').update(survivorBody).digest('hex');
  f.session.database.prepare(`INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator)
    VALUES ('survivor-evidence', ?, 'survivor', ?, 'document', 'ready', 'text/plain', ?, ?, ?, 'survivor-evidence')`)
    .run(f.clock.now, f.clock.now, survivorHash, survivorHash, survivorBody.length);
  const survivorPath = join(f.root, 'projects', 'survivor', 'artifacts', 'survivor-evidence', 'content');
  mkdirSync(join(survivorPath, '..'), { recursive: true });
  writeFileSync(survivorPath, survivorBody);
  const source = f.claim.box.box.repoDirA;
  const tracked = git(['ls-files'], source).trim().split('\n')[0]!;
  writeFileSync(join(source, tracked), 'tracked source edit');
  writeFileSync(join(source, 'keep-untracked.txt'), 'source private bytes');
  const head = git(['rev-parse', 'HEAD'], source);
  const refs = git(['show-ref'], source);
  const index = readFileSync(join(source, '.git', 'index'));
  const survivor = f.session.database.prepare("SELECT * FROM projects WHERE id = 'survivor'").get();
  const staging = join(f.root, 'staging', f.projectId, 'registered-residue.part');
  mkdirSync(join(staging, '..'), { recursive: true });
  writeFileSync(staging, 'fixed staging bytes');
  const input = await f.accept(true);
  const bodies = f.store.get(f.owner, input.operationId).manifest!.inventory.artifactBodies;
  await f.session.database.backup(join(f.root, 'core.sqlite'));
  const app = await openCoreApplication({ dataRoot: f.root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) });
  try {
  const survivorBefore = await app.stateStore.getProject('survivor');
  const survivorArtifact = await app.artifactStore.getArtifact('survivor', 'survivor-evidence');
  const result = await app.projectDeleteExecutor.execute(input);
  expect(result.status).toBe('completed');
  await expect(app.stateStore.getProject(f.projectId)).rejects.toMatchObject({ kind: 'not_found' });
  expect(await app.stateStore.getProject('survivor')).toEqual(survivorBefore);
  expect(await app.artifactStore.getArtifact('survivor', 'survivor-evidence')).toEqual(survivorArtifact);
  expect(readFileSync(survivorPath)).toEqual(survivorBody);
  expect(existsSync(f.worktreePath())).toBe(false);
  expect(existsSync(staging)).toBe(false);
  for (const body of bodies) expect(existsSync(join(f.root, 'projects', f.projectId, 'artifacts', body.artifactId, 'content'))).toBe(false);
  expect(git(['worktree', 'list', '--porcelain'], source)).not.toContain(f.worktreePath());
  expect(git(['rev-parse', 'HEAD'], source)).toBe(head);
  expect(git(['show-ref'], source)).toBe(refs);
  expect(readFileSync(join(source, '.git', 'index'))).toEqual(index);
  expect(readFileSync(join(source, tracked), 'utf8')).toBe('tracked source edit');
  expect(readFileSync(join(source, 'keep-untracked.txt'), 'utf8')).toBe('source private bytes');
  expect(existsSync(join(f.root, 'backups', 'backup-20261029'))).toBe(true);
  expect(f.session.database.prepare("SELECT * FROM projects WHERE id = 'survivor'").get()).toEqual(survivor);
  expect(await app.projectDeleteExecutor.execute(input)).toEqual(result);
  expect(f.session.database.pragma('foreign_key_check')).toEqual([]);
  } finally { app.close(); }
}, 120_000);

it('[case:separate-discard-then-delete] 脏目录先经独立丢弃确认清理，项目删除复用原清理证据核验已缺失目录', async () => {
  const f = await fixture();
  writeFileSync(join(f.worktreePath(), 'private-untracked.txt'), 'explicit discard required');
  await f.session.database.backup(join(f.root, 'core.sqlite'));
  const app = await openCoreApplication({ dataRoot: f.root, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]), nowUtcMs: () => f.clock.now });
  try {
    const featureId = f.claim.box.featureId;
    const preview = await app.workspaceDiscard.preview({ principal: f.owner, projectId: f.projectId, featureId });
    expect(preview.contents.counts.untracked).toBeGreaterThan(0);
    const discarded = await app.workspaceDiscard.confirm({ principal: f.owner, projectId: f.projectId, featureId,
      workspaceId: preview.workspaceId, operationId: randomUUID(), commandId: randomUUID(), expectedWorkspaceRevision: preview.workspaceRevision,
      preview: { previewDigest: preview.previewDigest, headCommit: preview.headCommit, codeDigest: preview.codeDigest,
        ignoredDigest: preview.ignoredDigest, workspaceRevision: preview.workspaceRevision, expiresAtUtcMs: preview.expiresAtUtcMs },
      evidenceRefs: [preview.evidenceRef] });
    expect(discarded.workspace.status).toBe('cleaned');
    const page = await app.projectDeletePreview.preview({ principal: f.owner, projectId: f.projectId });
    expect(page.confirmable).toBe(true);
    const receipt = await app.commandService.submit(f.owner, { schemaVersion: 5, commandId: randomUUID(), operation: 'project.delete.confirm',
      scope: { kind: 'project', projectId: f.projectId }, issuedAt: new Date(f.clock.now).toISOString(), expectedRevision: page.projectRevision,
      payload: { projectId: f.projectId, confirmed: true, previewDigest: page.previewDigest, expiresAtUtcMs: page.expiresAtUtcMs } });
    if (receipt.status !== 'accepted') throw new Error(JSON.stringify(receipt));
    const operation = app.projectDeleteStore.get(f.owner, receipt.operationId);
    expect((await app.projectDeleteExecutor.execute({ principal: f.owner, operationId: operation.operationId, owner: 'after-discard',
      expectedFence: operation.fence, previousExecutorStopped: false })).status).toBe('completed');
    expect(existsSync(join(f.claim.box.box.repoDirA, '.git'))).toBe(true);
  } finally { app.close(); }
}, 120_000);

it('[case:staging-fixed-digest] staging 同名内容在确认后发生变化时固定 operation 拒绝删除', async () => {
  const f = await fixture();
  const staging = join(f.root, 'staging', f.projectId, 'registered-residue.part');
  mkdirSync(join(staging, '..'), { recursive: true });
  writeFileSync(staging, 'confirmed staging bytes');
  const input = await f.accept();
  writeFileSync(staging, 'different staging bytes');
  await expect(f.assemble().execute(input)).rejects.toMatchObject({ details: { reason: 'staging_body_changed' } });
  expect(readFileSync(staging, 'utf8')).toBe('different staging bytes');
  expect(existsSync(f.worktreePath())).toBe(true);
});

it('[case:unlink-crash-reconcile] 文件已删但检查点回执前中断，重开 SQLite 按原意图续核，未登记缺失不当成功', async () => {
  const f = await fixture();
  const input = await f.accept();
  let interrupted = false;
  const faulty = { ...f.store, checkpoint: (...args: Parameters<typeof f.store.checkpoint>) => {
    if (!interrupted && args[1] === 'artifact_bodies' && args[2] === 'removed:0') { interrupted = true; throw new Error('crash_after_unlink'); }
    f.store.checkpoint(...args);
  } };
  await expect(f.assemble({ store: faulty }).execute(input)).rejects.toThrow('crash_after_unlink');
  const current = f.store.get(f.owner, input.operationId);
  expect(current.status).toBe('failed');
  const currentIdentity = { operationId: current.operationId, owner: current.owner!, fence: current.fence };
  expect(() => f.store.checkpoint(currentIdentity, 'artifact_bodies', 'plan', { forged: true })).toThrow();
  expect(() => f.store.checkpoint({ ...currentIdentity, fence: current.fence + 1 }, 'artifact_bodies', 'stale', true)).toThrow();
  const saved = f.session.database.prepare("SELECT checkpoint_json FROM project_delete_steps WHERE operation_id = ? AND step = 'artifact_bodies'").get(current.operationId) as { checkpoint_json: string };
  f.session.database.prepare("UPDATE project_delete_steps SET checkpoint_json = '{\"tampered\":true}' WHERE operation_id = ? AND step = 'artifact_bodies'").run(current.operationId);
  expect(() => f.store.readCheckpoints(currentIdentity, 'artifact_bodies')).toThrow();
  f.session.database.prepare("UPDATE project_delete_steps SET checkpoint_json = ? WHERE operation_id = ? AND step = 'artifact_bodies'").run(saved.checkpoint_json, current.operationId);
  const first = current.manifest!.inventory.artifactBodies[0]!;
  expect(existsSync(join(f.root, 'projects', f.projectId, 'artifacts', first.artifactId, 'content'))).toBe(false);
  const peer = openSqliteStorageSession({ path: f.session.path });
  try {
    const reopened = createSqliteProjectDeleteStore(peer);
    let actualRemovals = 0;
    const files = { ...f.files, remove: (...args: Parameters<typeof f.files.remove>) => {
      if (existsSync(join(f.root, args[0].relativePath))) actualRemovals++;
      f.files.remove(...args);
    } };
    const result = await f.assemble({ store: reopened, files }).execute({ ...input, owner: 'restarted', expectedFence: current.fence, previousExecutorStopped: true });
    expect(result.status).toBe('completed');
    expect(actualRemovals).toBe(current.manifest!.inventory.artifactBodies.length - 1);
  } finally { peer.close(); }
});

it('[case:worktree-receipt-crash] worktree 删除后步骤回执前中断，重启核对 Git 登记/分支与源内容，不重放删除', async () => {
  const f = await fixture();
  const input = await f.accept();
  let interrupted = false;
  const faulty = { ...f.store, recordStep: (...args: Parameters<typeof f.store.recordStep>) => {
    if (!interrupted && args[1] === 'managed_worktrees' && args[2] === 'completed') { interrupted = true; throw new Error('crash_before_step_receipt'); }
    f.store.recordStep(...args);
  } };
  await expect(f.assemble({ store: faulty }).execute(input)).rejects.toThrow('crash_before_step_receipt');
  expect(existsSync(f.worktreePath())).toBe(false);
  const current = f.store.get(f.owner, input.operationId);
  let recovered = false;
  const cleaner = { ...f.cleaner, clean: async (...args: Parameters<typeof f.cleaner.clean>) => {
    const outcome = await f.cleaner.clean(...args); recovered = outcome.recovered; return outcome;
  } };
  expect((await f.assemble({ cleanerFor: async () => cleaner }).execute({ ...input, expectedFence: current.fence, previousExecutorStopped: true })).status).toBe('completed');
  expect(recovered).toBe(true);
});

it('[case:purge-crash-reconcile] 数据清除前中断保留外部进度、维护占用和删除意图，重启续核后才完成', async () => {
  const f = await fixture();
  const input = await f.accept();
  f.session.database.exec("CREATE TRIGGER crash_purge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'crash_before_purge'); END;");
  await expect(f.assemble().execute(input)).rejects.toThrow('crash_before_purge');
  const current = f.store.get(f.owner, input.operationId);
  expect(current).toMatchObject({ status: 'failed', failedStep: 'database' });
  expect(current.steps.every(s => s.status === 'completed')).toBe(true);
  expect(f.projectRow().status).toBe('deleting');
  expect(f.session.database.prepare('SELECT state FROM maintenance_occupancy').get()).toEqual({ state: 'held' });
  f.session.database.exec('DROP TRIGGER crash_purge');
  const peer = openSqliteStorageSession({ path: f.session.path });
  try {
    const store = createSqliteProjectDeleteStore(peer);
    expect((await f.assemble({ store }).execute({ ...input, expectedFence: current.fence, previousExecutorStopped: true })).status).toBe('completed');
  } finally { peer.close(); }
});

it.each(['leaf-link', 'ancestor-link', 'same-bytes-new-inode', 'hard-link', 'body-drift', 'missing-without-intent', 'unlink-error'] as const)(
  '[case:path-%s] 链接、实体漂移和未登记缺失拒绝删除，外部文件保持原样', async kind => {
    const f = await fixture();
    const input = await f.accept();
    const sentinel = join(f.claim.box.box.repoDirA, 'external-kept.txt');
    writeFileSync(sentinel, 'external-kept');
    let changed = false;
    const files = { ...f.files, remove: (...args: Parameters<typeof f.files.remove>) => {
      if (!changed) {
        changed = true;
        const path = join(f.root, args[0].relativePath);
        if (kind === 'leaf-link') { unlinkSync(path); symlinkSync(sentinel, path); }
        if (kind === 'ancestor-link') { renameSync(join(path, '..'), join(path, '..') + '.original'); symlinkSync(f.claim.box.box.repoDirA, join(path, '..')); }
        if (kind === 'same-bytes-new-inode') { renameSync(path, path + '.original'); writeFileSync(path, readFileSync(path + '.original')); }
        if (kind === 'hard-link') { unlinkSync(path); linkSync(sentinel, path); }
        if (kind === 'body-drift') writeFileSync(path, 'new content after plan');
        if (kind === 'unlink-error') throw Object.assign(new Error('injected_unlink_permission_error'), { code: 'EACCES' });
      }
      f.files.remove(...args);
    } };
    if (kind === 'missing-without-intent') {
      const first = f.store.get(f.owner, input.operationId).manifest!.inventory.artifactBodies[0]!;
      unlinkSync(join(f.root, 'projects', f.projectId, 'artifacts', first.artifactId, 'content'));
    }
    await expect(f.assemble({ files }).execute(input)).rejects.toThrow();
    expect(f.projectRow().status).toBe('deleting');
    expect(existsSync(f.worktreePath())).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('external-kept');
    expect(f.store.get(f.owner, input.operationId).status).toBe('failed');
  });

it('[case:worktree-directory-replacement] verified 检查点之后同路径替换 worktree 实体时拒绝清理，原目录与替换目录均保留', async () => {
  const f = await fixture();
  const input = await f.accept();
  const original = f.worktreePath() + '.original';
  const tracked = git(['ls-files'], f.worktreePath()).trim().split('\n')[0]!;
  const bytes = readFileSync(join(f.worktreePath(), tracked));
  let replaced = false;
  const store = { ...f.store, checkpoint: (...args: Parameters<typeof f.store.checkpoint>) => {
    f.store.checkpoint(...args);
    if (!replaced && args[1] === 'managed_worktrees' && args[2].startsWith('verified:')) {
      replaced = true;
      renameSync(f.worktreePath(), original);
      mkdirSync(f.worktreePath());
      writeFileSync(join(f.worktreePath(), 'replacement.txt'), 'do not delete replacement');
    }
  } };
  await expect(f.assemble({ store }).execute(input)).rejects.toThrow();
  expect(readFileSync(join(original, tracked))).toEqual(bytes);
  expect(readFileSync(join(f.worktreePath(), 'replacement.txt'), 'utf8')).toBe('do not delete replacement');
  expect(f.projectRow().status).toBe('deleting');
});

it('[case:dirty-worktree-retained] 确认后出现 tracked/untracked/ignored 内容时保留目录，不能以项目删除强制丢弃', async () => {
  const f = await fixture();
  const input = await f.accept();
  const tracked = git(['ls-files'], f.worktreePath()).trim().split('\n')[0]!;
  writeFileSync(join(f.worktreePath(), tracked), 'unfinished tracked edit');
  writeFileSync(join(f.worktreePath(), 'uncommitted.txt'), 'must retain');
  await expect(f.assemble().execute(input)).rejects.toMatchObject({ code: 'conflict' });
  expect(readFileSync(join(f.worktreePath(), tracked), 'utf8')).toBe('unfinished tracked edit');
  expect(readFileSync(join(f.worktreePath(), 'uncommitted.txt'), 'utf8')).toBe('must retain');
  expect(f.projectRow().status).toBe('deleting');
});

it.each(['active', 'reference', 'fence'] as const)('[case:authorization-occupancy-fence-%s] 副作用前重核主体、固定快照、活动占用和执行围栏，迟到执行者不能删除', async kind => {
  const f = await fixture();
  const first = f.session.database.prepare('SELECT id FROM artifacts WHERE project_id = ? ORDER BY id LIMIT 1').get(f.projectId) as { id: string };
  if (kind === 'reference') {
    seedProjectRow(f, 'incoming-project', 'keep references');
    f.session.database.prepare(`INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator)
      VALUES ('external-body', ?, 'incoming-project', ?, 'document', 'ready', 'text/plain', ?, ?, 1, 'external')`)
      .run(f.clock.now, f.clock.now, 'a'.repeat(64), 'a'.repeat(64));
    seedMemoryRecord(f, 'incoming-memory', 'incoming-project', 'external-body');
  }
  const input = await f.accept();
  const denied = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
  await expect(f.assemble().execute({ ...input, principal: denied })).rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.assemble().execute({ ...input, sourcePath: f.claim.box.box.repoDirA } as typeof input)).rejects.toThrow();
  let changed = false;
  const files = { ...f.files, remove: (...args: Parameters<typeof f.files.remove>) => {
    if (!changed) {
      changed = true;
      if (kind === 'active') f.session.database.prepare("UPDATE runs SET status = 'running' WHERE project_id = ?").run(f.projectId);
      if (kind === 'reference') f.session.database.prepare("UPDATE memory_records SET source_refs = ? WHERE id = 'incoming-memory'").run(JSON.stringify([{ artifactId: first.id }]));
      if (kind === 'fence') {
        const current = f.store.get(f.owner, input.operationId);
        f.store.claim(f.owner, input.operationId, 'replacement-owner', current.fence, true);
      }
    }
    f.files.remove(...args);
  } };
  await expect(f.assemble({ files }).execute(input)).rejects.toMatchObject({ code: 'conflict' });
  const current = f.store.get(f.owner, input.operationId);
  expect(current.steps.some(s => s.status === 'completed')).toBe(false);
  await expect(f.assemble().execute(input)).rejects.toMatchObject({ code: 'conflict' });
  for (const body of current.manifest!.inventory.artifactBodies) expect(existsSync(join(f.root, 'projects', f.projectId, 'artifacts', body.artifactId, 'content'))).toBe(true);
});

it('[case:cleanup-unconfirmed] 真实活动进程与停止不明阻止任何文件删除，保留公共锁和维护占用', async () => {
  const f = await fixture();
  const input = await f.accept();
  const process = createCommandProcessAdapter();
  const handle = await process.start({ argv: [globalThis.process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: f.root,
    environment: {}, timeoutMs: 30_000, maxInputBytes: 65_536, maxOutputBytes: 1024 }, async p => ({ launchId: p.launchId }));
  const drain = (async () => { for await (const _ of handle.output) { /* drain */ } })();
  const binding = createSqliteStateAccess(f.session).getRepositoryBinding(f.projectId);
  const retainedLease = await createGitPublicMetadataLock().acquire({ operationId: input.operationId, repoIdentity: binding.repoIdentity,
    workspacePath: binding.canonicalPath, gitCommonDir: binding.gitCommonDir! });
  let recoveredClaim = false;
  try {
    const claimed = f.store.claim(f.owner, input.operationId, 'old-executor', input.expectedFence, false);
    const identity = { operationId: claimed.operationId, owner: claimed.owner!, fence: claimed.fence };
    f.store.checkpoint(identity, 'managed_worktrees', `process:${handle.identity.launchId}`, handle.identity);
    await expect(f.assemble({ verifyProcessStop: async p => {
      expect(p).toEqual(handle.identity); expect(handle.query().state).toBe('running'); return { confirmed: false };
    } }).execute({ ...input, expectedFence: claimed.fence, previousExecutorStopped: true })).rejects.toMatchObject({ details: { reason: 'cleanup_unconfirmed' } });
    expect(f.projectRow().status).toBe('deleting');
    const op = f.store.get(f.owner, input.operationId);
    expect(op.steps.some(s => s.status === 'completed')).toBe(false);
    expect(existsSync(join(f.claim.box.box.repoDirA, '.git', 'shiploop-baseline.claim'))).toBe(true);
    await handle.cancel(); await handle.result; await drain;
    expect((await handle.stopped).confirmed).toBe(true);
    const result = await f.assemble({ verifyProcessStop: p => process.recoverStop!(p) }).execute({ ...input,
      expectedFence: op.fence, previousExecutorStopped: true });
    recoveredClaim = true;
    expect(result.status).toBe('completed');
    expect(existsSync(join(binding.gitCommonDir!, 'shiploop-baseline.claim'))).toBe(false);
  } finally {
    await handle.cancel(); await handle.result; await drain;
    expect((await handle.stopped).confirmed).toBe(true);
    if (!recoveredClaim) await retainedLease.release();
  }
}, 120_000);

it('[case:legacy-modern-common-lock] 新旧仓库身份在同一公共目录争用同一锁；外部 Git 锁出现后不再推进', async () => {
  const f = await fixture();
  const binding = createSqliteStateAccess(f.session).getRepositoryBinding(f.projectId);
  const lock = createGitPublicMetadataLock();
  const lease = await lock.acquire({ repoIdentity: deriveRepoIdentity(binding.gitCommonDir!), gitCommonDir: binding.gitCommonDir!,
    workspacePath: binding.canonicalPath, operationId: randomUUID() });
  const input = await f.accept();
  try {
    await expect(f.assemble().execute(input)).rejects.toMatchObject({ code: 'resource_busy' });
    expect(existsSync(f.worktreePath())).toBe(true);
  } finally { await lease.release(); }
  const current = f.store.get(f.owner, input.operationId);
  let changed = false;
  const native = join(binding.gitCommonDir!, 'index.lock');
  const files = { ...f.files, remove: (...args: Parameters<typeof f.files.remove>) => {
    if (!changed) { changed = true; writeFileSync(native, 'external Git operation'); }
    f.files.remove(...args);
  } };
  try {
    await expect(f.assemble({ files }).execute({ ...input, expectedFence: current.fence, previousExecutorStopped: true }))
      .rejects.toMatchObject({ details: { reason: 'git_native_lock' } });
    expect(readFileSync(native, 'utf8')).toBe('external Git operation');
    for (const body of current.manifest!.inventory.artifactBodies) expect(existsSync(join(f.root, 'projects', f.projectId, 'artifacts', body.artifactId, 'content'))).toBe(true);
  } finally { rmSync(native); }
});