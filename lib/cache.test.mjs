// Tests for the shared cache-file model: owned-JSONC format contract, the
// owned<->CSV lens, merge-back policy, and migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESULT_ERROR,
  mergeBack,
  migrateCsvText,
  parseCsv,
  parseCsvLine,
  parseOwned,
  projectToCsv,
  serializeCsv,
  serializeOwned,
  tsToWhen,
  whenToTs,
} from './cache.mjs';

const NOW = 1_790_000_000; // 2026-09-21 UTC

const entry = (url, result, ts, via = 'lychee', extra = {}) => ({
  url,
  result,
  ts,
  via,
  comments: [],
  ...extra,
});

const OWNED_SAMPLE = `{
  // Seeded pending otel#11325 merge.
  "https://a.example/x": {
    "result": 206,
    "when": "1970-01-01T00:01:40Z",
    "via": "manual",
    "expires": "2026-12-31",
  },
  "https://b.example/": {
    "result": 200,
    "when": "1970-01-01T00:03:20Z",
    "via": "lychee",
  },
  "https://c.example/": {
    "result": 200,
    "when": "1970-01-01T00:05:00Z",
    "via": "browser",
  },
}
`;

// --- when <-> epoch ------------------------------------------------------------

test('tsToWhen emits the canonical whole-second UTC form', () => {
  assert.equal(tsToWhen(1790000000), '2026-09-21T14:13:20Z', 'canonical form');
});

test('when round-trips epoch seconds exactly', () => {
  for (const ts of [0, 100, 1788033998, 1790000000]) {
    assert.equal(whenToTs(tsToWhen(ts)), ts, `bijective at ts=${ts}`);
  }
});

test('whenToTs rejects non-canonical forms', () => {
  for (const bad of [
    '2026-09-21T14:13:20.5Z', // fractional seconds (the RFC3339Nano churn)
    '2026-09-21T10:13:20-04:00', // offset (the local-timezone churn)
    '2026-02-30T00:00:00Z', // impossible date Date.parse would normalize
    '2026-09-21 14:13:20Z',
    '2026-09-21',
  ]) {
    assert.ok(Number.isNaN(whenToTs(bad)), `rejected: ${bad}`);
  }
});

test('parseOwned rejects a non-canonical when value', () => {
  assert.throws(
    () =>
      parseOwned(
        '{\n  "https://a.example/": { "result": 200, "when": "2026-09-21T10:13:20-04:00", "via": "lychee" },\n}\n',
      ),
    /malformed entry/,
    'strict validation fails loudly on non-canonical input',
  );
});

// --- format contract ---------------------------------------------------------

test('owned file round-trips byte-identically', () => {
  const parsed = parseOwned(OWNED_SAMPLE);
  assert.equal(serializeOwned(parsed), OWNED_SAMPLE, 'round-trip is stable');
});

