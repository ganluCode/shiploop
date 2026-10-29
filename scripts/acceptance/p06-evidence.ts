/** P06 evidence boundary. F-007 consumes these records; this module never signs a phase or manufactures product reports. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { hashP06Bytes, hashP06Input, safeP06Json, safeP06Text, ownedP06Root, ownedP06Path,
  captureP06Sqlite, captureP06Git, captureP06Files, captureP06ProcessFacts, observeP06Processes,
  type P06ProcessFacts } from './p06-facts.ts';
export { hashP06Input } from './p06-facts.ts';

export const P06_FACT_CATEGORIES = ['sqlite', 'git', 'process', 'artifact', 'command-exit', 'usage', 'manifest', 'cleanup'] as const;
export type P06FactCategory = typeof P06_FACT_CATEGORIES[number];
export type P06EvidenceIdentity = { readonly runId: string; readonly testedCommit: string; readonly inputDigest: string };
export type P06Outcome = 'success' | 'nonzero_exit' | 'timeout' | 'cancelled' | 'validation_failed' | 'resource_conflict' | 'input_drift' | 'report_write_failed' | 'capture_failed' | 'cleanup_uncertain' | 'not_run';
export type P06CommandFact = { readonly argv: readonly string[]; readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean; readonly cancelled: boolean };
export type P06CleanupFact = { readonly status: 'pending' | 'passed' | 'failed' | 'unknown'; readonly processStopped: boolean;
  readonly sqliteClosed: boolean; readonly factsExported: boolean; readonly resourcesRemoved: boolean; readonly retainedRoot: string | null; readonly reason?: string };
export type P06EvidenceRef = { readonly identity: string; readonly category: P06FactCategory; readonly path: string; readonly sha256: string; readonly sizeBytes: number };
export type P06ScenarioRecord = P06EvidenceIdentity & {
  readonly schemaVersion: 1; readonly scenarioId: string; readonly attempt: number;
  readonly command: readonly string[]; readonly exitCode: number | null;
  readonly outcome: P06Outcome; readonly status: 'pass' | 'fail' | 'not_run'; readonly reason: string | null;
  readonly sideEffects: Readonly<Record<string, unknown>>; readonly evidenceRefs: readonly P06EvidenceRef[];
  readonly usageSource: 'command-output' | 'runtime-usage' | 'not_run'; readonly cleanup: P06CleanupFact;
  readonly publicationError: 'report_write_failed' | null;
  readonly failures: readonly { readonly kind: P06Outcome; readonly reason: string }[];
};
export type P06ScenarioOptions = {
  readonly directory: string; readonly identity: P06EvidenceIdentity; readonly scenarioId: string; readonly attempt: number;
  readonly input: unknown; readonly command: P06CommandFact; readonly outcome: Exclude<P06Outcome, 'not_run'>;
  readonly reason?: string; readonly sideEffects: Readonly<Record<string, unknown>>;
  readonly tools: Readonly<Record<string, string>>; readonly usageSource: 'command-output' | 'runtime-usage';
  readonly usage?: Readonly<Record<string, unknown>>; readonly sensitiveValues?: readonly string[];
  readonly resources: { readonly root: string; readonly sqlitePath: string; readonly repositoryPath: string; readonly files: readonly string[];
    readonly processFacts: () => P06ProcessFacts; readonly cleanup: () => Promise<P06CleanupFact> };
};

const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const scenario = /^(?:FR-[12]|I0[1-8])(?:-[a-z0-9-]+)?$/;
const outcomes: readonly P06Outcome[] = ['success', 'nonzero_exit', 'timeout', 'cancelled', 'validation_failed', 'resource_conflict', 'input_drift', 'report_write_failed', 'capture_failed', 'cleanup_uncertain', 'not_run'];
const emptyCleanup = (): P06CleanupFact => ({ status: 'pending', processStopped: false, sqliteClosed: false, factsExported: false, resourcesRemoved: false, retainedRoot: '<owned-temp>' });
const confirmed = (c: P06CleanupFact) => c.status === 'passed' && c.processStopped === true && c.sqliteClosed === true && c.factsExported === true && c.resourcesRemoved === true && c.retainedRoot === null;
const prefix = (s: { scenarioId: string; attempt: number }) => `${s.scenarioId}-a${s.attempt}`;
const sameIdentity = (a: P06EvidenceIdentity, b: P06EvidenceIdentity) => a.runId === b.runId && a.testedCommit === b.testedCommit && a.inputDigest === b.inputDigest;
function assertIdentity(value: P06EvidenceIdentity): void {
  if (!id.test(value.runId) || !commit.test(value.testedCommit) || !sha.test(value.inputDigest)) throw new Error('invalid_identity');
}
function assertScenario(scenarioId: string, attempt: number): void {
  if (!scenario.test(scenarioId) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid_scenario');
}
function directoryPath(directory: string, relative: string): string {
  if (!/^(?:FR-[12]|I0[1-8])(?:-[a-z0-9-]+)?-a[1-9][0-9]*\/[a-z-]+\.json$/.test(relative)) throw new Error('unsafe_evidence_path');
  return join(directory, relative);
}
function noSymlinkAncestors(path: string): void {
  const lexical = resolve(path);
  const temporary = resolve(tmpdir());
  // macOS exposes /var via /private/var. Normalize this system alias before checking user-controlled ancestors.
  let current = lexical.startsWith(temporary + sep) ? realpathSync(temporary) + lexical.slice(temporary.length) : lexical;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('evidence_symlink');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function safeError(error: unknown): string {
  // Never propagate filesystem paths, command output, scanner hits or caller-supplied messages.
  const internal = new Set(['sensitive_content', 'resource_symlink', 'resource_escape', 'unsafe_evidence_path', 'evidence_symlink',
    'evidence_size_limit', 'export_verification_failed', 'result_mismatch', 'size_mismatch', 'hash_mismatch', 'identity_mismatch',
    'invalid_identity', 'invalid_scenario', 'invalid_result', 'invalid_command', 'missing_side_effects', 'invalid_usage_source',
    'invalid_pass', 'invalid_not_run', 'invalid_failure', 'missing_reason', 'invalid_failure_history', 'invalid_cleanup',
    'invalid_reference', 'duplicate_evidence', 'missing_category', 'invalid_facts', 'sqlite_facts_missing', 'sqlite_facts_corrupt',
    'git_facts_missing', 'process_facts_missing', 'artifact_facts_missing', 'artifact_facts_corrupt', 'command_facts_mismatch',
    'usage_facts_missing', 'manifest_facts_missing', 'cleanup_uncertain', 'cleanup_mismatch', 'invalid_process_facts',
    'invalid_process_identity', 'process_identity_missing', 'descendant_scan_uncertain', 'sqlite_corrupt', 'sqlite_table_limit',
    'sqlite_row_limit', 'sqlite_binary_unsupported', 'sqlite_size_limit', 'invalid_file_list', 'invalid_file_path', 'file_size_or_type']);
  const message = error instanceof Error ? error.message : '';
  const systemCode = (error as NodeJS.ErrnoException | null)?.code;
  const allowedSystemCodes = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_BUSY', 'SQLITE_CANTOPEN'];
  if (typeof systemCode === 'string' && allowedSystemCodes.includes(systemCode)) return systemCode.toLowerCase();
  return internal.has(message) ? message : 'evidence_operation_failed';
}
function commandOutcome(command: P06CommandFact, requested: P06Outcome): P06Outcome {
  if (command.cancelled) return 'cancelled';
  if (command.timedOut) return 'timeout';
  if (command.signal !== null || command.exitCode !== 0) return 'nonzero_exit';
  return requested;
}

/** Validates a returned claim even when collection or publication failed. */
export function validateP06Scenario(value: P06ScenarioRecord, expected: P06EvidenceIdentity): void {
  assertIdentity(value); assertScenario(value.scenarioId, value.attempt);
  if (!sameIdentity(value, expected) || value.schemaVersion !== 1) throw new Error('identity_mismatch');
  if (!outcomes.includes(value.outcome) || !['pass', 'fail', 'not_run'].includes(value.status)) throw new Error('invalid_result');
  if (!Array.isArray(value.command) || value.command.some(p => typeof p !== 'string' || !p || p.includes('\0')) ||
      (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0))) throw new Error('invalid_command');
  if (!value.sideEffects || typeof value.sideEffects !== 'object' || Array.isArray(value.sideEffects)) throw new Error('missing_side_effects');
  if (!['command-output', 'runtime-usage', 'not_run'].includes(value.usageSource)) throw new Error('invalid_usage_source');
  if (value.status === 'pass' && (value.outcome !== 'success' || value.exitCode !== 0 || !value.command.length ||
      value.usageSource === 'not_run' || !confirmed(value.cleanup) || value.publicationError !== null)) throw new Error('invalid_pass');
  if (value.status === 'not_run' && (value.exitCode !== null || value.outcome !== 'not_run' || value.command.length || value.evidenceRefs.length || value.usageSource !== 'not_run')) throw new Error('invalid_not_run');
  if (value.status === 'fail' && value.outcome === 'not_run') throw new Error('invalid_failure');
  if (value.status !== 'pass' && (typeof value.reason !== 'string' || !value.reason)) throw new Error('missing_reason');
  if (!Array.isArray(value.failures) || value.failures.some(f => !outcomes.includes(f.kind) || f.kind === 'success' || !f.reason) ||
      (value.status === 'pass' && value.failures.length) ||
      (value.status === 'fail' && (!value.failures.length || value.failures[0]!.kind !== value.outcome || value.failures[0]!.reason !== value.reason))) throw new Error('invalid_failure_history');
  if (!value.cleanup || !['pending', 'passed', 'failed', 'unknown'].includes(value.cleanup.status) ||
      ['processStopped', 'sqliteClosed', 'factsExported', 'resourcesRemoved'].some(k => typeof value.cleanup[k as keyof P06CleanupFact] !== 'boolean') ||
      (value.cleanup.retainedRoot !== null && typeof value.cleanup.retainedRoot !== 'string')) throw new Error('invalid_cleanup');
  const ids = new Set<string>(), paths = new Set<string>();
  for (const ref of value.evidenceRefs) {
    if (!P06_FACT_CATEGORIES.includes(ref.category) || !sha.test(ref.sha256) || !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes <= 0) throw new Error('invalid_reference');
    if (ref.identity !== `${value.runId}/${prefix(value)}/${ref.category}` || ref.path !== `${prefix(value)}/${ref.category}.json`) throw new Error('identity_mismatch');
    if (ids.has(ref.identity) || paths.has(ref.path)) throw new Error('duplicate_evidence');
    ids.add(ref.identity); paths.add(ref.path);
  }
  if (value.status === 'pass' && P06_FACT_CATEGORIES.some(c => !value.evidenceRefs.some(r => r.category === c))) throw new Error('missing_category');
  safeP06Json(value);
}

