/**
 * P08-3 / F-001 存量 Todo 仓库夹具与基线快照（仅测试使用，不是产品实现）。
 *
 * 每次调用都在系统临时目录创建独立的真实 Git 仓库：
 * - 一次固定初始提交（固定内容、一次性注入身份与固定提交时间，跨调用可比）；
 * - 一个可执行的既有检查（退出码 0）和一个确定失败的检查（退出码 3）；
 * - tracked 未暂存、tracked 已暂存和 untracked 的预存改动；
 * - 仓库外的一份“无关旧状态文件”，由测试核对清理前后字节摘要不变。
 *
 * 快照只保存相对文件名、摘要、结构化检查结果和 not_run 范围，不保存开发机绝对
 * 路径、凭据或原始命令输出。夹具不创建、不读取 Nezha/Harness 业务数据库或元数据；
 * dispose() 只删除夹具自有的仓库目录，沙箱级清理由调用方显式执行。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWNFIELD_CHECK_REASONS,
  BROWNFIELD_CHECK_STATUSES,
  BROWNFIELD_REPO_IDENTITY_PATTERN,
  computeBrownfieldCheckCommandDigest,
  validateBrownfieldCheckDefinition,
  type BrownfieldCheckDefinition,
  type BrownfieldCheckReason,
  type BrownfieldCheckSnapshot,
  type BrownfieldCheckStatus,
} from '../../../packages/core/src/ports/brownfield.ts';
import { commitAll, git, initGitRepo } from '../git-repo.ts';
import { safeRemoveTempRoot } from '../safe-cleanup.ts';
import { createTempSandbox, type TempSandbox } from '../temp-sandbox.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_PREFIX = 'shiploop-p08-3-f001-';
const PROJECT_ID = 'legacy-todo-project';
const INITIAL_COMMIT_DATE = '2026-01-01T00:00:00Z';
const CHECK_ENVIRONMENT_IDENTITY = createHash('sha256')
  .update('shiploop:p08-3:legacy-todo-fixture-check-environment:v1', 'utf8')
  .digest('hex');

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const OFFICIAL_SKILL_PATH = /^\.(?:agents|claude)\/skills\/shiploop\/(?:SKILL\.md|references\/(?:project-init|providers|execution|diagnostics|cli|host)\.md)$/;
const SNAPSHOT_KEYS = [
  'schemaVersion', 'kind', 'repository', 'headCommit', 'headTree',
  'workingTree', 'files', 'checks', 'knownFailures', 'notRun',
] as const;
const OUTCOME_KEYS = ['status', 'reasonCode', 'exitCode', 'evidenceRefs', 'failureCaseIds'] as const;
const OUTPUT_KEYS = new Set(['stdout', 'stderr', 'output', 'rawoutput', 'modeloutput', 'transcript', 'messages']);
const CREDENTIAL_TEXT = /(?:bearer\s+[A-Za-z0-9._-]{4,}|sk-[A-Za-z0-9]|api[_-]?key\s*[:=]|access[_-]?token\s*[:=])/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

export const LEGACY_TODO_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const LEGACY_TODO_SNAPSHOT_KIND = 'shiploop.p08.legacy-todo-baseline' as const;
export const LEGACY_TODO_INITIAL_COMMIT_MESSAGE = 'fixture: initial legacy todo repository';

export type LegacyTodoDirtyState = 'modified_unstaged' | 'modified_staged' | 'untracked';

export interface LegacyTodoDirtyFile {
  readonly path: string;
  readonly state: LegacyTodoDirtyState;
  readonly digest: string;
}

export interface LegacyTodoFileSnapshot {
  readonly path: string;
  readonly digest: string;
}

export interface LegacyTodoKnownFailure {
  readonly checkKey: string;
  readonly reasonCode: BrownfieldCheckReason;
  readonly exitCode: number;
  readonly failureCaseIds: readonly string[];
}

export const LEGACY_TODO_NOT_RUN = [
  {
    id: 'real-sqlite-state',
    status: 'not_run',
    owner: 'phase-integration',
    reason: 'real_sqlite_state',
  },
  {
    id: 'real-host-lifecycle',
    status: 'not_run',
    owner: 'phase-integration',
    reason: 'real_host_lifecycle',
  },
  {
    id: 'real-process-control',
    status: 'not_run',
    owner: 'phase-integration',
    reason: 'real_process_control',
  },
  {
    id: 'cross-layer-lifecycle',
    status: 'not_run',
    owner: 'phase-integration',
    reason: 'cross_layer_lifecycle',
  },
] as const;

export type LegacyTodoNotRun = (typeof LEGACY_TODO_NOT_RUN)[number];

export interface LegacyTodoBaselineSnapshot {
  readonly schemaVersion: typeof LEGACY_TODO_SNAPSHOT_SCHEMA_VERSION;
  readonly kind: typeof LEGACY_TODO_SNAPSHOT_KIND;
  readonly repository: {
    readonly kind: 'non-nezha';
    readonly projectId: string;
    readonly repoIdentity: string;
    readonly pathDigest: string;
    readonly initialCommitMessage: string;
  };
  readonly headCommit: string;
  readonly headTree: string;
  readonly workingTree: {
    readonly statusPorcelain: string;
    readonly hasUncommittedChanges: true;
    readonly dirtyFiles: readonly LegacyTodoDirtyFile[];
  };
  readonly files: readonly LegacyTodoFileSnapshot[];
  readonly checks: readonly BrownfieldCheckSnapshot[];
  readonly knownFailures: readonly LegacyTodoKnownFailure[];
  readonly notRun: readonly LegacyTodoNotRun[];
}

export class LegacyTodoSnapshotError extends Error {
  readonly reason: string;
  readonly field: string;

  constructor(reason: string, field: string) {
    super(`legacy todo baseline snapshot rejected: ${field} (${reason})`);
    this.name = 'LegacyTodoSnapshotError';
    this.reason = reason;
    this.field = field;
  }
}

function fail(reason: string, field: string): never {
  throw new LegacyTodoSnapshotError(reason, field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('snapshot_shape_invalid', field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('snapshot_shape_invalid', field);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedSet.has(key));
  if (unknown !== undefined) fail('snapshot_field_invalid', `${field}.${unknown}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('snapshot_text_invalid', field);
  return value;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('snapshot_shape_invalid', field);
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('snapshot_digest_invalid', field);
  return value;
}

function gitSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) fail('snapshot_git_identity_invalid', field);
  return value;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('snapshot_identifier_invalid', field);
  return value;
}

function safePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || (!SAFE_PATH.test(value) && !OFFICIAL_SKILL_PATH.test(value))) fail('snapshot_path_invalid', field);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 快照中任何字符串都不允许携带开发机绝对路径或凭据；也不允许出现原始输出字段。
 * 这是脱敏边界，不是通用日志过滤器。
 */
