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
 * What is learnt about a dataset after it is published goes in
 * errata/<date>.json, beside the datasets. That file is append-only: an issue
 * stays as it was published, and a later finding is added after it.
 *
 * Usage: node scripts/check-immutable.mjs <base-ref>
 */

import { execFileSync } from 'node:child_process';

const base = process.argv[2];
if (!base) {
  process.stderr.write('Usage: check-immutable.mjs <base-ref>\n');
  process.exit(2);
}

// Every git command runs at the top of the repository, whatever directory the
// script was started in. Started in a subdirectory, "datasets" would name a
// path that does not exist there, and nothing would be compared.
let top;
try {
  top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  process.stderr.write('\nThis is not a git checkout, so there is nothing to compare.\n\n');
  process.exit(1);
}

/** Room for any file this repository could hold: a published file has to stay comparable as it grows. */
const MAX_OUTPUT = 1024 * 1024 * 1024;

const git = (...args) => execFileSync('git', args, { cwd: top, encoding: 'utf-8', maxBuffer: MAX_OUTPUT }).trim();

/** The same, for a question whose answer may be "there is no such thing": git's own complaint is not printed. */
const ask = (...args) =>
  execFileSync('git', args, { cwd: top, encoding: 'utf-8', maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A file as it is at a commit, decoded strictly: bytes that are not UTF-8 are an error, not a substituted character. */
const fileAt = (commit, path) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    execFileSync('git', ['show', `${commit}:${path}`], { cwd: top, maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'ignore'] })
  );

// The base has to be a commit this checkout can read. If it is not, nothing
// below can tell a rewritten tree from an untouched one, and a check that
// cannot look must not pass. A misspelt ref and a deleted branch arrive here,
// and so does a shallow checkout that never fetched the base.
try {
  ask('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
} catch {
  process.stderr.write(
    `\nCannot read the base "${base}" in this checkout, so nothing can be compared against it.\n` +
    'The check needs the full history of the base branch (fetch-depth: 0 in CI).\n\n'
  );
  process.exit(1);
}

// What was published is read at the point this change left the base. Without
// a common ancestor there is no such point, and the comparison has no meaning.
let mergeBase;
try {
  mergeBase = ask('merge-base', base, 'HEAD');
} catch {
  process.stderr.write(`\nThis change and the base "${base}" share no history, so nothing can be compared.\n\n`);
  process.exit(1);
}

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

/**
 * What this change did under one directory: the status letter, the path as it
 * is now, and the path it had before if it was renamed.
 */
const changesUnder = (directory) =>
  git('diff', '--name-status', `${base}...HEAD`, '--', directory)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status: status[0], path: paths[paths.length - 1], from: paths[0] };
    });

const VERBS = { M: 'modified', D: 'deleted', R: 'renamed', A: 'added a file to' };
const published = (path) => existing.has(path.split('/')[1]);

const violations = [];
for (const change of changesUnder('datasets')) {
  // A rename touches two places. Read at its new path alone, a file moved out
  // of a published dataset into a new directory is only a file added to the
  // new one, and the dataset it left is rewritten unseen.
  if (change.status === 'R') {
    if (published(change.from)) violations.push(`  renamed ${change.from}`);
    else if (published(change.path)) violations.push(`  added a file to ${change.path}`);
    continue;
  }
  if (!published(change.path)) continue; // new dataset, free to add files
  violations.push(`  ${VERBS[change.status] || change.status} ${change.path}`);
}

// --- Errata -----------------------------------------------------------------
//
// An errata file is the record of what was known to be wrong with a dataset,
// and when. An issue that could be reworded or withdrawn afterwards would let
// that record change without trace. So a file that was already published may
// only grow: everything outside `issues` stays as it was, and the issues it
// listed stay first, in order, unchanged.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One spelling per value, so that spacing and key order are not read as a change of content. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const edits = [];
for (const change of changesUnder('errata')) {
  if (change.status === 'A') continue; // a new errata file; the validator reads it
  if (change.status !== 'M') {
    const verb = { D: 'deleted', R: 'renamed' }[change.status] || `changed (${change.status})`;
    edits.push(`  ${verb} ${change.from}`);
    continue;
  }

  let was;
  let is;
  try {
    was = JSON.parse(fileAt(mergeBase, change.path));
    is = JSON.parse(fileAt('HEAD', change.path));
  } catch {
    edits.push(`  ${change.path} cannot be compared with what was published: one of the two does not parse`);
    continue;
  }
  if (!isObject(was) || !isObject(is) || !Array.isArray(was.issues) || !Array.isArray(is.issues)) {
    edits.push(`  ${change.path} cannot be compared with what was published: one of the two is not an errata file`);
    continue;
  }

  // Own properties only: read plainly, a key such as "__proto__" that one side
  // lacks comes back as the object every object inherits from, and an added
  // key would compare equal to its absence.
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  for (const field of new Set([...Object.keys(was), ...Object.keys(is)])) {
    if (field === 'issues') continue;
    if (canonical(own(was, field)) !== canonical(own(is, field))) edits.push(`  changed ${field} in ${change.path}`);
  }
  if (is.issues.length < was.issues.length) {
    edits.push(`  removed ${was.issues.length - is.issues.length} issue(s) from ${change.path}`);
  }
  was.issues.forEach((issue, index) => {
    if (index >= is.issues.length || canonical(issue) === canonical(is.issues[index])) return;
    const name = isObject(issue) && typeof issue.defect === 'string' ? ` (${issue.defect})` : '';
    edits.push(`  issue ${index + 1}${name} of ${change.path} is no longer what was published`);
  });
}

// Everything in errata/ at this change's head is a regular file. A link is
// compared as a link, so the text it points at could be rewritten elsewhere
// with no change here to see.
for (const line of ask('ls-tree', 'HEAD', 'errata/').split('\n').filter(Boolean)) {
  const [meta, path] = line.split('\t');
  const [mode, type] = meta.split(' ');
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) edits.push(`  ${path} is not a regular file`);
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
}

if (edits.length > 0) {
  process.stderr.write(
    '\nThis change alters an errata file that has already been published:\n\n' +
    edits.join('\n') +
    '\n\nAn errata file is append-only. It records what was known to be wrong with a\n' +
    'dataset, and when; an issue reworded or withdrawn afterwards changes that\n' +
    'record without trace. Add the later finding as a new issue after the\n' +
    'published ones.\n\n'
  );
}

if (violations.length > 0 || edits.length > 0) process.exit(1);

let protectedErrata = 0;
try {
  protectedErrata = ask('ls-tree', '--name-only', `${base}:errata`).split('\n').filter(Boolean).length;
} catch {
  // No errata/ at the base commit.
}

process.stdout.write(`No published dataset was modified (${existing.size} protected).\n`);
process.stdout.write(`No published errata issue was changed (${protectedErrata} file(s) protected).\n`);
