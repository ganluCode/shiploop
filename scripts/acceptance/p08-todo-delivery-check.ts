/**
 * P08-2 / F-003 Todo CLI 交付结果的局部契约检查器。
 *
 * 目标：对 live 生成的临时 Todo 项目做确定性的局部行为核对，使 Runtime 正常结束
 * 之后仍有一个不依赖模型自报/日志成功文字的判定入口。覆盖冻结需求
 * `acceptance/p08.todo-requirements.json`（F-001）的九类行为：
 * - 正常：add / list / complete / delete 在合法输入下产生可观察正确结果；
 * - 持久化：每次调用都是独立进程，跨进程读取同一数据，数据以文件形式落在数据目录；
 * - 失败：空标题、未知 ID、无效命令、数据读写故障必须非零退出且保全已有数据；
 * - 测试产物：临时项目须声明与九类行为对应的测试文件且真实存在，项目测试命令
 *   仅以退出码 0 判定通过，绝不解析日志中的成功文字。
 *
 * 边界（验收标准 5）：本检查器只验证 Todo 交付行为本身。真实 Host 进程、SQLite
 * 并发竞争、进程停止核验与 Git 集成属于阶段集成检查，本模块不提供、不伪装这些
 * 结论；报告显式列出 outOfScope。检查器不联网、不调用模型、不接触 Core/Host。
 *
 * 结构：`checkTodoDelivery` 为纯协议核心，全部副作用经 `TodoDeliveryCheckPorts`
 * 注入（运行 CLI、运行项目测试、数据目录探查、受控故障注入）。默认端口工厂
 * `createProcessTodoCheckPorts` 用真实子进程 + 真实文件系统实现端口：每次
 * `runTodo` 都 spawn 全新进程（跨进程持久化语义的前提），故障注入通过确定性
 * chmod 实现，不依赖随机磁盘错误。报告只含稳定结果码与布尔事实，不含输出正文、
 * 绝对路径或环境内容。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { P08_TODO_REQUIRED_CATEGORIES } from './p08-todo-requirements.ts';

/** 本检查器的作用域标识（区别于阶段集成/live 验收）。 */
export const P08_TODO_CHECK_SCOPE = 'local-delivery-contract' as const;

/** 明确移出本检查器范围的项（留给阶段集成检查）。 */
export const P08_TODO_CHECK_OUT_OF_SCOPE: readonly { readonly id: string; readonly note: string }[] = [
  { id: 'real-host', note: '真实 Host 进程与 HTTP 生命周期属于阶段集成检查' },
  { id: 'sqlite-concurrency', note: 'SQLite 并发竞争与迁移属于阶段集成检查' },
  { id: 'process-stop', note: '进程停止核验与取消恢复属于阶段集成检查' },
  { id: 'git-integration', note: '临时项目 Git 提交与集成属于阶段集成检查和 live 证据链' },
];

/** 受控数据故障注入类别（确定性，仅作用于数据目录）。 */
export type TodoDataFaultKind = 'store-readonly' | 'data-unreadable';

export class TodoDeliveryCheckError extends Error {
  readonly kind = 'invalid_target' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TodoDeliveryCheckError';
  }
}

