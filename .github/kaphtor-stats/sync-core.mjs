// kaphtor-stats-sync v1: a shared file (see stats-format.mjs). Each site's own script, beside it, decides what the
// counts print into and how the result ships.
/**
 * Reads kaphtor's headline counts at a commit that passed its gate, against the snapshot a site printed last.
 *
 *   readCounts(options, kaphtor)  the counts, or 'waiting'; throws on every refusal, having written nothing
 *   snapshotOf(sha, stats)        { kaphtor_commit, stats }: schema_version and the counts in PATHS, nothing else
 *   message(sha, moves)           the commit message for the counts that moved
 *   writeAtomic(path, text)       a temporary file, then a rename; nothing is left behind on failure
 *   report(fields)                one line per field in $GITHUB_OUTPUT, and one in the step summary
 *   invoked(url)                  whether the module at `url` is the script node was asked to run
 *
 * readCounts takes, in order:
 * 1. The commit: options.sha (40 hex digits), or main's head on GitHub.
 * 2. kaphtor's `gate` check on it, as run by GitHub Actions: success goes on. While no run has passed, the sync waits
 *    for 48 hours after the commit, then fails. Any other result fails.
 * 3. data/linear-a/stats.json at that commit, from raw.githubusercontent.com (kaphtor is public). It must pass
 *    schema 1.
 * 4. The site's snapshot at options.snapshot. A missing or invalid one is an error unless options.rewrite.
 * 5. No printed total may fall by more than 5% unless options.allowDropSha names the commit.
 * `fromFile` stands in for kaphtor with a stats.json on disk (fixtures and pilots), and its gate always passes.
 */
import { realpathSync } from 'node:fs';
import { appendFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dropped, get, grouped, PATHS, validate } from './stats-format.mjs';

export const REPO = 'plasma-ai/kaphtor';
export const STATS_FILE = 'data/linear-a/stats.json';
export const GATE = 'gate';
export const GITHUB_ACTIONS_APP = 15368;
export const WAIT_LIMIT_HOURS = 48;
const MAX_CHARS = 64 * 1024;
const TIMEOUT_MS = 30_000;
const AGENT = 'kaphtor-stats-sync';
const SHA = /^[0-9a-f]{40}$/;

// How the commit message names each count: [before the numbers, after them].
export const LABELS = {
  'corpus.records': ['corpus', 'records'],
  'corpus.documents': ['documents', ''],
  'lexicon.entries': ['lexicon', 'entries'],
  'lexicon.tiers.CONFIRMED': ['confirmed', ''],
  'lexicon.tiers.PROBABLE': ['probable', ''],
  'lexicon.tiers.CANDIDATE': ['candidate', ''],
  'lexicon.tiers.SPECULATIVE': ['speculative', ''],
  'translations.complete': ['translations', ''],
  'translations.incomplete': ['partial translations', ''],
  'sign_values.total': ['sign values', ''],
  'sign_values.resolved': ['resolved signs', ''],
  'sign_values.phonemic': ['phonemic values', ''],
  'sign_values.logographic': ['logographic values', ''],
  names: ['names', ''],
  semitic_roots: ['Semitic roots', ''],
};

/** The latest `gate` run by GitHub Actions in a check-runs response, or null. */
export function latestRun({ check_runs: runs }) {
  const ours = runs.filter((run) => run.app?.id === GITHUB_ACTIONS_APP);
  return ours.length ? ours.reduce((a, b) => (b.id > a.id ? b : a)) : null;
}

/** 'go', 'wait' or 'fail' for a check-runs response; the latest GitHub Actions run decides. */
export function gateVerdict(response) {
  const latest = latestRun(response);
  if (!latest || latest.status !== 'completed') return 'wait';
  if (latest.conclusion === 'success') return 'go';
  if (latest.conclusion === 'cancelled' || latest.conclusion === 'stale') return 'wait';
  return 'fail';
}

/** The counts that moved, in PATHS order: [{ path, from, to }]. */
export function changed(before, after) {
  return PATHS.map((path) => ({ path, from: get(before, path), to: get(after, path) }))
    .filter(({ from, to }) => from !== to);
}

export function message(sha, moves) {
  const parts = moves.map(({ path, from, to }) => {
    const [head, tail] = LABELS[path];
    const span = from === undefined ? ['now', grouped.format(to)] : [grouped.format(from), 'to', grouped.format(to)];
    return [head, ...span, tail].filter(Boolean).join(' ');
  });
  return `kaphtor ${sha.slice(0, 8)}: ${parts.join(', ')}`;
}

/** The snapshot for `stats` read at `sha`: schema_version and the counts in PATHS, nothing else from the file. */
export function snapshotOf(sha, stats) {
  const kept = { schema_version: stats.schema_version };
  for (const path of PATHS) {
    const keys = path.split('.');
    const node = keys.slice(0, -1).reduce((parent, key) => (parent[key] ??= {}), kept);
    node[keys.at(-1)] = get(stats, path);
  }
  return { kaphtor_commit: sha, stats: kept };
}

/** fetch with a timeout, and an error that names the address and the cause. */
export async function request(url, headers, timeoutMs = TIMEOUT_MS) {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = error.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s`
      : (error.cause?.code ?? error.cause?.message ?? error.message);
    throw new Error(`${url}: ${cause}`);
  }
}

/** The error for a failed GitHub API response, with GitHub's own message and a spent rate limit named. */
export async function httpError(label, response) {
  const body = await response.json().catch(() => ({}));
  const said = typeof body.message === 'string' ? ` ${JSON.stringify(body.message)}` : '';
  const spent = response.headers.get('x-ratelimit-remaining') === '0' ? ' (the API rate limit is spent)' : '';
  return new Error(`${label}: ${response.status}${said}${spent}`);
}

async function github(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': AGENT, 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await request(`https://api.github.com/repos/${REPO}/${path}`, headers);
  if (!response.ok) throw await httpError(`GitHub API ${path}`, response);
  return response.json();
}

