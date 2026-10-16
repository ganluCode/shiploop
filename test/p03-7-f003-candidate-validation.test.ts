/**
 * P03-7 / F-003 当前 Attempt 测试目标候选校验、路径安全与受信目标解析。
 *
 * 覆盖（F-003 验收标准）：
 * - 候选只接受当前 Attempt 的模块标识、实际测试目标和理由：payload 结构严格
 *   （schemaVersion/projectId/attemptId/executionVersion/codeDigest/modules），未知字段
 *   （command/shell/argv/environment/options 等）一律拒绝；候选 Artifact 经身份摘要
 *   核验读取，其他 Attempt、过期执行版本、跨项目或内容已改变的候选被拒绝；
 * - 真实文件夹具验证目标存在性、受控 realpath、目录归属和模块允许范围：目录穿越、
 *   外部绝对路径、符号链接逃逸、失效文件及不允许的目标均产生明确拒绝原因；
 * - 可被解释为选项的恶意目标（-x/--watch）在纯校验与真实解析两层都被拒绝；受信
 *   目标解析器只返回规范化目标与理由，不生成也不执行任何候选携带的命令；启动前
 *   recheck 重新核对路径与身份，变更后不能沿用旧选择；
 * - 扫描、候选数量、路径和输出大小均有明确上限，超限 fail-closed。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TEST_CANDIDATE_MODULES_MAX_COUNT,
  TEST_CANDIDATE_MODULE_TARGETS_MAX_COUNT,
  TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT,
  TEST_CANDIDATE_PATH_MAX_LENGTH,
  TEST_CANDIDATE_REASON_MAX_CODE_POINTS,
  TEST_CANDIDATE_PAYLOAD_MAX_BYTES,
  computeTestCandidateDigest,
  validateTestCandidatePayload,
  validateTestCandidateValidationInput,
  type TestCandidatePayload,
  type ResolvedCandidateModule,
} from '../packages/core/src/ports/verification-candidates.ts';
import { createTestTargetResolver } from '../packages/core/src/adapters/fs/verification-target-resolver.ts';
import { createVerificationCandidateValidator } from '../packages/core/src/application/verification-candidates.ts';
import { ArtifactVerifyError } from '../packages/core/src/application/artifact-verify.ts';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import type { AttemptRecord } from '../packages/core/src/ports/attempt-store.ts';
import type { VerifiedArtifactContent } from '../packages/core/src/application/artifact-verify.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const CODE_DIGEST = 'ab'.repeat(32);
const CODE_DIGEST_B = 'cd'.repeat(32);

const POLICY = {
  requireChecksBeforeDone: true,
  checkDefinitions: [
    {
      checkKey: 'unit-core', scope: 'module', kind: 'command',
      argv: ['npm', 'test', '--', 'packages/core'], cwdRef: null, environmentRef: null,
      timeout: 120_000, required: true, requirementRefs: [],
    },
  ],
  modules: [
    {
      moduleKey: 'core',
      allowedTargets: ['packages/core'],
      impactScope: ['packages/core'],
      sharedHighRiskFiles: ['package.json'],
    },
    {
      moduleKey: 'cli',
      allowedTargets: ['packages/cli/src', 'packages/cli/package.json'],
      impactScope: ['packages/cli'],
      sharedHighRiskFiles: [],
    },
  ],
  fullFallback: { checkRefs: ['unit-core'] },
} as const;

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    attemptId: 'attempt-1',
    executionVersion: 3,
    codeDigest: CODE_DIGEST,
    modules: [
      { moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: '修改了核心源码' },
    ],
    ...overrides,
  };
}

function validationField(error: unknown): string | undefined {
  if (!isStorageError(error)) return undefined;
  const field = error.details?.field;
  return typeof field === 'string' ? field : undefined;
}

describe('F-003 候选 payload 纯校验（不执行任何候选内容）', () => {
  it('接受合法候选并计算确定性身份摘要', () => {
    const payload = validateTestCandidatePayload(validPayload(), 'F-003.test');
    expect(payload.modules[0]).toEqual({
      moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: '修改了核心源码',
    });
    const digest = computeTestCandidateDigest(payload);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeTestCandidateDigest(validateTestCandidatePayload(validPayload(), 'F-003.test'))).toBe(digest);
    expect(computeTestCandidateDigest(
      validateTestCandidatePayload(validPayload({ codeDigest: CODE_DIGEST_B }), 'F-003.test'),
    )).not.toBe(digest);
  });

  it('拒绝携带命令、shell、环境或任意执行选项的候选（未知字段 fail-closed）', () => {
    for (const key of ['command', 'shell', 'argv', 'environment', 'env', 'options', 'exec', 'cwd', 'script']) {
      expect(() => validateTestCandidatePayload(validPayload({ [key]: 'rm -rf /' }), 'F-003.test')).toThrow();
    }
    expect(() => validateTestCandidatePayload(validPayload({
      modules: [{ moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: 'r', argv: ['sh', '-c', 'x'] }],
    }), 'F-003.test')).toThrow();
  });

  it('拒绝目录穿越、绝对路径、外部盘符、反斜杠与空/. /.. 段', () => {
    const bad = ['../secret.ts', 'a/../../b.ts', '/etc/passwd', '~/x.ts', 'C:/x.ts',
      'a\\b.ts', 'a//b.ts', './a.ts', 'a/./b.ts', 'a/../b.ts'];
    for (const target of bad) {
      expect(() => validateTestCandidatePayload(validPayload({
        modules: [{ moduleKey: 'core', targets: [target], reason: 'r' }],
      }), 'F-003.test'), target).toThrow();
    }
  });

  it('拒绝可被解释为选项的恶意目标（-x/--watch/--experimental-strip-types）', () => {
    for (const target of ['-x', '--watch', '--experimental-strip-types', '--', '-']) {
      expect(() => validateTestCandidatePayload(validPayload({
        modules: [{ moduleKey: 'core', targets: [target], reason: 'r' }],
      }), 'F-003.test'), target).toThrow();
    }
  });

  it('拒绝非法身份、过期版本形态、非摘要与超限结构', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [validPayload({ schemaVersion: 2 }), 'payload.schemaVersion'],
      [validPayload({ projectId: 'bad id!' }), 'payload.projectId'],
      [validPayload({ attemptId: '' }), 'payload.attemptId'],
      [validPayload({ executionVersion: 0 }), 'payload.executionVersion'],
      [validPayload({ executionVersion: 1.5 }), 'payload.executionVersion'],
      [validPayload({ codeDigest: 'zz' }), 'payload.codeDigest'],
      [validPayload({ modules: [] }), 'payload.modules'],
      [validPayload({ modules: [{ moduleKey: 'core', targets: [], reason: 'r' }] }), 'payload.modules[0].targets'],
      [validPayload({ modules: [{ moduleKey: 'core', targets: ['a.ts'], reason: '' }] }), 'payload.modules[0].reason'],
      [validPayload({
        modules: [
          { moduleKey: 'core', targets: ['a.ts'], reason: 'r' },
          { moduleKey: 'core', targets: ['b.ts'], reason: 'r' },
        ],
      }), 'payload.modules[1].moduleKey'],
      [validPayload({
        modules: [{ moduleKey: 'core', targets: ['a.ts', 'a.ts'], reason: 'r' }],
      }), 'payload.modules[0].targets[1]'],
    ];
    for (const [payload, field] of cases) {
      try {
        validateTestCandidatePayload(payload, 'F-003.test');
        expect.unreachable(`应当拒绝：${field}`);
      } catch (error) {
        expect(validationField(error)).toBe(field);
      }
    }
  });

  it('候选数量、路径长度、理由长度与总目标数上限明确且超限 fail-closed', () => {
    const manyModules = Array.from({ length: TEST_CANDIDATE_MODULES_MAX_COUNT + 1 }, (_, i) => ({
      moduleKey: `m-${i}`, targets: ['a.ts'], reason: 'r',
    }));
    expect(() => validateTestCandidatePayload(validPayload({ modules: manyModules }), 'F-003.test')).toThrow();
    const manyTargets = Array.from({ length: TEST_CANDIDATE_MODULE_TARGETS_MAX_COUNT + 1 }, (_, i) => `t-${i}.ts`);
    expect(() => validateTestCandidatePayload(validPayload({
      modules: [{ moduleKey: 'core', targets: manyTargets, reason: 'r' }],
    }), 'F-003.test')).toThrow();
    expect(() => validateTestCandidatePayload(validPayload({
      modules: [{ moduleKey: 'core', targets: [`${'a'.repeat(TEST_CANDIDATE_PATH_MAX_LENGTH)}.ts`], reason: 'r' }],
    }), 'F-003.test')).toThrow();
    expect(() => validateTestCandidatePayload(validPayload({
      modules: [{ moduleKey: 'core', targets: ['a.ts'], reason: '理'.repeat(TEST_CANDIDATE_REASON_MAX_CODE_POINTS + 1) }],
    }), 'F-003.test')).toThrow();
    // 总目标数上限跨模块累计
    const perModule = Math.floor(TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT / 2) + 1;
    expect(() => validateTestCandidatePayload(validPayload({
      modules: [
        { moduleKey: 'core', targets: Array.from({ length: perModule }, (_, i) => `c-${i}.ts`), reason: 'r' },
        { moduleKey: 'cli', targets: Array.from({ length: perModule }, (_, i) => `l-${i}.ts`), reason: 'r' },
      ],
    }), 'F-003.test')).toThrow();
    expect(TEST_CANDIDATE_PAYLOAD_MAX_BYTES).toBeGreaterThan(0);
  });
});

/** 真实文件工作区夹具：ws/ 为受管 worktree，secret.txt 在其之外。 */
function workspaceFixture(box: { path: string }) {
  const ws = join(box.path, 'ws');
  mkdirSync(join(ws, 'packages/core/src'), { recursive: true });
  mkdirSync(join(ws, 'packages/core/tests'), { recursive: true });
  mkdirSync(join(ws, 'packages/cli/src'), { recursive: true });
  writeFileSync(join(ws, 'packages/core/src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'packages/core/tests/a.test.ts'), 'test\n');
  writeFileSync(join(ws, 'packages/cli/src/main.ts'), 'main\n');
  writeFileSync(join(ws, 'packages/cli/package.json'), '{}\n');
  writeFileSync(join(box.path, 'secret.txt'), 'secret\n');
  return ws;
}

const resolver = createTestTargetResolver();

function resolveIn(ws: string, candidates: readonly { moduleKey: string; targets: readonly string[]; reason: string }[]) {
  return resolver.resolve({
    workspaceRoot: ws,
    policyModules: POLICY.modules,
    candidates,
  });
}

describe('F-003 受信目标解析器（真实文件系统）', () => {
  it('解析存在的文件与目录目标，返回规范化目标、类型与身份指纹', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const result = await resolveIn(ws, [
        { moduleKey: 'core', targets: ['packages/core/src/a.ts', 'packages/core/tests'], reason: '核心变更' },
        { moduleKey: 'cli', targets: ['packages/cli/package.json'], reason: '清单变更' },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.modules.map((m) => m.moduleKey)).toEqual(['core', 'cli']);
      const [core, cli] = result.modules;
      expect(core.reason).toBe('核心变更');
      expect(core.targets.map((t) => [t.target, t.kind])).toEqual([
        ['packages/core/src/a.ts', 'file'],
        ['packages/core/tests', 'directory'],
      ]);
      expect(cli.targets[0]?.kind).toBe('file');
      for (const m of result.modules) {
        for (const t of m.targets) expect(t.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally { box.cleanup(); }
  });

  it('失效文件与模块允许范围之外的目标产生明确拒绝原因', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const missing = await resolveIn(ws, [
        { moduleKey: 'core', targets: ['packages/core/src/missing.ts'], reason: 'r' },
      ]);
      expect(missing).toMatchObject({ ok: false, reason: 'target_missing' });
      const notAllowed = await resolveIn(ws, [
        { moduleKey: 'core', targets: ['packages/cli/src/main.ts'], reason: 'r' },
      ]);
      expect(notAllowed).toMatchObject({ ok: false, reason: 'target_not_allowed' });
      const outsideModule = await resolveIn(ws, [
        { moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: 'r' },
        { moduleKey: 'ghost', targets: ['packages/core/src/a.ts'], reason: 'r' },
      ]);
      expect(outsideModule).toMatchObject({ ok: false, reason: 'unknown_module' });
    } finally { box.cleanup(); }
  });

  it('目录穿越、外部绝对路径与选项形目标在解析层同样被拒绝', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      for (const [target, reason] of [
        ['../secret.txt', 'target_invalid'],
        ['/etc/passwd', 'target_invalid'],
        ['packages/core/../../secret.txt', 'target_invalid'],
        ['--watch', 'target_option_like'],
        ['-x', 'target_option_like'],
      ] as const) {
        const result = await resolveIn(ws, [{ moduleKey: 'core', targets: [target], reason: 'r' }]);
        expect(result, target).toMatchObject({ ok: false, reason });
      }
    } finally { box.cleanup(); }
  });

  it('符号链接逃逸（叶子与祖先）一律拒绝，不跟随不穿透', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      symlinkSync(join(box.path, 'secret.txt'), join(ws, 'packages/core/src/link.ts'));
      symlinkSync(box.path, join(ws, 'packages/core/escape'));
      const leaf = await resolveIn(ws, [{ moduleKey: 'core', targets: ['packages/core/src/link.ts'], reason: 'r' }]);
      expect(leaf).toMatchObject({ ok: false, reason: 'target_symlink' });
      const ancestor = await resolveIn(ws, [{ moduleKey: 'core', targets: ['packages/core/escape/secret.txt'], reason: 'r' }]);
      expect(ancestor).toMatchObject({ ok: false, reason: 'target_symlink' });
      const dirLink = await resolveIn(ws, [{ moduleKey: 'core', targets: ['packages/core/escape'], reason: 'r' }]);
      expect(dirLink).toMatchObject({ ok: false, reason: 'target_symlink' });
    } finally { box.cleanup(); }
  });

  it('特殊文件（fifo）与不可信工作区根 fail-closed', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      execFileSync('mkfifo', [join(ws, 'packages/core/src/pipe')]);
      const special = await resolveIn(ws, [{ moduleKey: 'core', targets: ['packages/core/src/pipe'], reason: 'r' }]);
      expect(special).toMatchObject({ ok: false, reason: 'target_special' });
      const badRoot = await resolveIn(join(box.path, 'missing-ws'), [
        { moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: 'r' },
      ]);
      expect(badRoot).toMatchObject({ ok: false, reason: 'workspace_untrusted' });
      const fileRoot = await resolver.resolve({
        workspaceRoot: join(box.path, 'secret.txt'), policyModules: POLICY.modules,
        candidates: [{ moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: 'r' }],
      });
      expect(fileRoot).toMatchObject({ ok: false, reason: 'workspace_untrusted' });
    } finally { box.cleanup(); }
  });

  it('recheck 启动前重核：未变化放行；内容改写、替换为链接或删除后旧选择失效', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const input = {
        workspaceRoot: ws,
        policyModules: POLICY.modules,
        candidates: [{ moduleKey: 'core', targets: ['packages/core/src/a.ts'], reason: 'r' }] as const,
      };
      const first = await resolver.resolve(input);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const again = await resolver.recheck(input, first.modules);
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.modules).toEqual(first.modules);

      appendFileSync(join(ws, 'packages/core/src/a.ts'), '// changed\n');
      const changed = await resolver.recheck(input, first.modules);
      expect(changed).toMatchObject({ ok: false, reason: 'content_changed' });

      rmSync(join(ws, 'packages/core/src/a.ts'));
      const deleted = await resolver.recheck(input, first.modules);
      expect(deleted).toMatchObject({ ok: false, reason: 'target_missing' });

      symlinkSync(join(box.path, 'secret.txt'), join(ws, 'packages/core/src/a.ts'));
      const linked = await resolver.recheck(input, first.modules);
      expect(linked).toMatchObject({ ok: false, reason: 'target_symlink' });
    } finally { box.cleanup(); }
  });
});

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1', projectId: 'proj-1', featureId: 'feature-1', runId: 'run-1', taskId: 'task-1',
    number: 1, owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 3,
    status: 'executing', executionStage: 'verification',
    ...overrides,
  } as AttemptRecord;
}

