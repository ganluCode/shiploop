/**
 * F-002 P02-4 证据快照工具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 为 P02-4 验收场景与报告导出提供结构化事实（§2.1 关键证据字段）：
 * - snapshotRepository：规范仓库身份（realpath + 真实 Git 顶层）、HEAD、Git 状态
 *   原文、tracked/untracked 文件内容摘要与工作树汇总摘要（真实 git 进程 + 真实字节）；
 * - extractHostIdentity：非秘密 Host 身份（hostInstanceId / dataRootIdentity /
 *   生命周期 / 监听），只按白名单取字段，绝不携带 token 或认证头；
 * - extractOperationSnapshot：操作/逐项检查状态、代码身份与输出制品引用；
 * - artifactContentDigest：输出制品正文摘要（sha256 + 字节数）；
 * - exportEvidenceDocument：稳定序列化（递归排序键）的报告导出文本；
 * - scanForCredentialShapes：凭据形状扫描（键名/Bearer 形态），供脱敏断言；
 * - openDataRootStorageProbe：受控只读数据库探针（p02-2 复用，只允许 SELECT/WITH）。
 *
 * 安全约束：只读文件系统与只读 SQLite；不插入或修改业务状态、不读凭据、不联网、
 * 不调用模型；git 子进程经 helpers/git-repo 的隔离环境运行，不读真实用户配置。
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DATABASE_FILE_NAME } from '../../../packages/core/src/ports/path-service.ts';
import { git } from '../git-repo.ts';
import { openStorageProbe, type StorageProbe } from '../p02-2/storage-probe.ts';
import { digestWorkingTree } from '../p02-3/process-tools.ts';

/* ------------------------------------------------------------------ *
 * 仓库快照（规范身份 / HEAD / Git 状态 / tracked+untracked 摘要）
 * ------------------------------------------------------------------ */

export interface FileContentDigest {
  readonly relativePath: string;
  /** 文件真实字节 sha256（小写十六进制）；工作区缺失文件为 null。 */
  readonly digest: string | null;
  readonly sizeBytes: number;
}

export interface RepositorySnapshot {
  /** 规范仓库身份：realpath 后的仓库目录。 */
  readonly canonicalPath: string;
  /** 真实 Git 顶层（`rev-parse --show-toplevel` 规范化后）。 */
  readonly gitTopLevel: string;
  /** HEAD 提交（40 hex）；无初始 commit 为 null（不猜分支）。 */
  readonly headCommit: string | null;
  /** 当前分支名；无 commit/游离头为原始输出或 null。 */
  readonly branch: string | null;
  /** `git status --porcelain` 原文（供「Git 状态一致」断言）。 */
  readonly statusPorcelain: string;
  readonly tracked: readonly FileContentDigest[];
  readonly untracked: readonly FileContentDigest[];
  /** 工作树汇总摘要（p02-3 process-tools 同一算法，排除 .git 等目录）。 */
  readonly treeDigest: string;
}

export interface SnapshotRepositoryOptions {
  /** git 子进程隔离 HOME（夹具沙箱 HOME；不提供则不读任何 HOME 配置）。 */
  readonly homeDir?: string;
}

function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fileDigestAt(root: string, relativePath: string): FileContentDigest {
  try {
    const content = readFileSync(join(root, ...relativePath.split('/')));
    return { relativePath, digest: sha256Hex(content), sizeBytes: content.length };
  } catch {
    return { relativePath, digest: null, sizeBytes: -1 };
  }
}

