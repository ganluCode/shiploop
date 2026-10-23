/**
 * P05-1 / F-002 规划用途策略选择（purposeStrategies.planner）纯函数测试。
 *
 * 覆盖（对应验收标准 4）：
 * - 按用户已批准配置的 purposeStrategies.planner 选择完整用途策略及来源：项目
 *   条目整体替换全局条目（不跨来源拼接 runtime/provider/model）；来源说明
 *   project_default / global_default + purposeStrategies.planner；
 * - 无用途条目时按 defaultStrategy 受控回退：整体复制完整策略并记录来源键
 *   defaultStrategy（区分回退与用途命中）；
 * - 无任何可用条目（purpose 与 default 均缺）即 no_strategy_match 明确拒绝，
 *   不注入任何默认厂商/模型；
 * - 用途选择不取 modelMap 的编码复杂度路由：只配置 modelMap（无 purpose、无
 *   default）同样拒绝；输入携带 complexity / userOverride 是未知键（用途面不
 *   开编码路由与覆盖通道）；
 * - 沿用有效配置合并与完整条目校验：无效来源 payload（未知版本/未知键/不完整
 *   条目/秘密正文字段）带字段定位拒绝，不静默降级；
 * - 副本独立与不追溯：输出为全新独立副本（输入对象后续变化不改变副本）；默认
 *   配置变化后重新选择产生新副本，但不改写既有副本对象（持久副本由存储测试
 *   覆盖重开库一致性）；
 * - 模块源码不硬编码厂商/模型字面量（输出严格来自被选中的配置条目）。
 *
 * 纯函数测试：无 I/O、无数据库、无模型调用。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLANNING_DEFAULT_STRATEGY_FALLBACK_SOURCE_KEY,
  PLANNING_PURPOSE_STRATEGY_KEY,
  PLANNING_PURPOSE_STRATEGY_SOURCE_KEY,
  selectPlanningPurposeStrategy,
} from '../../../packages/core/src/application/task-strategy-selection.ts';
import { SETTINGS_SCHEMA_VERSION } from '../../../packages/core/src/ports/settings-schema.ts';
import { StorageError, isStorageError } from '../../../packages/core/src/ports/errors.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SELECTION_MODULE_PATH = resolve(
  REPO_ROOT,
  'packages/core/src/application/task-strategy-selection.ts',
);

const GLOBAL_REVISION = 3;
const PROJECT_REVISION = 7;

const GLOBAL_DEFAULT = {
  runtime: 'runtime-g',
  provider: 'provider-g',
  model: 'model-g',
  credentialRef: 'cred/global-default',
};

function globalScope(strategies: Record<string, unknown> = { defaultStrategy: GLOBAL_DEFAULT }) {
  return {
    scopeRevision: GLOBAL_REVISION,
    payload: { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies },
  };
}

function projectScope(strategies: Record<string, unknown>) {
  return {
    scopeRevision: PROJECT_REVISION,
    payload: { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies },
  };
}

const PLANNER_GLOBAL = {
  runtime: 'runtime-plan-g',
  provider: 'provider-plan-g',
  model: 'model-plan-g',
  endpointRef: 'endpoint/global-planner',
};

const PLANNER_PROJECT = {
  runtime: 'runtime-plan-p',
  provider: 'provider-plan-p',
  model: 'model-plan-p',
  credentialRef: 'cred/project-planner',
};

describe('P05-1 F-002 planning purpose strategy selection', () => {
  it('[case:purpose-entry-project] 项目 purposeStrategies.planner 整体条目命中并记录来源', () => {
    const selection = selectPlanningPurposeStrategy({
      global: globalScope({ defaultStrategy: GLOBAL_DEFAULT, purposeStrategies: { planner: PLANNER_GLOBAL } }),
      project: projectScope({ purposeStrategies: { planner: PLANNER_PROJECT } }),
    });
    expect(selection.strategy).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runtime: 'runtime-plan-p',
      provider: 'provider-plan-p',
      model: 'model-plan-p',
      credentialRef: 'cred/project-planner',
    });
    expect(selection.configSource).toBe('project_default');
    expect(selection.configSourceKey).toBe(PLANNING_PURPOSE_STRATEGY_SOURCE_KEY);
  });

  it('[case:purpose-entry-global] 全局用途条目命中（项目未覆盖用途键）', () => {
    const selection = selectPlanningPurposeStrategy({
      global: globalScope({ purposeStrategies: { planner: PLANNER_GLOBAL } }),
      project: projectScope({ defaultStrategy: { runtime: 'p', provider: 'p', model: 'p' } }),
    });
    expect(selection.strategy).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runtime: 'runtime-plan-g',
      provider: 'provider-plan-g',
      model: 'model-plan-g',
      endpointRef: 'endpoint/global-planner',
    });
    expect(selection.configSource).toBe('global_default');
    expect(selection.configSourceKey).toBe(PLANNING_PURPOSE_STRATEGY_SOURCE_KEY);
  });

  it('[case:default-fallback] 无用途条目时按 defaultStrategy 受控回退并记录来源', () => {
    const selection = selectPlanningPurposeStrategy({
      global: globalScope({ defaultStrategy: GLOBAL_DEFAULT, purposeStrategies: { judge: { runtime: 'j', provider: 'j', model: 'j' } } }),
      project: projectScope({ modelMap: { low: { runtime: 'p-low', provider: 'p', model: 'p-low' } } }),
    });
    // 整体复制 defaultStrategy，不取 modelMap、不拼接字段。
    expect(selection.strategy).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      runtime: 'runtime-g',
      provider: 'provider-g',
      model: 'model-g',
      credentialRef: 'cred/global-default',
    });
    expect(selection.configSource).toBe('global_default');
    expect(selection.configSourceKey).toBe(PLANNING_DEFAULT_STRATEGY_FALLBACK_SOURCE_KEY);
  });

  it('[case:no-strategy-match] 无任何可用条目明确拒绝（不注入默认厂商/模型）', () => {
    const attempt = () =>
      selectPlanningPurposeStrategy({
        global: globalScope({ modelMap: { low: { runtime: 'g-low', provider: 'g', model: 'g-low' } } }),
        project: projectScope({ purposeStrategies: { judge: { runtime: 'j', provider: 'j', model: 'j' } } }),
      });
    expect(attempt).toThrow(StorageError);
    try {
      attempt();
    } catch (error) {
      expect(isStorageError(error)).toBe(true);
      expect(error).toMatchObject({ kind: 'validation' });
      expect((error as StorageError).details).toMatchObject({ reason: 'no_strategy_match', purpose: 'planner' });
    }
  });

  it('[case:no-modelmap-routing] 用途选择不取 modelMap 复杂度路由；complexity/userOverride 是未知键', () => {
    // 只配置 modelMap（无 purpose、无 default）→ 拒绝（证明没有复杂度路由）。
    expect(() =>
      selectPlanningPurposeStrategy({
        global: globalScope({ modelMap: { low: { runtime: 'g-low', provider: 'g', model: 'g-low' } } }),
      }),
    ).toThrow(StorageError);
    // 输入携带 complexity 是用途面未知键。
    expect(() =>
      selectPlanningPurposeStrategy({
        global: globalScope({ defaultStrategy: GLOBAL_DEFAULT }),
        complexity: 'low',
      }),
    ).toThrow(/complexity|未知/i);
    // 输入携带 userOverride 同样是用途面未知键（无隐式指定厂商/模型通道）。
    expect(() =>
      selectPlanningPurposeStrategy({
        global: globalScope({ defaultStrategy: GLOBAL_DEFAULT }),
        userOverride: { runtime: 'u', provider: 'u', model: 'u' },
      }),
    ).toThrow(/userOverride|未知/i);
  });

  it('[case:invalid-config-rejected] 无效配置合并/完整条目校验带字段定位拒绝，不静默降级', () => {
    // 不完整用途条目（缺 model）：mergeEffectiveSettings 完整条目校验拒绝。
    expect(() =>
      selectPlanningPurposeStrategy({
        project: projectScope({ purposeStrategies: { planner: { runtime: 'p', provider: 'p' } } }),
      }),
    ).toThrow(StorageError);
    // 秘密正文字段：完整条目校验拒绝（不回显秘密正文）。
    expect(() =>
      selectPlanningPurposeStrategy({
        project: projectScope({ purposeStrategies: { planner: { runtime: 'p', provider: 'p', model: 'm', apiKey: 'sk-secret' } } }),
      }),
    ).toThrow(StorageError);
    // 未知 schemaVersion：合并层拒绝。
    expect(() =>
      selectPlanningPurposeStrategy({
        project: { scopeRevision: 1, payload: { schemaVersion: 99, strategies: {} } },
      }),
    ).toThrow(StorageError);
    // scopeRevision 非法：拒绝（不是忽略来源）。
    expect(() =>
      selectPlanningPurposeStrategy({
        project: { scopeRevision: 0, payload: { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: {} } },
      }),
    ).toThrow(StorageError);
  });

  it('[case:copy-independence] 副本独立：输入对象后续变化不改变已生成副本；重选不共享引用', () => {
    const planner = { ...PLANNER_PROJECT };
    const input = { project: projectScope({ purposeStrategies: { planner } }) };
    const first = selectPlanningPurposeStrategy(input);
    planner.model = 'mutated-model';
    (input.project.payload.strategies as Record<string, unknown>).purposeStrategies = {};
    expect(first.strategy.model).toBe('model-plan-p');
    expect(first.strategy).not.toBe(planner);

    const second = selectPlanningPurposeStrategy({
      project: projectScope({ purposeStrategies: { planner: PLANNER_PROJECT } }),
    });
    expect(second).toEqual(first);
    expect(second.strategy).not.toBe(first.strategy);
  });

  it('[case:config-change-not-retroactive] 默认配置变化产生新副本，但不改写既有副本', () => {
    const before = selectPlanningPurposeStrategy({
      global: globalScope({ purposeStrategies: { planner: PLANNER_GLOBAL } }),
    });
    const frozenCopy = before.strategy;
    const after = selectPlanningPurposeStrategy({
      global: globalScope({ purposeStrategies: { planner: { runtime: 'runtime-plan-2', provider: 'provider-2', model: 'model-2' } } }),
    });
    expect(after.strategy.model).toBe('model-2');
    expect(frozenCopy.model).toBe('model-plan-g');
    expect(after.strategy).not.toEqual(frozenCopy);
  });

  it('[case:no-hardcoded-vendor] 选择模块源码不硬编码厂商/模型字面量', () => {
    const source = readFileSync(SELECTION_MODULE_PATH, 'utf8');
    // 用途键是配置键，不是厂商；输出 runtime/provider/model 严格来自配置条目。
    expect(source).toContain(`PLANNING_PURPOSE_STRATEGY_KEY = 'planner'`);
    expect(source).not.toMatch(/'(anthropic|openai|claude-|gpt-)[-a-z0-9.]*'/i);
  });

  it('[case:purpose-key-constant] 冻结用途键常量与来源键词汇', () => {
    expect(PLANNING_PURPOSE_STRATEGY_KEY).toBe('planner');
    expect(PLANNING_PURPOSE_STRATEGY_SOURCE_KEY).toBe('purposeStrategies.planner');
    expect(PLANNING_DEFAULT_STRATEGY_FALLBACK_SOURCE_KEY).toBe('defaultStrategy');
  });
});
