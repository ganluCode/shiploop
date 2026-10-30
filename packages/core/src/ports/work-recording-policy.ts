/**
 * P07-2 / F-001 统一有界记录策略（ports 契约层：纯常量与纯校验，无 I/O）。
 *
 * 目标：复用现有 RuntimeExecutionRequest.limits（ports/runtime-execution.ts）、
 * WorkEvidenceRecorderLimits（ports/work-evidence-recorder.ts）、正文发布限制
 * （ports/work-recording.ts）与 Runner 队列硬上限（host/runtime/pi-runner-protocol.ts
 * 的 PI_RUNNER_BUFFER_EVENTS=64 / PI_RUNNER_BUFFER_BYTES=64KiB，协议常量，不可配
 * 置），把它们组合成一个可信装配在启动前校验的策略对象。本文件不引入任何新的
 * 可配置旋钮，也不建立第二套配置系统：所有字段都来自上述既有限制类型。
 *
 * 计量范围、有限默认值与硬上限（默认值即生产装配 work-execution.ts 的现行值，
 * 保持兼容；硬上限沿用各既有契约）：
 *
 * | 计量 | 字段（所属契约） | 默认值 | 硬上限 |
 * | --- | --- | --- | --- |
 * | 单事件 | recorder.maxEventBodyBytes | 8_192 | 65_536 |
 * | 单块事件数/字节 | recorder.chunkMaxEvents / chunkMaxBytes | 32 / 262_144 | 10_000 / 1_048_576 |
 * | 累计输出（Runtime 事件流） | request.maxEvents / maxOutputBytes（每 Attempt） | 装配按预算给出 | 100_000 / 8_388_608 |
 * | 累计磁盘写入（事件证据） | recorder.maxTotalEvents / maxTotalBytes | 10_000 / 8_000_000 | 100_000 / 8_388_608 |
 * | 累计磁盘写入（公开正文） | publish.maxTotalBytes（每条消息） | 262_144 | 8_388_608 |
 * | 队列事件数/字节（Runner 通道） | PI_RUNNER_BUFFER_EVENTS / PI_RUNNER_BUFFER_BYTES（协议常量） | 64 / 65_536 | 固定 |
 * | 队列字节（发布器排队） | publish.maxQueueBytes | 8_192 | 1_048_576 |
 * | 整体采集/发布期限 | request.timeoutMs（从 record 开始，共用单调绝对期限） | 装配按预算给出 | 86_400_000 |
 * | 尾部等待期限 | recorder.tailWaitMs（不得越过整体期限） | 2_000 | 600_000 |
 * | 发布期限（Artifact staging） | artifactPublication.timeoutMs | 30_000 | 有限安全整数 |
 * | 失败收尾期限 | 一次 tailWaitMs 保留预算，包含取消等待、排空、未完成发布清理与失败 Manifest | — | tailWaitMs 上限 |
 *
 * 限制间关系（启动前校验，违约即拒绝装配）：
 * - recorder.maxEventBodyBytes ≤ recorder.chunkMaxBytes ≤ recorder.maxTotalBytes；
 * - recorder.chunkMaxEvents ≤ recorder.maxTotalEvents ≤ RUNTIME_EXECUTION_MAX_EVENTS_LIMIT（由硬上限隐含）；
 * - publish.maxQueueBytes ≥ publish.maxChunkBytes；publish.maxBodyBytes 与
 *   publish.maxAttachmentBytes 各自 ≤ publish.maxTotalBytes；
 * - recorder.maxTotalBytes 与 publish.maxTotalBytes 均不得超过 Artifact 发布端口
 *   自身的 maxSizeBytes 预算（否则记录会先撞上制品端口预算而非自身有界停止）。
 * - reorderWindow 保留既有零值语义（0 = 不接受任何乱序）。
 *
 * 实际适用范围（不夸大）：本策略只约束 Core 侧记录/发布路径的内存与磁盘计量。
 * 它不能限制已授权工具对工作区、仓库或任意路径的写入，不能阻止同用户恶意进程
 * 直接读取或写入文件，也不是 OS 沙箱；Runner 通道上限只约束 Host↔Runner 事件
 * 通道的排队，超过即按协议失败（runner_buffer_overflow），不静默丢弃。
 */
import type { WorkEvidenceRecorderLimits } from './work-evidence-recorder.js';
import { validateWorkEvidenceRecorderLimits } from './work-evidence-recorder.js';
import type { RequiredWorkRecordingPublishLimits, WorkRecordingPublishLimits } from './work-recording.js';
import { validateWorkRecordingPublishLimits } from './work-recording.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const WORK_RECORDING_POLICY_SCHEMA_VERSION = 1;

/** 生产装配默认：与 adapters/work-execution.ts 现行常量逐项一致（兼容承诺）。 */
export const DEFAULT_WORK_RECORDING_RECORDER_LIMITS: WorkEvidenceRecorderLimits = {
  maxEventBodyBytes: 8_192,
  chunkMaxEvents: 32,
  chunkMaxBytes: 262_144,
  maxTotalEvents: 10_000,
  maxTotalBytes: 8_000_000,
  reorderWindow: 8,
  tailWaitMs: 2_000,
};

