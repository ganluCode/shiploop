/**
 * P02-3 / F-014 Core 基线查询服务：baselines.list / baselines.get / artifacts.get
 * 三个只读查询（docs/p02-3-onboarding-contract.md §3.2/§7.4-§7.6）。
 *
 * 安全不变量：
 * - baselines.list / baselines.get 要求 baseline.read 能力（缺失 → forbidden）；
 *   list 先做项目可见谓词（受限主体不可见 → forbidden；全量范围下未知项目 →
 *   空页，不泄漏存在性）；get 对未知/不可见操作一律 not_found（不区分不存在
 *   与无权）；
 * - artifacts.get 委托 F-011 的 readBaselineOutput：能力缺失/未知/跨项目/
 *   非正式制品/路径形态一律统一 not_found（防枚举），正文经完整性核验读取
 *   （缺失/损坏 → corrupt_state），绝不按裸路径或 locator 读文件；
 * - baselines.get 的 output 引用与 tail 只来自经完整性核验的制品正文读取
 *   （readVerifiedContent，缓冲上限 8 MiB）；tail 为正文末尾 ≤16 KiB 的脱敏
 *   尾部视图，`truncated` 表示该内联尾部未覆盖完整正文（byteSize > tail 字节数，
 *   写回登记见 §7.5 F-014 注记）；正文核验失败 → corrupt_state，绝不静默放行；
 * - 只读：不创建/修改任何记录，不启动或停止进程；公开形状与 §7.4/§7.5 冻结
 *   字段一致（可选字段缺席即不携带，不产生 undefined 值键）。
 */
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import {
  hasCapability,
  isProjectVisible,
  requireCapability,
  requireProjectVisible,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import type { BaselineComparisonResult } from '../ports/baseline-comparison.js';
import { compareBaselineDetails } from '../ports/baseline-comparison.js';
import type {
  BaselineAuthorizationSummary,
  BaselineCheckOutputRef,
  BaselineCheckResult,
  BaselineDetailResult,
  BaselineListResult,
  BaselineOperationSummary,
} from '../ports/baseline.js';
import {
  ONBOARDING_QUERY_SCHEMA_VERSION,
  summarizeBaselineOperation,
  validateBaselineListQuery,
} from '../ports/baseline.js';
import type {
  BaselineAuthorizationRecord,
  BaselineCheckResultRecord,
  BaselineOperationRecord,
} from '../ports/baseline-store.js';
import { isUuidV4, PublicError } from '../ports/commands.js';
import type { BaselineQueryReadStore } from '../ports/queries.js';
import { validateStableId } from '../ports/validation.js';
import { createArtifactVerifier } from './artifact-verify.js';
import {
  BASELINE_OUTPUT_MAX_BYTES,
  BASELINE_OUTPUT_TAIL_MAX_BYTES,
  readBaselineOutput,
} from './baseline-evidence.js';

export interface BaselineQueryServiceDeps {
  readonly baselines: BaselineQueryReadStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
}

/** artifacts.get 的授权正文结果（传输层以 text/plain 有界输出）。 */
export interface BaselineArtifactContent {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly content: Uint8Array;
}

export interface BaselineQueryService {
  /** §7.4：项目内基线操作按键集分页（游标=上一页末条 operationId；不可见 → forbidden）。 */
  listBaselines(principal: TrustedPrincipal, projectId: unknown, query: unknown): BaselineListResult;
  /** §7.5：操作详情（授权摘要 + 检查明细含脱敏尾部）；未知/不可见 → not_found。 */
  getBaseline(principal: TrustedPrincipal, operationId: unknown): Promise<BaselineDetailResult>;
  /** F-007：按同项目检查身份比较两次基线；只返回诊断，不改变任何状态。 */
  compareBaselines(
    principal: TrustedPrincipal,
    previousOperationId: unknown,
    currentOperationId: unknown,
  ): Promise<BaselineComparisonResult>;
  /** §7.6：授权且有界的正式证据正文读取；未知/不可见/非正式制品 → not_found。 */
  readArtifactContent(principal: TrustedPrincipal, artifactId: unknown): Promise<BaselineArtifactContent>;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** 操作记录 + 检查行 → §7.4 公开摘要（逐项计数经冻结的纯函数派生）。 */
function toOperationSummary(
  record: BaselineOperationRecord,
  checks: readonly BaselineCheckResultRecord[],
): BaselineOperationSummary {
  return summarizeBaselineOperation({
    operationId: record.id,
    kind: record.kind,
    status: record.status,
    ...(record.reasonCode !== null ? { reasonCode: record.reasonCode } : {}),
    createdAt: toIso(record.createdAtUtcMs),
    startedAt: toIsoOrNull(record.startedAtUtcMs),
    endedAt: toIsoOrNull(record.endedAtUtcMs),
    checks: checks.map((check) => ({
      status: check.status,
      required: check.required,
      ...(check.reasonCode !== null ? { reasonCode: check.reasonCode } : {}),
    })),
  });
}

/** §6.2 不可变授权记录 → §7.5 公开摘要（authorizedAt epoch ms → ISO UTC）。 */
function toAuthorizationSummary(record: BaselineAuthorizationRecord): BaselineAuthorizationSummary {
  const missingFields = [
    ...(record.repositoryBindingRevision === null ? ['repositoryBindingRevision' as const] : []),
    ...(record.dirtyScope === null ? ['dirtyScope' as const] : []),
    ...(record.environmentIdentity === null ? ['environmentIdentity' as const] : []),
  ];
  return {
    projectId: record.projectId,
    repositoryBindingId: record.repositoryBindingId,
    ...(record.repositoryBindingRevision === null ? {} : { repositoryBindingRevision: record.repositoryBindingRevision }),
    ...(record.dirtyScope === null ? {} : { dirtyScope: record.dirtyScope }),
    ...(record.environmentIdentity === null ? {} : { environmentIdentity: record.environmentIdentity }),
    ...(missingFields.length === 0 ? {} : { missingFields }),
    codeIdentity: {
      headCommit: record.headCommit,
      workingTreeDigest: record.workingTreeDigest,
      hasUncommittedChanges: record.hasUncommittedChanges,
    },
    policyRevision: record.policyRevision,
    planDigest: record.planDigest,
    plan: record.plan,
    authorizedBy: record.authorizedBy,
    authorizedAt: toIso(record.authorizedAtUtcMs),
  };
}

/** 正文尾部视图：末尾 ≤BASELINE_OUTPUT_TAIL_MAX_BYTES 字节；空正文 → null。 */
function tailView(content: Uint8Array): { tail: string | null; truncated: boolean } {
  if (content.length === 0) {
    return { tail: null, truncated: false };
  }
  const truncated = content.length > BASELINE_OUTPUT_TAIL_MAX_BYTES;
  const bytes = truncated ? content.subarray(content.length - BASELINE_OUTPUT_TAIL_MAX_BYTES) : content;
  return { tail: Buffer.from(bytes).toString('utf8'), truncated };
}

/**
 * 装配基线查询服务。只校验依赖形态，不执行任何 I/O；import 本模块无副作用。
 */
export function createBaselineQueryService(deps: BaselineQueryServiceDeps): BaselineQueryService {
  if (deps === null || typeof deps !== 'object') {
    throw new PublicError('invalid_input', 'BaselineQueryService.create', '必须提供 baselines/artifacts/files 装配依赖');
  }
  const { baselines, artifacts, files } = deps;
  if (baselines === null || typeof baselines !== 'object' || typeof baselines.listBaselineOperations !== 'function') {
    throw new PublicError('invalid_input', 'BaselineQueryService.create', '必须提供 BaselineQueryReadStore 端口实现');
  }
  const verifier = createArtifactVerifier({
    artifacts,
    files,
    limits: { maxReadBytes: BASELINE_OUTPUT_MAX_BYTES },
  });

  /** 检查行 → §7.5 公开明细；有 output 制品时经完整性核验读取尾部视图（失败 → corrupt_state 上抛）。 */
  async function toCheckResult(row: BaselineCheckResultRecord): Promise<BaselineCheckResult> {
    let output: BaselineCheckOutputRef | null = null;
    let tail: string | null = null;
    if (row.outputArtifactId !== null) {
      const verified = await verifier.readVerifiedContent(row.projectId, row.outputArtifactId);
      const view = tailView(verified.content);
      output = { artifactId: verified.artifactId, byteSize: verified.sizeBytes, truncated: view.truncated };
      tail = view.tail;
    }
    return {
      checkKey: row.checkKey,
      argv: [...row.argv],
      cwdRef: row.cwdRef,
      environmentRef: row.environmentRef,
      timeoutMs: row.timeoutMs,
      required: row.required,
      status: row.status,
      ...(row.reasonCode !== null ? { reasonCode: row.reasonCode } : {}),
      exitCode: row.exitCode,
      signal: row.signal,
      timedOut: row.timedOut,
      output,
      tail,
      startedAt: toIsoOrNull(row.startedAtUtcMs),
      endedAt: toIsoOrNull(row.endedAtUtcMs),
      durationMs:
        row.startedAtUtcMs !== null && row.endedAtUtcMs !== null
          ? row.endedAtUtcMs - row.startedAtUtcMs
          : null,
    };
  }

  const service: BaselineQueryService = {
    listBaselines(principal, projectId, query) {
      const operation = 'baselines.list';
      requireCapability(principal, 'baseline.read', operation);
      const id = validateStableId(projectId, { operation }, 'projectId');
      // §4.3：受限主体对不可见项目 forbidden；全量范围下未知项目自然空页。
      requireProjectVisible(principal, id, operation);
      const validated = validateBaselineListQuery(query, operation);
      const page = baselines.listBaselineOperations(id, validated);
      return {
        schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
        projectId: id,
        records: page.records.map((record) =>
          toOperationSummary(record, baselines.listBaselineCheckResults(record.id)),
        ),
        nextCursor: page.nextCursor,
        limit: validated.limit,
      };
    },

    async getBaseline(principal, operationId) {
      const operation = 'baselines.get';
      requireCapability(principal, 'baseline.read', operation);
      if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
        throw new PublicError('invalid_input', operation, 'operationId 必须是 RFC 4122 UUID v4', {
          details: { field: 'operationId', reason: 'invalid_operation_id' },
        });
      }
      const record = baselines.getBaselineOperation(operationId);
      // §4.3：未知与不可见统一 not_found（不区分不存在与无权）。
      if (record === undefined || !isProjectVisible(principal, record.projectId)) {
        throw new PublicError('not_found', operation, '基线操作不存在');
      }
      const rows = baselines.listBaselineCheckResults(record.id);
      const authorization =
        record.authorizationId === null
          ? undefined
          : baselines.getBaselineAuthorization(record.authorizationId);
      const checks: BaselineCheckResult[] = [];
      for (const row of rows) {
        checks.push(await toCheckResult(row));
      }
      return {
        schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
        operation: toOperationSummary(record, rows),
        // 拒绝授权（decline）没有授权行 → null（§7.5）。
        authorization: authorization === undefined ? null : toAuthorizationSummary(authorization),
        checks,
      };
    },

    async compareBaselines(principal, previousOperationId, currentOperationId) {
      const operation = 'baselines.compare';
      requireCapability(principal, 'baseline.read', operation);
      const validateOperationId = (value: unknown): string => {
        if (typeof value !== 'string' || !isUuidV4(value)) {
          throw new PublicError('invalid_input', operation, 'operationId 必须是 RFC 4122 UUID v4', {
            details: { field: 'operationId', reason: 'invalid_operation_id' },
          });
        }
        return value;
      };
      const previousId = validateOperationId(previousOperationId);
      const currentId = validateOperationId(currentOperationId);
      const previousRecord = baselines.getBaselineOperation(previousId);
      const currentRecord = baselines.getBaselineOperation(currentId);
      // Unknown, invisible, and cross-project sources share not_found to avoid enumeration.
      if (previousRecord === undefined || currentRecord === undefined
        || !isProjectVisible(principal, previousRecord.projectId)
        || !isProjectVisible(principal, currentRecord.projectId)
        || previousRecord.projectId !== currentRecord.projectId) {
        throw new PublicError('not_found', operation, '基线操作不存在或不可比较');
      }
      // getBaseline performs authorization and every output artifact integrity check
      // before compareBaselineDetails inspects a result.
      const previous = await service.getBaseline(principal, previousId);
      const current = await service.getBaseline(principal, currentId);
      return compareBaselineDetails(previous, current, previousRecord.projectId);
    },

    async readArtifactContent(principal, artifactId) {
      // §7.6：与 F-011 readBaselineOutput 同一纪律——能力缺失/未知/伪造/跨项目
      // 一律统一 not_found（防枚举），绝不区分「不存在」与「无权」。
      const notFound = (): PublicError => new PublicError('not_found', 'artifacts.get', '证据不存在或不可见');
      if (!hasCapability(principal, 'baseline.read')) {
        throw notFound();
      }
      let membership: { readonly projectId: string; readonly operationId: string } | undefined;
      try {
        membership =
          typeof artifactId === 'string' ? baselines.findBaselineOutputArtifact(artifactId) : undefined;
      } catch {
        throw notFound();
      }
      if (membership === undefined) {
        throw notFound();
      }
      const artifactIdString = artifactId as string;
      // readBaselineOutput 重新做能力/可见性/成员/完整性核验（本服务不替代其把关）。
      const content = await readBaselineOutput(
        { artifacts, files, checks: baselines },
        principal,
        { projectId: membership.projectId, operationId: membership.operationId, artifactId: artifactIdString },
      );
      return { artifactId: artifactIdString, byteSize: content.length, content };
    },
  };
  return service;
}

/** F-014 传输层上限：artifacts.get 正文有界输出（= 基线输出制品上限 8 MiB）。 */
export const BASELINE_ARTIFACT_CONTENT_MAX_BYTES = BASELINE_OUTPUT_MAX_BYTES;
