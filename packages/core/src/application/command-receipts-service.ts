/**
 * F-006 CommandReceiptsService（application 层）：授权回执读取与结果引用解析
 * （docs/p02-2-commands-events-contract.md §4.3/§5.6）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（CommandReceiptStore）与 F-005 纯授权判定，不接触
 *   适配器、驱动、HTTP 或 Pi SDK；import 本模块无副作用；
 * - 授权失败在任何读取之前/之后都统一折算：无 receipts.read 能力 → forbidden；
 *   他人回执、不可见项目目标、未知 commandId/resultRef 一律 not_found
 *   （reason='receipt_not_found'），不区分不存在与无权；
 * - 能力核验先于数据库读取：无能力主体连存在性探测都得不到区分响应；
 * - 命令重放/历史读取重新核验当前身份与权限（F-005 authorize*），已有
 *   commandId/resultRef 不绕过授权；注册回执核验新建项目当前可见性
 *   （registrationProjectId 自回执固化结果提取，形状不符即 corrupt_state，
 *   不跳过可见性核验）；
 * - 返回的 result 是提交时固化的值：项目/配置后续修改不改变该次结果；
 * - resultRef 只作不透明引用解析：非法形态在字段级 invalid_input 拒绝，
 *   绝不当作文件路径或数据库定位符处理。
 */
import {
  assertTrustedPrincipal,
  authorizeReceiptRead,
  authorizeReceiptScopeVisibility,
  authorizeResultResolution,
  requireCapability,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import {
  PublicError,
  isUuidV4,
  validateResultRef,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import type { CommandReceiptStore } from '../ports/command-receipts.js';
import { isPlainObject } from '../ports/validation.js';

/** receipts.get / results.resolve 的公开操作身份（与 §3.2 查询清单一致）。 */
const RECEIPTS_GET_OPERATION = 'receipts.get';
const RESULTS_RESOLVE_OPERATION = 'results.resolve';

export interface CommandReceiptsServiceOptions {
  /** 持久回执窄端口（F-006）。 */
  readonly receiptStore: CommandReceiptStore;
}

export interface CommandReceiptsService {
  /**
   * receipts.get：授权后按本 principal 的 (principalId, commandId) 读取持久回执；
   * 不存在/无权/目标不可见 → not_found；非法 commandId → invalid_input。
   */
  getReceipt(principal: unknown, commandId: unknown): Promise<CommandReceipt>;
  /**
   * results.resolve：授权后按不透明 resultRef 解析原命令的固化结果（回执内嵌
   * result）；伪造/未知/无权引用 → not_found；非法形态 → invalid_input。
   */
  resolveResult(principal: unknown, resultRef: unknown): Promise<CommandReceipt>;
}

function receiptNotFound(operation: string): never {
  throw new PublicError('not_found', operation, undefined, {
    details: { reason: 'receipt_not_found' },
  });
}

/**
 * 注册回执的新建项目身份提取（§5.6：注册回执核验新建项目当前可见性）。
 * registration + completed 回执的结果按 §6 冻结形状携带 project.id；形状不符
 * 说明持久内容与写入侧契约不一致（corrupt_state），绝不跳过可见性核验。
 * rejected 注册回执没有项目实体（返回 null，仅归属核验）。
 */
function registrationProjectIdOf(receipt: CommandReceipt, operation: string): string | null {
  if (receipt.scope.kind !== 'registration' || receipt.status !== 'completed') {
    return null;
  }
  const result = receipt.result;
  if (isPlainObject(result) && isPlainObject(result.project)) {
    const projectId = result.project.id;
    if (typeof projectId === 'string' && isUuidV4(projectId)) {
      return projectId;
    }
  }
  throw new PublicError('corrupt_state', operation, undefined, {
    details: { reason: 'corrupt_receipt_result' },
  });
}

/**
 * 装配授权回执/结果读取服务。principal 由可信装配显式传入（生产固定
 * local-owner；受限主体仅测试装配），本服务绝不从请求数据取身份。
 */
export function createCommandReceiptsService(
  options: CommandReceiptsServiceOptions,
): CommandReceiptsService {
  const store = options.receiptStore;
  return {
    async getReceipt(principal: unknown, commandId: unknown): Promise<CommandReceipt> {
      const operation = RECEIPTS_GET_OPERATION;
      assertTrustedPrincipal(principal);
      const trusted: TrustedPrincipal = principal;
      // 能力核验先于数据库读取：无能力主体得不到存在性区分响应。
      requireCapability(trusted, 'receipts.read', operation);
      if (!isUuidV4(commandId)) {
        throw new PublicError('invalid_input', operation, undefined, {
          details: { field: 'commandId', reason: '必须是 RFC 4122 UUID v4（小写）' },
        });
      }
      // 按调用方自身 principalId 查询：跨身份读取结构性 miss（不区分不存在与无权）。
      const receipt = await store.findReceiptByCommandId(trusted.principalId, commandId);
      if (receipt === undefined) {
        receiptNotFound(operation);
      }
      authorizeReceiptRead(trusted, receipt.principalId, operation);
      authorizeReceiptScopeVisibility(
        trusted,
        receipt.scope,
        registrationProjectIdOf(receipt, operation),
        operation,
      );
      return receipt;
    },

    async resolveResult(principal: unknown, resultRef: unknown): Promise<CommandReceipt> {
      const operation = RESULTS_RESOLVE_OPERATION;
      assertTrustedPrincipal(principal);
      const trusted: TrustedPrincipal = principal;
      requireCapability(trusted, 'receipts.read', operation);
      const ref = validateResultRef(resultRef, operation);
      const receipt = await store.findReceiptByResultRef(ref);
      if (receipt === undefined) {
        receiptNotFound(operation);
      }
      // 归属 + 目标实体当前可见性重核（含注册回执的新建项目可见性）。
      authorizeResultResolution(
        trusted,
        receipt,
        registrationProjectIdOf(receipt, operation),
        operation,
      );
      return receipt;
    },
  };
}
