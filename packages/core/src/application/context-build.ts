/**
 * P03-2 / F-005 有版本的 ContextBuilder（application 层纯编排：预算核验、
 * 固定指导与动态输入分离、有界 prompt / inputManifest / inputSnapshot 组装
 * 与确定性摘要）。
 *
 * 设计依据：core-design/06 §4/§4.1 与 core-design/13 §2（见
 * ports/context-build.ts 文件头）。
 *
 * 不变量：
 * - 纯数据变换：不读时钟/文件/数据库、不生成随机值、不做网络与 SDK 调用；
 *   相同输入必然产生相同输出（确定性摘要可独立复算）；
 * - 分离固定指导与动态输入：CONTEXT_FIXED_GUIDANCE（Core 拥有的稳定常量）
 *   原样置于 prompt 开头，不能被任何输入字段替换；文件正文一律不进入 prompt
 *   （只列可校验受管引用：artifactId/version/hash/size/locator）；
 * - 完整 acceptance 属固定必需输入：逐条内联进 prompt 与 snapshot，manifest
 *   标为必需且选取范围完整；长度预算不足时整体结构化失败（limit_exceeded），
 *   绝不删项、绝不静默截断、绝不只留下可变路径；
 * - progress、全任务历史和旧报告默认不全量内联：历史只能经有界索引进入，
 *   保留条数/单条长度受预算约束；超预算条目按输入顺序前缀策略省略（不重排
 *   挑选）、超长摘要截断，二者都在 manifest omissions 与 snapshot
 *   historyIndex 中如实标注；历史增长只影响 omittedCount，不影响 prompt 规模；
 * - 必需预算核验顺序：引用数量 → 必需正文（快照业务投影规范化字节）→ 无历史
 *   prompt 字节；任一超限抛 ContextBuildError(limit_exceeded)（details 携带
 *   限制名、实测值与上限），不以截断必需内容换取成功；
 * - token 估算恒标注 estimation（kind='estimation' + method），不冒充精确用量；
 * - 确定性摘要：复用 feature-plan 的 stableStringify 规范化（键递归排序、
 *   数组保序、undefined 省略），不另立第二套规范化；labels 等非业务元数据
 *   只入 snapshot.meta，不参与任何摘要（有效验收身份不受标签影响）；
 * - 不读取 modelMap 重新路由：executionConfig 按副本原样进入 snapshot 与
 *   prompt（canonical 相等），装配依赖只有预算，不存在任何配置/路由入口；
 * - 失败脱敏：ContextBuildError 消息与 details 只含字段位置、限制名、实测
 *   字节数与计数，不回显正文内容。
 *
 * 本模块不实现：snapshot/manifest/prompt 制品组发布与批准最终重核（F-006）、
 * Host/CLI 接线（F-007/F-008）、ProjectProfile、检索、LLM 蒸馏、SDK 自动
 * 资源加载或原生会话续接。
 */
import { createHash } from 'node:crypto';
import {
  CONTEXT_FIXED_GUIDANCE,
  CONTEXT_INPUT_SCHEMA_VERSION,
  CONTEXT_MANIFEST_DIGEST_DOMAIN,
  CONTEXT_PROMPT_DIGEST_DOMAIN,
  CONTEXT_REWORK_GUIDANCE,
  CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
  ContextBuildError,
  validateContextBuildInput,
} from '../ports/context-build.js';
import type {
  ContextBuildInput,
  ContextBuildResult,
  ContextDigests,
  ContextHistoryEntry,
  ContextInputManifest,
  ContextInputSnapshot,
  ContextManifestSource,
  ContextOmission,
  ContextSelectedHistoryIndex,
  ContextTokenEstimate,
} from '../ports/context-build.js';
import { stableStringify } from '../ports/feature-plan.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/**
 * 上下文预算：全部显式有限。maxPromptBytes 同时约束最终 prompt（必需内容 +
 * 可选历史索引）；必需内容超限整体失败，可选历史按前缀策略省略/截断。
 */
