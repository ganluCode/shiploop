/**
 * P01-4 / F-003 P01 持久化闭环场景（检查 `P01-FR1-NORMAL` / `P01-FR1-REOPEN`，
 * 契约见 docs/p01-4-acceptance-contract.md §2.1）：经**真实 Core 应用服务**在
 * F-002 夹具的临时数据根上注册真实 Git 仓库、写全局默认与项目覆盖配置、发布
 * 固定正文制品；关闭全部连接后以**新的装配实例**打开同一数据根，逐字段核对
 * 项目/绑定/元数据、配置 schemaVersion/payload/revision/有效配置来源与制品
 * 身份/hash/size/正文完全一致。
 *
 * 纪律：
 * - 只经产品公共入口（openCoreApplication → ProjectService / ConfigurationService /
 *   ArtifactStore + 发布/核对用例）读写，不用验收脚本直接插入业务行替代产品接口，
 *   也不读取原实例内存缓存（重开为独立装配实例）；
 * - 重开后重复注册返回相同项目（already_exists）且无多余项目/绑定；制品文件位于
 *   受控数据根而非源仓库；源仓库 HEAD/工作文件/哨兵与根外哨兵逐字节不变；
 * - 重开前后状态、正文摘要与相对 locator 的结构化证据先写入独立报告目录，
 *   再删除业务资源；业务清理后证据仍可读；
 * - 场景可独立运行并连续执行两次，各次使用全新夹具资源；不调用模型或后续
 *   Host/CLI 能力；必需工具（Git/SQLite）缺失时由夹具显式失败而非 skip。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import {
  canonicalJson,
  sha256Hex,
  withP01AcceptanceFixture,
} from './helpers/p01-4-fixture.ts';
import type {
  P01AcceptanceFixture,
  P01EvidenceRef,
  P01RepoSentinelSnapshot,
} from './helpers/p01-4-fixture.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PUBLISH_LIMITS = { maxSizeBytes: 1_048_576, timeoutMs: 30_000 } as const;
const VERIFY_LIMITS = { maxReadBytes: 1_048_576 } as const;

/** 归一化后的固定标签（trim/NFC/ASCII 小写/去重，与产品共用规则一致）。 */
const EXPECTED_LABELS = ['core', '核心', '验收'] as const;

/** 闭环产出的可核对结果（供「连续两次」用例比对独立性）。 */
interface ClosedLoopOutcome {
  readonly root: string;
  readonly dataRoot: string;
  readonly businessInputDigest: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly artifactId: string;
  readonly evidenceRefs: readonly P01EvidenceRef[];
}

/**
 * 经产品服务读取的持久状态快照（重开前后逐字段比对的载体）。
 * 全部为端口返回值的原样序列化，不混入内存缓存。
 */
interface PersistedStateSnapshot {
  readonly project: unknown;
  readonly binding: unknown;
  readonly globalSettings: unknown;
  readonly projectSettings: unknown;
  readonly effectiveSettings: unknown;
  readonly artifact: unknown;
  readonly artifactContentSha256: string;
  readonly artifactContentSizeBytes: number;
  readonly artifactRelativePath: string;
}

function snapshotEqual(before: PersistedStateSnapshot, after: PersistedStateSnapshot): boolean {
  return canonicalJson(before) === canonicalJson(after);
}

/**
 * 单次闭环场景：写入 → 关闭 → 新实例重开 → 逐字段比对 → 重复注册幂等 →
 * 源仓库/哨兵不变 → 证据先行落盘。返回可跨运行核对的结果摘要。
 */
