/**
 * P07-1 / F-001 真实 Host 故障屏障夹具（父进程侧，仅测试使用，不进 packages/）。
 *
 * 复用既有隔离 Host 环境（helpers/host）、真实临时 Git/SQLite（p02-2/p03-6
 * 绑定夹具）与受管子进程屏障协议（managed-child），组装三类确定性边界场景：
 *
 * - Runner 边界：受控工具进程持续写 heartbeat + worker.pid，证明「Runner 正在
 *   写入」；不以固定 sleep 或状态轮询代替写入证据；
 * - Verifier 边界：真实检查命令进程自写启动标记并可被 hold 屏障，证明
 *   「真实 Verifier 命令已启动」而批次尚未定版；
 * - Git 提交边界：条件 post-commit 钩子（可信测试故障点）在真实 commit 落盘
 *   后阻塞回执事务，证明「Git 副作用已发生但业务回执尚未持久化」。
 *
 * 证据采集：每个场景按「故障前/故障后」两拍采集结构化快照（实体身份、进程
 * 身份、Git HEAD/tree 与 tracked/untracked 摘要、operation/回执、预算），绑定
 * 场景名与受测代码版本（仓库 HEAD + Node 版本），落盘 JSONL；断言不依赖日志
 * 成功文本。
 *
 * 清理纪律：先移除 hold 屏障放行等待方，再有限回收受控子进程；finally 以
 * 进程普查核验本次受控进程树缺席后才清理临时根；无法确认缺席时返回
 * cleanup_unconfirmed 并保留现场，不因业务断言通过而吞掉。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManagedChild } from '../host/index.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from '../host/isolated-environment.ts';
import { openBindingFixture, type BindingFixture } from '../p03-6/input-binding-fixture.ts';
import { git } from '../git-repo.ts';
import { processRows } from '../process-matrix.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';

export const HOST_CHILD = fileURLToPath(new URL('./fault-barrier-host-child.ts', import.meta.url));
export const CHECK_RUNNER = fileURLToPath(new URL('./check-runner.mjs', import.meta.url));

/** Runtime 写入并交由真实 Verifier 校验的目标（worktree 相对路径）。 */
export const RUNTIME_TARGET = { path: 'src/p07-marker.ts', content: 'export const p07F001Marker = 1;\n' } as const;

const WORKER_SCRIPT = [
  "const fs=require('node:fs')",
  "fs.writeFileSync('worker.pid',String(process.pid))",
  "process.on('SIGTERM',()=>{})",
  "fs.appendFileSync('heartbeat.txt','x')",
  "setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),20)",
].join(';');

const GIT_HOOK = [
  '#!/bin/sh',
  '# P07-1 / F-001 test fault point: after the real task commit is durable,',
  '# block the driver return (and therefore the receipt transaction) while the',
  '# hold file exists. Bounded by a finite wait; exits 0 either way.',
  'common_dir=$(git rev-parse --git-common-dir)',
  'marker="$common_dir/p07-1-git-barrier.json"',
  'hold="$common_dir/p07-1-git-hold"',
  'if [ -f "$hold" ]; then',
  '  printf \'{"pid":%s,"head":"%s","startedAt":"%s"}\\n\' "$$" "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"',
  '  i=0',
  '  while [ -f "$hold" ] && [ "$i" -lt 480 ]; do sleep 0.5 2>/dev/null || sleep 1; i=$((i+1)); done',
  'fi',
  'exit 0',
].join('\n');

export interface ControlledProcessEntry {
  readonly pid: number;
  readonly label: string;
  /** cancel=协作关闭后允许信号升级；wait=仅协作信号，预算内不停即 unconfirmed。 */
  readonly policy: 'cancel' | 'wait';
}

export interface SceneEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'p07-1-f001-scene-evidence';
  readonly scenario: string;
  readonly phase: 'before' | 'after';
  readonly codeVersion: { readonly repoHead: string; readonly nodeVersion: string; readonly platform: string };
  readonly collectedAtIso: string;
  readonly entities: Record<string, unknown>;
  readonly processes: Record<string, unknown>;
  readonly gitFacts: Record<string, unknown> | null;
  readonly operations: Record<string, unknown>;
  readonly budget: Record<string, unknown> | null;
}

