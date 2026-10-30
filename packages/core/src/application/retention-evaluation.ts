/**
 * P07-3 / F-012 保留评估应用服务（application 层，只读）。
 *
 * 设计依据：core-design/03 §6 与 PRD p07-data-lifecycle §3.1 第 3 项；
 * 端口契约见 ports/retention-evaluation.ts。
 *
 * 不变量：
 * - 只读：不删除/移动/写入任何文件，不写数据库、不推进操作、不启动清理
 *   （清理执行与引用闭合分析属 F-013；本服务只呈现阈值状态与候选估计）；
 * - 授权复用全局配置读取（authorizeGlobalSettingsRead）：受控数据根与全局
 *   保留政策是全局事实，受限主体不能借评估探测跨项目磁盘/备份布局；
 * - 未知不折算：磁盘观测未知时阈值整体 unknown（不当作 not_triggered/无限
 *   容量）；备份清单不可读、扫描预算耗尽都以显式 status/reason 呈现；
 * - 无默认保留值：全局未配置保留段（或段为空）即 policy not_configured，
 *   报告不注入任何默认天数/容量/份数，也不暗示自动清理已启用；
 * - 轮换估计始终保留最新一包（maxBackupCount 下界 1 的同一纪律）；估计
 *   只是候选量，绝不构成对被引用证据或唯一可恢复备份的删除授权。
 */
import {
  authorizeGlobalSettingsRead,
  assertTrustedPrincipal,
} from '../ports/authorization.js';
import { isStorageError } from '../ports/errors.js';
import {
  MANAGED_SCAN_MAX_ENTRIES_DEFAULT,
  MANAGED_SCAN_MAX_ENTRIES_MAX,
  MANAGED_SCAN_MAX_ENTRIES_MIN,
  MANAGED_USAGE_AREAS,
  RETENTION_EVALUATION_OPERATION,
  RETENTION_EVALUATION_SCHEMA_VERSION,
  type BackupCatalogRead,
  type BackupCatalogReader,
  type DiskUsageObservation,
  type DiskUsageObserver,
  type ManagedAreaScanner,
  type ManagedUsageScan,
  type RetentionCleanableComponent,
  type RetentionEvaluationReport,
  type RetentionRetainedComponent,
  type RetentionTriggerAssessment,
} from '../ports/retention-evaluation.js';
import type { RetentionPolicyV2 } from '../ports/settings-schema.js';
import type { ConfigurationService } from './configuration-service.js';

/** 每毫秒一天的滚动窗口（保留天数到期计算的单一换算）。 */
const MS_PER_DAY = 86_400_000;

export interface RetentionEvaluationService {
  /**
   * 只读评估受控数据根磁盘阈值与保留候选量。授权失败/全局配置损坏按公开
   * 错误传播；报告内所有未知/失败观测以显式 status/reason 呈现。
   */
  evaluate(principal: unknown): Promise<RetentionEvaluationReport>;
}

export interface RetentionEvaluationServiceDeps {
  /** 全局当前配置读取（唯一政策来源；项目段不能携带磁盘阈值字段）。 */
  readonly configurationService: Pick<ConfigurationService, 'getCurrentSettings'>;
  readonly disk: DiskUsageObserver;
  readonly managedScan: ManagedAreaScanner;
  readonly backups: BackupCatalogReader;
  /** UTC 毫秒时钟（默认 Date.now；测试注入获得确定性行为）。 */
  readonly nowUtcMs?: () => number;
  /** 受管区域扫描条目预算（缺省 MANAGED_SCAN_MAX_ENTRIES_DEFAULT）。 */
  readonly scanMaxEntries?: number;
}

interface RotationAssessment {
  readonly cleanable: RetentionCleanableComponent;
  readonly retained: RetentionRetainedComponent;
}

