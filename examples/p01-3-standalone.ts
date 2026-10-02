/**
 * P01-3 / F-012 独立 Core 调用示例（可编译、可测试；不是 CLI、不是 Host）。
 *
 * 本示例只演示 **公开 Core 装配入口**（`packages/core/src/adapters/composition.ts`，
 * 经 `shiploop-core` 的 `./assembly` 子路径导出）的真实调用序列：
 *
 *   打开 Core 应用（真实临时数据根 + 真实临时仓库）
 *     → 注册项目（仓库绑定、稳定 projectId）
 *     → 查询项目身份
 *     → CAS 编辑元数据（名称/标签）
 *     → 写入全局当前配置与项目覆盖
 *     → 读取当前配置 / 有效配置（含来源）/ 脱敏导出
 *     → 受权定位项目目录
 *     → 关闭；重新打开同一数据根核验持久化，再关闭。
 *
 * 边界（与验收一致，不扩大范围）：
 * - 不编造任何 `shiploop` CLI 命令；本文件不经参数解析，只导出可被编译/测试调用的函数；
 * - 不导入 Pi SDK、HTTP/Electron、better-sqlite3 或 Drizzle 类型；示例只消费
 *   Core 公共端口与应用服务；
 * - 结构合法 ≠ 可执行：P01 未装配 Runner/认证/模型执行，本示例只读写配置，不调用模型；
 * - 示例本身不访问真实用户目录：dataRoot 与 repositoryPath 均由调用方显式注入
 *   （测试/冒烟脚本使用临时沙箱）。
 */
import { openCoreApplication } from '../packages/core/src/adapters/composition.js';
import type { CoreApplication } from '../packages/core/src/adapters/composition.js';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.js';
import type { EffectiveSettings } from '../packages/core/src/application/effective-settings.js';
import type { ExportedSettings } from '../packages/core/src/application/configuration-service.js';
import type { LocatedPath } from '../packages/core/src/ports/path-service.js';

/** 示例装配配置：调用方注入真实临时数据根与仓库路径，以及可信能力目录。 */
export interface StandaloneCoreExampleOptions {
  /** 受控数据根（绝对路径）；不存在时由装配入口创建，只在该根内写入状态库与制品。 */
  readonly dataRoot: string;
  /** 真实本地仓库根（工作树顶层），由调用方在临时沙箱内初始化。 */
  readonly repositoryPath: string;
  /** 可信装配注入的只读能力目录（F-008）；决定策略条目是否被确认。 */
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
}

/** 示例结果摘要（只含相对逻辑信息与稳定 ID，不含绝对路径/秘密）。 */
export interface StandaloneCoreExampleResult {
  readonly projectId: string;
  readonly registrationStatus: 'registered' | 'already_exists';
  readonly canonicalPath: string;
  readonly repoIdentity: string;
  readonly metadataRevisionAfterEdit: number;
  readonly displayNameAfterEdit: string;
  readonly labelsAfterEdit: readonly string[];
  readonly globalRevision: number;
  readonly projectRevision: number;
  readonly effectiveConfigured: boolean;
  readonly effectiveStrategySource: 'global_default' | 'project_default';
  readonly effectiveRevision: number;
  readonly exportedScope: 'global' | 'project';
  readonly exportedProjectId: string | undefined;
  readonly locatedResourceType: LocatedPath['resourceType'];
  readonly reopenedProjectId: string;
  readonly reopenedProjectRevision: number;
  readonly reopenedProjectSettingsRevision: number;
}

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
} as const;

const PROJECT_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-example' } },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 2 },
  },
} as const;

/** 打开 Core 应用并在同一数据根内跑完整示例序列；返回可断言的结果摘要。 */
export async function runStandaloneCoreExample(
  options: StandaloneCoreExampleOptions,
): Promise<StandaloneCoreExampleResult> {
  let projectId: string;
  let registrationStatus: 'registered' | 'already_exists';
  let binding: { canonicalPath: string; repoIdentity: string };
  let metadataRevisionAfterEdit: number;
  let displayNameAfterEdit: string;
  let labelsAfterEdit: readonly string[];
  let globalRevision: number;
  let projectRevision: number;
  let effectiveSettings: EffectiveSettings;
  let exported: ExportedSettings;
  let located: LocatedPath;

  const first: CoreApplication = await openCoreApplication({
    dataRoot: options.dataRoot,
    capabilityCatalog: options.capabilityCatalog,
  });
  try {
    const registration = await first.projectService.registerRepository({
      repositoryPath: options.repositoryPath,
      displayName: '示例项目',
      description: '独立 Core 调用示例',
      labels: ['Alpha', ' beta ', 'alpha'],
    });
    projectId = registration.project.id;
    registrationStatus = registration.status;
    binding = {
      canonicalPath: registration.binding.canonicalPath,
      repoIdentity: registration.binding.repoIdentity,
    };

    const fetched = await first.projectService.getProject(projectId);
    const updated = await first.projectService.updateProjectMetadata(projectId, {
      expectedRevision: fetched.revision,
      displayName: '示例项目（已改名）',
      labels: ['示例', 'Example'],
    });
    metadataRevisionAfterEdit = updated.revision;
    displayNameAfterEdit = updated.displayName;
    labelsAfterEdit = updated.labels;

    const global = await first.configurationService.createSettings(
      { kind: 'global' },
      { payload: GLOBAL_PAYLOAD },
    );
    globalRevision = global.revision;

    const projectSettings = await first.configurationService.createSettings(
      { kind: 'project', projectId },
      { payload: PROJECT_PAYLOAD },
    );
    projectRevision = projectSettings.revision;

    effectiveSettings = await first.configurationService.getEffectiveSettings(projectId);
    exported = await first.configurationService.exportSettings(projectId);
    located = await first.pathService.locateProjectResource(
      { projectId },
      { type: 'project_directory', projectId },
    );
  } finally {
    first.close();
  }

  const second = await openCoreApplication({
    dataRoot: options.dataRoot,
    capabilityCatalog: options.capabilityCatalog,
  });
  let reopenedProjectId: string;
  let reopenedProjectRevision: number;
  let reopenedProjectSettingsRevision: number;
  try {
    const reopenedProject = await second.projectService.getProject(projectId);
    const reopenedSettings = await second.configurationService.getCurrentSettings({
      kind: 'project',
      projectId,
    });
    reopenedProjectId = reopenedProject.id;
    reopenedProjectRevision = reopenedProject.revision;
    reopenedProjectSettingsRevision = reopenedSettings.revision;
  } finally {
    second.close();
  }

  const lowStrategy = effectiveSettings.strategies.modelMap.low;
  return {
    projectId,
    registrationStatus,
    canonicalPath: binding.canonicalPath,
    repoIdentity: binding.repoIdentity,
    metadataRevisionAfterEdit,
    displayNameAfterEdit,
    labelsAfterEdit,
    globalRevision,
    projectRevision,
    effectiveConfigured: effectiveSettings.configured,
    effectiveStrategySource: lowStrategy?.source.kind ?? 'global_default',
    effectiveRevision: lowStrategy?.source.scopeRevision ?? 0,
    exportedScope: exported.scope,
    exportedProjectId: exported.projectId,
    locatedResourceType: located.resourceType,
    reopenedProjectId,
    reopenedProjectRevision,
    reopenedProjectSettingsRevision,
  };
}
