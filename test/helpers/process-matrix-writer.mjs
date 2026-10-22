/** Controlled three-generation writer; no detached descendants or external resources. */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [root, mode, role = 'parent'] = process.argv.slice(2);
const next = role === 'parent' ? 'child' : role === 'child' ? 'grandchild' : null;
if (mode === 'stubborn') process.on('SIGTERM', () => {
  appendFileSync(join(root, `${role}.signals`), 'SIGTERM\n');
});
const child = next === null ? undefined : spawn(process.execPath,
  [fileURLToPath(import.meta.url), root, mode, next], { stdio: 'ignore' });
child?.unref();
writeFileSync(join(root, `${role}.json`), JSON.stringify({ pid: process.pid, parentPid: process.ppid, role }));
let sequence = 0;
const timer = setInterval(() => {
  appendFileSync(join(root, `${role}.writes`), `${++sequence}\n`);
  if (existsSync(join(root, 'release')) || (role === 'parent' && existsSync(join(root, 'exit-parent')))) {
    clearInterval(timer);
  }
}, 10);
