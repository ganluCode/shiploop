/**
 * F-008 当前配置版本化运行时校验（schemaVersion 1→2 显式升级，纯函数无 I/O）。
 *
 * 覆盖：
 * - payload v2：顶层仅 schemaVersion/strategies/policies，未知键拒绝——任意 JSON
 *   不能冒充执行配置；v1 payload 与 v1 持久化 JSON 不再被当作有效配置
 *   （显式升级，旧版本不被静默误读）；
 * - 政策子集（本阶段确认）：executionLimits（有界数值 + 非敏感环境变量名允许列表）、
 *   verification（requireChecksBeforeDone 布尔）、securityPolicy（isolation 仅
 *   trusted_project）；未知政策段（memoryPolicy/deliveryPolicy 等）拒绝而非静默忽略；
 * - 无效政策数值（0/负数/小数/字符串/超界）返回带字段定位的错误；
 * - 要求强隔离（strong_sandbox 等）明确拒绝，不静默降级为可信项目执行；
 * - 凭据引用卫生：credentialRef/endpointRef 只接受引用字符串；带凭据 URL、
 *   空白/控制字符、超长拒绝；明文 apiKey/token/password 字段拒绝且错误不回显
 *   合成秘密；
 * - scope 校验（global 单例 / project 带稳定 projectId）与策略条目枚举
 *   listStrategyEntries 的字段路径。
 */
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  ENV_ALLOWLIST_MAX_COUNT,
  MAX_ATTEMPTS_PER_TASK_MAX,
  MAX_CONCURRENT_WORKS_MAX,
  SECRET_REFERENCE_MAX_LENGTH,
  SETTINGS_SCHEMA_VERSION,
  TRUSTED_PROJECT_ISOLATION,
  WORK_TIMEOUT_MS_MAX,
  WORK_TIMEOUT_MS_MIN,
  listStrategyEntries,
  parseStoredSettingsPayload,
  validateSettingsPayload,
  validateSettingsScope,
} from '../packages/core/src/ports/settings-schema.ts';
import type { ValidationContext } from '../packages/core/src/ports/validation.ts';

const CONTEXT: ValidationContext = {
  operation: 'Test.operation',
  entity: { type: 'global_settings', id: 'global' },
};

/** 断言抛出带字段定位的 validation 错误，返回错误供脱敏断言。 */
function expectValidationError(fn: () => unknown, field?: string, reason?: string): StorageError {
  try {
    fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(
      true,
    );
    const storageError = error as StorageError;
    expect(storageError.operation).toBe('Test.operation');
    if (field !== undefined) {
      expect(storageError.details?.field).toBe(field);
    }
    if (reason !== undefined) {
      expect(storageError.details?.reason).toBe(reason);
    }
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

describe('F-008 settings schema version upgrade (v2)', () => {
  it('declares schema version 2 as the only supported storage format', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
  });

  it('rejects v1 payloads explicitly (no silent misreading of the old version)', () => {
    expectValidationError(() => validateSettingsPayload({ schemaVersion: 1 }, CONTEXT), 'payload.schemaVersion');
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 1, strategies: {} }, CONTEXT),
      'payload.schemaVersion',
    );
  });

  it('returns corrupt for persisted v1 JSON on the read path', () => {
    try {
      parseStoredSettingsPayload('{"schemaVersion":1,"strategies":{}}', CONTEXT);
      throw new Error('expected corrupt error');
    } catch (error) {
      expect(isStorageError(error, 'corrupt')).toBe(true);
      expect((error as StorageError).details?.reason).toBe('schema_mismatch');
    }
  });

  it('rejects other unknown versions (0, 3, string, fractional, missing)', () => {
    for (const value of [{}, { schemaVersion: 0 }, { schemaVersion: 3 }, { schemaVersion: '2' }, { schemaVersion: 2.5 }]) {
      expectValidationError(() => validateSettingsPayload(value, CONTEXT), 'payload.schemaVersion');
    }
  });

  it('accepts the minimal v2 payload and a full strategies+policies payload as a fresh copy', () => {
    expect(validateSettingsPayload({ schemaVersion: 2 }, CONTEXT)).toEqual({ schemaVersion: 2 });
    const payload = {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-5-mini' } },
        purposeStrategies: { judge: { runtime: 'pi', provider: 'openai', model: 'gpt-5' } },
      },
      policies: {
        executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000, maxAttemptsPerTask: 3 },
        verification: { requireChecksBeforeDone: true },
        securityPolicy: { isolation: 'trusted_project' },
      },
    };
    const validated = validateSettingsPayload(payload, CONTEXT);
    expect(validated).toEqual(payload);
    expect(validated).not.toBe(payload);
    expect(validated.policies).not.toBe(payload.policies);
  });

  it('rejects unknown top-level keys so arbitrary JSON cannot pose as an executable config', () => {
    expectValidationError(() => validateSettingsPayload({ schemaVersion: 2, executionLimits: {} }, CONTEXT), 'payload');
    expectValidationError(() => validateSettingsPayload({ schemaVersion: 2, memoryPolicy: {} }, CONTEXT), 'payload');
    expectValidationError(() => validateSettingsPayload({ schemaVersion: 2, anything: { goes: true } }, CONTEXT), 'payload');
  });
});

