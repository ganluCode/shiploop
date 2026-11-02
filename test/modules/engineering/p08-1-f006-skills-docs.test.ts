/**
 * P08-1 / F-006 操作 Skills 同步守护：docs/skills 全部操作 Skill 必须与当前
 * CLI 命令面一致，且只通过受控 CLI/API 操作。
 *
 * 验收映射（.dag_context.json F-006 五项）：
 * 1. 全部 8 份 Skill 文档列出真实存在的命令、必需确认、数据根、结构化输出与
 *    错误/退出码语义；示例命令经真实解析面（parseAppCliArgs / parseHostCliArgs）
 *    核对命令身份（commandId ∈ APP_CLI_COMMAND_IDS）与帮助文本（getAppCliHelp /
 *    getHostCliHelp 的 usage 行）；不引用已删除、未实现或后置命令。
 * 2. Skill 流程语义在场：预览与显式批准分离、accepted 与 completed 分离、观察
 *    中断不取消执行、停止必须显式发起、备份恢复受权限和兼容性检查约束。
 * 3. 静态边界：不直接修改 SQLite/task_list 元数据/权限文件/发布配置；npm
 *    install/run 只允许出现在安装 Skill；npm publish 只允许否定语境；不解析
 *    易变日志判定通过；不请求真实模型；不含真实凭据/本机固定路径/自动同意选项。
 * 4. 文档负例经真实解析面核对：未知命令（chat/electron 后置能力 → unknown_
 *    command）、缺确认（execution start/cancel → confirmation_required）、监听
 *    覆盖（host start --bind → HostCliParseError）都被本地拒绝，退出码 2。
 * 5. 真实安装目录 Skill 驱动 Todo 演示、存量仓库增量变更与跨层失败恢复标为
 *    P08-2/P08-3/P08-4 集成验收，不在本 Task 折算通过。
 *
 * 全部为静态文本与纯解析校验：不启动 Host、不打开 SQLite、不执行任何示例命令。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  HostCliParseError,
  getAppCliHelp,
  getHostCliHelp,
  parseAppCliArgs,
  parseHostCliArgs,
} from '../../../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** F-006 覆盖的全部操作 Skill（两个既有 Skill 一并参与同步核对）。 */
const SKILL_FILES = [
  'docs/skills/project-init.md',
  'docs/skills/project-overview.md',
  'docs/skills/host-lifecycle.md',
  'docs/skills/planning-approval.md',
  'docs/skills/execution-observe.md',
  'docs/skills/stop-control.md',
  'docs/skills/backup-restore.md',
  'docs/skills/troubleshooting.md',
] as const;
const SKILL_HOST_LIFECYCLE = 'docs/skills/host-lifecycle.md';
const SKILL_PLANNING = 'docs/skills/planning-approval.md';
const SKILL_OBSERVE = 'docs/skills/execution-observe.md';
const SKILL_STOP = 'docs/skills/stop-control.md';
const SKILL_BACKUP = 'docs/skills/backup-restore.md';
const SKILL_TROUBLESHOOT = 'docs/skills/troubleshooting.md';

/** dist CLI 的两个正式入口形态（与 docs/skills 既有约定一致）。 */
const CLI_ENTRY_PREFIXES = ['node packages/cli/dist/bin.js ', 'shiploop '] as const;

const TMP = mkdtempSync(join(tmpdir(), 'shiploop-f006-skills-'));
const HEX64 = 'ab'.repeat(32);