/** Capture -> scan -> export and re-read -> cleanup -> publish result. Never deletes a resource itself. */
export async function collectP06Scenario(options: P06ScenarioOptions): Promise<P06ScenarioRecord> {
  const { identity, scenarioId, attempt, resources } = options;
  assertIdentity(identity); assertScenario(scenarioId, attempt);
  if (hashP06Input(options.input) !== identity.inputDigest) throw new Error('input_identity_mismatch');
  hashP06Input(options.sideEffects);
  const command = options.command;
  if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some(p => typeof p !== 'string' || !p || p.includes('\0')) ||
      (command.exitCode !== null && (!Number.isSafeInteger(command.exitCode) || command.exitCode < 0)) ||
      typeof command.timedOut !== 'boolean' || typeof command.cancelled !== 'boolean' ||
      (command.signal !== null && typeof command.signal !== 'string') || !outcomes.includes(options.outcome) ||
      !Object.keys(options.tools).length || (options.usageSource === 'runtime-usage' && !options.usage)) throw new Error('invalid_scenario_input');
  const sensitive = options.sensitiveValues ?? [];
  // Validate report inputs before writing any file or invoking cleanup.
  safeP06Json({ input: options.input, command, sideEffects: options.sideEffects, tools: options.tools, usage: options.usage, reason: options.reason }, sensitive);
  const root = ownedP06Root(resources.root);
  const sqlite = ownedP06Path(root, resources.sqlitePath);
  const repo = ownedP06Path(root, resources.repositoryPath);
  noSymlinkAncestors(options.directory);
  if (resolve(options.directory) === root || resolve(options.directory).startsWith(root + sep)) throw new Error('evidence_inside_cleanup_root');
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(options.directory);
  // An attempt is an immutable publication slot. Retry uses a new attempt; a rerun uses a new runId.
  const slot = join(directory, prefix({ scenarioId, attempt }));
  mkdirSync(slot, { mode: 0o700 });
  let outcome = commandOutcome(command, options.outcome);
  let reason: string | null = outcome === 'success' ? null : options.reason ?? outcome;
  let cleanup = emptyCleanup();
  const failures: { kind: P06Outcome; reason: string }[] = outcome === 'success' ? [] : [{ kind: outcome, reason: reason! }];
  function failure(kind: P06Outcome, detail: string): void {
    failures.push({ kind, reason: detail });
    if (outcome === 'success') { outcome = kind; reason = detail; }
  }
  const refs: P06EvidenceRef[] = [];
  let publicationError: P06ScenarioRecord['publicationError'] = null;
  const safeValue = <T>(value: T): T => JSON.parse(safeP06Json(value, sensitive)) as T;
  function exportFacts(category: P06FactCategory, facts: unknown): void {
    const path = `${prefix({ scenarioId, attempt })}/${category}.json`;
    const bytes = safeP06Json({ schemaVersion: 1, ...identity, scenarioId, attempt, category, facts }, sensitive);
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('evidence_size_limit');
    const target = directoryPath(directory, path);
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    const ref = { identity: `${identity.runId}/${prefix({ scenarioId, attempt })}/${category}`, category, path, sha256: hashP06Bytes(bytes), sizeBytes: Buffer.byteLength(bytes) };
    if (hashP06Bytes(readFileSync(target)) !== ref.sha256 || lstatSync(target).size !== ref.sizeBytes) throw new Error('export_verification_failed');
    refs.push(ref);
  }
  let captured: ReturnType<typeof captureP06ProcessFacts> | undefined;
  try {
    // All collectors run while resources are intact. Stage the whole scanned export before the first write.
    captured = captureP06ProcessFacts(resources.processFacts());
    const facts = {
      sqlite: captureP06Sqlite(sqlite, sensitive), git: captureP06Git(root, repo), process: captured,
      artifact: { files: captureP06Files(root, repo, resources.files, sensitive) },
      'command-exit': command, usage: { source: options.usageSource, tools: options.tools, usage: options.usage ?? null },
      manifest: { capturedBeforeDeletion: true, rootIdentity: hashP06Bytes(root), files: [...resources.files], sideEffects: options.sideEffects },
    };
    safeP06Json(facts, sensitive);
    for (const category of P06_FACT_CATEGORIES.filter(c => c !== 'cleanup')) exportFacts(category, facts[category]);
  } catch (error) {
    failure('capture_failed', safeError(error));
  }
  if (refs.length === P06_FACT_CATEGORIES.length - 1 && captured) {
    try {
      cleanup = await resources.cleanup();
      const after = observeP06Processes();
      const remaining = captured.observed.filter(before => after.some(row => row.pid === before.pid && row.identity === before.identity && !row.zombie));
      if (existsSync(root) || remaining.length || !confirmed(cleanup)) {
        failure('cleanup_uncertain', 'cleanup_uncertain');
        cleanup = { ...cleanup, status: 'failed', resourcesRemoved: !existsSync(root), processStopped: cleanup.processStopped && !remaining.length };
      }
      exportFacts('cleanup', { ...cleanup, descendantsGone: remaining.length === 0, observedAfter: after.filter(p => captured!.observed.some(before => p.pid === before.pid && p.identity === before.identity)) });
    } catch (error) {
      failure('cleanup_uncertain', safeError(error));
    }
  }
  let record: P06ScenarioRecord = safeValue({ schemaVersion: 1, ...identity, scenarioId, attempt,
    command: [...command.argv], exitCode: command.exitCode, outcome, status: outcome === 'success' && confirmed(cleanup) ? 'pass' : 'fail', reason,
    sideEffects: options.sideEffects, evidenceRefs: refs, usageSource: options.usageSource, cleanup, publicationError, failures });
  try {
    validateP06Scenario(record, identity);
    writeFileSync(join(slot, 'result.json'), safeP06Json(record, sensitive), { flag: 'wx', mode: 0o600 });
    if (!verifyP06Scenario(directory, record, identity).ok) throw new Error('result_verification_failed');
  } catch {
    publicationError = 'report_write_failed';
    record = { ...record, status: 'fail', outcome: record.outcome === 'success' ? 'report_write_failed' : record.outcome,
      reason: record.reason ?? 'report_write_failed', publicationError,
      failures: [...record.failures, { kind: 'report_write_failed', reason: 'report_write_failed' }] };
  }
  return record;
}

