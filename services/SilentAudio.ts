import { debugWarn } from '../utils/debug';

const DEBUG: boolean = false;

let audioContext: AudioContext | null = null;
let oscillator: OscillatorNode | null = null;
let gainNode: GainNode | null = null;
let isPlaying = false;

const isMobile = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
};

const isDesktop = (): boolean => !isMobile();

function initAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      DEBUG && debugWarn('[SilentAudio] Web Audio API not supported');
      return null;
    }

    audioContext = new AudioContextClass();

    gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(audioContext.destination);

    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
      }
    } catch {
    }

    return audioContext;
  } catch (err) {
    DEBUG && debugWarn('[SilentAudio] Failed to create AudioContext:', err);
    return null;
  }
}

export async function startSilentAudio(): Promise<boolean> {
  if (isPlaying) return true;

  try {
    const ctx = initAudioContext();
    if (!ctx || !gainNode) return false;

    // Best-effort keepalive only; never block scanning if resume() stays pending.
    if (ctx.state === 'suspended') {
      const resumed = await Promise.race([
        ctx.resume().then(() => true).catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 750)),
      ]);
      if (!resumed && ctx.state === 'suspended') {
        return false;
      }
    }

    oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 440;
    oscillator.connect(gainNode);
    oscillator.start();

    isPlaying = true;
    return true;
  } catch (err: any) {
    DEBUG && debugWarn('[SilentAudio] Could not start:', err?.message || err);
    return false;
  }
}

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
  }
}

export function isSilentAudioPlaying(): boolean {
  return isPlaying && audioContext !== null && audioContext.state === 'running';
}

export async function initDesktopSilentAudio(): Promise<void> {
  if (!isDesktop()) return;

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

export async function startMobileScanAudio(): Promise<void> {
  if (!isMobile()) return;
  await startSilentAudio();
}

export function stopMobileScanAudio(): void {
  if (!isMobile()) return;
  stopSilentAudio();
}

export function cleanupSilentAudio(): void {
  stopSilentAudio();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    gainNode = null;
  }
}
