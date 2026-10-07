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
 * A dataset in schema version 2 is held to the rules of that version, in the
 * section "Schema version 2" below.
 *
 * Usage:
 *   node scripts/validate-dataset.mjs            # every dataset and every errata file
 *   node scripts/validate-dataset.mjs 2026-07-29 # one dataset, and its errata file if it has one
 */

import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

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
 * shape cannot be published as a new measurement. A dataset that declares
 * schemaVersion 2 is held to the version 2 rules, under any other name; one
 * that declares anything else is refused rather than passed unchecked.
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
const ERRATA_FIELDS = ['schemaVersion', 'kind', 'dataset', 'doi', 'issuedAt', 'issues', 'regenerations'];
const ISSUE_FIELDS = ['defect', 'summary', 'affects', 'direction', 'magnitude', 'correctedIn', 'issuedAt'];
const MAGNITUDE_FIELDS = ['value', 'of', 'unit'];

/**
 * A regeneration: the record that a published dataset's files were written
 * again after the run its manifest names. It is a fact about bytes, with no
 * figure, direction or magnitude, so it is not an issue: an errata file lists
 * regenerations apart, under `regenerations`, and that list only grows too.
 * Where nothing was regenerated the key is left out.
 */
const REGENERATION_FIELDS = ['issuedAt', 'namedRun', 'runOutputSha256', 'writtenBy', 'beforeSteps', 'summary'];
const WRITTEN_BY_FIELDS = ['repository', 'pullRequest', 'commit'];
const BEFORE_STEPS_FIELDS = ['fields', 'ecosystems'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * Text a reader can see: at least one letter or digit, and no control or
 * format character. A zero-width space is not a summary, and a direction
 * override can make a sentence display as a different one.
 */
const hasWords = (v) => typeof v === 'string' && /[\p{L}\p{N}]/u.test(v);
const hasHiddenCharacters = (v) => /[\p{Cc}\p{Cf}]/u.test(v);
const isText = (v) => hasWords(v) && !hasHiddenCharacters(v);

/** Read a file as UTF-8 and refuse bytes that are not: a decoder that substitutes a character hides the difference. */
const readStrict = (path) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));

/** The day this run happens on, in UTC. A date of issue cannot be later. */
const TODAY = new Date().toISOString().slice(0, 10);
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
/** What a reader should know and no rule refuses. Listed beside the result of every run, problems or none. */
const notes = [];
const note = (dataset, message) => notes.push(`${dataset}: ${message}`);

/**
 * A name a manifest gives a file is read only as the name of a file in the
 * dataset's own directory: no separator, not a step up or in place, and no
 * control or format character. A path would have these checks read, and
 * report on, a file outside it; a name with a line break in it would print
 * as two lines, the second of which the name chose.
 */
const isFileName = (name) => typeof name === 'string' && /^[^/\\]+$/.test(name) && !hasHiddenCharacters(name) && name !== '..' && name !== '.';

