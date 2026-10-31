/**
 * P07-4 / F-009 通知与 delivery 发送状态 CLI 纯面层（参数映射、文本视图、帮助）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/notifications.ts` 视图投影 /
 * `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - notifications list 按实际 Host 公共契约（notifications.list）映射参数；
 *   实体 Task/Run/Feature 至多一（--task/--run/--feature），同现本地拒绝；
 *   非法 ID/分页/状态在任何 I/O 之前以稳定 reason 拒绝；get 位置 deliveryId；
 * - 文本展示 UTC 时间、次数与五类发送状态（中文标签区分等待/发送中/待重试/
 *   已发送/停止重试）；未知保持 unknown 不填零；摘要/回执只展示脱敏冻结摘要；
 * - 帮助同步（notifications 作用域与子命令 usage）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  NOTIFICATIONS_VIEW_NOTE,
  buildNotificationsDetailView,
  buildNotificationsListView,
  formatNotificationsDetailView,
  formatNotificationsListView,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from 'shiploop-core/protocol';

type NotificationListResult = Awaited<ReturnType<HostClient['listNotifications']>>;
type NotificationDetailResult = Awaited<ReturnType<HostClient['getNotification']>>;

const PROJECT_ID = randomUUID();
const RUN_UUID = randomUUID();
const DELIVERY_ID = 'delivery-stable-1';

function expectParseError(args: readonly string[], reason: string, field?: string): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(AppCliParseError);
    const parseError = error as AppCliParseError;
    expect(parseError.reason).toBe(reason);
    if (field !== undefined) expect(parseError.field).toBe(field);
    return parseError;
  }
  throw new Error(`expected parse failure for ${JSON.stringify(args)}`);
}

const listResult: NotificationListResult = {
  schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
  scope: 'notifications',
  filter: { entity: { kind: 'task', id: 't-1' }, status: 'retry_scheduled' },
  records: [
    {
      deliveryId: DELIVERY_ID,
      eventId: randomUUID(),
      channelId: 'local-results',
      eventType: 'task.terminal',
      eventSequence: 12,
      entity: { kind: 'task', id: 't-1' },
      summary: { schemaVersion: 1, kind: 'task_terminal', taskId: 't-1', status: 'failed', resultCategory: 'runtime_failed', attemptId: 'a-1', runId: 'run-1', resultRef: null },
      status: 'retry_scheduled',
      attemptCount: 2,
      lastOutcome: 'failed',
      lastFailureReason: 'channel down',
      receipt: null,
      nextAttemptAt: '2026-10-20T12:05:00.000Z',
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:04:00.000Z',
    },
    {
      deliveryId: 'delivery-stable-2',
      eventId: randomUUID(),
      channelId: 'local-results',
      eventType: 'execution.run.ended',
      eventSequence: 13,
      entity: { kind: 'run', id: 'run-1' },
      summary: { schemaVersion: 1, kind: 'run_ended', runId: 'run-1', status: 'succeeded', resultCategory: 'succeeded', resultRef: null, batchId: 'b-1', featureId: 'f-1' },
      status: 'delivered',
      attemptCount: 1,
      lastOutcome: 'succeeded',
      lastFailureReason: null,
      receipt: { channelId: 'local-results', deliveryId: 'delivery-stable-2', attempt: 1 },
      nextAttemptAt: null,
      createdAt: '2026-10-20T12:01:00.000Z',
      updatedAt: '2026-10-20T12:02:00.000Z',
    },
  ],
  nextCursor: null,
  limit: 50,
};

const detailResult: NotificationDetailResult = {
  schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
  scope: 'notification',
  delivery: listResult.records[0]!,
  attempts: [
    { attempt: 1, outcome: 'failed', receipt: null, failureReason: 'timeout', occurredAt: '2026-10-20T12:03:00.000Z' },
    { attempt: 2, outcome: 'failed', receipt: null, failureReason: 'channel down', occurredAt: '2026-10-20T12:04:00.000Z' },
  ],
};

describe('P07-4 / F-009 通知 CLI 参数映射与本地拒绝', () => {
  it('[case:cli-args-mapping] list/get 参数映射与本地拒绝', () => {
    const list = parseAppCliArgs(['notifications', 'list', '--project', PROJECT_ID, '--task', 't-1', '--status', 'retry_scheduled', '--limit', '20', '--cursor', 'plcur_v1_x'], {});
    expect(list).toMatchObject({ kind: 'command', command: 'notifications', commandId: 'notifications.list', projectId: PROJECT_ID, taskId: 't-1', status: 'retry_scheduled', limit: 20, cursor: 'plcur_v1_x' });

    const byRun = parseAppCliArgs(['notifications', 'list', '--project', PROJECT_ID, '--run', RUN_UUID], {});
    expect(byRun).toMatchObject({ runId: RUN_UUID });
    const byFeature = parseAppCliArgs(['notifications', 'list', '--project', PROJECT_ID, '--feature', 'f-1'], {});
    expect(byFeature).toMatchObject({ featureId: 'f-1' });
    const unfiltered = parseAppCliArgs(['notifications', 'list', '--project', PROJECT_ID], {});
    expect(unfiltered).not.toHaveProperty('taskId');
    expect(unfiltered).not.toHaveProperty('status');

    const get = parseAppCliArgs(['notifications', 'get', DELIVERY_ID, '--project', PROJECT_ID], {});
    expect(get).toMatchObject({ kind: 'command', commandId: 'notifications.get', projectId: PROJECT_ID, deliveryId: DELIVERY_ID });

    // 实体同现/缺 --project/非法 ID/非法分页/未知子命令在 I/O 前拒绝。
    expectParseError(['notifications', 'list', '--project', PROJECT_ID, '--task', 't-1', '--run', 'r-1'], 'conflicting_options');
    expectParseError(['notifications', 'list', '--project', PROJECT_ID, '--task', 't-1', '--feature', 'f-1'], 'conflicting_options');
    expectParseError(['notifications', 'list'], 'missing_required_option', 'project');
    expectParseError(['notifications', 'list', '--project', '../etc/passwd'], 'invalid_project_id', 'project');
    expectParseError(['notifications', 'list', '--project', PROJECT_ID, '--task', '..'], 'invalid_plan_id', 'taskId');
    expectParseError(['notifications', 'list', '--project', PROJECT_ID, '--limit', '0'], 'invalid_limit', 'limit');
    expectParseError(['notifications', 'list', '--project', PROJECT_ID, '--limit', 'abc'], 'invalid_limit', 'limit');
    expectParseError(['notifications', 'get', '--project', PROJECT_ID], 'missing_positional', 'deliveryId');
    expectParseError(['notifications', 'bogus', '--project', PROJECT_ID], 'unknown_subcommand');
    expectParseError(['notifications'], 'missing_subcommand');
  });

  it('[case:cli-view-text] 文本展示 UTC 时间/次数/五类状态与未知保持；不泄漏数据根', () => {
    const listText = formatNotificationsListView(buildNotificationsListView(listResult));
    expect(listText).toContain('status=retry_scheduled（待重试）');
    expect(listText).toContain('status=delivered（已发送）');
    expect(listText).toContain('attempts=2');
    expect(listText).toContain('lastOutcome=failed');
    expect(listText).toContain('lastReason=channel down');
    expect(listText).toContain('nextAttempt=2026-10-20T12:05:00.000Z');
    expect(listText).toContain('nextAttempt=unknown');
    expect(listText).toContain('entity=task:t-1');
    expect(listText).toContain('entity=run:run-1');
    expect(listText).toContain('receipt={"channelId":"local-results","deliveryId":"delivery-stable-2","attempt":1}');
    expect(listText).toContain('summary: schemaVersion=1 kind=task_terminal taskId=t-1');
    expect(listText).toContain(NOTIFICATIONS_VIEW_NOTE);
    expect(listText).not.toContain('/Users/');
    expect(listText).not.toContain('dataRoot');
    // 展示层不动结果：JSON 信封由执行层直接携带查询结果原文。
    expect(buildNotificationsListView(listResult).records).toBe(listResult.records);
    expect(buildNotificationsListView(listResult).filter).toEqual(listResult.filter);

    const detailText = formatNotificationsDetailView(buildNotificationsDetailView(detailResult));
    expect(detailText).toContain(`delivery=${DELIVERY_ID}`);
    expect(detailText).toContain('#1 outcome=failed reason=timeout occurredAt=2026-10-20T12:03:00.000Z');
    expect(detailText).toContain('#2 outcome=failed reason=channel down');
    expect(detailText).not.toContain('/Users/');
  });

  it('[case:cli-help-sync] 帮助同步：命令作用域/usage/五类状态词汇', () => {
    for (const scope of ['notifications', 'notifications.list', 'notifications.get'] as const) {
      const help = getAppCliHelp(scope);
      expect(help).toContain('usage: shiploop notifications');
      expect(help).not.toContain('undefined');
    }
    expect(getAppCliHelp('notifications.list')).toContain('--status <pending|in_flight|retry_scheduled|delivered|exhausted>');
    expect(getAppCliHelp('notifications.get')).toContain('<deliveryId>');
    expect(getAppCliHelp('notifications.list')).toContain('只读');
    // 帮助入口经 --help 解析真实可达。
    expect(parseAppCliArgs(['notifications', 'list', '--help'], {})).toMatchObject({ kind: 'help', scope: 'notifications.list' });
    expect(parseAppCliArgs(['notifications', '--help'], {})).toMatchObject({ kind: 'help', scope: 'notifications' });
  });
});
