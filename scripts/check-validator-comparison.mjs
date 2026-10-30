#!/usr/bin/env node
/**
 * Guards the version 3 rules of scripts/validate-dataset.mjs: a comparison
 * directory, datasets/<YYYY-MM-DD>-deepscan-comparison/.
 *
 * Each test writes a small comparison into a temporary directory, beside a
 * copy of the validator and of one published first-shape dataset, changes one
 * thing about it, and runs the copy. Its stored report is a synthetic report
 * of three projects, written out below: one with a dependency match and source
 * findings, a secret finding among them; one with source findings and no
 * match; and one with neither. It is not a copy of any stored report. Every
 * figure a test expects is written out by hand beside the projects it is
 * counted from, small enough to check by eye, and never computed by the
 * validator's code; the sizes and hashes the manifest lists are computed here,
 * from the bytes written.
 *
 * The immutability tests build a two-commit repository in a temporary
 * directory and run this repository's scripts/check-immutable.mjs in it.
 * Nothing in this repository is written to, and every temporary directory is
 * removed.
 *
 *   node --test scripts/check-validator-comparison.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_SHAPE = '2026-03-18';
const DATE = '2026-09-30';
const NAME = `${DATE}-deepscan-comparison`;
const REPORT = 'scan-comparison-report.json';
/** The SHA-256 the validator carries for the stored report of 2026-03-18-deepscan-comparison, written out here. */
const PINNED = '44764fdc547333b17adefba322b67757cda37f845cce73971ab49dccfd32a959';

// --- The stored report -----------------------------------------------------------

/**
 * Three projects, each project's counts written out to agree with its lists:
 *
 *   example-alpha  depMatch: example-alpha-core, example-cipher (2)
 *                  libraries 1, weakPatterns 1, sourceAlgorithms 2, secrets 1, tlsFindings 1: totalFindings 6
 *                  10 files; javascript
 *   example-beta   depMatch: none
 *                  sourceAlgorithms 1, tlsFindings 2: totalFindings 3
 *                  5 files; python
 *   example-gamma  depMatch: none; no finding: totalFindings 0
 *                  3 files; go, python
 */
function storedReport(date = DATE) {
  return {
    metadata: { generatedAt: `${date}T12:00:00.000Z`, projectCount: 3, scanTool: 'example-source-scanner', comparisonMethod: 'An example method.' },
    projects: [
      {
        project: 'example-alpha',
        depMatch: { count: 2, details: ['example-alpha-core', 'example-cipher'] },
        deepScan: {
          totalFindings: 6,
          libraries: 1,
          libraryNames: ['example-hash'],
          weakPatterns: 1,
          weakDetails: [{ issue: 'A weak hash.', severity: 'high', file: 'src/hash.js' }],
          sourceAlgorithms: 2,
          algorithmDetails: [
            { algorithm: 'AES', category: 'symmetric', language: 'javascript', quantumRisk: 'low' },
            { algorithm: 'RSA', category: 'asymmetric', language: 'javascript', quantumRisk: 'high' },
          ],
          secrets: 1,
          tlsFindings: 1,
          filesScanned: 10,
          languages: ['javascript'],
        },
        multiplier: 3,
      },
      {
        project: 'example-beta',
        depMatch: { count: 0, details: [] },
        deepScan: {
          totalFindings: 3,
          libraries: 0,
          libraryNames: [],
          weakPatterns: 0,
          weakDetails: [],
          sourceAlgorithms: 1,
          algorithmDetails: [{ algorithm: 'SHA-256', category: 'hash', language: 'python', quantumRisk: 'low' }],
          secrets: 0,
          tlsFindings: 2,
          filesScanned: 5,
          languages: ['python'],
        },
        multiplier: 'inf',
      },
      {
        project: 'example-gamma',
        depMatch: { count: 0, details: [] },
        deepScan: {
          totalFindings: 0,
          libraries: 0,
          libraryNames: [],
          weakPatterns: 0,
          weakDetails: [],
          sourceAlgorithms: 0,
          algorithmDetails: [],
          secrets: 0,
          tlsFindings: 0,
          filesScanned: 3,
          languages: ['go', 'python'],
        },
        multiplier: 0,
      },
    ],
    summary: {
      projectsWithDepMatch: 1,
      projectsWithDeepFindings: 2,
      projectsDeepFoundButDepMissed: 1,
      totalDepFindings: 2,
      totalDeepFindings: 9,
      overallMultiplier: 4.5,
      averageMultiplierPerProject: 1.5,
      totalSourceAlgorithms: 3,
      totalWeakPatterns: 1,
      totalTlsFindings: 3,
      totalFilesScanned: 18,
      languagesCovered: ['go', 'javascript', 'python'],
    },
  };
}

// --- The figures, counted from the report above by hand -----------------------------

const FIGURES = {
  dependencyMatches: 2, // example-alpha's two matches
  projectsWithDependencyMatch: 1, // example-alpha
  sourceFindings: 8, // alpha 1 + 1 + 2 + 1 = 5, beta 0 + 0 + 1 + 2 = 3, gamma 0; alpha's secret is excluded
  projectsWithSourceFinding: 2, // alpha and beta
  projectsWithSourceFindingAndNoDependencyMatch: 1, // beta
};
const BY_KIND = { libraries: 1, weakPatterns: 1, sourceAlgorithms: 3, tlsFindings: 3 };
const SECRETS = 1; // alpha's
const STORED_TOTAL = 9; // 6 + 3 + 0
/** The line a run that passes prints for the comparison, written out. */
const RECOUNT_LINE = `Recounted from datasets/${NAME}/${REPORT}: dependencyMatches 2, projectsWithDependencyMatch 1, sourceFindings 8, ` +
  'projectsWithSourceFinding 2, projectsWithSourceFindingAndNoDependencyMatch 1';

const comparisonFile = (name) => ({
  schemaVersion: 3,
  dataset: name,
  source: REPORT,
  projects: 3,
  figures: { ...FIGURES },
  sourceFindingsByKind: { ...BY_KIND },
  secretFindingsExcluded: SECRETS,
  storedTotalFindings: STORED_TOTAL,
  rules: {
    dependencyMatches: 'The sum over the projects of the entries in depMatch.details, which equals depMatch.count in every project.',
    projectsWithDependencyMatch: 'The projects with at least one entry in depMatch.details.',
    sourceFindings: 'The sum over the projects of libraries + weakPatterns + sourceAlgorithms + tlsFindings, which equals ' +
      'totalFindings - secrets in every project.',
    projectsWithSourceFinding: 'The projects where libraries + weakPatterns + sourceAlgorithms + tlsFindings is above zero.',
    projectsWithSourceFindingAndNoDependencyMatch: 'The projects where libraries + weakPatterns + sourceAlgorithms + tlsFindings ' +
      'is above zero and depMatch.details is empty.',
    sourceAlgorithmsUnit: 'sourceAlgorithms counts distinct (algorithm, language) pairs in a project, not occurrences.',
  },
});

const projectsFile = () => ({
  schemaVersion: 3,
  projects: [
    { name: 'example-alpha', repository: null, commit: null, languages: ['javascript'] },
    { name: 'example-beta', repository: null, commit: null, languages: ['python'] },
    { name: 'example-gamma', repository: null, commit: null, languages: ['go', 'python'] },
  ],
});

const figure = (key) => `comparison.json:figures.${key}`;
const EVERY_FIGURE = Object.keys(FIGURES).map(figure);

/**
 * The seven issues, in this order. Their sizes, counted by hand: 8 of 8 source
 * findings and 2 of 2 dependency matches not reviewed; 3 of 3 projects with
 * no raw output and no commit or tool version; 7 of the 8 source findings
 * with no file path (alpha's library, the three algorithms and the three TLS
 * findings; alpha's weak pattern names src/hash.js); and 1 of the 2 matches
 * naming its own project (example-alpha-core, in example-alpha).
 */
