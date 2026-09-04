// Tests for the link-cache bin (list / prune / summary) over both cache
// formats, and for its deprecated refcache alias.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  parseCache,
  parseOwnedCache,
  resolvePruneCount,
  selectOldest,
  computeStats,
  formatStats,
  runOps,
} from './index.mjs';

const DAY = 86400;
const NOW = 1_000_000_000; // fixed reference epoch (seconds)

// Build a cache line: `URL,STATUS,UNIX_TIMESTAMP`.
const line = (url, status, ageDays) =>
  `${url},${status},${NOW - ageDays * DAY}`;

const SAMPLE = [
  line('https://a.example/', 200, 0),
  line('https://b.example/', 200, 10),
  line('https://c.example/', 404, 60),
  line('https://d.example/', 200, 200),
  line('https://e.example/', 301, 400),
].join('\n');

// --- parseArgs ---

test('parseArgs preserves flag order across list and prune', () => {
  assert.deepEqual(parseArgs(['-l', '2', '-p', '1']).ops, [
    { kind: 'list', value: '2' },
    { kind: 'prune', value: '1' },
  ]);
  assert.deepEqual(parseArgs(['-p', '1', '-l', '2']).ops, [
    { kind: 'prune', value: '1' },
    { kind: 'list', value: '2' },
  ]);
});

test('parseArgs treats long and short flags the same', () => {
  assert.deepEqual(
    parseArgs(['--list', '3', '--prune', '50%', '--summary']).ops,
    [
      { kind: 'list', value: '3' },
      { kind: 'prune', value: '50%' },
      { kind: 'summary' },
    ],
  );
});

test('parseArgs rejects a repeated flag', () => {
  assert.throws(
    () => parseArgs(['-s', '--summary']),
    /repeated/,
    'a flag may not appear twice',
  );
});

test('parseArgs rejects a flag missing its value', () => {
  assert.throws(() => parseArgs(['-l']), /value/, '--list needs a count');
});

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown/, 'unknown flags error');
});

test('parseArgs validates the prune amount', () => {
  assert.throws(() => parseArgs(['-p', 'abc']), /prune/, 'NUM or NUM% only');
  assert.deepEqual(parseArgs(['-p', '12%']).ops, [
    { kind: 'prune', value: '12%' },
  ]);
});

test('parseArgs leaves the path null (resolved at run time) and yields no ops', () => {
  const { ops, path } = parseArgs([]);
  assert.deepEqual(ops, [], 'no flags means no ops');
  assert.equal(path, null, 'path resolution is deferred to main');
});

test('parseArgs captures a positional refcache path', () => {
  assert.equal(parseArgs(['other.cache', '-s']).path, 'other.cache');
});

// --- parseCache ---

test('parseCache counts entries and tallies malformed lines', () => {
  const p = parseCache(`${SAMPLE}\nnot-a-line`);
  assert.equal(p.entries.length, 5, 'valid lines become entries');
  assert.equal(p.malformed, 1, 'malformed lines are tallied');
});

test('parseCache reads url, status and timestamp from a quoted URL', () => {
  const p = parseCache(`"https://x.example/?a=1,2,3",200,${NOW - 5 * DAY}`);
  assert.equal(p.entries.length, 1, 'a quoted URL with commas is one entry');
  assert.equal(p.entries[0].status, '200', 'status read from the tail');
  assert.equal(p.entries[0].ts, NOW - 5 * DAY, 'timestamp read from the tail');
  assert.match(p.entries[0].url, /x\.example/, 'url is the quoted head');
});

test('parseCache rejects empty-URL and non-numeric rows as malformed', () => {
  // The lenient 0.4.x parser accepted these as entries, so junk rows fed the
  // age statistics and could be "pruned" as if they were URLs.
  const { entries, malformed } = parseCache(
    ',200,123\n"",200,123\nhttps://a.example/,foo,123\nhttps://b.example/,200,bad\n"https://c.example/,200,123\nhttps://ok.example/,200,123\n',
  );
  assert.equal(malformed, 5, 'junk rows count as malformed');
  assert.deepEqual(
    entries.map((e) => e.url),
    ['https://ok.example/'],
    'only the well-formed row parses',
  );
});

