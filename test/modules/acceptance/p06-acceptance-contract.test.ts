import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  P06_ACCEPT_CONFIG_PATH,
  P06_CHECKLIST_PATH,
  P06_ENTRY_PATH,
  P06_EVIDENCE_CATEGORIES,
  P06_EXECUTION_TYPES,
  P06_FEATURES,
  P06_MCP_POLICY,
  P06_REQUIRED_CHECK_IDS,
  P06AcceptError,
  aggregateP06CheckResults,
  digestP06Checklist,
  evaluateP06Prerequisites,
  loadP06AcceptanceConfig,
  loadP06Checklist,
  loadP06EntryContract,
  summarizeP06Checklist,
  validateP06AcceptanceConfig,
  validateP06Checklist,
  validateP06EntryContract,
} from '../../../scripts/acceptance/p06-config.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rejected(action: () => unknown): P06AcceptError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(P06AcceptError);
    return error as P06AcceptError;
  }
  throw new Error('expected P06 contract rejection');
}

it('[case:p06-checklist-freezes-scenarios] 清单覆盖 P06-1～P06-6 的接入/配置/知识/增量/资源隔离场景与证据字段', () => {
  const checklist = loadP06Checklist(join(ROOT, P06_CHECKLIST_PATH));
  const config = loadP06AcceptanceConfig(join(ROOT, P06_ACCEPT_CONFIG_PATH));
  const summary = summarizeP06Checklist(checklist);

  expect(config.requiredChecks).toEqual([...P06_REQUIRED_CHECK_IDS]);
  expect(summary.required).toBeGreaterThanOrEqual(12);
  expect(summary.deferred).toBeGreaterThanOrEqual(1);
  expect(new Set(checklist.items.map(item => item.execution))).toEqual(new Set(P06_EXECUTION_TYPES));
  expect(new Set(checklist.items.flatMap(item => item.features))).toEqual(new Set(P06_FEATURES));
  expect(new Set(checklist.items.flatMap(item => item.fr))).toEqual(new Set(['FR-1', 'FR-2']));
  // 接入/配置/知识/增量/资源隔离与 stdio MCP、负例证据场景均被必需检查覆盖。
  const requiredIds = checklist.items.filter(item => item.group !== 'deferred').map(item => item.id);
  for (const id of ['P06-I01-BROWNFIELD-ONBOARDING', 'P06-I02-PROFILE-CHECK-BASELINE', 'P06-I03-KNOWLEDGE-MANIFEST', 'P06-I04-RESTRICTED-INCREMENT', 'P06-I05-RESOURCE-ISOLATION', 'P06-I06-STDIO-MCP-FAKE', 'P06-I07-FAIL-CLOSED-NEGATIVES']) {
    expect(requiredIds).toContain(id);
  }
  for (const item of checklist.items) {
    expect(item.layer).toBeTruthy();
    expect(item.acceptanceRefs.length).toBeGreaterThan(0);
    expect(item.assertions.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
    for (const evidence of item.evidence) expect(P06_EVIDENCE_CATEGORIES).toContain(evidence);
  }
  expect(config.fullRegression.defaultEnabled).toBe(false);
  expect(config.fullRegression.optInFlag).toBe('--full-regression');
  expect(config.reportScope.statuses).toEqual(['pass', 'fail', 'not_run']);
  expect(config.reportScope.notRunCountsAsPassed).toBe(false);
  expect(config.fakeIdentity).toEqual({ provider: 'fake-provider', model: 'fake-model', realModel: false, network: 'denied' });
  expect(config.tempResources).toEqual({ git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false });
  // 默认离线：无网络、无真实模型；stdio MCP 只允许本地无凭据 Fake server。
  expect(config.executionPolicy.offline).toEqual({ runtime: 'fake-or-scripted', network: 'denied', llmCalls: false });
  expect(config.mcpPolicy).toEqual(P06_MCP_POLICY);
  expect(config.mcpPolicy.acceptedTransport).toBe('stdio');
  expect(config.mcpPolicy.server).toBe('local-no-credential-fake');
  expect(config.mcpPolicy.realCredentials).toBe(false);
  expect(config.mcpPolicy.otherTransports).toBe('unsupported');
});

it('[case:p06-config-fail-closed] 拒绝未知/重复/删减检查、隐式 live、默认全仓、凭据字段和绝对路径', () => {
  const checklist = json(join(ROOT, P06_CHECKLIST_PATH));
  const config = json(join(ROOT, P06_ACCEPT_CONFIG_PATH));

  const duplicate = clone(checklist);
  duplicate.items.push(clone(duplicate.items[0]));
  expect(rejected(() => validateP06Checklist(duplicate)).kind).toBe('invalid_config');

  const unknown = clone(checklist);
  unknown.items[0].id = 'P06-UNKNOWN';
  expect(rejected(() => validateP06Checklist(unknown)).kind).toBe('invalid_config');

  const assertionRemoved = clone(checklist);
  assertionRemoved.items[0].assertions.pop();
  expect(rejected(() => validateP06Checklist(assertionRemoved)).kind).toBe('invalid_config');

  const executionRewritten = clone(checklist);
  executionRewritten.items[0].execution = 'live';
  expect(rejected(() => validateP06Checklist(executionRewritten)).kind).toBe('invalid_config');

  const unknownChecklistField = clone(checklist);
  unknownChecklistField.extra = 1;
  expect(rejected(() => validateP06Checklist(unknownChecklistField)).kind).toBe('invalid_config');

  const requiredRemoved = clone(config);
  requiredRemoved.requiredChecks.pop();
  expect(rejected(() => validateP06AcceptanceConfig(requiredRemoved)).kind).toBe('invalid_config');

  const implicitLive = clone(config);
  implicitLive.executionPolicy.live.authorizationRequired = false;
  expect(rejected(() => validateP06AcceptanceConfig(implicitLive)).kind).toBe('invalid_config');

  const fullByDefault = clone(config);
  fullByDefault.fullRegression.defaultEnabled = true;
  expect(rejected(() => validateP06AcceptanceConfig(fullByDefault)).kind).toBe('invalid_config');

  const credentialField = clone(config);
  credentialField.apiKey = 'x';
  expect(rejected(() => validateP06AcceptanceConfig(credentialField)).kind).toBe('invalid_config');

  const absoluteReportRoot = clone(config);
  absoluteReportRoot.reportRoot = '/Users/dev/artifacts';
  expect(rejected(() => validateP06AcceptanceConfig(absoluteReportRoot)).kind).toBe('invalid_config');

  const realMcpCredentials = clone(config);
  realMcpCredentials.mcpPolicy.realCredentials = true;
  expect(rejected(() => validateP06AcceptanceConfig(realMcpCredentials)).kind).toBe('invalid_config');

  const remoteTransport = clone(config);
  remoteTransport.mcpPolicy.otherTransports = 'http';
  expect(rejected(() => validateP06AcceptanceConfig(remoteTransport)).kind).toBe('invalid_config');
});

it('[case:p06-status-gates] not_run 和人工 pending 不计为通过，offline 不能替代 live，缺证据即 fail', () => {
  const checklist = loadP06Checklist(join(ROOT, P06_CHECKLIST_PATH));
  const offline = checklist.items.find(item => item.execution === 'offline' && item.group !== 'deferred')!;
  const live = checklist.items.find(item => item.execution === 'live' && item.group !== 'deferred')!;
  const manual = checklist.items.find(item => item.execution === 'manual' && item.group !== 'deferred')!;
  const deferred = checklist.items.find(item => item.group === 'deferred')!;
  const result = (checkId: string, executionMode: 'fake' | 'live' | 'manual', extra = {}) => ({
    checkId, status: 'pass' as const, executionMode,
    evidence: [...checklist.items.find(item => item.id === checkId)!.evidence],
    ...extra,
  });

  const requiredCount = checklist.items.filter(item => item.group !== 'deferred').length;
  expect(aggregateP06CheckResults(checklist, []).counts).toEqual({ pass: 0, fail: 0, not_run: requiredCount });
  expect(aggregateP06CheckResults(checklist, []).conclusion).toBe('fail');

  // offline 用 fake + 全证据通过；其余未运行仍使整体 fail，deferred 不计入必需计数。
  const offlinePass = aggregateP06CheckResults(checklist, [result(offline.id, 'fake')]);
  expect(offlinePass.checks.find(check => check.id === offline.id)?.status).toBe('pass');
  expect(offlinePass.counts).toEqual({ pass: 1, fail: 0, not_run: requiredCount - 1 });
  expect(offlinePass.conclusion).toBe('fail');
  expect(offlinePass.checks.find(check => check.id === deferred.id)?.status).toBe('not_run');
  expect(offlinePass.counts.not_run).toBe(requiredCount - 1);

  // live 不能被离线 fake 结果满足；manual pending 不能由机器代签。
  expect(aggregateP06CheckResults(checklist, [result(live.id, 'fake')]).checks.find(check => check.id === live.id)?.status).toBe('fail');
  expect(aggregateP06CheckResults(checklist, [result(manual.id, 'manual', { manualStatus: 'pending' })]).checks.find(check => check.id === manual.id)?.status).toBe('fail');
  expect(aggregateP06CheckResults(checklist, [result(manual.id, 'manual', { manualStatus: 'rejected' })]).checks.find(check => check.id === manual.id)?.status).toBe('fail');

  // 证据类别缺失即 fail，即使状态声明为 pass。
  const missingEvidence = { ...result(offline.id, 'fake'), evidence: result(offline.id, 'fake').evidence.slice(1) };
  expect(aggregateP06CheckResults(checklist, [missingEvidence]).checks.find(check => check.id === offline.id)?.status).toBe('fail');

  // 未知或重复结果拒绝。
  expect(rejected(() => aggregateP06CheckResults(checklist, [{ ...result(offline.id, 'fake'), checkId: 'P06-NOPE' }])).kind).toBe('invalid_config');
  expect(rejected(() => aggregateP06CheckResults(checklist, [result(offline.id, 'fake'), result(offline.id, 'fake')])).kind).toBe('invalid_config');

  // 全部必需项以正确模式与证据通过时才 pass。
  const allPass = checklist.items
    .filter(item => item.group !== 'deferred')
    .map(item => item.execution === 'manual'
      ? result(item.id, 'manual', { manualStatus: 'confirmed' })
      : result(item.id, item.execution === 'live' ? 'live' : 'fake'));
  expect(aggregateP06CheckResults(checklist, allPass).conclusion).toBe('pass');
  expect(aggregateP06CheckResults(checklist, allPass).counts).toEqual({ pass: requiredCount, fail: 0, not_run: 0 });
});

it('[case:p06-prerequisite-blocking] 前序 Feature 未交付或接口不满足时记阻塞/not_run，占位不放行', () => {
  const all = P06_FEATURES.map(feature => ({ feature, delivered: true, interfacesSatisfied: true }));
  const satisfied = evaluateP06Prerequisites(all);
  expect(satisfied.status).toBe('satisfied');
  expect(satisfied.blockedFeatures).toEqual([]);
  expect(satisfied.resultStatus).toBe('pass');

  const notDelivered = evaluateP06Prerequisites(all.map(entry => entry.feature === 'P06-4' ? { ...entry, delivered: false } : entry));
  expect(notDelivered.status).toBe('blocked');
  expect(notDelivered.resultStatus).toBe('not_run');
  expect(notDelivered.blockedFeatures).toEqual(['P06-4']);
  expect(notDelivered.reason).toContain('P06-4');

  // 接口不满足（占位实现）同样阻塞，不能降低门槛放行。
  const placeholder = evaluateP06Prerequisites(all.map(entry => entry.feature === 'P06-5' ? { ...entry, interfacesSatisfied: false } : entry));
  expect(placeholder.status).toBe('blocked');
  expect(placeholder.resultStatus).toBe('not_run');
  expect(placeholder.blockedFeatures).toEqual(['P06-5']);

  // 缺失输入按未交付处理。
  const missing = evaluateP06Prerequisites(all.slice(1));
  expect(missing.status).toBe('blocked');
  expect(missing.blockedFeatures).toContain('P06-1');

  // 未知/重复前序 Feature 拒绝。
  expect(rejected(() => evaluateP06Prerequisites([...all, { feature: 'P06-9', delivered: true }])).kind).toBe('invalid_config');
  expect(rejected(() => evaluateP06Prerequisites([...all, all[0]])).kind).toBe('invalid_config');
});

it('[case:p06-checklist-digest-stable] 清单变更产生稳定摘要并可在报告中追溯', () => {
  const checklist = loadP06Checklist(join(ROOT, P06_CHECKLIST_PATH));
  const digest = digestP06Checklist(checklist);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);

  // 同一内容重复加载摘要一致；键序变化不影响摘要。
  const reloaded = validateP06Checklist(json(join(ROOT, P06_CHECKLIST_PATH)));
  expect(digestP06Checklist(reloaded)).toBe(digest);
  const reordered = {
    ...checklist,
    items: checklist.items.map(item => Object.fromEntries(Object.entries(item).reverse()) as typeof item),
  };
  expect(digestP06Checklist(reordered)).toBe(digest);

  // 内容变化（断言/证据/执行类别/新增项）必须改变摘要。
  const assertionChanged = { ...checklist, items: checklist.items.map((item, index) => index === 0 ? { ...item, assertions: [...item.assertions.slice(0, -1), `${item.assertions[item.assertions.length - 1]} (修订)`] } : item) };
  expect(digestP06Checklist(assertionChanged)).not.toBe(digest);
  const evidenceChanged = { ...checklist, items: checklist.items.map((item, index) => index === 0 ? { ...item, evidence: item.evidence.slice(1) } : item) };
  expect(digestP06Checklist(evidenceChanged)).not.toBe(digest);
  const executionChanged = { ...checklist, items: checklist.items.map((item, index) => index === 0 ? { ...item, execution: 'live' as const } : item) };
  expect(digestP06Checklist(executionChanged)).not.toBe(digest);
  const appended = { ...checklist, items: [...checklist.items, checklist.items[checklist.items.length - 1]] };
  expect(digestP06Checklist(appended)).not.toBe(digest);
});

