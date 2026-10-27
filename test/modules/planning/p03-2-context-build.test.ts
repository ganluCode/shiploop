/**
 * P03-2 / F-005 有版本的 ContextBuilder 回归（纯确定性单元：无 I/O、无时钟、
 * 无随机；所有摘要可独立复算）。
 *
 * 覆盖（F-005 验收点）：
 * - 正常构建：schemaVersion 化的 inputSnapshot/inputManifest/prompt 与确定性
 *   摘要；捕获 Task 标题/描述/完整 acceptance/需求与依赖证据/实际策略副本与
 *   来源/适用检查政策/权限/必需引用；不读取 modelMap 重新路由（无路由入口，
 *   executionConfig 按副本原样进入）；
 * - manifest 逐来源记录身份、版本、hash、用途、选取范围、必需性与选择理由，
 *   明确列出必须读取的输入；完整 acceptance 是固定必需输入，不因预算删项；
 * - 历史增长不膨胀：progress/全任务历史/旧报告默认不全量内联，可选历史只经
 *   有界索引进入；多档规模扩增后 prompt 保持在上限内且不随正文总量线性增长，
 *   当前 acceptance 仍逐项完整可读取；
 * - 预算边界：必需正文/引用数量/最终 prompt 超限结构化失败（不静默截断、
 *   不删 acceptance）；可选内容省略/截断在 manifest 与 snapshot 标注；
 *   token 估算恒标 estimation；
 * - 秘密字段与未知格式负例（fail-closed：内联正文/凭据/路由配置/MCP、Skills
 *   等未选择资源字段一律拒绝）；固定指导不可被输入或装配覆盖；
 * - 相同已固定业务内容生成相同内容摘要，labels 等非业务元数据不混入有效
 *   验收身份。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_FIXED_GUIDANCE,
  CONTEXT_INPUT_SCHEMA_VERSION,
  CONTEXT_MANIFEST_DIGEST_DOMAIN,
  CONTEXT_PROMPT_DIGEST_DOMAIN,
  CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
  ContextBuildError,
  isContextBuildError,
  validateContextBuildInput,
} from '../../../packages/core/src/ports/context-build.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import type { ContextBudget, ContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeRef(
  purpose: string,
  artifactId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId: 'proj-1',
    artifactId,
    kind: 'execution-input',
    purpose,
    version: 1,
    contentHash: sha256Hex(`content:${artifactId}`),
    sizeBytes: 128,
    locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain',
    origin: { kind: 'file', root: 'sources', relativePath: `${purpose}.txt` },
    ...overrides,
  };
}

function makeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-1',
    featureId: 'feat-1',
    taskId: 'task-1',
    task: {
      title: '实现支付重试',
      description: '在网络抖动时按策略重试支付请求。',
      acceptance: { criteria: ['重试不超过 3 次', '失败记录审计日志'] },
      requirementsRefs: [{ artifactId: 'art-req-1', contentHash: sha256Hex('req1') }],
      dependencies: [
        { taskId: 'task-0', evidenceRefs: [{ artifactId: 'art-dep-1' }] },
      ],
      executionConfig: { runtime: 'pi', provider: 'example', model: 'example-1' },
      configSource: 'project_default',
      configSourceKey: 'default',
      labels: ['payments'],
    },
    checkPolicy: { digest: sha256Hex('policy'), copy: { verification: { scope: 'affected' } } },
    permissions: { grants: ['repo.read', 'repo.write', 'tests.run'] },
    requiredInputs: [makeRef('spec', 'art-in-1'), makeRef('fixture', 'art-in-2', { version: 3 })],
    ...overrides,
  };
}

const DEFAULT_BUDGET: ContextBudget = {
  maxPromptBytes: 200_000,
  maxRequiredSnapshotBytes: 100_000,
  maxRequiredInputRefs: 8,
  maxHistoryEntries: 20,
  maxHistoryEntryChars: 120,
  bytesPerTokenEstimate: 4,
};

function makeBuilder(overrides: Partial<ContextBudget> = {}): ContextBuilder {
  return createContextBuilder({ budget: { ...DEFAULT_BUDGET, ...overrides } });
}

function expectContextError(error: unknown, code: string, field?: string): void {
  expect(error).toBeInstanceOf(ContextBuildError);
  if (isContextBuildError(error)) {
    expect(error.code).toBe(code);
    if (field !== undefined) {
      expect(error.field).toContain(field);
    }
  }
}

/** 与实现同一规范化规则独立复算 snapshot 摘要（确定性可核对）。 */
function recomputeSnapshotDigest(input: Record<string, unknown>, historyIndex: unknown): string {
  const validated = validateContextBuildInput(input);
  const business = {
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
    ...(historyIndex === null || historyIndex === undefined ? {} : { historyIndex }),
  };
  return sha256Hex(`${CONTEXT_SNAPSHOT_DIGEST_DOMAIN}\n${stableStringify(business)}`);
}

