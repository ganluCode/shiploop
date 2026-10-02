/**
 * P01-4 / F-007 版本化 P01 阶段报告、证据清单与严格结果聚合器回归。
 *
 * 承接契约（docs/p01-4-acceptance-contract.md §2.1）中的检查
 * `P01-PHASE-NOT-RUN`（必需检查未运行不得聚合为通过）与
 * `P01-PHASE-REPORT`（报告完整性、证据 path/hash/size 可验证）：
 * - 冻结的机器可读必需检查清单与契约文档一致；
 * - 聚合器三态（pass/fail/not_run）、not_run 四分类、未知/重复 ID 拒绝、
 *   预期负例错误+副作用双断言、空结果集不得通过；
 * - report.json 与 summary.md 同源同批写出、run-id 目录不覆盖、证据清单
 *   hash/size 可重验、缺失/损坏证据与非法报告 Schema 都被识别且阶段非零；
 * - 合成凭据脱敏覆盖报告 JSON、摘要与证据附件（不只脱敏摘要）；
 * - 阶段外能力（P01-OOS-*）标记 not_run/unsupported 且不计入必需项通过数；
 * - 命令 cwd 使用逻辑位置，报告不包含个人/仓库绝对路径。
 *
 * 全部场景在系统临时目录的独立沙箱中执行，不触碰真实用户资源，不调用模型。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P01_REQUIRED_CHECKS,
  P01_REQUIRED_CHECK_IDS,
  P01ReportError,
  aggregateP01CheckResults,
  assertValidRunId,
  buildP01AcceptanceReport,
  computeP01PhaseExitCode,
  generateP01RunId,
  redactSensitiveText,
  validateP01AcceptanceReport,
  verifyP01ReportDirectory,
  writeP01AcceptanceReport,
} from '../scripts/acceptance/p01-report.ts';
import type {
  P01AcceptanceReport,
  P01AcceptanceReportInput,
  P01CheckResultInput,
  P01EvidenceFileInput,
  P01ReportErrorKind,
} from '../scripts/acceptance/p01-report.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC = readFileSync(
  resolve(REPO_ROOT, 'docs/p01-4-acceptance-contract.md'),
  'utf-8',
);
const SYNTHETIC_SECRET = 'keychain://P01-4-TOP-SECRET-SENTINEL';

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(): string {
  const sandbox = createTempSandbox('shiploop-p01-4-report-', {
    outside: [REPO_ROOT, homedir()],
  });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function expectReportError(fn: () => unknown, kind: P01ReportErrorKind): P01ReportError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(P01ReportError);
    expect((error as P01ReportError).kind).toBe(kind);
    return error as P01ReportError;
  }
  throw new Error(`应抛出 P01ReportError(${kind})`);
}

/** 全部 14 项 pass 的提交结果（预期负例携带双断言）。 */
function passResults(): P01CheckResultInput[] {
  return P01_REQUIRED_CHECKS.map((definition) => ({
    checkId: definition.id,
    status: 'pass',
    durationMs: 25,
    detail: ` evidence for ${definition.id} `,
    ...(definition.expectedNegative
      ? { errorAssertion: true, sideEffectAssertion: true }
      : {}),
  }));
}

