/**
 * P07-5 / F-010 逐项核验证据的 P07 恢复演练报告与离线完整性检查
 * （开发验收工具，不进 packages/；只读证据消费者，不更新产品或 Harness 状态）。
 *
 * 复用 P06 的报告身份与离线核验模式（scripts/acceptance/p06-report.ts），按
 * P07-5 冻结清单（p07-config.ts）逐项核验：
 *
 * - **报告面**：JSON 报告 + 可读摘要汇总当前 commit、输入摘要、前置基线
 *   （P07-1～P07-4 交付/祖先核验）、工具链、实际命令/退出码/用时、逐项
 *   pass/fail/not_run 与已知限制；记录可作为下一阶段候选基线的提交，但
 *   phaseAccepted 恒为 false、ownerSignature 恒为 pending——机器报告不能替
 *   负责人签署；
 * - **逐项判定**：fr 项聚合全部场景记录、scenario 项绑定自身 checkId；每项
 *   按冻结 evidence 类别核验 sqlite/git/process/artifact/manifest/budget/
 *   notification/archive/command-exit/usage/cleanup 事实（逐文件 hash/size/
 *   身份/类别结构）；'report' 由真实产品报告（features.report.get，经
 *   validateP05ProductCapture + validateAppQueryResponse 核验实体与本次身份）
 *   提供，'sha' 由报告身份/文件清单提供，'manual' 由负责人门禁记录提供；
 *   缺失、错误身份、伪造分类、零断言或仅退出码 0 均不得形成通过；
 * - **三态保留**：负例正确拒绝与场景执行错误在检查内分别呈现；
 *   unsupported/not_run/deferred 与 cleanup_unconfirmed 显式展示且不计通过；
 *   人工门禁 pending/rejected 不由机器代签；
 * - **发布纪律**：runId 目录一次性预留（EEXIST 保留旧运行）；生成或回读校验
 *   失败写入 diagnostic.json 并返回失败，不覆写旧运行；发布目录自包含，临时
 *   数据根删除后仍可离线核验（重放构建 + 文件清单 + 摘要一致性）。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除运行。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { P07_PHYSICAL_STEPS } from './p07-plan.ts';
import { validateAppQueryResponse } from '../../packages/host/src/client/app-wire.ts';
import { validateP05ProductCapture } from './p05-product-evidence.ts';
import {
  digestP07Checklist, evaluateP07Prerequisites, loadP07Checklist, validateP07Checklist, P07_ENTRY_STEP_ORDER,
  type P07Checklist, type P07PrerequisiteEvaluation, type P07PrerequisiteInput, type P07ReportStatus,
} from './p07-config.ts';
import { assertP07Identity, hashP07Bytes, hashP07Input, safeP07Json, safeP07Text, verifyP07Scenario, type P07EvidenceIdentity, type P07ScenarioRecord } from './p07-evidence.ts';

/* ------------------------------------------------------------------ *
 * 输入与报告类型
 * ------------------------------------------------------------------ */

