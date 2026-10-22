/**
 * P04-8 / F-007 P04 集成报告聚合、证据索引、覆盖度与 fail-closed 行为验证。
 *
 * 覆盖验收标准：
 * 1. 集成报告逐项记录 pass/fail/not_run、实际命令、退出码、耗时、证据文件、
 *    状态回执和副作用验证结果；
 * 2. 工具交付完成与 Phase 尚未验收可区分，真实 live、人工确认和未运行项保持
 *    pending/not_run，不被 mock 结果覆盖；
 * 3. 同一运行的步骤和场景证据可重放且不覆盖旧报告；受测 commit、配置摘要、
 *    Node/npm/Git/SDK 版本和脱敏输入可追溯；
 * 4. 报告写入失败、证据缺失、未知退出码或清理不确定使汇总失败，并保留已经
 *    完成步骤的证据。
 *
 * 测试使用注入执行器的真实步骤运行目录与合成场景证据（形状与 F-004/F-005/F-006
 * 矩阵输出一致），不调用模型或网络，不执行阶段入口。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';
import {
  P04_CHECKLIST_PATH,
  loadP04Checklist,
  type P04Checklist,
  type P04EvidenceCategory,
} from '../../../scripts/acceptance/p04-config.ts';
import {
  runP04StepSequence,
  type P04StepSequenceOptions,
  type P04StepSpec,
} from '../../../scripts/acceptance/p04-steps.ts';
import {
  P04IntegrationError,
  aggregateP04IntegrationReport,
  type P04IntegrationCheckBinding,
  type P04IntegrationReportResult,
} from '../../../scripts/acceptance/p04-integration-report.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECKLIST: P04Checklist = loadP04Checklist(join(ROOT, P04_CHECKLIST_PATH));
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const IDENTITY = { runId: 'p04-f007-steps-0001', commit: 'a'.repeat(40), inputsDigest: 'b'.repeat(64) } as const;

const PASS_OUTCOME: P02BoundedRunOutcome = {
  kind: 'exit',
  exitCode: 0,
  signal: null,
  durationMs: 12,
  timedOut: false,
  stdout: '',
  stderr: '',
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  spawnError: null,
  stoppedVerified: true,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 用注入执行器创建一个真实的 F-003 步骤运行证据目录。 */
async function createStepRun(parent: string, secondOutcome?: P02BoundedRunOutcome): Promise<string> {
  const evidenceDir = join(parent, 'step-run');
  const steps: P04StepSpec[] = [
    { id: 'matrix-access', command: process.execPath, args: ['-e', 'process.stdout.write("access")'], cwd: parent },
    { id: 'matrix-control', command: process.execPath, args: ['-e', 'process.stdout.write("control")'], cwd: parent },
  ];
  const outcomes = [PASS_OUTCOME, secondOutcome ?? PASS_OUTCOME];
  const runProcess = (async () => outcomes.shift() ?? PASS_OUTCOME) as typeof runBoundedProcess;
  const options: P04StepSequenceOptions = {
    evidenceDir,
    identity: { ...IDENTITY },
    stepTimeoutMs: 5_000,
    overallTimeoutMs: 30_000,
    maxOutputBytes: 4_096,
    runProcess,
  };
  const result = await runP04StepSequence(steps, options);
  if (secondOutcome === undefined) expect(result.exitCode).toBe(0);
  return evidenceDir;
}

/** 场景证据文件：形状与故障矩阵（F-004/F-005/F-006）落盘输出一致。 */
function writeScenario(root: string, name: string, ids: readonly string[], extra?: Record<string, unknown>): void {
  writeFileSync(
    join(root, name),
    JSON.stringify(
      {
        schemaVersion: 1,
        matrix: name.replace(/\.json$/, ''),
        offline: true,
        live: 'not_run',
        observations: ids.map((id) => ({ scenarioId: id, receipts: [], sideEffectsVerified: true })),
        ...(extra ?? {}),
      },
      null,
      2,
    ) + '\n',
  );
}

