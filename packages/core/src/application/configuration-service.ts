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
 * 本模块已实现（F-011）查询切片：`getCurrentSettings`（当前值，按 scope 区分）、
 * `getEffectiveSettings`（F-009 合并 + 逐项来源）与 `exportSettings`
 * （普通脱敏导出：当前值投影 + 有效配置来源）。查询只经 StateStore 只读端口读取
 * 持久值/来源，不解析凭据引用、不读环境/认证文件/Keychain/CredentialProvider、
 * 不解析 YAML 外部覆盖、不标记执行能力已就绪；持久数据读取沿用存储端口的
 * 版本/Schema 校验（未知版本/损坏为 corrupt，不作为可执行配置导出、不静默回落）。
 *
 * 本模块不实现（后续任务）：Host/CLI 路由、配置历史版本表、Task 策略复制（T24）、
 * 凭据解析。
 */
import { isStorageError } from '../ports/errors.js';
import { validateStrategyCapabilities } from '../ports/runtime-capabilities.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import {
  SETTINGS_SCHEMA_VERSION,
  validateSettingsScope,
} from '../ports/settings-schema.js';
import type {
  ExecutionLimitsPolicyV2,
  ModelComplexity,
  ProjectStrategiesV1,
  RuntimeStrategyV1,
  SecurityPolicyV2,
  SettingsPayload,
  SettingsPoliciesV2,
  SettingsScope,
  StrategyPurpose,
  VerificationPolicyV2,
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
import { validateStableId, validationError } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import type { EffectiveSettings } from './effective-settings.js';

/** 配置写入结果：全局单例记录或项目当前配置记录（按 scope 区分）。 */
export type SettingsWriteResult = GlobalSettingsRecord | ProjectSettingsRecord;

/** 当前配置读取结果：全局单例记录或项目当前配置记录（按 scope 区分）。 */
export type SettingsReadResult = GlobalSettingsRecord | ProjectSettingsRecord;

/** 脱敏导出格式版本；导出字段 Schema 变更时必须显式递增（与文档同步）。 */
export const SETTINGS_EXPORT_FORMAT_VERSION = 1;

/** 导出中的策略条目：只含执行身份字段与**引用**（绝不含明文秘密值）。 */
export interface ExportedStrategy {
  readonly runtime: string;
  readonly provider: string;
  readonly model: string;
  readonly credentialRef?: string;
  readonly endpointRef?: string;
}

export interface ExportedStrategies {
  readonly defaultStrategy?: ExportedStrategy;
  readonly modelMap?: Partial<Record<ModelComplexity, ExportedStrategy>>;
  readonly purposeStrategies?: Partial<Record<StrategyPurpose, ExportedStrategy>>;
  readonly agentOverrides?: Record<string, ExportedStrategy>;
}

export interface ExportedPolicies {
  readonly executionLimits?: ExecutionLimitsPolicyV2;
  readonly verification?: VerificationPolicyV2;
  readonly securityPolicy?: SecurityPolicyV2;
}

/** 导出中的当前值投影：逐字段白名单，只含确认的非敏感配置与引用。 */
export interface ExportedCurrentSettings {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly strategies?: ExportedStrategies;
  readonly policies?: ExportedPolicies;
}

/**
 * 普通脱敏导出：scope 元数据 + 当前值投影（脱敏）+ 有效配置（F-009 合并值与来源）。
 * 不含明文秘密（`credentialRef`/`endpointRef` 只保留引用字符串）、不读取环境/
 * 认证文件/Keychain/CredentialProvider、不把结构合法标为执行就绪。
 */
export interface ExportedSettings {
  readonly exportFormatVersion: typeof SETTINGS_EXPORT_FORMAT_VERSION;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
  readonly current: ExportedCurrentSettings;
  readonly effective: EffectiveSettings;
}

/** 单条策略的导出投影（字段白名单；引用原样保留、不解析）。 */
function exportStrategy(strategy: RuntimeStrategyV1): ExportedStrategy {
  const result: {
    runtime: string;
    provider: string;
    model: string;
    credentialRef?: string;
    endpointRef?: string;
  } = { runtime: strategy.runtime, provider: strategy.provider, model: strategy.model };
  if (strategy.credentialRef !== undefined) {
    result.credentialRef = strategy.credentialRef;
  }
  if (strategy.endpointRef !== undefined) {
    result.endpointRef = strategy.endpointRef;
  }
  return result;
}

function exportStrategies(strategies: ProjectStrategiesV1 | undefined): ExportedStrategies | undefined {
  if (strategies === undefined) {
    return undefined;
  }
  const result: {
    defaultStrategy?: ExportedStrategy;
    modelMap?: Partial<Record<ModelComplexity, ExportedStrategy>>;
    purposeStrategies?: Partial<Record<StrategyPurpose, ExportedStrategy>>;
    agentOverrides?: Record<string, ExportedStrategy>;
  } = {};
  if (strategies.defaultStrategy !== undefined) {
    result.defaultStrategy = exportStrategy(strategies.defaultStrategy);
  }
  if (strategies.modelMap !== undefined) {
    const modelMap: Partial<Record<ModelComplexity, ExportedStrategy>> = {};
    for (const [key, value] of Object.entries(strategies.modelMap)) {
      if (value !== undefined) {
        modelMap[key as ModelComplexity] = exportStrategy(value);
      }
    }
    result.modelMap = modelMap;
  }
  if (strategies.purposeStrategies !== undefined) {
    const purposeStrategies: Partial<Record<StrategyPurpose, ExportedStrategy>> = {};
    for (const [key, value] of Object.entries(strategies.purposeStrategies)) {
      if (value !== undefined) {
        purposeStrategies[key as StrategyPurpose] = exportStrategy(value);
      }
    }
    result.purposeStrategies = purposeStrategies;
  }
  if (strategies.agentOverrides !== undefined) {
    const agentOverrides: Record<string, ExportedStrategy> = {};
    for (const [key, value] of Object.entries(strategies.agentOverrides)) {
      agentOverrides[key] = exportStrategy(value);
    }
    result.agentOverrides = agentOverrides;
  }
  return result;
}

function exportPolicies(policies: SettingsPoliciesV2 | undefined): ExportedPolicies | undefined {
  if (policies === undefined) {
    return undefined;
  }
  const result: {
    executionLimits?: ExecutionLimitsPolicyV2;
    verification?: VerificationPolicyV2;
    securityPolicy?: SecurityPolicyV2;
  } = {};
  if (policies.executionLimits !== undefined) {
    result.executionLimits =
      policies.executionLimits.envAllowlist === undefined
        ? { ...policies.executionLimits }
        : { ...policies.executionLimits, envAllowlist: [...policies.executionLimits.envAllowlist] };
  }
  if (policies.verification !== undefined) {
    result.verification = { ...policies.verification };
  }
  if (policies.securityPolicy !== undefined) {
    result.securityPolicy = { ...policies.securityPolicy };
  }
  return result;
}

/** 当前值 -> 导出投影（逐字段白名单；不导出存储内部 id/项目身份，不解析引用）。 */
function exportCurrentSettings(record: SettingsReadResult): ExportedCurrentSettings {
  const result: {
    schemaVersion: number;
    revision: number;
    strategies?: ExportedStrategies;
    policies?: ExportedPolicies;
  } = { schemaVersion: record.schemaVersion, revision: record.revision };
  const strategies = exportStrategies(record.payload.strategies);
  if (strategies !== undefined) {
    result.strategies = strategies;
  }
  const policies = exportPolicies(record.payload.policies);
  if (policies !== undefined) {
    result.policies = policies;
  }
  return result;
}

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
  /**
   * F-011 当前值查询：按 scope 返回全局单例/项目当前配置记录（含 schemaVersion、
   * 已校验 payload 与 revision）。缺失为 not_found；持久数据未知版本/损坏为
   * corrupt（不静默误读）。scope 校验先于任何 I/O。
   */
  getCurrentSettings(scope: unknown): Promise<SettingsReadResult>;
  /**
   * F-011 有效配置查询：调用 F-009 `mergeEffectiveSettings` 返回精确合并值与逐项
   * 来源。未知项目为 not_found；项目存在但双方均无策略时返回 `configured:false`
   * 的明确未配置/不可执行状态（不注入默认 Claude/API）。
   */
  getEffectiveSettings(projectId: string): Promise<EffectiveSettings>;
  /**
   * F-011 普通脱敏导出：当前值投影（只含确认的非敏感配置与引用）+ 有效配置来源。
   * 不解析凭据引用、不读环境/Keychain、不标记执行就绪；缺失为 not_found、损坏为
   * corrupt。省略 projectId 导出全局，提供时导出项目。
   */
  exportSettings(projectId?: string): Promise<ExportedSettings>;
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

  /**
   * 读取项目当前配置作为有效配置来源：不存在返回 null（项目存在但尚无覆盖或
   * 项目不存在——由调用方先用 getProject 区分）；其余错误（corrupt 等）原样传播。
   */
  async function readProjectSnapshot(projectId: string): Promise<{
    readonly revision: number;
    readonly payload: SettingsPayload;
  } | null> {
    try {
      const record = await stateStore.getProjectSettings(projectId);
      return { revision: record.revision, payload: record.payload };
    } catch (error) {
      if (isStorageError(error, 'not_found')) {
        return null;
      }
      throw error;
    }
  }

  /** 校验项目身份（稳定 ID）先于任何读取；未知项目由后续 getProject 返回 not_found。 */
  function validateProjectIdentity(operation: string, projectId: unknown): string {
    return validateStableId(
      projectId,
      { operation, entity: { type: 'project', id: typeof projectId === 'string' ? projectId : undefined } },
      'projectId',
    );
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

    async getCurrentSettings(scope: unknown): Promise<SettingsReadResult> {
      const operation = 'ConfigurationService.getCurrentSettings';
      // scope 校验先于任何 I/O：非法 scope 不产生读取。
      const validScope = validateSettingsScope(scope, { operation });
      if (validScope.kind === 'global') {
        return stateStore.getGlobalSettings();
      }
      return stateStore.getProjectSettings(validScope.projectId);
    },

    async getEffectiveSettings(projectId: string): Promise<EffectiveSettings> {
      const operation = 'ConfigurationService.getEffectiveSettings';
      const id = validateProjectIdentity(operation, projectId);
      // 项目必须存在：显式 not_found，与「项目存在但无覆盖」区分开。
      await stateStore.getProject(id);
      const global = await readGlobalSnapshot();
      const project = await readProjectSnapshot(id);
      return mergeEffectiveSettings({
        global: global === null ? null : { scopeRevision: global.revision, payload: global.payload },
        project: project === null ? null : { scopeRevision: project.revision, payload: project.payload },
      });
    },

    async exportSettings(projectId?: string): Promise<ExportedSettings> {
      const operation = 'ConfigurationService.exportSettings';
      if (projectId === undefined) {
        // 全局导出：当前值必须存在；未知版本/损坏读取为 corrupt（不作为可执行导出）。
        const global = await stateStore.getGlobalSettings();
        return {
          exportFormatVersion: SETTINGS_EXPORT_FORMAT_VERSION,
          scope: 'global',
          current: exportCurrentSettings(global),
          effective: mergeEffectiveSettings({
            global: { scopeRevision: global.revision, payload: global.payload },
          }),
        };
      }
      const id = validateProjectIdentity(operation, projectId);
      await stateStore.getProject(id);
      const project = await stateStore.getProjectSettings(id);
      const global = await readGlobalSnapshot();
      return {
        exportFormatVersion: SETTINGS_EXPORT_FORMAT_VERSION,
        scope: 'project',
        projectId: id,
        current: exportCurrentSettings(project),
        effective: mergeEffectiveSettings({
          global: global === null ? null : { scopeRevision: global.revision, payload: global.payload },
          project: { scopeRevision: project.revision, payload: project.payload },
        }),
      };
    },
  };
}
