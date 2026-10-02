/**
 * F-004 工作区与 Core 分层依赖检查（fail-closed 工程检查脚本，非 ShipLoop 业务 Verifier）。
 *
 * 职责（只读静态分析：不执行受检代码、不联网、不写文件）：
 * 1. 依据根 package.json 的 workspaces 与各包清单，扫描各包 src 下的生产 TypeScript
 *    源码（明确排除 node_modules/dist 与 *.d.ts；test/fixtures、scripts 等目录不在
 *    扫描范围内，故意违规的测试夹具不会被误当生产源码）；
 * 2. 提取静态 import/export from（含 type-only）、副作用 import、字面量 dynamic
 *    import 与字面量 require 的模块说明符；非字面量 import()/require() 一律报错；
 *    注释与字符串字面量中的“导入”文本不会触发误判；
 * 3. 强制单向依赖：仅允许 Host→Core 公共入口、CLI→Host 公共客户端/契约（清单依赖
 *    与源码导入同时检查）；Core 不反向依赖，CLI 不绕过 Host 直连 Core，禁止自包名
 *    引用、跨包子路径（内部文件）导入、相对路径或已声明路径别名（package.json
 *    imports / tsconfig paths）逃逸出本包 src；无法解析的生产导入明确报错，不默认
 *    为合法；并检测工作区包之间的循环依赖；
 * 4. 强制 Core 分层：domain 只可导入 domain；ports 可导入 domain；application 可
 *    导入 domain/ports；adapters 可导入 domain/application/ports；公共入口与契约区
 *    （domain/application/ports）禁止导入 adapters 实现，禁止导入或重导出 Pi SDK、
 *    Electron、HTTP 框架、better-sqlite3、Drizzle 及 node:http(s)/net/dgram；
 *    adapters 层的合法引用（ports/domain 类型、已声明的第三方依赖、Node 内置模块）
 *    不被误拒；
 * 5. 任何违规或解析错误都使退出码为 1，诊断包含违规文件（含行号）与目标模块。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建；
 * 同时导出 runBoundaryCheck，供回归测试在临时夹具树上 in-process 调用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DiagnosticSeverity = 'violation' | 'error';

export type BoundaryDiagnostic = {
  /** violation＝违反既定边界规则；error＝无法完成确定性解析（同样 fail-closed）。 */
  severity: DiagnosticSeverity;
  rule: string;
  /** 相对受检根目录的违规文件路径；工作区级诊断（如循环依赖）为空字符串。 */
  file: string;
  /** 1-based 行号；清单级诊断为 0。 */
  line: number;
  /** 目标模块说明符或包名。 */
  specifier: string;
  detail: string;
};

export type PackageScope = {
  packageName: string;
  packageDir: string;
  srcDir: string;
  files: string[];
};

export type BoundaryCheckResult = {
  root: string;
  scope: PackageScope[];
  diagnostics: BoundaryDiagnostic[];
  ok: boolean;
};

type PackageRole = 'core' | 'host' | 'cli' | 'unknown';

type WorkspacePackage = {
  name: string;
  role: PackageRole;
  dir: string;
  srcDir: string;
  manifest: Record<string, unknown>;
  declaredDependencies: Set<string>;
  importsMap: Record<string, unknown>;
  tsconfigPaths: Record<string, string[]>;
  tsconfigBaseDir: string;
};

type ExtractedImport = {
  kind: 'static' | 'export' | 'side-effect' | 'dynamic' | 'require';
  specifier: string;
  line: number;
};

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Core 契约区（domain/application/ports/公共入口）禁止绑定的厂商与基础设施模块。 */
const BANNED_CONTRACT_VENDORS = [
  '@earendil-works/pi-coding-agent',
  'electron',
  'better-sqlite3',
  'drizzle-orm',
  'express',
  'fastify',
  'koa',
  'hono',
] as const;
const BANNED_CONTRACT_BUILTINS = new Set(['http', 'https', 'net', 'dgram']);

/** Core 层内允许的目标层（含自身层）。root＝src 顶层文件（公共入口及同层文件）。 */
const CORE_LAYER_TARGETS: Record<string, readonly string[]> = {
  domain: ['domain'],
  ports: ['ports', 'domain'],
  application: ['application', 'ports', 'domain'],
  adapters: ['adapters', 'application', 'ports', 'domain'],
  root: ['root', 'application', 'ports', 'domain'],
};

