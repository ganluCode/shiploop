/**
 * F-012 制品中断核对与损坏诊断（application 层）：关闭重开后的中断恢复、
 * ready 完整性核对、有效读取与孤儿扫描证据。
 *
 * 设计依据：core-design/03 §4（pending 登记 → 同文件系统 staging → 校验 →
 * 发布 → 短事务 ready；ready 文件缺失为 corrupt）与 F-012 验收点。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（ArtifactStore / ArtifactFileStore）与 node 内置模块
 *   （crypto），不接触具体适配器、驱动或绝对路径；物理位置推导与路径安全
 *   完全由文件端口承担（含符号链接拒绝），本模块绝不拼接路径；
 * - 核对不伪装成功、不删除未知文件、不制造索引：
 *   · pending 且正式文件存在：校验项目归属/受控路径（由文件端口保证）、实测
 *     SHA-256 与登记预期摘要、实测字节数与 stat 一致，全部通过后经端口
 *     CAS（expectedRevision）补 ready；不能只因文件存在就 ready；
 *   · pending 只有 staging 残留或无任何文件：返回可理解的中断原因
 *     （staging_only / no_content），保持不可用（索引仍为 pending，取不到
 *     有效输入引用），残留文件原样保留；
 *   · ready 正文缺失 / 大小不符 / hash 被篡改：分别返回明确的 corrupt 诊断
 *     （missing / size_mismatch / hash_mismatch，ArtifactCorruption），不改变
 *     索引状态与正文字节；failed 终态保留原因与残留证据；
 * - 核对前的有效读取（readVerifiedContent）执行必要完整性检查：stat 存在性
 *   与字节数、流式实测摘要与索引一致；缺失正文抛 corrupt 而不是返回空内容；
 *   读取缓冲受显式 maxReadBytes 上限约束（超过即 size_limit_exceeded，不无限
 *   缓存大正文）；大正文的流式核对由 verifyArtifact 承担（增量 hash，不缓冲）；
 * - 与发布状态更新竞争：文件核验（事务外）之后一律经端口 CAS 提交，冲突时
 *   重新读取记录并按新状态重新核对（revision 重新核对），绝不让旧检查结果
 *   倒写；重复核对幂等：verified_ready 不改状态、不重复制造索引、不改变内容
 *   身份（hash/size/version/locator）；
 * - 项目级批量核对（verifyProject）：经 listArtifacts 分页（每批 ≤256）核对
 *   已索引制品；扫描正式区与 staging 区（不跟随链接、分页有界）发现无索引
 *   正式文件与 staging 孤儿时，生成含逻辑位置、原因、适用身份的恢复证据；
 *   原文件一律保留在原位置（kept_in_place），不立即删除未知文件，不跨项目
 *   自动绑定（孤儿证据只记录候选身份，绝不创建索引行）；maxArtifacts /
 *   maxOrphans 上限使单次核对有界，超出时 truncated=true；
 * - 错误脱敏：消息与 details 只含相对逻辑位置、摘要、字节数与脱敏错误码，
 *   不含绝对路径或正文内容（ArtifactVerifyError 携带 cause 供诊断）；
 * - import 本模块无副作用；createArtifactVerifier 只校验依赖与限制，不执行
 *   任何 I/O。
 *
 * 本模块不实现：制品删除/保留策略与安全隔离迁移、Host 停机升级编排、
 * Host/CLI 命令；断电/真实磁盘满演练与其他平台验收不在本阶段（竞争场景经
 * 确定性注入与真实子进程测试覆盖，见 test/artifact-verify.test.ts）。
 */
import { createHash } from 'node:crypto';
import { ARTIFACT_STAGING_FILE_SUFFIX, ArtifactFileError, isArtifactFileError } from '../ports/artifact-files.js';
import type {
  ArtifactFileScanEntry,
  ArtifactFileStat,
  ArtifactFileStore,
} from '../ports/artifact-files.js';
import { isStorageError } from '../ports/errors.js';
import type { ArtifactCorruption, ArtifactRecord, ArtifactStatus, ArtifactStore } from '../ports/artifact-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/** 核对结果类别：恢复、幂等通过、中断、损坏、失败证据与不可信文件系统条件。 */
export type ArtifactVerifyOutcomeKind =
  /** pending + 正式文件核验通过，经 CAS 补 ready。 */
  | 'recovered_ready'
  /** ready 且完整性核验通过（幂等：不改状态与 revision）。 */
  | 'verified_ready'
  /** pending 只有 staging 残留或无任何文件：保持不可用。 */
  | 'interrupted'
  /** 正文损坏（missing / size_mismatch / hash_mismatch）。 */
  | 'corrupt'
  /** failed 终态：保留原因与残留证据，不改状态。 */
  | 'failed_evidence'
  /** 文件系统拒绝（逃逸/非常规文件/权限/IO）：不跟随、不删除。 */
  | 'untrusted_file';

/** pending 中断原因：只有 staging 残留，或无任何正文。 */
export interface ArtifactInterruptionEvidence {
  readonly reason: 'staging_only' | 'no_content';
  readonly detail: string;
}

/** 本制品在受控 staging 区内的残留文件（相对位置 + 字节数）。 */
export interface ArtifactStagingResidue {
  readonly relativePath: string;
  readonly sizeBytes: number | null;
}