describe('P03-2 / F-005 ContextBuilder 正常构建与确定性', () => {
  it('输出 schemaVersion 化的 snapshot/manifest/prompt 与确定性摘要（可独立复算）', () => {
    const builder = makeBuilder();
    const input = makeInput();
    const result = builder.build(input);

    expect(result.schemaVersion).toBe(CONTEXT_INPUT_SCHEMA_VERSION);
    expect(result.inputSnapshot.schemaVersion).toBe(CONTEXT_INPUT_SCHEMA_VERSION);
    expect(result.inputManifest.schemaVersion).toBe(CONTEXT_INPUT_SCHEMA_VERSION);
    expect(result.prompt).toContain(`schemaVersion ${CONTEXT_INPUT_SCHEMA_VERSION}`);

    // 捕获当前 Task 标题、描述、完整 acceptance、需求与依赖证据、策略副本与
    // 来源、适用检查政策、权限和必需引用。
    expect(result.inputSnapshot.task.title).toBe('实现支付重试');
    expect(result.inputSnapshot.task.description).toBe('在网络抖动时按策略重试支付请求。');
    expect(result.inputSnapshot.task.acceptance.criteria).toEqual(['重试不超过 3 次', '失败记录审计日志']);
    expect(result.inputSnapshot.task.requirementsRefs).toEqual([
      { artifactId: 'art-req-1', contentHash: sha256Hex('req1') },
    ]);
    expect(result.inputSnapshot.task.dependencies).toEqual([
      { taskId: 'task-0', evidenceRefs: [{ artifactId: 'art-dep-1' }] },
    ]);
    expect(result.inputSnapshot.task.configSource).toBe('project_default');
    expect(result.inputSnapshot.checkPolicy.digest).toBe(sha256Hex('policy'));
    expect(result.inputSnapshot.permissions.grants).toEqual(['repo.read', 'repo.write', 'tests.run']);
    expect(result.inputSnapshot.requiredInputs).toHaveLength(2);
    expect(result.inputSnapshot.historyIndex).toBeNull();

    // 确定性摘要：64hex + 独立复算一致 + 域分隔。
    for (const digest of [
      result.digests.snapshotDigest,
      result.digests.manifestDigest,
      result.digests.promptDigest,
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.digests.snapshotDigest).toBe(recomputeSnapshotDigest(input, null));
    expect(result.digests.promptDigest).toBe(
      sha256Hex(`${CONTEXT_PROMPT_DIGEST_DOMAIN}\n${result.prompt}`),
    );
    expect(result.digests.manifestDigest).toBe(
      sha256Hex(`${CONTEXT_MANIFEST_DIGEST_DOMAIN}\n${stableStringify(result.inputManifest)}`),
    );

    // prompt 结构：固定指导原样在头部，Task 标题/描述/验收逐条内联，必需引用
    // 列为「必须读取」。
    const guidanceIndex = result.prompt.indexOf(CONTEXT_FIXED_GUIDANCE);
    expect(guidanceIndex).toBeGreaterThanOrEqual(0);
    expect(result.prompt.indexOf('## Task')).toBeGreaterThan(guidanceIndex);
    expect(result.prompt).toContain('title: 实现支付重试');
    expect(result.prompt).toContain('description: 在网络抖动时按策略重试支付请求。');
    expect(result.prompt).toContain('[1] 重试不超过 3 次');
    expect(result.prompt).toContain('[2] 失败记录审计日志');
    expect(result.prompt).toContain('## Required inputs (must read each before work; verify hash)');
    expect(result.prompt).toContain(
      'spec: artifact art-in-1 v1 sha256:' + sha256Hex('content:art-in-1'),
    );
    expect(result.prompt).toContain('fixture: artifact art-in-2 v3');
    expect(result.prompt).toContain('- repo.read');

    // token 估算恒标 estimation，不冒充精确用量。
    expect(result.tokenEstimate.kind).toBe('estimation');
    expect(result.tokenEstimate.method).toBe('utf8-bytes/4');
    expect(result.tokenEstimate.value).toBe(Math.ceil(result.promptBytes / 4));
    expect(result.promptBytes).toBe(Buffer.byteLength(result.prompt, 'utf8'));
  });

  it('相同输入重复构建产生完全相同输出（纯函数，无时钟/随机）', () => {
    const builder = makeBuilder();
    const input = makeInput();
    const first = builder.build(input);
    const second = builder.build(makeInput());
    expect(second).toEqual(first);
  });

  it('manifest 逐来源记录身份、版本、hash、用途、选取范围、必需性与选择理由', () => {
    const result = makeBuilder().build(makeInput());
    const manifest = result.inputManifest;

    const kinds = manifest.sources.map((source) => source.kind);
    expect(kinds).toEqual([
      'fixed-guidance',
      'task',
      'acceptance',
      'strategy',
      'requirements',
      'dependencies',
      'check-policy',
      'permissions',
      'required-input',
      'required-input',
    ]);

    // 必需来源全部 required=true；必需内容永不截断。
    for (const source of manifest.sources) {
      expect(source.reason.length).toBeGreaterThan(0);
      expect(source.purpose.length).toBeGreaterThan(0);
      expect(source.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(source.selection.length).toBeGreaterThan(0);
      if (source.kind !== 'history-index') {
        expect(source.required).toBe(true);
        expect(source.truncated).toBe(false);
      }
    }

    // 完整 acceptance 是固定必需输入，选取范围标明 complete。
    const acceptance = manifest.sources.find((source) => source.kind === 'acceptance');
    expect(acceptance?.sourceId).toBe('task-acceptance:task-1');
    expect(acceptance?.selection).toBe('criteria[1..2] complete');

    // 必需输入引用逐条列出（必须读取），身份/版本/hash 取自权威引用。
    const requiredInputs = manifest.sources.filter((source) => source.kind === 'required-input');
    expect(requiredInputs.map((source) => source.sourceId)).toEqual([
      'required-input:art-in-1',
      'required-input:art-in-2',
    ]);
    expect(requiredInputs[1].version).toBe(3);
    expect(requiredInputs[1].hash).toBe(sha256Hex('content:art-in-2'));
    expect(requiredInputs[1].identity).toEqual({ artifactId: 'art-in-2', projectId: 'proj-1' });
    expect(requiredInputs[0].purpose).toBe('required-input:spec');

    // manifest 通过 promptDigest 与最终 prompt 绑定。
    expect(manifest.promptDigest).toBe(result.digests.promptDigest);
    expect(manifest.omissions).toEqual([]);
  });

  it('实际策略副本与来源按副本进入 snapshot 与 prompt（不读取 modelMap 重新路由）', () => {
    const executionConfig = { runtime: 'pi', provider: 'example', model: 'example-1', nested: { a: [1, 2] } };
    const result = makeBuilder().build(makeInput({ task: { ...(makeInput().task as object), executionConfig } as object }));
    expect(result.inputSnapshot.task.executionConfig).toEqual(executionConfig);
    expect(result.prompt).toContain(`## Execution strategy (actual copy; source: project_default; key: default)`);
    expect(result.prompt).toContain(stableStringify(executionConfig));

    const strategy = result.inputManifest.sources.find((source) => source.kind === 'strategy');
    expect(strategy?.required).toBe(true);
    expect(strategy?.selection).toBe('full-copy');
  });
});

describe('P03-2 / F-005 完整 acceptance（固定必需输入）', () => {
  it('多条长验收逐项完整内联且顺序保持', () => {
    const criteria = Array.from({ length: 12 }, (_, index) => `验收条目 ${index + 1}：` + 'x'.repeat(100));
    const result = makeBuilder().build(
      makeInput({ task: { ...(makeInput().task as object), acceptance: { criteria } } as object }),
    );
    expect(result.inputSnapshot.task.acceptance.criteria).toEqual(criteria);
    for (const [index, criterion] of criteria.entries()) {
      const position = result.prompt.indexOf(`[${index + 1}] ${criterion}`);
      expect(position).toBeGreaterThan(0);
      if (index > 0) {
        expect(position).toBeGreaterThan(result.prompt.indexOf(`[${index}] ${criteria[index - 1]}`));
      }
    }
    const acceptance = result.inputManifest.sources.find((source) => source.kind === 'acceptance');
    expect(acceptance?.selection).toBe('criteria[1..12] complete');
    expect(acceptance?.required).toBe(true);
  });

  it('prompt 预算不足时整体结构化失败，不以删减验收条目换取成功', () => {
    const builder = makeBuilder();
    const input = makeInput();
    const full = builder.build(input);
    const tightBudget: ContextBudget = {
      ...DEFAULT_BUDGET,
      maxPromptBytes: full.promptBytes - 1,
      maxRequiredSnapshotBytes: DEFAULT_BUDGET.maxRequiredSnapshotBytes,
    };
    const tight = createContextBuilder({ budget: tightBudget });
    let error: unknown;
    try {
      tight.build(makeInput());
    } catch (thrown) {
      error = thrown;
    }
    expectContextError(error, 'limit_exceeded', 'maxPromptBytes');
    const details = isContextBuildError(error) ? error.details : undefined;
    expect(details?.measuredBytes).toBe(full.promptBytes);
    expect(details?.limitBytes).toBe(full.promptBytes - 1);
  });
});

describe('P03-2 / F-005 历史增长不膨胀（固定指导与动态输入分离）', () => {
  function historyEntries(count: number, summaryLength = 100): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `entry-${index + 1}`,
      summary: `历史条目 ${index + 1}:` + 'h'.repeat(summaryLength),
    }));
  }

  it('历史正文总量多档扩增后 prompt 规模不变且保持在上限内，acceptance 仍完整', () => {
    const budget: ContextBudget = { ...DEFAULT_BUDGET, maxHistoryEntries: 20 };
    const builder = createContextBuilder({ budget });
    const promptBytes: number[] = [];
    for (const count of [20, 200, 2000]) {
      const result = builder.build(
        makeInput({
          historyIndex: { entries: historyEntries(count), totalAvailable: count },
        }),
      );
      promptBytes.push(result.promptBytes);
      expect(result.promptBytes).toBeLessThanOrEqual(budget.maxPromptBytes);
      expect(result.inputSnapshot.historyIndex?.entries).toHaveLength(20);
      expect(result.inputSnapshot.historyIndex?.omittedCount).toBe(count - 20);
      expect(result.inputSnapshot.historyIndex?.totalAvailable).toBe(count);
      expect(result.inputSnapshot.historyIndex?.entries[0]?.id).toBe('entry-1');
      // 当前 acceptance 仍逐项完整可读取。
      expect(result.prompt).toContain('[1] 重试不超过 3 次');
      expect(result.prompt).toContain('[2] 失败记录审计日志');
      // manifest 标注可选内容省略（首档恰好等于条数预算，无省略）。
      const omissions = result.inputManifest.omissions.filter((item) => item.kind === 'history-entry-omitted');
      if (count === 20) {
        expect(omissions).toHaveLength(0);
        expect(result.inputSnapshot.historyIndex?.omittedCount).toBe(0);
      } else {
        expect(omissions.length).toBeGreaterThan(0);
        expect(omissions[0]?.note).toContain(`省略 ${count - 20} 条`);
      }
      const history = result.inputManifest.sources.find((source) => source.kind === 'history-index');
      expect(history?.required).toBe(false);
      expect(history?.selection).toBe(`entries[1..20] of ${count}`);
    }
    // 三档规模 prompt 字节基本一致（仅 footer 总数位数差异，≤16 字节）：
// 不随历史正文总量线性增长。
    expect(promptBytes[1] - promptBytes[0]).toBeLessThanOrEqual(16);
    expect(promptBytes[2] - promptBytes[0]).toBeLessThanOrEqual(16);
    // 与正文总量对比：2000 条时总正文字节远超 prompt 增量。
    const tier3Volume = Buffer.byteLength(
      historyEntries(2000).map((entry) => String(entry.summary)).join(''),
      'utf8',
    );
    expect(tier3Volume).toBeGreaterThan(promptBytes[2] * 10);
  });

  it('超长历史摘要按预算截断并在 manifest 标注（可选内容可截断，必需内容不可）', () => {
    const longSummary = '开头内容' + 'L'.repeat(5_000) + '尾部标记';
    const result = makeBuilder().build(
      makeInput({
        historyIndex: { entries: [{ id: 'big-entry', summary: longSummary }] },
      }),
    );
    const selected = result.inputSnapshot.historyIndex?.entries[0];
    expect(selected?.id).toBe('big-entry');
    expect([...(selected?.summary ?? '')].length).toBeLessThanOrEqual(DEFAULT_BUDGET.maxHistoryEntryChars);
    expect(result.inputSnapshot.historyIndex?.truncated).toBe(true);
    expect(result.prompt).not.toContain('尾部标记');
    const truncation = result.inputManifest.omissions.find(
      (item) => item.kind === 'history-entry-truncated',
    );
    expect(truncation?.note).toContain('big-entry');
    expect(result.inputManifest.sources.find((source) => source.kind === 'history-index')?.truncated).toBe(true);
  });

  it('prompt 剩余预算不足时按输入顺序前缀保留，其余省略并标注（不重排挑选）', () => {
    const noneHistory = makeBuilder().build(makeInput());
    const full = makeBuilder().build(
      makeInput({ historyIndex: { entries: historyEntries(20) } }),
    );
    // 预算只够容纳约一半历史段落。
    const middle = Math.floor((noneHistory.promptBytes + full.promptBytes) / 2);
    const tight = createContextBuilder({
      budget: { ...DEFAULT_BUDGET, maxPromptBytes: middle },
    });
    const result = tight.build(makeInput({ historyIndex: { entries: historyEntries(20) } }));
    expect(result.promptBytes).toBeLessThanOrEqual(middle);
    const kept = result.inputSnapshot.historyIndex?.entries ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);
    for (const [index] of kept.entries()) {
      expect(kept[index]?.id).toBe(`entry-${index + 1}`);
    }
    expect(result.inputSnapshot.historyIndex?.omittedCount).toBe(20 - kept.length);
    const omissionNote = result.inputManifest.omissions
      .map((item) => item.note)
      .join('\n');
    expect(omissionNote).toContain('前缀策略');
  });

  it('无历史输入时不产生历史 manifest 条目与 prompt 段落', () => {
    const result = makeBuilder().build(makeInput());
    expect(result.inputSnapshot.historyIndex).toBeNull();
    expect(result.inputManifest.sources.find((source) => source.kind === 'history-index')).toBeUndefined();
    expect(result.prompt).not.toContain('## History index');
    expect(result.inputManifest.omissions).toEqual([]);
  });
});

