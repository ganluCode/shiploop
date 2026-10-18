/**
 * F-009 P02 版本化阶段报告写出、证据导出校验与脱敏回归（契约 §2.1 `P02-PHASE-REPORT`）。
 *
 * 覆盖验收标准的报告侧要求：
 * - report.json 与 summary.md 由同一结果源生成，包含输入计划摘要、完整受测
 *   commit/工作树状态、工具版本、实际命令/退出码/耗时、状态摘要、证据位置、
 *   pass/fail/not_run 计数与已知限制；每次运行独立 run-id 目录，不覆盖此前证据；
 * - 证据在临时资源清理前以内存内容传入（模块不读临时目录），引用为报告目录内
 *   相对路径且带 hash/size，可整目录重验；保留非秘密实例/锁/退出、项目/配置/检查、
 *   Git 文件摘要与基线输出核对；不复制认证文件（凭据形状拒绝）或全量环境变量
 *   （Schema 无环境字段且未知字段拒绝）；
 * - 缺失/损坏证据、非法 Schema、写报告失败都使阶段退出码非零；
 * - 合成 token、认证头（Bearer 形状）、凭据键名与开发机路径统一脱敏/拒绝，
 *   不允许只脱敏摘要却泄漏附件；
 * - 阶段外能力（Pi Live、其他平台、强沙箱）P02-OOS-* 标 not_run/unsupported
 *   且不计入必需项通过数。
 *
 * 全部场景在系统临时目录的独立沙箱中执行，不触碰真实用户资源，不调用模型。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  P02_ACCEPTANCE_REPORT_SCHEMA_VERSION,
  P02_REQUIRED_CHECKS,
  P02ReportError,
  buildP02AcceptanceReport,
  computeP02PhaseExitCode,
  validateP02AcceptanceReport,
  verifyP02ReportDirectory,
  writeP02AcceptanceReport,
} from '../../../scripts/acceptance/p02-report.ts';
import type {
  P02AcceptanceReport,
  P02AcceptanceReportInput,
  P02CheckResultInput,
  P02EvidenceFileInput,
  P02ReportErrorKind,
} from '../../../scripts/acceptance/p02-report.ts';
import {
  exportEvidenceDocument,
  scanForCredentialShapes,
} from '../../helpers/p02-4/evidence-snapshot.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SYNTHETIC_SECRET = 'shiploop://P02-4-TOP-SECRET-SENTINEL';

const trackedSandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of trackedSandboxes) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function newSandbox(): string {
  const sandbox = createTempSandbox('shiploop-p02-4-report-', {
    outside: [REPO_ROOT, homedir()],
  });
  trackedSandboxes.push(sandbox.path);
  return sandbox.path;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function expectReportError(fn: () => unknown, kind: P02ReportErrorKind): P02ReportError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(P02ReportError);
    expect((error as P02ReportError).kind).toBe(kind);
    return error as P02ReportError;
  }
  throw new Error(`应抛出 P02ReportError(${kind})`);
}

function passResults(): P02CheckResultInput[] {
  return P02_REQUIRED_CHECKS.map((definition) => ({
    checkId: definition.id,
    status: 'pass',
    durationMs: 40,
    ...(definition.requiredAssertions.includes('error') ? { errorAssertion: true } : {}),
    ...(definition.requiredAssertions.includes('zeroStart')
      ? { zeroStartAssertion: true }
      : {}),
    ...(definition.requiredAssertions.includes('persistentState')
      ? { persistentStateAssertion: true }
      : {}),
  }));
}

function validInput(runId: string, results: P02CheckResultInput[]): P02AcceptanceReportInput {
  return {
    runId,
    generatedAtUtc: '2026-10-05T02:03:04.000Z',
    plan: {
      phaseId: 'p02',
      title: 'P02 双客户端与初始化验收',
      scope: 'FR-1/FR-2 双 CLI 竞争、共享持久状态、幂等、只读接入、拒绝、退出/重启与基线失败',
      version: '0.2',
      digestSha256: 'a'.repeat(64),
    },
    git: {
      commit: 'b'.repeat(40),
      worktree: 'clean',
      branch: 'feat/2026-10-04-23-19-52_p02-4-p02',
      priorBaselines: [
        {
          phase: 'p02-host-lifecycle',
          branch: 'feat/2026-10-04-23-19-52_p02-1-host',
          tipCommit: 'c'.repeat(40),
        },
        { phase: 'p02-commands-events', branch: 'feat/2026-10-04-23-19-52_p02-2', tipCommit: 'd'.repeat(40) },
        { phase: 'p02-onboarding', branch: 'feat/2026-10-04-23-19-52_p02-3', tipCommit: 'e'.repeat(40) },
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
    schemaVersions: {
      settingsSchema: 2,
      settingsExportFormat: 1,
      sqliteMigrations: [1, 2, 3, 4, 5],
      applicationWireSchema: 3,
      eventEnvelopeSchema: 1,
    },
    commands: [
      {
        label: 'npm run verify',
        argv: ['npm', 'run', 'verify'],
        cwd: '<repo>',
        exitCode: 0,
        durationMs: 123_456,
      },
      {
        label: 'npm run accept:p02',
        argv: ['npm', 'run', 'accept:p02'],
        cwd: '<repo>',
        exitCode: 0,
        durationMs: 234_567,
      },
    ],
    results,
    stateDigests: {
      businessInputSha256: 'f'.repeat(64),
      codeSha256: '0'.repeat(64),
      persistentStateSha256: '1'.repeat(64),
    },
    outOfScope: [
      {
        id: 'P02-OOS-PI-LIVE',
        capability: 'Pi/模型 Live 调用',
        status: 'not_run',
        note: 'P02 无 Work/Pi SDK 与真实模型执行',
      },
      {
        id: 'P02-OOS-OTHER-PLATFORMS',
        capability: 'Windows/WSL/Linux',
        status: 'not_run',
        note: '正式验收限 macOS',
      },
      {
        id: 'P02-OOS-STRONG-SANDBOX',
        capability: '强 OS 沙箱',
        status: 'unsupported',
        note: '首版为可信项目模式',
      },
    ],
    knownLimitations: ['正式验收限 macOS；未运行真实 Pi/模型 Live；无强 OS 沙箱。'],
  };
}

/**
 * 样例证据（F-002 exportEvidenceDocument 同源形态）：非秘密实例/锁/退出、
 * 项目/配置/检查、Git 文件摘要与基线输出核对；不含凭据或环境变量。
 * 临时资源路径用逻辑位置表达。
 */
