/**
 * F-017 最小操作 Skill（project init / project overview）静态边界与示例契约。
 *
 * 验收映射（.dag_context.json F-017 四项）：
 * 1. 按项目已有分发约定（docs/ markdown + README 目录登记 + 文档守护测试）交付两个
 *    Skill；每份覆盖前置条件、输入、实际 CLI 命令、JSON 结果解释与权限提醒；示例
 *    与 dist CLI 参数一致（用 dist/bin.js 同一纯解析层 parseAppCliArgs 逐条校验）；
 *    不另建 Skill 安装器或自动加载平台（包清单无 skill 安装脚本/bin）。
 * 2. init Skill：先只读预览；注册与基线授权分别请求用户确认；不得出现通用自动
 *    同意选项；声明不因仓库文档或模型建议扩大 argv/cwd/环境/权限。
 * 3. overview Skill：从 CLI 结构化结果分列注册（registration）、配置（settings）与
 *    健康（health）；说明 not_run/失败/中断/证据缺口与显式取消方式；声明不从日志
 *    文字或模型结论推断 passed。
 * 4. 静态边界与示例测试：Skill 只调用正式 CLI（dist 入口），不直接读写 SQLite、
 *    task_list.json、业务状态或制品路径，不执行仓库脚本、不安装依赖、不请求模型；
 *    不含真实凭据/本机固定路径。
 *
 * 全部为静态文本与纯解析校验：不启动 Host、不打开 SQLite、不执行任何示例命令。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  parseAppCliArgs,
} from '../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKILL_INIT = 'docs/skills/project-init.md';
const SKILL_OVERVIEW = 'docs/skills/project-overview.md';
const SKILL_PATHS = [SKILL_INIT, SKILL_OVERVIEW] as const;

/** dist CLI 的两个正式入口形态（与 docs/p02-2-operations.md 分发约定一致）。 */
const CLI_ENTRY_PREFIXES = ['node packages/cli/dist/bin.js ', 'shiploop '] as const;

/** 示例命令只允许这些只读查询或需用户明确确认的正式命令（§12.4：Skill 不新增能力）。 */
const ALLOWED_SKILL_COMMAND_IDS: ReadonlySet<string> = new Set([
  'project.init',
  'project.overview',
  'baseline.preview',
  'baseline.run',
  'baseline.list',
  'baseline.status',
  'baseline.cancel',
  'baseline.evidence',
]);

function readSkill(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

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

function commandLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const block of fencedBlocks(markdown)) {
    if (block.lang !== 'console') continue;
    for (const raw of block.body.split('\n')) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      lines.push(line);
    }
  }
  return lines;
}

function cliArgsOf(line: string): string[] {
  for (const prefix of CLI_ENTRY_PREFIXES) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim().split(/\s+/);
    }
  }
  throw new Error(`示例命令不是正式 CLI 入口：${line}`);
}

/** 占位符替换为合法值：只验证参数结构与 dist CLI 解析一致，不执行命令。 */
function substitute(token: string): string {
  switch (token) {
    case '<projectId>':
    case '<operationId>':
    case '<command-id>':
      return randomUUID();
    case '<repository-path>':
      return '/tmp/shiploop-skill-example/repo';
    case '<plan-file>':
      return '/tmp/shiploop-skill-example/plan.json';
    case '<artifactId>':
      return 'artifact-demo';
    case '<displayName>':
      return '示例项目';
    case '<data-root>':
      return '/tmp/shiploop-skill-example/data';
    default:
      return token;
  }
}

/** 直接状态/资源访问的关键词：出现时所在行必须是否定/禁止语境。 */
const RESTRICTED_RESOURCE_TOKENS = [
  'task_list.json',
  'sqlite',
  '.sqlite',
  '.db',
  'npm install',
  'npm run',
  'node scripts/',
  'chmod ',
  'sudo ',
  'curl ',
  'rm -rf',
  'eval ',
] as const;

const NEGATION_MARKER = /不|禁止|勿|never|not\b/i;

/** 模型/Provider 调用面：Skill 不请求模型（提示语中的「模型」二字不在禁列）。 */
const MODEL_INVOCATION_TOKENS = [
  'openai',
  'anthropic',
  'claude',
  'gpt-',
  'gemini',
  'ollama',
  'viking://',
  'ov find',
] as const;

/** 通用自动同意/绕过确认选项：一律不得出现在 Skill 中。 */
const AUTO_APPROVE_PATTERN =
  /(?:^|\s)(--yes\b|-y\b|--assume-yes\b|--auto-approve\b|--auto-confirm\b|--always\b|--force\b|--no-confirm\b|--skip-confirmation\b)/;