describe('P03-2 / F-005 缺少必需输入负例', () => {
  const missingCases: Array<[string, Record<string, unknown>]> = [
    ['requiredInputs 缺席', { requiredInputs: undefined }],
    ['requiredInputs 为 null', { requiredInputs: null }],
    ['acceptance 缺席', { task: { ...(makeInput().task as object), acceptance: undefined } }],
    [
      'acceptance 条目为空',
      { task: { ...(makeInput().task as object), acceptance: { criteria: [] } } as object },
    ],
    ['checkPolicy 缺席', { checkPolicy: undefined }],
    ['permissions 缺席', { permissions: undefined }],
    ['task 缺席', { task: undefined }],
    [
      'executionConfig 缺席',
      { task: { ...(makeInput().task as object), executionConfig: undefined } as object },
    ],
    [
      'configSource 缺席',
      { task: { ...(makeInput().task as object), configSource: undefined } as object },
    ],
    [
      'dependencies 缺席（可为空数组但不能缺席）',
      { task: { ...(makeInput().task as object), dependencies: undefined } as object },
    ],
  ];

  for (const [name, overrides] of missingCases) {
    it(`${name} → missing_required_input`, () => {
      let error: unknown;
      try {
        makeBuilder().build(makeInput(overrides));
      } catch (thrown) {
        error = thrown;
      }
      expectContextError(error, 'missing_required_input');
    });
  }
});

