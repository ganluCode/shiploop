/**
 * P07-3 / F-009：项目删除只读预览回归。
 *
 * 覆盖：分页有界只读预览与摘要绑定、归档前/活动占用阻塞、retained/脏 worktree
 * 的保留边界（复用丢弃确认保护）、跨项目引用与未知引用阻塞、内容/绑定/引用
 * 变化后的摘要失效、目标推导安全（不从展示名/sourcePath 推导）、有效期与
 * 授权边界。全部使用真实 SQLite + 真实 Git worktree/受管文件快照。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { createSqliteProjectLifecycleAccess } from '../../../packages/core/src/adapters/sqlite/project-lifecycle.ts';
import { createSqliteProjectDeleteInventory } from '../../../packages/core/src/adapters/sqlite/project-delete-inventory.ts';
import { createProjectLifecycleCommandHandler } from '../../../packages/core/src/application/project-lifecycle.ts';
import { createProjectDeletePreviewService } from '../../../packages/core/src/application/project-delete-preview.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../../../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../../../packages/core/src/application/execution-start.ts';
import { createBaselineWorkspaceReader } from '../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspacePreparationStore } from '../../../packages/core/src/adapters/sqlite/workspace-preparation.ts';
import { createWorkspacePreparationService } from '../../../packages/core/src/application/workspace-preparation.ts';
import { createFeatureWorktreePreparer } from '../../../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteStateStore, createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import {
  assessProjectDeletePreviewConfirmability,
  decodeProjectDeletePreviewCursor,
  PROJECT_DELETE_POLICY,
  type ProjectDeletePreviewPage,
} from '../../../packages/core/src/ports/project-delete-preview.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import type { CommandProcessIdentity } from '../../../packages/core/src/ports/command-process.ts';
import type { TrustedPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture, type ClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { git } from '../../helpers/git-repo.ts';

export type PreviewService = ReturnType<typeof createProjectDeletePreviewService>;
const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

export interface PreviewFixture {
  readonly claim: ClaimFixture;
  readonly root: string;
  readonly session: SqliteStorageSession;
  readonly owner: TrustedPrincipal;
  readonly projectId: string;
  readonly worktreePath: () => string;
  readonly clock: { now: number };
  previewService(pageSize?: number): PreviewService;
  previewViaCommand(cursor?: string): Promise<ProjectDeletePreviewPage>;
  submit(operation: string, payload: Record<string, unknown>, extra?: Record<string, unknown>): Promise<CommandReceipt>;
  archive(): Promise<void>;
  projectRow(): { revision: number; status: string };
  close(): void;
}

let fixtures: Array<() => void> = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});

/** 把 fixture 产生的执行输入/证据制品补齐为“正文在盘且哈希一致”的真实状态。 */
function syncArtifactBodies(f: ClaimFixture, root: string): void {
  const rows = f.box.session.database.prepare('SELECT id FROM artifacts WHERE project_id = ?').all(f.ids.projectId) as Array<{ id: string }>;
  for (const row of rows) {
    const body = Buffer.from(`body-of-${row.id}`, 'utf8');
    const path = join(root, 'projects', f.ids.projectId, 'artifacts', row.id, 'content');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    f.box.session.database.prepare('UPDATE artifacts SET expected_hash = ?, content_hash = ?, size_bytes = ? WHERE project_id = ? AND id = ?')
      .run(sha256(body), sha256(body), body.byteLength, f.ids.projectId, row.id);
  }
}