/** 备份轮换候选估计：份数超限 ∪ 期限到期，扣除始终保留的最新一包。 */
function assessBackupRotation(
  policy: RetentionPolicyV2,
  catalog: BackupCatalogRead,
  nowUtcMs: number,
): RotationAssessment {
  const rotationConfigured =
    policy.maxBackupCount !== undefined || policy.backupRetentionDays !== undefined;
  if (!rotationConfigured) {
    return {
      cleanable: { kind: 'backup_rotation', status: 'not_configured' },
      retained: { kind: 'backup_retained', status: 'not_configured' },
    };
  }
  if (catalog.status === 'unknown') {
    return {
      cleanable: {
        kind: 'backup_rotation', status: 'unknown', reason: catalog.reason ?? 'backup_catalog_unknown',
      },
      retained: {
        kind: 'backup_retained', status: 'unknown', reason: catalog.reason ?? 'backup_catalog_unknown',
      },
    };
  }
  // 最新在前；同刻按 backupId 稳定排序，保证候选/保留划分确定可复算。
  const sorted = [...catalog.entries].sort((a, b) =>
    a.createdAtUtcMs === b.createdAtUtcMs
      ? (a.backupId < b.backupId ? 1 : -1)
      : b.createdAtUtcMs - a.createdAtUtcMs,
  );
  let cleanableBytes = 0;
  let cleanableItems = 0;
  let retainedBytes = 0;
  let retainedItems = 0;
  sorted.forEach((entry, rank) => {
    const beyondCount = policy.maxBackupCount !== undefined && rank >= policy.maxBackupCount;
    const expired =
      policy.backupRetentionDays !== undefined &&
      nowUtcMs - entry.createdAtUtcMs > policy.backupRetentionDays * MS_PER_DAY;
    // rank 0（最新一包）始终保留：估计不得授权清除唯一最新备份。
    if ((beyondCount || expired) && rank > 0) {
      cleanableBytes += entry.bytes;
      cleanableItems += 1;
    } else {
      retainedBytes += entry.bytes;
      retainedItems += 1;
    }
  });
  const partialReason = catalog.status === 'partial' ? 'backup_catalog_partial' : undefined;
  return {
    cleanable: {
      kind: 'backup_rotation',
      status: 'assessed',
      ...(partialReason === undefined ? {} : { reason: partialReason }),
      bytes: cleanableBytes,
      items: cleanableItems,
    },
    retained: {
      kind: 'backup_retained',
      status: 'assessed',
      ...(partialReason === undefined ? {} : { reason: partialReason }),
      bytes: retainedBytes,
      items: retainedItems,
    },
  };
}

/** 汇总分项状态：全部已评=assessed；部分未知=partial/unknown；无配置维度=not_configured。 */
function rollupComponentStatus(
  components: readonly (readonly [status: 'not_configured' | 'assessed' | 'unknown', bytes: number | undefined])[],
): { status: 'not_configured' | 'assessed' | 'partial' | 'unknown'; bytes?: number } {
  const configured = components.filter(([status]) => status !== 'not_configured');
  if (configured.length === 0) {
    return { status: 'not_configured' };
  }
  const assessed = configured.filter(([status]) => status === 'assessed');
  const bytes = assessed.reduce((sum, [, entryBytes]) => sum + (entryBytes ?? 0), 0);
  if (assessed.length === configured.length) {
    return { status: 'assessed', ...(assessed.length === 0 ? {} : { bytes }) };
  }
  return {
    status: assessed.length > 0 ? 'partial' : 'unknown',
    ...(assessed.length === 0 ? {} : { bytes }),
  };
}

