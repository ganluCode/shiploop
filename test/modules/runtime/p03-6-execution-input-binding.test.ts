/**
 * P03-6 / F-002 不可变执行输入绑定测试（真实临时 SQLite + 真实 Git 仓库 +
 * 真实制品文件；经公开命令通道完成 注册→配置→计划→批准→prepare→start→claim→
 * beginLaunch 全真实前置，非 mock）。
 *
 * 验收依据（task_list F-002）：
 * - 消费 P03-2 snapshot/manifest/prompt 与 P03-4 claim/workspace 回执，同项目
 *   ready Artifact 的版本/hash/size、Task 完整 acceptance、实际策略与输入身份
 *   逐项核验；产出受限读取能力（BoundExecutionInputReader）而非业务库句柄；
 * - manifest 标记的必需正文在 Fake 执行前实际读取并保留用途/摘要/读取结果证据；
 *   引用存在但未读取不记为已满足；缺失、pending/failed、正文损坏、错误版本、
 *   跨项目、超限、不可读明确失败且零代码/工具副作用（证据保留、旧制品与预算
 *   不变）；
 * - cwd 绑定前序核验的工作区与当前 Attempt：占用归属与 realpath 复核；符号链接
 *   越界、未获准根、权限扩大拒绝；凭据只保留引用（策略仅 credentialRef 引用）；
 * - 不同 Task 独立输入/Session 上下文；auto/new/required 通用恢复决定与来源
 *   记录：Fake 无原生续接能力时 auto 显式降级 new（原因入证据）、required
 *   明确拒绝；旧执行未停止一律拒绝重叠；不实现原生档案；
 * - 修改原可变来源/扩大 progress 报告不改变既有制品；prompt 不内联历史与必需
 *   正文全文、完整 acceptance 仍可读取；单项/总字节/引用数量/读取耗时有界；
 * - RuntimeRequest 携带稳定 invocationId 与已授权恢复引用；恢复来源的同项目/
 *   用途/版本/摘要拒绝样例进入输入核验（core-design/14）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStaticRuntimeRecoveryCatalog,
  computeExecutionPermissionsDigest,
  deriveArtifactFinalRelativePath,
  isExecutionInputBindingError,
  isStorageError,
  validateExecutionInputBindingInput,
  validateExecutionInputReadEvidence,
  validateRuntimeExecutionRequest,
} from '../../../packages/core/src/index.ts';
import type {
  AttemptStore, ExecutionInputReadEvidence, ExecutionInputRef,
  RuntimeRecoverySourceState,
} from '../../../packages/core/src/index.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createExecutionInputBindingService } from '../../../packages/core/src/application/execution-input-binding.ts';
import {
  BINDING_NOW,
  FAKE_STRATEGY,
  openBindingFixture,
  publishReadyArtifact,
} from '../../helpers/p03-6/input-binding-fixture.ts';
import { CONTEXT_PROMPT_DIGEST_DOMAIN } from '../../../packages/core/src/ports/context-build.ts';
import type {
  BindingFixture,
  BoundAttempt,
} from '../../helpers/p03-6/input-binding-fixture.ts';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

let current: BindingFixture | undefined;
afterEach(() => {
  current?.close();
  current = undefined;
});
async function setup(options?: Parameters<typeof openBindingFixture>[0]): Promise<BindingFixture> {
  current = await openBindingFixture(options);
  return current;
}

function gitStatus(repoDir: string): string {
  return execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf8' });
}

function artifactFileHash(fixture: BindingFixture, artifactId: string, locator: string): string {
  return sha256(readFileSync(join(
    fixture.box.dataRoot,
    deriveArtifactFinalRelativePath({ projectId: fixture.projectId, artifactId, locator }),
  )));
}

/** 插入同 Task 的历史终态 Attempt（恢复来源；真实行，受既有触发器约束）。 */
function insertOldSucceededAttempt(
  fixture: BindingFixture,
  bound: BoundAttempt,
  attemptId: string,
  number = 90,
): void {
  fixture.session.database.prepare(
    `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
      number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest,
      input_ref, status, execution_stage, started_at, ended_at, duration_ms, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner-1', 'host-1', 1, ?, ?, ?, ?, 'succeeded', 'commit', ?, ?, 5, 0)`,
  ).run(
    attemptId, 1_900_000_000_000, 1_900_000_000_000, fixture.projectId, fixture.featureId,
    fixture.runId, bound.taskId, number, 1_900_000_000_000,
    JSON.stringify(bound.inputSnapshot), bound.inputSnapshot.digests.snapshotDigest,
    bound.inputSnapshot.group.snapshot.artifactId, 1_900_000_000_000, 1_900_000_000_001,
  );
}

/** 构造合法恢复来源（kind=conversation；overrides 做负例）。 */
function recoverySource(
  fixture: BindingFixture,
  bound: BoundAttempt,
  archive: { artifactId: string; contentHash: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1, purpose: 'work', kind: 'conversation', sourceProjectId: fixture.projectId,
    sourceSessionId: 'session-old', sourceTaskId: bound.taskId, sourceAttemptId: 'attempt-old-1',
    runtime: FAKE_STRATEGY.runtime, provider: FAKE_STRATEGY.provider, model: FAKE_STRATEGY.model,
    providerSessionId: 'native-old', nativeArchiveRef: archive.artifactId,
    nativeFormat: 'synthetic-json', nativeFormatVersion: '1', sourceDigest: archive.contentHash,
    ...overrides,
  };
}

/** 用真实不可变 Artifact 接通 P03-3A 可信来源授权，供恢复绑定集成测试使用。 */
function recoveryAuthority() {
  // Reader 按端口返回 unknown，由真实恢复服务校验合成 Fake 状态。
  let current: unknown;
  let state: RuntimeRecoverySourceState | undefined;
  return {
    reader: { readCurrent: () => current, readSource: () => state },
    async authorize(fixture: BindingFixture, bound: BoundAttempt, source: Record<string, unknown>) {
      const ref = async (artifactId: string, purpose: string): Promise<ExecutionInputRef> => {
        const record = await fixture.artifacts.getArtifact(fixture.projectId, artifactId);
        return { projectId: fixture.projectId, artifactId, purpose, kind: record.kind,
          version: record.version, contentHash: record.contentHash!, sizeBytes: record.sizeBytes!,
          locator: record.locator, mediaType: record.mediaType, origin: { kind: 'artifact' } };
      };
      const snapshot = await ref(bound.inputSnapshot.group.snapshot.artifactId, 'snapshot');
      const archive = await ref(source['nativeArchiveRef'] as string, 'native-archive');
      const codeDigest = sha256('synthetic-workspace-code');
      // 合成 Fake 访问快照：仅保存摘要/引用，与来源不可变证据逐项比较。
      const workAccess = {
        strategy: FAKE_STRATEGY,
        authentication: { status: 'ready', digest: sha256('synthetic-authentication'),
          sourceRef: 'synthetic-credential-ref', kind: 'environment' },
        resources: { digest: sha256('[]'), entries: [] },
      } as const;
      const stop = await publishReadyArtifact(fixture, {
        kind: 'stop-evidence', locator: 'recovery/stop.json', content: '{"stopped":"synthetic-confirmed"}',
      });
      const evidence = await publishReadyArtifact(fixture, {
        kind: 'runtime-recovery-evidence', locator: 'recovery/evidence.json',
        content: JSON.stringify({ schemaVersion: 1, source, inputSnapshot: snapshot, archive,
          codeDigest, permissionsDigest: computeExecutionPermissionsDigest([]), workAccess }),
      });
      current = { inputSnapshot: snapshot, codeDigest, permissions: { grants: [] }, workAccess };
      state = { evidence: await ref(evidence.artifactId, 'recovery-evidence'), stopped: 'confirmed',
        stopEvidence: await ref(stop.artifactId, 'stop-evidence') };
    },
    stopUnknown() { state = { ...state!, stopped: 'unknown' }; },
  };
}

