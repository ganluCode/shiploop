/**
 * P05-1 / F-006 规划候选受限工具提交与受管 Artifact 发布（Core 工具通道纵向）。
 *
 * 全真实资源（真实 SQLite/Git/制品文件；不调用付费模型）。覆盖：
 * - 受限操作贯通：有界正史入口 → F-001 候选校验 → 受控暂存发布为受管 Artifact →
 *   规划上下文单候选绑定 + 持久回执；提交不代表批准（verificationPassed=false）；
 * - 提交前/发布后短事务重核：撤权、取消、旧执行版本、越权/操作未授予、
 *   Run purpose 与 planning Task 绑定漂移均拒绝且零写入；
 * - 单候选与稳定重放：同命令同内容重放复用持久结果（不新增有效 Artifact/回执）；
 *   同命令异内容 conflict；已发布后替换企图明确 conflict；双提交竞争恰好一份
 *   副作用；发布中撤权保留 Artifact 事实且不绑定不落回执；原候选被破坏后重放
 *   稳定、不盲目发布第二份；
 * - 非法输入：非法 JSON/超限/非法 DAG（环）/跨项目引用拒绝为不可审批诊断回执，
 *   规划上下文保持 open（失败后仍可提交有效候选）；
 * - 权限隔离：无文件路径/数据库入口；模型凭据不能调用计划批准、execution.start、
 *   预算/锁/通过标记或任意 SQL；既有 candidate.submit/evidence.submit 操作身份
 *   保持兼容（工作工具面新增操作不影响用户命令白名单）。
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { WORK_TOOL_OPERATION_SPECS } from '../../../packages/core/src/ports/commands.ts';
import { PLANNING_CANDIDATE_SUBMIT_OPERATION } from '../../../packages/core/src/ports/planning-candidates.ts';
import { validateWireCommandReceipt } from '../../../packages/core/src/ports/command-receipts.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { openPlanningSubmitFixture, SUBMIT_NOW } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';
import type { PlanningSubmitFixture } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';

let fixture: PlanningSubmitFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const open = () => openPlanningSubmitFixture();

type Row = Record<string, unknown>;

function planningArtifacts(f: PlanningSubmitFixture): Row[] {
  return ((f.snapshot().artifacts ?? []) as Row[]).filter(row => row.kind === 'planning-candidate');
}

function receipts(f: PlanningSubmitFixture): Row[] {
  return ((f.snapshot().command_receipts ?? []) as Row[])
    .filter(row => row.operation === PLANNING_CANDIDATE_SUBMIT_OPERATION);
}

/** 收窄为完成回执（工作工具面不产生 accepted；测试断言前置）。 */
function asCompleted(receipt: CommandReceipt): CommandReceipt & { status: 'completed'; result: Record<string, unknown> } {
  if (receipt.status !== 'completed') throw new Error(`expected completed receipt: ${JSON.stringify(receipt)}`);
  return receipt as CommandReceipt & { status: 'completed'; result: Record<string, unknown> };
}

/** 收窄为拒绝回执。 */
function asRejected(receipt: CommandReceipt): CommandReceipt & { status: 'rejected'; error: { details?: { reason?: string } } } {
  if (receipt.status !== 'rejected') throw new Error(`expected rejected receipt: ${JSON.stringify(receipt)}`);
  return receipt as unknown as CommandReceipt & { status: 'rejected'; error: { details?: { reason?: string } } };
}

async function invoke(f: PlanningSubmitFixture, request: Record<string, unknown>): Promise<CommandReceipt> {
  const result = await f.bridge.invoke(request);
  if (!('status' in result) || result.operation !== PLANNING_CANDIDATE_SUBMIT_OPERATION) {
    throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
  }
  return result as CommandReceipt;
}

