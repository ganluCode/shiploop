import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runBoundedProcess } from '../scripts/acceptance/p02-accept.ts';
import { runBounded } from '../scripts/acceptance/clean-snapshot-replay.ts';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('acceptance timeout owns detached descendants', () => {
  for (const runner of ['controller', 'snapshot']) {
    it(`${runner}: timeout terminates a detached grandchild but leaves unrelated processes alone`, async () => {
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      let descendant: number | undefined;
      try {
        const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); c.unref(); console.log(c.pid); setInterval(()=>{},1000);`;
        const result = runner === 'controller'
          ? await runBoundedProcess(process.execPath, ['-e', script], { cwd: process.cwd(), timeoutMs: 1200, maxOutputBytes: 4096 })
          : await runBounded(process.execPath, ['-e', script], process.cwd(), 1200, process.env);
        descendant = Number(result.stdout.trim());
        expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
        expect(result.kind).toBe('timeout');
        expect(alive(descendant)).toBe(false);
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        if (descendant !== undefined && Number.isSafeInteger(descendant) && descendant > 1) {
          try { process.kill(descendant, 'SIGKILL'); } catch { /* Already gone. */ }
        }
        unrelated.kill('SIGKILL');
        await new Promise<void>((resolve) => unrelated.once('close', () => resolve()));
      }
    });
  }
});
