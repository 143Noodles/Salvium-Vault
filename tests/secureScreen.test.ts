import { afterEach, describe, expect, it, vi } from 'vitest';

const secureMocks = vi.hoisted(() => ({
  setSecure: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ setSecure: secureMocks.setSecure }),
}));

vi.mock('../utils/runtime', () => ({
  isNativeAndroid: () => true,
}));

import { setScreenSecure } from '../utils/secureScreen';

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Android secure-screen reconciliation', () => {
  afterEach(() => {
    secureMocks.setSecure.mockReset();
    vi.useRealTimers();
  });

  it('reference-counts callers and reconciles a desired-state change during a native call', async () => {
    let resolveEnable!: () => void;
    secureMocks.setSecure
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveEnable = resolve; }))
      .mockResolvedValue(undefined);

    setScreenSecure(true);
    setScreenSecure(true);
    expect(secureMocks.setSecure).toHaveBeenCalledTimes(1);
    expect(secureMocks.setSecure).toHaveBeenNthCalledWith(1, { secure: true });

    setScreenSecure(false);
    expect(secureMocks.setSecure).toHaveBeenCalledTimes(1);
    setScreenSecure(false);

    resolveEnable();
    await vi.waitFor(() => expect(secureMocks.setSecure).toHaveBeenCalledTimes(2));
    expect(secureMocks.setSecure).toHaveBeenNthCalledWith(2, { secure: false });
    await flushPromises();
  });

  it('backs off after a native error and reasserts FLAG_SECURE when the app resumes', async () => {
    vi.useFakeTimers();
    secureMocks.setSecure
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockResolvedValue(undefined);

    setScreenSecure(true);
    await flushPromises();
    expect(secureMocks.setSecure).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(secureMocks.setSecure).toHaveBeenCalledTimes(2);
    expect(secureMocks.setSecure).toHaveBeenLastCalledWith({ secure: true });
    await flushPromises();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(secureMocks.setSecure).toHaveBeenCalledTimes(3);
    expect(secureMocks.setSecure).toHaveBeenLastCalledWith({ secure: true });

    setScreenSecure(false);
    await flushPromises();
    expect(secureMocks.setSecure).toHaveBeenCalledTimes(4);
    expect(secureMocks.setSecure).toHaveBeenLastCalledWith({ secure: false });
  });
});