const SCENARIOS: Readonly<Record<string, { file: string; category: P04EvidenceCategory; ids: readonly string[] }>> = {
  sqlite: { file: 'access-core.json', category: 'sqlite', ids: ['core-authentication-refusal', 'core-quota-fallback'] },
  process: { file: 'control-events.json', category: 'process', ids: ['request-cancel', 'tool-cancel'] },
  artifact: { file: 'recovery-recording.json', category: 'artifact', ids: ['replay', 'late-owner'] },
};

function scenarioRootWith(): string {
  const root = tempDir('p04-f007-scenarios-');
  writeScenario(root, SCENARIOS.sqlite!.file, SCENARIOS.sqlite!.ids);
  writeScenario(root, SCENARIOS.process!.file, SCENARIOS.process!.ids);
  writeScenario(root, SCENARIOS.artifact!.file, SCENARIOS.artifact!.ids);
  return root;
}

/** 为全部 offline 必需检查生成绑定；live/manual 由聚合器按清单类型处理。 */
function bindingsFor(overrides: readonly P04IntegrationCheckBinding[] = []): P04IntegrationCheckBinding[] {
  const bindings: P04IntegrationCheckBinding[] = [];
  for (const item of CHECKLIST.items) {
    if (item.group === 'deferred' || item.execution !== 'offline') continue;
    const scenarios = new Map<string, { file: string; category: P04EvidenceCategory; scenarioIds: readonly string[] }>();
    for (const category of item.evidence) {
      const spec = SCENARIOS[category];
      if (spec !== undefined) scenarios.set(spec.file, { file: spec.file, category: spec.category, scenarioIds: [...spec.ids] });
    }
    bindings.push({
      checkId: item.id,
      stepIds: ['matrix-access', 'matrix-control'],
      scenarios: [...scenarios.values()],
      ...(item.id === 'P04-T41'
        ? {
            extraEvidence: [
              {
                name: 'live-zero-call.json',
                category: 'live' as P04EvidenceCategory,
                content: `${JSON.stringify({ checkId: item.id, zeroCall: true, unauthorizedRequests: 0 }, null, 2)}\n`,
              },
            ],
          }
        : {}),
    });
  }
  return [...bindings, ...overrides];
}

const fakeExec = (command: string, args: readonly string[]): string => {
  const key = `${command} ${args.join(' ')}`;
  if (key === 'git rev-parse HEAD') return IDENTITY.commit;
  if (key === 'git rev-parse HEAD^{tree}') return 'd'.repeat(40);
  if (key === 'git status --porcelain') return '';
  if (key === 'git branch --show-current') return 'feat/p04/p04-acceptance';
  if (key === 'git --version') return 'git version 2.50.0';
  if (key === 'npm --version') return '10.9.3';
  if (key === 'node --version') return process.version;
  if (key === 'sqlite3 --version') throw new Error('sqlite3 CLI 不可用');
  throw new Error(`测试未预期的命令执行：${key}`);
};

interface AggregateOverrides {
  runId?: string;
  bindings?: readonly P04IntegrationCheckBinding[];
  cleanup?: { confirmed: boolean; processesGone: boolean; notes?: readonly string[] };
  sensitiveValues?: readonly string[];
  manualConfirmations?: readonly {
    checkId: string;
    signer: string;
    confirmedAtUtc: string;
    conclusion: 'confirmed' | 'rejected';
    sideEffectVerified: boolean;
    note?: string;
  }[];
  stepRunDir?: string;
}

