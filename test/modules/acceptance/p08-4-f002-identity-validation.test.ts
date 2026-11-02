/**
 * P08-4 / F-002 P08 前置交付、受测源码与外部证据身份校验测试
 * （unit：真实临时文件 + 注入式祖先检查，不使用真实 Git/SQLite/Host/模型）。
 *
 * 守护对象：`scripts/acceptance/p08-identity.ts` 的 fail-closed 身份校验：
 * 1) 前置 P08-1～P08-3 交付基线记录逐项校验 feature 身份、commit 格式、交付
 *    状态、接口满足声明、交付证据与和受测 HEAD 的祖先关系；任一缺失或不匹
 *    配都形成 blocked/not_run，不产生验收通过；
 * 2) P08 运行建立不可变输入摘要（配置、清单、前置交付、工具链、适用测试范
 *    围与外部报告引用），源码 HEAD/哈希/文件集合/工具链漂移 fail-closed；
 * 3) 外部 Todo Live、存量 Live、安装产物与人工门禁记录分别校验来源 kind、
 *    runId、commit、输入摘要、结构版本与允许状态；错误身份、重复引用、损坏
 *    JSON、未知字段或陈旧 commit（非受测 HEAD 祖先）被拒绝；导入只读，不改
 *    写被引用的证据文件；
 * 4) 校验失败在独立运行目录写入脱敏诊断：不含开发机绝对路径与凭据，重复
 *    runId 时保留旧运行证据并写入独立诊断目录，不覆盖任何已有文件；
 * 5) 真实前序报告与 Live 运行是否存在由 Phase 入口（F-007）核对；本文件只
 *    验证身份契约本身。仓库内真实发布清单作为结构核对的实物样本。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  P08_IDENTITY_DIAGNOSTIC_KIND,
  P08_INSTALL_MANIFEST_KIND,
  P08_MANUAL_GATE_RECORD_KIND,
  P08_PREREQUISITE_BASELINE_KIND,
  buildP08RunIdentity,
  collectP08TestedSourceFiles,
  digestP08RunInputs,
  hashP08SourceInputs,
  importP08ExternalEvidence,
  p08DetectInputDrift,
  p08EvaluatePrerequisiteBaselines,
  p08IdentityFailureFromError,
  p08IdentityFailuresFromPrerequisites,
  p08SanitizeDiagnosticText,
  reserveP08RunDirectory,
  validateP08ExternalEvidenceReferences,
  validateP08InstallManifest,
  validateP08ManualGateRecord,
  validateP08PrerequisiteBaselines,
  writeP08IdentityDiagnostics,
  type P08ExternalEvidenceReference,
  type P08IdentityFailure,
  type P08RunInputsMaterial,
} from '../../../scripts/acceptance/p08-identity.ts';
import { P08_PREREQUISITE_FEATURES, p08RunIdentityMatches } from '../../../scripts/acceptance/p08-config.ts';
import { aggregateTodoLiveEvidence, type TodoLiveEvidenceReport } from '../../../scripts/acceptance/p08-todo-live-report.ts';
import { runTodoLiveDelivery, type TodoLiveDeliveryPorts, type TodoLiveTask } from '../../../scripts/acceptance/p08-todo-live.ts';
import { collectBrownfieldEvidenceEnvelope } from '../../../packages/core/src/ports/brownfield-evidence.ts';
import {
  computeBrownfieldCheckCommandDigest,
  type BrownfieldCheckDefinition,
  type BrownfieldCheckResult,
  type BrownfieldCheckSnapshot,
  type BrownfieldCodeIdentity,
} from '../../../packages/core/src/ports/brownfield.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const HEAD = 'b'.repeat(40);
const ANCESTOR = 'a'.repeat(40);
const SHA = /^[a-f0-9]{64}$/;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const alwaysAncestor = (): boolean => true;
const neverAncestor = (): boolean => false;

function rejectedBy<T>(action: () => T): { code: string; stage: string } {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toEqual(expect.stringMatching(/^p08_/));
    expect((error as { stage?: string }).stage).toEqual(expect.stringMatching(/^(baselines|run-directory|inputs|external-evidence|diagnostics)$/));
    return { code: (error as { code: string }).code, stage: (error as { stage: string }).stage };
  }
  throw new Error('expected P08 identity rejection');
}
async function rejectedByAsync<T>(action: () => Promise<T>): Promise<{ code: string; stage: string }> {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toEqual(expect.stringMatching(/^p08_/));
    expect((error as { stage?: string }).stage).toEqual(expect.stringMatching(/^(baselines|run-directory|inputs|external-evidence|diagnostics)$/));
    return { code: (error as { code: string }).code, stage: (error as { stage: string }).stage };
  }
  throw new Error('expected P08 identity rejection');
}

/* ------------------------------------------------------------------ *
 * 前置交付基线记录
 * ------------------------------------------------------------------ */

