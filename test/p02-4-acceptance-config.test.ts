/**
 * F-010 版本化 P02 验收配置、稳定场景清单及参数校验（契约 §2.1 / §3.8）。
 *
 * 覆盖验收标准：
 * - acceptance/p02.config.json 固定必需检查 → 实际场景入口映射、报告根
 *   （artifacts/acceptance/p02/<run-id>/）与有限步骤/整体预算；配置不含开发机
 *   绝对路径；
 * - 拒绝未知配置版本、未知/缺失/重复检查 ID、移除或关闭必需项、非法 run-id、
 *   非正/无限超时及报告路径逃逸；合法配置完整映射 F-001（契约 §2.1）清单；
 * - CLI/env 仅提供已记录的报告位置和有限预算覆盖，不提供跳过认证/负例/verify
 *   的开关；错误配置/参数在启动 Host 或场景之前得到明确非零结果（真实子进程
 *   预检入口验证）；
 * - 表驱动覆盖正常/拒绝分支；配置不解析用户认证（凭据字段/凭据形状拒绝）、
 *   不要求后续 Phase（未知字段拒绝）、不把后续未实现能力（P02-OOS-*）列为
 *   默认通过。
 *
 * 全部用例不启动 Host、不运行场景、不调用模型；子进程只运行纯配置预检入口。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P02_ACCEPT_CONFIG_PATH,
  P02_ACCEPT_CONFIG_VERSION,
  P02_ACCEPT_ENV_REPORT_DIR,
  P02_ACCEPT_ENV_RUN_ID,
  P02_ACCEPT_ENV_STEP_TIMEOUT_MS,
  P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
  P02_ACCEPT_MAX_TIMEOUT_MS,
  P02_ACCEPT_MIN_TIMEOUT_MS,
  P02AcceptError,
  loadP02AcceptanceConfig,
  parseP02AcceptArgs,
  readP02AcceptEnvOverrides,
  resolveP02AcceptInvocation,
  validateP02AcceptanceConfig,
} from '../scripts/acceptance/p02-config.ts';
import type {
  P02AcceptanceConfig,
  P02AcceptErrorKind,
} from '../scripts/acceptance/p02-config.ts';
import {
  P02_DEFAULT_REPORT_ROOT,
  P02_REQUIRED_CHECK_IDS,
  P02_REQUIRED_CHECKS,
  scanTextForCredentialShapes,
} from '../scripts/acceptance/p02-report.ts';
import {
  PUBLIC_EVENT_SCHEMA_VERSION,
  SETTINGS_EXPORT_FORMAT_VERSION,
  SETTINGS_SCHEMA_VERSION,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from 'shiploop-core/protocol';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONFIG_PATH = join(REPO_ROOT, P02_ACCEPT_CONFIG_PATH);
const CONTRACT_DOC_PATH = join(REPO_ROOT, 'docs', 'p02-4-acceptance-contract.md');
const CONTRACT_DOC = readFileSync(CONTRACT_DOC_PATH, 'utf-8');
const PREFLIGHT_ENTRY = join(REPO_ROOT, 'scripts', 'acceptance', 'p02-config.ts');

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const path of trackedSandboxes) {
    rmSync(path, { recursive: true, force: true });
  }
});

function newSandbox(): string {
  const sandbox = createTempSandbox('shiploop-p02-4-config-', {
    outside: [REPO_ROOT, homedir()],
  });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

/* ------------------------------------------------------------------ *
 * 合法配置夹具（稳定场景清单；与仓库内真实配置一致）
 * ------------------------------------------------------------------ */

const SCENARIO_FIXTURE: readonly Record<string, unknown>[] = [
  { id: 'verify', kind: 'command', entry: 'npm run verify', checkIds: ['P02-ENG-VERIFY'] },
  {
    id: 'dual-cli',
    kind: 'test',
    entry: 'test/p02-4-dual-cli-acceptance.test.ts',
    checkIds: ['P02-FR1-UNIQUE-HOST', 'P02-FR1-SHARED-STATE', 'P02-FR1-BASELINE-OK'],
  },
  {
    id: 'idempotency',
    kind: 'test',
    entry: 'test/p02-4-idempotency-acceptance.test.ts',
    checkIds: ['P02-FR2-DUPLICATE-INIT', 'P02-FR2-COMMAND-CONFLICT'],
  },
  {
    id: 'repo-preservation',
    kind: 'test',
    entry: 'test/p02-4-repo-preservation-acceptance.test.ts',
    checkIds: ['P02-FR2-SOURCE-PRESERVED'],
  },
  {
    id: 'auth-reject',
    kind: 'test',
    entry: 'test/p02-4-negative-acceptance.test.ts',
    checkIds: ['P02-FR2-AUTH-REJECT'],
  },
  {
    id: 'restart',
    kind: 'test',
    entry: 'test/p02-4-restart-acceptance.test.ts',
    checkIds: ['P02-FR2-CLIENT-EXIT', 'P02-FR1-RESTART-QUERY'],
  },
  {
    id: 'baseline-failure',
    kind: 'test',
    entry: 'test/p02-4-baseline-failure-acceptance.test.ts',
    checkIds: ['P02-FR2-BASELINE-FAILURE'],
  },
  {
    id: 'controller',
    kind: 'test',
    entry: 'test/p02-4-acceptance-controller.test.ts',
    checkIds: ['P02-PHASE-FIXTURE'],
  },
  {
    id: 'report-aggregation',
    kind: 'test',
    entry: 'test/p02-4-report-aggregation.test.ts',
    checkIds: ['P02-PHASE-NOT-RUN'],
  },
  {
    id: 'acceptance-report',
    kind: 'test',
    entry: 'test/p02-4-acceptance-report.test.ts',
    checkIds: ['P02-PHASE-REPORT'],
  },
  {
    id: 'clean-replay',
    kind: 'test',
    entry: 'test/p02-4-clean-replay.test.ts',
    checkIds: ['P02-ENG-CLEAN-REPLAY'],
  },
];

