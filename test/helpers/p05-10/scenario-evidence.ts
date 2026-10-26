import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const P0510_EVIDENCE_SCHEMA_VERSION = 1;
export const P0510_USAGE_SOURCES = ['runtime-usage', 'command-output', 'manual-record', 'not_run'] as const;
export type P0510UsageSource = (typeof P0510_USAGE_SOURCES)[number];
export type P0510EvidenceStatus = 'pass' | 'fail' | 'not_run';

export type P0510EvidenceErrorKind =
  | 'missing'
  | 'identity_mismatch'
  | 'hash_mismatch'
  | 'cleanup_uncertain'
  | 'write_failed';

export class P0510EvidenceError extends Error {
  readonly kind: P0510EvidenceErrorKind;
  constructor(kind: P0510EvidenceErrorKind, message: string) {
    super(message);
    this.name = 'P0510EvidenceError';
    this.kind = kind;
  }
}

export interface P0510SqliteFacts {
  readonly path: string;
  readonly journalMode: string;
  readonly foreignKeysEnabled: boolean;
  readonly open: boolean;
  readonly recordCount: number;
}

export interface P0510GitFacts {
  readonly repositoryPath: string;
  readonly head: string;
  readonly tree: string;
  readonly status: string;
}

export interface P0510ProcessFacts {
  readonly owned: boolean;
  readonly spawned: number;
  readonly exited: number;
  readonly alive: number;
  readonly identities: readonly { readonly pid: number; readonly label: string; readonly exitCode: number | null; readonly signal: string | null; readonly owned: boolean }[];
}

export interface P0510CleanupFacts {
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown';
  readonly resourcesRemoved: boolean;
  readonly processStopped: boolean;
  readonly filesChecked: boolean;
  readonly retainedRoot: string | null;
  readonly reason?: string;
}

export interface P0510EvidenceRef {
  readonly name: string;
  readonly digest: string;
}

export interface P0510ScenarioEvidence {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly inputDigest: string;
  readonly testedCommit: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly status: P0510EvidenceStatus;
  readonly durationMs: number;
  readonly stateSnapshot: Readonly<Record<string, unknown>>;
  readonly sqlite: P0510SqliteFacts;
  readonly git: P0510GitFacts;
  readonly process: P0510ProcessFacts;
  readonly usageSource: P0510UsageSource;
  readonly evidenceRefs: readonly P0510EvidenceRef[];
  readonly cleanup: P0510CleanupFacts;
  readonly notRunReason?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export function hashP0510Input(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireField(value: unknown, field: string): void {
  if (value === undefined) throw new P0510EvidenceError('missing', `证据缺少字段：${field}`);
}

function requireSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) {
    throw new P0510EvidenceError('identity_mismatch', `${field} 必须是受测 SHA`);
  }
}