function sampleEvidence(): P02EvidenceFileInput[] {
  return [
    {
      path: 'evidence/unique-host/host-identity.json',
      content: exportEvidenceDocument({
        hostIdentity: {
          hostInstanceId: 'host-inst-0001',
          dataRootIdentity: 'd'.repeat(64),
          lifecycleState: 'running',
          pid: 4242,
          listenAddress: '127.0.0.1',
          port: 51000,
          protocolVersion: 1,
        },
        notes: [
          '双 CLI 同步屏障竞争：恰一持锁 Host/写入者（writer.lock 唯一持有方）',
          '发现目录 host/ 0700、发现文件 0600；落选 CLI 回收自有候选后同实例连接',
        ],
      }),
      checkId: 'P02-FR1-UNIQUE-HOST',
    },
    {
      path: 'evidence/shared-state/project-config-check.json',
      content: exportEvidenceDocument({
        notes: [
          'projectId=proj-0001 双客户端 project list/get/overview 逐字段一致',
          'config global 当前值一致、revision=2、来源 global_default；project 配置 revision=1',
          'baseline 检查 checkKey=sample-ok、状态 passed、退出码 0',
        ],
      }),
      checkId: 'P02-FR1-SHARED-STATE',
    },
    {
      path: 'evidence/source-preserved/git-file-digests.json',
      content: exportEvidenceDocument({
        repositories: [
          {
            canonicalPath: '<repo>',
            gitTopLevel: '<repo>',
            headCommit: 'e'.repeat(40),
            branch: 'main',
            statusPorcelain: '',
            tracked: [
              { relativePath: 'AGENTS.md', digest: '2'.repeat(64), sizeBytes: 48 },
              { relativePath: 'README.md', digest: '3'.repeat(64), sizeBytes: 128 },
            ],
            untracked: [],
            treeDigest: '4'.repeat(64),
          },
        ],
        notes: ['接入前后 HEAD/索引/Git 状态/tracked+untracked 摘要逐项一致；哨兵不存在'],
      }),
      checkId: 'P02-FR2-SOURCE-PRESERVED',
    },
    {
      path: 'evidence/baseline-ok/output-verification.json',
      content: exportEvidenceDocument({
        operation: {
          operationId: 'op-0001',
          status: 'completed',
          state: 'completed',
          codeIdentity: {
            headCommit: 'e'.repeat(40),
            workingTreeDigest: '5'.repeat(64),
            hasUncommittedChanges: false,
          },
          checks: [
            {
              checkKey: 'sample-ok',
              status: 'passed',
              reasonCode: null,
              exitCode: 0,
              durationMs: 120,
              output: { artifactId: 'art-0001', byteSize: 15, truncated: false },
            },
          ],
        },
        artifacts: [{ artifactId: 'art-0001', digest: '6'.repeat(64), sizeBytes: 15 }],
      }),
      checkId: 'P02-FR1-BASELINE-OK',
    },
  ];
}

