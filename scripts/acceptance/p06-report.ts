/** P06 phase reports. Read-only evidence consumer; never updates product or Harness state. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { validateAppQueryResponse } from '../../packages/host/src/client/app-wire.ts';
import { validateP05ProductCapture } from './p05-product-evidence.ts';
import { digestP06Checklist, loadP06Checklist, validateP06Checklist, type P06Checklist, type P06ReportStatus } from './p06-config.ts';
import { P06_REQUIRED_EVIDENCE_SCENARIOS, validateP06Scenario, verifyP06Scenario,
  type P06EvidenceIdentity, type P06ScenarioRecord } from './p06-evidence.ts';
import { hashP06Bytes, hashP06Input, safeP06Json, safeP06Text } from './p06-facts.ts';

export type P06ReportCheckInput = { readonly checkId: string; readonly status: P06ReportStatus;
  readonly executionMode: 'fake' | 'live' | 'manual' | 'postponed'; readonly reason?: string };
/** External owner/live-runner captures are inputs, never generated or signed by this aggregator. */
export type P06GateCapture = P06EvidenceIdentity & {
  readonly schemaVersion: 1; readonly execution: 'live' | 'manual'; readonly producer: 'owner' | 'live-runner';
  readonly command: readonly string[]; readonly exitCode: number; readonly usage: { readonly source: 'reported'; readonly requests: number };
  readonly cleanup: { readonly confirmed: boolean; readonly processesGone: boolean; readonly resourcesRemoved: boolean };
  readonly live?: { readonly authorizedBy: string; readonly provider: string; readonly model: string; readonly maxRequests: number; readonly realModel: true };
  readonly manual?: { readonly status: 'pending' | 'confirmed' | 'rejected'; readonly confirmedBy: string; readonly confirmedAt: string; readonly decision: 'approved' | 'rejected' };
};
export type P06ReportInput = {
  readonly identity: P06EvidenceIdentity; readonly toolchain: Readonly<Record<string, string>>;
  readonly checks: readonly P06ReportCheckInput[]; readonly scenarios: readonly P06ScenarioRecord[];
  readonly products: readonly { readonly path: string }[];
  readonly gates?: readonly { readonly path: string; readonly execution: 'live' | 'manual' }[];
  readonly knownGaps: readonly string[];
};
export type P06ReportCheck = { readonly checkId: string; readonly title: string; readonly execution: string; readonly group: string;
  readonly status: P06ReportStatus; readonly reason: string | null; readonly scenarioIds: readonly string[];
  readonly evidence: readonly { readonly category: string; readonly path: string }[] };
