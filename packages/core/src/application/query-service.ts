/**
 * F-010 QueryService（application 层）：授权项目/配置查询、一致读视图快照
 * 水位与分页事件读取（docs/p02-2-commands-events-contract.md §4/§7/§8/§9.3）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（AuthorizedProjectReadStore / ConsistentSnapshotStore /
 *   StateEventReadStore / StateStore 只读子集 / ConfigurationService 查询切片）
 *   与 F-005 纯授权判定；不接触适配器、驱动、HTTP 或 Pi SDK；import 本模块
 *   无副作用，装配时不执行任何 I/O；
 * - 授权在 Core 应用层执行（不经 HTTP 也拒绝）：能力核验先于数据库读取；
 *   不可见项目与不存在项目对调用方统一 forbidden（mapProjectLookupError
 *   折算，不回显 projectId）；全局配置/全局事件独立授权（settings.global.read，
 *   项目能力不蕴含）；项目配置读 = project.read 或 settings.project.read；
 * - 可见范围谓词随端口下推 SQL（先收窄再分页/计数），事件行级可见过滤器
 *   （F-005 createEventVisibilityFilter）作为防御纵深复核：SQL 结果与谓词
 *   不一致是适配器编程错误（TypeError），绝不静默跳过；
 * - 快照内容（项目/绑定/当前配置/有效配置/水位）取自 ConsistentSnapshotStore
 *   的同一 SQLite 一致读视图：水位是该视图内的 MAX(state_events.sequence)，
 *   禁止多次独立读取后随手拼水位；有效配置（含全局来源 revision）由同一
 *   视图记录经 F-009 mergeEffectiveSettings 纯函数合并；
 * - 查询全部只读：不写 state_events、不创建任何行、不解析凭据引用、不执行
 *   脚本、不接受任意文件路径参数；无配置是明确结果（configured:false /
 *   not_found），损坏持久 JSON/未知版本为 corrupt_state，绝不降级成「已配置」；
 * - 事件读取：游标经 F-003 decodeEventCursor 绑定数据根身份与 scope（坏游标
 *   invalid_input(invalid_cursor)，绝不当从零读取；未来游标合法）；事件按
 *   sequence 升序有界分页（默认 100/上限 500），eventId 供客户端去重；持久
 *   行列经 mapStateEvents 白名单映射（损坏/未知类型显式 corrupt_state）；
 * - principal 形状非法属于可信装配编程错误（TypeError），不折算客户端错误；
 *   其余错误经 mapToPublicError 脱敏映射（不回显路径/payload 原文/堆栈）。
 */
import {
  assertTrustedPrincipal,
  authorizeEventSubscription,
  authorizeGlobalSettingsRead,
  authorizeProjectLabelCounts,
  authorizeProjectRead,
  authorizeProjectSettingsRead,
  authorizeProjectsList,
  authorizeSnapshot,
  createEventVisibilityFilter,
  isProjectVisible,
  mapProjectLookupError,
  principalProjectVisibility,
  requireCapability,
  requireProjectVisible,
} from '../ports/authorization.js';
import {
  PublicError,
  WIRE_MESSAGE_SCHEMA_VERSION,
  isUuidV4,
  mapToPublicError,
} from '../ports/commands.js';
import {
  createEventCursorBinding,
  createEventWatermark,
  decodeEventCursor,
  encodeEventCursor,
  mapStateEvents,
  normalizeMaxEventSequence,
  validateEventPageLimit,
  validateEventScope,
} from '../ports/events.js';
import type {
  EventCursorBinding,
  PublicEventScope,
  PublicStateEvent,
} from '../ports/events.js';
import {
  createPlanListCursorBinding,
  decodePlanListCursor,
  deriveFeatureNotExecutableReasons,
  encodePlanListCursor,
  PLAN_APPROVAL_QUERY_OPERATION,
  toPublicFeatureRecord,
  toPublicPhaseRecord,
  toPublicPlanApprovalRecord,
  toPublicProjectRecord,
  toPublicRepositoryBindingRecord,
  toPublicSettingsState,
  toPublicTaskDependencyEdge,
  toPublicTaskRecord,
  validatePlanListFilter,
} from '../ports/queries.js';
import type {
  AuthorizedProjectReadStore,
  ConsistentSnapshotStore,
  FeatureApprovalsResult,
  FeatureDetailResult,
  FeatureListResult,
  FeaturePlanValidationSummary,
  PlanListCursorBinding,
  PlanListScope,
  PlanListRequest,
  PlanQueryReadStore,
  ValidatedPlanListFilter,
  ProjectBindingResult,
  ProjectDetailResult,
  ProjectLabelCountsResult,
  ProjectListResult,
  PublicSettingsState,
  PhaseDetailResult,
  PhaseListResult,
  TaskDetailResult,
  TaskListResult,
} from '../ports/queries.js';
import type { StateEventReadStore } from '../ports/events.js';
import { isStorageError } from '../ports/errors.js';
import type { SettingsScope } from '../ports/settings-schema.js';
import { validateProjectListFilter } from '../ports/state-store.js';
import type { StateStore } from '../ports/state-store.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import {
  requirePlainObject,
  rejectUnknownKeys,
} from '../ports/validation.js';
import type { ConfigurationService } from './configuration-service.js';
import type { ExportedSettings } from './configuration-service.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import type { EffectiveSettings } from './effective-settings.js';
import type { EventWatermark } from '../ports/events.js';

