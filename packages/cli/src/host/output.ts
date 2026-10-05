/**
 * F-011 CLI JSON 信封、脱敏纪律与 §13.3 四档退出码（纯模块，无 I/O）。
 *
 * 路由纪律（F-012 显式入口接线，本模块只冻结形状）：
 * - --json 时 stdout 只输出一个可解析 JSON 对象（成功/失败信封）；
 * - 人类诊断（含解析失败的非 JSON 形态）全部走 stderr；
 * - 细分原因只看 error.code；退出码只做 0/1/2/3 四档粗分类。
 */
import type { HostCliCommandId, HostCliParseError } from './args.js';

/** §13.3 退出码：成功。 */
export const CLI_EXIT_OK = 0;
/** §13.3 退出码：业务拒绝 / 操作失败。 */
export const CLI_EXIT_REJECTED = 1;
/** §13.3 退出码：输入错误（参数/本地不安全发现/监听覆盖）。 */
export const CLI_EXIT_INPUT = 2;
/** §13.3 退出码：连接 / 协议错误。 */
export const CLI_EXIT_CONNECTION = 3;

export type CliExitCode = 0 | 1 | 2 | 3;

/**
 * 退出码 2：本地输入问题（尚未联网）。
 * - invalid_input：参数解析失败 / 客户端本地选项校验；
 * - unsafe_discovery / invalid_discovery：发现或凭据文件本地校验失败；
 * - bind_address_override_rejected：监听地址覆盖参数/env。
 */
const INPUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_input',
  'unsafe_discovery',
  'invalid_discovery',
  'bind_address_override_rejected',
]);

/**
 * 退出码 3：连接 / 协议错误（对端或网络层）。
 * 注意 unsupported_schema_version 在线消息上来自对端，按协议错误归类；
 * 本地发现文件的未知 schema 由 F-002 定案为 invalid_discovery（退出码 2）。
 */
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'host_not_found',
  'unreachable',
  'response_malformed',
  'redirect_rejected',
  'start_timeout',
  'protocol_incompatible',
  'unsupported_schema_version',
]);

/**
 * §13.3 错误码 → 退出码粗分类。未知错误码 fail-closed 归入 1
 * （操作失败），绝不折算为 0/2/3；新增协议错误码时必须在此显式归类。
 */
export function exitCodeForHostErrorCode(code: string): 1 | 2 | 3 {
  if (INPUT_ERROR_CODES.has(code)) {
    return CLI_EXIT_INPUT;
  }
  if (CONNECTION_ERROR_CODES.has(code)) {
    return CLI_EXIT_CONNECTION;
  }
  return CLI_EXIT_REJECTED;
}

/** §13.3 成功信封：`{ ok:true, command, result }`。 */
export interface HostCliSuccessEnvelope<Result> {
  readonly ok: true;
  readonly command: HostCliCommandId;
  readonly result: Result;
}

/** §13.3 失败信封：`{ ok:false, command, error }`；命令未知时 command=null。 */
export interface HostCliFailureEnvelope {
  readonly ok: false;
  readonly command: HostCliCommandId | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function buildHostCliSuccessEnvelope<Result>(
  command: HostCliCommandId,
  result: Result,
): HostCliSuccessEnvelope<Result> {
  return { ok: true, command, result };
}

export function buildHostCliFailureEnvelope(
  command: HostCliCommandId | null,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): HostCliFailureEnvelope {
  const error: HostCliFailureEnvelope['error'] = { code, message };
  if (details !== undefined && Object.keys(details).length > 0) {
    (error as { details?: Readonly<Record<string, unknown>> }).details = details;
  }
  return { ok: false, command, error };
}

/**
 * 解析失败的人类诊断（非 --json，stderr）：单行、以换行结尾，
 * 只含 code/reason/参数名等受控字段，绝不回显参数值。
 */
export function formatHostCliParseError(error: HostCliParseError): string {
  const field = error.field !== undefined ? `（${error.field}）` : '';
  return `shiploop: ${error.code}: ${error.reason}${field}：${error.message}\n`;
}
