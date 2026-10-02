/**
 * P01-3 / F-005 ProjectService（application 层）：仓库注册用例——只读仓库检查
 * 在写事务之外完成，项目身份、描述、规范标签与仓库绑定在同一短事务内原子保存；
 * 同一规范路径（含符号链接别名）幂等复用，不同 clone（同 remote）分别注册。
 *
 * 设计依据：core-design/06 §1（项目 init：规范路径重复 init 返回已有项目；同
 * remote 不同 clone 可注册不同项目）、core-design/03 §1/§3（canonical_path 全库
 * 唯一；短事务内不做 Git/文件检查）与 docs/p01-3-application-contract.md §4.1。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（StateStore / RepositoryInspector），不接触适配器、
 *   驱动、HTTP 或 Pi SDK；import 本模块无副作用，装配时不执行任何 I/O；
 * - 严格顺序：输入运行时校验（非法标签/名称在任何 I/O 之前拒绝）→ 只读仓库
 *   检查（Git/文件系统，数据库写事务之外）→ 单个短事务原子保存项目 + 绑定；
 *   仓库检查瞬时事实（HEAD/脏状态）不持久化，只保存身份与位置；
 * - 幂等：同 canonicalPath 重复注册返回 already_exists 与既有项目/绑定，
 *   不新增行、不覆盖既有名称/描述/标签；跨进程竞争由存储端口在 BEGIN
 *   IMMEDIATE 下串行化，唯一约束兜底后做有界核对（见适配器）；
 * - projectId 由存储端口应用侧生成（UUID），不由 displayName、remote 或目录
 *   标题推导；
 * - 错误原样向上传播且保持结构化：元数据/输入非法为
 *   StorageError(kind='validation')，仓库检查失败为 RepositoryInspectionError，
 *   存储失败为 StorageError；任何失败分支都不产生业务行。
 *
 * 本模块已实现（F-006）：项目身份/绑定查询与名称、描述、标签的 CAS 元数据编辑
 * 用例。查询直接复用 StateStore 读取端口；编辑先经 F-002 共用校验器（非法字段/
 * 标签先于任何 I/O 拒绝），再交由 StateStore.updateProject 在单个短事务内完成
 * CAS 更新与脱敏变更记录（state_events）——改名称/描述/标签不触碰 projectId、
 * canonicalPath、配置或 PathService 位置，也不改变仓库绑定。
 *
 * 本模块已实现（F-007）：项目标签任一/全部筛选、稳定 id 升序有界分页与项目层
 * 标签去重计数查询（listProjects / countProjectLabels），直接复用 StateStore
 * 只读查询端口，不另立第二套标签规则。
 *
 * 本模块不实现（后续任务）：配置服务（F-008~F-011）、
 * rebind、存量基线扫描、Host/CLI 路由。
 */
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import { validateCreateProjectInput, validateUpdateProjectInput } from '../ports/state-store.js';
import type {
  ProjectLabelCount,
  ProjectPage,
  ProjectRecord,
  ProjectWithRepositoryBindingResult,
  RepositoryBindingRecord,
  StateStore,
  ValidatedCreateProjectInput,
} from '../ports/state-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/**
 * 仓库注册输入（边界为 unknown，经运行时校验）：
 * - repositoryPath：用户提供的本地路径（可为符号链接别名），由
 *   RepositoryInspector 校验并 realpath 规范化；
 * - displayName/description/labels：项目元数据（F-002 规则），不参与身份或
 *   物理路径推导。
 */
export interface RegisterRepositoryInput {
  readonly repositoryPath: string;
  readonly displayName: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
}

/** 注册结果：registered（新建）或 already_exists（同规范路径复用既有项目/绑定）。 */
export type RegisterRepositoryResult = ProjectWithRepositoryBindingResult;

/**
 * 项目应用服务：仓库注册（F-005）与项目身份查询/元数据 CAS 编辑（F-006）。
 */
export interface ProjectService {
  registerRepository(input: unknown): Promise<RegisterRepositoryResult>;
  /** 按 projectId 返回持久化项目身份（含绑定 ID）；未知 ID 返回 not_found。 */
  getProject(projectId: string): Promise<ProjectRecord>;
  /** 按 projectId 返回完整仓库绑定；未知项目/无绑定返回 not_found。 */
  getRepositoryBinding(projectId: string): Promise<RepositoryBindingRecord>;
  /** 名称/描述/标签的 CAS 元数据编辑；匹配 expectedRevision 后返回递增 revision。 */
  updateProjectMetadata(projectId: string, input: unknown): Promise<ProjectRecord>;
  /** F-007：按标签任一/全部筛选、稳定 id 升序有界分页列出项目。 */
  listProjects(filter?: unknown): Promise<ProjectPage>;
  /** F-007：项目层标签去重计数（同一项目同标签只计一次），不跨层级求和。 */
  countProjectLabels(): Promise<readonly ProjectLabelCount[]>;
}

