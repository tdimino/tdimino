// kaphtor-stats-sync v1: a shared file (see stats-format.mjs). Run with `node --test` on the *.test.mjs files beside
// it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from './stats-format.mjs';
import {
  changed, gateVerdict, GITHUB_ACTIONS_APP, httpError, invoked, LABELS, message, readCounts, report, request, snapshotOf,
  writeAtomic,
} from './sync-core.mjs';

const SHA = '2601888f2f5bd2b8d6b1c8a1e2d3f4a5b6c7d8e9';
const OLD_SHA = '36173da9000000000000000000000000000000aa';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T10:00:00Z';

const BEFORE = {
  schema_version: 1,
  corpus: { records: 1719, documents: 1603 },
  lexicon: { entries: 665, tiers: { CONFIRMED: 19, PROBABLE: 69, CANDIDATE: 246, SPECULATIVE: 331 } },
  translations: { complete: 451, incomplete: 81 },
  sign_values: { total: 37, resolved: 5, phonemic: 14, logographic: 23 },
  names: 379,
  semitic_roots: 5187,
};
const AFTER = structuredClone(BEFORE);
Object.assign(AFTER.lexicon, { entries: 692, tiers: { CONFIRMED: 19, PROBABLE: 74, CANDIDATE: 268, SPECULATIVE: 331 } });
Object.assign(AFTER.translations, { complete: 518, incomplete: 117 });
Object.assign(AFTER, { names: 380, semitic_roots: 5189 });

const gateRun = (status, conclusion, id = 1, app = GITHUB_ACTIONS_APP) => (
  { id, app: { id: app }, status, conclusion, html_url: `https://github.com/plasma-ai/kaphtor/actions/runs/${id}` });
const passed = [gateRun('completed', 'success')];

/** A fake kaphtor at SHA, committed at `date`, with these check runs and this stats.json. */
const kaphtor = (stats, checkRuns = passed, date = FRESH) => ({
  head: async (sha) => ({ sha: sha ?? SHA, date }),
  checkRuns: async () => ({ check_runs: checkRuns }),
  stats: async () => structuredClone(stats),
});

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kaphtor-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A temporary snapshot (none when `snapshot` is null) and readCounts over it. */
async function counts(t, snapshot = { kaphtor_commit: OLD_SHA, stats: BEFORE }) {
  const dir = await folder(t);
  const path = join(dir, 'snapshot.json');
  if (snapshot) await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return (fake, extra = {}) => readCounts({ snapshot: path, log: () => {}, now: NOW, ...extra }, fake);
}

test('the gate verdict: the latest GitHub Actions run decides; a run in progress, none, cancelled or stale waits', () => {
  const verdict = (...runs) => gateVerdict({ check_runs: runs });
  assert.equal(verdict(gateRun('completed', 'success')), 'go');
  assert.equal(verdict(gateRun('in_progress', null)), 'wait');
  assert.equal(verdict(), 'wait');
  assert.equal(verdict(gateRun('completed', 'cancelled')), 'wait');
  assert.equal(verdict(gateRun('completed', 'stale')), 'wait');
  for (const conclusion of ['failure', 'timed_out', 'action_required', 'skipped', 'neutral']) {
    assert.equal(verdict(gateRun('completed', conclusion)), 'fail', conclusion);
  }
  assert.equal(verdict(gateRun('completed', 'failure', 1), gateRun('completed', 'success', 2)), 'go');
  assert.equal(verdict(gateRun('completed', 'success', 1, 99)), 'wait', 'a run named gate from another app');
});

test('only a count that moved is a change; the description and unknown keys are not', () => {
  assert.deepEqual(changed(BEFORE, structuredClone(BEFORE)), []);
  assert.deepEqual(changed(BEFORE, { ...structuredClone(BEFORE), description: 'new words', scribes: 113 }), []);
  assert.deepEqual(changed(BEFORE, AFTER).map((c) => c.path), [
    'lexicon.entries', 'lexicon.tiers.PROBABLE', 'lexicon.tiers.CANDIDATE', 'translations.complete',
    'translations.incomplete', 'names', 'semitic_roots',
  ]);
});