function gitList(repoPath: string, args: readonly string[], options: SnapshotRepositoryOptions): string[] {
  const output = git([...args, '-z'], repoPath, options.homeDir !== undefined ? { home: options.homeDir } : {});
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** 取得仓库快照（纯只读；真实 git 进程 + 文件字节摘要）。 */
export function snapshotRepository(
  repoPath: string,
  options: SnapshotRepositoryOptions = {},
): RepositorySnapshot {
  const runOptions = options.homeDir !== undefined ? { home: options.homeDir } : {};
  const canonicalPath = realpathSync(repoPath);
  const gitTopLevel = realpathSync(git(['rev-parse', '--show-toplevel'], repoPath, runOptions).trim());
  let headCommit: string | null;
  try {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], repoPath, runOptions).trim();
    headCommit = head.length > 0 ? head : null;
  } catch {
    headCommit = null; // 无初始 commit：不猜分支。
  }
  let branch: string | null = null;
  if (headCommit !== null) {
    try {
      branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, runOptions).trim() || null;
    } catch {
      branch = null;
    }
  }
  const statusPorcelain = git(['status', '--porcelain'], repoPath, runOptions);
  const tracked = gitList(repoPath, ['ls-files'], options).map((path) => fileDigestAt(gitTopLevel, path));
  const untracked = gitList(repoPath, ['ls-files', '--others', '--exclude-standard'], options).map((path) =>
    fileDigestAt(gitTopLevel, path),
  );
  return {
    canonicalPath,
    gitTopLevel,
    headCommit,
    branch,
    statusPorcelain,
    tracked,
    untracked,
    treeDigest: digestWorkingTree(gitTopLevel).digest,
  };
}

/* ------------------------------------------------------------------ *
 * 非秘密 Host 身份（白名单取字段；凭据形状扫描）
 * ------------------------------------------------------------------ */

export interface HostIdentitySnapshot {
  readonly hostInstanceId: string;
  readonly dataRootIdentity: string;
  readonly lifecycleState: string | null;
  readonly pid: number | null;
  readonly listenAddress: string | null;
  readonly port: number | null;
  readonly protocolVersion: number | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 从 host.start / host.status 的结构化 result 提取非秘密身份。
 * 只按白名单取字段：token / 认证头 / 任何凭据形状都不会进入快照。
 */
export function extractHostIdentity(result: Record<string, unknown>): HostIdentitySnapshot {
  const hostInstanceId = result.hostInstanceId;
  const dataRootIdentity = result.dataRootIdentity;
  if (typeof hostInstanceId !== 'string' || hostInstanceId.length === 0) {
    throw new TypeError('extractHostIdentity: 缺少 hostInstanceId（无法建立 Host 身份）');
  }
  if (typeof dataRootIdentity !== 'string' || dataRootIdentity.length === 0) {
    throw new TypeError('extractHostIdentity: 缺少 dataRootIdentity（无法建立数据根身份）');
  }
  return {
    hostInstanceId,
    dataRootIdentity,
    lifecycleState: optionalString(result.lifecycleState),
    pid: optionalNumber(result.pid),
    listenAddress: optionalString(result.listenAddress),
    port: optionalNumber(result.port),
    protocolVersion: optionalNumber(result.protocolVersion),
  };
}

/** 凭据形状键名（token/认证/密码/秘密/凭据/cookie）。 */
export const CREDENTIAL_KEY_PATTERN = /^(auth|token|authorization|password|secret|credential|cookie)s?$/i;

const BEARER_VALUE_PATTERN = /Bearer\s+\S+/i;

/**
 * 递归扫描结构（键名 + 字符串值），返回凭据形状命中位置（无命中为空数组）。
 * 用于报告/证据导出的脱敏断言；64-hex 数据根身份等合法字段不受影响。
 */
export function scanForCredentialShapes(value: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      hits.push(...scanForCredentialShapes(entry, `${path}[${index}]`));
    });
    return hits;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        hits.push(`${path}.${key}`);
        continue;
      }
      hits.push(...scanForCredentialShapes(entry, `${path}.${key}`));
    }
    return hits;
  }
  if (typeof value === 'string' && BEARER_VALUE_PATTERN.test(value)) {
    hits.push(`${path} (Bearer 形状)`);
  }
  return hits;
}

