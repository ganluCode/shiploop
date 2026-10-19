import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createTempSandbox } from '../temp-sandbox.ts';

const AUTHORIZED_TARGET_ID = 'p03-task-local';
const AUTHORIZED_REVISION = 'selection-v1';
const REQUIRE_FROM_FIXTURE = createRequire(import.meta.url);
const TSC_BIN = resolve(requireFromFixturePackage('typescript/package.json'), '..', 'bin', 'tsc');
const REQUIRED_MODULES = ['core', 'host'] as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const FULL_GATE_STEPS = ['test', 'typecheck', 'build', 'integration'] as const;
type ModuleName = (typeof REQUIRED_MODULES)[number];
type GateStepName = (typeof FULL_GATE_STEPS)[number];

function requireFromFixturePackage(packagePath: string): string {
  return REQUIRE_FROM_FIXTURE.resolve(packagePath);
}


type SelectionFixtureOptions = {
  readonly modulesToExecute?: readonly ModuleName[];
  readonly omitResultArtifact?: boolean;
  readonly baselineFailure?: boolean;
};

export type SelectionCandidate = {
  readonly targetId: string;
  readonly definitionRevision: string;
  readonly files: readonly string[];
  readonly selectionReason: string;
  readonly sharedConfigDigest?: string;
  readonly fallback?: 'full' | 'none';
  /** 未知字段代表未经授权的命令覆盖尝试，必须被拒绝。 */
  readonly command?: readonly string[];
};

type SelectionResult = {
  readonly status: 'passed' | 'failed' | 'error' | 'inconclusive';
  readonly mode: 'local' | 'full' | 'none';
  readonly reason?: string;
  readonly fallbackReason?: string;
  readonly selectionReason: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly exitCode: number | null;
  readonly resultArtifact: string | null;
  readonly executedModules: readonly string[];
  readonly shell: false;
};

export type FinalGateStep = {
  readonly name: GateStepName;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly exitCode: number | null;
};

export type FinalGateResult = {
  readonly status: 'passed' | 'failed' | 'error';
  readonly reason?: string;
  readonly passed: boolean;
  readonly steps: readonly FinalGateStep[];
  readonly resultArtifact: string | null;
};

export type NonNodeContractResult = {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly language: 'python';
  readonly exitCode: number | null;
  readonly protocol: {
    readonly targetId: string;
    readonly argvIsArray: boolean;
    readonly cwdIsAbsolute: boolean;
    readonly timeoutIsFinite: boolean;
    readonly evidenceRequired: boolean;
  };
  readonly profileCount: 1;
};

export type SelectionFixture = {
  readonly root: string;
  readonly cleanup: () => void;
  readonly sharedConfigDigest: string;
  readonly runner: string;
  readonly gateScript: string;
  readonly pythonScript: string;
  readonly options: SelectionFixtureOptions;
};

