// Shared cache-file model: the owned JSONC cache (link-cache.jsonc, source of
// truth) and its derived Lychee CSV (.lycheecache). Pure functions only — no
// I/O — so both bins and the tests share one implementation.
//
// Owned-file format: JSONC, pretty-printed by construction in Prettier's jsonc
// style (2-space indent, one field per line, trailing commas), so the file
// passes `prettier --check` untouched. Every entry is multi-line — the field
// separation is what keeps concurrent edits merging cleanly — and whole-line
// `//` comments attach to the entry that follows them. Entries are sorted by
// raw URL byte order (matching LC_ALL=C). Stripping comments and trailing
// commas yields valid JSON.
//
// Entry schema: { "status": INT, "when": RFC3339_UTC, "via": "RESOLVER" }
// with an optional "expires": "YYYY-MM-DD" (manual entries). Status
// generalizes HTTP: positive = HTTP status, 0 = unchecked, negative =
// tool-specific error. `when` is the canonical whole-second UTC form
// (YYYY-MM-DDTHH:MM:SSZ) — no fractional seconds, no offsets — validated
// strictly: this tool is the file's only writer, so a non-canonical value is
// a bug to surface, not smooth over (lesson from the htmltest-era
// RFC3339Nano/offset churn).

export const OWNED_FILE = 'link-cache.jsonc';
export const CSV_FILE = '.lycheecache';

// Tool-specific error statuses (the htmltest-fork convention).
export const STATUS_TIMEOUT = -10;
export const STATUS_NETWORK_ERROR = -20;
export const STATUS_CERT_ERROR = -30;
export const STATUS_CLIENT_ERROR = -40;

const WHEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Epoch seconds -> canonical `when`.
export function tsToWhen(ts) {
  return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Canonical `when` -> epoch seconds; NaN when non-canonical (strict: the
// regex gates shape, and the round-trip equality check rejects impossible
// dates that Date.parse would silently normalize, e.g. Feb 30 -> Mar 2).
export function whenToTs(when) {
  if (!WHEN_RE.test(when)) return NaN;
  const ts = Date.parse(when) / 1000;
  return tsToWhen(ts) === when ? ts : NaN;
}

const byUrlBytes = (a, b) =>
  Buffer.compare(Buffer.from(a.url), Buffer.from(b.url));

// --- CSV (.lycheecache) ------------------------------------------------------

// Unquote a CSV field: lychee quotes URLs that contain a comma.
export function csvUnquote(field) {
  return field.startsWith('"') && field.endsWith('"')
    ? field.slice(1, -1).replace(/""/g, '"')
    : field;
}

export function csvQuote(url) {
  return /[",]/.test(url) ? `"${url.replace(/"/g, '""')}"` : url;
}

// Parse one URL,STATUS,TIMESTAMP line; null when malformed. Lexically strict:
// STATUS and TIMESTAMP must be non-empty digit runs (`Number('')` is 0, which
// would silently coin status-0/epoch-0 entries from truncated lines).
export function parseCsvLine(raw) {
  const lastComma = raw.lastIndexOf(',');
  if (lastComma < 0) return null;
  const tsField = raw.slice(lastComma + 1);
  const head = raw.slice(0, lastComma);
  const statusComma = head.lastIndexOf(',');
  if (statusComma < 0) return null;
  const statusField = head.slice(statusComma + 1).trim();
  if (!/^\d+$/.test(tsField) || !/^-?\d+$/.test(statusField)) return null;
  const url = csvUnquote(head.slice(0, statusComma));
  if (url === '') return null;
  return { url, status: Number(statusField), ts: Number(tsField) };
}

// Parse a whole CSV cache; malformed lines are counted, duplicates keep the
// newest timestamp.
export function parseCsv(text) {
  const byUrl = new Map();
  let malformed = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const entry = parseCsvLine(raw);
    if (!entry) {
      malformed += 1;
      continue;
    }
    const prior = byUrl.get(entry.url);
    if (!prior || entry.ts >= prior.ts) byUrl.set(entry.url, entry);
  }
  return { entries: [...byUrl.values()].sort(byUrlBytes), malformed };
}

export function serializeCsv(entries) {
  if (entries.length === 0) return '';
  return (
    [...entries]
      .sort(byUrlBytes)
      .map((e) => `${csvQuote(e.url)},${e.status},${e.ts}`)
      .join('\n') + '\n'
  );
}

// --- owned JSONC (link-cache.jsonc) -----------------------------------------

const COMMENT_RE = /^\s*\/\//;
// The line that opens an entry: `"URL": {` (the key is a JSON string, which
// cannot span lines).
const ENTRY_OPEN_RE = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*\{/;

// Strip a line-ending comma when the next non-blank line closes an object —
// per-line, so commas inside URL strings are never touched (JSON strings
// cannot span lines).
function stripTrailingCommas(lines) {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].trimEnd().endsWith(',')) continue;
    let j = i + 1;
    while (j < out.length && out[j].trim() === '') j++;
    if (j < out.length && out[j].trim().startsWith('}')) {
      out[i] = out[i].trimEnd().slice(0, -1);
    }
  }
  return out;
}

const ENTRY_FIELDS = new Set(['status', 'when', 'via', 'expires']);

// A calendar-real YYYY-MM-DD (round-trip check rejects e.g. Feb 30).
function isCanonicalDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// Rejects unknown fields (a rewrite would silently drop them) and restricts
// `expires` to manual entries — resolvers set statuses, owners set trust
// windows. Relax the via restriction if a named resolver ever needs expiry.
// Statuses live in one of three domains: HTTP (100-999, the only ones that
// project into Lychee's CSV — Lychee rejects codes outside that range at
// load, which would wedge the run), 0 (unchecked), negative (tool errors).
function isValidStatus(s) {
  return Number.isInteger(s) && (s < 0 || s === 0 || (s >= 100 && s <= 999));
}

function validateEntry(url, v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    Object.keys(v).every((k) => ENTRY_FIELDS.has(k)) &&
    isValidStatus(v.status) &&
    typeof v.when === 'string' &&
    Number.isFinite(whenToTs(v.when)) &&
    whenToTs(v.when) >= 0 && // pre-epoch would project a negative CSV ts
    typeof v.via === 'string' &&
    (v.expires === undefined ||
      (v.via === 'manual' && isCanonicalDate(v.expires)))
  );
}

// Parse the owned cache. Throws on malformed content (the file is committed
// and tool-written; silent drops would lose data on the next rewrite),
// including blank input — a zero-byte file is a truncated write, not an empty
// cache (that one is `{}`). Comments are collected line-wise and attached to
// the entry whose opening `"URL": {` line follows them; comments after the
// last entry are kept as `trailing`. Duplicate URL keys are rejected: with
// merge=union gone, a duplicate is a bad merge resolution to surface, not a
// leftover to paper over.
export function parseOwned(text) {
  if (text.trim() === '') {
    throw new Error(`${OWNED_FILE}: blank file (truncated write?)`);
  }
  const lines = text.split('\n');

  // Comment attachment pass; also detects duplicate keys line-wise (the JSON
  // pass below cannot: Object.entries already collapsed them).
  const commentsByUrl = new Map();
  const seenUrls = new Set();
  const trailing = [];
  let pending = [];
  for (const raw of lines) {
    if (COMMENT_RE.test(raw)) {
      pending.push(`  ${raw.trim()}`);
      continue;
    }
    const open = ENTRY_OPEN_RE.exec(raw);
    if (open) {
      const url = JSON.parse(open[1]);
      if (seenUrls.has(url)) {
        throw new Error(`${OWNED_FILE}: duplicate entry for ${url}`);
      }
      seenUrls.add(url);
      if (pending.length) {
        commentsByUrl.set(url, pending);
        pending = [];
      }
    }
  }
  trailing.push(...pending);

  // Data pass: strip comments and trailing commas, then parse as JSON.
  const dataLines = stripTrailingCommas(
    lines.filter((l) => !COMMENT_RE.test(l)),
  );
  let obj;
  try {
    obj = JSON.parse(dataLines.join('\n') || '{}');
  } catch (err) {
    throw new Error(`${OWNED_FILE}: invalid JSONC: ${err.message}`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${OWNED_FILE}: top level must be an object`);
  }

  const entries = [];
  for (const [url, v] of Object.entries(obj)) {
    if (!validateEntry(url, v)) {
      throw new Error(`${OWNED_FILE}: malformed entry for ${url}`);
    }
    entries.push({
      url,
      status: v.status,
      ts: whenToTs(v.when), // epoch internally; `when` re-derives on write
      via: v.via,
      expires: v.expires,
      comments: commentsByUrl.get(url) ?? [],
    });
  }
  return { entries: entries.sort(byUrlBytes), trailing };
}

// Canonical serialization = Prettier's jsonc style (2-space indent, one field
// per line, trailing commas, always multi-line), so the output is
// prettier-idempotent by construction.
export function serializeEntry({ url, status, ts, via, expires }) {
  const fields = [
    `    "status": ${status},`,
    `    "when": ${JSON.stringify(tsToWhen(ts))},`,
    `    "via": ${JSON.stringify(via)},`,
  ];
  if (expires !== undefined) {
    fields.push(`    "expires": ${JSON.stringify(expires)},`);
  }
  return [`  ${JSON.stringify(url)}: {`, ...fields, '  },'].join('\n');
}

export function serializeOwned({ entries, trailing = [] }) {
  if (entries.length === 0 && trailing.length === 0) return '{}\n';
  const lines = ['{'];
  for (const entry of [...entries].sort(byUrlBytes)) {
    lines.push(...(entry.comments ?? []).map((c) => `  ${c.trim()}`));
    lines.push(serializeEntry(entry));
  }
  lines.push(...trailing.map((c) => `  ${c.trim()}`), '}');
  return lines.join('\n') + '\n';
}

// --- lens: owned -> CSV projection ------------------------------------------

const dateToTs = (isoDate) => Date.parse(`${isoDate}T23:59:59Z`) / 1000;

// Project the owned entries into Lychee's CSV. Only positive (HTTP) statuses
// project — Lychee never persists errors, and would re-drop the rest. An
// unexpired entry with `expires` projects with a fresh timestamp so it
// outlives Lychee's max_cache_age until its own expiry; once expired it is
// omitted, forcing a live re-check.
export function projectToCsv(entries, { now = Date.now() / 1000 } = {}) {
  const projected = [];
  for (const e of entries) {
    if (e.status <= 0) continue;
    if (e.expires !== undefined) {
      const cutoff = dateToTs(e.expires);
      if (!Number.isFinite(cutoff) || now > cutoff) continue;
      projected.push({ url: e.url, status: e.status, ts: Math.floor(now) });
      continue;
    }
    projected.push({ url: e.url, status: e.status, ts: e.ts });
  }
  return projected;
}

// --- lens: CSV -> owned merge-back ------------------------------------------

// Fold a post-run CSV back into the owned entries. Rules (owner, 08-31;
// absence-inference dropped 08-31 adversarial round):
//   - new URL: added with via "lychee";
//   - status changed: the whole entry is replaced (via "lychee", fresh fields,
//     comments dropped — a stale rationale is worse than none);
//   - status equal: provenance-bearing entries (via != "lychee") stay
//     untouched — a re-confirmation; "lychee" entries adopt the fresh ts;
//   - expired `expires` entry present in the CSV: replaced wholesale (the seed
//     served its purpose);
//   - URL in `failedUrls` (positive evidence from the run's own error report):
//     recorded as STATUS_CLIENT_ERROR under via "lychee": for existing
//     entries (keeping their comments: the rationale still explains the URL)
//     whatever their scheme, and for URLs new to the cache when http(s),
//     beating a residual CSV row for the same URL. Minting is http(s)-only
//     because a negative status never projects, so it heals only via a later
//     CSV success row, which never comes for file:// or mailto: (lychee
//     persists only http(s) rows); file:// keys also embed machine-specific
//     absolute paths. Those failures already fail the run via the exit code;
//   - entry missing from the CSV without failure evidence: untouched. CSV
//     absence is ambiguous — cache_exclude_status, max_cache_age expiry, and
//     URLs no longer in the site all remove entries from healthy runs — so it
//     never justifies a failure verdict on its own.
export function mergeBack(
  owned,
  csvEntries,
  { now = Date.now() / 1000, failedUrls = new Set() } = {},
) {
  const csvByUrl = new Map(csvEntries.map((e) => [e.url, e]));
  const failed = new Set(failedUrls);
  const merged = [];

  const failureEntry = (url, comments = []) => ({
    url,
    status: STATUS_CLIENT_ERROR,
    ts: Math.floor(now),
    via: 'lychee',
    comments,
  });

  for (const entry of owned.entries) {
    const csv = csvByUrl.get(entry.url);
    csvByUrl.delete(entry.url);

    const expired =
      entry.expires !== undefined &&
      (!Number.isFinite(dateToTs(entry.expires)) ||
        now > dateToTs(entry.expires));

    if (failed.delete(entry.url)) {
      merged.push(failureEntry(entry.url, entry.comments ?? []));
      continue;
    }

    if (!csv) {
      merged.push(entry); // absent without evidence: untouched
      continue;
    }

    if (expired || csv.status !== entry.status) {
      merged.push({
        url: entry.url,
        status: csv.status,
        ts: csv.ts,
        via: 'lychee',
        comments: [],
      });
    } else if (entry.via === 'lychee') {
      merged.push({ ...entry, ts: csv.ts });
    } else {
      merged.push(entry); // re-confirmation: provenance untouched
    }
  }

  for (const csv of csvByUrl.values()) {
    if (failed.delete(csv.url)) {
      merged.push(failureEntry(csv.url));
      continue;
    }
    merged.push({ ...csv, via: 'lychee', comments: [] });
  }

  // Unmatched failures: http(s)-only minting, per the rules above.
  for (const url of failed) {
    if (/^https?:\/\//.test(url)) merged.push(failureEntry(url));
  }

  return { entries: merged.sort(byUrlBytes), trailing: owned.trailing };
}

// --- migration ---------------------------------------------------------------

// One-shot .lycheecache -> link-cache.jsonc: every entry becomes via "lychee".
export function migrateCsvText(csvText) {
  const { entries, malformed } = parseCsv(csvText);
  const owned = {
    entries: entries.map((e) => ({ ...e, via: 'lychee', comments: [] })),
    trailing: [],
  };
  return { text: serializeOwned(owned), count: entries.length, malformed };
}