describe('P03-2 / F-005 预算边界（结构化失败，不静默截断必需内容）', () => {
  it('必需输入引用数量超限 → limit_exceeded（携带限制名与实测值）', () => {
    const manyRefs = Array.from({ length: 9 }, (_, index) => makeRef(`p${index}`, `art-${index}`));
    let error: unknown;
    try {
      makeBuilder().build(makeInput({ requiredInputs: manyRefs }));
    } catch (thrown) {
      error = thrown;
    }
    expectContextError(error, 'limit_exceeded', 'maxRequiredInputRefs');
    const details = isContextBuildError(error) ? error.details : undefined;
    expect(details).toMatchObject({ measured: 9, limit: 8, limitName: 'maxRequiredInputRefs' });
  });

  it('必需正文规范化字节超限 → limit_exceeded（不截断 acceptance/策略副本）', () => {
    const bigConfig = { blob: 'K'.repeat(8_000) };
    let error: unknown;
    try {
      makeBuilder({ maxRequiredSnapshotBytes: 4_000 }).build(
        makeInput({ task: { ...(makeInput().task as object), executionConfig: bigConfig } as object }),
      );
    } catch (thrown) {
      error = thrown;
    }
    expectContextError(error, 'limit_exceeded', 'maxRequiredSnapshotBytes');
    const details = isContextBuildError(error) ? error.details : undefined;
    expect((details?.measuredBytes as number)).toBeGreaterThan(4_000);
    expect(details?.limitBytes).toBe(4_000);
  });

  it('prompt 预算小到无法容纳必需内容 → limit_exceeded', () => {
    let error: unknown;
    try {
      makeBuilder({ maxPromptBytes: 200 }).build(makeInput());
    } catch (thrown) {
      error = thrown;
    }
    expectContextError(error, 'limit_exceeded', 'maxPromptBytes');
  });

  it('大历史 + 紧预算不失败：可选内容省略是成功路径的一部分', () => {
    const result = makeBuilder({ maxPromptBytes: 20_000 }).build(
      makeInput({
        historyIndex: {
          entries: Array.from({ length: 500 }, (_, index) => ({
            id: `h-${index}`,
            summary: 's'.repeat(100),
          })),
          totalAvailable: 500,
        },
      }),
    );
    expect(result.promptBytes).toBeLessThanOrEqual(20_000);
    expect(result.inputSnapshot.historyIndex?.omittedCount).toBeGreaterThan(0);
  });
});

