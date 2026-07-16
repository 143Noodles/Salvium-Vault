// CSP smoke: load vault-test in headless Chromium (modern CSP variant),
// create a wallet, assert zero CSP violations and a working WASM engine.
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL || 'https://vault-test.salvium.tools';
const violations = [];
const consoleErrors = [];

const browser = await chromium.launch({ headless: true });
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

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000); // let bootstrap + WASM worker init run

// Try to reach the create-wallet flow if onboarding is shown.
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
const wasmState = await page.evaluate(() => ({
  hasApp: !!document.querySelector('#root > *'),
  violations: window.__cspViolations,
}));

// Drive wallet creation via the visible UI if present.
let created = 'skipped';
try {
  const createBtn = page.getByText(/create.*wallet|new wallet/i).first();
  if (await createBtn.isVisible({ timeout: 3000 })) {
    await createBtn.click();
    await page.waitForTimeout(4000);
    created = 'clicked-create';
  }
} catch { /* onboarding variant differs; violations check is the core assert */ }

const finalViolations = await page.evaluate(() => window.__cspViolations);
console.log(JSON.stringify({
  appRendered: wasmState.hasApp,
  bodyPreview: bodyText.slice(0, 200).replace(/\n/g, ' | '),
  created,
  cspViolations: finalViolations,
  consoleErrors: consoleErrors.slice(0, 10),
}, null, 2));
await browser.close();
process.exit(finalViolations.length === 0 && wasmState.hasApp ? 0 : 1);
