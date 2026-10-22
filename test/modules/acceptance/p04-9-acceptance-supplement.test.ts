/**
 * P04-9 / F-011：把持久派发补充项纳入既有 P04 验收工具与报告。
 *
 * 只验证工具契约：清单/配置冻结扩展、可信测试索引发现与去重、P04-9 报告映射、
 * 缺索引/损坏/旧八项报告的 fail-closed。全部使用注入执行器与临时目录，不执行
 * 真实 accept:p04、verify、全仓测试或 live。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { collectP04TrustedTests, runP04Acceptance } from '../../../scripts/acceptance/p04-accept.ts';
import {
  P04_ACCEPT_CONFIG_PATH,
  P04_CHECKLIST_PATH,
  P04_REQUIRED_CHECK_IDS,
  P04_SUPPLEMENT_CHECK_IDS,
  loadP04AcceptanceConfig,
  loadP04Checklist,
} from '../../../scripts/acceptance/p04-config.ts';
import { verifyP04ReportDirectory } from '../../../scripts/acceptance/p04-report.ts';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMIT = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const PASS: P02BoundedRunOutcome = { kind: 'exit', exitCode: 0, signal: null, durationMs: 1,
  timedOut: false, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, spawnError: null, stoppedVerified: true };

const ORIGINAL_REQUIRED = [
  'P04-FR1-FAILURE-MATRIX', 'P04-FR2-BOUNDED-ENTRY', 'P04-FR3-LIVE-GUARD', 'P04-FR4-MANUAL-GATE',
  'P04-T35', 'P04-T36', 'P04-T37', 'P04-T39', 'P04-T40', 'P04-T41', 'P04-T42', 'P04-T43', 'P04-T44',
  'P04-VERT-OFFLINE-FAIL-CLOSED', 'P04-VERT-LIVE-ZERO-CALL', 'P04-VERT-MANUAL-BLOCK',
];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function probeExec(command: string, args: readonly string[]): string {
  const key = `${command} ${args.join(' ')}`;
  if (key === 'git rev-parse HEAD') return COMMIT;
  if (key === 'git status --porcelain') return '';
  if (key === 'git rev-parse HEAD^{tree}') return 'b'.repeat(40);
  if (key === 'git branch --show-current') return 'feat/p04/p04-dispatch-foundation';
  if (command === 'node') return process.version;
  if (command === 'npm') return '10.9.3';
  return 'probe-value';
}

/** 复制真实入口契约到临时仓库，只写入合成索引，不复制测试实现。 */
function trustedRepo(): { repo: string; sample: string } {
  const repo = tempDir('p049-index-');
  for (const file of ['package.json', 'package-lock.json', 'acceptance/p04.config.json', 'acceptance/p04.checklist.json',
    'acceptance/p04.entry.json', 'scripts/acceptance/p04-accept.ts', 'scripts/acceptance/p04-config.ts',
    'scripts/acceptance/p04-report.ts', 'scripts/acceptance/p04-steps.ts', 'scripts/acceptance/p04-integration-report.ts',
    'scripts/verify.ts', 'scripts/run-tests.ts']) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    cpSync(join(ROOT, file), join(repo, file));
  }
  const sample = 'test/modules/acceptance/sample.test.ts';
  mkdirSync(dirname(join(repo, sample)), { recursive: true });
  writeFileSync(join(repo, sample), 'sample');
  const root = join(repo, 'test/index/phases/P04/features');
  for (let number = 1; number <= 9; number++) {
    const feature = `P04-${number}`;
    const ids = number === 9
      ? ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008', 'F-009', 'F-010', 'F-011']
      : ['F-001'];
    const tasks = join(root, feature, 'tasks');
    mkdirSync(tasks, { recursive: true });
    for (const id of ids) {
      writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ schema_version: 2, task_id: id,
        projects: [{ id: 'shiploop', tests: [{ file: sample, all: true }] }] }));
    }
    if (number === 9) {
      writeFileSync(join(root, feature, 'feature.json'), JSON.stringify({ schema_version: 1, kind: 'feature', phase: 'P04',
        feature, scope: 'synthetic',
        tasks: ids.map(id => ({ task_id: id, index: `test/index/phases/P04/features/${feature}/tasks/${id}.json` })) }));
    }
  }
  return { repo, sample };
}

