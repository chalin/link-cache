#!/usr/bin/env node
// The `lychee-norm-cache` bin: run lychee over a built site, maintained around
// an owned JSONC cache (link-cache.jsonc, the committed source of truth) with
// lychee's CSV .lycheecache derived from it. Falls back to legacy CSV-only
// normalization when no owned cache exists. Run with `--help` for usage.
//
// When GITHUB_TOKEN is unset, a token is bridged from the gh CLI -- lychee reads
// GITHUB_TOKEN, which also lifts the github.com rate limit; CI sets it directly.
//
// Exit codes: 0 success; 1 dead links; 2 preflight or sanity failure (lychee
// or public/ missing, zero links checked, lychee config error).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CSV_FILE,
  OWNED_FILE,
  RESULT_ERROR,
  RESULT_TIMEOUT,
  mergeBack,
  migrateCsvText,
  parseCsv,
  parseOwned,
  projectToCsv,
  serializeCsv,
  serializeOwned,
} from '../lib/cache.mjs';
import { writeFileAtomic } from '../lib/write.mjs';

const INSTALL_HINT = 'https://github.com/lycheeverse/lychee#installation';

export const EXIT_OK = 0;
export const EXIT_DEAD_LINKS = 1;
export const EXIT_PREFLIGHT = 2;

const USAGE = `Usage: lychee-norm-cache [--import] [lychee args...]

Run lychee over this site's built ./public output. With a committed
${OWNED_FILE}, the ${CSV_FILE} handed to lychee is derived from it before the
run and folded back into it afterwards; otherwise ${CSV_FILE} is normalized in
place (legacy mode). Bridges a GitHub token from the gh CLI when GITHUB_TOKEN
isn't set; extra arguments pass through to lychee.

Cached 2xx results serve until lychee's max_cache_age says otherwise, unless
the entry's expires holds (then it always serves); failure words and non-2xx
results re-check on every run.

  --import       convert an existing ${CSV_FILE} to ${OWNED_FILE} and exit
  -h, --help     show this help

Exit codes: 0 success; 1 dead links; 2 preflight/sanity failure (missing
lychee or public/, lychee config or usage errors, zero links verified).

Lychee's summary must reach stdout in its default or JSON format -- it is the
wrapper's proof that a check completed -- so flags that divert or reshape
stdout (--output, --format junit, --dump-inputs, ...) are unsupported here;
run lychee directly for those.

Requires the lychee binary on your PATH and a lychee.toml at the site root.
Run \`lychee --help\` for all link-checking options.`;

// --- pure helpers (unit-tested) --------------------------------------------

