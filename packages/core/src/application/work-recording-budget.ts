/**
 * P07-2 / F-004 一次记录的累计磁盘额度账本（application 层，纯内存计量）。
 *
 * 设计依据：input/p07-recorder-bounds.md FR-1/验收 2、core-design/05 §5/§6。
 *
 * 语义：
 * - 一次记录（一次 record()）的全部落盘内容——事件分块 ndjson、公开消息/工具
 *   正文、附件与覆盖 Manifest——共享同一个累计额度 limitBytes（来自
 *   WorkEvidenceRecorderLimits.maxTotalBytes）。同一事件的重复存储（消息正文
 *   与事件分块各写一份）按各自写入分别计量；失败重试、原生补充或重新分块都
 *   不重新获得额度（申请不退还）。
 * - 额度拆成两池：正文（body：事件行/公开正文/附件）与收尾（finalization：
 *   成功/失败覆盖 Manifest）。finalizationReserveBytes 是为收尾保留的下限：
 *   正文累计申请不得超过 limitBytes − reserve，使收尾始终有有限额度可用；
 *   收尾申请可使用全部剩余（保留额度 + 正文未用完的部分）。
 * - 写入前申请（claim/claimExact），写入中/后按实测字节结算（settle）：
 *   ready 的以实测 sizeBytes 计入 writtenBytes；失败、短写与 staging 残留的
 *   申请计入 failedWriteBytes（不退还）；实测超过申请时如实记 oversoldBytes
 *   并继续扣减，绝不静默放行。claimed = written + failed + inFlight 恒成立。
 * - 并发发布在同一额度内竞争：申请是同步原子检查并扣减，不能超售。
 * - 本账本只约束记录器管理的写入，不扫描/清理全盘，不删除历史会话，也不是
 *   OS 磁盘配额；物理磁盘彻底不可写时（如真实 ENOSPC）Manifest 仍可能生成
 *   失败，由调用方走 SQLite 元数据回退（见 work-evidence-recorder.ts）。
 *
 * 本模块不做 I/O、不依赖 ports/adapters；import 无副作用。
 */

/** 额度池：正文（事件分块/公开正文/附件）与收尾（覆盖 Manifest）。 */
export type WorkRecordingStorageBudgetKind = 'body' | 'finalization';

/** 可核对账目快照：写入方与测试据此与磁盘实测字节核对。 */
export interface WorkRecordingStorageBudgetUsage {
  readonly limitBytes: number;
  readonly finalizationReserveBytes: number;
  /** 已申请字节总数（body + finalization；申请不退还）。 */
  readonly claimedBytes: number;
  /** 已结算为 ready 的实测字节。 */
  readonly writtenBytes: number;
  /** 失败/短写/staging 残留消耗的申请字节（不退还）。 */
  readonly failedWriteBytes: number;
  /** 实测超过申请的超售防御字节（如实记录并继续扣减）。 */
  readonly oversoldBytes: number;
  /** 已申请未结算的字节。 */
  readonly inFlightBytes: number;
  /** 正文池剩余可申请字节。 */
  readonly availableBodyBytes: number;
  /** 收尾池剩余可申请字节（保留额度 + 未用正文余量）。 */
  readonly availableFinalizationBytes: number;
  /** 正文池累计申请字节。 */
  readonly bodyClaimedBytes: number;
  /** 收尾池累计申请字节。 */
  readonly finalizationClaimedBytes: number;
}

export interface WorkRecordingStorageBudget {
  /** 流式申请：返回实际授予（0..bytes，部分授予可用前缀）。 */
  claim(kind: WorkRecordingStorageBudgetKind, bytes: number): number;
  /** 全有或全无申请：额度足够才授予并扣减，否则不消耗任何额度。 */
  claimExact(kind: WorkRecordingStorageBudgetKind, bytes: number): boolean;
  /** 按实测字节结算一次申请：failed=true 时整笔申请计入失败口径。 */
  settle(kind: WorkRecordingStorageBudgetKind, claimed: number, writtenBytes: number, failed: boolean): void;
  usage(): WorkRecordingStorageBudgetUsage;
}

/**
 * 收尾保留额度推导：min(chunkMaxBytes, floor(limitBytes / 4))。
 * 有限、由既有限制推导（不新增配置旋钮）；保证正文最多消耗 limitBytes −
 * reserve，收尾 Manifest 始终有 reserve 可用（Manifest 超出 reserve 时按
 * 额度不足失败并走 SQLite 元数据回退，不夸大保证）。
 */
