'use strict';
// Salvium Vault mining support.
//  - Pool stats proxy (all platforms): same-origin passthrough to pool.salvium.tools,
//    which sends no CORS headers so the SPA cannot call it directly.
//  - Miner control (desktop sidecar only): downloads a pinned, SHA-256-verified xmrig
//    build on demand, supervises it, and exposes start/stop/status/threads/afk routes.
// This module is the only place the sidecar touches child_process.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const POOL_HOST = 'pool.salvium.tools';
const POOL_API_BASE = `https://${POOL_HOST}`;
const POOL_STRATUM_PORT = 1230;

const XMRIG_VERSION = '6.26.0';
const XMRIG_RELEASE_BASE = `https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}`;
const XMRIG_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const XMRIG_ASSET_SHA256 = Object.freeze({
    [`xmrig-${XMRIG_VERSION}-linux-static-x64.tar.gz`]: 'fc6f8ae5f64e4f17481f7e3be29a1c56949f216a998414188003eae1db20c9e5',
    [`xmrig-${XMRIG_VERSION}-macos-arm64.tar.gz`]: '6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18',
    [`xmrig-${XMRIG_VERSION}-macos-x64.tar.gz`]: '1da924b358c0089e361540c4a9e6f8b09538b29efeafa2379590e0f6db358ff4',
    [`xmrig-${XMRIG_VERSION}-windows-arm64.zip`]: '958952de131c392a4e1e9656a1d70c3916d09d5a1f5e3f8c67dc0e6f35dbd76a',
    [`xmrig-${XMRIG_VERSION}-windows-x64.zip`]: 'bba8097cb37d9b458a1cb1137876b27cde6740d17fe4ccbc086ba07d87d9e147',
});
const XMRIG_DOWNLOAD_HOSTS = new Set([
    'github.com',
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
]);

// Salvium mainnet addresses: base58, "SC…" prefixes, ~97-106 chars.
function isValidSalviumAddress(addr) {
    const a = String(addr || '').trim();
    return a.length >= 90 && a.length <= 120 && /^SC/.test(a) && /^[1-9A-HJ-NP-Za-km-z]+$/.test(a);
}

// ---------------------------------------------------------------------------
// Pool proxy cache
// ---------------------------------------------------------------------------
const proxyCache = new Map(); // key -> { at, data, status }
const PROXY_CACHE_MAX = 300;

function cacheGet(key, ttlMs) {
    const hit = proxyCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit;
    return null;
}

function cacheSet(key, status, data) {
    if (proxyCache.size >= PROXY_CACHE_MAX) {
        // Drop oldest ~10% so a scan of many addresses can't grow the map unbounded.
        const keys = [...proxyCache.keys()].slice(0, Math.ceil(PROXY_CACHE_MAX / 10));
        for (const k of keys) proxyCache.delete(k);
    }
    proxyCache.set(key, { at: Date.now(), status, data });
}

// ---------------------------------------------------------------------------
// Miner state (desktop sidecar only)
// ---------------------------------------------------------------------------
const miner = {
    child: null,          // unix child process handle
    pid: null,            // xmrig pid (windows elevated: read from pid file)
    running: false,       // user intent: mining session active
    starting: false,
    stopping: false,
    installing: null,     // { phase, pct } while ensureXmrig is working
    elevated: false,
    address: null,
    threads: 0,
    afk: false,
    afkPaused: false,     // paused because user is active (afk mode)
    afkSupported: null,   // null = unknown yet
    apiPort: 0,
    apiToken: '',
    rigId: `desktop-${crypto.randomBytes(8).toString('hex')}`,
    error: null,
    startedAt: 0,
    restarts: 0,
    lastSummary: null,    // last xmrig /2/summary payload
    lastSummaryAt: 0,
    cpuPercent: null,
    cpuSample: null,      // { at, totalMs } for windows delta sampling
};

let minerDirRoot = null;
let cpuCountRef = Math.max(1, os.cpus().length);
let afkTimer = null;
let monitorTimer = null;

function minerDir() { return minerDirRoot; }
function versionDir() { return path.join(minerDirRoot, `xmrig-${XMRIG_VERSION}`); }
function xmrigBinPath() {
    return path.join(versionDir(), `xmrig-${XMRIG_VERSION}`, process.platform === 'win32' ? 'xmrig.exe' : 'xmrig');
}
function stateFilePath() { return path.join(minerDirRoot, 'state.json'); }

function xmrigAssetName() {
    const arch = process.arch;
    if (process.platform === 'win32') {
        if (arch === 'arm64') return `xmrig-${XMRIG_VERSION}-windows-arm64.zip`;
        return `xmrig-${XMRIG_VERSION}-windows-x64.zip`;
    }
    if (process.platform === 'darwin') {
        return arch === 'arm64'
            ? `xmrig-${XMRIG_VERSION}-macos-arm64.tar.gz`
            : `xmrig-${XMRIG_VERSION}-macos-x64.tar.gz`;
    }
    if (process.platform === 'linux' && arch === 'x64') {
        return `xmrig-${XMRIG_VERSION}-linux-static-x64.tar.gz`;
    }
    return null;
}

