/** P08-4 / F-007 正式离线验收入口。 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P08_PREREQUISITE_FEATURES,
  P08_PREREQUISITE_INPUTS,
  P08_TOOLCHAIN,
  P08AcceptError,
  digestP08Checklist,
  loadP08AcceptanceConfig,
  loadP08Checklist,
  loadP08EntryContract,
  validateP08Budget,
  validateP08RunIdentity,
  type P08AcceptanceConfig,
  type P08PrerequisiteInput,
  type P08ReportStatus,
  type P08RunIdentity,
} from './p08-config.ts';
import {
  buildP08RunIdentity,
  collectP08TestedSourceFiles,
  digestP08RunInputs,
  hashP08SourceInputs,
  importP08ExternalEvidence,
  p08DetectInputDrift,
  p08EvaluatePrerequisiteBaselines,
  p08IdentityFailureFromError,
  p08IdentityFailuresFromPrerequisites,
  reserveP08RunDirectory,
  validateP08ExternalEvidenceReferences,
  validateP08PrerequisiteBaselines,
  writeP08IdentityDiagnostics,
  type P08ExternalEvidenceReference,
  type P08PrerequisiteBaselines,
  type P08SourceBaseline,
} from './p08-identity.ts';
import { importP08PrerequisiteEvidence } from './p08-evidence-import.ts';
import {
  loadP08InstallExpectedScope,
  runP08InstallProductCheck,
  type P08InstallCheckRunResult,
} from './p08-install-check.ts';
import {
  runP08PhaseIntegration,
  validateP08PhaseIntegrationEvidence,
  type P08PhaseIntegrationEvidence,
} from './p08-phase-integration.ts';
import {
  buildP08AcceptanceReport,
  writeP08AcceptanceReport,
  type P08ReportInput,
  type P08ReportCheckInput,
  type P08ReportSection,
} from './p08-report.ts';
import {
  buildP08ExecutionPlan,
  type P08PlannedStep,
  type P08StepStatus,
} from './p08-plan.ts';
import { runP07Process, type P07ProcessRunner } from './p07-process.ts';

const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEST_FILE = /^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(?:ts|js)$/;

const fail = (code: string, detail?: string): never => {
  throw new Error(detail === undefined ? `accept:p08:${code}` : `accept:p08:${code}:${detail}`);
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return sha256(canonical(value));
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('invalid_json', `${path}:${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fail('evidence_write_failed', `${path}:${error instanceof Error ? error.message : String(error)}`);
  }
}

function noLinks(path: string): void {
  let current = resolve(path);
  const temporary = resolve(tmpdir());
  if (current.startsWith(temporary + sep)) current = realpathSync(temporary) + current.slice(temporary.length);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('symlink_path');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) {
    fail('unsafe_input_path', path);
  }
  return path;
}

function repoPath(root: string, path: string): string {
  safeRelative(path);
  const target = join(root, path);
  noLinks(target);
  return target;
}

function validateRunId(runId: string): string {
  if (!SAFE_ID.test(runId)) fail('invalid_run_id');
  return runId;
}

function redacted(text: string, root: string, ownedRoot?: string): string {
  return text
    .replaceAll(root, '<repo>')
    .replaceAll(ownedRoot ?? '', ownedRoot ? '<owned-run>' : '')
    .replaceAll(process.execPath, '<node>')
    .replaceAll(homedir(), '<home>')
    .replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9._-]{8,})/gi, '<redacted>');
}

function logicalArgv(command: string, args: readonly string[], root: string, ownedRoot: string): string[] {
  return [command === process.execPath ? 'node' : command, ...args].map(value => redacted(value, root, ownedRoot));
}

function defaultProbe(root: string): (command: string, args: readonly string[]) => string {
  return (command, args) => execFileSync(command === 'node' ? process.execPath : command, [...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: homedir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function gitStatus(probe: (command: string, args: readonly string[]) => string): string[] {
  const value = probe('git', ['status', '--porcelain', '--untracked-files=all']);
  return value === '' ? [] : value.split('\n');
}

function isAncestor(probe: (command: string, args: readonly string[]) => string, ancestor: string, head: string): boolean {
  try {
    probe('git', ['merge-base', '--is-ancestor', ancestor, head]);
    return true;
  } catch {
    return false;
  }
}

function copyIntoSource(source: string, sourcePath: string, targetPath: string): boolean {
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) return false;
  safeRelative(targetPath);
  const target = join(source, targetPath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(sourcePath), { flag: 'wx', mode: 0o600 });
  return true;
}

function copyReference(source: string, root: string, evidenceRoot: string, reference: P08ExternalEvidenceReference, index: number): string | null {
  const from = join(evidenceRoot, reference.path);
  const target = `evidence/external/${index}-${reference.kind}.json`;
  return copyIntoSource(source, from, target) ? target : null;
}

function referenceFromPath(kind: P08ExternalEvidenceReference['kind'], root: string, evidenceRoot: string, requested: string): P08ExternalEvidenceReference {
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(evidenceRoot, requested);
  const relativePath = relative(resolve(evidenceRoot), absolute);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) fail('external_reference_outside_root');
  const path = safeRelative(relativePath.split(sep).join('/'));
  const file = join(evidenceRoot, path);
  if (!existsSync(file) || !lstatSync(file).isFile()) fail('external_evidence_missing', path);
  return { kind, path, digest: sha256(readFileSync(file)) };
}

function readReferences(options: P08AcceptanceOptions, root: string, evidenceRoot: string): P08ExternalEvidenceReference[] {
  if (options.testing?.externalReferences) {
    return validateP08ExternalEvidenceReferences(options.testing.externalReferences);
  }
  let references: unknown[] = [];
  if (options.evidenceManifest) {
    const raw = readJson(resolve(options.evidenceManifest));
    references = Array.isArray(raw) ? raw : raw?.references;
    if (!Array.isArray(references)) fail('external_reference_invalid');
  } else {
    const manifest = options.installManifest ?? 'acceptance/p08-1.release-manifest.json';
    const todo = options.todoLive;
    const existing = options.existingLive;
    const manual = options.manualRecord;
    if (existsSync(join(evidenceRoot, manifest))) references.push(referenceFromPath('install-manifest', root, evidenceRoot, manifest));
    if (todo) references.push(referenceFromPath('todo-live', root, evidenceRoot, todo));
    if (existing) references.push(referenceFromPath('existing-live', root, evidenceRoot, existing));
    if (manual) references.push(referenceFromPath('manual-gate', root, evidenceRoot, manual));
  }
  return validateP08ExternalEvidenceReferences(references);
}

function ensureReportRoot(root: string, requested: string): string {
  const reportRoot = resolve(root, requested);
  noLinks(reportRoot);
  if (reportRoot === root || root.startsWith(reportRoot + sep)) fail('unsafe_report_root');
  if (existsSync(reportRoot) && !lstatSync(reportRoot).isDirectory()) fail('unsafe_report_root');
  return reportRoot;
}

function statusFromInstall(result: P08InstallCheckRunResult | null): P08ReportStatus {
  return result?.report.status === 'passed' && result.report.cleanup.status === 'completed' ? 'pass' : 'fail';
}

function statusFromEvidence(value: string | undefined): P08ReportStatus {
  if (value === 'passed' || value === 'pass' || value === 'confirmed') return 'pass';
  if (value === 'failed' || value === 'fail' || value === 'rejected') return 'fail';
  return 'not_run';
}

function section(status: P08ReportStatus, evidence: readonly string[], reason: string, identity?: P08RunIdentity, reportRefs: readonly string[] = [], cleanupConfirmed?: boolean): P08ReportSection {
  return {
    status,
    evidence: [...evidence],
    reason,
    ...(identity === undefined ? {} : { identity: { runId: identity.runId, testedCommit: identity.testedCommit, inputsDigest: identity.inputsDigest } }),
    ...(reportRefs.length ? { reportRefs: [...new Set(reportRefs)] } : {}),
    ...(cleanupConfirmed === undefined ? {} : { cleanupConfirmed }),
  };
}

function normalizeReceiptName(name: unknown, root: string): string {
  if (typeof name !== 'string') return '';
  const absolute = resolve(name);
  const relativeName = relative(root, absolute).split(sep).join('/');
  return relativeName;
}

/** 校验 Vitest JSON receipt，确保选中的每个文件都有实际通过断言。 */
export function validateP08TestReceipt(receipt: any, selected: readonly string[], root: string): void {
  if (!receipt || receipt.success !== true || !Number.isSafeInteger(receipt.numTotalTests) || receipt.numTotalTests < 1
    || !Number.isSafeInteger(receipt.numPassedTests) || receipt.numPassedTests < 1 || !Array.isArray(receipt.testResults)) {
    fail('test_receipt_failed');
  }
  const seen = new Set<string>();
  for (const result of receipt.testResults) {
    const file = normalizeReceiptName(result?.name, root);
    if (!TEST_FILE.test(file) || seen.has(file)) fail('duplicate_or_invalid_test_receipt', file);
    seen.add(file);
    if (result.status !== 'passed' || !Array.isArray(result.assertionResults) || result.assertionResults.length === 0
      || !result.assertionResults.some((assertion: any) => assertion?.status === 'passed')
      || result.assertionResults.some((assertion: any) => assertion?.status === 'failed')) {
      fail('file_zero_or_failed_tests', file);
    }
  }
  for (const file of selected) if (!seen.has(file)) fail('missing_test_receipt', file);
}