const ALL_UNSUPPORTED = {
  nativeHistory: { status: 'unsupported', limits: [] },
  conversationResume: { status: 'unsupported', limits: [] },
  executionRecovery: { status: 'unsupported', limits: [] },
  modelSwitchOnResume: { status: 'unsupported', limits: [] },
  nativeFork: { status: 'unsupported', limits: [] },
};

const CONVERSATION_VERIFIED = {
  nativeHistory: { status: 'unsupported', limits: [] },
  conversationResume: { status: 'verified', evidenceRef: 'evidence-cr-1', limits: [] },
  executionRecovery: { status: 'unsupported', limits: [] },
  modelSwitchOnResume: { status: 'unsupported', limits: [] },
  nativeFork: { status: 'verified', evidenceRef: 'evidence-nf-1', limits: [] },
};

function descriptorWith(capabilities: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0.0', sdkVersion: null,
    nativeFormats: [{ format: 'synthetic-json', versions: ['1'] }], limits: [],
    capabilities,
  };
}

/**
 * 拒绝路径公共断言：结构化错误 + 拒绝证据已按 Attempt 关联保留 +
 * 零代码/工具副作用（git 现场、预算/启动预占、既有制品全部不变）。
 */
async function expectRejection(
  fixture: BindingFixture,
  input: Record<string, unknown>,
  expected: { kind: 'input' | 'workspace' | 'recovery'; reason: string },
): Promise<ExecutionInputReadEvidence> {
  const statusBefore = gitStatus(fixture.box.repoDirA);
  const artifactCountBefore = (fixture.query('SELECT COUNT(*) AS n FROM artifacts') as { n: number }).n;
  const reservationsBefore = (fixture.query('SELECT COUNT(*) AS n FROM task_attempt_reservations') as { n: number }).n;
  const runtimeStartsBefore = (fixture.query('SELECT COUNT(*) AS n FROM runtime_start_reservations') as { n: number }).n;
  let thrown: unknown;
  try {
    await fixture.bindingService.bind(input);
  } catch (error) {
    thrown = error;
  }
  expect(isExecutionInputBindingError(thrown)).toBe(true);
  const bindingError = thrown as { kind: string; reason: string; evidenceRef: string | null };
  expect(bindingError.kind).toBe(expected.kind);
  expect(bindingError.reason).toBe(expected.reason);
  expect(gitStatus(fixture.box.repoDirA)).toBe(statusBefore);
  expect((fixture.query('SELECT COUNT(*) AS n FROM task_attempt_reservations') as { n: number }).n)
    .toBe(reservationsBefore);
  expect((fixture.query('SELECT COUNT(*) AS n FROM runtime_start_reservations') as { n: number }).n)
    .toBe(runtimeStartsBefore);
  /* 失败保留输入证据：仅新增一条按 Attempt 关联的 ready 证据制品。 */
  expect((fixture.query('SELECT COUNT(*) AS n FROM artifacts') as { n: number }).n)
    .toBe(artifactCountBefore + 1);
  expect(bindingError.evidenceRef).not.toBeNull();
  const evidenceRow = fixture.query(
    'SELECT kind, status FROM artifacts WHERE id = ?', bindingError.evidenceRef,
  ) as { kind: string; status: string };
  expect(evidenceRow).toEqual({ kind: 'execution-input-read-evidence', status: 'ready' });
  const content = await fixture.verifier.readVerifiedContent(fixture.projectId, bindingError.evidenceRef!);
  const evidence = validateExecutionInputReadEvidence(
    JSON.parse(Buffer.from(content.content).toString('utf8')),
  );
  expect(evidence.outcome).toBe('rejected');
  expect(evidence.reason).toBe(expected.reason);
  return evidence;
}

