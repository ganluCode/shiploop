/**
 * P07-5 / F-010 场景证据记录与离线核验（开发验收工具，不进 packages/）。
 *
 * 只读证据消费者与结构化采集出口；本模块不签署阶段、不制造产品报告、
 * 不修改产品或 Harness 状态。职责与 P06 的 p06-evidence.ts 相同，但绑定
 * P07-5 冻结清单（p07-config.ts）的检查身份与 F-002 演练夹具事实结构：
 *
 * - **身份绑定**：每条场景记录绑定 runId/受测 commit/输入摘要/checkId/attempt；
 *   每类事实是独立类型化文件（sqlite/git/process/artifact/manifest/budget/
 *   notification/archive/command-exit/usage/cleanup），携带相同身份与类别声明，
 *   绝不以同一段说明充当不同类别的事实；
 * - **严格三态**：pass 要求期望达成（success 或 expected_rejection）、主命令
 *   退出码为 0、至少一条正常业务断言、期望拒绝显式登记且与场景执行错误
 *   （executionErrors）区分、清理确认（进程停止/事实导出/SQLite 关闭/资源
 *   删除）；零断言或仅退出码 0 不得形成通过；not_run 是完整结构化记录；
 * - **离线核验**：临时数据根删除后仅凭证据目录重放校验——逐文件 hash/size、
 *   身份/类别一致性与逐类结构校验（表格摘要、Git HEAD/tree、进程身份、制品
 *   哈希、清单、预算、通知投递、归档操作、命令事实、用量来源、清理事实）；
 *   篡改、丢文件、伪造分类、身份漂移一律 fail-closed；
 * - **脱敏**：合成哨兵与开发机绝对路径经登记 fail-closed；演练临时根统一
 *   脱敏为 <fixture>；错误输出只保留内部代码，不回显路径或命令输出。
 *
 * 仅使用可擦除 TypeScript 语法与 Node 内置模块，由 Node 22 原生类型擦除运行。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { hashP06Bytes, hashP06Input, safeP06Json, safeP06Text } from './p06-facts.ts';

export const hashP07Bytes = hashP06Bytes;
export const hashP07Input = hashP06Input;
export type P07SafeJson = typeof safeP06Json;
export const safeP07Json = safeP06Json;
export const safeP07Text = safeP06Text;

/* ------------------------------------------------------------------ *
 * 类型与常量
 * ------------------------------------------------------------------ */

export const P07_FACT_CATEGORIES = ['sqlite', 'git', 'process', 'artifact', 'manifest', 'budget', 'notification', 'archive', 'command-exit', 'usage', 'cleanup'] as const;
export type P07FactCategory = (typeof P07_FACT_CATEGORIES)[number];
/** 允许调用方显式提供（或覆盖）的事实类别；命令/清理/清单始终由采集器绑定记录生成。 */
export const P07_OVERRIDE_FACT_CATEGORIES = ['sqlite', 'git', 'process', 'artifact', 'budget', 'notification', 'archive', 'usage'] as const;
export type P07OverrideFactCategory = (typeof P07_OVERRIDE_FACT_CATEGORIES)[number];

export type P07EvidenceIdentity = { readonly runId: string; readonly testedCommit: string; readonly inputDigest: string };
export type P07Outcome =
  | 'success' | 'expected_rejection' | 'nonzero_exit' | 'timeout' | 'cancelled'
  | 'capture_failed' | 'cleanup_uncertain' | 'publication_failed' | 'not_run';
export const P07_OUTCOMES: readonly P07Outcome[] = ['success', 'expected_rejection', 'nonzero_exit', 'timeout', 'cancelled', 'capture_failed', 'cleanup_uncertain', 'publication_failed', 'not_run'];
const FAILURE_OUTCOMES: readonly P07Outcome[] = ['nonzero_exit', 'timeout', 'cancelled', 'capture_failed', 'cleanup_uncertain', 'publication_failed'];

export type P07CommandFactLike = {
  readonly label: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly escalated: readonly string[];
  readonly stopConfirmed: boolean;
};

export type P07CleanupFact = {
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown';
  readonly processStopped: boolean;
  readonly factsExported: boolean;
  readonly sqliteClosed: boolean;
  readonly resourcesRemoved: boolean;
  readonly retainedRoot: string | null;
  readonly reason?: string;
};

