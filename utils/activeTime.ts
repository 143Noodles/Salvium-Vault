/** Elapsed foreground time. Visibility events account for freezes with no timer ticks. */
export function createActiveClock(pauseOffline = false) {
  let elapsed = 0;
  let observedAt = performance.now();
  const isPaused = () => (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
    (pauseOffline && typeof navigator !== 'undefined' && navigator.onLine === false);
  let paused = isPaused();
  const now = () => {
    const at = performance.now();
    if (!paused) elapsed += Math.max(0, at - observedAt);
    observedAt = at;
    paused = isPaused();
    return elapsed;
  };
  document.addEventListener('visibilitychange', now);
  if (pauseOffline) {
    window.addEventListener('offline', now);
    window.addEventListener('online', now);
  }
  return {
    now,
    dispose() {
      document.removeEventListener('visibilitychange', now);
      if (pauseOffline) {
        window.removeEventListener('offline', now);
        window.removeEventListener('online', now);
      }
    },
  };
}

/** A worker's execution deadline must not expire while its page is suspended. */
export function setActiveTimeout(callback: () => void, timeoutMs: number): () => void {
  const clock = createActiveClock();
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clock.dispose();
  };
  const check = () => {
    if (stopped) return;
    const remaining = timeoutMs - clock.now();
    if (remaining <= 0 && document.visibilityState !== 'hidden') {
      stop();
      callback();
    } else {
      timer = setTimeout(check, Math.max(1, Math.min(1000, remaining > 0 ? remaining : 1000)));
    }
  };
  timer = setTimeout(check, Math.min(1000, timeoutMs));
  return stop;
}