const knownIssues = () => [
  {
    defect: 'source-findings-not-reviewed-by-a-human', summary: 'No person has reviewed the source findings.',
    affects: [figure('sourceFindings'), figure('projectsWithSourceFinding'), figure('projectsWithSourceFindingAndNoDependencyMatch')],
    direction: 'unknown', magnitude: { value: 8, of: 8, unit: 'source findings' }, correctedIn: 'Not corrected.',
  },
  {
    defect: 'dependency-matches-not-reviewed-by-a-human', summary: 'No person has reviewed the dependency matches.',
    affects: [figure('dependencyMatches'), figure('projectsWithDependencyMatch'), figure('projectsWithSourceFindingAndNoDependencyMatch')],
    direction: 'unknown', magnitude: { value: 2, of: 2, unit: 'dependency matches' }, correctedIn: 'Not corrected.',
  },
  {
    defect: 'raw-output-of-both-tools-not-stored', summary: 'Only the report was stored.',
    affects: EVERY_FIGURE, direction: 'unknown', magnitude: { value: 3, of: 3, unit: 'projects' }, correctedIn: 'Not corrected.',
  },
  {
    defect: 'project-commits-and-tool-versions-not-recorded', summary: 'No commit and no version was recorded.',
    affects: EVERY_FIGURE, direction: 'unknown', magnitude: { value: 3, of: 3, unit: 'projects' }, correctedIn: 'Not corrected.',
  },
  {
    defect: 'source-findings-carry-no-location', summary: 'Most source findings carry no file path.',
    affects: [figure('sourceFindings')], direction: 'unknown', magnitude: { value: 7, of: 8, unit: 'source findings' },
    correctedIn: 'Not corrected.',
  },
  {
    defect: 'dependency-matches-include-the-projects-own-package', summary: 'One match is the project itself.',
    affects: [figure('dependencyMatches')], direction: 'overstates', magnitude: { value: 1, of: 2, unit: 'dependency matches' },
    correctedIn: 'Not corrected.',
  },
  {
    defect: 'stored-report-carries-ratio-fields', summary: 'The report carries ratio fields.',
    affects: [`${REPORT}:summary.overallMultiplier`, `${REPORT}:summary.averageMultiplierPerProject`, `${REPORT}:projects.*.multiplier`],
    direction: 'unknown', magnitude: null, correctedIn: 'Not corrected.',
  },
];

// --- Writing a comparison -----------------------------------------------------------

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ROLES = { [REPORT]: ['stored-report', null], 'comparison.json': ['comparison', 3], 'projects.json': ['projects', 3], 'README.md': ['readme', null] };

/**
 * The files of a comparison named `name`, as bytes. `change` holds a function
 * for each part it changes, run before the part is written: report,
 * reportText, comparison, comparisonText, projects, and manifest, which runs
 * once the manifest lists every file with its size and hash.
 */
function comparisonFiles(change, name, date) {
  const report = storedReport(date);
  change.report?.(report);
  const comparison = comparisonFile(name);
  change.comparison?.(comparison);
  const projects = projectsFile();
  change.projects?.(projects);
  const reportText = JSON.stringify(report, null, 2);
  const bytes = {
    [REPORT]: Buffer.from(change.reportText ? change.reportText(reportText) : reportText),
    'comparison.json': Buffer.from(change.comparisonText ? change.comparisonText(comparison) : json(comparison)),
    'projects.json': Buffer.from(json(projects)),
    'README.md': Buffer.from('# Example comparison\n\nA synthetic comparison, written by the tests of the validator.\n'),
  };
  const manifest = {
    schemaVersion: 3,
    dataset: 'An example comparison of a dependency scanner and a source scanner',
    kind: 'comparison-aggregate-only',
    collectedAt: date,
    generatedAt: `${date}T18:00:00.000Z`,
    license: 'CC-BY-4.0',
    provenance: null,
    provenanceNote: 'Only the report was stored. No raw output, version or invocation of either scanner was recorded.',
    files: Object.entries(bytes).map(([file, b]) => ({ role: ROLES[file][0], file, bytes: b.length, sha256: sha256(b), schemaVersion: ROLES[file][1] })),
    comparability: [],
    knownIssues: knownIssues(),
  };
  change.manifest?.(manifest);
  return { 'MANIFEST.json': Buffer.from(change.manifestText ? change.manifestText(manifest) : json(manifest)), ...bytes };
}

/** .zenodo.json naming every directory given, as a release's metadata does. */
const zenodoFor = (directories) => ({
  title: 'An example deposit',
  version: `dataset-${FIRST_SHAPE}`,
  description: `<p>The directories at this tag:</p><ul>${directories.map((d) => `<li><code>datasets/${d}</code></li>`).join('')}</ul>`,
});

/**
 * Write a repository into `dir`: a copy of the validator, a copy of the
 * published first-shape dataset, each comparison given (a directory name to
 * [change, its date]), each other directory given (a name to its files),
 * .zenodo.json naming every directory written (changed by `zenodo`, or left
 * out with false), and each errata file given.
 */
function writeTree(dir, { comparisons = { [NAME]: [{}] }, others = {}, errata = {}, zenodo = undefined } = {}) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'validate-dataset.mjs'), join(dir, 'scripts', 'validate-dataset.mjs'));
  cpSync(join(ROOT, 'datasets', FIRST_SHAPE), join(dir, 'datasets', FIRST_SHAPE), { recursive: true });
  const write = (directory, files) => {
    mkdirSync(join(dir, 'datasets', directory), { recursive: true });
    for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, 'datasets', directory, file), bytes);
  };
  for (const [directory, [change = {}, date = DATE]] of Object.entries(comparisons)) write(directory, comparisonFiles(change, directory, date));
  for (const [directory, files] of Object.entries(others)) write(directory, files);
  if (zenodo !== false) {
    const z = zenodoFor([FIRST_SHAPE, ...Object.keys(comparisons), ...Object.keys(others)]);
    zenodo?.(z);
    writeFileSync(join(dir, '.zenodo.json'), json(z));
  }
  if (Object.keys(errata).length > 0) {
    mkdirSync(join(dir, 'errata'));
    for (const [file, content] of Object.entries(errata)) writeFileSync(join(dir, 'errata', file), typeof content === 'string' ? content : json(content));
  }
}

