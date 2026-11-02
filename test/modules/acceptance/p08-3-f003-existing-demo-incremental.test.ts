/**
 * P08-3 / F-003 非 Nezha 存量仓库的真实 Host/CLI/SQLite/Git 增量变更场景
 * （integration：真实临时数据根、detached Host、真实 Git 工作区与 SQLite 状态）。
 *
 * 覆盖验收点（input/p08-existing-demo.md FR-1）：
 * - 经真实 CLI/Host 在临时数据根注册 F-001 存量 Todo 夹具仓库；初始化只生成
 *   ShipLoop 项目身份和仓库绑定，原仓库文件、三类脏文件与仓库外无关旧状态
 *   文件保持字节一致，仓库内不落入任何 ShipLoop 业务状态文件；
 * - 基线执行先记录原有通过项、已知失败与缺失依赖：缺失工具为 not_run
 *   （missing_command）、不可执行检查为 not_run（permission_denied）；新增需求
 *   检查在未实现时按 failed 记录，不因存在既有失败被折算为通过；
 * - 仅修改演示需求涉及的文件（src/archive.mjs）后重新执行检查：SQLite 中的
 *   项目/操作/检查结果与 CLI/Host 查询一致，成功检查带可查询制品引用、命令
 *   范围（argv）与退出码，制品内容摘要可在 artifacts 表独立复核；
 * - 前后基线比较按同一 projectId 与检查身份区分 fixed、new_failure、
 *   incomparable、not_run 等结果，保留两次代码身份与证据引用；旧失败
 *   （known-failure）的证据在第二次运行后仍可原样查询，未被删除或覆盖；
 * - 本 Task 局部验证不宣称 Phase 通过：场景耗时、进程停止确认与清理核验
 *   属于 Phase 必需集成验收，以下显式保持 not_run。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo, type AppCliRunResult } from '../../../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../../../packages/cli/src/host/execute.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from '../../helpers/host/isolated-environment.ts';
import { openDataRootStorageProbe } from '../../helpers/p02-4/index.ts';
import { git } from '../../helpers/git-repo.ts';
import {
  createLegacyTodoFixture,
  type LegacyTodoFixture,
} from '../../helpers/p08-3/legacy-todo-fixture.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const registerHooks = fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url));
const detachedHostEntry = fileURLToPath(new URL('../../helpers/host/detached-host-entry.ts', import.meta.url));

/** Phase 必需集成验收的未执行声明：本 Task 局部通过不折算这些证据。 */
const P08_3_F003_PHASE_INTEGRATION_NOT_RUN = [
  { id: 'scenario-timing-evidence', status: 'not_run', owner: 'phase-integration', reason: 'phase_scenario_timing_pending' },
  { id: 'host-stop-confirmation-evidence', status: 'not_run', owner: 'phase-integration', reason: 'phase_host_stop_confirmation_pending' },
  { id: 'post-scenario-cleanup-evidence', status: 'not_run', owner: 'phase-integration', reason: 'phase_cleanup_verification_pending' },
] as const;

interface Invocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

interface ActiveScenario {
  readonly hostEnv: IsolatedHostEnvironment;
  readonly legacy: LegacyTodoFixture;
  readonly roots: string[];
}

const active: ActiveScenario[] = [];