export type P07ReportCheckInput = {
  readonly checkId: string;
  readonly status: P07ReportStatus;
  readonly executionMode: 'fake' | 'manual' | 'postponed';
  readonly reason: string | null;
};
/** 负责人门禁记录是外部输入，绝不由本聚合器生成或签署。 */
export type P07GateCapture = P07EvidenceIdentity & {
  readonly schemaVersion: 1;
  readonly execution: 'manual';
  readonly producer: 'owner';
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly usage: { readonly source: 'reported'; readonly requests: number };
  readonly cleanup: { readonly confirmed: boolean; readonly processesGone: boolean; readonly resourcesRemoved: boolean };
  readonly manual: {
    readonly status: 'pending' | 'confirmed' | 'rejected';
    readonly confirmedBy: string;
    readonly confirmedAt: string;
    readonly decision: 'approved' | 'rejected';
  };
};
export type P07ReportInput = {
  readonly identity: P07EvidenceIdentity;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly prerequisites: readonly P07PrerequisiteInput[];
  readonly checks: readonly P07ReportCheckInput[];
  readonly scenarios: readonly P07ScenarioRecord[];
  readonly products: readonly { readonly path: string }[];
  readonly entry?: { readonly path: string };
  readonly gates?: readonly { readonly path: string; readonly execution: 'manual' }[];
  readonly knownGaps: readonly string[];
};
export type P07ReportScenarioSummary = {
  readonly checkId: string;
  readonly attempt: number;
  readonly status: P07ReportStatus;
  readonly expectation: string;
  readonly positiveAssertions: readonly string[];
  readonly expectedRejections: readonly string[];
  readonly executionErrors: readonly string[];
};
export type P07ReportCheck = {
  readonly checkId: string;
  readonly title: string;
  readonly execution: string;
  readonly group: string;
  readonly status: P07ReportStatus;
  readonly reason: string | null;
  readonly scenarios: readonly P07ReportScenarioSummary[];
  readonly evidence: readonly { readonly category: string; readonly path: string }[];
};
export type P07ReportFile = { readonly path: string; readonly sha256: string; readonly sizeBytes: number };
export type P07AcceptanceReport = {
  readonly schemaVersion: 1;
  readonly phase: 'P07';
  readonly layer: 'phase-acceptance';
  readonly identity: P07EvidenceIdentity;
  readonly checklist: P07Checklist;
  readonly checklistDigest: string;
  readonly request: P07ReportInput;
  readonly prerequisites: P07PrerequisiteEvaluation;
  readonly checks: readonly P07ReportCheck[];
  readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number };
  readonly offlineConclusion: 'pass' | 'fail';
  readonly executionScope: { readonly mode: 'phase' | 'full'; readonly selectedFileCount: number; readonly fullHistoryStatus: P07ReportStatus; readonly fullHistoryStepId: string | null } | null;
  readonly conclusion: 'pass' | 'fail';
  readonly exitCode: 0 | 1;
  readonly blockingIssues: readonly string[];
  readonly knownGaps: readonly string[];
  /** 候选基线：记录受测提交，但不签署阶段；负责人确认前不得作为已验收基线。 */
  readonly baseline: {
    readonly candidateCommit: string;
    readonly phaseAccepted: false;
    readonly ownerSignature: 'pending';
    readonly note: string;
  };
  readonly commands: readonly { readonly scenarioId: string; readonly attempt: number; readonly argv: readonly string[]; readonly exitCode: number | null; readonly durationMs: number }[];
  readonly productReports: readonly { readonly featureId: string; readonly path: string }[];
  readonly files: readonly P07ReportFile[];
};

const fail = (code: string): never => { throw new Error(code); };
const same = (a: unknown, b: unknown): boolean => hashP07Input(a) === hashP07Input(b);
const matchesIdentity = (a: P07EvidenceIdentity, b: P07EvidenceIdentity): boolean => a.runId === b.runId && a.testedCommit === b.testedCommit && a.inputDigest === b.inputDigest;

/* ------------------------------------------------------------------ *
 * 文件系统纪律
 * ------------------------------------------------------------------ */

function keys(value: object, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_schema');
}
function noLinks(path: string): void {
  const lexical = resolve(path);
  const temporary = resolve(tmpdir());
  let current = lexical.startsWith(temporary + sep) ? realpathSync(temporary) + lexical.slice(temporary.length) : lexical;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('directory_symlink');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function relativePath(path: string): string {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.json$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) fail('unsafe_path');
  return path;
}
function readFile(directory: string, path: string): Buffer {
  const target = join(directory, relativePath(path));
  noLinks(target);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || stat.size < 1) fail('invalid_evidence_file');
  const bytes = readFileSync(target);
  safeP07Text(bytes.toString('utf8'));
  JSON.parse(bytes.toString('utf8'));
  return bytes;
}
function parse(directory: string, path: string): unknown {
  return JSON.parse(readFile(directory, path).toString('utf8'));
}
function filesIn(directory: string, prefix = ''): string[] {
  noLinks(directory);
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('directory_symlink');
    const path = prefix + entry.name;
    if (entry.isDirectory()) {
      const children = filesIn(join(directory, entry.name), path + '/');
      if (!children.length) fail('unexpected_directory');
      result.push(...children);
    } else if (entry.isFile()) result.push(path);
    else fail('invalid_directory_entry');
  }
  return result.sort();
}

