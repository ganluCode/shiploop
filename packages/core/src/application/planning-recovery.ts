/**
 * P05-1 / F-010 规划启动恢复编排（application 层）。
 *
 * 编排顺序（每个窗口先做事务外受信核验，再由 SQLite 原语在短事务内幂等补完）：
 * 1. 一致读扫描 planning 上下文/Run/Attempt/Session/派发归属，得到窗口分类；
 * 2. 窗口 A（候选文件已发布但登记未完成）：读取受管候选制品正文（有界
 *    verified 读取），校验 schema/身份/摘要与上下文绑定一致；同一 candidateId
 *    存在多份不同内容的 ready 制品时视为歧义（unresolved），不补完；
 *    核验通过后补完 planning_contexts 登记（发布 CAS 复用，同身份重放幂等）；
 * 3. 窗口 B（有效候选已登记但 Run 未结束）：读取 runtime-settlement 制品正文，
 *    要求 Runtime 结果 completed、无失败、required 记录完整且停止确认；任一
 *    缺失保留 interrupted 与诊断；通过后同一短事务补完 Attempt/Task/Run 终态、
 *    预算结算、Session 停止/水位、占用释放与工作区 retained；
 * 4. 窗口 C（Run 已终态但唤醒/观察丢失）：核对 Session 停止、水位无缺口、
 *    Attempt/Run 终态一致后释放仍隔离的占用与派发归属；
 * 5. 窗口 D（批准应用已提交但响应丢失）：只核对 applied 上下文与已导入
 *    coding Task/决策事实一致；不一致记录诊断（不重复导入、不改正文）。
 *
 * 本模块不实现：模型调用、计划导入、Runtime 启动、原生库打开；不重开终态
 * Run；不释放停止不明的现场（fail-closed）。
 */
import { PLANNING_CANDIDATE_ARTIFACT_KIND } from '../ports/planning-candidates.js';
import {
  computePlanningCandidateDigest,
  validatePlanningCandidatePayload,
} from '../ports/planning-candidates.js';
import {
  PLANNING_RECOVERY_SCHEMA_VERSION,
} from '../ports/planning-recovery.js';
import type {
  PlanningCandidateRegistrationCompletionInput,
  PlanningOutcomeCompletionInput,
  PlanningRecoveryDeps,
  PlanningRecoveryGapReason,
  PlanningRecoveryOutcome,
  PlanningRecoveryScanRow,
  PlanningRecoveryWindow,
  PlanningStartupRecovery,
  PlanningStartupRecoveryResult,
} from '../ports/planning-recovery.js';

const CANDIDATE_MAX_READ_BYTES = 1_048_576 + 65_536;
const SETTLEMENT_MAX_READ_BYTES = 262_144;

interface SettlementArtifactBody {
  readonly identity?: { readonly sessionId?: unknown; readonly invocationId?: unknown };
  readonly execution?: {
    readonly result?: {
      readonly terminal?: unknown;
      readonly exitCode?: unknown;
    } | null;
    readonly failure?: { readonly kind?: unknown; readonly reason?: unknown } | null;
  };
  readonly recording?: {
    readonly complete?: unknown;
    readonly watermark?: unknown;
    readonly gaps?: unknown;
  };
  readonly stop?: {
    readonly evidence?: { readonly confirmed?: unknown } | null;
    readonly failure?: unknown;
  } | null;
}

function gap(value: PlanningRecoveryGapReason): PlanningRecoveryGapReason {
  return value;
}

