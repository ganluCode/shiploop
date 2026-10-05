/**
 * F-001 文档核验：`docs/p02-1-host-lifecycle-contract.md` 记录的 P01 放行基线与
 * P02-1 生命周期协议必须与仓库事实一致，避免「文档另立一套」与后续 F-002 ~ F-014
 * 各自发明协议。
 *
 * 定位：F-001 只交付基线核对与契约文档（+ 本守护）；Host/CLI 的真实实现由后续任务
 * 增量完成。本套件不新增业务实现，不扩大 P02-1 交付范围。后续任务改变 §1.5 记录的
 * 基线事实时（例如 F-006 把 Host 骨架换成真实入口），必须同步更新本守护与契约文档。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p02-1-host-lifecycle-contract.md';
const contractDoc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf-8');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8'));
}

function readText(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
}

/** 文档必须逐字记录的冻结事实（值变更必须走契约修订，不能静默漂移）。 */
const FROZEN_BASELINE_FACTS = [
  // 开工 HEAD、负责人放行基线、P01 受测产品 commit（完整 hash）。
  '24dcb7da41f2cb080c6b01c94a4cb24bddb8e4d3',
  '5a43a042b98bf2317db7501547def93a4f08f2fa',
  '0e96535cb2384f0b53911a154aedf477a04b52b7',
  // 工具版本。
  '22.19.0',
  '10.9.3',
  // 数据根身份算法。
  'dataRootIdentity = lower_hex(sha256(utf8Bytes(canonicalRoot)))',
  // 受保护文件布局。
  'host/discovery.json',
  'host/auth.token',
  'host/writer.lock',
  // 固定回环与体积预算。
  '127.0.0.1',
  '16 384',
] as const;

/** 生命周期协议三路由（方法 + 路径必须同时出现）。 */
const FROZEN_ROUTES = [
  'POST /v1/host/handshake',
  'GET /v1/host/status',
  'POST /v1/host/stop',
] as const;

/** 后续任务共用的关键契约概念，缺失即表示协议未被完整记录。 */
const FROZEN_CONCEPT_TERMS = [
  'schemaVersion',
  'protocolVersion',
  'hostInstanceId',
  'dataRootIdentity',
  'requestDigest',
  'commandId',
  'timingSafeEqual',
  'owner_active',
  'owner_unknown',
  'idle-only',
  'unsupported_platform',
  'bind_address_override_rejected',
  'stop_not_confirmed',
  'quiesce_not_confirmed',
  // CLI 四档退出码语义。
  '退出码',
  // 幂等矩阵关键分支。
  '同 commandId 不同摘要',
] as const;

/** 非目标必须显式写出，防止后续任务用占位冒充能力。 */
const NON_GOAL_TERMS = [
  '项目注册 / 配置 / 基线',
  'SSE',
  'Scheduler',
  'Runner',
  'Pi SDK',
  'command_receipts',
  '跨平台',
] as const;

