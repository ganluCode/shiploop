/**
 * F-003 P02-3 证据/输出故障夹具（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 目的（F-003 验收 4）：为「输出发布失败」与「数据库收尾失败」提供确定性、
 * 可撤除的故障注入，使 F-004 基线执行器能被验证「失败时不伪装成功、且只回收
 * 已核验的自有资源」。全部复用既有注入面，不另立一套：
 *
 * - 输出发布失败：对真实 ArtifactFileStore 端口做**装饰器**包装，在指定方法
 *   （默认 publishStaging）按次数抛出受控 ArtifactFileError。除被注入点外，
 *   其余调用原样透传真实适配器，因此断言看到的是真实文件系统状态（staging 残留
 *   保留、正式位置未发布），而不是 mock 返回值；
 * - 数据库收尾失败：复用 P02-2 的真实 SQLite `TEMP TRIGGER … RAISE(ABORT)`
 *   注入面（fault-injection.ts），默认注入在「业务写后、事件写前」的收尾点
 *   （stateEventsBeforeInsert），连接关闭即消亡。
 *
 * 安全约束：注入消息固定为受控字符集；错误只含相对逻辑位置与错误码（脱敏），
 * 不回显输入原文；不读凭据、不联网、不调用模型。
 */
import type Database from 'better-sqlite3';
import { ArtifactFileError } from '../../../packages/core/src/ports/artifact-files.ts';
import type {
  ArtifactFileErrorKind,
  ArtifactFileStore,
} from '../../../packages/core/src/ports/artifact-files.ts';
import {
  installWriteFault,
  WRITE_FAULT_POINTS,
  type InstalledWriteFault,
  type WriteFaultPoint,
} from '../p02-2/fault-injection.ts';

/* ------------------------------------------------------------------ *
 * 输出发布故障：ArtifactFileStore 装饰器
 * ------------------------------------------------------------------ */

export type ArtifactFaultPoint =
  | 'resolvePlacement'
  | 'openStagingWrite'
  | 'finishStaging'
  | 'publishStaging'
  | 'discardStaging'
  | 'openFinalRead'
  | 'statFinal'
  | 'scanFinalArea'
  | 'scanStagingArea';

export interface ArtifactPublishFaultOptions {
  /** 失败注入点（默认 'publishStaging'，即输出发布失败）。 */
  readonly point?: ArtifactFaultPoint;
  /** 抛出的 ArtifactFileError 类别（默认 'io'）。 */
  readonly kind?: ArtifactFileErrorKind;
  /** 只失败前 N 次（默认 1；Infinity 表示一直失败直到 remove）。 */
  readonly times?: number;
}

export interface ArtifactPublishFault {
  readonly point: ArtifactFaultPoint;
  readonly kind: ArtifactFileErrorKind;
  readonly times: number;
  /** 已触发失败次数。 */
  readonly firedCount: number;
  /** 是否已用尽（达到 times 次）。 */
  readonly exhausted: boolean;
  /** 撤除注入（幂等）；撤除后全部调用透传真实适配器。 */
  remove(): void;
  readonly removed: boolean;
}

export interface FaultyArtifactFileStore {
  /** 装饰后的端口：除注入点外全部透传 inner 的真实行为。 */
  readonly store: ArtifactFileStore;
  readonly fault: ArtifactPublishFault;
}

/**
 * 以故障装饰器包装真实 ArtifactFileStore。注入点的调用按次数抛受控
 * ArtifactFileError（其余方法原样透传），使「输出发布失败」可被确定性地
 * 复现并撤除，而文件系统状态仍是真实的。
 */
