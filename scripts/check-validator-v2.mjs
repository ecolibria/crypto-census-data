#!/usr/bin/env node
/**
 * Guards the schema version 2 rules of scripts/validate-dataset.mjs.
 *
 * Each test builds a small version 2 dataset in a temporary directory, beside
 * a copy of the validator and of one published first-shape dataset, changes
 * one thing about it, and runs the copy. Nothing in this repository is written
 * to, and every temporary directory is removed.
 *
 * The dataset has all eleven registries and 36 listed packages. Every figure
 * of each registry's row is written out by hand below, beside the packages it
 * comes from, small enough to be checked by eye. The coverage counts, the
 * ledger's match counts and the totals are computed by the small code in this
 * file from what is listed here, never by the validator's code; the totals'
 * code sums the rows the way the contract says, so it is a second statement
 * of that rule, not an independent one.
 *
 *   node --test scripts/check-validator-v2.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_SHAPE = '2026-03-18';
const DATE = '2026-09-30';

const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'crates', 'packagist', 'nuget', 'rubygems', 'hex', 'pub', 'cocoapods'];
const CLASSES = ['matched', 'weak', 'brokenAlgorithm', 'deprecatedLibrary', 'pqc'];
const JOINT = ['weakAndPqc', 'neitherWeakNorPqc'];
const DEFINITIONS = ['anyManifestMatch', 'directUnconditional'];
const UNITS = ['raw', 'consolidated'];
const CHANGE_CODES = ['enumerationFrame', 'versionSelection', 'manifestReader', 'declarationKinds', 'matchRule', 'matchSet',
  'coverageDefinition', 'matchDefinition', 'classDefinition', 'classification', 'consolidationRule'];
const CHECKS = ['missingEcosystems', 'belowPlausibleMinimum', 'withoutPlausibleMinimum', 'noMatches', 'unresolvedAboveCeiling',
  'sourcesOffAllowlist', 'catalogCheckMismatches', 'inputHashMismatches', 'identityFailures'];
const COVERAGE = ['listed', 'scanned', 'absent', 'unresolved', 'unversioned', 'dependenciesNotObservable'];
/** The columns two registries' ledgers add after the seven. */
const LEDGER_EXTRA = { packagist: ['type'], maven: ['page'] };

/** The declaration kinds a scan of each registry records. */
const KINDS = {
  npm: ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'],
  pypi: ['requiresDist'],
  go: ['require'],
  maven: ['project', 'managed', 'profile', 'plugin'],
  crates: ['normal', 'dev', 'build'],
  packagist: ['require', 'requireDev', 'suggest'],
  nuget: ['dependencyGroup'],
  rubygems: ['runtime', 'development'],
  hex: ['requirement'],
  pub: ['dependencies', 'devDependencies'],
  cocoapods: ['topLevel', 'platform', 'subspec', 'testspec', 'appspec'],
};
/** Every kind counts as a manifest match except Maven managed and plugin and Packagist suggest. */
const INCLUDES = Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, KINDS[eco].filter((kind) =>
  !(eco === 'maven' && ['managed', 'plugin'].includes(kind)) && !(eco === 'packagist' && kind === 'suggest'))]));

// Example values. The commit id and the two digests have the right form and
// name nothing; the URLs are in reserved example domains, except Go's two
// sources, which are the ones on the validator's allowlist.
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const MATCH_SET = createHash('sha256').update('example match set').digest('hex');
const CLASSIFICATION = createHash('sha256').update('example classification').digest('hex');
const CHECKED = '2026-09-28T12:00:00Z';
const evidence = (path) => `https://evidence.example/${path}`;
const ABSENT = { checkedAt: '2026-09-28', note: null };

// --- Catalogue entries ----------------------------------------------------------

const entry = (ecosystem, name, fields = {}) => ({
  ecosystem, name, tier: 'other', weakClass: null, classEvidence: null, classified: true, unclassifiedReason: null,
  endOfLifeReview: { status: 'notReviewed', url: null, checkedAt: null }, multiPurpose: null, unmatchable: null,
  registryAbsent: null, aliases: [], lastRelease: null, algorithms: ['AES'], category: 'general', ...fields,
});
const broken = (eco, name, algorithms, fields = {}) => entry(eco, name, {
  tier: 'weak', weakClass: 'brokenAlgorithm', algorithms, category: 'hashing',
  classEvidence: { basis: 'entryAlgorithms', limb: null, url: null, checkedAt: null, additionalUrls: [] }, ...fields,
});
const deprecated = (eco, name, limb, fields = {}) => entry(eco, name, {
  tier: 'weak', weakClass: 'deprecatedLibrary',
  classEvidence: { basis: 'endOfLifeSignal', limb, url: evidence(`${eco}/${name}`), checkedAt: CHECKED, additionalUrls: [] },
  endOfLifeReview: { status: 'signalFound', url: evidence(`${eco}/${name}`), checkedAt: CHECKED },
  lastRelease: { version: '1.0.0', date: '2020-01-01', checkedAt: '2026-09-28' }, ...fields,
});
const pqc = (eco, name, fields = {}) => entry(eco, name, { tier: 'pqc', algorithms: ['ML-KEM'], ...fields });
const unclassified = (eco, name, code) => entry(eco, name, {
  tier: null, classified: false, unclassifiedReason: { code, url: evidence(`${eco}/${name}`), checkedAt: CHECKED },
});
const multiPurpose = (eco, name, version) => entry(eco, name, {
  multiPurpose: { version, url: evidence(`${eco}/${name}/archive`), checkedAt: CHECKED }, algorithms: ['AES', 'ML-KEM'],
});
const alias = (name) => ({ name, url: evidence(`alias/${name}`), checkedAt: CHECKED });

// --- Packages -------------------------------------------------------------------

const scanned = (name, matches, { observable = 1, readFrom = null, manifest = null } = {}) =>
  ({ name, disposition: 'scanned', reason: '', observable, readFrom, manifest, matches });
const unread = (name, disposition, reason) => ({ name, disposition, reason });
const match = (name, ...declarations) => ({ declaredName: name, entry: name, matchedBy: 'exact', declarations });
const matchAs = (declaredName, name, matchedBy, ...declarations) => ({ declaredName, entry: name, matchedBy, declarations });

const npm = (kind, peerOptional = null) => ({ kind, peerOptional });
const pypi = (marker, markerText = null) => ({ kind: 'requiresDist', marker, markerText });
const go = (indirect, replace = null) => ({ kind: 'require', indirect, replace });
const maven = (kind, scope, optional = false) => ({ kind, scope, optional });
const crate = (kind, optional = false, target = null) => ({ kind, optional, target, package: null, inDefaultFeature: null });
const nuget = (targetFramework) => ({ kind: 'dependencyGroup', targetFramework });
const pod = (kind, subspec, platform = null) => ({ kind, platform, subspec });

// --- Figures --------------------------------------------------------------------
//
// A block is written [cells, unclassified matches by entry, units whose only
// matches are unclassified, consolidation [in, out, merged]]. Cells are, in
// order: matched, weak, brokenAlgorithm, deprecatedLibrary, pqc, weakAndPqc,
// neitherWeakNorPqc. null is a figure that cannot be measured because K is 0.

const measure = (k, entries, excluded) => ({ k, entries, excluded: excluded.map(([e, why]) => ({ entry: e, why })) });
/** A registry with no namespace and no unclassified entry: the consolidated blocks are the raw ones, nothing merged. */
const plain = (anyCells, anyUnits, directCells, directUnits) => ({
  anyManifestMatch: { raw: [anyCells, {}, 0], consolidated: [anyCells, {}, 0, [anyUnits, anyUnits, 0]] },
  directUnconditional: { raw: [directCells, {}, 0], consolidated: [directCells, {}, 0, [directUnits, directUnits, 0]] },
});

/** The eleven registries. Built afresh for each test, so that a change to one never reaches another. */
function registries() {
  return {
    npm: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      sampling: { method: 'seededShuffle', seed: 'example-seed' },
      entries: [
        pqc('npm', '@noble/post-quantum'),
        unclassified('npm', '@types/bcryptjs', 'noCryptographicCode'),
        deprecated('npm', 'crypto-js', 'D1'),
        broken('npm', 'md5', ['MD5']),
        entry('npm', 'node-forge', { endOfLifeReview: { status: 'noSignalFound', url: null, checkedAt: null } }),
        broken('npm', 'tripledes', ['3DES'], { registryAbsent: { ...ABSENT } }),
      ],
      rows: [
        scanned('@acme/alpha', [match('md5', npm('dependencies')), match('@noble/post-quantum', npm('devDependencies'))]),
        scanned('@acme/beta', [match('crypto-js', npm('optionalDependencies'))]),
        scanned('@acme/gamma', [match('node-forge', npm('dependencies')), match('md5', npm('peerDependencies', true))]),
        scanned('@other/delta', [match('@types/bcryptjs', npm('devDependencies'))]),
        scanned('epsilon', [match('md5', npm('dependencies')), match('@noble/post-quantum', npm('dependencies'))]),
        scanned('zeta', [match('tripledes', npm('dependencies')), match('@types/bcryptjs', npm('dependencies'))]),
        scanned('theta', []),
        unread('eta', 'absent', 'http404'),
      ],
      units: [{ unit: '@acme', members: ['@acme/alpha', '@acme/beta', '@acme/gamma'] }],
      // K: countable are @noble/post-quantum, crypto-js, md5, node-forge; tripledes is absent from the registry.
      measurability: {
        matched: { k: 4, excluded: [{ entry: '@types/bcryptjs', why: 'unclassified' }, { entry: 'tripledes', why: 'registryAbsent' }] },
        weak: measure(2, ['crypto-js', 'md5'], [['tripledes', 'registryAbsent']]),
        brokenAlgorithm: measure(1, ['md5'], [['tripledes', 'registryAbsent']]),
        deprecatedLibrary: measure(1, ['crypto-js'], []),
        pqc: measure(1, ['@noble/post-quantum'], []),
      },
      // Any manifest match (all four kinds): alpha {md5, post-quantum}, beta {crypto-js}, gamma {node-forge, md5},
      // delta {@types} only, epsilon {md5, post-quantum}, zeta {tripledes, @types}. A match to tripledes counts:
      // it is classified, though not countable. Direct: alpha {md5}, gamma {node-forge}, epsilon {md5, post-quantum},
      // zeta {tripledes, @types}; beta is optional, delta a dev dependency, gamma's md5 an optional peer.
      // Consolidated: alpha, beta and gamma are one unit (@acme).
      blocks: {
        anyManifestMatch: {
          raw: [[5, 5, 4, 1, 2, 2, 0], { '@types/bcryptjs': 2 }, 1],
          consolidated: [[3, 3, 3, 1, 2, 2, 0], { '@types/bcryptjs': 2 }, 1, [6, 4, 2]],
        },
        directUnconditional: {
          raw: [[4, 3, 3, 0, 1, 1, 1], { '@types/bcryptjs': 1 }, 0],
          consolidated: [[3, 3, 3, 0, 1, 1, 0], { '@types/bcryptjs': 1 }, 0, [4, 3, 1]],
        },
      },
    },
    pypi: {
      method: { readFrom: ['release'], notObservableWhen: ['requiresDistNullAndNoWheel'], limits: [] },
      entries: [
        multiPurpose('pypi', 'cryptography', '46.0.0'),
        broken('pypi', 'pyDes', ['DES']),
        deprecated('pypi', 'pycrypto', 'D1'),
      ],
      rows: [
        scanned('alpha-app', [match('cryptography', pypi('none')), matchAs('pydes', 'pyDes', 'normalized', pypi('extra', "extra == 'legacy'"))]),
        scanned('beta-lib', [match('pycrypto', pypi('environmentOnly', "python_version < '3'"))]),
        unread('delta-gone', 'unversioned', 'allYanked'),
        scanned('gamma-tool', [], { observable: 0 }),
        scanned('omega', []),
      ],
      units: [],
      measurability: {
        matched: { k: 3, excluded: [] },
        weak: measure(2, ['pyDes', 'pycrypto'], []),
        brokenAlgorithm: measure(1, ['pyDes'], []),
        deprecatedLibrary: measure(1, ['pycrypto'], []),
        pqc: measure(0, [], []),
      },
      // Any: alpha {cryptography, pyDes}, beta {pycrypto}. Direct (no marker): alpha {cryptography} only. No pqc entry.
      blocks: plain([2, 2, 1, 1, null, null, null], 2, [1, 0, 0, 0, null, null, null], 1),
    },
    go: {
      method: { readFrom: ['release'], notObservableWhen: ['goModHasOnlyModuleLine'], limits: [] },
      entries: [
        broken('go', 'crypto/md5', ['MD5'], { unmatchable: { reason: 'standardLibraryPath', url: evidence('go/crypto-md5'), checkedAt: CHECKED } }),
        multiPurpose('go', 'github.com/cloudflare/circl', 'v1.6.5'),
        deprecated('go', 'github.com/square/go-jose', 'D2', { aliases: [alias('gopkg.in/square/go-jose.v2')] }),
        entry('go', 'golang.org/x/crypto', { aliases: [alias('github.com/golang/crypto')] }),
      ],
      rows: [
        scanned('example.com/app/one', [
          matchAs('gopkg.in/square/go-jose.v2', 'github.com/square/go-jose', 'alias', go(false)),
          match('golang.org/x/crypto', go(true)),
        ]),
        scanned('example.com/app/one/v2', [match('github.com/cloudflare/circl', go(false))]),
        scanned('example.com/lib', [match('golang.org/x/crypto', go(false, { path: 'example.com/fork/crypto', version: 'v0.1.0' }))]),
        scanned('example.com/onlymod', [], { observable: 0 }),
        scanned('example.com/plain', []),
        unread('example.com/zgone', 'absent', 'http410'),
      ],
      units: [{ unit: 'example.com/app/one', members: ['example.com/app/one', 'example.com/app/one/v2'] }],
      measurability: {
        matched: { k: 3, excluded: [{ entry: 'crypto/md5', why: 'unmatchable' }] },
        weak: measure(1, ['github.com/square/go-jose'], [['crypto/md5', 'unmatchable']]),
        brokenAlgorithm: measure(0, [], [['crypto/md5', 'unmatchable']]),
        deprecatedLibrary: measure(1, ['github.com/square/go-jose'], []),
        pqc: measure(0, [], []),
      },
      // Any: one {go-jose, x/crypto}, one/v2 {circl}, lib {x/crypto}. Direct: one {go-jose} (x/crypto is indirect),
      // one/v2 {circl}, lib {x/crypto}. Consolidated: one and one/v2 share example.com/app/one.
      blocks: {
        anyManifestMatch: {
          raw: [[3, 1, null, 1, null, null, null], {}, 0],
          consolidated: [[2, 1, null, 1, null, null, null], {}, 0, [3, 2, 1]],
        },
        directUnconditional: {
          raw: [[3, 1, null, 1, null, null, null], {}, 0],
          consolidated: [[2, 1, null, 1, null, null, null], {}, 0, [3, 2, 1]],
        },
      },
    },
    maven: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: ['parentPomNotFollowed'] },
      entries: [
        unclassified('maven', 'commons-codec:commons-codec', 'primaryFunctionNotCryptography'),
        pqc('maven', 'org.bouncycastle:bcpqc-jdk18on', { registryAbsent: { ...ABSENT } }),
        deprecated('maven', 'org.bouncycastle:bcprov-jdk15on', 'D3'),
        entry('maven', 'org.bouncycastle:bcprov-jdk18on'),
      ],
      rows: [
        scanned('com.example:app', [
          match('org.bouncycastle:bcprov-jdk15on', maven('project', 'compile')),
          match('commons-codec:commons-codec', maven('project', null)),
        ], { manifest: { hasParent: false, propertyCoordinates: 0 } }),
        scanned('com.example:lib', [match('org.bouncycastle:bcprov-jdk18on', maven('managed', null))], { manifest: { hasParent: true, propertyCoordinates: 1 } }),
        scanned('com.example:tool', [
          match('org.bouncycastle:bcprov-jdk18on', maven('project', 'test')),
          match('org.bouncycastle:bcprov-jdk15on', maven('plugin', null)),
        ], { manifest: { hasParent: false, propertyCoordinates: 0 } }),
        { ...unread('org.example:gone', 'absent', 'http404'), page: 1 },
      ],
      units: [{ unit: 'com.example', members: ['com.example:app', 'com.example:lib', 'com.example:tool'] }],
      measurability: {
        matched: { k: 2, excluded: [{ entry: 'commons-codec:commons-codec', why: 'unclassified' }, { entry: 'org.bouncycastle:bcpqc-jdk18on', why: 'registryAbsent' }] },
        weak: measure(1, ['org.bouncycastle:bcprov-jdk15on'], []),
        brokenAlgorithm: measure(0, [], []),
        deprecatedLibrary: measure(1, ['org.bouncycastle:bcprov-jdk15on'], []),
        pqc: measure(0, [], [['org.bouncycastle:bcpqc-jdk18on', 'registryAbsent']]),
      },
      // Any (managed and plugin do not count): app {jdk15on, commons-codec}, tool {jdk18on}; lib has no counting
      // match. Direct: app only (tool's jdk18on is test scope). Consolidated: all three share com.example.
      blocks: {
        anyManifestMatch: {
          raw: [[2, 1, null, 1, null, null, null], { 'commons-codec:commons-codec': 1 }, 0],
          consolidated: [[1, 1, null, 1, null, null, null], { 'commons-codec:commons-codec': 1 }, 0, [2, 1, 1]],
        },
        directUnconditional: {
          raw: [[1, 1, null, 1, null, null, null], { 'commons-codec:commons-codec': 1 }, 0],
          consolidated: [[1, 1, null, 1, null, null, null], { 'commons-codec:commons-codec': 1 }, 0, [1, 1, 0]],
        },
      },
    },
    crates: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      entries: [pqc('crates', 'pqcrypto'), deprecated('crates', 'rust-crypto', 'D1')],
      rows: [
        scanned('quantum-app', [match('pqcrypto', crate('normal')), match('rust-crypto', crate('dev'))]),
        scanned('zz-none', []),
      ],
      units: [],
      measurability: {
        matched: { k: 2, excluded: [] },
        weak: measure(1, ['rust-crypto'], []),
        brokenAlgorithm: measure(0, [], []),
        deprecatedLibrary: measure(1, ['rust-crypto'], []),
        pqc: measure(1, ['pqcrypto'], []),
      },
      // Any: quantum-app {pqcrypto, rust-crypto}, weak and pqc both. Direct: {pqcrypto} (rust-crypto is a dev dependency).
      blocks: plain([1, 1, null, 1, 1, 1, 0], 1, [1, 0, null, 0, 1, 0, 0], 1),
    },
    packagist: {
      method: { readFrom: ['taggedRelease', 'devDefaultBranch'], notObservableWhen: [], limits: [] },
      entries: [
        unclassified('packagist', 'paragonie/random_compat', 'builtinPolyfill'),
        deprecated('packagist', 'phpseclib/mcrypt_compat', 'D4'),
        entry('packagist', 'phpseclib/phpseclib'),
      ],
      rows: [
        scanned('acme/api', [match('phpseclib/phpseclib', { kind: 'require' }), match('phpseclib/mcrypt_compat', { kind: 'suggest' })], { readFrom: 'taggedRelease' }),
        scanned('acme/cli', [match('phpseclib/mcrypt_compat', { kind: 'require' })], { readFrom: 'devDefaultBranch' }),
        scanned('beta/site', [match('paragonie/random_compat', { kind: 'requireDev' })], { readFrom: 'taggedRelease' }),
        unread('zeta/none', 'unversioned', 'noDefaultBranch'),
      ],
      units: [{ unit: 'acme', members: ['acme/api', 'acme/cli'] }],
      measurability: {
        matched: { k: 2, excluded: [{ entry: 'paragonie/random_compat', why: 'unclassified' }] },
        weak: measure(1, ['phpseclib/mcrypt_compat'], []),
        brokenAlgorithm: measure(0, [], []),
        deprecatedLibrary: measure(1, ['phpseclib/mcrypt_compat'], []),
        pqc: measure(0, [], []),
      },
      // Any (suggest does not count): api {phpseclib}, cli {mcrypt_compat}, site {random_compat} only.
      // Direct (require): api, cli. Consolidated: api and cli share the vendor acme.
      blocks: {
        anyManifestMatch: {
          raw: [[2, 1, null, 1, null, null, null], { 'paragonie/random_compat': 1 }, 1],
          consolidated: [[1, 1, null, 1, null, null, null], { 'paragonie/random_compat': 1 }, 1, [3, 2, 1]],
        },
        directUnconditional: {
          raw: [[2, 1, null, 1, null, null, null], { 'paragonie/random_compat': 0 }, 0],
          consolidated: [[1, 1, null, 1, null, null, null], { 'paragonie/random_compat': 0 }, 0, [2, 1, 1]],
        },
      },
      // Without the package read from dev metadata (acme/cli): api {phpseclib}, site {random_compat} only.
      devBlocks: {
        anyManifestMatch: {
          raw: [[1, 0, null, 0, null, null, null], { 'paragonie/random_compat': 1 }, 1],
          consolidated: [[1, 0, null, 0, null, null, null], { 'paragonie/random_compat': 1 }, 1, [2, 2, 0]],
        },
        directUnconditional: {
          raw: [[1, 0, null, 0, null, null, null], { 'paragonie/random_compat': 0 }, 0],
          consolidated: [[1, 0, null, 0, null, null, null], { 'paragonie/random_compat': 0 }, 0, [1, 1, 0]],
        },
      },
    },
    nuget: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      entries: [entry('nuget', 'BouncyCastle.Cryptography'), deprecated('nuget', 'Portable.BouncyCastle', 'D2')],
      rows: [
        scanned('Acme.App', [
          match('BouncyCastle.Cryptography', nuget('net8.0'), nuget('netstandard2.0')),
          match('Portable.BouncyCastle', nuget('netstandard2.0')),
        ], { manifest: { dependencyGroups: ['net8.0', 'netstandard2.0'] } }),
        scanned('Acme.Lib', []),
      ],
      units: [],
      measurability: {
        matched: { k: 2, excluded: [] },
        weak: measure(1, ['Portable.BouncyCastle'], []),
        brokenAlgorithm: measure(0, [], []),
        deprecatedLibrary: measure(1, ['Portable.BouncyCastle'], []),
        pqc: measure(0, [], []),
      },
      // Any: Acme.App {both}. Direct: BouncyCastle.Cryptography is declared in every group, Portable.BouncyCastle in one.
      blocks: plain([1, 1, null, 1, null, null, null], 1, [1, 0, null, 0, null, null, null], 1),
    },
    rubygems: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      entries: [entry('rubygems', 'rbnacl')],
      rows: [scanned('acme-gem', [match('rbnacl', { kind: 'runtime' })])],
      units: [],
      measurability: { matched: { k: 1, excluded: [] }, weak: measure(0, [], []), brokenAlgorithm: measure(0, [], []), deprecatedLibrary: measure(0, [], []), pqc: measure(0, [], []) },
      blocks: plain([1, null, null, null, null, null, null], 1, [1, null, null, null, null, null, null], 1),
    },
    hex: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      entries: [entry('hex', 'enacl')],
      rows: [scanned('acme_hex', [match('enacl', { kind: 'requirement', optional: true })])],
      units: [],
      measurability: { matched: { k: 1, excluded: [] }, weak: measure(0, [], []), brokenAlgorithm: measure(0, [], []), deprecatedLibrary: measure(0, [], []), pqc: measure(0, [], []) },
      // The one requirement is optional: a manifest match, not a direct one. A measured zero.
      blocks: plain([1, null, null, null, null, null, null], 1, [0, null, null, null, null, null, null], 0),
    },
    pub: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      entries: [entry('pub', 'pointycastle')],
      rows: [scanned('acme_dart', [match('pointycastle', { kind: 'devDependencies' })])],
      units: [],
      measurability: { matched: { k: 1, excluded: [] }, weak: measure(0, [], []), brokenAlgorithm: measure(0, [], []), deprecatedLibrary: measure(0, [], []), pqc: measure(0, [], []) },
      blocks: plain([1, null, null, null, null, null, null], 1, [0, null, null, null, null, null, null], 0),
    },
    cocoapods: {
      method: { readFrom: ['release'], notObservableWhen: [], limits: [] },
      entries: [entry('cocoapods', 'CryptoSwift'), deprecated('cocoapods', 'OpenSSL-Universal', 'D1')],
      rows: [
        scanned('AppKitX', [match('CryptoSwift', pod('subspec', 'Core')), match('OpenSSL-Universal', pod('subspec', 'Legacy'))],
          { manifest: { subspecs: ['Core', 'Legacy'], defaultSubspecs: ['Core'] } }),
        scanned('ZetaKit', [matchAs('OpenSSL-Universal/Static', 'OpenSSL-Universal', 'podSubspec', pod('topLevel', null))],
          { manifest: { subspecs: [], defaultSubspecs: null } }),
      ],
      units: [],
      measurability: {
        matched: { k: 2, excluded: [] },
        weak: measure(1, ['OpenSSL-Universal'], []),
        brokenAlgorithm: measure(0, [], []),
        deprecatedLibrary: measure(1, ['OpenSSL-Universal'], []),
        pqc: measure(0, [], []),
      },
      // Any: AppKitX {both}, ZetaKit {OpenSSL-Universal}. Direct: AppKitX {CryptoSwift} (Legacy is not a default
      // subspec), ZetaKit {OpenSSL-Universal} (top level).
      blocks: plain([2, 2, null, 2, null, null, null], 2, [2, 1, null, 1, null, null, null], 2),
    },
  };
}

