/**
 * F-001 文档核验：`docs/p02-4-acceptance-contract.md` 声明的 P02-4 验收清单与接口映射
 * 必须与仓库中真实存在的 dist CLI 入口、Host 路由、回执/基线契约、夹具与前序回归入口一致，
 * 避免「文档另立一套」与实现漂移，并守护「必需检查未运行/夹具失败不得聚合为通过」的
 * fail-closed 纪律。
 *
 * 定位：F-001 只交付验收约定与检查清单（文档 + 本守护）；夹具、场景、报告、`accept:p02`
 * 与阶段报告由 F-002 ~ F-014 交付。本套件不新增业务实现，不扩大 P02-4 交付范围。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import { SETTINGS_EXPORT_FORMAT_VERSION } from '../packages/core/src/application/configuration-service.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p02-4-acceptance-contract.md';
const contractDoc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf-8');

/** F-001 §2.1 冻结的必需检查 ID（顺序即报告与聚合的固定顺序）。 */
const REQUIRED_CHECK_IDS = [
  'P02-ENG-VERIFY',
  'P02-FR1-UNIQUE-HOST',
  'P02-FR1-SHARED-STATE',
  'P02-FR1-BASELINE-OK',
  'P02-FR2-DUPLICATE-INIT',
  'P02-FR2-COMMAND-CONFLICT',
  'P02-FR2-SOURCE-PRESERVED',
  'P02-FR2-AUTH-REJECT',
  'P02-FR2-CLIENT-EXIT',
  'P02-FR1-RESTART-QUERY',
  'P02-FR2-BASELINE-FAILURE',
  'P02-PHASE-FIXTURE',
  'P02-PHASE-NOT-RUN',
  'P02-PHASE-REPORT',
  'P02-ENG-CLEAN-REPLAY',
] as const;

/** F-001 §2.3 前序必需回归的真实测试入口（`npm run verify` 的 `npm test` 默认收集）。 */
const PRIOR_REGRESSION_TEST_FILES = [
  'host-lifecycle-contract.test.ts',
  'host-launcher.test.ts',
  'host-fixture-kit.test.ts',
  'host-http-transport.test.ts',
  'host-cli-execute.test.ts',
  'client-protocol-boundary.test.ts',
  'atomic-commands.test.ts',
  'command-receipts-store.test.ts',
  'commands-contract.test.ts',
  'app-cli-execute.test.ts',
  'host-app-routes.test.ts',
  'host-sse-events.test.ts',
  'snapshot-and-events.test.ts',
  'app-cli-events-observe.test.ts',
  'authorization-contract.test.ts',
  'authorized-queries.test.ts',
  'host-protected-storage.test.ts',
  'project-registration.test.ts',
  'repository-inspector.test.ts',
  'p02-3-init-overview-vertical.test.ts',
  'p02-3-inspect-overview.test.ts',
  'baseline-contract.test.ts',
  'baseline-execution.test.ts',
  'baseline-evidence.test.ts',
  'baseline-host-faults.test.ts',
  'baseline-host-recovery.test.ts',
  'p02-3-baseline-preview-authorize.test.ts',
  'supervised-command-process.test.ts',
  'supervised-process-stopping.test.ts',
  'p02-1-integration-regression.test.ts',
  'p02-2-integration-regression.test.ts',
  'p02-3-integration-regression.test.ts',
  'sqlite-migration-runner.test.ts',
  'sqlite-schema-migrations.test.ts',
  'sqlite-cas-and-atomicity.test.ts',
  'sqlite-baseline-store.test.ts',
  'verify.test.ts',
  'typescript-build.test.ts',
  'boundary-check.test.ts',
  'deterministic-test-harness.test.ts',
] as const;