function write(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function moduleName(file: string): ModuleName | null {
  if (file === 'modules/core.test.mjs') return 'core';
  if (file === 'modules/host.test.mjs') return 'host';
  return null;
}

const MODULE_SOURCE = (name: ModuleName): string => `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function run(root) {
  const config = JSON.parse(readFileSync(join(root, 'shared-config.json'), 'utf8'));
  assert.equal(config.schemaVersion, 1);
  return '${name}';
}
`;

const SELECTION_RUNNER = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const args = process.argv.slice(2);
const artifactIndex = args.indexOf('--artifact');
const targetIndex = args.indexOf('--target-id');
const revisionIndex = args.indexOf('--definition-revision');
const artifact = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
const targetId = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const definitionRevision = revisionIndex >= 0 ? args[revisionIndex + 1] : undefined;
const files = args.filter((arg, index) => !['--artifact', '--target-id', '--definition-revision'].includes(arg)
  && index !== artifactIndex + 1 && index !== targetIndex + 1 && index !== revisionIndex + 1);
const plan = JSON.parse(readFileSync(join(root, 'fixture-runner-plan.json'), 'utf8'));
const executedModules = [];
for (const file of files) {
  const module = file.includes('/core.') ? 'core' : file.includes('/host.') ? 'host' : null;
  if (!module || !plan.modulesToExecute.includes(module)) continue;
  const loaded = await import(pathToFileURL(join(root, file)).href);
  loaded.run(root);
  executedModules.push(module);
}
if (artifact && plan.omitResultArtifact !== true) {
  writeFileSync(artifact, JSON.stringify({ targetId, definitionRevision, executedModules, exitCode: 0 }) + '\\n');
}
if (!existsSync(join(root, 'shared-config.json'))) process.exit(9);
`;

const GATE_SCRIPT = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const step = process.argv[2];
if (existsSync(join(root, 'baseline-fail.marker')) && step === 'test') {
  console.error('fixture baseline failure');
  process.exit(16);
}
if (existsSync(join(root, 'fail-' + step + '.marker'))) {
  console.error('fixture gate failure: ' + step);
  process.exit(17);
}
if (step === 'test') {
  const result = spawnSync(process.execPath, [join(root, 'selection-runner.mjs'), '--artifact', join(root, 'gate-test-selection.json'), '--target-id', 'p03-feature-full', '--definition-revision', 'full-gate-v1', 'modules/core.test.mjs', 'modules/host.test.mjs'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (step === 'typecheck') {
  const result = spawnSync(process.execPath, [${JSON.stringify(TSC_BIN)}, '-p', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!readFileSync(join(root, 'typed-source.ts'), 'utf8').includes('typecheck-ok')) process.exit(18);
}
if (step === 'build') {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'feature-build.txt'), 'feature-build-ok\\n');
}
if (step === 'integration' && !existsSync(join(root, 'dist', 'feature-build.txt'))) process.exit(19);
writeFileSync(join(root, 'gate-events.ndjson'), (readFileSync(join(root, 'gate-events.ndjson'), 'utf8') || '') + step + '\\n');
`;

const PYTHON_CONTRACT = `
import json, os, sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
result = {
  'targetId': payload['targetId'],
  'argvIsArray': isinstance(payload['argv'], list),
  'cwdIsAbsolute': os.path.isabs(payload['cwd']),
  'timeoutIsFinite': isinstance(payload['timeoutMs'], int) and payload['timeoutMs'] > 0,
  'evidenceRequired': payload['evidenceRequired'],
}
json.dump(result, open(sys.argv[2], 'w', encoding='utf-8'))
`;

export function createSelectionFixture(prefix: string, options: SelectionFixtureOptions = {}): SelectionFixture {
  const sandbox = createTempSandbox(prefix);
  const root = sandbox.path;
  write(join(root, 'shared-config.json'), JSON.stringify({ schemaVersion: 1, module: 'core' }) + '\n');
  const sharedConfigDigest = digest(join(root, 'shared-config.json'));
  // Each module validates the shared schema and its own identity through the runner plan.
  write(join(root, 'modules', 'core.test.mjs'), MODULE_SOURCE('core'));
  write(join(root, 'modules', 'host.test.mjs'), MODULE_SOURCE('host'));
  write(join(root, 'selection-runner.mjs'), SELECTION_RUNNER);
  write(join(root, 'gate-step.mjs'), GATE_SCRIPT);
  write(join(root, 'typed-source.ts'), 'export const marker: string = \'typecheck-ok\';\n');
  write(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', types: [], skipLibCheck: true },
    include: ['typed-source.ts'],
  }) + '\n');
  write(join(root, 'gate-events.ndjson'), '');
  write(join(root, 'fixture-runner-plan.json'), JSON.stringify({
    modulesToExecute: options.modulesToExecute ?? [...REQUIRED_MODULES],
    omitResultArtifact: options.omitResultArtifact ?? false,
  }) + '\n');
  symlinkSync(join(root, 'modules', 'core.test.mjs'), join(root, 'modules', 'linked.test.mjs'));
  if (options.baselineFailure === true) write(join(root, 'baseline-fail.marker'), 'baseline failure\n');
  write(join(root, 'non-node-contract.py'), PYTHON_CONTRACT);
  return {
    root,
    cleanup: sandbox.cleanup,
    sharedConfigDigest,
    runner: join(root, 'selection-runner.mjs'),
    gateScript: join(root, 'gate-step.mjs'),
    pythonScript: join(root, 'non-node-contract.py'),
    options,
  };
}

