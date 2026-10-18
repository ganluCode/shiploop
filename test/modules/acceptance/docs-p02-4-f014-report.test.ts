/**
 * F-014 文档守护：P02-4 Feature 交付报告、P02 阶段报告与脱敏验证记录核对。
 *
 * 依据 F-014 验收标准逐项守护：
 * 1. 两份报告记录实现范围（F-001 ~ F-014）、输入计划摘要（PRD/共同执行约束 + 内容
 *    哈希）、工具版本、完整受测 commit 与工作树状态、实际命令（`npm run verify` /
 *    `npm run accept:p02`）与退出码 0、报告提交与受测代码身份的明确区分、逐项
 *    pass/fail/not_run 计数、实际耗时/资源限制、证据路径、遗留问题与 P03 候选基线；
 * 2. 负例矩阵覆盖全部 expectedNegative 必需检查，每行携带拒绝/错误、状态与意外
 *    副作用核对（与契约断言三轴 error/zeroStart/persistentState 对齐）；
 * 3. 新场景进入 npm test/verify 与阶段必需清单（`acceptance/p02.config.json` ↔
 *    `P02_REQUIRED_CHECKS` 逐项一致、测试入口存在），P01/P02 前序回归文件未删除、
 *    无 it/describe/test 的 skip/only 调用；
 * 4. 报告与证据脱敏（无 token/认证头/64hex 秘密/用户文件正文/开发机绝对路径），
 *    证据完整性复验与临时进程/资源清理记录在 verification-record；缺失/未运行
 *    不折算通过；
 * 5. 边界声明：未运行真实 Pi、未验收 Windows/WSL/Linux 与强沙箱、后序能力未实现；
 *    未解决核对或必需检查非通过时保留未完成、不自动合并/启动下一 Phase/代替人工放行；
 * 6. README 登记两份报告与脱敏验证记录。
 *
 * 只断言稳定契约内容（结构、清单一致性、边界声明、脱敏）；单次运行的 run-id/时刻
 * 等易变记录由 `docs/acceptance/evidence-p02-4-final/verification-record.md` 承载，
 * 以最终逐项复验（报告引用、证据 hash/size、进程清理）为准。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P02_REQUIRED_CHECKS, P02_REQUIRED_CHECK_IDS } from '../../../scripts/acceptance/p02-report.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_DOC_PATH = 'docs/acceptance/p02-4-f014-report.md';
const STAGE_REPORT_PATH = 'docs/acceptance/p02-stage-report.md';
const RECORD_DOC_PATH = 'docs/acceptance/evidence-p02-4-final/verification-record.md';
const README_PATH = 'README.md';
const CONFIG_PATH = 'acceptance/p02.config.json';

function readDoc(relativePath: string): string {
  const absolute = resolve(REPO_ROOT, relativePath);
  expect(existsSync(absolute), `${relativePath} 必须存在`).toBe(true);
  return readFileSync(absolute, 'utf-8');
}

/** 前序回归测试文件（P01 / P02-1 / P02-2 / P02-3 / P02-4 交付入口）不得被删除。 */
const REGRESSION_TEST_FILES: readonly string[] = [
  'test/modules/acceptance/p01-3-fr-acceptance-closed-loop.test.ts',
  'test/modules/acceptance/p01-4-persistence-closed-loop.test.ts',
  'test/modules/acceptance/p01-4-acceptance-controller.test.ts',
  'test/modules/acceptance/p01-4-sqlite-rollback-and-cas.test.ts',
  'test/modules/host/p02-1-integration-regression.test.ts',
  'test/modules/commands/p02-2-integration-regression.test.ts',
  'test/modules/onboarding/p02-3-integration-regression.test.ts',
  'test/modules/onboarding/p02-3-baseline-host-routes.test.ts',
  'test/modules/acceptance/p02-4-dual-cli-acceptance.test.ts',
  'test/modules/acceptance/p02-4-idempotency-acceptance.test.ts',
  'test/modules/acceptance/p02-4-repo-preservation-acceptance.test.ts',
  'test/modules/acceptance/p02-4-negative-acceptance.test.ts',
  'test/modules/acceptance/p02-4-restart-acceptance.test.ts',
  'test/modules/acceptance/p02-4-baseline-failure-acceptance.test.ts',
  'test/modules/acceptance/p02-4-acceptance-controller.test.ts',
  'test/modules/acceptance/p02-4-report-aggregation.test.ts',
  'test/modules/acceptance/p02-4-acceptance-report.test.ts',
  'test/modules/acceptance/p02-4-clean-replay.test.ts',
];