/** 装配保留评估服务。只校验依赖形态，不执行任何 I/O；import 本模块无副作用。 */
export function createRetentionEvaluationService(deps: RetentionEvaluationServiceDeps): RetentionEvaluationService {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('RetentionEvaluation.create: 必须提供装配依赖');
  }
  if (typeof deps.configurationService?.getCurrentSettings !== 'function') {
    throw new TypeError('RetentionEvaluation.create: 必须提供 ConfigurationService 读取端口');
  }
  if (typeof deps.disk?.observe !== 'function' || typeof deps.managedScan?.scan !== 'function'
    || typeof deps.backups?.list !== 'function') {
    throw new TypeError('RetentionEvaluation.create: 必须提供磁盘观测/受管扫描/备份清单端口');
  }
  const scanMaxEntries = deps.scanMaxEntries ?? MANAGED_SCAN_MAX_ENTRIES_DEFAULT;
  if (!Number.isInteger(scanMaxEntries)
    || scanMaxEntries < MANAGED_SCAN_MAX_ENTRIES_MIN
    || scanMaxEntries > MANAGED_SCAN_MAX_ENTRIES_MAX) {
    throw new TypeError('RetentionEvaluation.create: 扫描条目预算越界');
  }
  const nowUtcMs = deps.nowUtcMs ?? Date.now;

  return {
    async evaluate(principal: unknown): Promise<RetentionEvaluationReport> {
      assertTrustedPrincipal(principal);
      authorizeGlobalSettingsRead(principal, RETENTION_EVALUATION_OPERATION);
      const evaluatedAtUtcMs = nowUtcMs();

      // 全局当前配置是唯一政策来源；未配置（缺失）明确 not_configured，
      // 损坏（corrupt）原样传播（不把坏数据折算成未配置）。
      let retention: RetentionPolicyV2 | undefined;
      let scopeRevision: number | undefined;
      try {
        const record = await deps.configurationService.getCurrentSettings({ kind: 'global' });
        const section = record.payload.policies?.retentionPolicy;
        if (section !== undefined && Object.keys(section).length > 0) {
          retention = section;
          scopeRevision = record.revision;
        }
      } catch (error) {
        if (isStorageError(error, 'not_found')) {
          retention = undefined;
        } else {
          throw error;
        }
      }

      const [disk, catalog, managedUsage]: [DiskUsageObservation, BackupCatalogRead, ManagedUsageScan] =
        await Promise.all([
          deps.disk.observe().catch((error: unknown) => ({
            status: 'unknown' as const,
            reason: typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : 'observe_failed',
          })),
          deps.backups.list().catch((error: unknown) => ({
            status: 'unknown' as const,
            reason: typeof (error as { code?: unknown })?.code === 'string'
              ? (error as { code: string }).code
              : 'catalog_read_failed',
            entries: [],
            unreadable: 0,
          })),
          deps.managedScan.scan(scanMaxEntries).catch((error: unknown) => ({
            areas: MANAGED_USAGE_AREAS.map(area => ({
              area,
              status: 'unknown' as const,
              reason: typeof (error as { code?: unknown })?.code === 'string'
                ? (error as { code: string }).code
                : 'scan_failed',
            })),
            entriesExamined: 0,
            budgetExhausted: false,
          })),
        ]);

      // 磁盘阈值：未配置=not_configured；观测未知=unknown（不当作未触发）。
      const triggers: RetentionTriggerAssessment[] = [];
      let thresholdsStatus: 'not_configured' | 'evaluated' | 'unknown' = 'not_configured';
      let thresholdsReason: string | undefined;
      const diskObserved = disk.status === 'observed'
        && typeof disk.availableBytes === 'number'
        && typeof disk.totalBytes === 'number'
        ? { availableBytes: disk.availableBytes, totalBytes: disk.totalBytes }
        : undefined;
      if (retention?.diskMinFreeBytes !== undefined || retention?.diskMinFreePercent !== undefined) {
        if (diskObserved === undefined) {
          thresholdsStatus = 'unknown';
          thresholdsReason = disk.reason ?? 'disk_observation_unknown';
        } else {
          thresholdsStatus = 'evaluated';
        }
        if (retention.diskMinFreeBytes !== undefined) {
          const observed = diskObserved?.availableBytes;
          triggers.push({
            kind: 'disk_min_free_bytes',
            configuredValue: retention.diskMinFreeBytes,
            ...(observed === undefined ? {} : { observedValue: observed }),
            assessment: observed === undefined
              ? 'unknown'
              : observed < retention.diskMinFreeBytes ? 'triggered' : 'not_triggered',
          });
        }
        if (retention.diskMinFreePercent !== undefined) {
          const observedPercent = diskObserved === undefined || diskObserved.totalBytes === 0
            ? undefined
            : Math.round((diskObserved.availableBytes / diskObserved.totalBytes) * 10_000) / 100;
          triggers.push({
            kind: 'disk_min_free_percent',
            configuredValue: retention.diskMinFreePercent,
            ...(observedPercent === undefined ? {} : { observedValue: observedPercent }),
            assessment: observedPercent === undefined
              ? 'unknown'
              : observedPercent < retention.diskMinFreePercent ? 'triggered' : 'not_triggered',
          });
        }
      }

      // 可清理量 / 被引用保留量：备份轮换按清单估计；证据保留需要引用闭合
      // 分析（F-013 接线），本阶段显式 unknown，不冒充已评估。
      const rotation = retention === undefined
        ? {
          cleanable: { kind: 'backup_rotation' as const, status: 'not_configured' as const },
          retained: { kind: 'backup_retained' as const, status: 'not_configured' as const },
        }
        : assessBackupRotation(retention, catalog, evaluatedAtUtcMs);
      const evidenceRetentionConfigured = retention?.evidenceRetentionDays !== undefined;
      const cleanableComponents: RetentionCleanableComponent[] = [
        rotation.cleanable,
        {
          kind: 'evidence_retention',
          status: evidenceRetentionConfigured ? 'unknown' : 'not_configured',
          ...(evidenceRetentionConfigured ? { reason: 'reference_analysis_unavailable' } : {}),
        },
      ];
      const retainedComponents: RetentionRetainedComponent[] = [
        rotation.retained,
        {
          kind: 'evidence_references',
          status: evidenceRetentionConfigured ? 'unknown' : 'not_configured',
          ...(evidenceRetentionConfigured ? { reason: 'reference_analysis_unavailable' } : {}),
        },
      ];
      const cleanable = rollupComponentStatus(
        cleanableComponents.map(component => [component.status, component.bytes] as const),
      );
      const referencedRetained = rollupComponentStatus(
        retainedComponents.map(component => [component.status, component.bytes] as const),
      );

      return {
        schemaVersion: RETENTION_EVALUATION_SCHEMA_VERSION,
        operation: RETENTION_EVALUATION_OPERATION,
        evaluatedAtUtcMs,
        policy: retention === undefined
          ? { status: 'not_configured' }
          : {
            status: 'configured',
            retention,
            source: { kind: 'global_default', scopeRevision: scopeRevision ?? 0, sourceKey: 'policies.retentionPolicy' },
          },
        disk,
        thresholds: {
          status: thresholdsStatus,
          ...(thresholdsReason === undefined ? {} : { reason: thresholdsReason }),
          triggers,
        },
        cleanable: {
          status: cleanable.status,
          ...('bytes' in cleanable && cleanable.bytes !== undefined ? { bytes: cleanable.bytes } : {}),
          components: cleanableComponents,
        },
        referencedRetained: {
          status: referencedRetained.status,
          ...('bytes' in referencedRetained && referencedRetained.bytes !== undefined
            ? { bytes: referencedRetained.bytes }
            : {}),
          components: retainedComponents,
        },
        managedUsage,
      };
    },
  };
}
