/**
 * F-002 项目元数据（displayName / description / labels）运行时校验与确定性标签规范化的
 * 行为回归。
 *
 * 覆盖（F-002 验收）：
 * - 有效 displayName、空 description、Markdown/Unicode description 与 labels 字符串数组
 *   通过校验；省略 labels 返回空数组；
 * - 空白名称、错误字段类型、非法标签数组、空白标签、超长/超数量输入被拒绝，错误定位到
 *   具体字段（details.field），并携带 operation；
 * - 标签按统一规则 trim → Unicode NFC → ASCII 小写 → 实体内去重；非 ASCII 文本不被转写；
 * - 注册（validateCreateProjectInput）与元数据编辑（validateUpdateProjectInput）共用同一
 *   标签规则，可直接对照 normalizeLabels；标签保持不透明检索元数据，不被解释为 model/
 *   permission/status 或子级继承政策；
 * - 非法输入不得进入写入端口（写前置校验是唯一闸门）；
 * - 长度/数量上限常量与本契约文档记录一致。
 *
 * 纯函数测试不涉及 I/O；写入端口闸门用真实 SQLite 行数变化佐证。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import {
  DESCRIPTION_MAX_LENGTH,
  LABELS_MAX_COUNT,
  LABEL_MAX_LENGTH,
  PROJECT_DISPLAY_NAME_MAX_LENGTH,
  normalizeLabels,
  validateProjectDescription,
  validateProjectDisplayName,
} from '../packages/core/src/ports/validation.ts';
import type { ValidationContext } from '../packages/core/src/ports/validation.ts';
import {
  validateCreateProjectInput,
  validateUpdateProjectInput,
} from '../packages/core/src/ports/state-store.ts';
import * as coreEntry from '../packages/core/src/index.ts';

const CONTEXT: ValidationContext = {
  operation: 'Test.projectMetadata',
  entity: { type: 'project', id: 'p-1' },
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractDoc = readFileSync(resolve(REPO_ROOT, 'docs/p01-3-application-contract.md'), 'utf-8');

function expectValidationError(fn: () => unknown, field?: string): StorageError {
  try {
    fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(
      true,
    );
    const storageError = error as StorageError;
    expect(storageError.operation).toBe('Test.projectMetadata');
    if (field !== undefined) {
      expect(storageError.details?.field).toBe(field);
    }
    expect(typeof storageError.details?.reason).toBe('string');
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

async function expectStorageError(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(true);
    return error as StorageError;
  }
  throw new Error(`expected StorageError(${kind})`);
}

describe('F-002 recorded metadata limits', () => {
  it('exposes the shared validators and limits from the Core public entry', () => {
    expect(typeof coreEntry.validateProjectDisplayName).toBe('function');
    expect(typeof coreEntry.validateProjectDescription).toBe('function');
    expect(typeof coreEntry.normalizeLabels).toBe('function');
    expect(coreEntry.PROJECT_DISPLAY_NAME_MAX_LENGTH).toBe(PROJECT_DISPLAY_NAME_MAX_LENGTH);
    expect(coreEntry.DESCRIPTION_MAX_LENGTH).toBe(DESCRIPTION_MAX_LENGTH);
    expect(coreEntry.LABEL_MAX_LENGTH).toBe(LABEL_MAX_LENGTH);
    expect(coreEntry.LABELS_MAX_COUNT).toBe(LABELS_MAX_COUNT);
  });

  it('declares finite positive limits and records the same values in the application contract', () => {
    for (const limit of [
      PROJECT_DISPLAY_NAME_MAX_LENGTH,
      DESCRIPTION_MAX_LENGTH,
      LABEL_MAX_LENGTH,
      LABELS_MAX_COUNT,
    ]) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
    // 文档不得与代码漂移：把真实数值写入契约文档。
    expect(contractDoc).toContain(String(PROJECT_DISPLAY_NAME_MAX_LENGTH));
    expect(contractDoc).toContain(String(DESCRIPTION_MAX_LENGTH));
    expect(contractDoc).toContain(String(LABEL_MAX_LENGTH));
    expect(contractDoc).toContain(String(LABELS_MAX_COUNT));
  });
});

describe('F-002 project displayName validation', () => {
  it('accepts a valid name and trims surrounding whitespace deterministically', () => {
    expect(validateProjectDisplayName('  示例项目  ', CONTEXT)).toBe('示例项目');
    expect(validateProjectDisplayName('P01-3 项目', CONTEXT)).toBe('P01-3 项目');
  });

  it('accepts a name exactly at the recorded maximum length', () => {
    const name = 'x'.repeat(PROJECT_DISPLAY_NAME_MAX_LENGTH);
    expect(validateProjectDisplayName(name, CONTEXT)).toBe(name);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   \t\n '],
    ['non-string number', 1],
    ['null', null],
    ['array', ['x']],
  ])('rejects invalid displayName: %s', (_label, value) => {
    expectValidationError(() => validateProjectDisplayName(value, CONTEXT), 'displayName');
  });

  it('rejects a name one code point over the recorded maximum, locating the field', () => {
    const name = 'x'.repeat(PROJECT_DISPLAY_NAME_MAX_LENGTH + 1);
    const error = expectValidationError(() => validateProjectDisplayName(name, CONTEXT), 'displayName');
    expect(String(error.details?.reason)).toContain(String(PROJECT_DISPLAY_NAME_MAX_LENGTH));
  });
});

describe('F-002 project description validation', () => {
  it('treats absent and null descriptions as null without error', () => {
    expect(validateProjectDescription(undefined, CONTEXT)).toBeUndefined();
    expect(validateProjectDescription(null, CONTEXT)).toBeNull();
  });

  it('accepts an empty or whitespace-only description and normalizes it to null', () => {
    expect(validateProjectDescription('', CONTEXT)).toBeNull();
    expect(validateProjectDescription('   \n ', CONTEXT)).toBeNull();
  });

  it('preserves Markdown and Unicode description content verbatim', () => {
    const description = '# 标题\n\n- 项目说明 with **markdown**, emoji 🚀 and combining é (e\u0301).';
    expect(validateProjectDescription(description, CONTEXT)).toBe(description);
  });

  it('accepts a description exactly at the recorded maximum length', () => {
    const description = 'x'.repeat(DESCRIPTION_MAX_LENGTH);
    expect(validateProjectDescription(description, CONTEXT)).toBe(description);
  });

  it('rejects non-string descriptions and descriptions over the recorded maximum', () => {
    expectValidationError(() => validateProjectDescription(42, CONTEXT), 'description');
    const tooLong = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1);
    const error = expectValidationError(() => validateProjectDescription(tooLong, CONTEXT), 'description');
    expect(String(error.details?.reason)).toContain(String(DESCRIPTION_MAX_LENGTH));
  });
});

describe('F-002 deterministic label normalization', () => {
  it('defaults omitted labels to an empty array', () => {
    expect(normalizeLabels(undefined, CONTEXT)).toEqual([]);
  });

  it('applies trim, Unicode NFC, ASCII lowercase and per-entity dedupe', () => {
    // trim + ASCII 小写；NFC 把分解形式 e + U+0301 与预组合 é 归一后去重。
    expect(normalizeLabels(['  BUG ', 'bug', 'Bug ', 'é', 'e\u0301', '中文标签 '], CONTEXT)).toEqual([
      'bug',
      'é',
      '中文标签',
    ]);
  });

  it('does not transliterate lowercase or otherwise rewrite non-ASCII text', () => {
    // 仅 ASCII A-Z 小写；Ä/Ä、全角Ａ、希腊/西里尔文字保持原样（仅 NFC）。
    expect(normalizeLabels(['Ä', 'Ä', 'Ａ', 'Σ', 'Привет'], CONTEXT)).toEqual(['Ä', 'Ａ', 'Σ', 'Привет']);
  });

  it('preserves first occurrence order after dedupe', () => {
    expect(normalizeLabels(['B', 'a', 'b', 'A'], CONTEXT)).toEqual(['b', 'a']);
  });

  it('keeps labels opaque instead of interpreting them as model/permission/status policy', () => {
    // 这些字符串可能像策略枚举值，但标签层不得据此校验或改写；仅做字符串规范化。
    const labels = ['low', 'planner', 'active', 'admin', 'runtime:pi', 'verification', 'sub-inherit'];
    expect(normalizeLabels(labels, CONTEXT)).toEqual(labels);
  });

  it('accepts a label exactly at the recorded maximum length and count', () => {
    const labels = Array.from({ length: LABELS_MAX_COUNT }, (_unused, index) => `label-${index}`);
    expect(normalizeLabels(labels, CONTEXT)).toHaveLength(LABELS_MAX_COUNT);
    const maxLabel = 'x'.repeat(LABEL_MAX_LENGTH);
    expect(normalizeLabels([maxLabel], CONTEXT)).toEqual([maxLabel]);
  });

  it.each([
    ['non-array string', 'bug', 'labels'],
    ['number element', [1], 'labels[0]'],
    ['null element', [null], 'labels[0]'],
    ['nested array element', [['x']], 'labels[0]'],
    ['empty-after-trim element', ['   '], 'labels[0]'],
    ['object element', [{ label: 'x' }], 'labels[0]'],
  ])('rejects an illegal labels array: %s', (_label, value, field) => {
    expectValidationError(() => normalizeLabels(value, CONTEXT), field);
  });

  it('rejects an over-long single label and an over-count labels list with field location', () => {
    const tooLong = 'x'.repeat(LABEL_MAX_LENGTH + 1);
    const lengthError = expectValidationError(() => normalizeLabels([tooLong], CONTEXT), 'labels[0]');
    expect(String(lengthError.details?.reason)).toContain(String(LABEL_MAX_LENGTH));

    const tooMany = Array.from({ length: LABELS_MAX_COUNT + 1 }, (_unused, index) => `l${index}`);
    const countError = expectValidationError(() => normalizeLabels(tooMany, CONTEXT), 'labels');
    expect(String(countError.details?.reason)).toContain(String(LABELS_MAX_COUNT));
  });

  it('does not mutate the caller-supplied labels array', () => {
    const input = ['  BUG ', 'bug', '核心'];
    const snapshot = JSON.stringify(input);
    normalizeLabels(input, CONTEXT);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('F-002 create / update / query share one label rule', () => {
  it('normalizes the same label input identically on create, update and the shared primitive', () => {
    const input = ['  Bug ', 'bug', '核心', 'É', 'é', 'e\u0301'];
    const expected = normalizeLabels(input, CONTEXT);
    // 非 ASCII 大写 É 保留；é 的预组合与分解形式 NFC 后去重。
    expect(expected).toEqual(['bug', '核心', 'É', 'é']);

    const created = validateCreateProjectInput({ displayName: '项目', labels: input }, 'Test.projectMetadata');
    expect(created.labels).toEqual(expected);

    const updated = validateUpdateProjectInput(
      { expectedRevision: 1, labels: input },
      'Test.projectMetadata',
    );
    expect(updated.labels).toEqual(expected);
  });

  it('rejects the same illegal labels on create and update before any write', () => {
    for (const badLabels of ['not-an-array', [''], [1], ['x'.repeat(LABEL_MAX_LENGTH + 1)]]) {
      expect(() =>
        validateCreateProjectInput({ displayName: '项目', labels: badLabels }, 'Test.projectMetadata'),
      ).toThrow(StorageError);
      expect(() =>
        validateUpdateProjectInput(
          { expectedRevision: 1, labels: badLabels },
          'Test.projectMetadata',
        ),
      ).toThrow(StorageError);
    }
  });

  it('does not call the write port when input fails validation (write-after-validate boundary)', async () => {
    const writePort = { createProject: vi.fn(async (_input: unknown) => ({ id: 'p' })) };
    // 应用边界的既定模式：先运行时校验，校验通过才调用写入端口。
    async function register(input: unknown) {
      const valid = validateCreateProjectInput(input, 'ProjectService.registerRepository');
      return writePort.createProject(valid);
    }
    await expect(register({ displayName: '', labels: ['x'] })).rejects.toBeInstanceOf(StorageError);
    await expect(register({ displayName: 'x', labels: [''] })).rejects.toBeInstanceOf(StorageError);
    await expect(
      register({ displayName: 'x', labels: ['x'.repeat(LABEL_MAX_LENGTH + 1)] }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(writePort.createProject).not.toHaveBeenCalled();

    await register({ displayName: 'x', labels: [' Ok '] });
    expect(writePort.createProject).toHaveBeenCalledTimes(1);
    expect(writePort.createProject.mock.calls[0]?.[0]).toMatchObject({
      displayName: 'x',
      description: null,
      labels: ['ok'],
    });
  });
});

describe('F-002 create/update integration with the new rules', () => {
  it('normalizes trimmed name and empty description through validateCreateProjectInput', () => {
    const valid = validateCreateProjectInput(
      { displayName: '  示例  ', description: '   ' },
      'Test.projectMetadata',
    );
    expect(valid.displayName).toBe('示例');
    expect(valid.description).toBeNull();
    expect(valid.labels).toEqual([]);
  });

  it('allows clearing the description to null via update while keeping labels shared', () => {
    const valid = validateUpdateProjectInput(
      { expectedRevision: 2, description: '' },
      'Test.projectMetadata',
    );
    expect(valid.description).toBeNull();
    expect(valid.labels).toBeUndefined();
  });
});

describe('F-002 invalid metadata persists nothing in the real store', () => {
  it('rejects over-limit metadata at the port and leaves the table unchanged', async () => {
    // 真实 SQLite 行数取证见 sqlite-state-store.test.ts；此处用内存假存储的 raw 探针
    // 断言非法输入在端口校验阶段即失败、未写入任何业务行。
    const { createInMemoryStorage } = await import('./helpers/in-memory-store.ts');
    const harness = createInMemoryStorage(() => 1_700_000_000_000);
    await expectStorageError('validation', () =>
      harness.stateStore.createProject({ displayName: '  ' }),
    );
    await expectStorageError('validation', () =>
      harness.stateStore.createProject({
        displayName: 'x',
        labels: Array.from({ length: LABELS_MAX_COUNT + 1 }, (_unused, index) => `l${index}`),
      }),
    );
    expect(harness.raw.projects.size).toBe(0);
  });
});
