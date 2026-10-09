/**
 * F-015 应用命令 CLI 纵向执行层（契约 §12.1/§12.2/§12.3、§5.5/§5.7、§6、§7）。
 *
 * 与 F-014 纯面层的边界（`app/` 目录保持纯函数、无 I/O）：
 * - 本模块允许 I/O：经 `shiploop-host` 公共面 `ensureHostRunning` 连接或受控
 *   启动同一单例 Host，再经 HostClient 提交命令/执行查询；不直连 shiploop-core、
 *   不打开 SQLite、不读认证文件（凭据只由 Host 存储/客户端面读取）；
 * - 解析仍由纯面层 `parseAppCliArgs` 完成；解析失败在任何 I/O 之前返回退出码 2；
 * - 写命令复用 HostClient 的冻结信封与「超时先查回执」；显式 `--command-id`
 *   先查该身份下的既有回执并以其 `issuedAt` 重建同一信封，使相同参数的重复
 *   提交命中服务端摘要重放（返回原回执），不同参数则得到 conflict；
 * - 输出纪律：`--json` 时 stdout 只输出一个信封 JSON；人类诊断走 stderr；
 *   任何输出都不含 token、Authorization 头或堆栈。
 *
 * import 本模块即把 Host 启动编排装入图（有 I/O 能力），但不读 argv/env、
 * 不访问网络、不 spawn——只有 `runAppCli` 显式调用才执行。
 * `packages/cli/src/index.ts` 公共入口不 re-export 本模块（显式入口 bin.ts 专用）。
 */
import {
  ensureHostRunning,
  isHostProtocolError,
  HostProtocolError,
  type HostClient,
  type HostClientTimeouts,
  type SubmitCommandInput,
} from 'shiploop-host';
import { AppCliParseError, parseAppCliArgs } from './app/args.js';
import type { AppCliCommandId, ParsedAppCliCommand } from './app/args.js';
import { getAppCliHelp } from './app/help.js';
import {
  buildAppCliFailureEnvelope,
  buildAppCliSuccessEnvelope,
  exitCodeForAppErrorCode,
  exitCodeForReceiptStatus,
  formatAppCliParseError,
} from './app/output.js';
import type { AppCliFailureEnvelope, AppCliSuccessEnvelope } from './app/output.js';
import { CLI_EXIT_OK } from './host/output.js';
import type { CliExitCode } from './host/output.js';

export type { AppCliFailureEnvelope, AppCliSuccessEnvelope } from './app/output.js';

/** 输出端口：bin.ts 接 process.stdout/stderr；测试收集为字符串。 */
export interface AppCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** 受信测试注入：启动器装配覆盖（干净树用 TS 入口；生产默认 dist/start.js）。 */
export interface AppCliLaunchOverrides {
  readonly entryArgv?: readonly string[];
  readonly nodeExecutable?: string;
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
  readonly onCandidateSpawned?: (pid: number | undefined) => void;
  readonly pollIntervalMs?: number;
}

export interface RunAppCliOptions {
  /** process.argv.slice(2) 形态；不直接读 process.argv。 */
  readonly args: readonly string[];
  /** 显式注入的环境（bin.ts 传 process.env）；监听覆盖在此解析。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io: AppCliIo;
  /** 平台注入口（默认 process.platform）；非 darwin 在任何 I/O 前拒绝。 */
  readonly platform?: string;
  /** 用户目录注入口（默认 os.homedir()）；仅用于省略 --data-root 时推导默认根。 */
  readonly userHomeDir?: string;
  /** HostClient 有限预算覆盖（受信装配/测试注入；绝非 argv/env）。 */
  readonly timeouts?: HostClientTimeouts;
  /** 启动器覆盖（entryArgv/子进程 env 等）。 */
  readonly launch?: AppCliLaunchOverrides;
}

export type AppCliRunKind = 'success' | 'failure' | 'help';

export interface AppCliRunResult {
  readonly exitCode: CliExitCode;
  readonly kind: AppCliRunKind;
  /** 失败且命令不可识别时为 null；帮助为 null。 */
  readonly command: AppCliCommandId | null;
  /** --json 时即打印到 stdout 的信封；非 JSON/帮助时为 undefined。 */
  readonly envelope?: AppCliSuccessEnvelope<unknown> | AppCliFailureEnvelope;
}

