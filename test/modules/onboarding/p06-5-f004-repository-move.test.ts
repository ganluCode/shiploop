import { realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createRepositoryMoveService } from '../../../packages/core/src/application/repository-move-service.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { commitAll, git, initGitRepo } from '../../helpers/git-repo.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

async function setup() {
  const sandbox = createTempSandbox('shiploop-p065-f004-move-');
  const dbPath = join(sandbox.path, 'state.db');
  const oldPath = join(sandbox.path, 'old-repo');
  const newPath = join(sandbox.path, 'moved-repo');
  const session = openSqliteStorageSession({ path: dbPath });
  await migrateSqliteStorage(session);
  initGitRepo(oldPath);
  writeFileSync(join(oldPath, 'README.md'), 'before move\n', 'utf8');
  const head = commitAll(oldPath, 'initial move fixture');
  const store = createSqliteStateStore(session);
  const inspected = await createRepositoryInspector().inspect(oldPath);
  const project = await store.createProjectWithRepositoryBinding(
    { displayName: '移动项目' },
    { canonicalPath: inspected.canonicalPath, gitCommonDir: inspected.gitCommonDir, repoIdentity: inspected.repoIdentity },
  );
  const service = createRepositoryMoveService({
    stateStore: store,
    repositoryInspector: createRepositoryInspector(),
  });
  return { sandbox, session, store, service, project, oldPath, newPath, oldCanonicalPath: inspected.canonicalPath, head };
}

describe('P06-5 repository move preview and confirmation', () => {
  it('previews a real moved repository and confirms the original project binding', async () => {
    const f = await setup();
    try {
      renameSync(f.oldPath, f.newPath);
      writeFileSync(join(f.newPath, 'staged.txt'), 'kept user content\n', 'utf8');
      git(['add', 'staged.txt'], f.newPath);
      writeFileSync(join(f.newPath, 'untracked.txt'), 'also kept\n', 'utf8');
      const preview = await f.service.preview(createLocalOwnerPrincipal(), {
        projectId: f.project.project.id,
        repositoryPath: f.newPath,
      });
      expect(preview.projectId).toBe(f.project.project.id);
      expect(preview.oldBinding.canonicalPath).toBe(f.oldCanonicalPath);
      expect(preview.newRepository.canonicalPath).toBe(realpathSync(f.newPath));
      expect(preview.newRepository.headCommit).toBe(f.head);
      expect(preview.newRepository.hasUncommittedChanges).toBe(true);
      expect(preview.newRepository.workingTreeDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.identityRelation).toBe('different');
      expect(preview.requiresExplicitConfirmation).toBe(true);

      const result = await f.service.confirm(createLocalOwnerPrincipal(), {
        preview,
        decision: { schemaVersion: 1, projectId: f.project.project.id, oldBinding: preview.oldBinding,
          previewDigest: preview.previewDigest, decision: 'confirm' },
      });
      expect(result.project.id).toBe(f.project.project.id);
      expect(result.binding.canonicalPath).toBe(realpathSync(f.newPath));
      expect(result.previousBinding.canonicalPath).toBe(f.oldCanonicalPath);
      expect((await f.store.getProject(f.project.project.id)).id).toBe(f.project.project.id);
      expect(git(['status', '--porcelain'], f.newPath)).toContain('A  staged.txt');
      expect(git(['status', '--porcelain'], f.newPath)).toContain('?? untracked.txt');
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });

  it('rejects cancellation and preview drift without changing the old binding', async () => {
    const f = await setup();
    try {
      renameSync(f.oldPath, f.newPath);
      const preview = await f.service.preview(createLocalOwnerPrincipal(), {
        projectId: f.project.project.id, repositoryPath: f.newPath,
      });
      writeFileSync(join(f.newPath, 'drift.txt'), 'changed after preview\n', 'utf8');
      await expect(f.service.confirm(createLocalOwnerPrincipal(), {
        preview,
        decision: { schemaVersion: 1, projectId: f.project.project.id, oldBinding: preview.oldBinding,
          previewDigest: preview.previewDigest, decision: 'confirm' },
      })).rejects.toMatchObject({ kind: 'conflict' });
      expect((await f.store.getRepositoryBinding(f.project.project.id)).canonicalPath).toBe(f.oldCanonicalPath);
      await expect(f.service.confirm(createLocalOwnerPrincipal(), {
        preview,
        decision: { schemaVersion: 1, projectId: f.project.project.id, oldBinding: preview.oldBinding,
          previewDigest: preview.previewDigest, decision: 'cancel' },
      })).rejects.toMatchObject({ kind: 'validation' });
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });

  it('keeps the binding locked while a baseline occupancy is unresolved', async () => {
    const f = await setup();
    try {
      renameSync(f.oldPath, f.newPath);
      const preview = await f.service.preview(createLocalOwnerPrincipal(), {
        projectId: f.project.project.id, repositoryPath: f.newPath,
      });
      f.session.database.prepare("INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status) VALUES ('11111111-1111-4111-8111-111111111111', 1, 1, ?, 'baseline', 'running')").run(f.project.project.id);
      f.session.database.prepare("INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at) VALUES ('global', '11111111-1111-4111-8111-111111111111', 1)").run();
      await expect(f.service.confirm(createLocalOwnerPrincipal(), {
        preview,
        decision: { schemaVersion: 1, projectId: f.project.project.id, oldBinding: preview.oldBinding,
          previewDigest: preview.previewDigest, decision: 'confirm' },
      })).rejects.toMatchObject({ kind: 'conflict' });
      expect((await f.store.getRepositoryBinding(f.project.project.id)).canonicalPath).toBe(f.oldCanonicalPath);
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });
});