/** Skill 占位符 → 与解析面契约一致的绑定值（路径为真实临时绝对路径）。 */
const BINDINGS: Record<string, string> = {
  '<data-root>': join(TMP, 'data'),
  '<restore-root>': join(TMP, 'restore'),
  '<repository-path>': join(TMP, 'repo'),
  '<pack-dir>': join(TMP, 'pack'),
  '<install-dir>': join(TMP, 'install'),
  '<projectId>': randomUUID(),
  '<artifactId>': 'artifact-demo',
  '<phaseId>': randomUUID(),
  '<featureId>': randomUUID(),
  '<candidateId>': randomUUID(),
  '<taskId>': randomUUID(),
  '<batchId>': randomUUID(),
  '<runId>': randomUUID(),
  '<attemptId>': randomUUID(),
  '<operationId>': randomUUID(),
  '<commandId>': randomUUID(),
  '<command-id>': randomUUID(),
  '<plan-file>': join(TMP, 'work', 'feature-plan.json'),
  '<planning-input-file>': join(TMP, 'work', 'planning-input.json'),
  '<budget-file>': join(TMP, 'work', 'budget.json'),
  '<confirmation-file>': join(TMP, 'work', 'restore-confirmation.json'),
  '<package-path>': join(TMP, 'data', 'backups', 'demo-backup-0001'),
  '<candidateDigest>': HEX64,
  '<manifestDigest>': HEX64,
  '<previewDigest>': HEX64,
  '<displayName>': '示例项目',
  '<title>': '示例阶段',
  '<backupId>': 'demo-backup-0001',
  '<reason>': '示例原因',
};

interface FencedBlock {
  readonly lang: string;
  readonly body: string;
}

function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const pattern = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({ lang: match[1] ?? '', body: match[2] ?? '' });
  }
  return blocks;
}

function readSkill(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

interface DocumentedCommand {
  readonly file: string;
  readonly kind: 'app' | 'host';
  readonly argv: string[];
  readonly negative: boolean;
  readonly negativeKind: 'unknown_command' | 'confirmation_required' | 'listen_override' | null;
  readonly raw: string;
}

/** 引号感知地去掉行内注释：返回 [命令正文, 注释]。 */
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

function bind(token: string): string {
  let value = token;
  for (const [placeholder, replacement] of Object.entries(BINDINGS)) {
    value = value.split(placeholder).join(replacement);
  }
  return value;
}

function classifyNegative(comment: string): DocumentedCommand['negativeKind'] {
  if (comment.includes('未知命令')) return 'unknown_command';
  if (comment.includes('confirmation_required')) return 'confirmation_required';
  if (comment.includes('监听地址')) return 'listen_override';
  return null;
}

/** 提取全部 console/sh 代码块中的 shiploop CLI 示例行（含负例标注）。 */
function documentedCommands(): DocumentedCommand[] {
  const commands: DocumentedCommand[] = [];
  for (const file of SKILL_FILES) {
    const text = readSkill(file);
    for (const block of fencedBlocks(text)) {
      if (block.lang !== 'console' && block.lang !== 'sh') continue;
      for (const rawLine of block.body.split('\n')) {
        const { command, comment } = stripComment(rawLine.trim());
        if (command.length === 0) continue;
        const prefix = CLI_ENTRY_PREFIXES.find((entry) => command.startsWith(entry));
        if (prefix === undefined) continue;
        const negative = comment.includes('✗');
        const argv = command.slice(prefix.length).trim().split(/\s+/).map(bind);
        commands.push({
          file,
          kind: argv[0] === 'host' ? 'host' : 'app',
          argv,
          negative,
          negativeKind: negative ? classifyNegative(comment) : null,
          raw: command,
        });
      }
    }
  }
  return commands;
}

describe('F-006 Skill 交付形态：文档集合与 README 登记', () => {
  it('八份操作 Skill 存在且 README 文档导航逐项登记', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8');
    for (const skillPath of SKILL_FILES) {
      expect(readSkill(skillPath), `${skillPath} 必须存在`).toContain('# Skill');
      expect(readme, `README 必须登记 ${skillPath}`).toContain(skillPath);
    }
  });

  it('每份 Skill 覆盖前置条件、输入、命令、JSON 结果解释与权限提醒及退出码/数据根/--json 语义', () => {
    for (const skillPath of SKILL_FILES) {
      const text = readSkill(skillPath);
      for (const section of ['前置条件', '输入', '命令', 'JSON 结果解释', '权限提醒']) {
        expect(text, `${skillPath} 缺少「${section}」部分`).toContain(section);
      }
      for (const token of ['"ok"', '"error"', '退出码', '--json', '数据根', '--confirm']) {
        expect(text, `${skillPath} 须覆盖「${token}」`).toContain(token);
      }
    }
  });

  it('代码块只允许 console/sh/json；json 块必须可解析', () => {
    for (const skillPath of SKILL_FILES) {
      const blocks = fencedBlocks(readSkill(skillPath));
      expect(blocks.length, `${skillPath} 必须包含代码块`).toBeGreaterThanOrEqual(2);
      for (const block of blocks) {
        expect(block.lang, `${skillPath} 只允许 console/sh/json/text 代码块`).toMatch(/^(console|sh|json|text)$/);
        if (block.lang === 'json') {
          expect(() => JSON.parse(block.body), `${skillPath} 的 JSON 示例必须可解析`).not.toThrow();
        }
      }
    }
  });
});

