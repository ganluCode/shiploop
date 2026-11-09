/**
 * DAG / F-002：规划快照工作区准备器（fs 适配器）。
 *
 * 职责：在受控 planning 目录（<dataRoot>/projects/<projectId>/planning/<featureId>，
 * PathService planning_workspace_directory）确保存在一个 **detached** git worktree
 * ——固定在规划输入冻结的 headCommit 上，供 planning Runtime 只读浏览代码快照。
 *
 * 与正式编码准备（feature-worktree-preparer）的边界：
 * - 不创建、不占用 Feature 编码分支（`worktree add --detach`，无 -b）；
 * - 不写 managed_workspaces/workspace_operations（编码工作区事实归编码准备；
 *   旧规划工作区迁移属 F-003）；
 * - 不移动源仓库 refs/index/HEAD（创建前后逐项比对，证明零编码侧写入）；
 * - 目标路径恒在数据根授权根内，经 repository inspector 只读核对
 *   repoIdentity/gitCommonDir 与项目绑定一致。
 *
 * 进程纪律：全部 Git 命令经 CommandProcessPort 受监督执行（可信身份确认 +
 * 停止确认；变更性命令后未确认停止即视为不确定并 fail-closed）。崩溃中断留下的
 * 半成品目录在下一次 ensure 按「已在但不在冻结基线/有未提交变更」结构化拒绝
 * （planning_workspace_stale），由 F-003 迁移入口/后续清理负责恢复，不盲重放。
 */
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { devNull } from 'node:os';
import type { CommandProcessIdentity, CommandProcessPort } from '../../ports/command-process.js';
import { createCommandProcessAdapter } from '../process/command-process.js';
import type { RepositoryBindingRecord } from '../../ports/state-store.js';
import type { RepositoryInspector } from '../../ports/repository-inspector.js';
import type { PathService } from '../../ports/path-service.js';

/** 规划快照准备失败原因（受控小写蛇形词汇；work-execution 映射为结构化冲突）。 */
export type PlanningSnapshotWorkspaceFailure =
  | 'planning_workspace_preparer_not_assembled'
  | 'source_path_changed'
  | 'base_commit_mismatch'
  | 'base_commit_not_ancestor'
  | 'registered_path_conflict'
  | 'directory_conflict'
  | 'planning_workspace_not_at_baseline'
  | 'source_protection_changed'
  | 'git_command_failed'
  | 'stop_unconfirmed';

export class PlanningSnapshotWorkspaceError extends Error {
  constructor(public readonly reason: PlanningSnapshotWorkspaceFailure, message: string) {
    super(message);
    this.name = 'PlanningSnapshotWorkspaceError';
  }
}

export interface PlanningSnapshotWorktreePreparer {
  /**
   * 确保规划快照 detached worktree 存在于受控位置并固定在 headCommit。
   * 已存在且匹配（HEAD= headCommit、无未提交变更、真实路径无符号链接漂移）
   * 时幂等复用；不匹配时结构化拒绝（不自动重建、不盲删除现场）。
   */
  ensure(input: {
    readonly binding: RepositoryBindingRecord;
    readonly featureId: string;
    readonly headCommit: string;
    readonly admit?: () => void;
  }): Promise<{ readonly canonicalPath: string }>;
}

