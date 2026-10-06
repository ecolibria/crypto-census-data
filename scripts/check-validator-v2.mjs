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
 * of the corpus is written out by hand below, beside the packages it comes
 * from, small enough to be checked by eye. The coverage counts, the ledger's
 * match counts and the totals are computed by the small code in this file
 * from what is listed here, never by the validator's code.
 *
 *   node --test scripts/check-validator-v2.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

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
        unread('org.example:gone', 'absent', 'http404'),
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
    ledgers[eco] = ['name\tdisposition\treason\tversion\treadFrom\tobservable\tmatches', ...fixture[eco].rows.map((row) => (scannedRow(row)
      ? [row.name, 'scanned', '', '1.0.0', row.readFrom, String(row.observable), String(row.matches.length)]
      : [row.name, row.disposition, row.reason, '', '', '', '']).join('\t'))];
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
plant('an oversize file', {}, /listing-crates\.tsv\.gz is 95,000,001 bytes, over the 95,000,000 a dataset file may hold/,
  (dir) => truncateSync(join(datasetDir(dir), 'listing-crates.tsv.gz'), 95_000_001));
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
  assert.match(result.stderr, /2026-08-03: schemaVersion is 2, and 2026-08-03 is one of the datasets published in the first file shape/);
});
test('a first-shape manifest under a version 2 date is refused', async () => {
  const result = await validate({}, (dir) => cpSync(join(ROOT, 'datasets', FIRST_SHAPE), join(dir, 'datasets', DATE), { recursive: true }));
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /2026-09-30: MANIFEST\.json declares no schemaVersion\. The first file shape is accepted only for 2026-03-18 and 2026-08-03/);
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

// --- Running the planted defects -------------------------------------------------

for (const [what, change, problem, prepare] of defects) {
  test(`${what} is refused`, async () => {
    const result = await validateOne(change, prepare);
    assert.equal(result.code, 1, `expected a failure, got:\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, problem);
  });
}

function readText(path) {
  return readFileSync(path, 'utf-8');
}