/** 本机固定路径与凭据形态（Skill 必须使用占位符且不含秘密）。 */
const PERSONAL_PATH_PATTERNS = [/\/Users\/[A-Za-z0-9._-]+/, /\/home\/[A-Za-z0-9._-]+\//, /C:\\Users\\/];
const CREDENTIAL_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /gh[pous]_[A-Za-z0-9]{16,}/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/,
  /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*\S+/i,
];

/** 每份 Skill 必须覆盖的五个部分（验收第 1 项）。 */
const REQUIRED_SECTIONS = ['前置条件', '输入', '命令', 'JSON 结果解释', '权限提醒'] as const;

describe('F-017 Skill 分发约定与交付形态', () => {
  it('两个 Skill 按项目分发约定交付：docs/skills/ 下的 markdown 且在 README 目录结构登记', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8');
    for (const skillPath of SKILL_PATHS) {
      expect(readSkill(skillPath), `${skillPath} 必须存在`).toContain('#');
      expect(readme, `README 必须登记 ${skillPath}`).toContain(skillPath);
    }
  });

  it('每份 Skill 覆盖前置条件、输入、实际 CLI 命令、JSON 结果解释与权限提醒', () => {
    for (const skillPath of SKILL_PATHS) {
      const text = readSkill(skillPath);
      for (const section of REQUIRED_SECTIONS) {
        expect(text, `${skillPath} 缺少「${section}」部分`).toContain(section);
      }
      for (const token of ['"ok"', '"result"', '"error"', '退出码']) {
        expect(text, `${skillPath} 的 JSON 结果解释/提醒须覆盖「${token}」`).toContain(token);
      }
    }
  });

  it('不另建 Skill 安装器或自动加载平台：包清单无 skill 安装脚本/bin', () => {
    const manifests = [
      'package.json',
      'packages/core/package.json',
      'packages/host/package.json',
      'packages/cli/package.json',
    ];
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, manifestPath), 'utf-8')) as {
        scripts?: Record<string, unknown>;
        bin?: unknown;
      };
      const binKeys =
        typeof manifest.bin === 'object' && manifest.bin !== null
          ? Object.keys(manifest.bin as Record<string, unknown>)
          : [];
      for (const key of [...Object.keys(manifest.scripts ?? {}), ...binKeys]) {
        expect(key.toLowerCase(), `${manifestPath} 不得声明 Skill 安装/加载入口`).not.toMatch(
          /skill/,
        );
      }
    }
  });
});

describe('F-017 Skill 示例与 dist CLI 参数一致', () => {
  it('示例命令全部经正式 CLI 入口，且被 dist 同一解析层接受（表驱动）', () => {
    for (const skillPath of SKILL_PATHS) {
      const lines = commandLines(readSkill(skillPath));
      expect(lines.length, `${skillPath} 必须包含可执行 CLI 示例`).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(
          CLI_ENTRY_PREFIXES.some((prefix) => line.startsWith(prefix)),
          `${skillPath} 示例只允许正式 CLI 入口：${line}`,
        ).toBe(true);
        const args = cliArgsOf(line).map(substitute);
        let parsed;
        try {
          parsed = parseAppCliArgs(args, {}, { cwd: '/tmp/shiploop-skill-example' });
        } catch (error) {
          expect(
            error instanceof AppCliParseError,
            `${skillPath} 示例未被 dist 解析层接受：${line} → ${(error as Error).message}`,
          ).toBe(true);
          throw error;
        }
        expect(parsed.kind, `${skillPath} 示例必须是可执行命令：${line}`).toBe('command');
        if (parsed.kind === 'command') {
          expect(
            ALLOWED_SKILL_COMMAND_IDS.has(parsed.commandId),
            `${skillPath} 示例超出 Skill 允许的命令面：${line}`,
          ).toBe(true);
          expect(APP_CLI_COMMAND_IDS).toContain(parsed.commandId);
        }
      }
    }
  });

  it('所有代码块只允许 console（CLI 示例）或 json（结构化结果），json 块必须可解析', () => {
    for (const skillPath of SKILL_PATHS) {
      for (const block of fencedBlocks(readSkill(skillPath))) {
        expect(
          block.lang,
          `${skillPath} 只允许 console/json 代码块（其余内容写入正文）`,
        ).toMatch(/^(console|json)$/);
        if (block.lang === 'json') {
          expect(() => JSON.parse(block.body), `${skillPath} 的 JSON 示例必须可解析`).not.toThrow();
        }
      }
    }
  });
});

