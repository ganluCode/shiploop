/**
 * P04-8 / F-001 P04 阶段验收清单、配置和报告契约。
 * 只验证机器可读契约，不调用模型、网络或阶段入口。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  P04_ACCEPT_CONFIG_PATH,
  P04_CHECKLIST_PATH,
  P04_EVIDENCE_CATEGORIES,
  P04_EXECUTION_TYPES,
  P04_FR_IDS,
  P04_REQUIRED_CHECK_IDS,
  P04AcceptError,
  loadP04AcceptanceConfig,
  loadP04Checklist,
  summarizeP04Checklist,
  validateP04AcceptanceConfig,
  validateP04Checklist,
} from '../../../scripts/acceptance/p04-config.ts';
import { aggregateP04CheckResults } from '../../../scripts/acceptance/p04-report.ts';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '../../..'));
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rejected(action: () => unknown): P04AcceptError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(P04AcceptError);
    return error as P04AcceptError;
  }
  throw new Error('expected P04 contract rejection');
}

it('loads the frozen checklist and separates execution classes', () => {
  const checklist = loadP04Checklist(join(ROOT, P04_CHECKLIST_PATH));
  const config = loadP04AcceptanceConfig(join(ROOT, P04_ACCEPT_CONFIG_PATH));
  const summary = summarizeP04Checklist(checklist);
  expect(config.requiredChecks).toEqual([...P04_REQUIRED_CHECK_IDS]);
  expect(summary.required).toBe(16);
  expect(summary.deferred).toBe(2);
  expect(new Set(checklist.items.map((item) => item.execution))).toEqual(
    new Set(P04_EXECUTION_TYPES),
  );
  for (const fr of P04_FR_IDS) {
    expect(checklist.items.some((item) => item.fr.includes(fr))).toBe(true);
  }
  for (const item of checklist.items) {
    expect(item.assertions.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
    for (const category of item.evidence) expect(P04_EVIDENCE_CATEGORIES).toContain(category);
  }
});

it('rejects unknown, duplicate, removed, remapped, and illegal checklist entries', () => {
  const path = join(ROOT, P04_CHECKLIST_PATH);
  const baseline = readJson(path);
  const duplicate = clone(baseline);
  duplicate.items.push(clone(duplicate.items[0]));
  expect(rejected(() => validateP04Checklist(duplicate)).kind).toBe('invalid_config');

  const unknown = clone(baseline);
  unknown.items[0].id = 'P04-UNKNOWN-CHECK';
  expect(rejected(() => validateP04Checklist(unknown)).kind).toBe('invalid_config');

  const remapped = clone(baseline);
  remapped.items[0].fr = ['FR-4'];
  expect(rejected(() => validateP04Checklist(remapped)).kind).toBe('invalid_config');

  const illegalExecution = clone(baseline);
  illegalExecution.items[0].execution = 'mock';
  expect(rejected(() => validateP04Checklist(illegalExecution)).kind).toBe('invalid_config');
});

it('rejects absolute, escaping, credential, and business configuration fields', () => {
  const baseline = readJson(join(ROOT, P04_ACCEPT_CONFIG_PATH));
  for (const field of ['checklist', 'reportRoot']) {
    const draft = clone(baseline);
    draft[field] = field === 'checklist' ? '/tmp/p04.json' : '../outside';
    expect(rejected(() => validateP04AcceptanceConfig(draft)).kind).toBe('invalid_config');
  }
  const credential = clone(baseline);
  credential.credentials = { token: 'synthetic-only' };
  expect(rejected(() => validateP04AcceptanceConfig(credential)).kind).toBe('invalid_config');
  const business = clone(baseline);
  business.database = { file: 'production.db' };
  expect(rejected(() => validateP04AcceptanceConfig(business)).kind).toBe('invalid_config');
});

it('keeps not_run out of pass counts and enforces live/manual gates', () => {
  const checklist = loadP04Checklist(join(ROOT, P04_CHECKLIST_PATH));
  const offline = checklist.items.find((item) => item.execution === 'offline' && item.group !== 'deferred')!;
  const live = checklist.items.find((item) => item.execution === 'live' && item.group !== 'deferred')!;
  const manual = checklist.items.find((item) => item.execution === 'manual' && item.group !== 'deferred')!;
  const result = (checkId: string, executionMode: 'fake' | 'live', manualStatus?: 'pending' | 'confirmed') => ({
    checkId,
    status: 'pass' as const,
    executionMode,
    ...(manualStatus ? { manualStatus } : {}),
    assertions: [{ id: 'state', satisfied: true }],
    sideEffectVerified: true,
  });

  const offlinePass = aggregateP04CheckResults(checklist, [result(offline.id, 'fake')]);
  expect(offlinePass.counts.pass).toBe(1);
  expect(offlinePass.counts.not_run).toBe(15);
  expect(offlinePass.conclusion).toBe('fail');

  const liveFake = aggregateP04CheckResults(checklist, [result(live.id, 'fake')]);
  expect(liveFake.checks.find((check) => check.id === live.id)?.status).toBe('fail');

  const manualPending = aggregateP04CheckResults(checklist, [result(manual.id, 'fake', 'pending')]);
  expect(manualPending.checks.find((check) => check.id === manual.id)?.status).toBe('fail');

  const manualConfirmed = aggregateP04CheckResults(checklist, [result(manual.id, 'fake', 'confirmed')]);
  expect(manualConfirmed.checks.find((check) => check.id === manual.id)?.status).toBe('pass');
});