const run = (args, options) => new Promise((done) => {
  execFile(process.execPath, args, { ...options, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
});

/** Write a repository in a temporary directory, run `prepare` on it, and run the copy of the validator with `args`. */
async function validate({ prepare, args = [], ...tree } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'census-v3-'));
  try {
    writeTree(dir, tree);
    if (prepare) prepare(dir);
    return await run([join(dir, 'scripts', 'validate-dataset.mjs'), ...args], { env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One comparison under NAME, changed. */
const validateOne = (change = {}, prepare = undefined) => validate({ comparisons: { [NAME]: [change] }, prepare });
const inComparison = (dir, ...path) => join(dir, 'datasets', NAME, ...path);

/**
 * A refusal whose problems hold a line that begins with `line`, after the two
 * spaces each problem is indented by. A defect is refused, never recorded as
 * a note beside a run that passes.
 */
function refused(result, line) {
  assert.equal(result.code, 1, `expected a refusal, got:\n${result.stdout}${result.stderr}`);
  assert.ok(result.stderr.split('\n').some((l) => l.startsWith(`  ${line}`)), `expected a line beginning\n  ${line}\nin:\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /Recorded, not refused/);
}
const refusedHere = (result, line) => refused(result, `${NAME}: ${line}`);

/** Every character either stream holds is printable ASCII or a line break. */
function assertPrintable(result) {
  for (const [stream, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    const raw = /[^\x20-\x7e\n]/.exec(text);
    assert.equal(raw, null, `${stream} holds U+${raw ? raw[0].charCodeAt(0).toString(16).padStart(4, '0') : ''} as itself`);
  }
}

/** The comparison under NAME passes, beside the published dataset: the control a test of a near miss is read against. */
async function controlPasses() {
  const control = await validate();
  assert.equal(control.code, 0, control.stderr);
  assert.ok(control.stdout.includes(`${RECOUNT_LINE}\n`), control.stdout);
}

// --- T0: the control ------------------------------------------------------------------

test('T0 a comparison that meets the contract passes and prints the figures counted from its stored report', async () => {
  const result = await validate();
  assert.equal(result.code, 0, result.stderr);
  const validated = /^2 dataset\(s\) validated: (.*)$/m.exec(result.stdout);
  assert.ok(validated, result.stdout);
  assert.deepEqual(validated[1].split(', ').sort(), [FIRST_SHAPE, NAME]);
  assert.ok(result.stdout.includes(`\n${RECOUNT_LINE}\n`), result.stdout);
});

test('T0 the comparison named on the command line passes alone and prints the same figures', async () => {
  const result = await validate({ args: [NAME] });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`1 dataset(s) validated: ${NAME}\n${RECOUNT_LINE}\n`), result.stdout);
});

test('T0 this repository\'s own datasets and errata files still validate, read where they are', async () => {
  const result = await run([join(ROOT, 'scripts', 'validate-dataset.mjs')], { cwd: ROOT, env: {} });
  assert.equal(result.code, 0, result.stderr);
  const validated = /^(\d+) dataset\(s\) validated: (.*)$/m.exec(result.stdout);
  assert.ok(validated, result.stdout);
  for (const dataset of ['2026-03-18', '2026-08-03']) assert.ok(validated[2].split(', ').includes(dataset), result.stdout);
  assert.match(result.stdout, /^\d+ errata file\(s\) validated: .*2026-08-03\.json/m);
});

// --- T1: the name -------------------------------------------------------------------

/** [what, the directory name, the name as the problem prints it]. */
const NEAR_MISSES = [
  ['another suffix', `${DATE}-deepscan-comparisons`, `"${DATE}-deepscan-comparisons"`],
  ['a suffix that is not on the list', `${DATE}-source-comparison`, `"${DATE}-source-comparison"`],
  ['the suffix in upper case', `${DATE}-DEEPSCAN-COMPARISON`, `"${DATE}-DEEPSCAN-COMPARISON"`],
  ['an underscore before the suffix', `${DATE}_deepscan-comparison`, `"${DATE}_deepscan-comparison"`],
  ['an underscore inside the suffix', `${DATE}-deepscan_comparison`, `"${DATE}-deepscan_comparison"`],
  ['the hyphen U+2010 before the suffix', `${DATE}\u2010deepscan-comparison`, `"${DATE}\\u2010deepscan-comparison"`],
  ['the non-breaking hyphen U+2011 inside the suffix', `${DATE}-deepscan\u2011comparison`, `"${DATE}-deepscan\\u2011comparison"`],
  ['a trailing space', `${NAME} `, `"${NAME} "`],
  ['a bare trailing hyphen', `${DATE}-`, `"${DATE}-"`],
];
for (const [what, directory, shown] of NEAR_MISSES) {
  test(`T1 a name with ${what} is refused as no dataset name, and the same files under the comparison name pass`, async () => {
    await controlPasses();
    refused(await validate({ comparisons: { [directory]: [{}] } }), `${shown}: directory name is not a YYYY-MM-DD collection date`);
  });
}

test('T1 a comparison name whose date is not a date of the calendar is refused, and a real date passes', async () => {
  await controlPasses();
  refused(await validate({ comparisons: { '2026-02-30-deepscan-comparison': [{}, '2026-02-30'] } }),
    '"2026-02-30-deepscan-comparison": directory name has the form of a comparison directory, and 2026-02-30 is not a date of the calendar');
});

test('T1 a census name whose date is not a date of the calendar is refused', async () => {
  await controlPasses();
  refused(await validate({ comparisons: {}, others: { '2026-02-30': comparisonFiles({}, '2026-02-30', '2026-02-30') } }),
    '"2026-02-30": directory name has the form of a census directory, and 2026-02-30 is not a date of the calendar');
});

test('T1 version 3 under a name that is a date alone is refused', async () => {
  const result = await validate({ comparisons: {}, others: { [DATE]: comparisonFiles({}, DATE, DATE) } });
  refused(result, `${DATE}: schemaVersion is 3, which is not a version these rules know for a directory named by its date alone. ` +
    'Version 3 is the comparison contract');
});

test('T1 version 2 under a comparison name is refused', async () => {
  refusedHere(await validateOne({ manifest: (m) => { m.schemaVersion = 2; } }), `schemaVersion is 2, and ${NAME} is a comparison directory.`);
});

test('T1 no version under a comparison name is refused', async () => {
  refusedHere(await validateOne({ manifest: (m) => { delete m.schemaVersion; } }),
    `MANIFEST.json declares no schemaVersion, and ${NAME} is a comparison directory, which declares version 3.`);
});

// --- T2: version and kind ---------------------------------------------------------------

test('T2 schemaVersion 4 under a comparison name is refused', async () => {
  refusedHere(await validateOne({ manifest: (m) => { m.schemaVersion = 4; } }),
    'schemaVersion is 4, which is not a version these rules know. A comparison directory declares the number 3');
});

test('T2 the version written as text is refused', async () => {
  refusedHere(await validateOne({ manifest: (m) => { m.schemaVersion = '3'; } }),
    'schemaVersion is "3", which is not a version these rules know. A comparison directory declares the number 3');
});

for (const kind of ['comparison-raw+aggregate', 'aggregate-only', 'raw+aggregate']) {
  test(`T2 kind ${kind} under version 3 is refused`, async () => {
    refusedHere(await validateOne({ manifest: (m) => { m.kind = kind; } }),
      `MANIFEST.json: kind is "${kind}", which is not a kind version 3 accepts (comparison-aggregate-only).`);
  });
}

/**
 * A version 2 census dataset with every field of its manifest and of its
 * corpus present and almost nothing in them: refused on many counts, and read
 * far enough for its manifest's kind and its corpus's comparison with earlier
 * datasets to be checked.
 */
function censusV2(date, { comparability = [], kind = 'raw+aggregate' } = {}) {
  const corpusFile = `corpus-${date}.json`;
  const corpus = Buffer.from(json({
    schemaVersion: 2, kind: 'censusCorpus', collectedAt: date, generatedAt: `${date}T12:00:00.000Z`, aggregator: null,
    scanJobsComplete: null, inputs: null, definitions: null, comparability, blocked: [], withheld: [], coverage: null,
    byEcosystem: {}, total: null, multiPurposeLibraries: [],
  }));
  const manifest = {
    schemaVersion: 2, dataset: 'An example census', kind, collectedAt: date, generatedAt: `${date}T12:00:00.000Z`, license: 'CC-BY-4.0',
    provenance: null, files: [{ role: 'corpus', ecosystem: null, file: corpusFile, bytes: corpus.length, sha256: sha256(corpus), schemaVersion: 2 }],
    coverage: null, ecosystems: [], comparability, checks: null, knownIssues: [],
  };
  return { 'MANIFEST.json': Buffer.from(json(manifest)), [corpusFile]: corpus };
}

test('T2 the comparison kind in a version 2 manifest under a date alone is refused, and under a comparison name passes', async () => {
  await controlPasses();
  refused(await validate({ comparisons: {}, others: { '2026-10-01': censusV2('2026-10-01', { kind: 'comparison-aggregate-only' }) } }),
    '2026-10-01: MANIFEST.json: kind is "comparison-aggregate-only". A version 2 dataset is raw+aggregate');
});

// --- T3: the manifest -------------------------------------------------------------------

const manifestOf = (fn) => ({ manifest: fn });

test('T3 a manifest key the contract does not define is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.note = 'x'; })),
    'schemaVersion is 3, but MANIFEST.json is not a version 3 manifest: it carries "note", which a version 3 manifest does not define');
});

test('T3 a manifest without one of its keys is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { delete m.comparability; })),
    'schemaVersion is 3, but MANIFEST.json is not a version 3 manifest: it lacks comparability.');
});

test('T3 provenance that is not null is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.provenance = { note: 'x' }; })),
    'MANIFEST.json: provenance is {"note":"x"}. Under comparison-aggregate-only it is null');
});

test('T3 an empty provenanceNote is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.provenanceNote = ''; })), 'MANIFEST.json: provenanceNote is "". Where provenance is null');
});

test('T3 a collection date that is not the directory\'s date is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.collectedAt = '2026-09-29'; })),
    `MANIFEST.json: collectedAt is "2026-09-29", and the directory's date is ${DATE}.`);
});

test('T3 a collection date that is not the UTC date of the report\'s generatedAt is refused', async () => {
  refusedHere(await validateOne({ report: (r) => { r.metadata.generatedAt = '2026-09-29T23:00:00.000Z'; } }),
    `MANIFEST.json: collectedAt is "${DATE}", and ${REPORT} was generated at 2026-09-29T23:00:00.000Z, on 2026-09-29 in UTC.`);
});

test('T3 a generation time before the collection date is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.generatedAt = '2026-09-29T12:00:00.000Z'; })),
    `MANIFEST.json: generatedAt is 2026-09-29T12:00:00.000Z, before the run it describes, on ${DATE}`);
});

test('T3 a generation time after today is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.generatedAt = '2999-01-01T00:00:00.000Z'; })),
    'MANIFEST.json: generatedAt is 2999-01-01T00:00:00.000Z, after today (');
});