function verifierWith(content: unknown, overrides: Partial<VerifiedArtifactContent> = {}) {
  const body = typeof content === 'string' ? new TextEncoder().encode(content) : (content as Uint8Array);
  return {
    async readVerifiedContent(projectId: string, artifactId: string): Promise<VerifiedArtifactContent> {
      return {
        projectId, artifactId, content: body, sizeBytes: body.byteLength,
        contentHash: createHash('sha256').update(body).digest('hex'),
        locator: `candidates/${artifactId}.json`, relativePath: `candidates/${artifactId}.json`,
        ...overrides,
      };
    },
  };
}

function verifierFailing(error: unknown) {
  return {
    async readVerifiedContent(): Promise<VerifiedArtifactContent> { throw error; },
  };
}

function attemptsWith(record: AttemptRecord | null) {
  return {
    getAttempt(): AttemptRecord {
      if (record === null) throw new StorageError('not_found', 'AttemptStore.read', 'missing');
      return record;
    },
  };
}

async function validateWith(ws: string, deps: {
  attempt?: AttemptRecord | null;
  verifier?: ReturnType<typeof verifierWith>;
  inputOverrides?: Record<string, unknown>;
}) {
  const validator = createVerificationCandidateValidator({
    attempts: attemptsWith(deps.attempt === undefined ? attemptRecord() : deps.attempt),
    verifier: deps.verifier ?? verifierWith(JSON.stringify(validPayload())),
    resolver,
  });
  return validator.validateCandidates({
    projectId: 'proj-1', attemptId: 'attempt-1', executionVersion: 3, codeDigest: CODE_DIGEST,
    candidateArtifactId: 'cand-1', policy: POLICY, workspaceRoot: ws,
    ...deps.inputOverrides,
  });
}

