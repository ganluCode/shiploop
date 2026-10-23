import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

type ProcessIdentity = { pid: number; ppid: number; identity: string; zombie: boolean };

function processTable(): ProcessIdentity[] {
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=,args='], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024,
  });
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    // Do not retain slices/ropes backed by the entire ps snapshot in long-lived maps.
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]),
      identity: createHash('sha256').update(match[4]!).update('\0').update(match[5]!).digest('hex'),
      zombie: match[3]!.startsWith('Z') }];
  });
}

/** Acceptance-only ownership tracking: ancestry first, then PID + start time + argv revalidation. */
export class OwnedProcessTree {
  private readonly owned = new Map<number, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanFailed = false;
  private lastScanError = 'none';
  private lastRemaining: number[] = [];
  private readonly rootPid: number | undefined;
  private rootCaptured = false;

  constructor(rootPid: number | undefined) {
    this.rootPid = rootPid;
    this.capture();
    this.timer = setInterval(() => this.capture(), 200);
    this.timer.unref();
  }

  private capture(): ProcessIdentity[] {
    const initial = !this.rootCaptured;
    this.rootCaptured = true;
    try {
      const rows = processTable();
      const byPid = new Map(rows.map(row => [row.pid, row]));
      const children = new Map<number, ProcessIdentity[]>();
      for (const row of rows) {
        const siblings = children.get(row.ppid) ?? [];
        siblings.push(row);
        children.set(row.ppid, siblings);
      }
      // Prune only after a successful snapshot. Live proven orphans stay tracked.
      for (const [pid, identity] of this.owned) {
        const row = byPid.get(pid);
        if (!row || row.zombie || row.identity !== identity) this.owned.delete(pid);
      }
      // Never reacquire the root after exit: the same PID may now belong to another app.
      if (initial) {
        const root = this.rootPid === undefined ? undefined : byPid.get(this.rootPid);
        if (root && !root.zombie) this.owned.set(root.pid, root.identity);
      }
      const pending = [...this.owned.keys()];
      for (let index = 0; index < pending.length; index++) {
        for (const child of children.get(pending[index]!) ?? []) {
          if (!child.zombie && !this.owned.has(child.pid)) {
            this.owned.set(child.pid, child.identity);
            pending.push(child.pid);
          }
        }
      }
      return rows;
    } catch (error) {
      this.scanFailed = true;
      this.lastScanError = String((error as NodeJS.ErrnoException).code ?? 'scan_error');
      return [];
    }
  }

  kill(): void {
    for (const row of this.capture().reverse()) {
      if (row.pid > 1 && !row.zombie && this.owned.get(row.pid) === row.identity) {
        try { process.kill(row.pid, 'SIGKILL'); } catch { /* Verified below. */ }
      }
    }
  }

  async finish(cleanup: boolean): Promise<boolean> {
    clearInterval(this.timer);
    if (!cleanup) return true;
    this.kill();
    const deadline = Date.now() + 2000;
    do {
      const remaining = this.capture().filter((row) => !row.zombie && this.owned.get(row.pid) === row.identity);
      this.lastRemaining = remaining.map((row) => row.pid);
      if (remaining.length === 0) return !this.scanFailed;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return false;
  }

  diagnostic(): string {
    return `ownership_scan_failed=${this.scanFailed}; last_scan_error=${this.lastScanError}; remaining_owned_pids=${this.lastRemaining.join(',')}`;
  }
}