function validate(name) {
  const dir = join(DATASETS, name);
  const manifestPath = join(dir, 'MANIFEST.json');

  if (!existsSync(manifestPath)) {
    fail(name, 'no MANIFEST.json. A directory of JSON files with nothing describing them is not a dataset.');
    return;
  }
  // Only a regular file of bounded size is read. A link to a device or a pipe
  // would never finish reading, and any link keeps its text where the
  // immutability check does not look.
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile()) {
    fail(name, 'MANIFEST.json is not a regular file. A link would keep the text these checks read somewhere the immutability check does not look.');
    return;
  }
  if (manifestStat.size > MAX_FILE_BYTES) {
    fail(name, `MANIFEST.json is ${manifestStat.size.toLocaleString('en-US')} bytes, over the ${MAX_FILE_BYTES.toLocaleString('en-US')} a dataset file may hold`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    fail(name, `MANIFEST.json does not parse: ${err.message}`);
    return;
  }

  // Checked before anything else: the version a manifest declares decides
  // which rules run. Every rule below this block is written for the first file
  // shape, which declares none, and says nothing about a dataset in another.
  if (!isObject(manifest)) {
    fail(name, 'MANIFEST.json is not a JSON object, so it describes nothing.');
    return;
  }
  if (manifest.schemaVersion !== undefined) {
    if (manifest.schemaVersion !== 2) {
      fail(name, `schemaVersion is ${JSON.stringify(manifest.schemaVersion)}, which is not a version these rules know. A ` +
        'version 2 dataset declares the number 2 and a first-shape one declares none; any other version is refused, never ' +
        'read as the newest one known.');
    } else if (FIRST_SHAPE_DATASETS.includes(name)) {
      fail(name, `schemaVersion is 2, and ${name} is one of the datasets published in the first file shape, which declares ` +
        'no version. A version 2 manifest under that name is not the dataset that was published.');
    } else {
      validateVersion2(name, dir);
    }
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
    if (!isFileName(entry.file)) {
      fail(name, `a manifest entry names ${JSON.stringify(entry.file)}, which is not the name of a file in the dataset's own ` +
        'directory. A path would have these checks read a file outside it.');
      continue;
    }
    listed.add(entry.file);
    const path = join(dir, entry.file);
    if (!existsSync(path)) {
      fail(name, `${describe(entry.file)} is listed in MANIFEST.json but is not in the dataset`);
      continue;
    }
    if (!lstatSync(path).isFile()) {
      fail(name, `${entry.file} is not a regular file. A link would keep its bytes somewhere these checks and the immutability check do not look.`);
      continue;
    }
    if (!entry.sha256) {
      fail(name, `${describe(entry.file)} carries no sha256, so nothing about it can be verified after transit`);
      continue;
    }
    const actual = sha256(path);
    if (actual !== entry.sha256) {
      fail(name, `${describe(entry.file)} does not match its recorded hash\n    recorded ${describe(entry.sha256)}\n    actual   ${actual}`);
    }
    if (typeof entry.bytes === 'number' && entry.bytes !== statSync(path).size) {
      fail(name, `${describe(entry.file)} is ${statSync(path).size} bytes, manifest says ${entry.bytes}`);
    }
  }

  // --- Nothing arrives unaccounted for ------------------------------------
  const present = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json');
  const strays = present.filter((f) => !listed.has(f));
  if (strays.length > 0) {
    fail(name, `present but not listed in MANIFEST.json: ${strays.map(describe).join(', ')}. ` +
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
      `The dataset covers ${describe(manifest.ecosystemCount)} ecosystem(s); a reader comparing its total ` +
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
  if (!isFileName(manifest.corpus.file)) return;
  const corpusPath = join(dir, manifest.corpus.file);
  if (!existsSync(corpusPath) || !lstatSync(corpusPath).isFile()) return;
  let corpus;
  try {
    corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));
  } catch (err) {
    fail(name, `${manifest.corpus.file} does not parse: ${err.message}`);
    return;
  }
  if (!isObject(corpus)) {
    fail(name, `${manifest.corpus.file} is not a JSON object`);
    return;
  }

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
      if (!row.knownIssue[field]) fail(name, `${describe(eco)}.knownIssue is missing ${field}`);
    }
    if (!DIRECTIONS.includes(row.knownIssue.direction)) {
      fail(name, `${describe(eco)}.knownIssue.direction is ${JSON.stringify(row.knownIssue.direction)}, ` +
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

  // A regular file, and nothing else. A link would keep the text these checks
  // read somewhere the append-only check does not look, where it could be
  // rewritten without that check seeing a change.
  if (!lstatSync(join(ERRATA, file)).isFile()) {
    fail(label, 'is not a regular file. A link or a directory would keep the text somewhere the checks do not look.');
    return;
  }

  let text;
  let errata;
  try {
    text = readStrict(join(ERRATA, file));
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
  } else if (errata.issuedAt > TODAY) {
    fail(label, `issuedAt is ${errata.issuedAt}, after today (${TODAY})`);
  }

  // The figures an issue names are looked up in the dataset's own aggregate,
  // which its manifest names by the manifest's version: `corpus` in the first
  // file shape, the file listed with the role `corpus` in version 2.
  let corpus;
  let manifest;
  const manifestPath = join(DATASETS, date, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    fail(label, `describes datasets/${date}, which is not a dataset in this repository`);
  } else {
    try {
      manifest = readBounded(manifestPath);
      corpus = readBounded(join(DATASETS, date, datasetFile(manifest, 'corpus')));
    } catch {
      // What is wrong with the dataset is reported by its own validation.
      fail(label, `cannot be checked against datasets/${date}: its aggregate could not be read`);
    }
  }

  if (Object.hasOwn(errata, 'regenerations')) validateRegenerations(label, date, errata.regenerations, isObject(manifest) ? manifest : undefined);

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
      if (!hasWords(issue[field])) fail(label, `${where} is missing ${field}`);
      else if (hasHiddenCharacters(issue[field])) fail(label, `${where} has a control or format character in ${field}`);
    }
    if (isText(issue.defect)) {
      // An id is cited, so it has one spelling: "a-defect" and "a-defect " are
      // two strings and would be one id to every reader.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(issue.defect)) {
        fail(label, `${where} has a defect id that is not lower-case words joined by hyphens`);
      }
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
      // A date in the future would be accepted today and then refuse every
      // issue added before that day came, since dates do not run backwards
      // and a published issue cannot be corrected.
      if (issue.issuedAt > TODAY) {
        fail(label, `${where} has issuedAt ${issue.issuedAt}, after today (${TODAY})`);
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
        // Whole numbers a float holds exactly: a magnitude counts things. 0.5 of
        // 1 would pass as a share, and past 2^53 two different counts are one number.
        const valueOk = Number.isSafeInteger(m.value) && m.value >= 0;
        const ofOk = Number.isSafeInteger(m.of) && m.of > 0;
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

/**
 * The regenerations of an errata file. Each says which run's output the
 * published files were written from, what wrote them again, and which fields
 * of which files were written before steps that came later, so a reader
 * holding the manifest's run knows which of its bytes that run did not write.
 */
/**
 * The name of a file a manifest binds, by the manifest's version: the
 * aggregate (`corpus`) or one registry's raw file (`scan`). Undefined when the
 * manifest names none, or names it with a path rather than a file name.
 */
function datasetFile(manifest, role, ecosystem) {
  let entry;
  if (!Object.hasOwn(manifest, 'schemaVersion')) {
    entry = role === 'corpus' ? manifest.corpus
      : Array.isArray(manifest.ecosystems) ? manifest.ecosystems.find((e) => isObject(e) && e.ecosystem === ecosystem) : undefined;
  } else if (manifest.schemaVersion === 2 && Array.isArray(manifest.files)) {
    entry = manifest.files.find((f) => isObject(f) && f.role === role && (role === 'corpus' || f.ecosystem === ecosystem));
  }
  const file = isObject(entry) ? entry.file : undefined;
  return isFileName(file) ? file : undefined;
}

function validateRegenerations(label, date, list, manifest) {
  if (!Array.isArray(list) || list.length === 0) {
    fail(label, 'has regenerations that are not a list with a regeneration in it. Where nothing was regenerated the key is left out.');
    return;
  }
  const run = manifest && isObject(manifest.provenance) ? manifest.provenance.workflowRun : undefined;
  const rawFiles = new Map();
  /** The dataset's raw file for one registry, parsed, or the reason it cannot be read. */
  const rawFile = (ecosystem) => {
    if (rawFiles.has(ecosystem)) return rawFiles.get(ecosystem);
    let found;
    const file = isObject(manifest) ? datasetFile(manifest, 'scan', ecosystem) : undefined;
    if (file === undefined) {
      found = { problem: `has no raw file in datasets/${date}` };
    } else {
      try {
        found = { file, value: readBounded(join(DATASETS, date, file)) };
      } catch {
        found = { problem: `has a raw file, ${file}, that cannot be read` };
      }
    }
    rawFiles.set(ecosystem, found);
    return found;
  };
  let previousIssued = null;
  list.forEach((regeneration, index) => {
    const at = `regeneration ${index + 1}`;
    if (!isObject(regeneration)) {
      fail(label, `${at} is not an object`);
      return;
    }
    const undefinedHere = unknownFields(regeneration, REGENERATION_FIELDS);
    if (undefinedHere.length > 0) fail(label, `${at} carries ${undefinedHere.join(', ')}, which a regeneration does not define`);

    // The date of issue, under the rule an issue's date follows.
    if (!isCalendarDate(regeneration.issuedAt)) {
      fail(label, `${at} has issuedAt ${JSON.stringify(regeneration.issuedAt)}, not a YYYY-MM-DD date. A regeneration with no date of issue is a draft.`);
    } else {
      if (regeneration.issuedAt < date) {
        fail(label, `${at} has issuedAt ${regeneration.issuedAt}, before the dataset it describes was collected`);
      }
      if (regeneration.issuedAt > TODAY) {
        fail(label, `${at} has issuedAt ${regeneration.issuedAt}, after today (${TODAY})`);
      }
      if (previousIssued !== null && regeneration.issuedAt < previousIssued) {
        fail(label, `${at} has issuedAt ${regeneration.issuedAt}, earlier than the regeneration before it (${previousIssued}). ` +
          'Regenerations are listed in the order they were added.');
      }
      previousIssued = regeneration.issuedAt;
    }

    if (!isText(regeneration.namedRun)) {
      fail(label, `${at} has namedRun ${JSON.stringify(regeneration.namedRun)}, not the run the manifest names`);
    } else if (manifest !== undefined && regeneration.namedRun !== run) {
      fail(label, `${at} names the run ${regeneration.namedRun}, and datasets/${date}/MANIFEST.json names ${JSON.stringify(run ?? null)}. ` +
        'A regeneration qualifies the run the manifest names, so the two are one.');
    }
    if (typeof regeneration.runOutputSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(regeneration.runOutputSha256)) {
      fail(label, `${at} has runOutputSha256 ${JSON.stringify(regeneration.runOutputSha256)}, not a SHA-256 digest in lower-case hex`);
    }

    if (!Array.isArray(regeneration.writtenBy) || regeneration.writtenBy.length === 0) {
      fail(label, `${at} names nothing in writtenBy, so nothing says what wrote the files again`);
    } else {
      regeneration.writtenBy.forEach((change, number) => {
        const where = `${at}, writtenBy ${number + 1},`;
        if (!isObject(change) || unknownFields(change, WRITTEN_BY_FIELDS).length > 0 ||
            !WRITTEN_BY_FIELDS.every((field) => Object.hasOwn(change, field))) {
          fail(label, `${where} is not { repository, pullRequest, commit }`);
          return;
        }
        if (!isText(change.repository) || !/^[^/\s]+\/[^/\s]+$/.test(change.repository)) {
          fail(label, `${where} has repository ${JSON.stringify(change.repository)}, not owner/name`);
        }
        if (!Number.isSafeInteger(change.pullRequest) || change.pullRequest < 1) {
          fail(label, `${where} has pullRequest ${JSON.stringify(change.pullRequest)}, not a pull request number`);
        }
        if (typeof change.commit !== 'string' || !/^[0-9a-f]{40}$/.test(change.commit)) {
          fail(label, `${where} has commit ${JSON.stringify(change.commit)}, not a full commit id in lower-case hex`);
        }
      });
    }

    // Every field it names is in every file it names: a field that is not there names nothing.
    const steps = regeneration.beforeSteps;
    if (!isObject(steps) || unknownFields(steps, BEFORE_STEPS_FIELDS).length > 0 ||
        !BEFORE_STEPS_FIELDS.every((field) => Object.hasOwn(steps, field))) {
      fail(label, `${at} has beforeSteps ${JSON.stringify(steps)}, not { fields, ecosystems }`);
    } else {
      const listOf = (field, what) => {
        const value = steps[field];
        if (!Array.isArray(value) || value.length === 0 || !value.every(isText) || new Set(value).size !== value.length) {
          fail(label, `${at} has beforeSteps.${field} ${JSON.stringify(value)}, not a list of distinct ${what}`);
          return null;
        }
        return value;
      };
      const fields = listOf('fields', 'field paths');
      const ecosystems = listOf('ecosystems', 'registries');
      if (fields && ecosystems && manifest !== undefined) {
        for (const ecosystem of ecosystems) {
          const raw = rawFile(ecosystem);
          if (raw.problem) {
            fail(label, `${at} names ${ecosystem}, which ${raw.problem}`);
            continue;
          }
          for (const field of fields) {
            if (resolvePath(raw.value, field) === undefined) {
              fail(label, `${at} names ${field}, which ${raw.file} does not have. A field that is not in the file names nothing.`);
            }
          }
        }
      }
    }

    if (!hasWords(regeneration.summary)) fail(label, `${at} is missing summary`);
    else if (hasHiddenCharacters(regeneration.summary)) fail(label, `${at} has a control or format character in summary`);
  });
}

// ---------------------------------------------------------------------------
// Schema version 2
// ---------------------------------------------------------------------------
//
// A version 2 dataset is a set of files bound to each other by hashes: for
// each registry the corpus read a raw scan file and a ledger of every package
// it listed, the catalogue snapshot the aggregate was classified with, the
// consolidation map, the corpus, and MANIFEST.json. Each section below reads
// one kind of file and holds it to the schema version 2 contract.
//
// These rules are a second implementation of that contract, written apart
// from the code that produces the files, so that one mistake has to be made
// twice to pass.

/** The eleven registries, by the ids every file uses. */
const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'crates', 'packagist', 'nuget', 'rubygems', 'hex', 'pub', 'cocoapods'];

/** The largest file a dataset may hold. The host refuses a file of 100 MB. */
const MAX_FILE_BYTES = 95_000_000;
const FILE_LIMIT = {
  bytes: MAX_FILE_BYTES,
  what: 'a dataset file',
  why: 'The host refuses a file of 100 MB, so this one could not be published beside the others.',
};

/**
 * What the generator checks, each a list of refusals that must be empty. A
 * missing scan file and an unresolved share above the ceiling are not checks:
 * each withholds the row and refuses nothing, and a withheld row is recorded
 * once, in the corpus's withheld. A manifest that carries either key carries
 * a key the contract does not define.
 */
const MANIFEST_CHECKS = ['noMatches', 'sourcesOffAllowlist', 'catalogCheckMismatches', 'inputHashMismatches', 'identityFailures'];

/** The fields of each object, all of them required. An object is closed: a key not listed here fails. Each section adds the objects it reads. */
const KEYS = {
  manifest: ['schemaVersion', 'dataset', 'kind', 'collectedAt', 'generatedAt', 'license', 'provenance', 'files', 'coverage',
    'ecosystems', 'comparability', 'checks', 'knownIssues'],
  provenance: ['sourceRepository', 'sourceCommit', 'workflowRun'],
  file: ['role', 'ecosystem', 'file', 'bytes', 'sha256', 'schemaVersion'],
};

// --- Small readers ------------------------------------------------------------

const describe = (value) => {
  if (value === undefined) return 'missing';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isSha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** An ISO 8601 UTC time: a date-time ending in Z, or a date where the source gives no time of day. */
/**
 * A time is a date-time in exactly the form toISOString() writes, milliseconds
 * and Z included and never an offset, or a date where the source has no time.
 * One form, so that two times of one instant are one string.
 */
const isTime = (v) => {
  if (isCalendarDate(v)) return true;
  if (typeof v !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.exec(v);
  return match !== null && isCalendarDate(match[1]);
};
const startsWithVersion = (text) => /^\s*\{\s*"schemaVersion"\s*:/.test(text);

/**
 * The deepest a version 2 file nests: a corpus cell sits about nine levels
 * down. Anything deeper is refused before a reader that recurses meets it.
 */
const MAX_NESTING = 32;

/** Whether a parsed value nests deeper than the limit, found without recursion. */
function nestsDeeperThan(value, limit) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
  }
  return false;
}

/** The most problems listed for one file of a dataset; past it, the rest are counted. */
const MAX_PROBLEMS_PER_FILE = 50;

/** The words of a camelCase key, so that `weakShareOfCryptoUsing` reads as a share and `generatedAt` does not. */
const SHARE_WORDS = ['share', 'shares', 'rate', 'rates', 'ratio', 'percent', 'percentage', 'pct', 'proportion', 'fraction'];
const looksLikeShare = (key, value) =>
  key.split(/(?=[A-Z])/).some((word) => SHARE_WORDS.includes(word.toLowerCase())) || (typeof value === 'number' && !Number.isInteger(value));

/**
 * An object with exactly the given keys. Reports each key the contract does
 * not define and the keys it lacks, and says whether every expected key is
 * there to be read further.
 */
function closed(value, keys, where, bad) {
  if (!isObject(value)) {
    bad(`${where} is ${describe(value)}, not an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) continue;
    bad(looksLikeShare(key, value[key])
      ? `${where} carries ${describe(key)}, a stored share. No share is stored in a version 2 file: one is computed where it is shown, ` +
        'from two counts of the same block, so its denominator is never left to the reader.'
      : `${where} carries ${describe(key)}, which the schema version 2 contract does not define. Every object is closed, so a stale or ` +
        'misspelt field fails instead of being ignored.');
  }
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    bad(`${where} is missing ${missing.join(', ')}. Every field of a version 2 file is written out, null included, so that an ` +
      'absent field is never read as a default.');
  }
  return missing.length === 0;
}

/** Decode and parse one JSON file of a version 2 dataset, and read its version before anything else. */
function parseVersion2(buffer, file, bad) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    bad(`${file} is not UTF-8. A decoder that substitutes a character would hide the difference from every check here.`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    bad(`${file} does not parse: ${err.message}`);
    return null;
  }
  if (!isObject(value)) {
    bad(`${file} is not a JSON object`);
    return null;
  }
  if (nestsDeeperThan(value, MAX_NESTING)) {
    bad(`${file} nests values more than ${MAX_NESTING} deep. No version 2 file is nested so deep, and reading one that is ` +
      'could exhaust the stack of whoever checks it.');
    return null;
  }
  if (!Object.hasOwn(value, 'schemaVersion')) {
    bad(`${file} carries no schemaVersion, so it is a version 1 file. A dataset is version 2 throughout, and a version 1 file ` +
      'cannot enter a new one.');
    return null;
  }
  if (value.schemaVersion !== 2) {
    bad(`${file} has schemaVersion ${describe(value.schemaVersion)}. Every file of a version 2 dataset is version 2, and a ` +
      'version these rules do not know is never read as one they do.');
    return null;
  }
  if (!startsWithVersion(text)) {
    bad(`${file} does not begin with schemaVersion. It is the first key of every version 2 file, so that a reader learns the ` +
      'version before it reads anything else.');
  }
  return value;
}

/** A file of the dataset as bytes: a regular file, never a link, and no larger than its kind of file may be. */
function readDatasetFile(dir, file, bad, limit = FILE_LIMIT) {
  const path = join(dir, file);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) {
    bad(`${file} is listed in MANIFEST.json but is not in the dataset`);
    return null;
  }
  if (!stat.isFile()) {
    bad(`${file} is not a regular file. A link would keep its bytes somewhere these checks and the immutability check do not look.`);
    return null;
  }
  if (stat.size > limit.bytes) {
    bad(`${file} is ${stat.size.toLocaleString('en-US')} bytes, over the ${limit.bytes.toLocaleString('en-US')} ${limit.what} may hold. ` +
      `${limit.why}`);
    return null;
  }
  return readFileSync(path);
}

// --- MANIFEST.json --------------------------------------------------------------

/** The manifest, read strictly. One that is not a version 2 manifest in shape is reported once, since nothing else can be read from it. */
function readManifest2(dir, bad) {
  const path = join(dir, 'MANIFEST.json');
  let text;
  try {
    text = readStrict(path);
  } catch {
    bad('MANIFEST.json is not UTF-8. A decoder that substitutes a character would hide the difference from every check here.');
    return null;
  }
  const manifest = JSON.parse(text);
  if (nestsDeeperThan(manifest, MAX_NESTING)) {
    bad(`MANIFEST.json nests values more than ${MAX_NESTING} deep. No version 2 file is nested so deep, and reading one that is ` +
      'could exhaust the stack of whoever checks it.');
    return null;
  }
  const missing = KEYS.manifest.filter((key) => !Object.hasOwn(manifest, key));
  const extra = Object.keys(manifest).filter((key) => !KEYS.manifest.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`it lacks ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`it carries ${extra.map(describe).join(', ')}, which a version 2 manifest does not define`);
    bad(`schemaVersion is 2, but MANIFEST.json is not a version 2 manifest: ${parts.join('; ')}. A file is read as version 2 ` +
      'by the fields it has, not by its marker alone.');
    return null;
  }
  if (!startsWithVersion(text)) {
    bad('MANIFEST.json does not begin with schemaVersion. It is the first key of every version 2 file, so that a reader learns ' +
      'the version before it reads anything else.');
  }
  return manifest;
}

/** The manifest's own fields. What it says about the other files is compared with them further down. */
function checkManifest2(name, m, bad) {
  const at = 'MANIFEST.json';
  if (!isText(m.dataset)) bad(`${at}: dataset is ${describe(m.dataset)}, not a title`);
  if (m.kind !== 'raw+aggregate') {
    bad(`${at}: kind is ${describe(m.kind)}. A version 2 dataset is raw+aggregate; aggregate-only stays with the one dataset ` +
      'whose raw output does not exist.');
  }
  if (m.collectedAt !== name) {
    bad(`${at}: collectedAt is ${describe(m.collectedAt)}, and the directory is ${name}. The date names the dataset, its files ` +
      'and its citation, so they agree.');
  }
  if (!isTime(m.generatedAt)) bad(`${at}: generatedAt is ${describe(m.generatedAt)}, not a time as toISOString() writes it, or a date`);
  if (m.license !== 'CC-BY-4.0') bad(`${at}: license is ${describe(m.license)}; published datasets here are CC-BY-4.0`);
  if (closed(m.provenance, KEYS.provenance, `${at}: provenance`, bad)) {
    for (const field of KEYS.provenance) {
      if (!isText(m.provenance[field])) {
        bad(`${at}: provenance.${field} is ${describe(m.provenance[field])}. A published dataset that cannot say which run ` +
          'produced it cannot be reproduced or challenged.');
      }
    }
  }
  // `checks` records what the generator found. Each check is recomputed from
  // the files by the rules below, and none is read as proof of anything; a
  // list that is not empty is the generator saying the dataset is not ready.
  // The manifest stores no verdict of its own.
  if (closed(m.checks, MANIFEST_CHECKS, `${at}: checks`, bad)) {
    for (const check of MANIFEST_CHECKS) {
      if (!Array.isArray(m.checks[check])) {
        bad(`${at}: checks.${check} is ${describe(m.checks[check])}, not a list`);
      } else if (m.checks[check].length > 0) {
        bad(`${at}: checks.${check} lists ${describe(m.checks[check])}. The generator found the dataset incomplete, and an ` +
          'incomplete dataset is not published.');
      }
    }
  }
  if (!Array.isArray(m.knownIssues)) bad(`${at}: knownIssues is ${describe(m.knownIssues)}, not a list`);
}

// --- The files ------------------------------------------------------------------

const ROLES = ['corpus', 'scan', 'listing', 'catalog', 'consolidation'];
const PER_REGISTRY = ['scan', 'listing'];
const fileNameFor = (role, eco, date) => ({
  corpus: `corpus-${date}.json`,
  catalog: `catalog-${date}.json`,
  consolidation: `consolidation-${date}.json`,
  scan: `scan-results-${eco}.json`,
  listing: `listing-${eco}.tsv.gz`,
})[role];

/**
 * Every file the manifest lists: present, a regular file, within the size
 * limit, and hashing to what was recorded. Every other file in the directory
 * is a stray, whatever its name. Returns the parsed files by role, and the
 * registries whose scan file the manifest lists: the scan files the corpus read.
 */
function readListedFiles(name, dir, manifest, bad) {
  if (!Array.isArray(manifest.files)) {
    bad(`MANIFEST.json: files is ${describe(manifest.files)}, not a list of the dataset's files`);
    return null;
  }
  const found = { scans: {}, listings: {}, corpus: null, catalog: null, consolidation: null, hashes: new Map(), withScanFile: new Set() };
  const listed = new Set();
  let ledgerBytes = 0;
  const roles = new Set();
  manifest.files.forEach((entry, index) => {
    const where = `MANIFEST.json: files[${index}]`;
    if (!closed(entry, KEYS.file, where, bad)) return;
    if (!ROLES.includes(entry.role)) {
      bad(`${where}.role is ${describe(entry.role)}, not one of: ${ROLES.join(', ')}`);
      return;
    }
    const perRegistry = PER_REGISTRY.includes(entry.role);
    if (perRegistry && !ECOSYSTEMS.includes(entry.ecosystem)) {
      bad(`${where}.ecosystem is ${describe(entry.ecosystem)}, not one of the eleven registries`);
      return;
    }
    if (!perRegistry && entry.ecosystem !== null) {
      bad(`${where}.ecosystem is ${describe(entry.ecosystem)}; the ${entry.role} file covers every registry, so it is null`);
      return;
    }
    const expected = fileNameFor(entry.role, entry.ecosystem, name);
    if (entry.file !== expected) {
      bad(`${where} names ${describe(entry.file)} as the ${entry.role} file${perRegistry ? ` of ${entry.ecosystem}` : ''}, ` +
        `which is named ${expected}`);
      return;
    }
    if (listed.has(entry.file)) {
      bad(`${where} lists ${entry.file} a second time`);
      return;
    }
    listed.add(entry.file);
    roles.add(perRegistry ? `${entry.role}:${entry.ecosystem}` : entry.role);
    if (entry.schemaVersion !== 2) {
      bad(`${where}.schemaVersion is ${describe(entry.schemaVersion)}. Every file of a version 2 dataset is version 2, the ledger included.`);
    }
    if (!isCount(entry.bytes)) bad(`${where}.bytes is ${describe(entry.bytes)}, not a size in bytes`);
    if (!isSha256(entry.sha256)) bad(`${where}.sha256 is ${describe(entry.sha256)}, not a SHA-256 digest in lower-case hex`);

    if (entry.role === 'listing') {
      const stat = lstatSync(join(dir, entry.file), { throwIfNoEntry: false });
      if (stat && stat.isFile()) ledgerBytes += stat.size;
    }
    const buffer = readDatasetFile(dir, entry.file, bad, entry.role === 'listing' ? LEDGER_LIMIT : FILE_LIMIT);
    if (buffer === null) return;
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (isSha256(entry.sha256) && actual !== entry.sha256) {
      bad(`${entry.file} does not match its recorded hash\n    recorded ${entry.sha256}\n    actual   ${actual}`);
    }
    if (isCount(entry.bytes) && entry.bytes !== buffer.length) {
      bad(`${entry.file} is ${buffer.length} bytes, manifest says ${entry.bytes}`);
    }
    found.hashes.set(entry.file, actual);
    if (entry.role === 'listing') {
      found.listings[entry.ecosystem] = { file: entry.file, buffer, sha256: actual };
      return;
    }
    const value = parseVersion2(buffer, entry.file, bad);
    if (value === null) return;
    const record = { file: entry.file, value, sha256: actual };
    if (entry.role === 'scan') found.scans[entry.ecosystem] = record;
    else found[entry.role] = record;
  });

  if (ledgerBytes > MAX_LEDGERS_BYTES) {
    bad(`listing ledgers: together they are ${ledgerBytes.toLocaleString('en-US')} bytes, over the ` +
      `${MAX_LEDGERS_BYTES.toLocaleString('en-US')} the eleven may hold. Every copy of this repository carries them.`);
  }
  for (const role of ['corpus', 'catalog', 'consolidation']) {
    if (!roles.has(role)) bad(`MANIFEST.json lists no ${role} file, and a version 2 dataset has one`);
  }
  // One scan file and one ledger per registry read: eleven, less one per row the corpus withholds for having no scan
  // file. Which registries those are is the corpus's noScanFile rows, compared with this set when the corpus is read.
  for (const eco of ECOSYSTEMS) {
    const scan = roles.has(`scan:${eco}`);
    const listing = roles.has(`listing:${eco}`);
    if (scan) found.withScanFile.add(eco);
    if (scan !== listing) {
      bad(`MANIFEST.json lists ${scan ? `the scan file of ${eco} and no listing ledger` : `the listing ledger of ${eco} and no scan file`} ` +
        'for it. A scan file and its ledger are written together, so the two roles name the same registries.');
    }
  }

  const strays = readdirSync(dir).filter((entry) => entry !== 'MANIFEST.json' && !listed.has(entry)).sort();
  if (strays.length > 0) {
    bad(`present but not listed in MANIFEST.json: ${strays.map(describe).join(', ')}. An unlisted file is one no reader can attribute ` +
      'and no hash covers.');
  }
  return found;
}

// --- The catalogue snapshot -----------------------------------------------------

const isCamel = (v) => typeof v === 'string' && /^[a-z][A-Za-z0-9]*$/.test(v);
const isUrl = (v) => {
  if (typeof v !== 'string' || hasHiddenCharacters(v)) return false;
  try {
    return ['https:', 'http:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};
const isHttpsUrl = (v) => isUrl(v) && v.startsWith('https://');
const isDistinct = (list) => new Set(list).size === list.length;
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && isDistinct(a) && a.length === new Set(b).size && a.every((x) => b.includes(x));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));

const hasExactly = (object, keys) => Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
const isTextList = (value) => Array.isArray(value) && value.every(isText);

const CLASSES = ['matched', 'weak', 'brokenAlgorithm', 'deprecatedLibrary', 'pqc'];

/** The algorithms whose presence alone makes a library weak (class brokenAlgorithm). */
const BROKEN_ALGORITHMS = ['MD2', 'MD4', 'MD5', 'SHA-1', 'DES', 'RC4', '3DES', 'RC2', 'Blowfish', 'CAST5', 'IDEA', 'TEA', 'GOST 28147-89'];

Object.assign(KEYS, {
  catalog: ['schemaVersion', 'kind', 'collectedAt', 'sourceCommit', 'matchSetSha256', 'classificationSha256', 'matchRules', 'categories', 'entries'],
  entry: ['ecosystem', 'name', 'tier', 'weakClass', 'classEvidence', 'classified', 'unclassifiedReason', 'endOfLifeReview',
    'multiPurpose', 'unmatchable', 'registryAbsent', 'aliases', 'lastRelease', 'algorithms', 'category'],
  classEvidence: ['basis', 'limb', 'url', 'checkedAt', 'additionalUrls'],
  unclassifiedReason: ['code', 'url', 'checkedAt'],
  endOfLifeReview: ['status', 'url', 'checkedAt'],
  multiPurpose: ['version', 'url', 'checkedAt'],
  unmatchable: ['reason', 'url', 'checkedAt'],
  registryAbsent: ['checkedAt', 'note'],
  alias: ['name', 'url', 'checkedAt'],
  lastRelease: ['version', 'date', 'checkedAt'],
});

const TIERS = ['weak', 'other', 'pqc'];
const WEAK_CLASSES = ['brokenAlgorithm', 'deprecatedLibrary'];
const EVIDENCE_BASES = ['entryAlgorithms', 'endOfLifeSignal'];
const LIMBS = ['D1', 'D2', 'D3', 'D4'];
const UNCLASSIFIED_CODES = ['primaryFunctionNotCryptography', 'builtinPolyfill', 'noCryptographicCode'];
const REVIEW_STATUSES = ['notReviewed', 'signalFound', 'noSignalFound', 'statusNotVerified'];
const UNMATCHABLE_REASONS = ['standardLibraryPath', 'packagePathInModule'];

/** Which entries each class holds. A multi-purpose library is never a post-quantum one. */
const IN_CLASS = {
  matched: (e) => e.classified === true,
  weak: (e) => e.classified === true && e.tier === 'weak',
  brokenAlgorithm: (e) => e.classified === true && e.weakClass === 'brokenAlgorithm',
  deprecatedLibrary: (e) => e.classified === true && e.weakClass === 'deprecatedLibrary',
  pqc: (e) => e.classified === true && e.tier === 'pqc' && e.multiPurpose === null,
};
/** An entry a scan can observe: classified, present on the registry, and a name a manifest can declare. */
const isCountable = (e) => e.classified === true && e.registryAbsent === null && e.unmatchable === null;
const exclusionOf = (e) => (e.classified !== true ? 'unclassified' : e.registryAbsent !== null ? 'registryAbsent' : 'unmatchable');

/** One entry of the snapshot: its fields, their types, and the states the contract makes impossible. */
function checkEntry(e, where, bad) {
  if (!closed(e, KEYS.entry, where, bad)) return false;
  let sound = true;
  const wrong = (message) => {
    bad(`${where}: ${message}`);
    sound = false;
  };
  const nested = (value, keys, field, check) => {
    if (value === null) return;
    if (closed(value, keys, `${where}: ${field}`, bad)) check(value);
    else sound = false;
  };
  if (!ECOSYSTEMS.includes(e.ecosystem)) wrong(`ecosystem is ${describe(e.ecosystem)}, not one of the eleven registries`);
  if (!isText(e.name)) wrong(`name is ${describe(e.name)}`);
  if (e.tier !== null && !TIERS.includes(e.tier)) wrong(`tier is ${describe(e.tier)}, not weak, other, pqc or null`);
  if (e.weakClass !== null && !WEAK_CLASSES.includes(e.weakClass)) wrong(`weakClass is ${describe(e.weakClass)}, not brokenAlgorithm, deprecatedLibrary or null`);
  if (typeof e.classified !== 'boolean') wrong(`classified is ${describe(e.classified)}, not true or false`);
  nested(e.classEvidence, KEYS.classEvidence, 'classEvidence', (c) => {
    if (!EVIDENCE_BASES.includes(c.basis)) wrong(`classEvidence.basis is ${describe(c.basis)}, not entryAlgorithms or endOfLifeSignal`);
    if (c.limb !== null && !LIMBS.includes(c.limb)) wrong(`classEvidence.limb is ${describe(c.limb)}, not D1 to D4 or null`);
    if (c.url !== null && !isHttpsUrl(c.url)) wrong(`classEvidence.url is ${describe(c.url)}, not an https URL or null`);
    if (c.checkedAt !== null && !isTime(c.checkedAt)) wrong(`classEvidence.checkedAt is ${describe(c.checkedAt)}, not a time as toISOString() writes it, a date or null`);
    if (!Array.isArray(c.additionalUrls) || !c.additionalUrls.every(isHttpsUrl)) wrong(`classEvidence.additionalUrls is ${describe(c.additionalUrls)}, not a list of https URLs`);
    const cited = [c.limb, c.url, c.checkedAt].filter((v) => v !== null).length;
    if (c.basis === 'entryAlgorithms' && cited !== 0) {
      wrong('classEvidence cites a limb, a page or a check time with basis entryAlgorithms. An entry classed from its own ' +
        'algorithms cites none, and null in those fields means exactly that.');
    }
    if (c.basis === 'endOfLifeSignal' && cited !== 3) {
      wrong('classEvidence has basis endOfLifeSignal without a limb, a page and a check time. A class read from an end-of-life ' +
        'signal says which signal, where it was read and when.');
    }
  });
  nested(e.unclassifiedReason, KEYS.unclassifiedReason, 'unclassifiedReason', (u) => {
    if (!UNCLASSIFIED_CODES.includes(u.code)) wrong(`unclassifiedReason.code is ${describe(u.code)}, not one of: ${UNCLASSIFIED_CODES.join(', ')}`);
    if (!isHttpsUrl(u.url)) wrong(`unclassifiedReason.url is ${describe(u.url)}, not an https URL`);
    if (!isTime(u.checkedAt)) wrong(`unclassifiedReason.checkedAt is ${describe(u.checkedAt)}, not a time as toISOString() writes it, or a date`);
  });
  if (closed(e.endOfLifeReview, KEYS.endOfLifeReview, `${where}: endOfLifeReview`, bad)) {
    const r = e.endOfLifeReview;
    if (!REVIEW_STATUSES.includes(r.status)) wrong(`endOfLifeReview.status is ${describe(r.status)}, not one of: ${REVIEW_STATUSES.join(', ')}`);
    if (r.url !== null && !isHttpsUrl(r.url)) wrong(`endOfLifeReview.url is ${describe(r.url)}, not an https URL or null`);
    if (r.checkedAt !== null && !isTime(r.checkedAt)) wrong(`endOfLifeReview.checkedAt is ${describe(r.checkedAt)}, not a time as toISOString() writes it, a date or null`);
  } else {
    sound = false;
  }
  nested(e.multiPurpose, KEYS.multiPurpose, 'multiPurpose', (m) => {
    if (!isText(m.version)) wrong(`multiPurpose.version is ${describe(m.version)}, not the version inspected`);
    if (!isHttpsUrl(m.url)) wrong(`multiPurpose.url is ${describe(m.url)}, not an https URL`);
    if (!isTime(m.checkedAt)) wrong(`multiPurpose.checkedAt is ${describe(m.checkedAt)}, not a time as toISOString() writes it, or a date`);
  });
  nested(e.unmatchable, KEYS.unmatchable, 'unmatchable', (u) => {
    if (!UNMATCHABLE_REASONS.includes(u.reason)) wrong(`unmatchable.reason is ${describe(u.reason)}, not standardLibraryPath or packagePathInModule`);
    if (!isHttpsUrl(u.url)) wrong(`unmatchable.url is ${describe(u.url)}, not an https URL`);
    if (!isTime(u.checkedAt)) wrong(`unmatchable.checkedAt is ${describe(u.checkedAt)}, not a time as toISOString() writes it, or a date`);
  });
  nested(e.registryAbsent, KEYS.registryAbsent, 'registryAbsent', (a) => {
    if (!isTime(a.checkedAt)) wrong(`registryAbsent.checkedAt is ${describe(a.checkedAt)}, not a time as toISOString() writes it, or a date`);
    if (a.note !== null && !isText(a.note)) wrong(`registryAbsent.note is ${describe(a.note)}, not text or null`);
  });
  if (!Array.isArray(e.aliases)) {
    wrong(`aliases is ${describe(e.aliases)}, not a list`);
  } else {
    e.aliases.forEach((alias, index) => {
      if (!closed(alias, KEYS.alias, `${where}: aliases[${index}]`, bad)) {
        sound = false;
        return;
      }
      if (!isText(alias.name)) wrong(`aliases[${index}].name is ${describe(alias.name)}`);
      if (!isHttpsUrl(alias.url)) wrong(`aliases[${index}].url is ${describe(alias.url)}, not an https URL`);
      if (!isTime(alias.checkedAt)) wrong(`aliases[${index}].checkedAt is ${describe(alias.checkedAt)}, not a time as toISOString() writes it, or a date`);
    });
  }
  nested(e.lastRelease, KEYS.lastRelease, 'lastRelease', (l) => {
    if (!isText(l.version)) wrong(`lastRelease.version is ${describe(l.version)}, not a version`);
    if (!isCalendarDate(l.date)) wrong(`lastRelease.date is ${describe(l.date)}, not a YYYY-MM-DD date`);
    if (!isTime(l.checkedAt)) wrong(`lastRelease.checkedAt is ${describe(l.checkedAt)}, not a time as toISOString() writes it, or a date`);
  });
  if (!isTextList(e.algorithms)) wrong(`algorithms is ${describe(e.algorithms)}, not a list of names`);
  if (!isText(e.category)) wrong(`category is ${describe(e.category)}, not a category`);
  if (!sound) return false;

  // The states the contract makes impossible to write.
  if ((e.tier === null) !== (e.classified === false) || (e.unclassifiedReason !== null) !== (e.classified === false)) {
    wrong(`tier is ${describe(e.tier)}, classified ${e.classified} and unclassifiedReason ${e.unclassifiedReason === null ? 'null' : 'set'}. ` +
      'An entry has no tier exactly when it is unclassified, and then it says why.');
  }
  if ((e.weakClass !== null) !== (e.tier === 'weak')) {
    wrong(`weakClass is ${describe(e.weakClass)} on tier ${describe(e.tier)}. A weak entry is in exactly one weak class, and no other entry is in one.`);
  }
  if ((e.classEvidence !== null) !== (e.weakClass !== null)) {
    wrong(`classEvidence is ${e.classEvidence === null ? 'null' : 'set'} with weakClass ${describe(e.weakClass)}. The evidence for a weak class is given exactly when there is one.`);
  }
  if (e.weakClass === 'deprecatedLibrary' && e.classEvidence !== null && e.classEvidence.basis !== 'endOfLifeSignal') {
    wrong('is a deprecatedLibrary with classEvidence.basis entryAlgorithms. A library is deprecated on an end-of-life signal, cited.');
  }
  if (e.weakClass === 'brokenAlgorithm') {
    const off = e.algorithms.filter((algorithm) => !BROKEN_ALGORITHMS.includes(algorithm));
    if (off.length > 0) {
      wrong(`is a brokenAlgorithm entry whose algorithms include ${off.join(', ')}, which is not on the closed list of broken ` +
        `algorithms (${BROKEN_ALGORITHMS.join(', ')})`);
    }
  }
  if (e.multiPurpose !== null && e.tier !== 'other') {
    wrong(`multiPurpose is set on tier ${describe(e.tier)}. A library that ships post-quantum algorithms among others is tier other, never counted as post-quantum.`);
  }
  if ((e.endOfLifeReview.status === 'signalFound') !== (e.weakClass === 'deprecatedLibrary')) {
    wrong(`endOfLifeReview.status is ${e.endOfLifeReview.status} with weakClass ${describe(e.weakClass)}. A signal found is what makes a library deprecatedLibrary, and nothing else does.`);
  }
  return sound;
}

/** K, the countable entries and the excluded ones, for each class of one registry. */
function measure(registry) {
  registry.measure = {};
  for (const cls of CLASSES) {
    const counted = registry.entries.filter((e) => IN_CLASS[cls](e) && isCountable(e)).map((e) => e.name);
    const members = cls === 'matched' ? registry.entries : registry.entries.filter(IN_CLASS[cls]);
    const excluded = members.filter((e) => !isCountable(e)).map((e) => ({ entry: e.name, why: exclusionOf(e) }));
    registry.measure[cls] = { k: counted.length, entries: counted, excluded };
  }
  registry.unclassified = registry.entries.filter((e) => e.classified !== true).map((e) => e.name);
  registry.notCountable = registry.entries.filter((e) => e.classified === true && !isCountable(e)).map((e) => e.name);
  registry.multiPurpose = registry.entries.filter((e) => e.multiPurpose !== null).map((e) => e.name);
}

function checkCatalog(name, record, bad) {
  const file = record.file;
  const c = record.value;
  if (!closed(c, KEYS.catalog, file, bad)) return null;
  if (c.kind !== 'censusCatalog') bad(`${file}: kind is ${describe(c.kind)}, not "censusCatalog"`);
  if (c.collectedAt !== name) bad(`${file}: collectedAt is ${describe(c.collectedAt)}, not the dataset's date ${name}`);
  if (!isText(c.sourceCommit)) bad(`${file}: sourceCommit is ${describe(c.sourceCommit)}, not the commit the catalogue was taken from`);
  for (const digest of ['matchSetSha256', 'classificationSha256']) {
    if (!isSha256(c[digest])) bad(`${file}: ${digest} is ${describe(c[digest])}, not a SHA-256 digest in lower-case hex`);
  }
  if (closed(c.matchRules, ECOSYSTEMS, `${file}: matchRules`, bad)) {
    for (const eco of ECOSYSTEMS) {
      if (!isText(c.matchRules[eco])) bad(`${file}: matchRules.${eco} is ${describe(c.matchRules[eco])}, not a rule id`);
    }
  }
  const categories = isTextList(c.categories) && c.categories.length > 0 && isDistinct(c.categories) ? c.categories : null;
  if (categories === null) bad(`${file}: categories is ${describe(c.categories)}, not the closed list of distinct categories entries are held to`);
  if (!Array.isArray(c.entries)) {
    bad(`${file}: entries is ${describe(c.entries)}, not a list`);
    return null;
  }
  const byEco = Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, { entries: [], byName: new Map(), aliasOf: new Map() }]));
  let sound = true;
  let previous = null;
  c.entries.forEach((entry, index) => {
    const label = isObject(entry) && isText(entry.name) && isText(entry.ecosystem) ? ` (${entry.ecosystem}:${entry.name})` : '';
    const where = `${file}: entries[${index}]${label}`;
    if (!checkEntry(entry, where, bad)) {
      sound = false;
      return;
    }
    if (categories !== null && !categories.includes(entry.category)) {
      bad(`${where}: category is ${describe(entry.category)}, which is not one of the snapshot's categories`);
    }
    if (previous !== null && (byteOrder(previous.ecosystem, entry.ecosystem) || byteOrder(previous.name, entry.name)) >= 0) {
      bad(`${where} does not follow ${previous.ecosystem}:${previous.name}. Entries are sorted by registry and then by name, ` +
        'in byte order, and each appears once.');
    }
    previous = entry;
    byEco[entry.ecosystem].entries.push(entry);
    byEco[entry.ecosystem].byName.set(entry.name, entry);
  });
  for (const eco of ECOSYSTEMS) {
    const registry = byEco[eco];
    for (const entry of registry.entries) {
      for (const alias of entry.aliases) {
        if (registry.byName.has(alias.name)) {
          bad(`${file}: ${eco}:${entry.name} has the alias ${alias.name}, which is also the name of an entry. A declared name ` +
            'counts as one entry.');
        } else if (registry.aliasOf.has(alias.name)) {
          bad(`${file}: the alias ${alias.name} belongs to both ${registry.aliasOf.get(alias.name)} and ${entry.name} in ${eco}. ` +
            'A declared name counts as one entry.');
        } else {
          registry.aliasOf.set(alias.name, entry.name);
        }
      }
    }
    measure(registry);
  }
  // The two digests, recomputed: the canonical JSON of the entries, sorted by
  // registry and then name, with their aliases sorted, in byte order; the
  // match set with every registry's match rule. A re-tag or a name added
  // shows as a changed digest, and a digest that does not follow hides it.
  if (sound && isObject(c.matchRules) && ECOSYSTEMS.every((eco) => isText(c.matchRules[eco]))) {
    const entries = [...c.entries].sort((x, y) => byteOrder(x.ecosystem, y.ecosystem) || byteOrder(x.name, y.name));
    const digest = (value) => createHash('sha256').update(canonical(value), 'utf-8').digest('hex');
    const recomputed = {
      matchSetSha256: digest({
        entries: entries.map((e) => ({ ecosystem: e.ecosystem, name: e.name, aliases: e.aliases.map((a) => a.name).sort(byteOrder), unmatchable: e.unmatchable !== null })),
        matchRules: c.matchRules,
      }),
      classificationSha256: digest({
        entries: entries.map((e) => ({
          ecosystem: e.ecosystem, name: e.name, tier: e.tier, weakClass: e.weakClass, classified: e.classified,
          multiPurpose: e.multiPurpose !== null, registryAbsent: e.registryAbsent !== null, unmatchable: e.unmatchable !== null,
        })),
      }),
    };
    for (const field of ['matchSetSha256', 'classificationSha256']) {
      if (isSha256(c[field]) && c[field] !== recomputed[field]) {
        bad(`${file}: ${field} is not the digest of the entries it covers (recomputed: ${recomputed[field]}). A digest that ` +
          'does not follow from the entries hides the change it exists to show.');
      }
    }
  }
  return { value: c, byEco, sound };
}

