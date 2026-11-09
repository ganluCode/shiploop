import { requirePlainObject, rejectUnknownKeys, validationError, type ValidationContext } from './validation.js';

export interface PiAgentPolicy {
  readonly transient_retry_attempts?: number;
  readonly transient_retry_backoff_base_seconds?: number;
  readonly fallback_on_connection_exhausted?: boolean;
  readonly fallback_on_server_exhausted?: boolean;
  readonly fallback_on_authentication?: boolean;
}
export interface PiExecutionPolicy {
  readonly maxRequests?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputTokens?: number;
  readonly thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly commandTimeoutMs?: number;
  readonly codemode?: boolean;
}
export interface FeishuNotificationPolicy {
  readonly enabled?: boolean;
  readonly notify?: Partial<Record<'task_completed' | 'feature_completed' | 'rate_limited' | 'model_fallback' | 'error_stopped' | 'human_blocked', boolean>>;
}

export function validateFeishuNotificationPolicy(value: unknown, context: ValidationContext, field: string): FeishuNotificationPolicy {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, ['enabled', 'notify'], context, field);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw validationError(context, `${field}.enabled`, '必须是布尔值');
  if (raw.notify !== undefined) {
    const switches = requirePlainObject(raw.notify, context, `${field}.notify`);
    rejectUnknownKeys(switches, ['task_completed', 'feature_completed', 'rate_limited', 'model_fallback', 'error_stopped', 'human_blocked'], context, `${field}.notify`);
    if (Object.values(switches).some(v => typeof v !== 'boolean')) throw validationError(context, `${field}.notify`, '通知开关必须是布尔值');
  }
  return { ...raw };
}

export function validatePiAgentPolicy(value: unknown, context: ValidationContext, field: string): PiAgentPolicy {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, ['transient_retry_attempts', 'transient_retry_backoff_base_seconds',
    'fallback_on_connection_exhausted', 'fallback_on_server_exhausted', 'fallback_on_authentication'], context, field);
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (key === 'transient_retry_attempts' || key === 'transient_retry_backoff_base_seconds') {
      const max = key === 'transient_retry_attempts' ? 10 : 60, min = key === 'transient_retry_attempts' ? 0 : 1;
      if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) throw validationError(context, `${field}.${key}`, `必须是 ${min}..${max} 的整数`);
    } else if (typeof v !== 'boolean') throw validationError(context, `${field}.${key}`, '必须是布尔值');
  }
  return { ...raw };
}

export function validatePiExecutionPolicy(value: unknown, context: ValidationContext, field: string): PiExecutionPolicy {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, ['maxRequests', 'maxInputBytes', 'maxOutputTokens', 'thinkingLevel', 'commandTimeoutMs', 'codemode'], context, field);
  for (const [key, maximum] of [['maxRequests', 10000], ['maxInputBytes', 8388608], ['maxOutputTokens', 1000000], ['commandTimeoutMs', 3600000]] as const) {
    const value = raw[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)) throw validationError(context, `${field}.${key}`, `必须是 1..${maximum} 的整数`);
  }
  if (raw.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(raw.thinkingLevel))) throw validationError(context, `${field}.thinkingLevel`, '未知思考档位');
  if (raw.codemode !== undefined && typeof raw.codemode !== 'boolean') throw validationError(context, `${field}.codemode`, '必须是布尔值');
  return { ...raw };
}
