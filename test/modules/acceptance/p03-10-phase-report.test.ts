/**
 * F-016 P03 阶段结果聚合、证据索引、脱敏与严格退出结论回归。
 *
 * 验收标准（Task F-016）：
 * - 阶段报告与产品 Feature 报告明确分层；每个检查从 P03 检查清单带出 FR/T 编号、
 *   验证层次、清单断言与证据类别，并记录输入计划摘要、受测 commit、工具版本、
 *   命令/退出码和完整的产品 Feature 执行报告引用；
 * - 正常/预期负例只有真实状态断言与副作用核对同时成立才通过；准备失败、缺结果、
 *   缺输出、未运行、超时和真假执行混淆记 fail/not_run；必需项任一非通过则结论非零；
 * - 每次验收独立 run-id，生成 report.json/summary.md、pass/fail/not_run 计数和遗留
 *   问题；未知/重复检查 ID、重复证据身份一律拒绝，不静默重复聚合；
 * - SQLite/Git/进程与 cleanup manifest 在清理前导出；证据记录相对路径、hash、size，
 *   落盘后可整目录重验；缺失、篡改、路径越界、写入失败或清理未确认都阻止成功；
 * - 合成凭据与开发机绝对路径不进入报告/证据；脱敏后的证据 hash 与落盘文件一致，
 *   logger/detail 文本不能替代真实断言。
 *
 * 所有场景使用系统临时目录，不调用模型、不联网、不触碰真实用户资源。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P03_DEFERRED_IDS,
  P03_FAKE_IDENTITY,
  P03_REQUIRED_CHECK_IDS,
  loadP03AcceptanceConfig,
  loadP03Checklist,
} from '../../../scripts/acceptance/p03-config.ts';
import type {
  P03Checklist,
  P03ChecklistItem,
  P03EvidenceCategory,
} from '../../../scripts/acceptance/p03-config.ts';
import {
  P03_PHASE_EVIDENCE_CATEGORIES,
  P03ReportError,
  computeP03PhaseExitCode,
  generateP03RunId,
  redactSensitiveText,
  scanTextForCredentialShapes,
  scanTextForDeveloperPaths,
  validateP03AcceptanceReport,
  verifyP03ReportDirectory,
  writeP03AcceptanceReport,
} from '../../../scripts/acceptance/p03-report.ts';
import type {
  P03CheckResultInput,
  P03CleanupRecord,
  P03EvidenceFileInput,
  P03PhaseReportInput,
  P03ProductReportRef,
  P03ReportErrorKind,
} from '../../../scripts/acceptance/p03-report.ts';

const CHECKLIST: P03Checklist = loadP03Checklist();
const CONFIG = loadP03AcceptanceConfig();
const REQUIRED_ITEMS = CHECKLIST.items.filter((item) => item.group !== 'deferred');

const SANDBOXES: string[] = [];
const PRODUCT_REPORT_PATH = 'evidence/product-feature-report.json';
const CLEANUP_MANIFEST_PATH = 'evidence/phase-manifest.txt';
const PHASE_SQLITE_PATH = 'evidence/phase-sqlite.txt';

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p03-report-'));
  SANDBOXES.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of SANDBOXES) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function expectReportError(fn: () => unknown, kind: P03ReportErrorKind): P03ReportError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(P03ReportError);
    expect((error as P03ReportError).kind).toBe(kind);
    return error as P03ReportError;
  }
  throw new Error(`应抛出 P03ReportError(${kind})`);
}

function evidenceForCheck(item: P03ChecklistItem): P03EvidenceFileInput[] {
  return item.evidence.map((category) => ({
    path: `evidence/checks/${item.id.toLowerCase()}-${category}.txt`,
    identity: `${item.id}:${category}`,
    category: category as P03EvidenceCategory,
    checkId: item.id,
    content: `${item.id} ${category} structured evidence\n`,
  }));
}

function phaseEvidence(): P03EvidenceFileInput[] {
  return [
    ...P03_PHASE_EVIDENCE_CATEGORIES.map((category) => ({
      path: `evidence/phase-${category}.txt`,
      identity: `phase:${category}`,
      category: category as P03EvidenceCategory,
      checkId: null,
      content: `phase ${category} export before cleanup\n`,
    })),
    {
      path: PRODUCT_REPORT_PATH,
      identity: 'product:feature-execution-report',
      category: 'report',
      checkId: null,
      content: '{"schemaVersion":1,"scope":"feature-execution-report"}\n',
    },
  ];
}

function allEvidence(): P03EvidenceFileInput[] {
  return [...phaseEvidence(), ...REQUIRED_ITEMS.flatMap((item) => evidenceForCheck(item))];
}

const PRODUCT_REPORT: P03ProductReportRef = {
  featureId: '11111111-1111-4111-8111-111111111111',
  label: '完整 Feature 执行报告',
  command: 'shiploop feature report <featureId> --project <projectId> --json',
  evidenceRef: PRODUCT_REPORT_PATH,
};

const CLEANUP: P03CleanupRecord = {
  confirmed: true,
  processesGone: true,
  manifestEvidenceRefs: [CLEANUP_MANIFEST_PATH],
  notes: ['受管进程组已确认消失'],
};

function passResults(): P03CheckResultInput[] {
  return REQUIRED_ITEMS.map((item) => ({
    checkId: item.id,
    status: 'pass',
    executionMode: 'fake',
    assertions: [{ id: `${item.id}:persisted-state`, satisfied: true }],
    sideEffectVerified: true,
    durationMs: 12,
    detail: `${item.id} 真实状态断言通过`,
    evidenceRefs: evidenceForCheck(item).map((entry) => entry.path),
  }));
}

function reportInput(runId: string, overrides: Partial<P03PhaseReportInput> = {}): P03PhaseReportInput {
  return {
    runId,
    generatedAtUtc: '2026-10-19T12:00:00Z',
    plan: {
      phaseId: CONFIG.plan.phaseId,
      stepId: CONFIG.plan.stepId,
      title: CONFIG.plan.title,
      scope: CONFIG.plan.scope,
      version: CONFIG.plan.version,
      contractDoc: CONFIG.plan.contractDoc,
      digestSha256: 'a'.repeat(64),
      checklistDigestSha256: 'b'.repeat(64),
    },
    git: {
      commit: 'c'.repeat(40),
      worktree: 'clean',
      branch: 'feat/p03-10-acceptance',
      priorBaselines: [],
    },
    platform: { system: 'Darwin', release: '25.0.0', arch: 'arm64' },
    tools: {
      node: '22.19.0',
      npm: '10.9.3',
      git: 'git version 2.50.1',
      sqlite: '3.50.4',
      betterSqlite3: '12.2.0',
      drizzleOrm: '0.44.2',
    },
    commands: [
      {
        label: 'focused-tests',
        argv: ['node', 'scripts/run-tests.ts', '--', 'test/modules/acceptance/p03-10-phase-report.test.ts'],
        cwd: '<repo>',
        exitCode: 0,
        durationMs: 1234,
      },
    ],
    results: passResults(),
    cleanup: CLEANUP,
    productReports: [PRODUCT_REPORT],
    openIssues: [],
    knownLimitations: ['live/Pi 与强沙箱不在 P03 范围'],
    ...overrides,
  };
}

function writeRun(
  runId: string,
  options: {
    sandboxDir?: string;
    evidenceFiles?: readonly P03EvidenceFileInput[];
    sensitiveValues?: readonly string[];
    input?: Partial<P03PhaseReportInput>;
  } = {},
) {
  return writeP03AcceptanceReport({
    reportRoot: options.sandboxDir ?? sandbox(),
    checklist: CHECKLIST,
    input: reportInput(runId, options.input),
    evidenceFiles: options.evidenceFiles ?? allEvidence(),
    sensitiveValues: options.sensitiveValues ?? [],
  });
}

function mutateResults(
  mutate: (results: P03CheckResultInput[]) => void,
): P03CheckResultInput[] {
  const results = passResults();
  mutate(results);
  return results;
}

/* ------------------------------------------------------------------ */