// --- The raw scan files ---------------------------------------------------------

/**
 * The base URLs a scan may read from, by registry and role: the admitted
 * allowlist. It is written as JSON text, so that a reader that does not run
 * this script can parse it and recompute its digest. A scan's sources are its
 * registry's list exactly: the same roles, both ways, and each value the same
 * text, with no normalisation and no prefix. A source off the list means the
 * scanner was pointed somewhere else, at a stub or a mirror, and the file is
 * not a scan of the registry. A registry with no list fails this rule; it is
 * never skipped.
 */
const ALLOWED_SOURCES_JSON = `{
  "cocoapods": {"catalogCheck": "https://trunk.cocoapods.org/api/v1/pods", "enumeration": "https://cdn.cocoapods.org/all_pods.txt", "manifests": "https://cdn.cocoapods.org/Specs", "versions": "https://cdn.cocoapods.org"},
  "crates": {"catalogCheck": "https://crates.io/api/v1/crates", "enumeration": "https://github.com/rust-lang/crates.io-index.git", "manifests": "https://github.com/rust-lang/crates.io-index.git"},
  "go": {"catalogCheck": "https://proxy.golang.org", "enumeration": "https://index.golang.org/index", "manifests": "https://proxy.golang.org"},
  "hex": {"catalogCheck": "https://hex.pm/api", "enumeration": "https://hex.pm/api/packages", "manifests": "https://hex.pm/api"},
  "maven": {"catalogCheck": "https://repo1.maven.org/maven2", "enumeration": "https://search.maven.org/solrsearch/select", "manifests": "https://repo1.maven.org/maven2"},
  "npm": {"catalogCheck": "https://registry.npmjs.org", "enumeration": "https://replicate.npmjs.com/_all_docs", "manifests": "https://registry.npmjs.org"},
  "nuget": {"catalogCheck": "https://api.nuget.org/v3/registration5-gz-semver2", "enumeration": "https://api.nuget.org/v3/catalog0/index.json", "manifests": "https://api.nuget.org/v3/registration5-gz-semver2"},
  "packagist": {"catalogCheck": "https://repo.packagist.org/p2", "enumeration": "https://packagist.org/packages/list.json", "manifests": "https://repo.packagist.org/p2"},
  "pub": {"catalogCheck": "https://pub.dev/api/packages", "enumeration": "https://pub.dev/api/package-names", "manifests": "https://pub.dev/api/packages"},
  "pypi": {"catalogCheck": "https://pypi.org/pypi", "enumeration": "https://pypi.org/simple/", "manifests": "https://pypi.org/pypi"},
  "rubygems": {"catalogCheck": "https://rubygems.org/api/v1/gems", "enumeration": "https://index.rubygems.org/names", "manifests": "https://rubygems.org/api/v1/gems"}
}`;
const ALLOWED_SOURCES = Object.freeze(Object.fromEntries(Object.entries(JSON.parse(ALLOWED_SOURCES_JSON))
  .map(([eco, roles]) => [eco, Object.freeze(roles)])));

/**
 * What a manifest can declare, by registry: the closed list of declaration
 * kinds a scan records, and the members a declaration carries beside `kind`.
 */
