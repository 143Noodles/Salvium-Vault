// Seed-phrase clipboard hygiene: auto-clear after a delay, but only when we
// can verify the clipboard still holds the seed (readText may be unavailable
// or permission-denied; never blind-overwrite — the user may have copied
// something else since).
const AUTO_CLEAR_MS = 60000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export async function copySeedWithAutoClear(seed: string): Promise<void> {
  await navigator.clipboard.writeText(seed);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(async () => {
    clearTimer = null;
    try {
      const current = await navigator.clipboard.readText();
      if (current === seed) {
        await navigator.clipboard.writeText('');
      }
    } catch {
      // Can't verify clipboard contents — leave it alone.
    }
  }, AUTO_CLEAR_MS);
}
