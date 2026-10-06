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
