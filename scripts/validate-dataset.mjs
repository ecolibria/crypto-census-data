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
 *
 * Usage:
 *   node scripts/validate-dataset.mjs            # every dataset
 *   node scripts/validate-dataset.mjs 2026-07-29 # one dataset
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS = join(ROOT, 'datasets');

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
    if (!['understates', 'overstates', 'unknown'].includes(row.knownIssue.direction)) {
      fail(name, `${eco}.knownIssue.direction is ${JSON.stringify(row.knownIssue.direction)}, ` +
        'which tells a reader nothing about which way to read the figure');
    }
  }
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

// An empty repository is a valid state (nothing published yet), but a run that
// validated nothing must say so rather than print a checkmark.
if (names.length === 0) {
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

if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} problem(s) across ${names.length} dataset(s):\n\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(`${names.length} dataset(s) validated: ${names.join(', ')}\n`);
