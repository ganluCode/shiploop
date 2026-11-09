import { resolveWorkflowLocale, type WorkflowLocale } from 'shiploop-core';
import { createHmac } from 'node:crypto';
import type { NotificationChannel, NotificationChannelSendInput } from 'shiploop-core';
import { readPrivatePiJson } from './production-pi-config.js';
import type { ProductionPiConfig } from './production-pi-config.js';
import type { WorkRuntimeFactory } from 'shiploop-core/assembly';

export const FEISHU_NOTIFY_EVENTS = ['task_completed', 'feature_completed', 'rate_limited', 'model_fallback', 'error_stopped', 'human_blocked'] as const;
type NotifyEvent = typeof FEISHU_NOTIFY_EVENTS[number];

const CARD_COLORS: Record<NotifyEvent, string> = {
  task_completed: 'green', feature_completed: 'green', rate_limited: 'orange',
  model_fallback: 'orange', error_stopped: 'red', human_blocked: 'orange',
};

const EVENT_LABELS: Record<NotifyEvent, string> = {
  task_completed: 'Task 验收通过', feature_completed: 'Feature 已完成',
  rate_limited: '限流停止', model_fallback: '切换备用模型',
  error_stopped: '执行失败停止', human_blocked: '等待人工确认',
};

const EN_COPY: Readonly<Record<string, string>> = {
  "Task 验收通过": "Task accepted",
  "规划完成，等待批准": "Plan ready for approval",
  "Feature 已完成": "Feature completed",
  "限流停止": "Stopped: rate limit",
  "切换备用模型": "Fallback model selected",
  "执行失败停止": "Stopped: execution failed",
  "等待人工确认": "Awaiting owner confirmation",
  "未知": "unknown",
  "（已记录部分）": " (recorded portion)",
  "项目": "Project",
  "原模型": "Previous model",
  "新模型": "New model",
  "恢复时间(Unix)": "Retry time (Unix)",
  "原因类别": "Reason",
  "难度": "Complexity",
  "执行模型": "Model",
  "会话耗时（本轮累计）": "Session time (current Run total)",
  "Token（不含缓存）": "Tokens (excluding cache)",
  "连接故障次数": "Connection failures",
  "**项目与任务**": "**Project and Task**",
  "**状态详情**": "**Status details**",
  "**Task 用量（本轮累计）**": "**Task usage (current Run total)**",
  "事件时间：": "Event time: ",
  "执行器：": "Executor: ",
  "通知：": "Delivery: ",
  "分钟": "min"
};

function display(value: unknown, fallback = 'unknown'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).slice(0, 300);
}

function identityDisplay(code: unknown, title: unknown, id: unknown): string | null {
  const parts = [code, title].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return parts.length ? parts.map(value => value.slice(0, 200)).join(' · ') : typeof id === 'string' ? id : null;
}

function metricTokenText(summary: Readonly<Record<string, unknown>>, locale: WorkflowLocale): string {
  const t = (text: string) => locale === 'zh-CN' ? text : EN_COPY[text] ?? text;
  const usage = summary.tokenUsage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return t('未知');
  const input = (usage as Record<string, unknown>).inputTokens;
  const output = (usage as Record<string, unknown>).outputTokens;
  const known = [input, output].filter((value): value is number => Number.isSafeInteger(value) && Number(value) >= 0);
  if (!known.length) return t('未知');
  return `${(known.reduce((total, value) => total + value, 0) / 1000).toFixed(1)}k`
    + ((usage as Record<string, unknown>).partial === true || known.length !== 2 ? t('（已记录部分）') : '');
}

