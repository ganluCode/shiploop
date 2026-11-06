/**
 * P08-1 / F-004 最小发布 CI 配置验收（真实仓库配置 + 临时夹具变异，非 mock 断言）。
 *
 * 覆盖（F-004 验收点）：
 * - 正向：真实仓库工作流通过全部检查；固定顺序 npm ci → verify:ci-config → typecheck/测试/build →
 *   pack:local → verify:artifacts → 摘要；实际 CI 运行、macOS 原生模块与独立安装保持
 *   Phase 集成 not_run，不折算为通过；
 * - YAML 子集解析：支持本工作流使用的结构，拒绝锚点/别名/流式/多行标量等未审语法；
 * - 触发范围：schedule、pull_request_target、通配分支等扩大/漂移均失败；
 * - 权限：扩大（write）或缺省显式只读声明失败；
 * - 工具链/runner：node 版本漂移、非 macOS runner、缺 timeout 失败；
 * - 步骤顺序与失败语义：缺 npm ci、pack/制品检查乱序、continue-on-error、条件跳过失败；
 * - 发布/远端副作用：npm publish、git push、gh、第三方 Action、未固定 Action 引用失败；
 * - 凭据隔离：secrets./env 注入、${{ 表达式失败；正常检查环境不注入发布凭据；
 * - 接线与 fail-closed：缺工作流、未登记额外工作流、无法解析 YAML、缺 package-lock、
 *   缺必需脚本或缺脚本文件均明确失败；CLI 退出码与报告落盘一致；
 * - 摘要渲染：ci-summary 生成脱敏摘要（无开发机路径），退出码跟随制品报告结论。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCiSummaryMarkdown } from '../../../scripts/ci-summary.ts';
import {
  CI_CHECK_IDS,
  CI_PHASE_INTEGRATION_IDS,
  CI_WORKFLOW_FILE,
  parseYamlSubset,
  verifyCiConfig,
  type CiConfigCheck,
  type CiConfigVerificationReport,
} from '../../../scripts/verify-ci-config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENVIRONMENT = {
  nodeVersion: '22.19.0',
  npmVersion: '10.9.3',
  gitCommit: '0123456789abcdef0123456789abcdef01234567',
  platform: 'darwin',
};

/** 与 .github/workflows/release-ci.yml 的缩进约定保持一致（6/8 空格）。 */
function stepBlock(name: string, run: string): string {
  return `      - name: ${name}\n        run: ${run}\n`;
}

interface FixtureOptions {
  /** null 表示不写工作流文件；默认写真实仓库工作流。 */
  workflowText?: string | null;
  extraWorkflows?: { name: string; text: string }[];
  /** 在写入前修改从真实仓库复制的 package.json。 */
  mutatePackageJson?: (pkg: Record<string, unknown>) => void;
  omitLockfile?: boolean;
  /** 不创建（或删除）指定脚本文件，模拟接线缺失。 */
  omitScriptFiles?: string[];
}

/** 从工作流与 package.json 推导需要存在的 node 脚本文件，生成最小接线夹具。 */
function referencedScriptFiles(workflowText: string, pkg: Record<string, unknown>): string[] {
  const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;
  const files = new Set<string>();
  for (const match of workflowText.matchAll(/run: (.+)$/gm)) {
    const command = (match[1] ?? '').trim();
    const npmRun = /^npm run ([\w:.-]+)(?: .*)?$/.exec(command);
    if (npmRun) {
      const value = scripts[npmRun[1] ?? ''];
      const nodeFile = typeof value === 'string' ? /^node (\S+)/.exec(value) : null;
      if (nodeFile) files.add(nodeFile[1] as string);
    } else {
      const direct = /^node (\S+)(?: .*)?$/.exec(command);
      if (direct) files.add(direct[1] as string);
    }
  }
  return [...files].sort();
}