const DECLARATIONS = {
  npm: { kinds: ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'], members: { peerOptional: 'booleanOrNull' } },
  pypi: { kinds: ['requiresDist'], members: { marker: 'marker', markerText: 'textOrNull' } },
  go: { kinds: ['require'], members: { indirect: 'boolean', replace: 'replace' } },
  maven: { kinds: ['project', 'managed', 'profile', 'plugin'], members: { scope: 'textOrNull', optional: 'boolean' } },
  crates: { kinds: ['normal', 'dev', 'build'], members: { optional: 'boolean', target: 'textOrNull', package: 'textOrNull', inDefaultFeature: 'booleanOrNull' } },
  packagist: { kinds: ['require', 'requireDev', 'suggest'], members: {} },
  nuget: { kinds: ['dependencyGroup'], members: { targetFramework: 'textOrNull' } },
  rubygems: { kinds: ['runtime', 'development'], members: {} },
  hex: { kinds: ['requirement'], members: { optional: 'boolean' } },
  pub: { kinds: ['dependencies', 'devDependencies'], members: {} },
  cocoapods: { kinds: ['topLevel', 'platform', 'subspec', 'testspec', 'appspec'], members: { platform: 'textOrNull', subspec: 'textOrNull' } },
};

const MEMBER_TYPES = {
  boolean: { test: (v) => typeof v === 'boolean', says: 'true or false' },
  booleanOrNull: { test: (v) => v === null || typeof v === 'boolean', says: 'true, false or null' },
  textOrNull: { test: (v) => v === null || isText(v), says: 'text or null' },
  marker: { test: (v) => ['none', 'extra', 'environmentOnly'].includes(v), says: 'none, extra or environmentOnly' },
  replace: {
    test: (v) => v === null || (isObject(v) && hasExactly(v, ['path', 'version']) && isText(v.path) && (v.version === null || isText(v.version))),
    says: 'null or { path, version }',
  },
};

/** The package-level facts the "direct and unconditional" rule needs, for the three registries that have them; null for the others. */
const PACKAGE_MANIFESTS = {
  nuget: {
    keys: ['dependencyGroups'],
    test: (m) => Array.isArray(m.dependencyGroups) && m.dependencyGroups.every((g) => g === null || isText(g)),
    says: '{ dependencyGroups: [target framework or null] }',
  },
  cocoapods: {
    keys: ['subspecs', 'defaultSubspecs'],
    test: (m) => isTextList(m.subspecs) && (m.defaultSubspecs === null || isTextList(m.defaultSubspecs)),
    says: '{ subspecs: [names], defaultSubspecs: [names] or null }',
  },
  maven: {
    keys: ['hasParent', 'propertyCoordinates'],
    test: (m) => typeof m.hasParent === 'boolean' && Number.isSafeInteger(m.propertyCoordinates) && m.propertyCoordinates >= 0,
    says: '{ hasParent: true or false, propertyCoordinates: a count }',
  },
};

const COVERAGE_COUNTS = ['listed', 'scanned', 'absent', 'unresolved', 'unversioned', 'dependenciesNotObservable'];

Object.assign(KEYS, {
  scan: ['schemaVersion', 'kind', 'ecosystem', 'startedAt', 'finishedAt', 'scanner', 'sources', 'catalog', 'method', 'enumeration',
    'versionYears', 'coverage', 'listing', 'catalogCheck', 'packagesWithMatch', 'packages'],
  scanner: ['script', 'commit', 'workflowRun'],
  scanCatalog: ['entries', 'matchSetSha256', 'matchRule'],
  method: ['versionSelection', 'readFrom', 'declarationKinds', 'notObservableWhen', 'limits'],
  enumeration: ['requested', 'listed', 'truncated', 'reason', 'unit', 'budgetMinutes', 'elapsedMinutes', 'frameSize', 'sampling', 'indexWindow'],
  sampling: ['method', 'seed', 'draw', 'pageRows'],
  indexWindow: ['since', 'until'],
  scanCoverage: [...COVERAGE_COUNTS, 'scannedByReadFrom'],
  listing: ['file', 'sha256', 'rows'],
  catalogCheck: ['entry', 'alias', 'status', 'httpStatus', 'url', 'checkedAt', 'latestVersion', 'latestReleaseAt'],
  package: ['name', 'version', 'readFrom', 'manifest', 'matches'],
  match: ['declaredName', 'entry', 'matchedBy', 'declarations'],
});

const MATCHED_BY = ['exact', 'normalized', 'majorVersionSuffix', 'alias', 'packageRename', 'podSubspec'];
const SAMPLING_METHODS = ['all', 'registryOrder', 'rankedOrder', 'seededShuffle', 'rankedThenSeededShuffle'];
const SHUFFLED = ['seededShuffle', 'rankedThenSeededShuffle'];
const CHECK_STATUSES = ['present', 'absent', 'unresolved', 'notApplicable'];

function checkSources(eco, sources, file, bad) {
  const where = `${file}: sources`;
  const allowed = Object.hasOwn(ALLOWED_SOURCES, eco) ? ALLOWED_SOURCES[eco] : null;
  if (allowed === null) {
    bad(`${where}: no allowlist of sources is admitted for ${eco}, so these cannot be shown to be the registry's own. A scan ` +
      'enters a dataset only from admitted sources.');
    return;
  }
  if (!isObject(sources)) {
    bad(`${where} is ${describe(sources)}, not an object of base URLs by role`);
    return;
  }
  // The roles both ways: a role the list does not hold, and a role it holds that the file leaves out.
  for (const role of Object.keys(sources)) {
    if (!Object.hasOwn(allowed, role)) {
      bad(`${where} names the role ${describe(role)}, which the allowlist for ${eco} does not hold (it holds ` +
        `${Object.keys(allowed).join(', ')}). A scan names the roles it is admitted to read from, and no others.`);
    }
  }
  for (const [role, url] of Object.entries(allowed)) {
    if (!Object.hasOwn(sources, role)) {
      bad(`${where} has no ${role}. A scan of ${eco} names every base URL the allowlist holds for it, so that a scan of the ` +
        'registry can be told from a scan of something else.');
    } else if (sources[role] !== url) {
      bad(`${where}.${role} is ${describe(sources[role])}, not ${url}, the base URL admitted for ${eco}. Sources are compared ` +
        'as exact text: one off the list means the scanner was pointed at a stub or a mirror, and the file is not a scan of the registry.');
    }
  }
}

function checkMethod(eco, method, file, bad) {
  const where = `${file}: method`;
  if (!closed(method, KEYS.method, where, bad)) return null;
  let sound = true;
  const codes = (field, nonEmpty) => {
    const list = method[field];
    if (!Array.isArray(list) || !list.every(isCamel) || !isDistinct(list) || (nonEmpty && list.length === 0)) {
      bad(`${where}.${field} is ${describe(list)}, not a list of distinct camelCase codes${nonEmpty ? ' with at least one' : ''}`);
      sound = false;
    }
  };
  if (!isCamel(method.versionSelection)) bad(`${where}.versionSelection is ${describe(method.versionSelection)}, not a camelCase code`);
  codes('readFrom', true);
  codes('notObservableWhen', false);
  codes('limits', false);
  if (!sameSet(method.declarationKinds, DECLARATIONS[eco].kinds)) {
    bad(`${where}.declarationKinds is ${describe(method.declarationKinds)}. A scan of ${eco} records every kind of the closed ` +
      `list (${DECLARATIONS[eco].kinds.join(', ')}), so that a later definition needs no new scan.`);
  }
  return sound ? method : null;
}

function checkEnumeration(eco, e, file, bad) {
  const where = `${file}: enumeration`;
  if (!closed(e, KEYS.enumeration, where, bad)) return;
  if (!isCount(e.listed)) bad(`${where}.listed is ${describe(e.listed)}, not a whole count`);
  if (typeof e.truncated !== 'boolean') bad(`${where}.truncated is ${describe(e.truncated)}, not true or false`);
  if (e.truncated === false && e.reason !== null) bad(`${where}.reason is ${describe(e.reason)} for a run that was not truncated; it is null then`);
  if (e.truncated === true && !isText(e.reason)) bad(`${where}.reason is ${describe(e.reason)}; a truncated run says why it stopped`);
  if (!isText(e.unit)) bad(`${where}.unit is ${describe(e.unit)}, not the unit enumerated`);
  if (e.budgetMinutes !== null && !(Number.isFinite(e.budgetMinutes) && e.budgetMinutes >= 0)) {
    bad(`${where}.budgetMinutes is ${describe(e.budgetMinutes)}, not a number of minutes or null`);
  }
  if (!(Number.isFinite(e.elapsedMinutes) && e.elapsedMinutes >= 0)) bad(`${where}.elapsedMinutes is ${describe(e.elapsedMinutes)}, not a number of minutes`);
  if (e.frameSize !== null && !isCount(e.frameSize)) bad(`${where}.frameSize is ${describe(e.frameSize)}, not a whole count or null`);
  if (closed(e.sampling, KEYS.sampling, `${where}.sampling`, bad)) {
    const s = e.sampling;
    if (!SAMPLING_METHODS.includes(s.method)) bad(`${where}.sampling.method is ${describe(s.method)}, not one of: ${SAMPLING_METHODS.join(', ')}`);
    else if (SHUFFLED.includes(s.method) && !isText(s.seed)) bad(`${where}.sampling.seed is ${describe(s.seed)}. A shuffled sample names its seed, so that it can be drawn again.`);
    else if (!SHUFFLED.includes(s.method) && s.seed !== null) bad(`${where}.sampling.seed is ${describe(s.seed)} for ${s.method}, which shuffles nothing; it is null then`);
    // requested is a sampled row's size, and null for a row read whole. It is never 0.
    if (s.method === 'all' && e.requested !== null) {
      bad(`${where}.requested is ${describe(e.requested)} for a row read whole; it is null then`);
    } else if (SAMPLING_METHODS.includes(s.method) && s.method !== 'all' && !(isCount(e.requested) && e.requested > 0)) {
      bad(`${where}.requested is ${describe(e.requested)}, not the size of the sample. A row that is not read whole names how many ` +
        'packages it asked for, and that is never 0.');
    }
    if (s.method === 'all' && s.draw !== null) {
      bad(`${where}.sampling.draw is ${describe(s.draw)}, and a registry read whole draws nothing; it is null then`);
    } else if (s.method !== 'all' && !['package', 'page'].includes(s.draw)) {
      bad(`${where}.sampling.draw is ${describe(s.draw)}, not package or page: a sample says what it drew`);
    }
    if (s.draw === 'page' && !(isCount(s.pageRows) && s.pageRows > 0)) {
      bad(`${where}.sampling.pageRows is ${describe(s.pageRows)}; a draw by page says how many rows a page holds`);
    } else if (s.draw !== 'page' && s.pageRows !== null) {
      bad(`${where}.sampling.pageRows is ${describe(s.pageRows)} for a draw that is not by page; it is null then`);
    }
  }
  if (eco === 'go') {
    if (closed(e.indexWindow, KEYS.indexWindow, `${where}.indexWindow`, bad)) {
      for (const field of KEYS.indexWindow) {
        if (!isTime(e.indexWindow[field])) bad(`${where}.indexWindow.${field} is ${describe(e.indexWindow[field])}, not a time as toISOString() writes it, or a date`);
      }
    }
  } else if (e.indexWindow !== null) {
    bad(`${where}.indexWindow is ${describe(e.indexWindow)}; it is kept for Go's index alone and is null for ${eco}`);
  }
}

function checkScanCoverage(c, method, file, bad) {
  const where = `${file}: coverage`;
  if (!closed(c, KEYS.scanCoverage, where, bad)) return null;
  let sound = true;
  for (const field of COVERAGE_COUNTS) {
    if (!isCount(c[field])) {
      bad(`${where}.${field} is ${describe(c[field])}, not a whole count. null has no meaning in a version 2 count.`);
      sound = false;
    }
  }
  if (!isObject(c.scannedByReadFrom) || !Object.values(c.scannedByReadFrom).every(isCount)) {
    bad(`${where}.scannedByReadFrom is ${describe(c.scannedByReadFrom)}, not an object of counts by read source`);
    sound = false;
  }
  if (!sound) return null;
  const parts = c.scanned + c.absent + c.unresolved + c.unversioned;
  if (c.listed !== parts) {
    bad(`${where}.listed is ${c.listed}, and scanned + absent + unresolved + unversioned is ${parts}. Every listed package has ` +
      'one disposition, so an unread package cannot pass as a read one.');
  }
  if (c.dependenciesNotObservable > c.scanned) {
    bad(`${where}.dependenciesNotObservable is ${c.dependenciesNotObservable}, more than the ${c.scanned} manifests read it is a part of`);
  }
  if (method !== null && method.notObservableWhen.length === 0 && c.dependenciesNotObservable !== 0) {
    bad(`${where}.dependenciesNotObservable is ${c.dependenciesNotObservable} while method.notObservableWhen is empty. This ` +
      'registry always tells "no dependencies" from "no data", so the count is 0.');
  }
  if (method !== null && !sameSet(Object.keys(c.scannedByReadFrom), method.readFrom)) {
    bad(`${where}.scannedByReadFrom has ${describe(Object.keys(c.scannedByReadFrom))}; it has one count for each of method.readFrom ` +
      `(${method.readFrom.join(', ')})`);
  }
  if (sum(Object.values(c.scannedByReadFrom)) !== c.scanned) {
    bad(`${where}.scannedByReadFrom sums to ${sum(Object.values(c.scannedByReadFrom))}, and scanned is ${c.scanned}. Each manifest read came from one source.`);
  }
  return c;
}

function checkCatalogCheck(eco, rows, catalog, file, bad) {
  if (!Array.isArray(rows)) {
    bad(`${file}: catalogCheck is ${describe(rows)}, not a list`);
    return;
  }
  const registry = catalog ? catalog.byEco[eco] : null;
  const seen = new Set();
  rows.forEach((row, index) => {
    const where = `${file}: catalogCheck[${index}]`;
    if (!closed(row, KEYS.catalogCheck, where, bad)) return;
    if (!isText(row.entry)) bad(`${where}.entry is ${describe(row.entry)}`);
    if (row.alias !== null && !isText(row.alias)) bad(`${where}.alias is ${describe(row.alias)}, not a name or null`);
    if (!CHECK_STATUSES.includes(row.status)) bad(`${where}.status is ${describe(row.status)}, not one of: ${CHECK_STATUSES.join(', ')}`);
    if (row.httpStatus !== null && !isCount(row.httpStatus)) bad(`${where}.httpStatus is ${describe(row.httpStatus)}, not a status code or null`);
    if (row.url !== null && !isUrl(row.url)) bad(`${where}.url is ${describe(row.url)}, not a URL or null`);
    if (!isTime(row.checkedAt)) bad(`${where}.checkedAt is ${describe(row.checkedAt)}, not a time as toISOString() writes it, or a date`);
    if (row.latestVersion !== null && !isText(row.latestVersion)) bad(`${where}.latestVersion is ${describe(row.latestVersion)}, not a version or null`);
    if (row.latestReleaseAt !== null && !isTime(row.latestReleaseAt)) bad(`${where}.latestReleaseAt is ${describe(row.latestReleaseAt)}, not a time as toISOString() writes it, a date or null`);
    const label = row.alias === null ? describe(row.entry) : `${describe(row.entry)} by its alias ${describe(row.alias)}`;
    const key = `${row.entry}\0${row.alias ?? ''}`;
    if (seen.has(key)) bad(`${where} checks ${label} a second time`);
    seen.add(key);
    if (!registry) return;
    const entry = registry.byName.get(row.entry);
    if (!entry) {
      bad(`${where} checks ${describe(row.entry)}, which is not a ${eco} entry of the catalogue snapshot`);
      return;
    }
    if (row.alias !== null && !entry.aliases.some((alias) => alias.name === row.alias)) {
      bad(`${where} checks the alias ${describe(row.alias)}, which ${entry.name} does not have in the catalogue snapshot`);
      return;
    }
    // The blocking rules read entry rows; an alias row blocks nothing.
    if (row.alias !== null) return;
    if (entry.unmatchable !== null) {
      if (!['notApplicable', 'absent'].includes(row.status)) {
        bad(`${where}: ${entry.name} is tagged unmatchable, and the registry check finds it ${describe(row.status)}. A name a manifest ` +
          'cannot declare is notApplicable or absent; present means the tag is wrong.');
      }
      return;
    }
    if ((row.status === 'absent') !== (entry.registryAbsent !== null)) {
      bad(`${where}: the scan's own registry check finds ${entry.name} ${describe(row.status)}, and the catalogue snapshot ` +
        `${entry.registryAbsent === null ? 'does not tag it registryAbsent' : 'tags it registryAbsent'}. The two have to agree, ` +
        'since the tag decides whether the entry counts toward K.');
    }
    if (row.status === 'unresolved' && entry.classified === true) {
      bad(`${where}: the registry check of ${label} is unresolved. For a classified entry that leaves K unestablished, and ` +
        'publication waits for a check that resolves.');
    }
  });
  if (!registry) return;
  for (const entry of registry.entries) {
    for (const alias of [null, ...entry.aliases.map((a) => a.name)]) {
      if (!seen.has(`${entry.name}\0${alias ?? ''}`)) {
        bad(`${file}: catalogCheck has no row for ${entry.name}${alias === null ? '' : ` by its alias ${alias}`}. The scan's ` +
          'own check covers every catalogue entry of the registry and every alias.');
      }
    }
  }
}

/** The declarations of one match: closed objects of the registry's kinds. */
function checkDeclarations(eco, declarations, where, bad) {
  if (!Array.isArray(declarations) || declarations.length === 0) {
    bad(`${where}.declarations is ${describe(declarations)}. A match has at least one declaration: it says how the manifest declares the name.`);
    return false;
  }
  const spec = DECLARATIONS[eco];
  const keys = ['kind', ...Object.keys(spec.members)];
  let sound = true;
  declarations.forEach((d, index) => {
    const at = `${where}.declarations[${index}]`;
    if (!closed(d, keys, at, bad)) {
      sound = false;
      return;
    }
    if (!spec.kinds.includes(d.kind)) {
      bad(`${at}.kind is ${describe(d.kind)}, not one of the ${eco} kinds: ${spec.kinds.join(', ')}`);
      sound = false;
    }
    for (const [member, type] of Object.entries(spec.members)) {
      if (!MEMBER_TYPES[type].test(d[member])) {
        bad(`${at}.${member} is ${describe(d[member])}, not ${MEMBER_TYPES[type].says}`);
        sound = false;
      }
    }
  });
  return sound;
}

function checkPackages(eco, packages, method, catalog, file, bad) {
  if (!Array.isArray(packages)) {
    bad(`${file}: packages is ${describe(packages)}, not a list`);
    return null;
  }
  const registry = catalog ? catalog.byEco[eco] : null;
  const names = new Set();
  let sound = true;
  packages.forEach((p, index) => {
    const label = isObject(p) && isText(p.name) ? ` (${p.name})` : '';
    const where = `${file}: packages[${index}]${label}`;
    const wrong = (message) => {
      bad(message);
      sound = false;
    };
    if (!closed(p, KEYS.package, where, bad)) {
      sound = false;
      return;
    }
    if (!isText(p.name)) wrong(`${where}.name is ${describe(p.name)}`);
    else if (names.has(p.name)) wrong(`${where} is listed a second time`);
    names.add(p.name);
    if (!isText(p.version)) wrong(`${where}.version is ${describe(p.version)}, not the version read`);
    if (method !== null && !method.readFrom.includes(p.readFrom)) {
      wrong(`${where}.readFrom is ${describe(p.readFrom)}, not one of method.readFrom (${method.readFrom.join(', ')})`);
    }
    const shape = PACKAGE_MANIFESTS[eco];
    if (shape) {
      if (!isObject(p.manifest) || !hasExactly(p.manifest, shape.keys) || !shape.test(p.manifest)) {
        wrong(`${where}.manifest is ${describe(p.manifest)}; for ${eco} it is ${shape.says}`);
      }
    } else if (p.manifest !== null) {
      wrong(`${where}.manifest is ${describe(p.manifest)}; ${eco} has no package-level facts, so it is null`);
    }
    if (!Array.isArray(p.matches) || p.matches.length === 0) {
      wrong(`${where}.matches is ${describe(p.matches)}. Only packages with a match are listed, so each has at least one.`);
      return;
    }
    p.matches.forEach((m, at) => {
      const there = `${where}.matches[${at}]`;
      if (!closed(m, KEYS.match, there, bad)) {
        sound = false;
        return;
      }
      if (!isText(m.declaredName)) wrong(`${there}.declaredName is ${describe(m.declaredName)}`);
      if (!MATCHED_BY.includes(m.matchedBy)) wrong(`${there}.matchedBy is ${describe(m.matchedBy)}, not one of: ${MATCHED_BY.join(', ')}`);
      const entry = registry && typeof m.entry === 'string' ? registry.byName.get(m.entry) : undefined;
      if (!isText(m.entry)) {
        wrong(`${there}.entry is ${describe(m.entry)}. It is always written, also when it equals the declared name.`);
      } else if (registry && !entry) {
        wrong(`${there}.entry is ${describe(m.entry)}, which is not a ${eco} entry of the catalogue snapshot`);
      } else if (entry && m.matchedBy === 'exact' && m.declaredName !== m.entry) {
        wrong(`${there} is matched exactly, but the declared name ${describe(m.declaredName)} is not the entry's name ${describe(m.entry)}`);
      } else if (entry && m.matchedBy === 'alias' && !entry.aliases.some((alias) => alias.name === m.declaredName)) {
        wrong(`${there} is matched by alias, but ${describe(m.declaredName)} is not an alias of ${m.entry} in the catalogue snapshot`);
      }
      if (!checkDeclarations(eco, m.declarations, there, bad)) sound = false;
    });
  });
  return sound ? packages : null;
}

function checkScan(name, eco, record, catalog, found, bad) {
  const file = record.file;
  const s = record.value;
  if (!closed(s, KEYS.scan, file, bad)) return null;
  const at = `${file}:`;
  if (s.kind !== 'censusScan') bad(`${at} kind is ${describe(s.kind)}, not "censusScan"`);
  if (s.ecosystem !== eco) bad(`${at} ecosystem is ${describe(s.ecosystem)}, and the file is the scan of ${eco}`);
  for (const field of ['startedAt', 'finishedAt']) {
    if (!isTime(s[field])) bad(`${at} ${field} is ${describe(s[field])}, not a time as toISOString() writes it, or a date`);
  }
  if (closed(s.scanner, KEYS.scanner, `${at} scanner`, bad)) {
    if (!isText(s.scanner.script)) bad(`${at} scanner.script is ${describe(s.scanner.script)}`);
    if (!isText(s.scanner.commit)) {
      bad(`${at} scanner.commit is ${describe(s.scanner.commit)}. A published scan names the instrument commit it ran; null ` +
        'belongs to a local run.');
    }
    if (!isText(s.scanner.workflowRun)) {
      bad(`${at} scanner.workflowRun is ${describe(s.scanner.workflowRun)}. A published scan names the workflow run that wrote ` +
        'it; null belongs to a local run.');
    }
  }
  checkSources(eco, s.sources, file, bad);
  const registry = catalog ? catalog.byEco[eco] : null;
  if (closed(s.catalog, KEYS.scanCatalog, `${at} catalog`, bad)) {
    if (!isCount(s.catalog.entries)) {
      bad(`${at} catalog.entries is ${describe(s.catalog.entries)}, not a count`);
    } else if (registry && s.catalog.entries !== registry.entries.length) {
      bad(`${at} catalog.entries is ${s.catalog.entries}, and the catalogue snapshot has ${registry.entries.length} ${eco} ` +
        'entries. A scan is matched against the catalogue the aggregate is classified with.');
    }
    if (!isSha256(s.catalog.matchSetSha256)) {
      bad(`${at} catalog.matchSetSha256 is ${describe(s.catalog.matchSetSha256)}, not a SHA-256 digest`);
    } else if (catalog && s.catalog.matchSetSha256 !== catalog.value.matchSetSha256) {
      bad(`${at} catalog.matchSetSha256 differs from the catalogue snapshot's. A scan matched against another set of names ` +
        'needs a new scan, not a new aggregation.');
    }
    if (!isText(s.catalog.matchRule)) {
      bad(`${at} catalog.matchRule is ${describe(s.catalog.matchRule)}, not a rule id`);
    } else if (catalog && isObject(catalog.value.matchRules) && s.catalog.matchRule !== catalog.value.matchRules[eco]) {
      bad(`${at} catalog.matchRule is ${describe(s.catalog.matchRule)}, and the catalogue snapshot's rule for ${eco} is ` +
        `${describe(catalog.value.matchRules[eco])}`);
    }
  }
  const method = checkMethod(eco, s.method, file, bad);
  checkEnumeration(eco, s.enumeration, file, bad);
  if (eco === 'go') {
    if (!isObject(s.versionYears) || !Object.keys(s.versionYears).every((year) => /^\d{4}$/.test(year)) ||
        !Object.values(s.versionYears).every(isCount)) {
      bad(`${at} versionYears is ${describe(s.versionYears)}, not an object of counts by year`);
    }
  } else if (s.versionYears !== null) {
    bad(`${at} versionYears is ${describe(s.versionYears)}; it is kept for Go alone and is null for ${eco}`);
  }
  const coverage = checkScanCoverage(s.coverage, method, file, bad);
  if (coverage && isObject(s.enumeration) && s.enumeration.listed !== coverage.listed) {
    bad(`${at} enumeration.listed is ${describe(s.enumeration.listed)} and coverage.listed is ${coverage.listed}; both count ` +
      'the packages the scan set out to read');
  }
  if (closed(s.listing, KEYS.listing, `${at} listing`, bad)) {
    const expected = fileNameFor('listing', eco);
    const ledger = found.listings[eco];
    if (s.listing.file !== expected) bad(`${at} listing.file is ${describe(s.listing.file)}; the ledger of ${eco} is ${expected}`);
    if (!isSha256(s.listing.sha256)) {
      bad(`${at} listing.sha256 is ${describe(s.listing.sha256)}, not a SHA-256 digest`);
    } else if (ledger && s.listing.sha256 !== ledger.sha256) {
      bad(`${at} listing.sha256 does not match ${expected}. The scan file is bound to the ledger it was written with.`);
    }
    if (!isCount(s.listing.rows)) {
      bad(`${at} listing.rows is ${describe(s.listing.rows)}, not a count`);
    } else if (coverage && s.listing.rows !== coverage.listed) {
      bad(`${at} listing.rows is ${s.listing.rows} and coverage.listed is ${coverage.listed}; the ledger has one row per listed package`);
    }
  }
  checkCatalogCheck(eco, s.catalogCheck, catalog, file, bad);
  const packages = checkPackages(eco, s.packages, method, catalog, file, bad);
  if (!isCount(s.packagesWithMatch)) {
    bad(`${at} packagesWithMatch is ${describe(s.packagesWithMatch)}, not a count`);
  } else if (Array.isArray(s.packages) && s.packagesWithMatch !== s.packages.length) {
    bad(`${at} packagesWithMatch is ${s.packagesWithMatch}, and packages lists ${s.packages.length}. Only packages with a ` +
      'match are listed, so the two are one count.');
  } else if (s.packagesWithMatch === 0) {
    bad(`${at} matched no package. A registry that matched nothing fails checks.noMatches: a scan that went wrong and a ` +
      'registry without cryptography look the same in it.');
  }
  return { file, value: s, method, coverage, packages, sound: method !== null && coverage !== null && packages !== null };
}

// --- The listing ledgers --------------------------------------------------------

/**
 * The ceiling on packages listed and not read: a registry whose unresolved
 * count is above 1 in 100 of the packages it listed is a withheld row, not
 * published and summed by no total. Held here independently of the code that
 * produces the files, and compared in whole numbers.
 */
const ONE_IN = 100;

/**
 * The most a listing ledger may decompress to. A small gzip file can expand a
 * thousandfold, so without a bound one could exhaust the memory of whoever
 * checks it. The schema version 2 contract estimates about 160 MB for all
 * eleven ledgers together.
 */
const MAX_LEDGER_BYTES = 1024 * 1024 * 1024;

const LEDGER_COLUMNS = ['name', 'disposition', 'reason', 'version', 'readFrom', 'observable', 'matches'];

/**
 * The columns a registry's ledger adds after the seven, held exactly: for
 * Packagist the type of the version read, registry text that is empty unless
 * the package was read; for Maven the search page the package was drawn from,
 * counted from 0, on every row. The other nine registries keep the seven.
 */
const LEDGER_EXTRA_COLUMNS = { packagist: ['type'], maven: ['page'] };
const ledgerColumns = (eco) => [...LEDGER_COLUMNS, ...(LEDGER_EXTRA_COLUMNS[eco] ?? [])];

/**
 * What no field of a ledger row may hold: the C0 and C1 controls, DEL, and the
 * characters that change the direction text is shown in. A name that carries
 * one can display as another, in a file read by people as well as by code.
 */
const LEDGER_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * The most one listing ledger may hold on disk, and the eleven together: every
 * copy of this repository carries them. Each limit is held once, here.
 */
const MAX_LEDGER_FILE_BYTES = 45_000_000;
const MAX_LEDGERS_BYTES = 100_000_000;
const LEDGER_LIMIT = {
  bytes: MAX_LEDGER_FILE_BYTES,
  what: 'a listing ledger',
  why: 'Every copy of this repository carries the ledgers, so each is bounded.',
};
const LEDGER_REASONS = {
  scanned: [''],
  absent: ['http404', 'http410'],
  unresolved: ['timeout', 'network', 'http429', 'http5xx', 'httpOther', 'parseError', 'oversize'],
  unversioned: ['noRelease', 'allYanked', 'noDefaultBranch'],
};

/** Read one ledger: decompressed within the bound, one row per listed package, sorted by name in byte order. */
function readLedger(eco, listing, scan, bad) {
  const file = listing.file;
  const columns = ledgerColumns(eco);
  let data;
  try {
    data = gunzipSync(listing.buffer, { maxOutputLength: MAX_LEDGER_BYTES });
  } catch (err) {
    bad(err.code === 'ERR_BUFFER_TOO_LARGE'
      ? `${file} decompresses to more than ${MAX_LEDGER_BYTES.toLocaleString('en-US')} bytes, the most a ledger may hold. ` +
        'Read whole, a file like it could exhaust the memory of whoever checks it.'
      : `${file} is not a gzip file: ${err.message}`);
    return null;
  }
  const readFrom = scan.method ? scan.method.readFrom : null;
  const counts = { listed: 0, scanned: 0, absent: 0, unresolved: 0, unversioned: 0, dependenciesNotObservable: 0 };
  const byReadFrom = {};
  const hiddenByReadFrom = {};
  const matched = new Map();
  // Maven's draw is of search pages: the distinct pages its rows were drawn from are the pages it read.
  const pages = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let problems = 0;
  const rowBad = (line, message) => {
    problems += 1;
    if (problems <= 5) bad(`${file}: row ${line} ${message}`);
  };
  let position = 0;
  let line = 0;
  let previous = null;
  while (position < data.length) {
    let end = data.indexOf(10, position);
    if (end === -1) end = data.length;
    const bytes = data.subarray(position, end);
    position = end + 1;
    line += 1;
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      rowBad(line, 'is not UTF-8');
      continue;
    }
    if (line === 1) {
      if (text !== columns.join('\t')) {
        bad(`${file} does not begin with the header row (${columns.join(', ')}, tab-separated). Without it no column ` +
          'can be read as what it says.');
        return null;
      }
      continue;
    }
    counts.listed += 1;
    const fields = text.split('\t');
    const forbidden = fields.findIndex((field) => LEDGER_FORBIDDEN.test(field));
    if (forbidden >= 0) {
      rowBad(line, `has a control or direction character in its ${columns[forbidden] ?? `column ${forbidden + 1}`} column. A name ` +
        'that carries one can display as another.');
      continue;
    }
    if (fields.length !== columns.length) {
      rowBad(line, `has ${fields.length} columns. Every row of the ${eco} ledger has all ${columns.length} of its header's columns.`);
      continue;
    }
    const [name, disposition, reason, version, source, observable, matches] = fields;
    const extra = fields[7];
    const scanned = disposition === 'scanned';
    if (!Object.hasOwn(LEDGER_REASONS, disposition)) {
      rowBad(line, `has the disposition ${describe(disposition)}, not scanned, absent, unresolved or unversioned`);
      continue;
    }
    if (name === '') {
      rowBad(line, 'has no name');
      continue;
    }
    const nameBytes = bytes.subarray(0, bytes.indexOf(9));
    if (previous !== null && Buffer.compare(previous, nameBytes) >= 0) {
      rowBad(line, `(${name}) does not follow the row above it. Rows are sorted by name in byte order, one per package, so ` +
        'that a row is found, and the acceptance sample drawn, the same way every time.');
    }
    previous = nameBytes;
    if (!LEDGER_REASONS[disposition].includes(reason)) {
      rowBad(line, `(${name}) gives the reason ${describe(reason)} for ${disposition}; it is one of: ` +
        `${LEDGER_REASONS[disposition].map((r) => (r === '' ? 'empty' : r)).join(', ')}`);
      continue;
    }
    counts[disposition] += 1;
    if (eco === 'maven' && !/^(0|[1-9][0-9]{0,8})$/.test(extra)) {
      rowBad(line, `(${name}) has page ${describe(extra)}, not the search page it was drawn from, counted from 0`);
    } else if (eco === 'maven') {
      pages.add(Number(extra));
    }
    if (!scanned) {
      if ([version, source, observable, matches, ...(eco === 'packagist' ? [extra] : [])].some((field) => field !== '')) {
        rowBad(line, `(${name}) records a version, a source, an observation, matches or a type for a package that was not read`);
      }
      continue;
    }
    if (eco === 'packagist' && extra === '') rowBad(line, `(${name}) is scanned with no type of the version read`);
    if (version === '') rowBad(line, `(${name}) is scanned with no version read`);
    if (readFrom !== null && !readFrom.includes(source)) rowBad(line, `(${name}) is read from ${describe(source)}, not one of method.readFrom`);
    if (observable !== '0' && observable !== '1') rowBad(line, `(${name}) has observable ${describe(observable)}, not 1 or 0`);
    if (!/^(0|[1-9][0-9]{0,8})$/.test(matches)) {
      rowBad(line, `(${name}) has matches ${describe(matches)}, not a whole count`);
      continue;
    }
    byReadFrom[source] = (byReadFrom[source] ?? 0) + 1;
    if (observable === '0') {
      counts.dependenciesNotObservable += 1;
      hiddenByReadFrom[source] = (hiddenByReadFrom[source] ?? 0) + 1;
    }
    if (Number(matches) > 0) matched.set(name, { version, readFrom: source, matches: Number(matches) });
  }
  if (line === 0) {
    bad(`${file} is empty. A ledger has a header row and one row per listed package.`);
    return null;
  }
  if (problems > 5) bad(`${file}: ${problems - 5} more row(s) are malformed`);
  return { file, counts, byReadFrom, hiddenByReadFrom, matched, pages, sound: problems === 0 };
}

/** The scan file against its ledger: coverage is recomputed from the rows, and the matched rows are the packages listed. */
function compareLedger(eco, ledger, scan, bad) {
  const file = scan.file;
  const c = ledger.counts;
  if (scan.coverage) {
    for (const field of COVERAGE_COUNTS) {
      if (scan.coverage[field] !== c[field]) {
        bad(`${file}: coverage.${field} is ${scan.coverage[field]}, and ${ledger.file} gives ${c[field]}. Coverage is ` +
          'recomputed from the ledger, so a count cannot move without the rows that make it.');
      }
    }
    for (const source of new Set([...Object.keys(scan.coverage.scannedByReadFrom), ...Object.keys(ledger.byReadFrom)])) {
      const stored = scan.coverage.scannedByReadFrom[source] ?? 0;
      const counted = ledger.byReadFrom[source] ?? 0;
      if (stored !== counted) {
        bad(`${file}: coverage.scannedByReadFrom gives ${stored} for ${describe(source)}, and ${ledger.file} gives ${counted}`);
      }
    }
  }
  if (Array.isArray(scan.value.packages)) {
    for (const p of scan.value.packages) {
      if (!isObject(p) || !isText(p.name)) continue;
      const row = ledger.matched.get(p.name);
      if (!row) {
        bad(`${file}: ${p.name} is in packages, and ${ledger.file} records no match for it. The ledger and the scan file ` +
          'are written together, so a match added to one shows in the other.');
        continue;
      }
      if (Array.isArray(p.matches) && row.matches !== p.matches.length) {
        bad(`${file}: ${p.name} has ${p.matches.length} match record(s), and ${ledger.file} records ${row.matches}`);
      }
      if (row.version !== p.version) bad(`${file}: ${p.name} was read at ${describe(p.version)}, and ${ledger.file} says ${row.version}`);
      if (row.readFrom !== p.readFrom) bad(`${file}: ${p.name} was read from ${describe(p.readFrom)}, and ${ledger.file} says ${row.readFrom}`);
    }
    const listed = new Set(scan.value.packages.filter(isObject).map((p) => p.name));
    for (const [name, row] of ledger.matched) {
      if (!listed.has(name)) {
        bad(`${ledger.file} records ${row.matches} match(es) for ${name}, which ${file} does not list. A match deleted from ` +
          'the scan file still shows in the ledger.');
      }
    }
  }
}