/** 纯文本解码 + JSON 解析（有界；失败归一为 corrupt 类 gap）。 */
function parseJsonBody(content: Uint8Array, maxBytes: number): { parsed: unknown } | { corrupt: true } {
  if (content.byteLength > maxBytes) return { corrupt: true };
  try {
    return { parsed: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown };
  } catch {
    return { corrupt: true };
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createPlanningStartupRecovery(deps: PlanningRecoveryDeps): PlanningStartupRecovery {
  const now = deps.nowMs ?? Date.now;
  return {
    async recover(): Promise<PlanningStartupRecoveryResult> {
      const outcomes: PlanningRecoveryOutcome[] = [];
      /* 有界多遍：一个窗口补完后同一 Run 可能进入下一个窗口（A→B→C）；
       * 无新完成或达到上限即停止（重复恢复不重复写入）。 */
      for (let pass = 0; pass < 4; pass += 1) {
        const rows = deps.store.scan();
        let progressed = false;
        for (const row of rows) {
          if (row.window === 'none') continue;
          const outcome = await recoverRow(row);
          outcomes.push(outcome);
          if (outcome.status === 'completed') progressed = true;
        }
        if (!progressed) break;
      }
      const blocked = outcomes.some(outcome => outcome.status === 'unresolved');
      return { status: blocked ? 'blocked' : 'complete', outcomes };
    },
  };

  async function recoverRow(row: PlanningRecoveryScanRow): Promise<PlanningRecoveryOutcome> {
    try {
      switch (row.window) {
        case 'candidate_publication_incomplete':
          return await recoverPublicationIncomplete(row);
        case 'candidate_registered_run_open':
          return await recoverRegisteredRunOpen(row);
        case 'run_finished_observation_lost':
          return await recoverFinishedObservationLost(row);
        case 'decision_receipt_lost':
          return verifyDecisionReceiptLost(row);
        default:
          return {
            window: 'decision_receipt_lost', status: 'consistent', projectId: row.projectId,
            runId: row.runId, attemptId: row.attemptId, gaps: [], completedSteps: [],
          };
      }
    } catch (error) {
      /* 单窗口补完失败不拖垮整次恢复：保留现场并记录诊断（fail-closed）。 */
      const details = (error as { details?: { reason?: unknown } } | null)?.details;
      const reason = typeof details?.reason === 'string' ? details.reason : 'planning_recovery_window_failed';
      const window: PlanningRecoveryWindow = row.window === 'none' || row.window === 'consistent'
        ? 'decision_receipt_lost' : row.window;
      const outcome: PlanningRecoveryOutcome = {
        window, status: 'unresolved', projectId: row.projectId, runId: row.runId,
        attemptId: row.attemptId, gaps: ['attempt_not_recoverable'], completedSteps: [],
      };
      deps.store.recordDiagnostic({ projectId: row.projectId, runId: row.runId, attemptId: row.attemptId,
        window, status: 'unresolved', gaps: [reason] });
      return outcome;
    }
  }

  /** 窗口 A：候选文件已发布但登记未完成 → 核验后补完登记（一次有效发布）。 */
  async function recoverPublicationIncomplete(row: PlanningRecoveryScanRow): Promise<PlanningRecoveryOutcome> {
    const base = { window: 'candidate_publication_incomplete' as const, projectId: row.projectId, runId: row.runId, attemptId: row.attemptId };
    const gaps: PlanningRecoveryGapReason[] = [];
    const ready = row.candidateArtifacts.filter(artifact => artifact.status === 'ready');
    if (row.candidateArtifacts.length === 0) gaps.push(gap('candidate_artifact_missing'));
    else if (ready.length === 0) gaps.push(gap('candidate_artifact_not_ready'));
    const digests = new Set<string>();
    let registered: PlanningCandidateRegistrationCompletionInput | null = null;
    if (gaps.length === 0) {
      for (const artifact of ready) {
        if (artifact.contentHash === null || !artifact.locator.startsWith(`planning/candidates/${row.runId}/${row.candidateId}/`)) {
          gaps.push(gap('candidate_identity_mismatch'));
          break;
        }
        let content: Uint8Array;
        try {
          const read = await deps.verifier.readVerifiedContent(row.projectId, artifact.artifactId);
          if (read.contentHash !== artifact.contentHash) throw new Error('hash_drift');
          content = read.content;
        } catch {
          gaps.push(gap('candidate_artifact_corrupt'));
          break;
        }
        const parsed = parseJsonBody(content, CANDIDATE_MAX_READ_BYTES);
        if ('corrupt' in parsed) {
          gaps.push(gap('candidate_content_invalid'));
          break;
        }
        try {
          const candidate = validatePlanningCandidatePayload(parsed.parsed, { operation: PLANNING_CANDIDATE_ARTIFACT_KIND });
          if (candidate.projectId !== row.projectId || candidate.featureId !== row.featureId
            || candidate.runId !== row.runId || candidate.candidateId !== row.candidateId) {
            gaps.push(gap('candidate_identity_mismatch'));
            break;
          }
          const digest = computePlanningCandidateDigest(candidate);
          digests.add(digest);
          registered = {
            projectId: row.projectId, runId: row.runId, candidateId: row.candidateId,
            artifactId: artifact.artifactId, contentHash: artifact.contentHash,
            candidateDigest: digest, summary: candidate.summary,
          };
        } catch {
          gaps.push(gap('candidate_content_invalid'));
          break;
        }
      }
    }
    if (gaps.length === 0 && digests.size > 1) gaps.push(gap('candidate_artifact_ambiguous'));
    if (gaps.length > 0 || registered === null) {
      const outcome = { ...base, status: 'unresolved' as const, gaps, completedSteps: [] };
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps });
      return outcome;
    }
    const result = deps.store.completeRegistration(registered);
    if (result.outcome === 'rejected') {
      const rejected = { ...base, status: 'unresolved' as const, gaps: [gap('candidate_identity_mismatch')], completedSteps: [] };
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps: rejected.gaps as readonly string[] });
      return rejected;
    }
    return {
      ...base, status: 'completed', gaps: [],
      completedSteps: result.outcome === 'replayed' ? ['candidate_registration_replayed'] : ['candidate_registration'],
    };
  }

  /** 窗口 B：有效候选已登记但 Run 未结束 → 核验 settlement 制品后补完终态结算。 */
  async function recoverRegisteredRunOpen(row: PlanningRecoveryScanRow): Promise<PlanningRecoveryOutcome> {
    const base = { window: 'candidate_registered_run_open' as const, projectId: row.projectId, runId: row.runId, attemptId: row.attemptId };
    const gaps: PlanningRecoveryGapReason[] = [];
    if (row.attemptId === null || row.sessionId === null) gaps.push(gap('attempt_not_recoverable'));
    const artifact = row.settlementArtifact;
    if (artifact === null) gaps.push(gap('settlement_artifact_missing'));
    else if (artifact.status !== 'ready') gaps.push(gap('settlement_artifact_not_ready'));
    let completion: PlanningOutcomeCompletionInput | null = null;
    if (gaps.length === 0 && artifact !== null && row.attemptId !== null && row.sessionId !== null) {
      let content: Uint8Array;
      try {
        const read = await deps.verifier.readVerifiedContent(row.projectId, artifact.artifactId);
        if (read.contentHash !== artifact.contentHash) throw new Error('hash_drift');
        content = read.content;
      } catch {
        gaps.push(gap('settlement_artifact_corrupt'));
        content = new Uint8Array();
      }
      if (gaps.length === 0) {
        const parsed = parseJsonBody(content, SETTLEMENT_MAX_READ_BYTES);
        if ('corrupt' in parsed) gaps.push(gap('settlement_artifact_corrupt'));
        else {
          const body = (parsed.parsed ?? {}) as SettlementArtifactBody;
          const identity = body.identity ?? {};
          if (asString(identity.sessionId) !== row.sessionId) gaps.push(gap('settlement_identity_mismatch'));
          const result = body.execution?.result ?? null;
          const failure = body.execution?.failure ?? null;
          if (result === null || result.terminal !== 'completed') gaps.push(gap('settlement_result_incomplete'));
          if (failure !== null && failure !== undefined) gaps.push(gap('settlement_result_incomplete'));
          const recording = body.recording ?? {};
          if (recording.complete !== true) gaps.push(gap('settlement_recording_incomplete'));
          const stopEvidence = body.stop?.evidence ?? null;
          if (stopEvidence === null || stopEvidence.confirmed !== true || body.stop?.failure != null) {
            gaps.push(gap('settlement_stop_unconfirmed'));
          }
          if (gaps.length === 0) {
            const watermark = typeof recording.watermark === 'number' && Number.isSafeInteger(recording.watermark)
              ? recording.watermark : null;
            const exitCode = typeof result?.exitCode === 'number' && Number.isSafeInteger(result.exitCode) ? result.exitCode : null;
            completion = {
              projectId: row.projectId, runId: row.runId, attemptId: row.attemptId,
              settlementArtifactId: artifact.artifactId, settlementContentHash: artifact.contentHash!,
              sessionId: row.sessionId, invocationId: asString(identity.invocationId) ?? '',
              exitCode, watermark, startedAtUtcMs: null,
            };
          }
        }
      }
    }
    if (gaps.length > 0 || completion === null) {
      const outcome = { ...base, status: 'unresolved' as const, gaps, completedSteps: [] };
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps });
      return outcome;
    }
    const result = deps.store.completeOutcome(completion);
    if (result.outcome === 'rejected') {
      const rejectedGaps = [gap(result.reason === 'run_control_won' ? 'run_control_won'
        : result.reason === 'session_not_stopped_conflict' ? 'session_not_stopped' : 'attempt_not_recoverable')];
      const outcome = { ...base, status: 'unresolved' as const, gaps: rejectedGaps, completedSteps: [] };
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps: rejectedGaps });
      return outcome;
    }
    return {
      ...base, status: 'completed', gaps: [],
      completedSteps: result.outcome === 'replayed'
        ? ['planning_outcome_replayed']
        : ['planning_outcome_settled', 'occupancy_released', 'dispatch_released'],
    };
  }

  /** 窗口 C：Run 已终态但唤醒/观察丢失 → 核对停止/水位后释放仍保留的占用。 */
  async function recoverFinishedObservationLost(row: PlanningRecoveryScanRow): Promise<PlanningRecoveryOutcome> {
    const base = { window: 'run_finished_observation_lost' as const, projectId: row.projectId, runId: row.runId, attemptId: row.attemptId };
    const gaps: PlanningRecoveryGapReason[] = [];
    if (row.attemptId === null) gaps.push(gap('attempt_not_recoverable'));
    if (row.sessionStatus !== 'stopped') gaps.push(gap('session_not_stopped'));
    if (row.recordingWatermark === null) gaps.push(gap('recording_watermark_missing'));
    if (row.recordingGaps.length > 0) gaps.push(gap('recording_gaps_present'));
    if (gaps.length > 0 || row.attemptId === null) {
      const outcome = { ...base, status: 'unresolved' as const, gaps, completedSteps: [] };
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps });
      return outcome;
    }
    const result = deps.store.releaseObservation({ projectId: row.projectId, runId: row.runId, attemptId: row.attemptId });
    if (result.outcome === 'rejected') {
      const outcome = { ...base, status: 'unresolved' as const, gaps: [gap('occupancy_release_unconfirmed')], completedSteps: [] };
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps: outcome.gaps });
      return outcome;
    }
    return {
      ...base, status: 'completed', gaps: [],
      completedSteps: result.outcome === 'replayed' ? ['observation_release_replayed'] : ['occupancy_released', 'dispatch_released'],
    };
  }

  /** 窗口 D：批准应用已提交但响应丢失 → 只核对一致性（重放由命令幂等承担）。 */
  function verifyDecisionReceiptLost(row: PlanningRecoveryScanRow): PlanningRecoveryOutcome {
    const base = { window: 'decision_receipt_lost' as const, projectId: row.projectId, runId: row.runId, attemptId: row.attemptId };
    const gaps: PlanningRecoveryGapReason[] = [];
    if (row.contextStatus !== 'applied') gaps.push(gap('applied_consistency_mismatch'));
    const outcome: PlanningRecoveryOutcome = gaps.length > 0
      ? { ...base, status: 'unresolved', gaps, completedSteps: [] }
      : { ...base, status: 'consistent', gaps, completedSteps: [] };
    if (gaps.length > 0) {
      deps.store.recordDiagnostic({ ...base, window: base.window, status: 'unresolved', gaps });
    }
    return outcome;
  }
}

/** 供装配/测试复核的恢复记录 schema 版本（与事件负载一致）。 */
export const PLANNING_STARTUP_RECOVERY_SCHEMA = PLANNING_RECOVERY_SCHEMA_VERSION;