export type P06ReportFile = { readonly path: string; readonly sha256: string; readonly sizeBytes: number };
export type P06AcceptanceReport = {
  readonly schemaVersion: 1; readonly phase: 'P06'; readonly layer: 'phase-acceptance'; readonly identity: P06EvidenceIdentity;
  readonly checklist: P06Checklist; readonly checklistDigest: string; readonly request: P06ReportInput;
  readonly checks: readonly P06ReportCheck[]; readonly counts: { readonly pass: number; readonly fail: number; readonly not_run: number };
  readonly offlineConclusion: 'pass' | 'fail'; readonly conclusion: 'pass' | 'fail'; readonly exitCode: 0 | 1;
  readonly blockingIssues: readonly string[]; readonly knownGaps: readonly string[];
  readonly commands: readonly { readonly scenarioId: string; readonly attempt: number; readonly argv: readonly string[]; readonly exitCode: number | null }[];
  readonly productReports: readonly { readonly featureId: string; readonly path: string }[];
  readonly files: readonly P06ReportFile[];
};
const fail = (code: string): never => { throw new Error(code); };
const same = (a: unknown, b: unknown) => hashP06Input(a) === hashP06Input(b);
const matchesIdentity = (a: P06EvidenceIdentity, b: P06EvidenceIdentity) => same(a, b);
function keys(value: object, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('invalid_schema');
}
function identity(value: P06EvidenceIdentity): void {
  keys(value, ['runId', 'testedCommit', 'inputDigest']);
  if (!/^[\w][\w-]{0,79}$/.test(value.runId) || !/^[a-f0-9]{40}$/.test(value.testedCommit) || !/^[a-f0-9]{64}$/.test(value.inputDigest)) fail('invalid_identity');
}
function noLinks(path: string): void {
  const lexical = resolve(path), temporary = resolve(tmpdir());
  let current = lexical.startsWith(temporary + sep) ? realpathSync(temporary) + lexical.slice(temporary.length) : lexical;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('directory_symlink');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function relativePath(path: string): string {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.json$/.test(path) || path.split('/').some(p => p === '.' || p === '..')) fail('unsafe_path');
  return path;
}
function readFile(directory: string, path: string): Buffer {
  const target = join(directory, relativePath(path));
  noLinks(target);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || stat.size < 1) fail('invalid_evidence_file');
  const bytes = readFileSync(target);
  safeP06Text(bytes.toString('utf8'));
  safeP06Json(JSON.parse(bytes.toString('utf8')));
  return bytes;
}
function parse(directory: string, path: string): unknown { return JSON.parse(readFile(directory, path).toString('utf8')); }
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
const slot = (r: P06ScenarioRecord) => `${r.scenarioId}-a${r.attempt}`;
function validateInput(input: P06ReportInput, checklist: P06Checklist): void {
  keys(input, ['identity', 'toolchain', 'checks', 'scenarios', 'products', 'gates', 'knownGaps']); identity(input.identity);
  if (!input.toolchain || !Object.keys(input.toolchain).length || Object.values(input.toolchain).some(v => typeof v !== 'string' || !v) ||
      !Array.isArray(input.knownGaps) || input.knownGaps.some(g => typeof g !== 'string' || !g)) fail('invalid_metadata');
  const ids = new Set<string>();
  for (const check of input.checks) {
    keys(check, ['checkId', 'status', 'executionMode', 'reason']);
    const itemCandidate = checklist.items.find(i => i.id === check.checkId);
    if (!itemCandidate) fail('unknown_check');
    const item = itemCandidate!;
    if (ids.has(check.checkId)) fail('duplicate_check');
    ids.add(check.checkId);
    if (!['pass', 'fail', 'not_run'].includes(check.status)) fail('invalid_status');
    const expected = item.execution === 'offline' ? 'fake' : item.execution;
    if (check.executionMode !== expected) fail('execution_mismatch');
    if (item.group === 'deferred' && check.status !== 'not_run') fail('deferred_must_be_not_run');
  }
  if (checklist.items.some(i => i.group !== 'deferred' && !ids.has(i.id))) fail('missing_required_check');
  const slots = new Set<string>();
  for (const record of input.scenarios) {
    validateP06Scenario(record, input.identity);
    if (!P06_REQUIRED_EVIDENCE_SCENARIOS.includes(record.scenarioId as typeof P06_REQUIRED_EVIDENCE_SCENARIOS[number])) fail('unknown_scenario');
    if (slots.has(slot(record))) fail('duplicate_scenario');
    slots.add(slot(record));
  }
  safeP06Json(input);
}
function validateGate(value: unknown, expected: P06EvidenceIdentity, execution: 'live' | 'manual'): P06GateCapture {
  const gate = value as P06GateCapture;
  keys(gate, ['schemaVersion', 'runId', 'testedCommit', 'inputDigest', 'execution', 'producer', 'command', 'exitCode', 'usage', 'cleanup', 'live', 'manual']);
  if (gate.schemaVersion !== 1 || !matchesIdentity({ runId: gate.runId, testedCommit: gate.testedCommit, inputDigest: gate.inputDigest }, expected) ||
      gate.execution !== execution || gate.producer !== (execution === 'manual' ? 'owner' : 'live-runner')) fail('gate_identity_mismatch');
  keys(gate.usage, ['source', 'requests']); keys(gate.cleanup, ['confirmed', 'processesGone', 'resourcesRemoved']);
  if (!Array.isArray(gate.command) || !gate.command.length || gate.command.some(p => typeof p !== 'string' || !p) ||
      !Number.isSafeInteger(gate.exitCode) || gate.exitCode < 0 || gate.usage.source !== 'reported' || !Number.isSafeInteger(gate.usage.requests) || gate.usage.requests < 0 ||
      Object.values(gate.cleanup).length !== 3 || Object.values(gate.cleanup).some(v => typeof v !== 'boolean')) fail('invalid_gate');
  if (execution === 'live') {
    if (!gate.live || gate.manual) fail('invalid_live');
    const live = gate.live!;
    keys(live, ['authorizedBy', 'provider', 'model', 'maxRequests', 'realModel']);
    if (![live.authorizedBy, live.provider, live.model].every(v => typeof v === 'string' && v.length > 0) ||
        live.realModel !== true || !Number.isSafeInteger(live.maxRequests) || gate.usage.requests < 1 || gate.usage.requests > live.maxRequests) fail('invalid_live');
  } else {
    if (!gate.manual || gate.live) fail('invalid_manual');
    const manual = gate.manual!;
    keys(manual, ['status', 'confirmedBy', 'confirmedAt', 'decision']);
    if (!['pending', 'confirmed', 'rejected'].includes(manual.status) || !['approved', 'rejected'].includes(manual.decision) ||
        typeof manual.confirmedBy !== 'string' || !manual.confirmedBy || !/^\d{4}-\d\d-\d\dT.*Z$/.test(manual.confirmedAt) || !Number.isFinite(Date.parse(manual.confirmedAt))) fail('invalid_manual');
  }
  return gate;
}

