/**
 * P06-6 / F-001 默认策略重新应用预览的只读端口。
 *
 * 该端口只返回一次一致读中的事实；它没有任何写入原语，也不暴露 SQLite
 * 句柄、文件路径或执行快照正文。候选策略和预览身份由 application 层计算。
 */
import type { SettingsPayload } from './settings-schema.js';
import type { TaskRecord } from './plan-store.js';

export interface TaskStrategyReapplicationSettingsSnapshot {
  readonly revision: number;
  readonly payload: SettingsPayload;
}

export interface TaskStrategyReapplicationExecutionFacts {
  /** Task 已经拥有 Attempt 或 Run 等执行历史。 */
  readonly hasExecutionHistory: boolean;
  /** Task 所属 Feature 存在仍可能写入的活动执行输入。 */
  readonly hasActiveExecutionInputs: boolean;
  /** Task 所属 Feature 已被某个授权 Batch 固定纳入范围。 */
  readonly hasAuthorizedBatchScope: boolean;
}

export interface TaskStrategyReapplicationTaskFact {
  readonly task: TaskRecord | null;
  /** 目标 id 存在但属于另一个项目时明确保留该事实，应用层只输出受控原因。 */
  readonly ownership: 'same_project' | 'other_project' | 'missing';
  readonly execution: TaskStrategyReapplicationExecutionFacts;
}

export interface TaskStrategyReapplicationReadView {
  readonly projectExists: boolean;
  readonly globalSettings: TaskStrategyReapplicationSettingsSnapshot | null;
  readonly projectSettings: TaskStrategyReapplicationSettingsSnapshot | null;
  readonly tasks: readonly TaskStrategyReapplicationTaskFact[];
}

export interface TaskStrategyReapplicationReadStore {
  /**
   * projectId 与 taskIds 已由应用层校验；实现必须在一次一致读中取得全部事实。
   * 不存在或跨项目目标不应通过异常泄漏存在性，而应在 tasks 中给出受控事实。
   */
  readTaskStrategyReapplicationView(
    projectId: unknown,
    taskIds: readonly unknown[],
  ): TaskStrategyReapplicationReadView;
}
