/** P07 formal offline entry. Writes only its new run and owned temporary resources. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { register } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadP07AcceptanceConfig, loadP07Checklist, loadP07EntryContract, evaluateP07Prerequisites, validateP07Budget,
  type P07PrerequisiteInput } from './p07-config.ts';
import { collectP07TrustedTests, selectP07TestScope } from './p07-test-scope.ts';
import { buildP07ExecutionPlan, P07_SCENE_CHECKS } from './p07-plan.ts';
import { collectP07Scenario, hashP07Bytes, hashP07Input, safeP07Json, notRunP07Scenario,
  type P07EvidenceIdentity, type P07ScenarioRecord, type P07DrillEvidenceLike, type P07OverrideFacts } from './p07-evidence.ts';
import { runP07Process, type P07ProcessRunner } from './p07-process.ts';
import type { P07ReportInput } from './p07-report.ts';
export { buildP07ExecutionPlan } from './p07-plan.ts';

const fail = (code: string): never => { throw new Error(`accept:p07:${code}`); };
const json = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
const save = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, safeP07Json(value), { flag: 'wx', mode: 0o600 }); };
function noLinks(path: string): void {
  const temp = resolve(tmpdir()); let current = resolve(path);
  if (current.startsWith(temp + sep)) current = realpathSync(temp) + current.slice(temp.length);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('symlink');
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
function repoFile(root: string, file: string): string {
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split('/').some(p => p === '.' || p === '..')) fail('unsafe_input_path');
  const path = join(root, file); noLinks(path);
  if (!lstatSync(path).isFile()) fail('input_not_file');
  return path;
}
function sourceFiles(root: string, directory: string): string[] {
  noLinks(join(root, directory));
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) fail('input_symlink');
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(root, file) : entry.isFile() ? [file] : fail('invalid_source');
  }).sort();
}
function inputs(root: string): string[] {
  return [...new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.ts',
    ...['core', 'host', 'cli'].flatMap(pkg => [`packages/${pkg}/package.json`, `packages/${pkg}/tsconfig.json`, ...sourceFiles(root, `packages/${pkg}/src`)]),
    ...['scripts', 'test', 'acceptance'].flatMap(dir => sourceFiles(root, dir))])].sort();
}
function runId(id: string): string { if (!/^[\w][\w-]{0,79}$/.test(id)) fail('invalid_run_id'); return id; }
function outputRoot(root: string, requested: string): string {
  let path = resolve(root, requested); noLinks(path);
  const temp = realpathSync(tmpdir()), lexicalTemp = resolve(tmpdir());
  if (path.startsWith(lexicalTemp + sep)) path = temp + path.slice(lexicalTemp.length);
  const tempRoots = [temp, realpathSync('/tmp')];
  if (path !== join(root, 'artifacts/acceptance/p07') && !tempRoots.some(base => path.startsWith(base + sep))) fail('unsafe_report_root');
  if (path === root || root.startsWith(path + sep) || tempRoots.includes(path)) fail('unsafe_report_root');
  if (existsSync(path) && !lstatSync(path).isDirectory()) fail('unsafe_report_root');
  return path;
}

export function validateP07TestReceipt(receipt: any, selected: readonly string[], root: string): void {
  if (!Number.isSafeInteger(receipt?.numTotalTests) || receipt.numTotalTests < 1 || receipt.numPassedTests < 1) fail('zero_tests');
  if (receipt.success !== true || !Array.isArray(receipt.testResults)) fail('test_receipt_failed');
  const seen = new Set<string>();
  for (const file of receipt.testResults) {
    const path = relative(root, resolve(root, file.name));
    if (seen.has(path)) fail('duplicate_test_receipt'); seen.add(path);
    if (file.status !== 'passed' || !Array.isArray(file.assertionResults)
      || !file.assertionResults.some((test: any) => test.status === 'passed')
      || file.assertionResults.some((test: any) => test.status === 'failed')) fail('file_zero_or_failed_tests');
  }
  if (selected.some(file => !seen.has(file))) fail('missing_test_receipt');
}
export type P07Prerequisites = { approvedBy: string; features: readonly Omit<P07PrerequisiteInput, 'ancestorOfHead'>[] };
export type P07EntryStep = { id: string; argv: string[]; status: 'pass' | 'fail' | 'not_run'; exitCode: number | null;
  timedOut: boolean; stoppedVerified: boolean | null; durationMs: number | null; reason: string | null; tests: string[] };
export type P07AcceptanceOptions = {
  repoRoot: string; runId?: string; reportRoot?: string; expectedCommit?: string; prerequisiteFile?: string; manualRecord?: string;
  stepTimeoutMs?: number; overallTimeoutMs?: number; fullRegression?: boolean; signal?: AbortSignal; log?: (text: string) => void;
  /** In-process controller tests only; these cannot be supplied by the public argument parser. */
  testing?: { probe?: (command: string, args: readonly string[]) => string; platform?: string;
    prerequisites?: P07Prerequisites; runProcess?: P07ProcessRunner; publish?: (options: { reportRoot: string; sourceDirectory: string; input: P07ReportInput; checklist?: import('./p07-config.ts').P07Checklist }) => never };
};
let reportTools: Promise<typeof import('./p07-report.ts')> | undefined;
async function loadReport() {
  if (!reportTools) {
    if (!process.env.VITEST) register(new URL('../../test/helpers/node-ts-loader/hooks.mjs', import.meta.url), import.meta.url);
    reportTools = import('./p07-report.ts');
  }
  return reportTools;
}

