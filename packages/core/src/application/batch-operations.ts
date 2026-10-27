/**
 * P05-9 / F-005 Batch 操作应用门面。
 *
 * 该门面只统一应用入口，不拥有 Batch/Run/预算/停止状态机：
 * - preview/start/pause/resume/cancel 经过既有 CommandService，因而继续使用
 *   commandId 回执幂等、授权、revision CAS、stale preview 和持久派发语义；
 * - observe 组合既有有界 delivery/control 查询，不从日志或内存状态推断完成；
 * - finalize 复用既有叶子汇总服务，并要求可信装配显式提供授权判断。
 *
 * 门面不等待 Git、模型、网络或进程；外部执行由下层服务在命令提交后负责。
 */
import { PublicError } from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import type { BatchControlDetailResult } from '../ports/execution-control-query.js';
import type { PublicBatchDeliveryResult } from '../ports/batch-delivery-query.js';
import type { CommandService } from './command-service.js';
import type { QueryService } from './query-service.js';
import type {
  BatchFinalizationRunRequest,
  BatchFinalizationRunResult,
  BatchLeafFinalizationService,
} from './batch-leaf-finalization.js';

export interface BatchOperationsObserveInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface BatchOperationsBlockingChainEntry {
  readonly featureId: string;
  readonly failurePredecessors: readonly string[];
  readonly blockingReasons: readonly string[];
}

export interface BatchOperationsObservation {
  readonly delivery: PublicBatchDeliveryResult;
  readonly control: BatchControlDetailResult;
  /** Stable, read-only dependency/blocking projection for operators. */
  readonly blockingChain: readonly BatchOperationsBlockingChainEntry[];
}

export interface BatchOperationsService {
  preview(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  start(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  pause(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  resume(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  cancel(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  observe(principal: unknown, input: BatchOperationsObserveInput): Promise<BatchOperationsObservation>;
  finalize(principal: unknown, request: BatchFinalizationRunRequest): Promise<BatchFinalizationRunResult>;
  /** Descriptive alias for callers that use the delivery vocabulary. */
  finish(principal: unknown, request: BatchFinalizationRunRequest): Promise<BatchFinalizationRunResult>;
}

export interface BatchOperationsServiceDeps {
  readonly commands: Pick<CommandService, 'submit'>;
  readonly queries: Pick<QueryService, 'getBatchDelivery' | 'getBatchControl'>;
  readonly finalization?: BatchLeafFinalizationService;
  /** Trusted authorization hook; request payloads cannot grant this capability. */
  readonly authorizeFinalization?: (principal: unknown, request: BatchFinalizationRunRequest) => void | Promise<void>;
}

const COMMAND_OPERATION_BY_METHOD = {
  preview: 'execution.preview',
  start: 'execution.start',
  pause: 'execution.pause',
  resume: 'execution.resume',
  cancel: 'execution.cancel',
} as const;

type BatchCommandMethod = keyof typeof COMMAND_OPERATION_BY_METHOD;

function invalidOperation(method: BatchCommandMethod, received: unknown, expected: string): never {
  throw new PublicError('invalid_input', `batch.${method}`, undefined, {
    details: {
      field: 'operation',
      reason: 'unexpected_operation',
      expected,
      ...(typeof received === 'string' ? { received } : {}),
    },
  });
}

function commandOperation(envelope: unknown): unknown {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return undefined;
  return (envelope as { readonly operation?: unknown }).operation;
}

function assertCommandOperation(method: BatchCommandMethod, envelope: unknown): void {
  const expected = COMMAND_OPERATION_BY_METHOD[method];
  const received = commandOperation(envelope);
  if (received !== expected) invalidOperation(method, received, expected);
}

function blockingChain(delivery: PublicBatchDeliveryResult): readonly BatchOperationsBlockingChainEntry[] {
  return delivery.records.map(record => ({
    featureId: record.featureId,
    failurePredecessors: [...record.failurePredecessors],
    blockingReasons: [...record.blockingReasons],
  }));
}

function validateDeps(deps: BatchOperationsServiceDeps): void {
  if (deps === null || typeof deps !== 'object') throw new TypeError('BatchOperations dependencies are required');
  if (deps.commands === null || typeof deps.commands !== 'object' || typeof deps.commands.submit !== 'function') {
    throw new TypeError('BatchOperations dependency commands.submit is required');
  }
  if (deps.queries === null || typeof deps.queries !== 'object'
    || typeof deps.queries.getBatchDelivery !== 'function'
    || typeof deps.queries.getBatchControl !== 'function') {
    throw new TypeError('BatchOperations Batch delivery/control query services are required');
  }
  if (deps.finalization !== undefined
    && (deps.finalization === null || typeof deps.finalization !== 'object' || typeof deps.finalization.run !== 'function')) {
    throw new TypeError('BatchOperations finalization service must provide run');
  }
  if (deps.authorizeFinalization !== undefined && typeof deps.authorizeFinalization !== 'function') {
    throw new TypeError('BatchOperations authorizeFinalization must be a function');
  }
}

/** Assemble the Batch facade from existing application services. */
export function createBatchOperationsService(deps: BatchOperationsServiceDeps): BatchOperationsService {
  validateDeps(deps);

  async function submitCommand(method: BatchCommandMethod, principal: unknown, envelope: unknown): Promise<CommandReceipt> {
    // The underlying CommandService remains the authority for full envelope validation,
    // authorization, idempotency, CAS and durable receipts. This narrow check prevents
    // accidentally routing an action through the wrong facade method in trusted callers.
    assertCommandOperation(method, envelope);
    return deps.commands.submit(principal, envelope);
  }

  async function observe(principal: unknown, input: BatchOperationsObserveInput): Promise<BatchOperationsObservation> {
    const deliveryInput = {
      projectId: input.projectId,
      batchId: input.batchId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    };
    const [delivery, control] = await Promise.all([
      deps.queries.getBatchDelivery(principal, deliveryInput),
      deps.queries.getBatchControl(principal, { projectId: input.projectId, batchId: input.batchId }),
    ]);
    return { delivery, control, blockingChain: blockingChain(delivery) };
  }

  async function finalize(principal: unknown, request: BatchFinalizationRunRequest): Promise<BatchFinalizationRunResult> {
    if (deps.finalization === undefined || deps.authorizeFinalization === undefined) {
      throw new PublicError('unsupported', 'batch.finalize', undefined, {
        details: { reason: 'batch_finalization_not_assembled' },
      });
    }
    await deps.authorizeFinalization(principal, request);
    // The finalization service owns leaf enumeration, candidate persistence, external
    // integration/verification and command replay. Do not duplicate or retry it here.
    return deps.finalization.run(request);
  }

  return {
    preview: (principal, envelope) => submitCommand('preview', principal, envelope),
    start: (principal, envelope) => submitCommand('start', principal, envelope),
    pause: (principal, envelope) => submitCommand('pause', principal, envelope),
    resume: (principal, envelope) => submitCommand('resume', principal, envelope),
    cancel: (principal, envelope) => submitCommand('cancel', principal, envelope),
    observe,
    finalize,
    finish: finalize,
  };
}

/** Compatibility name for callers that describe this entry as a facade. */
export type BatchOperationsFacade = BatchOperationsService;
export const createBatchOperationsFacade = createBatchOperationsService;
