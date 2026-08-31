// Shared cache-file model: the owned JSONC cache (link-cache.jsonc, source of
// truth) and its derived Lychee CSV (.lycheecache). Pure functions only — no
// I/O — so both bins and the tests share one implementation.
//
// Owned-file format contract (line-disciplined JSONC):
//   - first line `{`, last line `}`, one entry per line in between;
//   - every entry line ends with a comma (uniform lines keep merge=union safe);
//   - whole-line `//` comments only, attached to the entry that follows them;
//   - entries sorted by raw URL byte order (matching LC_ALL=C).
// Stripping comments and trailing commas yields valid JSON.
//
// Entry schema: { "status": INT, "ts": UNIX_SECONDS, "via": "RESOLVER" } with
// an optional "expires": "YYYY-MM-DD" (manual entries). Status generalizes
// HTTP: positive = HTTP status, 0 = unchecked, negative = tool-specific error.

export const OWNED_FILE = 'link-cache.jsonc';
export const CSV_FILE = '.lycheecache';

// Tool-specific error statuses (the htmltest-fork convention).
export const STATUS_TIMEOUT = -10;
export const STATUS_NETWORK_ERROR = -20;
export const STATUS_CERT_ERROR = -30;
export const STATUS_CLIENT_ERROR = -40;

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

// Parse one URL,STATUS,TIMESTAMP line; null when malformed.
export function parseCsvLine(raw) {
  const lastComma = raw.lastIndexOf(',');
  if (lastComma < 0) return null;
  const ts = Number(raw.slice(lastComma + 1));
  const head = raw.slice(0, lastComma);
  const statusComma = head.lastIndexOf(',');
  if (statusComma < 0) return null;
  const status = Number(head.slice(statusComma + 1).trim());
  const url = csvUnquote(head.slice(0, statusComma));
  if (!Number.isInteger(ts) || !Number.isInteger(status)) return null;
  return { url, status, ts };
}

// Parse a whole CSV cache; malformed lines are counted, duplicates keep the
// newest timestamp (union merges leave benign duplicate lines behind).
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

function parseEntryLine(line) {
  const stripped = line.trim().replace(/,$/, '');
  let obj;
  try {
    obj = JSON.parse(`{${stripped}}`);
  } catch {
    return null;
  }
  const urls = Object.keys(obj);
  if (urls.length !== 1) return null;
  const url = urls[0];
  const v = obj[url];
  if (
    v === null ||
    typeof v !== 'object' ||
    !Number.isInteger(v.status) ||
    !Number.isInteger(v.ts) ||
    typeof v.via !== 'string' ||
    (v.expires !== undefined && typeof v.expires !== 'string')
  ) {
    return null;
  }
  return { url, status: v.status, ts: v.ts, via: v.via, expires: v.expires };
}

// Parse the owned cache. Throws on malformed lines (the file is committed and
// tool-written; silent drops would lose data on the next rewrite). Comment
// lines attach to the entry that follows; comments with no following entry are
// kept as `trailing`. Duplicate URLs (union-merge leftovers) keep the entry
// with the newest ts, merging both comment runs.
export function parseOwned(text) {
  const byUrl = new Map();
  const trailing = [];
  let pending = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line === '{' || line === '}') return;
    if (COMMENT_RE.test(line)) {
      pending.push(raw.trimEnd());
      return;
    }
    const entry = parseEntryLine(raw);
    if (!entry) {
      throw new Error(`${OWNED_FILE}:${i + 1}: malformed line: ${line}`);
    }
    entry.comments = pending;
    pending = [];
    const prior = byUrl.get(entry.url);
    if (!prior) {
      byUrl.set(entry.url, entry);
    } else {
      const [older, newer] =
        entry.ts >= prior.ts ? [prior, entry] : [entry, prior];
      newer.comments = [...older.comments, ...newer.comments];
      byUrl.set(entry.url, newer);
    }
  });
  trailing.push(...pending);
  return { entries: [...byUrl.values()].sort(byUrlBytes), trailing };
}

export function serializeEntryLine({ url, status, ts, via, expires }) {
  const tail =
    expires !== undefined ? `, "expires": ${JSON.stringify(expires)}` : '';
  return `  ${JSON.stringify(url)}: { "status": ${status}, "ts": ${ts}, "via": ${JSON.stringify(via)}${tail} },`;
}

export function serializeOwned({ entries, trailing = [] }) {
  const lines = ['{'];
  for (const entry of [...entries].sort(byUrlBytes)) {
    lines.push(...(entry.comments ?? []));
    lines.push(serializeEntryLine(entry));
  }
  lines.push(...trailing, '}');
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

// Fold a post-run CSV back into the owned entries. Rules (owner, 08-31):
//   - new URL: added with via "lychee";
//   - status changed: the whole entry is replaced (via "lychee", fresh fields,
//     comments dropped — a stale rationale is worse than none);
//   - status equal: provenance-bearing entries (via != "lychee") stay
//     untouched — a re-confirmation; "lychee" entries adopt the fresh ts;
//   - expired `expires` entry present in the CSV: replaced wholesale (the seed
//     served its purpose);
//   - projected entry missing from the CSV: Lychee dropped it (it never
//     persists errors) — recorded as STATUS_CLIENT_ERROR under via "lychee",
//     keeping the entry's comments (the rationale still explains the URL).
export function mergeBack(owned, csvEntries, { now = Date.now() / 1000 } = {}) {
  const csvByUrl = new Map(csvEntries.map((e) => [e.url, e]));
  const projectedUrls = new Set(
    projectToCsv(owned.entries, { now }).map((e) => e.url),
  );
  const merged = [];

  for (const entry of owned.entries) {
    const csv = csvByUrl.get(entry.url);
    csvByUrl.delete(entry.url);

    const expired =
      entry.expires !== undefined &&
      (!Number.isFinite(dateToTs(entry.expires)) ||
        now > dateToTs(entry.expires));

    if (!csv) {
      if (projectedUrls.has(entry.url)) {
        merged.push({
          url: entry.url,
          status: STATUS_CLIENT_ERROR,
          ts: Math.floor(now),
          via: 'lychee',
          comments: entry.comments ?? [],
        });
      } else {
        merged.push(entry); // never projected (error status, expired w/o hit)
      }
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
    merged.push({ ...csv, via: 'lychee', comments: [] });
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