describe('F-008 policies subset (non-sensitive policies)', () => {
  it('accepts an empty policies object (no overrides)', () => {
    expect(validateSettingsPayload({ schemaVersion: 2, policies: {} }, CONTEXT)).toEqual({
      schemaVersion: 2,
      policies: {},
    });
  });

  it.each([['memoryPolicy'], ['deliveryPolicy'], ['agentModes'], ['unknownPolicy']])(
    'rejects undefined policy segment %s instead of silently ignoring it',
    (segment) => {
      expectValidationError(
        () => validateSettingsPayload({ schemaVersion: 2, policies: { [segment]: {} } }, CONTEXT),
        'payload.policies',
      );
    },
  );

  it.each([
    ['maxConcurrentWorks zero', { maxConcurrentWorks: 0 }, 'payload.policies.executionLimits.maxConcurrentWorks'],
    ['maxConcurrentWorks over limit', { maxConcurrentWorks: MAX_CONCURRENT_WORKS_MAX + 1 }, 'payload.policies.executionLimits.maxConcurrentWorks'],
    ['maxConcurrentWorks fractional', { maxConcurrentWorks: 1.5 }, 'payload.policies.executionLimits.maxConcurrentWorks'],
    ['maxConcurrentWorks string', { maxConcurrentWorks: '2' }, 'payload.policies.executionLimits.maxConcurrentWorks'],
    ['workTimeoutMs below min', { workTimeoutMs: WORK_TIMEOUT_MS_MIN - 1 }, 'payload.policies.executionLimits.workTimeoutMs'],
    ['workTimeoutMs over max', { workTimeoutMs: WORK_TIMEOUT_MS_MAX + 1 }, 'payload.policies.executionLimits.workTimeoutMs'],
    ['workTimeoutMs negative', { workTimeoutMs: -5 }, 'payload.policies.executionLimits.workTimeoutMs'],
    ['maxAttemptsPerTask zero', { maxAttemptsPerTask: 0 }, 'payload.policies.executionLimits.maxAttemptsPerTask'],
    ['maxAttemptsPerTask over limit', { maxAttemptsPerTask: MAX_ATTEMPTS_PER_TASK_MAX + 1 }, 'payload.policies.executionLimits.maxAttemptsPerTask'],
  ])('rejects invalid policy numeric value: %s', (_label, executionLimits, field) => {
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { executionLimits } }, CONTEXT),
      field,
    );
  });

  it('accepts boundary values of the numeric policy ranges', () => {
    const validated = validateSettingsPayload(
      {
        schemaVersion: 2,
        policies: {
          executionLimits: {
            maxConcurrentWorks: MAX_CONCURRENT_WORKS_MAX,
            workTimeoutMs: WORK_TIMEOUT_MS_MIN,
            maxAttemptsPerTask: 1,
          },
        },
      },
      CONTEXT,
    );
    expect(validated.policies?.executionLimits).toEqual({
      maxConcurrentWorks: MAX_CONCURRENT_WORKS_MAX,
      workTimeoutMs: WORK_TIMEOUT_MS_MIN,
      maxAttemptsPerTask: 1,
    });
  });

  it('rejects unknown keys inside a defined policy segment', () => {
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { executionLimits: { maxTokens: 1000 } } }, CONTEXT),
      'payload.policies.executionLimits',
    );
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { verification: { strict: true } } }, CONTEXT),
      'payload.policies.verification',
    );
  });

  it('accepts requireChecksBeforeDone only as a boolean', () => {
    expect(
      validateSettingsPayload({ schemaVersion: 2, policies: { verification: { requireChecksBeforeDone: false } } }, CONTEXT)
        .policies?.verification,
    ).toEqual({ requireChecksBeforeDone: false });
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { verification: { requireChecksBeforeDone: 'yes' } } }, CONTEXT),
      'payload.policies.verification.requireChecksBeforeDone',
    );
  });

  it('accepts omitted isolation and the only supported trusted_project mode', () => {
    expect(validateSettingsPayload({ schemaVersion: 2, policies: { securityPolicy: {} } }, CONTEXT).policies?.securityPolicy).toEqual({});
    expect(
      validateSettingsPayload({ schemaVersion: 2, policies: { securityPolicy: { isolation: TRUSTED_PROJECT_ISOLATION } } }, CONTEXT)
        .policies?.securityPolicy,
    ).toEqual({ isolation: 'trusted_project' });
  });

  it.each([['strong_sandbox'], ['container'], ['vm'], ['none']])(
    'rejects unsupported isolation %s explicitly instead of silently downgrading to trusted-project execution',
    (isolation) => {
      const error = expectValidationError(
        () => validateSettingsPayload({ schemaVersion: 2, policies: { securityPolicy: { isolation } } }, CONTEXT),
        'payload.policies.securityPolicy.isolation',
        'unsupported_isolation',
      );
      expect(error.message).toContain('trusted_project');
    },
  );

  it('rejects non-object policy segments', () => {
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { executionLimits: 'fast' } }, CONTEXT),
      'payload.policies.executionLimits',
    );
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: 'none' }, CONTEXT),
      'payload.policies',
    );
  });
});

