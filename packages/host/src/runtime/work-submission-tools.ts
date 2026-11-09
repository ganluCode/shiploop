/**
 * P05-1 / F-006：规划候选受限提交的 Pi 自定义工具桥。
 *
 * 把「模型调用工具」映射为「受限 Work 工具通道命令」：工具参数只接受有界
 * 候选 JSON 正文（不含文件路径/artifactId/凭据）；execute 组装命令信封
 * （commandId/issuedAt/身份/执行版本均来自可信装配，不由模型提供）并经
 * WorkToolClient.invoke 提交；结果只回传脱敏回执摘要（状态/candidateDigest/
 * artifactId/失败原因），不回显候选正文，不携带任何凭据或路径。
 *
 * 该模块不加载 Pi SDK；结构化定义（PiSubmissionToolDefinition）在 SDK 边界
 * （pi-adapter 的 session 工厂）受控转换。可信装配负责：持有受限通道凭据
 * （Host 签发的 grant token）、按当前 planning Attempt 解析工具、在 Host/
 * Runner 侧传递 token（不经模型请求正文）。
 */
import type { CommandReceipt } from 'shiploop-core/protocol';
import { createHash } from 'node:crypto';
import {
  PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES,
  PLANNING_CANDIDATE_SUBMIT_OPERATION,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from 'shiploop-core/protocol';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';
import { getRuntimePromptTemplates } from './prompt-templates.js';

export const PLANNING_SUBMIT_TOOL_NAME = 'planning_candidate_submit';

/** 工具参数/结果正文长度上限（脱敏摘要；不含候选正文）。 */
const PLANNING_SUBMIT_TOOL_RESULT_MAX_CHARS = 4096;

export interface PlanningCandidateSubmitToolOptions {
  readonly promptTemplates?: import('shiploop-core').PromptTemplateCatalog;
  /** 受限通道调用端（如 Host 环回 WorkToolClient.invoke）；不得是通用 HostClient。 */
  readonly invoke: (input: unknown) => Promise<CommandReceipt | { operation: 'task.read' }>;
  /** 当前 planning Attempt 的绑定身份（可信装配提供；模型不可指定）。 */
  readonly identity: { readonly purpose: 'work'; readonly runId: string; readonly taskId: string; readonly attemptId: string };
  readonly projectId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  /** 候选正文字节上限（≤ Core 通道入口上限；缺省使用 Core 上限）。 */
  readonly maxBodyBytes?: number;
  /** 命令身份生成（缺省 crypto.randomUUID；测试可注入确定性来源）。 */
  readonly newCommandId?: () => string;
  readonly nowIso?: () => string;
}

interface PlanningSubmitReceiptSummary {
  readonly status: 'completed' | 'rejected';
  readonly commandId: string;
  readonly candidateDigest?: string;
  readonly artifactId?: string;
  readonly reason?: string;
  readonly replayed?: boolean;
}

function boundedText(value: string): string {
  return value.length > PLANNING_SUBMIT_TOOL_RESULT_MAX_CHARS
    ? `${value.slice(0, PLANNING_SUBMIT_TOOL_RESULT_MAX_CHARS)}…[truncated]`
    : value;
}

function receiptSummary(receipt: CommandReceipt): PlanningSubmitReceiptSummary {
  const base = { commandId: receipt.commandId, ...(receipt.replayed === true ? { replayed: true } : {}) };
  if (receipt.status === 'completed') {
    const result = receipt.result as { candidateDigest?: unknown; artifact?: { artifactId?: unknown } } | undefined;
    return {
      status: 'completed',
      ...base,
      ...(typeof result?.candidateDigest === 'string' ? { candidateDigest: result.candidateDigest } : {}),
      ...(typeof result?.artifact?.artifactId === 'string' ? { artifactId: result.artifact.artifactId } : {}),
    };
  }
  if (receipt.status === 'rejected') {
    const reason = (receipt.error.details as { reason?: unknown } | undefined)?.reason;
    return { status: 'rejected', ...base, ...(typeof reason === 'string' ? { reason } : {}) };
  }
  // Work 工具通道不产生 accepted；防御性拒绝，不回传未知形状。
  return { status: 'rejected', ...base, reason: 'unexpected_receipt_status' };
}

/**
 * 创建规划候选提交自定义工具（结构化定义；由可信装配经
 * PiTrustedAssembly.resolveSubmissionTools 按当前 planning Attempt 注入）。
 */
export function createPlanningCandidateSubmitTool(
  options: PlanningCandidateSubmitToolOptions,
): PiSubmissionToolDefinition {
  const maxBodyBytes = options.maxBodyBytes ?? PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES) {
    throw new TypeError('planning submit tool: invalid maxBodyBytes');
  }
  const newCommandId = options.newCommandId ?? (() => crypto.randomUUID());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const encoder = new TextEncoder();
  const candidateCommands = new Map<string, { commandId: string; issuedAt: string }>();
  const templates = options.promptTemplates ?? getRuntimePromptTemplates();
  return {
    name: PLANNING_SUBMIT_TOOL_NAME,
    label: '提交规划候选',
    description: templates.render('runtime/tools/planning-submit.md'),
    promptSnippet: templates.render('runtime/tools/planning-snippet.md'),
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        candidate: {
          type: 'string',
          description: templates.render('runtime/tools/planning-parameter.md'),
        },
      },
      required: ['candidate'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'rejected'] },
        commandId: { type: 'string' },
        candidateDigest: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    async execute(_toolCallId, params) {
      const candidate = (params as { candidate?: unknown }).candidate;
      if (typeof candidate !== 'string' || candidate.length === 0) {
        return { content: [{ type: 'text', text: 'candidate 正文缺失（必须是 JSON 字符串）' }], isError: true };
      }
      if (candidate.length > maxBodyBytes || encoder.encode(candidate).byteLength > maxBodyBytes) {
        return { content: [{ type: 'text', text: `candidate 正文超过 ${maxBodyBytes} 字节上限` }], isError: true };
      }
      const digest = createHash('sha256').update(candidate).digest('hex');
      if (!candidateCommands.has(digest)) {
        if (candidateCommands.size >= 64) return { content: [{ type: 'text', text: 'planning_candidate_submit: candidate limit' }], isError: true };
        candidateCommands.set(digest, { commandId: newCommandId(), issuedAt: nowIso() });
      }
      const { commandId, issuedAt } = candidateCommands.get(digest)!;
      let receipt: Awaited<ReturnType<PlanningCandidateSubmitToolOptions['invoke']>>;
      try {
        receipt = await options.invoke({
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          commandId,
          issuedAt,
          operation: PLANNING_CANDIDATE_SUBMIT_OPERATION,
          scope: { kind: 'project', projectId: options.projectId },
          payload: {
            identity: options.identity,
            invocationId: options.invocationId,
            executionVersion: options.executionVersion,
            candidate,
          },
        });
      } catch (error) {
        // 领域/通道失败以 isError 结果回给模型；只携带受控错误码，不回显
        // 错误原文/凭据/路径。同候选保留 commandId，结果未知时重放同一命令。
        const code = (error as { code?: unknown }).code;
        const safeCode = typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'submission_failed';
        const reason = (error as { details?: { reason?: unknown } }).details?.reason;
        const detail = typeof reason === 'string' && /^[a-z0-9_]{1,100}$/.test(reason) ? `:${reason}` : '';
        return { content: [{ type: 'text', text: `planning_candidate_submit failed: ${safeCode}${detail}` }], isError: true };
      }
      if (receipt.operation !== PLANNING_CANDIDATE_SUBMIT_OPERATION) {
        return { content: [{ type: 'text', text: '受限通道返回了非规划提交结果（拒绝）' }], isError: true };
      }
      const summary = receiptSummary(receipt as CommandReceipt);
      return {
        content: [{ type: 'text', text: boundedText(JSON.stringify(summary)) }],
        structuredContent: summary,
        isError: summary.status !== 'completed',
      };
    },
  };
}
