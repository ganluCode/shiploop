import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  P07_ACCEPT_CONFIG_PATH,
  P07_CHECKLIST_PATH,
  P07_DESIGN_INDEXES,
  P07_ENTRY_PATH,
  P07_EVIDENCE_CATEGORIES,
  P07_EXECUTION_TYPES,
  P07_FR_IDS,
  P07_MODES,
  P07_PREREQUISITE_FEATURES,
  P07_REQUIRED_CHECK_IDS,
  P07_TOOLCHAIN,
  P07_VERIFY_SEMANTICS,
  P07AcceptError,
  aggregateP07CheckResults,
  digestP07Checklist,
  digestP07ExecutionMode,
  evaluateP07Prerequisites,
  loadP07AcceptanceConfig,
  loadP07Checklist,
  loadP07EntryContract,
  summarizeP07Checklist,
  validateP07AcceptanceConfig,
  validateP07Budget,
  validateP07Checklist,
  validateP07EntryContract,
} from '../../../scripts/acceptance/p07-config.ts';
import {
  P07_REQUIRED_REGRESSIONS,
  collectP07TrustedTests,
  digestP07TestScope,
  selectP07TestScope,
} from '../../../scripts/acceptance/p07-test-scope.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rejected(action: () => unknown): P07AcceptError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(P07AcceptError);
    return error as P07AcceptError;
  }
  throw new Error('expected P07 contract rejection');
}

