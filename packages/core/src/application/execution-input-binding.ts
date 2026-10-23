/**
 * P03-6 / F-002 不可变执行输入绑定服务（application 层）：消费已提交认领
 * 回执与已核验工作区令牌，逐项核验不可变输入并产出 RuntimeExecutionRequest、
 * 受限读取能力与按 Attempt 关联的读取证据。
 *
 * 设计依据：ports/execution-input-binding.ts 文件头（契约要点）、
 * core-design/14 §3/§5（已授权恢复引用、Core 拥有占用与停止核验）、
 * input/p03-fake-runtime.md FR-2（校验必需输入及权限；不打开业务库）。
 *
 * 编排顺序（任一拒绝即 ExecutionInputBindingError + 尽力保留拒绝证据制品，
 * 零代码/工具副作用、不修改旧快照、不改预算）：
 * 1. 输入形态校验（ports 校验器；恢复选择连同身份委托 P03-3A 校验器）；
 * 2. 工作区令牌准入（authority.inspect）与权威 Attempt 重读：回执身份逐项
 *    核对（过期/伪造回执拒绝）、Attempt 必须处于 beginLaunch 授权后的
 *    preparing/runtime 且 invocationId 一致（未授权启动/已推进拒绝）；
 * 3. 重叠拒绝：同 Task 存在其他活动状态 Attempt 一律拒绝（旧执行未停止）；
 * 4. 占用归属：WorkResourceAccess 读取当前租约组，workspace 租约必须归属
 *    本 Attempt 且 held；工作区 realpath/仓库身份复核（authority.verify
 *    重检，目录替换/符号链接越界拒绝）；cwd 根 ID 经装配白名单解析，
 *    相对位置由规范路径推导并复核（路径注入拒绝）；
 * 5. 权限与策略身份：请求权限摘要必须等于准备时权限面（扩大拒绝）；请求
 *    策略必须与快照内实际策略副本逐项一致；
 * 6. 必需正文读取：snapshot/manifest/prompt 三正文 + manifest 标记必需的
 *    required-input 逐条「索引身份核对 → 有界 verified 读取」，证据逐项
 *    记录用途/摘要/字节/耗时；缺失、pending/failed、正文损坏、错误版本、
 *    跨项目、超限、不可读明确失败；引用存在但未读取绝不记为已满足；
 * 7. 内容身份重算：snapshot/manifest/prompt 确定性摘要重算比对、完整
 *    acceptance 可读性（快照条目 + manifest 完整标记 + prompt 逐条包含）、
 *    manifest 必需标记与引用集双向一致；
 * 8. 恢复决定：来源引用先解析为同项目 ready Artifact 并有界读取正文、核对
 *    sourceDigest；再经 P03-3A decideRuntimeRecovery 按可信能力目录决定，
 *    实际 resume 必须通过既有来源/停止/输入/权限授权预检；auto 降级 new
 *    记录原因，required 拒绝即失败；
 * 9. 组装 RuntimeExecutionRequest 并经既有 validateRuntimeExecutionRequest
 *    终验；发布按 Attempt 关联的读取证据制品（成功与拒绝都保留）。
 *
 * 本模块不实现：预算预占/结算、Attempt 状态推进（F-008/F-009）、Work
 * Session 持久化（F-006）、适配器与 FakeRuntime（F-003..F-005）、原生档案
 * 或 P03-9 完整 resume。
 */
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { RuntimeRecoveryService } from './runtime-recovery.js';
import type { AttemptStore, AttemptRecord } from '../ports/attempt-store.js';
import { isPlanningAttemptSnapshot } from '../ports/attempt-store.js';
import { ACTIVE_ATTEMPT_STATUSES } from '../ports/attempt-store.js';
import {
  CONTEXT_MANIFEST_DIGEST_DOMAIN,
  CONTEXT_PROMPT_DIGEST_DOMAIN,
  CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
} from '../ports/context-build.js';
import {
  computeExecutionPermissionsDigest,
  computeExecutionStrategyCopyDigest,
  EXECUTION_MANIFEST_ARTIFACT_KIND,
  EXECUTION_PROMPT_ARTIFACT_KIND,
  EXECUTION_SNAPSHOT_ARTIFACT_KIND,
} from '../ports/execution-input-prepare.js';
import {
  computePlanningPermissionsDigest,
  computePlanningStrategyCopyDigest,
  PLANNING_MANIFEST_ARTIFACT_KIND,
  PLANNING_MANIFEST_DIGEST_DOMAIN,
  PLANNING_PROMPT_ARTIFACT_KIND,
  PLANNING_PROMPT_DIGEST_DOMAIN,
  PLANNING_SNAPSHOT_ARTIFACT_KIND,
  PLANNING_SNAPSHOT_DIGEST_DOMAIN,
} from '../ports/planning-input-prepare.js';
import type { ExecutionInputRef } from '../ports/execution-input.js';
import type { PreparedExecutionInputGroup } from '../ports/execution-input-prepare.js';
import { isStorageError } from '../ports/errors.js';
import { stableStringify } from '../ports/feature-plan.js';
import {
  decideRuntimeRecovery,
} from '../ports/runtime-recovery.js';
import type {
  RuntimeRecoveryCapabilities,
  RuntimeRecoveryReference,
} from '../ports/runtime-recovery.js';
import type { RuntimeRecoveryCatalog } from '../ports/runtime-recovery-catalog.js';
import {
  RUNTIME_EXECUTION_SCHEMA_VERSION,
  validateRuntimeExecutionRequest,
} from '../ports/runtime-execution.js';
import type { RuntimeExecutionRequest } from '../ports/runtime-execution.js';
import type { WorkResourceAccess, WorkWorkspaceAuthority } from '../ports/work-resources.js';
import type { VerifiedWorkWorkspace } from '../ports/work-resources.js';
import { validateArtifactLocator, validationError } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import {
  DEFAULT_EXECUTION_INPUT_BINDING_LIMITS,
  EXECUTION_INPUT_READ_EVIDENCE_ARTIFACT_KIND,
  EXECUTION_INPUT_READ_EVIDENCE_LOCATOR_PREFIX,
  EXECUTION_INPUT_READ_EVIDENCE_MEDIA_TYPE,
  EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
  ExecutionInputBindingError,
  validateExecutionInputBindingInput,
  validateExecutionInputBindingLimits,
} from '../ports/execution-input-binding.js';
import type {
  BoundExecutionInputBody,
  BoundExecutionInputReader,
  BoundExecutionInputRef,
  ExecutionInputBindingInput,
  ExecutionInputBindingLimits,
  ExecutionInputBindingReason,
  ExecutionInputBindingResult,
  ExecutionInputReadEntry,
  ExecutionInputReadEvidence,
  ExecutionInputRecoveryRecord,
} from '../ports/execution-input-binding.js';

const OPERATION = 'ExecutionInputBinding.bind';

