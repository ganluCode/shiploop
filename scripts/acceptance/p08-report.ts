/**
 * P08-4 / F-006 P08 一期总报告聚合器。
 *
 * 这是离线验收工具，不是产品运行时。它只消费已经结构化的检查结果和外部
 * 证据摘要；所有检查状态、计数、层级摘要、blocking issue 和发布目录清单
 * 都从冻结 checklist 与这些输入重新计算。它不会修改 Feature/Task/Phase 状态，
 * 也不会把 Nezha 的状态、测试数量或成功日志当作产品证据。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  digestP08Checklist,
  loadP08Checklist,
  P08_LAYERS,
  P08_PREREQUISITE_FEATURES,
  validateP08Checklist,
  validateP08RunIdentity,
  type P08Checklist,
  type P08FrozenItem,
  type P08Layer,
  type P08ReportStatus,
  type P08RunIdentity,
} from './p08-config.ts';
import type { P08TestScope } from './p08-test-scope.ts';

export const P08_REPORT_SCHEMA_VERSION = 1;
export const P08_REPORT_KIND = 'shiploop.p08.acceptance-report';
export type P08ReportEvidence = { readonly category: string; readonly path?: string; readonly digest?: string };
export type P08ReportSection = {
  readonly status: P08ReportStatus;
  readonly evidence: readonly string[];
  readonly reason?: string;
  readonly cleanupConfirmed?: boolean;
  readonly identity?: { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string };
  readonly reportRefs?: readonly string[];
};
export type P08FeatureDelivery = {
  readonly feature: string;
  readonly status: P08ReportStatus;
  readonly commit: string;
  readonly reportRef: string;
  readonly evidenceRefs?: readonly string[];
  readonly identity?: { readonly runId?: string; readonly testedCommit?: string; readonly inputsDigest?: string };
};
export type P08PrerequisiteSummary = {
  readonly status: P08ReportStatus;
  readonly features: readonly P08FeatureDelivery[];
  readonly evidenceRefs?: readonly string[];
  readonly reason?: string;
};
export type P08ReportCheckInput = {
  readonly checkId: string;
  readonly status: P08ReportStatus;
  readonly executionMode: 'fake' | 'live' | 'manual' | 'postponed';
  readonly evidence?: readonly string[];
  readonly reason?: string;
};
export type P08LiveSections = { readonly todo: P08ReportSection; readonly existing: P08ReportSection };
export type P08ReportInput = {
  readonly identity: P08RunIdentity;
  readonly testScope: P08TestScope;
  readonly prerequisites: P08PrerequisiteSummary;
  readonly installation: P08ReportSection;
  readonly taskLocal: P08ReportSection;
  readonly featureGate: P08ReportSection;
  readonly phaseIntegration: P08ReportSection;
  readonly deterministic?: P08ReportSection;
  readonly live: P08LiveSections;
  readonly manual: P08ReportSection;
  readonly checks?: readonly P08ReportCheckInput[];
  readonly productReports?: readonly { readonly featureId: string; readonly path: string; readonly identity?: { readonly runId: string; readonly testedCommit: string; readonly inputsDigest: string } }[];
  readonly knownGaps: readonly string[];
  /** 相对于 sourceDirectory 的自包含证据文件；绝对路径永远不被接受。 */
  readonly evidenceFiles?: readonly string[];
};
export type P08ReportCheck = Omit<P08FrozenItem, 'evidence'> & {
  readonly status: P08ReportStatus;
  readonly reason: string | null;
  readonly executionMode: 'fake' | 'live' | 'manual' | 'postponed';
  readonly evidence: readonly P08ReportEvidence[];
};
export type P08ReportLayer = {
  readonly id: P08Layer;
  readonly status: P08ReportStatus;
  readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number };
  readonly checkIds: readonly string[];
};
export type P08ReportFile = { readonly path: string; readonly sha256: string; readonly sizeBytes: number };
export type P08AcceptanceReport = {
  readonly schemaVersion: typeof P08_REPORT_SCHEMA_VERSION;
  readonly kind: typeof P08_REPORT_KIND;
  readonly phase: 'P08';
  readonly layer: 'phase-acceptance';
  readonly identity: P08RunIdentity;
  readonly checklistDigest: string;
  readonly checklist: P08Checklist;
  readonly request: P08ReportInput;
  readonly prerequisites: P08PrerequisiteSummary;
  readonly installation: P08ReportSection;
  readonly testScope: P08TestScope;
  readonly checks: readonly P08ReportCheck[];
  readonly layers: readonly P08ReportLayer[];
  readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number };
  readonly conclusion: 'pass' | 'fail';
  readonly exitCode: 0 | 1;
  readonly blockingIssues: readonly string[];
  readonly knownGaps: readonly string[];
  readonly productReports: readonly { readonly featureId: string; readonly path: string }[];
  readonly baseline: { readonly candidateCommit: string; readonly phaseAccepted: false; readonly ownerSignature: 'pending'; readonly note: string };
  readonly files: readonly P08ReportFile[];
};

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RELATIVE = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const CREDENTIAL_KEY = /(?:authorization|auth|token|password|passwd|secret|credential|cookie|api[_-]?key)/i;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|~\/|file:\/\/)/;
const SENSITIVE = /(?:Bearer\s+\S+|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9._-]{8,}|-----BEGIN\s+[A-Z ]*PRIVATE KEY-----)/i;
const fail = (code: string): never => { throw new Error(code); };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function object(value: unknown, code = 'invalid_schema'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function relativeFile(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_RELATIVE.test(value) || isAbsolute(value) || value.split('/').some(part => part === '.' || part === '..')) fail('unsafe_evidence_path');
  return value as string;
}
function status(value: unknown): P08ReportStatus {
  if (value !== 'pass' && value !== 'fail' && value !== 'not_run') fail('invalid_status');
  return value as P08ReportStatus;
}
function identityRef(value: unknown, expected: P08RunIdentity): void {
  const raw = object(value, 'identity_mismatch');
  if (raw.runId !== expected.runId || raw.testedCommit !== expected.testedCommit || raw.inputsDigest !== expected.inputsDigest) fail('identity_mismatch');
}
function sanitize(value: unknown, key = ''): unknown {
  if (CREDENTIAL_KEY.test(key)) return '<redacted>';
  if (typeof value === 'string') {
    if (SENSITIVE.test(value)) return value.replace(SENSITIVE, '<redacted>');
    return value.replace(/(?:\/(?:Users|home|private\/tmp|tmp)\/[^\s"'`,;)]*|[A-Za-z]:[\\/][^\s"'`,;)]*|~\/[^\s"'`,;)]*)/g, '<machine-path>');
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}
function safeInput(input: P08ReportInput): P08ReportInput {
  return sanitize(input) as P08ReportInput;
}
function validateSection(section: P08ReportSection, expected: P08RunIdentity): void {
  object(section);
  status(section.status);
  if (!Array.isArray(section.evidence) || section.evidence.some(item => typeof item !== 'string' || item.length === 0)) fail('invalid_section');
  if (section.reason !== undefined && typeof section.reason !== 'string') fail('invalid_section');
  if (section.cleanupConfirmed !== undefined && typeof section.cleanupConfirmed !== 'boolean') fail('invalid_cleanup');
  if (section.identity !== undefined) identityRef(section.identity, expected);
  for (const path of section.reportRefs ?? []) relativeFile(path);
}
function expectedMode(item: P08FrozenItem): P08ReportCheckInput['executionMode'] {
  return item.execution === 'offline' ? 'fake' : item.execution === 'live' ? 'live' : item.execution === 'manual' ? 'manual' : 'postponed';
}
function prerequisiteStatus(summary: P08PrerequisiteSummary): P08ReportStatus {
  if (summary.status === 'fail' || summary.features.some(feature => feature.status === 'fail')) return 'fail';
  if (summary.status === 'not_run' || summary.features.some(feature => feature.status === 'not_run')) return 'not_run';
  return 'pass';
}
function prerequisiteSection(summary: P08PrerequisiteSummary): P08ReportSection {
  const effectiveStatus = prerequisiteStatus(summary);
  return { status: effectiveStatus, evidence: ['report', 'manifest', 'sha', ...(summary.evidenceRefs ?? [])], reason: effectiveStatus === 'pass' ? summary.reason : summary.reason ?? 'prerequisite_feature_not_pass',
    reportRefs: [...summary.features.map(feature => feature.reportRef), ...(summary.evidenceRefs ?? [])] };
}
function sectionFor(item: P08FrozenItem, input: P08ReportInput): P08ReportSection {
  if (item.id === 'P08-PREREQ-DELIVERY-REPORTS') return prerequisiteSection(input.prerequisites);
  if (item.id === 'P08-INSTALL-CLEAN-DIRECTORY') return input.installation;
  if (item.id === 'P08-LIVE-TODO-EVIDENCE') return input.live.todo;
  if (item.id === 'P08-LIVE-EXISTING-EVIDENCE') return input.live.existing;
  if (item.layer === 'code-delivery') return prerequisiteSection(input.prerequisites);
  if (item.layer === 'task-local') return input.taskLocal;
  if (item.layer === 'feature-gate') return input.featureGate;
  if (item.layer === 'phase-integration' && item.id === 'P08-DETERMINISTIC-PHASE-REGRESSION') return input.deterministic ?? input.phaseIntegration;
  if (item.layer === 'phase-integration') return input.phaseIntegration;
  if (item.layer === 'manual') return input.manual;
  return input.phaseIntegration;
}
function sectionStatus(section: P08ReportSection, item: P08FrozenItem): { status: P08ReportStatus; reason: string | null } {
  if (section.status === 'pass' && item.evidence.includes('cleanup') && section.cleanupConfirmed !== true) return { status: 'fail', reason: 'cleanup_unconfirmed' };
  return { status: section.status, reason: section.reason ?? null };
}
function validateInput(input: P08ReportInput, checklist: P08Checklist): void {
  validateP08RunIdentity(input.identity);
  if (!input.testScope || typeof input.testScope !== 'object') fail('invalid_test_scope');
  validateSection(input.installation, input.identity); validateSection(input.taskLocal, input.identity);
  validateSection(input.featureGate, input.identity); validateSection(input.phaseIntegration, input.identity);
  if (input.deterministic !== undefined) validateSection(input.deterministic, input.identity);
  validateSection(input.live.todo, input.identity); validateSection(input.live.existing, input.identity); validateSection(input.manual, input.identity);
  status(input.prerequisites.status);
  if (!Array.isArray(input.prerequisites.features) || input.prerequisites.features.length !== P08_PREREQUISITE_FEATURES.length) fail('invalid_prerequisites');
  const features = new Set<string>();
  for (const feature of input.prerequisites.features) {
    object(feature); status(feature.status); if (!P08_PREREQUISITE_FEATURES.includes(feature.feature as never) || features.has(feature.feature)) fail('invalid_prerequisites');
    features.add(feature.feature); if (!COMMIT.test(feature.commit)) fail('invalid_prerequisite_commit'); relativeFile(feature.reportRef);
    for (const ref of feature.evidenceRefs ?? []) relativeFile(ref);
    if (feature.identity) identityRef(feature.identity, input.identity);
  }
  for (const feature of P08_PREREQUISITE_FEATURES) if (!features.has(feature)) fail('invalid_prerequisites');
  for (const ref of input.prerequisites.evidenceRefs ?? []) relativeFile(ref);
  for (const path of input.evidenceFiles ?? []) relativeFile(path);
  for (const check of input.checks ?? []) {
    object(check); if (!checklist.items.some(item => item.id === check.checkId)) fail(`unknown_check:${check.checkId}`);
    status(check.status); if (!['fake', 'live', 'manual', 'postponed'].includes(check.executionMode)) fail('invalid_execution_mode');
    if (check.evidence?.some(item => typeof item !== 'string' || item.length === 0)) fail('invalid_evidence');
  }
  const productReports = input.productReports ?? [];
  const productIds = new Set<string>();
  for (const report of productReports) {
    if (!SAFE_ID.test(report.featureId) || productIds.has(report.featureId)) fail('duplicate_product_report');
    productIds.add(report.featureId); relativeFile(report.path); if (report.identity) identityRef(report.identity, input.identity);
  }
  if (!Array.isArray(input.knownGaps) || input.knownGaps.some(gap => typeof gap !== 'string' || gap.length === 0)) fail('invalid_known_gaps');
}
function evidenceFor(item: P08FrozenItem, claim: P08ReportCheckInput | undefined, section: P08ReportSection, report: P08ReportInput): P08ReportEvidence[] {
  const categories = new Set(claim?.evidence ?? section.evidence);
  const refs: P08ReportEvidence[] = [];
  for (const category of categories) refs.push({ category });
  const files = [
    ...(section.reportRefs ?? []),
    ...(item.id === 'P08-PREREQ-DELIVERY-REPORTS' ? report.prerequisites.features.flatMap(feature => [feature.reportRef, ...(feature.evidenceRefs ?? [])]) : []),
    ...(item.id === 'P08-INSTALL-CLEAN-DIRECTORY' && report.installation.reportRefs ? report.installation.reportRefs : []),
    ...(report.productReports ?? []).map(product => product.path),
  ];
  for (const path of [...new Set(files)]) refs.push({ category: 'report', path });
  return refs;
}
function layerSummary(checks: readonly P08ReportCheck[]): P08ReportLayer[] {
  return P08_LAYERS.map(id => {
    const scoped = checks.filter(check => check.layer === id && check.group !== 'deferred');
    const counts = { pass: scoped.filter(check => check.status === 'pass').length, fail: scoped.filter(check => check.status === 'fail').length, not_run: scoped.filter(check => check.status === 'not_run').length };
    const layerStatus: P08ReportStatus = counts.fail > 0 ? 'fail' : counts.not_run > 0 ? 'not_run' : 'pass';
    return { id, status: layerStatus, counts, checkIds: scoped.map(check => check.id) };
  });
}
function blockingChecks(checks: readonly P08ReportCheck[]): string[] {
  return checks.filter(check => check.group !== 'deferred' && check.status !== 'pass').map(check => `${check.id}:${check.reason ?? check.status}`);
}

/** 从 P08 冻结清单与已核验输入构造总报告，派生计数绝不信任调用方。 */
export function buildP08AcceptanceReport(input: P08ReportInput, checklist = loadP08Checklist()): P08AcceptanceReport {
  const cleanInput = safeInput(input);
  const checkedChecklist = validateP08Checklist(checklist);
  validateInput(cleanInput, checkedChecklist);
  const effectivePrerequisites: P08PrerequisiteSummary = { ...cleanInput.prerequisites, status: prerequisiteStatus(cleanInput.prerequisites) };
  const reportInput: P08ReportInput = { ...cleanInput, prerequisites: effectivePrerequisites };
  const claims = new Map<string, P08ReportCheckInput>();
  for (const claim of cleanInput.checks ?? []) { if (claims.has(claim.checkId)) fail('duplicate_check'); claims.set(claim.checkId, claim); }
  const checks = checkedChecklist.items.map(item => {
    const claim = claims.get(item.id);
    const section = sectionFor(item, reportInput);
    let result = sectionStatus(section, item);
    let mode = claim?.executionMode ?? expectedMode(item);
    let reason = result.reason;
    if (item.group === 'deferred') { result = { status: 'not_run', reason: 'deferred_not_run' }; mode = 'postponed'; }
    else if (claim) {
      if (claim.executionMode !== expectedMode(item)) { result = { status: 'fail', reason: 'execution_mode_mismatch' }; }
      else if (claim.status === 'fail') result = { status: 'fail', reason: claim.reason ?? 'check_failed' };
      else if (claim.status === 'not_run') result = { status: 'not_run', reason: claim.reason ?? 'not_run' };
      else if (section.status !== 'pass') result = { status: section.status, reason: section.reason ?? null };
      else result = { status: 'pass', reason: null };
      reason = result.reason;
    }
    const evidence = evidenceFor(item, claim, section, reportInput);
    if (result.status === 'pass') {
      const available = new Set(evidence.map(entry => entry.category));
      const missing = item.evidence.filter(category => !available.has(category));
      if (missing.length) result = { status: 'fail', reason: `missing_evidence:${missing.join(',')}` };
    }
    return { ...item, status: result.status, reason: result.reason ?? reason ?? null, executionMode: mode, evidence };
  });
  const required = checks.filter(check => check.group !== 'deferred');
  const counts = { pass: required.filter(check => check.status === 'pass').length, fail: required.filter(check => check.status === 'fail').length, not_run: required.filter(check => check.status === 'not_run').length };
  const blockingIssues = blockingChecks(checks);
  if (effectivePrerequisites.status !== 'pass') blockingIssues.push(`prerequisites:${effectivePrerequisites.status}`);
  if (cleanInput.installation.status !== 'pass') blockingIssues.push(`installation:${cleanInput.installation.status}`);
  if (cleanInput.installation.cleanupConfirmed !== true) blockingIssues.push('installation:cleanup_unconfirmed');
  for (const [kind, section] of Object.entries(cleanInput.live)) if (section.status !== 'pass') blockingIssues.push(`live-${kind}:${section.status}`);
  if ((cleanInput.productReports ?? []).length === 0) blockingIssues.push('missing_product_report');
  const layers = layerSummary(checks);
  const conclusion = blockingIssues.length === 0 && counts.fail === 0 && counts.not_run === 0 ? 'pass' : 'fail';
  const knownGaps = [...new Set([...cleanInput.knownGaps, ...checks.filter(check => check.status === 'not_run').map(check => `${check.id}:${check.reason ?? 'not_run'}`)])];
  return {
    schemaVersion: P08_REPORT_SCHEMA_VERSION, kind: P08_REPORT_KIND, phase: 'P08', layer: 'phase-acceptance', identity: cleanInput.identity,
    checklistDigest: digestP08Checklist(checkedChecklist), checklist: checkedChecklist, request: reportInput,
    prerequisites: effectivePrerequisites, installation: reportInput.installation, testScope: reportInput.testScope,
    checks, layers, counts, conclusion, exitCode: conclusion === 'pass' ? 0 : 1, blockingIssues, knownGaps,
    productReports: (cleanInput.productReports ?? []).map(({ featureId, path }) => ({ featureId, path })),
    baseline: { candidateCommit: cleanInput.identity.testedCommit, phaseAccepted: false, ownerSignature: 'pending', note: '机器报告只能记录候选基线，不能替负责人签署 Phase 或改变 Feature/Task 状态' },
    files: [],
  };
}

export function renderP08Summary(report: P08AcceptanceReport): string {
  const cell = (value: string): string => value.replace(/[|\r\n]/g, ' ');
  return `# P08 acceptance\n\nRun: ${report.identity.runId}\nCommit: ${report.identity.testedCommit}\nInput: ${report.identity.inputsDigest}\nChecklist: ${report.checklistDigest}\nToolchain: ${cell(JSON.stringify(report.identity.toolchain))}\n\nConclusion: ${report.conclusion}; exit=${report.exitCode}\nPass: ${report.counts.pass}; fail: ${report.counts.fail}; not_run: ${report.counts.not_run}\n\n| Layer | Status | Pass | Fail | Not run |\n| --- | --- | ---: | ---: | ---: |\n${report.layers.map(layer => `| ${layer.id} | ${layer.status} | ${layer.counts.pass} | ${layer.counts.fail} | ${layer.counts.not_run} |`).join('\n')}\n\n| Check | Execution | Status | Reason |\n| --- | --- | --- | --- |\n${report.checks.map(check => `| ${check.id} | ${check.execution} | ${check.status} | ${cell(check.reason ?? '')} |`).join('\n')}\n\nBlocking issues:\n${report.blockingIssues.map(issue => `- ${cell(issue)}`).join('\n') || '- none'}\n\nKnown gaps:\n${report.knownGaps.map(gap => `- ${cell(gap)}`).join('\n') || '- none'}\n\nBaseline candidate: ${report.baseline.candidateCommit} (phaseAccepted=${report.baseline.phaseAccepted}, ownerSignature=${report.baseline.ownerSignature})\n`;
}
function noSymlink(path: string): void {
  let current = resolve(path);
  const temporary = resolve(tmpdir());
  if (current.startsWith(temporary + sep)) current = realpathSync(temporary) + current.slice(temporary.length);
  while (true) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('directory_symlink'); const parent = dirname(current); if (parent === current) return; current = parent; }
}
function readMaterial(root: string, path: string): Buffer {
  relativeFile(path); const target = join(root, path); noSymlink(target); if (!existsSync(target) || !lstatSync(target).isFile()) fail(`missing_evidence_file:${path}`);
  const bytes = readFileSync(target); if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) fail('invalid_evidence_file'); return bytes;
}
function filesIn(root: string, prefix = ''): string[] {
  noSymlink(root); return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) fail('directory_symlink'); const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return filesIn(join(root, entry.name), `${path}/`); if (entry.isFile()) return [path]; return fail('invalid_directory_entry');
  }).sort();
}
function same(left: unknown, right: unknown): boolean { return digest(left) === digest(right); }

