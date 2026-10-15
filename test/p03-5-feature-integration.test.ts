/**
 * P03-5 / F-013 真实资源集成回归：经实际前序导入、批准、授权及认领入口
 * （openClaimFixture 真实命令链 project.register → settings.global.create →
 * phase.create → feature.plan.import → feature.plan.decide → execution.preview →
 * execution.start；生产组合根 openCoreApplication 认领/准备/保留），在真实临时
 * SQLite/Git 上组合首次准备、失败保留和重复恢复。
 *
 * 断言纪律：
 * - tracked/untracked/ignored 字节逐字节一致；合法已提交进展不重置；
 * - managed_workspaces 登记唯一；workspace_operations 逐项可审计；
 * - 源仓库 HEAD、既有 refs、index 与脏文件不变；新增受管 ref 单独列出；
 * - runtimeRecovery 恒为 not_evaluated：SDK 原生检查点/档案不能替代停止证据，
 *   恢复来源与 worktree 身份分别核验（core-design/14）；
 * - 未知停止后隔离持久化，禁止重跑（无双重写入者）；不重建 P03-9 完整控制恢复。
 *
 * 普通测试无网络模型；Git 与进程行为均真实，不以 Mock 代替。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCoreApplication, type CoreApplication } from 'shiploop-core/assembly';
import { createPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../packages/core/src/adapters/fs/work-workspace.ts';
import { createWorkspaceInspector } from '../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspaceAccess } from '../packages/core/src/adapters/sqlite/workspace.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { validateWorkspaceBaseline } from '../packages/core/src/ports/workspace.ts';
import { deriveManagedFeatureBranch } from '../packages/core/src/ports/workspace-preparation.ts';
import type { CommandProcessIdentity } from '../packages/core/src/ports/command-process.ts';
import type { WorkResourceIdentity } from '../packages/core/src/ports/work-resources.ts';
import { createLocalOwnerPrincipal } from './helpers/p02-2/principals.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { commitAll, git } from './helpers/git-repo.ts';

const OWNER = createLocalOwnerPrincipal();

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

interface Chain {
  readonly f: ClaimFixture;
  readonly app: CoreApplication;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly source: string;
  readonly branch: string;
}

/** 生产组合根认领 + 准备（已提交认领回执交接；权标由同一 authority 实例颁发）。 */
async function claimAndPrepare(chain: Chain, index: number, workspaceId: string) {
  const { app, f } = chain;
  const binding = await app.stateStore.getRepositoryBinding(chain.projectId);
  const token = await app.workWorkspaceAuthority.verifyPreparation(binding, chain.featureId);
  const claim = app.taskClaims.claimTask({ ...f.input(index), workspace: token }).receipt;
  const identity: WorkResourceIdentity = {
    projectId: chain.projectId,
    attemptId: claim.attempt.id,
    owner: claim.attempt.owner,
    hostInstanceId: claim.attempt.hostInstanceId,
    executionVersion: claim.attempt.executionVersion,
  };
  const input = {
    identity,
    taskId: `t-${index + 1}`,
    runId: chain.runId,
    claimKey: claim.claimKey,
    operationId: randomUUID(),
    workspaceId,
  };
  const prepared = await app.workspacePreparation.prepare(input);
  return { token, claim, identity, input, prepared };
}

/**
 * 可信内部进展登记（与 F-006 同一纪律）：真实只读检查 + 证据发布 +
 * workspace operation 两阶段事务；不是产品命令入口，不授予验收通过。
 */
