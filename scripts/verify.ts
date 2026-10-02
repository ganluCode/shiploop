/**
 * F-005 fail-closed 工程检查编排（npm run verify）——开发工程检查脚本，
 * 不是未来 ShipLoop 的业务 Verifier，也不提供本阶段之外的 accept:p01 验收。
 *
 * 编排（fail-fast，未执行步骤显式 NOT RUN，绝不标为通过）：
 * 0. 预检（不启动任何子命令）：根 package.json 可解析且声明 test/typecheck/build
 *    三个脚本（缺失即失败，检查不得跳过）；package-lock.json 存在、可解析、
 *    lockfileVersion 为有效数字、name/version 与根清单一致。预检不看 node_modules，
 *    锁文件缺失不会被“依赖已安装”的表象掩盖。
 * 1. npm test   2. npm run typecheck   3. npm run build
 *    每一步都是真实子进程：优先使用 npm_execpath 指定的当前 npm（即 `npm run verify`
 *    启动者的固定版本），否则回退 PATH 上的 npm；不通过 npx 临时下载任何工具。
 *    有限超时（默认 600s，可用 --step-timeout-ms 或 SHIPLOOP_VERIFY_STEP_TIMEOUT_MS
 *    覆盖，供隔离夹具验收使用）；超时按进程组 SIGKILL 收尾，不遗留孙进程。
 *    退出码非 0、信号退出、超时或无法启动一律算失败；失败即停止。
 *    只有全部步骤退出码为 0，verify 才返回 0。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建；
 * 不调用模型，不修改受检目录中的任何文件。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type VerifyStep = {
  /** 展示与诊断用的命令名（输出中可核对的检查命令）。 */
  readonly label: string;
  readonly npmArgs: readonly string[];
  /** 根 package.json 中必须声明的脚本名（缺失即预检失败，不跳过该检查）。 */
  readonly requiredScript: string;
};

export const VERIFY_STEPS: readonly VerifyStep[] = [
  { label: 'npm test', npmArgs: ['test'], requiredScript: 'test' },
  { label: 'npm run typecheck', npmArgs: ['run', 'typecheck'], requiredScript: 'typecheck' },
  { label: 'npm run build', npmArgs: ['run', 'build'], requiredScript: 'build' },
];

const DEFAULT_STEP_TIMEOUT_MS = 600_000;
/** 超时 SIGKILL 后的宽限期：close 事件仍未到达时强制收尾，避免 verify 自身悬挂。 */
const KILL_GRACE_MS = 5_000;
const STEP_TIMEOUT_ENV = 'SHIPLOOP_VERIFY_STEP_TIMEOUT_MS';

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

type PrecheckResult = { ok: true; lockDescription: string } | { ok: false; reason: string };

/** 锁文件与脚本预检：任何一项不满足都 fail-closed，不运行后续步骤。 */
function precheck(root: string): PrecheckResult {
  const manifestPath = resolve(root, 'package.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `缺少根 package.json：${manifestPath}` };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: `package.json 无法解析：${(error as Error).message}` };
  }

  const scripts =
    manifest.scripts !== null && typeof manifest.scripts === 'object'
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const missingScripts = VERIFY_STEPS.filter(
    (step) => typeof scripts[step.requiredScript] !== 'string',
  ).map((step) => step.requiredScript);
  if (missingScripts.length > 0) {
    return {
      ok: false,
      reason:
        `根 package.json 缺少必需脚本：${missingScripts.join(', ')}；` +
        '检查不得跳过，请先补齐脚本再运行 verify',
    };
  }

  const lockPath = resolve(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    return {
      ok: false,
      reason:
        `缺少 package-lock.json（${lockPath}）；锁文件缺失不会被已安装的 node_modules 掩盖，` +
        '请先重新生成并提交锁文件',
    };
  }
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: `package-lock.json 无法解析：${(error as Error).message}` };
  }
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 1) {
    return { ok: false, reason: 'package-lock.json 缺少有效的数字 lockfileVersion' };
  }
  if (typeof manifest.name === 'string' && lock.name !== manifest.name) {
    return {
      ok: false,
      reason: `锁文件 name "${String(lock.name)}" 与根 package.json "${manifest.name}" 不一致`,
    };
  }
  if (typeof manifest.version === 'string' && lock.version !== manifest.version) {
    return {
      ok: false,
      reason: `锁文件 version "${String(lock.version)}" 与根 package.json "${manifest.version}" 不一致`,
    };
  }
  return {
    ok: true,
    lockDescription:
      `lockfileVersion ${String(lock.lockfileVersion)}, name "${String(lock.name)}", ` +
      `version "${String(lock.version)}"`,
  };
}

type NpmInvocation = {
  command: string;
  argsPrefix: string[];
  description: string;
};

/** 优先使用 npm_execpath（启动 verify 的固定 npm 自身）；否则回退 PATH 上的 npm。 */
function resolveNpm(): NpmInvocation {
  const execPath = process.env.npm_execpath;
  if (typeof execPath === 'string' && execPath.endsWith('.js') && existsSync(execPath)) {
    return {
      command: process.execPath,
      argsPrefix: [execPath],
      description: `npm via npm_execpath (${execPath})`,
    };
  }
  return { command: 'npm', argsPrefix: [], description: 'npm from PATH' };
}

type StepOutcome =
  | { kind: 'exit'; code: number; durationMs: number }
  | { kind: 'signal'; signal: string; durationMs: number }
  | { kind: 'timeout'; timeoutMs: number; durationMs: number }
  | { kind: 'spawn-error'; message: string; durationMs: number };