export interface TodoCommandOutcome {
  /** 进程退出码；无法启动/被信号终止时为 null（fail-closed，绝不折算为成功）。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** list 输出的解释结果：条目视图；返回 null 表示输出不可解释（检查失败）。 */
export interface TodoListItemView {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

/**
 * 由交付接线声明的 list 输出解释器：实现细节（存储格式/输出格式）由 live 规划
 * 决定，检查器只通过解释器核对语义（ID/标题/完成状态）。解释器必须解析真实
 * 输出；无法解析时返回 null，检查器按 fail-closed 处理，不猜测降级。
 */
export type TodoListInterpreter = (stdout: string, stderr: string) => readonly TodoListItemView[] | null;

export interface TodoDeclaredTest {
  /** 相对 projectRoot 的测试文件路径（禁止绝对路径与 .. 逃逸）。 */
  readonly file: string;
  /** 该文件覆盖的需求行为类别；并集必须覆盖全部九类。 */
  readonly categories: readonly string[];
}

export interface TodoDeliveryTarget {
  /** 临时项目根（绝对路径，位于外层 mkdtemp 临时根内）。 */
  readonly projectRoot: string;
  /** 数据目录（绝对路径，必须位于 projectRoot 之内）。 */
  readonly dataDirectory: string;
  /** Todo CLI 启动命令（如 ["node","todo.mjs"]，cwd 为 projectRoot）。 */
  readonly todoCommand: readonly string[];
  /** 临时项目自己的测试入口命令（cwd 为 projectRoot）。 */
  readonly testCommand: readonly string[];
  /** 声明的行为测试清单。 */
  readonly declaredTests: readonly TodoDeclaredTest[];
}

export interface TodoDataDirectoryFacts {
  readonly regularFiles: number;
  readonly totalEntries: number;
}

export interface TodoDeliveryCheckPorts {
  /**
   * 以独立子进程运行一次 Todo CLI。每次调用必须启动全新进程（持久化检查的前提）；
   * 不经 shell 拼接、不联网。超时/启动失败返回 exitCode=null 并置 timedOut。
   */
  runTodo(argv: readonly string[]): Promise<TodoCommandOutcome>;
  /** 以独立子进程运行临时项目声明的测试入口。 */
  runProjectTests(): Promise<TodoCommandOutcome>;
  /** 确定性注入数据故障（只读存储/数据不可读）；失败抛错由检查器记为检查失败。 */
  applyDataFault(kind: TodoDataFaultKind): Promise<void>;
  /** 解除全部已注入故障并恢复可读写。 */
  clearDataFaults(): Promise<void>;
  /** 探查数据目录当前内容（文件形式存储核验）。 */
  inspectDataDirectory(): Promise<TodoDataDirectoryFacts>;
  /** 项目文件大小（字节）；不存在返回 null。 */
  projectFileSize(file: string): Promise<number | null>;
}

export interface TodoCheckRecord {
  readonly id: string;
  readonly categories: readonly string[];
  readonly status: 'pass' | 'fail';
  readonly reasons: readonly string[];
}

export interface TodoDeliveryCheckReport {
  readonly scope: typeof P08_TODO_CHECK_SCOPE;
  readonly passed: boolean;
  readonly outOfScope: typeof P08_TODO_CHECK_OUT_OF_SCOPE;
  readonly checks: readonly TodoCheckRecord[];
  readonly summary: { readonly total: number; readonly failed: number };
}

type Reason =
  | 'todo_timeout' | 'todo_unrunnable' | 'exit_nonzero'
  | 'list_uninterpretable' | 'list_not_empty' | 'list_empty_expected'
  | 'item_missing' | 'item_state_wrong' | 'other_items_changed' | 'id_not_unique'
  | 'id_changed' | 'repeat_nondeterministic' | 'item_still_listed'
  | 'silent_success' | 'missing_error_output' | 'id_not_echoed' | 'empty_title_hint_missing'
  | 'data_modified' | 'fault_application_failed' | 'fault_cleared_unverified'
  | 'silent_empty_success' | 'restored_data_changed' | 'restored_unreadable'
  | 'data_not_file_backed'
  | 'project_tests_timeout' | 'project_tests_unrunnable' | 'project_tests_exit_nonzero'
  | 'test_files_missing';

function fail(message: string): never {
  throw new TodoDeliveryCheckError(message);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** fail-closed 校验检查目标；数据目录越界、空命令或测试清单缺口一律拒绝。 */
export function validateTodoDeliveryTarget(target: TodoDeliveryTarget): void {
  if (!isAbsolute(target.projectRoot)) fail('projectRoot 必须是绝对路径');
  if (!isAbsolute(target.dataDirectory) || !isInside(target.dataDirectory, target.projectRoot)) {
    fail('dataDirectory 必须是位于 projectRoot 之内的绝对路径');
  }
  for (const [key, command] of [['todoCommand', target.todoCommand], ['testCommand', target.testCommand]] as const) {
    if (!Array.isArray(command) || command.length === 0) fail(`${key} 必须是非空命令数组`);
    for (const part of command) {
      if (typeof part !== 'string' || part.trim() === '') fail(`${key} 的每个参数必须是非空字符串`);
    }
  }
  if (!Array.isArray(target.declaredTests) || target.declaredTests.length === 0) {
    fail('declaredTests 必须是非空数组');
  }
  const allowed = new Set<string>(P08_TODO_REQUIRED_CATEGORIES);
  const covered = new Set<string>();
  const files = new Set<string>();
  target.declaredTests.forEach((entry, index) => {
    const at = `declaredTests[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`${at} 必须是对象`);
    if (typeof entry.file !== 'string' || entry.file.trim() === '') fail(`${at}.file 必须是非空字符串`);
    if (isAbsolute(entry.file) || entry.file.split(/[\\/]/).includes('..')) {
      fail(`${at}.file 必须是不含 .. 的项目相对路径`);
    }
    if (files.has(entry.file)) fail(`${at}.file 重复：${entry.file}`);
    files.add(entry.file);
    if (!Array.isArray(entry.categories) || entry.categories.length === 0) fail(`${at}.categories 必须是非空数组`);
    for (const category of entry.categories) {
      if (typeof category !== 'string' || !allowed.has(category)) {
        fail(`${at}.categories 含未知行为类别：${String(category)}`);
      }
      covered.add(category);
    }
  });
  const missing = [...allowed].filter(category => !covered.has(category));
  if (missing.length > 0) fail(`declaredTests 未覆盖全部需求行为类别，缺失：${missing.join('、')}`);
}

interface Snapshot {
  readonly ok: boolean;
  readonly reasons: Reason[];
  readonly items: readonly TodoListItemView[];
}

/** 对临时 Todo 项目执行局部契约检查并返回结构化报告（不抛业务失败，失败体现在报告内）。 */
export async function checkTodoDelivery(
  target: TodoDeliveryTarget,
  interpretList: TodoListInterpreter,
  ports: TodoDeliveryCheckPorts,
): Promise<TodoDeliveryCheckReport> {
  validateTodoDeliveryTarget(target);
  const checks: TodoCheckRecord[] = [];
  const record = (id: string, categories: readonly string[], reasons: readonly Reason[]): void => {
    checks.push({ id, categories, status: reasons.length === 0 ? 'pass' : 'fail', reasons });
  };

  const runOk = (outcome: TodoCommandOutcome): Reason[] => {
    if (outcome.timedOut) return ['todo_timeout'];
    if (outcome.exitCode === null) return ['todo_unrunnable'];
    return outcome.exitCode === 0 ? [] : ['exit_nonzero'];
  };
  const snapshot = async (): Promise<Snapshot> => {
    const outcome = await ports.runTodo(['list']);
    const reasons = runOk(outcome);
    if (reasons.length > 0) return { ok: false, reasons, items: [] };
    const items = interpretList(outcome.stdout, outcome.stderr);
    if (items === null) return { ok: false, reasons: ['list_uninterpretable'], items: [] };
    return { ok: true, reasons: [], items };
  };
  const sameItems = (left: readonly TodoListItemView[], right: readonly TodoListItemView[]): boolean =>
    left.length === right.length && left.every((item, index) =>
      item.id === right[index]!.id && item.title === right[index]!.title && item.completed === right[index]!.completed);
  /** 期望一次失败调用：非零退出、有错误输出、（可选）回显目标 ID/关键词。 */
  const expectFailure = async (
    argv: readonly string[],
    options: { readonly echo?: string; readonly emptyTitleHint?: boolean } = {},
  ): Promise<Reason[]> => {
    const outcome = await ports.runTodo(argv);
    if (outcome.timedOut) return ['todo_timeout'];
    if (outcome.exitCode === null) return ['todo_unrunnable'];
    if (outcome.exitCode === 0) return ['silent_success'];
    const reasons: Reason[] = [];
    const output = `${outcome.stdout}\n${outcome.stderr}`;
    if (output.trim() === '') reasons.push('missing_error_output');
    if (options.echo !== undefined && !output.includes(options.echo)) reasons.push('id_not_echoed');
    if (options.emptyTitleHint === true && !/空|empty|title|标题/i.test(output)) {
      reasons.push('empty_title_hint_missing');
    }
    return reasons;
  };
  /** 失败类别通用骨架：先取基线，执行故障调用，再核对数据未变。 */
  const failureCategory = async (
    id: string,
    category: string,
    steps: () => Promise<Reason[]>,
  ): Promise<void> => {
    const baseline = await snapshot();
    if (!baseline.ok) {
      record(id, [category], [...baseline.reasons]);
      return;
    }
    const reasons = await steps();
    const after = await snapshot();
    if (!after.ok) reasons.push(...after.reasons);
    else if (!sameItems(baseline.items, after.items)) reasons.push('data_modified');
    record(id, [category], reasons);
  };
  const absentId = (items: readonly TodoListItemView[]): string => {
    let candidate = 'todo-nonexistent-id';
    const ids = new Set(items.map(item => item.id));
    while (ids.has(candidate)) candidate = `${candidate}-x`;
    return candidate;
  };

  /* ---- 空列表：退出码 0 且输出可解释为明确空列表 ---- */
  {
    const outcome = await ports.runTodo(['list']);
    const reasons = runOk(outcome);
    if (reasons.length === 0) {
      const items = interpretList(outcome.stdout, outcome.stderr);
      if (items === null) reasons.push('list_uninterpretable');
      else if (items.length > 0) reasons.push('list_not_empty');
    }
    record('list-empty', ['list'], reasons);
  }

  /* ---- 新增 + 列表可见 ---- */
  {
    const reasons: Reason[] = [];
    const first = await ports.runTodo(['add', 'ShipLoop demo first']);
    reasons.push(...runOk(first));
    const second = await ports.runTodo(['add', 'ShipLoop demo second']);
    reasons.push(...runOk(second));
    const snap = await snapshot();
    reasons.push(...snap.reasons);
    if (snap.ok) {
      const items = snap.items;
      if (new Set(items.map(item => item.id)).size !== items.length) reasons.push('id_not_unique');
      for (const title of ['ShipLoop demo first', 'ShipLoop demo second']) {
        const entry = items.find(item => item.title === title);
        if (entry === undefined || entry.completed !== false) reasons.push('item_missing');
      }
    }
    record('add-list', ['add', 'list'], reasons);
  }

  /* ---- 完成：状态翻转、其余不变、ID/标题稳定 ---- */
  let firstItem: TodoListItemView | undefined;
  {
    const snap = await snapshot();
    const reasons = [...snap.reasons];
    if (snap.ok && snap.items.length >= 2) {
      firstItem = snap.items[0]!;
      const other = snap.items.slice(1);
      const done = await ports.runTodo(['complete', firstItem.id]);
      reasons.push(...runOk(done));
      const after = await snapshot();
      reasons.push(...after.reasons);
      if (after.ok) {
        const changed = after.items.find(item => item.id === firstItem!.id);
        if (changed === undefined || changed.completed !== true || changed.title !== firstItem.title) {
          reasons.push('item_state_wrong');
        }
        const rest = after.items.filter(item => item.id !== firstItem!.id);
        if (!sameItems(other, rest)) reasons.push('other_items_changed');
      }
    } else if (snap.ok) {
      reasons.push('item_missing');
    }
    record('complete', ['complete'], reasons);
  }

  /* ---- 重复完成：行为确定且不破坏数据 ---- */
  {
    const reasons: Reason[] = [];
    if (firstItem === undefined) {
      reasons.push('item_missing');
    } else {
      const before = await snapshot();
      reasons.push(...before.reasons);
      if (before.ok) {
        const again1 = await ports.runTodo(['complete', firstItem.id]);
        const again2 = await ports.runTodo(['complete', firstItem.id]);
        if (again1.timedOut || again2.timedOut) reasons.push('todo_timeout');
        else if (again1.exitCode === null || again2.exitCode === null) reasons.push('todo_unrunnable');
        else if (again1.exitCode !== again2.exitCode || again1.stdout !== again2.stdout) {
          reasons.push('repeat_nondeterministic');
        }
        const after = await snapshot();
        reasons.push(...after.reasons);
        if (after.ok && !sameItems(before.items, after.items)) reasons.push('data_modified');
      }
    }
    record('complete-repeat', ['complete'], reasons);
  }

  /* ---- 删除：条目消失、其余不变、数据仍可读 ---- */
  {
    const snap = await snapshot();
    const reasons = [...snap.reasons];
    if (snap.ok && snap.items.length >= 2) {
      const victim = snap.items[snap.items.length - 1]!;
      const rest = snap.items.filter(item => item.id !== victim.id);
      const removed = await ports.runTodo(['delete', victim.id]);
      reasons.push(...runOk(removed));
      const after = await snapshot();
      reasons.push(...after.reasons);
      if (after.ok) {
        if (after.items.some(item => item.id === victim.id)) reasons.push('item_still_listed');
        if (!sameItems(rest, after.items)) reasons.push('other_items_changed');
      }
    } else if (snap.ok) {
      reasons.push('item_missing');
    }
    record('delete', ['delete'], reasons);
  }

  /* ---- 跨进程持久化：全新进程读取同一数据；存储为数据目录内的文件 ---- */
  {
    const first = await snapshot();
    const reasons = [...first.reasons];
    if (first.ok) {
      const second = await snapshot();
      reasons.push(...second.reasons);
      if (second.ok && !sameItems(first.items, second.items)) reasons.push('data_modified');
      const facts = await ports.inspectDataDirectory();
      if (facts.regularFiles < 1) reasons.push('data_not_file_backed');
    }
    record('persistence', ['persistence'], reasons);
  }

  /* ---- 失败一：空标题（含纯空白） ---- */
  await failureCategory('failure-empty-title', 'empty-title', async () => {
    const reasons = await expectFailure(['add', ''], { emptyTitleHint: true });
    reasons.push(...(await expectFailure(['add', '   '])));
    return reasons;
  });

  /* ---- 失败二：未知 ID（complete/delete 均回显目标 ID） ---- */
  await failureCategory('failure-unknown-id', 'unknown-id', async () => {
    const snap = await snapshot();
    if (!snap.ok) return [...snap.reasons];
    const missing = absentId(snap.items);
    const reasons = await expectFailure(['complete', missing], { echo: missing });
    reasons.push(...(await expectFailure(['delete', missing], { echo: missing })));
    return reasons;
  });

  /* ---- 失败三：无效命令与缺参 ---- */
  await failureCategory('failure-invalid-command', 'invalid-command', async () => {
    const reasons = await expectFailure(['definitely-not-a-todo-command']);
    reasons.push(...(await expectFailure(['add'])));
    reasons.push(...(await expectFailure(['complete'])));
    return reasons;
  });

  /* ---- 失败四：数据读写故障（受控注入） ---- */
  {
    const reasons: Reason[] = [];
    const baseline = await snapshot();
    reasons.push(...baseline.reasons);
    if (baseline.ok) {
      try {
        await ports.applyDataFault('store-readonly');
        reasons.push(...(await expectFailure(['add', 'blocked by injection'])));
      } catch {
        reasons.push('fault_application_failed');
      }
      try {
        await ports.clearDataFaults();
      } catch {
        reasons.push('fault_cleared_unverified');
      }
      const afterWrite = await snapshot();
      reasons.push(...afterWrite.reasons);
      if (afterWrite.ok && !sameItems(baseline.items, afterWrite.items)) reasons.push('restored_data_changed');
      try {
        await ports.applyDataFault('data-unreadable');
        const listOutcome = await ports.runTodo(['list']);
        if (listOutcome.timedOut) reasons.push('todo_timeout');
        else if (listOutcome.exitCode === null) reasons.push('todo_unrunnable');
        else if (listOutcome.exitCode === 0) reasons.push('silent_empty_success');
      } catch {
        reasons.push('fault_application_failed');
      }
      try {
        await ports.clearDataFaults();
      } catch {
        reasons.push('fault_cleared_unverified');
      }
      const restored = await snapshot();
      reasons.push(...restored.reasons);
      if (restored.ok && !sameItems(baseline.items, restored.items)) reasons.push('restored_unreadable');
    }
    record('failure-data-io', ['data-io-failure'], reasons);
  }

  /* ---- 测试产物：清单文件真实存在，项目测试仅按退出码判定 ---- */
  {
    const reasons: Reason[] = [];
    for (const declared of target.declaredTests) {
      const size = await ports.projectFileSize(declared.file);
      if (size === null || size === 0) { reasons.push('test_files_missing'); break; }
    }
    const tests = await ports.runProjectTests();
    if (tests.timedOut) reasons.push('project_tests_timeout');
    else if (tests.exitCode === null) reasons.push('project_tests_unrunnable');
    else if (tests.exitCode !== 0) reasons.push('project_tests_exit_nonzero');
    // 成功只来自退出码 0；stdout 中的成功文字不参与判定（由负例夹具守护）。
    record('project-tests', ['add', 'list', 'complete', 'delete', 'persistence', 'empty-title', 'unknown-id', 'invalid-command', 'data-io-failure'], reasons);
  }

  const failed = checks.filter(check => check.status === 'fail').length;
  return {
    scope: P08_TODO_CHECK_SCOPE,
    passed: failed === 0,
    outOfScope: P08_TODO_CHECK_OUT_OF_SCOPE,
    checks,
    summary: { total: checks.length, failed },
  };
}

export interface ProcessTodoCheckPortOptions {
  /** 单条命令的运行预算（毫秒）；默认 10000。 */
  readonly timeoutMs?: number;
  /** 附加到 Todo CLI 子进程的环境（如交付接线声明的开关）；不继承开发机无关变量。 */
  readonly todoEnv?: Readonly<Record<string, string>>;
  /** 附加到项目测试子进程的环境。 */
  readonly testEnv?: Readonly<Record<string, string>>;
}

function spawnOutcome(
  command: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): TodoCommandOutcome {
  const result = spawnSync(command[0]!, [...command.slice(1)], {
    cwd,
    env,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    exitCode: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
  };
}

/**
 * 默认端口工厂：真实子进程（每次调用全新进程，不经 shell）+ 真实文件系统。
 * 故障注入只修改本次临时项目数据目录的权限，故障解除恢复为可读写标准权限。
 */
export function createProcessTodoCheckPorts(
  target: TodoDeliveryTarget,
  options: ProcessTodoCheckPortOptions = {},
): TodoDeliveryCheckPorts {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    TZ: 'UTC',
    ...(options.todoEnv ?? {}),
  };
  const dataFiles = (): string[] => {
    try {
      return readdirSync(target.dataDirectory)
        .map(entry => join(target.dataDirectory, entry))
        .filter(path => { try { return statSync(path).isFile(); } catch { return false; } });
    } catch {
      return [];
    }
  };
  return {
    async runTodo(argv) {
      return spawnOutcome([...target.todoCommand, ...argv], target.projectRoot, baseEnv, timeoutMs);
    },
    async runProjectTests() {
      const env = { PATH: process.env.PATH ?? '', TZ: 'UTC', ...(options.testEnv ?? {}) };
      return spawnOutcome(target.testCommand, target.projectRoot, env, timeoutMs);
    },
    async applyDataFault(kind) {
      const files = dataFiles();
      if (kind === 'store-readonly') {
        for (const file of files) chmodSync(file, 0o444);
        chmodSync(target.dataDirectory, 0o555);
      } else {
        for (const file of files) chmodSync(file, 0o000);
      }
    },
    async clearDataFaults() {
      for (const file of dataFiles()) chmodSync(file, 0o644);
      chmodSync(target.dataDirectory, 0o755);
    },
    async inspectDataDirectory() {
      try {
        const entries = readdirSync(target.dataDirectory);
        let regularFiles = 0;
        for (const entry of entries) {
          try { if (statSync(join(target.dataDirectory, entry)).isFile()) regularFiles += 1; } catch { /* 记为非文件 */ }
        }
        return { regularFiles, totalEntries: entries.length };
      } catch {
        return { regularFiles: 0, totalEntries: 0 };
      }
    },
    async projectFileSize(file) {
      try {
        const stats = statSync(resolve(target.projectRoot, file));
        return stats.isFile() ? stats.size : null;
      } catch {
        return null;
      }
    },
  };
}