export function workRecordingFinalizationReserve(limitBytes: number, chunkMaxBytes: number): number {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
    throw new Error('workRecordingFinalizationReserve: limitBytes 必须是 ≥1 的安全整数');
  }
  if (!Number.isSafeInteger(chunkMaxBytes) || chunkMaxBytes < 1) {
    throw new Error('workRecordingFinalizationReserve: chunkMaxBytes 必须是 ≥1 的安全整数');
  }
  return Math.min(chunkMaxBytes, Math.floor(limitBytes / 4));
}

function assertByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`WorkRecordingStorageBudget: ${label} 必须是 ≥0 的安全整数`);
  }
}

/** 创建一次记录的累计磁盘额度账本。同一记录内的所有写入方共享同一实例。 */
export function createWorkRecordingStorageBudget(input: {
  readonly limitBytes: number;
  readonly finalizationReserveBytes: number;
}): WorkRecordingStorageBudget {
  if (input === null || typeof input !== 'object') {
    throw new Error('WorkRecordingStorageBudget: input 必须是对象');
  }
  assertByteCount(input.limitBytes, 'limitBytes');
  if (input.limitBytes < 1) throw new Error('WorkRecordingStorageBudget: limitBytes 必须 ≥1');
  assertByteCount(input.finalizationReserveBytes, 'finalizationReserveBytes');
  if (input.finalizationReserveBytes > input.limitBytes) {
    throw new Error('WorkRecordingStorageBudget: 收尾保留额度不得超过总额度');
  }
  const limitBytes = input.limitBytes;
  const reserveBytes = input.finalizationReserveBytes;
  let bodyClaimed = 0;
  let finalizationClaimed = 0;
  let written = 0;
  let failed = 0;
  let oversold = 0;

  const availableFor = (kind: WorkRecordingStorageBudgetKind): number =>
    kind === 'body'
      ? Math.max(0, limitBytes - reserveBytes - bodyClaimed)
      : Math.max(0, limitBytes - bodyClaimed - finalizationClaimed);

  return {
    claim(kind, bytes) {
      assertByteCount(bytes, 'bytes');
      const granted = Math.min(bytes, availableFor(kind));
      if (kind === 'body') bodyClaimed += granted;
      else finalizationClaimed += granted;
      return granted;
    },
    claimExact(kind, bytes) {
      assertByteCount(bytes, 'bytes');
      if (bytes === 0) return true;
      if (availableFor(kind) < bytes) return false;
      if (kind === 'body') bodyClaimed += bytes;
      else finalizationClaimed += bytes;
      return true;
    },
    settle(kind, claimed, writtenBytes, failedWrite) {
      assertByteCount(claimed, 'claimed');
      assertByteCount(writtenBytes, 'writtenBytes');
      if (failedWrite) {
        failed += claimed;
        return;
      }
      if (writtenBytes > claimed) {
        /* 实测超过申请：如实记超售并继续扣减（防御纵深，正常不应发生）。 */
        oversold += writtenBytes - claimed;
        if (kind === 'body') bodyClaimed += writtenBytes - claimed;
        else finalizationClaimed += writtenBytes - claimed;
        written += claimed;
        return;
      }
      written += writtenBytes;
      if (writtenBytes < claimed) failed += claimed - writtenBytes;
    },
    usage(): WorkRecordingStorageBudgetUsage {
      const claimedBytes = bodyClaimed + finalizationClaimed;
      return {
        limitBytes,
        finalizationReserveBytes: reserveBytes,
        claimedBytes,
        writtenBytes: written,
        failedWriteBytes: failed,
        oversoldBytes: oversold,
        inFlightBytes: Math.max(0, claimedBytes - written - failed),
        availableBodyBytes: Math.max(0, limitBytes - reserveBytes - bodyClaimed),
        availableFinalizationBytes: Math.max(0, limitBytes - bodyClaimed - finalizationClaimed),
        bodyClaimedBytes: bodyClaimed,
        finalizationClaimedBytes: finalizationClaimed,
      };
    },
  };
}

/** 清单诊断里的可核对账目行（有界、无控制字符）。 */
export function storageBudgetDiagnostic(usage: WorkRecordingStorageBudgetUsage): string {
  return `storage_budget:limit=${usage.limitBytes},reserve=${usage.finalizationReserveBytes},claimed=${usage.claimedBytes},written=${usage.writtenBytes},failed=${usage.failedWriteBytes},oversold=${usage.oversoldBytes}`;
}