/** Full directory/content validation after temporary resources have gone; no log inference. */
export function verifyP06Scenario(directory: string, record: P06ScenarioRecord, expected: P06EvidenceIdentity): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  try {
    noSymlinkAncestors(directory);
    validateP06Scenario(record, expected);
    const resultPath = directoryPath(directory, `${prefix(record)}/result.json`);
    noSymlinkAncestors(resultPath);
    if (hashP06Input(JSON.parse(readFileSync(resultPath, 'utf8'))) !== hashP06Input(record)) throw new Error('result_mismatch');
    for (const ref of record.evidenceRefs) {
      const path = directoryPath(directory, ref.path);
      noSymlinkAncestors(path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.size !== ref.sizeBytes) throw new Error('size_mismatch');
      const bytes = readFileSync(path);
      if (hashP06Bytes(bytes) !== ref.sha256) throw new Error('hash_mismatch');
      safeP06Text(bytes.toString('utf8'));
      const body = JSON.parse(bytes.toString('utf8'));
      safeP06Json(body);
      if (!sameIdentity(body, expected) || body.schemaVersion !== 1 || body.scenarioId !== record.scenarioId || body.attempt !== record.attempt || body.category !== ref.category) throw new Error('identity_mismatch');
      validateFacts(ref.category, body.facts, record);
    }
    if (record.status === 'pass' && !confirmed(record.cleanup)) throw new Error('cleanup_uncertain');
  } catch (error) { problems.push(safeError(error)); }
  return { ok: problems.length === 0, problems };
}

