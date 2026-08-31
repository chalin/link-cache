// Tests for the shared cache-file model: owned-JSONC format contract, the
// owned<->CSV lens, merge-back policy, and migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_CLIENT_ERROR,
  mergeBack,
  migrateCsvText,
  parseCsv,
  parseOwned,
  projectToCsv,
  serializeCsv,
  serializeOwned,
} from './cache.mjs';

const NOW = 1_790_000_000; // 2026-09-11 UTC

const entry = (url, status, ts, via = 'lychee', extra = {}) => ({
  url,
  status,
  ts,
  via,
  comments: [],
  ...extra,
});

const OWNED_SAMPLE = `{
  // Seeded pending otel#11325 merge.
  "https://a.example/x": { "status": 206, "ts": 100, "via": "manual", "expires": "2026-12-31" },
  "https://b.example/": { "status": 200, "ts": 200, "via": "lychee" },
  "https://c.example/": { "status": 200, "ts": 300, "via": "browser" },
}
`;

// --- format contract ---------------------------------------------------------

test('owned file round-trips byte-identically', () => {
  const parsed = parseOwned(OWNED_SAMPLE);
  assert.equal(serializeOwned(parsed), OWNED_SAMPLE, 'round-trip is stable');
});

test('owned file is valid JSON once comments and trailing commas are stripped', () => {
  const json = OWNED_SAMPLE.split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  const obj = JSON.parse(json);
  assert.equal(Object.keys(obj).length, 3, 'all entries parse as JSON');
  assert.equal(obj['https://b.example/'].status, 200, 'field values survive');
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

test('parseOwned throws on a malformed line', () => {
  assert.throws(
    () => parseOwned('{\n  not json at all,\n}\n'),
    /malformed line/,
    'malformed committed data is an error, not a silent drop',
  );
});

test('parseOwned dedupes union-merge leftovers, newest ts wins', () => {
  const dup = `{
  // older run
  "https://a.example/": { "status": 200, "ts": 100, "via": "lychee" },
  // newer run
  "https://a.example/": { "status": 200, "ts": 900, "via": "lychee" },
}
`;
  const { entries } = parseOwned(dup);
  assert.equal(entries.length, 1, 'duplicates collapse');
  assert.equal(entries[0].ts, 900, 'newest ts wins');
  assert.deepEqual(
    entries[0].comments,
    ['  // older run', '  // newer run'],
    'both comment runs are kept',
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
  assert.match(out, /"ts": 999/, 'the edit landed');
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

// --- projection ---------------------------------------------------------------

test('projectToCsv keeps only positive statuses', () => {
  const projected = projectToCsv([
    entry('https://ok.example/', 200, 100),
    entry('https://err.example/', STATUS_CLIENT_ERROR, 100),
    entry('https://unchecked.example/', 0, 100),
  ]);
  assert.deepEqual(
    projected.map((e) => e.url),
    ['https://ok.example/'],
    'error and unchecked entries stay owned-file-only',
  );
});

test('projectToCsv freshens the ts of an unexpired manual entry', () => {
  const [p] = projectToCsv(
    [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-12-31',
      }),
    ],
    { now: NOW },
  );
  assert.equal(p.ts, NOW, 'fresh ts overrides max_cache_age');
});

test('projectToCsv omits an expired manual entry', () => {
  const projected = projectToCsv(
    [
      entry('https://a.example/', 206, 100, 'manual', {
        expires: '2026-01-01',
      }),
    ],
    { now: NOW },
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
  assert.equal(c.status, 404, 'status change lands');
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

test('mergeBack records a lychee drop as a tool-error status', () => {
  const owned = parseOwned(OWNED_SAMPLE);
  // b was projected but is absent from the post-run CSV: lychee dropped it.
  const merged = mergeBack(
    owned,
    [
      { url: 'https://a.example/x', status: 206, ts: NOW },
      { url: 'https://c.example/', status: 200, ts: NOW },
    ],
    { now: NOW },
  );
  const b = merged.entries.find((e) => e.url === 'https://b.example/');
  assert.equal(b.status, STATUS_CLIENT_ERROR, 'drop recorded as tool error');
  assert.equal(b.via, 'lychee', 'the drop is credited to the lychee run');
});

test('mergeBack keeps never-projected entries as-is', () => {
  const owned = {
    entries: [entry('https://err.example/', STATUS_CLIENT_ERROR, 100)],
    trailing: [],
  };
  const merged = mergeBack(owned, [], { now: NOW });
  assert.equal(
    merged.entries[0].status,
    STATUS_CLIENT_ERROR,
    'owned-only entry is untouched',
  );
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
  assert.equal(a.status, 200, 'live result wins');
  assert.equal(a.via, 'lychee', 'provenance moves to lychee');
  assert.equal(a.expires, undefined, 'expiry is gone');
  assert.deepEqual(a.comments, [], 'the served seed comment is dropped');
});

// --- union-merge simulation ----------------------------------------------------

test('union-merged owned file parses to a clean cache (dupes collapse)', () => {
  // Simulate merge=union keeping both sides' line for the same URL.
  const base = parseOwned(OWNED_SAMPLE);
  const oursB = { ...base.entries[1], ts: 500 };
  const union =
    '{\n' +
    serializeOwned({ entries: [oursB] })
      .split('\n')
      .slice(1, -2)
      .join('\n') +
    '\n' +
    serializeOwned(base).split('\n').slice(1).join('\n');
  const { entries } = parseOwned(union);
  assert.equal(entries.length, 3, 'no duplicate entries after re-parse');
  assert.equal(
    entries.find((e) => e.url === 'https://b.example/').ts,
    500,
    'newest side wins',
  );
});

// --- migration ------------------------------------------------------------------

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
    entries.find((e) => e.url === 'https://b.example/x,y').status,
    206,
    'comma URL survives migration',
  );
});
