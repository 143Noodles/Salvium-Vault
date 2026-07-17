// CSP smoke: load vault-test in a modern browser, assert the strict response
// policy, prove the WASM engine works, and prove JS string execution is blocked.
import { chromium, firefox } from 'playwright';

const BASE = process.env.SMOKE_URL || 'https://vault-test.salvium.tools';
const BROWSER_NAME = process.env.SMOKE_BROWSER || 'chromium';
const browserType = BROWSER_NAME === 'firefox' ? firefox : chromium;
const consoleErrors = [];
const documentPolicies = [];

const browser = await browserType.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} <- ${e.blockedURI} @ ${e.sourceFile}:${e.lineNumber}`);
  });
});
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
});
page.on('response', (response) => {
  if (response.request().resourceType() !== 'document') return;
  documentPolicies.push({
    url: response.url(),
    mode: response.headers()['x-salvium-csp-mode'] || '',
    csp: response.headers()['content-security-policy'] || '',
  });
});

const strictNavigation = page.waitForResponse(
  (response) => response.request().resourceType() === 'document'
    && response.url().startsWith(BASE)
    && response.headers()['x-salvium-csp-mode'] === 'strict',
  { timeout: 60_000 },
);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(async () => {
  try {
    const response = await fetch('/api/csp-readiness', { cache: 'no-store', credentials: 'same-origin' });
    const status = await response.json();
    return status.mode === 'strict';
  } catch {
    return false;
  }
}, undefined, { timeout: 30000, polling: 500 });
await strictNavigation;
await page.waitForLoadState('domcontentloaded');
await page.waitForFunction(() => document.querySelector('#root > *'), undefined, { timeout: 60_000 });
await page.waitForTimeout(2000); // let the strict document's WASM worker init settle

const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
const wasmState = await page.evaluate(() => ({
  hasApp: !!document.querySelector('#root > *'),
  violations: window.__cspViolations,
}));
const strictDocument = [...documentPolicies].reverse().find(({ mode }) => mode === 'strict');
const csp = strictDocument?.csp || '';

let engineProbe = 'n/a';
try {
  engineProbe = await page.evaluate(async () => {
    const ws = window.walletService;
    if (!ws?.validateMnemonic) return 'no validateMnemonic';
    const result = await ws.validateMnemonic('not a real seed phrase at all just words here to test the engine path zzzz');
    return `engine-responded:${JSON.stringify(result).slice(0, 80)}`;
  });
} catch (error) {
  engineProbe = `threw:${String(error?.message || error).slice(0, 120)}`;
}

// Trigger from a real page-realm event handler. DevTools evaluation alone can
// bypass page CSP and therefore is not a valid unsafe-eval assertion.
await page.evaluate(() => {
  window.__dynamicCodeProbe = null;
  const button = document.createElement('button');
  button.id = 'qa-dynamic-code-probe';
  button.textContent = 'CSP probe';
  Object.assign(button.style, {
    position: 'fixed',
    right: '8px',
    bottom: '8px',
    zIndex: '2147483647',
  });
  button.addEventListener('click', () => {
    const before = window.__cspViolations.length;
    let blocked = false;
    try { new Function('return 1')(); } catch (error) { blocked = error?.name === 'EvalError'; }
    setTimeout(() => {
      window.__dynamicCodeProbe = { blocked, violations: window.__cspViolations.slice(before) };
    }, 0);
  });
  document.body.appendChild(button);
});
await page.click('#qa-dynamic-code-probe');
await page.waitForFunction(() => window.__dynamicCodeProbe !== null);
const dynamicCodeProbe = await page.evaluate(() => window.__dynamicCodeProbe);

const finalViolations = await page.evaluate(() => window.__cspViolations);
console.log(JSON.stringify({
  browser: BROWSER_NAME,
  appRendered: wasmState.hasApp,
  bodyPreview: bodyText.slice(0, 200).replace(/\n/g, ' | '),
  csp,
  documentPolicies,
  engineProbe,
  dynamicCodeProbe,
  bootstrapCspViolations: wasmState.violations,
  cspViolations: finalViolations,
  consoleErrors: consoleErrors.slice(0, 10),
}, null, 2));
await browser.close();
const pass = wasmState.hasApp
  && csp.includes("'wasm-unsafe-eval'")
  && !csp.includes("'unsafe-eval'")
  && engineProbe.startsWith('engine-responded:')
  && wasmState.violations.length === 0
  && dynamicCodeProbe.blocked
  && dynamicCodeProbe.violations.some((violation) => violation.startsWith('script-src'));
process.exit(pass ? 0 : 1);
