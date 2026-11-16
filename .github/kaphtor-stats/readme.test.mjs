// kaphtor-stats-sync v1: the profile's sync over sync-core.mjs (tested in sync-core.test.mjs). Run with
// `node --test '.github/kaphtor-stats/*.test.mjs'`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GITHUB_ACTIONS_APP } from './sync-core.mjs';
import { END, run, sha256, split, START } from './readme.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = '8244ceacc19c602b9715e5142a932f2d17db8764';
const OLD_SHA = '2601888faae1974bfc010c7c61db451992ad57bc';
const NOW = Date.parse('2026-11-16T22:00:00Z');

const BEFORE = {
  schema_version: 1,
  corpus: { records: 1719, documents: 1603 },
  lexicon: { entries: 692, tiers: { CONFIRMED: 19, PROBABLE: 74, CANDIDATE: 268, SPECULATIVE: 331 } },
  translations: { complete: 518, incomplete: 117 },
  sign_values: { total: 37, resolved: 5, phonemic: 14, logographic: 23 },
  names: 380,
  semitic_roots: 5189,
};
const AFTER = structuredClone(BEFORE);
Object.assign(AFTER.lexicon, { entries: 693, tiers: { CONFIRMED: 19, PROBABLE: 74, CANDIDATE: 268, SPECULATIVE: 332 } });

const TEMPLATE = 'A record of {{corpus.records}} records, {{a lexicon.entries}}-entry lexicon and {{semitic_roots}} roots.\n';
const LINE = 'A record of 1,719 records, a 692-entry lexicon and 5,189 roots.\n';
const README = `# Profile\n\n${START}\n${LINE}${END}\n\nMore.\n`;

const kaphtor = (stats, checkRuns = [{ id: 1, app: { id: GITHUB_ACTIONS_APP }, status: 'completed', conclusion: 'success' }]) => ({
  head: async (sha) => ({ sha: sha ?? SHA, date: '2026-11-16T21:00:00Z' }),
  checkRuns: async () => ({ check_runs: checkRuns }),
  stats: async () => structuredClone(stats),
});