function baselineFile(): {
  schemaVersion: number; kind: string; approvedBy: string;
  features: { feature: string; commit: string; delivered: boolean; interfacesSatisfied: boolean; deliveryEvidence: string[]; publicInterfaces: string[] }[];
} {
  return {
    schemaVersion: 1, kind: P08_PREREQUISITE_BASELINE_KIND, approvedBy: 'owner-1',
    features: ['P08-1', 'P08-2', 'P08-3'].map(feature => ({
      feature, commit: ANCESTOR, delivered: true, interfacesSatisfied: true,
      deliveryEvidence: [`docs/acceptance/${feature.toLowerCase()}-delivery-report.md`], publicInterfaces: ['Core/Host/CLI'],
    })),
  };
}

it('[case:p08-f002-baseline-records] 前置交付基线：feature 身份/commit/交付/接口/证据逐项校验，缺失或不匹配阻止通过', () => {
  const baselines = validateP08PrerequisiteBaselines(baselineFile());
  expect(baselines.features.map(feature => feature.feature)).toEqual([...P08_PREREQUISITE_FEATURES]);

  // 满足全部条件且祖先关系成立 → satisfied/pass。
  const satisfied = p08EvaluatePrerequisiteBaselines(baselines, HEAD, alwaysAncestor);
  expect(satisfied).toMatchObject({ status: 'satisfied', resultStatus: 'pass', blockedFeatures: [], blockers: [] });
  expect(p08IdentityFailuresFromPrerequisites(satisfied)).toEqual([]);

  // 结构拒绝：未知/重复/缺失 feature、未知字段、凭据字段、绝对路径证据。
  expect(rejectedBy(() => validateP08PrerequisiteBaselines({ ...baselineFile(), unknownField: 1 })).code).toBe('p08_baseline_structure_invalid');
  const duplicate = baselineFile(); duplicate.features.push(clone(duplicate.features[0]));
  expect(rejectedBy(() => validateP08PrerequisiteBaselines(duplicate)).code).toBe('p08_baseline_structure_invalid');
  const missing = baselineFile(); missing.features.pop();
  expect(rejectedBy(() => validateP08PrerequisiteBaselines(missing)).code).toBe('p08_baseline_structure_invalid');
  const unknownFeature = baselineFile(); unknownFeature.features[0].feature = 'P08-9';
  expect(rejectedBy(() => validateP08PrerequisiteBaselines(unknownFeature)).code).toBe('p08_baseline_structure_invalid');
  const credential = baselineFile(); (credential as Record<string, unknown>).apiToken = 'x';
  expect(rejectedBy(() => validateP08PrerequisiteBaselines(credential)).code).toBe('p08_baseline_structure_invalid');
  const absoluteEvidence = baselineFile(); absoluteEvidence.features[0].deliveryEvidence = ['/Users/owner/secret-report.md'];
  expect(rejectedBy(() => validateP08PrerequisiteBaselines(absoluteEvidence)).code).toBe('p08_baseline_structure_invalid');

  // 语义阻断：未交付/接口不满足/非法 commit/证据或接口清单缺失 → blocked/not_run。
  const notDelivered = clone(baselineFile()); notDelivered.features[1].delivered = false;
  const evaluation = p08EvaluatePrerequisiteBaselines(validateP08PrerequisiteBaselines(notDelivered), HEAD, alwaysAncestor);
  expect(evaluation).toMatchObject({ status: 'blocked', resultStatus: 'not_run' });
  expect(evaluation.blockedFeatures).toEqual(['P08-2']);
  const failures = p08IdentityFailuresFromPrerequisites(evaluation);
  expect(failures.map(failure => failure.code)).toContain('p08_baseline_not_delivered');

  const unsatisfied = clone(baselineFile()); unsatisfied.features[0].interfacesSatisfied = false;
  expect(p08IdentityFailuresFromPrerequisites(p08EvaluatePrerequisiteBaselines(validateP08PrerequisiteBaselines(unsatisfied), HEAD, alwaysAncestor))
    .map(failure => failure.code)).toContain('p08_baseline_interfaces_unsatisfied');

  const badCommit = clone(baselineFile()); badCommit.features[2].commit = 'not-a-sha';
  expect(p08IdentityFailuresFromPrerequisites(p08EvaluatePrerequisiteBaselines(validateP08PrerequisiteBaselines(badCommit), HEAD, alwaysAncestor))
    .map(failure => failure.code)).toContain('p08_baseline_invalid_commit');

  const noEvidence = clone(baselineFile()); noEvidence.features[0].deliveryEvidence = [];
  expect(p08IdentityFailuresFromPrerequisites(p08EvaluatePrerequisiteBaselines(validateP08PrerequisiteBaselines(noEvidence), HEAD, alwaysAncestor))
    .map(failure => failure.code)).toContain('p08_baseline_evidence_missing');

  // 非祖先 commit：即使其余字段全部满足也阻断。
  const stale = p08EvaluatePrerequisiteBaselines(baselines, HEAD, neverAncestor);
  expect(stale).toMatchObject({ status: 'blocked', resultStatus: 'not_run' });
  expect(p08IdentityFailuresFromPrerequisites(stale).map(failure => failure.code)).toEqual(
    ['p08_baseline_not_ancestor', 'p08_baseline_not_ancestor', 'p08_baseline_not_ancestor']);

  // 受测 HEAD 非法 → 拒绝，不猜测。
  expect(rejectedBy(() => p08EvaluatePrerequisiteBaselines(baselines, 'short', alwaysAncestor)).code).toBe('p08_run_identity_invalid');
  // 祖先检查抛错按不成立处理（fail-closed）。
  expect(p08EvaluatePrerequisiteBaselines(baselines, HEAD, () => { throw new Error('probe failed'); }).status).toBe('blocked');
});