function writeRun(
  sandbox: string,
  runId: string,
  results: P02CheckResultInput[],
  evidence: P02EvidenceFileInput[] = sampleEvidence(),
  sensitiveValues: readonly string[] = [],
) {
  return writeP02AcceptanceReport({
    reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p02'),
    input: validInput(runId, results),
    evidenceFiles: evidence,
    sensitiveValues,
  });
}

/* ------------------------------------------------------------------ */

describe('F-009 报告写出、证据导出与验证', () => {
  it('全通过运行：report.json/summary.md/evidence 同源写出且可整目录重验，退出码 0', () => {
    const sandbox = newSandbox();
    const results = passResults();
    results[3] = {
      ...results[3],
      evidenceRefs: ['evidence/baseline-ok/output-verification.json'],
    } as P02CheckResultInput;
    const written = writeRun(sandbox, '20261005T020304Z-deadbeef', results);

    expect(written.exitCode).toBe(0);
    expect(written.conclusion).toBe('pass');
    expect(existsSync(written.reportPath)).toBe(true);
    expect(existsSync(written.summaryPath)).toBe(true);

    // report.json 通过严格 Schema 校验；证据 hash/size 与磁盘逐项一致。
    const parsed = JSON.parse(readFileSync(written.reportPath, 'utf-8')) as unknown;
    const report = validateP02AcceptanceReport(parsed);
    expect(report.reportSchemaVersion).toBe(P02_ACCEPTANCE_REPORT_SCHEMA_VERSION);
    expect(report.counts).toEqual({ pass: 15, fail: 0, not_run: 0, total: 15 });
    expect(report.checks.map((check) => check.id)).toHaveLength(15);
    expect(report.commands.map((command) => command.exitCode)).toEqual([0, 0]);
    for (const entry of report.evidence) {
      const bytes = readFileSync(join(written.runDir, ...entry.path.split('/')));
      expect(sha256Hex(bytes)).toBe(entry.sha256);
      expect(bytes.length).toBe(entry.sizeBytes);
    }
    expect(verifyP02ReportDirectory(written.runDir)).toEqual({ ok: true, problems: [] });

    // 摘要与 JSON 同源：相同结论、计数与逐项状态。
    const summary = readFileSync(written.summaryPath, 'utf-8');
    expect(summary).toContain('**pass**（pass 15 / fail 0 / not_run 0，必需检查共 15 项）');
    for (const check of report.checks) {
      expect(summary).toContain(`| ${check.id} |`);
    }
    // 输入计划摘要、受测 commit/工作树、工具版本与已知限制出现在摘要中。
    expect(summary).toContain('P02 双客户端与初始化验收');
    expect(summary).toContain(`\`${report.git.commit}\``);
    expect(summary).toContain('工作树 clean');
    expect(summary).toContain('Node 22.19.0');
    expect(summary).toContain('已知限制');
    expect(summary).toContain('正式验收限 macOS');
  });

  it('证据保留非秘密实例/锁/退出、项目/配置/检查、Git 摘要与基线输出核对', () => {
    const sandbox = newSandbox();
    const written = writeRun(sandbox, 'r-evidence-preserved', passResults());
    const runDir = written.runDir;

    // 非秘密 Host 身份与锁/退出说明。
    const hostIdentity = JSON.parse(
      readFileSync(join(runDir, 'evidence', 'unique-host', 'host-identity.json'), 'utf-8'),
    ) as unknown;
    expect(scanForCredentialShapes(hostIdentity)).toEqual([]);
    expect((hostIdentity as Record<string, unknown>)['hostIdentity']).toMatchObject({
      hostInstanceId: 'host-inst-0001',
      listenAddress: '127.0.0.1',
    });
    // Git 文件摘要（tracked 逐文件 digest/size）。
    const gitDigests = JSON.parse(
      readFileSync(join(runDir, 'evidence', 'source-preserved', 'git-file-digests.json'), 'utf-8'),
    ) as unknown;
    const repositories = (gitDigests as Record<string, unknown>)['repositories'] as Record<
      string,
      unknown
    >[];
    expect(repositories[0]?.['tracked']).toEqual([
      { relativePath: 'AGENTS.md', digest: '2'.repeat(64), sizeBytes: 48 },
      { relativePath: 'README.md', digest: '3'.repeat(64), sizeBytes: 128 },
    ]);
    // 基线输出核对：操作/检查退出码与制品 digest/size。
    const output = JSON.parse(
      readFileSync(join(runDir, 'evidence', 'baseline-ok', 'output-verification.json'), 'utf-8'),
    ) as unknown;
    const operation = (output as Record<string, unknown>)['operation'] as Record<string, unknown>;
    const checks = operation['checks'] as Record<string, unknown>[];
    expect(checks[0]?.['exitCode']).toBe(0);
    expect((output as Record<string, unknown>)['artifacts']).toEqual([
      { artifactId: 'art-0001', digest: '6'.repeat(64), sizeBytes: 15 },
    ]);

    // 报告与证据都不含凭据形状、认证文件内容或全量环境变量。
    const reportText = readFileSync(written.reportPath, 'utf-8');
    expect(reportText).not.toContain('auth.token');
    expect(reportText).not.toContain('environmentVariables');
    for (const entry of written.report.evidence) {
      const text = readFileSync(join(runDir, ...entry.path.split('/')), 'utf-8');
      expect(scanForCredentialShapes(JSON.parse(text) as unknown)).toEqual([]);
      expect(text).not.toContain('NODE_OPTIONS');
      expect(text).not.toContain('PATH=');
    }
  });

  it('run-id：独立目录互不覆盖；已存在 run-id 拒绝（不覆盖此前证据）', () => {
    const sandbox = newSandbox();
    const first = writeRun(sandbox, '20261005T020304Z-aaaaaaa1', passResults());
    const firstReportDigest = sha256Hex(readFileSync(first.reportPath));
    const firstEvidenceDigest = sha256Hex(
      readFileSync(join(first.runDir, 'evidence', 'unique-host', 'host-identity.json')),
    );
    const second = writeRun(sandbox, '20261005T020305Z-bbbbbbb2', passResults());
    expect(second.runDir).not.toBe(first.runDir);
    expect(sha256Hex(readFileSync(first.reportPath))).toBe(firstReportDigest);
    expect(
      sha256Hex(readFileSync(join(first.runDir, 'evidence', 'unique-host', 'host-identity.json'))),
    ).toBe(firstEvidenceDigest);
    expectReportError(
      () => writeRun(sandbox, '20261005T020304Z-aaaaaaa1', passResults()),
      'run_id_exists',
    );
  });

  it('证据清单：越界路径拒绝；检查引用必须在清单中；未知 checkId 拒绝；不留半成品', () => {
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
    const results = passResults();
    results[0] = {
      ...results[0],
      evidenceRefs: ['evidence/missing/nope.json'],
    } as P02CheckResultInput;
    expectReportError(() => writeRun(sandbox, 'r-evidence-missing', results), 'evidence_missing');
    expectReportError(
      () =>
        writeRun(sandbox, 'r-evidence-unknown', passResults(), [
          { path: 'evidence/x/y.json', content: '{}', checkId: 'P02-FR9-NOPE' },
        ]),
      'unknown_check',
    );
    expectReportError(
      () =>
        writeRun(sandbox, 'r-evidence-dup', passResults(), [
          { path: 'evidence/x/a.json', content: '{}' },
          { path: 'evidence/x/a.json', content: '{}' },
        ]),
      'invalid_input',
    );
    for (const runId of [
      'r-evidence-abs',
      'r-evidence-escape',
      'r-evidence-missing',
      'r-evidence-unknown',
      'r-evidence-dup',
    ]) {
      expect(
        existsSync(join(sandbox, 'artifacts', 'acceptance', 'p02', runId)),
        `校验失败不得留下半成品目录：${runId}`,
      ).toBe(false);
    }
  });

  it('缺失/损坏证据与被篡改的报告都使验证失败且阶段退出码非零', () => {
    const sandbox = newSandbox();
    const written = writeRun(sandbox, '20261005T030405Z-ccccccc3', passResults());
    expect(verifyP02ReportDirectory(written.runDir).ok).toBe(true);

    // 损坏一份证据（改写字节）。
    const victim = join(written.runDir, 'evidence', 'unique-host', 'host-identity.json');
    writeFileSync(victim, '{"tampered":true}\n');
    let verification = verifyP02ReportDirectory(written.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain('证据损坏');
    expect(
      computeP02PhaseExitCode({
        conclusion: written.conclusion,
        evidenceOk: verification.ok,
        reportWritten: true,
      }),
    ).toBe(1);

    // 删除证据 → 缺失。
    rmSync(victim);
    verification = verifyP02ReportDirectory(written.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain('证据缺失');

    // 篡改 report.json 的计数 → Schema 校验拒绝。
    writeFileSync(
      written.reportPath,
      JSON.stringify(
        {
          ...JSON.parse(readFileSync(written.reportPath, 'utf-8')),
          counts: { pass: 0, fail: 0, not_run: 0, total: 0 },
        },
        null,
        2,
      ),
    );
    verification = verifyP02ReportDirectory(written.runDir);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join('\n')).toContain('报告 Schema 非法');
  });

  it('写报告失败按 report_write_failed 处理，不留下看似完整的报告', () => {
    const sandbox = newSandbox();
    const reportRoot = join(sandbox, 'artifacts', 'acceptance', 'p02');
    mkdirSync(dirname(reportRoot), { recursive: true });
    writeFileSync(reportRoot, 'not a directory'); // reportRoot 是文件 → mkdir 失败
    expectReportError(
      () =>
        writeP02AcceptanceReport({
          reportRoot,
          input: validInput('r-write-fail', passResults()),
          evidenceFiles: [],
        }),
      'report_write_failed',
    );
  });

  it('合成 token/秘密脱敏覆盖报告 JSON、摘要与证据附件（不只脱敏摘要）', () => {
    const sandbox = newSandbox();
    const results = passResults();
    const authIndex = P02_REQUIRED_CHECKS.findIndex((d) => d.id === 'P02-FR2-AUTH-REJECT');
    results[authIndex] = {
      checkId: 'P02-FR2-AUTH-REJECT',
      status: 'pass',
      errorAssertion: true,
      zeroStartAssertion: true,
      persistentStateAssertion: true,
      detail: `拒绝携带 ${SYNTHETIC_SECRET} 的请求`,
    };
    const baseInput = validInput('r-redaction', results);
    const firstCommand = baseInput.commands[0] as P02AcceptanceReportInput['commands'][number];
    const input: P02AcceptanceReportInput = {
      ...baseInput,
      commands: [
        { ...firstCommand, argv: ['npm', 'run', 'accept:p02', `--token=${SYNTHETIC_SECRET}`] },
      ],
    };
    const written = writeP02AcceptanceReport({
      reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p02'),
      input,
      evidenceFiles: [
        {
          path: 'evidence/auth-reject/negative-matrix.json',
          content: JSON.stringify({ note: `未授权 token ${SYNTHETIC_SECRET} 被拒绝` }),
          checkId: 'P02-FR2-AUTH-REJECT',
        },
      ],
      sensitiveValues: [SYNTHETIC_SECRET],
    });
    const reportText = readFileSync(written.reportPath, 'utf-8');
    const summaryText = readFileSync(written.summaryPath, 'utf-8');
    const evidenceText = readFileSync(
      join(written.runDir, 'evidence', 'auth-reject', 'negative-matrix.json'),
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
        writeP02AcceptanceReport({
          reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p02'),
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
  });

  it('认证头（Bearer 形状）与凭据键名即使未列入敏感值也被拒绝（不复制认证文件）', () => {
    const sandbox = newSandbox();
    // 证据正文中出现 Bearer 认证头形状。
    expectReportError(
      () =>
        writeRun(sandbox, 'r-bearer-leak', passResults(), [
          {
            path: 'evidence/auth/header.txt',
            content: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.synthetic-token',
          },
        ]),
      'secret_leak',
    );
    // 凭据键名形状（模拟复制认证文件内容）。
    expectReportError(
      () =>
        writeRun(sandbox, 'r-auth-file-copy', passResults(), [
          {
            path: 'evidence/auth/token-file.json',
            content: JSON.stringify({ token: 'copied-from-host-auth-token-file' }),
          },
        ]),
      'secret_leak',
    );
    // 报告 detail 中的 Bearer 形状同样拒绝。
    const results = passResults();
    results[0] = {
      checkId: 'P02-ENG-VERIFY',
      status: 'pass',
      detail: 'header Authorization: Bearer abc123DEF456 未泄漏',
    };
    expectReportError(() => writeRun(sandbox, 'r-bearer-detail', results), 'secret_leak');
    // 敏感值覆盖 Bearer 凭据本身时可写出，且无 Bearer 形状残留。
    const bearerCredential = 'Bearer eyJhbGciOiJIUzI1NiJ9.synthetic-token';
    const okResults = passResults();
    const written = writeP02AcceptanceReport({
      reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p02'),
      input: validInput('r-bearer-redacted', okResults),
      evidenceFiles: [
        {
          path: 'evidence/auth/redacted.txt',
          content: `Authorization: ${bearerCredential}`,
        },
      ],
      sensitiveValues: [bearerCredential],
    });
    const evidenceText = readFileSync(
      join(written.runDir, 'evidence', 'auth', 'redacted.txt'),
      'utf-8',
    );
    expect(evidenceText).not.toContain(bearerCredential);
    expect(evidenceText).toContain('[REDACTED:');
    expect(evidenceText).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]+/);
    // 校验失败不留下半成品目录。
    expect(existsSync(join(sandbox, 'artifacts', 'acceptance', 'p02', 'r-bearer-leak'))).toBe(false);
    expect(existsSync(join(sandbox, 'artifacts', 'acceptance', 'p02', 'r-auth-file-copy'))).toBe(
      false,
    );
  });

  it('开发机路径脱敏：证据与命令携带的仓库/HOME 绝对路径统一替换；cwd 只允许逻辑位置', () => {
    const sandbox = newSandbox();
    // 命令 cwd 拒绝绝对路径。
    const badCwdInput = validInput('r-cwd-abs', passResults());
    const badCommand = badCwdInput.commands[0] as P02AcceptanceReportInput['commands'][number];
    expectReportError(
      () =>
        writeP02AcceptanceReport({
          reportRoot: join(sandbox, 'a'),
          input: {
            ...badCwdInput,
            commands: [{ ...badCommand, cwd: REPO_ROOT }],
          },
          evidenceFiles: [],
        }),
      'invalid_input',
    );

    // 证据中的开发机路径经 sensitiveValues 脱敏；报告不含仓库/HOME 原文。
    const home = homedir();
    const written = writeP02AcceptanceReport({
      reportRoot: join(sandbox, 'artifacts', 'acceptance', 'p02'),
      input: validInput('r-dev-path', passResults()),
      evidenceFiles: [
        {
          path: 'evidence/dev-paths/paths.json',
          content: JSON.stringify({
            repo: `${REPO_ROOT}/packages/core`,
            home: `${home}/.shiploop`,
          }),
        },
      ],
      sensitiveValues: [REPO_ROOT, home],
    });
    const reportText = readFileSync(written.reportPath, 'utf-8');
    const summaryText = readFileSync(written.summaryPath, 'utf-8');
    const evidenceText = readFileSync(
      join(written.runDir, 'evidence', 'dev-paths', 'paths.json'),
      'utf-8',
    );
    for (const text of [reportText, summaryText, evidenceText]) {
      expect(text).not.toContain(REPO_ROOT);
      expect(text).not.toContain(home);
    }
    expect(reportText).toContain('<repo>');
    // 证据引用全部为报告目录内相对路径。
    for (const entry of written.report.evidence) {
      expect(entry.path.startsWith('evidence/')).toBe(true);
      expect(entry.path.includes('\\')).toBe(false);
      expect(entry.path.startsWith('/')).toBe(false);
    }
  });

  it('严格 Schema 校验：往返一致；拒绝版本/未知字段/计数/结论/顺序/断言篡改', () => {
    const sandbox = newSandbox();
    const written = writeRun(sandbox, `r-schema-${trackedSandboxes.length}`, passResults());
    const report: P02AcceptanceReport = written.report;
    const validated = validateP02AcceptanceReport(report);
    expect(validated.runId).toBe(report.runId);
    const fromDisk = validateP02AcceptanceReport(
      JSON.parse(readFileSync(join(written.runDir, 'report.json'), 'utf-8')),
    );
    expect(fromDisk.counts).toEqual(report.counts);

    function mutate(fn: (draft: Record<string, unknown>) => void): unknown {
      const draft = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
      fn(draft);
      return draft;
    }

    expectReportError(
      () => validateP02AcceptanceReport(mutate((d) => { d.reportSchemaVersion = 2; })),
      'invalid_report',
    );
    // 全量环境变量字段（或任何未知字段）不允许进入报告。
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => { d.environmentVariables = { PATH: '/usr/bin' }; }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            d.counts = { pass: 14, fail: 1, not_run: 0, total: 15 };
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () => validateP02AcceptanceReport(mutate((d) => { d.conclusion = 'fail'; })),
      'invalid_report',
    );
    // 顺序固定：交换前两项即拒绝。
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            const checks = d.checks as unknown[];
            [checks[0], checks[1]] = [checks[1], checks[0]];
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            (d.checks as Record<string, unknown>[])[0].status = 'green';
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            const check = (d.checks as Record<string, unknown>[])[0];
            check.status = 'not_run';
            check.notRunReason = null;
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            const check = (d.checks as Record<string, unknown>[])[0];
            check.status = 'pass';
            check.notRunReason = 'skipped';
          }),
        ),
      'invalid_report',
    );
    // 预期负例 pass 但缺少定义要求的断言（P02-FR2-BASELINE-FAILURE 的 zeroStart）。
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            const failureIndex = (d.checks as Record<string, unknown>[]).findIndex(
              (check) => check.id === 'P02-FR2-BASELINE-FAILURE',
            );
            ((d.checks as Record<string, unknown>[])[failureIndex] as Record<string, unknown>)[
              'zeroStartAssertion'
            ] = null;
          }),
        ),
      'invalid_report',
    );
    // 证据清单负例：越界路径、重复路径、未知 checkId、检查引用清单外证据。
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            (d.evidence as Record<string, unknown>[])[0].path = '../escape.json';
          }),
        ),
      'unsafe_path',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            const evidence = d.evidence as Record<string, unknown>[];
            evidence.push({ ...evidence[0] });
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            (d.evidence as Record<string, unknown>[])[0].checkId = 'P02-FR9-NOPE';
          }),
        ),
      'invalid_report',
    );
    expectReportError(
      () =>
        validateP02AcceptanceReport(
          mutate((d) => {
            (d.checks as Record<string, unknown>[])[0].evidenceRefs = ['evidence/ghost.json'];
          }),
        ),
      'invalid_report',
    );
  });

  it('阶段外能力 P02-OOS-* 仅允许 not_run/unsupported，不进入必需项计数', () => {
    const sandbox = newSandbox();
    const report = buildP02AcceptanceReport(validInput('r-oos-ok', passResults()), []);
    expect(report.outOfScope.map((entry) => entry.status)).toEqual([
      'not_run',
      'not_run',
      'unsupported',
    ]);
    expect(report.counts).toEqual({ pass: 15, fail: 0, not_run: 0, total: 15 });
    expect(report.conclusion).toBe('pass');
    const summary = readFileSync(
      join(writeRun(sandbox, 'r-oos-summary', passResults()).summaryPath),
      'utf-8',
    );
    expect(summary).toContain('P02-OOS-PI-LIVE');
    expect(summary).toContain('不计入必需项通过数');

    // 冒充必需检查 ID 拒绝；非法状态拒绝。
    const badPrefix: P02AcceptanceReportInput = {
      ...validInput('r-oos-bad', passResults()),
      outOfScope: [
        { id: 'P02-FR1-UNIQUE-HOST', capability: '冒充必需检查', status: 'not_run', note: 'x' },
      ],
    };
    expectReportError(() => buildP02AcceptanceReport(badPrefix, []), 'invalid_input');
    const badStatus: P02AcceptanceReportInput = {
      ...validInput('r-oos-bad-status', passResults()),
      outOfScope: [
        { id: 'P02-OOS-X', capability: 'x', status: 'pass' as never, note: 'y' },
      ],
    };
    expectReportError(() => buildP02AcceptanceReport(badStatus, []), 'invalid_input');
  });

  it('失败结果同样写出报告（fail-closed：保留证据、阶段退出码非零）', () => {
    const sandbox = newSandbox();
    const results = passResults();
    const failureIndex = P02_REQUIRED_CHECKS.findIndex((d) => d.id === 'P02-FR2-BASELINE-FAILURE');
    results[failureIndex] = {
      checkId: 'P02-FR2-BASELINE-FAILURE',
      status: 'fail',
      detail: '固定非零退出与预期不符',
    };
    const written = writeRun(sandbox, 'r-fail-run', results);
    expect(written.conclusion).toBe('fail');
    expect(written.exitCode).toBe(1);
    expect(written.problems.join('\n')).toContain('P02-FR2-BASELINE-FAILURE');
    expect(verifyP02ReportDirectory(written.runDir)).toEqual({ ok: true, problems: [] });
    const summary = readFileSync(written.summaryPath, 'utf-8');
    expect(summary).toContain('**fail**（pass 14 / fail 1 / not_run 0，必需检查共 15 项）');
  });
});
