import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFeishuResultsChannel } from '../../../packages/host/src/runtime/production-feishu.js';

it('shows stable readable identities and distinguishes planning from accepted coding Tasks', async () => {
  const bodies: any[] = [];
  const channel = createFeishuResultsChannel({ locale: 'zh-CN',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('{"code":0}'); } });
  const input = { deliveryId: 'display-1', attempt: 1, signal: new AbortController().signal,
    summary: { kind: 'task_terminal', status: 'passed', taskKind: 'planning', projectName: 'desktop-platform',
      featureId: 'feature-uuid', featureCode: 'P01-F02', featureTitle: 'Storage',
      taskId: 'task-uuid', taskCode: 'P01-F02-PLAN', taskTitle: 'Generate plan', runId: 'run-uuid' } };
  await channel.send(input);
  expect(bodies[0].card.header.title.content).toBe('[shiploop] 规划完成，等待批准');
  const identity = bodies[0].card.elements[1].fields;
  expect(identity).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: { tag: 'plain_text', content: 'Feature\nP01-F02 · Storage' } }),
    expect.objectContaining({ text: { tag: 'plain_text', content: 'Task\nP01-F02-PLAN · Generate plan' } }),
  ]));
  expect(JSON.stringify(identity)).not.toContain('uuid');
  expect(JSON.stringify(bodies[0].card.elements.at(-1))).toContain('run-uuid');
  expect(JSON.stringify(bodies[0].card.elements.at(-1))).toContain('task-uuid');
  await channel.send({ ...input, summary: { ...input.summary, locale: 'en-US', taskKind: 'planning' } });
  expect(bodies[1].card.header.title.content).toBe('[shiploop] Plan ready for approval');
  await channel.send({ ...input, summary: { ...input.summary, taskKind: 'coding', taskCode: 'P01-F02-T001' } });
  expect(bodies[2].card.header.title.content).toBe('[shiploop] Task 验收通过');
  await channel.send({ ...input, summary: { kind: 'task_terminal', status: 'failed', taskKind: 'planning', taskId: 'old-uuid' } });
  expect(bodies[3].card.header.title.content).toBe('[shiploop] 执行失败停止');
  expect(JSON.stringify(bodies[3])).toContain('old-uuid');
});

it('defaults to English, honors frozen summary locale on retries and preserves raw values', async () => {
  const bodies: string[] = [];
  const channel = createFeishuResultsChannel({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response('{"code":0}'); } });
  const summary = { kind: 'task_terminal', projectName: '中文项目', taskId: 'task-1', status: 'passed',
    reason: '保留故障原文', complexity: 'medium', models: ['provider/model'], durationMs: 60000,
    durationPartial: true, tokenUsage: { inputTokens: 2000, outputTokens: 1000, partial: true } };
  const input = { deliveryId: 'locale-1', attempt: 1, signal: new AbortController().signal, summary };
  await channel.send(input);
  expect(bodies[0]).toContain('Task accepted');
  expect(bodies[0]).toContain('recorded portion');
  expect(bodies[0]).toContain('中文项目');
  expect(bodies[0]).toContain('保留故障原文');
  expect(bodies[0]).toContain('provider/model');
  expect(bodies[0]).toContain('3.0k');
  await channel.send({ ...input, summary: { ...summary, locale: 'zh-CN' } });
  await channel.send({ ...input, attempt: 2, summary: { ...summary, locale: 'zh-CN' } });
  expect(bodies[1]).toContain('Task 验收通过');
  expect(bodies[1]).toBe(bodies[2]);
});

it('sends a signed card with a bounded safe summary and supports event switches', async () => {
  const bodies: Record<string, unknown>[] = [];
  const channel = createFeishuResultsChannel({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    locale: 'zh-CN', secret: 'test-secret', now: () => 1700000000000,
    notify: { task_completed: true, feature_completed: false },
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('{"code":0}'); } });
  const signal = new AbortController().signal;
  const receipt = await channel.send({ deliveryId: 'delivery-1', attempt: 1, signal,
    summary: { kind: 'task_terminal', taskId: 'task-1', status: 'passed', complexity: 'medium',
      durationMs: 120000, tokenUsage: { inputTokens: 1000, outputTokens: 250 } } });
  expect(bodies[0]).toMatchObject({ msg_type: 'interactive', card: {
    config: { wide_screen_mode: true }, header: { template: 'green' }, elements: expect.arrayContaining([
      expect.objectContaining({ tag: 'div', text: { tag: 'lark_md', content: '**项目与任务**' } }),
      expect.objectContaining({ tag: 'div', fields: expect.arrayContaining([
        expect.objectContaining({ text: { tag: 'plain_text', content: '难度\nmedium' } }),
        expect.objectContaining({ text: { tag: 'plain_text', content: 'Token（不含缓存）\n1.3k' } }),
      ]),
      }),
    ]) }, timestamp: '1700000000',
    sign: createHmac('sha256', '1700000000\ntest-secret').update('').digest('base64') });
  expect(JSON.stringify(receipt)).not.toContain('test-secret');
  await channel.send({ deliveryId: 'delivery-2', attempt: 1, signal, summary: { kind: 'feature_finalized', outcome: 'passed' } });
  expect(bodies).toHaveLength(1);
  await channel.send({ deliveryId: 'delivery-3', attempt: 1, signal,
    summary: { kind: 'model_fallback', resultCategory: 'quota_blocked', provider: 'backup', model: 'model' } });
  expect(JSON.stringify(bodies[1])).toContain('切换备用模型');
});

it('confirms cancellation only after the in-flight sender has actually stopped', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const channel = createFeishuResultsChannel({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    fetch: async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
  const input = { deliveryId: 'cancel-1', attempt: 1, signal: new AbortController().signal,
    summary: { kind: 'run_ended', status: 'failed' } };
  const sending = channel.send(input);
  const rejected = expect(sending).rejects.toThrow('feishu_rejected');
  await ready;
  expect(await channel.cancel!(input)).toBe(true);
  await rejected;
});

it('rejects redirects and non-success application responses without exposing the webhook', async () => {
  const channel = createFeishuResultsChannel({ webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    fetch: async () => new Response('{"code":19021,"msg":"secret response"}') });
  await expect(channel.send({ deliveryId: 'delivery-1', attempt: 1, signal: new AbortController().signal,
    summary: { kind: 'run_ended', status: 'failed' } })).rejects.toThrow('feishu_rejected');
});