export type P07EvidenceRef = {
  readonly identity: string;
  readonly category: P07FactCategory;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export type P07ScenarioRecord = P07EvidenceIdentity & {
  readonly schemaVersion: 1;
  readonly checkId: string;
  readonly attempt: number;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly expectation: 'success' | 'expected_rejection';
  readonly outcome: P07Outcome;
  readonly status: 'pass' | 'fail' | 'not_run';
  readonly reason: string | null;
  /** 正常业务断言（稳定 ID）；pass 至少一条，零断言或仅退出码 0 不得通过。 */
  readonly positiveAssertions: readonly string[];
  /** 负例正确拒绝（业务期望的一部分），与 executionErrors（场景执行错误）严格区分。 */
  readonly expectedRejections: readonly { readonly kind: string; readonly reason: string }[];
  readonly executionErrors: readonly { readonly kind: P07Outcome; readonly reason: string }[];
  readonly evidenceRefs: readonly P07EvidenceRef[];
  readonly usageSource: 'command-output' | 'runtime-usage' | 'not_run';
  readonly cleanup: P07CleanupFact;
  readonly publicationError: 'publication_failed' | null;
};

/** F-002 演练夹具采集事实的结构子集（鸭子类型；脚本层不依赖测试助手模块）。 */
export interface P07DrillEvidenceLike {
  readonly business: {
    readonly projects: readonly { readonly projectId: string; readonly featureId: string }[];
    readonly runs: readonly { readonly runId: string; readonly status: string }[];
    readonly attempts: readonly { readonly attemptId: string; readonly taskId: string; readonly runId: string; readonly status: string; readonly executionStage: string | null; readonly exitCode: number | null }[];
    readonly tasks: readonly { readonly projectId: string; readonly taskId: string; readonly status: string }[];
    readonly workspaces: readonly { readonly branch: string; readonly baseCommit: string; readonly status: string }[];
    readonly verificationBatches: readonly { readonly batchId: string; readonly status: string; readonly attemptId: string }[];
  };
  readonly budget: { readonly runId: string; readonly attemptsCreated: number; readonly runtimeStarts: number; readonly deadlineAt: number | string | null } | null;
  readonly git: readonly {
    readonly repository: string; readonly head: string; readonly tree: string; readonly branch: string;
    readonly baseCommit: string; readonly headBeyondBase: boolean; readonly statusEntries: readonly string[];
    readonly worktreePath: string | null; readonly workspaceGone: boolean;
  }[];
  readonly processes: readonly { readonly pid: number; readonly label: string; readonly alive: boolean; readonly exitCode: number | null; readonly signal: string | null; readonly stopEscalated: readonly string[]; readonly source: string }[];
  readonly artifacts: readonly { readonly projectId: string; readonly artifactId: string; readonly kind: string; readonly contentHash: string; readonly sizeBytes: number }[];
  readonly commands: readonly P07CommandFactLike[];
  readonly concurrency: readonly Record<string, unknown>[];
  readonly timings: Readonly<Record<string, number>>;
}

export type P07SqliteFacts = {
  readonly source: string;
  readonly tables: readonly { readonly name: string; readonly rows: readonly unknown[]; readonly count: number; readonly digest: string }[];
};
export type P07GitFacts = {
  readonly repositories: readonly {
    readonly repository: string; readonly head: string; readonly tree: string; readonly branch: string;
    readonly baseCommit: string; readonly headBeyondBase: boolean; readonly statusEntries: readonly string[];
    readonly worktreePath: string | null; readonly workspaceGone: boolean;
  }[];
};
export type P07ProcessFacts = {
  readonly owned: true;
  readonly descendantsChecked: true;
  readonly processes: readonly { readonly pid: number; readonly label: string; readonly alive: boolean; readonly exitCode: number | null; readonly signal: string | null; readonly stopEscalated: readonly string[]; readonly source: string }[];
};
export type P07ArtifactFacts = {
  readonly artifacts: readonly { readonly projectId: string; readonly artifactId: string; readonly kind: string; readonly contentHash: string; readonly sizeBytes: number }[];
};
export type P07BudgetFacts = {
  readonly budget: { readonly runId: string; readonly attemptsCreated: number; readonly runtimeStarts: number; readonly deadlineAt: number | string | null };
};
export type P07NotificationFacts = {
  readonly channelIds: readonly string[];
  readonly deliveries: readonly { readonly id: string; readonly eventId: string; readonly channelId: string; readonly status: string; readonly attemptCount: number }[];
  readonly results: readonly { readonly deliveryId: string; readonly attempt: number; readonly outcome: string }[];
  readonly taskRerunObserved: boolean;
};
export type P07ArchiveFacts = {
  readonly operations: readonly { readonly operation: string; readonly projectId: string; readonly outcome: string; readonly detail?: string }[];
  readonly recordsRetained: boolean;
};
export type P07UsageFacts = {
  readonly source: 'command-output' | 'runtime-usage';
  readonly tools: Readonly<Record<string, string>>;
  readonly usage: unknown;
};

export type P07OverrideFacts = {
  readonly sqlite?: P07SqliteFacts;
  readonly git?: P07GitFacts;
  readonly process?: P07ProcessFacts;
  readonly artifact?: P07ArtifactFacts;
  readonly budget?: P07BudgetFacts;
  readonly notification?: P07NotificationFacts;
  readonly archive?: P07ArchiveFacts;
  readonly usage?: P07UsageFacts;
};

export type P07ScenarioCollectOptions = {
  /** 持久证据源目录（必须在演练临时根之外；临时根删除后仍保留）。 */
  readonly directory: string;
  readonly identity: P07EvidenceIdentity;
  /** P07 冻结清单的离线检查 ID（group=fr/scenario）。 */
  readonly checkId: string;
  readonly attempt: number;
  readonly expectation: 'success' | 'expected_rejection';
  readonly command: P07CommandFactLike;
  readonly positiveAssertions: readonly string[];
  readonly expectedRejections?: readonly { readonly kind: string; readonly reason: string }[];
  /** F-002 夹具在临时资源删除前采集的真实事实（可选；非演练来源用 facts 显式提供）。 */
  readonly drill?: P07DrillEvidenceLike;
  readonly facts?: P07OverrideFacts;
  readonly usage: { readonly source: 'command-output' | 'runtime-usage'; readonly tools: Readonly<Record<string, string>>; readonly usage?: unknown };
  readonly cleanup: P07CleanupFact;
  readonly sensitiveValues?: readonly string[];
  /** 演练临时根：证据文本中统一脱敏为 <fixture>。 */
  readonly fixtureRoot?: string;
};

/* ------------------------------------------------------------------ *
 * 校验辅助
 * ------------------------------------------------------------------ */

const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const runIdPattern = /^[\w][\w-]{0,79}$/;
const checkIdPattern = /^P07-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const INTERNAL_CODES = new Set([
  'invalid_identity', 'invalid_check', 'invalid_attempt', 'invalid_command', 'invalid_assertions',
  'invalid_rejections', 'invalid_cleanup', 'invalid_reference', 'duplicate_evidence', 'missing_category',
  'invalid_result', 'invalid_pass', 'invalid_not_run', 'invalid_failure', 'missing_reason',
  'invalid_failure_history', 'unsafe_evidence_path', 'evidence_symlink', 'evidence_inside_cleanup_root',
  'evidence_size_limit', 'export_verification_failed', 'result_mismatch', 'size_mismatch', 'hash_mismatch',
  'identity_mismatch', 'category_mismatch', 'invalid_facts', 'invalid_scenario_input', 'invalid_drill_facts',
  'sqlite_facts_corrupt', 'git_facts_missing', 'process_facts_missing', 'artifact_facts_corrupt',
  'manifest_facts_missing', 'budget_facts_missing', 'notification_facts_missing', 'archive_facts_missing',
  'command_facts_mismatch', 'usage_facts_missing', 'cleanup_mismatch', 'cleanup_uncertain',
  'result_verification_failed', 'sensitive_content', 'invalid_json_input',
]);
const SAFE_SYSTEM_CODES = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC'];

function safeError(error: unknown): string {
  // 不回显文件系统路径、命令输出或调用方文本；只保留内部代码与受限系统码。
  const message = error instanceof Error ? error.message : '';
  const systemCode = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof systemCode === 'string' && SAFE_SYSTEM_CODES.includes(systemCode)) return systemCode.toLowerCase();
  return INTERNAL_CODES.has(message) ? message : 'evidence_operation_failed';
}