function validInput(runId: string, results: P01CheckResultInput[]): P01AcceptanceReportInput {
  return {
    runId,
    generatedAtUtc: '2026-10-03T01:02:03.000Z',
    plan: {
      phaseId: 'p01',
      title: 'P01 持久化闭环验收',
      scope: 'FR-1/FR-2 持久化、回滚、制品与配置/标签',
      version: '0.2',
      digestSha256: 'a'.repeat(64),
    },
    git: {
      commit: 'b'.repeat(40),
      worktree: 'clean',
      branch: 'feat/2026-10-01-23-44-21_p01-4-p01',
      priorBaselines: [
        {
          phase: 'p01-project-config',
          branch: 'feat/2026-10-01-23-44-21_p01-3',
          tipCommit: 'c'.repeat(40),
        },
      ],
    },
    platform: { system: 'darwin', release: '24.6.0', arch: 'arm64' },
    tools: {
      node: '22.19.0',
      npm: '10.9.3',
      git: 'git version 2.50.1',
      sqlite: '3.50.4',
      betterSqlite3: '13.0.3',
      drizzleOrm: '0.45.3',
    },
    schemaVersions: { settingsSchema: 2, settingsExportFormat: 1, sqliteMigrations: [1, 2] },
    commands: [
      {
        label: 'npm run verify',
        argv: ['npm', 'run', 'verify'],
        cwd: '<repo>',
        exitCode: 0,
        durationMs: 12_345,
      },
    ],
    results,
    stateDigests: { businessInputSha256: 'd'.repeat(64) },
    outOfScope: [
      {
        id: 'P01-OOS-MODEL-LIVE',
        capability: '模型 Live 调用',
        status: 'not_run',
        note: 'P01 无 Runtime/Pi SDK',
      },
      {
        id: 'P01-OOS-STRONG-SANDBOX',
        capability: '强 OS 沙箱',
        status: 'unsupported',
        note: '首版为可信项目模式',
      },
      {
        id: 'P01-OOS-OTHER-PLATFORMS',
        capability: 'Windows/WSL/Linux',
        status: 'not_run',
        note: '正式验收限 macOS',
      },
    ],
    knownLimitations: ['正式验收限 macOS；无 Host 网络接口与模型 Live。'],
  };
}

function sampleEvidence(): P01EvidenceFileInput[] {
  return [
    {
      path: 'evidence/closed-loop/fr1-normal.json',
      content: JSON.stringify({ checkId: 'P01-FR1-NORMAL', status: 'pass' }, null, 2),
      checkId: 'P01-FR1-NORMAL',
    },
    {
      path: 'evidence/rollback/fr1-rollback.json',
      content: JSON.stringify({ checkId: 'P01-FR1-ROLLBACK', status: 'pass' }, null, 2),
      checkId: 'P01-FR1-ROLLBACK',
    },
  ];
}

function writeRun(
  sandbox: string,
  runId: string,
  results: P01CheckResultInput[],
  evidence: P01EvidenceFileInput[] = sampleEvidence(),
  sensitiveValues: readonly string[] = [],
) {
  return writeP01AcceptanceReport({
    reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p01'),
    input: validInput(runId, results),
    evidenceFiles: evidence,
    sensitiveValues,
  });
}

/* ------------------------------------------------------------------ */

