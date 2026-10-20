/** Finite observation only; process escalation and resource ownership stay in Core. */
export const PI_ABORT_WAIT_MS = 1_000;
export const PI_STOP_WAIT_MS = 1_000;

export async function observePiWithin<T>(promise: Promise<T>, ms: number): Promise<
  { readonly status: 'fulfilled'; readonly value: T } | { readonly status: 'rejected' } | { readonly status: 'timeout' }
> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ status: 'fulfilled' as const, value }), () => ({ status: 'rejected' as const })),
      new Promise<{ status: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
