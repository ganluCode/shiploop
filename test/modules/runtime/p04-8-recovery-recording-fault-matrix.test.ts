import { describe, expect, it } from 'vitest';
import { runRecordingFault, runLateResultFault, runUsageConsistencyFault } from '../../helpers/p04-8/recovery-recording-fault-matrix.ts';

describe('P04-8 F-005 恢复与记录离线故障矩阵', () => {
  it('[case:f005-replayed-recording] 重复回放保留父子工具身份，事件和 usage 只持久计量一次', async () => {
    const row = await runRecordingFault('replay');
    expect(row.coverage).toBe('complete');
    expect(row.watermark).toBe(4);
    expect(row.duplicatesDropped).toBe(4);
    expect(row.sequences).toEqual([1, 2, 3, 4]);
    expect(row.toolParents).toEqual([['parent', null], ['child', 'parent']]);
    expect(row.inputTokens).toBe(7);
    expect(row.finalInputTokens).toBe(900);
    expect(row.notAdditive).toBe(true);
    expect(row.businessUnchanged).toBe(true);
    expect(row.taskStatus).toBe('running');
  }, 20_000);

  it('[case:f005-large-message] 超大正文省略但保留可验证水位与缺口，不伪造完整记录', async () => {
    const row = await runRecordingFault('large-message');
    expect(row.coverage).toBe('partial');
    expect(row.watermark).toBe(3);
    expect(row.sequences).toEqual([1, 2, 3]);
    expect(row.gaps).toContain('event_body_too_large:4');
    expect(row.sessionGaps).toContain('event_body_too_large:4');
    expect(row.runtimeCompleted).toBe(true);
    expect(row.businessUnchanged).toBe(true);
    expect(row.taskStatus).toBe('running');
  }, 20_000);

  for (const scenario of ['disk-write', 'native-database-corrupt'] as const) {
    it(`[case:f005-${scenario}] 存储失败保留已落盘前缀、Core 状态和可追踪缺口`, async () => {
      const row = await runRecordingFault(scenario);
      expect(row.coverage).toBe('failed');
      expect(row.failureReason).toBe(scenario === 'disk-write' ? 'event_publish_failed' : 'event_stream_failed');
      expect(row.watermark).toBe(2);
      expect(row.sequences).toEqual([1, 2]);
      expect(row.sessionGaps).toContain(`recording_failed:${row.failureReason}`);
      expect(row.cancelCalls).toBe(1);
      expect(row.runtimeCompleted).toBe(true);
      expect(row.businessUnchanged).toBe(true);
      expect(row.taskStatus).toBe('running');
      if (scenario === 'native-database-corrupt') expect(row.nativeDatabaseRejected).toBe(true);
      else expect(row.failedChunks).toBe(1);
    }, 20_000);
  }

  it('[case:f005-usage-scopes] 恢复累计扣除历史，父子明细、Attempt 汇总和重复 usage 不相加', () => {
    const row = runUsageConsistencyFault();
    expect(row.totals).toEqual([100, 50]);
    expect(row.featureInputTokens).toBe(150);
    expect(row.counted).toEqual([false, true, false, false, true, false]);
    expect(row.reasons).toEqual(['child_detail', 'none', 'same_event', 'child_detail', 'none', 'same_event']);
    expect(row.rawResumedInputTokens).toBe(150);
  });

  for (const fence of ['task-version', 'attempt-version', 'owner', 'host'] as const) {
    it(`[case:f005-late-${fence}] 迟到结果与重复投递不能越过代次或持有者写入预算、验收和交付`, async () => {
      const row = await runLateResultFault(fence);
      expect(row.receipts).toHaveLength(2);
      for (const receipt of row.receipts) expect(receipt).toMatchObject({
        disposition: 'ignored', reason: 'stale_execution_identity', resultSaved: false, runtimeCompleted: false,
      });
      expect(row.businessUnchanged).toBe(true);
      expect(row.artifactsUnchanged).toBe(true);
      expect(row.sessionUnchanged).toBe(true);
      expect(row.diagnostics).toBe(1);
      expect(row.gitHeadUnchanged).toBe(true);
    }, 20_000);
  }
});
