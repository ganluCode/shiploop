/** P06 phase entry. Offline by default; no product/Harness metadata writes. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { register } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadP06AcceptanceConfig, loadP06Checklist, loadP06EntryContract, P06_ACCEPT_CONFIG_PATH, P06_ENTRY_PATH, P06_FEATURES, P06_ENTRY_STEP_ORDER } from './p06-config.ts';
import { hashP06Bytes, hashP06Input, safeP06Json } from './p06-facts.ts';
import { notRunP06Scenario, P06_REQUIRED_EVIDENCE_SCENARIOS, verifyP06Scenario, type P06EvidenceIdentity, type P06ScenarioRecord } from './p06-evidence.ts';
import { runP05StepSequence, type P05StepRecord, type P05StepSpec } from './p05-steps.ts';
import { runP06Process } from './p06-process.ts';
import type { runBoundedProcess } from './p02-accept.ts';

let reportTools: Promise<typeof import('./p06-report.ts')> | undefined;
/** Use the repository's existing source resolver for NodeNext .js references; Vitest supplies its own resolver. */
export function loadP06ReportTools() {
  if (!reportTools) {
    if (!process.env.VITEST) register(new URL('../../test/helpers/node-ts-loader/hooks.mjs', import.meta.url), import.meta.url);
    reportTools = import('./p06-report.ts');
  }
  return reportTools;
}

const DEMO = 'test/modules/acceptance/p06-7-f008-demo.test.ts';
const fail = (code: string): never => { throw new Error(`accept:p06:${code}`); };
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
function noLinks(path: string): void {
  let current = resolve(path);
  const temp = resolve(tmpdir());
  if (current.startsWith(temp + sep)) current = realpathSync(temp) + current.slice(temp.length);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('symlink');
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
function repoFile(root: string, file: string): string {
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split('/').some(p => p === '.' || p === '..')) fail('unsafe_input_path');
  const target = join(root, file); noLinks(target);
  if (!lstatSync(target).isFile()) fail('input_not_file');
  return target;
}
/** Validate complete P06 manifests before selecting files. Task cases expand to full files at Phase scope. */
export function collectP06TrustedTests(root: string) {
  const base = 'test/index/phases/P06/features';
  const features = [...P06_FEATURES, 'P06-7'];
  const discovered = readdirSync(join(root, base), { withFileTypes: true }).map(e => e.name).sort();
  if (hashP06Input(discovered) !== hashP06Input([...features].sort())) fail('prerequisite_index_set');
  const files = new Set<string>(), inputs: string[] = [];
  for (const feature of features) {
    const manifestFile = `${base}/${feature}/feature.json`;
    noLinks(join(root, base, feature, 'tasks'));
    const actual = readdirSync(join(root, base, feature, 'tasks')).sort();
    if (!actual.length || actual.some(name => !/^F-\d{3}\.json$/.test(name))) fail('invalid_task_index_set');
    // Earlier Features register Task indexes directly; P06-5/P06-7 also freeze an aggregate manifest.
    const manifest = existsSync(join(root, manifestFile)) ? json(repoFile(root, manifestFile)) :
      { schema_version: 1, kind: 'feature', phase: 'P06', feature, tasks: actual.map(name => ({ task_id: name.slice(0, -5), index: `${base}/${feature}/tasks/${name}` })) };
    if (existsSync(join(root, manifestFile))) inputs.push(manifestFile);
    else if (feature === 'P06-5' || feature === 'P06-7') fail('missing_feature_index');
    if (manifest.schema_version !== 1 || manifest.kind !== 'feature' || manifest.phase !== 'P06' || manifest.feature !== feature || !Array.isArray(manifest.tasks) || !manifest.tasks.length) fail('invalid_feature_index');
    const declared: string[] = [];
    for (const task of manifest.tasks) {
      if (!/^F-\d{3}$/.test(task.task_id) || task.index !== `${base}/${feature}/tasks/${task.task_id}.json`) fail('invalid_task_index_path');
      declared.push(`${task.task_id}.json`);
      const index = json(repoFile(root, task.index)); inputs.push(task.index);
      if (index.schema_version !== 2 || index.task_id !== task.task_id || !Array.isArray(index.projects) || index.projects.length !== 1) fail('invalid_task_index');
      const project = index.projects[0];
      if (project.id !== 'shiploop' || !Array.isArray(project.tests) || !project.tests.length) fail('empty_test_selection');
      for (const test of project.tests) {
        if (typeof test.file !== 'string' || !/^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(ts|js)$/.test(test.file) ||
            (test.all !== true && (!Array.isArray(test.cases) || !test.cases.length || test.cases.some((c: unknown) => typeof c !== 'string' || !c))) ||
            (test.all !== undefined && test.cases !== undefined)) fail('invalid_test_selection');
        repoFile(root, test.file); files.add(test.file);
      }
    }
    if (new Set(declared).size !== declared.length || hashP06Input(declared.sort()) !== hashP06Input(actual)) fail('task_index_manifest_mismatch');
  }
  if (!files.size) fail('empty_test_selection');
  return { files: [...files].sort(), inputs: inputs.sort() };
}