export function assertP07Identity(value: P07EvidenceIdentity): void {
  if (!runIdPattern.test(value.runId) || !commitPattern.test(value.testedCommit) || !shaPattern.test(value.inputDigest)) {
    throw new Error('invalid_identity');
  }
}

function assertCheckId(checkId: string): void {
  if (!checkIdPattern.test(checkId)) throw new Error('invalid_check');
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid_attempt');
}

const confirmedCleanup = (cleanup: P07CleanupFact): boolean =>
  cleanup.status === 'passed' && cleanup.processStopped === true && cleanup.factsExported === true
  && cleanup.sqliteClosed === true && cleanup.resourcesRemoved === true && cleanup.retainedRoot === null;

const slotOf = (record: { checkId: string; attempt: number }): string => `${record.checkId}-a${record.attempt}`;

function noSymlinkAncestors(path: string): void {
  const lexical = resolve(path);
  const temporary = resolve(tmpdir());
  // macOS 通过 /var 暴露 /private/var；检查用户可控祖先前先规范化该系统别名。
  let current = lexical.startsWith(temporary + sep) ? realpathSync(temporary) + lexical.slice(temporary.length) : lexical;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('evidence_symlink');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function evidencePath(directory: string, relative: string): string {
  if (!/^P07-[A-Z0-9]+(?:-[A-Z0-9]+)*-a[1-9][0-9]*\/[a-z-]+\.json$/.test(relative)) throw new Error('unsafe_evidence_path');
  return join(directory, relative);
}

/** 统一脱敏：登记值 → [REDACTED:hash]，演练临时根 → <fixture>；保留 JSON 结构有效。 */
export function redactP07EvidenceText(text: string, sensitiveValues: readonly string[], fixtureRoot?: string): string {
  let result = text;
  if (fixtureRoot !== undefined) result = result.split(fixtureRoot).join('<fixture>');
  for (const value of sensitiveValues) {
    if (typeof value !== 'string' || value === '') continue;
    result = result.split(value).join(`[REDACTED:${hashP07Bytes(value).slice(0, 12)}]`);
  }
  return result;
}

function readEvidenceFile(path: string): Buffer {
  noSymlinkAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.size < 1) throw new Error('evidence_size_limit');
  const bytes = readFileSync(path);
  safeP07Text(bytes.toString('utf8'));
  JSON.parse(bytes.toString('utf8'));
  return bytes;
}

