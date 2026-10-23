/** Core-owned Work tool bridge. Never pass these dependencies or bind/revoke to a Runner. */
import { createHash, randomBytes } from 'node:crypto';
import { assertTrustedPrincipal, requireCapability, requireProjectVisible } from '../ports/authorization.js';
import {
  PublicError, WORK_TOOL_OPERATION_SPECS, validateCommandEnvelopeFields, evaluateCommandTiming,
  createCompletedReceipt, createRejectedReceipt,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { computeCommandRequestDigest, createResultRef, decideCommandReplay, stableCanonicalJson } from '../ports/command-receipts.js';
import type { CommandReplayDecision } from '../ports/command-receipts.js';
import { buildWorkAccessManifest, validateWorkAccessConfiguration } from '../ports/work-access.js';
import type { WorkAccessBinding, WorkAccessContext, WorkAccessOperation } from '../ports/work-access.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { TaskDagStore } from '../ports/task-dag.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import type { ArtifactPublishResult, ArtifactPublisher } from './artifact-publish.js';
import { isArtifactPublishError } from './artifact-publish.js';
import type { VerificationCandidateValidator } from './verification-candidates.js';
import type { TestCandidateValidationInput } from '../ports/verification-candidates.js';
import type { PlanningContextRecord } from '../ports/planning-context.js';
import {
  PLANNING_CANDIDATE_ARTIFACT_KIND,
  PLANNING_CANDIDATE_ARTIFACT_MEDIA_TYPE,
  PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES,
  PLANNING_CANDIDATE_SUBMIT_OPERATION,
  PLANNING_RUN_PURPOSE,
  validatePlanningCandidatePayload,
} from '../ports/planning-candidates.js';
import type { ValidatedPlanningCandidate } from '../ports/planning-candidates.js';
import { isStorageError } from '../ports/errors.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId } from '../ports/validation.js';

/**
 * P05-1 / F-006：规划候选受限提交常量（正文上限/kind/mediaType 冻结于
 * ports/planning-candidates；同 grant 内在途提交上限为本通道装配边界）。
 * - 正文入口只接受有界 JSON 文本（UTF-8 字节上限；F-001 契约的语义上限远小于
 *   此，该上限只是入口防滥用边界，不是候选合法性依据）；
 * - 发布为受管 Artifact（正文由 Core 持有，模型不能自带 artifactId/文件路径/
 *   数据库访问）；
 * - 同 commandId+digest 的并发提交共享同一执行（双提交竞争只产生一份副作用）；
 *   超限 resource_busy，不无限累积在途 Promise。
 */
export const WORK_TOOL_PLANNING_MAX_INFLIGHT_SUBMITS = 64;

const candidateBodyEncoder = new TextEncoder();

export interface WorkToolChannelDeps {
  /** All synchronous readers must share the atomicStore connection/transaction. */
  readonly atomicStore: AtomicCommandStore;
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  readonly dag: TaskDagStore;
  /** Trusted live Host/Core authority: null revokes the grant. Never derive this from a request/sessionId. */
  readonly currentBinding: (context: WorkAccessContext) => WorkAccessBinding | null;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  readonly candidates: Pick<VerificationCandidateValidator, 'validateCandidates'>;
  /** Approved policy and observed code/workspace, never supplied by the model. */
  readonly candidateContext: (context: WorkAccessContext) => Pick<TestCandidateValidationInput, 'policy' | 'workspaceRoot' | 'codeDigest'>;
  /**
   * P05-1 / F-006：规划候选受管发布装配（可选）。缺失装配时
   * planning.candidate.submit 拒绝（fail-closed），其余操作不受影响；
   * 规划上下文的读取/发布绑定经 CommandTransaction 原语在同一短事务内完成。
   */
  readonly planning?: { readonly publisher: Pick<ArtifactPublisher, 'publishArtifact'> };
}

export interface WorkTaskResult {
  readonly operation: 'task.read';
  readonly task: { readonly id: string; readonly title: string; readonly status: string; readonly acceptance: unknown };
}
export interface WorkToolBridge {
  invoke(request: unknown): Promise<CommandReceipt | WorkTaskResult>;
  /** Host/Core only; in-flight operations recheck before persisting. */
  revoke(): void;
}

function denied(reason: string): never {
  throw new PublicError('forbidden', 'work.tools.invoke', undefined, { details: { reason } });
}

/** 提交失败原因定位（有界脱敏：只保留字段路径字符，不回显候选正文）。 */
function candidateFieldLocator(error: unknown): string {
  if (isStorageError(error) && typeof error.details?.field === 'string') {
    const field = error.details.field.replace(/[^A-Za-z0-9_.[\]-]/g, '').slice(0, 96);
    if (field.length > 0) return `:${field}`;
  }
  return '';
}

export function createWorkToolChannel(deps: WorkToolChannelDeps) {
  // Host-instance-local grants. Restart requires trusted reissuance; no credentials or owner discovery.
  const grants = new Set<string>();
  return {
    bind(value: unknown, binding: WorkAccessBinding): WorkToolBridge {
      assertTrustedPrincipal(binding.principal);
      const access = buildWorkAccessManifest(value, binding).access;
      const context = access.context;
      Object.freeze(context.identity);
      Object.freeze(context.operations);
      Object.freeze(context);
      if (grants.has(context.grantId)) denied('grant_already_issued');
      let revoked = false;
      /** P05-1 / F-006：同 commandId+digest 的在途规划提交共享执行（双提交竞争只产生一份副作用）。 */
      const flights = new Map<string, Promise<CommandReceipt>>();
      /** 规划上下文状态门槛：新提交只接受 open；重放先于本检查命中持久回执。 */
      function requirePlanningOpen(record: PlanningContextRecord): void {
        if (record.status === 'open') return;
        if (record.status === 'candidate_published') {
          throw new PublicError('conflict', PLANNING_CANDIDATE_SUBMIT_OPERATION, undefined, {
            details: { reason: 'candidate_already_published', candidateId: record.candidateId },
          });
        }
        if (record.status === 'cancelled') denied('planning_cancelled');
        throw new PublicError('conflict', PLANNING_CANDIDATE_SUBMIT_OPERATION, undefined, {
          details: { reason: 'planning_context_not_open', status: record.status },
        });
      }
      function check(transaction: CommandTransaction, operation: WorkAccessOperation) {
        if (revoked) denied('grant_revoked');
        const current = deps.currentBinding(context);
        if (current === null) denied('grant_revoked');
        validateWorkAccessConfiguration(access, current);
        requireCapability(current.principal, 'project.read', operation);
        requireProjectVisible(current.principal, context.projectId, operation);
        if (!context.operations.includes(operation)) denied('operation_denied');
        const attempt = deps.attempts.getAttempt(context.projectId, context.identity.attemptId);
        const run = transaction.getExecutionRun(context.projectId, context.identity.runId);
        const task = transaction.getTask(context.projectId, context.identity.taskId);
        const identityMismatch = attempt.runId !== run.id || attempt.taskId !== task.id || attempt.featureId !== task.featureId
          || run.featureId !== task.featureId || attempt.executionVersion !== context.executionVersion
          || attempt.hostInstanceId !== context.hostInstanceId || attempt.invocationId !== context.invocationId;
        let planning: PlanningContextRecord | null = null;
        // 统一读取 DAG 视图：提供 Batch 控制状态；规划提交仅跳过编码 fence 比对
        //（planning Task 不在业务计划视图内；其单 Attempt 语义由认领存储保证，
        // 无被新认领取代的执行版本漂移窗口），改为核对 Run purpose 与规划上下文绑定。
        const view = deps.dag.readTaskDagView(context.projectId, run.id);
        if (operation === PLANNING_CANDIDATE_SUBMIT_OPERATION) {
          if (deps.planning === undefined) denied('planning_channel_unavailable');
          if (identityMismatch || run.purpose !== PLANNING_RUN_PURPOSE) denied('identity_mismatch');
          planning = transaction.getPlanningContextByRun(context.projectId, context.identity.runId);
          if (planning === null
            || planning.runId !== run.id || planning.projectId !== context.projectId
            || planning.planningTaskId !== task.id || planning.planningTask.id !== task.id
            || planning.featureId !== task.featureId || planning.featureId !== run.featureId) denied('planning_identity_mismatch');
        } else {
          const fence = view.facts.find(fact => fact.taskId === task.id);
          if (identityMismatch || fence?.executionVersion !== context.executionVersion) denied('identity_mismatch');
        }
        if (attempt.status !== 'executing' || run.status !== 'running' || view.batch.status !== 'running' || task.status !== 'running'
          || attempt.leaseUntilUtcMs <= current.nowUtcMs) denied('execution_inactive');
        return { current, task, planning };
      }
      // Issue only for a currently executing Work, with authority independent of the declaration.
      deps.atomicStore.transact('work.tools.bind', tx => check(tx, context.operations[0]!));
      grants.add(context.grantId);
      return {
        revoke() { revoked = true; },
        async invoke(input: unknown) {
          const envelope = validateCommandEnvelopeFields(input, WORK_TOOL_OPERATION_SPECS);
          const operation = envelope.operation as WorkAccessOperation;
          const validation = { operation: 'work.tools.invoke' };
          const raw = requirePlainObject(envelope.payload, validation, 'payload');
          rejectUnknownKeys(raw, ['identity', 'invocationId', 'executionVersion',
            ...(operation === 'task.read' ? []
              : operation === PLANNING_CANDIDATE_SUBMIT_OPERATION ? ['candidate'] : ['artifactId'])], validation, 'payload');
          const identity = requirePlainObject(raw.identity, validation, 'payload.identity');
          rejectUnknownKeys(identity, ['purpose', 'runId', 'taskId', 'attemptId'], validation, 'payload.identity');
          if (envelope.scope.kind !== 'project' || envelope.scope.projectId !== context.projectId
            || stableCanonicalJson(identity) !== stableCanonicalJson(context.identity)
            || raw.invocationId !== context.invocationId || raw.executionVersion !== context.executionVersion) denied('identity_mismatch');
          const artifactId = operation !== 'task.read' && operation !== PLANNING_CANDIDATE_SUBMIT_OPERATION
            ? validateStableId(raw.artifactId, validation, 'payload.artifactId') : null;
          // P05-1 / F-006：规划候选正文入口（有界 JSON 文本；无文件路径/artifactId）。
          let candidateText: string | null = null;
          if (operation === PLANNING_CANDIDATE_SUBMIT_OPERATION) {
            if (deps.planning === undefined) denied('planning_channel_unavailable');
            const text = raw.candidate;
            if (typeof text !== 'string' || text.length === 0) {
              throw new PublicError('invalid_input', operation, undefined, { details: { reason: 'candidate_body_invalid' } });
            }
            if (text.length > PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES
              || candidateBodyEncoder.encode(text).byteLength > PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES) {
              throw new PublicError('invalid_input', operation, undefined, {
                details: { reason: 'candidate_body_too_large', maxBytes: PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES },
              });
            }
            candidateText = text;
          }
          // Snapshot all untrusted values before asynchronous work.
          const normalized = { ...envelope, payload: {
            identity: { ...context.identity }, invocationId: context.invocationId, executionVersion: context.executionVersion,
            ...(artifactId === null ? {} : { artifactId }),
            ...(candidateText === null ? {} : { candidate: candidateText }),
          } };
          const digest = computeCommandRequestDigest(normalized);
          const replay = (tx: CommandTransaction) => {
            check(tx, operation); // includes current grant validity even on replay
            return decideCommandReplay(tx.findReceipt(context.principalId, envelope.commandId), digest, operation);
          };
          let planningSnapshot: PlanningContextRecord | null = null;
          const preliminary = deps.atomicStore.transact('work.tools.preflight', tx => {
            const state = check(tx, operation);
            if (operation !== 'task.read') {
              const decision = replay(tx);
              if (decision.kind === 'replay') return decision.receipt;
            }
            const timing = evaluateCommandTiming(envelope, state.current.nowUtcMs);
            if (timing.kind !== 'fresh') throw new PublicError(timing.kind === 'expired' ? 'command_expired' : 'invalid_input', operation);
            if (operation === 'task.read') {
              const { id, title, status, acceptance } = state.task;
              return { operation: 'task.read' as const, task: { id, title, status, acceptance } };
            }
            // 新提交（无持久回执）才要求上下文 open；已发布候选的替换企图在此早期冲突，不发布第二份 Artifact。
            if (operation === PLANNING_CANDIDATE_SUBMIT_OPERATION) {
              requirePlanningOpen(state.planning!);
              planningSnapshot = state.planning!;
            }
            return null;
          });
          if (preliminary !== null) return preliminary;
          if (operation === PLANNING_CANDIDATE_SUBMIT_OPERATION) {
            const key = `${envelope.commandId}\u0000${digest}`;
            const inFlight = flights.get(key);
            if (inFlight !== undefined) return inFlight; // 同命令同内容：共享执行与持久回执，不重复发布
            if (flights.size >= WORK_TOOL_PLANNING_MAX_INFLIGHT_SUBMITS) {
              throw new PublicError('resource_busy', operation, undefined, { details: { reason: 'planning_submit_busy' } });
            }
            const flight = executePlanningSubmit(envelope, digest, candidateText!, planningSnapshot!, replay)
              .finally(() => { flights.delete(key); });
            flights.set(key, flight);
            return flight;
          }
          let result: Record<string, unknown>;
          let rejection: string | null = null;
          // Existing managed verifier checks ready/hash/project; caller cannot supply paths or bytes.
          const content = await deps.verifier.readVerifiedContent(context.projectId, artifactId!);
          if (content.projectId !== context.projectId || content.artifactId !== artifactId) denied('artifact_identity_mismatch');
          if (operation === 'candidate.submit') {
            const candidate = await deps.candidates.validateCandidates({
              ...deps.candidateContext(context), projectId: context.projectId, attemptId: context.identity.attemptId,
              executionVersion: context.executionVersion, candidateArtifactId: artifactId,
            });
            if (!candidate.ok) rejection = candidate.reason;
            else if (candidate.artifact.artifactId !== content.artifactId || candidate.artifact.contentHash !== content.contentHash
              || candidate.artifact.sizeBytes !== content.sizeBytes) denied('artifact_identity_mismatch');
            result = candidate.ok ? { candidateDigest: candidate.candidateDigest, moduleCount: candidate.modules.length } : {};
          } else result = {};
          return deps.atomicStore.transact(operation, tx => {
            const decision = replay(tx);
            if (decision.kind === 'replay') return decision.receipt;
            const { current } = check(tx, operation);
            const ref = tx.getArtifactInputRef(context.projectId, artifactId!);
            if (ref.contentHash !== content.contentHash || ref.sizeBytes !== content.sizeBytes) denied('artifact_identity_mismatch');
            const receiptIdentity = {
              principalId: context.principalId, commandId: envelope.commandId, operation,
              scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt,
              completedAt: new Date(current.nowUtcMs).toISOString(),
            };
            const receipt = rejection === null ? createCompletedReceipt({
              ...receiptIdentity, resultRef: createResultRef(randomBytes(32)),
              result: { ...result, identity: context.identity, invocationId: context.invocationId,
                executionVersion: context.executionVersion, artifact: { artifactId, contentHash: ref.contentHash, sizeBytes: ref.sizeBytes },
                verificationPassed: false },
            }) : createRejectedReceipt({ ...receiptIdentity,
              error: new PublicError('invalid_input', operation, undefined, { details: { reason: rejection } }),
            });
            tx.saveReceipt(receipt); // submission fact and idempotency anchor; no Task/budget/lock mutation
            return receipt;
          });
        },
      };
      /** P05-1 / F-006：规划候选提交执行（事务外校验/发布 + 短事务重核/绑定/回执）。 */
      async function executePlanningSubmit(
        envelope: ReturnType<typeof validateCommandEnvelopeFields>,
        digest: string,
        text: string,
        snapshot: PlanningContextRecord,
        replay: (tx: CommandTransaction) => CommandReplayDecision,
      ): Promise<CommandReceipt> {
        const operation = PLANNING_CANDIDATE_SUBMIT_OPERATION;
        /* 1) 内容级校验（纯函数，事务外）：失败保留为不可审批诊断回执，不发布。 */
        let rejection: string | null = null;
        let candidate: ValidatedPlanningCandidate | null = null;
        let parsed: unknown;
        try { parsed = JSON.parse(text) as unknown; } catch { rejection = 'candidate_json_invalid'; }
        if (rejection === null) {
          try {
            const validated = validatePlanningCandidatePayload(parsed, { operation });
            if (validated.projectId !== snapshot.projectId || validated.featureId !== snapshot.featureId
              || validated.runId !== snapshot.runId || validated.candidateId !== snapshot.candidateId) {
              rejection = 'candidate_identity_mismatch';
            } else candidate = validated;
          } catch (error) {
            rejection = `candidate_invalid${candidateFieldLocator(error)}`;
          }
        }
        /* 2) 受管 Artifact 发布（Core 受控暂存；失败保留 pending/失败事实并如实抛出，不落回执）。 */
        let publication: ArtifactPublishResult | null = null;
        if (candidate !== null) {
          const body = candidateBodyEncoder.encode(text);
          try {
            publication = await deps.planning!.publisher.publishArtifact({
              projectId: context.projectId,
              kind: PLANNING_CANDIDATE_ARTIFACT_KIND,
              mediaType: PLANNING_CANDIDATE_ARTIFACT_MEDIA_TYPE,
              expectedHash: createHash('sha256').update(body).digest('hex'),
              locator: `planning/candidates/${snapshot.runId}/${snapshot.candidateId}/${envelope.commandId}.json`,
              content: [body],
            });
          } catch (error) {
            // 只携带阶段/类别枚举与失败记录事实，不含路径或正文。
            throw new PublicError('internal', operation, undefined, {
              details: { reason: 'candidate_publication_failed',
                ...(isArtifactPublishError(error) ? { stage: error.stage, code: error.code } : {}) },
              ...(isArtifactPublishError(error) ? { cause: error } : {}),
            });
          }
        }
        /* 3) 短事务：重核 grant/身份/状态 → 绑定发布（单候选 CAS）→ 保存回执。 */
        return deps.atomicStore.transact(operation, tx => {
          const decision = replay(tx);
          if (decision.kind === 'replay') return decision.receipt;
          const state = check(tx, operation);
          requirePlanningOpen(state.planning!);
          const receiptIdentity = {
            principalId: context.principalId, commandId: envelope.commandId, operation,
            scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt,
            completedAt: new Date(state.current.nowUtcMs).toISOString(),
          };
          if (rejection !== null || candidate === null) {
            const receipt = createRejectedReceipt({ ...receiptIdentity,
              error: new PublicError('invalid_input', operation, undefined, { details: { reason: rejection ?? 'candidate_invalid' } }),
            });
            tx.saveReceipt(receipt); // 失败输出的事实保留：不可审批诊断，规划上下文保持 open
            return receipt;
          }
          const artifact = publication!.artifact;
          const published = tx.publishPlanningCandidate({
            projectId: context.projectId, candidateId: candidate.candidateId,
            candidateDigest: candidate.candidateDigest, artifactId: artifact.id,
            contentHash: artifact.contentHash!, summary: candidate.summary,
          });
          const receipt = createCompletedReceipt({
            ...receiptIdentity, resultRef: createResultRef(randomBytes(32)),
            result: {
              candidateDigest: candidate.candidateDigest, planDigest: candidate.plan.planDigest,
              artifact: { artifactId: artifact.id, contentHash: artifact.contentHash!, sizeBytes: artifact.sizeBytes! },
              publication: published.outcome, identity: context.identity, invocationId: context.invocationId,
              executionVersion: context.executionVersion, verificationPassed: false,
            },
          });
          tx.saveReceipt(receipt); // 提交事实与幂等锚；不改 Task/预算/锁/批准状态
          return receipt;
        });
      }
    },
  };
}
