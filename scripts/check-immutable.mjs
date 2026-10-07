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
  // Only the line ending is removed: a directory name can end in a space.
  top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
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

/**
 * A path or a key a change chose, as it is printed. The runner reads a line
 * that begins with `::`, leading space aside, or that holds `##[` anywhere, as
 * a command; the problem matchers actions/setup-node registers for the job
 * read a line holding `: line 1, col 2, Error - x (y)`, or an indented line
 * beginning `1:2 error x  y`, as an error; and a line break in a name would
 * start a line the name chose. So a name is printed as itself only when every
 * character of it is an ASCII letter, a digit, `.`, `_`, `~`, `/` or `-`; any
 * other name, and the empty one, is printed as JSON text with each `#`
 * escaped.
 */
const shown = (name) => (/^[A-Za-z0-9._~\/-]+$/.test(name) ? name : JSON.stringify(name).replace(/#/g, '\\u0023'));

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

// Everything these checks read is a regular file in a real directory. A link
// is compared as a link, so the text it points at could be rewritten
// elsewhere with no change here to see. That holds for a link to a directory
// as much as for a link to a file, and for datasets/ or errata/ itself as
// much as for an entry inside one. So at this change's head: datasets/ and
// errata/ are directories, nothing at any depth under datasets/ is a link or
// a submodule, and errata/ holds regular files and nothing else.
const REGULAR = ['100644', '100755'];
const entries = (...args) =>
  ask('ls-tree', ...args).split('\n').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type] = meta.split(' ');
    return { mode, type, path };
  });
const isRegular = (entry) => entry.type === 'blob' && REGULAR.includes(entry.mode);
const irregular = [
  ...['datasets', 'errata'].flatMap((directory) => entries('HEAD', directory))
    .filter((entry) => entry.type !== 'tree').map((entry) => `  ${shown(entry.path)} is not a directory`),
  ...[...entries('-r', 'HEAD', 'datasets/'), ...entries('HEAD', 'errata/')]
    .filter((entry) => !isRegular(entry)).map((entry) => `  ${shown(entry.path)} is not a regular file`),
  // A file directly under datasets/ belongs to no dataset: the validator reads
  // dataset directories, and nothing else reads it.
  ...entries('HEAD', 'datasets/')
    .filter((entry) => isRegular(entry)).map((entry) => `  ${shown(entry.path)} is not a dataset directory`),
];

// An attribute file can change what an archive of this repository holds without
// changing one file these checks read: `export-ignore` leaves a published file
// out of the archive a deposit is made from. None is needed here, so none is
// allowed, at any depth. Names are read NUL-separated, so that a path git
// would print in quotes is still recognised.
/**
 * True for a file name that git, on some file system, reads as the attribute
 * file. Wider than git's own tests on purpose, since no such name is needed
 * here:
 * - a file system that folds case reads `.GITATTRIBUTES` as it;
 * - HFS+ ignores some format characters, so a name with one inside is it;
 * - NTFS drops trailing spaces and periods, reads `name:stream` as `name`,
 *   and gives it the short names `GITATT~1` to `~4` and, as a fall-back, a
 *   name built on `gi7d29` (git's is_ntfs_dotgitattributes). A backslash is a
 *   path separator there, so the last part after one is tested as well.
 */
const isAttributeFileName = (name) => {
  const folded = name.normalize('NFC').replace(/\p{Cf}/gu, '').toLowerCase();
  const base = folded.split(':')[0].replace(/[ .]+$/, '');
  if (base === '.gitattributes') return true;
  if (/^gitatt~[1-4]$/.test(base)) return true;
  const tilde = base.indexOf('~');
  return tilde >= 0 && tilde <= 6 && 'gi7d29'.startsWith(base.slice(0, tilde)) && /^~[1-9]\d*$/.test(base.slice(tilde));
};
const attributeFiles = ask('ls-tree', '-r', '-z', '--name-only', 'HEAD').split('\0')
  .filter((path) => isAttributeFileName(path.split('/').pop()) || isAttributeFileName(path.split(/[\\/]/).pop()));
const reportIrregular = () => {
  if (attributeFiles.length > 0) {
    process.stderr.write(
      '\nThis tree holds an attribute file:\n\n' +
      attributeFiles.map((path) => `  ${shown(path)}`).join('\n') +
      '\n\nAn attribute file can leave a published file out of an archive of this\n' +
      'repository, or change its bytes on checkout, with no change to the file\n' +
      'itself. Remove it.\n\n'
    );
  }
  if (irregular.length === 0) return;
  process.stderr.write(
    '\nNot everything under datasets/ and errata/ is a regular file in a real directory:\n\n' +
    irregular.join('\n') +
    '\n\nA link or a submodule keeps its content somewhere these checks do not look,\n' +
    'where it could be rewritten with no change here to see. Commit the files\n' +
    'themselves.\n\n'
  );
};

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
  reportIrregular();
  if (irregular.length > 0 || attributeFiles.length > 0) process.exit(1);
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