it('[case:p07-checklist-freezes-scenarios] 清单把 FR-1/FR-2 与 T06/T08/T11/T12/T15/T16 映射到具名场景和必需事实类别', () => {
  const checklist = loadP07Checklist(join(ROOT, P07_CHECKLIST_PATH));
  const config = loadP07AcceptanceConfig(join(ROOT, P07_ACCEPT_CONFIG_PATH));
  const entry = loadP07EntryContract(join(ROOT, P07_ENTRY_PATH));
  const summary = summarizeP07Checklist(checklist);

  expect(config.requiredChecks).toEqual([...P07_REQUIRED_CHECK_IDS]);
  expect(summary.required).toBeGreaterThanOrEqual(11);
  expect(summary.deferred).toBeGreaterThanOrEqual(1);
  expect(new Set(checklist.items.map(item => item.execution))).toEqual(new Set(P07_EXECUTION_TYPES));
  expect(new Set(checklist.items.flatMap(item => item.features))).toEqual(new Set(P07_PREREQUISITE_FEATURES));
  expect(new Set(checklist.items.flatMap(item => item.fr))).toEqual(new Set(P07_FR_IDS));
  // 每个设计验收索引都被必需检查（非 deferred）映射到具名场景。
  for (const designIndex of P07_DESIGN_INDEXES) expect(summary.designIndexCoverage[designIndex]).toBeGreaterThanOrEqual(1);
  const requiredIds = checklist.items.filter(item => item.group !== 'deferred').map(item => item.id);
  for (const id of ['P07-T06-VERIFIER-CRASH-RECOVERY', 'P07-T08-COMMIT-RECEIPT-RECOVERY', 'P07-T11-RECORDER-BACKPRESSURE',
    'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER', 'P07-T12-NOTIFICATION-INDEPENDENT-RETRY', 'P07-T15-ARCHIVE-DELETE-RETENTION',
    'P07-T16-BACKUP-RESTORE-CONSISTENCY', 'P07-RERUN-EVIDENCE-INTEGRITY']) {
    expect(requiredIds).toContain(id);
  }
  for (const item of checklist.items) {
    expect(item.acceptanceRefs.length).toBeGreaterThan(0);
    expect(item.assertions.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
    for (const evidence of item.evidence) expect(P07_EVIDENCE_CATEGORIES).toContain(evidence);
    for (const designIndex of item.designIndexes) expect(P07_DESIGN_INDEXES).toContain(designIndex);
  }
  // 工具链与运行资格：macOS、Node 22.19.0、npm 10.9.3、默认单并发、有限预算写入契约。
  expect(config.toolchain).toEqual({ ...P07_TOOLCHAIN, platform: 'darwin', platformLabel: 'macOS', defaultConcurrency: 1 });
  expect(entry.toolchain).toEqual({ node: '22.19.0', npm: '10.9.3', platform: 'darwin', defaultConcurrency: 1 });
  expect(entry.budget).toEqual({ stepMs: config.timeouts.stepMs, overallMs: config.timeouts.overallMs, bounded: true });
  expect(config.timeouts.stepMs).toBeGreaterThan(0);
  expect(config.timeouts.overallMs).toBeGreaterThanOrEqual(config.timeouts.stepMs);
  expect(config.executionPolicy.offline).toEqual({ runtime: 'fake-or-scripted', network: 'denied', llmCalls: false });
  expect(config.livePolicy.requiredGate).toBe(false);
  expect(config.reportScope.statuses).toEqual(['pass', 'fail', 'not_run']);
  expect(config.reportScope.notRunCountsAsPassed).toBe(false);
  expect(config.tempResources).toEqual({ git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false });
});

it('[case:p07-config-fail-closed] 拒绝未知/重复/删减检查、未知版本、空检查集合、凭据字段、绝对路径与工具链漂移', () => {
  const checklist = json(join(ROOT, P07_CHECKLIST_PATH));
  const config = json(join(ROOT, P07_ACCEPT_CONFIG_PATH));
  const entry = json(join(ROOT, P07_ENTRY_PATH));

  const duplicate = clone(checklist);
  duplicate.items.push(clone(duplicate.items[0]));
  expect(rejected(() => validateP07Checklist(duplicate)).kind).toBe('invalid_config');

  const unknown = clone(checklist);
  unknown.items[0].id = 'P07-UNKNOWN';
  expect(rejected(() => validateP07Checklist(unknown)).kind).toBe('invalid_config');

  const assertionRemoved = clone(checklist);
  assertionRemoved.items[0].assertions.pop();
  expect(rejected(() => validateP07Checklist(assertionRemoved)).kind).toBe('invalid_config');

  const evidenceRemoved = clone(checklist);
  evidenceRemoved.items[0].evidence.pop();
  expect(rejected(() => validateP07Checklist(evidenceRemoved)).kind).toBe('invalid_config');

  const executionRewritten = clone(checklist);
  executionRewritten.items[0].execution = 'postponed';
  expect(rejected(() => validateP07Checklist(executionRewritten)).kind).toBe('invalid_config');

  // 未知版本：清单/配置/入口 schema 版本漂移一律拒绝。
  const unknownChecklistVersion = clone(checklist);
  unknownChecklistVersion.checklistVersion = 2;
  expect(rejected(() => validateP07Checklist(unknownChecklistVersion)).kind).toBe('invalid_config');

  const emptyItems = clone(checklist);
  emptyItems.items = [];
  expect(rejected(() => validateP07Checklist(emptyItems)).kind).toBe('invalid_config');

  const unknownConfigVersion = clone(config);
  unknownConfigVersion.configVersion = 2;
  expect(rejected(() => validateP07AcceptanceConfig(unknownConfigVersion)).kind).toBe('invalid_config');

  // 空检查集合不能证明需求覆盖。
  const emptyChecks = clone(config);
  emptyChecks.requiredChecks = [];
  expect(rejected(() => validateP07AcceptanceConfig(emptyChecks)).kind).toBe('invalid_config');

  const requiredRemoved = clone(config);
  requiredRemoved.requiredChecks.pop();
  expect(rejected(() => validateP07AcceptanceConfig(requiredRemoved)).kind).toBe('invalid_config');

  const toolchainDrift = clone(config);
  toolchainDrift.toolchain.node = '24.0.0';
  expect(rejected(() => validateP07AcceptanceConfig(toolchainDrift)).kind).toBe('invalid_config');

  const concurrencyDrift = clone(config);
  concurrencyDrift.toolchain.defaultConcurrency = 4;
  expect(rejected(() => validateP07AcceptanceConfig(concurrencyDrift)).kind).toBe('invalid_config');

  const credentialField = clone(config);
  credentialField.apiKey = 'x';
  expect(rejected(() => validateP07AcceptanceConfig(credentialField)).kind).toBe('invalid_config');

  const absoluteReportRoot = clone(config);
  absoluteReportRoot.reportRoot = '/Users/dev/artifacts';
  expect(rejected(() => validateP07AcceptanceConfig(absoluteReportRoot)).kind).toBe('invalid_config');

  const fullByDefault = clone(config);
  fullByDefault.fullRegression.defaultEnabled = true;
  expect(rejected(() => validateP07AcceptanceConfig(fullByDefault)).kind).toBe('invalid_config');

  const modeClaimRewritten = clone(config);
  modeClaimRewritten.modes.default.mustNotClaim = [];
  expect(rejected(() => validateP07AcceptanceConfig(modeClaimRewritten)).kind).toBe('invalid_config');

  const verifySemanticsRewritten = clone(config);
  verifySemanticsRewritten.verifySemantics.noArgRunClaimableByPhaseReport = true;
  expect(rejected(() => validateP07AcceptanceConfig(verifySemanticsRewritten)).kind).toBe('invalid_config');

  const entryUnknownVersion = clone(entry);
  entryUnknownVersion.schemaVersion = 2;
  expect(rejected(() => validateP07EntryContract(entryUnknownVersion)).kind).toBe('invalid_config');

  const entryImplicitFull = clone(entry);
  entryImplicitFull.defaultExecution.fullRegression = true;
  expect(rejected(() => validateP07EntryContract(entryImplicitFull)).kind).toBe('invalid_config');

  const entryNoAncestry = clone(entry);
  entryNoAncestry.prerequisites.commitAncestryRequired = false;
  expect(rejected(() => validateP07EntryContract(entryNoAncestry)).kind).toBe('invalid_config');

  const entryStepReordered = clone(entry);
  entryStepReordered.stepOrder = [...entryStepReordered.stepOrder].reverse();
  expect(rejected(() => validateP07EntryContract(entryStepReordered)).kind).toBe('invalid_config');
});

it('[case:p07-trusted-index-validation] 完整校验 P07-1～P07-5 索引并去重；缺索引/无效版本/清单不一致均拒绝', () => {
  const collected = collectP07TrustedTests(ROOT);
  expect(collected.files.length).toBeGreaterThan(20);
  expect(collected.files).toEqual([...new Set(collected.files)].sort());
  // P07-1～P07-5 的测试文件与聚合清单都进入输入集合。
  expect(collected.inputs).toContain('test/index/phases/P07/features/P07-5/feature.json');
  expect(collected.inputs).toContain('test/index/phases/P07/features/P07-5/tasks/F-001.json');
  for (const feature of ['P07-1', 'P07-2', 'P07-3', 'P07-4', 'P07-5']) {
    expect(collected.files.some(file => file.includes(`/${feature.toLowerCase()}-`))).toBe(true);
  }
  // 本 Task 自身测试文件已在 P07-5 索引登记。
  expect(collected.files).toContain('test/modules/acceptance/p07-5-f001-acceptance-contract.test.ts');

  // 构造合成索引根：复制索引树并把引用的测试文件物化为空普通文件，只测索引契约。
  const synthetic = mkdtempSync(join(tmpdir(), 'p07-index-root-'));
  try {
    cpSync(join(ROOT, 'test/index/phases/P07'), join(synthetic, 'test/index/phases/P07'), { recursive: true });
    for (const file of collectP07TrustedTests(ROOT).files) {
      const target = join(synthetic, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '');
    }
    expect(collectP07TrustedTests(synthetic).files).toEqual(collected.files);

    // 缺整个 Feature 目录：特征集合不完整即拒绝。
    rmSync(join(synthetic, 'test/index/phases/P07/features/P07-3'), { recursive: true });
    expect(() => collectP07TrustedTests(synthetic)).toThrow('prerequisite_index_set');
    cpSync(join(ROOT, 'test/index/phases/P07/features/P07-3'), join(synthetic, 'test/index/phases/P07/features/P07-3'), { recursive: true });

    // 缺 Task 索引文件：引用目标不存在即 fail-closed（不裸抛 ENOENT）。
    rmSync(join(synthetic, 'test/index/phases/P07/features/P07-1/tasks/F-001.json'));
    expect(() => collectP07TrustedTests(synthetic)).toThrow('input_not_file');
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-1/tasks/F-001.json'), JSON.stringify(json(join(ROOT, 'test/index/phases/P07/features/P07-1/tasks/F-001.json'))));

    // 未知 Task 索引 schema 版本即拒绝。
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-1/tasks/F-001.json'), JSON.stringify({ schema_version: 3, task_id: 'F-001', projects: [] }));
    expect(() => collectP07TrustedTests(synthetic)).toThrow('invalid_task_index');
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-1/tasks/F-001.json'), JSON.stringify(json(join(ROOT, 'test/index/phases/P07/features/P07-1/tasks/F-001.json'))));

    // 清单声明与发现的任务集合不一致即拒绝（多登记未落盘任务）。
    const extraDeclared = json(join(ROOT, 'test/index/phases/P07/features/P07-5/feature.json'));
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-5/feature.json'),
      JSON.stringify({ ...extraDeclared, tasks: [...extraDeclared.tasks, { task_id: 'F-099', index: 'test/index/phases/P07/features/P07-5/tasks/F-099.json' }] }));
    expect(() => collectP07TrustedTests(synthetic)).toThrow('input_not_file');
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-5/feature.json'), JSON.stringify(extraDeclared));

    // 空 Feature 清单 tasks：无效聚合清单即拒绝。
    const p071Manifest = json(join(ROOT, 'test/index/phases/P07/features/P07-1/feature.json'));
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-1/feature.json'), JSON.stringify({ ...p071Manifest, tasks: [] }));
    expect(() => collectP07TrustedTests(synthetic)).toThrow('invalid_feature_index');
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-1/feature.json'), JSON.stringify(p071Manifest));

    // 空 Task 测试选择：非空选择强制。
    const f001 = json(join(ROOT, 'test/index/phases/P07/features/P07-5/tasks/F-001.json'));
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-5/tasks/F-001.json'), JSON.stringify({ ...f001, projects: [{ id: 'shiploop', tests: [] }] }));
    expect(() => collectP07TrustedTests(synthetic)).toThrow('empty_test_selection');
    writeFileSync(join(synthetic, 'test/index/phases/P07/features/P07-5/tasks/F-001.json'), JSON.stringify(f001));

    // P07-5 聚合清单缺失必须拒绝（验收 Feature 冻结聚合清单）。
    rmSync(join(synthetic, 'test/index/phases/P07/features/P07-5/feature.json'));
    expect(() => collectP07TrustedTests(synthetic)).toThrow('missing_feature_index');
  } finally { rmSync(synthetic, { recursive: true, force: true }); }
});

