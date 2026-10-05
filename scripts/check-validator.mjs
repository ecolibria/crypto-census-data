#!/usr/bin/env node
/**
 * Guards one rule of scripts/validate-dataset.mjs: the first file shape, whose
 * manifest carries no `schemaVersion`, is accepted only for the datasets
 * already published in it.
 *
 * The validator finds datasets relative to its own location, so each test
 * copies it and one small published dataset into a temporary directory and
 * runs the copy there. Nothing in this repository is written to.
 *
 *   node --test scripts/check-validator.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Aggregate-only, so a copy of it is two small files. */
const PUBLISHED = '2026-03-18';

/**
 * Build a datasets/ tree holding copies of the published dataset under the
 * given directory names, each with an optional change to its manifest, and run
 * a copy of the validator over it.
 */
async function validateCopies(datasets) {
  const dir = mkdtempSync(join(tmpdir(), 'census-data-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts', 'validate-dataset.mjs'), join(dir, 'scripts', 'validate-dataset.mjs'));
    for (const [name, change] of Object.entries(datasets)) {
      const target = join(dir, 'datasets', name);
      cpSync(join(ROOT, 'datasets', PUBLISHED), target, { recursive: true });
      if (change) {
        const path = join(target, 'MANIFEST.json');
        writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, 'utf-8'))), null, 2));
      }
    }
    return await new Promise((done) => {
      execFile(process.execPath, [join(dir, 'scripts', 'validate-dataset.mjs')], { env: {} },
        (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a published dataset in the first shape validates', async () => {
  const result = await validateCopies({ [PUBLISHED]: null });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 dataset\(s\) validated: 2026-03-18/);
});

test('the same files under a new date are refused', async () => {
  const result = await validateCopies({ [PUBLISHED]: null, '2026-10-05': null });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /1 problem\(s\) across 2 dataset\(s\)/);
  assert.match(result.stderr, /2026-10-05: MANIFEST\.json declares no schemaVersion/);
});

for (const declared of [1, 2, '2', null]) {
  test(`a dataset that declares schemaVersion ${JSON.stringify(declared)} is refused, under any name`, async () => {
    const declare = (manifest) => ({ ...manifest, schemaVersion: declared });
    const result = await validateCopies({ [PUBLISHED]: declare, '2026-10-05': declare });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /2 problem\(s\) across 2 dataset\(s\)/);
    assert.match(result.stderr, /2026-03-18: schemaVersion is /);
    assert.match(result.stderr, /2026-10-05: schemaVersion is /);
  });
}