export type P06Prerequisites = { approvedBy: string; features: readonly { feature: string; commit: string; delivered: boolean; interfacesSatisfied: boolean }[] };
export type P06AcceptanceOptions = {
  repoRoot: string; runId?: string; reportRoot?: string; expectedCommit?: string;
  stepTimeoutMs?: number; overallTimeoutMs?: number; fullRegression?: boolean;
  prerequisites?: P06Prerequisites; prerequisiteFile?: string; manualRecord?: string; liveRecord?: string;
  /** Read-only probes/executor injection for task-local controller tests. CLI never supplies these. */
  probe?: (command: string, args: readonly string[]) => string; runProcess?: typeof runBoundedProcess;
  log?: (text: string) => void;
};
function bounded(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 7_200_000) fail('invalid_budget');
  return value;
}
function runId(value: string): string { if (!/^[\w][\w-]{0,79}$/.test(value)) fail('invalid_run_id'); return value; }
function isolatedEnv(home: string, temporary: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LANG: 'C.UTF-8', TZ: 'UTC', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    SHIPLOOP_P06_OFFLINE: '1' };
}
export async function runP06Acceptance(options: P06AcceptanceOptions) {
  const started = Date.now(), root = realpathSync(options.repoRoot);
  const config = loadP06AcceptanceConfig(repoFile(root, P06_ACCEPT_CONFIG_PATH));
  const checklist = loadP06Checklist(repoFile(root, config.checklist));
  loadP06EntryContract(repoFile(root, P06_ENTRY_PATH));
  const pkg = json(repoFile(root, 'package.json'));
  if (pkg.scripts?.['accept:p06'] !== 'node scripts/acceptance/p06-accept.ts' || pkg.scripts.verify !== 'node scripts/verify.ts' || pkg.scripts.test !== 'node scripts/run-tests.ts') fail('entry_interface');
  const stepTimeoutMs = bounded(options.stepTimeoutMs ?? config.timeouts.stepMs);
  const overallTimeoutMs = bounded(options.overallTimeoutMs ?? config.timeouts.overallMs);
  if (overallTimeoutMs < stepTimeoutMs) fail('invalid_budget_order');
  const id = runId(options.runId ?? `p06-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`);
  const reportRoot = resolve(root, options.reportRoot ?? config.reportRoot); noLinks(reportRoot);
  const withinRepo = relative(root, reportRoot);
  if (reportRoot === root || (!withinRepo.startsWith('..' + sep) && withinRepo.split(sep).some(part => ['.git', 'node_modules', 'packages', 'scripts', 'test', 'acceptance', 'docs'].includes(part)))) fail('unsafe_report_root');
  const workDir = join(reportRoot, 'runs', id), reportDir = join(reportRoot, 'reports', id);
  if (existsSync(workDir) || existsSync(reportDir)) fail('run_exists');
  // No caller credentials, NODE_OPTIONS, Git overrides or npm-injected variables reach probes.
  const probeEnv = { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const probe = options.probe ?? ((command, args) => execFileSync(command === 'node' ? process.execPath : command, [...args], {
    cwd: root, env: probeEnv, encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }).trim());
  const commit = probe('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit) || (options.expectedCommit !== undefined && options.expectedCommit !== commit)) fail('commit_mismatch');
  if (probe('git', ['status', '--porcelain', '--untracked-files=all'])) fail('dirty_source');
  if (probe('node', ['--version']).replace(/^v/, '') !== config.toolchain.node || probe('npm', ['--version']) !== config.toolchain.npm) fail('toolchain_mismatch');
  const prerequisites: P06Prerequisites | undefined = options.prerequisites ?? (options.prerequisiteFile ? json(options.prerequisiteFile) : undefined);
  if (!prerequisites || typeof prerequisites.approvedBy !== 'string' || !prerequisites.approvedBy ||
      !Array.isArray(prerequisites.features) || prerequisites.features.length !== P06_FEATURES.length) fail('prerequisites_required');
  for (const feature of P06_FEATURES) {
    const matches = prerequisites!.features.filter(p => p.feature === feature), p = matches[0];
    if (matches.length !== 1 || p.delivered !== true || p.interfacesSatisfied !== true || !/^[a-f0-9]{40}$/.test(p.commit)) fail('prerequisite_not_delivered');
    try { probe('git', ['merge-base', '--is-ancestor', p.commit, commit]); } catch { fail('prerequisite_not_ancestor'); }
  }
  const selection = collectP06TrustedTests(root);
  const files = [...new Set([P06_ACCEPT_CONFIG_PATH, P06_ENTRY_PATH, config.checklist, 'package.json', 'package-lock.json',
    'scripts/acceptance/p06-accept.ts', 'scripts/acceptance/p06-report.ts', 'scripts/acceptance/p06-evidence.ts', 'scripts/acceptance/p06-facts.ts',
    'scripts/acceptance/p06-config.ts', 'scripts/acceptance/p06-process.ts', 'scripts/acceptance/p05-steps.ts', 'scripts/acceptance/p02-accept.ts', 'scripts/acceptance/owned-process-tree.ts',
    'scripts/verify.ts', 'scripts/run-tests.ts', 'test/helpers/node-ts-loader/hooks.mjs', 'test/helpers/node-ts-loader/register.mjs',
    'docs/p06-acceptance.md', 'docs/acceptance/p06-owner-walkthrough.md', DEMO, ...selection.inputs, ...selection.files])].sort();
  const material = { config, prerequisites: prerequisites!, stepTimeoutMs, overallTimeoutMs, fullRegression: options.fullRegression === true,
    files: files.map(file => ({ file, sha256: hashP06Bytes(readFileSync(repoFile(root, file))) })) };
  const identity: P06EvidenceIdentity = { runId: id, testedCommit: commit, inputDigest: hashP06Input(material) };
  safeP06Json(material); // Before creating any run or process.
  const externalGates = [options.liveRecord && { execution: 'live' as const, file: options.liveRecord },
    options.manualRecord && { execution: 'manual' as const, file: options.manualRecord }].filter(v => !!v);
  const gateContents = externalGates.map(gate => ({ execution: gate.execution, value: json(gate.file) }));
  gateContents.forEach(g => { if (g.value.runId !== id || g.value.testedCommit !== commit || g.value.inputDigest !== identity.inputDigest) fail('gate_identity_mismatch'); safeP06Json(g.value); });
  if (Date.now() - started >= overallTimeoutMs) fail('overall_preflight_timeout');
  mkdirSync(dirname(workDir), { recursive: true, mode: 0o700 }); mkdirSync(workDir, { mode: 0o700 });
  writeFileSync(join(workDir, 'inputs.json'), safeP06Json({ identity, material, selection }), { flag: 'wx', mode: 0o600 });
  const source = join(workDir, 'source'); mkdirSync(source, { mode: 0o700 });
  const resources = realpathSync(mkdtempSync(join(tmpdir(), `shiploop-p06-${id}-`)));
  const ownership = randomUUID();
  writeFileSync(join(resources, '.owner'), ownership, { flag: 'wx', mode: 0o600 });
  const home = join(resources, 'home'), temporary = join(resources, 'tmp');
  mkdirSync(home); mkdirSync(temporary);
  const env = { ...isolatedEnv(home, temporary), SHIPLOOP_P06_ENTRY_SOURCE: source,
    SHIPLOOP_P06_ENTRY_IDENTITY: JSON.stringify(identity), SHIPLOOP_P06_ENTRY_INPUT: join(workDir, 'inputs.json') };
  const specs: P05StepSpec[] = P06_ENTRY_STEP_ORDER.slice(0, 3).map((step, index) => ({ id: step, cwd: root, command: process.execPath,
    args: index === 0 ? ['scripts/build-host-lock.ts'] : ['scripts/run-tests.ts', ...(index === 1 ? [DEMO] : selection.files.filter(f => f !== DEMO))] }));
  if (options.fullRegression) specs.push({ id: 'p06-full-regression', cwd: root, command: 'npm', args: ['test'] });
  options.log?.(`accept:p06: run-id=${id}`);
  const sourceChanged = () => probe('git', ['rev-parse', 'HEAD']) !== commit || probe('git', ['status', '--porcelain', '--untracked-files=all']).split('\n').some(line => {
    if (!line) return false;
    // Only this run's new, untracked outputs may be ignored. Tracked changes always block.
    if (!line.startsWith('?? ')) return true;
    const path = resolve(root, line.slice(3));
    return ![workDir, reportDir].some(owned => path === owned || path.startsWith(owned + sep));
  });
  const sequence = await runP05StepSequence(specs, { evidenceDir: join(workDir, 'step-run'),
    identity: { runId: id, commit, inputsDigest: identity.inputDigest }, stepTimeoutMs, overallTimeoutMs: Math.max(1, overallTimeoutMs - (Date.now() - started)),
    maxOutputBytes: config.maxCommandOutputBytes, env,
    redact: text => text.replaceAll(root, '<repo>').replaceAll(resources, '<owned-temp>').replaceAll(process.execPath, '<node>').replaceAll(homedir(), '<home>'),
    runProcess: async (command, args, opts) => {
      if (sourceChanged()) fail('input_drift');
      return (options.runProcess ?? runP06Process)(command, args, opts);
    } });
  const manual: P05StepRecord = { index: sequence.steps.length, stepId: 'p06-manual-gate', label: 'Owner confirmation', status: 'not_run',
    notRunReason: null, endKind: 'not_started', exitCode: null, signal: null, timedOut: false, durationMs: null, stoppedVerified: null,
    argv: [], cwd: '<repo>', evidencePath: 'manual-gate.json', logPath: null, fromVerifiedEvidence: false };
  const cleanup = { processesGone: sequence.stopConfirmed, resourcesRemoved: false };
  try {
    if (cleanup.processesGone && readFileSync(join(resources, '.owner'), 'utf8') === ownership && !lstatSync(resources).isSymbolicLink()) {
      rmSync(resources, { recursive: true }); cleanup.resourcesRemoved = !existsSync(resources);
    }
  } catch { /* Retain unknown resources and publish a failure, never erase their ownership record. */ }
  const scenarios: P06ScenarioRecord[] = [];
  let invalidEvidence = false;
  for (const scenarioId of P06_REQUIRED_EVIDENCE_SCENARIOS) {
    const path = join(source, `${scenarioId}-a1/result.json`);
    if (!existsSync(path)) { scenarios.push(notRunP06Scenario(identity, scenarioId, 'scene_not_exported')); continue; }
    try {
      const record: P06ScenarioRecord = json(path);
      if (record.scenarioId !== scenarioId || !verifyP06Scenario(source, record, identity).ok) fail('scenario_verification_failed');
      scenarios.push(record);
    } catch { invalidEvidence = true; scenarios.push(notRunP06Scenario(identity, scenarioId, 'scene_export_invalid')); }
  }
  const drift = sourceChanged(), expired = Date.now() - started > overallTimeoutMs;
  const failed = sequence.exitCode !== 0 || !cleanup.processesGone || !cleanup.resourcesRemoved || drift || expired || invalidEvidence;
  const products = existsSync(join(source, 'products/feature.json')) ? [{ path: 'products/feature.json' }] : [];
  const gates = gateContents.map(g => {
    mkdirSync(join(source, 'gates'), { recursive: true });
    const path = `gates/${g.execution}.json`;
    writeFileSync(join(source, path), safeP06Json(g.value), { flag: 'wx', mode: 0o600 });
    return { execution: g.execution, path };
  });
  mkdirSync(join(source, 'entry'));
  writeFileSync(join(source, 'entry/steps.json'), safeP06Json({ schemaVersion: 1, ...identity,
    steps: sequence.steps.map(s => ({ id: s.stepId, argv: s.argv.map(p => p === process.execPath ? 'node' : p), status: s.status, exitCode: s.exitCode,
      timedOut: s.timedOut, stoppedVerified: s.stoppedVerified, durationMs: s.durationMs })), cleanup, sourceDrift: drift,
    elapsedMs: Date.now() - started, overallTimeoutMs, selectedFiles: selection.files }, [root, resources, process.execPath, homedir()]), { flag: 'wx', mode: 0o600 });
  const { writeP06AcceptanceReport } = await loadP06ReportTools();
  const published = writeP06AcceptanceReport({ reportRoot: join(reportRoot, 'reports'), sourceDirectory: source,
    input: { identity, toolchain: { node: config.toolchain.node, npm: config.toolchain.npm, platform: process.platform }, scenarios, products, gates,
      entry: { path: 'entry/steps.json' },
      checks: checklist.items.map(item => ({ checkId: item.id, executionMode: item.execution === 'offline' ? 'fake' : item.execution,
        status: item.group === 'deferred' ? 'not_run' : item.execution === 'offline' ? failed ? 'fail' : 'pass' : 'pass',
        ...(item.execution === 'offline' && failed ? { reason: drift ? 'source_drift' : expired ? 'overall_timeout' : 'entry_step_or_cleanup_failed' } : {}) })),
      knownGaps: ['verify_not_run_by_phase_entry; invoke separately with explicit authorization', 'live and owner evidence require independent run-bound captures',
        'trusted project mode is not an OS sandbox', ...(options.fullRegression ? [] : ['full_history_not_run'])] } });
  const manualCheck = published.report?.checks.find(check => check.execution === 'manual');
  const finalManual = { ...manual, status: manualCheck?.status ?? 'not_run' as const };
  writeFileSync(join(workDir, 'manual-gate.json'), safeP06Json(finalManual), { flag: 'wx', mode: 0o600 });
  const result = { identity, workDir, resourceRoot: resources, reportDir: published.directory, report: published.report, steps: [...sequence.steps, finalManual], cleanup,
    exitCode: published.exitCode, phaseAccepted: published.exitCode === 0, reportVerified: published.verification.ok };
  writeFileSync(join(workDir, 'entry-result.json'), safeP06Json({ ...result, report: undefined, resourceRoot: cleanup.resourcesRemoved ? null : resources, workDir: relative(reportRoot, workDir), reportDir: relative(reportRoot, published.directory) }, [root, process.execPath, homedir()]), { flag: 'wx', mode: 0o600 });
  return result;
}
export function resolveP06Args(argv: readonly string[]): Omit<P06AcceptanceOptions, 'repoRoot'> & { help?: boolean } {
  const result: Record<string, unknown> = {}, seen = new Set<string>();
  const fields: Record<string, string> = { '--run-id': 'runId', '--report-dir': 'reportRoot', '--expected-commit': 'expectedCommit',
    '--step-timeout-ms': 'stepTimeoutMs', '--overall-timeout-ms': 'overallTimeoutMs', '--prerequisites': 'prerequisiteFile',
    '--manual-record': 'manualRecord', '--live-authorized': 'liveRecord' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; if (seen.has(flag)) fail('duplicate_argument'); seen.add(flag);
    if (flag === '--help') { result.help = true; continue; }
    if (flag === '--full-regression') { result.fullRegression = true; continue; }
    if (!fields[flag] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_argument');
    const value = argv[++i]; result[fields[flag]] = flag.endsWith('-timeout-ms') ? bounded(Number(value)) : value;
  }
  if (result.runId) runId(String(result.runId));
  return result as ReturnType<typeof resolveP06Args>;
}
export const P06_ACCEPT_USAGE = 'accept:p06 [--run-id <id>] [--report-dir <root>] --prerequisites <owner-baselines.json> [--expected-commit <sha>] [--step-timeout-ms <ms>] [--overall-timeout-ms <ms>] [--full-regression] [--manual-record <capture.json>] [--live-authorized <capture.json>]';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = resolveP06Args(process.argv.slice(2));
    if (options.help) console.log(P06_ACCEPT_USAGE);
    else { const result = await runP06Acceptance({ ...options, repoRoot: fileURLToPath(new URL('../../', import.meta.url)), log: console.log });
      console.log(JSON.stringify({ runId: result.identity.runId, exitCode: result.exitCode, reportVerified: result.reportVerified, report: relative(process.cwd(), result.reportDir) })); process.exitCode = result.exitCode; }
  } catch { console.error('accept:p06: preflight_or_entry_failed; inspect configuration, clean commit, prerequisites and unused report directory'); process.exitCode = 1; }
}
