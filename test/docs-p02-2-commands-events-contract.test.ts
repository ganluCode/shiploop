/**
 * F-001 文档核验：`docs/p02-2-commands-events-contract.md` 记录的前序基线与
 * P02-2 命令/查询/事件/CLI 实施契约必须与仓库事实一致，避免「文档另立一套」
 * 与后续 F-002 ~ F-020 各自发明协议。
 *
 * 定位：F-001 只交付基线核对与契约文档（+ 本守护）；/v1 业务路由、SSE 与
 * CLI 新命令由后续任务增量实现。本文中冻结的是「目标契约」，不是已实现
 * 声明——因此本套件同时核验开工时的现状事实（开工基线：线消息版本 1、迁移
 * 止于 v2、capabilities unsupported、CLI 只有 host 子命令），后续任务改变这些
 * 事实时必须同步更新本守护与契约。当前状态：F-006 已新增迁移 v3
 * command_receipts（本守护已同步）；线消息版本/capabilities/CLI 面仍保持
 * 开工基线（F-011/F-013/F-014 起按契约演进）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p02-2-commands-events-contract.md';
const contractDoc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf-8');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8'));
}

function readText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

/** 文档必须逐字记录的冻结基线事实（值变更必须走契约修订，不能静默漂移）。 */
const FROZEN_BASELINE_FACTS = [
  // 开工 HEAD（P02-1 F-014 文档提交）与 P02-1 受测产品 commit（完整 hash）。
  '7ae5f39bb3d30a82a37a592d938a8e3d933f8c02',
  '8473f306d8bc825356eaa42defc3e512e22edbae',
  // P01 放行基线与负责人放行提交。
  '5a43a042b98bf2317db7501547def93a4f08f2fa',
  '24dcb7da41f2cb080c6b01c94a4cb24bddb8e4d3',
  // 工具版本与开工基线实测计数（历史事实，不随后续实现改写）。
  '22.19.0',
  '10.9.3',
  '59 test files / 1332 tests passed',
] as const;

/** §3.2 冻结的全部业务路由（方法 + 路径必须同时出现）。 */
const FROZEN_ROUTES = [
  'POST /v1/commands',
  'GET /v1/receipts/:commandId',
  'GET /v1/results/:resultRef',
  'GET /v1/projects',
  'GET /v1/projects/:projectId',
  'GET /v1/projects/:projectId/repository-binding',
  'GET /v1/projects/label-counts',
  'GET /v1/settings/global',
  'GET /v1/settings/global/export',
  'GET /v1/projects/:projectId/settings',
  'GET /v1/projects/:projectId/settings/effective',
  'GET /v1/projects/:projectId/settings/export',
  'GET /v1/snapshot',
  'GET /v1/events',
] as const;

/** 六个冻结命令名（§6 白名单与 §11.3 能力视图必须一致）。 */
const FROZEN_OPERATIONS = [
  'project.register',
  'project.metadata.update',
  'settings.global.create',
  'settings.global.update',
  'settings.project.create',
  'settings.project.update',
] as const;

/** 后续任务共用的关键契约概念，缺失即表示协议未被完整记录。 */
const FROZEN_CONCEPT_TERMS = [
  'schemaVersion',
  'protocolVersion',
  'commandId',
  'expectedRevision',
  'requestDigest',
  'command_receipts',
  'stableCanonicalJson',
  'BEGIN IMMEDIATE',
  'resultRef',
  'principalId',
  'local-owner',
  'test-restricted',
  'projectScope',
  'forbidden',
  'not_found',
  'command_expired',
  'corrupt_state',
  'snapshot_required',
  'stream_overflow',
  'observation_interrupted',
  'evcur_v1_',
  'watermark',
  'Last-Event-ID',
  'project.registered',
  'settings.global_created',
  'settings.project_created',
  'project.metadata_updated',
  'settings.global_updated',
  'settings.project_updated',
  'scope_kind',
  'principal_id',
  'idempotency_key_reuse',
  // 版本分离原则。
  'SETTINGS_SCHEMA_VERSION',
  'SETTINGS_EXPORT_FORMAT_VERSION',
  // CLI 退出码第五档。
  '退出码',
] as const;