async function runPersistenceClosedLoop(fixture: P01AcceptanceFixture): Promise<ClosedLoopOutcome> {
  const input = fixture.businessInput;
  const repoBefore = fixture.snapshotSourceRepo();
  const outsideBefore = fixture.snapshotOutsideSentinel();

  // —— 第一阶段：经应用服务写入全部业务事实（P01-FR1-NORMAL） ——
  const firstApp = await fixture.openApplication();
  let before: PersistedStateSnapshot;
  let projectId = '';
  let bindingId = '';
  let artifactId = '';
  try {
    const registration = await firstApp.projectService.registerRepository({
      repositoryPath: fixture.repoDir,
      displayName: input.project.displayName,
      description: input.project.description,
      labels: [...input.project.labels],
    });
    expect(registration.status).toBe('registered');
    projectId = registration.project.id;
    bindingId = registration.binding.id;
    expect(registration.project.labels).toEqual([...EXPECTED_LABELS]);
    expect(registration.project.revision).toBe(1);
    expect(registration.binding.canonicalPath).toBe(realpathSync(fixture.repoDir));
    expect(registration.binding.repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);

    // 全局默认 + 项目覆盖（schemaVersion=2 固定夹具配置，凭据/端点只传引用）。
    const globalCreated = await firstApp.configurationService.createSettings(
      { kind: 'global' },
      { payload: input.globalSettings },
    );
    expect(globalCreated.schemaVersion).toBe(2);
    expect(globalCreated.revision).toBe(1);
    const projectCreated = await firstApp.configurationService.createSettings(
      { kind: 'project', projectId },
      { payload: input.projectSettings },
    );
    expect(projectCreated.revision).toBe(1);

    // 固定正文制品：分两块流式发布，hash/size 入库。
    const publisher = createArtifactPublisher({
      artifacts: firstApp.artifactStore,
      files: firstApp.artifactFileStore,
      limits: PUBLISH_LIMITS,
    });
    const splitAt = 13;
    const contentParts = [
      new Uint8Array(fixture.artifactBytes.subarray(0, splitAt)),
      new Uint8Array(fixture.artifactBytes.subarray(splitAt)),
    ];
    const published = await publisher.publishArtifact({
      projectId,
      kind: input.artifact.kind,
      mediaType: input.artifact.mediaType,
      expectedHash: fixture.artifactSha256,
      locator: input.artifact.locator,
      version: input.artifact.version,
      content: contentParts,
    });
    artifactId = published.artifact.id;
    expect(published.artifact.status).toBe('ready');
    expect(published.artifact.contentHash).toBe(fixture.artifactSha256);
    expect(published.artifact.sizeBytes).toBe(fixture.artifactBytes.length);

    // 制品正文必须落在受控数据根内，而非源仓库。
    const publishedAbsolute = join(firstApp.dataRoot, published.finalRelativePath);
    expect(existsSync(publishedAbsolute)).toBe(true);
    expect(
      realpathSync(publishedAbsolute).startsWith(realpathSync(firstApp.dataRoot) + '/'),
    ).toBe(true);
    expect(realpathSync(publishedAbsolute).startsWith(realpathSync(fixture.repoDir) + '/')).toBe(
      false,
    );

    // 有效配置精确值与逐项来源（项目覆盖完整替换 defaultStrategy 与 verification 段）。
    const effective = await firstApp.configurationService.getEffectiveSettings(projectId);
    expect(effective.configured).toBe(true);
    expect(effective.strategies.defaultStrategy?.strategy.model).toBe('claude-sonnet');
    expect(effective.strategies.defaultStrategy?.strategy.credentialRef).toBe(
      'credref-fixture-1',
    );
    expect(effective.strategies.defaultStrategy?.strategy.endpointRef).toBe(
      'endpoint-fixture-1',
    );
    expect(effective.strategies.defaultStrategy?.source).toEqual({
      kind: 'project_default',
      scopeRevision: 1,
      sourceKey: 'defaultStrategy',
    });
    expect(effective.policies.executionLimits?.source.kind).toBe('global_default');
    expect(effective.policies.executionLimits?.value).toEqual(
      (input.globalSettings.policies as Record<string, unknown>).executionLimits,
    );
    expect(effective.policies.verification?.source.kind).toBe('project_default');
    expect(effective.policies.securityPolicy?.source.kind).toBe('global_default');

    // 制品正文经核对端口读回，逐字节等于固定夹具字节。
    const verifier = createArtifactVerifier({
      artifacts: firstApp.artifactStore,
      files: firstApp.artifactFileStore,
      limits: VERIFY_LIMITS,
    });
    const verified = await verifier.readVerifiedContent(projectId, artifactId);
    expect(Buffer.from(verified.content)).toEqual(fixture.artifactBytes);
    expect(verified.contentHash).toBe(fixture.artifactSha256);
    expect(verified.sizeBytes).toBe(fixture.artifactBytes.length);

    before = {
      project: await firstApp.projectService.getProject(projectId),
      binding: await firstApp.projectService.getRepositoryBinding(projectId),
      globalSettings: await firstApp.configurationService.getCurrentSettings({ kind: 'global' }),
      projectSettings: await firstApp.configurationService.getCurrentSettings({
        kind: 'project',
        projectId,
      }),
      effectiveSettings: effective,
      artifact: published.artifact,
      artifactContentSha256: verified.contentHash,
      artifactContentSizeBytes: verified.sizeBytes,
      artifactRelativePath: published.finalRelativePath,
    };
  } finally {
    firstApp.close();
  }

  // —— 第二阶段：关闭全部连接后以新的装配实例重开同一数据根（P01-FR1-REOPEN） ——
  const reopenedApp = await fixture.openApplication();
  expect(reopenedApp).not.toBe(firstApp);
  let after: PersistedStateSnapshot;
  try {
    const projectAfter = await reopenedApp.projectService.getProject(projectId);
    const bindingAfter = await reopenedApp.projectService.getRepositoryBinding(projectId);
    const globalAfter = await reopenedApp.configurationService.getCurrentSettings({
      kind: 'global',
    });
    const projectSettingsAfter = await reopenedApp.configurationService.getCurrentSettings({
      kind: 'project',
      projectId,
    });
    const effectiveAfter = await reopenedApp.configurationService.getEffectiveSettings(projectId);
    const artifactAfter = await reopenedApp.artifactStore.getArtifact(projectId, artifactId);
    const verifierAfter = createArtifactVerifier({
      artifacts: reopenedApp.artifactStore,
      files: reopenedApp.artifactFileStore,
      limits: VERIFY_LIMITS,
    });
    const verifiedAfter = await verifierAfter.readVerifiedContent(projectId, artifactId);

    // 逐字段一致：projectId/绑定/元数据、配置 schemaVersion/payload/revision、
    // 有效配置来源、制品身份/hash/size/正文。
    expect(projectAfter).toEqual(before.project);
    expect(bindingAfter).toEqual(before.binding);
    expect(globalAfter).toEqual(before.globalSettings);
    expect(projectSettingsAfter).toEqual(before.projectSettings);
    expect(globalAfter.schemaVersion).toBe(2);
    expect(globalAfter.payload).toEqual(input.globalSettings);
    expect(projectSettingsAfter.payload).toEqual(input.projectSettings);
    expect(JSON.stringify(effectiveAfter)).toBe(JSON.stringify(before.effectiveSettings));
    expect(effectiveAfter.strategies.defaultStrategy?.source.kind).toBe('project_default');
    expect(artifactAfter).toEqual(before.artifact);
    expect(artifactAfter.contentHash).toBe(fixture.artifactSha256);
    expect(artifactAfter.sizeBytes).toBe(fixture.artifactBytes.length);
    expect(artifactAfter.locator).toBe(input.artifact.locator);
    expect(Buffer.from(verifiedAfter.content)).toEqual(fixture.artifactBytes);
    expect(verifiedAfter.relativePath).toBe(before.artifactRelativePath);

    after = {
      project: projectAfter,
      binding: bindingAfter,
      globalSettings: globalAfter,
      projectSettings: projectSettingsAfter,
      effectiveSettings: effectiveAfter,
      artifact: artifactAfter,
      artifactContentSha256: verifiedAfter.contentHash,
      artifactContentSizeBytes: verifiedAfter.sizeBytes,
      artifactRelativePath: verifiedAfter.relativePath,
    };
    expect(snapshotEqual(before, after)).toBe(true);

    // 重开后重复注册同一规范路径：返回相同项目/绑定，不新增行、不覆盖元数据。
    const duplicate = await reopenedApp.projectService.registerRepository({
      repositoryPath: fixture.repoDir,
      displayName: '不应覆盖既有名称',
      labels: ['不应覆盖'],
    });
    expect(duplicate.status).toBe('already_exists');
    expect(duplicate.project).toEqual(before.project);
    expect(duplicate.binding).toEqual(before.binding);
    const page = await reopenedApp.projectService.listProjects();
    expect(page.records.map((record) => record.id)).toEqual([projectId]);
    const labelsAfterDuplicate = await reopenedApp.projectService.getProject(projectId);
    expect(labelsAfterDuplicate.labels).toEqual([...EXPECTED_LABELS]);

    // 重开后制品文件仍位于受控数据根内。
    expect(
      existsSync(join(reopenedApp.dataRoot, before.artifactRelativePath)),
    ).toBe(true);
  } finally {
    reopenedApp.close();
  }

  // —— 第三阶段：源仓库与根外哨兵逐字节不变（不迁入、不改写） ——
  const repoAfter = fixture.snapshotSourceRepo();
  expect(repoAfter).toEqual(repoBefore);
  expect(repoAfter.head).toBe(fixture.sourceRepoHead);
  expect(repoAfter.statusPorcelain.trim()).toBe('');
  expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

  // —— 第四阶段：结构化证据先落盘（业务清理前），按契约 §2.1 证据字段组织 ——
  const bindingRecord = before.binding as Record<string, unknown>;
  const evidenceRefs: P01EvidenceRef[] = [];
  evidenceRefs.push(
    fixture.writeEvidence(
      'closed-loop/fr1-normal.json',
      JSON.stringify(
        {
          checkId: 'P01-FR1-NORMAL',
          status: 'pass',
          businessInputDigest: fixture.businessInputDigest,
          project_id: projectId,
          repository_binding: {
            id: bindingId,
            canonical_path_sha256: sha256Hex(String(bindingRecord.canonicalPath)),
            repo_identity: bindingRecord.repoIdentity,
          },
          config: {
            global: {
              schema_version: 2,
              revision: 1,
              payload_digest: sha256Hex(canonicalJson(input.globalSettings)),
            },
            project: {
              schema_version: 2,
              revision: 1,
              payload_digest: sha256Hex(canonicalJson(input.projectSettings)),
            },
            effective_sources: {
              defaultStrategy: 'project_default',
              executionLimits: 'global_default',
              verification: 'project_default',
              securityPolicy: 'global_default',
            },
          },
          artifact: {
            id: artifactId,
            content_hash: fixture.artifactSha256,
            size_bytes: fixture.artifactBytes.length,
            locator: input.artifact.locator,
            relative_path: before.artifactRelativePath,
          },
          source_repo: repoEvidence(repoBefore),
          outside_sentinel_sha256: outsideBefore,
          tools: fixture.tools,
        },
        null,
        2,
      ),
    ),
  );
  evidenceRefs.push(
    fixture.writeEvidence(
      'closed-loop/fr1-reopen.json',
      JSON.stringify(
        {
          checkId: 'P01-FR1-REOPEN',
          status: 'pass',
          project_id: projectId,
          field_by_field_equal: snapshotEqual(before, after),
          before: snapshotDigests(before),
          after: snapshotDigests(after),
          duplicate_registration: 'already_exists',
          project_count_after_reopen: 1,
          artifact_relative_locator: before.artifactRelativePath,
          artifact_content_sha256: fixture.artifactSha256,
          artifact_size_bytes: fixture.artifactBytes.length,
          source_repo: repoEvidence(repoAfter),
          source_repo_unchanged: canonicalJson(repoAfter) === canonicalJson(repoBefore),
        },
        null,
        2,
      ),
    ),
  );

  return {
    root: fixture.root,
    dataRoot: fixture.dataRoot,
    businessInputDigest: fixture.businessInputDigest,
    projectId,
    bindingId,
    artifactId,
    evidenceRefs,
  };
}

