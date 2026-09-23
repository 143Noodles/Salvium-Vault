import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A user-pinned custom node that went down (2026-09-23) turned single-node routes into 500s
// although the request's order continued with seeds and the hosted daemon. Runs the real
// selection code from server.cjs against stubbed node state.
const source = readFileSync(path.resolve(process.cwd(), 'server.cjs'), 'utf8');

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function loadSelection() {
  const selection = slice('const NODE_CONNECTION_FAILURE_TTL_MS', 'function pickDaemonNode()') +
    slice('function pickDaemonNode()', 'setInterval(() => { refreshNodeHealth()');
  const interceptor = slice('const NODE_DOWN_CODES', '// Build this request\'s node failover order');
  const custom = 'http://144.76.16.241:19081';
  const seed = 'http://seed01.salvium.io:19081';
  const hosted = 'http://salvium:19081';
  const handlers: { ok?: (r: any) => any; fail?: (e: any) => any } = {};
  const axiosInstance = { interceptors: { response: { use: (ok: any, fail: any) => { handlers.ok = ok; handlers.fail = fail; } } } };
  const order = [custom, seed, hosted];
  // eslint-disable-next-line no-new-func
  const api = new Function('axiosInstance', 'HOSTED_DAEMON_URL', 'nodeContext', 'nodeHeight', 'customNodeCache', 'RPC_NODES', 'NODE_STALE_BLOCKS', 'healthyOrder', 'activeBlockFetchNode',
    `${selection}\n${interceptor}\nreturn { pickDaemonNode, nodeConnectionFailureAt };`)(
    axiosInstance, hosted, { getStore: () => ({ order }) }, {}, new Map(), [hosted, seed], 30, [hosted], hosted);
  const fail = (url: string, code: string, message = '') =>
    handlers.fail!({ code, message, config: { url: `${url}/json_rpc` } }).catch(() => {});
  const ok = (url: string) => handlers.ok!({ config: { url: `${url}/json_rpc` } });
  return { api, fail, ok, custom, seed, hosted };
}

describe('daemon node selection after connection failures', () => {
  it('fails over from a pinned node that refused a connection, and back once it answers', async () => {
    const { api, fail, ok, custom, seed } = loadSelection();
    expect(api.pickDaemonNode()).toBe(custom);
    await fail(custom, 'ECONNREFUSED');
    expect(api.pickDaemonNode()).toBe(seed);
    ok(custom);
    expect(api.pickDaemonNode()).toBe(custom);
  });

  it('treats a reset or hang-up as down for other nodes but never for the hosted daemon', async () => {
    const { api, fail, custom, hosted } = loadSelection();
    await fail(custom, 'ECONNRESET', 'socket hang up');
    expect(api.nodeConnectionFailureAt.has(new URL(custom).origin)).toBe(true);
    await fail(hosted, 'ECONNRESET', 'socket hang up');
    await fail(hosted, 'ECONNABORTED', 'timeout of 45000ms exceeded');
    expect(api.nodeConnectionFailureAt.has(new URL(hosted).origin)).toBe(false);
  });
});
