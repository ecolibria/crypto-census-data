#!/usr/bin/env node
/**
 * A published dataset is never rewritten.
 *
 * This is the property a DOI depends on. Zenodo mints a citation against a
 * snapshot of this repository, and a talk cites that DOI; if the bytes behind a
 * dated directory can change afterwards, the citation stops meaning anything and
 * nobody downstream can tell.
 *
 * A correction is therefore published as a NEW dataset that supersedes the old
 * one, never as an edit to it -- the same rule the census applies to its own
 * corpus rows, which are annotated in place rather than restated.
 *
 * Usage: node scripts/check-immutable.mjs <base-ref>
 */

import { execFileSync } from 'node:child_process';

const base = process.argv[2];
if (!base) {
  process.stderr.write('Usage: check-immutable.mjs <base-ref>\n');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf-8' }).trim();

// Dataset directories that already existed at the base commit. A directory
// introduced by this change is new and may contain anything; one that was
// already published may not change at all.
let existing;
try {
  existing = new Set(
    git('ls-tree', '--name-only', `${base}:datasets`)
      .split('\n')
      .map((s) => s.replace(/\/$/, ''))
      .filter(Boolean)
  );
} catch {
  // No datasets/ at the base commit: nothing has been published, so nothing
  // can have been rewritten.
  process.stdout.write('No datasets existed at the base commit. Nothing to protect.\n');
  process.exit(0);
}

const changes = git('diff', '--name-status', `${base}...HEAD`, '--', 'datasets')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status: status[0], path: paths[paths.length - 1], from: paths[0] };
  });

const violations = [];
for (const change of changes) {
  const parts = change.path.split('/');
  if (parts.length < 2) continue;
  const dataset = parts[1];
  if (!existing.has(dataset)) continue; // new dataset, free to add files

  const verb = { M: 'modified', D: 'deleted', R: 'renamed', A: 'added a file to' }[change.status] || change.status;
  violations.push(`  ${verb} ${change.path}`);
}

if (violations.length > 0) {
  process.stderr.write(
    '\nThis change rewrites a dataset that has already been published:\n\n' +
    violations.join('\n') +
    '\n\nPublished datasets are immutable. A citation -- including a Zenodo DOI --\n' +
    'points at bytes that must not move underneath it. Publish a correction as a\n' +
    'new dated dataset that supersedes this one, and record the supersession in\n' +
    "the new dataset's MANIFEST.json and in the README.\n\n"
  );
  process.exit(1);
}

process.stdout.write(`No published dataset was modified (${existing.size} protected).\n`);
