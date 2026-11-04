/**
 * P08-1 / F-001 分发元数据与兼容声明冻结验收（纯本地清单/契约检查）。
 *
 * 覆盖（F-001 验收点，全部为真实文件/常量断言，非 mock）：
 * - 根与三个工作区 package.json 的名称、统一版本、私有性、engines（Node/npm
 *   固定版本）与 os（macOS）冻结一致；root packageManager/workspaces 一致；
 * - 工作区依赖链 host→core、cli→host 与 package-lock.json 的名称/版本/引擎/
 *   link 关系一致，无 file:/link:/绝对路径依赖；
 * - exports/main/types 的 dist 入口与 CLI bin 约定映射到真实 src 源文件
 *   （bin 源入口带 node shebang；真实 dist 加载冒烟由 npm run build 的
 *   smoke-built-entries 执行，不在本文件宣称）；
 * - distribution-compatibility.json 声明的平台、工具链、Host 协议范围
 *   （wire schema/协议版本/发现 schema/旧客户端握手范围）与数据库 Schema
 *   读写范围与代码常量一致；未知/高版本策略为 reject，不静默降级；
 * - 握手版本门禁真实拒绝未知 schema/协议版本（纯契约函数，无网络）；
 * - 清单/声明/锁不含开发机绝对路径、凭据样式内容或 Nezha 运行时依赖；
 * - 许可证、npm scope、正式包名、公开发布身份保持待负责人确认的发布阻塞；
 *   本阶段仅 local pack，真实安装/原生模块/Host 启动等登记为 Phase 集成
 *   not_run，不在本 Task 宣称通过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { HostProtocolError } from '../../../packages/host/src/contract/errors.ts';
import {
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  DISCOVERY_SCHEMA_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../../packages/host/src/contract/constants.ts';
import { validateHandshakeRequest } from '../../../packages/host/src/contract/handshake.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** P01 起冻结的工具链与平台支持矩阵（docs/p08-packaging.md FR-1 / 兼容性）。 */
const FROZEN_NODE = '22.19.0';
const FROZEN_NPM = '10.9.3';
const SUPPORTED_ENGINES = { node: '^22.19.0 || ^24.14.1 || ^26.7.0', npm: '>=10.9.3 <12' };
const FROZEN_OS = ['darwin'];
const UNIFIED_VERSION = '0.0.0';

const MANIFEST_PATHS = [
  'package.json',
  'packages/core/package.json',
  'packages/host/package.json',
  'packages/cli/package.json',
] as const;

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8')) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf-8');
}

const rootManifest = readJson('package.json');
const coreManifest = readJson('packages/core/package.json');
const hostManifest = readJson('packages/host/package.json');
const cliManifest = readJson('packages/cli/package.json');
const lock = readJson('package-lock.json');
const compatibility = readJson('distribution-compatibility.json');
const manifestsByName: Record<string, Record<string, unknown>> = {
  shiploop: rootManifest,
  'shiploop-core': coreManifest,
  'shiploop-host': hostManifest,
  'shiploop-cli': cliManifest,
};

const DEPENDENCY_KINDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
] as const;

function dependencyEntries(manifest: Record<string, unknown>): [string, string][] {
  const entries: [string, string][] = [];
  for (const kind of DEPENDENCY_KINDS) {
    const deps = manifest[kind];
    if (deps && typeof deps === 'object') {
      for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof version === 'string') {
          entries.push([name, version]);
        }
      }
    }
  }
  return entries;
}