const SUPPORTED_PLATFORM = 'darwin';

/** 命令操作/回执的窄类型（避免 CLI 直接依赖 Core 协议类型）。 */
type CommandReceipt = Awaited<ReturnType<HostClient['submitCommand']>>;
type CompletedReceipt = Extract<CommandReceipt, { status: 'completed' }>;
type ProjectDetailResult = Awaited<ReturnType<HostClient['getProject']>>;
type ProjectListResult = Awaited<ReturnType<HostClient['listProjects']>>;
type ProjectLabelCountsResult = Awaited<ReturnType<HostClient['countProjectLabels']>>;

/** 根来源二选一：显式 --data-root 优先，省略时才用注入用户目录推导默认根。 */
function rootSource(
  dataRoot: string | undefined,
  userHomeDir: string | undefined,
): { dataRoot?: string } | { userHomeDir?: string } {
  if (dataRoot !== undefined) {
    return { dataRoot };
  }
  return userHomeDir !== undefined ? { userHomeDir } : {};
}

interface FailureResult {
  readonly exitCode: CliExitCode;
  readonly command: AppCliCommandId | null;
  readonly code: string;
  readonly message: string;
  readonly commandId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 失败输出：JSON 信封到 stdout（--json）；人类诊断始终到 stderr。 */
function emitFailure(io: AppCliIo, json: boolean, failure: FailureResult): AppCliRunResult {
  const envelope = buildAppCliFailureEnvelope(failure.command, failure.code, failure.message, {
    ...(failure.commandId !== undefined ? { commandId: failure.commandId } : {}),
    ...(failure.details !== undefined ? { details: failure.details } : {}),
  });
  if (json) {
    io.stdout(`${JSON.stringify(envelope)}\n`);
  }
  io.stderr(`shiploop: ${failure.code}: ${failure.message}\n`);
  return {
    exitCode: failure.exitCode,
    kind: 'failure',
    command: failure.command,
    ...(json ? { envelope } : {}),
  };
}

function protocolFailure(command: AppCliCommandId, error: HostProtocolError): FailureResult {
  return {
    exitCode: exitCodeForAppErrorCode(error.code),
    command,
    code: error.code,
    message: error.message ?? 'Host 协议错误（已脱敏）',
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}

/** 成功输出：--json 信封到 stdout；否则人类行到 stdout。 */
function emitSuccess(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  result: unknown,
  human: string,
): AppCliRunResult {
  const commandId = command.commandId;
  if (command.json) {
    const envelope = buildAppCliSuccessEnvelope(commandId, result);
    io.stdout(`${JSON.stringify(envelope)}\n`);
    return { exitCode: CLI_EXIT_OK, kind: 'success', command: commandId, envelope };
  }
  io.stdout(human);
  return { exitCode: CLI_EXIT_OK, kind: 'success', command: commandId };
}

/* ------------------------------------------------------------------ *
 * 人类可读行（脱敏；不含凭据/堆栈）
 * ------------------------------------------------------------------ */

function projectRegisteredHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as
    | { status?: string; project?: { id?: string; revision?: number; displayName?: string } }
    | undefined;
  const project = result?.project ?? {};
  const status = result?.status ?? receipt.status;
  return (
    `shiploop project register: ${status} project=${String(project.id)} ` +
    `name=${String(project.displayName)} revision=${String(project.revision)}\n`
  );
}

function projectEditedHumanLine(receipt: CompletedReceipt): string {
  const result = receipt.result as { project?: { id?: string; revision?: number } } | undefined;
  const project = result?.project ?? {};
  return (
    `shiploop project edit: updated project=${String(project.id)} ` +
    `revision=${String(project.revision)}${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function projectListHumanLine(result: ProjectListResult): string {
  const lines = [`shiploop project list: ${result.records.length} project(s)`];
  for (const record of result.records) {
    const labels = record.labels.length > 0 ? ` [${record.labels.join(',')}]` : '';
    lines.push(`  - ${record.id} ${record.displayName} r${record.revision}${labels}`);
  }
  if (result.nextCursor !== null) {
    lines.push(`  nextCursor=${result.nextCursor}`);
  }
  return `${lines.join('\n')}\n`;
}

function projectDetailHumanLine(detail: ProjectDetailResult): string {
  const binding = detail.binding;
  const bindingText = binding === null ? 'none' : binding.canonicalPath;
  return (
    `shiploop project get: ${detail.project.id} name=${detail.project.displayName} ` +
    `revision=${detail.project.revision} binding=${bindingText}\n`
  );
}

function projectLabelsHumanLine(result: ProjectLabelCountsResult): string {
  const summary =
    result.labels.length === 0
      ? '（无标签）'
      : result.labels.map((entry) => `${entry.label}=${entry.projectCount}`).join(' ');
  return `shiploop project labels: ${summary}\n`;
}

/* ------------------------------------------------------------------ *
 * 写命令：显式 commandId 先查回执、以原 issuedAt 重建同一信封
 * ------------------------------------------------------------------ */

/**
 * 显式 `--command-id` 的重复语义（契约 §5.5「重复提交用同一信封（先查回执）」）：
 * 先按本 principal 查该 commandId 的既有回执；命中则以原 `issuedAt` 作为本次
 * 信封时间（expiresAt 恒缺席），服务端重算摘要后：
 * - 相同参数 → 同摘要 → 重放原回执（replayed:true）；
 * - 不同参数 → 摘要不同 → conflict（idempotency_key_reuse）。
 * 未命中则返回 undefined，由 HostClient 生成一次 issuedAt 并冻结。
 */
async function replayIssuedAt(
  client: HostClient,
  commandId: string | undefined,
): Promise<string | undefined> {
  if (commandId === undefined) {
    return undefined;
  }
  try {
    const receipt = await client.getReceipt(commandId);
    return receipt.issuedAt;
  } catch (error) {
    if (isHostProtocolError(error, 'not_found')) {
      return undefined;
    }
    throw error;
  }
}

async function submitCommandAndEmit(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  client: HostClient,
  input: SubmitCommandInput,
): Promise<AppCliRunResult> {
  const receipt = await client.submitCommand(input);
  if (receipt.status === 'rejected') {
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  const human =
    command.commandId === 'project.edit'
      ? projectEditedHumanLine(receipt)
      : projectRegisteredHumanLine(receipt);
  return emitSuccess(io, command, receipt, human);
}

/* ------------------------------------------------------------------ *
 * 命令分发
 * ------------------------------------------------------------------ */

async function executeProjectCommand(
  io: AppCliIo,
  command: ParsedAppCliCommand,
  client: HostClient,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'project.register': {
      const payload: Record<string, unknown> = {
        repositoryPath: command.repositoryPath,
        displayName: command.displayName,
      };
      if (command.description !== undefined) {
        payload.description = command.description;
      }
      if (command.labels.length > 0) {
        payload.labels = [...command.labels];
      }
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'project.edit': {
      const payload: Record<string, unknown> = {};
      if (command.displayName !== undefined) {
        payload.displayName = command.displayName;
      }
      if (command.description !== undefined) {
        payload.description = command.description;
      }
      if (command.labels !== undefined) {
        payload.labels = [...command.labels];
      }
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId: command.projectId },
        expectedRevision: command.revision,
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'project.list': {
      const result = await client.listProjects({
        ...(command.labels.length > 0 ? { labels: [...command.labels] } : {}),
        match: command.match,
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      return emitSuccess(io, command, result, projectListHumanLine(result));
    }
    case 'project.get': {
      const result = await client.getProject(command.projectId);
      return emitSuccess(io, command, result, projectDetailHumanLine(result));
    }
    case 'project.labels': {
      const result = await client.countProjectLabels();
      return emitSuccess(io, command, result, projectLabelsHumanLine(result));
    }
    default:
      return emitFailure(io, command.json, {
        exitCode: 1,
        command: command.commandId,
        code: 'unsupported',
        message: '该命令由后续任务实现',
      });
  }
}

/**
 * 执行一条应用命令 CLI 意图。解析（纯）→ 平台门禁 → 连接/启动 Host →
 * 命令编排 → §12.3 信封/退出码。返回退出码与（JSON 模式）信封；
 * 调用方（bin.ts）据此退出。
 *
 * F-015 只接线 project.*；config/receipt/events 由 F-016/F-017 扩展，本版
 * 明确返回 `unsupported`（退出码 1），不冒充已实现。
 */
export async function runAppCli(options: RunAppCliOptions): Promise<AppCliRunResult> {
  if (
    options === null ||
    typeof options !== 'object' ||
    options.io === null ||
    typeof options.io !== 'object'
  ) {
    // 入口装配错误：无可用 io 时无法走正常输出；直接抛出，由 bin.ts 兜底。
    throw new HostProtocolError('internal', 'commands.submit', 'CLI 执行选项未通过校验');
  }
  const io = options.io;
  const jsonFlag = Array.isArray(options.args) && options.args.includes('--json');

  let parsed;
  try {
    parsed = parseAppCliArgs(options.args, options.env ?? {});
  } catch (error) {
    if (error instanceof AppCliParseError) {
      const details: Record<string, unknown> = { reason: error.reason };
      if (error.field !== undefined) {
        details.field = error.field;
      }
      const failure: FailureResult = {
        exitCode: 2,
        command: error.commandId,
        code: error.code,
        message: error.message,
        details,
      };
      const json = error.json || jsonFlag;
      const envelope = json
        ? buildAppCliFailureEnvelope(failure.command, failure.code, failure.message, { details })
        : undefined;
      if (envelope !== undefined) {
        io.stdout(`${JSON.stringify(envelope)}\n`);
      }
      io.stderr(formatAppCliParseError(error));
      return {
        exitCode: 2,
        kind: 'failure',
        command: failure.command,
        ...(envelope !== undefined ? { envelope } : {}),
      };
    }
    return emitFailure(io, jsonFlag, {
      exitCode: 2,
      command: null,
      code: 'invalid_input',
      message: '参数解析失败',
    });
  }

  if (parsed.kind === 'help') {
    io.stdout(getAppCliHelp(parsed.scope));
    return { exitCode: CLI_EXIT_OK, kind: 'help', command: null };
  }

  const command: ParsedAppCliCommand = parsed;
  const platform = options.platform ?? process.platform;
  if (platform !== SUPPORTED_PLATFORM) {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'unsupported_platform',
      message: '当前平台不受支持（首版仅正式支持 macOS）',
      details: { reason: 'platform_not_darwin' },
    });
  }

  // F-015 范围：project.* 经 HostClient 接线；其余命令明确 unsupported。
  if (command.command !== 'project') {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'unsupported',
      message: '该命令由后续任务实现',
    });
  }

  let client: HostClient;
  try {
    const ensured = await ensureHostRunning({
      ...rootSource(command.dataRoot, options.userHomeDir),
      platform,
      startBudgetMs: command.startTimeoutMs,
      ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
      ...(options.launch?.entryArgv !== undefined ? { entryArgv: options.launch.entryArgv } : {}),
      ...(options.launch?.nodeExecutable !== undefined
        ? { nodeExecutable: options.launch.nodeExecutable }
        : {}),
      ...(options.launch?.childEnv !== undefined ? { childEnv: options.launch.childEnv } : {}),
      ...(options.launch?.onCandidateSpawned !== undefined
        ? { onCandidateSpawned: options.launch.onCandidateSpawned }
        : {}),
      ...(options.launch?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.launch.pollIntervalMs }
        : {}),
    });
    client = ensured.client;
  } catch (error) {
    if (isHostProtocolError(error)) {
      return emitFailure(io, command.json, protocolFailure(command.commandId, error));
    }
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'internal',
      message: '连接 Host 时发生未预期错误（已脱敏）',
    });
  }

  try {
    return await executeProjectCommand(io, command, client);
  } catch (error) {
    if (isHostProtocolError(error)) {
      return emitFailure(io, command.json, protocolFailure(command.commandId, error));
    }
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'internal',
      message: '执行命令时发生未预期错误（已脱敏）',
    });
  } finally {
    client.close();
  }
}
