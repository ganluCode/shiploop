/**
 * P03-3 / F-001：预算政策进入现有配置 Schema、合并与 Task 策略快照路径 +
 * 执行授权并发规则 + 持久层不追溯改写。
 *
 * 验收面：
 * - 旧配置（schemaVersion=2 无 maxCodeAttempts）保持可读且语义不变（不静默注入
 *   默认值、maxAttemptsPerTask 仍是总 Attempt 上限）；显式新政策通过；非法字段、
 *   未知键与版本不兼容（v1/v3）拒绝；
 * - 新政策进入现有配置 Schema（settings-schema）与合并（mergeEffectiveSettings：
 *   段级整体覆盖语义保持），不另建配置体系；
 * - Task 策略快照路径（selectTaskStrategy / validateTaskExecutionConfig）：配置了
 *   maxCodeAttempts 即捕获进 executionConfig 副本；未配置不注入字段（使用时按
 *   默认解析）；旧快照（无字段）仍可校验通过；
 * - 读取或修改默认配置不追溯改写既有 Task 输入（真实 SQLite：导入后更新全局
 *   配置，既有 Task execution_config 逐字节不变；新导入捕获新值）；
 * - 旧配置允许保存的并发政策（maxConcurrentWorks 最多 16）不等于执行支持：
 *   执行授权对有效并发大于一明确拒绝（结构化 reason）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MAX_CODE_ATTEMPTS,
  resolveTaskAttemptCaps,
  TASK_MAX_CODE_ATTEMPTS_MAX,
} from '../../../../packages/core/src/ports/execution-budget.ts';
import {
  MAX_ATTEMPTS_PER_TASK_MAX,
  MAX_CONCURRENT_WORKS_MAX,
  parseStoredSettingsPayload,
  SETTINGS_SCHEMA_VERSION,
  validateSettingsPayload,
} from '../../../../packages/core/src/ports/settings-schema.ts';
import { StorageError } from '../../../../packages/core/src/ports/errors.ts';
import type { ValidationContext } from '../../../../packages/core/src/ports/validation.ts';
import { mergeEffectiveSettings } from '../../../../packages/core/src/application/effective-settings.ts';
import {
  assertSingleWorkConcurrencyAuthorization,
  EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT,
  resolveEffectiveMaxConcurrentWorks,
} from '../../../../packages/core/src/application/execution-authorization-policy.ts';
import {
  selectTaskStrategy,
  validateTaskExecutionConfig,
} from '../../../../packages/core/src/application/task-strategy-selection.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAtomicCommandStore } from '../../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../../../../packages/core/src/application/command-service.ts';
import type { CommandService } from '../../../../packages/core/src/application/command-service.ts';
import type { CommandReceipt } from '../../../../packages/core/src/ports/commands.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../../helpers/p02-2/index.ts';

const CONTEXT: ValidationContext = { operation: 'P033BudgetPolicyConfig.test' };

function isStorageValidationError(error: unknown): error is StorageError {
  return error instanceof StorageError && error.kind === 'validation';
}

function expectValidationError(run: () => unknown, field?: string): StorageError {
  try {
    run();
  } catch (error) {
    expect(isStorageValidationError(error), `expected StorageError(validation), got ${String(error)}`).toBe(true);
    const storageError = error as StorageError;
    if (field !== undefined) {
      expect(storageError.details?.field).toBe(field);
    }
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

const CODE_ATTEMPTS_FIELD = 'payload.policies.executionLimits.maxCodeAttempts';

describe('P03-3 / F-001 配置 Schema：旧配置、显式新政策、非法字段与版本不兼容', () => {
  it('旧配置（无 maxCodeAttempts）保持可读：结构原样返回，不注入默认值', () => {
    const legacy = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      policies: {
        executionLimits: {
          maxConcurrentWorks: 1,
          workTimeoutMs: 600_000,
          // 旧字段语义保持：总 Attempt 上限（不是代码尝试上限）。
          maxAttemptsPerTask: 2,
        },
      },
    };
    expect(validateSettingsPayload(legacy, CONTEXT)).toEqual(legacy);
    // 持久化读取路径同样原样（不静默补字段）。
    expect(parseStoredSettingsPayload(JSON.stringify(legacy), CONTEXT)).toEqual(legacy);
  });

  it('显式新政策 maxCodeAttempts 进入现有 executionLimits 段并通过', () => {
    const explicit = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      policies: {
        executionLimits: { maxAttemptsPerTask: 5, maxCodeAttempts: 4 },
      },
    };
    expect(validateSettingsPayload(explicit, CONTEXT)).toEqual(explicit);
  });

  it.each([
    ['zero', 0],
    ['over limit', TASK_MAX_CODE_ATTEMPTS_MAX + 1],
    ['fractional', 1.5],
    ['string', '3'],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', 2 ** 53],
    ['null', null],
  ] as const)('非法 maxCodeAttempts（%s）拒绝：字段定位 executionLimits.maxCodeAttempts', (_label, value) => {
    expectValidationError(
      () =>
        validateSettingsPayload(
          {
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            policies: { executionLimits: { maxCodeAttempts: value } },
          },
          CONTEXT,
        ),
      CODE_ATTEMPTS_FIELD,
    );
  });

  it('executionLimits 未知兄弟键依旧拒绝（不因新字段放宽结构）', () => {
    expectValidationError(
      () =>
        validateSettingsPayload(
          {
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            policies: { executionLimits: { maxCodeAttempts: 3, maxRuntimeStarts: 5 } },
          },
          CONTEXT,
        ),
      'payload.policies.executionLimits',
    );
  });

  it.each([1, 3, SETTINGS_SCHEMA_VERSION + 1] as const)('版本不兼容：schemaVersion=%s 拒绝（v1 持久数据为 corrupt）', (version) => {
    expectValidationError(
      () =>
        validateSettingsPayload(
          { schemaVersion: version, policies: { executionLimits: { maxCodeAttempts: 3 } } },
          CONTEXT,
        ),
      'payload.schemaVersion',
    );
    // 持久化读取路径：结构损坏/版本未知 → corrupt（fail-closed，不静默误读）。
    let storedError: unknown;
    try {
      parseStoredSettingsPayload(
        JSON.stringify({ schemaVersion: version, policies: { executionLimits: { maxCodeAttempts: 3 } } }),
        CONTEXT,
      );
    } catch (error) {
      storedError = error;
    }
    expect(storedError instanceof StorageError).toBe(true);
    expect((storedError as StorageError).kind).toBe('corrupt');
  });
});

describe('P03-3 / F-001 合并路径：新政策沿用段级整体覆盖', () => {
  const scope = (payload: unknown, scopeRevision = 1) => ({ scopeRevision, payload });

  it('项目 executionLimits 段含 maxCodeAttempts：整段替换全局段', () => {
    const merged = mergeEffectiveSettings({
      global: scope({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        policies: { executionLimits: { maxCodeAttempts: 5, maxAttemptsPerTask: 6 } },
      }),
      project: scope({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        policies: { executionLimits: { maxCodeAttempts: 7 } },
      }),
    });
    expect(merged.policies.executionLimits?.value).toEqual({ maxCodeAttempts: 7 });
    expect(merged.policies.executionLimits?.source.kind).toBe('project_default');
  });

  it('项目段未含新字段时不得从全局段内继承（段内不跨来源拼接）', () => {
    const merged = mergeEffectiveSettings({
      global: scope({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        policies: { executionLimits: { maxCodeAttempts: 5 } },
      }),
      project: scope({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        policies: { executionLimits: { maxConcurrentWorks: 2 } },
      }),
    });
    // 项目段整体替换：有效段是项目段本身，全局 maxCodeAttempts 不再生效。
    expect(merged.policies.executionLimits?.value).toEqual({ maxConcurrentWorks: 2 });
    expect(merged.policies.executionLimits?.value).not.toHaveProperty('maxCodeAttempts');
  });

  it('仅全局配置新政策：有效段继承全局（global_default）', () => {
    const merged = mergeEffectiveSettings({
      global: scope({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        policies: { executionLimits: { maxCodeAttempts: 4 } },
      }),
    });
    expect(merged.policies.executionLimits?.value).toEqual({ maxCodeAttempts: 4 });
    expect(merged.policies.executionLimits?.source.sourceKey).toBe('policies.executionLimits');
  });
});

describe('P03-3 / F-001 Task 策略快照路径', () => {
  const STRATEGY = { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' };

  it('配置了 maxCodeAttempts：捕获进 executionConfig 完整副本', () => {
    const selection = selectTaskStrategy({
      global: {
        scopeRevision: 3,
        payload: {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { defaultStrategy: STRATEGY },
          policies: { executionLimits: { maxCodeAttempts: 5 } },
        },
      },
    });
    expect(selection.executionConfig).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      ...STRATEGY,
      maxCodeAttempts: 5,
    });
    // 项目段优先（段级整体覆盖）。
    const projectFirst = selectTaskStrategy({
      global: {
        scopeRevision: 1,
        payload: {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { defaultStrategy: STRATEGY },
          policies: { executionLimits: { maxCodeAttempts: 5 } },
        },
      },
      project: {
        scopeRevision: 2,
        payload: {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          policies: { executionLimits: { maxCodeAttempts: 8 } },
        },
      },
    });
    expect(projectFirst.executionConfig.maxCodeAttempts).toBe(8);
    expect(projectFirst.configSource).toBe('global_default');
  });

  it('未配置 maxCodeAttempts：副本不注入字段（使用时按默认解析，不写死进快照）', () => {
    const selection = selectTaskStrategy({
      global: {
        scopeRevision: 1,
        payload: { schemaVersion: SETTINGS_SCHEMA_VERSION, strategies: { defaultStrategy: STRATEGY } },
      },
    });
    expect(selection.executionConfig).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      ...STRATEGY,
    });
    expect(selection.executionConfig).not.toHaveProperty('maxCodeAttempts');
    // 使用路径解析默认：含首次共三次。
    expect(resolveTaskAttemptCaps({}, CONTEXT).maxCodeAttempts).toBe(DEFAULT_TASK_MAX_CODE_ATTEMPTS);
  });

  it('userOverride 路径同样捕获政策（政策解析与策略来源正交）；无来源时不注入', () => {
    const withPolicy = selectTaskStrategy({
      userOverride: STRATEGY,
      global: {
        scopeRevision: 1,
        payload: {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          policies: { executionLimits: { maxCodeAttempts: 6 } },
        },
      },
    });
    expect(withPolicy.configSource).toBe('user_override');
    expect(withPolicy.executionConfig.maxCodeAttempts).toBe(6);

    const noScopes = selectTaskStrategy({ userOverride: STRATEGY });
    expect(noScopes.executionConfig).not.toHaveProperty('maxCodeAttempts');
  });

  it('快照副本独立：捕获后修改来源配置不改变已生成副本', () => {
    const payload = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      strategies: { defaultStrategy: STRATEGY },
      policies: { executionLimits: { maxCodeAttempts: 5 } },
    };
    const input = { global: { scopeRevision: 1, payload } };
    const first = selectTaskStrategy(input);
    (payload.policies.executionLimits as { maxCodeAttempts: number }).maxCodeAttempts = 9;
    expect(first.executionConfig.maxCodeAttempts).toBe(5);
    expect(selectTaskStrategy(input).executionConfig.maxCodeAttempts).toBe(9);
  });

  it('validateTaskExecutionConfig：旧快照（无字段）通过；显式字段校验范围；非法值拒绝', () => {
    const legacySnapshot = { schemaVersion: SETTINGS_SCHEMA_VERSION, ...STRATEGY };
    expect(validateTaskExecutionConfig(legacySnapshot, 'test.validate')).toEqual(legacySnapshot);
    const withCap = { ...legacySnapshot, maxCodeAttempts: 5 };
    expect(validateTaskExecutionConfig(withCap, 'test.validate')).toEqual(withCap);
    for (const bad of [0, TASK_MAX_CODE_ATTEMPTS_MAX + 1, 1.5, '3', Number.POSITIVE_INFINITY, null]) {
      expectValidationError(
        () => validateTaskExecutionConfig({ ...legacySnapshot, maxCodeAttempts: bad }, 'test.validate'),
        'executionConfig.maxCodeAttempts',
      );
    }
  });
});

describe('P03-3 / F-001 执行授权并发规则（保存政策 ≠ 执行支持）', () => {
  const policiesWith = (maxConcurrentWorks: number) => ({
    executionLimits: {
      value: { maxConcurrentWorks },
      source: { kind: 'project_default', scopeRevision: 1, sourceKey: 'policies.executionLimits' },
    },
  });

  it('有效并发缺省为一（单并发），允许执行授权', () => {
    expect(EFFECTIVE_MAX_CONCURRENT_WORKS_DEFAULT).toBe(1);
    expect(resolveEffectiveMaxConcurrentWorks({})).toEqual({ maxConcurrentWorks: 1, source: 'default' });
    expect(resolveEffectiveMaxConcurrentWorks(policiesWith(1))).toEqual({
      maxConcurrentWorks: 1,
      source: 'project_default',
    });
    expect(() => assertSingleWorkConcurrencyAuthorization(policiesWith(1))).not.toThrow();
    expect(() => assertSingleWorkConcurrencyAuthorization({})).not.toThrow();
  });

  it('有效并发大于一：执行授权明确拒绝（结构化 reason），即便配置合法可保存', () => {
    // 保存面：maxConcurrentWorks=MAX 仍是合法配置（旧配置允许保存）。
    const saved = validateSettingsPayload(
      {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        policies: { executionLimits: { maxConcurrentWorks: MAX_CONCURRENT_WORKS_MAX } },
      },
      CONTEXT,
    );
    expect(saved.policies?.executionLimits?.maxConcurrentWorks).toBe(MAX_CONCURRENT_WORKS_MAX);
    // 执行面：有效并发 > 1 明确拒绝。
    for (const concurrency of [2, MAX_CONCURRENT_WORKS_MAX]) {
      const error = expectValidationError(() => assertSingleWorkConcurrencyAuthorization(policiesWith(concurrency)));
      expect(error.details?.reason).toBe('concurrency_not_supported');
      expect(error.message).toContain('单并发');
    }
  });

  it('全局来源的有效并发同样受限；非法输入 fail-closed 拒绝', () => {
    const fromGlobal = {
      executionLimits: {
        value: { maxConcurrentWorks: 3 },
        source: { kind: 'global_default', scopeRevision: 2, sourceKey: 'policies.executionLimits' },
      },
    };
    expect(resolveEffectiveMaxConcurrentWorks(fromGlobal)).toEqual({
      maxConcurrentWorks: 3,
      source: 'global_default',
    });
    expectValidationError(() => assertSingleWorkConcurrencyAuthorization(fromGlobal));

    expectValidationError(() => resolveEffectiveMaxConcurrentWorks('policies'));
    expectValidationError(() =>
      resolveEffectiveMaxConcurrentWorks({ executionLimits: { value: { maxConcurrentWorks: '2' } } }),
    );
    expectValidationError(() =>
      resolveEffectiveMaxConcurrentWorks({ executionLimits: { value: { maxConcurrentWorks: 0 } } }),
    );
    // 兼容直接传 mergeEffectiveSettings 的 policies 结果。
    const merged = mergeEffectiveSettings({
      global: {
        scopeRevision: 1,
        payload: {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          policies: { executionLimits: { maxConcurrentWorks: 2 } },
        },
      },
    });
    expectValidationError(() => assertSingleWorkConcurrencyAuthorization(merged.policies));
  });
});

/* ---------------------- 持久层：真实 SQLite 不追溯改写 ---------------------- */

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const HASH_A = sha256('p03-3-budget-policy-src');
const HASH_B = sha256('p03-3-budget-policy-req');
const STRATEGY = { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' };

let fixture: CommandsTestFixture | undefined;
afterEach(() => {
  if (fixture) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
  }
  fixture = undefined;
});