describe('P03-2 / F-005 秘密字段与未知格式负例（fail-closed）', () => {
  const secretCases: Array<[string, Record<string, unknown>]> = [
    ['task 携带 apiKey', { task: { ...(makeInput().task as object), apiKey: 'sk-123' } }],
    ['task 携带 secret', { task: { ...(makeInput().task as object), secret: 'zzz' } }],
    ['task 携带内联 content', { task: { ...(makeInput().task as object), content: '正文' } }],
    ['顶层携带 credentials', { credentials: { token: 't' } }],
    [
      '必需输入引用携带内联 content',
      { requiredInputs: [makeRef('spec', 'art-in-1', { content: '正文' })] },
    ],
    [
      '必需输入引用携带 credentials',
      { requiredInputs: [makeRef('spec', 'art-in-1', { credentials: 'x' })] },
    ],
  ];

  for (const [name, overrides] of secretCases) {
    it(`${name} → validation（内联正文/凭据字段拒绝）`, () => {
      let error: unknown;
      try {
        makeBuilder().build(makeInput(overrides));
      } catch (thrown) {
        error = thrown;
      }
      expectContextError(error, 'validation');
    });
  }

  const unknownFormatCases: Array<[string, unknown]> = [
    ['输入不是对象', 42],
    ['输入是数组', [makeInput()]],
    ['task 不是对象', { ...makeInput(), task: 42 }],
    ['acceptance 是字符串（引用不能替代结构化验收）', { ...makeInput(), task: { ...(makeInput().task as object), acceptance: '必须全部通过' } }],
    ['验收条目不是字符串', { ...makeInput(), task: { ...(makeInput().task as object), acceptance: { criteria: [42] } } }],
    ['requiredInputs 不是数组', { ...makeInput(), requiredInputs: 'all' }],
    ['必需输入引用 hash 非法', { ...makeInput(), requiredInputs: [makeRef('spec', 'art-in-1', { contentHash: 'deadbeef' })] }],
    ['必需输入引用跨项目', { ...makeInput(), requiredInputs: [makeRef('spec', 'art-in-1', { projectId: 'proj-other' })] }],
    ['必需输入引用重复制品', { ...makeInput(), requiredInputs: [makeRef('spec', 'art-in-1'), makeRef('other', 'art-in-1')] }],
    ['checkPolicy digest 非法', { ...makeInput(), checkPolicy: { digest: 'nope' } }],
    ['permissions grants 非数组', { ...makeInput(), permissions: { grants: 'repo.read' } }],
    ['labels 非数组', { ...makeInput(), task: { ...(makeInput().task as object), labels: 123 } }],
    ['historyIndex 未知键', { ...makeInput(), historyIndex: { entries: [], fullText: '...' } }],
    ['历史条目重复 ID', { ...makeInput(), historyIndex: { entries: [{ id: 'a', summary: 'x' }, { id: 'a', summary: 'y' }] } }],
    ['totalAvailable 小于条目数', { ...makeInput(), historyIndex: { entries: [{ id: 'a', summary: 'x' }], totalAvailable: 0 } }],
  ];

  for (const [name, input] of unknownFormatCases) {
    it(`未知/非法格式：${name} → validation`, () => {
      let error: unknown;
      try {
        makeBuilder().build(input);
      } catch (thrown) {
        error = thrown;
      }
      expectContextError(error, 'validation');
    });
  }

  const unselectedResourceCases: Array<[string, Record<string, unknown>]> = [
    ['modelMap（路由重新选择入口）', { modelMap: { low: { model: 'm' } } }],
    ['全局 settings', { settings: { a: 1 } }],
    ['未选择的 MCP 服务器', { mcpServers: [{ name: 'x' }] }],
    ['未选择的 Skills', { skills: ['skill-a'] }],
    ['未选择的扩展', { extensions: ['ext-a'] }],
    ['全文知识库', { knowledge: { wiki: '全文' } }],
    ['ProjectProfile（本项不实现）', { projectProfile: { revision: 'r1' } }],
  ];

  for (const [name, overrides] of unselectedResourceCases) {
    it(`不自动继承未选择资源：${name} → validation（未知键拒绝）`, () => {
      let error: unknown;
      try {
        makeBuilder().build(makeInput(overrides));
      } catch (thrown) {
        error = thrown;
      }
      expectContextError(error, 'validation');
    });
  }
});

