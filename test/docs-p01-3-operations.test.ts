/**
 * F-014 文档核验：`docs/p01-3-operations.md` 的说明与示例必须与真实可调用接口一致
 * （编译检查 + 运行断言），`docs/p01-4-handoff.md` 必须指向真实可复跑入口。
 *
 * 定位：F-014 只交付文档；为避免文档与实现漂移，本套件在真实临时 Git 仓库 + 真实临时
 * 数据根上，用公开装配入口 `openCoreApplication` 跑通「注册 → 查询 → CAS 编辑 →
 * 全局/项目配置 → 有效配置来源 → 脱敏导出 → 受权定位 → 关闭重开逐字段一致」，
 * 并交叉核对文档引用的真实常量（namespace、迁移版本、schemaVersion、标签/分页上限、
 * 导出格式版本）。不新增业务实现、不扩大 P01-3 交付范围。
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { SETTINGS_EXPORT_FORMAT_VERSION } from '../packages/core/src/application/configuration-service.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import {
  DATA_NAMESPACE,
  DATABASE_FILE_NAME,
  PROJECT_RESOURCE_TYPES,
  deriveDefaultDataRoot,
} from '../packages/core/src/ports/path-service.ts';
import {
  GLOBAL_SETTINGS_ID,
  PROJECT_LIST_DEFAULT_LIMIT,
  PROJECT_LIST_MAX_LIMIT,
} from '../packages/core/src/ports/state-store.ts';
import {
  DESCRIPTION_MAX_LENGTH,
  LABELS_MAX_COUNT,
  LABEL_MAX_LENGTH,
  PROJECT_DISPLAY_NAME_MAX_LENGTH,
} from '../packages/core/src/ports/validation.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATIONS_DOC_PATH = 'docs/p01-3-operations.md';
const HANDOFF_DOC_PATH = 'docs/p01-4-handoff.md';
const REPORT_DOC_PATH = 'docs/acceptance/p01-3-f014-report.md';
const operationsDoc = readFileSync(resolve(REPO_ROOT, OPERATIONS_DOC_PATH), 'utf-8');
const handoffDoc = readFileSync(resolve(REPO_ROOT, HANDOFF_DOC_PATH), 'utf-8');
const reportDoc = readFileSync(resolve(REPO_ROOT, REPORT_DOC_PATH), 'utf-8');

function createCatalog(): RuntimeCapabilityCatalog {
  return createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
    },
  ]);
}

function createCommittedRepo(sandbox: string, name: string): string {
  const repo = join(sandbox, name);
  initGitRepo(repo);
  writeFileSync(join(repo, 'README.md'), '# docs example\n', 'utf-8');
  commitAll(repo, 'init');
  return repo;
}

describe('F-014 P01-3 操作说明文档', () => {
  it('操作说明中的最小示例（§6）在真实仓库与数据根上编译并运行', async () => {
    const sandbox = createTempSandbox('shiploop-p013-f014-docs-', { outside: [REPO_ROOT] });
    try {
      const repositoryPath = createCommittedRepo(sandbox.path, 'repo');
      const dataRoot = join(sandbox.path, 'data');
      const app = await openCoreApplication({ dataRoot, capabilityCatalog: createCatalog() });
      let projectId: string;
      let registrationStatus: 'registered' | 'already_exists';
      let metadataRevision: number;
      let labels: readonly string[];
      let globalRevision: number;
      let projectRevision: number;
      let effectiveConfigured: boolean;
      let effectiveSourceKind: string;
      let effectiveScopeRevision: number;
      let exportedScope: string;
      let exportedFormatVersion: number;
      let locatedResourceType: string;
      try {
        // 2) 注册：稳定 projectId + 绑定，标签规范化去重。
        const registration = await app.projectService.registerRepository({
          repositoryPath,
          displayName: '示例项目',
          description: '最小示例',
          labels: ['Alpha', ' beta ', 'alpha'],
        });
        projectId = registration.project.id;
        registrationStatus = registration.status;
        expect(registrationStatus).toBe('registered');
        expect(registration.project.labels).toEqual(['alpha', 'beta']);
        expect(registration.binding.canonicalPath.startsWith(realpathSync(sandbox.path))).toBe(true);
        expect(registration.binding.repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);

        // 同路径重复注册幂等复用，不新增、不覆盖。
        const duplicate = await app.projectService.registerRepository({
          repositoryPath,
          displayName: '另一个名字',
        });
        expect(duplicate.status).toBe('already_exists');
        expect(duplicate.project.id).toBe(projectId);
        expect(duplicate.project.displayName).toBe('示例项目');

        // 3) CAS 编辑元数据。
        const fetched = await app.projectService.getProject(projectId);
        const updated = await app.projectService.updateProjectMetadata(projectId, {
          expectedRevision: fetched.revision,
          displayName: '示例项目（已改名）',
        });
        metadataRevision = updated.revision;
        labels = updated.labels;
        expect(metadataRevision).toBe(2);
        expect(labels).toEqual(['alpha', 'beta']);

        // 4) 全局默认 + 项目覆盖（insert-only）。
        const global = await app.configurationService.createSettings(
          { kind: 'global' },
          {
            payload: {
              schemaVersion: SETTINGS_SCHEMA_VERSION,
              strategies: {
                defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
              },
            },
          },
        );
        globalRevision = global.revision;
        const project = await app.configurationService.createSettings(
          { kind: 'project', projectId },
          {
            payload: {
              schemaVersion: SETTINGS_SCHEMA_VERSION,
              strategies: {
                modelMap: {
                  low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
                },
              },
              policies: { executionLimits: { maxConcurrentWorks: 2 } },
            },
          },
        );
        projectRevision = project.revision;
        expect(globalRevision).toBe(1);
        expect(projectRevision).toBe(1);

        // 5) 有效配置来源、脱敏导出、受权定位。
        const effective = await app.configurationService.getEffectiveSettings(projectId);
        effectiveConfigured = effective.configured;
        effectiveSourceKind = effective.strategies.modelMap.low?.source.kind ?? '';
        effectiveScopeRevision = effective.strategies.modelMap.low?.source.scopeRevision ?? 0;
        expect(effectiveConfigured).toBe(true);
        expect(effectiveSourceKind).toBe('project_default');
        expect(effectiveScopeRevision).toBe(1);
        // 项目政策段整体覆盖：仅给 maxConcurrentWorks 也随段整体替换。
        expect(effective.policies.executionLimits?.value).toEqual({ maxConcurrentWorks: 2 });

        const exported = await app.configurationService.exportSettings(projectId);
        exportedScope = exported.scope;
        exportedFormatVersion = exported.exportFormatVersion;
        expect(exportedScope).toBe('project');
        expect(exportedFormatVersion).toBe(SETTINGS_EXPORT_FORMAT_VERSION);
        expect(exported.projectId).toBe(projectId);

        const located = await app.pathService.locateProjectResource(
          { projectId },
          { type: 'project_directory', projectId },
        );
        locatedResourceType = located.resourceType;
        expect(locatedResourceType).toBe('project_directory');
        expect(located.relativePath).toBe(`projects/${projectId}`);
        expect(located.absolutePath.startsWith(app.dataRoot)).toBe(true);

        // 未知项目 not_found；跨项目归属由 path-service.test.ts 覆盖。
        await expect(
          app.pathService.locateProjectResource(
            { projectId: 'unknown-project' },
            { type: 'project_directory' },
          ),
        ).rejects.toMatchObject({ kind: 'not_found' });
      } finally {
        app.close();
        app.close(); // 幂等。
      }

      // 6) 关闭重开同一数据根后逐字段一致。
      const reopened = await openCoreApplication({ dataRoot, capabilityCatalog: createCatalog() });
      try {
        const project = await reopened.projectService.getProject(projectId);
        const settings = await reopened.configurationService.getCurrentSettings({
          kind: 'project',
          projectId,
        });
        expect(project.id).toBe(projectId);
        expect(project.revision).toBe(metadataRevision);
        expect(project.displayName).toBe('示例项目（已改名）');
        expect(settings.revision).toBe(projectRevision);
      } finally {
        reopened.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('操作说明引用的常量与实现真实一致（namespace/schemaVersion/上限/导出格式版本）', () => {
    expect(DATA_NAMESPACE).toBe('shiploop');
    expect(DATABASE_FILE_NAME).toBe('core.sqlite');
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    expect(SETTINGS_EXPORT_FORMAT_VERSION).toBe(1);
    expect(GLOBAL_SETTINGS_ID).toBe('global');
    expect(PROJECT_LIST_DEFAULT_LIMIT).toBe(50);
    expect(PROJECT_LIST_MAX_LIMIT).toBe(200);
    expect(PROJECT_DISPLAY_NAME_MAX_LENGTH).toBe(200);
    expect(DESCRIPTION_MAX_LENGTH).toBe(10_000);
    expect(LABEL_MAX_LENGTH).toBe(64);
    expect(LABELS_MAX_COUNT).toBe(50);
    expect(PROJECT_RESOURCE_TYPES).toEqual([
      'project_directory',
      'artifacts_directory',
      'staging_directory',
      'artifact_content',
    ]);

    for (const token of [
      DATA_NAMESPACE,
      DATABASE_FILE_NAME,
      `SETTINGS_SCHEMA_VERSION = ${SETTINGS_SCHEMA_VERSION}`,
      `SETTINGS_EXPORT_FORMAT_VERSION = ${SETTINGS_EXPORT_FORMAT_VERSION}`,
      `GLOBAL_SETTINGS_ID = '${GLOBAL_SETTINGS_ID}'`,
      String(PROJECT_LIST_DEFAULT_LIMIT),
      String(PROJECT_LIST_MAX_LIMIT),
      ...PROJECT_RESOURCE_TYPES,
    ]) {
      expect(operationsDoc).toContain(token);
    }
    // 默认根由注入用户目录纯推导，示例/说明不把开发机绝对路径写成运行时依赖。
    const derived = deriveDefaultDataRoot('/Users/example');
    expect(derived).toBe('/Users/example/Library/Application Support/shiploop');
    expect(operationsDoc).not.toContain('/Users/ganlu');
  });

  it('操作说明覆盖注册/重复结果、仓库范围、标签、scope/CAS、合并来源、凭据与 PathService', () => {
    for (const topic of [
      'already_exists',
      'repository_root_required',
      'bare_repository',
      'gitdir-sha256:',
      'NFC',
      'PROJECT_LIST_DEFAULT_LIMIT',
      'expectedRevision',
      'insert-only',
      'stale_dependency',
      'credentialRef',
      'endpointRef',
      'credential_in_url',
      'unsupported_isolation',
      '整体替换',
      'global_default',
      'project_default',
      'configured: false',
      'trusted_project',
      'ownership',
    ]) {
      expect(operationsDoc).toContain(topic);
    }
    // 示例经公开装配入口，不编造 CLI。
    expect(operationsDoc).toContain('shiploop-core/assembly');
    expect(operationsDoc).toContain('openCoreApplication');
    expect(operationsDoc).not.toMatch(/shiploop\s+(project|config)\s+register/);
  });

  it('交接文档指向真实可复跑闭环与失败注入入口，并交接 P02 命令/查询契约', () => {
    for (const entry of [
      'test/p01-3-fr-acceptance-closed-loop.test.ts',
      'examples/p01-3-standalone.ts',
      'scripts/core-assembly-smoke.mjs',
      'test/helpers/register-race-child.ts',
      'test/helpers/settings-race-child.ts',
      'test/helpers/cas-race-child.ts',
      'test/helpers/interrupt-publish-child.ts',
    ]) {
      expect(handoffDoc).toContain(entry);
      expect(() => readFileSync(resolve(REPO_ROOT, entry), 'utf-8')).not.toThrow();
    }
    for (const contract of [
      'registerRepository',
      'updateProjectMetadata',
      'createSettings',
      'updateSettings',
      'getEffectiveSettings',
      'exportSettings',
      'locateProjectResource',
    ]) {
      expect(handoffDoc).toContain(contract);
    }
    // 明确未交付范围，不冒充后续能力。
    for (const exclusion of [
      'Host 网络接口',
      'CLI 命令',
      'Runtime 执行',
      'Task 策略复制',
      'rebind',
      'not_run',
    ]) {
      expect(handoffDoc).toContain(exclusion);
    }
  });

  it('验收报告记录版本/命令/证据/差距，且不含凭据或开发机绝对路径', () => {
    for (const section of [
      'npm ci',
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run verify',
      'evidence-p01-3',
      'not_run',
      '结论',
    ]) {
      expect(reportDoc).toContain(section);
    }
    // 证据相对路径真实存在。
    expect(() =>
      readFileSync(resolve(REPO_ROOT, 'docs/acceptance/evidence-p01-3/00-commands.log'), 'utf-8'),
    ).not.toThrow();
    // 报告不写开发机绝对路径，不把 Harness 目录当运行时依赖。
    expect(reportDoc).not.toContain('/Users/ganlu');
    expect(reportDoc).not.toContain('apiKey:');
  });
});