// --- The consolidation map ------------------------------------------------------

/** The id every figure is read with. A definition that changes takes the next integer, so an id these rules do not know fails. */
const DEFINITIONS = {
  coverage: 'census.coverage/1',
  anyManifestMatch: 'census.match.anyManifest/1',
  directUnconditional: 'census.match.directUnconditional/1',
  raw: 'census.unit.package/1',
  consolidated: 'census.unit.consolidated/1',
  multiPurposeLibrary: 'census.table.multiPurposeLibrary/1',
};

/**
 * The namespace that makes packages one unit under census.unit.consolidated/1:
 * an npm scope, a Maven groupId, a Packagist vendor, the first three elements
 * of a Go path. Names only, any size, and nothing is removed. A registry not
 * named here has no namespace, so each of its packages is its own unit.
 */
const NAMESPACE = {
  npm: (name) => (name.startsWith('@') && name.includes('/') ? name.slice(0, name.indexOf('/')) : null),
  maven: (name) => (name.includes(':') ? name.slice(0, name.indexOf(':')) : null),
  packagist: (name) => (name.includes('/') ? name.slice(0, name.indexOf('/')) : null),
  go: (name) => name.split('/').slice(0, 3).join('/'),
};

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

Object.assign(KEYS, {
  consolidation: ['schemaVersion', 'kind', 'collectedAt', 'definitionId', 'rules', 'byEcosystem'],
  rule: ['id', 'statement'],
  consolidationEcosystem: ['units', 'removed'],
  unit: ['unit', 'members'],
  removal: ['name', 'rule'],
});

function checkConsolidation(name, record, scans, withScanFile, bad) {
  const file = record.file;
  const c = record.value;
  if (!closed(c, KEYS.consolidation, file, bad)) return null;
  let sound = true;
  if (c.kind !== 'censusConsolidation') bad(`${file}: kind is ${describe(c.kind)}, not "censusConsolidation"`);
  if (c.collectedAt !== name) bad(`${file}: collectedAt is ${describe(c.collectedAt)}, not the dataset's date ${name}`);
  if (c.definitionId !== DEFINITIONS.consolidated) {
    bad(`${file}: definitionId is ${describe(c.definitionId)}, not ${DEFINITIONS.consolidated}, the one rule set these rules know`);
    sound = false;
  }
  const ruleIds = new Set();
  if (!Array.isArray(c.rules)) {
    bad(`${file}: rules is ${describe(c.rules)}, not a list`);
    sound = false;
  } else {
    c.rules.forEach((rule, index) => {
      if (!closed(rule, KEYS.rule, `${file}: rules[${index}]`, bad)) return;
      if (!isText(rule.id) || ruleIds.has(rule.id)) bad(`${file}: rules[${index}].id is ${describe(rule.id)}, not a rule id of its own`);
      if (!isText(rule.statement)) bad(`${file}: rules[${index}].statement is ${describe(rule.statement)}, not a statement of the rule`);
      ruleIds.add(rule.id);
    });
  }
  const byEco = {};
  if (!isObject(c.byEcosystem)) {
    bad(`${file}: byEcosystem is ${describe(c.byEcosystem)}, not an object by registry`);
    return null;
  }
  for (const key of Object.keys(c.byEcosystem)) {
    if (!ECOSYSTEMS.includes(key)) bad(`${file}: byEcosystem carries ${describe(key)}, which is not one of the eleven registries`);
  }
  for (const eco of ECOSYSTEMS) {
    const unitOf = new Map();
    const removedBy = new Map();
    const units = [];
    byEco[eco] = { unitOf, removedBy, units };
    if (!Object.hasOwn(c.byEcosystem, eco)) continue;
    const where = `${file}: byEcosystem.${eco}`;
    const section = c.byEcosystem[eco];
    if (!closed(section, KEYS.consolidationEcosystem, where, bad)) {
      sound = false;
      continue;
    }
    // A registry with no scan file has no package with a match, so its section places none.
    const known = !withScanFile.has(eco) ? new Set()
      : scans[eco] && Array.isArray(scans[eco].value.packages) ? new Set(scans[eco].value.packages.filter(isObject).map((p) => p.name)) : null;
    const place = (member, at) => {
      if (!isText(member)) {
        bad(`${at} names ${describe(member)}, not a package`);
        return false;
      }
      if (known && !known.has(member)) {
        bad(withScanFile.has(eco)
          ? `${at} names ${member}, which is not a package with a match in the scan file of ${eco}`
          : `${at} names ${member}, and the dataset holds no scan file of ${eco}, so no package of it has a match to place`);
        return false;
      }
      if (unitOf.has(member) || removedBy.has(member)) {
        bad(`${at} places ${member} a second time. Each package with a match is kept, merged into one unit, or removed.`);
        return false;
      }
      return true;
    };
    if (!Array.isArray(section.units)) {
      bad(`${where}.units is ${describe(section.units)}, not a list`);
      sound = false;
    } else {
      const seen = new Set();
      section.units.forEach((unit, index) => {
        const at = `${where}.units[${index}]`;
        if (!closed(unit, KEYS.unit, at, bad)) {
          sound = false;
          return;
        }
        if (!isText(unit.unit) || seen.has(unit.unit)) {
          bad(`${at}.unit is ${describe(unit.unit)}, not a name of its own`);
          sound = false;
          return;
        }
        seen.add(unit.unit);
        if (!Array.isArray(unit.members) || unit.members.length < 2) {
          bad(`${at}.members is ${describe(unit.members)}. The map lists merged units only, so a unit has two members or more.`);
          sound = false;
          return;
        }
        for (const member of unit.members) {
          if (place(member, at)) unitOf.set(member, unit.unit);
          else sound = false;
        }
        units.push({ unit: unit.unit, members: unit.members });
      });
    }
    if (!Array.isArray(section.removed)) {
      bad(`${where}.removed is ${describe(section.removed)}, not a list`);
      sound = false;
    } else {
      section.removed.forEach((removal, index) => {
        const at = `${where}.removed[${index}]`;
        if (!closed(removal, KEYS.removal, at, bad)) {
          sound = false;
          return;
        }
        if (!ruleIds.has(removal.rule)) {
          bad(`${at}.rule is ${describe(removal.rule)}, which is not a rule of this map`);
          sound = false;
        }
        if (place(removal.name, at)) removedBy.set(removal.name, removal.rule);
        else sound = false;
      });
    }
  }
  if (sound) checkConsolidationRule(byEco, scans, file, bad);
  return sound ? { byEco } : null;
}

/**
 * census.unit.consolidated/1, recomputed from the names: packages that share
 * a namespace are one unit, whatever its size, and no package is removed. A
 * map that merges anything else, or leaves a namespace apart, fails, whatever
 * figures it produces.
 */
function checkConsolidationRule(byEco, scans, file, bad) {
  for (const eco of ECOSYSTEMS) {
    const section = byEco[eco];
    for (const [member, rule] of section.removedBy) {
      bad(`${file}: byEcosystem.${eco} removes ${member} by ${rule}. Under ${DEFINITIONS.consolidated} consolidation only ` +
        'merges; no rule removes a package.');
    }
    if (!scans[eco] || !Array.isArray(scans[eco].value.packages)) continue;
    const namespace = NAMESPACE[eco];
    const groups = new Map();
    if (namespace) {
      for (const p of scans[eco].value.packages) {
        if (!isObject(p) || typeof p.name !== 'string') continue;
        const key = namespace(p.name);
        if (key === null) continue;
        let members = groups.get(key);
        if (!members) groups.set(key, (members = []));
        members.push(p.name);
      }
    }
    const expected = new Map([...groups].filter(([, members]) => members.length > 1)
      .map(([key, members]) => [canonical([...members].sort()), { key, members }]));
    const actual = new Map(section.units.map((unit) => [canonical([...unit.members].sort()), unit]));
    for (const [members, group] of expected) {
      if (!actual.has(members)) {
        bad(`${file}: byEcosystem.${eco} does not merge ${group.members.join(', ')}, which share ${group.key}. Under ` +
          `${DEFINITIONS.consolidated}, packages that share an npm scope, a Maven groupId, a Packagist vendor or the first ` +
          'three elements of a Go path are one unit, whatever its size.');
      }
    }
    for (const [members, unit] of actual) {
      if (!expected.has(members)) {
        bad(`${file}: byEcosystem.${eco} unit ${unit.unit} merges ${unit.members.join(', ')}, which are not the packages of ` +
          `one namespace. Under ${DEFINITIONS.consolidated} a unit is a namespace and nothing else.`);
      }
    }
  }
}

// --- The corpus ---------------------------------------------------------------
//
// Every figure in the corpus is a function of the other files, so each one is
// recomputed from them and compared. Nothing a producer writes is taken on
// trust: not a total, not a verdict, not a count a ledger can give.

const MAVEN_DIRECT_SCOPES = ['compile', 'runtime', 'provided', 'system'];

/**
 * When the declarations of one name in one manifest count as declared
 * directly and unconditionally (census.match.directUnconditional/1), by
 * registry. Evaluated here from the declarations a scan recorded; never read
 * from a stored flag.
 */
const DIRECT = {
  npm: (ds) => (ds.some((d) => d.kind === 'dependencies') && !ds.some((d) => d.kind === 'optionalDependencies')) ||
    ds.some((d) => d.kind === 'peerDependencies' && d.peerOptional === false),
  pypi: (ds) => ds.some((d) => d.marker === 'none'),
  go: (ds) => ds.some((d) => d.indirect === false),
  maven: (ds) => ds.some((d) => d.kind === 'project' && (d.scope === null || MAVEN_DIRECT_SCOPES.includes(d.scope)) && d.optional === false),
  crates: (ds) => ds.some((d) => d.kind === 'normal' && d.optional === false && d.target === null),
  packagist: (ds) => ds.some((d) => d.kind === 'require'),
  nuget: (ds, manifest) => manifest.dependencyGroups.every((group) => ds.some((d) => d.targetFramework === group)) ||
    ds.some((d) => d.targetFramework === null),
  rubygems: (ds) => ds.some((d) => d.kind === 'runtime'),
  hex: (ds) => ds.some((d) => d.optional === false),
  pub: (ds) => ds.some((d) => d.kind === 'dependencies'),
  // Some object with platform null that is topLevel, or a subspec whose first path element is a default
  // subspec (any subspec when defaultSubspecs is null, none when it is empty). A platform line is conditional
  // wherever it sits; platform, testspec and appspec objects never count.
  cocoapods: (ds, manifest) => ds.some((d) => d.platform === null && (d.kind === 'topLevel' || (d.kind === 'subspec' &&
    typeof d.subspec === 'string' && (manifest.defaultSubspecs === null || manifest.defaultSubspecs.includes(d.subspec.split('/')[0]))))),
};

/** The kinds that count as a match under census.match.anyManifest/1: every kind recorded, except Maven managed and plugin and Packagist suggest. */
const ANY_MANIFEST_KINDS = Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, DECLARATIONS[eco].kinds.filter((kind) =>
  !(eco === 'maven' && (kind === 'managed' || kind === 'plugin')) && !(eco === 'packagist' && kind === 'suggest'))]));

const CLASS_IDS = {
  matched: 'census.class.countableEntry/1',
  weak: 'census.class.weak/1',
  brokenAlgorithm: 'census.class.brokenAlgorithm/1',
  deprecatedLibrary: 'census.class.deprecatedLibrary/1',
  pqc: 'census.class.pqcDedicated/1',
};
const JOINT = ['weakAndPqc', 'neitherWeakNorPqc'];
const MATCH_DEFINITIONS = ['anyManifestMatch', 'directUnconditional'];
const UNITS = ['raw', 'consolidated'];

/** The codes for what changed in the instrument between two datasets. A version 1 dataset differs in all eleven. */
const CHANGE_CODES = ['enumerationFrame', 'versionSelection', 'manifestReader', 'declarationKinds', 'matchRule', 'matchSet',
  'coverageDefinition', 'matchDefinition', 'classDefinition', 'classification', 'consolidationRule'];

const isDoi = (v) => typeof v === 'string' && /^10\.\d{4,9}\/\S+$/.test(v);
const sameValue = (a, b) => canonical(a) === canonical(b);

const EXCLUSIONS = ['unclassified', 'registryAbsent', 'unmatchable'];

/** The same ceiling as a corpus writes it in its definitions. A corpus cannot set its own. */
const UNRESOLVED_CEILING = 1 / ONE_IN;

Object.assign(KEYS, {
  manifestEcosystem: ['ecosystem', 'coverage', 'enumeration', 'sources'],
  knownIssue: ['defect', 'summary', 'affects', 'direction', 'magnitude', 'correctedIn'],
  corpus: ['schemaVersion', 'kind', 'collectedAt', 'generatedAt', 'aggregator', 'inputs', 'definitions', 'comparability', 'blocked',
    'withheld', 'coverage', 'byEcosystem', 'total', 'multiPurposeLibraries'],
  withheld: ['ecosystem', 'reasons', 'coverage'],
  withheldReason: ['code', 'detail'],
  aggregator: ['script', 'commit'],
  inputs: ['scans', 'catalog', 'consolidation'],
  inputScan: ['ecosystem', 'file', 'sha256'],
  inputCatalog: ['file', 'sha256', 'matchSetSha256', 'classificationSha256'],
  inputConsolidation: ['file', 'sha256'],
  definitions: ['coverage', 'unresolvedCeiling', 'anyManifestMatch', 'directUnconditional', 'raw', 'consolidated', 'classes', 'multiPurposeLibrary'],
  id: ['id'],
  includes: ['id', 'includes'],
  predicate: ['id', 'predicate', 'code'],
  comparability: ['dataset', 'doi', 'comparable', 'reason', 'changes'],
  blocked: ['ecosystem', 'reason', 'detail'],
  corpusCoverage: ['total', 'byEcosystem'],
  rowCoverage: [...COVERAGE_COUNTS, 'scannedByReadFrom', 'enumeration', 'sources'],
  devCoverage: ['scanned', 'dependenciesNotObservable'],
  row: ['measurability', 'anyManifestMatch', 'directUnconditional', 'excludingDevMetadata'],
  total: ['anyManifestMatch', 'directUnconditional'],
  pair: ['raw', 'consolidated'],
  devRow: ['coverage', 'anyManifestMatch', 'directUnconditional'],
  measure: ['k', 'entries', 'excluded'],
  measureMatched: ['k', 'excluded'],
  exclusion: ['entry', 'why'],
  block: ['definitionId', ...CLASSES, ...JOINT, 'excludedUnclassified', 'excludedNotCountable'],
  consolidatedBlock: ['definitionId', ...CLASSES, ...JOINT, 'excludedUnclassified', 'excludedNotCountable', 'consolidation'],
  cell: ['count', 'k', 'nullReason'],
  totalCell: ['count', 'k', 'nullReason', 'measurableIn', 'notMeasurableIn'],
  jointCell: ['count', 'nullReason'],
  totalJointCell: ['count', 'nullReason', 'measurableIn', 'notMeasurableIn'],
  excludedUnclassified: ['matches', 'unitsWithOnlyUnclassifiedMatches', 'byEntry'],
  excludedNotCountable: ['matches', 'unitsWithOnlyNotCountableMatches', 'byEntry'],
  byEntry: ['entry', 'matches'],
  totalByEntry: ['ecosystem', 'entry', 'matches'],
  consolidationStats: ['unitsIn', 'unitsOut', 'merged', 'removedByRule'],
  multiPurposeLibrary: ['ecosystem', 'entry', 'definitionId', 'dependents'],
  magnitude: ['value', 'of', 'unit'],
});

// --- The corpus: figures recomputed ---------------------------------------------

/** The catalogue entries one package matched under one definition. */
function countedEntries(p, eco, definition, includes) {
  const entries = new Set();
  for (const m of p.matches) {
    const counts = definition === 'anyManifestMatch'
      ? m.declarations.some((d) => includes.includes(d.kind))
      : DIRECT[eco](m.declarations, p.manifest);
    if (counts) entries.add(m.entry);
  }
  return entries;
}

/**
 * The units of one figure block and the entries each matched: a package, or a
 * consolidated unit, among the packages with a match that counts under the
 * definition. A merged unit holds the union of its members' entries, so it
 * carries the union of their flags.
 */
function unitsOf(packages, eco, definition, includes, map) {
  const inBlock = [];
  for (const p of packages) {
    const entries = countedEntries(p, eco, definition, includes);
    if (entries.size > 0) inBlock.push({ name: p.name, entries });
  }
  if (map === null) return { units: inBlock.map((unit) => unit.entries), stats: null };
  const merged = new Map();
  const removedByRule = {};
  for (const { name, entries } of inBlock) {
    const rule = map.removedBy.get(name);
    if (rule !== undefined) {
      removedByRule[rule] = (removedByRule[rule] ?? 0) + 1;
      continue;
    }
    const unit = map.unitOf.get(name);
    const key = unit === undefined ? `package\0${name}` : `unit\0${unit}`;
    const union = merged.get(key) ?? new Set();
    for (const entry of entries) union.add(entry);
    merged.set(key, union);
  }
  const removed = sum(Object.values(removedByRule));
  return {
    units: [...merged.values()],
    stats: { unitsIn: inBlock.length, unitsOut: merged.size, merged: inBlock.length - merged.size - removed, removedByRule },
  };
}

/** One figure block as the files give it: a cell per class, the two joint cells, what was left out, and the consolidation. */
function figureBlock({ units, stats }, registry, definitionId) {
  const counts = Object.fromEntries([...CLASSES, ...JOINT].map((key) => [key, 0]));
  const unclassified = new Map(registry.unclassified.map((name) => [name, 0]));
  const notCountable = new Map(registry.notCountable.map((name) => [name, 0]));
  let onlyUnclassified = 0;
  let onlyNotCountable = 0;
  for (const entries of units) {
    const flags = Object.fromEntries(CLASSES.map((cls) => [cls, false]));
    let sawUnclassified = false;
    let sawNotCountable = false;
    for (const name of entries) {
      const entry = registry.byName.get(name);
      if (entry.classified !== true) {
        unclassified.set(name, unclassified.get(name) + 1);
        sawUnclassified = true;
      } else if (!isCountable(entry)) {
        // Counted only where it can be observed, so a count and its K cover the same entries.
        notCountable.set(name, notCountable.get(name) + 1);
        sawNotCountable = true;
      } else {
        for (const cls of CLASSES) if (IN_CLASS[cls](entry)) flags[cls] = true;
      }
    }
    for (const cls of CLASSES) if (flags[cls]) counts[cls] += 1;
    if (flags.weak && flags.pqc) counts.weakAndPqc += 1;
    if (flags.matched && !flags.weak && !flags.pqc) counts.neitherWeakNorPqc += 1;
    // A unit with no countable match is left out of every class: under its classified matches that cannot be
    // observed if it has any, otherwise under its unclassified ones.
    if (!flags.matched && sawNotCountable) onlyNotCountable += 1;
    else if (!flags.matched && sawUnclassified) onlyUnclassified += 1;
  }
  const block = { definitionId };
  for (const cls of CLASSES) {
    const k = registry.measure[cls].k;
    block[cls] = k === 0 ? { count: null, k: 0, nullReason: 'noCountableEntry' } : { count: counts[cls], k, nullReason: null };
  }
  const both = registry.measure.weak.k > 0 && registry.measure.pqc.k > 0;
  for (const joint of JOINT) {
    block[joint] = both ? { count: counts[joint], nullReason: null } : { count: null, nullReason: 'noCountableEntry' };
  }
  block.excludedUnclassified = {
    matches: sum([...unclassified.values()]),
    unitsWithOnlyUnclassifiedMatches: onlyUnclassified,
    byEntry: [...unclassified].map(([entry, matches]) => ({ entry, matches })),
  };
  block.excludedNotCountable = {
    matches: sum([...notCountable.values()]),
    unitsWithOnlyNotCountableMatches: onlyNotCountable,
    byEntry: [...notCountable].map(([entry, matches]) => ({ entry, matches })),
  };
  if (stats !== null) block.consolidation = stats;
  return { block, population: units.length };
}

/** Everything one registry's row of the corpus should hold, computed from its scan file, its ledger, the snapshot and the map. */
function expectedRow(eco, registry, scan, ledger, map, includes) {
  const blocksOf = (packages) => {
    const result = { blocks: {}, units: {}, populations: {} };
    for (const definition of MATCH_DEFINITIONS) {
      const raw = unitsOf(packages, eco, definition, includes, null);
      const consolidated = unitsOf(packages, eco, definition, includes, map);
      const rawBlock = figureBlock(raw, registry, `${DEFINITIONS[definition]}+${DEFINITIONS.raw}`);
      const consolidatedBlock = figureBlock(consolidated, registry, `${DEFINITIONS[definition]}+${DEFINITIONS.consolidated}`);
      result.blocks[definition] = { raw: rawBlock.block, consolidated: consolidatedBlock.block };
      result.units[definition] = { raw: raw.units, consolidated: consolidated.units };
      result.populations[definition] = { raw: rawBlock.population, consolidated: consolidatedBlock.population };
    }
    return result;
  };
  const all = blocksOf(scan.packages);
  const measurability = {};
  for (const cls of CLASSES) {
    const m = registry.measure[cls];
    measurability[cls] = cls === 'matched' ? { k: m.k, excluded: m.excluded } : { k: m.k, entries: m.entries, excluded: m.excluded };
  }
  const coverage = Object.fromEntries(COVERAGE_COUNTS.map((field) => [field, ledger.counts[field]]));
  const row = { measurability, anyManifestMatch: all.blocks.anyManifestMatch, directUnconditional: all.blocks.directUnconditional, excludingDevMetadata: null };
  let dev = null;
  // Packagist's dev metadata: the same figures over the packages not read from it, so that they are published with and without them.
  if (scan.method.readFrom.includes('devDefaultBranch')) {
    const read = ledger.byReadFrom.devDefaultBranch ?? 0;
    const hidden = ledger.hiddenByReadFrom.devDefaultBranch ?? 0;
    dev = blocksOf(scan.packages.filter((p) => p.readFrom !== 'devDefaultBranch'));
    dev.coverage = { ...coverage, listed: coverage.listed - read, scanned: coverage.scanned - read, dependenciesNotObservable: coverage.dependenciesNotObservable - hidden };
    row.excludingDevMetadata = { coverage: dev.coverage, anyManifestMatch: dev.blocks.anyManifestMatch, directUnconditional: dev.blocks.directUnconditional };
  }
  return { row, coverage, units: all.units, populations: all.populations, dev };
}