export interface ContextBudget {
  /** 最终 prompt 最大 UTF-8 字节数（≥1）。 */
  readonly maxPromptBytes: number;
  /** 必需正文（snapshot 业务投影，不含 labels/历史）最大规范化字节数（≥1）。 */
  readonly maxRequiredSnapshotBytes: number;
  /** 必需输入引用最大条数（≥1；0 条引用合法）。 */
  readonly maxRequiredInputRefs: number;
  /** 历史索引最多保留条数（≥1）。 */
  readonly maxHistoryEntries: number;
  /** 历史索引单条摘要最大保留长度（Unicode 码点，≥1；超出截断并标注）。 */
  readonly maxHistoryEntryChars: number;
  /** token 估算的每 token 字节数（≥1；估算仅标注 estimation）。 */
  readonly bytesPerTokenEstimate: number;
}

export interface ContextBuilderDeps {
  readonly budget: ContextBudget;
}

/** ContextBuilder 窄用例：纯函数形态（同步、无 I/O）。 */
export interface ContextBuilder {
  /** 构建输入快照 / manifest / prompt 与确定性摘要；失败抛 ContextBuildError。 */
  build(input: unknown): ContextBuildResult;
}

const CONTEXT_BUILDER_OPERATION = 'ContextBuilder';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestOf(domain: string, canonical: string): string {
  return sha256Hex(`${domain}\n${canonical}`);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) {
    count += 1;
  }
  return count;
}

function truncateToCodePoints(value: string, maxCodePoints: number): string {
  if (codePointLength(value) <= maxCodePoints) {
    return value;
  }
  let result = '';
  let count = 0;
  for (const char of value) {
    if (count >= maxCodePoints) {
      break;
    }
    result += char;
    count += 1;
  }
  return result;
}

function limitError(
  field: string,
  reason: string,
  details: Readonly<Record<string, unknown>>,
): ContextBuildError {
  return new ContextBuildError('limit_exceeded', `${CONTEXT_BUILDER_OPERATION}: 预算超限（${field}）${reason}`, {
    field,
    details,
  });
}

function validateBudget(value: unknown): ContextBudget {
  const context: ValidationContext = { operation: `${CONTEXT_BUILDER_OPERATION}.create` };
  const object = requirePlainObject(value, context, 'budget');
  rejectUnknownKeys(
    object,
    [
      'maxPromptBytes',
      'maxRequiredSnapshotBytes',
      'maxRequiredInputRefs',
      'maxHistoryEntries',
      'maxHistoryEntryChars',
      'bytesPerTokenEstimate',
    ],
    context,
    'budget',
  );
  return {
    maxPromptBytes: validatePositiveInteger(object.maxPromptBytes, context, 'budget.maxPromptBytes'),
    maxRequiredSnapshotBytes: validatePositiveInteger(
      object.maxRequiredSnapshotBytes,
      context,
      'budget.maxRequiredSnapshotBytes',
    ),
    maxRequiredInputRefs: validatePositiveInteger(
      object.maxRequiredInputRefs,
      context,
      'budget.maxRequiredInputRefs',
    ),
    maxHistoryEntries: validatePositiveInteger(object.maxHistoryEntries, context, 'budget.maxHistoryEntries'),
    maxHistoryEntryChars: validatePositiveInteger(
      object.maxHistoryEntryChars,
      context,
      'budget.maxHistoryEntryChars',
    ),
    bytesPerTokenEstimate: validatePositiveInteger(
      object.bytesPerTokenEstimate,
      context,
      'budget.bytesPerTokenEstimate',
    ),
  };
}

/** 历史条目渲染（单行；换行归一为空格，保证索引条目不破坏段落结构）。 */
function singleLine(text: string): string {
  return text.replaceAll(/\r?\n/g, ' ');
}

function renderOrigin(origin: ContextBuildInput['requiredInputs'][number]['origin']): string {
  return origin.kind === 'artifact'
    ? 'origin artifact'
    : `origin file root ${origin.root} path ${origin.relativePath}`;
}

/**
 * 装配有版本的 ContextBuilder。只校验装配依赖与预算形态（fail-closed，未知
 * 键拒绝——不存在替换固定指导或注入配置的入口），不执行任何 I/O；
 * import 本模块无副作用。
 */
