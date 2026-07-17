import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('upgrade-safe strict CSP readiness gate', () => {
  it('binds readiness to the exact app, service-worker, and WASM generation', () => {
    const server = read('server.cjs');

    expect(server).toContain('`${bundleId}\\n${swBuildId}\\n${wasmVersion}`');
    expect(server).toContain("crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(descriptor.generation))");
    expect(server).toContain("CSP_EVAL_FREE_READY_COOKIE = 'salvium_eval_free_ready'");
    expect(server).toContain("httpOnly: true");
    expect(server).toContain("sameSite: 'strict'");
    expect(server).toContain("requestOrigin !== publicOrigin");
    expect(server).toContain("fetchSite !== 'same-origin'");
  });

  it('withholds readiness until every stable same-scope window proves the generation', () => {
    const serviceWorker = read('public/sw.js');
    const app = read('index.tsx');

    expect(serviceWorker).toContain("includeUncontrolled: true");
    expect(serviceWorker).toContain("reason: 'client-set-changed'");
    expect(serviceWorker).toContain("pending.acknowledgedIds.has(id)");
    expect(serviceWorker).toContain("runtime.swBuildId !== SW_BUILD_ID");
    expect(serviceWorker).toContain("runtime.wasmVersion !== WASM_VERSION");
    expect(app).toContain("data.type === 'SALVIUM_CSP_CLIENT_PROBE'");
    expect(app).toContain("if (!scope.ready)");
    expect(app).toContain("scope.reason === 'service-worker-generation-mismatch'");
    expect(app).toContain('service_worker_generation_mismatch:${runtime.swBuildId}:${runtime.wasmVersion}');
    expect(app.indexOf("if (!scope.ready)")).toBeLessThan(app.indexOf("fetch('/api/csp-readiness/ack'"));
  });

  it('can force strict CSP on the cacheless public test host', () => {
    const server = read('server.cjs');
    const app = read('index.tsx');
    const rollout = read('scripts/qa/CSP_UNSAFE_EVAL_ROLLOUT.md');

    expect(app).toContain('if (isTestVaultHost)');
    expect(app).toContain('Service worker disabled on test vault domain');
    expect(server).toContain("process.env.SALVIUM_CSP_FORCE_STRICT === '1'");
    expect(rollout).toContain('SALVIUM_CSP_FORCE_STRICT=1');
  });

  it('does not persist a permissive worker response into the strict generation', () => {
    const server = read('server.cjs');

    expect(server).toContain("appendVaryHeader(res, ['User-Agent', 'Cookie'])");
    expect(server).toContain("'Cache-Control', 'private, no-store, no-cache, must-revalidate, proxy-revalidate'");
    expect(server).toContain('if (isCspVariantSensitiveRequest(req))');
    expect(server).not.toContain("res.locals.cspMode !== 'legacy'");
    const workerHeaders = server.slice(
      server.indexOf('function walletStaticSetHeaders'),
      server.indexOf('const v = res.req', server.indexOf('function walletStaticSetHeaders')),
    );
    expect(workerHeaders).not.toContain('immutable');
  });

  it('activates an update whose installation started before register resolved', () => {
    const app = read('index.tsx');
    const watchExisting = 'watchInstallingServiceWorker(registration, registration.installing);';
    const forceUpdate = 'registration.update().catch((error) => {';

    expect(app).toContain('worker.postMessage({ type: \'SKIP_WAITING\' })');
    expect(app).toContain(watchExisting);
    expect(app.indexOf(watchExisting)).toBeLessThan(app.indexOf(forceUpdate));
    expect(read('public/sw.js')).toContain('event.waitUntil(self.skipWaiting())');
  });
});
