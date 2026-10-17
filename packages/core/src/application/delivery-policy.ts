/**
 * P03-8 / F-001 当前适用交付政策解析（application 层纯函数）。
 *
 * 从全局与项目当前配置快照解析当前有效 deliveryPolicy 段及其身份摘要：
 * 两来源经 mergeEffectiveSettings 重新校验合并（项目非空段整体覆盖全局段，
 * 空段继承全局；双方均未配置 → 显式 null 形态摘要）。与
 * resolveCurrentCheckPolicyDigest（application/plan-approval-verification.ts）
 * 同一纪律：配置 revision 只作合并输入身份，不进入摘要内容。
 *
 * 执行输入准备把解析结果（摘要 + 已配置时的政策副本）固定进不可变 input
 * snapshot，后续全局/项目默认配置漂移不改变已固定执行依据；F-002/F-003 的
 * 提交意图固定复用同一解析入口，保证「配置体系中校验、执行依据中固定」的
 * 政策来源一致。
 */
import { computeDeliveryPolicyDigest, validateDeliveryPolicySection } from '../ports/delivery-policy.js';
import type { DeliveryPolicySection } from '../ports/delivery-policy.js';
import type { SettingsPayload } from '../ports/settings-schema.js';
import { mergeEffectiveSettings } from './effective-settings.js';

/** 配置 scope 快照输入形态（scopeRevision + 已校验 payload；缺失为 null）。 */
export interface DeliveryPolicySettingsScopeSnapshot {
  readonly scopeRevision: number;
  readonly payload: SettingsPayload;
}

/** 当前适用交付政策解析结果。 */
export interface CurrentDeliveryPolicy {
  /** 当前有效政策段身份摘要（未配置时为显式 null 形态摘要；64hex）。 */
  readonly digest: string;
  /** 当前有效政策段（未配置为 undefined；已通过段校验）。 */
  readonly section: DeliveryPolicySection | undefined;
}

/**
 * 解析当前适用交付政策：重新校验两来源 payload（无效配置带字段定位拒绝，
 * 不静默降级），合并后取有效段并计算身份摘要。纯函数：不读时钟/文件/数据库。
 */
export function resolveCurrentDeliveryPolicy(
  globalSettings: DeliveryPolicySettingsScopeSnapshot | null,
  projectSettings: DeliveryPolicySettingsScopeSnapshot | null,
): CurrentDeliveryPolicy {
  const effective = mergeEffectiveSettings({
    global:
      globalSettings === null
        ? null
        : { scopeRevision: globalSettings.scopeRevision, payload: globalSettings.payload },
    project:
      projectSettings === null
        ? null
        : { scopeRevision: projectSettings.scopeRevision, payload: projectSettings.payload },
  });
  const section = effective.policies.deliveryPolicy?.value;
  return {
    digest: computeDeliveryPolicyDigest(section),
    section:
      section === undefined
        ? undefined
        : validateDeliveryPolicySection(section, { operation: 'DeliveryPolicy.resolveCurrent' }, 'section'),
  };
}