/* ------------------------------------------------------------------ *
 * 输入校验
 * ------------------------------------------------------------------ */

function validateInput(input: P07ReportInput, checklist: P07Checklist): void {
  keys(input, ['identity', 'toolchain', 'prerequisites', 'checks', 'scenarios', 'products', 'entry', 'gates', 'knownGaps']);
  assertP07Identity(input.identity);
  if (!input.toolchain || !Object.keys(input.toolchain).length || Object.values(input.toolchain).some(value => typeof value !== 'string' || !value)
    || !Array.isArray(input.knownGaps) || input.knownGaps.some(gap => typeof gap !== 'string' || !gap)) fail('invalid_metadata');

  const ids = new Set<string>();
  for (const check of input.checks) {
    keys(check, ['checkId', 'status', 'executionMode', 'reason']);
    const itemCandidate = checklist.items.find(candidate => candidate.id === check.checkId);
    if (!itemCandidate) fail('unknown_check');
    const item = itemCandidate!;
    if (ids.has(check.checkId)) fail('duplicate_check');
    ids.add(check.checkId);
    if (!['pass', 'fail', 'not_run'].includes(check.status)) fail('invalid_status');
    const expectedMode = item.execution === 'offline' ? 'fake' : item.execution === 'manual' ? 'manual' : 'postponed';
    if (check.executionMode !== expectedMode) fail('execution_mismatch');
    if (item.group === 'deferred' && check.status !== 'not_run') fail('deferred_must_be_not_run');
    if (typeof check.reason !== 'string' && check.reason !== null) fail('invalid_status');
  }
  if (checklist.items.some(item => item.group !== 'deferred' && !ids.has(item.id))) fail('missing_required_check');

  const slots = new Set<string>();
  const offlineIds = new Set(checklist.items.filter(item => item.group !== 'deferred' && item.execution === 'offline').map(item => item.id));
  for (const record of input.scenarios) {
    if (!offlineIds.has(record.checkId)) fail('unknown_check');
    const slot = `${record.checkId}-a${record.attempt}`;
    if (slots.has(slot)) fail('duplicate_scenario');
    slots.add(slot);
  }
  safeP07Json(input);
}

/* ------------------------------------------------------------------ *
 * 门禁与入口记录
 * ------------------------------------------------------------------ */

function validateGate(value: unknown, expected: P07EvidenceIdentity): P07GateCapture {
  const gate = value as P07GateCapture;
  keys(gate, ['schemaVersion', 'runId', 'testedCommit', 'inputDigest', 'execution', 'producer', 'command', 'exitCode', 'usage', 'cleanup', 'manual']);
  if (gate.schemaVersion !== 1 || !matchesIdentity({ runId: gate.runId, testedCommit: gate.testedCommit, inputDigest: gate.inputDigest }, expected)
    || gate.execution !== 'manual' || gate.producer !== 'owner') fail('gate_identity_mismatch');
  keys(gate.usage, ['source', 'requests']);
  keys(gate.cleanup, ['confirmed', 'processesGone', 'resourcesRemoved']);
  if (!Array.isArray(gate.command) || !gate.command.length || gate.command.some(part => typeof part !== 'string' || !part)
    || !Number.isSafeInteger(gate.exitCode) || gate.exitCode < 0 || gate.usage.source !== 'reported'
    || !Number.isSafeInteger(gate.usage.requests) || gate.usage.requests < 0
    || Object.values(gate.cleanup).some(value_ => typeof value_ !== 'boolean')) fail('invalid_gate');
  const manual = gate.manual;
  keys(manual, ['status', 'confirmedBy', 'confirmedAt', 'decision']);
  if (!['pending', 'confirmed', 'rejected'].includes(manual.status) || !['approved', 'rejected'].includes(manual.decision)
    || typeof manual.confirmedBy !== 'string' || !manual.confirmedBy
    || !/^\d{4}-\d\d-\d\dT.*Z$/.test(manual.confirmedAt) || !Number.isFinite(Date.parse(manual.confirmedAt))) fail('invalid_manual');
  return gate;
}

