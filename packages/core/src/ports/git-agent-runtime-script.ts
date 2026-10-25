/** P05-8 / F-003 deterministic GitAgent script contract. */
import { GIT_AGENT_RUNTIME_SCHEMA_VERSION } from './git-agent-runtime.js';
import { rejectUnknownKeys, requirePlainObject, validateSha256Digest, validationError, type ValidationContext } from './validation.js';

export const GIT_AGENT_RUNTIME_SCRIPT_SCHEMA_VERSION = 1 as const;
export const GIT_AGENT_RUNTIME_SCRIPT_MAX_STEPS = 128;
export const GIT_AGENT_RUNTIME_SCRIPT_MAX_BODY_BYTES = 262_144;

export type GitAgentRuntimeScriptStep =
  | { readonly op: 'write_file'; readonly path: string; readonly content: string }
  | { readonly op: 'no_change' }
  | { readonly op: 'verification'; readonly outputDigest: string | null; readonly exitCode: number | null }
  | { readonly op: 'usage'; readonly consumedTokens: number; readonly runtimeMs: number }
  | { readonly op: 'fail'; readonly classification: 'invalid' | 'out_of_scope' | 'runtime'; readonly code: string }
  | { readonly op: 'process_exit'; readonly code: string }
  | { readonly op: 'await_gate'; readonly name: string };

export interface GitAgentRuntimeScript {
  readonly schemaVersion: typeof GIT_AGENT_RUNTIME_SCRIPT_SCHEMA_VERSION;
  readonly steps: readonly GitAgentRuntimeScriptStep[];
  readonly stopUnconfirmed?: true;
}

const CONTEXT: ValidationContext = { operation: 'GitAgentRuntimeScript.validate' };
const PATH = /^[^/\\\u0000]+(?:\/[^/\\\u0000]+)*$/;
const TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const GATE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw validationError(CONTEXT, field, 'invalid_token');
  return value;
}
function relativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !PATH.test(value)
    || value.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)) {
    throw validationError(CONTEXT, field, 'invalid_relative_path');
  }
  return value;
}
function gate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GATE.test(value)) throw validationError(CONTEXT, field, 'invalid_gate');
  return value;
}
function cloneFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) cloneFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function validateGitAgentRuntimeScript(value: unknown): GitAgentRuntimeScript {
  const raw = requirePlainObject(value, CONTEXT, 'script');
  rejectUnknownKeys(raw, ['schemaVersion', 'steps', 'stopUnconfirmed'], CONTEXT, 'script');
  if (raw.schemaVersion !== GIT_AGENT_RUNTIME_SCRIPT_SCHEMA_VERSION) throw validationError(CONTEXT, 'script.schemaVersion', 'unsupported_schema_version');
  if (!Array.isArray(raw.steps) || raw.steps.length > GIT_AGENT_RUNTIME_SCRIPT_MAX_STEPS) throw validationError(CONTEXT, 'script.steps', 'invalid_steps');
  const steps = raw.steps.map((value, index): GitAgentRuntimeScriptStep => {
    const field = `script.steps[${index}]`;
    const step = requirePlainObject(value, CONTEXT, field);
    if (typeof step.op !== 'string') throw validationError(CONTEXT, `${field}.op`, 'invalid_operation');
    switch (step.op) {
      case 'write_file': {
        rejectUnknownKeys(step, ['op', 'path', 'content'], CONTEXT, field);
        const content = step.content;
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > GIT_AGENT_RUNTIME_SCRIPT_MAX_BODY_BYTES) throw validationError(CONTEXT, `${field}.content`, 'body_too_large');
        return { op: 'write_file', path: relativePath(step.path, `${field}.path`), content };
      }
      case 'no_change':
        rejectUnknownKeys(step, ['op'], CONTEXT, field);
        return { op: 'no_change' };
      case 'verification': {
        rejectUnknownKeys(step, ['op', 'outputDigest', 'exitCode'], CONTEXT, field);
        const exitCode = step.exitCode;
        if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)) throw validationError(CONTEXT, `${field}.exitCode`, 'invalid_exit_code');
        return { op: 'verification', outputDigest: step.outputDigest === null ? null : validateSha256Digest(step.outputDigest, CONTEXT, `${field}.outputDigest`), exitCode: exitCode as number | null };
      }
      case 'usage': {
        rejectUnknownKeys(step, ['op', 'consumedTokens', 'runtimeMs'], CONTEXT, field);
        for (const name of ['consumedTokens', 'runtimeMs'] as const) {
          const number = step[name];
          if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw validationError(CONTEXT, `${field}.${name}`, 'invalid_usage');
        }
        return { op: 'usage', consumedTokens: step.consumedTokens as number, runtimeMs: step.runtimeMs as number };
      }
      case 'fail':
        rejectUnknownKeys(step, ['op', 'classification', 'code'], CONTEXT, field);
        if (step.classification !== 'invalid' && step.classification !== 'out_of_scope' && step.classification !== 'runtime') throw validationError(CONTEXT, `${field}.classification`, 'invalid_failure_class');
        return { op: 'fail', classification: step.classification, code: token(step.code, `${field}.code`) };
      case 'process_exit':
        rejectUnknownKeys(step, ['op', 'code'], CONTEXT, field);
        return { op: 'process_exit', code: token(step.code, `${field}.code`) };
      case 'await_gate':
        rejectUnknownKeys(step, ['op', 'name'], CONTEXT, field);
        return { op: 'await_gate', name: gate(step.name, `${field}.name`) };
      default:
        throw validationError(CONTEXT, `${field}.op`, 'unknown_operation');
    }
  });
  return cloneFreeze({ schemaVersion: GIT_AGENT_RUNTIME_SCRIPT_SCHEMA_VERSION, steps, ...(raw.stopUnconfirmed === true ? { stopUnconfirmed: true as const } : {}) });
}

export function validateGitAgentRuntimeRequestShape(value: unknown): void {
  const raw = requirePlainObject(value, CONTEXT, 'request');
  if (raw.schemaVersion !== GIT_AGENT_RUNTIME_SCHEMA_VERSION) throw validationError(CONTEXT, 'request.schemaVersion', 'unsupported_schema_version');
}