// Redirect-following buffered download (GitHub release assets 302 to a CDN).
function assertAllowedDownloadUrl(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !XMRIG_DOWNLOAD_HOSTS.has(parsed.hostname)) {
        throw new Error(`Blocked xmrig download URL: ${parsed.protocol}//${parsed.hostname}`);
    }
    return parsed;
}

function fetchBuffer(url, redirects = 5, onProgress = null) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = assertAllowedDownloadUrl(url); }
        catch (error) { reject(error); return; }
        const req = https.get(parsed, { headers: { 'User-Agent': 'salvium-vault-miner' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(fetchBuffer(new URL(res.headers.location, url).toString(), redirects - 1, onProgress));
            }
            if (res.statusCode >= 300 && res.statusCode < 400) {
                res.resume();
                return reject(new Error(`Too many redirects for ${url}`));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const total = Number(res.headers['content-length'] || 0);
            if (total > XMRIG_MAX_ARCHIVE_BYTES) {
                res.resume();
                return reject(new Error(`xmrig download exceeds ${XMRIG_MAX_ARCHIVE_BYTES} bytes`));
            }
            const chunks = [];
            let got = 0;
            res.on('data', (c) => {
                got += c.length;
                if (got > XMRIG_MAX_ARCHIVE_BYTES) {
                    req.destroy(new Error(`xmrig download exceeds ${XMRIG_MAX_ARCHIVE_BYTES} bytes`));
                    return;
                }
                chunks.push(c);
                if (onProgress && total > 0) onProgress(Math.min(99, Math.round((got / total) * 100)));
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
    });
}

function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const { input, ...spawnOptions } = opts;
        const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...spawnOptions });
        let out = '';
        let errOut = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { errOut += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(out.trim());
            else reject(new Error(`${cmd} exited ${code}: ${errOut.trim().slice(0, 400)}`));
        });
        if (input !== undefined) child.stdin.end(input);
    });
}

function validateArchiveListing(names, verboseListing = '') {
    const entries = String(names || '').split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.length > 10000) throw new Error('Invalid or excessive archive entry count');
    for (const entry of entries) {
        const normalized = entry.replace(/\\/g, '/');
        if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
            throw new Error(`Unsafe absolute archive entry: ${entry}`);
        }
        const parts = normalized.split('/').filter((part) => part && part !== '.');
        if (parts.some((part) => part === '..')) throw new Error(`Unsafe archive traversal entry: ${entry}`);
    }
    for (const line of String(verboseListing || '').split(/\r?\n/).filter(Boolean)) {
        const type = line.trimStart()[0];
        if (type && type !== '-' && type !== 'd') {
            throw new Error(`Unsafe non-file archive entry type: ${type}`);
        }
    }
}

async function extractArchive(archivePath, destDir) {
    const compressedTar = archivePath.endsWith('.tar.gz');
    const listArgs = compressedTar ? ['-tzf', archivePath] : ['-tf', archivePath];
    const verboseArgs = compressedTar ? ['-tvzf', archivePath] : ['-tvf', archivePath];
    const names = await runCmd('tar', listArgs);
    const verbose = await runCmd('tar', verboseArgs);
    validateArchiveListing(names, verbose);
    if (archivePath.endsWith('.tar.gz')) {
        await runCmd('tar', ['-xzf', archivePath, '-C', destDir, '--no-same-owner', '--no-same-permissions']);
        return;
    }
    // Supported Windows releases ship bsdtar. Refuse a less-auditable fallback.
    await runCmd('tar', ['-xf', archivePath, '-C', destDir]);
}