describe('F-016 P03 阶段报告分层、清单关联与严格聚合', () => {
  it('[case:checklist-layered-report] 按清单关联 FR/T、分层并引用完整产品报告', () => {
    const written = writeRun('20261019T120000Z-deadbeef');

    expect(written.conclusion).toBe('pass');
    expect(written.exitCode).toBe(0);
    expect(written.problems).toEqual([]);
    expect(written.report.reportLayer).toBe('phase-acceptance');
    expect(written.report.checks.map((check) => check.id)).toEqual([...P03_REQUIRED_CHECK_IDS]);
    expect(written.report.fakeIdentity).toEqual(P03_FAKE_IDENTITY);

    for (const check of written.report.checks) {
      const item = CHECKLIST.items.find((entry) => entry.id === check.id) as P03ChecklistItem;
      expect(check.layer).toBe(item.layer);
      expect(check.fr).toEqual(item.fr);
      expect(check.acceptanceRefs).toEqual(item.acceptanceRefs);
      expect(check.checklistAssertions).toEqual(item.assertions);
      expect(check.evidenceCategories).toEqual(item.evidence);
    }
    const fr1 = written.report.checks.find((check) => check.fr.includes('FR-1'));
    expect(fr1?.acceptanceRefs.length).toBeGreaterThan(0);

    expect(written.report.plan.digestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.report.plan.checklistDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.report.git.commit).toBe('c'.repeat(40));
    expect(written.report.tools.node).toBe('22.19.0');
    expect(written.report.commands[0]?.argv).toEqual([
      'node',
      'scripts/run-tests.ts',
      '--',
      'test/modules/acceptance/p03-10-phase-report.test.ts',
    ]);
    expect(written.report.commands[0]?.exitCode).toBe(0);
    expect(written.report.productReports).toEqual([PRODUCT_REPORT]);
    expect(written.report.deferred.map((entry) => entry.id)).toEqual([...P03_DEFERRED_IDS]);
    expect(written.report.counts).toEqual({
      pass: P03_REQUIRED_CHECK_IDS.length,
      fail: 0,
      not_run: 0,
      total: P03_REQUIRED_CHECK_IDS.length,
    });

    const summary = readFileSync(written.summaryPath, 'utf-8');
    expect(summary).toContain('P03 阶段验收摘要');
    expect(summary).toContain('阶段验收报告（本文件');
    expect(summary).toContain('产品 Feature 报告引用');
    expect(summary).toContain('完整 Feature 执行报告');
    expect(summary).toContain('P03-FR1-CLOSED-LOOP');
    expect(summary).toContain('T02');
    expect(summary).toContain(`pass ${P03_REQUIRED_CHECK_IDS.length} / fail 0 / not_run 0`);
    expect(summary).toContain('校验清单摘要');
  });

  it('[case:strict-pass-gates] 真实断言/副作用核对不满足或真假执行混淆时不通过', () => {
    const noAssertions = writeRun(
      '20261019T120001Z-00000001',
      {
        input: {
          results: mutateResults((results) => {
            results[0] = { ...results[0], assertions: [], detail: '日志说成功' } as P03CheckResultInput;
          }),
        },
      },
    );
    expect(noAssertions.conclusion).toBe('fail');
    expect(noAssertions.exitCode).toBe(1);
    expect(noAssertions.problems.join('\n')).toContain('真实状态断言');

    const unmetAssertion = writeRun(
      '20261019T120002Z-00000002',
      {
        input: {
          results: mutateResults((results) => {
            results[1] = {
              ...results[1],
              assertions: [{ id: 'state', satisfied: false }],
            } as P03CheckResultInput;
          }),
        },
      },
    );
    expect(unmetAssertion.conclusion).toBe('fail');
    expect(unmetAssertion.problems.join('\n')).toContain('断言未满足');

    const noSideEffect = writeRun(
      '20261019T120003Z-00000003',
      {
        input: {
          results: mutateResults((results) => {
            results[2] = { ...results[2], sideEffectVerified: undefined } as P03CheckResultInput;
          }),
        },
      },
    );
    expect(noSideEffect.conclusion).toBe('fail');
    expect(noSideEffect.problems.join('\n')).toContain('副作用核对');

    const fakeRealConfusion = writeRun(
      '20261019T120004Z-00000004',
      {
        input: {
          results: mutateResults((results) => {
            results[3] = { ...results[3], executionMode: 'live' } as P03CheckResultInput;
          }),
        },
      },
    );
    expect(fakeRealConfusion.conclusion).toBe('fail');
    expect(fakeRealConfusion.exitCode).toBe(1);
    expect(fakeRealConfusion.problems.join('\n')).toContain('真假执行混淆');

    expectReportError(
      () =>
        writeRun('20261019T120005Z-00000005', {
          input: {
            results: mutateResults((results) => {
              results[0] = { ...results[0], checkId: 'P03-UNKNOWN-CHECK' } as P03CheckResultInput;
            }),
          },
        }),
      'unknown_check',
    );
    expectReportError(
      () =>
        writeRun('20261019T120006Z-00000006', {
          input: {
            results: mutateResults((results) => {
              results.push({ ...results[0] });
            }),
          },
        }),
      'duplicate_check',
    );
  });

  it('[case:not-run-classification] 准备失败/缺结果/缺输出/超时/未运行分类可见且结论非零', () => {
    const results = passResults();
    results[1] = {
      ...results[1],
      status: 'not_run',
      notRunReason: 'preparation_failure',
    } as P03CheckResultInput;
    results[2] = {
      ...results[2],
      status: 'not_run',
      notRunReason: 'missing_output',
    } as P03CheckResultInput;
    results[3] = {
      ...results[3],
      status: 'not_run',
      notRunReason: 'timeout',
    } as P03CheckResultInput;
    results[4] = {
      ...results[4],
      status: 'not_run',
      notRunReason: 'skipped',
    } as P03CheckResultInput;
    results.splice(5, 1);

    const written = writeRun('20261019T120007Z-00000007', { input: { results } });
    expect(written.conclusion).toBe('fail');
    expect(written.exitCode).toBe(1);
    expect(written.counts.pass).toBe(P03_REQUIRED_CHECK_IDS.length - 5);
    expect(written.counts.not_run).toBe(5);
    expect(written.counts.fail).toBe(0);
    const summary = readFileSync(written.summaryPath, 'utf-8');
    expect(summary).toContain('not_run (preparation_failure)');
    expect(summary).toContain('not_run (missing_output)');
    expect(summary).toContain('not_run (timeout)');
    expect(summary).toContain('not_run (skipped)');
    expect(summary).toContain('not_run (missing_result)');

    expectReportError(
      () =>
        writeRun('20261019T120008Z-00000008', {
          input: {
            results: mutateResults((results2) => {
              results2[0] = {
                ...results2[0],
                status: 'not_run',
              } as P03CheckResultInput;
            }),
          },
        }),
      'invalid_result',
    );
  });

  it('[case:evidence-integrity] 证据 hash/size 可重验，缺失/篡改/越界/重复身份被阻止', () => {
    const dir = sandbox();
    const written = writeRun('20261019T120009Z-00000009', { sandboxDir: dir });
    expect(verifyP03ReportDirectory(written.runDir)).toEqual({ ok: true, problems: [] });

    const firstEvidence = written.report.evidence[0];
    const absolute = join(written.runDir, ...firstEvidence.path.split('/'));
    const onDisk = readFileSync(absolute);
    expect(firstEvidence.sizeBytes).toBe(onDisk.length);
    expect(firstEvidence.sha256).toBe(sha256(onDisk));

    writeFileSync(absolute, Buffer.alloc(onDisk.length, 0x41));
    const tampered = verifyP03ReportDirectory(written.runDir);
    expect(tampered.ok).toBe(false);
    expect(tampered.problems.join('\n')).toContain('sha256 不符');

    rmSync(absolute);
    const missing = verifyP03ReportDirectory(written.runDir);
    expect(missing.ok).toBe(false);
    expect(missing.problems.join('\n')).toContain('证据缺失');

    expectReportError(
      () =>
        writeRun('20261019T120010Z-00000010', {
          evidenceFiles: [
            ...allEvidence(),
            {
              path: 'evidence/../../escape.txt',
              identity: 'escape',
              category: 'artifact',
              content: 'escape\n',
            },
          ],
        }),
      'unsafe_path',
    );
    expectReportError(
      () =>
        writeRun('20261019T120011Z-00000011', {
          evidenceFiles: [
            ...allEvidence(),
            {
              path: '/tmp/absolute.txt',
              identity: 'absolute',
              category: 'artifact',
              content: 'absolute\n',
            },
          ],
        }),
      'unsafe_path',
    );
    expectReportError(
      () =>
        writeRun('20261019T120012Z-00000012', {
          evidenceFiles: [
            ...allEvidence(),
            {
              path: 'evidence/duplicate-identity.txt',
              identity: 'phase:sqlite',
              category: 'artifact',
              content: 'duplicate identity\n',
            },
          ],
        }),
      'duplicate_evidence',
    );
    expectReportError(
      () =>
        writeRun('20261019T120013Z-00000013', {
          evidenceFiles: [
            ...allEvidence(),
            {
              path: PHASE_SQLITE_PATH,
              identity: 'phase:sqlite-copy',
              category: 'artifact',
              content: 'duplicate path\n',
            },
          ],
        }),
      'duplicate_evidence',
    );

    // 缺少清理前 process 证据类别 → 结论非零（即使每项检查其余断言都通过）。
    const withoutProcess = allEvidence().filter((entry) => entry.category !== 'process');
    const noProcess = writeRun('20261019T120014Z-00000014', {
      evidenceFiles: withoutProcess,
      input: {
        results: passResults().map((result) => ({
          ...result,
          evidenceRefs: (result.evidenceRefs ?? []).filter((ref) =>
            withoutProcess.some((entry) => entry.path === ref),
          ),
        })),
      },
    });
    expect(noProcess.conclusion).toBe('fail');
    expect(noProcess.problems.join('\n')).toContain('process');

    // 单项检查声明的证据类别未覆盖 → 结论非零并指出检查与类别。
    const target = REQUIRED_ITEMS[0];
    const targetPath = evidenceForCheck(target)[0].path;
    const uncovered = writeRun('20261019T120015Z-00000015', {
      evidenceFiles: allEvidence().filter((entry) => entry.path !== targetPath),
      input: {
        results: passResults().map((result) =>
          result.checkId === target.id
            ? {
                ...result,
                evidenceRefs: (result.evidenceRefs ?? []).filter((ref) => ref !== targetPath),
              }
            : result,
        ),
      },
    });
    expect(uncovered.conclusion).toBe('fail');
    expect(uncovered.problems.join('\n')).toContain(target.id);
    expect(uncovered.problems.join('\n')).toContain('证据类别');

    // 落盘后的 report.json 计数被篡改 → 重验失败。
    const reportPath = join(written.runDir, 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as Record<string, unknown>;
    (report.counts as Record<string, number>).pass += 1;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const tamperedReport = verifyP03ReportDirectory(written.runDir);
    expect(tamperedReport.ok).toBe(false);
    expect(tamperedReport.problems.join('\n')).toContain('报告 Schema 非法');

    // 手工构造不一致报告也被严格 Schema 拒绝。
    expectReportError(
      () => validateP03AcceptanceReport(report, CHECKLIST),
      'invalid_report',
    );
  });

  it('[case:cleanup-and-product-report] 清理未确认、进程未消失、缺 manifest/产品报告阻止成功', () => {
    const unconfirmed = writeRun('20261019T120016Z-00000016', {
      input: { cleanup: { ...CLEANUP, confirmed: false } },
    });
    expect(unconfirmed.conclusion).toBe('fail');
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.problems.join('\n')).toContain('cleanup 未确认');

    const processAlive = writeRun('20261019T120017Z-00000017', {
      input: { cleanup: { ...CLEANUP, processesGone: false } },
    });
    expect(processAlive.conclusion).toBe('fail');
    expect(processAlive.problems.join('\n')).toContain('受管进程组');

    const noManifest = writeRun('20261019T120018Z-00000018', {
      input: { cleanup: { ...CLEANUP, manifestEvidenceRefs: [] } },
    });
    expect(noManifest.conclusion).toBe('fail');
    expect(noManifest.problems.join('\n')).toContain('cleanup manifest');

    const manifestNotManifestCategory = writeRun('20261019T120019Z-00000019', {
      input: { cleanup: { ...CLEANUP, manifestEvidenceRefs: [PHASE_SQLITE_PATH] } },
    });
    expect(manifestNotManifestCategory.conclusion).toBe('fail');
    expect(manifestNotManifestCategory.problems.join('\n')).toContain('manifest');

    const noProductReport = writeRun('20261019T120020Z-00000020', {
      input: { productReports: [] },
    });
    expect(noProductReport.conclusion).toBe('fail');
    expect(noProductReport.problems.join('\n')).toContain('产品 Feature 报告');

    const missingProductEvidence = writeRun('20261019T120021Z-00000021', {
      evidenceFiles: allEvidence().filter((entry) => entry.path !== PRODUCT_REPORT_PATH),
    });
    expect(missingProductEvidence.conclusion).toBe('fail');
    expect(missingProductEvidence.problems.join('\n')).toContain('产品 Feature 报告');

    const blockingIssue = writeRun('20261019T120022Z-00000022', {
      input: {
        openIssues: [{ id: 'P03-ISSUE-1', summary: '人工放行未完成', blocking: true }],
      },
    });
    expect(blockingIssue.conclusion).toBe('fail');
    expect(blockingIssue.problems.join('\n')).toContain('P03-ISSUE-1');
    expect(readFileSync(blockingIssue.summaryPath, 'utf-8')).toContain('人工放行未完成');

    const nonBlocking = writeRun('20261019T120023Z-00000023', {
      input: {
        openIssues: [{ id: 'P03-ISSUE-2', summary: '后续阶段优化项', blocking: false }],
      },
    });
    expect(nonBlocking.conclusion).toBe('pass');
    expect(readFileSync(nonBlocking.summaryPath, 'utf-8')).toContain('后续阶段优化项');
  });

  it('[case:redaction-run-id] 凭据/开发机路径不落盘，脱敏后 hash 与文件一致，run-id 独立', () => {
    const dir = sandbox();
    const token = 'sk-synthetic-F016-ABCDEF123456';
    const devPath = '/Users/developer/private-workspace/shiploop';
    const sensitiveFiles = allEvidence().map((entry) =>
      entry.path === PRODUCT_REPORT_PATH
        ? {
            ...entry,
            content: `{"token":"${token}","cwd":"${devPath}"}\n`,
          }
        : entry,
    );
    const written = writeRun('20261019T120024Z-00000024', {
      sandboxDir: dir,
      evidenceFiles: sensitiveFiles,
      sensitiveValues: [token, devPath],
      input: {
        results: passResults().map((result, index) =>
          index === 0
            ? {
                ...result,
                detail: `使用合成凭据 ${token}，工作目录 ${devPath}`,
              }
            : result,
        ),
      },
    });
    expect(written.conclusion).toBe('pass');
    expect(verifyP03ReportDirectory(written.runDir)).toEqual({ ok: true, problems: [] });

    const productEntry = written.report.evidence.find(
      (entry) => entry.path === PRODUCT_REPORT_PATH,
    );
    const productBytes = readFileSync(join(written.runDir, ...PRODUCT_REPORT_PATH.split('/')));
    const productText = productBytes.toString('utf-8');
    const rawProductContent = sensitiveFiles.find(
      (entry) => entry.path === PRODUCT_REPORT_PATH,
    )?.content as string;
    expect(productText).not.toContain(token);
    expect(productText).not.toContain(devPath);
    expect(productText).toContain('[REDACTED:');
    expect(productEntry?.sha256).toBe(sha256(productBytes));
    expect(productEntry?.sha256).not.toBe(sha256(rawProductContent));

    const reportText = readFileSync(written.reportPath, 'utf-8');
    const summaryText = readFileSync(written.summaryPath, 'utf-8');
    for (const text of [reportText, summaryText]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(devPath);
      expect(scanTextForCredentialShapes(text)).toEqual([]);
      expect(scanTextForDeveloperPaths(text)).toEqual([]);
    }

    // 未登记敏感值的开发机绝对路径 / Bearer 凭据形状 → 拒绝写出（失败可见）。
    expectReportError(
      () =>
        writeRun('20261019T120025Z-00000025', {
          input: {
            results: mutateResults((results) => {
              results[0] = {
                ...results[0],
                detail: '工作目录 /Users/someone/another-repo',
              } as P03CheckResultInput;
            }),
          },
        }),
      'absolute_path_leak',
    );
    expectReportError(
      () =>
        writeRun('20261019T120026Z-00000026', {
          input: {
            results: mutateResults((results) => {
              results[0] = {
                ...results[0],
                detail: 'Authorization header value was Bearer abc.def.ghi',
              } as P03CheckResultInput;
            }),
          },
        }),
      'secret_leak',
    );

    // logger/detail 文本不能替代真实断言：只有 detail 的“通过”仍降级 fail。
    const detailOnly = writeRun('20261019T120027Z-00000027', {
      input: {
        results: mutateResults((results) => {
          results[0] = {
            ...results[0],
            assertions: [],
            detail: 'logger 文本显示全部通过',
          } as P03CheckResultInput;
        }),
      },
    });
    expect(detailOnly.conclusion).toBe('fail');

    expect(generateP03RunId(new Date('2026-10-19T12:00:00Z'), 'deadbeef')).toBe(
      '20261019T120000Z-deadbeef',
    );
    expectReportError(() => generateP03RunId(new Date('2026-10-19T12:00:00Z'), 'XYZ'), 'invalid_run_id');
    expectReportError(
      () =>
        writeRun('20261019T120024Z-00000024', {
          sandboxDir: dir,
        }),
      'run_id_exists',
    );

    expect(redactSensitiveText(`a ${token} b`, [token])).not.toContain(token);
    expect(computeP03PhaseExitCode({
      conclusion: 'pass',
      evidenceOk: true,
      reportWritten: true,
      cleanupConfirmed: false,
    })).toBe(1);
  });
});

