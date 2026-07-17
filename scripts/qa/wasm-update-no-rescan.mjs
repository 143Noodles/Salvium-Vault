#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs';
import { chromium } from 'playwright';

const mode = process.argv[2];
assert.ok(mode === 'prepare' || mode === 'verify', 'usage: wasm-update-no-rescan.mjs <prepare|verify>');

const base = process.env.SMOKE_URL || 'https://vault-test.salvium.tools';
const profileDir = process.env.WASM_UPDATE_PROFILE || '/tmp/salvium-wasm-update-profile';
const statePath = process.env.WASM_UPDATE_STATE || '/tmp/salvium-wasm-update-state.json';
const password = process.env.WASM_UPDATE_PASSWORD || 'HeadlessTest123!';
const seedPath = process.env.WASM_UPDATE_SEED || '/tmp/.salvium_seed';
const expectedBalancePattern = /16\.8\d/;
const log = (...values) => console.log(new Date().toISOString().slice(11, 19), ...values);

if (mode === 'prepare') {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(statePath, { force: true });
}
if (mode === 'verify') {
  assert.ok(fs.statSync(statePath).isFile(), `missing prepared state: ${statePath}`);
}

const requests = [];
const pageErrors = [];
const context = await chromium.launchPersistentContext(profileDir, { headless: true });
try {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
    const count = Number(sessionStorage.getItem('salvium_qa_navigation_count') || '0') + 1;
    sessionStorage.setItem('salvium_qa_navigation_count', String(count));
  });

  const page = context.pages()[0] || await context.newPage();
  page.on('request', (request) => {
    const url = request.url();
    if (/\/api\/(?:csp-|wallet\/.*sparse|wasm)/.test(url)) {
      requests.push({ method: request.method(), url });
    }
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const startedAt = Date.now();
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5_000);

  if (mode === 'prepare') {
    const seed = fs.readFileSync(seedPath, 'utf8').trim();
    assert.ok(seed.split(/\s+/).length >= 24, 'test seed is missing or malformed');
    log('restoring the persistent control profile from height 0');
    await page.getByText('Import from seed or backup', { exact: false }).first().click();
    await page.waitForTimeout(1_000);
    await page.getByText('Enter your 25-word recovery phrase', { exact: false }).first().click();
    await page.waitForTimeout(1_000);
    await page.locator('textarea').first().fill(seed);
    const heightInput = page.locator('input[type="number"]').first();
    if (await heightInput.count()) await heightInput.fill('0');
    await page.getByRole('button', { name: /continue|next/i }).first().click();
    await page.waitForTimeout(1_000);
    const passwordInputs = page.locator('input[type="password"]');
    await passwordInputs.nth(0).fill(password);
    await passwordInputs.nth(1).fill(password);
    await page.getByRole('button', { name: /restore wallet/i }).last().click();
  } else {
    log('opening and unlocking the already-synced persistent profile');
    const unlockPassword = page.locator('input#password');
    await unlockPassword.waitFor({ state: 'visible', timeout: 60_000 });
    await unlockPassword.fill(password);
    await page.getByRole('button', { name: /unlock/i }).first().click();
  }

  const timeoutMs = mode === 'prepare' ? 14 * 60_000 : 3 * 60_000;
  await page.waitForFunction(
    () => /16\.8\d/.test(document.body.innerText.replace(/\s+/g, ' ')),
    undefined,
    { timeout: timeoutMs, polling: 2_000 },
  );
  // Allow journal and cache writes triggered by the final balance update to settle.
  await page.waitForTimeout(mode === 'prepare' ? 10_000 : 15_000);

  const snapshot = await page.evaluate(async () => {
    const service = window.walletService;
    const databases = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map((entry) => ({ name: entry.name, version: entry.version }))
      : [];
    return {
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1_500),
      balance: service && typeof service.getBalance === 'function' ? service.getBalance() : null,
      wasmAssetVersion: window.__salviumWasmAssetVersion || null,
      wasmCacheVersion: window.__salviumWasmCacheVersion || null,
      databases,
      navigationCount: Number(sessionStorage.getItem('salvium_qa_navigation_count') || '0'),
      violations: window.__cspViolations || [],
    };
  });
  assert.match(snapshot.body, expectedBalancePattern, 'expected restored balance is not visible');
  assert.deepEqual(snapshot.violations, [], 'CSP violations occurred');
  assert.deepEqual(pageErrors, [], 'page errors occurred');

  if (mode === 'prepare') {
    const state = {
      preparedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      snapshot,
      requestCount: requests.length,
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    log('PREPARED', JSON.stringify(state));
  } else {
    const prepared = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const batchCapabilityProbes = requests.filter(({ url }) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith('/api/csp-batch') &&
        parsed.searchParams.get('start_height') === '0' &&
        parsed.searchParams.get('chunks') === '1';
    });
    const fullRescanRequests = requests.filter(({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/api/csp-bundle')) return true;
      if (!parsed.pathname.endsWith('/api/csp-batch')) return false;
      if (parsed.searchParams.get('start_height') !== '0') return false;
      return parsed.searchParams.get('chunks') !== '1';
    });
    assert.ok(batchCapabilityProbes.length <= 1, 'unexpected repeated height-0 batch probes');
    assert.deepEqual(fullRescanRequests, [], 'the update triggered a height-0/full-bundle rescan');
    assert.deepEqual(snapshot.balance, prepared.snapshot.balance, 'wallet balance changed across the glue-only update');
    assert.deepEqual(snapshot.databases, prepared.snapshot.databases, 'wallet IndexedDB database set changed');
    assert.ok(Date.now() - startedAt < timeoutMs, 'reopen exceeded the no-rescan time budget');
    const result = {
      elapsedMs: Date.now() - startedAt,
      navigationCount: snapshot.navigationCount,
      requestCount: requests.length,
      batchCapabilityProbes,
      fullRescanRequests,
      balance: snapshot.balance,
      wasmAssetVersion: snapshot.wasmAssetVersion,
      wasmCacheVersion: snapshot.wasmCacheVersion,
      violations: snapshot.violations,
    };
    log('VERIFIED', JSON.stringify(result));
  }
} finally {
  await context.close();
}
