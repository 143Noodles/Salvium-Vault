import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('unified desktop and Android content release', () => {
  it('refuses a partial Latest release and stages both signed manifests', () => {
    const unified = read('scripts/publish-content-release.mjs');
    expect(unified).toContain("'content-manifest.json'");
    expect(unified).toContain("'android-content-manifest.json'");
    expect(unified).toContain('desktop and Android manifests must use the same release version');
    expect(unified).toContain('Do not expose or move Latest');
    expect(unified).toContain('--draft');
    expect(unified).toContain('--draft=false --latest');
    expect(unified).toContain('--verify-tag');
    expect(unified).toContain("SKIP_BUILD: '1'");
    expect(unified).toContain("assertLockedDependency('vite')");
    expect(unified).toContain("assertLockedDependency('tar', path.join(REPO, 'desktop'))");
    expect(unified).toContain('run npm ci && npm --prefix desktop ci in a clean checkout');
    expect(unified).toContain("SALVIUM_RELEASE_TEST_MODE !== '1'");
    expect(unified).toContain('SOURCE_DATE_EPOCH');
    expect(unified).toContain('reproducible timestamp');
    expect(unified).toContain('scripts/verify-content-release.mjs');
    const gate = read('scripts/release-source-gate.mjs');
    expect(gate).toContain("status', '--porcelain=v1', '--untracked-files=all");
    expect(gate).toContain('refs/tags/v${version}^{commit}');
    expect(gate).toContain('public release requires a clean checkout');
  });

  it('warns platform-specific publishers not to replace Latest alone', () => {
    const desktop = read('desktop/scripts/publish-content.mjs');
    expect(desktop).toContain('Do not mark a desktop-only release Latest');
    expect(desktop).toContain('EXPECTED_PUBLIC_KEY_BASE64');
    expect(desktop).toContain('content signing key permissions must be owner-only');
    expect(desktop).toContain('minShellVersion');
    expect(desktop).toContain('mtime: sourceDate');
    expect(read('scripts/publish-android-content.mjs')).toContain('Do not mark an Android-only release Latest');
    expect(read('scripts/publish-android-content.mjs')).toContain('normalizeTreeTimes(stagingDir, sourceDate)');
  });

  it('packages every sidecar module required by the updated server', () => {
    const desktop = read('desktop/scripts/publish-content.mjs');
    expect(desktop).toContain("'utils/canonicalTxMembership.cjs'");
    expect(desktop).toContain('[publish] required content is missing:');
    expect(desktop).toContain('assertNoSymlinks(src)');
    expect(read('desktop/package.json')).toContain('utils/canonicalTxMembership.cjs');
    const updater = read('desktop/content-update.js');
    expect(updater).toContain('metadata.minShellVersion !== manifest.minShellVersion');
    expect(updater).toContain('verGt(metadata.minShellVersion, app.getVersion())');
    expect(updater).toContain('assertOfficialArchiveUrl(manifest.url, manifest.version)');
    expect(updater).toContain("parsed.protocol !== 'https:'");
  });
});