test('T3 a generation time that is not a time is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.generatedAt = 'yesterday'; })), 'MANIFEST.json: generatedAt is "yesterday", not a time');
});

test('T3 a dataset with no title is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.dataset = ' '; })), 'MANIFEST.json: dataset is " ", not a title');
});

test('T3 another licence is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.license = 'CC0-1.0'; })), 'MANIFEST.json: license is "CC0-1.0"');
});

test('T3 a manifest that is not in canonical form is refused', async () => {
  refusedHere(await validateOne({ manifestText: (m) => `${JSON.stringify(m, null, 4)}\n` }), 'MANIFEST.json is not in its canonical form');
});

test('T3 a manifest whose first key is not schemaVersion is refused', async () => {
  refusedHere(await validateOne({ manifestText: ({ schemaVersion, ...rest }) => json({ ...rest, schemaVersion }) }),
    'MANIFEST.json does not begin with schemaVersion.');
});

test('T3 a comparability list naming a census dataset is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.comparability = [{ dataset: FIRST_SHAPE, doi: null, comparable: false, reason: 'A census.' }]; })),
    `MANIFEST.json: comparability[0] names "${FIRST_SHAPE}", which is not a comparison directory of this repository dated before ${DATE}`);
});

const LATER = '2026-10-15-deepscan-comparison';
const namesEarlier = (fields = {}) => manifestOf((m) => { m.comparability = [{ dataset: NAME, doi: null, comparable: false, reason: 'No tool version is recorded in either.', ...fields }]; });

test('T3 a later comparison that names the earlier one as not comparable passes, and prints both lines', async () => {
  const result = await validate({ comparisons: { [NAME]: [{}], [LATER]: [namesEarlier(), '2026-10-15'] } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`${RECOUNT_LINE}\n`), result.stdout);
  assert.ok(result.stdout.includes(RECOUNT_LINE.replace(NAME, LATER)), result.stdout);
});

test('T3 a later comparison that does not name the earlier one is refused', async () => {
  refused(await validate({ comparisons: { [NAME]: [{}], [LATER]: [{}, '2026-10-15'] } }),
    `${LATER}: MANIFEST.json: comparability does not name ${NAME}. Every earlier comparison directory is named`);
});

test('T3 a later comparison that calls an earlier aggregate-only one comparable is refused', async () => {
  refused(await validate({ comparisons: { [NAME]: [{}], [LATER]: [namesEarlier({ comparable: true, reason: null }), '2026-10-15'] } }),
    `${LATER}: MANIFEST.json: comparability[0]: ${NAME} is comparison-aggregate-only, which records no tool version, so it is not comparable`);
});

test('T3 an earlier comparison\'s manifest not read for the bound is listed for the later comparison, whose check it stopped', async () => {
  const result = await validate({
    comparisons: { [NAME]: [{}], [LATER]: [namesEarlier({ comparable: true, reason: null }), '2026-10-15'] },
    // The later comparison's README.md grown, sparse, until its directory holds all of the 150,000,000 bytes the checks
    // hold at once, so that no byte is left for the earlier comparison's manifest.
    prepare: (dir) => {
      const later = join(dir, 'datasets', LATER);
      const rest = ['MANIFEST.json', REPORT, 'comparison.json', 'projects.json'].reduce((n, file) => n + statSync(join(later, file)).size, 0);
      truncateSync(join(later, 'README.md'), 150_000_000 - rest);
    },
  });
  refused(result, `${LATER}: datasets/${NAME}/MANIFEST.json was not read: it is `);
  refused(result, `${LATER}: MANIFEST.json: comparability[0]: ${NAME} has no manifest these rules can read`);
  const earlier = result.stderr.split('\n').filter((line) => line.startsWith(`  ${NAME}: `));
  assert.deepEqual(earlier, [], `${NAME} passes its own checks, and a problem is listed for it`);
});

// --- T4: the files --------------------------------------------------------------------

const entry = (m, role) => m.files.find((f) => f.role === role);

test('T4 one byte of a listed file changed is refused', async () => {
  refusedHere(await validateOne({}, (dir) => {
    const path = inComparison(dir, 'README.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('#', '%'));
  }), 'README.md does not match its recorded hash');
});

test('T4 a size that is not the file\'s is refused', async () => {
  const result = await validateOne(manifestOf((m) => { entry(m, 'readme').bytes += 1; }));
  refusedHere(result, 'README.md is ');
  const [, size, said] = /README\.md is (\d+) bytes, manifest says (\d+)/.exec(result.stderr);
  assert.equal(Number(said), Number(size) + 1);
});

test('T4 a stray file is refused', async () => {
  refusedHere(await validateOne({}, (dir) => writeFileSync(inComparison(dir, 'notes.txt'), 'x')),
    'present but not listed in MANIFEST.json: "notes.txt".');
});

test('T4 a listed file that is a link is refused by the validator itself', async () => {
  refusedHere(await validateOne({}, (dir) => {
    const path = inComparison(dir, 'comparison.json');
    renameSync(path, join(dir, 'kept.json'));
    symlinkSync(join('..', '..', 'kept.json'), path);
  }), 'comparison.json is a link.');
});

test('T4 an unlisted link is refused', async () => {
  refusedHere(await validateOne({}, (dir) => symlinkSync(join('..', '..', '.zenodo.json'), inComparison(dir, 'more.json'))),
    '"more.json" is a link.');
});

test('T4 a subdirectory is refused', async () => {
  refusedHere(await validateOne({}, (dir) => {
    mkdirSync(inComparison(dir, 'more'));
    writeFileSync(inComparison(dir, 'more', 'notes.json'), '{}\n');
  }), '"more" is a directory.');
});

test('T4 a role missing is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.files = m.files.filter((f) => f.role !== 'readme'); }), (dir) => unlinkSync(inComparison(dir, 'README.md'))),
    'MANIFEST.json lists no readme file');
});

test('T4 a role listed twice is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { m.files.push({ ...entry(m, 'readme') }); })),
    'MANIFEST.json: files[4] lists the readme file a second time.');
});

test('T4 a role the contract does not define is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { entry(m, 'stored-report').role = 'report'; })),
    'MANIFEST.json: files[0].role is "report", not one of: stored-report, comparison, projects, readme');
});

for (const [what, path, shown] of [['a step up', '../comparison.json', '"../comparison.json"'], ['an absolute path', '/tmp/comparison.json', '"/tmp/comparison.json"'],
  ['a backslash', 'more\\comparison.json', '"more\\\\comparison.json"']]) {
  test(`T4 a listed path with ${what} is refused`, async () => {
    refusedHere(await validateOne(manifestOf((m) => { entry(m, 'comparison').file = path; })),
      `MANIFEST.json: files[1] names ${shown}, which is not the name of a file in the dataset's own directory.`);
  });
}

test('T4 a role listed under another file name is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { entry(m, 'comparison').file = 'figures.json'; })),
    'MANIFEST.json: files[1] names "figures.json" as the comparison file, which is named comparison.json');
});

test('T4 a listed file that is absent is refused', async () => {
  refusedHere(await validateOne({}, (dir) => unlinkSync(inComparison(dir, 'projects.json'))),
    'projects.json is listed in MANIFEST.json but is not in the dataset');
});

test('T4 a version on the stored report\'s entry is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { entry(m, 'stored-report').schemaVersion = 3; })),
    'MANIFEST.json: files[0].schemaVersion is 3, and the stored-report file\'s is null: its bytes are not versioned here');
});

test('T4 a hash that is not one is refused', async () => {
  refusedHere(await validateOne(manifestOf((m) => { entry(m, 'projects').sha256 = 'abc'; })),
    'MANIFEST.json: files[2].sha256 is "abc", not a SHA-256 digest in lower-case hex');
});

test('T4 a final newline added to the stored report, with the hash in the manifest written again, is refused', async () => {
  refusedHere(await validateOne({ reportText: (text) => `${text}\n` }), `${REPORT} is not in the form it was stored in`);
});

test('T4 the stored report written again with four spaces is refused', async () => {
  refusedHere(await validateOne({ reportText: (text) => JSON.stringify(JSON.parse(text), null, 4) }), `${REPORT} is not in the form it was stored in`);
});

test('T4 a derived file that is not in canonical form is refused', async () => {
  refusedHere(await validateOne({ comparisonText: (c) => `${JSON.stringify(c, null, 4)}\n` }), 'comparison.json is not in its canonical form');
});