/** 校验发布目录：重新聚合、逐文件摘要、摘要文本和精确目录清单。 */
export function verifyP08ReportDirectory(directory: string, expected: P08RunIdentity): { ok: boolean; exitCode: 0 | 1; problems: string[] } {
  try {
    validateP08RunIdentity(expected); noSymlink(directory);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as P08AcceptanceReport;
    if (report.kind !== P08_REPORT_KIND || report.schemaVersion !== P08_REPORT_SCHEMA_VERSION) fail('report_schema_invalid');
    identityRef(report.identity, expected);
    const rebuilt = buildP08AcceptanceReport(report.request, validateP08Checklist(report.checklist));
    const expectedFiles = report.files.map(file => file.path).sort();
    if (!same(report.checks, rebuilt.checks) || !same(report.layers, rebuilt.layers) || !same(report.counts, rebuilt.counts)
      || report.conclusion !== rebuilt.conclusion || report.exitCode !== rebuilt.exitCode || !same(report.blockingIssues, rebuilt.blockingIssues)
      || !same(report.knownGaps, rebuilt.knownGaps) || report.checklistDigest !== rebuilt.checklistDigest) fail('report_aggregation_mismatch');
    for (const file of report.files) { const bytes = readMaterial(directory, file.path); if (file.sha256 !== sha256(bytes) || file.sizeBytes !== bytes.length) fail('report_file_digest_mismatch'); }
    if (!same(filesIn(directory), ['report.json', 'summary.md', ...expectedFiles].sort())) fail('directory_manifest_mismatch');
    if (readFileSync(join(directory, 'summary.md'), 'utf8') !== renderP08Summary(report)) fail('summary_mismatch');
    return { ok: true, exitCode: report.exitCode, problems: [] };
  } catch (error) { return { ok: false, exitCode: 1, problems: [error instanceof Error ? error.message : 'p08_report_verification_failed'] }; }
}