test('serialized output is prettier-idempotent', () => {
  // The canonical serialization is Prettier's jsonc style; a formatting pass
  // over the tool's output must be a no-op, so consumers need no ignore entry.
  const prettierBin = join(
    fileURLToPath(new URL('..', import.meta.url)),
    'node_modules/.bin/prettier',
  );
  const out = serializeOwned(parseOwned(OWNED_SAMPLE));
  const r = spawnSync(prettierBin, ['--parser', 'jsonc'], {
    input: out,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'prettier parses the output');
  assert.equal(r.stdout, out, 'prettier leaves the output unchanged');
});

test('owned file is valid JSON once comments and trailing commas are stripped', () => {
  const json = OWNED_SAMPLE.split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  const obj = JSON.parse(json);
  assert.equal(Object.keys(obj).length, 3, 'all entries parse as JSON');
  assert.equal(obj['https://b.example/'].result, 200, 'field values survive');
});

test('parseOwned attaches comments to the following entry', () => {
  const { entries } = parseOwned(OWNED_SAMPLE);
  const a = entries.find((e) => e.url === 'https://a.example/x');
  assert.deepEqual(
    a.comments,
    ['  // Seeded pending otel#11325 merge.'],
    'comment travels with its entry',
  );
});

test('parseOwned throws on invalid JSONC', () => {
  assert.throws(
    () => parseOwned('{\n  not json at all,\n}\n'),
    /invalid JSONC/,
    'malformed committed data is an error, not a silent drop',
  );
});

test('parseOwned throws on a schema-violating entry', () => {
  assert.throws(
    () => parseOwned('{\n  "https://a.example/": { "result": "ok" },\n}\n'),
    /malformed entry/,
    'schema violations are named per URL',
  );
});

test('parseOwned accepts single-line entries (non-canonical input)', () => {
  const { entries } = parseOwned(
    '{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": "lychee" },\n}\n',
  );
  assert.equal(entries.length, 1, 'single-line entry parses');
  assert.equal(entries[0].result, 200, 'fields parse');
  assert.equal(entries[0].ts, 1, 'when converts to epoch internally');
});

test('parseOwned rejects unknown entry fields', () => {
  // A rewrite would silently drop them; fail loudly instead.
  assert.throws(
    () =>
      parseOwned(
        '{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": "lychee", "future": 1 },\n}\n',
      ),
    /malformed entry/,
    'unknown fields are rejected',
  );
});

test('parseOwned restricts expires to manual entries with real dates', () => {
  const withExpires = (via, expires) =>
    `{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": ${JSON.stringify(via)}, "expires": ${JSON.stringify(expires)} },\n}\n`;
  assert.throws(
    () => parseOwned(withExpires('browser', '2026-12-31')),
    /malformed entry/,
    'expires is manual-only',
  );
  assert.throws(
    () => parseOwned(withExpires('manual', '2026-02-30')),
    /malformed entry/,
    'an impossible expiry date is rejected',
  );
  const { entries } = parseOwned(withExpires('manual', '2026-12-31'));
  assert.equal(
    entries[0].expires,
    '2026-12-31',
    'a valid manual expiry parses',
  );
});

test('parseOwned rejects blank input as a truncated write', () => {
  assert.throws(() => parseOwned(''), /blank file/, 'zero bytes is an error');
  assert.throws(() => parseOwned('  \n'), /blank file/, 'whitespace too');
});

test('parseOwned rejects duplicate URL keys', () => {
  const dup = `{
  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": "lychee" },
  "https://a.example/": { "result": 404, "when": "1970-01-01T00:00:02Z", "via": "lychee" },
}
`;
  assert.throws(
    () => parseOwned(dup),
    /duplicate entry/,
    'a bad merge resolution is surfaced, not papered over',
  );
});

test('parseOwned rejects results outside the HTTP and failure-word domains', () => {
  const withResult = (r) =>
    `{\n  "https://a.example/": { "result": ${JSON.stringify(r)}, "when": "1970-01-01T00:00:01Z", "via": "lychee" },\n}\n`;
  assert.throws(
    () => parseOwned(withResult(1)),
    /malformed entry/,
    'a projected sub-100 status would wedge the lychee CSV load',
  );
  assert.throws(
    () => parseOwned(withResult(1000)),
    /malformed entry/,
    'statuses above 999 are rejected',
  );
  for (const bad of [0, -40, '', 'ERROR', '404', 'not a word']) {
    assert.throws(
      () => parseOwned(withResult(bad)),
      /malformed entry/,
      `result ${JSON.stringify(bad)} is out of domain`,
    );
  }
  for (const ok of [100, 999, 'error', 'timeout']) {
    assert.equal(
      parseOwned(withResult(ok)).entries[0].result,
      ok,
      `result ${JSON.stringify(ok)} is in-domain`,
    );
  }
});

test('parseOwned reads a legacy status field as result (one-version migration)', () => {
  // 0.4.x wrote `status`; every run rewrites the file wholesale, so accepting
  // it on read self-migrates caches to `result` on the first 0.5.0 run.
  const legacy = (s) =>
    `{\n  "https://a.example/": { "status": ${s}, "when": "1970-01-01T00:00:01Z", "via": "lychee" },\n}\n`;
  assert.equal(parseOwned(legacy(200)).entries[0].result, 200, 'HTTP carries');
  assert.equal(
    parseOwned(legacy(-40)).entries[0].result,
    'error',
    'the one negative ever written maps to the error word',
  );
  assert.equal(
    parseOwned(legacy(-10)).entries[0].result,
    'timeout',
    'the timeout code maps to the timeout word',
  );
  assert.throws(
    () => parseOwned(legacy(0)),
    /re-seed as a manual entry/,
    'status 0 (unchecked, never tool-written) names its remedy',
  );
  assert.throws(
    () => parseOwned(legacy(-50)),
    /no result equivalent/,
    'an unknown legacy code names the cause',
  );
  assert.throws(
    () =>
      parseOwned(
        '{\n  "https://a.example/": { "status": 200, "result": 200, "when": "1970-01-01T00:00:01Z", "via": "lychee" },\n}\n',
      ),
    /malformed entry/,
    'an entry cannot carry both status and result',
  );
});

test('legacy status entries rewrite to result (self-migration)', () => {
  const out = serializeOwned(
    parseOwned(
      '{\n  "https://a.example/": { "status": -40, "when": "1970-01-01T00:00:01Z", "via": "lychee" },\n}\n',
    ),
  );
  assert.match(out, /"result": "error"/, 'legacy code becomes a failure word');
  assert.doesNotMatch(out, /"status"/, 'the status field is gone on write');
});

test('parseOwned requires a nonblank via', () => {
  // A blank via would ride the named-resolver exemptions (guard, prune,
  // merge-back provenance) while naming no resolver.
  assert.throws(
    () =>
      parseOwned(
        '{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": "" },\n}\n',
      ),
    /malformed entry/,
    'blank provenance is rejected',
  );
});

test('serializeOwned sorts entries by URL byte order', () => {
  const out = serializeOwned({
    entries: [
      entry('https://b.example/', 200, 1),
      entry('https://a.example/', 200, 1),
    ],
  });
  const urls = [...out.matchAll(/"(https:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    urls,
    ['https://a.example/', 'https://b.example/'],
    'entries are byte-sorted',
  );
});

test('comment preservation: rewriting an unrelated entry keeps every comment byte', () => {
  const parsed = parseOwned(OWNED_SAMPLE);
  const b = parsed.entries.find((e) => e.url === 'https://b.example/');
  b.ts = 999;
  const out = serializeOwned(parsed);
  assert.match(
    out,
    /^ {2}\/\/ Seeded pending otel#11325 merge\.$/m,
    'the untouched entry keeps its comment verbatim',
  );
  assert.match(out, /"when": "1970-01-01T00:16:39Z"/, 'the edit landed');
});

test('comments after the last entry are preserved as trailing', () => {
  const text = `{
  "https://a.example/": {
    "result": 200,
    "when": "1970-01-01T00:00:01Z",
    "via": "lychee",
  },
  // parked note
}
`;
  const parsed = parseOwned(text);
  assert.deepEqual(parsed.trailing, ['  // parked note'], 'trailing kept');
  assert.equal(serializeOwned(parsed), text, 'round-trip keeps it in place');
});

// --- CSV ----------------------------------------------------------------------

test('parseCsv handles quoted URLs containing commas', () => {
  const { entries } = parseCsv('"https://a.example/x,y",200,123\n');
  assert.equal(entries[0].url, 'https://a.example/x,y', 'URL is unquoted');
  assert.equal(entries[0].status, 200, 'status parsed');
});

test('csv round-trip preserves a comma URL', () => {
  const text = '"https://a.example/x,y",200,123\n';
  assert.equal(
    serializeCsv(parseCsv(text).entries),
    text,
    'quoting round-trips',
  );
});

test('parseCsv keeps the newest duplicate and counts malformed lines', () => {
  const { entries, malformed } = parseCsv(
    'https://a.example/,200,100\nhttps://a.example/,200,900\ngarbage\n',
  );
  assert.equal(entries.length, 1, 'duplicates collapse');
  assert.equal(entries[0].ts, 900, 'newest ts wins');
  assert.equal(malformed, 1, 'malformed line is counted');
});

test('parseCsvLine rejects empty and non-numeric fields', () => {
  // Number('') is 0: without lexical checks, truncated lines would coin
  // status-0 or epoch-0 entries instead of counting as malformed. Quote
  // grammar is enforced: an unquoted field may not contain quotes, and a
  // quoted field's interior quotes must be doubled — a lone quote is a
  // corrupt row, not a URL with a quote in it.
  for (const bad of [
    'https://a.example/,200,',
    'https://a.example/,,123',
    'https://a.example/,20x,123',
    ',200,123',
    '"https://broken.example/,200,100',
    'https://broken.example/",200,100',
    'https://bad.example/"oops,200,100',
    '"https://rotten.example/"oops",200,100',
  ]) {
    assert.equal(parseCsvLine(bad), null, `rejected: ${bad}`);
  }
  assert.equal(
    parseCsvLine('"https://ok.example/""q",200,100').url,
    'https://ok.example/"q',
    'a properly doubled interior quote parses',
  );
});

// --- projection ---------------------------------------------------------------

test('projectToCsv keeps only 2xx results', () => {
  // Lychee's cache loader accepts success codes only (verified against
  // 0.24.2: a non-2xx row is dropped at load and the URL re-checked live), so
  // projecting anything else hands lychee rows it discards.
  const projected = projectToCsv([
    entry('https://ok.example/', 200, 100),
    entry('https://partial.example/', 206, 100),
    entry('https://moved.example/', 301, 100),
    entry('https://gone.example/', 404, 100),
    entry('https://err.example/', RESULT_ERROR, 100),
    entry('https://slow.example/', 'timeout', 100),
  ]);
  assert.deepEqual(
    projected.map((e) => e.url),
    ['https://ok.example/', 'https://partial.example/'],
    'non-2xx and failure-word entries stay owned-file-only',
  );
});

test('projectToCsv defaults to fresh timestamps for every entry', () => {
  // Staleness checks off by default: every cached 2xx result projects with a
  // fresh ts, so lychee's max_cache_age never triggers and expired seeds are
  // not re-checked; a run verifies only URLs without a cached 2xx result.
  const projected = projectToCsv(
    [
      entry('https://a.example/', 200, 100),
      entry('https://b.example/', 206, 100, 'manual', {
        expires: '2026-01-01', // long expired
      }),
    ],
    { now: NOW },
  );
  assert.deepEqual(
    projected.map((e) => e.ts),
    [NOW, NOW],
    'all entries project fresh, expired seeds included',
  );
});

test('projectToCsv with checkStale projects real timestamps', () => {
  const [p] = projectToCsv([entry('https://a.example/', 200, 100)], {
    now: NOW,
    checkStale: true,
  });
  assert.equal(p.ts, 100, 'real ts lets max_cache_age bite');
});

test('checkStale still freshens the ts of an unexpired manual entry', () => {
  // `expires` owns a manual seed's lifecycle even in the staleness-checking
  // mode: until then the seed outlives max_cache_age.
  const [p] = projectToCsv(
    [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-12-31',
      }),
    ],
    { now: NOW, checkStale: true },
  );
  assert.equal(p.ts, NOW, 'fresh ts overrides max_cache_age');
});

