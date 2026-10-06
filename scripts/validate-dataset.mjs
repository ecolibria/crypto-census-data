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

  // The figures an issue names are looked up in the dataset's own aggregate.
  let corpus;
  let manifest;
  const manifestPath = join(DATASETS, date, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    fail(label, `describes datasets/${date}, which is not a dataset in this repository`);
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      corpus = JSON.parse(readFileSync(join(DATASETS, date, manifest.corpus.file), 'utf-8'));
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
    const entry = Array.isArray(manifest.ecosystems) ? manifest.ecosystems.find((e) => isObject(e) && e.ecosystem === ecosystem) : undefined;
    if (!entry || typeof entry.file !== 'string' || !/^[^/\\]+$/.test(entry.file) || entry.file === '..') {
      found = { problem: `has no raw file in datasets/${date}` };
    } else {
      const path = join(DATASETS, date, entry.file);
      try {
        if (!lstatSync(path).isFile()) throw new Error('not a regular file');
        found = { file: entry.file, value: JSON.parse(readStrict(path)) };
      } catch {
        found = { problem: `has a raw file, ${entry.file}, that cannot be read` };
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
// each of the eleven registries a raw scan file and a ledger of every package
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

const MANIFEST_CHECKS = ['missingEcosystems', 'belowPlausibleMinimum', 'withoutPlausibleMinimum', 'noMatches', 'unresolvedAboveCeiling',
  'sourcesOffAllowlist', 'catalogCheckMismatches', 'inputHashMismatches', 'identityFailures'];

/** The fields of each object, all of them required. An object is closed: a key not listed here fails. Each section adds the objects it reads. */
const KEYS = {
  manifest: ['schemaVersion', 'dataset', 'kind', 'collectedAt', 'generatedAt', 'license', 'provenance', 'files', 'coverage',
    'ecosystems', 'comparability', 'checks', 'complete', 'knownIssues'],
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
const isTime = (v) => {
  if (isCalendarDate(v)) return true;
  if (typeof v !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.exec(v);
  return match !== null && isCalendarDate(match[1]);
};
const startsWithVersion = (text) => /^\s*\{\s*"schemaVersion"\s*:/.test(text);

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
      ? `${where} carries ${key}, a stored share. No share is stored in a version 2 file: one is computed where it is shown, ` +
        'from two counts of the same block, so its denominator is never left to the reader.'
      : `${where} carries ${key}, which the schema version 2 contract does not define. Every object is closed, so a stale or ` +
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

/** A file of the dataset as bytes: a regular file, never a link, and no larger than the host accepts. */
function readDatasetFile(dir, file, bad) {
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
  if (stat.size > MAX_FILE_BYTES) {
    bad(`${file} is ${stat.size.toLocaleString('en-US')} bytes, over the ${MAX_FILE_BYTES.toLocaleString('en-US')} a dataset file ` +
      'may hold. The host refuses a file of 100 MB, so this one could not be published beside the others.');
    return null;
  }
  return readFileSync(path);
}

// --- MANIFEST.json --------------------------------------------------------------

/** The manifest, read strictly. One that is not a version 2 manifest in shape is reported once, since nothing else can be read from it. */
function readManifest2(dir, bad) {
  const path = join(dir, 'MANIFEST.json');
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    bad('MANIFEST.json is not a regular file. A link would keep the text these checks read somewhere the immutability check does not look.');
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) {
    bad(`MANIFEST.json is ${stat.size.toLocaleString('en-US')} bytes, over the ${MAX_FILE_BYTES.toLocaleString('en-US')} a dataset file may hold`);
    return null;
  }
  let text;
  try {
    text = readStrict(path);
  } catch {
    bad('MANIFEST.json is not UTF-8. A decoder that substitutes a character would hide the difference from every check here.');
    return null;
  }
  const manifest = JSON.parse(text);
  const missing = KEYS.manifest.filter((key) => !Object.hasOwn(manifest, key));
  const extra = Object.keys(manifest).filter((key) => !KEYS.manifest.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`it lacks ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`it carries ${extra.join(', ')}, which a version 2 manifest does not define`);
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
  if (!isTime(m.generatedAt)) bad(`${at}: generatedAt is ${describe(m.generatedAt)}, not an ISO 8601 UTC time`);
  if (m.license !== 'CC-BY-4.0') bad(`${at}: license is ${describe(m.license)}; published datasets here are CC-BY-4.0`);
  if (closed(m.provenance, KEYS.provenance, `${at}: provenance`, bad)) {
    for (const field of KEYS.provenance) {
      if (!isText(m.provenance[field])) {
        bad(`${at}: provenance.${field} is ${describe(m.provenance[field])}. A published dataset that cannot say which run ` +
          'produced it cannot be reproduced or challenged.');
      }
    }
  }
  // `checks` records what the generator found; `complete` is its verdict. Each
  // check is recomputed from the files by the rules below, and neither field
  // is read as proof of anything. A list that is not empty, or a verdict that
  // is not true, is the generator saying the dataset is not ready.
  // not checked yet: belowPlausibleMinimum and withoutPlausibleMinimum, the
  // plausible minimum of packages read per registry, which the schema version
  // 2 contract does not state.
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
  if (m.complete !== true) {
    bad(`${at}: complete is ${describe(m.complete)}. A dataset is published when every check passes, and this one says one did not.`);
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
 * is a stray, whatever its name. Returns the parsed files by role.
 */
function readListedFiles(name, dir, manifest, bad) {
  if (!Array.isArray(manifest.files)) {
    bad(`MANIFEST.json: files is ${describe(manifest.files)}, not a list of the dataset's files`);
    return null;
  }
  const found = { scans: {}, listings: {}, corpus: null, catalog: null, consolidation: null, hashes: new Map() };
  const listed = new Set();
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

    const buffer = readDatasetFile(dir, entry.file, bad);
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

  for (const role of ['corpus', 'catalog', 'consolidation']) {
    if (!roles.has(role)) bad(`MANIFEST.json lists no ${role} file, and a version 2 dataset has one`);
  }
  for (const eco of ECOSYSTEMS) {
    for (const role of PER_REGISTRY) {
      if (!roles.has(`${role}:${eco}`)) {
        bad(`MANIFEST.json lists no ${role === 'scan' ? 'scan file' : 'listing ledger'} for ${eco}. All eleven registries are ` +
          'in a version 2 dataset, so that a missing one cannot read as a fall in every total.');
      }
    }
  }

  const strays = readdirSync(dir).filter((entry) => entry !== 'MANIFEST.json' && !listed.has(entry)).sort();
  if (strays.length > 0) {
    bad(`present but not listed in MANIFEST.json: ${strays.join(', ')}. An unlisted file is one no reader can attribute ` +
      'and no hash covers.');
  }
  return found;
}

/** Every rule of a version 2 dataset, in the order its files depend on each other. */
function validateVersion2(name, dir) {
  const bad = (message) => fail(name, message);
  const manifest = readManifest2(dir, bad);
  if (manifest === null) return;
  checkManifest2(name, manifest, bad);
  readListedFiles(name, dir, manifest, bad);
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
