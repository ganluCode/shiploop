/**
 * P03-2 / F-008 计划决策、Task 策略编辑与固定输入 CLI 纯面层（参数/帮助/输入守护）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs`/`getAppCliHelp`/`app/decisions.ts` 输入
 * 扫描），不接触真实 Host、SQLite、文件或网络：
 * - `feature approve/reject`、`task strategy/prepare/inputs` 命令身份与参数在
 *   解析层可得；planDigest/expectedRevision 是必填输入（缺失即输入错误）；
 * - 秘密/身份字段在任何 I/O 之前以既有 input_secret_field_rejected /
 *   input_identity_field_rejected 拒绝（秘密不得进入请求体）；
 * - 帮助与结构化输出纪律：批准/拒绝明确未启动执行，未知执行能力不显示为
 *   可运行，不宣称 Run/Work/模型可用；
 * - 解析失败不回显参数值、不泄漏秘密或开发机路径。
 *
 * 纵向（真实 Host + HostClient + SQLite）见 `p03-2-cli-vertical.test.ts`；
 * 构建后 CLI（真实 dist/bin.js）见 `p03-2-cli-built.test.ts`。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  getAppCliHelp,
  parseAppCliArgs,
} from '../packages/cli/src/index.ts';
import {
  parsePrepareItemsPayload,
  scanStrategyInputFields,
} from '../packages/cli/src/app/decisions.ts';
import type { DecisionsInputContext } from '../packages/cli/src/app/decisions.ts';

const PROJECT_ID = randomUUID();
const FEATURE_ID = randomUUID();
const TASK_ID = randomUUID();
const PLAN_DIGEST = 'a'.repeat(64);
const SECRET_VALUE = 'sk-never-echo-please';

const SCAN_CONTEXT: DecisionsInputContext = {
  command: 'task',
  commandId: 'task.strategy',
  json: false,
};

function expectParseError(
  args: readonly string[],
  reason: string,
  field?: string,
): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(
      AppCliParseError,
    );
    const parsed = error as AppCliParseError;
    expect(parsed.code).toBe('invalid_input');
    expect(parsed.reason).toBe(reason);
    if (field !== undefined) {
      expect(parsed.field).toBe(field);
    }
    // 错误不回显用户输入值（ID/摘要/秘密一律不带回）。
    expect(parsed.message).not.toContain(PROJECT_ID);
    expect(parsed.message).not.toContain(PLAN_DIGEST);
    expect(parsed.message).not.toContain(SECRET_VALUE);
    return parsed;
  }
  throw new Error(`expected parse error ${reason} for args ${JSON.stringify(args)}`);
}

function expectScanError(
  action: () => unknown,
  reason: string,
  field: string,
): AppCliParseError {
  try {
    action();
  } catch (error) {
    expect(error, `expected AppCliParseError(${reason})`).toBeInstanceOf(AppCliParseError);
    const parsed = error as AppCliParseError;
    expect(parsed.reason).toBe(reason);
    expect(parsed.field).toBe(field);
    expect(parsed.message).not.toContain(SECRET_VALUE);
    return parsed;
  }
  throw new Error(`expected scan error ${reason}`);
}

/* ------------------------------------------------------------------ *
 * 命令面
 * ------------------------------------------------------------------ */