test('T4 a synthetic report under the name whose report is pinned is refused by the pinned hash alone', async () => {
  const pinnedName = '2026-03-18-deepscan-comparison';
  const result = await validate({ comparisons: { [pinnedName]: [{}, '2026-03-18'] } });
  refused(result, `${pinnedName}: ${REPORT} has SHA-256 `);
  assert.ok(result.stderr.includes(`, and the report stored for ${pinnedName} has ${PINNED}.`), result.stderr);
  assert.match(result.stderr, /\n1 problem\(s\) across 2 dataset\(s\):/);
});

// --- T5: the stored report agrees with itself -------------------------------------------------

const reportOf = (fn) => ({ report: fn });
const alpha = (fn) => reportOf((r) => fn(r.projects[0].deepScan, r.projects[0]));
const at = (path) => `${REPORT}: ${path}`;

const STORED_DEFECTS = [
  ['depMatch.count unequal to its details', alpha((s, p) => { p.depMatch.count = 3; }), at('projects[0].depMatch.count is 3, and depMatch.details lists 2.')],
  ['totalFindings unequal to its five parts', alpha((s) => { s.totalFindings = 7; }),
    at('projects[0].deepScan.totalFindings is 7, and its five parts, libraries, weakPatterns, sourceAlgorithms, secrets and tlsFindings, sum to 6')],
  ['libraries one more than its list', alpha((s) => { s.libraries = 2; }), at('projects[0].deepScan.libraries is 2, and libraryNames lists 1')],
  ['weakPatterns one more than its list', alpha((s) => { s.weakPatterns = 2; }), at('projects[0].deepScan.weakPatterns is 2, and weakDetails lists 1')],
  ['sourceAlgorithms one more than its list', alpha((s) => { s.sourceAlgorithms = 3; }), at('projects[0].deepScan.sourceAlgorithms is 3, and algorithmDetails lists 2')],
  ['secrets one more', alpha((s) => { s.secrets = 2; }),
    at('projects[0].deepScan.totalFindings is 6, and its five parts, libraries, weakPatterns, sourceAlgorithms, secrets and tlsFindings, sum to 7')],
  ['tlsFindings one more', alpha((s) => { s.tlsFindings = 2; }),
    at('projects[0].deepScan.totalFindings is 6, and its five parts, libraries, weakPatterns, sourceAlgorithms, secrets and tlsFindings, sum to 7')],
  ['filesScanned one more', alpha((s) => { s.filesScanned = 11; }), at('summary.totalFilesScanned is 18; counted again from the projects, it is 19')],
  ['a count that is not whole', alpha((s) => { s.filesScanned = 1.5; }), at('projects[0].deepScan.filesScanned is 1.5, not a whole count')],
  ['a repeated (algorithm, language) pair', alpha((s) => { s.algorithmDetails[1] = { ...s.algorithmDetails[0] }; }),
    at('projects[0].deepScan.algorithmDetails lists the pair ("AES", "javascript") twice.')],
  ['a project key missing', reportOf((r) => { delete r.projects[1].multiplier; }), at('projects[1] is missing multiplier, which the stored report holds there')],
  ['a project key added', reportOf((r) => { r.projects[1].note = 'x'; }), at('projects[1] carries "note", which the stored report does not hold there.')],
  ['a key added at the top', reportOf((r) => { r.notes = []; }), `${REPORT} carries "notes", which the stored report does not hold there.`],
  ['a summary key missing', reportOf((r) => { delete r.summary.totalWeakPatterns; }), at('summary is missing totalWeakPatterns, which the stored report holds there')],
  ['a weak pattern key missing', alpha((s) => { delete s.weakDetails[0].severity; }), at('projects[0].deepScan.weakDetails[0] is missing severity')],
  ['projectCount one more', reportOf((r) => { r.metadata.projectCount = 4; }), at('metadata.projectCount is 4, and the report lists 3 projects')],
];
/** Each summary count one off, with the value counted again from the projects, written out. */
const SUMMARY = [['projectsWithDepMatch', 1], ['projectsWithDeepFindings', 2], ['projectsDeepFoundButDepMissed', 1], ['totalDepFindings', 2],
  ['totalDeepFindings', 9], ['totalSourceAlgorithms', 3], ['totalWeakPatterns', 1], ['totalTlsFindings', 3], ['totalFilesScanned', 18]];
for (const [key, value] of SUMMARY) {
  STORED_DEFECTS.push([`summary.${key} one more`, reportOf((r) => { r.summary[key] = value + 1; }),
    at(`summary.${key} is ${value + 1}; counted again from the projects, it is ${value}`)]);
}
STORED_DEFECTS.push(['summary.languagesCovered without a language', reportOf((r) => { r.summary.languagesCovered = ['go', 'javascript']; }),
  at('summary.languagesCovered is ["go","javascript"]; counted again from the projects, it is ["go","javascript","python"]')]);
for (const [what, change, line] of STORED_DEFECTS) {
  test(`T5 a stored report with ${what} is refused`, async () => refusedHere(await validateOne(change), line));
}

// --- T6: comparison.json ----------------------------------------------------------------

const comparisonOf = (fn) => ({ comparison: fn });
const counted = (path, value, rule, expected) =>
  `comparison.json: ${path} is ${value}; counted from ${REPORT} as ${rule}, it is ${expected}`;

const FIGURE_DEFECTS = [
  ['dependencyMatches', 3, 'the sum over the projects of the entries in depMatch.details'],
  ['projectsWithDependencyMatch', 2, 'the projects with at least one entry in depMatch.details'],
  ['sourceFindings', 7, 'the sum over the projects of libraries + weakPatterns + sourceAlgorithms + tlsFindings, secrets excluded'],
  ['projectsWithSourceFinding', 3, 'the projects where libraries + weakPatterns + sourceAlgorithms + tlsFindings is above zero'],
  ['projectsWithSourceFindingAndNoDependencyMatch', 2, 'the projects where that sum is above zero and depMatch.details is empty'],
];
for (const [key, value, rule] of FIGURE_DEFECTS) {
  test(`T6 figures.${key} one off is refused`, async () => {
    refusedHere(await validateOne(comparisonOf((c) => { c.figures[key] = value; })), counted(`figures.${key}`, value, rule, FIGURES[key]));
  });
}

test('T6 sourceFindings counted with the secret findings is refused, and the problem says so', async () => {
  refusedHere(await validateOne(comparisonOf((c) => { c.figures.sourceFindings = 9; })),
    `${counted('figures.sourceFindings', 9, FIGURE_DEFECTS[2][2], 8)}. 9 is the sum with secrets included, and secret findings are excluded from it.`);
});

for (const [path, value, rule, expected, change] of [
  ['projects', 4, 'the number of its projects', 3, (c) => { c.projects = 4; }],
  ['sourceFindingsByKind.tlsFindings', 4, 'the sum of tlsFindings over the projects', 3, (c) => { c.sourceFindingsByKind.tlsFindings = 4; }],
  ['secretFindingsExcluded', 0, 'the sum of secrets over the projects', 1, (c) => { c.secretFindingsExcluded = 0; }],
  ['storedTotalFindings', 8, 'the sum of totalFindings over the projects', 9, (c) => { c.storedTotalFindings = 8; }],
]) {
  test(`T6 ${path} one off is refused`, async () => refusedHere(await validateOne(comparisonOf(change)), counted(path, value, rule, expected)));
}

for (const [what, change, path, word] of [
  ['a key overallMultiplier', (c) => { c.overallMultiplier = 4.5; }, 'overallMultiplier', 'multiplier'],
  ['a nested key ratio', (c) => { c.figures.ratio = 4; }, 'figures.ratio', 'ratio'],
  ['a key that holds the word times', (c) => { c.rules.timesMore = 'x'; }, 'rules.timesMore', 'times'],
  ['a key in upper case that holds the word ratio', (c) => { c.figures.SOURCE_RATIO = 1; }, 'figures.SOURCE_RATIO', 'ratio'],
]) {
  test(`T6 ${what} is refused as a ratio`, async () => {
    refusedHere(await validateOne(comparisonOf(change)), `comparison.json: ${path} is a key that holds the word ${word}.`);
  });
}

for (const [key, change, line] of [
  ['duration', (c) => { c.figures.duration = 1; }, 'comparison.json: figures carries "duration", which the version 3 contract does not define.'],
  ['timestamp', (c) => { c.timestamp = '2026-09-30'; }, 'comparison.json carries "timestamp", which the version 3 contract does not define.'],
]) {
  test(`T6 a key ${key}, which holds the letters of a ratio word and no ratio word, is refused only as a key the contract does not define`, async () => {
    const result = await validateOne(comparisonOf(change));
    refusedHere(result, line);
    assert.doesNotMatch(result.stderr, /is a key that holds the word/);
  });
}