export function createPlanningSnapshotWorktreePreparer(options: {
  readonly inspector: RepositoryInspector;
  readonly paths: PathService;
  readonly commandProcess?: CommandProcessPort;
  readonly confirmProcessIdentity: (identity: CommandProcessIdentity) => Promise<{ readonly launchId: string }>;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}): PlanningSnapshotWorktreePreparer {
  const processes = options.commandProcess ?? createCommandProcessAdapter();
  return {
    async ensure({ binding, featureId, headCommit, admit }) {
      if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(headCommit)) {
        throw new PlanningSnapshotWorkspaceError('base_commit_mismatch', 'planning headCommit 形态非法');
      }
      const located = await options.paths.locateProjectResource(
        { projectId: binding.projectId },
        { type: 'planning_workspace_directory', featureId },
      );
      const target = located.absolutePath;

      /* 受监督 Git（与 feature-worktree-preparer 同一纪律；cwd=登记源仓库）。 */
      async function git(args: string[], allowed: readonly number[] = [0]): Promise<{ readonly output: string; readonly exitCode: number }> {
        admit?.();
        if (await realpath(binding.canonicalPath) !== binding.canonicalPath) {
          throw new PlanningSnapshotWorkspaceError('source_path_changed', '源仓库路径在准备期间被替换');
        }
        const handle = await processes.start({ cwd: binding.canonicalPath,
          argv: ['/usr/bin/git', '--no-pager', '--no-optional-locks', '-c', `core.hooksPath=${devNull}`,
            '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
            '-c', 'protocol.allow=never', ...args],
          environment: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
            GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
          maxInputBytes: 65_536, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
          timeoutMs: options.timeoutMs ?? 30_000 },
          async identity => options.confirmProcessIdentity(identity));
        const chunks: Buffer[] = [];
        let outputFailed = false;
        try {
          for await (const event of handle.output) if (event.stream === 'stdout') chunks.push(Buffer.from(event.bytes));
        } catch {
          outputFailed = true;
          await handle.cancel();
        }
        const completed = await handle.result;
        if (!completed.stop.confirmed || !(await handle.stopped).confirmed) {
          throw new PlanningSnapshotWorkspaceError('stop_unconfirmed', 'Git 进程停止未确认');
        }
        const exitCode = completed.exitCode ?? -1;
        if (outputFailed || completed.reason !== null || completed.droppedOutputBytes !== 0 || completed.signal !== null
          || !allowed.includes(exitCode)) {
          throw new PlanningSnapshotWorkspaceError('git_command_failed', `Git 命令失败（exit=${exitCode}）`);
        }
        return { output: Buffer.concat(chunks).toString('utf8'), exitCode };
      }

      try {
        /* 1) 冻结基线提交存在且身份一致；且是当前源 HEAD 的祖先（F-001 同款
         *    纪律：源仓库历史被改写导致快照不在主线时 fail-closed）。 */
        await git(['cat-file', '-e', `${headCommit}^{commit}`]);
        if ((await git(['rev-parse', '--verify', `${headCommit}^{commit}`])).output.trim() !== headCommit) {
          throw new PlanningSnapshotWorkspaceError('base_commit_mismatch', 'headCommit 解析不一致');
        }
        const ancestry = await git(['merge-base', '--is-ancestor', headCommit, 'HEAD'], [0, 1]);
        if (ancestry.exitCode !== 0) {
          throw new PlanningSnapshotWorkspaceError('base_commit_not_ancestor', '规划快照提交不再是源仓库 HEAD 祖先');
        }

        /* 2) 已存在的规划工作区：幂等复用（严格匹配冻结基线 + 干净 + 无链接漂移）；
         *    不匹配结构化拒绝，不自动重建（现场可能是崩溃残留，交 F-003/清理）。 */
        let existing: import('node:fs').Stats | undefined;
        try { existing = await lstat(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (existing !== undefined) {
          if (!existing.isDirectory() || existing.isSymbolicLink()) {
            throw new PlanningSnapshotWorkspaceError('directory_conflict', '规划工作区路径被非目录/符号链接占用');
          }
          if (await realpath(target) !== target) {
            throw new PlanningSnapshotWorkspaceError('directory_conflict', '规划工作区路径符号链接漂移');
          }
          const inspection = await options.inspector.inspect(target);
          if (inspection.repoIdentity !== binding.repoIdentity || inspection.gitCommonDir !== binding.gitCommonDir) {
            throw new PlanningSnapshotWorkspaceError('planning_workspace_not_at_baseline', '规划工作区仓库身份与项目绑定不一致');
          }
          if (inspection.headCommit !== headCommit || inspection.hasUncommittedChanges) {
            throw new PlanningSnapshotWorkspaceError('planning_workspace_not_at_baseline', '规划工作区不在冻结基线或存在未提交变更');
          }
          return { canonicalPath: target };
        }

        /* 3) 创建前现场核对：目标未注册为 worktree、目录不存在、父目录真实路径稳定；
         *    记录源仓库 refs/index/HEAD 作为零写入比对基准。 */
        const listing = (await git(['worktree', 'list', '--porcelain', '-z'])).output;
        if (listing.split('\0').includes(`worktree ${target}`)) {
          throw new PlanningSnapshotWorkspaceError('registered_path_conflict', '规划工作区路径已注册为 Git worktree');
        }
        const indexPath = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).output.trim();
        const refsBefore = (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).output;
        const sourceHeadBefore = (await git(['rev-parse', '--verify', 'HEAD'])).output.trim();
        const indexBefore = await readFile(indexPath);

        await mkdir(dirname(target), { recursive: true });
        if (await realpath(dirname(target)) !== dirname(target)) {
          throw new PlanningSnapshotWorkspaceError('directory_conflict', '规划工作区父目录符号链接漂移');
        }
        admit?.();
        /* 4) detached worktree（无 -b、不建编码分支）。 */
        await git(['worktree', 'add', '--detach', target, headCommit]);

        /* 5) 创建后核对：固定在冻结基线、无未提交变更、身份一致；源仓库零写入
         *    （refs/index/HEAD 逐项一致——不产生编码分支提交）。 */
        const inspection = await options.inspector.inspect(target);
        if (inspection.repoIdentity !== binding.repoIdentity || inspection.gitCommonDir !== binding.gitCommonDir
          || inspection.headCommit !== headCommit || inspection.hasUncommittedChanges) {
          throw new PlanningSnapshotWorkspaceError('planning_workspace_not_at_baseline', '新建规划工作区不在冻结基线');
        }
        if ((await git(['for-each-ref', '--format=%(refname) %(objectname)'])).output !== refsBefore
          || (await git(['rev-parse', '--verify', 'HEAD'])).output.trim() !== sourceHeadBefore
          || !(await readFile(indexPath)).equals(indexBefore)) {
          throw new PlanningSnapshotWorkspaceError('source_protection_changed', '源仓库 refs/index/HEAD 在规划工作区创建期间被改动');
        }
        if (await realpath(target) !== target) {
          throw new PlanningSnapshotWorkspaceError('directory_conflict', '规划工作区路径符号链接漂移');
        }
        admit?.();
        return { canonicalPath: target };
      } catch (error) {
        /* 停止未确认/输出截断的变更性命令留下的现场状态不确定：保持目录原样
         * （下次 ensure 按基线/干净核对结构化拒绝），绝不静默视为成功。 */
        throw error;
      }
    },
  };
}