it('[case:supplement-checklist-frozen] 原有十六项保留，P04-9 六项作为必需补充追加并可校验', () => {
  const checklist = loadP04Checklist(join(ROOT, P04_CHECKLIST_PATH));
  const config = loadP04AcceptanceConfig(join(ROOT, P04_ACCEPT_CONFIG_PATH));
  const required = checklist.items.filter(item => item.group !== 'deferred').map(item => item.id);

  expect(required.slice(0, ORIGINAL_REQUIRED.length)).toEqual(ORIGINAL_REQUIRED);
  expect(required.slice(ORIGINAL_REQUIRED.length)).toEqual([...P04_SUPPLEMENT_CHECK_IDS]);
  expect(config.requiredChecks).toEqual([...P04_REQUIRED_CHECK_IDS]);
  expect(P04_REQUIRED_CHECK_IDS.slice(0, ORIGINAL_REQUIRED.length)).toEqual(ORIGINAL_REQUIRED);

  const supplement = checklist.items.filter(item => item.group === 'supplement');
  expect(supplement.map(item => item.acceptanceRefs)).toEqual([
    ['P04-9-AC1'], ['P04-9-AC2'], ['P04-9-AC3'], ['P04-9-AC4'], ['P04-9-AC5'], ['P04-9-AC6'],
  ]);
  for (const item of supplement) {
    expect(item.execution).toBe('offline');
    expect(item.layer).toBe('feature-integration');
    expect(item.assertions.length).toBeGreaterThan(0);
    // SQLite/竞争/恢复证据是清单要求，不能用命令退出替代。
    expect(item.evidence).toContain('sqlite');
    expect(item.fr.length).toBeGreaterThan(0);
  }
  expect(checklist.items.filter(item => item.group === 'deferred')).toHaveLength(2);
});

it('[case:trusted-index-discovery] 入口发现 P04-9 的逐 Task 索引、Feature 合集并去重', () => {
  const selection = collectP04TrustedTests(ROOT);
  expect(selection.features.map(feature => feature.feature)).toEqual(
    ['P04-1', 'P04-2', 'P04-3', 'P04-4', 'P04-5', 'P04-6', 'P04-7', 'P04-8', 'P04-9'],
  );
  const supplement = selection.features.find(feature => feature.feature === 'P04-9')!;
  expect(supplement.manifests).toEqual(['test/index/phases/P04/features/P04-9/feature.json']);
  expect(supplement.indexes).toContain('test/index/phases/P04/features/P04-9/tasks/F-011.json');
  expect(supplement.indexes).toHaveLength(11);
  expect(supplement.files).toContain('test/modules/execution/dispatch/p04-9-f010-dispatch-vertical.test.ts');
  expect(supplement.files).toContain('test/modules/acceptance/p04-9-acceptance-supplement.test.ts');
  expect(new Set(selection.files).size).toBe(selection.files.length);
  expect(selection.inputs).toContain('test/index/phases/P04/features/P04-9/feature.json');
  for (const file of selection.files) expect(existsSync(join(ROOT, file)), file).toBe(true);
});

it('[case:index-fail-closed] 缺 P04-9、损坏索引或 Feature 合集不一致时在执行前拒绝', () => {
  const missing = trustedRepo();
  rmSync(join(missing.repo, 'test/index/phases/P04/features/P04-9'), { recursive: true });
  expect(() => collectP04TrustedTests(missing.repo)).toThrow(/Feature 集合不匹配/);

  const corrupt = trustedRepo();
  writeFileSync(join(corrupt.repo, 'test/index/phases/P04/features/P04-9/tasks/F-002.json'), '{not-json');
  expect(() => collectP04TrustedTests(corrupt.repo)).toThrow();

  const empty = trustedRepo();
  writeFileSync(join(empty.repo, 'test/index/phases/P04/features/P04-9/tasks/F-003.json'),
    JSON.stringify({ schema_version: 2, task_id: 'F-003', projects: [{ id: 'shiploop', tests: [] }] }));
  expect(() => collectP04TrustedTests(empty.repo)).toThrow(/空测试索引/);

  const mismatch = trustedRepo();
  const manifestPath = join(mismatch.repo, 'test/index/phases/P04/features/P04-9/feature.json');
  const manifest = readJson(manifestPath);
  manifest.tasks = manifest.tasks.filter((task: { task_id: string }) => task.task_id !== 'F-011');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => collectP04TrustedTests(mismatch.repo)).toThrow(/Feature 索引与 Task 索引不一致/);
});