/** A temporary profile: README, template and snapshot (the README's sentence rendered from BEFORE), removed after. */
async function profile(t, { readme = README, template = TEMPLATE, snapshot = { kaphtor_commit: OLD_SHA, rendered_sha256: sha256(LINE), stats: BEFORE } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kaphtor-readme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { readme: join(dir, 'README.md'), template: join(dir, 'readme-line.tmpl'), snapshot: join(dir, 'snapshot.json') };
  await writeFile(paths.readme, readme);
  await writeFile(paths.template, template);
  if (snapshot) await writeFile(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
  const sync = (fake, extra = {}) => run({ ...paths, log: () => {}, now: NOW, ...extra }, fake);
  const texts = async () => ({ readme: await readFile(paths.readme, 'utf8'), snapshot: await readFile(paths.snapshot, 'utf8') });
  return { dir, paths, sync, texts };
}

test('the README splits at its markers, each once, START first and alone on its line', () => {
  assert.deepEqual(split(README), { head: `# Profile\n\n${START}\n`, region: LINE, tail: `${END}\n\nMore.\n` });
  assert.throws(() => split('# Profile\n'), /kaphtor-stats:start --> 0 times/);
  assert.throws(() => split(`${README}${START}\n`), /kaphtor-stats:start --> 2 times/);
  assert.throws(() => split(`${END}\n${START}\nx\n`), /kaphtor-stats:end --> before/);
  assert.throws(() => split(`${START} x\n${END}\n`), /line break right after/);
});

test('moved counts rewrite the sentence and the snapshot, with the hash of what was written', async (t) => {
  const p = await profile(t);
  const result = await p.sync(kaphtor(AFTER));
  assert.equal(result.status, 'written');
  assert.equal(result.message, 'kaphtor 8244ceac: lexicon 692 to 693 entries, speculative 331 to 332');
  const { readme, snapshot } = await p.texts();
  assert.equal(readme, README.replace('a 692-entry', 'a 693-entry'));
  assert.equal(result.readme, readme);
  assert.equal(result.file, snapshot);
  assert.deepEqual(JSON.parse(snapshot), {
    kaphtor_commit: SHA, rendered_sha256: sha256(LINE.replace('692', '693')), stats: AFTER,
  });
});

test('the same counts and the same wording write nothing', async (t) => {
  const p = await profile(t);
  const before = await p.texts();
  assert.equal((await p.sync(kaphtor(BEFORE))).status, 'unchanged');
  assert.deepEqual(await p.texts(), before);
});

test('a wording change in the template goes live with no count moved', async (t) => {
  const p = await profile(t, { template: TEMPLATE.replace('A record', 'An open record') });
  const result = await p.sync(kaphtor(BEFORE));
  assert.equal(result.status, 'written');
  assert.equal(result.message, 'kaphtor 8244ceac: the README sentence rendered again from readme-line.tmpl');
  assert.match((await p.texts()).readme, /^An open record of 1,719 records/m);
});

test('a template saved without its final line break still leaves the end marker on its own line', async (t) => {
  const p = await profile(t, { template: TEMPLATE.trimEnd() });
  assert.equal((await p.sync(kaphtor(BEFORE))).status, 'unchanged');
  assert.equal((await p.sync(kaphtor(AFTER))).status, 'written');
  assert.match((await p.texts()).readme, /5,189 roots\.\n<!-- kaphtor-stats:end -->/);
});

test('a hand edit between the markers stops the sync and writes nothing; --rewrite takes the template', async (t) => {
  const p = await profile(t, { readme: README.replace('5,189 roots', '5,190 roots') });
  const before = await p.texts();
  await assert.rejects(p.sync(kaphtor(AFTER)), /edited by hand; put the wording in .*readme-line\.tmpl, then run once with --rewrite/);
  assert.deepEqual(await p.texts(), before);
  assert.equal((await p.sync(kaphtor(AFTER), { rewrite: true })).status, 'written');
  assert.match((await p.texts()).readme, /a 693-entry lexicon and 5,189 roots/);
});

test('a README without its markers, or a broken template, writes nothing', async (t) => {
  const p = await profile(t, { readme: '# Profile\n' });
  await assert.rejects(p.sync(kaphtor(AFTER)), /README\.md holds <!-- kaphtor-stats:start --> 0 times/);
  const q = await profile(t, { template: '{{lexicon.entires}}\n' });
  const before = await q.texts();
  await assert.rejects(q.sync(kaphtor(AFTER), { rewrite: true }), /readme-line\.tmpl: .*lexicon\.entires/);
  assert.deepEqual(await q.texts(), before);
  assert.deepEqual((await readdir(q.dir)).sort(), ['README.md', 'readme-line.tmpl', 'snapshot.json']);
});

test('a dry run reports and writes nothing; a gate in progress waits', async (t) => {
  const p = await profile(t);
  const before = await p.texts();
  const dry = await p.sync(kaphtor(AFTER), { dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.match(dry.message, /lexicon 692 to 693 entries/);
  assert.equal((await p.sync(kaphtor(AFTER, [{ id: 1, app: { id: GITHUB_ACTIONS_APP }, status: 'in_progress' }]))).status, 'waiting');
  assert.deepEqual(await p.texts(), before);
});

test('the first snapshot leaves a README already on those counts byte for byte', async (t) => {
  const p = await profile(t, { snapshot: null });
  const result = await p.sync(kaphtor(BEFORE), { rewrite: true });
  assert.equal(result.message, 'kaphtor 8244ceac: the first snapshot of the headline counts');
  const { readme, snapshot } = await p.texts();
  assert.equal(readme, README);
  assert.equal(JSON.parse(snapshot).rendered_sha256, sha256(LINE));
});

const execute = promisify(execFile);

test('the command line reports the README and the snapshot to $GITHUB_OUTPUT, and an error reports itself', async (t) => {
  const p = await profile(t);
  const file = join(p.dir, 'stats.json');
  await writeFile(file, JSON.stringify(AFTER));
  const output = join(p.dir, 'output');
  const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(p.dir, 'summary') };
  const args = ['--readme', p.paths.readme, '--template', p.paths.template, '--snapshot', p.paths.snapshot];
  const cli = async (extra) => {
    await writeFile(output, '');
    const code = await execute(process.execPath, [join(HERE, 'readme.mjs'), ...args, ...extra], { env, cwd: p.dir })
      .then(() => 0, (error) => error.code);
    const lines = (await readFile(output, 'utf8')).trim().split('\n');
    return { code, fields: Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
  };
  const ok = await cli(['--from-file', file, '--sha', SHA]);
  assert.equal(ok.code, 0);
  assert.equal(ok.fields.status, 'written');
  assert.equal(ok.fields.changed, 'true');
  const { readme, snapshot } = await p.texts();
  assert.equal(Buffer.from(ok.fields.readme, 'base64').toString(), readme);
  assert.equal(Buffer.from(ok.fields.snapshot, 'base64').toString(), snapshot);
  const bad = await cli(['--from-file', file]);
  assert.equal(bad.code, 1);
  assert.equal(bad.fields.status, 'failed');
  assert.equal(bad.fields.error, '--from-file needs --sha, the commit the file came from');
});