it('[case:p07-scope-selection] 默认范围纳入全部 P07 文件与逐项登记的必需回归，未选历史测试逐项 deferred/not_run', () => {
  const collected = collectP07TrustedTests(ROOT);
  const scope = selectP07TestScope(collected.files);

  expect(scope.policy).toBe('p07-impact-and-required-regressions');
  // P07 文件全部纳入。
  for (const file of collected.files.filter(file => file.includes('p07-'))) expect(scope.selected).toContain(file);
  // 必需底层回归逐项纳入且带类别与选择理由。
  expect(new Set(scope.requiredRegressions.map(reg => reg.category))).toEqual(new Set(['recovery', 'git-metadata-lock', 'recorder', 'migration', 'result-query']));
  for (const regression of P07_REQUIRED_REGRESSIONS) {
    expect(scope.selected).toContain(regression.file);
    expect(regression.reason.length).toBeGreaterThan(0);
    expect(collected.files).toContain(regression.file);
  }
  // 未选历史测试逐项登记 deferred/not_run，不删除也不计通过。
  expect(scope.deferred.length).toBeGreaterThan(0);
  expect(new Set(scope.deferred.map(entry => entry.file))).toEqual(new Set(collected.files.filter(file => !scope.selected.includes(file))));
  for (const entry of scope.deferred) {
    expect(entry.status).toBe('not_run');
    expect(entry.reason.length).toBeGreaterThan(0);
  }

  // 范围遗漏：必需回归缺失于可信并集即 fail-closed。
  for (const regression of P07_REQUIRED_REGRESSIONS.slice(0, 3)) {
    const dropped = collected.files.filter(file => file !== regression.file);
    expect(() => selectP07TestScope(dropped)).toThrow(/required_regression_missing/);
    expect(() => selectP07TestScope(dropped)).toThrow(regression.file);
  }
  // 空并集与非测试文件条目拒绝。
  expect(() => selectP07TestScope([])).toThrow('empty_test_selection');
  expect(() => selectP07TestScope(['test/modules/not-a-test.txt'])).toThrow('invalid_trusted_union_entry');
});

