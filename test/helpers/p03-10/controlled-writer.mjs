// A fixture-owned parent and writer. No OS process outside this launch is signalled.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, mode] = process.argv.slice(2);
process.on('SIGTERM', () => {});
if (mode === 'child') {
  appendFileSync(join(directory, 'heartbeat'), 'x');
  setInterval(() => appendFileSync(join(directory, 'heartbeat'), 'x'), 20);
} else {
  const child = spawn(process.execPath, [import.meta.filename, directory, 'child'], { stdio: 'ignore' });
  const timer = setInterval(() => {
    if (!existsSync(join(directory, 'heartbeat'))) return;
    if (!existsSync(join(directory, 'ready.json'))) {
      const tree = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', `${process.pid},${child.pid}`], { encoding: 'utf8' });
      writeFileSync(join(directory, 'ready.json'), JSON.stringify({ parent: process.pid, child: child.pid, tree }));
      if (mode === 'orphan') { clearInterval(timer); child.unref(); return; }
    }
    if (existsSync(join(directory, 'release'))) {
      clearInterval(timer);
      child.once('exit', () => {
        console.log('SHIPLOOP_NODE_CHECK_RESULT=' + JSON.stringify({ schemaVersion: 1, protocol: 'shiploop.node-check', collected: true, testCount: 1, targets: ['chain'] }));
        process.exitCode = mode === 'fail' ? 1 : 0;
      });
      child.kill('SIGKILL');
    }
  }, 20);
}
