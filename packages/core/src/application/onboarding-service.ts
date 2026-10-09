/**
 * F-004 P02-3 OnboardingService（application 层）：Core 静态 inspect 与
 * 注册/健康分离的 overview 用例（docs/p02-3-onboarding-contract.md
 * §4.3/§7.2/§7.3/§8.2/§15.1）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（RepositoryInspector / StateStore 只读子集 /
 *   ConfigurationService 查询切片 / RepositoryBindingLookupStore /
 *   BaselineHealthReadStore）与 F-005 纯授权判定；不接触适配器、驱动、
 *   HTTP 或 Pi SDK；import 本模块无副作用，装配时不执行任何 I/O；
 * - 授权在 Core 应用层执行（不经 HTTP 也拒绝）：inspect 要求 project.register
 *   能力且在任何 Git/文件 I/O 之前核验；canonicalPath 命中既有绑定后用
 *   requireProjectVisible 把关（不可见 → forbidden，不泄漏存在性）；
 *   overview 要求 baseline.read + 目标可见，未知/不可见统一 forbidden
 *   （mapProjectLookupError 折算，不回显 projectId）；
 * - inspect 只读：沿用 RepositoryInspector 的 Git argv/有限超时/根路径规则，
 *   不安装依赖、不执行 package 脚本、不加载插件、不写任何行、不新建目录、
 *   不自动 git init、不猜 main；Git/文件读取发生在数据库写事务之外（本服务
 *   不持有任何事务，绑定查找走独立窄端口只读查询）；
 * - overview 的注册状态与健康状态严格分开：registration 只描述绑定存在性，
 *   health 由 BaselineHealthReadStore 窄端口取得的 §8.2 派生原料经
 *   deriveProjectHealth 纯函数派生；注册成功/配置存在绝不显示为健康通过；
 *   当前配置只回传存在性与确认信息（revision/schemaVersion），payload 读取
 *   仍走 settings.project.get 的既有授权面；
 * - principal 形状非法属于可信装配编程错误（TypeError），不折算客户端错误；
 *   其余错误经 mapToPublicError 脱敏映射（不回显路径/stderr/堆栈）。
 */
import {
  assertTrustedPrincipal,
  authorizeProjectOverview,
  authorizeRepositoryInspect,
  mapProjectLookupError,
  requireProjectVisible,
} from '../ports/authorization.js';
import { deriveProjectHealth, ONBOARDING_QUERY_SCHEMA_VERSION, validateRepositoryRootPath } from '../ports/baseline.js';
import type {
  BaselineHealthReadStore,
  ProjectInspectionResult,
  ProjectOverviewResult,
  ProjectSettingsPresence,
} from '../ports/baseline.js';
import { mapToPublicError } from '../ports/commands.js';
import { isStorageError } from '../ports/errors.js';
import { toPublicProjectRecord, toPublicRepositoryBindingRecord } from '../ports/queries.js';
import type { RepositoryBindingLookupStore } from '../ports/queries.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import type { StateStore } from '../ports/state-store.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import type { ConfigurationService } from './configuration-service.js';

const PROJECTS_INSPECT_OPERATION = 'projects.inspect';
const PROJECTS_OVERVIEW_OPERATION = 'projects.overview';

/**
 * 静态接入用例服务。principal 由可信装配显式传入（生产固定 local-owner；
 * 受限主体仅测试装配），本服务绝不从请求数据取身份。
 */
export interface OnboardingService {
  /** projects.inspect：注册前只读仓库检查（§7.2；schemaVersion=3）。 */
  inspectRepository(principal: unknown, path: unknown): Promise<ProjectInspectionResult>;
  /** projects.overview：注册状态与健康状态分开的概览（§7.3；schemaVersion=3）。 */
  getProjectOverview(principal: unknown, projectId: unknown): Promise<ProjectOverviewResult>;
}

export interface OnboardingServiceOptions {
  /** 只读仓库检查端口（真实 Git 实现；Git/文件读取在写事务外）。 */
  readonly repositoryInspector: RepositoryInspector;
  /** StateStore 只读子集（项目/绑定详情读取）。 */
  readonly stateStore: Pick<StateStore, 'getProject' | 'getRepositoryBinding'>;
  /** 配置服务查询切片（当前值存在性与确认信息）。 */
  readonly configurationService: Pick<ConfigurationService, 'getCurrentSettings'>;
  /** §7.2 绑定查找窄端口（alreadyRegistered 判定）。 */
  readonly bindingReads: RepositoryBindingLookupStore;
  /** §7.3 基线健康窄端口（迁移 v4 前由组合根装配显式占位「尚无检查」）。 */
  readonly baselineReads: BaselineHealthReadStore;
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性 readAt。 */
  readonly nowUtcMs?: () => number;
}