describe('P03-6 / F-002 不可变执行输入绑定', () => {
  it('[case:launch-receipt-binding] binds a frozen launch receipt and strictly validates its nested identity', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const launch = { sessionId: 'session-t-1-1', invocationId: bound.invocationId, parentSessionId: null };
    const input = fixture.bindingInput(bound, { claim: { ...bound.receipt, launch } });
    expect(validateExecutionInputBindingInput(input).claim.launch).toEqual(launch);
    const result = await fixture.bindingService.bind(input);
    expect(result.request).toMatchObject({ sessionId: launch.sessionId, invocationId: launch.invocationId });
    for (const invalid of [{ ...launch, credentials: 'forbidden' }, { ...launch, sessionId: '' },
      { ...launch, invocationId: 1 }, { ...launch, parentSessionId: {} },
      { ...launch, sessionId: 'different-session' }, { ...launch, invocationId: 'different-invocation' }]) {
      expect(() => validateExecutionInputBindingInput({ ...input, claim: { ...bound.receipt, launch: invalid } }))
        .toThrow(expect.objectContaining({ kind: 'validation' }));
    }
  });

  it('绑定成功：逐项身份核验、实际读取必需正文、发布按 Attempt 关联的读取证据并产出受限读取能力', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound));

    /* 请求终验：携带稳定 invocationId、work 身份、受控 cwd、有限政策。 */
    const request = validateRuntimeExecutionRequest(result.request);
    expect(request.projectId).toBe(fixture.projectId);
    expect(request.featureId).toBe(fixture.featureId);
    expect(request.invocationId).toBe(bound.invocationId);
    expect(request.identity).toEqual({
      purpose: 'work', runId: fixture.runId, taskId: 't-1', attemptId: bound.receipt.attempt.id,
    });
    expect(request.strategy).toEqual(FAKE_STRATEGY);
    expect(request.prompt.artifactId).toBe(bound.inputSnapshot.group.prompt.artifactId);
    expect(request.inputManifest.artifactId).toBe(bound.inputSnapshot.group.manifest.artifactId);
    expect(request.cwd.root).toBe('workspace-root');
    expect(request.cwd.relativePath).toBe('仓库 A 🚢');
    expect(request.recovery).toEqual({ mode: 'new' });

    /* 读取证据：三正文 + manifest 必需输入逐条实际读取，用途/摘要/字节/耗时齐全。 */
    expect(result.evidence.outcome).toBe('bound');
    expect(result.evidence.reason).toBeNull();
    expect(result.evidence.attemptId).toBe(bound.receipt.attempt.id);
    expect(result.evidence.reads.map((entry) => entry.purpose)).toEqual([
      'snapshot', 'manifest', 'prompt', 'requirements',
    ]);
    for (const entry of result.evidence.reads) {
      expect(entry.outcome).toBe('read');
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(Number.isSafeInteger(entry.durationMs)).toBe(true);
    }
    expect(result.evidence.totals.refCount).toBe(4);
    expect(result.evidence.totals.totalBytes).toBeGreaterThan(0);

    /* 证据已发布为同项目不可变制品，可经 verified 读回并通过契约校验。 */
    const evidenceContent = await fixture.verifier.readVerifiedContent(
      fixture.projectId, result.evidenceRef.artifactId,
    );
    const published = validateExecutionInputReadEvidence(
      JSON.parse(Buffer.from(evidenceContent.content).toString('utf8')),
    );
    expect(published.outcome).toBe('bound');
    expect(published.reads).toHaveLength(4);

    /* 受限读取能力：按用途读取正文且与发布内容一致；未绑定用途拒绝。 */
    expect(result.reader.list().map((ref) => ref.purpose)).toEqual([
      'snapshot', 'manifest', 'prompt', 'requirements',
    ]);
    const promptBody = await result.reader.read('prompt');
    expect(sha256(Buffer.from(promptBody.content))).toBe(
      bound.inputSnapshot.group.prompt.contentHash,
    );
    const requirement = await result.reader.read('requirements');
    expect(Buffer.from(requirement.content).toString('utf8')).toBe(fixture.requirementContent);
    await expect(result.reader.read('nonexistent-purpose')).rejects.toMatchObject({
      reason: 'unbound_input_read',
    });
    /* 受限读取能力不是业务库句柄：只有 list/read 两个入口。 */
    expect(Object.keys(result.reader).sort()).toEqual(['list', 'read']);
  });

  it('reader 的引用清单独立于证据对象，且重读拒绝 kind 漂移', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound));
    const exposed = result.evidence.boundInputs.find(ref => ref.purpose === 'requirements')!;
    (exposed as { artifactId: string }).artifactId = result.evidenceRef.artifactId;
    expect(Buffer.from((await result.reader.read('requirements')).content).toString('utf8'))
      .toBe(fixture.requirementContent);
    fixture.session.database.prepare("UPDATE artifacts SET kind = 'different' WHERE id = ?")
      .run(fixture.requirementArtifactId);
    await expect(result.reader.read('requirements')).rejects.toMatchObject({ reason: 'input_identity_mismatch' });
  });

  it('prompt 不全量内联历史与必需正文全文，完整 acceptance 逐条可读；修改可变来源/扩大 progress 不改变既有制品', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const promptPath = join(
      fixture.box.dataRoot,
      deriveArtifactFinalRelativePath({
        projectId: fixture.projectId,
        artifactId: bound.inputSnapshot.group.prompt.artifactId,
        locator: bound.inputSnapshot.group.prompt.locator,
      }),
    );
    const promptBefore = readFileSync(promptPath, 'utf8');
    /* 完整 acceptance 逐条进入 prompt；必需输入正文全文不内联（只有受管引用）。 */
    for (const criterion of ['验收条目甲：必须完整可读', '验收条目乙：不得删项']) {
      expect(promptBefore).toContain(criterion);
    }
    expect(promptBefore).not.toContain(fixture.requirementContent);
    const snapshotHashBefore = artifactFileHash(
      fixture,
      bound.inputSnapshot.group.snapshot.artifactId,
      bound.inputSnapshot.group.snapshot.locator,
    );

    /* 扩大可变来源：写入 progress/历史报告与新文件，修改既有文件。 */
    writeFileSync(
      join(fixture.box.repoDirA, 'progress.md'),
      'PROGRESS_MARKER_历史报告全文不得内联\n'.repeat(50),
    );
    appendFileSync(join(fixture.box.repoDirA, 'README.md'), '\n可变来源已被修改\n');

    const result = await fixture.bindingService.bind(fixture.bindingInput(bound));
    expect(result.evidence.outcome).toBe('bound');
    /* 既有制品逐字节不变（digest 稳定），prompt 不含可变来源文本。 */
    expect(artifactFileHash(
      fixture,
      bound.inputSnapshot.group.snapshot.artifactId,
      bound.inputSnapshot.group.snapshot.locator,
    )).toBe(snapshotHashBefore);
    const promptAfter = readFileSync(promptPath, 'utf8');
    expect(promptAfter).toBe(promptBefore);
    expect(promptAfter).not.toContain('PROGRESS_MARKER');
    expect(result.evidence.reads.find((entry) => entry.purpose === 'prompt')?.contentHash)
      .toBe(bound.inputSnapshot.group.prompt.contentHash);
  });

  it('不同 Task 使用独立输入/Session 上下文：受限读取能力不交叉', async () => {
    const firstFixture = await openBindingFixture();
    let secondFixture: BindingFixture | undefined;
    try {
      const boundOne = firstFixture.claimAndLaunch('t-1');
      const first = await firstFixture.bindingService.bind(firstFixture.bindingInput(boundOne));
      expect(first.request.sessionId).toBe('session-t-1-1');
      expect(first.reader.list().map((ref) => ref.purpose)).toEqual([
        'snapshot', 'manifest', 'prompt', 'requirements',
      ]);

      /* 独立真实 SQLite/文件上下文中的第二 Task，使用不同必需正文用途。 */
      secondFixture = await openBindingFixture({ secondTask: true });
      const boundTwo = secondFixture.claimAndLaunch('t-2');
      const second = await secondFixture.bindingService.bind(secondFixture.bindingInput(boundTwo));
      expect(second.request.sessionId).toBe('session-t-2-1');
      expect(second.request.identity).toMatchObject({ taskId: 't-2', attemptId: boundTwo.receipt.attempt.id });
      expect(second.reader.list().map((ref) => ref.purpose)).toEqual(['snapshot', 'manifest', 'prompt', 'spec']);
      const spec = await second.reader.read('spec');
      expect(Buffer.from(spec.content).toString('utf8')).toContain('任务二规格正文');
      await expect(second.reader.read('requirements')).rejects.toMatchObject({
        reason: 'unbound_input_read',
      });
      /* Task 一的受限 reader 仍只暴露 Task 一的 requirements。 */
      await expect(first.reader.read('spec')).rejects.toMatchObject({
        reason: 'unbound_input_read',
      });
      const body = await first.reader.read('requirements');
      expect(Buffer.from(body.content).toString('utf8')).toBe(firstFixture.requirementContent);
    } finally {
      secondFixture?.close();
      firstFixture.close();
    }
  });

  it.each([
    ['缺失', "DELETE FROM artifacts WHERE id = '@REQ@'", 'input_missing'],
    ['pending', "UPDATE artifacts SET status = 'pending' WHERE id = '@REQ@'", 'input_not_ready'],
    ['failed', "UPDATE artifacts SET status = 'failed' WHERE id = '@REQ@'", 'input_not_ready'],
    ['错误版本', 'UPDATE artifacts SET version = 7 WHERE id = \'@REQ@\'', 'input_version_mismatch'],
    ['索引身份漂移', 'UPDATE artifacts SET size_bytes = size_bytes + 1 WHERE id = \'@REQ@\'', 'input_identity_mismatch'],
    ['kind 漂移', "UPDATE artifacts SET kind = 'other-kind' WHERE id = '@REQ@'", 'input_identity_mismatch'],
  ])('必需输入%s明确失败且零代码/工具副作用', async (_label, sqlTemplate, reason) => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    fixture.session.database.exec(sqlTemplate.replaceAll('@REQ@', fixture.requirementArtifactId));
    const evidence = await expectRejection(
      fixture, fixture.bindingInput(bound), { kind: 'input', reason: reason as string },
    );
    /* 引用存在但未读取不记为已满足：requirements 读取项记录失败。 */
    const requirementRead = evidence.reads.find((entry) => entry.purpose === 'requirements');
    expect(requirementRead?.outcome).toBe('failed');
  });

  it('必需输入正文损坏（同长度篡改）与正文缺失明确失败', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const record = fixture.query(
      'SELECT storage_locator AS locator, size_bytes AS sizeBytes FROM artifacts WHERE id = ?',
      fixture.requirementArtifactId,
    ) as { locator: string; sizeBytes: number };
    const path = join(
      fixture.box.dataRoot,
      deriveArtifactFinalRelativePath({
        projectId: fixture.projectId,
        artifactId: fixture.requirementArtifactId,
        locator: record.locator,
      }),
    );
    /* 同长度篡改 → 实测摘要不符（hash_mismatch）。 */
    writeFileSync(path, Buffer.alloc(record.sizeBytes, 0x21));
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'input_corrupt' });
    /* 删除正文 → corrupt missing。 */
    rmSync(path);
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'input_corrupt' });
  });

  it('跨项目必需输入引用明确拒绝', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    /* 第二项目（真实行）后把必需输入制品行转移到另一项目（归属漂移）。 */
    fixture.session.database.prepare(
      "INSERT INTO projects (id, created_at, updated_at, revision, display_name, status) VALUES ('project-b', 1, 1, 1, 'B', 'active')",
    ).run();
    fixture.session.database.prepare(
      "UPDATE artifacts SET project_id = 'project-b' WHERE id = ?",
    ).run(fixture.requirementArtifactId);
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'input_cross_project' });
  });

  it('单项正文超过读取上限明确失败（有界 maxItemBytes）', async () => {
    const fixture = await setup({
      bindingLimits: {
        maxItemBytes: 10, maxTotalBytes: 8_388_608, maxRefCount: 260, maxReads: 512, maxReadDurationMs: 60_000,
      },
    });
    const bound = fixture.claimAndLaunch('t-1');
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'limit_exceeded' });
  });

  it('读取总字节超过上限明确失败（有界 maxTotalBytes）', async () => {
    const fixture = await setup({
      bindingLimits: {
        maxItemBytes: 1_048_576, maxTotalBytes: 100, maxRefCount: 260, maxReads: 512, maxReadDurationMs: 60_000,
      },
    });
    const bound = fixture.claimAndLaunch('t-1');
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'limit_exceeded' });
  });

  it('引用数量超过上限明确失败（有界 maxRefCount）', async () => {
    const fixture = await setup({
      bindingLimits: {
        maxItemBytes: 1_048_576, maxTotalBytes: 8_388_608, maxRefCount: 3, maxReads: 512, maxReadDurationMs: 60_000,
      },
    });
    const bound = fixture.claimAndLaunch('t-1');
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'limit_exceeded' });
  });

  it('读取耗时超过上限明确失败（有界 maxReadDurationMs，注入跳变时钟）', async () => {
    let tick = 1_000;
    const fixture = await setup({ bindingNowMs: () => (tick += 1_000_000) });
    const bound = fixture.claimAndLaunch('t-1');
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'limit_exceeded' });
  });

  it('并发 reader 读取仍受总字节上限约束', async () => {
    const maxTotalBytes = 100_000;
    const fixture = await setup({ bindingLimits: { maxItemBytes: 1_048_576, maxTotalBytes,
      maxRefCount: 260, maxReads: 512, maxReadDurationMs: 60_000 } });
    const bound = fixture.claimAndLaunch('t-1');
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound));
    const prompt = result.reader.list().find(ref => ref.purpose === 'prompt')!;
    const count = Math.floor((maxTotalBytes - result.evidence.totals.totalBytes) / prompt.sizeBytes) + 2;
    const reads = await Promise.allSettled(Array.from({ length: count }, () => result.reader.read('prompt')));
    const successes = reads.filter(read => read.status === 'fulfilled').length;
    expect(successes).toBeGreaterThan(0);
    expect(successes).toBeLessThan(count);
    expect(result.evidence.totals.totalBytes + successes * prompt.sizeBytes).toBeLessThanOrEqual(maxTotalBytes);
    for (const read of reads) {
      if (read.status === 'rejected') expect(read.reason).toMatchObject({ reason: 'limit_exceeded' });
    }
  });

  it('最后一个必需正文读取完成时超时也必须拒绝', async () => {
    let tick = BINDING_NOW;
    const fixture = await setup({ bindingNowMs: () => tick });
    const bound = fixture.claimAndLaunch('t-1');
    const original = fixture.verifier.readVerifiedContent.bind(fixture.verifier);
    vi.spyOn(fixture.verifier, 'readVerifiedContent').mockImplementation(async (projectId, artifactId) => {
      const content = await original(projectId, artifactId);
      if (artifactId === fixture.requirementArtifactId) tick += 60_001;
      return content;
    });
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'limit_exceeded' });
  });

  it('过期/伪造认领回执与未授权启动明确拒绝', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    /* 回执 runId 篡改：与权威 Attempt 不一致。 */
    const tampered = fixture.bindingInput(bound);
    (tampered['claim'] as { attempt: { runId: string } }).attempt.runId = 'run-forged';
    await expectRejection(fixture, tampered, { kind: 'input', reason: 'claim_identity_mismatch' });

    /* invocationId 不符（未授权启动身份）。 */
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { invocationId: 'invocation-forged' }),
      { kind: 'input', reason: 'attempt_not_current' },
    );
  });

  it('未 beginLaunch（无授权 invocationId）拒绝绑定', async () => {
    const fixture = await setup();
    const claimed = fixture.claimTask('t-1');
    await expectRejection(fixture, fixture.bindingInput(claimed), {
      kind: 'input', reason: 'attempt_not_current',
    });
  });

  it('同 Task 存在未停止活动 Attempt 一律拒绝重叠（存储防线之外的纵深复核）', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    /* 真实 SQLite 以部分唯一索引禁止第二活动 Attempt；此处以测试包装注入
       「防线被绕过」场景，绑定服务必须仍拒绝。 */
    const realAttempts = createSqliteAttemptAccess(fixture.session);
    const fakeActive = {
      ...bound.receipt.attempt,
      id: 'attempt-shadow', status: 'executing' as const,
    };
    const wrapped: AttemptStore = {
      ...realAttempts,
      listTaskAttempts: (projectId, taskId) => [
        ...realAttempts.listTaskAttempts(projectId, taskId),
        fakeActive,
      ],
    };
    const wrappedService = createExecutionInputBindingService({
      artifacts: fixture.artifacts,
      verifier: fixture.verifier,
      attempts: wrapped,
      resources: fixture.createResources(),
      workspaceAuthority: fixture.authority,
      workspaceRoots: { 'workspace-root': fixture.box.root },
      publisher: fixture.publisher,
    });
    await expect(wrappedService.bind(fixture.bindingInput(bound))).rejects.toMatchObject({
      kind: 'input', reason: 'overlap_active_attempt',
    });
  });

  it('cwd 根白名单、权限扩大与策略漂移逐项拒绝', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    await expectRejection(
      fixture, fixture.bindingInput(bound, { cwdRoot: 'unknown-root' }),
      { kind: 'workspace', reason: 'cwd_root_unknown' },
    );
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { permissions: { grants: ['fs.write'], isolation: 'trusted-project' } }),
      { kind: 'input', reason: 'permission_expansion' },
    );
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { strategy: { ...FAKE_STRATEGY, model: 'other-model' } }),
      { kind: 'input', reason: 'strategy_mismatch' },
    );
  });

  it('工作区符号链接越界（realpath 复核）明确拒绝', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const moved = `${fixture.box.repoDirA}-moved`;
    renameSync(fixture.box.repoDirA, moved);
    symlinkSync(fixture.box.homeDir, fixture.box.repoDirA);
    let thrown: unknown;
    try {
      await fixture.bindingService.bind(fixture.bindingInput(bound));
    } catch (error) {
      thrown = error;
    } finally {
      /* 恢复现场以便夹具清理。 */
      rmSync(fixture.box.repoDirA);
      renameSync(moved, fixture.box.repoDirA);
    }
    expect(isExecutionInputBindingError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ kind: 'workspace', reason: 'workspace_untrusted' });
    expect((thrown as { evidenceRef: string | null }).evidenceRef).not.toBeNull();
  });

  it('auto 恢复在能力未验证时显式降级 new 并记录来源与原因', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound, {
      recovery: { mode: 'auto', kind: 'conversation', source: recoverySource(fixture, bound, archive) },
    }));
    expect(result.request.recovery).toEqual({ mode: 'new' });
    expect(result.evidence.recovery).toEqual({
      selectionMode: 'auto',
      selectionKind: 'conversation',
      sourceArchiveArtifactId: archive.artifactId,
      decision: 'new',
      reasons: ['capabilities:unverified'],
    });
  });

  it('new 不能绕过旧 Attempt 仍持有的工作区占用', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    fixture.session.database.prepare(
      `INSERT INTO workspace_leases (id, created_at, project_id, revision, updated_at, resource_key,
        resource_kind, owner_kind, owner_id, host_instance_id, execution_version, state, lease_until, process_identity)
       VALUES ('lease-old-1', ?, ?, 1, ?, 'legacy-workspace', 'workspace', 'attempt', 'attempt-old-1',
         'host-1', 1, 'quarantined', ?, NULL)`,
    ).run(1_900_000_000_000, fixture.projectId, 1_900_000_000_000, 1_900_000_000_100);
    await expectRejection(fixture, fixture.bindingInput(bound),
      { kind: 'recovery', reason: 'source_occupancy_unresolved' });
  });

  it('恢复来源必须是同 Task 的直接上一 Attempt', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1', 89);
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-2', 90);
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, {
        recovery: { mode: 'auto', kind: 'conversation',
          source: recoverySource(fixture, bound, archive, { sourceAttemptId: 'attempt-old-1' }) },
      }),
      { kind: 'recovery', reason: 'recovery_source_invalid' },
    );
  });

  it('Fake 声明不支持原生续接时 auto 降级记录能力原因、required 明确拒绝', async () => {
    const fixture = await setup({ recoveryDescriptors: [descriptorWith(ALL_UNSUPPORTED)] });
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });
    const source = recoverySource(fixture, bound, archive);

    /* auto：显式降级 new，原因含具体能力状态。 */
    const autoResult = await fixture.bindingService.bind(fixture.bindingInput(bound, {
      recovery: { mode: 'auto', kind: 'conversation', source },
    }));
    expect(autoResult.request.recovery).toEqual({ mode: 'new' });
    expect(autoResult.evidence.recovery.decision).toBe('new');
    expect(autoResult.evidence.recovery.reasons).toEqual([
      'conversationResume:unsupported', 'nativeFork:unsupported',
    ]);

    /* required：明确拒绝，绝不降级。 */
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { recovery: { mode: 'required', kind: 'conversation', source } }),
      { kind: 'recovery', reason: 'recovery_rejected' },
    );
  });

  it('能力证据 verified 时 required 恢复携带已授权引用（不实现原生档案）', async () => {
    const authority = recoveryAuthority();
    const fixture = await setup({ recoveryDescriptors: [descriptorWith(CONVERSATION_VERIFIED)],
      recoverySources: authority.reader });
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });
    const source = recoverySource(fixture, bound, archive);
    await authority.authorize(fixture, bound, source);
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound, {
      recovery: { mode: 'required', kind: 'conversation', source },
    }));
    expect(result.request.recovery).toEqual({ mode: 'required', kind: 'conversation', source });
    expect(result.evidence.recovery.decision).toBe('resume');
    expect(result.evidence.recovery.reasons).toEqual([]);
    expect(result.evidence.reads.find(read => read.purpose === 'recovery-archive'))
      .toMatchObject({ artifactId: archive.artifactId, contentHash: archive.contentHash, outcome: 'read' });
    /* 同一来源停止状态变成 unknown，即使能力仍为 verified 也不得继续授权。 */
    authority.stopUnknown();
    await expectRejection(fixture, fixture.bindingInput(bound, {
      recovery: { mode: 'required', kind: 'conversation', source },
    }), { kind: 'recovery', reason: 'recovery_source_invalid' });
  });

  it('verified 能力缺少来源授权服务时拒绝携带恢复引用', async () => {
    const fixture = await setup({ recoveryDescriptors: [descriptorWith(CONVERSATION_VERIFIED)] });
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });
    await expectRejection(fixture, fixture.bindingInput(bound, {
      recovery: { mode: 'required', kind: 'conversation', source: recoverySource(fixture, bound, archive) },
    }), { kind: 'recovery', reason: 'recovery_source_invalid' });
  });

  it('恢复归档的实际正文损坏在 auto 降级前拒绝，并保存读取失败证据', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });
    const verified = await fixture.verifier.readVerifiedContent(fixture.projectId, archive.artifactId);
    writeFileSync(join(fixture.box.dataRoot, verified.relativePath), Buffer.alloc(archive.sizeBytes, 0x21));
    const evidence = await expectRejection(fixture, fixture.bindingInput(bound, {
      recovery: { mode: 'auto', kind: 'conversation', source: recoverySource(fixture, bound, archive) },
    }), { kind: 'recovery', reason: 'recovery_source_invalid' });
    expect(evidence.reads.find(read => read.purpose === 'recovery-archive'))
      .toMatchObject({ outcome: 'failed', detail: 'recovery_source_invalid' });
  });

  it('恢复来源内容/摘要/归属拒绝样例进入输入核验', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });

    /* 摘要与归档制品正文不符。 */
    const wrongDigest = recoverySource(fixture, bound, archive, { sourceDigest: sha256('tampered') });
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { recovery: { mode: 'auto', kind: 'conversation', source: wrongDigest } }),
      { kind: 'recovery', reason: 'recovery_source_invalid' },
    );

    /* 归档制品缺失。 */
    const missingArchive = recoverySource(fixture, bound, archive, { nativeArchiveRef: 'artifact-missing' });
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { recovery: { mode: 'auto', kind: 'conversation', source: missingArchive } }),
      { kind: 'recovery', reason: 'recovery_source_invalid' },
    );

    /* 来源 Attempt 不存在。 */
    const missingAttempt = recoverySource(fixture, bound, archive, { sourceAttemptId: 'attempt-missing' });
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { recovery: { mode: 'auto', kind: 'conversation', source: missingAttempt } }),
      { kind: 'recovery', reason: 'recovery_source_invalid' },
    );
  });

  it('恢复来源跨项目/跨用途/同 Attempt 在输入边界即拒绝（StorageError validation）', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    insertOldSucceededAttempt(fixture, bound, 'attempt-old-1');
    const archive = await publishReadyArtifact(fixture, {
      kind: 'native-archive', locator: 'native/old-session.json', content: '{"session":"old"}',
    });

    const cases: Record<string, unknown>[] = [
      recoverySource(fixture, bound, archive, { sourceProjectId: 'project-other' }),
      recoverySource(fixture, bound, archive, { purpose: 'chat', sourceTurnId: 'turn-1' }),
      recoverySource(fixture, bound, archive, { sourceAttemptId: bound.receipt.attempt.id }),
      recoverySource(fixture, bound, archive, { sourceTaskId: 't-other' }),
    ];
    for (const source of cases) {
      let thrown: unknown;
      try {
        await fixture.bindingService.bind(fixture.bindingInput(bound, {
          recovery: { mode: 'auto', kind: 'conversation', source },
        }));
      } catch (error) {
        thrown = error;
      }
      expect(isStorageError(thrown, 'validation')).toBe(true);
    }
  });

  it('证据形态校验：读回证据的边界校验拒绝畸形/未知原因', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound));
    const valid = JSON.parse(JSON.stringify(result.evidence)) as Record<string, unknown>;
    expect(() => validateExecutionInputReadEvidence(valid)).not.toThrow();
    expect(() => validateExecutionInputReadEvidence({ ...valid, outcome: 'maybe' }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateExecutionInputReadEvidence({ ...valid, reason: 'not-a-reason' }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
    expect(() => validateExecutionInputReadEvidence({ ...valid, extra: true }))
      .toThrowError(expect.objectContaining({ kind: 'validation' }));
  });
});