/* ------------------------------------------------------------------ *
 * 逐类事实结构校验（采集与离线核验共用）
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateP07Facts(category: P07FactCategory, facts: unknown, record: P07ScenarioRecord): void {
  if (!isObject(facts)) throw new Error('invalid_facts');
  switch (category) {
    case 'sqlite': {
      if (typeof facts.source !== 'string' || !facts.source || !Array.isArray(facts.tables) || facts.tables.length === 0) throw new Error('sqlite_facts_corrupt');
      const names = new Set<string>();
      for (const table of facts.tables as unknown[]) {
        if (!isObject(table) || typeof table.name !== 'string' || !table.name || !Array.isArray(table.rows)
          || table.count !== table.rows.length || typeof table.digest !== 'string' || hashP07Input(table.rows) !== table.digest) throw new Error('sqlite_facts_corrupt');
        if (names.has(table.name)) throw new Error('sqlite_facts_corrupt');
        names.add(table.name);
      }
      break;
    }
    case 'git': {
      if (!Array.isArray(facts.repositories) || facts.repositories.length === 0) throw new Error('git_facts_missing');
      for (const repo of facts.repositories as unknown[]) {
        if (!isObject(repo) || typeof repo.repository !== 'string' || !repo.repository
          || !commitPattern.test(String(repo.head)) || !commitPattern.test(String(repo.tree)) || !commitPattern.test(String(repo.baseCommit))
          || typeof repo.branch !== 'string' || !repo.branch || typeof repo.headBeyondBase !== 'boolean'
          || !Array.isArray(repo.statusEntries) || repo.statusEntries.some((entry: unknown) => typeof entry !== 'string')
          || (repo.worktreePath !== null && typeof repo.worktreePath !== 'string') || typeof repo.workspaceGone !== 'boolean') throw new Error('git_facts_missing');
      }
      break;
    }
    case 'process': {
      if (facts.owned !== true || facts.descendantsChecked !== true || !Array.isArray(facts.processes)) throw new Error('process_facts_missing');
      for (const process_ of facts.processes as unknown[]) {
        const pid = isObject(process_) ? process_.pid : undefined;
        if (!isObject(process_) || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || typeof process_.label !== 'string'
          || typeof process_.alive !== 'boolean' || (process_.exitCode !== null && !Number.isSafeInteger(process_.exitCode))
          || (process_.signal !== null && typeof process_.signal !== 'string')
          || !Array.isArray(process_.stopEscalated) || process_.stopEscalated.some((step: unknown) => typeof step !== 'string')
          || typeof process_.source !== 'string' || !process_.source) throw new Error('process_facts_missing');
      }
      break;
    }
    case 'artifact': {
      if (!Array.isArray(facts.artifacts) || facts.artifacts.length === 0) throw new Error('artifact_facts_corrupt');
      for (const artifact of facts.artifacts as unknown[]) {
        const sizeBytes = isObject(artifact) ? artifact.sizeBytes : undefined;
        if (!isObject(artifact) || typeof artifact.projectId !== 'string' || !artifact.projectId
          || typeof artifact.artifactId !== 'string' || !artifact.artifactId || typeof artifact.kind !== 'string' || !artifact.kind
          || !shaPattern.test(String(artifact.contentHash)) || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('artifact_facts_corrupt');
      }
      break;
    }
    case 'manifest': {
      if (facts.capturedBeforeDeletion !== true || typeof facts.source !== 'string' || !facts.source
        || !Array.isArray(facts.runIds) || facts.runIds.some((id: unknown) => typeof id !== 'string')
        || !Array.isArray(facts.evidenceFiles) || facts.evidenceFiles.some((file: unknown) => typeof file !== 'string')) throw new Error('manifest_facts_missing');
      const timings = facts.timings;
      if (!isObject(timings) || Object.keys(timings).length === 0 || Object.values(timings).some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('manifest_facts_missing');
      const declared = new Set(facts.evidenceFiles as string[]);
      for (const ref of record.evidenceRefs) {
        if (ref.category !== 'manifest' && !declared.has(ref.path)) throw new Error('manifest_facts_missing');
      }
      break;
    }
    case 'budget': {
      const budget = facts.budget;
      const attemptsCreated = isObject(budget) ? budget.attemptsCreated : undefined;
      const runtimeStarts = isObject(budget) ? budget.runtimeStarts : undefined;
      if (!isObject(budget) || typeof budget.runId !== 'string' || !budget.runId
        || typeof attemptsCreated !== 'number' || !Number.isSafeInteger(attemptsCreated) || attemptsCreated < 1
        || typeof runtimeStarts !== 'number' || !Number.isSafeInteger(runtimeStarts) || runtimeStarts < 0
        || (budget.deadlineAt !== null && typeof budget.deadlineAt !== 'number' && typeof budget.deadlineAt !== 'string')) throw new Error('budget_facts_missing');
      break;
    }
    case 'notification': {
      if (!Array.isArray(facts.channelIds) || facts.channelIds.length === 0 || facts.channelIds.some((id: unknown) => typeof id !== 'string' || !id)
        || !Array.isArray(facts.deliveries) || !Array.isArray(facts.results) || typeof facts.taskRerunObserved !== 'boolean') throw new Error('notification_facts_missing');
      const channels = new Set(facts.channelIds as string[]);
      for (const delivery of facts.deliveries as unknown[]) {
        const attemptCount = isObject(delivery) ? delivery.attemptCount : undefined;
        if (!isObject(delivery) || typeof delivery.id !== 'string' || !delivery.id || typeof delivery.eventId !== 'string' || !delivery.eventId
          || typeof delivery.channelId !== 'string' || !channels.has(delivery.channelId) || typeof delivery.status !== 'string' || !delivery.status
          || typeof attemptCount !== 'number' || !Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error('notification_facts_missing');
      }
      for (const result of facts.results as unknown[]) {
        const attempt = isObject(result) ? result.attempt : undefined;
        if (!isObject(result) || typeof result.deliveryId !== 'string' || !result.deliveryId
          || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || typeof result.outcome !== 'string' || !result.outcome) throw new Error('notification_facts_missing');
      }
      if (record.status === 'pass' && (facts.deliveries as unknown[]).length === 0) throw new Error('notification_facts_missing');
      break;
    }
    case 'archive': {
      if (!Array.isArray(facts.operations) || typeof facts.recordsRetained !== 'boolean') throw new Error('archive_facts_missing');
      for (const operation of facts.operations as unknown[]) {
        if (!isObject(operation) || typeof operation.operation !== 'string' || !operation.operation
          || typeof operation.projectId !== 'string' || !operation.projectId || typeof operation.outcome !== 'string' || !operation.outcome) throw new Error('archive_facts_missing');
      }
      if (record.status === 'pass' && (facts.operations as unknown[]).length === 0) throw new Error('archive_facts_missing');
      break;
    }
    case 'command-exit': {
      if (!Array.isArray(facts.commands) || facts.commands.length === 0) throw new Error('command_facts_mismatch');
      const [primary, ...rest] = facts.commands as unknown[];
      if (!isObject(primary) || JSON.stringify(primary.argv) !== JSON.stringify(record.command)
        || primary.exitCode !== record.exitCode || primary.durationMs !== record.durationMs) throw new Error('command_facts_mismatch');
      for (const command of facts.commands as unknown[]) {
        const durationMs = isObject(command) ? command.durationMs : undefined;
        if (!isObject(command) || typeof command.label !== 'string' || !command.label
          || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part: unknown) => typeof part !== 'string' || !part)
          || (command.exitCode !== null && (typeof command.exitCode !== 'number' || !Number.isSafeInteger(command.exitCode)))
          || (command.signal !== null && typeof command.signal !== 'string')
          || typeof command.timedOut !== 'boolean' || typeof command.cancelled !== 'boolean'
          || typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0
          || !Array.isArray(command.escalated) || command.escalated.some((step: unknown) => typeof step !== 'string')
          || typeof command.stopConfirmed !== 'boolean') throw new Error('command_facts_mismatch');
      }
      if (record.status === 'pass' && (primary.exitCode !== 0 || primary.signal !== null || primary.timedOut || primary.cancelled)) throw new Error('command_facts_mismatch');
      break;
    }
    case 'usage': {
      if (facts.source !== record.usageSource || !isObject(facts.tools) || Object.keys(facts.tools).length === 0
        || Object.values(facts.tools).some(value => typeof value !== 'string' || !value)) throw new Error('usage_facts_missing');
      if (facts.source === 'runtime-usage' && facts.usage === null) throw new Error('usage_facts_missing');
      break;
    }
    case 'cleanup': {
      if (hashP07Input(facts) !== hashP07Input(record.cleanup)) throw new Error('cleanup_mismatch');
      if (record.status === 'pass' && !confirmedCleanup(facts as unknown as P07CleanupFact)) throw new Error('cleanup_uncertain');
      break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 场景记录校验与离线核验
 * ------------------------------------------------------------------ */