describe('F-008 envAllowlist (non-sensitive env names only, never values)', () => {
  it('accepts ordinary non-sensitive env names and dedupes deterministically', () => {
    const validated = validateSettingsPayload(
      { schemaVersion: 2, policies: { executionLimits: { envAllowlist: ['PATH', 'LANG', 'PATH', 'TZ'] } } },
      CONTEXT,
    );
    expect(validated.policies?.executionLimits?.envAllowlist).toEqual(['PATH', 'LANG', 'TZ']);
  });

  it('allows names that merely contain non-sensitive segments (MONKEY is not a KEY segment)', () => {
    const validated = validateSettingsPayload(
      { schemaVersion: 2, policies: { executionLimits: { envAllowlist: ['MONKEY', 'KEYSTONE_LIGHT'] } } },
      CONTEXT,
    );
    // KEYSTONE_LIGHT 的 KEYSTONE 不是独立 KEY 段，放行；秘密形态按 _ 分段判定。
    expect(validated.policies?.executionLimits?.envAllowlist).toEqual(['MONKEY', 'KEYSTONE_LIGHT']);
  });

  it.each([
    ['GITHUB_TOKEN'],
    ['AWS_SECRET_ACCESS_KEY'],
    ['MY_API_KEY'],
    ['APIKEY'],
    ['APP_PASSWORD'],
    ['CLIENT_CREDENTIALS'],
    ['SSH_AUTH_SOCK'],
    ['PRIVATE_KEY_ID'],
  ])('rejects secret-shaped env name %s', (name) => {
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { executionLimits: { envAllowlist: [name] } } }, CONTEXT),
      'payload.policies.executionLimits.envAllowlist[0]',
      'sensitive_env_name',
    );
  });

  it.each([
    ['starts with digit', ['1PATH']],
    ['contains dash', ['MY-VAR']],
    ['empty name', ['']],
    ['non-string entry', [42]],
  ])('rejects malformed env name: %s', (_label, envAllowlist) => {
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { executionLimits: { envAllowlist } } }, CONTEXT),
    );
  });

  it('rejects an over-long allowlist', () => {
    const envAllowlist = Array.from({ length: ENV_ALLOWLIST_MAX_COUNT + 1 }, (_, index) => `VAR_${index}`);
    expectValidationError(
      () => validateSettingsPayload({ schemaVersion: 2, policies: { executionLimits: { envAllowlist } } }, CONTEXT),
      'payload.policies.executionLimits.envAllowlist',
    );
  });
});