describe('F-007 冻结必需检查清单与严格聚合器', () => {
  it('机器可读清单与契约文档 §2.1 一致（14 项、顺序固定、无重复）', () => {
    expect(P01_REQUIRED_CHECK_IDS).toEqual([
      'P01-ENG-VERIFY',
      'P01-FR1-NORMAL',
      'P01-FR1-REOPEN',
      'P01-FR1-ROLLBACK',
      'P01-FR2-CONFIG',
      'P01-FR2-ROLLBACK',
      'P01-FR2-CAS',
      'P01-FR2-TAGS',
      'P01-FR2-ARTIFACT-MISSING',
      'P01-FR2-ARTIFACT-RECOVERY',
      'P01-PHASE-FIXTURE',
      'P01-PHASE-NOT-RUN',
      'P01-ENG-BUILD-SMOKE',
      'P01-PHASE-REPORT',
    ]);
    expect(new Set(P01_REQUIRED_CHECK_IDS).size).toBe(P01_REQUIRED_CHECK_IDS.length);
    const docIds = [...CONTRACT_DOC.matchAll(/^\| `(P01-[A-Z0-9-]+)`/gm)].map(
      (match) => match[1],
    );
    expect(docIds).toEqual([...P01_REQUIRED_CHECK_IDS]);
    // 已存在的测试入口真实在库（F-008/F-009 约定入口除外）。
    for (const definition of P01_REQUIRED_CHECKS) {
      if (definition.testEntry.endsWith('.test.ts')) {
        const relative = definition.testEntry.replace(/^test\//, '');
        if (
          ['p01-4-acceptance-controller.test.ts', 'p01-4-build-smoke.test.ts'].includes(relative)
        ) {
          continue; // F-008/F-009 交付的约定入口。
        }
        expect(
          existsSync(join(REPO_ROOT, 'test', relative)),
          `测试入口缺失：${definition.testEntry}`,
        ).toBe(true);
      }
    }
    // 预期负例标记与契约 §2.4 示例一致。
    const negativeIds = P01_REQUIRED_CHECKS.filter((d) => d.expectedNegative).map((d) => d.id);
    expect(negativeIds).toEqual([
      'P01-FR1-ROLLBACK',
      'P01-FR2-CONFIG',
      'P01-FR2-ROLLBACK',
      'P01-FR2-ARTIFACT-MISSING',
    ]);
  });

  it('全部通过：conclusion=pass、计数 14/0/0、无问题项', () => {
    const aggregation = aggregateP01CheckResults(passResults());
    expect(aggregation.conclusion).toBe('pass');
    expect(aggregation.counts).toEqual({ pass: 14, fail: 0, not_run: 0, total: 14 });
    expect(aggregation.problems).toEqual([]);
    expect(aggregation.checks.map((check) => check.id)).toEqual([...P01_REQUIRED_CHECK_IDS]);
    expect(
      computeP01PhaseExitCode({
        conclusion: aggregation.conclusion,
        evidenceOk: true,
        reportWritten: true,
      }),
    ).toBe(0);
  });

  it('断言失败：fail 计数与问题项明确，结论 fail', () => {
    const results = passResults();
    results[1] = { checkId: 'P01-FR1-NORMAL', status: 'fail', detail: '重开后 hash 不一致' };
    const aggregation = aggregateP01CheckResults(results);
    expect(aggregation.conclusion).toBe('fail');
    expect(aggregation.counts).toEqual({ pass: 13, fail: 1, not_run: 0, total: 14 });
    expect(aggregation.problems.join('\n')).toContain('P01-FR1-NORMAL');
    expect(aggregation.problems.join('\n')).toContain('重开后 hash 不一致');
  });

  it('缺项与空结果：未提交必需项标 not_run/missing_result，空结果集不得聚合为通过', () => {
    const partial = aggregateP01CheckResults(passResults().slice(0, 3));
    expect(partial.conclusion).toBe('fail');
    expect(partial.counts).toEqual({ pass: 3, fail: 0, not_run: 11, total: 14 });
    const missing = partial.checks.filter((check) => check.status === 'not_run');
    expect(missing.every((check) => check.notRunReason === 'missing_result')).toBe(true);
    expect(partial.problems.join('\n')).toContain('P01-PHASE-REPORT');

    const empty = aggregateP01CheckResults([]);
    expect(empty.conclusion).toBe('fail');
    expect(empty.counts).toEqual({ pass: 0, fail: 0, not_run: 14, total: 14 });
    expect(empty.checks.every((check) => check.notRunReason === 'missing_result')).toBe(true);
  });

  it('not_run 必须携带明确分类；启动失败/超时/被跳过均不得计为通过', () => {
    const results = passResults().slice(0, 11);
    results.push(
      { checkId: 'P01-PHASE-NOT-RUN', status: 'not_run', notRunReason: 'startup_failure' },
      { checkId: 'P01-ENG-BUILD-SMOKE', status: 'not_run', notRunReason: 'timeout' },
      { checkId: 'P01-PHASE-REPORT', status: 'not_run', notRunReason: 'skipped' },
    );
    const aggregation = aggregateP01CheckResults(results);
    expect(aggregation.conclusion).toBe('fail');
    expect(aggregation.counts).toEqual({ pass: 11, fail: 0, not_run: 3, total: 14 });
    const byId = new Map(aggregation.checks.map((check) => [check.id, check]));
    expect(byId.get('P01-PHASE-NOT-RUN')?.notRunReason).toBe('startup_failure');
    expect(byId.get('P01-ENG-BUILD-SMOKE')?.notRunReason).toBe('timeout');
    expect(byId.get('P01-PHASE-REPORT')?.notRunReason).toBe('skipped');

    expectReportError(
      () =>
        aggregateP01CheckResults([
          ...passResults().slice(0, 13),
          { checkId: 'P01-PHASE-REPORT', status: 'not_run' },
        ]),
      'invalid_result',
    );
    expectReportError(
      () =>
        aggregateP01CheckResults([
          { checkId: 'P01-ENG-VERIFY', status: 'pass', notRunReason: 'skipped' },
        ]),
      'invalid_result',
    );
    expectReportError(
      () =>
        aggregateP01CheckResults([
          { checkId: 'P01-ENG-VERIFY', status: 'not_run', notRunReason: 'unknown_reason' as never },
        ]),
      'invalid_result',
    );
  });

  it('未知 / 重复检查 ID 一律拒绝，不得聚合为通过', () => {
    expectReportError(
      () =>
        aggregateP01CheckResults([
          ...passResults(),
          { checkId: 'P01-FR9-NOPE', status: 'pass' },
        ]),
      'unknown_check',
    );
    expectReportError(
      () =>
        aggregateP01CheckResults([
          { checkId: 'P01-ENG-VERIFY', status: 'pass' },
          { checkId: 'P01-ENG-VERIFY', status: 'fail' },
        ]),
      'duplicate_check',
    );
    // 阶段外能力 ID 也不允许冒充必需检查结果。
    expectReportError(
      () => aggregateP01CheckResults([{ checkId: 'P01-OOS-MODEL-LIVE', status: 'pass' }]),
      'unknown_check',
    );
  });

  it('预期负例必须同时满足错误断言与副作用断言才计为 pass', () => {
    // 只有错误断言、缺少副作用断言 → 降级 fail。
    const onlyError = passResults();
    onlyError[3] = { checkId: 'P01-FR1-ROLLBACK', status: 'pass', errorAssertion: true };
    const downgraded = aggregateP01CheckResults(onlyError);
    expect(downgraded.conclusion).toBe('fail');
    const entry = downgraded.checks.find((check) => check.id === 'P01-FR1-ROLLBACK');
    expect(entry?.status).toBe('fail');
    expect(entry?.detail).toContain('副作用断言');
    expect(downgraded.problems.join('\n')).toContain('P01-FR1-ROLLBACK');

    // 双断言齐全 → pass；非负例检查不受断言约束。
    const both = passResults();
    const ok = aggregateP01CheckResults(both);
    expect(ok.conclusion).toBe('pass');
    expect(
      ok.checks.find((check) => check.id === 'P01-FR2-ARTIFACT-MISSING')?.status,
    ).toBe('pass');
  });

  it('结果条目的证据引用必须是 evidence/ 内的安全相对路径', () => {
    expectReportError(
      () =>
        aggregateP01CheckResults([
          { checkId: 'P01-ENG-VERIFY', status: 'pass', evidenceRefs: ['/abs/path.json'] },
        ]),
      'unsafe_path',
    );
    expectReportError(
      () =>
        aggregateP01CheckResults([
          { checkId: 'P01-ENG-VERIFY', status: 'pass', evidenceRefs: ['evidence/../escape'] },
        ]),
      'unsafe_path',
    );
    expectReportError(
      () =>
        aggregateP01CheckResults([
          { checkId: 'P01-ENG-VERIFY', status: 'pass', evidenceRefs: ['outside/file.json'] },
        ]),
      'unsafe_path',
    );
  });
});

/* ------------------------------------------------------------------ */

describe('F-007 报告写入、证据清单与验证', () => {
  it('全通过运行：report.json/summary.md/evidence 同源写出且可重验，退出码 0', () => {
    const sandbox = newSandbox();
    const results = passResults();
    results[1] = {
      ...results[1],
      evidenceRefs: ['evidence/closed-loop/fr1-normal.json'],
    } as P01CheckResultInput;
    const written = writeRun(sandbox, '20261003T010203Z-deadbeef', results);

    expect(written.exitCode).toBe(0);
    expect(written.conclusion).toBe('pass');
    expect(existsSync(written.reportPath)).toBe(true);
    expect(existsSync(written.summaryPath)).toBe(true);

    // report.json 通过严格 Schema 校验；证据 hash/size 与磁盘一致。
    const parsed = JSON.parse(readFileSync(written.reportPath, 'utf-8')) as unknown;
    const report = validateP01AcceptanceReport(parsed);
    expect(report.counts).toEqual({ pass: 14, fail: 0, not_run: 0, total: 14 });
    for (const entry of report.evidence) {
      const bytes = readFileSync(join(written.runDir, ...entry.path.split('/')));
      expect(sha256Hex(bytes)).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.sizeBytes);
    }
    expect(verifyP01ReportDirectory(written.runDir)).toEqual({ ok: true, problems: [] });

    // 摘要与 JSON 同源：相同结论、相同计数、逐项状态一致。
    const summary = readFileSync(written.summaryPath, 'utf-8');
    expect(summary).toContain('**pass**（pass 14 / fail 0 / not_run 0，必需检查共 14 项）');
    for (const check of report.checks) {
      expect(summary).toContain(`| ${check.id} | ${check.frBranch} | pass |`);
    }
    // 阶段外能力在报告中标记且不计入必需项计数。
    expect(report.outOfScope.map((entry) => entry.status)).toEqual([
      'not_run',
      'unsupported',
      'not_run',
    ]);
    expect(report.counts.total).toBe(14);
    expect(summary).toContain('P01-OOS-MODEL-LIVE');
    expect(summary).toContain('不计入必需项通过数');
  });

  it('run-id：非法值拒绝；不同 run-id 互不覆盖；已存在目录拒绝', () => {
    for (const bad of ['', '/abs', 'a/b', '.hidden', 'a b', 'a\\b', '..']) {
      expectReportError(() => assertValidRunId(bad), 'invalid_run_id');
    }
    expect(assertValidRunId('20261003T010203Z-deadbeef')).toBe('20261003T010203Z-deadbeef');

    const generated = generateP01RunId(new Date(Date.UTC(2026, 9, 3, 1, 2, 3)), '0badf00d');
    expect(generated).toBe('20261003T010203Z-0badf00d');
    expectReportError(
      () => generateP01RunId(new Date(Date.UTC(2026, 9, 3)), 'not-hex!'),
      'invalid_run_id',
    );

    const sandbox = newSandbox();
    const first = writeRun(sandbox, '20261003T010203Z-aaaaaaa1', passResults());
    const firstDigest = sha256Hex(readFileSync(first.reportPath));
    const second = writeRun(sandbox, '20261003T010204Z-bbbbbbb2', passResults());
    expect(second.runDir).not.toBe(first.runDir);
    // 另一 run-id 的报告不被覆盖。
    expect(sha256Hex(readFileSync(first.reportPath))).toBe(firstDigest);
    // 相同 run-id 拒绝覆盖。
    expectReportError(
      () => writeRun(sandbox, '20261003T010203Z-aaaaaaa1', passResults()),
      'run_id_exists',
    );
  });

  it('证据清单：越界路径拒绝；检查引用必须在清单中；checkId 必须已知', () => {
    const sandbox = newSandbox();
    expectReportError(
      () =>
        writeRun(sandbox, 'r-evidence-abs', passResults(), [
          { path: '/tmp/evidence/x.json', content: '{}' },
        ]),
      'unsafe_path',
    );
    expectReportError(
      () =>
        writeRun(sandbox, 'r-evidence-escape', passResults(), [
          { path: 'evidence/../escape.json', content: '{}' },
        ]),
      'unsafe_path',
    );
    // 检查引用了清单中不存在的证据 → evidence_missing。
    const results = passResults();
    results[0] = {
      ...results[0],
      evidenceRefs: ['evidence/missing/nope.json'],
    } as P01CheckResultInput;
    expectReportError(
      () => writeRun(sandbox, 'r-evidence-missing', results),
      'evidence_missing',
    );
    // 证据关联未知检查 ID → unknown_check。
    expectReportError(
      () =>
        writeRun(sandbox, 'r-evidence-unknown', passResults(), [
          { path: 'evidence/x/y.json', content: '{}', checkId: 'P01-FR9-NOPE' },
        ]),
      'unknown_check',
    );
    // 校验失败不留下半成品 run 目录。
    expect(existsSync(join(sandbox, 'artifacts', 'acceptance', 'p01', 'r-evidence-abs'))).toBe(
      false,
    );
    expect(
      existsSync(join(sandbox, 'artifacts', 'acceptance', 'p01', 'r-evidence-missing')),
    ).toBe(false);
  });

  it('缺失 / 损坏证据与被篡改的报告都使验证失败且阶段退出码非零', () => {
    const sandbox = newSandbox();
    const written = writeRun(sandbox, '20261003T020203Z-ccccccc3', passResults());
    expect(verifyP01ReportDirectory(written.runDir).ok).toBe(true);

    // 损坏一份证据（改写字节）。
    const victim = join(written.runDir, 'evidence', 'closed-loop', 'fr1-normal.json');
    writeFileSync(victim, '{"tampered":true}\n');
    let verification = verifyP01ReportDirectory(written.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain('证据损坏');
    expect(
      computeP01PhaseExitCode({
        conclusion: written.conclusion,
        evidenceOk: verification.ok,
        reportWritten: true,
      }),
    ).toBe(1);

    // 删除证据 → 缺失。
    rmSync(victim);
    verification = verifyP01ReportDirectory(written.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain('证据缺失');

    // 篡改 report.json 的计数 → Schema 校验拒绝。
    writeFileSync(
      written.reportPath,
      JSON.stringify(
        { ...JSON.parse(readFileSync(written.reportPath, 'utf-8')), counts: { pass: 0, fail: 0, not_run: 0, total: 0 } },
        null,
        2,
      ),
    );
    verification = verifyP01ReportDirectory(written.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain('报告 Schema 非法');
  });

  it('报告写入失败按 report_write_failed 处理，不留下看似完整的报告', () => {
    const sandbox = newSandbox();
    const reportRoot = join(sandbox, 'artifacts', 'acceptance', 'p01');
    mkdirSync(dirname(reportRoot), { recursive: true });
    writeFileSync(reportRoot, 'not a directory'); // reportRoot 是文件 → mkdir/runDir 失败
    expectReportError(
      () =>
        writeP01AcceptanceReport({
          reportRoot,
          input: validInput('r-write-fail', passResults()),
          evidenceFiles: [],
        }),
      'report_write_failed',
    );
  });

  it('合成凭据脱敏覆盖报告 JSON、摘要与证据附件（不只脱敏摘要）', () => {
    const sandbox = newSandbox();
    const results = passResults();
    results[4] = {
      checkId: 'P01-FR2-CONFIG',
      status: 'pass',
      errorAssertion: true,
      sideEffectAssertion: true,
      detail: `拒绝明文秘密 ${SYNTHETIC_SECRET} 的配置`,
    };
    const baseInput = validInput('r-redaction', results);
    const firstCommand = baseInput.commands[0] as P01AcceptanceReportInput['commands'][number];
    const input: P01AcceptanceReportInput = {
      ...baseInput,
      commands: [
        { ...firstCommand, argv: ['npm', 'run', 'verify', `--token=${SYNTHETIC_SECRET}`] },
      ],
    };
    const written = writeP01AcceptanceReport({
      reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p01'),
      input,
      evidenceFiles: [
        {
          path: 'evidence/config-and-tags/fr2-config.json',
          content: JSON.stringify({ credentialRef: SYNTHETIC_SECRET, status: 'pass' }),
          checkId: 'P01-FR2-CONFIG',
        },
      ],
      sensitiveValues: [SYNTHETIC_SECRET],
    });
    const reportText = readFileSync(written.reportPath, 'utf-8');
    const summaryText = readFileSync(written.summaryPath, 'utf-8');
    const evidenceText = readFileSync(
      join(written.runDir, 'evidence', 'config-and-tags', 'fr2-config.json'),
      'utf-8',
    );
    const placeholder = `[REDACTED:${sha256Hex(SYNTHETIC_SECRET).slice(0, 12)}]`;
    for (const text of [reportText, summaryText, evidenceText]) {
      expect(text).not.toContain(SYNTHETIC_SECRET);
      expect(text).toContain(placeholder);
    }
    // 字节证据包含敏感值时拒绝写出（不允许静默放行）。
    expectReportError(
      () =>
        writeP01AcceptanceReport({
          reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p01'),
          input: validInput('r-redaction-bytes', passResults()),
          evidenceFiles: [
            {
              path: 'evidence/bin/leak.bin',
              content: Buffer.from(`prefix ${SYNTHETIC_SECRET} suffix`, 'utf-8'),
            },
          ],
          sensitiveValues: [SYNTHETIC_SECRET],
        }),
      'secret_leak',
    );
    // 空敏感值非法（会破坏替换语义）。
    expectReportError(() => redactSensitiveText('x', ['']), 'invalid_input');
  });

  it('命令 cwd 使用逻辑位置；报告不包含仓库/个人绝对路径', () => {
    const sandbox = newSandbox();
    const baseBad = validInput('r-cwd-abs', passResults());
    const baseCommand = baseBad.commands[0] as P01AcceptanceReportInput['commands'][number];
    const badInput: P01AcceptanceReportInput = {
      ...baseBad,
      commands: [{ ...baseCommand, cwd: REPO_ROOT }],
    };
    expectReportError(
      () =>
        writeP01AcceptanceReport({
          reportRoot: join(sandbox, 'a'),
          input: badInput,
          evidenceFiles: [],
        }),
      'invalid_input',
    );

    const written = writeRun(sandbox, 'r-cwd-logical', passResults());
    const reportText = readFileSync(written.reportPath, 'utf-8');
    const summaryText = readFileSync(written.summaryPath, 'utf-8');
    expect(reportText).not.toContain(REPO_ROOT);
    expect(summaryText).not.toContain(REPO_ROOT);
    expect(reportText).not.toContain(homedir());
    expect(reportText).toContain('<repo>');
    // 证据引用全部为报告内相对路径。
    for (const entry of written.report.evidence) {
      expect(entry.path.startsWith('evidence/')).toBe(true);
      expect(entry.path.includes('\\')).toBe(false);
      expect(entry.path.startsWith('/')).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('F-007 严格报告 Schema 校验与阶段外能力', () => {
  function writtenReport(): { report: P01AcceptanceReport; runDir: string } {
    const sandbox = newSandbox();
    const written = writeRun(sandbox, `r-schema-${trackedSandboxes.length}`, passResults());
    return { report: written.report, runDir: written.runDir };
  }

  function mutate(report: P01AcceptanceReport, fn: (draft: Record<string, unknown>) => void): unknown {
    const draft = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    fn(draft);
    return draft;
  }

  it('接受合法报告并往返一致', () => {
    const { report, runDir } = writtenReport();
    const validated = validateP01AcceptanceReport(report);
    expect(validated.runId).toBe(report.runId);
    const fromDisk = validateP01AcceptanceReport(
      JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf-8')),
    );
    expect(fromDisk.counts).toEqual(report.counts);
  });

  it('拒绝非法 Schema：版本、未知字段、环境变量泄漏、计数/结论不一致', () => {
    const { report } = writtenReport();
    expectReportError(
      () => validateP01AcceptanceReport(mutate(report, (d) => { d.reportSchemaVersion = 2; })),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => { d.environmentVariables = { PATH: '/usr/bin' }; }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            d.counts = { pass: 13, fail: 1, not_run: 0, total: 14 };
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () => validateP01AcceptanceReport(mutate(report, (d) => { d.conclusion = 'fail'; })),
      'invalid_report',
    );
  });

  it('拒绝非法逐项结果：顺序/未知 ID、非法状态、not_run 分类缺失、负例缺断言', () => {
    const { report } = writtenReport();
    // 顺序固定：交换前两项即拒绝。
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            const checks = d.checks as unknown[];
            [checks[0], checks[1]] = [checks[1], checks[0]];
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            (d.checks as Record<string, unknown>[])[0].status = 'green';
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            const check = (d.checks as Record<string, unknown>[])[0];
            check.status = 'not_run';
            check.notRunReason = null;
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            const check = (d.checks as Record<string, unknown>[])[0];
            check.status = 'pass';
            check.notRunReason = 'skipped';
          }),
        ),
      'invalid_report',
    );
    // 预期负例 pass 但缺少双断言。
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            const check = (d.checks as Record<string, unknown>[])[3]; // P01-FR1-ROLLBACK
            check.sideEffectAssertion = null;
          }),
        ),
      'invalid_report',
    );
  });

  it('拒绝非法证据清单：越界路径、重复路径、未知 checkId、引用缺失', () => {
    const { report } = writtenReport();
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            (d.evidence as Record<string, unknown>[])[0].path = '../escape.json';
          }),
        ),
      'unsafe_path',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            const evidence = d.evidence as Record<string, unknown>[];
            evidence.push({ ...evidence[0] });
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            (d.evidence as Record<string, unknown>[])[0].checkId = 'P01-FR9-NOPE';
          }),
        ),
      'invalid_report',
    );
    // 检查引用了清单外证据。
    expectReportError(
      () =>
        validateP01AcceptanceReport(
          mutate(report, (d) => {
            (d.checks as Record<string, unknown>[])[0].evidenceRefs = ['evidence/ghost.json'];
          }),
        ),
      'invalid_report',
    );
  });

  it('阶段外能力仅允许 P01-OOS-* 与 not_run/unsupported，且不进入必需项计数', () => {
    const sandbox = newSandbox();
    const input = validInput('r-oos-ok', passResults());
    const report = buildP01AcceptanceReport(input, []);
    expect(report.outOfScope).toHaveLength(3);
    expect(report.counts).toEqual({ pass: 14, fail: 0, not_run: 0, total: 14 });
    expect(report.conclusion).toBe('pass');

    const badPrefix: P01AcceptanceReportInput = {
      ...validInput('r-oos-bad', passResults()),
      outOfScope: [
        { id: 'P01-FR1-NORMAL', capability: '冒充必需检查', status: 'not_run', note: 'x' },
      ],
    };
    expectReportError(() => buildP01AcceptanceReport(badPrefix, []), 'invalid_input');

    const badStatus: P01AcceptanceReportInput = {
      ...validInput('r-oos-bad-status', passResults()),
      outOfScope: [
        {
          id: 'P01-OOS-X',
          capability: 'x',
          status: 'pass' as never,
          note: 'y',
        },
      ],
    };
    expectReportError(() => buildP01AcceptanceReport(badStatus, []), 'invalid_input');
  });
});