export interface ProjectServiceDeps {
  readonly stateStore: StateStore;
  readonly repositoryInspector: RepositoryInspector;
}

interface ValidatedRegisterRepositoryInput {
  readonly repositoryPath: unknown;
  readonly metadata: ValidatedCreateProjectInput;
}

/**
 * 注册输入运行时校验：白名单键 + 元数据复用 F-002 共用校验器。
 * repositoryPath 保持 unknown 原样转交 RepositoryInspector（其自带窄校验），
 * 本层不预先拼接或规范化路径。元数据校验先于任何 I/O：非法标签/名称时
 * 不调用仓库检查，也不接触存储端口。
 */
function validateRegisterRepositoryInput(
  value: unknown,
  operation: string,
): ValidatedRegisterRepositoryInput {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(
    object,
    ['repositoryPath', 'displayName', 'description', 'labels'],
    context,
    'input',
  );
  if (object.repositoryPath === undefined) {
    throw validationError(context, 'repositoryPath', '必须提供本地仓库路径');
  }
  const metadata = validateCreateProjectInput(
    {
      displayName: object.displayName,
      description: object.description,
      labels: object.labels,
    },
    operation,
  );
  return { repositoryPath: object.repositoryPath, metadata };
}

/**
 * 装配 ProjectService。只校验依赖形态，不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const context: ValidationContext = { operation: 'ProjectService.create' };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 stateStore/repositoryInspector 装配依赖');
  }
  if (deps.stateStore === null || typeof deps.stateStore !== 'object') {
    throw validationError(context, 'deps.stateStore', '必须提供 StateStore 端口实现');
  }
  if (deps.repositoryInspector === null || typeof deps.repositoryInspector !== 'object') {
    throw validationError(context, 'deps.repositoryInspector', '必须提供 RepositoryInspector 端口实现');
  }
  const { stateStore, repositoryInspector } = deps;

  return {
    async registerRepository(input: unknown): Promise<RegisterRepositoryResult> {
      const operation = 'ProjectService.registerRepository';
      // 1. 输入校验（任何 I/O 与持久化之前；失败零副作用）。
      const valid = validateRegisterRepositoryInput(input, operation);
      // 2. 只读仓库检查（Git/文件系统，数据库写事务之外；检查失败零业务行）。
      const inspection = await repositoryInspector.inspect(valid.repositoryPath);
      // 3. 单个短事务原子保存项目 + 绑定（同 canonicalPath 幂等复用）。
      return stateStore.createProjectWithRepositoryBinding(valid.metadata, {
        canonicalPath: inspection.canonicalPath,
        gitCommonDir: inspection.gitCommonDir,
        repoIdentity: inspection.repoIdentity,
      });
    },

    async getProject(projectId: string): Promise<ProjectRecord> {
      // projectId 形态校验由读取端口完成；未知 ID 返回结构化 not_found。
      return stateStore.getProject(projectId);
    },

    async getRepositoryBinding(projectId: string): Promise<RepositoryBindingRecord> {
      return stateStore.getRepositoryBinding(projectId);
    },

    async updateProjectMetadata(projectId: string, input: unknown): Promise<ProjectRecord> {
      const operation = 'ProjectService.updateProjectMetadata';
      // F-002 共用校验先于任何 I/O：非法字段/标签在接触存储前拒绝，错误定位到字段。
      // 通过后交由存储端口在同一短事务内完成 CAS 更新 + 脱敏变更记录并返回新记录。
      validateUpdateProjectInput(input, operation);
      return stateStore.updateProject(projectId, input);
    },

    async listProjects(filter?: unknown): Promise<ProjectPage> {
      // 查询筛选/分页/绑定参数由存储端口统一完成；应用层不另立第二套标签规则。
      return stateStore.listProjects(filter);
    },

    async countProjectLabels(): Promise<readonly ProjectLabelCount[]> {
      return stateStore.countProjectLabels();
    },
  };
}
