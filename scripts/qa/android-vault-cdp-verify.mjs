// Android/WebView incremental scan verifier.
//
// This script connects to an already-forwarded WebView CDP endpoint. It does not
// enumerate adb devices or touch any phone/emulator directly.
//
// Expected setup:
// - A debuggable WebView page exposed at CDP_HTTP, default http://127.0.0.1:9333.
// - A tunnel/proxy to the Vault test container at ROUTE_ORIGIN, default http://127.0.0.1:13000.
// - The WebView profile already contains the test wallet storage for https://vault.salvium.tools.
import fs from 'node:fs';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9333';
const VAULT_ORIGIN = 'https://vault.salvium.tools';
const ROUTE_ORIGIN = process.env.ROUTE_ORIGIN || 'http://127.0.0.1:13000';
const PASSWORD = process.env.VAULT_PASSWORD || 'HeadlessTest123!';
const LOG = process.env.LOG || '/tmp/android-vault-cdp-verify.log';
const SCREENSHOT = process.env.SCREENSHOT || '/tmp/android-vault-cdp-final.png';

fs.writeFileSync(LOG, '');
const runStart = Date.now();

function log(type, payload = {}) {
  const rel = ((Date.now() - runStart) / 1000).toFixed(1);
  const line = `${new Date().toISOString()} +${rel}s ${type} ${JSON.stringify(payload)}\n`;
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function textBody(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function cleanRequestHeaders(headers = {}) {
  const result = {};
  const skip = new Set([
    'host',
    'content-length',
    'connection',
    'accept-encoding',
    'origin',
    'referer',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'sec-fetch-user',
  ]);
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (skip.has(key) || key.startsWith(':')) continue;
    result[name] = String(value);
  }
  return result;
}

function cleanResponseHeaders(headers) {
  const skip = new Set([
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
  ]);
  const result = [];
  for (const [name, value] of headers.entries()) {
    if (skip.has(name.toLowerCase())) continue;
    result.push({ name, value });
  }
  return result;
}

function parseClientEvents(postData) {
  if (!postData) return [];
  try {
    const parsed = JSON.parse(postData);
    const events = Array.isArray(parsed.events) ? parsed.events : [parsed];
    return events.filter((event) => event && event.type);
  } catch {
    return [];
  }
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event));
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer, method } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
        err.cdp = msg.error;
        reject(err);
      } else {
        resolve(msg.result || {});
      }
      return;
    }
    if (msg.method && this.handlers.has(msg.method)) {
      for (const handler of this.handlers.get(msg.method)) {
        try {
          handler(msg.params || {});
        } catch (err) {
          log('HANDLER_ERROR', { method: msg.method, error: String(err && err.message || err) });
        }
      }
    }
  }

  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(payload);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
    }
  }
}