/** 源仓库证据：不记录绝对路径，只记录可核对摘要。 */
function repoEvidence(snapshot: P01RepoSentinelSnapshot): Record<string, unknown> {
  return {
    head: snapshot.head,
    status_porcelain_empty: snapshot.statusPorcelain.trim() === '',
    files_digest: sha256Hex(canonicalJson(snapshot.files)),
    sentinel_sha256: snapshot.sentinelSha256,
  };
}

/** 快照摘要：逐字段状态的结构化 digest（证据正文不复制大 payload）。 */
function snapshotDigests(snapshot: PersistedStateSnapshot): Record<string, unknown> {
  return {
    project_digest: sha256Hex(canonicalJson(snapshot.project)),
    binding_digest: sha256Hex(canonicalJson(snapshot.binding)),
    global_settings_digest: sha256Hex(canonicalJson(snapshot.globalSettings)),
    project_settings_digest: sha256Hex(canonicalJson(snapshot.projectSettings)),
    effective_settings_digest: sha256Hex(canonicalJson(snapshot.effectiveSettings)),
    artifact_digest: sha256Hex(canonicalJson(snapshot.artifact)),
    artifact_content_sha256: snapshot.artifactContentSha256,
    artifact_content_size_bytes: snapshot.artifactContentSizeBytes,
    artifact_relative_path: snapshot.artifactRelativePath,
  };
}