function describeOutcome(outcome: StepOutcome): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  switch (outcome.kind) {
    case 'exit':
      return `exit code ${outcome.code} after ${seconds}s`;
    case 'signal':
      return `terminated by signal ${outcome.signal} after ${seconds}s`;
    case 'timeout':
      return `timed out after ${outcome.timeoutMs}ms (process group SIGKILLed)`;
    case 'spawn-error':
      return `failed to start: ${outcome.message}`;
  }
}

/**
 * 以独立进程组运行单步子命令（detached: true），有限超时；
 * 超时对整个进程组 SIGKILL（含 npm 之下的孙进程），并宽限收尾。
 */
function runStepCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<StepOutcome> {
  return new Promise((resolveOutcome) => {
    const started = Date.now();
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: 'inherit',
      detached: true,
    });
    let settled = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const settle = (outcome: StepOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      resolveOutcome(outcome);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          // 负 pid 杀掉整个进程组，完成孙进程收尾。
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 子进程已退出，无需处理。
          }
        }
      }
      graceTimer = setTimeout(() => {
        settle({ kind: 'timeout', timeoutMs, durationMs: Date.now() - started });
      }, KILL_GRACE_MS);
      graceTimer.unref();
    }, timeoutMs);

    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started;
      if (timedOut) {
        settle({ kind: 'timeout', timeoutMs, durationMs });
        return;
      }
      if (spawnError !== null) {
        settle({ kind: 'spawn-error', message: spawnError.message, durationMs });
        return;
      }
      if (signal !== null) {
        settle({ kind: 'signal', signal, durationMs });
        return;
      }
      settle({ kind: 'exit', code: code ?? 1, durationMs });
    });
  });
}

/** 运行完整 verify 编排，返回进程退出码（0＝全部步骤退出 0；否则 1）。 */
export async function runVerify(
  rootInput: string,
  options: { stepTimeoutMs?: number } = {},
): Promise<number> {
  const root = resolve(rootInput);
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const total = VERIFY_STEPS.length;
  const allLabels = VERIFY_STEPS.map((step) => step.label).join(', ');

  out(`verify: root ${root}`);
  out('verify: 开发工程检查编排（非 ShipLoop 业务 Verifier，不含 accept:p01 验收）');
  out(`verify: step timeout ${stepTimeoutMs}ms (finite; non-zero exit / signal / timeout all fail)`);

  const pre = precheck(root);
  if (!pre.ok) {
    err(`verify: FAIL precheck: ${pre.reason}`);
    out(`verify: NOT RUN (未执行，不标记为通过): ${allLabels}`);
    return 1;
  }
  out(`verify: precheck package-lock.json OK (${pre.lockDescription})`);

  const npm = resolveNpm();
  out(`verify: using ${npm.description}`);

  for (let index = 0; index < total; index += 1) {
    const step = VERIFY_STEPS[index] as VerifyStep;
    const position = `[${index + 1}/${total}]`;
    out(`verify: ${position} RUN ${step.label}`);
    const outcome = await runStepCommand(
      npm.command,
      [...npm.argsPrefix, ...step.npmArgs],
      root,
      stepTimeoutMs,
    );
    if (outcome.kind === 'exit' && outcome.code === 0) {
      out(`verify: ${position} EXIT 0 ${step.label} (${(outcome.durationMs / 1000).toFixed(1)}s)`);
      continue;
    }
    err(`verify: ${position} FAIL ${step.label} -> ${describeOutcome(outcome)}`);
    const remaining = VERIFY_STEPS.slice(index + 1).map((entry) => entry.label);
    if (remaining.length > 0) {
      out(`verify: NOT RUN (未执行，不标记为通过): ${remaining.join(', ')}`);
    }
    err(`verify: FAIL ${index}/${total} checks exited 0; first failing step: ${step.label}`);
    return 1;
  }
  out(`verify: PASS ${total}/${total} checks exited 0`);
  return 0;
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : null;
}

function printUsage(): void {
  out(
    'usage: node scripts/verify.ts [--root <dir>] [--step-timeout-ms <ms>]\n' +
      `  --root <dir>           受检工作区根目录（默认：本脚本所在仓库）\n` +
      `  --step-timeout-ms <ms> 单步有限超时（默认 ${DEFAULT_STEP_TIMEOUT_MS}；亦可经 ${STEP_TIMEOUT_ENV} 设置，供隔离夹具验收）`,
  );
}

async function main(argv: string[]): Promise<number> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  let root = resolve(scriptDir, '..');
  let stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS;

  const envTimeout = process.env[STEP_TIMEOUT_ENV];
  if (typeof envTimeout === 'string' && envTimeout.length > 0) {
    const parsed = parsePositiveInt(envTimeout);
    if (parsed === null) {
      err(`verify: FAIL ${STEP_TIMEOUT_ENV}="${envTimeout}" 不是正整数毫秒值`);
      return 1;
    }
    stepTimeoutMs = parsed;
  }

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--root' && i + 1 < rest.length) {
      root = resolve(rest[i + 1] as string);
      i += 1;
    } else if (arg === '--step-timeout-ms' && i + 1 < rest.length) {
      const parsed = parsePositiveInt(rest[i + 1] as string);
      if (parsed === null) {
        err(`verify: FAIL --step-timeout-ms "${rest[i + 1] as string}" 不是正整数毫秒值`);
        return 1;
      }
      stepTimeoutMs = parsed;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return 0;
    } else {
      err(`verify: unknown argument "${arg}"`);
      printUsage();
      return 1;
    }
  }

  return runVerify(root, { stepTimeoutMs });
}

const invokedPath = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      err(`verify: FAIL unexpected orchestration error: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