test('checkStale omits an expired manual entry', () => {
  const projected = projectToCsv(
    [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-01-01',
      }),
    ],
    { now: NOW, checkStale: true },
  );
  assert.equal(projected.length, 0, 'expired seed forces a live re-check');
});

// --- merge-back ---------------------------------------------------------------

test('mergeBack adds new URLs with via lychee', () => {
  const merged = mergeBack(
    { entries: [], trailing: [] },
    [{ url: 'https://new.example/', status: 200, ts: NOW }],
    { now: NOW },
  );
  assert.equal(merged.entries[0].via, 'lychee', 'new entry credited to lychee');
});

test('mergeBack ignores an echoed fresh projection ts (no false recency)', () => {
  // Under the default fresh-ts projection, a cache hit echoes the projected
  // ts back into the CSV byte-exactly (verified against lychee 0.24.2).
  // Adopting it would freshen every entry's `when` on every run, erasing the
  // real ages the staleness guard reads. The projection map identifies the
  // echo; a genuinely re-checked URL carries a different ts and still adopts.
  const owned = {
    entries: [entry('https://a.example/', 200, 100)],
    trailing: [],
  };
  const projectedTs = new Map([['https://a.example/', NOW]]);
  const echoed = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 200, ts: NOW }],
    { now: NOW, projectedTs },
  );
  assert.equal(echoed.entries[0].ts, 100, 'the echoed ts is not adopted');
  const rechecked = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 200, ts: NOW - 5 }],
    { now: NOW, projectedTs },
  );
  assert.equal(rechecked.entries[0].ts, NOW - 5, 'a real re-check ts adopts');
});

