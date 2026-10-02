/**
 * F-001 文档核验：`docs/p01-4-acceptance-contract.md` 声明的 P01-4 验收约定与检查清单
 * 必须与仓库中真实存在的前序能力、常量、迁移与测试入口一致，避免「文档另立一套」与
 * 实现漂移，并守护「必需检查未运行/夹具失败不得聚合为通过」的 fail-closed 纪律。
 *
 * 定位：F-001 只交付验收约定与检查清单（文档 + 本守护）；`accept:p01`、夹具、报告与阶段
 * 最终报告由 F-002 ~ F-010 交付。本套件不新增业务实现，不扩大 P01-4 交付范围。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { GLOBAL_SETTINGS_ID } from '../packages/core/src/ports/state-store.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import { SETTINGS_EXPORT_FORMAT_VERSION } from '../packages/core/src/application/configuration-service.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p01-4-acceptance-contract.md';
const contractDoc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf-8');

/** F-001 §2.1 冻结的必需检查 ID（顺序即报告与聚合的固定顺序）。 */
const REQUIRED_CHECK_IDS = [
  'P01-ENG-VERIFY',
  'P01-FR1-NORMAL',
  'P01-FR1-REOPEN',
  'P01-FR1-ROLLBACK',
  'P01-FR2-CONFIG',
  'P01-FR2-ROLLBACK',
  'P01-FR2-CAS',
  'P01-FR2-TAGS',
  'P01-FR2-ARTIFACT-MISSING',
  'P01-FR2-ARTIFACT-RECOVERY',
  'P01-PHASE-FIXTURE',
  'P01-PHASE-NOT-RUN',
  'P01-ENG-BUILD-SMOKE',
  'P01-PHASE-REPORT',
] as const;

/** F-001 §2.3 前序必需回归的真实测试入口（`npm run verify` 的 `npm test` 默认收集）。 */
const PRIOR_REGRESSION_TEST_FILES = [
  'project-registration.test.ts',
  'repository-inspector.test.ts',
  'project-metadata-validation.test.ts',
  'project-metadata-service.test.ts',
  'project-tag-filter.test.ts',
  'settings-schema-v2.test.ts',
  'runtime-capabilities.test.ts',
  'configuration-service.test.ts',
  'sqlite-cas-and-atomicity.test.ts',
  'effective-settings-merge.test.ts',
  'settings-query-service.test.ts',
  'path-service.test.ts',
  'core-assembly.test.ts',
  'deterministic-test-harness.test.ts',
  'sqlite-storage-fixture.test.ts',
] as const;

