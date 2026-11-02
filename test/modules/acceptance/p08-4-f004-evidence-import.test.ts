import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  runTodoLiveDelivery,
  type TodoLiveTask,
  type TodoLiveDeliveryReport,
} from '../../../scripts/acceptance/p08-todo-live.ts';
import { aggregateTodoLiveEvidence } from '../../../scripts/acceptance/p08-todo-live-report.ts';
import { importP08PrerequisiteEvidence } from '../../../scripts/acceptance/p08-evidence-import.ts';
import { buildP08RunIdentity, type P08ExternalEvidenceReference } from '../../../scripts/acceptance/p08-identity.ts';
import {
  collectBrownfieldEvidenceEnvelope,
} from '../../../packages/core/src/ports/brownfield-evidence.ts';
import {
  computeBrownfieldCheckCommandDigest as commandDigest,
  type BrownfieldCheckDefinition,
  type BrownfieldCheckResult,
  type BrownfieldCheckSnapshot,
  type BrownfieldCodeIdentity,
} from '../../../packages/core/src/ports/brownfield.ts';

const ROOT = process.cwd();
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(64);
const requirements = { version: 1, digest: 'c'.repeat(64) };
const tasks: TodoLiveTask[] = [
  { id: 'F-001', title: 'Todo 数据层', dependsOn: [] },
  { id: 'F-002', title: 'Todo 命令', dependsOn: ['F-001'] },
  { id: 'F-003', title: 'Todo 验证', dependsOn: ['F-002'] },
];

function delivery(): Promise<TodoLiveDeliveryReport> {
  let sequence = 0;
  return runTodoLiveDelivery({
    projectId: 'todo-project', featureId: 'todo-feature', runId: 'todo-run', tasks,
    authorization: { realPi: true, provider: 'provider', model: 'model', expiresAt: Date.now() + 60_000, maxTasks: 3 },
    ports: {
      runTask: async task => ({ executionMode: 'live', status: 'completed', taskId: task.id,
        attemptId: `attempt-${task.id}`, provider: 'provider', model: 'model', realCalls: 1 }),
      verifyTask: async task => ({ status: 'passed', taskId: task.id, exitCode: 0,
        command: ['node', `verify-${task.id}.mjs`], evidenceRef: `checks/${task.id}.json` }),
      commitTask: async task => {
        sequence += 1;
        return { status: 'succeeded', taskId: task.id, commitSha: String(sequence).padStart(40, '0'), treeSha: 'd'.repeat(40), message: `${task.id}: ${task.title}` };
      },
      saveEvidence: async () => {},
    },
  });
}

function check(): BrownfieldCheckDefinition {
  return { checkKey: 'existing-check', argv: ['node', 'checks/existing.mjs'], environmentIdentity: 'e'.repeat(64), timeoutMs: 10_000, required: true };
}
function snapshot(definition: BrownfieldCheckDefinition): BrownfieldCheckSnapshot {
  const result: BrownfieldCheckResult = { status: 'passed', evidenceRefs: ['artifacts/existing.json'] };
  return { check: definition, commandDigest: commandDigest(definition), result };
}
function existingEnvelope(): unknown {
  const definition = check();
  const identity = (headCommit: string): BrownfieldCodeIdentity => ({
    repoIdentity: `gitdir-sha256:${'f'.repeat(64)}`, headCommit, workingTreeDigest: TREE, hasUncommittedChanges: true,
  });
  return collectBrownfieldEvidenceEnvelope({
    projectId: 'existing-project',
    binding: { projectId: 'existing-project', repositoryBindingId: 'binding', bindingRevision: 1,
      canonicalPath: '/tmp/existing-project', repoIdentity: `gitdir-sha256:${'f'.repeat(64)}` },
    testCommit: HEAD, baselineCodeIdentity: identity(HEAD), currentCodeIdentity: identity(HEAD),
    checkScope: { requiredCheckKeys: ['existing-check'], optionalCheckKeys: [] },
    baselineChecks: [snapshot(definition)], currentChecks: [snapshot(definition)],
    artifacts: [{ ref: 'artifacts/existing.json', digest: '1'.repeat(64), bytes: 12 }],
    baselineDirtyFiles: [{ path: 'notes.md', state: 'modified_unstaged', digest: '2'.repeat(64) }],
    currentDirtyFiles: [{ path: 'notes.md', state: 'modified_unstaged', digest: '2'.repeat(64) }],
    phaseIntegration: [{ id: 'real-host', reason: 'phase-integration-required' }], collectedAtUtcMs: 1_769_000_000_000,
  });
}

function identity() {
  return buildP08RunIdentity({
    runId: 'p08-run', testedCommit: HEAD, configDigest: '1'.repeat(64), checklistDigest: '2'.repeat(64),
    prerequisites: { features: ['P08-1', 'P08-2', 'P08-3'] },
    toolchain: { node: '22.19.0', npm: '10.9.3', platform: 'darwin' }, testScope: [{ file: 'acceptance/p08.config.json', sha256: '3'.repeat(64) }], externalReports: [],
  });
}

