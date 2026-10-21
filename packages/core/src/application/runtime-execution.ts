/**
 * P03-6 / F-001 Runtime 执行会话服务（application 层：可信注册消费 +
 * 适配器句柄的契约包装；只依赖 ports 窄接口，无任何 I/O 与 SDK）。
 *
 * 设计依据：core-design/14 §1（Core 拥有授权与停止核验，适配器不更新业务表）、
 * input/p03-fake-runtime.md FR-1（事件流结束、cancel accepted、result completed
 * 都不能替代 stopped 确认；重复/迟到结果不生效）。
 *
 * 职责：
 * - start 前拒绝：请求结构（StorageError validation）→ 配置能力目录
 *   （RuntimeError configuration）→ 注册表解析（missing_runtime）→ 描述符
 *   provider/model 复核（configuration）→ 权限授予/隔离可落实性（permission）；
 * - start 后包装：适配器产出（事件/结果/停止证据/取消回执）逐项运行时校验；
 *   适配器抛出的非 RuntimeError 归为 process（start/result/stopped/cancel
 *   分别带 adapter_start_failed 等受限原因），适配器契约违约为 protocol；
 * - 四个事实互相独立：eventsEnded、resultSettled、cancelAccepted、stopConfirmed
 *   分别由事件流自然结束、result 校验通过、cancel 回执 accepted、stopped 证据
 *   各自驱动，任何一项都不推出其他项；
 * - result 只结算一次：会话层自持有 Promise，适配器的迟到/重复产出不改变已
 *   结算结果；未知终态等 protocol 违约使 result 拒绝而非伪造 failed；
 * - 未知公开事件保留受限诊断（有界条目、有界长度、不透传 payload），事件序列
 *   必须严格递增（倒退/重复为 protocol），事件数量超出请求政策上限即
 *   protocol(event_limit_exceeded)；
 * - 本服务不做预算预占、不写业务库、不决定 Task 验收、不实现超时看门狗
 *   （超时政策是请求字段，执行与停止路径属 F-010）。
 */
import { validateRuntimeRecoveryRecording } from '../ports/runtime-recovery-recording.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { validateRuntimeStrategyCapabilities } from '../ports/runtime-capabilities.js';
import { isStorageError } from '../ports/errors.js';
import type {
  RuntimeAdapter,
  RuntimeCancelReceipt,
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeHandle,
  RuntimeStopEvidence,
} from '../ports/runtime-execution.js';
import {
  classifyRuntimeEvent,
  isRuntimeError,
  RuntimeError,
  RUNTIME_SESSION_DIAGNOSTICS_MAX_COUNT,
  validateRuntimeCancelReceipt,
  validateRuntimeExecutionRequest,
  validateRuntimeExecutionResult,
  validateRuntimeStopEvidence,
} from '../ports/runtime-execution.js';
import type { RuntimeRegistry, RuntimeAdapterDescriptor } from '../ports/runtime-registry.js';

/** 会话状态快照：四项事实互相独立；stopConfirmed 在 stopped 未结算时为 null。 */
export interface RuntimeSessionStatus {
  readonly invocationId: string;
  readonly eventsEnded: boolean;
  readonly resultSettled: boolean;
  readonly cancelAccepted: boolean;
  readonly stopConfirmed: boolean | null;
}

/** Core 侧会话句柄：全部产出已校验；事件流只能消费一次。 */
export interface RuntimeSession {
  readonly invocationId: string;
  readonly recoveryRecording?: RuntimeHandle['recoveryRecording'];
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly result: Promise<RuntimeExecutionResult>;
  readonly stopped: Promise<RuntimeStopEvidence>;
  query(): RuntimeSessionStatus;
  cancel(): Promise<RuntimeCancelReceipt>;
  /** 受限诊断（未知公开事件等）：有界条目，不含未知 payload。 */
  diagnostics(): readonly string[];
}

export interface RuntimeExecutionService {
  /** Pure capability/permission preflight; never calls the adapter. */
  prepare(request: unknown): RuntimeAdapterDescriptor;
  start(request: unknown): Promise<RuntimeSession>;
}

export interface RuntimeExecutionServiceDeps {
  readonly configuration: RuntimeCapabilityCatalog;
  readonly registry: RuntimeRegistry;
}

function assertHandleShape(value: unknown): RuntimeHandle {
  const raw = value as Partial<RuntimeHandle> | null | undefined;
  if (
    raw === null || typeof raw !== 'object' ||
    typeof (raw.events as AsyncIterable<unknown> | undefined)?.[Symbol.asyncIterator] !== 'function' ||
    typeof (raw.result as Promise<unknown> | undefined)?.then !== 'function' ||
    typeof (raw.stopped as Promise<unknown> | undefined)?.then !== 'function' ||
    typeof raw.cancel !== 'function'
  ) {
    throw new RuntimeError('protocol', 'invalid_handle');
  }
  return raw as RuntimeHandle;
}