async function recordProgress(chain: Chain, identity: WorkResourceIdentity, preparationOperationId: string) {
  const { session } = chain.f.box;
  const paths = createPathService({
    dataRoot: chain.f.box.box.root,
    projectLookup: createSqliteStateStore(session),
    featureLookup: createSqliteQueryStore(session),
  });
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [chain.f.box.box.root], preparationPaths: paths });
  const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
  const access = createSqliteWorkspaceAccess(session, { resources, nowUtcMs: () => NOW });
  const publisher = createArtifactPublisher({
    artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => NOW }),
    files: createArtifactFileStore({ dataRoot: chain.f.box.box.root }),
    limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 10_000 },
  });
  const publishEvidence = async (operationId: string, evidence: Readonly<Record<string, unknown>>) => {
    expect(session.database.inTransaction).toBe(false);
    const body = Buffer.from(JSON.stringify(evidence));
    const published = await publisher.publishArtifact({
      projectId: chain.projectId, kind: 'workspace_evidence', mediaType: 'application/json',
      expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${operationId}.json`, content: [body],
    });
    return published.artifact.id;
  };
  const confirm = async (processIdentity: CommandProcessIdentity) => {
    await publishEvidence(processIdentity.launchId, { processIdentity });
    return { launchId: processIdentity.launchId };
  };
  const inspector = createWorkspaceInspector({ authorizedRoots: [chain.f.box.box.root], confirmProcessIdentity: confirm });
  const workspace = access.readWorkspace(chain.projectId, chain.featureId)!;
  const baseline = validateWorkspaceBaseline(access.readOperation(chain.projectId, preparationOperationId)!.inputSnapshot.baseline);
  const inspection = await inspector.inspect(baseline);
  const evidenceRef = await publishEvidence(randomUUID(), { inspection, expectedHead: inspection.repository.headCommit });
  const operationId = randomUUID();
  const receipt = (step: string) => createCompletedReceipt({
    commandId: randomUUID(), principalId: 'trusted-f013-progress',
    operation: 'execution.start', scope: { kind: 'project', projectId: chain.projectId },
    requestDigest: createHash('sha256').update(step).digest('hex'),
    issuedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
    result: { workspaceOperationId: operationId, workspaceId: workspace.id }, resultRef: createResultRef(randomBytes(32)),
  });
  const intent = session.transactWrite('test.progress.intent', () => access.beginInTransaction({
    operationId, workspaceId: workspace.id, featureId: chain.featureId, kind: 'retain', identity,
    executionStage: 'commit', expectedWorkspaceRevision: workspace.revision, baseline, receipt: receipt('intent'),
  }));
  const done = session.transactWrite('test.progress.result', () => access.finishInTransaction({
    operationId, identity, expectedRevision: intent.operation.revision, expectedWorkspaceRevision: intent.workspace.revision,
    status: 'succeeded', workspaceStatus: 'retained', headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest,
    result: { evidenceRefs: [evidenceRef], errorRef: null, startedAtUtcMs: NOW, endedAtUtcMs: NOW, durationMs: 0, exitCode: 0, signal: null },
    receipt: receipt('result'),
  }));
  return { authority, evidenceRef, operation: done.operation, headCommit: inspection.repository.headCommit };
}

/** 读取生产组合根发布的 workspace_evidence 制品正文（<dataRoot>/projects/<pid>/artifacts/<id>/content）。 */
function readEvidence(chain: Chain, artifactId: string): Record<string, unknown> {
  const path = join(chain.f.box.box.dataRoot, 'projects', chain.projectId, 'artifacts', artifactId, 'content');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('F-013 真实资源集成回归：首次准备 → 失败保留 → 重复恢复', () => {
  let chain: Chain | undefined;
  afterEach(() => {
    chain?.app.close();
    chain?.f.box.close();
    chain = undefined;
  });

  it('全链路组合：字节一致、登记唯一、源仓库不变、受管 ref 单独列证据、合法提交不重置', async () => {
    const f = await openClaimFixture([[], []]);
    const app = await openCoreApplication({
      dataRoot: f.box.box.dataRoot,
      capabilityCatalog: f.box.box.capabilityCatalog,
    });
    const projectId = f.box.projectId;
    const featureId = f.box.featureId;
    chain = { f, app, projectId, featureId, runId: f.ids.runId, source: f.box.box.repoDirA, branch: deriveManagedFeatureBranch(projectId, featureId) };
    const { source, branch } = chain;

    // 原生 SDK 档案（沙箱内、源码仓库之外）：恢复全程不得读取/复制/修改。
    const archivePath = join(f.box.box.root, 'native-archive.sqlite');
    const archive = new DatabaseSync(archivePath);
    archive.exec("CREATE TABLE native_session (body TEXT); INSERT INTO native_session VALUES ('keep native session separate');");
    try {
      // 源仓库脏现场：tracked 修改 + untracked + ignored，准备/恢复全程不得触碰。
      writeFileSync(join(source, 'README.md'), 'dirty tracked source bytes\n');
      writeFileSync(join(source, 'only-source.txt'), 'dirty untracked source bytes\n');
      writeFileSync(join(source, '.gitignore'), 'ignored.local\n');
      writeFileSync(join(source, 'ignored.local'), 'preserved ignored source\n');
      const sourceHead = git(['rev-parse', 'HEAD'], source);
      const sourceRefs = git(['for-each-ref', '--format=%(refname) %(objectname)'], source);
      const indexPath = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], source).trim();
      const sourceIndex = readFileSync(indexPath);
      const sourceDirty = ['README.md', 'only-source.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(source, name)));
      const baseCommit = sourceHead.trim();
      const nativeBytes = readFileSync(archivePath);

      // 1) 首次准备（生产组合根；真实 claim 回执交接）。
      const first = await claimAndPrepare(chain, 0, randomUUID());
      expect(first.prepared.operation.status).toBe('succeeded');
      expect(first.prepared.workspace).toMatchObject({ status: 'ready', baseCommit, headCommit: baseCommit, branch });
      const worktree = first.prepared.workspace.canonicalPath;
      expect(existsSync(worktree)).toBe(true);

      // 准备证据：恢复来源与 worktree 身份分别记录；SDK 恢复未评估、不冒充停止证据。
      const evidence = readEvidence(chain, first.prepared.operation.result!.evidenceRefs[0]!);
      expect(evidence.runtimeRecovery).toBe('not_evaluated');
      expect(evidence.baseline).toMatchObject({ canonicalPath: worktree, branch, baseCommit });

      // 2) 合法进展：tracked 提交 + untracked + ignored（字节级快照）。
      writeFileSync(join(worktree, 'progress.txt'), 'legitimate committed progress\n');
      commitAll(worktree, 'authorized recorded progress');
      writeFileSync(join(worktree, 'dirty.txt'), 'additional untracked progress');
      writeFileSync(join(worktree, '.gitignore'), 'ignored.local\n');
      writeFileSync(join(worktree, 'ignored.local'), 'preserved ignored progress');
      const progressBytes = ['progress.txt', 'dirty.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(worktree, name)));
      const progress = await recordProgress(chain, first.identity, first.input.operationId);
      const progressHead = progress.headCommit;
      expect(progressHead).not.toBe(baseCommit);

      // 3) 失败保留：Attempt-1 准备失败终态（真实生命周期适配器，释放未启动占用）。
      const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: progress.authority, nowUtcMs: () => NOW });
      expect(lifecycle.apply({
        ...first.identity, runId: chain.runId, taskId: 't-1',
        notificationId: 'stop-preflight', kind: 'preparation_failed', errorKind: 'configuration',
        evidenceRef: first.prepared.operation.result!.evidenceRefs[0]!,
      }).disposition).toBe('applied');

      // 4) 重复恢复：新认领 Attempt-2 复用同一 retained workspace（生产组合根）。
      const second = await claimAndPrepare(chain, 1, first.input.workspaceId);
      expect(second.prepared.operation.status).toBe('succeeded');
      expect(second.prepared.workspace.id).toBe(first.prepared.workspace.id);
      expect(second.prepared.workspace.baseCommit).toBe(baseCommit);
      expect(second.prepared.workspace.headCommit).toBe(progressHead);

      // 合法既有提交不重置；tracked/untracked/ignored 字节逐字节一致。
      expect(git(['rev-parse', 'HEAD'], worktree).trim()).toBe(progressHead);
      expect(['progress.txt', 'dirty.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(worktree, name)))).toEqual(progressBytes);

      // 5) 失败保留收尾：Attempt-2 未启动停止证据 → retained，占用释放。
      const detail = await app.queryService.getWorkspace(OWNER, { projectId, featureId });
      const retained = await app.workspaceRetention.retain({
        identity: second.identity, runId: chain.runId, taskId: 't-2',
        workspaceId: second.prepared.workspace.id, operationId: randomUUID(),
        expectedWorkspaceRevision: detail.workspace.revision, reason: 'execution_error',
        evidenceRefs: second.prepared.operation.result!.evidenceRefs,
      });
      expect(retained.operation.status).toBe('succeeded');
      expect(retained.workspace.status).toBe('retained');
      expect(retained.receipt.status === 'completed' && retained.receipt.result).toMatchObject({ reason: 'execution_error', stop: 'not_started' });
      expect(app.workResources.read(second.identity).leases).toEqual([]);
      expect(['progress.txt', 'dirty.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(worktree, name)))).toEqual(progressBytes);

      // 登记唯一 + 操作逐项可审计（prepare/retain 共 4 项，无重复登记）。
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get()).toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get()).toEqual({ n: 4 });
      expect((git(['worktree', 'list', '--porcelain'], source).match(/worktree /g) ?? []).length).toBe(2);

      // 源仓库 HEAD、既有 refs、index、脏文件不变；新增受管 ref 单独列出。
      expect(git(['rev-parse', 'HEAD'], source)).toBe(sourceHead);
      expect(readFileSync(indexPath)).toEqual(sourceIndex);
      expect(['README.md', 'only-source.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(source, name)))).toEqual(sourceDirty);
      const refsAfter = git(['for-each-ref', '--format=%(refname) %(objectname)'], source).trim().split('\n').sort();
      const refsBefore = sourceRefs.trim().split('\n').sort();
      const managedRefs = refsAfter.filter(ref => !refsBefore.includes(ref));
      // 新增受管 ref 单独列出：唯一、受管命名、仅随合法已登记提交前进（不重置回 baseCommit）。
      expect(managedRefs).toEqual([`refs/heads/${branch} ${progressHead}`]);

      // 预算/运行事实：两次 Attempt、零 Runtime 启动、无用量冒充、任务不冒充通过。
      expect(f.box.session.database.prepare('SELECT attempts_created, runtime_starts FROM execution_batches').get())
        .toEqual({ attempts_created: 2, runtime_starts: 0 });
      expect(f.box.session.database.prepare('SELECT * FROM runtime_start_reservations').all()).toEqual([]);
      expect(f.box.session.database.prepare('SELECT status, usage_summary FROM attempts ORDER BY created_at').all())
        .toEqual([
          { status: 'failed', usage_summary: null },
          { status: 'preparing', usage_summary: null },
        ]);
      expect(f.box.session.database.prepare("SELECT status FROM tasks WHERE id = 't-1'").get()).toEqual({ status: 'failed' });

      // 原生档案未被读取/复制/修改（SDK 检查点不是恢复决策来源）。
      expect(readFileSync(archivePath)).toEqual(nativeBytes);
      expect(existsSync(join(worktree, 'native-archive.sqlite'))).toBe(false);
    } finally {
      archive.close();
    }
  }, 120_000);

  it('未知停止持久隔离：SDK 检查点不能替代停止证据，禁止未知停止后重跑', async () => {
    const f = await openClaimFixture();
    const app = await openCoreApplication({
      dataRoot: f.box.box.dataRoot,
      capabilityCatalog: f.box.box.capabilityCatalog,
    });
    const projectId = f.box.projectId;
    const featureId = f.box.featureId;
    chain = { f, app, projectId, featureId, runId: f.ids.runId, source: f.box.box.repoDirA, branch: deriveManagedFeatureBranch(projectId, featureId) };

    const first = await claimAndPrepare(chain, 0, randomUUID());
    expect(first.prepared.operation.status).toBe('succeeded');
    const worktree = first.prepared.workspace.canonicalPath;
    writeFileSync(join(worktree, 'sentinel.txt'), 'failure scene preserved bytes');
    const sentinel = readFileSync(join(worktree, 'sentinel.txt'));

    // 伪造的 SDK 原生检查点/档案存在（数据根内、源码仓库之外）——不构成停止证据。
    const archivePath = join(f.box.box.root, 'native-archive.sqlite');
    const archive = new DatabaseSync(archivePath);
    archive.exec("CREATE TABLE native_checkpoint (body TEXT); INSERT INTO native_checkpoint VALUES ('sdk checkpoint is not stop evidence');");
    archive.close();
    const nativeBytes = readFileSync(archivePath);

    // Runtime 可能已启动（启动占用登记、无停止回执）→ 停止结论 unknown。
    const paths = createPathService({
      dataRoot: f.box.box.root,
      projectLookup: createSqliteStateStore(f.box.session),
      featureLookup: createSqliteQueryStore(f.box.session),
    });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root], preparationPaths: paths });
    const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
    f.box.session.transactWrite('test.launch', () => resources.beginLaunchInTransaction(first.identity));

    const detail = await app.queryService.getWorkspace(OWNER, { projectId, featureId });
    const retained = await app.workspaceRetention.retain({
      identity: first.identity, runId: chain.runId, taskId: 't-1',
      workspaceId: first.prepared.workspace.id, operationId: randomUUID(),
      expectedWorkspaceRevision: detail.workspace.revision, reason: 'cancelled',
      evidenceRefs: first.prepared.operation.result!.evidenceRefs,
    });
    // 原生检查点在场也不改变结论：停止未知 → quarantined，绝不释放占用。
    expect(retained.workspace.status).toBe('quarantined');
    expect(retained.receipt.status === 'completed' && retained.receipt.result).toMatchObject({ reason: 'cancelled', stop: 'unknown', reusable: false });
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all())
      .toEqual([{ state: 'quarantined' }, { state: 'quarantined' }, { state: 'quarantined' }]);

    // 数据库与组合根重开后隔离持久化；禁止未知停止后重跑（无双重写入者）。
    app.close();
    f.box.reopen();
    const reopened = await openCoreApplication({
      dataRoot: f.box.box.dataRoot,
      capabilityCatalog: f.box.box.capabilityCatalog,
    });
    chain = { ...chain, app: reopened };
    try {
      expect(reopened.workResources.read(first.identity).leases.map(lease => lease.state))
        .toEqual(['quarantined', 'quarantined', 'quarantined']);
      const detailAfter = await reopened.queryService.getWorkspace(OWNER, { projectId, featureId });
      expect(detailAfter.workspace.status).toBe('quarantined');
      const operationsBefore = f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get() as { n: number };
      await expect(reopened.workspacePreparation.prepare(first.input)).rejects.toThrow();
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get()).toEqual(operationsBefore);
      expect(readFileSync(join(worktree, 'sentinel.txt'))).toEqual(sentinel);
      expect(readFileSync(archivePath)).toEqual(nativeBytes);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get()).toEqual({ n: 1 });
    } finally {
      reopened.close();
    }
  }, 120_000);
});
