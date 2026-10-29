import { describe, expect, it } from 'vitest';
import { getAppCliHelp, parseAppCliArgs } from '../../../packages/cli/src/index.ts';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'task-a';

describe('P06-6 F-003 策略重应用 CLI', () => {
  it('[case:strategy-reapply-cli] 预览支持重复 Task，确认要求显式 --confirm 和受控输入文件', () => {
    const preview = parseAppCliArgs(
      ['task', 'strategy-preview', '--project', PROJECT_ID, '--task', TASK_ID, '--task', 'task-b'],
      {},
    );
    expect(preview).toMatchObject({
      commandId: 'task.strategy-reapply-preview',
      projectId: PROJECT_ID,
      taskIds: [TASK_ID, 'task-b'],
    });
    const reapply = parseAppCliArgs(
      ['task', 'strategy-reapply', '--project', PROJECT_ID, '--input', 'confirmation.json', '--confirm'],
      {},
    );
    expect(reapply).toMatchObject({
      commandId: 'task.strategy-reapply',
      projectId: PROJECT_ID,
      inputFile: 'confirmation.json',
      confirm: true,
    });
    expect(getAppCliHelp('task.strategy-reapply-preview')).toContain('不批准');
    expect(getAppCliHelp('task.strategy-reapply')).toContain('--confirm');
  });

  it('[case:strategy-reapply-confirm-required] 缺少显式确认时在纯解析层拒绝', () => {
    expect(() => parseAppCliArgs(
      ['task', 'strategy-reapply', '--project', PROJECT_ID, '--input', 'confirmation.json'],
      {},
    )).toThrow();
  });
});