/* ------------------------------------------------------------------ *
 * 不可变输入摘要与源码漂移
 * ------------------------------------------------------------------ */

function inputsMaterial(): P08RunInputsMaterial {
  return {
    runId: 'p08-identity-run-1', testedCommit: HEAD,
    configDigest: 'c'.repeat(64), checklistDigest: 'd'.repeat(64),
    prerequisites: baselineFile(),
    toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'darwin' },
    testScope: [{ file: 'test/modules/acceptance/example.test.ts', sha256: 'e'.repeat(64) }],
    externalReports: [{ kind: 'todo-live', path: 'evidence/todo-live.json', digest: '1'.repeat(64) }],
  };
}

it('[case:p08-f002-inputs-digest] 输入摘要不可变：配置/清单/前置/工具链/范围/外部引用任一变化即改变摘要', () => {
  const material = inputsMaterial();
  const identity = buildP08RunIdentity(material);
  expect(identity.inputsDigest).toMatch(SHA);
  expect(p08RunIdentityMatches(identity, identity)).toBe(true);
  expect(buildP08RunIdentity(clone(material))).toEqual(identity);

  type WritableMaterial = { -readonly [K in keyof P08RunInputsMaterial]: P08RunInputsMaterial[K] };
  for (const mutate of [
    (value: WritableMaterial) => { value.configDigest = '0'.repeat(64); },
    (value: WritableMaterial) => { value.checklistDigest = '0'.repeat(64); },
    (value: WritableMaterial) => { (value.prerequisites as { features: { commit: string }[] }).features[0].commit = 'f'.repeat(40); },
    (value: WritableMaterial) => { value.toolchain = { node: '26.0.0', npm: '10.9.3', platform: 'darwin' }; },
    (value: WritableMaterial) => { value.testScope = []; },
    (value: WritableMaterial) => { (value.testScope[0] as { sha256: string }).sha256 = '0'.repeat(64); },
    (value: WritableMaterial) => { value.externalReports = []; },
    (value: WritableMaterial) => { (value.externalReports[0] as { digest: string }).digest = '0'.repeat(64); },
    (value: WritableMaterial) => { value.testedCommit = 'f'.repeat(40); },
  ]) {
    const mutated = clone(material) as WritableMaterial; mutate(mutated);
    expect(digestP08RunInputs(mutated)).not.toBe(identity.inputsDigest);
  }

  // runId 变化改变摘要；非法 runId/commit 在运行身份校验处拒绝。
  const renamed = clone(material) as WritableMaterial; renamed.runId = 'p08-other-run';
  expect(digestP08RunInputs(renamed)).not.toBe(identity.inputsDigest);
  const badIdentity = clone(material) as WritableMaterial; badIdentity.runId = '../escape';
  expect(rejectedBy(() => buildP08RunIdentity(badIdentity)).code).toBe('p08_run_identity_invalid');
  const badCommit = clone(material) as WritableMaterial; badCommit.testedCommit = 'xyz';
  expect(rejectedBy(() => buildP08RunIdentity(badCommit)).code).toBe('p08_run_identity_invalid');
});