function ref(kind: P08ExternalEvidenceReference['kind'], path: string, content: string): P08ExternalEvidenceReference {
  return { kind, path, digest: createHash('sha256').update(content).digest('hex') };
}

async function writeEvidence(root: string, name: string, kind: P08ExternalEvidenceReference['kind'], value: unknown): Promise<P08ExternalEvidenceReference> {
  const content = `${JSON.stringify(value)}\n`;
  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(join(root, 'evidence', name), content, { flag: 'wx' });
  return ref(kind, `evidence/${name}`, content);
}

function installManifest(): unknown {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'acceptance/p08-1.release-manifest.json'), 'utf8')) as Record<string, unknown>;
  return { ...manifest, identity: { ...(manifest.identity as Record<string, unknown>), gitCommit: HEAD } };
}

async function fixture(): Promise<{ root: string; refs: P08ExternalEvidenceReference[] }> {
  const root = mkdtempSync(join(tmpdir(), 'p08-f004-import-'));
  const todoDelivery = await delivery();
  const todo = aggregateTodoLiveEvidence({
    delivery: todoDelivery, requirements, code: { headCommit: HEAD, headTree: 'd'.repeat(40) },
    checks: [{ id: 'todo-check', exitCode: 0, command: ['node', 'verify.mjs'], evidence: { ref: 'checks/todo.json', content: '{"ok":true}\n' } }],
  });
  return { root, refs: [
    await writeEvidence(root, 'install.json', 'install-manifest', installManifest()),
    await writeEvidence(root, 'todo.json', 'todo-live', todo),
    await writeEvidence(root, 'existing.json', 'existing-live', existingEnvelope()),
  ] };
}

describe('P08-4 F-004 前序交付与两类 Live 证据导入', () => {
  it('[case:p08-f004-import-all-kinds] 三类报告分别导入并保留各自状态；存量 phase not_run 不被伪装为通过', async () => {
    const fixtureData = await fixture();
    const result = await importP08PrerequisiteEvidence({ evidenceRoot: fixtureData.root, references: fixtureData.refs,
      runIdentity: identity(), isAncestor: () => true });
    expect(result).toMatchObject({ status: 'not_run', identity: { runId: 'p08-run', testedCommit: HEAD }, counts: { passed: 1, failed: 0, not_run: 2 } });
    expect(result.reports.map(report => report.kind)).toEqual(['install-manifest', 'todo-live', 'existing-live']);
    expect(result.reports.find(report => report.kind === 'todo-live')?.status).toBe('passed');
    expect(result.reports.find(report => report.kind === 'existing-live')?.status).toBe('not_run');
    expect(result.blockingIssues).toContain('existing-live:not_run');
  });

  it('[case:p08-f004-type-substitution] Todo 报告冒充存量报告时 fail-closed，不能用一类 Live 替代另一类', async () => {
    const fixtureData = await fixture();
    const todo = fixtureData.refs.find(reference => reference.kind === 'todo-live')!;
    const substituted = { ...todo, kind: 'existing-live' as const, path: todo.path.replace('todo.json', 'wrong-existing.json') };
    const content = readFileSync(join(fixtureData.root, todo.path), 'utf8');
    writeFileSync(join(fixtureData.root, substituted.path), content);
    const refs = fixtureData.refs.filter(reference => reference.kind !== 'existing-live').map(reference => reference.kind === 'todo-live' ? substituted : reference);
    const result = await importP08PrerequisiteEvidence({ evidenceRoot: fixtureData.root, references: refs,
      runIdentity: identity(), isAncestor: () => true });
    expect(result.status).toBe('failed');
    expect(result.reports).toHaveLength(1);
    expect(result.blockingIssues).toContain('existing-live:failed');
    expect(result.blockingIssues.some(issue => issue.startsWith('existing-live:'))).toBe(true);
  });

  it('[case:p08-f004-missing-and-integrity] 缺少报告为 not_run，摘要篡改或越权字段为 fail 且不回显敏感内容', async () => {
    const fixtureData = await fixture();
    const refs = fixtureData.refs.filter(reference => reference.kind !== 'todo-live');
    const missing = await importP08PrerequisiteEvidence({ evidenceRoot: fixtureData.root, references: refs,
      runIdentity: identity(), isAncestor: () => true });
    expect(missing.status).toBe('not_run');
    expect(missing.blockingIssues).toContain('todo-live:missing');

    const install = refs.find(reference => reference.kind === 'install-manifest')!;
    const installPath = join(fixtureData.root, install.path);
    const tampered = JSON.parse(readFileSync(installPath, 'utf8')) as Record<string, unknown>;
    tampered.authorization = 'Bearer secret-value';
    writeFileSync(installPath, `${JSON.stringify(tampered)}\n`);
    const badRef = { ...install, digest: createHash('sha256').update(readFileSync(installPath)).digest('hex') };
    const failed = await importP08PrerequisiteEvidence({ evidenceRoot: fixtureData.root,
      references: [...refs.filter(reference => reference.kind !== 'install-manifest'), badRef], runIdentity: identity(), isAncestor: () => true });
    expect(failed.status).toBe('failed');
    expect(failed.blockingIssues.some(issue => issue.startsWith('install-manifest:failed'))).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret-value');
  });
});