function buildFixture(prefix: string, options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workflowDir = join(root, '.github/workflows');
  mkdirSync(workflowDir, { recursive: true });
  const workflowText =
    options.workflowText === undefined ? readRealWorkflow() : options.workflowText;
  if (workflowText !== null) writeFileSync(join(root, CI_WORKFLOW_FILE), workflowText, 'utf8');
  for (const extra of options.extraWorkflows ?? []) {
    writeFileSync(join(workflowDir, extra.name), extra.text, 'utf8');
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  options.mutatePackageJson?.(pkg);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  if (!options.omitLockfile) {
    writeFileSync(join(root, 'package-lock.json'), readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'), 'utf8');
  }
  const omitted = new Set(options.omitScriptFiles ?? []);
  for (const file of referencedScriptFiles(workflowText ?? '', pkg)) {
    if (omitted.has(file)) continue;
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '// fixture stub\n', 'utf8');
  }
  for (const file of ['scripts/ci-shard-gate.ts', 'scripts/test-stages.ts', 'test/ci-timings.json']) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{}', 'utf8');
  }
  return root;
}

function withFixture(prefix: string, options: FixtureOptions, run: (root: string) => void): void {
  const root = buildFixture(prefix, options);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readRealWorkflow(): string {
  return readFileSync(join(repoRoot, CI_WORKFLOW_FILE), 'utf8');
}

function checkById(report: CiConfigVerificationReport, id: string): CiConfigCheck {
  const found = report.checks.find((check) => check.id === id);
  if (!found) throw new Error(`报告中缺少检查 ${id}`);
  return found;
}

function expectFailed(report: CiConfigVerificationReport, id: string): readonly string[] {
  expect(report.passed).toBe(false);
  const check = checkById(report, id);
  expect(check.status).toBe('failed');
  expect(check.problems.length).toBeGreaterThan(0);
  return check.problems;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function runConfigCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-ci-config.ts'), ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runSummaryCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/ci-summary.ts'), ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function summaryArtifactReportFixture(passed: boolean): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'shiploop.artifact-verification',
    generatedAt: '2026-01-01T00:00:00.000Z',
    passed,
    environment: {
      gitCommit: 'fedcba9876543210fedcba9876543210fedcba98',
      nodeVersion: '22.19.0',
      npmVersion: '10.9.3',
      platform: 'darwin',
    },
    inputs: {
      distribution: 'local-pack',
      distributionManifest: { label: 'distribution-manifest.json', sha256: 'a'.repeat(64) },
      compatibility: null,
      artifacts: [
        {
          name: 'shiploop-cli',
          version: '0.0.0',
          filename: 'shiploop-cli-0.0.0.tgz',
          sha256: 'b'.repeat(64),
        },
      ],
    },
    checks: [
      {
        id: 'artifact-identity',
        title: '制品身份',
        status: passed ? 'passed' : 'failed',
        objects: ['local-pack'],
        problems: passed ? [] : ['tarball 摘要不匹配'],
      },
    ],
    notRun: [],
    evidence: [],
    summary: { passed: passed ? 1 : 0, failed: passed ? 0 : 1, notRun: 0 },
  };
}