describe('F-003 P01 持久化闭环（P01-FR1-NORMAL / P01-FR1-REOPEN）', () => {
  it('注册→配置→制品→关闭重开逐字段一致，重复注册幂等，源仓库与哨兵不变，证据先行落盘', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const sentinelAtStart = fixture.snapshotOutsideSentinel();
      const outcome = await runPersistenceClosedLoop(fixture);

      // 证据引用有效且在报告目录内（相对路径 + hash + size）。
      expect(outcome.evidenceRefs).toHaveLength(2);
      for (const ref of outcome.evidenceRefs) {
        expect(ref.relativePath).toMatch(/^closed-loop\/fr1-(normal|reopen)\.json$/);
        expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(ref.sizeBytes).toBeGreaterThan(0);
        expect(existsSync(join(fixture.reportDir, ref.relativePath))).toBe(true);
      }

      // 业务清理后证据仍可读（证据先于清理落盘，报告目录独立于业务根）。
      fixture.cleanup();
      expect(fixture.cleaned).toBe(true);
      expect(existsSync(fixture.dataRoot)).toBe(false);
      const normal = JSON.parse(
        readFileSync(join(fixture.reportDir, 'closed-loop/fr1-normal.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(normal.checkId).toBe('P01-FR1-NORMAL');
      expect(normal.status).toBe('pass');
      expect(normal.project_id).toBe(outcome.projectId);
      const reopen = JSON.parse(
        readFileSync(join(fixture.reportDir, 'closed-loop/fr1-reopen.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(reopen.checkId).toBe('P01-FR1-REOPEN');
      expect(reopen.field_by_field_equal).toBe(true);
      expect(reopen.source_repo_unchanged).toBe(true);
      // 证据不含受测仓库/Harness 个人目录作为运行依赖。
      const evidenceText = JSON.stringify([normal, reopen]);
      expect(evidenceText).not.toContain(REPO_ROOT);
      // 根外哨兵在业务清理后仍保持不变。
      expect(fixture.snapshotOutsideSentinel()).toBe(sentinelAtStart);
    });
  });

  it('连续两次独立执行：全新临时资源、相同业务输入摘要、两次闭环各自逐字段一致', async () => {
    const outcomes: ClosedLoopOutcome[] = [];
    for (let run = 0; run < 2; run += 1) {
      outcomes.push(
        await withP01AcceptanceFixture(async (fixture) => {
          const outcome = await runPersistenceClosedLoop(fixture);
          // 每次运行都使用全新资源且证据落盘后再收尾。
          fixture.cleanup();
          expect(fixture.cleaned).toBe(true);
          return outcome;
        }),
      );
    }
    // 相同固定业务输入：摘要跨运行稳定。
    expect(outcomes[0]?.businessInputDigest).toBe(outcomes[1]?.businessInputDigest);
    // 全新资源：临时根不同、项目身份由存储端口独立生成。
    expect(outcomes[0]?.root).not.toBe(outcomes[1]?.root);
    expect(outcomes[0]?.dataRoot).not.toBe(outcomes[1]?.dataRoot);
    expect(outcomes[0]?.projectId).not.toBe(outcomes[1]?.projectId);
    expect(outcomes[0]?.artifactId).not.toBe(outcomes[1]?.artifactId);
  });
});
