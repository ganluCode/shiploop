/**
 * P01-3 / F-010 ConfigurationService（application 层）：全局/项目当前配置的
 * 创建（insert-only）与 expectedRevision CAS 更新——在一致性视图内完成
 * 有效配置校验（合并 + 能力兼容），再经存储端口在同一短事务内原子保存
 * 当前值与脱敏变更记录（state_events）。
 *
 * 设计依据：core-design/03 §1-3（短事务、CAS、端口先校验后持久化）、
 * core-design/06 §3 / 11 §3.1（当前配置语义与凭据引用卫生）与
 * docs/p01-3-application-contract.md §4.4/§5（F-008/F-009/F-010 定案）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（StateStore / RuntimeCapabilityCatalog）与
 *   application 纯函数（mergeEffectiveSettings），不接触适配器、驱动、HTTP
 *   或 Pi SDK；import 本模块无副作用，装配时不执行任何 I/O；
 * - 严格顺序：scope/输入运行时校验（非法 scope/schemaVersion/payload/未知键/
 *   明文秘密字段在任何 I/O 之前拒绝）→ 读取全局当前配置（一致性视图来源）→
 *   有效配置合并校验 + 能力兼容检查（可信装配注入的窄能力目录）→ 存储端口
 *   条件写入；任何失败都不改变现有 payload/revision，首次创建失败不留配置行；
 * - 一致性视图（项目 scope）：应用服务在写事务之外读取全局当前配置，并把读取
 *   时看到的全局 revision 作为 `consistency.globalRevision` 前置条件随写入传入；
 *   适配器在同一写事务内核对——与默认更新竞争时（全局已被并发修改）返回
 *   conflict（reason='stale_dependency'），不提交基于陈旧依赖校验过的结果；
 * - 能力兼容（F-008）：写入校验针对**合并后的有效策略集合**（项目覆盖 + 继承的
 *   全局条目随当前能力目录复检）；未知 runtime/不兼容 provider/未枚举 model
 *   带字段定位拒绝，不从其他策略补齐，不注入默认 Claude/API；
 * - scope 即授权边界：目标身份只来自 `scope`（global 单例 / project 携带稳定
 *   projectId），不存在第二条传入项目身份的渠道，项目 A 范围不能更新项目 B；
 * - 审计（F-010 定案）：成功的 CAS 更新由存储端口在同一短事务内追加
 *   `settings.global_updated` / `settings.project_updated` 脱敏记录（只含
 *   schemaVersion 与策略键名/政策段名摘要，绝不含 payload 值/引用值/秘密）；
 *   首次创建为 insert-only，不写审计记录（与 createProject 一致）；
 * - 合法 ≠ 可执行：写入只表达结构与兼容性合法；P01 未装配 Runner/认证/模型
 *   执行能力，本服务不返回也不伪装“可执行”状态（见 F-008
 *   assessSettingsConfiguration）。
 *
 * 本模块不实现（后续任务）：当前值/有效配置/脱敏导出查询（F-011）、
 * Host/CLI 路由、配置历史版本表、Task 策略复制（T24）、凭据解析。
 */
import { isStorageError } from '../ports/errors.js';
import { validateStrategyCapabilities } from '../ports/runtime-capabilities.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import {
  SETTINGS_SCHEMA_VERSION,
  validateSettingsScope,
} from '../ports/settings-schema.js';
import type {
  RuntimeStrategyV1,
  SettingsPayload,
  SettingsScope,
} from '../ports/settings-schema.js';
import {
  validatePutSettingsInput,
  validateUpdateSettingsInput,
} from '../ports/state-store.js';
import type {
  GlobalSettingsRecord,
  ProjectSettingsRecord,
  StateStore,
} from '../ports/state-store.js';
import { validationError } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import type { EffectiveSettings } from './effective-settings.js';

/** 配置写入结果：全局单例记录或项目当前配置记录（按 scope 区分）。 */
export type SettingsWriteResult = GlobalSettingsRecord | ProjectSettingsRecord;

/**
 * 配置应用服务（F-010 命令切片）：全局/项目当前配置的创建与 CAS 更新。
 * 查询（当前值/有效配置/脱敏导出）由 F-011 交付。
 */
