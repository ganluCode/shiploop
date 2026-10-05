/**
 * F-011 CLI 帮助文本（契约 §13.1/§13.3）。
 *
 * 纯字符串常量：不读环境、不读文件、不格式化用户输入。帮助必须准确传达：
 * - 退出 CLI 客户端不会停止 Host（Host 是独立后台进程，停止只能显式
 *   `shiploop host stop`）；
 * - 首版仅正式支持 macOS，且只面向可信本机单用户场景；
 * - 发现文件中的本机 token 不防御同一操作系统用户下的恶意进程；
 * - 退出码四档语义（0/1/2/3）。
 */
import type { HelpScope } from './args.js';

const BOUNDARY_BLOCK = [
  '边界：',
  '- 退出 CLI 客户端不会停止 Host：Host 是独立后台进程，只有显式 `shiploop host stop` 才会停止。',
  '- 首版仅正式支持 macOS，且仅面向可信本机单用户场景；Host 固定监听 127.0.0.1 随机端口。',
  '- 发现文件中的本机 token 不防御同一操作系统用户下的恶意进程，只防未授权的本机读取。',
].join('\n');

const EXIT_CODE_BLOCK = [
  '退出码：0 成功；1 业务拒绝/操作失败；2 输入错误（含监听地址覆盖）；3 连接/协议错误。',
  'JSON 模式（--json）下 stdout 只输出一个 JSON 对象；人类诊断输出到 stderr。',
].join('\n');

const TOP_HELP = [
  'usage: shiploop --help',
  '       shiploop host <start|status|stop> [options]',
  '',
  'Host 生命周期命令：',
  '  host start    连接已运行的 Host；无实例时启动本机 Host 并完成握手',
  '  host status   查询当前 Host 的生命周期状态（只读；不启动 Host）',
  '  host stop     显式请求当前 Host 停止，并等待进程退出/释锁/发现移除证据',
  '',
  '查看各命令参数：shiploop host start --help（或 status/stop --help）',
  '',
  BOUNDARY_BLOCK,
  '- 本版本仅提供 Host 生命周期命令，没有 project/run 等命令。',
  '',
].join('\n');

const HOST_HELP = [
  'usage: shiploop host <start|status|stop> [options]',
  '       shiploop host --help',
  '',
  '通用选项：',
  '  --data-root <abs>  规范数据根（POSIX 绝对路径；省略 = P01 默认根；仅 start 允许创建根）',
  '  --json             stdout 只输出单个 JSON 对象（人类诊断输出到 stderr）',
  '',
  '  start  连接既有 Host，无实例时启动；另支持 --start-timeout-ms',
  '  status 只读查询当前 Host；不启动 Host、不触发停止',
  '  stop   显式停止当前 Host；另支持 --stop-command-id、--confirm-timeout-ms',
  '',
  BOUNDARY_BLOCK,
  EXIT_CODE_BLOCK,
  '',
].join('\n');

const START_HELP = [
  'usage: shiploop host start [--data-root <abs>] [--json] [--start-timeout-ms <int>]',
  '',
  '连接已运行的 Host（同一 hostInstanceId）；无实例时仅经正式获锁入口启动一个',
  '本机 Host 并完成握手。重复 start 连接同一实例，不会启动第二个写入者。',
  '',
  '选项：',
  '  --data-root <abs>           规范数据根（POSIX 绝对路径，不能为 /；省略 = P01 默认根）',
  '  --json                      stdout 只输出结果 JSON；诊断到 stderr',
  '  --start-timeout-ms <int>    启动/重新发现预算，默认 15000，允许 1000..60000',
  '',
  '监听地址不可配置：任何 --bind/--host/--address/--port/--listen* 参数与',
  'SHIPLOOP_HOST_BIND/HOST/PORT/ADDRESS/LISTEN* 环境变量一律拒绝（退出码 2）。',
  '',
  BOUNDARY_BLOCK,
  EXIT_CODE_BLOCK,
  '',
].join('\n');

const STATUS_HELP = [
  'usage: shiploop host status [--data-root <abs>] [--json]',
  '',
  '只读查询当前 Host 的生命周期状态。status 不启动 Host：无实例时按',
  'host_not_found 失败（退出码 3），绝不自行拉起写入者；也不触发停止。',
  '',
  '选项：',
  '  --data-root <abs>  规范数据根（POSIX 绝对路径，不能为 /；省略 = P01 默认根）',
  '  --json             stdout 只输出结果 JSON；诊断到 stderr',
  '',
  BOUNDARY_BLOCK,
  EXIT_CODE_BLOCK,
  '',
].join('\n');

const STOP_HELP = [
  'usage: shiploop host stop [--data-root <abs>] [--json]',
  '                          [--stop-command-id <uuid>] [--confirm-timeout-ms <int>]',
  '',
  '显式请求当前 Host 停止。停止是版本化操作：同 commandId + 同请求摘要重复提交',
  '返回同一结果；同 ID 不同摘要为 conflict。仅支持 graceful 停止，未实现的停止',
  '选项返回 unsupported。',
  '',
  '选项：',
  '  --data-root <abs>           规范数据根（POSIX 绝对路径，不能为 /；省略 = P01 默认根）',
  '  --json                      stdout 只输出结果 JSON；诊断到 stderr',
  '  --stop-command-id <uuid>    停止操作身份（UUID v4）；省略时由 CLI 生成',
  '  --confirm-timeout-ms <int>  等待进程退出/锁释放/发现移除证据的预算，默认 10000，允许 0..30000',
  '',
  'HTTP completed/stopping 回执或连接断开不等于已退出；必须取得全部外部停止证据',
  '才报告 stopped，否则报告 stop_not_confirmed（退出码 1）并保留锁与隔离。',
  '退出 CLI 客户端不会停止 Host。',
  '',
  BOUNDARY_BLOCK,
  EXIT_CODE_BLOCK,
  '',
].join('\n');

const HELP_BY_SCOPE: Readonly<Record<HelpScope, string>> = Object.freeze({
  top: TOP_HELP,
  host: HOST_HELP,
  start: START_HELP,
  status: STATUS_HELP,
  stop: STOP_HELP,
});

/** 返回指定作用域的帮助文本（以换行结尾）；不做任何 I/O。 */
export function getHostCliHelp(scope: HelpScope): string {
  return HELP_BY_SCOPE[scope];
}