it('[case:p07-mode-digests-differ] 默认与全量模式范围/输入摘要不同；默认模式不得声称无参数 verify 或全仓回归通过', () => {
  const collected = collectP07TrustedTests(ROOT);
  const scope = selectP07TestScope(collected.files);
  const full = selectP07TestScope(collected.files, true);

  expect(full.policy).toBe('full-trusted-union');
  expect(full.selected).toEqual(collected.files);
  expect(full.deferred).toEqual([]);
  expect(scope.selected.length).toBeLessThan(full.selected.length);
  // 两种模式的范围摘要与执行模式摘要都必须不同。
  expect(digestP07TestScope(scope)).not.toBe(digestP07TestScope(full));
  expect(digestP07ExecutionMode('default')).not.toBe(digestP07ExecutionMode('full'));
  expect(digestP07ExecutionMode('default')).toMatch(/^[0-9a-f]{64}$/);

  const modes = P07_MODES;
  expect(modes.default.fullRepositoryTests).toBe(false);
  expect(modes.default.mustNotClaim).toContain('no-arg-verify-passed');
  expect(modes.default.mustNotClaim).toContain('full-history-regression-passed');
  expect(modes.full.fullRepositoryTests).toBe(true);
  expect(modes.full.optIn).toBe('--full-regression');
  expect(modes.full.mustNotClaim).toContain('no-arg-verify-passed');
  // 无参数 npm run verify 的全仓语义保持原样，未被阶段入口修改或代签。
  expect(P07_VERIFY_SEMANTICS.noArgCommand).toEqual(['npm', 'run', 'verify']);
  expect(P07_VERIFY_SEMANTICS.noArgSteps).toEqual(['typecheck', 'test', 'build']);
  expect(P07_VERIFY_SEMANTICS.modifiedByPhaseEntry).toBe(false);
  expect(P07_VERIFY_SEMANTICS.noArgRunClaimableByPhaseReport).toBe(false);
  // 默认阶段模式的工程检查覆盖类型/边界/构建并复用既有入口。
  const entry = loadP07EntryContract(join(ROOT, P07_ENTRY_PATH));
  expect(entry.defaultExecution).toEqual({ mode: 'phase', network: 'denied', llmCalls: false, fullRegression: false, verifyChecksOnly: true });
  expect(entry.modes.default.engineeringChecks).toEqual({ typecheck: 'npm run typecheck', boundaries: 'npm run check:boundaries', build: 'npm run build' });
});