test('mergeBack replaces an entry when the status changes', () => {
  const owned = parseOwned(OWNED_SAMPLE);
  const merged = mergeBack(
    owned,
    [
      { url: 'https://c.example/', status: 404, ts: NOW },
      { url: 'https://a.example/x', status: 206, ts: NOW },
      { url: 'https://b.example/', status: 200, ts: 200 },
    ],
    { now: NOW },
  );
  const c = merged.entries.find((e) => e.url === 'https://c.example/');
  assert.equal(c.result, 404, 'status change lands');
  assert.equal(c.via, 'lychee', 'provenance moves to lychee on change');
});

test('mergeBack leaves a re-confirmed provenance entry untouched', () => {
  const owned = parseOwned(OWNED_SAMPLE);
  const merged = mergeBack(
    owned,
    [
      { url: 'https://a.example/x', status: 206, ts: NOW },
      { url: 'https://b.example/', status: 200, ts: 200 },
      { url: 'https://c.example/', status: 200, ts: NOW },
    ],
    { now: NOW },
  );
  const a = merged.entries.find((e) => e.url === 'https://a.example/x');
  const c = merged.entries.find((e) => e.url === 'https://c.example/');
  assert.equal(a.via, 'manual', 'manual provenance survives re-confirmation');
  assert.equal(a.ts, 100, 'manual ts survives re-confirmation');
  assert.deepEqual(
    a.comments,
    ['  // Seeded pending otel#11325 merge.'],
    'rationale comment survives re-confirmation',
  );
  assert.equal(c.via, 'browser', 'resolver provenance survives too');
});