function aggregate(
  reportRoot: string,
  stepRunDir: string,
  scenarioRoot: string,
  overrides: AggregateOverrides = {},
): P04IntegrationReportResult {
  return aggregateP04IntegrationReport({
    repoRoot: ROOT,
    runId: overrides.runId ?? 'p04-f007-agg-0001',
    reportRoot,
    stepRunDir: overrides.stepRunDir ?? stepRunDir,
    scenarioRoot,
    bindings: overrides.bindings ?? bindingsFor(),
    cleanup: overrides.cleanup ?? { confirmed: true, processesGone: true },
    productReports: [
      {
        featureId: 'shiploop-p04',
        label: 'P04 产品 Feature 执行报告引用',
        command: 'shiploop feature report --project demo --json',
        content: `${JSON.stringify({ layer: 'feature-execution-report', synthetic: false }, null, 2)}\n`,
      },
    ],
    ...(overrides.sensitiveValues === undefined ? {} : { sensitiveValues: overrides.sensitiveValues }),
    ...(overrides.manualConfirmations === undefined ? {} : { manualConfirmations: overrides.manualConfirmations }),
    exec: fakeExec,
    now: () => new Date('2026-10-22T08:00:00.000Z'),
  });
}

it('aggregates offline matrices, step run and checklist into a replayable phase report', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = scenarioRootWith();
  const stepRunDir = await createStepRun(tempDir('p04-f007-run-'));
  const result = aggregate(reportRoot, stepRunDir, scenarioRoot);

  expect(result.reportWritten).toBe(true);
  expect(result.verification?.ok).toBe(true);
  expect(result.exitCode).toBe(1); // live/manual 未运行，阶段结论 fail
  expect(result.conclusion).toBe('fail');
  expect(result.written?.counts).toEqual({ pass: 9, fail: 0, not_run: 7, total: 16 });

  const report = result.written!.report;
  // 逐项状态：offline 全部 pass；live not_run；manual pending。
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  for (const item of CHECKLIST.items) {
    if (item.group === 'deferred') continue;
    const check = byId.get(item.id)!;
    expect(check.status).toBe(item.execution === 'offline' ? 'pass' : 'not_run');
    expect(check.evidenceRefs.length).toBeGreaterThan(0);
    if (item.execution === 'live') {
      expect(check.manualStatus).toBeNull();
      expect(check.detail).toContain('live');
    }
    if (item.execution === 'manual') expect(check.manualStatus).toBe('pending');
  }
  // 证据类别覆盖：T40 声明 sqlite/process/artifact 均由证据满足。
  const categoriesByPath = new Map(report.evidence.map((entry) => [entry.path, entry.category]));
  const t40 = byId.get('P04-T40')!;
  const t40Categories = t40.evidenceRefs.map((ref) => categoriesByPath.get(ref));
  for (const category of t40.evidenceCategories) expect(t40Categories).toContain(category);
  // 实际命令、退出码、耗时来自步骤记录，且不含开发机绝对路径。
  expect(report.commands).toHaveLength(2);
  for (const command of report.commands) {
    expect(command.exitCode).toBe(0);
    expect(command.durationMs).toBeGreaterThanOrEqual(0);
    expect(command.argv.join(' ')).not.toContain('/Users/');
    expect(command.cwd).toMatch(/^<[A-Za-z0-9][A-Za-z0-9._-]*>(?:\/[A-Za-z0-9._-]+)*$/);
  }
  // 工具交付完成 vs Phase 尚未验收。
  expect(result.toolDelivery.status).toBe('pass');
  expect(result.phaseGate.accepted).toBe(false);
  expect(result.phaseGate.pending).toHaveLength(7);
  expect(result.phaseGate.pending.filter((entry) => entry.kind === 'live' && entry.display === 'not_run')).toHaveLength(4);
  expect(result.phaseGate.pending.filter((entry) => entry.kind === 'manual' && entry.display === 'pending')).toHaveLength(3);
  expect(report.openIssues.some((issue) => issue.id === 'P04-PHASE-GATE-LIVE' && !issue.blocking)).toBe(true);
  expect(report.knownLimitations.some((text) => text.includes('live'))).toBe(true);
  // 受测 commit 与工具链可追溯；SDK 版本进入 toolchain 证据。
  expect(report.git.commit).toBe(IDENTITY.commit);
  expect(report.tools.node.startsWith('v')).toBe(true);
  expect(report.tools.npm).toBe('10.9.3');
  const toolchain = JSON.parse(
    readFileSync(join(result.written!.runDir, 'evidence/toolchain/tool-versions.json'), 'utf-8'),
  ) as { sdk?: { version?: string } };
  const repoPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    devDependencies?: Record<string, string>;
  };
  expect(toolchain.sdk?.version).toBe(repoPackage.devDependencies?.['@earendil-works/pi-agent-core']);
  // 脱敏：报告与摘要不含开发机路径或 Bearer 形状。
  const reportText = readFileSync(join(result.written!.runDir, 'report.json'), 'utf-8');
  const summaryText = readFileSync(join(result.written!.runDir, 'summary.md'), 'utf-8');
  for (const text of [reportText, summaryText]) {
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('Bearer ');
  }
});