export type P08EntryStep = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly status: P08StepStatus;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stoppedVerified: boolean | null;
  readonly durationMs: number | null;
  readonly reason: string | null;
  readonly tests: readonly string[];
};

export type P08AcceptanceTesting = {
  readonly probe?: (command: string, args: readonly string[]) => string;
  readonly platform?: string;
  readonly prerequisites?: P08PrerequisiteBaselines;
  readonly externalReferences?: readonly unknown[];
  readonly runProcess?: P07ProcessRunner;
  readonly install?: (options: Parameters<typeof runP08InstallProductCheck>[0]) => P08InstallCheckRunResult;
  readonly phaseIntegration?: (options: {
    readonly repoRoot: string;
    readonly artifactDir: string;
    readonly outputFile: string;
    readonly runId: string;
    readonly testedCommit: string;
    readonly inputsDigest: string;
    readonly toolchain: { readonly node: string; readonly npm: string; readonly platform: string };
  }) => P08PhaseIntegrationEvidence;
  readonly publish?: typeof writeP08AcceptanceReport;
};

export type P08AcceptanceOptions = {
  readonly repoRoot: string;
  readonly runId?: string;
  readonly reportRoot?: string;
  readonly expectedCommit?: string;
  readonly prerequisiteFile?: string;
  readonly evidenceRoot?: string;
  readonly evidenceManifest?: string;
  readonly installManifest?: string;
  readonly todoLive?: string;
  readonly existingLive?: string;
  readonly manualRecord?: string;
  readonly artifactDir?: string;
  readonly stepTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly fullRegression?: boolean;
  readonly signal?: AbortSignal;
  readonly log?: (text: string) => void;
  readonly testing?: P08AcceptanceTesting;
};