export function createFaultyArtifactFileStore(
  inner: ArtifactFileStore,
  options: ArtifactPublishFaultOptions = {},
): FaultyArtifactFileStore {
  const point = options.point ?? 'publishStaging';
  const kind = options.kind ?? 'io';
  const times = options.times ?? 1;
  let firedCount = 0;
  let removed = false;

  const maybeFail = (method: ArtifactFaultPoint, operation: string): void => {
    if (removed || method !== point || firedCount >= times) {
      return;
    }
    firedCount += 1;
    throw new ArtifactFileError(
      kind,
      operation,
      `${operation}: 注入的输出发布失败（p023_artifact_fault）`,
      { details: { reason: 'injected_artifact_publish_failure', point, fired: firedCount } },
    );
  };

  const store: ArtifactFileStore = {
    resolvePlacement(key: unknown) {
      maybeFail('resolvePlacement', 'ArtifactFileStore.resolvePlacement');
      return inner.resolvePlacement(key);
    },
    async openStagingWrite(key: unknown) {
      maybeFail('openStagingWrite', 'ArtifactFileStore.openStagingWrite');
      return inner.openStagingWrite(key);
    },
    async finishStaging(write) {
      maybeFail('finishStaging', 'ArtifactFileStore.finishStaging');
      return inner.finishStaging(write);
    },
    async publishStaging(staging, key) {
      maybeFail('publishStaging', 'ArtifactFileStore.publishStaging');
      return inner.publishStaging(staging, key);
    },
    async discardStaging(staging) {
      maybeFail('discardStaging', 'ArtifactFileStore.discardStaging');
      return inner.discardStaging(staging);
    },
    async openFinalRead(key: unknown) {
      maybeFail('openFinalRead', 'ArtifactFileStore.openFinalRead');
      return inner.openFinalRead(key);
    },
    openStagingRead(staging) {
      return inner.openStagingRead(staging);
    },
    async statFinal(key: unknown) {
      maybeFail('statFinal', 'ArtifactFileStore.statFinal');
      return inner.statFinal(key);
    },
    async scanFinalArea(projectId: string, scanOptions?: unknown) {
      maybeFail('scanFinalArea', 'ArtifactFileStore.scanFinalArea');
      return inner.scanFinalArea(projectId, scanOptions);
    },
    async scanStagingArea(projectId: string, scanOptions?: unknown) {
      maybeFail('scanStagingArea', 'ArtifactFileStore.scanStagingArea');
      return inner.scanStagingArea(projectId, scanOptions);
    },
  };

  const fault: ArtifactPublishFault = {
    point,
    kind,
    times,
    get firedCount() {
      return firedCount;
    },
    get exhausted() {
      return firedCount >= times;
    },
    get removed() {
      return removed;
    },
    remove(): void {
      removed = true;
    },
  };

  return { store, fault };
}

/* ------------------------------------------------------------------ *
 * 数据库收尾故障：复用 P02-2 真实 TEMP TRIGGER 注入面
 * ------------------------------------------------------------------ */

/** 默认收尾注入点：业务写入之后、事件写入之前（事务收尾失败）。 */
export const DEFAULT_FINALIZATION_FAULT_POINT: WriteFaultPoint =
  WRITE_FAULT_POINTS.stateEventsBeforeInsert;

export interface DatabaseFinalizationFaultOptions {
  /** 注入点（默认 DEFAULT_FINALIZATION_FAULT_POINT）。 */
  readonly target?: WriteFaultPoint;
  /** 受控故障消息（默认 p02-2 injected fault: <label>）。 */
  readonly message?: string;
}

/**
 * 在真实 SQLite 连接上安装「收尾失败」故障：委托 P02-2 installWriteFault
 * （TEMP TRIGGER RAISE(ABORT)，连接关闭即消亡）。表名/时机走白名单，不接受
 * 任意 SQL。返回的 InstalledWriteFault 可 remove() 撤除。
 */
export function installDatabaseFinalizationFault(
  database: Database.Database,
  options: DatabaseFinalizationFaultOptions = {},
): InstalledWriteFault {
  return installWriteFault(database, {
    target: options.target ?? DEFAULT_FINALIZATION_FAULT_POINT,
    ...(options.message !== undefined ? { message: options.message } : {}),
  });
}

export { WRITE_FAULT_POINTS, type InstalledWriteFault, type WriteFaultPoint };