/** 单制品核对报告：携带核对后的索引状态、revision 与诊断证据。 */
export interface ArtifactVerifyReport {
  readonly kind: ArtifactVerifyOutcomeKind;
  readonly projectId: string;
  readonly artifactId: string;
  readonly status: ArtifactStatus;
  readonly revision: number;
  readonly contentHash: string | null;
  readonly corruption: ArtifactCorruption | null;
  readonly interruption: ArtifactInterruptionEvidence | null;
  readonly failureReason: string | null;
  readonly untrustedDetail: string | null;
  readonly stagingResidues: readonly ArtifactStagingResidue[];
  readonly checkedAtUtcMs: number;
}

/** 孤儿/未信任条目证据：只记录逻辑位置、原因与候选身份，绝不创建索引。 */
export interface ArtifactOrphanEvidence {
  readonly projectId: string;
  readonly area: 'final' | 'staging';
  readonly relativePath: string;
  readonly reason: 'final_without_index' | 'staging_without_index' | 'untrusted_entry';
  /** 从受控位置名推导的候选制品身份（可能不可解析为 null）；未经索引绑定。 */
  readonly candidateArtifactId: string | null;
  readonly sizeBytes: number | null;
  readonly detectedAtUtcMs: number;
}

/** 项目级批量核对报告。 */
export interface ProjectVerifyReport {
  readonly projectId: string;
  readonly checkedAtUtcMs: number;
  readonly artifactReports: readonly ArtifactVerifyReport[];
  readonly orphans: readonly ArtifactOrphanEvidence[];
  /** 超出 maxArtifacts / maxOrphans 上限时为 true（单次核对有界）。 */
  readonly truncated: boolean;
  /** 孤儿处置策略：原文件保留在原位置，不立即删除未知文件。 */
  readonly orphanPolicy: 'kept_in_place';
}

/** 有效读取结果：内容字节与经核验的身份摘要。 */
export interface VerifiedArtifactContent {
  readonly projectId: string;
  readonly artifactId: string;
  readonly content: Uint8Array;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly relativePath: string;
}

/** 核对失败类别。 */
export type ArtifactVerifyErrorCode =
  | 'validation'
  | 'not_found'
  | 'ownership'
  | 'conflict'
  /** 正文损坏（missing / size_mismatch / hash_mismatch），corruption 携带诊断。 */
  | 'corrupt'
  | 'storage'
  | 'file'
  /** readVerifiedContent 超过 maxReadBytes 缓冲上限。 */
  | 'size_limit_exceeded';

export interface ArtifactVerifyErrorOptions {
  readonly projectId?: string;
  readonly artifactId?: string;
  readonly corruption?: ArtifactCorruption;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * 制品核对失败：携带类别与适用实体身份；消息与 details 只含相对逻辑位置、
 * 摘要与脱敏错误码，不含绝对路径或正文内容；cause 保留原始端口错误。
 */
export class ArtifactVerifyError extends Error {
  readonly code: ArtifactVerifyErrorCode;
  readonly projectId: string | null;
  readonly artifactId: string | null;
  readonly corruption: ArtifactCorruption | null;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ArtifactVerifyErrorCode,
    message: string,
    options: ArtifactVerifyErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ArtifactVerifyError';
    this.code = code;
    this.projectId = options.projectId ?? null;
    this.artifactId = options.artifactId ?? null;
    this.corruption = options.corruption ?? null;
    this.details = options.details;
  }
}

export function isArtifactVerifyError(
  value: unknown,
  code?: ArtifactVerifyErrorCode,
): value is ArtifactVerifyError {
  return value instanceof ArtifactVerifyError && (code === undefined || value.code === code);
}

/** 读取缓冲上限（readVerifiedContent）：显式有限，超过即失败。 */
export interface ArtifactVerifyLimits {
  readonly maxReadBytes: number;
}

export interface ArtifactVerifierDeps {
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly limits: ArtifactVerifyLimits;
  readonly nowMs?: () => number;
}

/** 项目级批量核对选项：分页与单次上限（均有界）。 */
export interface ProjectVerifyOptions {
  /** 每批条目数（1..PROJECT_VERIFY_MAX_PAGE_SIZE，默认 64）。 */
  readonly pageSize?: number;
  /** 单次核对的最大索引制品数（≥1，默认 256；超出置 truncated）。 */
  readonly maxArtifacts?: number;
  /** 单次上报的最大孤儿/未信任条目数（≥1，默认 256；超出置 truncated）。 */
  readonly maxOrphans?: number;
}

export const PROJECT_VERIFY_MAX_PAGE_SIZE = 256;
export const PROJECT_VERIFY_DEFAULTS = {
  pageSize: 64,
  maxArtifacts: 256,
  maxOrphans: 256,
} as const;

/** 内部扫描分页安全上限：防御游标异常导致的无限循环（每批 ≤256 条）。 */
const MAX_SCAN_PAGES = 4096;
/** pending 恢复时状态竞争的最大重试次数（每次重试都重新读取并重新核对）。 */
const MAX_STATE_ATTEMPTS = 3;