/** The multi-purpose libraries and their dependents: circl by one/v2 (and the unit it is in), cryptography by alpha-app. */
const MULTI_PURPOSE = [
  { ecosystem: 'pypi', entry: 'cryptography', counts: [1, 1, 1, 1] },
  { ecosystem: 'go', entry: 'github.com/cloudflare/circl', counts: [1, 1, 1, 1] },
];

// --- Building a dataset ---------------------------------------------------------

const sum = (values) => values.reduce((total, value) => total + value, 0);
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileName = {
  corpus: (date) => `corpus-${date}.json`,
  catalog: (date) => `catalog-${date}.json`,
  consolidation: (date) => `consolidation-${date}.json`,
  scan: (eco) => `scan-results-${eco}.json`,
  listing: (eco) => `listing-${eco}.tsv.gz`,
};

function cellsOf(spec, k, definitionId) {
  const [cells, byEntry, only, stats] = spec;
  const block = { definitionId };
  CLASSES.forEach((cls, i) => {
    block[cls] = { count: cells[i], k: k[cls], nullReason: cells[i] === null ? 'noCountableEntry' : null };
  });
  JOINT.forEach((joint, j) => {
    block[joint] = { count: cells[5 + j], nullReason: cells[5 + j] === null ? 'noCountableEntry' : null };
  });
  block.excludedUnclassified = {
    matches: sum(Object.values(byEntry)),
    unitsWithOnlyUnclassifiedMatches: only,
    byEntry: Object.entries(byEntry).map(([entry, matches]) => ({ entry, matches })),
  };
  if (stats) block.consolidation = { unitsIn: stats[0], unitsOut: stats[1], merged: stats[2], removedByRule: {} };
  return block;
}

const ID = {
  anyManifestMatch: 'census.match.anyManifest/1',
  directUnconditional: 'census.match.directUnconditional/1',
  raw: 'census.unit.package/1',
  consolidated: 'census.unit.consolidated/1',
};

function blocksOf(specs, k) {
  return Object.fromEntries(DEFINITIONS.map((definition) => [definition, Object.fromEntries(UNITS.map((unit) =>
    [unit, cellsOf(specs[definition][unit], k, `${ID[definition]}+${ID[unit]}`)]))]));
}

/** A total, summed by this file's own code: a class cell over the rows where its K is above 0. */
function totalOf(rows) {
  const total = { definitionId: rows[0].block.definitionId };
  for (const cls of CLASSES) {
    const measurable = rows.filter(({ block }) => block[cls].k > 0);
    total[cls] = {
      count: measurable.length ? sum(measurable.map(({ block }) => block[cls].count)) : null,
      k: sum(measurable.map(({ block }) => block[cls].k)),
      nullReason: measurable.length ? null : 'noCountableEntry',
      measurableIn: measurable.map(({ eco }) => eco),
      notMeasurableIn: rows.filter(({ block }) => block[cls].k === 0).map(({ eco }) => eco),
    };
  }
  for (const joint of JOINT) {
    const counted = rows.filter(({ block }) => block[joint].count !== null);
    total[joint] = counted.length ? { count: sum(counted.map(({ block }) => block[joint].count)), nullReason: null } : { count: null, nullReason: 'noCountableEntry' };
  }
  total.excludedUnclassified = {
    matches: sum(rows.map(({ block }) => block.excludedUnclassified.matches)),
    unitsWithOnlyUnclassifiedMatches: sum(rows.map(({ block }) => block.excludedUnclassified.unitsWithOnlyUnclassifiedMatches)),
    byEntry: rows.flatMap(({ block }) => block.excludedUnclassified.byEntry),
  };
  if (rows[0].block.consolidation) {
    total.consolidation = {
      unitsIn: sum(rows.map(({ block }) => block.consolidation.unitsIn)),
      unitsOut: sum(rows.map(({ block }) => block.consolidation.unitsOut)),
      merged: sum(rows.map(({ block }) => block.consolidation.merged)),
      removedByRule: {},
    };
  }
  return total;
}

const scannedRow = (row) => row.disposition === 'scanned';
const coverageOf = (rows) => ({
  listed: rows.length,
  scanned: rows.filter(scannedRow).length,
  absent: rows.filter((row) => row.disposition === 'absent').length,
  unresolved: rows.filter((row) => row.disposition === 'unresolved').length,
  unversioned: rows.filter((row) => row.disposition === 'unversioned').length,
  dependenciesNotObservable: rows.filter((row) => scannedRow(row) && row.observable === 0).length,
});

/**
 * Every file of one version 2 dataset, as bytes by name. `change` may hold one
 * function for each stage, called with what that stage built, before it is
 * written and hashed: fixture, catalog, ledgers (lines by registry), scans,
 * consolidation, corpus, manifest.
 */
function buildDataset(date, change = {}, earlier = [{ dataset: FIRST_SHAPE, version: 1 }]) {
  const fixture = registries();
  change.fixture?.(fixture);
  for (const eco of ECOSYSTEMS) {
    const r = fixture[eco];
    for (const row of r.rows) if (scannedRow(row) && row.readFrom === null) row.readFrom = r.method.readFrom[0];
    r.rows.sort((a, b) => byteOrder(a.name, b.name));
  }
  const files = {};

  const entries = structuredClone(ECOSYSTEMS.flatMap((eco) => fixture[eco].entries))
    .sort((a, b) => byteOrder(a.ecosystem, b.ecosystem) || byteOrder(a.name, b.name));
  const catalog = {
    schemaVersion: 2, kind: 'censusCatalog', collectedAt: date, sourceCommit: COMMIT,
    matchSetSha256: MATCH_SET, classificationSha256: CLASSIFICATION,
    matchRules: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, `${eco}Name/1`])),
    entries,
  };
  change.catalog?.(catalog);
  files[fileName.catalog(date)] = json(catalog);

  const ledgers = {};
  for (const eco of ECOSYSTEMS) {
    // Packagist adds the type of the version read, Maven the search page a package was drawn from.
    const extra = (row) => (eco === 'packagist' ? [scannedRow(row) ? 'library' : ''] : eco === 'maven' ? [String(row.page ?? 0)] : []);
    ledgers[eco] = [['name', 'disposition', 'reason', 'version', 'readFrom', 'observable', 'matches', ...(LEDGER_EXTRA[eco] ?? [])].join('\t'),
      ...fixture[eco].rows.map((row) => [...(scannedRow(row)
        ? [row.name, 'scanned', '', '1.0.0', row.readFrom, String(row.observable), String(row.matches.length)]
        : [row.name, row.disposition, row.reason, '', '', '', '']), ...extra(row)].join('\t'))];
  }
  change.ledgers?.(ledgers);
  for (const eco of ECOSYSTEMS) {
    files[fileName.listing(eco)] = Buffer.isBuffer(ledgers[eco]) ? ledgers[eco] : gzipSync(`${ledgers[eco].join('\n')}\n`);
  }

  const scans = {};
  for (const eco of ECOSYSTEMS) {
    const r = fixture[eco];
    const coverage = coverageOf(r.rows);
    const byReadFrom = Object.fromEntries(r.method.readFrom.map((source) => [source, r.rows.filter((row) => scannedRow(row) && row.readFrom === source).length]));
    const packages = r.rows.filter((row) => scannedRow(row) && row.matches.length > 0)
      .map((row) => ({ name: row.name, version: '1.0.0', readFrom: row.readFrom, manifest: row.manifest, matches: row.matches }));
    const catalogCheck = r.entries.flatMap((e) => [
      {
        entry: e.name, alias: null,
        status: e.registryAbsent ? 'absent' : e.unmatchable ? 'notApplicable' : 'present',
        httpStatus: e.registryAbsent ? 404 : e.unmatchable ? null : 200,
        url: e.unmatchable ? null : `https://${eco}.registry.example/check/${encodeURIComponent(e.name)}`,
        checkedAt: `${date}T00:30:00Z`, latestVersion: null, latestReleaseAt: null,
      },
      ...e.aliases.map((a) => ({
        entry: e.name, alias: a.name, status: 'present', httpStatus: 200,
        url: `https://${eco}.registry.example/check/${encodeURIComponent(a.name)}`,
        checkedAt: `${date}T00:30:00Z`, latestVersion: null, latestReleaseAt: null,
      })),
    ]);
    scans[eco] = {
      schemaVersion: 2, kind: 'censusScan', ecosystem: eco,
      startedAt: `${date}T00:00:00Z`, finishedAt: `${date}T06:00:00Z`,
      scanner: { script: `scripts/scan-${eco}.mjs`, commit: COMMIT },
      sources: eco === 'go'
        ? { enumeration: 'https://index.golang.org/index', manifests: 'https://proxy.golang.org/cached-only' }
        : { enumeration: `https://${eco}.registry.example/list`, manifests: `https://${eco}.registry.example/manifests` },
      catalog: { entries: r.entries.length, matchSetSha256: MATCH_SET, matchRule: `${eco}Name/1` },
      method: { versionSelection: 'latest', readFrom: r.method.readFrom, declarationKinds: [...KINDS[eco]], notObservableWhen: r.method.notObservableWhen, limits: r.method.limits },
      enumeration: {
        requested: 1000, listed: coverage.listed, truncated: false, reason: null, unit: 'packages', budgetMinutes: null,
        elapsedMinutes: 1.5, frameSize: null, sampling: r.sampling ?? { method: 'registryOrder', seed: null },
        indexWindow: eco === 'go' ? { since: '2026-09-01T00:00:00Z', until: `${date}T00:00:00Z` } : null,
      },
      versionYears: eco === 'go' ? { 2024: 2, 2025: 3 } : null,
      coverage: { ...coverage, scannedByReadFrom: byReadFrom },
      listing: { file: fileName.listing(eco), sha256: sha256(files[fileName.listing(eco)]), rows: coverage.listed },
      catalogCheck,
      packagesWithMatch: packages.length,
      packages,
    };
  }
  change.scans?.(scans);
  for (const eco of ECOSYSTEMS) files[fileName.scan(eco)] = json(scans[eco]);

  const consolidation = {
    schemaVersion: 2, kind: 'censusConsolidation', collectedAt: date, definitionId: ID.consolidated,
    rules: [{ id: 'sharedNamespace', statement: 'Packages that share an npm scope, a Maven groupId, a Packagist vendor or the first three elements of a Go path are one unit.' }],
    byEcosystem: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, { units: fixture[eco].units, removed: [] }])),
  };
  change.consolidation?.(consolidation);
  files[fileName.consolidation(date)] = json(consolidation);

  const rows = {};
  for (const eco of ECOSYSTEMS) {
    const r = fixture[eco];
    const k = Object.fromEntries(CLASSES.map((cls) => [cls, r.measurability[cls].k]));
    rows[eco] = { ...blocksOf(r.blocks, k), excludingDevMetadata: null };
    if (r.devBlocks) {
      rows[eco].excludingDevMetadata = {
        coverage: coverageOf(r.rows.filter((row) => row.readFrom !== 'devDefaultBranch')),
        ...blocksOf(r.devBlocks, k),
      };
    }
  }
  const totalsOver = (pick) => Object.fromEntries(DEFINITIONS.map((definition) => [definition, Object.fromEntries(UNITS.map((unit) =>
    [unit, totalOf(ECOSYSTEMS.map((eco) => ({ eco, block: pick(eco)[definition][unit] })))]))]));
  const comparability = earlier.map(({ dataset, version }) => (version === 1
    ? { dataset, doi: null, comparable: false, reason: 'instrumentChanged', changes: [...CHANGE_CODES] }
    : { dataset, doi: null, comparable: true, reason: null, changes: [] }));
  const corpus = {
    schemaVersion: 2, kind: 'censusCorpus', collectedAt: date, generatedAt: `${date}T12:00:00Z`,
    inputs: {
      scans: ECOSYSTEMS.map((eco) => ({ ecosystem: eco, file: fileName.scan(eco), sha256: sha256(files[fileName.scan(eco)]) })),
      catalog: { file: fileName.catalog(date), sha256: sha256(files[fileName.catalog(date)]), matchSetSha256: MATCH_SET, classificationSha256: CLASSIFICATION },
      consolidation: { file: fileName.consolidation(date), sha256: sha256(files[fileName.consolidation(date)]) },
    },
    definitions: {
      coverage: { id: 'census.coverage/1' },
      unresolvedCeiling: 0.01,
      anyManifestMatch: { id: ID.anyManifestMatch, includes: structuredClone(INCLUDES) },
      directUnconditional: { id: ID.directUnconditional, predicate: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, `The ${eco} declarations that count as direct and unconditional.`])) },
      raw: { id: ID.raw },
      consolidated: { id: ID.consolidated },
      classes: {
        matched: 'census.class.classifiedEntry/1', weak: 'census.class.weak/1', brokenAlgorithm: 'census.class.brokenAlgorithm/1',
        deprecatedLibrary: 'census.class.deprecatedLibrary/1', pqc: 'census.class.pqcDedicated/1',
      },
      multiPurposeLibrary: { id: 'census.table.multiPurposeLibrary/1' },
    },
    comparability,
    blocked: [],
    coverage: {
      total: Object.fromEntries(COVERAGE.map((field) => [field, sum(ECOSYSTEMS.map((eco) => scans[eco].coverage[field]))])),
      byEcosystem: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, structuredClone({ ...scans[eco].coverage, enumeration: scans[eco].enumeration })])),
    },
    byEcosystem: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, { measurability: fixture[eco].measurability, ...rows[eco] }])),
    total: {
      ...totalsOver((eco) => rows[eco]),
      excludingDevMetadata: {
        coverage: Object.fromEntries(COVERAGE.map((field) => [field, sum(ECOSYSTEMS.map((eco) => (rows[eco].excludingDevMetadata ?? { coverage: scans[eco].coverage }).coverage[field]))])),
        ...totalsOver((eco) => rows[eco].excludingDevMetadata ?? rows[eco]),
      },
    },
    multiPurposeLibraries: MULTI_PURPOSE.map(({ ecosystem, entry: name, counts }) => ({
      ecosystem, entry: name, definitionId: 'census.table.multiPurposeLibrary/1',
      dependents: { anyManifestMatch: { raw: counts[0], consolidated: counts[1] }, directUnconditional: { raw: counts[2], consolidated: counts[3] } },
    })),
  };
  // The measurability objects of the fixture are shared with the corpus above; copy them so a change to one is a change to one.
  for (const eco of ECOSYSTEMS) corpus.byEcosystem[eco].measurability = structuredClone(fixture[eco].measurability);
  change.corpus?.(corpus);
  files[fileName.corpus(date)] = json(corpus);

  const listing = [
    { role: 'corpus', ecosystem: null, file: fileName.corpus(date) },
    { role: 'catalog', ecosystem: null, file: fileName.catalog(date) },
    { role: 'consolidation', ecosystem: null, file: fileName.consolidation(date) },
    ...ECOSYSTEMS.flatMap((eco) => [
      { role: 'scan', ecosystem: eco, file: fileName.scan(eco) },
      { role: 'listing', ecosystem: eco, file: fileName.listing(eco) },
    ]),
  ];
  const manifest = {
    schemaVersion: 2,
    dataset: 'Example census dataset, built by the validator tests',
    kind: 'raw+aggregate',
    collectedAt: date,
    generatedAt: `${date}T13:00:00Z`,
    license: 'CC-BY-4.0',
    provenance: { sourceRepository: 'example/census', sourceCommit: COMMIT, workflowRun: 'https://ci.example/runs/1' },
    files: listing.map((item) => ({ ...item, bytes: Buffer.byteLength(files[item.file]), sha256: sha256(files[item.file]), schemaVersion: 2 })),
    coverage: Object.fromEntries(COVERAGE.map((field) => [field, sum(ECOSYSTEMS.map((eco) => scans[eco].coverage[field]))])),
    ecosystems: ECOSYSTEMS.map((eco) => structuredClone({ ecosystem: eco, coverage: scans[eco].coverage, enumeration: scans[eco].enumeration, sources: scans[eco].sources })),
    comparability: structuredClone(corpus.comparability),
    checks: Object.fromEntries(CHECKS.map((check) => [check, []])),
    complete: true,
    knownIssues: [],
  };
  change.manifest?.(manifest);
  files['MANIFEST.json'] = json(manifest);
  return files;
}