/** 凭据形状命中即抛错（fail-closed）；导出前调用。 */
export function assertNoCredentialShapes(value: unknown): void {
  const hits = scanForCredentialShapes(value);
  if (hits.length > 0) {
    throw new Error(`证据文本出现凭据形状，拒绝导出：${hits.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ *
 * 操作 / 检查状态与输出制品摘要
 * ------------------------------------------------------------------ */

export interface OperationCheckOutputSnapshot {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly truncated: boolean;
}

export interface OperationCheckSnapshot {
  readonly checkKey: string | null;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly output: OperationCheckOutputSnapshot | null;
}

export interface OperationSnapshot {
  readonly operationId: string;
  readonly status: string | null;
  readonly state: string | null;
  readonly codeIdentity: {
    readonly headCommit: string | null;
    readonly workingTreeDigest: string | null;
    readonly hasUncommittedChanges: boolean | null;
  };
  readonly checks: readonly OperationCheckSnapshot[];
}

function extractCheckOutput(raw: unknown): OperationCheckOutputSnapshot | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const output = raw as Record<string, unknown>;
  const artifactId = output.artifactId;
  if (typeof artifactId !== 'string') {
    return null;
  }
  return {
    artifactId,
    byteSize: optionalNumber(output.byteSize) ?? -1,
    truncated: output.truncated === true,
  };
}

/**
 * 从 baseline run / baseline status 的结构化 result 提取操作与逐项检查状态
 * （含代码身份与输出制品引用）。只读入参，不做任何 I/O。
 */
export function extractOperationSnapshot(result: Record<string, unknown>): OperationSnapshot {
  const operationId = result.operationId;
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new TypeError('extractOperationSnapshot: 缺少 operationId');
  }
  const identityRaw = result.codeIdentity;
  const identity =
    typeof identityRaw === 'object' && identityRaw !== null
      ? (identityRaw as Record<string, unknown>)
      : {};
  const checksRaw = Array.isArray(result.checks) ? (result.checks as unknown[]) : [];
  const checks = checksRaw.map((entry): OperationCheckSnapshot => {
    const check = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    return {
      checkKey: optionalString(check.checkKey),
      status: optionalString(check.status) ?? 'not_run',
      reasonCode: optionalString(check.reasonCode),
      exitCode: optionalNumber(check.exitCode),
      durationMs: optionalNumber(check.durationMs),
      output: extractCheckOutput(check.output),
    };
  });
  return {
    operationId,
    status: optionalString(result.status),
    state: optionalString(result.state),
    codeIdentity: {
      headCommit: optionalString(identity.headCommit),
      workingTreeDigest: optionalString(identity.workingTreeDigest),
      hasUncommittedChanges:
        typeof identity.hasUncommittedChanges === 'boolean' ? identity.hasUncommittedChanges : null,
    },
    checks,
  };
}

export interface ArtifactDigestSnapshot {
  readonly artifactId: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

/** 输出制品正文摘要（utf8 字节 sha256 + 字节数）。 */
export function artifactContentDigest(
  artifactId: string,
  content: string | Uint8Array,
): ArtifactDigestSnapshot {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return { artifactId, digest: sha256Hex(bytes), sizeBytes: bytes.length };
}

/* ------------------------------------------------------------------ *
 * 报告导出（稳定序列化）与只读数据库探针
 * ------------------------------------------------------------------ */

export interface EvidenceDocumentInput {
  readonly repositories?: readonly RepositorySnapshot[];
  readonly hostIdentity?: HostIdentitySnapshot;
  readonly operation?: OperationSnapshot;
  readonly artifacts?: readonly ArtifactDigestSnapshot[];
  readonly notes?: readonly string[];
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 导出版本化证据文档（稳定 JSON：递归排序键、无凭据字段）。
 * 导出前经 assertNoCredentialShapes fail-closed 校验。
 */
export function exportEvidenceDocument(input: EvidenceDocumentInput): string {
  const document = {
    schemaVersion: 1,
    ...(input.repositories !== undefined ? { repositories: input.repositories } : {}),
    ...(input.hostIdentity !== undefined ? { hostIdentity: input.hostIdentity } : {}),
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  assertNoCredentialShapes(document);
  return JSON.stringify(sortKeysDeep(document), null, 2);
}

/** 打开数据根状态库的受控只读探针（驱动层 readonly，绝不写业务状态）。 */
export function openDataRootStorageProbe(dataRoot: string): StorageProbe {
  return openStorageProbe(join(dataRoot, DATABASE_FILE_NAME));
}