export async function openPreviewFixture(pageSize = 5_000, options: { readonly prepareWorkspace?: boolean } = {}): Promise<PreviewFixture> {
  const claim = await openClaimFixture();
  const box = claim.box;
  const root = box.box.root;
  const session = box.session;
  const projectId = claim.ids.projectId;
  let closed = false;
  const close = (): void => {
    if (!closed) { closed = true; session.close(); box.box.cleanup(); }
  };
  fixtures.push(close);
  // 注意：执行输入制品先保持 fixture 原始登记（claim 校验快照↔行一致），
  // 认领/准备工作区完成后再把正文落盘并同步哈希。
  mkdirSync(join(root, 'backups', 'backup-20261029'), { recursive: true });
  const clock = { now: NOW };
  const files = createArtifactFileStore({ dataRoot: root });
  const inspectorFor = async () => createWorkspaceInspector({
    authorizedRoots: [root, box.box.repoDirA],
    confirmProcessIdentity: async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId }),
  });
  const inventory = createSqliteProjectDeleteInventory({ session, files, backupRoot: join(root, 'backups') });
  const makePreviewService = (size: number): PreviewService => createProjectDeletePreviewService({
    inventory,
    inspectorFor,
    nowUtcMs: () => clock.now,
    ttlMs: 600_000,
    maxPageEntries: size,
  });
  const closeouts = createSqliteProjectLifecycleAccess(session);
  const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => clock.now });
  const repositoryInspector = createRepositoryInspector();
  const executionPreview = createExecutionPreviewService({
    views: createSqlitePlanAccess(session, { nowUtcMs: () => clock.now }), inspector: repositoryInspector,
    workspace: createBaselineWorkspaceReader(), permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: () => clock.now,
  });
  const owner = createLocalOwnerPrincipal();
  const commands = createCommandService({
    atomicStore: atomic,
    repositoryInspector,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
    ]),
    executionPreview,
    executionStart: createExecutionStartService({ preview: executionPreview, permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: () => clock.now }),
    projectLifecycle: createProjectLifecycleCommandHandler({
      atomicStore: atomic,
      readCloseout: closeouts.readProjectArchiveCloseout,
      nowUtcMs: () => clock.now,
      closeoutBudgetMs: 0,
    }),
    projectDeletePreview: makePreviewService(pageSize),
    nowUtcMs: () => clock.now,
  });

  const projectRow = (): { revision: number; status: string } =>
    session.database.prepare('SELECT revision, status FROM projects WHERE id = ?').get(projectId) as { revision: number; status: string };
  const terminal = (): void => {
    session.transactWrite('fixture.terminal', () => {
      session.database.prepare('UPDATE runs SET status = ?').run('cancelled');
      session.database.prepare('UPDATE execution_batches SET status = ?').run('cancelled');
      // 认领产生的 preparing Attempt 与 held 租约/派发/槽位一并收尾（终态事实）。
      session.database.prepare('UPDATE attempts SET status = ? WHERE project_id = ?').run('cancelled', projectId);
      session.database.prepare('DELETE FROM workspace_leases WHERE project_id = ?').run(projectId);
      session.database.prepare("UPDATE execution_slot_claims SET state = 'released', released_at = ? WHERE project_id = ? AND state = 'held'").run(NOW, projectId);
      session.database.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ? WHERE project_id = ? AND state = 'held'").run(NOW, projectId);
    });
  };
  const submit = async (operationName: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<CommandReceipt> =>
    commands.submit(owner, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(clock.now).toISOString(),
      operation: operationName, scope: { kind: 'project', projectId }, payload, ...extra,
    }) as Promise<CommandReceipt>;
  const archive = async (): Promise<void> => {
    terminal();
    const receipt = await submit('project.archive', { projectId }, { expectedRevision: projectRow().revision });
    if (receipt.status !== 'completed') throw new Error(`archive failed: ${JSON.stringify(receipt)}`);
  };
  const previewViaCommand = async (cursor?: string): Promise<ProjectDeletePreviewPage> => {
    const receipt = await submit('project.delete.preview', cursor === undefined ? { projectId } : { projectId, cursor });
    if (receipt.status !== 'completed') throw new Error(`preview rejected: ${JSON.stringify(receipt)}`);
    return receipt.result as ProjectDeletePreviewPage;
  };

  // 真实受管 worktree：完整 preparation 栈（与 workspace discard 测试同一装配）。
  let worktreePath = '';
  if (options.prepareWorkspace !== false) {
    const paths = createPathService({ dataRoot: root, projectLookup: createSqliteStateStore(session), featureLookup: createSqlitePlanAccess(session) });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [root], preparationPaths: paths });
    const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, nowUtcMs: () => clock.now });
    const inspector = await inspectorFor();
    const publisher = createArtifactPublisher({
      artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => clock.now }),
      files, limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 10_000 },
    });
    const publishEvidence = async (evidenceProjectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => {
      const body = Buffer.from(JSON.stringify(evidence));
      return (await publisher.publishArtifact({ projectId: evidenceProjectId, kind: 'workspace_evidence', mediaType: 'application/json',
        expectedHash: sha256(body), locator: `evidence/${operationId}.json`, content: [body] })).artifact.id;
    };
    const preparation = createWorkspacePreparationService({
      store: createSqliteWorkspacePreparationStore(session, { resources, workspaceAuthority: authority, nowUtcMs: () => clock.now }),
      authority, resources, gitLock: createGitPublicMetadataLock(),
      preparer: createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId }) }),
      publishEvidence,
    });
    const binding = createSqliteStateAccess(session).getRepositoryBinding(projectId);
    const verified = await authority.verifyPreparation(binding, box.featureId);
    const claimed = createSqliteTaskClaimStore(session, { workspaceAuthority: authority, nowUtcMs: () => clock.now })
      .claimTask({ ...claim.input(0), workspace: verified }).receipt;
    const identity = {
      projectId, attemptId: claimed.attempt.id, owner: claimed.attempt.owner,
      hostInstanceId: claimed.attempt.hostInstanceId, executionVersion: claimed.attempt.executionVersion,
    };
    const prepared = await preparation.prepare({
      identity, taskId: claim.ids.taskId, runId: claim.ids.runId, claimKey: claim.input(0).claimKey,
      operationId: randomUUID(), workspaceId: randomUUID(),
    });
    worktreePath = String((session.database.prepare('SELECT canonical_path FROM managed_workspaces WHERE id = ?')
      .get(prepared.workspace.id) as { canonical_path: string }).canonical_path);
  }
  syncArtifactBodies(claim, root);

  return {
    claim, root, session, owner, projectId, worktreePath: () => worktreePath, clock,
    previewService: (size?: number) => makePreviewService(size ?? pageSize),
    previewViaCommand, submit, archive, projectRow, close,
  };
}

