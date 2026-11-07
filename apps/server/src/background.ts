/**
 * Background work that must finish after the HTTP response (chain transactions, voyages).
 * On Vercel, vercel.ts hands drain() to waitUntil so the instance is not frozen mid-transaction.
 */
const tasks = new Set<Promise<unknown>>();
const busyChecks: (() => boolean)[] = [];

/** Track a promise until it settles. Errors are the caller's business; they never reject drain(). */
export function track<T>(p: Promise<T>): Promise<T> {
  const t = p.catch(() => undefined);
  tasks.add(t);
  void t.finally(() => tasks.delete(t));
  return p;
}

/** Register a "still working" check for work that isn't a single promise (e.g. a running voyage loop). */
export function addBusyCheck(fn: () => boolean): void {
  busyChecks.push(fn);
}

export const hasWork = (): boolean => tasks.size > 0 || busyChecks.some((f) => f());

/** Resolves when no tracked work is left, or at the deadline. */
export async function drain(maxMs = 290_000): Promise<void> {
  const stopAt = Date.now() + maxMs;
  while (hasWork() && Date.now() < stopAt) {
    if (tasks.size) await Promise.race([Promise.allSettled([...tasks]), new Promise((r) => setTimeout(r, 500))]);
    else await new Promise((r) => setTimeout(r, 500));
  }
}