describe('P03-2 / F-005 有效验收身份：labels 等非业务元数据不混入', () => {
  it('相同已固定业务内容、不同 labels → 全部内容摘要一致；labels 仅入 meta', () => {
    const builder = makeBuilder();
    const withAlpha = builder.build(makeInput({ task: { ...(makeInput().task as object), labels: ['alpha'] } as object }));
    const withBeta = builder.build(makeInput({ task: { ...(makeInput().task as object), labels: ['beta', 'gamma'] } as object }));
    const withoutLabels = builder.build(
      makeInput({ task: { ...(makeInput().task as object), labels: undefined } as object }),
    );

    expect(withAlpha.digests).toEqual(withBeta.digests);
    expect(withAlpha.digests).toEqual(withoutLabels.digests);
    expect(withAlpha.prompt).toBe(withBeta.prompt);
    expect(withAlpha.inputManifest).toEqual(withBeta.inputManifest);
    // labels 只作为追溯元数据记录在 snapshot.meta。
    expect(withAlpha.inputSnapshot.meta.labels).toEqual(['alpha']);
    expect(withBeta.inputSnapshot.meta.labels).toEqual(['beta', 'gamma']);
    expect(withoutLabels.inputSnapshot.meta.labels).toEqual([]);
  });
});

describe('P03-2 / F-005 已授权知识来源与输入身份', () => {
  function knowledgeSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'document',
      documentId: 'doc-1',
      projectId: 'proj-1',
      version: 2,
      contentRef: {
        projectId: 'proj-1',
        artifactId: 'knowledge-artifact-1',
        version: 7,
        contentHash: sha256Hex('managed-knowledge'),
        sizeBytes: 1_024,
      },
      range: { start: 10, end: 44, line: 2, column: 3 },
      purpose: 'task-guidance',
      required: true,
      reason: '当前 Task 需要该文档的授权命中片段',
      snippet: '受管文档命中片段',
      ...overrides,
    };
  }

  it('[case:knowledge-source-manifest-identity] 将文档/记忆选择写入快照、prompt 与 manifest，并保留来源顺序', () => {
    const input = makeInput({
      knowledge: {
        selections: [
          knowledgeSource(),
          knowledgeSource({
            kind: 'memory',
            documentId: undefined,
            memoryId: 'memory-1',
            version: 3,
            contentRef: {
              projectId: 'proj-1',
              artifactId: 'memory-artifact-1',
              version: 4,
              contentHash: sha256Hex('managed-memory'),
              sizeBytes: 512,
            },
            range: { start: 0, end: 18 },
            purpose: 'accepted-memory',
            required: false,
            reason: '已接受记忆与当前实现相关',
            snippet: '受管记忆命中片段',
          }),
        ],
      },
    });
    const result = makeBuilder().build(input);
    const knowledge = result.inputSnapshot.knowledge;

    expect(result.schemaVersion).toBeGreaterThan(4);
    expect(knowledge?.map((source) => source.kind)).toEqual(['document', 'memory']);
    expect(knowledge?.[0]).toMatchObject({
      documentId: 'doc-1',
      version: 2,
      contentHash: sha256Hex('managed-knowledge'),
      range: { start: 10, end: 44, line: 2, column: 3 },
      purpose: 'task-guidance',
      required: true,
      reason: '当前 Task 需要该文档的授权命中片段',
      truncated: false,
    });
    expect(result.prompt).toContain('## Authorized knowledge selections');
    expect(result.prompt).toContain('document doc-1 v2');
    expect(result.prompt).toContain('memory memory-1 v3');
    expect(result.inputManifest.sources.filter((source) => source.kind === 'knowledge')).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ documentId: 'doc-1', projectId: 'proj-1' }),
        version: 2,
        hash: sha256Hex('managed-knowledge'),
        purpose: 'task-guidance',
        selection: 'range[10..44)',
        required: true,
        truncated: false,
      }),
      expect.objectContaining({
        identity: expect.objectContaining({ memoryId: 'memory-1', projectId: 'proj-1' }),
        version: 3,
        hash: sha256Hex('managed-memory'),
        required: false,
      }),
    ]);
  });

  it('[case:knowledge-digest-label-invariance] 知识来源参与业务摘要，labels 仍不参与摘要', () => {
    const knowledge = { selections: [knowledgeSource()] };
    const first = makeBuilder().build(makeInput({ knowledge, task: { ...(makeInput().task as object), labels: ['one'] } as object }));
    const second = makeBuilder().build(makeInput({ knowledge, task: { ...(makeInput().task as object), labels: ['two', 'three'] } as object }));
    const changed = makeBuilder().build(makeInput({
      knowledge: { selections: [knowledgeSource({ reason: '不同的授权选择理由' })] },
    }));

    expect(first.digests).toEqual(second.digests);
    expect(first.inputManifest).toEqual(second.inputManifest);
    expect(first.inputSnapshot.knowledge).toEqual(second.inputSnapshot.knowledge);
    expect(changed.digests.snapshotDigest).not.toBe(first.digests.snapshotDigest);
    expect(changed.digests.manifestDigest).not.toBe(first.digests.manifestDigest);
  });

  it('[case:knowledge-budget-required-and-optional] 必需知识超限失败，可选知识按顺序截断并记录 omissions', () => {
    const required = knowledgeSource({ snippet: '必需片段'.repeat(10) });
    expect(() => makeBuilder({ maxKnowledgeSnippetChars: 4 }).build(makeInput({ knowledge: { selections: [required] } })))
      .toThrowError(ContextBuildError);

    const optional = knowledgeSource({
      required: false,
      snippet: '可选片段'.repeat(10),
      reason: '可选背景',
    });
    const result = makeBuilder({ maxKnowledgeSnippetChars: 4, maxKnowledgeTotalBytes: 20 })
      .build(makeInput({ knowledge: { selections: [optional] } }));
    expect(result.inputSnapshot.knowledge?.[0]).toMatchObject({
      snippet: '可选片段',
      truncated: true,
    });
    expect(result.inputManifest.omissions).toEqual([
      expect.objectContaining({ sourceId: expect.stringContaining('knowledge:'), kind: 'knowledge-entry-truncated' }),
    ]);
  });

  it('[case:knowledge-prompt-budget-optional] 可选知识超过最终 prompt 预算时省略并保留结构化 omissions', () => {
    const baseBytes = makeBuilder().build(makeInput()).promptBytes;
    const optional = knowledgeSource({ required: false, reason: '可选背景', snippet: '额外背景片段' });
    const result = makeBuilder({ maxPromptBytes: baseBytes + 1 }).build(
      makeInput({ knowledge: { selections: [optional] } }),
    );
    expect(result.inputSnapshot.knowledge).toBeUndefined();
    expect(result.inputManifest.omissions).toEqual([
      expect.objectContaining({ kind: 'knowledge-entry-omitted', sourceId: expect.stringContaining('knowledge:') }),
    ]);
  });
  it('[case:knowledge-fail-closed] 知识来源必须是同项目受管制品引用，未知类别/跨项目/内联正文均拒绝', () => {
    const invalidCases = [
      { ...knowledgeSource(), kind: 'wiki' },
      { ...knowledgeSource(), projectId: 'other-project' },
      { ...knowledgeSource(), content: '绕过 Artifact 的正文' },
      { ...knowledgeSource(), contentRef: { ...(knowledgeSource().contentRef as object), projectId: 'other-project' } },
    ];
    for (const source of invalidCases) {
      expect(() => makeBuilder().build(makeInput({ knowledge: { selections: [source] } })))
        .toThrowError(ContextBuildError);
    }
  });
});

