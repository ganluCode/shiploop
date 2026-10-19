/**
 * F-001 文档核验：`docs/p02-3-onboarding-contract.md` 记录的前序基线与 P02-3
 * 静态接入/基线授权/受监督进程/CLI 实施契约必须与仓库事实一致，避免「文档另立
 * 一套」与后续 F-002 ~ F-020 各自发明协议。
 *
 * 定位：F-001 只交付基线核对与契约文档（+ 本守护）；/v1 基线路由、受监督进程
 * 适配器、基线 CLI 与 Skill 由后续任务增量实现。本文冻结的是「目标契约」，不是
 * 已实现声明——因此本套件同时核验开工时的现状事实（开工基线：线消息 schemaVersion
 * 2、迁移止于 v3、能力 9 项、CLI 顶层 project/config/receipt/events、退出码 0~4），
 * 后续任务改变这些事实时必须同步更新本守护与契约。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT_DOC_PATH = 'docs/p02-3-onboarding-contract.md';
const contractDoc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf-8');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8'));
}

function readText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

/** 文档必须逐字记录的冻结基线事实（值变更必须走契约修订，不能静默漂移）。 */
const FROZEN_BASELINE_FACTS = [
  // 开工 HEAD（P02-3 起点，P02-2 F-020 纯文档提交）。
  '3caca4892423fb33c2ea423edfd426c146314793',
  // P02-2 受测产品 commit（F-019/F-018/F-017）与 P02-2 文档起点。
  '98cf080394e1d9f848c06ecbcca65c28c1b3c7b7',
  '9d92977047555afc547705446c952fbf43bf08a4',
  'eff0c2634b8eb04c27082a5727471f06fd35ff9d',
  // P02-1 受测产品 commit 与 P02-1 文档起点。
  '8473f306d8bc825356eaa42defc3e512e22edbae',
  '7ae5f39bb3d30a82a37a592d938a8e3d933f8c02',
  // P02-1 起点、P01 放行基线与负责人放行提交（main tip）。
  '83091167ffd41494146f404fbc46861d3b976d13',
  '5a43a042b98bf2317db7501547def93a4f08f2fa',
  '24dcb7da41f2cb080c6b01c94a4cb24bddb8e4d3',
  // 工具版本与开工基线实测计数（历史事实，不随后续实现改写）。
  '22.19.0',
  '10.9.3',
  '81 test files',
  '2174 tests passed',
] as const;

/** §3.2 冻结的 P02-3 新增业务路由（方法 + 路径必须同时出现）。 */
const FROZEN_ROUTES = [
  'GET /v1/projects/inspect?path=<abs>',
  'GET /v1/projects/:projectId/overview',
  'POST /v1/commands',
  'GET /v1/projects/:projectId/baselines?limit&cursor',
  'GET /v1/baselines/:operationId',
  'GET /v1/artifacts/:artifactId/content',
] as const;

/** §6 冻结的 P02-3 新增命令名与 §3.2 查询操作名。 */
const FROZEN_OPERATIONS = [
  'baseline.preview',
  'baseline.run',
  'baseline.cancel',
  'projects.inspect',
  'projects.overview',
  'baselines.list',
  'baselines.get',
  'artifacts.get',
] as const;

/** 后续任务共用的关键契约概念，缺失即表示协议未被完整记录。 */
const FROZEN_CONCEPT_TERMS = [
  // 异步操作模型首次启用。
  'accepted',
  'operationId',
  // 迁移 v4 四张基线作用域表。
  'baseline_authorizations',
  'baseline_operations',
  'baseline_check_results',
  'baseline_occupancy',
  // 摘要与代码身份。
  'previewDigest',
  'planDigest',
  'workingTreeDigest',
  'codeIdentity',
  'environmentRef',
  'cwdRef',
  'checkKey',
  'required',
  // 三轴状态与原因码。
  'passed',
  'failed',
  'error',
  'inconclusive',
  'not_run',
  'authorization_rejected',
  'missing_command',
  'unknown_script',
  'spawn_failed',
  'permission_denied',
  'timed_out',
  'cancelled',
  'stop_unconfirmed',
  'source_changed',
  'evidence_incomplete',
  'output_overflow',
  'restart_recovery',
  'preview_stale',
  'baseline_in_progress',
  'empty_check_set',
  // 新增能力位。
  'baseline.read',
  'baseline.run',
  // 版本分离原则。
  'unsupported_schema_version',
] as const;

