/**
 * P03-7 / F-014 CLI 纯面层：人审/验证继续命令参数、输入守护、状态折算与帮助边界。
 *
 * 验收面（.dag_context.json F-014 第 1/2/4 条的纯函数部分）：
 * 1. 新命令参数映射（status/block/approve/reject/unblock/continue）稳定解析；
 *   客户端伪造主体（principalId/decisionActor/actor）与明文凭据参数/字段在任何
 *   I/O 之前拒绝；
 * 2. 状态折算：错误、等待批准、not_run 与额度耗尽绝不折算为通过；
 * 4. 帮助与范围说明区分可信项目与强沙箱、Task 局部验证与 P03-8 Feature 全量
 *   交付，未装配语言执行器明确 unsupported；开发机绝对路径不进入生产源码。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppCliParseError, parseAppCliArgs } from '../packages/cli/src/app/args.ts';
import {
  buildTaskStatusView,
  deriveTaskDisplayState,
  formatTaskStatusView,
  parseArtifactRefValues,
  scanConfigPolicyInputFields,
  verificationContinueDisplay,
  type TaskStatusInputs,
} from '../packages/cli/src/app/approvals.ts';
import { getAppCliHelp } from '../packages/cli/src/app/help.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'ab'.repeat(32);
const DIGEST_2 = 'cd'.repeat(32);

const context = { command: 'task' as const, commandId: 'task.approve' as const, json: true };

describe('F-014 新命令参数映射（纯解析，无 I/O）', () => {
  it('task status/block/approve/continue 映射冻结参数', () => {
    const status = parseAppCliArgs(['task', 'status', 't-1', '--project', PROJECT_ID, '--json'], {});
    expect(status).toMatchObject({ kind: 'command', commandId: 'task.status', projectId: PROJECT_ID, taskId: 't-1' });

    const block = parseAppCliArgs(
      [
        'task', 'block', 't-1', '--project', PROJECT_ID, '--digest', DIGEST, '--revision', '3',
        '--kind', 'approval', '--description', '复核', '--party', 'owner',
        '--code-digest', DIGEST_2, '--artifact', `art-1:${DIGEST}`, '--json',
      ],
      {},
    );
    expect(block).toMatchObject({
      commandId: 'task.block',
      operation: 'task.approval.block',
      planDigest: DIGEST,
      codeDigest: DIGEST_2,
      revision: 3,
      kindOption: 'approval',
      responsibleParty: 'owner',
      artifactRefs: [`art-1:${DIGEST}`],
    });

    const approve = parseAppCliArgs(
      [
        'task', 'approve', 't-1', 'item-1', '--project', PROJECT_ID, '--digest', DIGEST,
        '--code-digest', DIGEST_2, '--revision', '1', '--reason', '已复核', '--json',
      ],
      {},
    );
    expect(approve).toMatchObject({
      commandId: 'task.approve',
      operation: 'task.approval.approve',
      itemId: 'item-1',
      reason: '已复核',
    });

    const continuation = parseAppCliArgs(
      [
        'task', 'continue', 't-1', '--project', PROJECT_ID, '--attempt', ATTEMPT_ID,
        '--batch', 'verification-a1', '--code-digest', DIGEST, '--observation', DIGEST_2,
        '--revision', '2', '--json',
      ],
      {},
    );
    expect(continuation).toMatchObject({
      commandId: 'task.continue',
      operation: 'task.verification.continue',
      attemptId: ATTEMPT_ID,
      verificationBatchId: 'verification-a1',
      observationDigest: DIGEST_2,
      revision: 2,
    });
  });

  it('不接受客户端伪造主体或明文凭据参数（解析层即拒绝）', () => {
    for (const flag of ['--principal', '--principal-id', '--actor', '--decision-actor', '--token', '--credentials']) {
      expect(() =>
        parseAppCliArgs(
          ['task', 'approve', 't-1', 'item-1', '--project', PROJECT_ID, '--digest', DIGEST,
            '--code-digest', DIGEST_2, '--revision', '1', flag, 'forged', '--json'],
          {},
        ),
      ).toThrow(AppCliParseError);
    }
  });

  it('摘要/revision/引用形态非法在连接前拒绝', () => {
    expect(() =>
      parseAppCliArgs(
        ['task', 'continue', 't-1', '--project', PROJECT_ID, '--attempt', ATTEMPT_ID,
          '--batch', 'b-1', '--code-digest', 'not-a-digest', '--observation', DIGEST, '--revision', '1'],
        {},
      ),
    ).toThrow(/摘要必须是 64 位小写十六进制/);
    expect(() =>
      parseAppCliArgs(
        ['task', 'block', 't-1', '--project', PROJECT_ID, '--digest', DIGEST],
        {},
      ),
    ).toThrow(AppCliParseError);
    const refs = parseArtifactRefValues([`art-1:${DIGEST}`, 'art-2'], context);
    expect(refs).toEqual([
      { artifactId: 'art-1', contentHash: DIGEST },
      { artifactId: 'art-2', contentHash: null },
    ]);
    expect(() => parseArtifactRefValues(['art-1:zz'], context)).toThrow(AppCliParseError);
    expect(() => parseArtifactRefValues(['art-1', `art-1:${DIGEST}`], context)).toThrow(/不得重复引用/);
  });
});

describe('F-014 检查定义/模块策略确认输入守护', () => {
  it('拒绝伪造主体与明文凭据字段；检查范围 scope/environmentRef 词汇保留', () => {
    expect(() =>
      scanConfigPolicyInputFields(
        { verification: { checkDefinitions: [{ checkKey: 'unit', scope: 'task' }] } },
        context,
      ),
    ).not.toThrow();
    expect(() =>
      scanConfigPolicyInputFields(
        { verification: { checkDefinitions: [{ checkKey: 'unit', scope: 'task', environmentRef: 'ci-safe' }] } },
        context,
      ),
    ).not.toThrow();
    expect(() =>
      scanConfigPolicyInputFields({ verification: { principalId: 'forged' } }, context),
    ).toThrow(/身份/);
    expect(() =>
      scanConfigPolicyInputFields({ verification: { modules: [{ moduleKey: 'core', decisionActor: 'forged' }] } }, context),
    ).toThrow(/身份/);
    expect(() =>
      scanConfigPolicyInputFields({ verification: { credentials: 'plaintext' } }, context),
    ).toThrow(/秘密|凭据|环境值/);
    expect(() =>
      scanConfigPolicyInputFields({ verification: { fullFallback: { checkRefs: [], apiToken: 'x' } } }, context),
    ).toThrow(/秘密|凭据|环境值/);
  });
});

describe('F-014 状态折算：非通过绝不打印为通过', () => {
  it('错误/等待批准/not_run/额度耗尽都不是 passed', () => {
    expect(deriveTaskDisplayState({ machineStatus: 'error', effectivePassed: false, pendingApprovalCount: 0, codeRemaining: 1 })).toBe('error');
    expect(deriveTaskDisplayState({ machineStatus: 'none', effectivePassed: false, pendingApprovalCount: 0, codeRemaining: 1 })).toBe('not_run');
    expect(deriveTaskDisplayState({ machineStatus: 'passed', effectivePassed: false, pendingApprovalCount: 1, codeRemaining: 1 })).toBe('waiting_approval');
    expect(deriveTaskDisplayState({ machineStatus: 'failed', effectivePassed: false, pendingApprovalCount: 0, codeRemaining: 0 })).toBe('exhausted');
    expect(deriveTaskDisplayState({ machineStatus: 'passed', effectivePassed: true, pendingApprovalCount: 0, codeRemaining: 2 })).toBe('passed');
  });

  it('三分区视图保持 passed 不变量；未装配执行器明确 unsupported', () => {
    const inputs: TaskStatusInputs = {
      verification: {
        task: { taskId: 't-1', featureId: 'f-1', status: 'running', executionVersion: 1, manualBlock: true, effectivePassed: false },
        machine: { status: 'passed', reason: 'checks_passed', outcome: 'passed', attemptId: ATTEMPT_ID, batchId: 'b-1', codeDigest: DIGEST, observationDigest: DIGEST_2 },
      },
      approvals: {
        records: [
          { id: 'item-1', kind: 'approval', status: 'pending', description: '复核', responsibleParty: 'owner', planDigest: DIGEST, codeDigest: DIGEST_2 },
          { id: 'item-2', kind: 'block', status: 'unblocked', description: '旧事项', responsibleParty: 'owner', planDigest: DIGEST, codeDigest: null },
        ],
      },
      rework: { summary: { codeEligibility: { used: 1, limit: 3, remaining: 2 } } },
    };
    const view = buildTaskStatusView('task.status', inputs);
    expect(view.passed).toBe(false);
    expect(view.display).toBe('waiting_approval');
    expect(view.pendingApprovalCount).toBe(1);
    expect(view.task.manualBlock).toBe(true);
    const human = formatTaskStatusView(view);
    expect(human).toContain('display=waiting_approval');
    expect(human).toContain('machine: status=passed');
    expect(human).not.toContain('display=passed');

    expect(verificationContinueDisplay('verification_not_assembled', 'applied')).toBe('unsupported');
    expect(verificationContinueDisplay(null, 'applied')).toBe('completed');
    expect(verificationContinueDisplay('approval', 'replayed')).toBe('waiting_approval');
  });
});

describe('F-014 帮助与范围说明', () => {
  it('区分可信项目与强沙箱、Task 局部验证与 P03-8 全量交付、未装配执行器 unsupported', () => {
    for (const scope of ['task', 'task.status', 'task.block', 'task.approve', 'task.continue'] as const) {
      const help = getAppCliHelp(scope);
      expect(help, scope).toContain('可信项目模式');
      expect(help, scope).toContain('强 OS 沙箱');
      expect(help, scope).toContain('P03-8 Feature 全量交付');
      expect(help, scope).toContain('unsupported');
      expect(help, scope).toMatch(/不启动执行|零写入/);
    }
  });

  it('生产源码与帮助不含开发机绝对路径；默认生产依赖不含 Fake 配置', () => {
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') || path.endsWith('.md')) sources.push(path);
      }
    };
    for (const pkg of ['core', 'host', 'cli']) walk(join(repoRoot, 'packages', pkg, 'src'));
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('/Users/');
    }
    for (const scope of ['task', 'task.status', 'task.block', 'task.approve', 'task.continue'] as const) {
      expect(getAppCliHelp(scope)).not.toContain('/Users/');
    }
    const coreManifest = JSON.parse(readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(coreManifest.dependencies).sort()).toEqual(['better-sqlite3', 'drizzle-orm']);
    const cliManifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(cliManifest.dependencies)).toEqual(['shiploop-host']);
  });
});