/**
 * The first problem a failed run prints for the dataset under test: a planted
 * defect's own rule is reported before anything it sets off. A dataset
 * validated before it reports its own problems first, so they are skipped.
 */
function firstProblem(stderr, dataset = DATE) {
  return stderr.split('\n').find((line) => line.startsWith(`  ${dataset}: `)) ?? '';
}

const run = (args, options) => new Promise((done) => {
  execFile(process.execPath, args, { ...options, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
});

/**
 * Write a repository holding a copy of the validator, a copy of the smaller
 * published dataset, and the version 2 datasets given, and run the copy.
 * `datasets` maps a directory name to [date, change, earlier]; `prepare` runs
 * on the directory before the validator does.
 */
async function validate(datasets, prepare) {
  const dir = mkdtempSync(join(tmpdir(), 'census-v2-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts', 'validate-dataset.mjs'), join(dir, 'scripts', 'validate-dataset.mjs'));
    cpSync(join(ROOT, 'datasets', FIRST_SHAPE), join(dir, 'datasets', FIRST_SHAPE), { recursive: true });
    for (const [directory, [date, change, earlier]] of Object.entries(datasets)) {
      const target = join(dir, 'datasets', directory);
      mkdirSync(target, { recursive: true });
      for (const [name, bytes] of Object.entries(buildDataset(date, change, earlier))) writeFileSync(join(target, name), bytes);
    }
    if (prepare) await prepare(dir);
    return await run([join(dir, 'scripts', 'validate-dataset.mjs')], { env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The usual case: one version 2 dataset, under its own date, beside the published one. */
const validateOne = (change = {}, prepare = undefined) => validate({ [DATE]: [DATE, change] }, prepare);
const datasetDir = (dir) => join(dir, 'datasets', DATE);

// --- Version, manifest and files ----------------------------------------------

/** [the defect, the change that plants it, what the output says, and optionally a step on the files once written]. */
const defects = [];

const plant = (what, change, problem, prepare) => defects.push([what, change, problem, prepare]);

const scanOf = (eco, fn) => ({ scans: (scans) => fn(scans[eco]) });

const catalogOf = (fn) => ({ catalog: fn });

const manifestOf = (fn) => ({ manifest: fn });

test('a version 2 dataset that meets the contract passes', async () => {
  const result = await validateOne();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /2 dataset\(s\) validated: 2026-03-18, 2026-09-30/);
});

// Each object is closed: a field the contract does not define fails, at every level.
const closedInTheManifest = [
  ['the manifest\'s provenance', manifestOf((m) => { m.provenance.note = 'x'; }), /MANIFEST\.json: provenance carries note/],
  ['the manifest\'s checks', manifestOf((m) => { m.checks.note = []; }), /MANIFEST\.json: checks carries note/],
  ['a file of the manifest', manifestOf((m) => { m.files[0].note = 'x'; }), /MANIFEST\.json: files\[0\] carries note/],
  ['the manifest', manifestOf((m) => { m.note = 'x'; }), /MANIFEST\.json is not a version 2 manifest: it carries note/],
];
for (const [level, change, problem] of closedInTheManifest) plant(`a field the contract does not define, in ${level}`, change, problem);

// The version a dataset declares.
plant('an unknown schemaVersion', manifestOf((m) => { m.schemaVersion = 3; }), /2026-09-30: schemaVersion is 3, which is not a version these rules know/);
plant('the version written as text', manifestOf((m) => { m.schemaVersion = '2'; }), /2026-09-30: schemaVersion is "2", which is not a version these rules know/);
plant('a version 2 dataset without its marker, under a date that is not a published first-shape dataset',
  manifestOf((m) => { delete m.schemaVersion; }), /2026-09-30: MANIFEST\.json declares no schemaVersion/);
plant('a manifest whose schemaVersion is not its first key', manifestOf((m) => { const { schemaVersion, ...rest } = m; Object.keys(m).forEach((k) => delete m[k]); Object.assign(m, rest, { schemaVersion }); }),
  /MANIFEST\.json does not begin with schemaVersion/);
plant('a manifest that is a first-shape manifest with the marker added',
  manifestOf((m) => { delete m.files; delete m.ecosystems; m.corpus = { file: 'corpus-2026-09-30.json' }; m.totalScanned = 1; }),
  /schemaVersion is 2, but MANIFEST\.json is not a version 2 manifest: it lacks files, ecosystems; it carries corpus, totalScanned/);
plant('a manifest that is a link to a file elsewhere', {}, /MANIFEST\.json is not a regular file/, (dir) => {
  const path = join(datasetDir(dir), 'MANIFEST.json');
  writeFileSync(join(dir, 'kept.json'), readText(path));
  unlinkSync(path);
  symlinkSync(join('..', '..', 'kept.json'), path);
});

// The manifest's own fields.
plant('a dataset with no title', manifestOf((m) => { m.dataset = ' '; }), /MANIFEST\.json: dataset is " ", not a title/);
plant('the aggregate-only kind', manifestOf((m) => { m.kind = 'aggregate-only'; }), /MANIFEST\.json: kind is "aggregate-only"\. A version 2 dataset is raw\+aggregate/);
plant('a collection date that is not the directory\'s', manifestOf((m) => { m.collectedAt = '2026-09-29'; }), /MANIFEST\.json: collectedAt is "2026-09-29", and the directory is 2026-09-30/);
plant('a generation time that is not a time', manifestOf((m) => { m.generatedAt = 'yesterday'; }), /MANIFEST\.json: generatedAt is "yesterday", not an ISO 8601 UTC time/);
plant('a time without its zone', manifestOf((m) => { m.generatedAt = '2026-09-30T13:00:00'; }), /MANIFEST\.json: generatedAt is "2026-09-30T13:00:00", not an ISO 8601 UTC time/);
plant('another licence', manifestOf((m) => { m.license = 'CC0-1.0'; }), /MANIFEST\.json: license is "CC0-1\.0"/);
plant('a run that is not named', manifestOf((m) => { m.provenance.workflowRun = null; }), /MANIFEST\.json: provenance\.workflowRun is null\. A published dataset that cannot say which run/);
plant('a check the generator found failing', manifestOf((m) => { m.checks.noMatches = ['hex']; }), /MANIFEST\.json: checks\.noMatches lists \["hex"\]\. The generator found the dataset incomplete/);
plant('a check that is not a list', manifestOf((m) => { m.checks.identityFailures = null; }), /MANIFEST\.json: checks\.identityFailures is null, not a list/);
plant('a manifest that says it is not complete', manifestOf((m) => { m.complete = false; }), /MANIFEST\.json: complete is false/);
plant('known issues that are not a list', manifestOf((m) => { m.knownIssues = {}; }), /MANIFEST\.json: knownIssues is \{\}, not a list/);

// The files the manifest lists, and the ones it does not.
const fileEntry = (m, file) => m.files.find((f) => f.file === file);
plant('a wrong hash', manifestOf((m) => { fileEntry(m, 'scan-results-hex.json').sha256 = '0'.repeat(64); }), /scan-results-hex\.json does not match its recorded hash/);
plant('a hash that is not one', manifestOf((m) => { fileEntry(m, 'scan-results-hex.json').sha256 = 'abc'; }), /files\[\d+\]\.sha256 is "abc", not a SHA-256 digest in lower-case hex/);
plant('a wrong size', manifestOf((m) => { fileEntry(m, 'listing-pub.tsv.gz').bytes += 1; }), /listing-pub\.tsv\.gz is \d+ bytes, manifest says \d+/);
plant('a size that is not a count', manifestOf((m) => { fileEntry(m, 'listing-pub.tsv.gz').bytes = '12'; }), /files\[\d+\]\.bytes is "12", not a size in bytes/);
plant('a stray file', {}, /present but not listed in MANIFEST\.json: notes\.txt\. An unlisted file/, (dir) => writeFileSync(join(datasetDir(dir), 'notes.txt'), 'notes\n'));
plant('a stray ledger', {}, /present but not listed in MANIFEST\.json: listing-npm-old\.tsv\.gz/, (dir) => writeFileSync(join(datasetDir(dir), 'listing-npm-old.tsv.gz'), gzipSync('x\n')));
plant('a first-shape scan file beside the new ones', {}, /present but not listed in MANIFEST\.json: scan-results-npm-clean\.json/,
  (dir) => writeFileSync(join(datasetDir(dir), 'scan-results-npm-clean.json'), '{"ecosystem":"npm","totalScanned":1}\n'));
plant('a listed file that is missing', {}, /listing-hex\.tsv\.gz is listed in MANIFEST\.json but is not in the dataset/, (dir) => unlinkSync(join(datasetDir(dir), 'listing-hex.tsv.gz')));
plant('a link in place of a file', {}, /scan-results-pub\.json is not a regular file\. A link would keep its bytes somewhere/, (dir) => {
  const path = join(datasetDir(dir), 'scan-results-pub.json');
  writeFileSync(join(dir, 'kept.json'), readText(path));
  unlinkSync(path);
  symlinkSync(join('..', '..', 'kept.json'), path);
});
plant('a directory in place of a file', {}, /listing-hex\.tsv\.gz is not a regular file/, (dir) => {
  unlinkSync(join(datasetDir(dir), 'listing-hex.tsv.gz'));
  mkdirSync(join(datasetDir(dir), 'listing-hex.tsv.gz'));
});
plant('an oversize file', {}, /scan-results-crates\.json is 95,000,001 bytes, over the 95,000,000 a dataset file may hold/,
  (dir) => truncateSync(join(datasetDir(dir), 'scan-results-crates.json'), 95_000_001));
plant('a role that is not one', manifestOf((m) => { fileEntry(m, 'listing-pub.tsv.gz').role = 'notes'; }), /files\[\d+\]\.role is "notes", not one of: corpus, scan, listing, catalog, consolidation/);
plant('a scan file for a registry that is not one', manifestOf((m) => { fileEntry(m, 'scan-results-pub.json').ecosystem = 'conda'; }), /files\[\d+\]\.ecosystem is "conda", not one of the eleven registries/);
plant('a corpus that names a registry', manifestOf((m) => { fileEntry(m, 'corpus-2026-09-30.json').ecosystem = 'npm'; }), /files\[0\]\.ecosystem is "npm"; the corpus file covers every registry, so it is null/);
plant('a scan file under its first-shape name', manifestOf((m) => { fileEntry(m, 'scan-results-pub.json').file = 'scan-results-pub-clean.json'; }),
  /files\[\d+\] names "scan-results-pub-clean\.json" as the scan file of pub, which is named scan-results-pub\.json/);
plant('a file listed twice', manifestOf((m) => { m.files.push({ ...fileEntry(m, 'listing-pub.tsv.gz') }); }), /files\[25\] lists listing-pub\.tsv\.gz a second time/);
plant('a ledger recorded as another version', manifestOf((m) => { fileEntry(m, 'listing-pub.tsv.gz').schemaVersion = 1; }), /files\[\d+\]\.schemaVersion is 1\. Every file of a version 2 dataset is version 2/);
plant('no catalogue snapshot', manifestOf((m) => { m.files = m.files.filter((f) => f.role !== 'catalog'); }), /MANIFEST\.json lists no catalog file/);
plant('a registry with no scan file', manifestOf((m) => { m.files = m.files.filter((f) => f.file !== 'scan-results-hex.json'); }), /MANIFEST\.json lists no scan file for hex\. All eleven registries/);
plant('a registry with no ledger', manifestOf((m) => { m.files = m.files.filter((f) => f.file !== 'listing-hex.tsv.gz'); }), /MANIFEST\.json lists no listing ledger for hex/);
plant('files that are not a list', manifestOf((m) => { m.files = {}; }), /MANIFEST\.json: files is \{\}, not a list/);

// Every JSON file of the dataset is version 2, read strictly.
const rehash = (file, bytes) => (dir) => {
  writeFileSync(join(datasetDir(dir), file), bytes);
  const path = join(datasetDir(dir), 'MANIFEST.json');
  const m = JSON.parse(readText(path));
  const item = m.files.find((f) => f.file === file);
  item.sha256 = sha256(bytes);
  item.bytes = Buffer.byteLength(bytes);
  writeFileSync(path, json(m));
};
plant('a version 1 file inside', scanOf('hex', (s) => { delete s.schemaVersion; }), /scan-results-hex\.json carries no schemaVersion, so it is a version 1 file/);
plant('a file of an unknown version inside', catalogOf((c) => { c.schemaVersion = 3; }), /catalog-2026-09-30\.json has schemaVersion 3\. Every file of a version 2 dataset is version 2/);
plant('a file whose schemaVersion is not its first key', {}, /consolidation-2026-09-30\.json does not begin with schemaVersion/, (dir) => {
  const path = join(datasetDir(dir), 'consolidation-2026-09-30.json');
  const { schemaVersion, ...rest } = JSON.parse(readText(path));
  rehash('consolidation-2026-09-30.json', json({ ...rest, schemaVersion }))(dir);
});
plant('a file that does not parse', {}, /scan-results-hex\.json does not parse/, (dir) => rehash('scan-results-hex.json', '{"schemaVersion": 2,')(dir));
plant('a file that is a list', {}, /scan-results-hex\.json is not a JSON object/, (dir) => rehash('scan-results-hex.json', '[]\n')(dir));
plant('a file with a byte that is not UTF-8', {}, /scan-results-hex\.json is not UTF-8/, (dir) => rehash('scan-results-hex.json', Buffer.from([0x7b, 0xff, 0x7d]))(dir));

// Fields left out of nested objects, and the remaining types.
plant('a manifest that is not UTF-8', {}, /MANIFEST\.json is not UTF-8/, (dir) => {
  const path = join(datasetDir(dir), 'MANIFEST.json');
  const text = Buffer.from(readText(path));
  const at = text.indexOf('Example census');
  writeFileSync(path, Buffer.concat([text.subarray(0, at), Buffer.from([0xff]), text.subarray(at + 1)]));
});
plant('an oversize manifest', {}, /MANIFEST\.json is 95,\d{3},\d{3} bytes, over the 95,000,000 a dataset file may hold/, (dir) => {
  const path = join(datasetDir(dir), 'MANIFEST.json');
  writeFileSync(path, readText(path) + ' '.repeat(95_000_001));
});

// Where a dataset sits.
test('a version 2 manifest in a published first-shape directory is refused', async () => {
  const result = await validate({ '2026-08-03': ['2026-08-03', {}] });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, '2026-08-03'), /2026-08-03: schemaVersion is 2, and 2026-08-03 is one of the datasets published in the first file shape/, result.stderr);
});
test('a first-shape manifest under a version 2 date is refused', async () => {
  const result = await validate({}, (dir) => cpSync(join(ROOT, 'datasets', FIRST_SHAPE), join(dir, 'datasets', DATE), { recursive: true }));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /2026-09-30: MANIFEST\.json declares no schemaVersion\. The first file shape is accepted only for 2026-03-18 and 2026-08-03/, result.stderr);
});

// --- Catalogue snapshot and raw scan files ---------------------------------------

const entryOf = (eco, name, fn) => catalogOf((c) => fn(c.entries.find((e) => e.ecosystem === eco && e.name === name)));

// Each object is closed: a field the contract does not define fails, at every level.
const closedInTheSnapshotAndScans = [
  ['the catalogue snapshot', catalogOf((c) => { c.note = 'x'; }), /catalog-2026-09-30\.json carries note/],
  ['a catalogue entry', entryOf('npm', 'md5', (e) => { e.replacedBy = '@noble/hashes'; }), /entries\[\d+\] \(npm:md5\) carries replacedBy/],
  ['an entry\'s class evidence', entryOf('npm', 'md5', (e) => { e.classEvidence.note = 'x'; }), /\(npm:md5\): classEvidence carries note/],
  ['an entry\'s reason for being unclassified', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.note = 'x'; }), /unclassifiedReason carries note/],
  ['an entry\'s end-of-life review', entryOf('npm', 'md5', (e) => { e.endOfLifeReview.note = 'x'; }), /endOfLifeReview carries note/],
  ['an entry\'s multi-purpose record', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.note = 'x'; }), /multiPurpose carries note/],
  ['an entry\'s unmatchable record', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.note = 'x'; }), /unmatchable carries note/],
  ['an entry\'s registry-absent record', entryOf('npm', 'tripledes', (e) => { e.registryAbsent.extra = 'x'; }), /registryAbsent carries extra/],
  ['an alias', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].note = 'x'; }), /aliases\[0\] carries note/],
  ['an entry\'s last release', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.note = 'x'; }), /lastRelease carries note/],
  ['a raw scan file', scanOf('hex', (s) => { s.totalScanned = 1; }), /scan-results-hex\.json carries totalScanned/],
  ['the scanner record', scanOf('hex', (s) => { s.scanner.note = 'x'; }), /scan-results-hex\.json: scanner carries note/],
  ['the scan\'s catalogue record', scanOf('hex', (s) => { s.catalog.note = 'x'; }), /scan-results-hex\.json: catalog carries note/],
  ['the scan method', scanOf('hex', (s) => { s.method.note = 'x'; }), /scan-results-hex\.json: method carries note/],
  ['the enumeration', scanOf('hex', (s) => { s.enumeration.collected = 1; }), /scan-results-hex\.json: enumeration carries collected/],
  ['the sampling', scanOf('hex', (s) => { s.enumeration.sampling.size = 1; }), /enumeration\.sampling carries size/],
  ['the Go index window', scanOf('go', (s) => { s.enumeration.indexWindow.note = 'x'; }), /enumeration\.indexWindow carries note/],
  ['the scan coverage', scanOf('hex', (s) => { s.coverage.fetchErrors = 0; }), /scan-results-hex\.json: coverage carries fetchErrors/],
  ['the listing record', scanOf('hex', (s) => { s.listing.note = 'x'; }), /scan-results-hex\.json: listing carries note/],
  ['a registry check', scanOf('hex', (s) => { s.catalogCheck[0].note = 'x'; }), /catalogCheck\[0\] carries note/],
  ['a package record', scanOf('hex', (s) => { s.packages[0].posture = 'modern'; }), /packages\[0\] \(acme_hex\) carries posture/],
  ['a match record', scanOf('hex', (s) => { s.packages[0].matches[0].direct = true; }), /matches\[0\] carries direct/],
  ['a declaration', scanOf('hex', (s) => { s.packages[0].matches[0].declarations[0].tier = 'other'; }), /declarations\[0\] carries tier/],
];
for (const [level, change, problem] of closedInTheSnapshotAndScans) plant(`a field the contract does not define, in ${level}`, change, problem);

