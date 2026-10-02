/**
 * F-001 文档核验：`docs/p01-3-application-contract.md` 声明的 P01-3 Core 应用契约
 * 必须与仓库中真实存在的前序常量/端口/迁移一致，避免「文档另立一套」与实现漂移。
 *
 * 定位：F-001 只交付契约与范围文档；本套件交叉核对文档引用的真实契约
 * （schemaVersion、全局单例 ID、结构化错误类别、受控定位规则、六表迁移），
 * 并断言范围/非目标被显式声明。不新增业务实现，不扩大 P01-3 交付范围。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { GLOBAL_SETTINGS_ID } from '../packages/core/src/ports/state-store.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import { StorageError } from '../packages/core/src/ports/errors.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p01-3-application-contract.md';
const contractDoc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf-8');

describe('F-001 P01-3 应用契约文档', () => {
  it('记录前序基线核验、真实命令与退出码（不冒充阶段验收）', () => {
    expect(contractDoc).toContain('npm run verify');
    expect(contractDoc).toContain('443');
    expect(contractDoc).toContain('20 test files');
    expect(contractDoc).toContain('feat/2026-10-01-23-44-21_p01-2-sqlite');
    expect(contractDoc).toContain('44c8c30');
    // 文档明确不是阶段验收报告，且不做 accept:p01。
    expect(contractDoc).toContain('不是阶段验收报告');
    expect(contractDoc).toContain('P01-4');
  });

  it('声明的 schemaVersion / 全局单例 ID 与实现的真实常量一致', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
    expect(GLOBAL_SETTINGS_ID).toBe('global');
    expect(contractDoc).toContain(`SETTINGS_SCHEMA_VERSION = ${SETTINGS_SCHEMA_VERSION}`);
    expect(contractDoc).toContain("global_settings.id='global'");
  });

  it('完整列出结构化错误类别且与 StorageError 契约一致', () => {
    const kindsFromContract = [
      'validation',
      'not_found',
      'conflict',
      'busy',
      'corrupt',
      'unsupported_version',
      'ownership',
    ] as const;
    for (const kind of kindsFromContract) {
      expect(contractDoc).toContain(kind);
    }
    // 交叉核对：真实错误厂函数确实接受这些 kind（构造不抛即视为契约可表达）。
    for (const kind of kindsFromContract) {
      const error = new StorageError(kind, 'contract.check', 'probe');
      expect(error.kind).toBe(kind);
    }
  });

  it('版本化迁移（v1 六表 + v2 state_events 审计）与受控定位/标签规范等复用规则在文档中可核对', () => {
    expect(SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2]);
    const [migration] = SQLITE_MIGRATIONS;
    expect(migration?.version).toBe(1);
    const sql = migration?.sql ?? '';
    for (const table of [
      'projects',
      'repository_bindings',
      'global_settings',
      'project_settings',
      'artifacts',
      'schema_migrations',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
      expect(contractDoc).toContain(table);
    }
    // F-006 引入的 state_events 审计表由 v2 迁移建立，文档与此一致。
    const eventsMigration = SQLITE_MIGRATIONS[1];
    expect(eventsMigration?.sql).toContain('CREATE TABLE state_events');
    expect(contractDoc).toContain('state_events');
    // 受控定位与标签规则是文档声明的复用契约。
    expect(contractDoc).toContain('realpath');
    expect(contractDoc).toContain('no-follow');
    expect(contractDoc).toContain('NFC');
    expect(contractDoc).toContain('ASCII 小写');
    expect(contractDoc).toContain('expectedRevision');
  });

  it('明确本 Feature 范围与非目标，并沿用前序精确版本', () => {
    for (const exclusion of [
      'Host 网络接口',
      'CLI 路由',
      'Task 策略复制',
      'Runtime 调用',
      'rebind',
      '存量基线扫描',
      '不修改 Harness YAML',
    ]) {
      expect(contractDoc).toContain(exclusion);
    }
    for (const version of ['22.19.0', '10.9.3', '13.0.3', '0.45.3', '7.0.2', '5.0.3']) {
      expect(contractDoc).toContain(version);
    }
  });

  it('记录变更记录落点与已发现的领域/接口张力（不静默改变语义）', () => {
    expect(contractDoc).toContain('state_events');
    expect(contractDoc).toContain('脱敏');
    expect(contractDoc).toContain('同一短事务');
    expect(contractDoc).toContain('请求核对');
    expect(contractDoc).toContain('dataNamespace');
  });
});
