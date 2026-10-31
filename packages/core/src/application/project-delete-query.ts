/**
 * P07-3 / F-015：项目删除操作只读查询服务（application 层）。
 *
 * 设计依据：core-design/08 §2/§4/§5.1；ports/project-delete-query.ts。
 *
 * 行为：
 * - operationId 未知输入先做形态校验（UUID v4，与删除存储生成的身份同源），
 *   非法形态按 invalid_input 拒绝（不进入存储读取）；
 * - 读取复用 F-010/F-011 删除存储的受控 get：能力位（project.lifecycle.write）
 *   + 项目可见性 + 仅原始提交主体可读（其余统一 forbidden，与不存在不可区分）；
 * - 存储抛出的 PublicError 重新绑定到查询操作身份（project.delete.operation.get），
 *   错误码/原因保持不变；结果是最小事实投影，不回放 manifest 正文。
 */
import { PublicError, isUuidV4 } from '../ports/commands.js';
import { PROJECT_DELETE_OPERATION_GET_OPERATION, type ProjectDeleteOperationQueryResult, type ProjectDeleteQueryService } from '../ports/project-delete-query.js';
import type { ProjectDeleteStore } from '../ports/project-delete.js';

export function createProjectDeleteQueryService(options: {
  readonly store: Pick<ProjectDeleteStore, 'get'>;
}): ProjectDeleteQueryService {
  const remap = (error: unknown): unknown => (error instanceof PublicError
    ? new PublicError(error.code, PROJECT_DELETE_OPERATION_GET_OPERATION, error.message, {
      ...(error.details === undefined ? {} : { details: error.details }),
    })
    : error);

  return {
    async get(principal, operationId) {
      try {
        if (typeof operationId !== 'string' || !isUuidV4(operationId)) {
          throw new PublicError('invalid_input', PROJECT_DELETE_OPERATION_GET_OPERATION, 'operationId 必须是删除操作身份（UUID v4）', {
            details: { field: 'operationId' },
          });
        }
        const operation = options.store.get(principal as never, operationId);
        return {
          operation: PROJECT_DELETE_OPERATION_GET_OPERATION,
          schemaVersion: 1,
          operationId: operation.operationId,
          projectId: operation.projectId,
          status: operation.status,
          failedStep: operation.failedStep,
          steps: operation.steps.map(step => ({ step: step.step, status: step.status })),
          fence: operation.fence,
        } satisfies ProjectDeleteOperationQueryResult;
      } catch (error) {
        throw remap(error);
      }
    },
  };
}