// --- resolvePruneCount ---

test('resolvePruneCount reads an absolute count', () => {
  assert.equal(resolvePruneCount('100', 938), 100);
});

test('resolvePruneCount floors a percentage of the total', () => {
  assert.equal(resolvePruneCount('10%', 938), 93, '10% of 938 floors to 93');
});

test('resolvePruneCount clamps to the total', () => {
  assert.equal(resolvePruneCount('500', 5), 5, 'never prunes more than exist');
});

// --- selectOldest ---

test('selectOldest returns the n oldest, oldest first', () => {
  const { entries } = parseCache(SAMPLE);
  const oldest = selectOldest(entries, 2);
  assert.deepEqual(
    oldest.map((e) => e.ts),
    [NOW - 400 * DAY, NOW - 200 * DAY],
    'two oldest by timestamp ascending',
  );
});

test('selectOldest returns all entries when n exceeds the count', () => {
  const { entries } = parseCache(SAMPLE);
  assert.equal(
    selectOldest(entries, 99).length,
    5,
    'capped at the entry count',
  );
});

// --- computeStats / formatStats ---

test('computeStats summarizes counts, extremes and an adaptive histogram', () => {
  const { entries } = parseCache(SAMPLE);
  const s = computeStats(entries, { now: NOW });
  assert.equal(s.count, 5, 'every entry counted');
  assert.equal(s.oldest.ageDays, 400, 'oldest age in days');
  assert.equal(s.newest.ageDays, 0, 'newest age in days');
  assert.deepEqual(
    s.byStatus,
    [
      ['200', 3],
      ['301', 1],
      ['404', 1],
    ],
    'status counts sorted by count desc then status asc',
  );
  assert.equal(s.ageBuckets.length, 5, 'five adaptive age buckets');
});

test('formatStats shows entries, a local timestamp and a status', () => {
  const out = formatStats(
    computeStats(parseCache(SAMPLE).entries, { now: NOW }),
    {
      now: NOW,
    },
  );
  assert.match(out, /Entries:\s*5/, 'entry count shown');
  assert.match(out, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'timestamp shown');
  assert.match(out, /\b200\b/, 'a status code shown');
});

test('formatStats reports the prune delta when entries were pruned', () => {
  const { entries } = parseCache(SAMPLE);
  const s = computeStats(entries.slice(2), { now: NOW, pruned: 2 });
  const out = formatStats(s, { now: NOW });
  assert.match(out, /Pruned:\s*2/, 'pruned count shown');
  assert.match(out, /5 → 3/, 'before and after totals shown');
});

// --- runOps (ordered execution) ---

test('runOps with list before prune lists the pre-prune oldest', () => {
  const parsed = parseCache(SAMPLE);
  const { output, writeText, pruned } = runOps(
    parsed,
    [
      { kind: 'list', value: '2' },
      { kind: 'prune', value: '1' },
    ],
    { now: NOW },
  );
  assert.match(output, /e\.example/, 'the oldest (to be pruned) is listed');
  assert.match(output, /d\.example/, 'the second oldest is listed');
  assert.equal(pruned, 1, 'one entry pruned');
  assert.equal(
    writeText.split('\n').filter((l) => l !== '').length,
    4,
    'one line removed from the file',
  );
  assert.ok(
    !writeText.includes('e.example'),
    'the pruned oldest is gone from the written file',
  );
});

test('runOps with prune before list lists the post-prune oldest (look-ahead)', () => {
  const parsed = parseCache(SAMPLE);
  const { output } = runOps(
    parsed,
    [
      { kind: 'prune', value: '1' },
      { kind: 'list', value: '1' },
    ],
    { now: NOW },
  );
  assert.ok(
    !output.includes('e.example'),
    'the just-pruned oldest is not in the look-ahead list',
  );
  assert.match(output, /d\.example/, 'the next-oldest is listed instead');
});