/**
 * P03-10 / F-010 输入装配历史增长与必需输入完整性确定性回归（T37 子集）。
 * 沿用本文件前序输入装配夹具（openBindingFixture/expectRejection/
 * publishReadyArtifact），不调用模型、不新增知识平台；只证明输入完整性与
 * 有界装配，不宣称缓存命中或 Token 节省。
 */
describe('P03-10 / F-010 输入完整性与历史增长阶段回归', () => {
  function artifactBody(fixture: BindingFixture, artifactId: string, locator: string): Buffer {
    return readFileSync(join(
      fixture.box.dataRoot,
      deriveArtifactFinalRelativePath({ projectId: fixture.projectId, artifactId, locator }),
    ));
  }

  it('[case:f010-input-manifest-evidence-digest-artifacts] Attempt InputManifest、读取证据与输入摘要关联真实制品；依赖结果与 acceptance 始终可读', async () => {
    const fixture = await setup({ secondTask: true, secondTaskDependsOnFirst: true });
    const bound = fixture.claimAndLaunch('t-1');
    const result = await fixture.bindingService.bind(fixture.bindingInput(bound));
    const attemptId = bound.receipt.attempt.id;

    /* InputManifest 是同项目 ready 制品，正文摘要可从实际文件复算，并绑定 prompt 摘要。 */
    const manifestRef = result.request.inputManifest;
    const manifestRow = fixture.query(
      'SELECT project_id AS projectId, kind, status, content_hash AS contentHash FROM artifacts WHERE id = ?',
      manifestRef.artifactId,
    ) as Record<string, string>;
    expect(manifestRow).toEqual({
      projectId: fixture.projectId,
      kind: 'execution-manifest',
      status: 'ready',
      contentHash: manifestRef.contentHash,
    });
    expect(artifactFileHash(fixture, manifestRef.artifactId, manifestRef.locator))
      .toBe(manifestRef.contentHash);
    const manifestBody = JSON.parse(
      Buffer.from((await fixture.verifier.readVerifiedContent(fixture.projectId, manifestRef.artifactId)).content)
        .toString('utf8'),
    ) as {
      promptDigest: string;
      sources: Array<{ sourceId: string; kind: string; hash: string; required: boolean }>;
    };
    /* manifest 的 promptDigest 与实际 prompt 制品字节的域分离摘要逐字节绑定。 */
    const promptFileText = artifactBody(
      fixture, result.request.prompt.artifactId, result.request.prompt.locator,
    ).toString('utf8');
    expect(manifestBody.promptDigest)
      .toBe(sha256(`${CONTEXT_PROMPT_DIGEST_DOMAIN}\n${promptFileText}`));
    expect(manifestBody.promptDigest).toBe(bound.inputSnapshot.digests.promptDigest);
    const requiredSources = manifestBody.sources.filter((source) => source.kind === 'required-input');
    expect(requiredSources.length).toBeGreaterThan(0);
    for (const source of requiredSources) {
      const artifactId = source.sourceId.slice('required-input:'.length);
      const row = fixture.query(
        'SELECT content_hash AS contentHash FROM artifacts WHERE id = ?', artifactId,
      ) as { contentHash: string };
      expect(source.hash).toBe(row.contentHash);
      expect(source.required).toBe(true);
    }

    /* 读取证据已发布为按 Attempt 关联的不可变制品，逐项摘要可从真实文件复算。 */
    const evidenceContent = await fixture.verifier.readVerifiedContent(
      fixture.projectId, result.evidenceRef.artifactId,
    );
    const published = validateExecutionInputReadEvidence(
      JSON.parse(Buffer.from(evidenceContent.content).toString('utf8')),
    );
    expect(published.attemptId).toBe(attemptId);
    expect(published.taskId).toBe('t-1');
    expect(published.outcome).toBe('bound');
    expect(published.reads.map((entry) => entry.purpose)).toEqual([
      'snapshot', 'manifest', 'prompt', 'requirements',
    ]);
    for (const entry of published.reads) {
      const ref = published.boundInputs.find((input) => input.purpose === entry.purpose);
      expect(ref).toBeDefined();
      expect(entry.outcome).toBe('read');
      expect(entry.contentHash).toBe(sha256(artifactBody(fixture, ref!.artifactId, ref!.locator)));
      expect(entry.sizeBytes).toBe(ref!.sizeBytes);
    }

    /* 输入摘要关联真实快照制品：attempts.input_digest/input_ref 与冻结身份一致。 */
    const attemptRow = fixture.query(
      'SELECT input_digest AS inputDigest, input_ref AS inputRef FROM attempts WHERE id = ?',
      attemptId,
    ) as { inputDigest: string; inputRef: string };
    expect(attemptRow.inputDigest).toBe(bound.inputSnapshot.digests.snapshotDigest);
    expect(attemptRow.inputRef).toBe(bound.inputSnapshot.group.snapshot.artifactId);
    expect(artifactFileHash(
      fixture,
      bound.inputSnapshot.group.snapshot.artifactId,
      bound.inputSnapshot.group.snapshot.locator,
    )).toBe(bound.inputSnapshot.group.snapshot.contentHash);

    /* 当前描述与全部 acceptance 在绑定后的 prompt/快照中始终可读。 */
    const snapshotBody = JSON.parse(
      Buffer.from((await fixture.verifier.readVerifiedContent(
        fixture.projectId, bound.inputSnapshot.group.snapshot.artifactId,
      )).content).toString('utf8'),
    ) as {
      task: {
        description: string | null;
        acceptance: { criteria: string[] };
        dependencies: Array<{ taskId: string; evidenceRefs: Array<{ artifactId: string }> }>;
      };
    };
    expect(snapshotBody.task.acceptance.criteria)
      .toEqual(['验收条目甲：必须完整可读', '验收条目乙：不得删项']);
    expect(snapshotBody.task.dependencies).toEqual([]);
    const promptText = Buffer.from((await result.reader.read('prompt')).content).toString('utf8');
    expect(promptText).toContain('- title: 绑定任务一');
    expect(promptText).toContain('- description: (none)');
    expect(promptText).toContain('[1] 验收条目甲：必须完整可读');
    expect(promptText).toContain('[2] 验收条目乙：不得删项');

    /* 依赖后继 Task（t-2，dependsOn t-1）的准备制品组：依赖结果与 acceptance
       始终可读，三正文均为关联真实文件的 ready 制品。 */
    const groupRow = (part: string): {
      artifactId: string; status: string; contentHash: string; locator: string;
    } => fixture.query(
      'SELECT id AS artifactId, status, content_hash AS contentHash, storage_locator AS locator ' +
        'FROM artifacts WHERE storage_locator = ?',
      `execution-input-groups/t-2/${part}`,
    ) as { artifactId: string; status: string; contentHash: string; locator: string };
    const dependentParts = [groupRow('snapshot'), groupRow('manifest'), groupRow('prompt')];
    for (const part of dependentParts) {
      expect(part.status).toBe('ready');
      expect(artifactFileHash(fixture, part.artifactId, part.locator)).toBe(part.contentHash);
    }
    const dependentSnapshot = JSON.parse(
      artifactBody(fixture, dependentParts[0].artifactId, dependentParts[0].locator).toString('utf8'),
    ) as {
      task: {
        acceptance: { criteria: string[] };
        dependencies: Array<{ taskId: string; evidenceRefs: Array<{ artifactId: string }> }>;
      };
    };
    expect(dependentSnapshot.task.acceptance.criteria).toEqual(['任务二验收']);
    expect(dependentSnapshot.task.dependencies).toEqual([
      { taskId: 't-1', evidenceRefs: [{ artifactId: fixture.requirementArtifactId }] },
    ]);
    const dependentPrompt = artifactBody(
      fixture, dependentParts[2].artifactId, dependentParts[2].locator,
    ).toString('utf8');
    expect(dependentPrompt).toContain('[1] 任务二验收');
    expect(dependentPrompt).toContain(`- task t-1: artifact ${fixture.requirementArtifactId}`);
    const dependentManifest = JSON.parse(
      artifactBody(fixture, dependentParts[1].artifactId, dependentParts[1].locator).toString('utf8'),
    ) as { promptDigest: string; sources: Array<{ kind: string; hash: string }> };
    expect(dependentManifest.promptDigest)
      .toBe(sha256(`${CONTEXT_PROMPT_DIGEST_DOMAIN}\n${dependentPrompt}`));
    expect(dependentManifest.sources.find((source) => source.kind === 'dependencies')?.hash)
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it('[case:f010-progress-report-growth-keeps-fixed-input] 显著增长 progress/报告与源路径内容变化不改变既有快照；可变路径不是固定执行输入', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    await fixture.bindingService.bind(fixture.bindingInput(bound));
    const group = bound.inputSnapshot.group;
    const bodyBefore = {
      snapshot: artifactBody(fixture, group.snapshot.artifactId, group.snapshot.locator),
      manifest: artifactBody(fixture, group.manifest.artifactId, group.manifest.locator),
      prompt: artifactBody(fixture, group.prompt.artifactId, group.prompt.locator),
    };

    /* 小历史状态 → 显著增长的 progress/报告夹具 + 源路径内容改变。 */
    mkdirSync(join(fixture.box.repoDirA, 'requirements'), { recursive: true });
    writeFileSync(
      join(fixture.box.repoDirA, 'progress.md'),
      'PROGRESS_GROWTH_MARK 历史进度全文不得内联\n'.repeat(300),
    );
    appendFileSync(join(fixture.box.repoDirA, 'README.md'), '\nREPORT_GROWTH_MARK 可变来源增长\n');
    writeFileSync(
      join(fixture.box.repoDirA, 'requirements', 'task-1.md'),
      'SOURCE_PATH_CHANGED 源路径内容已改变',
    );
    for (let index = 0; index < 20; index += 1) {
      await publishReadyArtifact(fixture, {
        kind: 'execution-report',
        locator: `reports/report-${index}.json`,
        content: JSON.stringify({ mark: `REPORT_GROWTH_MARK_${index}`, body: 'x'.repeat(20_000) }),
      });
    }

    const again = await fixture.bindingService.bind(fixture.bindingInput(bound));
    expect(again.evidence.outcome).toBe('bound');
    /* 既有 snapshot/manifest/prompt 逐字节不变，冻结摘要与读取证据一致。 */
    for (const key of ['snapshot', 'manifest', 'prompt'] as const) {
      expect(artifactBody(fixture, group[key].artifactId, group[key].locator).equals(bodyBefore[key]))
        .toBe(true);
    }
    expect(again.evidence.reads.find((entry) => entry.purpose === 'prompt')?.contentHash)
      .toBe(group.prompt.contentHash);
    /* 增长的 progress/报告正文零内联（动态内容只经不可变引用/摘要提供）。 */
    for (const key of ['snapshot', 'manifest', 'prompt'] as const) {
      const text = bodyBefore[key].toString('utf8');
      expect(text).not.toContain('PROGRESS_GROWTH_MARK');
      expect(text).not.toContain('REPORT_GROWTH_MARK');
      expect(text).not.toContain('SOURCE_PATH_CHANGED');
    }
    /* 可变路径不是固定执行输入：受限读取返回固定正文，而非源路径新内容。 */
    const requirement = await again.reader.read('requirements');
    expect(Buffer.from(requirement.content).toString('utf8')).toBe(fixture.requirementContent);
    expect(Buffer.from(requirement.content).toString('utf8')).not.toContain('SOURCE_PATH_CHANGED');
    const requirementRow = fixture.query(
      'SELECT content_hash AS contentHash FROM artifacts WHERE id = ?', fixture.requirementArtifactId,
    ) as { contentHash: string };
    expect(sha256(Buffer.from(requirement.content))).toBe(requirementRow.contentHash);
    /* acceptance 完整未截断。 */
    expect(bodyBefore.prompt.toString('utf8')).toContain('## Acceptance (required; complete; 不得删项)');
    expect(bodyBefore.prompt.toString('utf8')).toContain('[1] 验收条目甲：必须完整可读');
    expect(bodyBefore.prompt.toString('utf8')).toContain('[2] 验收条目乙：不得删项');
  });

  it('[case:f010-required-input-missing-or-corrupt-rejected] 必需输入损坏/缺失启动被拒绝并给出明确原因；不静默截断 acceptance', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    const group = bound.inputSnapshot.group;
    const record = fixture.query(
      'SELECT storage_locator AS locator, size_bytes AS sizeBytes FROM artifacts WHERE id = ?',
      fixture.requirementArtifactId,
    ) as { locator: string; sizeBytes: number };
    const path = join(
      fixture.box.dataRoot,
      deriveArtifactFinalRelativePath({
        projectId: fixture.projectId, artifactId: fixture.requirementArtifactId, locator: record.locator,
      }),
    );
    const original = readFileSync(path);
    const snapshotBefore = artifactBody(fixture, group.snapshot.artifactId, group.snapshot.locator);

    /* 同长度篡改 → input_corrupt（拒绝证据按 Attempt 保留，原因明确）。 */
    writeFileSync(path, Buffer.alloc(record.sizeBytes, 0x21));
    const corruptEvidence = await expectRejection(
      fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'input_corrupt' },
    );
    expect(corruptEvidence.reads.find((entry) => entry.purpose === 'requirements')?.outcome)
      .toBe('failed');

    /* 恢复正文后删除制品行 → input_missing（缺失不被静默省略）。 */
    writeFileSync(path, original);
    fixture.session.database.prepare('DELETE FROM artifacts WHERE id = ?').run(fixture.requirementArtifactId);
    await expectRejection(fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'input_missing' });

    /* 拒绝不改写固定输入：既有快照逐字节不变、acceptance 仍完整。 */
    expect(artifactBody(fixture, group.snapshot.artifactId, group.snapshot.locator).equals(snapshotBefore))
      .toBe(true);
    expect(snapshotBefore.toString('utf8')).toContain('验收条目甲：必须完整可读');
    expect(snapshotBefore.toString('utf8')).toContain('验收条目乙：不得删项');
  });

  it('[case:f010-path-escape-and-permission-expansion-rejected] 受控路径越界与读取权限扩大启动被拒绝：明确原因、零副作用', async () => {
    const fixture = await setup();
    const bound = fixture.claimAndLaunch('t-1');
    /* cwd 根不在获准白名单 → cwd_root_unknown。 */
    await expectRejection(
      fixture, fixture.bindingInput(bound, { cwdRoot: 'unknown-root' }),
      { kind: 'workspace', reason: 'cwd_root_unknown' },
    );
    /* 读取/执行权限扩大 → permission_expansion（不扩大读取权限）。 */
    await expectRejection(
      fixture,
      fixture.bindingInput(bound, { permissions: { grants: ['fs.write'], isolation: 'trusted-project' } }),
      { kind: 'input', reason: 'permission_expansion' },
    );
    /* 工作区符号链接越界（realpath 复核）→ workspace_untrusted。 */
    const moved = `${fixture.box.repoDirA}-moved`;
    renameSync(fixture.box.repoDirA, moved);
    symlinkSync(fixture.box.homeDir, fixture.box.repoDirA);
    let thrown: unknown;
    try {
      await fixture.bindingService.bind(fixture.bindingInput(bound));
    } catch (error) {
      thrown = error;
    } finally {
      /* 恢复现场以便夹具清理。 */
      rmSync(fixture.box.repoDirA);
      renameSync(moved, fixture.box.repoDirA);
    }
    expect(isExecutionInputBindingError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ kind: 'workspace', reason: 'workspace_untrusted' });
    expect((thrown as { evidenceRef: string | null }).evidenceRef).not.toBeNull();
  });

  it('[case:f010-required-input-budget-rejected] 超出必需输入读取预算启动被拒绝（有界 limit_exceeded）', async () => {
    const fixture = await setup({
      bindingLimits: {
        maxItemBytes: 1_048_576, maxTotalBytes: 100, maxRefCount: 260,
        maxReads: 512, maxReadDurationMs: 60_000,
      },
    });
    const bound = fixture.claimAndLaunch('t-1');
    await expectRejection(
      fixture, fixture.bindingInput(bound), { kind: 'input', reason: 'limit_exceeded' },
    );
  });
});