function requirePort(value: unknown, field: string, method: string): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>)[method] !== 'function'
  ) {
    throw new TypeError(`createOnboardingService: ${field} 必须提供 ${method} 方法（可信装配编程错误）`);
  }
}

/**
 * 装配 OnboardingService。只校验依赖形态，不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createOnboardingService(options: OnboardingServiceOptions): OnboardingService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createOnboardingService: options 必须是对象');
  }
  requirePort(options.repositoryInspector, 'repositoryInspector', 'inspect');
  requirePort(options.stateStore, 'stateStore', 'getProject');
  requirePort(options.stateStore, 'stateStore', 'getRepositoryBinding');
  requirePort(options.configurationService, 'configurationService', 'getCurrentSettings');
  requirePort(options.bindingReads, 'bindingReads', 'findBindingByCanonicalPath');
  requirePort(options.baselineReads, 'baselineReads', 'readProjectHealthInput');
  const { repositoryInspector, stateStore, configurationService, bindingReads, baselineReads } =
    options;
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function requireProjectId(projectId: unknown, operation: string): string {
    const context: ValidationContext = { operation, entity: { type: 'project' } };
    return validateStableId(projectId, context, 'projectId');
  }

  return {
    async inspectRepository(principal: unknown, path: unknown): Promise<ProjectInspectionResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_INSPECT_OPERATION;
      try {
        // 能力核验先于路径校验与任何 Git/文件 I/O。
        authorizeRepositoryInspect(principal, operation);
        const repositoryPath = validateRepositoryRootPath(path, operation);
        // 只读仓库检查：独立 argv/有限超时/根路径规则；不持有任何数据库事务。
        const inspection = await repositoryInspector.inspect(repositoryPath);
        const binding = bindingReads.findBindingByCanonicalPath(inspection.canonicalPath);
        let alreadyRegistered: { readonly projectId: string } | null = null;
        if (binding !== null) {
          // 已绑定到不可见项目 → forbidden（与注册一致，不泄漏存在性）。
          requireProjectVisible(principal, binding.projectId, operation);
          alreadyRegistered = { projectId: binding.projectId };
        }
        return {
          schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
          canonicalPath: inspection.canonicalPath,
          repoIdentity: inspection.repoIdentity,
          headCommit: inspection.headCommit,
          hasInitialCommit: inspection.hasInitialCommit,
          hasUncommittedChanges: inspection.hasUncommittedChanges,
          alreadyRegistered,
          readAt: new Date(nowUtcMs()).toISOString(),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getProjectOverview(principal: unknown, projectId: unknown): Promise<ProjectOverviewResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_OVERVIEW_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectOverview(principal, id, operation);
        let project;
        try {
          project = await stateStore.getProject(id);
        } catch (error) {
          // 项目缺失折算为与不可见相同的 forbidden（不区分存在性）。
          mapProjectLookupError(error, operation);
        }
        let binding = null;
        try {
          binding = await stateStore.getRepositoryBinding(id);
        } catch (error) {
          // 项目存在但尚无绑定 → binding:null + not_registered；其余错误原样传播。
          if (isStorageError(error, 'not_found') && error.entity?.type === 'repository_binding') {
            binding = null;
          } else {
            throw error;
          }
        }
        let settings: ProjectSettingsPresence;
        try {
          const record = await configurationService.getCurrentSettings({
            kind: 'project',
            projectId: id,
          });
          settings = { configured: true, revision: record.revision, schemaVersion: record.schemaVersion };
        } catch (error) {
          // 未配置是明确结果（configured:false）；损坏/未知版本不降级成已配置。
          if (isStorageError(error, 'not_found')) {
            settings = { configured: false };
          } else {
            throw error;
          }
        }
        // 健康只由基线窄端口的 §8.2 派生原料决定：注册/配置事实不参与。
        const health = deriveProjectHealth(baselineReads.readProjectHealthInput(id));
        return {
          schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
          project: toPublicProjectRecord(project),
          binding: binding === null ? null : toPublicRepositoryBindingRecord(binding),
          registration: { status: binding === null ? 'not_registered' : 'registered' },
          settings,
          health,
          readAt: new Date(nowUtcMs()).toISOString(),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
