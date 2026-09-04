// Tests for the shared cache-file model: owned-JSONC format contract, the
// owned<->CSV lens, merge-back policy, and migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESULT_ERROR,
  hasLapsed,
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

test('parseOwned accepts expires on any entry, via regardless', () => {
  const withExpires = (via, expires) =>
    `{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": ${JSON.stringify(via)}, "expires": ${JSON.stringify(expires)} },\n}\n`;
  for (const via of ['manual', 'browser', 'lychee']) {
    const { entries } = parseOwned(withExpires(via, '2026-12-31'));
    assert.equal(entries[0].expires, '2026-12-31', `a date parses on ${via}`);
  }
  const { entries } = parseOwned(withExpires('manual', 'never'));
  assert.equal(entries[0].expires, 'never', 'never parses');
});

test('parseOwned resolves +Nd expiry sugar to a date from the run time', () => {
  // NOW is 2026-09-21T14:13:20Z; rationale at resolveExpires.
  const withSugar = (sugar) =>
    `{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": "manual", "expires": ${JSON.stringify(sugar)} },\n}\n`;
  for (const [sugar, date] of [
    ['+0d', '2026-09-21'],
    ['+7d', '2026-09-28'],
    ['+365d', '2027-09-21'],
  ]) {
    const { entries } = parseOwned(withSugar(sugar), { now: NOW });
    assert.equal(entries[0].expires, date, `${sugar} resolves to ${date}`);
  }
});

test('parseOwned rejects malformed expiry values', () => {
  const withExpires = (expires) =>
    `{\n  "https://a.example/": { "result": 200, "when": "1970-01-01T00:00:01Z", "via": "manual", "expires": ${JSON.stringify(expires)} },\n}\n`;
  for (const bad of [
    null,
    20261231,
    '2026-02-30', // impossible date
    'soon',
    'Never', // the token is lowercase
    '+d',
    '+7h', // only whole days
    '+-1d',
    '7d', // sugar needs its sign
    '+3000000d', // resolves past year 9999: no canonical date to write
    '+999999999999d', // overflows Date entirely
    '',
  ]) {
    assert.throws(
      () => parseOwned(withExpires(bad)),
      /malformed entry/,
      `rejected: ${JSON.stringify(bad)}`,
    );
  }
});

test('parseOwned defaults a missing when to the run time, manual entries only', () => {
  const without = (via) =>
    `{\n  "https://a.example/": { "result": 200, "via": ${JSON.stringify(via)} },\n}\n`;
  const { entries } = parseOwned(without('manual'), { now: NOW + 0.7 });
  assert.equal(entries[0].ts, NOW, 'a hand-written entry is dated by the run');
  for (const via of ['lychee', 'browser']) {
    // Rationale at validateEntry.
    assert.throws(
      () => parseOwned(without(via), { now: NOW }),
      /malformed entry/,
      `${via} without when is rejected`,
    );
  }
});

test('resolved sugar and a defaulted when serialize as canonical values', () => {
  const text = `{\n  "https://a.example/": { "result": 200, "via": "manual", "expires": "+7d" },\n}\n`;
  const out = serializeOwned(parseOwned(text, { now: NOW }));
  assert.match(out, /"when": "2026-09-21T14:13:20Z"/, 'when is written');
  assert.match(out, /"expires": "2026-09-28"/, 'the sugar is written resolved');
  assert.equal(
    serializeOwned(parseOwned(out, { now: NOW + 10 * 86400 })),
    out,
    'a resolved file is stable under a later read',
  );
});

test('hasLapsed holds through the last instant of the UTC day, then lapses', () => {
  const eod = Date.parse('2026-09-21T23:59:59.999Z') / 1000;
  assert.equal(
    hasLapsed(undefined, NOW),
    false,
    'an absent expiry holds forever',
  );
  assert.equal(hasLapsed('never', NOW), false, 'never holds forever');
  assert.equal(hasLapsed('2026-09-21', eod), false, 'the last ms still holds');
  assert.equal(hasLapsed('2026-09-21', eod + 0.001), true, 'midnight lapses');
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
  // Input: a 0.4.x file; rationale at migrateLegacyStatus.
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
    /malformed entry/,
    'status 0 (unchecked) was never tool-written and has no result mapping',
  );
  assert.throws(
    () => parseOwned(legacy(-50)),
    /malformed entry/,
    'an unknown legacy code is malformed',
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
  // quoted field's interior quotes must be doubled; a lone quote is a
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

test('projectToCsv projects real timestamps for entries without expires', () => {
  const [p] = projectToCsv([entry('https://a.example/', 200, 100)], {
    now: NOW,
  });
  assert.equal(p.ts, 100, 'the real ts lets max_cache_age govern');
});

test('projectToCsv freshens the ts of an entry whose expires holds, via regardless', () => {
  const projected = projectToCsv(
    [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-12-31',
      }),
      entry('https://b.example/', 200, 100, 'lychee', {
        expires: '2026-12-31',
      }),
      entry('https://c.example/', 200, 100, 'browser', { expires: 'never' }),
    ],
    { now: NOW },
  );
  assert.deepEqual(
    projected.map((e) => e.ts),
    [NOW, NOW, NOW],
    'an unlapsed or never expiry overrides max_cache_age',
  );
});

