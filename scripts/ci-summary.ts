/**
 * P08-1 F-004 CI 摘要渲染（脱敏）：把本地 pack 与 CI 配置的结构化报告渲染为
 * 人类可读的 Markdown，写入 $GITHUB_STEP_SUMMARY（存在时）并打印到 stdout。
 *
 * 不变量：输入必须是 scripts/verify-artifacts.ts 产出的结构化报告（其自身保证脱敏）；
 * 报告缺失、结构不符或结论为 failed 时退出非零（fail-closed）。本脚本只读输入，
 * 仅写 $GITHUB_STEP_SUMMARY 指定文件；不调用模型、不执行发布/推送/PR 操作。
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CI_ARTIFACT_REPORT_DEFAULT = 'artifacts/local-pack/artifact-verification.json';
export const CI_CONFIG_REPORT_DEFAULT = 'artifacts/ci-config/ci-config-verification.json';
const SUMMARY_ENV = 'GITHUB_STEP_SUMMARY';

interface ArtifactReportShape {
  readonly kind: 'shiploop.artifact-verification';
  readonly passed: boolean;
  readonly environment: { readonly gitCommit: string; readonly nodeVersion: string; readonly npmVersion: string; readonly platform: string };
  readonly inputs: { readonly artifacts: readonly { readonly name: string; readonly version: string; readonly filename: string; readonly sha256: string | null }[] };
  readonly checks: readonly { readonly id: string; readonly status: string }[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly notRun: number };
}

interface CiConfigReportShape {
  readonly kind: 'shiploop.ci-config-verification';
  readonly passed: boolean;
  readonly summary: { readonly passed: number; readonly failed: number };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function expectString(record: Record<string, unknown>, key: string, owner: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${owner} 缺少字符串字段 ${key}`);
  return value;
}

function expectCount(record: Record<string, unknown>, key: string, owner: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${owner} 缺少非负整数字段 ${key}`);
  return value;
}

function parseArtifactReport(value: unknown): ArtifactReportShape {
  const record = asRecord(value);
  if (!record || record['kind'] !== 'shiploop.artifact-verification') {
    throw new Error('制品报告 kind 不是 shiploop.artifact-verification');
  }
  const passed = record['passed'];
  if (typeof passed !== 'boolean') throw new Error('制品报告缺少布尔 passed');
  const environment = asRecord(record['environment']);
  if (!environment) throw new Error('制品报告缺少 environment');
  const inputs = asRecord(record['inputs']);
  if (!inputs || !Array.isArray(inputs['artifacts'])) throw new Error('制品报告缺少 inputs.artifacts');
  const artifacts = (inputs['artifacts'] as unknown[]).map((item) => {
    const entry = asRecord(item);
    if (!entry) throw new Error('制品报告 artifacts 项结构无效');
    return {
      name: expectString(entry, 'name', '制品报告'),
      version: expectString(entry, 'version', '制品报告'),
      filename: expectString(entry, 'filename', '制品报告'),
      sha256: typeof entry['sha256'] === 'string' ? entry['sha256'] : null,
    };
  });
  if (!Array.isArray(record['checks'])) throw new Error('制品报告缺少 checks');
  const checks = (record['checks'] as unknown[]).map((item) => {
    const entry = asRecord(item);
    if (!entry || typeof entry['id'] !== 'string' || typeof entry['status'] !== 'string') {
      throw new Error('制品报告 checks 项结构无效');
    }
    return { id: entry['id'] as string, status: entry['status'] as string };
  });
  const summary = asRecord(record['summary']);
  if (!summary) throw new Error('制品报告缺少 summary');
  return {
    kind: 'shiploop.artifact-verification',
    passed,
    environment: {
      gitCommit: expectString(environment, 'gitCommit', '制品报告'),
      nodeVersion: expectString(environment, 'nodeVersion', '制品报告'),
      npmVersion: expectString(environment, 'npmVersion', '制品报告'),
      platform: expectString(environment, 'platform', '制品报告'),
    },
    inputs: { artifacts },
    checks,
    summary: {
      passed: expectCount(summary, 'passed', '制品报告'),
      failed: expectCount(summary, 'failed', '制品报告'),
      notRun: expectCount(summary, 'notRun', '制品报告'),
    },
  };
}

function parseCiConfigReport(value: unknown): CiConfigReportShape {
  const record = asRecord(value);
  if (!record || record['kind'] !== 'shiploop.ci-config-verification') {
    throw new Error('CI 配置报告 kind 不是 shiploop.ci-config-verification');
  }
  const passed = record['passed'];
  const summary = asRecord(record['summary']);
  if (typeof passed !== 'boolean' || !summary) throw new Error('CI 配置报告缺少 passed/summary');
  return {
    kind: 'shiploop.ci-config-verification',
    passed,
    summary: {
      passed: expectCount(summary, 'passed', 'CI 配置报告'),
      failed: expectCount(summary, 'failed', 'CI 配置报告'),
    },
  };
}

/** 渲染脱敏 Markdown 摘要；输入无效时抛错（fail-closed，不渲染半截结论）。 */
export function renderCiSummaryMarkdown(input: { artifactReport: unknown; ciConfigReport?: unknown }): string {
  const artifact = parseArtifactReport(input.artifactReport);
  const ciConfig = input.ciConfigReport === undefined ? null : parseCiConfigReport(input.ciConfigReport);
  const lines: string[] = [];
  lines.push('## ShipLoop release-ci 检查摘要');
  lines.push('');
  lines.push(`- 结论：${artifact.passed ? '**通过**' : '**失败**'}`);
  lines.push(`- 受测 commit：\`${artifact.environment.gitCommit}\`（node ${artifact.environment.nodeVersion} / npm ${artifact.environment.npmVersion} / ${artifact.environment.platform}）`);
  lines.push(`- 制品检查：${artifact.summary.passed} passed / ${artifact.summary.failed} failed / ${artifact.summary.notRun} not_run`);
  if (ciConfig) {
    lines.push(`- CI 配置检查：${ciConfig.summary.passed} passed / ${ciConfig.summary.failed} failed`);
  }
  if (artifact.inputs.artifacts.length > 0) {
    lines.push('- 制品摘要：');
    for (const entry of artifact.inputs.artifacts) {
      const digest = entry.sha256 ? ` sha256:\`${entry.sha256.slice(0, 12)}…\`` : '（无摘要）';
      lines.push(`  - \`${entry.name}@${entry.version}\`（${entry.filename}）${digest}`);
    }
  }
  lines.push('- 边界：本 CI 不执行 npm publish、git push、自动合并、PR 创建、真实模型调用或未授权跨仓操作；公开发布需负责人独立批准与身份确认。');
  return `${lines.join('\n')}\n`;
}