it('[case:p08-f002-input-drift] 源码漂移 fail-closed：HEAD、跟踪改动、未跟踪、哈希、文件集合与工具链', () => {
  const root = mkdtempSync(join(tmpdir(), 'p08-f002-drift-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  const files = ['package.json', 'src/a.ts'];
  writeFileSync(join(root, 'package.json'), '{}\n');
  const baseline = { headCommit: HEAD, toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'darwin' }, fileHashes: hashP08SourceInputs(root, files) };
  const observe = (overrides: Partial<Parameters<typeof p08DetectInputDrift>[1]> = {}) => p08DetectInputDrift(baseline, {
    headCommit: HEAD, toolchain: baseline.toolchain, fileHashes: baseline.fileHashes,
    statusEntries: [], repositoryRoot: root, ownedUntrackedRoots: [join(root, 'runs/p08-x')],
    ...overrides,
  });

  // 完全一致 + 本运行目录内的未跟踪输出 → 无漂移。
  expect(observe({ statusEntries: ['?? runs/p08-x/step.json', '?? "runs/p08-x/nested/out.json"'] }))
    .toEqual({ drifted: false, reasons: [] });

  expect(observe({ headCommit: ANCESTOR })).toMatchObject({ drifted: true, reasons: ['head_commit_changed'] });
  expect(observe({ toolchain: { node: '26.0.0', npm: '10.9.3', platform: 'darwin' } }).reasons).toContain('toolchain_drift');
  expect(observe({ statusEntries: ['M  src/a.ts'] }).reasons).toContain('tracked_source_changed:src/a.ts');
  expect(observe({ statusEntries: ['?? intruder.txt'] }).reasons).toContain('untracked_source_changed:intruder.txt');
  expect(observe({ fileHashes: [...baseline.fileHashes.slice(0, 1), { file: 'src/a.ts', sha256: '0'.repeat(64) }] }).reasons)
    .toContain('input_hash_changed:src/a.ts');
  expect(observe({ fileHashes: baseline.fileHashes.slice(0, 1) }).reasons).toContain('input_file_set_changed:-src/a.ts');
  expect(observe({ fileHashes: [...baseline.fileHashes, { file: 'src/new.ts', sha256: '0'.repeat(64) }] }).reasons)
    .toContain('input_file_set_changed:+src/new.ts');
});

it('[case:p08-f002-tested-source-enumeration] 受测源码枚举覆盖配置、包源码、脚本与测试且拒绝越界路径', () => {
  const files = collectP08TestedSourceFiles(ROOT);
  for (const required of ['package.json', 'package-lock.json', 'packages/core/src/index.ts', 'scripts/acceptance/p08-config.ts',
    'test/modules/acceptance/p08-4-f001-acceptance-contract.test.ts', 'acceptance/p08.config.json']) {
    expect(files).toContain(required);
  }
  expect(new Set(files).size).toBe(files.length);
  expect(files).toEqual([...files].sort());
  for (const file of files) expect(file.startsWith('/') || file.includes('..')).toBe(false);
  const hashes = hashP08SourceInputs(ROOT, ['package.json']);
  expect(hashes[0].sha256).toBe(sha256(readFileSync(join(ROOT, 'package.json'), 'utf8')));
  expect(rejectedBy(() => hashP08SourceInputs(ROOT, ['../outside.txt'])).code).toBe('p08_inputs_invalid');
});

/* ------------------------------------------------------------------ *
 * 运行目录：create-once，重复 runId 保留旧运行
 * ------------------------------------------------------------------ */

it('[case:p08-f002-run-directory] 运行目录一次性预留：重复 runId 拒绝且旧运行证据不被覆盖', () => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'p08-f002-runs-'));
  const first = reserveP08RunDirectory(reportRoot, 'p08-run-once');
  expect(first).toMatchObject({ action: 'created', runId: 'p08-run-once' });
  if (first.action !== 'created') throw new Error('expected created reservation');
  expect(existsSync(first.workDir)).toBe(true);
  writeFileSync(join(first.workDir, 'entry-result.json'), '{"keep":true}');

  const second = reserveP08RunDirectory(reportRoot, 'p08-run-once');
  expect(second).toMatchObject({ action: 'rejected', reason: 'run-directory-exists', runId: 'p08-run-once' });
  expect(readFileSync(join(first.workDir!, 'entry-result.json'), 'utf8')).toBe('{"keep":true}');
  expect(readdirSync(join(reportRoot, 'runs'))).toEqual(['p08-run-once']);

  expect(rejectedBy(() => reserveP08RunDirectory(reportRoot, '../escape')).code).toBe('p08_run_directory_invalid');
  expect(rejectedBy(() => reserveP08RunDirectory('relative/path', 'p08-run-2')).code).toBe('p08_run_directory_invalid');
});

