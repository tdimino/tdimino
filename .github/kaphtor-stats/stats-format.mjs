// kaphtor-stats-sync v1: one of four shared files (stats-format.mjs, sync-core.mjs and their tests), copied byte for
// byte into each site that prints kaphtor's counts. The reference copy is .github/kaphtor-stats/ in tdimino/tdimino;
// each site's workflow compares its copies with it. Change the reference first, then every copy.
/**
 * kaphtor's headline counts (data/linear-a/stats.json, schema 1) as prose.
 *
 *   validate(stats)         throws on any break of schema 1; unknown top-level keys are ignored
 *   count(stats, path)      a count by dotted path, en-US grouped ("5,189"); an unknown path throws
 *   a(stats, path)          the same count with its article ("a 692", "an 800")
 *   render(template, stats) fills {{path}} and {{a path}}; an unknown token, a stray brace or an Astro-style
 *                           placeholder ({k('…')}, {a('…')}, ${…}, {lexicon.entries}, {names}) throws. A template
 *                           cannot print a literal {{ or }}.
 *   dropped(old, new)       the printed totals that fell by more than 5%
 *   bind(stats)             validates, then gives { k, a, render } over the counts
 *
 * The sites print only these counts, so a page or template can never reach for a figure the file lacks. Every value
 * from the file that reaches an error message is quoted with JSON.stringify, so it cannot forge a log line.
 */

/** @typedef {'corpus.records' | 'corpus.documents' | 'lexicon.entries' | 'lexicon.tiers.CONFIRMED'
 *   | 'lexicon.tiers.PROBABLE' | 'lexicon.tiers.CANDIDATE' | 'lexicon.tiers.SPECULATIVE' | 'translations.complete'
 *   | 'translations.incomplete' | 'sign_values.total' | 'sign_values.resolved' | 'sign_values.phonemic'
 *   | 'sign_values.logographic' | 'names' | 'semitic_roots'} CountPath */

export const SCHEMA_VERSION = 1;
export const TIERS = ['CONFIRMED', 'PROBABLE', 'CANDIDATE', 'SPECULATIVE'];
/** @type {CountPath[]} */
export const PATHS = [
  'corpus.records', 'corpus.documents',
  'lexicon.entries', 'lexicon.tiers.CONFIRMED', 'lexicon.tiers.PROBABLE', 'lexicon.tiers.CANDIDATE',
  'lexicon.tiers.SPECULATIVE',
  'translations.complete', 'translations.incomplete',
  'sign_values.total', 'sign_values.resolved', 'sign_values.phonemic', 'sign_values.logographic',
  'names', 'semitic_roots',
];
// The headline totals the drop guard watches. Tier sub-counts and incomplete translations move both ways.
export const GUARDED = ['corpus.records', 'corpus.documents', 'lexicon.entries', 'translations.complete',
  'sign_values.total', 'names', 'semitic_roots'];
export const DROP_LIMIT = 0.05;

export const grouped = new Intl.NumberFormat('en-US');
/** The value at a dotted path, or undefined. */
export const get = (stats, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), stats);

const isCount = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

export function validate(stats) {
  if (stats?.schema_version !== SCHEMA_VERSION) {
    throw new Error(`kaphtor stats.json: schema_version is ${JSON.stringify(stats?.schema_version)}; `
      + `this reader knows ${SCHEMA_VERSION}`);
  }
  const problems = PATHS.filter((path) => !isCount(get(stats, path)))
    .map((path) => `${path} is ${JSON.stringify(get(stats, path))}, not a count`);
  const unknown = Object.keys(stats.lexicon?.tiers ?? {}).filter((tier) => !TIERS.includes(tier));
  if (unknown.length) problems.push(`unknown tier ${unknown.map((tier) => JSON.stringify(tier)).join(', ')}`);
  if (!problems.length) {
    const sum = TIERS.reduce((total, tier) => total + stats.lexicon.tiers[tier], 0);
    if (sum !== stats.lexicon.entries) problems.push(`the tiers sum to ${sum}, not ${stats.lexicon.entries} entries`);
    const { total, resolved, phonemic, logographic } = stats.sign_values;
    if (phonemic + logographic !== total) {
      problems.push(`${phonemic} phonemic and ${logographic} logographic values do not make ${total}`);
    }
    if (resolved > total) problems.push(`${resolved} resolved sign values exceed the ${total} in all`);
    if (stats.corpus.documents > stats.corpus.records) {
      problems.push(`${stats.corpus.documents} documents exceed the ${stats.corpus.records} corpus records`);
    }
  }
  if (problems.length) throw new Error(`kaphtor stats.json: ${problems.join('; ')}`);
  return stats;
}

/** @param {CountPath} path */
export function count(stats, path) {
  if (!PATHS.includes(path)) throw new Error(`unknown kaphtor count: ${JSON.stringify(path)}`);
  const value = get(stats, path);
  if (!isCount(value)) throw new Error(`kaphtor count ${path} is ${JSON.stringify(value)}`);
  return grouped.format(value);
}

// "an" where the spoken number opens on a vowel: eight, eleven, eighteen, eighty-, eight hundred, at any
// thousands power ("an 8,000", "an 11,000"). The leading comma group is what is said first.
export function article(n) {
  const lead = Number(grouped.format(n).split(',')[0]);
  const vowel = lead === 8 || lead === 11 || lead === 18 || (lead >= 80 && lead <= 89) || (lead >= 800 && lead <= 899);
  return vowel ? 'an' : 'a';
}

/** @param {CountPath} path */
export function a(stats, path) {
  return `${article(get(stats, path))} ${count(stats, path)}`;
}

const TOKEN = /\{\{\s*(a\s+)?([A-Za-z_.]+)\s*\}\}/g;
// What survives a render only by mistake: a stray double brace, a placeholder pasted from an Astro file, or a count's
// name in single braces ({names}, {a semitic_roots}).
const LEFTOVER = new RegExp(String.raw`\{\{|\}\}|\$\{|\{\s*[ak]\(|\{[A-Za-z_]+(?:\.[A-Za-z_]+)+\}|`
  + String.raw`\{\s*(?:a\s+)?(?:${PATHS.join('|').replaceAll('.', '\\.')})\s*\}`);

function refuse(text, match) {
  if (!match) return;
  const at = match.index;
  throw new Error(`a kaphtor template has a stray brace or placeholder at ${JSON.stringify(text.slice(Math.max(0, at - 30), at + 30))}`);
}

export function render(template, stats) {
  refuse(template, /\{\{\{|\}\}\}/.exec(template));
  const out = template.replace(TOKEN, (_, withArticle, path) => (withArticle ? a(stats, path) : count(stats, path)));
  refuse(out, LEFTOVER.exec(out));
  return out;
}

export function dropped(before, after, limit = DROP_LIMIT) {
  return GUARDED.map((path) => ({ path, from: get(before, path), to: get(after, path) }))
    .filter(({ from, to }) => to < from * (1 - limit));
}

export function bind(stats) {
  validate(stats);
  return {
    /** @param {CountPath} path */
    k: (path) => count(stats, path),
    /** @param {CountPath} path */
    a: (path) => a(stats, path),
    render: (template) => render(template, stats),
  };
}