function validateFacts(category: P06FactCategory, facts: any, record: P06ScenarioRecord): void {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('invalid_facts');
  switch (category) {
    case 'sqlite':
      if (facts.integrity !== 'ok' || typeof facts.journalMode !== 'string' || !Array.isArray(facts.tables) || !facts.tables.length) throw new Error('sqlite_facts_missing');
      for (const table of facts.tables) if (typeof table.name !== 'string' || typeof table.schema !== 'string' || !Array.isArray(table.rows) || table.count !== table.rows.length || hashP06Input(table.rows) !== table.digest) throw new Error('sqlite_facts_corrupt');
      break;
    case 'git':
      if (!commit.test(facts.head) || !commit.test(facts.tree) || ['status', 'diff', 'stagedDiff'].some(k => typeof facts[k] !== 'string')) throw new Error('git_facts_missing');
      break;
    case 'process':
      if (facts.owned !== true || facts.descendantsChecked !== true || !Array.isArray(facts.observed) || !Array.isArray(facts.identities) ||
          !Array.isArray(facts.trees) || facts.spawned !== facts.identities.length || facts.alive + facts.exited !== facts.spawned ||
          ![facts.spawned, facts.alive, facts.exited].every(v => Number.isSafeInteger(v) && v >= 0) ||
          facts.alive !== facts.identities.filter((p: any) => p.alive === true).length ||
          new Set(facts.identities.map((p: any) => p.pid)).size !== facts.spawned ||
          facts.identities.some((p: any) => !Number.isSafeInteger(p.pid) || p.pid <= 1 || typeof p.label !== 'string' || typeof p.alive !== 'boolean') ||
          facts.observed.some((p: any) => !Number.isSafeInteger(p.pid) || p.pid <= 1 || !Number.isSafeInteger(p.ppid) || !sha.test(p.identity) || typeof p.zombie !== 'boolean') ||
          facts.trees.some((tree: any) => tree.scanConfirmed !== true || !facts.identities.some((p: any) => p.pid === tree.rootPid) || !Array.isArray(tree.identities) ||
            tree.identities.some((p: any) => !facts.observed.some((o: any) => p.pid === o.pid && p.identity === o.identity)))) throw new Error('process_facts_missing');
      break;
    case 'artifact':
      if (!Array.isArray(facts.files) || !facts.files.length || new Set(facts.files.map((f: any) => f.path)).size !== facts.files.length) throw new Error('artifact_facts_missing');
      for (const file of facts.files) if (typeof file.path !== 'string' || typeof file.content !== 'string' || hashP06Bytes(file.content) !== file.sha256 || Buffer.byteLength(file.content) !== file.sizeBytes) throw new Error('artifact_facts_corrupt');
      break;
    case 'command-exit':
      if (JSON.stringify(facts.argv) !== JSON.stringify(record.command) || facts.exitCode !== record.exitCode || typeof facts.timedOut !== 'boolean' || typeof facts.cancelled !== 'boolean' || (record.status === 'pass' && (facts.signal !== null || facts.timedOut || facts.cancelled))) throw new Error('command_facts_mismatch');
      break;
    case 'usage':
      if (facts.source !== record.usageSource || !facts.tools || !Object.keys(facts.tools).length || Object.values(facts.tools).some(v => typeof v !== 'string' || !v) || (facts.source === 'runtime-usage' && !facts.usage)) throw new Error('usage_facts_missing');
      break;
    case 'manifest':
      if (facts.capturedBeforeDeletion !== true || !sha.test(facts.rootIdentity) || !Array.isArray(facts.files) || hashP06Input(facts.sideEffects) !== hashP06Input(record.sideEffects)) throw new Error('manifest_facts_missing');
      break;
    case 'cleanup':
      if (record.status === 'pass' && (!confirmed(facts) || facts.descendantsGone !== true)) throw new Error('cleanup_uncertain');
      for (const key of ['status', 'processStopped', 'sqliteClosed', 'factsExported', 'resourcesRemoved', 'retainedRoot']) if (facts[key] !== record.cleanup[key as keyof P06CleanupFact]) throw new Error('cleanup_mismatch');
  }
}

