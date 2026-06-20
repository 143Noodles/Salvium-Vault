#!/usr/bin/env node
// Type-check gate for a codebase with pre-existing tsc errors. Runs `tsc --noEmit`,
// reduces each error to a line-number-independent signature (file::code::message),
// and FAILS only when a signature appears MORE than the committed baseline allows —
// i.e. on NEW type errors in changed code. This would have caught the LoadingScreen
// TDZ (TS2448 "used before its declaration"). The build (vite/esbuild) does not type-check.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, 'tsc-baseline.json');
const update = process.argv.includes('--update-baseline');

let out = '';
try {
  out = execSync('npx tsc --noEmit', { cwd: path.join(here, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = `${e.stdout || ''}${e.stderr || ''}`; // tsc exits non-zero when there are errors
}

const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const counts = {};
for (const line of out.split('\n')) {
  const m = line.match(re);
  if (!m) continue;
  const sig = `${m[1]}::${m[4]}::${m[5]}`;
  counts[sig] = (counts[sig] || 0) + 1;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`[typecheck] baseline written: ${Object.keys(counts).length} signatures, ${total} pre-existing errors`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const offenders = [];
for (const [sig, n] of Object.entries(counts)) {
  const allowed = baseline[sig] || 0;
  if (n > allowed) offenders.push(`  + ${sig.replace(/::/g, '  ')}  [now ${n}, baseline ${allowed}]`);
}
if (offenders.length) {
  console.error(`\n[typecheck] FAIL — ${offenders.length} NEW type error(s) vs baseline (the build/esbuild does NOT catch these):`);
  console.error(offenders.join('\n'));
  console.error(`\nFix them. If genuinely intentional, regenerate the baseline: npm run typecheck:update-baseline\n`);
  process.exit(1);
}
console.log(`[typecheck] OK — no new type errors (${total} pre-existing, ${Object.keys(baseline).length} baseline signatures)`);
process.exit(0);
