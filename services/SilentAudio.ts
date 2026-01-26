/**
 * SilentAudio.ts - Background Keep-Alive via Silent Audio
 *
 * Uses Web Audio API to generate silence programmatically.
 * Prevents:
 * - Desktop: Browser tab throttling in background
 * - Mobile: iOS/Android suspending the PWA during scans
 *
 * Strategy:
 * - Desktop: Always on (prevents tab throttling)
 * - Mobile: Only during scans (avoids battery drain & audio conflicts)
 */

// PRODUCTION: Set to false to suppress verbose debug logs
const DEBUG = false;

let audioContext: AudioContext | null = null;
let oscillator: OscillatorNode | null = null;
let gainNode: GainNode | null = null;
let isPlaying = false;

// Detect if we're on mobile
const isMobile = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
};

// Detect if we're on desktop
const isDesktop = (): boolean => !isMobile();

/**
 * Initialize the Web Audio API context
 */
function initAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;

  try {
    // Create audio context (with webkit prefix for older Safari)
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      void DEBUG && console.warn('[SilentAudio] Web Audio API not supported');
      return null;
    }

    audioContext = new AudioContextClass();

    // Create a gain node set to zero (complete silence)
    gainNode = audioContext.createGain();
    gainNode.gain.value = 0; // Completely silent
    gainNode.connect(audioContext.destination);

    // Don't show in media session / control center (where supported)
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
      }
    } catch {
      // mediaSession not supported
    }

    return audioContext;
  } catch (err) {
    void DEBUG && console.warn('[SilentAudio] Failed to create AudioContext:', err);
    return null;
  }
}

/**
 * Start silent audio playback
 */
export async function startSilentAudio(): Promise<boolean> {
  if (isPlaying) return true;

  try {
    const ctx = initAudioContext();
    if (!ctx || !gainNode) return false;

    // Resume context if suspended (required after user interaction on some browsers)
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // Create oscillator (generates a tone, but gain is 0 so it's silent)
    oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 440; // Doesn't matter - gain is 0
    oscillator.connect(gainNode);
    oscillator.start();

    isPlaying = true;
    return true;
  } catch (err: any) {
    void DEBUG && console.warn('[SilentAudio] Could not start:', err?.message || err);
    return false;
  }
}

/**
 * Stop silent audio playback
 */
export function stopSilentAudio(): void {
  if (!isPlaying) return;

  try {
    if (oscillator) {
      oscillator.stop();
      oscillator.disconnect();
      oscillator = null;
    }
    isPlaying = false;
  } catch {
    // Ignore stop errors
  }
}

/**
 * Check if silent audio is currently playing
 */
export function isSilentAudioPlaying(): boolean {
  return isPlaying && audioContext !== null && audioContext.state === 'running';
}

/**
 * Start silent audio for desktop (always on)
 * Call this when the wallet becomes ready
 */
export async function initDesktopSilentAudio(): Promise<void> {
  if (!isDesktop()) return;

  // Don't try to start immediately - browsers block AudioContext before user gesture
  // Instead, wait for first user interaction to avoid console warning
  const startOnInteraction = async () => {
    const success = await startSilentAudio();
    if (success) {
      document.removeEventListener('click', startOnInteraction);
      document.removeEventListener('keydown', startOnInteraction);
      document.removeEventListener('touchstart', startOnInteraction);
    }
  };

  document.addEventListener('click', startOnInteraction, { once: false });
  document.addEventListener('keydown', startOnInteraction, { once: false });
  document.addEventListener('touchstart', startOnInteraction, { once: false });
}

/**
 * Start silent audio for mobile scan
 * Call this when a scan starts on mobile
 */
export async function startMobileScanAudio(): Promise<void> {
  if (!isMobile()) return;
  await startSilentAudio();
}

/**
 * Stop silent audio after mobile scan
 * Call this when a scan ends on mobile
 */
export function stopMobileScanAudio(): void {
  if (!isMobile()) return;
  stopSilentAudio();
}

/**
 * Cleanup - close audio context
 */
export function cleanupSilentAudio(): void {
  stopSilentAudio();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    gainNode = null;
  }
}