/** 校验返回的声明（即使采集或发布失败也可校验）。 */
export function validateP07Scenario(value: P07ScenarioRecord, expected: P07EvidenceIdentity): void {
  assertP07Identity(value);
  assertCheckId(value.checkId);
  assertAttempt(value.attempt);
  if (value.schemaVersion !== 1 || value.runId !== expected.runId || value.testedCommit !== expected.testedCommit || value.inputDigest !== expected.inputDigest) throw new Error('identity_mismatch');
  if (!P07_OUTCOMES.includes(value.outcome) || !['pass', 'fail', 'not_run'].includes(value.status)) throw new Error('invalid_result');
  if (value.expectation !== 'success' && value.expectation !== 'expected_rejection') throw new Error('invalid_scenario_input');
  if (!Array.isArray(value.command) || value.command.some(part => typeof part !== 'string' || !part || part.includes('\0'))) throw new Error('invalid_command');
  if ((value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0)) || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) throw new Error('invalid_command');
  if (!Array.isArray(value.positiveAssertions) || value.positiveAssertions.length === 0
    || value.positiveAssertions.some(assertion => typeof assertion !== 'string' || !assertion)
    || new Set(value.positiveAssertions).size !== value.positiveAssertions.length) throw new Error('invalid_assertions');
  if (!Array.isArray(value.expectedRejections)
    || value.expectedRejections.some(rejection => !isObject(rejection) || typeof rejection.kind !== 'string' || !rejection.kind || typeof rejection.reason !== 'string' || !rejection.reason)) throw new Error('invalid_rejections');
  if (!Array.isArray(value.executionErrors)
    || value.executionErrors.some(error => !isObject(error) || !FAILURE_OUTCOMES.includes(error.kind as P07Outcome) || typeof error.reason !== 'string' || !error.reason)) throw new Error('invalid_failure_history');
  if (!['command-output', 'runtime-usage', 'not_run'].includes(value.usageSource)) throw new Error('invalid_result');
  if (!isObject(value.cleanup) || !['pending', 'passed', 'failed', 'unknown'].includes(String(value.cleanup.status))
    || ['processStopped', 'factsExported', 'sqliteClosed', 'resourcesRemoved'].some(key => typeof value.cleanup[key as keyof P07CleanupFact] !== 'boolean')
    || (value.cleanup.retainedRoot !== null && typeof value.cleanup.retainedRoot !== 'string')) throw new Error('invalid_cleanup');

  if (value.status === 'pass') {
    if ((value.outcome !== 'success' && value.outcome !== 'expected_rejection') || value.exitCode !== 0 || value.command.length === 0
      || value.usageSource === 'not_run' || !confirmedCleanup(value.cleanup) || value.publicationError !== null) throw new Error('invalid_pass');
    if (value.expectation === 'expected_rejection' && value.expectedRejections.length === 0) throw new Error('invalid_pass');
    if (value.executionErrors.length > 0) throw new Error('invalid_failure_history');
  }
  if (value.status === 'not_run') {
    if (value.command.length !== 0 || value.exitCode !== null || value.durationMs !== 0 || value.outcome !== 'not_run'
      || value.evidenceRefs.length !== 0 || value.usageSource !== 'not_run' || value.publicationError !== null) throw new Error('invalid_not_run');
    if (value.executionErrors.length !== 0) throw new Error('invalid_failure_history');
  }
  if (value.status === 'fail') {
    if (typeof value.reason !== 'string' || !value.reason) throw new Error('missing_reason');
    if (value.executionErrors.length === 0 || FAILURE_OUTCOMES.includes(value.outcome as P07Outcome) === false) throw new Error('invalid_failure');
    const first = value.executionErrors[0]!;
    if (first.kind !== value.outcome || first.reason !== value.reason) throw new Error('invalid_failure_history');
  }
  if (value.status !== 'pass' && (typeof value.reason !== 'string' || !value.reason)) throw new Error('missing_reason');

  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const ref of value.evidenceRefs) {
    if (!isObject(ref) || !P07_FACT_CATEGORIES.includes(ref.category as P07FactCategory)
      || !shaPattern.test(String(ref.sha256)) || !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes <= 0) throw new Error('invalid_reference');
    if (ref.identity !== `${value.runId}/${slotOf(value)}/${ref.category}` || ref.path !== `${slotOf(value)}/${ref.category}.json`) throw new Error('identity_mismatch');
    if (identities.has(ref.identity) || paths.has(ref.path)) throw new Error('duplicate_evidence');
    identities.add(ref.identity);
    paths.add(ref.path);
  }
  if (value.status === 'pass' && value.evidenceRefs.length === 0) throw new Error('missing_category');
  safeP07Json(value);
}

