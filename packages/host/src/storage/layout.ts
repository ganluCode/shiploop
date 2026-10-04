/**
 * F-003 Host 私有目录布局常量（纯常量，无 I/O）。
 *
 * 协议依据：docs/p02-1-host-lifecycle-contract.md §3.3。
 *
 * 相对路径常量（POSIX 风格）同时用于错误 details：错误消息与 details 只携带
 * 这些受控相对位置，绝不携带绝对路径（§7.3 脱敏）。
 */

/** Host 私有目录名（<canonicalRoot>/host）。 */
export const HOST_DIR_NAME = 'host';
/** 发现文件名（host/discovery.json）。 */
export const DISCOVERY_FILE_NAME = 'discovery.json';
/** 本机 Bearer 凭据文件名（host/auth.token）。 */
export const AUTH_TOKEN_FILE_NAME = 'auth.token';
/** OS 排他锁目标文件名（host/writer.lock；锁本身由 F-004 实现，业务清理永不删除）。 */
export const WRITER_LOCK_FILE_NAME = 'writer.lock';

/** Host 私有目录权限（当前用户 rwx，其余无）。 */
export const HOST_DIR_MODE = 0o700;
/** 受保护文件权限（当前用户 rw，其余无）。 */
export const PROTECTED_FILE_MODE = 0o600;

/** 受控相对位置（错误 details 专用，禁止替换为绝对路径）。 */
export const HOST_DIR_RELATIVE_PATH = 'host';
export const DISCOVERY_RELATIVE_PATH = 'host/discovery.json';
export const AUTH_TOKEN_RELATIVE_PATH = 'host/auth.token';
export const WRITER_LOCK_RELATIVE_PATH = 'host/writer.lock';
