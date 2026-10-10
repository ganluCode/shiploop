/**
 * F-009 P02 版本化逐项报告的严格结果聚合回归（契约 §2.1 `P02-PHASE-NOT-RUN`）。
 *
 * 承接 docs/p02-4-acceptance-contract.md 冻结的机器可读必需检查清单与聚合纪律：
 * - 15 个必需检查 ID 与契约文档 §2.1 一致（顺序固定、无重复），未知/重复 ID 拒绝；
 * - 三态（pass/fail/not_run）、not_run 四分类（未提交结果/启动失败/超时/被跳过）；
 *   缺失、跳过或未完成的必需检查一律 not_run，空结果集不得聚合为通过；
 * - 预期负例（拒绝/冲突/失败分支）的 pass 必须携带定义要求的断言集合：
 *   错误断言（error）、零启动断言（zeroStart）、持久状态断言（persistentState）；
 *   业务 not_run 的拒绝用例（如 P02-FR2-BASELINE-FAILURE 的拒绝授权分支）只有
 *   零启动及持久状态断言成立才可作为检查 pass，否则降级 fail；
 * - 夹具失败（startup_failure）使阶段结论非通过、退出码非零；
 * - P01 报告行为不回归（P01 清单与降级语义保持不变）。
 *
 * 全部断言针对聚合器纯函数，不做 I/O、不调用模型、不触碰真实用户资源。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  P02_REQUIRED_CHECKS,
  P02_REQUIRED_CHECK_IDS,
  P02ReportError,
  aggregateP02CheckResults,
  assertValidRunId,
  computeP02PhaseExitCode,
  generateP02RunId,
} from '../scripts/acceptance/p02-report.ts';
import type { P02CheckResultInput, P02ReportErrorKind } from '../scripts/acceptance/p02-report.ts';
// P01 非回归（本任务不得改变 P01 报告行为）。
import {
  P01_REQUIRED_CHECK_IDS,
  aggregateP01CheckResults,
} from '../scripts/acceptance/p01-report.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC = readFileSync(
  resolve(REPO_ROOT, 'docs/p02-4-acceptance-contract.md'),
  'utf-8',
);

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

/** 按冻结定义补齐各检查要求的断言集合的全 pass 提交。 */
function passResults(): P02CheckResultInput[] {
  return P02_REQUIRED_CHECKS.map((definition) => ({
    checkId: definition.id,
    status: 'pass',
    durationMs: 40,
    detail: `evidence for ${definition.id}`,
    ...(definition.requiredAssertions.includes('error') ? { errorAssertion: true } : {}),
    ...(definition.requiredAssertions.includes('zeroStart')
      ? { zeroStartAssertion: true }
      : {}),
    ...(definition.requiredAssertions.includes('persistentState')
      ? { persistentStateAssertion: true }
      : {}),
  }));
}

/* ------------------------------------------------------------------ */