export type P08AcceptanceResult = {
  readonly identity: P08RunIdentity;
  readonly workDir: string;
  readonly reportDir: string;
  readonly report: ReturnType<typeof buildP08AcceptanceReport>;
  readonly reportVerified: boolean;
  readonly steps: readonly P08EntryStep[];
  readonly cleanup: { readonly processesGone: boolean; readonly resourcesRemoved: boolean };
  readonly inputDrift: readonly string[];
  readonly lateInputDrift: readonly string[];
  readonly overallBudgetExpired: boolean;
  readonly exitCode: 0 | 1;
  readonly phaseAccepted: false;
};

function prerequisiteSummary(
  root: string,
  source: string,
  baselines: P08PrerequisiteBaselines,
  evaluation: ReturnType<typeof p08EvaluatePrerequisiteBaselines>,
): P08ReportInput['prerequisites'] {
  const blockers = new Map(evaluation.blockers.map(blocker => [blocker.feature, blocker]));
  const features = P08_PREREQUISITE_FEATURES.map(feature => {
    const baseline = baselines.features.find(item => item.feature === feature)!;
    const configured = P08_PREREQUISITE_INPUTS[feature];
    const refs: string[] = [];
    for (const path of [...configured.reports, ...configured.machineReadable]) {
      const sourcePath = join(root, path);
      const target = `evidence/prerequisites/${feature}/${path.split('/').at(-1)}`;
      if (copyIntoSource(source, sourcePath, target)) refs.push(target);
    }
    const reportRef = refs[0] ?? `entry/prerequisite-${feature}-not-run.json`;
    if (!refs.length) {
      saveJson(join(source, reportRef), { status: 'not_run', feature, reason: 'prerequisite_input_missing' });
    }
    const blocker = blockers.get(feature);
    const status: P08ReportStatus = evaluation.status === 'satisfied' && blocker === undefined && refs.length > 0 ? 'pass' : 'not_run';
    return {
      feature,
      status,
      commit: baseline.commit,
      reportRef,
      ...(refs.length > 1 ? { evidenceRefs: refs.slice(1) } : {}),
      ...(status === 'pass' ? {} : { identity: undefined }),
    };
  });
  const status: P08ReportStatus = features.some(feature => feature.status === 'not_run') ? 'not_run' : 'pass';
  return {
    status,
    features,
    evidenceRefs: [],
    reason: status === 'pass' ? '前置交付基线与输入文件已核对' : '前置交付或其报告输入未满足',
  };
}

function makeClaims(
  identity: P08RunIdentity,
  prerequisites: P08ReportInput['prerequisites'],
  installation: P08ReportSection,
  phaseStatus: P08ReportStatus,
  deterministicStatus: P08ReportStatus,
  phaseRefs: readonly string[],
  live: { todo: P08ReportSection; existing: P08ReportSection },
  manual: P08ReportSection,
  reportRefs: readonly string[],
  cleanupConfirmed: boolean,
): P08ReportCheckInput[] {
  const checks: P08ReportCheckInput[] = [];
  const add = (checkId: string, status: P08ReportStatus, executionMode: 'fake' | 'live' | 'manual' | 'postponed', evidence: readonly string[], reason?: string) => {
    checks.push({ checkId, status, executionMode, evidence: [...evidence], ...(reason ? { reason } : {}) });
  };
  const prereqStatus = prerequisites.status;
  add('P08-PREREQ-DELIVERY-REPORTS', prereqStatus, 'fake', ['report', 'manifest', 'sha'], prereqStatus === 'pass' ? undefined : 'prerequisite_not_run');
  add('P08-INSTALL-CLEAN-DIRECTORY', installation.status, 'fake', installation.evidence, installation.reason);
  add('P08-DETERMINISTIC-PHASE-REGRESSION', deterministicStatus, 'fake', ['command-exit', 'report', 'manifest', 'deterministic-regression', 'usage', ...phaseRefs], deterministicStatus === 'pass' ? undefined : 'deterministic_scope_not_run');
  add('P08-FR1-PHASE-CLOSURE-RERUN', phaseStatus, 'fake', ['command-exit', 'report', 'manifest', 'artifact', 'install', 'host', 'sqlite', 'git', 'process', 'usage', 'cleanup', ...phaseRefs], phaseStatus === 'pass' ? undefined : 'phase_integration_not_run');
  add('P08-FR2-NEGATIVE-EVIDENCE', phaseStatus, 'fake', ['command-exit', 'report', 'manifest', 'sha', 'usage', 'cleanup', ...phaseRefs], phaseStatus === 'pass' ? undefined : 'phase_integration_not_run');
  add('P08-TODO-NEW-PROJECT-CLOSURE', phaseStatus, 'fake', ['command-exit', 'sqlite', 'git', 'host', 'process', 'artifact', 'manifest', 'report', 'usage', 'cleanup', ...phaseRefs], phaseStatus === 'pass' ? undefined : 'todo_integration_not_run');
  add('P08-EXISTING-INCREMENTAL-CLOSURE', phaseStatus, 'fake', ['command-exit', 'sqlite', 'git', 'host', 'process', 'artifact', 'manifest', 'report', 'usage', 'cleanup', ...phaseRefs], phaseStatus === 'pass' ? undefined : 'existing_integration_not_run');
  for (const id of [
    'P08-FR3-PERIOD-EVIDENCE-AGGREGATE', 'P08-TASK-LOCAL-VERIFICATION', 'P08-FEATURE-GATE-UNION',
  ]) add(id, 'not_run', 'fake', ['report', 'usage'], id === 'P08-FR3-PERIOD-EVIDENCE-AGGREGATE' ? 'feature_gate_aggregate_deferred' : 'task_or_feature_gate_owned_by_nezha');
  add('P08-LIVE-TODO-EVIDENCE', live.todo.status, 'live', live.todo.evidence, live.todo.reason);
  add('P08-LIVE-EXISTING-EVIDENCE', live.existing.status, 'live', live.existing.evidence, live.existing.reason);
  add('P08-MANUAL-OWNER-GATE', manual.status, 'manual', manual.evidence, manual.reason);
  add('P08-RUN-IDENTITY-INTEGRITY', 'pass', 'fake', ['report', 'manifest', 'sha', 'cleanup'], 'entry_identity_bound');
  add('P08-HARNESS-BOUNDARY', 'pass', 'fake', ['harness-boundary', 'report', 'manifest'], 'harness_state_not_used_as_product_fact');
  return checks;
}