it('keeps manual gates pending unless owner-confirmed and rejects mock overrides for live checks', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = scenarioRootWith();
  const stepRunDir = await createStepRun(tempDir('p04-f007-run-'));

  // offline 步骤/场景试图顶替 live 检查：绑定即拒绝。
  const mockBinding: P04IntegrationCheckBinding = { checkId: 'P04-FR3-LIVE-GUARD', stepIds: ['matrix-access'] };
  expect(() => aggregate(reportRoot, stepRunDir, scenarioRoot, { bindings: bindingsFor([mockBinding]) })).toThrow(
    P04IntegrationError,
  );

  // 显式负责人确认后对应 manual 检查通过，其余 manual 仍 pending。
  const result = aggregate(reportRoot, stepRunDir, scenarioRoot, {
    runId: 'p04-f007-agg-0002',
    manualConfirmations: [
      {
        checkId: 'P04-FR4-MANUAL-GATE',
        signer: 'owner@shiploop.example',
        confirmedAtUtc: '2026-10-22T07:00:00.000Z',
        conclusion: 'confirmed',
        sideEffectVerified: true,
      },
    ],
  });
  const byId = new Map(result.written!.report.checks.map((check) => [check.id, check]));
  expect(byId.get('P04-FR4-MANUAL-GATE')?.status).toBe('pass');
  expect(byId.get('P04-FR4-MANUAL-GATE')?.manualStatus).toBe('confirmed');
  expect(byId.get('P04-T39')?.manualStatus).toBe('pending');
  expect(byId.get('P04-VERT-MANUAL-BLOCK')?.manualStatus).toBe('pending');
  expect(byId.get('P04-VERT-LIVE-ZERO-CALL')?.status).toBe('not_run');
  expect(result.written!.counts).toEqual({ pass: 10, fail: 0, not_run: 6, total: 16 });
  expect(result.exitCode).toBe(1);
});

it('fails closed on missing or corrupt step evidence and preserves the scene', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = scenarioRootWith();
  const parent = tempDir('p04-f007-run-');
  const stepRunDir = await createStepRun(parent);

  rmSync(join(stepRunDir, 'steps/01-matrix-access.json'));
  const missing = aggregate(reportRoot, stepRunDir, scenarioRoot);
  expect(missing.reportWritten).toBe(false);
  expect(missing.exitCode).toBe(1);
  expect(missing.problems.some((problem) => problem.includes('证据缺失') || problem.includes('缺失'))).toBe(true);
  expect(existsSync(join(stepRunDir, 'state.json'))).toBe(true);
  expect(existsSync(join(stepRunDir, 'steps/02-matrix-control.json'))).toBe(true);

  const secondRun = await createStepRun(tempDir('p04-f007-run-'));
  writeFileSync(join(secondRun, 'steps/01-matrix-access.json'), '{}\n');
  const corrupt = aggregate(reportRoot, secondRun, scenarioRoot, { runId: 'p04-f007-agg-0003' });
  expect(corrupt.reportWritten).toBe(false);
  expect(corrupt.exitCode).toBe(1);
  expect(corrupt.problems.some((problem) => problem.includes('损坏') || problem.includes('哈希') || problem.includes('sha256'))).toBe(true);
  expect(existsSync(join(secondRun, 'steps/02-matrix-control.json'))).toBe(true);
});

