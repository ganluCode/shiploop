/**
 * P08-1 / F-005 文档守护：`docs/p08-1-user-guide.md`（新用户安装与操作指南）
 * 必须与真实 CLI/Host 契约和冻结的分发兼容声明一致，且示例保持脱敏。
 *
 * 本套件不新增业务实现、不启动 Host、不调用模型：
 * 1) 提取指南所有 sh 代码块中的 `shiploop …` 命令行（含续行与注释语义），
 *    绑定占位符后经真实解析面（parseAppCliArgs / parseHostCliArgs）核对；
 *    标注「退出码 2」的负例命令必须被解析面拒绝；
 * 2) 指南中的结构化 JSON 示例逐块可解析，且预算文档 / 规划输入 / Feature 计划
 *    分别经真实校验函数（parseExecutionBudgetDocument / parsePlanningStartInput /
 *    validateFeaturePlanInput）核对；Host 信封示例的协议版本与
 *    distribution-compatibility.json 冻结值一致；
 * 3) 脱敏纪律：不含开发机绝对路径、真实凭据形态、手工改库步骤；UUID 字面量
 *    只允许指南声明的占位集合；退出码档位只允许 0/1/2/3/4；
 * 4) 支持边界（macOS 正式支持；Windows/WSL/Linux 未支持；npm 发布未定；
 *    Electron 后置；真实模型需独立授权）与 not_run 边界逐项在场；
 *    README 文档导航登记本指南。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  HostCliParseError,
  parseAppCliArgs,
  parseHostCliArgs,
} from '../../../packages/cli/src/index.ts';
import { parseExecutionBudgetDocument } from '../../../packages/cli/src/app/execution.ts';
import { parsePlanningStartInput } from '../../../packages/cli/src/app/planning.ts';
import { validateFeaturePlanInput } from '../../../packages/core/src/ports/feature-plan.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GUIDE_PATH = 'docs/p08-1-user-guide.md';
const guide = readFileSync(resolve(REPO_ROOT, GUIDE_PATH), 'utf-8');
const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8');
const compatibility = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'distribution-compatibility.json'), 'utf-8'),
) as {
  distributionMode: string;
  published: boolean;
  platforms: string[];
  toolchain: { node: string; npm: string };
  hostProtocol: {
    wireProtocolVersions: number[];
    wireSchemaVersion: number;
    legacyHandshakeSchemaVersionsAccepted: number[];
    unknownVersionPolicy: string;
  };
  databaseSchema: { writableTargetVersion: number };
  releaseBlockers: { ownerConfirmation: string };
  phaseIntegration: { status: string };
};

/** 指南声明的占位 UUID 白名单（任何其他 UUID 形状字面量都视为泄漏/漂移）。 */
const PLACEHOLDER_UUIDS = new Set([
  '11111111-2222-4333-8444-555555555555',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
]);

const HEX64 = 'ab'.repeat(32);
const TMP = mkdtempSync(join(tmpdir(), 'shiploop-f005-guide-'));

/** 指南占位符 → 与解析面契约一致的绑定值（路径为真实临时绝对路径）。 */
const BINDINGS: Record<string, string> = {
  $DATA_ROOT: join(TMP, 'data'),
  $RESTORE_ROOT: join(TMP, 'restore'),
  $WORK_DIR: join(TMP, 'work'),
  $REPO: join(TMP, 'repo'),
  $INSTALL_DIR: join(TMP, 'install'),
  $PACK_DIR: join(TMP, 'pack'),
  $PROJECT_ID: randomUUID(),
  $PHASE_ID: randomUUID(),
  $FEATURE_ID: randomUUID(),
  $CANDIDATE_ID: randomUUID(),
  $TASK_ID: randomUUID(),
  $BATCH_ID: randomUUID(),
  $RUN_ID: randomUUID(),
  $ATTEMPT_ID: randomUUID(),
  $OPERATION_ID: randomUUID(),
  $RESTORE_OPERATION_ID: randomUUID(),
  $DELETE_OPERATION_ID: randomUUID(),
  $COMMAND_ID: randomUUID(),
  $CANDIDATE_DIGEST: HEX64,
  $MANIFEST_DIGEST: HEX64,
  $PREVIEW_DIGEST: HEX64,
  $DELETE_DIGEST: HEX64,
  $FEATURE_REVISION: '1',
  $PROJECT_REVISION: '1',
  $EXPIRES_AT_MS: '4102444800000',
};