it('[case:p07-prerequisite-identity] 前置交付/接口/证据/祖先关系缺失输出结构化阻塞；未知或重复身份拒绝', () => {
  const sha = (char: string) => char.repeat(40);
  const all = P07_PREREQUISITE_FEATURES.map(feature => ({
    feature, commit: sha('a'), delivered: true, interfacesSatisfied: true,
    deliveryEvidence: [`reports/${feature}.json`], publicInterfaces: ['core-command', 'host-query'], ancestorOfHead: true,
  }));
  const satisfied = evaluateP07Prerequisites(all);
  expect(satisfied.status).toBe('satisfied');
  expect(satisfied.resultStatus).toBe('pass');
  expect(satisfied.blockedFeatures).toEqual([]);

  // 未交付：结构化阻塞，相关步骤 not_run。
  const notDelivered = evaluateP07Prerequisites(all.map(entry => entry.feature === 'P07-2' ? { ...entry, delivered: false } : entry));
  expect(notDelivered.status).toBe('blocked');
  expect(notDelivered.resultStatus).toBe('not_run');
  expect(notDelivered.blockedFeatures).toEqual(['P07-2']);
  expect(notDelivered.blockers).toContainEqual({ feature: 'P07-2', code: 'not_delivered', detail: 'delivered 不为 true' });

  // 占位接口不放行。
  const placeholder = evaluateP07Prerequisites(all.map(entry => entry.feature === 'P07-3' ? { ...entry, interfacesSatisfied: false } : entry));
  expect(placeholder.blockers.some(b => b.feature === 'P07-3' && b.code === 'interfaces_unsatisfied')).toBe(true);

  // 错误前置身份：commit 非法、证据缺失、公开接口清单缺失、祖先关系不成立。
  const badCommit = evaluateP07Prerequisites(all.map(entry => entry.feature === 'P07-1' ? { ...entry, commit: 'HEAD' } : entry));
  expect(badCommit.blockers.some(b => b.feature === 'P07-1' && b.code === 'invalid_commit')).toBe(true);
  const noEvidence = evaluateP07Prerequisites(all.map(entry => entry.feature === 'P07-4' ? { ...entry, deliveryEvidence: [] } : entry));
  expect(noEvidence.blockers.some(b => b.feature === 'P07-4' && b.code === 'evidence_missing')).toBe(true);
  const noInterfaces = evaluateP07Prerequisites(all.map(entry => entry.feature === 'P07-4' ? { ...entry, publicInterfaces: [] } : entry));
  expect(noInterfaces.blockers.some(b => b.feature === 'P07-4' && b.code === 'interfaces_missing')).toBe(true);
  const notAncestor = evaluateP07Prerequisites(all.map(entry => entry.feature === 'P07-1' ? { ...entry, ancestorOfHead: false } : entry));
  expect(notAncestor.blockers.some(b => b.feature === 'P07-1' && b.code === 'not_ancestor')).toBe(true);

  // 缺失输入按未交付处理。
  const missing = evaluateP07Prerequisites(all.slice(1));
  expect(missing.status).toBe('blocked');
  expect(missing.blockedFeatures).toContain('P07-1');
  expect(missing.blockers.some(b => b.feature === 'P07-1' && b.code === 'not_delivered')).toBe(true);

  // 未知/重复前序 Feature 属于身份错误，直接拒绝。
  expect(rejected(() => evaluateP07Prerequisites([...all, { ...all[0]!, feature: 'P07-9', commit: sha('a'), delivered: true, interfacesSatisfied: true, deliveryEvidence: ['x'], publicInterfaces: ['y'], ancestorOfHead: true }])).kind).toBe('invalid_config');
  expect(rejected(() => evaluateP07Prerequisites([...all, all[0]!])).kind).toBe('invalid_config');
});

