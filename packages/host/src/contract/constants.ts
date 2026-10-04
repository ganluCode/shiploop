/**
 * F-002 Host 生命周期协议冻结常量（契约纯模块）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md
 * - §5.1/§7.1：发现 schemaVersion 与线协议 protocolVersion 独立演进、独立校验；
 * - §5.1：唯一合法监听字面量 127.0.0.1 与三条路由；
 * - §7.2：16 384 B 体积上限与有限客户端预算；
 * - §6：锁获取有限预算；§10.2：quiesce 有限预算；
 * - §8/§10：冻结能力声明（graceful / idle-only / 无事件 / 无项目命令）。
 *
 * 首版数值预算为有限默认值（§17.1 待核对项 3）：调整必须有测试依据并回写契约，
 * 不得改为无界，也不得开放为用户可配的监听/安全放宽项。
 */

/** 发现文档结构版本（discovery.json）；未知值拒绝，不猜测降级。 */
export const DISCOVERY_SCHEMA_VERSION = 1 as const;

/**
 * 线消息结构版本（握手/stop 请求与响应体）。与发现 schemaVersion 同值但独立
 * 校验：未来其中一个升版不自动改变另一个。
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/** 当前 Host 生命周期线协议版本；本 Feature 只实现 v1。 */
export const CURRENT_PROTOCOL_VERSION = 1 as const;

/** 客户端/服务端共同支持的线协议版本集合（不兼容时 426 回传）。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1]);

/** 唯一合法监听地址字面量；localhost/::1/0.0.0.0/域名/外网 IP 一律拒绝。 */
export const LOOPBACK_LISTEN_ADDRESS = '127.0.0.1';

/** §7.2 请求体与响应体字节上限。 */
export const MAX_HTTP_BODY_BYTES = 16_384;

/** §7.2 路由前缀与三条生命周期路由（无匿名路由、无 /health）。 */
export const HOST_ROUTE_PREFIX = '/v1/host/';
export const HANDSHAKE_ROUTE = '/v1/host/handshake';
export const STATUS_ROUTE = '/v1/host/status';
export const STOP_ROUTE = '/v1/host/stop';

/** §7.2 客户端有限预算（毫秒）。 */
export const TCP_CONNECT_TIMEOUT_MS = 2_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const STATUS_TIMEOUT_MS = 10_000;
/** stop 整体预算 = 10 000 ms quiesce + 5 000 ms 余量（§7.2/§10.2）。 */
export const STOP_TIMEOUT_MS = 15_000;

/** §10.2 enterQuiesce 后等待活动收尾的有限预算。 */
export const QUIESCE_BUDGET_MS = 10_000;

/** §6 每规范根 OS 排他锁获取的有限等待预算。 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

/** §10.1 唯一支持的停止模式与能力声明字面量。 */
export const STOP_MODE_GRACEFUL = 'graceful';
export const SUPPORTED_STOP_MODES: readonly string[] = Object.freeze([STOP_MODE_GRACEFUL]);
export const IDEMPOTENCY_SCHEME = 'commandId+requestDigest';
export const ACTIVITY_SCOPE_IDLE_ONLY = 'idle-only';