function collectIo(): { readonly io: AppCliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parseJson(invocation: Invocation): Record<string, any> {
  expect(invocation.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(invocation.stdout) as Record<string, any>;
}

function cliRunner(scenario: ActiveScenario) {
  return async (args: readonly string[]): Promise<Invocation> => {
    const io = collectIo();
    const result = await runAppCli({
      args,
      io: io.io,
      launch: {
        entryArgv: ['--import', registerHooks, detachedHostEntry],
        childEnv: scenario.hostEnv.childEnv(),
        pollIntervalMs: 50,
      },
    });
    return { result, stdout: io.stdout(), stderr: io.stderr() };
  };
}

async function stopRoots(roots: readonly string[]): Promise<void> {
  for (const root of roots) {
    const io = collectIo();
    try {
      await runHostCli({ args: ['host', 'stop', '--data-root', root, '--json'], io: io.io as HostCliIo, env: {} });
    } catch {
      // 夹具回收保持权威：临时目录的删除与核验由下方 dispose 负责。
    }
  }
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function porcelainLines(repositoryPath: string): string[] {
  return git(['status', '--porcelain', '--untracked-files=all'], repositoryPath)
    .split('\n')
    .filter(Boolean)
    .sort();
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeChecker(directory: string, name: string, lines: readonly string[], executable = true): string {
  const path = join(directory, name);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}

function writePlan(plansDirectory: string, name: string, checks: readonly unknown[]): string {
  mkdirSync(plansDirectory, { recursive: true });
  const path = join(plansDirectory, `${name}.json`);
  writeFileSync(path, JSON.stringify({ checks }), 'utf8');
  return path;
}

function checkPlan(checkKey: string, argv: readonly string[], timeoutMs = 10_000) {
  return { checkKey, kind: 'command' as const, argv: [...argv], timeoutMs, required: true };
}

function checkOf(detail: Record<string, any>, checkKey: string): Record<string, any> {
  const check = (detail.checks as Record<string, any>[]).find(entry => entry.checkKey === checkKey);
  expect(check, `check ${checkKey} missing in ${JSON.stringify(detail.checks?.map((c: any) => c.checkKey))}`).toBeDefined();
  return check!;
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

afterEach(async () => {
  for (const item of active.splice(0).reverse()) {
    await stopRoots(item.roots);
    item.legacy.dispose();
    item.legacy.cleanupSandbox();
    await item.hostEnv.dispose();
  }
});

describe('P08-3 F-003 存量仓库真实跨层增量变更', () => {
  it('[case:p08-3-f003-incremental-demo] 注册保留原仓库字节、基线记录既有失败与缺失依赖，受控变更后比较前后证据', async () => {
    // --- 场景资源：真实 Host 环境 + F-001 非 Nezha 存量 Todo 夹具 ---
    const hostEnv = createIsolatedHostEnvironment({ prefix: 'shiploop-p08-3-f003-' });
    const legacy = createLegacyTodoFixture({ prefix: 'shiploop-p08-3-f003-' });
    const dataRoot = hostEnv.dataRoot('legacy-demo').canonicalRoot;
    const scenario: ActiveScenario = { hostEnv, legacy, roots: [dataRoot] };
    active.push(scenario);
    const run = cliRunner(scenario);
    const repositoryPath = legacy.repositoryPath;
    // macOS realpath 规范化（/var → /private/var）：SQLite 与 Host 绑定保存规范路径。
    const canonicalRepositoryPath = realpathSync(repositoryPath);

    // 演示需求检查脚本（在数据根沙箱内、仓库外；检查 cwd 为仓库根）。
    const checkersDirectory = join(hostEnv.sandboxRoot, 'checkers');
    mkdirSync(checkersDirectory, { recursive: true });
    const newRequirementChecker = writeChecker(checkersDirectory, 'new-requirement-check.mjs', [
      '#!/usr/bin/env node',
      "import { readFileSync } from 'node:fs';",
      'let source;',
      'try {',
      "  source = readFileSync('src/archive.mjs', 'utf8');",
      '} catch {',
      "  process.stderr.write('new requirement not implemented: src/archive.mjs missing\\n');",
      '  process.exit(4);',
      '}',
      "if (source.includes('export function archiveTodos')) {",
      "  process.stdout.write('new requirement satisfied: archive todos implemented\\n');",
      '  process.exit(0);',
      '}',
      "process.stderr.write('new requirement not implemented: archiveTodos export missing\\n');",
      'process.exit(4);',
    ]);
    const archiveNotesChecker = writeChecker(checkersDirectory, 'archive-notes-check.mjs', [
      '#!/usr/bin/env node',
      "import { readFileSync } from 'node:fs';",
      'try {',
      "  readFileSync('docs/archive.md', 'utf8');",
      "  process.stdout.write('archive usage notes present\\n');",
      '  process.exit(0);',
      '} catch {',
      "  process.stderr.write('archive usage notes missing: docs/archive.md\\n');",
      '  process.exit(5);',
      '}',
    ]);
    // 不可执行检查：文件存在但没有执行位（EACCES → permission_denied → not_run）。
    const blockedTool = writeChecker(checkersDirectory, 'blocked-tool.mjs', [
      '#!/usr/bin/env node',
      'process.exit(0);',
    ], false);

    // --- 初始化前事实 ---
    const beforeSnapshot = legacy.snapshot();
    const beforePorcelain = porcelainLines(repositoryPath);
    const beforeUnrelatedDigest = fileDigest(legacy.unrelatedStatePath);
    expect(beforeSnapshot.headCommit).toMatch(/^[a-f0-9]{40}$/);

    // --- 1) 真实 CLI/Host 注册：只生成 ShipLoop 项目身份与绑定 ---
    const initialized = await run([
      'project', 'init', repositoryPath, '--name', 'Legacy Todo Demo', '--confirm', '--data-root', dataRoot, '--json',
    ]);
    expect(initialized.result.exitCode, initialized.stderr).toBe(0);
    const initializedEnvelope = parseJson(initialized).result as Record<string, any>;
    expect(initializedEnvelope.registration).toMatchObject({ status: 'registered' });
    const projectId = initializedEnvelope.registration.projectId as string;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(initializedEnvelope.health).toMatchObject({ status: 'not_run', reasonCode: 'no_baseline' });

    // 初始化后原仓库字节一致：文件摘要、脏文件、HEAD、porcelain、无关旧状态全部不变。
    const afterInitSnapshot = legacy.snapshot();
    expect(afterInitSnapshot.headCommit).toBe(beforeSnapshot.headCommit);
    expect(afterInitSnapshot.files).toEqual(beforeSnapshot.files);
    expect(afterInitSnapshot.workingTree.dirtyFiles).toEqual(beforeSnapshot.workingTree.dirtyFiles);
    expect(porcelainLines(repositoryPath)).toEqual(beforePorcelain);
    expect(fileDigest(legacy.unrelatedStatePath)).toBe(beforeUnrelatedDigest);
    expect(legacy.stateIsolation()).toMatchObject({ status: 'isolated' });

    const overview = await run(['project', 'overview', '--project', projectId, '--data-root', dataRoot, '--json']);
    expect(overview.result.exitCode, overview.stderr).toBe(0);
    const overviewResult = parseJson(overview).result as Record<string, any>;
    expect(overviewResult.project.displayName).toBe('Legacy Todo Demo');
    expect(overviewResult.binding.canonicalPath).toBe(canonicalRepositoryPath);

    // --- 2) 基线执行：原有通过项、已知失败、缺失依赖、未实现的新需求检查 ---
    const plansDirectory = join(hostEnv.sandboxRoot, 'plans');
    const baselineChecks = [
      checkPlan('existing-check', ['node', 'checks/existing-check.mjs']),
      checkPlan('known-failure', ['node', 'checks/known-failure.mjs']),
      checkPlan('missing-tool', ['p08-f003-demo-tool-not-installed', '--version']),
      checkPlan('blocked-tool', [blockedTool]),
      checkPlan('new-requirement', [process.execPath, newRequirementChecker]),
    ];
    const baselinePlanPath = writePlan(plansDirectory, 'baseline', baselineChecks);

    const baselineRun = await run([
      'baseline', 'run', '--project', projectId, '--input', baselinePlanPath,
      '--confirm', '--wait', '--data-root', dataRoot, '--json',
    ]);
    expect(baselineRun.result.exitCode, baselineRun.stderr).toBe(1);
    const baselineDetail = parseJson(baselineRun).result as Record<string, any>;
    expect(baselineDetail.state).toBe('failed');
    expect(baselineDetail.status).toBe('completed');
    const baselineOperationId = baselineDetail.operationId as string;
    expect(baselineOperationId).toMatch(/^[0-9a-f-]{36}$/);

    // 原有通过项与已知失败如实记录。
    expect(checkOf(baselineDetail, 'existing-check')).toMatchObject({
      status: 'passed', exitCode: 0, required: true,
    });
    const baselineKnownFailure = checkOf(baselineDetail, 'known-failure');
    expect(baselineKnownFailure).toMatchObject({
      status: 'failed', exitCode: 3,
    });
    const knownFailureArtifactId = baselineKnownFailure.output?.artifactId as string | undefined;
    expect(knownFailureArtifactId).toMatch(/^[0-9a-f-]{36}$/);

    // 缺失依赖：not_run + 明确原因，不折算失败或通过。
    expect(checkOf(baselineDetail, 'missing-tool')).toMatchObject({
      status: 'not_run', reasonCode: 'missing_command', exitCode: null,
    });
    // 不可执行检查：not_run + 明确原因。
    expect(checkOf(baselineDetail, 'blocked-tool')).toMatchObject({
      status: 'not_run', reasonCode: 'permission_denied', exitCode: null,
    });

    // 新需求检查未实现时按 failed 记录：既有失败存在也不把它标成通过。
    expect(checkOf(baselineDetail, 'new-requirement')).toMatchObject({
      status: 'failed', exitCode: 4,
    });
    expect(baselineDetail.checks.every((check: any) => check.status !== 'passed' || check.checkKey === 'existing-check')).toBe(true);

    // 基线代码身份绑定受测仓库现状。
    expect(baselineDetail.codeIdentity).toMatchObject({
      headCommit: beforeSnapshot.headCommit,
      hasUncommittedChanges: true,
    });

    // --- 3) 受控文件变更：只写演示需求文件 src/archive.mjs ---
    const archiveModulePath = join(repositoryPath, 'src', 'archive.mjs');
    writeFileSync(
      archiveModulePath,
      [
        'export const archived = [];',
        'export function archiveTodos(todos) {',
        '  for (const todo of todos) archived.push(todo);',
        '  return [...archived];',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    // 预存脏文件与原文件保持字节一致；porcelain 只新增演示需求文件一项。
    const afterChangeSnapshot = legacy.snapshot();
    expect(afterChangeSnapshot.headCommit).toBe(beforeSnapshot.headCommit);
    const beforeFileMap = new Map(beforeSnapshot.files.map(file => [file.path, file.digest]));
    for (const file of afterChangeSnapshot.files) {
      if (file.path === 'src/archive.mjs') continue;
      expect(beforeFileMap.get(file.path), `pre-existing file changed: ${file.path}`).toBe(file.digest);
    }
    expect(afterChangeSnapshot.workingTree.dirtyFiles.map(file => `${file.state}:${file.path}`)).toEqual(
      expect.arrayContaining(beforeSnapshot.workingTree.dirtyFiles.map(file => `${file.state}:${file.path}`)),
    );
    const afterChangePorcelain = porcelainLines(repositoryPath);
    expect(afterChangePorcelain).toEqual(expect.arrayContaining(beforePorcelain));
    expect(afterChangePorcelain.filter(line => !beforePorcelain.includes(line))).toEqual(['?? src/archive.mjs']);
    expect(fileDigest(legacy.unrelatedStatePath)).toBe(beforeUnrelatedDigest);

    // --- 4) 重新执行检查：新增一条演示需求附带检查（docs 未写 → 新失败如实暴露） ---
    const currentPlanPath = writePlan(plansDirectory, 'current', [
      ...baselineChecks,
      checkPlan('archive-notes', [process.execPath, archiveNotesChecker]),
    ]);
    const currentRun = await run([
      'baseline', 'run', '--project', projectId, '--input', currentPlanPath,
      '--confirm', '--wait', '--data-root', dataRoot, '--json',
    ]);
    expect(currentRun.result.exitCode, currentRun.stderr).toBe(1);
    const currentDetail = parseJson(currentRun).result as Record<string, any>;
    expect(currentDetail.state).toBe('failed');
    const currentOperationId = currentDetail.operationId as string;

    const fixedCheck = checkOf(currentDetail, 'new-requirement');
    expect(fixedCheck).toMatchObject({
      status: 'passed', exitCode: 0, required: true,
      argv: [process.execPath, newRequirementChecker],
    });
    const fixedArtifactId = fixedCheck.output?.artifactId as string | undefined;
    expect(fixedArtifactId).toMatch(/^[0-9a-f-]{36}$/);
    // 既有失败保持失败，不被“修复”或豁免；缺失依赖维持 not_run。
    expect(checkOf(currentDetail, 'known-failure')).toMatchObject({
      status: 'failed', exitCode: 3,
    });
    expect(checkOf(currentDetail, 'missing-tool')).toMatchObject({ status: 'not_run', reasonCode: 'missing_command' });
    expect(checkOf(currentDetail, 'blocked-tool')).toMatchObject({ status: 'not_run', reasonCode: 'permission_denied' });
    expect(checkOf(currentDetail, 'archive-notes')).toMatchObject({
      status: 'failed', exitCode: 5,
    });

    // 脏文件在两次真实执行后仍保持字节一致。
    expect(fileDigest(legacy.dirtyTrackedPath)).toBe(beforeFileMap.get('src/todo.mjs'));
    expect(fileDigest(legacy.stagedPath)).toBe(beforeFileMap.get('docs/notes.md'));
    expect(fileDigest(legacy.untrackedPath)).toBe(beforeFileMap.get('notes/user-scratch.md'));
    expect(fileDigest(legacy.unrelatedStatePath)).toBe(beforeUnrelatedDigest);

    // --- 5) SQLite 持久状态与 CLI/Host 查询一致 ---
    const baselineStatusAgain = await run(['baseline', 'status', baselineOperationId, '--data-root', dataRoot, '--json']);
    expect(baselineStatusAgain.result.exitCode, baselineStatusAgain.stderr).toBe(0);
    const baselineStatusDetail = parseJson(baselineStatusAgain).result as Record<string, any>;
    expect(baselineStatusDetail.operationId).toBe(baselineOperationId);
    expect(checkOf(baselineStatusDetail, 'new-requirement')).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(checkOf(baselineStatusDetail, 'known-failure').output?.artifactId).toBe(knownFailureArtifactId);

    const evidence = await run(['baseline', 'evidence', fixedArtifactId!, '--data-root', dataRoot, '--json']);
    expect(evidence.result.exitCode, evidence.stderr).toBe(0);
    const evidenceContent = String((parseJson(evidence).result as Record<string, any>).content);
    const evidenceDigest = sha256Text(evidenceContent);

    const probe = openDataRootStorageProbe(dataRoot);
    try {
      expect(probe.readonly).toBe(true);
      // 项目与绑定：与 CLI overview 同一身份。
      const projectRow = probe.projectRow(projectId);
      expect(projectRow).toMatchObject({ id: projectId, display_name: 'Legacy Todo Demo' });
      const bindingRow = probe.selectOne<{ project_id: string; canonical_path: string; repo_identity: string }>(
        'SELECT project_id, canonical_path, repo_identity FROM repository_bindings WHERE project_id = ?',
        [projectId],
      );
      expect(bindingRow).toMatchObject({ project_id: projectId, canonical_path: canonicalRepositoryPath });
      expect(bindingRow?.repo_identity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);
      expect(projectRow?.repository_binding_id).toBeDefined();

      // 操作状态与 CLI 一致：两次运行都是 completed（检查失败不等于操作未完成）。
      for (const [operationId, expected] of [
        [baselineOperationId, 'completed'],
        [currentOperationId, 'completed'],
      ] as const) {
        expect(probe.selectOne<{ project_id: string; status: string }>(
          'SELECT project_id, status FROM baseline_operations WHERE id = ?',
          [operationId],
        )).toMatchObject({ project_id: projectId, status: expected });
      }

      // 两次运行的全部检查结果与 CLI/Host 查询逐项一致（状态/退出码）。
      for (const [operationId, detail] of [[baselineOperationId, baselineDetail], [currentOperationId, currentDetail]] as const) {
        for (const check of detail.checks as Record<string, any>[]) {
          const row = probe.selectOne<{ status: string; exit_code: number | null }>(
            'SELECT status, exit_code FROM baseline_check_results WHERE operation_id = ? AND check_key = ?',
            [operationId, check.checkKey],
          );
          expect(row, `sqlite check row missing: ${check.checkKey}`).toBeDefined();
          expect(row!.status).toBe(check.status);
          expect(row!.exit_code).toBe(check.exitCode);
        }
      }

      // 成功检查：命令范围（argv）、退出码与制品引用可查询且与 CLI 一致。
      const fixedRow = probe.selectOne<{
        check_key: string; status: string; exit_code: number; required: number;
        argv_json: string; output_artifact_id: string | null;
      }>(
        'SELECT check_key, status, exit_code, required, argv_json, output_artifact_id FROM baseline_check_results WHERE operation_id = ? AND check_key = ?',
        [currentOperationId, 'new-requirement'],
      );
      expect(fixedRow).toMatchObject({
        check_key: 'new-requirement', status: 'passed', exit_code: 0, required: 1,
        output_artifact_id: fixedArtifactId,
      });
      expect(JSON.parse(fixedRow!.argv_json)).toEqual([process.execPath, newRequirementChecker]);
      // 制品内容摘要可在 artifacts 表独立复核。
      expect(probe.selectOne<{ project_id: string; status: string; content_hash: string }>(
        'SELECT project_id, status, content_hash FROM artifacts WHERE id = ?',
        [fixedArtifactId],
      )).toMatchObject({ project_id: projectId, status: 'ready', content_hash: evidenceDigest });
    } finally {
      probe.close();
    }

    // --- 6) 前后基线比较：同一 projectId 与检查身份下的分类与证据 ---
    const comparisonRun = await run([
      'baseline', 'compare', baselineOperationId, currentOperationId, '--data-root', dataRoot, '--json',
    ]);
    expect(comparisonRun.result.exitCode, comparisonRun.stderr).toBe(0);
    const comparison = parseJson(comparisonRun).result as Record<string, any>;
    expect(comparison.projectId).toBe(projectId);
    expect(comparison.previous.operationId).toBe(baselineOperationId);
    expect(comparison.current.operationId).toBe(currentOperationId);

    // 两次代码身份保留：HEAD 未变（受控变更未提交），工作区摘要变化如实暴露。
    expect(comparison.previous.codeIdentity.headCommit).toBe(beforeSnapshot.headCommit);
    expect(comparison.current.codeIdentity.headCommit).toBe(beforeSnapshot.headCommit);
    expect(comparison.codeDiff).toMatchObject({ headCommitChanged: false, workingTreeDigestChanged: true });

    const classificationOf = (checkKey: string): Record<string, any> => {
      const row = (comparison.checks as Record<string, any>[]).find(entry => entry.checkKey === checkKey);
      expect(row, `comparison row ${checkKey} missing`).toBeDefined();
      return row!;
    };
    expect(classificationOf('existing-check').classification).toBe('unchanged_passed');
    expect(classificationOf('known-failure')).toMatchObject({ classification: 'incomparable', reason: 'failure_identity_missing' });
    expect(classificationOf('missing-tool')).toMatchObject({ classification: 'not_run', reason: 'check_not_run' });
    expect(classificationOf('blocked-tool')).toMatchObject({ classification: 'not_run', reason: 'check_not_run' });
    expect(classificationOf('new-requirement')).toMatchObject({ classification: 'fixed' });
    expect(classificationOf('archive-notes')).toMatchObject({ classification: 'new_failure' });

    // 证据引用保留：两侧都携带各自操作与制品引用。
    expect(comparison.previous.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: baselineOperationId, checkKey: 'known-failure', artifactId: knownFailureArtifactId }),
      expect.objectContaining({ operationId: baselineOperationId, checkKey: 'new-requirement' }),
    ]));
    expect(comparison.current.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: currentOperationId, checkKey: 'new-requirement', artifactId: fixedArtifactId }),
    ]));
    // 比较是诊断：不可比与 not_run 明确存在，不提供豁免或通过语义。
    expect(comparison.comparable).toBe(false);
    expect(comparison.gaps).toEqual(expect.arrayContaining(['check_not_run', 'failure_identity_missing']));

    // --- 7) 旧失败未被删除或覆盖：第一次运行的失败证据仍可原样查询 ---
    const preservedEvidence = await run(['baseline', 'evidence', knownFailureArtifactId!, '--data-root', dataRoot, '--json']);
    expect(preservedEvidence.result.exitCode, preservedEvidence.stderr).toBe(0);
    const preservedContent = String((parseJson(preservedEvidence).result as Record<string, any>).content);
    expect(preservedContent).toContain('legacy todo known failure: archive flag missing');
    const knownFailureCheck = checkOf(baselineStatusDetail, 'known-failure');
    expect(knownFailureCheck.status).toBe('failed');
    expect(knownFailureCheck.exitCode).toBe(3);

    // --- 8) Phase 集成边界：局部验证不宣称 Phase 通过 ---
    expect(P08_3_F003_PHASE_INTEGRATION_NOT_RUN.every(
      item => item.status === 'not_run' && item.owner === 'phase-integration',
    )).toBe(true);
    expect(beforeSnapshot.notRun).toEqual(afterChangeSnapshot.notRun);
  }, 240_000);
});
