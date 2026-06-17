const { execFileSync } = require('child_process');
const http = require('http');

const SERIAL = process.env.ADB_SERIAL || 'emulator-5554';
const PACKAGE = process.env.ANDROID_PACKAGE || 'tools.salvium';
const ACTIVITY = process.env.ANDROID_ACTIVITY || 'tools.salvium/.MainActivity';
const ANDROID_URL = process.env.ANDROID_URL || process.env.VAULT_URL || '';
const EXPECTED_ORIGIN = process.env.ANDROID_EXPECTED_ORIGIN || (ANDROID_URL ? new URL(ANDROID_URL).origin : '');
const CLEAR_PACKAGE = process.env.ANDROID_CLEAR_PACKAGE || PACKAGE;
const CDP_PORT = Number(process.env.CDP_PORT || 9230);
const PASSWORD = process.env.VAULT_PASSWORD || 'PerfTest1234!';
const SEED = 'REDACTED-TEST-SEED';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function adb(args, opts = {}) {
  return execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', ...opts });
}

function launchTarget() {
  if (ANDROID_URL) {
    const args = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', ANDROID_URL];
    if (PACKAGE) args.push('-p', PACKAGE);
    adb(args);
  } else {
    adb(['shell', 'am', 'start', '-n', ACTIVITY]);
  }
}

function tapUiText(source, timeoutMs = 10000) {
  const rx = new RegExp(source, 'i');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const nodes = xml.match(/<node\b[^>]*>/g) || [];
    for (const node of nodes) {
      const text = (node.match(/\btext="([^"]*)"/) || [])[1] || '';
      const desc = (node.match(/\bcontent-desc="([^"]*)"/) || [])[1] || '';
      const bounds = (node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) || []).slice(1).map(Number);
      if (bounds.length === 4 && rx.test(`${text} ${desc}`)) {
        const x = Math.round((bounds[0] + bounds[2]) / 2);
        const y = Math.round((bounds[1] + bounds[3]) / 2);
        adb(['shell', 'input', 'tap', String(x), String(y)]);
        log('tapped android ui', text || desc, x, y);
        waitSync(1500);
        return true;
      }
    }
    waitSync(500);
  }
  return false;
}

function finishChromeFirstRunIfPresent() {
  if (!/chrome/i.test(PACKAGE)) return;
  for (let i = 0; i < 3; i++) {
    const tapped =
      tapUiText('use without an account|accept.*continue|no thanks|got it', 2500) ||
      tapUiText('skip|not now', 1000);
    if (!tapped) break;
  }
  launchTarget();
}

function startFreshApp() {
  adb(['shell', 'pm', 'clear', CLEAR_PACKAGE]);
  adb(['shell', 'logcat', '-c']);
  launchTarget();
  waitSync(3000);
  finishChromeFirstRunIfPresent();
}

function findWebViewSocket() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const unix = adb(['shell', 'cat', '/proc/net/unix']);
    const webview = unix.match(/@webview_devtools_remote_(\d+)/);
    if (webview) return `webview_devtools_remote_${webview[1]}`;
    const chrome = unix.match(/@chrome_devtools_remote\b/);
    if (chrome) return 'chrome_devtools_remote';
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('No WebView/Chrome devtools socket found');
}