/** A total: each class cell sums the rows where the class is measurable, and says which rows those are. */
function totalOf(rows, consolidated, definitionId) {
  const total = { definitionId };
  for (const cls of CLASSES) {
    const measurable = rows.filter(({ block }) => block[cls].k > 0);
    total[cls] = {
      count: measurable.length === 0 ? null : sum(measurable.map(({ block }) => block[cls].count)),
      k: sum(measurable.map(({ block }) => block[cls].k)),
      nullReason: measurable.length === 0 ? 'noCountableEntry' : null,
      measurableIn: measurable.map(({ eco }) => eco),
      notMeasurableIn: rows.filter(({ block }) => block[cls].k === 0).map(({ eco }) => eco),
    };
  }
  // The two joint cells sum the rows where weak and pqc are both counted, and name them.
  for (const joint of JOINT) {
    const counted = rows.filter(({ block }) => block[joint].count !== null);
    total[joint] = {
      count: counted.length === 0 ? null : sum(counted.map(({ block }) => block[joint].count)),
      nullReason: counted.length === 0 ? 'noCountableEntry' : null,
      measurableIn: counted.map(({ eco }) => eco),
      notMeasurableIn: rows.filter(({ block }) => block[joint].count === null).map(({ eco }) => eco),
    };
  }
  for (const [group, spec] of Object.entries(EXCLUDED)) {
    total[group] = {
      matches: sum(rows.map(({ block }) => block[group].matches)),
      [spec.units]: sum(rows.map(({ block }) => block[group][spec.units])),
      byEntry: rows.flatMap(({ eco, block }) => block[group].byEntry.map((item) => ({ ecosystem: eco, ...item }))),
    };
  }
  if (consolidated) {
    total.consolidation = {
      unitsIn: sum(rows.map(({ block }) => block.consolidation.unitsIn)),
      unitsOut: sum(rows.map(({ block }) => block.consolidation.unitsOut)),
      merged: sum(rows.map(({ block }) => block.consolidation.merged)),
      removedByRule: {},
    };
  }
  return total;
}

/** The total of every row not withheld. A withheld row's figures are not published, so no total sums them. */
function expectedTotal(rows, withheld) {
  const published = publishedRows(withheld);
  return Object.fromEntries(MATCH_DEFINITIONS.map((definition) => [definition, Object.fromEntries(UNITS.map((unit) => [
    unit, totalOf(published.map((eco) => ({ eco, block: rows[eco].row[definition][unit] })), unit === 'consolidated',
      `${DEFINITIONS[definition]}+${DEFINITIONS[unit]}`)]))]));
}

// --- The corpus: comparison -----------------------------------------------------
//
// A block is read in three passes: its shape and the rules each cell states
// about itself; then the identities between its figures; then every figure
// against the value recomputed from the files. A figure that breaks an
// identity is reported as that before it is reported as one that does not
// follow from the files.

/** The rules a cell states about itself. True when the cell can be compared with its recomputed value. */
function cellRules(stored, where, keys, ctx) {
  if (!closed(stored, keys, where, ctx.bad)) return false;
  if (stored.count !== null && !isCount(stored.count)) {
    ctx.bad(`${where}.count is ${describe(stored.count)}, not a whole count or null. No share is stored: a share is computed where it is shown.`);
    return false;
  }
  if (keys.includes('k') && !isCount(stored.k)) {
    ctx.bad(`${where}.k is ${describe(stored.k)}, not a whole count`);
    return false;
  }
  if (stored.nullReason !== null && !['noCountableEntry', 'rowBlocked'].includes(stored.nullReason)) {
    ctx.bad(`${where}.nullReason is ${describe(stored.nullReason)}, not noCountableEntry, rowBlocked or null`);
    return false;
  }
  if (keys.includes('k') && stored.k === 0 && stored.count !== null) {
    ctx.bad(`${where} is ${describe(stored)}: count must be null when k is 0. No countable entry exists to be observed, and a 0 ` +
      'would read as a measured absence.');
    return false;
  }
  if (keys.includes('k') && stored.k > 0 && stored.count === null && stored.nullReason !== 'rowBlocked') {
    ctx.bad(`${where} is ${describe(stored)}: count is null while k is ${stored.k}. Null is kept for a figure that cannot be ` +
      'measured, and this one can; a measured zero is 0.');
    return false;
  }
  if ((stored.count === null) !== (stored.nullReason !== null)) {
    ctx.bad(`${where} is ${describe(stored)}: nullReason says why count is null, so it is set exactly when count is null`);
    return false;
  }
  if (keys.includes('measurableIn')) {
    for (const field of ['measurableIn', 'notMeasurableIn']) {
      const list = stored[field];
      if (!Array.isArray(list) || !list.every((eco) => ECOSYSTEMS.includes(eco)) || !isDistinct(list)) {
        ctx.bad(`${where}.${field} is ${describe(list)}, not a list of distinct registries`);
        return false;
      }
    }
  }
  return true;
}

function cellValue(stored, expected, where, keys, ctx) {
  const ordered = (cell) => (keys.includes('measurableIn')
    ? { ...cell, measurableIn: [...cell.measurableIn].sort(), notMeasurableIn: [...cell.notMeasurableIn].sort() } : cell);
  if (!sameValue(ordered(stored), ordered(expected))) {
    ctx.figureBad(`${where} is ${describe(stored)}; recomputed from the files it is bound to, it is ${describe(expected)}. A ` +
      'figure that does not follow from the scan files, the catalogue snapshot and the consolidation map is not a measurement.');
  }
}

/** What a block leaves out of every class, by the kind of entry: unclassified, or classified and not countable. */
const EXCLUDED = {
  excludedUnclassified: { units: 'unitsWithOnlyUnclassifiedMatches', what: 'unclassified' },
  excludedNotCountable: { units: 'unitsWithOnlyNotCountableMatches', what: 'classified and not countable' },
};

function excludedRules(stored, group, where, ctx, total) {
  if (!closed(stored, KEYS[group], where, ctx.bad)) return false;
  let ok = true;
  for (const field of ['matches', EXCLUDED[group].units]) {
    if (!isCount(stored[field])) {
      ctx.bad(`${where}.${field} is ${describe(stored[field])}, not a whole count`);
      ok = false;
    }
  }
  if (!Array.isArray(stored.byEntry)) {
    ctx.bad(`${where}.byEntry is ${describe(stored.byEntry)}, not a list`);
    return false;
  }
  stored.byEntry.forEach((item, index) => {
    if (!closed(item, total ? KEYS.totalByEntry : KEYS.byEntry, `${where}.byEntry[${index}]`, ctx.bad)) ok = false;
    else if (!isText(item.entry) || !isCount(item.matches) || (total && !ECOSYSTEMS.includes(item.ecosystem))) {
      ctx.bad(`${where}.byEntry[${index}] is ${describe(item)}, not ${total ? 'a registry, ' : 'an '}entry and a count`);
      ok = false;
    }
  });
  return ok;
}

function excludedValue(stored, expected, group, where, ctx) {
  for (const field of ['matches', EXCLUDED[group].units]) {
    if (stored[field] !== expected[field]) ctx.figureBad(`${where}.${field} is ${stored[field]}; recomputed it is ${expected[field]}`);
  }
  const items = (list) => list.map((item) => `${item.ecosystem ?? ''}\0${item.entry}\0${item.matches}`).sort();
  if (!sameValue(items(stored.byEntry), items(expected.byEntry))) {
    ctx.figureBad(`${where}.byEntry is ${describe(stored.byEntry)}; recomputed it is ${describe(expected.byEntry)}. It lists ` +
      `every ${EXCLUDED[group].what} entry of the registry, each with the units that matched it.`);
  }
}

function statsRules(stored, where, ctx) {
  if (!closed(stored, KEYS.consolidationStats, where, ctx.bad)) return false;
  let ok = true;
  for (const field of ['unitsIn', 'unitsOut', 'merged']) {
    if (!isCount(stored[field])) {
      ctx.bad(`${where}.${field} is ${describe(stored[field])}, not a whole count`);
      ok = false;
    }
  }
  if (!isObject(stored.removedByRule) || Object.keys(stored.removedByRule).length > 0) {
    ctx.bad(`${where}.removedByRule is ${describe(stored.removedByRule)}. Under ${DEFINITIONS.consolidated} no rule removes a ` +
      'package, so it is empty.');
    return false;
  }
  return ok;
}

function statsIdentity(stored, where, ctx) {
  if (stored.unitsIn !== stored.unitsOut + stored.merged) {
    ctx.bad(`${where}: unitsIn (${stored.unitsIn}) is not unitsOut + merged (${stored.unitsOut + stored.merged}). Every unit ` +
      'that goes in is kept or merged, once; no rule removes one.');
  }
}

/**
 * unitsIn and unitsOut against the map. merged is not compared apart: where
 * both are the map's and the identity above holds, it is the map's too.
 */
function statsValue(stored, expected, where, ctx) {
  for (const field of ['unitsIn', 'unitsOut']) {
    if (stored[field] !== expected[field]) ctx.figureBad(`${where}.${field} is ${stored[field]}; the consolidation map gives ${expected[field]}`);
  }
}

/** A block's shape and the rules its cells state about themselves. True when all of it can be read further. */
function blockRules(stored, consolidated, where, ctx, total) {
  if (!closed(stored, consolidated ? KEYS.consolidatedBlock : KEYS.block, where, ctx.bad)) return false;
  let ok = true;
  for (const cls of CLASSES) ok = cellRules(stored[cls], `${where}.${cls}`, total ? KEYS.totalCell : KEYS.cell, ctx) && ok;
  for (const joint of JOINT) ok = cellRules(stored[joint], `${where}.${joint}`, total ? KEYS.totalJointCell : KEYS.jointCell, ctx) && ok;
  for (const group of Object.keys(EXCLUDED)) ok = excludedRules(stored[group], group, `${where}.${group}`, ctx, total) && ok;
  if (consolidated) ok = statsRules(stored.consolidation, `${where}.consolidation`, ctx) && ok;
  return ok;
}

/** Every figure of a block against its recomputed value. */
function blockValues(stored, expected, where, ctx, total) {
  if (stored.definitionId !== expected.definitionId) {
    ctx.bad(`${where}.definitionId is ${describe(stored.definitionId)}, not ${expected.definitionId}. A figure is cited with ` +
      'the definitions it was counted under.');
  }
  for (const cls of CLASSES) cellValue(stored[cls], expected[cls], `${where}.${cls}`, total ? KEYS.totalCell : KEYS.cell, ctx);
  for (const joint of JOINT) cellValue(stored[joint], expected[joint], `${where}.${joint}`, total ? KEYS.totalJointCell : KEYS.jointCell, ctx);
  for (const group of Object.keys(EXCLUDED)) excludedValue(stored[group], expected[group], group, `${where}.${group}`, ctx);
  if (Object.hasOwn(expected, 'consolidation')) statsValue(stored.consolidation, expected.consolidation, `${where}.consolidation`, ctx);
}

/**
 * The identities the contract states for every block of a row, read from the
 * stored figures. Two follow from recomputing each figure from the scan file,
 * so neither is checked apart: that matched and the units of both exclusions
 * make every unit with a match that counts, and that in a raw block those
 * units are at most the file's packagesWithMatch.
 */
function blockIdentities(block, where, coverage, ctx) {
  const n = (cell) => (isObject(cell) && isCount(cell.count) ? cell.count : null);
  const [m, w, ba, dl, p, wp, nw] = [...CLASSES, ...JOINT].map((key) => n(block[key]));
  if ([m, w, p, wp, nw].every((x) => x !== null) && m !== w + p - wp + nw) {
    ctx.bad(`${where}: matched (${m}) is not weak (${w}) + pqc (${p}) - weakAndPqc (${wp}) + neitherWeakNorPqc (${nw}). The ` +
      'flags overlap, and these four parts are how a reader sees by how much.');
  }
  if ([w, ba, dl].every((x) => x !== null) && (w > ba + dl || w < Math.max(ba, dl))) {
    ctx.bad(`${where}: weak (${w}) is not between the larger of brokenAlgorithm (${ba}) and deprecatedLibrary (${dl}) and ` +
      'their sum. weak is the union of the two classes.');
  }
  if ((w === null || p === null) && (wp !== null || nw !== null)) {
    ctx.bad(`${where}: weakAndPqc or neitherWeakNorPqc is counted while weak or pqc is not measurable. Where post-quantum is ` +
      'not measurable, "neither" would assert an absence nobody measured.');
  }
  if (m !== null && coverage && m > coverage.scanned - coverage.dependenciesNotObservable) {
    ctx.bad(`${where}: matched (${m}) is more than the ${coverage.scanned - coverage.dependenciesNotObservable} packages read ` +
      'whose dependencies could be observed');
  }
}

/**
 * At a total the first identity holds only where its five cells sum the same
 * rows; elsewhere its parts are counted over different registries.
 */
function totalIdentity(block, where, ctx) {
  const cells = ['matched', 'weak', 'pqc', 'weakAndPqc', 'neitherWeakNorPqc'].map((key) => block[key]);
  if (!cells.every((cell) => isCount(cell.count))) return;
  const rowsOf = (cell) => [...cell.measurableIn].sort().join(' ');
  if (!cells.every((cell) => rowsOf(cell) === rowsOf(cells[0]))) return;
  const [m, w, p, wp, nw] = cells.map((cell) => cell.count);
  if (m !== w + p - wp + nw) {
    ctx.bad(`${where}: matched (${m}) is not weak (${w}) + pqc (${p}) - weakAndPqc (${wp}) + neitherWeakNorPqc (${nw}), and all ` +
      'five sum the same registries');
  }
}

/** A direct and unconditional declaration is also a manifest match, so no cell of that block exceeds the other's. */
function monotone(row, where, ctx) {
  const n = (cell) => (isObject(cell) && isCount(cell.count) ? cell.count : null);
  for (const unit of UNITS) {
    const any = isObject(row.anyManifestMatch) ? row.anyManifestMatch[unit] : null;
    const direct = isObject(row.directUnconditional) ? row.directUnconditional[unit] : null;
    if (!isObject(any) || !isObject(direct)) continue;
    for (const key of [...CLASSES, 'weakAndPqc']) {
      const x = n(any[key]);
      const d = n(direct[key]);
      if (x !== null && d !== null && d > x) {
        ctx.bad(`${where}: directUnconditional.${unit}.${key} (${d}) is more than anyManifestMatch.${unit}.${key} (${x}). A ` +
          'declaration that counts as direct counts as a manifest match too.');
      }
    }
  }
}

/** The blocks of a row, or of its figures without dev metadata, in the order they are read. */
function blocksOf(holder, expected, where, coverage, ctx) {
  const items = [];
  for (const definition of MATCH_DEFINITIONS) {
    if (!closed(holder[definition], KEYS.pair, `${where}.${definition}`, ctx.bad)) continue;
    for (const unit of UNITS) {
      items.push({ stored: holder[definition][unit], expected: expected[definition][unit], where: `${where}.${definition}.${unit}`, coverage, consolidated: unit === 'consolidated' });
    }
  }
  return items;
}

function compareMeasurability(stored, expected, registry, where, ctx) {
  if (!closed(stored, CLASSES, where, ctx.bad)) return;
  for (const cls of CLASSES) {
    const at = `${where}.${cls}`;
    const s = stored[cls];
    const e = expected[cls];
    if (!closed(s, cls === 'matched' ? KEYS.measureMatched : KEYS.measure, at, ctx.bad)) continue;
    if (s.k !== e.k) {
      ctx.figureBad(`${at}.k is ${describe(s.k)}; the catalogue snapshot has ${e.k} countable entries in this class. K ` +
        'follows from the snapshot and nothing else.');
    }
    if (cls !== 'matched') {
      if (!isTextList(s.entries) || !isDistinct(s.entries)) {
        ctx.bad(`${at}.entries is ${describe(s.entries)}, not a list of distinct entry names`);
      } else {
        if (cls === 'pqc') {
          for (const name of s.entries.filter((entry) => registry.multiPurpose.includes(entry))) {
            ctx.bad(`${at}.entries names ${name}, a multi-purpose library. One that ships post-quantum algorithms among others ` +
              'is listed apart and never counted as post-quantum.');
          }
        }
        if (!sameSet(s.entries, e.entries)) {
          ctx.figureBad(`${at}.entries is ${describe(s.entries)}; the countable entries of the snapshot are ${describe(e.entries)}`);
        }
      }
    }
    if (!Array.isArray(s.excluded) || !s.excluded.every((x, i) => closed(x, KEYS.exclusion, `${at}.excluded[${i}]`, ctx.bad) &&
        isText(x.entry) && EXCLUSIONS.includes(x.why))) {
      ctx.bad(`${at}.excluded is ${describe(s.excluded)}, not a list of { entry, why } with why one of: ${EXCLUSIONS.join(', ')}`);
    } else {
      const items = (list) => list.map((x) => `${x.entry}\0${x.why}`).sort();
      if (!sameValue(items(s.excluded), items(e.excluded))) {
        ctx.figureBad(`${at}.excluded is ${describe(s.excluded)}; the snapshot gives ${describe(e.excluded)}`);
      }
    }
  }
}

function compareMultiPurpose(stored, rows, withheld, catalog, file, ctx) {
  if (!Array.isArray(stored)) {
    ctx.bad(`${file}: multiPurposeLibraries is ${describe(stored)}, not a list`);
    return;
  }
  const expected = new Map();
  for (const eco of ECOSYSTEMS) {
    for (const entry of catalog.byEco[eco].multiPurpose) {
      const dependents = {};
      for (const definition of MATCH_DEFINITIONS) {
        dependents[definition] = {};
        for (const unit of UNITS) {
          dependents[definition][unit] = withheld.has(eco) ? null : rows[eco].units[definition][unit].filter((set) => set.has(entry)).length;
        }
      }
      expected.set(`${eco}\0${entry}`, { ecosystem: eco, entry, dependents });
    }
  }
  const seen = new Set();
  stored.forEach((item, index) => {
    const where = `${file}: multiPurposeLibraries[${index}]`;
    if (!closed(item, KEYS.multiPurposeLibrary, where, ctx.bad)) return;
    const key = `${item.ecosystem}\0${item.entry}`;
    if (!expected.has(key)) {
      ctx.bad(`${where} names ${describe(item.ecosystem)}:${describe(item.entry)}, which is not a multi-purpose entry of the catalogue snapshot`);
      return;
    }
    if (seen.has(key)) {
      ctx.bad(`${where} names ${item.ecosystem}:${item.entry} a second time`);
      return;
    }
    seen.add(key);
    if (item.definitionId !== DEFINITIONS.multiPurposeLibrary) {
      ctx.bad(`${where}.definitionId is ${describe(item.definitionId)}, not ${DEFINITIONS.multiPurposeLibrary}`);
    }
    const want = expected.get(key).dependents;
    if (!closed(item.dependents, MATCH_DEFINITIONS, `${where}.dependents`, ctx.bad)) return;
    for (const definition of MATCH_DEFINITIONS) {
      if (!closed(item.dependents[definition], UNITS, `${where}.dependents.${definition}`, ctx.bad)) continue;
      for (const unit of UNITS) {
        const value = item.dependents[definition][unit];
        if (want[definition][unit] === null) {
          if (value !== null) ctx.bad(`${where}.dependents.${definition}.${unit} is ${describe(value)}; ${item.ecosystem} is withheld, so it is null`);
        } else if (!isCount(value)) ctx.bad(`${where}.dependents.${definition}.${unit} is ${describe(value)}, not a whole count`);
        else if (value !== want[definition][unit]) {
          ctx.figureBad(`${where}.dependents.${definition}.${unit} is ${value}; recomputed it is ${want[definition][unit]}`);
        }
      }
    }
  });
  for (const [key, want] of expected) {
    if (!seen.has(key)) {
      ctx.bad(`${file}: multiPurposeLibraries has no row for ${want.ecosystem}:${want.entry}. Each multi-purpose library is ` +
        'listed, apart from every post-quantum count.');
    }
  }
}

// --- The corpus: its other fields -----------------------------------------------

function checkInputs(name, inputs, ctx, file, bad) {
  const where = `${file}: inputs`;
  if (!closed(inputs, KEYS.inputs, where, bad)) return;
  const hashOf = (bound) => ctx.found.hashes.get(bound);
  const binding = (value, keys, at, expectedFile) => {
    if (!closed(value, keys, at, bad)) return false;
    if (value.file !== expectedFile) {
      bad(`${at}.file is ${describe(value.file)}, not ${expectedFile}`);
      return false;
    }
    if (!isSha256(value.sha256)) {
      bad(`${at}.sha256 is ${describe(value.sha256)}, not a SHA-256 digest`);
    } else if (hashOf(expectedFile) !== undefined && value.sha256 !== hashOf(expectedFile)) {
      bad(`${at}.sha256 is not the hash of ${expectedFile}. The corpus is bound to the bytes it was computed from, and these ` +
        'are other bytes.');
    }
    return true;
  };
  if (!Array.isArray(inputs.scans)) {
    bad(`${where}.scans is ${describe(inputs.scans)}, not a list`);
  } else {
    const seen = new Set();
    inputs.scans.forEach((item, index) => {
      const at = `${where}.scans[${index}]`;
      if (!isObject(item) || !ECOSYSTEMS.includes(item.ecosystem)) {
        bad(`${at} is ${describe(item)}, not the binding of one registry's scan file`);
        return;
      }
      if (seen.has(item.ecosystem)) {
        bad(`${at} binds ${item.ecosystem} a second time`);
        return;
      }
      seen.add(item.ecosystem);
      if (!ctx.found.withScanFile.has(item.ecosystem)) {
        bad(`${at} binds the scan file of ${item.ecosystem}, which the dataset does not hold. The corpus binds one scan file per ` +
          'scan file it read, and each is in the dataset.');
        return;
      }
      binding(item, KEYS.inputScan, at, fileNameFor('scan', item.ecosystem));
    });
    for (const eco of ctx.found.withScanFile) {
      if (!seen.has(eco)) bad(`${where}.scans does not bind the scan file of ${eco}, which the dataset holds; it binds one per scan file read`);
    }
  }
  const catalogFile = fileNameFor('catalog', null, name);
  if (binding(inputs.catalog, KEYS.inputCatalog, `${where}.catalog`, catalogFile) && ctx.catalog) {
    for (const digest of ['matchSetSha256', 'classificationSha256']) {
      if (inputs.catalog[digest] !== ctx.catalog.value[digest]) {
        bad(`${where}.catalog.${digest} is not the catalogue snapshot's. The corpus names the classification it was computed with.`);
      }
    }
  }
  binding(inputs.consolidation, KEYS.inputConsolidation, `${where}.consolidation`, fileNameFor('consolidation', null, name));
}