/** kaphtor on GitHub. */
export const live = {
  async head(sha) {
    const commit = await github(`commits/${sha ?? 'main'}`);
    return { sha: commit.sha, date: commit.commit.committer.date };
  },
  checkRuns: (sha) => github(`commits/${sha}/check-runs?check_name=${GATE}&app_id=${GITHUB_ACTIONS_APP}`),
  async stats(sha) {
    const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${STATS_FILE}`;
    const response = await request(url, { 'User-Agent': AGENT });
    if (response.status === 404) throw new Error(`kaphtor ${sha.slice(0, 8)} has no ${STATS_FILE}`);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_CHARS) throw new Error(`${url} is ${body.length} characters; a stats file is far smaller`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`${url} is not JSON (an LFS pointer?): ${JSON.stringify(body.slice(0, 60))}`);
    }
  },
};

/** A stats.json on disk, standing in for kaphtor at `sha`; there is no gate to read. */
export function fromFile(path, sha) {
  return {
    head: async () => ({ sha, date: new Date().toISOString() }),
    checkRuns: async () => ({ check_runs: [{ id: 0, app: { id: GITHUB_ACTIONS_APP }, status: 'completed', conclusion: 'success' }] }),
    stats: async () => JSON.parse(await readFile(path, 'utf8')),
  };
}

/** A JSON file, or null when there is none. */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${path}: ${error.message}`);
  }
}

/**
 * The counts of kaphtor's commit, checked against the snapshot. Resolves to { status: 'waiting', sha } while the gate
 * has not passed, or to { status: 'ready', sha, short, stats, before, moves }, where before is the stored snapshot
 * (null when there is none) and moves the counts that moved. Rejects on every refusal, having written nothing.
 */
export async function readCounts(options, kaphtor = live) {
  const { snapshot, rewrite = false, log = console.log, now = Date.now() } = options;
  if (options.sha !== undefined && !SHA.test(options.sha)) {
    throw new Error(`--sha ${JSON.stringify(options.sha)} is not a full commit SHA (40 hex digits)`);
  }
  const allow = options.allowDropSha?.trim().toLowerCase() || undefined;
  if (allow !== undefined && !/^[0-9a-f]{7,40}$/.test(allow)) {
    throw new Error(`--allow-drop-sha (the allow_drop_sha input) ${JSON.stringify(options.allowDropSha)} is not a commit `
      + 'SHA or a prefix of 7 or more hex digits');
  }

  const head = await kaphtor.head(options.sha);
  const { sha } = head;
  if (!SHA.test(sha)) throw new Error(`kaphtor gave ${JSON.stringify(sha)} as a commit SHA`);
  const short = sha.slice(0, 8);

  const checks = await kaphtor.checkRuns(sha);
  const latest = latestRun(checks);
  const verdict = gateVerdict(checks);
  if (verdict === 'wait') {
    const seen = latest ? `the latest run is ${latest.status}${latest.conclusion ? `, ${latest.conclusion}` : ''}` : 'none has run';
    const hours = (now - Date.parse(head.date)) / 3_600_000;
    if (hours > WAIT_LIMIT_HOURS) {
      throw new Error(`kaphtor ${short}: no successful ${GATE} check ${Math.floor(hours)} hours after the commit (${seen}); `
        + 'the sites keep their counts until one passes');
    }
    log(`kaphtor ${short}: waiting for the ${GATE} check (${seen})`);
    return { status: 'waiting', sha };
  }
  if (verdict === 'fail') {
    throw new Error(`kaphtor ${short}: the ${GATE} check concluded ${latest.conclusion} (${latest.html_url}); its counts are not taken`);
  }

  const stats = validate(await kaphtor.stats(sha));
  const before = await readJson(snapshot);
  if (!before && !rewrite) throw new Error(`no snapshot at ${snapshot}; run once with --rewrite to write the first`);
  if (before && !rewrite) {
    try {
      validate(before.stats);
    } catch (error) {
      throw new Error(`${snapshot}: ${error.message}; after adding a count to PATHS, run once with --rewrite`);
    }
  }

  if (before) {
    const fell = dropped(before.stats, stats);
    if (fell.length && !(allow && sha.startsWith(allow))) {
      const list = fell.map(({ path, from, to }) => `${path} ${from} to ${to}`).join(', ');
      const other = allow ? ` (--allow-drop-sha ${allow} names another commit)` : '';
      throw new Error(`kaphtor ${short}: counts fell by more than 5% (${list})${other}; to accept them, run again with `
        + `--allow-drop-sha ${short} (the allow_drop_sha input of a manual run)`);
    }
  }
  return { status: 'ready', sha, short, stats, before, moves: before ? changed(before.stats, stats) : [] };
}

/** Writes `text` to a temporary file beside `path`, then renames it over `path`; removes the temporary on failure. */
export async function writeAtomic(path, text) {
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** One line per field in $GITHUB_OUTPUT (line breaks become spaces), and `kaphtor stats: status: …` in the summary. */
export async function report(fields) {
  const line = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(fields).map(([key, value]) => `${key}=${line(value)}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const said = line(fields.error || fields.message);
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `kaphtor stats: ${line(fields.status)}${said ? `: ${said}` : ''}\n`);
  }
}

/** Whether the module at `url` (its import.meta.url) is the script node runs, through a symlinked path too. */
export function invoked(url) {
  try {
    return Boolean(process.argv[1]) && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