function cardBody(event: NotifyEvent, input: NotificationChannelSendInput, locale: WorkflowLocale): Record<string, unknown> {
  const t = (text: string) => locale === 'zh-CN' ? text : EN_COPY[text] ?? text;
  const summary = input.summary;
  const kind = String(summary.kind ?? 'event');
  const fields: Record<string, unknown> = {
    '项目': summary.projectName ?? input.projectId ?? null,
    'Agent': 'shiploop',
    'Feature': identityDisplay(summary.featureCode, summary.featureTitle, summary.featureId),
    'Task': identityDisplay(summary.taskCode, summary.taskTitle, summary.taskId),
    '原模型': summary.fromModel ?? null,
    '新模型': summary.toModel ?? (kind === 'model_fallback' ? `${summary.provider ?? ''}/${summary.model ?? ''}` : null),
    '恢复时间(Unix)': summary.retryAt ?? null,
    '原因类别': summary.reason ?? summary.reasonCode ?? summary.resultCategory ?? null,
  };
  const metricEvent = kind === 'task_terminal' || kind === 'task_delivered' || kind === 'run_ended';
  if (metricEvent) {
    fields['难度'] = summary.complexity ?? t('未知');
    fields['执行模型'] = Array.isArray(summary.models) && summary.models.length
      ? summary.models.filter(model => typeof model === 'string').join('; ')
      : summary.model === undefined ? t('未知')
      : summary.provider === undefined ? summary.model : `${summary.provider}/${summary.model}`;
    fields['会话耗时（本轮累计）'] = typeof summary.durationMs === 'number'
      ? `${(summary.durationMs / 60000).toFixed(2)} ${t('分钟')}${summary.durationPartial === true ? t('（已记录部分）') : ''}` : t('未知');
    fields['Token（不含缓存）'] = metricTokenText(summary, locale);
    fields['连接故障次数'] = summary.connectionFailures === null || summary.connectionFailures === undefined ? t('未知')
      : `${summary.connectionFailures}${summary.connectionFailuresPartial === true ? t('（已记录部分）') : ''}`;
  }
  const field = (name: string) => ({ is_short: name !== '原因类别', text: {
    tag: 'plain_text', content: `${t(name)}\n${display(fields[name], t('未知'))}`,
  } });
  const identityNames = ['项目', 'Agent', 'Feature', 'Task'].filter(name => fields[name] !== null);
  const detailNames = ['原模型', '新模型', '恢复时间(Unix)', '原因类别'].filter(name => fields[name] !== null);
  const metricNames = ['难度', '执行模型', '会话耗时（本轮累计）', 'Token（不含缓存）', '连接故障次数']
    .filter(name => fields[name] !== null);
  const elements: Record<string, unknown>[] = [
    { tag: 'div', text: { tag: 'lark_md', content: t('**项目与任务**') } },
    { tag: 'div', fields: identityNames.map(field) },
  ];
  if (detailNames.length) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: t('**状态详情**') } },
      { tag: 'div', fields: detailNames.map(field) });
  }
  if (metricNames.length) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: t('**Task 用量（本轮累计）**') } },
      { tag: 'div', fields: metricNames.map(field) });
  }
  const occurred = typeof summary.occurredAt === 'string' ? new Date(summary.occurredAt) : null;
  const eventTime = occurred && Number.isFinite(occurred.getTime())
    ? occurred.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00' : t('未知');
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `${t('事件时间：')}${eventTime}`
    + ['runId', 'batchId', 'featureId', 'taskId'].filter(key => typeof summary[key] === 'string')
      .map(key => `\n${key}: ${display(summary[key])}`).join('')
    + (summary.executorId ? `\n${t('执行器：')}${display(summary.executorId)}` : '') + `\n${t('通知：')}${input.deliveryId}` }] });
  const label = event === 'task_completed' && summary.taskKind === 'planning'
    ? '规划完成，等待批准' : EVENT_LABELS[event];
  return { msg_type: 'interactive', card: {
    config: { wide_screen_mode: true },
    header: { template: CARD_COLORS[event], title: { tag: 'plain_text', content: `[shiploop] ${t(label)}` } },
    elements,
  } };
}