test('mergeBack leaves an evidence-free CSV absence untouched', () => {
  // b is absent from the post-run CSV, but absence alone is ambiguous
  // (cache_exclude_status, max_cache_age, URL gone from the site): without
  // failure evidence the entry survives unchanged.
  const owned = parseOwned(OWNED_SAMPLE);
  const merged = mergeBack(
    owned,
    [
      { url: 'https://a.example/x', status: 206, ts: NOW },
      { url: 'https://c.example/', status: 200, ts: NOW },
    ],
    { now: NOW },
  );
  const b = merged.entries.find((e) => e.url === 'https://b.example/');
  assert.equal(b.result, 200, 'the entry keeps its result');
  assert.equal(b.ts, 200, 'the entry keeps its timestamp');
});

test('mergeBack records a reported failure as a tool-error status', () => {
  const owned = parseOwned(OWNED_SAMPLE);
  const merged = mergeBack(
    owned,
    [
      { url: 'https://a.example/x', status: 206, ts: NOW },
      { url: 'https://c.example/', status: 200, ts: NOW },
    ],
    { now: NOW, failedUrls: new Map([['https://b.example/', 'error']]) },
  );
  const b = merged.entries.find((e) => e.url === 'https://b.example/');
  assert.equal(b.result, RESULT_ERROR, 'failure recorded as a failure word');
  assert.equal(b.via, 'lychee', 'the failure is credited to the lychee run');
});