test('runOps summary after a prune includes the prune delta', () => {
  const parsed = parseCache(SAMPLE);
  const { output } = runOps(
    parsed,
    [{ kind: 'prune', value: '2' }, { kind: 'summary' }],
    { now: NOW },
  );
  assert.match(output, /Pruned:\s*2/, 'summary reports the prune');
  assert.match(
    output,
    /Entries:\s*3/,
    'summary reflects the remaining entries',
  );
});

test('runOps without a prune does not rewrite the file', () => {
  const parsed = parseCache(SAMPLE);
  const { writeText, pruned } = runOps(parsed, [{ kind: 'summary' }], {
    now: NOW,
  });
  assert.equal(pruned, 0, 'nothing pruned');
  assert.equal(writeText, null, 'writeText stays null when nothing changed');
});

// --- owned-format (link-cache.jsonc) support ---

const A_BLOCK = `  // seed rationale
  "https://a.example/": {
    "result": 206,
    "when": "2000-08-05T01:46:40Z",
    "via": "manual",
  },
`;
const B_BLOCK = `  "https://b.example/": {
    "result": 200,
    "when": "2001-09-09T01:46:40Z",
    "via": "lychee",
  },
`;
const C_BLOCK = `  "https://c.example/": {
    "result": 200,
    "when": "2001-08-30T01:46:40Z",
    "via": "browser",
  },
`;
const OWNED_SAMPLE = `{\n${A_BLOCK}${B_BLOCK}${C_BLOCK}}\n`;

test('parseOwnedCache adapts owned entries to the common shape', () => {
  const parsed = parseOwnedCache(OWNED_SAMPLE);
  assert.equal(parsed.kind, 'owned', 'format detected');
  assert.equal(parsed.entries.length, 3, 'all entries parsed');
  assert.equal(parsed.entries[0].status, '206', 'status is stringified');
  assert.equal(parsed.entries[0].via, 'manual', 'via is carried');
});

test('owned summary includes a via breakdown', () => {
  const parsed = parseOwnedCache(OWNED_SAMPLE);
  const { output } = runOps(parsed, [{ kind: 'summary' }], { now: NOW });
  assert.match(output, /Via:/, 'via section present');
  assert.match(output, /manual\s+1/, 'manual counted');
  assert.match(output, /lychee\s+1/, 'lychee counted');
});

test('owned prune drops the oldest entry, via regardless', () => {
  // The manual seed (a) is the oldest overall and carries no expires, so it
  // competes on age like any other entry: provenance says nothing about
  // lifetime. Its comment goes with it.
  const parsed = parseOwnedCache(OWNED_SAMPLE);
  const { writeText, pruned } = runOps(
    parsed,
    [{ kind: 'prune', value: '1' }],
    {
      now: NOW,
    },
  );
  assert.equal(pruned, 1, 'one entry pruned');
  assert.ok(!writeText.includes('a.example'), 'the oldest entry is gone');
  assert.ok(!writeText.includes('seed rationale'), 'its comment went with it');
  assert.match(writeText, /c\.example/, 'the next-oldest remains');
  assert.match(writeText, /b\.example/, 'newer entries remain');
});

test('owned prune preserves surviving entries byte-identically', () => {
  const parsed = parseOwnedCache(OWNED_SAMPLE);
  const { writeText } = runOps(parsed, [{ kind: 'prune', value: '1' }], {
    now: NOW,
  });
  assert.equal(
    writeText,
    `{\n${B_BLOCK}${C_BLOCK}}\n`,
    'survivor blocks are byte-identical, pruned block is gone',
  );
});

