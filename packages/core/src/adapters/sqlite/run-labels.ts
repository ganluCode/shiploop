import { StorageError } from '../../ports/errors.js';
import { normalizeLabels } from '../../ports/validation.js';

/** Persistent labels must already be canonical; never repair corrupt execution metadata on read. */
export function parseStoredRunLabels(text: string, operation: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('not an array');
    const normalized = normalizeLabels(value, { operation, entity: { type: 'run' } });
    if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('non-canonical labels');
    return normalized;
  } catch (cause) {
    throw new StorageError('corrupt', operation, 'Run 标签 JSON 或规范化形态损坏', {
      entity: { type: 'run' }, details: { reason: 'invalid_run_labels' }, cause,
    });
  }
}