describe('F-003 候选校验编排（当前 Attempt / 执行版本 / 项目 / 内容身份绑定）', () => {
  it('合法候选返回规范化目标、理由与 Artifact 身份摘要，不执行候选内容', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const verifier = verifierWith(JSON.stringify(validPayload()));
      const result = await validateWith(ws, { verifier });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.candidateDigest).toBe(
        computeTestCandidateDigest(validateTestCandidatePayload(validPayload(), 'F-003.test')),
      );
      expect(result.artifact.artifactId).toBe('cand-1');
      expect(result.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.modules[0]?.targets[0]?.target).toBe('packages/core/src/a.ts');
      expect(result.modules[0]?.reason).toBe('修改了核心源码');
    } finally { box.cleanup(); }
  });

  it('其他 Attempt、过期执行版本、跨项目与代码身份变化的候选被拒绝', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const otherAttempt = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({ attemptId: 'attempt-2' }))),
      });
      expect(otherAttempt).toMatchObject({ ok: false, reason: 'attempt_mismatch' });
      const staleInput = await validateWith(ws, { inputOverrides: { executionVersion: 2 } });
      expect(staleInput).toMatchObject({ ok: false, reason: 'stale_execution_version' });
      const stalePayload = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({ executionVersion: 2 }))),
      });
      expect(stalePayload).toMatchObject({ ok: false, reason: 'stale_execution_version' });
      const otherProject = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({ projectId: 'proj-2' }))),
      });
      expect(otherProject).toMatchObject({ ok: false, reason: 'project_mismatch' });
      const codeChanged = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({ codeDigest: CODE_DIGEST_B }))),
      });
      expect(codeChanged).toMatchObject({ ok: false, reason: 'code_changed' });
      const missing = await validateWith(ws, { attempt: null });
      expect(missing).toMatchObject({ ok: false, reason: 'attempt_mismatch' });
    } finally { box.cleanup(); }
  });

  it('候选 Artifact 不可信（缺失/pending/损坏/跨项目）或超大被拒绝', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      for (const error of [
        new ArtifactVerifyError('not_found', 'missing', { projectId: 'proj-1', artifactId: 'cand-1' }),
        new ArtifactVerifyError('corrupt', 'hash mismatch', { projectId: 'proj-1', artifactId: 'cand-1' }),
        new ArtifactVerifyError('ownership', 'cross project', { projectId: 'proj-1', artifactId: 'cand-1' }),
        new ArtifactVerifyError('size_limit_exceeded', 'too large', { projectId: 'proj-1', artifactId: 'cand-1' }),
      ]) {
        const result = await validateWith(ws, { verifier: verifierFailing(error) });
        expect(result).toMatchObject({ ok: false, reason: 'artifact_untrusted' });
      }
      const oversized = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload()), { sizeBytes: TEST_CANDIDATE_PAYLOAD_MAX_BYTES + 1 }),
      });
      expect(oversized).toMatchObject({ ok: false, reason: 'candidate_too_large' });
    } finally { box.cleanup(); }
  });

  it('非法 JSON、携带执行字段的候选与无模块政策均 fail-closed', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const notJson = await validateWith(ws, { verifier: verifierWith('not json {') });
      expect(notJson).toMatchObject({ ok: false, reason: 'invalid_payload' });
      const withCommand = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({ command: 'rm -rf /' }))),
      });
      expect(withCommand).toMatchObject({ ok: false, reason: 'invalid_payload' });
      const noModules = await validateWith(ws, {
        inputOverrides: { policy: { requireChecksBeforeDone: true } },
      });
      expect(noModules).toMatchObject({ ok: false, reason: 'no_module_policy' });
      const optionTarget = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({
          modules: [{ moduleKey: 'core', targets: ['--watch'], reason: 'r' }],
        }))),
      });
      expect(optionTarget).toMatchObject({ ok: false, reason: 'invalid_payload' });
    } finally { box.cleanup(); }
  });

  it('解析层拒绝原因透传；recheckCandidates 在启动前重核身份与路径', async () => {
    const box = createTempSandbox();
    try {
      const ws = workspaceFixture(box);
      const notAllowed = await validateWith(ws, {
        verifier: verifierWith(JSON.stringify(validPayload({
          modules: [{ moduleKey: 'core', targets: ['packages/cli/src/main.ts'], reason: 'r' }],
        }))),
      });
      expect(notAllowed).toMatchObject({ ok: false, reason: 'target_not_allowed' });

      const validator = createVerificationCandidateValidator({
        attempts: attemptsWith(attemptRecord()),
        verifier: verifierWith(JSON.stringify(validPayload())),
        resolver,
      });
      const input = {
        projectId: 'proj-1', attemptId: 'attempt-1', executionVersion: 3, codeDigest: CODE_DIGEST,
        candidateArtifactId: 'cand-1', policy: POLICY, workspaceRoot: ws,
      };
      const first = await validator.validateCandidates(input);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const again = await validator.recheckCandidates(input, first);
      expect(again.ok).toBe(true);
      const codeMoved = await validator.recheckCandidates({ ...input, codeDigest: CODE_DIGEST_B }, first);
      expect(codeMoved).toMatchObject({ ok: false, reason: 'code_changed' });
      appendFileSync(join(ws, 'packages/core/src/a.ts'), '// late change\n');
      const drifted = await validator.recheckCandidates(input, first);
      expect(drifted).toMatchObject({ ok: false, reason: 'content_changed' });
    } finally { box.cleanup(); }
  });
});

describe('F-003 编排输入校验', () => {
  it('拒绝未知字段与非法身份/根路径', () => {
    const base = {
      projectId: 'proj-1', attemptId: 'attempt-1', executionVersion: 3, codeDigest: CODE_DIGEST,
      candidateArtifactId: 'cand-1', policy: POLICY, workspaceRoot: '/tmp/ws',
    };
    expect(validateTestCandidateValidationInput(base, 'F-003.test').projectId).toBe('proj-1');
    expect(() => validateTestCandidateValidationInput({ ...base, shell: true }, 'F-003.test')).toThrow();
    expect(() => validateTestCandidateValidationInput({ ...base, workspaceRoot: 'relative/ws' }, 'F-003.test')).toThrow();
    expect(() => validateTestCandidateValidationInput({ ...base, codeDigest: 'nope' }, 'F-003.test')).toThrow();
  });
});

type _PayloadUsed = TestCandidatePayload;
type _ModulesUsed = ResolvedCandidateModule;