/** Recomputes every derived value from frozen checks and independently verified file contents. */
export function buildP06AcceptanceReport(sourceDirectory: string, input: P06ReportInput, checklist = loadP06Checklist()): P06AcceptanceReport {
  validateP06Checklist(checklist); validateInput(input, checklist);
  const material = new Map<string, P06ReportFile>();
  function add(path: string): void {
    if (material.has(path)) return;
    const bytes = readFile(sourceDirectory, path);
    material.set(path, { path, sha256: hashP06Bytes(bytes), sizeBytes: bytes.length });
  }
  for (const record of input.scenarios) {
    if (record.status === 'not_run') continue;
    if (!verifyP06Scenario(sourceDirectory, record, input.identity).ok) fail('scenario_verification_failed');
    add(`${slot(record)}/result.json`);
    for (const ref of record.evidenceRefs) add(ref.path);
  }
  const productReports = input.products.map(product => {
    keys(product, ['path']);
    if (!/^products\/[\w-]+\.json$/.test(product.path) || material.has(product.path)) fail('invalid_product_path');
    const body = parse(sourceDirectory, product.path) as { report: unknown };
    const capture = validateP05ProductCapture(body, { runId: input.identity.runId, commit: input.identity.testedCommit, inputsDigest: input.identity.inputDigest });
    validateAppQueryResponse('features.report.get', body.report);
    add(product.path);
    return { featureId: capture.featureId, path: product.path };
  });
  if (new Set(productReports.map(p => p.featureId)).size !== productReports.length) fail('duplicate_product');
  const gates = new Map<string, { gate: P06GateCapture; path: string }>();
  for (const ref of input.gates ?? []) {
    keys(ref, ['path', 'execution']);
    if (!['live', 'manual'].includes(ref.execution) || gates.has(ref.execution) || !/^gates\/[\w-]+\.json$/.test(ref.path)) fail('invalid_gate_reference');
    const gate = validateGate(parse(sourceDirectory, ref.path), input.identity, ref.execution);
    add(ref.path); gates.set(ref.execution, { gate, path: ref.path });
  }
  const blockingIssues: string[] = [];
  if (!productReports.length) blockingIssues.push('missing_product_report');
  const checks: P06ReportCheck[] = checklist.items.map(item => {
    const claim = input.checks.find(c => c.checkId === item.id);
    const evidence: { category: string; path: string }[] = [];
    let status: P06ReportStatus = claim?.status ?? 'not_run', reason: string | null = claim?.reason ?? null;
    if (item.group === 'deferred') { status = 'not_run'; reason = 'deferred_full_history_not_run'; }
    else if (item.execution === 'offline') {
      const required = [...item.scenarioIds];
      if (item.id === 'P06-FR1-OFFLINE-CLOSURE') required.push('FR-1');
      if (item.id === 'P06-FR2-NEGATIVE-EVIDENCE') required.push('FR-2');
      if (item.scenarioIds.includes('I07')) required.push(...P06_REQUIRED_EVIDENCE_SCENARIOS.filter(s => s.startsWith('I07-')));
      if (item.scenarioIds.includes('I08')) required.push('I08-report-write-failed');
      const records = input.scenarios.filter(r => required.includes(r.scenarioId));
      for (const r of records) for (const ref of r.evidenceRefs) evidence.push({ category: ref.category, path: ref.path });
      if (records.length) evidence.push({ category: 'sha', path: 'report.json#identity' });
      for (const p of productReports) evidence.push({ category: 'report', path: p.path });
      const failed = records.find(r => r.status === 'fail');
      const missing = required.filter(s => !records.some(r => r.scenarioId === s));
      const notRun = records.find(r => r.status === 'not_run');
      if (failed || status === 'fail') { status = 'fail'; reason = failed?.reason ?? reason ?? 'check_failed'; }
      else if (status === 'not_run' || missing.length || notRun) { status = 'not_run'; reason = missing.length ? `missing_scenarios:${missing.join(',')}` : notRun?.reason ?? reason ?? 'not_run'; }
    } else {
      const external = gates.get(item.execution);
      if (!external) { status = 'not_run'; reason = item.execution === 'manual' ? 'owner_pending' : 'live_not_run'; }
      else {
        const gate = external.gate;
        // Each category is a typed subdocument or separate verified product, never copied prose.
        for (const category of ['command-exit', 'usage', 'cleanup', 'artifact', item.execution]) evidence.push({ category, path: `${external.path}#${category}` });
        evidence.push({ category: 'sha', path: 'report.json#identity' }, { category: 'manifest', path: 'report.json#files' });
        for (const p of productReports) evidence.push({ category: 'report', path: p.path });
        if (gate.exitCode !== 0 || !Object.values(gate.cleanup).every(Boolean) || gate.manual?.status === 'rejected' || gate.manual?.decision === 'rejected') { status = 'fail'; reason = 'external_gate_failed'; }
        else if (gate.manual && gate.manual.status !== 'confirmed') { status = 'not_run'; reason = 'owner_pending'; }
      }
    }
    if (status === 'pass') {
      const missing = item.evidence.filter(c => !evidence.some(e => e.category === c));
      if (missing.length) { status = 'fail'; reason = `missing_categories:${missing.join(',')}`; }
    }
    if (item.group !== 'deferred' && status !== 'pass') blockingIssues.push(`${item.id}:${reason ?? status}`);
    return { checkId: item.id, title: item.title, execution: item.execution, group: item.group, status, reason, scenarioIds: [...item.scenarioIds], evidence };
  });
  // A failed record is never hidden by an unrelated claim or a successful later attempt.
  for (const record of input.scenarios.filter(r => r.status === 'fail')) blockingIssues.push(`${slot(record)}:${record.reason}`);
  const required = checks.filter(c => c.group !== 'deferred');
  const counts = { pass: required.filter(c => c.status === 'pass').length, fail: required.filter(c => c.status === 'fail').length, not_run: required.filter(c => c.status === 'not_run').length };
  const offlineConclusion = required.filter(c => c.execution === 'offline').every(c => c.status === 'pass') && productReports.length > 0 ? 'pass' : 'fail';
  const conclusion = blockingIssues.length === 0 ? 'pass' : 'fail';
  return { schemaVersion: 1, phase: 'P06', layer: 'phase-acceptance', identity: input.identity, checklist, checklistDigest: digestP06Checklist(checklist), request: input,
    checks, counts, offlineConclusion, conclusion, exitCode: conclusion === 'pass' ? 0 : 1, blockingIssues,
    knownGaps: [...input.knownGaps, ...checks.filter(c => c.status === 'not_run').map(c => `${c.checkId}:${c.reason}`)],
    commands: input.scenarios.map(r => ({ scenarioId: r.scenarioId, attempt: r.attempt, argv: r.command, exitCode: r.exitCode })),
    productReports, files: [...material.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
export function renderP06Summary(report: P06AcceptanceReport): string {
  const cell = (v: string) => v.replace(/[|\r\n]/g, ' ');
  return `# P06 acceptance\n\nRun: ${report.identity.runId}\nCommit: ${report.identity.testedCommit}\nInput: ${report.identity.inputDigest}\nChecklist: ${report.checklistDigest}\n\nOffline: ${report.offlineConclusion}; phase: ${report.conclusion}\nPass: ${report.counts.pass}; fail: ${report.counts.fail}; not_run: ${report.counts.not_run}\n\n| Check | Execution | Status | Reason |\n| --- | --- | --- | --- |\n${report.checks.map(c => `| ${c.checkId} | ${c.execution} | ${c.status} | ${cell(c.reason ?? '')} |`).join('\n')}\n\nBlocking issues:\n${report.blockingIssues.map(s => `- ${cell(s)}`).join('\n')}\n\nKnown gaps:\n${report.knownGaps.map(s => `- ${cell(s)}`).join('\n')}\n\nToolchain: ${cell(JSON.stringify(report.request.toolchain))}\nCommands and evidence hashes: report.json\n`;
}
export function verifyP06ReportDirectory(directory: string, expected: P06EvidenceIdentity): { ok: boolean; exitCode: 0 | 1; problems: string[] } {
  try {
    identity(expected); noLinks(directory);
    const report = parse(directory, 'report.json') as P06AcceptanceReport;
    if (!matchesIdentity(report.identity, expected)) fail('report_identity_mismatch');
    const rebuilt = buildP06AcceptanceReport(directory, report.request, validateP06Checklist(report.checklist));
    if (!same(report, rebuilt)) fail('report_schema_or_aggregation_mismatch');
    const expectedFiles = ['report.json', 'summary.md', ...report.files.map(f => f.path)].sort();
    if (!same(filesIn(directory), expectedFiles)) fail('directory_manifest_mismatch');
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8'); safeP06Text(summary);
    if (summary !== renderP06Summary(report)) fail('summary_mismatch');
    return { ok: true, exitCode: report.exitCode, problems: [] };
  } catch { return { ok: false, exitCode: 1, problems: ['p06_report_verification_failed'] }; }
}
export function writeP06AcceptanceReport(options: { reportRoot: string; sourceDirectory: string; input: P06ReportInput }) {
  // Reserve the run before any write; EEXIST leaves the entire prior run untouched.
  identity(options.input.identity); noLinks(options.reportRoot);
  mkdirSync(options.reportRoot, { recursive: true, mode: 0o700 });
  const directory = join(options.reportRoot, options.input.identity.runId);
  mkdirSync(directory, { mode: 0o700 });
  let report: P06AcceptanceReport | null = null;
  try {
    report = buildP06AcceptanceReport(options.sourceDirectory, options.input);
    for (const ref of report.files) {
      const target = join(directory, ref.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = readFile(options.sourceDirectory, ref.path);
      if (hashP06Bytes(bytes) !== ref.sha256 || bytes.length !== ref.sizeBytes) fail('source_changed');
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(directory, 'report.json'), safeP06Json(report), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'summary.md'), safeP06Text(renderP06Summary(report)), { flag: 'wx', mode: 0o600 });
    const verification = verifyP06ReportDirectory(directory, options.input.identity);
    if (!verification.ok) fail('report_readback_failed');
    return { directory, report, verification, exitCode: report.exitCode };
  } catch {
    const verification = { ok: false, exitCode: 1 as const, problems: ['p06_report_publication_failed'] };
    // Diagnostics contain no caller text, scanner hits or filesystem error messages.
    writeFileSync(join(directory, 'diagnostic.json'), JSON.stringify(verification, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { directory, report, verification, exitCode: 1 as const };
  }
}
