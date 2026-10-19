/**
 * F-020 文档守护：`docs/acceptance/p02-3-f020-report.md` 与脱敏证据
 * `docs/acceptance/evidence-p02-3/f020-verification-evidence.md` 的交付报告核对。
 *
 * 依据 F-020 验收标准逐项守护：
 * 1. 报告记录实现范围、输入需求/核对契约摘要、完整受测代码 commit、Node/npm/平台
 *    版本、实际命令及退出码、测试/证据路径、通过/失败/not_run 计数和已知缺口；
 * 2. FR-1/FR-2 正常和关键失败分支逐项关联实际测试及证据，特别包含源文件不变、
 *    授权内容、进程树已停止、拒绝零启动、重启可查询和重复请求无副作用；
 * 3. 报告核对新增测试进入 npm test/verify，并记录迁移、认证、固定回环、
 *    public import 与构建回归结论；
 * 4. 报告与证据不含真实凭据/认证头/用户文件正文（无开发机绝对路径、Bearer 值、
 *    64hex 秘密），记录临时资源/进程清理，明确未调用真实 Pi、未验收其他平台及
 *    整阶段，且只记录 Harness 验证策略建议（不改 executor/agent YAML、不自动
 *    合并或代替人工放行）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_DOC_PATH = 'docs/acceptance/p02-3-f020-report.md';
const EVIDENCE_DOC_PATH = 'docs/acceptance/evidence-p02-3/f020-verification-evidence.md';
const README_PATH = 'README.md';

function readDoc(relativePath: string): string {
  const absolute = resolve(REPO_ROOT, relativePath);
  expect(existsSync(absolute), `${relativePath} 必须存在`).toBe(true);
  return readFileSync(absolute, 'utf-8');
}

describe('F-020 文档守护：P02-3 交付报告、FR 验收索引与脱敏证据', () => {
  it('报告记录实现范围、输入契约、受测 commit、版本、命令退出码、证据路径、计数与已知缺口', () => {
    const report = readDoc(REPORT_DOC_PATH);

    // 实现范围：F-001 ~ F-020 全任务清单。
    for (const taskId of ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008', 'F-009', 'F-010', 'F-011', 'F-012', 'F-013', 'F-014', 'F-015', 'F-016', 'F-017', 'F-018', 'F-019', 'F-020']) {
      expect(report, taskId).toContain(taskId);
    }

    // 输入需求/核对契约摘要。
    for (const token of ['p02-onboarding.md', 'p02-3-onboarding-contract.md', 'execution-contract.md', 'FR-1', 'FR-2']) {
      expect(report, token).toContain(token);
    }

    // 完整受测代码 commit（40 hex）与工具链/平台版本。
    expect(report).toContain('fdacf2571da66f5b04a8be15516516eefbf61966');
    for (const token of ['22.19.0', '10.9.3', 'macOS', 'arm64']) {
      expect(report, token).toContain(token);
    }

    // 实际命令及退出码。
    for (const token of [
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run verify',
      'npm run check:boundaries',
      'git diff --check',
      '退出码',
    ]) {
      expect(report, token).toContain(token);
    }

    // 测试/证据路径与计数/缺口。
    for (const token of [
      EVIDENCE_DOC_PATH,
      'tool-logs/',
      '101 files / 2709 tests',
      '通过',
      '失败',
      'not_run',
      '已知缺口',
    ]) {
      expect(report, token).toContain(token);
    }
  });

  it('FR-1/FR-2 正常与关键失败分支逐项关联实际测试文件，含六项关键证据', () => {
    const report = readDoc(REPORT_DOC_PATH);

    // 六项特别要求的关键证据标签。
    for (const token of [
      '源文件不变',
      '授权内容',
      '进程树已停止',
      '拒绝零启动',
      '重启可查询',
      '重复请求无副作用',
    ]) {
      expect(report, token).toContain(token);
    }

    // 报告引用的每个 *.test.ts 都真实存在（防止虚构用例；兼容带/不带 test/ 前缀）。
    const referenced = new Set(
      (report.match(/(?:test\/)?(?:modules\/[a-z0-9/-]+\/)?[a-z0-9-]+\.test\.ts/g) ?? []).map((name) =>
        name.replace(/^test\//, ''),
      ),
    );
    expect(referenced.size).toBeGreaterThanOrEqual(10);
    for (const testFile of referenced) {
      expect(
        existsSync(resolve(REPO_ROOT, 'test', testFile)),
        `test/${testFile} 必须真实存在`,
      ).toBe(true);
    }

    // 证据文档同样按 FR-1/FR-2 组织并覆盖六项标签。
    const evidence = readDoc(EVIDENCE_DOC_PATH);
    for (const token of ['FR-1', 'FR-2', '源文件不变', '进程树已停止', '拒绝零启动', '重启可查询', '重复请求无副作用']) {
      expect(evidence, token).toContain(token);
    }
  });

  it('报告核对新增测试进入 npm test/verify，并记录前序迁移/认证/回环/public import/构建回归', () => {
    const report = readDoc(REPORT_DOC_PATH);
    for (const token of [
      'modules/onboarding/p02-3-integration-regression.test.ts',
      'npm test',
      'verify',
      '迁移',
      '认证',
      '回环',
      'public import',
      '构建',
    ]) {
      expect(report, token).toContain(token);
    }
  });

  it('报告与证据脱敏（无开发机路径/凭据/认证头/用户文件正文），记录清理与范围边界', () => {
    const report = readDoc(REPORT_DOC_PATH);
    const evidence = readDoc(EVIDENCE_DOC_PATH);

    for (const [name, doc] of [
      ['report', report],
      ['evidence', evidence],
    ] as const) {
      expect(doc, `${name} 不含开发机绝对路径`).not.toContain('/Users/');
      expect(doc, `${name} 不含 64hex 秘密形状`).not.toMatch(/[0-9a-f]{64}/);
      expect(doc, `${name} 不含 Bearer 凭据值`).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
      expect(doc, `${name} 不含认证头取值`).not.toMatch(/authorization['"`]?\s*[:=]\s*['"`]?[A-Za-z0-9._-]{8,}/i);
    }

    // 范围边界与交接纪律。
    for (const token of [
      '未调用真实 Pi',
      'not_run',
      'accept:p02',
      'macOS',
      '不自动合并',
      '人工放行',
      'YAML',
      '清理',
    ]) {
      expect(report, token).toContain(token);
    }

    // README 登记交付报告与证据入口。
    const readme = readDoc(README_PATH);
    expect(readme).toContain(REPORT_DOC_PATH);
    expect(readme).toContain(EVIDENCE_DOC_PATH);
    expect(readme).not.toContain('/Users/');
  });
});