describe('F-006 Skill 命令身份与 CLI 帮助/参数集合一致', () => {
  const commands = documentedCommands();

  it('提取到覆盖各 Skill 的示例命令（正例与负例都在场）', () => {
    expect(commands.length).toBeGreaterThanOrEqual(30);
    const files = new Set(commands.map((command) => command.file));
    for (const skillPath of SKILL_FILES) {
      expect(files, `${skillPath} 必须包含 CLI 示例`).toContain(skillPath);
    }
    expect(commands.some((command) => command.negative)).toBe(true);
  });

  it('正例全部被真实解析面接受：commandId 在命令面内且帮助文本有对应 usage', () => {
    for (const command of commands.filter((entry) => !entry.negative)) {
      expect(command.raw, command.raw).not.toMatch(/chat|electron|publish/);
      if (command.kind === 'host') {
        const parsed = parseHostCliArgs(command.argv, {});
        if (parsed.kind === 'help') {
          expect(getHostCliHelp(parsed.scope), command.raw).toContain('usage');
          continue;
        }
        expect(getHostCliHelp(parsed.command), command.raw).toContain('usage');
        continue;
      }
      const parsed = parseAppCliArgs(command.argv, {}, { cwd: TMP });
      expect(parsed.kind, `${command.raw} 必须是可执行命令`).toBe('command');
      if (parsed.kind !== 'command') continue;
      expect(
        (APP_CLI_COMMAND_IDS as readonly string[]).includes(parsed.commandId),
        `${command.raw} 的命令身份 ${parsed.commandId} 不在当前命令面`,
      ).toBe(true);
      const help = getAppCliHelp(parsed.commandId);
      expect(help, `${command.raw} 必须有帮助文本`).toContain('usage: shiploop');
      expect(
        help.includes(parsed.commandId.split('.')[0] as string),
        `${command.raw} 帮助文本须属同一命令族`,
      ).toBe(true);
    }
  });

  it('文档负例经真实解析面核对：未知命令/缺确认/监听覆盖都被本地拒绝', () => {
    const negatives = commands.filter((entry) => entry.negative);
    expect(negatives.length).toBeGreaterThanOrEqual(4);
    const reasons = new Set<string>();
    for (const command of negatives) {
      expect(command.negativeKind, `负例注释须写明拒绝语义：${command.raw}`).not.toBeNull();
      if (command.kind === 'host' || command.negativeKind === 'listen_override') {
        let thrown: unknown;
        try {
          parseHostCliArgs(command.argv, {});
        } catch (error) {
          thrown = error;
        }
        expect(thrown, command.raw).toBeInstanceOf(HostCliParseError);
        continue;
      }
      let thrown: unknown;
      try {
        parseAppCliArgs(command.argv, {}, { cwd: TMP });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `负例必须被解析层拒绝：${command.raw}`).toBeInstanceOf(AppCliParseError);
      expect((thrown as AppCliParseError).code, command.raw).toBe('invalid_input');
      expect((thrown as AppCliParseError).reason, command.raw).toBe(command.negativeKind === 'unknown_command'
        ? 'unknown_command'
        : 'confirmation_required');
      reasons.add((thrown as AppCliParseError).reason);
    }
    expect(reasons, '至少覆盖未知命令与缺确认两类负例').toEqual(new Set(['unknown_command', 'confirmation_required']));
  });
});