export function dirtyWorktree(worktree: string): void {
  writeFileSync(join(worktree, 'README.md'), 'modified but uncommitted');
  writeFileSync(join(worktree, 'new-file.bin'), Buffer.from([1, 2, 3]));
  // ignored 内容需要真实 ignore 规则（与 workspace discard 测试同一手法）。
  writeFileSync(join(worktree, '.gitignore'), 'local.ignored\n');
  git(['add', '.gitignore'], worktree);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore rules'], worktree);
  writeFileSync(join(worktree, 'local.ignored'), 'ignored-residue');
}

export function fileSnapshot(root: string, prefix = ''): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    entries.push(`${prefix}${name}:${stat.isDirectory() ? 'dir' : `${stat.size}`}`);
    if (stat.isDirectory()) entries.push(...fileSnapshot(path, `${prefix}${name}/`));
  }
  return entries;
}

export function businessSnapshot(f: PreviewFixture): Record<string, unknown[]> {
  return Object.fromEntries(['projects', 'phases', 'features', 'tasks', 'attempts', 'runs', 'execution_batches',
    'artifacts', 'sessions', 'managed_workspaces', 'state_events', 'memory_records', 'repository_bindings']
    .map(table => [table, f.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

export function seedProjectRow(f: PreviewFixture, projectId: string, displayName: string): void {
  f.session.database.prepare('INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(projectId, NOW, NOW, displayName, 'active', '[]');
}

export function seedMemoryRecord(f: PreviewFixture, recordId: string, projectId: string, contentRef: string, sourceRefs: readonly string[] = []): void {
  // content_ref 受同项目 FK 约束（必须指向本项目真实制品）；source_refs 为 JSON
  // 引用列，无 FK —— 悬空/跨项目引用只能经出此类列构造（真实数据同理）。
  f.session.database.prepare(`INSERT INTO memory_records (id, created_at, project_id, updated_at, record_key, version, scope, status, content_ref, content_hash, source_refs, retrieval_count)
    VALUES (?, ?, ?, ?, ?, 1, 'project', 'accepted', ?, ?, ?, 0)`)
    .run(recordId, NOW, projectId, NOW, `key-${recordId}`, contentRef, 'cd'.repeat(32), JSON.stringify(sourceRefs.map(artifactId => ({ artifactId }))));
}