/** 绑定服务装配依赖（全部窄端口/用例；不接触具体适配器与业务库连接）。 */
export interface ExecutionInputBindingDeps {
  /** 制品索引只读（核验 ready/身份；不是交给适配器的句柄）。 */
  readonly artifacts: ArtifactStore;
  /** 有界 verified 读取（实测摘要复核）。 */
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  /** 权威 Attempt 只读（重读核对回执身份、重叠检查）。 */
  readonly attempts: AttemptStore;
  /** 工作区占用只读（租约归属核验）。 */
  readonly resources: WorkResourceAccess;
  /** 工作区令牌准入与 realpath 复核（P03-5 权威端口）。 */
  readonly workspaceAuthority: WorkWorkspaceAuthority;
  /** 可信装配的 cwd 获准根白名单：rootId → 规范授权根（与 authority 同一根集）。 */
  readonly workspaceRoots: Readonly<Record<string, string>>;
  /** 证据制品发布（按 Attempt 关联；成功与拒绝都保留）。 */
  readonly publisher: ArtifactPublisher;
  /** P03-3A 可信恢复能力目录（缺省即全部 unverified）。 */
  readonly recoveryCatalog?: RuntimeRecoveryCatalog;
  /** P03-3A 来源/停止/输入/权限授权预检；实际 resume 前必须提供并通过。 */
  readonly recovery?: RuntimeRecoveryService;
  readonly limits?: ExecutionInputBindingLimits;
  /** 时间源（默认 Date.now；测试注入以获得确定性）。 */
  readonly nowMs?: () => number;
}

