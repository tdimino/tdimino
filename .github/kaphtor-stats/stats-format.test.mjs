// kaphtor-stats-sync v1: a shared file (see stats-format.mjs). Run with `node --test` on the *.test.mjs files beside
// it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a, article, bind, count, dropped, render, validate } from './stats-format.mjs';

// kaphtor 2601888f, data/linear-a/stats.json
const STATS = {
  schema_version: 1,
  description: 'Headline counts of the Linear A record, computed from the data files.',
  corpus: { records: 1719, documents: 1603 },
  lexicon: { entries: 692, tiers: { CONFIRMED: 19, PROBABLE: 74, CANDIDATE: 268, SPECULATIVE: 331 } },
  translations: { complete: 518, incomplete: 117 },
  sign_values: { total: 37, resolved: 5, phonemic: 14, logographic: 23 },
  names: 380,
  semitic_roots: 5189,
};
const edit = (fn) => { const s = structuredClone(STATS); fn(s); return s; };

test('a valid file passes, and an unknown top-level key is ignored', () => {
  assert.equal(validate(STATS), STATS);
  assert.doesNotThrow(() => validate(edit((s) => { s.scribes = 113; })));
});

test('every schema break is refused', () => {
  const broken = {
    'schema 2': (s) => { s.schema_version = 2; },
    'missing key': (s) => { delete s.semitic_roots; },
    'unknown tier': (s) => { s.lexicon.tiers.REJECTED = 0; },
    'missing tier': (s) => { delete s.lexicon.tiers.CONFIRMED; },
    'a float': (s) => { s.names = 380.5; },
    'a negative': (s) => { s.names = -1; },
    'a string count': (s) => { s.corpus.records = '1719'; },
    'tiers off the entries': (s) => { s.lexicon.tiers.PROBABLE = 75; },
    'signs off the total': (s) => { s.sign_values.phonemic = 15; },
    'too large to print': (s) => { s.names = 1e308; },
    'beyond safe integers': (s) => { s.names = 2 ** 53 + 2; },
    'negative zero': (s) => { s.names = -0; },
    'more documents than records': (s) => { s.corpus.documents = 1720; },
    'more resolved than in all': (s) => { s.sign_values.resolved = 38; },
  };
  for (const [name, fn] of Object.entries(broken)) assert.throws(() => validate(edit(fn)), Error, name);
});

test('counts print with en-US grouping, and an unknown path throws', () => {
  assert.equal(count(STATS, 'semitic_roots'), '5,189');
  assert.equal(count(STATS, 'lexicon.entries'), '692');
  assert.equal(count(STATS, 'lexicon.tiers.SPECULATIVE'), '331');
  assert.throws(() => count(STATS, 'lexicon.entires'), /lexicon\.entires/);
});

test('the article follows the spoken number', () => {
  const an = [8, 11, 18, 80, 89, 800, 899, 8000, 11000, 18000, 80000, 800000, 8000000];
  const plain = [1, 7, 12, 37, 100, 380, 518, 692, 1719, 5189, 9000, 10000, 110000];
  for (const n of an) assert.equal(article(n), 'an', String(n));
  for (const n of plain) assert.equal(article(n), 'a', String(n));
  assert.equal(a(STATS, 'lexicon.entries'), 'a 692');
});

test('a template fills every token, and a typo or a stray brace throws', () => {
  assert.equal(render('{{a lexicon.entries}}-entry lexicon, {{ semitic_roots }} roots', STATS),
    'a 692-entry lexicon, 5,189 roots');
  assert.throws(() => render('{{lexicon.entires}}', STATS), /lexicon\.entires/);
  assert.throws(() => render('{{lexicon.entries}} and {{ unclosed', STATS), /unclosed/);
});

test('a placeholder pasted from an Astro file, or a triple brace, throws and is quoted', () => {
  for (const paste of ["{a('lexicon.entries')}-entry", '{lexicon.entries} entries', '${k("names")} names', '{{{names}}}',
    '{names} names', '{ a semitic_roots } roots']) {
    assert.throws(() => render(`The lexicon: ${paste}.`, STATS), /stray brace or placeholder at "/, paste);
  }
  assert.equal(render('{ "json": true } and {braces}', STATS), '{ "json": true } and {braces}');
});

test('a value from the file reaches an error message quoted, never as a raw line', () => {
  const forged = '2\n::warning::forged';
  for (const fn of [(s) => { s.schema_version = forged; }, (s) => { s.lexicon.tiers[forged] = 0; }]) {
    try {
      validate(edit(fn));
      assert.fail('validate accepted a forged value');
    } catch (error) {
      assert.ok(!error.message.includes('\n'), error.message);
    }
  }
});

test('the drop guard watches every printed total, beyond 5%, and nothing else', () => {
  assert.deepEqual(dropped(STATS, edit((s) => { s.lexicon.entries = 600; s.lexicon.tiers.SPECULATIVE = 239; })),
    [{ path: 'lexicon.entries', from: 692, to: 600 }]);
  assert.deepEqual(dropped(STATS, edit((s) => { s.lexicon.entries = 680; s.lexicon.tiers.SPECULATIVE = 319; })), []);
  assert.deepEqual(dropped(STATS, edit((s) => { s.translations.incomplete = 10; })), []);
  assert.deepEqual(dropped(STATS, edit((s) => { s.sign_values.total = 30; s.sign_values.phonemic = 7; })),
    [{ path: 'sign_values.total', from: 37, to: 30 }]);
});

test('bind validates first, then gives k, a and render over the counts', () => {
  const { k, a: an, render: fill } = bind(STATS);
  assert.equal(k('corpus.documents'), '1,603');
  assert.equal(an('names'), 'a 380');
  assert.equal(fill('{{translations.complete}}'), '518');
  assert.throws(() => bind(edit((s) => { s.schema_version = 2; })));
});