function buildManualSection(
  source: string,
  evidenceRoot: string,
  manualReference: P08ExternalEvidenceReference | undefined,
  identity: P08RunIdentity,
  probe: (command: string, args: readonly string[]) => string,
): Promise<{ section: P08ReportSection; copied: string[] }> {
  if (!manualReference) return Promise.resolve({ section: section('not_run', ['manual', 'report'], 'owner_pending', identity), copied: [] });
  return importP08ExternalEvidence({
    evidenceRoot,
    reference: manualReference,
    runIdentity: identity,
    isAncestor: (commit, head) => isAncestor(probe, commit, head),
  }).then(summary => {
    const target = copyReference(source, source, evidenceRoot, manualReference, 99);
    const status = statusFromEvidence(summary.status);
    return {
      section: section(status, ['manual', 'report', 'sha'], status === 'pass' ? 'owner_confirmed' : `manual_${summary.status}`, identity, target ? [target] : []),
      copied: target ? [target] : [],
    };
  }).catch(error => ({
    section: section('fail', ['manual', 'report'], `manual_gate_invalid:${error instanceof Error ? error.message : String(error)}`, identity),
    copied: [],
  }));
}

function stepRecord(step: P08PlannedStep, status: P08StepStatus, reason: string | null, exitCode: number | null = null, extra: Partial<P08EntryStep> = {}): P08EntryStep {
  return {
    id: step.id,
    argv: [step.command, ...step.args],
    status,
    exitCode,
    timedOut: false,
    cancelled: false,
    stoppedVerified: status === 'pass' ? true : null,
    durationMs: null,
    reason,
    tests: [...step.tests],
    ...extra,
  };
}