test('the commit message names the kaphtor commit and every moved count, and a new count as "now"', () => {
  assert.equal(message(SHA, changed(BEFORE, AFTER)),
    'kaphtor 2601888f: lexicon 665 to 692 entries, probable 69 to 74, candidate 246 to 268, translations 451 to 518, '
    + 'partial translations 81 to 117, names 379 to 380, Semitic roots 5,187 to 5,189');
  const { names, ...withoutNames } = BEFORE;
  assert.equal(message(SHA, changed(withoutNames, AFTER).filter((m) => m.path === 'names')), 'kaphtor 2601888f: names now 380');
});

test('every count has a label for the commit message', () => {
  assert.deepEqual(Object.keys(LABELS), PATHS);
});

test('the snapshot keeps schema_version and the counts, nothing else from the file', () => {
  const file = JSON.parse(JSON.stringify({ ...AFTER, description: 'words', scribes: 113 }).replace('{', '{"__proto__":{"polluted":true},'));
  assert.deepEqual(snapshotOf(SHA, file), { kaphtor_commit: SHA, stats: AFTER });
  assert.equal({}.polluted, undefined);
});

test('ready: the counts of the commit, the stored snapshot and the counts that moved', async (t) => {
  const read = await counts(t);
  const result = await read(kaphtor({ ...AFTER, description: 'words' }));
  assert.equal(result.status, 'ready');
  assert.equal(result.sha, SHA);
  assert.equal(result.short, '2601888f');
  assert.deepEqual(result.before, { kaphtor_commit: OLD_SHA, stats: BEFORE });
  assert.deepEqual(result.moves.map((m) => m.path), changed(BEFORE, AFTER).map((m) => m.path));
  assert.deepEqual((await read(kaphtor(BEFORE))).moves, []);
});

test('a gate in progress waits, a failed gate stops with its run, and neither reads the counts', async (t) => {
  const read = await counts(t);
  const fetched = [];
  const watch = (runs) => ({ ...kaphtor(AFTER, runs), stats: async () => { fetched.push(1); return AFTER; } });
  assert.deepEqual(await read(watch([gateRun('in_progress', null)])), { status: 'waiting', sha: SHA });
  await assert.rejects(read(watch([gateRun('completed', 'failure', 7)])),
    /gate check concluded failure \(https:\/\/github\.com\/plasma-ai\/kaphtor\/actions\/runs\/7\)/);
  assert.deepEqual(fetched, []);
});

test('waiting stops 48 hours after the commit, naming the gate', async (t) => {
  const read = await counts(t);
  const old = '2026-11-14T10:00:00Z';
  await assert.rejects(read(kaphtor(AFTER, [], old)), /no successful gate check 50 hours after the commit \(none has run\)/);
  await assert.rejects(read(kaphtor(AFTER, [gateRun('completed', 'cancelled')], old)), /latest run is completed, cancelled/);
});

test('a drop past the limit stops, unless that commit is allowed by name', async (t) => {
  const fell = structuredClone(AFTER);
  Object.assign(fell.lexicon, { entries: 600, tiers: { CONFIRMED: 19, PROBABLE: 74, CANDIDATE: 268, SPECULATIVE: 239 } });
  const read = await counts(t, { kaphtor_commit: OLD_SHA, stats: AFTER });
  await assert.rejects(read(kaphtor(fell)), /lexicon\.entries 692 to 600\); to accept them, run again with --allow-drop-sha 2601888f/);
  await assert.rejects(read(kaphtor(fell), { allowDropSha: 'deadbeef' }), /--allow-drop-sha deadbeef names another commit/);
  await assert.rejects(read(kaphtor(fell), { allowDropSha: '2601' }), /not a commit SHA or a prefix of 7 or more/);
  assert.equal((await read(kaphtor(fell), { allowDropSha: ' 2601888F ' })).status, 'ready');
});

test('a file off schema is refused', async (t) => {
  const read = await counts(t);
  await assert.rejects(read(kaphtor({ ...AFTER, schema_version: 2 })), /schema_version/);
});

test('a missing snapshot is an error unless rewrite, which reads with no snapshot', async (t) => {
  const read = await counts(t, null);
  await assert.rejects(read(kaphtor(AFTER)), /run once with --rewrite/);
  const first = await read(kaphtor(AFTER), { rewrite: true });
  assert.equal(first.before, null);
  assert.deepEqual(first.moves, []);
});