const VERBS = { M: 'modified', D: 'deleted', R: 'renamed', A: 'added a file to', T: 'changed the type of' };
const published = (path) => existing.has(path.split('/')[1]);

const violations = [];
for (const change of changesUnder('datasets')) {
  // A rename touches two places. Read at its new path alone, a file moved out
  // of a published dataset into a new directory is only a file added to the
  // new one, and the dataset it left is rewritten unseen.
  if (change.status === 'R') {
    if (published(change.from)) violations.push(`  renamed ${shown(change.from)}`);
    else if (published(change.path)) violations.push(`  added a file to ${shown(change.path)}`);
    continue;
  }
  if (!published(change.path)) continue; // new dataset, free to add files
  violations.push(`  ${VERBS[change.status] || change.status} ${shown(change.path)}`);
}

// --- Errata -----------------------------------------------------------------
//
// An errata file is the record of what was known to be wrong with a dataset,
// and when. An issue that could be reworded or withdrawn afterwards would let
// that record change without trace. So a file that was already published may
// only grow: everything outside `issues` and `regenerations` stays as it was,
// and the elements each list held stay first, in order, unchanged. A
// `regenerations` list the published file does not have reads as empty.

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
    edits.push(`  ${verb} ${shown(change.from)}`);
    continue;
  }

  let was;
  let is;
  try {
    was = JSON.parse(fileAt(mergeBase, change.path));
    is = JSON.parse(fileAt('HEAD', change.path));
  } catch {
    edits.push(`  ${shown(change.path)} cannot be compared with what was published: one of the two does not parse`);
    continue;
  }
  if (!isObject(was) || !isObject(is) || !Array.isArray(was.issues) || !Array.isArray(is.issues)) {
    edits.push(`  ${shown(change.path)} cannot be compared with what was published: one of the two is not an errata file`);
    continue;
  }

  // Own properties only: read plainly, a key such as "__proto__" that one side
  // lacks comes back as the object every object inherits from, and an added
  // key would compare equal to its absence.
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  for (const field of new Set([...Object.keys(was), ...Object.keys(is)])) {
    if (field === 'issues' || field === 'regenerations') continue;
    if (canonical(own(was, field)) !== canonical(own(is, field))) edits.push(`  changed ${shown(field)} in ${shown(change.path)}`);
  }
  if (is.issues.length < was.issues.length) {
    edits.push(`  removed ${was.issues.length - is.issues.length} issue(s) from ${shown(change.path)}`);
  }
  was.issues.forEach((issue, index) => {
    if (index >= is.issues.length || canonical(issue) === canonical(is.issues[index])) return;
    const name = isObject(issue) && typeof issue.defect === 'string' ? ` (${shown(issue.defect)})` : '';
    edits.push(`  issue ${index + 1}${name} of ${shown(change.path)} is no longer what was published`);
  });

  // Regenerations grow the same way. Absent from the published file, the list
  // reads as empty, so the first regeneration may be added; once present it is
  // a list with a regeneration in it, on both sides, and it is never dropped.
  const had = Object.hasOwn(was, 'regenerations');
  const has = Object.hasOwn(is, 'regenerations');
  const isList = (value) => Array.isArray(value) && value.length > 0;
  if (had && !has) {
    edits.push(`  dropped regenerations from ${shown(change.path)}`);
  } else if ((had && !isList(was.regenerations)) || (has && !isList(is.regenerations))) {
    edits.push(`  ${shown(change.path)} cannot be compared with what was published: regenerations is not a list with a regeneration in it`);
  } else {
    const before = had ? was.regenerations : [];
    const after = has ? is.regenerations : [];
    if (after.length < before.length) {
      edits.push(`  removed ${before.length - after.length} regeneration(s) from ${shown(change.path)}`);
    }
    before.forEach((regeneration, index) => {
      if (index >= after.length || canonical(regeneration) === canonical(after[index])) return;
      edits.push(`  regeneration ${index + 1} of ${shown(change.path)} is no longer what was published`);
    });
  }
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

reportIrregular();

if (violations.length > 0 || edits.length > 0 || irregular.length > 0 || attributeFiles.length > 0) process.exit(1);

let protectedErrata = 0;
try {
  protectedErrata = ask('ls-tree', '--name-only', `${base}:errata`).split('\n').filter(Boolean).length;
} catch {
  // No errata/ at the base commit.
}

process.stdout.write(`No published dataset was modified (${existing.size} protected).\n`);
process.stdout.write(`No published errata issue was changed (${protectedErrata} file(s) protected).\n`);
