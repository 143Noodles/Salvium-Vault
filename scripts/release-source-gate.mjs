import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fallbackEpoch(repo) {
  const supplied = process.env.SOURCE_DATE_EPOCH;
  if (supplied && /^\d+$/.test(supplied)) return supplied;
  try {
    const value = git(repo, ['log', '-1', '--format=%ct']);
    if (/^\d+$/.test(value)) return value;
  } catch {}
  const floor = JSON.parse(fs.readFileSync(path.join(repo, 'content-version.json'), 'utf8'));
  const value = Math.floor(Date.parse(floor.builtAt) / 1000);
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error('SOURCE_DATE_EPOCH is required when no git/floor build timestamp is available');
}

/**
 * Public release artifacts must come from one clean, immutable tagged tree.
 * Test-mode fixtures may intentionally exercise dirty or untagged worktrees.
 */
export function assertReleaseSource(repo, version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(version || ''))) {
    throw new Error('release version must be stable x.y.z semver');
  }
  if (process.env.SALVIUM_RELEASE_TEST_MODE === '1') return fallbackEpoch(repo);

  const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    throw new Error('public release requires a clean checkout; commit or remove every tracked and untracked change');
  }
  const head = git(repo, ['rev-parse', 'HEAD']);
  let taggedCommit;
  try {
    taggedCommit = git(repo, ['rev-parse', `refs/tags/v${version}^{commit}`]);
  } catch {
    throw new Error(`public release requires an existing v${version} tag`);
  }
  if (taggedCommit !== head) throw new Error(`v${version} does not resolve to the checked-out HEAD`);

  const floor = JSON.parse(fs.readFileSync(path.join(repo, 'content-version.json'), 'utf8'));
  if (floor.version !== version) {
    throw new Error(`content-version.json is ${floor.version || 'missing'}, expected ${version}`);
  }

  const tagEpoch = git(repo, ['show', '-s', '--format=%ct', taggedCommit]);
  if (!/^\d+$/.test(tagEpoch)) throw new Error('could not derive the tagged release timestamp');
  if (process.env.SOURCE_DATE_EPOCH && process.env.SOURCE_DATE_EPOCH !== tagEpoch) {
    throw new Error(`SOURCE_DATE_EPOCH must equal tagged commit time ${tagEpoch}`);
  }
  return tagEpoch;
}
