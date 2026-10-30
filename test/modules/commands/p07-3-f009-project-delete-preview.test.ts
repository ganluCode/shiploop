/**
 * P07-3 / F-009：项目删除只读预览回归。
 *
 * 覆盖：分页有界只读预览与摘要绑定、归档前/活动占用阻塞、retained/脏 worktree
 * 的保留边界（复用丢弃确认保护）、跨项目引用与未知引用阻塞、内容/绑定/引用
 * 变化后的摘要失效、目标推导安全（不从展示名/sourcePath 推导）、有效期与
 * 授权边界。全部使用真实 SQLite + 真实 Git worktree/受管文件快照。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createProjectDeletePreviewService } from '../../../packages/core/src/application/project-delete-preview.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import {
  assessProjectDeletePreviewConfirmability,
  decodeProjectDeletePreviewCursor,
  PROJECT_DELETE_POLICY,
  type ProjectDeletePreviewPage,
} from '../../../packages/core/src/ports/project-delete-preview.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { git } from '../../helpers/git-repo.ts';
import {
  businessSnapshot, dirtyWorktree, fileSnapshot, openPreviewFixture,
  seedMemoryRecord, seedProjectRow,
} from '../../helpers/p07-3/delete-preview-fixture.ts';

const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

it('[case:read-only-bounded-preview] 归档后生成只读有界预览：完整清单/保留项/零副作用/不泄漏路径', async () => {
  const f = await openPreviewFixture();
  await f.archive();
  const before = businessSnapshot(f);
  const files = fileSnapshot(f.root);
  const repoFiles = fileSnapshot(f.claim.box.box.repoDirA);
  const receiptsBefore = (f.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n;

  const page = await f.previewViaCommand();

  expect(page.projectStatus).toBe('archived');
  expect(page.schemaVersion).toBe(1);
  expect(page.policy).toEqual(PROJECT_DELETE_POLICY);
  expect(page.inventoryComplete).toBe(true);
  expect(page.inventoryReasons).toEqual([]);
  // 完整清单：单页覆盖全部清点结果且关键类别计数与真实关系一致。
  expect(page.pagination).toEqual({ complete: true, nextCursor: null });
  expect(page.summary.objects.total).toBe(page.entries.length);
  const byKind = page.summary.objects.byKind;
  expect(byKind.runs).toBe(1);
  expect(byKind.tasks).toBe(1);
  expect(byKind.features).toBe(1);
  expect(byKind.phases).toBe(1);
  expect(byKind.attempts).toBeGreaterThanOrEqual(1);
  expect(byKind.managed_workspaces).toBe(1);
  expect(byKind.artifacts).toBeGreaterThanOrEqual(4);
  expect(byKind.command_receipts).toBeGreaterThanOrEqual(1);
  // 正文清单：全部 ready 制品都被重新哈希并绑定。
  const artifactRows = f.session.database.prepare('SELECT id, content_hash, size_bytes FROM artifacts WHERE project_id = ?').all(f.projectId) as Array<{ id: string; content_hash: string; size_bytes: number }>;
  expect(page.summary.artifactBodies.count).toBe(artifactRows.length);
  expect(page.summary.artifactBodies.totalBytes).toBe(artifactRows.reduce((sum, row) => sum + row.size_bytes, 0));
  // 保留项：源仓库/分支/备份/最小回执；仓库绑定身份绑定摘要。
  const retainedKinds = page.summary.retained.map(item => item.kind);
  expect(retainedKinds).toContain('source-repository');
  expect(retainedKinds).toContain('branches');
  expect(retainedKinds).toContain('backup');
  expect(retainedKinds).toContain('minimal-receipt');
  expect(page.summary.retained.filter(item => item.kind === 'backup').map(item => item.id)).toEqual(['backup-20261029']);
  expect(page.summary.repositoryBindings).toHaveLength(1);
  const bindingRow = f.session.database.prepare('SELECT repo_identity FROM repository_bindings WHERE project_id = ?').get(f.projectId) as { repo_identity: string };
  expect(page.summary.repositoryBindings[0]!.repoIdentity).toBe(bindingRow.repo_identity);
  // 活动占用为 0 且可确认（干净归档项目、单页完整清点）。
  expect(page.summary.activity.activeRuns).toBe(0);
  expect(page.summary.activity.activeBatches).toBe(0);
  expect(page.blockers).toEqual([]);
  expect(page.confirmable).toBe(true);
  // 只读：业务行、数据根文件、源仓库全部原样；仅新增 1 条预览命令回执。
  expect(businessSnapshot(f)).toEqual(before);
  expect(fileSnapshot(f.root)).toEqual(files);
  expect(fileSnapshot(f.claim.box.box.repoDirA)).toEqual(repoFiles);
  const receiptsAfter = (f.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n;
  expect(receiptsAfter - receiptsBefore).toBe(1);
  // 不泄漏绝对路径（源仓库/worktree/数据根）。
  const serialized = JSON.stringify(page);
  expect(serialized).not.toContain(f.root);
  expect(serialized).not.toContain(f.claim.box.box.repoDirA);
  expect(serialized).not.toContain(f.worktreePath());
  f.close();
});

it('[case:pagination-rejects-confirm] 分页未完成拒绝确认，游标翻页绑定同一摘要且结构非法拒绝', async () => {
  const f = await openPreviewFixture(6);
  await f.archive();
  const small = f.previewService(6);

  const first = await small.preview({ principal: f.owner, projectId: f.projectId });
  expect(first.entries.length).toBe(6);
  expect(first.pagination.complete).toBe(false);
  expect(first.pagination.nextCursor).toBeTypeOf('string');
  expect(first.confirmable).toBe(false);
  expect(first.blockers).toContain('pagination_incomplete');
  // 纯函数判定与页面一致（F-010 确认事务复用同一口径）。
  expect(assessProjectDeletePreviewConfirmability(first, f.clock.now).confirmable).toBe(false);

  // 翻页至末页：全程同一摘要/有效期；末页 complete 后才可确认。
  const pagedKeys = [...first.entries.map(entry => `${entry.kind}:${entry.id}`)];
  const digests = new Set<string>([first.previewDigest]);
  let page: ProjectDeletePreviewPage = first;
  for (let guard = 0; page.pagination.complete === false && guard < 100; guard += 1) {
    page = await small.preview({ principal: f.owner, projectId: f.projectId, cursor: page.pagination.nextCursor! });
    digests.add(page.previewDigest);
    pagedKeys.push(...page.entries.map(entry => `${entry.kind}:${entry.id}`));
    expect(page.observedAtUtcMs).toBe(first.observedAtUtcMs);
    expect(page.expiresAtUtcMs).toBe(first.expiresAtUtcMs);
  }
  expect(digests.size).toBe(1);
  expect(page.pagination).toEqual({ complete: true, nextCursor: null });
  expect(page.confirmable).toBe(true);
  expect(page.blockers).toEqual([]);

  // 分页并集等于单页全集（清单完整性不因分页丢失）。
  const single = await f.previewService(5_000).preview({ principal: f.owner, projectId: f.projectId });
  expect(pagedKeys.sort()).toEqual(single.entries.map(entry => `${entry.kind}:${entry.id}`).sort());

  // 结构非法/篡改游标拒绝（不产生任何删除授权）。
  await expect(small.preview({ principal: f.owner, projectId: f.projectId, cursor: 'not-a-cursor' }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  const decoded = decodeProjectDeletePreviewCursor(first.pagination.nextCursor!);
  const forged = Buffer.from(JSON.stringify([`f${'0'.repeat(63)}`, decoded.expiresAtUtcMs, decoded.lastKey]), 'utf8').toString('base64url');
  await expect(small.preview({ principal: f.owner, projectId: f.projectId, cursor: forged }))
    .rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_content_changed' } });
  f.close();
});

it('[case:not-archived-and-active-blockers] 归档前与活动/不确定执行显示不可确认且不省略被阻塞对象', async () => {
  const f = await openPreviewFixture();
  // 活动项目 + 活动 Run：不省略对象，直接列出全部清单与阻塞。
  const active = await f.previewViaCommand();
  expect(active.projectStatus).toBe('active');
  expect(active.summary.objects.total).toBeGreaterThan(0);
  expect(active.entries.length).toBeGreaterThan(0);
  expect(active.confirmable).toBe(false);
  expect(active.blockers).toContain('project_not_archived');
  expect(active.blockers).toContain('active_execution');
  expect(active.summary.activity.activeRuns).toBe(1);

  // 归档等待中（archiving）同样不可确认删除。
  f.session.transactWrite('fixture.archiving', () => {
    f.session.database.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archiving', f.projectId);
  });
  const archiving = await f.previewViaCommand();
  expect(archiving.projectStatus).toBe('archiving');
  expect(archiving.blockers).toContain('project_not_archived');
  expect(archiving.confirmable).toBe(false);

  // 不确定停止证据也保持阻塞（未确认停止操作）。
  f.session.transactWrite('fixture.stop', () => {
    f.session.database.prepare(`INSERT INTO execution_stop_operations (id, created_at, project_id, updated_at, command_id,
      target_kind, target_id, batch_id, run_id, reason, status, requested_at, stop_confirmed)
      VALUES ('stop-1', ?, ?, ?, 'cmd-stop-1', 'run', ?, ?, ?, 'user_cancel', 'stopping', ?, 0)`)
      .run(NOW, f.projectId, NOW, f.claim.ids.runId, f.claim.ids.batchId, f.claim.ids.runId, NOW);
    f.session.database.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', f.projectId);
  });
  const unconfirmed = await f.previewViaCommand();
  expect(unconfirmed.summary.activity.unconfirmedStops).toBe(1);
  expect(unconfirmed.blockers).toContain('active_execution');
  expect(unconfirmed.confirmable).toBe(false);
  f.close();
});

it('[case:dirty-worktree-protection] retained/脏 worktree 列出内容与影响，须独立丢弃确认且预览零删除', async () => {
  const f = await openPreviewFixture();
  dirtyWorktree(f.worktreePath());
  await f.archive();

  const page = await f.previewViaCommand();
  expect(page.summary.workspaces).toHaveLength(1);
  const workspace = page.summary.workspaces[0]!;
  expect(workspace.status).toBe('ready');
  const inspection = workspace.inspection as Extract<typeof workspace.inspection, { headCommit: string }>;
  expect('unavailableReason' in workspace.inspection).toBe(false);
  expect(inspection.counts.tracked).toBeGreaterThanOrEqual(1);
  expect(inspection.counts.modifiedTracked).toBeGreaterThanOrEqual(1);
  expect(inspection.counts.untracked).toBeGreaterThanOrEqual(1);
  expect(inspection.counts.ignored).toBeGreaterThanOrEqual(1);
  expect(inspection.contents.modifiedTracked).toContain('README.md');
  expect(inspection.contents.untracked).toContain('new-file.bin');
  expect(inspection.contents.ignored).toContain('local.ignored');
  expect(inspection.impact.irreversible).toBe(true);
  expect(inspection.impact.preserves).toContain('source_repository');
  // 阻塞：必须走既有 workspace.discard 确认，项目删除确认不隐式丢弃未保存代码。
  expect(page.blockers).toContain('workspace_discard_confirmation_required');
  expect(page.confirmable).toBe(false);
  expect(page.policy.worktreeContents).toBe('dirty_contents_require_separate_discard_confirmation');
  // 预览零删除：脏内容原样保留。
  expect(existsSync(join(f.worktreePath(), 'new-file.bin'))).toBe(true);

  // 清空未保存内容与 ignored 残留后不再阻塞（独立丢弃完成后可确认）。
  git(['checkout', '--', '.'], f.worktreePath());
  git(['clean', '-fdx'], f.worktreePath());
  const clean = await f.previewViaCommand();
  const cleanInspection = clean.summary.workspaces[0]!.inspection as Extract<ProjectDeletePreviewPage['summary']['workspaces'][number]['inspection'], { headCommit: string }>;
  expect(cleanInspection.counts.modifiedTracked).toBe(0);
  expect(cleanInspection.counts.untracked).toBe(0);
  expect(cleanInspection.counts.ignored).toBe(0);
  expect(clean.blockers).not.toContain('workspace_discard_confirmation_required');
  expect(clean.confirmable).toBe(true);
  f.close();
});

it('[case:cross-project-and-unknown-refs] 跨项目被引用与未知引用阻塞删除，且清单严格按项目隔离', async () => {
  const f = await openPreviewFixture();
  const artifactRow = f.session.database.prepare('SELECT id FROM artifacts WHERE project_id = ? ORDER BY id LIMIT 1').get(f.projectId) as { id: string };
  await f.archive();
  // 项目 A 的悬空引用（JSON source_refs 指向不存在的制品；content_ref 受同项目 FK）。
  seedMemoryRecord(f, 'mem-a-dangling', f.projectId, artifactRow.id, ['artifact-does-not-exist']);
  // 项目 B 的行经 JSON 引用列指向项目 A 的制品（跨项目被引用证据）。
  seedProjectRow(f, 'project-b', 'B');
  f.session.transactWrite('fixture.project-b-artifact', () => {
    const body = Buffer.from('project-b-body', 'utf8');
    f.session.database.prepare(`INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator)
      VALUES ('artifact-b-1', ?, 'project-b', ?, 'document', 'ready', 'text/plain', ?, ?, ?, 'documents/b.txt')`)
      .run(NOW, NOW, sha256(body), sha256(body), body.byteLength);
  });
  seedMemoryRecord(f, 'mem-b-incoming', 'project-b', 'artifact-b-1', [artifactRow.id]);

  const page = await f.previewViaCommand();
  expect(page.summary.references.incomingCrossProject).toBe(1);
  expect(page.summary.references.unknown).toBe(1);
  expect(page.summary.references.examples.join('\n')).toContain('incoming:memory_records.source_refs:project-b');
  expect(page.blockers).toContain('incoming_cross_project_reference');
  expect(page.blockers).toContain('unknown_reference');
  expect(page.confirmable).toBe(false);

  // 项目隔离：A 的预览绝不包含 B 的对象；被引用制品仍完整列出（不省略阻塞对象）。
  const serialized = JSON.stringify(page.entries);
  expect(serialized).not.toContain('project-b');
  expect(serialized).not.toContain('mem-b-incoming');
  expect(page.summary.objects.byKind.memory_records).toBe(1);
  expect(page.entries.find(entry => entry.kind === 'artifacts' && entry.id === artifactRow.id)).toBeDefined();

  // 移除跨项目引用与悬空引用后阻塞解除（引用关系变化改变摘要并恢复可确认）。
  f.session.database.prepare('DELETE FROM memory_records').run();
  const cleared = await f.previewViaCommand();
  expect(cleared.summary.references.incomingCrossProject).toBe(0);
  expect(cleared.summary.references.unknown).toBe(0);
  expect(cleared.blockers).toEqual([]);
  expect(cleared.confirmable).toBe(true);
  expect(cleared.previewDigest).not.toBe(page.previewDigest);
  f.close();
});

it('[case:digest-invalidation] 内容/绑定/引用/保留变化后摘要失效，过期预览拒绝确认', async () => {
  const f = await openPreviewFixture();
  await f.archive();
  // 摘要对比全部走直接服务调用（命令面预览本身会追加回执行，改变清单）。
  const servicePreview = () => f.previewService().preview({ principal: f.owner, projectId: f.projectId });
  const baseline = await servicePreview();
  const artifactId = (f.session.database.prepare('SELECT id FROM artifacts WHERE project_id = ? ORDER BY id LIMIT 1').get(f.projectId) as { id: string }).id;
  const bodyPath = join(f.root, 'projects', f.projectId, 'artifacts', artifactId, 'content');
  const originalBody = readFileSync(bodyPath);

  // 内容变化：正文漂移 → 摘要变化 + 清点不完整 → 不可确认。
  writeFileSync(bodyPath, Buffer.from('tampered-body', 'utf8'));
  const drifted = await servicePreview();
  expect(drifted.previewDigest).not.toBe(baseline.previewDigest);
  expect(drifted.inventoryComplete).toBe(false);
  expect(drifted.inventoryReasons.join('\n')).toContain('artifact_body_drift');
  expect(drifted.confirmable).toBe(false);

  // 翻页游标在两页之间内容变化后失效（摘要不匹配 → preview_content_changed）。
  const small = f.previewService(4);
  const first = await small.preview({ principal: f.owner, projectId: f.projectId });
  writeFileSync(bodyPath, Buffer.from('tampered-between-pages', 'utf8'));
  await expect(small.preview({ principal: f.owner, projectId: f.projectId, cursor: first.pagination.nextCursor! }))
    .rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_content_changed' } });

  // 恢复内容：摘要回到基线（确定性绑定）。
  writeFileSync(bodyPath, originalBody);
  const restored = await servicePreview();
  expect(restored.previewDigest).toBe(baseline.previewDigest);
  expect(restored.confirmable).toBe(true);

  // 绑定 revision 变化：真实 project.metadata.update CAS 改项目 revision（绑定行受
  // 不可变触发器保护，真实“绑定变化”经管理命令而非直接改行）→ 摘要失效。
  const metadata = await f.submit('project.metadata.update', {
    displayName: '删除预览摘要失效', description: null, labels: [],
  }, { expectedRevision: f.projectRow().revision });
  if (metadata.status !== 'completed') throw new Error(`metadata update failed: ${JSON.stringify(metadata)}`);
  const bindingChanged = await servicePreview();
  expect(f.projectRow().revision).toBe(baseline.projectRevision + 1);
  expect(bindingChanged.previewDigest).not.toBe(baseline.previewDigest);

  // 引用变化：新增本项目引用 → 摘要失效。
  seedMemoryRecord(f, 'mem-a-new', f.projectId, artifactId, [artifactId]);
  const referenceChanged = await servicePreview();
  expect(referenceChanged.summary.references.inProject).toBeGreaterThan(baseline.summary.references.inProject);
  expect(referenceChanged.previewDigest).not.toBe(baseline.previewDigest);
  f.session.database.prepare("DELETE FROM memory_records WHERE id = 'mem-a-new'").run();

  // 保留项变化：新增备份目录 → 摘要失效。
  mkdirSync(join(f.root, 'backups', 'backup-20261030'));
  const retentionChanged = await servicePreview();
  expect(retentionChanged.previewDigest).not.toBe(baseline.previewDigest);

  // 有效期：时钟越过 expiresAt → preview_expired 阻塞 + 游标续页拒绝。
  const beforeExpiry = await servicePreview();
  expect(beforeExpiry.confirmable).toBe(true);
  f.clock.now = beforeExpiry.expiresAtUtcMs + 1;
  expect(assessProjectDeletePreviewConfirmability(beforeExpiry, f.clock.now).blockers).toContain('preview_expired');
  // 有效期只约束同一游标会话：过期后续页拒绝（preview_expired）。
  const expirySession = f.previewService(4);
  const expiryFirst = await expirySession.preview({ principal: f.owner, projectId: f.projectId });
  f.clock.now = expiryFirst.expiresAtUtcMs + 1;
  await expect(expirySession.preview({ principal: f.owner, projectId: f.projectId, cursor: expiryFirst.pagination.nextCursor! }))
    .rejects.toMatchObject({ code: 'conflict', details: { reason: 'preview_expired' } });
  f.close();
});

it('[case:target-derivation-safety] 删除目标只按数据库关系与受管区推导，不接受展示名/客户端路径', async () => {
  const f = await openPreviewFixture();
  await f.archive();
  // locator 带误导性内容：目标推导只认 project_id 归属与 ID 派生路径。
  const decoyId = randomUUID();
  const body = Buffer.from('decoy-body', 'utf8');
  f.session.transactWrite('fixture.decoy', () => {
    f.session.database.prepare(`INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator)
      VALUES (?, ?, ?, ?, 'document', 'ready', 'text/plain', ?, ?, ?, '../../evil/outside-root.txt')`)
      .run(decoyId, NOW, f.projectId, NOW, sha256(body), sha256(body), body.byteLength);
  });
  mkdirSync(join(f.root, 'projects', f.projectId, 'artifacts', decoyId), { recursive: true });
  writeFileSync(join(f.root, 'projects', f.projectId, 'artifacts', decoyId, 'content'), body);
  mkdirSync(join(f.root, 'staging', f.projectId), { recursive: true });
  writeFileSync(join(f.root, 'staging', f.projectId, 'residue.part'), 'staging-residue');

  const page = await f.previewViaCommand();
  // 制品按 ID 列出/哈希（ID 派生路径），不出现 locator 字符串。
  expect(page.entries.find(entry => entry.kind === 'artifacts' && entry.id === decoyId)).toBeDefined();
  expect(JSON.stringify(page)).not.toContain('../../evil/outside-root.txt');
  expect(page.summary.artifactBodies.listed.find(item => item.artifactId === decoyId)?.sha256).toBe(sha256(body));  // staging 残留按受管区清点并列出。
  expect(page.entries.find(entry => entry.kind === 'artifact-staging-entry' && entry.id.includes('residue.part'))).toBeDefined();
  expect(page.confirmable).toBe(true);

  // 未知输入键（sourcePath 等客户端路径）在信封层拒绝，不进入清点。
  await expect((async () => {
    const commands = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => f.clock.now }),
      projectDeletePreview: f.previewService(),
      nowUtcMs: () => f.clock.now,
    });
    return commands.submit(f.owner, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(f.clock.now).toISOString(),
      operation: 'project.delete.preview', scope: { kind: 'project', projectId: f.projectId },
      payload: { projectId: f.projectId, sourcePath: '/etc/passwd' },
    });
  })()).rejects.toMatchObject({ code: 'invalid_input' });
  f.close();
});

it('[case:authorization-and-visibility] 无能力/不可见主体拒绝，预览命令幂等重放', async () => {
  const f = await openPreviewFixture();
  await f.archive();
  const service = f.previewService();

  // 缺少 project.lifecycle.write 能力 → forbidden。
  const noCapability = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });
  await expect(service.preview({ principal: noCapability, projectId: f.projectId }))
    .rejects.toMatchObject({ code: 'forbidden' });

  // 有能力但项目不可见 → forbidden（不区分不存在/不可见）。
  const noVisibility = createRestrictedPrincipal({
    capabilities: ['project.lifecycle.write'],
    projectScope: { kind: 'allowlist', projectIds: [randomUUID()] },
  });
  await expect(service.preview({ principal: noVisibility, projectId: f.projectId }))
    .rejects.toMatchObject({ code: 'forbidden' });

  // 项目不存在 → not_found。
  await expect(service.preview({ principal: f.owner, projectId: randomUUID() }))
    .rejects.toMatchObject({ code: 'not_found' });

  // 命令面幂等：同 commandId 同参数重放原回执。
  const commands = createCommandService({
    atomicStore: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => f.clock.now }),
    projectDeletePreview: service,
    nowUtcMs: () => f.clock.now,
  });
  const envelope = {
    schemaVersion: 5 as const, commandId: randomUUID(), issuedAt: new Date(f.clock.now).toISOString(),
    operation: 'project.delete.preview' as const, scope: { kind: 'project' as const, projectId: f.projectId },
    payload: { projectId: f.projectId },
  };
  const first = await commands.submit(f.owner, envelope) as CommandReceipt;
  expect(first.status).toBe('completed');
  const replayed = await commands.submit(f.owner, envelope) as CommandReceipt;
  expect(replayed.status).toBe('completed');
  expect(replayed.replayed).toBe(true);
  f.close();
});