test('T6 a dataset name that is not the directory\'s is refused', async () => {
  refusedHere(await validateOne(comparisonOf((c) => { c.dataset = '2026-09-29-deepscan-comparison'; })),
    `comparison.json: dataset is "2026-09-29-deepscan-comparison", and the directory is ${NAME}`);
});

test('T6 a source that is not the stored report is refused', async () => {
  refusedHere(await validateOne(comparisonOf((c) => { c.source = 'report.json'; })), 'comparison.json: source is "report.json".');
});

test('T6 a rule that does not name the stored fields it counts is refused', async () => {
  refusedHere(await validateOne(comparisonOf((c) => { c.rules.sourceFindings = 'The source findings.'; })),
    'comparison.json: rules.sourceFindings does not name libraries, weakPatterns, sourceAlgorithms, tlsFindings.');
});

test('T6 a rule missing is refused', async () => {
  refusedHere(await validateOne(comparisonOf((c) => { delete c.rules.sourceAlgorithmsUnit; })), 'comparison.json: rules is missing sourceAlgorithmsUnit.');
});

test('T6 comparison.json in version 2 is refused', async () => {
  refusedHere(await validateOne(comparisonOf((c) => { c.schemaVersion = 2; })), 'comparison.json has schemaVersion 2.');
});

// --- T7: projects.json, secret fields, printable output ----------------------------------------

const projectsOf = (fn) => ({ projects: fn });

test('T7 two names swapped is refused', async () => {
  refusedHere(await validateOne(projectsOf((p) => { [p.projects[0], p.projects[1]] = [p.projects[1], p.projects[0]]; })),
    `projects.json: projects[0].name is "example-beta", and ${REPORT} names project 1 "example-alpha".`);
});

test('T7 a repository filled in is refused', async () => {
  refusedHere(await validateOne(projectsOf((p) => { p.projects[0].repository = 'https://example.invalid/alpha'; })),
    'projects.json: projects[0].repository is "https://example.invalid/alpha". Under comparison-aggregate-only it is null');
});

test('T7 a commit filled in is refused', async () => {
  refusedHere(await validateOne(projectsOf((p) => { p.projects[0].commit = '0123456789abcdef0123456789abcdef01234567'; })),
    'projects.json: projects[0].commit is "0123456789abcdef0123456789abcdef01234567". Under comparison-aggregate-only it is null');
});

test('T7 a list of languages changed is refused', async () => {
  refusedHere(await validateOne(projectsOf((p) => { p.projects[2].languages = ['python', 'go']; })),
    `projects.json: projects[2].languages is ["python","go"], and ${REPORT} lists ["go","python"] for that project`);
});

test('T7 a project left out is refused', async () => {
  refusedHere(await validateOne(projectsOf((p) => { p.projects.pop(); })), `projects.json: projects lists 2, and ${REPORT} 3.`);
});

for (const [file, change, path, key, what] of [
  ['projects.json', projectsOf((p) => { p.projects[0].secrets = 1; }), 'projects.*.secrets', 'secrets', 'hard-coded secret findings'],
  ['comparison.json', comparisonOf((c) => { c.secrets = 1; }), 'secrets', 'secrets', 'hard-coded secret findings'],
]) {
  test(`T7 a ${key} field in ${file} is refused`, async () => {
    refusedHere(await validateOne(change), `${file}: ${path} is ${key}, the stored report's field for a project's ${what}.`);
  });
}

// The stored report holds no list of key files, so a certFiles field is refused as a key the contract does not define.
test('T7 a certFiles field in projects.json is refused', async () => {
  refusedHere(await validateOne(projectsOf((p) => { p.projects[0].certFiles = ['keys/example-key-file']; })),
    'projects.json: projects[0] carries "certFiles", which the version 3 contract does not define.');
});

test('T7 a direction override and a control character in a project name print escaped', async () => {
  const result = await validateOne(reportOf((r) => { r.projects[0].project = 'example-\u202ealpha\u001b'; }));
  refusedHere(result, at('projects[0].project is "example-\\u202ealpha\\u001b", which holds a control or format character.'));
  assertPrintable(result);
});

test('T7 a direction override and a control character in a weak pattern\'s path print escaped', async () => {
  const result = await validateOne(alpha((s) => { s.weakDetails[0].file = 'src/\u202ehash\u0007.js'; }));
  refusedHere(result, at('projects[0].deepScan.weakDetails[0].file is "src/\\u202ehash\\u0007.js", which holds a control or format character.'));
  assertPrintable(result);
});

// --- T8: knownIssues -------------------------------------------------------------------

const issuesOf = (fn) => manifestOf((m) => fn(m.knownIssues));
const issue = (index) => `MANIFEST.json: knownIssues[${index}]`;

const ISSUE_DEFECTS = [
  ['the source review entry missing', issuesOf((k) => { k.splice(0, 1); }),
    'MANIFEST.json: knownIssues has no source-findings-not-reviewed-by-a-human entry. A comparison-aggregate-only directory carries it'],
  ['the dependency review entry missing', issuesOf((k) => { k.splice(1, 1); }),
    'MANIFEST.json: knownIssues has no dependency-matches-not-reviewed-by-a-human entry.'],
  ['the raw output entry missing', issuesOf((k) => { k.splice(2, 1); }), 'MANIFEST.json: knownIssues has no raw-output-of-both-tools-not-stored entry.'],
  ['the commits and versions entry missing', issuesOf((k) => { k.splice(3, 1); }),
    'MANIFEST.json: knownIssues has no project-commits-and-tool-versions-not-recorded entry.'],
  ['a review value below its of', issuesOf((k) => { k[0].magnitude.value = 7; }),
    `${issue(0)}.magnitude.value is 7 of 8. No review is in the dataset, so none of them was reviewed, and the value equals of.`],
  ['a review of unequal to its figure', issuesOf((k) => { k[0].magnitude = { value: 9, of: 9, unit: 'source findings' }; }),
    `${issue(0)}.magnitude.of is 9, and the figure it names, figures.sourceFindings, is 8, counted from the stored report`],
  ['a dependency review of unequal to its figure', issuesOf((k) => { k[1].magnitude = { value: 3, of: 3, unit: 'dependency matches' }; }),
    `${issue(1)}.magnitude.of is 3, and the figure it names, figures.dependencyMatches, is 2, counted from the stored report`],
  ['an affects path that does not resolve', issuesOf((k) => { k[4].affects = [figure('nothing'), figure('sourceFindings')]; }),
    `${issue(4)} affects "comparison.json:figures.nothing", which is not a field of comparison.json`],
  ['an affects path that names no file', issuesOf((k) => { k[4].affects = ['figures.sourceFindings']; }),
    `${issue(4)} affects "figures.sourceFindings", which names no file.`],
  ['an affects path in another file', issuesOf((k) => { k[4].affects = ['projects.json:projects', figure('sourceFindings')]; }),
    `${issue(4)} affects "projects.json:projects", which names "projects.json".`],
  ['an affects path in the stored report that does not resolve', issuesOf((k) => { k[6].affects[2] = `${REPORT}:projects.*.ratio`; }),
    `${issue(6)} affects "${REPORT}:projects.*.ratio", which is not a field of ${REPORT}`],
  ['a direction outside the three', issuesOf((k) => { k[0].direction = 'up'; }), `${issue(0)}.direction is "up", which tells a reader nothing`],
  ['the ratio entry missing while the report carries multiplier keys', issuesOf((k) => { k.splice(6, 1); }),
    `MANIFEST.json: knownIssues has no stored-report-carries-ratio-fields entry, and ${REPORT} carries projects.*.multiplier, ` +
    'summary.overallMultiplier, summary.averageMultiplierPerProject.'],
  ['the ratio entry not naming a ratio the report carries', issuesOf((k) => { k[6].affects.pop(); }),
    `${issue(6)}.affects does not name ${REPORT}:projects.*.multiplier, a ratio the stored report carries`],
  ['the ratio entry with a size', issuesOf((k) => { k[6].magnitude = { value: 1, of: 3, unit: 'fields' }; }),
    `${issue(6)}.magnitude is {"value":1,"of":3,"unit":"fields"}. A ratio field is not counted, so it is null.`],
  ['the own-package entry one below its count', issuesOf((k) => { k[5].magnitude.value = 0; }),
    `${issue(5)}.magnitude.value is 0; counted from the stored report it is 1 of 2`],
  ['the no-location entry one above its count', issuesOf((k) => { k[4].magnitude.value = 8; }),
    `${issue(4)}.magnitude.value is 8; counted from the stored report it is 7 of 8`],
  ['the no-location entry with no size', issuesOf((k) => { k[4].magnitude = null; }),
    `${issue(4)}.magnitude is null. Its size is counted from the stored report: 7 of 8.`],
  ['the raw output entry one below its count', issuesOf((k) => { k[2].magnitude.value = 2; }),
    `${issue(2)}.magnitude.value is 2; counted from the stored report it is 3 of 3`],
  ['the raw output entry not naming a figure', issuesOf((k) => { k[2].affects = EVERY_FIGURE.slice(1); }),
    `${issue(2)}.affects does not name comparison.json:figures.dependencyMatches, which the issue bears on`],
  ['a defect listed twice', issuesOf((k) => { k.push({ ...k[0] }); }), `${issue(7)} repeats the defect source-findings-not-reviewed-by-a-human.`],
];
for (const [what, change, line] of ISSUE_DEFECTS) {
  test(`T8 knownIssues with ${what} is refused`, async () => refusedHere(await validateOne(change), line));
}