async function ensureXmrig() {
    const bin = xmrigBinPath();
    if (fs.existsSync(bin)) return bin;

    const asset = xmrigAssetName();
    if (!asset) throw new Error(`Mining is not supported on ${process.platform}/${process.arch}`);

    await fsp.mkdir(versionDir(), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fsp.chmod(versionDir(), 0o700);
    try {
        miner.installing = { phase: 'download', pct: 0 };
        const expected = XMRIG_ASSET_SHA256[asset];
        if (!expected) throw new Error(`No source-pinned SHA256 for ${asset}`);

        const archive = await fetchBuffer(`${XMRIG_RELEASE_BASE}/${asset}`, 5, (pct) => {
            miner.installing = { phase: 'download', pct };
        });
        const actual = crypto.createHash('sha256').update(archive).digest('hex');
        if (actual !== expected) {
            throw new Error(`xmrig download failed verification (sha256 ${actual.slice(0, 12)}… != expected ${expected.slice(0, 12)}…)`);
        }

        miner.installing = { phase: 'extract', pct: 100 };
        const archivePath = path.join(versionDir(), asset);
        await fsp.writeFile(archivePath, archive, { mode: 0o600 });
        await extractArchive(archivePath, versionDir());
        await fsp.unlink(archivePath).catch(() => {});

        if (!fs.existsSync(bin)) throw new Error('xmrig binary missing after extraction');
        const binStat = await fsp.lstat(bin);
        const resolvedBin = await fsp.realpath(bin);
        const resolvedRoot = `${await fsp.realpath(versionDir())}${path.sep}`;
        if (!binStat.isFile() || binStat.isSymbolicLink() || !resolvedBin.startsWith(resolvedRoot)) {
            throw new Error('xmrig binary escaped the verified extraction directory');
        }
        if (process.platform !== 'win32') await fsp.chmod(bin, 0o755);
        console.log(`[miner] Installed xmrig ${XMRIG_VERSION} (sha256 verified) at ${bin}`);
        return bin;
    } finally {
        miner.installing = null;
    }
}

function pickFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// xmrig HTTP API (localhost, bearer token)
// ---------------------------------------------------------------------------
function xmrigApi(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port: miner.apiPort,
            path: apiPath,
            method,
            timeout: 4000,
            headers: {
                Authorization: `Bearer ${miner.apiToken}`,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
                } else {
                    reject(new Error(`xmrig api ${apiPath} -> HTTP ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('xmrig api timeout')));
        if (payload) req.write(payload);
        req.end();
    });
}

const xmrigRpc = (rpcMethod) => xmrigApi('POST', '/json_rpc', { method: rpcMethod, id: 1, jsonrpc: '2.0' });

// Live thread re-tune via the unrestricted HTTP API: GET /1/config, set the '*'
// CPU profile's thread count, PUT it back. xmrig restarts its CPU backend in-process,
// so an elevated miner keeps its privileges and the user sees no new UAC/pkexec
// prompt. Verified empirically (6.26.0): '-t N' maps to cpu['*'] = {intensity, threads,
// affinity}; the PUT hot-applies (backend thread count follows) and a paused miner
// stays paused.
async function setThreadsLive(threads) {
    const config = await xmrigApi('GET', '/1/config');
    if (!config || typeof config !== 'object' || !config.cpu || typeof config.cpu !== 'object') {
        throw new Error('xmrig config unavailable');
    }
    const profile = config.cpu['*'];
    if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
        profile.threads = threads;
    } else {
        config.cpu['*'] = { intensity: 1, threads, affinity: -1 };
    }
    await xmrigApi('PUT', '/1/config', config);
}

function xmrigArgs(address, threads) {
    return [
        '-o', `${POOL_HOST}:${POOL_STRATUM_PORT}`,
        '-u', address,
        '-p', miner.rigId,
        '-a', 'rx/0',
        '-t', String(threads),
        '-k',
        '--http-host=127.0.0.1',
        `--http-port=${miner.apiPort}`,
        `--http-access-token=${miner.apiToken}`,
        '--http-no-restricted',
        '--no-color',
    ];
}

async function persistState() {
    const state = {
        running: miner.running,
        address: miner.address,
        threads: miner.threads,
        afk: miner.afk,
        apiPort: miner.apiPort,
        apiToken: miner.apiToken,
        rigId: miner.rigId,
        pid: miner.pid,
        elevated: miner.elevated,
    };
    try {
        const tmp = `${stateFilePath()}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
        if (process.platform !== 'win32') await fsp.chmod(tmp, 0o600);
        await fsp.rename(tmp, stateFilePath());
        if (process.platform !== 'win32') await fsp.chmod(stateFilePath(), 0o600);
    } catch (e) { /* best effort */ }
}

async function loadPersistedState() {
    try {
        return JSON.parse(await fsp.readFile(stateFilePath(), 'utf8'));
    } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Launch / supervise
// ---------------------------------------------------------------------------
async function launchUnix(bin, address, threads) {
    const child = spawn(bin, xmrigArgs(address, threads), {
        cwd: path.dirname(bin),
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-1000); });
    child.on('error', (err) => {
        miner.error = `xmrig failed to start: ${err.message}`;
        miner.child = null;
        miner.pid = null;
    });
    child.on('exit', (code) => {
        const wasRunning = miner.running && miner.child === child;
        miner.child = null;
        if (miner.pid === child.pid) miner.pid = null;
        if (!wasRunning || miner.stopping) return;
        // Crash while a session is active: restart with a cap.
        if (miner.restarts < 3) {
            miner.restarts += 1;
            console.warn(`[miner] xmrig exited (code ${code}), restart ${miner.restarts}/3`);
            setTimeout(() => {
                if (!miner.running || miner.child) return;
                launchUnix(bin, miner.address, miner.threads).catch((err) => {
                    miner.error = err.message;
                    miner.running = false;
                    persistState();
                });
            }, 3000);
        } else {
            miner.error = `Miner stopped unexpectedly (exit code ${code}). ${stderrTail ? stderrTail.split('\n').pop() : ''}`.trim();
            miner.running = false;
            persistState();
        }
    });
    miner.child = child;
    miner.pid = child.pid;
    miner.elevated = false;
}

function psQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

function elevatedStopFile() { return path.join(minerDirRoot, 'stop.request'); }
function windowsStopFile() { return elevatedStopFile(); } // back-compat alias

async function launchWindowsElevated(bin, address, threads) {
    const dir = minerDir();
    const pidFile = path.join(dir, 'xmrig.pid');
    const stopFile = windowsStopFile();
    await fsp.rm(pidFile, { force: true }).catch(() => {});
    await fsp.rm(stopFile, { force: true }).catch(() => {});

    const argLine = xmrigArgs(address, threads).map((a) => `"${a}"`).join(', ');
    // Runs elevated for the optimized miner launch. Never weaken Defender by adding
    // an exclusion for a user-writable directory. The script stays resident as a watchdog — the unelevated sidecar
    // cannot signal an elevated xmrig, so the watchdog kills it when the sidecar
    // process disappears (app quit/crash) or when the sidecar writes stop.request.
    const inner = [
        `$p = Start-Process -FilePath ${psQuote(bin)} -ArgumentList ${argLine} -WorkingDirectory ${psQuote(path.dirname(bin))} -WindowStyle Hidden -PassThru`,
        `$p.Id | Out-File -FilePath ${psQuote(pidFile)} -Encoding ascii`,
        `while ($true) {`,
        `  Start-Sleep -Seconds 3`,
        `  if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { break }`,
        `  if (Test-Path ${psQuote(stopFile)}) {`,
        `    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`,
        `    Remove-Item ${psQuote(stopFile)} -Force -ErrorAction SilentlyContinue`,
        `    break`,
        `  }`,
        `  if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) {`,
        `    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`,
        `    break`,
        `  }`,
        `}`,
    ].join('\n');
    const encodedCommand = Buffer.from(inner, 'utf16le').toString('base64');

    // Pass immutable command bytes through UAC. Never ask an elevated process to
    // execute a file that the unelevated user can replace during the prompt.
    await runCmd('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',${psQuote(encodedCommand)} | Out-Null`,
    ]).catch((err) => {
        const msg = /canceled|cancelled|denied|1223/i.test(err.message)
            ? 'Administrator permission was declined. Mining needs it once per session for full-speed hardware optimizations.'
            : `Could not launch the miner: ${err.message}`;
        throw new Error(msg);
    });

    // The elevated helper wrote the xmrig pid; give the file a moment to appear.
    for (let i = 0; i < 20; i++) {
        try {
            const pid = parseInt((await fsp.readFile(pidFile, 'utf8')).trim(), 10);
            if (Number.isFinite(pid) && pid > 0) {
                miner.pid = pid;
                miner.child = null;
                miner.elevated = true;
                return;
            }
        } catch (e) { /* not yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Miner was authorized but did not start (no pid reported).');
}

function shQuote(str) {
    return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

async function launchLinuxElevated(bin, address, threads) {
    const dir = minerDir();
    const pidFile = path.join(dir, 'xmrig.pid');
    const stopFile = elevatedStopFile();
    await fsp.rm(pidFile, { force: true }).catch(() => {});
    await fsp.rm(stopFile, { force: true }).catch(() => {});

    const argLine = xmrigArgs(address, threads).map(shQuote).join(' ');
    const HUGEPAGES = 1280; // ~2.5GB of 2MB pages: RandomX dataset + per-thread scratchpads
    // pkexec reads immutable script bytes over stdin. The root shell never opens a
    // user-writable helper path after the authorization prompt.
    const script = [
        '#!/bin/bash',
        `PIDFILE=${shQuote(pidFile)}`,
        `STOPFILE=${shQuote(stopFile)}`,
        `(`,
        `  HP=$(cat /proc/sys/vm/nr_hugepages 2>/dev/null || echo 0)`,
        `  if [ "$HP" -lt ${HUGEPAGES} ]; then sysctl -w vm.nr_hugepages=${HUGEPAGES} >/dev/null 2>&1 || true; fi`,
        `  modprobe msr >/dev/null 2>&1 || true`,
        `  ${shQuote(bin)} ${argLine} &`,
        `  XPID=$!`,
        `  echo $XPID > "$PIDFILE"`,
        `  SIDECAR=${process.pid}`,
        `  while kill -0 $XPID 2>/dev/null; do`,
        `    sleep 3`,
        `    if [ -f "$STOPFILE" ]; then kill -TERM $XPID 2>/dev/null; sleep 2; kill -KILL $XPID 2>/dev/null; rm -f "$STOPFILE"; break; fi`,
        `    if ! kill -0 $SIDECAR 2>/dev/null; then kill -TERM $XPID 2>/dev/null; sleep 2; kill -KILL $XPID 2>/dev/null; break; fi`,
        `  done`,
        `  rm -f "$PIDFILE"`,
        `) </dev/null >/dev/null 2>&1 &`,
        `for i in $(seq 1 60); do [ -s "$PIDFILE" ] && exit 0; sleep 0.25; done`,
        `exit 1`,
    ].join('\n');

    await runCmd('pkexec', ['bash', '-s'], { input: script }).catch((err) => {
        // Declined prompt, missing pkexec/polkit, or any other failure of the
        // elevation step: the caller falls back to standard unprivileged mining.
        const e = new Error(`Elevated launch unavailable: ${err.message}`);
        e.fallbackToStandard = true;
        throw e;
    });

    for (let i = 0; i < 20; i++) {
        try {
            const pid = parseInt((await fsp.readFile(pidFile, 'utf8')).trim(), 10);
            if (Number.isFinite(pid) && pid > 0) {
                miner.pid = pid;
                miner.child = null;
                miner.elevated = true;
                return;
            }
        } catch (e) { /* not yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Miner was authorized but did not start (no pid reported).');
}

async function waitForApi(maxMs = 30000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            const summary = await xmrigApi('GET', '/2/summary');
            miner.lastSummary = summary;
            miner.lastSummaryAt = Date.now();
            return true;
        } catch (e) { /* not up yet */ }
        if (!miner.pid && !miner.child) return false;
        await new Promise((r) => setTimeout(r, 800));
    }
    return false;
}

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function startMining({ address, threads, afk }) {
    if (miner.starting) throw new Error('Miner is already starting');
    if (miner.running) throw new Error('Miner is already running');
    miner.starting = true;
    miner.error = null;
    miner.restarts = 0;
    try {
        const bin = await ensureXmrig();
        miner.address = address;
        miner.threads = threads;
        miner.afk = !!afk;
        miner.afkPaused = false;
        miner.apiPort = await pickFreePort();
        miner.apiToken = crypto.randomBytes(24).toString('hex');

        if (process.platform === 'win32') {
            await launchWindowsElevated(bin, address, threads);
        } else if (process.platform === 'linux') {
            // Full speed by default: one OS (polkit) prompt per session enables huge
            // pages + the MSR mod. Declining the prompt (or a missing polkit) falls
            // back to standard unprivileged mining instead of failing the start.
            try {
                await launchLinuxElevated(bin, address, threads);
            } catch (err) {
                if (!err || !err.fallbackToStandard) throw err;
                console.warn(`[miner] elevated launch unavailable, using standard mode: ${err.message}`);
                await launchUnix(bin, address, threads);
            }
        } else {
            // macOS: xmrig runs unprivileged. No MSR mod exists and it allocates its
            // own 2MB pages without root, so unprivileged is already optimal there.
            await launchUnix(bin, address, threads);
        }

        const apiUp = await waitForApi();
        if (!apiUp) {
            await hardStop().catch(() => {});
            throw new Error(miner.error || 'The miner started but its status interface never came up.');
        }

        miner.running = true;
        miner.startedAt = Date.now();
        startMonitors();
        await persistState();
        console.log(`[miner] Mining started (threads=${threads}, elevated=${miner.elevated}, afk=${miner.afk})`);
    } finally {
        miner.starting = false;
    }
}

async function hardStop() {
    miner.stopping = true;
    try {
        // Halt mining threads immediately through the API (verified: 'stop' idles the
        // process but does not exit it), then take the process down.
        if (miner.apiPort) {
            try { await xmrigRpc('stop'); } catch (e) { /* fall through to signals */ }
        }
        if (miner.child) {
            try { miner.child.kill('SIGTERM'); } catch (e) {}
            const child = miner.child;
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 4000).unref?.();
        } else if (miner.pid && process.platform === 'win32') {
            // The unelevated sidecar cannot terminate the elevated xmrig directly:
            // ask the resident elevated watchdog to do it (picked up within ~3s),
            // plus a direct taskkill in case xmrig ever ran unelevated.
            await fsp.writeFile(elevatedStopFile(), String(Date.now())).catch(() => {});
            spawn('taskkill', ['/PID', String(miner.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
        } else if (miner.pid && miner.elevated && process.platform === 'linux') {
            // Elevated Linux xmrig: signal the resident root watchdog via the stop-file
            // (it kills xmrig within ~3s), plus a best-effort direct SIGTERM.
            await fsp.writeFile(elevatedStopFile(), String(Date.now())).catch(() => {});
            try { process.kill(miner.pid, 'SIGTERM'); } catch (e) {}
        } else if (miner.pid) {
            try { process.kill(miner.pid, 'SIGTERM'); } catch (e) {}
        }
    } finally {
        miner.running = false;
        miner.afkPaused = false;
        miner.child = null;
        miner.pid = null;
        miner.startedAt = 0;
        miner.cpuPercent = null;
        miner.cpuSample = null;
        miner.lastSummary = null;
        stopMonitors();
        miner.stopping = false;
        await persistState();
    }
}

// ---------------------------------------------------------------------------
// Monitoring: xmrig summary + process CPU% + AFK idle loop
// ---------------------------------------------------------------------------
function startMonitors() {
    stopMonitors();
    monitorTimer = setInterval(async () => {
        if (!miner.running) return;
        try {
            miner.lastSummary = await xmrigApi('GET', '/2/summary');
            miner.lastSummaryAt = Date.now();
            if (miner.error && /status interface|unexpectedly/i.test(miner.error)) miner.error = null;
        } catch (e) {
            // API gone: process likely died. Unix exit handler covers restarts; on
            // Windows (elevated, unsupervisable) declare it stopped after a grace period.
            if (Date.now() - miner.lastSummaryAt > 30000 && !pidAlive(miner.pid) && !miner.child) {
                miner.error = 'Miner stopped unexpectedly.';
                miner.running = false;
                stopMonitors();
                persistState();
            }
        }
        sampleCpu().catch(() => {});
    }, 3000);
    if (monitorTimer.unref) monitorTimer.unref();

    afkTimer = setInterval(() => { afkTick().catch(() => {}); }, 20000);
    if (afkTimer.unref) afkTimer.unref();
}

function stopMonitors() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
}

async function sampleCpu() {
    const pid = miner.pid || (miner.child && miner.child.pid);
    if (!pid || !miner.running) { miner.cpuPercent = null; return; }
    if (process.platform === 'win32') {
        try {
            const out = await runCmd('powershell.exe', [
                '-NoProfile', '-Command',
                `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`,
            ]);
            const totalMs = parseFloat(out);
            const now = Date.now();
            if (miner.cpuSample && Number.isFinite(totalMs)) {
                const dt = now - miner.cpuSample.at;
                const dcpu = totalMs - miner.cpuSample.totalMs;
                if (dt > 500) miner.cpuPercent = Math.max(0, Math.min(100, (dcpu / dt / cpuCountRef) * 100));
            }
            if (Number.isFinite(totalMs)) miner.cpuSample = { at: now, totalMs };
        } catch (e) { miner.cpuPercent = null; }
    } else {
        try {
            const out = await runCmd('ps', ['-o', '%cpu=', '-p', String(pid)]);
            const pct = parseFloat(out);
            // ps reports % of one core; normalize to % of the whole machine.
            if (Number.isFinite(pct)) miner.cpuPercent = Math.max(0, Math.min(100, pct / cpuCountRef));
        } catch (e) { miner.cpuPercent = null; }
    }
}

async function getIdleMs() {
    if (process.platform === 'win32') {
        const script = 'Add-Type @"\nusing System;using System.Runtime.InteropServices;public class UIdle{[StructLayout(LayoutKind.Sequential)]public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);public static uint Get(){LASTINPUTINFO l=new LASTINPUTINFO();l.cbSize=(uint)Marshal.SizeOf(l);GetLastInputInfo(ref l);return ((uint)Environment.TickCount-l.dwTime);}}\n"@; [UIdle]::Get()';
        const out = await runCmd('powershell.exe', ['-NoProfile', '-Command', script]);
        const ms = parseInt(out, 10);
        if (!Number.isFinite(ms)) throw new Error('idle parse failed');
        return ms;
    }
    if (process.platform === 'darwin') {
        const out = await runCmd('sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'"]);
        const ns = parseFloat(out);
        if (!Number.isFinite(ns)) throw new Error('idle parse failed');
        return ns / 1e6;
    }
    const out = await runCmd('xprintidle', []);
    const ms = parseInt(out, 10);
    if (!Number.isFinite(ms)) throw new Error('idle parse failed');
    return ms;
}

const AFK_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

async function afkTick() {
    if (!miner.running || !miner.afk) return;
    let idleMs;
    try {
        idleMs = await getIdleMs();
        miner.afkSupported = true;
    } catch (e) {
        miner.afkSupported = false;
        // Can't detect idle: never leave the miner silently paused.
        if (miner.afkPaused) {
            miner.afkPaused = false;
            await xmrigRpc('resume').catch(() => {});
        }
        return;
    }
    const userActive = idleMs < AFK_IDLE_THRESHOLD_MS;
    if (userActive && !miner.afkPaused) {
        try { await xmrigRpc('pause'); miner.afkPaused = true; } catch (e) {}
    } else if (!userActive && miner.afkPaused) {
        try { await xmrigRpc('resume'); miner.afkPaused = false; } catch (e) {}
    }
}

function statusPayload() {
    const summary = miner.lastSummary || {};
    const hashrate = summary.hashrate && Array.isArray(summary.hashrate.total) ? summary.hashrate.total : [];
    const results = summary.results || {};
    const hp = summary.hugepages;
    // xmrig summary.hugepages = [allocated, total]; >0 allocated == active.
    const hugepagesActive = Array.isArray(hp) ? Number(hp[0]) > 0 : (hp && typeof hp === 'object' ? Number(hp.allocated) > 0 : false);
    const msrRaw = summary.cpu && summary.cpu.msr;
    const msrActive = !!msrRaw && msrRaw !== 'none' && msrRaw !== false;
    return {
        supported: !!xmrigAssetName(),
        platform: process.platform,
        // Windows and Linux elevate automatically at start (OS-native prompt);
        // Linux falls back to unprivileged if declined. macOS is optimal unprivileged.
        boostSupported: process.platform === 'linux',
        boostActive: process.platform === 'linux' && !!miner.elevated,
        hugepagesActive,
        msrActive,
        installed: fs.existsSync(xmrigBinPath()),
        installing: miner.installing,
        version: XMRIG_VERSION,
        running: miner.running,
        starting: miner.starting,
        elevated: miner.elevated,
        threads: miner.threads,
        cpuCount: cpuCountRef,
        afk: miner.afk,
        afkSupported: miner.afkSupported,
        afkPaused: miner.afkPaused,
        hashrate: Number(hashrate[0]) || 0,
        hashrate60s: Number(hashrate[1]) || 0,
        hashrate15m: Number(hashrate[2]) || 0,
        cpuPercent: miner.cpuPercent,
        acceptedShares: Number(results.shares_good) || 0,
        totalShares: Number(results.shares_total) || 0,
        uptimeSec: miner.startedAt ? Math.floor((Date.now() - miner.startedAt) / 1000) : 0,
        pool: `${POOL_HOST}:${POOL_STRATUM_PORT}`,
        rigId: miner.rigId,
        error: miner.error,
    };
}

// On sidecar boot, reconcile with any miner left over from a previous run so the
// tab reflects reality (and an orphaned xmrig from a crashed sidecar gets stopped).
async function reconcilePersistedState() {
    const persisted = await loadPersistedState();
    if (persisted && /^desktop-[0-9a-f]{16}$/.test(String(persisted.rigId || ''))) {
        miner.rigId = persisted.rigId;
    }
    if (!persisted || !persisted.running) {
        await persistState();
        return;
    }
    miner.apiPort = persisted.apiPort || 0;
    miner.apiToken = persisted.apiToken || '';
    miner.address = persisted.address || null;
    miner.threads = persisted.threads || 0;
    miner.afk = !!persisted.afk;
    miner.pid = persisted.pid || null;
    miner.elevated = !!persisted.elevated;
    await persistState();
    try {
        miner.lastSummary = await xmrigApi('GET', '/2/summary');
        miner.lastSummaryAt = Date.now();
        miner.running = true;
        miner.startedAt = Date.now() - Math.floor(((miner.lastSummary.uptime || 0) * 1000));
        startMonitors();
        console.log('[miner] Re-attached to running xmrig from previous session');
    } catch (e) {
        // Not reachable: stop any orphan and clear state.
        await hardStop().catch(() => {});
    }
}

function killOnExit() {
    if (!miner.running && !miner.child && !miner.pid) return;
    // Synchronous best effort: signal the child; ask the API to stop the elevated one.
    try { if (miner.child) miner.child.kill('SIGKILL'); } catch (e) {}
    if (process.platform === 'win32' && miner.pid) {
        try { spawn('taskkill', ['/PID', String(miner.pid), '/T', '/F'], { stdio: 'ignore', detached: true }); } catch (e) {}
        try {
            // Fire-and-forget API stop for the elevated case; may not complete on hard exits.
            http.request({
                host: '127.0.0.1', port: miner.apiPort, path: '/json_rpc', method: 'POST',
                headers: { Authorization: `Bearer ${miner.apiToken}`, 'Content-Type': 'application/json' },
            }).end(JSON.stringify({ method: 'stop', id: 1, jsonrpc: '2.0' }));
        } catch (e) {}
    } else if (miner.pid) {
        try { process.kill(miner.pid, 'SIGKILL'); } catch (e) {}
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function isLoopbackRequest(req) {
    const addr = String(req.socket?.remoteAddress || '');
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function registerMiningRoutes(app, ctx) {
    const {
        desktopSidecar,
        blockIfNotAdmin,
        validateCsrfToken,
        axiosInstance,
        dataDir,
        cpuCount,
    } = ctx;

    minerDirRoot = path.join(dataDir, 'miner');
    if (Number.isFinite(cpuCount) && cpuCount > 0) cpuCountRef = cpuCount;
    try {
        fs.mkdirSync(minerDirRoot, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(minerDirRoot, 0o700);
    } catch (e) {
        throw new Error(`Unable to secure miner data directory: ${e.message}`);
    }

    // ------------------------- stats proxy (all platforms) -------------------
    async function proxyPoolJson(res, cacheKey, ttlMs, poolPath) {
        const hit = cacheGet(cacheKey, ttlMs);
        if (hit) {
            res.setHeader('X-Cache', 'hit');
            return res.status(hit.status).json(hit.data);
        }
        try {
            const resp = await axiosInstance.get(`${POOL_API_BASE}${poolPath}`, {
                timeout: 15000,
                headers: { Accept: 'application/json' },
                validateStatus: (s) => s >= 200 && s < 500,
            });
            cacheSet(cacheKey, resp.status, resp.data);
            return res.status(resp.status).json(resp.data);
        } catch (err) {
            const stale = proxyCache.get(cacheKey);
            if (stale) return res.status(stale.status).json(stale.data);
            return res.status(502).json({ error: 'pool unreachable' });
        }
    }

    const requireAddress = (req, res) => {
        const address = String(req.query.address || '').trim();
        if (!isValidSalviumAddress(address)) {
            res.status(400).json({ error: 'invalid address' });
            return null;
        }
        return address;
    };

    app.get(['/api/mining/config', '/vault/api/mining/config'], (req, res) => {
        return proxyPoolJson(res, 'pool:config', 5 * 60 * 1000, '/config');
    });

    app.get(['/api/mining/stats', '/vault/api/mining/stats'], (req, res) => {
        const address = requireAddress(req, res);
        if (!address) return;
        return proxyPoolJson(res, `stats:${address}`, 10000, `/miner/${address}/stats`);
    });

    app.get(['/api/mining/snapshot', '/vault/api/mining/snapshot'], (req, res) => {
        const address = requireAddress(req, res);
        if (!address) return;
        return proxyPoolJson(res, `snapshot:${address}`, 10000, `/api/miner/${address}/page-snapshot`);
    });

    app.get(['/api/mining/workers', '/vault/api/mining/workers'], (req, res) => {
        const address = requireAddress(req, res);
        if (!address) return;
        // Same source as the pool website's worker table (live, canonically
        // scaled) — the page-snapshot's embedded workers use a raw 10-minute
        // share-difficulty sum that visibly disagrees with the stats hashrate.
        return proxyPoolJson(res, `workers:${address}`, 10000, `/miner/${address}/stats/allWorkers`);
    });

    app.get(['/api/mining/payments', '/vault/api/mining/payments'], (req, res) => {
        const address = requireAddress(req, res);
        if (!address) return;
        const page = Math.max(0, parseInt(String(req.query.page || '0'), 10) || 0);
        const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || '10'), 10) || 10));
        return proxyPoolJson(
            res,
            `payments:${address}:${page}:${limit}`,
            10000,
            `/miner/${address}/payments?page=${page}&limit=${limit}`
        );
    });

    // ------------------------- control (desktop sidecar only) ----------------
    // The sidecar binds all interfaces, so the desktop gate alone is not enough:
    // control requires loopback, and mutations require the SPA's CSRF token.
    function gateControl(req, res, { mutating }) {
        if (!desktopSidecar) return blockIfNotAdmin(req, res);
        if (!isLoopbackRequest(req)) {
            res.status(403).json({ error: 'forbidden' });
            return true;
        }
        if (mutating) {
            const token = String(req.headers['x-csrf-token'] || '');
            const sessionId = String(req.headers['x-session-id'] || 'anonymous');
            if (!token || !validateCsrfToken(token, sessionId)) {
                res.status(403).json({ error: 'Invalid or missing CSRF token' });
                return true;
            }
        }
        return false;
    }

    app.get(['/api/mining/status', '/vault/api/mining/status'], (req, res) => {
        if (gateControl(req, res, { mutating: false })) return;
        res.json(statusPayload());
    });

    app.post(['/api/mining/start', '/vault/api/mining/start'], async (req, res) => {
        if (gateControl(req, res, { mutating: true })) return;
        const body = req.body || {};
        const address = String(body.address || '').trim();
        if (!isValidSalviumAddress(address)) return res.status(400).json({ error: 'invalid address' });
        let threads = parseInt(String(body.threads), 10);
        if (!Number.isFinite(threads) || threads < 1) threads = Math.max(1, Math.floor(cpuCountRef / 2));
        threads = Math.min(threads, cpuCountRef);
        try {
            await startMining({ address, threads, afk: !!body.afk });
            res.json({ success: true, status: statusPayload() });
        } catch (err) {
            console.error('[miner] start failed:', err.message);
            res.status(500).json({ error: err.message, status: statusPayload() });
        }
    });

    app.post(['/api/mining/stop', '/vault/api/mining/stop'], async (req, res) => {
        if (gateControl(req, res, { mutating: true })) return;
        try {
            await hardStop();
            res.json({ success: true, status: statusPayload() });
        } catch (err) {
            res.status(500).json({ error: err.message, status: statusPayload() });
        }
    });

    app.post(['/api/mining/threads', '/vault/api/mining/threads'], async (req, res) => {
        if (gateControl(req, res, { mutating: true })) return;
        let threads = parseInt(String((req.body || {}).threads), 10);
        if (!Number.isFinite(threads) || threads < 1 || threads > cpuCountRef) {
            return res.status(400).json({ error: 'invalid thread count' });
        }
        try {
            if (miner.running) {
                try {
                    await setThreadsLive(threads);
                    miner.threads = threads;
                    // The config PUT preserves the pause flag (verified), but re-assert
                    // AFK pause defensively so a re-tune can never wake a paused miner.
                    if (miner.afkPaused) await xmrigRpc('pause').catch(() => {});
                    await persistState();
                } catch (liveErr) {
                    // Fallback: full restart (re-prompts elevation on Windows/Linux).
                    console.warn(`[miner] live thread re-tune failed, restarting: ${liveErr.message}`);
                    const address = miner.address;
                    const afk = miner.afk;
                    await hardStop();
                    await startMining({ address, threads, afk });
                }
            } else {
                miner.threads = threads;
                await persistState();
            }
            res.json({ success: true, status: statusPayload() });
        } catch (err) {
            res.status(500).json({ error: err.message, status: statusPayload() });
        }
    });

    app.post(['/api/mining/afk', '/vault/api/mining/afk'], async (req, res) => {
        if (gateControl(req, res, { mutating: true })) return;
        miner.afk = !!(req.body || {}).afk;
        if (!miner.afk && miner.afkPaused) {
            miner.afkPaused = false;
            await xmrigRpc('resume').catch(() => {});
        }
        await persistState();
        res.json({ success: true, status: statusPayload() });
    });

    if (desktopSidecar) {
        reconcilePersistedState().catch(() => {});
        process.on('exit', killOnExit);
        const signalExit = () => { killOnExit(); process.exit(0); };
        process.once('SIGINT', signalExit);
        process.once('SIGTERM', signalExit);
    }
}

module.exports = {
    registerMiningRoutes,
    _test: {
        assertAllowedDownloadUrl,
        validateArchiveListing,
        expectedAssetHashes: XMRIG_ASSET_SHA256,
        persistState,
        loadPersistedState,
        setMinerDirRoot: (dir) => { minerDirRoot = dir; },
        getMinerState: () => ({ ...miner }),
    },
};