function validateProjectVerifyOptions(value: unknown, operation: string): {
  pageSize: number;
  maxArtifacts: number;
  maxOrphans: number;
} {
  const context: ValidationContext = { operation };
  if (value === undefined) {
    const defaults: { pageSize: number; maxArtifacts: number; maxOrphans: number } = {
      pageSize: PROJECT_VERIFY_DEFAULTS.pageSize,
      maxArtifacts: PROJECT_VERIFY_DEFAULTS.maxArtifacts,
      maxOrphans: PROJECT_VERIFY_DEFAULTS.maxOrphans,
    };
    return defaults;
  }
  const object = requirePlainObject(value, context, 'options');
  rejectUnknownKeys(object, ['pageSize', 'maxArtifacts', 'maxOrphans'], context, 'options');
  let pageSize: number = PROJECT_VERIFY_DEFAULTS.pageSize;
  if (object.pageSize !== undefined) {
    if (
      typeof object.pageSize !== 'number' ||
      !Number.isInteger(object.pageSize) ||
      object.pageSize < 1 ||
      object.pageSize > PROJECT_VERIFY_MAX_PAGE_SIZE
    ) {
      throw validationError(
        context,
        'options.pageSize',
        `必须是 1..${PROJECT_VERIFY_MAX_PAGE_SIZE} 的整数（每批处理量上限）`,
        object.pageSize,
      );
    }
    pageSize = object.pageSize;
  }
  const maxArtifacts =
    object.maxArtifacts === undefined
      ? PROJECT_VERIFY_DEFAULTS.maxArtifacts
      : validatePositiveInteger(object.maxArtifacts, context, 'options.maxArtifacts');
  const maxOrphans =
    object.maxOrphans === undefined
      ? PROJECT_VERIFY_DEFAULTS.maxOrphans
      : validatePositiveInteger(object.maxOrphans, context, 'options.maxOrphans');
  return { pageSize, maxArtifacts, maxOrphans };
}

