/** Stable public identity shared by native Pi notifications and MCP audit events. */
import { createHash } from 'node:crypto';

export function piEventToken(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    ? value : `pi-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}
