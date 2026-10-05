#!/usr/bin/env node
/**
 * Validate every published dataset in this repository.
 *
 * A dataset here is meant to be citable: linked from a conference submission and
 * deposited to Zenodo for a DOI. That only means something if the bytes behind
 * the citation are the bytes that were measured, and if a reader can tell a
 * complete dataset from a partial one without re-deriving it.
 *
 * So this checks the things a citation depends on:
 *
 *   - every file the manifest lists exists and hashes to what the manifest says
 *   - every file present is listed, so nothing arrives unaccounted for
 *   - the aggregate and the raw files describe the same run
 *   - a dataset says which kind it is, and meets that kind's requirements
 *   - an errata file names a dataset that is here, and figures that are in it
 *
 * Usage:
 *   node scripts/validate-dataset.mjs            # every dataset and every errata file
 *   node scripts/validate-dataset.mjs 2026-07-29 # one dataset, and its errata file if it has one
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS = join(ROOT, 'datasets');
const ERRATA = join(ROOT, 'errata');

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * The kinds of dataset this repository publishes.
 *
 * An unrecognised kind is a failure rather than a default-allow. A dataset whose
 * kind is unknown is one no rule below applies to, which is indistinguishable
 * from a dataset that passed.
 */
const KINDS = {
  'raw+aggregate': {
    description: 'Per-package scan output for every ecosystem, plus the aggregate computed from it.',
    requiresRaw: true,
    requiresProvenance: true,
  },
  'aggregate-only': {
    description: 'The aggregate alone. Used where the raw per-package output does not exist.',
    requiresRaw: false,
    requiresProvenance: false,
  },
};

/**
 * Datasets published in the first file shape, whose manifest carries no
 * `schemaVersion`.
 *
 * That shape is accepted for these directories and for no others. A dataset
 * added under a new date has to declare its version, so files in the first
 * shape cannot be published as a new measurement. This script has no rules for
 * a declared version yet, so a dataset that declares one is refused rather than
 * passed unchecked.
 */
const FIRST_SHAPE_DATASETS = ['2026-03-18', '2026-08-03'];

/** The three ways a figure can be off: for a row's knownIssue and for an errata issue alike. */
const DIRECTIONS = ['understates', 'overstates', 'unknown'];

/**
 * An errata file: what has been learnt about a dataset since it was published.
 *
 * A published dataset is never rewritten (scripts/check-immutable.mjs), so a
 * figure found to be wrong cannot be corrected, or even labelled, where it
 * sits. The finding is published beside the datasets instead, in
 * errata/<date>.json, named for the dataset it describes.
 *
 * The lists are closed. A field this script has no rule for is one no reader
 * has a definition of, and a misspelt field would otherwise read as an absent
 * one.
 */
const ERRATA_FIELDS = ['schemaVersion', 'kind', 'dataset', 'doi', 'issuedAt', 'issues'];
const ISSUE_FIELDS = ['defect', 'summary', 'affects', 'direction', 'magnitude', 'correctedIn', 'issuedAt'];
const MAGNITUDE_FIELDS = ['value', 'of', 'unit'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const unknownFields = (object, fields) => Object.keys(object).filter((k) => !fields.includes(k));

/** A date that exists: 2026-02-31 has the right shape and is not one. */
function isCalendarDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const time = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === v;
}

/**
 * Follow a dotted path through own properties only, so that `constructor` and
 * its kind resolve to nothing instead of to something every object has.
 */