describe('F-001 P02-4 验收契约文档', () => {
  it('记录前序基线核验、真实分支/提交与交付报告（不冒充阶段验收、不代签）', () => {
    for (const branch of [
      'feat/2026-10-04-23-19-52_p02-1-host',
      'feat/2026-10-04-23-19-52_p02-2',
      'feat/2026-10-04-23-19-52_p02-3',
      'feat/2026-10-04-23-19-52_p02-4-p02',
    ]) {
      expect(contractDoc).toContain(branch);
    }
    for (const commit of ['7ae5f39', '3caca48', '18d490e', 'fdacf25', '6c140f8']) {
      expect(contractDoc).toContain(commit);
    }
    for (const report of [
      'p02-1-f014-report.md',
      'p02-2-f020-report.md',
      'p02-3-f020-report.md',
    ]) {
      expect(contractDoc).toContain(report);
    }
    // P01 放行依据：acceptance/p01 与 owner approval 人工记录只核验不代替。
    expect(contractDoc).toContain('acceptance/p01');
    expect(contractDoc).toContain('5a43a04');
    expect(contractDoc).toContain('24dcb7d');
    expect(contractDoc).toContain('p01-review-results.md');
    expect(contractDoc).toContain('不代替人工签字');
    // 基线验证命令与实测结果。
    expect(contractDoc).toContain('npm run verify');
    expect(contractDoc).toContain('PASS 3/3');
    expect(contractDoc).toContain('102 test files');
    expect(contractDoc).toContain('2713');
    // 明确不是阶段验收报告。
    expect(contractDoc).toContain('不是');
    expect(contractDoc).toContain('阶段验收报告');
  });

  it('冻结的必需检查 ID 集合与文档一致且无重复', () => {
    // 仅匹配 §2.1 必需检查表的首列（形如 `| `P02-...``）。
    const ids = [...contractDoc.matchAll(/^\| `(P02-[A-Z0-9-]+)`/gm)].map((match) => match[1]);
    expect(ids).toEqual([...REQUIRED_CHECK_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
    // 每个检查 ID 都有 FR/阶段分支承接说明。
    for (const id of REQUIRED_CHECK_IDS) {
      expect(contractDoc).toContain(id);
    }
  });

  it('PRD FR-1/FR-2 关键分支均有检查 ID 承接（含验收要求的覆盖项）', () => {
    for (const branch of [
      '唯一 Host',
      '共享项目/配置',
      '授权基线',
      '认证拒绝',
      '重复初始化',
      '命令重放/冲突',
      '源文件保留',
      '客户端退出',
      '重启查询',
      '基线失败',
      '夹具失败',
      '必需检查未运行',
    ]) {
      expect(contractDoc).toContain(branch);
    }
    // fail-closed：not_run 不折算、accepted 不是 passed。
    expect(contractDoc).toContain('not_run');
    expect(contractDoc).toContain('accepted');
    expect(contractDoc).toContain('不是通过');
  });

  it('真实 dist CLI 入口、命令面与五档退出码被记录', () => {
    for (const token of [
      'packages/cli/dist/bin.js',
      'shiploop',
      'host start',
      'project init',
      'baseline preview',
      'baseline run',
      'baseline status',
      'baseline evidence',
      'receipt get',
      'config',
      'events',
      '--data-root',
      '--confirm',
      '--decline',
      '--command-id',
    ]) {
      expect(contractDoc).toContain(token);
    }
    // 退出码五档冻结值。
    for (const code of ['`0`', '`1`', '`2`', '`3`', '`4`']) {
      expect(contractDoc).toContain(code);
    }
    expect(contractDoc).toContain('observation_interrupted');
  });

  it('Host 路由/协议、可信授权上下文与幂等回执契约被记录', () => {
    for (const route of [
      'POST /v1/host/handshake',
      'POST /v1/commands',
      'GET /v1/receipts/:commandId',
      'GET /v1/results/:resultRef',
      'GET /v1/events',
      'GET /v1/projects/inspect',
      'GET /v1/baselines/:operationId',
      'GET /v1/artifacts/:artifactId/content',
    ]) {
      expect(contractDoc).toContain(route);
    }
    for (const token of [
      // P03-2 / F-007 起线消息升 v5（P03-1 冻结时为 4，历史记录保留）。
      'schemaVersion=5',
      'P03-1 / F-009',
      'P03-2 / F-007',
      'evcur_v1',
      'local-owner',
      'TrustedPrincipal',
      'test-restricted',
      'Bearer',
      'writer.lock',
      'requestDigest',
      'idempotency_key_reuse',
      'replayed:true',
    ]) {
      expect(contractDoc).toContain(token);
    }
  });

  it('基线状态/证据查询与进程夹具约束被记录，且引用的既有夹具在库', () => {
    for (const token of [
      'previewDigest',
      'artifactId',
      'stop_unconfirmed',
      'preview_stale',
      '16 KiB',
      '8 MiB',
    ]) {
      expect(contractDoc).toContain(token);
    }
    for (const helperDir of ['test/helpers/p02-3', 'test/helpers/host']) {
      expect(contractDoc).toContain(helperDir);
      expect(existsSync(join(REPO_ROOT, helperDir)), `夹具目录缺失：${helperDir}`).toBe(true);
    }
    for (const helper of [
      ['test/helpers/p02-2', 'storage-probe.ts'],
      ['test/helpers', 'safe-cleanup.ts'],
      ['test/helpers', 'register-race-child.ts'],
      ['test/helpers', 'writer-lock-child.ts'],
    ]) {
      expect(existsSync(join(REPO_ROOT, ...helper)), `夹具缺失：${helper.join('/')}`).toBe(true);
    }
  });

  it('声明的 schema/迁移版本与实现的真实常量一致', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    expect(SETTINGS_EXPORT_FORMAT_VERSION).toBe(1);
    const migrationVersions = SQLITE_MIGRATIONS.map((migration) => migration.version);
    // P03-1 / F-002 起新增 v6 计划结构四表、P03-2 / F-002 起新增 v7 approvals 决策
    // 记录表、P03-2 / F-003 起新增 v8 approvals.check_policy_digest 检查政策身份绑定、
    // P03-3 / F-002 起新增 v9 单 Feature 执行域三表
    // （P02-4 冻结时止于 v5；事实演进同步登记）。
    expect(migrationVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(contractDoc).toContain('v1..v10');
    expect(contractDoc).toContain('state_events');
    expect(contractDoc).toContain('command_receipts');
  });

  it('阶段验收索引按实际行为映射并记录 T26 编号差异', () => {
    for (const index of ['T10', 'T15', 'T17', 'T23', 'T26']) {
      expect(contractDoc).toContain(index);
    }
    expect(contractDoc).toContain('命令幂等');
    expect(contractDoc).toContain('配置 CAS');
    expect(contractDoc).toContain('不宣称完整索引已验收');
  });

  it('明确平台、版本锁定、依赖与非目标边界', () => {
    expect(contractDoc).toContain('macOS');
    for (const version of ['22.19.0', '10.9.3', '13.0.3', '0.45.3', '7.0.2', '5.0.3', '9.6.0', '22.20.4']) {
      expect(contractDoc).toContain(version);
    }
    expect(contractDoc).toContain('better-sqlite3');
    expect(contractDoc).toContain('Drizzle');
    for (const exclusion of [
      'Work/Pi',
      'Web',
      'Profile',
      'rebind',
      '强沙箱',
      '不自动修改',
    ]) {
      expect(contractDoc).toContain(exclusion);
    }
    // verify 与 accept:p02 执行要求显式记录。
    expect(contractDoc).toContain('npm run verify');
    expect(contractDoc).toContain('accept:p02');
  });

  it('前序必需回归的真实测试入口均在库且被文档引用', () => {
    for (const file of PRIOR_REGRESSION_TEST_FILES) {
      expect(contractDoc).toContain(file);
      expect(existsSync(join(REPO_ROOT, 'test', file)), `前序回归测试入口缺失：test/${file}`).toBe(
        true,
      );
    }
  });

  it('记录设计张力与待核对项（不静默改变语义）', () => {
    expect(contractDoc).toContain('请求核对');
    expect(contractDoc).toContain('command_receipts.project_id');
    expect(contractDoc).toContain('帮助文案漂移');
    expect(contractDoc).toContain('run-id');
    expect(contractDoc).toContain('acceptance/p02.config.json');
  });
});