describe('F-001 P02-1 Host 生命周期契约文档', () => {
  it('存在且为非空 Markdown', () => {
    expect(contractDoc.startsWith('# P02-1')).toBe(true);
    expect(contractDoc).toContain('F-001');
  });

  it.each(FROZEN_BASELINE_FACTS)('记录冻结基线事实：%s', (fact) => {
    expect(contractDoc).toContain(fact);
  });

  it.each(FROZEN_ROUTES)('冻结生命周期路由：%s', (route) => {
    expect(contractDoc).toContain(route);
  });

  it.each(FROZEN_CONCEPT_TERMS)('记录协议关键概念：%s', (term) => {
    expect(contractDoc).toContain(term);
  });

  it.each(NON_GOAL_TERMS)('明确写出非目标：%s', (term) => {
    expect(contractDoc).toContain(term);
  });

  it('记录 P01 负责人阶段放行依据（不代签、不自动合并）', () => {
    for (const fact of ['负责人阶段放行', 'ganlu', 'p01帮我修改一下，放行', '2026-10-05']) {
      expect(contractDoc).toContain(fact);
    }
    // 诚实记录：逐项清单空白仍为模板，阶段放行不冒充逐项验收。
    expect(contractDoc).toContain('原始审阅模板空白');
  });

  it('记录 T26 编号不一致并按行为给出映射与核对请求', () => {
    expect(contractDoc).toContain('T26命令幂等');
    expect(contractDoc).toContain('当前配置 CAS 冲突');
    expect(contractDoc).toContain('请求核对');
    // 只认领 stop 幂等子集，不扩建项目命令回执体系。
    expect(contractDoc).toContain('同一实例 stop 的进程内版本化');
  });

  it('不把开发机绝对路径或 Bearer 凭据样例写进运行文档', () => {
    expect(contractDoc).not.toMatch(/\/Users\//);
    // 允许 64 位全零占位身份（§5.1 示例），但不允许 Bearer 后携带任何疑似 token。
    expect(contractDoc).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
  });
});

describe('F-001 契约文档与仓库基线一致', () => {
  it('根清单脚本与版本与文档记录一致，且没有提前冒用 accept:p02', () => {
    const root = readJson('package.json');
    expect(root.engines).toEqual({ node: '22.19.0', npm: '10.9.3' });
    expect(root.packageManager).toBe('npm@10.9.3');
    expect(Object.keys(root.scripts as Record<string, string>).sort()).toEqual(
      ['accept:p01', 'build', 'check:boundaries', 'test', 'typecheck', 'verify'].sort(),
    );
    expect(root.scripts).not.toHaveProperty('accept:p02');
  });

  it('P02-1 开工基线：CLI 公共入口仍是无副作用骨架（文档 §1.5 事实）', () => {
    const source = readText('packages/cli/src/index.ts');
    expect(source).toContain('export {}');
    // 骨架阶段没有任何 import 语句（注释中可描述不做的事，代码行不允许引用基础设施）。
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//'));
    expect(codeLines.some((line) => line.startsWith('import'))).toBe(false);
    expect(source).not.toMatch(/node:(http|https|net|dgram|child_process)/);
  });

  it('F-002~F-008 增量事实：Host 导出契约/存储/锁/启动装配/认证传输面与停止控制器', () => {
    // F-002 把 host 入口从 `export {}` 骨架换成契约公共面；F-003 追加存储面；
    // F-004 追加直接 fd 锁；F-006 追加 runtime 启动装配与显式入口 start.ts
    // （docs §1.5 各增量记录）。F-007 以真实生命周期传输面替换 F-006 的 404
    // 占位监听器（握手/status 认证路由生效）；F-008 以停止控制器接线 stop
    // （§10.4 幂等矩阵、§10.5 收尾、§10.7 信号收尾）；公共入口加载仍不得有副作用。
    const hostIndex = readText('packages/host/src/index.ts');
    expect(hostIndex).toContain("from './contract/index.js'");
    expect(hostIndex).toContain("from './storage/index.js'");
    expect(hostIndex).toContain("from './locking/index.js'");
    expect(hostIndex).toContain("from './runtime/index.js'");
    expect(contractDoc).toContain('F-004 增量');
    expect(contractDoc).toContain('F-006 增量');
    expect(contractDoc).toContain('F-007 增量');
    expect(contractDoc).toContain('F-008 增量');
    expect(contractDoc).toContain('createHostStopController');
    expect(contractDoc).toContain('wireHostSignalShutdown');
    expect(contractDoc).toContain('flock(LOCK_EX | LOCK_NB)');
    expect(readText('docs/p02-1-writer-lock.md')).toContain('实际写入进程直接持 fd');
    expect((readJson('package.json').scripts as Record<string, string>).build).toContain('build-host-lock.ts');
    expect(hostIndex).not.toContain('export {}');

    // F-006 显式启动入口存在（契约 §13.1），且只经 runtime 公共面启动。
    const startEntry = readText('packages/host/src/start.ts');
    expect(startEntry).toContain('runHostStartEntry');

    // F-006（契约 §13.4）：host 包声明且仅声明工作区依赖 shiploop-core；
    // storage/ 面仍不得依赖 shiploop-core（默认根由调用方预推导）。
    const hostPkg = readJson('packages/host/package.json');
    expect(hostPkg.dependencies).toEqual({ 'shiploop-core': '0.0.0' });

    // 契约面源码只允许相对导入与 node:crypto（确定性哈希），不允许网络/文件/进程/ORM/SDK。
    const contractDir = resolve(REPO_ROOT, 'packages/host/src/contract');
    const listTs = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          return listTs(child);
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [child] : [];
      });
    expect(statSync(contractDir).isDirectory()).toBe(true);
    expect(listTs(contractDir).length).toBeGreaterThanOrEqual(8);
    for (const file of listTs(contractDir)) {
      const source2 = readText(file);
      // 只匹配真实 import 语句，注释中描述「不导入 node:http」不误伤。
      expect(source2, file).not.toMatch(
        /\b(?:import|export)[^;]*?\bfrom\s+['"]node:(?:fs|os|net|http|https|dgram|child_process|cluster|worker_threads)['"]|\bimport\s+['"]node:(?:fs|os|net|http|https|dgram|child_process|cluster|worker_threads)['"]/,
      );
      expect(source2, file).not.toMatch(
        /from\s+['"](?:better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono)['"]/,
      );
    }

    // F-003 存储面允许 node:fs/crypto/path，但仍禁止网络/进程/ORM/SDK，
    // 也不得依赖 shiploop-core（默认根由调用方预推导，见 §13.4）。
    const storageDir = resolve(REPO_ROOT, 'packages/host/src/storage');
    expect(statSync(storageDir).isDirectory()).toBe(true);
    expect(listTs(storageDir).length).toBeGreaterThanOrEqual(3);
    for (const file of listTs(storageDir)) {
      const source2 = readText(file);
      expect(source2, file).not.toMatch(
        /\b(?:import|export)[^;]*?\bfrom\s+['"]node:(?:net|http|https|dgram|child_process|cluster|worker_threads)['"]|\bimport\s+['"]node:(?:net|http|https|dgram|child_process|cluster|worker_threads)['"]/,
      );
      expect(source2, file).not.toMatch(
        /from\s+['"](?:shiploop-core|better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono)['"]/,
      );
    }

    // F-006 runtime 面允许 node:http 与 shiploop-core 公共入口（含 ./assembly），
    // 但禁止其他网络/进程/线程内置模块与 ORM/厂商 SDK 直接绑定。
    const runtimeDir = resolve(REPO_ROOT, 'packages/host/src/runtime');
    expect(statSync(runtimeDir).isDirectory()).toBe(true);
    expect(listTs(runtimeDir).length).toBeGreaterThanOrEqual(3);
    for (const file of listTs(runtimeDir)) {
      const source2 = readText(file);
      expect(source2, file).not.toMatch(
        /\b(?:import|export)[^;]*?\bfrom\s+['"]node:(?:net|https|dgram|tls|child_process|cluster|worker_threads)['"]|\bimport\s+['"]node:(?:net|https|dgram|tls|child_process|cluster|worker_threads)['"]/,
      );
      expect(source2, file).not.toMatch(
        /from\s+['"](?:better-sqlite3|drizzle-orm|@earendil-works\/pi-coding-agent|electron|express|fastify|koa|hono)['"]/,
      );
      // argv 只属于显式入口 start.ts；剔除注释后 runtime 模块不得直接读 process.argv。
      const codeOnly = source2
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^\s*\/\/.*$/gm, '');
      expect(codeOnly, file).not.toContain('process.argv');
    }
  });

  it('shiploop-core 的两个公共入口与文档记录一致', () => {
    const corePkg = readJson('packages/core/package.json');
    const exportsMap = corePkg.exports as Record<string, { default: string }>;
    expect(exportsMap['.'].default).toBe('./dist/index.js');
    expect(exportsMap['./assembly'].default).toBe('./dist/adapters/composition.js');
    expect(readText('packages/core/src/adapters/composition.ts')).toContain(
      'export async function openCoreApplication',
    );
  });

  it('P01 放行记录文档实际存在且含负责人放线段落', () => {
    const results = readText('docs/acceptance/p01-review-results.md');
    const checklist = readText('docs/acceptance/p01-review-checklist.md');
    expect(results).toContain('人工放行记录（2026-10-05）');
    expect(results).toContain('5a43a04');
    expect(checklist).toContain('负责人阶段放行（2026-10-05）');
  });
});