function emptyResult(fixture: SelectionFixture, reason: string): SelectionResult {
  return {
    status: 'inconclusive', mode: 'none', reason, selectionReason: '', argv: [], cwd: fixture.root,
    timeoutMs: DEFAULT_TIMEOUT_MS, exitCode: null, resultArtifact: null, executedModules: [], shell: false,
  };
}

function validateCandidate(fixture: SelectionFixture, candidate: SelectionCandidate): string | null {
  if (candidate.targetId !== AUTHORIZED_TARGET_ID) return 'unknown_target';
  if (candidate.definitionRevision !== AUTHORIZED_REVISION) return 'stale_definition';
  if (candidate.command !== undefined) return 'unauthorized_command';
  if (typeof candidate.selectionReason !== 'string' || candidate.selectionReason.trim() === '') return 'missing_selection_reason';
  if (candidate.sharedConfigDigest !== undefined && candidate.sharedConfigDigest !== fixture.sharedConfigDigest) return 'shared_config_changed';
  if (candidate.files.length === 0) return 'zero_tests';
  const seen = new Set<string>();
  for (const file of candidate.files) {
    if (typeof file !== 'string' || file.length === 0 || file.startsWith('-') || /[\u0000;$`()]/.test(file)) return 'argument_injection';
    const absolute = resolve(fixture.root, file);
    const moduleRoot = resolve(fixture.root, 'modules');
    if (relative(moduleRoot, absolute).startsWith('..') || absolute === moduleRoot) return 'path_out_of_bounds';
    if (!existsSync(absolute)) return 'file_missing';
    let stat;
    try { stat = lstatSync(absolute); } catch { return 'file_missing'; }
    if (stat.isSymbolicLink()) return 'symlink';
    if (!stat.isFile()) return 'file_not_regular';
    if (seen.has(file)) return 'duplicate_file';
    seen.add(file);
    if (moduleName(file) === null) return 'unauthorized_file';
  }
  const selected = new Set(candidate.files.map(moduleName));
  for (const required of REQUIRED_MODULES) if (!selected.has(required)) return 'required_module_missing';
  return null;
}

function executeSelection(fixture: SelectionFixture, files: readonly string[], mode: 'local' | 'full', reason: string): SelectionResult {
  const artifact = join(fixture.root, 'selection-result.json');
  const argv = [process.execPath, fixture.runner, '--artifact', artifact, '--target-id', AUTHORIZED_TARGET_ID, '--definition-revision', AUTHORIZED_REVISION, ...files];
  const child = spawnSync(process.execPath, argv.slice(1), {
    cwd: fixture.root, encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, shell: false,
  });
  const exitCode = child.status ?? null;
  if (exitCode !== 0) {
    return { status: 'failed', mode, reason: 'command_failed', fallbackReason: reason, selectionReason: reason,
      argv, cwd: fixture.root, timeoutMs: DEFAULT_TIMEOUT_MS, exitCode, resultArtifact: existsSync(artifact) ? artifact : null,
      executedModules: [], shell: false };
  }
  if (!existsSync(artifact)) {
    return { status: 'inconclusive', mode, reason: 'missing_execution_evidence', fallbackReason: reason,
      selectionReason: reason, argv, cwd: fixture.root, timeoutMs: DEFAULT_TIMEOUT_MS, exitCode, resultArtifact: null,
      executedModules: [], shell: false };
  }
  const evidence = JSON.parse(readFileSync(artifact, 'utf8')) as { executedModules?: unknown; exitCode?: unknown };
  const executedModules = Array.isArray(evidence.executedModules) ? evidence.executedModules.filter((value): value is string => typeof value === 'string') : [];
  const expected = files.map(moduleName).filter((value): value is ModuleName => value !== null);
  if (evidence.exitCode !== 0 || expected.some((value) => !executedModules.includes(value))) {
    return { status: 'inconclusive', mode, reason: 'required_module_missing', fallbackReason: reason,
      selectionReason: reason, argv, cwd: fixture.root, timeoutMs: DEFAULT_TIMEOUT_MS, exitCode, resultArtifact: artifact,
      executedModules, shell: false };
  }
  return { status: 'passed', mode, fallbackReason: mode === 'full' ? reason : undefined,
    selectionReason: reason, argv, cwd: fixture.root, timeoutMs: DEFAULT_TIMEOUT_MS, exitCode, resultArtifact: artifact,
    executedModules, shell: false };
}

export function runAuthorizedSelection(fixture: SelectionFixture, candidate: SelectionCandidate): SelectionResult {
  const validationError = validateCandidate(fixture, candidate);
  if (validationError === 'zero_tests') return emptyResult(fixture, 'zero_tests');
  if (validationError === null) return executeSelection(fixture, candidate.files, 'local', candidate.selectionReason);
  if (candidate.fallback !== 'none') {
    const reason = `fallback_full:${validationError}`;
    return executeSelection(fixture, ['modules/core.test.mjs', 'modules/host.test.mjs'], 'full', reason);
  }
  return { ...emptyResult(fixture, validationError), selectionReason: candidate.selectionReason };
}

export function runFinalGate(fixture: SelectionFixture, options: {
  readonly definition?: readonly string[];
  readonly failStep?: GateStepName;
} = {}): FinalGateResult {
  if (options.definition !== undefined && JSON.stringify(options.definition) !== JSON.stringify(FULL_GATE_STEPS)) {
    return { status: 'error', reason: 'gate_definition_tampered', passed: false, steps: [], resultArtifact: null };
  }
  if (options.failStep !== undefined) write(join(fixture.root, `fail-${options.failStep}.marker`), 'controlled failure\n');
  const steps: FinalGateStep[] = [];
  for (const name of FULL_GATE_STEPS) {
    const child = spawnSync(process.execPath, [fixture.gateScript, name], {
      cwd: fixture.root, encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, shell: false,
    });
    const exitCode = child.status ?? null;
    if (exitCode !== 0) {
      steps.push({ name, status: 'failed', exitCode });
      for (const remaining of FULL_GATE_STEPS.slice(steps.length)) steps.push({ name: remaining, status: 'not_run', exitCode: null });
      const resultArtifact = join(fixture.root, 'final-gate-result.json');
      writeFileSync(resultArtifact, JSON.stringify({ status: 'failed', passed: false, steps }) + '\n');
      return { status: 'failed', passed: false, steps, resultArtifact };
    }
    steps.push({ name, status: 'passed', exitCode: 0 });
  }
  const resultArtifact = join(fixture.root, 'final-gate-result.json');
  writeFileSync(resultArtifact, JSON.stringify({ status: 'passed', passed: true, steps }) + '\n');
  return { status: 'passed', passed: true, steps, resultArtifact };
}

export function runNonNodeContract(fixture: SelectionFixture): NonNodeContractResult {
  const payload = join(fixture.root, 'non-node-input.json');
  const artifact = join(fixture.root, 'non-node-result.json');
  const argv = ['python3', fixture.pythonScript, payload, artifact];
  writeFileSync(payload, JSON.stringify({
    targetId: 'p03-non-node-contract', argv, cwd: fixture.root, timeoutMs: DEFAULT_TIMEOUT_MS, evidenceRequired: true,
  }) + '\n');
  const child = spawnSync('python3', [fixture.pythonScript, payload, artifact], {
    cwd: fixture.root, encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS, shell: false,
  });
  if (child.status !== 0 || !existsSync(artifact)) {
    return { status: child.status === 0 ? 'inconclusive' : 'failed', language: 'python', exitCode: child.status ?? null,
      protocol: { targetId: 'p03-non-node-contract', argvIsArray: false, cwdIsAbsolute: false, timeoutIsFinite: false, evidenceRequired: false }, profileCount: 1 };
  }
  const result = JSON.parse(readFileSync(artifact, 'utf8')) as NonNodeContractResult['protocol'];
  return { status: 'passed', language: 'python', exitCode: child.status, protocol: result, profileCount: 1 };
}

export { FULL_GATE_STEPS };