function baseRaw(): Record<string, unknown> {
  return {
    configVersion: 1,
    reportRoot: 'artifacts/acceptance/p02',
    requiredChecks: [...P02_REQUIRED_CHECK_IDS],
    scenarios: structuredClone(SCENARIO_FIXTURE),
    timeouts: { verifyMs: 60_000, scenarioMs: 60_000, overallMs: 300_000 },
    maxCommandOutputBytes: 65_536,
    plan: {
      phaseId: '2026-10-04-23-19-52_shiploop-p02-hostcli',
      stepId: 'p02-acceptance',
      title: 'P02-4 P02 双客户端与初始化验收',
      scope: '控制器回归沙箱',
      version: '0.2',
      contractDoc: 'docs/p02-4-acceptance-contract.md',
    },
    priorBaselines: [
      {
        phase: 'p02-host-lifecycle',
        branch: 'feat/2026-10-04-23-19-52_p02-1-host',
        tipCommit: '7ae5f39bb3d30a82a37a592d938a8e3d933f8c02',
      },
    ],
    schemaVersions: {
      settingsSchema: 2,
      settingsExportFormat: 1,
      sqliteMigrations: [1, 2, 3, 4, 5],
      applicationWireSchema: 4,
      eventEnvelopeSchema: 1,
    },
  };
}

function expectConfigError(fn: () => unknown, messagePart: string): P02AcceptError {
  try {
    fn();
  } catch (error) {
    expect(error, `应抛出 P02AcceptError，实际：${String(error)}`).toBeInstanceOf(P02AcceptError);
    expect((error as P02AcceptError).kind).toBe('invalid_config');
    expect((error as P02AcceptError).message).toContain(messagePart);
    return error as P02AcceptError;
  }
  throw new Error(`应抛出 P02AcceptError(invalid_config)：${messagePart}`);
}

function expectUsageError(fn: () => unknown, messagePart: string): P02AcceptError {
  try {
    fn();
  } catch (error) {
    expect(error, `应抛出 P02AcceptError，实际：${String(error)}`).toBeInstanceOf(P02AcceptError);
    expect((error as P02AcceptError).kind).toBe('invalid_usage');
    expect((error as P02AcceptError).message).toContain(messagePart);
    return error as P02AcceptError;
  }
  throw new Error(`应抛出 P02AcceptError(invalid_usage)：${messagePart}`);
}

/* ------------------------------------------------------------------ *
 * 真实配置：固定映射、报告根与预算
 * ------------------------------------------------------------------ */

