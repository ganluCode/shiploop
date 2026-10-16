import { readFileSync } from 'node:fs';

/** File creation precedes writeFileSync's payload; existence alone is not readiness. */
export function readPublishedPid(path: string): number | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}