// Prefer an existing GITHUB_TOKEN; otherwise fall back to the gh CLI; '' if neither.
export function resolveToken({ env = process.env, runGh = ghAuthToken } = {}) {
  const fromEnv = (env.GITHUB_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  return (runGh() ?? '').trim();
}

// Sort .lycheecache by raw byte value (matching `LC_ALL=C sort`) and terminate
// with a single newline, so lychee's nondeterministic cache writes diff cleanly.
// Byte order via Buffer.compare -- not JS string order, which compares UTF-16
// code units and can diverge from LC_ALL=C on non-ASCII URLs.
export function sortCacheText(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return lines.join('\n') + '\n';
}

// Return the site's public/ dir under the given cwd, or null if missing.
// The path is kept lexical (symlinks unresolved): sites often symlink public/
// to a separate diffable repo, and the /public/-anchored exclude_path patterns
// in lychee.toml silently stop matching if the path handed to lychee no longer
// contains the /public component.
export function publicDirOf(cwd) {
  const publicDir = path.join(cwd, 'public');
  try {
    if (!statSync(publicDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return publicDir;
}

// lychee colors its output when CLICOLOR_FORCE is set (even onto the piped
// stdout we capture, since the spawn env passes process.env through), and SGR
// codes around the tags defeat the line parsers (captured live from 0.24.2),
// so failures would vanish silently. Strip before parsing.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Check counts from lychee's stdout summary -- the human line ("🔍 2 Total …
// ✅ 1 OK 🚫 0 Errors …") or --format json fields; null when neither is
// present. A parsed summary is the proof that a check actually completed.
export function parseSummary(stdout) {
  stdout = stripAnsi(stdout);
  const m = /(\d+)\s+Total\b[\s\S]*?(\d+)\s+OK\b[\s\S]*?(\d+)\s+Errors?\b/.exec(
    stdout,
  );
  if (m) return { total: +m[1], ok: +m[2], errors: +m[3] };
  const total = /"total"\s*:\s*(\d+)/.exec(stdout);
  const ok = /"successful"\s*:\s*(\d+)/.exec(stdout);
  const errors = /"errors"\s*:\s*(\d+)/.exec(stdout);
  return total && ok && errors
    ? { total: +total[1], ok: +ok[1], errors: +errors[1] }
    : null;
}

// Map lychee's exit code to ours (0 ok, 1 dead links, 2 preflight). A parsed
// summary is required in every case: lychee exits 2 both for broken links and
// for argument errors, and exits 0 from non-check modes (--dump-inputs) and
// diverted-output runs (--output FILE, --format junit/detailed) -- without the
// summary there is no proof a check completed.
export function mapLycheeExit(code, summary) {
  if (!summary) return EXIT_PREFLIGHT;
  if (code === 0) return EXIT_OK;
  if (code === 2) return EXIT_DEAD_LINKS;
  return EXIT_PREFLIGHT;
}

// URLs the run itself reported as failing, mapped to a failure word from
// lychee's own tag vocabulary ("error" or "timeout"): the human per-URL
// lines, or --format json's failure maps. Positive per-URL evidence for the
// merge-back's failure recording (CSV absence alone proves nothing:
// merge-back rules, lib/cache.mjs).
//
// Line shapes (lychee 0.24, verified against live output and Status::
// code_as_string in its source): failures carry the word tags ERROR or
// TIMEOUT, or a numeric status tag with a failure remark ("[403] URL … |
// Rejected status code: 403 Forbidden", "[404] URL | Error (cached)").
// Numeric tags alone are not failures: -vv prints accepted URLs the same way
// ("[200] URL (at 1:1)", "[200] URL | OK (cached)"). Word tags are
// whitelisted, not blacklisted: the others (EXCLUDED; IGNORED, unsupported
// URLs printed on green runs; UNKNOWN, mail outside lychee's is_error) are
// non-failures, as are lychee's log-level lines ([INFO], [WARN], …), and a
// recorded failure becomes a committed cache entry (merge-back rules again),
// making a false positive costlier than a false negative. For the same reason
// the URL token must look like a URL: absolute with scheme:// or mailto:
// (the one scheme://-less form lychee checks).
const FAILURE_TAGS = new Set(['ERROR', 'TIMEOUT']);
const URL_SHAPE = /^(\w[\w+.-]*:\/\/|mailto:)/;
export function parseFailedUrls(stdout) {
  stdout = stripAnsi(stdout);
  const failed = new Map();
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    // --format json, possibly with a trailing human "Hint:" line after the
    // document. Failures live in error_map/timeout_map (0.24's shape);
    // fail_map covers older lychee.
    try {
      const json = JSON.parse(trimmed.slice(0, trimmed.lastIndexOf('}') + 1));
      for (const [map, word] of [
        [json.fail_map, RESULT_ERROR],
        [json.error_map, RESULT_ERROR],
        [json.timeout_map, RESULT_TIMEOUT],
      ]) {
        for (const failures of Object.values(map ?? {})) {
          for (const f of failures) {
            const url = typeof f.url === 'string' ? f.url : f.url?.url;
            if (url) failed.set(url, word);
          }
        }
      }
      return failed;
    } catch {
      // fall through to the line scan
    }
  }
  for (const m of stdout.matchAll(/^\s*\[(\w+)\]\s+(\S+)(.*)$/gm)) {
    const [, tag, url, rest] = m;
    if (!URL_SHAPE.test(url)) continue;
    if (/^\d+$/.test(tag)) {
      if (
        /\|\s*(Rejected|Failed|Error \(cached\)|Request timed out)/.test(rest)
      ) {
        failed.set(
          url,
          /Request timed out/.test(rest) ? RESULT_TIMEOUT : RESULT_ERROR,
        );
      }
    } else if (FAILURE_TAGS.has(tag.toUpperCase())) {
      failed.set(
        url,
        tag.toUpperCase() === 'TIMEOUT' ? RESULT_TIMEOUT : RESULT_ERROR,
      );
    }
  }
  return failed;
}

// --- lychee invocation -----------------------------------------------------

function ghAuthToken() {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  return r.error || r.status !== 0 ? '' : (r.stdout ?? '').trim();
}

function hasLychee() {
  return !spawnSync('lychee', ['--version'], { stdio: 'ignore' }).error;
}

function fail(message) {
  process.stderr.write(`[help] ${message}\n`);
  return EXIT_PREFLIGHT;
}

function importCsv(cwd) {
  const csvPath = path.join(cwd, CSV_FILE);
  const ownedPath = path.join(cwd, OWNED_FILE);
  if (existsSync(ownedPath)) return fail(`${OWNED_FILE} already exists.`);
  if (!existsSync(csvPath)) return fail(`${CSV_FILE} not found.`);
  const { text, count, malformed, conflicting, unmappable } = migrateCsvText(
    readFileSync(csvPath, 'utf8'),
  );
  // Migration is specified lossless: refuse rather than silently drop.
  if (malformed) {
    return fail(
      `${CSV_FILE} has ${malformed} malformed line(s); fix or remove them, then rerun.`,
    );
  }
  if (conflicting) {
    return fail(
      `${CSV_FILE} has ${conflicting} URL(s) with conflicting duplicate rows; fix or remove them, then rerun.`,
    );
  }
  if (unmappable) {
    return fail(
      `${CSV_FILE} has ${unmappable} entr${unmappable === 1 ? 'y' : 'ies'} with an unmappable status or timestamp; fix or remove them, then rerun.`,
    );
  }
  writeFileAtomic(ownedPath, text);
  console.log(
    `Imported ${count} ${count === 1 ? 'entry' : 'entries'} to ${OWNED_FILE}. Commit it and gitignore ${CSV_FILE}.`,
  );
  return EXIT_OK;
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const cwd = process.cwd();
  if (argv.includes('--import')) return importCsv(cwd);

  if (!hasLychee()) {
    return fail(`lychee not found. Install: ${INSTALL_HINT}`);
  }

  const publicDir = publicDirOf(cwd);
  if (!publicDir) {
    return fail(`${path.join(cwd, 'public')} not found. Build the site first.`);
  }

  const now = Date.now() / 1000;
  const ownedPath = path.join(cwd, OWNED_FILE);
  const cachePath = path.join(cwd, CSV_FILE);
  const owned = existsSync(ownedPath)
    ? parseOwned(readFileSync(ownedPath, 'utf8'), { now })
    : null;

  // The owned-cache lens requires lychee's cache; enforce rather than let a
  // cacheless run erase every projected entry on merge-back.
  const hasCacheFlag = argv.some(
    (a) => a === '--cache' || a.startsWith('--cache='),
  );
  if (owned && argv.includes('--cache=false')) {
    return fail(`--cache=false is incompatible with ${OWNED_FILE}.`);
  }
  const cacheArgs = hasCacheFlag ? [] : ['--cache'];

  // Derive the CSV lychee will read from the owned cache; keep the projected
  // timestamps so merge-back can tell echoed cache hits from real re-checks.
  let projectedTs = new Map();
  if (owned) {
    const projected = projectToCsv(owned.entries, { now });
    projectedTs = new Map(projected.map((e) => [e.url, e.ts]));
    writeFileAtomic(cachePath, serializeCsv(projected));
  }

  const token = resolveToken();
  // stdout is captured for the completion/zero-check sanity checks and echoed
  // afterwards; stderr (progress) still streams. The generous buffer bound
  // keeps spawnSync simple; overruns surface via run.error below.
  const run = spawnSync(
    'lychee',
    [
      '--config',
      'lychee.toml',
      ...cacheArgs,
      '--root-dir',
      publicDir,
      ...argv,
      publicDir,
    ],
    {
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GITHUB_TOKEN: token },
    },
  );
  if (run.stdout) process.stdout.write(run.stdout);

  // A failed or verdict-free run never folds; remove the derived CSV rather
  // than leave it behind (a projection no completed run consumed is not a
  // cache state to keep).
  const bail = (message) => {
    if (owned) rmSync(cachePath, { force: true });
    return fail(message);
  };

  if (run.error) {
    return bail(`lychee failed to run: ${run.error.message}`);
  }
  const summary = parseSummary(run.stdout ?? '');
  const status = mapLycheeExit(run.status ?? 1, summary);

  // On a preflight failure lychee produced no trustworthy results: leave the
  // owned cache untouched (folding would mislabel unprojected entries as
  // failed).
  if (status === EXIT_PREFLIGHT) {
    return bail('lychee did not complete a check; owned cache left untouched.');
  }

  // A clean run in which nothing got a verdict is a false-clean (empty or
  // fully-excluded public/), not a success -- and folding it would mislabel
  // unattempted entries as failed, so the check precedes the fold. Cache hits
  // count toward OK in lychee's summary, so a fully-cached run passes.
  if (status === EXIT_OK && summary && summary.ok + summary.errors === 0) {
    return bail('lychee verified 0 links: empty or fully-excluded public/?');
  }

  // Fold the post-run CSV back into the owned cache (also on dead links, so a
  // completed run with failures still leaves a stable, truthful cache), or
  // normalize the CSV in place in legacy mode.
  if (owned) {
    const csvEntries = existsSync(cachePath)
      ? parseCsv(readFileSync(cachePath, 'utf8')).entries
      : [];
    // Failure evidence counts only on a dead-links exit: a green run means
    // lychee accepted everything it printed (--accept-timeouts runs print
    // "[TIMEOUT] URL …" lines while exiting 0), so recording those would mint
    // and churn failure entries on every clean run.
    const failedUrls =
      status === EXIT_DEAD_LINKS
        ? parseFailedUrls(run.stdout ?? '')
        : new Map();
    writeFileAtomic(
      ownedPath,
      serializeOwned(
        mergeBack(owned, csvEntries, { now, failedUrls, projectedTs }),
      ),
    );
    writeFileAtomic(cachePath, sortCacheText(readFileSync(cachePath, 'utf8')));
  } else if (existsSync(cachePath)) {
    writeFileAtomic(cachePath, sortCacheText(readFileSync(cachePath, 'utf8')));
  }

  return status;
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
  // Wrapper exceptions (e.g. a malformed owned cache) are preflight failures,
  // not dead links: warn wrappers must not swallow them.
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`[error] ${err.message}\n`);
    process.exit(EXIT_PREFLIGHT);
  }
}
