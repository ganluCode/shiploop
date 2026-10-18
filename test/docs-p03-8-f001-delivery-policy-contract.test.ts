/**
 * P03-8 / F-001 文档核验：`docs/p03-8-f001-delivery-policy-contract.md` 记录的
 * 交付政策契约必须与仓库实现事实一致（冻结常量、词汇与集成点），避免
 * 「文档另立一套」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_POLICY_DIGEST_DOMAIN,
  FEATURE_FINAL_COMMIT_MODE,
  SUPPORTED_DELIVERY_ACTIONS,
} from '../packages/core/src/ports/delivery-policy.ts';
import {
  CONTEXT_DELIVERY_POLICY_COPY_MAX_BYTES,
  CONTEXT_INPUT_SCHEMA_VERSION,
  CONTEXT_MANIFEST_SOURCE_KINDS,
} from '../packages/core/src/ports/context-build.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p03-8-f001-delivery-policy-contract.md';

function readContractDoc(): string {
  const path = resolve(REPO_ROOT, CONTRACT_DOC_PATH);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('P03-8 / F-001 交付政策契约文档', () => {
  it('冻结常量与实现一致：唯一提交模式、唯一交付动作、摘要域、配置版本', () => {
    const doc = readContractDoc();
    expect(FEATURE_FINAL_COMMIT_MODE).toBe('feature_final_only');
    expect([...SUPPORTED_DELIVERY_ACTIONS]).toEqual(['commit']);
    expect(DELIVERY_POLICY_DIGEST_DOMAIN).toBe('shiploop:feature-delivery-policy:v1');
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    for (const keyword of [
      'feature_final_only',
      "['commit']",
      'shiploop:feature-delivery-policy:v1',
      'schemaVersion 维持 2',
      String(CONTEXT_DELIVERY_POLICY_COPY_MAX_BYTES),
      'unsupported_commit_mode',
      'unsupported_delivery_action',
      'identity_not_confirmed',
    ]) {
      expect(doc, `文档必须记录 ${keyword}`).toContain(keyword);
    }
  });

  it('快照集成事实一致：ContextBuilder v3+、delivery-policy manifest 类别与导出入口', () => {
    const doc = readContractDoc();
    expect(CONTEXT_INPUT_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    expect(CONTEXT_MANIFEST_SOURCE_KINDS).toContain('delivery-policy');
    for (const keyword of [
      'ports/delivery-policy.ts',
      'application/delivery-policy.ts',
      'resolveCurrentDeliveryPolicy',
      'ports/settings-schema.ts',
      'application/effective-settings.ts',
      'ports/context-build.ts',
      'application/execution-input-prepare.ts',
      'schemaVersion 升至 3',
      'delivery-policy',
      'computeDeliveryPolicyDigest',
      'v25',
      'IN (1, 2, 3)',
      '不自行提交',
      '保存验证成果',
      '不回落到开发机全局身份',
    ]) {
      expect(doc, `文档必须记录 ${keyword}`).toContain(keyword);
    }
  });

  it('前序核对记录存在：P03-7 线性链接口核对与 main 基线不替代声明', () => {
    const doc = readContractDoc();
    expect(doc).toContain('前序核对记录');
    expect(doc).toContain('p03-task-verification');
    expect(doc).toContain('ports/verification-store.ts');
    expect(doc).toContain('ports/work-resources.ts');
    expect(doc).toContain('ports/execution-input-prepare.ts');
    expect(doc).toContain('不是本 Feature 前置交付');
    for (const rejected of ['push', 'pull_request', 'auto_merge']) {
      expect(doc).toContain(rejected);
    }
  });
});