/** The definitions a corpus is read with. Returns the kinds that count as a manifest match, or null if they cannot be used. */
function checkDefinitions(d, file, bad) {
  const where = `${file}: definitions`;
  if (!closed(d, KEYS.definitions, where, bad)) return null;
  for (const key of ['coverage', 'raw', 'consolidated', 'multiPurposeLibrary']) {
    if (closed(d[key], KEYS.id, `${where}.${key}`, bad) && d[key].id !== DEFINITIONS[key]) {
      bad(`${where}.${key}.id is ${describe(d[key].id)}, not ${DEFINITIONS[key]}. A definition that changes takes a new id, ` +
        'and these rules know this one.');
    }
  }
  if (d.unresolvedCeiling !== UNRESOLVED_CEILING) {
    bad(`${where}.unresolvedCeiling is ${describe(d.unresolvedCeiling)}. The ceiling is ${UNRESOLVED_CEILING}, held here as ` +
      'well, so that a corpus cannot set its own.');
  }
  if (closed(d.classes, CLASSES, `${where}.classes`, bad)) {
    for (const cls of CLASSES) {
      if (d.classes[cls] !== CLASS_IDS[cls]) bad(`${where}.classes.${cls} is ${describe(d.classes[cls])}, not ${CLASS_IDS[cls]}`);
    }
  }
  if (closed(d.directUnconditional, KEYS.predicate, `${where}.directUnconditional`, bad)) {
    if (d.directUnconditional.id !== DEFINITIONS.directUnconditional) {
      bad(`${where}.directUnconditional.id is ${describe(d.directUnconditional.id)}, not ${DEFINITIONS.directUnconditional}`);
    }
    if (!isText(d.directUnconditional.code)) {
      bad(`${where}.directUnconditional.code is ${describe(d.directUnconditional.code)}, not the module that evaluates the rule`);
    }
    if (closed(d.directUnconditional.predicate, ECOSYSTEMS, `${where}.directUnconditional.predicate`, bad)) {
      for (const eco of ECOSYSTEMS) {
        if (!isText(d.directUnconditional.predicate[eco])) bad(`${where}.directUnconditional.predicate.${eco} is ${describe(d.directUnconditional.predicate[eco])}, not the rule in words`);
      }
    }
  }
  if (!closed(d.anyManifestMatch, KEYS.includes, `${where}.anyManifestMatch`, bad)) return null;
  if (d.anyManifestMatch.id !== DEFINITIONS.anyManifestMatch) {
    bad(`${where}.anyManifestMatch.id is ${describe(d.anyManifestMatch.id)}, not ${DEFINITIONS.anyManifestMatch}`);
    return null;
  }
  if (!closed(d.anyManifestMatch.includes, ECOSYSTEMS, `${where}.anyManifestMatch.includes`, bad)) return null;
  let usable = true;
  for (const eco of ECOSYSTEMS) {
    const kinds = d.anyManifestMatch.includes[eco];
    if (!Array.isArray(kinds) || !isDistinct(kinds) || !kinds.every((kind) => DECLARATIONS[eco].kinds.includes(kind))) {
      bad(`${where}.anyManifestMatch.includes.${eco} is ${describe(kinds)}, not a list of distinct ${eco} declaration kinds`);
      usable = false;
    } else if (!sameSet(kinds, ANY_MANIFEST_KINDS[eco])) {
      bad(`${where}.anyManifestMatch.includes.${eco} is ${describe(kinds)}; under ${DEFINITIONS.anyManifestMatch} it is ` +
        `${describe(ANY_MANIFEST_KINDS[eco])}: every kind recorded, except Maven managed and plugin and Packagist suggest. A ` +
        'definition that changes takes a new id.');
    }
  }
  return usable ? d.anyManifestMatch.includes : null;
}

/** The change codes these rules recompute, each from the fields it names, for two version 2 datasets. */
const CHANGES_CHECKED = {
  versionSelection: (a, b) => ECOSYSTEMS.some((eco) => !sameValue(a.methods[eco]?.versionSelection, b.methods[eco]?.versionSelection)),
  declarationKinds: (a, b) => ECOSYSTEMS.some((eco) => !sameSet(a.methods[eco]?.declarationKinds ?? [], b.methods[eco]?.declarationKinds ?? [])),
  matchRule: (a, b) => !sameValue(a.matchRules, b.matchRules),
  matchSet: (a, b) => a.matchSetSha256 !== b.matchSetSha256,
  coverageDefinition: (a, b) => a.definitionIds.coverage !== b.definitionIds.coverage,
  matchDefinition: (a, b) => a.definitionIds.anyManifestMatch !== b.definitionIds.anyManifestMatch ||
    a.definitionIds.directUnconditional !== b.definitionIds.directUnconditional,
  classDefinition: (a, b) => !sameValue(a.definitionIds.classes, b.definitionIds.classes),
  classification: (a, b) => a.classificationSha256 !== b.classificationSha256,
  consolidationRule: (a, b) => a.definitionIds.consolidated !== b.definitionIds.consolidated,
};
// not checked yet: enumerationFrame and manifestReader, for which the
// schema version 2 contract names no field to compare. A dataset may name
// them or not.
const UNCHECKED_CHANGES = ['enumerationFrame', 'manifestReader'];

/**
 * A file read from beside what is being validated (an earlier dataset, or the
 * dataset an errata file describes), parsed, if it is a regular file of
 * bounded size nested within the bound; otherwise an error.
 */
function readBounded(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`${path} is not a regular file of a size these rules read`);
  const value = JSON.parse(readStrict(path));
  if (nestsDeeperThan(value, MAX_NESTING)) throw new Error(`${path} nests too deep`);
  return value;
}

/** The version of an earlier dataset, read from its manifest: 1 when it declares none. */
function versionOf(dataset) {
  try {
    const manifest = readBounded(join(DATASETS, dataset, 'MANIFEST.json'));
    if (!isObject(manifest)) return null;
    if (!Object.hasOwn(manifest, 'schemaVersion')) return 1;
    return manifest.schemaVersion === 2 ? 2 : null;
  } catch {
    return null;
  }
}

const definitionIds = (d) => ({
  coverage: d.coverage.id, anyManifestMatch: d.anyManifestMatch.id, directUnconditional: d.directUnconditional.id,
  raw: d.raw.id, consolidated: d.consolidated.id, classes: d.classes, multiPurposeLibrary: d.multiPurposeLibrary.id,
});

/** What two version 2 datasets have to share to be comparable: the match set, the definition ids, and every scanner's method. */
function instrumentOf(dataset) {
  try {
    const dir = join(DATASETS, dataset);
    const manifest = readBounded(join(dir, 'MANIFEST.json'));
    const read = (role, eco = null) => {
      const file = fileNameFor(role, eco, dataset);
      if (!manifest.files.some((entry) => entry.role === role && entry.ecosystem === eco && entry.file === file)) throw new Error(file);
      return readBounded(join(dir, file));
    };
    const catalog = read('catalog');
    return {
      matchSetSha256: catalog.matchSetSha256,
      classificationSha256: catalog.classificationSha256,
      matchRules: catalog.matchRules,
      definitionIds: definitionIds(read('corpus').definitions),
      methods: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, read('scan', eco).method])),
    };
  } catch {
    return null;
  }
}

function checkComparability(name, list, corpus, ctx, file, bad) {
  const where = `${file}: comparability`;
  if (!Array.isArray(list) || list.length === 0) {
    bad(`${where} is ${describe(list)}. It is required and names every earlier dataset, so that no surface draws a trend ` +
      'across an instrument change unseen.');
    return;
  }
  const earlier = readdirSync(DATASETS)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < name && lstatSync(join(DATASETS, d)).isDirectory()).sort();
  const named = new Set();
  list.forEach((item, index) => {
    const at = `${where}[${index}]`;
    if (!closed(item, KEYS.comparability, at, bad)) return;
    if (!earlier.includes(item.dataset)) {
      bad(`${at} names ${describe(item.dataset)}, which is not a dataset of this repository collected before ${name}`);
      return;
    }
    if (named.has(item.dataset)) {
      bad(`${at} names ${item.dataset} a second time`);
      return;
    }
    named.add(item.dataset);
    if (item.doi !== null && !isDoi(item.doi)) bad(`${at}.doi is ${describe(item.doi)}, not a DOI or null`);
    if (typeof item.comparable !== 'boolean') {
      bad(`${at}.comparable is ${describe(item.comparable)}, not true or false`);
      return;
    }
    if (!Array.isArray(item.changes) || !isDistinct(item.changes) || !item.changes.every((code) => CHANGE_CODES.includes(code))) {
      bad(`${at}.changes is ${describe(item.changes)}, not a list of distinct change codes (${CHANGE_CODES.join(', ')})`);
      return;
    }
    if (item.comparable && (item.reason !== null || item.changes.length > 0)) {
      bad(`${at} is comparable and still gives a reason or changes; a comparable dataset has reason null and no changes`);
    }
    if (!item.comparable && (item.reason !== 'instrumentChanged' || item.changes.length === 0)) {
      bad(`${at} is not comparable, so its reason is instrumentChanged and changes names what changed`);
    }
    const version = versionOf(item.dataset);
    if (version === 1) {
      if (item.comparable) {
        bad(`${at}: ${item.dataset} is a version 1 dataset, measured with an instrument that has since changed, so it is not ` +
          'comparable, and no difference, ratio or trend may be drawn between the two.');
      } else if (!sameSet(item.changes, CHANGE_CODES)) {
        bad(`${at}.changes is ${describe(item.changes)}. A version 1 dataset differs in every component, so it names all ` +
          `eleven codes (${CHANGE_CODES.join(', ')}).`);
      }
    } else if (version === 2) {
      const theirs = instrumentOf(item.dataset);
      let ours = null;
      try {
        ours = ctx.catalog ? {
          matchSetSha256: ctx.catalog.value.matchSetSha256,
          classificationSha256: ctx.catalog.value.classificationSha256,
          matchRules: ctx.catalog.value.matchRules,
          definitionIds: definitionIds(corpus.definitions),
          methods: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, ctx.scans[eco] ? ctx.scans[eco].value.method : null])),
        } : null;
      } catch {
        ours = null;
      }
      if (theirs === null || ours === null) {
        bad(`${at}: ${item.dataset} is a version 2 dataset whose instrument cannot be read beside this one's, so neither ` +
          'whether it is comparable nor the changes named can be checked');
        return;
      }
      if (item.comparable) {
        const differ = [];
        if (!sameValue(theirs.matchSetSha256, ours.matchSetSha256)) differ.push('the match set');
        if (!sameValue(theirs.definitionIds, ours.definitionIds)) differ.push('the definition ids');
        for (const eco of ECOSYSTEMS) if (!sameValue(theirs.methods[eco], ours.methods[eco])) differ.push(`the ${eco} scanner's method`);
        if (differ.length > 0) {
          bad(`${at}: ${item.dataset} is marked comparable, and these differ between the two datasets: ${differ.join(', ')}. Two ` +
            'datasets are comparable only when the match set, the definition ids and every scanner\'s method are the same.');
        }
      }
      // The change codes, recomputed from the fields each one names.
      const computed = Object.keys(CHANGES_CHECKED).filter((code) => CHANGES_CHECKED[code](theirs, ours));
      const stated = item.changes.filter((code) => !UNCHECKED_CHANGES.includes(code));
      if (!sameSet(stated, computed)) {
        bad(`${at}.changes is ${describe(item.changes)}; recomputed from the fields each code names, the two datasets differ in ` +
          `${describe(computed)}${UNCHECKED_CHANGES.length ? ` (and ${UNCHECKED_CHANGES.join(' and ')} are not recomputed)` : ''}`);
      }
    } else if (version === null) {
      bad(`${at}: ${item.dataset} has no manifest these rules can read, so whether it is comparable cannot be checked`);
    }
  });
  for (const dataset of earlier) {
    if (!named.has(dataset)) {
      bad(`${where} does not name ${dataset}. Every earlier dataset is named, so that a reader holding two of them knows ` +
        'whether the instrument changed between them.');
    }
  }
}

const BLOCK_REASONS = ['coverageInvalid', 'catalogCheckMismatch', 'sourcesOffAllowlist'];

/** True when the corpus blocks no row. A corpus that blocks one is not published, whatever its figures say. */
function checkBlocked(list, file, bad) {
  const where = `${file}: blocked`;
  if (!Array.isArray(list)) {
    bad(`${where} is ${describe(list)}, not a list`);
    return false;
  }
  list.forEach((item, index) => {
    const at = `${where}[${index}]`;
    if (!closed(item, KEYS.blocked, at, bad)) return;
    if (!ECOSYSTEMS.includes(item.ecosystem)) bad(`${at}.ecosystem is ${describe(item.ecosystem)}, not one of the eleven registries`);
    if (!BLOCK_REASONS.includes(item.reason)) bad(`${at}.reason is ${describe(item.reason)}, not one of: ${BLOCK_REASONS.join(', ')}`);
    if (!isText(item.detail)) bad(`${at}.detail is ${describe(item.detail)}, not text`);
  });
  if (list.length > 0) {
    bad(`${where} names ${list.map((item) => (isObject(item) ? describe(item.ecosystem) : describe(item))).join(', ')}. A corpus ` +
      'that blocks a row is not published: the row\'s figures and every total are withheld until it is measured again.');
    return false;
  }
  return true;
}

/** Why a row may be withheld, as the aggregator writes it. A withheld row is not published, and no total sums it. */
const WITHHELD_CODES = ['noScanFile', 'listingNotWhole', 'notUnderPopulationRule', 'sampleNotDrawnToSize', 'seedNotRunId',
  'unresolvedShareAboveCeiling'];

/**
 * The population rule: which packages a scan of each registry sets out to
 * read. A literal copy of the instrument's POPULATION (lib/census/population.mjs
 * at 56078ea, lines 59 to 71, its three constants written out), held here
 * apart from the code that writes the files, as JSON text so that a reader
 * that does not run this script can parse it and recompute its digest. Eight
 * registries are read whole from their listing; npm, Go and Maven are seeded
 * draws of `size` from the frame their listing names, Maven by pages of
 * `pageRows` rows. `source` is the listing read, which the allowlist holds as
 * the scan's enumeration source; `frameDays` bounds Go's frame, which no
 * field of a scan records whole. Neither decides a withholding code here.
 */
const POPULATION_RULE_JSON = `{
  "pypi": {"rule": "listing", "source": "https://pypi.org/simple/"},
  "packagist": {"rule": "listing", "source": "https://packagist.org/packages/list.json"},
  "rubygems": {"rule": "listing", "source": "https://index.rubygems.org/names"},
  "nuget": {"rule": "listing", "source": "https://api.nuget.org/v3/catalog0/index.json"},
  "hex": {"rule": "listing", "source": "https://hex.pm/api/packages"},
  "pub": {"rule": "listing", "source": "https://pub.dev/api/package-names"},
  "crates": {"rule": "listing", "source": "https://github.com/rust-lang/crates.io-index.git"},
  "cocoapods": {"rule": "listing", "source": "https://cdn.cocoapods.org/all_pods.txt"},
  "npm": {"rule": "sample", "source": "https://replicate.npmjs.com/_all_docs", "size": 385000, "draw": "package"},
  "go": {"rule": "sample", "source": "https://index.golang.org/index", "size": 385000, "draw": "package", "frameDays": 365},
  "maven": {"rule": "sample", "source": "https://search.maven.org/solrsearch/select", "size": 385000, "draw": "page", "pageRows": 200}
}`;
const POPULATION_RULE = Object.freeze(Object.fromEntries(Object.entries(JSON.parse(POPULATION_RULE_JSON))
  .map(([eco, rule]) => [eco, Object.freeze(rule)])));

/**
 * The row the rule sets for a registry, in the fields a scan header writes: a
 * row read whole samples by `all`, with no size, draw, page size or seed; a
 * draw is a seeded shuffle of the rule's size, by its draw.
 */
const ruledRow = (eco) => {
  const rule = POPULATION_RULE[eco];
  return rule.rule === 'listing'
    ? { method: 'all', requested: null, draw: null, pageRows: null }
    : { method: 'seededShuffle', requested: rule.size, draw: rule.draw, pageRows: rule.draw === 'page' ? rule.pageRows : null };
};

/** A run of the instrument's workflow, and the id that ends it: the seed of every draw that run made. */
const INSTRUMENT_RUN = /^https:\/\/github\.com\/opena2a-org\/crypto-census\/actions\/runs\/(\d+)$/;

/**
 * Every reason the files give to withhold a registry's row, each
 * `{ code, why }`, recomputed from its scan file, its ledger and the rule
 * above; null when they cannot be read far enough to say, which their own
 * checks have already reported. A row not read under the rule is withheld for
 * that alone; whether it was read whole, drawn to size or seeded with its run's
 * id is asked only of a row that was. The ceiling is asked of every row.
 */
function withholdingReasons(eco, scan, ledger) {
  if (!scan || !scan.coverage || !ledger || !ledger.sound) return null;
  const e = scan.value.enumeration;
  if (!isObject(e) || !isObject(e.sampling)) return null;
  const s = e.sampling;
  const listed = scan.coverage.listed;
  const reasons = [];
  const add = (code, why) => reasons.push({ code, why });
  const ruled = ruledRow(eco);
  const misfit = [];
  for (const [field, value, want] of [['sampling.method', s.method, ruled.method], ['requested', e.requested, ruled.requested],
    ['sampling.draw', s.draw, ruled.draw], ['sampling.pageRows', s.pageRows, ruled.pageRows]]) {
    if (value !== want) misfit.push(`${field} is ${describe(value)}, and the rule's is ${describe(want)}`);
  }
  if (POPULATION_RULE[eco].rule === 'listing' && s.seed !== null) misfit.push(`a row read whole carries the seed ${describe(s.seed)}`);
  if (!Number.isInteger(e.frameSize)) misfit.push(`frameSize is ${describe(e.frameSize)}, so the listing was not fetched whole`);
  if (misfit.length > 0) {
    add('notUnderPopulationRule', misfit.join('; '));
  } else if (POPULATION_RULE[eco].rule === 'listing') {
    if (e.truncated === true || listed !== e.frameSize) {
      add('listingNotWhole', `listed ${listed} of the ${e.frameSize} its listing holds${e.truncated === true ? ', truncated' : ''}`);
    }
  } else {
    if (s.draw === 'page') {
      const read = ledger.pages.size;
      const due = Math.min(Math.ceil(e.frameSize / s.pageRows), Math.ceil(e.requested / s.pageRows));
      if (!(read === due || (e.truncated === true && read < due)) || listed > read * s.pageRows) {
        add('sampleNotDrawnToSize', `read ${read} page(s) of ${s.pageRows} rows, ${due} due, and listed ${listed}${e.truncated === true ? ', truncated' : ''}`);
      }
    } else {
      const due = Math.min(e.requested, e.frameSize);
      if (!(listed === due || (e.truncated === true && listed < due))) {
        add('sampleNotDrawnToSize', `listed ${listed} of ${due} due${e.truncated === true ? ', truncated' : ''}`);
      }
    }
    // The seed is the id of the scan's own run, never the run that publishes it, so a re-aggregation keeps the row.
    const run = isObject(scan.value.scanner) && typeof scan.value.scanner.workflowRun === 'string'
      ? INSTRUMENT_RUN.exec(scan.value.scanner.workflowRun) : null;
    if (run === null || s.seed !== run[1]) {
      add('seedNotRunId', `the seed is ${describe(s.seed)}, and the scan's run ${describe(scan.value.scanner?.workflowRun)} ` +
        `${run === null ? 'is not a run of the instrument' : `has the id ${run[1]}`}`);
    }
  }
  if (aboveCeiling(scan.coverage)) {
    add('unresolvedShareAboveCeiling', `${scan.coverage.unresolved} of ${listed} listed unresolved, above the ceiling of 1 in ${ONE_IN}`);
  }
  return reasons;
}

/**
 * A registry's coverage as the corpus holds it, published or withheld: the
 * raw header's coverage members, with its enumeration and sources, copied as
 * they are. One shape, so that a withheld row says why it is withheld.
 */
const rowCoverageOf = (scan) => ({ ...scan.value.coverage, enumeration: scan.value.enumeration, sources: scan.value.sources });

/** True when a registry's scan reads more than the ceiling of its listed packages as unresolved. */
const aboveCeiling = (coverage) => coverage.unresolved * ONE_IN > coverage.listed;

/**
 * The rows the corpus withholds, as a set of registries, or null when the list
 * cannot be read as one. Each reason is a verdict, so none is taken as stated:
 * every row's reasons are recomputed from its files and the population rule,
 * and the corpus must withhold exactly the rows, for exactly the codes, they
 * give. A detail is words, and is not compared.
 */
