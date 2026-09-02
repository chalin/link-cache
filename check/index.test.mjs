// Tests for the Lychee check wrapper: pure helpers (token resolution, cache
// normalization, summary parsing, exit mapping) and hermetic end-to-end runs
// against a stub lychee binary — no network and no real lychee needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
  parseFailedUrls,
  parseSummary,
  publicDirOf,
  resolveToken,
  sortCacheText,
} from './index.mjs';

const WIN_SKIP =
  process.platform === 'win32' ? 'POSIX stub binaries only' : false;

const SCRIPT = fileURLToPath(new URL('./index.mjs', import.meta.url));
const SUMMARY_1OK = '🔍 1 Total (in 1ms) 🔗 1 Unique ✅ 1 OK 🚫 0 Errors';

// A scratch site with a stub `lychee` on PATH whose behavior the test scripts:
// `stdout`/`exit` set the stub's output and status, `csv` pre-seeds the cache
// lychee would leave behind (written post-invocation via a marker copy).
function makeSite({ stdout = '', exit = 0, csvAfterRun = null } = {}) {
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  const bin = join(site, 'stub-bin');
  mkdirSync(bin);
  mkdirSync(join(site, 'public'));
  const lines = ['#!/bin/sh'];
  if (csvAfterRun !== null) {
    lines.push(`cp ${JSON.stringify(join(site, 'csv-after'))} .lycheecache`);
    writeFileSync(join(site, 'csv-after'), csvAfterRun);
  }
  lines.push(`printf '%s\\n' ${JSON.stringify(stdout)}`, `exit ${exit}`);
  writeFileSync(join(bin, 'lychee'), lines.join('\n') + '\n');
  chmodSync(join(bin, 'lychee'), 0o755);
  return site;
}