export const DEFAULT_WORK_RECORDING_PUBLISH_LIMITS: RequiredWorkRecordingPublishLimits = {
  maxBodyBytes: 131_072,
  maxAttachmentBytes: 65_536,
  maxTotalBytes: 262_144,
  maxChunkBytes: 8_192,
  maxQueueBytes: 8_192,
  maxAttachments: 32,
};

export const DEFAULT_WORK_RECORDING_ARTIFACT_PUBLICATION: Readonly<{
  maxSizeBytes: number;
  timeoutMs: number;
}> = { maxSizeBytes: 16_000_000, timeoutMs: 30_000 };

/** 统一有界记录策略：全部字段来自既有限制类型，无新增旋钮。 */
export interface WorkRecordingBoundPolicy {
  readonly schemaVersion: typeof WORK_RECORDING_POLICY_SCHEMA_VERSION;
  readonly recorder: WorkEvidenceRecorderLimits;
  readonly publish: RequiredWorkRecordingPublishLimits;
  /** Artifact 发布端口自身预算（发布期限 = timeoutMs）。 */
  readonly artifactPublication: { readonly maxSizeBytes: number; readonly timeoutMs: number };
}

function safePositiveInteger(value: unknown, context: ValidationContext, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw validationError(context, field, '必须是 ≥1 的有限安全整数', value);
  }
  return value;
}

/**
 * 可信装配启动前校验：先按各既有契约逐项校验（拒绝非有限数、非安全整数、
 * 负数、非法零值与超硬上限），再校验限制间关系。任何违约都在装配期失败，
 * 不允许带病启动；运行时事件不能提高任何限制。
 */
export function validateWorkRecordingBoundPolicy(
  value: unknown,
  context: ValidationContext = { operation: 'WorkRecording.boundPolicy' },
  field = 'policy',
): WorkRecordingBoundPolicy {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['schemaVersion', 'recorder', 'publish', 'artifactPublication'], context, field);
  if (object.schemaVersion !== WORK_RECORDING_POLICY_SCHEMA_VERSION) {
    throw validationError(context, `${field}.schemaVersion`, `仅支持版本 ${WORK_RECORDING_POLICY_SCHEMA_VERSION}`, object.schemaVersion);
  }
  const recorder = validateWorkEvidenceRecorderLimits(object.recorder, context, `${field}.recorder`);
  const publish = validateWorkRecordingPublishLimits(object.publish, context, `${field}.publish`);
  const artifactRaw = requirePlainObject(object.artifactPublication, context, `${field}.artifactPublication`);
  rejectUnknownKeys(artifactRaw, ['maxSizeBytes', 'timeoutMs'], context, `${field}.artifactPublication`);
  const artifactPublication = {
    maxSizeBytes: safePositiveInteger(artifactRaw.maxSizeBytes, context, `${field}.artifactPublication.maxSizeBytes`),
    timeoutMs: safePositiveInteger(artifactRaw.timeoutMs, context, `${field}.artifactPublication.timeoutMs`),
  };
  if (recorder.maxEventBodyBytes > recorder.chunkMaxBytes) {
    throw validationError(context, `${field}.recorder.maxEventBodyBytes`, '不得大于 chunkMaxBytes（单事件必须能落入单块）', recorder.maxEventBodyBytes);
  }
  if (recorder.chunkMaxBytes > recorder.maxTotalBytes) {
    throw validationError(context, `${field}.recorder.chunkMaxBytes`, '不得大于 maxTotalBytes（单块必须落在累计磁盘预算内）', recorder.chunkMaxBytes);
  }
  if (recorder.chunkMaxEvents > recorder.maxTotalEvents) {
    throw validationError(context, `${field}.recorder.chunkMaxEvents`, '不得大于 maxTotalEvents', recorder.chunkMaxEvents);
  }
  if (publish.maxBodyBytes > publish.maxTotalBytes) {
    throw validationError(context, `${field}.publish.maxBodyBytes`, '不得大于 publish.maxTotalBytes（单正文必须落在单消息预算内）', publish.maxBodyBytes);
  }
  if (publish.maxAttachmentBytes > publish.maxTotalBytes) {
    throw validationError(context, `${field}.publish.maxAttachmentBytes`, '不得大于 publish.maxTotalBytes', publish.maxAttachmentBytes);
  }
  if (recorder.maxTotalBytes > artifactPublication.maxSizeBytes) {
    throw validationError(context, `${field}.recorder.maxTotalBytes`, '不得超过 artifactPublication.maxSizeBytes（记录预算必须能被制品端口承载）', recorder.maxTotalBytes);
  }
  if (publish.maxTotalBytes > artifactPublication.maxSizeBytes) {
    throw validationError(context, `${field}.publish.maxTotalBytes`, '不得超过 artifactPublication.maxSizeBytes', publish.maxTotalBytes);
  }
  return { schemaVersion: WORK_RECORDING_POLICY_SCHEMA_VERSION, recorder, publish, artifactPublication };
}

export const DEFAULT_WORK_RECORDING_BOUND_POLICY: WorkRecordingBoundPolicy = {
  schemaVersion: WORK_RECORDING_POLICY_SCHEMA_VERSION,
  recorder: DEFAULT_WORK_RECORDING_RECORDER_LIMITS,
  publish: DEFAULT_WORK_RECORDING_PUBLISH_LIMITS,
  artifactPublication: DEFAULT_WORK_RECORDING_ARTIFACT_PUBLICATION,
};
