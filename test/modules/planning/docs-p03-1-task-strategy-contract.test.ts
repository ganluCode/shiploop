/**
 * F-003 文档核验：`docs/p03-1-task-strategy-selection.md` 记录的 Task 策略副本与
 * 来源选择契约必须与仓库实现事实一致（选择/回退优先级、来源与 sourceKey 词汇、
 * executionConfig 副本形态、拒绝矩阵、合法 ≠ 可执行、范围边界与张力记录），
 * 避免「文档另立一套」与后续 F-005/F-011 各自发明规则。
 *
 * 定位：契约文档 + 本守护只冻结纯选择契约；导入事务、Task 策略编辑、凭据解析与
 * Attempt 快照按各自任务验收。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TASK_STRATEGY_CONFIG_SOURCES,
  TASK_STRATEGY_SELECTION_OPERATION,
  TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY,
} from '../../../packages/core/src/application/task-strategy-selection.ts';
import { SETTINGS_SCHEMA_VERSION } from '../../../packages/core/src/ports/settings-schema.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT_DOC_PATH = 'docs/p03-1-task-strategy-selection.md';
const contractDocPath = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
const PLAN_CONTRACT_DOC_PATH = resolve(REPO_ROOT, 'docs/p03-1-plan-import-contract.md');

function readContractDoc(): string {
  expect(existsSync(contractDocPath)).toBe(true);
  return readFileSync(contractDocPath, 'utf-8');
}

describe('F-003 Task 策略副本与来源选择契约文档', () => {
  it('选择与回退优先级在文档中可核对（userOverride > 复杂度条目 > defaultStrategy）', () => {
    const doc = readContractDoc();
    expect(doc).toContain('userOverride');
    expect(doc).toContain('modelMap');
    expect(doc).toContain('defaultStrategy');
    expect(doc).toContain('回退');
    expect(doc).toContain('no_strategy_match');
    // 复杂度缺省/无对应条目与「不猜模型」的回退语义。
    expect(doc).toContain('不猜');
  });

  it('来源词汇、sourceKey 与实现常量一致', () => {
    const doc = readContractDoc();
    for (const source of TASK_STRATEGY_CONFIG_SOURCES) {
      expect(doc).toContain(source);
    }
    expect(TASK_STRATEGY_CONFIG_SOURCES).toEqual(['project_default', 'global_default', 'user_override']);
    expect(doc).toContain('modelMap.low');
    expect(doc).toContain(TASK_STRATEGY_USER_OVERRIDE_SOURCE_KEY);
    expect(doc).toContain(TASK_STRATEGY_SELECTION_OPERATION);
  });

  it('executionConfig 副本形态与拒绝矩阵在文档中可核对', () => {
    const doc = readContractDoc();
    expect(doc).toContain('execution_config');
    expect(doc).toContain(`schemaVersion=2 标记`);
    expect(doc).toContain(`SETTINGS_SCHEMA_VERSION = ${SETTINGS_SCHEMA_VERSION}`);
    for (const keyword of [
      '缺任一必需策略字段',
      '不完整覆盖',
      'credential_in_url',
      '秘密正文',
      '未知字段',
    ]) {
      expect(doc).toContain(keyword);
    }
    // 错误不回显秘密正文。
    expect(doc).toContain('不回显');
  });

  it('合法 ≠ 可执行、来源仅作解释与范围边界在文档中可核对', () => {
    const doc = readContractDoc();
    expect(doc).toContain('合法 ≠ 可执行');
    expect(doc).toContain('来源仅作解释');
    expect(doc).toContain('assessSettingsConfiguration');
    for (const keyword of ['Task 策略编辑', '重新应用默认', '凭据解析', 'Attempt 快照', 'agentOverrides']) {
      expect(doc).toContain(keyword);
    }
  });

  it('张力记录与请求核对：回退优先级等实施契约值明确标注', () => {
    const doc = readContractDoc();
    expect(doc).toContain('张力记录');
    expect(doc).toContain('请求核对');
    expect(doc).toContain('core-design/06');
    expect(doc).toContain('core-design/11');
  });

  it('计划导入契约登记 F-003 定案（策略副本与来源不参与 planDigest）', () => {
    const planDoc = readFileSync(PLAN_CONTRACT_DOC_PATH, 'utf-8');
    expect(planDoc).toContain('F-003 定案');
    expect(planDoc).toContain('不参与');
    expect(planDoc).toContain('task-strategy-selection');
  });
});
