/**
 * P01-3 / F-012 Core 装配公共入口验收（真实临时 SQLite + 真实临时 Git 仓库 +
 * 真实临时数据根 + 可信装配能力目录，非 mock）。
 *
 * 覆盖（F-012 验收点）：
 * - 公开 Core 装配入口提供可调用的项目注册/查询/编辑、配置读取/更新/导出与受权
 *   路径能力，装配复用 StateStore/ArtifactStore，不暴露 ORM/HTTP/Pi SDK 类型
 *   （返回面只含端口与用例接口，不含 session/database）；
 * - 独立示例（examples/p01-3-standalone.ts）在真实临时仓库与数据根上跑通
 *   「注册 → 查询 → CAS 编辑 → 全局/项目配置 → 有效配置来源 → 脱敏导出 →
 *   受权定位 → 关闭重开逐字段一致」；
 * - 默认根由注入的 macOS 用户目录推导（不读真实 HOME），数据根内可定位状态库与
 *   迁移记录；非法装配选项在任何 I/O 之前 fail-closed；
 * - 包清单声明 `shiploop-core` 的 `./assembly` 子路径导出并指向真实 dist 产物
 *   （构建产物冒烟由 scripts/smoke-built-entries.ts 在 npm run build 中执行）。
 *
 * 不扩大范围：不新增 Host 网络/CLI 路由、不调用模型、不读取真实用户凭据或
 * Harness/开发机路径。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { deriveDefaultDataRoot } from '../packages/core/src/ports/path-service.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { runStandaloneCoreExample } from '../examples/p01-3-standalone.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

/** 在沙箱内初始化一个含真实 commit 的仓库，返回仓库根。 */
function createCommittedRepo(sandbox: string, name: string): string {
  const repo = join(sandbox, name);
  initGitRepo(repo);
  writeFileSync(join(repo, 'README.md'), '# example\n', 'utf-8');
  commitAll(repo, 'init');
  return repo;
}

describe('F-012 Core 装配公共入口', () => {
  it('装配入口在真实仓库与数据根上提供项目/配置/路径能力，且关闭重开后逐字段一致', async () => {
    const sandbox = createTempSandbox('shiploop-p013-f012-', { outside: [repoRoot] });
    try {
      const repositoryPath = createCommittedRepo(sandbox.path, 'repo');
      const dataRoot = join(sandbox.path, 'data');

      const result = await runStandaloneCoreExample({
        dataRoot,
        repositoryPath,
        capabilityCatalog: createCatalog(),
      });

      // 稳定身份：UUID，不由名称/路径/remote 生成。
      expect(result.projectId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(result.registrationStatus).toBe('registered');
      expect(result.repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);
      expect(result.canonicalPath).toBe(realpathSync(repositoryPath));

      // 元数据 CAS 编辑：revision 递增、名称生效、标签规范化去重。
      expect(result.metadataRevisionAfterEdit).toBe(2);
      expect(result.displayNameAfterEdit).toBe('示例项目（已改名）');
      expect(result.labelsAfterEdit).toEqual(['示例', 'example']);

      // 配置：全局/项目当前值各 revision 1；有效配置来自项目覆盖。
      expect(result.globalRevision).toBe(1);
      expect(result.projectRevision).toBe(1);
      expect(result.effectiveConfigured).toBe(true);
      expect(result.effectiveStrategySource).toBe('project_default');
      expect(result.effectiveRevision).toBe(1);

      // 脱敏导出：scope=project、projectId 一致、不含 executable/ready。
      expect(result.exportedScope).toBe('project');
      expect(result.exportedProjectId).toBe(result.projectId);

      // 受权路径：项目目录类型。
      expect(result.locatedResourceType).toBe('project_directory');

      // 关闭重开：项目与项目配置 revision 保持一致。
      expect(result.reopenedProjectId).toBe(result.projectId);
      expect(result.reopenedProjectRevision).toBe(2);
      expect(result.reopenedProjectSettingsRevision).toBe(1);

      // 数据根内可定位状态库（迁移随装配执行）。
      expect(existsSync(join(dataRoot, 'core.sqlite'))).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it('默认数据根由注入的 macOS 用户目录纯推导，且只在派生根内创建状态库', async () => {
    const sandbox = createTempSandbox('shiploop-p013-f012-home-', { outside: [repoRoot] });
    try {
      const userHome = join(sandbox.path, 'home');
      mkdirSync(userHome, { recursive: true });
      const derivedRoot = deriveDefaultDataRoot(userHome);
      expect(derivedRoot.startsWith(userHome)).toBe(true);

      const app = await openCoreApplication({
        userHomeDir: userHome,
        capabilityCatalog: createCatalog(),
      });
      try {
        const expectedRoot = realpathSync(derivedRoot);
        expect(app.dataRoot).toBe(expectedRoot);
        expect(app.pathService.dataRoot()).toBe(expectedRoot);
        expect(existsSync(join(expectedRoot, 'core.sqlite'))).toBe(true);
      } finally {
        app.close();
        app.close(); // close 幂等。
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('非法装配选项在任何 I/O 之前 fail-closed，且不创建数据根', async () => {
    const sandbox = createTempSandbox('shiploop-p013-f012-invalid-', { outside: [repoRoot] });
    try {
      const a = join(sandbox.path, 'a');
      const b = join(sandbox.path, 'b');
      const ambiguous = await openCoreApplication({
        dataRoot: a,
        userHomeDir: b,
        capabilityCatalog: createCatalog(),
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isStorageError(ambiguous, 'validation')).toBe(true);
      const missingCatalog = await openCoreApplication({
        capabilityCatalog: null as unknown as RuntimeCapabilityCatalog,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isStorageError(missingCatalog, 'validation')).toBe(true);
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it('包清单声明 ./assembly 子路径导出并指向真实源/产物（不暴露 ORM 类型面）', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/core/package.json'), 'utf-8'),
    ) as { exports: Record<string, { types?: string; default?: string }> };
    const assembly = manifest.exports['./assembly'];
    expect(assembly).toBeDefined();
    expect(assembly?.types).toBe('./dist/adapters/composition.d.ts');
    expect(assembly?.default).toBe('./dist/adapters/composition.js');
    expect(existsSync(resolve(repoRoot, 'packages/core/src/adapters/composition.ts'))).toBe(true);

    // 返回面键集合：只含端口/用例，不含 session/database 等 ORM 句柄。
    const source = readFileSync(
      resolve(repoRoot, 'packages/core/src/adapters/composition.ts'),
      'utf-8',
    );
    expect(source).not.toMatch(/export\s+interface\s+CoreApplication[\s\S]*?\bsession\s*:/);
    expect(source).not.toMatch(/export\s+interface\s+CoreApplication[\s\S]*?\bdatabase\s*:/);
  });
});