export interface FaultBarrierCleanupResult {
  readonly ok: boolean;
  readonly cleanupUnconfirmed: readonly string[];
  readonly removedTempRoot: boolean;
}

export interface FaultBarrierFixture {
  readonly env: IsolatedHostEnvironment;
  readonly fixture: BindingFixture;
  readonly probe: SqliteStorageSession;
  readonly markerDir: string;
  readonly evidenceDir: string;
  readonly gitHoldPath: string;
  readonly gitMarkerPath: string;
  readonly verifierHoldPath: string;
  readonly verifierMarkerPath: string;
  readonly children: readonly ManagedChild[];
  /** 生成子进程 Host 配置（场景预设 + 覆盖）。 */
  buildChildConfig(scenario: FaultBarrierScenario, overrides?: Record<string, unknown>): Record<string, unknown>;
  spawnHost(config: Record<string, unknown>, label: string): Promise<ManagedChild>;
  runtimeStarts(): Array<Record<string, unknown>>;
  verifierMarker(): { pid: number; ppid: number; startedAtIso: string } | undefined;
  gitMarker(): { pid: number; head: string; startedAt: string } | undefined;
  workspaceRow(): { id: string; canonical_path: string; status: string; branch: string; base_commit: string } | undefined;
  workerPids(): number[];
  registerControlled(entry: ControlledProcessEntry): void;
  collectEvidence(scenario: string, phase: 'before' | 'after'): Promise<SceneEvidence>;
  q(sql: string, ...params: unknown[]): any;
  /** 有限回收 + 缺席核验 + 条件清理；cleanup_unconfirmed 保留现场并独立上报。 */
  cleanup(): Promise<FaultBarrierCleanupResult>;
  /** cleanup_unconfirmed 后的最终兜底：强制清理受控进程并移除临时根（仅测试收尾）。 */
  forceDispose(): Promise<void>;
}

export type FaultBarrierScenario =
  | 'normal'
  | 'runner-barrier'
  | 'verifier-barrier'
  | 'git-barrier'
  | 'check-timeout'
  | 'verifier-wait-timeout';

export interface FaultBarrierFixtureOptions {
  /** 植入条件 post-commit 钩子并预置 hold 文件（Git 提交边界场景）。 */
  readonly gitBarrier?: boolean;
  readonly prefix?: string;
}