export function validateP0510ScenarioEvidence(
  value: unknown,
  expected: { readonly scenarioId?: string; readonly input?: unknown; readonly testedCommit?: string } = {},
): P0510ScenarioEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new P0510EvidenceError('missing', '场景证据必须是对象');
  const evidence = value as Partial<P0510ScenarioEvidence>;
  for (const field of ['schemaVersion', 'scenarioId', 'inputDigest', 'testedCommit', 'command', 'exitCode', 'status', 'durationMs', 'stateSnapshot', 'sqlite', 'git', 'process', 'usageSource', 'evidenceRefs', 'cleanup']) {
    requireField(evidence[field as keyof P0510ScenarioEvidence], field);
  }
  if (evidence.schemaVersion !== 1) throw new P0510EvidenceError('identity_mismatch', '证据 schemaVersion 不受支持');
  if (typeof evidence.scenarioId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(evidence.scenarioId)) throw new P0510EvidenceError('identity_mismatch', 'scenarioId 非法');
  if (expected.scenarioId !== undefined && evidence.scenarioId !== expected.scenarioId) throw new P0510EvidenceError('identity_mismatch', 'scenarioId 与场景不匹配');
  if (typeof evidence.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.inputDigest)) throw new P0510EvidenceError('hash_mismatch', 'inputDigest 非法');
  if (expected.input !== undefined && evidence.inputDigest !== hashP0510Input(expected.input)) throw new P0510EvidenceError('hash_mismatch', 'inputDigest 与输入不匹配');
  requireSha(evidence.testedCommit, 'testedCommit');
  if (expected.testedCommit !== undefined && evidence.testedCommit !== expected.testedCommit) throw new P0510EvidenceError('identity_mismatch', 'testedCommit 与受测提交不匹配');
  if (!Array.isArray(evidence.command) || evidence.command.some(part => typeof part !== 'string' || part.length === 0)) throw new P0510EvidenceError('missing', 'command 必须是实际命令数组');
  if (evidence.status !== 'pass' && evidence.status !== 'fail' && evidence.status !== 'not_run') throw new P0510EvidenceError('identity_mismatch', 'status 非法');
  const exitCode = evidence.exitCode as number | null;
  const durationMs = evidence.durationMs as number;
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0)) throw new P0510EvidenceError('missing', 'exitCode 非法');
  if (evidence.status === 'not_run' && (typeof evidence.notRunReason !== 'string' || evidence.notRunReason.length === 0)) throw new P0510EvidenceError('missing', 'not_run 必须保留原因');
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new P0510EvidenceError('missing', 'durationMs 非法');
  if (!P0510_USAGE_SOURCES.includes(evidence.usageSource as P0510UsageSource)) throw new P0510EvidenceError('identity_mismatch', 'usageSource 非法');
  if (evidence.stateSnapshot === null || typeof evidence.stateSnapshot !== 'object' || Array.isArray(evidence.stateSnapshot)) throw new P0510EvidenceError('missing', 'stateSnapshot 必须是对象');
  if (!Array.isArray(evidence.evidenceRefs) || evidence.evidenceRefs.length === 0 || evidence.evidenceRefs.some(ref => typeof ref?.name !== 'string' || !/^[^/\\]+$/.test(ref.name) || typeof ref.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.digest))) throw new P0510EvidenceError('hash_mismatch', 'evidenceRefs 缺少稳定哈希');
  if (evidence.status === 'pass' && exitCode !== 0) throw new P0510EvidenceError('identity_mismatch', 'pass 证据必须绑定零退出码');
  if (evidence.status === 'not_run' && exitCode !== null) throw new P0510EvidenceError('identity_mismatch', 'not_run 证据必须绑定 null 退出码');
  const sqlite = evidence.sqlite as Partial<P0510SqliteFacts>;
  if (typeof sqlite.path !== 'string' || sqlite.path.length === 0 || sqlite.journalMode !== 'wal' || typeof sqlite.foreignKeysEnabled !== 'boolean' || typeof sqlite.open !== 'boolean' || !Number.isSafeInteger(sqlite.recordCount as number) || (sqlite.recordCount as number) < 0) throw new P0510EvidenceError('missing', 'SQLite 事实不完整');
  const git = evidence.git as Partial<P0510GitFacts>;
  if (typeof git.repositoryPath !== 'string' || git.repositoryPath.length === 0 || typeof git.status !== 'string') throw new P0510EvidenceError('missing', 'Git 事实不完整');
  requireSha(git.head, 'git.head');
  requireSha(git.tree, 'git.tree');
  const processFacts = evidence.process as Partial<P0510ProcessFacts>;
  if (processFacts.owned !== true || !Number.isSafeInteger(processFacts.spawned) || !Number.isSafeInteger(processFacts.exited) || !Number.isSafeInteger(processFacts.alive) || !Array.isArray(processFacts.identities)) throw new P0510EvidenceError('identity_mismatch', '进程归属事实缺失');
  const cleanup = evidence.cleanup as Partial<P0510CleanupFacts>;
  if (!['pending', 'passed', 'failed', 'unknown'].includes(cleanup.status ?? '') || typeof cleanup.resourcesRemoved !== 'boolean' || typeof cleanup.processStopped !== 'boolean' || typeof cleanup.filesChecked !== 'boolean' || (cleanup.retainedRoot !== null && typeof cleanup.retainedRoot !== 'string')) throw new P0510EvidenceError('cleanup_uncertain', 'cleanup 清单不完整');
  if (cleanup.status === 'passed' && (!cleanup.resourcesRemoved || !cleanup.processStopped || !cleanup.filesChecked)) throw new P0510EvidenceError('cleanup_uncertain', 'cleanup passed 但资源事实未确认');
  if (evidence.status === 'pass' && cleanup.status !== 'passed') throw new P0510EvidenceError('cleanup_uncertain', '成功证据必须绑定已确认清理');
  return evidence as P0510ScenarioEvidence;
}

export function writeP0510EvidenceFile(
  evidenceDir: string,
  evidence: P0510ScenarioEvidence,
  expected: { readonly scenarioId?: string; readonly input?: unknown; readonly testedCommit?: string } = {},
): string {
  const validated = validateP0510ScenarioEvidence(evidence, expected);
  try {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const target = join(evidenceDir, `${validated.scenarioId}.json`);
    if (existsSync(target)) throw new P0510EvidenceError('write_failed', `既有场景证据不可覆盖：${validated.scenarioId}`);
    const temporary = `${target}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`, 'utf8'); } finally { closeSync(fd); }
    renameSync(temporary, target);
    return target;
  } catch (error) {
    if (error instanceof P0510EvidenceError) throw error;
    throw new P0510EvidenceError('write_failed', `证据写入失败：${String(error)}`);
  }
}

export function evidenceFileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