/* ------------------------------------------------------------------ *
 * 外部证据引用与导入
 * ------------------------------------------------------------------ */

const tasks: TodoLiveTask[] = [
  { id: 'F-001', title: '创建 Todo 数据层', dependsOn: [] },
  { id: 'F-002', title: '实现 Todo 命令', dependsOn: ['F-001'] },
  { id: 'F-003', title: '补齐 Todo 验证', dependsOn: ['F-002'] },
];
function deliveryPorts(): TodoLiveDeliveryPorts {
  let sequence = 0;
  return {
    runTask: async task => ({
      executionMode: 'live', status: 'completed', taskId: task.id,
      attemptId: `attempt-${task.id}`, provider: 'authorized-provider', model: 'authorized-model', realCalls: 1,
    }),
    verifyTask: async task => ({ status: 'passed', taskId: task.id, exitCode: 0, command: ['node', `verify-${task.id}.mjs`], evidenceRef: `checks/${task.id}.json` }),
    commitTask: async task => {
      sequence += 1;
      return { status: 'succeeded', taskId: task.id, commitSha: `${String(sequence).padStart(40, '0')}`,
        treeSha: `${String(sequence + 10).padStart(40, '0')}`, message: `${task.id}: ${task.title}` };
    },
    saveEvidence: async () => {},
  };
}
async function todoLiveReport(): Promise<TodoLiveEvidenceReport> {
  const delivery = await runTodoLiveDelivery({
    projectId: 'project-todo', featureId: 'feature-todo', runId: 'todo-run-1', tasks,
    authorization: { realPi: true, provider: 'authorized-provider', model: 'authorized-model', expiresAt: Date.now() + 60_000, maxTasks: 3 },
    ports: deliveryPorts(),
  });
  return aggregateTodoLiveEvidence({
    delivery, requirements: { version: 1, digest: 'a'.repeat(64) }, code: { headCommit: ANCESTOR, headTree: 'c'.repeat(40) },
    checks: [{ id: 'todo-delivery-check', exitCode: 0, command: ['node', 'verify.mjs'], evidence: { ref: 'checks/todo.json', content: '{"exitCode":0}\n' } }],
  });
}

function brownfieldEnvelope(): unknown {
  const definition: BrownfieldCheckDefinition = {
    checkKey: 'existing-check', argv: ['node', 'checks/existing.mjs'], environmentIdentity: 'e'.repeat(64), timeoutMs: 10_000, required: true,
  };
  const result: BrownfieldCheckResult = { status: 'passed', evidenceRefs: ['artifacts/existing.json'] };
  const snapshot: BrownfieldCheckSnapshot = { check: definition, commandDigest: computeBrownfieldCheckCommandDigest(definition), result };
  const identity = (headCommit: string): BrownfieldCodeIdentity =>
    ({ repoIdentity: `gitdir-sha256:${'a'.repeat(64)}`, headCommit, workingTreeDigest: 'f'.repeat(64), hasUncommittedChanges: true });
  return collectBrownfieldEvidenceEnvelope({
    projectId: 'project-existing',
    binding: { projectId: 'project-existing', repositoryBindingId: 'binding-1', bindingRevision: 1, canonicalPath: '/tmp/demo/repository', repoIdentity: `gitdir-sha256:${'a'.repeat(64)}` },
    testCommit: ANCESTOR, baselineCodeIdentity: identity(HEAD), currentCodeIdentity: identity(ANCESTOR),
    checkScope: { requiredCheckKeys: ['existing-check'], optionalCheckKeys: [] },
    baselineChecks: [snapshot], currentChecks: [snapshot],
    artifacts: [{ ref: 'artifacts/existing.json', digest: '1'.repeat(64), bytes: 64 }],
    baselineDirtyFiles: [], currentDirtyFiles: [],
    phaseIntegration: [{ id: 'real-host', reason: 'phase-integration-required' }],
    collectedAtUtcMs: 1_769_000_000_000,
  });
}