// Each object is closed: a field the contract does not define fails, at every level.
plant('a stored share in a scan file', scanOf('npm', (s) => { s.coverage.unresolvedShare = 0; }), /coverage carries unresolvedShare, a stored share/);
plant('a missing field', scanOf('hex', (s) => { delete s.versionYears; }), /scan-results-hex\.json is missing versionYears\. Every field of a version 2 file is written out/);

// The catalogue snapshot: the entry's fields, and the states the contract makes impossible.
plant('a snapshot of another kind', catalogOf((c) => { c.kind = 'censusCorpus'; }), /catalog-2026-09-30\.json: kind is "censusCorpus", not "censusCatalog"/);
plant('a snapshot of another date', catalogOf((c) => { c.collectedAt = '2026-09-01'; }), /catalog-2026-09-30\.json: collectedAt is "2026-09-01", not the dataset's date/);
plant('a snapshot with no source commit', catalogOf((c) => { c.sourceCommit = null; }), /sourceCommit is null, not the commit/);
plant('a digest that is not one', catalogOf((c) => { c.classificationSha256 = 'PLACEHOLDER'; }), /classificationSha256 is "PLACEHOLDER", not a SHA-256 digest/);
plant('a registry with no match rule', catalogOf((c) => { delete c.matchRules.hex; }), /matchRules is missing hex/);
plant('entries that are not a list', catalogOf((c) => { c.entries = {}; }), /catalog-2026-09-30\.json: entries is \{\}, not a list/);
plant('entries out of order', catalogOf((c) => { c.entries.reverse(); }), /does not follow .*Entries are sorted by registry and then by name/);
plant('an entry listed twice', catalogOf((c) => { c.entries.splice(1, 0, structuredClone(c.entries[1])); }), /does not follow .*each appears once/);
plant('an entry of a registry that is not one', entryOf('hex', 'enacl', (e) => { e.ecosystem = 'conda'; }), /ecosystem is "conda", not one of the eleven registries/);
plant('a tier that is not one', entryOf('npm', 'node-forge', (e) => { e.tier = 'modern'; }), /\(npm:node-forge\): tier is "modern", not weak, other, pqc or null/);
plant('a weak class that is not one', entryOf('npm', 'md5', (e) => { e.weakClass = 'mixedUse'; }), /weakClass is "mixedUse", not brokenAlgorithm, deprecatedLibrary or null/);
plant('classified written as text', entryOf('npm', 'md5', (e) => { e.classified = 'yes'; }), /classified is "yes", not true or false/);
plant('an evidence basis that is not one', entryOf('npm', 'md5', (e) => { e.classEvidence.basis = 'other'; }), /classEvidence\.basis is "other", not entryAlgorithms or endOfLifeSignal/);
plant('a limb that is not one', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.limb = 'D5'; }), /classEvidence\.limb is "D5", not D1 to D4 or null/);
plant('evidence over http', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.url = 'http://evidence.example/x'; }), /classEvidence\.url is "http:\/\/evidence\.example\/x", not an https URL or null/);
plant('an evidence time that is not one', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.checkedAt = '2026-02-31'; }), /classEvidence\.checkedAt is "2026-02-31", not a time or null/);
plant('further evidence that is not a list of URLs', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.additionalUrls = ['see above']; }), /classEvidence\.additionalUrls is \["see above"\], not a list of https URLs/);
plant('a page cited for a class read from the entry\'s own algorithms', entryOf('npm', 'md5', (e) => { e.classEvidence.url = evidence('npm/md5'); }), /classEvidence cites a limb, a page or a check time with basis entryAlgorithms/);
plant('an end-of-life signal with no limb', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.limb = null; }), /classEvidence has basis endOfLifeSignal without a limb, a page and a check time/);
plant('a reason code that is not one', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.code = 'notCrypto'; }), /unclassifiedReason\.code is "notCrypto"/);
plant('a reason with no page', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.url = null; }), /unclassifiedReason\.url is null, not an https URL/);
plant('a reason with no time', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.checkedAt = null; }), /unclassifiedReason\.checkedAt is null, not a time/);
plant('a review status that is not one', entryOf('npm', 'node-forge', (e) => { e.endOfLifeReview.status = 'maintained'; }), /endOfLifeReview\.status is "maintained"/);
plant('a review page that is not a URL', entryOf('npm', 'crypto-js', (e) => { e.endOfLifeReview.url = 'registry'; }), /endOfLifeReview\.url is "registry", not an https URL or null/);
plant('a review time that is not one', entryOf('npm', 'crypto-js', (e) => { e.endOfLifeReview.checkedAt = 'today'; }), /endOfLifeReview\.checkedAt is "today", not a time or null/);
plant('an end-of-life review left out', entryOf('npm', 'md5', (e) => { e.endOfLifeReview = null; }), /endOfLifeReview is null, not an object/);
plant('a multi-purpose record with no version', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.version = ''; }), /multiPurpose\.version is "", not the version inspected/);
plant('a multi-purpose record with no page', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.url = null; }), /multiPurpose\.url is null, not an https URL/);
plant('a multi-purpose record with no time', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.checkedAt = null; }), /multiPurpose\.checkedAt is null, not a time/);
plant('an unmatchable reason that is not one', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.reason = 'vendored'; }), /unmatchable\.reason is "vendored"/);
plant('an unmatchable record with no page', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.url = null; }), /unmatchable\.url is null, not an https URL/);
plant('an unmatchable record with no time', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.checkedAt = null; }), /unmatchable\.checkedAt is null, not a time/);
plant('an absence with no time', entryOf('npm', 'tripledes', (e) => { e.registryAbsent.checkedAt = null; }), /registryAbsent\.checkedAt is null, not a time/);
plant('an absence note that is not text', entryOf('npm', 'tripledes', (e) => { e.registryAbsent.note = 404; }), /registryAbsent\.note is 404, not text or null/);
plant('aliases that are not a list', entryOf('npm', 'md5', (e) => { e.aliases = null; }), /aliases is null, not a list/);
plant('an alias with no name', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].name = ''; }), /aliases\[0\]\.name is ""/);
plant('an alias with no page', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].url = null; }), /aliases\[0\]\.url is null, not an https URL/);
plant('an alias with no time', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].checkedAt = null; }), /aliases\[0\]\.checkedAt is null, not a time/);
plant('a last release with no version', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.version = null; }), /lastRelease\.version is null, not a version/);
plant('a last release on a date that is not one', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.date = '2020-13-01'; }), /lastRelease\.date is "2020-13-01", not a YYYY-MM-DD date/);
plant('a last release with no time checked', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.checkedAt = null; }), /lastRelease\.checkedAt is null, not a time/);
plant('algorithms left unstated', entryOf('go', 'golang.org/x/crypto', (e) => { e.algorithms = null; }), /algorithms is null, not a list of names/);
plant('a category left unstated', entryOf('go', 'golang.org/x/crypto', (e) => { e.category = null; }), /category is null, not a category/);
plant('an entry with no name', entryOf('hex', 'enacl', (e) => { e.name = ''; }), /name is ""/);
plant('a classified entry with no tier', entryOf('npm', 'node-forge', (e) => { e.tier = null; }), /tier is null, classified true and unclassifiedReason null\. An entry has no tier exactly when it is unclassified/);
plant('an unclassified entry with a tier', entryOf('npm', '@types/bcryptjs', (e) => { e.tier = 'other'; }), /tier is "other", classified false and unclassifiedReason set/);
plant('a weak class on a tier other than weak', entryOf('npm', 'md5', (e) => { e.tier = 'other'; }), /weakClass is "brokenAlgorithm" on tier "other"\. A weak entry is in exactly one weak class/);
plant('class evidence with no weak class', entryOf('npm', 'node-forge', (e) => { e.classEvidence = { basis: 'entryAlgorithms', limb: null, url: null, checkedAt: null, additionalUrls: [] }; }),
  /classEvidence is set with weakClass null\. The evidence for a weak class is given exactly when there is one/);
plant('a deprecated library classed from its algorithms', entryOf('npm', 'crypto-js', (e) => { e.classEvidence = { basis: 'entryAlgorithms', limb: null, url: null, checkedAt: null, additionalUrls: [] }; }),
  /is a deprecatedLibrary with classEvidence\.basis entryAlgorithms/);
plant('a broken algorithm off the closed list', entryOf('npm', 'md5', (e) => { e.algorithms = ['MD5', 'GOST']; }), /is a brokenAlgorithm entry whose algorithms include GOST, which is not on the closed list/);
plant('a multi-purpose library counted as post-quantum', entryOf('pypi', 'cryptography', (e) => { e.tier = 'pqc'; }), /multiPurpose is set on tier "pqc"/);
plant('a signal found on a library that is not deprecated', entryOf('npm', 'node-forge', (e) => { e.endOfLifeReview = { status: 'signalFound', url: evidence('x'), checkedAt: CHECKED }; }),
  /endOfLifeReview\.status is signalFound with weakClass null/);
plant('a deprecated library with no signal found', entryOf('npm', 'crypto-js', (e) => { e.endOfLifeReview.status = 'noSignalFound'; }), /endOfLifeReview\.status is noSignalFound with weakClass "deprecatedLibrary"/);
plant('an alias that is also an entry\'s name', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases.push(alias('github.com/cloudflare/circl')); }),
  /has the alias github\.com\/cloudflare\/circl, which is also the name of an entry/);
plant('an alias given to two entries', entryOf('go', 'github.com/cloudflare/circl', (e) => { e.aliases.push(alias('github.com/golang/crypto')); }),
  /the alias github\.com\/golang\/crypto belongs to both/);

