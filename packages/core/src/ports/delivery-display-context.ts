/**
 * P08 / F-013 DAG 交付公共展示上下文（ports 纯契约层）。
 *
 * 依据 input/2026-11-09-dag-integration-lifecycle.md FR-09：公共查询必须同时
 * 展示稳定层级编码/名称、branchName 等脱敏展示事实，UUID 只用于精确追踪；
 * 不把 worktree 绝对路径、凭据或模型正文加入公共投影。
 *
 * 事实来源：`entity_display_codes`（创建期固化的 phase/feature/task 展示编码，
 * tombstone 保留）+ features/phases 持久行。展示编码是 display-only 别名，
 * 不参与任何业务判定；缺失时保持 null，不以 UUID 片段冒充编码。
 *
 * 纯度不变量：本模块只做类型声明与确定性校验，不读时钟/文件系统/网络/数据库。
 */
import { validationError, type ValidationContext } from './validation.js';

/** 展示编码长度上限（与 entity_display_codes 写入路径同一上界）。 */
export const DELIVERY_DISPLAY_CODE_MAX_LENGTH = 64 as const;
/** 标题展示上限（与 phases/features 标题列约束同一量级）。 */
export const DELIVERY_DISPLAY_TITLE_MAX_LENGTH = 512 as const;
/** 批量展示上下文读取上限（防止无界 IN 查询）。 */
export const DELIVERY_DISPLAY_CONTEXT_BATCH_LIMIT = 128 as const;

/** 展示编码字符集：大写字母开头，允许大写字母/数字/连字符。 */
const DISPLAY_CODE_PATTERN = /^[A-Z][A-Z0-9-]{0,63}$/;

/**
 * 公开交付展示上下文：单 Feature 的稳定层级编码/名称/branchName 与所属
 * Phase 展示事实。displayCode/phaseDisplayCode 缺失（历史数据或未迁移）为
 * null；title 恒来自持久行（非空）。
 */
export interface PublicDeliveryEntityDisplay {
  readonly featureId: string;
  readonly displayCode: string | null;
  readonly title: string;
  readonly branchName: string | null;
  readonly phaseId: string;
  readonly phaseDisplayCode: string | null;
  readonly phaseTitle: string;
}

/** 交付展示上下文只读窄端口（授权与存在性折叠在应用层完成）。 */
export interface DeliveryDisplayContextReadStore {
  /** 单 Feature 展示上下文；Feature 不存在/跨项目统一 undefined。 */
  readFeatureDeliveryDisplay(projectId: unknown, featureId: unknown): PublicDeliveryEntityDisplay | undefined;
  /**
   * 批量展示上下文（≤ DELIVERY_DISPLAY_CONTEXT_BATCH_LIMIT）；输入身份非法
   * fail-closed（validation），不静默丢弃。返回 Map 以 featureId 为键；缺失
   * 的 Feature 不出现在结果中，由调用方决定折叠语义。
   */
  listFeatureDeliveryDisplays(
    projectId: unknown,
    featureIds: readonly unknown[],
  ): ReadonlyMap<string, PublicDeliveryEntityDisplay>;
}

/** 展示编码形状校验（wire/CLI 与 SQLite 行映射共用同一规则）。 */
export function isDeliveryDisplayCodeShape(value: unknown): value is string {
  return typeof value === 'string' && DISPLAY_CODE_PATTERN.test(value);
}

/** 纯对象形状校验：未知键拒绝，编码/标题/branchName 形状 fail-closed。 */
export function validateDeliveryEntityDisplay(
  value: unknown,
  context: ValidationContext,
  field: string,
): PublicDeliveryEntityDisplay {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(context, field, 'object_required');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of ['featureId', 'displayCode', 'title', 'branchName', 'phaseId', 'phaseDisplayCode', 'phaseTitle']) {
    if (!keys.includes(key)) {
      throw validationError(context, `${field}.${key}`, 'missing_field');
    }
  }
  if (keys.length !== 7) {
    throw validationError(context, field, 'unknown_field');
  }
  for (const key of ['featureId', 'phaseId']) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      throw validationError(context, `${field}.${key}`, 'invalid_identity');
    }
  }
  for (const key of ['displayCode', 'phaseDisplayCode']) {
    const code = record[key];
    if (code !== null && !isDeliveryDisplayCodeShape(code)) {
      throw validationError(context, `${field}.${key}`, 'invalid_display_code');
    }
  }
  for (const key of ['title', 'phaseTitle']) {
    const title = record[key];
    if (typeof title !== 'string' || title.length === 0 || title.length > DELIVERY_DISPLAY_TITLE_MAX_LENGTH) {
      throw validationError(context, `${field}.${key}`, 'invalid_title');
    }
  }
  if (record.branchName !== null && (typeof record.branchName !== 'string' || record.branchName.length === 0
    || record.branchName.length > 255 || record.branchName.startsWith('/') || /[\x00-\x20\x7f~^:?*\[\\]/.test(record.branchName)
    || record.branchName.includes('..') || record.branchName.includes('@{'))) {
    throw validationError(context, `${field}.branchName`, 'invalid_branch_name');
  }
  return value as PublicDeliveryEntityDisplay;
}