describe('F-009 冻结必需检查清单与严格聚合器', () => {
  it('机器可读清单与契约文档 §2.1 一致（15 项、顺序固定、无重复）', () => {
    expect(P02_REQUIRED_CHECK_IDS).toEqual([
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
    ]);
    expect(new Set(P02_REQUIRED_CHECK_IDS).size).toBe(P02_REQUIRED_CHECK_IDS.length);
    const docIds = [...CONTRACT_DOC.matchAll(/^\| `(P02-[A-Z0-9-]+)`/gm)].map(
      (match) => match[1],
    );
    expect(docIds).toEqual([...P02_REQUIRED_CHECK_IDS]);

    // 约定测试入口真实在库（F-011/F-012 尚未交付的入口除外）。
    const futureEntries = new Set([
      'test/p02-4-acceptance-controller.test.ts', // F-011 交付
      'test/p02-4-clean-replay.test.ts', // F-012 交付
    ]);
    for (const definition of P02_REQUIRED_CHECKS) {
      if (definition.testEntry.endsWith('.test.ts')) {
        if (futureEntries.has(definition.testEntry)) {
          continue;
        }
        expect(
          existsSync(join(REPO_ROOT, definition.testEntry)),
          `测试入口缺失：${definition.testEntry}`,
        ).toBe(true);
      }
    }
    // 契约为 P02-PHASE-REPORT 记录的第二个入口同样须在库（本任务交付）。
    expect(CONTRACT_DOC).toContain('test/p02-4-acceptance-report.test.ts');
    expect(existsSync(join(REPO_ROOT, 'test', 'p02-4-acceptance-report.test.ts'))).toBe(true);
  });

  it('预期负例集合与断言要求按契约 §2.2/§2.5 冻结', () => {
    const negativeIds = P02_REQUIRED_CHECKS.filter((d) => d.expectedNegative).map((d) => d.id);
    expect(negativeIds).toEqual([
      'P02-FR2-DUPLICATE-INIT',
      'P02-FR2-COMMAND-CONFLICT',
      'P02-FR2-SOURCE-PRESERVED',
      'P02-FR2-AUTH-REJECT',
      'P02-FR2-CLIENT-EXIT',
      'P02-FR2-BASELINE-FAILURE',
    ]);
    const byId = new Map(P02_REQUIRED_CHECKS.map((definition) => [definition.id, definition]));
    // 业务 not_run 的拒绝用例：零启动 + 持久状态断言必须成立。
    expect(byId.get('P02-FR2-BASELINE-FAILURE')?.requiredAssertions).toEqual([
      'error',
      'zeroStart',
      'persistentState',
    ]);
    expect(byId.get('P02-FR2-AUTH-REJECT')?.requiredAssertions).toEqual([
      'error',
      'zeroStart',
      'persistentState',
    ]);
    expect(byId.get('P02-FR2-COMMAND-CONFLICT')?.requiredAssertions).toEqual([
      'error',
      'zeroStart',
      'persistentState',
    ]);
    expect(byId.get('P02-FR2-SOURCE-PRESERVED')?.requiredAssertions).toEqual([
      'error',
      'zeroStart',
      'persistentState',
    ]);
    expect(byId.get('P02-FR2-CLIENT-EXIT')?.requiredAssertions).toEqual([
      'error',
      'persistentState',
    ]);
    expect(byId.get('P02-FR2-DUPLICATE-INIT')?.requiredAssertions).toEqual([
      'error',
      'persistentState',
    ]);
    // 正向检查不要求负例断言。
    for (const id of [
      'P02-ENG-VERIFY',
      'P02-FR1-UNIQUE-HOST',
      'P02-FR1-SHARED-STATE',
      'P02-FR1-BASELINE-OK',
      'P02-FR1-RESTART-QUERY',
      'P02-PHASE-FIXTURE',
      'P02-PHASE-NOT-RUN',
      'P02-PHASE-REPORT',
      'P02-ENG-CLEAN-REPLAY',
    ]) {
      expect(byId.get(id)?.expectedNegative).toBe(false);
      expect(byId.get(id)?.requiredAssertions).toEqual([]);
    }
  });

  it('全部通过：conclusion=pass、计数 15/0/0、退出码 0', () => {
    const aggregation = aggregateP02CheckResults(passResults());
    expect(aggregation.conclusion).toBe('pass');
    expect(aggregation.counts).toEqual({ pass: 15, fail: 0, not_run: 0, total: 15 });
    expect(aggregation.problems).toEqual([]);
    expect(aggregation.checks.map((check) => check.id)).toEqual([...P02_REQUIRED_CHECK_IDS]);
    expect(
      computeP02PhaseExitCode({
        conclusion: aggregation.conclusion,
        evidenceOk: true,
        reportWritten: true,
      }),
    ).toBe(0);
  });

  it('断言失败：fail 计数与问题项明确，结论 fail、退出码非零', () => {
    const results = passResults();
    results[1] = {
      checkId: 'P02-FR1-UNIQUE-HOST',
      status: 'fail',
      detail: '出现第二个持锁 Host',
    };
    const aggregation = aggregateP02CheckResults(results);
    expect(aggregation.conclusion).toBe('fail');
    expect(aggregation.counts).toEqual({ pass: 14, fail: 1, not_run: 0, total: 15 });
    expect(aggregation.problems.join('\n')).toContain('P02-FR1-UNIQUE-HOST');
    expect(aggregation.problems.join('\n')).toContain('第二个持锁 Host');
    expect(
      computeP02PhaseExitCode({
        conclusion: aggregation.conclusion,
        evidenceOk: true,
        reportWritten: true,
      }),
    ).toBe(1);
  });

  it('缺项与空结果：未提交必需项标 not_run/missing_result，空结果集不得聚合为通过', () => {
    const partial = aggregateP02CheckResults(passResults().slice(0, 3));
    expect(partial.conclusion).toBe('fail');
    expect(partial.counts).toEqual({ pass: 3, fail: 0, not_run: 12, total: 15 });
    const missing = partial.checks.filter((check) => check.status === 'not_run');
    expect(missing.every((check) => check.notRunReason === 'missing_result')).toBe(true);
    expect(partial.problems.join('\n')).toContain('P02-PHASE-REPORT');

    const empty = aggregateP02CheckResults([]);
    expect(empty.conclusion).toBe('fail');
    expect(empty.counts).toEqual({ pass: 0, fail: 0, not_run: 15, total: 15 });
    expect(empty.checks.every((check) => check.notRunReason === 'missing_result')).toBe(true);
  });

  it('not_run 必须携带明确分类；夹具失败/超时/被跳过均不得计为通过', () => {
    // 前 11 项正向检查 pass；后三个阶段控制检查与重复运行检查单独提交。
    const results = passResults().slice(0, 11);
    results.push(
      { checkId: 'P02-PHASE-FIXTURE', status: 'not_run', notRunReason: 'startup_failure' },
      { checkId: 'P02-PHASE-NOT-RUN', status: 'not_run', notRunReason: 'timeout' },
      { checkId: 'P02-PHASE-REPORT', status: 'not_run', notRunReason: 'skipped' },
      { checkId: 'P02-ENG-CLEAN-REPLAY', status: 'pass' },
    );
    const aggregation = aggregateP02CheckResults(results);
    expect(aggregation.conclusion).toBe('fail');
    expect(aggregation.counts).toEqual({ pass: 12, fail: 0, not_run: 3, total: 15 });
    const byId = new Map(aggregation.checks.map((check) => [check.id, check]));
    expect(byId.get('P02-PHASE-FIXTURE')?.notRunReason).toBe('startup_failure');
    expect(byId.get('P02-PHASE-NOT-RUN')?.notRunReason).toBe('timeout');
    expect(byId.get('P02-PHASE-REPORT')?.notRunReason).toBe('skipped');
    // 夹具失败使阶段非零。
    expect(
      computeP02PhaseExitCode({
        conclusion: aggregation.conclusion,
        evidenceOk: true,
        reportWritten: true,
      }),
    ).toBe(1);

    expectReportError(
      () =>
        aggregateP02CheckResults([
          ...passResults().slice(0, 13),
          { checkId: 'P02-PHASE-REPORT', status: 'not_run' },
        ]),
      'invalid_result',
    );
    expectReportError(
      () =>
        aggregateP02CheckResults([
          { checkId: 'P02-ENG-VERIFY', status: 'pass', notRunReason: 'skipped' },
        ]),
      'invalid_result',
    );
    expectReportError(
      () =>
        aggregateP02CheckResults([
          {
            checkId: 'P02-ENG-VERIFY',
            status: 'not_run',
            notRunReason: 'unknown_reason' as never,
          },
        ]),
      'invalid_result',
    );
  });

  it('未知 / 重复检查 ID 一律拒绝，不得聚合为通过', () => {
    expectReportError(
      () => aggregateP02CheckResults([...passResults(), { checkId: 'P02-FR9-NOPE', status: 'pass' }]),
      'unknown_check',
    );
    expectReportError(
      () =>
        aggregateP02CheckResults([
          { checkId: 'P02-ENG-VERIFY', status: 'pass' },
          { checkId: 'P02-ENG-VERIFY', status: 'fail' },
        ]),
      'duplicate_check',
    );
    // 阶段外能力 ID 不允许冒充必需检查结果。
    expectReportError(
      () => aggregateP02CheckResults([{ checkId: 'P02-OOS-PI-LIVE', status: 'pass' }]),
      'unknown_check',
    );
  });

  it('预期负例必须携带并满足定义要求的断言集合才计为 pass', () => {
    // 业务 not_run 拒绝用例：P02-FR2-BASELINE-FAILURE 缺零启动断言 → 降级 fail。
    const missingZeroStart = passResults();
    const failureIndex = P02_REQUIRED_CHECK_IDS.indexOf('P02-FR2-BASELINE-FAILURE');
    missingZeroStart[failureIndex] = {
      checkId: 'P02-FR2-BASELINE-FAILURE',
      status: 'pass',
      errorAssertion: true,
      persistentStateAssertion: true,
      detail: '拒绝授权 not_run 与固定非零退出均符合预期',
    };
    let aggregation = aggregateP02CheckResults(missingZeroStart);
    expect(aggregation.conclusion).toBe('fail');
    let entry = aggregation.checks.find((check) => check.id === 'P02-FR2-BASELINE-FAILURE');
    expect(entry?.status).toBe('fail');
    expect(entry?.detail).toContain('zeroStart');
    expect(aggregation.problems.join('\n')).toContain('P02-FR2-BASELINE-FAILURE');

    // 缺持久状态断言同样降级。
    const missingPersistent = passResults();
    missingPersistent[failureIndex] = {
      checkId: 'P02-FR2-BASELINE-FAILURE',
      status: 'pass',
      errorAssertion: true,
      zeroStartAssertion: true,
    };
    aggregation = aggregateP02CheckResults(missingPersistent);
    entry = aggregation.checks.find((check) => check.id === 'P02-FR2-BASELINE-FAILURE');
    expect(entry?.status).toBe('fail');
    expect(entry?.detail).toContain('persistentState');

    // 断言为 false（不成立）同样降级，不得默认成功。
    const falseAssertion = passResults();
    falseAssertion[failureIndex] = {
      checkId: 'P02-FR2-BASELINE-FAILURE',
      status: 'pass',
      errorAssertion: true,
      zeroStartAssertion: false,
      persistentStateAssertion: true,
    };
    aggregation = aggregateP02CheckResults(falseAssertion);
    expect(aggregation.checks.find((check) => check.id === 'P02-FR2-BASELINE-FAILURE')?.status).toBe(
      'fail',
    );

    // 断言齐全 → pass。
    aggregation = aggregateP02CheckResults(passResults());
    expect(aggregation.conclusion).toBe('pass');
    expect(
      aggregation.checks.find((check) => check.id === 'P02-FR2-BASELINE-FAILURE')?.status,
    ).toBe('pass');

    // 按定义只需 error+persistentState 的检查（P02-FR2-CLIENT-EXIT）不要求 zeroStart。
    const clientExitOnly = passResults();
    const exitIndex = P02_REQUIRED_CHECK_IDS.indexOf('P02-FR2-CLIENT-EXIT');
    clientExitOnly[exitIndex] = {
      checkId: 'P02-FR2-CLIENT-EXIT',
      status: 'pass',
      errorAssertion: true,
      persistentStateAssertion: true,
    };
    aggregation = aggregateP02CheckResults(clientExitOnly);
    expect(aggregation.checks.find((check) => check.id === 'P02-FR2-CLIENT-EXIT')?.status).toBe(
      'pass',
    );

    // 正向检查不携带断言也不受影响。
    const noAssertions = passResults();
    const verifyIndex = P02_REQUIRED_CHECK_IDS.indexOf('P02-ENG-VERIFY');
    noAssertions[verifyIndex] = { checkId: 'P02-ENG-VERIFY', status: 'pass' };
    aggregation = aggregateP02CheckResults(noAssertions);
    expect(aggregation.checks.find((check) => check.id === 'P02-ENG-VERIFY')?.status).toBe('pass');

    // fail 状态不要求断言集合（失败如实记录）。
    const failedNegative = passResults();
    failedNegative[failureIndex] = {
      checkId: 'P02-FR2-BASELINE-FAILURE',
      status: 'fail',
      detail: '失败证据缺失',
    };
    aggregation = aggregateP02CheckResults(failedNegative);
    expect(aggregation.checks.find((check) => check.id === 'P02-FR2-BASELINE-FAILURE')?.status).toBe(
      'fail',
    );
    expect(aggregation.counts).toEqual({ pass: 14, fail: 1, not_run: 0, total: 15 });
  });

  it('结果条目的证据引用必须是 evidence/ 内的安全相对路径', () => {
    expectReportError(
      () =>
        aggregateP02CheckResults([
          { checkId: 'P02-ENG-VERIFY', status: 'pass', evidenceRefs: ['/abs/path.json'] },
        ]),
      'unsafe_path',
    );
    expectReportError(
      () =>
        aggregateP02CheckResults([
          { checkId: 'P02-ENG-VERIFY', status: 'pass', evidenceRefs: ['evidence/../escape'] },
        ]),
      'unsafe_path',
    );
    expectReportError(
      () =>
        aggregateP02CheckResults([
          { checkId: 'P02-ENG-VERIFY', status: 'pass', evidenceRefs: ['outside/file.json'] },
        ]),
      'unsafe_path',
    );
    expectReportError(
      () =>
        aggregateP02CheckResults([
          {
            checkId: 'P02-ENG-VERIFY',
            status: 'pass',
            evidenceRefs: ['evidence/a.json', 'evidence/a.json'],
          },
        ]),
      'invalid_result',
    );
  });

  it('run-id 校验与生成（<UTC 时间戳>-<8 hex>，非法值拒绝）', () => {
    for (const bad of ['', '/abs', 'a/b', '.hidden', 'a b', 'a\\b', '..']) {
      expectReportError(() => assertValidRunId(bad), 'invalid_run_id');
    }
    expect(assertValidRunId('20261005T010203Z-deadbeef')).toBe('20261005T010203Z-deadbeef');
    expect(generateP02RunId(new Date(Date.UTC(2026, 9, 5, 1, 2, 3)), '0badf00d')).toBe(
      '20261005T010203Z-0badf00d',
    );
    expectReportError(
      () => generateP02RunId(new Date(Date.UTC(2026, 9, 5)), 'not-hex!'),
      'invalid_run_id',
    );
    expectReportError(() => generateP02RunId(new Date('not a date'), '0badf00d'), 'invalid_run_id');
  });

  it('P01 报告行为不回归：清单与预期负例降级语义保持原状', () => {
    expect(P01_REQUIRED_CHECK_IDS.length).toBe(14);
    expect(P01_REQUIRED_CHECK_IDS[0]).toBe('P01-ENG-VERIFY');
    // P01 预期负例缺双断言仍降级 fail（本任务不得触碰 P01 语义）。
    const p01Downgrade = aggregateP01CheckResults(
      P01_REQUIRED_CHECK_IDS.map((id) => ({
        checkId: id,
        status: 'pass' as const,
        ...(id === 'P01-FR1-ROLLBACK' ? { errorAssertion: true } : {}),
      })),
    );
    expect(p01Downgrade.conclusion).toBe('fail');
    expect(
      p01Downgrade.checks.find((check) => check.id === 'P01-FR1-ROLLBACK')?.status,
    ).toBe('fail');
    // P02 清单独立于 P01，不共享 ID。
    for (const id of P02_REQUIRED_CHECK_IDS) {
      expect(P01_REQUIRED_CHECK_IDS).not.toContain(id);
    }
  });
});