describe('F-008 credential reference hygiene', () => {
  it('accepts opaque reference strings (keyring/keychain style)', () => {
    const payload = {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: {
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          credentialRef: 'keyring://primary',
          endpointRef: 'endpoint/primary',
        },
      },
    };
    expect(validateSettingsPayload(payload, CONTEXT)).toEqual(payload);
  });

  it.each([
    ['credentialRef', 'https://user:synthetic-password-9f27@example.com'],
    ['endpointRef', 'https://ci-bot:synthetic-token-41ab@gateway.internal/v1'],
  ])('rejects a credential-bearing URL in %s without echoing the secret', (fieldName, url) => {
    const error = expectValidationError(
      () =>
        validateSettingsPayload(
          {
            schemaVersion: 2,
            strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y', [fieldName]: url } },
          },
          CONTEXT,
        ),
      `payload.strategies.defaultStrategy.${fieldName}`,
      'credential_in_url',
    );
    expect(error.message).not.toContain('synthetic-password-9f27');
    expect(error.message).not.toContain('synthetic-token-41ab');
    expect(JSON.stringify(error.details)).not.toContain('synthetic-password-9f27');
    expect(JSON.stringify(error.details)).not.toContain('synthetic-token-41ab');
  });

  it.each([
    ['apiKey', 'sk-synthetic-apiKey-77c1'],
    ['token', 'synthetic-token-88d2'],
    ['password', 'synthetic-password-99e3'],
  ])('rejects plaintext secret field %s without echoing the secret value', (key, secret) => {
    const error = expectValidationError(() =>
      validateSettingsPayload(
        { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y', [key]: secret } } },
        CONTEXT,
      ),
    );
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it.each([
    ['whitespace', 'key ring/primary'],
    ['newline', 'cred\nprimary'],
    ['NUL byte', 'cred\0primary'],
    ['too long', 'r'.repeat(SECRET_REFERENCE_MAX_LENGTH + 1)],
    ['empty', '   '],
  ])('rejects an unusable credentialRef: %s', (_label, credentialRef) => {
    expectValidationError(
      () =>
        validateSettingsPayload(
          { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y', credentialRef } } },
          CONTEXT,
        ),
      'payload.strategies.defaultStrategy.credentialRef',
    );
  });

  it('applies the same reference hygiene to modelMap/purposeStrategies/agentOverrides entries', () => {
    expectValidationError(
      () =>
        validateSettingsPayload(
          {
            schemaVersion: 2,
            strategies: {
              modelMap: { high: { runtime: 'pi', provider: 'x', model: 'y', credentialRef: 'https://u:p@h' } },
            },
          },
          CONTEXT,
        ),
      'payload.strategies.modelMap.high.credentialRef',
      'credential_in_url',
    );
  });
});

describe('F-008 settings scope validation', () => {
  it('accepts the global singleton scope', () => {
    expect(validateSettingsScope({ kind: 'global' }, CONTEXT)).toEqual({ kind: 'global' });
  });

  it('accepts a project scope with a stable projectId', () => {
    expect(validateSettingsScope({ kind: 'project', projectId: 'p-1' }, CONTEXT)).toEqual({
      kind: 'project',
      projectId: 'p-1',
    });
  });

  it.each([
    ['unknown kind', { kind: 'workspace' }, 'scope.kind'],
    ['missing kind', {}, 'scope.kind'],
    ['project scope without projectId', { kind: 'project' }, 'scope.projectId'],
    ['project scope with illegal projectId', { kind: 'project', projectId: '../escape' }, 'scope.projectId'],
    ['global scope carrying projectId', { kind: 'global', projectId: 'p-1' }, 'scope.projectId'],
    ['unknown scope key', { kind: 'global', extra: 1 }, 'scope'],
    ['non-object scope', 'global', 'scope'],
  ])('rejects invalid scope: %s', (_label, scope, field) => {
    expectValidationError(() => validateSettingsScope(scope, CONTEXT), field);
  });
});

describe('F-008 strategy entry enumeration', () => {
  it('enumerates every provided strategy entry with its payload field path', () => {
    const payload = validateSettingsPayload(
      {
        schemaVersion: 2,
        strategies: {
          defaultStrategy: { runtime: 'r', provider: 'p', model: 'm' },
          modelMap: { low: { runtime: 'r', provider: 'p', model: 'm-low' } },
          purposeStrategies: { planner: { runtime: 'r', provider: 'p', model: 'm-plan' } },
          agentOverrides: { 'coding-agent': { runtime: 'r', provider: 'p', model: 'm-agent' } },
        },
      },
      CONTEXT,
    );
    const entries = listStrategyEntries(payload.strategies);
    expect(entries.map((entry) => entry.field)).toEqual([
      'payload.strategies.defaultStrategy',
      'payload.strategies.modelMap.low',
      'payload.strategies.purposeStrategies.planner',
      'payload.strategies.agentOverrides.coding-agent',
    ]);
    expect(entries[1]?.strategy.model).toBe('m-low');
  });

  it('returns an empty list when no strategies are provided', () => {
    expect(listStrategyEntries(undefined)).toEqual([]);
    expect(listStrategyEntries({})).toEqual([]);
  });
});