/**
 * 装配制品中断核对用例。只校验依赖形态与限制，不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createArtifactVerifier(deps: ArtifactVerifierDeps) {
  const operation = 'ArtifactVerifier';
  const context: ValidationContext = { operation: 'ArtifactVerifier.create' };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 artifacts/files/limits 装配依赖');
  }
  if (deps.artifacts === null || typeof deps.artifacts !== 'object') {
    throw validationError(context, 'deps.artifacts', '必须提供 ArtifactStore 端口实现');
  }
  if (deps.files === null || typeof deps.files !== 'object') {
    throw validationError(context, 'deps.files', '必须提供 ArtifactFileStore 端口实现');
  }
  if (deps.limits === null || typeof deps.limits !== 'object') {
    throw validationError(context, 'deps.limits', '必须提供显式有限的读取限制');
  }
  const limitsObject = requirePlainObject(deps.limits, context, 'limits');
  rejectUnknownKeys(limitsObject, ['maxReadBytes'], context, 'limits');
  const maxReadBytes = validatePositiveInteger(limitsObject['maxReadBytes'], context, 'limits.maxReadBytes');
  const nowMs = deps.nowMs ?? Date.now;
  const { artifacts, files } = deps;

  function errorOf(
    code: ArtifactVerifyErrorCode,
    message: string,
    projectId: string | null,
    artifactId: string | null,
    cause?: unknown,
    options: { corruption?: ArtifactCorruption; details?: Readonly<Record<string, unknown>> } = {},
  ): ArtifactVerifyError {
    return new ArtifactVerifyError(code, message, {
      projectId: projectId ?? undefined,
      artifactId: artifactId ?? undefined,
      ...(options.corruption !== undefined ? { corruption: options.corruption } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /** 端口错误类别映射（保留 cause 供诊断）。 */
  function portErrorCode(cause: unknown): ArtifactVerifyErrorCode {
    if (isStorageError(cause, 'validation')) {
      return 'validation';
    }
    if (isStorageError(cause, 'not_found')) {
      return 'not_found';
    }
    if (isStorageError(cause, 'ownership')) {
      return 'ownership';
    }
    if (isStorageError(cause, 'conflict')) {
      return 'conflict';
    }
    if (isStorageError(cause)) {
      return 'storage';
    }
    if (isArtifactFileError(cause)) {
      return 'file';
    }
    return 'storage';
  }

  /** 文件端口错误的脱敏摘要（错误类别 + 脱敏 code，不含路径原文）。 */
  function fileErrorDetail(cause: unknown): string {
    if (isArtifactFileError(cause)) {
      const code = (cause.details?.['code'] as string | undefined) ?? cause.kind;
      return `fs=${cause.kind}（code=${code}）`;
    }
    return 'cause=unknown';
  }

  /** 分页扫描受控 staging 区，收集本制品的残留文件（每批有界）。 */
  async function findStagingResidues(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactStagingResidue[]> {
    const residues: ArtifactStagingResidue[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const scanPage = await files.scanStagingArea(projectId, {
        limit: 64,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const entry of scanPage.entries) {
        if (
          entry.kind === 'file' &&
          entry.name.startsWith(`${artifactId}.`) &&
          entry.name.endsWith(ARTIFACT_STAGING_FILE_SUFFIX)
        ) {
          residues.push({ relativePath: entry.relativePath, sizeBytes: entry.sizeBytes });
        }
      }
      if (scanPage.nextCursor === null) {
        residues.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
        return residues;
      }
      cursor = scanPage.nextCursor;
    }
    throw errorOf(
      'storage',
      `${operation}.verifyArtifact: staging 扫描超过分页安全上限（${String(MAX_SCAN_PAGES)} 批），拒绝无限核对`,
      projectId,
      artifactId,
    );
  }

  /**
   * 流式实测正式正文：增量 SHA-256 与字节数（不把整个正文缓冲进内存）。
   * stat 先行核对字节数一致性（防御纵深）。
   */
  async function measureFinalFile(
    projectId: string,
    artifactId: string,
    locator: string,
    expectedSizeBytes: number,
  ): Promise<{ hash: string; sizeBytes: number }> {
    const key = { projectId, artifactId, locator };
    const content = await files.openFinalRead(key);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const chunk of content.stream) {
        const data = chunk as Uint8Array;
        hash.update(data);
        sizeBytes += data.byteLength;
      }
    } catch (cause) {
      content.stream.destroy();
      if (isArtifactFileError(cause)) {
        throw cause;
      }
      throw new ArtifactFileError('io', `${operation}.verifyArtifact`, '读取正式正文失败', {
        details: { relativePath: content.relativePath, code: 'stream_read_failed' },
        cause,
      });
    }
    if (sizeBytes !== expectedSizeBytes) {
      throw new ArtifactFileError('io', `${operation}.verifyArtifact`, '实测字节数与 stat 不一致', {
        details: {
          relativePath: content.relativePath,
          reason: 'stream_size_differs_from_stat',
          expectedSizeBytes,
          actualSizeBytes: sizeBytes,
        },
      });
    }
    return { hash: hash.digest('hex'), sizeBytes };
  }

  function corruptionOf(
    kind: ArtifactCorruption['kind'],
    detail: string,
    fields: {
      expectedHash?: string;
      actualHash?: string;
      expectedSizeBytes?: number;
      actualSizeBytes?: number;
    },
  ): ArtifactCorruption {
    return {
      kind,
      detectedAtUtcMs: nowMs(),
      ...(fields.expectedHash !== undefined ? { expectedHash: fields.expectedHash } : {}),
      ...(fields.actualHash !== undefined ? { actualHash: fields.actualHash } : {}),
      ...(fields.expectedSizeBytes !== undefined ? { expectedSizeBytes: fields.expectedSizeBytes } : {}),
      ...(fields.actualSizeBytes !== undefined ? { actualSizeBytes: fields.actualSizeBytes } : {}),
      detail,
    };
  }

  /** ready 完整性核对：缺失/大小不符/摘要篡改分别给出明确 corrupt 诊断（无状态变更）。 */
  async function verifyReadyIntegrity(record: ArtifactRecord): Promise<ArtifactVerifyReport> {
    const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };
    const checkedAtUtcMs = nowMs();
    if (record.contentHash === null || record.sizeBytes === null) {
      // 防御纵深：读取路径不信任持久层，ready 行缺少 hash/size 证据（直接 SQL
      // 注入的历史损坏）一律拒绝放行。
      return {
        kind: 'untrusted_file',
        projectId: record.projectId,
        artifactId: record.id,
        status: record.status,
        revision: record.revision,
        contentHash: null,
        corruption: null,
        interruption: null,
        failureReason: null,
        untrustedDetail: 'ready 行缺少 hash/size 证据（index_missing_evidence）',
        stagingResidues: [],
        checkedAtUtcMs,
      };
    }
    let stat: ArtifactFileStat;
    try {
      stat = await files.statFinal(key);
    } catch (cause) {
      if (isArtifactFileError(cause, 'not_found')) {
        return {
          kind: 'corrupt',
          projectId: record.projectId,
          artifactId: record.id,
          status: record.status,
          revision: record.revision,
          contentHash: record.contentHash,
          corruption: corruptionOf(
            'missing',
            'ready 正文缺失（corrupt: missing）',
            { expectedHash: record.contentHash, expectedSizeBytes: record.sizeBytes },
          ),
          interruption: null,
          failureReason: null,
          untrustedDetail: null,
          stagingResidues: [],
          checkedAtUtcMs,
        };
      }
      if (isArtifactFileError(cause)) {
        return {
          kind: 'untrusted_file',
          projectId: record.projectId,
          artifactId: record.id,
          status: record.status,
          revision: record.revision,
          contentHash: record.contentHash,
          corruption: null,
          interruption: null,
          failureReason: null,
          untrustedDetail: fileErrorDetail(cause),
          stagingResidues: [],
          checkedAtUtcMs,
        };
      }
      throw errorOf(
        portErrorCode(cause),
        `${operation}.verifyArtifact: stat 正式正文失败`,
        record.projectId,
        record.id,
        cause,
      );
    }
    if (stat.sizeBytes !== record.sizeBytes) {
      return {
        kind: 'corrupt',
        projectId: record.projectId,
        artifactId: record.id,
        status: record.status,
        revision: record.revision,
        contentHash: record.contentHash,
        corruption: corruptionOf(
          'size_mismatch',
          'ready 正文字节数与索引不符（corrupt: size_mismatch）',
          { expectedSizeBytes: record.sizeBytes, actualSizeBytes: stat.sizeBytes },
        ),
        interruption: null,
        failureReason: null,
        untrustedDetail: null,
        stagingResidues: [],
        checkedAtUtcMs,
      };
    }
    let measured: { hash: string; sizeBytes: number };
    try {
      measured = await measureFinalFile(record.projectId, record.id, record.locator, stat.sizeBytes);
    } catch (cause) {
      if (isArtifactFileError(cause)) {
        return {
          kind: 'untrusted_file',
          projectId: record.projectId,
          artifactId: record.id,
          status: record.status,
          revision: record.revision,
          contentHash: record.contentHash,
          corruption: null,
          interruption: null,
          failureReason: null,
          untrustedDetail: fileErrorDetail(cause),
          stagingResidues: [],
          checkedAtUtcMs,
        };
      }
      throw errorOf(
        portErrorCode(cause),
        `${operation}.verifyArtifact: 读取正式正文失败`,
        record.projectId,
        record.id,
        cause,
      );
    }
    if (measured.hash !== record.contentHash) {
      return {
        kind: 'corrupt',
        projectId: record.projectId,
        artifactId: record.id,
        status: record.status,
        revision: record.revision,
        contentHash: record.contentHash,
        corruption: corruptionOf(
          'hash_mismatch',
          'ready 正文摘要与索引不符（corrupt: hash_mismatch，疑似篡改）',
          {
            expectedHash: record.contentHash,
            actualHash: measured.hash,
            expectedSizeBytes: record.sizeBytes,
            actualSizeBytes: measured.sizeBytes,
          },
        ),
        interruption: null,
        failureReason: null,
        untrustedDetail: null,
        stagingResidues: [],
        checkedAtUtcMs,
      };
    }
    // 幂等通过：不改变状态、revision 与内容身份。
    return {
      kind: 'verified_ready',
      projectId: record.projectId,
      artifactId: record.id,
      status: record.status,
      revision: record.revision,
      contentHash: record.contentHash,
      corruption: null,
      interruption: null,
      failureReason: null,
      untrustedDetail: null,
      stagingResidues: [],
      checkedAtUtcMs,
    };
  }

  /** failed 终态核对：保留原因与残留证据，不改状态。 */
  async function verifyFailedEvidence(record: ArtifactRecord): Promise<ArtifactVerifyReport> {
    const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };
    let untrustedDetail: string | null = null;
    try {
      await files.statFinal(key);
    } catch (cause) {
      if (isArtifactFileError(cause, 'not_found')) {
        untrustedDetail = null;
      } else if (isArtifactFileError(cause)) {
        untrustedDetail = fileErrorDetail(cause);
      } else {
        throw errorOf(
          portErrorCode(cause),
          `${operation}.verifyArtifact: 核对 failed 残留失败`,
          record.projectId,
          record.id,
          cause,
        );
      }
    }
    const residues = await findStagingResidues(record.projectId, record.id);
    return {
      kind: 'failed_evidence',
      projectId: record.projectId,
      artifactId: record.id,
      status: record.status,
      revision: record.revision,
      contentHash: null,
      corruption: null,
      interruption: null,
      failureReason: record.failureReason,
      untrustedDetail,
      stagingResidues: residues,
      checkedAtUtcMs: nowMs(),
    };
  }

  type PendingOutcome = { kind: 'retry' } | ArtifactVerifyReport;

  /** pending 恢复核对：正式文件核验通过后 CAS 补 ready；冲突交由上层重试。 */
  async function verifyPendingArtifact(record: ArtifactRecord): Promise<PendingOutcome> {
    const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };
    const checkedAtUtcMs = nowMs();
    let stat: ArtifactFileStat;
    try {
      stat = await files.statFinal(key);
    } catch (cause) {
      if (isArtifactFileError(cause, 'not_found')) {
        // 只有 staging 或无文件：可理解的中断原因，保持不可用（不标 ready）。
        const residues = await findStagingResidues(record.projectId, record.id);
        const reason = residues.length > 0 ? 'staging_only' : 'no_content';
        return {
          kind: 'interrupted',
          projectId: record.projectId,
          artifactId: record.id,
          status: record.status,
          revision: record.revision,
          contentHash: null,
          corruption: null,
          interruption: {
            reason,
            detail:
              reason === 'staging_only'
                ? `发布中断：仅存在 staging 残留（${String(residues.length)} 个 .part），正式正文缺失，保持 pending 不可用`
                : '发布中断：未发现任何正文（无正式文件、无 staging 残留），保持 pending 不可用',
          },
          failureReason: null,
          untrustedDetail: null,
          stagingResidues: residues,
          checkedAtUtcMs,
        };
      }
      if (isArtifactFileError(cause)) {
        return {
          kind: 'untrusted_file',
          projectId: record.projectId,
          artifactId: record.id,
          status: record.status,
          revision: record.revision,
          contentHash: null,
          corruption: null,
          interruption: null,
          failureReason: null,
          untrustedDetail: fileErrorDetail(cause),
          stagingResidues: [],
          checkedAtUtcMs,
        };
      }
      throw errorOf(
        portErrorCode(cause),
        `${operation}.verifyArtifact: stat 正式正文失败`,
        record.projectId,
        record.id,
        cause,
      );
    }
    let measured: { hash: string; sizeBytes: number };
    try {
      measured = await measureFinalFile(record.projectId, record.id, record.locator, stat.sizeBytes);
    } catch (cause) {
      if (isArtifactFileError(cause)) {
        return {
          kind: 'untrusted_file',
          projectId: record.projectId,
          artifactId: record.id,
          status: record.status,
          revision: record.revision,
          contentHash: null,
          corruption: null,
          interruption: null,
          failureReason: null,
          untrustedDetail: fileErrorDetail(cause),
          stagingResidues: [],
          checkedAtUtcMs,
        };
      }
      throw errorOf(
        portErrorCode(cause),
        `${operation}.verifyArtifact: 读取正式正文失败`,
        record.projectId,
        record.id,
        cause,
      );
    }
    if (measured.hash !== record.expectedHash) {
      // 不能只因文件存在就 ready：摘要不符给出明确 corrupt 诊断，保持 pending
      // 供人工/上层处置，不删除文件、不覆盖状态。
      return {
        kind: 'corrupt',
        projectId: record.projectId,
        artifactId: record.id,
        status: record.status,
        revision: record.revision,
        contentHash: null,
        corruption: corruptionOf(
          'hash_mismatch',
          'pending 正式文件实测摘要与登记预期不符，拒绝补 ready（corrupt: hash_mismatch）',
          {
            expectedHash: record.expectedHash,
            actualHash: measured.hash,
            actualSizeBytes: measured.sizeBytes,
          },
        ),
        interruption: null,
        failureReason: null,
        untrustedDetail: null,
        stagingResidues: [],
        checkedAtUtcMs,
      };
    }
    // 核验通过：短事务 CAS 补 ready；与状态更新竞争时冲突 → 上层按新 revision 重新核对。
    try {
      const ready = await artifacts.transitionArtifact(record.projectId, record.id, {
        expectedRevision: record.revision,
        outcome: {
          status: 'ready',
          actualHash: measured.hash,
          sizeBytes: measured.sizeBytes,
        },
      });
      return {
        kind: 'recovered_ready',
        projectId: ready.projectId,
        artifactId: ready.id,
        status: ready.status,
        revision: ready.revision,
        contentHash: ready.contentHash,
        corruption: null,
        interruption: null,
        failureReason: null,
        untrustedDetail: null,
        stagingResidues: [],
        checkedAtUtcMs,
      };
    } catch (cause) {
      if (isStorageError(cause, 'conflict')) {
        return { kind: 'retry' };
      }
      throw errorOf(
        portErrorCode(cause),
        `${operation}.verifyArtifact: pending 恢复的 ready 提交失败`,
        record.projectId,
        record.id,
        cause,
      );
    }
  }

  /** 稳定 ID 形态探测（不信任扫描条目名；不可解析返回 null）。 */
  function stableIdOrNull(name: string): string | null {
    try {
      return validateStableId(name, { operation: `${operation}.verifyProject` }, 'entry.name');
    } catch {
      return null;
    }
  }

  /** staging 文件名 → 候选制品身份（<artifactId>.<随机>.part）。 */
  function stagingCandidateOf(name: string): string | null {
    if (!name.endsWith(ARTIFACT_STAGING_FILE_SUFFIX)) {
      return null;
    }
    const prefix = name.slice(0, -ARTIFACT_STAGING_FILE_SUFFIX.length);
    const candidate = prefix.split('.')[0] ?? '';
    return stableIdOrNull(candidate);
  }

  return {
    /**
     * 单制品核对：pending 恢复（正式文件核验 + CAS 补 ready）或 ready 完整性
     * 核对；failed 保留证据。与状态更新竞争时按 revision 重新核对，不让旧
     * 检查结果倒写；重复核对幂等。
     */
    async verifyArtifact(projectId: string, artifactId: string): Promise<ArtifactVerifyReport> {
      for (let attempt = 1; ; attempt += 1) {
        let record: ArtifactRecord;
        try {
          record = await artifacts.getArtifact(projectId, artifactId);
        } catch (cause) {
          throw errorOf(
            portErrorCode(cause),
            `${operation}.verifyArtifact: 读取制品索引失败`,
            typeof projectId === 'string' ? projectId : null,
            typeof artifactId === 'string' ? artifactId : null,
            cause,
          );
        }
        if (record.status === 'ready') {
          return verifyReadyIntegrity(record);
        }
        if (record.status === 'failed') {
          return verifyFailedEvidence(record);
        }
        const outcome = await verifyPendingArtifact(record);
        if (outcome.kind !== 'retry') {
          return outcome;
        }
        if (attempt >= MAX_STATE_ATTEMPTS) {
          throw errorOf(
            'conflict',
            `${operation}.verifyArtifact: 制品状态在核对期间持续变化（重试 ${String(MAX_STATE_ATTEMPTS)} 次后仍冲突），拒绝以过期核对结果写入`,
            record.projectId,
            record.id,
          );
        }
        // 冲突后按新 revision 重新读取并重新核对（本轮循环顶部）。
      }
    },

    /**
     * 项目级批量核对：分页核对已索引制品（有界 maxArtifacts），扫描正式区与
     * staging 区生成孤儿/未信任条目证据（有界 maxOrphans）；原文件一律保留在
     * 原位置（kept_in_place），不删除、不创建索引、不跨项目绑定。
     */
    async verifyProject(projectId: string, options?: unknown): Promise<ProjectVerifyReport> {
      const op = `${operation}.verifyProject`;
      let opts: { pageSize: number; maxArtifacts: number; maxOrphans: number };
      try {
        opts = validateProjectVerifyOptions(options, op);
      } catch (cause) {
        throw errorOf('validation', (cause as Error).message, typeof projectId === 'string' ? projectId : null, null, cause);
      }
      // 项目存在性与完整 id 集（分页有界；不截断，供孤儿归属判断）。
      const indexedIds: string[] = [];
      let listCursor: string | undefined;
      for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
        let listPage;
        try {
          listPage = await artifacts.listArtifacts(projectId, {
            limit: opts.pageSize,
            ...(listCursor !== undefined ? { cursor: listCursor } : {}),
          });
        } catch (cause) {
          throw errorOf(portErrorCode(cause), `${op}: 分页读取制品索引失败`, typeof projectId === 'string' ? projectId : null, null, cause);
        }
        indexedIds.push(...listPage.records.map((entry) => entry.id));
        if (listPage.nextCursor === null) {
          break;
        }
        listCursor = listPage.nextCursor;
      }
      const idSet = new Set(indexedIds);
      const truncatedArtifacts = indexedIds.length > opts.maxArtifacts;

      const artifactReports: ArtifactVerifyReport[] = [];
      for (const artifactId of indexedIds.slice(0, opts.maxArtifacts)) {
        artifactReports.push(await this.verifyArtifact(projectId, artifactId));
      }

      const orphans: ArtifactOrphanEvidence[] = [];
      let truncatedOrphans = false;

      const pushOrphan = (evidence: ArtifactOrphanEvidence): boolean => {
        orphans.push(evidence);
        return orphans.length >= opts.maxOrphans;
      };

      const classifyFinalEntry = (entry: ArtifactFileScanEntry): ArtifactOrphanEvidence | null => {
        if (entry.kind === 'directory') {
          if (idSet.has(entry.name)) {
            return null; // 已索引制品的正式目录
          }
          return {
            projectId,
            area: 'final',
            relativePath: entry.relativePath,
            reason: 'final_without_index',
            candidateArtifactId: stableIdOrNull(entry.name),
            sizeBytes: null,
            detectedAtUtcMs: nowMs(),
          };
        }
        // 正式区只允许每制品目录；散落常规文件/链接/其他对象按未信任条目
        // 保留证据（不跟随、不打开）。
        return {
          projectId,
          area: 'final',
          relativePath: entry.relativePath,
          reason: 'untrusted_entry',
          candidateArtifactId: null,
          sizeBytes: null,
          detectedAtUtcMs: nowMs(),
        };
      };

      const classifyStagingEntry = (entry: ArtifactFileScanEntry): ArtifactOrphanEvidence | null => {
        if (entry.kind === 'file' && entry.name.endsWith(ARTIFACT_STAGING_FILE_SUFFIX)) {
          const candidate = stagingCandidateOf(entry.name);
          if (candidate !== null && idSet.has(candidate)) {
            // 已索引制品的已知残留：由单制品核对报告携带，不是孤儿。
            return null;
          }
          return {
            projectId,
            area: 'staging',
            relativePath: entry.relativePath,
            reason: candidate === null ? 'untrusted_entry' : 'staging_without_index',
            candidateArtifactId: candidate,
            sizeBytes: entry.sizeBytes,
            detectedAtUtcMs: nowMs(),
          };
        }
        return {
          projectId,
          area: 'staging',
          relativePath: entry.relativePath,
          reason: 'untrusted_entry',
          candidateArtifactId: null,
          sizeBytes: null,
          detectedAtUtcMs: nowMs(),
        };
      };

      async function scanArea(
        area: 'final' | 'staging',
        classify: (entry: ArtifactFileScanEntry) => ArtifactOrphanEvidence | null,
      ): Promise<void> {
        let scanCursor: string | undefined;
        for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
          const scanPage = await (area === 'final'
            ? files.scanFinalArea(projectId, {
                limit: opts.pageSize,
                ...(scanCursor !== undefined ? { cursor: scanCursor } : {}),
              })
            : files.scanStagingArea(projectId, {
                limit: opts.pageSize,
                ...(scanCursor !== undefined ? { cursor: scanCursor } : {}),
              }));
          for (const entry of scanPage.entries) {
            const evidence = classify(entry);
            if (evidence !== null && pushOrphan(evidence)) {
              truncatedOrphans = true;
              return;
            }
          }
          if (scanPage.nextCursor === null) {
            return;
          }
          scanCursor = scanPage.nextCursor;
        }
        throw errorOf(
          'storage',
          `${op}: ${area} 区扫描超过分页安全上限（${String(MAX_SCAN_PAGES)} 批），拒绝无限核对`,
          typeof projectId === 'string' ? projectId : null,
          null,
        );
      }

      await scanArea('final', classifyFinalEntry);
      if (!truncatedOrphans) {
        await scanArea('staging', classifyStagingEntry);
      }

      return {
        projectId,
        checkedAtUtcMs: nowMs(),
        artifactReports,
        orphans,
        truncated: truncatedArtifacts || truncatedOrphans,
        orphanPolicy: 'kept_in_place',
      };
    },

    /**
     * 有效读取：核对前的必要完整性检查（stat 存在性/字节数 + 流式实测摘要），
     * 缺失正文抛 corrupt 而不是返回空内容；缓冲受 maxReadBytes 上限约束。
     * 大正文的流式核对（不缓冲）由 verifyArtifact 承担。
     */
    async readVerifiedContent(projectId: string, artifactId: string): Promise<VerifiedArtifactContent> {
      const op = `${operation}.readVerifiedContent`;
      let record: ArtifactRecord;
      try {
        record = await artifacts.getArtifact(projectId, artifactId);
      } catch (cause) {
        throw errorOf(
          portErrorCode(cause),
          `${op}: 读取制品索引失败`,
          typeof projectId === 'string' ? projectId : null,
          typeof artifactId === 'string' ? artifactId : null,
          cause,
        );
      }
      if (record.status !== 'ready') {
        throw errorOf('conflict', `${op}: 制品状态 ${record.status} 不能有效读取（仅 ready 制品可用）`, record.projectId, record.id, undefined, {
          details: { status: record.status },
        });
      }
      if (record.contentHash === null || record.sizeBytes === null) {
        throw errorOf(
          'corrupt',
          `${op}: ready 行缺少 hash/size 证据，拒绝有效读取`,
          record.projectId,
          record.id,
          undefined,
          { details: { reason: 'index_missing_evidence' } },
        );
      }
      const key = { projectId: record.projectId, artifactId: record.id, locator: record.locator };
      let stat: ArtifactFileStat;
      try {
        stat = await files.statFinal(key);
      } catch (cause) {
        if (isArtifactFileError(cause, 'not_found')) {
          throw errorOf(
            'corrupt',
            `${op}: ready 正文缺失（corrupt: missing），有效读取失败`,
            record.projectId,
            record.id,
            cause,
            {
              corruption: corruptionOf('missing', 'ready 正文缺失（corrupt: missing）', {
                expectedHash: record.contentHash,
                expectedSizeBytes: record.sizeBytes,
              }),
            },
          );
        }
        throw errorOf(
          isArtifactFileError(cause) ? 'file' : portErrorCode(cause),
          `${op}: stat 正式正文失败（${fileErrorDetail(cause)}）`,
          record.projectId,
          record.id,
          cause,
        );
      }
      if (stat.sizeBytes !== record.sizeBytes) {
        throw errorOf(
          'corrupt',
          `${op}: 正文字节数与索引不符（corrupt: size_mismatch），有效读取失败`,
          record.projectId,
          record.id,
          undefined,
          {
            corruption: corruptionOf(
              'size_mismatch',
              '正文字节数与索引不符（corrupt: size_mismatch）',
              { expectedSizeBytes: record.sizeBytes, actualSizeBytes: stat.sizeBytes },
            ),
          },
        );
      }
      const content = await files.openFinalRead(key);
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let sizeBytes = 0;
      try {
        for await (const chunk of content.stream) {
          const data = chunk as Buffer;
          sizeBytes += data.byteLength;
          if (sizeBytes > maxReadBytes) {
            throw errorOf(
              'size_limit_exceeded',
              `${op}: 正文超过读取缓冲上限 ${String(maxReadBytes)} 字节，拒绝无限缓存（大正文请使用 verifyArtifact 的流式核对）`,
              record.projectId,
              record.id,
              undefined,
              { details: { maxReadBytes } },
            );
          }
          hash.update(data);
          chunks.push(data);
        }
      } catch (cause) {
        content.stream.destroy();
        if (cause instanceof ArtifactVerifyError) {
          throw cause;
        }
        throw errorOf(
          'file',
          `${op}: 读取正式正文失败`,
          record.projectId,
          record.id,
          cause,
        );
      }
      const actualHash = hash.digest('hex');
      if (sizeBytes !== record.sizeBytes) {
        throw errorOf(
          'corrupt',
          `${op}: 实测字节数与索引不符（corrupt: size_mismatch），有效读取失败`,
          record.projectId,
          record.id,
          undefined,
          {
            corruption: corruptionOf(
              'size_mismatch',
              '实测字节数与索引不符（corrupt: size_mismatch）',
              { expectedSizeBytes: record.sizeBytes, actualSizeBytes: sizeBytes },
            ),
          },
        );
      }
      if (actualHash !== record.contentHash) {
        throw errorOf(
          'corrupt',
          `${op}: 正文摘要与索引不符（corrupt: hash_mismatch），有效读取失败`,
          record.projectId,
          record.id,
          undefined,
          {
            corruption: corruptionOf(
              'hash_mismatch',
              '正文摘要与索引不符（corrupt: hash_mismatch，疑似篡改）',
              { expectedHash: record.contentHash, actualHash, expectedSizeBytes: sizeBytes },
            ),
          },
        );
      }
      return {
        projectId: record.projectId,
        artifactId: record.id,
        content: Buffer.concat(chunks),
        contentHash: record.contentHash,
        sizeBytes: record.sizeBytes,
        locator: record.locator,
        relativePath: content.relativePath,
      };
    },
  };
}

export type ArtifactVerifier = ReturnType<typeof createArtifactVerifier>;