// --- T9: .zenodo.json --------------------------------------------------------------------

test('T9 a release version naming a directory that is not here is refused', async () => {
  refused(await validate({ zenodo: (z) => { z.version = 'dataset-2026-09-29'; } }),
    '.zenodo.json: version is "dataset-2026-09-29", which is not dataset-<d> for a directory d under datasets/.');
});

test('T9 a release description that does not name a directory here is refused', async () => {
  refused(await validate({ zenodo: (z) => { z.description = `<code>datasets/${FIRST_SHAPE}</code>`; } }),
    `.zenodo.json: description does not name datasets/${NAME}.`);
});

test('T9 a release description that names a directory only inside the name of a longer one is refused', async () => {
  refused(await validate({ zenodo: (z) => { z.description = `<code>datasets/${FIRST_SHAPE}-deepscan-comparison</code> <code>datasets/${NAME}</code>`; } }),
    `.zenodo.json: description does not name datasets/${FIRST_SHAPE}.`);
});

test('T9 a release version naming the comparison passes', async () => {
  const result = await validate({ zenodo: (z) => { z.version = `dataset-${NAME}`; } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`${RECOUNT_LINE}\n`), result.stdout);
});

test('T9 .zenodo.json is not read when one dataset is named', async () => {
  const result = await validate({ args: [NAME], zenodo: (z) => { z.version = 'dataset-2026-09-29'; } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`${RECOUNT_LINE}\n`), result.stdout);
});

// --- T10: errata for a comparison ------------------------------------------------------------

const comparisonErrata = (dataset = NAME, fields = {}) => ({
  schemaVersion: 3,
  kind: 'comparisonErrata',
  dataset,
  doi: '10.5555/example.comparison',
  issuedAt: '2026-10-02',
  issues: [{
    defect: 'example-comparison-issue', summary: 'An example issue, for the tests.',
    affects: [figure('sourceFindings'), `${REPORT}:projects.*.deepScan.sourceAlgorithms`], direction: 'unknown', magnitude: null,
    correctedIn: 'Not corrected.', issuedAt: '2026-10-02', ...fields,
  }],
});
const censusErrata = (dataset, affects) => ({
  schemaVersion: 2,
  kind: 'censusErrata',
  dataset,
  doi: '10.5555/example.errata',
  issuedAt: '2026-10-02',
  issues: [{
    defect: 'example-census-issue', summary: 'An example issue, for the tests.', affects, direction: 'unknown', magnitude: null,
    correctedIn: 'Not corrected.', issuedAt: '2026-10-02',
  }],
});
const ERRATA = `${NAME}.json`;
const errataLine = (text) => `errata/${ERRATA}: ${text}`;

test('T10 a comparison\'s errata file named for its whole name passes', async () => {
  const result = await validate({ errata: { [ERRATA]: comparisonErrata() } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`1 errata file(s) validated: ${ERRATA}\n`), result.stdout);
});

test('T10 a comparison\'s errata file with kind censusErrata is refused', async () => {
  refused(await validate({ errata: { [ERRATA]: { ...comparisonErrata(), kind: 'censusErrata' } } }), errataLine('kind is "censusErrata", not "comparisonErrata"'));
});

test('T10 a comparison\'s errata file whose dataset is not its name is refused', async () => {
  refused(await validate({ errata: { [ERRATA]: comparisonErrata(DATE) } }), errataLine(`dataset is "${DATE}", and the file is named for ${NAME}`));
});

for (const [what, affects, problem] of [
  ['in another file', 'projects.json:projects', 'which names "projects.json".'],
  ['with no file, as a census path', 'byEcosystem', 'which names no file.'],
  ['that does not resolve', figure('nothing'), 'which is not a field of comparison.json'],
]) {
  test(`T10 a comparison's errata issue with an affects path ${what} is refused`, async () => {
    refused(await validate({ errata: { [ERRATA]: comparisonErrata(NAME, { affects: [affects] }) } }),
      errataLine(`issue 1 (example-comparison-issue) affects ${affects}, ${problem}`));
  });
}

test('T10 a comparison\'s errata issue with an affects path that names no file is refused where the comparison\'s files cannot be read', async () => {
  const result = await validate({
    errata: { [ERRATA]: comparisonErrata(NAME, { affects: ['figures.sourceFindings'] }) },
    prepare: (dir) => unlinkSync(inComparison(dir, 'comparison.json')),
  });
  refused(result, errataLine(`cannot be checked against datasets/${NAME}: its comparison.json and ${REPORT} could not be read`));
  refused(result, errataLine('issue 1 (example-comparison-issue) affects figures.sourceFindings, which names no file.'));
});

test('T10 a comparison\'s errata file in version 2 is refused', async () => {
  refused(await validate({ errata: { [ERRATA]: { ...comparisonErrata(), schemaVersion: 2 } } }), errataLine('schemaVersion is 2; the rules here are for version 3'));
});

test('T10 a comparison\'s errata file with regenerations is refused', async () => {
  refused(await validate({ errata: { [ERRATA]: { ...comparisonErrata(), regenerations: [] } } }),
    errataLine('carries regenerations, which an errata file of a comparison does not define'));
});

const ONE_PROBLEM_WITH_ERRATA = /\n1 problem\(s\) across 2 dataset\(s\) and 1 errata file\(s\):/;

test('T10 a census errata file named for the comparison\'s date is not read as the comparison\'s, which passes', async () => {
  const result = await validate({ errata: { [`${DATE}.json`]: censusErrata(DATE, ['comparison.json:figures.sourceFindings']) } });
  refused(result, `errata/${DATE}.json: describes datasets/${DATE}, which is not a dataset in this repository`);
  assert.match(result.stderr, ONE_PROBLEM_WITH_ERRATA);
});

test('T10 a comparison\'s errata file named for a census dataset\'s date is not read as the census dataset\'s', async () => {
  const pinnedName = `${FIRST_SHAPE}-deepscan-comparison`;
  const result = await validate({ errata: { [`${pinnedName}.json`]: comparisonErrata(pinnedName) } });
  refused(result, `errata/${pinnedName}.json: describes datasets/${pinnedName}, which is not a dataset in this repository`);
  assert.match(result.stderr, ONE_PROBLEM_WITH_ERRATA);
});

test('T10 a census errata file naming a field of comparison.json is refused, and is the only problem beside a comparison that passes', async () => {
  const result = await validate({ errata: { [`${FIRST_SHAPE}.json`]: censusErrata(FIRST_SHAPE, ['comparison.json:figures.sourceFindings']) } });
  refused(result, `errata/${FIRST_SHAPE}.json: issue 1 (example-census-issue) affects comparison.json:figures.sourceFindings, which is not a ` +
    `field of the ${FIRST_SHAPE} aggregate`);
  assert.match(result.stderr, /\n1 problem\(s\) across 2 dataset\(s\) and 1 errata file\(s\):/);
});

// --- T11: the census does not read a comparison as an earlier census -------------------------------

