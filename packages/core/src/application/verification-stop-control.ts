/**
 * P03-9 / F-003：Verifier 停止登记与有界停止请求。
 *
 * 不变量：
 * - 每个验证批次只登记一次；`signal` 直接传给既有 CommandProcess.start 的
 *   AbortSignal 参数，因此宽限、身份核验、必要升级与整组缺席确认仍由
 *   CommandProcess 的单一有界停止路径承担；
 * - 登记/记录/完成全部同步，不 spawn、不杀进程、不写业务表；
 * - 停止请求先中止匹配批次，再在有界预算内等待登记完成；超时/未观察不得
 *   折算为 stopped，必须返回 unconfirmed 与记录缺口；
 * - 未启动任何受控进程的批次安全返回 not_started；这不冒充“已杀死进程”。
 */
import type {
  VerificationCheckStopRecord,
  VerificationStopControl,
  VerificationStopEvidence,
  VerificationStopKey,
  VerificationStopRegistration,
} from '../ports/verification-stop.js';

interface ActiveRegistration {
  readonly key: VerificationStopKey;
  readonly controller: AbortController;
  readonly checks: VerificationCheckStopRecord[];
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  completed: boolean;
  timedOut: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function summary(entry: ActiveRegistration): VerificationStopEvidence {
  const launched = entry.checks.filter(check => check.launched);
  const gaps = new Set<string>();
  for (const check of entry.checks) for (const gap of check.gaps) gaps.add(gap);
  let state: VerificationStopEvidence['state'];
  let stopConfirmed: boolean;
  if (entry.timedOut) {
    state = 'unconfirmed';
    stopConfirmed = false;
    gaps.add('verifier_stop_wait_timeout');
  } else if (launched.length === 0) {
    state = 'not_started';
    stopConfirmed = true;
  } else if (launched.every(check => check.stopConfirmed)) {
    state = 'stopped';
    stopConfirmed = true;
  } else {
    state = 'unconfirmed';
    stopConfirmed = false;
    gaps.add('verifier_stop_unconfirmed');
  }
  if (entry.checks.some(check => check.launched && check.reason === 'stop_unconfirmed')) gaps.add('verifier_stop_unconfirmed');
  return {
    key: entry.key,
    state,
    stopConfirmed,
    checks: entry.checks.map(record => ({ ...record, gaps: [...record.gaps] })),
    gaps: [...gaps],
  };
}

export function createVerificationStopControl(options: { readonly waitMs?: number } = {}): VerificationStopControl {
  const waitMs = options.waitMs ?? 10_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 60_000) {
    throw new TypeError('VerificationStopControl.waitMs must be an integer in 1..60000');
  }
  const active = new Set<ActiveRegistration>();
  // Cancelled targets are remembered for this trusted Host process so a verifier
  // start that races the cancel does not launch a new controlled process after
  // the stop operation has already settled. Bounded FIFO; no bus/process ownership.
  const cancelledTargets = new Set<string>();
  const targetKey = (projectId: string, kind: 'run' | 'batch', id: string) => `${projectId}|${kind}|${id}`;
  function rememberCancelled(key: string): void {
    cancelledTargets.delete(key);
    cancelledTargets.add(key);
    while (cancelledTargets.size > 512) {
      const oldest = cancelledTargets.values().next().value;
      if (oldest === undefined) break;
      cancelledTargets.delete(oldest);
    }
  }
  return {
    begin(key) {
      let resolveSettled!: () => void;
      const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
      const entry: ActiveRegistration = {
        key: { ...key },
        controller: new AbortController(),
        checks: [],
        settled,
        resolveSettled,
        completed: false,
        timedOut: false,
      };
      active.add(entry);
      if (cancelledTargets.has(targetKey(key.projectId, 'run', key.runId))
        || cancelledTargets.has(targetKey(key.projectId, 'batch', key.batchId))) {
        entry.controller.abort('execution_stop');
      }
      const registration: VerificationStopRegistration = {
        signal: entry.controller.signal,
        record(record) {
          if (entry.completed) return;
          entry.checks.push({
            checkKey: record.checkKey,
            launched: record.launched,
            stopConfirmed: record.stopConfirmed,
            exitCode: record.exitCode,
            signal: record.signal,
            forced: record.forced,
            reason: record.reason,
            gaps: [...record.gaps],
          });
        },
        complete() {
          if (entry.completed) return;
          entry.completed = true;
          entry.resolveSettled();
          active.delete(entry);
        },
      };
      return registration;
    },
    async stop(input) {
      if (input === null || typeof input !== 'object'
        || typeof input.projectId !== 'string' || typeof input.targetId !== 'string'
        || (input.targetKind !== 'run' && input.targetKind !== 'batch')) {
        throw new TypeError('VerificationStopControl.stop input is invalid');
      }
      rememberCancelled(targetKey(input.projectId, input.targetKind, input.targetId));
      const matching = [...active].filter(entry => entry.key.projectId === input.projectId
        && (input.targetKind === 'run' ? entry.key.runId === input.targetId : entry.key.batchId === input.targetId));
      if (matching.length === 0) return [];
      for (const entry of matching) entry.controller.abort('execution_stop');
      await Promise.all(matching.map(async entry => {
        const outcome = await Promise.race([
          entry.settled.then(() => 'settled' as const),
          delay(waitMs).then(() => 'timeout' as const),
        ]);
        if (outcome === 'timeout' && !entry.completed) {
          // Keep the registration until the executor reports completion so a late
          // record is not lost, but report uncertainty now and never claim stopped.
          entry.timedOut = true;
        }
      }));
      const evidence = matching.map(summary);
      // A timed out entry stays registered for its late completion; already settled
      // entries were removed by complete().
      for (const entry of matching) {
        if (!entry.timedOut) active.delete(entry);
      }
      return evidence;
    },
  };
}