// The raw scan file's header.
plant('a scan of another kind', scanOf('hex', (s) => { s.kind = 'scan'; }), /scan-results-hex\.json: kind is "scan", not "censusScan"/);
plant('a scan of another registry', scanOf('hex', (s) => { s.ecosystem = 'pub'; }), /ecosystem is "pub", and the file is the scan of hex/);
plant('a scan with no start', scanOf('hex', (s) => { s.startedAt = null; }), /startedAt is null, not an ISO 8601 UTC time/);
plant('a scan with no instrument commit', scanOf('hex', (s) => { s.scanner.commit = null; }), /scanner\.commit is null\. A published scan names the instrument commit/);
plant('a scan with no script', scanOf('hex', (s) => { s.scanner.script = ''; }), /scanner\.script is ""/);
plant('a source outside the allowlist', scanOf('go', (s) => { s.sources.manifests = 'http://127.0.0.1:8080'; }), /sources\.manifests is http:\/\/127\.0\.0\.1:8080, which is off the allowlist for go \(https:\/\/proxy\.golang\.org\/cached-only\)/);
plant('a source role the allowlist does not have', scanOf('go', (s) => { s.sources.mirror = 'https://goproxy.example'; }), /sources\.mirror is https:\/\/goproxy\.example, which is off the allowlist for go\. A source off the list/);
plant('a scan that does not say where it enumerated', scanOf('hex', (s) => { delete s.sources.enumeration; }), /sources has no enumeration/);
plant('a source that is not a URL', scanOf('hex', (s) => { s.sources.manifests = 'the registry'; }), /sources\.manifests is "the registry", not a URL/);
plant('a source role that is not a name', scanOf('hex', (s) => { s.sources['base-url'] = 'https://hex.registry.example/'; }), /sources has the role "base-url", not a camelCase name/);
plant('sources that are not an object', scanOf('hex', (s) => { s.sources = 'https://hex.registry.example/'; }), /sources is "https:\/\/hex\.registry\.example\/", not an object of base URLs/);
plant('a scan matched against another number of entries', scanOf('hex', (s) => { s.catalog.entries = 2; }), /catalog\.entries is 2, and the catalogue snapshot has 1 hex entries/);
plant('a scan matched against another set of names', scanOf('hex', (s) => { s.catalog.matchSetSha256 = sha256('other'); }), /catalog\.matchSetSha256 differs from the catalogue snapshot's/);
plant('a scan with another match rule', scanOf('hex', (s) => { s.catalog.matchRule = 'hexName/2'; }), /catalog\.matchRule is "hexName\/2", and the catalogue snapshot's rule for hex is "hexName\/1"/);
plant('a version selection that is not a code', scanOf('hex', (s) => { s.method.versionSelection = 'latest stable'; }), /method\.versionSelection is "latest stable", not a camelCase code/);
plant('a scan that reads from nowhere', scanOf('hex', (s) => { s.method.readFrom = []; }), /method\.readFrom is \[\], not a list of distinct camelCase codes with at least one/);
plant('a condition that is not a code', scanOf('go', (s) => { s.method.notObservableWhen = ['only a module line']; }), /method\.notObservableWhen is \["only a module line"\]/);
plant('limits listed twice', scanOf('maven', (s) => { s.method.limits = ['parentPomNotFollowed', 'parentPomNotFollowed']; }), /method\.limits is .*not a list of distinct camelCase codes/);
plant('a scan that does not record every kind', scanOf('npm', (s) => { s.method.declarationKinds = ['dependencies']; }), /method\.declarationKinds is \["dependencies"\]\. A scan of npm records every kind of the closed list/);
plant('a requested count that is not one', scanOf('hex', (s) => { s.enumeration.requested = null; }), /enumeration\.requested is null, not a whole count/);
plant('truncation that is not a yes or no', scanOf('hex', (s) => { s.enumeration.truncated = 'no'; }), /enumeration\.truncated is "no", not true or false/);
plant('a reason for a run that was not truncated', scanOf('hex', (s) => { s.enumeration.reason = 'budget'; }), /enumeration\.reason is "budget" for a run that was not truncated/);
plant('a truncated run that does not say why', scanOf('hex', (s) => { s.enumeration.truncated = true; }), /enumeration\.reason is null; a truncated run says why it stopped/);
plant('an enumeration with no unit', scanOf('hex', (s) => { s.enumeration.unit = ''; }), /enumeration\.unit is "", not the unit enumerated/);
plant('a budget that is not a number of minutes', scanOf('hex', (s) => { s.enumeration.budgetMinutes = -5; }), /enumeration\.budgetMinutes is -5, not a number of minutes or null/);
plant('an elapsed time left out', scanOf('hex', (s) => { s.enumeration.elapsedMinutes = null; }), /enumeration\.elapsedMinutes is null, not a number of minutes/);
plant('a frame size that is not a count', scanOf('hex', (s) => { s.enumeration.frameSize = 2.5; }), /enumeration\.frameSize is 2\.5, not a whole count or null/);
plant('a sampling method that is not one', scanOf('hex', (s) => { s.enumeration.sampling.method = 'random'; }), /enumeration\.sampling\.method is "random"/);
plant('a shuffled sample with no seed', scanOf('npm', (s) => { s.enumeration.sampling.seed = null; }), /enumeration\.sampling\.seed is null\. A shuffled sample names its seed/);
plant('a seed for a sample that shuffles nothing', scanOf('hex', (s) => { s.enumeration.sampling.seed = 'abc'; }), /enumeration\.sampling\.seed is "abc" for registryOrder, which shuffles nothing/);
plant('a Go index window that is not times', scanOf('go', (s) => { s.enumeration.indexWindow.until = 'later'; }), /enumeration\.indexWindow\.until is "later", not a time/);
plant('a Go scan with no index window', scanOf('go', (s) => { s.enumeration.indexWindow = null; }), /enumeration\.indexWindow is null, not an object/);
plant('an index window outside Go', scanOf('hex', (s) => { s.enumeration.indexWindow = { since: '2026-09-01', until: '2026-09-30' }; }), /enumeration\.indexWindow is .*; it is kept for Go's index alone and is null for hex/);
plant('version years that are not years', scanOf('go', (s) => { s.versionYears = { recent: 5 }; }), /versionYears is \{"recent":5\}, not an object of counts by year/);
plant('version years outside Go', scanOf('hex', (s) => { s.versionYears = { 2025: 1 }; }), /versionYears is \{"2025":1\}; it is kept for Go alone and is null for hex/);
plant('a count that is null', scanOf('hex', (s) => { s.coverage.unresolved = null; }), /coverage\.unresolved is null, not a whole count\. null has no meaning in a version 2 count/);
plant('counts by source that are not counts', scanOf('hex', (s) => { s.coverage.scannedByReadFrom = { release: '1' }; }), /coverage\.scannedByReadFrom is \{"release":"1"\}, not an object of counts by read source/);
plant('coverage whose parts do not add up', scanOf('npm', (s) => { s.coverage.listed = 9; s.enumeration.listed = 9; s.listing.rows = 9; }),
  /coverage\.listed is 9, and scanned \+ absent \+ unresolved \+ unversioned is 8\. Every listed package has one disposition/);
plant('more unobservable manifests than manifests read', scanOf('go', (s) => { s.coverage.dependenciesNotObservable = 9; }), /coverage\.dependenciesNotObservable is 9, more than the 5 manifests read/);
plant('unobservable manifests where the registry always shows them', scanOf('npm', (s) => { s.coverage.dependenciesNotObservable = 1; }),
  /coverage\.dependenciesNotObservable is 1 while method\.notObservableWhen is empty/);
plant('counts by source that are not the method\'s sources', scanOf('packagist', (s) => { s.coverage.scannedByReadFrom = { taggedRelease: 3 }; }),
  /coverage\.scannedByReadFrom has \["taggedRelease"\]; it has one count for each of method\.readFrom/);
plant('counts by source that do not sum to the manifests read', scanOf('hex', (s) => { s.coverage.scannedByReadFrom.release = 2; }), /coverage\.scannedByReadFrom sums to 2, and scanned is 1/);
plant('an enumeration that listed another number', scanOf('hex', (s) => { s.enumeration.listed = 5; }), /enumeration\.listed is 5 and coverage\.listed is 1; both count the packages the scan set out to read/);
plant('a scan that names another ledger', scanOf('hex', (s) => { s.listing.file = 'listing-pub.tsv.gz'; }), /listing\.file is "listing-pub\.tsv\.gz"; the ledger of hex is listing-hex\.tsv\.gz/);
plant('a scan bound to other ledger bytes', scanOf('hex', (s) => { s.listing.sha256 = sha256('other'); }), /listing\.sha256 does not match listing-hex\.tsv\.gz\. The scan file is bound to the ledger/);
plant('a ledger row count that is not the listed count', scanOf('hex', (s) => { s.listing.rows = 2; }), /listing\.rows is 2 and coverage\.listed is 1; the ledger has one row per listed package/);
plant('a ledger digest that is not one', scanOf('hex', (s) => { s.listing.sha256 = null; }), /listing\.sha256 is null, not a SHA-256 digest/);

// The scan's own registry check, against the tags.
plant('registry checks that are not a list', scanOf('hex', (s) => { s.catalogCheck = {}; }), /catalogCheck is \{\}, not a list/);
plant('a check status that is not one', scanOf('hex', (s) => { s.catalogCheck[0].status = 'ok'; }), /catalogCheck\[0\]\.status is "ok"/);
plant('an HTTP status that is not one', scanOf('hex', (s) => { s.catalogCheck[0].httpStatus = '200'; }), /catalogCheck\[0\]\.httpStatus is "200", not a status code or null/);
plant('a check URL that is not one', scanOf('hex', (s) => { s.catalogCheck[0].url = 'registry'; }), /catalogCheck\[0\]\.url is "registry", not a URL or null/);
plant('a check with no time', scanOf('hex', (s) => { s.catalogCheck[0].checkedAt = null; }), /catalogCheck\[0\]\.checkedAt is null, not a time/);
plant('a latest version that is not one', scanOf('hex', (s) => { s.catalogCheck[0].latestVersion = 1; }), /catalogCheck\[0\]\.latestVersion is 1, not a version or null/);
plant('a latest release that is not a time', scanOf('hex', (s) => { s.catalogCheck[0].latestReleaseAt = 'recent'; }), /catalogCheck\[0\]\.latestReleaseAt is "recent", not a time or null/);
plant('a check of an alias that is not a name', scanOf('hex', (s) => { s.catalogCheck[0].alias = ''; }), /catalogCheck\[0\]\.alias is "", not a name or null/);
plant('a check of an entry the snapshot does not have', scanOf('hex', (s) => { s.catalogCheck.push({ ...s.catalogCheck[0], entry: 'other' }); }), /checks "other", which is not a hex entry of the catalogue snapshot/);
plant('a check of an alias the entry does not have', scanOf('go', (s) => { s.catalogCheck.push({ ...s.catalogCheck[1], alias: 'example.com/alias' }); }), /checks the alias "example\.com\/alias", which .* does not have/);
plant('an entry checked twice', scanOf('hex', (s) => { s.catalogCheck.push({ ...s.catalogCheck[0] }); }), /catalogCheck\[1\] checks "enacl" a second time/);
plant('an entry left unchecked', scanOf('hex', (s) => { s.catalogCheck = []; }), /catalogCheck has no row for enacl/);
plant('an alias left unchecked', scanOf('go', (s) => { s.catalogCheck = s.catalogCheck.filter((row) => row.alias === null); }), /catalogCheck has no row for github\.com\/square\/go-jose by its alias gopkg\.in\/square\/go-jose\.v2/);
plant('a check that finds absent an entry the tags say is present', scanOf('hex', (s) => { s.catalogCheck[0].status = 'absent'; }),
  /the scan's own registry check finds enacl absent, and the catalogue snapshot does not tag it registryAbsent/);
plant('a check that finds present an entry the tags say is absent', scanOf('npm', (s) => { s.catalogCheck.find((row) => row.entry === 'tripledes').status = 'present'; }),
  /finds tripledes present, and the catalogue snapshot tags it registryAbsent/);
plant('an unmatchable entry found on the registry', scanOf('go', (s) => { s.catalogCheck.find((row) => row.entry === 'crypto/md5').status = 'present'; }),
  /crypto\/md5 is tagged unmatchable, and the registry has a package under that name/);
plant('an unresolved check of a classified entry', scanOf('hex', (s) => { s.catalogCheck[0].status = 'unresolved'; }), /the registry check of "enacl" is unresolved\. For a classified entry that leaves K unestablished/);

// Package records, matches and declarations.
plant('packages that are not a list', scanOf('hex', (s) => { s.packages = {}; }), /scan-results-hex\.json: packages is \{\}, not a list/);
plant('a package listed twice', scanOf('npm', (s) => { s.packages.push(structuredClone(s.packages[0])); s.packagesWithMatch += 1; }), /packages\[6\] \(@acme\/alpha\) is listed a second time/);
plant('a package with no name', scanOf('hex', (s) => { s.packages[0].name = ''; }), /packages\[0\]\.name is ""/);
plant('a package with no version', scanOf('hex', (s) => { s.packages[0].version = ''; }), /packages\[0\] \(acme_hex\)\.version is "", not the version read/);
plant('a package read from a source the method does not name', scanOf('hex', (s) => { s.packages[0].readFrom = 'mirror'; }), /\.readFrom is "mirror", not one of method\.readFrom/);
plant('a NuGet package without its groups', scanOf('nuget', (s) => { s.packages[0].manifest = null; }), /\.manifest is null; for nuget it is \{ dependencyGroups/);
plant('a CocoaPods package without its default subspecs', scanOf('cocoapods', (s) => { delete s.packages[0].manifest.defaultSubspecs; }), /\.manifest is .*; for cocoapods it is \{ subspecs/);
plant('a Maven package whose coordinates are not a count', scanOf('maven', (s) => { s.packages[0].manifest.propertyCoordinates = -1; }), /\.manifest is .*; for maven it is \{ hasParent/);
plant('package-level facts where the registry has none', scanOf('hex', (s) => { s.packages[0].manifest = {}; }), /\.manifest is \{\}; hex has no package-level facts, so it is null/);
plant('a package with no match', scanOf('hex', (s) => { s.packages[0].matches = []; }), /\.matches is \[\]\. Only packages with a match are listed/);
plant('a match with no declared name', scanOf('hex', (s) => { s.packages[0].matches[0].declaredName = null; }), /matches\[0\]\.declaredName is null/);
plant('a match by a way that is not one', scanOf('hex', (s) => { s.packages[0].matches[0].matchedBy = 'fuzzy'; }), /matches\[0\]\.matchedBy is "fuzzy"/);
plant('a match with no entry', scanOf('hex', (s) => { s.packages[0].matches[0].entry = null; }), /matches\[0\]\.entry is null\. It is always written/);
plant('a match to an entry the snapshot does not have', scanOf('hex', (s) => { s.packages[0].matches[0].entry = 'other'; }), /matches\[0\]\.entry is "other", which is not a hex entry of the catalogue snapshot/);
plant('an exact match under another name', scanOf('hex', (s) => { s.packages[0].matches[0].declaredName = 'enacl_compat'; }), /is matched exactly, but the declared name "enacl_compat" is not the entry's name/);
plant('an alias match by a name that is not an alias', scanOf('go', (s) => { s.packages[0].matches[0].declaredName = 'example.com/jose'; }), /is matched by alias, but "example\.com\/jose" is not an alias of github\.com\/square\/go-jose/);
plant('a match with no declaration', scanOf('hex', (s) => { s.packages[0].matches[0].declarations = []; }), /declarations is \[\]\. A match has at least one declaration/);
plant('a declaration of a kind the registry does not have', scanOf('npm', (s) => { s.packages[0].matches[0].declarations[0].kind = 'bundledDependencies'; }), /declarations\[0\]\.kind is "bundledDependencies", not one of the npm kinds/);
plant('a declaration member of the wrong type', scanOf('go', (s) => { s.packages[0].matches[0].declarations[0].indirect = 'no'; }), /declarations\[0\]\.indirect is "no", not true or false/);
plant('a replacement that is not one', scanOf('go', (s) => { s.packages.find((p) => p.name === 'example.com/lib').matches[0].declarations[0].replace = { path: 'x' }; }), /declarations\[0\]\.replace is .*, not null or \{ path, version \}/);
plant('a marker that is not one', scanOf('pypi', (s) => { s.packages[0].matches[0].declarations[0].marker = 'platform'; }), /declarations\[0\]\.marker is "platform", not none, extra or environmentOnly/);
plant('a package count that is not the packages listed', scanOf('hex', (s) => { s.packagesWithMatch = 2; }), /packagesWithMatch is 2, and packages lists 1/);
plant('a package count that is not a count', scanOf('hex', (s) => { s.packagesWithMatch = null; }), /packagesWithMatch is null, not a count/);
plant('a registry that matched nothing', {
  fixture: (f) => { f.hex.rows[0].matches = []; },
  consolidation: () => {},
}, /scan-results-hex\.json: matched no package\. A registry that matched nothing fails checks\.noMatches/);

// Fields left out of nested objects, and the remaining types.
plant('class evidence missing a field', entryOf('npm', 'md5', (e) => { delete e.classEvidence.additionalUrls; }), /\(npm:md5\): classEvidence is missing additionalUrls/);
plant('an alias missing a field', entryOf('go', 'golang.org/x/crypto', (e) => { delete e.aliases[0].url; }), /aliases\[0\] is missing url/);
plant('a declaration missing a member', scanOf('go', (s) => { delete s.packages[0].matches[0].declarations[0].replace; }), /declarations\[0\] is missing replace/);
plant('a package record missing a field', scanOf('hex', (s) => { delete s.packages[0].manifest; }), /packages\[0\] \(acme_hex\) is missing manifest/);
plant('a match record missing a field', scanOf('hex', (s) => { delete s.packages[0].matches[0].matchedBy; }), /matches\[0\] is missing matchedBy/);
plant('a catalogue size that is not a count', scanOf('hex', (s) => { s.catalog.entries = '1'; }), /catalog\.entries is "1", not a count/);
plant('a match set that is not a digest', scanOf('hex', (s) => { s.catalog.matchSetSha256 = 'PLACEHOLDER'; }), /catalog\.matchSetSha256 is "PLACEHOLDER", not a SHA-256 digest/);
plant('a match rule that is not an id', scanOf('hex', (s) => { s.catalog.matchRule = null; }), /catalog\.matchRule is null, not a rule id/);
plant('a ledger row count that is not a count', scanOf('hex', (s) => { s.listing.rows = null; }), /listing\.rows is null, not a count/);

// --- Listing ledgers -----------------------------------------------------------

const ledgerOf = (eco, fn) => ({ ledgers: (ledgers) => { ledgers[eco] = fn(ledgers[eco]); } });

plant('an unread row that leaves out its empty columns', ledgerOf('npm', (lines) => lines.map((line) => line.replace(/^(eta\tabsent\thttp404)\t\t\t\t$/, '$1'))),
  /listing-npm\.tsv\.gz: row \d+ has 3 columns\. Every row of the npm ledger has all 7 of its header's columns/);

// Every field of every row is free of control and direction characters.
const inRow = (eco, name, from, to) => ledgerOf(eco, (lines) => lines.map((line) => (line.startsWith(`${name}\t`) ? line.replace(from, to) : line)));
plant('a name with a direction override in it', inRow('npm', 'eta', /^eta\t/, 'eta\u202e\t'), /listing-npm\.tsv\.gz: row \d+ has a control or direction character in its name column/);
plant('a name with an isolate in it', inRow('npm', 'eta', /^eta\t/, 'eta\u2066\t'), /listing-npm\.tsv\.gz: row \d+ has a control or direction character in its name column/);
plant('a version with a control character in it', inRow('hex', 'acme_hex', '\t1.0.0\t', '\t1.0\u0007\t'), /listing-hex\.tsv\.gz: row 2 has a control or direction character in its version column/);
plant('a reason with a C1 control in it', inRow('npm', 'eta', '\thttp404\t', '\thttp404\u0085\t'), /listing-npm\.tsv\.gz: row \d+ has a control or direction character in its reason column/);
plant('a source with DEL in it', inRow('hex', 'acme_hex', '\trelease\t', '\trelease\u007f\t'), /listing-hex\.tsv\.gz: row 2 has a control or direction character in its readFrom column/);
plant('a row that ends in a carriage return', inRow('hex', 'acme_hex', /$/, '\r'), /listing-hex\.tsv\.gz: row 2 has a control or direction character in its matches column/);

// The columns two registries add.
plant('a Maven ledger without its page column', ledgerOf('maven', (lines) => lines.map((line) => line.replace(/\t[^\t]*$/, ''))),
  /listing-maven\.tsv\.gz does not begin with the header row \(name, disposition, reason, version, readFrom, observable, matches, page,/);
plant('a Packagist ledger without its type column', ledgerOf('packagist', (lines) => lines.map((line) => line.replace(/\t[^\t]*$/, ''))),
  /listing-packagist\.tsv\.gz does not begin with the header row \(name, disposition, reason, version, readFrom, observable, matches, type,/);
plant('a Maven row whose page is not a count', inRow('maven', 'com.example:app', /\t0$/, '\tfirst'), /\(com\.example:app\) has page "first", not the search page it was drawn from/);
plant('a scanned Packagist row with no type', inRow('packagist', 'acme/api', /\tlibrary$/, '\t'), /\(acme\/api\) is scanned with no type of the version read/);
plant('an unread Packagist row with a type', inRow('packagist', 'zeta/none', /\t$/, '\tlibrary'),
  /\(zeta\/none\) records a version, a source, an observation, matches or a type for a package that was not read/);

// The size of the ledgers on disk: one at most 45,000,000 bytes, the eleven at most 100,000,000.
/** Make listed files the given sizes, as sparse files, and record their hashes and sizes in the manifest. */
const resized = (sizes) => (dir) => {
  const manifestPath = join(datasetDir(dir), 'MANIFEST.json');
  const m = JSON.parse(readText(manifestPath));
  for (const [file, size] of Object.entries(typeof sizes === 'function' ? sizes(m) : sizes)) {
    const path = join(datasetDir(dir), file);
    truncateSync(path, size);
    Object.assign(m.files.find((f) => f.file === file), { bytes: size, sha256: sha256(readFileSync(path)) });
  }
  writeFileSync(manifestPath, json(m));
};
/** Sizes for three ledgers that bring the eleven to the total given. */
const toTotal = (total) => (m) => {
  const others = sum(m.files.filter((f) => f.role === 'listing' && !['listing-npm.tsv.gz', 'listing-pypi.tsv.gz', 'listing-go.tsv.gz'].includes(f.file)).map((f) => f.bytes));
  return { 'listing-npm.tsv.gz': 45_000_000, 'listing-pypi.tsv.gz': 45_000_000, 'listing-go.tsv.gz': total - 90_000_000 - others };
};
plant('a listing ledger over 45,000,000 bytes', {}, /listing-crates\.tsv\.gz is 45,000,001 bytes, over the 45,000,000 a listing ledger may hold/,
  resized({ 'listing-crates.tsv.gz': 45_000_001 }));
plant('listing ledgers over 100,000,000 bytes together', {}, /listing ledgers: together they are 100,000,001 bytes, over the 100,000,000 the eleven may hold/,
  resized(toTotal(100_000_001)));

test('a listing ledger of exactly 45,000,000 bytes is not refused for its size', async () => {
  const result = await validateOne({}, resized({ 'listing-crates.tsv.gz': 45_000_000 }));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /scan-results-crates\.json: listing\.sha256 does not match listing-crates\.tsv\.gz/, result.stderr);
  assert.doesNotMatch(result.stderr, /over the 45,000,000/);
});

test('listing ledgers of exactly 100,000,000 bytes together are not refused for their size', async () => {
  const result = await validateOne({}, resized(toTotal(100_000_000)));
  assert.equal(result.code, 1, result.stdout);
  assert.doesNotMatch(result.stderr, /together they are/);
});

const fillers = (count, extra) => (f) => {
  for (let i = 0; i < count; i += 1) f.npm.rows.push(scanned(`filler-${String(i).padStart(3, '0')}`, []));
  f.npm.rows.push(extra);
};

test('one unresolved package in 100 listed is at the ceiling, and passes', async () => {
  const result = await validateOne({ fixture: fillers(91, unread('kappa', 'unresolved', 'parseError')) });
  assert.equal(result.code, 0, result.stderr);
});

// The listing ledger.
const swap = (lines, a, b) => { [lines[a], lines[b]] = [lines[b], lines[a]]; return lines; };
plant('a ledger that is not gzip', { ledgers: (l) => { l.hex = Buffer.from('name\tdisposition\n'); } }, /listing-hex\.tsv\.gz is not a gzip file/);
plant('a ledger without its header', ledgerOf('hex', (lines) => lines.slice(1)), /listing-hex\.tsv\.gz does not begin with the header row/);
plant('an empty ledger', { ledgers: (l) => { l.hex = gzipSync(''); } }, /listing-hex\.tsv\.gz is empty/);
plant('a ledger row that is not UTF-8', { ledgers: (l) => { l.hex = gzipSync(Buffer.concat([Buffer.from(`${l.hex[0]}\n`), Buffer.from([0x61, 0xff, 0x0a])])); } }, /listing-hex\.tsv\.gz: row 2 is not UTF-8/);
plant('rows out of order', ledgerOf('npm', (lines) => swap(lines, 1, 2)), /listing-npm\.tsv\.gz: row 3 \(@acme\/alpha\) does not follow the row above it/);
plant('a package listed twice in the ledger', ledgerOf('hex', (lines) => [...lines, lines[1]]), /listing-hex\.tsv\.gz: row 3 \(acme_hex\) does not follow the row above it/);
plant('a disposition that is not one', ledgerOf('npm', (lines) => lines.map((line) => line.replace('\tabsent\t', '\tgone\t'))), /has the disposition "gone", not scanned, absent, unresolved or unversioned/);
plant('a row with five columns', ledgerOf('hex', (lines) => [lines[0], lines[1].split('\t').slice(0, 5).join('\t')]), /listing-hex\.tsv\.gz: row 2 has 5 columns\. Every row of the hex ledger has all 7 of its header's columns/);
plant('a scanned row with three columns', ledgerOf('hex', (lines) => [lines[0], lines[1].split('\t').slice(0, 3).join('\t')]), /row 2 has 3 columns/);
plant('a row with no name', ledgerOf('hex', (lines) => [lines[0], lines[1].replace(/^[^\t]+/, '')]), /listing-hex\.tsv\.gz: row 2 has no name/);
plant('a scanned row that gives a reason', ledgerOf('hex', (lines) => [lines[0], lines[1].replace('\tscanned\t\t', '\tscanned\ttimeout\t')]), /gives the reason "timeout" for scanned/);
plant('an absent row with a reason for an unresolved one', ledgerOf('npm', (lines) => lines.map((line) => line.replace('\tabsent\thttp404', '\tabsent\ttimeout'))), /gives the reason "timeout" for absent; it is one of: http404, http410/);
plant('an unread row that records a version', ledgerOf('npm', (lines) => lines.map((line) => line.replace('\tabsent\thttp404\t', '\tabsent\thttp404\t1.0.0'))), /records a version, a source, an observation, matches or a type for a package that was not read/);
plant('a scanned row with no version', ledgerOf('hex', (lines) => [lines[0], lines[1].replace('\t1.0.0\t', '\t\t')]), /\(acme_hex\) is scanned with no version read/);
plant('a row read from a source the method does not name', ledgerOf('hex', (lines) => [lines[0], lines[1].replace('\trelease\t', '\tmirror\t')]), /\(acme_hex\) is read from "mirror", not one of method\.readFrom/);
plant('an observation that is not 1 or 0', ledgerOf('hex', (lines) => [lines[0], lines[1].replace('\trelease\t1\t', '\trelease\tyes\t')]), /\(acme_hex\) has observable "yes", not 1 or 0/);
plant('a match count that is not a count', ledgerOf('hex', (lines) => [lines[0], lines[1].replace(/\t1$/, '\tone')]), /\(acme_hex\) has matches "one", not a whole count/);
plant('a count that is not what the ledger gives', scanOf('npm', (s) => { s.coverage.scanned = 6; s.coverage.absent = 2; s.coverage.scannedByReadFrom.release = 6; }), /scan-results-npm\.json: coverage\.scanned is 6, and listing-npm\.tsv\.gz gives 7\. Coverage is recomputed from the ledger/);
plant('a ledger that reads an unread package as read', ledgerOf('npm', (lines) => lines.map((line) => line.replace(/^eta\tabsent\thttp404\t\t\t\t$/, 'eta\tscanned\t\t1.0.0\trelease\t1\t0'))),
  /scan-results-npm\.json: coverage\.scanned is 7, and listing-npm\.tsv\.gz gives 8/);
plant('counts by source that the ledger does not give', { fixture: (f) => { f.packagist.rows.find((r) => r.name === 'acme/cli').readFrom = 'taggedRelease'; }, scans: (s) => { s.packagist.coverage.scannedByReadFrom = { taggedRelease: 2, devDefaultBranch: 1 }; } },
  /coverage\.scannedByReadFrom\.taggedRelease is 2, and listing-packagist\.tsv\.gz gives 3/);
plant('a package whose ledger row records no match', ledgerOf('hex', (lines) => [lines[0], lines[1].replace(/\t1$/, '\t0')]), /acme_hex is in packages, and listing-hex\.tsv\.gz records no match for it/);
plant('a scan file with one match deleted', scanOf('npm', (s) => { s.packages[0].matches.pop(); }), /@acme\/alpha has 1 match record\(s\), and listing-npm\.tsv\.gz records 2/);
plant('a scan file with one matched package deleted', scanOf('npm', (s) => { s.packages.shift(); s.packagesWithMatch -= 1; }), /listing-npm\.tsv\.gz records 2 match\(es\) for @acme\/alpha, which scan-results-npm\.json does not list/);
plant('a package read at another version than the ledger says', scanOf('hex', (s) => { s.packages[0].version = '2.0.0'; }), /acme_hex was read at "2\.0\.0", and listing-hex\.tsv\.gz says 1\.0\.0/);
plant('a package read from another source than the ledger says', scanOf('packagist', (s) => { s.packages[0].readFrom = 'devDefaultBranch'; }), /acme\/api was read from "devDefaultBranch", and listing-packagist\.tsv\.gz says taggedRelease/);
plant('a row over the ceiling', { fixture: fillers(90, unread('kappa', 'unresolved', 'timeout')) }, /npm: 1 of the 99 packages listed are unresolved, above the ceiling of 1 in 100\. The row is blocked/);
plant('a deterministic non-read over the ceiling', { fixture: (f) => { f.hex.rows.push(unread('broken_pkg', 'unresolved', 'parseError')); } }, /hex: 1 of the 2 packages listed are unresolved, above the ceiling/);

// Where a dataset sits.
test('a ledger that decompresses past the bound is refused, and the run ends', async () => {
  // About a megabyte of gzip that would grow past a gigabyte read whole.
  const gzip = createGzip({ level: 9 });
  const chunks = [];
  gzip.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((done) => gzip.on('end', done));
  gzip.write('name\tdisposition\treason\tversion\treadFrom\tobservable\tmatches\n');
  const zeros = Buffer.alloc(16 * 1024 * 1024);
  for (let i = 0; i < 65; i += 1) {
    if (!gzip.write(zeros)) await new Promise((done) => gzip.once('drain', done));
  }
  gzip.end();
  await ended;
  const result = await validateOne({ ledgers: (l) => { l.hex = Buffer.concat(chunks); } });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /listing-hex\.tsv\.gz decompresses to more than 1,073,741,824 bytes, the most a ledger may hold/, result.stderr);
});

// --- Consolidation map ---------------------------------------------------------

const mapOf = (fn) => ({ consolidation: fn });

// Each object is closed: a field the contract does not define fails, at every level.
const closedInTheMap = [
  ['the consolidation map', mapOf((m) => { m.note = 'x'; }), /consolidation-2026-09-30\.json carries note/],
  ['a consolidation rule', mapOf((m) => { m.rules[0].note = 'x'; }), /rules\[0\] carries note/],
  ['a registry of the map', mapOf((m) => { m.byEcosystem.npm.note = 'x'; }), /byEcosystem\.npm carries note/],
  ['a merged unit', mapOf((m) => { m.byEcosystem.npm.units[0].note = 'x'; }), /byEcosystem\.npm\.units\[0\] carries note/],
  ['a removal', mapOf((m) => { m.byEcosystem.pub.removed = [{ name: 'acme_dart', rule: 'sharedNamespace', note: 'x' }]; }), /byEcosystem\.pub\.removed\[0\] carries note/],
];
for (const [level, change, problem] of closedInTheMap) plant(`a field the contract does not define, in ${level}`, change, problem);

// The consolidation map, and the rule it is held to.
plant('a map of another kind', mapOf((m) => { m.kind = 'censusMap'; }), /consolidation-2026-09-30\.json: kind is "censusMap", not "censusConsolidation"/);
plant('a map of another date', mapOf((m) => { m.collectedAt = '2026-09-01'; }), /consolidation-2026-09-30\.json: collectedAt is "2026-09-01", not the dataset's date/);
plant('a map under a definition these rules do not know', mapOf((m) => { m.definitionId = 'census.unit.consolidated/2'; }), /definitionId is "census\.unit\.consolidated\/2", not census\.unit\.consolidated\/1/);
plant('rules that are not a list', mapOf((m) => { m.rules = {}; }), /consolidation-2026-09-30\.json: rules is \{\}, not a list/);
plant('a rule with no id of its own', mapOf((m) => { m.rules.push({ ...m.rules[0] }); }), /rules\[1\]\.id is "sharedNamespace", not a rule id of its own/);
plant('a rule with no statement', mapOf((m) => { m.rules[0].statement = ''; }), /rules\[0\]\.statement is "", not a statement of the rule/);
plant('a map that is not by registry', mapOf((m) => { m.byEcosystem = []; }), /consolidation-2026-09-30\.json: byEcosystem is \[\], not an object by registry/);
plant('a map naming a registry that is not one', mapOf((m) => { m.byEcosystem.conda = { units: [], removed: [] }; }), /byEcosystem carries conda, which is not one of the eleven registries/);
plant('units that are not a list', mapOf((m) => { m.byEcosystem.npm.units = {}; }), /byEcosystem\.npm\.units is \{\}, not a list/);
plant('two units of one name', mapOf((m) => { m.byEcosystem.go.units.push({ unit: 'example.com/app/one', members: ['example.com/lib', 'example.com/app/one/v2'] }); }), /byEcosystem\.go\.units\[1\]\.unit is "example\.com\/app\/one", not a name of its own/);
plant('a unit of one member', mapOf((m) => { m.byEcosystem.npm.units.push({ unit: '@other', members: ['@other/delta'] }); }), /units\[1\]\.members is \["@other\/delta"\]\. The map lists merged units only/);
plant('a unit with a member that is not a package with a match', mapOf((m) => { m.byEcosystem.npm.units[0].members.push('@acme/zeta'); }), /names @acme\/zeta, which is not a package with a match in the scan file of npm/);
plant('a package placed twice', mapOf((m) => { m.byEcosystem.npm.removed = [{ name: '@acme/alpha', rule: 'sharedNamespace' }]; }), /places @acme\/alpha a second time/);
plant('removals that are not a list', mapOf((m) => { m.byEcosystem.npm.removed = {}; }), /byEcosystem\.npm\.removed is \{\}, not a list/);
plant('a removal by a rule the map does not have', mapOf((m) => { m.byEcosystem.pub.removed = [{ name: 'acme_dart', rule: 'nameTooShort' }]; }), /removed\[0\]\.rule is "nameTooShort", which is not a rule of this map/);
plant('a map that removes a package', mapOf((m) => { m.byEcosystem.pub.removed = [{ name: 'acme_dart', rule: 'sharedNamespace' }]; }), /byEcosystem\.pub removes acme_dart by sharedNamespace\. Under census\.unit\.consolidated\/1 consolidation only merges/);
plant('a namespace left unmerged', mapOf((m) => { m.byEcosystem.maven.units = []; }), /byEcosystem\.maven does not merge com\.example:app, com\.example:lib, com\.example:tool, which share com\.example/);
plant('a merge across namespaces', mapOf((m) => { m.byEcosystem.pypi.units = [{ unit: 'apps', members: ['alpha-app', 'beta-lib'] }]; }), /byEcosystem\.pypi unit apps merges alpha-app, beta-lib, which are not the packages of one namespace/);

// Fields left out of nested objects, and the remaining types.
plant('a registry of the map missing a field', mapOf((m) => { delete m.byEcosystem.npm.removed; }), /byEcosystem\.npm is missing removed/);
plant('a unit member that is not a name', mapOf((m) => { m.byEcosystem.npm.units[0].members.push(42); }), /byEcosystem\.npm\.units\[0\] names 42, not a package/);
plant('a unit missing its members', mapOf((m) => { delete m.byEcosystem.npm.units[0].members; }), /byEcosystem\.npm\.units\[0\] is missing members/);
plant('a removal missing its rule', mapOf((m) => { m.byEcosystem.pub.removed = [{ name: 'acme_dart' }]; }), /byEcosystem\.pub\.removed\[0\] is missing rule/);

// --- Corpus ------------------------------------------------------------------

const EARLIER_V2 = '2026-09-15';

const corpusOf = (fn) => ({ corpus: fn });

const npmRaw = (c) => c.byEcosystem.npm.anyManifestMatch.raw;

test('a dataset in which no registry can measure post-quantum passes, with its joint totals null', async () => {
  // Both countable post-quantum entries become absent from their registries. K drops, so every post-quantum
  // cell and every joint cell is null; the matches to them still count toward matched, which needs only a
  // classified entry. Written out by hand: npm and crates lose their pqc K, nothing else moves.
  const result = await validateOne({
    fixture: (f) => {
      for (const [eco, name] of [['npm', '@noble/post-quantum'], ['crates', 'pqcrypto']]) {
        f[eco].entries.find((e) => e.name === name).registryAbsent = { ...ABSENT };
        f[eco].measurability.matched.k -= 1;
        f[eco].measurability.matched.excluded.push({ entry: name, why: 'registryAbsent' });
        f[eco].measurability.pqc = measure(0, [], [[name, 'registryAbsent']]);
        for (const definition of DEFINITIONS) {
          for (const unit of UNITS) f[eco].blocks[definition][unit][0].splice(4, 3, null, null, null);
        }
      }
    },
  });
  assert.equal(result.code, 0, result.stderr);
});

test('a known issue in the vocabulary of an errata issue passes', async () => {
  const result = await validateOne({ manifest: (m) => { m.knownIssues = [knownIssue()]; } });
  assert.equal(result.code, 0, result.stderr);
});

function knownIssue() {
  return {
    defect: 'example-issue',
    summary: 'A figure is known to be low.',
    affects: ['byEcosystem.npm.anyManifestMatch.raw.weak'],
    direction: 'understates',
    magnitude: { value: 1, of: 5, unit: 'packages' },
    correctedIn: 'the next dataset',
  };
}

test('a later version 2 dataset that names an earlier one as comparable passes when their instruments are the same', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, {}],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2 }]],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /3 dataset\(s\) validated: 2026-03-18, 2026-09-15, 2026-09-30/);
});

// The manifest's own fields.
plant('a known issue with no direction', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), direction: 'wrong' }]; }), /knownIssues\[0\]\.direction is "wrong", which tells a reader nothing/);
plant('a known issue with a defect id of another form', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), defect: 'Example Issue' }]; }), /knownIssues\[0\]\.defect is "Example Issue", not an id of lower-case words/);
plant('a known issue listed twice', manifestOf((m) => { m.knownIssues = [knownIssue(), knownIssue()]; }), /knownIssues\[1\] repeats the defect example-issue/);
plant('a known issue with no summary', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), summary: '\u200B' }]; }), /knownIssues\[0\]\.summary is .*, not text a reader can see/);
plant('a known issue naming a figure the corpus does not have', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), affects: ['packagesScanned'] }]; }), /knownIssues\[0\] affects packagesScanned, which is not a field of the corpus/);
plant('a known issue naming no figure', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), affects: [] }]; }), /knownIssues\[0\]\.affects is \[\], not a list of the figures/);
plant('a known issue larger than its whole', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), magnitude: { value: 6, of: 5, unit: 'packages' } }]; }), /knownIssues\[0\]\.magnitude is .*, not null or \{ value, of, unit \}/);

