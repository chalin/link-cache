#!/usr/bin/env node
// The `lychee-norm-cache` bin: run lychee over a built site, maintained around
// an owned JSONC cache (link-cache.jsonc, the committed source of truth) with
// lychee's CSV .lycheecache derived from it. Falls back to legacy CSV-only
// normalization when no owned cache exists. Run with `--help` for usage.
//
// When GITHUB_TOKEN is unset, a token is bridged from the gh CLI — lychee reads
// GITHUB_TOKEN, which also lifts the github.com rate limit; CI sets it directly.
//
// Exit codes: 0 success; 1 dead links; 2 preflight or sanity failure (lychee
// or public/ missing, zero links checked, lychee config error).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CSV_FILE,
  OWNED_FILE,
  mergeBack,
  migrateCsvText,
  parseCsv,
  parseOwned,
  projectToCsv,
  serializeCsv,
  serializeOwned,
} from '../lib/cache.mjs';

const INSTALL_HINT = 'https://github.com/lycheeverse/lychee#installation';

export const EXIT_OK = 0;
export const EXIT_DEAD_LINKS = 1;
export const EXIT_PREFLIGHT = 2;

const USAGE = `Usage: lychee-norm-cache [--migrate] [lychee args...]

Run lychee over this site's built ./public output. With a committed
${OWNED_FILE}, the ${CSV_FILE} handed to lychee is derived from it before the
run and folded back into it afterwards; otherwise ${CSV_FILE} is normalized in
place (legacy mode). Bridges a GitHub token from the gh CLI when GITHUB_TOKEN
isn't set; extra arguments pass through to lychee.

  --migrate    convert an existing ${CSV_FILE} to ${OWNED_FILE} and exit
  -h, --help   show this help

Exit codes: 0 success; 1 dead links; 2 preflight/sanity failure (missing
lychee or public/, zero links checked).

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
// Byte order via Buffer.compare — not JS string order, which compares UTF-16
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

// Check counts from lychee's stdout summary — the human line ("🔍 2 Total …
// ✅ 1 OK 🚫 0 Errors …") or --format json fields; null when neither is
// present. A parsed summary is the proof that a check actually completed.
export function parseSummary(stdout) {
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

// Map lychee's exit code to ours (0 ok, 1 dead links, 2 preflight). Lychee
// exits 2 both for broken links and for argument errors; only a parsed
// summary (the check completed) makes it a dead-links result.
export function mapLycheeExit(code, summary) {
  if (code === 0) return EXIT_OK;
  if (code === 2 && summary) return EXIT_DEAD_LINKS;
  return EXIT_PREFLIGHT;
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

function migrate(cwd) {
  const csvPath = path.join(cwd, CSV_FILE);
  const ownedPath = path.join(cwd, OWNED_FILE);
  if (existsSync(ownedPath)) return fail(`${OWNED_FILE} already exists.`);
  if (!existsSync(csvPath)) return fail(`${CSV_FILE} not found.`);
  const { text, count, malformed } = migrateCsvText(
    readFileSync(csvPath, 'utf8'),
  );
  // Migration is specified lossless: refuse rather than silently drop.
  if (malformed) {
    return fail(
      `${CSV_FILE} has ${malformed} malformed line(s); fix or remove them, then rerun.`,
    );
  }
  writeFileSync(ownedPath, text);
  console.log(
    `Migrated ${count} entries to ${OWNED_FILE}. Commit it and gitignore ${CSV_FILE}.`,
  );
  return EXIT_OK;
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const cwd = process.cwd();
  if (argv.includes('--migrate')) return migrate(cwd);

  if (!hasLychee()) {
    return fail(`lychee not found. Install: ${INSTALL_HINT}`);
  }

  const publicDir = publicDirOf(cwd);
  if (!publicDir) {
    return fail(`${path.join(cwd, 'public')} not found. Build the site first.`);
  }

  const ownedPath = path.join(cwd, OWNED_FILE);
  const cachePath = path.join(cwd, CSV_FILE);
  const owned = existsSync(ownedPath)
    ? parseOwned(readFileSync(ownedPath, 'utf8'))
    : null;
  const now = Date.now() / 1000;

  // The owned-cache lens requires lychee's cache; enforce rather than let a
  // cacheless run erase every projected entry on merge-back.
  const hasCacheFlag = argv.some(
    (a) => a === '--cache' || a.startsWith('--cache='),
  );
  if (owned && argv.includes('--cache=false')) {
    return fail(`--cache=false is incompatible with ${OWNED_FILE}.`);
  }
  const cacheArgs = hasCacheFlag ? [] : ['--cache'];

  // Derive the CSV lychee will read from the owned cache.
  if (owned) {
    writeFileSync(
      cachePath,
      serializeCsv(projectToCsv(owned.entries, { now })),
    );
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
  if (run.error) {
    return fail(`lychee failed to run: ${run.error.message}`);
  }
  const summary = parseSummary(run.stdout ?? '');
  const status = mapLycheeExit(run.status ?? 1, summary);

  // On a preflight failure lychee produced no trustworthy results: leave both
  // caches untouched (folding would mislabel unprojected entries as failed).
  if (status === EXIT_PREFLIGHT) {
    return fail('lychee did not complete a check; caches left untouched.');
  }

  // A clean run in which nothing got a verdict is a false-clean (empty or
  // fully-excluded public/), not a success — and folding it would mislabel
  // unattempted entries as failed, so the check precedes the fold. Cache hits
  // count toward OK in lychee's summary, so a fully-cached run passes.
  if (status === EXIT_OK && summary && summary.ok + summary.errors === 0) {
    return fail('lychee verified 0 links: empty or fully-excluded public/?');
  }

  // Fold the post-run CSV back into the owned cache (also on dead links, so a
  // completed run with failures still leaves a stable, truthful cache), or
  // normalize the CSV in place in legacy mode.
  if (owned) {
    const csvEntries = existsSync(cachePath)
      ? parseCsv(readFileSync(cachePath, 'utf8')).entries
      : [];
    writeFileSync(
      ownedPath,
      serializeOwned(mergeBack(owned, csvEntries, { now })),
    );
    writeFileSync(cachePath, sortCacheText(readFileSync(cachePath, 'utf8')));
  } else if (existsSync(cachePath)) {
    writeFileSync(cachePath, sortCacheText(readFileSync(cachePath, 'utf8')));
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
