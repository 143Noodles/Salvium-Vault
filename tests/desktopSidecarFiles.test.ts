import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore plain ESM helper shared with desktop/scripts/publish-content.mjs
import { collectSidecarLocalModules } from '../scripts/sidecar-local-modules.mjs';

const REPO = process.cwd();

describe('desktop packages carry every local module the sidecar requires', () => {
  it('installer extraResources filter covers the sidecar require closure', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop/package.json'), 'utf8'));
    const filter: string[] = pkg.build.extraResources[0].filter;
    const covered = (rel: string) => filter.some((f) => f === rel || (f.endsWith('/**') && rel.startsWith(f.slice(0, -2))));
    expect(collectSidecarLocalModules(REPO).filter((rel) => !covered(rel))).toEqual([]);
  });
});
