/**
 * P08-4 / F-008 一期能力矩阵、交付报告模板与负责人 walkthrough 守护。
 *
 * 验收映射（.dag_context.json F-008 五项）：
 * 1) 能力矩阵列出 Core/Host/CLI/Pi Work、macOS/Node/npm、协议/Schema、安装产物摘要字段
 *    与不支持的 Chat/Electron/云/其他 Runtime 能力。
 * 2) 交付报告模板要求 commit、工具版本、实际命令与退出码、范围与预算、证据路径、
 *    pass/fail/not_run/deferred 计数、人工状态和遗留问题，禁止凭据与私密认证内容。
 * 3) walkthrough 覆盖干净安装目录启动打包 CLI、Todo 新项目、存量仓库演示核对点，以及
 *    基线脏文件、已有失败、清理、停止未确认和 Live 缺失处理。
 * 4) 文档与报告入口链接指向仓库内真实存在或本 Feature 新增的路径，不引用 Harness
 *    私有运行目录；不把文档、测试数量或 Nezha 状态当签署依据。
 * 5) 局部验证覆盖 Markdown 链接、能力矩阵字段、示例脱敏和报告 schema；真实演示与
 *    负责人确认不在本文档 Task 内宣称通过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const MATRIX = 'docs/p08-capability-matrix.md';
const REPORT_TEMPLATE = 'docs/acceptance/p08-delivery-report-template.md';
const WALKTHROUGH = 'docs/acceptance/p08-owner-walkthrough.md';
const NEW_DOCS = [MATRIX, REPORT_TEMPLATE, WALKTHROUGH] as const;
const README_NAV_HEADING = '## P08 一期总验收文档导航';

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

function fencedJsonBlocks(markdown: string): JsonRecord[] {
  const blocks: JsonRecord[] = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    blocks.push(JSON.parse(match[1] as string) as JsonRecord);
  }
  return blocks;
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

function requirePath(record: JsonRecord, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    current = asRecord(current, path.join('.'))[key];
  }
  expect(current, `缺少字段 ${path.join('.')}`).toBeDefined();
  return current;
}

interface MarkdownLink {
  readonly source: string;
  readonly target: string;
  readonly path: string;
}

function relativeLinks(source: string, markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1] as string;
    if (/^(?:https?:)?\/\//.test(target) || target.startsWith('#')) continue;
    links.push({ source, target, path: target.split('#')[0] as string });
  }
  return links;
}

function assertNoPrivateReferences(relativePath: string): void {
  const text = readText(relativePath);
  expect(text, `${relativePath} 不得包含开发机绝对路径`).not.toMatch(/\/Users\/[^/\s]+/);
  expect(text, `${relativePath} 不得引用 Harness 私有运行目录`).not.toMatch(
    /shiploop-harness|workspace\/features|state\/acceptance|\.dag_context\.json/,
  );
  expect(text, `${relativePath} 不得包含凭据形态`).not.toMatch(
    /npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/,
  );
  expect(text, `${relativePath} 不得包含私钥`).not.toContain('-----BEGIN');
  expect(text, `${relativePath} 不得包含 Bearer 认证头`).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/);
}

it('[case:p08-f008-links] README 导航和新增文档的相对链接都指向仓库内真实路径', () => {
  const readme = readText('README.md');
  const nav = section(readme, README_NAV_HEADING);
  expect(nav.length, `README 必须有「${README_NAV_HEADING}」章节`).toBeGreaterThan(0);

  for (const target of [MATRIX, REPORT_TEMPLATE, WALKTHROUGH]) {
    expect(nav, `README 导航缺少 ${target}`).toContain(`](${target})`);
    expect(existsSync(resolve(REPO_ROOT, target)), `${target} 必须存在`).toBe(true);
  }

  const links = [...relativeLinks('README.md', nav), ...NEW_DOCS.flatMap((file) => relativeLinks(file, readText(file)))];
  expect(links.length).toBeGreaterThan(10);
  for (const link of links) {
    expect(link.target, `${link.source} 链接不得指向 Harness 私有目录`).not.toMatch(
      /shiploop-harness|workspace\/features|state\/acceptance/,
    );
    const base = link.source === 'README.md' ? REPO_ROOT : dirname(resolve(REPO_ROOT, link.source));
    expect(existsSync(resolve(base, link.path)), `${link.source} 的链接目标不存在：${link.target}`).toBe(true);
  }
});

it('[case:p08-f008-matrix] 能力矩阵覆盖能力域、平台/工具链、协议/Schema、安装摘要与不支持项', () => {
  const matrix = readText(MATRIX);
  const compatibility = readJson('distribution-compatibility.json');
  const rootPackage = readJson('package.json');

  for (const token of ['Core', 'Host', 'CLI', 'Pi Work', 'macOS', 'darwin', 'Windows', 'WSL', 'Linux']) {
    expect(matrix, `能力矩阵缺少「${token}」`).toContain(token);
  }

  const hostProtocol = asRecord(compatibility['hostProtocol'], 'hostProtocol');
  const databaseSchema = asRecord(compatibility['databaseSchema'], 'databaseSchema');
  const toolchain = asRecord(rootPackage['engines'], 'engines');
  const requiredValues: readonly (readonly [string, string])[] = [
    ['wireProtocolVersions', JSON.stringify(hostProtocol['wireProtocolVersions'])],
    ['wireSchemaVersion', String(hostProtocol['wireSchemaVersion'])],
    ['legacyHandshakeSchemaVersionsAccepted', JSON.stringify(hostProtocol['legacyHandshakeSchemaVersionsAccepted'])],
    ['discoverySchemaVersions', JSON.stringify(hostProtocol['discoverySchemaVersions'])],
    ['unknownVersionPolicy', String(hostProtocol['unknownVersionPolicy'])],
    ['engine', String(databaseSchema['engine'])],
    ['writableTargetVersion', String(databaseSchema['writableTargetVersion'])],
    ['higherVersionPolicy', String(databaseSchema['higherVersionPolicy'])],
    ['Node.js', String(toolchain['node'])],
    ['npm', String(toolchain['npm'])],
  ];
  for (const [label, value] of requiredValues) {
    expect(matrix, `能力矩阵缺少「${label}」`).toContain(label);
    expect(matrix, `能力矩阵的「${label}」与冻结声明不一致：${value}`).toContain(value);
  }
  expect(matrix).toContain('package-lock.json');
  expect(matrix).toContain('local-pack-only');

  for (const token of [
    'gitCommit',
    'platform',
    'toolchain',
    'compatibility',
    'artifacts',
    'sha256',
    'packageManifestSha256',
    'fileDigests',
    'distribution-manifest.json',
    'artifact-verification.json',
    'checks',
    'notRun',
    'evidence',
    'summary',
    'phase-integration',
    'P08_INSTALL_CHECK_NOT_RUN',
  ]) {
    expect(matrix, `能力矩阵缺少安装摘要字段「${token}」`).toContain(token);
  }

  for (const token of [
    'Chat',
    'Electron',
    '云端',
    '其他 Runtime',
    '强 OS 沙箱',
    'npm publish',
    'nativeHistory',
    'conversationResume',
    'executionRecovery',
    'modelSwitchOnResume',
    'nativeFork',
    'not_run',
    'deferred',
  ]) {
    expect(matrix, `能力矩阵缺少不支持/状态说明「${token}」`).toContain(token);
  }
});

it('[case:p08-f008-report-template] 交付报告模板包含必需字段、计数规则与可解析的报告骨架', () => {
  const template = readText(REPORT_TEMPLATE);

  for (const token of [
    '受测 commit',
    '工具版本',
    '实际命令与退出码',
    '范围与预算',
    '证据索引',
    'pass',
    'fail',
    'not_run',
    'deferred',
    '人工 pending',
    '遗留问题',
    '凭据',
    '脱敏',
    'phaseAccepted',
    'ownerSignature',
    'P08-MANUAL-OWNER-GATE',
    'verifyP08ReportDirectory',
    'summary.md',
    'create-once',
  ]) {
    expect(template, `交付报告模板缺少「${token}」`).toContain(token);
  }

  const blocks = fencedJsonBlocks(template);
  expect(blocks.length, '模板必须包含报告与人工门禁的 JSON 骨架').toBeGreaterThanOrEqual(2);
  const report = blocks.find((block) => block['kind'] === 'shiploop.p08.acceptance-report');
  expect(report, '缺少 shiploop.p08.acceptance-report 骨架').toBeDefined();
  const reportRecord = asRecord(report, 'report');

  const requiredPaths: readonly (readonly string[])[] = [
    ['schemaVersion'],
    ['phase'],
    ['layer'],
    ['identity', 'runId'],
    ['identity', 'testedCommit'],
    ['identity', 'inputsDigest'],
    ['identity', 'toolchain', 'node'],
    ['identity', 'toolchain', 'npm'],
    ['identity', 'toolchain', 'platform'],
    ['checklistDigest'],
    ['testScope', 'policy'],
    ['testScope', 'selected'],
    ['testScope', 'selectedReasons'],
    ['testScope', 'requiredRegressions'],
    ['testScope', 'deferred'],
    ['testScope', 'fullRegression', 'status'],
    ['counts', 'pass'],
    ['counts', 'fail'],
    ['counts', 'not_run'],
    ['layers'],
    ['checks'],
    ['productReports'],
    ['blockingIssues'],
    ['knownGaps'],
    ['conclusion'],
    ['exitCode'],
    ['baseline', 'candidateCommit'],
    ['baseline', 'phaseAccepted'],
    ['baseline', 'ownerSignature'],
  ];
  for (const path of requiredPaths) requirePath(reportRecord, path);
  expect(reportRecord['schemaVersion']).toBe(1);
  expect(reportRecord['phase']).toBe('P08');
  expect(reportRecord['layer']).toBe('phase-acceptance');
  expect(requirePath(reportRecord, ['baseline', 'phaseAccepted'])).toBe(false);
  expect(requirePath(reportRecord, ['baseline', 'ownerSignature'])).toBe('pending');
  expect(requirePath(reportRecord, ['identity', 'toolchain', 'node'])).toBe('22.19.0');
  expect(requirePath(reportRecord, ['identity', 'toolchain', 'npm'])).toBe('10.9.3');
  expect(requirePath(reportRecord, ['identity', 'toolchain', 'platform'])).toBe('darwin');

  const deferred = asArray(requirePath(reportRecord, ['testScope', 'deferred']), 'testScope.deferred');
  expect(asRecord(deferred[0], 'deferred[0]')['status']).toBe('not_run');
  const layers = asArray(requirePath(reportRecord, ['layers']), 'layers');
  expect(asRecord(layers[0], 'layers[0]')['status']).toBe('not_run');
  const checks = asArray(requirePath(reportRecord, ['checks']), 'checks');
  expect(asRecord(checks[0], 'checks[0]')['id']).toMatch(/^P08-/);

  const manual = blocks.find((block) => block['kind'] === 'shiploop.p08.manual-gate-record');
  expect(manual, '缺少 shiploop.p08.manual-gate-record 骨架').toBeDefined();
  const manualRecord = asRecord(manual, 'manual');
  expect(requirePath(manualRecord, ['schemaVersion'])).toBe(1);
  expect(requirePath(manualRecord, ['status'])).toBe('pending');
  expect(requirePath(manualRecord, ['confirmedAtUtcMs'])).toBeNull();
  for (const path of [['identity', 'runId'], ['identity', 'testedCommit'], ['identity', 'inputsDigest'], ['owner']]) {
    requirePath(manualRecord, path);
  }
});

it('[case:p08-f008-walkthrough] walkthrough 覆盖干净安装、两类项目与例外处理，且不宣称通过', () => {
  const walkthrough = readText(WALKTHROUGH);

  for (const token of [
    '干净安装目录',
    '打包 CLI',
    'shiploop host --help',
    'Todo',
    '存量仓库',
    '基线脏文件',
    '已有失败',
    'known_failure',
    '清理',
    'cleanup_unconfirmed',
    '停止未确认',
    'stop_not_confirmed',
    'Live 缺失',
    'not_run',
    'FakeRuntime',
    '负责人确认',
    'pending',
    'accept:p08',
    'artifacts/acceptance/p08',
    'reports/<runId>/report.json',
    'phaseAccepted=false',
    'ownerSignature=pending',
    'P08-MANUAL-OWNER-GATE',
  ]) {
    expect(walkthrough, `walkthrough 缺少「${token}」`).toContain(token);
  }

  expect(walkthrough).not.toMatch(/P08\s*阶段(?:已)?通过/);
  expect(walkthrough).not.toMatch(/phaseAccepted\s*[:=]\s*true/);
  expect(walkthrough).not.toMatch(/ownerSignature\s*[:=]\s*['"]confirmed['"]/);
  expect(walkthrough).toContain('不能代替签署');
});

it('[case:p08-f008-redaction-boundary] 新增文档与 JSON 示例不含私密认证、绝对路径或“已签署”状态', () => {
  for (const file of NEW_DOCS) {
    assertNoPrivateReferences(file);
    for (const block of fencedJsonBlocks(readText(file))) {
      const text = JSON.stringify(block);
      expect(text, `${file} 的 JSON 示例不得包含凭据形态`).not.toMatch(
        /npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/,
      );
      expect(text, `${file} 的 JSON 示例不得包含绝对路径`).not.toMatch(/\/Users\/[^/\s]+/);
    }
  }

  const combined = NEW_DOCS.map(readText).join('\n');
  expect(combined).not.toMatch(/测试数量[^\n]{0,20}(?:即|就是|等于)[^\n]{0,10}通过/);
  expect(combined).not.toMatch(/nezha[^\n]{0,20}(?:完成|completed)[^\n]{0,20}(?:即|就是|等于)[^\n]{0,10}通过/i);
});

it('[case:p08-f008-index] F-008 索引为 v2 unit，并同步到 Feature 索引与 test/stages.json', () => {
  const index = readJson('test/index/phases/P08/features/P08-4/tasks/F-008.json');
  expect(index['schema_version']).toBe(2);
  expect(index['task_id']).toBe('F-008');
  const projects = asArray(index['projects'], 'projects').map((entry, position) =>
    asRecord(entry, `projects[${position}]`),
  );
  expect(projects).toHaveLength(1);
  expect(projects[0]?.['id']).toBe('shiploop');
  const tests = asArray(projects[0]?.['tests'], 'tests').map((entry, position) =>
    asRecord(entry, `tests[${position}]`),
  );
  const selected = tests.find(
    (entry) => entry['file'] === 'test/modules/acceptance/p08-4-f008-docs.test.ts',
  );
  expect(selected, '索引必须登记 F-008 守护测试').toBeDefined();
  expect(selected?.['all']).toBe(true);
  expect(selected?.['level']).toBe('unit');
  expect(existsSync(resolve(REPO_ROOT, String(selected?.['file'])))).toBe(true);

  const feature = readJson('test/index/phases/P08/features/P08-4/feature.json');
  const tasks = asArray(feature['tasks'], 'feature.tasks').map((entry) => asRecord(entry, 'feature.tasks[]'));
  expect(tasks).toContainEqual({
    task_id: 'F-008',
    index: 'test/index/phases/P08/features/P08-4/tasks/F-008.json',
  });

  const stages = readJson('test/stages.json');
  const staged = [...asArray(stages['light'], 'stages.light'), ...asArray(stages['standard'], 'stages.standard')];
  expect(staged).toContain('test/modules/acceptance/p08-4-f008-docs.test.ts');
});