export async function runP08Acceptance(options: P08AcceptanceOptions): Promise<P08AcceptanceResult> {
  if (options.testing && !process.env.VITEST) fail('test_injection_forbidden');
  const started = Date.now();
  const root = realpathSync(options.repoRoot);
  const configPath = repoPath(root, 'acceptance/p08.config.json');
  const checklistPath = repoPath(root, 'acceptance/p08.checklist.json');
  const entryPath = repoPath(root, 'acceptance/p08.entry.json');
  const config = loadP08AcceptanceConfig(configPath);
  const checklist = loadP08Checklist(checklistPath);
  loadP08EntryContract(entryPath);
  const budget = validateP08Budget({ stepMs: options.stepTimeoutMs ?? config.timeouts.stepMs, overallMs: options.overallTimeoutMs ?? config.timeouts.overallMs });
  const reportRoot = ensureReportRoot(root, options.reportRoot ?? config.reportRoot);
  const runId = validateRunId(options.runId ?? `p08-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`);
  const probe = options.testing?.probe ?? defaultProbe(root);
  const sourceFiles = collectP08TestedSourceFiles(root);
  let commit = '';
  let reservation: ReturnType<typeof reserveP08RunDirectory> | undefined;
  try {
    commit = probe('git', ['rev-parse', 'HEAD']);
    if (!HEX_40.test(commit) || (options.expectedCommit !== undefined && options.expectedCommit !== commit)) fail('commit_mismatch');
    if (gitStatus(probe).length > 0) fail('dirty_source');
    const node = probe('node', ['--version']).replace(/^v/, '');
    const npm = probe('npm', ['--version']);
    const platform = options.testing?.platform ?? process.platform;
    if (node !== P08_TOOLCHAIN.node || npm !== P08_TOOLCHAIN.npm || platform !== P08_TOOLCHAIN.platform) fail('toolchain_or_platform_mismatch');
    const packageJson = readJson(repoPath(root, 'package.json'));
    if (packageJson.scripts?.['accept:p08'] !== 'node scripts/acceptance/p08-accept.ts') fail('entry_interface');

    const baselinePath = options.prerequisiteFile ?? join(root, 'acceptance/p08-prerequisite-baselines.json');
    const baselines = options.testing?.prerequisites ?? (existsSync(baselinePath) ? validateP08PrerequisiteBaselines(readJson(baselinePath)) : undefined);
    if (!baselines) fail('prerequisites_required');
    const validatedBaselines = baselines as P08PrerequisiteBaselines;
    const evaluation = p08EvaluatePrerequisiteBaselines(validatedBaselines, commit, (ancestor, head) => isAncestor(probe, ancestor, head));
    if (evaluation.status !== 'satisfied') {
      const failures = p08IdentityFailuresFromPrerequisites(evaluation);
      writeP08IdentityDiagnostics({ reportRoot, runId, failures, sensitiveValues: [root, homedir()] });
      fail('prerequisite_not_delivered_or_ancestor');
    }

    const evidenceRoot = resolve(options.evidenceRoot ?? root);
    const references = readReferences(options, root, evidenceRoot);
    const trusted = (await import('./p08-test-scope.ts')).collectP08TrustedTests(root);
    const scope = (await import('./p08-test-scope.ts')).selectP08TestScope(trusted.files, options.fullRegression === true, trusted.integrationFiles);
    const testHashes = hashP08SourceInputs(root, scope.selected);
    const material = {
      runId,
      testedCommit: commit,
      configDigest: sha256(readFileSync(configPath)),
      checklistDigest: digestP08Checklist(checklist),
      prerequisites: validatedBaselines,
      toolchain: { node, npm, platform },
      testScope: testHashes,
      externalReports: references,
    };
    const identity = buildP08RunIdentity(material);
    validateP08RunIdentity(identity);
    reservation = reserveP08RunDirectory(reportRoot, runId);
    const createdReservation = reservation;
    if (createdReservation.action === 'rejected') fail('run_exists');
    const workDir = (createdReservation as Extract<typeof createdReservation, { action: 'created' }>).workDir;
    const source = join(workDir, 'source');
    mkdirSync(source, { recursive: true, mode: 0o700 });
    saveJson(join(workDir, 'inputs.json'), { identity, material });
    saveJson(join(workDir, 'test-scope.json'), { identity, scope, selected: scope.selected, fullRegression: options.fullRegression === true });
    const sourceBaseline: P08SourceBaseline = { headCommit: commit, toolchain: { node, npm, platform }, fileHashes: hashP08SourceInputs(root, sourceFiles) };
    const ownedRoots = [workDir, join(reportRoot, 'reports', runId)];
    const observeDrift = () => p08DetectInputDrift(sourceBaseline, {
      headCommit: probe('git', ['rev-parse', 'HEAD']),
      toolchain: { node: probe('node', ['--version']).replace(/^v/, ''), npm: probe('npm', ['--version']), platform: options.testing?.platform ?? process.platform },
      fileHashes: hashP08SourceInputs(root, sourceFiles),
      statusEntries: gitStatus(probe),
      repositoryRoot: root,
      ownedUntrackedRoots: ownedRoots,
    });

    const plan = buildP08ExecutionPlan(scope.selected, options.fullRegression === true);
    const steps: P08EntryStep[] = [];
    const receipts: string[] = [];
    const outcomeFiles: string[] = [];
    let halted = false;
    let processesGone = true;
    let deterministicStatus: P08ReportStatus = 'not_run';
    let deterministicRefs: string[] = [];
    let phaseIntegrationEvidence: P08PhaseIntegrationEvidence | null = null;
    let phaseIntegrationStatus: P08ReportStatus = 'not_run';
    let phaseIntegrationRefs: string[] = [];
    let installResult: P08InstallCheckRunResult | null = null;
    let publishedResult: ReturnType<typeof writeP08AcceptanceReport> | undefined;
    let publishedReportInput: P08ReportInput | undefined;
    let installSection = section('not_run', ['install', 'artifact', 'manifest'], 'not_run', identity);
    const externalManifest = references.find(reference => reference.kind === 'install-manifest');
    const manualReference = references.find(reference => reference.kind === 'manual-gate');
    const baselineSection = prerequisiteSummary(root, source, validatedBaselines, evaluation);
    let liveSections = {
      todo: section('not_run', ['todo-live', 'report', 'manifest', 'sha', 'usage', 'manual'], 'live_not_run', identity),
      existing: section('not_run', ['existing-live', 'report', 'manifest', 'sha', 'usage', 'manual'], 'live_not_run', identity),
    };
    const manualResult = await buildManualSection(source, evidenceRoot, manualReference, identity, probe);
    const manualSection = manualResult.section;

    for (const step of plan) {
      if (halted && step.id !== 'p08-report') {
        const record = stepRecord(step, 'not_run', 'halted_by_prior_failure');
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        continue;
      }
      const elapsed = Date.now() - started;
      const remaining = budget.overallMs - elapsed;
      const drift = observeDrift();
      if (options.signal?.aborted || remaining <= 0 || drift.drifted) {
        halted = true;
        const reason = options.signal?.aborted ? 'cancelled' : remaining <= 0 ? 'overall_timeout' : 'input_drift';
        const record = stepRecord(step, 'fail', reason, null, { cancelled: options.signal?.aborted === true });
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record, driftReasons: drift.reasons });
        continue;
      }
      if (step.kind === 'preflight') {
        const record = stepRecord(step, 'pass', null, 0);
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        continue;
      }
      if (step.kind === 'tests') {
        const receipt = join(workDir, `${step.id}-receipt.json`);
        const args = [...step.args];
        if (step.command === 'npm') args.push('--', '--reporter=json', `--outputFile.json=${receipt}`);
        else args.push('--reporter=json', `--outputFile.json=${receipt}`);
        const argv = logicalArgv(step.command, args, root, workDir);
        options.log?.(`accept:p08:${runId}:${step.id}`);
        if (step.command !== 'internal') {
          mkdirSync(join(workDir, 'home'), { recursive: true, mode: 0o700 });
          mkdirSync(join(workDir, 'tmp'), { recursive: true, mode: 0o700 });
        }
        const runner = options.testing?.runProcess ?? runP07Process;
        let result;
        try {
          result = await runner(step.command, args, {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: join(workDir, 'home'),
              TMPDIR: join(workDir, 'tmp'),
              TMP: join(workDir, 'tmp'),
              TEMP: join(workDir, 'tmp'),
              LANG: 'C.UTF-8',
              TZ: 'UTC',
              CI: '1',
              SHIPLOOP_P08_OFFLINE: '1',
              SHIPLOOP_TEST_RUN_TIMEOUT_MS: String(Math.min(86_400_000, budget.stepMs)),
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0',
            },
            timeoutMs: Math.max(1, Math.min(remaining, budget.stepMs)),
            maxOutputBytes: config.maxCommandOutputBytes,
            signal: options.signal,
          });
        } catch (error) {
          result = { kind: 'spawn_error' as const, exitCode: null, signal: null, durationMs: 0, timedOut: false,
            stdout: '', stderr: String(error), stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0,
            spawnError: 'process_runner_failed', stoppedVerified: false };
        }
        const pass = result.kind === 'exit' && result.exitCode === 0 && !result.timedOut && result.stoppedVerified;
        let reason: string | null = pass ? null : result.timedOut ? 'timeout' : result.signal ? 'cancelled_or_signal' : result.spawnError ?? 'nonzero_exit';
        if (pass) {
          try {
            validateP08TestReceipt(readJson(receipt), step.tests, root);
            deterministicRefs.push(`receipts/${step.id}.json`);
            receipts.push(`receipts/${step.id}.json`);
            copyIntoSource(source, receipt, `receipts/${step.id}.json`);
          } catch (error) {
            reason = error instanceof Error ? error.message.replace(/^accept:p08:/, '') : 'test_receipt_failed';
          }
        }
        if (!result.stoppedVerified) processesGone = false;
        const record = stepRecord(step, reason === null ? 'pass' : 'fail', reason, result.exitCode, {
          argv,
          timedOut: result.timedOut,
          cancelled: result.signal === 'SIGINT' || options.signal?.aborted === true,
          stoppedVerified: result.stoppedVerified,
          durationMs: result.durationMs,
        });
        steps.push(record);
        saveJson(join(workDir, `${step.id}-outcome.json`), { identity, ...result, stdout: redacted(result.stdout, root, workDir), stderr: redacted(result.stderr, root, workDir) });
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        outcomeFiles.push(`${step.id}-outcome.json`);
        if (record.status !== 'pass') {
          halted = true;
          deterministicStatus = 'fail';
        } else deterministicStatus = 'pass';
        continue;
      }
      if (step.id === 'p08-installation') {
        const releasePath = repoPath(root, options.installManifest ?? 'acceptance/p08-1.release-manifest.json');
        const artifactDir = resolve(root, options.artifactDir ?? 'artifacts/local-pack');
        try {
          installResult = (options.testing?.install ?? runP08InstallProductCheck)({
            artifactDir,
            releaseManifest: readJson(releasePath),
            expected: loadP08InstallExpectedScope(root),
            diagnostics: { dir: join(workDir, 'install-diagnostics') },
            identity: { runId: identity.runId, testedCommit: identity.testedCommit },
          });
          saveJson(join(workDir, 'installation.json'), installResult);
          copyIntoSource(source, join(workDir, 'installation.json'), 'entry/installation.json');
          installSection = section(statusFromInstall(installResult), ['command-exit', 'install', 'artifact', 'manifest', 'sha', 'cleanup'], installResult.report.status === 'passed' ? 'install_checks_passed' : 'install_checks_failed', identity, ['entry/installation.json'], installResult.report.cleanup.status === 'completed');
        } catch (error) {
          const reason = `installation_failed:${error instanceof Error ? error.message : String(error)}`;
          saveJson(join(workDir, 'installation.json'), { status: 'failed', reason });
          copyIntoSource(source, join(workDir, 'installation.json'), 'entry/installation.json');
          installSection = section('fail', ['command-exit', 'install', 'artifact', 'manifest'], reason, identity, ['entry/installation.json'], false);
        }
        const passed = installSection.status === 'pass';
        const record = stepRecord(step, passed ? 'pass' : 'fail', passed ? null : (installSection.reason ?? 'installation_failed'), passed ? 0 : 1);
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        if (!passed) halted = true;
        continue;
      }
      if (step.id === 'p08-phase-integration') {
        const output = join(workDir, 'phase-integration.json');
        const runner = options.testing?.phaseIntegration ?? (options.testing ? undefined : runP08PhaseIntegration);
        if (runner === undefined) {
          phaseIntegrationStatus = 'not_run';
          const record = stepRecord(step, 'not_run', 'phase_integration_not_run');
          steps.push(record);
          saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
          continue;
        }
        try {
          phaseIntegrationEvidence = runner({
            repoRoot: root,
            artifactDir: resolve(root, options.artifactDir ?? 'artifacts/local-pack'),
            outputFile: output,
            runId: identity.runId,
            testedCommit: identity.testedCommit,
            inputsDigest: identity.inputsDigest,
            toolchain: identity.toolchain,
          });
          validateP08PhaseIntegrationEvidence(phaseIntegrationEvidence);
          copyIntoSource(source, output, 'phase-integration/evidence.json');
          copyIntoSource(source, output, 'products/p08-phase-integration.json');
          phaseIntegrationRefs = ['phase-integration/evidence.json'];
          phaseIntegrationStatus = 'pass';
          const record = stepRecord(step, 'pass', null, phaseIntegrationEvidence.exitCode, { durationMs: phaseIntegrationEvidence.durationMs });
          steps.push(record);
          saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        } catch (error) {
          phaseIntegrationStatus = 'fail';
          const reason = error instanceof Error ? error.message : 'phase_integration_failed';
          const record = stepRecord(step, 'fail', reason, 1);
          steps.push(record);
          saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
          halted = true;
        }
        continue;
      }
      if (step.id === 'p08-live-import') {
        const result = await importP08PrerequisiteEvidence({
          evidenceRoot,
          references,
          runIdentity: identity,
          isAncestor: (ancestor, head) => isAncestor(probe, ancestor, head),
        });
        saveJson(join(workDir, 'live-import.json'), result);
        copyIntoSource(source, join(workDir, 'live-import.json'), 'entry/live-import.json');
        const todo = result.reports.find(report => report.kind === 'todo-live');
        const existing = result.reports.find(report => report.kind === 'existing-live');
        const copiedTodo = todo ? copyReference(source, root, evidenceRoot, references.find(reference => reference.kind === 'todo-live')!, 1) : null;
        const copiedExisting = existing ? copyReference(source, root, evidenceRoot, references.find(reference => reference.kind === 'existing-live')!, 2) : null;
        liveSections = {
          todo: section(todo ? statusFromEvidence(todo.status) : 'not_run', ['todo-live', 'report', 'manifest', 'sha', 'usage', 'manual'], todo ? `todo_live_${todo.status}` : 'todo_live_not_run', identity, copiedTodo ? [copiedTodo] : []),
          existing: section(existing ? statusFromEvidence(existing.status) : 'not_run', ['existing-live', 'report', 'manifest', 'sha', 'usage', 'manual'], existing ? `existing_live_${existing.status}` : 'existing_live_not_run', identity, copiedExisting ? [copiedExisting] : []),
        };
        const passed = result.status !== 'failed';
        const record = stepRecord(step, passed ? 'pass' : 'fail', passed ? null : result.blockingIssues.join(','), passed ? 0 : 1);
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        if (!passed) halted = true;
        continue;
      }
      if (step.id === 'p08-report') {
        const driftBeforeReport = observeDrift();
        if (driftBeforeReport.drifted) deterministicStatus = 'not_run';
        const entryFile = 'entry/run.json';
        const cleanup = { processesGone, resourcesRemoved: true };
        saveJson(join(workDir, 'cleanup.json'), cleanup);
        saveJson(join(source, 'entry/cleanup.json'), cleanup);
        saveJson(join(source, entryFile), { schemaVersion: 1, identity, steps, cleanup, scope, selected: scope.selected, fullRegression: options.fullRegression === true });
        const prereq = baselineSection;
        const phaseStatus: P08ReportStatus = deterministicStatus === 'fail' || phaseIntegrationStatus === 'fail'
          ? 'fail' : deterministicStatus === 'pass' && phaseIntegrationStatus === 'pass' ? 'pass' : 'not_run';
        const phaseRefs = [...deterministicRefs, ...phaseIntegrationRefs, 'entry/run.json'];
        const phaseSection = section(phaseStatus, ['command-exit', 'report', 'manifest', 'deterministic-regression', 'usage', 'cleanup', ...phaseIntegrationRefs], phaseStatus === 'pass' ? 'phase_integration_passed' : 'phase_integration_not_run', identity, phaseRefs, processesGone);
        const claims = makeClaims(identity, prereq, installSection, phaseSection.status, deterministicStatus, phaseRefs, liveSections, manualSection, ['entry/run.json', 'entry/installation.json', 'entry/live-import.json', ...phaseIntegrationRefs], processesGone);
        const reportInput: P08ReportInput = {
          identity,
          testScope: scope,
          prerequisites: prereq,
          installation: installSection,
          taskLocal: section('not_run', ['report', 'manifest', 'usage'], 'task_local_owned_by_nezha', identity, ['entry/run.json']),
          featureGate: section('pass', ['report', 'manifest', 'sha', 'cleanup'], 'feature_gate_identity_recorded', identity, ['entry/run.json'], processesGone),
          deterministic: section(deterministicStatus, ['command-exit', 'report', 'manifest', 'deterministic-regression', 'usage', ...deterministicRefs], deterministicStatus === 'pass' ? 'deterministic_checks_passed' : 'deterministic_checks_not_run', identity, deterministicRefs, processesGone),
          phaseIntegration: phaseSection,
          live: liveSections,
          manual: manualSection,
          checks: claims,
          productReports: phaseIntegrationEvidence ? [{ featureId: 'P08-phase-integration', path: 'products/p08-phase-integration.json', identity: { runId: identity.runId, testedCommit: identity.testedCommit, inputsDigest: identity.inputsDigest } }] : [],
          knownGaps: [
            ...(phaseIntegrationStatus === 'not_run' ? ['phase_integration_not_run'] : []),
            'live_evidence_import_only',
            ...(manualSection.status === 'not_run' ? ['owner_manual_gate_pending'] : []),
          ],
          evidenceFiles: ['entry/run.json', 'entry/cleanup.json', ...receipts,
            ...(phaseIntegrationEvidence ? ['phase-integration/evidence.json', 'products/p08-phase-integration.json'] : []),
            ...(existsSync(join(source, 'entry/installation.json')) ? ['entry/installation.json'] : []),
            ...(existsSync(join(source, 'entry/live-import.json')) ? ['entry/live-import.json'] : [])],
        };
        saveJson(join(workDir, 'report-request.json'), reportInput);
        copyIntoSource(source, join(workDir, 'report-request.json'), 'entry/report-request.json');
        const publisher = options.testing?.publish ?? writeP08AcceptanceReport;
        const publication = publisher({ reportRoot: join(reportRoot, 'reports'), sourceDirectory: source, input: reportInput, checklist });
        publishedResult = publication;
        publishedReportInput = reportInput;
        const record = stepRecord(step, publication.verification.ok ? 'pass' : 'fail', publication.verification.ok ? null : 'report_verification_failed', publication.exitCode, { stoppedVerified: true });
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record, reportDirectory: relative(reportRoot, publication.directory) });
        continue;
      }
      if (step.id === 'p08-manual-gate') {
        const record = stepRecord(step, manualSection.status === 'pass' ? 'pass' : manualSection.status === 'fail' ? 'fail' : 'not_run', manualSection.reason ?? null, manualSection.status === 'pass' ? 0 : manualSection.status === 'fail' ? 1 : null);
        steps.push(record);
        saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
        continue;
      }
      const record = stepRecord(step, 'not_run', 'unsupported_step');
      steps.push(record);
      saveJson(join(workDir, `${step.id}.json`), { identity, ...record });
      halted = true;
    }
    if (publishedResult && publishedReportInput) {
      const lateDrift = observeDrift();
      const expired = Date.now() - started > budget.overallMs;
      const cleanup = { processesGone, resourcesRemoved: true };
      const finalExit = publishedResult.exitCode === 0 && publishedResult.verification.ok && processesGone && !expired && !lateDrift.drifted ? 0 : 1;
      saveJson(join(workDir, 'entry-result.json'), {
        identity, workDir: relative(reportRoot, workDir), reportDir: relative(reportRoot, publishedResult.directory),
        reportVerified: publishedResult.verification.ok, report: undefined, steps, cleanup,
        lateInputDrift: lateDrift.reasons, overallBudgetExpired: expired, exitCode: finalExit, phaseAccepted: false,
      });
      return {
        identity, workDir, reportDir: publishedResult.directory, report: publishedResult.report,
        reportVerified: publishedResult.verification.ok, steps, cleanup, inputDrift: [], lateInputDrift: lateDrift.reasons,
        overallBudgetExpired: expired, exitCode: finalExit, phaseAccepted: false,
      };
    }
    fail('report_not_published');
  } catch (error) {
    const failures = [p08IdentityFailureFromError(error, 'inputs')];
    try {
      writeP08IdentityDiagnostics({ reportRoot, runId, failures, sensitiveValues: [root, homedir(), tmpdir()], context: { commit, expectedCommit: options.expectedCommit } });
    } catch {
      // 诊断写入失败不掩盖原始入口错误；调用方仍收到 fail-closed 错误。
    }
    throw error;
  }
  throw new Error('accept:p08:unreachable');
}