function runWrapper(site, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: site,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(site, 'stub-bin')}:${process.env.PATH}`,
      GITHUB_TOKEN: 'test-token',
    },
  });
}

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
    assert.equal(
      publicDirOf(site),
      null,
      'null is returned for an absent public dir',
    );
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

// --- exit-code mapping & summary parsing ---

test('mapLycheeExit maps a completed run with broken links to exit 1', () => {
  const summary = { total: 3, ok: 2, errors: 1 };
  assert.equal(mapLycheeExit(2, summary), EXIT_DEAD_LINKS, 'dead links exit 1');
});

test('mapLycheeExit treats lychee exit 2 without a summary as preflight', () => {
  // Lychee also exits 2 for argument errors, which print no summary; warn
  // wrappers must be able to tell those from dead links.
  assert.equal(
    mapLycheeExit(2, null),
    EXIT_PREFLIGHT,
    'arg error is preflight',
  );
});

test('mapLycheeExit passes a summarized success through', () => {
  const summary = { total: 1, ok: 1, errors: 0 };
  assert.equal(mapLycheeExit(0, summary), EXIT_OK, 'success exits 0');
});

test('mapLycheeExit treats a summary-less success as preflight', () => {
  // Non-check modes and diverted output exit 0 with no summary: without proof
  // that a check completed, success is not reportable.
  assert.equal(mapLycheeExit(0, null), EXIT_PREFLIGHT, 'no summary, no pass');
});

test('mapLycheeExit maps config/runtime errors to preflight exit 2', () => {
  const summary = { total: 1, ok: 1, errors: 0 };
  assert.equal(
    mapLycheeExit(3, summary),
    EXIT_PREFLIGHT,
    'config error is preflight',
  );
  assert.equal(
    mapLycheeExit(1, null),
    EXIT_PREFLIGHT,
    'runtime error is preflight',
  );
});

test('parseSummary reads the human summary line', () => {
  assert.deepEqual(
    parseSummary('🔍 3 Total (in 3s) 🔗 2 Unique ✅ 2 OK 🚫 1 Error'),
    { total: 3, ok: 2, errors: 1 },
    'summary counts parsed',
  );
});

test('parseSummary reads --format json output', () => {
  assert.deepEqual(
    parseSummary('{"total": 42, "successful": 40, "errors": 2}'),
    { total: 42, ok: 40, errors: 2 },
    'json counts parsed',
  );
});

test('parseSummary yields null for unrecognized output', () => {
  assert.equal(parseSummary('nothing here'), null, 'unknown format');
});

test('parseFailedUrls reads human [ERROR] lines', () => {
  const out = [
    '[f.md]:',
    '[ERROR] https://dead.example/ (at 1:1) | Failed: 404',
    '     [ERROR] file:///site/missing.html | File not found',
    '🔍 2 Total (in 1s) 🔗 2 Unique ✅ 0 OK 🚫 2 Errors',
  ].join('\n');
  assert.deepEqual(
    [...parseFailedUrls(out)].sort(),
    ['file:///site/missing.html', 'https://dead.example/'],
    'both failing URLs extracted',
  );
});

test('parseFailedUrls reads status-bracket rejection lines', () => {
  // Real lychee 0.24 shapes: HTTP rejections carry a numeric status tag, not
  // [ERROR] (docsy run 33607424643); timeouts carry [TIMEOUT].
  const out = [
    '[urls.txt]:',
    '[403] https://cloud-native.slack.com/archives/CUJ6W5TLM | Rejected status code: 403 Forbidden | Followed 1 redirect. Redirects: x',
    '  [404] https://httpbin.org/status/404 (at 1:1) | Rejected status code: 404 Not Found',
    '[TIMEOUT] https://slow.example/ | Timeout',
    '🔍 3 Total (in 1s) 🔗 3 Unique ✅ 0 OK 🚫 3 Errors',
  ].join('\n');
  assert.deepEqual(
    [...parseFailedUrls(out)].sort(),
    [
      'https://cloud-native.slack.com/archives/CUJ6W5TLM',
      'https://httpbin.org/status/404',
      'https://slow.example/',
    ],
    'status-bracket and timeout failures extracted',
  );
});

test('parseFailedUrls ignores verbose success lines', () => {
  // `lychee -vv` prints per-URL success lines with a numeric status tag and
  // (for cached results) a `| Cached:` suffix; neither is a failure.
  const out = [
    '[200] https://ok.example/ (at 2:1)',
    '[200] https://cached.example/ | Cached: OK (cached)',
    '[301] https://moved.example/ (at 3:1)',
    '[404] https://dead.example/ (at 1:1) | Rejected status code: 404 Not Found',
    '🔍 4 Total (in 1s) 🔗 4 Unique ✅ 3 OK 🚫 1 Error',
  ].join('\n');
  assert.deepEqual(
    [...parseFailedUrls(out)],
    ['https://dead.example/'],
    'only the rejected URL is treated as failing',
  );
});

test('parseFailedUrls reads --format json fail_map', () => {
  const out = JSON.stringify({
    total: 2,
    successful: 1,
    errors: 1,
    fail_map: {
      'public/index.html': [{ url: 'https://dead.example/', status: 'Failed' }],
    },
  });
  assert.deepEqual(
    [...parseFailedUrls(out)],
    ['https://dead.example/'],
    'fail_map URL extracted',
  );
});

test('parseFailedUrls yields an empty set for a clean run', () => {
  assert.equal(
    parseFailedUrls('🔍 1 Total (in 1s) 🔗 1 Unique ✅ 1 OK 🚫 0 Errors').size,
    0,
    'a clean summary reports nothing failing',
  );
});

// --- end-to-end against the stub lychee ---

test(
  'missing public/ is a preflight failure: exit 2',
  { skip: WIN_SKIP },
  () => {
    const site = makeSite(); // stub lychee on PATH, so the public check is reached
    rmSync(join(site, 'public'), { recursive: true });
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 2, 'preflight failures exit 2');
      assert.match(r.stderr, /public/, 'the error names the public dir');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

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
    assert.match(r.stderr, /lychee not found/, 'the error names lychee');
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

const OWNED_WITH_EXPIRED = `{
  // seed
  "https://seed.example/": {
    "status": 206,
    "when": "2020-01-01T00:00:00Z",
    "via": "manual",
    "expires": "2020-06-30",
  },
}
`;

const OWNED_WITH_SEED = `{
  // range seed
  "https://seed.example/x": {
    "status": 206,
    "when": "2026-08-01T00:00:00Z",
    "via": "manual",
    "expires": "2027-01-01",
  },
}
`;

test(
  'a preflight failure leaves both caches untouched',
  { skip: WIN_SKIP },
  () => {
    // Expired entries are omitted from the projection, so folding a run that
    // never happened would mislabel them as failed (-40).
    const site = makeSite({ stdout: 'error: bad usage', exit: 2 });
    writeFileSync(join(site, 'link-cache.jsonc'), OWNED_WITH_EXPIRED);
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 2, 'arg errors are preflight, exit 2');
      assert.equal(
        readFileSync(join(site, 'link-cache.jsonc'), 'utf8'),
        OWNED_WITH_EXPIRED,
        'the owned cache is byte-identical after a preflight failure',
      );
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'a malformed owned cache is a preflight failure: exit 2',
  { skip: WIN_SKIP },
  () => {
    const site = makeSite();
    writeFileSync(join(site, 'link-cache.jsonc'), '{\n  garbage,\n}\n');
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 2, 'wrapper exceptions exit 2, not 1');
      assert.match(r.stderr, /invalid JSONC/, 'the error names the cause');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'a fully-excluded clean run is a zero-check failure: exit 2',
  { skip: WIN_SKIP },
  () => {
    const site = makeSite({
      stdout:
        '🔍 2 Total (in 1ms) 🔗 2 Unique ✅ 0 OK 🚫 0 Errors 👻 2 Excluded',
      exit: 0,
    });
    try {
      const r = runWrapper(site);
      assert.equal(
        r.status,
        2,
        'a verdict-free clean run fails the sanity check',
      );
      assert.match(r.stderr, /0 links/, 'the error names the zero-check');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'a fully-cached clean run passes: cache hits count as OK',
  { skip: WIN_SKIP },
  () => {
    const csv = 'https://a.example/,200,1788190000\n';
    const site = makeSite({
      stdout: '🔍 1 Total (in 1ms) 🔗 1 Unique ✅ 1 OK 🚫 0 Errors',
      exit: 0,
      csvAfterRun: csv,
    });
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 0, 'a cache-hit-only clean run passes');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'the wrapper passes --cache to lychee and rejects --cache=false',
  { skip: WIN_SKIP },
  () => {
    // Without the cache, a successful run would erase every projected entry on
    // merge-back; the stub records its argv so the flag is observable.
    const site = makeSite({ stdout: SUMMARY_1OK, exit: 0 });
    writeFileSync(
      join(site, 'stub-bin', 'lychee'),
      `#!/bin/sh\necho "$@" > argv.txt\nprintf '%s\\n' ${JSON.stringify(SUMMARY_1OK)}\nexit 0\n`,
    );
    chmodSync(join(site, 'stub-bin', 'lychee'), 0o755);
    writeFileSync(
      join(site, 'link-cache.jsonc'),
      '{\n  "https://a.example/": {\n    "status": 200,\n    "when": "2026-01-01T00:00:00Z",\n    "via": "lychee",\n  },\n}\n',
    );
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 0, 'run succeeds');
      assert.match(
        readFileSync(join(site, 'argv.txt'), 'utf8'),
        /--cache\b/,
        'lychee runs with the cache enabled',
      );
      const rejected = runWrapper(site, ['--cache=false']);
      assert.equal(rejected.status, 2, 'an explicit cache opt-out is rejected');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'lychee exit 2 with a summary is dead links: exit 1',
  { skip: WIN_SKIP },
  () => {
    const site = makeSite({
      stdout: '🔍 2 Total (in 1s) 🔗 2 Unique ✅ 1 OK 🚫 1 Error',
      exit: 2,
      csvAfterRun: 'https://ok.example/,200,1788190000\n',
    });
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 1, 'a completed run with failures exits 1');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'lychee exit 0 without a summary is preflight: no false-clean',
  { skip: WIN_SKIP },
  () => {
    // Non-check modes (--dump-inputs) and diverted output (--output FILE,
    // --format junit) exit 0 without a stdout summary; without proof that a
    // check completed, the wrapper must not report success.
    const site = makeSite({ stdout: 'inputs listed', exit: 0 });
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 2, 'summary-less success is preflight');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'a clean run keeps entries the CSV no longer lists',
  { skip: WIN_SKIP },
  () => {
    // cache_exclude_status (and max_cache_age) legitimately remove entries from
    // a healthy run's CSV; absence must not become a failure verdict.
    const site = makeSite({
      stdout: '🔍 1 Total (in 1s) 🔗 1 Unique ✅ 1 OK 🚫 0 Errors',
      exit: 0,
      csvAfterRun: '', // lychee wrote back an empty cache
    });
    writeFileSync(join(site, 'link-cache.jsonc'), OWNED_WITH_SEED);
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 0, 'run succeeds');
      const owned = readFileSync(join(site, 'link-cache.jsonc'), 'utf8');
      assert.match(owned, /"status": 206/, 'the absent entry keeps its status');
      assert.match(owned, /"via": "manual"/, 'provenance survives');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