describe('F-006 Skill 流程语义（预览/批准、accepted/completed、观察、停止、备份）', () => {
  it('planning-approval：预览与显式批准分离；accepted 不等于完成；批准不启动编码', () => {
    const text = readSkill(SKILL_PLANNING);
    expect(text).toMatch(/预览与显式批准分离|预览与批准分离|只读预览.{0,40}显式批准/);
    expect(text).toMatch(/accepted 只表示|accepted 只是|accepted 不代表|accepted 与 completed 分离/);
    expect(text).toMatch(/不启动编码|不自动开始编码/);
    expect(text).toContain('candidateDigest');
    expect(text).toMatch(/conflict/);
    expect(text).toContain('manual');
  });

  it('execution-observe：观察中断不取消执行；查询只读零副作用；accepted 不折算完成', () => {
    const text = readSkill(SKILL_OBSERVE);
    expect(text).toContain('观察中断');
    expect(text).toMatch(/退出码 4|observation_interrupted/);
    expect(text).toMatch(/只结束本次观察/);
    expect(text).toMatch(/不取消|不停止 Host/);
    expect(text).toContain('previewDigest');
    expect(text).toContain('budget_exhausted');
  });

  it('stop-control：停止必须显式发起；pause 不中止在途 Attempt；stop_unconfirmed 不伪装成功', () => {
    const text = readSkill(SKILL_STOP);
    expect(text).toMatch(/停止必须显式|显式停止|唯一.{0,12}停止途径|唯一取消途径/);
    expect(text).toContain('stop_unconfirmed');
    expect(text).toMatch(/不伪装|不折算/);
    expect(text).toMatch(/不中止/);
    expect(text).toMatch(/不重置预算/);
  });

  it('backup-restore：恢复受权限与兼容性检查约束；fail-closed 不发布坏包', () => {
    const text = readSkill(SKILL_BACKUP);
    expect(text).toContain('backup_not_verified');
    expect(text).toContain('unsupported_version');
    expect(text).toContain('target_not_empty');
    expect(text).toMatch(/fail-closed|不发布包/);
    expect(text).toContain('restored_data_requires_current_facts');
    expect(text).toMatch(/隔离恢复根/);
    expect(text).toMatch(/不手工拷贝|禁止手工/);
  });

  it('troubleshooting：退出码总表与固定错误身份在场；回执 completed 才是成功', () => {
    const text = readSkill(SKILL_TROUBLESHOOT);
    expect(text).toContain('退出码总表');
    for (const token of ['0 成功', '1 业务拒绝', '2 输入错误', '3 连接', '4 观察中断']) {
      expect(text, `退出码总表须含「${token}」`).toContain(token);
    }
    for (const token of ['protocol_incompatible', 'preview_stale', 'budget_exhausted', 'host_not_found', 'stop_unconfirmed']) {
      expect(text, `排障须覆盖「${token}」`).toContain(token);
    }
    expect(text).toMatch(/completed 才是成功|status=completed/);
    expect(text).toMatch(/不解析易变日志|不从日志文字/);
  });
});