it('[case:p06-entry-contract] 入口契约冻结默认离线、前置阻塞、stdio Fake server 与显式全仓开关', () => {
  const entryPath = join(ROOT, P06_ENTRY_PATH);
  const entry = loadP06EntryContract(entryPath);

  expect(entry.phase).toBe('P06');
  expect(entry.requiredFeatures).toEqual([...P06_FEATURES]);
  expect(entry.defaultExecution).toEqual({ mode: 'offline', network: 'denied', llmCalls: false, fullRegression: false });
  expect(entry.explicitOptions.fullRegression).toBe('--full-regression');
  expect(entry.explicitOptions.live).toBe('--live-authorized');
  expect(entry.prerequisites.missingBehavior).toBe('blocked-not-run');
  expect(entry.prerequisites.placeholderAllowed).toBe(false);
  expect(entry.mcp.transport).toBe('stdio');
  expect(entry.mcp.server).toBe('local-no-credential-fake');
  expect(entry.mcp.otherTransports).toEqual(['http', 'sse']);
  expect(entry.mcp.otherTransportsStatus).toBe('unsupported');
  for (const field of ['scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'evidenceRefs', 'usageSource', 'cleanup']) {
    expect(entry.evidence.requiredFields).toContain(field);
  }
  expect(entry.evidence.statuses).toEqual(['pass', 'fail', 'not_run']);
  expect(entry.evidence.notRunCountsAsPassed).toBe(false);
  expect(entry.stepOrder[0]).toBe('p06-prerequisites');
  expect(entry.stepOrder[entry.stepOrder.length - 1]).toBe('p06-manual-gate');
  expect(existsSync(join(ROOT, entry.trustedIndexRoot))).toBe(true);

  const raw = json(entryPath);
  const unknownField = { ...raw, extra: true };
  expect(rejected(() => validateP06EntryContract(unknownField)).kind).toBe('invalid_config');

  const implicitModel = { ...raw, defaultExecution: { ...raw.defaultExecution, llmCalls: true } };
  expect(rejected(() => validateP06EntryContract(implicitModel)).kind).toBe('invalid_config');

  const networkAllowed = { ...raw, defaultExecution: { ...raw.defaultExecution, network: 'allowed' } };
  expect(rejected(() => validateP06EntryContract(networkAllowed)).kind).toBe('invalid_config');

  const fullByDefault = { ...raw, defaultExecution: { ...raw.defaultExecution, fullRegression: true } };
  expect(rejected(() => validateP06EntryContract(fullByDefault)).kind).toBe('invalid_config');

  const placeholderAllowed = { ...raw, prerequisites: { ...raw.prerequisites, placeholderAllowed: true } };
  expect(rejected(() => validateP06EntryContract(placeholderAllowed)).kind).toBe('invalid_config');

  const missingRecord = { ...raw, prerequisites: { ...raw.prerequisites, missingBehavior: 'ignore' } };
  expect(rejected(() => validateP06EntryContract(missingRecord)).kind).toBe('invalid_config');

  const remoteMcp = { ...raw, mcp: { ...raw.mcp, transport: 'http' } };
  expect(rejected(() => validateP06EntryContract(remoteMcp)).kind).toBe('invalid_config');

  const stepReordered = { ...raw, stepOrder: [...raw.stepOrder].reverse() };
  expect(rejected(() => validateP06EntryContract(stepReordered)).kind).toBe('invalid_config');

  const unknownStep = { ...raw, stepOrder: [...raw.stepOrder, 'p06-extra-gate'] };
  expect(rejected(() => validateP06EntryContract(unknownStep)).kind).toBe('invalid_config');
});
