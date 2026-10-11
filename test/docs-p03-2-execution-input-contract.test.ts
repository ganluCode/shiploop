/**
 * P03-2 / F-004 文档核验：`docs/p03-2-execution-input-contract.md` 记录的
 * 执行必需输入采集/读取契约必须与仓库实现事实一致（引用形态、受控源路径
 * 安全、复用 ArtifactPublisher/ArtifactVerifier、预算与秘密纪律、边界），
 * 避免「文档另立一套」与后续 ContextBuilder/输入准备任务各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_INPUT_ARTIFACT_KIND,
  EXECUTION_INPUT_DEFAULT_MEDIA_TYPE,
  EXECUTION_INPUT_LOCATOR_PREFIX,
  EXECUTION_INPUT_PURPOSE_MAX_LENGTH,
  InputSourceError,
  isInputSourceError,
  validateExecutionInputItem,
  validateExecutionInputRef,
} from '../packages/core/src/ports/execution-input.ts';
import { createInputSourceFileReader } from '../packages/core/src/adapters/fs/input-source-files.ts';
import {
  ExecutionInputError,
  createExecutionInputService,
  isExecutionInputError,
} from '../packages/core/src/application/execution-input.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-2-execution-input-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-2 / F-004 执行必需输入契约文档', () => {
  it('引用形态与采集/读取入口在文档中可核对（公共导出与常量一致）', () => {
    const doc = readContractDoc();
    expect(EXECUTION_INPUT_ARTIFACT_KIND).toBe('execution-input');
    expect(EXECUTION_INPUT_LOCATOR_PREFIX).toBe('execution-inputs');
    expect(EXECUTION_INPUT_DEFAULT_MEDIA_TYPE).toBe('application/octet-stream');
    expect(EXECUTION_INPUT_PURPOSE_MAX_LENGTH).toBe(128);
    expect(typeof validateExecutionInputItem).toBe('function');
    expect(typeof validateExecutionInputRef).toBe('function');
    expect(typeof createExecutionInputService).toBe('function');
    expect(typeof createInputSourceFileReader).toBe('function');
    expect(typeof isExecutionInputError).toBe('function');
    expect(typeof isInputSourceError).toBe('function');
    expect(new ExecutionInputError('validation', 'x').name).toBe('ExecutionInputError');
    expect(new InputSourceError('escape', 'op', 'x').name).toBe('InputSourceError');
    for (const keyword of [
      'ExecutionInputRef',
      'captureRequiredInputs',
      'readRequiredInput',
      'InputSourceFileReader',
      'execution-inputs',
      '源文件绝对路径不当最终快照',
      '不静默省略',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('路径安全三层防线与复用边界在文档中可核对', () => {
    const doc = readContractDoc();
    // 复用既有发布/完整性验证用例（不新建制品库）。
    expect(typeof createArtifactPublisher).toBe('function');
    expect(typeof createArtifactVerifier).toBe('function');
    for (const keyword of [
      'realpath',
      'O_NOFOLLOW',
      'ArtifactPublisher',
      'ArtifactVerifier',
      'unknown_root',
      '强 OS 沙箱',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('校验读取失败语义在文档中可核对（corrupt/not_ready/mismatch/ownership）', () => {
    const doc = readContractDoc();
    for (const keyword of ['corrupt', 'not_ready', 'mismatch', 'ownership', '不修补', '不扫描全部历史']) {
      expect(doc).toContain(keyword);
    }
    // 引用一致性核对：被修补引用不放行（validation 形态校验 fail-closed）。
    expect(() =>
      validateExecutionInputRef({ projectId: 'p', artifactId: 'a', contentHash: 'zz' }, 'guard'),
    ).toThrow();
  });

  it('预算与秘密纪律在文档中可核对（显式有限、不含绝对路径或正文）', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'maxItems',
      'maxItemBytes',
      'maxTotalBytes',
      'captureTimeoutMs',
      'readTimeoutMs',
      'rejectUnknownKeys',
      '不含绝对路径或正文内容',
      '凭据只以引用表达',
    ]) {
      expect(doc).toContain(keyword);
    }
  });
});
