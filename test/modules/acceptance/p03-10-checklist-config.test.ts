/**
 * P03-10 / F-002 P03 阶段验收机器可读检查清单与受校验配置。
 *
 * 覆盖验收标准：
 * - 清单覆盖 FR-1～FR-3 的正常与关键负例及 T02/T03/T04/T06/T07/T08/T13/T21/T24/
 *   T25/T26/T29/T31、T35～T37/T39；T38 仅报告结构、T40 仅通用恢复决策；每项有
 *   稳定 ID、必需断言与证据类别；
 * - 完成、预算耗尽、人工阻塞、最终检查失败、仅收尾重试分别列为必需纵向演示；
 *   单元测试、Feature 集成与阶段验收分层标注，覆盖按必需断言判定而非测试数量；
 * - 配置沿用 npm 和 P01/P02 版本约束（与 root package.json engines/packageManager
 *   核对），含有限步骤/总时间及输出上限、显式 Fake 身份、临时资源与报告范围；
 *   无效配置、重复或未知检查 ID、试图减少必需项（删断言/改映射/降层次/计入 deferred）
 *   均被拒绝；
 * - live/Pi、强沙箱及后序能力在清单中明确后置（not_run/postponed），不参与 P03
 *   已通过计数；配置是验收工具输入，拒绝业务版本表/第二套产品配置体系/凭据字段。
 *
 * 全部用例为纯数据校验，不启动 Host、不运行场景、不调用模型、不修改产品代码。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import {
  P03_ACCEPT_CONFIG_PATH,
  P03_ACCEPT_MAX_OUTPUT_BYTES,
  P03_ACCEPT_MIN_OUTPUT_BYTES,
  P03_ACCEPT_MIN_TIMEOUT_MS,
  P03_ACCEPT_MAX_TIMEOUT_MS,
  P03_CHECKLIST_PATH,
  P03_COUNT_RULE,
  P03_DEFERRED_IDS,
  P03_EVIDENCE_CATEGORIES,
  P03_FROZEN_ITEMS,
  P03_LAYERS,
  P03_REQUIRED_CHECK_IDS,
  P03AcceptError,
  loadP03AcceptanceConfig,
  loadP03Checklist,
  summarizeP03Checklist,
  validateP03AcceptanceConfig,
  validateP03Checklist,
} from '../../../scripts/acceptance/p03-config.ts';
import type { P03AcceptErrorKind } from '../../../scripts/acceptance/p03-config.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECKLIST_PATH = join(REPO_ROOT, P03_CHECKLIST_PATH);
const CONFIG_PATH = join(REPO_ROOT, P03_ACCEPT_CONFIG_PATH);
const CONTRACT_DOC = readFileSync(join(REPO_ROOT, 'docs', 'p03-10-f002-checklist.md'), 'utf-8');

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const path of trackedSandboxes) {
    rmSync(path, { recursive: true, force: true });
  }
});

function newSandbox(): string {
  const sandbox = createTempSandbox('shiploop-p03-10-checklist-', { outside: [REPO_ROOT] });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function expectRejected(
  mutate: (draft: Record<string, unknown>) => void,
  kind: P03AcceptErrorKind = 'invalid_config',
): P03AcceptError {
  const draft = clone(readJson(CONFIG_PATH)) as Record<string, unknown>;
  mutate(draft);
  try {
    validateP03AcceptanceConfig(draft);
  } catch (error) {
    expect(error).toBeInstanceOf(P03AcceptError);
    const acceptError = error as P03AcceptError;
    expect(acceptError.kind).toBe(kind);
    return acceptError;
  }
  throw new Error('预期 invalid_config 拒绝，但配置校验通过');
}

function expectChecklistRejected(mutate: (draft: Record<string, unknown>) => void): P03AcceptError {
  const draft = clone(readJson(CHECKLIST_PATH)) as Record<string, unknown>;
  mutate(draft);
  try {
    validateP03Checklist(draft);
  } catch (error) {
    expect(error).toBeInstanceOf(P03AcceptError);
    const acceptError = error as P03AcceptError;
    expect(acceptError.kind).toBe('invalid_config');
    return acceptError;
  }
  throw new Error('预期 invalid_config 拒绝，但清单校验通过');
}

function itemById(draft: Record<string, unknown>, id: string): Record<string, unknown> {
  const items = draft.items as Record<string, unknown>[];
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`清单缺少 ${id}`);
  return item;
}

it('[case:fr-coverage] 清单覆盖 FR-1～FR-3 正常与关键负例并标注验证层次', () => {
  const checklist = loadP03Checklist(CHECKLIST_PATH);
  const byFr = new Map<string, string[]>();
  for (const item of checklist.items) {
    expect(item.assertions.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
    for (const category of item.evidence) {
      expect(P03_EVIDENCE_CATEGORIES as readonly string[]).toContain(category);
    }
    expect(P03_LAYERS as readonly string[]).toContain(item.layer);
    for (const fr of item.fr) {
      byFr.set(fr, [...(byFr.get(fr) ?? []), item.id]);
    }
  }
  for (const fr of ['FR-1', 'FR-2', 'FR-3']) {
    expect(byFr.get(fr)?.length ?? 0).toBeGreaterThan(0);
  }
  // 每个 FR 至少各有一个正常项与一个关键负例项（ID 固定）。
  const ids = checklist.items.map((item) => item.id);
  expect(ids).toEqual(expect.arrayContaining([
    'P03-FR1-CLOSED-LOOP', 'P03-FR1-NEG-INTEGRITY',
    'P03-FR2-MATRIX', 'P03-FR2-NEG-GUARDRAILS',
    'P03-FR3-REPORT', 'P03-FR3-NEG-REPORT-INTEGRITY',
  ]));
  // 三层验证层次均有归属；覆盖按必需断言判定，不按测试数量判断。
  const summary = summarizeP03Checklist(checklist);
  expect(summary.layers.unit).toBeGreaterThan(0);
  expect(summary.layers['feature-integration']).toBeGreaterThan(0);
  expect(summary.layers['phase-acceptance']).toBeGreaterThan(0);
  expect(checklist.countRule).toBe(P03_COUNT_RULE);
  expect(CONTRACT_DOC).toContain('不按测试数量');
});

it('[case:acceptance-mapping] T 编号映射完整，T38/T40 限定范围不外推', () => {
  const checklist = loadP03Checklist(CHECKLIST_PATH);
  const requiredT = [
    'T02', 'T03', 'T04', 'T06', 'T07', 'T08', 'T13', 'T21',
    'T24', 'T25', 'T26', 'T29', 'T31', 'T35', 'T36', 'T37', 'T39',
  ];
  for (const ref of [...requiredT, 'T38', 'T40']) {
    const mapped = checklist.items.filter((item) => item.acceptanceRefs.includes(ref));
    expect(mapped.length, `验收编号 ${ref} 必须映射到至少一项检查`).toBeGreaterThan(0);
  }
  const t38 = checklist.items.find((item) => item.id === 'P03-T38');
  const t40 = checklist.items.find((item) => item.id === 'P03-T40');
  expect(t38?.coverage).toBe('partial');
  expect(t38?.coverageNote).toContain('仅报告结构');
  expect(t38?.coverageNote).toContain('P04/P07');
  expect(t40?.coverage).toBe('partial');
  expect(t40?.coverageNote).toContain('仅通用恢复决策');
  expect(t40?.coverageNote).toContain('P04');
  expect(CONTRACT_DOC).toContain('仅报告结构');
  expect(CONTRACT_DOC).toContain('仅通用恢复决策');
});

it('[case:vertical-demos] 五个必需纵向演示独立成项并进入必需检查', () => {
  const checklist = loadP03Checklist(CHECKLIST_PATH);
  const verticalIds = [
    'P03-VERT-COMPLETE',
    'P03-VERT-BUDGET-EXHAUSTED',
    'P03-VERT-MANUAL-BLOCK',
    'P03-VERT-FINAL-FAIL',
    'P03-VERT-RETRY-FINAL',
  ];
  for (const id of verticalIds) {
    const item = checklist.items.find((entry) => entry.id === id);
    expect(item, `${id} 必须是清单内的必需纵向演示`).toBeDefined();
    expect(item?.group).toBe('vertical');
    expect(item?.layer).toBe('phase-acceptance');
    expect(item?.assertions.length).toBeGreaterThan(0);
    expect(item?.acceptanceRefs.length).toBeGreaterThan(0);
    expect(P03_REQUIRED_CHECK_IDS).toContain(id);
  }
});

it('[case:config-valid] 真实配置通过校验且沿用 npm/P01/P02 版本约束', () => {
  const config = loadP03AcceptanceConfig(CONFIG_PATH);
  const pkg = readJson(join(REPO_ROOT, 'package.json')) as {
    engines: { node: string; npm: string };
    packageManager: string;
  };
  expect(config.configVersion).toBe(1);
  expect(config.requiredChecks).toEqual([...P03_REQUIRED_CHECK_IDS]);
  expect(config.checklist).toBe(P03_CHECKLIST_PATH);
  expect(config.reportRoot).toBe('artifacts/acceptance/p03');
  // 沿用 npm 与 P01/P02 冻结版本约束（与 root package.json 逐字段核对）。
  expect(config.toolchain.packageManager).toBe(pkg.packageManager);
  expect(config.toolchain.node).toBe(pkg.engines.node);
  expect(config.toolchain.npm).toBe(pkg.engines.npm);
  expect(config.toolchain.lockfile).toBe('package-lock.json');
  expect(() => readFileSync(join(REPO_ROOT, config.toolchain.lockfile))).not.toThrow();
  // 有限步骤/总时间与输出上限。
  for (const value of [config.timeouts.stepMs, config.timeouts.overallMs]) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(P03_ACCEPT_MIN_TIMEOUT_MS);
    expect(value).toBeLessThanOrEqual(P03_ACCEPT_MAX_TIMEOUT_MS);
  }
  expect(config.timeouts.overallMs).toBeGreaterThanOrEqual(config.timeouts.stepMs);
  expect(config.maxCommandOutputBytes).toBeGreaterThanOrEqual(P03_ACCEPT_MIN_OUTPUT_BYTES);
  expect(config.maxCommandOutputBytes).toBeLessThanOrEqual(P03_ACCEPT_MAX_OUTPUT_BYTES);
  // 显式 Fake 身份、临时资源与报告范围。
  expect(config.fakeIdentity.realModel).toBe(false);
  expect(config.fakeIdentity.network).toBe('denied');
  expect(config.fakeIdentity.provider).toBe('fake-provider');
  expect(config.fakeIdentity.model).toBe('fake-model');
  for (const value of Object.values(config.tempResources)) {
    if (typeof value === 'boolean') expect(value).toBe(false);
    else expect(value).toBe('temp');
  }
  expect(config.reportScope.deferredCountsAsPassed).toBe(false);
  expect(config.reportScope.statuses).toContain('not_run');
  expect(config.reportScope.includeEvidenceHash).toBe(true);
  expect(config.reportScope.includeManualChecklist).toBe(true);
});

it('[case:reject-invalid-config] 无效配置逐项拒绝', () => {
  expect(expectRejected((draft) => { draft.configVersion = 2; }).message).toContain('configVersion');
  expect(expectRejected((draft) => { draft.extra = 1; }).message).toContain('未知字段');
  // 不新增业务版本表或第二套产品配置体系。
  expect(expectRejected((draft) => { draft.schemaVersions = { sqliteMigrations: [1] }; }).message).toContain('业务配置');
  expect(expectRejected((draft) => { draft.migrations = []; }).message).toContain('业务配置');
  expect(expectRejected((draft) => { draft.settings = {}; }).message).toContain('业务配置');
  // 凭据字段拒绝。
  expect(expectRejected((draft) => { draft.token = 'x'; }).message).toContain('凭据');
  // 路径逃逸/绝对路径拒绝。
  expect(expectRejected((draft) => { draft.reportRoot = '/tmp/p03-report'; }).message).toContain('相对路径');
  expect(expectRejected((draft) => { draft.reportRoot = '../escape'; }).message).toContain('逃逸');
  // 非有限/越界预算与输出上限拒绝。
  expect(expectRejected((draft) => { (draft.timeouts as Record<string, unknown>).stepMs = 0; }).message).toContain('stepMs');
  expect(expectRejected((draft) => { (draft.timeouts as Record<string, unknown>).stepMs = Infinity; }).message).toContain('stepMs');
  expect(expectRejected((draft) => { (draft.timeouts as Record<string, unknown>).overallMs = '600000'; }).message).toContain('overallMs');
  expect(expectRejected((draft) => {
    (draft.timeouts as Record<string, unknown>).stepMs = 3_000_000;
    (draft.timeouts as Record<string, unknown>).overallMs = 2_000_000;
  }).message).toContain('overallMs');
  expect(expectRejected((draft) => { draft.maxCommandOutputBytes = 12; }).message).toContain('maxCommandOutputBytes');
  expect(expectRejected((draft) => { draft.maxCommandOutputBytes = P03_ACCEPT_MAX_OUTPUT_BYTES + 1; }).message).toContain('maxCommandOutputBytes');
  // 版本约束不得改写。
  expect(expectRejected((draft) => { (draft.toolchain as Record<string, unknown>).packageManager = 'pnpm@9.0.0'; }).message).toContain('toolchain');
  expect(expectRejected((draft) => { (draft.toolchain as Record<string, unknown>).node = '20.0.0'; }).message).toContain('toolchain');
  // 显式 Fake 身份不得冒充真实模型/live。
  expect(expectRejected((draft) => { (draft.fakeIdentity as Record<string, unknown>).realModel = true; }).message).toContain('fakeIdentity');
  expect(expectRejected((draft) => { (draft.fakeIdentity as Record<string, unknown>).model = 'gpt-real'; }).message).toContain('fakeIdentity');
  expect(expectRejected((draft) => { (draft.fakeIdentity as Record<string, unknown>).network = 'allowed'; }).message).toContain('fakeIdentity');
  // 临时资源不得复用或指向开发机路径。
  expect(expectRejected((draft) => { (draft.tempResources as Record<string, unknown>).reusePrevious = true; }).message).toContain('tempResources');
  expect(expectRejected((draft) => { (draft.tempResources as Record<string, unknown>).git = '/Users/dev/tmp'; }).message).toContain('tempResources');
  // not_run/deferred 不得计入已通过数。
  expect(expectRejected((draft) => { (draft.reportScope as Record<string, unknown>).deferredCountsAsPassed = true; }).message).toContain('reportScope');
  expect(expectRejected((draft) => { (draft.reportScope as Record<string, unknown>).statuses = ['pass']; }).message).toContain('reportScope');
});

it('[case:reject-check-ids] 重复/未知/deferred/缺失/重排检查 ID 逐项拒绝', () => {
  expect(expectRejected((draft) => {
    const checks = draft.requiredChecks as string[];
    checks[1] = checks[0];
  }).message).toContain('重复');
  expect(expectRejected((draft) => {
    const checks = draft.requiredChecks as string[];
    checks[0] = 'P03-UNKNOWN-CHECK';
  }).message).toContain('未知检查 ID');
  expect(expectRejected((draft) => {
    const checks = draft.requiredChecks as string[];
    checks[0] = 'P03-OOS-LIVE-PI';
  }).message).toContain('deferred');
  expect(expectRejected((draft) => {
    const checks = draft.requiredChecks as string[];
    checks.pop();
  }).message).toContain('必需检查');
  expect(expectRejected((draft) => {
    const checks = draft.requiredChecks as string[];
    [checks[0], checks[1]] = [checks[1], checks[0]];
  }).message).toContain('顺序固定');
});

it('[case:reject-reduced-checklist] 试图减少/改写清单必需项被拒绝', () => {
  // 移除必需项。
  expect(expectChecklistRejected((draft) => {
    draft.items = (draft.items as Record<string, unknown>[]).filter((item) => item.id !== 'P03-T39');
  }).message).toContain('被移除');
  // 删减必需断言。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T13');
    (item.assertions as string[]).pop();
  }).message).toContain('assertions');
  // 改写验收编号映射。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T13');
    item.acceptanceRefs = ['T02'];
  }).message).toContain('acceptanceRefs');
  // 改写 FR 映射。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T03');
    item.fr = ['FR-3'];
  }).message).toContain('fr');
  // 删减证据要求。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T08');
    item.evidence = ['git'];
  }).message).toContain('evidence');
  // 降级/升格验证层次。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T24');
    item.layer = 'phase-acceptance';
  }).message).toContain('layer');
  // 改写 T38/T40 覆盖限制说明或解除限定。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T40');
    item.coverageNote = '全部恢复能力';
  }).message).toContain('coverageNote');
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T38');
    item.coverage = undefined;
    item.coverageNote = undefined;
  }).message).toContain('coverage');
  // deferred 项不得改为计入通过，必需项不得降级为 deferred。
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-OOS-LIVE-PI');
    item.deferredStatus = 'pass';
  }).message).toContain('deferredStatus');
  expect(expectChecklistRejected((draft) => {
    const item = itemById(draft, 'P03-T06');
    item.deferredStatus = 'not_run';
  }).message).toContain('deferredStatus');
  // 新增未知项、重复 ID 拒绝。
  expect(expectChecklistRejected((draft) => {
    (draft.items as Record<string, unknown>[]).push({ id: 'P03-NEW-EXTRA' });
  }).message).toContain('未知检查 ID');
  expect(expectChecklistRejected((draft) => {
    const items = draft.items as Record<string, unknown>[];
    items.push(clone(items[0]));
  }).message).toContain('重复');
});

it('[case:deferred-not-counted] live/Pi、强沙箱及后序能力 not_run/postponed 且不计入已通过', () => {
  const checklist = loadP03Checklist(CHECKLIST_PATH);
  const config = loadP03AcceptanceConfig(CONFIG_PATH);
  const summary = summarizeP03Checklist(checklist);
  expect(summary.deferred).toBe(P03_DEFERRED_IDS.length);
  expect(summary.required).toBe(P03_REQUIRED_CHECK_IDS.length);
  expect(summary.total).toBe(summary.required + summary.deferred);
  for (const id of P03_DEFERRED_IDS) {
    expect(summary.countedChecks.includes(id)).toBe(false);
    expect(config.requiredChecks.includes(id)).toBe(false);
    expect(P03_FROZEN_ITEMS.map((item) => item.id)).toContain(id);
  }
  const statuses = summary.deferredChecks.map((entry) => entry.status);
  expect(statuses).toContain('not_run');
  expect(statuses).toContain('postponed');
  for (const status of statuses) {
    expect(['not_run', 'postponed']).toContain(status);
  }
  expect(CONTRACT_DOC).toContain('not_run');
});

it('[case:load-guard] 加载对缺失/损坏文件 fail-closed', () => {
  const sandbox = newSandbox();
  expect(() => loadP03Checklist(join(sandbox, 'missing.json'))).toThrow(P03AcceptError);
  expect(() => loadP03AcceptanceConfig(join(sandbox, 'missing.json'))).toThrow(P03AcceptError);
  const brokenChecklist = join(sandbox, 'broken-checklist.json');
  writeFileSync(brokenChecklist, '{ not json');
  expect(() => loadP03Checklist(brokenChecklist)).toThrow(P03AcceptError);
  const brokenConfig = join(sandbox, 'broken-config.json');
  writeFileSync(brokenConfig, '[]');
  let caught: unknown;
  try {
    loadP03AcceptanceConfig(brokenConfig);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(P03AcceptError);
  expect((caught as P03AcceptError).kind).toBe('invalid_config');
});
