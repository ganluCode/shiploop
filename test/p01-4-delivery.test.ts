/**
 * F-010 交付守护：干净安装复跑工具与 P01 阶段操作说明必须与真实实现一致。
 *
 * 本套件不重复执行完整干净复跑（那会递归运行 verify/accept:p01；完整复跑由
 * `scripts/acceptance/clean-snapshot-replay.ts` 作为阶段验收步骤真实执行）。这里只：
 *  - 交叉核对复跑工具的冻结步骤、脱敏与报告解析纯函数；
 *  - 核对操作说明引用的命令、检查 ID、配置字段与真实文件确实存在；
 *  - 守护文档/工具不含个人绝对路径、凭据或未实现的 CLI 业务命令。
 *
 * F-010 的交付报告与脱敏证据由后续文档提交补齐（见 `docs/acceptance/p01-4-f010-report.md`）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_STEPS,
  parseAcceptReportSummary,
  sanitizeEvidenceText,
  sha256Hex,
} from '../scripts/acceptance/clean-snapshot-replay.ts';
import { P01_REQUIRED_CHECKS } from '../scripts/acceptance/p01-report.ts';
import { P01_ACCEPT_CONFIG_PATH } from '../scripts/acceptance/p01-accept.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATIONS_DOC_PATH = 'docs/p01-4-operations.md';
const REPLAY_SCRIPT_PATH = 'scripts/acceptance/clean-snapshot-replay.ts';
const CONFIG_PATH = 'acceptance/p01.config.json';
const operationsDoc = readFileSync(resolve(REPO_ROOT, OPERATIONS_DOC_PATH), 'utf-8');
const replayScript = readFileSync(resolve(REPO_ROOT, REPLAY_SCRIPT_PATH), 'utf-8');
const config = JSON.parse(readFileSync(resolve(REPO_ROOT, CONFIG_PATH), 'utf-8')) as {
  configVersion: number;
  reportRoot: string;
  requiredChecks: string[];
  timeouts: Record<string, number>;
  plan: { contractDoc: string; version: string };
};

describe('F-010 干净安装复跑工具', () => {
  it('冻结步骤按验收命令顺序串行，且包含两次 accept:p01', () => {
    expect(REPLAY_STEPS.map((step) => step.id)).toEqual([
      'npm-ci',
      'npm-test',
      'typecheck',
      'build',
      'verify',
      'accept-1',
      'accept-2',
    ]);
    expect(REPLAY_STEPS.map((step) => step.label)).toEqual([
      'npm ci',
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run verify',
      'npm run accept:p01（第 1 次）',
      'npm run accept:p01（第 2 次，验证无残留依赖）',
    ]);
    expect(REPLAY_STEPS.flatMap((step) => step.npmArgs)).toContain('accept:p01');
    for (const step of REPLAY_STEPS) {
      expect(step.timeoutMs).toBeGreaterThan(0);
      expect(Number.isFinite(step.timeoutMs)).toBe(true);
    }
    // 两次 accept 运行各自独立，均可解析报告。
    expect(REPLAY_STEPS.filter((step) => step.isAcceptRun).map((step) => step.id)).toEqual([
      'accept-1',
      'accept-2',
    ]);
  });

  it('脱敏按最长前缀优先替换，不残留快照/仓库/用户目录绝对路径', () => {
    const replacements = {
      repoRoot: '/Users/example/work/repo',
      snapshotRoot: '/tmp/shiploop-p01-clean-abc/repo',
      homeDir: '/Users/example',
      tempDir: '/tmp',
    };
    const text =
      'snapshot=/tmp/shiploop-p01-clean-abc/repo/data ' +
      'repo=/Users/example/work/repo/logs home=/Users/example/.npm tmp=/tmp/other';
    const sanitized = sanitizeEvidenceText(text, replacements);
    expect(sanitized).toBe(
      'snapshot=<SNAPSHOT-ROOT>/data repo=<REPO-ROOT>/logs home=<HOME>/.npm tmp=<TMPDIR>/other',
    );
    for (const raw of ['/Users/example', '/tmp/shiploop-p01-clean-abc/repo', '/Users/example/work/repo']) {
      expect(sanitized).not.toContain(raw);
    }
    // 仓库根是 HOME 的子目录时不得被 HOME 先截断成 `<HOME>/work/repo`。
    expect(sanitized).toContain('<REPO-ROOT>');
  });

  it('解析 accept:p01 的 REPORT 行；非报告输出返回 null', () => {
    const stdout =
      'accept:p01: STEP [1/6] RUN npm run verify\n' +
      'accept:p01: REPORT <SNAPSHOT-ROOT>/artifacts/acceptance/p01/20261002T225338Z-e417cf37' +
      '（conclusion=pass，pass=14 fail=0 not_run=0）\n' +
      'accept:p01: PASS exit 0\n';
    expect(parseAcceptReportSummary(stdout)).toEqual({
      runDir: '<SNAPSHOT-ROOT>/artifacts/acceptance/p01/20261002T225338Z-e417cf37',
      conclusion: 'pass',
      pass: 14,
      fail: 0,
      notRun: 0,
    });
    expect(parseAcceptReportSummary('accept:p01: FAIL exit 1\n')).toBeNull();
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('复跑工具真实创建已提交快照、显式 argv 且不拼接 Shell 字符串', () => {
    expect(existsSync(resolve(REPO_ROOT, REPLAY_SCRIPT_PATH))).toBe(true);
    for (const token of [
      "'clone'",
      "'--no-hardlinks'",
      "'checkout'",
      "'--detach'",
      "'--porcelain'",
      "'node_modules'",
      "'dist'",
    ]) {
      expect(replayScript).toContain(token);
    }
    // 不经 shell 解释：没有 shell:true，也不使用 execSync 拼接命令字符串。
    expect(replayScript).not.toContain('shell: true');
    expect(replayScript).not.toContain('execSync');
  });
});

describe('F-010 P01 操作说明与验收配置', () => {
  it('操作说明引用真实命令、配置、报告位置与检查 ID', () => {
    for (const command of [
      'npm ci',
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run verify',
      'npm run accept:p01',
    ]) {
      expect(operationsDoc).toContain(command);
    }
    for (const reference of [
      CONFIG_PATH,
      'scripts/acceptance/clean-snapshot-replay.ts',
      'artifacts/acceptance/p01',
      'report.json',
      'summary.md',
      'evidence/',
      P01_ACCEPT_CONFIG_PATH,
    ]) {
      expect(operationsDoc).toContain(reference);
    }
    for (const env of [
      'SHIPLOOP_ACCEPT_P01_RUN_ID',
      'SHIPLOOP_ACCEPT_P01_REPORT_DIR',
      'SHIPLOOP_ACCEPT_P01_STEP_TIMEOUT_MS',
      'SHIPLOOP_VERIFY_STEP_TIMEOUT_MS',
    ]) {
      expect(operationsDoc).toContain(env);
    }
    expect(operationsDoc).toContain('shiploop-core/assembly');
    expect(operationsDoc).toContain('openCoreApplication');
    // 不编造未实现的 CLI 业务命令。
    expect(operationsDoc).not.toMatch(/shiploop\s+(project|config|artifact)\s+/);
  });

  it('操作说明覆盖结果三态、负例双断言、安全边界与 T03/T24/T26/T32 子集', () => {
    for (const topic of [
      'pass',
      'fail',
      'not_run',
      'startup_failure',
      'timeout',
      'skipped',
      '可信项目模式',
      'strong_sandbox',
      'T03',
      'T24',
      'T26',
      'T32',
      'tasks.execution_config',
      'not_run',
    ]) {
      expect(operationsDoc).toContain(topic);
    }
    // 三态与负例要求以中文明确表述。
    expect(operationsDoc).toContain('副作用断言');
    expect(operationsDoc).toContain('不计入必需项通过数');
    // 不把开发机绝对路径写成运行时依赖。
    expect(operationsDoc).not.toContain('/Users/example');
  });

  it('验收配置的必需检查与冻结清单一致，且超时有限、契约路径存在', () => {
    expect(config.configVersion).toBe(1);
    expect(config.reportRoot).toBe('artifacts/acceptance/p01');
    expect(config.requiredChecks).toEqual(P01_REQUIRED_CHECKS.map((check) => check.id));
    expect(config.requiredChecks).toHaveLength(14);
    for (const value of Object.values(config.timeouts)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(existsSync(resolve(REPO_ROOT, config.plan.contractDoc))).toBe(true);
    expect(operationsDoc).not.toContain('apiKey:');
    expect(operationsDoc).not.toContain('credential=');
  });

  it('操作说明引用的每个必需检查的承接测试入口真实存在', () => {
    for (const check of P01_REQUIRED_CHECKS) {
      const entry = check.testEntry;
      if (entry.startsWith('test/')) {
        expect(existsSync(resolve(REPO_ROOT, entry))).toBe(true);
        expect(operationsDoc).toContain(entry);
      }
    }
  });
});