describe('F-014 文档守护：P02 交付/阶段报告、负例矩阵与脱敏证据记录', () => {
  it('最终统计区分首次验证与回填后验证，迁移包含 v5', () => {
    for (const path of [REPORT_DOC_PATH, STAGE_REPORT_PATH]) {
      const doc = readDoc(path);
      expect(doc).toContain('117 files / 2970 tests');
      expect(doc).toContain('116 files / 2961 tests');
      expect(doc).toContain('SQLite 迁移 v1-v5');
    }
  });
  it('两份报告记录实现范围、输入计划摘要、工具版本、命令退出码、计数、耗时/资源、证据路径、遗留问题与 P03 候选基线', () => {
    for (const path of [REPORT_DOC_PATH, STAGE_REPORT_PATH]) {
      const doc = readDoc(path);

      // 实现范围：F-001 ~ F-014 全任务清单（阶段报告同时覆盖 P02-1 ~ P02-4）。
      for (const taskId of [
        'F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008',
        'F-009', 'F-010', 'F-011', 'F-012', 'F-013', 'F-014',
      ]) {
        expect(doc, `${path} 应包含 ${taskId}`).toContain(taskId);
      }

      // 输入计划摘要：PRD/共同执行约束与内容哈希（缩写）。
      for (const token of ['p02-acceptance.md', 'execution-contract.md', '016888a6', '89dcd2b2']) {
        expect(doc, `${path} 应包含 ${token}`).toContain(token);
      }

      // 工具链与平台版本。
      for (const token of ['22.19.0', '10.9.3', '7.0.2', '5.0.3', '13.0.3', '0.45.3', '26.6.2', 'arm64']) {
        expect(doc, `${path} 应包含 ${token}`).toContain(token);
      }

      // 实际命令与退出码 0；逐项计数（15 必需检查全过）。
      for (const token of ['npm run verify', 'npm run accept:p02', '退出码 0', 'pass 15 / fail 0 / not_run 0']) {
        expect(doc, `${path} 应包含 ${token}`).toContain(token);
      }

      // 受测 commit（完整 40hex）、工作树状态、报告提交与受测代码身份区分。
      expect(doc, `${path} 应含完整受测 commit`).toMatch(/[0-9a-f]{40}/);
      for (const token of ['工作树', '受测', '报告提交', '不改变产品代码']) {
        expect(doc, `${path} 应包含 ${token}`).toContain(token);
      }

      // 实际耗时/资源限制、证据路径、遗留问题、P03 候选基线。
      for (const token of [
        '实际耗时', '资源限制', 'tool-logs/', 'artifacts/acceptance/p02/',
        'docs/acceptance/evidence-p02-4-clean-replay/', '遗留问题', 'P03 候选基线',
      ]) {
        expect(doc, `${path} 应包含 ${token}`).toContain(token);
      }
    }
  });

  it('阶段报告逐项覆盖 15 个必需检查，逐项结果为 pass 且映射实际测试入口', () => {
    const stage = readDoc(STAGE_REPORT_PATH);
    for (const checkId of P02_REQUIRED_CHECK_IDS) {
      expect(stage, `阶段报告应逐项列出 ${checkId}`).toContain(checkId);
    }
    for (const definition of P02_REQUIRED_CHECKS) {
      if (definition.testEntry.startsWith('test/')) {
        expect(stage, `阶段报告应映射入口 ${definition.testEntry}`).toContain(definition.testEntry);
        expect(existsSync(resolve(REPO_ROOT, definition.testEntry)), `${definition.testEntry} 必须存在`).toBe(true);
      }
    }
  });

  it('负例矩阵覆盖全部 expectedNegative 检查，每行含拒绝/错误、状态与意外副作用核对', () => {
    const stage = readDoc(STAGE_REPORT_PATH);
    const matrixStart = stage.indexOf('负例核对矩阵');
    expect(matrixStart, '阶段报告应含负例核对矩阵').toBeGreaterThan(0);
    const matrixSection = stage.slice(matrixStart);
    const negatives = P02_REQUIRED_CHECKS.filter((definition) => definition.expectedNegative);
    expect(negatives.length).toBeGreaterThanOrEqual(6);
    for (const definition of negatives) {
      const row = matrixSection
        .split('\n')
        .find((line) => line.startsWith(`| \`${definition.id}\``));
      expect(row, `负例矩阵应有 ${definition.id} 行`).toBeDefined();
      const text = String(row);
      expect(text, `${definition.id} 行应含核对标记`).toContain('✔');
      expect(
        (text.match(/✔/g) ?? []).length,
        `${definition.id} 行核对标记应覆盖 ${definition.requiredAssertions.length} 类断言`,
      ).toBeGreaterThanOrEqual(definition.requiredAssertions.length);
      if (definition.requiredAssertions.includes('error')) {
        expect(text, `${definition.id} 应含拒绝/错误断言`).toMatch(/拒绝|错误/);
      }
      if (definition.requiredAssertions.includes('zeroStart')) {
        expect(text, `${definition.id} 应含零启动/零副作用核对`).toMatch(/零启动|零副作用/);
      }
      if (definition.requiredAssertions.includes('persistentState')) {
        expect(text, `${definition.id} 应含持久状态核对`).toContain('持久状态');
      }
    }
  });

  it('必需检查清单与版本化配置逐项一致，场景入口全部存在', () => {
    const config = JSON.parse(readFileSync(resolve(REPO_ROOT, CONFIG_PATH), 'utf-8')) as {
      requiredChecks: unknown;
      scenarios: readonly { id: string; kind: string; entry: string; checkIds: readonly string[] }[];
    };
    expect(config.requiredChecks).toEqual([...P02_REQUIRED_CHECK_IDS]);
    for (const scenario of config.scenarios) {
      if (scenario.kind === 'test') {
        expect(existsSync(resolve(REPO_ROOT, scenario.entry)), `${scenario.entry} 必须存在`).toBe(true);
      }
    }
    // 检查 ID ↔ 场景 checkIds 双向覆盖：无必需检查落在场景清单之外。
    const mapped = config.scenarios.flatMap((scenario) => scenario.checkIds);
    expect(mapped).toEqual([...P02_REQUIRED_CHECK_IDS]);
  });

  it('P01/P02 前序回归测试文件未删除，全部测试文件无 skip/only 调用', () => {
    for (const relativePath of REGRESSION_TEST_FILES) {
      expect(existsSync(resolve(REPO_ROOT, relativePath)), `${relativePath} 不得被删除`).toBe(true);
    }
    const testFiles = readdirSync(resolve(REPO_ROOT, 'test'), { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.test.ts'));
    expect(testFiles.length).toBeGreaterThanOrEqual(REGRESSION_TEST_FILES.length);
    const callPattern = /^[ \t]*(?:it|test|describe)\.(?:skip|only)\(/m;
    for (const name of testFiles) {
      const source = readFileSync(resolve(REPO_ROOT, 'test', name), 'utf-8');
      expect(callPattern.test(source), `${name} 不得含 skip/only 调用`).toBe(false);
    }
  });

  it('验证记录含命令/退出码、受测 commit 与工作树状态、证据完整性复验与临时进程/资源清理', () => {
    const record = readDoc(RECORD_DOC_PATH);
    for (const token of [
      'npm run verify', 'npm run accept:p02', '退出码', 'git status --porcelain',
      'hash', 'size', '脱敏', '清理', '进程', '残留',
    ]) {
      expect(record, `验证记录应包含 ${token}`).toContain(token);
    }
    // 缺失/未运行不折算通过的语义必须显式保留。
    expect(record).toContain('不折算');
  });

  it('报告与证据脱敏：无 token/认证头/64hex 秘密/用户文件正文/开发机绝对路径', () => {
    const docs = [REPORT_DOC_PATH, STAGE_REPORT_PATH, RECORD_DOC_PATH].map(readDoc);
    for (const [index, text] of docs.entries()) {
      const label = [REPORT_DOC_PATH, STAGE_REPORT_PATH, RECORD_DOC_PATH][index] as string;
      expect(/[0-9a-f]{64}/.test(text), `${label} 不得含 64hex 秘密/完整摘要`).toBe(false);
      expect(/sk-[A-Za-z0-9_-]{8,}/.test(text), `${label} 不得含 token 形状`).toBe(false);
      expect(/Bearer\s+[A-Za-z0-9._-]{8,}/.test(text), `${label} 不得含认证头取值`).toBe(false);
      expect(/ARK_[A-Z_]*KEY|KIMI_API_KEY|api[_-]?key\s*[:=]/i.test(text), `${label} 不得含环境秘密名`).toBe(false);
      expect(text.includes('/Users/'), `${label} 不得含开发机绝对路径`).toBe(false);
    }
  });

  it('边界声明：未运行真实 Pi、未验收其他平台/强沙箱与后序能力；不代替人工放行', () => {
    for (const path of [REPORT_DOC_PATH, STAGE_REPORT_PATH]) {
      const doc = readDoc(path);
      for (const token of [
        '真实 Pi', 'Windows / WSL / Linux 未验收', '强沙箱',
        '不折算', '不自动合并', '不启动下一 Phase', '不代替人工放行',
      ]) {
        expect(doc, `${path} 应包含边界声明 ${token}`).toContain(token);
      }
    }
  });

  it('README 登记 P02-4 Feature 报告、P02 阶段报告与脱敏验证记录', () => {
    const readme = readDoc(README_PATH);
    for (const token of [
      'docs/acceptance/p02-4-f014-report.md',
      'docs/acceptance/p02-stage-report.md',
      'docs/acceptance/evidence-p02-4-final/verification-record.md',
    ]) {
      expect(readme, `README 应登记 ${token}`).toContain(token);
    }
  });
});
