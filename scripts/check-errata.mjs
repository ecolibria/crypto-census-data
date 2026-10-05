#!/usr/bin/env node
/**
 * Guards the two rules an errata file lives under.
 *
 *   1. scripts/validate-dataset.mjs: an errata file names a dataset that is
 *      here and figures that are in it, and says of each issue which way the
 *      figure is off and by how much.
 *   2. scripts/check-immutable.mjs: an errata file that has been published
 *      only grows.
 *
 * Both scripts are run the way a reader would run them. The validator finds
 * its files relative to its own location, so each of its tests copies it and
 * one small published dataset into a temporary directory. The immutability
 * check reads history, so each of its tests builds a two-commit repository in
 * a temporary directory. Nothing in this repository is written to.
 *
 *   node --test scripts/check-errata.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Aggregate-only, so a copy of it is two small files. */
const PUBLISHED = '2026-03-18';
const ERRATA_FILE = `errata/${PUBLISHED}.json`;

/**
 * A well-formed errata file for the copied dataset. Each test changes one
 * thing about it. The DOI is in the prefix reserved for examples.
 */
const wellFormed = () => ({
  schemaVersion: 2,
  kind: 'censusErrata',
  dataset: PUBLISHED,
  doi: '10.5555/example.errata',
  issuedAt: '2026-10-05',
  issues: [
    {
      defect: 'example-first',
      summary: 'A count includes packages that were not read.',
      affects: ['packagesScanned', 'byEcosystem.npm.scanned'],
      direction: 'overstates',
      magnitude: { value: 3, of: 10, unit: 'packages' },
      correctedIn: 'the next dataset',
      issuedAt: '2026-10-05',
    },
    {
      defect: 'example-second',
      summary: 'A share rests on the count above.',
      affects: ['weakShareOfCryptoUsing'],
      direction: 'unknown',
      magnitude: null,
      correctedIn: 'the next dataset',
      issuedAt: '2026-10-05',
    },
  ],
});

const later = () => ({
  defect: 'example-later',
  summary: 'Found after the file was first published.',
  affects: ['withPqcReady'],
  direction: 'understates',
  magnitude: null,
  correctedIn: 'the next dataset',
  issuedAt: '2026-11-01',
});

