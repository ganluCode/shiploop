/**
 * F-013 文档核验：P02 操作指南（`docs/p02-4-operations.md`，含验收复跑说明）与人工审阅
 * 清单（`docs/acceptance/p02-4-review-checklist.md`）必须交接**实际支持的接口与阶段
 * 边界**，不得与真实命令契约、`accept:p02` 控制器或检查清单漂移：
 *
 *  1) 操作指南里每条 `node packages/cli/dist/bin.js …` 示例命令行逐字提取，经真实命令
 *     契约面（`parseAppCliArgs`/`parseHostCliArgs`）核对为按真实参数可解析的调用；
 *     示例覆盖双 CLI 共享数据根、确认配置、注册、授权基线、查询、退出观察、显式
 *     stop/重启与读取证据的完整步骤；
 *  2) `accept:p02` 验收复跑说明（配置入口、报告位置、CLI/env 覆盖、非零处理）与真实
 *     控制器（`scripts/acceptance/p02-accept.ts`、`scripts/acceptance/p02-config.ts`、
 *     `acceptance/p02.config.json`）一致；干净快照复跑入口与深度护栏如实登记；
 *  3) 诊断章节覆盖注册与健康独立、重复 init、commandId 重放/冲突、超时先查回执、
 *     认证/协议拒绝、failed/not_run/cancelled 与 stop_unconfirmed，并明确禁止手工
 *     修改业务数据库或删除锁来“解决”问题；
 *  4) 人工审阅清单逐项引用 FR-1/FR-2、稳定检查 ID 与真实测试/证据入口，列出阶段支持的
 *     T 索引子集与已知限制；人工未审阅明确记为未完成，不自动签字、不把 Nezha 的
 *     completed 等同放行；
 *  5) 文档声明正式支持 macOS、可信项目不具备强 OS 沙箱，未实现的 Pi/Work/Web/rebind
 *     等不冒充完成；示例无真实凭据与开发机固定路径；记录 Harness 验证策略应对齐
 *     `npm run verify` 与阶段命令但本轮不修改配置。
 *
 * 定位：F-013 只交付文档与本守护；不新增业务实现、不改变产品代码与验收语义。
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAppCliArgs, parseHostCliArgs } from '../packages/cli/src/index.ts';
import {
  loadP02AcceptanceConfig,
  parseP02AcceptArgs,
  P02AcceptError,
  P02_ACCEPT_CONFIG_PATH,
  P02_ACCEPT_ENV_REPORT_DIR,
  P02_ACCEPT_ENV_RUN_ID,
  P02_ACCEPT_ENV_STEP_TIMEOUT_MS,
  P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
} from '../scripts/acceptance/p02-config.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATIONS_DOC_PATH = 'docs/p02-4-operations.md';
const CHECKLIST_DOC_PATH = 'docs/acceptance/p02-4-review-checklist.md';
const README_PATH = 'README.md';

const operationsDoc = readFileSync(resolve(REPO_ROOT, OPERATIONS_DOC_PATH), 'utf-8');
const checklistDoc = readFileSync(resolve(REPO_ROOT, CHECKLIST_DOC_PATH), 'utf-8');
const readmeDoc = readFileSync(resolve(REPO_ROOT, README_PATH), 'utf-8');

/** P02-4 冻结的必需检查 ID（与 `acceptance/p02.config.json` / 契约 §2.1 一致）。 */
const REQUIRED_CHECK_IDS = [
  'P02-ENG-VERIFY',
  'P02-FR1-UNIQUE-HOST',
  'P02-FR1-SHARED-STATE',
  'P02-FR1-BASELINE-OK',
  'P02-FR2-DUPLICATE-INIT',
  'P02-FR2-COMMAND-CONFLICT',
  'P02-FR2-SOURCE-PRESERVED',
  'P02-FR2-AUTH-REJECT',
  'P02-FR2-CLIENT-EXIT',
  'P02-FR1-RESTART-QUERY',
  'P02-FR2-BASELINE-FAILURE',
  'P02-PHASE-FIXTURE',
  'P02-PHASE-NOT-RUN',
  'P02-PHASE-REPORT',
  'P02-ENG-CLEAN-REPLAY',
] as const;