it('[case:p07-budget-limits] 非法预算（0/负数/非整数/越界/总体小于单步）一律拒绝', () => {
  const config = loadP07AcceptanceConfig(join(ROOT, P07_ACCEPT_CONFIG_PATH));
  const ok = validateP07Budget({ stepMs: config.timeouts.stepMs, overallMs: config.timeouts.overallMs });
  expect(ok).toEqual({ stepMs: config.timeouts.stepMs, overallMs: config.timeouts.overallMs });
  expect(validateP07Budget({ stepMs: 60_000, overallMs: 60_000 }).stepMs).toBe(60_000);

  expect(rejected(() => validateP07Budget({ stepMs: 0, overallMs: 1000 })).kind).toBe('invalid_config');
  expect(rejected(() => validateP07Budget({ stepMs: -5, overallMs: 1000 })).kind).toBe('invalid_config');
  expect(rejected(() => validateP07Budget({ stepMs: 1.5, overallMs: 1000 })).kind).toBe('invalid_config');
  expect(rejected(() => validateP07Budget({ stepMs: '900000', overallMs: 1000 })).kind).toBe('invalid_config');
  expect(rejected(() => validateP07Budget({ stepMs: 999, overallMs: 1000 })).kind).toBe('invalid_config');
  expect(rejected(() => validateP07Budget({ stepMs: 8_000_000, overallMs: 9_000_000 })).kind).toBe('invalid_config');
  expect(rejected(() => validateP07Budget({ stepMs: 20_000_000, overallMs: 21_000_000 })).kind).toBe('invalid_config');
  // 总体预算小于单步预算拒绝。
  expect(rejected(() => validateP07Budget({ stepMs: 500_000, overallMs: 400_000 })).kind).toBe('invalid_config');
});

