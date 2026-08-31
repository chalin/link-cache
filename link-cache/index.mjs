#!/usr/bin/env node
// The `link-cache` bin (deprecated alias: `refcache`): inspect and prune a
// link cache — the owned JSONC cache (link-cache.jsonc) or a legacy Lychee CSV
// (.lycheecache). Read-only unless `--prune` is given, and never hits the
// network. Run with `--help` for usage.
//
// CSV line format: URL,STATUS,UNIX_TIMESTAMP — the URL is CSV-quoted when it
// contains a comma, so STATUS and TIMESTAMP are read from the final two fields.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CSV_FILE,
  OWNED_FILE,
  parseOwned,
  serializeOwned,
} from '../lib/cache.mjs';

const DAY = 86400;
const BUCKET_COUNT = 5;

// --- parsing ---------------------------------------------------------------

function parseLine(raw) {
  const lastComma = raw.lastIndexOf(',');
  if (lastComma < 0) return null;
  const ts = Number(raw.slice(lastComma + 1));
  const head = raw.slice(0, lastComma);
  const statusComma = head.lastIndexOf(',');
  if (statusComma < 0) return null;
  const status = head.slice(statusComma + 1).trim();
  const url = head.slice(0, statusComma);
  if (!Number.isInteger(ts) || status === '') return null;
  return { url, status, ts };
}

// Parse a whole CSV cache, keeping the original lines (so a prune can rewrite
// the file with a minimal, still-sorted diff) and tagging each entry with its
// line index.
export function parseCache(text) {
  const lines = text.split('\n');
  const entries = [];
  let malformed = 0;
  lines.forEach((raw, index) => {
    if (raw.trim() === '') return;
    const parsed = parseLine(raw);
    if (!parsed) {
      malformed += 1;
      return;
    }
    entries.push({ ...parsed, index });
  });
  return { kind: 'csv', lines, entries, malformed };
}

// Adapt the owned JSONC cache to the same entry shape (string status, index).
export function parseOwnedCache(text) {
  const owned = parseOwned(text);
  const entries = owned.entries.map((e, index) => ({
    url: e.url,
    status: String(e.status),
    ts: e.ts,
    via: e.via,
    index,
    src: e,
  }));
  return { kind: 'owned', owned, entries, malformed: 0 };
}

// --- selection / pruning ---------------------------------------------------

export function selectOldest(entries, n) {
  return [...entries]
    .sort((a, b) => a.ts - b.ts || a.index - b.index)
    .slice(0, Math.max(0, n));
}

export function resolvePruneCount(spec, total) {
  const m = /^(\d+)(%?)$/.exec(String(spec));
  if (!m) throw new Error(`--prune needs NUM or NUM%, got: ${spec}`);
  const num = Number(m[1]);
  const count = m[2] ? Math.floor((total * num) / 100) : num;
  return Math.min(count, total);
}

// --- stats -----------------------------------------------------------------

// Equal-width age histogram over 0..maxAge with an open-ended final bucket. The
// width adapts to the data, so the split stays useful whether the cache spans a
// couple of weeks or a year.
function ageHistogram(ages, maxAgeDays) {
  if (ages.length === 0) return [];
  const width = Math.max(1, Math.ceil((maxAgeDays + 1) / BUCKET_COUNT));
  const buckets = Array.from({ length: BUCKET_COUNT }, (_, i) => {
    const lo = i * width;
    const last = i === BUCKET_COUNT - 1;
    return { label: last ? `≥${lo}d` : `${lo}–${lo + width}d`, count: 0 };
  });
  for (const age of ages) {
    const i = Math.max(0, Math.min(BUCKET_COUNT - 1, Math.floor(age / width)));
    buckets[i].count += 1;
  }
  return buckets;
}

export function computeStats(
  entries,
  { now = Date.now() / 1000, malformed = 0, pruned = 0 } = {},
) {
  const statusCounts = new Map();
  const viaCounts = new Map();
  const ages = [];
  let oldestTs = null;
  let newestTs = null;

  for (const entry of entries) {
    statusCounts.set(entry.status, (statusCounts.get(entry.status) ?? 0) + 1);
    if (entry.via !== undefined) {
      viaCounts.set(entry.via, (viaCounts.get(entry.via) ?? 0) + 1);
    }
    if (oldestTs === null || entry.ts < oldestTs) oldestTs = entry.ts;
    if (newestTs === null || entry.ts > newestTs) newestTs = entry.ts;
    ages.push(Math.floor((now - entry.ts) / DAY));
  }

  const desc = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const byStatus = [...statusCounts.entries()].sort(desc);
  const byVia = [...viaCounts.entries()].sort(desc);

  const at = (ts) =>
    ts === null ? null : { ts, ageDays: Math.floor((now - ts) / DAY) };
  const oldest = at(oldestTs);

  return {
    count: entries.length,
    malformed,
    pruned,
    byStatus,
    byVia,
    oldest,
    newest: at(newestTs),
    ageBuckets: ageHistogram(ages, oldest ? oldest.ageDays : 0),
  };
}