// Owned-entry block builder for expiry fixtures. NOW is 2001-09-09.
const when = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, '');
const block = (url, ts, via, expires) =>
  `  ${JSON.stringify(url)}: {\n    "result": 200,\n    "when": "${when(ts)}Z",\n    "via": ${JSON.stringify(via)},\n${expires === undefined ? '' : `    "expires": ${JSON.stringify(expires)},\n`}  },\n`;
const cacheOf = (...blocks) => parseOwnedCache(`{\n${blocks.join('')}}\n`);

const NEVER = block(
  'https://never.example/',
  NOW - 900 * DAY,
  'manual',
  'never',
);
const HOLDS = block(
  'https://holds.example/',
  NOW - 800 * DAY,
  'lychee',
  '2002-01-01',
);
const LAPSED = block(
  'https://lapsed.example/',
  NOW - 1 * DAY,
  'manual',
  '2001-01-01',
);
const OLD = block('https://old.example/', NOW - 300 * DAY, 'lychee');
const MID = block('https://mid.example/', NOW - 200 * DAY, 'browser');
const NEW = block('https://new.example/', NOW - 100 * DAY, 'lychee');

test('prune drops lapsed entries unconditionally, then the N oldest of the rest', () => {
  // The lapsed entry is the newest by timestamp and still goes; the holding
  // and never entries are the oldest and still stay. Only the entries without
  // expires compete on age.
  const parsed = cacheOf(NEVER, HOLDS, LAPSED, OLD, MID, NEW);
  const { writeText, pruned, output } = runOps(
    parsed,
    [{ kind: 'prune', value: '1' }],
    { now: NOW },
  );
  assert.equal(pruned, 2, 'one lapsed plus one oldest');
  assert.equal(
    writeText,
    `{\n${HOLDS}${MID}${NEVER}${NEW}}\n`,
    'lapsed and oldest-without-expires gone; holding and never kept',
  );
  assert.match(output, /1 lapsed, 1 oldest \(6 → 4\)/, 'the split is reported');
});

test('--prune 0 drops lapsed entries only', () => {
  const parsed = cacheOf(NEVER, LAPSED, OLD);
  const { writeText, pruned } = runOps(
    parsed,
    [{ kind: 'prune', value: '0' }],
    { now: NOW },
  );
  assert.equal(pruned, 1, 'only the lapsed entry');
  assert.equal(writeText, `{\n${NEVER}${OLD}}\n`, 'nothing else moved');
});

test('a 100% prune leaves only entries whose expires holds', () => {
  const parsed = cacheOf(NEVER, HOLDS, LAPSED, OLD, MID);
  const { writeText, pruned } = runOps(
    parsed,
    [{ kind: 'prune', value: '100%' }],
    { now: NOW },
  );
  assert.equal(pruned, 3, 'lapsed plus both entries without expires');
  assert.equal(writeText, `{\n${HOLDS}${NEVER}}\n`, 'holding entries stand');
});

test('prune with nothing lapsed and --prune 0 rewrites nothing', () => {
  const parsed = cacheOf(NEVER, OLD);
  const { writeText, pruned } = runOps(
    parsed,
    [{ kind: 'prune', value: '0' }],
    { now: NOW },
  );
  assert.equal(pruned, 0, 'nothing pruned');
  assert.equal(writeText, null, 'no rewrite');
});

// --- --match scoping ---

test('match scopes list and summary to matching URLs', () => {
  const parsed = parseOwnedCache(OWNED_SAMPLE);
  const { output } = runOps(
    parsed,
    [{ kind: 'list', value: '5' }, { kind: 'summary' }],
    { now: NOW, match: /b\.example/ },
  );
  assert.match(output, /b\.example/, 'matching entry listed');
  assert.ok(!output.includes('a.example'), 'listing is scoped to matches');
  assert.match(output, /Entries: 1/, 'summary counts matches only');
});