/** 临时资源删除后的完整目录/内容核验；不做日志推断。 */
export function verifyP07Scenario(directory: string, record: P07ScenarioRecord, expected: P07EvidenceIdentity): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  try {
    noSymlinkAncestors(directory);
    validateP07Scenario(record, expected);
    const resultPath = evidencePath(directory, `${slotOf(record)}/result.json`);
    const resultBytes = readEvidenceFile(resultPath);
    if (hashP07Input(JSON.parse(resultBytes.toString('utf8'))) !== hashP07Input(record)) throw new Error('result_mismatch');
    for (const ref of record.evidenceRefs) {
      const path = evidencePath(directory, ref.path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size !== ref.sizeBytes) throw new Error('size_mismatch');
      const bytes = readEvidenceFile(path);
      if (hashP07Bytes(bytes) !== ref.sha256) throw new Error('hash_mismatch');
      const body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      safeP07Json(body);
      if (body.runId !== expected.runId || body.testedCommit !== expected.testedCommit || body.inputDigest !== expected.inputDigest
        || body.schemaVersion !== 1 || body.checkId !== record.checkId || body.attempt !== record.attempt
        || body.category !== ref.category) throw new Error('identity_mismatch');
      validateP07Facts(ref.category as P07FactCategory, body.facts, record);
    }
    if (record.status === 'pass' && !confirmedCleanup(record.cleanup)) throw new Error('cleanup_uncertain');
  } catch (error) {
    problems.push(safeError(error));
  }
  return { ok: problems.length === 0, problems };
}

/** 未执行检查是完整结构化 not_run 记录，不是空成功占位。 */
export function notRunP07Scenario(identity: P07EvidenceIdentity, checkId: string, reason: string): P07ScenarioRecord {
  assertP07Identity(identity);
  assertCheckId(checkId);
  if (typeof reason !== 'string' || !reason) throw new Error('missing_reason');
  const record: P07ScenarioRecord = {
    schemaVersion: 1, ...identity, checkId, attempt: 1,
    command: [], exitCode: null, durationMs: 0,
    expectation: 'success', outcome: 'not_run', status: 'not_run', reason,
    positiveAssertions: ['declared_not_run'], expectedRejections: [], executionErrors: [],
    evidenceRefs: [], usageSource: 'not_run',
    cleanup: { status: 'pending', processStopped: false, factsExported: false, sqliteClosed: false, resourcesRemoved: false, retainedRoot: null },
    publicationError: null,
  };
  validateP07Scenario(record, identity);
  return record;
}

