/**
 * P07-3 / F-015：项目删除操作只读查询窄契约（ports 契约层，纯类型与常量）。
 *
 * 设计依据：core-design/08 §2/§4/§5.1（受控 operation 查询）与 PRD §3.1。
 *
 * 契约要点：
 * - 查询只返回**最小删除事实**（操作身份、目标项目、状态、失败步骤与各步骤
 *   状态）；不回放完整 manifest/清单（完成态本就已清空正文）；
 * - 授权复用删除存储的受控语义：仅原始提交主体可读（其他主体统一 forbidden，
 *   与「不存在」不可区分），且需 project.lifecycle.write 能力位；
 * - 删除完成后项目主体行已清除，本查询是原主体核对删除事实的受控入口；
 *   普通项目列表/详情不返回已删除项目。
 */

/** 项目删除操作查询操作身份（与 Host 路由/能力清单同源）。 */
export const PROJECT_DELETE_OPERATION_GET_OPERATION = 'project.delete.operation.get' as const;

/** 删除操作单步骤的最小状态投影。 */
export interface ProjectDeleteOperationStepView {
  readonly step: string;
  readonly status: 'pending' | 'completed' | 'failed';
}

/** 项目删除操作查询结果（最小事实投影；不含 manifest 正文）。 */
export interface ProjectDeleteOperationQueryResult {
  readonly operation: typeof PROJECT_DELETE_OPERATION_GET_OPERATION;
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly projectId: string;
  readonly status: 'intent' | 'running' | 'failed' | 'purging' | 'completed';
  readonly failedStep: string | null;
  readonly steps: readonly ProjectDeleteOperationStepView[];
  readonly fence: number;
}

export interface ProjectDeleteQueryService {
  /** operationId 为未知输入：非法形态按 invalid_input 拒绝；不可见统一 forbidden。 */
  get(principal: unknown, operationId: unknown): Promise<ProjectDeleteOperationQueryResult>;
}