interface DocumentedCommand {
  readonly argv: string[];
  readonly negative: boolean;
  readonly raw: string;
}

/** 引号感知地去掉行内注释，返回 [命令正文, 注释]。 */
function stripComment(line: string): { command: string; comment: string } {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === '"') quoted = !quoted;
    if (char === '#' && !quoted) {
      return { command: line.slice(0, index).trim(), comment: line.slice(index) };
    }
  }
  return { command: line.trim(), comment: '' };
}

/** 极简 shell 风格分词：空白分隔、双引号保留内容（指南示例无转义/单引号参数）。 */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of commandLine) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  expect(quoted, `引号不配对：${commandLine}`).toBe(false);
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** 提取全部 ```sh 代码块中的 shiploop 命令行（合并续行；记录注释中的退出码语义）。 */
function documentedCommands(): DocumentedCommand[] {
  const commands: DocumentedCommand[] = [];
  for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const lines = (block[1] as string).split('\n');
    let pending: string | null = null;
    for (const rawLine of lines) {
      const { command, comment } = stripComment(rawLine.trim());
      if (command.length === 0) {
        expect(pending, `注释行不得打断续行：${rawLine}`).toBeNull();
        continue;
      }
      const joined: string = pending === null ? command : `${pending} ${command}`;
      pending = null;
      if (joined.endsWith('\\')) {
        pending = joined.slice(0, -1).trim();
        continue;
      }
      if (!joined.startsWith('shiploop ')) continue;
      const bound = tokenize(joined.slice('shiploop '.length))
        .map((token) => {
          let value = token;
          for (const [placeholder, replacement] of Object.entries(BINDINGS)) {
            value = value.split(placeholder).join(replacement);
          }
          return value;
        });
      commands.push({
        argv: bound,
        negative: comment.includes('退出码 2'),
        raw: joined,
      });
    }
    expect(pending, '指南命令行不得以悬挂续行结尾').toBeNull();
  }
  return commands;
}

/** 提取全部 ```json 代码块正文。 */
function jsonBlocks(): string[] {
  return [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] as string);
}

/** 提取 sh 块内 cat <<'JSON' … JSON 的 heredoc 正文（模型配置示例）。 */
function heredocJsonBlocks(): string[] {
  return [...guide.matchAll(/<<'JSON'\n([\s\S]*?)\nJSON/g)].map((match) => match[1] as string);
}

describe('F-005 指南命令契约（真实解析面，无 I/O 副作用）', () => {
  const commands = documentedCommands();

  it('指南包含覆盖全部章节的 shiploop 命令示例', () => {
    expect(commands.length).toBeGreaterThanOrEqual(45);
    expect(commands.some((command) => command.negative)).toBe(true);
  });

  it('每条命令被真实解析面接受；标注退出码 2 的负例被本地拒绝', () => {
    for (const command of commands) {
      const [group] = command.argv;
      if (group === 'host') {
        if (command.negative) {
          let thrown: unknown;
          try {
            parseHostCliArgs(command.argv, {});
          } catch (error) {
            thrown = error;
          }
          expect(thrown, command.raw).toBeInstanceOf(HostCliParseError);
          expect(
            (thrown as HostCliParseError).code,
            command.raw,
          ).toBe('bind_address_override_rejected');
        } else {
          expect(() => parseHostCliArgs(command.argv, {}), command.raw).not.toThrow();
        }
        continue;
      }
      if (command.negative) {
        expect(() => parseAppCliArgs(command.argv, {}, { cwd: TMP }), command.raw).toThrow(
          AppCliParseError,
        );
        continue;
      }
      const parsed = parseAppCliArgs(command.argv, {}, { cwd: TMP });
      expect('commandId' in parsed, command.raw).toBe(true);
      expect('commandId' in parsed ? parsed.commandId : '', command.raw).toMatch(
        new RegExp(`^${group}\\.`),
      );
    }
  });

  it('命令族覆盖与指南章节一致（不缺不多）', () => {
    const families = new Set(
      commands.map((command) => {
        const second = command.argv[1];
        return second !== undefined && !second.startsWith('-')
          ? `${command.argv[0]} ${second}`
          : (command.argv[0] as string);
      }),
    );
    expect([...families].sort()).toEqual([
      'backup create',
      'backup get',
      'backup operation',
      'backup verify',
      'baseline preview',
      'baseline run',
      'config create',
      'config effective',
      'config export',
      'events',
      'execution attempts',
      'execution budget',
      'execution cancel',
      'execution control',
      'execution diagnostics',
      'execution pause',
      'execution preview',
      'execution recovery',
      'execution resume',
      'execution revise',
      'execution runs',
      'execution start',
      'feature delivery',
      'feature get',
      'feature import',
      'feature report',
      'host',
      'host start',
      'host status',
      'host stop',
      'phase create',
      'planning approve',
      'planning candidate',
      'planning list',
      'planning start',
      'project archive',
      'project delete-confirm',
      'project delete-operation',
      'project delete-preview',
      'project init',
      'project overview',
      'receipt get',
      'restore confirm',
      'restore prepare',
      'restore verify',
      'retention cleanup',
      'retention evaluation',
      'task list',
      'task status',
      'workspace discard',
      'workspace discard-preview',
      'workspace list',
    ]);
  });
});

