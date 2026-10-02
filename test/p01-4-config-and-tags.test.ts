/**
 * P01-4 / F-006 当前配置与项目标签阶段检查组（检查 `P01-FR2-CONFIG` /
 * `P01-FR2-TAGS`，契约见 docs/p01-4-acceptance-contract.md §2.1 / §4）：
 *
 * - `P01-FR2-CONFIG`：实际经**真实 Core 应用服务**（openCoreApplication →
 *   ConfigurationService）覆盖完整策略整体替换、政策段级覆盖、当前值与逐项来源
 *   关闭重开读取、未知版本/未知 runtime/不完整策略/明文秘密拒绝、凭据只保存引用；
 *   输出**精确值或结构化错误**（kind/field/reason），不仅标记测试名存在；
 * - `P01-FR2-TAGS`：真实注册与元数据编辑下的标签规范化、非法数组拒绝、项目层
 *   任一/全部筛选、去重计数；非法更新后元数据与 revision 不变；单纯改标签不改
 *   绑定/配置/制品路径；筛选与计数改后立即反映持久状态；
 * - 合成秘密只用于验证普通导出、结构化错误与脱敏变更记录不泄漏，检查不读取
 *   真实凭据、不访问环境/认证文件/Keychain；
 * - 明确区分 P01 已实现子集（当前配置 + 项目标签）与未实现的
 *   Task/Attempt/Batch 执行模型、Task 策略复制（属 P03）；不新增策略复制或执行表；
 * - 证据（精确值、来源、结构化错误、命中项目 ID 集合与计数、副作用核对）在删除
 *   临时业务资源之前序列化到独立报告目录；必需工具（Git/SQLite）缺失由 F-002
 *   夹具显式失败而非 skip。
 */
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import {
  assessSettingsConfiguration,
  createStaticRuntimeCapabilityCatalog,
} from '../packages/core/src/ports/runtime-capabilities.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { canonicalJson, withP01AcceptanceFixture } from './helpers/p01-4-fixture.ts';
import type { P01AcceptanceFixture, P01EvidenceRef } from './helpers/p01-4-fixture.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 合成凭据哨兵：只以引用形式出现，任何导出/错误/审计/证据文本都不得回显。 */
const SYNTHETIC_SECRET = 'sk-synthetic-f006-do-not-leak';
const GLOBAL_CREDENTIAL_REF = 'keychain://shiploop/global-default';
const PROJECT_ENDPOINT_REF = 'endpoint://shiploop/project-endpoint';

/** P01 子集边界：区分本阶段已实现能力与后续 Task/Attempt/Batch 执行模型。 */
const P01_SUBSET = {
  implemented: [
    '当前配置 schemaVersion=2 结构与政策子集',
    '完整策略条目整体替换与政策段级覆盖',
    '当前值与逐项来源（global_default/project_default）读取',
    '项目标签规范化/任一全部筛选/去重计数',
  ],
  not_covered: [
    'Task 策略复制（tasks.execution_config）属 P03',
    'Phase/Feature/Task/Run/Attempt/Batch 执行模型与调度',
    '配置历史版本表与跨层策略编排',
    'Phase/Feature/Task 层级标签与跨层求和',
  ],
} as const;

/** 与 F-002 夹具同形态但更完整的能力目录：anthropic 枚举模型、openai 透传。 */
function createCatalog() {
  return createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [
        { providerId: 'anthropic', models: ['claude-sonnet', 'claude-opus'] },
        { providerId: 'openai' },
      ],
    },
  ]);
}

/** 全局默认：完整策略 + 非敏感政策子集（凭据只保存引用）。 */
const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: GLOBAL_CREDENTIAL_REF,
    },
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000 },
    verification: { requireChecksBeforeDone: true },
  },
};

/** 项目覆盖：完整 defaultStrategy 条目整体替换全局（不同 provider/model + 端点引用）。 */
const PROJECT_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'openai',
      model: 'gpt-project-default',
      endpointRef: PROJECT_ENDPOINT_REF,
    },
  },
  policies: { executionLimits: { maxConcurrentWorks: 2 } },
};