/* ------------------------------------------------------------------ *
 * 采集：演练事实 → 类型化事实文件 → 不可变结果记录
 * ------------------------------------------------------------------ */

function drillSqliteFacts(drill: P07DrillEvidenceLike): P07SqliteFacts {
  const business = drill.business;
  const pairs: readonly [string, readonly unknown[]][] = [
    ['projects', business.projects], ['runs', business.runs], ['attempts', business.attempts],
    ['tasks', business.tasks], ['workspaces', business.workspaces], ['verificationBatches', business.verificationBatches],
  ];
  return {
    source: 'p07-5-drill-business-rows',
    tables: pairs.map(([name, rows]) => ({ name, rows, count: rows.length, digest: hashP07Input(rows) })),
  };
}

function drillGitFacts(drill: P07DrillEvidenceLike): P07GitFacts {
  if (drill.git.length === 0) throw new Error('invalid_drill_facts');
  return { repositories: drill.git.map(repo => ({ ...repo, statusEntries: [...repo.statusEntries] })) };
}

function drillProcessFacts(drill: P07DrillEvidenceLike): P07ProcessFacts {
  return { owned: true, descendantsChecked: true, processes: drill.processes.map(process_ => ({ ...process_, stopEscalated: [...process_.stopEscalated] })) };
}

function drillArtifactFacts(drill: P07DrillEvidenceLike): P07ArtifactFacts {
  return { artifacts: drill.artifacts.map(artifact => ({ ...artifact })) };
}