describe('F-005 指南结构化示例与真实校验契约一致', () => {
  const blocks = jsonBlocks();
  const heredocs = heredocJsonBlocks();

  it('全部 JSON 示例可解析（含 sh 块内 heredoc 配置示例）', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(heredocs.length).toBeGreaterThanOrEqual(1);
    for (const block of [...blocks, ...heredocs]) {
      expect(() => JSON.parse(block), block.slice(0, 80)).not.toThrow();
    }
  });

  it('预算文档示例通过 parseExecutionBudgetDocument（ISO 日期映射为 epoch 毫秒）', () => {
    const block = blocks.find((candidate) => candidate.includes('"maxTokenTotal"'));
    expect(block, '指南必须包含完整有限预算示例').toBeDefined();
    const wire = parseExecutionBudgetDocument(JSON.parse(block as string), {
      command: 'execution',
      commandId: 'execution.preview',
      json: true,
    }) as { batch: { deadlineUtcMs: number; maxRuns: number } };
    expect(wire.batch.maxRuns).toBe(2);
    expect(typeof wire.batch.deadlineUtcMs).toBe('number');
  });

  it('规划输入示例通过 parsePlanningStartInput（顶层键封闭、manual 审批）', () => {
    const block = blocks.find((candidate) => candidate.includes('"approvalMode"'));
    expect(block, '指南必须包含规划输入示例').toBeDefined();
    const input = parsePlanningStartInput(JSON.parse(block as string), {
      commandId: 'planning.start',
      json: true,
    });
    expect(input.strategy.approvalMode).toBe('manual');
    expect(input.requirementRefs).toEqual([]);
  });

  it('Feature 草稿计划示例通过 Core validateFeaturePlanInput', () => {
    const block = blocks.find((candidate) => candidate.includes('"sourceRefs"'));
    expect(block, '指南必须包含 Feature 计划示例').toBeDefined();
    const plan = validateFeaturePlanInput(JSON.parse(block as string));
    expect(plan.tasks).toHaveLength(1);
  });

  it('模型配置示例只含占位引用，不含明文凭据字段', () => {
    const block = [...blocks, ...heredocs].find((candidate) =>
      candidate.includes('"schemaVersion": 2'),
    );
    expect(block, '指南必须包含配置 v2 示例').toBeDefined();
    const config = JSON.parse(block as string) as {
      strategies: { defaultStrategy: Record<string, string> };
    };
    expect(Object.keys(config.strategies.defaultStrategy).sort()).toEqual(
      expect.arrayContaining(['credentialRef', 'model', 'provider', 'runtime']),
    );
    expect(config.strategies.defaultStrategy.credentialRef).toBe('<credential-ref>');
    for (const forbidden of ['apiKey', 'token', 'password']) {
      expect(block, forbidden).not.toContain(forbidden);
    }
  });

  it('Host 信封示例的协议版本与冻结兼容声明一致', () => {
    const block = blocks.find((candidate) => candidate.includes('"host.start"'));
    expect(block, '指南必须包含 host start JSON 信封示例').toBeDefined();
    const envelope = JSON.parse(block as string) as {
      result: { protocolVersion: number; hostInstanceId: string };
    };
    expect(envelope.result.protocolVersion).toBe(
      compatibility.hostProtocol.wireProtocolVersions[0],
    );
    expect(PLACEHOLDER_UUIDS).toContain(envelope.result.hostInstanceId);
  });
});