it('[case:p07-status-gates] not_run 与人工 pending 不计为通过，缺证据即 fail，未知/重复结果拒绝', () => {
  const checklist = loadP07Checklist(join(ROOT, P07_CHECKLIST_PATH));
  const offline = checklist.items.find(item => item.execution === 'offline' && item.group !== 'deferred')!;
  const manual = checklist.items.find(item => item.execution === 'manual' && item.group !== 'deferred')!;
  const deferred = checklist.items.find(item => item.group === 'deferred')!;
  const result = (checkId: string, executionMode: 'fake' | 'manual', extra = {}) => ({
    checkId, status: 'pass' as const, executionMode,
    evidence: [...checklist.items.find(item => item.id === checkId)!.evidence],
    ...extra,
  });

  const requiredCount = checklist.items.filter(item => item.group !== 'deferred').length;
  expect(aggregateP07CheckResults(checklist, []).counts).toEqual({ pass: 0, fail: 0, not_run: requiredCount });
  expect(aggregateP07CheckResults(checklist, []).conclusion).toBe('fail');

  const offlinePass = aggregateP07CheckResults(checklist, [result(offline.id, 'fake')]);
  expect(offlinePass.checks.find(check => check.id === offline.id)?.status).toBe('pass');
  expect(offlinePass.counts).toEqual({ pass: 1, fail: 0, not_run: requiredCount - 1 });
  expect(offlinePass.conclusion).toBe('fail');
  expect(offlinePass.checks.find(check => check.id === deferred.id)?.status).toBe('not_run');

  // manual pending/rejected 不能由机器代签；offline 检查不能被 manual 结果满足。
  expect(aggregateP07CheckResults(checklist, [result(manual.id, 'manual', { manualStatus: 'pending' })]).checks.find(check => check.id === manual.id)?.status).toBe('fail');
  expect(aggregateP07CheckResults(checklist, [result(manual.id, 'manual', { manualStatus: 'rejected' })]).checks.find(check => check.id === manual.id)?.status).toBe('fail');
  expect(aggregateP07CheckResults(checklist, [result(offline.id, 'manual', { manualStatus: 'confirmed' })]).checks.find(check => check.id === offline.id)?.status).toBe('fail');

  // 证据类别缺失即 fail，即使状态声明为 pass。
  const missingEvidence = { ...result(offline.id, 'fake'), evidence: result(offline.id, 'fake').evidence.slice(1) };
  expect(aggregateP07CheckResults(checklist, [missingEvidence]).checks.find(check => check.id === offline.id)?.status).toBe('fail');

  expect(rejected(() => aggregateP07CheckResults(checklist, [{ ...result(offline.id, 'fake'), checkId: 'P07-NOPE' }])).kind).toBe('invalid_config');
  expect(rejected(() => aggregateP07CheckResults(checklist, [result(offline.id, 'fake'), result(offline.id, 'fake')])).kind).toBe('invalid_config');

  // 全部必需项以正确模式与证据通过时才 pass。
  const allPass = checklist.items
    .filter(item => item.group !== 'deferred')
    .map(item => item.execution === 'manual' ? result(item.id, 'manual', { manualStatus: 'confirmed' }) : result(item.id, 'fake'));
  const aggregate = aggregateP07CheckResults(checklist, allPass);
  expect(aggregate.conclusion).toBe('pass');
  expect(aggregate.counts).toEqual({ pass: requiredCount, fail: 0, not_run: 0 });
});