function manualGateRecord(runId: string, testedCommit: string, inputsDigest: string): Record<string, unknown> {
  return { schemaVersion: 1, kind: P08_MANUAL_GATE_RECORD_KIND, identity: { runId, testedCommit, inputsDigest },
    owner: 'owner-1', status: 'confirmed', confirmedAtUtcMs: 1_769_000_123_000, notes: '负责人核对安装与两类 live 证据' };
}

function installManifest(commit: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'acceptance/p08-1.release-manifest.json'), 'utf8'));
  manifest.identity.gitCommit = commit;
  return manifest;
}

it('[case:p08-f002-external-references] 外部证据引用注册：kind/路径/摘要结构、唯一性与互斥', () => {
  const references = [
    { kind: 'todo-live', path: 'evidence/todo-live.json', digest: '1'.repeat(64) },
    { kind: 'existing-live', path: 'evidence/existing-live.json', digest: '2'.repeat(64) },
    { kind: 'install-manifest', path: 'evidence/install.json', digest: '3'.repeat(64) },
    { kind: 'manual-gate', path: 'evidence/manual.json', digest: '4'.repeat(64) },
  ];
  expect(validateP08ExternalEvidenceReferences(references)).toEqual(references);

  const duplicatePath = clone(references); duplicatePath[1].path = duplicatePath[0].path;
  expect(rejectedBy(() => validateP08ExternalEvidenceReferences(duplicatePath)).code).toBe('p08_external_reference_invalid');
  const duplicateKind = clone(references); duplicateKind[1].kind = 'todo-live';
  expect(rejectedBy(() => validateP08ExternalEvidenceReferences(duplicateKind)).code).toBe('p08_external_reference_invalid');
  for (const bad of [
    { kind: 'unknown-kind', path: 'evidence/x.json', digest: '1'.repeat(64) },
    { kind: 'todo-live', path: '/etc/passwd', digest: '1'.repeat(64) },
    { kind: 'todo-live', path: '../escape.json', digest: '1'.repeat(64) },
    { kind: 'todo-live', path: 'evidence/x.json', digest: 'not-hex' },
    { kind: 'todo-live', path: 'evidence/x.json', digest: '1'.repeat(64), extra: 1 },
  ]) {
    expect(rejectedBy(() => validateP08ExternalEvidenceReferences([...references.slice(0, 1), bad])).code).toBe('p08_external_reference_invalid');
  }
});

