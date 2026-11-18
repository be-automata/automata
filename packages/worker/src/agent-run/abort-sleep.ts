/**
 * The worker's two abortable sleeps (#656 simplify): the only two, so every
 * wait in the agent-run plane reacts to a cancel through an abort listener.
 * No imports: any module may use them, whatever a test mocks.
 */

/** Resolves after `ms`, or early and WITHOUT rejecting when `signal` aborts (a wait that just ends). */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Abortable sleep for the deferral wait: resolves after `ms`, rejects with AbortError on the run's cancel. */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Declared BEFORE abort(): an already-aborted signal calls abort() before
    // any timer exists (a `const` here would be a temporal-dead-zone error, not
    // an AbortError — caught by the sleepAbortable unit test).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      const err = new Error("admission wait aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