// Each object is closed: a field the contract does not define fails, at every level.
plant('a stored share at the top of the corpus', corpusOf((c) => { c.weakShareOfCryptoUsing = 0.42; }), /carries weakShareOfCryptoUsing, a stored share\. No share is stored/);
plant('a stored share in a figure block', corpusOf((c) => { npmRaw(c).pqcRate = 0.4; }), /anyManifestMatch\.raw carries pqcRate, a stored share/);
plant('a share stored where a count goes', corpusOf((c) => { npmRaw(c).weak.count = 0.5; }), /anyManifestMatch\.raw\.weak\.count is 0\.5, not a whole count or null/);

// The consolidation map, and the rule it is held to.
plant('consolidated figures that are not what the consolidation map produces', corpusOf((c) => {
  // The go figures as if nothing were merged: each consistent with the others, none with the map.
  Object.assign(c.byEcosystem.go.anyManifestMatch.consolidated, { matched: { count: 3, k: 3, nullReason: null }, consolidation: { unitsIn: 3, unitsOut: 3, merged: 0, removedByRule: {} } });
}), /byEcosystem\.go\.anyManifestMatch\.consolidated\.matched is \{"count":3,"k":3,"nullReason":null\}; recomputed from the files it is bound to, it is \{"count":2/);

// The corpus: its own fields.
plant('a corpus of another kind', corpusOf((c) => { c.kind = 'corpus'; }), /corpus-2026-09-30\.json: kind is "corpus", not "censusCorpus"/);
plant('a corpus of another date', corpusOf((c) => { c.collectedAt = '2026-09-29'; }), /corpus-2026-09-30\.json: collectedAt is "2026-09-29", and the dataset is 2026-09-30/);
plant('a dataset dated before its last scan finished', scanOf('hex', (s) => { s.finishedAt = '2026-10-01T02:00:00Z'; }), /collectedAt is 2026-09-30, and the last scan finished on 2026-10-01/);
plant('a corpus with no generation time', corpusOf((c) => { c.generatedAt = null; }), /corpus-2026-09-30\.json: generatedAt is null, not an ISO 8601 UTC time/);
plant('input scans that are not a list', corpusOf((c) => { c.inputs.scans = {}; }), /inputs\.scans is \{\}, not a list/);
plant('an input that binds no registry', corpusOf((c) => { c.inputs.scans[0].ecosystem = 'conda'; }), /inputs\.scans\[0\] is .*, not the binding of one registry's scan file/);
plant('a scan bound twice', corpusOf((c) => { c.inputs.scans[1] = { ...c.inputs.scans[0] }; }), /inputs\.scans\[1\] binds npm a second time/);
plant('a scan left unbound', corpusOf((c) => { c.inputs.scans.pop(); }), /inputs\.scans does not bind the scan file of cocoapods/);
plant('a scan bound under another name', corpusOf((c) => { c.inputs.scans[0].file = 'scan-results-npm-clean.json'; }), /inputs\.scans\[0\]\.file is "scan-results-npm-clean\.json", not scan-results-npm\.json/);
plant('a corpus bound to other scan bytes', corpusOf((c) => { c.inputs.scans[2].sha256 = sha256('other'); }), /inputs\.scans\[2\]\.sha256 is not the hash of scan-results-go\.json\. The corpus is bound to the bytes it was computed from/);
plant('a scan binding that is not a digest', corpusOf((c) => { c.inputs.scans[2].sha256 = 'x'; }), /inputs\.scans\[2\]\.sha256 is "x", not a SHA-256 digest/);
plant('a corpus bound to other snapshot bytes', corpusOf((c) => { c.inputs.catalog.sha256 = sha256('other'); }), /inputs\.catalog\.sha256 is not the hash of catalog-2026-09-30\.json/);
plant('a corpus bound to other map bytes', corpusOf((c) => { c.inputs.consolidation.sha256 = sha256('other'); }), /inputs\.consolidation\.sha256 is not the hash of consolidation-2026-09-30\.json/);
plant('a corpus naming another classification', corpusOf((c) => { c.inputs.catalog.classificationSha256 = sha256('other'); }), /inputs\.catalog\.classificationSha256 is not the catalogue snapshot's/);
plant('a corpus naming another match set', corpusOf((c) => { c.inputs.catalog.matchSetSha256 = sha256('other'); }), /inputs\.catalog\.matchSetSha256 is not the catalogue snapshot's/);
plant('a definition under another id', corpusOf((c) => { c.definitions.coverage.id = 'census.coverage/2'; }), /definitions\.coverage\.id is "census\.coverage\/2", not census\.coverage\/1/);
plant('a corpus that sets its own ceiling', corpusOf((c) => { c.definitions.unresolvedCeiling = 0.05; }), /definitions\.unresolvedCeiling is 0\.05\. The ceiling is 0\.01, held here as well/);
plant('a class under another id', corpusOf((c) => { c.definitions.classes.pqc = 'census.class.pqc/1'; }), /definitions\.classes\.pqc is "census\.class\.pqc\/1", not census\.class\.pqcDedicated\/1/);
plant('a direct definition under another id', corpusOf((c) => { c.definitions.directUnconditional.id = 'census.match.direct/1'; }), /definitions\.directUnconditional\.id is "census\.match\.direct\/1"/);
plant('a direct definition without a registry\'s rule', corpusOf((c) => { delete c.definitions.directUnconditional.predicate.hex; }), /directUnconditional\.predicate is missing hex/);
plant('a direct rule that is not words', corpusOf((c) => { c.definitions.directUnconditional.predicate.hex = ''; }), /directUnconditional\.predicate\.hex is "", not the rule in words/);
plant('a manifest-match definition under another id', corpusOf((c) => { c.definitions.anyManifestMatch.id = 'census.match.anyManifest/2'; }), /definitions\.anyManifestMatch\.id is "census\.match\.anyManifest\/2", not census\.match\.anyManifest\/1/);
plant('a manifest-match definition without a registry', corpusOf((c) => { delete c.definitions.anyManifestMatch.includes.pub; }), /anyManifestMatch\.includes is missing pub/);
plant('a kind the registry does not have', corpusOf((c) => { c.definitions.anyManifestMatch.includes.npm = ['dependencies', 'bundled']; }), /anyManifestMatch\.includes\.npm is \["dependencies","bundled"\], not a list of distinct npm declaration kinds/);
plant('a kind the definition leaves out, counted', corpusOf((c) => { c.definitions.anyManifestMatch.includes.packagist = ['require', 'requireDev', 'suggest']; }),
  /anyManifestMatch\.includes\.packagist is \["require","requireDev","suggest"\]; under census\.match\.anyManifest\/1 it is \["require","requireDev"\]/);
plant('a blocked row', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'unresolvedShareAboveCeiling', detail: 'Above the ceiling.' }]; }), /blocked names "hex"\. A corpus that blocks a row is not published/);
plant('a blocked row for a reason that is not one', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'tooSmall', detail: 'x' }]; }), /blocked\[0\]\.reason is "tooSmall"/);
plant('blocked rows that are not a list', corpusOf((c) => { c.blocked = null; }), /corpus-2026-09-30\.json: blocked is null, not a list/);
plant('a registry\'s coverage that is not the raw file\'s', corpusOf((c) => { c.coverage.byEcosystem.hex.scanned += 1; }), /coverage\.byEcosystem\.hex is not the coverage and enumeration of scan-results-hex\.json/);
plant('a registry\'s enumeration that is not the raw file\'s', corpusOf((c) => { c.coverage.byEcosystem.go.enumeration = { requested: 1000, listed: 6, truncated: false, reason: null }; }), /coverage\.byEcosystem\.go is not the coverage and enumeration of scan-results-go\.json/);
plant('a coverage total that is not the sum of the rows', corpusOf((c) => { c.coverage.total.listed += 1; }), /coverage\.total\.listed is 37; the eleven scan files sum to 36/);
plant('a coverage without a registry', corpusOf((c) => { delete c.coverage.byEcosystem.pub; }), /coverage\.byEcosystem is missing pub/);
plant('a corpus without a registry\'s row', corpusOf((c) => { delete c.byEcosystem.pub; }), /corpus-2026-09-30\.json: byEcosystem is missing pub/);