it('[case:p07-checklist-digest-stable] 清单变更产生稳定摘要并可在报告中追溯', () => {
  const checklist = loadP07Checklist(join(ROOT, P07_CHECKLIST_PATH));
  const digest = digestP07Checklist(checklist);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);

  const reloaded = validateP07Checklist(json(join(ROOT, P07_CHECKLIST_PATH)));
  expect(digestP07Checklist(reloaded)).toBe(digest);
  // 键序变化不影响摘要。
  const reordered = { ...checklist, items: checklist.items.map(item => Object.fromEntries(Object.entries(item).reverse()) as typeof item) };
  expect(digestP07Checklist(reordered)).toBe(digest);

  // 内容变化必须改变摘要。
  const assertionChanged = { ...checklist, items: checklist.items.map((item, index) => index === 0 ? { ...item, assertions: [...item.assertions.slice(0, -1), `${item.assertions[item.assertions.length - 1]} (修订)`] } : item) };
  expect(digestP07Checklist(assertionChanged)).not.toBe(digest);
  const designIndexChanged = { ...checklist, items: checklist.items.map((item, index) => index === 2 ? { ...item, designIndexes: ['T12'] } : item) };
  expect(digestP07Checklist(designIndexChanged)).not.toBe(digest);
  const appended = { ...checklist, items: [...checklist.items, checklist.items[checklist.items.length - 1]!] };
  expect(digestP07Checklist(appended)).not.toBe(digest);
});

// 索引契约自身登记检查：P07-5 聚合清单与 Task 索引符合 v1/v2 schema。
it('[case:p07-self-index-registered] P07-5 聚合清单与本 Task 的 schema_version=2 局部测试索引真实登记', () => {
  const manifest = json(join(ROOT, 'test/index/phases/P07/features/P07-5/feature.json'));
  expect(manifest).toMatchObject({ schema_version: 1, kind: 'feature', phase: 'P07', feature: 'P07-5' });
  expect(manifest.tasks.map((task: any) => task.task_id)).toEqual(['F-001']);
  expect(manifest.tasks[0].index).toBe('test/index/phases/P07/features/P07-5/tasks/F-001.json');

  const taskIndex = json(join(ROOT, 'test/index/phases/P07/features/P07-5/tasks/F-001.json'));
  expect(taskIndex).toMatchObject({ schema_version: 2, task_id: 'F-001' });
  expect(taskIndex.projects).toHaveLength(1);
  expect(taskIndex.projects[0].id).toBe('shiploop');
  const files = taskIndex.projects[0].tests.map((test: any) => test.file);
  expect(files).toEqual(['test/modules/acceptance/p07-5-f001-acceptance-contract.test.ts']);
  for (const file of files) expect(existsSync(join(ROOT, file))).toBe(true);
});
