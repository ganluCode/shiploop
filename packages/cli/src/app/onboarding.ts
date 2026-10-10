/**
 * F-005 project init/overview CLI 静态预览、确认文案与结构化格式化（契约 §12.1/§12.2/§12.3）。
 *
 * 纯函数模块（与 `app/args.ts` 同一纪律）：
 * - 不读 argv/env、不读文件、不发现 Host、不联网、不启动进程、不打印；
 * - 确认语义按契约 §12.1 冻结：注册只有显式 `--confirm`（非交互授权）才同意，
 *   且只覆盖预览展示的这一次注册请求；无输入或非交互模式绝不默认同意，
 *   交互肯定应答也必须回到显式 `--confirm`（确认入口唯一）；取消确认得到
 *   `not_run`（未注册），绝不折算为成功；
 * - 注册确认与运行基线确认严格分开：本模块的确认只涉及 `project.register`，
 *   不执行仓库脚本、不安装依赖、不运行基线（基线授权是 baseline run 的独立确认）；
 * - `not_run`/注册成功/健康未检查/健康失败分别展示，注册状态与健康状态分轴
 *   建模（§7.3/§8.2）：注册成功、配置存在都不得显示为健康通过。
 *
 * 输入视图与 §7.2/§7.3 查询响应结构兼容（结构化窄类型，纯面层不导入 Core）。
 */
import type { AppCliCommandId } from './args.js';
import { buildAppCliSuccessEnvelope } from './output.js';
import { CLI_EXIT_OK } from '../host/output.js';
import type { CliExitCode } from '../host/output.js';

/* ------------------------------------------------------------------ *
 * 输入视图（结构形；与 core §7.2/§7.3 响应兼容）
 * ------------------------------------------------------------------ */

/** 仓库静态事实（HEAD/初始 commit/脏状态）。 */
export interface RepositoryFactView {
  /** 实际 HEAD；无初始 commit 为 null（不猜分支、不自动提交）。 */
  readonly headCommit: string | null;
  readonly hasInitialCommit: boolean;
  readonly hasUncommittedChanges: boolean;
}

/** §7.2 `projects.inspect` 响应的窄视图（只读仓库事实 + 既有项目身份）。 */
export interface InspectedRepositoryView extends RepositoryFactView {
  /** realpath 规范化后的仓库根。 */
  readonly canonicalPath: string;
  /** 稳定本地身份（gitdir-sha256:…）；只进结构化结果，不进人类预览。 */
  readonly repoIdentity: string;
  /** canonicalPath 已绑定可见项目时的既有项目身份；未绑定为 null。 */
  readonly alreadyRegistered: { readonly projectId: string } | null;
}

/** 即将注册的请求内容（预览与确认展示的实际请求）。 */
export interface InitRequestView {
  readonly repositoryPath: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly labels: readonly string[];
}

/** §7.3/§8.2 健康摘要（注册状态之外独立的一轴）。 */
export interface ProjectHealthView {
  readonly status: 'healthy' | 'unhealthy' | 'not_run';
  readonly lastBaselineOperationId: string | null;
  readonly lastCompletedAt: string | null;
  readonly reasonCode?: string;
}

/** §7.3 `projects.overview` 响应的窄视图（注册与健康严格分开）。 */
export interface ProjectOverviewView {
  readonly project: {
    readonly id: string;
    readonly displayName: string;
    readonly description: string | null;
    readonly labels: readonly string[];
  };
  readonly binding: { readonly canonicalPath: string } | null;
  readonly registration: { readonly status: 'registered' | 'not_registered' };
  readonly settings:
    | { readonly configured: false }
    | { readonly configured: true; readonly revision: number; readonly schemaVersion: number };
  readonly health: ProjectHealthView;
  readonly readAt: string;
}

/* ------------------------------------------------------------------ *
 * 静态预览（人类输出；空仓库/脏仓库事实原样呈现）
 * ------------------------------------------------------------------ */

/** HEAD 事实：有则显示实际 commit；无则显示 null 语义（不猜分支、不自动 commit）。 */
export function describeHeadFact(facts: RepositoryFactView): string {
  return facts.headCommit === null
    ? '无 HEAD（null；尚无初始 commit，不猜测分支、不自动提交）'
    : facts.headCommit;
}

/** 脏状态事实：脏文件原样保留（不 stash/reset）。 */
export function describeWorktreeFact(facts: RepositoryFactView): string {
  return facts.hasUncommittedChanges
    ? '有未提交改动（原样保留，不 stash/reset）'
    : '干净';
}

function describeRequestLine(request: InitRequestView): string {
  const name = request.displayName ?? '（未指定）';
  const description = request.description ?? '（无）';
  const labels = request.labels.length > 0 ? request.labels.join(', ') : '（无）';
  return `displayName=${name} description=${description} labels=[${labels}]`;
}