test(
  'a reported failure becomes a tool-error entry',
  { skip: WIN_SKIP },
  () => {
    const site = makeSite({
      stdout: [
        '[ERROR] https://seed.example/x (at 1:1) | Failed: 404',
        '🔍 1 Total (in 1s) 🔗 1 Unique ✅ 0 OK 🚫 1 Error',
      ].join('\n'),
      exit: 2,
      csvAfterRun: '',
    });
    writeFileSync(join(site, 'link-cache.jsonc'), OWNED_WITH_SEED);
    try {
      const r = runWrapper(site);
      assert.equal(r.status, 1, 'a completed run with failures exits 1');
      const owned = readFileSync(join(site, 'link-cache.jsonc'), 'utf8');
      assert.match(owned, /"status": -40/, 'the failure is recorded');
      assert.match(owned, /\/\/ range seed/, 'the rationale comment is kept');
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  },
);

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

test('--migrate fails without writing when the CSV has malformed lines', () => {
  // The migration is specified lossless: partial output would silently drop
  // committed data.
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const site = mkdtempSync(join(tmpdir(), 'lnc-'));
  try {
    writeFileSync(
      join(site, '.lycheecache'),
      'https://a.example/,200,100\ngarbage-line\n',
    );
    const r = spawnSync(process.execPath, [script, '--migrate'], {
      cwd: site,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, 'lossy migration is refused');
    assert.match(r.stderr, /malformed/, 'the error names the cause');
    assert.throws(
      () => readFileSync(join(site, 'link-cache.jsonc')),
      'nothing is written on refusal',
    );
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