it('[case:p08-f002-external-import] 外部证据导入：来源/结构/身份/陈旧 commit 校验且对证据只读', async () => {
  const identity = buildP08RunIdentity(inputsMaterial());
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'p08-f002-evidence-'));
  const todo = await todoLiveReport();
  const writeEvidence = (name: string, value: unknown): P08ExternalEvidenceReference => {
    const path = `evidence/${name}`;
    mkdirSync(join(evidenceRoot, 'evidence'), { recursive: true });
    const content = JSON.stringify(value);
    writeFileSync(join(evidenceRoot, path), content);
    return { kind: 'todo-live', path, digest: sha256(content) };
  };

  // Todo Live：合法报告导入成功，身份事实绑定其 runId 与 commit。
  const todoReference = writeEvidence('todo-live.json', todo);
  const before = readFileSync(join(evidenceRoot, todoReference.path), 'utf8');
  const todoSummary = await importP08ExternalEvidence({ evidenceRoot, reference: todoReference, runIdentity: identity, isAncestor: alwaysAncestor });
  expect(todoSummary).toMatchObject({ kind: 'todo-live', reportKind: 'shiploop.todo.live-evidence', schemaVersion: 1, status: 'passed' });
  expect(todoSummary.commits).toContain(ANCESTOR);
  expect(todoSummary.runIds).toEqual(['todo-run-1']);
  // 导入只读：证据文件原样保留。
  expect(readFileSync(join(evidenceRoot, todoReference.path), 'utf8')).toBe(before);

  // 存量 Live：封套合法导入成功；篡改 envelopeDigest → 结构拒绝。
  const envelopeReference = { ...writeEvidence('existing-live.json', brownfieldEnvelope()), kind: 'existing-live' as const };
  const envelopeSummary = await importP08ExternalEvidence({ evidenceRoot, reference: envelopeReference, runIdentity: identity, isAncestor: alwaysAncestor });
  expect(envelopeSummary).toMatchObject({ kind: 'existing-live', reportKind: 'shiploop.brownfield.evidence-envelope', schemaVersion: 1 });
  expect(envelopeSummary.commits).toContain(ANCESTOR);
  const tampered = clone(brownfieldEnvelope()) as { envelopeDigest: string };
  tampered.envelopeDigest = '0'.repeat(64);
  const tamperedReference = { ...writeEvidence('tampered.json', tampered), kind: 'existing-live' as const };
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: tamperedReference, runIdentity: identity, isAncestor: alwaysAncestor }))).code)
    .toBe('p08_external_evidence_structure_invalid');

  // 安装产物：仓库真实发布清单结构核对通过；发布政策漂移拒绝。
  const manifestReference = { ...writeEvidence('install.json', installManifest(ANCESTOR)), kind: 'install-manifest' as const };
  const manifestSummary = await importP08ExternalEvidence({ evidenceRoot, reference: manifestReference, runIdentity: identity, isAncestor: alwaysAncestor });
  expect(manifestSummary).toMatchObject({ kind: 'install-manifest', reportKind: 'shiploop.p08.release-manifest', status: 'not_run' });
  expect(manifestSummary.commits).toEqual([ANCESTOR]);
  const published = installManifest(ANCESTOR); published.published = true;
  expect(rejectedBy(() => validateP08InstallManifest(published)).code).toBe('p08_external_evidence_structure_invalid');
  const unknownField = installManifest(ANCESTOR); unknownField.extraField = true;
  expect(rejectedBy(() => validateP08InstallManifest(unknownField)).code).toBe('p08_external_evidence_structure_invalid');
  const badToolchain = installManifest(ANCESTOR); badToolchain.toolchain = { node: '26.0.0', npm: '10.9.3', platform: 'darwin', packageManager: 'npm@10.9.3' };
  expect(rejectedBy(() => validateP08InstallManifest(badToolchain)).code).toBe('p08_external_evidence_structure_invalid');

  // 人工门禁：绑定当前运行身份；错误身份与非法状态拒绝。
  const gateReference = { ...writeEvidence('manual.json', manualGateRecord(identity.runId, identity.testedCommit, identity.inputsDigest)), kind: 'manual-gate' as const };
  const gateSummary = await importP08ExternalEvidence({ evidenceRoot, reference: gateReference, runIdentity: identity, isAncestor: alwaysAncestor });
  expect(gateSummary).toMatchObject({ kind: 'manual-gate', status: 'confirmed' });
  for (const wrong of [manualGateRecord('other-run', identity.testedCommit, identity.inputsDigest),
    manualGateRecord(identity.runId, 'f'.repeat(40), identity.inputsDigest),
    manualGateRecord(identity.runId, identity.testedCommit, '0'.repeat(64))]) {
    expect(rejectedBy(() => validateP08ManualGateRecord(wrong, identity)).code).toBe('p08_manual_gate_identity_mismatch');
  }
  const badStatus = manualGateRecord(identity.runId, identity.testedCommit, identity.inputsDigest);
  badStatus.status = 'signed-by-machine';
  expect(rejectedBy(() => validateP08ManualGateRecord(badStatus, identity)).code).toBe('p08_manual_gate_status_invalid');

  // 损坏 JSON / 摘要不匹配 / 来源错配（两类 live 互不替代）/ 陈旧 commit。
  writeFileSync(join(evidenceRoot, 'evidence/corrupt.json'), '{not-json');
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: { kind: 'todo-live', path: 'evidence/corrupt.json', digest: sha256('{not-json') }, runIdentity: identity, isAncestor: alwaysAncestor }))).code)
    .toBe('p08_external_evidence_corrupt_json');
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: { kind: 'todo-live', path: todoReference.path, digest: '0'.repeat(64) }, runIdentity: identity, isAncestor: alwaysAncestor }))).code)
    .toBe('p08_external_evidence_digest_mismatch');
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: { kind: 'existing-live', path: todoReference.path, digest: todoReference.digest }, runIdentity: identity, isAncestor: alwaysAncestor }))).code)
    .toBe('p08_external_evidence_kind_mismatch');
  const schemaDrift = writeEvidence('schema-drift.json', { ...todo, schemaVersion: 2 });
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: schemaDrift, runIdentity: identity, isAncestor: alwaysAncestor }))).code)
    .toBe('p08_external_evidence_schema_invalid');
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: todoReference, runIdentity: identity, isAncestor: neverAncestor }))).code)
    .toBe('p08_external_evidence_stale_commit');
  expect((await rejectedByAsync(() => importP08ExternalEvidence({ evidenceRoot, reference: { kind: 'todo-live', path: 'evidence/missing.json', digest: '1'.repeat(64) }, runIdentity: identity, isAncestor: alwaysAncestor }))).code)
    .toBe('p08_external_evidence_missing');
});

