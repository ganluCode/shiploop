/**
 * F-002 存储契约的运行时校验层回归（纯函数，不涉及持久化）。
 *
 * 覆盖（P01-2 / F-002）：
 * - 结构化错误 StorageError 携带 kind / operation / 适用实体身份 / details；
 * - 校验原语：稳定 ID、SHA-256 摘要、expectedRevision（非正整数拒绝）、
 *   标签数组（trim + Unicode NFC + ASCII 小写 + 实体內去重，非法数组拒绝）、
 *   受控逻辑 locator（绝对路径 / 父目录穿越 / 空段 / 反斜杠 / NUL 拒绝）；
 * - 当前配置 Payload Schema（schemaVersion=2 的明确限定结构，F-008 显式升级）：
 *   有效最小/完整样例可往返；缺字段、类型错误、未知 schemaVersion、未知键、
 *   不完整策略条目（缺 runtime/provider/model）均拒绝——任意对象不能冒充可执行策略；
 * - 读取路径 parseStoredSettingsPayload：损坏 JSON 与未知格式返回 corrupt 而非有效配置；
 * - 迁移记录描述符：版本正整数 + SHA-256 校验摘要。
 *
 * 纯校验层不做任何 I/O：校验失败在持久化之前抛出，天然无持久化副作用；
 * 持久化无副作用的组合断言见 test/storage-contracts.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  normalizeLabels,
  validateArtifactLocator,
  validateExpectedRevision,
  validateSha256Digest,
  validateStableId,
} from '../packages/core/src/ports/validation.ts';
import type { ValidationContext } from '../packages/core/src/ports/validation.ts';
import {
  SETTINGS_SCHEMA_VERSION,
  parseStoredSettingsPayload,
  validateSettingsPayload,
} from '../packages/core/src/ports/settings-schema.ts';
import { validateMigrationDescriptor } from '../packages/core/src/ports/migrations.ts';

const VALID_HASH = 'a'.repeat(64);
const CONTEXT: ValidationContext = {
  operation: 'Test.operation',
  entity: { type: 'project', id: 'p-1' },
};

/** 断言抛出的正是带操作与实体身份的 validation 错误，并返回该错误供进一步断言。 */
function expectValidationError(fn: () => unknown, field?: string): StorageError {
  try {
    fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(
      true,
    );
    const storageError = error as StorageError;
    expect(storageError.operation).toBe('Test.operation');
    expect(storageError.entity).toEqual({ type: 'project', id: 'p-1' });
    expect(typeof storageError.details?.reason).toBe('string');
    if (field !== undefined) {
      expect(storageError.details?.field).toBe(field);
    }
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

describe('F-002 structured storage errors', () => {
  it('carries kind, operation, entity identity and structured details', () => {
    const error = new StorageError('conflict', 'StateStore.updateProjectSettings', 'revision 冲突', {
      entity: { type: 'project_settings', id: 's-1', projectId: 'p-1' },
      details: { expectedRevision: 3, actualRevision: 4 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StorageError');
    expect(error.kind).toBe('conflict');
    expect(error.operation).toBe('StateStore.updateProjectSettings');
    expect(error.entity).toEqual({ type: 'project_settings', id: 's-1', projectId: 'p-1' });
    expect(error.details).toEqual({ expectedRevision: 3, actualRevision: 4 });
    expect(isStorageError(error)).toBe(true);
    expect(isStorageError(error, 'conflict')).toBe(true);
    expect(isStorageError(error, 'validation')).toBe(false);
  });

  it('rejects foreign errors and non-error values', () => {
    expect(isStorageError(new Error('plain'))).toBe(false);
    expect(isStorageError({ kind: 'conflict' })).toBe(false);
    expect(isStorageError(undefined)).toBe(false);
  });
});

describe('F-002 validation primitives', () => {
  it('accepts a well-formed lowercase sha256 hex digest', () => {
    expect(validateSha256Digest(VALID_HASH, CONTEXT, 'expectedHash')).toBe(VALID_HASH);
  });

  it.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex characters', 'g'.repeat(64)],
    ['non-string', 42],
    ['empty string', ''],
  ])('rejects an illegal digest: %s', (_label, value) => {
    expectValidationError(() => validateSha256Digest(value, CONTEXT, 'expectedHash'), 'expectedHash');
  });

  it.each([[1], [2], [9_999]])('accepts positive integer expectedRevision %d', (value) => {
    expect(validateExpectedRevision(value, CONTEXT)).toBe(value);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ['3'], [null], [true], [undefined]])(
    'rejects non-positive-integer expectedRevision %s',
    (value) => {
      expectValidationError(() => validateExpectedRevision(value, CONTEXT), 'expectedRevision');
    },
  );

  it.each([
    ['f47ac10b-58cc-4372-a567-0e02b2c3d479'],
    ['project_01.backup'],
    ['a'],
  ])('accepts stable id %s', (value) => {
    expect(validateStableId(value, CONTEXT, 'projectId')).toBe(value);
  });

  it.each([[''], ['has space'], ['../escape'], ['.'], ['..'], ['a/b'], [42], ['a'.repeat(129)]])(
    'rejects illegal stable id %s',
    (value) => {
      expectValidationError(() => validateStableId(value, CONTEXT, 'projectId'), 'projectId');
    },
  );

  it('defaults labels to an empty array when omitted', () => {
    expect(normalizeLabels(undefined, CONTEXT)).toEqual([]);
  });

  it('normalizes labels with trim, NFC, ASCII lowercase and per-entity dedupe', () => {
    // 'BUG'→ASCII 小写；'ÄBC' 只有 ASCII 字母变小写（设计 11 §10 规定 ASCII 小写）；
    // 'é'（NFC 组合字符）与 'e\u0301'（分解形式）归一后去重。
    const normalized = normalizeLabels(['  BUG ', 'bug', 'ÄBC', 'é', 'é', '中文标签 '], CONTEXT);
    expect(normalized).toEqual(['bug', 'Äbc', 'é', '中文标签']);
  });

  it.each([
    ['non-array', 'bug'],
    ['non-string element', [1]],
    ['empty-after-trim element', ['   ']],
    ['null element', [null]],
    ['nested array element', [['x']]],
  ])('rejects illegal labels array: %s', (_label, value) => {
    expectValidationError(() => normalizeLabels(value, CONTEXT), undefined);
  });

  it.each([['artifacts/a-1/v1/content'], ['file'], ['projects/p-1/artifacts/a-1']])(
    'accepts a controlled relative locator %s',
    (value) => {
      expect(validateArtifactLocator(value, CONTEXT, 'locator')).toBe(value);
    },
  );

  it.each([
    ['absolute path', '/var/data/x'],
    ['parent traversal', 'a/../b'],
    ['bare parent', '..'],
    ['empty segment', 'a//b'],
    ['dot segment', 'a/./b'],
    ['drive letter', 'C:\\data\\x'],
    ['backslash separator', 'a\\b'],
    ['NUL byte', 'a\0b'],
    ['tilde root', '~/x'],
    ['empty', ''],
    ['non-string', 7],
  ])('rejects an untrusted locator: %s', (_label, value) => {
    expectValidationError(() => validateArtifactLocator(value, CONTEXT, 'locator'), 'locator');
  });
});

describe('F-002/F-008 settings payload schema (bounded schemaVersion=2)', () => {
  it('declares schema version 2 as the only supported storage format', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
  });

  it('accepts the minimal payload with only schemaVersion', () => {
    expect(validateSettingsPayload({ schemaVersion: 2 }, CONTEXT)).toEqual({ schemaVersion: 2 });
  });

  it('accepts a complete strategies section and returns a normalized deep copy', () => {
    const payload = {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        modelMap: {
          low: { runtime: 'pi', provider: 'openai', model: 'gpt-5-mini', endpointRef: 'endpoint/primary' },
          medium: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          high: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus', credentialRef: 'cred/team' },
        },
        purposeStrategies: {
          planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' },
          judge: { runtime: 'pi', provider: 'openai', model: 'gpt-5' },
          review: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        },
        agentOverrides: {
          'coding-agent': { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        },
      },
    };
    const validated = validateSettingsPayload(payload, CONTEXT);
    expect(validated).toEqual(payload);
    // 返回新对象，不与外部输入共享引用（外部后续修改不影响已校验结果）。
    expect(validated).not.toBe(payload);
    expect(validated.strategies).not.toBe(payload.strategies);
  });

  it.each([
    ['missing schemaVersion', {}],
    ['unknown schemaVersion 3', { schemaVersion: 3 }],
    ['previous schemaVersion 1 (F-008 显式升级后不再接受)', { schemaVersion: 1 }],
    ['schemaVersion 0', { schemaVersion: 0 }],
    ['schemaVersion as string', { schemaVersion: '2' }],
    ['schemaVersion 1.5', { schemaVersion: 2.5 }],
  ])('rejects unknown or missing schemaVersion: %s', (_label, value) => {
    expectValidationError(() => validateSettingsPayload(value, CONTEXT), 'payload.schemaVersion');
  });

  it.each([
    ['top-level policy segment shortcut (executionLimits belongs under policies)', { schemaVersion: 2, executionLimits: {} }],
    ['top-level modelMap shortcut', { schemaVersion: 2, modelMap: {} }],
    ['arbitrary extra key', { schemaVersion: 2, anything: { goes: true } }],
  ])('rejects unknown top-level keys so arbitrary objects cannot pose as policy: %s', (_label, value) => {
    expectValidationError(() => validateSettingsPayload(value, CONTEXT), 'payload');
  });

  it.each([
    ['non-object payload', 'not-an-object'],
    ['null payload', null],
    ['array payload', [1, 2]],
  ])('rejects non-object payload: %s', (_label, value) => {
    expectValidationError(() => validateSettingsPayload(value, CONTEXT), 'payload');
  });

  it.each([
    ['unknown complexity key', { schemaVersion: 2, strategies: { modelMap: { turbo: { runtime: 'pi', provider: 'x', model: 'y' } } } }],
    ['incomplete strategy missing model', { schemaVersion: 2, strategies: { modelMap: { low: { runtime: 'pi', provider: 'x' } } } }],
    ['incomplete strategy missing provider', { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', model: 'y' } } }],
    ['empty runtime', { schemaVersion: 2, strategies: { defaultStrategy: { runtime: '  ', provider: 'x', model: 'y' } } }],
    ['unknown strategy key', { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y', temperature: 0.1 } } }],
    ['non-string credentialRef', { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y', credentialRef: 42 } } }],
    ['unknown purpose key', { schemaVersion: 2, strategies: { purposeStrategies: { wizard: { runtime: 'pi', provider: 'x', model: 'y' } } } }],
    ['agent override with invalid strategy', { schemaVersion: 2, strategies: { agentOverrides: { a: { runtime: 'pi' } } } }],
    ['agent override with empty key', { schemaVersion: 2, strategies: { agentOverrides: { '': { runtime: 'pi', provider: 'x', model: 'y' } } } }],
    ['strategies wrong type', { schemaVersion: 2, strategies: 'nope' }],
  ])('rejects malformed strategy structure: %s', (_label, value) => {
    expectValidationError(() => validateSettingsPayload(value, CONTEXT));
  });

  it('rejects prototype-polluting agent override keys', () => {
    const payload = JSON.parse(
      '{"schemaVersion":2,"strategies":{"agentOverrides":{"__proto__":{"runtime":"pi","provider":"x","model":"y"}}}}',
    ) as unknown;
    expectValidationError(() => validateSettingsPayload(payload, CONTEXT));
  });

  it('does not mutate the caller-supplied payload while validating', () => {
    const payload = {
      schemaVersion: 2,
      strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y' } },
    };
    const snapshot = JSON.stringify(payload);
    validateSettingsPayload(payload, CONTEXT);
    expect(JSON.stringify(payload)).toBe(snapshot);
  });
});

describe('F-002 stored settings read path (corruption diagnostics)', () => {
  it('round-trips a valid persisted payload', () => {
    const payload = {
      schemaVersion: 2,
      strategies: { defaultStrategy: { runtime: 'pi', provider: 'x', model: 'y' } },
    };
    expect(parseStoredSettingsPayload(JSON.stringify(payload), CONTEXT)).toEqual(payload);
  });

  it('returns a corrupt error for broken JSON instead of a valid config', () => {
    try {
      parseStoredSettingsPayload('{broken', CONTEXT);
      throw new Error('expected corrupt error');
    } catch (error) {
      expect(isStorageError(error, 'corrupt')).toBe(true);
      const storageError = error as StorageError;
      expect(storageError.operation).toBe('Test.operation');
      expect(storageError.entity).toEqual({ type: 'project', id: 'p-1' });
      expect(storageError.details?.reason).toBe('invalid_json');
    }
  });

  it('returns a corrupt error for an unknown persisted schemaVersion', () => {
    try {
      parseStoredSettingsPayload('{"schemaVersion":99,"strategies":{}}', CONTEXT);
      throw new Error('expected corrupt error');
    } catch (error) {
      expect(isStorageError(error, 'corrupt')).toBe(true);
      expect((error as StorageError).details?.reason).toBe('schema_mismatch');
    }
  });

  it('returns a corrupt error for persisted JSON of the wrong shape', () => {
    expect(() => parseStoredSettingsPayload('[1,2,3]', CONTEXT)).toThrow(StorageError);
    try {
      parseStoredSettingsPayload('[1,2,3]', CONTEXT);
    } catch (error) {
      expect(isStorageError(error, 'corrupt')).toBe(true);
    }
  });
});

describe('F-002 migration record contract', () => {
  it('accepts a valid versioned migration descriptor', () => {
    expect(validateMigrationDescriptor({ version: 1, checksum: VALID_HASH }, 'Test.operation')).toEqual({
      version: 1,
      checksum: VALID_HASH,
    });
  });

  it.each([
    ['version zero', { version: 0, checksum: VALID_HASH }],
    ['fractional version', { version: 1.5, checksum: VALID_HASH }],
    ['missing checksum', { version: 1 }],
    ['illegal checksum', { version: 1, checksum: 'xyz' }],
    ['unknown extra key', { version: 1, checksum: VALID_HASH, sql: 'DROP TABLE' }],
  ])('rejects an illegal migration descriptor: %s', (_label, value) => {
    expect(() => validateMigrationDescriptor(value, 'Test.operation')).toThrow(StorageError);
  });
});
