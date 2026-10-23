/**
 * P05-1 / F-001 文档核验：`docs/p05-1-planning-candidate-contract.md` 记录的
 * 一次性规划候选契约必须与仓库实现事实一致（请求/候选纯数据契约、verification
 * 引用边界、四类摘要区分、单候选与人工决策边界、测试候选操作身份区分），
 * 避免「文档另立一套」与后续接线任务（F-002 起）各自发明规则。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORK_TOOL_OPERATION_SPECS } from '../../../packages/core/src/ports/commands.ts';
import { EXECUTION_RUN_PURPOSE } from '../../../packages/core/src/ports/execution-start.ts';
import {
  PLANNING_CANDIDATE_DIGEST_DOMAIN,
  PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS,
  PLANNING_CANDIDATE_SCHEMA_VERSION,
  PLANNING_CANDIDATE_SUBMIT_OPERATION,
  PLANNING_INPUT_DIGEST_DOMAIN,
  PLANNING_REQUEST_SCHEMA_VERSION,
  PLANNING_RUNTIME_IDENTITY_PURPOSE,
  PLANNING_RUN_PURPOSE,
  PLANNING_TASK_KIND,
} from '../../../packages/core/src/ports/planning-candidates.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT_DOC_PATH = 'docs/p05-1-planning-candidate-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('P05-1 / F-001 规划候选契约文档', () => {
  it('文档存在且冻结模块常量（版本/领域前缀/身份常量/操作身份）', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'schemaVersion=1',
      String(PLANNING_REQUEST_SCHEMA_VERSION),
      String(PLANNING_CANDIDATE_SCHEMA_VERSION),
      PLANNING_INPUT_DIGEST_DOMAIN,
      PLANNING_CANDIDATE_DIGEST_DOMAIN,
      PLANNING_CANDIDATE_SUBMIT_OPERATION,
    ]) {
      expect(doc).toContain(keyword);
    }
    // 身份常量的取值在文档的 Run/Task/Runtime 身份章节可核对。
    expect(doc).toContain(`Run.purpose=${PLANNING_RUN_PURPOSE}`);
    expect(doc).toContain(`Task.kind=${PLANNING_TASK_KIND}`);
    expect(doc).toContain(`Runtime identity.purpose=${PLANNING_RUNTIME_IDENTITY_PURPOSE}`);
  });

  it('Run/Task/Runtime 身份区分与编码执行用途不混淆', () => {
    const doc = readContractDoc();
    expect(PLANNING_RUN_PURPOSE).toBe('plan');
    expect(PLANNING_TASK_KIND).toBe('planning');
    expect(PLANNING_RUNTIME_IDENTITY_PURPOSE).toBe('work');
    expect(EXECUTION_RUN_PURPOSE).toBe('execute');
    expect(EXECUTION_RUN_PURPOSE).not.toBe(PLANNING_RUN_PURPOSE);
    for (const keyword of ['Run.purpose', 'Task.kind', 'identity.purpose']) {
      expect(doc).toContain(keyword);
    }
  });

  it('四类摘要区分与批准依据失效规则在文档中可核对', () => {
    const doc = readContractDoc();
    for (const keyword of [
      'contentHash',
      'candidateDigest',
      'planDigest',
      'checkPolicyDigest',
      'inputDigest',
      'candidate_changed',
      'input_changed',
      'plan_changed',
      'check_policy_changed',
    ]) {
      expect(doc).toContain(keyword);
    }
  });

  it('verification 引用边界：受信检查/模块与影响范围；执行语义字段冻结拒绝清单一致', () => {
    const doc = readContractDoc();
    for (const keyword of ['checkRefs', 'moduleRefs', 'impactScope', '受信检查', '影响范围']) {
      expect(doc).toContain(keyword);
    }
    for (const field of PLANNING_CANDIDATE_FORBIDDEN_EXECUTION_FIELDS) {
      expect(doc).toContain(field);
      expect(typeof field).toBe('string');
    }
  });

  it('实施边界在文档中冻结：单候选、人工决策、拒绝不重写、批准原子应用且不自动编码', () => {
    const doc = readContractDoc();
    for (const keyword of [
      '仅发布一个可审批候选',
      '人工',
      '拒绝',
      '原子',
      '不自动编码',
      '空 Task 草稿',
      'feature.plan.import',
      'candidate.submit',
      '执行期',
      '不扩展',
    ]) {
      expect(doc).toContain(keyword);
    }
    // 既有 candidate.submit 仍表示测试候选（工作工具操作身份未改变）。
    expect(WORK_TOOL_OPERATION_SPECS['candidate.submit']).toEqual({
      scopeKind: 'project',
      mutation: 'create',
      capability: 'project.read',
    });
    expect(PLANNING_CANDIDATE_SUBMIT_OPERATION).not.toBe('candidate.submit');
  });
});
