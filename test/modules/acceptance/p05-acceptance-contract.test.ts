import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  P05_ACCEPT_CONFIG_PATH,
  P05_CHECKLIST_PATH,
  P05_EVIDENCE_CATEGORIES,
  P05_EXECUTION_TYPES,
  P05_FEATURES,
  P05_REQUIRED_CHECK_IDS,
  P05AcceptError,
  aggregateP05CheckResults,
  loadP05AcceptanceConfig,
  loadP05Checklist,
  summarizeP05Checklist,
  validateP05AcceptanceConfig,
  validateP05Checklist,
} from '../../../scripts/acceptance/p05-config.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rejected(action: () => unknown): P05AcceptError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(P05AcceptError);
    return error as P05AcceptError;
  }
  throw new Error('expected P05 contract rejection');
}

it('[case:p05-checklist-freezes-scenarios] 清单覆盖 P05-1 至 P05-9 的集成场景和证据字段', () => {
  const checklist = loadP05Checklist(join(ROOT, P05_CHECKLIST_PATH));
  const config = loadP05AcceptanceConfig(join(ROOT, P05_ACCEPT_CONFIG_PATH));
  const summary = summarizeP05Checklist(checklist);

  expect(config.requiredChecks).toEqual([...P05_REQUIRED_CHECK_IDS]);
  expect(summary.required).toBeGreaterThanOrEqual(12);
  expect(summary.deferred).toBeGreaterThanOrEqual(1);
  expect(new Set(checklist.items.map(item => item.execution))).toEqual(new Set(P05_EXECUTION_TYPES));
  expect(new Set(checklist.items.flatMap(item => item.features))).toEqual(new Set(P05_FEATURES));
  for (const item of checklist.items) {
    expect(item.layer).toBeTruthy();
    expect(item.acceptanceRefs.length).toBeGreaterThan(0);
    expect(item.assertions.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
    for (const evidence of item.evidence) expect(P05_EVIDENCE_CATEGORIES).toContain(evidence);
  }
  expect(config.fullRegression.defaultEnabled).toBe(false);
  expect(config.fullRegression.optInFlag).toBe('--full-regression');
  expect(config.reportScope.statuses).toEqual(['pass', 'fail', 'not_run']);
});

it('[case:p05-config-fail-closed] 拒绝未知/重复/删减检查、隐式 live 和默认全仓', () => {
  const checklist = json(join(ROOT, P05_CHECKLIST_PATH));
  const config = json(join(ROOT, P05_ACCEPT_CONFIG_PATH));

  const duplicate = clone(checklist);
  duplicate.items.push(clone(duplicate.items[0]));
  expect(rejected(() => validateP05Checklist(duplicate)).kind).toBe('invalid_config');

  const unknown = clone(checklist);
  unknown.items[0].id = 'P05-UNKNOWN';
  expect(rejected(() => validateP05Checklist(unknown)).kind).toBe('invalid_config');

  const assertionRemoved = clone(checklist);
  assertionRemoved.items[0].assertions.pop();
  expect(rejected(() => validateP05Checklist(assertionRemoved)).kind).toBe('invalid_config');

  const requiredRemoved = clone(config);
  requiredRemoved.requiredChecks.pop();
  expect(rejected(() => validateP05AcceptanceConfig(requiredRemoved)).kind).toBe('invalid_config');

  const implicitLive = clone(config);
  implicitLive.executionPolicy.liveAuthorizationRequired = false;
  expect(rejected(() => validateP05AcceptanceConfig(implicitLive)).kind).toBe('invalid_config');

  const fullByDefault = clone(config);
  fullByDefault.fullRegression.defaultEnabled = true;
  expect(rejected(() => validateP05AcceptanceConfig(fullByDefault)).kind).toBe('invalid_config');
});

it('[case:p05-status-gates] not_run 和人工 pending 不得计为通过，offline 不能替代 live', () => {
  const checklist = loadP05Checklist(join(ROOT, P05_CHECKLIST_PATH));
  const offline = checklist.items.find(item => item.execution === 'offline' && item.group !== 'deferred')!;
  const live = checklist.items.find(item => item.execution === 'live' && item.group !== 'deferred')!;
  const manual = checklist.items.find(item => item.execution === 'manual' && item.group !== 'deferred')!;
  const result = (checkId: string, executionMode: 'fake' | 'live' | 'manual', extra = {}) => ({
    checkId, status: 'pass' as const, executionMode,
    evidence: [...checklist.items.find(item => item.id === checkId)!.evidence],
    ...extra,
  });

  expect(aggregateP05CheckResults(checklist, []).counts.not_run).toBe(
    checklist.items.filter(item => item.group !== 'deferred').length,
  );
  expect(aggregateP05CheckResults(checklist, [result(live.id, 'fake')]).checks.find(check => check.id === live.id)?.status).toBe('fail');
  expect(aggregateP05CheckResults(checklist, [result(manual.id, 'manual', { manualStatus: 'pending' })]).checks.find(check => check.id === manual.id)?.status).toBe('fail');
  expect(aggregateP05CheckResults(checklist, [result(offline.id, 'fake')]).counts.pass).toBe(1);
  expect(aggregateP05CheckResults(checklist, [result(offline.id, 'fake')]).conclusion).toBe('fail');
});

it('[case:p05-manual-entry-contract] 入口和 macOS 清单冻结证据字段、默认离线和显式全仓开关', () => {
  const entry = json(join(ROOT, 'acceptance/p05.entry.json'));
  const contract = readFileSync(join(ROOT, 'docs/p05-acceptance.md'), 'utf8');
  const walkthrough = readFileSync(join(ROOT, 'docs/acceptance/p05-owner-walkthrough.md'), 'utf8');

  expect(entry.phase).toBe('P05');
  expect(entry.requiredFeatures).toEqual([...P05_FEATURES]);
  expect(entry.defaultExecution).toEqual({ mode: 'offline', network: 'denied', llmCalls: false, fullRegression: false });
  expect(entry.explicitOptions.fullRegression).toBe('--full-regression');
  for (const field of ['scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'evidenceRefs', 'usageSource', 'cleanup']) {
    expect(entry.evidence.requiredFields).toContain(field);
  }
  for (const token of ['I01', 'I09', 'not_run', '受测完整 SHA', '用量来源', '清理事实', '--full-regression', '不能由模型']) {
    expect(contract).toContain(token);
  }
  for (const token of ['git rev-parse HEAD', '退出码', 'runtime-usage', 'pending', 'rejected', '不包含凭据', 'macOS']) {
    expect(walkthrough).toContain(token);
  }
  expect(walkthrough.includes('/Users/')).toBe(false);
  expect(walkthrough.includes('/home/')).toBe(false);
  expect(walkthrough.match(/[A-Za-z]:\\\\/)).toBeNull();
});
