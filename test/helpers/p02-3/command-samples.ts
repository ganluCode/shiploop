/**
 * F-003 P02-3 基线命令样例描述符（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 把 command-scripts/*.mjs 这组「实际 Node 命令」绑定到 §8.3 三轴状态模型：
 * 每个样例声明它应当被归类到的检查业务状态与原因码，供 F-004 基线执行器
 * 与 F-003 夹具自测共同引用（单一事实来源，避免测试里散落魔法字符串）。
 *
 * 覆盖（F-003 验收 2）：
 * - success（exit-zero）→ passed；
 * - nonzeroExit（exit-nonzero）→ failed（有真实非零退出码，无原因码）；
 * - missingCommand（不存在的可执行文件）→ error + missing_command；
 * - unknownPackageScript（node --run 未知脚本）→ error + unknown_script；
 * - hang（挂起）→ inconclusive + timed_out；
 * - ignoreSigterm（忽略 SIGTERM）→ inconclusive + stop_unconfirmed；
 * - spawnWriter（派生持续写入子进程）→ inconclusive + stop_unconfirmed；
 * - largeOutput（大量 stdout/stderr）→ inconclusive + output_overflow；
 * - modifySource（运行期间修改受检源码）→ inconclusive + source_changed；
 * - maliciousInit（初始化脚本仅写临时哨兵）→ 由调用方断言「静态 inspect 绝不执行」。
 *
 * 期望状态由 ports/baseline.ts 的 baselineCheckStatusForReason 派生，与产品
 * 契约保持同一映射；成功/非零退出这两个「有确定退出码」的样例不携带原因码。
 *
 * 安全约束：只描述 argv，不读凭据、不联网、不调用模型；样例脚本本身的行为
 * 被刻意限制（只写临时哨兵 / 只追加受检文件），见 command-scripts/ 各文件头。
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_CHECK_TIMEOUT_DEFAULT_MS,
  baselineCheckStatusForReason,
} from '../../../packages/core/src/ports/baseline.ts';
import type {
  BaselineCheck,
  BaselineCheckStatus,
  BaselineReasonCode,
} from '../../../packages/core/src/ports/baseline.ts';

/** command-scripts 目录绝对路径（样例脚本真实位置）。 */
export const COMMAND_SAMPLE_SCRIPTS_DIR = fileURLToPath(
  new URL('./command-scripts/', import.meta.url),
);

function scriptPath(fileName: string): string {
  return join(COMMAND_SAMPLE_SCRIPTS_DIR, fileName);
}

/** 样例脚本绝对路径（供需要直接 spawn 的调用方引用）。 */
export const COMMAND_SAMPLE_SCRIPT = Object.freeze({
  exitZero: scriptPath('exit-zero.mjs'),
  exitNonzero: scriptPath('exit-nonzero.mjs'),
  hang: scriptPath('hang.mjs'),
  ignoreSigterm: scriptPath('ignore-sigterm.mjs'),
  spawnWriter: scriptPath('spawn-writer.mjs'),
  persistentWriterChild: scriptPath('persistent-writer-child.mjs'),
  largeOutput: scriptPath('large-output.mjs'),
  modifySource: scriptPath('modify-source.mjs'),
  maliciousInit: scriptPath('malicious-init.mjs'),
});

/** 缺命令样例使用的可执行文件：确定性且显然不存在（自测先核验其确实缺失）。 */
export const MISSING_COMMAND_EXECUTABLE = join(
  tmpdir(),
  'shiploop-p02-3-missing-command-does-not-exist',
);

/** 未知 package script 样例的脚本名（仓库内不存在的 script）。 */
export const UNKNOWN_PACKAGE_SCRIPT = 'shiploop-p02-3-does-not-exist';

/** 非零退出样例默认退出码（可用 argv[2] 覆盖）。 */
export const NONZERO_EXIT_CODE = 3;

export function isMissingCommandExecutableAbsent(): boolean {
  return !existsSync(MISSING_COMMAND_EXECUTABLE);
}

export type CommandSampleKey =
  | 'success'
  | 'nonzeroExit'
  | 'missingCommand'
  | 'unknownPackageScript'
  | 'hang'
  | 'ignoreSigterm'
  | 'spawnWriter'
  | 'largeOutput'
  | 'modifySource';