export async function runP07Acceptance(options: P07AcceptanceOptions) {
  if (options.testing && !process.env.VITEST) fail('test_injection_forbidden');
  const started = Date.now(), root = realpathSync(options.repoRoot);
  const config = loadP07AcceptanceConfig(repoFile(root, 'acceptance/p07.config.json'));
  const checklist = loadP07Checklist(repoFile(root, config.checklist));
  loadP07EntryContract(repoFile(root, 'acceptance/p07.entry.json'));
  const budget = validateP07Budget({ stepMs: options.stepTimeoutMs ?? config.timeouts.stepMs, overallMs: options.overallTimeoutMs ?? config.timeouts.overallMs });
  const id = runId(options.runId ?? `p07-${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`);
  const reports = outputRoot(root, options.reportRoot ?? config.reportRoot);
  const workDir = join(reports, 'runs', id), reportDir = join(reports, 'reports', id);
  noLinks(workDir); noLinks(reportDir);
  if (existsSync(workDir) || existsSync(reportDir)) fail('run_exists');
  mkdirSync(dirname(workDir), { recursive: true, mode: 0o700 }); mkdirSync(workDir, { mode: 0o700 });
  let resources: string | undefined, ownership: string | undefined;
  let stopConfirmed = true;
  const cleanup = { processesGone: true, resourcesRemoved: true };
  const steps: P07EntryStep[] = [];
  try {
    const probe = options.testing?.probe ?? ((command, args) => execFileSync(command === 'node' ? process.execPath : command, [...args], {
      cwd: root, env: { PATH: process.env.PATH, HOME: homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', timeout: Math.min(10_000, budget.overallMs), maxBuffer: 4 * 1024 * 1024 }).trim());
    const commit = probe('git', ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(commit) || (options.expectedCommit !== undefined && options.expectedCommit !== commit)) fail('commit_mismatch');
    // The reserved directory is empty at this point and cannot mask dirty source.
    if (probe('git', ['status', '--porcelain', '--untracked-files=all'])) fail('dirty_source');
    if (probe('node', ['--version']).replace(/^v/, '') !== config.toolchain.node || probe('npm', ['--version']) !== config.toolchain.npm
      || (options.testing?.platform ?? process.platform) !== config.toolchain.platform) fail('toolchain_or_platform_mismatch');
    const pkg = json(repoFile(root, 'package.json'));
    if (pkg.scripts?.['accept:p07'] !== 'node scripts/acceptance/p07-accept.ts' || pkg.scripts.verify !== 'node scripts/verify.ts' || pkg.scripts.test !== 'node scripts/run-tests.ts') fail('entry_interface');
    const supplied: P07Prerequisites | undefined = options.testing?.prerequisites ?? (options.prerequisiteFile ? json(options.prerequisiteFile) : undefined);
    if (!supplied || typeof supplied.approvedBy !== 'string' || !supplied.approvedBy || !Array.isArray(supplied.features)) fail('prerequisites_required');
    const prerequisites = supplied!.features.map(feature => {
      let ancestorOfHead = false;
      if (/^[a-f0-9]{40}$/.test(feature.commit)) {
        try { probe('git', ['merge-base', '--is-ancestor', feature.commit, commit]); ancestorOfHead = true; } catch { /* Actual ancestry failure blocks. */ }
      }
      return { ...feature, ancestorOfHead };
    });
    const prerequisiteResult = evaluateP07Prerequisites(prerequisites);
    save(join(workDir, 'prerequisites.json'), prerequisiteResult);
    if (prerequisiteResult.status !== 'satisfied') fail('prerequisite_not_delivered_or_ancestor');
    const trusted = collectP07TrustedTests(root), scope = selectP07TestScope(trusted.files, options.fullRegression === true);
    for (const file of Object.keys(P07_SCENE_CHECKS)) if (!scope.selected.includes(file)) fail('required_scene_missing');
    const files = inputs(root);
    const executed = options.fullRegression ? files.filter(file => /^test\/modules\/.*\.test\.(ts|js)$/.test(file)) : [...scope.selected];
    const plan = buildP07ExecutionPlan(executed, options.fullRegression === true);
    const material = { config, prerequisites, budget, fullRegression: options.fullRegression === true, scope, executed,
      files: files.map(file => ({ file, sha256: hashP07Bytes(readFileSync(repoFile(root, file))) })) };
    const identity: P07EvidenceIdentity = { runId: id, testedCommit: commit, inputDigest: hashP07Input(material) };
    save(join(workDir, 'inputs.json'), { identity, material });
    save(join(workDir, 'test-scope.json'), { identity, scope, executed, steps: plan.map(step => ({ id: step.id, tests: step.tests })) });
    const source = join(workDir, 'source'); mkdirSync(source, { mode: 0o700 });
    resources = realpathSync(mkdtempSync(join(tmpdir(), `shiploop-p07-${id}-`))); ownership = randomUUID();
    writeFileSync(join(resources, '.owner'), ownership, { flag: 'wx', mode: 0o600 });
    const home = join(resources, 'home'), temporary = join(resources, 'tmp'); mkdirSync(home); mkdirSync(temporary);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      LANG: 'C.UTF-8', TZ: 'UTC', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      SHIPLOOP_P07_OFFLINE: '1', SHIPLOOP_P07_ENTRY_SOURCE: source, SHIPLOOP_P07_ENTRY_IDENTITY: JSON.stringify(identity),
      SHIPLOOP_TEST_RUN_TIMEOUT_MS: String(budget.stepMs) };
    const redact = (text: string) => text.replaceAll(root, '<repo>').replaceAll(resources!, '<owned-temp>').replaceAll(process.execPath, '<node>').replaceAll(homedir(), '<home>');
    const drift = () => probe('git', ['rev-parse', 'HEAD']) !== commit || probe('git', ['status', '--porcelain', '--untracked-files=all']).split('\n').some(line => {
      if (!line) return false; if (!line.startsWith('?? ')) return true;
      const path = resolve(root, line.slice(3)); return ![workDir, reportDir].some(owned => path === owned || path.startsWith(owned + sep));
    }) || hashP07Input(files.map(file => ({ file, sha256: hashP07Bytes(readFileSync(repoFile(root, file))) }))) !== hashP07Input(material.files)
      || hashP07Input(inputs(root)) !== hashP07Input(files);
    let halted = false;
    for (const step of plan) {
      const receipt = join(workDir, `${step.id}-tests.json`);
      const args = [...step.args, ...(step.tests.length ? ['--config', 'scripts/acceptance/p07-vitest.config.ts', '--reporter=default', '--reporter=json', `--outputFile.json=${receipt}`] : [])];
      const record: P07EntryStep = { id: step.id, argv: [step.command, ...args], status: 'not_run', exitCode: null,
        timedOut: false, stoppedVerified: null, durationMs: null, reason: halted ? 'halted_by_prior_failure' : null, tests: step.tests };
      steps.push(record);
      const remaining = budget.overallMs - (Date.now() - started);
      if (!halted && (options.signal?.aborted || remaining <= 0 || drift())) {
        halted = true; record.reason = options.signal?.aborted ? 'cancelled' : remaining <= 0 ? 'overall_timeout' : 'input_drift';
      }
      if (!halted) {
        options.log?.(`accept:p07:${id}:${step.id}`);
        save(join(workDir, `${step.id}-running.json`), { identity, argv: record.argv.map(redact), timeoutMs: Math.min(remaining, budget.stepMs) });
        stopConfirmed = false;
        const outcome = await (options.testing?.runProcess ?? runP07Process)(step.command, args, {
          cwd: root, env, timeoutMs: Math.max(1, Math.min(remaining, budget.stepMs)), maxOutputBytes: config.maxCommandOutputBytes, signal: options.signal,
        });
        stopConfirmed = outcome.stoppedVerified;
        save(join(workDir, `${step.id}-outcome.json`), { ...outcome, stdout: redact(outcome.stdout), stderr: redact(outcome.stderr) });
        Object.assign(record, { exitCode: outcome.exitCode, timedOut: outcome.timedOut, stoppedVerified: outcome.stoppedVerified, durationMs: outcome.durationMs,
          status: outcome.kind === 'exit' && outcome.exitCode === 0 && !outcome.timedOut && outcome.stoppedVerified ? 'pass' : 'fail' });
        if (record.status === 'pass' && step.tests.length) {
          try { validateP07TestReceipt(json(receipt), step.tests, root); }
          catch { record.status = 'fail'; record.reason = 'zero_missing_or_failed_test_receipt'; }
        }
        if (options.signal?.aborted) { record.status = 'fail'; record.reason = 'cancelled'; }
        halted = record.status !== 'pass';
      }
      save(join(workDir, `${step.id}.json`), { identity, ...record, argv: record.argv.map(redact) });
    }
    cleanup.processesGone = stopConfirmed;
    cleanup.resourcesRemoved = false;
    if (stopConfirmed && readFileSync(join(resources, '.owner'), 'utf8') === ownership) {
      noLinks(resources); rmSync(resources, { recursive: true }); cleanup.resourcesRemoved = !existsSync(resources);
    }
    const sourceDrift = drift();
    const scenes = await collectEntryScenarios(root, source, identity, steps, executed);
    const gates: { path: string; execution: 'manual' }[] = [];
    if (options.manualRecord) {
      save(join(source, 'gates/manual.json'), json(options.manualRecord)); gates.push({ path: 'gates/manual.json', execution: 'manual' });
    }
    const capturedSteps = steps.map(({ reason: _reason, tests: _tests, ...step }) => ({ ...step, argv: step.argv.map(redact) }));
    save(join(source, 'entry/run.json'), { schemaVersion: 2, ...identity, steps: capturedSteps, cleanup, sourceDrift,
      elapsedMs: Date.now() - started, overallTimeoutMs: budget.overallMs, selectedFiles: executed,
      bindings: steps.map(step => ({ id: step.id, tests: step.tests })), scope,
      fullHistory: { status: options.fullRegression ? steps.find(step => step.id === 'p07-trusted-scope')!.status : 'not_run', stepId: options.fullRegression ? 'p07-trusted-scope' : null } });
    const tools = await loadReport();
    const published = (options.testing?.publish ?? tools.writeP07AcceptanceReport)({ reportRoot: join(reports, 'reports'), sourceDirectory: source, checklist,
      input: { identity, toolchain: { node: config.toolchain.node, npm: config.toolchain.npm, platform: config.toolchain.platform }, prerequisites,
        checks: checklist.items.map(item => ({ checkId: item.id, executionMode: item.execution === 'offline' ? 'fake' : item.execution === 'manual' ? 'manual' : 'postponed',
          status: item.execution === 'offline' ? 'pass' : 'not_run', reason: item.execution === 'manual' ? 'owner_pending' : null })),
        scenarios: scenes, products: existsSync(join(source, 'products/feature.json')) ? [{ path: 'products/feature.json' }] : [],
        gates, entry: { path: 'entry/run.json' }, knownGaps: ['trusted_project_mode_is_not_an_OS_sandbox', 'no_arg_verify_not_run',
          ...(options.fullRegression ? ['full_history_included_in_single_test_step'] : ['full_history_not_run'])] } });
    const lateInputDrift = drift();
    const expired = Date.now() - started > budget.overallMs;
    const exitCode = published.exitCode === 0 && !expired && !lateInputDrift ? 0 : 1;
    const result = { identity, workDir, reportDir: published.directory, report: published.report, reportVerified: published.verification.ok,
      steps, cleanup, lateInputDrift, overallBudgetExpired: expired, resourceRoot: cleanup.resourcesRemoved ? null : resources, exitCode, phaseAccepted: false as const };
    save(join(workDir, 'entry-result.json'), { ...result, report: undefined, steps: steps.map(step => ({ ...step, argv: step.argv.map(redact) })),
      workDir: relative(reports, workDir), reportDir: relative(reports, published.directory), resourceRoot: result.resourceRoot ? '<retained-owned-temp>' : null });
    return result;
  } catch (error) {
    cleanup.processesGone = stopConfirmed;
    if (resources && existsSync(resources)) {
      cleanup.resourcesRemoved = false;
      if (stopConfirmed && readFileSync(join(resources, '.owner'), 'utf8') === ownership) {
        noLinks(resources); rmSync(resources, { recursive: true }); cleanup.resourcesRemoved = !existsSync(resources);
      }
    }
    const code = error instanceof Error && /^accept:p07:[\w_-]+$/.test(error.message) ? error.message : 'accept:p07:preflight_or_publication_failed';
    save(join(workDir, 'diagnostic.json'), { code, steps: steps.map(step => ({ ...step, argv: step.argv.map(arg => arg.replaceAll(root, '<repo>').replaceAll(process.execPath, '<node>').replaceAll(homedir(), '<home>')) })), cleanup, phaseAccepted: false, retainedResources: cleanup.resourcesRemoved ? null : '<owned-temp>' });
    throw new Error(code);
  }
}

type Capture = { identity: P07EvidenceIdentity; file: string; title: string; checkId: string; passed: boolean; assertions: number;
  observations: { facts: P07OverrideFacts; drill?: P07DrillEvidenceLike; removed: boolean }[]; products: any[] };
async function collectEntryScenarios(root: string, source: string, identity: P07EvidenceIdentity, steps: readonly P07EntryStep[], executed: readonly string[]) {
  const scenes: P07ScenarioRecord[] = [], attempts = new Map<string, number>();
  const expected = new Map<string, string>();
  for (const step of steps.filter(step => step.status === 'pass' && step.tests.length)) {
    const receipt = json(join(source, '..', `${step.id}-tests.json`));
    for (const result of receipt.testResults) {
      const file = relative(root, result.name);
      if (!P07_SCENE_CHECKS[file]) continue;
      for (const assertion of result.assertionResults.filter((value: { status: string }) => value.status === 'passed')) {
        if (file.endsWith('p07-5-f010-report.test.ts') && !assertion.title.includes('[case:p07-f010-real-drill-report]')) continue;
        expected.set(`${file}/${assertion.title}`, P07_SCENE_CHECKS[file]);
      }
    }
  }
  const seen = new Set<string>();
  const directory = join(source, 'captures');
  if (existsSync(directory)) for (const file of readdirSync(directory).sort()) {
    const path = join(directory, file); noLinks(path);
    if (!lstatSync(path).isFile() || lstatSync(path).size > 16 * 1024 * 1024) fail('invalid_capture');
    const capture: Capture = json(path);
    const key = `${capture.file}/${capture.title}`;
    if (seen.has(key)) fail('duplicate_capture'); seen.add(key);
    if (hashP07Input(capture.identity) !== hashP07Input(identity) || !executed.includes(capture.file) || P07_SCENE_CHECKS[capture.file] !== capture.checkId) fail('capture_identity_mismatch');
    const step = steps.find(candidate => candidate.tests.includes(capture.file));
    if (!step) fail('capture_step_missing');
    if (step!.status === 'pass' && !expected.has(key)) fail('unexpected_capture');
    for (const product of capture.products) {
      const target = join(source, 'products/feature.json');
      if (existsSync(target)) fail('duplicate_product');
      save(target, { ...product, identity: { runId: identity.runId, commit: identity.testedCommit, inputsDigest: identity.inputDigest } });
    }
    for (const observation of capture.observations.length ? capture.observations : [{ facts: {}, removed: false }]) {
      const attempt = (attempts.get(capture.checkId) ?? 0) + 1; attempts.set(capture.checkId, attempt);
      const passed = capture.passed && capture.assertions > 0;
      if (!passed) { scenes.push({ ...notRunP07Scenario(identity, capture.checkId, 'scene_assertions_failed_or_not_completed'), attempt }); continue; }
      const command = { label: step!.id, argv: step!.argv.map(arg => arg === process.execPath ? 'node' : arg.startsWith('--outputFile.json=') ? '--outputFile.json=<owned-test-receipt>' : arg),
        exitCode: step!.exitCode, signal: null, durationMs: Math.round(step!.durationMs ?? 0), timedOut: step!.timedOut, cancelled: step!.reason === 'cancelled', escalated: [], stopConfirmed: step!.stoppedVerified === true };
      const record = await collectP07Scenario({ directory: source, identity, checkId: capture.checkId, attempt, expectation: 'success', command,
        positiveAssertions: passed ? [capture.title] : [],
        drill: observation.drill, facts: observation.facts,
        usage: { source: 'command-output', tools: { node: process.versions.node } },
        cleanup: { status: observation.removed && step!.stoppedVerified ? 'passed' : 'failed', processStopped: step!.stoppedVerified === true,
          factsExported: true, sqliteClosed: observation.removed, resourcesRemoved: observation.removed, retainedRoot: observation.removed ? null : '<scene-resources-unconfirmed>' },
        sensitiveValues: [root, process.execPath, homedir()],
      });
      scenes.push(record);
    }
  }
  for (const [key, checkId] of expected) if (!seen.has(key)) {
    const attempt = (attempts.get(checkId) ?? 0) + 1; attempts.set(checkId, attempt);
    scenes.push({ ...notRunP07Scenario(identity, checkId, 'required_test_capture_missing'), attempt });
  }
  for (const checkId of new Set(Object.values(P07_SCENE_CHECKS))) if (!attempts.has(checkId)) scenes.push(notRunP07Scenario(identity, checkId, 'scene_not_exported'));
  return scenes;
}

export function resolveP07Args(argv: readonly string[]): Omit<P07AcceptanceOptions, 'repoRoot' | 'testing' | 'signal' | 'log'> & { help?: boolean } {
  const result: Record<string, unknown> = {}, seen = new Set<string>();
  const fields: Record<string, string> = { '--run-id': 'runId', '--report-dir': 'reportRoot', '--expected-commit': 'expectedCommit', '--prerequisites': 'prerequisiteFile',
    '--manual-record': 'manualRecord', '--step-timeout-ms': 'stepTimeoutMs', '--overall-timeout-ms': 'overallTimeoutMs' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; if (seen.has(flag)) fail('duplicate_argument'); seen.add(flag);
    if (flag === '--help') { result.help = true; continue; }
    if (flag === '--full-regression') { result.fullRegression = true; continue; }
    if (!fields[flag] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_argument');
    const value = argv[++i]; result[fields[flag]] = flag.endsWith('-timeout-ms') ? Number(value) : value;
  }
  if (result.runId) runId(String(result.runId));
  validateP07Budget({ stepMs: result.stepTimeoutMs ?? 900_000, overallMs: result.overallTimeoutMs ?? 2_700_000 });
  return result as ReturnType<typeof resolveP07Args>;
}
export const P07_ACCEPT_USAGE = 'accept:p07 --prerequisites <owner-baselines.json> [--run-id <id>] [--report-dir <owned-root>] [--expected-commit <sha>] [--step-timeout-ms <ms>] [--overall-timeout-ms <ms>] [--full-regression] [--manual-record <capture.json>]';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController(); const cancel = () => abort.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const options = resolveP07Args(process.argv.slice(2));
    if (options.help) console.log(P07_ACCEPT_USAGE);
    else {
      const result = await runP07Acceptance({ ...options, repoRoot: fileURLToPath(new URL('../../', import.meta.url)), signal: abort.signal, log: console.log });
      console.log(JSON.stringify({ runId: result.identity.runId, exitCode: result.exitCode, reportVerified: result.reportVerified, phaseAccepted: false, report: relative(process.cwd(), result.reportDir) }));
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error && /^accept:p07:[\w_-]+$/.test(error.message) ? error.message : 'accept:p07:preflight_or_entry_failed'); process.exitCode = 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