export function createRuntimeExecutionService(deps: RuntimeExecutionServiceDeps): RuntimeExecutionService {
  function prepare(value: unknown) {
    const request: RuntimeExecutionRequest = validateRuntimeExecutionRequest(value);
    const strategyContext = { operation: 'RuntimeExecution.start' };
    try {
      validateRuntimeStrategyCapabilities(request.strategy, deps.configuration, strategyContext, 'request.strategy');
    } catch (error) {
      if (isStorageError(error, 'validation')) {
        const reason = (error.details as { reason?: string } | undefined)?.reason ?? 'incompatible_strategy';
        throw new RuntimeError('configuration', reason);
      }
      throw error;
    }
    const entry = deps.registry.resolve(request.strategy.runtime);
    if (entry === undefined) throw new RuntimeError('missing_runtime', 'runtime_not_registered');
    const descriptor = entry.descriptor;
    if (descriptor.runtimeId !== request.strategy.runtime) {
      throw new RuntimeError('configuration', 'descriptor_runtime_mismatch');
    }
    const provider = descriptor.providers.find((candidate) => candidate.providerId === request.strategy.provider);
    if (provider === undefined) throw new RuntimeError('configuration', 'incompatible_provider');
    if (provider.models !== undefined && provider.models.length > 0 &&
        !provider.models.includes(request.strategy.model)) {
      throw new RuntimeError('configuration', 'unsupported_model');
    }
    for (const grant of request.permissions.grants) {
      if (!descriptor.permissionGrants.includes(grant)) {
        throw new RuntimeError('permission', 'grant_not_enforceable', { field: 'request.permissions.grants' });
      }
    }
    if (!descriptor.isolationModes.includes(request.permissions.isolation)) {
      throw new RuntimeError('permission', 'isolation_not_providable', { field: 'request.permissions.isolation' });
    }

    return entry;
  }
  return {
    prepare(value) { return prepare(value).descriptor; },
    async start(value: unknown): Promise<RuntimeSession> {
      const request = validateRuntimeExecutionRequest(value);
      const entry = prepare(request);
      let handle: RuntimeHandle;
      try {
        handle = assertHandleShape(await entry.adapter.start(request));
      } catch (error) {
        if (isRuntimeError(error)) throw error;
        throw new RuntimeError('process', 'adapter_start_failed', { cause: error });
      }

      const state = { eventsEnded: false, resultSettled: false, cancelAccepted: false, stopConfirmed: null as boolean | null };
      const diagnostics: string[] = [];
      const recordDiagnostic = (entryText: string): void => {
        if (diagnostics.length < RUNTIME_SESSION_DIAGNOSTICS_MAX_COUNT) {
          diagnostics.push(entryText.slice(0, 200));
        } else if (diagnostics.length === RUNTIME_SESSION_DIAGNOSTICS_MAX_COUNT) {
          diagnostics.push('diagnostics_overflow');
        }
      };

      const recoveryRecording = handle.recoveryRecording?.then(value => value === null ? null : validateRuntimeRecoveryRecording(value));
      void recoveryRecording?.catch(() => undefined);
      const result = new Promise<RuntimeExecutionResult>((resolve, reject) => {
        Promise.resolve(handle.result).then((raw) => {
          let validated: RuntimeExecutionResult;
          try {
            validated = validateRuntimeExecutionResult(raw);
          } catch (error) {
            reject(isRuntimeError(error) ? error : new RuntimeError('protocol', 'invalid_result', { cause: error }));
            return;
          }
          state.resultSettled = true;
          resolve(validated);
        }, (error: unknown) => {
          reject(isRuntimeError(error) ? error : new RuntimeError('process', 'adapter_result_failed', { cause: error }));
        });
      });
      // 结果拒绝必须由消费方观察；未观察时静默保留在句柄上（不触发 unhandled）。
      result.catch(() => undefined);

      const stopped = new Promise<RuntimeStopEvidence>((resolve, reject) => {
        Promise.resolve(handle.stopped).then((raw) => {
          let evidence: RuntimeStopEvidence;
          try {
            evidence = validateRuntimeStopEvidence(raw);
          } catch (error) {
            reject(isRuntimeError(error) ? error : new RuntimeError('protocol', 'invalid_stop_evidence', { cause: error }));
            return;
          }
          state.stopConfirmed = evidence.confirmed;
          resolve(evidence);
        }, (error: unknown) => {
          reject(isRuntimeError(error) ? error : new RuntimeError('process', 'adapter_stopped_failed', { cause: error }));
        });
      });
      stopped.catch(() => undefined);

      let consumed = false;
      const events: AsyncIterable<RuntimeEvent> = {
        [Symbol.asyncIterator]() {
          if (consumed) throw new RuntimeError('protocol', 'events_already_consumed');
          consumed = true;
          return iterator();
        },
      };
      async function* iterator(): AsyncGenerator<RuntimeEvent> {
        let count = 0;
        let lastSequence = 0;
        try {
          for await (const raw of handle.events) {
            count += 1;
            if (count > request.limits.maxEvents) {
              throw new RuntimeError('protocol', 'event_limit_exceeded');
            }
            const classified = classifyRuntimeEvent(raw);
            if (classified.outcome === 'unknown') {
              recordDiagnostic(`unknown_event:${classified.observedKind}`);
              continue;
            }
            if (classified.outcome === 'invalid') {
              throw new RuntimeError('protocol', classified.reason);
            }
            const event = classified.event;
            if (event.sequence <= lastSequence) {
              throw new RuntimeError('protocol', 'sequence_not_monotonic');
            }
            lastSequence = event.sequence;
            yield event;
          }
          state.eventsEnded = true;
        } catch (error) {
          if (isRuntimeError(error)) throw error;
          throw new RuntimeError('process', 'adapter_events_failed', { cause: error });
        }
      }

      return {
        invocationId: request.invocationId,
        recoveryRecording,
        events,
        result,
        stopped,
        query(): RuntimeSessionStatus {
          return { invocationId: request.invocationId, ...state };
        },
        async cancel(): Promise<RuntimeCancelReceipt> {
          let raw: unknown;
          try {
            raw = await handle.cancel();
          } catch (error) {
            if (isRuntimeError(error)) throw error;
            throw new RuntimeError('process', 'cancel_failed', { cause: error });
          }
          const receipt = validateRuntimeCancelReceipt(raw);
          if (receipt.accepted) state.cancelAccepted = true;
          return receipt;
        },
        diagnostics(): readonly string[] {
          return [...diagnostics];
        },
      };
    },
  };
}
