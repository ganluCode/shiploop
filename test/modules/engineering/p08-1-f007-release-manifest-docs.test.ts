/**
 * P08-1 / F-007 发布清单与文档入口守护。
 *
 * 验收映射（.dag_context.json F-007 五项）：
 * 1) README 的 P08-1 导航能找到安装指南、支持矩阵、变更说明、制品检查说明与
 *    Skills 操作文档；相对链接目标真实存在，且不指向 Harness 私有运行目录。
 * 2) `acceptance/p08-1.release-manifest.json` 覆盖 Git SHA、包版本、协议范围、
 *    Schema 支持范围、Node/npm、平台、制品摘要、检查退出码、证据位置与已知缺口，
 *    且不含凭据字段/值。
 * 3) 清单把代码交付、Task 局部单元检查、Feature 门禁和 P08 Phase 集成分层；
 *    真实三包安装、Host/CLI 运行、协议兼容/不兼容、进程清理与 Todo/存量演示
 *    保持 not_run，文档不得签署阶段通过。
 * 4) 局部检查只读取仓库文档/清单、Git 对象与现有 JSON，不执行全仓回归、不发包、
 *    不 push、不合并、不修改 Phase/Feature/Task 状态。
 * 5) 交付报告可供 P08-4 读取，并显式声明不替代跨 Feature 集成、人工确认或 live 授权。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const GUIDE = 'docs/p08-1-user-guide.md';
const SUPPORT_MATRIX = 'docs/p08-1-support-matrix.md';
const CHANGELOG = 'CHANGELOG.md';
const ARTIFACT_DOC = 'docs/p08-1-artifact-verification.md';
const MANIFEST = 'acceptance/p08-1.release-manifest.json';
const MANIFEST_DOC = 'docs/acceptance/p08-1-release-manifest.md';
const DELIVERY_REPORT = 'docs/acceptance/p08-1-delivery-report.md';
const SKILLS = [
  'docs/skills/project-init.md',
  'docs/skills/project-overview.md',
  'docs/skills/host-lifecycle.md',
  'docs/skills/planning-approval.md',
  'docs/skills/execution-observe.md',
  'docs/skills/stop-control.md',
  'docs/skills/backup-restore.md',
  'docs/skills/troubleshooting.md',
] as const;

const NEW_DOC_FILES = [SUPPORT_MATRIX, CHANGELOG, ARTIFACT_DOC, MANIFEST_DOC, MANIFEST, DELIVERY_REPORT] as const;
const P08_PHASE_INTEGRATION_IDS = [
  'real-three-package-install',
  'host-cli-run',
  'protocol-compatible',
  'protocol-incompatible',
  'process-cleanup',
  'todo-demo',
  'existing-repo-demo',
] as const;

type JsonRecord = Record<string, unknown>;

function readText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(readText(relativePath)) as JsonRecord;
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function fencedJsonBlock(markdown: string): string {
  const match = /```json\n([\s\S]*?)```/.exec(markdown);
  expect(match, '文档必须包含可解析的 json 模板代码块').not.toBeNull();
  return match?.[1] as string;
}

function asRecord(value: unknown, label: string): JsonRecord {
  expect(value, `${label} 必须是对象`).toBeTypeOf('object');
  expect(value, `${label} 不能是 null`).not.toBeNull();
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} 必须是数组`).toBe(true);
  return value as unknown[];
}

function requireField(record: JsonRecord, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current, path.join('.'))[key];
  }
  expect(current, `缺少字段 ${path.join('.')}`).toBeDefined();
  return current;
}

function git(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

describe('F-007 README 文档入口', () => {
  it('P08-1 导航登记安装、支持矩阵、变更说明、制品检查与全部 Skills，且目标真实存在', () => {
    const readme = readText('README.md');
    const nav = section(readme, '## P08-1 安装与发布文档导航');
    expect(nav.length, 'README 必须有 P08-1 安装与发布文档导航章节').toBeGreaterThan(0);

    const required = [
      GUIDE,
      SUPPORT_MATRIX,
      CHANGELOG,
      ARTIFACT_DOC,
      MANIFEST_DOC,
      MANIFEST,
      DELIVERY_REPORT,
      ...SKILLS,
    ];
    for (const target of required) {
      expect(nav, `导航缺少 ${target}`).toContain(`](${target})`);
      expect(existsSync(resolve(REPO_ROOT, target)), `${target} 必须存在`).toBe(true);
    }

    const links = [...nav.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1] as string);
    expect(links.length).toBeGreaterThanOrEqual(required.length);
    for (const link of links) {
      if (/^https?:\/\//.test(link) || link.startsWith('#')) continue;
      const path = link.split('#')[0] as string;
      expect(existsSync(resolve(REPO_ROOT, path)), `导航链接目标不存在：${link}`).toBe(true);
      expect(link).not.toMatch(/shiploop-harness|workspace\/features|\/Users\//);
    }
  });
});

describe('F-007 发布清单结构、身份与状态边界', () => {
  const manifest = readJson(MANIFEST);
  const compatibility = readJson('distribution-compatibility.json');

  it('清单头、Git SHA、包版本、工具链和兼容范围与仓库冻结声明一致', () => {
    expect(manifest['schemaVersion']).toBe(1);
    expect(manifest['kind']).toBe('shiploop.p08.release-manifest');
    expect(manifest['phase']).toBe('P08');
    expect(manifest['feature']).toBe('P08-1');
    expect(manifest['distributionMode']).toBe('local-pack-only');
    expect(manifest['published']).toBe(false);

    const identity = asRecord(manifest['identity'], 'identity');
    const gitCommit = identity['gitCommit'];
    expect(gitCommit).toMatch(/^[0-9a-f]{40}$/);
    const commit = git(['cat-file', '-e', `${String(gitCommit)}^{commit}`]);
    expect(commit.status, `清单 Git SHA 必须是本仓库真实提交：${String(gitCommit)}`).toBe(0);
    expect(git(['log', '-1', '--format=%s', String(gitCommit)]).stdout).toMatch(/^F-\d{3}: /);
    expect(identity['branch']).toBe('feat/2026-11-02-14-56-22_p08-1');

    const unifiedVersion = compatibility['unifiedVersion'];
    const packages = asArray(manifest['packages'], 'packages').map((entry, index) =>
      asRecord(entry, `packages[${index}]`),
    );
    expect(packages.map((entry) => entry['name'])).toEqual([
      'shiploop-core',
      'shiploop-host',
      'shiploop-cli',
    ]);
    for (const entry of packages) {
      const pkg = readJson(`packages/${String(entry['name']).replace('shiploop-', '')}/package.json`);
      expect(entry['version']).toBe(pkg['version']);
      expect(entry['version']).toBe(unifiedVersion);
      expect(entry['private']).toBe(true);
    }

    const toolchain = asRecord(manifest['toolchain'], 'toolchain');
    const expectedToolchain = asRecord(compatibility['toolchain'], 'compatibility.toolchain');
    expect(toolchain['node']).toBe(expectedToolchain['node']);
    expect(toolchain['npm']).toBe(expectedToolchain['npm']);
    expect(toolchain['platform']).toBe('darwin');
    expect(toolchain['packageManager']).toBe('npm@10.9.3');

    const declaredCompatibility = asRecord(manifest['compatibility'], 'compatibility');
    expect(declaredCompatibility['hostProtocol']).toEqual(compatibility['hostProtocol']);
    expect(declaredCompatibility['databaseSchema']).toEqual(compatibility['databaseSchema']);
  });

  it('制品摘要字段保留但标记 not_run，不把现有旧产物冒充当前提交制品', () => {
    const artifacts = asRecord(manifest['artifacts'], 'artifacts');
    expect(artifacts['status']).toBe('not_run');
    expect(String(artifacts['reason'])).toContain('pack');
    const items = asArray(artifacts['items'], 'artifacts.items').map((entry, index) =>
      asRecord(entry, `artifacts.items[${index}]`),
    );
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item['name']).toMatch(/^shiploop-(core|host|cli)$/);
      expect(item['version']).toBe(compatibility['unifiedVersion']);
      expect(item['filename']).toBe(`${String(item['name'])}-${String(item['version'])}.tgz`);
      expect(Object.keys(item)).toContain('sha256');
      expect(item['sha256']).toBeNull();
    }
  });

  it('分层状态、Phase 集成待运行项、检查退出码与发布身份缺口完整', () => {
    const layers = asRecord(manifest['layers'], 'layers');
    expect(layers).toMatchObject({
      codeDelivery: 'delivered',
      taskLocalChecks: 'passed',
      featureGate: 'not_run',
      phaseIntegration: 'not_run',
    });

    const checks = asArray(manifest['checks'], 'checks').map((entry, index) =>
      asRecord(entry, `checks[${index}]`),
    );
    const localCheck = checks.find((entry) => entry['id'] === 'f007-docs-manifest-local');
    expect(localCheck, '必须登记 F-007 局部检查').toBeDefined();
    expect(localCheck?.['layer']).toBe('task-local-unit');
    expect(localCheck?.['status']).toBe('passed');
    expect(localCheck?.['exitCode']).toBe(0);
    expect(String(localCheck?.['evidence'])).toMatch(
      /^verifications\/F-007\/runtime-logs\/[^/]+\.log$/,
    );
    for (const id of ['feature-gate', 'p08-phase-integration']) {
      const gate = checks.find((entry) => entry['id'] === id);
      expect(gate, `必须登记 ${id}`).toBeDefined();
      expect(gate?.['status']).toBe('not_run');
      expect(gate?.['exitCode']).toBeNull();
    }
    const artifactCheck = checks.find((entry) => entry['id'] === 'artifact-verification');
    expect(artifactCheck?.['status']).toBe('not_run');
    expect(String(artifactCheck?.['reason'])).toContain('未重新生成');

    const phaseIntegration = asRecord(manifest['phaseIntegration'], 'phaseIntegration');
    expect(phaseIntegration['status']).toBe('not_run');
    const items = asArray(phaseIntegration['items'], 'phaseIntegration.items').map((entry, index) =>
      asRecord(entry, `phaseIntegration.items[${index}]`),
    );
    expect(items.map((entry) => entry['id'])).toEqual([...P08_PHASE_INTEGRATION_IDS]);
    for (const item of items) {
      expect(item['status'], String(item['id'])).toBe('not_run');
    }

    const blockers = asArray(manifest['releaseBlockers'], 'releaseBlockers').map((entry, index) =>
      asRecord(entry, `releaseBlockers[${index}]`),
    );
    expect(blockers.map((entry) => entry['id'])).toEqual([
      'license',
      'npmScope',
      'publicPackageNames',
      'publishIdentity',
    ]);
    for (const blocker of blockers) expect(blocker['status']).toBe('pending');

    const knownGaps = asArray(manifest['knownGaps'], 'knownGaps');
    expect(knownGaps.length).toBeGreaterThanOrEqual(4);
    expect(knownGaps.join('\n')).toContain('P08-4');
  });

  it('清单不含凭据字段或凭据形态的值', () => {
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as JsonRecord)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(manifest);
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('apiKey');
    expect(keys).not.toContain('secret');

    const text = readText(MANIFEST);
    expect(text).not.toMatch(/npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/);
    expect(text).not.toContain('-----BEGIN');
  });
});

describe('F-007 发布清单模板与变更说明', () => {
  it('模板文档包含全部必需字段、状态词汇和 not_run 边界', () => {
    const doc = readText(MANIFEST_DOC);
    const template = JSON.parse(fencedJsonBlock(doc)) as JsonRecord;
    const paths: readonly (readonly string[])[] = [
      ['identity', 'gitCommit'],
      ['packages', '0', 'version'],
      ['compatibility', 'hostProtocol'],
      ['compatibility', 'databaseSchema'],
      ['toolchain', 'node'],
      ['toolchain', 'npm'],
      ['toolchain', 'platform'],
      ['artifacts', 'items', '0', 'sha256'],
      ['checks', '0', 'exitCode'],
      ['checks', '0', 'evidence'],
      ['layers', 'taskLocalChecks'],
      ['phaseIntegration', 'items', '0', 'status'],
      ['knownGaps'],
    ];
    for (const path of paths) {
      let current: unknown = template;
      for (const part of path) {
        if (Array.isArray(current)) {
          current = current[Number(part)];
        } else {
          current = asRecord(current, path.join('.'))[part];
        }
      }
      expect(current, `模板缺少 ${path.join('.')}`).toBeDefined();
    }
    for (const token of [
      'Git SHA',
      '包版本',
      '协议范围',
      'Schema',
      '制品摘要',
      '检查退出码',
      '证据位置',
      '已知缺口',
      'not_run',
      'passed',
      'delivered',
      'P08-4',
      '凭据',
    ]) {
      expect(doc, `模板文档缺少「${token}」`).toContain(token);
    }
  });

  it('变更说明记录三包版本、P08-1 范围、未发布状态和兼容范围', () => {
    const changelog = readText(CHANGELOG);
    for (const token of [
      '0.0.0',
      'P08-1',
      'local-pack-only',
      'published: false',
      'shiploop-core',
      'shiploop-host',
      'shiploop-cli',
      'F-001',
      'F-007',
      'not_run',
    ]) {
      expect(changelog, `变更说明缺少「${token}」`).toContain(token);
    }
  });
});

describe('F-007 文档脱敏与交付报告边界', () => {
  it('新增文档与清单不含开发机路径、Harness 私有目录或凭据形态', () => {
    for (const file of NEW_DOC_FILES) {
      const text = readText(file);
      expect(text, `${file} 不得包含开发机绝对路径`).not.toMatch(/\/Users\/[^/\s]+/);
      expect(text, `${file} 不得指向 Harness 私有运行目录`).not.toMatch(
        /shiploop-harness|workspace\/features|\.dag_context\.json/,
      );
      expect(text, `${file} 不得包含凭据形态`).not.toMatch(
        /npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/,
      );
      expect(text, `${file} 不得包含私钥`).not.toContain('-----BEGIN');
    }
  });

  it('交付报告列出代码提交、局部检查、Feature/Phase not_run 且声明不替代 P08-4', () => {
    const report = readText(DELIVERY_REPORT);
    const manifest = readJson(MANIFEST);
    const identity = asRecord(manifest['identity'], 'identity');
    expect(report).toContain(String(identity['gitCommit']));
    expect(report).toContain('feat/2026-11-02-14-56-22_p08-1');
    expect(report).toContain(MANIFEST);
    expect(report).toContain('P08-4');

    for (const taskId of ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007']) {
      expect(report).toContain(taskId);
    }
    for (const token of [
      '代码交付',
      'Task 局部单元检查',
      'Feature 门禁',
      'P08 Phase 集成',
      'not_run',
      '真实三包安装',
      'Host/CLI',
      '协议兼容',
      '进程清理',
      'Todo',
      '存量',
      '不替代',
      '人工确认',
      'live',
    ]) {
      expect(report, `交付报告缺少「${token}」`).toContain(token);
    }
    expect(report).not.toMatch(/P08\s*阶段(已)?通过/);
  });

  it('支持矩阵与制品检查说明保留 not_run、不发布和真实检查入口', () => {
    const matrix = readText(SUPPORT_MATRIX);
    for (const token of [
      'macOS',
      '22.19.0',
      '10.9.3',
      'wireProtocolVersions',
      'writableTargetVersion',
      'local-pack-only',
      'not_run',
      'P08-4',
      'npm publish',
    ]) {
      expect(matrix, `支持矩阵缺少「${token}」`).toContain(token);
    }

    const artifactDoc = readText(ARTIFACT_DOC);
    for (const token of [
      'npm run pack:local',
      'npm run verify:artifacts',
      'artifact-verification.json',
      'distribution-manifest.json',
      'passed',
      'failed',
      'not_run',
      '退出码',
      '不发布',
    ]) {
      expect(artifactDoc, `制品检查说明缺少「${token}」`).toContain(token);
    }
  });
});

describe('F-007 测试索引接线', () => {
  it('F-007 索引为 v2 unit 且 Feature 索引与 test/stages.json 同步登记', () => {
    const index = readJson('test/index/phases/P08/features/P08-1/tasks/F-007.json');
    expect(index['schema_version']).toBe(2);
    expect(index['task_id']).toBe('F-007');
    const projects = asArray(index['projects'], 'projects').map((entry, position) =>
      asRecord(entry, `projects[${position}]`),
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]?.['id']).toBe('shiploop');
    const tests = asArray(projects[0]?.['tests'], 'tests').map((entry, position) =>
      asRecord(entry, `tests[${position}]`),
    );
    const selected = tests.find(
      (entry) => entry['file'] === 'test/modules/engineering/p08-1-f007-release-manifest-docs.test.ts',
    );
    expect(selected, '索引必须登记 F-007 守护测试').toBeDefined();
    expect(selected?.['all']).toBe(true);
    expect(selected?.['level']).toBe('unit');
    expect(existsSync(resolve(REPO_ROOT, String(selected?.['file'])))).toBe(true);

    const feature = readJson('test/index/phases/P08/features/P08-1/feature.json');
    const tasks = asArray(feature['tasks'], 'feature.tasks').map((entry) =>
      asRecord(entry, 'feature.tasks[]'),
    );
    expect(tasks).toContainEqual({
      task_id: 'F-007',
      index: 'test/index/phases/P08/features/P08-1/tasks/F-007.json',
    });

    const stages = readJson('test/stages.json');
    expect(asArray(stages['standard'], 'stages.standard')).toContain(
      'test/modules/engineering/p08-1-f007-release-manifest-docs.test.ts',
    );
  });
});