function expectStorageError(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<StorageError> {
  return fn().then(
    () => {
      throw new Error(`expected StorageError(${kind})`);
    },
    (error: unknown) => {
      expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(
        true,
      );
      return error as StorageError;
    },
  );
}

function countRows(session: SqliteStorageSession, table: string): number {
  const row = session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

interface StateEventRow {
  readonly project_id: string | null;
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_revision: number;
  readonly payload: string;
}

function readStateEvents(session: SqliteStorageSession): StateEventRow[] {
  return session.database
    .prepare<[], StateEventRow>(
      'SELECT project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload ' +
        'FROM state_events ORDER BY sequence',
    )
    .all();
}

function listUserTables(session: SqliteStorageSession): string[] {
  return session.database
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

/** 在夹具受控业务根内新建真实 Git 仓库（含 commit），用于多项目标签场景。 */
function createExtraRepo(fixture: P01AcceptanceFixture, name: string): string {
  const dir = join(fixture.root, name);
  initGitRepo(dir);
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf-8');
  commitAll(dir, 'init', { home: fixture.homeDir });
  return dir;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** 证据先行落盘 + 业务清理后仍可读 + 根外哨兵不变的统一收尾断言。 */
function assertEvidenceSurvivesCleanup(
  fixture: P01AcceptanceFixture,
  refs: readonly P01EvidenceRef[],
  expectedPaths: readonly string[],
  outsideBefore: string,
): Record<string, unknown>[] {
  expect(refs.map((ref) => ref.relativePath)).toEqual([...expectedPaths]);
  for (const ref of refs) {
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(fixture.reportDir, ref.relativePath))).toBe(true);
  }
  fixture.cleanup();
  expect(fixture.cleaned).toBe(true);
  expect(existsSync(fixture.dataRoot)).toBe(false);
  const parsed = expectedPaths.map((relativePath) => {
    const text = readFileSync(join(fixture.reportDir, relativePath), 'utf-8');
    // 证据不含受测仓库/Harness 个人目录作为运行依赖。
    expect(text).not.toContain(REPO_ROOT);
    return JSON.parse(text) as Record<string, unknown>;
  });
  expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);
  return parsed;
}

describe('F-006 当前配置检查组（P01-FR2-CONFIG）', () => {
  it('完整策略整体覆盖、当前值与来源重开读取、凭据仅保存引用且审计脱敏', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const repoBefore = fixture.snapshotSourceRepo();
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication({ capabilityCatalog: createCatalog() });
      const projectIdRef = { id: '' };
      let effectiveBeforeJson = '';
      let exportJson = '';
      let globalCredentialRefPreserved = false;
      let projectDefaultNoStitching = false;
      let stateEvents: StateEventRow[] = [];
      try {
        // —— 写入：注册真实仓库 → 全局默认 → 项目完整覆盖 ——
        const registration = await app.projectService.registerRepository({
          repositoryPath: fixture.repoDir,
          displayName: '配置检查组',
          labels: ['config'],
        });
        expect(registration.status).toBe('registered');
        projectIdRef.id = registration.project.id;

        const globalCreated = await app.configurationService.createSettings(
          { kind: 'global' },
          { payload: GLOBAL_PAYLOAD },
        );
        expect(globalCreated.schemaVersion).toBe(2);
        expect(globalCreated.revision).toBe(1);

        const projectCreated = await app.configurationService.createSettings(
          { kind: 'project', projectId: projectIdRef.id },
          { payload: PROJECT_PAYLOAD },
        );
        expect(projectCreated.schemaVersion).toBe(2);
        expect(projectCreated.revision).toBe(1);

        const projectCurrent = await app.configurationService.getCurrentSettings({
          kind: 'project',
          projectId: projectIdRef.id,
        });
        expect(projectCurrent.schemaVersion).toBe(2);
        expect(projectCurrent.revision).toBe(1);
        expect(projectCurrent.payload).toEqual(PROJECT_PAYLOAD);

        // —— 有效配置：完整条目整体替换（不跨来源拼接）+ 逐项来源 ——
        const effective = await app.configurationService.getEffectiveSettings(projectIdRef.id);
        expect(effective.configured).toBe(true);
        expect(effective.schemaVersion).toBe(2);
        // defaultStrategy 精确等于项目完整条目；全局条目的 credentialRef 未被拼接进来。
        expect(effective.strategies.defaultStrategy?.strategy).toEqual(
          PROJECT_PAYLOAD.strategies?.defaultStrategy,
        );
        expect(effective.strategies.defaultStrategy?.strategy).not.toHaveProperty('credentialRef');
        expect(effective.strategies.defaultStrategy?.strategy.endpointRef).toBe(
          PROJECT_ENDPOINT_REF,
        );
        projectDefaultNoStitching =
          effective.strategies.defaultStrategy?.strategy.provider === 'openai' &&
          effective.strategies.defaultStrategy?.strategy.credentialRef === undefined;
        expect(effective.strategies.defaultStrategy?.source).toEqual({
          kind: 'project_default',
          scopeRevision: 1,
          sourceKey: 'defaultStrategy',
        });
        // 未覆盖条目继承全局并标注 global_default。
        expect(effective.strategies.modelMap.low?.strategy).toEqual(
          GLOBAL_PAYLOAD.strategies?.modelMap?.low,
        );
        expect(effective.strategies.modelMap.low?.source).toEqual({
          kind: 'global_default',
          scopeRevision: 1,
          sourceKey: 'modelMap.low',
        });
        // 政策段级整体覆盖：项目段只含 maxConcurrentWorks，全局段字段不进入。
        expect(effective.policies.executionLimits?.value).toEqual({ maxConcurrentWorks: 2 });
        expect(effective.policies.executionLimits?.source).toEqual({
          kind: 'project_default',
          scopeRevision: 1,
          sourceKey: 'policies.executionLimits',
        });
        expect(effective.policies.verification?.value).toEqual({ requireChecksBeforeDone: true });
        expect(effective.policies.verification?.source).toEqual({
          kind: 'global_default',
          scopeRevision: 1,
          sourceKey: 'policies.verification',
        });
        effectiveBeforeJson = JSON.stringify(effective);

        // —— 普通脱敏导出：引用原样保留、无执行就绪标记、无合成秘密 ——
        const exported = await app.configurationService.exportSettings(projectIdRef.id);
        expect(exported.exportFormatVersion).toBe(1);
        expect(exported.scope).toBe('project');
        expect(exported.projectId).toBe(projectIdRef.id);
        expect(exported.current.revision).toBe(1);
        exportJson = JSON.stringify(exported);
        expect(exportJson).toContain(PROJECT_ENDPOINT_REF);
        expect(exportJson).not.toContain(SYNTHETIC_SECRET);
        expect(exportJson).not.toContain('"executable"');
        expect(exportJson).not.toContain('"ready"');

        // 全局导出保留全局凭据引用（引用不是秘密），证明引用只保存不解析。
        const globalExport = await app.configurationService.exportSettings();
        expect(globalExport.scope).toBe('global');
        globalCredentialRefPreserved = JSON.stringify(globalExport).includes(GLOBAL_CREDENTIAL_REF);
        expect(globalCredentialRefPreserved).toBe(true);

        // —— CAS 更新（revision 1→2）：生成一条脱敏变更记录供核对 ——
        const updatedPayload: SettingsPayload = {
          schemaVersion: 2,
          strategies: {
            defaultStrategy: PROJECT_PAYLOAD.strategies!.defaultStrategy!,
            modelMap: { high: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' } },
          },
          policies: { executionLimits: { maxConcurrentWorks: 2 } },
        };
        const updated = await app.configurationService.updateSettings(
          { kind: 'project', projectId: projectIdRef.id },
          { expectedRevision: 1, payload: updatedPayload },
        );
        expect(updated.revision).toBe(2);

        const effectiveAfterUpdate =
          await app.configurationService.getEffectiveSettings(projectIdRef.id);
        expect(effectiveAfterUpdate.strategies.defaultStrategy?.source).toEqual({
          kind: 'project_default',
          scopeRevision: 2,
          sourceKey: 'defaultStrategy',
        });
        expect(effectiveAfterUpdate.strategies.modelMap.high?.source).toEqual({
          kind: 'project_default',
          scopeRevision: 2,
          sourceKey: 'modelMap.high',
        });
        expect(effectiveAfterUpdate.strategies.modelMap.low?.source).toEqual({
          kind: 'global_default',
          scopeRevision: 1,
          sourceKey: 'modelMap.low',
        });
        effectiveBeforeJson = JSON.stringify(effectiveAfterUpdate);
      } finally {
        app.close();
      }

      // —— 只读核对脱敏变更记录（真实库，不手工改库） ——
      const rawSession = openSqliteStorageSession({
        path: join(fixture.dataRoot, DATABASE_FILE_NAME),
      });
      try {
        stateEvents = readStateEvents(rawSession);
      } finally {
        rawSession.close();
      }
      expect(stateEvents.map((event) => event.event_type)).toEqual(['settings.project_updated']);
      expect(stateEvents[0]?.aggregate_revision).toBe(2);
      expect(stateEvents[0]?.project_id).toBe(projectIdRef.id);
      const eventsJson = JSON.stringify(stateEvents);
      expect(eventsJson).not.toContain(SYNTHETIC_SECRET);
      expect(eventsJson).not.toContain(GLOBAL_CREDENTIAL_REF);
      expect(eventsJson).not.toContain(PROJECT_ENDPOINT_REF);

      // —— 关闭全部连接后以新装配实例重开：当前值与来源逐字段一致 ——
      const reopened = await fixture.openApplication({ capabilityCatalog: createCatalog() });
      try {
        const globalAfter = await reopened.configurationService.getCurrentSettings({
          kind: 'global',
        });
        expect(globalAfter.schemaVersion).toBe(2);
        expect(globalAfter.revision).toBe(1);
        expect(globalAfter.payload).toEqual(GLOBAL_PAYLOAD);

        const projectAfter = await reopened.configurationService.getCurrentSettings({
          kind: 'project',
          projectId: projectIdRef.id,
        });
        expect(projectAfter.schemaVersion).toBe(2);
        expect(projectAfter.revision).toBe(2);

        const effectiveAfter = await reopened.configurationService.getEffectiveSettings(
          projectIdRef.id,
        );
        expect(JSON.stringify(effectiveAfter)).toBe(effectiveBeforeJson);
        expect(effectiveAfter.strategies.defaultStrategy?.source.kind).toBe('project_default');
        expect(effectiveAfter.strategies.modelMap.low?.source.kind).toBe('global_default');
      } finally {
        reopened.close();
      }

      // —— 源仓库与根外哨兵逐字节不变（配置写入不迁移/不改写源仓库） ——
      expect(fixture.snapshotSourceRepo()).toEqual(repoBefore);
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      // —— 证据先落盘（凭据引用卫生 + 精确值 + 来源 + 审计脱敏 + 重开一致） ——
      const ref = fixture.writeEvidence(
        'config-and-tags/fr2-config.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-CONFIG',
            status: 'pass',
            scenario: 'full_strategy_override_and_reopen',
            scope: 'project',
            schema_version: 2,
            revision: 2,
            current_values: {
              global: {
                schema_version: 2,
                revision: 1,
                default_strategy: GLOBAL_PAYLOAD.strategies?.defaultStrategy ?? null,
              },
              project: {
                schema_version: 2,
                revision: 2,
                default_strategy: PROJECT_PAYLOAD.strategies?.defaultStrategy ?? null,
                model_map_high: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' },
              },
            },
            effective: {
              defaultStrategy: {
                value: PROJECT_PAYLOAD.strategies?.defaultStrategy ?? null,
                source: { kind: 'project_default', sourceKey: 'defaultStrategy', scopeRevision: 2 },
              },
              modelMapLow: {
                value: GLOBAL_PAYLOAD.strategies?.modelMap?.low ?? null,
                source: { kind: 'global_default', sourceKey: 'modelMap.low', scopeRevision: 1 },
              },
              policiesExecutionLimits: {
                value: { maxConcurrentWorks: 2 },
                source: {
                  kind: 'project_default',
                  sourceKey: 'policies.executionLimits',
                  scopeRevision: 2,
                },
              },
              policiesVerification: {
                value: { requireChecksBeforeDone: true },
                source: {
                  kind: 'global_default',
                  sourceKey: 'policies.verification',
                  scopeRevision: 1,
                },
              },
            },
            credential_references: {
              global_credential_ref_preserved: globalCredentialRefPreserved,
              project_endpoint_ref_preserved: exportJson.includes(PROJECT_ENDPOINT_REF),
              plaintext_secret_in_export: exportJson.includes(SYNTHETIC_SECRET),
              no_cross_source_stitching: projectDefaultNoStitching,
            },
            audit: {
              event_types: stateEvents.map((event) => event.event_type),
              state_events: stateEvents.length,
              aggregate_revision: stateEvents[0]?.aggregate_revision ?? null,
              contains_reference:
                eventsJson.includes(GLOBAL_CREDENTIAL_REF) ||
                eventsJson.includes(PROJECT_ENDPOINT_REF),
              contains_secret: eventsJson.includes(SYNTHETIC_SECRET),
            },
            reopen: { current_equal: true, effective_equal: true, sources_equal: true },
            source_repo_unchanged:
              canonicalJson(fixture.snapshotSourceRepo()) === canonicalJson(repoBefore),
            outside_sentinel_sha256: outsideBefore,
            p01_subset: P01_SUBSET,
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      const parsed = assertEvidenceSurvivesCleanup(
        fixture,
        [ref],
        ['config-and-tags/fr2-config.json'],
        outsideBefore,
      );
      expect(parsed[0]?.checkId).toBe('P01-FR2-CONFIG');
      expect(parsed[0]?.status).toBe('pass');
      expect(parsed[0]?.credential_references).toMatchObject({
        global_credential_ref_preserved: true,
        project_endpoint_ref_preserved: true,
        plaintext_secret_in_export: false,
        no_cross_source_stitching: true,
      });
      expect(parsed[0]?.audit).toMatchObject({
        event_types: ['settings.project_updated'],
        contains_reference: false,
        contains_secret: false,
      });
    });
  });

  it('未知版本/未知 runtime/不完整策略/明文秘密拒绝：结构化错误且零副作用、错误脱敏', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication({ capabilityCatalog: createCatalog() });
      const projectIdRef = { id: '' };
      let globalBeforeJson = '';
      const rejections: Record<string, unknown>[] = [];
      try {
        const registration = await app.projectService.registerRepository({
          repositoryPath: fixture.repoDir,
          displayName: '拒绝检查组',
        });
        projectIdRef.id = registration.project.id;
        await app.configurationService.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        const globalBefore = await app.configurationService.getCurrentSettings({ kind: 'global' });
        globalBeforeJson = JSON.stringify(globalBefore);

        const cases: ReadonlyArray<{
          readonly label: string;
          readonly payload: unknown;
          readonly field?: string;
          readonly reason?: string;
        }> = [
          {
            label: 'unknown_schema_version',
            payload: { schemaVersion: 1, strategies: {} },
            field: 'payload.schemaVersion',
          },
          {
            label: 'unknown_runtime',
            payload: {
              schemaVersion: 2,
              strategies: {
                defaultStrategy: { runtime: 'ghost-runtime', provider: 'anthropic', model: 'claude-sonnet' },
              },
            },
            field: 'payload.strategies.defaultStrategy.runtime',
            reason: 'unknown_runtime',
          },
          {
            label: 'incomplete_strategy',
            payload: {
              schemaVersion: 2,
              strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic' } },
            },
            field: 'payload.strategies.defaultStrategy.model',
          },
          {
            label: 'plaintext_secret',
            payload: {
              schemaVersion: 2,
              strategies: {
                defaultStrategy: {
                  runtime: 'pi',
                  provider: 'anthropic',
                  model: 'claude-sonnet',
                  apiKey: SYNTHETIC_SECRET,
                },
              },
            },
          },
        ];

        for (const testCase of cases) {
          const error = await expectStorageError('validation', () =>
            app.configurationService.createSettings(
              { kind: 'project', projectId: projectIdRef.id },
              { payload: testCase.payload },
            ),
          );
          expect(error.operation).toBe('ConfigurationService.createSettings');
          expect(error.entity?.type).toBe('project_settings');
          if (testCase.field !== undefined) {
            expect(error.details?.field).toBe(testCase.field);
          }
          if (testCase.reason !== undefined) {
            expect(error.details?.reason).toBe(testCase.reason);
          }
          const text = `${error.message} ${JSON.stringify(error.details)}`;
          expect(text).not.toContain(SYNTHETIC_SECRET);
          rejections.push({
            case: testCase.label,
            kind: error.kind,
            field: (error.details?.field as string | undefined) ?? null,
            reason: (error.details?.reason as string | undefined) ?? null,
            leaked_secret: text.includes(SYNTHETIC_SECRET),
          });
        }

        // 零副作用：项目配置始终不存在、全局配置逐字段不变。
        const missing = await expectStorageError('not_found', () =>
          app.configurationService.getCurrentSettings({
            kind: 'project',
            projectId: projectIdRef.id,
          }),
        );
        expect(missing.entity?.type).toBe('project_settings');
        const globalAfter = await app.configurationService.getCurrentSettings({ kind: 'global' });
        expect(JSON.stringify(globalAfter)).toBe(globalBeforeJson);
      } finally {
        app.close();
      }

      // 真实库只读核对：拒绝分支零业务行、零变更记录。
      const rawSession = openSqliteStorageSession({
        path: join(fixture.dataRoot, DATABASE_FILE_NAME),
      });
      let projectSettingsRows = -1;
      let stateEventRows = -1;
      try {
        projectSettingsRows = countRows(rawSession, 'project_settings');
        stateEventRows = countRows(rawSession, 'state_events');
      } finally {
        rawSession.close();
      }
      expect(projectSettingsRows).toBe(0);
      expect(stateEventRows).toBe(0);

      const ref = fixture.writeEvidence(
        'config-and-tags/fr2-config-rejections.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-CONFIG',
            status: 'pass',
            scenario: 'structured_rejections_zero_side_effects',
            rejections,
            side_effects: {
              project_settings_rows: projectSettingsRows,
              state_events_rows: stateEventRows,
              global_unchanged: true,
            },
            p01_subset: P01_SUBSET,
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      const parsed = assertEvidenceSurvivesCleanup(
        fixture,
        [ref],
        ['config-and-tags/fr2-config-rejections.json'],
        outsideBefore,
      );
      expect(parsed[0]?.checkId).toBe('P01-FR2-CONFIG');
    });
  });

  it('P01 子集边界：仅当前配置/项目/制品表，无 Task/Attempt/Batch 执行表，合法≠可执行', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication({ capabilityCatalog: createCatalog() });
      const projectIdRef = { id: '' };
      try {
        const registration = await app.projectService.registerRepository({
          repositoryPath: fixture.repoDir,
          displayName: '子集边界项目',
        });
        projectIdRef.id = registration.project.id;
        await app.configurationService.createSettings(
          { kind: 'project', projectId: projectIdRef.id },
          { payload: PROJECT_PAYLOAD },
        );
        const effective = await app.configurationService.getEffectiveSettings(projectIdRef.id);
        expect(effective.configured).toBe(true);

        // 合法 ≠ 可执行：P01 未装配 Runner/认证/模型执行能力。
        const assessment = assessSettingsConfiguration(PROJECT_PAYLOAD);
        expect(assessment.configured).toBe(true);
        expect(assessment.executable).toBe(false);
        expect(assessment.reason).toBe('execution_capability_not_assembled');
      } finally {
        app.close();
      }

      const rawSession = openSqliteStorageSession({
        path: join(fixture.dataRoot, DATABASE_FILE_NAME),
      });
      let tables: string[] = [];
      try {
        tables = listUserTables(rawSession);
      } finally {
        rawSession.close();
      }
      expect(tables).toEqual(
        [
          'artifacts',
          'global_settings',
          'project_settings',
          'projects',
          'repository_bindings',
          'schema_migrations',
          'state_events',
        ].sort(),
      );
      for (const forbidden of [
        'tasks',
        'attempts',
        'batches',
        'runs',
        'sessions',
        'works',
        'phases',
        'features',
      ]) {
        expect(tables).not.toContain(forbidden);
      }

      const ref = fixture.writeEvidence(
        'config-and-tags/p01-subset-boundary.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-CONFIG',
            status: 'pass',
            scenario: 'p01_subset_boundary',
            storage_tables: tables,
            execution_tables_present: false,
            strategy_copy_tables_present: false,
            configured_but_not_executable: true,
            p01_subset: P01_SUBSET,
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      const parsed = assertEvidenceSurvivesCleanup(
        fixture,
        [ref],
        ['config-and-tags/p01-subset-boundary.json'],
        outsideBefore,
      );
      expect(parsed[0]?.scenario).toBe('p01_subset_boundary');
      expect(parsed[0]?.execution_tables_present).toBe(false);
      expect(parsed[0]?.strategy_copy_tables_present).toBe(false);
      expect(parsed[0]?.configured_but_not_executable).toBe(true);
    });
  });
});

