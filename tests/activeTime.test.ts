import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveClock, setActiveTimeout } from '../utils/activeTime';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('foreground execution budgets', () => {
  it('excludes a frozen background interval even when the timer runs before the resume event', () => {
    vi.useFakeTimers();
    let at = 0;
    let visibility = 'visible';
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    const fired = vi.fn();
    const stop = setActiveTimeout(fired, 120000);
    at = 20000;
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    at += 3600000; // no JS callbacks execute while the app is frozen
    visibility = 'visible';
    vi.advanceTimersByTime(1000); // expired timer is delivered before visibilitychange
    expect(fired).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('visibilitychange'));
    at += 99000; vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
    at += 1000; vi.advanceTimersByTime(1000);
    expect(fired).toHaveBeenCalledTimes(1);
    stop();
  });

  it('retains the real foreground timeout and cancels listeners on completion', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const remove = vi.spyOn(document, 'removeEventListener');
    const fired = vi.fn();
    setActiveTimeout(fired, 100);
    vi.advanceTimersByTime(100);
    expect(fired).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('excludes offline time for scan liveness without making local wallet work depend on the network', () => {
    let at = 0; let online = true;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const scan = createActiveClock(true); const wallet = createActiveClock();
    at = 100; online = false; window.dispatchEvent(new Event('offline'));
    at = 1000000; online = true;
    expect(scan.now()).toBe(100);
    expect(wallet.now()).toBe(1000000);
    scan.dispose(); wallet.dispose();
  });
});
