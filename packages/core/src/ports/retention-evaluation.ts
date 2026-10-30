/**
 * P07-3 / F-012 保留评估窄契约（ports 契约层，纯类型与常量、无 I/O）。
 *
 * 设计依据：core-design/03 §6（会话保留、磁盘阈值和备份上限由用户显式配置，
 * 不编造默认容量；孤立文件先隔离并按保留政策处理，不立刻删除）与 PRD
 * p07-data-lifecycle §3.1 第 3 项（配置记录保留政策和磁盘阈值，存在引用的
 * 证据不被无声清理）。
 *
 * 契约要点：
 * - 评估是**只读**观测：不删除任何文件、不写数据库、不推进任何操作；
 *   阈值/上限只授权「评估与候选估计」，绝不授权删除被引用证据（引用保护
 *   与执行前复核属于 F-013 清理执行，不在本契约）；
 * - 所有观测量区分「实际观测」与「未知」：磁盘 statfs 失败、目录读取失败、
 *   清单不可读都以显式 status/reason 呈现，绝不把未知可用空间当作无限容量
 *   （未知即整体 unknown，不折算为 not_triggered）；
 * - 扫描/清单读取有有限预算（条目上限），预算耗尽以 partial/budget_exhausted
 *   呈现，不静默截断为完整结论；
 * - 本层为纯契约；真实文件系统适配器在 adapters/fs 实现，评估服务在
 *   application 层组装（授权复用全局配置读取）。
 */
import type { RetentionPolicyV2 } from './settings-schema.js';

/** 保留评估只读查询操作身份（与 Host 路由/能力清单同源）。 */
export const RETENTION_EVALUATION_OPERATION = 'retention.evaluation.get';

/** 保留评估报告封套版本；报告结构变更时显式递增。 */
export const RETENTION_EVALUATION_SCHEMA_VERSION = 1 as const;

/** 受管区域扫描条目预算缺省（单次评估枚举的目录项总数上限）。 */
export const MANAGED_SCAN_MAX_ENTRIES_DEFAULT = 20_000;
/** 受管区域扫描条目预算上下界（实施契约值）。 */
export const MANAGED_SCAN_MAX_ENTRIES_MIN = 1;
export const MANAGED_SCAN_MAX_ENTRIES_MAX = 100_000;

/* ------------------------------------------------------------------ *
 * 窄端口（只读；真实适配器在 adapters/fs/disk-observation.ts）
 * ------------------------------------------------------------------ */

/** 受控数据根磁盘观测：实际观测或未知（原因脱敏为错误码形态）。 */
export interface DiskUsageObservation {
  readonly status: 'observed' | 'unknown';
  readonly reason?: string;
  /** statfs 可用空间（字节；status='observed' 时必填）。 */
  readonly availableBytes?: number;
  /** statfs 总容量（字节；status='observed' 时必填）。 */
  readonly totalBytes?: number;
}

export interface DiskUsageObserver {
  observe(): Promise<DiskUsageObservation>;
}

/** 受管数据根的一级受管区域（数据库文件按所在根统计，不跟随符号链接）。 */
export const MANAGED_USAGE_AREAS = ['projects', 'staging', 'backups', 'database'] as const;
export type ManagedUsageArea = (typeof MANAGED_USAGE_AREAS)[number];

/** 单个受管区域的用量观测：observed（完整）/partial（预算内部分）/unknown。 */
export interface ManagedAreaUsage {
  readonly area: ManagedUsageArea;
  readonly status: 'observed' | 'partial' | 'unknown';
  readonly reason?: string;
  /** 区域内普通文件字节合计（不含符号链接目标）。 */
  readonly bytes?: number;
  /** 区域内普通文件数（status≠unknown 时给出预算内计数）。 */
  readonly files?: number;
}

/** 受管区域有界扫描结果；预算耗尽显式呈现，不冒充完整结论。 */
export interface ManagedUsageScan {
  readonly areas: readonly ManagedAreaUsage[];
  /** 本次扫描实际枚举的目录项数（含目录与文件）。 */
  readonly entriesExamined: number;
  readonly budgetExhausted: boolean;
}

