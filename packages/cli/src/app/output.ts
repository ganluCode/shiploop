/**
 * F-014 应用命令 JSON 信封、观察中断退出码与脱敏诊断（纯模块，无 I/O）。
 *
 * 复用 P02-1 的 `{ok,command,result|error}` 信封与 0/1/2/3 四档粗分类；
 * P02-2 在其上追加第五档退出码 4（观察中断），只对 `observation_interrupted`/
 * `stream_overflow` 生效。失败信封保留 commandId，便于按 commandId 查回执。
 */
import type { AppCliCommandId, AppCliParseError } from './args.js';
import {
  CLI_EXIT_OK,
  CLI_EXIT_REJECTED,
  exitCodeForHostErrorCode,
} from '../host/output.js';
import type { CliExitCode } from '../host/output.js';

/** §12.3 第五档：观察中断（Ctrl+C/Abort/观察超时/stream_overflow）。 */
export const CLI_EXIT_OBSERVATION_INTERRUPTED = 4 as const;

/** 只结束本次观察、不代表命令失败或取消的结束码。 */
const OBSERVATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'observation_interrupted',
  'stream_overflow',
]);

/** 应用命令成功信封：`{ ok:true, command, result }`。 */
export interface AppCliSuccessEnvelope<Result> {
  readonly ok: true;
  readonly command: AppCliCommandId;
  readonly result: Result;
}

/** 应用命令失败信封；命令未知时 command=null，commandId 用于查回执。 */
export interface AppCliFailureEnvelope {
  readonly ok: false;
  readonly command: AppCliCommandId | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly commandId?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function buildAppCliSuccessEnvelope<Result>(
  command: AppCliCommandId,
  result: Result,
): AppCliSuccessEnvelope<Result> {
  return { ok: true, command, result };
}

export function buildAppCliFailureEnvelope(
  command: AppCliCommandId | null,
  code: string,
  message: string,
  options: {
    readonly commandId?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {},
): AppCliFailureEnvelope {
  const error: {
    code: string;
    message: string;
    commandId?: string;
    details?: Readonly<Record<string, unknown>>;
  } = { code, message };
  if (options.commandId !== undefined) {
    error.commandId = options.commandId;
  }
  if (options.details !== undefined && Object.keys(options.details).length > 0) {
    error.details = options.details;
  }
  return { ok: false, command, error };
}

/**
 * 应用错误码 → 退出码：观察中断/溢出为第五档 4；其余复用 P02-1 四档粗分类
 *（未知码 fail-closed 归入 1）。
 */
export function exitCodeForAppErrorCode(code: string): CliExitCode {
  if (OBSERVATION_ERROR_CODES.has(code)) {
    return CLI_EXIT_OBSERVATION_INTERRUPTED;
  }
  return exitCodeForHostErrorCode(code);
}

/**
 * 命令回执状态 → 退出码：只有 `completed` 是成功（0）；`accepted` 不是完成，
 * `rejected` 是业务拒绝，均为 1。
 */
export function exitCodeForReceiptStatus(
  status: 'accepted' | 'completed' | 'rejected',
): typeof CLI_EXIT_OK | typeof CLI_EXIT_REJECTED {
  return status === 'completed' ? CLI_EXIT_OK : CLI_EXIT_REJECTED;
}

/**
 * 解析失败的人类诊断（stderr）：单行、以换行结尾，只含 code/reason/参数名等
 * 受控字段，绝不回显参数值。
 */
export function formatAppCliParseError(error: AppCliParseError): string {
  const field = error.field !== undefined ? `（${error.field}）` : '';
  return `shiploop: ${error.code}: ${error.reason}${field}：${error.message}\n`;
}