describe('F-001 P01-4 验收契约文档', () => {
  it('记录前序基线核验、真实命令与退出码（不冒充阶段验收）', () => {
    // 三条前置都是当前分支历史内的真实分支。
    for (const branch of [
      'feat/2026-10-01-23-44-21_p01-1',
      'feat/2026-10-01-23-44-21_p01-2-sqlite',
      'feat/2026-10-01-23-44-21_p01-3',
    ]) {
      expect(contractDoc).toContain(branch);
    }
    // 前序 tip commit 与 P01-3 受测 commit。
    for (const commit of ['44c8c30', '74934ac', '2578a66', '60e9308']) {
      expect(contractDoc).toContain(commit);
    }
    // 已验收报告与基线验证命令/退出码。
    for (const report of [
      'p01-1-f006-report.md',
      'p01-2-f014-report.md',
      'p01-3-f014-report.md',
    ]) {
      expect(contractDoc).toContain(report);
    }
    expect(contractDoc).toContain('npm run verify');
    expect(contractDoc).toContain('PASS 3/3');
    expect(contractDoc).toContain('35 test files');
    expect(contractDoc).toContain('700');
    // 明确不是阶段验收报告，且验收实现在后续任务。
    expect(contractDoc).toContain('不是');
    expect(contractDoc).toContain('阶段验收报告');
  });

  it('冻结的必需检查 ID 集合与文档一致且无重复', () => {
    // 仅匹配 §2.1 必需检查表的首列（形如 `| \`P01-...\``）。
    const ids = [...contractDoc.matchAll(/^\| `(P01-[A-Z0-9-]+)`/gm)].map((match) => match[1]);
    expect(ids).toEqual([...REQUIRED_CHECK_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
    // 每个 FR/阶段分支都有检查 ID 承接。
    for (const id of REQUIRED_CHECK_IDS) {
      expect(contractDoc).toContain(id);
    }
  });

  it('声明的 schemaVersion / 导出格式版本 / 迁移版本与实现的真实常量一致', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    expect(SETTINGS_EXPORT_FORMAT_VERSION).toBe(1);
    expect(GLOBAL_SETTINGS_ID).toBe('global');
    expect(SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
    expect(SQLITE_MIGRATIONS[1]?.sql).toContain('CREATE TABLE state_events');

    expect(contractDoc).toContain(`schemaVersion\` | \`${SETTINGS_SCHEMA_VERSION}\``);
    expect(contractDoc).toContain(`SETTINGS_EXPORT_FORMAT_VERSION=${SETTINGS_EXPORT_FORMAT_VERSION}`);
    expect(contractDoc).toContain('SQLITE_MIGRATIONS');
    expect(contractDoc).toContain('state_events');
  });

  it('实际 Core 装配与命令/查询入口在文档中可核对', () => {
    for (const token of [
      'openCoreApplication',
      'shiploop-core/assembly',
      'registerRepository',
      'updateProjectMetadata',
      'createSettings',
      'updateSettings',
      'publishArtifact',
      'getEffectiveSettings',
      'exportSettings',
      'locateProjectResource',
      'readVerifiedContent',
    ]) {
      expect(contractDoc).toContain(token);
    }
  });

  it('报告位置、配置入口、有限超时、结果状态与证据保留规则被显式声明', () => {
    expect(contractDoc).toContain('artifacts/acceptance/p01/<run-id>/');
    expect(contractDoc).toContain('acceptance/p01.config.json');
    expect(contractDoc).toContain('SHIPLOOP_ACCEPT_P01_RUN_ID');
    expect(contractDoc).toContain('SHIPLOOP_VERIFY_STEP_TIMEOUT_MS');
    // 结果状态三态与 fail-closed 聚合。
    for (const status of ['`pass`', '`fail`', '`not_run`']) {
      expect(contractDoc).toContain(status);
    }
    expect(contractDoc).toContain('600_000');
    expect(contractDoc).toContain('30_000');
    // 证据先导出后清理、相对路径、不导出秘密。
    expect(contractDoc).toContain('相对路径');
    expect(contractDoc).toContain('脱敏');
    expect(contractDoc).toContain('证据');
  });

  it('阶段验收索引明确 T03/T24/T26/T32 子集，且 Task 策略复制属 P03', () => {
    for (const index of ['T03', 'T24', 'T26', 'T32']) {
      expect(contractDoc).toContain(index);
    }
    expect(contractDoc).toContain('tasks.execution_config');
    expect(contractDoc).toContain('P03');
    // 本阶段不建执行表。
    expect(contractDoc).toContain('不建执行表');
  });

  it('明确平台、版本锁定与非目标边界', () => {
    expect(contractDoc).toContain('macOS');
    for (const version of ['22.19.0', '10.9.3', '13.0.3', '0.45.3', '7.0.2', '5.0.3', '9.6.0', '22.20.4']) {
      expect(contractDoc).toContain(version);
    }
    for (const exclusion of [
      'Host 网络接口',
      'CLI 命令',
      'Runtime/Pi SDK',
      'DAG',
      '桌面端',
      '强 OS 沙箱',
      'Task 策略复制',
      '不自动修改 Harness YAML',
    ]) {
      expect(contractDoc).toContain(exclusion);
    }
  });

  it('前序必需回归的真实测试入口均在库且被文档引用', () => {
    for (const file of PRIOR_REGRESSION_TEST_FILES) {
      expect(contractDoc).toContain(file);
      expect(existsSync(join(REPO_ROOT, 'test', file)), `前序回归测试入口缺失：test/${file}`).toBe(
        true,
      );
    }
    // 故障注入子进程夹具与运行器入口在位。
    for (const helper of ['register-race-child.ts', 'settings-race-child.ts', 'cas-race-child.ts', 'interrupt-publish-child.ts']) {
      expect(contractDoc).toContain(helper);
      expect(existsSync(join(REPO_ROOT, 'test', 'helpers', helper))).toBe(true);
    }
  });

  it('记录设计张力并请求核对（不静默改变语义）', () => {
    expect(contractDoc).toContain('请求核对');
    expect(contractDoc).toContain('请求确认');
    expect(contractDoc).toContain('state_events.project_id');
    expect(contractDoc).toContain('dataNamespace');
  });
});