function roleOf(name: string): PackageRole {
  if (/(^|-)core$/.test(name)) {
    return 'core';
  }
  if (/(^|-)host$/.test(name)) {
    return 'host';
  }
  if (/(^|-)cli$/.test(name)) {
    return 'cli';
  }
  return 'unknown';
}

/** 单向依赖：Host 可依赖 Core 公共入口；CLI 只在需要时依赖 Host 公共客户端或契约。 */
function isAllowedWorkspaceEdge(from: PackageRole, to: PackageRole): boolean {
  return (from === 'host' && to === 'core') || (from === 'cli' && to === 'host');
}

function isInside(candidate: string, directory: string): boolean {
  const base = resolve(directory);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}

function isBannedVendor(specifier: string): boolean {
  return BANNED_CONTRACT_VENDORS.some(
    (vendor) => specifier === vendor || specifier.startsWith(`${vendor}/`),
  );
}

function bannedBuiltinBase(specifier: string): string | null {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const base = name.split('/')[0] ?? '';
  return BANNED_CONTRACT_BUILTINS.has(base) ? base : null;
}

/**
 * 剔除注释并记录字符串字面量区间（保持长度与行号不变）。
 * 模板字符串整体按字符串处理（含 ${}），属于有意的近似：生产源码不在模板里藏导入。
 */
