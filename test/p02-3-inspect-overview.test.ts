/**
 * F-004 P02-3 Core 静态 inspect 与注册/健康分离 overview 用例验收
 * （真实临时 SQLite + 真实 Git 仓库变体 + 真实组合根装配，非 mock；
 * 健康派生表与未注册形态用显式窄端口桩件，桩件不冒充持久实现）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md §4.3/§7.2/§7.3/§8.2 与 §15.1：
 * - projects.inspect：project.register 能力（无项目范围约束），只读返回
 *   {schemaVersion:3, canonicalPath, repoIdentity, headCommit|null,
 *   hasInitialCommit, hasUncommittedChanges, alreadyRegistered:{projectId}|null,
 *   readAt}；已绑定到不可见项目 → forbidden（不泄漏存在性）；永不执行脚本/
 *   安装/commit/stash/reset，不新建目录、不自动 git init、不猜 main；
 * - projects.overview：baseline.read 能力 + 目标可见，返回实际持久项目/绑定、
 *   registration（registered/not_registered）与 health（§8.2 派生）严格分开，
 *   当前配置是否存在及其确认信息（revision/schemaVersion）；注册成功与配置
 *   存在都不得显示为健康通过；未知/不可见项目统一 forbidden；
 * - 基线健康经窄端口 BaselineHealthReadStore 接入（F-007 迁移 v4 之前由组合根
 *   装配显式占位「尚无检查」，health=not_run/no_baseline，不冒充已检查）。
 *
 * 夹具复用 F-003 createBaselineFixture（同一沙箱内真实 Git 仓库变体）；
 * 受限主体只经 test/helpers/p02-2/principals 可信测试装配构造。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOnboardingService } from '../packages/core/src/application/onboarding-service.ts';
import type { OnboardingService } from '../packages/core/src/application/onboarding-service.ts';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { isPublicError, PublicError } from '../packages/core/src/ports/commands.ts';
import { StorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageEntityType } from '../packages/core/src/ports/errors.ts';
import type { ProjectHealthInput } from '../packages/core/src/ports/baseline.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { ProjectRecord } from '../packages/core/src/ports/state-store.ts';
import {
  createLocalOwnerPrincipal,
  createRestrictedPrincipal,
  scopeAll,
  scopeAllowlist,
} from './helpers/p02-2/principals.ts';
import { createBaselineFixture } from './helpers/p02-3/index.ts';
import type { BaselineFixture } from './helpers/p02-3/index.ts';

const OWNER = createLocalOwnerPrincipal();

function createCatalog(): RuntimeCapabilityCatalog {
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

const ANTHROPIC_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
} as const;

async function catchPublicError(fn: () => Promise<unknown>): Promise<PublicError> {
  try {
    await fn();
  } catch (error) {
    if (isPublicError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('expected PublicError to be thrown');
}

function stubNotFound(entityType: StorageEntityType, projectId: string): StorageError {
  return new StorageError('not_found', 'stub', 'stub: 实体不存在', {
    entity: { type: entityType, projectId },
  });
}

function stubProjectRecord(projectId: string): ProjectRecord {
  return {
    id: projectId,
    displayName: '桩件项目',
    description: null,
    status: 'active',
    labels: [],
    repositoryBindingId: null,
    revision: 1,
    createdAtUtcMs: 1_700_000_000_000,
    updatedAtUtcMs: 1_700_000_000_000,
  };
}

interface ServiceStubs {
  readonly healthInput?: ProjectHealthInput;
  readonly projectRecord?: ProjectRecord;
}

/** 直接装配 OnboardingService（窄端口显式桩件；不冒充持久实现）。 */
function createStubbedService(stubs: ServiceStubs = {}): OnboardingService {
  const projectRecord = stubs.projectRecord ?? stubProjectRecord(randomUUID());
  const healthInput: ProjectHealthInput = stubs.healthInput ?? { operation: null, checks: [] };
  return createOnboardingService({
    repositoryInspector: {
      inspect: () => Promise.reject(new Error('本用例不应触发仓库检查')),
    },
    stateStore: {
      getProject: () => Promise.resolve(projectRecord),
      getRepositoryBinding: () =>
        Promise.reject(stubNotFound('repository_binding', projectRecord.id)),
    },
    configurationService: {
      getCurrentSettings: () =>
        Promise.reject(stubNotFound('project_settings', projectRecord.id)),
    },
    bindingReads: { findBindingByCanonicalPath: () => null },
    baselineReads: { readProjectHealthInput: () => healthInput },
  });
}

