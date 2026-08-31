// Unit tests for the Lychee check wrapper's pure helpers: GitHub-token
// resolution and byte-exact .lycheecache normalization. The lychee invocation
// itself needs the binary and is not exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_DEAD_LINKS,
  EXIT_OK,
  EXIT_PREFLIGHT,
  mapLycheeExit,
  parseTotalChecked,
  publicDirOf,
  resolveToken,
  sortCacheText,
} from './index.mjs';

// --- resolveToken ---

test('resolveToken prefers a token already in the environment', () => {
  let ghCalled = false;
  const token = resolveToken({
    env: { GITHUB_TOKEN: 'env-token' },
    runGh: () => {
      ghCalled = true;
      return 'gh-token';
    },
  });
  assert.equal(token, 'env-token', 'the environment token wins');
  assert.equal(ghCalled, false, 'gh is left alone when the env has a token');
});

test('resolveToken falls back to gh when the environment has none', () => {
  const token = resolveToken({ env: {}, runGh: () => 'gh-token' });
  assert.equal(token, 'gh-token', 'the gh token is used as a fallback');
});

test('resolveToken yields an empty string when no source has a token', () => {
  const token = resolveToken({ env: {}, runGh: () => '' });
  assert.equal(token, '', 'empty when unauthenticated');
});

test('resolveToken treats a blank environment token as absent', () => {
  const token = resolveToken({
    env: { GITHUB_TOKEN: '  ' },
    runGh: () => 'gh-token',
  });
  assert.equal(token, 'gh-token', 'whitespace is not a usable token');
});

// --- sortCacheText ---

test('sortCacheText orders lines and keeps one trailing newline', () => {
  assert.equal(sortCacheText('c\na\nb\n'), 'a\nb\nc\n', 'lines sorted');
});

test('sortCacheText appends a trailing newline when the input lacks one', () => {
  assert.equal(sortCacheText('b\na'), 'a\nb\n', 'output is newline-terminated');
});

test('sortCacheText is idempotent on already-sorted text', () => {
  const sorted = 'a\nb\nc\n';
  assert.equal(
    sortCacheText(sorted),
    sorted,
    'sorting a sorted cache is a no-op',
  );
});

test('sortCacheText returns empty for empty input', () => {
  assert.equal(sortCacheText(''), '', 'an empty cache stays empty');
});

test('sortCacheText sorts by byte value (C locale), not UTF-16 code unit', () => {
  // U+E000 (private-use, BMP) is the single UTF-16 unit 0xE000; U+1F600 is the
  // surrogate pair 0xD83D 0xDE00. A naive String `<` sort orders by the lead
  // surrogate (0xD83D < 0xE000) and would put U+1F600 first; LC_ALL=C / UTF-8
  // byte order puts U+E000 first. Buffer.compare matches the committed cache.
  const a = '\uE000,200,1\n';
  const b = '\u{1F600},200,1\n';
  assert.equal(sortCacheText(b + a), a + b, 'byte order keeps U+E000 first');
});

// --- publicDirOf ---