/** ---------- CLI ---------- */

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) throw new Error(`缺少报告文件：${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`报告无法解析（${path}）：${(error as Error).message}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let repoRootArg: string | undefined;
  let reportArg: string | undefined;
  let ciConfigReportArg: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo-root' && args[index + 1] !== undefined) {
      repoRootArg = args[++index];
    } else if (arg === '--report' && args[index + 1] !== undefined) {
      reportArg = args[++index];
    } else if (arg === '--ci-config-report' && args[index + 1] !== undefined) {
      ciConfigReportArg = args[++index];
    } else {
      process.stderr.write(`ci-summary: 未知参数：${arg}（支持 --repo-root/--report/--ci-config-report）\n`);
      process.exitCode = 2;
      return;
    }
  }
  const repoRoot = resolve(repoRootArg ?? process.cwd());
  const reportPath = reportArg ? (isAbsolute(reportArg) ? reportArg : join(repoRoot, reportArg)) : join(repoRoot, CI_ARTIFACT_REPORT_DEFAULT);
  const ciConfigPath = ciConfigReportArg
    ? (isAbsolute(ciConfigReportArg) ? ciConfigReportArg : join(repoRoot, ciConfigReportArg))
    : join(repoRoot, CI_CONFIG_REPORT_DEFAULT);

  try {
    const parsedArtifact = parseArtifactReport(readJsonFile(reportPath));
    const ciConfigReport = existsSync(ciConfigPath) ? readJsonFile(ciConfigPath) : undefined;
    const markdown = renderCiSummaryMarkdown({ artifactReport: parsedArtifact, ciConfigReport });
    process.stdout.write(markdown);
    const summaryTarget = process.env[SUMMARY_ENV];
    if (summaryTarget) appendFileSync(summaryTarget, markdown, 'utf8');
    process.exitCode = parsedArtifact.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`ci-summary: FAIL ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main();
}