export type CommandSampleKind =
  /** 直接以 node 运行受控脚本（argv[0]=execPath）。 */
  | 'node-script'
  /** argv[0] 指向不存在的可执行文件。 */
  | 'missing-binary'
  /** 在含 package.json 的仓库内 `node --run <未知脚本>`。 */
  | 'unknown-package-script';

export interface CommandSample {
  readonly key: CommandSampleKey;
  /** 规范 checkKey（§6.1 ^[a-z0-9][a-z0-9_-]{0,63}$，由 key 派生为 kebab-case）。 */
  readonly checkKey: string;
  readonly kind: CommandSampleKind;
  readonly description: string;
  /** 期望的检查业务状态（§8.3）。 */
  readonly expectedStatus: BaselineCheckStatus;
  /** 期望的原因码（成功/非零退出为 undefined）。 */
  readonly expectedReason?: BaselineReasonCode;
  /** 运行是否改写受检仓库工作区（source_changed 类样例）。 */
  readonly mutatesRepository: boolean;
  /**
   * 构造完整 argv。node-script 样例的 args 追加在脚本之后；
   * missing-binary 忽略 args；unknown-package-script 的 args[0] 覆盖脚本名。
   */
  argv(args?: readonly string[]): string[];
}

function nodeScript(argvArgs: readonly string[] | undefined, script: string): string[] {
  return [process.execPath, script, ...(argvArgs ?? [])];
}

/** 由 camelCase key 派生规范 checkKey（§6.1 只允许小写、数字、`_`、`-`）。 */
function checkKeyFor(key: CommandSampleKey): string {
  return key.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);
}

function sample(
  key: CommandSampleKey,
  kind: CommandSampleKind,
  description: string,
  expected: { status: BaselineCheckStatus; reason?: BaselineReasonCode },
  mutatesRepository: boolean,
  argv: (args?: readonly string[]) => string[],
): CommandSample {
  return Object.freeze({
    key,
    checkKey: checkKeyFor(key),
    kind,
    description,
    expectedStatus: expected.status,
    expectedReason: expected.reason,
    mutatesRepository,
    argv,
  });
}

const SUCCESS: { status: BaselineCheckStatus } = { status: 'passed' };
const NONZERO: { status: BaselineCheckStatus } = { status: 'failed' };
const MISSING_COMMAND = { status: baselineCheckStatusForReason('missing_command')!, reason: 'missing_command' as const };
const UNKNOWN_SCRIPT = { status: baselineCheckStatusForReason('unknown_script')!, reason: 'unknown_script' as const };
const TIMED_OUT = { status: baselineCheckStatusForReason('timed_out')!, reason: 'timed_out' as const };
const STOP_UNCONFIRMED = { status: baselineCheckStatusForReason('stop_unconfirmed')!, reason: 'stop_unconfirmed' as const };
const OUTPUT_OVERFLOW = { status: baselineCheckStatusForReason('output_overflow')!, reason: 'output_overflow' as const };
const SOURCE_CHANGED = { status: baselineCheckStatusForReason('source_changed')!, reason: 'source_changed' as const };