it('fails closed on unknown exit codes and scenario coverage gaps', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = scenarioRootWith();
  const unknownParent = tempDir('p04-f007-run-');
  const unknownRun = await createStepRun(unknownParent, { ...PASS_OUTCOME, kind: 'mystery' as P02BoundedRunOutcome['kind'] });
  const unknown = aggregate(reportRoot, unknownRun, scenarioRoot);
  expect(unknown.reportWritten).toBe(true);
  expect(unknown.toolDelivery.status).toBe('fail');
  expect(unknown.exitCode).toBe(1);
  expect(unknown.problems.some((problem) => problem.includes('未知退出状态'))).toBe(true);
  const failed = unknown.written!.report.checks.find((check) => check.id === 'P04-T40')!;
  expect(failed.status).toBe('fail');

  // 场景覆盖缺口：文件存在但缺少一个声明场景。
  const gapRoot = tempDir('p04-f007-scenarios-');
  writeScenario(gapRoot, SCENARIOS.sqlite!.file, SCENARIOS.sqlite!.ids);
  writeScenario(gapRoot, SCENARIOS.process!.file, ['request-cancel']);
  writeScenario(gapRoot, SCENARIOS.artifact!.file, SCENARIOS.artifact!.ids);
  const stepRunDir = await createStepRun(tempDir('p04-f007-run-'));
  const gap = aggregate(reportRoot, stepRunDir, gapRoot, { runId: 'p04-f007-agg-0004' });
  expect(gap.reportWritten).toBe(true);
  expect(gap.exitCode).toBe(1);
  expect(gap.coverage.missingScenarioIds).toContain('tool-cancel');
  const gapCheck = gap.written!.report.checks.find((check) => check.id === 'P04-T40')!;
  expect(gapCheck.status).toBe('fail');
  expect(gapCheck.assertions.some((entry) => entry.id === 'scenario:control-events.json:tool-cancel' && !entry.satisfied)).toBe(true);
});

it('replays the same evidence into new reports without overwriting previous runs', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = scenarioRootWith();
  const stepRunDir = await createStepRun(tempDir('p04-f007-run-'));

  const first = aggregate(reportRoot, stepRunDir, scenarioRoot, { runId: 'p04-f007-replay-a' });
  expect(first.reportWritten).toBe(true);
  const firstReportBytes = readFileSync(join(first.written!.runDir, 'report.json'));

  // 相同 run-id 再次汇总：拒绝覆盖，旧报告逐字节保留。
  const clash = aggregate(reportRoot, stepRunDir, scenarioRoot, { runId: 'p04-f007-replay-a' });
  expect(clash.reportWritten).toBe(false);
  expect(clash.exitCode).toBe(1);
  expect(readFileSync(join(first.written!.runDir, 'report.json')).equals(firstReportBytes)).toBe(true);

  // 新 run-id 重放同一证据：逐项结果一致，证据来源哈希一致。
  const second = aggregate(reportRoot, stepRunDir, scenarioRoot, { runId: 'p04-f007-replay-b' });
  expect(second.reportWritten).toBe(true);
  expect(second.written!.report.checks).toEqual(first.written!.report.checks);
  expect(second.written!.counts).toEqual(first.written!.counts);
  expect(second.written!.conclusion).toBe(first.written!.conclusion);
  const inputsA = JSON.parse(readFileSync(join(first.written!.runDir, 'evidence/state/inputs.json'), 'utf-8'));
  const inputsB = JSON.parse(readFileSync(join(second.written!.runDir, 'evidence/state/inputs.json'), 'utf-8'));
  expect(inputsB.scenarioFiles).toEqual(inputsA.scenarioFiles);
  expect(inputsB.stepRun.identity).toEqual(inputsA.stepRun.identity);
});