test('mergeBack records a failure for a URL new to the cache', () => {
  // The common "new page introduces a dead link" case: the URL is in neither
  // the owned cache nor the post-run CSV (failures are cache-excluded), so
  // the run's own error report is the only evidence.
  const merged = mergeBack({ entries: [], trailing: [] }, [], {
    now: NOW,
    failedUrls: new Map([['https://new-dead.example/', 'error']]),
  });
  assert.equal(merged.entries.length, 1, 'the failure lands in the cache');
  const e = merged.entries[0];
  assert.equal(e.url, 'https://new-dead.example/', 'the failing URL is keyed');
  assert.equal(e.result, RESULT_ERROR, 'recorded as a failure word');
  assert.equal(e.via, 'lychee', 'credited to the lychee run');
});

test('mergeBack mints new entries for http(s) failures only', () => {
  // Input classes: an owned mailto failure plus new https, file://, and
  // mailto: failures; only http(s) mints (rationale: the merge-back rules
  // above mergeBack).
  const merged = mergeBack(
    {
      entries: [
        {
          url: 'mailto:owned@dead.example',
          result: 200,
          ts: 100,
          via: 'lychee',
          comments: [],
        },
      ],
      trailing: [],
    },
    [],
    {
      now: NOW,
      failedUrls: new Map([
        ['https://new-dead.example/', 'error'],
        ['file:///home/runner/site/missing.html', 'error'],
        ['mailto:new@dead.example', 'error'],
        ['mailto:owned@dead.example', 'error'],
      ]),
    },
  );
  assert.deepEqual(
    merged.entries.map((e) => e.url).sort(),
    ['https://new-dead.example/', 'mailto:owned@dead.example'],
    'only the http(s) failure mints a new entry',
  );
  assert.ok(
    merged.entries.every((e) => e.result === RESULT_ERROR),
    'the owned mailto failure is still recorded',
  );
});

test('mergeBack lets failure evidence beat a residual CSV row', () => {
  // A URL new to the owned cache that both lingers in the CSV (stale success)
  // and appears in the run's error report: the failure wins.
  const merged = mergeBack(
    { entries: [], trailing: [] },
    [{ url: 'https://flaky.example/', status: 200, ts: 100 }],
    { now: NOW, failedUrls: new Map([['https://flaky.example/', 'error']]) },
  );
  assert.equal(merged.entries.length, 1, 'one entry for the URL');
  assert.equal(
    merged.entries[0].result,
    RESULT_ERROR,
    'the reported failure beats the residual CSV status',
  );
});

test('mergeBack keeps never-projected entries as-is', () => {
  const owned = {
    entries: [entry('https://err.example/', RESULT_ERROR, 100)],
    trailing: [],
  };
  const merged = mergeBack(owned, [], { now: NOW });
  assert.equal(
    merged.entries[0].result,
    RESULT_ERROR,
    'owned-only entry is untouched',
  );
});

test('mergeBack leaves an expired seed untouched on an echoed projection', () => {
  // Default mode projects expired seeds fresh, so lychee cache-hits them and
  // echoes the row back. Without echo detection the `expired` branch would
  // replace the seed wholesale (via lychee, comments dropped) though no live
  // re-check happened.
  const owned = {
    entries: [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-01-01',
        comments: ['  // seed'],
      }),
    ],
    trailing: [],
  };
  const merged = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 206, ts: NOW }],
    { now: NOW, projectedTs: new Map([['https://a.example/', NOW]]) },
  );
  const a = merged.entries[0];
  assert.equal(a.via, 'manual', 'the expired seed keeps its provenance');
  assert.equal(a.ts, 100, 'the expired seed keeps its timestamp');
  assert.deepEqual(a.comments, ['  // seed'], 'the rationale is kept');
});