it('[case:handoff-doc] 交接文档记录持久结构、资源职责、恢复限制、设计映射与未运行范围', () => {
  const handoff = readFileSync(join(ROOT, 'docs/p04-9-f011-acceptance-handoff.md'), 'utf8');
  for (const token of ['提交引用', 'run_dispatch_intents', 'run_dispatch_claims', 'execution_slot_claims',
    '生产额度 1', 'TaskClaimReceipt.dispatch', 'capacity_unsupported', 'P05',
    'core-design/04', 'core-design/11', 'core-design/12', 'core-design/15',
    'not_run', '负责人确认', 'P04 未放行', 'test-sauycijp.log']) {
    expect(handoff).toContain(token);
  }
  const contract = readFileSync(join(ROOT, 'docs/p04-acceptance.md'), 'utf8');
  for (const token of ['P04-P9-AC1', 'AC6', 'schemaVersion=2', 'requiredChecks', 'task_union']) {
    expect(contract).toContain(token);
  }
  const config = loadP04AcceptanceConfig(join(ROOT, P04_ACCEPT_CONFIG_PATH));
  expect(existsSync(join(ROOT, config.plan.contractDoc))).toBe(true);
});

it('[case:supplement-not-run] 入口报告保留 P04-9 映射但保持 not_run，旧八项报告被拒绝', async () => {
  const reportRoot = tempDir('p049-entry-report-');
  const result = await runP04Acceptance({
    repoRoot: ROOT, reportRoot, runId: 'p049-supplement-0001', exec: probeExec,
    runProcess: async () => PASS,
  });
  expect(result.reportWritten, result.problems.join('\n')).toBe(true);
  expect(result.phaseAccepted).toBe(false);
  expect(result.exitCode).not.toBe(0);

  const report = readJson(join(result.runDir!, 'report.json'));
  expect(report.checks).toHaveLength(P04_REQUIRED_CHECK_IDS.length);
  expect(report.counts.total).toBe(P04_REQUIRED_CHECK_IDS.length);
  expect(report.conclusion).toBe('fail');
  for (const checkId of P04_SUPPLEMENT_CHECK_IDS) {
    const check = report.checks.find((entry: { id: string }) => entry.id === checkId);
    expect(check, checkId).toBeDefined();
    expect(check.status).toBe('not_run');
    const mapping = readJson(join(result.runDir!, `evidence/checks/${checkId}/extra/test-index-mapping.json`));
    expect(mapping.checkId).toBe(checkId);
    expect(mapping.tasks.length).toBeGreaterThan(0);
    for (const task of mapping.tasks) {
      expect(existsSync(join(ROOT, task.index)), task.index).toBe(true);
      expect(task.files.length).toBeGreaterThan(0);
    }
  }
  expect(report.knownLimitations.join('\n')).toMatch(/P04-9/);

  // 旧八项成功（16 项）不能沿用：清单扩展后报告必须逐项包含补充检查。
  const legacy = readJson(join(result.runDir!, 'report.json'));
  legacy.checks = legacy.checks.filter((check: { id: string }) => !P04_SUPPLEMENT_CHECK_IDS.includes(check.id));
  legacy.counts = { ...legacy.counts, total: legacy.checks.length };
  writeFileSync(join(result.runDir!, 'report.json'), JSON.stringify(legacy));
  const verification = verifyP04ReportDirectory(result.runDir!, loadP04Checklist(join(ROOT, P04_CHECKLIST_PATH)));
  expect(verification.ok).toBe(false);
  expect(verification.problems.join('\n')).toMatch(new RegExp(`checks 必须恰好 ${P04_REQUIRED_CHECK_IDS.length} 项`));
});