// The corpus: measurability, every cell, and the identities.
plant('K that does not follow from the snapshot', corpusOf((c) => { c.byEcosystem.go.measurability.pqc.k = 1; }), /byEcosystem\.go\.measurability\.pqc\.k is 1; the catalogue snapshot has 0 countable entries in this class/);
plant('entries that do not follow from the snapshot', corpusOf((c) => { c.byEcosystem.maven.measurability.pqc.entries = ['org.bouncycastle:bcpqc-jdk18on']; }), /maven\.measurability\.pqc\.entries is \["org\.bouncycastle:bcpqc-jdk18on"\]; the countable entries of the snapshot are \[\]/);
plant('an exclusion the snapshot does not give', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.excluded = []; }), /npm\.measurability\.weak\.excluded is \[\]; the snapshot gives/);
plant('an exclusion for a reason that is not one', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.excluded[0].why = 'gone'; }), /measurability\.weak\.excluded is .*, not a list of \{ entry, why \}/);
plant('entries that are not names', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.entries = 'crypto-js'; }), /measurability\.weak\.entries is "crypto-js", not a list of distinct entry names/);
plant('a multi-purpose library among the post-quantum entries', corpusOf((c) => { c.byEcosystem.go.measurability.pqc.entries = ['github.com/cloudflare/circl']; }),
  /go\.measurability\.pqc\.entries names github\.com\/cloudflare\/circl, a multi-purpose library/);
// Each cell off by one, with whatever else it takes to keep the block's identities, so that the
// figure is caught as not following from the files rather than as one that breaks an identity.
// neitherWeakNorPqc cannot move alone without breaking the first identity, so its test is that one.
const offByOne = [
  ['matched', 'anyManifestMatch', { matched: 1, neitherWeakNorPqc: 1 }, 6],
  ['weak', 'directUnconditional', { weak: 1, brokenAlgorithm: 1, neitherWeakNorPqc: -1 }, 4],
  ['brokenAlgorithm', 'anyManifestMatch', { brokenAlgorithm: 1 }, 5],
  ['deprecatedLibrary', 'anyManifestMatch', { deprecatedLibrary: 1 }, 2],
  ['pqc', 'anyManifestMatch', { pqc: 1, weakAndPqc: 1 }, 3],
  ['weakAndPqc', 'anyManifestMatch', { weakAndPqc: 1, neitherWeakNorPqc: 1 }, 3],
];
for (const [cell, definition, moves, count] of offByOne) {
  plant(`the ${cell} cell off by one`, corpusOf((c) => {
    for (const [moved, by] of Object.entries(moves)) c.byEcosystem.npm[definition].raw[moved].count += by;
  }), new RegExp(`byEcosystem\\.npm\\.${definition}\\.raw\\.${cell} is \\{"count":${count}[,}].*recomputed from the files it is bound to`));
}
plant('a consolidated cell off by one', corpusOf((c) => { c.byEcosystem.maven.anyManifestMatch.consolidated.matched.count += 1; }), /maven\.anyManifestMatch\.consolidated\.matched is \{"count":2.*recomputed/);
plant('a total cell off by one', corpusOf((c) => { c.total.anyManifestMatch.raw.matched.count += 1; }), /total\.anyManifestMatch\.raw\.matched is \{"count":22.*recomputed/);
plant('a count where K is 0', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.pqc = { count: 0, k: 0, nullReason: null }; }), /go\.anyManifestMatch\.raw\.pqc is \{"count":0,"k":0,"nullReason":null\}: count must be null when k is 0/);
plant('null where K is not 0', corpusOf((c) => { c.byEcosystem.pypi.directUnconditional.raw.weak = { count: null, k: 2, nullReason: 'noCountableEntry' }; }), /pypi\.directUnconditional\.raw\.weak is .*: count is null while k is 2/);
plant('a null with no reason', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.pqc.nullReason = null; }), /go\.anyManifestMatch\.raw\.pqc is .*: nullReason says why count is null/);
plant('a reason with no null', corpusOf((c) => { npmRaw(c).weakAndPqc.nullReason = 'noCountableEntry'; }), /anyManifestMatch\.raw\.weakAndPqc is .*: nullReason says why count is null/);
plant('a null reason that is not one', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.pqc.nullReason = 'notMeasured'; }), /pqc\.nullReason is "notMeasured", not noCountableEntry, rowBlocked or null/);
plant('a K that is not a count', corpusOf((c) => { npmRaw(c).weak.k = null; }), /anyManifestMatch\.raw\.weak\.k is null, not a whole count/);
plant('a cell under another K', corpusOf((c) => { npmRaw(c).weak.k = 3; }), /anyManifestMatch\.raw\.weak is \{"count":5,"k":3,"nullReason":null\}; recomputed/);
plant('a block under another definition id', corpusOf((c) => { npmRaw(c).definitionId = 'census.match.anyManifest/1'; }), /anyManifestMatch\.raw\.definitionId is "census\.match\.anyManifest\/1", not census\.match\.anyManifest\/1\+census\.unit\.package\/1/);
plant('a block without its consolidation figures', corpusOf((c) => { delete c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation; }), /anyManifestMatch\.consolidated is missing consolidation/);
plant('a raw block with consolidation figures', corpusOf((c) => { npmRaw(c).consolidation = { unitsIn: 6, unitsOut: 6, merged: 0, removedByRule: {} }; }), /anyManifestMatch\.raw carries consolidation/);
plant('unclassified matches off by one', corpusOf((c) => { npmRaw(c).excludedUnclassified.matches += 1; }), /raw\.excludedUnclassified\.matches is 3; recomputed it is 2/);
plant('units with only unclassified matches off by one', corpusOf((c) => { npmRaw(c).excludedUnclassified.unitsWithOnlyUnclassifiedMatches = 2; }), /unitsWithOnlyUnclassifiedMatches is 2; recomputed it is 1/);
plant('an unclassified entry\'s count off by one', corpusOf((c) => { npmRaw(c).excludedUnclassified.byEntry[0].matches = 3; }), /raw\.excludedUnclassified\.byEntry is .*; recomputed it is .*It lists every unclassified entry/);
plant('an unclassified entry left out because nothing matched it', corpusOf((c) => { c.byEcosystem.packagist.directUnconditional.raw.excludedUnclassified.byEntry = []; }), /packagist\.directUnconditional\.raw\.excludedUnclassified\.byEntry is \[\]; recomputed it is/);
plant('consolidation figures off by one that still add up', corpusOf((c) => { Object.assign(c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation, { unitsIn: 7, unitsOut: 5 }); }),
  /consolidated\.consolidation\.unitsIn is 7; the consolidation map gives 6/);
plant('consolidation figures that do not add up', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.unitsIn = 7; }), /consolidated\.consolidation: unitsIn \(7\) is not unitsOut \+ merged \+ removed \(6\)/);
plant('a removal count the map does not give', corpusOf((c) => { Object.assign(c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation, { removedByRule: { sharedNamespace: 1 }, merged: 1 }); }),
  /removedByRule\.sharedNamespace is 1; the consolidation map gives 0/);
plant('a removal count under a rule the map does not have', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.removedByRule = { nameTooShort: 0 }; }), /removedByRule names nameTooShort, which is not a rule of the consolidation map/);
plant('removals that are not counts', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.removedByRule = { sharedNamespace: '1' }; }), /removedByRule is .*, not an object of counts by rule/);
plant('flags whose parts do not make the matched count', corpusOf((c) => { npmRaw(c).neitherWeakNorPqc.count = 1; }), /anyManifestMatch\.raw: matched \(5\) is not weak \(5\) \+ pqc \(2\) - weakAndPqc \(2\) \+ neitherWeakNorPqc \(1\)/);
plant('weak outside its two classes', corpusOf((c) => { npmRaw(c).deprecatedLibrary.count = 0; }), /anyManifestMatch\.raw: weak \(5\) is not between the larger of brokenAlgorithm \(4\) and deprecatedLibrary \(0\) and their sum/);
plant('"neither" counted where post-quantum is not measurable', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.neitherWeakNorPqc = { count: 2, nullReason: null }; }), /go\.anyManifestMatch\.raw: weakAndPqc or neitherWeakNorPqc is counted while weak or pqc is not measurable/);
plant('more matched than packages read with observable dependencies', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.matched.count = 5; }), /go\.anyManifestMatch\.raw: matched \(5\) is more than the 4 packages read whose dependencies could be observed/);
plant('a direct figure above the manifest-match one', corpusOf((c) => { c.byEcosystem.npm.directUnconditional.raw.deprecatedLibrary.count = 2; }),
  /byEcosystem\.npm: directUnconditional\.raw\.deprecatedLibrary \(2\) is more than anyManifestMatch\.raw\.deprecatedLibrary \(1\)/);
