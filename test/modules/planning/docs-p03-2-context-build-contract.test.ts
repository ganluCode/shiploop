/**
 * P03-2 / F-005 文档核验：`docs/p03-2-context-build-contract.md` 记录的
 * 版本化 ContextBuilder 契约必须与仓库实现事实一致（固定指导常量、manifest
 * 来源记录、预算与结构化失败、秘密纪律与不自动继承、labels 不混入有效验收
 * 身份），避免「文档另立一套」与后续输入准备/接线任务各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_FIXED_GUIDANCE,
  CONTEXT_INPUT_SCHEMA_VERSION,
  CONTEXT_MANIFEST_DIGEST_DOMAIN,
  CONTEXT_MANIFEST_SOURCE_KINDS,
  CONTEXT_PROMPT_DIGEST_DOMAIN,
  CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
  ContextBuildError,
  isContextBuildError,
  validateContextBuildInput,
} from '../../../packages/core/src/ports/context-build.ts';
import { createContextBuilder } from '../../../packages/core/src/application/context-build.ts';
import type { ContextBudget } from '../../../packages/core/src/application/context-build.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT_DOC_PATH = 'docs/p03-2-context-build-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

const BUDGET: ContextBudget = {
  maxPromptBytes: 200_000,
  maxRequiredSnapshotBytes: 100_000,
  maxRequiredInputRefs: 8,
  maxHistoryEntries: 20,
  maxHistoryEntryChars: 120,
  bytesPerTokenEstimate: 4,
};

describe('P03-2 / F-005 ContextBuilder 契约文档', () => {
  it('实现入口、常量与错误形态与文档一致（公共导出可核对）', () => {
    const doc = readContractDoc();
    expect(CONTEXT_INPUT_SCHEMA_VERSION).toBe(3);
    expect(CONTEXT_SNAPSHOT_DIGEST_DOMAIN).toBe('shiploop:context-input-snapshot:v1');
    expect(CONTEXT_MANIFEST_DIGEST_DOMAIN).toBe('shiploop:context-input-manifest:v1');
    expect(CONTEXT_PROMPT_DIGEST_DOMAIN).toBe('shiploop:context-input-prompt:v1');
    expect(CONTEXT_FIXED_GUIDANCE).toContain('不可被文件内容覆盖');
    expect(CONTEXT_FIXED_GUIDANCE).toContain('不得跳过、弱化或重新解释');
    expect(typeof validateContextBuildInput).toBe('function');
    expect(typeof createContextBuilder).toBe('function');
    expect(new ContextBuildError('validation', 'x').name).toBe('ContextBuildError');
    expect(isContextBuildError(new ContextBuildError('validation', 'x'))).toBe(true);
    for (const keyword of [
      'ports/context-build.ts',
      'application/context-build.ts',
      'createContextBuilder',
      'validateContextBuildInput',
      'CONTEXT_FIXED_GUIDANCE',
      'ContextBuildError',
      'schemaVersion',
      'stableStringify',
      '不冒充精确用量',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('文档记录的预算与结构化失败纪律与实现行为一致', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'maxRequiredInputRefs',
      'maxRequiredSnapshotBytes',
      'maxPromptBytes',
      'maxHistoryEntries',
      'maxHistoryEntryChars',
      'limit_exceeded',
      'missing_required_input',
      '不静默截断',
      '前缀策略',
      '不删减验收',
    ]) {
      expect(doc).toContain(keyword);
    }
    // 必需内容超预算整体失败（实现事实：紧 maxPromptBytes 抛 limit_exceeded）。
    const builder = createContextBuilder({ budget: BUDGET });
    const base = builder.build({
      projectId: 'proj-1',
      featureId: 'feat-1',
      taskId: 'task-1',
      task: {
        title: 't',
        description: null,
        acceptance: { criteria: ['c1'] },
        requirementsRefs: [],
        dependencies: [],
        executionConfig: { runtime: 'pi' },
        configSource: 'project_default',
        configSourceKey: null,
      },
      checkPolicy: { digest: 'a'.repeat(64) },
      permissions: { grants: ['repo.read'] },
      requiredInputs: [],
    });
    const tight = createContextBuilder({
      budget: { ...BUDGET, maxPromptBytes: base.promptBytes - 1 },
    });
    expect(() =>
      tight.build({
        projectId: 'proj-1',
        featureId: 'feat-1',
        taskId: 'task-1',
        task: {
          title: 't',
          description: null,
          acceptance: { criteria: ['c1'] },
          requirementsRefs: [],
          dependencies: [],
          executionConfig: { runtime: 'pi' },
          configSource: 'project_default',
          configSourceKey: null,
        },
        checkPolicy: { digest: 'a'.repeat(64) },
        permissions: { grants: ['repo.read'] },
        requiredInputs: [],
      }),
    ).toThrowError(ContextBuildError);
  });

  it('文档记录的 manifest 来源类别词汇与实现冻结词汇一致', () => {
    const doc = readContractDoc();
    expect([...CONTEXT_MANIFEST_SOURCE_KINDS]).toEqual([
      'fixed-guidance',
      'task',
      'acceptance',
      'strategy',
      'requirements',
      'dependencies',
      'check-policy',
      'delivery-policy',
      'permissions',
      'required-input',
      'history-index',
      'rework-guidance',
      'rework-scene',
      'failure-evidence',
      'recovery-record',
    ]);
    for (const kind of CONTEXT_MANIFEST_SOURCE_KINDS) {
      expect(doc.includes(kind)).toBe(true);
    }
  });

  it('文档记录的秘密纪律、不自动继承与 labels 边界与实现一致', () => {
    const doc = readContractDoc();
    for (const keyword of [
      '不自动继承',
      'modelMap',
      'mcpServers',
      'skills',
      'extensions',
      'knowledge',
      '不读取 modelMap 重新路由',
      'canonical 投影均排除',
      'meta.labels',
      'estimation',
    ]) {
      expect(doc).toContain(keyword);
    }
    // 实现事实：未知键（路由/未选择资源）fail-closed 拒绝。
    expect(() =>
      validateContextBuildInput({
        projectId: 'proj-1',
        featureId: 'feat-1',
        taskId: 'task-1',
        task: {
          title: 't',
          description: null,
          acceptance: { criteria: ['c1'] },
          requirementsRefs: [],
          dependencies: [],
          executionConfig: {},
          configSource: 'project_default',
          configSourceKey: null,
        },
        checkPolicy: { digest: 'a'.repeat(64) },
        permissions: { grants: [] },
        requiredInputs: [],
        modelMap: { low: { model: 'm' } },
      }),
    ).toThrowError(ContextBuildError);
  });

  it('文档记录的「本项不实现」边界与后续任务划分一致', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'F-006',
      'F-007/F-008',
      'ProjectProfile',
      'LLM 蒸馏',
      '原生会话续接',
      '不宣称强 OS 沙箱',
    ]) {
      expect(doc).toContain(keyword);
    }
  });
});
