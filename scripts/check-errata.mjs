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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
async function validateWith(errataFiles, argument, prepare) {
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
    if (prepare) prepare(dir);
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
  ['a date of issue that is not its first issue\'s', (e) => { e.issuedAt = '2026-10-04'; }, /issuedAt is 2026-10-04 and its first issue has 2026-10-05/],
  ['an issue dated in the future', (e) => { e.issues[1].issuedAt = '2999-01-01'; }, /issue 2 \(example-second\) has issuedAt 2999-01-01, after today/],
  ['a file dated in the future', (e) => { e.issuedAt = '2999-01-01'; e.issues.forEach((issue) => { issue.issuedAt = '2999-01-01'; }); }, /: issuedAt is 2999-01-01, after today/, 3],
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
  ['a summary made of characters nobody can see', (e) => { e.issues[0].summary = '\u200B\u200B'; }, /issue 1 \(example-first\) is missing summary/],
  ['a summary that carries a direction override', (e) => { e.issues[0].summary = 'A count \u202Edaer ton saw'; }, /issue 1 \(example-first\) has a control or format character in summary/],
  ['a summary with a control character in it', (e) => { e.issues[0].summary = 'A count includes\u0007 packages that were not read.'; }, /issue 1 \(example-first\) has a control or format character in summary/],
  ['a summary broken over two lines', (e) => { e.issues[0].summary = 'A count includes packages\nthat were not read.'; }, /issue 1 \(example-first\) has a control or format character in summary/],
  ['a unit that carries a character nobody can see', (e) => { e.issues[0].magnitude.unit = 'pack\u200Bages'; }, /has no magnitude\.unit/],
  ['a unit made of characters nobody can see', (e) => { e.issues[0].magnitude.unit = '\u0000'; }, /has no magnitude\.unit/],
  ['a defect id with a space after it', (e) => { e.issues[1].defect = 'example-first '; }, /issue 2 \(example-first \) has a defect id that is not lower-case words joined by hyphens/],
  ['an issue that does not say where it is corrected', (e) => { delete e.issues[0].correctedIn; }, /issue 1 \(example-first\) is missing correctedIn/],
  ['the same defect listed twice', (e) => { e.issues[1].defect = 'example-first'; }, /issue 2 \(example-first\) repeats a defect already listed/],
  ['a direction outside the three', (e) => { e.issues[0].direction = 'wrong'; }, /issue 1 \(example-first\) has direction "wrong"/],
  ['an issue with no direction', (e) => { delete e.issues[0].direction; }, /issue 1 \(example-first\) has direction undefined/],
  ['an issue that names no figure', (e) => { e.issues[0].affects = []; }, /issue 1 \(example-first\) names no figure in affects/],
  ['a figure the aggregate does not have', (e) => { e.issues[0].affects = ['byEcosystem.npm.unread']; }, /affects byEcosystem\.npm\.unread, which is not a field of the 2026-03-18 aggregate/],
  ['a registry the aggregate does not have', (e) => { e.issues[0].affects = ['byEcosystem.conda.scanned']; }, /affects byEcosystem\.conda\.scanned, which is not a field/],
  ['a figure every object has', (e) => { e.issues[0].affects = ['byEcosystem.constructor']; }, /affects byEcosystem\.constructor, which is not a field/],
  ['a path below a number', (e) => { e.issues[0].affects = ['packagesScanned.toFixed']; }, /affects packagesScanned\.toFixed, which is not a field/],
  ['a path below a text value', (e) => { e.issues[0].affects = ['collectedAt.length']; }, /affects collectedAt\.length, which is not a field/],
  ['a figure named with a character nobody can see', (e) => { e.issues[0].affects = ['packagesScanned\u200B']; }, /has an entry in affects that is not a field path/],
  ['a figure named twice', (e) => { e.issues[0].affects = ['packagesScanned', 'packagesScanned']; }, /names packagesScanned twice in affects/],
  ['a figure that is not a path', (e) => { e.issues[0].affects = [42]; }, /has an entry in affects that is not a field path/],
  ['a magnitude left out', (e) => { delete e.issues[0].magnitude; }, /issue 1 \(example-first\) is missing magnitude/],
  ['a magnitude whose count is text', (e) => { e.issues[0].magnitude.value = '3'; }, /has magnitude\.value "3", not a whole count/],
  ['a negative magnitude', (e) => { e.issues[0].magnitude.value = -1; }, /has magnitude\.value -1, not a whole count/],
  ['a magnitude past what a number holds exactly', (e) => { e.issues[0].magnitude = { value: 2 ** 53, of: 2 ** 53 + 2, unit: 'packages' }; }, /has magnitude\.value 9007199254740992, not a whole count/, 2],
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

test('an errata file that is a link to a file elsewhere is refused', async () => {
  // The text of a link lives outside errata/, where the append-only check does not look.
  const result = await validateWith({}, undefined, (dir) => {
    mkdirSync(join(dir, 'attic'));
    writeFileSync(join(dir, 'attic', 'kept.json'), `${JSON.stringify(wellFormed(), null, 2)}\n`);
    symlinkSync(join('..', 'attic', 'kept.json'), join(dir, 'errata', `${PUBLISHED}.json`));
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /errata\/2026-03-18\.json: is not a regular file/);
});

test('errata/ that is a link to a directory elsewhere is refused', async () => {
  // Every file in it is a regular file, kept where the append-only check does not look.
  const result = await validateWith({}, undefined, (dir) => {
    rmSync(join(dir, 'errata'), { recursive: true });
    mkdirSync(join(dir, 'attic'));
    writeFileSync(join(dir, 'attic', `${PUBLISHED}.json`), `${JSON.stringify(wellFormed(), null, 2)}\n`);
    symlinkSync('attic', join(dir, 'errata'));
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /\n1 problem\(s\) across 1 dataset\(s\):/);
  assert.match(result.stderr, /errata: is not a directory/);
});

test('an errata file that starts with a byte order mark is refused', async () => {
  // A decoder that drops the mark reads the rest as the canonical file, which these bytes are not.
  const result = await validateWith({ [`${PUBLISHED}.json`]: `\uFEFF${JSON.stringify(wellFormed(), null, 2)}\n` });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /errata\/2026-03-18\.json: does not parse/);
});

test('a file directly under datasets/ is refused', async () => {
  const result = await validateWith({}, undefined, (dir) => writeFileSync(join(dir, 'datasets', 'corpus-latest.json'), '{}\n'));
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /\n1 problem\(s\) across 1 dataset\(s\):/);
  assert.match(result.stderr, /datasets: corpus-latest\.json is not a dataset directory/);
});

test('an errata file with a byte that is not UTF-8 is refused', async () => {
  const good = Buffer.from(`${JSON.stringify(wellFormed(), null, 2)}\n`, 'utf-8');
  const at = good.indexOf('A count');
  assert.ok(at > 0);
  const bad = Buffer.concat([good.subarray(0, at), Buffer.from([0xff]), good.subarray(at + 1)]);
  const result = await validateWith({}, undefined, (dir) => writeFileSync(join(dir, 'errata', `${PUBLISHED}.json`), bad));
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, ONE_PROBLEM);
  assert.match(result.stderr, /errata\/2026-03-18\.json: does not parse/);
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
 * `published: null` publishes the dataset with no errata file, and
 * `dataset: false` publishes nothing at all.
 */
async function afterPublication(change, { published = wellFormed(), startIn = '.', dataset = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'census-errata-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    git('add', '--', path);
  };
  try {
    git('init', '--quiet', '--initial-branch=work');
    if (dataset) write(`datasets/${PUBLISHED}/MANIFEST.json`, { dataset: PUBLISHED });
    if (dataset && published) write(ERRATA_FILE, published);
    git('commit', '--quiet', '--allow-empty', '--message', 'published');
    git('branch', 'published');
    change({ write, git, dir });
    git('commit', '--quiet', '--allow-empty', '--message', 'change');
    return await run([join(ROOT, 'scripts', 'check-immutable.mjs'), 'published'], { cwd: join(dir, startIn), env: GIT_ENV });
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
    // It stops there: nothing further is asked of a base that cannot be read.
    assert.doesNotMatch(missing.stderr, /share no history/);
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
  ['adds a new dataset that holds an executable file', (r) => {
    r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    chmodSync(join(r.dir, 'datasets', '2026-10-05', 'MANIFEST.json'), 0o755);
    r.git('add', '--', 'datasets/2026-10-05/MANIFEST.json');
  }],
  ['touches nothing', () => {}],
  ['adds an issue while the base has moved on with another change', (r) => {
    // Compared with the tip of the base, this change would seem to lack what
    // the base gained since. It is compared with the point where it left the base.
    r.git('checkout', '--quiet', 'published');
    r.write(ERRATA_FILE, changed((e) => { e.issues.push({ ...later(), defect: 'example-on-the-base' }); }));
    r.git('commit', '--quiet', '--message', 'the base moves on');
    r.git('checkout', '--quiet', 'work');
    r.write(ERRATA_FILE, changed((e) => { e.issues.push(later()); }));
  }],
];

test('a published errata file larger than a megabyte can still be added to', async () => {
  const large = wellFormed();
  for (let i = 0; large.issues.length < 6000; i += 1) large.issues.push({ ...later(), defect: `example-filler-${i}`, issuedAt: '2026-10-05' });
  assert.ok(JSON.stringify(large).length > 1024 * 1024);
  const result = await afterPublication((r) => r.write(ERRATA_FILE, { ...large, issues: [...large.issues, later()] }), { published: large });
  assert.equal(result.code, 0, result.stderr);
});

test('started in a subdirectory, the check still sees a rewritten dataset and a reworded issue', async () => {
  const result = await afterPublication((r) => {
    r.write(`datasets/${PUBLISHED}/MANIFEST.json`, { dataset: PUBLISHED, note: 'restated' });
    r.write(ERRATA_FILE, changed((e) => { e.issues[0].summary = 'A count may be slightly high.'; }));
  }, { startIn: 'datasets' });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /modified datasets\/2026-03-18\/MANIFEST\.json/);
  assert.match(result.stderr, /issue 1 \(example-first\) of errata\/2026-03-18\.json is no longer what was published/);
});

test('a change that left the base before the base gained a dataset passes', async () => {
  // Compared with the tip of the base, this change would seem to have deleted a dataset it never had.
  const result = await afterPublication((r) => {
    r.git('checkout', '--quiet', 'published');
    r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    r.git('commit', '--quiet', '--message', 'the base gains a dataset');
    r.git('checkout', '--quiet', 'work');
    r.write(ERRATA_FILE, changed((e) => { e.issues.push(later()); }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No published dataset was modified \(2 protected\)/);
});

for (const [what, name] of [['ends in a space', 'repo '], ['holds a line feed', 're\npo']]) test(`a checkout whose directory name ${what} is the one that is checked`, async () => {
  // Beside it sits a checkout named without that character, in which nothing was rewritten.
  const parent = mkdtempSync(join(tmpdir(), 'census-errata-names-'));
  const build = (dir, rewrite) => {
    mkdirSync(dir);
    const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const write = (content) => {
      mkdirSync(join(dir, 'datasets', PUBLISHED), { recursive: true });
      writeFileSync(join(dir, 'datasets', PUBLISHED, 'MANIFEST.json'), `${JSON.stringify(content, null, 2)}\n`);
      git('add', '--', 'datasets');
    };
    git('init', '--quiet', '--initial-branch=work');
    write({ dataset: PUBLISHED });
    git('commit', '--quiet', '--message', 'published');
    git('branch', 'published');
    if (!rewrite) return;
    write({ dataset: PUBLISHED, note: 'restated' });
    git('commit', '--quiet', '--message', 'change');
  };
  try {
    build(join(parent, 'repo'), false);
    build(join(parent, name), true);
    const result = await run([join(ROOT, 'scripts', 'check-immutable.mjs'), 'published'], { cwd: join(parent, name), env: GIT_ENV });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /modified datasets\/2026-03-18\/MANIFEST\.json/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

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
  ['adds a key named __proto__ beside the issues', (r) => r.write(ERRATA_FILE, `${JSON.stringify(wellFormed(), null, 2)}\n`.replace('  "issues": [', '  "__proto__": {},\n  "issues": [')),
    /changed __proto__ in errata\/2026-03-18\.json/],
  ['replaces the errata file with a link to a copy of it', (r) => {
    r.write('attic/kept.json', wellFormed());
    rmSync(join(r.dir, ERRATA_FILE));
    symlinkSync(join('..', 'attic', 'kept.json'), join(r.dir, ERRATA_FILE));
    r.git('add', '--', ERRATA_FILE);
  }, /errata\/2026-03-18\.json is not a regular file/],
  ['adds an errata file that is a link', (r) => {
    r.write('attic/other.json', { ...wellFormed(), dataset: '2026-08-03' });
    symlinkSync(join('..', 'attic', 'other.json'), join(r.dir, 'errata', '2026-08-03.json'));
    r.git('add', '--', 'errata/2026-08-03.json');
  }, /errata\/2026-08-03\.json is not a regular file/],
  ['makes errata a link to a directory, where no errata file was published', (r) => {
    r.write(`attic/${PUBLISHED}.json`, wellFormed());
    symlinkSync('attic', join(r.dir, 'errata'));
    r.git('add', '--', 'errata');
  }, /\n  errata is not a directory/, { published: null }],
  ['makes errata a link to a directory, where nothing at all was published', (r) => {
    r.write(`attic/${PUBLISHED}.json`, wellFormed());
    symlinkSync('attic', join(r.dir, 'errata'));
    r.git('add', '--', 'errata');
  }, /\n  errata is not a directory/, { dataset: false }],
  ['replaces datasets with a link to a copy of it', (r) => {
    r.git('mv', 'datasets', 'attic');
    symlinkSync('attic', join(r.dir, 'datasets'));
    r.git('add', '--', 'datasets');
  }, /\n  datasets is not a directory/],
  ['adds a dataset that is a link to a directory elsewhere', (r) => {
    r.write('attic/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    symlinkSync(join('..', 'attic', '2026-10-05'), join(r.dir, 'datasets', '2026-10-05'));
    r.git('add', '--', 'datasets/2026-10-05');
  }, /\n  datasets\/2026-10-05 is not a regular file/],
  ['adds a dataset that holds a link to a file elsewhere', (r) => {
    r.write('attic/aggregate.json', {});
    r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    symlinkSync(join('..', '..', 'attic', 'aggregate.json'), join(r.dir, 'datasets', '2026-10-05', 'aggregate.json'));
    r.git('add', '--', 'datasets/2026-10-05/aggregate.json');
  }, /\n  datasets\/2026-10-05\/aggregate\.json is not a regular file/],
  ['adds a dataset that holds a submodule', (r) => {
    r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    const commit = r.git('rev-parse', 'HEAD').toString().trim();
    r.git('update-index', '--add', '--cacheinfo', `160000,${commit},datasets/2026-10-05/source`);
  }, /\n  datasets\/2026-10-05\/source is not a regular file/],
  ['replaces a file of a published dataset with a link to a copy of it', (r) => {
    r.write('attic/MANIFEST.json', { dataset: PUBLISHED });
    rmSync(join(r.dir, 'datasets', PUBLISHED, 'MANIFEST.json'));
    symlinkSync(join('..', '..', 'attic', 'MANIFEST.json'), join(r.dir, 'datasets', PUBLISHED, 'MANIFEST.json'));
    r.git('add', '--', `datasets/${PUBLISHED}/MANIFEST.json`);
  }, /changed the type of datasets\/2026-03-18\/MANIFEST\.json/],
  ['adds a file directly under datasets', (r) => r.write('datasets/corpus-latest.json', { dataset: 'latest' }),
    /\n  datasets\/corpus-latest\.json is not a dataset directory/],
  ['adds an attribute file at the top of the tree', (r) => r.write('.gitattributes', 'datasets/** export-ignore\n'),
    /This tree holds an attribute file:\n\n  \.gitattributes\n/],
  ['adds an attribute file inside a new dataset', (r) => {
    r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    r.write('datasets/2026-10-05/.gitattributes', '*.json export-ignore\n');
  }, /\n  datasets\/2026-10-05\/\.gitattributes\n/],
  ['adds an attribute file under a directory whose name git prints in quotes', (r) => r.write('notes/na\u00efve/.gitattributes', '* text\n'),
    /This tree holds an attribute file:/],
  ['adds an attribute file named in capitals', (r) => r.write('.GITATTRIBUTES', 'datasets/** export-ignore\n'),
    /This tree holds an attribute file:\n\n  \.GITATTRIBUTES\n/],
  ['adds an attribute file named in mixed case inside a dataset', (r) => {
    r.write('datasets/2026-10-05/MANIFEST.json', { dataset: '2026-10-05' });
    r.write('datasets/2026-10-05/.GitAttributes', '*.json export-ignore\n');
  }, /\n  datasets\/2026-10-05\/\.GitAttributes\n/],
  // Names that are not the attribute file byte for byte, and that git reads as it on HFS+ or NTFS.
  ['adds an attribute file with a format character in its name', (r) => r.write('.git\u200cattributes', 'datasets/** export-ignore\n'),
    /This tree holds an attribute file:/],
  ['adds an attribute file under its first NTFS short name', (r) => r.write('GITATT~1', 'datasets/** export-ignore\n'),
    /This tree holds an attribute file:\n\n  GITATT~1\n/],
  ['adds an attribute file under its fall-back NTFS short name', (r) => r.write('notes/gi7d29~1', 'datasets/** export-ignore\n'),
    /This tree holds an attribute file:\n\n  notes\/gi7d29~1\n/],
  ['adds an attribute file after a backslash in a name', (r) => r.write('notes\\.gitattributes', 'datasets/** export-ignore\n'),
    /This tree holds an attribute file:/],
  ['puts a directory inside errata', (r) => r.write('errata/drafts/2026-08-03.json', wellFormed()),
    /errata\/drafts is not a regular file/],
  ['leaves a file that is not UTF-8', (r) => {
    const good = Buffer.from(`${JSON.stringify(wellFormed(), null, 2)}\n`, 'utf-8');
    const at = good.indexOf('A count');
    writeFileSync(join(r.dir, ERRATA_FILE), Buffer.concat([good.subarray(0, at), Buffer.from([0xff]), good.subarray(at + 1)]));
    r.git('add', '--', ERRATA_FILE);
  }, /errata\/2026-03-18\.json cannot be compared with what was published: one of the two does not parse/],
  ['puts a byte order mark at the start of the errata file', (r) => r.write(ERRATA_FILE, `\uFEFF${JSON.stringify(wellFormed(), null, 2)}\n`),
    /errata\/2026-03-18\.json cannot be compared with what was published: one of the two does not parse/],
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

for (const [what, change, report, options] of forbidden) {
  test(`a change that ${what} fails`, async () => {
    const result = await afterPublication(change, options);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, report);
  });
}

// --- Regenerations ----------------------------------------------------------
//
// An errata file may also record that a dataset's published files were
// written again after the run its manifest names. The validator holds each
// record to its fields, to the run the manifest names, and to the files and
// fields it names; the immutability check lets the list grow and nothing else.

/** The published dataset with raw files, so a regeneration has files to name. Its own errata file is read from this repository. */
const RAW_PUBLISHED = '2026-08-03';
const RUN = JSON.parse(readFileSync(join(ROOT, 'datasets', RAW_PUBLISHED, 'MANIFEST.json'), 'utf-8')).provenance.workflowRun;

/** A regeneration of it. The run is the manifest's; the digest, repository and commit ids are examples. */
const regeneration = () => ({
  issuedAt: '2026-10-06',
  namedRun: RUN,
  runOutputSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  writtenBy: [
    { repository: 'example/instrument', pullRequest: 2, commit: '0123456789abcdef0123456789abcdef01234567' },
    { repository: 'example/instrument', pullRequest: 1, commit: '89abcdef0123456789abcdef0123456789abcdef' },
  ],
  beforeSteps: {
    fields: ['summary.noCrypto', 'summary.weakExposureRate', 'summary.pqcAdoptionRate'],
    ecosystems: ['npm', 'pypi', 'go', 'maven', 'crates', 'packagist', 'nuget', 'rubygems', 'hex', 'pub'],
  },
  summary: 'The published files were written again after the run named in the manifest.',
});

/** Run a copy of the validator over a copy of that dataset and its errata file with regenerations added. */
async function validateRegenerations(change) {
  const dir = mkdtempSync(join(tmpdir(), 'census-regenerations-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts', 'validate-dataset.mjs'), join(dir, 'scripts', 'validate-dataset.mjs'));
    cpSync(join(ROOT, 'datasets', RAW_PUBLISHED), join(dir, 'datasets', RAW_PUBLISHED), { recursive: true });
    mkdirSync(join(dir, 'errata'));
    const errata = JSON.parse(readFileSync(join(ROOT, 'errata', `${RAW_PUBLISHED}.json`), 'utf-8'));
    errata.regenerations = [regeneration()];
    change(errata);
    writeFileSync(join(dir, 'errata', `${RAW_PUBLISHED}.json`), `${JSON.stringify(errata, null, 2)}\n`);
    return await run([join(dir, 'scripts', 'validate-dataset.mjs'), RAW_PUBLISHED], { env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an errata file that records a regeneration validates', async () => {
  const result = await validateRegenerations(() => {});
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 dataset\(s\) validated: 2026-08-03/);
  assert.match(result.stdout, /1 errata file\(s\) validated: 2026-08-03\.json/);
});

test('two regenerations in the order they were added validate', async () => {
  const result = await validateRegenerations((e) => { e.regenerations.push({ ...regeneration(), beforeSteps: { fields: ['summary'], ecosystems: ['cocoapods'] } }); });
  assert.equal(result.code, 0, result.stderr);
});

/** [what the regenerations have wrong, the change that makes it so, the problem reported, how many problems if not one]. */
const refusedRegenerations = [
  ['regenerations that are not a list', (e) => { e.regenerations = {}; }, /has regenerations that are not a list with a regeneration in it/],
  ['an empty list of regenerations', (e) => { e.regenerations = []; }, /has regenerations that are not a list with a regeneration in it/],
  ['a regeneration that is not an object', (e) => { e.regenerations[0] = 'see the issues'; }, /regeneration 1 is not an object/],
  ['a field a regeneration does not define', (e) => { e.regenerations[0].severity = 'high'; }, /regeneration 1 carries severity, which a regeneration does not define/],
  ['no date of issue', (e) => { delete e.regenerations[0].issuedAt; }, /regeneration 1 has issuedAt undefined, not a YYYY-MM-DD date/],
  ['a date of issue that is not a day of the calendar', (e) => { e.regenerations[0].issuedAt = '2026-02-31'; }, /regeneration 1 has issuedAt "2026-02-31", not a YYYY-MM-DD date/],
  ['a date of issue before the dataset was collected', (e) => { e.regenerations[0].issuedAt = '2026-08-02'; }, /regeneration 1 has issuedAt 2026-08-02, before the dataset it describes was collected/],
  ['a date of issue in the future', (e) => { e.regenerations[0].issuedAt = '2999-01-01'; }, /regeneration 1 has issuedAt 2999-01-01, after today/],
  ['a date of issue earlier than the regeneration before it', (e) => { e.regenerations.push({ ...regeneration(), issuedAt: '2026-10-05' }); },
    /regeneration 2 has issuedAt 2026-10-05, earlier than the regeneration before it \(2026-10-06\)/],
  ['a run other than the one the manifest names', (e) => { e.regenerations[0].namedRun = `${RUN}0`; },
    /regeneration 1 names the run .*, and datasets\/2026-08-03\/MANIFEST\.json names ".*"\. A regeneration qualifies the run the manifest names/],
  ['no run', (e) => { e.regenerations[0].namedRun = null; }, /regeneration 1 has namedRun null, not the run the manifest names/],
  ['a digest that is not one', (e) => { e.regenerations[0].runOutputSha256 = 'E3B0'; }, /regeneration 1 has runOutputSha256 "E3B0", not a SHA-256 digest in lower-case hex/],
  ['nothing that wrote the files again', (e) => { e.regenerations[0].writtenBy = []; }, /regeneration 1 names nothing in writtenBy/],
  ['a change with a field of its own', (e) => { e.regenerations[0].writtenBy[0].branch = 'main'; }, /regeneration 1, writtenBy 1, is not \{ repository, pullRequest, commit \}/],
  ['a change with a part missing', (e) => { delete e.regenerations[0].writtenBy[1].commit; }, /regeneration 1, writtenBy 2, is not \{ repository, pullRequest, commit \}/],
  ['a repository that is not owner and name', (e) => { e.regenerations[0].writtenBy[0].repository = 'instrument'; }, /regeneration 1, writtenBy 1, has repository "instrument", not owner\/name/],
  ['a pull request number that is not one', (e) => { e.regenerations[0].writtenBy[0].pullRequest = 0; }, /regeneration 1, writtenBy 1, has pullRequest 0, not a pull request number/],
  ['a commit id that is not a full one', (e) => { e.regenerations[0].writtenBy[0].commit = '0123456'; }, /regeneration 1, writtenBy 1, has commit "0123456", not a full commit id/],
  ['steps that are not { fields, ecosystems }', (e) => { e.regenerations[0].beforeSteps = { fields: ['summary.noCrypto'] }; }, /regeneration 1 has beforeSteps .*, not \{ fields, ecosystems \}/],
  ['no field named', (e) => { e.regenerations[0].beforeSteps.fields = []; }, /regeneration 1 has beforeSteps\.fields \[\], not a list of distinct field paths/],
  ['a registry named twice', (e) => { e.regenerations[0].beforeSteps.ecosystems = ['npm', 'npm']; }, /regeneration 1 has beforeSteps\.ecosystems \["npm","npm"\], not a list of distinct registries/],
  ['a field one named file does not have', (e) => { e.regenerations[0].beforeSteps.fields.push('summary.unread'); },
    /regeneration 1 names summary\.unread, which scan-results-npm-clean\.json does not have/, 10],
  ['a registry with no raw file in the dataset', (e) => { e.regenerations[0].beforeSteps.ecosystems.push('conda'); },
    /regeneration 1 names conda, which has no raw file in datasets\/2026-08-03/],
  ['no summary', (e) => { e.regenerations[0].summary = ' '; }, /regeneration 1 is missing summary/],
  ['a summary with a control character in it', (e) => { e.regenerations[0].summary = 'Written\u0007 again.'; }, /regeneration 1 has a control or format character in summary/],
];

for (const [what, change, problem, count = 1] of refusedRegenerations) {
  test(`an errata file with ${what} is refused`, async () => {
    const result = await validateRegenerations(change);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`\\n${count} problem\\(s\\) across 1 dataset\\(s\\) and 1 errata file\\(s\\):`));
    assert.match(result.stderr, problem);
  });
}

test('a regeneration of a dataset whose manifest names no run, and has no raw files, is refused', async () => {
  const result = await validateWith({ [`${PUBLISHED}.json`]: { ...wellFormed(), regenerations: [regeneration()] } });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /regeneration 1 names the run .*, and datasets\/2026-03-18\/MANIFEST\.json names null/);
  assert.match(result.stderr, /regeneration 1 names npm, which has no raw file in datasets\/2026-03-18/);
});
