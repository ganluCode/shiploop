import { describe, expect, it } from 'vitest';
import {
  SETTINGS_SCHEMA_VERSION,
  validateSettingsPayload,
} from '../packages/core/src/ports/settings-schema.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';

const context = {
  operation: 'F-001.test',
  entity: { type: 'project_settings', projectId: 'project-a' },
} as const;

const checkPolicy = {
  requireChecksBeforeDone: true,
  checkDefinitions: [
    {
      checkKey: 'unit-core',
      scope: 'module',
      kind: 'command',
      argv: ['npm', 'test', '--', 'packages/core'],
      cwdRef: 'packages/core',
      environmentRef: 'ci-safe',
      timeout: 120_000,
      required: true,
      requirementRefs: ['req-core'],
    },
    {
      checkKey: 'lint',
      scope: 'project',
      kind: 'command',
      argv: ['npm', 'run', 'lint'],
      cwdRef: null,
      environmentRef: null,
      timeout: 300_000,
      required: true,
      requirementRefs: [],
    },
  ],
  modules: [
    {
      moduleKey: 'core',
      allowedTargets: ['packages/core'],
      impactScope: ['packages/core', 'packages/shared'],
      sharedHighRiskFiles: ['package.json', 'package-lock.json'],
    },
  ],
  fullFallback: {
    checkRefs: ['lint'],
  },
};

function validPayload() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    policies: { verification: checkPolicy },
  };
}

function validationField(error: unknown): string | undefined {
  if (!isStorageError(error)) return undefined;
  const field = error.details?.field;
  return typeof field === 'string' ? field : undefined;
}

describe('F-001 confirmed verification policy in current settings', () => {
  it('保存并读回完整 CheckDefinition、显式模块规则和全量回退引用', () => {
    const result = validateSettingsPayload(validPayload(), context);
    expect(result.policies?.verification).toEqual(checkPolicy);
  });

  it('拒绝重复检查身份、空 argv、非法超时、未知 kind 和未知字段', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['duplicate', { checkDefinitions: [{ ...checkPolicy.checkDefinitions[0] }, { ...checkPolicy.checkDefinitions[0] }] }, 'payload.policies.verification.checkDefinitions[1].checkKey'],
      ['empty argv', { checkDefinitions: [{ ...checkPolicy.checkDefinitions[0], argv: [] }] }, 'payload.policies.verification.checkDefinitions[0].argv'],
      ['bad timeout', { checkDefinitions: [{ ...checkPolicy.checkDefinitions[0], timeout: 0 }] }, 'payload.policies.verification.checkDefinitions[0].timeout'],
      ['unsupported kind', { checkDefinitions: [{ ...checkPolicy.checkDefinitions[0], kind: 'script' }] }, 'payload.policies.verification.checkDefinitions[0].kind'],
      ['unknown field', { checkDefinitions: [{ ...checkPolicy.checkDefinitions[0], surprise: true }] }, 'payload.policies.verification.checkDefinitions[0]'],
    ];
    for (const [, replacement, field] of cases) {
      expect(() => validateSettingsPayload({
        ...validPayload(),
        policies: { verification: { ...checkPolicy, ...replacement } },
      }, context)).toThrow();
      try {
        validateSettingsPayload({
          ...validPayload(),
          policies: { verification: { ...checkPolicy, ...replacement } },
        }, context);
      } catch (error) {
        expect(validationField(error)).toBe(field);
      }
    }
  });

  it('拒绝无效模块/检查引用、重复模块及跨项目引用', () => {
    const invalidPolicies = [
      { ...checkPolicy, fullFallback: { checkRefs: ['missing'] } },
      { ...checkPolicy, modules: [{ ...checkPolicy.modules[0], moduleKey: 'core', allowedTargets: [] }] },
      { ...checkPolicy, modules: [{ ...checkPolicy.modules[0], moduleKey: 'core' }, { ...checkPolicy.modules[0] }] },
      { ...checkPolicy, fullFallback: { checkRefs: ['lint'], moduleRefs: [{ id: 'core', projectId: 'project-b' }] } },
      { ...checkPolicy, fullFallback: undefined },
    ];
    for (const verification of invalidPolicies) {
      expect(() => validateSettingsPayload({
        ...validPayload(),
        policies: { verification },
      }, context)).toThrow();
    }
  });

  it('拒绝把项目定义写入 global scope', () => {
    expect(() => validateSettingsPayload(validPayload(), {
      operation: context.operation,
      entity: { type: 'global_settings', id: 'global' },
    })).toThrow();
  });

  it('旧 v2 payload without the optional verification definitions remains compatible', () => {
    expect(validateSettingsPayload({ schemaVersion: 2, policies: { verification: { requireChecksBeforeDone: true } } }, context))
      .toEqual({ schemaVersion: 2, policies: { verification: { requireChecksBeforeDone: true } } });
  });
});
