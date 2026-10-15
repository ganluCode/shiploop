/**
 * P03-5 / F-012 工作区状态展示与人工丢弃预览/确认 CLI 纯面层（参数解析、
 * 结构化视图、预览文档守护与帮助）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/workspace.ts` 视图投影 /
 * `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - `workspace list/get/operations/operation/discard-preview/discard` 命令身份与
 *   参数映射在解析层可得；非法 project/feature/operation ID、非法分页参数在任何
 *   I/O 之前以稳定 reason 拒绝，错误不回显参数值；
 * - 破坏性确认缺 `--confirm` 或缺 `--preview-file` 在解析层本地拒绝
 *   （confirmation_required / missing_required_option），不隐式预览后自动同意；
 * - 结构化视图区分准备中/准备完成/保留/隔离/可清理/实际已清理与操作失败，
 *   pending 不是最终结论，accepted/准备完成/已清理均不显示为 Feature 交付
 *   （completion.featureVerified/delivered 恒 false）；
 * - 预览文档守护：畸形形状在本地拒绝（invalid_preview_file），Feature 不一致
 *   拒绝（preview_feature_mismatch）；确认负载只从预览绑定派生；
 * - 帮助说明可信项目非强 OS 隔离、失败默认保留与本阶段尚无完整 Runtime/提交闭环。
 *
 * 纵向（真实临时 Host + CLI 执行路径）见 `p03-5-cli-workspace-vertical.test.ts`；
 * 正式构建入口验收见 `p03-5-cli-workspace-built.test.ts`。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMANDS,
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  getAppCliHelp,
  parseAppCliArgs,
} from '../packages/cli/src/index.ts';
import {
  buildWorkspaceDiscardConfirmPayload,
  buildWorkspaceDiscardPreviewView,
  buildWorkspaceDiscardSubmitView,
  buildWorkspaceDetailView,
  buildWorkspaceListView,
  buildWorkspaceOperationDetailView,
  buildWorkspaceOperationListView,
  classifyWorkspaceState,
  formatWorkspaceDetailView,
  formatWorkspaceDiscardPreviewView,
  formatWorkspaceDiscardSubmitView,
  formatWorkspaceListView,
  formatWorkspaceOperationDetailView,
  parseWorkspaceDiscardPreviewDocument,
} from '../packages/cli/src/app/workspace.ts';
import type {
  PublicWorkspaceOperationRecord,
  PublicWorkspaceRecord,
  WorkspaceDetailResult,
  WorkspaceDiscardPreview,
  WorkspaceListResult,
  WorkspaceOperationListResult,
} from '../packages/host/src/index.ts';

const PROJECT_ID = randomUUID();
const FEATURE_ID = 'feature-a';
const WORKSPACE_ID = randomUUID();
const OPERATION_ID = randomUUID();
const COMMAND_ID = randomUUID();
const RUN_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const COMMIT = 'b'.repeat(40);
const DIGEST = 'a'.repeat(64);
const DIGEST_B = 'c'.repeat(64);
const NOW_ISO = '2026-10-15T00:00:00.000Z';

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
    const parseError = error as AppCliParseError;
    expect(parseError.reason).toBe(reason);
    if (field !== undefined) {
      expect(parseError.field).toBe(field);
    }
    return parseError;
  }
  throw new Error(`expected parse failure for ${JSON.stringify(args)}`);
}

/* ------------------------------------------------------------------ *
 * 线形状夹具（HostClient 已校验结果的等价形态；纯投影不改写事实）
 * ------------------------------------------------------------------ */