/** 非目标必须显式写出，防止后续任务用占位冒充能力。 */
const NON_GOAL_TERMS = [
  'confirmProfile',
  'ProjectProfile',
  'Work/Pi',
  'Pi SDK',
  '模型请求',
  'rebind',
  '隔离副本',
  '强 OS 沙箱',
  'accept:p02',
  'Web/Electron',
  '任意文件读取',
] as const;

describe('F-001 P02-3 项目初始化与获准基线检查契约文档', () => {
  it('存在且为非空 Markdown，明确是实施前置契约而非已实现声明', () => {
    expect(contractDoc.startsWith('# P02-3')).toBe(true);
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

  it.each(FROZEN_OPERATIONS)('冻结命令/查询操作名：%s', (operation) => {
    expect(contractDoc).toContain(operation);
  });

  it.each(FROZEN_CONCEPT_TERMS)('记录协议关键概念：%s', (term) => {
    expect(contractDoc).toContain(term);
  });

  it.each(NON_GOAL_TERMS)('明确写出非目标：%s', (term) => {
    expect(contractDoc).toContain(term);
  });

  it('记录四项细化项并各自显式请求核对（验收标准 3）', () => {
    // 细化项 1：注册前 inspect 的身份与权限范围。
    expect(contractDoc).toContain('15.1');
    expect(contractDoc).toContain('注册前 inspect 的身份与权限范围');
    // 细化项 2：现有配置 Schema 不含检查命令时的独立授权输入。
    expect(contractDoc).toContain('15.2');
    expect(contractDoc).toContain('现有配置 Schema 不含检查命令');
    // 细化项 3：无 HEAD/脏工作区采用明确确认的当前工作区基线。
    expect(contractDoc).toContain('15.3');
    expect(contractDoc).toContain('无 HEAD/脏工作区');
    // 细化项 4：未知脚本/拒绝/缺命令/超时/取消/停止未确认的状态映射。
    expect(contractDoc).toContain('15.4');
    expect(contractDoc).toContain('停止未确认');
    // 每处细化项都必须显式请求核对。
    const matches = contractDoc.match(/请求核对/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('冻结三轴状态映射：操作状态、检查业务状态与原因码分开（验收标准 3）', () => {
    expect(contractDoc).toContain('三轴状态模型');
    expect(contractDoc).toContain('操作状态');
    expect(contractDoc).toContain('检查业务状态');
    expect(contractDoc).toContain('原因码');
    // passed/failed/error/inconclusive/not_run 语义齐全且 not_run 不折算通过。
    for (const status of ['passed', 'failed', 'error', 'inconclusive', 'not_run']) {
      expect(contractDoc).toContain(status);
    }
    expect(contractDoc).toContain('永不伪装');
  });

  it('版本空间分离：发现/线协议/配置 payload 不动，线消息 2 → 3', () => {
    expect(contractDoc).toContain('发现 `schemaVersion` | `1`');
    expect(contractDoc).toContain('线协议 `protocolVersion` | `1`');
    expect(contractDoc).toMatch(/线消息 `schemaVersion` \| \*\*`2` → `3`/);
    expect(contractDoc).toContain('配置 payload `schemaVersion`');
  });

  it('异步操作模型首次启用 accepted + operationId，且不违反「写事务内不长检查」', () => {
    expect(contractDoc).toContain('首次启用');
    expect(contractDoc).toContain('baseline_operations');
    expect(contractDoc).toContain('执行阶段在写事务之外');
    // P02-2 六个命令仍全为同步短事务命令。
    expect(contractDoc).toContain('P02-2 的六个命令仍全部为同步短事务命令');
  });

  it('按行为记录 T26 编号差异（命令幂等 vs 设计 09 配置 CAS）', () => {
    expect(contractDoc).toContain('T26');
    expect(contractDoc).toContain('命令幂等');
    expect(contractDoc).toContain('配置 CAS');
    expect(contractDoc).toContain('14.3');
  });

  it('不把开发机绝对路径或 Bearer 凭据样例写进运行文档', () => {
    expect(contractDoc).not.toMatch(/\/Users\//);
    expect(contractDoc).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
  });
});

describe('F-001 契约文档与仓库基线一致（开工现状事实）', () => {
  it('根清单脚本与版本不变（accept:p02 自 P02-4/F-011 起正式交付，指向本地控制器）', () => {
    const root = readJson('package.json');
    expect(root.engines).toEqual({ node: '22.19.0', npm: '10.9.3' });
    expect(root.packageManager).toBe('npm@10.9.3');
    expect(Object.keys(root.scripts as Record<string, string>).sort()).toEqual(
      ['accept:p01', 'accept:p02', 'accept:p03', 'accept:p03:clean-replay', 'build', 'check:boundaries', 'test', 'typecheck', 'verify'].sort(),
    );
    // P02-4/F-011 起正式交付：必须是本地控制器脚本，不得经由 npx/全局工具。
    expect(root.scripts).toHaveProperty('accept:p02', 'node scripts/acceptance/p02-accept.ts');
  });

  it('线消息 schemaVersion 已随 F-006 升至 3（开工为 2），契约记录起点与升版定案；P03-2/F-007 起续升 v5', () => {
    const constants = readText('packages/host/src/contract/constants.ts');
    // F-006 接线 projects.inspect/overview 并扩张握手能力集合，按 §3.1 显式升 v3；
    // P03-1 / F-009 计划域能力后续升 v4；P03-2 / F-007 决策/策略/输入准备与审批
    // 查询进入能力集合后续升 v5（docs/p03-2-plan-approval-contract.md）。
    expect(constants).toMatch(/export const CURRENT_SCHEMA_VERSION = 5 as const/);
    expect(constants).toMatch(/export const MAX_APP_BODY_BYTES = 65_536/);
    expect(constants).toMatch(/export const MAX_QUERY_STRING_BYTES = 8_192/);
    expect(constants).toContain("COMMANDS_ROUTE = '/v1/commands'");
    const commandsPort = readText('packages/core/src/ports/commands.ts');
    expect(commandsPort).toMatch(/export const WIRE_MESSAGE_SCHEMA_VERSION = 5 as const/);
    // 契约冻结线消息 2 → 3（P02-3 历史定案）；P03-1 续升 3 → 4 见 p03-1 契约；
    // P03-2 / F-007 续升 4 → 5 见 p03-2 契约。
    expect(contractDoc).toContain('WIRE_MESSAGE_SCHEMA_VERSION');
    expect(contractDoc).toMatch(/线消息 `schemaVersion` \| \*\*`2` → `3`/);
    expect(contractDoc).toContain('P03-1 / F-009');
    expect(contractDoc).toContain('P03-2 / F-007');
  });

  it('开工能力清单为 9 项、命令清单为 6 项，契约记录扩展后的 11 项/9 项', () => {
    const commandsPort = readText('packages/core/src/ports/commands.ts');
    expect(commandsPort).toContain("LOCAL_OWNER_PRINCIPAL_ID = 'local-owner'");
    // 开工九项能力与六个命令。
    expect(commandsPort).toMatch(/export const APP_CAPABILITIES = \[/);
    expect(commandsPort).toMatch(/export const COMMAND_OPERATIONS = \[/);
    const capabilityCount = (commandsPort.match(/'[a-z]+\.[a-z.]+',/g) ?? []).length;
    expect(capabilityCount).toBeGreaterThanOrEqual(9);
    // 契约记录新增两项能力位与三个命令。
    expect(contractDoc).toContain("'baseline.read'");
    expect(contractDoc).toContain("'baseline.run'");
    expect(contractDoc).toContain('11 项');
  });

  it('迁移随 F-007 升至 v4 基线四表（开工止于 v3），契约记录 v4 定案与 F-007 写回', () => {
    const migrations = readText('packages/core/src/adapters/sqlite/migrations.ts');
    expect(migrations).toMatch(/version: 1,/);
    expect(migrations).toMatch(/version: 2,/);
    expect(migrations).toMatch(/version: 3,/);
    // F-007（P02-3）已落地迁移 v4：基线作用域四表。
    expect(migrations).toMatch(/version: 4,/);
    expect(migrations).toContain('command_receipts');
    expect(migrations).toContain('command_receipts_principal_command_unique');
    expect(migrations).toContain('command_receipts_scope_check');
    // 契约冻结迁移 v4 与四张基线作用域表（含 F-007 写回的补充注记）。
    expect(contractDoc).toContain('迁移 **v4**');
    for (const table of [
      'baseline_authorizations',
      'baseline_operations',
      'baseline_check_results',
      'baseline_occupancy',
    ]) {
      expect(contractDoc).toContain(table);
    }
    expect(migrations).toContain('baseline_occupancy_process_identity_json_check');
    expect(contractDoc).toContain('process_identity');
    expect(contractDoc).toContain('F-007 补充');
  });

  it('迁移随 F-008 升至 v5（accepted 回执 + operation_id），契约记录写回与实施注记', () => {
    const migrations = readText('packages/core/src/adapters/sqlite/migrations.ts');
    // F-008（P02-3）已落地迁移 v5：command_receipts 重建（accepted 持久化）。
    expect(migrations).toMatch(/version: 5,/);
    expect(migrations).toContain("status IN ('completed','rejected','accepted')");
    expect(migrations).toContain('command_receipts_accepted_check');
    expect(migrations).toContain('command_receipts_operation_id_unique');
    // 契约写回：v5 登记与 F-008 实施注记（expectedRevision 载体/预览 result 形状）。
    expect(contractDoc).toContain('F-008 补充（写回登记，2026-10-10）：迁移 v5');
    expect(contractDoc).toContain('F-008 实施注记（写回登记，2026-10-10）');
    expect(contractDoc).toContain('payload.previewDigest');
    expect(contractDoc).toContain('policyRevision');
    expect(contractDoc).toContain('excludedDirNames');
    // F-014 已接线取消：baseline.cancel 随取消/停止核验（F-010/F-012）进入信封白名单。
    const commandsPort = readText('packages/core/src/ports/commands.ts');
    expect(commandsPort).toContain("'baseline.preview',");
    expect(commandsPort).toContain("'baseline.run',");
    expect(commandsPort).toContain("'baseline.cancel',");
  });

  it('CLI 顶层命令含计划、执行、workspace 与 git，契约记录基线子命令面', () => {
    const args = readText('packages/cli/src/app/args.ts');
    // P03-5 / F-012 追加 workspace（工作区状态展示与人工丢弃预览/确认），
    // 与 p03-1/p03-2/p03-3/app-cli-args 冻结面同步扩展。
    expect(args.replace(/\s+/g, ' ')).toContain(
      "APP_CLI_COMMANDS = [ 'project', 'config', 'receipt', 'events', 'baseline', 'phase', 'feature', 'task', 'execution', 'workspace', 'git', ] as const;",
    );
    expect(args).toContain('APP_CLI_COMMAND_IDS');
    // 契约记录 project init/overview 与 baseline 子命令面（F-015 已增补）。
    expect(contractDoc).toContain('shiploop project init');
    expect(contractDoc).toContain('shiploop project overview');
    expect(contractDoc).toContain('shiploop baseline run');
    expect(contractDoc).toContain('shiploop baseline cancel');
    for (const id of [
      "'baseline.preview'",
      "'baseline.run'",
      "'baseline.list'",
      "'baseline.status'",
      "'baseline.cancel'",
      "'baseline.evidence'",
    ]) {
      expect(args).toContain(id);
    }
  });

  it('退出码五档 0~4 冻结不变，契约沿用', () => {
    const hostOutput = readText('packages/cli/src/host/output.ts');
    expect(hostOutput).toContain('export const CLI_EXIT_OK = 0');
    expect(hostOutput).toContain('export const CLI_EXIT_REJECTED = 1');
    expect(hostOutput).toContain('export const CLI_EXIT_INPUT = 2');
    expect(hostOutput).toContain('export const CLI_EXIT_CONNECTION = 3');
    const appOutput = readText('packages/cli/src/app/output.ts');
    expect(appOutput).toContain('export const CLI_EXIT_OBSERVATION_INTERRUPTED = 4');
    expect(contractDoc).toContain('退出码');
    expect(contractDoc).toContain('observation_interrupted');
  });

  it('F-011/F-012 已接线握手能力视图，契约记录 v3 形状与集合扩张', () => {
    const lifecycle = readText('packages/host/src/contract/lifecycle.ts');
    expect(lifecycle).toContain('readonly application: ApplicationCapabilityView');
    expect(lifecycle).toContain('APPLICATION_COMMAND_CAPABILITIES');
    expect(lifecycle).toContain('APPLICATION_QUERY_CAPABILITIES');
    expect(lifecycle).toContain("transport: 'sse'");
    expect(lifecycle).toContain('CURRENT_HOST_CAPABILITIES');
    // 契约冻结 v3 握手视图与新增命令/查询。
    expect(contractDoc).toContain('11.3');
    expect(contractDoc).toContain('capabilities.application');
  });

  it('P02-1/P02-2 契约、交接与报告仍在库且被本文显式接续', () => {
    for (const path of [
      'docs/p02-1-host-lifecycle-contract.md',
      'docs/p02-1-writer-lock.md',
      'docs/p02-2-commands-events-contract.md',
      'docs/p01-3-application-contract.md',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path))).toBe(true);
    }
    expect(contractDoc).toContain('p02-1-host-lifecycle-contract.md');
    expect(contractDoc).toContain('p02-2-commands-events-contract.md');
    expect(contractDoc).toContain('p01-3-application-contract.md');
  });
});