/* ------------------------------------------------------------------ *
 * 脱敏诊断
 * ------------------------------------------------------------------ */

it('[case:p08-f002-diagnostics] 校验失败脱敏诊断：独立目录、不覆盖、保留旧运行', () => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'p08-f002-diag-'));
  const sensitiveValues = [reportRoot, 'sk-live-secret-token-value'];
  const failures: P08IdentityFailure[] = [{ code: 'p08_input_drift', stage: 'inputs', detail: `source changed under ${reportRoot} with token sk-live-secret-token-value` }];

  // 全新 runId：诊断写入本运行目录，内容脱敏。
  const first = writeP08IdentityDiagnostics({ reportRoot, runId: 'p08-diag-1', failures, sensitiveValues,
    context: { home: '/Users/owner/secret', authorization: 'Bearer abcdef123456789' } });
  expect(first.mode).toBe('run-directory');
  const firstBody = JSON.parse(readFileSync(first.file, 'utf8'));
  expect(firstBody).toMatchObject({ kind: P08_IDENTITY_DIAGNOSTIC_KIND, runId: 'p08-diag-1', phaseAccepted: false });
  const serialized = JSON.stringify(firstBody);
  expect(serialized).not.toContain(reportRoot);
  expect(serialized).not.toContain('sk-live-secret-token-value');
  expect(serialized).not.toContain('/Users/owner/secret');
  expect(serialized).toContain('<redacted>');

  // 重复 runId：旧运行目录原样保留，诊断写入独立 diagnostics 目录，不覆盖。
  mkdirSync(join(reportRoot, 'runs/p08-diag-2'), { recursive: true });
  writeFileSync(join(reportRoot, 'runs/p08-diag-2/entry-result.json'), '{"old":true}');
  const duplicate = writeP08IdentityDiagnostics({ reportRoot, runId: 'p08-diag-2', failures, sensitiveValues, nowMs: 1_769_000_000_000, nonce: 'n1' });
  expect(duplicate.mode).toBe('diagnostics-directory');
  expect(readFileSync(join(reportRoot, 'runs/p08-diag-2/entry-result.json'), 'utf8')).toBe('{"old":true}');
  const second = writeP08IdentityDiagnostics({ reportRoot, runId: 'p08-diag-2', failures, sensitiveValues, nowMs: 1_769_000_000_000, nonce: 'n2' });
  expect(second.file).not.toBe(duplicate.file);
  expect(existsSync(duplicate.file)).toBe(true);

  // 同一时间戳与 nonce 的诊断路径冲突按 create-once 拒绝，不覆盖已有文件与旧运行。
  expect(rejectedBy(() => writeP08IdentityDiagnostics({ reportRoot, runId: 'p08-diag-2', failures, sensitiveValues, nowMs: 1_769_000_000_000, nonce: 'n1' })).code)
    .toBe('p08_diagnostic_write_failed');
  expect(readFileSync(join(reportRoot, 'runs/p08-diag-2/entry-result.json'), 'utf8')).toBe('{"old":true}');
  expect(readFileSync(duplicate.file, 'utf8')).toContain('p08_input_drift');
  expect(rejectedBy(() => writeP08IdentityDiagnostics({ reportRoot: 'relative', runId: 'x', failures: [], sensitiveValues })).code)
    .toBe('p08_diagnostic_invalid');

  // 文本脱敏：绝对路径与凭据值替换。
  expect(p08SanitizeDiagnosticText(`run at ${reportRoot}/runs/x`, [reportRoot])).not.toContain(reportRoot);
  expect(p08SanitizeDiagnosticText('token sk-live-secret-token-value', ['sk-live-secret-token-value'])).toContain('<redacted>');
  expect(p08SanitizeDiagnosticText('home is /Users/ganlu/project', [])).toContain('<machine-path>');
});

it('[case:p08-f002-failure-mapping] 身份失败从异常映射：结构化 code/stage，不回显敏感值', () => {
  class IdentityError extends Error { code = 'p08_baseline_structure_invalid'; stage = 'baselines'; }
  const failure = p08IdentityFailureFromError(new IdentityError('结构非法'), 'baselines');
  expect(failure).toMatchObject({ code: 'p08_baseline_structure_invalid', stage: 'baselines', detail: '结构非法' });
  const generic = p08IdentityFailureFromError(new Error('boom'), 'external-evidence');
  expect(generic).toMatchObject({ code: 'p08_identity_check_failed', stage: 'external-evidence', detail: 'boom' });
});