/**
 * 静态预览：规范路径、HEAD/null、初始 commit、脏状态、既有项目身份与注册确认内容。
 * 只展示只读事实与「是否会注册」，绝不执行脚本、不安装依赖、不运行基线。
 */
export function formatInitPreview(
  request: InitRequestView,
  inspection: InspectedRepositoryView,
): string {
  const existing =
    inspection.alreadyRegistered === null
      ? '无（canonicalPath 未绑定项目）'
      : `已注册（projectId=${inspection.alreadyRegistered.projectId}；重复 init 将复用既有项目）`;
  return [
    'project init 静态预览（只读事实；不执行仓库脚本、不安装依赖、不运行基线）：',
    `  规范路径：${inspection.canonicalPath}`,
    `  HEAD：${describeHeadFact(inspection)}`,
    `  初始 commit：${inspection.hasInitialCommit ? '有' : '无'}`,
    `  工作区：${describeWorktreeFact(inspection)}`,
    `  既有项目：${existing}`,
    `  注册确认内容：${describeRequestLine(request)}`,
    '  注册动作：未带 --confirm 时不会注册（静态预览，退出码 0）。',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 注册确认（与运行基线确认分开）
 * ------------------------------------------------------------------ */

/**
 * `--confirm` 是显式非交互授权：只覆盖预览展示的这一次注册请求（project.register）。
 * 无输入或非交互模式不默认同意；取消确认得到 not_run（未注册）。
 */
export type InitConfirmationDecision =
  | {
      readonly outcome: 'register';
      readonly source: 'explicit_flag';
      readonly scope: 'project.register';
    }
  | { readonly outcome: 'not_run'; readonly reason: InitNotRunReason };

export type InitNotRunReason =
  | 'non_interactive'
  | 'no_input'
  | 'declined'
  | 'confirm_flag_required';

export interface InitConfirmationInput {
  /** `--confirm`：显式非交互授权（唯一注册确认入口，契约 §12.1）。 */
  readonly confirmFlag: boolean;
  /** 交互会话（TTY）标记；只用于区分取消原因，不构成注册授权。 */
  readonly interactive: boolean;
  /** 交互确认应答原文；null/undefined 表示无输入。 */
  readonly answer?: string | null;
}

/**
 * 注册确认决策（纯函数）：
 * - 只有 `--confirm` 同意注册，且授权范围仅限预览展示的注册请求；
 * - 无 TTY：不采信任何输入，绝不默认同意（非交互模式必须显式 --confirm）；
 * - 有 TTY 无 --confirm：无输入 → no_input；明确否定 → declined；肯定应答 →
 *   confirm_flag_required（契约 §12.1：无 --confirm 不注册，须显式重新授权）。
 */
export function resolveInitConfirmation(input: InitConfirmationInput): InitConfirmationDecision {
  if (input.confirmFlag) {
    return { outcome: 'register', source: 'explicit_flag', scope: 'project.register' };
  }
  if (!input.interactive) {
    return { outcome: 'not_run', reason: 'non_interactive' };
  }
  const answer = input.answer ?? '';
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) {
    return { outcome: 'not_run', reason: 'no_input' };
  }
  if (normalized === 'y' || normalized === 'yes') {
    return { outcome: 'not_run', reason: 'confirm_flag_required' };
  }
  return { outcome: 'not_run', reason: 'declined' };
}

/** 注册确认文案：授权范围只含注册，不含脚本/安装/基线；未确认 → not_run。 */
export function buildInitConfirmationNotice(): string {
  return [
    '注册确认（与运行基线确认分开）：',
    '  --confirm 是显式非交互授权，只覆盖上面展示的这一次注册请求（project.register）。',
    '  确认注册也只提交注册命令：不执行仓库脚本、不安装依赖、不运行基线；基线需要 baseline run 的独立确认。',
    '  无输入或非交互模式不默认同意：未显式 --confirm 不会注册；取消确认得到 not_run（未注册，绝不伪装成功）。',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 结构化结果与格式化（not_run/注册成功/健康分开显示）
 * ------------------------------------------------------------------ */

export type InitRegistrationOutcome =
  | { readonly status: 'not_run'; readonly reason: InitNotRunReason }
  | { readonly status: 'registered'; readonly projectId: string }
  | { readonly status: 'already_registered'; readonly projectId: string };

export interface InitCliResult {
  readonly preview: {
    readonly canonicalPath: string;
    readonly repoIdentity: string;
    readonly headCommit: string | null;
    readonly hasInitialCommit: boolean;
    readonly hasUncommittedChanges: boolean;
    readonly alreadyRegisteredProjectId: string | null;
  };
  readonly request: {
    readonly displayName: string | null;
    readonly description: string | null;
    readonly labels: readonly string[];
  };
  /** 注册状态（独立一轴）：not_run/registered/already_registered。 */
  readonly registration: InitRegistrationOutcome;
  /** 健康状态（独立一轴）：注册成功后仍为 not_run（尚无基线），绝不折算成功。 */
  readonly health: ProjectHealthView;
}

/** 组装 init 结构化结果：注册结果与健康摘要分轴保留。 */
export function buildInitCliResult(
  request: InitRequestView,
  inspection: InspectedRepositoryView,
  registration: InitRegistrationOutcome,
): InitCliResult {
  return {
    preview: {
      canonicalPath: inspection.canonicalPath,
      repoIdentity: inspection.repoIdentity,
      headCommit: inspection.headCommit,
      hasInitialCommit: inspection.hasInitialCommit,
      hasUncommittedChanges: inspection.hasUncommittedChanges,
      alreadyRegisteredProjectId: inspection.alreadyRegistered?.projectId ?? null,
    },
    request: {
      displayName: request.displayName,
      description: request.description,
      labels: [...request.labels],
    },
    registration,
    health: {
      status: 'not_run',
      lastBaselineOperationId: null,
      lastCompletedAt: null,
      reasonCode: 'no_baseline',
    },
  };
}

/**
 * 健康摘要展示：`not_run` 显示为未检查（尚无基线操作），绝不折算为成功；
 * `healthy`/`unhealthy` 带受控 reason 原样展示。
 */
export function describeHealthStatus(health: ProjectHealthView): string {
  if (health.status === 'not_run') {
    const reason = health.reasonCode ?? 'no_baseline';
    const hint = reason === 'no_baseline' ? '尚无基线操作' : `原因=${reason}`;
    return `not_run（未检查：${hint}；reason=${reason}，不得视为健康）`;
  }
  if (health.status === 'unhealthy') {
    return `unhealthy（不健康；reason=${health.reasonCode ?? 'unknown'}）`;
  }
  return 'healthy（健康）';
}

function describeRegistrationOutcome(outcome: InitRegistrationOutcome): string {
  if (outcome.status === 'not_run') {
    return `not_run（未注册；原因=${outcome.reason}）`;
  }
  if (outcome.status === 'registered') {
    return `registered（注册成功；projectId=${outcome.projectId}）`;
  }
  return `already_registered（复用既有项目；projectId=${outcome.projectId}，不覆盖原名称/说明/标签）`;
}

/** init 结果的人类摘要：注册状态与健康状态分行、分开显示。 */
export function formatInitCliResult(result: InitCliResult): string {
  return [
    'project init 结果：',
    `  规范路径：${result.preview.canonicalPath}`,
    `  HEAD：${describeHeadFact(result.preview)}`,
    `  工作区：${describeWorktreeFact(result.preview)}`,
    `  注册状态：${describeRegistrationOutcome(result.registration)}`,
    `  健康状态：${describeHealthStatus(result.health)}（注册状态与健康状态分开）`,
    '',
  ].join('\n');
}

/** overview 结果的人类摘要：注册状态与健康状态严格分开（§7.3）。 */
export function formatOverviewResult(overview: ProjectOverviewView): string {
  const settings = overview.settings.configured
    ? `已配置（revision=${overview.settings.revision} schemaVersion=${overview.settings.schemaVersion}）`
    : '未配置';
  const binding =
    overview.binding === null ? '无（未绑定仓库）' : overview.binding.canonicalPath;
  return [
    'project overview 结果：',
    `  项目：${overview.project.displayName}（id=${overview.project.id}）`,
    `  绑定：${binding}`,
    `  注册状态：${overview.registration.status}`,
    `  配置：${settings}`,
    `  健康状态：${describeHealthStatus(overview.health)}（注册状态与健康状态分开）`,
    `  读取时间：${overview.readAt}`,
    '',
  ].join('\n');
}

/**
 * §12.3：`project init` 预览或注册成功都是退出码 0；`not_run`（未确认/取消确认）
 * 是明确展示的未注册结果，不是操作失败，也不是成功折算。
 */
export function initCliExitCode(_result: InitCliResult): CliExitCode {
  return CLI_EXIT_OK;
}

/* ------------------------------------------------------------------ *
 * 输出路由（JSON 模式 stdout 只有可解析结果；提示与诊断进 stderr）
 * ------------------------------------------------------------------ */

export interface AppCliStreamOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * stdout/stderr 纯路由：
 * - `--json`：stdout 只有一个可解析成功信封（{ok,command,result}），提示进 stderr；
 * - 人类模式：结果文本进 stdout，提示（确认文案等）进 stderr。
 */
export function composeAppCliStreams(input: {
  readonly json: boolean;
  readonly command: Extract<AppCliCommandId, 'project.init' | 'project.overview'>;
  readonly result: unknown;
  readonly humanText: string;
  readonly notices: readonly string[];
}): AppCliStreamOutput {
  const notices = input.notices
    .map((notice) => (notice.endsWith('\n') ? notice : `${notice}\n`))
    .join('');
  if (input.json) {
    const envelope = buildAppCliSuccessEnvelope(input.command, input.result);
    return { stdout: `${JSON.stringify(envelope)}\n`, stderr: notices };
  }
  return { stdout: input.humanText, stderr: notices };
}