/** 非目标必须显式写出，防止后续任务用占位冒充能力。 */
const NON_GOAL_TERMS = [
  'Work 执行域',
  'Chat API',
  'runBaseline',
  'confirmProfile',
  'Pi SDK',
  '任意文件读取',
  'accept:p02',
  'operations` 表',
  'Web/Electron',
  '强 OS 沙箱',
] as const;

describe('F-001 P02-2 应用命令/查询/事件契约文档', () => {
  it('存在且为非空 Markdown，明确是实施前置契约而非已实现声明', () => {
    expect(contractDoc.startsWith('# P02-2')).toBe(true);
    expect(contractDoc).toContain('F-001');
    expect(contractDoc).toContain('尚不存在');
    expect(contractDoc).toContain('**不是**阶段验收报告');
  });

  it.each(FROZEN_BASELINE_FACTS)('记录冻结基线事实：%s', (fact) => {
    expect(contractDoc).toContain(fact);
  });

  it.each(FROZEN_ROUTES)('冻结业务路由：%s', (route) => {
    expect(contractDoc).toContain(route);
  });

  it.each(FROZEN_OPERATIONS)('冻结命令操作名：%s', (operation) => {
    expect(contractDoc).toContain(operation);
  });

  it.each(FROZEN_CONCEPT_TERMS)('记录协议关键概念：%s', (term) => {
    expect(contractDoc).toContain(term);
  });

  it.each(NON_GOAL_TERMS)('明确写出非目标：%s', (term) => {
    expect(contractDoc).toContain(term);
  });

  it('记录三处设计差异并给出契约决定与核对请求', () => {
    // 差异 1：注册前无 projectId 与信封/回执外键。
    expect(contractDoc).toContain('15.1');
    expect(contractDoc).toContain('注册前无 projectId');
    expect(contractDoc).toContain('command_receipts_scope_check');
    // 差异 2：全局配置与全局事件授权。
    expect(contractDoc).toContain('15.2');
    expect(contractDoc).toContain('settings.global.read');
    // 差异 3：P01 首次创建不写事件与命令创建事件。
    expect(contractDoc).toContain('15.3');
    expect(contractDoc).toContain('创建事件只在新命令提交路径写入');
    // 每处差异都必须显式请求核对。
    const matches = contractDoc.match(/请求核对/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('按行为记录 T26 编号差异（命令幂等 vs 设计 09 配置 CAS）', () => {
    expect(contractDoc).toContain('T26命令幂等');
    expect(contractDoc).toContain('当前配置 CAS 冲突');
    expect(contractDoc).toContain('14.3');
  });

  it('版本空间分离：线消息升 v2、发现/线协议/配置 payload 版本不联动', () => {
    expect(contractDoc).toContain('发现 `schemaVersion` | `1`');
    expect(contractDoc).toContain('线协议 `protocolVersion` | `1`');
    expect(contractDoc).toMatch(/线消息 `schemaVersion` \| \*\*`2`/);
    expect(contractDoc).toContain('配置 payload `schemaVersion`');
  });

  it('不把开发机绝对路径或 Bearer 凭据样例写进运行文档', () => {
    expect(contractDoc).not.toMatch(/\/Users\//);
    expect(contractDoc).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
  });
});

describe('F-001 契约文档与仓库基线一致（开工现状事实）', () => {
  it('根清单脚本与版本不变，且仍未冒用 accept:p02', () => {
    const root = readJson('package.json');
    expect(root.engines).toEqual({ node: '22.19.0', npm: '10.9.3' });
    expect(root.packageManager).toBe('npm@10.9.3');
    expect(Object.keys(root.scripts as Record<string, string>).sort()).toEqual(
      ['accept:p01', 'build', 'check:boundaries', 'test', 'typecheck', 'verify'].sort(),
    );
    expect(root.scripts).not.toHaveProperty('accept:p02');
  });

  it('F-011 已升线消息 v2 并以 §11.3 结构化能力宣告真实接线（F-012 起 events 为 SSE 视图）', () => {
    const constants = readText('packages/host/src/contract/constants.ts');
    expect(constants).toMatch(/export const CURRENT_SCHEMA_VERSION = 2 as const/);
    expect(constants).toMatch(/export const MAX_APP_BODY_BYTES = 65_536/);
    expect(constants).toMatch(/export const MAX_QUERY_STRING_BYTES = 8_192/);
    const lifecycle = readText('packages/host/src/contract/lifecycle.ts');
    expect(lifecycle).toContain('readonly application: ApplicationCapabilityView');
    expect(lifecycle).toContain('readonly events: EventsCapabilityView');
    expect(lifecycle).toContain("transport: 'sse'");
    expect(lifecycle).toContain('scopes: [\'project\', \'global\']');
    // 契约必须记录演进依据与独立版本纪律。
    expect(contractDoc).toContain('P02-2 起');
    expect(contractDoc).toContain('§11.3');
  });

  it('F-006 已新增迁移 v3 command_receipts（开工基线为 v2，本守护随实现同步）', () => {
    const migrations = readText('packages/core/src/adapters/sqlite/migrations.ts');
    expect(migrations).toMatch(/version: 1,/);
    expect(migrations).toMatch(/version: 2,/);
    expect(migrations).toMatch(/version: 3,/);
    expect(migrations).toContain('command_receipts');
    expect(migrations).toContain('command_receipts_principal_command_unique');
    expect(migrations).toContain('command_receipts_scope_check');
    expect(contractDoc).toContain('迁移 v3');
    expect(contractDoc).toContain('(principal_id, command_id)');
  });

  it('配置 payload 与导出版本、既有事件类型与契约记录一致', () => {
    const schema = readText('packages/core/src/ports/settings-schema.ts');
    expect(schema).toContain('export const SETTINGS_SCHEMA_VERSION = 2');
    const configService = readText('packages/core/src/application/configuration-service.ts');
    expect(schema).toContain('export const SETTINGS_EXPORT_FORMAT_VERSION = 1');
    expect(configService).toContain("export { SETTINGS_EXPORT_FORMAT_VERSION } from '../ports/settings-schema.js'");
    const stateStorePort = readText('packages/core/src/ports/state-store.ts');
    expect(stateStorePort).toContain("PROJECT_METADATA_UPDATED_EVENT_TYPE = 'project.metadata_updated'");
    expect(stateStorePort).toContain("GLOBAL_SETTINGS_UPDATED_EVENT_TYPE = 'settings.global_updated'");
    expect(stateStorePort).toContain("PROJECT_SETTINGS_UPDATED_EVENT_TYPE = 'settings.project_updated'");
  });

  it('开工时 CLI 仍只有 host 生命周期子命令（F-014 起按 §12 扩展）', () => {
    const args = readText('packages/cli/src/host/args.ts');
    expect(args).toContain("HOST_CLI_SUBCOMMANDS = ['start', 'status', 'stop']");
    expect(contractDoc).toContain('shiploop project register');
    expect(contractDoc).toContain('shiploop receipt get');
    expect(contractDoc).toContain('shiploop events');
  });

  it('F-011 已接线 §3.2 应用路由；F-012 已接线 /v1/events SSE 订阅传输面', () => {
    const appTransport = readText('packages/host/src/runtime/app-transport.ts');
    expect(appTransport).toContain('/v1/commands');
    const transport = readText('packages/host/src/runtime/http-transport.ts');
    expect(transport).toContain('HANDSHAKE_ROUTE');
    expect(transport).toContain('STATUS_ROUTE');
    expect(transport).toContain('STOP_ROUTE');
    expect(transport).toContain('handleApplicationRequest');
    const startup = readText('packages/host/src/runtime/host-startup.ts');
    expect(startup).toContain('createLocalOwnerPrincipal');
    expect(contractDoc).toContain('F-011 已接线');
    // F-012（§9.4）：SSE Hub 传输面 + Core 恢复解析/补读 + Last-Event-ID 端口。
    const sseTransport = readText('packages/host/src/runtime/sse-transport.ts');
    expect(sseTransport).toContain('export const SSE_MAX_PENDING_BYTES = 1_048_576');
    expect(sseTransport).toContain('export const SSE_HEARTBEAT_INTERVAL_MS = 15_000');
    expect(sseTransport).toContain('export const SSE_BATCH_LIMIT = 500');
    expect(sseTransport).toContain('export const SSE_MAX_BATCH_BYTES = 262_144');
    expect(sseTransport).toContain('snapshot_required');
    expect(sseTransport).toContain('stream_overflow');
    expect(startup).toContain('createEventStreamHub');
    const appTransportSse = readText('packages/host/src/runtime/app-transport.ts');
    expect(appTransportSse).toContain('events.subscribe');
    expect(appTransportSse).toContain('eventStreams');
    const queryService = readText('packages/core/src/application/query-service.ts');
    expect(queryService).toContain('resolveEventResume');
    expect(queryService).toContain('readEventBatch');
    const eventsPort = readText('packages/core/src/ports/events.ts');
    expect(eventsPort).toContain('findPersistedEventSequence');
    expect(contractDoc).toContain('F-012 已实施');
  });

  it('F-017 已接线 events 观察 CLI（快照+SSE、snapshot_required 重载、退出码 4）', () => {
    const appExecute = readText('packages/cli/src/app-execute.ts');
    expect(appExecute).toContain('executeEventsCommand');
    expect(appExecute).toContain('subscribeEvents');
    expect(appExecute).toContain('observation_interrupted');
    expect(appExecute).toContain('snapshot_required');
    const bin = readText('packages/cli/src/bin.ts');
    expect(bin).toContain('SIGINT');
    const output = readText('packages/cli/src/app/output.ts');
    expect(output).toContain('CLI_EXIT_OBSERVATION_INTERRUPTED');
    expect(contractDoc).toContain('F-017 已接线 events 观察');
  });

  it('F-018 整 Feature 集成回归套件与脱敏证据文档入档（§14 映射）', () => {
    expect(contractDoc).toContain('f018-regression-evidence.md');
    expect(existsSync(resolve(REPO_ROOT, 'test/p02-2-integration-regression.test.ts'))).toBe(true);
    const evidencePath = 'docs/acceptance/evidence-p02-2/f018-regression-evidence.md';
    expect(existsSync(resolve(REPO_ROOT, evidencePath))).toBe(true);
    const evidenceDoc = readText(evidencePath);
    for (const term of [
      'FR-1',
      'FR-2',
      'T10',
      'T15',
      'T17',
      'T23',
      'T26',
      'not_run',
      'p02-2-integration-regression',
      'npm run verify',
    ]) {
      expect(evidenceDoc).toContain(term);
    }
    // 证据文档不得含开发机绝对路径或疑似凭据样例。
    expect(evidenceDoc).not.toMatch(/\/Users\//);
    expect(evidenceDoc).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
  });

  it('P02-1 契约、交接与 F-014 报告仍在库且被本文显式接续', () => {
    for (const path of [
      'docs/p02-1-host-lifecycle-contract.md',
      'docs/p02-1-handoff.md',
      'docs/acceptance/p02-1-f014-report.md',
      'docs/p01-3-application-contract.md',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path))).toBe(true);
    }
    expect(contractDoc).toContain('p02-1-host-lifecycle-contract.md');
    expect(contractDoc).toContain('p01-3-application-contract.md');
  });
});
