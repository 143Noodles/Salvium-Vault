#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.SMOKE_URL || 'http://127.0.0.1:39002';
const profile = process.env.CSP_READINESS_PROFILE || '/tmp/salvium-csp-readiness-profile';
const heartbeatSha = crypto.createHash('sha256')
  .update(fs.readFileSync(new URL('../../wallet/heartbeat.worker.js', import.meta.url)))
  .digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.rmSync(profile, { recursive: true, force: true });
const documentModes = [];
const pageErrors = [];
const violations = [];
const context = await chromium.launchPersistentContext(profile, { headless: true });
await context.exposeBinding('__recordReadinessViolation', (_source, value) => violations.push(value));
await context.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__recordReadinessViolation({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
    });
  });
});

try {
  // A same-scope client with no current app bundle cannot answer the generation
  // probe. Its presence must hold the app on the bridge policy.
  const blocker = context.pages()[0] || await context.newPage();
  await blocker.goto(`${base}/privacy`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'document') return;
    if (!response.url().startsWith(base)) return;
    documentModes.push({
      url: response.url(),
      mode: response.headers()['x-salvium-csp-mode'] || '',
      csp: response.headers()['content-security-policy'] || '',
    });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('#root > *'), undefined, { timeout: 60_000 });
  await sleep(9_000);

  const before = await page.evaluate(async () => {
    const response = await fetch('/api/csp-readiness', { cache: 'no-store', credentials: 'same-origin' });
    return response.json();
  });
  assert.equal(before.mode, 'bridge', 'an unproven same-scope client did not hold bridge mode');
  assert.equal(before.ready, false, 'readiness cookie appeared before every client proved its generation');
  assert.ok(documentModes.some(({ mode }) => mode === 'bridge'), 'initial app document was not bridge CSP');
  assert.ok(!documentModes.some(({ mode }) => mode === 'strict'), 'strict CSP activated while an unproven client was open');

  const bridgeWorker = await context.request.get(`${base}/wallet/heartbeat.worker.js?v=${heartbeatSha}`);
  assert.equal(bridgeWorker.status(), 200);
  assert.match(bridgeWorker.headers()['content-security-policy'] || '', /'unsafe-eval'/);
  assert.match(bridgeWorker.headers()['cache-control'] || '', /no-store/);

  const strictNavigation = page.waitForResponse(
    (response) => response.request().resourceType() === 'document' &&
      response.url().startsWith(base) &&
      response.headers()['x-salvium-csp-mode'] === 'strict',
    { timeout: 45_000 },
  );
  await blocker.close();
  await page.bringToFront();
  await page.waitForFunction(async () => {
    try {
      const response = await fetch('/api/csp-readiness', { cache: 'no-store', credentials: 'same-origin' });
      const state = await response.json();
      return state.mode === 'strict' && state.ready === true;
    } catch {
      return false;
    }
  }, undefined, { timeout: 45_000, polling: 500 });
  await strictNavigation;
  await sleep(2_000);

  assert.ok(documentModes.some(({ mode }) => mode === 'strict'), 'app did not reload under strict CSP');
  const strictDocument = [...documentModes].reverse().find(({ mode }) => mode === 'strict');
  assert.ok(strictDocument?.csp.includes("'wasm-unsafe-eval'"), 'strict document does not permit WASM compilation');
  assert.ok(!strictDocument?.csp.includes("'unsafe-eval'"), 'strict document still permits JavaScript string execution');

  const cookies = await context.cookies(base);
  const readinessCookie = cookies.find(({ name }) => name === 'salvium_eval_free_ready');
  assert.ok(readinessCookie, 'strict readiness cookie is missing');
  assert.equal(readinessCookie.httpOnly, true, 'strict readiness cookie must be HttpOnly');
  assert.equal(readinessCookie.sameSite, 'Strict', 'strict readiness cookie must be SameSite=Strict');

  const strictWorker = await context.request.get(`${base}/wallet/heartbeat.worker.js?v=${heartbeatSha}`);
  assert.equal(strictWorker.status(), 200);
  assert.ok((strictWorker.headers()['content-security-policy'] || '').includes("'wasm-unsafe-eval'"));
  assert.ok(!(strictWorker.headers()['content-security-policy'] || '').includes("'unsafe-eval'"));
  assert.match(strictWorker.headers()['cache-control'] || '', /immutable/);
  assert.match(strictWorker.headers().vary || '', /Cookie/);

  assert.deepEqual(violations, [], 'bootstrap CSP violations occurred before the deliberate string-code probe');
  await page.evaluate(() => {
    window.__strictDynamicCodeProbe = null;
    const button = document.createElement('button');
    button.id = 'strict-readiness-code-probe';
    button.textContent = 'Strict CSP probe';
    button.addEventListener('click', () => {
      let blocked = false;
      try { new Function('return 1')(); } catch (error) { blocked = error?.name === 'EvalError'; }
      window.__strictDynamicCodeProbe = blocked;
    });
    document.body.appendChild(button);
  });
  await page.click('#strict-readiness-code-probe');
  assert.equal(await page.evaluate(() => window.__strictDynamicCodeProbe), true, 'strict CSP did not block new Function');
  assert.deepEqual(pageErrors, [], 'page errors occurred during readiness migration');

  console.log('CSP_READINESS_MIGRATION_RESULT ' + JSON.stringify({
    before,
    documentModes,
    readinessCookie: {
      name: readinessCookie.name,
      httpOnly: readinessCookie.httpOnly,
      secure: readinessCookie.secure,
      sameSite: readinessCookie.sameSite,
    },
    bridgeWorkerCacheControl: bridgeWorker.headers()['cache-control'],
    strictWorkerCacheControl: strictWorker.headers()['cache-control'],
    violations,
    pageErrors,
  }));
} finally {
  await context.close();
}