plant('figures without dev metadata for a registry that has none', corpusOf((c) => { c.byEcosystem.npm.excludingDevMetadata = c.byEcosystem.packagist.excludingDevMetadata; }), /byEcosystem\.npm\.excludingDevMetadata is .*\. It is kept for a registry read partly from dev metadata/);
plant('no figures without dev metadata for Packagist', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata = null; }), /byEcosystem\.packagist\.excludingDevMetadata is null, not an object/);
plant('coverage without dev metadata off by one', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.coverage.scanned = 3; }), /excludingDevMetadata\.coverage\.scanned is 3; the ledger gives 2 without the packages read from dev metadata/);
plant('a figure without dev metadata off by one', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.anyManifestMatch.raw.matched.count = 2; }), /packagist\.excludingDevMetadata\.anyManifestMatch\.raw\.matched is \{"count":2.*recomputed/);
plant('a total that names the wrong rows as measurable', corpusOf((c) => { c.total.directUnconditional.raw.pqc.measurableIn = ['npm']; }), /total\.directUnconditional\.raw\.pqc is .*recomputed/);
plant('a total whose measurable rows are not registries', corpusOf((c) => { c.total.directUnconditional.raw.pqc.measurableIn = ['npm', 'npm']; }), /total\.directUnconditional\.raw\.pqc\.measurableIn is \["npm","npm"\], not a list of distinct registries/);
plant('a total without dev metadata left out', corpusOf((c) => { c.total.excludingDevMetadata = null; }), /total\.excludingDevMetadata is null, not an object/);
plant('a total coverage without dev metadata off by one', corpusOf((c) => { c.total.excludingDevMetadata.coverage.listed = 36; }), /total\.excludingDevMetadata\.coverage\.listed is 36; the ledgers give 35/);
plant('a total figure without dev metadata off by one', corpusOf((c) => { c.total.excludingDevMetadata.directUnconditional.raw.weak.count += 1; }), /total\.excludingDevMetadata\.directUnconditional\.raw\.weak is .*recomputed/);
plant('a multi-purpose library left out', corpusOf((c) => { c.multiPurposeLibraries.pop(); }), /multiPurposeLibraries has no row for go:github\.com\/cloudflare\/circl/);
plant('a library listed as multi-purpose that is not', corpusOf((c) => { c.multiPurposeLibraries.push({ ...c.multiPurposeLibraries[0], entry: 'pyDes' }); }), /multiPurposeLibraries\[2\] names "pypi":"pyDes", which is not a multi-purpose entry/);
plant('a multi-purpose library listed twice', corpusOf((c) => { c.multiPurposeLibraries.push(structuredClone(c.multiPurposeLibraries[0])); }), /multiPurposeLibraries\[2\] names pypi:cryptography a second time/);
plant('a multi-purpose count off by one', corpusOf((c) => { c.multiPurposeLibraries[1].dependents.directUnconditional.consolidated = 2; }), /multiPurposeLibraries\[1\]\.dependents\.directUnconditional\.consolidated is 2; recomputed it is 1/);
plant('a multi-purpose count that is not a count', corpusOf((c) => { c.multiPurposeLibraries[1].dependents.anyManifestMatch.raw = null; }), /dependents\.anyManifestMatch\.raw is null, not a whole count/);
plant('a multi-purpose table under another id', corpusOf((c) => { c.multiPurposeLibraries[0].definitionId = 'census.table/1'; }), /multiPurposeLibraries\[0\]\.definitionId is "census\.table\/1"/);
plant('multi-purpose libraries that are not a list', corpusOf((c) => { c.multiPurposeLibraries = {}; }), /multiPurposeLibraries is \{\}, not a list/);

// Comparability with every earlier dataset.
plant('an empty comparability', corpusOf((c) => { c.comparability = []; }), /comparability is \[\]\. It is required and names every earlier dataset/);
plant('comparability naming a dataset that is not here', corpusOf((c) => { c.comparability.push({ ...c.comparability[0], dataset: '2026-08-03' }); }), /comparability\[1\] names "2026-08-03", which is not a dataset of this repository collected before 2026-09-30/);
plant('comparability naming a dataset twice', corpusOf((c) => { c.comparability.push({ ...c.comparability[0] }); }), /comparability\[1\] names 2026-03-18 a second time/);
plant('a first-shape dataset marked comparable', corpusOf((c) => { Object.assign(c.comparability[0], { comparable: true, reason: null, changes: [] }); }), /2026-03-18 is a version 1 dataset, measured with an instrument that has since changed, so it is not comparable/);
plant('a first-shape dataset that does not name every change', corpusOf((c) => { c.comparability[0].changes = ['matchSet']; }), /comparability\[0\]\.changes is \["matchSet"\]\. A version 1 dataset differs in every component/);
plant('a change code that is not one', corpusOf((c) => { c.comparability[0].changes = ['PLACEHOLDER']; }), /comparability\[0\]\.changes is \["PLACEHOLDER"\], not a list of distinct change codes/);
plant('a dataset not comparable for no reason', corpusOf((c) => { c.comparability[0].reason = null; }), /comparability\[0\] is not comparable, so its reason is instrumentChanged/);
plant('comparable that is not a yes or no', corpusOf((c) => { c.comparability[0].comparable = 'no'; }), /comparability\[0\]\.comparable is "no", not true or false/);
plant('a DOI that is not one', corpusOf((c) => { c.comparability[0].doi = 'zenodo'; }), /comparability\[0\]\.doi is "zenodo", not a DOI or null/);
plant('the manifest\'s comparability not a copy of the corpus\'s', manifestOf((m) => { m.comparability = [{ ...m.comparability[0], doi: '10.5281/zenodo.1' }]; }), /MANIFEST\.json: comparability is not the corpus's/);

// MANIFEST.json against the files.
plant('a manifest coverage that is not the files\'', manifestOf((m) => { m.coverage = { ...m.coverage, unresolved: 1 }; }), /MANIFEST\.json: coverage\.unresolved is 1; the eleven scan files sum to 0/);
plant('a manifest coverage count that is not a count', manifestOf((m) => { m.coverage = { ...m.coverage, absent: null }; }), /MANIFEST\.json: coverage\.absent is null, not a whole count/);
plant('a manifest registry whose sources are not the raw file\'s', manifestOf((m) => { m.ecosystems[2] = { ...m.ecosystems[2], sources: { enumeration: 'https://index.golang.org/index', manifests: 'https://proxy.golang.org' } }; }),
  /MANIFEST\.json: ecosystems\[2\]\.sources is not the sources of scan-results-go\.json/);
plant('a manifest registry listed twice', manifestOf((m) => { m.ecosystems[1] = m.ecosystems[0]; }), /MANIFEST\.json: ecosystems\[1\]\.ecosystem is "npm", not a registry listed once/);
plant('a manifest without a registry', manifestOf((m) => { m.ecosystems.pop(); }), /MANIFEST\.json: ecosystems has no item for cocoapods/);
plant('manifest registries that are not a list', manifestOf((m) => { m.ecosystems = {}; }), /MANIFEST\.json: ecosystems is \{\}, not a list/);

// Fields left out of nested objects, and the remaining types.
plant('unclassified counts that are not a list', corpusOf((c) => { npmRaw(c).excludedUnclassified.byEntry = {}; }), /raw\.excludedUnclassified\.byEntry is \{\}, not a list/);
plant('an unclassified count that is not a count', corpusOf((c) => { npmRaw(c).excludedUnclassified.byEntry[0].matches = '2'; }), /excludedUnclassified\.byEntry\[0\] is .*, not an entry and a count/);
plant('consolidation figures that are not counts', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.unitsOut = null; }), /consolidated\.consolidation\.unitsOut is null, not a whole count/);
plant('a comparable dataset that still gives a reason', corpusOf((c) => { c.comparability[0].comparable = true; }), /comparability\[0\] is comparable and still gives a reason or changes/);
plant('a coverage total that is not a count', corpusOf((c) => { c.coverage.total.absent = -1; }), /coverage\.total\.absent is -1, not a whole count/);
plant('a total without dev metadata where no registry reads from it', {
  fixture: (f) => { f.packagist.method.readFrom = ['taggedRelease']; f.packagist.rows.find((r) => r.name === 'acme/cli').readFrom = 'taggedRelease'; },
  corpus: (c) => { c.byEcosystem.packagist.excludingDevMetadata = null; },
}, /total\.excludingDevMetadata is set, and no registry is read partly from dev metadata/);

// Where a dataset sits.
test('comparability missing an earlier directory is refused', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, {}],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }]],
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /2026-09-30: corpus-2026-09-30\.json: comparability does not name 2026-09-15\. Every earlier dataset is named/, result.stderr);
});
test('a later dataset marked comparable with an earlier one whose instrument differs is refused', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, { scans: (s) => { s.npm.method.versionSelection = 'distTagLatest'; } }],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2 }]],
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /2026-09-15 is marked comparable, and these differ between the two datasets: the npm scanner's method\. Two datasets are comparable only when/, result.stderr);
});
test('a later dataset marked comparable with an earlier one that cannot be read is refused', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, {}],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2 }]],
  }, (dir) => unlinkSync(join(dir, 'datasets', EARLIER_V2, 'catalog-2026-09-15.json')));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /2026-09-15 is marked comparable, and the files that would show it cannot be read/, result.stderr);
});
test('an earlier dataset whose manifest cannot be read is refused as a comparison', async () => {
  const result = await validate({ [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: '2026-09-01', version: 1 }]] },
    (dir) => { mkdirSync(join(dir, 'datasets', '2026-09-01')); writeFileSync(join(dir, 'datasets', '2026-09-01', 'MANIFEST.json'), '{'); });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /comparability\[1\]: 2026-09-01 has no manifest these rules can read/, result.stderr);
});

// Each object is closed: a field the contract does not define fails, at every level.
const closedInTheCorpus = [
  ['a registry of the manifest', manifestOf((m) => { m.ecosystems[0].note = 'x'; }), /MANIFEST\.json: ecosystems\[0\] carries note/],
  ['a known issue', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), note: 'x' }]; }), /MANIFEST\.json: knownIssues\[0\] carries note/],
  ['the corpus', corpusOf((c) => { c.packagesScanned = 36; }), /corpus-2026-09-30\.json carries packagesScanned/],
  ['the inputs', corpusOf((c) => { c.inputs.note = 'x'; }), /corpus-2026-09-30\.json: inputs carries note/],
  ['an input scan', corpusOf((c) => { c.inputs.scans[0].note = 'x'; }), /inputs\.scans\[0\] carries note/],
  ['the input catalogue', corpusOf((c) => { c.inputs.catalog.note = 'x'; }), /inputs\.catalog carries note/],
  ['the input map', corpusOf((c) => { c.inputs.consolidation.note = 'x'; }), /inputs\.consolidation carries note/],
  ['the definitions', corpusOf((c) => { c.definitions.note = 'x'; }), /: definitions carries note/],
  ['a definition', corpusOf((c) => { c.definitions.raw.note = 'x'; }), /definitions\.raw carries note/],
  ['the manifest-match definition', corpusOf((c) => { c.definitions.anyManifestMatch.note = 'x'; }), /definitions\.anyManifestMatch carries note/],
  ['the direct definition', corpusOf((c) => { c.definitions.directUnconditional.note = 'x'; }), /definitions\.directUnconditional carries note/],
  ['the class ids', corpusOf((c) => { c.definitions.classes.modern = 'x'; }), /definitions\.classes carries modern/],
  ['a comparability record', corpusOf((c) => { c.comparability[0].note = 'x'; }), /comparability\[0\] carries note/],
  ['a blocked row', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'sourcesOffAllowlist', detail: 'x', note: 'x' }]; }), /blocked\[0\] carries note/],
  ['the corpus coverage', corpusOf((c) => { c.coverage.note = 'x'; }), /corpus-2026-09-30\.json: coverage carries note/],
  ['the coverage total', corpusOf((c) => { c.coverage.total.withCrypto = 1; }), /coverage\.total carries withCrypto/],
  ['a registry\'s coverage', corpusOf((c) => { c.coverage.byEcosystem.hex.qc = 1; }), /coverage\.byEcosystem\.hex carries qc/],
  ['a registry\'s row', corpusOf((c) => { c.byEcosystem.hex.qc = {}; }), /byEcosystem\.hex carries qc/],
  ['the measurability', corpusOf((c) => { c.byEcosystem.hex.measurability.modern = {}; }), /measurability carries modern/],
  ['one class\'s measurability', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.note = 'x'; }), /measurability\.weak carries note/],
  ['an exclusion', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.excluded[0].note = 'x'; }), /measurability\.weak\.excluded\[0\] carries note/],
  ['a figure block', corpusOf((c) => { npmRaw(c).modernOnly = { count: 1, k: 1, nullReason: null }; }), /anyManifestMatch\.raw carries modernOnly/],
  ['a pair of blocks', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.qc = {}; }), /byEcosystem\.npm\.anyManifestMatch carries qc/],
  ['a class cell', corpusOf((c) => { npmRaw(c).weak.note = 'x'; }), /anyManifestMatch\.raw\.weak carries note/],
  ['a joint cell', corpusOf((c) => { npmRaw(c).weakAndPqc.k = 2; }), /anyManifestMatch\.raw\.weakAndPqc carries k/],
  ['what was left out', corpusOf((c) => { npmRaw(c).excludedUnclassified.note = 'x'; }), /raw\.excludedUnclassified carries note/],
  ['an unclassified entry\'s count', corpusOf((c) => { npmRaw(c).excludedUnclassified.byEntry[0].ecosystem = 'npm'; }), /excludedUnclassified\.byEntry\[0\] carries ecosystem/],
  ['the consolidation figures', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.note = 'x'; }), /consolidated\.consolidation carries note/],
  ['the figures without dev metadata', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.note = 'x'; }), /byEcosystem\.packagist\.excludingDevMetadata carries note/],
  ['the total', corpusOf((c) => { c.total.coverage = c.coverage.total; }), /corpus-2026-09-30\.json: total carries coverage/],
  ['a total cell', corpusOf((c) => { c.total.anyManifestMatch.raw.weak.note = 'x'; }), /total\.anyManifestMatch\.raw\.weak carries note/],
  ['a joint total cell', corpusOf((c) => { c.total.anyManifestMatch.raw.weakAndPqc.measurableIn = ['npm']; }), /total\.anyManifestMatch\.raw\.weakAndPqc carries measurableIn/],
  ['the total without dev metadata', corpusOf((c) => { c.total.excludingDevMetadata.note = 'x'; }), /total\.excludingDevMetadata carries note/],
  ['a multi-purpose library', corpusOf((c) => { c.multiPurposeLibraries[0].total = 2; }), /multiPurposeLibraries\[0\] carries total/],
  ['its dependents', corpusOf((c) => { c.multiPurposeLibraries[0].dependents.anyManifestMatch.total = 2; }), /dependents\.anyManifestMatch carries total/],
];
for (const [level, change, problem] of closedInTheCorpus) plant(`a field the contract does not define, in ${level}`, change, problem);

test('more malformed rows than are listed one by one are counted after the first five', async () => {
  const result = await validateOne(ledgerOf('npm', (lines) => lines.map((line, i) => (i === 0 ? line : line.replace(/^([^\t]+)\t[^\t]+\t/, '$1\tgone\t')))));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /listing-npm\.tsv\.gz: row 2 has the disposition "gone"/, result.stderr);
  assert.equal(result.stderr.split('\n').filter((line) => / listing-npm\.tsv\.gz: row \d+ /.test(line)).length, 5, result.stderr);
  assert.match(result.stderr, /listing-npm\.tsv\.gz: 3 more row\(s\) are malformed/);
});

// --- Files that would hang, or exhaust a reader ----------------------------------

const deep = (depth) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
plant('a manifest nested deeper than any version 2 file', {}, /MANIFEST\.json nests values more than 32 deep/, (dir) => {
  const path = join(datasetDir(dir), 'MANIFEST.json');
  writeFileSync(path, readText(path).replace(/"comparability": \[[\s\S]*?\n {2}\],\n/, `"comparability": ${deep(20000)},\n`));
});
plant('a listed file nested deeper than any version 2 file', {}, /corpus-2026-09-30\.json nests values more than 32 deep/, (dir) => {
  const text = readText(join(datasetDir(dir), 'corpus-2026-09-30.json'));
  rehash('corpus-2026-09-30.json', text.replace(/"comparability": \[[\s\S]*?\n {2}\],\n/, `"comparability": ${deep(20000)},\n`))(dir);
});

test('a manifest that is a link to a device is refused without reading it', { timeout: 30000 }, async () => {
  const result = await validateOne({}, (dir) => {
    const path = join(datasetDir(dir), 'MANIFEST.json');
    unlinkSync(path);
    symlinkSync('/dev/zero', path);
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /MANIFEST\.json is not a regular file/, result.stderr);
});

test('an earlier dataset whose manifest is a pipe is refused without reading it', { timeout: 30000 }, async () => {
  const result = await validate({ [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: '2026-09-01', version: 1 }]] }, (dir) => {
    mkdirSync(join(dir, 'datasets', '2026-09-01'));
    execFileSync('mkfifo', [join(dir, 'datasets', '2026-09-01', 'MANIFEST.json')]);
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, '2026-09-01'), /MANIFEST\.json is not a regular file/, result.stderr);
  assert.match(firstProblem(result.stderr), /comparability\[1\]: 2026-09-01 has no manifest these rules can read/, result.stderr);
});

test('a link under datasets/ that leads nowhere is reported, and the run goes on', async () => {
  const result = await validateOne({}, (dir) => symlinkSync('nowhere', join(dir, 'datasets', '2026-01-01')));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, 'datasets'), /2026-01-01 is not a dataset directory/, result.stderr);
  assert.doesNotMatch(result.stderr, /could not be checked to the end|\n\s+at /);
});

test('past fifty problems in one file, the rest are counted, not listed', async () => {
  const result = await validateOne(scanOf('hex', (s) => {
    for (let i = 0; i < 40; i += 1) s.packages.push({ name: `extra-${i}`, extra: true });
  }));
  assert.equal(result.code, 1, result.stdout);
  const listed = result.stderr.split('\n').filter((line) => line.startsWith(`  ${DATE}: scan-results-hex.json`));
  assert.equal(listed.length, 51, result.stderr);
  assert.match(listed.at(-1), /scan-results-hex\.json: \d+ more problem\(s\) in this file are not listed/);
});

// --- Running the planted defects -------------------------------------------------

for (const [what, change, problem, prepare] of defects) {
  test(`${what} is refused`, async () => {
    const result = await validateOne(change, prepare);
    assert.equal(result.code, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
    assert.match(firstProblem(result.stderr), problem, result.stderr);
  });
}

function readText(path) {
  return readFileSync(path, 'utf-8');
}