type EntryStep = {
  id: string; argv: string[]; status: P07ReportStatus; exitCode: number | null;
  timedOut: boolean; stoppedVerified: boolean | null; durationMs: number | null;
};
function readEntryCapture(directory: string, ref: { readonly path: string }, expected: P07EvidenceIdentity) {
  keys(ref, ['path']);
  if (!/^entry\/[\w-]+\.json$/.test(ref.path)) fail('invalid_entry_path');
  const raw = parse(directory, ref.path) as Record<string, any>;
  keys(raw, ['schemaVersion', 'runId', 'testedCommit', 'inputDigest', 'steps', 'cleanup', 'sourceDrift', 'elapsedMs', 'overallTimeoutMs', 'selectedFiles', ...(raw.schemaVersion === 2 ? ['bindings', 'scope', 'fullHistory'] : [])]);
  if (![1, 2].includes(raw.schemaVersion) || !matchesIdentity({ runId: raw.runId, testedCommit: raw.testedCommit, inputDigest: raw.inputDigest }, expected)
    || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > P07_ENTRY_STEP_ORDER.length) fail('invalid_entry_identity');
  const expectedOrder = raw.schemaVersion === 2
    ? P07_PHYSICAL_STEPS.filter(id => id !== 'p07-recovery-scenarios' || raw.steps.some((step: EntryStep) => step.id === id))
    : [...P07_ENTRY_STEP_ORDER];
  if (raw.schemaVersion === 2) {
    if (raw.steps.length !== expectedOrder.length || !Array.isArray(raw.bindings) || raw.bindings.length !== expectedOrder.length
      || !raw.scope || !Array.isArray(raw.scope.selected) || !Array.isArray(raw.scope.deferred)) fail('invalid_entry_scope');
    const bound: string[] = [];
    raw.bindings.forEach((binding: { id: string; tests: string[] }, index: number) => {
      keys(binding, ['id', 'tests']);
      if (binding.id !== expectedOrder[index] || !Array.isArray(binding.tests)) fail('invalid_entry_scope');
      bound.push(...binding.tests);
    });
    if (new Set(bound).size !== bound.length || !same([...bound].sort(), [...raw.selectedFiles].sort())
      || raw.scope.selected.some((file: string) => !bound.includes(file))) fail('invalid_entry_scope');
    const full = raw.scope.policy === 'full-trusted-union';
    if (!full && raw.scope.policy !== 'p07-impact-and-required-regressions') fail('invalid_entry_scope');
    keys(raw.fullHistory, ['status', 'stepId']);
    const testStep = raw.steps.find((step: EntryStep) => step.id === 'p07-trusted-scope');
    if (!testStep || raw.fullHistory.status !== (full ? testStep.status : 'not_run') || raw.fullHistory.stepId !== (full ? testStep.id : null)) fail('invalid_full_history_binding');
  }
  const steps: EntryStep[] = raw.steps;
  steps.forEach((step, index) => {
    keys(step, ['id', 'argv', 'status', 'exitCode', 'timedOut', 'stoppedVerified', 'durationMs']);
    if (step.id !== expectedOrder[index] || !['pass', 'fail', 'not_run'].includes(step.status)
      || !Array.isArray(step.argv) || !step.argv.length || step.argv.some(part => typeof part !== 'string' || !part)
      || (step.exitCode !== null && (!Number.isSafeInteger(step.exitCode) || step.exitCode < 0)) || typeof step.timedOut !== 'boolean'
      || (step.stoppedVerified !== null && typeof step.stoppedVerified !== 'boolean')
      || (step.durationMs !== null && (!Number.isFinite(step.durationMs) || step.durationMs < 0))) fail('invalid_entry_step');
    if (step.status === 'pass' && (step.exitCode !== 0 || step.timedOut || step.stoppedVerified !== true || step.durationMs === null)) fail('invalid_entry_pass');
    if (step.status === 'not_run' && (step.exitCode !== null || step.timedOut || step.durationMs !== null)) fail('invalid_entry_not_run');
    if (index > 0 && steps.slice(0, index).some(previous => previous.status !== 'pass') && step.status !== 'not_run') fail('invalid_entry_continuation');
  });
  keys(raw.cleanup, ['processesGone', 'resourcesRemoved']);
  if (typeof raw.cleanup.processesGone !== 'boolean' || typeof raw.cleanup.resourcesRemoved !== 'boolean' || typeof raw.sourceDrift !== 'boolean'
    || !Number.isSafeInteger(raw.elapsedMs) || raw.elapsedMs < 0 || !Number.isSafeInteger(raw.overallTimeoutMs) || raw.overallTimeoutMs < 1000
    || !Array.isArray(raw.selectedFiles) || !raw.selectedFiles.length || new Set(raw.selectedFiles).size !== raw.selectedFiles.length
    || raw.selectedFiles.some((file: unknown) => typeof file !== 'string' || !/^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(ts|js)$/.test(file))) fail('invalid_entry_facts');
  return {
    steps,
    executionScope: raw.schemaVersion === 2 ? { mode: raw.scope.policy === 'full-trusted-union' ? 'full' as const : 'phase' as const,
      selectedFileCount: raw.selectedFiles.length, fullHistoryStatus: raw.fullHistory.status as P07ReportStatus, fullHistoryStepId: raw.fullHistory.stepId as string | null } : null,
    failed: steps.some(step => step.status !== 'pass') || !raw.cleanup.processesGone || !raw.cleanup.resourcesRemoved || raw.sourceDrift || raw.elapsedMs > raw.overallTimeoutMs,
  };
}

