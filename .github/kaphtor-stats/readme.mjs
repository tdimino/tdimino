// kaphtor-stats-sync v1: the profile's sync. sync-core.mjs reads and checks the counts; this file renders the README's
// kaphtor sentence between its markers, on every run.
/**
 * Keeps the README's kaphtor sentence on kaphtor's counts, once a day from the workflow or by hand.
 *
 *   node .github/kaphtor-stats/readme.mjs [--sha SHA] [--from-file PATH --sha SHA] [--dry-run]
 *        [--allow-drop-sha SHA] [--rewrite] [--readme PATH] [--template PATH] [--snapshot PATH]
 *
 * 1. sync-core.mjs's readCounts: the commit, its gate, the counts, the stored snapshot and the drop guard.
 * 2. The README must hold each marker once, START before END. The text between them must hash to the snapshot's
 *    rendered_sha256, the text this script last wrote there, so a hand edit stops the sync instead of being lost.
 * 3. The template renders on every run, so a wording change goes live on the next run even when no count moved.
 * 4. When the README or a count changed, the README and the snapshot, { kaphtor_commit, rendered_sha256, stats }, are
 *    rewritten.
 *
 * --from-file reads a stats.json on disk in place of kaphtor (fixtures, pilots); --sha then names the commit the file
 * came from. --dry-run reports and writes nothing. --rewrite skips the hand-edit check and writes the snapshot even
 * when nothing changed (the first snapshot, or after a count is added to PATHS). Under GitHub Actions the outcome goes
 * to $GITHUB_OUTPUT (status, changed, message, error, and the README and snapshot as base64) and to the step summary.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { bind } from './stats-format.mjs';
import { fromFile, invoked, live, message, readCounts, report, snapshotOf, writeAtomic } from './sync-core.mjs';

export const START = '<!-- kaphtor-stats:start -->';
export const END = '<!-- kaphtor-stats:end -->';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The README cut at its markers: { head, region, tail }, where region is the text from the line after START to END.
 * Throws unless each marker appears once, START first and alone on its line.
 */
export function split(readme) {
  for (const marker of [START, END]) {
    const seen = readme.split(marker).length - 1;
    if (seen !== 1) throw new Error(`holds ${marker} ${seen} times; it needs it exactly once`);
  }
  const from = readme.indexOf(`${START}\n`);
  if (from === -1) throw new Error(`needs a line break right after ${START}`);
  const to = readme.indexOf(END);
  if (to < from) throw new Error(`holds ${END} before ${START}`);
  return { head: readme.slice(0, from + START.length + 1), region: readme.slice(from + START.length + 1, to), tail: readme.slice(to) };
}

/**
 * One sync. Resolves to { status, sha, message, readme, file }, where status is 'waiting', 'unchanged', 'dry-run' or
 * 'written', and readme and file are the README and snapshot texts written; rejects on every failure, having written
 * nothing.
 */
export async function run(options, kaphtor = live) {
  const { readme: readmePath, template, snapshot, dryRun = false, rewrite = false, log = console.log } = options;
  const counts = await readCounts(options, kaphtor);
  const none = { message: '', readme: '', file: '' };
  if (counts.status === 'waiting') return { status: 'waiting', sha: counts.sha, ...none };
  const { sha, short, stats, before, moves } = counts;

  const readme = await readFile(readmePath, 'utf8');
  let parts;
  try {
    parts = split(readme);
  } catch (error) {
    throw new Error(`${readmePath} ${error.message}`);
  }
  if (before && !rewrite && sha256(parts.region) !== before.rendered_sha256) {
    throw new Error(`${readmePath}: the text between the kaphtor-stats markers was edited by hand; put the wording in `
      + `${template}, then run once with --rewrite (the rewrite input of a manual run)`);
  }
  let line;
  try {
    line = bind(stats).render(await readFile(template, 'utf8'));
  } catch (error) {
    throw new Error(`${template}: ${error.message}`);
  }
  if (!line.endsWith('\n')) line += '\n'; // the end marker keeps its own line

  const next = parts.head + line + parts.tail;
  if (next === readme && !moves.length && !rewrite) {
    log(`kaphtor ${short}: no count moved, and the README sentence is current`);
    return { status: 'unchanged', sha, ...none };
  }
  let text = message(sha, moves);
  if (!moves.length) {
    text = next !== readme ? `kaphtor ${short}: the README sentence rendered again from ${basename(template)}`
      : `kaphtor ${short}: ${before ? 'the snapshot rewritten' : 'the first snapshot of the headline counts'}`;
  }
  log(text);
  if (dryRun) return { status: 'dry-run', sha, ...none, message: text };

  const { kaphtor_commit: commit, stats: kept } = snapshotOf(sha, stats);
  const file = `${JSON.stringify({ kaphtor_commit: commit, rendered_sha256: sha256(line), stats: kept }, null, 2)}\n`;
  await writeAtomic(readmePath, next);
  await writeAtomic(snapshot, file);
  return { status: 'written', sha, message: text, readme: next, file };
}

async function main() {
  try {
    const { values } = parseArgs({
      options: {
        sha: { type: 'string' },
        'from-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'allow-drop-sha': { type: 'string' },
        rewrite: { type: 'boolean', default: false },
        readme: { type: 'string', default: 'README.md' },
        template: { type: 'string', default: '.github/kaphtor-stats/readme-line.tmpl' },
        snapshot: { type: 'string', default: '.github/kaphtor-stats/snapshot.json' },
      },
    });
    if (values['from-file'] && !values.sha) throw new Error('--from-file needs --sha, the commit the file came from');
    const kaphtor = values['from-file'] ? fromFile(values['from-file'], values.sha) : live;
    const result = await run({
      sha: values.sha,
      readme: values.readme,
      template: values.template,
      snapshot: values.snapshot,
      dryRun: values['dry-run'],
      allowDropSha: values['allow-drop-sha'],
      rewrite: values.rewrite,
    }, kaphtor);
    await report({
      status: result.status,
      changed: result.status === 'written',
      message: result.message,
      error: '',
      readme: Buffer.from(result.readme).toString('base64'),
      snapshot: Buffer.from(result.file).toString('base64'),
    });
  } catch (error) {
    console.error(`kaphtor-stats: ${error.message}`);
    await report({ status: 'failed', changed: false, message: '', error: error.message, readme: '', snapshot: '' });
    process.exitCode = 1;
  }
}

if (invoked(import.meta.url)) await main();
