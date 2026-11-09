/**
 * P08-4 / F-001 P08 一期总验收契约冻结测试（纯本地文件/常量断言）。
 *
 * 守护对象：`acceptance/p08.checklist.json`、`acceptance/p08.config.json`、
 * `acceptance/p08.entry.json` 与 `scripts/acceptance/p08-config.ts` 的
 * fail-closed 校验入口，以及 `docs/phases/p08/p08-acceptance.md` 契约说明。
 *
 * 覆盖（全部为真实文件/真实校验函数断言，无 mock、无网络、无模型）：
 * 1) 清单逐项表达代码交付、Task 局部验证、Feature 门禁、Phase 集成、Live
 *    和人工确认六个层次，Todo live 与存量 live 分开登记、互不替代；
 * 2) 严格三态 pass/fail/not_run：缺失结果、负责人未确认、真实模型缺失一律
 *    保持 not_run，不把缺失输入默认为通过；
 * 3) 运行身份固定 runId、受测 commit、输入摘要与工具链；报告与证据引用必须
 *    绑定同一身份，旧运行目录不可被覆盖；
 * 4) Nezha 只作为开发编排工具：Harness 状态、测试数量、成功日志文字不得
 *    作为产品通过依据，本 Feature 不自动发布、推送或修改 Phase 状态；
 * 5) 契约漂移（版本/删减断言/改写执行类别或层次/凭据字段/绝对路径/工具链
 *    漂移/live 政策弱化）一律拒绝；前序 P08-1～P08-3 交付输入路径真实存在；
 * 6) 本模块只验证结构、唯一性与允许值，不导入进程/网络/数据库/产品包，
 *    真实安装、SQLite、Git、Host、受控进程与跨层事实留给 Phase 集成任务。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  P08_ACCEPT_CONFIG_PATH,
  P08_CHECKLIST_PATH,
  P08_ENTRY_PATH,
  P08_EVIDENCE_CATEGORIES,
  P08_FR_IDS,
  P08_FROZEN_ITEMS,
  P08_LAYERS,
  P08_LIVE_EVIDENCE_KINDS,
  P08_PREREQUISITE_FEATURES,
  P08_PREREQUISITE_INPUTS,
  P08_REQUIRED_CHECK_IDS,
  P08_DEFERRED_IDS,
  P08_TOOLCHAIN,
  P08AcceptError,
  aggregateP08CheckResults,
  digestP08Checklist,
  digestP08ExecutionMode,
  evaluateP08LiveEvidence,
  evaluateP08Prerequisites,
  loadP08AcceptanceConfig,
  loadP08Checklist,
  loadP08EntryContract,
  p08HarnessEvidenceAdmissible,
  p08RunDirectoryDisposition,
  p08RunIdentityMatches,
  summarizeP08Checklist,
  validateP08AcceptanceConfig,
  validateP08Budget,
  validateP08Checklist,
  validateP08EntryContract,
  validateP08EvidenceIdentityBinding,
  validateP08RunIdentity,
} from '../../../scripts/acceptance/p08-config.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rejected(action: () => unknown): P08AcceptError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(P08AcceptError);
    return error as P08AcceptError;
  }
  throw new Error('expected P08 contract rejection');
}

it('[case:p08-checklist-freezes-gates] 清单逐项覆盖六个验证层次并分开登记两类 live 与人工门禁', () => {
  const checklist = loadP08Checklist(join(ROOT, P08_CHECKLIST_PATH));
  const config = loadP08AcceptanceConfig(join(ROOT, P08_ACCEPT_CONFIG_PATH));
  const entry = loadP08EntryContract(join(ROOT, P08_ENTRY_PATH));
  const summary = summarizeP08Checklist(checklist);

  // 六个层次（代码交付/Task 局部/Feature 门禁/Phase 集成/Live/人工确认）
  // 都被必需检查（非 deferred）覆盖。
  expect([...P08_LAYERS]).toEqual(['code-delivery', 'task-local', 'feature-gate', 'phase-integration', 'live', 'manual']);
  for (const layer of P08_LAYERS) expect(summary.layerCoverage[layer]).toBeGreaterThanOrEqual(1);
  // 严格三态；not_run 不折算通过。
  expect(checklist.executionTypes).toEqual(['offline', 'live', 'manual', 'postponed']);
  expect(summary.byExecution.offline).toBeGreaterThanOrEqual(1);
  expect(summary.byExecution.live).toBeGreaterThanOrEqual(2);
  expect(summary.byExecution.manual).toBe(1);
  // FR-1/FR-2/FR-3 与前序 Feature 全部被必需检查覆盖。
  for (const fr of P08_FR_IDS) expect(summary.frCoverage[fr]).toBeGreaterThanOrEqual(1);
  for (const feature of P08_PREREQUISITE_FEATURES) expect(summary.byFeature[feature]).toBeGreaterThanOrEqual(1);
  // 两类 live 证据分开登记，互不替代。
  expect(Object.keys(P08_LIVE_EVIDENCE_KINDS)).toEqual(['todo-live', 'existing-live']);
  for (const kind of Object.keys(P08_LIVE_EVIDENCE_KINDS) as (keyof typeof P08_LIVE_EVIDENCE_KINDS)[]) {
    const liveItems = checklist.items.filter(item => item.group !== 'deferred' && item.layer === 'live' && item.evidence.includes(kind));
    expect(liveItems).toHaveLength(1);
    expect(liveItems[0].execution).toBe('live');
  }
  // 人工门禁独立存在，机器不可代签。
  const manualItems = checklist.items.filter(item => item.execution === 'manual');
  expect(manualItems).toHaveLength(1);
  expect(manualItems[0].layer).toBe('manual');

  expect(config.requiredChecks).toEqual([...P08_REQUIRED_CHECK_IDS]);
  for (const deferredId of P08_DEFERRED_IDS) expect(config.requiredChecks).not.toContain(deferredId);
  expect(checklist.countRule).toContain('not_run');
  expect(checklist.countRule).toContain('互不替代');
  // live 政策：两类分开核对；缺失/负责人未确认保持 not_run；默认入口不调用真实模型。
  expect(config.livePolicy.requiredGate).toBe(true);
  expect(config.livePolicy.crossSubstitutionAllowed).toBe(false);
  expect(config.livePolicy.missingBehavior).toBe('not_run');
  expect(config.livePolicy.ownerUnconfirmedBehavior).toBe('not_run');
  expect(entry.defaultExecution.llmCalls).toBe(false);
  expect(entry.defaultExecution.liveEvidence).toBe('import-only');
  expect(entry.separateLiveEntry.command).toBe('npm run accept:p08:live');
  expect(entry.separateLiveEntry.invokedByDefaultEntry).toBe(false);
  expect(entry.separateLiveEntry.ownerApprovalRequired).toBe(true);
  // 运行身份与运行目录政策冻结。
  expect(config.runIdentity.requiredFields).toEqual(['runId', 'testedCommit', 'inputsDigest', 'toolchain']);
  expect(config.runIdentity.reportAndEvidenceBindSameIdentity).toBe(true);
  expect(config.runIdentity.runDirectoryPolicy).toBe('create-once');
  expect(config.runIdentity.existingRunDirectoryBehavior).toBe('fail-preserve-previous');
  expect(entry.runIdentity).toEqual(config.runIdentity);
  // 工具链与预算。
  expect(config.toolchain).toEqual({ ...P08_TOOLCHAIN, platform: 'darwin', platformLabel: 'macOS', defaultConcurrency: 2 });
  expect(entry.toolchain).toEqual({ node: '22.19.0', npm: '10.9.3', platform: 'darwin', defaultConcurrency: 2 });
  expect(entry.budget).toEqual({ stepMs: config.timeouts.stepMs, overallMs: config.timeouts.overallMs, bounded: true });
  expect(config.executionPolicy.offline).toEqual({ runtime: 'fake-or-scripted', network: 'denied', llmCalls: false });
  expect(config.reportScope.statuses).toEqual(['pass', 'fail', 'not_run']);
  expect(config.reportScope.notRunCountsAsPassed).toBe(false);
  expect(config.tempResources).toEqual({ git: 'temp', sqlite: 'temp', dataRoot: 'temp', home: 'temp', processes: 'owned-only', reusePrevious: false });
  for (const item of checklist.items) {
    expect(item.assertions.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
    for (const evidence of item.evidence) expect(P08_EVIDENCE_CATEGORIES).toContain(evidence);
    expect([...P08_PREREQUISITE_FEATURES]).toEqual(expect.arrayContaining([...item.features]));
  }
});

it('[case:p08-config-fail-closed] 拒绝重复/未知/删减检查、版本漂移、凭据字段、绝对路径与政策弱化', () => {
  const checklist = json(join(ROOT, P08_CHECKLIST_PATH));
  const config = json(join(ROOT, P08_ACCEPT_CONFIG_PATH));
  const entry = json(join(ROOT, P08_ENTRY_PATH));

  const duplicate = clone(checklist);
  duplicate.items.push(clone(duplicate.items[0]));
  expect(rejected(() => validateP08Checklist(duplicate)).kind).toBe('invalid_config');

  const unknown = clone(checklist);
  unknown.items[0].id = 'P08-UNKNOWN';
  expect(rejected(() => validateP08Checklist(unknown)).kind).toBe('invalid_config');

  const assertionRemoved = clone(checklist);
  assertionRemoved.items[0].assertions.pop();
  expect(rejected(() => validateP08Checklist(assertionRemoved)).kind).toBe('invalid_config');

  const evidenceRemoved = clone(checklist);
  evidenceRemoved.items[0].evidence.pop();
  expect(rejected(() => validateP08Checklist(evidenceRemoved)).kind).toBe('invalid_config');

  const executionRewritten = clone(checklist);
  executionRewritten.items.find((item: any) => item.execution === 'live').execution = 'offline';
  expect(rejected(() => validateP08Checklist(executionRewritten)).kind).toBe('invalid_config');

  const layerRewritten = clone(checklist);
  layerRewritten.items[0].layer = 'task-local';
  expect(rejected(() => validateP08Checklist(layerRewritten)).kind).toBe('invalid_config');

  const versionDrift = clone(checklist);
  versionDrift.checklistVersion = 2;
  expect(rejected(() => validateP08Checklist(versionDrift)).kind).toBe('invalid_config');

  const credentialField = clone(config);
  (credentialField as any).apiToken = 'x';
  expect(rejected(() => validateP08AcceptanceConfig(credentialField)).kind).toBe('invalid_config');

  const absolutePath = clone(config);
  absolutePath.checklist = '/etc/passwd';
  expect(rejected(() => validateP08AcceptanceConfig(absolutePath)).kind).toBe('invalid_config');

  const requiredDrift = clone(config);
  requiredDrift.requiredChecks = requiredDrift.requiredChecks.slice(1);
  expect(rejected(() => validateP08AcceptanceConfig(requiredDrift)).kind).toBe('invalid_config');

  const toolchainDrift = clone(config);
  toolchainDrift.toolchain.node = '26.0.0';
  expect(rejected(() => validateP08AcceptanceConfig(toolchainDrift)).kind).toBe('invalid_config');

  const liveWeakened = clone(config);
  liveWeakened.livePolicy.requiredGate = false;
  expect(rejected(() => validateP08AcceptanceConfig(liveWeakened)).kind).toBe('invalid_config');

  const liveSubstitution = clone(config);
  liveSubstitution.livePolicy.crossSubstitutionAllowed = true;
  expect(rejected(() => validateP08AcceptanceConfig(liveSubstitution)).kind).toBe('invalid_config');

  const runDirOverwrite = clone(config);
  runDirOverwrite.runIdentity.existingRunDirectoryBehavior = 'overwrite';
  expect(rejected(() => validateP08AcceptanceConfig(runDirOverwrite)).kind).toBe('invalid_config');

  const harnessWeakened = clone(config);
  harnessWeakened.nezhaBoundary.harnessStateAsPassEvidence = true;
  expect(rejected(() => validateP08AcceptanceConfig(harnessWeakened)).kind).toBe('invalid_config');

  const publishWeakened = clone(config);
  publishWeakened.publicationPolicy.autoPush = true;
  expect(rejected(() => validateP08AcceptanceConfig(publishWeakened)).kind).toBe('invalid_config');

  const prerequisiteRemoved = clone(config);
  prerequisiteRemoved.prerequisites.deliveryInputs['P08-2'].reports = [];
  expect(rejected(() => validateP08AcceptanceConfig(prerequisiteRemoved)).kind).toBe('invalid_config');

  const entryVersionDrift = clone(entry);
  entryVersionDrift.schemaVersion = 2;
  expect(rejected(() => validateP08EntryContract(entryVersionDrift)).kind).toBe('invalid_config');

  const entryLiveInjected = clone(entry);
  entryLiveInjected.defaultExecution.llmCalls = true;
  expect(rejected(() => validateP08EntryContract(entryLiveInjected)).kind).toBe('invalid_config');

  const entryStepRemoved = clone(entry);
  entryStepRemoved.stepOrder.pop();
  expect(rejected(() => validateP08EntryContract(entryStepRemoved)).kind).toBe('invalid_config');

  const entryManualSignedByMachine = clone(entry);
  entryManualSignedByMachine.nezhaBoundary.autoPhaseStatusChange = true;
  expect(rejected(() => validateP08EntryContract(entryManualSignedByMachine)).kind).toBe('invalid_config');
});

it('[case:p08-run-identity-binding] 运行身份绑定 runId/受测 commit/输入摘要/工具链且旧运行目录不可覆盖', () => {
  const identity = { runId: 'p08-total-20261103-001', testedCommit: 'a'.repeat(40), inputsDigest: 'b'.repeat(64), toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'darwin' } };
  expect(validateP08RunIdentity(identity)).toEqual(identity);
  for (const bad of [
    { ...identity, runId: '../escape' },
    { ...identity, runId: '' },
    { ...identity, runId: 'x'.repeat(129) },
    { ...identity, testedCommit: 'XYZ' },
    { ...identity, inputsDigest: 'short' },
    { ...identity, toolchain: { node: '26.0.0', npm: '10.9.3', platform: 'darwin' } },
    { ...identity, toolchain: { node: '22.19.0', npm: '11.0.0', platform: 'darwin' } },
    { ...identity, toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'linux' } },
  ]) expect(rejected(() => validateP08RunIdentity(bad)).kind).toBe('invalid_config');

  const other = { ...identity, runId: 'p08-total-20261103-002' };
  expect(p08RunIdentityMatches(identity, identity)).toBe(true);
  expect(p08RunIdentityMatches(identity, other)).toBe(false);
  expect(p08RunIdentityMatches(identity, { ...identity, testedCommit: 'c'.repeat(40) })).toBe(false);
  expect(p08RunIdentityMatches(identity, { ...identity, inputsDigest: 'd'.repeat(64) })).toBe(false);

  // 证据引用必须绑定同一身份；漂移 fail-closed。
  validateP08EvidenceIdentityBinding({ runId: identity.runId, testedCommit: identity.testedCommit, inputsDigest: identity.inputsDigest }, identity);
  expect(rejected(() => validateP08EvidenceIdentityBinding(other, identity)).kind).toBe('identity_mismatch');
  expect(rejected(() => validateP08EvidenceIdentityBinding({ runId: identity.runId, testedCommit: 'e'.repeat(40), inputsDigest: identity.inputsDigest }, identity)).kind).toBe('identity_mismatch');
  expect(rejected(() => validateP08EvidenceIdentityBinding({ runId: identity.runId, testedCommit: identity.testedCommit, inputsDigest: 'f'.repeat(64) }, identity)).kind).toBe('identity_mismatch');

  // 旧运行目录不可覆盖：已存在即失败并保留旧运行。
  expect(p08RunDirectoryDisposition({ runId: identity.runId, directoryExists: false })).toEqual({ action: 'create' });
  const preserved = p08RunDirectoryDisposition({ runId: identity.runId, directoryExists: true });
  expect(preserved.action).toBe('fail');
  expect(preserved).toMatchObject({ reason: 'run-directory-exists' });
});

it('[case:p08-prerequisites-not-run] 前序交付缺失/非祖先/证据缺失记 blocked 与 not_run，不以占位放行', () => {
  const commit = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const base = (feature: string) => ({
    feature, commit, delivered: true, interfacesSatisfied: true,
    deliveryEvidence: ['docs/acceptance/report.md'], publicInterfaces: ['Core/Host/CLI'], ancestorOfHead: true,
  });
  const satisfied = evaluateP08Prerequisites(P08_PREREQUISITE_FEATURES.map(base));
  expect(satisfied.status).toBe('satisfied');
  expect(satisfied.resultStatus).toBe('pass');
  expect(satisfied.blockers).toEqual([]);

  const missing = evaluateP08Prerequisites(P08_PREREQUISITE_FEATURES.slice(0, 2).map(base));
  expect(missing.status).toBe('blocked');
  expect(missing.resultStatus).toBe('not_run');
  expect(missing.blockedFeatures).toEqual(['P08-3']);
  expect(missing.blockers.map(blocker => blocker.code)).toContain('not_delivered');

  const notAncestor = evaluateP08Prerequisites(P08_PREREQUISITE_FEATURES.map(feature => ({ ...base(feature), feature, ancestorOfHead: feature === 'P08-1' ? false : true })));
  expect(notAncestor.status).toBe('blocked');
  expect(notAncestor.resultStatus).toBe('not_run');
  expect(notAncestor.blockers.find(blocker => blocker.feature === 'P08-1')?.code).toBe('not_ancestor');

  const noEvidence = evaluateP08Prerequisites(P08_PREREQUISITE_FEATURES.map(feature => ({ ...base(feature), feature, deliveryEvidence: [] })));
  expect(noEvidence.resultStatus).toBe('not_run');
  expect(noEvidence.blockers.every(blocker => blocker.code === 'evidence_missing')).toBe(true);

  const invalidCommit = evaluateP08Prerequisites(P08_PREREQUISITE_FEATURES.map(feature => ({ ...base(feature), feature, commit: 'not-a-sha' })));
  expect(invalidCommit.blockers.every(blocker => blocker.code === 'invalid_commit')).toBe(true);

  const placeholder = evaluateP08Prerequisites(P08_PREREQUISITE_FEATURES.map(feature => ({ ...base(feature), feature, interfacesSatisfied: false })));
  expect(placeholder.blockers.every(blocker => blocker.code === 'interfaces_unsatisfied')).toBe(true);

  expect(rejected(() => evaluateP08Prerequisites([...P08_PREREQUISITE_FEATURES.map(base), base('P08-1')])).kind).toBe('invalid_config');
  expect(rejected(() => evaluateP08Prerequisites([base('P08-9')])).kind).toBe('invalid_config');
});

it('[case:p08-live-evidence-separate] 两类 live 分开核对：模型缺失/负责人未确认保持 not_run，不可互相替代', () => {
  const todo = { kind: 'todo-live' as const, reportPresent: false, reportKind: null, identityBound: null, realModelUsed: null, ownerConfirmed: null };
  expect(evaluateP08LiveEvidence(todo)).toMatchObject({ kind: 'todo-live', status: 'not_run' });

  const existing = evaluateP08LiveEvidence({ kind: 'existing-live', reportPresent: true, reportKind: 'shiploop.todo.live-evidence', identityBound: true, realModelUsed: true, ownerConfirmed: true });
  expect(existing.status).toBe('fail');
  expect(existing.reason).toContain('不可互相替代');

  const wrongKind = evaluateP08LiveEvidence({ kind: 'todo-live', reportPresent: true, reportKind: 'shiploop.brownfield.evidence-envelope', identityBound: true, realModelUsed: true, ownerConfirmed: true });
  expect(wrongKind.status).toBe('fail');

  const unbound = evaluateP08LiveEvidence({ kind: 'todo-live', reportPresent: true, reportKind: 'shiploop.todo.live-evidence', identityBound: false, realModelUsed: true, ownerConfirmed: true });
  expect(unbound.status).toBe('fail');

  const fakeModel = evaluateP08LiveEvidence({ kind: 'todo-live', reportPresent: true, reportKind: 'shiploop.todo.live-evidence', identityBound: true, realModelUsed: false, ownerConfirmed: true });
  expect(fakeModel.status).toBe('fail');

  const modelUnverified = evaluateP08LiveEvidence({ kind: 'todo-live', reportPresent: true, reportKind: 'shiploop.todo.live-evidence', identityBound: true, realModelUsed: null, ownerConfirmed: true });
  expect(modelUnverified.status).toBe('not_run');

  const ownerPending = evaluateP08LiveEvidence({ kind: 'existing-live', reportPresent: true, reportKind: 'shiploop.brownfield.evidence-envelope', identityBound: true, realModelUsed: true, ownerConfirmed: false });
  expect(ownerPending.status).toBe('not_run');
  expect(ownerPending.reason).toContain('not_run');

  const passed = evaluateP08LiveEvidence({ kind: 'todo-live', reportPresent: true, reportKind: 'shiploop.todo.live-evidence', identityBound: true, realModelUsed: true, ownerConfirmed: true });
  expect(passed.status).toBe('pass');

  expect(rejected(() => evaluateP08LiveEvidence({ ...todo, kind: 'other-live' })).kind).toBe('invalid_config');

  // 聚合层面：只有存量 live 证据、Todo live 缺失时阶段不能通过。
  const checklist = loadP08Checklist(join(ROOT, P08_CHECKLIST_PATH));
  const existingLiveItem = checklist.items.find(item => item.layer === 'live' && item.evidence.includes('existing-live'))!;
  const aggregate = aggregateP08CheckResults(checklist, [{
    checkId: existingLiveItem.id, status: 'pass', executionMode: 'live',
    evidence: [...existingLiveItem.evidence],
  }]);
  const todoLiveCheck = aggregate.checks.find(check => check.layer === 'live' && check.evidence.includes('todo-live'))!;
  expect(todoLiveCheck.status).toBe('not_run');
  expect(aggregate.counts.not_run).toBeGreaterThanOrEqual(1);
  expect(aggregate.conclusion).toBe('fail');
});

it('[case:p08-harness-boundary] Harness 状态、测试数量与成功日志文字不得作为产品通过依据', () => {
  expect(p08HarnessEvidenceAdmissible({ productFactRef: true })).toBe(true);
  expect(p08HarnessEvidenceAdmissible({ productFactRef: true, harnessState: true })).toBe(false);
  expect(p08HarnessEvidenceAdmissible({ productFactRef: true, testCountOnly: true })).toBe(false);
  expect(p08HarnessEvidenceAdmissible({ productFactRef: true, successLogText: true })).toBe(false);
  expect(p08HarnessEvidenceAdmissible({ productFactRef: true, harnessState: true, testCountOnly: true, successLogText: true })).toBe(false);
  expect(p08HarnessEvidenceAdmissible({})).toBe(false);

  const config = loadP08AcceptanceConfig(join(ROOT, P08_ACCEPT_CONFIG_PATH));
  expect(config.nezhaBoundary.role).toBe('development-orchestration-tool-only');
  expect(config.nezhaBoundary.productRuntimeDependency).toBe(false);
  expect(config.nezhaBoundary.harnessStateAsPassEvidence).toBe(false);
  expect(config.nezhaBoundary.testCountsAsPassEvidence).toBe(false);
  expect(config.nezhaBoundary.successLogTextAsPassEvidence).toBe(false);
  expect(config.publicationPolicy).toEqual({ autoPublish: false, autoPush: false, modifiesPhaseStatus: false, npmPublishRequires: 'owner-approved-after-acceptance' });
});

it('[case:p08-aggregate-three-state] 缺失结果与负责人未确认记 not_run；缺证据类别记 fail；人工不可代签', () => {
  const checklist = loadP08Checklist(join(ROOT, P08_CHECKLIST_PATH));
  // 全部结果缺失：必需检查全部 not_run，结论不能通过。
  const allMissing = aggregateP08CheckResults(checklist, []);
  expect(allMissing.counts.pass).toBe(0);
  expect(allMissing.counts.not_run).toBe(P08_REQUIRED_CHECK_IDS.length);
  expect(allMissing.conclusion).toBe('fail');
  expect(allMissing.checks.every(check => check.status === 'not_run')).toBe(true);

  const manualItem = checklist.items.find(item => item.execution === 'manual')!;
  const offlineItem = checklist.items.find(item => item.execution === 'offline')!;

  // 负责人 pending：即使机器部分成功也保持 not_run，不折算通过。
  const pending = aggregateP08CheckResults(checklist, [{
    checkId: manualItem.id, status: 'pass', executionMode: 'manual', manualStatus: 'pending', evidence: [...manualItem.evidence],
  }]);
  expect(pending.checks.find(check => check.id === manualItem.id)?.status).toBe('not_run');

  // 声称通过但缺少必需证据类别 → fail。
  const missingEvidence = aggregateP08CheckResults(checklist, [{
    checkId: offlineItem.id, status: 'pass', executionMode: 'fake', evidence: offlineItem.evidence.slice(1),
  }]);
  expect(missingEvidence.checks.find(check => check.id === offlineItem.id)?.status).toBe('fail');

  // 执行类别不匹配（offline 检查被 live 结果替代）→ fail。
  const wrongMode = aggregateP08CheckResults(checklist, [{
    checkId: offlineItem.id, status: 'pass', executionMode: 'live', evidence: [...offlineItem.evidence],
  }]);
  expect(wrongMode.checks.find(check => check.id === offlineItem.id)?.status).toBe('fail');

  // 人工确认 + 完整证据 → 该项 pass；机器不能代签（manualStatus 缺失即不算确认）。
  const confirmed = aggregateP08CheckResults(checklist, [{
    checkId: manualItem.id, status: 'pass', executionMode: 'manual', manualStatus: 'confirmed', evidence: [...manualItem.evidence],
  }]);
  expect(confirmed.checks.find(check => check.id === manualItem.id)?.status).toBe('pass');
  const machineSigned = aggregateP08CheckResults(checklist, [{
    checkId: manualItem.id, status: 'pass', executionMode: 'manual', evidence: [...manualItem.evidence],
  }]);
  expect(machineSigned.checks.find(check => check.id === manualItem.id)?.status).toBe('not_run');

  // 结果身份校验：未知/重复检查拒绝；deferred 不参与通过计数。
  expect(rejected(() => aggregateP08CheckResults(checklist, [{ checkId: 'P08-UNKNOWN', status: 'pass', executionMode: 'fake' }])).kind).toBe('invalid_config');
  expect(rejected(() => aggregateP08CheckResults(checklist, [
    { checkId: offlineItem.id, status: 'pass', executionMode: 'fake', evidence: [...offlineItem.evidence] },
    { checkId: offlineItem.id, status: 'pass', executionMode: 'fake', evidence: [...offlineItem.evidence] },
  ])).kind).toBe('invalid_config');
  const deferred = aggregateP08CheckResults(checklist, P08_DEFERRED_IDS.map(id => {
    const item = checklist.items.find(entry => entry.id === id)!;
    return { checkId: id, status: 'pass' as const, executionMode: 'fake' as const, evidence: [...item.evidence] };
  }));
  expect(deferred.counts).toEqual({ pass: 0, fail: 0, not_run: P08_REQUIRED_CHECK_IDS.length });
});

it('[case:p08-local-contract-only] 本 Task 只验证结构/唯一性/允许值，前序交付路径真实存在且契约可摘要', () => {
  // 前序 Feature 交付输入路径按实际交付核对，不凭空写死。
  for (const feature of P08_PREREQUISITE_FEATURES) {
    const input = P08_PREREQUISITE_INPUTS[feature];
    expect(input.reports.length).toBeGreaterThan(0);
    for (const path of [...input.reports, ...input.machineReadable]) {
      expect(existsSync(join(ROOT, path))).toBe(true);
    }
    if (input.liveEvidenceKind !== null) expect(Object.values(P08_LIVE_EVIDENCE_KINDS)).toContain(input.liveEvidenceKind);
  }
  expect(P08_PREREQUISITE_INPUTS['P08-2'].liveEvidenceKind).toBe('shiploop.todo.live-evidence');
  expect(P08_PREREQUISITE_INPUTS['P08-3'].liveEvidenceKind).toBe('shiploop.brownfield.evidence-envelope');
  expect(P08_PREREQUISITE_INPUTS['P08-1'].machineReadable).toEqual(['acceptance/p08-1.release-manifest.json']);

  // 契约说明文档存在且明确 not_run 不折算。
  const doc = readFileSync(join(ROOT, 'docs/phases/p08/p08-acceptance.md'), 'utf8');
  expect(doc).toContain('not_run');
  expect(doc).toContain('Nezha');

  // 模块保持纯结构校验：仅允许 node 内置模块，不导入进程/网络/数据库/产品包。
  const source = readFileSync(join(ROOT, 'scripts/acceptance/p08-config.ts'), 'utf8');
  const imports = [...source.matchAll(/^import .*?from '([^']+)';$/gm)].map(match => match[1]);
  expect(imports.length).toBeGreaterThan(0);
  for (const specifier of imports) expect(specifier.startsWith('node:')).toBe(true);

  // 清单/模式摘要稳定且可区分。
  const checklist = loadP08Checklist(join(ROOT, P08_CHECKLIST_PATH));
  expect(digestP08Checklist(checklist)).toBe(digestP08Checklist(loadP08Checklist(join(ROOT, P08_CHECKLIST_PATH))));
  const mutated = clone(checklist);
  (mutated.items[0].assertions as string[]).push('漂移');
  expect(digestP08Checklist(mutated)).not.toBe(digestP08Checklist(checklist));
  expect(digestP08ExecutionMode('default')).not.toBe(digestP08ExecutionMode('full'));

  // 预算校验：非法预算拒绝。
  expect(() => validateP08Budget({ stepMs: 900000, overallMs: 1800000 })).not.toThrow();
  for (const bad of [{ stepMs: 0, overallMs: 1 }, { stepMs: -1, overallMs: 1 }, { stepMs: 1.5, overallMs: 2 }, { stepMs: 2000, overallMs: 1000 }]) {
    expect(rejected(() => validateP08Budget(bad)).kind).toBe('invalid_config');
  }
  // 冻结清单本身通过校验且 ID 唯一。
  expect(new Set(P08_FROZEN_ITEMS.map(item => item.id)).size).toBe(P08_FROZEN_ITEMS.length);
  expect(validateP08Checklist(json(join(ROOT, P08_CHECKLIST_PATH)))).toEqual(checklist);
});