// --- rendering -------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// Local-time `YYYY-MM-DD HH:MM:SS ZONE` — entries minutes apart share a date, so
// the time disambiguates them. Shown in the user's timezone (with a short zone
// label) to save them the UTC math.
const localStamp = (ts) => {
  const d = new Date(ts * 1000);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;
  return zone ? `${date} ${time} ${zone}` : `${date} ${time}`;
};

const displayUrl = (url) =>
  url.startsWith('"') && url.endsWith('"')
    ? url.slice(1, -1).replace(/""/g, '"')
    : url;

export function formatList(entries, n, { now = Date.now() / 1000 } = {}) {
  const chosen = selectOldest(entries, n);
  const head = `${chosen.length} oldest ${chosen.length === 1 ? 'entry' : 'entries'}:`;
  const rows = chosen.map((e) => {
    const ageDays = Math.floor((now - e.ts) / DAY);
    const via = e.via !== undefined ? `  ${e.via}` : '';
    return `  ${localStamp(e.ts)}  ${String(ageDays).padStart(4)}d  ${e.status}${via}  ${displayUrl(e.url)}`;
  });
  return [head, ...rows].join('\n');
}

export function formatStats(stats, { now = Date.now() / 1000, path } = {}) {
  const lines = [];
  lines.push(`Link cache${path ? `: ${path}` : ''}`);
  lines.push(`  Entries: ${stats.count}`);
  if (stats.pruned) {
    const before = stats.count + stats.pruned;
    lines.push(`  Pruned:  ${stats.pruned} (${before} → ${stats.count})`);
  }
  if (stats.malformed) lines.push(`  Malformed lines: ${stats.malformed}`);

  if (stats.oldest && stats.newest) {
    lines.push(
      `  Oldest:  ${localStamp(stats.oldest.ts)} (${stats.oldest.ageDays} days ago)`,
    );
    lines.push(
      `  Newest:  ${localStamp(stats.newest.ts)} (${stats.newest.ageDays} days ago)`,
    );
  }

  lines.push('  Status:');
  for (const [status, n] of stats.byStatus) {
    lines.push(`    ${status.padEnd(5)} ${n}`);
  }

  if (stats.byVia?.length) {
    lines.push('  Via:');
    const w = Math.max(...stats.byVia.map(([via]) => via.length));
    for (const [via, n] of stats.byVia) {
      lines.push(`    ${via.padEnd(w)}  ${n}`);
    }
  }

  if (stats.ageBuckets.length) {
    lines.push('  Age:');
    const w = Math.max(...stats.ageBuckets.map((b) => b.label.length));
    for (const { label, count } of stats.ageBuckets) {
      lines.push(`    ${label.padEnd(w)}  ${count}`);
    }
  }

  return lines.join('\n');
}

// --- ordered execution -----------------------------------------------------

// Run the parsed ops in order over the evolving cache, optionally scoped to
// URLs matching `match`. Pure: returns the text to print and the text to write
// (null when nothing was pruned); no I/O.
export function runOps(
  parsed,
  ops,
  { now = Date.now() / 1000, path, match = null } = {},
) {
  const removed = new Set();
  let pruned = 0;
  const out = [];
  // Match against the unquoted URL: legacy-CSV entries carry the raw
  // (possibly CSV-quoted) field, which would defeat anchored regexes.
  const inScope = (e) => (match ? match.test(displayUrl(e.url)) : true);
  const current = () =>
    parsed.entries.filter((e) => !removed.has(e.index) && inScope(e));

  for (const op of ops) {
    if (op.kind === 'list') {
      out.push(formatList(current(), Number(op.value), { now }));
    } else if (op.kind === 'prune') {
      const cur = current();
      const k = resolvePruneCount(op.value, cur.length);
      for (const victim of selectOldest(cur, k)) removed.add(victim.index);
      pruned += k;
      out.push(
        `Pruned ${k} oldest ${k === 1 ? 'entry' : 'entries'} (${cur.length} → ${cur.length - k}).`,
      );
    } else if (op.kind === 'summary') {
      const stats = computeStats(current(), {
        now,
        malformed: parsed.malformed,
        pruned,
      });
      out.push(formatStats(stats, { now, path }));
    }
  }

  let writeText = null;
  if (pruned > 0) {
    // Survivors are all unpruned entries — including those outside the
    // --match scope, which the scope only shields from ops, never from the
    // rewrite.
    const survivors = parsed.entries.filter((e) => !removed.has(e.index));
    if (parsed.kind === 'owned') {
      // Comments of surviving entries travel with them; pruned entries take
      // their comment lines along.
      writeText = serializeOwned({
        entries: survivors.map((e) => e.src),
        trailing: parsed.owned.trailing,
      });
    } else {
      writeText = parsed.lines.filter((_, i) => !removed.has(i)).join('\n');
    }
  }
  return { output: out.join('\n\n'), writeText, pruned };
}

