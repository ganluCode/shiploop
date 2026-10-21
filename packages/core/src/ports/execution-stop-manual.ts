/** P04-7 / F-006：停止 operation 的受限人工处置契约。
 *
 * 人工动作是事实确认/处置意图的审计记录，不是通用进程控制器：它不能
 * 伪造 stopped、释放租约、启动 Attempt 或覆盖既有停止证据。真正的 probe
 * 由提交后的既有 ExecutionStopControlPort 完成。
 */
import { rejectUnknownKeys, requirePlainObject, validateStableId, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

export const EXECUTION_STOP_MANUAL_OPERATION = 'execution.stop.manual' as const;
export const EXECUTION_STOP_MANUAL_ACTIONS = [
  'acknowledge', 'quarantine', 'retry_probe', 'release_confirmed', 'mark_unresolved',
] as const;
export type ExecutionStopManualAction = (typeof EXECUTION_STOP_MANUAL_ACTIONS)[number];

export interface ValidatedExecutionStopManualPayload {
  readonly stopOperationId: string;
  readonly action: ExecutionStopManualAction;
  /** 只接受 Core 已发布的 evidence/artifact 引用，不接受正文、路径或 PID。 */
  readonly evidenceRef: string | null;
}

const context: ValidationContext = { operation: EXECUTION_STOP_MANUAL_OPERATION };

export function validateExecutionStopManualPayload(value: unknown): ValidatedExecutionStopManualPayload {
  const raw = requirePlainObject(value, context, 'payload');
  rejectUnknownKeys(raw, ['stopOperationId', 'action', 'evidenceRef'], context, 'payload');
  const action = raw.action;
  if (typeof action !== 'string' || !(EXECUTION_STOP_MANUAL_ACTIONS as readonly string[]).includes(action)) {
    throw validationError(context, 'payload.action', '不支持的人工处置动作');
  }
  if (raw.evidenceRef !== null && typeof raw.evidenceRef !== 'string') {
    throw validationError(context, 'payload.evidenceRef', '必须是 evidence 引用或 null');
  }
  return {
    stopOperationId: validateStableId(raw.stopOperationId, context, 'payload.stopOperationId'),
    action: action as ExecutionStopManualAction,
    evidenceRef: raw.evidenceRef as string | null,
  };
}

export interface ExecutionStopManualActionInput {
  readonly projectId: string;
  readonly stopOperationId: string;
  readonly commandId: string;
  readonly actorId: string;
  readonly action: ExecutionStopManualAction;
  readonly evidenceRef: string | null;
  readonly expectedRevision: number;
}

export interface ExecutionStopManualActionResult {
  readonly disposition: 'accepted' | 'replayed';
  readonly operationId: string;
  readonly action: ExecutionStopManualAction;
  readonly auditRef: string;
  readonly revision: number;
  readonly stopConfirmed: boolean | null;
  readonly status: 'stopping' | 'stopped' | 'uncertain';
  /** release_confirmed 仅在既有 stopped + stopConfirmed=true 时可被接受。 */
  readonly releaseEligible: boolean;
}