/** 递归收集 JSON 键名（凭据样式键检测用）。 */
function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, into));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.push(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** 把 ./dist/** 的产物路径映射回对应 src 源文件（.js/.d.ts → .ts）。 */
function distPathToSource(distPath: string): string | null {
  if (!distPath.startsWith('./dist/')) {
    return null;
  }
  const relative = distPath.slice('./dist/'.length).replace(/\.(d\.ts|js)$/, '.ts');
  return `src/${relative}`;
}

function expectDistEntryResolves(packageDir: string, distPath: string): void {
  expect(typeof distPath).toBe('string');
  const sourcePath = distPathToSource(distPath);
  expect(sourcePath, `${packageDir} 的 ${distPath} 必须位于 ./dist/ 下`).not.toBeNull();
  expect(
    existsSync(resolve(repoRoot, packageDir, sourcePath as string)),
    `${packageDir} 的 ${distPath} 缺少对应源文件 ${sourcePath}`,
  ).toBe(true);
}

describe('P08-1 / F-001 分发元数据与兼容声明', () => {
  describe('清单身份、引擎与平台冻结', () => {
    it('四个 package.json 名称/版本/私有性统一，engines 冻结 Node/npm 固定版本，os 仅 darwin', () => {
      const expectedNames = ['shiploop', 'shiploop-core', 'shiploop-host', 'shiploop-cli'];
      expect(Object.values(manifestsByName).map((manifest) => manifest['name'])).toEqual(expectedNames);
      for (const manifest of Object.values(manifestsByName)) {
        expect(manifest['version']).toBe(UNIFIED_VERSION);
        expect(manifest['private']).toBe(true);
        expect(manifest['type']).toBe('module');
        expect(manifest['engines']).toEqual(SUPPORTED_ENGINES);
        expect(manifest['os']).toEqual(FROZEN_OS);
        // 公开发布身份未定：不擅自声明 license 或发布配置。
        expect(manifest['license']).toBeUndefined();
        expect(manifest['publishConfig']).toBeUndefined();
      }
    });

    it('根 packageManager 与 engines.npm 一致；workspaces 恰为三个包目录', () => {
      expect(rootManifest['packageManager']).toBe(`npm@${FROZEN_NPM}`);
      expect(rootManifest['workspaces']).toEqual(['packages/core', 'packages/host', 'packages/cli']);
    });
  });

  describe('工作区依赖与 package-lock 一致性', () => {
    it('依赖链 host→core、cli→host 使用统一版本，且无 file:/link:/URL 协议依赖', () => {
      const hostDeps = hostManifest['dependencies'] as Record<string, string>;
      const cliDeps = cliManifest['dependencies'] as Record<string, string>;
      expect(hostDeps['shiploop-core']).toBe(UNIFIED_VERSION);
      expect(cliDeps['shiploop-host']).toBe(UNIFIED_VERSION);
      // CLI 只经 host 使用 Core，不绕过分层直接依赖 core。
      expect(Object.keys(cliDeps).filter((name) => name.startsWith('shiploop'))).toEqual(['shiploop-host']);

      for (const manifest of Object.values(manifestsByName)) {
        for (const [name, version] of dependencyEntries(manifest)) {
          expect(
            version.startsWith('file:') || version.startsWith('link:') || version.includes('://'),
            `${name} 的依赖 ${name}@${version} 不得使用 file:/link:/URL 协议`,
          ).toBe(false);
        }
      }
    });

    it('lock 记录一致的工作区身份、引擎、平台与 link 关系（lockfileVersion 3）', () => {
      expect(lock['lockfileVersion']).toBe(3);
      expect(lock['name']).toBe('shiploop');
      expect(lock['version']).toBe(UNIFIED_VERSION);
      const lockPackages = lock['packages'] as Record<string, Record<string, unknown>>;
      for (const [packageDir, manifest] of [
        ['', rootManifest],
        ['packages/core', coreManifest],
        ['packages/host', hostManifest],
        ['packages/cli', cliManifest],
      ] as const) {
        const entry = lockPackages[packageDir] as Record<string, unknown> | undefined;
        expect(entry, `lock 缺少 ${packageDir || '根'} 条目`).toBeDefined();
        expect(entry!['name']).toBe(manifest['name']);
        expect(entry!['version']).toBe(UNIFIED_VERSION);
        expect(entry!['engines']).toEqual(SUPPORTED_ENGINES);
        expect(entry!['os']).toEqual(FROZEN_OS);
      }
      for (const [linkName, resolvedDir] of [
        ['node_modules/shiploop-core', 'packages/core'],
        ['node_modules/shiploop-host', 'packages/host'],
        ['node_modules/shiploop-cli', 'packages/cli'],
      ] as const) {
        expect(lockPackages[linkName]).toMatchObject({ resolved: resolvedDir, link: true });
      }
      const hostEntry = lockPackages['packages/host']!;
      expect((hostEntry['dependencies'] as Record<string, string>)['shiploop-core']).toBe(UNIFIED_VERSION);
    });

    it('Host 的 Pi SDK 运行依赖与根 devDependencies/overrides 锁定同版本', () => {
      const hostDeps = hostManifest['dependencies'] as Record<string, string>;
      const rootDevDeps = rootManifest['devDependencies'] as Record<string, string>;
      const overrides = rootManifest['overrides'] as Record<string, string>;
      const sdkNames = Object.keys(hostDeps).filter((name) => name.startsWith('@earendil-works/'));
      expect(sdkNames.length).toBeGreaterThan(0);
      for (const name of sdkNames) {
        // 运行依赖必须精确锁定；根 devDependencies/overrides 中同名条目（如有）不得漂移。
        expect(hostDeps[name]).toMatch(/^\d+\.\d+\.\d+$/);
        const overrideVersion = overrides[name];
        if (overrideVersion !== undefined) {
          expect(overrideVersion).toBe(hostDeps[name]);
        }
        const rootDevVersion = rootDevDeps[name];
        if (rootDevVersion !== undefined) {
          expect(rootDevVersion).toBe(hostDeps[name]);
        }
      }
    });
  });

  describe('dist 入口与 CLI bin 约定可解析', () => {
    it('exports/main/types 全部指向 ./dist/ 且映射到真实 src 源文件；files 只含 dist', () => {
      for (const [packageDir, manifest] of [
        ['packages/core', coreManifest],
        ['packages/host', hostManifest],
        ['packages/cli', cliManifest],
      ] as const) {
        expect(manifest['files']).toEqual(['dist']);
        const exportsMap = manifest['exports'];
        if (exportsMap && typeof exportsMap === 'object') {
          for (const [subpath, entry] of Object.entries(exportsMap as Record<string, unknown>)) {
            const targets =
              typeof entry === 'string' ? [entry] : Object.values(entry as Record<string, unknown>);
            for (const target of targets) {
              if (typeof target === 'string' && subpath !== './package.json') {
                expectDistEntryResolves(packageDir, target);
              }
            }
          }
        }
        for (const field of ['main', 'types'] as const) {
          const value = manifest[field];
          if (typeof value === 'string') {
            expectDistEntryResolves(packageDir, value);
          }
        }
      }
    });

    it('CLI bin 约定为 shiploop → ./dist/bin.js，源入口带 node shebang', () => {
      expect(cliManifest['bin']).toEqual({ shiploop: './dist/bin.js' });
      expectDistEntryResolves('packages/cli', './dist/bin.js');
      const binSource = readText('packages/cli/src/bin.ts');
      expect(binSource.startsWith('#!/usr/bin/env node')).toBe(true);
    });
  });

  describe('兼容声明与代码常量一致（不静默降级）', () => {
    it('分发模式/平台/工具链与协议范围声明与 Host 契约常量一致', () => {
      expect(compatibility['schemaVersion']).toBe(1);
      expect(compatibility['distributionMode']).toBe('local-pack-only');
      expect(compatibility['published']).toBe(false);
      expect(compatibility['unifiedVersion']).toBe(UNIFIED_VERSION);
      expect(compatibility['platforms']).toEqual(FROZEN_OS);
      expect(compatibility['toolchain']).toEqual({ node: FROZEN_NODE, npm: FROZEN_NPM });

      const hostProtocol = compatibility['hostProtocol'] as Record<string, unknown>;
      expect(hostProtocol['wireProtocolVersions']).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
      expect(hostProtocol['wireSchemaVersion']).toBe(CURRENT_SCHEMA_VERSION);
      expect(hostProtocol['legacyHandshakeSchemaVersionsAccepted']).toEqual([CURRENT_SCHEMA_VERSION - 1]);
      expect(hostProtocol['discoverySchemaVersions']).toEqual([DISCOVERY_SCHEMA_VERSION]);
      expect(hostProtocol['unknownVersionPolicy']).toBe('reject');
    });

    it('数据库 Schema 读写范围声明与迁移常量一致且版本连续', () => {
      // 迁移必须从 1 开始连续编号；migrator 以 migrations.length 为支持上限，
      // 高于上限的库明确拒写（test/modules/storage/sqlite/sqlite-migration-runner.test.ts）。
      SQLITE_MIGRATIONS.forEach((migration, index) => {
        expect(migration.version).toBe(index + 1);
      });
      const databaseSchema = compatibility['databaseSchema'] as Record<string, unknown>;
      expect(databaseSchema['engine']).toBe('sqlite');
      expect(databaseSchema['readableAppliedVersions']).toEqual({
        min: SQLITE_MIGRATIONS[0]!.version,
        max: SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]!.version,
      });
      expect(databaseSchema['writableTargetVersion']).toBe(SQLITE_MIGRATIONS.length);
      expect(databaseSchema['higherVersionPolicy']).toBe('reject');
    });

    it('握手版本门禁：当前与上一版 schema 通过，未知 schema/协议版本明确拒绝', () => {
      const baseRequest = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        hostInstanceId: '123e4567-e89b-42d3-a456-426614174000',
        dataRootIdentity: 'ab'.repeat(32),
      };
      expect(validateHandshakeRequest(baseRequest)).toEqual(baseRequest);
      expect(validateHandshakeRequest({ ...baseRequest, schemaVersion: CURRENT_SCHEMA_VERSION - 1 })).toEqual({
        ...baseRequest,
        schemaVersion: CURRENT_SCHEMA_VERSION - 1,
      });

      const expectHandshakeRejection = (code: string, request: unknown): void => {
        let caught: unknown;
        try {
          validateHandshakeRequest(request);
        } catch (error) {
          caught = error;
        }
        expect(caught, `握手请求 ${JSON.stringify(request)} 应被拒绝`).toBeInstanceOf(HostProtocolError);
        expect((caught as HostProtocolError).code).toBe(code);
      };
      expectHandshakeRejection('unsupported_schema_version', {
        ...baseRequest,
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      });
      expectHandshakeRejection('protocol_incompatible', {
        ...baseRequest,
        protocolVersion: CURRENT_PROTOCOL_VERSION + 1,
      });
    });
  });

  describe('敏感信息、开发机路径与 Nezha 边界', () => {
    it('清单/声明/锁不含开发机绝对路径、凭据样式键值或 Nezha 运行时依赖', () => {
      const scannedTexts = [
        ...MANIFEST_PATHS.map((path) => readText(path)),
        readText('distribution-compatibility.json'),
      ];
      for (const text of scannedTexts) {
        expect(text).not.toContain('/Users/');
        expect(text).not.toContain('/home/');
        expect(text).not.toContain('C:\\');
        expect(text).not.toMatch(/[0-9a-f]{40,}/i);
      }
      for (const parsed of [rootManifest, coreManifest, hostManifest, cliManifest, compatibility]) {
        for (const key of collectKeys(parsed)) {
          expect(
            key.match(/secret|password|token|api[_-]?key|credential|webhook/i),
            `键名 ${key} 不得是凭据样式`,
          ).toBeNull();
        }
      }
      for (const manifest of Object.values(manifestsByName)) {
        for (const [name] of dependencyEntries(manifest)) {
          expect(name.match(/nezha/i), `依赖 ${name} 不得引入 Nezha 运行时`).toBeNull();
        }
      }
      expect(readText('package-lock.json')).not.toContain('nezha');
    });
  });

  describe('发布阻塞与 Phase 集成边界', () => {
    it('许可证/npm scope/正式包名/发布身份保持待负责人确认', () => {
      const releaseBlockers = compatibility['releaseBlockers'] as Record<string, unknown>;
      expect(releaseBlockers['ownerConfirmation']).toBe('pending');
      const items = releaseBlockers['items'] as Record<string, { status: string }>;
      expect(Object.keys(items).sort()).toEqual(
        ['license', 'npmScope', 'publicPackageNames', 'publishIdentity'].sort(),
      );
      for (const item of Object.values(items)) {
        expect(item.status).toBe('pending');
      }
    });

    it('真实安装/原生模块/Host 启动等登记为 Phase 集成 not_run，不在此宣称通过', () => {
      const phaseIntegration = compatibility['phaseIntegration'] as Record<string, unknown>;
      expect(phaseIntegration['status']).toBe('not_run');
      const items = phaseIntegration['items'] as { id: string }[];
      expect(items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          'real-install-independent-directory',
          'native-module-loading',
          'host-startup-packed-artifact',
          'existing-host-compatibility-matrix',
        ]),
      );
    });
  });
});
