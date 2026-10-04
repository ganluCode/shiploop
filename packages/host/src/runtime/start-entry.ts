/**
 * F-006 Host 显式启动入口（契约 §13.1：`node …/dist/start.js --data-root <abs>`，
 * 只接受受控 argv，无 shell）。
 *
 * - parseHostStartArgv：纯解析（无 I/O），与执行分离；监听地址覆盖参数
 *   （--bind/--host/--hostname/--address/--port/--listen*）零容忍 →
 *   bind_address_override_rejected；未知参数/缺值/相对数据根/重复 → invalid_input；
 * - runHostStartEntry：解析失败退出码 2 且零文件副作用；启动失败按错误码
 *   1（业务/平台/锁）或 2（输入）；成功打印单行脱敏 JSON 到 stdout
 *   （{ ok:true, command:'host.start', result } —— 绝不含凭据），诊断 JSON 到
 *   stderr；未预期错误只报 generic internal，不回显原始消息（可能含路径/秘密）。
 *
 * import 本模块无副作用：只有 runHostStartEntry 显式调用才启动 Host。
 */
import { isAbsolute } from 'node:path';
import { createStaticRuntimeCapabilityCatalog } from 'shiploop-core';
import { HostProtocolError, isHostProtocolError } from '../contract/index.js';
import type { LifecycleState } from '../contract/index.js';
import { startHost } from './host-startup.js';
import type { HostStartOptions, RunningHost } from './host-startup.js';

const OPERATION = 'host.discovery';

export const HOST_START_ENTRY_USAGE =
  'usage: node start.js [--data-root <abs>] [--help]\n' +
  '  --data-root <abs>  规范数据根（POSIX 绝对路径；省略 = P01 默认根）\n' +
  '  --help             显示本说明\n' +
  'Host 只监听 127.0.0.1（随机端口），不提供公网监听能力；首版仅正式支持 macOS。';

export interface ParsedHostStartArgv {
  readonly help: boolean;
  readonly dataRoot?: string;
}

const LISTEN_OVERRIDE_ARGV_PREFIXES = [
  '--bind',
  '--host',
  '--hostname',
  '--address',
  '--port',
  '--listen',
] as const;

function isListenOverrideArgument(argument: string): boolean {
  return LISTEN_OVERRIDE_ARGV_PREFIXES.some(
    (prefix) => argument === prefix || argument.startsWith(`${prefix}=`) || argument.startsWith(`${prefix}-`),
  );
}

function invalidArgv(reason: string): HostProtocolError {
  return new HostProtocolError('invalid_input', OPERATION, 'Host 启动入口参数未通过校验', {
    details: { reason },
  });
}

/**
 * 纯解析受控 argv（process.argv.slice(2) 形态）；拒绝时抛 HostProtocolError，
 * 不产生任何 I/O。参数值（可能是路径）绝不进入错误 details。
 */
export function parseHostStartArgv(args: readonly string[]): ParsedHostStartArgv {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw invalidArgv('invalid_argv_type');
  }
  let dataRoot: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (isListenOverrideArgument(argument)) {
      throw new HostProtocolError(
        'bind_address_override_rejected',
        OPERATION,
        '拒绝监听地址覆盖参数：Host 只监听 127.0.0.1，不提供公网监听能力',
        { details: { reason: 'listen_override_argument_rejected' } },
      );
    }
    if (argument === '--data-root') {
      if (dataRoot !== undefined) {
        throw invalidArgv('duplicate_data_root');
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw invalidArgv('missing_data_root_value');
      }
      if (value.includes('\0') || !isAbsolute(value)) {
        throw invalidArgv('data_root_not_absolute');
      }
      dataRoot = value;
      index += 1;
      continue;
    }
    throw invalidArgv('unknown_argument');
  }
  return { help, dataRoot };
}

export interface HostStartEntryIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** 受信测试注入（锁预算/原生适配器路径/能力目录）；绝非 argv/env 行为。 */
export interface HostStartEntryOverrides {
  readonly startOptions?: Partial<
    Pick<HostStartOptions, 'lockTimeoutMs' | 'nativeAddonPath' | 'capabilityCatalog'>
  >;
}