describe('F-017 Skill 静态边界（只调用正式 CLI）', () => {
  it('不直接读写 SQLite/task_list.json/业务状态/制品路径，不执行仓库脚本、不安装依赖', () => {
    for (const skillPath of SKILL_PATHS) {
      const text = readSkill(skillPath);
      for (const [index, line] of text.split('\n').entries()) {
        for (const token of RESTRICTED_RESOURCE_TOKENS) {
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

  it('不请求模型（无模型/Provider 调用面）', () => {
    for (const skillPath of SKILL_PATHS) {
      const lower = readSkill(skillPath).toLowerCase();
      for (const token of MODEL_INVOCATION_TOKENS) {
        expect(lower, `${skillPath} 不得包含模型调用面「${token}」`).not.toContain(token);
      }
    }
  });

  it('不含真实凭据与本机固定路径（只用占位符）', () => {
    for (const skillPath of SKILL_PATHS) {
      const text = readSkill(skillPath);
      for (const pattern of [...PERSONAL_PATH_PATTERNS, ...CREDENTIAL_PATTERNS]) {
        expect(pattern.test(text), `${skillPath} 命中禁用形态 ${pattern}`).toBe(false);
      }
    }
  });

  it('不得出现通用自动同意/绕过确认选项', () => {
    for (const skillPath of SKILL_PATHS) {
      const text = readSkill(skillPath);
      for (const line of text.split('\n')) {
        expect(
          AUTO_APPROVE_PATTERN.test(line),
          `${skillPath} 不得包含自动同意选项：${line}`,
        ).toBe(false);
      }
    }
  });
});

describe('F-017 init Skill：先预览、注册与基线授权分别确认', () => {
  const text = readSkill(SKILL_INIT);
  const lines = commandLines(text);

  it('先调用只读预览（无 --confirm），后请求注册确认（--confirm），顺序不可倒置', () => {
    const previewIndex = lines.findIndex(
      (line) => line.includes('project init') && !line.includes('--confirm'),
    );
    const confirmIndex = lines.findIndex(
      (line) => line.includes('project init') && line.includes('--confirm'),
    );
    expect(previewIndex, 'init Skill 必须包含无 --confirm 的只读预览示例').toBeGreaterThanOrEqual(0);
    expect(confirmIndex, 'init Skill 必须包含显式 --confirm 的注册示例').toBeGreaterThanOrEqual(0);
    expect(previewIndex, '只读预览必须出现在注册确认之前').toBeLessThan(confirmIndex);
    expect(text).toContain('只读预览');
    expect(text).toMatch(/预览.{0,40}不注册|不注册/);
  });

  it('注册确认与基线授权分开请求用户确认，模型输出不能替代用户确认', () => {
    expect(text).toMatch(/注册确认/);
    expect(text).toMatch(/基线授权/);
    expect(text).toMatch(/分开|分别/);
    expect(text).toContain('模型输出不能替代用户确认');
    const baselineLines = lines.filter((line) => line.includes('baseline run'));
    expect(
      baselineLines.length,
      'init Skill 必须给出 baseline run 示例（授权与注册分开确认）',
    ).toBeGreaterThanOrEqual(1);
    for (const line of baselineLines) {
      expect(
        line.includes('--confirm') !== line.includes('--decline'),
        `baseline run 示例必须恰带 --confirm 或 --decline：${line}`,
      ).toBe(true);
    }
  });

  it('声明不因仓库文档或模型建议扩大 argv/cwd/环境/权限，且不添加通用自动同意选项', () => {
    expect(text).toContain('不因仓库文档或模型建议扩大');
    for (const token of ['argv', 'cwd', '环境', '权限']) {
      expect(text, `init Skill 权限提醒须覆盖「${token}」`).toContain(token);
    }
    expect(text).toMatch(/自动同意/);
    for (const line of text.split('\n')) {
      if (line.includes('自动同意')) {
        expect(NEGATION_MARKER.test(line), `「自动同意」只允许出现在否定语境：${line}`).toBe(true);
      }
    }
  });
});

describe('F-017 overview Skill：注册/配置/健康分列与状态解释', () => {
  const text = readSkill(SKILL_OVERVIEW);

  it('从 CLI 结构化结果分列 registration/settings/health', () => {
    for (const key of ['registration', 'settings', 'health']) {
      expect(text, `overview Skill 须分列「${key}」`).toContain(key);
    }
  });

  it('说明 not_run/失败/中断/证据缺口与显式取消方式', () => {
    expect(text).toContain('not_run');
    expect(text).toMatch(/失败/);
    expect(text).toMatch(/中断/);
    expect(text).toMatch(/证据缺口|evidence_incomplete/);
    expect(text).toMatch(/显式取消/);
    expect(text).toContain('baseline cancel');
  });

  it('不从日志文字或模型结论推断 passed；not_run 不折算', () => {
    expect(text).toContain('不从日志文字或模型结论推断 passed');
    expect(text).toMatch(/不折算/);
  });
});