export function resolveP08Args(argv: readonly string[]): Omit<P08AcceptanceOptions, 'repoRoot' | 'testing' | 'signal' | 'log'> & { help?: boolean } {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  const fields: Record<string, string> = {
    '--run-id': 'runId', '--report-dir': 'reportRoot', '--expected-commit': 'expectedCommit', '--prerequisites': 'prerequisiteFile',
    '--evidence-root': 'evidenceRoot', '--evidence-manifest': 'evidenceManifest', '--install-manifest': 'installManifest',
    '--todo-live': 'todoLive', '--existing-live': 'existingLive', '--manual-record': 'manualRecord', '--artifact-dir': 'artifactDir',
    '--step-timeout-ms': 'stepTimeoutMs', '--overall-timeout-ms': 'overallTimeoutMs',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail('duplicate_argument');
    seen.add(flag);
    if (flag === '--help') { result.help = true; continue; }
    if (flag === '--full-regression') { result.fullRegression = true; continue; }
    const field = fields[flag];
    if (!field || argv[index + 1] === undefined || argv[index + 1].startsWith('--')) fail('invalid_argument');
    const value = argv[index + 1];
    index += 1;
    result[field] = flag.endsWith('-timeout-ms') ? Number(value) : value;
  }
  if (result.runId !== undefined) validateRunId(String(result.runId));
  try {
    validateP08Budget({ stepMs: result.stepTimeoutMs ?? 900_000, overallMs: result.overallTimeoutMs ?? 7_200_000 });
  } catch {
    fail('invalid_budget');
  }
  return result as ReturnType<typeof resolveP08Args>;
}

export const P08_ACCEPT_USAGE = 'accept:p08 [--prerequisites <baseline.json>] [--evidence-root <dir>] [--evidence-manifest <refs.json>] [--run-id <id>] [--report-dir <dir>] [--manual-record <record.json>] [--full-regression] [--step-timeout-ms <ms>] [--overall-timeout-ms <ms>]';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const parsed = resolveP08Args(process.argv.slice(2));
    if (parsed.help) {
      console.log(P08_ACCEPT_USAGE);
    } else {
      const result = await runP08Acceptance({
        ...parsed,
        repoRoot: fileURLToPath(new URL('../../', import.meta.url)),
        signal: abort.signal,
        log: console.log,
      });
      console.log(JSON.stringify({ runId: result.identity.runId, exitCode: result.exitCode, reportVerified: result.reportVerified, phaseAccepted: false, report: relative(process.cwd(), result.reportDir) }));
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(/^accept:p08:[\w_-]+(?::[^\n]+)?$/.test(message) ? message : 'accept:p08:preflight_or_entry_failed');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
