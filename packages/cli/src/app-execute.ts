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
import { readFileSync } from 'node:fs';
import {
  ensureHostRunning,
  isHostProtocolError,
  HostProtocolError,
  type HostClient,
  type HostClientTimeouts,
  type SubmitCommandInput,
} from 'shiploop-host';
import { AppCliParseError, parseAppCliArgs, parseAppInputJson } from './app/args.js';
import type {
  AppCliCommandId,
  ParsedAppCliCommand,
  ParsedConfigCreate,
  ParsedConfigUpdate,
  ParsedReceiptGet,
} from './app/args.js';
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
type SettingsStateResult = Awaited<ReturnType<HostClient['getGlobalSettings']>>;
type EffectiveSettingsResult = Awaited<ReturnType<HostClient['getEffectiveSettings']>>;
type ExportedSettingsResult = Awaited<ReturnType<HostClient['exportGlobalSettings']>>;

/** 配置命令（create/update/get/effective/export）的解析形态。 */
type ParsedConfigCommand = Extract<ParsedAppCliCommand, { command: 'config' }>;
/** 携带 scope 的配置命令子集（effective 无 scope）。 */
type ScopedConfigCommand = Extract<ParsedConfigCommand, { scope: 'global' | 'project' }>;

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

/** 解析失败统一出口（退出码 2）：JSON 信封到 stdout（--json），诊断到 stderr。 */
function emitParseFailure(
  io: AppCliIo,
  error: AppCliParseError,
  jsonFlag: boolean,
): AppCliRunResult {
  const details: Record<string, unknown> = { reason: error.reason };
  if (error.field !== undefined) {
    details.field = error.field;
  }
  const json = error.json || jsonFlag;
  const envelope = json
    ? buildAppCliFailureEnvelope(error.commandId, error.code, error.message, { details })
    : undefined;
  if (envelope !== undefined) {
    io.stdout(`${JSON.stringify(envelope)}\n`);
  }
  io.stderr(formatAppCliParseError(error));
  return {
    exitCode: 2,
    kind: 'failure',
    command: error.commandId,
    ...(envelope !== undefined ? { envelope } : {}),
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
 * 配置与回执人类可读行（脱敏；只输出 scope/revision/来源，不打印 payload 值）
 * ------------------------------------------------------------------ */

function scopeText(scope: unknown): string {
  if (scope !== null && typeof scope === 'object') {
    const candidate = scope as { kind?: unknown; projectId?: unknown };
    if (candidate.kind === 'project' && typeof candidate.projectId === 'string') {
      return `project:${candidate.projectId}`;
    }
    if (candidate.kind === 'global') {
      return 'global';
    }
  }
  return 'unknown';
}

function settingsWriteHumanLine(verb: 'create' | 'update', receipt: CompletedReceipt): string {
  const state = receipt.result as
    | { scope?: unknown; revision?: unknown; schemaVersion?: unknown }
    | undefined;
  return (
    `shiploop config ${verb}: ${receipt.status} scope=${scopeText(state?.scope)} ` +
    `schemaVersion=${String(state?.schemaVersion)} revision=${String(state?.revision)}` +
    `${receipt.replayed ? '（replayed）' : ''}\n`
  );
}

function settingsCurrentHumanLine(state: SettingsStateResult): string {
  return (
    `shiploop config get: scope=${scopeText(state.scope)} ` +
    `schemaVersion=${String(state.schemaVersion)} revision=${String(state.revision)}\n`
  );
}

function effectiveSettingsHumanLine(effective: EffectiveSettingsResult): string {
  const strategies = effective.strategies as
    | { defaultStrategy?: unknown; modelMap?: Record<string, unknown>; purposeStrategies?: Record<string, unknown>; agentOverrides?: Record<string, unknown> }
    | undefined;
  const hasDefault = strategies?.defaultStrategy !== undefined;
  const modelCount = Object.keys(strategies?.modelMap ?? {}).length;
  const purposeCount = Object.keys(strategies?.purposeStrategies ?? {}).length;
  const policyCount = Object.keys(effective.policies ?? {}).length;
  return (
    `shiploop config effective: configured=${String(effective.configured)} ` +
    `defaultStrategy=${String(hasDefault)} modelMap=${modelCount} ` +
    `purposeStrategies=${purposeCount} policies=${policyCount}\n`
  );
}

function exportedSettingsHumanLine(exported: ExportedSettingsResult): string {
  const current = exported.current as { revision?: unknown } | undefined;
  return (
    `shiploop config export: scope=${exported.scope} ` +
    `format=${String(exported.exportFormatVersion)} revision=${String(current?.revision)}\n`
  );
}

function receiptHumanLine(receipt: CommandReceipt): string {
  const reference = receipt.status === 'completed' ? ` resultRef=${receipt.resultRef}` : '';
  return (
    `shiploop receipt get: ${receipt.status} commandId=${receipt.commandId} ` +
    `operation=${receipt.operation}${reference}\n`
  );
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
  return emitSuccess(io, command, receipt, writeCommandHumanLine(command.commandId, receipt));
}

/** 写命令 completed 回执的人类行（按命令身份分派；只输出脱敏字段）。 */
function writeCommandHumanLine(commandId: AppCliCommandId, receipt: CompletedReceipt): string {
  switch (commandId) {
    case 'project.register':
      return projectRegisteredHumanLine(receipt);
    case 'project.edit':
      return projectEditedHumanLine(receipt);
    case 'config.create':
      return settingsWriteHumanLine('create', receipt);
    case 'config.update':
      return settingsWriteHumanLine('update', receipt);
    default:
      return `shiploop ${commandId}: ${receipt.status}\n`;
  }
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

/* ------------------------------------------------------------------ *
 * 配置命令（F-016）
 * ------------------------------------------------------------------ */

/** 配置命令 scope 映射（project 分支的 projectId 已由纯解析层校验）。 */
function configScope(
  command: ScopedConfigCommand,
): { kind: 'global' } | { kind: 'project'; projectId: string } {
  if (command.scope === 'global') {
    return { kind: 'global' };
  }
  return { kind: 'project', projectId: command.projectId as string };
}

/**
 * 读取 `--input <file>` 文本并解析为 JSON 普通对象。文件读取是显式命令输入
 * （不是结果读取，不接受任意 Core 数据库/结果路径）；缺失/不可读/畸形 JSON
 * 一律在连接 Host 之前以退出码 2 拒绝。
 */
function readConfigInputPayload(
  command: ParsedConfigCreate | ParsedConfigUpdate,
): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(command.inputFile, 'utf8');
  } catch {
    throw new AppCliParseError(
      'invalid_input',
      'invalid_input_file',
      { command: command.command, commandId: command.commandId, json: command.json },
      'input',
    );
  }
  return parseAppInputJson(text, { commandId: command.commandId, json: command.json });
}

async function executeConfigCommand(
  io: AppCliIo,
  command: ParsedConfigCommand,
  client: HostClient,
  payload: Record<string, unknown>,
): Promise<AppCliRunResult> {
  switch (command.commandId) {
    case 'config.create': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: command.operation,
        scope: configScope(command),
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'config.update': {
      const issuedAt = await replayIssuedAt(client, command.explicitCommandId);
      const input: SubmitCommandInput = {
        operation: command.operation,
        scope: configScope(command),
        expectedRevision: command.revision,
        payload,
        ...(command.explicitCommandId !== undefined ? { commandId: command.explicitCommandId } : {}),
        ...(issuedAt !== undefined ? { issuedAt } : {}),
      };
      return submitCommandAndEmit(io, command, client, input);
    }
    case 'config.get': {
      const result =
        command.scope === 'global'
          ? await client.getGlobalSettings()
          : await client.getProjectSettings(command.projectId as string);
      return emitSuccess(io, command, result, settingsCurrentHumanLine(result));
    }
    case 'config.effective': {
      const result = await client.getEffectiveSettings(command.projectId);
      return emitSuccess(io, command, result, effectiveSettingsHumanLine(result));
    }
    case 'config.export': {
      const result =
        command.scope === 'global'
          ? await client.exportGlobalSettings()
          : await client.exportProjectSettings(command.projectId as string);
      return emitSuccess(io, command, result, exportedSettingsHumanLine(result));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 回执读取（F-016）
 * ------------------------------------------------------------------ */

async function executeReceiptCommand(
  io: AppCliIo,
  command: ParsedReceiptGet,
  client: HostClient,
): Promise<AppCliRunResult> {
  const receipt = await client.getReceipt(command.targetCommandId);
  if (receipt.status === 'rejected') {
    // 回执固化的是原命令的业务拒绝；按 §12.3 退出码 1 展示，不重发副作用。
    return emitFailure(io, command.json, {
      exitCode: exitCodeForReceiptStatus('rejected'),
      command: command.commandId,
      code: receipt.error.code,
      message: receipt.error.message,
      commandId: receipt.commandId,
      ...(receipt.error.details !== undefined ? { details: receipt.error.details } : {}),
    });
  }
  return emitSuccess(io, command, receipt, receiptHumanLine(receipt));
}

/**
 * 执行一条应用命令 CLI 意图。解析（纯）→ 平台门禁 → 配置输入文件读取 →
 * 连接/启动 Host → 命令编排 → §12.3 信封/退出码。返回退出码与（JSON 模式）
 * 信封；调用方（bin.ts）据此退出。
 *
 * F-015 接线 project.* ，F-016 接线 config.* 与 receipt.get；events 观察由 F-017
 * 实现，本版明确返回 `unsupported`（退出码 1），不冒充已实现。
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
      return emitParseFailure(io, error, jsonFlag);
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

  // F-015/F-016 范围：project.*、config.*、receipt.get 经 HostClient 接线；
  // events 观察由 F-017 实现，本版明确 unsupported。
  if (
    command.command !== 'project' &&
    command.command !== 'config' &&
    command.command !== 'receipt'
  ) {
    return emitFailure(io, command.json, {
      exitCode: 1,
      command: command.commandId,
      code: 'unsupported',
      message: '该命令由后续任务实现',
    });
  }

  // 配置输入文件在连接 Host 之前读取/解析：缺失/畸形 JSON 以退出码 2 拒绝，
  // 不发现 Host、不联网、不启动进程（与纯解析失败同一纪律）。
  let configPayload: Record<string, unknown> | undefined;
  if (command.commandId === 'config.create' || command.commandId === 'config.update') {
    try {
      configPayload = readConfigInputPayload(command);
    } catch (error) {
      if (error instanceof AppCliParseError) {
        return emitParseFailure(io, error, jsonFlag);
      }
      return emitFailure(io, command.json, {
        exitCode: 2,
        command: command.commandId,
        code: 'invalid_input',
        message: '输入文件读取失败',
      });
    }
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
    if (command.command === 'config') {
      return await executeConfigCommand(io, command, client, configPayload as Record<string, unknown>);
    }
    if (command.command === 'receipt') {
      return await executeReceiptCommand(io, command, client);
    }
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