/* ------------------------------------------------------------------ *
 * 报告构建：从冻结清单与独立核验过的文件内容重算全部派生值
 * ------------------------------------------------------------------ */

export function buildP07AcceptanceReport(sourceDirectory: string, input: P07ReportInput, checklist = loadP07Checklist()): P07AcceptanceReport {
  validateP07Checklist(checklist);
  validateInput(input, checklist);
  const material = new Map<string, P07ReportFile>();
  function add(path: string): void {
    if (material.has(path)) return;
    const bytes = readFile(sourceDirectory, path);
    material.set(path, { path, sha256: hashP07Bytes(bytes), sizeBytes: bytes.length });
  }

  /* 前置基线：P07-1～P07-4 交付/接口/证据/祖先关系核验（不满足即阻塞）。 */
  const prerequisites = evaluateP07Prerequisites(input.prerequisites);

  const entry = input.entry ? readEntryCapture(sourceDirectory, input.entry, input.identity) : null;
  if (input.entry) add(input.entry.path);
  for (const record of input.scenarios) {
    if (record.status === 'not_run') continue;
    if (!verifyP07Scenario(sourceDirectory, record, input.identity).ok) fail('scenario_verification_failed');
    add(`${record.checkId}-a${record.attempt}/result.json`);
    for (const ref of record.evidenceRefs) add(ref.path);
  }

  /* 产品报告：真实 Core/Host features.report.get 捕获；实体与本次运行身份必须匹配。 */
  const productReports = input.products.map(product => {
    keys(product, ['path']);
    if (!/^products\/[\w-]+\.json$/.test(product.path) || material.has(product.path)) fail('invalid_product_path');
    const body = parse(sourceDirectory, product.path) as { report: unknown };
    const capture = validateP05ProductCapture(body, {
      runId: input.identity.runId, commit: input.identity.testedCommit, inputsDigest: input.identity.inputDigest,
    });
    validateAppQueryResponse('features.report.get', body.report);
    add(product.path);
    return { featureId: capture.featureId, path: product.path };
  });
  if (new Set(productReports.map(product => product.featureId)).size !== productReports.length) fail('duplicate_product');

  const gates = new Map<string, { gate: P07GateCapture; path: string }>();
  for (const ref of input.gates ?? []) {
    keys(ref, ['path', 'execution']);
    if (ref.execution !== 'manual' || gates.has(ref.execution) || !/^gates\/[\w-]+\.json$/.test(ref.path)) fail('invalid_gate_reference');
    const gate = validateGate(parse(sourceDirectory, ref.path), input.identity);
    add(ref.path);
    gates.set(ref.execution, { gate, path: ref.path });
  }

  const blockingIssues: string[] = [];
  if (!productReports.length) blockingIssues.push('missing_product_report');
  if (prerequisites.status === 'blocked') blockingIssues.push('prerequisites_blocked');

  const checks: P07ReportCheck[] = checklist.items.map(item => {
    const claim = input.checks.find(check => check.checkId === item.id);
    const evidence: { category: string; path: string }[] = [];
    let status: P07ReportStatus = claim?.status ?? 'not_run';
    let reason: string | null = claim?.reason ?? null;
    const records = (item.group === 'fr' ? input.scenarios : input.scenarios.filter(record => record.checkId === item.id))
      .filter(record => record.status !== 'not_run');
    const scenarioSummaries: P07ReportScenarioSummary[] = (item.group === 'fr' ? input.scenarios : input.scenarios.filter(record => record.checkId === item.id))
      .map(record => ({
        checkId: record.checkId, attempt: record.attempt, status: record.status, expectation: record.expectation,
        positiveAssertions: [...record.positiveAssertions],
        expectedRejections: record.expectedRejections.map(rejection => rejection.kind),
        executionErrors: record.executionErrors.map(error => error.kind),
      }));

    if (item.group === 'deferred') {
      status = 'not_run';
      reason = 'deferred_full_history_not_run';
    } else if (item.execution === 'manual') {
      const external = gates.get('manual');
      if (!external) {
        status = 'not_run';
        reason = 'owner_pending';
      } else {
        const gate = external.gate;
        // 每个类别是类型化子文档或独立核验过的产品，绝不复制同一段说明。
        for (const category of ['command-exit', 'usage', 'cleanup', 'manual']) evidence.push({ category, path: `${external.path}#${category}` });
        evidence.push({ category: 'manifest', path: 'report.json#files' }, { category: 'sha', path: 'report.json#identity' });
        for (const product of productReports) evidence.push({ category: 'report', path: product.path });
        if (gate.exitCode !== 0 || !Object.values(gate.cleanup).every(Boolean) || gate.manual.status === 'rejected' || gate.manual.decision === 'rejected') {
          status = 'fail';
          reason = 'external_gate_failed';
        } else if (gate.manual.status !== 'confirmed') {
          status = 'not_run';
          reason = 'owner_pending';
        } else {
          status = 'pass';
          reason = null;
        }
      }
    } else {
      // 离线项：fr 聚合全部场景，scenario 绑定自身 checkId。
      if (input.entry) evidence.push({ category: 'command-exit', path: `${input.entry.path}#steps` }, { category: 'cleanup', path: `${input.entry.path}#cleanup` });
      for (const record of records) {
        for (const ref of record.evidenceRefs) evidence.push({ category: ref.category, path: ref.path });
      }
      if (records.length) evidence.push({ category: 'sha', path: 'report.json#identity' });
      for (const product of productReports) evidence.push({ category: 'report', path: product.path });
      const missingScene = item.group !== 'fr' && input.scenarios.some(record => record.checkId === item.id && record.status === 'not_run');
      const failed = records.find(record => record.status === 'fail');
      if (prerequisites.status === 'blocked') {
        status = 'not_run';
        reason = 'prerequisites_blocked';
      } else if (entry?.failed) {
        status = 'fail';
        reason = 'entry_step_or_cleanup_failed';
      } else if (failed || status === 'fail') {
        status = 'fail';
        reason = failed?.reason ?? reason ?? 'check_failed';
      } else if (missingScene || status === 'not_run' || records.length === 0) {
        status = 'not_run';
        reason = missingScene ? 'required_scenarios_not_run' : records.length === 0 ? `missing_scenarios:${item.id}` : reason ?? 'not_run';
      } else {
        status = 'pass';
        reason = null;
      }
    }

    if (status === 'pass') {
      const available = new Set(evidence.map(entry_ => entry_.category));
      const missing = item.evidence.filter(category => !available.has(category));
      if (missing.length) {
        status = 'fail';
        reason = `missing_categories:${missing.join(',')}`;
      }
    }
    if (item.group !== 'deferred' && status !== 'pass') blockingIssues.push(`${item.id}:${reason ?? status}`);
    return { checkId: item.id, title: item.title, execution: item.execution, group: item.group, status, reason, scenarios: scenarioSummaries, evidence };
  });

  // 场景失败不被无关声明或后续成功掩盖。
  for (const record of input.scenarios.filter(record_ => record_.status === 'fail')) {
    blockingIssues.push(`${record.checkId}-a${record.attempt}:${record.reason ?? record.outcome}`);
  }
  const required = checks.filter(check => check.group !== 'deferred');
  const counts = {
    pass: required.filter(check => check.status === 'pass').length,
    fail: required.filter(check => check.status === 'fail').length,
    not_run: required.filter(check => check.status === 'not_run').length,
  };
  const offlineConclusion = required.filter(check => check.execution === 'offline').every(check => check.status === 'pass') && productReports.length > 0 ? 'pass' : 'fail';
  const conclusion = blockingIssues.length === 0 ? 'pass' : 'fail';
  return {
    schemaVersion: 1,
    phase: 'P07',
    layer: 'phase-acceptance',
    identity: input.identity,
    checklist,
    checklistDigest: digestP07Checklist(checklist),
    request: input,
    prerequisites,
    checks,
    counts,
    offlineConclusion,
    executionScope: entry?.executionScope ?? null,
    conclusion,
    exitCode: conclusion === 'pass' ? 0 : 1,
    blockingIssues,
    knownGaps: [...input.knownGaps, ...checks.filter(check => check.status === 'not_run').map(check => `${check.checkId}:${check.reason}`)],
    baseline: {
      candidateCommit: input.identity.testedCommit,
      phaseAccepted: false,
      ownerSignature: 'pending',
      note: '机器报告不能替负责人签署；负责人确认前该提交只是候选基线，不得作为已验收基线',
    },
    commands: [
      ...input.scenarios.map(record => ({ scenarioId: record.checkId, attempt: record.attempt, argv: record.command, exitCode: record.exitCode, durationMs: record.durationMs })),
      ...(entry?.steps.map(step => ({ scenarioId: `entry/${step.id}`, attempt: 1, argv: step.argv, exitCode: step.exitCode, durationMs: step.durationMs ?? 0 })) ?? []),
      ...(gates.get('manual') ? [{ scenarioId: 'manual-gate', attempt: 1, argv: gates.get('manual')!.gate.command, exitCode: gates.get('manual')!.gate.exitCode, durationMs: 0 }] : []),
    ],
    productReports,
    files: [...material.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/* ------------------------------------------------------------------ *
 * 可读摘要
 * ------------------------------------------------------------------ */

export function renderP07Summary(report: P07AcceptanceReport): string {
  const cell = (value: string) => value.replace(/[|\r\n]/g, ' ');
  const prerequisiteLines = report.request.prerequisites.map(input => `- ${input.feature}: ${input.commit} ${report.prerequisites.status === 'satisfied' ? 'satisfied' : 'blocked'}`);
  const commandLines = report.commands.map(command => `- ${cell(command.scenarioId)} a${command.attempt}: exit=${command.exitCode ?? 'null'} ${command.durationMs}ms argv=${cell(JSON.stringify(command.argv))}`);
  return `# P07 acceptance\n\nRun: ${report.identity.runId}\nCommit: ${report.identity.testedCommit}\nInput: ${report.identity.inputDigest}\nChecklist: ${report.checklistDigest}\n\nPrerequisites: ${report.prerequisites.status}\n${prerequisiteLines.join('\n')}\n\nToolchain: ${cell(JSON.stringify(report.request.toolchain))}\nOffline: ${report.offlineConclusion}; phase: ${report.conclusion}\nScope: ${report.executionScope?.mode ?? 'unspecified'}; full history: ${report.executionScope?.fullHistoryStatus ?? 'not_run'}\nPass: ${report.counts.pass}; fail: ${report.counts.fail}; not_run: ${report.counts.not_run}\n\n| Check | Execution | Status | Reason |\n| --- | --- | --- | --- |\n${report.checks.map(check => `| ${check.checkId} | ${check.execution} | ${check.status} | ${cell(check.reason ?? '')} |`).join('\n')}\n\nScenario assertions (positive / expected rejections / execution errors):\n${report.checks.flatMap(check => check.scenarios.map(scenario => `- ${cell(`${check.checkId} a${scenario.attempt}`)}: ${scenario.status}; +${scenario.positiveAssertions.length} reject=${scenario.expectedRejections.join(',')} errors=${scenario.executionErrors.join(',')}`)).join('\n')}\n\nCommands:\n${commandLines.join('\n')}\n\nProduct reports: ${report.productReports.map(product => `${product.featureId}@${product.path}`).join(', ') || 'none'}\n\nBaseline candidate: ${report.baseline.candidateCommit} (phaseAccepted=${report.baseline.phaseAccepted}, ownerSignature=${report.baseline.ownerSignature})\n${report.baseline.note}\n\nBlocking issues:\n${report.blockingIssues.map(issue => `- ${cell(issue)}`).join('\n')}\n\nKnown gaps:\n${report.knownGaps.map(gap => `- ${cell(gap)}`).join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 离线核验与发布
 * ------------------------------------------------------------------ */

export function verifyP07ReportDirectory(directory: string, expected: P07EvidenceIdentity): { ok: boolean; exitCode: 0 | 1; problems: string[] } {
  try {
    assertP07Identity(expected);
    noLinks(directory);
    const report = parse(directory, 'report.json') as P07AcceptanceReport;
    if (!matchesIdentity(report.identity, expected)) fail('report_identity_mismatch');
    const rebuilt = buildP07AcceptanceReport(directory, report.request, validateP07Checklist(report.checklist));
    if (!same(report, rebuilt)) fail('report_schema_or_aggregation_mismatch');
    const expectedFiles = ['report.json', 'summary.md', ...report.files.map(file => file.path)].sort();
    if (!same(filesIn(directory), expectedFiles)) fail('directory_manifest_mismatch');
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
    safeP07Text(summary);
    if (summary !== renderP07Summary(report)) fail('summary_mismatch');
    return { ok: true, exitCode: report.exitCode, problems: [] };
  } catch {
    return { ok: false, exitCode: 1, problems: ['p07_report_verification_failed'] };
  }
}

export function writeP07AcceptanceReport(options: { reportRoot: string; sourceDirectory: string; input: P07ReportInput; checklist?: P07Checklist }) {
  // 先预留运行目录；EEXIST 保留整个旧运行不被触碰。
  assertP07Identity(options.input.identity);
  noLinks(options.reportRoot);
  mkdirSync(options.reportRoot, { recursive: true, mode: 0o700 });
  const directory = join(options.reportRoot, options.input.identity.runId);
  mkdirSync(directory, { mode: 0o700 });
  let report: P07AcceptanceReport | null = null;
  try {
    report = buildP07AcceptanceReport(options.sourceDirectory, options.input, options.checklist);
    for (const ref of report.files) {
      const target = join(directory, ref.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = readFile(options.sourceDirectory, ref.path);
      if (hashP07Bytes(bytes) !== ref.sha256 || bytes.length !== ref.sizeBytes) fail('source_changed');
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(directory, 'report.json'), safeP07Json(report), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'summary.md'), safeP07Text(renderP07Summary(report)), { flag: 'wx', mode: 0o600 });
    const verification = verifyP07ReportDirectory(directory, options.input.identity);
    if (!verification.ok) fail('report_readback_failed');
    return { directory, report, verification, exitCode: report.exitCode };
  } catch {
    const verification = { ok: false, exitCode: 1 as const, problems: ['p07_report_publication_failed'] };
    // 诊断不含调用方文本、扫描命中或文件系统错误信息。
    writeFileSync(join(directory, 'diagnostic.json'), JSON.stringify(verification, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { directory, report: null, verification, exitCode: 1 as const };
  }
}