function assertNoSensitiveContent(value: unknown, field: string): void {
  if (typeof value === 'string') {
    if (isAbsolute(value) || WINDOWS_ABSOLUTE.test(value) || value.startsWith('file://')) {
      fail('absolute_path', field);
    }
    if (CREDENTIAL_TEXT.test(value)) fail('credential_text', field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSensitiveContent(child, `${field}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (OUTPUT_KEYS.has(key.toLowerCase())) fail('model_or_command_output', `${field}.${key}`);
      assertNoSensitiveContent(child, `${field}.${key}`);
    }
  }
}

function validateCheckResult(value: unknown, field: string): {
  readonly status: BrownfieldCheckStatus;
  readonly reasonCode?: BrownfieldCheckReason;
  readonly exitCode?: number;
  readonly evidenceRefs: readonly string[];
  readonly failureCaseIds?: readonly string[];
} {
  const result = object(value, field);
  exactKeys(result, OUTCOME_KEYS, field);
  if (typeof result.status !== 'string' || !(BROWNFIELD_CHECK_STATUSES as readonly string[]).includes(result.status)) {
    fail('check_result_invalid', `${field}.status`);
  }
  const status = result.status as BrownfieldCheckStatus;
  let reasonCode: BrownfieldCheckReason | undefined;
  if (result.reasonCode !== undefined) {
    if (typeof result.reasonCode !== 'string' || !(BROWNFIELD_CHECK_REASONS as readonly string[]).includes(result.reasonCode)) {
      fail('check_result_invalid', `${field}.reasonCode`);
    }
    reasonCode = result.reasonCode as BrownfieldCheckReason;
  }
  let exitCode: number | undefined;
  if (result.exitCode !== undefined) {
    if (!Number.isSafeInteger(result.exitCode) || (result.exitCode as number) < 0) {
      fail('check_result_invalid', `${field}.exitCode`);
    }
    exitCode = result.exitCode as number;
  }
  if (status === 'passed' && exitCode !== 0) fail('check_result_invalid', `${field}.exitCode`);
  if (status === 'failed' && (reasonCode !== 'non_zero_exit' || exitCode === undefined || exitCode === 0)) {
    fail('check_result_invalid', `${field}.reasonCode`);
  }
  const evidenceRefs = array(result.evidenceRefs, `${field}.evidenceRefs`)
    .map((entry, index) => safePath(entry, `${field}.evidenceRefs[${index}]`));
  let failureCaseIds: readonly string[] | undefined;
  if (result.failureCaseIds !== undefined) {
    failureCaseIds = array(result.failureCaseIds, `${field}.failureCaseIds`)
      .map((entry, index) => text(entry, `${field}.failureCaseIds[${index}]`));
  }
  return {
    status,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(exitCode === undefined ? {} : { exitCode }),
    evidenceRefs,
    ...(failureCaseIds === undefined ? {} : { failureCaseIds }),
  };
}

export function validateLegacyTodoBaselineSnapshot(input: unknown): LegacyTodoBaselineSnapshot {
  const snapshot = object(input, 'snapshot');
  assertNoSensitiveContent(snapshot, 'snapshot');
  exactKeys(snapshot, SNAPSHOT_KEYS, 'snapshot');
  if (snapshot.schemaVersion !== LEGACY_TODO_SNAPSHOT_SCHEMA_VERSION) fail('schema_version_invalid', 'schemaVersion');
  if (snapshot.kind !== LEGACY_TODO_SNAPSHOT_KIND) fail('snapshot_kind_invalid', 'kind');

  const repository = object(snapshot.repository, 'repository');
  exactKeys(repository, ['kind', 'projectId', 'repoIdentity', 'pathDigest', 'initialCommitMessage'], 'repository');
  if (repository.kind !== 'non-nezha') fail('repository_kind_invalid', 'repository.kind');
  safeId(repository.projectId, 'repository.projectId');
  if (typeof repository.repoIdentity !== 'string' || !BROWNFIELD_REPO_IDENTITY_PATTERN.test(repository.repoIdentity)) {
    fail('repository_identity_invalid', 'repository.repoIdentity');
  }
  digest(repository.pathDigest, 'repository.pathDigest');
  text(repository.initialCommitMessage, 'repository.initialCommitMessage');

  gitSha(snapshot.headCommit, 'headCommit');
  gitSha(snapshot.headTree, 'headTree');

  const workingTree = object(snapshot.workingTree, 'workingTree');
  exactKeys(workingTree, ['statusPorcelain', 'hasUncommittedChanges', 'dirtyFiles'], 'workingTree');
  const statusPorcelain = text(workingTree.statusPorcelain, 'workingTree.statusPorcelain');
  if (workingTree.hasUncommittedChanges !== true) fail('working_tree_clean', 'workingTree.hasUncommittedChanges');
  const dirtyEntries = array(workingTree.dirtyFiles, 'workingTree.dirtyFiles');
  if (dirtyEntries.length === 0) fail('dirty_file_missing', 'workingTree.dirtyFiles');
  const dirtyFiles = dirtyEntries.map((entry, index) => {
    const field = `workingTree.dirtyFiles[${index}]`;
    const file = object(entry, field);
    exactKeys(file, ['path', 'state', 'digest'], field);
    safePath(file.path, `${field}.path`);
    if (!['modified_unstaged', 'modified_staged', 'untracked'].includes(file.state as string)) {
      fail('dirty_file_state_invalid', `${field}.state`);
    }
    digest(file.digest, `${field}.digest`);
    if (!statusPorcelain.includes(file.path as string)) {
      fail('dirty_file_not_in_status', `${field}.path`);
    }
    return { path: file.path as string, state: file.state as LegacyTodoDirtyState, digest: file.digest as string };
  });
  if (!dirtyFiles.some(file => file.state !== 'untracked')) fail('tracked_dirty_file_missing', 'workingTree.dirtyFiles');
  if (!dirtyFiles.some(file => file.state === 'untracked')) fail('untracked_dirty_file_missing', 'workingTree.dirtyFiles');

  const fileEntries = array(snapshot.files, 'files');
  if (fileEntries.length === 0) fail('files_missing', 'files');
  const files = new Map<string, string>();
  fileEntries.forEach((entry, index) => {
    const field = `files[${index}]`;
    const file = object(entry, field);
    exactKeys(file, ['path', 'digest'], field);
    const path = safePath(file.path, `${field}.path`);
    const fileDigest = digest(file.digest, `${field}.digest`);
    if (files.has(path)) fail('file_snapshot_duplicate', `${field}.path`);
    files.set(path, fileDigest);
  });
  for (const file of dirtyFiles) {
    if (!files.has(file.path)) fail('dirty_file_snapshot_missing', `files.${file.path}`);
    if (files.get(file.path) !== file.digest) fail('dirty_file_digest_mismatch', `files.${file.path}`);
  }

  const checkEntries = array(snapshot.checks, 'checks');
  const checks = checkEntries.map((entry, index) => {
    const field = `checks[${index}]`;
    const check = object(entry, field);
    exactKeys(check, ['check', 'commandDigest', 'result'], field);
    let definition: BrownfieldCheckDefinition;
    try {
      definition = validateBrownfieldCheckDefinition(check.check, 'p08-3.fixture.snapshot', `${field}.check`);
    } catch {
      return fail('check_definition_invalid', `${field}.check`);
    }
    const commandDigest = digest(check.commandDigest, `${field}.commandDigest`);
    if (computeBrownfieldCheckCommandDigest(definition) !== commandDigest) {
      fail('check_command_digest_mismatch', `${field}.commandDigest`);
    }
    return {
      check: definition,
      commandDigest,
      result: validateCheckResult(check.result, `${field}.result`),
    } satisfies BrownfieldCheckSnapshot;
  });
  if (!checks.some(check => check.result.status === 'passed')) fail('check_coverage_invalid', 'checks.passed');

  const knownEntries = array(snapshot.knownFailures, 'knownFailures');
  if (knownEntries.length === 0) fail('known_failure_missing', 'knownFailures');
  const knownFailures = knownEntries.map((entry, index) => {
    const field = `knownFailures[${index}]`;
    const failure = object(entry, field);
    exactKeys(failure, ['checkKey', 'reasonCode', 'exitCode', 'failureCaseIds'], field);
    const checkKey = safeId(failure.checkKey, `${field}.checkKey`);
    if (failure.reasonCode !== 'non_zero_exit') fail('known_failure_invalid', `${field}.reasonCode`);
    if (!Number.isSafeInteger(failure.exitCode) || (failure.exitCode as number) <= 0) {
      fail('known_failure_invalid', `${field}.exitCode`);
    }
    const failureCaseIds = array(failure.failureCaseIds, `${field}.failureCaseIds`)
      .map((caseId, caseIndex) => text(caseId, `${field}.failureCaseIds[${caseIndex}]`));
    const check = checks.find(candidate => candidate.check.checkKey === checkKey);
    if (
      check === undefined
      || check.result.status !== 'failed'
      || check.result.reasonCode !== failure.reasonCode
      || check.result.exitCode !== failure.exitCode
      || stableJson(check.result.failureCaseIds ?? []) !== stableJson(failureCaseIds)
    ) {
      fail('known_failure_check_mismatch', field);
    }
    return {
      checkKey,
      reasonCode: 'non_zero_exit' as const,
      exitCode: failure.exitCode as number,
      failureCaseIds,
    };
  });
  const failedChecks = checks.filter(check => check.result.status === 'failed');
  if (failedChecks.length !== knownFailures.length) fail('known_failure_check_mismatch', 'knownFailures.coverage');

  const notRun = array(snapshot.notRun, 'notRun');
  if (stableJson(notRun) !== stableJson(LEGACY_TODO_NOT_RUN)) fail('not_run_scope_invalid', 'notRun');

  return input as LegacyTodoBaselineSnapshot;
}

export interface LegacyTodoCleanupFacts {
  readonly status: 'passed' | 'failed';
  readonly ownedRootRemoved: boolean;
  readonly unrelatedState: {
    readonly digestBefore: string;
    readonly digestAfter: string | null;
    readonly preserved: boolean;
  };
  readonly reasons: readonly string[];
}

export interface LegacyTodoStateIsolation {
  readonly status: 'isolated' | 'violated';
  readonly databaseFiles: readonly string[];
  readonly harnessMetadataPaths: readonly string[];
  readonly repositoryInsideSandbox: boolean;
}

export interface LegacyTodoFixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly unrelatedStatePath: string;
  readonly projectId: string;
  readonly existingCheckPath: string;
  readonly dirtyTrackedPath: string;
  readonly stagedPath: string;
  readonly untrackedPath: string;
  snapshot(): LegacyTodoBaselineSnapshot;
  runKnownFailure(): LegacyTodoKnownFailure;
  dirtyFileDigests(): readonly { readonly path: string; readonly digest: string }[];
  stateIsolation(): LegacyTodoStateIsolation;
  dispose(): LegacyTodoCleanupFacts;
  cleanupSandbox(): void;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(path: string): string {
  return sha256(readFileSync(path));
}

function checkEnvironment(): Record<string, string> {
  return { PATH: process.env.PATH ?? '', LC_ALL: 'C' };
}

function checkDefinition(checkKey: string, argv: readonly string[], timeoutMs = 10_000): BrownfieldCheckDefinition {
  return {
    checkKey,
    argv: [...argv],
    environmentIdentity: CHECK_ENVIRONMENT_IDENTITY,
    timeoutMs,
    required: true,
  };
}

const EXISTING_CHECK = checkDefinition('existing-check', ['node', 'checks/existing-check.mjs']);
const KNOWN_FAILURE_CHECK = checkDefinition('known-failure', ['node', 'checks/known-failure.mjs']);

function runCheck(definition: BrownfieldCheckDefinition, repositoryPath: string): BrownfieldCheckSnapshot {
  const evidenceRef = `checks/${definition.checkKey}.json`;
  try {
    execFileSync(definition.argv[0]!, definition.argv.slice(1), {
      cwd: repositoryPath,
      env: checkEnvironment(),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: definition.timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return {
      check: definition,
      commandDigest: computeBrownfieldCheckCommandDigest(definition),
      result: { status: 'passed', exitCode: 0, evidenceRefs: [evidenceRef] },
    };
  } catch (error) {
    const failure = error as { readonly status?: number | null; readonly code?: string };
    const exitCode = typeof failure.status === 'number' ? failure.status : null;
    if (failure.code === 'ETIMEDOUT') {
      return {
        check: definition,
        commandDigest: computeBrownfieldCheckCommandDigest(definition),
        result: { status: 'error', reasonCode: 'timed_out', evidenceRefs: [evidenceRef] },
      };
    }
    if (exitCode !== null && exitCode !== 0) {
      return {
        check: definition,
        commandDigest: computeBrownfieldCheckCommandDigest(definition),
        result: {
          status: 'failed',
          reasonCode: 'non_zero_exit',
          exitCode,
          evidenceRefs: [evidenceRef],
          failureCaseIds: [`case:${definition.checkKey}-exit-${exitCode}`],
        },
      };
    }
    return {
      check: definition,
      commandDigest: computeBrownfieldCheckCommandDigest(definition),
      result: { status: 'error', reasonCode: 'spawn_failed', evidenceRefs: [evidenceRef] },
    };
  }
}

function dirtyState(index: string): LegacyTodoDirtyState {
  if (index === '?') return 'untracked';
  if (index !== ' ') return 'modified_staged';
  return 'modified_unstaged';
}

function readDirtyFiles(repositoryPath: string): readonly LegacyTodoDirtyFile[] {
  const porcelain = git(['status', '--porcelain', '--untracked-files=all'], repositoryPath);
  return porcelain
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const path = line.slice(3).trim();
      return { path, state: dirtyState(line[0] ?? ' '), digest: fileDigest(join(repositoryPath, path)) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function listFiles(repositoryPath: string): readonly string[] {
  const tracked = git(['ls-files'], repositoryPath).split('\n').filter(Boolean);
  const dirty = readDirtyFiles(repositoryPath).map(file => file.path);
  return [...new Set([...tracked, ...dirty])].sort((left, right) => left.localeCompare(right));
}

function scanBusinessState(repositoryPath: string): { databaseFiles: string[]; harnessMetadataPaths: string[] } {
  const databaseFiles: string[] = [];
  const harnessMetadataPaths: string[] = [];
  const harnessNames = new Set([
    'feature.yaml',
    'task_list.json',
    'task_list.candidate.json',
    'progress.md',
    'exec-plan.md',
    'execution-report.md',
    'phase.yaml',
  ]);
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['state', 'workspace', 'sessions'].includes(entry.name)) harnessMetadataPaths.push(relativePath);
        if (entry.name !== '.git') walk(absolutePath, relativePath);
        continue;
      }
      if (/(?:\.sqlite3?|\.db)(?:-(?:wal|shm))?$/.test(entry.name)) databaseFiles.push(relativePath);
      if (harnessNames.has(entry.name)) harnessMetadataPaths.push(relativePath);
    }
  };
  walk(repositoryPath, '');
  return {
    databaseFiles: databaseFiles.sort((left, right) => left.localeCompare(right)),
    harnessMetadataPaths: harnessMetadataPaths.sort((left, right) => left.localeCompare(right)),
  };
}

export function createLegacyTodoFixture(options: { readonly prefix?: string } = {}): LegacyTodoFixture {
  const sandbox: TempSandbox = createTempSandbox(options.prefix ?? DEFAULT_PREFIX, {
    outside: [REPO_ROOT, homedir()],
  });
  const root = sandbox.path;
  const repositoryPath = join(root, 'repository');
  const unrelatedStateDirectory = join(root, 'unrelated-state');
  const unrelatedStatePath = join(unrelatedStateDirectory, 'legacy-tool-state.json');

  mkdirSync(unrelatedStateDirectory, { recursive: true });
  writeFileSync(
    unrelatedStatePath,
    `${JSON.stringify({ tool: 'legacy-todo-tool', stateVersion: 1, items: ['pre-existing'] }, null, 2)}\n`,
    'utf8',
  );
  const unrelatedDigestBefore = fileDigest(unrelatedStatePath);

  initGitRepo(repositoryPath);
  mkdirSync(join(repositoryPath, 'src'), { recursive: true });
  mkdirSync(join(repositoryPath, 'checks'), { recursive: true });
  mkdirSync(join(repositoryPath, 'docs'), { recursive: true });
  mkdirSync(join(repositoryPath, 'notes'), { recursive: true });

  writeFileSync(join(repositoryPath, 'README.md'), '# Legacy Todo\n\nA small pre-existing todo repository.\n', 'utf8');
  writeFileSync(
    join(repositoryPath, 'src/todo.mjs'),
    "export const todos = ['write baseline snapshot'];\nexport function listTodos() { return [...todos]; }\n",
    'utf8',
  );
  writeFileSync(join(repositoryPath, 'docs/notes.md'), '# Legacy todo notes\n', 'utf8');
  const existingCheckPath = join(repositoryPath, 'checks/existing-check.mjs');
  writeFileSync(
    existingCheckPath,
    [
      '#!/usr/bin/env node',
      "const todos = ['write baseline snapshot', 'preserve dirty files'];",
      'if (todos.length !== 2) process.exit(1);',
      "process.stdout.write('legacy todo check: ok\\n');",
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(existingCheckPath, 0o755);
  const knownFailurePath = join(repositoryPath, 'checks/known-failure.mjs');
  writeFileSync(
    knownFailurePath,
    [
      '#!/usr/bin/env node',
      "process.stderr.write('legacy todo known failure: archive flag missing\\n');",
      'process.exit(3);',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(knownFailurePath, 0o755);

  commitAll(repositoryPath, LEGACY_TODO_INITIAL_COMMIT_MESSAGE, {
    env: {
      GIT_AUTHOR_DATE: INITIAL_COMMIT_DATE,
      GIT_COMMITTER_DATE: INITIAL_COMMIT_DATE,
    },
  });

  const dirtyTrackedPath = join(repositoryPath, 'src/todo.mjs');
  const stagedPath = join(repositoryPath, 'docs/notes.md');
  const untrackedPath = join(repositoryPath, 'notes/user-scratch.md');
  writeFileSync(
    dirtyTrackedPath,
    "export const todos = ['write baseline snapshot'];\nexport function listTodos() { return [...todos]; }\n// local work in progress (must be preserved)\n",
    'utf8',
  );
  writeFileSync(stagedPath, '# Legacy todo notes\nlocal staged note (must be preserved)\n', 'utf8');
  writeFileSync(untrackedPath, 'user scratch note; keep this file.\n', 'utf8');
  git(['add', '--', 'docs/notes.md'], repositoryPath);

  let cleanupFacts: LegacyTodoCleanupFacts | undefined;

  const runKnownFailure = (): LegacyTodoKnownFailure => {
    const snapshot = runCheck(KNOWN_FAILURE_CHECK, repositoryPath);
    if (snapshot.result.status !== 'failed' || snapshot.result.exitCode === undefined) {
      throw new Error('legacy todo fixture known failure check did not fail as expected');
    }
    return {
      checkKey: KNOWN_FAILURE_CHECK.checkKey,
      reasonCode: 'non_zero_exit',
      exitCode: snapshot.result.exitCode,
      failureCaseIds: snapshot.result.failureCaseIds ?? [],
    };
  };

  return {
    root,
    repositoryPath,
    unrelatedStatePath,
    projectId: PROJECT_ID,
    existingCheckPath,
    dirtyTrackedPath,
    stagedPath,
    untrackedPath,
    snapshot(): LegacyTodoBaselineSnapshot {
      const statusPorcelain = git(['status', '--porcelain', '--untracked-files=all'], repositoryPath);
      const dirtyFiles = readDirtyFiles(repositoryPath);
      const files = listFiles(repositoryPath).map(path => ({ path, digest: fileDigest(join(repositoryPath, path)) }));
      const checks = [runCheck(EXISTING_CHECK, repositoryPath), runCheck(KNOWN_FAILURE_CHECK, repositoryPath)];
      const knownFailure = checks[1]!;
      const snapshotCandidate = {
        schemaVersion: LEGACY_TODO_SNAPSHOT_SCHEMA_VERSION,
        kind: LEGACY_TODO_SNAPSHOT_KIND,
        repository: {
          kind: 'non-nezha' as const,
          projectId: PROJECT_ID,
          repoIdentity: `gitdir-sha256:${sha256(realpathSync(join(repositoryPath, '.git')))}`,
          pathDigest: sha256(realpathSync(repositoryPath)),
          initialCommitMessage: LEGACY_TODO_INITIAL_COMMIT_MESSAGE,
        },
        headCommit: git(['rev-parse', 'HEAD'], repositoryPath).trim(),
        headTree: git(['rev-parse', 'HEAD^{tree}'], repositoryPath).trim(),
        workingTree: {
          statusPorcelain,
          hasUncommittedChanges: true as const,
          dirtyFiles,
        },
        files,
        checks,
        knownFailures: [{
          checkKey: knownFailure.check.checkKey,
          reasonCode: 'non_zero_exit' as const,
          exitCode: knownFailure.result.exitCode!,
          failureCaseIds: knownFailure.result.failureCaseIds ?? [],
        }],
        notRun: LEGACY_TODO_NOT_RUN,
      };
      return validateLegacyTodoBaselineSnapshot(snapshotCandidate);
    },
    runKnownFailure,
    dirtyFileDigests(): readonly { readonly path: string; readonly digest: string }[] {
      return readDirtyFiles(repositoryPath).map(file => ({ path: file.path, digest: file.digest }));
    },
    stateIsolation(): LegacyTodoStateIsolation {
      const scan = scanBusinessState(repositoryPath);
      const inside = relative(root, repositoryPath);
      const repositoryInsideSandbox = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) && !inside.startsWith(sep);
      return {
        status: scan.databaseFiles.length === 0 && scan.harnessMetadataPaths.length === 0 && repositoryInsideSandbox
          ? 'isolated'
          : 'violated',
        databaseFiles: scan.databaseFiles,
        harnessMetadataPaths: scan.harnessMetadataPaths,
        repositoryInsideSandbox,
      };
    },
    dispose(): LegacyTodoCleanupFacts {
      if (cleanupFacts !== undefined) return cleanupFacts;
      const reasons: string[] = [];
      let ownedRootRemoved = false;
      try {
        safeRemoveTempRoot(repositoryPath, {
          authorizedRoot: root,
          protectedPaths: [REPO_ROOT, homedir(), unrelatedStateDirectory],
        });
        ownedRootRemoved = !existsSync(repositoryPath);
        if (!ownedRootRemoved) reasons.push('owned_root_still_exists');
      } catch (error) {
        reasons.push(`cleanup_failed:${error instanceof Error ? error.message : String(error)}`);
      }
      const digestAfter = existsSync(unrelatedStatePath) ? fileDigest(unrelatedStatePath) : null;
      const preserved = digestAfter === unrelatedDigestBefore;
      if (!preserved) reasons.push('unrelated_state_changed');
      cleanupFacts = {
        status: reasons.length === 0 ? 'passed' : 'failed',
        ownedRootRemoved,
        unrelatedState: { digestBefore: unrelatedDigestBefore, digestAfter, preserved },
        reasons,
      };
      return cleanupFacts;
    },
    cleanupSandbox(): void {
      sandbox.cleanup();
    },
  };
}