function scanSource(code: string): {
  stripped: string;
  stringRanges: Array<readonly [number, number]>;
} {
  const chars = [...code];
  const ranges: Array<readonly [number, number]> = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (char === '/' && next === '/') {
      let end = index;
      while (end < code.length && code[end] !== '\n') {
        chars[end] = ' ';
        end += 1;
      }
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      let end = index;
      while (end < code.length && !(code[end] === '*' && code[end + 1] === '/')) {
        if (code[end] !== '\n') {
          chars[end] = ' ';
        }
        end += 1;
      }
      if (end < code.length) {
        chars[end] = ' ';
        chars[end + 1] = ' ';
        end += 2;
      }
      index = end;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < code.length) {
        const inner = code[index];
        if (inner === '\\') {
          index += 2;
          continue;
        }
        if (inner === quote) {
          index += 1;
          break;
        }
        if (quote !== '`' && inner === '\n') {
          break;
        }
        index += 1;
      }
      ranges.push([start, index]);
      continue;
    }
    index += 1;
  }
  return { stripped: chars.join(''), stringRanges: ranges };
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (code[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

function isInsideRanges(index: number, ranges: Array<readonly [number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

const SPECIFIER_PATTERNS: Array<{ kind: ExtractedImport['kind']; regex: RegExp }> = [
  // 静态 import（含 import type）……from 'x'；[^;'"=] 防止跨语句或跨越说明符引号。
  { kind: 'static', regex: /\bimport\s+(?:type\s+)?[^;'"=]*?\bfrom\s*(['"])([^'"]+)\1/g },
  // export … from 'x'（含 export type、export *、export * as ns）。
  {
    kind: 'export',
    regex: /\bexport\s+(?:type\s+)?(?:\*\s+as\s+[\w$]+|\*|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/g,
  },
  // 副作用 import 'x'。
  { kind: 'side-effect', regex: /\bimport\s+(['"])([^'"]+)\1/g },
  // 字面量 dynamic import('x')。
  { kind: 'dynamic', regex: /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g },
  // 字面量 require('x')。
  { kind: 'require', regex: /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g },
];

function extractImports(code: string): {
  imports: ExtractedImport[];
  nonLiteral: Array<{ kind: string; line: number }>;
} {
  const { stripped, stringRanges } = scanSource(code);
  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();
  for (const { kind, regex } of SPECIFIER_PATTERNS) {
    for (const match of stripped.matchAll(regex)) {
      const matchIndex = match.index ?? 0;
      if (isInsideRanges(matchIndex, stringRanges)) {
        continue;
      }
      const specifier = match[2] ?? '';
      const line = lineOf(stripped, matchIndex);
      const key = `${kind}:${specifier}:${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        imports.push({ kind, specifier, line });
      }
    }
  }
  const nonLiteral: Array<{ kind: string; line: number }> = [];
  for (const match of stripped.matchAll(/\b(import|require)\s*\(\s*/g)) {
    const matchIndex = match.index ?? 0;
    if (isInsideRanges(matchIndex, stringRanges)) {
      continue;
    }
    const after = stripped[matchIndex + match[0].length];
    if (after !== "'" && after !== '"') {
      nonLiteral.push({ kind: match[1] ?? 'import', line: lineOf(stripped, matchIndex) });
    }
  }
  return { imports, nonLiteral };
}

/** 把相对/别名目标解析为 src 下的真实 .ts 源文件（NodeNext 的 .js 后缀映射回 .ts）。 */
function resolveSourceFile(baseDir: string, specifier: string): string | null {
  const base = resolve(baseDir, specifier);
  const candidates = [base];
  if (base.endsWith('.js')) {
    candidates.push(`${base.slice(0, -3)}.ts`);
  }
  if (base.endsWith('.mjs')) {
    candidates.push(`${base.slice(0, -4)}.mts`);
  }
  if (base.endsWith('.cjs')) {
    candidates.push(`${base.slice(0, -4)}.cts`);
  }
  candidates.push(`${base}.ts`, join(base, 'index.ts'));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return null;
}

function listSourceFiles(srcDir: string): string[] {
  if (!existsSync(srcDir)) {
    return [];
  }
  const result: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        result.push(child);
      }
    }
  };
  walk(srcDir);
  return result.sort();
}

/** tsconfig 允许注释与尾逗号；解析失败时按无 paths 处理之外的结构性错误抛出。 */
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/^\s*\/\/.*$/gm, '')
    .replaceAll(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as Record<string, unknown>;
}

function loadPackage(root: string, dir: string): WorkspacePackage {
  const absoluteDir = resolve(root, dir);
  const manifestPath = join(absoluteDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`workspace ${dir} 缺少 package.json（${manifestPath}）`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const name = manifest.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`workspace ${dir} 的 package.json 缺少有效的 name 字段`);
  }

  const declaredDependencies = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const table = manifest[field];
    if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
      for (const dependencyName of Object.keys(table as Record<string, unknown>)) {
        declaredDependencies.add(dependencyName);
      }
    }
  }

  const importsMap: Record<string, unknown> = {};
  const importsField = manifest.imports;
  if (importsField !== null && typeof importsField === 'object' && !Array.isArray(importsField)) {
    Object.assign(importsMap, importsField as Record<string, unknown>);
  }

  const tsconfigPaths: Record<string, string[]> = {};
  let tsconfigBaseDir = absoluteDir;
  const tsconfigPath = join(absoluteDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    const tsconfig = parseJsonc(readFileSync(tsconfigPath, 'utf-8'));
    const compilerOptions =
      tsconfig.compilerOptions !== null && typeof tsconfig.compilerOptions === 'object'
        ? (tsconfig.compilerOptions as Record<string, unknown>)
        : {};
    if (typeof compilerOptions.baseUrl === 'string') {
      tsconfigBaseDir = resolve(absoluteDir, compilerOptions.baseUrl);
    }
    const paths = compilerOptions.paths;
    if (paths !== null && typeof paths === 'object' && !Array.isArray(paths)) {
      for (const [key, value] of Object.entries(paths as Record<string, unknown>)) {
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
          tsconfigPaths[key] = value as string[];
        }
      }
    }
  }

  return {
    name,
    role: roleOf(name),
    dir: absoluteDir,
    srcDir: join(absoluteDir, 'src'),
    manifest,
    declaredDependencies,
    importsMap,
    tsconfigPaths,
    tsconfigBaseDir,
  };
}

/** 匹配 `#alias/*`、`@scope/*` 这类至多一个 `*` 的模式键；返回 `*` 捕获的内容。 */
function matchPatternKey(key: string, specifier: string): string | null {
  const star = key.indexOf('*');
  if (star === -1) {
    return key === specifier ? '' : null;
  }
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix) &&
    specifier.length >= prefix.length + suffix.length
  ) {
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  }
  return null;
}

/** 解析 package.json imports 目标：字符串直接采用；条件对象按 node→import→default 选取。 */
function pickConditionalTarget(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const table = value as Record<string, unknown>;
    for (const condition of ['node', 'import', 'default']) {
      if (condition in table) {
        return pickConditionalTarget(table[condition]);
      }
    }
  }
  return null;
}

type CheckContext = {
  root: string;
  packagesByName: Map<string, WorkspacePackage>;
  edges: Map<string, Set<string>>;
  diagnostics: BoundaryDiagnostic[];
  report: (
    severity: DiagnosticSeverity,
    rule: string,
    file: string,
    line: number,
    specifier: string,
    detail: string,
  ) => void;
};

function coreLayerOf(corePkg: WorkspacePackage, absoluteFile: string): string {
  const rel = relative(corePkg.srcDir, absoluteFile);
  const head = rel.split(sep)[0] ?? '';
  return head in CORE_LAYER_TARGETS ? head : 'root';
}

function checkCoreLayerEdge(
  ctx: CheckContext,
  corePkg: WorkspacePackage,
  importerFile: string,
  targetFile: string,
  line: number,
  specifier: string,
): void {
  const importerLayer = coreLayerOf(corePkg, importerFile);
  const targetLayer = coreLayerOf(corePkg, targetFile);
  const allowed = CORE_LAYER_TARGETS[importerLayer] ?? [];
  if (!allowed.includes(targetLayer)) {
    ctx.report(
      'violation',
      'core-layer-direction',
      importerFile,
      line,
      specifier,
      `Core ${importerLayer} 层禁止导入 ${targetLayer} 层（domain 仅可自引用；ports→domain；` +
        'application→domain/ports；adapters→domain/application/ports；公共入口与契约区禁止导入 adapters 实现）',
    );
  }
}

function checkWorkspaceDirection(
  ctx: CheckContext,
  importer: WorkspacePackage,
  target: WorkspacePackage,
  file: string,
  line: number,
  specifier: string,
): void {
  if (target.name === importer.name) {
    ctx.report(
      'violation',
      'self-package-reference',
      file,
      line,
      specifier,
      `包内模块不得通过自身包名 ${importer.name} 引用，请使用相对路径（自引用会绕过分层与公共入口边界）`,
    );
    return;
  }
  if (!isAllowedWorkspaceEdge(importer.role, target.role)) {
    ctx.report(
      'violation',
      'reverse-dependency',
      file,
      line,
      specifier,
      `工作区包 ${importer.name}(${importer.role}) 不允许依赖 ${target.name}(${target.role})：` +
        '单向依赖仅允许 Host→Core 公共入口、CLI→Host 公共客户端/契约；Core 不反向依赖 Host/CLI，CLI 不绕过 Host 直连 Core',
    );
  }
}

/** 判定经过包内解析后的 src 目标文件：越界报 alias-escape/relative-escape，Core 内做分层检查。 */
function checkResolvedInternalTarget(
  ctx: CheckContext,
  importerPkg: WorkspacePackage,
  importerFile: string,
  resolved: string,
  line: number,
  specifier: string,
  escapeRule: 'relative-escape' | 'alias-escape',
  escapeDetail: string,
): void {
  if (!isInside(resolved, importerPkg.srcDir)) {
    ctx.report('violation', escapeRule, importerFile, line, specifier, escapeDetail);
    return;
  }
  if (importerPkg.role === 'core') {
    checkCoreLayerEdge(ctx, importerPkg, importerFile, resolved, line, specifier);
  }
}

function classifyExternal(
  ctx: CheckContext,
  importerPkg: WorkspacePackage,
  importerFile: string,
  line: number,
  specifier: string,
): void {
  const contractZone =
    importerPkg.role === 'core' && coreLayerOf(importerPkg, importerFile) !== 'adapters';
  if (contractZone && isBannedVendor(specifier)) {
    ctx.report(
      'violation',
      'core-contract-infra',
      importerFile,
      line,
      specifier,
      'Core 契约区（domain/application/ports/公共入口）禁止导入或重导出 Pi SDK、Electron、' +
        'HTTP 框架、better-sqlite3、Drizzle 等基础设施/厂商模块；此类绑定只能出现在 adapters 层',
    );
    return;
  }
  const declaredName = [...importerPkg.declaredDependencies].find(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
  if (declaredName !== undefined) {
    return;
  }
  let resolvedFrom: string | null = null;
  try {
    resolvedFrom = createRequire(importerFile).resolve(specifier);
  } catch {
    resolvedFrom = null;
  }
  if (resolvedFrom !== null) {
    ctx.report(
      'violation',
      'undeclared-dependency',
      importerFile,
      line,
      specifier,
      `生产源码导入了未在 ${importerPkg.name} 的 package.json 中声明的依赖（虽可从 ${resolvedFrom} 解析）；` +
        '为占位而添加依赖与隐式依赖传递同样禁止',
    );
    return;
  }
  ctx.report(
    'error',
    'unresolved-import',
    importerFile,
    line,
    specifier,
    `无法解析的生产导入：既不是 Node 内置模块、已声明依赖，也不是已知工作区包，本地解析失败；不默认可解析为合法`,
  );
}

function classifySpecifier(
  ctx: CheckContext,
  importerPkg: WorkspacePackage,
  importerFile: string,
  entry: ExtractedImport,
): void {
  const { specifier, line } = entry;

  // 1. 相对路径：必须解析到本包 src 之内的真实源文件。
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = resolveSourceFile(dirname(importerFile), specifier);
    if (resolved === null) {
      ctx.report(
        'error',
        'unresolved-import',
        importerFile,
        line,
        specifier,
        '相对导入无法解析到真实源文件；不默认可解析为合法',
      );
      return;
    }
    checkResolvedInternalTarget(
      ctx,
      importerPkg,
      importerFile,
      resolved,
      line,
      specifier,
      'relative-escape',
      `相对导入解析到本包 src 根之外（${relative(ctx.root, resolved)}）；不允许以相对路径绕过包边界或导入非 src 文件`,
    );
    return;
  }

  // 2. package.json imports（# 别名）：只能映射回本包 src 之内的文件或外部已声明依赖。
  if (specifier.startsWith('#')) {
    let matchedTarget: string | null = null;
    let matchedKey: string | null = null;
    for (const [key, value] of Object.entries(importerPkg.importsMap)) {
      const star = matchPatternKey(key, specifier);
      if (star === null) {
        continue;
      }
      const target = pickConditionalTarget(value);
      if (target === null) {
        continue;
      }
      matchedKey = key;
      matchedTarget = target.includes('*') ? target.replaceAll('*', star) : target;
      break;
    }
    if (matchedTarget === null || matchedKey === null) {
      ctx.report(
        'error',
        'unresolved-import',
        importerFile,
        line,
        specifier,
        `# 别名未在 ${importerPkg.name} 的 package.json imports 中声明可解析目标；不默认可解析为合法`,
      );
      return;
    }
    if (!matchedTarget.startsWith('./')) {
      classifyExternal(ctx, importerPkg, importerFile, line, matchedTarget);
      return;
    }
    const resolved = resolveSourceFile(importerPkg.dir, matchedTarget);
    if (resolved === null) {
      ctx.report(
        'error',
        'unresolved-import',
        importerFile,
        line,
        specifier,
        `imports 别名 ${matchedKey} 的目标 ${matchedTarget} 无法解析到真实源文件`,
      );
      return;
    }
    checkResolvedInternalTarget(
      ctx,
      importerPkg,
      importerFile,
      resolved,
      line,
      specifier,
      'alias-escape',
      `imports 别名 ${matchedKey}（${specifier}）解析到本包 src 根之外（${relative(ctx.root, resolved)}）；不允许以路径别名绕过包边界`,
    );
    return;
  }

  // 3. tsconfig paths 别名：匹配则必须解析到本包 src 之内。
  for (const [key, targets] of Object.entries(importerPkg.tsconfigPaths)) {
    const star = matchPatternKey(key, specifier);
    if (star === null) {
      continue;
    }
    for (const target of targets) {
      const substituted = target.includes('*') ? target.replaceAll('*', star) : target;
      const resolved = resolveSourceFile(importerPkg.tsconfigBaseDir, substituted);
      if (resolved === null) {
        continue;
      }
      checkResolvedInternalTarget(
        ctx,
        importerPkg,
        importerFile,
        resolved,
        line,
        specifier,
        'alias-escape',
        `tsconfig paths 别名 ${key}（${specifier}）解析到本包 src 根之外（${relative(ctx.root, resolved)}）；不允许以路径别名绕过包边界`,
      );
      return;
    }
    // 匹配了别名但所有目标都无法解析：继续后续解析路径，最终按 unresolved 报错。
  }

  // 4. Node 内置模块：Core 契约区禁止网络类内置模块。
  if (isBuiltin(specifier)) {
    const contractZone =
      importerPkg.role === 'core' && coreLayerOf(importerPkg, importerFile) !== 'adapters';
    const bannedBase = bannedBuiltinBase(specifier);
    if (contractZone && bannedBase !== null) {
      ctx.report(
        'violation',
        'core-contract-infra',
        importerFile,
        line,
        specifier,
        `Core 契约区（domain/application/ports/公共入口）禁止导入 node:${bannedBase} 等网络内置模块`,
      );
    }
    return;
  }

  // 5. 工作区包（包名精确命中）：方向规则 + 记录依赖图边。
  const workspaceTarget = ctx.packagesByName.get(specifier);
  if (workspaceTarget !== undefined) {
    const fromEdges = ctx.edges.get(importerPkg.name) ?? new Set<string>();
    fromEdges.add(workspaceTarget.name);
    ctx.edges.set(importerPkg.name, fromEdges);
    checkWorkspaceDirection(ctx, importerPkg, workspaceTarget, importerFile, line, specifier);
    return;
  }

  // 6. 工作区包子路径：跨包内部导入，无论方向一律禁止。
  const subpathOwner = [...ctx.packagesByName.keys()].find((name) =>
    specifier.startsWith(`${name}/`),
  );
  if (subpathOwner !== undefined) {
    ctx.report(
      'violation',
      'cross-package-internal',
      importerFile,
      line,
      specifier,
      `禁止跨包内部导入 ${specifier}：只允许经包名 ${subpathOwner} 依赖其公共入口（exports 的 "."），不得引用内部文件`,
    );
    return;
  }

  // 7. 外部依赖：必须已在导入包清单中声明，否则区分“可解析但未声明”与“无法解析”。
  classifyExternal(ctx, importerPkg, importerFile, line, specifier);
}

function normalizeCycle(cycle: string[]): string {
  const body = cycle.slice(0, -1);
  let smallest = 0;
  for (let i = 1; i < body.length; i += 1) {
    if ((body[i] as string) < (body[smallest] as string)) {
      smallest = i;
    }
  }
  const rotated = [...body.slice(smallest), ...body.slice(0, smallest)];
  return [...rotated, rotated[0] as string].join(' -> ');
}

function findCycles(edges: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (node: string): void => {
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (onStack.has(next)) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = normalizeCycle(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else {
        visit(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  };
  for (const node of edges.keys()) {
    visit(node);
  }
  return cycles;
}

export function runBoundaryCheck(rootInput: string): BoundaryCheckResult {
  const root = resolve(rootInput);
  const rootManifestPath = join(root, 'package.json');
  if (!existsSync(rootManifestPath)) {
    throw new Error(`缺少根 package.json：${rootManifestPath}`);
  }
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf-8')) as Record<
    string,
    unknown
  >;
  const workspaces = rootManifest.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((entry) => typeof entry !== 'string')) {
    throw new Error('根 package.json 的 workspaces 必须是字符串数组');
  }

  const packages = (workspaces as string[]).map((dir) => loadPackage(root, dir));
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  const diagnostics: BoundaryDiagnostic[] = [];
  const edges = new Map<string, Set<string>>();
  const ctx: CheckContext = {
    root,
    packagesByName,
    edges,
    diagnostics,
    report: (severity, rule, file, line, specifier, detail) => {
      diagnostics.push({ severity, rule, file: relative(root, file), line, specifier, detail });
    },
  };

  // 清单级检查：各包声明的工作区依赖同样受单向规则约束，并计入依赖图。
  for (const pkg of packages) {
    const manifestFile = join(pkg.dir, 'package.json');
    for (const field of DEPENDENCY_FIELDS) {
      const table = pkg.manifest[field];
      if (table === null || typeof table !== 'object' || Array.isArray(table)) {
        continue;
      }
      for (const dependencyName of Object.keys(table as Record<string, unknown>)) {
        const target = packagesByName.get(dependencyName);
        if (target === undefined) {
          continue;
        }
        const fromEdges = edges.get(pkg.name) ?? new Set<string>();
        fromEdges.add(target.name);
        edges.set(pkg.name, fromEdges);
        checkWorkspaceDirection(ctx, pkg, target, manifestFile, 0, dependencyName);
      }
    }
  }

  // 源码级检查：只扫描各包 src 下的生产 TypeScript 源码。
  const scope: PackageScope[] = [];
  for (const pkg of packages) {
    const files = listSourceFiles(pkg.srcDir);
    scope.push({
      packageName: pkg.name,
      packageDir: relative(root, pkg.dir),
      srcDir: relative(root, pkg.srcDir),
      files: files.map((file) => relative(root, file)),
    });
    for (const file of files) {
      const { imports, nonLiteral } = extractImports(readFileSync(file, 'utf-8'));
      for (const entry of nonLiteral) {
        ctx.report(
          'error',
          'non-literal-import',
          file,
          entry.line,
          `${entry.kind}(…)`,
          `非字面量 ${entry.kind}() 调用无法静态分析，生产源码禁止使用；请改为字面量说明符`,
        );
      }
      for (const entry of imports) {
        classifySpecifier(ctx, pkg, file, entry);
      }
    }
  }

  // 工作区循环依赖检测（基于清单与源码导入的完整依赖图）。
  for (const cycle of findCycles(edges)) {
    const normalized = normalizeCycle(cycle);
    diagnostics.push({
      severity: 'violation',
      rule: 'dependency-cycle',
      file: '',
      line: 0,
      specifier: normalized,
      detail: `检测到工作区循环依赖：${normalized}；单向依赖规则禁止任何环形引用`,
    });
  }

  const deduped = [
    ...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values(),
  ].sort((a, b) =>
    `${a.file}:${a.line}:${a.rule}:${a.specifier}`.localeCompare(
      `${b.file}:${b.line}:${b.rule}:${b.specifier}`,
    ),
  );

  return { root, scope, diagnostics: deduped, ok: deduped.length === 0 };
}

function main(argv: string[]): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  let root = resolve(scriptDir, '..');
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--root' && i + 1 < rest.length) {
      root = resolve(rest[i + 1] as string);
      i += 1;
    } else {
      process.stderr.write(
        `check-boundaries: unknown argument "${String(arg)}"\n` +
          'usage: node scripts/check-boundaries.ts [--root <dir>]\n',
      );
      return 1;
    }
  }

  let result: BoundaryCheckResult;
  try {
    result = runBoundaryCheck(root);
  } catch (error) {
    process.stderr.write(`check-boundaries: FAIL ${(error as Error).message}\n`);
    return 1;
  }

  process.stdout.write(`check-boundaries: root ${result.root}\n`);
  for (const entry of result.scope) {
    process.stdout.write(
      `check-boundaries: scope ${entry.srcDir} (${entry.packageName}, ${entry.files.length} production source files)\n`,
    );
  }
  if (!result.ok) {
    process.stdout.write(`check-boundaries: FAIL ${result.diagnostics.length} diagnostic(s)\n`);
    for (const diagnostic of result.diagnostics) {
      const where =
        diagnostic.file.length > 0
          ? `${diagnostic.file}${diagnostic.line > 0 ? `:${diagnostic.line}` : ''}`
          : '(workspace graph)';
      process.stdout.write(
        `  [${diagnostic.severity}/${diagnostic.rule}] ${where} -> '${diagnostic.specifier}': ${diagnostic.detail}\n`,
      );
    }
    return 1;
  }
  const total = result.scope.reduce((count, entry) => count + entry.files.length, 0);
  process.stdout.write(
    `check-boundaries: PASS ${total} production source files scanned, 0 diagnostics\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