describe('P05-1 / F-006 规划候选受限提交', () => {
  it('[case:submit-publish] 有效候选发布为受管 Artifact 并绑定单候选；同命令重放复用持久结果', async () => {
    const f = fixture = await open();
    const request = f.request();
    const receipt = asCompleted(await invoke(f, request));
    // 回执：完成、绑定身份、验证不通过（提交 ≠ 批准）。
    expect(receipt).toMatchObject({ status: 'completed', operation: PLANNING_CANDIDATE_SUBMIT_OPERATION });
    expect(validateWireCommandReceipt(receipt, 'test')).toEqual(receipt);
    const result = receipt.result;
    expect(result.verificationPassed).toBe(false);
    expect(result.publication).toBe('published');
    expect(typeof result.candidateDigest).toBe('string');
    // 制品：恰好一份 planning-candidate，ready 且 hash/size 与正文一致。
    const artifacts = planningArtifacts(f);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0] as Record<string, unknown>;
    expect(artifact.status).toBe('ready');
    expect(artifact.content_hash).toBe(
      (await import('node:crypto')).createHash('sha256')
        .update((request.payload as { candidate: string }).candidate, 'utf8').digest('hex'),
    );
    expect(result.artifact).toMatchObject({ artifactId: artifact.id });
    // 规划上下文：单候选绑定（摘要与制品一致），状态 candidate_published。
    const context = f.planningContext();
    expect(context.status).toBe('candidate_published');
    expect(context.candidate_artifact_id).toBe(artifact.id);
    expect(context.candidate_digest).toBe(result.candidateDigest);
    expect(receipts(f)).toHaveLength(1);
    // 重放：同命令同内容复用持久回执；无新增 Artifact/回执/上下文事件。
    const before = f.snapshot();
    const replay = await invoke(f, request);
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(f.snapshot()).toEqual(before);
  });

  it('[case:invalid-diagnostics] 非法 JSON/超限/环/跨项目/身份漂移拒绝为不可审批诊断，上下文保持 open', async () => {
    const f = fixture = await open();
    const cases: Array<{ name: string; candidate: () => string; reason: string }> = [
      { name: 'invalid-json', candidate: () => '{"broken": ', reason: 'candidate_json_invalid' },
      {
        name: 'oversize',
        candidate: () => JSON.stringify({ schemaVersion: 1, padding: 'x'.repeat(1_100_000) }),
        reason: 'candidate_body_too_large',
      },
      {
        name: 'dag-cycle',
        candidate: () => f.candidateBody({
          plan: {
            schemaVersion: 1,
            feature: { title: '环计划', description: null, labels: [], sourceRefs: [] },
            tasks: [
              { id: 'a', title: 'A', acceptance: { criteria: ['a'] }, dependsOn: ['b'] },
              { id: 'b', title: 'B', acceptance: { criteria: ['b'] }, dependsOn: ['a'] },
            ],
          },
        }),
        reason: 'candidate_invalid',
      },
      {
        name: 'cross-project',
        candidate: () => f.candidateBody({ projectId: randomUUID() }),
        reason: 'candidate_identity_mismatch',
      },
      {
        name: 'foreign-candidate-id',
        candidate: () => f.candidateBody({ candidateId: randomUUID() }),
        reason: 'candidate_identity_mismatch',
      },
    ];
    for (const item of cases) {
      if (item.name === 'oversize') {
        // 超限在信封载荷层拒绝（未落任何事实）。
        const before = f.snapshot();
        await expect(f.bridge.invoke(f.request({ candidate: item.candidate() })))
          .rejects.toMatchObject({ code: 'invalid_input', details: { reason: item.reason } });
        expect(f.snapshot()).toEqual(before);
        continue;
      }
      const request = f.request({ candidate: item.candidate() });
      const receipt = asRejected(await invoke(f, request));
      expect(receipt.status, item.name).toBe('rejected');
      const reason = receipt.error.details?.reason ?? '';
      expect(reason.startsWith(item.reason), `${item.name}: ${reason}`).toBe(true);
      // 失败输出保留为不可审批诊断：持久回执 + 零 Artifact + 上下文仍 open。
      expect(planningArtifacts(f), item.name).toHaveLength(0);
      expect(f.planningContext().status).toBe('open');
      const replay = await invoke(f, request);
      expect(replay).toEqual({ ...receipt, replayed: true });
      expect(receipts(f).length).toBeLessThanOrEqual(cases.length);
    }
    expect(receipts(f)).toHaveLength(4); // 4 个落回执的诊断（超限不落）
    // 失败后仍可提交有效候选（单候选槽位未被失败消耗）。
    const valid = await invoke(f, f.request());
    expect(valid.status).toBe('completed');
    expect(f.planningContext().status).toBe('candidate_published');
  });

  it('[case:conflicts] 同命令异内容 conflict；已发布后替换企图明确冲突且零新增副作用', async () => {
    const f = fixture = await open();
    const request = f.request();
    const first = asCompleted(await invoke(f, request));
    expect(first.status).toBe('completed');
    // 同命令不同内容：摘要不一致 → conflict，无写入。
    const before = f.snapshot();
    await expect(invoke(f, f.request({ commandId: first.commandId, candidate: f.candidateBody({ summary: '替换内容' }) })))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(f.snapshot()).toEqual(before);
    // 新命令替换已发布候选 → 明确 conflict（不发布第二份 Artifact）。
    await expect(invoke(f, f.request({ candidate: f.candidateBody({ summary: '第二个候选' }) })))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'candidate_already_published' } });
    expect(planningArtifacts(f)).toHaveLength(1);
    expect(f.planningContext().candidate_digest).toBe(first.result.candidateDigest);
    // 原命令原内容重放仍稳定返回原回执。
    const replay = await invoke(f, request);
    expect(replay).toEqual({ ...first, replayed: true });
  });

  it('[case:authority-recheck] 提交前/发布后重核撤权、取消、旧版本、用途漂移与操作未授予均拒绝', async () => {
    const f = fixture = await open();
    // 操作未授予（grant 只含规划提交；artifactId 型载荷到达授权层后被拒）。
    const limited = f.bindBridge({ operations: ['planning.candidate.submit'] });
    const artifactPayload = { identity: f.binding.identity, invocationId: f.invocationId, executionVersion: f.executionVersion, artifactId: randomUUID() };
    await expect(limited.invoke(f.request({ operation: 'candidate.submit', payload: artifactPayload })))
      .rejects.toMatchObject({ code: 'forbidden', details: { reason: 'operation_denied' } });
    // 未装配规划发布依赖的通道 fail-closed。
    expect(() => f.bindBridge({ withPlanning: false })).toThrow();
    // Run purpose 漂移（测试注入：临时禁用不可变触发器把 purpose 改成 execute；
    // 生产路径不可达，用于重核分支覆盖；测试后还原并恢复触发器）。
    const asExecute = f.request();
    f.session.database.exec('DROP TRIGGER runs_immutable_columns_update');
    try {
      f.session.database.prepare("UPDATE runs SET purpose = 'execute' WHERE id = ?").run(f.runId);
      await expect(f.bridge.invoke(asExecute)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'identity_mismatch' } });
    } finally {
      f.session.database.prepare("UPDATE runs SET purpose = 'plan' WHERE id = ?").run(f.runId);
      f.session.database.exec("CREATE TRIGGER runs_immutable_columns_update BEFORE UPDATE ON runs\n"
        + "WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.project_id IS NOT OLD.project_id\n"
        + "  OR NEW.batch_id IS NOT OLD.batch_id OR NEW.feature_id IS NOT OLD.feature_id\n"
        + "  OR NEW.purpose IS NOT OLD.purpose OR NEW.input_snapshot IS NOT OLD.input_snapshot\n"
        + "  OR NEW.config_snapshot IS NOT OLD.config_snapshot OR NEW.scope_digest IS NOT OLD.scope_digest\n"
        + "  OR NEW.work_key IS NOT OLD.work_key OR NEW.dispatch_ordinal IS NOT OLD.dispatch_ordinal\n"
        + "  OR NEW.max_attempts_per_run IS NOT OLD.max_attempts_per_run OR NEW.run_time_limit_ms IS NOT OLD.run_time_limit_ms\n"
        + "  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)\n"
        + "BEGIN\n"
        + "  SELECT RAISE(ABORT, 'runs immutable input, dispatch identity and time basis columns cannot be updated');\n"
        + "END;");
    }
    // 旧执行版本。
    await expect(f.bridge.invoke(f.request({ payload: {
      identity: f.binding.identity, invocationId: f.invocationId, executionVersion: f.executionVersion + 5,
      candidate: f.candidateBody(),
    } }))).rejects.toMatchObject({ code: 'forbidden' });
    // 上下文取消后提交（测试注入终态；F-009 接线生产路径）。
    f.session.database.prepare("UPDATE planning_contexts SET status = 'cancelled' WHERE run_id = ?").run(f.runId);
    await expect(f.bridge.invoke(f.request())).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'planning_cancelled' } });
    f.session.database.prepare("UPDATE planning_contexts SET status = 'open' WHERE run_id = ?").run(f.runId);
    // 撤权（提交前）。
    f.setCurrent(null);
    await expect(f.bridge.invoke(f.request())).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'grant_revoked' } });
    f.setCurrent(f.binding);
    // 全部拒绝路径零写入。
    expect(planningArtifacts(f)).toHaveLength(0);
    expect(receipts(f)).toHaveLength(0);
    expect(f.planningContext().status).toBe('open');
  });

  it('[case:revoke-after-publish] 发布后短事务重核撤权：保留 Artifact 事实、不绑定、不落回执', async () => {
    let published = 0;
    let revokeOnce = false;
    const f = fixture = await openPlanningSubmitFixture({
      wrapPublisher: publisher => ({
        publishArtifact: async (input: unknown) => {
          const result = await publisher.publishArtifact(input);
          published += 1;
          if (!revokeOnce) {
            revokeOnce = true;
            fixture?.setCurrent(null); // 首次发布完成后、最终短事务前撤权
          }
          return result;
        },
      }),
    });
    await expect(f.bridge.invoke(f.request())).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'grant_revoked' } });
    expect(published).toBe(1);
    // 事实保留：Artifact 已 ready（未绑定）；上下文 open；无回执。
    const artifacts = planningArtifacts(f);
    expect(artifacts).toHaveLength(1);
    expect((artifacts[0] as { status: string }).status).toBe('ready');
    expect(f.planningContext().status).toBe('open');
    expect(receipts(f)).toHaveLength(0);
    // 恢复授权后重试（新命令）：不盲目依赖旧未绑定制品，重新发布并恰好绑定一份。
    f.setCurrent(f.binding);
    const retry = asCompleted(await invoke(f, f.request()));
    expect(retry.status).toBe('completed');
    expect(planningArtifacts(f)).toHaveLength(2); // 前次中断事实保留 + 本次有效发布
    expect(f.planningContext().status).toBe('candidate_published');
    expect(f.planningContext().candidate_artifact_id)
      .toBe((retry.result.artifact as { artifactId: string }).artifactId);
  });

  it('[case:double-submit-race] 同命令同内容并发提交恰好一份副作用与一条持久回执', async () => {
    let releasePublication: (() => void) | undefined;
    const f = fixture = await openPlanningSubmitFixture({
      wrapPublisher: publisher => ({
        publishArtifact: async (input: unknown) => {
          const result$ = publisher.publishArtifact(input);
          await new Promise<void>(resolve => { releasePublication = resolve; });
          return result$;
        },
      }),
    });
    const request = f.request();
    const first = f.bridge.invoke(request);
    // 首个提交停在发布阶段；并发第二个同命令同内容提交必须共享同一执行。
    await vi.waitFor(() => expect(releasePublication).toBeDefined());
    const second = f.bridge.invoke(request);
    releasePublication!();
    const [a, b] = await Promise.all([first, second]);
    const receipt = a as CommandReceipt;
    expect(receipt.status).toBe('completed');
    expect(b).toEqual(a); // 同一持久回执（共享执行，不产生第二条副作用）
    expect(planningArtifacts(f)).toHaveLength(1);
    expect(receipts(f)).toHaveLength(1);
    expect(f.planningContext().status).toBe('candidate_published');
  });

  it('[case:candidate-destroyed] 原候选被破坏后重放稳定返回持久回执，不重复发布或替换', async () => {
    const f = fixture = await open();
    const request = f.request();
    const receipt = asCompleted(await invoke(f, request));
    const artifactId = (receipt.result.artifact as { artifactId: string }).artifactId;
    // 破坏正式文件（保留索引行；损坏检测属 F-012 范畴）。
    const placement = f.files.resolvePlacement({ projectId: f.projectId, artifactId, locator: 'unused' });
    rmSync(join(f.dataRoot, placement.finalRelativePath));
    const before = f.snapshot();
    const replay = await invoke(f, request);
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(f.snapshot()).toEqual(before); // 重放不触文件、不新增事实
    // 新命令不能借破坏替换候选。
    await expect(invoke(f, f.request())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'candidate_already_published' } });
    expect(planningArtifacts(f)).toHaveLength(1);
  });

  it('[case:no-file-or-sql-entry] 无文件路径/SQL/管理命令入口；用户命令白名单未扩展', async () => {
    const f = fixture = await open();
    const before = f.snapshot();
    // 载荷不接受 path/sql/artifactId 等未知键。
    for (const extra of [{ path: '/etc/passwd' }, { sql: 'SELECT * FROM planning_contexts' }, { artifactId: randomUUID() }]) {
      await expect(f.bridge.invoke(f.request({ payload: {
        identity: f.binding.identity, invocationId: f.invocationId, executionVersion: f.executionVersion,
        candidate: f.candidateBody(), ...extra,
      } }))).rejects.toThrow();
    }
    // 正文必须是 JSON 字符串（非字符串拒绝）。
    await expect(f.bridge.invoke(f.request({ payload: {
      identity: f.binding.identity, invocationId: f.invocationId, executionVersion: f.executionVersion,
      candidate: 123,
    } }))).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'candidate_body_invalid' } });
    // 模型凭据不能调用管理操作（信封层即拒绝）。
    for (const operation of ['feature.plan.decide', 'execution.start', 'execution.budget.revise',
      'locks.update', 'workspace.release', 'task.pass', 'sql.query', 'planning.candidate.submit:x']) {
      await expect(f.bridge.invoke(f.request({ operation }))).rejects.toThrow();
    }
    // planning.candidate.submit 不是用户命令（validateCommandEnvelope 拒绝）；既有工作操作身份不变。
    expect(() => validateCommandEnvelope(f.request())).toThrow();
    for (const operation of ['candidate.submit', 'evidence.submit', 'task.read', 'planning.candidate.submit']) {
      expect(WORK_TOOL_OPERATION_SPECS[operation as keyof typeof WORK_TOOL_OPERATION_SPECS])
        .toEqual({ scopeKind: 'project', mutation: 'create', capability: 'project.read' });
    }
    expect(f.snapshot()).toEqual(before);
  });

  it('[case:compat-existing-ops] 既有 candidate.submit/evidence.submit 语义保持（不同入口互不混用）', async () => {
    const f = fixture = await open();
    // 规划 grant 未授予测试候选/证据操作 → 拒绝且零写入（载荷按各操作自身形状）。
    const artifactPayload = { identity: f.binding.identity, invocationId: f.invocationId, executionVersion: f.executionVersion, artifactId: randomUUID() };
    await expect(f.bridge.invoke(f.request({ operation: 'candidate.submit', payload: artifactPayload }))).rejects
      .toMatchObject({ code: 'forbidden', details: { reason: 'operation_denied' } });
    await expect(f.bridge.invoke(f.request({ operation: 'evidence.submit', payload: artifactPayload }))).rejects
      .toMatchObject({ code: 'forbidden', details: { reason: 'operation_denied' } });
    // 规划提交不接受 artifactId 载荷（与既有 artifactId 入口区分）。
    await expect(f.bridge.invoke(f.request({ payload: {
      identity: f.binding.identity, invocationId: f.invocationId, executionVersion: f.executionVersion,
      artifactId: randomUUID(),
    } }))).rejects.toThrow();
    expect(planningArtifacts(f)).toHaveLength(0);
    expect(receipts(f)).toHaveLength(0);
  });

  it('[case:lease-and-timing] 租约到期与过期命令拒绝（不产生任何写入）', async () => {
    const f = fixture = await open();
    // 命令过期（issuedAt 远早于当前绑定时刻）。
    const stale = { ...f.request(), issuedAt: new Date(SUBMIT_NOW - 10 * 60_000).toISOString() };
    await expect(f.bridge.invoke(stale)).rejects.toMatchObject({ code: 'command_expired' });
    // 租约到期（测试注入过去租约）。
    f.session.database.prepare('UPDATE attempts SET lease_until = ? WHERE id = ?').run(SUBMIT_NOW - 1, f.attemptId);
    await expect(f.bridge.invoke(f.request())).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'execution_inactive' } });
    expect(planningArtifacts(f)).toHaveLength(0);
    expect(receipts(f)).toHaveLength(0);
  });
});