test('match scopes prune but never drops out-of-scope entries on rewrite', () => {
  const parsed = parseOwnedCache(OWNED_SAMPLE);
  // a is the oldest overall, but only c matches: c is pruned, a and b survive.
  const { writeText, pruned } = runOps(
    parsed,
    [{ kind: 'prune', value: '1' }],
    { now: NOW, match: /c\.example/ },
  );
  assert.equal(pruned, 1, 'one matching entry pruned');
  assert.equal(
    writeText,
    `{\n${A_BLOCK}${B_BLOCK}}\n`,
    'out-of-scope entries survive the rewrite',
  );
});

test('parseArgs compiles --match and rejects an invalid regex', () => {
  assert.equal(
    parseArgs(['-m', 'foo.*']).match.source,
    'foo.*',
    'regex compiled',
  );
  assert.throws(
    () => parseArgs(['--match', '(']),
    /--match needs a valid regex/,
    'invalid regex is rejected',
  );
});

test('match tests the unquoted URL on the legacy CSV path', () => {
  // The raw CSV field is quoted for comma URLs; an anchored regex must still
  // match the real URL.
  const parsed = parseCache('"https://a.example/x,y",200,100\n');
  const { output } = runOps(parsed, [{ kind: 'list', value: '5' }], {
    now: NOW,
    match: /^https:\/\/a\.example\//,
  });
  assert.match(output, /a\.example\/x,y/, 'anchored regex matches a comma URL');
});

test('match scopes the lapsed drop: an out-of-scope lapsed entry survives', () => {
  const parsed = cacheOf(LAPSED, OLD, NEW);
  const { writeText, pruned } = runOps(
    parsed,
    [{ kind: 'prune', value: '1' }],
    { now: NOW, match: /old\.example|new\.example/ },
  );
  assert.equal(pruned, 1, 'only the matching oldest entry');
  assert.equal(
    writeText,
    `{\n${LAPSED}${NEW}}\n`,
    'lapsed but unmatched stays',
  );
});

// --- retired flags ---

test('parseArgs rejects the retired --no-manual and --max-age flags', () => {
  // --no-manual shipped only in the unpublished 0.4.2; --max-age (0.5.0's
  // staleness guard) went with the mode split in 0.6.0. Both fail loud as
  // unknown flags rather than silently doing something else.
  for (const flag of ['--no-manual', '--max-age']) {
    assert.throws(
      () => parseArgs([flag, '30']),
      /unknown flag/,
      `${flag} is unknown`,
    );
  }
});

test('exit codes stop at 2: a prune run exits 0', () => {
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'link-cache-'));
  const file = join(dir, '.lycheecache');
  try {
    writeFileSync(file, `https://a.example/,200,1\n`);
    const r = spawnSync(process.execPath, [script, file, '--prune', '1'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'no guard verdict, no exit 3');
    assert.match(r.stdout, /1 oldest \(1 → 0\)/, 'the prune ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI entry point ---

test(
  'runs when invoked through a bin symlink (npx)',
  { skip: process.platform === 'win32' ? 'POSIX symlink bins only' : false },
  () => {
    // A naive `file://${argv[1]}` guard misses the symlink and silently skips
    // main(), so `npx link-cache` would do nothing.
    const script = fileURLToPath(new URL('./index.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'link-cache-'));
    const link = join(dir, 'link-cache');
    symlinkSync(script, link);
    try {
      const r = spawnSync(process.execPath, [link, '--help'], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, 'help exits 0');
      assert.match(r.stdout, /Usage: link-cache/, 'main ran via the symlink');
      assert.ok(
        !r.stderr.includes('deprecated'),
        'the canonical bin name keeps stderr clean',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('the refcache alias wrapper warns and delegates', () => {
  // A dedicated wrapper file, not an argv[1] sniff: works under npm's Windows
  // shims too, so this test runs on every platform.
  const script = fileURLToPath(new URL('./refcache.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'the alias still works');
  assert.match(r.stdout, /Usage: link-cache/, 'main ran via the alias');
  assert.match(
    r.stderr,
    /refcache bin is deprecated/,
    'the alias names its replacement',
  );
});