const run = (args, options) => new Promise((done) => {
  execFile(process.execPath, args, options,
    (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
});

// --- The validator ----------------------------------------------------------

/**
 * Run a copy of the validator over a copy of the published dataset and the
 * given errata files. A file's content is an object, or text to write as is.
 */
async function validateWith(errataFiles, argument) {
  const dir = mkdtempSync(join(tmpdir(), 'census-errata-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts', 'validate-dataset.mjs'), join(dir, 'scripts', 'validate-dataset.mjs'));
    cpSync(join(ROOT, 'datasets', PUBLISHED), join(dir, 'datasets', PUBLISHED), { recursive: true });
    mkdirSync(join(dir, 'errata'));
    for (const [name, content] of Object.entries(errataFiles)) {
      writeFileSync(join(dir, 'errata', name),
        typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
    const args = [join(dir, 'scripts', 'validate-dataset.mjs'), ...(argument ? [argument] : [])];
    return await run(args, { env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONE_PROBLEM = /\n1 problem\(s\) across 1 dataset\(s\) and 1 errata file\(s\):/;

test('a well-formed errata file validates, and the run says it was read', async () => {
  const result = await validateWith({ [`${PUBLISHED}.json`]: wellFormed() });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 dataset\(s\) validated: 2026-03-18/);
  assert.match(result.stdout, /1 errata file\(s\) validated: 2026-03-18\.json/);
});

test('an empty errata directory changes nothing about the run', async () => {
  const result = await validateWith({});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 dataset\(s\) validated: 2026-03-18/);
  assert.doesNotMatch(result.stdout, /errata/);
});

/** [what the file has wrong, the change that makes it so, the problem reported, how many problems if not one]. */
const refusals = [
  ['no date of issue', (e) => { e.issuedAt = null; }, /issuedAt is null, not a YYYY-MM-DD date/],
  ['a date of issue that is not a day of the calendar', (e) => { e.issuedAt = '2026-02-31'; }, /issuedAt is "2026-02-31", not a YYYY-MM-DD date/],
  ['a date of issue before the dataset was collected', (e) => { e.issuedAt = '2026-03-17'; }, /issuedAt is 2026-03-17, before the dataset/, 2],
  ['a date of issue that is not its first issue\'s', (e) => { e.issuedAt = '2026-10-06'; }, /issuedAt is 2026-10-06 and its first issue has 2026-10-05/],
  ['an issue with no date of issue', (e) => { delete e.issues[1].issuedAt; }, /issue 2 \(example-second\) has issuedAt undefined, not a YYYY-MM-DD date/],
  ['an issue dated before the dataset was collected', (e) => { e.issues[0].issuedAt = '2026-03-01'; e.issuedAt = '2026-03-01'; }, /issue 1 \(example-first\) has issuedAt 2026-03-01, before the dataset/, 2],
  ['an issue dated before the one above it', (e) => { e.issues[1].issuedAt = '2026-10-04'; }, /issue 2 \(example-second\) has issuedAt 2026-10-04, earlier than the issue before it \(2026-10-05\)/],
  ['another schema version', (e) => { e.schemaVersion = 1; }, /schemaVersion is 1;/],
  ['another kind', (e) => { e.kind = 'aggregate-only'; }, /kind is "aggregate-only", not "censusErrata"/],
  ['a dataset other than the one the file is named for', (e) => { e.dataset = '2026-08-03'; }, /dataset is "2026-08-03", and the file is named for 2026-03-18/],
  ['no DOI', (e) => { delete e.doi; }, /doi is undefined\./],
  ['a DOI that is not one', (e) => { e.doi = 'https://example.org/dataset'; }, /doi is "https:\/\/example\.org\/dataset"\./],
  ['a field an errata file does not define', (e) => { e.supersedes = '2026-01-01'; }, /carries supersedes, which an errata file does not define/],
  ['no issues', (e) => { e.issues = []; }, /lists no issues/],
  ['an issue that is not an object', (e) => { e.issues[1] = 'see above'; }, /issue 2 is not an object/],
  ['a field an issue does not define', (e) => { e.issues[0].severity = 'high'; }, /issue 1 \(example-first\) carries severity, which an issue does not define/],
  ['an issue with no defect', (e) => { delete e.issues[0].defect; }, /issue 1 is missing defect/],
  ['an issue with no summary', (e) => { e.issues[0].summary = '  '; }, /issue 1 \(example-first\) is missing summary/],
  ['an issue that does not say where it is corrected', (e) => { delete e.issues[0].correctedIn; }, /issue 1 \(example-first\) is missing correctedIn/],
  ['the same defect listed twice', (e) => { e.issues[1].defect = 'example-first'; }, /issue 2 \(example-first\) repeats a defect already listed/],
  ['a direction outside the three', (e) => { e.issues[0].direction = 'wrong'; }, /issue 1 \(example-first\) has direction "wrong"/],
  ['an issue with no direction', (e) => { delete e.issues[0].direction; }, /issue 1 \(example-first\) has direction undefined/],
  ['an issue that names no figure', (e) => { e.issues[0].affects = []; }, /issue 1 \(example-first\) names no figure in affects/],
  ['a figure the aggregate does not have', (e) => { e.issues[0].affects = ['byEcosystem.npm.unread']; }, /affects byEcosystem\.npm\.unread, which is not a field of the 2026-03-18 aggregate/],
  ['a registry the aggregate does not have', (e) => { e.issues[0].affects = ['byEcosystem.conda.scanned']; }, /affects byEcosystem\.conda\.scanned, which is not a field/],
  ['a figure every object has', (e) => { e.issues[0].affects = ['byEcosystem.constructor']; }, /affects byEcosystem\.constructor, which is not a field/],
  ['a path below a number', (e) => { e.issues[0].affects = ['packagesScanned.toFixed']; }, /affects packagesScanned\.toFixed, which is not a field/],
  ['a figure named twice', (e) => { e.issues[0].affects = ['packagesScanned', 'packagesScanned']; }, /names packagesScanned twice in affects/],
  ['a figure that is not a path', (e) => { e.issues[0].affects = [42]; }, /has an entry in affects that is not a field path/],
  ['a magnitude left out', (e) => { delete e.issues[0].magnitude; }, /issue 1 \(example-first\) is missing magnitude/],
  ['a magnitude whose count is text', (e) => { e.issues[0].magnitude.value = '3'; }, /has magnitude\.value "3", not a whole count/],
  ['a magnitude that is a fraction', (e) => { e.issues[0].magnitude = { value: 0.5, of: 1, unit: 'packages' }; }, /has magnitude\.value 0\.5, not a whole count/],
  ['a magnitude counted in a fraction', (e) => { e.issues[0].magnitude.of = 10.5; }, /has magnitude\.of 10\.5, not a whole count above zero/],
  ['a magnitude counted in nothing', (e) => { e.issues[0].magnitude = { value: 0, of: 0, unit: 'packages' }; }, /has magnitude\.of 0, not a whole count above zero/],
  ['a magnitude larger than its whole', (e) => { e.issues[0].magnitude.value = 11; }, /has a magnitude of 11 of 10: more than the whole/],
  ['a magnitude with no unit', (e) => { e.issues[0].magnitude.unit = ''; }, /has no magnitude\.unit/],
  ['a magnitude with a field of its own', (e) => { e.issues[0].magnitude.note = 'estimate'; }, /has a magnitude that is not \{ value, of, unit \} or null/],
  ['a magnitude with a part missing', (e) => { delete e.issues[0].magnitude.of; }, /has a magnitude that is not \{ value, of, unit \} or null/],
  ['a magnitude written as a list', (e) => { e.issues[0].magnitude = [3, 10, 'packages']; }, /has a magnitude that is not \{ value, of, unit \} or null/],
];

for (const [what, change, problem, count = 1] of refusals) {
  test(`an errata file with ${what} is refused`, async () => {
    const errata = wellFormed();
    change(errata);
    const result = await validateWith({ [`${PUBLISHED}.json`]: errata });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`\\n${count} problem\\(s\\) across 1 dataset\\(s\\) and 1 errata file\\(s\\):`));
    assert.match(result.stderr, problem);
  });
}

/** [how the file is written, its text]. The content is the well-formed file each time. */
const spellings = [
  ['with four-space indentation', () => `${JSON.stringify(wellFormed(), null, 4)}\n`],
  ['on one line', () => `${JSON.stringify(wellFormed())}\n`],
  ['with no newline at its end', () => JSON.stringify(wellFormed(), null, 2)],
  ['with a key written twice', () => `${JSON.stringify(wellFormed(), null, 2)}\n`.replace('"kind": "censusErrata",', '"kind": "draft",\n  "kind": "censusErrata",')],
];

for (const [how, text] of spellings) {
  test(`an errata file written ${how} is refused`, async () => {
    const result = await validateWith({ [`${PUBLISHED}.json`]: text() });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, ONE_PROBLEM);
    assert.match(result.stderr, /is not in its canonical form/);
  });
}

test('a file in errata/ that is not named for a dataset is refused', async () => {
  const result = await validateWith({ 'notes.json': wellFormed() });
  assert.equal(result.code, 1);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /errata\/notes\.json: is not named <dataset date>\.json/);
});

test('an errata file that does not parse is refused', async () => {
  const result = await validateWith({ [`${PUBLISHED}.json`]: '{ "schemaVersion": 2,' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /errata\/2026-03-18\.json: does not parse/);
});

test('an errata file that is a list is refused', async () => {
  const result = await validateWith({ [`${PUBLISHED}.json`]: [wellFormed()] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /is not a JSON object/);
});

test('an errata file for a dataset that is not here is refused', async () => {
  const result = await validateWith({ '2026-01-01.json': { ...wellFormed(), dataset: '2026-01-01' } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /describes datasets\/2026-01-01, which is not a dataset in this repository/);
});

test('validating one dataset reads its errata file and no other', async () => {
  const files = { [`${PUBLISHED}.json`]: wellFormed(), '2026-01-01.json': '{' };
  const one = await validateWith(files, PUBLISHED);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /1 errata file\(s\) validated: 2026-03-18\.json/);
  const every = await validateWith(files);
  assert.equal(every.code, 1);
  assert.match(every.stderr, /errata\/2026-01-01\.json: does not parse/);
});

// --- The immutability check -------------------------------------------------

/** git with no configuration but its own defaults, and an identity that exists only here. */
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'check-errata',
  GIT_AUTHOR_EMAIL: 'check-errata@example.invalid',
  GIT_COMMITTER_NAME: 'check-errata',
  GIT_COMMITTER_EMAIL: 'check-errata@example.invalid',
};

/**
 * Publish a dataset and its errata file in one commit, apply `change` in a
 * second, and run the immutability check with the first commit as its base.
 */
async function afterPublication(change) {
  const dir = mkdtempSync(join(tmpdir(), 'census-errata-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    git('add', '--', path);
  };
  try {
    git('init', '--quiet', '--initial-branch=work');
    write(`datasets/${PUBLISHED}/MANIFEST.json`, { dataset: PUBLISHED });
    write(ERRATA_FILE, wellFormed());
    git('commit', '--quiet', '--message', 'published');
    git('branch', 'published');
    change({ write, git });
    git('commit', '--quiet', '--allow-empty', '--message', 'change');
    return await run([join(ROOT, 'scripts', 'check-immutable.mjs'), 'published'], { cwd: dir, env: GIT_ENV });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a base that cannot be read fails the check', async () => {
  // A check that cannot look at what was published must not report that
  // nothing was rewritten.
  const dir = mkdtempSync(join(tmpdir(), 'census-errata-history-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--quiet', '--initial-branch=work');
    mkdirSync(join(dir, 'datasets', PUBLISHED), { recursive: true });
    writeFileSync(join(dir, 'datasets', PUBLISHED, 'MANIFEST.json'), '{}\n');
    git('add', '--', `datasets/${PUBLISHED}/MANIFEST.json`);
    git('commit', '--quiet', '--message', 'published');
    const script = join(ROOT, 'scripts', 'check-immutable.mjs');
    const missing = await run([script, 'origin/no-such-branch'], { cwd: dir, env: GIT_ENV });
    assert.equal(missing.code, 1, missing.stdout);
    assert.match(missing.stderr, /Cannot read the base "origin\/no-such-branch"/);
    // The same tree against a base it can read passes, so the failure above is the base and nothing else.
    const readable = await run([script, 'work'], { cwd: dir, env: GIT_ENV });
    assert.equal(readable.code, 0, readable.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a change with no history in common with the base fails the check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'census-errata-history-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = (message) => {
      mkdirSync(join(dir, 'datasets', PUBLISHED), { recursive: true });
      writeFileSync(join(dir, 'datasets', PUBLISHED, 'MANIFEST.json'), `${JSON.stringify({ message })}\n`);
      git('add', '--', `datasets/${PUBLISHED}/MANIFEST.json`);
      git('commit', '--quiet', '--message', message);
    };
    git('init', '--quiet', '--initial-branch=published');
    commit('published');
    git('checkout', '--quiet', '--orphan', 'rewritten');
    commit('a second history');
    const result = await run([join(ROOT, 'scripts', 'check-immutable.mjs'), 'published'], { cwd: dir, env: GIT_ENV });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /share no history/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const changed = (edit) => { const errata = wellFormed(); edit(errata); return errata; };
const reversedKeys = (value) => {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedKeys(v)]));
};

/** [what the change does, the change]. Each leaves every published issue as it was. */
const allowed = [
  ['adds an issue after the published ones', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues.push(later()); }))],
  ['adds an errata file for another dataset', (r) => r.write('errata/2026-08-03.json', { ...wellFormed(), dataset: '2026-08-03' })],
  ['rewrites the file with other spacing and key order', (r) => r.write(ERRATA_FILE, JSON.stringify(reversedKeys(wellFormed())))],
  ['adds a new dataset', (r) => r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' })],
  ['touches nothing', () => {}],
];

for (const [what, change] of allowed) {
  test(`a change that ${what} passes`, async () => {
    const result = await afterPublication(change);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /No published dataset was modified \(1 protected\)/);
    assert.match(result.stdout, /No published errata issue was changed \(1 file\(s\) protected\)/);
  });
}

