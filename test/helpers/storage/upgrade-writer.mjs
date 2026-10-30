import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (process.argv[3] === 'child') {
  appendFileSync(join(root, 'legacy-writes'), 'ready\n');
  const timer = setInterval(() => appendFileSync(join(root, 'legacy-writes'), 'write\n'), 20);
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
  process.send({ type: 'ready' });
  process.disconnect();
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', () => { child.unref(); process.send({ groupId: process.pid }); });
  process.on('message', message => { if (message.type === 'exit-parent') process.exit(0); });
}