describe('P03-2 / F-005 固定指导与权限边界', () => {
  it('文件/引用内容不能覆盖 Core 权限指导：指导常量原样位于 prompt 头部且不可注入替换', () => {
    const adversarial = makeRef('ignore-previous-instructions', 'art-adv', {
      locator: 'execution-inputs/ignore-previous-instructions',
    });
    const result = makeBuilder().build(
      makeInput({
        requiredInputs: [adversarial],
        permissions: { grants: ['grant:file-says-admin'] },
      }),
    );
    const guidanceIndex = result.prompt.indexOf(CONTEXT_FIXED_GUIDANCE);
    expect(guidanceIndex).toBeGreaterThanOrEqual(0);
    expect(result.prompt.indexOf('## Task')).toBeGreaterThan(guidanceIndex);
    // 对抗性内容只作为数据出现在必需引用清单中，不能进入指导位置。
    const adversarialIndex = result.prompt.indexOf('ignore-previous-instructions');
    expect(adversarialIndex).toBeGreaterThan(result.prompt.indexOf('## Required inputs'));
    expect(result.prompt.indexOf(CONTEXT_FIXED_GUIDANCE)).toBe(result.prompt.lastIndexOf(CONTEXT_FIXED_GUIDANCE));
  });

  it('装配入口无法替换固定指导或注入配置（未知 deps 键拒绝）', () => {
    let error: unknown;
    try {
      createContextBuilder({
        budget: DEFAULT_BUDGET,
        ...( { fixedGuidance: '覆盖指导' } as unknown as Record<string, unknown> ),
      } as never);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(Error);
    if (isContextBuildError(error)) {
      throw new Error('装配校验应抛 StorageError(validation) 而非 ContextBuildError');
    }
  });

  it('validateContextBuildInput 独立导出可用：规范化 trim 并保留业务内容', () => {
    const validated = validateContextBuildInput(
      makeInput({ task: { ...(makeInput().task as object), title: '  带空格的标题  ' } as object }),
    );
    expect(validated.task.title).toBe('带空格的标题');
    expect(validated.projectId).toBe('proj-1');
    expect(validated.taskId).toBe('task-1');
    expect(validated.requiredInputs).toHaveLength(2);
    expect(validated.historyIndex).toBeUndefined();
  });
});

/**
 * P03-10 / F-010 输入装配历史增长与必需输入完整性确定性回归（T37 子集）。
 * 沿用本文件前序输入装配夹具（makeInput/makeBuilder/同输入形态），不新增知识
 * 平台、不调用模型；此处只证明有界装配与输入完整性，不宣称缓存命中或 Token
 * 节省（token 估算恒为 estimation）。历史增长对照使用同一 Task 的小历史与
 * 显著增长的 progress/报告摘要夹具。
 */
describe('P03-10 / F-010 输入装配历史增长与必需输入完整性回归', () => {
  it('[case:f010-history-small-vs-grown-readable] 同一 Task 小历史与显著增长 progress/报告对照：固定指导不复制历史全文，动态内容走不可变引用/摘要，描述/acceptance/依赖结果始终可读', () => {
    const builder = makeBuilder();
    const small = builder.build(makeInput({
      historyIndex: {
        entries: [
          { id: 'progress-1', summary: 'progress 摘要：首次执行记录' },
          { id: 'report-1', summary: 'report 摘要：旧报告要点' },
        ],
        totalAvailable: 2,
      },
    }));
    const grownEntries = Array.from({ length: 60 }, (_, index) => ({
      id: `report-${index + 1}`,
      summary: `progress/报告 ${index + 1} 正文开头：${'R'.repeat(2_000)} FULL_BODY_MARK_${index + 1}`,
    }));
    const grownInput = () => makeInput({
      historyIndex: { entries: grownEntries, totalAvailable: 4_000 },
    });
    const grown = builder.build(grownInput());

    /* 固定指导是 Core 常量、原样位于历史段之前；完整历史正文零内联。 */
    for (const result of [small, grown]) {
      expect(result.prompt).toContain(CONTEXT_FIXED_GUIDANCE);
      expect(result.prompt.indexOf(CONTEXT_FIXED_GUIDANCE))
        .toBeLessThan(result.prompt.indexOf('## History index'));
    }
    expect(grown.prompt).not.toContain('FULL_BODY_MARK');
    expect(grown.prompt).not.toContain('R'.repeat(200));

    /* prompt 规模有界：远小于历史正文总量，不随 progress/报告增长线性膨胀。 */
    const grownHistoryChars = grownEntries.reduce((sum, entry) => sum + entry.summary.length, 0);
    expect(grown.promptBytes).toBeLessThanOrEqual(DEFAULT_BUDGET.maxPromptBytes);
    expect(grown.promptBytes * 4).toBeLessThan(grownHistoryChars);
    expect(grown.promptBytes - small.promptBytes).toBeLessThan(10_000);

    /* 可选历史只以有界索引进入，省略/截断在 snapshot 与 manifest 如实标注。 */
    expect(small.inputSnapshot.historyIndex?.omittedCount).toBe(0);
    expect(small.inputSnapshot.historyIndex?.truncated).toBe(false);
    expect(grown.inputSnapshot.historyIndex?.entries)
      .toHaveLength(DEFAULT_BUDGET.maxHistoryEntries);
    expect(grown.inputSnapshot.historyIndex?.omittedCount)
      .toBe(4_000 - DEFAULT_BUDGET.maxHistoryEntries);
    expect(grown.inputSnapshot.historyIndex?.truncated).toBe(true);
    const omissionKinds = grown.inputManifest.omissions.map((item) => item.kind);
    expect(omissionKinds).toContain('history-entry-truncated');
    expect(omissionKinds).toContain('history-entry-omitted');
    expect(grown.inputManifest.sources.find((source) => source.kind === 'history-index'))
      .toMatchObject({
        required: false,
        truncated: true,
        selection: `entries[1..${DEFAULT_BUDGET.maxHistoryEntries}] of 4000`,
      });

    /* 当前描述、全部 acceptance 与依赖结果在两个历史规模下始终逐项可读。 */
    for (const result of [small, grown]) {
      expect(result.prompt).toContain('- description: 在网络抖动时按策略重试支付请求。');
      expect(result.prompt).toContain('[1] 重试不超过 3 次');
      expect(result.prompt).toContain('[2] 失败记录审计日志');
      expect(result.prompt).toContain('- task task-0: artifact art-dep-1');
    }

    /* 动态必需内容经不可变引用/摘要提供：正文不内联，引用带 sha256。 */
    expect(grown.prompt).toContain('## Required inputs (must read each before work; verify hash)');
    expect(grown.prompt).toContain(`sha256:${sha256Hex('content:art-in-1')}`);
    expect(grown.prompt).toContain(`sha256:${sha256Hex('content:art-in-2')}`);
    expect(grown.prompt).not.toContain('content:art-in-1');

    /* 历史增长不改变固定输入身份：必需区逐字节一致、各固定来源摘要不变。 */
    expect(grown.prompt.split('## History index')[0])
      .toBe(small.prompt.split('## History index')[0]);
    const hashesOfKind = (result: typeof small, kind: string): string[] =>
      result.inputManifest.sources
        .filter((source) => source.kind === kind)
        .map((source) => source.hash);
    for (const kind of [
      'fixed-guidance', 'task', 'acceptance', 'strategy', 'requirements',
      'dependencies', 'check-policy', 'permissions', 'required-input',
    ]) {
      const grownHashes = hashesOfKind(grown, kind);
      expect(grownHashes.length).toBeGreaterThan(0);
      expect(grownHashes).toEqual(hashesOfKind(small, kind));
    }

    /* 纯确定性：重复构建逐字节一致；估算只标 estimation，不宣称缓存/Token 收益。 */
    const rebuilt = builder.build(grownInput());
    expect(rebuilt.prompt).toBe(grown.prompt);
    expect(rebuilt.digests).toEqual(grown.digests);
    expect(rebuilt.inputManifest).toEqual(grown.inputManifest);
    expect(rebuilt.tokenEstimate.kind).toBe('estimation');
  });

  it('[case:f010-required-budget-structured-failure] 必需输入缺失/超预算整体结构化失败：不静默截断 acceptance、不静默生成空输入', () => {
    /* 必需输入清单缺席 → missing_required_input（fail-closed，不静默按空输入放行）。 */
    let missingError: unknown;
    try {
      makeBuilder().build(makeInput({ requiredInputs: undefined }));
    } catch (thrown) {
      missingError = thrown;
    }
    expectContextError(missingError, 'missing_required_input', 'input.requiredInputs');

    /* acceptance 条目为空 → missing_required_input（不以删减/空验收生成可执行输入）。 */
    let acceptanceError: unknown;
    try {
      makeBuilder().build(
        makeInput({ task: { ...(makeInput().task as object), acceptance: { criteria: [] } } as object }),
      );
    } catch (thrown) {
      acceptanceError = thrown;
    }
    expectContextError(acceptanceError, 'missing_required_input', 'acceptance.criteria');

    /* 超出必需输入预算（引用数量）→ limit_exceeded，携带限制名与实测值。 */
    let refError: unknown;
    try {
      makeBuilder({ maxRequiredInputRefs: 1 }).build(makeInput());
    } catch (thrown) {
      refError = thrown;
    }
    expectContextError(refError, 'limit_exceeded', 'maxRequiredInputRefs');
    if (isContextBuildError(refError)) {
      expect(refError.details).toMatchObject({ limitName: 'maxRequiredInputRefs', limit: 1, measured: 2 });
    }

    /* prompt 预算无法容纳必需内容 → limit_exceeded，消息明确「不删减验收条目」。 */
    let promptError: unknown;
    try {
      makeBuilder({ maxPromptBytes: 200 }).build(makeInput());
    } catch (thrown) {
      promptError = thrown;
    }
    expectContextError(promptError, 'limit_exceeded', 'maxPromptBytes');
    expect((promptError as Error).message).toContain('不删减验收条目');
  });
});
