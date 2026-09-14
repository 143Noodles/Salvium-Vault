// Local (./ ../) modules the desktop sidecar needs at runtime, resolved
// transitively from its entry points. The OTA content publisher and the
// installer-coverage test both use this so a new require() can never be left
// out of a package again: 0.2.14-0.2.24 shipped without mempool-poller.cjs and
// the sidecar could not boot, so every desktop OTA rolled back to the floor.
import fs from 'node:fs';
import path from 'node:path';

export const SIDECAR_ENTRIES = ['server.cjs', 'server-csp-worker.cjs', 'services/minerManager.cjs'];
const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function resolveLocal(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  for (const c of [base, base + '.js', base + '.cjs', base + '.json', path.join(base, 'index.js'), path.join(base, 'index.cjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`unresolved local require ${spec} from ${fromDir}`);
}

export function collectSidecarLocalModules(repoRoot) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(REQUIRE_RE)) walk(resolveLocal(path.dirname(file), m[1]));
  };
  for (const entry of SIDECAR_ENTRIES) walk(path.join(repoRoot, entry));
  return [...seen].map((f) => path.relative(repoRoot, f).split(path.sep).join('/')).sort();
}