describe('F-010 真实 acceptance/p02.config.json 完整映射 F-001 清单', () => {
  const config = loadP02AcceptanceConfig(REAL_CONFIG_PATH);

  it('必需检查 ID 与 F-009 冻结清单、契约 §2.1 逐项一致（完整映射 F-001）', () => {
    expect(config.configVersion).toBe(P02_ACCEPT_CONFIG_VERSION);
    expect(config.configVersion).toBe(1);
    expect(config.requiredChecks).toEqual([...P02_REQUIRED_CHECK_IDS]);

    // 契约正文出现的每个 P02 必需检查 ID 都被配置覆盖，且不夹带任何额外 ID。
    const docIds = new Set(
      [...CONTRACT_DOC.matchAll(/P02-(?:ENG|FR1|FR2|PHASE)-[A-Z0-9-]+/g)].map((m) => m[0]),
    );
    expect([...config.requiredChecks].sort()).toEqual([...docIds].sort());
  });

  it('稳定场景清单把每个必需检查映射到冻结的真实场景入口（不静默关闭）', () => {
    const flattened = config.scenarios.flatMap((scenario) => [...scenario.checkIds]);
    expect(flattened).toEqual([...P02_REQUIRED_CHECK_IDS]);

    const frozenEntry = new Map(P02_REQUIRED_CHECKS.map((d) => [d.id, d.testEntry]));
    for (const scenario of config.scenarios) {
      expect(scenario.entry).toBe(frozenEntry.get(scenario.checkIds[0] as string));
      for (const checkId of scenario.checkIds) {
        expect(scenario.entry).toBe(frozenEntry.get(checkId));
      }
    }
    const ids = config.scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('报告根为仓库内相对路径，默认报告落在 artifacts/acceptance/p02/<run-id>/', () => {
    expect(config.reportRoot).toBe(P02_DEFAULT_REPORT_ROOT);
    expect(config.reportRoot).toBe('artifacts/acceptance/p02');
    const runDir = resolve(REPO_ROOT, config.reportRoot, '20261001T120000Z-abcdef01');
    expect(runDir).toBe(join(REPO_ROOT, 'artifacts', 'acceptance', 'p02', '20261001T120000Z-abcdef01'));
  });

  it('步骤与整体预算全部为有限正整数毫秒', () => {
    for (const value of Object.values(config.timeouts)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(config.timeouts.overallMs).toBeGreaterThanOrEqual(config.timeouts.verifyMs);
    expect(config.timeouts.overallMs).toBeGreaterThanOrEqual(config.timeouts.scenarioMs);
  });
});

describe('F-010 配置内容边界（无绝对路径 / 不解析认证 / 不依赖后续 Phase）', () => {
  const rawText = readFileSync(REAL_CONFIG_PATH, 'utf-8');
  const raw = JSON.parse(rawText) as Record<string, unknown>;

  it('配置不写入开发机绝对路径', () => {
    const collect = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        expect(value.startsWith('/'), `${path} 不得以 / 开头：${value}`).toBe(false);
        expect(/^[A-Za-z]:[\\/]/.test(value), `${path} 不得是盘符路径：${value}`).toBe(false);
        expect(value.includes('\\'), `${path} 不得含反斜杠：${value}`).toBe(false);
        expect(value.includes(homedir()), `${path} 不得含用户 HOME：${value}`).toBe(false);
      } else if (Array.isArray(value)) {
        value.forEach((entry, index) => collect(entry, `${path}[${index}]`));
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          collect(entry, `${path}.${key}`);
        }
      }
    };
    collect(raw, 'config');
  });

  it('配置不解析用户认证：无凭据字段、无凭据形状', () => {
    expect(scanTextForCredentialShapes(rawText)).toEqual([]);
    // 顶层键恰好是当前阶段所需集合，不含任何认证/后续 Phase 字段。
    expect(Object.keys(raw).sort()).toEqual(
      [
        'configVersion',
        'maxCommandOutputBytes',
        'plan',
        'priorBaselines',
        'reportRoot',
        'requiredChecks',
        'scenarios',
        'schemaVersions',
        'timeouts',
      ].sort(),
    );
  });

  it('不把后续未实现能力列为默认通过：无 P02-OOS-*、无状态/开关字段', () => {
    expect(rawText).not.toContain('P02-OOS');
    for (const scenario of configScenarios(raw)) {
      expect(Object.keys(scenario).sort()).toEqual(['checkIds', 'entry', 'id', 'kind']);
    }
  });

  it('只引用当前阶段计划，Schema 版本与产品常量交叉一致', () => {
    const plan = raw.plan as Record<string, unknown>;
    expect(plan.phaseId).toBe('2026-10-04-23-19-52_shiploop-p02-hostcli');
    expect(plan.stepId).toBe('p02-acceptance');
    expect(plan.contractDoc).toBe('docs/p02-4-acceptance-contract.md');
    expect(existsSync(join(REPO_ROOT, 'docs', 'p02-4-acceptance-contract.md'))).toBe(true);

    const schemaVersions = raw.schemaVersions as Record<string, unknown>;
    expect(schemaVersions.settingsSchema).toBe(SETTINGS_SCHEMA_VERSION);
    expect(schemaVersions.settingsExportFormat).toBe(SETTINGS_EXPORT_FORMAT_VERSION);
    expect(schemaVersions.applicationWireSchema).toBe(WIRE_MESSAGE_SCHEMA_VERSION);
    expect(schemaVersions.eventEnvelopeSchema).toBe(PUBLIC_EVENT_SCHEMA_VERSION);
    expect(schemaVersions.sqliteMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);

    for (const baseline of raw.priorBaselines as Record<string, string>[]) {
      expect(CONTRACT_DOC).toContain(baseline.tipCommit.slice(0, 7));
    }
  });
});

