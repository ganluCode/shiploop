import type { AttemptRecord, WorkspaceLeaseRecord } from './attempt-store.js';
import { validateAttemptInputSnapshot } from './attempt-store.js';
import type { PreparedExecutionInputGroup } from './execution-input-prepare.js';
import type { VerifiedWorkWorkspace } from './work-resources.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId, validationError } from './validation.js';

export interface TaskClaimInput {
  readonly claimKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly expectedRevision: number;
  /** Expected current Task fence, not a native Session/request/checkpoint identity. */
  readonly executionVersion: number;
  readonly workspace: VerifiedWorkWorkspace;
  readonly leaseUntilUtcMs: number;
  readonly inputSnapshot: PreparedExecutionInputGroup;
  /** F-012：返工认领时受信 Runner 预生成的新 Attempt 稳定 ID（快照返工身份
   * 必须与其一致；普通首次认领缺省，由认领事务自行生成）。 */
  readonly attemptId?: string;
  /** F-003：准备阶段冻结的 Core launch 身份；claim 回执会原样保留它。 */
  readonly launch?: {
    readonly sessionId: string;
    readonly invocationId: string;
    readonly parentSessionId?: string | null;
  };
}
export interface TaskClaimReceipt {
  readonly schemaVersion: 1;
  readonly claimKey: string;
  readonly batchId: string;
  readonly attempt: AttemptRecord;
  readonly taskRevision: number;
  readonly reservationId: string;
  readonly leases: readonly WorkspaceLeaseRecord[];
  readonly counts: { readonly batchAttempts: number; readonly runAttempts: number;
    readonly taskAttempts: number; readonly codeAttempts: number };
  readonly eventId: string;
  /** F-003：准备阶段冻结的 Core launch 身份，若存在则不能由启动事务改写。 */
  readonly launch?: {
    readonly sessionId: string;
    readonly invocationId: string;
    readonly parentSessionId: string | null;
  };
}
export interface TaskClaimResult {
  /** Historical replay is evidence, never permission to start another invocation. */
  readonly replayed: boolean;
  readonly receipt: TaskClaimReceipt;
}
export interface TaskClaimStore {
  /** Returns only after committing its own short synchronous write transaction. */
  claimTask(input: unknown): TaskClaimResult;
}

export function validateTaskClaimInput(value: unknown, inspectWorkspace: (token: unknown) => VerifiedWorkWorkspace): TaskClaimInput {
  const context = { operation: 'TaskClaim.validate' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['claimKey', 'projectId', 'runId', 'taskId', 'owner', 'hostInstanceId',
    'expectedRevision', 'executionVersion', 'workspace', 'leaseUntilUtcMs', 'inputSnapshot', 'attemptId', 'launch'], context, 'input');
  const id = (key: string) => validateStableId(raw[key], context, key);
  const integer = (key: string, minimum: number) => {
    const n = raw[key];
    if (!Number.isSafeInteger(n) || Number(n) < minimum || Number(n) >= Number.MAX_SAFE_INTEGER) {
      throw validationError(context, key, 'invalid_safe_integer');
    }
    return n as number;
  };
  const launch = raw.launch === undefined || raw.launch === null ? undefined : (() => {
    const value = requirePlainObject(raw.launch, context, 'launch');
    rejectUnknownKeys(value, ['sessionId', 'invocationId', 'parentSessionId'], context, 'launch');
    return {
      sessionId: validateStableId(value.sessionId, context, 'launch.sessionId'),
      invocationId: validateStableId(value.invocationId, context, 'launch.invocationId'),
      parentSessionId: value.parentSessionId === undefined || value.parentSessionId === null
        ? null : validateStableId(value.parentSessionId, context, 'launch.parentSessionId'),
    };
  })();
  return { claimKey: id('claimKey'), projectId: id('projectId'), runId: id('runId'), taskId: id('taskId'),
    owner: id('owner'), hostInstanceId: id('hostInstanceId'), expectedRevision: integer('expectedRevision', 1),
    executionVersion: integer('executionVersion', 0), leaseUntilUtcMs: integer('leaseUntilUtcMs', 1),
    workspace: inspectWorkspace(raw.workspace), inputSnapshot: validateAttemptInputSnapshot(raw.inputSnapshot),
    ...(raw.attemptId === undefined || raw.attemptId === null ? {} : { attemptId: id('attemptId') }),
    ...(launch === undefined ? {} : { launch }) };
}