function forwardCdp(socket) {
  try { adb(['forward', '--remove', `tcp:${CDP_PORT}`]); } catch {}
  adb(['forward', `tcp:${CDP_PORT}`, `localabstract:${socket}`]);
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function connect(expectedOrigin = '') {
  const pages = await getJson('/json/list');
  const target =
    pages.find((page) => page.type === 'page' && expectedOrigin && String(page.url || '').startsWith(expectedOrigin)) ||
    pages.find((page) => page.type === 'page' && /vault/i.test(String(page.url || ''))) ||
    pages.find((page) => page.type === 'page') ||
    pages[0];
  if (!target) throw new Error('No CDP target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const callbacks = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? callbacks.reject(new Error(JSON.stringify(msg.error))) : callbacks.resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = id++;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await send('Runtime.enable');
  return { ws, send };
}

async function evalValue(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function installEventCapture(send) {
  await evalValue(send, `(() => {
    window.__vaultAndroidEvents = [];
    const capture = async (url, body) => {
      try {
        if (!String(url || '').includes('/api/client-events')) return;
        let text = '';
        if (typeof body === 'string') text = body;
        else if (body && typeof body.text === 'function') text = await body.text();
        if (text) window.__vaultAndroidEvents.push(JSON.parse(text));
      } catch {}
    };
    if (!window.__vaultAndroidFetchWrapped) {
      window.__vaultAndroidFetchWrapped = true;
      const originalFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        try { capture(typeof input === 'string' ? input : input && input.url, init && init.body); } catch {}
        return originalFetch(input, init);
      };
      const originalBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
      if (originalBeacon) {
        navigator.sendBeacon = function(url, data) {
          try { capture(url, data); } catch {}
          return originalBeacon(url, data);
        };
      }
    }
    return true;
  })()`);
}

async function state(send) {
  return evalValue(send, `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return {
      href: location.href,
      text: text.slice(0, 1400),
      buttons: [...document.querySelectorAll('button,[role=button],a,label')]
        .filter(visible)
        .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 50),
      inputs: [...document.querySelectorAll('input,textarea')]
        .filter(visible)
        .map((el) => ({ tag: el.tagName, type: el.type || '', placeholder: el.placeholder || '', valueLen: (el.value || '').length }))
        .slice(0, 30),
      session: (() => { try { return sessionStorage.getItem('salvium_vault_telemetry_session_v1') || ''; } catch { return ''; } })(),
      dashboard: /total balance|assets|send|receive|history/i.test(text) && !/welcome to|restore wallet|create wallet/i.test(text),
      syncing: /syncing|scanning|restoring|checking wallet|loading wallet/i.test(text),
      pct: (text.match(/(\\d{1,3}(?:\\.\\d+)?)\\s*%/) || [])[1] || ''
    };
  })()`);
}

async function clickText(send, source, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await evalValue(send, `(() => {
      const rx = new RegExp(${JSON.stringify(source)}, 'i');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
      };
      const candidates = [...document.querySelectorAll('button,[role=button],a,label,div[tabindex],div[role=option]')].filter(visible);
      for (const el of candidates) {
        const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text && text.length < 140 && rx.test(text)) {
          el.click();
          return text;
        }
      }
      return '';
    })()`);
    if (clicked) {
      log('clicked', clicked);
      return clicked;
    }
    await sleep(300);
  }
  return '';
}

async function fill(send, selector, value) {
  return evalValue(send, `(() => {
    const selector = ${JSON.stringify(selector)};
    const value = ${JSON.stringify(value)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const setValue = (el, val) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const els = [...document.querySelectorAll(selector)].filter(visible);
    els.forEach((el) => setValue(el, value));
    return els.length;
  })()`);
}

async function fillSeed(send) {
  return evalValue(send, `(() => {
    const seed = ${JSON.stringify(SEED)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const setValue = (el, val) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const textareas = [...document.querySelectorAll('textarea')].filter(visible);
    if (textareas.length) {
      setValue(textareas[0], seed);
      return 'textarea';
    }
    const words = seed.split(/\\s+/);
    const inputs = [...document.querySelectorAll('input')]
      .filter(visible)
      .filter((el) => !/password|checkbox|radio/i.test(el.type || ''));
    if (inputs.length >= 25) {
      for (let i = 0; i < 25; i++) setValue(inputs[i], words[i]);
      return 'word-inputs';
    }
    return 'missing';
  })()`);
}

async function waitDashboard(send, label, timeoutMs) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const s = await state(send);
    const summary = `${s.pct || '-'} dash=${s.dashboard} syncing=${s.syncing}`;
    if (summary !== last) {
      last = summary;
      log(`${label} state`, summary, s.text.slice(0, 220));
    }
    if (s.dashboard && !s.syncing) return Date.now() - start;
    await sleep(1500);
  }
  throw new Error(`${label} did not reach dashboard in ${timeoutMs}ms`);
}

async function restore(send) {
  await sleep(5000);
  log('entry', JSON.stringify(await state(send)));
  await clickText(send, 'restore|recover|import|already have', 15000);
  await sleep(1000);
  await clickText(send, 'seed phrase|recovery phrase|mnemonic|25.?word|seed', 10000);
  await sleep(1000);
  log('seed-form', JSON.stringify(await state(send)));
  log('seed-field', await fillSeed(send));
  await fill(send, 'input[type=number]', '0').catch(() => {});
  await clickText(send, '^(next|continue|restore|import)$', 10000);
  await sleep(1500);
  log('password-form', JSON.stringify(await state(send)));
  await fill(send, 'input[type=password]', PASSWORD);
  await clickText(send, 'restore|create|unlock|finish|continue|next|set password|save', 12000);
  log('restore submitted');
  return waitDashboard(send, 'android-restore-scan', 20 * 60 * 1000);
}

async function unlockAfterReload(send) {
  const reloadStart = Date.now();
  await evalValue(send, `location.reload(); true`);
  await sleep(3000);
  const afterReload = await state(send);
  log('after-reload', JSON.stringify(afterReload));
  if (/wallet locked|unlock/i.test(afterReload.text) && afterReload.inputs.some((input) => input.type === 'password')) {
    await fill(send, 'input[type=password]', PASSWORD);
    await clickText(send, 'unlock|continue|open', 8000);
  }
  const reloadDashboardMs = await waitDashboard(send, 'android-reload-resync', 120000);
  return { reloadDashboardMs, reloadMs: Date.now() - reloadStart };
}

(async () => {
  startFreshApp();
  await sleep(7000);
  const socket = findWebViewSocket();
  forwardCdp(socket);
  const { ws, send } = await connect(EXPECTED_ORIGIN);
  if (EXPECTED_ORIGIN) {
    const href = await evalValue(send, `location.href`);
    if (!String(href).startsWith(EXPECTED_ORIGIN)) {
      throw new Error(`Android target opened ${href}, expected ${EXPECTED_ORIGIN}`);
    }
  }
  await installEventCapture(send);
  const restoreMs = await restore(send);
  const cached = await unlockAfterReload(send);
  const finalState = await state(send);
  const events = await evalValue(send, `window.__vaultAndroidEvents || []`);
  const interesting = events.filter((event) => /wallet\\.slow_op|wallet\\.import_cache_phase_timings|wallet\\.runtime_tx_candidate_timings|task\\.timeout|task\\.failed|frontend\\.stale/.test(event.type || ''));
  console.log('ANDROID_VAULT_TEST_RESULT ' + JSON.stringify({
    session: finalState.session,
    restoreMs,
    ...cached,
    eventCount: events.length,
    interesting,
    text: finalState.text.slice(0, 800),
  }));
  ws.close();
})().catch((error) => {
  console.error('ANDROID_VAULT_TEST_FATAL', error && error.stack || error);
  process.exit(2);
});