function configScenarios(raw: Record<string, unknown>): Record<string, unknown>[] {
  return raw.scenarios as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ *
 * 配置校验拒绝分支（表驱动）
 * ------------------------------------------------------------------ */

type ConfigCase = readonly [string, (raw: Record<string, unknown>) => void, string];

const CONFIG_REJECTIONS: readonly ConfigCase[] = [
  // 未知配置版本。
  ['未知 configVersion 0', (r) => { r.configVersion = 0; }, '未知 configVersion'],
  ['未知 configVersion 2', (r) => { r.configVersion = 2; }, '未知 configVersion'],
  ['configVersion 字符串', (r) => { r.configVersion = '1'; }, '未知 configVersion'],
  ['configVersion 缺失', (r) => { delete r.configVersion; }, '未知 configVersion'],
  // 后续 Phase / 认证 / 默认通过开关一律拒绝（未知字段）。
  ['后续 Phase 字段 work', (r) => { r.work = {}; }, '含未知字段'],
  ['后续 Phase 字段 phases', (r) => { r.phases = []; }, '含未知字段'],
  ['阶段外能力 outOfScope 默认通过', (r) => { r.outOfScope = [{ id: 'P02-OOS-PI-LIVE', status: 'pass' }]; }, '含未知字段'],
  ['认证字段 token', (r) => { r.token = 'x'; }, '不解析用户认证'],
  ['认证字段 authorization', (r) => { r.authorization = 'Bearer x'; }, '不解析用户认证'],
  ['认证字段 credentials', (r) => { r.credentials = {}; }, '不解析用户认证'],
  // 报告路径逃逸。
  ['reportRoot 逃逸 ..', (r) => { r.reportRoot = '../escape'; }, 'reportRoot'],
  ['reportRoot 绝对路径', (r) => { r.reportRoot = '/abs/path'; }, 'reportRoot'],
  ['reportRoot 盘符路径', (r) => { r.reportRoot = 'C:\\temp'; }, 'reportRoot'],
  ['reportRoot 中段 ..', (r) => { r.reportRoot = 'artifacts/../../etc'; }, 'reportRoot'],
  ['reportRoot 空段', (r) => { r.reportRoot = 'artifacts//p02'; }, 'reportRoot'],
  ['reportRoot . 段', (r) => { r.reportRoot = './artifacts'; }, 'reportRoot'],
  ['reportRoot NUL', (r) => { r.reportRoot = 'artifacts\0/p02'; }, 'reportRoot'],
  // 必需检查：移除/关闭/重复/未知/重排。
  ['移除一个必需检查', (r) => { r.requiredChecks = (r.requiredChecks as string[]).slice(1); }, '不得移除/关闭'],
  ['重复检查 ID', (r) => {
    const checks = [...(r.requiredChecks as string[])];
    checks[1] = checks[0] as string;
    r.requiredChecks = checks;
  }, '重复检查 ID'],
  ['未知检查 ID', (r) => {
    const checks = [...(r.requiredChecks as string[])];
    checks[1] = 'P02-FAKE-CHECK';
    r.requiredChecks = checks;
  }, '未知检查 ID'],
  ['阶段外能力冒充必需检查', (r) => {
    const checks = [...(r.requiredChecks as string[])];
    checks[1] = 'P02-OOS-PI-LIVE';
    r.requiredChecks = checks;
  }, '阶段外能力'],
  ['重排必需检查', (r) => { r.requiredChecks = [...(r.requiredChecks as string[])].reverse(); }, '顺序固定'],
  ['必需检查非字符串', (r) => {
    const checks = [...(r.requiredChecks as unknown[])];
    checks[1] = 42;
    r.requiredChecks = checks;
  }, '检查 ID'],
  ['requiredChecks 非数组', (r) => { r.requiredChecks = 'P02-ENG-VERIFY'; }, 'requiredChecks'],
  // 稳定场景清单：缺失/重复/改写入口/关闭开关。
  ['scenarios 缺失', (r) => { delete r.scenarios; }, 'scenarios'],
  ['scenarios 空数组', (r) => { r.scenarios = []; }, 'scenarios'],
  ['场景移除必需检查映射', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { checkIds: string[] }).checkIds = [];
    (scenarios[1] as { checkIds: string[] }).checkIds = (scenarios[1] as { checkIds: string[] }).checkIds.slice(1);
    r.scenarios = scenarios;
  }, '至少一个检查'],
  ['场景遗漏必需检查', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    scenarios.pop();
    r.scenarios = scenarios;
  }, '未映射到任何场景'],
  ['场景重复检查 ID', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[1] as { checkIds: string[] }).checkIds = ['P02-FR1-UNIQUE-HOST', 'P02-FR1-SHARED-STATE'];
    (scenarios[0] as { checkIds: string[] }).checkIds = ['P02-ENG-VERIFY', 'P02-FR1-UNIQUE-HOST'];
    r.scenarios = scenarios;
  }, '重复检查 ID'],
  ['场景未知检查 ID', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { checkIds: string[] }).checkIds = ['P02-FAKE-CHECK'];
    r.scenarios = scenarios;
  }, '未知检查 ID'],
  ['场景改写真实入口（伪入口冒充）', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { entry: string }).entry = 'echo ok';
    r.scenarios = scenarios;
  }, '与冻结场景入口不一致'],
  ['场景把检查改映射到别的文件', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { entry: string }).entry = 'test/p02-4-acceptance-report.test.ts';
    r.scenarios = scenarios;
  }, '与冻结场景入口不一致'],
  ['场景 kind 与入口不符', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { kind: string }).kind = 'test';
    r.scenarios = scenarios;
  }, 'kind'],
  ['场景 kind 非法', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { kind: string }).kind = 'shell';
    r.scenarios = scenarios;
  }, 'kind'],
  ['场景 id 重复', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[1] as { id: string }).id = 'verify';
    r.scenarios = scenarios;
  }, '场景 id 重复'],
  ['场景 id 非法', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as { id: string }).id = 'Verify';
    r.scenarios = scenarios;
  }, '场景 id'],
  ['场景 enabled:false 试图关闭', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as Record<string, unknown>).enabled = false;
    r.scenarios = scenarios;
  }, '含未知字段'],
  ['场景 required:false 试图降级', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as Record<string, unknown>).required = false;
    r.scenarios = scenarios;
  }, '含未知字段'],
  ['场景 defaultStatus:pass 试图默认通过', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    (scenarios[0] as Record<string, unknown>).defaultStatus = 'pass';
    r.scenarios = scenarios;
  }, '含未知字段'],
  ['场景顺序重排', (r) => {
    const scenarios = structuredClone(r.scenarios) as Record<string, unknown>[];
    const first = scenarios.shift() as Record<string, unknown>;
    scenarios.push(first);
    r.scenarios = scenarios;
  }, '顺序'],
  // 预算：非正/无限/非整数/未知键。
  ['timeouts 缺失', (r) => { delete r.timeouts; }, 'timeouts'],
  ['timeouts 非对象', (r) => { r.timeouts = 60_000; }, 'timeouts'],
  ['timeouts 未知键', (r) => { r.timeouts = { verifyMs: 60_000, scenarioMs: 60_000, overallMs: 300_000, skipMs: 1 }; }, '含未知字段'],
  ['timeouts.verifyMs 为 0', (r) => { r.timeouts = { verifyMs: 0, scenarioMs: 60_000, overallMs: 300_000 }; }, '有限毫秒'],
  ['timeouts.scenarioMs 为负', (r) => { r.timeouts = { verifyMs: 60_000, scenarioMs: -5, overallMs: 300_000 }; }, '有限毫秒'],
  ['timeouts.overallMs 无限', (r) => { r.timeouts = { verifyMs: 60_000, scenarioMs: 60_000, overallMs: Number.POSITIVE_INFINITY }; }, '有限毫秒'],
  ['timeouts NaN', (r) => { r.timeouts = { verifyMs: Number.NaN, scenarioMs: 60_000, overallMs: 300_000 }; }, '有限毫秒'],
  ['timeouts 非整数', (r) => { r.timeouts = { verifyMs: 60_000.5, scenarioMs: 60_000, overallMs: 300_000 }; }, '有限毫秒'],
  ['timeouts 字符串数字', (r) => { r.timeouts = { verifyMs: '60000', scenarioMs: 60_000, overallMs: 300_000 }; }, '有限毫秒'],
  ['timeouts 超上限', (r) => { r.timeouts = { verifyMs: 60_000, scenarioMs: 60_000, overallMs: P02_ACCEPT_MAX_TIMEOUT_MS + 1 }; }, '有限毫秒'],
  ['整体预算小于步骤预算', (r) => { r.timeouts = { verifyMs: 60_000, scenarioMs: 60_000, overallMs: 1_000 }; }, 'overallMs'],
  // 输出上限。
  ['maxCommandOutputBytes 为 0', (r) => { r.maxCommandOutputBytes = 0; }, 'maxCommandOutputBytes'],
  ['maxCommandOutputBytes 超上限', (r) => { r.maxCommandOutputBytes = 1e9; }, 'maxCommandOutputBytes'],
  ['maxCommandOutputBytes 非整数', (r) => { r.maxCommandOutputBytes = '262144'; }, 'maxCommandOutputBytes'],
  // 计划与基线。
  ['plan 缺字段', (r) => { delete (r.plan as Record<string, unknown>).stepId; }, 'plan.stepId'],
  ['plan.contractDoc 绝对路径', (r) => { (r.plan as Record<string, unknown>).contractDoc = '/Users/dev/doc.md'; }, 'plan.contractDoc'],
  ['plan 认证字段', (r) => { (r.plan as Record<string, unknown>).authToken = 'x'; }, '不解析用户认证'],
  ['priorBaselines 空', (r) => { r.priorBaselines = []; }, 'priorBaselines'],
  ['priorBaselines 非法 commit', (r) => {
    r.priorBaselines = [{ phase: 'p', branch: 'b', tipCommit: 'not-a-commit' }];
  }, 'tipCommit'],
  // Schema 版本。
  ['schemaVersions 缺字段', (r) => { delete (r.schemaVersions as Record<string, unknown>).eventEnvelopeSchema; }, 'schemaVersions.eventEnvelopeSchema'],
  ['sqliteMigrations 非递增', (r) => {
    r.schemaVersions = { settingsSchema: 2, settingsExportFormat: 1, sqliteMigrations: [2, 1], applicationWireSchema: 3, eventEnvelopeSchema: 1 };
  }, 'sqliteMigrations'],
  ['schemaVersions 未知键', (r) => {
    r.schemaVersions = { settingsSchema: 2, settingsExportFormat: 1, sqliteMigrations: [1], applicationWireSchema: 3, eventEnvelopeSchema: 1, piLive: 1 };
  }, '含未知字段'],
];