/** 发布自包含报告。runId 目录是 create-once，任何旧目录都保持不变。 */
export function writeP08AcceptanceReport(options: { readonly reportRoot: string; readonly sourceDirectory?: string; readonly input: P08ReportInput; readonly checklist?: P08Checklist }): { directory: string; report: P08AcceptanceReport; verification: { ok: boolean; exitCode: 0 | 1; problems: string[] }; exitCode: 0 | 1 } {
  if (!isAbsolute(options.reportRoot)) fail('report_root');
  mkdirSync(options.reportRoot, { recursive: true, mode: 0o700 });
  const directory = join(options.reportRoot, options.input.identity.runId);
  try { mkdirSync(directory, { recursive: false, mode: 0o700 }); } catch { fail('run_exists'); }
  const source = options.sourceDirectory ?? process.cwd();
  let stage = 'build';
  try {
    const built = buildP08AcceptanceReport(options.input, options.checklist);
    stage = 'copy';
    const paths = [...new Set([
      ...(options.input.evidenceFiles ?? []),
      ...built.prerequisites.features.flatMap(feature => [feature.reportRef, ...(feature.evidenceRefs ?? [])]),
      ...(built.installation.reportRefs ?? []),
      ...(built.productReports.map(report => report.path)),
      ...(built.request.manual.reportRefs ?? []),
    ])].sort();
    const files: P08ReportFile[] = [];
    for (const path of paths) {
      const bytes = readMaterial(source, path); const target = join(directory, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); files.push({ path, sha256: sha256(bytes), sizeBytes: bytes.length });
    }
    stage = 'serialize';
    const report = { ...built, files };
    writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'summary.md'), renderP08Summary(report), { flag: 'wx', mode: 0o600 });
    stage = 'verify';
    const verification = verifyP08ReportDirectory(directory, options.input.identity);
    if (!verification.ok) fail('report_readback_failed');
    return { directory, report, verification, exitCode: report.exitCode };
  } catch (error) {
    const diagnostic = { kind: P08_REPORT_KIND, schemaVersion: P08_REPORT_SCHEMA_VERSION, phaseAccepted: false, stage };
    writeFileSync(join(directory, 'diagnostic.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    throw new Error('publication_failed');
  }
}

export const buildP08Report = buildP08AcceptanceReport;
export const writeP08Report = writeP08AcceptanceReport;
export const verifyP08Report = verifyP08ReportDirectory;