describe('P08-1 F-004 最小发布 CI 配置', () => {
  it('[case:real-repo-passes] 真实仓库工作流通过全部检查且保留 Phase 集成 not_run 边界', () => {
    const workflowText = readRealWorkflow();
    // 夹具变异所依赖的缩进契约与真实文件一致。
    for (const [name, run] of [
      ['npm-ci', 'npm ci'],
      ['typecheck', 'npm run typecheck'],
      ['light-tests', 'node scripts/run-tests.ts --stage light'],
      ['standard-tests', 'node scripts/run-tests.ts --stage standard'],
      ['build', 'npm run build'],
      ['pack-local', 'npm run pack:local -- --output artifacts/local-pack'],
      ['verify-artifacts', 'npm run verify:artifacts'],
    ] as const) {
      expect(workflowText).toContain(stepBlock(name, run));
    }

    const report = verifyCiConfig({ repoRoot, environment: ENVIRONMENT });
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([...CI_CHECK_IDS]);
    for (const check of report.checks) {
      expect(check.status, `${check.id} 不应有失败`).toBe('passed');
      expect(check.problems).toEqual([]);
    }
    expect(report.summary).toEqual({ passed: CI_CHECK_IDS.length, failed: 0, notRun: CI_PHASE_INTEGRATION_IDS.length });
    expect(report.notRun.map((entry) => entry.id)).toEqual([...CI_PHASE_INTEGRATION_IDS]);
    for (const entry of report.notRun) {
      expect(entry.owner).toBe('phase-integration');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    expect(report.inputs.workflows).toEqual([
      { label: '.github/workflows/node-compatibility.yml', sha256: sha256Hex(readFileSync(join(repoRoot, '.github/workflows/node-compatibility.yml'), 'utf8')) },
      { label: CI_WORKFLOW_FILE, sha256: sha256Hex(workflowText) },
    ]);
    // 报告不携带开发机绝对路径。
    expect(JSON.stringify(report)).not.toMatch(/\/Users\//);
    expect(report.environment).toEqual(ENVIRONMENT);
  });

  it('[case:yaml-subset] 子集解析器支持工作流结构并拒绝未审语法', () => {
    const parsed = parseYamlSubset(
      [
        'on:',
        '  push:',
        '    branches:',
        '      - main',
        'jobs:',
        '  checks:',
        '    steps:',
        '      - name: checkout',
        '        uses: actions/checkout@v4.2.2',
      ].join('\n'),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({
      on: { push: { branches: ['main'] } },
      jobs: { checks: { steps: [{ name: 'checkout', uses: 'actions/checkout@v4.2.2' }] } },
    });

    const real = parseYamlSubset(readRealWorkflow()) as Record<string, unknown>;
    const on = real['on'] as Record<string, unknown>;
    expect((on['push'] as Record<string, unknown>)['branches']).toEqual(['main']);
    const jobs = real['jobs'] as Record<string, unknown>;
    expect(Object.keys(jobs)).toEqual(['checks', 'heavy-1', 'heavy-2', 'heavy-3', 'heavy-4', 'release-gate']);
    const steps = (jobs['checks'] as Record<string, unknown>)['steps'] as unknown[];
    expect(steps.length).toBe(12);

    expect(() => parseYamlSubset('a: &anchor value\n')).toThrow();
    expect(() => parseYamlSubset('a: *alias\n')).toThrow();
    expect(() => parseYamlSubset('a: [one, two]\n')).toThrow();
    expect(() => parseYamlSubset('a: {x: 1}\n')).toThrow();
    expect(() => parseYamlSubset('a: |\n  block\n')).toThrow();
    expect(() => parseYamlSubstringTab()).toThrow();
  });

  it('[case:missing-workflow] 缺少工作流文件时明确失败', () => {
    withFixture('p08f004-no-wf-', { workflowText: null }, (root) => {
      const report = verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT });
      expectFailed(report, 'workflow-file-set');
      expectFailed(report, 'workflow-parseable');
      expect(report.passed).toBe(false);
    });
  });

  it('[case:node-matrix] 允许已审矩阵，拒绝修改后的矩阵', () => {
    const text = readFileSync(join(repoRoot, '.github/workflows/node-compatibility.yml'), 'utf8');
    for (const modified of [false, true]) {
      withFixture('node-matrix-', { extraWorkflows: [{ name: 'node-compatibility.yml',
        text: modified ? text.replace('contents: read', 'contents: write') : text }] }, root => {
        const report = verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT });
        if (modified) expectFailed(report, 'workflow-file-set');
        else expect(report.passed).toBe(true);
      });
    }
  });

  it('[case:shard-dependencies] rejects missing shards, skipped gates and weakened shard commands', () => {
    const real = readRealWorkflow();
    for (const text of [
      real.replace('  heavy-1:\n', '  unreviewed-job:\n'),
      real.replace('    needs: checks', '    needs: release-gate'),
      real.replace('--shard 1/4', '--shard 1/3'),
      real.replace('      - run: node scripts/build-host-lock.ts\n', ''),
      real.replace('    if: always()\n    needs:', '    if: success()\n    needs:'),
      real.replace('CI_JOB_RESULTS: ${{ toJSON(needs) }}', 'CI_JOB_RESULTS: success'),
      real.replace('      - heavy-4\n', ''),
    ]) {
      expect(text).not.toBe(real);
      withFixture('ci-shard-drift-', { workflowText: text }, root => {
        expect(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }).passed).toBe(false);
      });
    }
  });

  it('[case:extra-workflow] 未登记的额外工作流文件失败', () => {
    withFixture(
      'p08f004-extra-wf-',
      { extraWorkflows: [{ name: 'nightly.yml', text: readRealWorkflow() }] },
      (root) => {
        const report = verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT });
        expectFailed(report, 'workflow-file-set');
      },
    );
  });

  it('[case:unparseable-yaml] 无法解析的工作流 YAML fail-closed', () => {
    withFixture(
      'p08f004-badyaml-',
      { workflowText: 'jobs:\n  checks:\n    steps: [unterminated\n' },
      (root) => {
        const report = verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT });
        expectFailed(report, 'workflow-parseable');
      },
    );
  });

  it('[case:trigger-scope] 触发范围漂移或扩大均失败', () => {
    const real = readRealWorkflow();
    const triggerBlock = [
      'on:',
      '  push:',
      '    branches:',
      '      - main',
      '  pull_request:',
      '    branches:',
      '      - main',
      '',
    ].join('\n');
    const scheduled = real.replace(triggerBlock, 'on:\n  schedule:\n    - cron: "0 3 * * *"\n\n');
    expect(scheduled).not.toBe(real);
    withFixture('p08f004-sched-', { workflowText: scheduled }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'trigger-scope');
    });

    const prTarget = real.replace('  pull_request:\n', '  pull_request_target:\n');
    withFixture('p08f004-prtarget-', { workflowText: prTarget }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'trigger-scope');
    });

    const wildcard = real.split('      - main').join("      - '*'");
    withFixture('p08f004-wildcard-', { workflowText: wildcard }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'trigger-scope');
    });
  });

  it('[case:permissions] 权限扩大或缺少显式只读声明失败', () => {
    const real = readRealWorkflow();
    const write = real.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n');
    withFixture('p08f004-permwrite-', { workflowText: write }, (root) => {
      const problems = expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'permissions-minimal');
      expect(problems.join('\n')).toContain('write');
    });

    const missing = real.replace('permissions:\n  contents: read\n\n', '');
    withFixture('p08f004-permnone-', { workflowText: missing }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'permissions-minimal');
    });
  });

  it('[case:runner-toolchain] runner 或工具链漂移失败', () => {
    const real = readRealWorkflow();
    const nodeDrift = real.replace('          node-version: 22.19.0', '          node-version: 22.x');
    withFixture('p08f004-nodedrift-', { workflowText: nodeDrift }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'runner-toolchain');
    });

    const linux = real.replace('    runs-on: macos-15', '    runs-on: ubuntu-latest');
    withFixture('p08f004-linux-', { workflowText: linux }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'runner-toolchain');
    });

    const retired = real.replace('    runs-on: macos-15', '    runs-on: macos-14');
    withFixture('p08f004-retired-runner-', { workflowText: retired }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'runner-toolchain');
    });

    const noTimeout = real.replace('    timeout-minutes: 30\n', '');
    withFixture('p08f004-notimeout-', { workflowText: noTimeout }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'runner-toolchain');
    });
  });

  it('[case:history-and-test-budgets] requires full Git history and bounded nested test budgets', () => {
    const real = readRealWorkflow();
    for (const depth of ['1', '2']) {
      withFixture('ci-shallow-', { workflowText: real.replace('fetch-depth: 0', `fetch-depth: ${depth}`) }, root => {
        expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'script-wiring');
      });
    }
    for (const replacement of ["'0'", "'86400000'"]) {
      withFixture('ci-budget-', { workflowText: real.replace("'1200000'", replacement) }, root => {
        expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-publish-side-effects');
      });
    }
    withFixture('ci-unknown-env-', { workflowText: real.replace('        env:\n', '        env:\n          EXTRA: value\n') }, root => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-publish-side-effects');
    });
  });

  it('[case:step-order] 缺少 npm ci 或步骤乱序失败', () => {
    const real = readRealWorkflow();
    const noInstall = real.replace(stepBlock('npm-ci', 'npm ci'), '');
    withFixture('p08f004-noci-', { workflowText: noInstall }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'required-step-order');
    });

    const pack = stepBlock('pack-local', 'npm run pack:local -- --output artifacts/local-pack');
    const artifactsCheck = stepBlock('verify-artifacts', 'npm run verify:artifacts');
    const reordered = real.replace(pack + artifactsCheck, artifactsCheck + pack);
    expect(reordered).not.toBe(real);
    withFixture('p08f004-order-', { workflowText: reordered }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'required-step-order');
    });
  });

  it('[case:continue-on-error] 必需步骤 continue-on-error 或条件跳过失败', () => {
    const real = readRealWorkflow();
    const softened = real.replace(
      stepBlock('typecheck', 'npm run typecheck'),
      `${stepBlock('typecheck', 'npm run typecheck')}        continue-on-error: true\n`,
    );
    withFixture('p08f004-coe-', { workflowText: softened }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'required-step-order');
    });

    const conditional = real.replace(
      stepBlock('typecheck', 'npm run typecheck'),
      `${stepBlock('typecheck', 'npm run typecheck')}        if: always()\n`,
    );
    withFixture('p08f004-ifalways-', { workflowText: conditional }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'required-step-order');
    });
  });

  it('[case:unknown-command] 未审阅的 run 命令失败', () => {
    const real = readRealWorkflow();
    const unknown = real.replace(
      stepBlock('ci-summary', 'node scripts/ci-summary.ts'),
      stepBlock('ci-summary', 'npm run unknown:script'),
    );
    withFixture('p08f004-unknowncmd-', { workflowText: unknown }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'command-allowlist');
    });
  });

  it('[case:forbidden-publish] npm publish、git push 或 gh 远端副作用失败', () => {
    const real = readRealWorkflow();
    const summary = stepBlock('ci-summary', 'node scripts/ci-summary.ts');
    const publish = real.replace(summary, `${summary}${stepBlock('publish', 'npm publish')}`);
    withFixture('p08f004-publish-', { workflowText: publish }, (root) => {
      const problems = expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-publish-side-effects');
      expect(problems.join('\n')).toContain('npm publish');
    });

    const push = real.replace(summary, `${summary}${stepBlock('sync', 'git push origin main')}`);
    withFixture('p08f004-push-', { workflowText: push }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-publish-side-effects');
    });

    const prCreate = real.replace(summary, `${summary}${stepBlock('open-pr', 'gh pr create --fill')}`);
    withFixture('p08f004-ghpr-', { workflowText: prCreate }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-publish-side-effects');
    });
  });

  it('[case:action-references] 第三方 Action 或未固定引用失败', () => {
    const real = readRealWorkflow();
    const thirdParty = real.replace(
      'uses: actions/upload-artifact@v4.6.2',
      'uses: unknown-org/npm-publish-action@v1.2.3',
    );
    withFixture('p08f004-thirdparty-', { workflowText: thirdParty }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-publish-side-effects');
    });

    const floating = real.replace('uses: actions/checkout@v4.2.2', 'uses: actions/checkout@main');
    withFixture('p08f004-floating-', { workflowText: floating }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'action-refs-pinned');
    });

    const majorOnly = real.replace('uses: actions/checkout@v4.2.2', 'uses: actions/checkout@v4');
    withFixture('p08f004-majoronly-', { workflowText: majorOnly }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'action-refs-pinned');
    });
  });

  it('[case:credential-injection] secrets、env 注入或表达式引用失败', () => {
    const real = readRealWorkflow();
    const injected = real.replace(
      '    steps:\n',
      '    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n    steps:\n',
    );
    withFixture('p08f004-secret-', { workflowText: injected }, (root) => {
      const problems = expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-credential-injection');
      expect(problems.join('\n')).toContain('secrets');
    });

    const inlineSecret = real.replace(
      '    steps:\n',
      '    env:\n      NPM_TOKEN: dummy-value\n    steps:\n',
    );
    withFixture('p08f004-envtoken-', { workflowText: inlineSecret }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'no-credential-injection');
    });
  });

  it('[case:wiring-gaps] 缺 package-lock、必需脚本或脚本文件失败', () => {
    withFixture('p08f004-nolock-', { omitLockfile: true }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'lockfile-present');
    });

    withFixture(
      'p08f004-noscript-',
      {
        mutatePackageJson: (pkg) => {
          delete (pkg['scripts'] as Record<string, unknown>)['pack:local'];
        },
      },
      (root) => {
        expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'script-wiring');
      },
    );

    withFixture('p08f004-nofile-', { omitScriptFiles: ['scripts/run-tests.ts'] }, (root) => {
      const problems = expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'script-wiring');
      expect(problems.join('\n')).toContain('scripts/run-tests.ts');
    });

    // 缺少制品摘要上传接线（upload 步骤被移除）同样失败。
    const real = readRealWorkflow();
    const uploadBlock = [
      '      - name: upload-ci-reports',
      '        uses: actions/upload-artifact@v4.6.2',
      '        with:',
      '          name: ci-reports',
      '          path: artifacts/',
      '          if-no-files-found: error',
      '',
    ].join('\n');
    const noUpload = real.replace(uploadBlock, '');
    expect(noUpload).not.toBe(real);
    withFixture('p08f004-noupload-', { workflowText: noUpload }, (root) => {
      expectFailed(verifyCiConfig({ repoRoot: root, environment: ENVIRONMENT }), 'script-wiring');
    });
  });

  it('[case:cli-exit-codes] CLI 退出码与报告落盘语义一致', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'p08f004-cli-'));
    try {
      const badFixture = buildFixture('p08f004-clibad-', { omitLockfile: true });
      const badReport = join(outputDir, 'bad-report.json');
      try {
        const bad = runConfigCli(['--repo-root', badFixture, '--output', badReport]);
        expect(bad.status).toBe(1);
        expect(bad.stdout).toContain('ci-config');
        const saved = JSON.parse(readFileSync(badReport, 'utf8')) as CiConfigVerificationReport;
        expect(saved.passed).toBe(false);
      } finally {
        rmSync(badFixture, { recursive: true, force: true });
      }

      const goodReport = join(outputDir, 'good-report.json');
      const good = runConfigCli(['--repo-root', repoRoot, '--output', goodReport]);
      expect(good.status).toBe(0);
      const saved = JSON.parse(readFileSync(goodReport, 'utf8')) as CiConfigVerificationReport;
      expect(saved.passed).toBe(true);
      expect(saved.inputs.workflows.map(row => row.label)).toEqual(['.github/workflows/node-compatibility.yml', CI_WORKFLOW_FILE]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('[case:summary-rendering] ci-summary 渲染脱敏摘要且退出码跟随制品报告', () => {
    const passing = renderCiSummaryMarkdown({ artifactReport: summaryArtifactReportFixture(true) });
    expect(passing).toContain('fedcba9876543210fedcba9876543210fedcba98');
    expect(passing).toContain('shiploop-cli@0.0.0');
    expect(passing).toContain('bbbb');
    expect(passing).toContain('不执行 npm publish');
    expect(passing).not.toMatch(/\/Users\//);
    expect(() =>
      renderCiSummaryMarkdown({ artifactReport: { kind: 'unexpected', passed: true } }),
    ).toThrow();

    const outputDir = mkdtempSync(join(tmpdir(), 'p08f004-sum-'));
    try {
      const root = mkdtempSync(join(tmpdir(), 'p08f004-sumrepo-'));
      try {
        const reportDir = join(root, 'artifacts/local-pack');
        mkdirSync(reportDir, { recursive: true });
        const failedPath = join(reportDir, 'artifact-verification.json');
        writeFileSync(failedPath, `${JSON.stringify(summaryArtifactReportFixture(false), null, 2)}\n`, 'utf8');
        const failed = runSummaryCli(['--repo-root', root]);
        expect(failed.status).toBe(1);
        expect(failed.stdout).toContain('shiploop-cli@0.0.0');

        rmSync(failedPath, { force: true });
        const missing = runSummaryCli(['--repo-root', root]);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('ci-summary');
        expect(existsSync(join(root, 'summary.md'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

/** 制表符缩进属于未审语法，解析器必须拒绝。 */
function parseYamlSubstringTab(): unknown {
  return parseYamlSubset('a:\n\tb: 1\n');
}
