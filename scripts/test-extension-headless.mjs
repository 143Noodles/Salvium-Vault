import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromeExtensionDir = path.join(repoRoot, 'dist-extension/chrome');
const firefoxExtensionDir = path.join(repoRoot, 'dist-extension/firefox');
const firefoxExtensionId = 'vault@salvium.tools';
const firefoxExtensionUuid = '2b73b6f4-2dcc-4f73-9cf2-c56c8f8b2a99';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, expected, label) {
  assert(String(text).includes(expected), `${label} did not include "${expected}". Text was:\n${text}`);
}

function assertBuiltExtension(dir, browserName) {
  assert(fs.existsSync(path.join(dir, 'manifest.json')), `${browserName} manifest is missing at ${dir}`);
  assert(fs.existsSync(path.join(dir, 'popup.html')), `${browserName} popup.html is missing`);
  assert(fs.existsSync(path.join(dir, 'vault.html')), `${browserName} vault.html is missing`);
  assert(fs.existsSync(path.join(dir, 'wallet/SalviumWallet.js')), `${browserName} packaged WASM glue is missing`);
  assert(fs.existsSync(path.join(dir, 'wallet/SalviumWallet.wasm')), `${browserName} packaged WASM binary is missing`);
  assert(fs.existsSync(path.join(dir, 'wallet/SalviumWalletBaseline.js')), `${browserName} packaged baseline WASM glue is missing`);
  assert(fs.existsSync(path.join(dir, 'wallet/SalviumWalletBaseline.wasm')), `${browserName} packaged baseline WASM binary is missing`);
  assert(fs.existsSync(path.join(dir, 'wallet/wasm-feature-detect.js')), `${browserName} packaged WASM feature detector is missing`);
}

function listFiles(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, fullPath, out);
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

function assertNoDirectDynamicCode(dir) {
  const dynamicCodePattern = /(^|[^\w$])eval\s*\(|\(\s*0\s*,\s*eval\s*\)|new\s+Function|[^\w$]Function\s*\(/;
  const offenders = [];
  for (const file of listFiles(dir).filter((filePath) => filePath.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (dynamicCodePattern.test(text)) offenders.push(path.relative(dir, file));
  }
  assert(offenders.length === 0, `Extension package contains direct dynamic-code calls: ${offenders.join(', ')}`);
}

async function testChromeExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-vault-chrome-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${chromeExtensionDir}`,
      `--load-extension=${chromeExtensionDir}`,
    ],
  });

  const runtimeErrors = [];
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    assert(worker.url().includes('/assets/background.chrome.js'), `Unexpected Chrome background URL: ${worker.url()}`);
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      const text = message.text();
      if (/(Refused to|violates the following Content Security Policy|unsafe-eval|EvalError|WalletWorkerCrashedError)/i.test(text)) {
        runtimeErrors.push(text);
      }
    });

    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Salvium Vault', { timeout: 10000 });
    const popupText = await page.locator('body').innerText();
    assertIncludes(popupText, 'CHROME EXTENSION', 'Chrome popup');
    assertIncludes(popupText, 'host scaffold ready', 'Chrome popup');
    const chromeState = await page.evaluate(() => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'vault:getState' }, (response) => resolve(response));
    }));
    assert(chromeState?.ok === true, `Chrome background state request failed: ${JSON.stringify(chromeState)}`);

    await page.goto(`chrome-extension://${extensionId}/vault.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Private by Design.', { timeout: 20000 });
    const vaultText = await page.locator('body').innerText();
    assertIncludes(vaultText, 'Create Wallet', 'Chrome Vault');
    assertIncludes(vaultText, 'Restore Wallet', 'Chrome Vault');
    assert(runtimeErrors.length === 0, `Chrome extension runtime errors:\n${runtimeErrors.join('\n')}`);
    console.log('[chrome] popup, background, and full Vault loaded in headless Chromium');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createStoredZip(sourceDir, outputFile) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  const time = 0;
  const day = 33; // 1980-01-01

  for (const file of listFiles(sourceDir).sort()) {
    const relativeName = path.relative(sourceDir, file).split(path.sep).join('/');
    const name = Buffer.from(relativeName);
    const data = fs.readFileSync(file);
    const crc = crc32(data);
    const localRecord = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    const centralRecord = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    localRecords.push(localRecord);
    centralRecords.push(centralRecord);
    offset += localRecord.length;
  }

  const centralSize = centralRecords.reduce((sum, record) => sum + record.length, 0);
  const endRecord = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centralRecords.length), u16(centralRecords.length),
    u32(centralSize), u32(offset), u16(0),
  ]);
  fs.writeFileSync(outputFile, Buffer.concat([...localRecords, ...centralRecords, endRecord]));
}

function findPlaywrightFirefoxBinary() {
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root)
    .filter((entry) => entry.startsWith('firefox-'))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const binary = path.join(root, candidate, 'firefox/firefox');
    if (fs.existsSync(binary)) return binary;
  }
  return null;
}

async function testFirefoxExtension() {
  const xpiPath = path.join(os.tmpdir(), `salvium-vault-firefox-${Date.now()}.xpi`);
  createStoredZip(firefoxExtensionDir, xpiPath);
  const options = new firefox.Options();
  options.addArguments('-headless');
  const firefoxBinary = findPlaywrightFirefoxBinary();
  if (firefoxBinary) options.setBinary(firefoxBinary);
  options.setPreference('xpinstall.signatures.required', false);
  options.setPreference('extensions.autoDisableScopes', 0);
  options.setPreference('extensions.enabledScopes', 15);
  options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [firefoxExtensionId]: firefoxExtensionUuid }));

  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  try {
    const installedId = await driver.installAddon(xpiPath, true);
    assert(installedId === firefoxExtensionId, `Unexpected Firefox add-on id: ${installedId}`);
    await driver.sleep(2500);

    await driver.get(`moz-extension://${firefoxExtensionUuid}/popup.html`);
    await driver.wait(until.elementLocated(By.css('body')), 10000);
    await driver.sleep(750);
    const popupText = await driver.findElement(By.css('body')).getText();
    assertIncludes(popupText, 'FIREFOX EXTENSION', 'Firefox popup');
    assertIncludes(popupText, 'host scaffold ready', 'Firefox popup');
    const firefoxState = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({ type: 'vault:getState' }).then(done, (error) => done({ ok: false, error: String(error) }));
    `);
    assert(firefoxState?.ok === true, `Firefox background state request failed: ${JSON.stringify(firefoxState)}`);

    await driver.get(`moz-extension://${firefoxExtensionUuid}/vault.html`);
    await driver.wait(until.elementLocated(By.css('body')), 10000);
    await driver.sleep(5000);
    const vaultText = await driver.findElement(By.css('body')).getText();
    assertIncludes(vaultText, 'Private by Design.', 'Firefox Vault');
    assertIncludes(vaultText, 'Create Wallet', 'Firefox Vault');
    assertIncludes(vaultText, 'Restore Wallet', 'Firefox Vault');
    console.log('[firefox] popup, background, and full Vault loaded in headless Firefox');
  } finally {
    await driver.quit();
    fs.rmSync(xpiPath, { force: true });
  }
}

async function main() {
  assertBuiltExtension(chromeExtensionDir, 'Chrome extension');
  assertBuiltExtension(firefoxExtensionDir, 'Firefox extension');
  assertNoDirectDynamicCode(chromeExtensionDir);
  assertNoDirectDynamicCode(firefoxExtensionDir);
  await testChromeExtension();
  await testFirefoxExtension();
  console.log('Headless extension smoke tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