test('T11 a version 2 census dataset whose comparability names a comparison that passes is refused for it', async () => {
  const census = '2026-10-01';
  const tree = { others: { [census]: censusV2(census, { comparability: [{ dataset: NAME, doi: null, comparable: false, reason: 'instrumentChanged', changes: ['matchRule'] }] }) } };
  const comparison = await validate({ ...tree, args: [NAME] });
  assert.equal(comparison.code, 0, comparison.stderr);
  refused(await validate(tree), `${census}: corpus-${census}.json: comparability[0] names "${NAME}", which is not a dataset of this repository ` +
    `collected before ${census}`);
});

test('T11 a version 2 census dataset is not asked to name a comparison collected before it', async () => {
  const census = '2026-10-01';
  const tree = { others: { [census]: censusV2(census, { comparability: [{ dataset: FIRST_SHAPE, doi: null, comparable: false, reason: 'instrumentChanged', changes: [] }] }) } };
  const comparison = await validate({ ...tree, args: [NAME] });
  assert.equal(comparison.code, 0, comparison.stderr);
  // The census fixture is refused on other counts; what is read here is that none of them is about the comparison.
  const result = await validate(tree);
  assert.equal(result.code, 1, result.stdout);
  assert.ok(result.stderr.includes(`\n  ${census}: corpus-${census}.json: comparability[0]`) || result.stderr.includes(`\n  ${census}: `), result.stderr);
  assert.ok(!result.stderr.includes(`comparability does not name ${NAME}`), result.stderr);
  assert.ok(!result.stderr.split('\n').some((line) => line.startsWith(`  ${NAME}: `)), result.stderr);
});

// --- T12: immutability ---------------------------------------------------------------------

/** git with no configuration but its own defaults, and an identity that exists only here. */
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'check-validator-comparison',
  GIT_AUTHOR_EMAIL: 'check-validator-comparison@example.invalid',
  GIT_COMMITTER_NAME: 'check-validator-comparison',
  GIT_COMMITTER_EMAIL: 'check-validator-comparison@example.invalid',
};

/**
 * Publish a tree in one commit of a temporary repository and apply `change`
 * in a second. Returns the copy of the validator's run over each commit's
 * tree, and this repository's immutability check run with the first commit as
 * its base.
 */
async function afterPublication(published, change) {
  const dir = mkdtempSync(join(tmpdir(), 'census-v3-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (message) => {
    git('add', '--', ...['datasets', 'errata'].filter((path) => existsSync(join(dir, path))));
    git('commit', '--quiet', '--allow-empty', '--message', message);
  };
  try {
    git('init', '--quiet', '--initial-branch=work');
    writeTree(dir, { zenodo: false, ...published });
    const before = await run([join(dir, 'scripts', 'validate-dataset.mjs')], { env: {} });
    commit('published');
    git('branch', 'published');
    change(dir, git);
    commit('change');
    const after = await run([join(dir, 'scripts', 'validate-dataset.mjs')], { env: {} });
    const afterComparison = await run([join(dir, 'scripts', 'validate-dataset.mjs'), NAME], { env: {} });
    const immutable = await run([join(ROOT, 'scripts', 'check-immutable.mjs'), 'published'], { cwd: dir, env: GIT_ENV });
    return { before, after, afterComparison, immutable };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The published tree passed the validator: the premise of every test below. */
const publishedPassed = ({ before }) => assert.equal(before.code, 0, `the published tree is refused:\n${before.stderr}`);
const rewrites = (result, line) => {
  publishedPassed(result);
  assert.equal(result.immutable.code, 1, `expected a refusal, got:\n${result.immutable.stdout}${result.immutable.stderr}`);
  assert.ok(result.immutable.stderr.split('\n').includes(`  ${line}`), `expected the line\n  ${line}\nin:\n${result.immutable.stderr}`);
};
const accepted = (result, protectedCount) => {
  publishedPassed(result);
  assert.equal(result.immutable.code, 0, result.immutable.stderr);
  assert.ok(result.immutable.stdout.includes(`No published dataset was modified (${protectedCount} protected).`), result.immutable.stdout);
  assert.equal(result.after.code, 0, `the changed tree is refused:\n${result.after.stderr}`);
};
const CENSUS_ONLY = { comparisons: {} };
const addComparison = (dir) => writeTree(dir, { zenodo: false });

test('T12 a file of a published comparison changed is refused', async () => {
  rewrites(await afterPublication({}, (dir) => writeFileSync(inComparison(dir, 'comparison.json'), json(comparisonFile('changed')))),
    `modified datasets/${NAME}/comparison.json`);
});

test('T12 a file added to datasets/2026-03-18/ beside a published comparison is refused', async () => {
  rewrites(await afterPublication({}, (dir) => writeFileSync(join(dir, 'datasets', FIRST_SHAPE, 'extra.json'), '{}\n')),
    `added a file to datasets/${FIRST_SHAPE}/extra.json`);
});

test('T12 a second comparison added beside a published one is accepted, and both pass', async () => {
  const result = await afterPublication({}, (dir) => writeTree(dir, { zenodo: false, comparisons: { [LATER]: [namesEarlier(), '2026-10-15'] } }));
  accepted(result, 2);
  assert.ok(result.after.stdout.includes(RECOUNT_LINE.replace(NAME, LATER)), result.after.stdout);
});

test('T12 a comparison added new beside the published census is accepted', async () => {
  accepted(await afterPublication(CENSUS_ONLY, addComparison), 1);
});

test('T12 a comparison added with one byte changed in the published census manifest is refused for the census alone', async () => {
  const result = await afterPublication(CENSUS_ONLY, (dir) => {
    addComparison(dir);
    const path = join(dir, 'datasets', FIRST_SHAPE, 'MANIFEST.json');
    writeFileSync(path, `${readFileSync(path, 'utf-8')} `);
  });
  rewrites(result, `modified datasets/${FIRST_SHAPE}/MANIFEST.json`);
  assert.ok(!result.immutable.stderr.includes(`datasets/${NAME}`), result.immutable.stderr);
  assert.equal(result.afterComparison.code, 0, `the comparison added is refused:\n${result.afterComparison.stderr}`);
});

test('T12 one byte changed in a published comparison\'s manifest is refused', async () => {
  rewrites(await afterPublication({}, (dir) => {
    const path = inComparison(dir, 'MANIFEST.json');
    writeFileSync(path, `${readFileSync(path, 'utf-8')} `);
  }), `modified datasets/${NAME}/MANIFEST.json`);
});

test('T12 a comparison added with a link in it is refused by both checks', async () => {
  const result = await afterPublication(CENSUS_ONLY, (dir) => {
    addComparison(dir);
    unlinkSync(inComparison(dir, 'README.md'));
    symlinkSync(join('..', FIRST_SHAPE, 'MANIFEST.json'), inComparison(dir, 'README.md'));
  });
  rewrites(result, `datasets/${NAME}/README.md is not a regular file`);
  refused(result.after, `${NAME}: README.md is a link.`);
});

test('T12 a file of the published census moved into a comparison added new is refused by both checks', async () => {
  const result = await afterPublication(CENSUS_ONLY, (dir) => {
    addComparison(dir);
    renameSync(join(dir, 'datasets', FIRST_SHAPE, `corpus-${FIRST_SHAPE}.json`), inComparison(dir, `corpus-${FIRST_SHAPE}.json`));
  });
  rewrites(result, `renamed datasets/${FIRST_SHAPE}/corpus-${FIRST_SHAPE}.json`);
  refused(result.afterComparison, `${NAME}: present but not listed in MANIFEST.json: "corpus-${FIRST_SHAPE}.json".`);
});

test('T12 an issue of a published comparison\'s errata file reworded is refused', async () => {
  rewrites(await afterPublication({ errata: { [ERRATA]: comparisonErrata() } }, (dir) => {
    writeFileSync(join(dir, 'errata', ERRATA), json(comparisonErrata(NAME, { summary: 'Reworded.' })));
  }), `issue 1 (example-comparison-issue) of errata/${ERRATA} is no longer what was published`);
});

test('T12 an issue appended to a published comparison\'s errata file is accepted', async () => {
  const result = await afterPublication({ errata: { [ERRATA]: comparisonErrata() } }, (dir) => {
    const errata = comparisonErrata();
    errata.issues.push({ ...errata.issues[0], defect: 'example-later-issue', issuedAt: '2026-10-03' });
    writeFileSync(join(dir, 'errata', ERRATA), json(errata));
  });
  accepted(result, 2);
  assert.ok(result.immutable.stdout.includes('No published errata issue was changed (1 file(s) protected).'), result.immutable.stdout);
});