describe('F-006 Skill 权限边界（只经受控 CLI；不写库/不授权/不发布）', () => {
  const NEGATION_MARKER = /不|禁止|勿|拒绝|永不|不得|✗|never|not\b/i;

  /** 直接状态/资源/发布访问关键词：出现时所在行必须是否定/禁止语境。 */
  const RESTRICTED_TOKENS = [
    'task_list',
    'sqlite',
    '.sqlite',
    'core.sqlite',
    'npm publish',
    'chmod ',
    'sudo ',
    'curl ',
    'rm -rf',
    'eval ',
  ] as const;

  it('不直接修改 SQLite/task 元数据/权限文件/发布配置；npm publish 只允许否定语境', () => {
    for (const skillPath of SKILL_FILES) {
      const text = readSkill(skillPath);
      for (const [index, line] of text.split('\n').entries()) {
        for (const token of RESTRICTED_TOKENS) {
          if (line.toLowerCase().includes(token.toLowerCase())) {
            expect(
              NEGATION_MARKER.test(line),
              `${skillPath}:${index + 1} 只能在否定/禁止语境提到「${token}」：${line}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('npm 安装/构建只属于安装 Skill；其余 Skill 不得包含 npm install/run', () => {
    for (const skillPath of SKILL_FILES) {
      const text = readSkill(skillPath);
      for (const [index, line] of text.split('\n').entries()) {
        const lower = line.toLowerCase();
        if (!(lower.includes('npm install') || lower.includes('npm run') || lower.includes('npm ci'))) continue;
        if (skillPath === SKILL_HOST_LIFECYCLE) {
          expect(index, 'npm 行属于 host-lifecycle Skill 的安装流程').toBeGreaterThanOrEqual(0);
          continue;
        }
        expect(
          NEGATION_MARKER.test(line),
          `${skillPath}:${index + 1} 只有安装 Skill 可以包含 npm 安装/构建，且须为否定语境：${line}`,
        ).toBe(true);
      }
    }
  });

  it('不请求真实模型、不含凭据与本机固定路径、不得出现通用自动同意选项', () => {
    const AUTO_APPROVE_PATTERN =
      /(?:^|\s)(--yes\b|-y\b|--assume-yes\b|--auto-approve\b|--auto-confirm\b|--always\b|--force\b|--no-confirm\b|--skip-confirmation\b)/;
    const PERSONAL_PATH_PATTERNS = [/\/Users\/[A-Za-z0-9._-]+/, /\/home\/[A-Za-z0-9._-]+\//, /C:\\Users\\/];
    const CREDENTIAL_PATTERNS = [
      /sk-[A-Za-z0-9]{16,}/,
      /gh[pous]_[A-Za-z0-9]{16,}/,
      /Bearer\s+[A-Za-z0-9._-]{8,}/,
      /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*\S+/i,
    ];
    const MODEL_INVOCATION_TOKENS = ['openai', 'anthropic', 'claude', 'gpt-', 'gemini', 'ollama', 'viking://', 'ov find'];
    for (const skillPath of SKILL_FILES) {
      const text = readSkill(skillPath);
      const lower = text.toLowerCase();
      for (const token of MODEL_INVOCATION_TOKENS) {
        expect(lower, `${skillPath} 不得包含模型调用面「${token}」`).not.toContain(token);
      }
      for (const pattern of [...PERSONAL_PATH_PATTERNS, ...CREDENTIAL_PATTERNS]) {
        expect(pattern.test(text), `${skillPath} 命中禁用形态 ${pattern}`).toBe(false);
      }
      for (const line of text.split('\n')) {
        expect(AUTO_APPROVE_PATTERN.test(line), `${skillPath} 不得包含自动同意选项：${line}`).toBe(false);
      }
      expect(text, `${skillPath} 须声明不请求/不调用真实模型`).toMatch(/不(请求|调用|自动调用)(真实)?模型/);
      expect(text, `${skillPath} 须声明模型输出不能替代用户确认`).toContain('模型输出不能替代用户确认');
    }
  });

  it('后置与未支持能力如实标注：Chat/Electron/公开发布/其他 Runtime/非 macOS 平台不冒充可用', () => {
    const combined = SKILL_FILES.map((path) => readSkill(path)).join('\n');
    for (const token of ['Chat', 'Electron', 'npm publish', '后置', '未支持', 'not_run']) {
      expect(combined, `Skill 集合须标注「${token}」边界`).toContain(token);
    }
    expect(combined).toMatch(/P08-2/);
    expect(combined).toMatch(/P08-3/);
    expect(combined).toMatch(/P08-4/);
  });
});