/* ================================================================== *
 * 1) 操作指南示例命令与真实命令契约一致（纯面层解析，无 I/O）
 * ================================================================== */

/** 提取操作指南全部 sh 代码块中的 `node packages/cli/dist/bin.js …` 逻辑命令行。 */
function documentedInvocations(): string[][] {
  const blocks = [...operationsDoc.matchAll(/```sh\n([\s\S]*?)```/g)];
  expect(blocks.length, '操作指南必须包含 sh 代码块').toBeGreaterThanOrEqual(1);
  const invocations: string[][] = [];
  for (const block of blocks) {
    let pending: string | null = null;
    for (const line of block[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.length === 0) continue;
      const candidate: string = pending === null ? trimmed : `${pending} ${trimmed}`;
      pending = null;
      if (!candidate.startsWith('node packages/cli/dist/bin.js')) {
        expect(candidate.endsWith('\\'), `续行标记只允许出现在 CLI 命令行上：${candidate}`).toBe(false);
        continue;
      }
      if (candidate.endsWith('\\')) {
        pending = candidate.slice(0, -1).trim();
        continue;
      }
      invocations.push(tokenize(candidate.slice('node packages/cli/dist/bin.js'.length).trim()));
    }
    expect(pending, '文档命令行不得以悬挂续行结尾').toBeNull();
  }
  return invocations;
}

/** 极简 shell 风格分词：空白分隔、双引号保留内容（示例中无转义/单引号参数）。 */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of commandLine) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  expect(quoted, `引号不配对：${commandLine}`).toBe(false);
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function bindPlaceholders(tokens: readonly string[]): string[] {
  const base = join(tmpdir(), 'shiploop-docs-p02-4');
  const bindings: Record<string, string> = {
    $REPO: join(base, 'repo'),
    $ROOT: join(base, 'data'),
    $PROJECT_ID: randomUUID(),
    $OPERATION_ID: randomUUID(),
    $ARTIFACT_ID: randomUUID(),
    $CMD: randomUUID(),
  };
  return tokens.map((token) => {
    let bound = token;
    for (const [placeholder, value] of Object.entries(bindings)) {
      bound = bound.split(placeholder).join(value);
    }
    return bound;
  });
}