/** Uses the durable results outbox; failed HTTP does not affect business state. */
export function createFeishuResultsChannel(options: {
  readonly locale?: WorkflowLocale;
  readonly webhookUrl: string;
  readonly secret?: string;
  readonly notify?: Partial<Record<NotifyEvent, boolean>>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): NotificationChannel {
  const locale = resolveWorkflowLocale(options.locale);
  const url = new URL(options.webhookUrl);
  if (url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)
    || !url.pathname.startsWith('/open-apis/bot/v2/hook/') || url.username || url.password || url.search || url.hash) throw new Error('feishu_config_invalid');
  const transport = options.fetch ?? fetch;
  const active = new Map<string, { controller: AbortController; stopped: Promise<void> }>();
  return {
    channelId: 'local-results',
    async send(input) {
      const summary = input.summary;
      const kind = summary.kind;
      if (kind === 'run_ended' && summary.status === 'succeeded') return {
        channelId: 'local-results', transport: 'feishu', deliveryId: input.deliveryId, attempt: input.attempt, skipped: true,
      };
      const event: NotifyEvent = kind === 'task_action_required' || (kind === 'feature_finalization_blocked'
        && (summary.outcome === undefined || summary.outcome === 'awaiting_approval')) ? 'human_blocked'
        : kind === 'model_fallback' ? 'model_fallback'
        : summary.resultCategory === 'quota_blocked' || summary.resultCategory === 'rate_limited' ? 'rate_limited'
        : summary.status === 'failed' || summary.status === 'cancelled' || summary.outcome === 'failed'
          || kind === 'feature_finalization_blocked' ? 'error_stopped'
        : kind === 'task_terminal' ? 'task_completed' : kind === 'feature_finalized' ? 'feature_completed' : 'error_stopped';
      const receipt = { channelId: 'local-results', transport: 'feishu', deliveryId: input.deliveryId, attempt: input.attempt };
      if (options.notify?.[event] === false) return { ...receipt, skipped: true };
      const body = cardBody(event, input, resolveWorkflowLocale(summary.locale ?? locale));
      if (options.secret) {
        const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
        body.timestamp = timestamp;
        body.sign = createHmac('sha256', `${timestamp}\n${options.secret}`).update('').digest('base64');
      }
      const key = `${input.deliveryId}:${input.attempt}`;
      if (active.has(key)) throw new Error('feishu_delivery_in_flight');
      const controller = new AbortController();
      let stopped!: () => void;
      active.set(key, { controller, stopped: new Promise<void>(resolve => { stopped = resolve; }) });
      try {
        const response = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok || !response.body) throw new Error('feishu_rejected');
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > 16384) throw new Error('feishu_rejected');
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if ((value.code ?? value.StatusCode) !== 0) throw new Error('feishu_rejected');
        return receipt;
      } catch { throw new Error('feishu_rejected'); }
      finally { active.delete(key); stopped(); }
    },
    async cancel(input) {
      const sending = active.get(`${input.deliveryId}:${input.attempt}`);
      if (!sending) return true;
      sending.controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([sending.stopped.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}

export function productionFeishuChannels(dataRoot: string, config: ProductionPiConfig,
  currentSettings: () => Parameters<WorkRuntimeFactory>[0]['effectiveSettings']): readonly NotificationChannel[] {
  const active = new Map<string, NotificationChannel>();
  return [{ channelId: 'local-results', async send(input) {
    const project = input.projectId ? currentSettings()?.(input.projectId).policies.feishu?.value : undefined;
    const settings = project ?? config.notifications?.feishu;
    if (settings?.enabled !== true) return { channelId: 'local-results', deliveryId: input.deliveryId, attempt: input.attempt };
    const auth = readPrivatePiJson(dataRoot, 'auth.json') as Record<string, unknown> | undefined;
    const value = auth?.feishu as { type?: unknown; url?: unknown; secret?: unknown } | undefined;
    if (!value || value.type !== 'webhook' || typeof value.url !== 'string'
      || (value.secret !== undefined && (typeof value.secret !== 'string' || value.secret.length > 4096))
      || Object.keys(value).some(key => !['type', 'url', 'secret'].includes(key))) throw new Error('feishu_config_invalid');
    const key = `${input.deliveryId}:${input.attempt}`;
    if (active.has(key)) throw new Error('feishu_delivery_in_flight');
    const channel = createFeishuResultsChannel({ webhookUrl: value.url, secret: value.secret as string | undefined, notify: settings.notify });
    active.set(key, channel);
    try { return await channel.send(input); } finally { active.delete(key); }
  }, async cancel(input) { return active.get(`${input.deliveryId}:${input.attempt}`)?.cancel?.(input) ?? true; } }];
}