/** 入口成功结果（脱敏；凭据只留在 0600 文件与 Bearer 头通道）。 */
export interface HostStartEntrySuccessResult {
  readonly hostInstanceId: string;
  readonly listenAddress: '127.0.0.1';
  readonly port: number;
  readonly pid: number;
  readonly dataRootIdentity: string;
  readonly startedAt: string;
  readonly lifecycleState: LifecycleState;
}

export interface HostStartEntryOutcome {
  readonly exitCode: number;
  /** 成功时的脱敏结果（即 stdout 打印的 result）。 */
  readonly result?: HostStartEntrySuccessResult;
  /** 成功时持有运行中的 Host（进程须保持存活）；失败为 undefined。 */
  readonly host?: RunningHost;
}

function emitError(io: HostStartEntryIo, code: string, message: string): void {
  io.stderr(
    JSON.stringify({
      ok: false,
      command: 'host.start',
      error: { code, message, operation: OPERATION },
    }),
  );
}

/**
 * 执行 Host 启动入口：解析（零 I/O）→ startHost。返回退出码与（成功时）
 * RunningHost；调用方负责保持进程存活（监听句柄维持事件循环）。
 */
export async function runHostStartEntry(
  argv: readonly string[],
  io: HostStartEntryIo,
  overrides?: HostStartEntryOverrides,
): Promise<HostStartEntryOutcome> {
  let parsed: ParsedHostStartArgv;
  try {
    parsed = parseHostStartArgv(argv.slice(2));
  } catch (error) {
    if (isHostProtocolError(error)) {
      emitError(io, error.code, error.message);
      return { exitCode: 2 };
    }
    emitError(io, 'invalid_input', 'Host 启动入口参数未通过校验');
    return { exitCode: 2 };
  }
  if (parsed.help) {
    io.stdout(HOST_START_ENTRY_USAGE);
    return { exitCode: 0 };
  }

  const startOptions: HostStartOptions = {
    ...(overrides?.startOptions ?? {}),
    ...(parsed.dataRoot !== undefined ? { dataRoot: parsed.dataRoot } : {}),
    // 空能力目录：不装配任何 runtime/Pi/模型执行；Core 配置校验 fail-closed。
    capabilityCatalog:
      overrides?.startOptions?.capabilityCatalog ?? createStaticRuntimeCapabilityCatalog([]),
  };
  try {
    const host = await startHost(startOptions);
    const result: HostStartEntrySuccessResult = {
      hostInstanceId: host.hostInstanceId,
      listenAddress: host.listenAddress,
      port: host.port,
      pid: host.pid,
      dataRootIdentity: host.dataRootIdentity,
      startedAt: host.startedAt,
      lifecycleState: host.lifecycleState,
    };
    io.stdout(JSON.stringify({ ok: true, command: 'host.start', result }));
    return { exitCode: 0, result, host };
  } catch (error) {
    if (isHostProtocolError(error)) {
      emitError(io, error.code, error.message);
      return {
        exitCode:
          error.code === 'invalid_input' || error.code === 'bind_address_override_rejected' ? 2 : 1,
      };
    }
    // 未预期错误（如 Core StorageError）：不回显原始消息（可能含路径/内部细节）。
    const storageError = isStorageErrorLike(error);
    const code = storageError !== false ? storageError.kind : 'internal';
    emitError(io, code, 'Host 启动失败（详见 Host 诊断；错误不含秘密）');
    return { exitCode: 1 };
  }
}

/** Core 结构化错误的窄判定（kind 是受控枚举，可安全上报为 code）。 */
function isStorageErrorLike(error: unknown): { kind: string } | false {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const kind = (error as { kind?: unknown }).kind;
  const name = (error as { name?: unknown }).name;
  return name === 'StorageError' && typeof kind === 'string' && /^[a-z_]+$/.test(kind)
    ? { kind }
    : false;
}