/** [what the change does, the change, what the check reports]. */
const forbidden = [
  ['rewords a published issue', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues[0].summary = 'A count may be slightly high.'; })),
    /issue 1 \(example-first\) of errata\/2026-03-18\.json is no longer what was published/],
  ['changes a published magnitude', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues[0].magnitude.value = 1; })),
    /issue 1 \(example-first\) of errata\/2026-03-18\.json is no longer what was published/],
  ['withdraws the last published issue', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues.pop(); })),
    /removed 1 issue\(s\) from errata\/2026-03-18\.json/],
  ['moves a published issue', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues.reverse(); })),
    /issue 1 \(example-first\) of errata\/2026-03-18\.json is no longer what was published/],
  ['puts a new issue ahead of the published ones', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues.unshift(later()); })),
    /issue 1 \(example-first\) of errata\/2026-03-18\.json is no longer what was published/],
  ['changes the date of issue', (r) => r.write(ERRATA_FILE, changed((e) => { e.issuedAt = '2026-11-01'; })),
    /changed issuedAt in errata\/2026-03-18\.json/],
  ['adds a field beside the issues', (r) => r.write(ERRATA_FILE, changed((e) => { e.withdrawn = true; })),
    /changed withdrawn in errata\/2026-03-18\.json/],
  ['empties the list of issues', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues = []; })),
    /removed 2 issue\(s\) from errata\/2026-03-18\.json/],
  ['replaces the list of issues with text', (r) => r.write(ERRATA_FILE, changed((e) => { e.issues = 'none'; })),
    /errata\/2026-03-18\.json cannot be compared with what was published: one of the two is not an errata file/],
  ['leaves a file that does not parse', (r) => r.write(ERRATA_FILE, '{'),
    /errata\/2026-03-18\.json cannot be compared with what was published: one of the two does not parse/],
  ['deletes the errata file', (r) => r.git('rm', '--quiet', '--', ERRATA_FILE),
    /deleted errata\/2026-03-18\.json/],
  ['renames the errata file', (r) => r.git('mv', ERRATA_FILE, 'errata/2026-03-19.json'),
    /renamed errata\/2026-03-18\.json/],
  ['edits a file of a published dataset', (r) => r.write(`datasets/${PUBLISHED}/MANIFEST.json`, { dataset: PUBLISHED, note: 'restated' }),
    /modified datasets\/2026-03-18\/MANIFEST\.json/],
  ['adds a file to a published dataset', (r) => r.write(`datasets/${PUBLISHED}/errata.json`, {}),
    /added a file to datasets\/2026-03-18\/errata\.json/],
  ['moves a file out of a published dataset into a new one', (r) => r.git('mv', `datasets/${PUBLISHED}`, 'datasets/2026-10-05'),
    /renamed datasets\/2026-03-18\/MANIFEST\.json/],
];

for (const [what, change, report] of forbidden) {
  test(`a change that ${what} fails`, async () => {
    const result = await afterPublication(change);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, report);
  });
}