async function getPageWebSocket() {
  const targets = await fetch(`${CDP_HTTP}/json/list`).then((r) => r.json());
  const page = targets.find((target) => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No debuggable WebView page at ${CDP_HTTP}`);
  }
  return page.webSocketDebuggerUrl;
}

async function waitFor(label, fn, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err && err.message || String(err);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function main() {
  const pageWs = await getPageWebSocket();
  log('CDP_CONNECT', { pageWs });
  const cdp = new CdpClient(pageWs);
  await cdp.ready;

  let pinHeight = null;
  let blockStreamBlocked = false;
  let loadedBundleUrl = null;
  let loadedBundleStatus = null;
  let loadedBundleScriptId = null;
  let scriptSource = null;
  let scriptSourceChecked = false;
  let phase = 'boot';
  let measureStart = 0;
  let activeScan = false;
  let lastScanEventAt = 0;
  let kickCount = 0;
  let startedAt = 0;
  let completedAt = 0;
  const clientEvents = [];

  function recordClientEvent(event) {
    const now = Date.now();
    const item = {
      at: now,
      phase,
      rel: measureStart ? ((now - measureStart) / 1000).toFixed(1) : null,
      type: event.type,
      msg: event.message || '',
      ctx: event.context || {},
    };
    clientEvents.push(item);

    if (event.type === 'scan.stall_recovery_kick') kickCount += 1;
    if (event.type === 'scan.coordinator_started' || event.type === 'scan.started') {
      activeScan = true;
      lastScanEventAt = now;
      if (phase === 'measure' && event.type === 'scan.started' && !startedAt) startedAt = now;
    }
    if (event.type === 'scan.completed' || event.type === 'scan.failed' || event.type === 'scan.coordinator_terminal') {
      activeScan = false;
      lastScanEventAt = now;
      if (phase === 'measure' && event.type === 'scan.completed' && !completedAt) completedAt = now;
    }
    if (/stall_recovery|stall-recovery|coordinator_started|coordinator_terminal|scan\.started|scan\.completed|watchdog_reconcile/.test(event.type)) {
      log('CLIENT_EVENT', item);
    }
  }

  async function fulfillJson(requestId, body, status = 200) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: [
        { name: 'content-type', value: 'application/json; charset=utf-8' },
        { name: 'cache-control', value: 'no-store' },
      ],
      body: textBody(JSON.stringify(body)),
    });
  }

  async function fulfillText(requestId, text, contentType, status = 200) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: [
        { name: 'content-type', value: contentType },
        { name: 'cache-control', value: 'no-store' },
      ],
      body: textBody(text),
    });
  }

  async function handleFetchPaused(params) {
    const { requestId, request } = params;
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;

    if (url.origin !== VAULT_ORIGIN) {
      await cdp.send('Fetch.continueRequest', { requestId });
      return;
    }

    if (url.pathname.endsWith('/api/client-events') || url.pathname.endsWith('/vault/api/client-events')) {
      for (const event of parseClientEvents(request.postData)) recordClientEvent(event);
      await fulfillJson(requestId, { accepted: true }, 202);
      return;
    }

    if (url.pathname.includes('/api/wallet/block-stream')) {
      if (blockStreamBlocked) {
        log('BLOCK_STREAM_BLOCKED', { phase, url: request.url });
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
        return;
      }
      const h = pinHeight || 0;
      const sse = `data: ${JSON.stringify({ type: 'connected', height: h, timestamp: new Date().toISOString() })}\n\n`;
      await fulfillText(requestId, sse, 'text/event-stream; charset=utf-8');
      return;
    }

    if (pinHeight && (/\/api\/daemon\/info$/.test(url.pathname) || /\/vault\/api\/daemon\/info$/.test(url.pathname))) {
      await fulfillJson(requestId, {
        height: pinHeight,
        target_height: pinHeight,
        status: 'OK',
        synchronized: true,
      });
      return;
    }

    if (pinHeight && (/\/api\/wallet-rpc\/getheight$/.test(url.pathname) || /\/getheight$/.test(url.pathname))) {
      await fulfillJson(requestId, { height: pinHeight, status: 'OK' });
      return;
    }

    const mapped = `${ROUTE_ORIGIN}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const init = {
        method: request.method,
        headers: cleanRequestHeaders(request.headers),
        redirect: 'manual',
        signal: controller.signal,
      };
      if (!/^(GET|HEAD)$/i.test(request.method) && request.postData != null) {
        init.body = request.postData;
      }
      const response = await fetch(mapped, init);
      const body = request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
      const headers = cleanResponseHeaders(response.headers);
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.status,
        responsePhrase: response.statusText,
        responseHeaders: headers,
        body: bufferToBase64(body),
      });
      if (url.pathname.includes('/assets/vault-') || url.pathname === '/' || url.pathname === '') {
        log('ROUTE_FETCH', { url: request.url, mapped, status: response.status, bytes: body.length });
      }
    } catch (err) {
      log('ROUTE_ERROR', { url: request.url, mapped, error: String(err && err.message || err) });
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  cdp.on('Fetch.requestPaused', (params) => {
    handleFetchPaused(params).catch((err) => {
      log('FETCH_HANDLER_ERROR', { url: params?.request?.url, error: String(err && err.message || err) });
      cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }).catch(() => {});
    });
  });

  cdp.on('Network.responseReceived', (params) => {
    const url = params.response?.url || '';
    if (url.includes('/assets/vault-')) {
      loadedBundleUrl = url;
      loadedBundleStatus = {
        status: params.response.status,
        fromDiskCache: !!params.response.fromDiskCache,
        fromServiceWorker: !!params.response.fromServiceWorker,
        mimeType: params.response.mimeType,
      };
      log('BUNDLE_RESPONSE', { url, ...loadedBundleStatus });
    }
  });

  cdp.on('Network.loadingFailed', (params) => {
    const url = params.requestId || '';
    if (phase !== 'measure' || params.errorText !== 'net::ERR_ABORTED') {
      log('NETWORK_FAILED', {
        requestId: url,
        errorText: params.errorText,
        canceled: !!params.canceled,
        blockedReason: params.blockedReason || null,
      });
    }
  });

  cdp.on('Debugger.scriptParsed', (params) => {
    if (!params.url.includes('/assets/vault-')) return;
    loadedBundleScriptId = params.scriptId;
    cdp.send('Debugger.getScriptSource', { scriptId: params.scriptId }, 30000)
      .then((result) => {
        scriptSource = result.scriptSource || '';
        scriptSourceChecked = true;
        log('SCRIPT_SOURCE', {
          url: params.url,
          length: scriptSource.length,
          hasStallRecoveryKick: scriptSource.includes('scan.stall_recovery_kick'),
          hasWatchdogTelemetry: scriptSource.includes('scan.watchdog_reconcile_needed'),
        });
      })
      .catch((err) => log('SCRIPT_SOURCE_ERROR', { error: String(err && err.message || err) }));
  });

  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || []).map((arg) => arg.value || arg.description || '').join(' ');
    if (/error|warn|service worker|scan|wallet/i.test(text)) {
      log('CONSOLE', { type: params.type, text: text.slice(0, 500) });
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable', { maxPostDataSize: 128 * 1024 });
  await cdp.send('Debugger.enable');
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: `${VAULT_ORIGIN}/*`, requestStage: 'Request' }],
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.clearBrowserCache').catch((err) => log('CLEAR_CACHE_WARN', { error: err.message }));
  await cdp.send('Storage.clearDataForOrigin', {
    origin: VAULT_ORIGIN,
    storageTypes: 'service_workers,cache_storage',
  }).catch((err) => log('CLEAR_SW_WARN', { error: err.message }));
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        window.__androidCdpVerify = true;
        try {
          if (navigator.serviceWorker && navigator.serviceWorker.register) {
            navigator.serviceWorker.register = function() {
              console.warn('Service Worker registration blocked by Android CDP verifier');
              return Promise.reject(new Error('Service Worker registration blocked by Android CDP verifier'));
            };
          }
        } catch {}
      })();
    `,
  });

  const testUrl = `${VAULT_ORIGIN}/?androidCdp=${Date.now()}`;
  log('NAVIGATE', { testUrl, routeOrigin: ROUTE_ORIGIN });
  await cdp.send('Page.navigate', { url: testUrl });

  const boot = await waitFor('Vault boot', async () => {
    const result = await evaluate(cdp, `(() => {
      const scripts = Array.from(document.scripts || []).map((s) => s.src).filter(Boolean);
      const build = (scripts.find((s) => /\\/assets\\/vault-/.test(s)) || '').split('/').pop() || null;
      return {
        href: location.href,
        title: document.title,
        build,
        scripts,
        text: (document.body && document.body.innerText || '').slice(0, 800),
        hasWalletService: !!window.walletService,
        hasServiceWorkerController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      };
    })()`);
    return result?.build ? result : null;
  }, 60000, 1000);
  log('BOOT', boot);

  await waitFor('script source inspection', () => scriptSourceChecked, 30000, 500).catch((err) => {
    log('SCRIPT_SOURCE_WAIT_WARN', { error: err.message, scriptId: loadedBundleScriptId });
  });

  log('BUILD_CHECK', {
    loadedBundleUrl,
    loadedBundleStatus,
    hasStallRecoveryKick: !!scriptSource && scriptSource.includes('scan.stall_recovery_kick'),
    hasWatchdogTelemetry: !!scriptSource && scriptSource.includes('scan.watchdog_reconcile_needed'),
  });

  await waitFor('wallet UI', async () => {
    const state = await evaluate(cdp, `(() => ({
      href: location.href,
      hasWalletService: !!window.walletService,
      hasReceive: /\\bReceive\\b/i.test(document.body && document.body.innerText || ''),
      hasPassword: !!document.querySelector('input[type="password"]'),
      text: (document.body && document.body.innerText || '').slice(0, 500),
    }))()`);
    if (state.hasWalletService && state.hasReceive) return state;
    if (state.hasPassword) {
      const unlocked = await unlock(cdp, PASSWORD);
      log('UNLOCK_ATTEMPT', unlocked);
    }
    return null;
  }, 90000, 1500);

  const unlocked = await evaluate(cdp, `(() => ({
    href: location.href,
    hasWalletService: !!window.walletService,
    hasReceive: /\\bReceive\\b/i.test(document.body && document.body.innerText || ''),
    text: (document.body && document.body.innerText || '').slice(0, 500),
  }))()`);
  log('UNLOCKED', unlocked);

  phase = 'pre-detach';
  const ready = await waitFor('quiescent synced wallet', async () => {
    const status = await getSyncStatus(cdp);
    const now = Date.now();
    const quietForMs = lastScanEventAt ? now - lastScanEventAt : 999999;
    log('QUIET_WAIT', { status, activeScan, quietForMs });
    if (status?.daemonHeight > 0 && status?.walletHeight >= status.daemonHeight - 2 && status?.isSyncing === false && !activeScan && quietForMs >= 3000) {
      return status;
    }
    return null;
  }, 180000, 5000);
  log('QUIESCENT_READY', ready);

  const tip = ready.daemonHeight;
  const detachTo = tip - 1500;
  phase = 'measure';
  measureStart = Date.now();
  pinHeight = tip;
  blockStreamBlocked = true;
  activeScan = false;
  lastScanEventAt = 0;
  kickCount = 0;
  startedAt = 0;
  completedAt = 0;

  const detached = await evaluate(cdp, `(async () => {
    await window.walletService.detachFromHeight(${detachTo});
    return {
      href: location.href,
      status: window.walletService.getSyncStatus(),
    };
  })()`, 60000);
  log('DETACHED', { tip, detachTo, detached });

  let recovered = false;
  let finalStatus = null;
  for (let i = 1; i <= 30; i += 1) {
    await sleep(5000);
    finalStatus = await getSyncStatus(cdp);
    log('DETACH_TICK', {
      t: i * 5,
      status: finalStatus,
      kicks: kickCount,
      activeScan,
    });
    if (finalStatus?.walletHeight >= tip && finalStatus?.isSyncing === false) {
      recovered = true;
      break;
    }
  }

  await cdp.send('Page.captureScreenshot', { format: 'png' }, 30000)
    .then((shot) => fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64')))
    .catch((err) => log('SCREENSHOT_WARN', { error: err.message }));

  const result = {
    recovered,
    wallSeconds: ((Date.now() - measureStart) / 1000).toFixed(1),
    computeSeconds: startedAt && completedAt ? ((completedAt - startedAt) / 1000).toFixed(1) : 'n/a',
    kickCount,
    finalStatus,
    androidBundle: loadedBundleUrl,
    hasStallRecoveryKick: !!scriptSource && scriptSource.includes('scan.stall_recovery_kick'),
  };
  log('RESULT', result);

  cdp.close();
  if (!recovered) process.exitCode = 2;
}

async function evaluate(cdp, expression, timeoutMs = 30000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate exception');
  }
  return result.result?.value;
}

async function getSyncStatus(cdp) {
  return evaluate(cdp, `(() => {
    try {
      if (!window.walletService || !window.walletService.getSyncStatus) return null;
      return window.walletService.getSyncStatus();
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  })()`);
}

async function unlock(cdp, password) {
  return evaluate(cdp, `(() => {
    const password = ${JSON.stringify(password)};
    const setInput = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = Array.from(document.querySelectorAll('input[type="password"], input:not([type])'));
    const passwordInputs = inputs.filter((input) => input.type === 'password' || /password|unlock/i.test(input.placeholder || input.name || input.id || ''));
    for (const input of passwordInputs) setInput(input, password);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
    const button = buttons.find((el) => /unlock|open|login|continue|submit|enter|confirm/i.test(el.innerText || el.value || el.getAttribute('aria-label') || '')) || buttons[0] || null;
    if (button) button.click();
    if (passwordInputs[0]) {
      passwordInputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      passwordInputs[0].dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }
    return {
      passwordInputs: passwordInputs.length,
      clicked: button ? (button.innerText || button.value || button.getAttribute('aria-label') || '').trim().slice(0, 80) : null,
      href: location.href,
      text: (document.body && document.body.innerText || '').slice(0, 500),
    };
  })()`);
}

main().catch((err) => {
  log('FATAL', { error: String(err && err.stack || err) });
  process.exitCode = 1;
});