/** 采集 → 脱敏 → 类型化导出 → 重读核验；本身不删除任何资源。 */
export async function collectP07Scenario(options: P07ScenarioCollectOptions): Promise<P07ScenarioRecord> {
  const { identity, checkId, attempt, command, cleanup } = options;
  assertP07Identity(identity);
  assertCheckId(checkId);
  assertAttempt(attempt);
  hashP07Input(options.facts ?? null);

  if (!isObject(command) || typeof command.label !== 'string' || !command.label
    || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some(part => typeof part !== 'string' || !part || part.includes('\0'))
    || (command.exitCode !== null && (!Number.isSafeInteger(command.exitCode) || command.exitCode < 0))
    || (command.signal !== null && typeof command.signal !== 'string')
    || typeof command.timedOut !== 'boolean' || typeof command.cancelled !== 'boolean'
    || !Number.isSafeInteger(command.durationMs) || command.durationMs < 0
    || !Array.isArray(command.escalated) || command.escalated.some(step => typeof step !== 'string')
    || typeof command.stopConfirmed !== 'boolean') throw new Error('invalid_command');
  if (!Array.isArray(options.positiveAssertions) || options.positiveAssertions.length === 0
    || options.positiveAssertions.some(assertion => typeof assertion !== 'string' || !assertion)) throw new Error('invalid_assertions');
  if ((options.expectedRejections ?? []).some(rejection => !isObject(rejection) || typeof rejection.kind !== 'string' || !rejection.kind || typeof rejection.reason !== 'string' || !rejection.reason)) throw new Error('invalid_rejections');
  if (options.expectation === 'expected_rejection' && (options.expectedRejections ?? []).length === 0) throw new Error('invalid_rejections');
  if (!isObject(cleanup) || !['pending', 'passed', 'failed', 'unknown'].includes(String(cleanup.status))) throw new Error('invalid_cleanup');
  if (!isObject(options.usage.tools) || Object.keys(options.usage.tools).length === 0
    || Object.values(options.usage.tools).some(value => typeof value !== 'string' || !value)
    || (options.usage.source === 'runtime-usage' && options.usage.usage === undefined)) throw new Error('invalid_scenario_input');
  const sensitive = [...(options.sensitiveValues ?? []).filter(value => typeof value === 'string' && value !== '')];

  noSymlinkAncestors(options.directory);
  if (options.fixtureRoot !== undefined) {
    // 演练根可能已被清理；调用方在存活时传入真实路径，这里只做词法包含检查。
    const root = resolve(options.fixtureRoot);
    if (resolve(options.directory) === root || resolve(options.directory).startsWith(root + sep)) throw new Error('evidence_inside_cleanup_root');
  }
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(options.directory);
  /* attempt 是不可变发布槽：重试使用新 attempt，重跑使用新 runId。 */
  const slot = join(directory, slotOf({ checkId, attempt }));
  mkdirSync(slot, { mode: 0o700 });

  const derived: Partial<Record<P07OverrideFactCategory, unknown>> = {};
  if (options.drill !== undefined) {
    derived.sqlite = drillSqliteFacts(options.drill);
    derived.git = drillGitFacts(options.drill);
    derived.process = drillProcessFacts(options.drill);
    derived.artifact = drillArtifactFacts(options.drill);
    if (options.drill.budget !== null) derived.budget = { budget: { ...options.drill.budget } };
  }
  for (const category of P07_OVERRIDE_FACT_CATEGORIES) {
    if (category === 'usage') continue; // usage 始终来自 options.usage，不接受事实覆盖
    const override = (options.facts ?? {}) as Record<string, unknown>;
    if (override[category] !== undefined) derived[category] = override[category];
  }
  derived.usage = { source: options.usage.source, tools: { ...options.usage.tools }, usage: options.usage.usage ?? null };
  const factCategories = [...P07_OVERRIDE_FACT_CATEGORIES.filter(category => derived[category] !== undefined)];
  const manifestPaths = [
    ...factCategories.map(category => `${slotOf({ checkId, attempt })}/${category}.json`),
    `${slotOf({ checkId, attempt })}/command-exit.json`,
    `${slotOf({ checkId, attempt })}/cleanup.json`,
  ];

  let outcome: P07Outcome;
  if (command.cancelled) outcome = 'cancelled';
  else if (command.timedOut) outcome = 'timeout';
  else if (command.signal !== null || command.exitCode !== 0) outcome = 'nonzero_exit';
  else if (options.expectation === 'expected_rejection') outcome = 'expected_rejection';
  else outcome = 'success';
  const executionErrors: { kind: P07Outcome; reason: string }[] = [];
  let reason: string | null = outcome === 'success' || outcome === 'expected_rejection' ? null : outcome;
  if (FAILURE_OUTCOMES.includes(outcome)) executionErrors.push({ kind: outcome, reason: outcome });
  const failure = (kind: P07Outcome, detail: string): void => {
    executionErrors.push({ kind, reason: detail });
    if (outcome === 'success' || outcome === 'expected_rejection') { outcome = kind; reason = detail; }
  };

  const refs: P07EvidenceRef[] = [];
  let publicationError: P07ScenarioRecord['publicationError'] = null;
  const redact = (text: string): string => redactP07EvidenceText(text, sensitive, options.fixtureRoot);
  const safeValue = <T>(value: T): T => JSON.parse(redact(safeP07Json(value, sensitive))) as T;

  function exportFacts(category: P07FactCategory, facts: unknown): void {
    const relative = `${slotOf({ checkId, attempt })}/${category}.json`;
    const bytes = redact(safeP07Json({ schemaVersion: 1, ...identity, checkId, attempt, category, facts }, sensitive));
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('evidence_size_limit');
    const target = evidencePath(directory, relative);
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    const reference = { identity: `${identity.runId}/${slotOf({ checkId, attempt })}/${category}`, category, path: relative, sha256: hashP07Bytes(bytes), sizeBytes: Buffer.byteLength(bytes) };
    if (hashP07Bytes(readFileSync(target)) !== reference.sha256 || lstatSync(target).size !== reference.sizeBytes) throw new Error('export_verification_failed');
    refs.push(reference);
  }

  let record: P07ScenarioRecord;
  try {
    for (const category of P07_OVERRIDE_FACT_CATEGORIES) {
      if (derived[category] === undefined) continue;
      exportFacts(category, derived[category]);
    }
    exportFacts('command-exit', {
      commands: [command, ...(options.drill?.commands ?? []).map(entry => ({ ...entry, argv: [...entry.argv], escalated: [...entry.escalated] }))],
    });
    exportFacts('manifest', {
      capturedBeforeDeletion: true,
      source: options.drill !== undefined ? 'p07-5-drill-fixture' : 'explicit-facts',
      runIds: options.drill?.business.runs.map(run => run.runId) ?? [],
      evidenceFiles: manifestPaths,
      timings: { ...(options.drill?.timings ?? { collectMs: command.durationMs }) },
    });
    exportFacts('cleanup', { ...cleanup });
  } catch (error) {
    failure('capture_failed', safeError(error));
  }

  if (refs.length >= 3 && (outcome === 'success' || outcome === 'expected_rejection') && !confirmedCleanup(cleanup)) {
    failure('cleanup_uncertain', 'cleanup_uncertain');
  }

  record = safeValue({
    schemaVersion: 1, ...identity, checkId, attempt,
    command: [...command.argv], exitCode: command.exitCode, durationMs: command.durationMs,
    expectation: options.expectation, outcome,
    status: (outcome === 'success' || outcome === 'expected_rejection') && confirmedCleanup(cleanup) && executionErrors.length === 0 && refs.length >= 3 ? 'pass' : 'fail',
    reason, positiveAssertions: [...options.positiveAssertions],
    expectedRejections: (options.expectedRejections ?? []).map(rejection => ({ ...rejection })),
    executionErrors, evidenceRefs: refs,
    usageSource: options.usage.source, cleanup, publicationError,
  });

  try {
    const candidate: P07ScenarioRecord = record;
    validateP07Scenario(candidate, identity);
    for (const ref of candidate.evidenceRefs) {
      const body = JSON.parse(readEvidenceFile(evidencePath(directory, ref.path)).toString('utf8')) as Record<string, unknown>;
      validateP07Facts(ref.category as P07FactCategory, body.facts, candidate);
    }
    writeFileSync(join(slot, 'result.json'), safeP07Json(candidate, sensitive), { flag: 'wx', mode: 0o600 });
    if (!verifyP07Scenario(directory, candidate, identity).ok) throw new Error('result_verification_failed');
    record = candidate;
  } catch {
    publicationError = 'publication_failed';
    record = {
      ...record, status: 'fail', publicationError,
      outcome: outcome === 'success' || outcome === 'expected_rejection' ? 'publication_failed' : outcome,
      reason: record.reason ?? 'publication_failed',
      executionErrors: [...executionErrors, { kind: 'publication_failed', reason: 'publication_failed' }],
    };
  }
  return record;
}