describe('F-008 决策/策略/固定输入命令面', () => {
  it('命令身份齐全（批准/拒绝/策略编辑/输入准备/输入查看）且唯一、形态沿用点分 CLI 路径', () => {
    for (const id of [
      'feature.approve',
      'feature.reject',
      'task.strategy',
      'task.prepare',
      'task.inputs',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
    }
    expect(new Set(APP_CLI_COMMAND_IDS).size).toBe(APP_CLI_COMMAND_IDS.length);
    for (const id of APP_CLI_COMMAND_IDS) {
      expect(id).toMatch(/^(project|config|receipt|events|baseline|phase|feature|task)\.[a-z]+$/);
    }
  });

  it('feature approve：项目/Feature/planDigest/revision 在解析层可得', () => {
    const parsed = parseAppCliArgs([
      'feature', 'approve', FEATURE_ID,
      '--project', PROJECT_ID,
      '--digest', PLAN_DIGEST,
      '--revision', '3',
      '--reason', '验收证据已复核',
      '--json',
    ]);
    expect(parsed).toMatchObject({
      kind: 'command',
      command: 'feature',
      commandId: 'feature.approve',
      operation: 'feature.plan.decide',
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
      planDigest: PLAN_DIGEST,
      revision: 3,
      reason: '验收证据已复核',
      json: true,
    });
  });

  it('feature reject：同一参数面（decision 由子命令给定，不接受 --decision）', () => {
    const parsed = parseAppCliArgs([
      'feature', 'reject', FEATURE_ID,
      '--project', PROJECT_ID,
      '--digest', PLAN_DIGEST,
      '--revision', '1',
    ]);
    expect(parsed).toMatchObject({
      commandId: 'feature.reject',
      operation: 'feature.plan.decide',
      planDigest: PLAN_DIGEST,
    });
    expectParseError(
      [
        'feature', 'reject', FEATURE_ID,
        '--project', PROJECT_ID,
        '--digest', PLAN_DIGEST,
        '--revision', '1',
        '--decision', 'approve',
      ],
      'unknown_argument',
      'decision',
    );
  });

  it('缺少摘要或 revision 一律输入错误（退出码 2 口径）', () => {
    expectParseError(
      ['feature', 'approve', FEATURE_ID, '--project', PROJECT_ID, '--revision', '1'],
      'missing_required_option',
      'digest',
    );
    expectParseError(
      ['feature', 'approve', FEATURE_ID, '--project', PROJECT_ID, '--digest', PLAN_DIGEST],
      'missing_required_option',
      'revision',
    );
    expectParseError(
      ['feature', 'approve', FEATURE_ID, '--digest', PLAN_DIGEST, '--revision', '1'],
      'missing_required_option',
      'project',
    );
  });

  it('非法 planDigest 形态被拒绝且不回显值', () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), `a${'z'.repeat(63)}`, '']) {
      expectParseError(
        ['feature', 'approve', FEATURE_ID, '--project', PROJECT_ID, '--digest', bad, '--revision', '1'],
        'invalid_plan_digest',
        'digest',
      );
    }
  });

  it('task strategy：完整策略副本经 --input 文件给出（CAS + 来源服务端定值）', () => {
    const parsed = parseAppCliArgs([
      'task', 'strategy', TASK_ID,
      '--project', PROJECT_ID,
      '--revision', '2',
      '--input', 'strategy.json',
      '--command-id', randomUUID(),
    ]);
    expect(parsed).toMatchObject({
      command: 'task',
      commandId: 'task.strategy',
      operation: 'task.strategy.update',
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      revision: 2,
      inputFile: 'strategy.json',
    });
    expectParseError(
      ['task', 'strategy', TASK_ID, '--project', PROJECT_ID, '--revision', '2'],
      'missing_required_option',
      'input',
    );
    expectParseError(
      ['task', 'strategy', TASK_ID, '--project', PROJECT_ID, '--input', 'strategy.json'],
      'missing_required_option',
      'revision',
    );
  });

  it('task prepare：Task + Feature 选择在解析层可得；--input 必填（必需输入显式声明）', () => {
    const parsed = parseAppCliArgs([
      'task', 'prepare', TASK_ID,
      '--project', PROJECT_ID,
      '--feature', FEATURE_ID,
      '--input', 'items.json',
    ]);
    expect(parsed).toMatchObject({
      commandId: 'task.prepare',
      operation: 'execution.input.prepare',
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
      inputFile: 'items.json',
    });
    expectParseError(
      ['task', 'prepare', TASK_ID, '--project', PROJECT_ID],
      'missing_required_option',
      'featureId',
    );
    expectParseError(
      ['task', 'prepare', TASK_ID, '--project', PROJECT_ID, '--feature', FEATURE_ID],
      'missing_required_option',
      'input',
    );
  });

  it('task inputs <commandId>：固定输入查看走既有回执查询身份（UUID v4）', () => {
    const targetCommandId = randomUUID();
    const parsed = parseAppCliArgs(['task', 'inputs', targetCommandId, '--json']);
    expect(parsed).toMatchObject({
      commandId: 'task.inputs',
      targetCommandId,
      json: true,
    });
    expectParseError(['task', 'inputs', 'not-a-uuid'], 'invalid_command_id', 'commandId');
    expectParseError(['task', 'inputs'], 'missing_positional');
    expectParseError(['task', 'inputs', randomUUID(), 'extra'], 'too_many_positionals');
  });

  it('未知参数与未知子命令沿用既有拒绝口径', () => {
    expectParseError(
      ['feature', 'approve', FEATURE_ID, '--project', PROJECT_ID, '--digest', PLAN_DIGEST, '--revision', '1', '--run'],
      'unknown_argument',
      'run',
    );
    expectParseError(['feature', 'run', FEATURE_ID], 'unknown_subcommand');
    expectParseError(['task', 'run', TASK_ID], 'unknown_subcommand');
  });
});

/* ------------------------------------------------------------------ *
 * 输入守护（秘密/身份字段；任何 I/O 之前）
 * ------------------------------------------------------------------ */