export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const context: ValidationContext = { operation: `${CONTEXT_BUILDER_OPERATION}.create` };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 budget 装配依赖');
  }
  const depsRecord = deps as unknown as Record<string, unknown>;
  rejectUnknownKeys(depsRecord, ['budget'], context, 'deps');
  const budget = validateBudget(depsRecord.budget);
  const fixedGuidanceHash = digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, CONTEXT_FIXED_GUIDANCE);

  return { build };

  function build(input: unknown): ContextBuildResult {
    const validated = validateContextBuildInput(input);

    /* 1) 必需输入引用数量预算（fail-fast，不静默丢弃引用）。 */
    if (validated.requiredInputs.length > budget.maxRequiredInputRefs) {
      throw limitError('budget.maxRequiredInputRefs', '必需输入引用数量超限', {
        limitName: 'maxRequiredInputRefs',
        measured: validated.requiredInputs.length,
        limit: budget.maxRequiredInputRefs,
      });
    }

    /* 2) 可选历史索引：先做确定性条数/长度截断（前缀策略，保持输入顺序）。 */
    const historyInput = validated.historyIndex ?? undefined;
    const omissions: ContextOmission[] = [];
    const totalAvailable = historyInput?.totalAvailable ?? historyInput?.entries.length ?? 0;
    const cappedEntries: ContextHistoryEntry[] = [];
    const truncatedEntryIds: string[] = [];
    if (historyInput !== undefined && historyInput.entries.length > 0) {
      const kept = historyInput.entries.slice(0, budget.maxHistoryEntries);
      for (const entry of kept) {
        if (codePointLength(entry.summary) > budget.maxHistoryEntryChars) {
          cappedEntries.push({
            id: entry.id,
            summary: truncateToCodePoints(entry.summary, budget.maxHistoryEntryChars),
          });
          truncatedEntryIds.push(entry.id);
        } else {
          cappedEntries.push(entry);
        }
      }
      if (truncatedEntryIds.length > 0) {
        omissions.push({
          sourceId: 'history-index',
          kind: 'history-entry-truncated',
          note: `${truncatedEntryIds.length} 条摘要超过 ${budget.maxHistoryEntryChars} 码点被截断（ids: ${truncatedEntryIds.join(', ')}）`,
        });
      }
      const cappedByCount = historyInput.entries.length - kept.length;
      if (cappedByCount > 0) {
        omissions.push({
          sourceId: 'history-index',
          kind: 'history-entry-omitted',
          note: `条数预算 maxHistoryEntries=${budget.maxHistoryEntries} 省略 ${cappedByCount} 条`,
        });
      }
    }

    const rework = validated.rework ?? null;

    /* 3) 必需正文预算：snapshot 业务投影（不含 labels 与历史索引）规范化字节。
          返工身份/证据引用属必需内容，同一预算约束（超限整体失败，不截断）。 */
    const requiredSnapshot = {
      schemaVersion: CONTEXT_INPUT_SCHEMA_VERSION,
      projectId: validated.projectId,
      featureId: validated.featureId,
      taskId: validated.taskId,
      task: {
        title: validated.task.title,
        description: validated.task.description,
        acceptance: validated.task.acceptance,
        requirementsRefs: validated.task.requirementsRefs,
        dependencies: validated.task.dependencies,
        executionConfig: validated.task.executionConfig,
        configSource: validated.task.configSource,
        configSourceKey: validated.task.configSourceKey,
      },
      checkPolicy: validated.checkPolicy,
      permissions: validated.permissions,
      requiredInputs: validated.requiredInputs,
      ...(rework === null ? {} : { rework }),
    };
    const requiredBytes = utf8Bytes(stableStringify(requiredSnapshot));
    if (requiredBytes > budget.maxRequiredSnapshotBytes) {
      throw limitError('budget.maxRequiredSnapshotBytes', '必需正文规范化字节数超限', {
        limitName: 'maxRequiredSnapshotBytes',
        measuredBytes: requiredBytes,
        limitBytes: budget.maxRequiredSnapshotBytes,
      });
    }

    /* 4) prompt 骨架（固定指导 + 全部必需内容；不含历史）。 */
    const basePrompt = renderRequiredPrompt(validated);
    const baseBytes = utf8Bytes(basePrompt);
    if (baseBytes > budget.maxPromptBytes) {
      throw limitError('budget.maxPromptBytes', '必需内容 prompt 字节数超限（不删减验收条目）', {
        limitName: 'maxPromptBytes',
        measuredBytes: baseBytes,
        limitBytes: budget.maxPromptBytes,
      });
    }

    /* 5) 历史索引按 prompt 剩余预算贪心保留（前缀策略；不重排挑选）。 */
    let prompt = basePrompt;
    let selectedEntries: ContextHistoryEntry[] = [];
    let omittedByPrompt = 0;
    if (cappedEntries.length > 0) {
      const lines: string[] = ['## History index (optional; bounded; not required)'];
      const headerBytes = utf8Bytes(`${prompt}${lines[0]}\n`);
      if (headerBytes <= budget.maxPromptBytes) {
        prompt = `${prompt}${lines[0]}\n`;
        for (const entry of cappedEntries) {
          const line = `- ${entry.id}: ${singleLine(entry.summary)}\n`;
          if (utf8Bytes(prompt + line) <= budget.maxPromptBytes) {
            prompt += line;
            selectedEntries.push(entry);
          } else {
            omittedByPrompt = cappedEntries.length - selectedEntries.length;
            break;
          }
        }
        const omittedCount =
          totalAvailable - selectedEntries.length > 0 ? totalAvailable - selectedEntries.length : 0;
        const footer = `- (index bounded: ${selectedEntries.length} kept of ${totalAvailable} available)\n`;
        if (utf8Bytes(prompt + footer) <= budget.maxPromptBytes) {
          prompt += footer;
        }
        if (omittedByPrompt > 0) {
          omissions.push({
            sourceId: 'history-index',
            kind: 'history-entry-omitted',
            note: `prompt 字节预算 maxPromptBytes=${budget.maxPromptBytes} 省略 ${omittedByPrompt} 条（前缀策略，不重排挑选）`,
          });
        }
        const historyIndex: ContextSelectedHistoryIndex = {
          entries: selectedEntries,
          totalAvailable,
          omittedCount,
          truncated: truncatedEntryIds.length > 0,
        };
        return finalize(validated, historyIndex, omissions, prompt);
      }
      omissions.push({
        sourceId: 'history-index',
        kind: 'history-entry-omitted',
        note: `prompt 字节预算 maxPromptBytes=${budget.maxPromptBytes} 无剩余空间，历史索引整体省略`,
      });
    }
    return finalize(validated, null, omissions, prompt);
  }

  /** 必需 prompt 骨架：固定指导原样开头 + 结构化必需内容（完整 acceptance 逐条）。 */
  function renderRequiredPrompt(validated: ContextBuildInput): string {
    const parts: string[] = [];
    parts.push(`ShipLoop task context (schemaVersion ${CONTEXT_INPUT_SCHEMA_VERSION})`);
    parts.push('');
    parts.push(CONTEXT_FIXED_GUIDANCE);
    parts.push('');
    const rework = validated.rework ?? null;
    if (rework !== null) {
      parts.push(CONTEXT_REWORK_GUIDANCE);
      parts.push('');
      parts.push('## Rework handoff (incremental fix; same worktree; verified scene)');
      parts.push(`- attemptId: ${rework.attemptId}`);
      parts.push(
        `- previousAttemptId: ${rework.previousAttemptId} (direct previous attempt, same task ${rework.previousTaskId})`,
      );
      parts.push(`- worktreeId: ${rework.scene.worktreeId}`);
      parts.push(`- headCommit: ${rework.scene.headCommit}`);
      parts.push(`- codeDigest: sha256:${rework.scene.codeDigest}`);
      parts.push('');
      parts.push('## Failure evidence (required; read each via reference and verify hash; bodies not inlined)');
      for (const ref of rework.failureEvidenceRefs) {
        parts.push(
          `- ${ref.purpose}: artifact ${ref.artifactId} v${ref.version} sha256:${ref.contentHash} size ${ref.sizeBytes}B media ${ref.mediaType} locator ${ref.locator} ${renderOrigin(ref.origin)}`,
        );
      }
      parts.push('');
      parts.push('## Recovery record (source & mode record only; no native continuation implemented)');
      const selection = rework.recovery.selection;
      parts.push(
        `- selection: mode ${selection.mode}${selection.mode === 'new' ? '' : ` kind ${selection.kind}`}`,
      );
      const decision = rework.recovery.decision;
      parts.push(
        `- decision: mode ${decision.mode}${decision.mode === 'resume' ? ` kind ${decision.kind}` : ''} reasons: ${
          decision.reasons.length === 0 ? '(none)' : decision.reasons.join(', ')
        }`,
      );
      parts.push('');
    }
    parts.push('## Task');
    parts.push(`- taskId: ${validated.taskId}`);
    parts.push(`- projectId: ${validated.projectId}`);
    parts.push(`- featureId: ${validated.featureId}`);
    parts.push(`- title: ${validated.task.title}`);
    parts.push(
      `- description: ${validated.task.description === null ? '(none)' : singleLine(validated.task.description)}`,
    );
    parts.push('');
    parts.push('## Acceptance (required; complete; 不得删项)');
    for (const [index, criterion] of validated.task.acceptance.criteria.entries()) {
      parts.push(`[${index + 1}] ${singleLine(criterion)}`);
    }
    parts.push('');
    parts.push('## Dependency evidence');
    if (validated.task.dependencies.length === 0) {
      parts.push('- (no upstream dependencies)');
    } else {
      for (const dependency of validated.task.dependencies) {
        const refs =
          dependency.evidenceRefs.length === 0
            ? '(no evidence refs)'
            : dependency.evidenceRefs
                .map((ref) => `artifact ${ref.artifactId}${ref.contentHash === undefined ? '' : ` sha256:${ref.contentHash}`}`)
                .join(', ');
        parts.push(`- task ${dependency.taskId}: ${refs}`);
      }
    }
    parts.push('');
    parts.push('## Requirements evidence');
    if (validated.task.requirementsRefs.length === 0) {
      parts.push('- (none)');
    } else {
      for (const ref of validated.task.requirementsRefs) {
        parts.push(`- artifact ${ref.artifactId}${ref.contentHash === undefined ? '' : ` sha256:${ref.contentHash}`}`);
      }
    }
    parts.push('');
    parts.push(
      `## Execution strategy (actual copy; source: ${validated.task.configSource}${
        validated.task.configSourceKey === null ? '' : `; key: ${validated.task.configSourceKey}`
      })`,
    );
    parts.push(stableStringify(validated.task.executionConfig));
    parts.push('');
    parts.push('## Applicable check policy');
    parts.push(`- digest: sha256:${validated.checkPolicy.digest}`);
    parts.push(
      `- copy: ${
        validated.checkPolicy.copy === undefined
          ? '(copy not provided; digest is identity)'
          : stableStringify(validated.checkPolicy.copy)
      }`,
    );
    parts.push('');
    parts.push('## Permissions');
    if (validated.permissions.grants.length === 0) {
      parts.push('- (none)');
    } else {
      for (const grant of validated.permissions.grants) {
        parts.push(`- ${grant}`);
      }
    }
    parts.push('');
    parts.push('## Required inputs (must read each before work; verify hash)');
    if (validated.requiredInputs.length === 0) {
      parts.push('- (none)');
    } else {
      for (const ref of validated.requiredInputs) {
        parts.push(
          `- ${ref.purpose}: artifact ${ref.artifactId} v${ref.version} sha256:${ref.contentHash} size ${ref.sizeBytes}B media ${ref.mediaType} locator ${ref.locator} ${renderOrigin(ref.origin)}`,
        );
      }
    }
    parts.push('');
    return parts.join('\n');
  }

  /** 组装 snapshot/manifest/prompt 最终形态与确定性摘要。 */
  function finalize(
    validated: ContextBuildInput,
    historyIndex: ContextSelectedHistoryIndex | null,
    omissions: readonly ContextOmission[],
    prompt: string,
  ): ContextBuildResult {
    const rework = validated.rework ?? null;
    const snapshotBusiness = {
      schemaVersion: CONTEXT_INPUT_SCHEMA_VERSION,
      projectId: validated.projectId,
      featureId: validated.featureId,
      taskId: validated.taskId,
      task: {
        title: validated.task.title,
        description: validated.task.description,
        acceptance: validated.task.acceptance,
        requirementsRefs: validated.task.requirementsRefs,
        dependencies: validated.task.dependencies,
        executionConfig: validated.task.executionConfig,
        configSource: validated.task.configSource,
        configSourceKey: validated.task.configSourceKey,
      },
      checkPolicy: validated.checkPolicy,
      permissions: validated.permissions,
      requiredInputs: validated.requiredInputs,
      ...(historyIndex === null ? {} : { historyIndex }),
      ...(rework === null ? {} : { rework }),
    };
    const inputSnapshot: ContextInputSnapshot = {
      schemaVersion: CONTEXT_INPUT_SCHEMA_VERSION,
      projectId: validated.projectId,
      featureId: validated.featureId,
      taskId: validated.taskId,
      task: {
        title: validated.task.title,
        description: validated.task.description,
        acceptance: validated.task.acceptance,
        requirementsRefs: validated.task.requirementsRefs,
        dependencies: validated.task.dependencies,
        executionConfig: validated.task.executionConfig,
        configSource: validated.task.configSource,
        configSourceKey: validated.task.configSourceKey,
      },
      meta: { labels: validated.task.labels ?? [] },
      checkPolicy: validated.checkPolicy,
      permissions: validated.permissions,
      requiredInputs: validated.requiredInputs,
      historyIndex,
      rework,
    };

    const promptDigest = digestOf(CONTEXT_PROMPT_DIGEST_DOMAIN, prompt);
    const snapshotDigest = digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(snapshotBusiness));

    const manifest = buildManifest(validated, historyIndex, omissions, promptDigest);
    const manifestDigest = digestOf(CONTEXT_MANIFEST_DIGEST_DOMAIN, stableStringify(manifest));
    const promptBytes = utf8Bytes(prompt);
    const tokenEstimate: ContextTokenEstimate = {
      value: Math.ceil(promptBytes / budget.bytesPerTokenEstimate),
      kind: 'estimation',
      method: `utf8-bytes/${budget.bytesPerTokenEstimate}`,
    };
    const digests: ContextDigests = { snapshotDigest, manifestDigest, promptDigest };
    return {
      schemaVersion: CONTEXT_INPUT_SCHEMA_VERSION,
      inputSnapshot,
      inputManifest: manifest,
      prompt,
      digests,
      promptBytes,
      tokenEstimate,
    };
  }

  /** manifest：逐来源记录身份、版本、hash、用途、选取范围、必需性与选择理由。 */
  function buildManifest(
    validated: ContextBuildInput,
    historyIndex: ContextSelectedHistoryIndex | null,
    omissions: readonly ContextOmission[],
    promptDigest: string,
  ): ContextInputManifest {
    const sources: ContextManifestSource[] = [
      {
        sourceId: 'fixed-guidance',
        kind: 'fixed-guidance',
        identity: null,
        version: CONTEXT_INPUT_SCHEMA_VERSION,
        hash: fixedGuidanceHash,
        purpose: 'core-fixed-guidance',
        selection: 'full',
        required: true,
        reason: 'Core 固定权限与执行指导（稳定常量；文件内容不可覆盖）',
        truncated: false,
      },
      {
        sourceId: `task:${validated.taskId}`,
        kind: 'task',
        identity: { taskId: validated.taskId },
        version: null,
        hash: digestOf(
          CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
          stableStringify({ title: validated.task.title, description: validated.task.description }),
        ),
        purpose: 'task-identity',
        selection: 'full',
        required: true,
        reason: '当前 Task 标题与业务描述（固定输入）',
        truncated: false,
      },
      {
        sourceId: `task-acceptance:${validated.taskId}`,
        kind: 'acceptance',
        identity: { taskId: validated.taskId },
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(validated.task.acceptance)),
        purpose: 'task-acceptance',
        selection: `criteria[1..${validated.task.acceptance.criteria.length}] complete`,
        required: true,
        reason: '完整结构化验收：必需固定输入，超预算整体失败，不删项',
        truncated: false,
      },
      {
        sourceId: `task-strategy:${validated.taskId}`,
        kind: 'strategy',
        identity: { taskId: validated.taskId },
        version: null,
        hash: digestOf(
          CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
          stableStringify({
            executionConfig: validated.task.executionConfig,
            configSource: validated.task.configSource,
            configSourceKey: validated.task.configSourceKey,
          }),
        ),
        purpose: 'task-strategy-copy',
        selection: 'full-copy',
        required: true,
        reason: '实际执行策略副本与来源（按副本执行，不重读 modelMap）',
        truncated: false,
      },
      {
        sourceId: `task-requirements:${validated.taskId}`,
        kind: 'requirements',
        identity: { taskId: validated.taskId },
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(validated.task.requirementsRefs)),
        purpose: 'task-requirements-evidence',
        selection:
          validated.task.requirementsRefs.length === 0
            ? 'none'
            : `${validated.task.requirementsRefs.length} refs`,
        required: true,
        reason: '需求/验收证据引用（身份级；空集亦是证据）',
        truncated: false,
      },
      {
        sourceId: `task-dependencies:${validated.taskId}`,
        kind: 'dependencies',
        identity: { taskId: validated.taskId },
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(validated.task.dependencies)),
        purpose: 'task-dependency-evidence',
        selection:
          validated.task.dependencies.length === 0 ? 'none' : `${validated.task.dependencies.length} edges`,
        required: true,
        reason: '依赖证据（上游 Task 与证据引用；空集即无上游依赖）',
        truncated: false,
      },
      {
        sourceId: 'check-policy',
        kind: 'check-policy',
        identity: { digest: validated.checkPolicy.digest },
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(validated.checkPolicy)),
        purpose: 'applicable-check-policy',
        selection: validated.checkPolicy.copy === undefined ? 'digest' : 'digest+copy',
        required: true,
        reason: '适用检查政策身份（批准复合身份成分）',
        truncated: false,
      },
      {
        sourceId: 'permissions',
        kind: 'permissions',
        identity: null,
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(validated.permissions)),
        purpose: 'execution-permissions',
        selection: 'full',
        required: true,
        reason: '执行权限清单（数据，不是提权指令）',
        truncated: false,
      },
    ];
    for (const ref of validated.requiredInputs) {
      sources.push({
        sourceId: `required-input:${ref.artifactId}`,
        kind: 'required-input',
        identity: { artifactId: ref.artifactId, projectId: ref.projectId },
        version: ref.version,
        hash: ref.contentHash,
        purpose: `required-input:${ref.purpose}`,
        selection: 'full-artifact',
        required: true,
        reason: `必需输入（用途 ${ref.purpose}；必须读取并核对 hash）`,
        truncated: false,
      });
    }
    const rework = validated.rework ?? null;
    if (rework !== null) {
      sources.push({
        sourceId: 'rework-guidance',
        kind: 'rework-guidance',
        identity: null,
        version: CONTEXT_INPUT_SCHEMA_VERSION,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, CONTEXT_REWORK_GUIDANCE),
        purpose: 'core-rework-guidance',
        selection: 'full',
        required: true,
        reason: 'Core 固定返工交接指导（先核对现有文件与 Git 再增量修复；禁止删除/reset/重建 worktree）',
        truncated: false,
      });
      sources.push({
        sourceId: `rework-scene:${rework.scene.worktreeId}`,
        kind: 'rework-scene',
        identity: {
          worktreeId: rework.scene.worktreeId,
          attemptId: rework.attemptId,
          previousAttemptId: rework.previousAttemptId,
        },
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(rework.scene)),
        purpose: 'rework-scene-identity',
        selection: 'full',
        required: true,
        reason: '同一 worktree 与已核对 Git/文件现场身份（增量修复基准）',
        truncated: false,
      });
      for (const ref of rework.failureEvidenceRefs) {
        sources.push({
          sourceId: `failure-evidence:${ref.artifactId}`,
          kind: 'failure-evidence',
          identity: { artifactId: ref.artifactId, projectId: ref.projectId },
          version: ref.version,
          hash: ref.contentHash,
          purpose: `failure-evidence:${ref.purpose}`,
          selection: 'full-artifact',
          required: true,
          reason: `必需失败证据引用（用途 ${ref.purpose}；按引用读取并核对 hash，不内联正文）`,
          truncated: false,
        });
      }
      sources.push({
        sourceId: 'recovery-record',
        kind: 'recovery-record',
        identity: {
          selectionMode: rework.recovery.selection.mode,
          decisionMode: rework.recovery.decision.mode,
        },
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(rework.recovery)),
        purpose: 'recovery-source-and-mode',
        selection: 'full',
        required: true,
        reason: '本次恢复来源与模式记录（复用 P03-3A 决策；只记录，不重新决策、不实现原生续接）',
        truncated: false,
      });
    }
    if (historyIndex !== null && (historyIndex.entries.length > 0 || omissions.length > 0)) {
      sources.push({
        sourceId: 'history-index',
        kind: 'history-index',
        identity: null,
        version: null,
        hash: digestOf(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify(historyIndex.entries)),
        purpose: 'optional-history-index',
        selection: `entries[1..${historyIndex.entries.length}] of ${historyIndex.totalAvailable}`,
        required: false,
        reason: '可选历史索引（有限条目/长度；progress/旧报告默认不内联全文）',
        truncated: historyIndex.truncated || historyIndex.omittedCount > 0,
      });
    }
    return {
      schemaVersion: CONTEXT_INPUT_SCHEMA_VERSION,
      projectId: validated.projectId,
      featureId: validated.featureId,
      taskId: validated.taskId,
      sources,
      omissions,
      promptDigest,
    };
  }
}
