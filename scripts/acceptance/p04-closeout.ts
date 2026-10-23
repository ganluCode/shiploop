/** Supplemental offline handoff. Never signs the frozen Phase checklist or invokes a model. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './p02-accept.ts';
import { evaluateP04TestEvidence, P04_OFFLINE_TEST_BINDINGS } from './p04-test-evidence.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
}
function fileInside(root: string, file: string) {
  if (typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe evidence path');
  const path = join(root, file);
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('Unsafe evidence file');
  return path;
}
export function verifyP04Closeout(root: string, expectedCommit?: string) {
  root = realpathSync(root);
  const index = read(join(root, 'evidence-index.json'));
  if (index.schemaVersion !== 1 || index.kind !== 'p04-offline-closeout' || !/^[a-f0-9]{40}$/.test(index.commit)
      || index.phaseAccepted !== false || !Array.isArray(index.files) || index.files.length === 0
      || (expectedCommit !== undefined && index.commit !== expectedCommit)) throw new Error('Closeout identity mismatch');
  const seen = new Set<string>();
  for (const record of index.files) {
    if (seen.has(record.path)) throw new Error('Duplicate evidence');
    seen.add(record.path);
    const bytes = readFileSync(fileInside(root, record.path));
    if (bytes.length !== record.sizeBytes || hash(bytes) !== record.sha256) throw new Error(`Evidence hash mismatch: ${record.path}`);
  }
  for (const file of ['summary.json', 'tests.json', 'command.json']) if (!seen.has(file)) throw new Error('Required evidence missing');
  const summary = read(join(root, 'summary.json'));
  const proofs = evaluateP04TestEvidence(summary.repository, read(join(root, 'tests.json')));
  const command = read(join(root, 'command.json'));
  const machinePassed = command.kind === 'exit' && command.exitCode === 0 && command.stoppedVerified === true
    && !command.timedOut && proofs.every(p => p.passed);
  if (summary.commit !== index.commit || summary.phaseAccepted !== false || summary.machineAssertionsPassed !== machinePassed
      || JSON.stringify(summary.checks) !== JSON.stringify(proofs)) throw new Error('Closeout verdict mismatch');
  return { evidenceVerified: true, machineAssertionsPassed: machinePassed, commit: index.commit,
    checks: proofs.length, snapshots: index.files.filter((f: { path: string }) => f.path.endsWith('.sqlite')).length, phaseAccepted: false };
}

export async function runP04Closeout(repository: string, destination: string) {
  const repo = realpathSync(repository), root = resolve(destination);
  if (existsSync(root) || realpathSync(dirname(root)) !== dirname(root)) throw new Error('Use a new canonical report directory');
  if (git(repo, ['status', '--porcelain'])) throw new Error('Commit code before closeout');
  const commit = git(repo, ['rev-parse', 'HEAD']);
  mkdirSync(root, { mode: 0o700 });
  const save = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C', NO_COLOR: '1', SHIPLOOP_TEST_RUN_TIMEOUT_MS: '1800000' };
  for (const [key, directory] of Object.entries({ HOME: 'home', TMPDIR: 'tmp', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache' })) {
    env[key] = join(root, 'resources', directory); mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  const sqlite = join(root, 'sqlite'); mkdirSync(sqlite, { mode: 0o700 });
  env.SHIPLOOP_P04_EVIDENCE_DIR = sqlite;
  const files = [...new Set(Object.values(P04_OFFLINE_TEST_BINDINGS).flat())].sort();
  const argv = ['scripts/run-tests.ts', ...files, '--reporter=json', `--outputFile=${join(root, 'tests.json')}`];
  save('started.json', { commit, repository: repo, argv, startedAtUtc: new Date().toISOString(), scope: 'supplemental-offline-evidence', realCalls: 0 });
  console.log(`P04 closeout: ${files.length} files; ${root}`);
  const command = await runBoundedProcess(process.execPath, argv, { cwd: repo, env, timeoutMs: 1_800_000, maxOutputBytes: 1_048_576 });
  save('command.json', command);
  const proofs = evaluateP04TestEvidence(repo, existsSync(join(root, 'tests.json')) ? read(join(root, 'tests.json')) : null);
  const drift = git(repo, ['rev-parse', 'HEAD']) !== commit || git(repo, ['status', '--porcelain']) !== '';
  const summary = { schemaVersion: 1, kind: 'p04-offline-closeout', commit, repository: repo,
    machineAssertionsPassed: !drift && command.kind === 'exit' && command.exitCode === 0 && command.stoppedVerified
      && !command.timedOut && proofs.every(p => p.passed),
    drift, checks: proofs, snapshotCount: readdirSync(sqlite).filter(file => file.endsWith('.sqlite')).length,
    phaseAccepted: false, manualStatus: 'pending',
    limitations: ['补充离线证据，不替代完整工程/集成入口或 live/人工签署', 'SQLite 镜像是场景观察值，断言结论来自 tests.json',
      '缺少的进程/产品报告/真实闭环证据仍需核对，不能按文件类别或测试数量自动放行'] };
  save('summary.json', summary);
  const entries = ['started.json', 'command.json', 'summary.json', ...(existsSync(join(root, 'tests.json')) ? ['tests.json'] : []),
    ...readdirSync(sqlite).sort().map(file => `sqlite/${file}`)].map(path => {
    const bytes = readFileSync(fileInside(root, path));
    return { path, sizeBytes: bytes.length, sha256: hash(bytes) };
  });
  save('evidence-index.json', { schemaVersion: 1, kind: 'p04-offline-closeout', commit, phaseAccepted: false, files: entries });
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length || !['--out', '--verify'].includes(mode ?? '')) throw new Error('usage: node scripts/acceptance/p04-closeout.ts --out NEW_DIRECTORY | --verify DIRECTORY');
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const result = mode === '--verify' ? verifyP04Closeout(directory, git(repo, ['rev-parse', 'HEAD'])) : await runP04Closeout(repo, directory);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.machineAssertionsPassed ? 0 : 1;
  } catch (error) { console.error(error instanceof Error ? error.message : 'P04 closeout failed'); process.exitCode = 1; }
}