test('projectToCsv projects fresh for any entry with expires, lapsed included', () => {
  // Input: a lapsed expires; rationale at projectToCsv.
  const [p] = projectToCsv(
    [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-01-01',
      }),
    ],
    { now: NOW },
  );
  assert.equal(p.ts, NOW, 'a lapsed expiry still projects fresh');
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
  // Inputs: a CSV row equal to the projected one (echo), then one with a later
  // ts (live re-check); rationale in mergeBack's rules.
  const owned = {
    entries: [
      entry('https://a.example/', 200, 100, 'lychee', {
        expires: '2026-12-31',
      }),
    ],
    trailing: [],
  };
  const projectedTs = new Map([['https://a.example/', NOW]]);
  const echoed = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 200, ts: NOW }],
    { now: NOW, projectedTs },
  );
  assert.equal(
    echoed.entries[0].ts,
    100,
    'the owned ts survives an echoed row',
  );
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

test('mergeBack drops expires along with comments on a changed result', () => {
  // Input: a holding expires whose URL now answers differently.
  const owned = {
    entries: [
      entry('https://a.example/', 200, 100, 'lychee', {
        expires: 'never',
        comments: ['  // vouched'],
      }),
    ],
    trailing: [],
  };
  const [a] = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 301, ts: NOW }],
    { now: NOW },
  ).entries;
  assert.equal(a.result, 301, 'the live result lands');
  assert.equal(a.expires, undefined, 'the override ends with its claim');
  assert.deepEqual(a.comments, [], 'comments go with it');
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

test('mergeBack leaves a lapsed seed untouched on an echoed projection', () => {
  // Input: a lapsed seed whose fresh projection lychee echoed back.
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
  assert.equal(a.via, 'manual', 'the lapsed seed keeps its provenance');
  assert.equal(a.ts, 100, 'the lapsed seed keeps its timestamp');
  assert.deepEqual(a.comments, ['  // seed'], 'the rationale is kept');
});

test('mergeBack replaces a lapsed seed re-checked live with the lychee result', () => {
  // Input: a lapsed expires on a named-resolver entry (lapse is via-regardless),
  // re-checked later in the run than the fresh projection.
  const owned = {
    entries: [
      entry('https://a.example/', 206, 100, 'browser', {
        expires: '2026-01-01',
        comments: ['  // seed'],
      }),
    ],
    trailing: [],
  };
  const merged = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 206, ts: NOW + 5 }],
    { now: NOW, projectedTs: new Map([['https://a.example/', NOW]]) },
  );
  const a = merged.entries[0];
  assert.equal(a.via, 'lychee', 'provenance moves to lychee');
  assert.equal(a.ts, NOW + 5, 'the live check time is recorded');
  assert.equal(a.expires, undefined, 'the spent expiry is gone');
  assert.deepEqual(a.comments, [], 'the served seed comment is dropped');
});

test('mergeBack keeps a holding expiry through a lychee re-confirmation', () => {
  // Input: a lychee-owned entry with a holding expires, re-confirmed live.
  const owned = {
    entries: [
      entry('https://a.example/', 200, 100, 'lychee', {
        expires: '2026-12-31',
      }),
    ],
    trailing: [],
  };
  const merged = mergeBack(
    owned,
    [{ url: 'https://a.example/', status: 200, ts: NOW }],
    { now: NOW },
  );
  assert.equal(merged.entries[0].expires, '2026-12-31', 'expiry kept');
  assert.equal(merged.entries[0].ts, NOW, 'recency recorded');
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
  // Input: a lapsed seed named in the run's failure report.
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
  assert.equal(a.expires, '2026-01-01', 'the expiry is kept for prune to read');
});

test('mergeBack keeps a holding expiry on a repeated failure', () => {
  // Input: a recorded failure with expires, reported failing again.
  const owned = {
    entries: [
      entry('https://a.example/', RESULT_ERROR, 100, 'lychee', {
        expires: 'never',
      }),
    ],
    trailing: [],
  };
  const merged = mergeBack(owned, [], {
    now: NOW,
    failedUrls: new Map([['https://a.example/', RESULT_ERROR]]),
  });
  assert.equal(merged.entries[0].expires, 'never', 'expiry survives');
});

test('migrateCsvText counts out-of-range timestamps as unmappable', () => {
  // A ts past year 9999 serializes to a non-canonical `when` that every
  // subsequent parse rejects: importing it would be a false-clean.
  const { count, unmappable } = migrateCsvText(
    'https://a.example/,200,300000000000\nhttps://ok.example/,200,100\n',
  );
  assert.equal(unmappable, 1, 'the out-of-range ts is counted');
  assert.equal(count, 1, 'the well-formed row still imports');
});

test('parseCsv conflict detection is order-independent', () => {
  // A newer row resolves an older equal-ts conflict regardless of row order;
  // only ties among the final winners are ambiguous.
  const rows = [
    'https://a.example/,200,100',
    'https://a.example/,404,100',
    'https://a.example/,200,900',
  ];
  for (const text of [
    rows.join('\n') + '\n',
    [...rows].reverse().join('\n') + '\n',
  ]) {
    const { entries, conflicting } = parseCsv(text);
    assert.equal(conflicting, 0, 'the newer row resolves the tie');
    assert.equal(entries[0].ts, 900, 'the newest row wins');
  }
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
    assert.equal(count, 0, 'the conflicted URL is withheld from the import');
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