describe('F-013 P02 操作指南示例命令契约', () => {
  it('每条 dist CLI 示例命令行都被真实解析面接受（真实参数，非候选名）', () => {
    const invocations = documentedInvocations();
    expect(invocations.length).toBeGreaterThanOrEqual(16);

    const seenCommands = new Set<string>();
    for (const invocation of invocations) {
      const bound = bindPlaceholders(invocation);
      const [group, second] = bound;
      const subcommand = second !== undefined && !second.startsWith('-') ? second : undefined;
      seenCommands.add(subcommand === undefined ? group : `${group} ${subcommand}`);
      if (group === 'host') {
        expect(() => parseHostCliArgs(bound, {}), JSON.stringify(bound)).not.toThrow();
      } else {
        const parsed = parseAppCliArgs(bound, {}, { cwd: join(tmpdir(), 'shiploop-docs-p02-4') });
        expect('commandId' in parsed, JSON.stringify(bound)).toBe(true);
      }
    }

    // 示例覆盖 AC 要求的完整闭环：双 CLI/配置/注册/授权基线/查询/观察/stop·重启/证据。
    for (const command of [
      'host start',
      'host status',
      'host stop',
      'project init',
      'project overview',
      'project list',
      'config create',
      'config get',
      'config effective',
      'receipt get',
      'events',
      'baseline preview',
      'baseline run',
      'baseline list',
      'baseline status',
      'baseline cancel',
      'baseline evidence',
    ]) {
      expect(seenCommands, command).toContain(command);
    }
  });

  it('操作指南记录双 CLI、临时 Git 仓库与退出观察/重启步骤的关键语义', () => {
    for (const token of [
      'CLI-A',
      'CLI-B',
      'mktemp -d',
      'git init',
      '--data-root',
      '--confirm',
      'hostInstanceId',
      '同一个 Host',
      'observation_interrupted',
      '退出码 4',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }
  });
});

/* ================================================================== *
 * 2) accept:p02 验收复跑说明与真实控制器/配置一致
 * ================================================================== */

describe('F-013 验收复跑说明与 accept:p02 实际代码一致', () => {
  it('复跑说明覆盖真实 CLI 参数、环境变量与配置/报告位置', () => {
    for (const token of [
      'npm run accept:p02',
      P02_ACCEPT_CONFIG_PATH,
      '--run-id',
      '--report-dir',
      '--step-timeout-ms',
      '--verify-timeout-ms',
      '--help',
      P02_ACCEPT_ENV_RUN_ID,
      P02_ACCEPT_ENV_REPORT_DIR,
      P02_ACCEPT_ENV_STEP_TIMEOUT_MS,
      P02_ACCEPT_ENV_VERIFY_TIMEOUT_MS,
      'artifacts/acceptance/p02',
      'report.json',
      'summary.md',
      'evidence/',
      'YYYYMMDDThhmmssZ',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }

    // 文档记录的覆盖参数确实被真实解析面接受（用法与实际代码一致）。
    const parsed = parseP02AcceptArgs([
      '--run-id',
      '20260101T000000Z-abcdef12',
      '--report-dir',
      'out/p02',
      '--step-timeout-ms',
      '1500',
      '--verify-timeout-ms',
      '1500',
    ]);
    expect(parsed.help).toBe(false);
    expect(parsed.overrides.runId).toBe('20260101T000000Z-abcdef12');
    expect(parsed.overrides.reportDir).toBe('out/p02');
    // 跳过类开关被拒绝（文档必须如实声明“不得跳过必需检查”）。
    expect(() => parseP02AcceptArgs(['--skip-verify'])).toThrow(P02AcceptError);
  });

  it('配置入口与必需检查清单即仓库内真实配置（不另立一套）', () => {
    const config = loadP02AcceptanceConfig(resolve(REPO_ROOT, P02_ACCEPT_CONFIG_PATH));
    expect(config.configVersion).toBe(1);
    expect(config.reportRoot).toBe('artifacts/acceptance/p02');
    expect([...config.requiredChecks]).toEqual([...REQUIRED_CHECK_IDS]);
    for (const id of REQUIRED_CHECK_IDS) {
      expect(operationsDoc.includes(id) || checklistDoc.includes(id), id).toBe(true);
    }
  });

  it('非零处理与 fail-closed 语义按实际代码描述', () => {
    for (const token of [
      '退出码 1',
      '零副作用',
      '不产生报告',
      '全部必需检查',
      'not_run',
      '非零',
      '不得跳过',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }
  });

  it('干净快照连续复跑入口、证据目录与深度护栏如实登记', () => {
    for (const token of [
      'p02-clean-replay.ts',
      '--phase',
      'prepare',
      'accept-1',
      'accept-2',
      'finalize',
      'test/p02-4-clean-replay.test.ts',
      'SHIPLOOP_CLEAN_REPLAY_DEPTH',
      'docs/acceptance/evidence-p02-4-clean-replay',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }
  });
});

/* ================================================================== *
 * 3) 诊断章节（注册/健康、幂等、回执、拒绝、失败与停止未确认）
 * ================================================================== */

describe('F-013 诊断与排障交接', () => {
  it('覆盖注册与健康独立、重复 init、commandId 重放/冲突、超时先查回执、拒绝与失败诊断', () => {
    for (const token of [
      // 注册与健康独立
      '注册',
      '健康',
      'no_baseline',
      // 重复 init
      'already_registered',
      // commandId 重放 / 冲突
      'replayed',
      'idempotency_key_reuse',
      // 超时先查回执
      'receipt get',
      '先查回执',
      // 认证/协议拒绝
      'unauthorized',
      'protocol_incompatible',
      // failed / not_run / cancelled
      'failed',
      'not_run',
      'cancelled',
      'authorization_rejected',
      'timed_out',
      // 停止未确认
      'stop_unconfirmed',
    ]) {
      expect(operationsDoc, token).toContain(token);
    }
  });

  it('明确禁止手工修改业务数据库或删除锁来“解决问题”', () => {
    for (const token of ['不得手工修改业务数据库', '不得删除', '锁']) {
      expect(operationsDoc, token).toContain(token);
    }
  });
});

/* ================================================================== *
 * 4) 人工审阅清单（FR-1/FR-2、T 索引子集、人工未审阅=未完成）
 * ================================================================== */

describe('F-013 人工审阅清单', () => {
  it('逐项引用 FR-1/FR-2、稳定检查 ID 与真实测试/证据入口', () => {
    expect(checklistDoc).toContain('FR-1');
    expect(checklistDoc).toContain('FR-2');
    expect(checklistDoc.match(/FR-1/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(checklistDoc.match(/FR-2/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    for (const id of REQUIRED_CHECK_IDS) {
      expect(checklistDoc, id).toContain(id);
    }
    // 清单引用的每个测试文件都真实存在（不引用虚构入口）。
    const referenced = new Set(
      [...checklistDoc.matchAll(/test\/[a-zA-Z0-9./_-]+\.test\.ts/g)].map((m) => m[0]),
    );
    expect(referenced.size).toBeGreaterThanOrEqual(8);
    for (const file of referenced) {
      expect(existsSync(resolve(REPO_ROOT, file)), file).toBe(true);
    }
    // 证据位置真实（阶段报告根与干净快照复跑证据目录）。
    expect(checklistDoc).toContain('artifacts/acceptance/p02');
    expect(checklistDoc).toContain('docs/acceptance/evidence-p02-4-clean-replay');
  });

  it('列出阶段支持的 T 索引子集与已知限制', () => {
    for (const token of ['T10', 'T15', 'T17', 'T23', 'T26', '子集', '已知限制']) {
      expect(checklistDoc, token).toContain(token);
    }
  });

  it('人工未审阅明确未完成：不自动签字、Nezha completed 不等于放行', () => {
    for (const token of [
      '人工未审阅',
      '未完成',
      '不自动签字',
      'Nezha',
      'completed',
      '不等于',
      '放行',
    ]) {
      expect(checklistDoc, token).toContain(token);
    }
  });
});

/* ================================================================== *
 * 5) 平台、安全边界、未实现声明与交接卫生
 * ================================================================== */

describe('F-013 平台与边界声明', () => {
  it('声明 macOS 正式支持、可信项目非强 OS 沙箱，未实现能力不冒充完成', () => {
    for (const doc of [operationsDoc, checklistDoc]) {
      for (const token of [
        'macOS',
        '强沙箱',
        'Pi',
        'Work',
        'Web',
        'rebind',
        '未实现',
      ]) {
        expect(doc, token).toContain(token);
      }
    }
    expect(operationsDoc).toContain('not_run');
  });

  it('记录 Harness 验证策略应对齐 verify 与阶段命令但本轮不修改配置', () => {
    for (const token of ['Harness', 'npm run verify', 'accept:p02', '对齐', '不修改']) {
      expect(operationsDoc, token).toContain(token);
    }
  });

  it('示例与文档不含真实凭据或开发机固定路径；README 登记新文档入口', () => {
    for (const doc of [operationsDoc, checklistDoc, readmeDoc]) {
      expect(doc).not.toMatch(/\/Users\//);
      expect(doc).not.toMatch(/\/home\/[a-z]/);
      expect(doc).not.toMatch(/ghp_[A-Za-z0-9]/);
      expect(doc).not.toContain('PRIVATE KEY');
    }
    expect(readmeDoc).toContain('docs/p02-4-operations.md');
    expect(readmeDoc).toContain('docs/acceptance/p02-4-review-checklist.md');
  });
});