/** 全部命令样例（冻结；键与 CommandSampleKey 一一对应）。 */
export const COMMAND_SAMPLES: Readonly<Record<CommandSampleKey, CommandSample>> = Object.freeze({
  success: sample(
    'success',
    'node-script',
    '成功命令：写出 sample-ok 并以退出码 0 结束',
    SUCCESS,
    false,
    (args) => nodeScript(args, COMMAND_SAMPLE_SCRIPT.exitZero),
  ),
  nonzeroExit: sample(
    'nonzeroExit',
    'node-script',
    `非零退出：以 argv[2]（默认 ${NONZERO_EXIT_CODE}）作为退出码`,
    NONZERO,
    false,
    (args) => nodeScript(args ?? [String(NONZERO_EXIT_CODE)], COMMAND_SAMPLE_SCRIPT.exitNonzero),
  ),
  missingCommand: sample(
    'missingCommand',
    'missing-binary',
    '缺命令：argv[0] 指向不存在的可执行文件（spawn ENOENT）',
    MISSING_COMMAND,
    false,
    () => [MISSING_COMMAND_EXECUTABLE, '--version'],
  ),
  unknownPackageScript: sample(
    'unknownPackageScript',
    'unknown-package-script',
    '未知 package script：node --run <不存在的 script>（须在含 package.json 的仓库内运行）',
    UNKNOWN_SCRIPT,
    false,
    (args) => [process.execPath, '--run', args?.[0] ?? UNKNOWN_PACKAGE_SCRIPT],
  ),
  hang: sample(
    'hang',
    'node-script',
    '挂起命令：永不退出（由监督方按超时判 timed_out）',
    TIMED_OUT,
    false,
    (args) => nodeScript(args, COMMAND_SAMPLE_SCRIPT.hang),
  ),
  ignoreSigterm: sample(
    'ignoreSigterm',
    'node-script',
    '忽略 SIGTERM：需升级到 SIGKILL 才能停止（stop_unconfirmed 场景）',
    STOP_UNCONFIRMED,
    false,
    (args) => nodeScript(args, COMMAND_SAMPLE_SCRIPT.ignoreSigterm),
  ),
  spawnWriter: sample(
    'spawnWriter',
    'node-script',
    '派生持续写入子进程并挂起：杀父进程不停孙进程，须核验整棵进程树',
    STOP_UNCONFIRMED,
    false,
    (args) => nodeScript(args, COMMAND_SAMPLE_SCRIPT.spawnWriter),
  ),
  largeOutput: sample(
    'largeOutput',
    'node-script',
    '大量输出：argv[2]/argv[3] 控制 stdout/stderr 字节数（触发有界采集/溢出）',
    OUTPUT_OVERFLOW,
    false,
    (args) => nodeScript(args, COMMAND_SAMPLE_SCRIPT.largeOutput),
  ),
  modifySource: sample(
    'modifySource',
    'node-script',
    '修改受检源码：运行期间向 argv[2] 追加内容（执行后复核代码身份应发现变化）',
    SOURCE_CHANGED,
    true,
    (args) => nodeScript(args, COMMAND_SAMPLE_SCRIPT.modifySource),
  ),
});

export interface CommandSampleCheckOptions {
  /** 检查键（默认取样例的规范 checkKey，匹配 §6.1 ^[a-z0-9][a-z0-9_-]{0,63}$）。 */
  readonly checkKey?: string;
  /** 是否必需（默认 true）。 */
  readonly required?: boolean;
  /** 超时（默认契约默认值）；hang/ignore-sigterm/spawn-writer 样例通常显式给较小值。 */
  readonly timeoutMs?: number;
  /** 仓库内相对子目录（§6.1 cwdRef）。 */
  readonly cwdRef?: string;
  /** 透传给 argv 构造。 */
  readonly args?: readonly string[];
}

/**
 * 由样例 key 构造规范 BaselineCheck（§6.1）。纯函数：只组装 argv/超时，
 * 不做 I/O；运行与状态判定由 F-004 执行器负责。
 */
export function commandSampleCheck(
  key: CommandSampleKey,
  options: CommandSampleCheckOptions = {},
): BaselineCheck {
  const descriptor = COMMAND_SAMPLES[key];
  const check: BaselineCheck = {
    checkKey: options.checkKey ?? descriptor.checkKey,
    kind: 'command',
    argv: descriptor.argv(options.args),
    timeoutMs: options.timeoutMs ?? BASELINE_CHECK_TIMEOUT_DEFAULT_MS,
    required: options.required ?? true,
    ...(options.cwdRef !== undefined ? { cwdRef: options.cwdRef } : {}),
  };
  return check;
}

/** 样例期望结果（状态 + 原因码），供断言比对。 */
export function commandSampleExpectation(key: CommandSampleKey): {
  status: BaselineCheckStatus;
  reason?: BaselineReasonCode;
} {
  const descriptor = COMMAND_SAMPLES[key];
  return {
    status: descriptor.expectedStatus,
    ...(descriptor.expectedReason !== undefined ? { reason: descriptor.expectedReason } : {}),
  };
}

/** 全部样例 key（稳定顺序，便于参数化测试）。 */
export const COMMAND_SAMPLE_KEYS: readonly CommandSampleKey[] = Object.freeze([
  'success',
  'nonzeroExit',
  'missingCommand',
  'unknownPackageScript',
  'hang',
  'ignoreSigterm',
  'spawnWriter',
  'largeOutput',
  'modifySource',
]);