describe('F-005 支持边界与兼容声明绑定', () => {
  it('指南声明的工具链/平台/协议/Schema 与 distribution-compatibility.json 一致', () => {
    expect(guide).toContain(compatibility.toolchain.node);
    expect(guide).toContain(compatibility.toolchain.npm);
    expect(guide).toContain(compatibility.platforms.join(', '));
    expect(compatibility.distributionMode).toBe('local-pack-only');
    expect(guide).toContain('local-pack-only');
    expect(compatibility.published).toBe(false);
    expect(guide).toContain('published: false');
    expect(guide).toContain(
      `wireSchemaVersion ${compatibility.hostProtocol.wireSchemaVersion}`,
    );
    expect(guide).toContain(
      `legacy \`${compatibility.hostProtocol.legacyHandshakeSchemaVersionsAccepted[0]}\``,
    );
    expect(guide).toContain(
      `数据库 Schema 可写目标版本 \`${compatibility.databaseSchema.writableTargetVersion}\``,
    );
    expect(compatibility.hostProtocol.unknownVersionPolicy).toBe('reject');
    expect(compatibility.releaseBlockers.ownerConfirmation).toBe('pending');
    expect(compatibility.phaseIntegration.status).toBe('not_run');
  });

  it('指南逐项标记支持边界：未支持 / 后置 / 需独立授权 / 未定', () => {
    for (const [token, meaning] of [
      ['Windows / WSL / Linux', '未支持'],
      ['Electron', '后置'],
      ['真实模型验收', '需独立授权'],
      ['公开 npm 发布', '未定'],
    ] as const) {
      expect(guide, `${token} 必须标记 ${meaning}`).toContain(token);
    }
    expect(guide).toContain('| Windows / WSL / Linux | **未支持**');
    expect(guide).toContain('| Electron / 桌面客户端 | **后置**');
    expect(guide).toContain('| 真实模型验收 | **需独立授权**');
    expect(guide).toContain('正式支持平台 | macOS');
    expect(guide).toContain('P08 Phase 集成验收');
  });

  it('指南贯穿 accepted/not_run 不等于通过与授权/回执语义', () => {
    for (const token of [
      'accepted',
      'not_run',
      'preview_stale',
      'budget_exhausted',
      'business_completed',
      'stop_unconfirmed',
      'host_not_found',
      'owner_unknown',
      'protocol_incompatible',
      'unsupported_version',
      'retention_policy_not_configured',
      'pending_generation',
      '--confirm',
      '--preview-digest',
      '--data-root',
      'receipt get',
      '不等于',
      '不折算',
      '不从日志成功文字推断',
    ]) {
      expect(guide, token).toContain(token);
    }
  });
});

describe('F-005 脱敏与占位纪律', () => {
  it('不含开发机绝对路径、真实凭据形态或手工改库步骤', () => {
    for (const forbidden of [
      '/Users/',
      'Documents/my-dev',
      'shiploop-harness',
      'sk-',
      'Bearer eyJ',
      'INSERT INTO',
      'UPDATE projects',
    ]) {
      expect(guide, forbidden).not.toContain(forbidden);
    }
    // 手工改库 = 对数据库文件直接执行 sqlite3 命令（指南只允许出现禁止性说明）。
    expect(guide).not.toMatch(/sqlite3\s+\//);
    expect(guide).toContain('禁止手工 sqlite3 改库');
  });

  it('UUID 字面量只允许占位集合；退出码档位只允许 0/1/2/3/4', () => {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    for (const uuid of guide.match(uuidPattern) ?? []) {
      expect(PLACEHOLDER_UUIDS, uuid).toContain(uuid);
    }
    for (const exitCode of guide.matchAll(/退出码 (\d+)/g)) {
      expect(['0', '1', '2', '3', '4'], exitCode[0]).toContain(exitCode[1] as string);
    }
  });

  it('README 文档导航登记本指南', () => {
    expect(readme).toContain(GUIDE_PATH);
  });
});
