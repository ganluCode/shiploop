/**
 * F-005 脱敏证据日志（仅测试夹具，不是产品实现）。
 *
 * 证据允许记录的内容（F-005 验收 4）：PID、hostInstanceId、生命周期状态、
 * 退出码/信号、路由、HTTP 状态、监听地址/端口、非秘密枚举等。
 * 证据**绝不**允许包含：Authorization 头原值、Bearer token、auth.token 文件
 * 正文、密码/Cookie、受保护绝对路径（真实 HOME、受测仓库）。
 *
 * fail-closed 实现：
 * - 每次 record 深度遍历字段；键名命中凭据语义模式且值为字符串时直接拒绝
 *   （布尔/数字存在性标记必须改用 hasToken / authPresent 之类的键名）；
 * - 所有字符串值都会被扫描：不得包含任何已登记秘密、`Bearer <长串>`、
 *   受保护字符串（如真实 HOME 路径）；非有限数同样拒绝（证据必须可序列化）；
 * - 已净化的请求头分类用 redactRequestHeaders 取得，键名是 `auth`，
 *   其值仅为 'bearer' | 'absent' | 'other-scheme' 枚举。
 *
 * 证据日志只做记忆态追加与 JSON 序列化，不做文件 I/O；F-014 报告落盘时
 * 复用 serialize() 的输出，秘密防线不放在写盘环节。
 */
import { stableCanonicalJson } from '../../../packages/host/src/contract/identifiers.ts';
import type { IncomingHttpHeaders } from 'node:http';

/** 凭据语义键名：authorization / token / password / secret / cookie（允许 has_ 前缀与 _ 边界）。 */
const SECRET_KEY_PATTERN = /(^|[_\-.])(authorization|auth_token|authtoken|token|password|passwd|secret|cookie)([_\-.]|$)/i;

const BEARER_VALUE_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/;

export interface EvidenceEvent {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface EvidenceLogOptions {
  /** 永不允许出现在证据中的秘密值（如伪服务 token、auth.token 正文）。 */
  readonly secrets?: readonly string[];
  /** 永不允许出现在证据中的受保护字符串（如真实 HOME、受测仓库绝对路径）。 */
  readonly protectedStrings?: readonly string[];
}

export interface EvidenceLog {
  /** 追加登记秘密（如测试中途新发行的凭据）；空串/过短值忽略以免误报。 */
  registerSecret(secret: string): void;
  /** 记录一条证据；任何脱敏检查失败即抛 EvidenceSecretLeakError，不留半截记录。 */
  record(type: string, fields: Record<string, unknown>): EvidenceEvent;
  events(): readonly EvidenceEvent[];
  /** 稳定规范 JSON（与协议摘要同一序列化器），供报告落盘与断言使用。 */
  serialize(): string;
}

export class EvidenceSecretLeakError extends Error {
  readonly eventType: string;
  readonly reason: 'secret_value' | 'protected_string' | 'bearer_header' | 'secret_key' | 'non_finite';
  readonly keyPath: string;

  constructor(eventType: string, reason: EvidenceSecretLeakError['reason'], keyPath: string) {
    super(`证据记录 ${eventType} 在 ${keyPath} 触发脱敏拒绝（${reason}）`);
    this.name = 'EvidenceSecretLeakError';
    this.eventType = eventType;
    this.reason = reason;
    this.keyPath = keyPath;
  }
}

export function createEvidenceLog(options: EvidenceLogOptions = {}): EvidenceLog {
  const secrets = new Set<string>((options.secrets ?? []).filter((value) => typeof value === 'string' && value.length >= 8));
  const protectedStrings = (options.protectedStrings ?? []).filter((value) => typeof value === 'string' && value.length > 1);
  const events: EvidenceEvent[] = [];
  let seq = 0;

  function scan(value: unknown, eventType: string, keyPath: string, key: string): void {
    if (typeof value === 'string') {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new EvidenceSecretLeakError(eventType, 'secret_key', keyPath);
      }
      if (BEARER_VALUE_PATTERN.test(value)) {
        throw new EvidenceSecretLeakError(eventType, 'bearer_header', keyPath);
      }
      for (const secret of secrets) {
        if (value.includes(secret)) {
          throw new EvidenceSecretLeakError(eventType, 'secret_value', keyPath);
        }
      }
      for (const protectedString of protectedStrings) {
        if (value.includes(protectedString)) {
          throw new EvidenceSecretLeakError(eventType, 'protected_string', keyPath);
        }
      }
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new EvidenceSecretLeakError(eventType, 'non_finite', keyPath);
      }
      return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'undefined') {
      // bigint 无法 JSON 序列化，提前在键名规则外拦一道。
      if (typeof value === 'bigint') {
        throw new EvidenceSecretLeakError(eventType, 'non_finite', keyPath);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, eventType, `${keyPath}[${index}]`, key));
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        scan(childValue, eventType, keyPath === '' ? childKey : `${keyPath}.${childKey}`, childKey);
      }
    }
  }

  return {
    registerSecret(secret: string): void {
      if (typeof secret === 'string' && secret.length >= 8) {
        secrets.add(secret);
      }
    },
    record(type: string, fields: Record<string, unknown>): EvidenceEvent {
      if (typeof type !== 'string' || type.length === 0) {
        throw new Error('证据事件类型必须是非空字符串');
      }
      // 先完整扫描，通过后才落库（失败不留半截记录）。
      scan(fields, type, '', '');
      const event: EvidenceEvent = {
        seq: (seq += 1),
        at: new Date().toISOString(),
        type,
        fields: JSON.parse(JSON.stringify(fields)) as Record<string, unknown>,
      };
      events.push(event);
      return event;
    },
    events(): readonly EvidenceEvent[] {
      return events;
    },
    serialize(): string {
      return stableCanonicalJson(events);
    },
  };
}

/** 请求头的脱敏分类视图（F-005：认证头只留分类，原值不复制、不缓存）。 */
export interface SanitizedRequestHeaders {
  readonly host?: string;
  /** 凭据分类；不存在 'bearer-<token>' 之类携带原值的形态。 */
  readonly auth: 'bearer' | 'absent' | 'other-scheme';
  readonly originPresent: boolean;
  readonly contentType?: string;
  readonly contentLength?: number;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

export function redactRequestHeaders(headers: IncomingHttpHeaders): SanitizedRequestHeaders {
  const authorization = headerValue(headers, 'authorization');
  let auth: SanitizedRequestHeaders['auth'] = 'absent';
  if (authorization !== undefined) {
    auth = /^Bearer\s+\S+$/i.test(authorization.trim()) ? 'bearer' : 'other-scheme';
  }
  const view: SanitizedRequestHeaders = {
    auth,
    originPresent: headerValue(headers, 'origin') !== undefined,
  };
  const host = headerValue(headers, 'host');
  const contentType = headerValue(headers, 'content-type');
  const contentLengthRaw = headerValue(headers, 'content-length');
  const mutable = { ...view } as {
    auth: SanitizedRequestHeaders['auth'];
    originPresent: boolean;
    host?: string;
    contentType?: string;
    contentLength?: number;
  };
  if (host !== undefined) {
    mutable.host = host;
  }
  if (contentType !== undefined) {
    mutable.contentType = contentType;
  }
  if (contentLengthRaw !== undefined && /^\d+$/.test(contentLengthRaw)) {
    mutable.contentLength = Number(contentLengthRaw);
  }
  return mutable;
}