test('a snapshot that is not JSON is refused, naming the file', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'snapshot.json');
  await writeFile(path, '{"kaphtor_commit": "36173da9", "stats": {');
  await assert.rejects(readCounts({ snapshot: path, log: () => {}, now: NOW }, kaphtor(AFTER)), /snapshot\.json: .*JSON/);
});

test('a snapshot missing a count is refused, and rewrite reads it as a new count', async (t) => {
  const { names, ...withoutNames } = AFTER;
  const read = await counts(t, { kaphtor_commit: OLD_SHA, stats: withoutNames });
  await assert.rejects(read(kaphtor(AFTER)), /names is undefined, not a count; after adding a count to PATHS, run once with --rewrite/);
  const result = await read(kaphtor(AFTER), { rewrite: true });
  assert.equal(message(result.sha, result.moves), 'kaphtor 2601888f: names now 380');
});

test('a --sha that is not a full commit SHA is refused before any request', async (t) => {
  const read = await counts(t);
  for (const sha of ['main', '2601888f', SHA.toUpperCase()]) {
    await assert.rejects(read(kaphtor(AFTER), { sha }), /is not a full commit SHA/);
  }
});

test('a request that gets no answer, or no connection, names the address and the cause', async (t) => {
  const server = createServer(() => {}); // never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  await assert.rejects(request(`http://127.0.0.1:${port}/x`, {}, 50), new RegExp(`127\\.0\\.0\\.1:${port}/x: no answer in 0\\.05 s`));
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const free = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(request(`http://127.0.0.1:${free}/x`, {}, 1000), new RegExp(`127\\.0\\.0\\.1:${free}/x: ECONNREFUSED`));
  await assert.rejects(request('http://127.0.0.1:1/x', {}, 1000), /127\.0\.0\.1:1\/x: bad port/);
});

test('a failed API response carries GitHub\'s message and a spent rate limit', async () => {
  const response = new Response(JSON.stringify({ message: 'API rate limit exceeded' }),
    { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  assert.equal((await httpError('GitHub API commits/main', response)).message,
    'GitHub API commits/main: 403 "API rate limit exceeded" (the API rate limit is spent)');
});

test('an atomic write replaces the file whole, and a failed one leaves nothing behind', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 'snapshot.json');
  await writeAtomic(path, 'one\n');
  await writeAtomic(path, 'two\n');
  assert.equal(await readFile(path, 'utf8'), 'two\n');
  // The rename fails onto a folder that holds a file, after the temporary file was written.
  const busy = join(dir, 'busy');
  await mkdir(busy);
  await writeFile(join(busy, 'inside'), '');
  await assert.rejects(writeAtomic(busy, 'three\n'));
  assert.deepEqual((await readdir(dir)).sort(), ['busy', 'snapshot.json']);
});

test('the report puts each field on one line of $GITHUB_OUTPUT and the outcome in the summary', async (t) => {
  const dir = await folder(t);
  const saved = { output: process.env.GITHUB_OUTPUT, summary: process.env.GITHUB_STEP_SUMMARY };
  t.after(() => {
    for (const [key, value] of [['GITHUB_OUTPUT', saved.output], ['GITHUB_STEP_SUMMARY', saved.summary]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.GITHUB_OUTPUT = join(dir, 'output');
  process.env.GITHUB_STEP_SUMMARY = join(dir, 'summary');
  await report({ status: 'failed', changed: false, error: 'two\nlines\r\n::warning::forged', snapshot: '' });
  assert.equal(await readFile(join(dir, 'output'), 'utf8'),
    'status=failed\nchanged=false\nerror=two lines ::warning::forged\nsnapshot=\n');
  await report({ status: 'odd\nstatus', message: '' });
  assert.equal(await readFile(join(dir, 'summary'), 'utf8'),
    'kaphtor stats: failed: two lines ::warning::forged\nkaphtor stats: odd status\n');
});

test('invoked is false for a module node was not asked to run', () => {
  assert.equal(invoked('file:///nowhere/sync.mjs'), false);
});