function terminalOperation(
  status: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'not_run',
  reasonCode?: 'stop_unconfirmed' | 'authorization_rejected' | 'empty_check_set',
): NonNullable<ProjectHealthInput['operation']> {
  return {
    operationId: randomUUID(),
    kind: 'baseline',
    status,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    createdAt: '2026-10-04T00:00:00.000Z',
    startedAt: '2026-10-04T00:00:01.000Z',
    endedAt: '2026-10-04T00:00:02.000Z',
  };
}

describe('F-004 P02-3 静态 inspect 与 overview 用例', () => {
  let fixture: BaselineFixture;
  const openApps: CoreApplication[] = [];

  beforeAll(() => {
    fixture = createBaselineFixture({ prefix: 'shiploop-p02-3-f004-' });
  });

  afterEach(() => {
    while (openApps.length > 0) {
      openApps.pop()?.close();
    }
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  async function openApp(name: string): Promise<CoreApplication> {
    const app = await openCoreApplication({
      dataRoot: fixture.dataRoot(name),
      capabilityCatalog: createCatalog(),
    });
    openApps.push(app);
    return app;
  }

  /* ---------------------------------------------------------------- *
   * projects.inspect（注册前只读静态检查）
   * ---------------------------------------------------------------- */

  describe('projects.inspect（注册前只读静态检查）', () => {
    it('干净有 HEAD 仓库：规范路径/实际 HEAD/初始 commit/未脏/未注册，schemaVersion=3', async () => {
      const app = await openApp('inspect-happy');
      const result = await app.onboardingService.inspectRepository(OWNER, fixture.repos.withHead);
      expect(result.schemaVersion).toBe(3);
      expect(result.canonicalPath).toBe(realpathSync(fixture.repos.withHead));
      expect(result.headCommit).toBe(fixture.repos.headOf('withHead'));
      expect(result.hasInitialCommit).toBe(true);
      expect(result.hasUncommittedChanges).toBe(false);
      expect(result.repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);
      expect(result.alreadyRegistered).toBeNull();
      expect(Number.isNaN(Date.parse(result.readAt))).toBe(false);
    });

    it('无初始 commit：headCommit=null 且不猜 main、不创建 commit', async () => {
      const app = await openApp('inspect-no-head');
      const result = await app.onboardingService.inspectRepository(
        OWNER,
        fixture.repos.noInitialCommit,
      );
      expect(result.headCommit).toBeNull();
      expect(result.hasInitialCommit).toBe(false);
      expect(result.hasUncommittedChanges).toBe(false);
      // inspect 之后仍然无 HEAD（未自动 commit、未猜 main 分支）。
      expect(fixture.repos.headOf('noInitialCommit')).toBeNull();
    });

    it('脏工作区原样保留：hasUncommittedChanges=true，已跟踪/未跟踪文件字节不变', async () => {
      const trackedBefore = readFileSync(fixture.repos.dirtyTrackedFile);
      const untrackedBefore = readFileSync(fixture.repos.dirtyUntrackedFile);
      const app = await openApp('inspect-dirty');
      const result = await app.onboardingService.inspectRepository(OWNER, fixture.repos.dirty);
      expect(result.hasInitialCommit).toBe(true);
      expect(result.hasUncommittedChanges).toBe(true);
      expect(result.headCommit).toBe(fixture.repos.headOf('dirty'));
      expect(readFileSync(fixture.repos.dirtyTrackedFile)).toEqual(trackedBefore);
      expect(readFileSync(fixture.repos.dirtyUntrackedFile)).toEqual(untrackedBefore);
    });

    it('恶意初始化脚本绝不执行：哨兵文件不存在', async () => {
      const app = await openApp('inspect-malicious');
      const result = await app.onboardingService.inspectRepository(OWNER, fixture.repos.malicious);
      expect(result.hasInitialCommit).toBe(true);
      expect(existsSync(fixture.repos.maliciousSentinelPath)).toBe(false);
    });

    it('同路径符号链接别名复用同一规范路径与仓库身份', async () => {
      const app = await openApp('inspect-alias');
      const direct = await app.onboardingService.inspectRepository(OWNER, fixture.repos.withHead);
      const viaAlias = await app.onboardingService.inspectRepository(OWNER, fixture.repos.alias);
      expect(viaAlias.canonicalPath).toBe(direct.canonicalPath);
      expect(viaAlias.repoIdentity).toBe(direct.repoIdentity);
      expect(viaAlias.headCommit).toBe(direct.headCommit);
    });

    it('已注册可见项目：inspect 与别名路径都返回 alreadyRegistered.projectId', async () => {
      const app = await openApp('inspect-registered');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.withHead,
        displayName: '已注册仓库',
      });
      const direct = await app.onboardingService.inspectRepository(OWNER, fixture.repos.withHead);
      expect(direct.alreadyRegistered).toEqual({ projectId: registration.project.id });
      const viaAlias = await app.onboardingService.inspectRepository(OWNER, fixture.repos.alias);
      expect(viaAlias.alreadyRegistered).toEqual({ projectId: registration.project.id });
    });

    it('同 remote 不同 clone 不合并身份：repoIdentity 不同且可分别注册', async () => {
      const app = await openApp('inspect-clones');
      expect(fixture.repos.remoteOf('cloneA')).toBe(fixture.repos.remoteOf('cloneB'));
      const inspectA = await app.onboardingService.inspectRepository(OWNER, fixture.repos.cloneA);
      const inspectB = await app.onboardingService.inspectRepository(OWNER, fixture.repos.cloneB);
      expect(inspectA.repoIdentity).not.toBe(inspectB.repoIdentity);
      expect(inspectA.canonicalPath).not.toBe(inspectB.canonicalPath);
      const registrationA = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.cloneA,
        displayName: '克隆 A',
      });
      const registrationB = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.cloneB,
        displayName: '克隆 B',
      });
      expect(registrationA.project.id).not.toBe(registrationB.project.id);
    });

    it('已绑定到不可见项目 → forbidden，不回显项目身份', async () => {
      const app = await openApp('inspect-invisible');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.withHead,
        displayName: '受限可见性',
      });
      const outsider = createRestrictedPrincipal({
        capabilities: ['project.register'],
        projectScope: scopeAllowlist([randomUUID()]),
      });
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(outsider, fixture.repos.withHead),
      );
      expect(error.code).toBe('forbidden');
      expect(error.details?.reason).toBe('project_not_visible');
      expect(JSON.stringify(error.details ?? {})).not.toContain(registration.project.id);
    });

    it('缺 project.register 能力 → forbidden，且在任何 Git/文件 I/O 之前拒绝', async () => {
      let inspectCalls = 0;
      const realInspector = createRepositoryInspector();
      const spyInspector = {
        inspect: (path: unknown) => {
          inspectCalls += 1;
          return realInspector.inspect(path);
        },
      };
      const app = await openCoreApplication({
        dataRoot: fixture.dataRoot('inspect-capability'),
        capabilityCatalog: createCatalog(),
        repositoryInspector: spyInspector,
      });
      openApps.push(app);
      const withoutRegister = createRestrictedPrincipal({
        capabilities: ['project.read'],
        projectScope: scopeAll(),
      });
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(withoutRegister, fixture.repos.withHead),
      );
      expect(error.code).toBe('forbidden');
      expect(error.details?.reason).toBe('capability_denied');
      expect(inspectCalls).toBe(0);
    });

    it('非法路径输入 → invalid_input（相对/空/非字符串/NUL/对象）', async () => {
      const app = await openApp('inspect-invalid-input');
      const invalidInputs: unknown[] = [
        'relative/path',
        '',
        123,
        null,
        '/tmp/含\0 NUL',
        { path: fixture.repos.withHead },
      ];
      for (const bad of invalidInputs) {
        const error = await catchPublicError(() =>
          app.onboardingService.inspectRepository(OWNER, bad),
        );
        expect(error.code).toBe('invalid_input');
      }
    });

    it('不存在路径 → invalid_input(repository_path_not_found)，且不新建目录', async () => {
      const app = await openApp('inspect-missing');
      const missing = join(fixture.root, 'repos', '不存在的仓库');
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(OWNER, missing),
      );
      expect(error.code).toBe('invalid_input');
      expect(error.details?.reason).toBe('repository_path_not_found');
      expect(existsSync(missing)).toBe(false);
    });

    it('普通文件 → invalid_input(repository_not_a_directory)', async () => {
      const app = await openApp('inspect-file');
      const plainFile = join(fixture.root, 'plain-file.txt');
      writeFileSync(plainFile, 'not a directory\n', 'utf-8');
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(OWNER, plainFile),
      );
      expect(error.code).toBe('invalid_input');
      expect(error.details?.reason).toBe('repository_not_a_directory');
    });

    it('非 Git 目录 → invalid_input(repository_not_a_repository)，不自动 git init', async () => {
      const app = await openApp('inspect-non-git');
      const plainDir = join(fixture.root, 'plain-dir');
      mkdirSync(plainDir, { recursive: true });
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(OWNER, plainDir),
      );
      expect(error.code).toBe('invalid_input');
      expect(error.details?.reason).toBe('repository_not_a_repository');
      expect(existsSync(join(plainDir, '.git'))).toBe(false);
    });

    it('仓库子目录 → invalid_input(repository_not_a_repository)，不误绑外层仓库', async () => {
      const app = await openApp('inspect-subdir');
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(OWNER, join(fixture.repos.withHead, 'src')),
      );
      expect(error.code).toBe('invalid_input');
      expect(error.details?.reason).toBe('repository_not_a_repository');
    });

    it('裸仓库 → invalid_input(repository_not_a_repository)', async () => {
      const app = await openApp('inspect-bare');
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(OWNER, fixture.repos.origin),
      );
      expect(error.code).toBe('invalid_input');
      expect(error.details?.reason).toBe('repository_not_a_repository');
    });

    it('拒绝结果结构化且不回显路径原文', async () => {
      const app = await openApp('inspect-redaction');
      const error = await catchPublicError(() =>
        app.onboardingService.inspectRepository(OWNER, join(fixture.repos.withHead, 'src')),
      );
      expect(error.operation).toBe('projects.inspect');
      const serialized = JSON.stringify(error.details ?? {});
      expect(serialized).not.toContain(fixture.repos.withHead);
      expect(serialized).not.toContain(fixture.root);
    });
  });

  /* ---------------------------------------------------------------- *
   * projects.overview（注册状态与健康状态严格分开）
   * ---------------------------------------------------------------- */

  describe('projects.overview（注册状态与健康状态严格分开）', () => {
    it('已注册项目：registration=registered，但尚无检查 → health=not_run/no_baseline', async () => {
      const app = await openApp('overview-registered');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.withHead,
        displayName: '概览项目',
        labels: ['web'],
      });
      const overview = await app.onboardingService.getProjectOverview(
        OWNER,
        registration.project.id,
      );
      expect(overview.schemaVersion).toBe(3);
      expect(overview.project.id).toBe(registration.project.id);
      expect(overview.project.displayName).toBe('概览项目');
      expect(overview.binding?.canonicalPath).toBe(realpathSync(fixture.repos.withHead));
      expect(overview.binding?.repoIdentity).toBe(registration.binding.repoIdentity);
      expect(overview.registration).toEqual({ status: 'registered' });
      expect(overview.settings).toEqual({ configured: false });
      // 注册成功不得显示为健康通过。
      expect(overview.health).toEqual({
        status: 'not_run',
        lastBaselineOperationId: null,
        lastCompletedAt: null,
        reasonCode: 'no_baseline',
      });
      expect(Number.isNaN(Date.parse(overview.readAt))).toBe(false);
    });

    it('配置存在及其确认信息（revision/schemaVersion）返回，但配置存在不等于健康通过', async () => {
      const app = await openApp('overview-configured');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.withHead,
        displayName: '已配置项目',
      });
      await app.configurationService.createSettings(
        { kind: 'project', projectId: registration.project.id },
        { payload: ANTHROPIC_PAYLOAD },
      );
      const overview = await app.onboardingService.getProjectOverview(
        OWNER,
        registration.project.id,
      );
      expect(overview.settings).toEqual({ configured: true, revision: 1, schemaVersion: 2 });
      expect(overview.registration.status).toBe('registered');
      expect(overview.health.status).toBe('not_run');
      expect(overview.health.reasonCode).toBe('no_baseline');
    });

    it('无绑定项目：registration=not_registered、binding=null，健康仍为 not_run', async () => {
      const projectId = randomUUID();
      const service = createStubbedService({ projectRecord: stubProjectRecord(projectId) });
      const overview = await service.getProjectOverview(OWNER, projectId);
      expect(overview.project.id).toBe(projectId);
      expect(overview.binding).toBeNull();
      expect(overview.registration).toEqual({ status: 'not_registered' });
      expect(overview.settings).toEqual({ configured: false });
      expect(overview.health).toEqual({
        status: 'not_run',
        lastBaselineOperationId: null,
        lastCompletedAt: null,
        reasonCode: 'no_baseline',
      });
    });

    it.each([
      {
        name: '全部必需检查 passed → healthy',
        input: {
          operation: terminalOperation('completed'),
          checks: [
            { status: 'passed', required: true },
            { status: 'failed', required: false },
          ],
        } as ProjectHealthInput,
        expected: { status: 'healthy', reasonCode: undefined },
      },
      {
        name: '必需检查 failed → unhealthy',
        input: {
          operation: terminalOperation('completed'),
          checks: [{ status: 'failed', required: true }],
        } as ProjectHealthInput,
        expected: { status: 'unhealthy' },
      },
      {
        name: '必需检查 not_run 不得折算通过 → unhealthy',
        input: {
          operation: terminalOperation('completed'),
          checks: [{ status: 'not_run', required: true, reasonCode: 'authorization_rejected' }],
        } as ProjectHealthInput,
        expected: { status: 'unhealthy', reasonCode: 'authorization_rejected' },
      },
      {
        name: '操作 failed + stop_unconfirmed → unhealthy 且保留 reason',
        input: {
          operation: terminalOperation('failed', 'stop_unconfirmed'),
          checks: [],
        } as ProjectHealthInput,
        expected: { status: 'unhealthy', reasonCode: 'stop_unconfirmed' },
      },
      {
        name: '操作 not_run → not_run（不折算通过）',
        input: {
          operation: terminalOperation('not_run', 'empty_check_set'),
          checks: [],
        } as ProjectHealthInput,
        expected: { status: 'not_run', reasonCode: 'empty_check_set' },
      },
      {
        name: '尚无终态操作 → not_run/no_baseline',
        input: { operation: null, checks: [] } as ProjectHealthInput,
        expected: { status: 'not_run', reasonCode: 'no_baseline' },
      },
    ])('健康经窄端口派生：$name', async ({ input, expected }) => {
      const projectId = randomUUID();
      const service = createStubbedService({
        projectRecord: stubProjectRecord(projectId),
        healthInput: input,
      });
      const overview = await service.getProjectOverview(OWNER, projectId);
      expect(overview.health.status).toBe(expected.status);
      expect(overview.health.reasonCode).toBe(expected.reasonCode);
      if (input.operation !== null) {
        expect(overview.health.lastBaselineOperationId).toBe(input.operation.operationId);
        expect(overview.health.lastCompletedAt).toBe(input.operation.endedAt);
      } else {
        expect(overview.health.lastBaselineOperationId).toBeNull();
        expect(overview.health.lastCompletedAt).toBeNull();
      }
    });

    it('缺 baseline.read 能力 → forbidden（capability_denied）', async () => {
      const app = await openApp('overview-capability');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.withHead,
        displayName: '能力边界',
      });
      const withoutBaselineRead = createRestrictedPrincipal({
        capabilities: ['project.read'],
        projectScope: scopeAll(),
      });
      const error = await catchPublicError(() =>
        app.onboardingService.getProjectOverview(withoutBaselineRead, registration.project.id),
      );
      expect(error.code).toBe('forbidden');
      expect(error.details?.reason).toBe('capability_denied');
    });

    it('可见范围外项目 → forbidden（与不存在不可区分，不回显项目身份）', async () => {
      const app = await openApp('overview-invisible');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.withHead,
        displayName: '不可见项目',
      });
      const outsider = createRestrictedPrincipal({
        capabilities: ['baseline.read'],
        projectScope: scopeAllowlist([randomUUID()]),
      });
      const error = await catchPublicError(() =>
        app.onboardingService.getProjectOverview(outsider, registration.project.id),
      );
      expect(error.code).toBe('forbidden');
      expect(error.details?.reason).toBe('project_not_visible');
      expect(JSON.stringify(error.details ?? {})).not.toContain(registration.project.id);
    });

    it('未知 projectId → forbidden（折算为与不可见相同，不区分存在性）', async () => {
      const app = await openApp('overview-unknown');
      const error = await catchPublicError(() =>
        app.onboardingService.getProjectOverview(OWNER, randomUUID()),
      );
      expect(error.code).toBe('forbidden');
      expect(error.details?.reason).toBe('project_not_visible');
    });

    it('非法 projectId → invalid_input', async () => {
      const app = await openApp('overview-invalid-id');
      for (const bad of ['含空格 id', '', 42, null, 'a'.repeat(200)]) {
        const error = await catchPublicError(() =>
          app.onboardingService.getProjectOverview(OWNER, bad),
        );
        expect(error.code).toBe('invalid_input');
      }
    });

    it('组合根装配的 onboardingService 经真实 SQLite 窄端口接入（占位健康读 = 尚无检查）', async () => {
      const app = await openApp('overview-composed');
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repos.cloneA,
        displayName: '组合根冒烟',
      });
      const overview = await app.onboardingService.getProjectOverview(
        OWNER,
        registration.project.id,
      );
      expect(overview.schemaVersion).toBe(3);
      expect(overview.project.id).toBe(registration.project.id);
      expect(overview.registration.status).toBe('registered');
      expect(overview.health.status).toBe('not_run');
      expect(overview.health.reasonCode).toBe('no_baseline');
    });
  });
});