it('treats uncertain cleanup as an aggregation failure and keeps the scene', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = scenarioRootWith();
  const parent = tempDir('p04-f007-run-');
  const stepRunDir = await createStepRun(parent);

  const result = aggregate(reportRoot, stepRunDir, scenarioRoot, {
    runId: 'p04-f007-agg-0005',
    cleanup: { confirmed: false, processesGone: false, notes: ['受管进程未确认消失'] },
  });
  expect(result.reportWritten).toBe(true);
  expect(result.exitCode).toBe(1);
  expect(result.conclusion).toBe('fail');
  expect(result.problems.some((problem) => problem.includes('cleanup'))).toBe(true);
  expect(result.written!.report.cleanup.confirmed).toBe(false);
  const manifest = JSON.parse(
    readFileSync(join(result.written!.runDir, 'evidence/cleanup/manifest.json'), 'utf-8'),
  ) as { confirmed?: boolean };
  expect(manifest.confirmed).toBe(false);
  for (const path of ['run.json', 'state.json', 'steps/01-matrix-access.json', 'steps/02-matrix-control.json']) {
    expect(existsSync(join(stepRunDir, path))).toBe(true);
  }
});

it('records traceable commit, digests, toolchain and redacted inputs', async () => {
  const reportRoot = tempDir('p04-f007-report-');
  const scenarioRoot = tempDir('p04-f007-scenarios-');
  writeScenario(scenarioRoot, SCENARIOS.sqlite!.file, SCENARIOS.sqlite!.ids, { secret: 'synthetic-secret-p048' });
  writeScenario(scenarioRoot, SCENARIOS.process!.file, SCENARIOS.process!.ids);
  writeScenario(scenarioRoot, SCENARIOS.artifact!.file, SCENARIOS.artifact!.ids);
  const stepRunDir = await createStepRun(tempDir('p04-f007-run-'));

  const result = aggregate(reportRoot, stepRunDir, scenarioRoot, {
    runId: 'p04-f007-agg-0006',
    sensitiveValues: ['synthetic-secret-p048'],
  });
  expect(result.reportWritten).toBe(true);
  const report = result.written!.report;
  expect(report.git.commit).toBe(IDENTITY.commit);
  expect(report.stateDigests?.codeSha256).toBe(sha256('d'.repeat(40)));
  expect(report.plan.checklistDigestSha256).toBe(sha256(readFileSync(join(ROOT, 'acceptance/p04.checklist.json'), 'utf-8')));
  const config = JSON.parse(readFileSync(join(ROOT, 'acceptance/p04.config.json'), 'utf-8')) as { plan: { title: string; contractDoc: string } };
  const contractPath = join(ROOT, config.plan.contractDoc);
  expect(report.plan.digestSha256).toBe(sha256(existsSync(contractPath) ? readFileSync(contractPath, 'utf-8') : config.plan.title));
  // 登记的敏感值在证据副本中脱敏，不回显。
  const copiedScenario = readFileSync(join(result.written!.runDir, 'evidence/checks/P04-T40/scenarios/access-core.json'), 'utf-8');
  expect(copiedScenario).not.toContain('synthetic-secret-p048');
  expect(copiedScenario).toContain('[REDACTED:');
  // 重放配方：inputs.json 记录绑定、场景哈希与步骤运行身份。
  const inputs = JSON.parse(readFileSync(join(result.written!.runDir, 'evidence/state/inputs.json'), 'utf-8')) as {
    stepRun?: { identity?: { commit?: string } };
    scenarioFiles?: { sha256?: string }[];
    bindings?: unknown[];
  };
  expect(inputs.stepRun?.identity?.commit).toBe(IDENTITY.commit);
  expect(inputs.scenarioFiles?.length).toBe(3);
  expect(inputs.bindings?.length).toBe(9);
});