export interface ManagedAreaScanner {
  scan(maxEntries: number): Promise<ManagedUsageScan>;
}

/** 备份包目录清单条目（只读自 backupRoot 各包 manifest；不读正文内容）。 */
export interface BackupCatalogEntry {
  readonly backupId: string;
  readonly createdAtUtcMs: number;
  /** 包内文件字节合计（来自 manifest 登记的 sizeBytes）。 */
  readonly bytes: number;
}

/** 备份目录清单读取结果：listed（全部可读）/partial（个别不可读）/unknown。 */
export interface BackupCatalogRead {
  readonly status: 'listed' | 'partial' | 'unknown';
  readonly reason?: string;
  readonly entries: readonly BackupCatalogEntry[];
  /** 无法读取 manifest 的包数（partial 时 >0）。 */
  readonly unreadable: number;
}

export interface BackupCatalogReader {
  list(): Promise<BackupCatalogRead>;
}

/* ------------------------------------------------------------------ *
 * 评估报告（application 层组装；全部观测量区分实际观测/未知）
 * ------------------------------------------------------------------ */

/** 单条磁盘阈值评估：配置值 vs 观测值；观测未知时 assessment='unknown'。 */
export interface RetentionTriggerAssessment {
  readonly kind: 'disk_min_free_bytes' | 'disk_min_free_percent';
  readonly configuredValue: number;
  /** 观测值（字节或百分比，保留两位小数）；观测未知时缺省。 */
  readonly observedValue?: number;
  readonly assessment: 'triggered' | 'not_triggered' | 'unknown';
}

/** 可清理量分项：not_configured（政策未配置该维度）/assessed/unknown。 */
export interface RetentionCleanableComponent {
  readonly kind: 'backup_rotation' | 'evidence_retention';
  readonly status: 'not_configured' | 'assessed' | 'unknown';
  readonly reason?: string;
  readonly bytes?: number;
  /** backup_rotation 的候选包数（含备份期限到期与份数超限并集，扣除始终保留的最新一包）。 */
  readonly items?: number;
}

/** 被引用保留量分项：评估只呈现保护事实，引用闭合分析由 F-013 接线。 */
export interface RetentionRetainedComponent {
  readonly kind: 'backup_retained' | 'evidence_references';
  readonly status: 'not_configured' | 'assessed' | 'unknown';
  readonly reason?: string;
  readonly bytes?: number;
  readonly items?: number;
}

/** 阈值评估报告：政策解析、磁盘观测、触发原因、可清理量与被引用保留量。 */
export interface RetentionEvaluationReport {
  readonly schemaVersion: typeof RETENTION_EVALUATION_SCHEMA_VERSION;
  readonly operation: typeof RETENTION_EVALUATION_OPERATION;
  readonly evaluatedAtUtcMs: number;
  readonly policy: {
    readonly status: 'configured' | 'not_configured';
    /** 生效保留政策（全局当前配置；项目段不能携带磁盘阈值字段）。 */
    readonly retention?: RetentionPolicyV2;
    readonly source?: {
      readonly kind: 'global_default';
      readonly scopeRevision: number;
      readonly sourceKey: 'policies.retentionPolicy';
    };
  };
  readonly disk: DiskUsageObservation;
  readonly thresholds: {
    readonly status: 'not_configured' | 'evaluated' | 'unknown';
    readonly reason?: string;
    readonly triggers: readonly RetentionTriggerAssessment[];
  };
  readonly cleanable: {
    readonly status: 'not_configured' | 'assessed' | 'partial' | 'unknown';
    readonly bytes?: number;
    readonly components: readonly RetentionCleanableComponent[];
  };
  readonly referencedRetained: {
    readonly status: 'not_configured' | 'assessed' | 'partial' | 'unknown';
    readonly reason?: string;
    readonly bytes?: number;
    readonly components: readonly RetentionRetainedComponent[];
  };
  readonly managedUsage: ManagedUsageScan;
}