export interface ExecutionInputBindingService {
  /** 绑定不可变执行输入；失败抛 ExecutionInputBindingError（或输入形态 StorageError validation）。 */
  bind(input: unknown): Promise<ExecutionInputBindingResult>;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function domainDigest(domain: string, canonical: string): string {
  return sha256Hex(`${domain}\n${canonical}`);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** prompt 中验收条目的渲染归一（与 ContextBuilder 的 singleLine 一致）。 */
function singleLine(text: string): string {
  return text.replaceAll(/\r?\n/g, ' ');
}

/**
 * 装配执行输入绑定服务。只校验依赖形态与限制（fail-closed），不执行任何
 * I/O；import 本模块无副作用。
 */
export function createExecutionInputBindingService(
  deps: ExecutionInputBindingDeps,
): ExecutionInputBindingService {
  const context: ValidationContext = { operation: 'ExecutionInputBinding.create' };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 artifacts/verifier/attempts/resources/workspaceAuthority/workspaceRoots/publisher 装配依赖');
  }
  for (const [field, value] of [
    ['artifacts', deps.artifacts],
    ['verifier', deps.verifier],
    ['attempts', deps.attempts],
    ['resources', deps.resources],
    ['workspaceAuthority', deps.workspaceAuthority],
    ['workspaceRoots', deps.workspaceRoots],
    ['publisher', deps.publisher],
  ] as const) {
    if (value === null || typeof value !== 'object') {
      throw validationError(context, `deps.${field}`, `必须提供 ${field} 端口/用例实现`);
    }
  }
  const limits = deps.limits === undefined
    ? DEFAULT_EXECUTION_INPUT_BINDING_LIMITS
    : validateExecutionInputBindingLimits(deps.limits);
  const nowMs = deps.nowMs ?? Date.now;

  return { bind };

  async function bind(value: unknown): Promise<ExecutionInputBindingResult> {
    const validated = validateExecutionInputBindingInput(value);
    const claimAttempt = validated.claim.attempt;
    const projectId = claimAttempt.projectId;

    /* 证据构建状态（随流程累积；拒绝时尽力发布）。 */
    const startedAtMs = nowMs();
    const reads: ExecutionInputReadEntry[] = [];
    let boundInputs: BoundExecutionInputRef[] = [];
    let recoveryRecord: ExecutionInputRecoveryRecord = {
      selectionMode: validated.recovery.mode,
      selectionKind: validated.recovery.mode === 'new' ? null : validated.recovery.kind,
      sourceArchiveArtifactId:
        validated.recovery.mode !== 'new' && validated.recovery.source !== undefined
          ? validated.recovery.source.nativeArchiveRef
          : null,
      decision: 'new',
      reasons: [],
    };

    const buildEvidence = (
      outcome: 'bound' | 'rejected',
      reason: ExecutionInputBindingReason | null,
    ): ExecutionInputReadEvidence => ({
      schemaVersion: EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
      projectId,
      featureId: claimAttempt.featureId,
      runId: claimAttempt.runId,
      taskId: claimAttempt.taskId,
      attemptId: claimAttempt.id,
      sessionId: validated.sessionId,
      invocationId: validated.invocationId,
      outcome,
      reason,
      boundInputs,
      reads,
      recovery: recoveryRecord,
      totals: {
        refCount: boundInputs.length,
        totalBytes: reads.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
        readDurationMs: Math.max(0, nowMs() - startedAtMs),
      },
      createdAtUtcMs: nowMs(),
    });

    /** 尽力发布拒绝证据；发布失败不掩盖原始拒绝。 */
    const publishQuietly = async (
      evidence: ExecutionInputReadEvidence,
    ): Promise<BoundExecutionInputRef | null> => {
      try {
        return await publishEvidence(evidence);
      } catch {
        return null;
      }
    };

    const reject = async (
      kind: 'input' | 'workspace' | 'recovery',
      reason: ExecutionInputBindingReason,
      message: string,
      options: { details?: Readonly<Record<string, unknown>>; cause?: unknown } = {},
    ): Promise<never> => {
      const evidenceRef = await publishQuietly(buildEvidence('rejected', reason));
      throw new ExecutionInputBindingError(kind, reason, `${OPERATION}: ${message}`, {
        evidenceRef: evidenceRef?.artifactId ?? null,
        ...(options.details !== undefined ? { details: options.details } : {}),
        ...(options.cause !== undefined ? { cause: options.cause } : {}),
      });
    };

    /* ---- 2. 工作区令牌准入 + 权威 Attempt 重读与回执身份核对 ---- */
    let workspace: VerifiedWorkWorkspace;
    try {
      workspace = deps.workspaceAuthority.inspect(validated.workspace);
    } catch (cause) {
      return reject('workspace', 'workspace_untrusted', '工作区令牌未经权威颁发', { cause });
    }
    if (workspace.binding.projectId !== projectId) {
      return reject('workspace', 'workspace_untrusted', '工作区绑定与认领项目不一致');
    }

    let attempt: AttemptRecord;
    try {
      attempt = deps.attempts.getAttempt(projectId, claimAttempt.id);
    } catch (cause) {
      return reject('input', 'claim_identity_mismatch', '权威 Attempt 不存在（回执不可信）', { cause });
    }
    const identityMismatch =
      attempt.projectId !== claimAttempt.projectId ||
      attempt.featureId !== claimAttempt.featureId ||
      attempt.runId !== claimAttempt.runId ||
      attempt.taskId !== claimAttempt.taskId ||
      attempt.number !== claimAttempt.number ||
      attempt.owner !== claimAttempt.owner ||
      attempt.hostInstanceId !== claimAttempt.hostInstanceId ||
      attempt.executionVersion !== claimAttempt.executionVersion ||
      attempt.inputDigest !== claimAttempt.inputDigest ||
      attempt.inputRef !== claimAttempt.inputRef ||
      attempt.leaseUntilUtcMs !== claimAttempt.leaseUntilUtcMs;
    if (identityMismatch) {
      return reject('input', 'claim_identity_mismatch', '认领回执与权威 Attempt 身份不一致');
    }
    if (
      attempt.status !== 'preparing' ||
      attempt.executionStage !== 'runtime' ||
      attempt.invocationId === null ||
      attempt.invocationId !== validated.invocationId
    ) {
      return reject('input', 'attempt_not_current', 'Attempt 不在已授权启动状态（beginLaunch 前置/已推进/invocationId 不符）');
    }
    if (attempt.sessionId !== null && attempt.sessionId !== validated.sessionId) {
      return reject('input', 'session_conflict', 'Attempt 已绑定的 Session 与请求不一致');
    }

    /* ---- 3. 重叠拒绝：同 Task 其他活动 Attempt（旧执行未停止一律拒绝） ---- */
    let taskAttempts: readonly AttemptRecord[];
    try {
      taskAttempts = deps.attempts.listTaskAttempts(projectId, attempt.taskId);
    } catch (cause) {
      return reject('input', 'claim_identity_mismatch', '读取同 Task Attempt 列表失败', { cause });
    }
    const overlapping = taskAttempts.find(
      (candidate) =>
        candidate.id !== attempt.id &&
        (ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(candidate.status),
    );
    if (overlapping !== undefined) {
      return reject('input', 'overlap_active_attempt', '同 Task 存在未停止的活动 Attempt，拒绝重叠执行', {
        details: { activeAttemptId: overlapping.id },
      });
    }
    /* P03-9 / F-007：旧 Attempt 的隔离/未释放占用不能被 new 绕过。 */
    const priorAttemptIds = new Set(taskAttempts.filter((candidate) => candidate.id !== attempt.id)
      .map((candidate) => candidate.id));
    const lingeringLeases = deps.attempts.listWorkspaceLeases(projectId)
      .filter((lease) => priorAttemptIds.has(lease.owner) &&
        (lease.state === 'held' || lease.state === 'quarantined'));
    if (lingeringLeases.length > 0) {
      return reject('recovery', 'source_occupancy_unresolved', '同 Task 旧 Attempt 仍持有或隔离工作区占用（new 不能绕过）', {
        details: { owners: lingeringLeases.map((lease) => lease.owner) },
      });
    }
    const requestedRecovery = validated.recovery;
    if (requestedRecovery.mode !== 'new' && requestedRecovery.source !== undefined) {
      const source = requestedRecovery.source;
      if (source.purpose !== 'work') {
        return reject('recovery', 'recovery_source_invalid', 'Work 续接不接受 Chat 恢复来源');
      }
      const prior = taskAttempts.filter((candidate) => candidate.id !== attempt.id)
        .sort((left, right) => left.number - right.number);
      const latest = prior[prior.length - 1];
      if (latest === undefined || latest.id !== source.sourceAttemptId) {
        return reject('recovery', 'recovery_source_invalid', '恢复来源不是同 Task 的直接上一 Attempt', {
          details: { sourceAttemptId: source.sourceAttemptId },
        });
      }
      if (latest.sessionId !== null && latest.sessionId !== source.sourceSessionId) {
        return reject('recovery', 'recovery_source_invalid', '恢复来源 Session 与来源 Attempt 不一致');
      }
    }
    const recordedRecovery = attempt.inputSnapshot.recovery;
    if (recordedRecovery !== undefined) {
      if (recordedRecovery.nextAttemptId !== attempt.id ||
          stableStringify(recordedRecovery.selection) !== stableStringify(requestedRecovery)) {
        return reject('recovery', 'recovery_decision_changed', '输入快照记录的续接选择与当前请求不一致');
      }
    }

    /* ---- 4. 占用归属 + 工作区 realpath 复核 + cwd 推导 ---- */
    const identity = {
      projectId,
      attemptId: attempt.id,
      owner: attempt.owner,
      hostInstanceId: attempt.hostInstanceId,
      executionVersion: attempt.executionVersion,
    };
    let leaseOk = false;
    try {
      const snapshot = deps.resources.read(identity);
      const workspaceLease = snapshot.leases.find(
        (lease) => lease.resourceKind === 'workspace' && lease.resourceKey === workspace.resourceKey,
      );
      leaseOk =
        workspaceLease !== undefined &&
        workspaceLease.owner === attempt.id &&
        workspaceLease.state === 'held';
    } catch {
      leaseOk = false;
    }
    if (!leaseOk) {
      return reject('workspace', 'workspace_untrusted', '工作区占用未归属当前 Attempt（或已被隔离/过期）');
    }
    try {
      const fresh = await deps.workspaceAuthority.verify(workspace.binding, workspace.canonicalPath);
      if (fresh.resourceKey !== workspace.resourceKey) {
        return reject('workspace', 'workspace_untrusted', '工作区 realpath 复核身份漂移（目录替换）');
      }
    } catch (cause) {
      if (cause instanceof ExecutionInputBindingError) throw cause;
      return reject('workspace', 'workspace_untrusted', '工作区 realpath/仓库身份复核失败（目录替换或符号链接越界）', { cause });
    }
    const authorizedRoot = deps.workspaceRoots[validated.cwdRoot];
    if (authorizedRoot === undefined) {
      return reject('workspace', 'cwd_root_unknown', 'cwd 根 ID 不在获准根白名单内');
    }
    if (authorizedRoot !== workspace.authorizedRoot) {
      return reject('workspace', 'workspace_untrusted', 'cwd 根 ID 解析的授权根不覆盖已核验工作区');
    }
    const relativePath = relative(workspace.authorizedRoot, workspace.canonicalPath);
    const posixRelative = relativePath === '' ? '.' : relativePath.split(sep).join('/');
    if (posixRelative !== '.') {
      try {
        validateArtifactLocator(posixRelative, { operation: OPERATION }, 'cwd.relativePath');
      } catch (cause) {
        return reject('workspace', 'workspace_untrusted', 'cwd 相对位置推导非法（路径注入拒绝）', { cause });
      }
    }

    /* ---- 5. 权限与恢复选择的前置核验（读取前 fail-fast） ---- */
    const snapshot = attempt.inputSnapshot;
    // P05-1 / F-007：planning 快照走独立绑定分支（无业务计划批准身份）：权限面
    // 按规划摘要域重算；planning Task 单 Attempt 语义不接受任何续接选择。
    const planningSnapshot = isPlanningAttemptSnapshot(snapshot) ? snapshot : null;
    if (planningSnapshot !== null) {
      if (validated.recovery.mode !== 'new') {
        return reject('recovery', 'recovery_source_invalid', 'planning Attempt 不支持续接（只能新会话）');
      }
      if (computePlanningPermissionsDigest(validated.permissions.grants) !== planningSnapshot.digests.permissionsDigest) {
        return reject('input', 'permission_expansion', '请求权限与准备时规划权限面不一致（拒绝权限扩大）');
      }
    } else if (computeExecutionPermissionsDigest(validated.permissions.grants) !== snapshot.digests.permissionsDigest) {
      return reject('input', 'permission_expansion', '请求权限与准备时权限面不一致（拒绝权限扩大）');
    }

    /* ---- 6. 必需正文读取（索引身份核对 + 有界 verified 读取 + 逐项证据） ---- */
    const expectedKinds = new Map<string, string>();
    const groupArtifactKinds = planningSnapshot !== null
      ? { snapshot: PLANNING_SNAPSHOT_ARTIFACT_KIND, manifest: PLANNING_MANIFEST_ARTIFACT_KIND, prompt: PLANNING_PROMPT_ARTIFACT_KIND }
      : { snapshot: EXECUTION_SNAPSHOT_ARTIFACT_KIND, manifest: EXECUTION_MANIFEST_ARTIFACT_KIND, prompt: EXECUTION_PROMPT_ARTIFACT_KIND };
    const groupRef = (
      part: 'snapshot' | 'manifest' | 'prompt',
      kind: string,
    ): BoundExecutionInputRef => {
      expectedKinds.set(part, kind);
      const body = snapshot.group[part];
      return {
        purpose: part,
        artifactId: body.artifactId,
        version: body.version,
        contentHash: body.contentHash,
        sizeBytes: body.sizeBytes,
        locator: body.locator,
        mediaType: body.mediaType,
      };
    };
    boundInputs = [
      groupRef('snapshot', groupArtifactKinds.snapshot),
      groupRef('manifest', groupArtifactKinds.manifest),
      groupRef('prompt', groupArtifactKinds.prompt),
      ...snapshot.requiredInputs.map((ref) => {
        expectedKinds.set(ref.purpose, ref.kind);
        return {
          purpose: ref.purpose,
          artifactId: ref.artifactId,
          version: ref.version,
          contentHash: ref.contentHash,
          sizeBytes: ref.sizeBytes,
          locator: ref.locator,
          mediaType: ref.mediaType,
        };
      }),
    ];
    const purposes = new Set<string>();
    for (const ref of boundInputs) {
      if (purposes.has(ref.purpose)) {
        return reject('input', 'input_identity_mismatch', '绑定输入用途重复', {
          details: { purpose: ref.purpose },
        });
      }
      purposes.add(ref.purpose);
    }
    if (boundInputs.length > limits.maxRefCount) {
      return reject('input', 'limit_exceeded', '引用数量超限', {
        details: { limit: 'maxRefCount', measured: boundInputs.length, max: limits.maxRefCount },
      });
    }

    const readState = { count: 0, totalBytes: 0 };
    const checkDeadline = async (): Promise<void> => {
      if (nowMs() - startedAtMs > limits.maxReadDurationMs) {
        return reject('input', 'limit_exceeded', '读取耗时超限', {
          details: { limit: 'maxReadDurationMs', max: limits.maxReadDurationMs },
        });
      }
    };

    const bodies = new Map<string, Uint8Array>();
    for (const ref of boundInputs) {
      const readStarted = nowMs();
      const recordRead = (
        outcome: 'read' | 'failed',
        detail: string | null,
        contentHash: string | null,
        sizeBytes: number | null,
      ): void => {
        reads.push({
          purpose: ref.purpose,
          artifactId: ref.artifactId,
          contentHash,
          sizeBytes,
          durationMs: Math.max(0, nowMs() - readStarted),
          outcome,
          detail,
        });
      };
      const failRead = async (
        reason: ExecutionInputBindingReason,
        message: string,
        cause?: unknown,
      ): Promise<never> => {
        recordRead('failed', reason, null, null);
        return reject('input', reason, message, {
          details: { purpose: ref.purpose, artifactId: ref.artifactId },
          ...(cause !== undefined ? { cause } : {}),
        });
      };

      await checkDeadline();
      if (readState.count >= limits.maxReads) {
        return failRead('limit_exceeded', '读取次数超限');
      }
      readState.count += 1;
      if (ref.sizeBytes > limits.maxItemBytes) {
        return failRead('limit_exceeded', '单项正文超过读取上限');
      }
      if (readState.totalBytes + ref.sizeBytes > limits.maxTotalBytes) {
        return failRead('limit_exceeded', '读取总字节超过上限');
      }

      let record;
      try {
        record = await deps.artifacts.getArtifact(projectId, ref.artifactId);
      } catch (cause) {
        if (isStorageError(cause, 'not_found')) return failRead('input_missing', '必需制品缺失', cause);
        if (isStorageError(cause, 'ownership')) return failRead('input_cross_project', '必需制品跨项目归属', cause);
        return failRead('input_unreadable', '读取制品索引失败', cause);
      }
      if (record.status !== 'ready') {
        return failRead('input_not_ready', '必需制品非 ready（pending/failed）');
      }
      if (record.version !== ref.version) {
        return failRead('input_version_mismatch', '引用版本与权威索引不一致');
      }
      if (
        record.contentHash !== ref.contentHash ||
        record.sizeBytes !== ref.sizeBytes ||
        record.locator !== ref.locator ||
        record.mediaType !== ref.mediaType ||
        record.kind !== expectedKinds.get(ref.purpose)
      ) {
        return failRead('input_identity_mismatch', '引用与权威索引身份漂移（kind/hash/size/locator/mediaType）');
      }
      let verified;
      try {
        verified = await deps.verifier.readVerifiedContent(projectId, ref.artifactId);
      } catch (cause) {
        if (isArtifactVerifyError(cause, 'corrupt')) return failRead('input_corrupt', '正文损坏（摘要/字节实测不符或缺失）', cause);
        if (isArtifactVerifyError(cause, 'conflict')) return failRead('input_not_ready', '必需制品非 ready', cause);
        if (isArtifactVerifyError(cause, 'size_limit_exceeded')) return failRead('limit_exceeded', '正文超过读取缓冲上限', cause);
        if (isArtifactVerifyError(cause, 'not_found')) return failRead('input_missing', '必需制品缺失', cause);
        if (isArtifactVerifyError(cause, 'ownership')) return failRead('input_cross_project', '必需制品跨项目归属', cause);
        return failRead('input_unreadable', '正文读取失败（不可读输入）', cause);
      }
      if (verified.contentHash !== ref.contentHash || verified.sizeBytes !== ref.sizeBytes) {
        recordRead('failed', 'input_corrupt', verified.contentHash, verified.sizeBytes);
        return reject('input', 'input_corrupt', '正文实测摘要与引用不一致', {
          details: { purpose: ref.purpose, artifactId: ref.artifactId },
        });
      }
      readState.totalBytes += verified.sizeBytes;
      recordRead('read', null, verified.contentHash, verified.sizeBytes);
      bodies.set(ref.purpose, verified.content);
      await checkDeadline();
    }

    /* ---- 7. 内容身份重算：摘要、acceptance、manifest 双向覆盖、策略 ---- */
    const parseJson = async (
      part: 'snapshot' | 'manifest',
      bytes: Uint8Array,
    ): Promise<Record<string, unknown>> => {
      try {
        const parsed: unknown = JSON.parse(decodeUtf8(bytes));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not_an_object');
        }
        return parsed as Record<string, unknown>;
      } catch (cause) {
        return reject('input', 'input_corrupt', `${part} 正文不是合法 JSON`, {
          details: { part },
          cause,
        });
      }
    };
    const snapshotBody = await parseJson('snapshot', bodies.get('snapshot')!);
    const manifestBody = await parseJson('manifest', bodies.get('manifest')!);
    const promptBody = decodeUtf8(bodies.get('prompt')!);

    if (planningSnapshot !== null) {
      /* P05-1 / F-007：planning 分支内容身份重算：三正文按规划摘要域重算；
       * 身份键与 Attempt 冻结快照逐项一致；冻结策略副本与请求策略逐项一致；
       * prompt 完整携带验收条目；不携带业务计划批准身份。 */
      if (domainDigest(PLANNING_SNAPSHOT_DIGEST_DOMAIN, stableStringify(snapshotBody)) !== planningSnapshot.digests.snapshotDigest) {
        return reject('input', 'snapshot_digest_mismatch', 'planning snapshot 正文与冻结摘要重算不一致');
      }
      if (domainDigest(PLANNING_MANIFEST_DIGEST_DOMAIN, stableStringify(manifestBody)) !== planningSnapshot.digests.manifestDigest) {
        return reject('input', 'manifest_digest_mismatch', 'planning manifest 正文与冻结摘要重算不一致');
      }
      if (domainDigest(PLANNING_PROMPT_DIGEST_DOMAIN, promptBody) !== planningSnapshot.digests.promptDigest) {
        return reject('input', 'prompt_digest_mismatch', 'planning prompt 正文与冻结摘要重算不一致');
      }
      if (
        snapshotBody['projectId'] !== projectId ||
        snapshotBody['featureId'] !== attempt.featureId ||
        snapshotBody['runId'] !== attempt.runId ||
        snapshotBody['planningTaskId'] !== attempt.taskId ||
        snapshotBody['candidateId'] !== planningSnapshot.candidateId ||
        snapshotBody['phaseId'] !== planningSnapshot.phaseId
      ) {
        return reject('input', 'input_identity_mismatch', 'planning snapshot 正文身份与 Attempt 不一致');
      }
      const purposeStrategy = snapshotBody['purposeStrategy'];
      const strategyCopy = typeof purposeStrategy === 'object' && purposeStrategy !== null
        ? (purposeStrategy as Record<string, unknown>)['executionConfig'] : undefined;
      const strategySource = typeof purposeStrategy === 'object' && purposeStrategy !== null
        ? (purposeStrategy as Record<string, unknown>)['configSource'] : undefined;
      const strategySourceKey = typeof purposeStrategy === 'object' && purposeStrategy !== null
        ? (purposeStrategy as Record<string, unknown>)['configSourceKey'] : undefined;
      if (typeof strategyCopy !== 'object' || strategyCopy === null || Array.isArray(strategyCopy)
        || typeof strategySource !== 'string' || !(strategySourceKey === null || typeof strategySourceKey === 'string')) {
        return reject('input', 'input_corrupt', 'planning snapshot 缺少冻结策略副本');
      }
      const strategyRecord = strategyCopy as Record<string, unknown>;
      if (
        computePlanningStrategyCopyDigest({
          executionConfig: strategyCopy as Record<string, unknown>,
          configSource: strategySource as string,
          configSourceKey: strategySourceKey as string | null,
        }) !== planningSnapshot.digests.strategyCopyDigest
        || strategyRecord['runtime'] !== validated.strategy.runtime
        || strategyRecord['provider'] !== validated.strategy.provider
        || strategyRecord['model'] !== validated.strategy.model
        || (strategyRecord['credentialRef'] ?? undefined) !== validated.strategy.credentialRef
        || (strategyRecord['endpointRef'] ?? undefined) !== validated.strategy.endpointRef
      ) {
        return reject('input', 'strategy_mismatch', '请求策略与 planning 冻结策略副本不一致');
      }
      const planningRequest = snapshotBody['request'];
      const planningAcceptance = typeof planningRequest === 'object' && planningRequest !== null
        ? (planningRequest as Record<string, unknown>)['acceptance'] : undefined;
      const planningCriteria = typeof planningAcceptance === 'object' && planningAcceptance !== null
        ? (planningAcceptance as Record<string, unknown>)['criteria'] : undefined;
      if (!Array.isArray(planningCriteria) || planningCriteria.length === 0
        || planningCriteria.some(item => typeof item !== 'string')) {
        return reject('input', 'acceptance_incomplete', 'planning snapshot 缺少完整结构化验收条目');
      }
      for (const criterion of planningCriteria) {
        if (!promptBody.includes(singleLine(criterion as string))) {
          return reject('input', 'acceptance_incomplete', 'planning prompt 未完整携带验收条目');
        }
      }
    } else {
    const { meta: _meta, ...snapshotBusiness } = snapshotBody;
    if (snapshotBusiness['historyIndex'] === null) {
      delete snapshotBusiness['historyIndex'];
    }
    // F-011：普通构建 snapshot 正文携带 rework:null，业务摘要投影不含该键（与
    // ContextBuilder 条件展开一致）；返工构建 rework 为对象，原样参与重算。
    if (snapshotBusiness['rework'] === null) {
      delete snapshotBusiness['rework'];
    }
    if (domainDigest(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(snapshotBusiness)) !== snapshot.digests.snapshotDigest) {
      return reject('input', 'snapshot_digest_mismatch', 'snapshot 正文与冻结摘要重算不一致');
    }
    if (domainDigest(CONTEXT_MANIFEST_DIGEST_DOMAIN, stableStringify(manifestBody)) !== snapshot.digests.manifestDigest) {
      return reject('input', 'manifest_digest_mismatch', 'manifest 正文与冻结摘要重算不一致');
    }
    if (domainDigest(CONTEXT_PROMPT_DIGEST_DOMAIN, promptBody) !== snapshot.digests.promptDigest) {
      return reject('input', 'prompt_digest_mismatch', 'prompt 正文与冻结摘要重算不一致');
    }
    if (
      snapshotBody['projectId'] !== projectId ||
      snapshotBody['featureId'] !== attempt.featureId ||
      snapshotBody['taskId'] !== attempt.taskId ||
      manifestBody['projectId'] !== projectId ||
      manifestBody['taskId'] !== attempt.taskId
    ) {
      return reject('input', 'input_identity_mismatch', 'snapshot/manifest 正文身份与 Attempt 不一致');
    }
    const snapshotCheckPolicy = snapshotBody['checkPolicy'];
    const codingSnapshot = snapshot as PreparedExecutionInputGroup;
    if (
      typeof snapshotCheckPolicy !== 'object' || snapshotCheckPolicy === null ||
      (snapshotCheckPolicy as Record<string, unknown>)['digest'] !== codingSnapshot.approval.checkPolicyDigest
    ) {
      return reject('input', 'input_identity_mismatch', 'snapshot 检查政策与批准复合身份不一致');
    }

    /* 完整 acceptance 逐项可读（快照条目 + manifest 完整标记 + prompt 逐条包含）。 */
    const snapshotTask = snapshotBody['task'];
    const acceptance =
      typeof snapshotTask === 'object' && snapshotTask !== null
        ? (snapshotTask as Record<string, unknown>)['acceptance']
        : undefined;
    const criteria =
      typeof acceptance === 'object' && acceptance !== null
        ? (acceptance as Record<string, unknown>)['criteria']
        : undefined;
    if (!Array.isArray(criteria) || criteria.length === 0 || criteria.some((item) => typeof item !== 'string')) {
      return reject('input', 'acceptance_incomplete', '快照缺少完整结构化验收条目');
    }
    const codingManifestSources = Array.isArray(manifestBody['sources']) ? manifestBody['sources'] : [];
    const acceptanceSource = codingManifestSources.find(
      (source) =>
        typeof source === 'object' && source !== null &&
        (source as Record<string, unknown>)['kind'] === 'acceptance',
    ) as Record<string, unknown> | undefined;
    if (
      acceptanceSource === undefined ||
      acceptanceSource['required'] !== true ||
      acceptanceSource['truncated'] !== false ||
      acceptanceSource['selection'] !== `criteria[1..${criteria.length}] complete`
    ) {
      return reject('input', 'acceptance_incomplete', 'manifest 未标记完整 acceptance（required + 完整选取范围）');
    }
    for (const criterion of criteria) {
      if (!promptBody.includes(singleLine(criterion as string))) {
        return reject('input', 'acceptance_incomplete', 'prompt 未完整携带验收条目');
      }
    }
    }

    /* manifest 必需标记与绑定引用集双向一致（引用存在但未读取不算已满足）。 */
    const manifestSources = Array.isArray(manifestBody['sources']) ? manifestBody['sources'] : [];
    const requiredSources = manifestSources.filter(
      (source) =>
        typeof source === 'object' && source !== null &&
        (source as Record<string, unknown>)['kind'] === 'required-input',
    ) as Record<string, unknown>[];
    for (const source of requiredSources) {
      const identityValue = source['identity'];
      const artifactId =
        typeof identityValue === 'object' && identityValue !== null
          ? (identityValue as Record<string, unknown>)['artifactId']
          : undefined;
      const ref = boundInputs.find((candidate) => candidate.artifactId === artifactId);
      if (
        source['required'] !== true ||
        typeof artifactId !== 'string' ||
        ref === undefined ||
        source['version'] !== ref.version ||
        source['hash'] !== ref.contentHash ||
        !reads.some((entry) => entry.artifactId === ref.artifactId && entry.outcome === 'read')
      ) {
        return reject('input', 'manifest_required_mismatch', 'manifest 必需标记与引用/读取证据不一致');
      }
    }
    for (const ref of snapshot.requiredInputs) {
      if (!requiredSources.some((source) => {
        const identityValue = source['identity'];
        return (
          typeof identityValue === 'object' &&
          identityValue !== null &&
          (identityValue as Record<string, unknown>)['artifactId'] === ref.artifactId
        );
      })) {
        return reject('input', 'manifest_required_mismatch', '必需输入引用缺少 manifest 必需标记', {
          details: { artifactId: ref.artifactId },
        });
      }
    }

    /* 请求策略必须与快照中的实际策略副本逐项一致。 */
    if (planningSnapshot === null) {
    const strategyTaskBody = snapshotBody['task'];
    const executionConfig =
      typeof strategyTaskBody === 'object' && strategyTaskBody !== null
        ? (strategyTaskBody as Record<string, unknown>)['executionConfig']
        : undefined;
    const configSource =
      typeof strategyTaskBody === 'object' && strategyTaskBody !== null
        ? (strategyTaskBody as Record<string, unknown>)['configSource']
        : undefined;
    const configSourceKey =
      typeof strategyTaskBody === 'object' && strategyTaskBody !== null
        ? (strategyTaskBody as Record<string, unknown>)['configSourceKey']
        : undefined;
    if (
      typeof executionConfig !== 'object' || executionConfig === null || Array.isArray(executionConfig) ||
      typeof configSource !== 'string' ||
      (configSourceKey !== null && typeof configSourceKey !== 'string')
    ) {
      return reject('input', 'input_corrupt', '快照缺少实际策略副本');
    }
    const configRecord = executionConfig as Record<string, unknown>;
    const fallbackStrategy = snapshot.runtimeFallback?.strategy;
    const fallbackStrategyMatches = fallbackStrategy !== undefined
      && fallbackStrategy.runtime === validated.strategy.runtime
      && fallbackStrategy.provider === validated.strategy.provider
      && fallbackStrategy.model === validated.strategy.model
      && (fallbackStrategy.credentialRef ?? undefined) === validated.strategy.credentialRef
      && (fallbackStrategy.endpointRef ?? undefined) === validated.strategy.endpointRef;
    if (
      computeExecutionStrategyCopyDigest({
        executionConfig: executionConfig as Record<string, unknown>,
        configSource,
        configSourceKey: configSourceKey as string | null,
      }) !== snapshot.digests.strategyCopyDigest && !fallbackStrategyMatches
    ) {
      return reject('input', 'strategy_mismatch', '快照策略副本与冻结策略摘要重算不一致');
    }
    if (
      (configRecord['runtime'] !== validated.strategy.runtime ||
       configRecord['provider'] !== validated.strategy.provider ||
       configRecord['model'] !== validated.strategy.model ||
       (configRecord['credentialRef'] ?? undefined) !== validated.strategy.credentialRef ||
       (configRecord['endpointRef'] ?? undefined) !== validated.strategy.endpointRef) && !fallbackStrategyMatches
    ) {
      return reject('input', 'strategy_mismatch', '请求策略与快照实际策略副本逐项不一致');
    }
    }

    /* ---- 8. 恢复来源解析与能力决定 ---- */
    const selection = validated.recovery;
    if (selection.mode !== 'new' && selection.source !== undefined) {
      const source: RuntimeRecoveryReference = selection.source;
      const resolveSourceArtifact = async (
        artifactId: string,
        expectedDigest: string | null,
        label: string,
      ): Promise<void> => {
        let record;
        try {
          record = await deps.artifacts.getArtifact(projectId, artifactId);
        } catch (cause) {
          return reject('recovery', 'recovery_source_invalid', `恢复来源${label}不可解析（缺失或跨项目）`, {
            details: { artifactId },
            cause,
          });
        }
        if (
          record.status !== 'ready' ||
          (expectedDigest !== null && record.contentHash !== expectedDigest)
        ) {
          return reject('recovery', 'recovery_source_invalid', `恢复来源${label}内容身份不符（ready/摘要核验失败）`, {
            details: { artifactId },
          });
        }
        const purpose = label === '原生归档' ? 'recovery-archive' : 'recovery-checkpoint';
        /* F-007：续接记录已把来源归档/检查点列入必需输入并实际读取时，不重复
         * 绑定同一 artifactId；仍复核摘要并要求已读取证据。 */
        const existing = boundInputs.find((candidate) => candidate.artifactId === artifactId);
        if (existing !== undefined) {
          if (expectedDigest !== null && existing.contentHash !== expectedDigest) {
            return reject('recovery', 'recovery_source_invalid', `恢复来源${label}摘要与必需输入不一致`);
          }
          if (!reads.some((read) => read.artifactId === artifactId && read.outcome === 'read')) {
            return reject('recovery', 'recovery_source_invalid', `恢复来源${label}缺少实际读取证据`);
          }
          return;
        }
        if (purposes.has(purpose)) {
          return reject('recovery', 'recovery_source_invalid', '恢复来源用途与必需输入冲突');
        }
        const ref: BoundExecutionInputRef = {
          purpose, artifactId, version: record.version,
          contentHash: record.contentHash!, sizeBytes: record.sizeBytes!,
          locator: record.locator, mediaType: record.mediaType,
        };
        boundInputs.push(ref);
        purposes.add(purpose);
        expectedKinds.set(purpose, record.kind);
        await checkDeadline();
        if (boundInputs.length > limits.maxRefCount || readState.count >= limits.maxReads ||
            ref.sizeBytes > limits.maxItemBytes || readState.totalBytes + ref.sizeBytes > limits.maxTotalBytes) {
          return reject('recovery', 'limit_exceeded', '恢复来源读取超过绑定上限');
        }
        const readStarted = nowMs();
        readState.count += 1;
        let verified;
        try {
          verified = await deps.verifier.readVerifiedContent(projectId, artifactId);
          if (verified.contentHash !== ref.contentHash || verified.sizeBytes !== ref.sizeBytes) {
            throw new Error('recovery_content_mismatch');
          }
        } catch (cause) {
          reads.push({ purpose, artifactId, contentHash: null, sizeBytes: null,
            durationMs: Math.max(0, nowMs() - readStarted), outcome: 'failed', detail: 'recovery_source_invalid' });
          return reject('recovery', 'recovery_source_invalid', '恢复来源正文不可读或已损坏', { cause });
        }
        readState.totalBytes += verified.sizeBytes;
        reads.push({ purpose, artifactId, contentHash: verified.contentHash, sizeBytes: verified.sizeBytes,
          durationMs: Math.max(0, nowMs() - readStarted), outcome: 'read', detail: null });
        await checkDeadline();
      };
      await resolveSourceArtifact(source.nativeArchiveRef, source.sourceDigest, '原生归档');
      if (source.kind === 'checkpoint') {
        await resolveSourceArtifact(source.checkpointRef, null, '检查点');
      }
      /* 来源 Attempt 必须存在（Work 用途）；其未停止已由第 3 步重叠检查拒绝。 */
      if (source.purpose === 'work') {
        try {
          const sourceAttempt = deps.attempts.getAttempt(projectId, source.sourceAttemptId);
          if (sourceAttempt.taskId !== attempt.taskId ||
              (ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(sourceAttempt.status)) {
            throw new Error('source_attempt_identity_or_stop_mismatch');
          }
        } catch (cause) {
          return reject('recovery', 'recovery_source_invalid', '恢复来源 Attempt 不存在', {
            details: { sourceAttemptId: source.sourceAttemptId },
            cause,
          });
        }
      }
    }

    const descriptor: RuntimeRecoveryCapabilities | undefined =
      deps.recoveryCatalog?.resolve(validated.strategy.runtime);
    const recoveryRequest = {
      schemaVersion: RUNTIME_EXECUTION_SCHEMA_VERSION,
      projectId,
      sessionId: validated.sessionId,
      executionVersion: attempt.executionVersion,
      identity: { purpose: 'work' as const, runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id },
      invocationId: validated.invocationId,
      strategy: validated.strategy,
      recovery: selection,
    };
    let decision = decideRuntimeRecovery(recoveryRequest, descriptor);
    if (decision.mode === 'resume') {
      try {
        if (deps.recovery === undefined) throw new Error('recovery_authority_unavailable');
        /* 能力可用不等于来源获准：复用 P03-3A 对停止证据/输入/代码/权限的完整预检。 */
        decision = await deps.recovery.evaluate(recoveryRequest);
      } catch (cause) {
        recoveryRecord = { ...recoveryRecord, decision: 'rejected', reasons: ['source_authorization_failed'] };
        return reject('recovery', 'recovery_source_invalid', '恢复来源授权预检未通过', { cause });
      }
    }
    if (recordedRecovery !== undefined &&
        (recordedRecovery.decision.mode !== decision.mode ||
         (decision.mode === 'resume' && recordedRecovery.decision.mode === 'resume' &&
          recordedRecovery.decision.kind !== decision.kind))) {
      return reject('recovery', 'recovery_decision_changed', '输入快照记录的实际续接决策与当前能力/授权不一致');
    }
    recoveryRecord = {
      ...recoveryRecord,
      decision: decision.mode,
      reasons: decision.reasons,
    };
    if (decision.mode === 'rejected') {
      return reject('recovery', 'recovery_rejected', 'required 恢复被能力/证据拒绝（绝不降级）', {
        details: { reasons: [...decision.reasons] },
      });
    }
    const requestRecovery =
      decision.mode === 'resume' ? selection : ({ mode: 'new' } as const);

    /* ---- 9. 组装请求并终验 + 发布绑定证据 ---- */
    const toInputRef = (part: 'manifest' | 'prompt', kind: string): ExecutionInputRef => {
      const body = snapshot.group[part];
      return {
        projectId,
        artifactId: body.artifactId,
        kind,
        purpose: part,
        version: body.version,
        contentHash: body.contentHash,
        sizeBytes: body.sizeBytes,
        locator: body.locator,
        mediaType: body.mediaType,
        origin: { kind: 'artifact' },
      };
    };
    const request: RuntimeExecutionRequest = validateRuntimeExecutionRequest({
      schemaVersion: RUNTIME_EXECUTION_SCHEMA_VERSION,
      projectId,
      featureId: attempt.featureId,
      sessionId: validated.sessionId,
      executionVersion: attempt.executionVersion,
      owner: { principalId: attempt.owner, hostInstanceId: attempt.hostInstanceId },
      identity: { purpose: 'work', runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id },
      invocationId: validated.invocationId,
      strategy: validated.strategy,
      prompt: toInputRef('prompt', groupArtifactKinds.prompt),
      inputManifest: toInputRef('manifest', groupArtifactKinds.manifest),
      cwd: { root: validated.cwdRoot, relativePath: posixRelative },
      permissions: { grants: [...validated.permissions.grants], isolation: validated.permissions.isolation },
      limits: validated.limits,
      recovery: requestRecovery,
      ...(validated.workAccess === undefined ? {} : { workAccess: validated.workAccess }),
    });

    await checkDeadline();
    const evidence = buildEvidence('bound', null);
    const evidenceRef = await publishEvidence(evidence);
    const reader = createReader(projectId, boundInputs, expectedKinds, readState, startedAtMs);
    return { request, reader, evidence, evidenceRef };
  }

  /** 发布按 Attempt 关联的证据制品（成功路径失败即绑定失败，证据是必须产物）。 */
  async function publishEvidence(
    evidence: ExecutionInputReadEvidence,
  ): Promise<BoundExecutionInputRef> {
    const body = Buffer.from(stableStringify(evidence), 'utf8');
    let published;
    try {
      published = await deps.publisher.publishArtifact({
        projectId: evidence.projectId,
        kind: EXECUTION_INPUT_READ_EVIDENCE_ARTIFACT_KIND,
        mediaType: EXECUTION_INPUT_READ_EVIDENCE_MEDIA_TYPE,
        expectedHash: sha256Hex(body),
        locator: `${EXECUTION_INPUT_READ_EVIDENCE_LOCATOR_PREFIX}/${evidence.attemptId}/binding`,
        content: [body],
      });
    } catch (cause) {
      throw new ExecutionInputBindingError('input', 'evidence_publish_failed', `${OPERATION}: 读取证据发布失败`, {
        cause,
      });
    }
    const record = published.artifact;
    return {
      purpose: 'read-evidence',
      artifactId: record.id,
      version: record.version,
      contentHash: record.contentHash ?? sha256Hex(body),
      sizeBytes: record.sizeBytes ?? body.byteLength,
      locator: record.locator,
      mediaType: record.mediaType,
    };
  }

  /** 读取端口错误 → 受限读取能力失败（脱敏原因，不含绝对路径/正文）。 */
  function readerReadError(cause: unknown, ref: BoundExecutionInputRef): ExecutionInputBindingError {
    const detail = { purpose: ref.purpose, artifactId: ref.artifactId };
    if (isStorageError(cause, 'not_found')) {
      return new ExecutionInputBindingError('input', 'input_missing', 'BoundExecutionInputReader.read: 制品缺失', { details: detail, cause });
    }
    if (isStorageError(cause, 'ownership')) {
      return new ExecutionInputBindingError('input', 'input_cross_project', 'BoundExecutionInputReader.read: 跨项目归属', { details: detail, cause });
    }
    if (isArtifactVerifyError(cause, 'corrupt')) {
      return new ExecutionInputBindingError('input', 'input_corrupt', 'BoundExecutionInputReader.read: 正文损坏', { details: detail, cause });
    }
    if (isArtifactVerifyError(cause, 'conflict')) {
      return new ExecutionInputBindingError('input', 'input_not_ready', 'BoundExecutionInputReader.read: 制品非 ready', { details: detail, cause });
    }
    return new ExecutionInputBindingError('input', 'input_unreadable', 'BoundExecutionInputReader.read: 读取失败', { details: detail, cause });
  }

  /** 受限读取能力：白名单用途 + 逐项身份复核 + 有界字节/次数/耗时。 */
  function createReader(
    projectId: string,
    boundInputs: readonly BoundExecutionInputRef[],
    expectedKinds: ReadonlyMap<string, string>,
    readState: { count: number; totalBytes: number },
    startedAtMs: number,
  ): BoundExecutionInputReader {
    const refs = boundInputs.map((ref) => ({ ...ref }));
    const byPurpose = new Map(refs.map((ref) => [ref.purpose, ref]));
    return {
      list(): readonly BoundExecutionInputRef[] {
        return refs.map((ref) => ({ ...ref }));
      },
      async read(purpose: unknown): Promise<BoundExecutionInputBody> {
        if (typeof purpose !== 'string') {
          throw validationError({ operation: 'BoundExecutionInputReader.read' }, 'purpose', '必须是非空字符串');
        }
        const ref = byPurpose.get(purpose);
        if (ref === undefined) {
          throw new ExecutionInputBindingError('input', 'unbound_input_read', 'BoundExecutionInputReader.read: 用途不在本次绑定集合内', {
            details: { purpose },
          });
        }
        if (readState.count >= limits.maxReads) {
          throw new ExecutionInputBindingError('input', 'limit_exceeded', 'BoundExecutionInputReader.read: 读取次数超限', {
            details: { limit: 'maxReads', max: limits.maxReads },
          });
        }
        readState.count += 1;
        if (nowMs() - startedAtMs > limits.maxReadDurationMs) {
          throw new ExecutionInputBindingError('input', 'limit_exceeded', 'BoundExecutionInputReader.read: 读取耗时超限', {
            details: { limit: 'maxReadDurationMs', max: limits.maxReadDurationMs },
          });
        }
        let record;
        try {
          record = await deps.artifacts.getArtifact(projectId, ref.artifactId);
        } catch (cause) {
          throw readerReadError(cause, ref);
        }
        if (record.status !== 'ready' ||
            record.version !== ref.version ||
            record.contentHash !== ref.contentHash ||
            record.sizeBytes !== ref.sizeBytes ||
            record.locator !== ref.locator ||
            record.mediaType !== ref.mediaType ||
            record.kind !== expectedKinds.get(ref.purpose)) {
          throw new ExecutionInputBindingError('input', 'input_identity_mismatch', 'BoundExecutionInputReader.read: 绑定引用与权威索引漂移', {
            details: { purpose: ref.purpose, artifactId: ref.artifactId },
          });
        }
        if (ref.sizeBytes > limits.maxItemBytes || readState.totalBytes + ref.sizeBytes > limits.maxTotalBytes) {
          throw new ExecutionInputBindingError('input', 'limit_exceeded', 'BoundExecutionInputReader.read: 读取字节超限', {
            details: { limit: ref.sizeBytes > limits.maxItemBytes ? 'maxItemBytes' : 'maxTotalBytes' },
          });
        }
        /* await 前预留字节，避免并发读取共同越过总量上限；失败读取同样消耗额度。 */
        readState.totalBytes += ref.sizeBytes;
        let verified;
        try {
          verified = await deps.verifier.readVerifiedContent(projectId, ref.artifactId);
        } catch (cause) {
          throw readerReadError(cause, ref);
        }
        if (verified.contentHash !== ref.contentHash || verified.sizeBytes !== ref.sizeBytes) {
          throw new ExecutionInputBindingError('input', 'input_corrupt', 'BoundExecutionInputReader.read: 正文实测摘要与绑定引用不一致', {
            details: { purpose: ref.purpose, artifactId: ref.artifactId },
          });
        }
        if (nowMs() - startedAtMs > limits.maxReadDurationMs) {
          throw new ExecutionInputBindingError('input', 'limit_exceeded', 'BoundExecutionInputReader.read: 正文读取完成时已超时');
        }
        return {
          purpose: ref.purpose,
          artifactId: ref.artifactId,
          contentHash: verified.contentHash,
          sizeBytes: verified.sizeBytes,
          content: verified.content,
        };
      },
    };
  }
}
