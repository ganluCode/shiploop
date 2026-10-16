import { execFileSync } from 'node:child_process';

type ProcessIdentity = { pid: number; ppid: number; identity: string; zombie: boolean };

function processTable(): ProcessIdentity[] {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart=,args='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024,
  });
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), identity: `${match[4]} ${match[5]}`, zombie: match[3]!.startsWith('Z') }];
  });
}

/** Acceptance-only ownership tracking: ancestry first, then PID + start time + argv revalidation. */
export class OwnedProcessTree {
  private readonly owned = new Map<number, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanFailed = false;
  private readonly rootPid: number | undefined;

  constructor(rootPid: number | undefined) {
    this.rootPid = rootPid;
    this.capture();
    this.timer = setInterval(() => this.capture(), 200);
    this.timer.unref();
  }

  private capture(): ProcessIdentity[] {
    try {
      const rows = processTable();
      const root = rows.find((row) => row.pid === this.rootPid);
      if (root !== undefined && !this.owned.has(root.pid)) this.owned.set(root.pid, root.identity);
      let added = true;
      while (added) {
        added = false;
        for (const row of rows) {
          const parent = rows.find((item) => item.pid === row.ppid);
          if (parent !== undefined && this.owned.get(parent.pid) === parent.identity && !this.owned.has(row.pid)) {
            this.owned.set(row.pid, row.identity);
            added = true;
          }
        }
      }
      return rows;
    } catch {
      this.scanFailed = true;
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
      if (remaining.length === 0) return !this.scanFailed;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return false;
  }
}
