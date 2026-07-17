import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertReleaseSource } from '../scripts/release-source-gate.mjs';

let repo = '';
const git = (...args: string[]): string => execFileSync('git', args, {
  cwd: repo,
  encoding: 'utf8',
}).trim();

beforeEach(() => {
  delete process.env.SALVIUM_RELEASE_TEST_MODE;
  delete process.env.SOURCE_DATE_EPOCH;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'salvium-release-source-'));
  git('init', '-q');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@invalid.example');
  fs.writeFileSync(path.join(repo, 'content-version.json'), JSON.stringify({
    version: '1.2.3',
    builtAt: '2026-07-16T00:00:00.000Z',
  }));
  git('add', 'content-version.json');
  git('commit', '-q', '-m', 'release source');
  git('tag', 'v1.2.3');
});

afterEach(() => {
  delete process.env.SALVIUM_RELEASE_TEST_MODE;
  delete process.env.SOURCE_DATE_EPOCH;
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('public content release source gate', () => {
  it('accepts only a clean HEAD resolved by the matching release tag', () => {
    const expectedEpoch = git('show', '-s', '--format=%ct', 'HEAD');
    expect(assertReleaseSource(repo, '1.2.3')).toBe(expectedEpoch);
    process.env.SOURCE_DATE_EPOCH = expectedEpoch;
    expect(assertReleaseSource(repo, '1.2.3')).toBe(expectedEpoch);
  });

  it('rejects dirty, untagged, mismatched-version, and timestamp-spoofed releases', () => {
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'not reviewed');
    expect(() => assertReleaseSource(repo, '1.2.3')).toThrow(/clean checkout/);
    fs.rmSync(path.join(repo, 'untracked.txt'));
    expect(() => assertReleaseSource(repo, '1.2.4')).toThrow(/existing v1\.2\.4 tag/);
    process.env.SOURCE_DATE_EPOCH = '1';
    expect(() => assertReleaseSource(repo, '1.2.3')).toThrow(/tagged commit time/);
  });

  it('allows explicitly marked test fixtures without weakening the public path', () => {
    process.env.SALVIUM_RELEASE_TEST_MODE = '1';
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'fixture');
    expect(assertReleaseSource(repo, '9.9.9')).toMatch(/^\d+$/);
  });
});