test('mergeBack replaces an expired manual entry with the live result', () => {
  const owned = {
    entries: [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-01-01',
        comments: ['  // seed'],
      }),
    ],
    trailing: [],
  };
  const merged = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 200, ts: NOW }],
    { now: NOW },
  );
  const a = merged.entries[0];
  assert.equal(a.result, 200, 'live result wins');
  assert.equal(a.via, 'lychee', 'provenance moves to lychee');
  assert.equal(a.expires, undefined, 'expiry is gone');
  assert.deepEqual(a.comments, [], 'the served seed comment is dropped');
});

test('mergeBack records an expired entry whose re-check failed with the failure word', () => {
  // Expired -> not projected -> lychee re-checked live and reported the
  // failure. The stale seeded status must not survive.
  const owned = {
    entries: [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-01-01',
        comments: ['  // seed'],
      }),
    ],
    trailing: [],
  };
  const merged = mergeBack(owned, [], {
    now: NOW,
    failedUrls: new Map([['https://a.example/', 'timeout']]),
  });
  const a = merged.entries[0];
  assert.equal(a.result, 'timeout', 'the reported failure word is recorded');
  assert.equal(a.via, 'lychee', 'the failed re-check is credited to lychee');
  assert.deepEqual(a.comments, ['  // seed'], 'rationale comment is kept');
});

test('migrateCsvText refuses ambiguous conflicting duplicates', () => {
  // Equal-timestamp duplicates with different statuses have no right answer;
  // collapsing them silently would make migration order-dependent.
  const rows = ['https://a.example/,200,100', 'https://a.example/,404,100'];
  for (const text of [
    rows.join('\n') + '\n',
    rows.reverse().join('\n') + '\n',
  ]) {
    const { count, conflicting } = migrateCsvText(text);
    assert.equal(conflicting, 1, 'the conflict is counted');
    assert.equal(count, 0, 'nothing migrates from a conflicted URL');
  }
  const clean = migrateCsvText(
    'https://a.example/,200,100\nhttps://a.example/,404,900\n',
  );
  assert.equal(clean.conflicting, 0, 'a newer row wins without ambiguity');
  assert.equal(clean.count, 1, 'the newest row migrates');
});

// --- migration ------------------------------------------------------------------

test('migrateCsvText maps legacy negative statuses to failure words', () => {
  // htmltest-era refcache CSVs carry the fork's negative codes; migration
  // preserves the failure record as words, so the output re-parses.
  const { text, count, unmappable } = migrateCsvText(
    'https://a.example/,-40,100\nhttps://t.example/,-10,100\n',
  );
  assert.equal(count, 2, 'both entries migrated');
  assert.equal(unmappable, 0, 'clean input');
  const { entries } = parseOwned(text);
  assert.equal(entries[0].result, 'error', 'the client-error code maps');
  assert.equal(entries[1].result, 'timeout', 'the timeout code maps');
});

test('migrateCsvText counts out-of-domain statuses as unmappable', () => {
  // Without the domain check, migration would write a file its own parser
  // rejects: a false-clean migration.
  const { text, count, unmappable } = migrateCsvText(
    'https://a.example/,0,100\nhttps://b.example/,99,100\nhttps://c.example/,1000,100\nhttps://d.example/,-50,100\n',
  );
  assert.equal(unmappable, 4, 'every out-of-domain status is counted');
  assert.equal(count, 0, 'none migrated');
  assert.doesNotThrow(() => parseOwned(text), 'the output is still valid');
});

test('migrateCsvText converts every CSV entry to via lychee', () => {
  const { text, count, malformed } = migrateCsvText(
    'https://a.example/,200,100\n"https://b.example/x,y",206,200\n',
  );
  assert.equal(count, 2, 'both entries migrated');
  assert.equal(malformed, 0, 'clean input');
  const { entries } = parseOwned(text);
  assert.equal(entries.length, 2, 'owned file has both entries');
  assert.ok(
    entries.every((e) => e.via === 'lychee'),
    'migrated entries are credited to lychee',
  );
  assert.equal(
    entries.find((e) => e.url === 'https://b.example/x,y').result,
    206,
    'comma URL survives migration',
  );
});
