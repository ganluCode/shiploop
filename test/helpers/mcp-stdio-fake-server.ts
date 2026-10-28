import { fileURLToPath } from 'node:url';
import { until } from './process-matrix.ts';
import { existsSync } from 'node:fs';

const SCRIPT = fileURLToPath(new URL('./mcp-stdio-fake-server.mjs', import.meta.url));
export interface FakeMcpServerOptions {
  readonly mode?: 'normal' | 'hang_initialize' | 'hang_list' | 'invalid_protocol' | 'missing_tools_capability'
    | 'exit_on_start' | 'exit_initialize' | 'stdout_noise' | 'large_output' | 'list_error';
  readonly callMode?: 'normal' | 'error' | 'hang' | 'exit' | 'is_error' | 'large_output';
  readonly spawnChild?: boolean;
  readonly ignoreTerminate?: boolean;
  readonly stderrBytes?: number;
  /** Synthetic test value is resolved only from the child environment. */
  readonly echoEnvironmentKey?: string;
  readonly toolName?: string;
  readonly discoveryFile?: string;
  readonly pagesFile?: string;
  readonly instructions?: string;
  readonly pidFile?: string;
  readonly readyFile?: string;
  readonly initializeFile?: string;
  readonly toolsListFile?: string;
  readonly childPidFile?: string;
  readonly exitFile?: string;
  readonly holdInitialize?: boolean;
  readonly parentExitAfterInitializeMs?: number;
}
/** Explicit no-secret local executable/argv; fixture modes never install or contact anything. */
export function createFakeMcpServerCommand(root: string, options: FakeMcpServerOptions = {}): {
  readonly executable: string; readonly argv: readonly string[];
} {
  return { executable: process.execPath, argv: [SCRIPT, JSON.stringify({ root, ...options })] };
}
export async function waitForFakeMcpFile(path: string, timeoutMs = 2_000): Promise<void> {
  await until(() => existsSync(path), 'Fake MCP file barrier', timeoutMs);
}