export interface ConfigurationService {
  /**
   * 首次创建（insert-only）：全局单例或每项目一条当前配置；已存在返回
   * conflict（不覆盖），失败不留配置行。首次创建不携带 expectedRevision。
   */
  createSettings(scope: unknown, input: unknown): Promise<SettingsWriteResult>;
  /**
   * CAS 更新：必须携带 expectedRevision（≥1 整数）；匹配则 revision+1 并在
   * 同一短事务内追加脱敏变更记录；过期 revision/陈旧全局依赖返回 conflict，
   * 现有 payload/revision 不变。
   */
  updateSettings(scope: unknown, input: unknown): Promise<SettingsWriteResult>;
}

export interface ConfigurationServiceDeps {
  readonly stateStore: StateStore;
  /** 可信装配注入的只读能力目录（F-008）；空目录 fail-closed。 */
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
}

/**
 * 从合并后的有效配置重建策略集合 payload，供能力兼容复检使用
 * （只取策略条目，不含政策段；条目本身已是校验过的完整 RuntimeStrategyV1）。
 */
function strategiesPayloadFromEffective(effective: EffectiveSettings): SettingsPayload {
  const strategies: {
    defaultStrategy?: RuntimeStrategyV1;
    modelMap?: Record<string, RuntimeStrategyV1>;
    purposeStrategies?: Record<string, RuntimeStrategyV1>;
    agentOverrides?: Record<string, RuntimeStrategyV1>;
  } = {};
  if (effective.strategies.defaultStrategy !== undefined) {
    strategies.defaultStrategy = effective.strategies.defaultStrategy.strategy;
  }
  const modelMap: Record<string, RuntimeStrategyV1> = {};
  for (const [key, entry] of Object.entries(effective.strategies.modelMap)) {
    if (entry !== undefined) {
      modelMap[key] = entry.strategy;
    }
  }
  if (Object.keys(modelMap).length > 0) {
    strategies.modelMap = modelMap;
  }
  const purposeStrategies: Record<string, RuntimeStrategyV1> = {};
  for (const [key, entry] of Object.entries(effective.strategies.purposeStrategies)) {
    if (entry !== undefined) {
      purposeStrategies[key] = entry.strategy;
    }
  }
  if (Object.keys(purposeStrategies).length > 0) {
    strategies.purposeStrategies = purposeStrategies;
  }
  const agentOverrides: Record<string, RuntimeStrategyV1> = {};
  for (const [key, entry] of Object.entries(effective.strategies.agentOverrides)) {
    agentOverrides[key] = entry.strategy;
  }
  if (Object.keys(agentOverrides).length > 0) {
    strategies.agentOverrides = agentOverrides;
  }
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies };
}