export async function openFaultBarrierFixture(
  options: FaultBarrierFixtureOptions = {},
): Promise<FaultBarrierFixture> {
  const env = createIsolatedHostEnvironment({ prefix: options.prefix ?? 'shiploop-p07f001-' });
  const fixture = await openBindingFixture({
    deliveryPolicy: {
      commitMode: 'task_and_feature',
      gitIdentity: { name: 'P07 F001 Owner', email: 'p07-f001@example.test', confirmed: true },
    },
  });
  /* P06 起 Task 认领要求已确认项目 Profile：经公开 Core 装配入口的
   * project.profile.detect/confirm 命令建立（与产品 Host/CLI 同一入口），
   * 不补写业务表。绑定夹具自身的命令通道未装配 Profile 端口，故短开一次
   * 完整 CoreApplication 提交后立即关闭。 */
  const scope = { kind: 'project' as const, projectId: fixture.projectId };
  /* 命令时钟：盒子确定性时钟与真实时钟都不可直接读取，这里给短寿命 CoreApplication
   * 注入固定时钟（位于盒子基准与 BINDING_NOW 之间），保证 issuedAt 通过时序检查。 */
  const profileNowMs = 1_900_000_100_000;
  const profileApp = await fixture.box.openApplication({
    capabilityCatalog: fixture.box.capabilityCatalog,
    nowUtcMs: () => profileNowMs,
  });
  try {
    const owner = fixture.box.localOwner();
    const submitCommand = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
      const receipt = await profileApp.commandService.submit(owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(profileNowMs).toISOString(),
        operation, payload, ...extra,
      } as never);
      if (receipt.status !== 'completed' || receipt.result === null) {
        throw new Error(`project.profile 命令失败（${operation}）: ${JSON.stringify(receipt)}`);
      }
      return receipt as unknown as { result: Record<string, unknown> };
    };
    const detected = await submitCommand('project.profile.detect', {}, { scope });
    const candidate = detected.result.profile;
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error(`project.profile.detect 未返回候选 Profile: ${JSON.stringify(detected.result)}`);
    }
    const revisionRow = fixture.query('SELECT revision FROM project_profiles WHERE project_id = ?'
      + ' ORDER BY version DESC LIMIT 1', fixture.projectId) as { revision: number } | undefined;
    if (revisionRow === undefined) throw new Error('project.profile.detect 未持久化候选 Profile');
    await submitCommand('project.profile.confirm', { profile: candidate },
      { scope, expectedRevision: revisionRow.revision });
  } finally {
    await profileApp.close();
  }
  const markerDir = join(fixture.box.root, 'p07-1-markers');
  const evidenceDir = join(fixture.box.root, 'p07-1-evidence');
  mkdirSync(markerDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const verifierHoldPath = join(markerDir, 'verifier-hold');
  const verifierMarkerPath = join(markerDir, 'verifier-started.json');
  const gitDir = join(fixture.box.repoDirA, '.git');
  const hooksDir = join(gitDir, 'hooks');
  const gitHoldPath = join(gitDir, 'p07-1-git-hold');
  const gitMarkerPath = join(gitDir, 'p07-1-git-barrier.json');
  if (options.gitBarrier === true) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'post-commit'), GIT_HOOK, { mode: 0o755 });
    chmodSync(join(hooksDir, 'post-commit'), 0o755);
    writeFileSync(gitHoldPath, 'hold\n');
  }
  fixture.session.close();
  const probe = openSqliteStorageSession({ path: fixture.box.dbPath });

  const children: ManagedChild[] = [];
  const controlled: ControlledProcessEntry[] = [];

  function q(sql: string, ...params: unknown[]): any {
    return probe.database.prepare(sql).get(...params as never[]);
  }

  function buildChildConfig(scenario: FaultBarrierScenario, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base: Record<string, unknown> = {
      dataRoot: fixture.box.dataRoot,
      dbPath: fixture.box.dbPath,
      markerDir,
      fixtureRoot: fixture.box.root,
      stopGraceMs: 200,
      stopConfirmMs: 1_000,
      closeTimeoutMs: 150_000,
      watchdogMs: 240_000,
    };
    if (scenario === 'runner-barrier') {
      base.gates = ['hold'];
      base.script = {
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'P07-1 F-001 runner barrier' },
          { op: 'tool_command', name: 'writer' },
          { op: 'await_gate', name: 'hold' },
        ],
      };
      base.toolCommands = {
        writer: {
          argv: [process.execPath, '--no-warnings', '-e', WORKER_SCRIPT],
          environment: {}, timeoutMs: 120_000,
        },
      };
    } else {
      base.script = {
        schemaVersion: 1,
        steps: [
          { op: 'write_file', path: RUNTIME_TARGET.path, content: RUNTIME_TARGET.content },
          /* 真实受控工具进程：向占用提交真实进程身份（停止证据可核验），
           * 与 F-012/F-016 同一模式；否则收尾提交因无写入者身份而被拒。 */
          { op: 'tool_command', name: 'probe' },
          { op: 'message', role: 'assistant', text: 'P07-1 F-001 deterministic run' },
        ],
        result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
      };
      base.toolCommands = {
        ...(base.toolCommands as Record<string, unknown> | undefined),
        probe: { argv: ['/usr/bin/true'], environment: {}, timeoutMs: 10_000 },
      };
      base.verifier = {
        checkRunner: CHECK_RUNNER,
        markerPath: verifierMarkerPath,
        holdPath: verifierHoldPath,
        targetPath: RUNTIME_TARGET.path,
        expectedContent: RUNTIME_TARGET.content,
        checkTimeoutMs: scenario === 'check-timeout' ? 4_000 : 60_000,
        holdBudgetMs: 120_000,
        waitAttemptTimeoutMs: scenario === 'verifier-wait-timeout' ? 6_000 : 120_000,
        stopGraceMs: 500,
        stopConfirmMs: 2_000,
      };
      if (scenario === 'verifier-barrier') writeFileSync(verifierHoldPath, 'hold\n');
    }
    return { ...base, ...overrides };
  }

  async function spawnHost(config: Record<string, unknown>, label: string): Promise<ManagedChild> {
    const child = env.processes.spawn({
      scriptPath: HOST_CHILD,
      config,
      cwd: env.sandboxRoot,
      env: env.childEnv(),
      label,
      readyTimeoutMs: 30_000,
      requireInside: env.sandboxRoot,
    });
    children.push(child);
    await child.waitReady(30_000);
    child.releaseGo();
    await child.waitMessage('host_ready', 30_000);
    return child;
  }

  function runtimeStarts(): Array<Record<string, unknown>> {
    const path = join(markerDir, 'runtime-starts.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }

  function verifierMarker() {
    if (!existsSync(verifierMarkerPath)) return undefined;
    return JSON.parse(readFileSync(verifierMarkerPath, 'utf8')) as { pid: number; ppid: number; startedAtIso: string };
  }

  function gitMarker() {
    if (!existsSync(gitMarkerPath)) return undefined;
    return JSON.parse(readFileSync(gitMarkerPath, 'utf8')) as { pid: number; head: string; startedAt: string };
  }

  let lastWorkspace: { id: string; canonical_path: string; status: string; branch: string; base_commit: string } | undefined;
  function workspaceRow() {
    const row = q('SELECT id, canonical_path, status, branch, base_commit FROM managed_workspaces') as
      | { id: string; canonical_path: string; status: string; branch: string; base_commit: string }
      | undefined;
    if (row !== undefined) lastWorkspace = row;
    return row ?? lastWorkspace;
  }

  function workerPids(): number[] {
    const found: number[] = [];
    const walk = (path: string, depth: number): void => {
      if (depth > 6) return;
      try {
        for (const name of readdirSync(path)) {
          const full = join(path, name);
          if (name === 'worker.pid') {
            const pid = Number(readFileSync(full, 'utf8'));
            if (Number.isSafeInteger(pid) && pid > 1) found.push(pid);
            continue;
          }
          try { if (statSync(full).isDirectory()) walk(full, depth + 1); } catch { /* gone */ }
        }
      } catch { /* gone */ }
    };
    walk(fixture.box.root, 0);
    return found;
  }

  function registerControlled(entry: ControlledProcessEntry): void {
    controlled.push(entry);
  }

  async function collectEvidence(scenario: string, phase: 'before' | 'after'): Promise<SceneEvidence> {
    const workspace = workspaceRow();
    let gitFacts: Record<string, unknown> | null = null;
    if (workspace !== undefined) {
      const root = workspace.canonical_path;
      const managed = q('SELECT repository_binding_id, repository_binding_revision, repo_identity,'
        + ' git_common_dir FROM managed_workspaces') as {
        repository_binding_id: string; repository_binding_revision: number; repo_identity: string; git_common_dir: string;
      } | undefined;
      try {
        if (managed === undefined) throw new Error('managed workspace row gone');
        const baseline = {
          repositoryBindingId: managed.repository_binding_id,
          repositoryBindingRevision: managed.repository_binding_revision,
          repoIdentity: managed.repo_identity,
          canonicalPath: root,
          gitCommonDir: managed.git_common_dir,
          branch: workspace.branch,
          baseCommit: workspace.base_commit,
        };
        const inspection = await createWorkspaceInspector({
          authorizedRoots: [fixture.box.root, fixture.box.repoDirA],
          confirmProcessIdentity: async identity => ({ launchId: identity.launchId }),
        }).inspect(baseline);
        const identity = verificationCodeIdentity(inspection);
        gitFacts = {
          head: inspection.repository.headCommit,
          tree: git(['rev-parse', 'HEAD^{tree}'], root).trim(),
          branch: workspace.branch,
          baseCommit: workspace.base_commit,
          headBeyondBase: inspection.repository.headCommit !== workspace.base_commit,
          trackedPathsDigest: identity.trackedPathsDigest ?? null,
          untrackedPathsDigest: identity.untrackedPathsDigest ?? null,
          trackedCount: inspection.contents.tracked.length,
          untrackedCount: inspection.contents.untracked.length,
          workspaceGone: false,
        };
      } catch {
        /* 成功收尾后 worktree 可能已被产品清理：回退到共享引用（共同 git dir）
         * 中的真实分支事实，不虚构内容清单。 */
        const head = git(['rev-parse', `refs/heads/${workspace.branch}`], fixture.box.repoDirA).trim();
        gitFacts = {
          head,
          tree: git(['rev-parse', `${head}^{tree}`], fixture.box.repoDirA).trim(),
          branch: workspace.branch,
          baseCommit: workspace.base_commit,
          headBeyondBase: head !== workspace.base_commit,
          workspaceGone: true,
        };
      }
    }
    const attempt = q('SELECT id, task_id, status, execution_stage, exit_code, diagnostic_ref,'
      + ' owner_id, host_instance_id, execution_version FROM attempts ORDER BY number DESC LIMIT 1');
    const markerPids = {
      verifier: verifierMarker()?.pid ?? null,
      gitHook: gitMarker()?.pid ?? null,
      workers: workerPids(),
      hostChildren: children.map(child => child.pid),
    };
    const census = await processRows();
    const ownPids = new Set([process.pid, ...markerPids.hostChildren]);
    const censusRows = census.filter(row =>
      markerPids.verifier === row.pid || markerPids.gitHook === row.pid
      || markerPids.workers.includes(row.pid));
    const evidence: SceneEvidence = {
      schemaVersion: 1,
      kind: 'p07-1-f001-scene-evidence',
      scenario, phase,
      codeVersion: {
        repoHead: git(['rev-parse', 'HEAD'], process.cwd()).trim(),
        nodeVersion: process.version,
        platform: process.platform,
      },
      collectedAtIso: new Date().toISOString(),
      gitFacts,
      entities: {
        run: q('SELECT id, status, reason, revision, batch_id FROM runs'),
        attempt,
        task: q('SELECT id, status, manual_block FROM tasks'),
        workspace: workspace === undefined ? null : { id: workspace.id, status: workspace.status },
        verificationBatch: attempt === undefined ? undefined
          : q('SELECT id, status, code_digest IS NOT NULL AS has_code_digest FROM verification_batches'
            + ' WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1', attempt.id),
      },
      processes: {
        markers: markerPids,
        census: censusRows.map(row => ({ pid: row.pid, processGroupId: row.processGroupId, startTime: row.startTime })),
        hostChildCount: children.length,
      },
      operations: {
        gitOperations: attempt === undefined ? [] : probe.database.prepare(
          'SELECT operation_type, status, actual_commit IS NOT NULL AS has_actual_commit, reason_code'
          + ' FROM git_operations WHERE attempt_id = ? ORDER BY created_at').all(attempt.id),
        verifierCompletionEvents: probe.database.prepare(
          "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'attempt.updated'").get(),
      },
      budget: q('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches'),
    };
    const line = `${JSON.stringify(evidence)}\n`;
    writeFileSync(join(evidenceDir, `${scenario}.jsonl`), line, { flag: 'a' });
    return evidence;
  }

  function removeHoldFiles(): void {
    for (const path of [gitHoldPath, verifierHoldPath]) {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    }
  }

  async function terminateRegistry(): Promise<string[]> {
    const unconfirmed: string[] = [];
    const entries: Array<ControlledProcessEntry & { source: string }> = [
      ...controlled.map(entry => ({ ...entry, source: entry.label })),
      ...workerPids().map(pid => ({ pid, label: 'worker', policy: 'cancel' as const, source: 'worker.pid' })),
    ];
    const verifier = verifierMarker();
    if (verifier !== undefined) entries.push({ pid: verifier.pid, label: 'verifier-check', policy: 'cancel', source: 'verifier-started.json' });
    const hook = gitMarker();
    if (hook !== undefined) entries.push({ pid: hook.pid, label: 'git-post-commit-hook', policy: 'cancel', source: 'git-barrier.json' });
    const seen = new Set<number>();
    for (const entry of entries) {
      if (seen.has(entry.pid)) continue;
      seen.add(entry.pid);
      try {
        if (entry.policy === 'cancel') {
          try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* no group */ }
          try { process.kill(entry.pid, 'SIGKILL'); } catch { /* exited */ }
        } else {
          try { process.kill(entry.pid, 'SIGTERM'); } catch { /* exited */ }
        }
      } catch {
        unconfirmed.push(`${entry.source}:${entry.pid}:signal_failed`);
      }
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = entries.filter(entry => {
        try { process.kill(entry.pid, 0); return true; } catch { return false; }
      });
      if (pending.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    for (const entry of entries) {
      try { process.kill(entry.pid, 0); unconfirmed.push(`${entry.source}:${entry.pid}:still_alive`); } catch { /* gone */ }
    }
    return unconfirmed;
  }

  async function confirmTreeAbsence(): Promise<string[]> {
    const unconfirmed: string[] = [];
    for (const child of children) {
      if (child.isAlive()) unconfirmed.push(`host-child:${child.label}:${child.pid}`);
    }
    let census: Awaited<ReturnType<typeof processRows>>;
    try { census = await processRows(); } catch {
      return [...unconfirmed, 'census:unavailable'];
    }
    const known = new Set<number>([...workerPids()]);
    const verifier = verifierMarker();
    if (verifier !== undefined) known.add(verifier.pid);
    const hook = gitMarker();
    if (hook !== undefined) known.add(hook.pid);
    for (const pid of known) {
      if (census.some(row => row.pid === pid)) unconfirmed.push(`marker-pid:${pid}`);
    }
    return unconfirmed;
  }

  let cleaned = false;
  async function cleanup(): Promise<FaultBarrierCleanupResult> {
    if (cleaned) return { ok: true, cleanupUnconfirmed: [], removedTempRoot: true };
    const problems: string[] = [];
    removeHoldFiles();
    for (const child of children.splice(0)) {
      try {
        await child.verifyStopped({ stepMs: 500 });
      } catch (error) {
        problems.push(`host-child:${child.label}:exit_unconfirmed:${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    problems.push(...await terminateRegistry());
    problems.push(...await confirmTreeAbsence());
    if (problems.length > 0) {
      return { ok: false, cleanupUnconfirmed: problems, removedTempRoot: false };
    }
    probe.close();
    fixture.close();
    await env.dispose();
    cleaned = true;
    return { ok: true, cleanupUnconfirmed: [], removedTempRoot: true };
  }

  async function forceDispose(): Promise<void> {
    if (cleaned) return;
    removeHoldFiles();
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { await child.exited; } catch { /* already gone */ }
    }
    for (const entry of controlled.splice(0)) {
      try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* no group */ }
      try { process.kill(entry.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    for (const pid of workerPids()) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    }
    const verifier = verifierMarker();
    if (verifier !== undefined) {
      try { process.kill(-verifier.pid, 'SIGKILL'); } catch { /* no group */ }
      try { process.kill(verifier.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    const hook = gitMarker();
    if (hook !== undefined) {
      try { process.kill(-hook.pid, 'SIGKILL'); } catch { /* no group */ }
      try { process.kill(hook.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    try { probe.close(); } catch { /* already closed */ }
    try { fixture.close(); } catch { /* already closed */ }
    await env.dispose();
    cleaned = true;
  }

  return {
    env, fixture, probe, markerDir, evidenceDir,
    gitHoldPath, gitMarkerPath, verifierHoldPath, verifierMarkerPath,
    children,
    buildChildConfig, spawnHost,
    runtimeStarts, verifierMarker, gitMarker, workspaceRow, workerPids,
    registerControlled, collectEvidence, q,
    cleanup, forceDispose,
  };
}

/** 生成忽略 SIGTERM 的真实驻留进程（cleanup_unconfirmed 场景的确定性来源）。
 * 处理器安装完成后写就绪标记，避免 SIGTERM 在引导完成前默认杀死进程的竞争。 */
export function spawnIgnoringTerminator(label: string): { pid: number; stop: () => void } {
  const readyPath = join(join(realpathSync(tmpdir()), `p07f001-term-${process.pid}-${Date.now()}.ready`));
  const script = [
    "process.on('SIGTERM',()=>{})",
    "process.on('SIGINT',()=>{})",
    `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    'setInterval(()=>{},1000)',
  ].join(';');
  const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error('ignoring-terminator 启动失败');
  const pid = child.pid;
  const deadline = Date.now() + 5_000;
  while (!existsSync(readyPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (!existsSync(readyPath)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    throw new Error('ignoring-terminator 就绪超时');
  }
  try { rmSync(readyPath, { force: true }); } catch { /* best effort */ }
  return {
    pid,
    stop(): void {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    },
  };
}

/** 有界等待条件成立（屏障观察统一入口）。 */
export async function waitFor(condition: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