describe('F-008 输入守护（秘密/身份字段不进请求体）', () => {
  it('策略副本中的秘密字段名被定位拒绝（不回显值）', () => {
    expectScanError(
      () => scanStrategyInputFields({ runtime: 'pi', provider: 'anthropic', model: 'm', apiKey: SECRET_VALUE }, SCAN_CONTEXT),
      'input_secret_field_rejected',
      'executionConfig.apiKey',
    );
    expectScanError(
      () => scanStrategyInputFields({ runtime: 'pi', provider: 'anthropic', model: 'm', credential: { token: SECRET_VALUE } }, SCAN_CONTEXT),
      'input_secret_field_rejected',
      'executionConfig.credential',
    );
    expectScanError(
      () => scanStrategyInputFields({ runtime: 'pi', provider: 'anthropic', model: 'm', auth: SECRET_VALUE }, SCAN_CONTEXT),
      'input_secret_field_rejected',
      'executionConfig.auth',
    );
  });

  it('身份/权限字段名被定位拒绝', () => {
    expectScanError(
      () => scanStrategyInputFields({ runtime: 'pi', provider: 'anthropic', model: 'm', principalId: 'local-owner' }, SCAN_CONTEXT),
      'input_identity_field_rejected',
      'executionConfig.principalId',
    );
    expectScanError(
      () => scanStrategyInputFields({ runtime: 'pi', provider: 'anthropic', model: 'm', scope: { kind: 'global' } }, SCAN_CONTEXT),
      'input_identity_field_rejected',
      'executionConfig.scope',
    );
  });

  it('合法引用字段（credentialRef/endpointRef）通过扫描（只看键名不读值）', () => {
    expect(() =>
      scanStrategyInputFields(
        {
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          credentialRef: 'keychain://shiploop/global-default',
          endpointRef: 'service://model-gateway',
        },
        SCAN_CONTEXT,
      ),
    ).not.toThrow();
  });

  it('固定输入清单只接受 {items:[...]} 形态；秘密/身份字段同样拒绝', () => {
    expect(
      parsePrepareItemsPayload(
        {
          items: [
            { purpose: 'requirements', source: { kind: 'file', root: 'docs', relativePath: 'a.md' } },
          ],
        },
        SCAN_CONTEXT,
      ),
    ).toHaveLength(1);
    expect(parsePrepareItemsPayload({ items: [] }, SCAN_CONTEXT)).toEqual([]);
    expectScanError(
      () => parsePrepareItemsPayload({ items: 'nope' }, SCAN_CONTEXT),
      'input_items_invalid',
      'items',
    );
    expectScanError(
      () => parsePrepareItemsPayload({ items: [], note: 'x' }, SCAN_CONTEXT),
      'unknown_input_field',
      'note',
    );
    expectScanError(
      () =>
        parsePrepareItemsPayload(
          { items: [{ purpose: 'requirements', source: { kind: 'file', root: 'r', relativePath: 'a.md' }, token: SECRET_VALUE }] },
          SCAN_CONTEXT,
        ),
      'input_secret_field_rejected',
      'items[0].token',
    );
    expectScanError(
      () =>
        parsePrepareItemsPayload(
          { items: [{ purpose: 'requirements', source: { kind: 'file', root: 'r', relativePath: 'a.md' }, principalId: 'p' }] },
          SCAN_CONTEXT,
        ),
      'input_identity_field_rejected',
      'items[0].principalId',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 帮助与不宣称纪律
 * ------------------------------------------------------------------ */

describe('F-008 帮助与输出纪律（不宣称执行可用）', () => {
  it('批准/拒绝帮助明确未启动执行、不重新应用默认策略、未知执行能力不显示为可运行', () => {
    for (const scope of ['feature.approve', 'feature.reject'] as const) {
      const help = getAppCliHelp(scope);
      expect(help).toContain('planDigest');
      expect(help).toContain('--revision');
      expect(help).toContain('未启动执行');
      expect(help).toContain('未知执行能力不显示为可运行');
      expect(help).toContain('不重新应用默认策略');
    }
  });

  it('策略编辑帮助明确完整副本整体替换、来源由服务端定值', () => {
    const help = getAppCliHelp('task.strategy');
    expect(help).toContain('完整策略副本');
    expect(help).toContain('task_edit');
    expect(help).toContain('未启动执行');
  });

  it('输入准备/查看帮助明确制品组版本/hash/用途与回执查询路径', () => {
    const prepare = getAppCliHelp('task.prepare');
    expect(prepare).toContain('制品组');
    expect(prepare).toContain('未启动执行');
    const view = getAppCliHelp('task.inputs');
    expect(view).toContain('回执');
    expect(view).toContain('version');
  });

  it('feature/task 顶层帮助列出新子命令且不出现 Run/Work 启动命令', () => {
    const featureHelp = getAppCliHelp('feature');
    expect(featureHelp).toContain('approve');
    expect(featureHelp).toContain('reject');
    const taskHelp = getAppCliHelp('task');
    expect(taskHelp).toContain('strategy');
    expect(taskHelp).toContain('prepare');
    expect(taskHelp).toContain('inputs');
    for (const help of [featureHelp, taskHelp]) {
      expect(help).not.toMatch(/shiploop (run|work)\b/);
    }
  });
});
