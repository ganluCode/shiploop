/**
 * F-001 文档核验：`docs/p03-1-plan-import-contract.md` 记录的 P02 基线、公共端口
 * 复用、计划 payload 契约、DAG 错误定位、planDigest 规范与导入/编辑 CAS 契约必须
 * 与仓库事实一致，避免「文档另立一套」与后续 F-002 ~ F-011 各自发明规则。
 *
 * 定位：F-001 只交付纯校验模块、摘要计算与契约文档（+ 本守护）；SQLite 迁移、
 * 命令注册、查询与 Host/CLI 接入由后续任务增量实现，本文冻结的是目标契约。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_PLAN_SCHEMA_VERSION,
  PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT,
  PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH,
  PLAN_DEPENDENCY_EDGES_MAX_COUNT,
  PLAN_FEATURE_SOURCE_REFS_MAX_COUNT,
  PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
  PLAN_TASKS_MAX_COUNT,
  PLAN_TITLE_MAX_LENGTH,
} from '../packages/core/src/ports/feature-plan.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from '../packages/core/src/ports/commands.ts';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATIONS,
  COMMAND_OPERATION_SPECS,
} from '../packages/core/src/ports/commands.ts';
import { PHASE_CREATED_EVENT_TYPE, FEATURE_PLAN_IMPORTED_EVENT_TYPE, PUBLIC_STATE_EVENT_TYPES } from '../packages/core/src/ports/events.ts';
import {
  PLAN_LIST_CURSOR_PREFIX,
  PLAN_LIST_DEFAULT_LIMIT,
  PLAN_LIST_MAX_LIMIT,
  PLAN_QUERY_OPERATIONS,
} from '../packages/core/src/ports/queries.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import { DESCRIPTION_MAX_LENGTH, LABELS_MAX_COUNT, LABEL_MAX_LENGTH } from '../packages/core/src/ports/validation.ts';
import * as coreEntry from '../packages/core/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-1-plan-import-contract.md';
const contractDocPath = resolve(REPO_ROOT, CONTRACT_DOC_PATH);

describe('F-001 P03-1 计划导入契约文档', () => {
  it('文档存在且记录开工基线核验（P02 放行基线、分支、worktree 与实测命令）', () => {
    expect(existsSync(contractDocPath)).toBe(true);
    const doc = readFileSync(contractDocPath, 'utf-8');
    // P02 放行基线（完整 hash）与执行环境事实。
    expect(doc).toContain('0e76ad8d9ae7a9e03949c8af4bae8e7e236acd56');
    expect(doc).toContain('feat/2026-10-11-17-45-49_p03-1');
    expect(doc).toContain('shiploop-2026-10-11-17-45-49_p03-1');
    expect(doc).toContain('npm run verify');
    expect(doc).toContain('117 test files / 2971 tests passed');
    // 文档明确不是阶段验收报告。
    expect(doc).toContain('不是阶段验收报告');
  });

  it('计划 payload 版本与边界常量与实现一致', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(FEATURE_PLAN_SCHEMA_VERSION).toBe(1);
    expect(doc).toContain(`FEATURE_PLAN_SCHEMA_VERSION = ${FEATURE_PLAN_SCHEMA_VERSION}`);
    expect(doc).toContain(`PLAN_TITLE_MAX_LENGTH = ${PLAN_TITLE_MAX_LENGTH}`);
    expect(doc).toContain(`PLAN_TASKS_MAX_COUNT = ${PLAN_TASKS_MAX_COUNT}`);
    expect(doc).toContain(`PLAN_DEPENDENCY_EDGES_MAX_COUNT = ${PLAN_DEPENDENCY_EDGES_MAX_COUNT}`);
    expect(doc).toContain(`PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT = ${PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT}`);
    expect(doc).toContain(`PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH = ${PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH}`);
    expect(doc).toContain(`PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT = ${PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT}`);
    expect(doc).toContain(`PLAN_FEATURE_SOURCE_REFS_MAX_COUNT = ${PLAN_FEATURE_SOURCE_REFS_MAX_COUNT}`);
    // 复用的既有上限（描述长度与标签规则）在文档中可核对。
    expect(doc).toContain(`DESCRIPTION_MAX_LENGTH = ${DESCRIPTION_MAX_LENGTH}`);
    expect(doc).toContain(`LABEL_MAX_LENGTH = ${LABEL_MAX_LENGTH}`);
    expect(doc).toContain(`LABELS_MAX_COUNT = ${LABELS_MAX_COUNT}`);
  });

  it('版本兼容记录：与线消息版本、配置 payload 版本相互独立', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(doc).toContain(`WIRE_MESSAGE_SCHEMA_VERSION = ${WIRE_MESSAGE_SCHEMA_VERSION}`);
    expect(doc).toContain(`SETTINGS_SCHEMA_VERSION = ${SETTINGS_SCHEMA_VERSION}`);
    expect(doc).toContain('不静默降级');
  });

  it('DAG 错误清单与节点定位规则在文档中逐项可核对', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    for (const keyword of ['重复 ID', '缺依赖', '自依赖', '重复依赖', '环', '跨 Feature']) {
      expect(doc).toContain(keyword);
    }
    // 错误带字段或节点定位且脱敏。
    expect(doc).toContain('字段或节点定位');
    expect(doc).toContain('脱敏');
  });

  it('CAS 与归属契约：expectedRevision 唯一权威来源、创建/更新区别、单一 CAS 权威', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(doc).toContain('expectedRevision');
    expect(doc).toContain('信封');
    expect(doc).toContain('唯一权威来源');
    expect(doc).toContain('Feature 聚合');
    expect(doc).toContain('不建立两个 CAS 权威');
    // 归属与引用存在性留给事务提交重核。
    expect(doc).toContain('事务提交重核');
    // planDigest 不是 CAS 依据。
    expect(doc).toContain('不是 CAS');
  });

  it('摘要规范与草稿语义在文档中可核对', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(doc).toContain('planDigest');
    expect(doc).toContain('顺序');
    expect(doc).toContain('纯标签');
    expect(doc).toContain('不可执行');
    expect(doc).toContain('不生成 Run');
  });

  it('契约模块经 Core 公共入口导出（不另立私有入口）', () => {
    expect(coreEntry.FEATURE_PLAN_SCHEMA_VERSION).toBe(FEATURE_PLAN_SCHEMA_VERSION);
    expect(typeof coreEntry.validateFeaturePlanInput).toBe('function');
    expect(typeof coreEntry.computeFeaturePlanDigest).toBe('function');
    expect(typeof coreEntry.canonicalFeaturePlanBusinessJson).toBe('function');
  });

  it('F-004 Phase 创建命令定案与实现同源（文档、命令白名单、能力位与事件白名单不漂移）', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(doc).toContain('phase.create');
    expect(doc).toContain('phase.write');
    expect(doc).toContain('phase.created');
    expect(doc).toContain('phase_already_exists');
    expect(doc).toContain('6.4');
    // 文档定案与实现逐项一致（不另立第二套）。
    expect(COMMAND_OPERATIONS).toContain('phase.create');
    expect(COMMAND_OPERATION_SPECS['phase.create']).toEqual({
      scopeKind: 'project',
      mutation: 'create',
      capability: 'phase.write',
    });
    expect(APP_CAPABILITIES).toContain('phase.write');
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(PHASE_CREATED_EVENT_TYPE);
    expect(PHASE_CREATED_EVENT_TYPE).toBe('phase.created');
  });

  it('F-005 计划导入命令定案与实现同源（文档、命令/能力/事件白名单与 CAS 语义不漂移）', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(doc).toContain('feature.plan.import');
    expect(doc).toContain('feature.plan.imported');
    expect(doc).toContain('task_already_exists');
    expect(doc).toContain('artifact_not_usable');
    expect(doc).toContain('artifact_content_hash_mismatch');
    expect(doc).toContain('no_strategy_match');
    expect(doc).toContain('6.5');
    expect(doc).toContain('9.7');
    // 文档定案与实现逐项一致（不另立第二套）：信封 expectedRevision 指向 Phase 聚合。
    expect(COMMAND_OPERATIONS).toContain('feature.plan.import');
    expect(COMMAND_OPERATION_SPECS['feature.plan.import']).toEqual({
      scopeKind: 'project',
      mutation: 'update',
      capability: 'feature.plan.import',
    });
    expect(APP_CAPABILITIES).toContain('feature.plan.import');
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(FEATURE_PLAN_IMPORTED_EVENT_TYPE);
    expect(FEATURE_PLAN_IMPORTED_EVENT_TYPE).toBe('feature.plan.imported');
    expect(typeof coreEntry.submitFeaturePlanImport).toBe('function');
    expect(coreEntry.FEATURE_PLAN_IMPORT_OPERATION).toBe('feature.plan.import');
  });

  it('F-006 计划查询面定案与实现同源（文档、查询操作清单、分页/游标常量与错误纪律不漂移）', () => {
    const doc = readFileSync(contractDocPath, 'utf-8');
    expect(doc).toContain('6.6');
    expect(doc).toContain('plcur_v1_');
    expect(doc).toContain('plan_entity_not_found');
    expect(doc).toContain('invalid_cursor');
    expect(doc).toContain('no_tasks');
    expect(doc).toContain('plan_not_approved');
    // 文档定案与实现逐项一致（不另立第二套）。
    expect([...PLAN_QUERY_OPERATIONS]).toEqual([
      'phases.list',
      'phases.get',
      'features.list',
      'features.get',
      'tasks.list',
      'tasks.get',
    ]);
    expect(PLAN_LIST_DEFAULT_LIMIT).toBe(50);
    expect(PLAN_LIST_MAX_LIMIT).toBe(200);
    expect(PLAN_LIST_CURSOR_PREFIX).toBe('plcur_v1_');
    for (const operation of PLAN_QUERY_OPERATIONS) {
      expect(doc).toContain(operation);
    }
    // 能力位复用 project.read（不新增能力位）。
    expect(APP_CAPABILITIES).not.toContain('plan.read');
    expect(typeof coreEntry.encodePlanListCursor).toBe('function');
    expect(typeof coreEntry.decodePlanListCursor).toBe('function');
    expect(typeof coreEntry.validatePlanListFilter).toBe('function');
  });
});