/** A missing check is a complete structured not_run record, never an empty successful placeholder. */
export function notRunP06Scenario(identity: P06EvidenceIdentity, scenarioId: string, reason: string): P06ScenarioRecord {
  assertIdentity(identity); assertScenario(scenarioId, 1);
  if (!reason) throw new Error('missing_reason');
  const record: P06ScenarioRecord = { schemaVersion: 1, ...identity, scenarioId, attempt: 1,
    command: [], exitCode: null, outcome: 'not_run', status: 'not_run', reason,
    sideEffects: { observed: false }, evidenceRefs: [], usageSource: 'not_run', cleanup: emptyCleanup(), publicationError: null, failures: [] };
  validateP06Scenario(record, identity);
  return record;
}

/** Required failures are separate identities, so a later retry cannot erase a failed attempt. */
export const P06_REQUIRED_EVIDENCE_SCENARIOS = ['FR-1', 'FR-2', 'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08',
  'I07-nonzero-exit', 'I07-timeout', 'I07-cancelled', 'I07-validation-failed', 'I07-resource-conflict', 'I07-input-drift', 'I08-report-write-failed'] as const;

export function reconcileP06Evidence(directory: string, identity: P06EvidenceIdentity, records: readonly P06ScenarioRecord[], required: readonly string[] = P06_REQUIRED_EVIDENCE_SCENARIOS) {
  assertIdentity(identity);
  if (!required.length || new Set(required).size !== required.length || required.some(s => !scenario.test(s))) throw new Error('invalid_required_scenarios');
  const ids = new Set<string>(), paths = new Set<string>(), slots = new Set<string>();
  const checked = records.map(record => {
    const slot = prefix(record);
    if (slots.has(slot)) throw new Error('duplicate_scenario_attempt');
    slots.add(slot);
    for (const ref of record.evidenceRefs) {
      if (ids.has(ref.identity) || paths.has(ref.path)) throw new Error('duplicate_evidence');
      ids.add(ref.identity); paths.add(ref.path);
    }
    const verification = verifyP06Scenario(directory, record, identity);
    return { record, verification };
  });
  const checks = required.map(scenarioId => {
    const matches = checked.filter(r => r.record.scenarioId === scenarioId);
    if (!matches.length) {
      const reason = checked.some(r => r.record.status === 'fail' || !r.verification.ok) ? 'halted_by_prior_failure' : 'missing_scenario';
      return { scenarioId, status: 'not_run' as const, reason, attempts: [notRunP06Scenario(identity, scenarioId, reason)] };
    }
    // Every attempt remains visible; one failure prevents a retry from laundering a run into success.
    const failed = matches.find(r => !r.verification.ok || r.record.status === 'fail');
    const notRun = matches.find(r => r.record.status === 'not_run');
    return { scenarioId, status: failed ? 'fail' as const : notRun ? 'not_run' as const : 'pass' as const,
      reason: failed?.verification.problems[0] ?? failed?.record.reason ?? notRun?.record.reason ?? null,
      attempts: matches.map(r => r.record) };
  });
  return { checks, status: checks.every(c => c.status === 'pass') && checked.every(r => r.verification.ok && r.record.status === 'pass') ? 'pass' as const : 'fail' as const };
}