// --- CLI -------------------------------------------------------------------

const FLAGS = new Map([
  ['-l', 'list'],
  ['--list', 'list'],
  ['-m', 'match'],
  ['--match', 'match'],
  ['-p', 'prune'],
  ['--prune', 'prune'],
  ['-s', 'summary'],
  ['--summary', 'summary'],
]);

export function parseArgs(argv) {
  const ops = [];
  const seen = new Set();
  let path = null;
  let match = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      help = true;
      continue;
    }
    const kind = FLAGS.get(a);
    if (kind) {
      if (seen.has(kind)) throw new Error(`repeated flag: ${a}`);
      seen.add(kind);
      if (kind === 'summary') {
        ops.push({ kind });
        continue;
      }
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} requires a value`);
      if (kind === 'match') {
        try {
          match = new RegExp(value);
        } catch (err) {
          throw new Error(`--match needs a valid regex: ${err.message}`);
        }
        continue;
      }
      if (kind === 'list' && !/^\d+$/.test(value)) {
        throw new Error(`--list needs a count, got: ${value}`);
      }
      if (kind === 'prune' && !/^\d+%?$/.test(value)) {
        throw new Error(`--prune needs NUM or NUM%, got: ${value}`);
      }
      ops.push({ kind, value });
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    if (path !== null) throw new Error(`unexpected extra argument: ${a}`);
    path = a;
  }

  return { ops, path, match, help };
}

const USAGE = `Usage: link-cache [CACHE_FILE] [options]

Inspect and prune a link cache: the owned ${OWNED_FILE} (default when present)
or a legacy Lychee CSV like ${CSV_FILE}. Options run in the order given, over
the evolving cache, so \`-l 5 -p 5\` lists the 5 oldest about to be pruned,
while \`-p 5 -l 5\` lists the next 5 after pruning.

  -l, --list NUM        list the NUM oldest entries
  -m, --match REGEX     scope all operations to URLs matching REGEX
  -p, --prune NUM[%]    drop the NUM (or NUM%) oldest entries, then rewrite
  -s, --summary         print a summary (counts, ages, status, via, histogram)
  -h, --help            show this help

With no options, prints the summary. A flag may not be repeated.`;

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[error] ${err.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const path = args.path ?? (existsSync(OWNED_FILE) ? OWNED_FILE : CSV_FILE);

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`[error] cannot read cache file: ${path}`);
    process.exit(1);
  }

  const isOwned = path.endsWith('.jsonc') || text.trimStart().startsWith('{');
  let parsed;
  try {
    parsed = isOwned ? parseOwnedCache(text) : parseCache(text);
  } catch (err) {
    console.error(`[error] ${err.message}`);
    process.exit(1);
  }

  const now = Date.now() / 1000;
  const ops = args.ops.length ? args.ops : [{ kind: 'summary' }];
  const { output, writeText } = runOps(parsed, ops, {
    now,
    path,
    match: args.match,
  });

  if (output) console.log(output);
  if (writeText !== null) writeFileSync(path, writeText);
}

// Real-path compare, not `file://${argv[1]}`: npm links bins as symlinks, so
// argv[1] is the symlink while import.meta.url is the real path.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Deprecation notice when invoked through the legacy alias bin.
  if (process.argv[1]?.endsWith('refcache')) {
    process.stderr.write(
      '[warn] the refcache bin is deprecated; use link-cache instead.\n',
    );
  }
  main(process.argv.slice(2));
}