/**
 * 装配 ConfigurationService。只校验依赖形态，不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createConfigurationService(deps: ConfigurationServiceDeps): ConfigurationService {
  const context: ValidationContext = { operation: 'ConfigurationService.create' };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 stateStore/capabilityCatalog 装配依赖');
  }
  if (deps.stateStore === null || typeof deps.stateStore !== 'object') {
    throw validationError(context, 'deps.stateStore', '必须提供 StateStore 端口实现');
  }
  if (
    deps.capabilityCatalog === null ||
    typeof deps.capabilityCatalog !== 'object' ||
    typeof deps.capabilityCatalog.resolve !== 'function'
  ) {
    throw validationError(context, 'deps.capabilityCatalog', '必须提供 RuntimeCapabilityCatalog 端口实现');
  }
  const { stateStore, capabilityCatalog } = deps;

  /**
   * 读取全局当前配置作为一致性视图来源：不存在返回 null（不是错误——全局
   * 未配置时项目覆盖仍合法）；其余错误（corrupt 等）原样传播。
   */
  async function readGlobalSnapshot(): Promise<{
    readonly revision: number;
    readonly payload: SettingsPayload;
  } | null> {
    try {
      const record = await stateStore.getGlobalSettings();
      return { revision: record.revision, payload: record.payload };
    } catch (error) {
      if (isStorageError(error, 'not_found')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 项目 scope 写入的合并校验：以「当前全局 + 新项目 payload」合并有效配置
   * （两个来源在合并前重新经 schemaVersion=2 校验，无效全局不被掩盖、无效
   * 项目输入不降级），再对合并后的策略集合做能力兼容复检。
   * nextScopeRevision 只用于来源标注（创建为 1，更新为 expectedRevision+1），
   * 不影响校验结论。
   */
  function validateMergedProjectWrite(
    operation: string,
    projectId: string,
    payload: SettingsPayload,
    nextScopeRevision: number,
    global: { readonly revision: number; readonly payload: SettingsPayload } | null,
  ): void {
    const merged = mergeEffectiveSettings({
      global:
        global === null ? null : { scopeRevision: global.revision, payload: global.payload },
      project: { scopeRevision: nextScopeRevision, payload },
    });
    validateStrategyCapabilities(strategiesPayloadFromEffective(merged), capabilityCatalog, {
      operation,
      entity: { type: 'project_settings', projectId },
    });
  }

  async function createGlobal(operation: string, input: unknown): Promise<GlobalSettingsRecord> {
    // 全局有效配置即全局 payload 自身：直接对 payload 做能力兼容检查。
    const valid = validatePutSettingsInput(input, operation, { type: 'global_settings', id: 'global' });
    validateStrategyCapabilities(valid.payload, capabilityCatalog, {
      operation,
      entity: { type: 'global_settings', id: 'global' },
    });
    return stateStore.createGlobalSettings({ payload: valid.payload });
  }

  async function createForProject(
    operation: string,
    scope: { readonly kind: 'project'; readonly projectId: string },
    input: unknown,
  ): Promise<ProjectSettingsRecord> {
    // 调用方输入只接受 { payload }（consistency 由本服务从自己的一致性读取推导，
    // 不接受调用方声明——否则前置条件失去意义）。
    const valid = validatePutSettingsInput(input, operation, {
      type: 'project_settings',
      projectId: scope.projectId,
    });
    const global = await readGlobalSnapshot();
    validateMergedProjectWrite(operation, scope.projectId, valid.payload, 1, global);
    return stateStore.createProjectSettings(scope.projectId, {
      payload: valid.payload,
      consistency: { globalRevision: global?.revision ?? null },
    });
  }

  async function updateGlobal(operation: string, input: unknown): Promise<GlobalSettingsRecord> {
    const valid = validateUpdateSettingsInput(input, operation, { type: 'global_settings', id: 'global' });
    validateStrategyCapabilities(valid.payload, capabilityCatalog, {
      operation,
      entity: { type: 'global_settings', id: 'global' },
    });
    return stateStore.updateGlobalSettings({
      expectedRevision: valid.expectedRevision,
      payload: valid.payload,
    });
  }

  async function updateForProject(
    operation: string,
    scope: { readonly kind: 'project'; readonly projectId: string },
    input: unknown,
  ): Promise<ProjectSettingsRecord> {
    const valid = validateUpdateSettingsInput(input, operation, {
      type: 'project_settings',
      projectId: scope.projectId,
    });
    const global = await readGlobalSnapshot();
    validateMergedProjectWrite(
      operation,
      scope.projectId,
      valid.payload,
      valid.expectedRevision + 1,
      global,
    );
    return stateStore.updateProjectSettings(scope.projectId, {
      expectedRevision: valid.expectedRevision,
      payload: valid.payload,
      consistency: { globalRevision: global?.revision ?? null },
    });
  }

  return {
    async createSettings(scope: unknown, input: unknown): Promise<SettingsWriteResult> {
      const operation = 'ConfigurationService.createSettings';
      // scope 校验先于任何 I/O：非法 scope 不产生读取或写入。
      const validScope = validateSettingsScope(scope, { operation });
      if (validScope.kind === 'global') {
        return createGlobal(operation, input);
      }
      return createForProject(operation, validScope, input);
    },

    async updateSettings(scope: unknown, input: unknown): Promise<SettingsWriteResult> {
      const operation = 'ConfigurationService.updateSettings';
      const validScope: SettingsScope = validateSettingsScope(scope, { operation });
      if (validScope.kind === 'global') {
        return updateGlobal(operation, input);
      }
      return updateForProject(operation, validScope, input);
    },
  };
}