test('publicDirOf returns the lexical path for a plain directory', () => {
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    mkdirSync(join(site, 'public'));
    assert.equal(publicDirOf(site), join(site, 'public'), 'public dir found');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test(
  'publicDirOf keeps the lexical path when public is a symlink',
  { skip: process.platform === 'win32' ? 'POSIX symlinks only' : false },
  () => {
    // Sites often symlink public/ to a separate (diffable) git repo. The
    // /public/-anchored exclude_path patterns in lychee.toml only match if the
    // path handed to lychee still ends in /public — resolving the symlink
    // would silently disable every exclusion.
    const dir = mkdtempSync(join(tmpdir(), 'lnc-'));
    try {
      const target = join(dir, 'site.g');
      mkdirSync(target);
      const site = join(dir, 'site');
      mkdirSync(site);
      symlinkSync(target, join(site, 'public'));
      assert.equal(
        publicDirOf(site),
        join(site, 'public'),
        'the /public path component is preserved',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('publicDirOf returns null when public is missing', () => {
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    assert.equal(publicDirOf(site), null, 'missing public dir is reported');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test(
  'publicDirOf returns null for a dangling public symlink',
  { skip: process.platform === 'win32' ? 'POSIX symlinks only' : false },
  () => {
    const site = mkdtempSync(join(tmpdir(), 'lnc-'));
    try {
      symlinkSync(join(site, 'no-such-target'), join(site, 'public'));
      assert.equal(publicDirOf(site), null, 'dangling symlink is reported');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

// --- exit-code mapping & zero-links sanity ---

test('mapLycheeExit maps broken links (2) to dead-links exit 1', () => {
  assert.equal(mapLycheeExit(2), EXIT_DEAD_LINKS, 'dead links exit 1');
});

test('mapLycheeExit passes success through', () => {
  assert.equal(mapLycheeExit(0), EXIT_OK, 'success exits 0');
});

test('mapLycheeExit maps config/runtime errors to preflight exit 2', () => {
  assert.equal(mapLycheeExit(3), EXIT_PREFLIGHT, 'config error is preflight');
  assert.equal(mapLycheeExit(1), EXIT_PREFLIGHT, 'runtime error is preflight');
});

test('parseTotalChecked reads the human summary line', () => {
  assert.equal(
    parseTotalChecked('🔍 1234 Total (in 3s) 🔗 900 Unique ✅ 1234 OK'),
    1234,
    'summary total parsed',
  );
});

test('parseTotalChecked reads --format json output', () => {
  assert.equal(
    parseTotalChecked('{"total": 42, "successful": 42}'),
    42,
    'json total parsed',
  );
});

test('parseTotalChecked yields null for unrecognized output', () => {
  assert.equal(parseTotalChecked('nothing here'), null, 'unknown format');
});

test('missing public/ is a preflight failure: exit 2', () => {
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    const r = spawnSync(process.execPath, [script], {
      cwd: site,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, 'preflight failures exit 2');
    assert.match(r.stderr, /public/, 'the missing dir is named');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('missing lychee binary is a preflight failure: exit 2', () => {
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    mkdirSync(join(site, 'public'));
    const r = spawnSync(process.execPath, [script], {
      cwd: site,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(r.status, 2, 'preflight failures exit 2');
    assert.match(r.stderr, /lychee not found/, 'the missing tool is named');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

// --- --migrate ---

test('--migrate converts .lycheecache to link-cache.jsonc', () => {
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    writeFileSync(join(site, '.lycheecache'), 'https://a.example/,200,100\n');
    const r = spawnSync(process.execPath, [script, '--migrate'], {
      cwd: site,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'migration succeeds');
    const owned = readFileSync(join(site, 'link-cache.jsonc'), 'utf8');
    assert.match(owned, /"via": "lychee"/, 'entries credited to lychee');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('--migrate refuses to overwrite an existing link-cache.jsonc', () => {
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    writeFileSync(join(site, '.lycheecache'), 'https://a.example/,200,100\n');
    writeFileSync(join(site, 'link-cache.jsonc'), '{\n}\n');
    const r = spawnSync(process.execPath, [script, '--migrate'], {
      cwd: site,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, 'refusal is a preflight failure');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

// --- CLI: --help short-circuits before the lychee check ---

test('--help prints usage and exits 0 without needing lychee', () => {
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'help exits 0');
  assert.match(r.stdout, /Usage: lychee-norm-cache/, 'help prints usage');
});

test(
  'runs when invoked through a bin symlink (npx)',
  { skip: process.platform === 'win32' ? 'POSIX symlink bins only' : false },
  () => {
    // A naive `file://${argv[1]}` guard misses the symlink and silently skips
    // main(), so `npx lychee-norm-cache` would do nothing.
    const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'lnc-'));
    const link = join(dir, 'lychee-norm-cache');
    symlinkSync(script, link);
    try {
      const r = spawnSync(process.execPath, [link, '--help'], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, 'help exits 0');
      assert.match(
        r.stdout,
        /Usage: lychee-norm-cache/,
        'main ran via the symlink',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