describe('F-006 项目标签检查组（P01-FR2-TAGS）', () => {
  it('标签规范化/非法数组拒绝/任一全部筛选与去重计数，非法更新零副作用，改标签不改绑定配置制品', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const repoBefore = fixture.snapshotSourceRepo();
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication({ capabilityCatalog: createCatalog() });
      const projectIds = { a: '', b: '', c: '', d: '' };
      let evidenceData: Record<string, unknown> = {};
      try {
        // —— 真实注册四个仓库，标签含前后空格/大小写/Unicode 重复 ——
        const repoA = createExtraRepo(fixture, '标签 项目 A');
        const repoB = createExtraRepo(fixture, '标签 项目 B');
        const repoC = createExtraRepo(fixture, '标签 项目 C');
        const repoD = createExtraRepo(fixture, '标签 项目 D');

        const regA = await app.projectService.registerRepository({
          repositoryPath: repoA,
          displayName: '项目 A',
          labels: [' Core ', 'CORE', '核心'],
        });
        expect(regA.status).toBe('registered');
        expect(regA.project.labels).toEqual(['core', '核心']);

        const regB = await app.projectService.registerRepository({
          repositoryPath: repoB,
          displayName: '项目 B',
          labels: ['core', 'api'],
        });
        const regC = await app.projectService.registerRepository({
          repositoryPath: repoC,
          displayName: '项目 C',
          labels: ['ui', 'UI', ' ui '],
        });
        // 规范化去重：同项目重复/大小写/空白标签折叠为一个。
        expect(regC.project.labels).toEqual(['ui']);
        const regD = await app.projectService.registerRepository({
          repositoryPath: repoD,
          displayName: '项目 D',
        });
        expect(regD.project.labels).toEqual([]);
        projectIds.a = regA.project.id;
        projectIds.b = regB.project.id;
        projectIds.c = regC.project.id;
        projectIds.d = regD.project.id;

        // —— 任一/全部筛选：准确项目 ID 集合与计数 ——
        const anyCore = await app.projectService.listProjects({ match: 'any', labels: ['core'] });
        expect(sorted(anyCore.records.map((record) => record.id))).toEqual(
          sorted([projectIds.a, projectIds.b]),
        );
        expect(anyCore.records).toHaveLength(2);
        expect(anyCore.nextCursor).toBeNull();

        const anyCoreUi = await app.projectService.listProjects({
          match: 'any',
          labels: ['core', 'ui'],
        });
        expect(sorted(anyCoreUi.records.map((record) => record.id))).toEqual(
          sorted([projectIds.a, projectIds.b, projectIds.c]),
        );

        const allCoreApi = await app.projectService.listProjects({
          match: 'all',
          labels: ['core', 'api'],
        });
        expect(allCoreApi.records.map((record) => record.id)).toEqual([projectIds.b]);

        // 空过滤返回全部可见项目；无命中返回空且无下一页。
        const allProjects = await app.projectService.listProjects();
        expect(sorted(allProjects.records.map((record) => record.id))).toEqual(
          sorted([projectIds.a, projectIds.b, projectIds.c, projectIds.d]),
        );
        const noMatch = await app.projectService.listProjects({
          match: 'all',
          labels: ['core', 'ui'],
        });
        expect(noMatch.records).toEqual([]);
        expect(noMatch.nextCursor).toBeNull();

        // —— 项目层去重计数（同一项目同标签只计一次，不跨层级求和） ——
        const counts = await app.projectService.countProjectLabels();
        const normalizedCounts = [...counts]
          .map((entry) => ({ label: entry.label, projectCount: entry.projectCount }))
          .sort((a, b) => a.label.localeCompare(b.label));
        expect(normalizedCounts).toEqual([
          { label: 'api', projectCount: 1 },
          { label: 'core', projectCount: 2 },
          { label: 'ui', projectCount: 1 },
          { label: '核心', projectCount: 1 },
        ]);
        for (const entry of counts) {
          expect(Object.keys(entry).sort()).toEqual(['label', 'projectCount']);
        }

        // —— 非法数组拒绝：注册与更新均在任何 I/O 之前拒绝 ——
        const badRegistration = await expectStorageError('validation', () =>
          app.projectService.registerRepository({
            repositoryPath: repoA,
            displayName: '非法标签项目',
            labels: ['   '],
          }),
        );
        expect(badRegistration.operation).toBe('ProjectService.registerRepository');
        expect(badRegistration.details?.field).toBe('labels[0]');

        const beforeA = await app.projectService.getProject(projectIds.a);
        const badUpdate = await expectStorageError('validation', () =>
          app.projectService.updateProjectMetadata(projectIds.a, {
            expectedRevision: beforeA.revision,
            labels: [42],
          }),
        );
        expect(badUpdate.operation).toBe('ProjectService.updateProjectMetadata');
        // 非法更新后元数据与 revision 不变。
        expect(await app.projectService.getProject(projectIds.a)).toEqual(beforeA);

        // —— 为项目 B 建立配置与制品，快照后仅改标签 ——
        await app.configurationService.createSettings(
          { kind: 'project', projectId: projectIds.b },
          { payload: PROJECT_PAYLOAD },
        );
        const publisher = createArtifactPublisher({
          artifacts: app.artifactStore,
          files: app.artifactFileStore,
          limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
        });
        const published = await publisher.publishArtifact({
          projectId: projectIds.b,
          kind: 'verification-report',
          mediaType: 'text/markdown; charset=utf-8',
          expectedHash: fixture.artifactSha256,
          locator: 'artifacts/reports/tags-b.md',
          version: 1,
          content: [new Uint8Array(fixture.artifactBytes)],
        });
        expect(published.artifact.status).toBe('ready');

        const bindingBefore = await app.projectService.getRepositoryBinding(projectIds.b);
        const configBefore = await app.configurationService.getCurrentSettings({
          kind: 'project',
          projectId: projectIds.b,
        });
        const artifactBefore = await app.artifactStore.getArtifact(
          projectIds.b,
          published.artifact.id,
        );
        const projectDirBefore = await app.pathService.locateProjectResource(
          { projectId: projectIds.b },
          { type: 'project_directory' },
        );

        const updatedB = await app.projectService.updateProjectMetadata(projectIds.b, {
          expectedRevision: 1,
          labels: [' renamed '],
        });
        expect(updatedB.revision).toBe(2);
        expect(updatedB.labels).toEqual(['renamed']);
        expect(updatedB.id).toBe(projectIds.b);
        expect(updatedB.repositoryBindingId).toBe(regB.project.repositoryBindingId);

        // 绑定/配置/制品路径与正文均不变，不 rebind、不迁移源仓库。
        expect(await app.projectService.getRepositoryBinding(projectIds.b)).toEqual(bindingBefore);
        expect(
          await app.configurationService.getCurrentSettings({
            kind: 'project',
            projectId: projectIds.b,
          }),
        ).toEqual(configBefore);
        expect(await app.artifactStore.getArtifact(projectIds.b, published.artifact.id)).toEqual(
          artifactBefore,
        );
        expect(
          await app.pathService.locateProjectResource(
            { projectId: projectIds.b },
            { type: 'project_directory' },
          ),
        ).toEqual(projectDirBefore);
        const verifier = createArtifactVerifier({
          artifacts: app.artifactStore,
          files: app.artifactFileStore,
          limits: { maxReadBytes: 1_048_576 },
        });
        const verified = await verifier.readVerifiedContent(projectIds.b, published.artifact.id);
        expect(Buffer.from(verified.content)).toEqual(fixture.artifactBytes);
        expect(verified.relativePath).toBe(published.finalRelativePath);

        // 改标签后筛选与计数立即反映持久状态。
        const renamed = await app.projectService.listProjects({
          match: 'any',
          labels: ['renamed'],
        });
        expect(renamed.records.map((record) => record.id)).toEqual([projectIds.b]);
        const oldApi = await app.projectService.listProjects({ match: 'any', labels: ['api'] });
        expect(oldApi.records).toEqual([]);
        const countsAfter = [...(await app.projectService.countProjectLabels())]
          .map((entry) => ({ label: entry.label, projectCount: entry.projectCount }))
          .sort((a, b) => a.label.localeCompare(b.label));
        expect(countsAfter).toEqual([
          { label: 'core', projectCount: 1 },
          { label: 'renamed', projectCount: 1 },
          { label: 'ui', projectCount: 1 },
          { label: '核心', projectCount: 1 },
        ]);

        evidenceData = {
          normalization: {
            project_a_input: [' Core ', 'CORE', '核心'],
            project_a_normalized: regA.project.labels,
            project_c_input: ['ui', 'UI', ' ui '],
            project_c_normalized: regC.project.labels,
            project_d_normalized: regD.project.labels,
          },
          match_any: {
            labels: ['core'],
            match_mode: 'any',
            project_ids: sorted(anyCore.records.map((record) => record.id)),
            count: anyCore.records.length,
          },
          match_all: {
            labels: ['core', 'api'],
            match_mode: 'all',
            project_ids: allCoreApi.records.map((record) => record.id),
            count: allCoreApi.records.length,
          },
          empty_filter_count: allProjects.records.length,
          no_match_count: noMatch.records.length,
          dedup_counts: normalizedCounts,
          invalid_input: {
            registration: {
              kind: badRegistration.kind,
              field: badRegistration.details?.field ?? null,
            },
            update: { kind: badUpdate.kind, operation: badUpdate.operation },
          },
          invalid_update_no_side_effect: { metadata_unchanged: true, revision_unchanged: true },
          label_only_change: {
            binding_unchanged: true,
            config_unchanged: true,
            artifact_index_unchanged: true,
            artifact_relative_path: published.finalRelativePath,
            artifact_content_readable: true,
            project_directory_unchanged: true,
          },
          after_change: {
            renamed_match_ids: renamed.records.map((record) => record.id),
            old_label_match_count: oldApi.records.length,
            counts: countsAfter,
          },
          p01_subset: P01_SUBSET,
          tools: fixture.tools,
        };
      } finally {
        app.close();
      }

      // 源仓库与根外哨兵逐字节不变（标签筛选/编辑不触碰真实仓库）。
      expect(fixture.snapshotSourceRepo()).toEqual(repoBefore);
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      const ref = fixture.writeEvidence(
        'config-and-tags/fr2-tags.json',
        JSON.stringify(
          { checkId: 'P01-FR2-TAGS', status: 'pass', ...evidenceData },
          null,
          2,
        ),
      );
      const parsed = assertEvidenceSurvivesCleanup(
        fixture,
        [ref],
        ['config-and-tags/fr2-tags.json'],
        outsideBefore,
      );
      expect(parsed[0]?.checkId).toBe('P01-FR2-TAGS');
      expect(parsed[0]?.status).toBe('pass');
      expect(parsed[0]?.invalid_update_no_side_effect).toMatchObject({
        metadata_unchanged: true,
        revision_unchanged: true,
      });
      expect(parsed[0]?.label_only_change).toMatchObject({
        binding_unchanged: true,
        config_unchanged: true,
        artifact_index_unchanged: true,
        artifact_content_readable: true,
        project_directory_unchanged: true,
      });
    });
  });
});