function workspaceRecord(status: PublicWorkspaceRecord['status']): PublicWorkspaceRecord {
  return {
    id: WORKSPACE_ID,
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    preparationOperationId: OPERATION_ID,
    status,
    revision: 2,
    branch: 'feature/feature-a',
    baseCommit: COMMIT,
    headCommit: COMMIT,
    codeDigest: DIGEST,
    repositoryBindingId: randomUUID(),
    repositoryBindingRevision: 1,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    executionVersion: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function operationRecord(
  status: PublicWorkspaceOperationRecord['status'],
  kind: PublicWorkspaceOperationRecord['kind'] = 'prepare',
): PublicWorkspaceOperationRecord {
  return {
    id: OPERATION_ID,
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    kind,
    executionStage: 'preflight',
    status,
    revision: 1,
    principalId: 'principal-1',
    commandId: COMMAND_ID,
    requestDigest: DIGEST,
    result:
      status === 'pending'
        ? null
        : {
            evidenceRefs: ['ev-1'],
            errorRef: status === 'failed' ? 'err-1' : null,
            startedAt: NOW_ISO,
            endedAt: NOW_ISO,
            durationMs: 12,
            exitCode: status === 'failed' ? 1 : 0,
            signal: null,
          },
    receipt: {
      commandId: COMMAND_ID,
      resultRef: 'res-1',
      status: 'completed',
      reason: status === 'failed' ? 'git_failed' : null,
    },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function previewDocument(): WorkspaceDiscardPreview {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    workspaceId: WORKSPACE_ID,
    branch: 'feature/feature-a',
    baseCommit: COMMIT,
    status: 'retained',
    scope: 'worktree_only',
    workspaceRevision: 2,
    headCommit: COMMIT,
    codeDigest: DIGEST,
    ignoredDigest: DIGEST_B,
    expiresAtUtcMs: 1_800_000_000_000,
    previewDigest: DIGEST,
    contents: {
      tracked: [],
      untracked: [],
      ignored: [],
      counts: { tracked: 1, untracked: 2, ignored: 3, bytes: 42 },
      truncated: false,
    },
    impact: {
      irreversible: true,
      discardsUncommittedTrackedChanges: 1,
      discardsUntrackedFiles: 2,
      discardsIgnoredFiles: 3,
      discardsBytes: 42,
      preserves: ['source_repository', 'feature_branch', 'committed_work', 'audit_records'],
    },
    blockers: [],
    observedAtUtcMs: 1_800_000_000_000,
    evidenceRef: 'ev-preview',
  };
}

/* ------------------------------------------------------------------ *
 * A. 命令面与参数解析
 * ------------------------------------------------------------------ */

describe('F-012 工作区命令面与解析', () => {
  it('workspace 进入命令组与命令身份清单（不新增 run/work 命令）', () => {
    expect([...APP_CLI_COMMANDS]).toContain('workspace');
    for (const id of [
      'workspace.list',
      'workspace.get',
      'workspace.operations',
      'workspace.operation',
      'workspace.discard-preview',
      'workspace.discard',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
    }
    expect([...APP_CLI_COMMANDS]).not.toContain('run');
    expect([...APP_CLI_COMMANDS]).not.toContain('work');
  });

  it('workspace list/get/operations/operation：正常参数映射', () => {
    const list = parseAppCliArgs(['workspace', 'list', '--project', PROJECT_ID], {});
    expect(list).toMatchObject({
      commandId: 'workspace.list',
      projectId: PROJECT_ID,
    });
    const filtered = parseAppCliArgs(
      ['workspace', 'list', '--project', PROJECT_ID, '--feature', FEATURE_ID, '--limit', '10', '--cursor', 'wscur_v1_abc'],
      {},
    );
    expect(filtered).toMatchObject({
      commandId: 'workspace.list',
      featureId: FEATURE_ID,
      limit: 10,
      cursor: 'wscur_v1_abc',
    });
    const get = parseAppCliArgs(['workspace', 'get', FEATURE_ID, '--project', PROJECT_ID], {});
    expect(get).toMatchObject({ commandId: 'workspace.get', featureId: FEATURE_ID });
    const operations = parseAppCliArgs(
      ['workspace', 'operations', '--project', PROJECT_ID, '--feature', FEATURE_ID],
      {},
    );
    expect(operations).toMatchObject({ commandId: 'workspace.operations', featureId: FEATURE_ID });
    const operation = parseAppCliArgs(
      ['workspace', 'operation', OPERATION_ID, '--project', PROJECT_ID],
      {},
    );
    expect(operation).toMatchObject({ commandId: 'workspace.operation', operationId: OPERATION_ID });
  });

  it('workspace discard-preview/discard：正常参数映射（operation 身份同源）', () => {
    const preview = parseAppCliArgs(
      ['workspace', 'discard-preview', FEATURE_ID, '--project', PROJECT_ID, '--command-id', COMMAND_ID],
      {},
    );
    expect(preview).toMatchObject({
      commandId: 'workspace.discard-preview',
      operation: 'workspace.discard.preview',
      featureId: FEATURE_ID,
      explicitCommandId: COMMAND_ID,
    });
    const confirm = parseAppCliArgs(
      ['workspace', 'discard', FEATURE_ID, '--project', PROJECT_ID, '--preview-file', '/tmp/p.json', '--confirm'],
      {},
    );
    expect(confirm).toMatchObject({
      commandId: 'workspace.discard',
      operation: 'workspace.discard',
      featureId: FEATURE_ID,
      previewFile: '/tmp/p.json',
      confirm: true,
    });
  });

  it('破坏性确认缺 --confirm 或缺 --preview-file 在解析层本地拒绝', () => {
    expectParseError(
      ['workspace', 'discard', FEATURE_ID, '--project', PROJECT_ID, '--preview-file', '/tmp/p.json'],
      'confirmation_required',
      'confirm',
    );
    expectParseError(
      ['workspace', 'discard', FEATURE_ID, '--project', PROJECT_ID, '--confirm'],
      'missing_required_option',
      'preview-file',
    );
  });

  it('非法 ID/分页/未知参数在解析层拒绝（不回显参数值）', () => {
    expectParseError(['workspace', 'list', '--project', 'not-a-uuid'], 'invalid_project_id');
    expectParseError(
      ['workspace', 'get', 'bad id!', '--project', PROJECT_ID],
      'invalid_plan_id',
      'featureId',
    );
    expectParseError(
      ['workspace', 'operation', 'not-a-uuid', '--project', PROJECT_ID],
      'invalid_operation_id',
      'operationId',
    );
    expectParseError(
      ['workspace', 'list', '--project', PROJECT_ID, '--limit', '0'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['workspace', 'list', '--project', PROJECT_ID, '--limit', '501'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['workspace', 'operations', '--project', PROJECT_ID, '--limit', 'abc'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['workspace', 'list', '--project', PROJECT_ID, '--bogus'],
      'unknown_argument',
    );
    expectParseError(
      ['workspace', 'discard', FEATURE_ID, '--project', PROJECT_ID, '--preview-file', '/tmp/p', '--confirm', '--listen', 'x'],
      'listen_override_argument_rejected',
    );
    const error = expectParseError(
      ['workspace', 'get', 'bad id!', '--project', PROJECT_ID],
      'invalid_plan_id',
    );
    expect(error.message).not.toContain('bad id!');
  });

  it('未知子命令/缺子命令拒绝', () => {
    expectParseError(['workspace'], 'missing_subcommand');
    expectParseError(['workspace', 'bogus'], 'unknown_subcommand');
  });
});

/* ------------------------------------------------------------------ *
 * B. 结构化视图（状态分类与不交付声明）
 * ------------------------------------------------------------------ */

describe('F-012 工作区结构化视图', () => {
  it('状态分类一一映射：preparing/prepared/retained/quarantined/cleanable/cleaned', () => {
    expect(classifyWorkspaceState('preparing')).toBe('preparing');
    expect(classifyWorkspaceState('ready')).toBe('prepared');
    expect(classifyWorkspaceState('retained')).toBe('retained');
    expect(classifyWorkspaceState('quarantined')).toBe('quarantined');
    expect(classifyWorkspaceState('cleanup_pending')).toBe('cleanable');
    expect(classifyWorkspaceState('cleaned')).toBe('cleaned');
  });

  it('list 视图：逐条分类 + 分页 + 不交付声明', () => {
    const result: WorkspaceListResult = {
      schemaVersion: 5,
      scope: 'workspace-list',
      records: [workspaceRecord('ready'), { ...workspaceRecord('quarantined'), id: randomUUID() }],
      nextCursor: null,
      limit: 100,
    };
    const view = buildWorkspaceListView(result);
    expect(view.records.map((entry) => entry.state)).toEqual(['prepared', 'quarantined']);
    expect(view.completion).toMatchObject({ featureVerified: false, delivered: false });
    const text = formatWorkspaceListView(view);
    expect(text).toContain('state=prepared');
    expect(text).toContain('state=quarantined');
    expect(text).toContain('不代表 Feature 交付');
    expect(text).not.toContain('/Users/');
  });

  it('get 视图：准备/最新 operation 分层；failed 如实展示原因与证据引用', () => {
    const detail: WorkspaceDetailResult = {
      workspace: workspaceRecord('retained'),
      preparationOperation: operationRecord('succeeded', 'prepare'),
      latestOperation: { ...operationRecord('failed', 'discard'), id: randomUUID() },
    };
    const view = buildWorkspaceDetailView(detail);
    expect(view.state).toBe('retained');
    expect(view.latestClassification).toMatchObject({ terminal: true, failed: true });
    const text = formatWorkspaceDetailView(view);
    expect(text).toContain('kind=discard');
    expect(text).toContain('status=failed');
    expect(text).toContain('reason=git_failed');
    expect(text).toContain('operation_failed');
  });

  it('operations 视图：pending 不是最终结论；blocked 是受阻隔离', () => {
    const result: WorkspaceOperationListResult = {
      schemaVersion: 5,
      scope: 'workspace-operation-list',
      records: [operationRecord('pending', 'discard'), operationRecord('blocked', 'cleanup')],
      nextCursor: null,
      limit: 100,
    };
    const view = buildWorkspaceOperationListView(result);
    expect(view.records[0]?.classification).toMatchObject({ terminal: false });
    expect(view.records[1]?.classification).toMatchObject({ terminal: true, blocked: true });
  });

  it('operation 详情视图：保留回执引用与未知耗时（null 不填零）', () => {
    const record = operationRecord('pending', 'discard');
    const view = buildWorkspaceOperationDetailView({ operation: record });
    expect(view.record.result).toBeNull();
    const text = formatWorkspaceOperationDetailView(view);
    expect(text).toContain('pending_not_outcome');
    expect(text).toContain('exit=unknown');
    expect(text).toContain('receipt=completed');
  });

  it('预览视图：绑定摘要/有效期/不可逆影响展示，预览不是删除', () => {
    const view = buildWorkspaceDiscardPreviewView(COMMAND_ID, false, previewDocument());
    expect(view.preview.previewDigest).toBe(DIGEST);
    expect(view.state).toBe('retained');
    expect(view.preview.scope).toBe('worktree_only');
    expect(view.preview.impact.preserves).toContain('source_repository');
    // preview 逐字节回喂即合法 --preview-file（round-trip 不失真）。
    expect(view.preview).toEqual(previewDocument());
    const formatted = formatWorkspaceDiscardPreviewView(view);
    expect(formatted).toContain('预览不是删除');
    expect(formatted).toContain(DIGEST);
    expect(formatted).toContain('worktree_only');
  });

  it('确认回执视图：completed 不等于丢弃成功，指向 operation 查询', () => {
    const view = buildWorkspaceDiscardSubmitView(COMMAND_ID, false, {
      workspaceOperationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      previewDigest: DIGEST,
    });
    expect(view.completion.delivered).toBe(false);
    const text = formatWorkspaceDiscardSubmitView(view);
    expect(text).toContain('completed 不等于丢弃成功');
    expect(text).toContain(OPERATION_ID);
  });
});

/* ------------------------------------------------------------------ *
 * C. 预览文档守护（本地拒绝，不发确认请求）
 * ------------------------------------------------------------------ */

describe('F-012 丢弃预览文档守护', () => {
  const context = { command: 'workspace' as const, commandId: 'workspace.discard' as const };

  it('合法预览文档通过并派生确认负载（绑定 revision/摘要/证据引用）', () => {
    const preview = parseWorkspaceDiscardPreviewDocument(
      previewDocument() as unknown as Record<string, unknown>,
      context,
    );
    const payload = buildWorkspaceDiscardConfirmPayload(preview, FEATURE_ID, context);
    expect(payload).toEqual({
      featureId: FEATURE_ID,
      workspaceId: WORKSPACE_ID,
      expectedWorkspaceRevision: 2,
      preview: {
        previewDigest: DIGEST,
        headCommit: COMMIT,
        codeDigest: DIGEST,
        ignoredDigest: DIGEST_B,
        workspaceRevision: 2,
        expiresAtUtcMs: 1_800_000_000_000,
      },
      evidenceRefs: ['ev-preview'],
    });
  });

  it('畸形/篡改预览形状本地拒绝（invalid_preview_file）', () => {
    for (const mutate of [
      (doc: Record<string, unknown>) => ({ ...doc, previewDigest: 'not-hex' }),
      (doc: Record<string, unknown>) => ({ ...doc, scope: 'everything' }),
      (doc: Record<string, unknown>) => ({ ...doc, schemaVersion: 2 }),
      (doc: Record<string, unknown>) => ({ ...doc, extra: 1 }),
      (doc: Record<string, unknown>) => ({ ...doc, impact: { ...(doc.impact as object), irreversible: false } }),
    ]) {
      try {
        parseWorkspaceDiscardPreviewDocument(
          mutate(previewDocument() as unknown as Record<string, unknown>),
          context,
        );
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(AppCliParseError);
        expect((error as AppCliParseError).reason).toBe('invalid_preview_file');
        expect((error as AppCliParseError).field).toBe('preview-file');
      }
    }
  });

  it('预览 Feature 与命令目标不一致本地拒绝（preview_feature_mismatch）', () => {
    const preview = parseWorkspaceDiscardPreviewDocument(
      previewDocument() as unknown as Record<string, unknown>,
      context,
    );
    try {
      buildWorkspaceDiscardConfirmPayload(preview, 'feature-b', context);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AppCliParseError);
      expect((error as AppCliParseError).reason).toBe('preview_feature_mismatch');
    }
  });
});

/* ------------------------------------------------------------------ *
 * D. 帮助（可信项目边界与本阶段闭环声明）
 * ------------------------------------------------------------------ */

describe('F-012 工作区帮助', () => {
  it('组帮助与各子命令帮助可得且含边界声明', () => {
    const group = getAppCliHelp('workspace');
    expect(group).toContain('discard-preview');
    expect(group).toContain('discard');
    for (const scope of [
      'workspace.list',
      'workspace.get',
      'workspace.operations',
      'workspace.operation',
      'workspace.discard-preview',
      'workspace.discard',
    ] as const) {
      expect(getAppCliHelp(scope).length).toBeGreaterThan(0);
    }
    const discard = getAppCliHelp('workspace.discard');
    expect(discard).toContain('强 OS 隔离');
    expect(discard).toContain('失败默认保留');
    expect(discard).toContain('尚无完整 Runtime/提交闭环');
    expect(discard).toContain('--confirm');
    expect(discard).toContain('--preview-file');
    expect(discard).toContain('completed 不等于');
    const preview = getAppCliHelp('workspace.discard-preview');
    expect(preview).toContain('预览不是删除');
    expect(preview).toContain('worktree_only');
  });
});
