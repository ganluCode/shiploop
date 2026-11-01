/**
 * P07-5 / F-010 回归：逐项核验证据的 P07 恢复演练报告与离线完整性检查。
 *
 * 覆盖验收面：
 * - 真实演练场景（公开命令建立项目、真实 SQLite/Git/进程/制品/预算事实，
 *   FakeRuntime 仅替代模型输出）经结构化采集进入报告；产品报告来自真实
 *   Core/Host loopback 查询并绑定本次 run 身份；清理临时数据根后仍可离线核验；
 * - 报告 JSON + 可读摘要：commit、输入摘要、前置基线、工具链、命令/退出码/
 *   用时、逐项 pass/fail/not_run、已知限制与候选基线（机器报告不代负责人签署）；
 * - 逐类事实核验：缺文件、篡改、过期运行身份、伪造分类、同一份内容充当不同
 *   事实、零断言或仅退出码 0 均不得形成通过；负例正确拒绝与场景执行错误区分；
 *   cleanup 未确认显式失败；unsupported/not_run 不折算为通过；
 * - 人工门禁 pending/rejected 不由机器代签；confirmed 也只记录负责人决定，
 *   不把阶段标记为 accepted；
 * - 报告生成或校验失败返回失败、保留诊断且不覆写旧运行。
 *
 * 合成结构仅用于报告契约负例（F-010 约束允许）；真实通过路径只消费
 * 真实采集事实，不拿 Nezha 编码报告充当产品证据。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectToHost } from '../../../packages/host/src/index.ts';
import { openDrillFixture, DRILL_CHILD, type DrillCleanupFacts, type DrillFixture } from '../../helpers/p07-5/drill-fixture.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { P07_FROZEN_ITEMS, P07_PREREQUISITE_FEATURES } from '../../../scripts/acceptance/p07-config.ts';
import {
  collectP07Scenario,
  hashP07Input,
  notRunP07Scenario,
  redactP07EvidenceText,
  verifyP07Scenario,
  type P07CommandFactLike,
  type P07EvidenceIdentity,
  type P07OverrideFacts,
  type P07ScenarioRecord,
} from '../../../scripts/acceptance/p07-evidence.ts';
import {
  buildP07AcceptanceReport,
  renderP07Summary,
  verifyP07ReportDirectory,
  writeP07AcceptanceReport,
  type P07ReportInput,
} from '../../../scripts/acceptance/p07-report.ts';

const HOOKS = fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url));
const COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const cell = (value: string) => value.replace(/[|\r\n]/g, ' ');
const q = (f: DrillFixture, sql: string, ...args: unknown[]) => f.q(sql, ...args) as Record<string, any>;

const identityOf = (material: unknown, runId: string): P07EvidenceIdentity => ({
  runId, testedCommit: COMMIT, inputDigest: hashP07Input(material),
});

const baseCommand = {
  label: 'synthetic-scenario', argv: ['node', 'synthetic-scenario'], exitCode: 0, signal: null,
  timedOut: false, cancelled: false, durationMs: 5, escalated: [], stopConfirmed: true,
} as const;

const passedCleanup: DrillCleanupFacts = {
  status: 'passed', processStopped: true, factsExported: true,
  sqliteClosed: true, resourcesRemoved: true, retainedRoot: null,
};

function syntheticFacts(): P07OverrideFacts {
  const runRows = [{ runId: 'run-1', status: 'completed' }];
  const taskRows = [{ projectId: 'p1', taskId: 't-1', status: 'passed' }];
  return {
    sqlite: { source: 'synthetic-contract', tables: [
      { name: 'runs', rows: runRows, count: runRows.length, digest: hashP07Input(runRows) },
      { name: 'tasks', rows: taskRows, count: taskRows.length, digest: hashP07Input(taskRows) },
    ] },
    git: { repositories: [{ repository: 'a', head: 'a'.repeat(40), tree: 'b'.repeat(40), branch: 'main',
      baseCommit: 'c'.repeat(40), headBeyondBase: true, statusEntries: [], worktreePath: null, workspaceGone: false }] },
    process: { owned: true, descendantsChecked: true, processes: [{ pid: 424242, label: 'synthetic-host', alive: false,
      exitCode: 0, signal: null, stopEscalated: [], source: 'synthetic' }] },
    artifact: { artifacts: [{ projectId: 'p1', artifactId: 'a1', kind: 'requirement',
      contentHash: 'd'.repeat(64), sizeBytes: 12 }] },
    budget: { budget: { runId: 'run-1', attemptsCreated: 1, runtimeStarts: 1, deadlineAt: 1893456000000 } },
    notification: { channelIds: ['local-results'], deliveries: [{ id: 'd1', eventId: 'e1', channelId: 'local-results',
      status: 'delivered', attemptCount: 1 }], results: [{ deliveryId: 'd1', attempt: 1, outcome: 'succeeded' }], taskRerunObserved: false },
    archive: { operations: [{ operation: 'project.archive', projectId: 'p1', outcome: 'applied' }], recordsRetained: true },
  };
}

type SyntheticOptions = {
  attempt?: number;
  expectation?: 'success' | 'expected_rejection';
  command?: P07CommandFactLike;
  cleanup?: DrillCleanupFacts;
  positiveAssertions?: readonly string[];
  expectedRejections?: readonly { kind: string; reason: string }[];
  dropCategories?: readonly ('sqlite' | 'git' | 'process' | 'artifact' | 'budget' | 'notification' | 'archive')[];
  corruptCategory?: 'notification' | 'artifact' | 'archive';
};

async function writeSyntheticScenario(
  directory: string, identity: P07EvidenceIdentity, checkId: string, options: SyntheticOptions = {},
): Promise<P07ScenarioRecord> {
  const facts: Record<string, unknown> = syntheticFacts();
  for (const category of options.dropCategories ?? []) delete facts[category];
  if (options.corruptCategory) facts[options.corruptCategory] = facts.sqlite;
  return collectP07Scenario({
    directory, identity, checkId, attempt: options.attempt ?? 1,
    expectation: options.expectation ?? 'success',
    command: options.command ?? baseCommand,
    positiveAssertions: options.positiveAssertions ?? ['business_state_verified'],
    expectedRejections: options.expectedRejections,
    facts,
    usage: { source: 'command-output', tools: { node: process.versions.node } },
    cleanup: options.cleanup ?? passedCleanup,
  });
}

function satisfiedPrerequisites() {
  return P07_PREREQUISITE_FEATURES.map(feature => ({
    feature, commit: COMMIT, delivered: true, interfacesSatisfied: true,
    deliveryEvidence: [`docs/acceptance/p07-${feature.toLowerCase()}.md`],
    publicInterfaces: ['packages/core/src/index.ts'],
    ancestorOfHead: true,
  }));
}

function claimChecks() {
  return P07_FROZEN_ITEMS.map(item => ({
    checkId: item.id,
    status: (item.group === 'deferred' || item.execution === 'manual' ? 'not_run' : 'pass') as 'pass' | 'fail' | 'not_run',
    executionMode: item.execution === 'manual' ? ('manual' as const) : item.execution === 'postponed' ? ('postponed' as const) : ('fake' as const),
    reason: item.group === 'deferred' ? 'deferred_full_history_not_run'
      : item.execution === 'manual' ? 'owner_pending' : null,
  }));
}

function makeInput(identity: P07EvidenceIdentity, scenarios: readonly P07ScenarioRecord[], extra: Partial<P07ReportInput> = {}): P07ReportInput {
  return {
    identity,
    toolchain: { node: process.versions.node, npm: '10.9.3', platform: process.platform },
    prerequisites: satisfiedPrerequisites(),
    checks: claimChecks(),
    scenarios,
    products: [],
    knownGaps: [],
    ...extra,
  };
}

function writeManualGate(directory: string, identity: P07EvidenceIdentity, status: 'pending' | 'confirmed' | 'rejected') {
  mkdirSync(join(directory, 'gates'), { recursive: true, mode: 0o700 });
  const gate = {
    schemaVersion: 1, ...identity, execution: 'manual', producer: 'owner',
    command: ['npm', 'run', 'accept:p07'], exitCode: 0,
    usage: { source: 'reported', requests: 0 },
    cleanup: { confirmed: true, processesGone: true, resourcesRemoved: true },
    manual: {
      status, confirmedBy: 'owner', confirmedAt: '2026-11-02T08:00:00.000Z',
      decision: status === 'rejected' ? 'rejected' : 'approved',
    },
  };
  writeFileSync(join(directory, 'gates', 'manual.json'), `${JSON.stringify(gate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { path: 'gates/manual.json', execution: 'manual' as const };
}

function writeEntryCapture(directory: string, identity: P07EvidenceIdentity, failStepTwo: boolean) {
  mkdirSync(join(directory, 'entry'), { recursive: true, mode: 0o700 });
  const order = ['p07-prerequisites', 'p07-trusted-scope', 'p07-recovery-scenarios', 'p07-report', 'p07-manual-gate'];
  const steps = order.map((id, index) => {
    const failed = failStepTwo && index === 1;
    const notRun = failStepTwo && index >= 2;
    return {
      id, argv: ['node', `scripts/${id}.ts`],
      status: (failed ? 'fail' : notRun ? 'not_run' : 'pass') as 'pass' | 'fail' | 'not_run',
      exitCode: failed ? 1 : notRun ? null : 0,
      timedOut: false,
      stoppedVerified: notRun ? null : true,
      durationMs: notRun ? null : 10,
    };
  });
  const capture = {
    schemaVersion: 1, ...identity, steps,
    cleanup: { processesGone: true, resourcesRemoved: true },
    sourceDrift: false, elapsedMs: 50, overallTimeoutMs: 1_200_000,
    selectedFiles: ['test/modules/acceptance/p07-5-f010-report.test.ts'],
  };
  writeFileSync(join(directory, 'entry', 'run.json'), `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { path: 'entry/run.json' };
}

describe.skipIf(process.platform !== 'darwin')('P07-5 / F-010 recovery drill report', () => {
  it('[case:p07-f010-real-drill-report] publishes a real drill scene with product evidence and verifies offline after cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p07-f010-real-'));
    let fixture: DrillFixture | undefined;
    try {
      const source = join(root, 'source');
      fixture = await openDrillFixture({ prefix: 'shiploop-p07f010-' });
      const fixtureRoot = fixture.root;
      const sensitiveValues = [process.execPath, process.cwd(), fixture.sensitiveSentinelValue, fixture.bearerSentinelValue];
      const { runId: businessRunId } = await fixture.startRun('a');
      await fixture.collectDrillEvidence('f010-report', 'before', { runId: businessRunId });

      /* 真实演练：公开命令建立的 Run 由演练 Host 子进程完成（FakeRuntime 仅替代模型输出）。 */
      const startedAt = Date.now();
      const child = await fixture.spawnDrillHost({ label: 'f010-report' });
      const projectA = fixture.projectA;
      await waitFor(() => q(fixture!,
        "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'passed'", projectA.projectId,
      ).n === projectA.taskIds.length, 'drill run completes both dependent tasks', 150_000);

      /* 产品报告：真实 Core/Host loopback 查询，绑定本次场景实体与身份。 */
      const client = await connectToHost({ canonicalRoot: fixture.dataRoot, timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
      let report: unknown;
      try {
        report = await client.getFeatureReport(projectA.projectId, projectA.featureId);
        /* 负例正确拒绝：已完成 Run 的恢复命令被公开入口拒绝（not_resumable → conflict）。 */
        const refused = await client.resumeExecution({
          projectId: projectA.projectId, runId: businessRunId,
          expectedRevision: q(fixture, 'SELECT revision FROM runs WHERE id = ?', businessRunId).revision,
        });
        expect(refused).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'not_resumable' } } });
      } finally { await client.close(); }
      const identity = identityOf({ purpose: 'p07-f010-report', scenario: 'f010-report' }, 'p07f010-real');
      mkdirSync(join(source, 'products'), { recursive: true, mode: 0o700 });
      /* 真实校验命令 argv 含开发机绝对路径：按 FR-2 纪律在捕获时统一脱敏，结构保持不变。 */
      const envelopeText = redactP07EvidenceText(`${JSON.stringify({
        schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture',
        identity: { runId: identity.runId, commit: identity.testedCommit, inputsDigest: identity.inputDigest },
        projectId: projectA.projectId, featureId: projectA.featureId, report,
      }, null, 2)}`, [process.execPath, process.cwd(), sensitiveValues[2], sensitiveValues[3]], fixtureRoot);
      JSON.parse(envelopeText);
      writeFileSync(join(source, 'products', 'feature.json'), `${envelopeText}\n`, { flag: 'wx', mode: 0o600 });

      child.send({ kind: 'close' });
      const exit = await child.exited;
      expect(exit.code).toBe(0);
      const after = await fixture.collectDrillEvidence('f010-report', 'after', { runId: businessRunId });
      expect(after.git.find(facts => facts.repository === 'a')?.headBeyondBase).toBe(true);
      expect(q(fixture, 'SELECT attempts_created, runtime_starts, deadline_at FROM execution_batches ORDER BY created_at DESC LIMIT 1'))
        .toMatchObject({ attempts_created: 2, runtime_starts: 2 });

      const cleanupFacts = await fixture.cleanup();
      expect(cleanupFacts.status).toBe('passed');
      fixture = undefined;

      /* 清理临时数据根之后：仅凭持久证据目录完成采集、发布与离线核验。 */
      const record = await collectP07Scenario({
        directory: source, identity, checkId: 'P07-FR2-NEGATIVE-EVIDENCE', attempt: 1,
        expectation: 'success',
        command: {
          label: 'drill-host', argv: [process.execPath, '--import', HOOKS, DRILL_CHILD],
          exitCode: exit.code, signal: exit.signal, timedOut: false, cancelled: false,
          durationMs: Date.now() - startedAt, escalated: exit.escalated, stopConfirmed: true,
        },
        positiveAssertions: ['both_dependent_tasks_passed', 'commits_durable_beyond_base', 'budget_and_deadline_preserved', 'product_report_entity_matched'],
        expectedRejections: [{ kind: 'not_resumable', reason: 'resume of a completed run is rejected with conflict' }],
        drill: after,
        usage: { source: 'command-output', tools: { node: process.versions.node } },
        cleanup: cleanupFacts,
        sensitiveValues,
        fixtureRoot,
      });
      expect(record.status).toBe('pass');
      expect(record.evidenceRefs.map(ref => ref.category)).toContain('sqlite');

      const input = makeInput(identity, [record, notRunP07Scenario(identity, 'P07-T06-VERIFIER-CRASH-RECOVERY', 'not scheduled in this run')], {
        products: [{ path: 'products/feature.json' }],
      });
      const result = writeP07AcceptanceReport({ reportRoot: join(root, 'reports'), sourceDirectory: source, input });
      expect(result.exitCode).toBe(1);
      expect(result.verification.ok).toBe(true);
      const report2 = result.report!;
      expect(report2.checks.find(check => check.checkId === 'P07-FR2-NEGATIVE-EVIDENCE')?.status).toBe('pass');
      expect(report2.checks.find(check => check.checkId === 'P07-FR1-RECOVERY-CLOSURE')?.status).toBe('fail');
      expect(report2.checks.find(check => check.checkId === 'P07-FR1-RECOVERY-CLOSURE')?.reason).toContain('notification');
      expect(report2.checks.find(check => check.checkId === 'P07-T06-VERIFIER-CRASH-RECOVERY')?.status).toBe('not_run');
      expect(report2.checks.find(check => check.checkId === 'P07-MANUAL-OWNER-GATE')?.status).toBe('not_run');
      expect(report2.checks.find(check => check.checkId === 'P07-POST-FULL-HISTORY-REGRESSION')?.status).toBe('not_run');
      expect(report2.counts).toEqual({ pass: 1, fail: 1, not_run: 9 });
      expect(report2.baseline).toMatchObject({ candidateCommit: COMMIT, phaseAccepted: false, ownerSignature: 'pending' });
      expect(report2.productReports).toEqual([{ featureId: projectA.featureId, path: 'products/feature.json' }]);
      expect(report2.commands.find(entry => entry.scenarioId === 'P07-FR2-NEGATIVE-EVIDENCE')?.exitCode).toBe(0);
      expect(report2.knownGaps.some(gap => gap.includes('P07-MANUAL-OWNER-GATE'))).toBe(true);
      const summary = readFileSync(join(result.directory, 'summary.md'), 'utf8');
      expect(summary).toContain(cell(COMMIT));
      expect(summary).toContain(identity.inputDigest);
      expect(summary).toContain('P07-4');
      expect(summary).toContain('机器报告不能替负责人签署');
      expect(summary).toEqual(renderP07Summary(report2));

      /* 离线核验：篡改、丢文件、过期身份都失败；源目录删除后仍可核验；重复 runId 不覆写旧运行。 */
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(true);
      const factPath = join(result.directory, record.evidenceRefs[0]!.path);
      const original = readFileSync(factPath, 'utf8');
      writeFileSync(factPath, `${original.slice(0, -2)}, "tampered": true }\n`);
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(false);
      writeFileSync(factPath, original);
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(true);
      const staleIdentity = { ...identity, runId: 'p07f010-stale' };
      expect(verifyP07ReportDirectory(result.directory, staleIdentity).ok).toBe(false);
      rmSync(factPath);
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(false);
      writeFileSync(factPath, original);
      rmSync(source, { recursive: true, force: true });
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(true);
      expect(() => writeP07AcceptanceReport({ reportRoot: join(root, 'reports'), sourceDirectory: source, input })).toThrow();
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(true);

      /* 失败导出：无效输入返回失败、保留诊断，不触碰已发布运行。 */
      const badIdentity = { ...identity, runId: 'p07f010-real-bad' };
      const badInput = makeInput(badIdentity, [{ ...record, runId: 'p07f010-drift' } as P07ScenarioRecord], { products: [] });
      const failed = writeP07AcceptanceReport({ reportRoot: join(root, 'reports'), sourceDirectory: source, input: badInput });
      expect(failed.exitCode).toBe(1);
      expect(failed.report).toBeNull();
      expect(failed.verification.ok).toBe(false);
      expect(JSON.parse(readFileSync(join(failed.directory, 'diagnostic.json'), 'utf8')).exitCode).toBe(1);
      expect(verifyP07ReportDirectory(result.directory, identity).ok).toBe(true);
    } finally {
      if (fixture !== undefined) await fixture.forceDispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  it('[case:p07-f010-report-negative-integrity] rejects missing facts, forged categories, pending manual gates, failed entries and absent products', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p07-f010-neg-'));
    try {
      const identity = identityOf({ purpose: 'negative-integrity' }, 'p07f010-neg');
      const source = join(root, 'source');

      /* 缺必需事实类别：T06 需要 budget 事实，缺失即 fail（不得只看退出码）。 */
      const missingFacts = await writeSyntheticScenario(source, identity, 'P07-T06-VERIFIER-CRASH-RECOVERY', { dropCategories: ['budget'] });
      expect(missingFacts.status).toBe('pass');
      const partial = buildP07AcceptanceReport(source, makeInput(identity, [missingFacts]));
      const t06 = partial.checks.find(check => check.checkId === 'P07-T06-VERIFIER-CRASH-RECOVERY')!;
      expect(t06.status).toBe('fail');
      expect(t06.reason).toContain('missing_categories');
      expect(t06.reason).toContain('budget');
      expect(partial.blockingIssues).toContain('missing_product_report');
      expect(partial.conclusion).toBe('fail');

      /* 伪造分类 / 同一份内容充当不同事实：notification 与 artifact 文件复用 sqlite 结构 → 拒绝。 */
      const forged = await writeSyntheticScenario(source, identity, 'P07-T12-NOTIFICATION-INDEPENDENT-RETRY', { corruptCategory: 'notification' });
      expect(verifyP07Scenario(source, forged, identity).ok).toBe(false);
      expect(() => buildP07AcceptanceReport(source, makeInput(identity, [forged]))).toThrow();
      const sameProse = await writeSyntheticScenario(source, identity, 'P07-T16-BACKUP-RESTORE-CONSISTENCY', { corruptCategory: 'artifact' });
      expect(verifyP07Scenario(source, sameProse, identity).ok).toBe(false);

      /* 过期运行身份：记录身份与报告身份不一致 → 构建失败。 */
      const stale = await writeSyntheticScenario(source, { ...identity, runId: 'p07f010-other' }, 'P07-T08-COMMIT-RECEIPT-RECOVERY');
      expect(() => buildP07AcceptanceReport(source, makeInput(identity, [stale]))).toThrow();

      /* 人工门禁未决：pending 不代签，manual 项保持 not_run。 */
      const manualGate = writeManualGate(source, identity, 'pending');
      const pending = buildP07AcceptanceReport(source, makeInput(identity, [], { gates: [manualGate] }));
      const manualCheck = pending.checks.find(check => check.checkId === 'P07-MANUAL-OWNER-GATE')!;
      expect(manualCheck.status).toBe('not_run');
      expect(manualCheck.reason).toBe('owner_pending');
      expect(pending.baseline.ownerSignature).toBe('pending');

      /* 入口步骤失败：离线项 fail-closed，后续步骤 not_run 不得折算为通过。 */
      const failedEntry = writeEntryCapture(source, identity, true);
      const entryFailed = buildP07AcceptanceReport(source, makeInput(identity, [], { entry: failedEntry }));
      expect(entryFailed.checks.filter(check => check.group === 'scenario').every(check => check.status === 'fail')).toBe(true);
      expect(entryFailed.blockingIssues.some(issue => issue.includes('entry_step_or_cleanup_failed'))).toBe(true);
      rmSync(join(source, 'entry'), { recursive: true, force: true });

      /* 全部步骤通过的入口记录不单独制造通过；仍受逐项证据约束。 */
      const passedEntry = writeEntryCapture(source, identity, false);
      const entryPassed = buildP07AcceptanceReport(source, makeInput(identity, [], { entry: passedEntry }));
      expect(entryPassed.checks.find(check => check.checkId === 'P07-T15-ARCHIVE-DELETE-RETENTION')?.status).toBe('not_run');
      expect(entryPassed.conclusion).toBe('fail');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('[case:p07-f010-record-contract] distinguishes expected rejections from execution errors and blocks zero-assertion passes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'p07-f010-record-'));
    try {
      const identity = identityOf({ purpose: 'record-contract' }, 'p07f010-record');
      const source = join(root, 'source');

      /* 零业务断言：仅退出码 0 不得形成通过。 */
      await expect(writeSyntheticScenario(source, identity, 'P07-T11-RECORDER-BACKPRESSURE', { positiveAssertions: [] })).rejects.toThrow();
      /* 无业务事实（仅命令/用量/清理）：记录可成立，但对应检查缺 sqlite/artifact/manifest/usage → fail。 */
      const exitCodeOnly = await writeSyntheticScenario(source, identity, 'P07-T11-RECORDER-BACKPRESSURE', {
        dropCategories: ['sqlite', 'artifact', 'budget', 'git', 'process', 'archive', 'notification'],
      });
      expect(exitCodeOnly.status).toBe('pass');
      const report = buildP07AcceptanceReport(source, makeInput(identity, [exitCodeOnly]));
      expect(report.checks.find(check => check.checkId === 'P07-T11-RECORDER-BACKPRESSURE')?.status).toBe('fail');

      /* 预期失败：负例正确拒绝是业务断言，不是场景执行错误。 */
      const rejection = await writeSyntheticScenario(source, identity, 'P07-T15-ARCHIVE-DELETE-RETENTION', {
        expectation: 'expected_rejection',
        expectedRejections: [{ kind: 'delete_without_confirmation', reason: 'public command rejects unconfirmed delete' }],
      });
      expect(rejection.status).toBe('pass');
      expect(rejection.outcome).toBe('expected_rejection');
      expect(rejection.executionErrors).toEqual([]);
      expect(rejection.expectedRejections).toHaveLength(1);
      const rejectionReport = buildP07AcceptanceReport(source, makeInput(identity, [rejection]));
      const t15 = rejectionReport.checks.find(check => check.checkId === 'P07-T15-ARCHIVE-DELETE-RETENTION')!;
      expect(t15.status).toBe('pass');
      expect(t15.scenarios[0]!.expectedRejections).toEqual(['delete_without_confirmation']);

      /* 场景执行错误：非零退出与清理未确认都是 fail，与负例拒绝分开呈现。 */
      const nonzero = await writeSyntheticScenario(source, identity, 'P07-T16-BACKUP-RESTORE-CONSISTENCY', {
        command: { ...baseCommand, exitCode: 3 },
      });
      expect(nonzero.status).toBe('fail');
      expect(nonzero.executionErrors[0]).toMatchObject({ kind: 'nonzero_exit' });
      const uncertain = await writeSyntheticScenario(source, identity, 'P07-T16-BACKUP-RESTORE-CONSISTENCY', {
        attempt: 2,
        cleanup: { ...passedCleanup, status: 'failed', resourcesRemoved: false, retainedRoot: '<fixture>/retained' },
      });
      expect(uncertain.status).toBe('fail');
      expect(uncertain.executionErrors[0]).toMatchObject({ kind: 'cleanup_uncertain' });
      const failedReport = buildP07AcceptanceReport(source, makeInput(identity, [uncertain]));
      expect(failedReport.checks.find(check => check.checkId === 'P07-T16-BACKUP-RESTORE-CONSISTENCY')?.status).toBe('fail');
      expect(failedReport.blockingIssues.some(issue => issue.startsWith('P07-T16-BACKUP-RESTORE-CONSISTENCY:cleanup_uncertain'))).toBe(true);

      /* not_run 占位是完整结构化记录，不计为通过。 */
      const notRun = notRunP07Scenario(identity, 'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER', 'not scheduled in this run');
      const notRunReport = buildP07AcceptanceReport(source, makeInput(identity, [notRun]));
      expect(notRunReport.checks.find(check => check.checkId === 'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER')?.status).toBe('not_run');
      expect(notRunReport.counts.not_run).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('[case:p07-f010-manual-gate-and-product] records a confirmed owner gate without signing the phase and requires product identity', async () => {
    const f = await openBudgetFixture(BUDGET);
    let host: Awaited<ReturnType<typeof openReportHost>> | undefined;
    const root = mkdtempSync(join(tmpdir(), 'p07-f010-manual-'));
    try {
      await f.start();
      host = await openReportHost(f);
      const report = await host.client.getFeatureReport(f.projectId, f.featureId);
      expect(report.runs.length).toBeGreaterThan(0);
      const identity = identityOf({ purpose: 'manual-gate' }, 'p07f010-manual');
      const source = join(root, 'source');
      mkdirSync(join(source, 'products'), { recursive: true, mode: 0o700 });
      const envelope = {
        schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture',
        identity: { runId: identity.runId, commit: identity.testedCommit, inputsDigest: identity.inputDigest },
        projectId: f.projectId, featureId: f.featureId, report,
      };
      writeFileSync(join(source, 'products', 'feature.json'), `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

      const gate = writeManualGate(source, identity, 'confirmed');
      const confirmed = buildP07AcceptanceReport(source, makeInput(identity, [], { products: [{ path: 'products/feature.json' }], gates: [gate] }));
      const manualCheck = confirmed.checks.find(check => check.checkId === 'P07-MANUAL-OWNER-GATE')!;
      expect(manualCheck.status).toBe('pass');
      /* 负责人确认不等于阶段通过：离线场景未运行，候选基线仍未签署。 */
      expect(confirmed.conclusion).toBe('fail');
      expect(confirmed.baseline).toMatchObject({ phaseAccepted: false, ownerSignature: 'pending' });

      /* 产品身份不匹配（过期运行/提交/摘要）→ 拒绝。 */
      for (const drift of [{ runId: 'other' }, { commit: 'f'.repeat(40) }, { inputsDigest: 'e'.repeat(64) }]) {
        mkdirSync(join(source, 'products'), { recursive: true });
        writeFileSync(join(source, 'products', 'drift.json'), `${JSON.stringify({
          ...envelope, identity: { ...envelope.identity, ...drift },
        }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        expect(() => buildP07AcceptanceReport(source, makeInput(identity, [], { products: [{ path: 'products/drift.json' }] }))).toThrow();
        rmSync(join(source, 'products', 'drift.json'));
      }
    } finally {
      await host?.close();
      await f.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