function checkWithheld(list, ctx, file, bad) {
  const where = `${file}: withheld`;
  if (!Array.isArray(list)) {
    bad(`${where} is ${describe(list)}, not a list`);
    return null;
  }
  const withheld = new Set();
  const stated = new Map();
  let sound = true;
  list.forEach((item, index) => {
    const at = `${where}[${index}]`;
    if (!closed(item, KEYS.withheld, at, bad)) {
      sound = false;
      return;
    }
    if (!ECOSYSTEMS.includes(item.ecosystem) || withheld.has(item.ecosystem)) {
      bad(`${at}.ecosystem is ${describe(item.ecosystem)}, not one of the eleven registries withheld once`);
      sound = false;
      return;
    }
    withheld.add(item.ecosystem);
    const scan = ctx.scans[item.ecosystem];
    const holds = ctx.found.withScanFile.has(item.ecosystem);
    const codes = [];
    if (!Array.isArray(item.reasons) || item.reasons.length === 0) {
      bad(`${at}.reasons is ${describe(item.reasons)}, not a list with a reason in it. A row withheld for no stated reason reads ` +
        'as a row left out.');
      sound = false;
    } else {
      item.reasons.forEach((reason, number) => {
        const r = `${at}.reasons[${number}]`;
        if (!closed(reason, KEYS.withheldReason, r, bad)) {
          sound = false;
          return;
        }
        if (!WITHHELD_CODES.includes(reason.code)) {
          bad(`${r}.code is ${describe(reason.code)}, not one of: ${WITHHELD_CODES.join(', ')}`);
          sound = false;
        } else if (codes.includes(reason.code)) {
          bad(`${r}.code gives ${reason.code} a second time. A row names each reason it is withheld for once.`);
          sound = false;
        } else {
          codes.push(reason.code);
        }
        if (!isText(reason.detail)) {
          bad(`${r}.detail is ${describe(reason.detail)}, not text`);
          sound = false;
        }
      });
    }
    stated.set(item.ecosystem, { at, codes });
    // The coverage a row would have held, or null for a row with no scan file. A noScanFile given beside the scan
    // file is a reason the files do not give, reported below with the others.
    if (codes.includes('noScanFile') && holds) return;
    if (codes.includes('noScanFile') || !holds) {
      if (item.coverage !== null) {
        bad(`${at}.coverage is ${describe(item.coverage)}. A row with no scan file has no coverage to copy, so it is null.`);
        sound = false;
      }
    } else if (item.coverage === null) {
      bad(`${at}.coverage is null. It is null only for a row with no scan file; the counts of ${item.ecosystem} are in its scan file.`);
      sound = false;
    } else if (closed(item.coverage, KEYS.rowCoverage, `${at}.coverage`, bad)) {
      if (scan && scan.coverage && !sameValue(item.coverage, rowCoverageOf(scan))) {
        bad(`${at}.coverage is not the coverage, enumeration and sources of ${scan.file}. A withheld row keeps the coverage its ` +
          'row would have held, copied from the raw file as it is, so that a reader holding only the corpus can see why it is withheld.');
      }
    } else {
      sound = false;
    }
  });

  // The reasons, recomputed for every registry and compared as sets with the ones stated.
  const said = (reasons) => (reasons.length === 0 ? 'no reason' : reasons.map((r) => `${r.code} (${r.why})`).join(', '));
  for (const eco of ECOSYSTEMS) {
    const holds = ctx.found.withScanFile.has(eco);
    const computed = holds
      ? withholdingReasons(eco, ctx.scans[eco], ctx.ledgers[eco])
      : [{ code: 'noScanFile', why: 'the dataset holds no scan file of it' }];
    if (computed === null) continue;
    const given = stated.get(eco);
    if (sameSet(given ? given.codes : [], computed.map((r) => r.code))) continue;
    const from = holds ? `${fileNameFor('scan', eco)} and the population rule` : `the files, which hold no scan file of ${eco}`;
    if (!given && !holds) {
      bad(`${eco}: the dataset holds no scan file of ${eco}, and ${file} does not withhold the row for noScanFile. A registry is ` +
        'left out of a dataset only as a row withheld for having no scan file.');
    } else if (!given) {
      bad(`${eco}: recomputed from ${from}, the row is withheld for ${said(computed)}, and ${file} does not withhold it. A row ` +
        'withheld is not published, and no total sums it.');
    } else if (given.codes.length > 0) {
      bad(`${given.at} withholds ${eco} for ${given.codes.join(', ')}; recomputed from ${from}, it is withheld for ${said(computed)}. ` +
        'Each reason is a verdict on the files, so the corpus gives exactly the ones they give.');
    }
  }
  return sound ? withheld : null;
}

function checkCorpusCoverage(coverage, withheld, ctx, file, bad) {
  const where = `${file}: coverage`;
  if (!closed(coverage, KEYS.corpusCoverage, where, bad)) return;
  if (closed(coverage.byEcosystem, ECOSYSTEMS, `${where}.byEcosystem`, bad)) {
    for (const eco of ECOSYSTEMS) {
      const at = `${where}.byEcosystem.${eco}`;
      if (withheld && withheld.has(eco)) {
        if (coverage.byEcosystem[eco] !== null) bad(`${at} is ${describe(coverage.byEcosystem[eco])}; ${eco} is withheld, so it is null`);
        continue;
      }
      if (!closed(coverage.byEcosystem[eco], KEYS.rowCoverage, at, bad)) continue;
      const scan = ctx.scans[eco];
      if (!scan || !scan.coverage) continue;
      if (!sameValue(coverage.byEcosystem[eco], rowCoverageOf(scan))) {
        bad(`${at} is not the coverage, enumeration and sources of ${scan.file}. The corpus copies them from the raw file, and a ` +
          'copy that differs is a second answer.');
      }
    }
  }
  if (closed(coverage.total, COVERAGE_COUNTS, `${where}.total`, bad)) {
    const published = publishedRows(withheld);
    const scans = (published ?? []).map((eco) => ctx.scans[eco]);
    for (const field of COVERAGE_COUNTS) {
      if (!isCount(coverage.total[field])) {
        bad(`${where}.total.${field} is ${describe(coverage.total[field])}, not a whole count`);
      } else if (published && scans.every((scan) => scan && scan.coverage)) {
        const summed = sum(scans.map((scan) => scan.coverage[field]));
        if (coverage.total[field] !== summed) {
          bad(`${where}.total.${field} is ${coverage.total[field]}; the scan files of the ${published.length} rows not withheld sum to ${summed}`);
        }
      }
    }
  }
}

/** The registries a total sums: every one the corpus does not withhold. Null when the withheld rows cannot be read. */
const publishedRows = (withheld) => (withheld ? ECOSYSTEMS.filter((eco) => !withheld.has(eco)) : null);

/** A total names each registry once: as measurable, as not measurable, or as withheld. */
function totalPartition(block, where, withheld, ctx) {
  for (const key of [...CLASSES, ...JOINT]) {
    const cell = block[key];
    const named = [...cell.measurableIn, ...cell.notMeasurableIn, ...withheld];
    const twice = ECOSYSTEMS.filter((eco) => named.filter((x) => x === eco).length > 1);
    const missing = ECOSYSTEMS.filter((eco) => !named.includes(eco));
    if (twice.length > 0 || missing.length > 0) {
      ctx.bad(`${where}.${key}: measurableIn, notMeasurableIn and the withheld rows do not name the eleven registries once each` +
        `${twice.length > 0 ? ` (named twice: ${twice.join(', ')})` : ''}${missing.length > 0 ? ` (not named: ${missing.join(', ')})` : ''}`);
    }
  }
}

function checkCorpus(name, record, ctx, bad) {
  const file = record.file;
  const c = record.value;
  if (!closed(c, KEYS.corpus, file, bad)) return;
  if (c.kind !== 'censusCorpus') bad(`${file}: kind is ${describe(c.kind)}, not "censusCorpus"`);
  if (c.collectedAt !== name) {
    bad(`${file}: collectedAt is ${describe(c.collectedAt)}, and the dataset is ${name}`);
  } else {
    const finished = [...ctx.found.withScanFile].map((eco) => (ctx.scans[eco] ? ctx.scans[eco].value.finishedAt : null));
    if (finished.every(isTime)) {
      const latest = finished.map((time) => time.slice(0, 10)).sort().at(-1);
      if (latest !== c.collectedAt) {
        bad(`${file}: collectedAt is ${c.collectedAt}, and the last scan finished on ${latest}. A dataset is collected on the ` +
          'day its last scan finished.');
      }
    }
  }
  if (!isTime(c.generatedAt)) bad(`${file}: generatedAt is ${describe(c.generatedAt)}, not a time as toISOString() writes it, or a date`);
  if (closed(c.aggregator, KEYS.aggregator, `${file}: aggregator`, bad)) {
    if (!isText(c.aggregator.script)) bad(`${file}: aggregator.script is ${describe(c.aggregator.script)}`);
    if (!isText(c.aggregator.commit)) {
      bad(`${file}: aggregator.commit is ${describe(c.aggregator.commit)}. A published corpus names the instrument commit its ` +
        'aggregation ran at; null belongs to a local run.');
    }
  }
  checkInputs(name, c.inputs, ctx, file, bad);
  const includes = checkDefinitions(c.definitions, file, bad);
  checkComparability(name, c.comparability, c, ctx, file, bad);
  const publishable = checkBlocked(c.blocked, file, bad);
  const withheld = checkWithheld(c.withheld, ctx, file, bad);
  checkCorpusCoverage(c.coverage, withheld, ctx, file, bad);
  const rowsShaped = closed(c.byEcosystem, ECOSYSTEMS, `${file}: byEcosystem`, bad);
  const totalShaped = closed(c.total, KEYS.total, `${file}: total`, bad);

  // The figures are recomputed only from files that passed their own checks:
  // where one did not, it has been reported above, and the dataset fails.
  // Every scan file read is sound, and every registry without one is withheld: a row is computed from its files.
  const ready = publishable && withheld !== null && includes !== null && ctx.catalog && ctx.catalog.sound && ctx.map &&
    ECOSYSTEMS.every((eco) => (ctx.found.withScanFile.has(eco)
      ? ctx.scans[eco] && ctx.scans[eco].sound && ctx.ledgers[eco] && ctx.ledgers[eco].sound
      : withheld.has(eco)));
  if (!ready) return withheld;

  let differing = 0;
  const figureContext = {
    bad,
    figureBad: (message) => {
      differing += 1;
      if (differing <= 40) bad(message);
    },
  };
  const rows = {};
  for (const eco of ctx.found.withScanFile) {
    rows[eco] = expectedRow(eco, ctx.catalog.byEco[eco], ctx.scans[eco], ctx.ledgers[eco], ctx.map.byEco[eco], includes[eco]);
  }
  if (rowsShaped) {
    for (const eco of ECOSYSTEMS) {
      const where = `${file}: byEcosystem.${eco}`;
      const stored = c.byEcosystem[eco];
      const expected = rows[eco];
      if (withheld.has(eco)) {
        if (stored !== null) bad(`${where} is set; ${eco} is withheld, so its row is null and none of its figures is published`);
        continue;
      }
      if (!closed(stored, KEYS.row, where, bad)) continue;
      compareMeasurability(stored.measurability, expected.row.measurability, ctx.catalog.byEco[eco], `${where}.measurability`, figureContext);
      const items = blocksOf(stored, expected.row, where, expected.coverage, figureContext);
      const devWhere = `${where}.excludingDevMetadata`;
      let devCoverage = null;
      if (expected.row.excludingDevMetadata === null) {
        if (stored.excludingDevMetadata !== null) {
          bad(`${devWhere} is ${describe(stored.excludingDevMetadata)}. It is kept for a registry read partly from dev metadata, and is ` +
            'null for one that reads from a single source.');
        }
      } else if (closed(stored.excludingDevMetadata, KEYS.devRow, devWhere, bad)) {
        const dev = stored.excludingDevMetadata;
        if (closed(dev.coverage, KEYS.devCoverage, `${devWhere}.coverage`, bad)) {
          devCoverage = dev.coverage;
          for (const field of KEYS.devCoverage) {
            if (!isCount(dev.coverage[field])) {
              bad(`${devWhere}.coverage.${field} is ${describe(dev.coverage[field])}, not a whole count`);
              devCoverage = null;
            }
          }
        }
        items.push(...blocksOf(dev, expected.row.excludingDevMetadata, devWhere, expected.dev.coverage, figureContext));
      }
      const ready = items.filter((item) => blockRules(item.stored, item.consolidated, item.where, figureContext, false));
      for (const item of ready) {
        blockIdentities(item.stored, item.where, item.coverage, figureContext);
        if (item.consolidated) statsIdentity(item.stored.consolidation, `${item.where}.consolidation`, figureContext);
      }
      monotone(stored, where, figureContext);
      if (expected.dev !== null && isObject(stored.excludingDevMetadata)) monotone(stored.excludingDevMetadata, devWhere, figureContext);
      if (devCoverage) {
        for (const field of KEYS.devCoverage) {
          if (devCoverage[field] !== expected.dev.coverage[field]) {
            figureContext.figureBad(`${devWhere}.coverage.${field} is ${devCoverage[field]}; the ledger gives ` +
              `${expected.dev.coverage[field]} without the packages read from dev metadata`);
          }
        }
      }
      for (const item of ready) blockValues(item.stored, item.expected, item.where, figureContext, false);
    }
  }
  if (totalShaped) {
    const items = blocksOf(c.total, expectedTotal(rows, withheld), `${file}: total`, null, figureContext);
    const ready = items.filter((item) => blockRules(item.stored, item.consolidated, item.where, figureContext, true));
    for (const item of ready) {
      totalPartition(item.stored, item.where, withheld, figureContext);
      totalIdentity(item.stored, item.where, figureContext);
      if (item.consolidated) statsIdentity(item.stored.consolidation, `${item.where}.consolidation`, figureContext);
    }
    for (const item of ready) blockValues(item.stored, item.expected, item.where, figureContext, true);
  }
  compareMultiPurpose(c.multiPurposeLibraries, rows, withheld, ctx.catalog, file, figureContext);
  if (differing > 40) bad(`${file}: ${differing - 40} more figure(s) differ from their recomputed values`);
  return withheld;
}

// --- MANIFEST.json against the files --------------------------------------------

function checkKnownIssues(list, corpus, bad) {
  if (!Array.isArray(list)) return;
  const defects = new Set();
  list.forEach((issue, index) => {
    const where = `MANIFEST.json: knownIssues[${index}]`;
    if (!closed(issue, KEYS.knownIssue, where, bad)) return;
    if (!isText(issue.defect) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(issue.defect)) {
      bad(`${where}.defect is ${describe(issue.defect)}, not an id of lower-case words joined by hyphens`);
    } else if (defects.has(issue.defect)) {
      bad(`${where} repeats the defect ${issue.defect}. A reader citing it could mean either.`);
    }
    defects.add(issue.defect);
    for (const field of ['summary', 'correctedIn']) {
      if (!isText(issue[field])) bad(`${where}.${field} is ${describe(issue[field])}, not text a reader can see`);
    }
    if (!DIRECTIONS.includes(issue.direction)) {
      bad(`${where}.direction is ${describe(issue.direction)}, which tells a reader nothing about which way to read the figure`);
    }
    if (!Array.isArray(issue.affects) || issue.affects.length === 0 || !issue.affects.every(isText) || !isDistinct(issue.affects)) {
      bad(`${where}.affects is ${describe(issue.affects)}, not a list of the figures the issue bears on`);
    } else if (corpus) {
      for (const path of issue.affects) {
        if (resolvePath(corpus, path) === undefined) bad(`${where} affects ${path}, which is not a field of the corpus`);
      }
    }
    const m = issue.magnitude;
    if (m !== null && !(isObject(m) && hasExactly(m, KEYS.magnitude) && isCount(m.value) && isCount(m.of) && m.of > 0 &&
        m.value <= m.of && isText(m.unit))) {
      bad(`${where}.magnitude is ${describe(m)}, not null or { value, of, unit } with whole counts, value no more than of`);
    }
  });
}

function checkManifestAgainstFiles(manifest, found, scans, withheld, bad) {
  const at = 'MANIFEST.json';
  const corpus = found.corpus ? found.corpus.value : null;
  if (closed(manifest.coverage, COVERAGE_COUNTS, `${at}: coverage`, bad)) {
    const published = publishedRows(withheld);
    const rows = (published ?? []).map((eco) => scans[eco]);
    for (const field of COVERAGE_COUNTS) {
      if (!isCount(manifest.coverage[field])) {
        bad(`${at}: coverage.${field} is ${describe(manifest.coverage[field])}, not a whole count`);
      } else if (published && rows.every((scan) => scan && scan.coverage)) {
        const summed = sum(rows.map((scan) => scan.coverage[field]));
        if (manifest.coverage[field] !== summed) {
          bad(`${at}: coverage.${field} is ${manifest.coverage[field]}; the scan files of the ${published.length} rows not withheld sum to ${summed}`);
        }
      }
    }
  }
  if (!Array.isArray(manifest.ecosystems)) {
    bad(`${at}: ecosystems is ${describe(manifest.ecosystems)}, not a list`);
  } else {
    const seen = new Set();
    manifest.ecosystems.forEach((item, index) => {
      const where = `${at}: ecosystems[${index}]`;
      if (!closed(item, KEYS.manifestEcosystem, where, bad)) return;
      if (!ECOSYSTEMS.includes(item.ecosystem) || seen.has(item.ecosystem)) {
        bad(`${where}.ecosystem is ${describe(item.ecosystem)}, not a registry listed once`);
        return;
      }
      seen.add(item.ecosystem);
      if (!found.withScanFile.has(item.ecosystem)) {
        bad(`${where} names ${item.ecosystem}, which has no scan file in files. The manifest has one item per scan file, copied ` +
          'from its raw header.');
        return;
      }
      const scan = scans[item.ecosystem];
      if (!scan) return;
      for (const field of ['coverage', 'enumeration', 'sources']) {
        if (!sameValue(item[field], scan.value[field])) {
          bad(`${where}.${field} is not the ${field} of ${scan.file}. The manifest copies it from the raw header, and a copy ` +
            'that differs is a second answer.');
        }
      }
    });
    for (const eco of found.withScanFile) if (!seen.has(eco)) bad(`${at}: ecosystems has no item for ${eco}, whose scan file is in files`);
  }
  if (corpus && !sameValue(manifest.comparability, corpus.comparability)) {
    bad(`${at}: comparability is not the corpus's. It is a copy, so that the manifest alone tells a reader which datasets ` +
      'may not be compared with this one.');
  }
  checkKnownIssues(manifest.knownIssues, corpus, bad);
}

/** Every rule of a version 2 dataset, in the order its files depend on each other. */
function validateVersion2(name, dir) {
  const counted = new Map();
  const bad = (message) => {
    const file = (/^([A-Za-z0-9.-]+\.(?:json|gz))[: ]/.exec(message) ?? [])[1] ?? '';
    const count = (counted.get(file) ?? 0) + 1;
    counted.set(file, count);
    if (file === '' || count <= MAX_PROBLEMS_PER_FILE) fail(name, message);
  };
  try {
    validateVersion2Files(name, dir, bad);
  } finally {
    for (const [file, count] of counted) {
      if (file !== '' && count > MAX_PROBLEMS_PER_FILE) fail(name, `${file}: ${count - MAX_PROBLEMS_PER_FILE} more problem(s) in this file are not listed`);
    }
  }
}

function validateVersion2Files(name, dir, bad) {
  const manifest = readManifest2(dir, bad);
  if (manifest === null) return;
  checkManifest2(name, manifest, bad);
  const found = readListedFiles(name, dir, manifest, bad);
  if (found === null) return;
  const catalog = found.catalog ? checkCatalog(name, found.catalog, bad) : null;
  const scans = {};
  for (const eco of ECOSYSTEMS) {
    if (found.scans[eco]) scans[eco] = checkScan(name, eco, found.scans[eco], catalog, found, bad);
  }
  const ledgers = {};
  for (const eco of ECOSYSTEMS) {
    if (!found.listings[eco] || !scans[eco]) continue;
    const ledger = readLedger(eco, found.listings[eco], scans[eco], bad);
    if (ledger === null) continue;
    if (ledger.sound) compareLedger(eco, ledger, scans[eco], bad);
    ledgers[eco] = ledger;
  }
  const map = found.consolidation ? checkConsolidation(name, found.consolidation, scans, found.withScanFile, bad) : null;
  const withheld = found.corpus ? checkCorpus(name, found.corpus, { catalog, scans, ledgers, map, found }, bad) : null;
  checkManifestAgainstFiles(manifest, found, scans, withheld ?? null, bad);
  listRegeneratedScans(name, manifest, found);
}

/**
 * Every scan written by a run other than the one the manifest names: its
 * figures were aggregated again, later, without a new scan. That is allowed,
 * and it is recorded each time the dataset is validated, never left implicit.
 */
function listRegeneratedScans(name, manifest, found) {
  const run = isObject(manifest.provenance) ? manifest.provenance.workflowRun : null;
  if (!isText(run)) return;
  for (const eco of ECOSYSTEMS) {
    const scan = found.scans[eco];
    const scanRun = scan && isObject(scan.value.scanner) ? scan.value.scanner.workflowRun : null;
    if (isText(scanRun) && scanRun !== run) {
      note(name, `${scan.file} was written by the run ${scanRun}, not by ${run}, the run MANIFEST.json names: the dataset ` +
        'aggregates it again, without a new scan.');
    }
  }
}



// ---------------------------------------------------------------------------

if (!existsSync(DATASETS)) {
  process.stderr.write('No datasets/ directory.\n');
  process.exit(2);
}

const requested = process.argv[2];
// Everything directly under datasets/ is a dataset directory. A file there is
// read by none of these checks, so it would be published unchecked. Names that
// begin with a dot are left to the check that reads the committed tree: an
// operating system can leave one in a working copy.
for (const entry of readdirSync(DATASETS)) {
  if (!entry.startsWith('.') && !lstatSync(join(DATASETS, entry)).isDirectory()) {
    fail('datasets', `${entry} is not a dataset directory. A file directly under datasets/ is read by none of these checks.`);
  }
}
const all = readdirSync(DATASETS).filter((f) => statSync(join(DATASETS, f), { throwIfNoEntry: false })?.isDirectory());
const names = requested ? [requested] : all;

if (requested && !all.includes(requested)) {
  process.stderr.write(`No dataset datasets/${requested}\n`);
  process.exit(2);
}

// With no dataset named, every entry of errata/ is read, whatever it is
// called: a file passed over for its name is a file nothing has checked. With
// one dataset named, only that dataset's errata file is read.
let allErrata = [];
// errata/ is asked about itself and not about what it may point at: a link to
// a directory reads like one, while the files live where the append-only
// check does not look.
const errataEntry = lstatSync(ERRATA, { throwIfNoEntry: false });
if (errataEntry) {
  if (errataEntry.isDirectory()) allErrata = readdirSync(ERRATA).sort();
  else fail('errata', 'is not a directory. A link would keep the errata files somewhere the checks do not look.');
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
    fail(describe(name), 'directory name is not a YYYY-MM-DD collection date');
    continue;
  }
  // A check that throws reports where it stopped, and the problems found before it are still listed.
  try {
    validate(name);
  } catch (err) {
    fail(name, `could not be checked to the end: ${err.message}`);
  }
}

for (const file of errataFiles) {
  try {
    validateErrata(file);
  } catch (err) {
    fail(`errata/${file}`, `could not be checked to the end: ${err.message}`);
  }
}

const checked = `${names.length} dataset(s)` +
  (errataFiles.length > 0 ? ` and ${errataFiles.length} errata file(s)` : '');

/**
 * One problem or note, every line of it indented. Keys, names and fields are
 * printed through describe() above, so a line break in one is written as
 * `\n`; this holds for whatever else a file's text reaches, a parser's own
 * message included. No line of the log begins with text a dataset chose, so
 * none can read as a command to whatever runs these checks.
 */
const indented = (text) => `  ${text.replace(/\r\n|\r|\n/g, '\n  ')}\n`;

if (notes.length > 0) {
  process.stdout.write(`\nRecorded, not refused (${notes.length}):\n\n`);
  for (const n of notes) process.stdout.write(indented(n));
  process.stdout.write('\n');
}

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem(s) across ${checked}:\n\n`);
  for (const p of problems) process.stderr.write(indented(p));
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`${names.length} dataset(s) validated: ${names.join(', ')}\n`);
if (errataFiles.length > 0) {
  process.stdout.write(`${errataFiles.length} errata file(s) validated: ${errataFiles.join(', ')}\n`);
}