/** 分页事件读取结果（Core 内部面；F-012 SSE 补读复用）。 */
export interface StateEventPage {
  readonly scope: PublicEventScope;
  readonly events: readonly PublicStateEvent[];
  /** 本页用满 limit 时为最后一事件之后的不透明续读游标；否则 null（页末明确）。 */
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** F-012 SSE 建连恢复位置（§9.4）：授权后经游标或 Last-Event-ID 解析。 */
export interface EventResumePosition {
  readonly scope: PublicEventScope;
  /** 排他下界：从 sequence > afterSequence 的已提交事件开始补读。 */
  readonly afterSequence: number;
  /** 同一位置的不透明续读游标（绑定数据根与 scope，供客户端落盘恢复）。 */
  readonly resumeCursor: string;
}

/** F-012 SSE 轮询补读批次（Host 可信传输面自持位置，不来自客户端字段）。 */
export interface StateEventBatch {
  readonly scope: PublicEventScope;
  readonly events: readonly PublicStateEvent[];
  /** 本批最后一事件的 sequence；空批等于请求的 afterSequence（位置不后退）。 */
  readonly lastSequence: number;
  readonly limit: number;
}

interface SnapshotBase {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly watermark: EventWatermark;
  /** 快照装配时刻（ISO UTC；注入时钟）。 */
  readonly readAt: string;
}

/** §8 项目快照：项目 + 绑定（无则 null）+ 项目当前配置（无则 null）+ 有效配置 + 水位。 */
export interface ProjectSnapshotResult extends SnapshotBase {
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly project: ReturnType<typeof toPublicProjectRecord>;
  readonly binding: ReturnType<typeof toPublicRepositoryBindingRecord> | null;
  readonly settings: PublicSettingsState | null;
  readonly effective: EffectiveSettings;
}

/** §8 全局快照：全局当前配置（无则 null）+ 水位。 */
export interface GlobalSnapshotResult extends SnapshotBase {
  readonly scope: { readonly kind: 'global' };
  readonly settings: PublicSettingsState | null;
}

export type SnapshotResult = ProjectSnapshotResult | GlobalSnapshotResult;

/**
 * 授权查询服务：项目/绑定/配置/快照/事件。principal 由可信装配显式传入
 * （生产固定 local-owner；受限主体仅测试装配），本服务绝不从请求数据取身份。
 */
export interface QueryService {
  /** projects.list：project.read + 可见谓词下推 + P01 标签/分页规则。 */
  listProjects(principal: unknown, filter?: unknown): Promise<ProjectListResult>;
  /** projects.labelCounts：与列表同一可见范围的项目层标签去重计数。 */
  countProjectLabels(principal: unknown): Promise<ProjectLabelCountsResult>;
  /** projects.get：项目 + 绑定一次授权组装（无绑定 binding:null）。 */
  getProject(principal: unknown, projectId: unknown): Promise<ProjectDetailResult>;
  /** projects.binding.get：无绑定 not_found（entityType repository_binding）。 */
  getRepositoryBinding(principal: unknown, projectId: unknown): Promise<ProjectBindingResult>;
  /** settings.global.get：settings.global.read 独立授权；缺失 not_found。 */
  getGlobalSettings(principal: unknown): Promise<PublicSettingsState>;
  /** settings.project.get：project.read 或 settings.project.read + 目标可见。 */
  getProjectSettings(principal: unknown, projectId: unknown): Promise<PublicSettingsState>;
  /** settings.project.effective：P01 有效配置合并与逐项来源；configured:false 明确未配置。 */
  getEffectiveSettings(principal: unknown, projectId: unknown): Promise<EffectiveSettings>;
  /** settings.global.export：P01 脱敏导出（引用原样、不解析）。 */
  exportGlobalSettings(principal: unknown): Promise<ExportedSettings>;
  /** settings.project.export：同上，项目 scope。 */
  exportProjectSettings(principal: unknown, projectId: unknown): Promise<ExportedSettings>;
  /** snapshot.get：同一 SQLite 一致读视图 + 事件水位（游标绑定数据根与 scope）。 */
  getSnapshot(principal: unknown, scope: unknown): Promise<SnapshotResult>;
  /**
   * 事件分页读取（F-012 SSE 补读复用）：events.read + 范围读能力授权；
   * 游标必填（缺失 cursor_required），非法/跨根/跨 scope 一律 invalid_cursor。
   */
  listEvents(principal: unknown, input: unknown): Promise<StateEventPage>;
  /**
   * F-012 SSE 建连恢复解析（§9.4）：events.read + 范围读能力授权先于任何
   * 读取；恢复位置按契约优先级 Last-Event-ID → cursor；两者皆缺
   * cursor_required；Last-Event-ID 在当前 scope 内解析不到（不存在或属于
   * 其他 scope，不区分）→ invalid_input(unknown_event_id)；非法游标
   * invalid_cursor，绝不当从零读取；未来游标合法（等待是订阅方策略）。
   */
  resolveEventResume(principal: unknown, input: unknown): Promise<EventResumePosition>;
  /**
   * F-012 SSE 轮询补读：Host 可信传输面自持的排他下界（绝非客户端字段）+
   * 有界分页；每次调用重新核验当前授权（能力/可见性撤销即拒绝）。
   */
  readEventBatch(principal: unknown, input: unknown): Promise<StateEventBatch>;
  /**
   * F-006 phases.get：按 Phase ID 查询（真实父级 projectId、标题/描述/标签/
   * revision）；能力 + 可见性先行，不可见与不存在统一 not_found。
   */
  getPhase(principal: unknown, phaseId: unknown): Promise<PhaseDetailResult>;
  /**
   * F-006 features.get：Feature 详情（真实父级、planDigest/planStatus/不可执行
   * 原因）与完整同 Feature Task DAG（节点 + 依赖边）；内容取自同一一致读视图，
   * 不虚构 Run/Attempt 结果。
   */
  getFeature(principal: unknown, featureId: unknown): Promise<FeatureDetailResult>;
  /**
   * P03-2 / F-002 features.approvals：Feature 计划审批决策查询（当前决定 vs
   * 历史决定按 planDigest 绑定区分；feature.planStatus 为权威审批状态，拒绝
   * 后绝非 approved）。能力位复用 project.read；Host 传输接线属 F-007。
   */
  getFeatureApprovals(principal: unknown, featureId: unknown): Promise<FeatureApprovalsResult>;
  /** F-006 tasks.get：Task 详情（真实父级、验收/需求引用/策略副本及来源）。 */
  getTask(principal: unknown, taskId: unknown): Promise<TaskDetailResult>;
  /** F-006 phases.list：项目内 Phase 层级列表（稳定排序、有限分页、受控游标）。 */
  listPhases(principal: unknown, input: unknown): Promise<PhaseListResult>;
  /** F-006 features.list：Phase 内 Feature 层级列表（游标绑定项目 + 父级）。 */
  listFeatures(principal: unknown, input: unknown): Promise<FeatureListResult>;
  /** F-006 tasks.list：Feature 内 Task 层级列表（游标绑定项目 + 父级）。 */
  listTasks(principal: unknown, input: unknown): Promise<TaskListResult>;
}

export interface QueryServiceOptions {
  /** F-010 可见谓词下推的项目列表/计数窄读取端口。 */
  readonly projectReads: AuthorizedProjectReadStore;
  /** F-010 §8 一致读视图窄端口。 */
  readonly snapshots: ConsistentSnapshotStore;
  /** F-010 持久事件分页读取窄端口。 */
  readonly eventReads: StateEventReadStore;
  /** P01 StateStore 只读子集（项目/绑定详情读取）。 */
  readonly stateStore: Pick<StateStore, 'getProject' | 'getRepositoryBinding'>;
  /** P01 配置服务查询切片（当前值/有效配置/脱敏导出）。 */
  readonly configurationService: Pick<
    ConfigurationService,
    'getCurrentSettings' | 'getEffectiveSettings' | 'exportSettings'
  >;
  /** P03-1 / F-006 计划层级列表/详情一致读取窄端口。 */
  readonly planReads: PlanQueryReadStore;
  /** 数据根身份（64hex；可信装配由 realpath 数据根派生，绝不来自请求数据）。 */
  readonly dataRootIdentity: string;
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性 readAt。 */
  readonly nowUtcMs?: () => number;
}

const PROJECTS_LIST_OPERATION = 'projects.list';
const PROJECTS_LABEL_COUNTS_OPERATION = 'projects.labelCounts';
const PROJECTS_GET_OPERATION = 'projects.get';
const PROJECTS_BINDING_GET_OPERATION = 'projects.binding.get';
const SETTINGS_GLOBAL_GET_OPERATION = 'settings.global.get';
const SETTINGS_PROJECT_GET_OPERATION = 'settings.project.get';
const SETTINGS_PROJECT_EFFECTIVE_OPERATION = 'settings.project.effective';
const SETTINGS_GLOBAL_EXPORT_OPERATION = 'settings.global.export';
const SETTINGS_PROJECT_EXPORT_OPERATION = 'settings.project.export';
const SNAPSHOT_GET_OPERATION = 'snapshot.get';
const EVENTS_SUBSCRIBE_OPERATION_NAME = 'events.subscribe';
// P03-1 / F-006 计划查询操作身份（与 ports/queries.ts PLAN_QUERY_OPERATIONS 同源）。
const PHASES_LIST_OPERATION = 'phases.list';
const PHASES_GET_OPERATION = 'phases.get';
const FEATURES_LIST_OPERATION = 'features.list';
const FEATURES_GET_OPERATION = 'features.get';
const TASKS_LIST_OPERATION = 'tasks.list';
const TASKS_GET_OPERATION = 'tasks.get';

/**
 * F-006 计划实体「不可见/不存在」统一 not_found（与 receipts.get 同一纪律：
 * 不区分存在性，不回显归属或实体身份）；能力缺失仍先行 forbidden。
 */
function planEntityNotFound(
  operation: string,
  entityType: 'phase' | 'feature' | 'task',
): never {
  throw new PublicError('not_found', operation, '计划实体不存在或不可见', {
    details: { reason: 'plan_entity_not_found', entityType },
  });
}

/**
 * 装配 QueryService。只校验依赖形态，不执行任何 I/O；import 本模块无副作用。
 */
export function createQueryService(options: QueryServiceOptions): QueryService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createQueryService: options 必须是对象');
  }
  const {
    projectReads,
    snapshots,
    eventReads,
    stateStore,
    configurationService,
    planReads,
    dataRootIdentity,
  } = options;
  if (typeof dataRootIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(dataRootIdentity)) {
    throw new TypeError('createQueryService: dataRootIdentity 必须是 64 位小写十六进制（可信装配派生）');
  }
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  /** 游标绑定：数据根身份 + scope（每次构造；createEventCursorBinding 复核形状）。 */
  function cursorBinding(scope: PublicEventScope, operation: string): EventCursorBinding {
    return createEventCursorBinding({ rootIdentity: dataRootIdentity, scope }, operation);
  }

  /** 项目目标身份校验（非法稳定 ID 在任何授权/读取之前 invalid_input）。 */
  function requireProjectId(projectId: unknown, operation: string): string {
    const context: ValidationContext = { operation, entity: { type: 'project' } };
    return validateStableId(projectId, context, 'projectId');
  }

  /** F-006：层级列表分页过滤器（只取 limit/cursor；非法参数/未知键拒绝）。 */
  function validatedPlanFilter(
    object: Record<string, unknown>,
    operation: string,
  ): ValidatedPlanListFilter {
    const filter: Record<string, unknown> = {};
    if (object.limit !== undefined) filter.limit = object.limit;
    if (object.cursor !== undefined) filter.cursor = object.cursor;
    return validatePlanListFilter(filter, operation);
  }

  /** F-006：游标绑定（数据根 + 列表 scope；仅可信装配构造，绝不来自请求字段）。 */
  function planCursorBinding(scope: PlanListScope, operation: string): PlanListCursorBinding {
    return createPlanListCursorBinding({ rootIdentity: dataRootIdentity, scope }, operation);
  }

  /** F-006：游标 → 键集排他下界（非法/跨根/跨项目/跨父级一律 invalid_cursor）。 */
  function planListRequest(
    filter: ValidatedPlanListFilter,
    binding: PlanListCursorBinding,
    operation: string,
  ): PlanListRequest {
    return {
      afterId:
        filter.cursor === undefined
          ? null
          : decodePlanListCursor(filter.cursor, binding, operation).lastId,
      limit: filter.limit,
    };
  }

  return {
    async listProjects(principal: unknown, filter?: unknown): Promise<ProjectListResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_LIST_OPERATION;
      try {
        // 能力核验先于筛选校验与任何读取；可见谓词随端口下推 SQL。
        const visibility = authorizeProjectsList(principal, operation);
        const valid = validateProjectListFilter(filter, operation);
        const page = projectReads.listVisibleProjects(visibility, filter);
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'project-list',
          records: page.records.map(toPublicProjectRecord),
          nextCursor: page.nextCursor,
          limit: valid.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async countProjectLabels(principal: unknown): Promise<ProjectLabelCountsResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_LABEL_COUNTS_OPERATION;
      try {
        const visibility = authorizeProjectLabelCounts(principal, operation);
        return { labels: [...projectReads.countVisibleProjectLabels(visibility)] };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getProject(principal: unknown, projectId: unknown): Promise<ProjectDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_GET_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectRead(principal, id, operation);
        let project;
        try {
          project = await stateStore.getProject(id);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
        let binding = null;
        try {
          binding = await stateStore.getRepositoryBinding(id);
        } catch (error) {
          // 项目存在但尚无绑定 → binding:null；项目缺失已在上面折算 forbidden。
          if (isStorageError(error, 'not_found') && error.entity?.type === 'repository_binding') {
            binding = null;
          } else {
            throw error;
          }
        }
        return {
          project: toPublicProjectRecord(project),
          binding: binding === null ? null : toPublicRepositoryBindingRecord(binding),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getRepositoryBinding(principal: unknown, projectId: unknown): Promise<ProjectBindingResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_BINDING_GET_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectRead(principal, id, operation);
        let binding;
        try {
          binding = await stateStore.getRepositoryBinding(id);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
        return { binding: toPublicRepositoryBindingRecord(binding) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getGlobalSettings(principal: unknown): Promise<PublicSettingsState> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_GLOBAL_GET_OPERATION;
      try {
        authorizeGlobalSettingsRead(principal, operation);
        const record = await configurationService.getCurrentSettings({ kind: 'global' });
        return toPublicSettingsState({ kind: 'global' }, record);
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getProjectSettings(principal: unknown, projectId: unknown): Promise<PublicSettingsState> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_PROJECT_GET_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectSettingsRead(principal, id, operation);
        const scope: SettingsScope = { kind: 'project', projectId: id };
        const record = await configurationService.getCurrentSettings(scope);
        return toPublicSettingsState(scope, record);
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getEffectiveSettings(principal: unknown, projectId: unknown): Promise<EffectiveSettings> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_PROJECT_EFFECTIVE_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectSettingsRead(principal, id, operation);
        try {
          return await configurationService.getEffectiveSettings(id);
        } catch (error) {
          // 项目缺失折算为与不可见相同的 forbidden；配置损坏等其余错误原样传播。
          mapProjectLookupError(error, operation);
        }
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async exportGlobalSettings(principal: unknown): Promise<ExportedSettings> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_GLOBAL_EXPORT_OPERATION;
      try {
        authorizeGlobalSettingsRead(principal, operation);
        return await configurationService.exportSettings();
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async exportProjectSettings(principal: unknown, projectId: unknown): Promise<ExportedSettings> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_PROJECT_EXPORT_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectSettingsRead(principal, id, operation);
        try {
          return await configurationService.exportSettings(id);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getSnapshot(principal: unknown, scopeInput: unknown): Promise<SnapshotResult> {
      assertTrustedPrincipal(principal);
      const operation = SNAPSHOT_GET_OPERATION;
      try {
        const scope = validateEventScope(scopeInput, operation);
        authorizeSnapshot(principal, scope, operation);
        const binding = cursorBinding(scope, operation);
        const readAt = new Date(nowUtcMs()).toISOString();
        if (scope.kind === 'global') {
          const view = snapshots.readGlobalSnapshotView();
          const watermark = createEventWatermark(
            normalizeMaxEventSequence(view.maxEventSequence, operation),
            binding,
          );
          return {
            schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
            scope,
            settings:
              view.globalSettings === null
                ? null
                : toPublicSettingsState({ kind: 'global' }, view.globalSettings),
            watermark,
            readAt,
          };
        }
        let view;
        try {
          view = snapshots.readProjectSnapshotView(scope.projectId);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
        if (view.project === null) {
          // 端口契约：项目缺失必须抛 not_found 而不是返回空视图（实现缺陷）。
          throw new TypeError('项目快照视图缺失项目行（适配器实现缺陷）');
        }
        const watermark = createEventWatermark(
          normalizeMaxEventSequence(view.maxEventSequence, operation),
          binding,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope,
          project: toPublicProjectRecord(view.project),
          binding:
            view.binding === null ? null : toPublicRepositoryBindingRecord(view.binding),
          settings:
            view.projectSettings === null
              ? null
              : toPublicSettingsState(scope, view.projectSettings),
          // 有效配置与内容/水位同一读视图：全局来源 revision 随视图记录进入合并。
          effective: mergeEffectiveSettings({
            global:
              view.globalSettings === null
                ? null
                : {
                    scopeRevision: view.globalSettings.revision,
                    payload: view.globalSettings.payload,
                  },
            project:
              view.projectSettings === null
                ? null
                : {
                    scopeRevision: view.projectSettings.revision,
                    payload: view.projectSettings.payload,
                  },
          }),
          watermark,
          readAt,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listEvents(principal: unknown, input: unknown): Promise<StateEventPage> {
      assertTrustedPrincipal(principal);
      const operation = EVENTS_SUBSCRIBE_OPERATION_NAME;
      try {
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['scope', 'cursor', 'limit'], { operation }, 'input');
        const scope = validateEventScope(object.scope, operation);
        const binding = cursorBinding(scope, operation);
        if (object.cursor === undefined) {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'cursor', reason: 'cursor_required' },
          });
        }
        const cursor = decodeEventCursor(object.cursor, binding, operation);
        const limit = validateEventPageLimit(object.limit, operation);
        // 授权在任何读取之前：events.read + 范围读能力 + 项目可见性。
        authorizeEventSubscription(principal, scope, operation);
        const rows = eventReads.listPersistedEvents({
          scope,
          afterSequence: cursor.sequence,
          limit,
        });
        // 行级可见过滤器复核（F-005）：SQL 谓词已下推，此处为防御纵深——
        // 结果与谓词不一致是适配器编程错误，绝不静默跳过/透传。
        const visibilityFilter = createEventVisibilityFilter(scope);
        for (const row of rows) {
          if (!visibilityFilter(row)) {
            throw new TypeError('事件读取结果越出授权范围（适配器实现缺陷）');
          }
        }
        const events = mapStateEvents(rows, operation);
        const last = events[events.length - 1];
        return {
          scope,
          events,
          nextCursor:
            events.length === limit && last !== undefined
              ? encodeEventCursor(last.sequence, binding)
              : null,
          limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async resolveEventResume(principal: unknown, input: unknown): Promise<EventResumePosition> {
      assertTrustedPrincipal(principal);
      const operation = EVENTS_SUBSCRIBE_OPERATION_NAME;
      try {
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['scope', 'cursor', 'lastEventId'], { operation }, 'input');
        const scope = validateEventScope(object.scope, operation);
        // 授权在任何读取之前：events.read + 范围读能力 + 项目可见性。
        authorizeEventSubscription(principal, scope, operation);
        const binding = cursorBinding(scope, operation);
        let afterSequence: number;
        if (object.lastEventId !== undefined) {
          // §9.4 优先级：Last-Event-ID（eventId）先于 ?cursor=；同一授权 scope
          // 内解析，未命中不区分「不存在」与「跨 scope」（防存在性探测）。
          if (typeof object.lastEventId !== 'string' || !isUuidV4(object.lastEventId)) {
            throw new PublicError('invalid_input', operation, undefined, {
              details: { field: 'lastEventId', reason: 'invalid_event_id' },
            });
          }
          const sequence = eventReads.findPersistedEventSequence({
            scope,
            eventId: object.lastEventId,
          });
          if (sequence === undefined) {
            throw new PublicError('invalid_input', operation, undefined, {
              details: { field: 'lastEventId', reason: 'unknown_event_id' },
            });
          }
          afterSequence = sequence;
        } else if (object.cursor !== undefined) {
          afterSequence = decodeEventCursor(object.cursor, binding, operation).sequence;
        } else {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'cursor', reason: 'cursor_required' },
          });
        }
        return {
          scope,
          afterSequence,
          resumeCursor: encodeEventCursor(afterSequence, binding),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async readEventBatch(principal: unknown, input: unknown): Promise<StateEventBatch> {
      assertTrustedPrincipal(principal);
      const operation = EVENTS_SUBSCRIBE_OPERATION_NAME;
      try {
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['scope', 'afterSequence', 'limit'], { operation }, 'input');
        const scope = validateEventScope(object.scope, operation);
        const afterSequence = object.afterSequence;
        if (
          typeof afterSequence !== 'number' ||
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0
        ) {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'afterSequence', reason: '必须是 0..2^53-1 的安全整数' },
          });
        }
        const limit = validateEventPageLimit(object.limit, operation);
        // 每次轮询重新核验当前授权：能力/可见性撤销即拒绝，不凭建连时快照。
        authorizeEventSubscription(principal, scope, operation);
        const rows = eventReads.listPersistedEvents({ scope, afterSequence, limit });
        // 行级可见过滤器复核（与 listEvents 同一防御纵深）。
        const visibilityFilter = createEventVisibilityFilter(scope);
        for (const row of rows) {
          if (!visibilityFilter(row)) {
            throw new TypeError('事件读取结果越出授权范围（适配器实现缺陷）');
          }
        }
        const events = mapStateEvents(rows, operation);
        const last = events[events.length - 1];
        return {
          scope,
          events,
          lastSequence: last === undefined ? afterSequence : last.sequence,
          limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getPhase(principal: unknown, phaseId: unknown): Promise<PhaseDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = PHASES_GET_OPERATION;
      try {
        const id = validateStableId(phaseId, { operation, entity: { type: 'phase' } }, 'phaseId');
        // 能力核验先于数据库读取；不可见与不存在统一 not_found（不区分存在性）。
        requireCapability(principal, 'project.read', operation);
        const record = planReads.readPhaseRecord(id);
        if (record === undefined || !isProjectVisible(principal, record.projectId)) {
          planEntityNotFound(operation, 'phase');
        }
        return { phase: toPublicPhaseRecord(record) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getFeature(principal: unknown, featureId: unknown): Promise<FeatureDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = FEATURES_GET_OPERATION;
      try {
        const id = validateStableId(featureId, { operation, entity: { type: 'feature' } }, 'featureId');
        requireCapability(principal, 'project.read', operation);
        const view = planReads.readFeaturePlanView(id);
        if (view === undefined || !isProjectVisible(principal, view.feature.projectId)) {
          planEntityNotFound(operation, 'feature');
        }
        // 防御纵深：一致读视图内 Task/边必须属于同一 Feature；混合状态是适配器
        // 实现缺陷（TypeError），绝不静默返回半新半旧的计划。
        const taskIds = new Set<string>();
        for (const task of view.tasks) {
          if (
            task.featureId !== id ||
            task.projectId !== view.feature.projectId ||
            taskIds.has(task.id)
          ) {
            throw new TypeError('Feature 计划视图内 Task 归属不一致（适配器实现缺陷）');
          }
          taskIds.add(task.id);
        }
        for (const edge of view.dependencies) {
          if (
            edge.featureId !== id ||
            edge.projectId !== view.feature.projectId ||
            !taskIds.has(edge.taskId) ||
            !taskIds.has(edge.dependsOnId)
          ) {
            throw new TypeError('Feature 计划视图内依赖边归属不一致（适配器实现缺陷）');
          }
        }
        const validation: FeaturePlanValidationSummary = {
          taskCount: view.tasks.length,
          dependencyEdgeCount: view.dependencies.length,
          // F-001 §3.1 同源结构前提（taskCount>0）；不代表已批准或已执行。
          executable: view.tasks.length > 0,
        };
        return {
          feature: toPublicFeatureRecord(view.feature),
          validation,
          notExecutableReasons: deriveFeatureNotExecutableReasons({
            taskCount: view.tasks.length,
            planStatus: view.feature.planStatus,
          }),
          tasks: view.tasks.map(toPublicTaskRecord),
          dependencies: view.dependencies.map(toPublicTaskDependencyEdge),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getFeatureApprovals(principal: unknown, featureId: unknown): Promise<FeatureApprovalsResult> {
      assertTrustedPrincipal(principal);
      const operation = PLAN_APPROVAL_QUERY_OPERATION;
      try {
        const id = validateStableId(featureId, { operation, entity: { type: 'feature' } }, 'featureId');
        requireCapability(principal, 'project.read', operation);
        const view = planReads.readFeatureApprovalsView(id);
        if (view === undefined || !isProjectVisible(principal, view.feature.projectId)) {
          planEntityNotFound(operation, 'feature');
        }
        // 当前决定 = 绑定当前 planDigest 的记录（同主体同摘要至多一条，DDL
        // 唯一索引保证）；摘要变更后旧决策自然成为历史。planStatus 是权威审批
        // 状态（拒绝后绝非 approved），不把拒绝显示为已批准。
        const currentDigest = view.feature.planDigest;
        const decisions = view.approvals.map((record) => ({
          ...toPublicPlanApprovalRecord(record),
          current: record.subjectDigest === currentDigest,
        }));
        return {
          feature: toPublicFeatureRecord(view.feature),
          currentDecision: decisions.find((decision) => decision.current) ?? null,
          decisions,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getTask(principal: unknown, taskId: unknown): Promise<TaskDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = TASKS_GET_OPERATION;
      try {
        const id = validateStableId(taskId, { operation, entity: { type: 'task' } }, 'taskId');
        requireCapability(principal, 'project.read', operation);
        const record = planReads.readTaskRecord(id);
        if (record === undefined || !isProjectVisible(principal, record.projectId)) {
          planEntityNotFound(operation, 'task');
        }
        return { task: toPublicTaskRecord(record) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listPhases(principal: unknown, input: unknown): Promise<PhaseListResult> {
      assertTrustedPrincipal(principal);
      const operation = PHASES_LIST_OPERATION;
      try {
        // 能力与可见性先于分页/计数：受限主体对不可见项目 forbidden（与不存在
        // 项目同一错误）；全量范围下未知项目自然空页，不泄漏存在性。
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'phases', projectId }, operation);
        const page = planReads.listPhaseRecords(
          principalProjectVisibility(principal),
          projectId,
          planListRequest(filter, binding, operation),
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'phase-list',
          records: page.records.map(toPublicPhaseRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listFeatures(principal: unknown, input: unknown): Promise<FeatureListResult> {
      assertTrustedPrincipal(principal);
      const operation = FEATURES_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'phaseId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const phaseId = validateStableId(
          object.phaseId,
          { operation, entity: { type: 'phase' } },
          'phaseId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'features', projectId, phaseId }, operation);
        const page = planReads.listFeatureRecords(
          principalProjectVisibility(principal),
          projectId,
          phaseId,
          planListRequest(filter, binding, operation),
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'feature-list',
          records: page.records.map(toPublicFeatureRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listTasks(principal: unknown, input: unknown): Promise<TaskListResult> {
      assertTrustedPrincipal(principal);
      const operation = TASKS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'featureId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const featureId = validateStableId(
          object.featureId,
          { operation, entity: { type: 'feature' } },
          'featureId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'tasks', projectId, featureId }, operation);
        const page = planReads.listTaskRecords(
          principalProjectVisibility(principal),
          projectId,
          featureId,
          planListRequest(filter, binding, operation),
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'task-list',
          records: page.records.map(toPublicTaskRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