function planWithSingleTask(taskId: string, src: string, req: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: `Feature ${taskId}`,
      description: null,
      labels: [],
      sourceRefs: [{ artifactId: src, contentHash: HASH_A }],
    },
    tasks: [
      {
        id: taskId,
        title: `任务 ${taskId}`,
        complexity: null,
        acceptance: { criteria: [`${taskId} 验收`] },
        requirementsRefs: [{ artifactId: req }],
      },
    ],
  };
}

describe('P03-3 / F-001 持久层：读取/修改默认配置不追溯改写既有 Task 输入', () => {
  it('导入捕获当前 maxCodeAttempts；更新全局配置后既有 Task 副本逐字节不变，新 Task 捕获新值', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-p033-f001-' });
    const harness = await fixture.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
    const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => NOW });
    const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs: () => NOW });
    const service: CommandService = createCommandService({
      atomicStore: store,
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog: fixture.capabilityCatalog,
      nowUtcMs: () => NOW,
    });
    const probe = fixture.openProbe();
    const owner = fixture.localOwner();

    const submit = async (payload: Record<string, unknown>, operation: string, extra: Record<string, unknown> = {}) =>
      service.submit(owner, {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation,
        issuedAt: NOW_ISO,
        payload,
        ...extra,
      });
    const completed = async (receipt: Promise<CommandReceipt>) => {
      const resolved = await receipt;
      if (resolved.status !== 'completed') {
        throw new Error(`expected completed receipt, got ${resolved.status}`);
      }
      return resolved;
    };

    const registered = await completed(
      submit(
        {
          repositoryPath: fixture.repoDirA,
          displayName: 'Repo A',
          description: null,
          labels: [],
        },
        'project.register',
        { scope: { kind: 'registration' } },
      ),
    );
    const projectId = ((registered.result as { project: { id: string } }).project).id;

    await completed(
      submit(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { defaultStrategy: STRATEGY },
          policies: { executionLimits: { maxCodeAttempts: 5 } },
        },
        'settings.global.create',
        { scope: { kind: 'global' } },
      ),
    );
    await completed(
      submit({ id: 'phase-1', title: '第一阶段', description: null, labels: [] }, 'phase.create', {
        scope: { kind: 'project', projectId },
      }),
    );

    const artifactIds = { src: '', req: '' };
    const seedArtifact = async (contentHash: string, locatorName: string): Promise<string> => {
      const record = await artifactStore.registerArtifact({
        projectId,
        kind: 'requirement',
        mediaType: 'text/markdown',
        expectedHash: contentHash,
        locator: `artifacts/${locatorName}.md`,
      });
      await artifactStore.transitionArtifact(projectId, record.id, {
        expectedRevision: record.revision,
        outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
      });
      return record.id;
    };
    artifactIds.src = await seedArtifact(HASH_A, 'p033-src');
    artifactIds.req = await seedArtifact(HASH_B, 'p033-req');

    await completed(
      submit(
        { phaseId: 'phase-1', plan: planWithSingleTask('t-first', artifactIds.src, artifactIds.req) },
        'feature.plan.import',
        { scope: { kind: 'project', projectId }, expectedRevision: 1 },
      ),
    );

    const firstConfig = probe.selectOne<{ execution_config: string }>(
      'SELECT execution_config FROM tasks WHERE id = ?',
      ['t-first'],
    )!.execution_config;
    expect(JSON.parse(firstConfig)).toMatchObject({ ...STRATEGY, maxCodeAttempts: 5 });

    // 修改默认配置（新政策值 9 + 并发政策）：读取与写入都不改写既有 Task 输入。
    await completed(
      submit(
        {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          strategies: { defaultStrategy: STRATEGY },
          policies: { executionLimits: { maxCodeAttempts: 9, maxConcurrentWorks: 4 } },
        },
        'settings.global.update',
        { scope: { kind: 'global' }, expectedRevision: 1 },
      ),
    );
    expect(probe.selectOne<{ execution_config: string }>(
      'SELECT execution_config FROM tasks WHERE id = ?',
      ['t-first'],
    )!.execution_config).toBe(firstConfig);

    // 新导入的 Task 按更新后的当前配置捕获新值（不追溯也不冻结未来输入）。
    await completed(
      submit({ id: 'phase-2', title: '第二阶段', description: null, labels: [] }, 'phase.create', {
        scope: { kind: 'project', projectId },
      }),
    );
    await completed(
      submit(
        { phaseId: 'phase-2', plan: planWithSingleTask('t-second', artifactIds.src, artifactIds.req) },
        'feature.plan.import',
        { scope: { kind: 'project', projectId }, expectedRevision: 1 },
      ),
    );
    const secondConfig = probe.selectOne<{ execution_config: string }>(
      'SELECT execution_config FROM tasks WHERE id = ?',
      ['t-second'],
    )!.execution_config;
    expect(JSON.parse(secondConfig)).toMatchObject({ ...STRATEGY, maxCodeAttempts: 9 });

    // 全局配置里保存的并发政策（4 > 1）在授权面被拒（保存 ≠ 执行支持）。
    const merged = mergeEffectiveSettings({
      global: {
        scopeRevision: 2,
        payload: JSON.parse(
          probe.selectOne<{ payload: string }>('SELECT payload FROM global_settings')!.payload,
        ),
      },
    });
    expect(merged.policies.executionLimits?.value.maxConcurrentWorks).toBe(4);
    expectValidationError(() => assertSingleWorkConcurrencyAuthorization(merged.policies));

    await harness.close();
  });
});