describe('F-010 配置校验拒绝分支（表驱动）', () => {
  it.each(CONFIG_REJECTIONS)('拒绝：%s', (_label, mutate, messagePart) => {
    const raw = baseRaw();
    mutate(raw);
    expectConfigError(() => validateP02AcceptanceConfig(raw), messagePart);
  });

  it('拒绝非对象配置', () => {
    for (const bad of [null, [], 'x', 42, true]) {
      expectConfigError(() => validateP02AcceptanceConfig(bad), '必须是对象');
    }
  });

  it('拒绝不可解析/不存在的配置文件', () => {
    const sandbox = newSandbox();
    expectConfigError(() => loadP02AcceptanceConfig(join(sandbox, 'missing.json')), '不存在');
    const broken = join(sandbox, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf-8');
    expectConfigError(() => loadP02AcceptanceConfig(broken), '无法解析');
  });

  it('合法夹具配置通过校验并回填冻结顺序', () => {
    const config = validateP02AcceptanceConfig(baseRaw());
    expect(config.requiredChecks).toEqual([...P02_REQUIRED_CHECK_IDS]);
    expect(config.scenarios.flatMap((s) => [...s.checkIds])).toEqual([...P02_REQUIRED_CHECK_IDS]);
  });
});

/* ------------------------------------------------------------------ *
 * CLI / env 参数：仅报告位置与有限预算覆盖（表驱动）
 * ------------------------------------------------------------------ */

describe('F-010 CLI/env 参数正常分支', () => {
  it('无覆盖时为空覆盖集', () => {
    expect(parseP02AcceptArgs([]).overrides).toEqual({});
    expect(parseP02AcceptArgs([]).help).toBe(false);
    expect(readP02AcceptEnvOverrides({})).toEqual({});
  });

  it('接受已记录的报告位置与有限预算覆盖', () => {
    const parsed = parseP02AcceptArgs([
      '--run-id', '20261001T120000Z-abcdef01',
      '--report-dir', 'out/p02-reports',
      '--step-timeout-ms', '120000',
      '--verify-timeout-ms', '600000',
    ]);
    expect(parsed.overrides).toEqual({
      runId: '20261001T120000Z-abcdef01',
      reportDir: 'out/p02-reports',
      stepTimeoutMs: 120_000,
      verifyTimeoutMs: 600_000,
    });
  });

  it('允许绝对报告覆盖位置（已记录的报告位置覆盖，不产生越界 run 目录）', () => {
    const parsed = parseP02AcceptArgs(['--report-dir', '/tmp/p02-reports']);
    expect(parsed.overrides.reportDir).toBe('/tmp/p02-reports');
  });

  it('环境变量覆盖生效且 CLI 优先于环境变量', () => {
    const env = {
      [P02_ACCEPT_ENV_RUN_ID]: '20261001T000000Z-env00000',
      [P02_ACCEPT_ENV_REPORT_DIR]: 'out/from-env',
      [P02_ACCEPT_ENV_STEP_TIMEOUT_MS]: '1000',
      [P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS]: '2000',
    };
    const envOverrides = readP02AcceptEnvOverrides(env);
    expect(envOverrides).toEqual({
      runId: '20261001T000000Z-env00000',
      reportDir: 'out/from-env',
      stepTimeoutMs: 1_000,
      verifyTimeoutMs: 2_000,
    });
    const resolution = resolveP02AcceptInvocation({
      argv: ['--run-id', '20261001T120000Z-abcdef01'],
      env,
      configPath: REAL_CONFIG_PATH,
      repoRoot: REPO_ROOT,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok && resolution.invocation !== null) {
      expect(resolution.invocation.overrides.runId).toBe('20261001T120000Z-abcdef01');
      expect(resolution.invocation.overrides.stepTimeoutMs).toBe(1_000);
    }
  });

  it('接受预算边界值', () => {
    expect(
      parseP02AcceptArgs(['--step-timeout-ms', String(P02_ACCEPT_MIN_TIMEOUT_MS)]).overrides.stepTimeoutMs,
    ).toBe(P02_ACCEPT_MIN_TIMEOUT_MS);
    expect(
      parseP02AcceptArgs(['--verify-timeout-ms', String(P02_ACCEPT_MAX_TIMEOUT_MS)]).overrides.verifyTimeoutMs,
    ).toBe(P02_ACCEPT_MAX_TIMEOUT_MS);
  });

  it('--help 单独使用返回帮助标记', () => {
    expect(parseP02AcceptArgs(['--help']).help).toBe(true);
    expect(parseP02AcceptArgs(['-h']).help).toBe(true);
  });
});

type ArgsCase = readonly [string, readonly string[], string];

const ARGS_REJECTIONS: readonly ArgsCase[] = [
  // 不提供跳过认证/负例/verify 的开关。
  ['--skip-verify', ['--skip-verify'], '不提供跳过认证/负例/verify 的开关'],
  ['--skip-auth', ['--skip-auth'], '不提供跳过认证/负例/verify 的开关'],
  ['--skip-negative', ['--skip-negative'], '不提供跳过认证/负例/verify 的开关'],
  ['--no-verify', ['--no-verify'], '不提供跳过认证/负例/verify 的开关'],
  ['--only', ['--only', 'verify'], '不提供跳过认证/负例/verify 的开关'],
  ['--exclude', ['--exclude', 'P02-FR2-AUTH-REJECT'], '不提供跳过认证/负例/verify 的开关'],
  // 其他未知参数（含配置路径覆盖）一律拒绝：仅报告位置与预算覆盖。
  ['--config', ['--config', 'other.json'], '未知参数'],
  ['位置参数', ['extra'], '未知参数'],
  ['--unknown', ['--unknown'], '未知参数'],
  // 缺值。
  ['--run-id 缺值', ['--run-id'], '需要参数值'],
  ['--report-dir 缺值', ['--report-dir'], '需要参数值'],
  ['--step-timeout-ms 缺值', ['--step-timeout-ms'], '需要参数值'],
  // 非法 run-id（路径逃逸）。
  ['run-id 含 /', ['--run-id', 'a/b'], 'run-id'],
  ['run-id ..', ['--run-id', '..'], 'run-id'],
  ['run-id 前导 .', ['--run-id', '.hidden'], 'run-id'],
  ['run-id 前导 -', ['--run-id', '-x'], 'run-id'],
  ['run-id 空', ['--run-id', ''], 'run-id'],
  ['run-id 过长', ['--run-id', 'x'.repeat(129)], 'run-id'],
  ['run-id 反斜杠', ['--run-id', 'a\\b'], 'run-id'],
  ['run-id NUL', ['--run-id', 'x\0y'], 'run-id'],
  // 报告路径逃逸。
  ['report-dir 逃逸 ..', ['--report-dir', '../out'], '禁止路径逃逸'],
  ['report-dir 中段 ..', ['--report-dir', 'a/../b'], '禁止路径逃逸'],
  ['report-dir 根', ['--report-dir', '/'], '禁止路径逃逸'],
  ['report-dir 空', ['--report-dir', ''], '禁止路径逃逸'],
  ['report-dir ..', ['--report-dir', '..'], '禁止路径逃逸'],
  ['report-dir .', ['--report-dir', '.'], '禁止路径逃逸'],
  ['report-dir 空段', ['--report-dir', 'a//b'], '禁止路径逃逸'],
  ['report-dir 反斜杠', ['--report-dir', 'a\\b'], '禁止路径逃逸'],
  ['report-dir NUL', ['--report-dir', 'x\0y'], '禁止路径逃逸'],
  // 非正/非法预算。
  ['--step-timeout-ms 0', ['--step-timeout-ms', '0'], '整数毫秒'],
  ['--step-timeout-ms -1', ['--step-timeout-ms', '-1'], '整数毫秒'],
  ['--verify-timeout-ms 空', ['--verify-timeout-ms', ''], '整数毫秒'],
  ['--verify-timeout-ms Infinity', ['--verify-timeout-ms', 'Infinity'], '整数毫秒'],
  ['--verify-timeout-ms 1e999', ['--verify-timeout-ms', '1e999'], '整数毫秒'],
  ['--step-timeout-ms 小数', ['--step-timeout-ms', '1.5'], '整数毫秒'],
  ['--step-timeout-ms 非数字', ['--step-timeout-ms', 'abc'], '整数毫秒'],
  ['--verify-timeout-ms 超上限', ['--verify-timeout-ms', String(P02_ACCEPT_MAX_TIMEOUT_MS + 1)], '整数毫秒'],
  // --help 不与其他参数混用。
  ['--help 混用', ['--help', '--run-id', 'x'], '--help'],
];

describe('F-010 CLI 参数拒绝分支（表驱动）', () => {
  it.each(ARGS_REJECTIONS)('拒绝：%s', (_label, args, messagePart) => {
    expectUsageError(() => parseP02AcceptArgs(args), messagePart);
  });
});

type EnvCase = readonly [string, Record<string, string>, string];

const ENV_REJECTIONS: readonly EnvCase[] = [
  ['未记录的开关环境变量', { SHIPLOOP_ACCEPT_P02_SKIP_VERIFY: '1' }, '不提供跳过认证/负例/verify 的开关'],
  ['未记录的配置环境变量', { SHIPLOOP_ACCEPT_P02_CONFIG: 'x.json' }, '未记录的环境变量'],
  ['未记录的跳过负例开关', { SHIPLOOP_ACCEPT_P02_SKIP_NEGATIVE: '1' }, '不提供跳过认证/负例/verify 的开关'],
  ['非法 run-id', { [P02_ACCEPT_ENV_RUN_ID]: 'a/b' }, 'run-id'],
  ['空 run-id', { [P02_ACCEPT_ENV_RUN_ID]: '' }, 'run-id'],
  ['非法 report-dir', { [P02_ACCEPT_ENV_REPORT_DIR]: '../out' }, '禁止路径逃逸'],
  ['非正 step 预算', { [P02_ACCEPT_ENV_STEP_TIMEOUT_MS]: '0' }, '整数毫秒'],
  ['非法 verify 预算', { [P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS]: 'inf' }, '整数毫秒'],
  ['无限 verify 预算', { [P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS]: 'Infinity' }, '整数毫秒'],
];

describe('F-010 环境变量拒绝分支（表驱动）', () => {
  it.each(ENV_REJECTIONS)('拒绝：%s', (_label, env, messagePart) => {
    expectUsageError(() => readP02AcceptEnvOverrides(env), messagePart);
  });
});

/* ------------------------------------------------------------------ *
 * 错误配置/参数在启动 Host 或场景之前得到明确非零结果
 * ------------------------------------------------------------------ */

describe('F-010 预检：错误配置/参数先于 Host 与场景得到非零结果', () => {
  it('配置文件缺失 → invalid_config 且 exitCode 非零（无任何启动）', () => {
    const resolution = resolveP02AcceptInvocation({
      argv: [],
      env: {},
      configPath: join(newSandbox(), 'missing.json'),
      repoRoot: REPO_ROOT,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.exitCode).not.toBe(0);
      expect(resolution.errorKind).toBe('invalid_config');
      expect(resolution.invocation).toBeUndefined();
    }
  });

  it('配置内容非法 → invalid_config 且 exitCode 非零', () => {
    const sandbox = newSandbox();
    const badConfig = join(sandbox, 'bad.json');
    writeFileSync(badConfig, JSON.stringify({ ...baseRaw(), configVersion: 99 }), 'utf-8');
    const resolution = resolveP02AcceptInvocation({
      argv: [],
      env: {},
      configPath: badConfig,
      repoRoot: REPO_ROOT,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.exitCode).not.toBe(0);
      expect(resolution.errorKind).toBe('invalid_config');
    }
  });

  it('非法参数 → invalid_usage 且 exitCode 非零', () => {
    const resolution = resolveP02AcceptInvocation({
      argv: ['--skip-verify'],
      env: {},
      configPath: REAL_CONFIG_PATH,
      repoRoot: REPO_ROOT,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.exitCode).not.toBe(0);
      expect(resolution.errorKind).toBe('invalid_usage');
    }
  });

  it('合法调用返回完整已校验计划（默认报告根 + 覆盖合并）', () => {
    const resolution = resolveP02AcceptInvocation({
      argv: ['--report-dir', 'out/reports'],
      env: { [P02_ACCEPT_ENV_RUN_ID]: '20261001T120000Z-abcdef01' },
      configPath: REAL_CONFIG_PATH,
      repoRoot: REPO_ROOT,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok && resolution.invocation !== null) {
      expect(resolution.invocation.config.requiredChecks).toEqual([...P02_REQUIRED_CHECK_IDS]);
      expect(resolution.invocation.reportRoot).toBe('out/reports');
      expect(resolution.invocation.overrides.runId).toBe('20261001T120000Z-abcdef01');
    }
  });

  it('--help 不要求配置存在（用法展示先于一切）', () => {
    const resolution = resolveP02AcceptInvocation({
      argv: ['--help'],
      env: {},
      configPath: join(newSandbox(), 'missing.json'),
      repoRoot: REPO_ROOT,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.help).toBe(true);
      expect(resolution.invocation).toBeNull();
    }
  });

  it('真实预检入口子进程：非法参数/环境变量退出码非零且零副作用', () => {
    const run = (
      args: readonly string[],
      env: Record<string, string> = {},
    ): { status: number | null; stdout: string; stderr: string } =>
      spawnSync(process.execPath, [PREFLIGHT_ENTRY, ...args], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf-8',
        timeout: 30_000,
      });

    const skipped = run(['--skip-verify']);
    expect(skipped.status).toBe(1);
    expect(skipped.stderr).toContain('不提供跳过认证/负例/verify 的开关');

    const badRunId = run(['--run-id', '../evil']);
    expect(badRunId.status).toBe(1);
    expect(badRunId.stderr).toContain('run-id');

    const badEnv = run([], { SHIPLOOP_ACCEPT_P02_STEP_TIMEOUT_MS: '0' });
    expect(badEnv.status).toBe(1);
    expect(badEnv.stderr).toContain('整数毫秒');

    const ok = run([]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('预检通过');
    expect(ok.stdout).toContain('artifacts/acceptance/p02');
  });

  it('真实预检入口子进程：坏配置在启动任何场景之前退出 1（复制布局，独立沙箱）', () => {
    const sandbox = newSandbox();
    mkdirSync(join(sandbox, 'scripts', 'acceptance'), { recursive: true });
    mkdirSync(join(sandbox, 'acceptance'), { recursive: true });
    for (const file of ['p02-config.ts', 'p02-report.ts']) {
      const source = readFileSync(join(REPO_ROOT, 'scripts', 'acceptance', file), 'utf-8');
      writeFileSync(join(sandbox, 'scripts', 'acceptance', file), source, 'utf-8');
    }
    writeFileSync(
      join(sandbox, 'acceptance', 'p02.config.json'),
      JSON.stringify({ ...baseRaw(), configVersion: 42 }),
      'utf-8',
    );

    const result = spawnSync(process.execPath, [join(sandbox, 'scripts', 'acceptance', 'p02-config.ts')], {
      cwd: sandbox,
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未知 configVersion');
    // 零副作用：没有报告目录、没有 Host/场景产物。
    expect(existsSync(join(sandbox, 'artifacts'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 类型导出存在性（供 F-011 控制器复用的契约面）
 * ------------------------------------------------------------------ */

describe('F-010 校验模块契约面', () => {
  it('错误种类只覆盖配置/用法（不承载业务状态语义）', () => {
    const error = new P02AcceptError('invalid_config', 'x', 'y');
    const kind: P02AcceptErrorKind = error.kind;
    expect(['invalid_config', 'invalid_usage']).toContain(kind);
  });

  it('真实配置经严格校验后与文件内容同源（无隐式改写）', () => {
    const fromFile = loadP02AcceptanceConfig(REAL_CONFIG_PATH);
    const raw = JSON.parse(readFileSync(REAL_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    expect(fromFile.reportRoot).toBe(raw.reportRoot);
    expect(fromFile.scenarios).toEqual(raw.scenarios);
    expect(fromFile.timeouts).toEqual(raw.timeouts);
  });
});