function resolvePath(root, path) {
  let at = root;
  for (const key of path.split('.')) {
    if (!isObject(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

const problems = [];
const fail = (dataset, message) => problems.push(`${dataset}: ${message}`);

function validate(name) {
  const dir = join(DATASETS, name);
  const manifestPath = join(dir, 'MANIFEST.json');

  if (!existsSync(manifestPath)) {
    fail(name, 'no MANIFEST.json. A directory of JSON files with nothing describing them is not a dataset.');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    fail(name, `MANIFEST.json does not parse: ${err.message}`);
    return;
  }

  // Checked before anything else: every rule below is written for the first
  // file shape and says nothing about a dataset in another one.
  if (manifest.schemaVersion !== undefined) {
    fail(name, `schemaVersion is ${JSON.stringify(manifest.schemaVersion)}. This script has no rules for a ` +
      'declared version yet, and a dataset it cannot check is not one it can pass.');
    return;
  }
  if (!FIRST_SHAPE_DATASETS.includes(name)) {
    fail(name, 'MANIFEST.json declares no schemaVersion. The first file shape is accepted only for ' +
      `${FIRST_SHAPE_DATASETS.join(' and ')}; a new dataset has to declare its version.`);
    return;
  }

  const kind = KINDS[manifest.kind];
  if (!kind) {
    fail(name, `kind is ${JSON.stringify(manifest.kind)}, which is not one of: ${Object.keys(KINDS).join(', ')}`);
    return;
  }

  if (manifest.license !== 'CC-BY-4.0') {
    fail(name, `license is ${JSON.stringify(manifest.license)}; published datasets here are CC-BY-4.0`);
  }

  // --- Every listed file exists and hashes to what was recorded ------------
  const listed = new Set();
  const entries = [
    ...(manifest.corpus ? [manifest.corpus] : []),
    ...(manifest.ecosystems ?? []),
  ];

  for (const entry of entries) {
    if (!entry.file) {
      fail(name, 'a manifest entry names no file');
      continue;
    }
    listed.add(entry.file);
    const path = join(dir, entry.file);
    if (!existsSync(path)) {
      fail(name, `${entry.file} is listed in MANIFEST.json but is not in the dataset`);
      continue;
    }
    if (!entry.sha256) {
      fail(name, `${entry.file} carries no sha256, so nothing about it can be verified after transit`);
      continue;
    }
    const actual = sha256(path);
    if (actual !== entry.sha256) {
      fail(name, `${entry.file} does not match its recorded hash\n    recorded ${entry.sha256}\n    actual   ${actual}`);
    }
    if (typeof entry.bytes === 'number' && entry.bytes !== statSync(path).size) {
      fail(name, `${entry.file} is ${statSync(path).size} bytes, manifest says ${entry.bytes}`);
    }
  }

  // --- Nothing arrives unaccounted for ------------------------------------
  const present = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json');
  const strays = present.filter((f) => !listed.has(f));
  if (strays.length > 0) {
    fail(name, `present but not listed in MANIFEST.json: ${strays.join(', ')}. ` +
      'An unlisted file is one no reader can attribute and no hash covers.');
  }

  // --- Kind-specific requirements -----------------------------------------
  const rawCount = (manifest.ecosystems ?? []).length;

  if (kind.requiresRaw && rawCount === 0) {
    fail(name, `kind is ${manifest.kind} but the dataset carries no per-ecosystem files`);
  }
  if (!kind.requiresRaw && rawCount > 0) {
    fail(name, `kind is ${manifest.kind} but the dataset carries ${rawCount} per-ecosystem files. ` +
      'Publish it as raw+aggregate.');
  }

  // A partial run must say it is partial.
  //
  // The scan workflow cannot publish one -- its aggregate step depends on every
  // ecosystem scan succeeding, so a failed or cancelled scan stops the run
  // before anything is produced. This covers the path that does not go through
  // the workflow: a dataset committed by hand, where a missing ecosystem is
  // invisible in every total and reads as a fall in adoption rather than as an
  // absent measurement.
  if (kind.requiresRaw && manifest.complete !== true && !manifest.partialReason) {
    fail(name, `complete is ${JSON.stringify(manifest.complete)} and no partialReason is given. ` +
      `The dataset covers ${manifest.ecosystemCount} ecosystem(s); a reader comparing its total ` +
      'against a previous dataset would read the missing ones as a drop rather than as a gap.');
  }

  if (kind.requiresProvenance) {
    for (const field of ['sourceRepository', 'sourceCommit', 'workflowRun']) {
      if (!manifest.provenance?.[field]) {
        fail(name, `provenance.${field} is missing. A published dataset that cannot say which run ` +
          'produced it cannot be reproduced or challenged.');
      }
    }
  } else if (!manifest.provenanceNote) {
    fail(name, 'carries no provenance and no provenanceNote explaining why. ' +
      'Absent provenance has to be stated, not left blank.');
  }

  if (!manifest.corpus) {
    fail(name, 'carries no aggregate. The corpus is what every published share is computed from.');
    return;
  }

  // --- The aggregate and the raw files describe the same run --------------
  const corpusPath = join(dir, manifest.corpus.file);
  if (!existsSync(corpusPath)) return;
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));

  const byEco = corpus.byEcosystem ?? {};
  const sum = (f) => Object.values(byEco).reduce((s, e) => s + (e[f] || 0), 0);
  if (sum('scanned') !== corpus.packagesScanned) {
    fail(name, `the aggregate does not add up: per-ecosystem scanned sums to ` +
      `${sum('scanned').toLocaleString('en-US')}, packagesScanned says ` +
      `${corpus.packagesScanned.toLocaleString('en-US')}`);
  }

  if (rawCount > 0) {
    const rawTotal = manifest.ecosystems.reduce((s, e) => s + (e.totalScanned || 0), 0);
    if (rawTotal !== corpus.packagesScanned) {
      fail(name, `the aggregate describes a different run than the raw files beside it: ` +
        `raw files sum to ${rawTotal.toLocaleString('en-US')}, the aggregate reports ` +
        `${corpus.packagesScanned.toLocaleString('en-US')}`);
    }
  }

  // --- A row known to be wrong says so, in a form a reader can use --------
  for (const [eco, row] of Object.entries(byEco)) {
    if (!row.knownIssue) continue;
    for (const field of ['defect', 'summary', 'affects', 'direction', 'correctedIn']) {
      if (!row.knownIssue[field]) fail(name, `${eco}.knownIssue is missing ${field}`);
    }
    if (!DIRECTIONS.includes(row.knownIssue.direction)) {
      fail(name, `${eco}.knownIssue.direction is ${JSON.stringify(row.knownIssue.direction)}, ` +
        'which tells a reader nothing about which way to read the figure');
    }
  }
}

/**
 * Validate one file of errata/.
 *
 * An errata file is only useful if a reader can act on it. So each issue has
 * to say which figures it bears on, which way they are off, by how much where
 * that was measured, and where the correction will appear. An issue that names
 * a figure the dataset does not contain describes nothing, and fails.
 */
function validateErrata(file) {
  const label = `errata/${file}`;

  const named = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
  if (!named) {
    fail(label, 'is not named <dataset date>.json. Everything in errata/ is the errata file of one dataset.');
    return;
  }
  const date = named[1];

  let text;
  let errata;
  try {
    text = readFileSync(join(ERRATA, file), 'utf-8');
    errata = JSON.parse(text);
  } catch (err) {
    fail(label, `does not parse: ${err.message}`);
    return;
  }
  if (!isObject(errata)) {
    fail(label, 'is not a JSON object');
    return;
  }

  // One spelling of a file. A JSON parser keeps the last of two keys with the
  // same name and says nothing, so a file edited by hand can hold a second
  // `summary` that no check ever reads. A file that is exactly what a
  // serialiser writes cannot.
  if (text !== `${JSON.stringify(errata, null, 2)}\n`) {
    fail(label, 'is not in its canonical form: two-space JSON as JSON.stringify writes it, ending in one ' +
      'newline. Anything else can hide a repeated key from every check here.');
  }

  const extra = unknownFields(errata, ERRATA_FIELDS);
  if (extra.length > 0) {
    fail(label, `carries ${extra.join(', ')}, which an errata file does not define`);
  }
  if (errata.schemaVersion !== 2) {
    fail(label, `schemaVersion is ${JSON.stringify(errata.schemaVersion)}; the rules here are for version 2`);
  }
  if (errata.kind !== 'censusErrata') {
    fail(label, `kind is ${JSON.stringify(errata.kind)}, not "censusErrata"`);
  }
  if (errata.dataset !== date) {
    fail(label, `dataset is ${JSON.stringify(errata.dataset)}, and the file is named for ${date}`);
  }
  if (typeof errata.doi !== 'string' || !/^10\.\d{4,9}\/\S+$/.test(errata.doi)) {
    fail(label, `doi is ${JSON.stringify(errata.doi)}. An errata file gives the DOI of the dataset it ` +
      'describes, so a reader holding the citation can tell the two belong together.');
  }
  if (!isCalendarDate(errata.issuedAt)) {
    fail(label, `issuedAt is ${JSON.stringify(errata.issuedAt)}, not a YYYY-MM-DD date. ` +
      'An errata file with no date of issue is a draft.');
  } else if (errata.issuedAt < date) {
    fail(label, `issuedAt is ${errata.issuedAt}, before the dataset it describes was collected`);
  }

  // The figures an issue names are looked up in the dataset's own aggregate.
  let corpus;
  const manifestPath = join(DATASETS, date, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    fail(label, `describes datasets/${date}, which is not a dataset in this repository`);
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      corpus = JSON.parse(readFileSync(join(DATASETS, date, manifest.corpus.file), 'utf-8'));
    } catch {
      // What is wrong with the dataset is reported by its own validation.
      fail(label, `cannot be checked against datasets/${date}: its aggregate could not be read`);
    }
  }

  if (!Array.isArray(errata.issues) || errata.issues.length === 0) {
    fail(label, 'lists no issues. An errata file with nothing in it reads as a dataset checked and cleared.');
    return;
  }

  // Each issue carries the date it was added. One date for the file would
  // backdate every issue added later. The file's own date is that of its
  // first issue, and the dates never run backwards.
  const fileIssued = isCalendarDate(errata.issuedAt) ? errata.issuedAt : null;
  let previousIssued = null;

  const defects = new Set();
  errata.issues.forEach((issue, index) => {
    const at = `issue ${index + 1}`;
    if (!isObject(issue)) {
      fail(label, `${at} is not an object`);
      return;
    }
    const where = isText(issue.defect) ? `${at} (${issue.defect})` : at;

    const undefinedHere = unknownFields(issue, ISSUE_FIELDS);
    if (undefinedHere.length > 0) {
      fail(label, `${where} carries ${undefinedHere.join(', ')}, which an issue does not define`);
    }

    for (const field of ['defect', 'summary', 'correctedIn']) {
      if (!isText(issue[field])) fail(label, `${where} is missing ${field}`);
    }
    if (isText(issue.defect)) {
      if (defects.has(issue.defect)) {
        fail(label, `${where} repeats a defect already listed. A reader citing it could mean either.`);
      }
      defects.add(issue.defect);
    }

    if (!DIRECTIONS.includes(issue.direction)) {
      fail(label, `${where} has direction ${JSON.stringify(issue.direction)}, ` +
        'which tells a reader nothing about which way to read the figure');
    }

    if (!isCalendarDate(issue.issuedAt)) {
      fail(label, `${where} has issuedAt ${JSON.stringify(issue.issuedAt)}, not a YYYY-MM-DD date. ` +
        'An issue with no date of issue is a draft.');
    } else {
      if (issue.issuedAt < date) {
        fail(label, `${where} has issuedAt ${issue.issuedAt}, before the dataset it describes was collected`);
      }
      if (previousIssued !== null && issue.issuedAt < previousIssued) {
        fail(label, `${where} has issuedAt ${issue.issuedAt}, earlier than the issue before it (${previousIssued}). ` +
          'Issues are listed in the order they were added.');
      }
      if (index === 0 && fileIssued !== null && issue.issuedAt !== fileIssued) {
        fail(label, `issuedAt is ${fileIssued} and its first issue has ${issue.issuedAt}. ` +
          "The file's date of issue is the date of its first issue.");
      }
      previousIssued = issue.issuedAt;
    }

    if (!Array.isArray(issue.affects) || issue.affects.length === 0) {
      fail(label, `${where} names no figure in affects`);
    } else {
      const figures = new Set();
      for (const path of issue.affects) {
        if (!isText(path)) {
          fail(label, `${where} has an entry in affects that is not a field path`);
          continue;
        }
        if (figures.has(path)) fail(label, `${where} names ${path} twice in affects`);
        figures.add(path);
        if (corpus !== undefined && resolvePath(corpus, path) === undefined) {
          fail(label, `${where} affects ${path}, which is not a field of the ${date} aggregate`);
        }
      }
    }

    if (!Object.hasOwn(issue, 'magnitude')) {
      fail(label, `${where} is missing magnitude. Where the size was not measured it is null, ` +
        'stated rather than left out.');
    } else if (issue.magnitude !== null) {
      const m = issue.magnitude;
      if (!isObject(m) || unknownFields(m, MAGNITUDE_FIELDS).length > 0 ||
          !MAGNITUDE_FIELDS.every((k) => Object.hasOwn(m, k))) {
        fail(label, `${where} has a magnitude that is not { value, of, unit } or null`);
      } else {
        // Whole numbers: a magnitude counts things, and 0.5 of 1 would pass as a share.
        const valueOk = Number.isInteger(m.value) && m.value >= 0;
        const ofOk = Number.isInteger(m.of) && m.of > 0;
        if (!valueOk) fail(label, `${where} has magnitude.value ${JSON.stringify(m.value)}, not a whole count`);
        if (!ofOk) fail(label, `${where} has magnitude.of ${JSON.stringify(m.of)}, not a whole count above zero`);
        if (valueOk && ofOk && m.value > m.of) {
          fail(label, `${where} has a magnitude of ${m.value} of ${m.of}: more than the whole it is counted in`);
        }
        if (!isText(m.unit)) fail(label, `${where} has no magnitude.unit, so its numbers count nothing a reader can name`);
      }
    }
  });
}

// ---------------------------------------------------------------------------

if (!existsSync(DATASETS)) {
  process.stderr.write('No datasets/ directory.\n');
  process.exit(2);
}

const requested = process.argv[2];
const all = readdirSync(DATASETS).filter((f) => statSync(join(DATASETS, f)).isDirectory());
const names = requested ? [requested] : all;

if (requested && !all.includes(requested)) {
  process.stderr.write(`No dataset datasets/${requested}\n`);
  process.exit(2);
}

// With no dataset named, every entry of errata/ is read, whatever it is
// called: a file passed over for its name is a file nothing has checked. With
// one dataset named, only that dataset's errata file is read.
let allErrata = [];
if (existsSync(ERRATA)) {
  if (statSync(ERRATA).isDirectory()) allErrata = readdirSync(ERRATA).sort();
  else fail('errata', 'is not a directory');
}
const errataFiles = requested ? allErrata.filter((f) => f === `${requested}.json`) : allErrata;

// An empty repository is a valid state (nothing published yet), but a run that
// validated nothing must say so rather than print a checkmark.
if (names.length === 0 && errataFiles.length === 0 && problems.length === 0) {
  process.stdout.write('No datasets published yet. Nothing to validate.\n');
  process.exit(0);
}

for (const name of names) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) {
    fail(name, 'directory name is not a YYYY-MM-DD collection date');
    continue;
  }
  validate(name);
}

for (const file of errataFiles) validateErrata(file);

const checked = `${names.length} dataset(s)` +
  (errataFiles.length > 0 ? ` and ${errataFiles.length} errata file(s)` : '');

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem(s) across ${checked}:\n\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`${names.length} dataset(s) validated: ${names.join(', ')}\n`);
if (errataFiles.length > 0) {
  process.stdout.write(`${errataFiles.length} errata file(s) validated: ${errataFiles.join(', ')}\n`);
}
