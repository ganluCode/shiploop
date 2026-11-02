import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildP08ExecutionPlan } from '../../../scripts/acceptance/p08-plan.ts';
import {
  validateP08PhaseIntegrationEvidence,
  type P08PhaseIntegrationEvidence,
} from '../../../scripts/acceptance/p08-phase-integration.ts';
import { P08_ENTRY_STEP_ORDER } from '../../../scripts/acceptance/p08-config.ts';
import { readFileSync } from 'node:fs';

const HEAD = 'a'.repeat(40);
const INPUT = 'b'.repeat(64);

function project(kind: P08PhaseIntegrationEvidence['projects'][number]['kind'], id: string) {
  return {
    kind,
    projectId: id,
    repository: {
      headBefore: HEAD, treeBefore: HEAD, statusBefore: [], headAfter: HEAD, treeAfter: HEAD,
      statusAfter: [], dirtyStatePreserved: true, committedPaths: ['approved.mjs'], commitSha: HEAD,
    },
    cli: {
      commands: [{ name: 'project.init', exitCode: 0, status: 'registered' }, { name: 'baseline.run', exitCode: 0, status: 'completed' }],
      projectState: 'active', operationStates: ['completed'],
    },
    sqlite: { integrity: 'ok', projectRows: 2, operationRows: 2, checkRows: 2 },
  } as const;
}

function evidence(): P08PhaseIntegrationEvidence {
  return {
    schemaVersion: 1,
    kind: 'shiploop.p08.phase-integration-evidence',
    scenarioId: 'p08-f009-phase-integration',
    runId: 'p08-f009-test',
    testedCommit: HEAD,
    inputsDigest: INPUT,
    toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'darwin' },
    command: ['npm', 'install', '--offline', 'shiploop-cli'],
    exitCode: 0,
    status: 'pass',
    durationMs: 12,
    usageSource: 'reported',
    installation: { artifactKind: 'local-pack-tarballs', packageNames: ['shiploop-core', 'shiploop-host', 'shiploop-cli'], independentDirectory: true, npmExitCode: 0 },
    host: { startExitCode: 0, stopExitCode: 0, statusAfterStopExitCode: 3, stoppedVerified: true },
    projects: [project('todo-new-project', 'todo-project'), project('non-nezha-existing-project', 'existing-project')],
    failureBoundaries: [
      { id: 'existing-known-failure', status: 'rejected', reason: 'known failure preserved' },
      { id: 'host-stop-unconfirmed', status: 'rejected', reason: 'stop must be confirmed' },
    ],
    evidenceRefs: ['command-exit', 'artifact', 'manifest', 'host', 'sqlite', 'git', 'process', 'report', 'usage', 'cleanup'],
    cleanup: { processesGone: true, resourcesRemoved: true, confirmed: true },
    knownGaps: ['real Pi live remains independent'],
  };
}

it('[case:p08-f009-plan-wires-integration-step] P08 固定步骤在 Live 导入前执行最终跨层集成', () => {
  const plan = buildP08ExecutionPlan(['test/modules/acceptance/p08-4-f009-phase-integration.test.ts'], false);
  expect(plan.map(step => step.id)).toEqual([
    'p08-prerequisites', 'p08-source-identity', 'p08-deterministic-scope', 'p08-installation',
    'p08-phase-integration', 'p08-live-import', 'p08-report', 'p08-manual-gate',
  ]);
  expect(P08_ENTRY_STEP_ORDER).toEqual(plan.map(step => step.id));
  const entry = JSON.parse(readFileSync(new URL('../../../acceptance/p08.entry.json', import.meta.url), 'utf8')) as { stepOrder: string[] };
  expect(entry.stepOrder).toEqual(P08_ENTRY_STEP_ORDER);
});

it('[case:p08-f009-evidence-contract] 集成证据必须同时绑定身份、SQLite/Git/Host/进程/制品和清理事实', () => {
  const value = evidence();
  expect(validateP08PhaseIntegrationEvidence(value)).toEqual(value);
  expect(() => validateP08PhaseIntegrationEvidence({ ...value, cleanup: { ...value.cleanup, confirmed: false } })).toThrow(/evidence_contract_failed/);
  expect(() => validateP08PhaseIntegrationEvidence({
    ...value,
    projects: [value.projects[0]!, { ...value.projects[1]!, sqlite: { ...value.projects[1]!.sqlite, integrity: 'corrupt' } }],
  })).toThrow(/project_evidence_incomplete/);
});

it('[case:p08-f009-failure-boundary] 关键负例保留 rejected，不被成功退出码或缺失事实覆盖', () => {
  const value = evidence();
  const rejected = value.failureBoundaries.find(item => item.id === 'existing-known-failure');
  expect(rejected).toMatchObject({ status: 'rejected' });
  expect(value.projects[1]!.cli.commands.find(command => command.name === 'baseline.run')).toMatchObject({ exitCode: 1 });
  expect(() => validateP08PhaseIntegrationEvidence({
    ...value,
    projects: [value.projects[0]!, { ...value.projects[1]!, repository: { ...value.projects[1]!.repository, dirtyStatePreserved: false } }],
  })).toThrow(/existing_dirty_state_not_preserved/);
});

it('[case:p08-f009-real-git-fact] 证据测试的 Git 身份使用真实临时仓库格式核对', () => {
  const root = mkdtempSync(join(tmpdir(), 'shiploop-p08-f009-git-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'P08 Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'p08@example.invalid']);
    writeFileSync(join(root, 'README.md'), 'P08 F009\n');
    execFileSync('git', ['-C', root, 'add', 'README.md']);
    execFileSync('git', ['-C', root, '-c', 'user.name=P08 Test', '-c', 'user.email=p08@example.invalid', 'commit', '--quiet', '-m', 'fixture: initial']);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect(head.trim()).toMatch(/^[a-f0-9]{40}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
