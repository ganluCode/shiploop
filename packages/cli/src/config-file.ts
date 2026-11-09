import { openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { extname } from 'node:path';
import { parseDocument } from 'yaml';
import { AppCliParseError, parseAppInputJson } from './app/args.js';
import type { AppCliCommandId } from './app/args.js';

const MAX_BYTES = 1_048_576;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize file shorthand only; Core and persisted strategy identities stay explicit. */
function normalizeStrategy(value: unknown): void {
  if (!record(value)) return;
  if (value.provider === undefined && typeof value.model === 'string' && value.model.includes('/')) {
    const separator = value.model.indexOf('/');
    const provider = value.model.slice(0, separator), model = value.model.slice(separator + 1);
    if (!provider || !model || /\s/.test(provider) || /\s/.test(model)
      || model.startsWith('/') || model.endsWith('/') || model.includes('//')) throw new Error('invalid_model_shorthand');
    value.provider = provider;
    value.model = model;
  }
  // An explicit provider makes model an opaque ID (e.g. an OpenRouter org/model).
  if (value.runtime === 'pi' && value.credentialRef === undefined
    && typeof value.provider === 'string' && value.provider.length > 0) {
    value.credentialRef = `credential://pi/${value.provider}`;
  }
}

function normalizeConfigStrategies(payload: Record<string, unknown>): void {
  const configured = (value: unknown) => {
    normalizeStrategy(value);
    if (record(value) && Array.isArray(value.fallbacks)) value.fallbacks.forEach(normalizeStrategy);
  };
  if (record(payload.strategies)) {
    configured(payload.strategies.defaultStrategy);
    for (const key of ['modelMap', 'purposeStrategies', 'agentOverrides']) {
      const entries = payload.strategies[key];
      if (record(entries)) Object.values(entries).forEach(configured);
    }
  }
  if (record(payload.policies) && record(payload.policies.featureAutoFix)) {
    normalizeStrategy(payload.policies.featureAutoFix.strategy);
  }
}

function rejectSecretFields(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('config_depth_limit');
  if (Array.isArray(value)) { value.forEach(item => rejectSecretFields(item, depth + 1)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?key|password|secret|token|access[_-]?token|refresh[_-]?token|authorization|credentials?)$/i.test(key)) {
      throw new Error('config_secret_field');
    }
    rejectSecretFields(item, depth + 1);
  }
}

/** YAML is only a syntax front end; all payload checks still use the existing JSON/Core schema. */
export function readSettingsFile(file: string, commandId: AppCliCommandId, json: boolean): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('config_file_limit');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, size);
      if (!n) break;
      size += n;
    }
    if (size > MAX_BYTES) throw new Error('config_file_limit');
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    if (['.yaml', '.yml'].includes(extname(file).toLowerCase())) {
      const document = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, strict: true, merge: false });
      if (document.errors.length || document.warnings.length || document.directives?.yaml.version !== '1.2') throw new Error('invalid_yaml');
      text = JSON.stringify(document.toJS({ maxAliasCount: 0, mapAsMap: false }));
    }
    const parsed = parseAppInputJson(text, { commandId, json });
    rejectSecretFields(parsed);
    normalizeConfigStrategies(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof AppCliParseError) throw error;
    throw new AppCliParseError('invalid_input', 'invalid_input_file', { command: 'config', commandId, json }, 'input');
  } finally { if (fd !== undefined) closeSync(fd); }
}
