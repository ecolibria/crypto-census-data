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
 * comes from, small enough to be checked by eye, and so is every figure of the
 * total. The coverage counts and the ledger's match counts are computed by the
 * small code in this file from what is listed here, never by the validator's
 * code.
 *
 *   node --test scripts/check-validator-v2.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
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
const CHECKS = ['noMatches', 'sourcesOffAllowlist', 'catalogCheckMismatches', 'inputHashMismatches', 'identityFailures'];
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

// Example values. The commit id has the right form and names nothing. The run
// is in the form the contract gives a run of the instrument, and its id names
// no run; every other URL is in a reserved example domain.
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const RUN_ID = '1';
const runUrl = (id) => `https://github.com/opena2a-org/crypto-census/actions/runs/${id}`;
const RUN_URL = runUrl(RUN_ID);

/**
 * The snapshot's two digests, computed here from its entries: JSON with keys
 * sorted and no whitespace, written with a replacer rather than the
 * validator's code, over the fields each digest covers.
 */
const canonicalJson = (value) => JSON.stringify(value, (key, v) => (v !== null && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const digestsOf = (catalog) => {
  const entries = [...catalog.entries].sort((a, b) => byteOrder(a.ecosystem, b.ecosystem) || byteOrder(a.name, b.name));
  const hash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  return {
    matchSetSha256: hash({
      entries: entries.map((e) => ({ ecosystem: e.ecosystem, name: e.name, aliases: e.aliases.map((a) => a.name).sort(byteOrder), unmatchable: e.unmatchable !== null })),
      matchRules: catalog.matchRules,
    }),
    classificationSha256: hash({
      entries: entries.map((e) => ({ ecosystem: e.ecosystem, name: e.name, tier: e.tier, weakClass: e.weakClass, classified: e.classified,
        multiPurpose: e.multiPurpose !== null, registryAbsent: e.registryAbsent !== null, unmatchable: e.unmatchable !== null })),
    }),
  };
};
const CHECKED = '2026-09-28T12:00:00.000Z';
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
/** The same figure in every block of a registry. */
const everywhere = (spec) => ({ anyManifestMatch: { raw: spec, consolidated: spec }, directUnconditional: { raw: spec, consolidated: spec } });
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
      // delta {@types} only, epsilon {md5, post-quantum}, zeta {tripledes, @types}. tripledes is absent from the
      // registry, so not countable: zeta is in no class, and is counted under excludedNotCountable. Direct: alpha
      // {md5}, gamma {node-forge}, epsilon {md5, post-quantum}, zeta {tripledes, @types}; beta is optional, delta a
      // dev dependency, gamma's md5 an optional peer. Consolidated: alpha, beta and gamma are one unit (@acme).
      blocks: {
        anyManifestMatch: {
          raw: [[4, 4, 3, 1, 2, 2, 0], { '@types/bcryptjs': 2 }, 1],
          consolidated: [[2, 2, 2, 1, 2, 2, 0], { '@types/bcryptjs': 2 }, 1, [6, 4, 2]],
        },
        directUnconditional: {
          raw: [[3, 2, 2, 0, 1, 1, 1], { '@types/bcryptjs': 1 }, 0],
          consolidated: [[2, 2, 2, 0, 1, 1, 0], { '@types/bcryptjs': 1 }, 0, [4, 3, 1]],
        },
      },
      // zeta, under every definition and unit: its match to tripledes, and nothing countable.
      notCountable: everywhere([{ tripledes: 1 }, 1]),
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
      notCountable: everywhere([{ 'crypto/md5': 0 }, 0]),
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
      // The search found 400 rows: two pages of 200, both drawn and read (the ledger's pages 0 and 1).
      frameSize: 400,
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
      notCountable: everywhere([{ 'org.bouncycastle:bcpqc-jdk18on': 0 }, 0]),
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

function cellsOf(spec, k, definitionId, [notCountable, onlyNotCountable] = [{}, 0]) {
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
  block.excludedNotCountable = {
    matches: sum(Object.values(notCountable)),
    unitsWithOnlyNotCountableMatches: onlyNotCountable,
    byEntry: Object.entries(notCountable).map(([entry, matches]) => ({ entry, matches })),
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

function blocksOf(specs, k, notCountable = {}) {
  return Object.fromEntries(DEFINITIONS.map((definition) => [definition, Object.fromEntries(UNITS.map((unit) =>
    [unit, cellsOf(specs[definition][unit], k, `${ID[definition]}+${ID[unit]}`, notCountable[definition]?.[unit])]))]));
}

/** A total, summed by this file's own code: a class cell over the rows where its K is above 0. */
function totalTables() {
  return {
    // A class cell sums the rows where its K is above 0 and names them; the two joint cells sum the rows
    // where weak and pqc are both counted. K over those rows: matched 4+3+3+2+2+2+2+1+1+1+2, and so on.
    measurable: {
      matched: [...ECOSYSTEMS],
      weak: ['npm', 'pypi', 'go', 'maven', 'crates', 'packagist', 'nuget', 'cocoapods'],
      brokenAlgorithm: ['npm', 'pypi'],
      deprecatedLibrary: ['npm', 'pypi', 'go', 'maven', 'crates', 'packagist', 'nuget', 'cocoapods'],
      pqc: ['npm', 'crates'],
      weakAndPqc: ['npm', 'crates'],
      neitherWeakNorPqc: ['npm', 'crates'],
    },
    k: { matched: 23, weak: 10, brokenAlgorithm: 2, deprecatedLibrary: 8, pqc: 2 },
    // matched, weak, brokenAlgorithm, deprecatedLibrary, pqc, weakAndPqc, neitherWeakNorPqc: the rows above, summed.
    cells: {
      anyManifestMatch: { raw: [20, 13, 4, 9, 3, 3, 0], consolidated: [15, 11, 3, 9, 3, 3, 0] },
      directUnconditional: { raw: [15, 6, 2, 4, 2, 1, 1], consolidated: [12, 6, 2, 4, 2, 1, 0] },
    },
    // Each entry left out, by registry, and the units whose only matches it holds; the same for both units.
    excluded: {
      anyManifestMatch: {
        excludedUnclassified: [[['npm', '@types/bcryptjs', 2], ['maven', 'commons-codec:commons-codec', 1], ['packagist', 'paragonie/random_compat', 1]], 2],
        excludedNotCountable: [[['npm', 'tripledes', 1], ['go', 'crypto/md5', 0], ['maven', 'org.bouncycastle:bcpqc-jdk18on', 0]], 1],
      },
      directUnconditional: {
        excludedUnclassified: [[['npm', '@types/bcryptjs', 1], ['maven', 'commons-codec:commons-codec', 1], ['packagist', 'paragonie/random_compat', 0]], 0],
        excludedNotCountable: [[['npm', 'tripledes', 1], ['go', 'crypto/md5', 0], ['maven', 'org.bouncycastle:bcpqc-jdk18on', 0]], 1],
      },
    },
    // unitsIn, unitsOut, merged: npm 6, 4, 2; go 3, 2, 1; maven 2, 1, 1; packagist 3, 2, 1; the rest unmerged.
    stats: { anyManifestMatch: [23, 18, 5], directUnconditional: [16, 13, 3] },
  };
}

/** The total blocks, from the tables written out above. */
function totalsFrom(t) {
  const withheld = t.withheld ?? [];
  const rows = (cell) => ({
    measurableIn: t.measurable[cell],
    notMeasurableIn: ECOSYSTEMS.filter((eco) => !t.measurable[cell].includes(eco) && !withheld.includes(eco)),
  });
  const UNITS_FIELD = { excludedUnclassified: 'unitsWithOnlyUnclassifiedMatches', excludedNotCountable: 'unitsWithOnlyNotCountableMatches' };
  return Object.fromEntries(DEFINITIONS.map((definition) => [definition, Object.fromEntries(UNITS.map((unit) => {
    const cells = t.cells[definition][unit];
    const block = { definitionId: `${ID[definition]}+${ID[unit]}` };
    CLASSES.forEach((cls, i) => {
      block[cls] = { count: cells[i], k: t.k[cls], nullReason: cells[i] === null ? 'noCountableEntry' : null, ...rows(cls) };
    });
    JOINT.forEach((joint, j) => {
      block[joint] = { count: cells[5 + j], nullReason: cells[5 + j] === null ? 'noCountableEntry' : null, ...rows(joint) };
    });
    for (const [group, [items, only]] of Object.entries(t.excluded[definition])) {
      block[group] = {
        matches: sum(items.map(([, , matches]) => matches)),
        [UNITS_FIELD[group]]: only,
        byEntry: items.map(([ecosystem, entry, matches]) => ({ ecosystem, entry, matches })),
      };
    }
    if (unit === 'consolidated') {
      const [unitsIn, unitsOut, merged] = t.stats[definition];
      block.consolidation = { unitsIn, unitsOut, merged, removedByRule: {} };
    }
    return [unit, block];
  }))]));
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
 * consolidation, corpus, manifest. `noScanFile` names registries whose scan
 * file and ledger the dataset does not hold: the corpus withholds each for it.
 */
function buildDataset(date, change = {}, earlier = [{ dataset: FIRST_SHAPE, version: 1 }]) {
  const missing = change.noScanFile ?? [];
  const read = ECOSYSTEMS.filter((eco) => !missing.includes(eco));
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
    matchSetSha256: null, classificationSha256: null,
    matchRules: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, `${eco}Name/1`])),
    categories: ['encryption', 'general', 'hashing'],
    entries,
  };
  change.catalog?.(catalog);
  // A digest a change left alone is computed from the entries as they now are; catalogAfterDigests changes them after.
  // Entries a change has made unreadable get digests of the right form, which the validator does not recompute.
  let digests;
  try {
    digests = digestsOf(catalog);
  } catch {
    digests = { matchSetSha256: sha256('unreadable entries'), classificationSha256: sha256('unreadable entries') };
  }
  for (const field of ['matchSetSha256', 'classificationSha256']) if (catalog[field] === null) catalog[field] = digests[field];
  change.catalogAfterDigests?.(catalog);
  files[fileName.catalog(date)] = json(catalog);
  const MATCH_SET = catalog.matchSetSha256;
  const CLASSIFICATION = catalog.classificationSha256;

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
  const ledgerBytes = Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, Buffer.isBuffer(ledgers[eco]) ? ledgers[eco] : gzipSync(`${ledgers[eco].join('\n')}\n`)]));
  for (const eco of read) files[fileName.listing(eco)] = ledgerBytes[eco];

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
        checkedAt: `${date}T00:30:00.000Z`, latestVersion: null, latestReleaseAt: null,
      },
      ...e.aliases.map((a) => ({
        entry: e.name, alias: a.name, status: 'present', httpStatus: 200,
        url: `https://${eco}.registry.example/check/${encodeURIComponent(a.name)}`,
        checkedAt: `${date}T00:30:00.000Z`, latestVersion: null, latestReleaseAt: null,
      })),
    ]);
    scans[eco] = {
      schemaVersion: 2, kind: 'censusScan', ecosystem: eco,
      startedAt: `${date}T00:00:00.000Z`, finishedAt: `${date}T06:00:00.000Z`,
      scanner: { script: `scripts/scan-${eco}.mjs`, commit: COMMIT, workflowRun: RUN_URL },
      sources: structuredClone(ADMITTED_SOURCES[eco]),
      catalog: { entries: r.entries.length, matchSetSha256: MATCH_SET, matchRule: `${eco}Name/1` },
      method: { versionSelection: 'latest', readFrom: r.method.readFrom, declarationKinds: [...KINDS[eco]], notObservableWhen: r.method.notObservableWhen, limits: r.method.limits },
      // Every row is read as the population rule sets it: whole, or a seeded draw of its size whose seed is the run's id.
      // A frame smaller than the size is read whole, so a draw lists its frame.
      enumeration: {
        requested: RULED_POPULATION[eco].rule === 'listing' ? null : RULED_POPULATION[eco].size, listed: coverage.listed, truncated: false,
        reason: null, unit: 'packages', budgetMinutes: null, elapsedMinutes: 1.5, frameSize: r.frameSize ?? coverage.listed,
        sampling: RULED_POPULATION[eco].rule === 'listing'
          ? { method: 'all', seed: null, draw: null, pageRows: null }
          : { method: 'seededShuffle', seed: RUN_ID, draw: RULED_POPULATION[eco].draw, pageRows: RULED_POPULATION[eco].pageRows ?? null },
        indexWindow: eco === 'go' ? { since: '2026-09-01T00:00:00.000Z', until: `${date}T00:00:00.000Z` } : null,
      },
      versionYears: eco === 'go' ? { 2024: 2, 2025: 3 } : null,
      coverage: { ...coverage, scannedByReadFrom: byReadFrom },
      listing: { file: fileName.listing(eco), sha256: sha256(ledgerBytes[eco]), rows: coverage.listed },
      catalogCheck,
      packagesWithMatch: packages.length,
      packages,
    };
  }
  change.scans?.(scans);
  for (const eco of read) files[fileName.scan(eco)] = json(scans[eco]);

  const consolidation = {
    schemaVersion: 2, kind: 'censusConsolidation', collectedAt: date, definitionId: ID.consolidated,
    rules: [{ id: 'sharedNamespace', statement: 'Packages that share an npm scope, a Maven groupId, a Packagist vendor or the first three elements of a Go path are one unit.' }],
    byEcosystem: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, { units: missing.includes(eco) ? [] : fixture[eco].units, removed: [] }])),
  };
  change.consolidation?.(consolidation);
  files[fileName.consolidation(date)] = json(consolidation);

  const rows = {};
  for (const eco of ECOSYSTEMS) {
    const r = fixture[eco];
    const k = Object.fromEntries(CLASSES.map((cls) => [cls, r.measurability[cls].k]));
    rows[eco] = { ...blocksOf(r.blocks, k, r.notCountable), excludingDevMetadata: null };
    if (r.devBlocks) {
      rows[eco].excludingDevMetadata = {
        coverage: (({ scanned, dependenciesNotObservable }) => ({ scanned, dependenciesNotObservable }))(coverageOf(r.rows.filter((row) => row.readFrom !== 'devDefaultBranch'))),
        ...blocksOf(r.devBlocks, k, r.notCountable),
      };
    }
  }
  // Rows the corpus withholds: not published, and summed by no total.
  const withhold = [...(change.withhold ?? []),
    ...missing.map((eco) => ({ ecosystem: eco, reasons: [{ code: 'noScanFile', detail: `no scan file of ${eco}` }] }))];
  const isPublished = (eco) => !withhold.some((w) => w.ecosystem === eco);
  const tables = { ...totalTables(), withheld: withhold.map((w) => w.ecosystem) };
  change.totalTables?.(tables);
  const comparability = earlier.map(({ dataset, version, comparable = true, changes = [] }) => (version === 1
    ? { dataset, doi: null, comparable: false, reason: 'instrumentChanged', changes: [...CHANGE_CODES] }
    : { dataset, doi: null, comparable, reason: comparable ? null : 'instrumentChanged', changes }));
  const corpus = {
    schemaVersion: 2, kind: 'censusCorpus', collectedAt: date, generatedAt: `${date}T12:00:00.000Z`,
    aggregator: { script: 'scripts/aggregate.mjs', commit: COMMIT },
    inputs: {
      scans: read.map((eco) => ({ ecosystem: eco, file: fileName.scan(eco), sha256: sha256(files[fileName.scan(eco)]) })),
      catalog: { file: fileName.catalog(date), sha256: sha256(files[fileName.catalog(date)]), matchSetSha256: MATCH_SET, classificationSha256: CLASSIFICATION },
      consolidation: { file: fileName.consolidation(date), sha256: sha256(files[fileName.consolidation(date)]) },
    },
    definitions: {
      coverage: { id: 'census.coverage/1' },
      unresolvedCeiling: 0.01,
      anyManifestMatch: { id: ID.anyManifestMatch, includes: structuredClone(INCLUDES) },
      directUnconditional: { id: ID.directUnconditional, predicate: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, `The ${eco} declarations that count as direct and unconditional.`])), code: 'lib/census/declarations.mjs' },
      raw: { id: ID.raw },
      consolidated: { id: ID.consolidated },
      classes: {
        matched: 'census.class.countableEntry/1', weak: 'census.class.weak/1', brokenAlgorithm: 'census.class.brokenAlgorithm/1',
        deprecatedLibrary: 'census.class.deprecatedLibrary/1', pqc: 'census.class.pqcDedicated/1',
      },
      multiPurposeLibrary: { id: 'census.table.multiPurposeLibrary/1' },
    },
    comparability,
    blocked: [],
    // A withheld row keeps the coverage its row would have held: the raw coverage, its enumeration and its sources.
    withheld: withhold.map(({ ecosystem, reasons }) => ({ ecosystem, reasons: structuredClone(reasons),
      coverage: missing.includes(ecosystem) ? null
        : structuredClone({ ...scans[ecosystem].coverage, enumeration: scans[ecosystem].enumeration, sources: scans[ecosystem].sources }) })),
    coverage: {
      total: Object.fromEntries(COVERAGE.map((field) => [field, sum(ECOSYSTEMS.filter(isPublished).map((eco) => scans[eco].coverage[field]))])),
      byEcosystem: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, structuredClone({ ...scans[eco].coverage, enumeration: scans[eco].enumeration, sources: scans[eco].sources })])),
    },
    byEcosystem: Object.fromEntries(ECOSYSTEMS.map((eco) => [eco, { measurability: fixture[eco].measurability, ...rows[eco] }])),
    total: totalsFrom(tables),
    multiPurposeLibraries: MULTI_PURPOSE.map(({ ecosystem, entry: name, counts }) => ({
      ecosystem, entry: name, definitionId: 'census.table.multiPurposeLibrary/1',
      dependents: isPublished(ecosystem)
        ? { anyManifestMatch: { raw: counts[0], consolidated: counts[1] }, directUnconditional: { raw: counts[2], consolidated: counts[3] } }
        : { anyManifestMatch: { raw: null, consolidated: null }, directUnconditional: { raw: null, consolidated: null } },
    })),
  };
  // The measurability objects of the fixture are shared with the corpus above; copy them so a change to one is a change to one.
  for (const eco of ECOSYSTEMS) corpus.byEcosystem[eco].measurability = structuredClone(fixture[eco].measurability);
  for (const eco of ECOSYSTEMS.filter((x) => !isPublished(x))) {
    corpus.byEcosystem[eco] = null;
    corpus.coverage.byEcosystem[eco] = null;
  }
  change.corpus?.(corpus);
  files[fileName.corpus(date)] = json(corpus);

  const listing = [
    { role: 'corpus', ecosystem: null, file: fileName.corpus(date) },
    { role: 'catalog', ecosystem: null, file: fileName.catalog(date) },
    { role: 'consolidation', ecosystem: null, file: fileName.consolidation(date) },
    ...read.flatMap((eco) => [
      { role: 'scan', ecosystem: eco, file: fileName.scan(eco) },
      { role: 'listing', ecosystem: eco, file: fileName.listing(eco) },
    ]),
  ];
  const manifest = {
    schemaVersion: 2,
    dataset: 'Example census dataset, built by the validator tests',
    kind: 'raw+aggregate',
    collectedAt: date,
    generatedAt: `${date}T13:00:00.000Z`,
    license: 'CC-BY-4.0',
    provenance: { sourceRepository: 'example/census', sourceCommit: COMMIT, workflowRun: RUN_URL },
    files: listing.map((item) => ({ ...item, bytes: Buffer.byteLength(files[item.file]), sha256: sha256(files[item.file]), schemaVersion: 2 })),
    coverage: Object.fromEntries(COVERAGE.map((field) => [field, sum(ECOSYSTEMS.filter(isPublished).map((eco) => scans[eco].coverage[field]))])),
    ecosystems: read.map((eco) => structuredClone({ ecosystem: eco, coverage: scans[eco].coverage, enumeration: scans[eco].enumeration, sources: scans[eco].sources })),
    comparability: structuredClone(corpus.comparability),
    checks: Object.fromEntries(CHECKS.map((check) => [check, []])),
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

/** Run a copy of the validator. A run that is killed, by a timeout here or by a crash, has no exit code and a signal. */
const run = (args, options) => new Promise((done) => {
  execFile(process.execPath, args, { ...options, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => done({ code: error ? error.code : 0, signal: error ? error.signal ?? null : null, stdout, stderr }));
});

/**
 * The admitted allowlist of sources, this file's own copy, written as JSON
 * text like the validator's. Every scan the fixture writes reads from exactly
 * these, and the digest below pins both copies.
 */
const ADMITTED_SOURCES_JSON = `{
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
const ADMITTED_SOURCES = JSON.parse(ADMITTED_SOURCES_JSON);
const ADMITTED_SOURCES_SHA256 = 'dc3da855b33e5ef92470b0647f54da194006bf1fc6c71a46348e63b4f4b78a05';

/**
 * The population rule, this file's own copy of the instrument's `POPULATION`
 * (lib/census/population.mjs at 56078ea, lines 59 to 71, with its three
 * constants written out), as JSON text. Every scan the fixture writes is read
 * under it, and the digest below pins both copies.
 */
const RULED_POPULATION_JSON = `{
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
const RULED_POPULATION = JSON.parse(RULED_POPULATION_JSON);
const RULED_POPULATION_SHA256 = 'afab7c7dffb7018d7dbc96adb76601f451f496d660000bcf8895508f791b8c43';

/**
 * Write a repository holding a copy of the validator, a copy of the smaller
 * published dataset, and the version 2 datasets given, and run the copy.
 * `datasets` maps a directory name to [date, change, earlier]; `prepare` runs
 * on the directory before the validator does; `options` go to the run, for
 * a `timeout` in milliseconds after which the validator is killed, except
 * `args`, the arguments the validator is run with.
 */
async function validate(datasets, prepare, { args = [], ...options } = {}) {
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
    return await run([join(dir, 'scripts', 'validate-dataset.mjs'), ...args], { env: {}, ...options });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The usual case: one version 2 dataset, under its own date, beside the published one. */
const validateOne = (change = {}, prepare = undefined, options = {}) => validate({ [DATE]: [DATE, change] }, prepare, options);
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
  ['the manifest\'s provenance', manifestOf((m) => { m.provenance.note = 'x'; }), /MANIFEST\.json: provenance carries "note"/],
  ['the manifest\'s checks', manifestOf((m) => { m.checks.note = []; }), /MANIFEST\.json: checks carries "note"/],
  ['a file of the manifest', manifestOf((m) => { m.files[0].note = 'x'; }), /MANIFEST\.json: files\[0\] carries "note"/],
  ['the manifest', manifestOf((m) => { m.note = 'x'; }), /MANIFEST\.json is not a version 2 manifest: it carries "note"/],
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
  /schemaVersion is 2, but MANIFEST\.json is not a version 2 manifest: it lacks files, ecosystems; it carries "corpus", "totalScanned"/);
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
plant('a generation time that is not a time', manifestOf((m) => { m.generatedAt = 'yesterday'; }), /MANIFEST\.json: generatedAt is "yesterday", not a time as toISOString\(\) writes it, or a date/);
plant('a time without its zone', manifestOf((m) => { m.generatedAt = '2026-09-30T13:00:00.000'; }), /MANIFEST\.json: generatedAt is "2026-09-30T13:00:00\.000", not a time as toISOString\(\) writes it, or a date/);
plant('a time without its milliseconds', manifestOf((m) => { m.generatedAt = '2026-09-30T13:00:00Z'; }), /MANIFEST\.json: generatedAt is "2026-09-30T13:00:00Z", not a time as toISOString\(\) writes it/);
plant('a time with an offset', scanOf('hex', (s) => { s.finishedAt = '2026-09-30T06:00:00.000+00:00'; }), /scan-results-hex\.json: finishedAt is "2026-09-30T06:00:00\.000\+00:00", not a time as toISOString\(\) writes it/);
plant('a time to the microsecond', scanOf('hex', (s) => { s.catalogCheck[0].checkedAt = '2026-09-30T00:30:00.000000Z'; }), /catalogCheck\[0\]\.checkedAt is "2026-09-30T00:30:00\.000000Z", not a time as toISOString\(\) writes it/);

test('a date where the source gives no time passes', async () => {
  const result = await validateOne(scanOf('hex', (s) => { s.catalogCheck[0].latestReleaseAt = '2026-01-15'; }));
  assert.equal(result.code, 0, result.stderr);
});
plant('another licence', manifestOf((m) => { m.license = 'CC0-1.0'; }), /MANIFEST\.json: license is "CC0-1\.0"/);
plant('a run that is not named', manifestOf((m) => { m.provenance.workflowRun = null; }), /MANIFEST\.json: provenance\.workflowRun is null\. A published dataset that cannot say which run/);
for (const check of CHECKS) {
  plant(`a check the generator found failing (${check})`, manifestOf((m) => { m.checks[check] = ['hex']; }),
    new RegExp(`MANIFEST\\.json: checks\\.${check} lists \\["hex"\\]\\. The generator found the dataset incomplete`));
}
plant('the checks without one of the five', manifestOf((m) => { delete m.checks.identityFailures; }), /MANIFEST\.json: checks is missing identityFailures/);
// A missing scan file and an unresolved share above the ceiling withhold a row; neither is a check, empty or not.
plant('a check for missing registries, which a manifest no longer carries', manifestOf((m) => { m.checks.missingEcosystems = []; }),
  /MANIFEST\.json: checks carries "missingEcosystems", which the schema version 2 contract does not define/);
plant('a check for rows above the ceiling, which a manifest no longer carries', manifestOf((m) => { m.checks.unresolvedAboveCeiling = []; }),
  /MANIFEST\.json: checks carries "unresolvedAboveCeiling", which the schema version 2 contract does not define/);
plant('a check that is not a list', manifestOf((m) => { m.checks.identityFailures = null; }), /MANIFEST\.json: checks\.identityFailures is null, not a list/);
plant('a manifest that carries a verdict of its own', manifestOf((m) => { m.complete = true; }), /MANIFEST\.json is not a version 2 manifest: it carries "complete"/);
plant('a plausible-minimum check, which a manifest no longer carries', manifestOf((m) => { m.checks.belowPlausibleMinimum = []; }), /MANIFEST\.json: checks carries "belowPlausibleMinimum"/);
plant('known issues that are not a list', manifestOf((m) => { m.knownIssues = {}; }), /MANIFEST\.json: knownIssues is \{\}, not a list/);

// The files the manifest lists, and the ones it does not.
const fileEntry = (m, file) => m.files.find((f) => f.file === file);
plant('a wrong hash', manifestOf((m) => { fileEntry(m, 'scan-results-hex.json').sha256 = '0'.repeat(64); }), /scan-results-hex\.json does not match its recorded hash/);
plant('a hash that is not one', manifestOf((m) => { fileEntry(m, 'scan-results-hex.json').sha256 = 'abc'; }), /files\[\d+\]\.sha256 is "abc", not a SHA-256 digest in lower-case hex/);
plant('a wrong size', manifestOf((m) => { fileEntry(m, 'listing-pub.tsv.gz').bytes += 1; }), /listing-pub\.tsv\.gz is \d+ bytes, manifest says \d+/);
plant('a size that is not a count', manifestOf((m) => { fileEntry(m, 'listing-pub.tsv.gz').bytes = '12'; }), /files\[\d+\]\.bytes is "12", not a size in bytes/);
plant('a stray file', {}, /present but not listed in MANIFEST\.json: "notes\.txt"\. An unlisted file/, (dir) => writeFileSync(join(datasetDir(dir), 'notes.txt'), 'notes\n'));
plant('a stray ledger', {}, /present but not listed in MANIFEST\.json: "listing-npm-old\.tsv\.gz"/, (dir) => writeFileSync(join(datasetDir(dir), 'listing-npm-old.tsv.gz'), gzipSync('x\n')));
plant('a first-shape scan file beside the new ones', {}, /present but not listed in MANIFEST\.json: "scan-results-npm-clean\.json"/,
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
plant('a registry with a ledger and no scan file', manifestOf((m) => { m.files = m.files.filter((f) => f.file !== 'scan-results-hex.json'); }),
  /MANIFEST\.json lists the listing ledger of hex and no scan file for it\. A scan file and its ledger are written together, so the two roles name the same registries/);
plant('a registry with a scan file and no ledger', manifestOf((m) => { m.files = m.files.filter((f) => f.file !== 'listing-hex.tsv.gz'); }),
  /MANIFEST\.json lists the scan file of hex and no listing ledger for it/);
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
  ['the catalogue snapshot', catalogOf((c) => { c.note = 'x'; }), /catalog-2026-09-30\.json carries "note"/],
  ['a catalogue entry', entryOf('npm', 'md5', (e) => { e.replacedBy = '@noble/hashes'; }), /entries\[\d+\] \(npm:md5\) carries "replacedBy"/],
  ['an entry\'s class evidence', entryOf('npm', 'md5', (e) => { e.classEvidence.note = 'x'; }), /\(npm:md5\): classEvidence carries "note"/],
  ['an entry\'s reason for being unclassified', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.note = 'x'; }), /unclassifiedReason carries "note"/],
  ['an entry\'s end-of-life review', entryOf('npm', 'md5', (e) => { e.endOfLifeReview.note = 'x'; }), /endOfLifeReview carries "note"/],
  ['an entry\'s multi-purpose record', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.note = 'x'; }), /multiPurpose carries "note"/],
  ['an entry\'s unmatchable record', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.note = 'x'; }), /unmatchable carries "note"/],
  ['an entry\'s registry-absent record', entryOf('npm', 'tripledes', (e) => { e.registryAbsent.extra = 'x'; }), /registryAbsent carries "extra"/],
  ['an alias', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].note = 'x'; }), /aliases\[0\] carries "note"/],
  ['an entry\'s last release', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.note = 'x'; }), /lastRelease carries "note"/],
  ['a raw scan file', scanOf('hex', (s) => { s.totalScanned = 1; }), /scan-results-hex\.json carries "totalScanned"/],
  ['the scanner record', scanOf('hex', (s) => { s.scanner.note = 'x'; }), /scan-results-hex\.json: scanner carries "note"/],
  ['the scan\'s catalogue record', scanOf('hex', (s) => { s.catalog.note = 'x'; }), /scan-results-hex\.json: catalog carries "note"/],
  ['the scan method', scanOf('hex', (s) => { s.method.note = 'x'; }), /scan-results-hex\.json: method carries "note"/],
  ['the enumeration', scanOf('hex', (s) => { s.enumeration.collected = 1; }), /scan-results-hex\.json: enumeration carries "collected"/],
  ['the sampling', scanOf('hex', (s) => { s.enumeration.sampling.size = 1; }), /enumeration\.sampling carries "size"/],
  ['the Go index window', scanOf('go', (s) => { s.enumeration.indexWindow.note = 'x'; }), /enumeration\.indexWindow carries "note"/],
  ['the scan coverage', scanOf('hex', (s) => { s.coverage.fetchErrors = 0; }), /scan-results-hex\.json: coverage carries "fetchErrors"/],
  ['the listing record', scanOf('hex', (s) => { s.listing.note = 'x'; }), /scan-results-hex\.json: listing carries "note"/],
  ['a registry check', scanOf('hex', (s) => { s.catalogCheck[0].note = 'x'; }), /catalogCheck\[0\] carries "note"/],
  ['a package record', scanOf('hex', (s) => { s.packages[0].posture = 'modern'; }), /packages\[0\] \(acme_hex\) carries "posture"/],
  ['a match record', scanOf('hex', (s) => { s.packages[0].matches[0].direct = true; }), /matches\[0\] carries "direct"/],
  ['a declaration', scanOf('hex', (s) => { s.packages[0].matches[0].declarations[0].tier = 'other'; }), /declarations\[0\] carries "tier"/],
];
for (const [level, change, problem] of closedInTheSnapshotAndScans) plant(`a field the contract does not define, in ${level}`, change, problem);

// Each object is closed: a field the contract does not define fails, at every level.
plant('a stored share in a scan file', scanOf('npm', (s) => { s.coverage.unresolvedShare = 0; }), /coverage carries "unresolvedShare", a stored share/);
plant('a missing field', scanOf('hex', (s) => { delete s.versionYears; }), /scan-results-hex\.json is missing versionYears\. Every field of a version 2 file is written out/);

// The catalogue snapshot: the entry's fields, and the states the contract makes impossible.
plant('a snapshot of another kind', catalogOf((c) => { c.kind = 'censusCorpus'; }), /catalog-2026-09-30\.json: kind is "censusCorpus", not "censusCatalog"/);
plant('a snapshot of another date', catalogOf((c) => { c.collectedAt = '2026-09-01'; }), /catalog-2026-09-30\.json: collectedAt is "2026-09-01", not the dataset's date/);
plant('a snapshot with no source commit', catalogOf((c) => { c.sourceCommit = null; }), /sourceCommit is null, not the commit/);
plant('a digest that is not one', catalogOf((c) => { c.classificationSha256 = 'PLACEHOLDER'; }), /classificationSha256 is "PLACEHOLDER", not a SHA-256 digest/);
plant('a registry with no match rule', catalogOf((c) => { delete c.matchRules.hex; }), /matchRules is missing hex/);
plant('a match rule that is not an id', catalogOf((c) => { c.matchRules.hex = 7; }), /catalog-2026-09-30\.json: matchRules\.hex is 7, not a rule id/);
plant('a match set digest that is not the entries\'', catalogOf((c) => { c.matchSetSha256 = sha256('another match set'); }),
  /catalog-2026-09-30\.json: matchSetSha256 is not the digest of the entries it covers/);
plant('a classification digest that is not the entries\'', catalogOf((c) => { c.classificationSha256 = sha256('another classification'); }),
  /catalog-2026-09-30\.json: classificationSha256 is not the digest of the entries it covers/);
plant('a re-tag that leaves the classification digest as it was', { catalogAfterDigests: (c) => {
  c.entries.find((e) => e.ecosystem === 'npm' && e.name === 'node-forge').multiPurpose = { version: '1.4.0', url: evidence('npm/node-forge/archive'), checkedAt: CHECKED };
} }, /catalog-2026-09-30\.json: classificationSha256 is not the digest of the entries it covers/);
plant('an alias added that leaves the match set digest as it was', { catalogAfterDigests: (c) => {
  c.entries.find((e) => e.ecosystem === 'npm' && e.name === 'md5').aliases.push(alias('md5-legacy'));
} }, /catalog-2026-09-30\.json: matchSetSha256 is not the digest of the entries it covers/);
plant('a match rule changed that leaves the match set digest as it was', { catalogAfterDigests: (c) => { c.matchRules.hex = 'hexName/2'; } },
  /catalog-2026-09-30\.json: matchSetSha256 is not the digest of the entries it covers/);
plant('a category the snapshot does not list', entryOf('npm', 'md5', (e) => { e.category = 'tls'; }), /\(npm:md5\): category is "tls", which is not one of the snapshot's categories/);
plant('categories that are not a list of names', catalogOf((c) => { c.categories = 'general'; }), /catalog-2026-09-30\.json: categories is "general", not the closed list of distinct categories/);
plant('a category listed twice', catalogOf((c) => { c.categories.push('general'); }), /catalog-2026-09-30\.json: categories is .*, not the closed list of distinct categories/);
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
plant('an evidence time that is not one', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.checkedAt = '2026-02-31'; }), /classEvidence\.checkedAt is "2026-02-31", not a time as toISOString\(\) writes it, a date or null/);
plant('further evidence that is not a list of URLs', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.additionalUrls = ['see above']; }), /classEvidence\.additionalUrls is \["see above"\], not a list of https URLs/);
plant('a page cited for a class read from the entry\'s own algorithms', entryOf('npm', 'md5', (e) => { e.classEvidence.url = evidence('npm/md5'); }), /classEvidence cites a limb, a page or a check time with basis entryAlgorithms/);
plant('an end-of-life signal with no limb', entryOf('npm', 'crypto-js', (e) => { e.classEvidence.limb = null; }), /classEvidence has basis endOfLifeSignal without a limb, a page and a check time/);
plant('a reason code that is not one', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.code = 'notCrypto'; }), /unclassifiedReason\.code is "notCrypto"/);
plant('a reason with no page', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.url = null; }), /unclassifiedReason\.url is null, not an https URL/);
plant('a reason with no time', entryOf('npm', '@types/bcryptjs', (e) => { e.unclassifiedReason.checkedAt = null; }), /unclassifiedReason\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('a review status that is not one', entryOf('npm', 'node-forge', (e) => { e.endOfLifeReview.status = 'maintained'; }), /endOfLifeReview\.status is "maintained"/);
plant('a review page that is not a URL', entryOf('npm', 'crypto-js', (e) => { e.endOfLifeReview.url = 'registry'; }), /endOfLifeReview\.url is "registry", not an https URL or null/);
plant('a review time that is not one', entryOf('npm', 'crypto-js', (e) => { e.endOfLifeReview.checkedAt = 'today'; }), /endOfLifeReview\.checkedAt is "today", not a time as toISOString\(\) writes it, a date or null/);
plant('an end-of-life review left out', entryOf('npm', 'md5', (e) => { e.endOfLifeReview = null; }), /endOfLifeReview is null, not an object/);
plant('a multi-purpose record with no version', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.version = ''; }), /multiPurpose\.version is "", not the version inspected/);
plant('a multi-purpose record with no page', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.url = null; }), /multiPurpose\.url is null, not an https URL/);
plant('a multi-purpose record with no time', entryOf('pypi', 'cryptography', (e) => { e.multiPurpose.checkedAt = null; }), /multiPurpose\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('an unmatchable reason that is not one', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.reason = 'vendored'; }), /unmatchable\.reason is "vendored"/);
plant('an unmatchable record with no page', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.url = null; }), /unmatchable\.url is null, not an https URL/);
plant('an unmatchable record with no time', entryOf('go', 'crypto/md5', (e) => { e.unmatchable.checkedAt = null; }), /unmatchable\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('an absence with no time', entryOf('npm', 'tripledes', (e) => { e.registryAbsent.checkedAt = null; }), /registryAbsent\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('an absence note that is not text', entryOf('npm', 'tripledes', (e) => { e.registryAbsent.note = 404; }), /registryAbsent\.note is 404, not text or null/);
plant('aliases that are not a list', entryOf('npm', 'md5', (e) => { e.aliases = null; }), /aliases is null, not a list/);
plant('an alias with no name', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].name = ''; }), /aliases\[0\]\.name is ""/);
plant('an alias with no page', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].url = null; }), /aliases\[0\]\.url is null, not an https URL/);
plant('an alias with no time', entryOf('go', 'golang.org/x/crypto', (e) => { e.aliases[0].checkedAt = null; }), /aliases\[0\]\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('a last release with no version', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.version = null; }), /lastRelease\.version is null, not a version/);
plant('a last release on a date that is not one', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.date = '2020-13-01'; }), /lastRelease\.date is "2020-13-01", not a YYYY-MM-DD date/);
plant('a last release with no time checked', entryOf('npm', 'crypto-js', (e) => { e.lastRelease.checkedAt = null; }), /lastRelease\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
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
plant('a scan with no start', scanOf('hex', (s) => { s.startedAt = null; }), /startedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('a scan with no instrument commit', scanOf('hex', (s) => { s.scanner.commit = null; }), /scanner\.commit is null\. A published scan names the instrument commit/);
plant('a scan with no script', scanOf('hex', (s) => { s.scanner.script = ''; }), /scanner\.script is ""/);
plant('a scan that names no run', scanOf('hex', (s) => { s.scanner.workflowRun = null; }), /scanner\.workflowRun is null\. A published scan names the workflow run that wrote it/);
plant('a scan without its run', scanOf('hex', (s) => { delete s.scanner.workflowRun; }), /scanner is missing workflowRun/);

/** A scan written by an earlier run, aggregated again by the run the manifest names: drawn, if it is a draw, with its own run's id. */
const writtenByRun = (eco, id) => scanOf(eco, (s) => {
  s.scanner.workflowRun = runUrl(id);
  if (s.enumeration.sampling.seed !== null) s.enumeration.sampling.seed = id;
});

test('a scan written by another run than the manifest names is listed, not refused', async () => {
  const result = await validateOne(writtenByRun('npm', '2'));
  assert.equal(result.code, 0, result.stderr);
  const listed = result.stdout.split('\n').filter((line) => line.startsWith(`  ${DATE}: `));
  assert.equal(listed.length, 1, result.stdout);
  assert.match(listed[0], /scan-results-npm\.json was written by the run https:\/\/github\.com\/opena2a-org\/crypto-census\/actions\/runs\/2, not by https:\/\/github\.com\/opena2a-org\/crypto-census\/actions\/runs\/1, the run MANIFEST\.json names/);
  assert.match(result.stdout, /^Recorded, not refused \(1\):$/m);
});

test('a dataset whose scans were all written by the run its manifest names lists nothing', async () => {
  const result = await validateOne();
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Recorded, not refused/);
});
plant('a source off the allowlist', scanOf('go', (s) => { s.sources.manifests = 'http://127.0.0.1:8080'; }),
  /sources\.manifests is "http:\/\/127\.0\.0\.1:8080", not https:\/\/proxy\.golang\.org, the base URL admitted for go\. Sources are compared as exact text/);
plant('a source that only begins with the admitted URL', scanOf('go', (s) => { s.sources.manifests = 'https://proxy.golang.org/cached-only'; }),
  /sources\.manifests is "https:\/\/proxy\.golang\.org\/cached-only", not https:\/\/proxy\.golang\.org, the base URL admitted for go/);
plant('a source written without the admitted trailing slash', scanOf('pypi', (s) => { s.sources.enumeration = 'https://pypi.org/simple'; }),
  /sources\.enumeration is "https:\/\/pypi\.org\/simple", not https:\/\/pypi\.org\/simple\/, the base URL admitted for pypi/);
plant('a source in another case', scanOf('npm', (s) => { s.sources.manifests = 'https://Registry.npmjs.org'; }), /sources\.manifests is "https:\/\/Registry\.npmjs\.org", not https:\/\/registry\.npmjs\.org/);
plant('a scan that leaves out a role the allowlist holds', scanOf('go', (s) => { delete s.sources.catalogCheck; }),
  /scan-results-go\.json: sources has no catalogCheck\. A scan of go names every base URL the allowlist holds for it/);
plant('a CocoaPods scan that leaves out where it read versions', scanOf('cocoapods', (s) => { delete s.sources.versions; }), /scan-results-cocoapods\.json: sources has no versions/);
plant('a scan that does not say where it enumerated', scanOf('hex', (s) => { delete s.sources.enumeration; }), /sources has no enumeration/);
plant('a source role the allowlist does not hold', scanOf('go', (s) => { s.sources.mirror = 'https://goproxy.example'; }),
  /sources names the role "mirror", which the allowlist for go does not hold \(it holds catalogCheck, enumeration, manifests\)/);
plant('a role the allowlist holds for another registry', scanOf('npm', (s) => { s.sources.versions = 'https://cdn.cocoapods.org'; }), /sources names the role "versions", which the allowlist for npm does not hold/);
plant('a source that is not text', scanOf('hex', (s) => { s.sources.manifests = ['https://hex.pm/api']; }), /sources\.manifests is \["https:\/\/hex\.pm\/api"\], not https:\/\/hex\.pm\/api/);
plant('sources that are not an object', scanOf('hex', (s) => { s.sources = 'https://hex.pm/api'; }), /sources is "https:\/\/hex\.pm\/api", not an object of base URLs/);
plant('a scan with no sources', scanOf('hex', (s) => { delete s.sources; }), /scan-results-hex\.json is missing sources/);

/** The allowlist literal of a script, read as text and parsed as JSON: nothing in the script is run. */
function allowlistIn(source, name) {
  const match = new RegExp(`\\nconst ${name} = \x60([^\x60]*)\x60;\\n`).exec(source);
  assert.ok(match, `no ${name} literal`);
  return JSON.parse(match[1]);
}
const digestOf = (value) => createHash('sha256').update(canonicalJson(value), 'utf-8').digest('hex');

test('the validator holds the admitted allowlist, read without running it', () => {
  const held = allowlistIn(readText(join(ROOT, 'scripts', 'validate-dataset.mjs')), 'ALLOWED_SOURCES_JSON');
  assert.equal(digestOf(held), ADMITTED_SOURCES_SHA256);
  assert.deepEqual(Object.keys(held).sort(), [...ECOSYSTEMS].sort());
});

test('these tests read from the admitted allowlist, read without running them', () => {
  assert.equal(digestOf(allowlistIn(readText(fileURLToPath(import.meta.url)), 'ADMITTED_SOURCES_JSON')), ADMITTED_SOURCES_SHA256);
  assert.equal(digestOf(ADMITTED_SOURCES), ADMITTED_SOURCES_SHA256);
});

test('the validator holds the population rule, read without running it', () => {
  const held = allowlistIn(readText(join(ROOT, 'scripts', 'validate-dataset.mjs')), 'POPULATION_RULE_JSON');
  assert.equal(digestOf(held), RULED_POPULATION_SHA256);
  assert.deepEqual(Object.keys(held).sort(), [...ECOSYSTEMS].sort());
  const allowed = allowlistIn(readText(join(ROOT, 'scripts', 'validate-dataset.mjs')), 'ALLOWED_SOURCES_JSON');
  for (const eco of ECOSYSTEMS) assert.equal(held[eco].source, allowed[eco].enumeration, eco);
});

test('these tests build every scan under the population rule, read without running them', () => {
  assert.equal(digestOf(allowlistIn(readText(fileURLToPath(import.meta.url)), 'RULED_POPULATION_JSON')), RULED_POPULATION_SHA256);
  assert.equal(digestOf(RULED_POPULATION), RULED_POPULATION_SHA256);
  assert.deepEqual(Object.keys(RULED_POPULATION).sort(), [...ECOSYSTEMS].sort());
  // Each frame is read from the base the allowlist admits for enumeration.
  for (const eco of ECOSYSTEMS) assert.equal(RULED_POPULATION[eco].source, ADMITTED_SOURCES[eco].enumeration, eco);
});

plant('a scan matched against another number of entries', scanOf('hex', (s) => { s.catalog.entries = 2; }), /catalog\.entries is 2, and the catalogue snapshot has 1 hex entries/);
plant('a scan matched against another set of names', scanOf('hex', (s) => { s.catalog.matchSetSha256 = sha256('other'); }), /catalog\.matchSetSha256 differs from the catalogue snapshot's/);
plant('a scan with another match rule', scanOf('hex', (s) => { s.catalog.matchRule = 'hexName/2'; }), /catalog\.matchRule is "hexName\/2", and the catalogue snapshot's rule for hex is "hexName\/1"/);
plant('a version selection that is not a code', scanOf('hex', (s) => { s.method.versionSelection = 'latest stable'; }), /method\.versionSelection is "latest stable", not a camelCase code/);
plant('a scan that reads from nowhere', scanOf('hex', (s) => { s.method.readFrom = []; }), /method\.readFrom is \[\], not a list of distinct camelCase codes with at least one/);
plant('a condition that is not a code', scanOf('go', (s) => { s.method.notObservableWhen = ['only a module line']; }), /method\.notObservableWhen is \["only a module line"\]/);
plant('limits listed twice', scanOf('maven', (s) => { s.method.limits = ['parentPomNotFollowed', 'parentPomNotFollowed']; }), /method\.limits is .*not a list of distinct camelCase codes/);
plant('a scan that does not record every kind', scanOf('npm', (s) => { s.method.declarationKinds = ['dependencies']; }), /method\.declarationKinds is \["dependencies"\]\. A scan of npm records every kind of the closed list/);
plant('a listed count that is not one', scanOf('hex', (s) => { s.enumeration.listed = -1; }), /scan-results-hex\.json: enumeration\.listed is -1, not a whole count/);
plant('a sample that does not name its size', scanOf('npm', (s) => { s.enumeration.requested = null; }), /scan-results-npm\.json: enumeration\.requested is null, not the size of the sample/);
plant('a sample of no packages', scanOf('npm', (s) => { s.enumeration.requested = 0; }), /scan-results-npm\.json: enumeration\.requested is 0, not the size of the sample\. A row that is not read whole names how many packages it asked for, and that is never 0/);
plant('a row read whole that names a size', scanOf('hex', (s) => { s.enumeration.requested = 1000; }), /scan-results-hex\.json: enumeration\.requested is 1000 for a row read whole; it is null then/);
plant('truncation that is not a yes or no', scanOf('hex', (s) => { s.enumeration.truncated = 'no'; }), /enumeration\.truncated is "no", not true or false/);
plant('a reason for a run that was not truncated', scanOf('hex', (s) => { s.enumeration.reason = 'budget'; }), /enumeration\.reason is "budget" for a run that was not truncated/);
plant('a truncated run that does not say why', scanOf('hex', (s) => { s.enumeration.truncated = true; }), /enumeration\.reason is null; a truncated run says why it stopped/);
plant('an enumeration with no unit', scanOf('hex', (s) => { s.enumeration.unit = ''; }), /enumeration\.unit is "", not the unit enumerated/);
plant('a budget that is not a number of minutes', scanOf('hex', (s) => { s.enumeration.budgetMinutes = -5; }), /enumeration\.budgetMinutes is -5, not a number of minutes or null/);
plant('an elapsed time left out', scanOf('hex', (s) => { s.enumeration.elapsedMinutes = null; }), /enumeration\.elapsedMinutes is null, not a number of minutes/);
plant('a frame size that is not a count', scanOf('hex', (s) => { s.enumeration.frameSize = 2.5; }), /enumeration\.frameSize is 2\.5, not a whole count or null/);
plant('a sampling method that is not one', scanOf('hex', (s) => { s.enumeration.sampling.method = 'random'; }), /enumeration\.sampling\.method is "random"/);
plant('a shuffled sample with no seed', scanOf('npm', (s) => { s.enumeration.sampling.seed = null; }), /enumeration\.sampling\.seed is null\. A shuffled sample names its seed/);
plant('a seed for a sample that shuffles nothing', scanOf('pub', (s) => {
  s.enumeration.requested = 1000;
  s.enumeration.sampling = { method: 'registryOrder', seed: 'abc', draw: 'package', pageRows: null };
}), /enumeration\.sampling\.seed is "abc" for registryOrder, which shuffles nothing/);
plant('a seed for a row read whole', scanOf('pub', (s) => { s.enumeration.sampling.seed = 'abc'; }), /enumeration\.sampling\.seed is "abc" for all, which shuffles nothing/);
plant('a registry read whole that names a draw', scanOf('hex', (s) => { s.enumeration.sampling.draw = 'package'; }), /enumeration\.sampling\.draw is "package", and a registry read whole draws nothing/);
plant('a sample that does not say what it drew', scanOf('npm', (s) => { s.enumeration.sampling.draw = null; }), /enumeration\.sampling\.draw is null, not package or page/);
plant('a draw by page with no page size', scanOf('maven', (s) => { s.enumeration.sampling.pageRows = null; }), /enumeration\.sampling\.pageRows is null; a draw by page says how many rows a page holds/);
plant('a page size for a draw that is not by page', scanOf('npm', (s) => { s.enumeration.sampling.pageRows = 10; }), /enumeration\.sampling\.pageRows is 10 for a draw that is not by page/);
plant('a Go index window that is not times', scanOf('go', (s) => { s.enumeration.indexWindow.until = 'later'; }), /enumeration\.indexWindow\.until is "later", not a time as toISOString\(\) writes it, or a date/);
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
plant('a check with no time', scanOf('hex', (s) => { s.catalogCheck[0].checkedAt = null; }), /catalogCheck\[0\]\.checkedAt is null, not a time as toISOString\(\) writes it, or a date/);
plant('a latest version that is not one', scanOf('hex', (s) => { s.catalogCheck[0].latestVersion = 1; }), /catalogCheck\[0\]\.latestVersion is 1, not a version or null/);
plant('a latest release that is not a time', scanOf('hex', (s) => { s.catalogCheck[0].latestReleaseAt = 'recent'; }), /catalogCheck\[0\]\.latestReleaseAt is "recent", not a time as toISOString\(\) writes it, a date or null/);
plant('a check of an alias that is not a name', scanOf('hex', (s) => { s.catalogCheck[0].alias = ''; }), /catalogCheck\[0\]\.alias is "", not a name or null/);
plant('a check that names no entry', scanOf('hex', (s) => { s.catalogCheck[0].entry = 7; }), /scan-results-hex\.json: catalogCheck\[0\]\.entry is 7/);
plant('a check of an entry the snapshot does not have', scanOf('hex', (s) => { s.catalogCheck.push({ ...s.catalogCheck[0], entry: 'other' }); }), /checks "other", which is not a hex entry of the catalogue snapshot/);
plant('a check of an alias the entry does not have', scanOf('go', (s) => { s.catalogCheck.push({ ...s.catalogCheck[1], alias: 'example.com/alias' }); }), /checks the alias "example\.com\/alias", which .* does not have/);
plant('an entry checked twice', scanOf('hex', (s) => { s.catalogCheck.push({ ...s.catalogCheck[0] }); }), /catalogCheck\[1\] checks "enacl" a second time/);
plant('an entry left unchecked', scanOf('hex', (s) => { s.catalogCheck = []; }), /catalogCheck has no row for enacl/);
plant('an alias left unchecked', scanOf('go', (s) => { s.catalogCheck = s.catalogCheck.filter((row) => row.alias === null); }), /catalogCheck has no row for github\.com\/square\/go-jose by its alias gopkg\.in\/square\/go-jose\.v2/);
plant('a check that finds absent an entry the tags say is present', scanOf('hex', (s) => { s.catalogCheck[0].status = 'absent'; }),
  /the scan's own registry check finds enacl "absent", and the catalogue snapshot does not tag it registryAbsent/);
plant('a check that finds present an entry the tags say is absent', scanOf('npm', (s) => { s.catalogCheck.find((row) => row.entry === 'tripledes').status = 'present'; }),
  /finds tripledes "present", and the catalogue snapshot tags it registryAbsent/);
plant('an unmatchable entry found on the registry', scanOf('go', (s) => { s.catalogCheck.find((row) => row.entry === 'crypto/md5').status = 'present'; }),
  /crypto\/md5 is tagged unmatchable, and the registry check finds it "present"/);
plant('an unmatchable entry left unresolved', scanOf('go', (s) => { s.catalogCheck.find((row) => row.entry === 'crypto/md5').status = 'unresolved'; }),
  /crypto\/md5 is tagged unmatchable, and the registry check finds it "unresolved"/);

test('an unmatchable entry the registry check finds absent passes', async () => {
  const result = await validateOne(scanOf('go', (s) => { Object.assign(s.catalogCheck.find((row) => row.entry === 'crypto/md5'), { status: 'absent', httpStatus: 404 }); }));
  assert.equal(result.code, 0, result.stderr);
});

test('an alias whose registry check is unresolved blocks nothing', async () => {
  const result = await validateOne(scanOf('go', (s) => { s.catalogCheck.find((row) => row.alias === 'gopkg.in/square/go-jose.v2').status = 'unresolved'; }));
  assert.equal(result.code, 0, result.stderr);
});
plant('an unresolved check of a classified entry', scanOf('hex', (s) => { s.catalogCheck[0].status = 'unresolved'; }), /the registry check of "enacl" is unresolved\. For a classified entry that leaves K unestablished/);

// Package records, matches and declarations.
plant('packages that are not a list', scanOf('hex', (s) => { s.packages = {}; }), /scan-results-hex\.json: packages is \{\}, not a list/);
plant('a package listed twice', scanOf('npm', (s) => { s.packages.push(structuredClone(s.packages[0])); s.packagesWithMatch += 1; }), /packages\[6\] \(@acme\/alpha\) is listed a second time/);
plant('a package with no name', scanOf('hex', (s) => { s.packages[0].name = ''; }), /packages\[0\]\.name is ""/);
plant('a package with no version', scanOf('hex', (s) => { s.packages[0].version = ''; }), /packages\[0\] \(acme_hex\)\.version is "", not the version read/);
plant('a package read from a source the method does not name', scanOf('hex', (s) => { s.packages[0].readFrom = 'mirror'; }), /\.readFrom is "mirror", not one of method\.readFrom/);
plant('a NuGet package without its groups', scanOf('nuget', (s) => { s.packages[0].manifest = null; }), /\.manifest is null; for nuget it is \{ dependencyGroups/);
plant('a CocoaPods package without its default subspecs', scanOf('cocoapods', (s) => { delete s.packages[0].manifest.defaultSubspecs; }), /\.manifest is .*; for cocoapods it is \{ subspecs/);

/** CocoaPods with AppKitX's direct match taken away: ZetaKit alone is direct, and the direct totals lose one unit. */
const appKitXNotDirect = (change) => ({
  fixture: (f) => {
    change(f.cocoapods.rows[0]);
    f.cocoapods.blocks = plain([2, 2, null, 2, null, null, null], 2, [1, 1, null, 1, null, null, null], 1);
  },
  totalTables: (t) => {
    t.cells.directUnconditional = { raw: [14, 6, 2, 4, 2, 1, 1], consolidated: [11, 6, 2, 4, 2, 1, 0] };
    t.stats.directUnconditional = [15, 12, 3];
  },
});

test('the values set for the Go module entry golang.org/x/crypto pass, as a multi-purpose library', async () => {
  // Its algorithms are its package entries', in catalogue order, deduplicated; its category is general; the
  // archive inspected is v0.57.0. It is matched by example.com/app/one (indirectly) and example.com/lib (directly).
  const result = await validateOne({
    fixture: (f) => {
      Object.assign(f.go.entries.find((e) => e.name === 'golang.org/x/crypto'), {
        algorithms: ['MD4', 'RIPEMD-160', 'RSA', 'DSA', 'CAST5', 'BN256', 'Blowfish', 'TEA', 'Salsa20', 'ChaCha20-Poly1305', 'X25519',
          'XSalsa20-Poly1305', 'Argon2id', 'bcrypt', 'scrypt', 'BLAKE2b', 'SSH', 'ACME', 'TLS'],
        category: 'general',
        multiPurpose: { version: 'v0.57.0', url: 'https://proxy.golang.org/golang.org/x/crypto/@v/v0.57.0.zip', checkedAt: '2026-10-06T17:59:20.568Z' },
      });
    },
    corpus: (c) => {
      c.multiPurposeLibraries.push({
        ecosystem: 'go', entry: 'golang.org/x/crypto', definitionId: 'census.table.multiPurposeLibrary/1',
        dependents: { anyManifestMatch: { raw: 2, consolidated: 2 }, directUnconditional: { raw: 1, consolidated: 1 } },
      });
    },
  });
  assert.equal(result.code, 0, result.stderr);
});

test('a CocoaPods dependency in a subspec nested under a default subspec is direct', async () => {
  const result = await validateOne({ fixture: (f) => { f.cocoapods.rows[0].matches[0].declarations[0].subspec = 'Core/Utils'; } });
  assert.equal(result.code, 0, result.stderr);
});

test('a CocoaPods dependency of a default subspec for one platform only is not direct', async () => {
  const result = await validateOne(appKitXNotDirect((row) => { row.matches[0].declarations[0].platform = 'ios'; }));
  assert.equal(result.code, 0, result.stderr);
});

test('a CocoaPods pod that names no default subspec counts none of its subspecs as direct', async () => {
  const result = await validateOne(appKitXNotDirect((row) => { row.manifest.defaultSubspecs = []; }));
  assert.equal(result.code, 0, result.stderr);
});

plant('a CocoaPods direct count that counts a dependency for one platform', { fixture: (f) => { f.cocoapods.rows[0].matches[0].declarations[0].platform = 'ios'; } },
  /byEcosystem\.cocoapods\.directUnconditional\.raw\.matched is \{"count":2,"k":2,"nullReason":null\}; recomputed from the files it is bound to, it is \{"count":1/);
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
  /coverage\.scannedByReadFrom gives 2 for "taggedRelease", and listing-packagist\.tsv\.gz gives 3/);
plant('a package whose ledger row records no match', ledgerOf('hex', (lines) => [lines[0], lines[1].replace(/\t1$/, '\t0')]), /acme_hex is in packages, and listing-hex\.tsv\.gz records no match for it/);
plant('a scan file with one match deleted', scanOf('npm', (s) => { s.packages[0].matches.pop(); }), /@acme\/alpha has 1 match record\(s\), and listing-npm\.tsv\.gz records 2/);
plant('a scan file with one matched package deleted', scanOf('npm', (s) => { s.packages.shift(); s.packagesWithMatch -= 1; }), /listing-npm\.tsv\.gz records 2 match\(es\) for @acme\/alpha, which scan-results-npm\.json does not list/);
plant('a package read at another version than the ledger says', scanOf('hex', (s) => { s.packages[0].version = '2.0.0'; }), /acme_hex was read at "2\.0\.0", and listing-hex\.tsv\.gz says 1\.0\.0/);
plant('a package read from another source than the ledger says', scanOf('packagist', (s) => { s.packages[0].readFrom = 'devDefaultBranch'; }), /acme\/api was read from "devDefaultBranch", and listing-packagist\.tsv\.gz says taggedRelease/);
plant('a row over the ceiling that the corpus publishes', { fixture: fillers(90, unread('kappa', 'unresolved', 'timeout')) },
  /npm: recomputed from scan-results-npm\.json and the population rule, the row is withheld for unresolvedShareAboveCeiling \(1 of 99 listed unresolved, above the ceiling of 1 in 100\), and corpus-2026-09-30\.json does not withhold it/);
plant('a deterministic non-read over the ceiling', { fixture: (f) => { f.hex.rows.push(unread('broken_pkg', 'unresolved', 'parseError')); } },
  /hex: recomputed from scan-results-hex\.json and the population rule, the row is withheld for unresolvedShareAboveCeiling \(1 of 2 listed unresolved, above the ceiling/);

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
  ['the consolidation map', mapOf((m) => { m.note = 'x'; }), /consolidation-2026-09-30\.json carries "note"/],
  ['a consolidation rule', mapOf((m) => { m.rules[0].note = 'x'; }), /rules\[0\] carries "note"/],
  ['a registry of the map', mapOf((m) => { m.byEcosystem.npm.note = 'x'; }), /byEcosystem\.npm carries "note"/],
  ['a merged unit', mapOf((m) => { m.byEcosystem.npm.units[0].note = 'x'; }), /byEcosystem\.npm\.units\[0\] carries "note"/],
  ['a removal', mapOf((m) => { m.byEcosystem.pub.removed = [{ name: 'acme_dart', rule: 'sharedNamespace', note: 'x' }]; }), /byEcosystem\.pub\.removed\[0\] carries "note"/],
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
plant('a map naming a registry that is not one', mapOf((m) => { m.byEcosystem.conda = { units: [], removed: [] }; }), /byEcosystem carries "conda", which is not one of the eleven registries/);
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

/**
 * The totals with one row withheld, written out by hand from the rows above.
 * RubyGems is one package matching rbnacl, so it leaves matched alone: one
 * fewer in every block, one less K, one unit fewer. PyPI leaves matched,
 * weak, brokenAlgorithm and deprecatedLibrary: [2, 2, 1, 1] in each any block
 * and [1, 0, 0, 0] in each direct one, K 3, 2, 1 and 1, units 2 and 1.
 */
const WITHHELD_TOTALS = {
  rubygems: (t) => {
    t.measurable.matched = ECOSYSTEMS.filter((eco) => eco !== 'rubygems');
    Object.assign(t.k, { matched: 22 });
    t.cells.anyManifestMatch = { raw: [19, 13, 4, 9, 3, 3, 0], consolidated: [14, 11, 3, 9, 3, 3, 0] };
    t.cells.directUnconditional = { raw: [14, 6, 2, 4, 2, 1, 1], consolidated: [11, 6, 2, 4, 2, 1, 0] };
    t.stats = { anyManifestMatch: [22, 17, 5], directUnconditional: [15, 12, 3] };
  },
  // Maven leaves matched, weak and deprecatedLibrary: [2, 1, 1] and [1, 1, 1] in the any blocks, [1, 1, 1] in each
  // direct one, K 2, 1 and 1, commons-codec's one unclassified match, and units 2 in and 1 out (any), 1 and 1 (direct).
  maven: (t) => {
    t.measurable.matched = ECOSYSTEMS.filter((eco) => eco !== 'maven');
    t.measurable.weak = ['npm', 'pypi', 'go', 'crates', 'packagist', 'nuget', 'cocoapods'];
    t.measurable.deprecatedLibrary = ['npm', 'pypi', 'go', 'crates', 'packagist', 'nuget', 'cocoapods'];
    Object.assign(t.k, { matched: 21, weak: 9, deprecatedLibrary: 7 });
    t.cells.anyManifestMatch = { raw: [18, 12, 4, 8, 3, 3, 0], consolidated: [14, 10, 3, 8, 3, 3, 0] };
    t.cells.directUnconditional = { raw: [14, 5, 2, 3, 2, 1, 1], consolidated: [11, 5, 2, 3, 2, 1, 0] };
    t.excluded.anyManifestMatch.excludedUnclassified = [[['npm', '@types/bcryptjs', 2], ['packagist', 'paragonie/random_compat', 1]], 2];
    t.excluded.anyManifestMatch.excludedNotCountable = [[['npm', 'tripledes', 1], ['go', 'crypto/md5', 0]], 1];
    t.excluded.directUnconditional.excludedUnclassified = [[['npm', '@types/bcryptjs', 1], ['packagist', 'paragonie/random_compat', 0]], 0];
    t.excluded.directUnconditional.excludedNotCountable = [[['npm', 'tripledes', 1], ['go', 'crypto/md5', 0]], 1];
    t.stats = { anyManifestMatch: [21, 17, 4], directUnconditional: [15, 12, 3] };
  },
  pypi: (t) => {
    t.measurable.matched = ECOSYSTEMS.filter((eco) => eco !== 'pypi');
    t.measurable.weak = ['npm', 'go', 'maven', 'crates', 'packagist', 'nuget', 'cocoapods'];
    t.measurable.brokenAlgorithm = ['npm'];
    t.measurable.deprecatedLibrary = ['npm', 'go', 'maven', 'crates', 'packagist', 'nuget', 'cocoapods'];
    Object.assign(t.k, { matched: 20, weak: 8, brokenAlgorithm: 1, deprecatedLibrary: 7 });
    t.cells.anyManifestMatch = { raw: [18, 11, 3, 8, 3, 3, 0], consolidated: [13, 9, 2, 8, 3, 3, 0] };
    t.cells.directUnconditional = { raw: [14, 6, 2, 4, 2, 1, 1], consolidated: [11, 6, 2, 4, 2, 1, 0] };
    t.stats = { anyManifestMatch: [21, 16, 5], directUnconditional: [15, 12, 3] };
  },
};

/**
 * A row read as a ranked head of its registry, as rows were before the
 * population rule: a size of 1,000 in the registry's own order. Not under the
 * rule, so its files withhold it for that.
 */
const readAsAHead = (eco) => ({ scans: (scans) => {
  scans[eco].enumeration.requested = 1000;
  scans[eco].enumeration.sampling = { method: 'registryOrder', seed: null, draw: 'package', pageRows: null };
} });

/**
 * One row withheld for the reasons given, with the totals and the rest of the
 * dataset as they then are. A row withheld as not under the rule is read as a
 * ranked head, so that its files give the reason.
 */
const withholding = (eco, reasons, extra = {}) => ({
  withhold: [{ ecosystem: eco, reasons }],
  totalTables: WITHHELD_TOTALS[eco],
  ...(reasons.some((r) => r.code === 'notUnderPopulationRule') ? readAsAHead(eco) : {}),
  ...extra,
});
const NOT_UNDER_RULE = [{ code: 'notUnderPopulationRule', detail: 'The row was not read under the population rule.' }];
const ABOVE_CEILING = [{ code: 'unresolvedShareAboveCeiling', detail: '1 of 2 listed unresolved.' }];
const oneUnresolvedGem = { fixture: (f) => { f.rubygems.rows.push(unread('acme-two', 'unresolved', 'timeout')); } };

const npmRaw = (c) => c.byEcosystem.npm.anyManifestMatch.raw;

test('a dataset in which no registry can measure post-quantum passes, with its post-quantum totals null', async () => {
  // Both countable post-quantum entries become absent from their registries: K for pqc drops to 0 in npm and
  // crates, every pqc and joint cell is null, and the matches to them leave every class for excludedNotCountable.
  const result = await validateOne({
    fixture: (f) => {
      for (const [eco, name] of [['npm', '@noble/post-quantum'], ['crates', 'pqcrypto']]) {
        f[eco].entries.find((e) => e.name === name).registryAbsent = { ...ABSENT };
        f[eco].measurability.matched.k -= 1;
        f[eco].measurability.matched.excluded.push({ entry: name, why: 'registryAbsent' });
        f[eco].measurability.pqc = measure(0, [], [[name, 'registryAbsent']]);
      }
      // npm: alpha and epsilon keep md5, so only zeta is in no class; under direct, epsilon's post-quantum is left out.
      f.npm.blocks = {
        anyManifestMatch: {
          raw: [[4, 4, 3, 1, null, null, null], { '@types/bcryptjs': 2 }, 1],
          consolidated: [[2, 2, 2, 1, null, null, null], { '@types/bcryptjs': 2 }, 1, [6, 4, 2]],
        },
        directUnconditional: {
          raw: [[3, 2, 2, 0, null, null, null], { '@types/bcryptjs': 1 }, 0],
          consolidated: [[2, 2, 2, 0, null, null, null], { '@types/bcryptjs': 1 }, 0, [4, 3, 1]],
        },
      };
      f.npm.notCountable = {
        anyManifestMatch: { raw: [{ '@noble/post-quantum': 2, tripledes: 1 }, 1], consolidated: [{ '@noble/post-quantum': 2, tripledes: 1 }, 1] },
        directUnconditional: { raw: [{ '@noble/post-quantum': 1, tripledes: 1 }, 1], consolidated: [{ '@noble/post-quantum': 1, tripledes: 1 }, 1] },
      };
      // crates: quantum-app keeps rust-crypto as a manifest match; its one direct match is the absent pqcrypto.
      f.crates.blocks = plain([1, 1, null, 1, null, null, null], 1, [0, 0, null, 0, null, null, null], 1);
      f.crates.notCountable = { anyManifestMatch: { raw: [{ pqcrypto: 1 }, 0], consolidated: [{ pqcrypto: 1 }, 0] },
        directUnconditional: { raw: [{ pqcrypto: 1 }, 1], consolidated: [{ pqcrypto: 1 }, 1] } };
    },
    totalTables: (t) => {
      Object.assign(t.measurable, { pqc: [], weakAndPqc: [], neitherWeakNorPqc: [] });
      Object.assign(t.k, { matched: 21, pqc: 0 });
      t.cells.anyManifestMatch = { raw: [20, 13, 4, 9, null, null, null], consolidated: [15, 11, 3, 9, null, null, null] };
      t.cells.directUnconditional = { raw: [14, 6, 2, 4, null, null, null], consolidated: [11, 6, 2, 4, null, null, null] };
      const notCountable = (npmPqc) => [['npm', '@noble/post-quantum', npmPqc], ['npm', 'tripledes', 1], ['go', 'crypto/md5', 0],
        ['maven', 'org.bouncycastle:bcpqc-jdk18on', 0], ['crates', 'pqcrypto', 1]];
      t.excluded.anyManifestMatch.excludedNotCountable = [notCountable(2), 1];
      t.excluded.directUnconditional.excludedNotCountable = [notCountable(1), 2];
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
plant('a stored share at the top of the corpus', corpusOf((c) => { c.weakShareOfCryptoUsing = 0.42; }), /carries "weakShareOfCryptoUsing", a stored share\. No share is stored/);
plant('a stored share in a figure block', corpusOf((c) => { npmRaw(c).pqcRate = 0.4; }), /anyManifestMatch\.raw carries "pqcRate", a stored share/);
plant('a share stored where a count goes', corpusOf((c) => { npmRaw(c).weak.count = 0.5; }), /anyManifestMatch\.raw\.weak\.count is 0\.5, not a whole count or null/);

// The consolidation map, and the rule it is held to.
plant('consolidated figures that are not what the consolidation map produces', corpusOf((c) => {
  // The go figures as if nothing were merged: each consistent with the others, none with the map.
  Object.assign(c.byEcosystem.go.anyManifestMatch.consolidated, { matched: { count: 3, k: 3, nullReason: null }, consolidation: { unitsIn: 3, unitsOut: 3, merged: 0, removedByRule: {} } });
}), /byEcosystem\.go\.anyManifestMatch\.consolidated\.matched is \{"count":3,"k":3,"nullReason":null\}; recomputed from the files it is bound to, it is \{"count":2/);

// The corpus: its own fields.
plant('a corpus of another kind', corpusOf((c) => { c.kind = 'corpus'; }), /corpus-2026-09-30\.json: kind is "corpus", not "censusCorpus"/);
plant('a corpus of another date', corpusOf((c) => { c.collectedAt = '2026-09-29'; }), /corpus-2026-09-30\.json: collectedAt is "2026-09-29", and the dataset is 2026-09-30/);
plant('a dataset dated before its last scan finished', scanOf('hex', (s) => { s.finishedAt = '2026-10-01T02:00:00.000Z'; }), /collectedAt is 2026-09-30, and the last scan finished on 2026-10-01/);
plant('a corpus with no generation time', corpusOf((c) => { c.generatedAt = null; }), /corpus-2026-09-30\.json: generatedAt is null, not a time as toISOString\(\) writes it, or a date/);
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
plant('a blocked row', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'coverageInvalid', detail: 'Above the ceiling.' }]; }), /blocked names "hex"\. A corpus that blocks a row is not published/);
plant('a blocked row for a reason no longer used', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'unresolvedShareAboveCeiling', detail: 'x' }]; }),
  /blocked\[0\]\.reason is "unresolvedShareAboveCeiling", not one of: coverageInvalid, catalogCheckMismatch, sourcesOffAllowlist/);
plant('a blocked row for a reason that is not one', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'tooSmall', detail: 'x' }]; }), /blocked\[0\]\.reason is "tooSmall"/);
plant('a blocked row for a registry that is not one', corpusOf((c) => { c.blocked = [{ ecosystem: 'conda', reason: 'coverageInvalid', detail: 'x' }]; }),
  /blocked\[0\]\.ecosystem is "conda", not one of the eleven registries/);
plant('a blocked row that does not say why', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'coverageInvalid', detail: null }]; }), /blocked\[0\]\.detail is null, not text/);
plant('a blocked row missing a field', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'coverageInvalid' }]; }), /blocked\[0\] is missing detail\. Every field of a version 2 file is written out/);
plant('a blocked row that is not an object', corpusOf((c) => { c.blocked = ['hex']; }), /blocked\[0\] is "hex", not an object/);
plant('blocked rows that are not a list', corpusOf((c) => { c.blocked = null; }), /corpus-2026-09-30\.json: blocked is null, not a list/);
plant('a registry\'s coverage that is not the raw file\'s', corpusOf((c) => { c.coverage.byEcosystem.hex.scanned += 1; }), /coverage\.byEcosystem\.hex is not the coverage, enumeration and sources of scan-results-hex\.json/);
plant('a registry\'s enumeration that is not the raw file\'s', corpusOf((c) => { c.coverage.byEcosystem.go.enumeration = { requested: 1000, listed: 6, truncated: false, reason: null }; }), /coverage\.byEcosystem\.go is not the coverage, enumeration and sources of scan-results-go\.json/);
plant('a registry\'s sources that are not the raw file\'s', corpusOf((c) => { c.coverage.byEcosystem.go.sources.manifests = 'https://mirror.example/go'; }),
  /coverage\.byEcosystem\.go is not the coverage, enumeration and sources of scan-results-go\.json/);
plant('a registry\'s coverage without its sources', corpusOf((c) => { delete c.coverage.byEcosystem.go.sources; }), /coverage\.byEcosystem\.go is missing sources/);
plant('a corpus that does not name its aggregator', corpusOf((c) => { delete c.aggregator; }), /corpus-2026-09-30\.json is missing aggregator/);
plant('an aggregation with no instrument commit', corpusOf((c) => { c.aggregator.commit = null; }), /aggregator\.commit is null\. A published corpus names the instrument commit its aggregation ran at/);
plant('an aggregation with no script', corpusOf((c) => { c.aggregator.script = ''; }), /aggregator\.script is ""/);
plant('a direct definition without the module that evaluates it', corpusOf((c) => { delete c.definitions.directUnconditional.code; }), /directUnconditional is missing code/);
plant('a direct definition whose module is not named', corpusOf((c) => { c.definitions.directUnconditional.code = null; }), /directUnconditional\.code is null, not the module that evaluates the rule/);
plant('coverage without dev metadata that repeats the unread counts', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.coverage.listed = 3; }),
  /packagist\.excludingDevMetadata\.coverage carries "listed"/);
plant('a coverage total that is not the sum of the rows', corpusOf((c) => { c.coverage.total.listed += 1; }), /coverage\.total\.listed is 37; the scan files of the 11 rows not withheld sum to 36/);
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
  ['matched', 'anyManifestMatch', { matched: 1, neitherWeakNorPqc: 1 }, 5],
  ['weak', 'directUnconditional', { weak: 1, brokenAlgorithm: 1, neitherWeakNorPqc: -1 }, 3],
  ['brokenAlgorithm', 'anyManifestMatch', { brokenAlgorithm: 1 }, 4],
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
plant('a total cell off by one', corpusOf((c) => { c.total.anyManifestMatch.raw.matched.count += 1; }), /total\.anyManifestMatch\.raw\.matched is \{"count":21.*recomputed/);
plant('a count where K is 0', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.pqc = { count: 0, k: 0, nullReason: null }; }), /go\.anyManifestMatch\.raw\.pqc is \{"count":0,"k":0,"nullReason":null\}: count must be null when k is 0/);
plant('null where K is not 0', corpusOf((c) => { c.byEcosystem.pypi.directUnconditional.raw.weak = { count: null, k: 2, nullReason: 'noCountableEntry' }; }), /pypi\.directUnconditional\.raw\.weak is .*: count is null while k is 2/);
plant('a null with no reason', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.pqc.nullReason = null; }), /go\.anyManifestMatch\.raw\.pqc is .*: nullReason says why count is null/);
plant('a reason with no null', corpusOf((c) => { npmRaw(c).weakAndPqc.nullReason = 'noCountableEntry'; }), /anyManifestMatch\.raw\.weakAndPqc is .*: nullReason says why count is null/);
plant('a null reason that is not one', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.pqc.nullReason = 'notMeasured'; }), /pqc\.nullReason is "notMeasured", not noCountableEntry, rowBlocked or null/);
plant('a K that is not a count', corpusOf((c) => { npmRaw(c).weak.k = null; }), /anyManifestMatch\.raw\.weak\.k is null, not a whole count/);
plant('a cell under another K', corpusOf((c) => { npmRaw(c).weak.k = 3; }), /anyManifestMatch\.raw\.weak is \{"count":4,"k":3,"nullReason":null\}; recomputed/);
plant('a block under another definition id', corpusOf((c) => { npmRaw(c).definitionId = 'census.match.anyManifest/1'; }), /anyManifestMatch\.raw\.definitionId is "census\.match\.anyManifest\/1", not census\.match\.anyManifest\/1\+census\.unit\.package\/1/);
plant('a block without its consolidation figures', corpusOf((c) => { delete c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation; }), /anyManifestMatch\.consolidated is missing consolidation/);
plant('a raw block with consolidation figures', corpusOf((c) => { npmRaw(c).consolidation = { unitsIn: 6, unitsOut: 6, merged: 0, removedByRule: {} }; }), /anyManifestMatch\.raw carries "consolidation"/);
plant('unclassified matches off by one', corpusOf((c) => { npmRaw(c).excludedUnclassified.matches += 1; }), /raw\.excludedUnclassified\.matches is 3; recomputed it is 2/);
plant('units with only unclassified matches off by one', corpusOf((c) => { npmRaw(c).excludedUnclassified.unitsWithOnlyUnclassifiedMatches = 2; }), /unitsWithOnlyUnclassifiedMatches is 2; recomputed it is 1/);
plant('an unclassified entry\'s count off by one', corpusOf((c) => { npmRaw(c).excludedUnclassified.byEntry[0].matches = 3; }), /raw\.excludedUnclassified\.byEntry is .*; recomputed it is .*It lists every unclassified entry/);
plant('an unclassified entry left out because nothing matched it', corpusOf((c) => { c.byEcosystem.packagist.directUnconditional.raw.excludedUnclassified.byEntry = []; }), /packagist\.directUnconditional\.raw\.excludedUnclassified\.byEntry is \[\]; recomputed it is/);
plant('consolidation figures off by one that still add up', corpusOf((c) => { Object.assign(c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation, { unitsIn: 7, unitsOut: 5 }); }),
  /consolidated\.consolidation\.unitsIn is 7; the consolidation map gives 6/);
plant('consolidation figures that do not add up', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.unitsIn = 7; }), /consolidated\.consolidation: unitsIn \(7\) is not unitsOut \+ merged \(6\)/);
plant('a removal counted where no rule removes a package', corpusOf((c) => { Object.assign(c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation, { removedByRule: { sharedNamespace: 1 }, merged: 1 }); }),
  /removedByRule is \{"sharedNamespace":1\}\. Under census\.unit\.consolidated\/1 no rule removes a package, so it is empty/);
plant('flags whose parts do not make the matched count', corpusOf((c) => { npmRaw(c).neitherWeakNorPqc.count = 1; }), /anyManifestMatch\.raw: matched \(4\) is not weak \(4\) \+ pqc \(2\) - weakAndPqc \(2\) \+ neitherWeakNorPqc \(1\)/);
plant('a corpus that counts a match no scan can observe', corpusOf((c) => {
  // As if zeta's match to tripledes, absent from the registry, put it in matched, weak and brokenAlgorithm.
  Object.assign(npmRaw(c), { matched: { count: 5, k: 4, nullReason: null }, weak: { count: 5, k: 2, nullReason: null }, brokenAlgorithm: { count: 4, k: 1, nullReason: null } });
  Object.assign(npmRaw(c).excludedNotCountable, { unitsWithOnlyNotCountableMatches: 0 });
}), /byEcosystem\.npm\.anyManifestMatch\.raw\.matched is \{"count":5,"k":4,"nullReason":null\}; recomputed/);
plant('matches no scan can observe off by one', corpusOf((c) => { npmRaw(c).excludedNotCountable.matches = 2; }), /raw\.excludedNotCountable\.matches is 2; recomputed it is 1/);
plant('matches no scan can observe that are not a count', corpusOf((c) => { npmRaw(c).excludedNotCountable.matches = 1.5; }), /raw\.excludedNotCountable\.matches is 1\.5, not a whole count/);
plant('units whose only matches no scan can observe off by one', corpusOf((c) => { npmRaw(c).excludedNotCountable.unitsWithOnlyNotCountableMatches = 2; }), /excludedNotCountable\.unitsWithOnlyNotCountableMatches is 2; recomputed it is 1/);
plant('an entry no scan can observe left out of its list', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.excludedNotCountable.byEntry = []; }),
  /go\.anyManifestMatch\.raw\.excludedNotCountable\.byEntry is \[\]; recomputed it is .*every classified and not countable entry/);
plant('a block without the matches it could not count', corpusOf((c) => { delete npmRaw(c).excludedNotCountable; }), /anyManifestMatch\.raw is missing excludedNotCountable/);
plant('a total whose five cells sum the same registries and do not add up', corpusOf((c) => {
  const total = c.total.anyManifestMatch.raw;
  const npmAndCrates = { measurableIn: ['npm', 'crates'], notMeasurableIn: ECOSYSTEMS.filter((eco) => !['npm', 'crates'].includes(eco)) };
  Object.assign(total.matched, { count: 5, ...npmAndCrates });
  Object.assign(total.weak, { count: 5, ...npmAndCrates });
  Object.assign(total.pqc, npmAndCrates);
  Object.assign(total.weakAndPqc, npmAndCrates);
  Object.assign(total.neitherWeakNorPqc, { count: 1, ...npmAndCrates });
}), /total\.anyManifestMatch\.raw: matched \(5\) is not weak \(5\) \+ pqc \(3\) - weakAndPqc \(3\) \+ neitherWeakNorPqc \(1\), and all five sum the same registries/);
plant('a total joint cell that does not name its registries', corpusOf((c) => { delete c.total.directUnconditional.raw.weakAndPqc.measurableIn; }), /total\.directUnconditional\.raw\.weakAndPqc is missing measurableIn/);
plant('a total joint cell that names the wrong registries', corpusOf((c) => {
  Object.assign(c.total.directUnconditional.raw.neitherWeakNorPqc, { measurableIn: ['npm'], notMeasurableIn: [...c.total.directUnconditional.raw.neitherWeakNorPqc.notMeasurableIn, 'crates'] });
}), /total\.directUnconditional\.raw\.neitherWeakNorPqc is .*recomputed/);
plant('a total entry that does not name its registry', corpusOf((c) => { delete c.total.anyManifestMatch.raw.excludedUnclassified.byEntry[0].ecosystem; }),
  /total\.anyManifestMatch\.raw\.excludedUnclassified\.byEntry\[0\] is missing ecosystem/);
plant('a total entry under another registry', corpusOf((c) => { c.total.anyManifestMatch.raw.excludedUnclassified.byEntry[0].ecosystem = 'pypi'; }),
  /total\.anyManifestMatch\.raw\.excludedUnclassified\.byEntry is .*recomputed/);
plant('weak outside its two classes', corpusOf((c) => { npmRaw(c).deprecatedLibrary.count = 0; }), /anyManifestMatch\.raw: weak \(4\) is not between the larger of brokenAlgorithm \(3\) and deprecatedLibrary \(0\) and their sum/);
plant('"neither" counted where post-quantum is not measurable', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.neitherWeakNorPqc = { count: 2, nullReason: null }; }), /go\.anyManifestMatch\.raw: weakAndPqc or neitherWeakNorPqc is counted while weak or pqc is not measurable/);
plant('more matched than packages read with observable dependencies', corpusOf((c) => { c.byEcosystem.go.anyManifestMatch.raw.matched.count = 5; }), /go\.anyManifestMatch\.raw: matched \(5\) is more than the 4 packages read whose dependencies could be observed/);
plant('a direct figure above the manifest-match one', corpusOf((c) => { c.byEcosystem.npm.directUnconditional.raw.deprecatedLibrary.count = 2; }),
  /byEcosystem\.npm: directUnconditional\.raw\.deprecatedLibrary \(2\) is more than anyManifestMatch\.raw\.deprecatedLibrary \(1\)/);
plant('figures without dev metadata for a registry that has none', corpusOf((c) => { c.byEcosystem.npm.excludingDevMetadata = c.byEcosystem.packagist.excludingDevMetadata; }), /byEcosystem\.npm\.excludingDevMetadata is .*\. It is kept for a registry read partly from dev metadata/);
plant('no figures without dev metadata for Packagist', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata = null; }), /byEcosystem\.packagist\.excludingDevMetadata is null, not an object/);
plant('coverage without dev metadata off by one', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.coverage.scanned = 3; }), /excludingDevMetadata\.coverage\.scanned is 3; the ledger gives 2 without the packages read from dev metadata/);
plant('coverage without dev metadata that is not a count', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.coverage.scanned = -1; }),
  /packagist\.excludingDevMetadata\.coverage\.scanned is -1, not a whole count/);
plant('a figure without dev metadata off by one', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.anyManifestMatch.raw.matched.count = 2; }), /packagist\.excludingDevMetadata\.anyManifestMatch\.raw\.matched is \{"count":2.*recomputed/);
plant('a total that names the wrong rows as measurable', corpusOf((c) => {
  Object.assign(c.total.directUnconditional.raw.pqc, { measurableIn: ['npm'], notMeasurableIn: [...c.total.directUnconditional.raw.pqc.notMeasurableIn, 'crates'] });
}), /total\.directUnconditional\.raw\.pqc is .*recomputed/);
plant('a total cell that leaves a registry out', corpusOf((c) => { c.total.anyManifestMatch.raw.weak.notMeasurableIn.pop(); }),
  /total\.anyManifestMatch\.raw\.weak: measurableIn, notMeasurableIn and the withheld rows do not name the eleven registries once each \(not named: pub\)/);
plant('a total cell that names a registry twice', corpusOf((c) => { c.total.anyManifestMatch.raw.pqc.notMeasurableIn.push('npm'); }),
  /total\.anyManifestMatch\.raw\.pqc: measurableIn, notMeasurableIn and the withheld rows do not name the eleven registries once each \(named twice: npm\)/);
plant('a total whose measurable rows are not registries', corpusOf((c) => { c.total.directUnconditional.raw.pqc.measurableIn = ['npm', 'npm']; }), /total\.directUnconditional\.raw\.pqc\.measurableIn is \["npm","npm"\], not a list of distinct registries/);
plant('a total that carries figures without dev metadata', corpusOf((c) => { c.total.excludingDevMetadata = null; }), /corpus-2026-09-30\.json: total carries "excludingDevMetadata"/);
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
plant('a manifest coverage that is not the files\'', manifestOf((m) => { m.coverage = { ...m.coverage, unresolved: 1 }; }), /MANIFEST\.json: coverage\.unresolved is 1; the scan files of the 11 rows not withheld sum to 0/);
plant('a manifest coverage count that is not a count', manifestOf((m) => { m.coverage = { ...m.coverage, absent: null }; }), /MANIFEST\.json: coverage\.absent is null, not a whole count/);
plant('a manifest registry whose sources are not the raw file\'s', manifestOf((m) => { m.ecosystems[2] = { ...m.ecosystems[2], sources: { ...m.ecosystems[2].sources, manifests: 'https://mirror.example/go' } }; }),
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
test('a later dataset marked comparable with an earlier one matched against another match set is refused', async () => {
  // One more alias in the earlier snapshot: its match set digest differs, and nothing else about its instrument does.
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, { fixture: (f) => { f.go.entries.find((e) => e.name === 'golang.org/x/crypto').aliases.push(alias('example.com/x/crypto')); } }],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2 }]],
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /2026-09-15 is marked comparable, and these differ between the two datasets: the match set\. Two datasets are comparable only when/, result.stderr);
});
test('a later dataset marked comparable with an earlier one read under other definition ids is refused', async () => {
  // The earlier corpus names a unit definition these rules do not know, which refuses it on its own; the comparison
  // reads the ids as written and refuses the later dataset too.
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, corpusOf((c) => { c.definitions.raw.id = 'census.unit.package/2'; })],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2 }]],
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, EARLIER_V2), /definitions\.raw\.id is "census\.unit\.package\/2", not census\.unit\.package\/1/, result.stderr);
  assert.match(firstProblem(result.stderr), /2026-09-15 is marked comparable, and these differ between the two datasets: the definition ids\. Two datasets are comparable only when/, result.stderr);
});
test('a later dataset that names what changed in the instrument passes', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, { scans: (s) => { s.npm.method.versionSelection = 'distTagLatest'; } }],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2, comparable: false, changes: ['versionSelection'] }]],
  });
  assert.equal(result.code, 0, result.stderr);
});

test('a change code these rules do not recompute may be named beside the others', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, { scans: (s) => { s.npm.method.versionSelection = 'distTagLatest'; } }],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2, comparable: false, changes: ['versionSelection', 'enumerationFrame'] }]],
  });
  assert.equal(result.code, 0, result.stderr);
});

for (const [what, earlierChange, changes, problem] of [
  ['changes that do not name what changed', { scans: (s) => { s.npm.method.versionSelection = 'distTagLatest'; } }, ['matchSet'],
    /comparability\[1\]\.changes is \["matchSet"\]; recomputed from the fields each code names, the two datasets differ in \["versionSelection"\]/],
  ['changes that name what did not change', { scans: (s) => { s.npm.method.versionSelection = 'distTagLatest'; } }, ['versionSelection', 'classification'],
    /comparability\[1\]\.changes is \["versionSelection","classification"\]; recomputed .* differ in \["versionSelection"\]/],
  ['a change named between two datasets whose instruments are the same', {}, ['matchRule'],
    /comparability\[1\]\.changes is \["matchRule"\]; recomputed from the fields each code names, the two datasets differ in \[\]/],
]) {
  test(`${what} are refused`, async () => {
    const result = await validate({
      [EARLIER_V2]: [EARLIER_V2, earlierChange],
      [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2, comparable: false, changes }]],
    });
    assert.equal(result.code, 1, result.stdout);
    assert.match(firstProblem(result.stderr), problem, result.stderr);
  });
}

test('a later dataset marked comparable with an earlier one that cannot be read is refused', async () => {
  const result = await validate({
    [EARLIER_V2]: [EARLIER_V2, {}],
    [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: EARLIER_V2, version: 2 }]],
  }, (dir) => unlinkSync(join(dir, 'datasets', EARLIER_V2, 'catalog-2026-09-15.json')));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /2026-09-15 is a version 2 dataset whose instrument cannot be read beside this one's/, result.stderr);
});
test('an earlier dataset whose manifest cannot be read is refused as a comparison', async () => {
  const result = await validate({ [DATE]: [DATE, {}, [{ dataset: FIRST_SHAPE, version: 1 }, { dataset: '2026-09-01', version: 1 }]] },
    (dir) => { mkdirSync(join(dir, 'datasets', '2026-09-01')); writeFileSync(join(dir, 'datasets', '2026-09-01', 'MANIFEST.json'), '{'); });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /comparability\[1\]: 2026-09-01 has no manifest these rules can read/, result.stderr);
});

// Each object is closed: a field the contract does not define fails, at every level.
const closedInTheCorpus = [
  ['a registry of the manifest', manifestOf((m) => { m.ecosystems[0].note = 'x'; }), /MANIFEST\.json: ecosystems\[0\] carries "note"/],
  ['a known issue', manifestOf((m) => { m.knownIssues = [{ ...knownIssue(), note: 'x' }]; }), /MANIFEST\.json: knownIssues\[0\] carries "note"/],
  ['the corpus', corpusOf((c) => { c.packagesScanned = 36; }), /corpus-2026-09-30\.json carries "packagesScanned"/],
  ['the inputs', corpusOf((c) => { c.inputs.note = 'x'; }), /corpus-2026-09-30\.json: inputs carries "note"/],
  ['an input scan', corpusOf((c) => { c.inputs.scans[0].note = 'x'; }), /inputs\.scans\[0\] carries "note"/],
  ['the input catalogue', corpusOf((c) => { c.inputs.catalog.note = 'x'; }), /inputs\.catalog carries "note"/],
  ['the input map', corpusOf((c) => { c.inputs.consolidation.note = 'x'; }), /inputs\.consolidation carries "note"/],
  ['the definitions', corpusOf((c) => { c.definitions.note = 'x'; }), /: definitions carries "note"/],
  ['a definition', corpusOf((c) => { c.definitions.raw.note = 'x'; }), /definitions\.raw carries "note"/],
  ['the manifest-match definition', corpusOf((c) => { c.definitions.anyManifestMatch.note = 'x'; }), /definitions\.anyManifestMatch carries "note"/],
  ['the direct definition', corpusOf((c) => { c.definitions.directUnconditional.note = 'x'; }), /definitions\.directUnconditional carries "note"/],
  ['the class ids', corpusOf((c) => { c.definitions.classes.modern = 'x'; }), /definitions\.classes carries "modern"/],
  ['a comparability record', corpusOf((c) => { c.comparability[0].note = 'x'; }), /comparability\[0\] carries "note"/],
  ['a blocked row', corpusOf((c) => { c.blocked = [{ ecosystem: 'hex', reason: 'sourcesOffAllowlist', detail: 'x', note: 'x' }]; }), /blocked\[0\] carries "note"/],
  ['the corpus coverage', corpusOf((c) => { c.coverage.note = 'x'; }), /corpus-2026-09-30\.json: coverage carries "note"/],
  ['the coverage total', corpusOf((c) => { c.coverage.total.withCrypto = 1; }), /coverage\.total carries "withCrypto"/],
  ['a registry\'s coverage', corpusOf((c) => { c.coverage.byEcosystem.hex.qc = 1; }), /coverage\.byEcosystem\.hex carries "qc"/],
  ['a registry\'s row', corpusOf((c) => { c.byEcosystem.hex.qc = {}; }), /byEcosystem\.hex carries "qc"/],
  ['the measurability', corpusOf((c) => { c.byEcosystem.hex.measurability.modern = {}; }), /measurability carries "modern"/],
  ['one class\'s measurability', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.note = 'x'; }), /measurability\.weak carries "note"/],
  ['an exclusion', corpusOf((c) => { c.byEcosystem.npm.measurability.weak.excluded[0].note = 'x'; }), /measurability\.weak\.excluded\[0\] carries "note"/],
  ['a figure block', corpusOf((c) => { npmRaw(c).modernOnly = { count: 1, k: 1, nullReason: null }; }), /anyManifestMatch\.raw carries "modernOnly"/],
  ['a pair of blocks', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.qc = {}; }), /byEcosystem\.npm\.anyManifestMatch carries "qc"/],
  ['a class cell', corpusOf((c) => { npmRaw(c).weak.note = 'x'; }), /anyManifestMatch\.raw\.weak carries "note"/],
  ['a joint cell', corpusOf((c) => { npmRaw(c).weakAndPqc.k = 2; }), /anyManifestMatch\.raw\.weakAndPqc carries "k"/],
  ['what was left out', corpusOf((c) => { npmRaw(c).excludedUnclassified.note = 'x'; }), /raw\.excludedUnclassified carries "note"/],
  ['an unclassified entry\'s count', corpusOf((c) => { npmRaw(c).excludedUnclassified.byEntry[0].ecosystem = 'npm'; }), /excludedUnclassified\.byEntry\[0\] carries "ecosystem"/],
  ['the consolidation figures', corpusOf((c) => { c.byEcosystem.npm.anyManifestMatch.consolidated.consolidation.note = 'x'; }), /consolidated\.consolidation carries "note"/],
  ['the figures without dev metadata', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.note = 'x'; }), /byEcosystem\.packagist\.excludingDevMetadata carries "note"/],
  ['the total', corpusOf((c) => { c.total.coverage = c.coverage.total; }), /corpus-2026-09-30\.json: total carries "coverage"/],
  ['a total cell', corpusOf((c) => { c.total.anyManifestMatch.raw.weak.note = 'x'; }), /total\.anyManifestMatch\.raw\.weak carries "note"/],
  ['a joint total cell', corpusOf((c) => { c.total.anyManifestMatch.raw.weakAndPqc.k = 2; }), /total\.anyManifestMatch\.raw\.weakAndPqc carries "k"/],
  ['what a block could not count', corpusOf((c) => { npmRaw(c).excludedNotCountable.note = 'x'; }), /raw\.excludedNotCountable carries "note"/],
  ['the coverage without dev metadata', corpusOf((c) => { c.byEcosystem.packagist.excludingDevMetadata.coverage.note = 1; }), /packagist\.excludingDevMetadata\.coverage carries "note"/],
  ['the dependents of a multi-purpose library', corpusOf((c) => { c.multiPurposeLibraries[0].dependents.note = 1; }), /multiPurposeLibraries\[0\]\.dependents carries "note"/],
  ['the coverage of the manifest', manifestOf((m) => { m.coverage.note = 1; }), /MANIFEST\.json: coverage carries "note"/],
  ['the aggregator', corpusOf((c) => { c.aggregator.note = 'x'; }), /corpus-2026-09-30\.json: aggregator carries "note"/],
  ['a withheld row', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].note = 'x'; })), /withheld\[0\] carries "note"/],
  ['a reason a row is withheld', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].reasons[0].note = 'x'; })), /withheld\[0\]\.reasons\[0\] carries "note"/],
  ['the coverage of a withheld row', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].coverage.note = 'x'; })), /withheld\[0\]\.coverage carries "note"/],
  ['a multi-purpose library', corpusOf((c) => { c.multiPurposeLibraries[0].total = 2; }), /multiPurposeLibraries\[0\] carries "total"/],
  ['its dependents', corpusOf((c) => { c.multiPurposeLibraries[0].dependents.anyManifestMatch.total = 2; }), /dependents\.anyManifestMatch carries "total"/],
];
for (const [level, change, problem] of closedInTheCorpus) plant(`a field the contract does not define, in ${level}`, change, problem);

test('five malformed rows are listed one by one, and a ledger with a sixth is refused there', async () => {
  const result = await validateOne(ledgerOf('npm', (lines) => lines.map((line, i) => (i === 0 ? line : line.replace(/^([^\t]+)\t[^\t]+\t/, '$1\tgone\t')))));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /listing-npm\.tsv\.gz: row 2 has the disposition "gone"/, result.stderr);
  assert.equal(result.stderr.split('\n').filter((line) => / listing-npm\.tsv\.gz: row \d+ has the disposition/.test(line)).length, 5, result.stderr);
  assert.match(result.stderr, /listing-npm\.tsv\.gz: row 7 is the sixth malformed row, so the ledger is refused and the rows after it are not read/);
  assert.doesNotMatch(result.stderr, /more row\(s\) are malformed/);
});

test('a ledger with exactly five malformed rows is read to its end', async () => {
  // Four rows at the top and the last row given a disposition that is not one; the rows between them are left as they
  // are. A ledger with a malformed row is not compared with its scan file, so nothing else is printed of it: the last
  // row listed is what shows the rows after the fourth were read, to the end.
  let last = 0;
  const result = await validateOne(ledgerOf('npm', (lines) => {
    last = lines.length;
    assert.ok(last > 7, 'well-formed rows lie between the fourth malformed row and the last');
    return lines.map((line, i) => ((i >= 1 && i <= 4) || i === last - 1 ? line.replace(/^([^\t]+)\t[^\t]+\t/, '$1\tgone\t') : line));
  }));
  assert.equal(result.code, 1, result.stdout);
  const listed = result.stderr.split('\n').filter((line) => / listing-npm\.tsv\.gz: row \d+ has the disposition/.test(line))
    .map((line) => Number(/ row (\d+) /.exec(line)[1]));
  assert.deepEqual(listed, [2, 3, 4, 5, last], result.stderr);
  assert.doesNotMatch(result.stderr, /is the sixth malformed row/);
});

// --- Withheld rows ---------------------------------------------------------------


test('a row withheld for a reason the population rule gives passes, and no total sums it', async () => {
  const result = await validateOne(withholding('rubygems', NOT_UNDER_RULE));
  assert.equal(result.code, 0, result.stderr);
});

test('a row above the ceiling, withheld for it, passes', async () => {
  const result = await validateOne(withholding('rubygems', ABOVE_CEILING, oneUnresolvedGem));
  assert.equal(result.code, 0, result.stderr);
});

test('a withheld row with a multi-purpose library publishes none of its dependents', async () => {
  const result = await validateOne(withholding('pypi', NOT_UNDER_RULE));
  assert.equal(result.code, 0, result.stderr);
});

plant('a withheld row whose figures are published', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.byEcosystem.rubygems = structuredClone(c.byEcosystem.hex); })),
  /byEcosystem\.rubygems is set; rubygems is withheld, so its row is null and none of its figures is published/);
// A withheld row and each of its reasons is a closed object: one with a field missing, or that is no object, is refused there.
plant('a withheld row missing a field', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { delete c.withheld[0].coverage; })),
  /withheld\[0\] is missing coverage\. Every field of a version 2 file is written out/);
plant('a withheld row that is not an object', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld = ['rubygems']; })),
  /withheld\[0\] is "rubygems", not an object/);
plant('a reason a row is withheld missing a field', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { delete c.withheld[0].reasons[0].detail; })),
  /withheld\[0\]\.reasons\[0\] is missing detail\. Every field of a version 2 file is written out/);
plant('a reason a row is withheld that is not an object', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].reasons = ['notUnderPopulationRule']; })),
  /withheld\[0\]\.reasons\[0\] is "notUnderPopulationRule", not an object/);
plant('a withheld row whose coverage is published', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.coverage.byEcosystem.rubygems = structuredClone(c.coverage.byEcosystem.hex); })),
  /coverage\.byEcosystem\.rubygems is \{.*; rubygems is withheld, so it is null/);
plant('a total that still sums a withheld row', { withhold: [{ ecosystem: 'rubygems', reasons: NOT_UNDER_RULE }], ...readAsAHead('rubygems') },
  /total\.anyManifestMatch\.raw\.matched: measurableIn, notMeasurableIn and the withheld rows do not name the eleven registries once each \(named twice: rubygems\)/);
plant('a coverage total that still counts a withheld row', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.coverage.total.listed += 1; c.coverage.total.scanned += 1; })),
  /coverage\.total\.listed is 36; the scan files of the 10 rows not withheld sum to 35/);
plant('a multi-purpose count published for a withheld row', withholding('pypi', NOT_UNDER_RULE, corpusOf((c) => { c.multiPurposeLibraries[0].dependents.anyManifestMatch.raw = 1; })),
  /multiPurposeLibraries\[0\]\.dependents\.anyManifestMatch\.raw is 1; pypi is withheld, so it is null/);
plant('a row withheld for a reason the aggregator does not give', withholding('rubygems', [{ code: 'tooSmall', detail: 'x' }]),
  /withheld\[0\]\.reasons\[0\]\.code is "tooSmall", not one of: noScanFile, listingNotWhole, notUnderPopulationRule, sampleNotDrawnToSize, seedNotRunId, unresolvedShareAboveCeiling/);
plant('a row withheld for no reason', withholding('rubygems', []), /withheld\[0\]\.reasons is \[\], not a list with a reason in it/);
plant('a reason that does not say what it found', withholding('rubygems', [{ code: 'notUnderPopulationRule', detail: '' }]), /withheld\[0\]\.reasons\[0\]\.detail is "", not text/);
plant('a row withheld twice', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld.push(structuredClone(c.withheld[0])); })),
  /withheld\[1\]\.ecosystem is "rubygems", not one of the eleven registries withheld once/);
plant('a registry withheld that is not one', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld.push({ ...structuredClone(c.withheld[0]), ecosystem: 'conda' }); })),
  /withheld\[1\]\.ecosystem is "conda", not one of the eleven registries withheld once/);
plant('a row withheld for having no scan file, beside its scan file', withholding('rubygems', [{ code: 'noScanFile', detail: 'x' }]),
  /withheld\[0\] withholds rubygems for noScanFile; recomputed from scan-results-rubygems\.json and the population rule, it is withheld for no reason\. Each reason is a verdict on the files/);
plant('a withheld row without its counts', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].coverage = null; })),
  /withheld\[0\]\.coverage is null\. It is null only for a row with no scan file/);
plant('a withheld row whose counts are not its scan file\'s', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].coverage.listed += 1; })),
  /withheld\[0\]\.coverage is not the coverage, enumeration and sources of scan-results-rubygems\.json/);
// A withheld row's coverage has the shape of the row's coverage.byEcosystem entry, so the codes can be read from it.
plant('a withheld row with its counts alone', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { delete c.withheld[0].coverage.enumeration; delete c.withheld[0].coverage.sources; })),
  /withheld\[0\]\.coverage is missing enumeration, sources/);
plant('a withheld row without its enumeration', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { delete c.withheld[0].coverage.enumeration; })),
  /withheld\[0\]\.coverage is missing enumeration\./);
plant('a withheld row without its sources', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { delete c.withheld[0].coverage.sources; })),
  /withheld\[0\]\.coverage is missing sources\./);
plant('a withheld row whose enumeration is not its scan file\'s', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].coverage.enumeration.elapsedMinutes = 2; })),
  /withheld\[0\]\.coverage is not the coverage, enumeration and sources of scan-results-rubygems\.json/);
plant('a withheld row whose sources are not its scan file\'s', withholding('rubygems', NOT_UNDER_RULE, corpusOf((c) => { c.withheld[0].coverage.sources.manifests = 'https://rubygems.org/api/v2/gems'; })),
  /withheld\[0\]\.coverage is not the coverage, enumeration and sources of scan-results-rubygems\.json/);
plant('a row withheld above the ceiling that is within it', withholding('rubygems', ABOVE_CEILING),
  /withheld\[0\] withholds rubygems for unresolvedShareAboveCeiling; recomputed from scan-results-rubygems\.json and the population rule, it is withheld for no reason/);
plant('withheld rows that are not a list', corpusOf((c) => { c.withheld = null; }), /corpus-2026-09-30\.json: withheld is null, not a list/);
// A row withheld is recorded once, in the corpus: listing it as a check as well refuses it.
plant('a withheld row listed as a check as well', withholding('rubygems', ABOVE_CEILING, { ...oneUnresolvedGem, ...manifestOf((m) => { m.checks.unresolvedAboveCeiling = ['rubygems']; }) }),
  /MANIFEST\.json: checks carries "unresolvedAboveCeiling", which the schema version 2 contract does not define/);

// --- Each withholding code, recomputed --------------------------------------------
//
// Every code is a verdict on the files: the validator recomputes all six from
// the scan file, its ledger and its own copy of the population rule, and the
// corpus must withhold exactly the rows, for exactly the codes, they give. The
// detail is words and is never compared. A row not read under the rule is
// withheld for that alone; the other three rule codes are asked of a row that
// was, and the ceiling of every row.

const reasonsFor = (...codes) => codes.map((code) => ({ code, detail: `Withheld for ${code}, in the aggregator's words.` }));
const enumerationOf = (eco, fn) => scanOf(eco, (s) => fn(s.enumeration));
const budget = (e) => { e.truncated = true; e.reason = 'budget'; };
/** Two changes as one: where both change a stage, both run, in order. */
const both = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => [key,
  typeof a[key] === 'function' && typeof b[key] === 'function' ? (x) => { a[key](x); b[key](x); } : (b[key] ?? a[key])]));

for (const [what, change] of [
  ['a listing row whose read stopped part way, withheld as not whole', withholding('rubygems', reasonsFor('listingNotWhole'), enumerationOf('rubygems', budget))],
  ['a listing row that listed fewer than its listing holds, withheld as not whole', withholding('rubygems', reasonsFor('listingNotWhole'), enumerationOf('rubygems', (e) => { e.frameSize += 1; }))],
  ['a page draw that read fewer pages than are due without being stopped, withheld for it', withholding('maven', reasonsFor('sampleNotDrawnToSize'), enumerationOf('maven', (e) => { e.frameSize = 600; }))],
  ['a draw seeded with another run\'s id, withheld for it', withholding('maven', reasonsFor('seedNotRunId'), enumerationOf('maven', (e) => { e.sampling.seed = '2'; }))],
  ['a page draw of pages the rule does not size, withheld as not under the rule', withholding('maven', NOT_UNDER_RULE, enumerationOf('maven', (e) => { e.sampling.pageRows = 20; }))],
  ['a row not under the rule and above the ceiling, withheld for both', withholding('rubygems', reasonsFor('notUnderPopulationRule', 'unresolvedShareAboveCeiling'), oneUnresolvedGem)],
  ['a listing row with no frame size, withheld as not under the rule alone', withholding('rubygems', NOT_UNDER_RULE, enumerationOf('rubygems', (e) => { e.frameSize = null; }))],
  ['a page draw a time budget stopped after two of three pages, published', enumerationOf('maven', (e) => { e.frameSize = 600; budget(e); })],
  ['a package draw a time budget stopped short of its size, published', enumerationOf('npm', (e) => { e.frameSize += 5; budget(e); })],
  ['a draw aggregated again by a later run, seeded with its own run\'s id, published', writtenByRun('maven', '2')],
]) {
  test(`${what} passes`, async () => {
    const result = await validateOne(change);
    assert.equal(result.code, 0, result.stderr);
  });
}

const notWithheld = (eco, code, why) => new RegExp(`${eco}: recomputed from scan-results-${eco}\\.json and the population rule, the row is withheld for ${code} \\(${why}`);
const POPULATION_FILLERS = { fixture: (f) => {
  f.maven.rows.find((row) => row.name === 'org.example:gone').page = 0;
  for (let i = 0; i < 200; i += 1) f.maven.rows.push({ ...unread(`org.filler:p${String(i).padStart(3, '0')}`, 'absent', 'http404'), page: 0 });
} };
// A row the files withhold, published.
plant('a draw seeded with something other than its run\'s id', enumerationOf('npm', (e) => { e.sampling.seed = 'example-seed'; }),
  notWithheld('npm', 'seedNotRunId', 'the seed is "example-seed", and the scan\'s run "https:\\/\\/github\\.com\\/opena2a-org\\/crypto-census\\/actions\\/runs\\/1" has the id 1\\)'));
plant('a draw whose run is not a run of the instrument', scanOf('npm', (s) => { s.scanner.workflowRun = 'https://ci.example/runs/1'; }),
  notWithheld('npm', 'seedNotRunId', 'the seed is "1", and the scan\'s run "https:\\/\\/ci\\.example\\/runs\\/1" is not a run of the instrument\\)'));
plant('a draw whose run names an attempt', scanOf('npm', (s) => { s.scanner.workflowRun = `${RUN_URL}/attempts/1`; }),
  notWithheld('npm', 'seedNotRunId', 'the seed is "1", .* is not a run of the instrument\\)'));
plant('a draw seeded with the id of the run that publishes it, not its own', scanOf('npm', (s) => { s.scanner.workflowRun = runUrl('2'); }),
  notWithheld('npm', 'seedNotRunId', 'the seed is "1", .* has the id 2\\)'));
plant('a draw of another size', enumerationOf('npm', (e) => { e.requested = 1000; }), notWithheld('npm', 'notUnderPopulationRule', 'requested is 1000, and the rule\'s is 385000\\)'));
plant('a package draw made by pages', enumerationOf('npm', (e) => { e.sampling.draw = 'page'; e.sampling.pageRows = 200; }),
  notWithheld('npm', 'notUnderPopulationRule', 'sampling\\.draw is "page", and the rule\'s is "package"; sampling\\.pageRows is 200, and the rule\'s is null\\)'));
plant('a draw ranked before it was shuffled', enumerationOf('go', (e) => { e.sampling.method = 'rankedThenSeededShuffle'; }),
  notWithheld('go', 'notUnderPopulationRule', 'sampling\\.method is "rankedThenSeededShuffle", and the rule\'s is "seededShuffle"\\)'));
plant('a registry read whole drawn as a sample', enumerationOf('hex', (e) => {
  e.requested = 385000;
  e.sampling = { method: 'seededShuffle', seed: RUN_ID, draw: 'package', pageRows: null };
}), notWithheld('hex', 'notUnderPopulationRule', 'sampling\\.method is "seededShuffle", and the rule\'s is "all"; requested is 385000, and the rule\'s is null; sampling\\.draw is "package", and the rule\'s is null; a row read whole carries the seed "1"\\)'));
plant('a listing with no frame size', enumerationOf('hex', (e) => { e.frameSize = null; }), notWithheld('hex', 'notUnderPopulationRule', 'frameSize is null, so the listing was not fetched whole\\)'));
plant('a listing whose read stopped part way', enumerationOf('hex', budget), notWithheld('hex', 'listingNotWhole', 'listed 1 of the 1 its listing holds, truncated\\)'));
plant('a listing that listed fewer than it holds', enumerationOf('hex', (e) => { e.frameSize += 1; }), notWithheld('hex', 'listingNotWhole', 'listed 1 of the 2 its listing holds\\)'));
plant('a package draw short of its size, not stopped', enumerationOf('npm', (e) => { e.frameSize += 1; }), notWithheld('npm', 'sampleNotDrawnToSize', 'listed 8 of 9 due\\)'));
plant('a package draw beyond its frame', enumerationOf('npm', (e) => { e.frameSize -= 1; }), notWithheld('npm', 'sampleNotDrawnToSize', 'listed 8 of 7 due\\)'));
plant('a package draw beyond its frame, stopped', enumerationOf('npm', (e) => { e.frameSize -= 1; budget(e); }), notWithheld('npm', 'sampleNotDrawnToSize', 'listed 8 of 7 due, truncated\\)'));
plant('a page draw that read more pages than are due', enumerationOf('maven', (e) => { e.frameSize = 200; }),
  notWithheld('maven', 'sampleNotDrawnToSize', 'read 2 page\\(s\\) of 200 rows, 1 due, and listed 4\\)'));
plant('a page draw that read more pages than are due, stopped', enumerationOf('maven', (e) => { e.frameSize = 200; budget(e); }),
  notWithheld('maven', 'sampleNotDrawnToSize', 'read 2 page\\(s\\) of 200 rows, 1 due, and listed 4, truncated\\)'));
plant('a page draw that lists more packages than its pages hold', both(POPULATION_FILLERS, enumerationOf('maven', (e) => { e.frameSize = 200; })),
  notWithheld('maven', 'sampleNotDrawnToSize', 'read 1 page\\(s\\) of 200 rows, 1 due, and listed 204\\)'));
// A code the files do not give, or one they give left out.
plant('a listing row withheld for its seed', withholding('rubygems', reasonsFor('seedNotRunId')),
  /withheld\[0\] withholds rubygems for seedNotRunId; recomputed from scan-results-rubygems\.json and the population rule, it is withheld for no reason/);
plant('a draw withheld for its seed, seeded with its run\'s id', withholding('maven', reasonsFor('seedNotRunId')),
  /withheld\[0\] withholds maven for seedNotRunId; recomputed from scan-results-maven\.json and the population rule, it is withheld for no reason/);
plant('a row withheld for one of the two reasons its files give', withholding('rubygems', NOT_UNDER_RULE, oneUnresolvedGem),
  /withheld\[0\] withholds rubygems for notUnderPopulationRule; recomputed .*, it is withheld for notUnderPopulationRule \(.*\), unresolvedShareAboveCeiling \(1 of 2 listed unresolved/);
plant('a row not under the rule withheld as not whole as well', withholding('rubygems', reasonsFor('notUnderPopulationRule', 'listingNotWhole'), enumerationOf('rubygems', (e) => { e.frameSize = null; })),
  /withheld\[0\] withholds rubygems for notUnderPopulationRule, listingNotWhole; recomputed .*, it is withheld for notUnderPopulationRule \(frameSize is null/);
plant('a reason given twice', withholding('rubygems', [...NOT_UNDER_RULE, ...NOT_UNDER_RULE]),
  /withheld\[0\]\.reasons\[1\]\.code gives notUnderPopulationRule a second time/);

// --- A registry with no scan file -----------------------------------------------
//
// The dataset holds one scan file and one ledger per registry the corpus read:
// eleven, less one per row withheld with noScanFile, and the registries with no
// scan file are exactly those rows.

/** A dataset without the scan file and ledger of one registry, the corpus withholding it for that, and its totals without it. */
const withoutScanFile = (eco, extra = {}) => ({ noScanFile: [eco], totalTables: WITHHELD_TOTALS[eco], ...extra });

for (const eco of ['rubygems', 'pypi']) {
  test(`a dataset without the scan file of ${eco}, which the corpus withholds for it, passes`, async () => {
    const result = await validateOne(withoutScanFile(eco), (dir) => {
      const names = readdirSync(datasetDir(dir));
      assert.equal(names.filter((name) => name.startsWith('scan-results-')).length, 10);
      assert.equal(names.filter((name) => name.startsWith('listing-')).length, 10);
    });
    assert.equal(result.code, 0, result.stderr);
  });
}

plant('a registry with no scan file that the corpus does not withhold', withoutScanFile('rubygems', corpusOf((c) => { c.withheld = []; })),
  /rubygems: the dataset holds no scan file of rubygems, and corpus-2026-09-30\.json does not withhold the row for noScanFile\. A registry is left out of a dataset only as a row withheld for having no scan file/);
plant('a registry with no scan file withheld for another reason', withoutScanFile('rubygems', corpusOf((c) => { c.withheld[0].reasons = structuredClone(NOT_UNDER_RULE); })),
  /withheld\[0\] withholds rubygems for notUnderPopulationRule; recomputed from the files, which hold no scan file of rubygems, it is withheld for noScanFile/);
plant('a row with no scan file that carries coverage', withoutScanFile('rubygems', corpusOf((c) => { c.withheld[0].coverage = structuredClone(c.coverage.byEcosystem.hex); })),
  /withheld\[0\]\.coverage is \{.*\. A row with no scan file has no coverage to copy, so it is null/);
plant('a corpus that binds a scan file the dataset does not hold', withoutScanFile('rubygems', corpusOf((c) => {
  c.inputs.scans.push({ ecosystem: 'rubygems', file: 'scan-results-rubygems.json', sha256: sha256('not here') });
})), /inputs\.scans\[10\] binds the scan file of rubygems, which the dataset does not hold/);
plant('a manifest item for a registry with no scan file', withoutScanFile('rubygems', manifestOf((m) => {
  m.ecosystems.push({ ecosystem: 'rubygems', coverage: structuredClone(m.ecosystems[0].coverage), enumeration: structuredClone(m.ecosystems[0].enumeration), sources: structuredClone(m.ecosystems[0].sources) });
})), /MANIFEST\.json: ecosystems\[10\] names rubygems, which has no scan file in files/);
plant('a map that merges packages of a registry with no scan file', withoutScanFile('rubygems', mapOf((m) => {
  m.byEcosystem.rubygems.units = [{ unit: 'acme', members: ['acme-gem', 'acme-gem-two'] }];
})), /byEcosystem\.rubygems\.units\[0\] names acme-gem, and the dataset holds no scan file of rubygems, so no package of it has a match to place/);
plant('a dataset dated before the last scan it holds finished', withoutScanFile('rubygems', scanOf('hex', (s) => { s.finishedAt = '2026-10-01T02:00:00.000Z'; })),
  /collectedAt is 2026-09-30, and the last scan finished on 2026-10-01/);
plant('a scan file left in the directory and out of the manifest', withoutScanFile('rubygems'),
  /present but not listed in MANIFEST\.json: "scan-results-rubygems\.json"/, (dir) => { writeFileSync(join(datasetDir(dir), 'scan-results-rubygems.json'), '{}\n'); });

// --- Errata for a version 2 dataset ----------------------------------------------

const ERRATA = `errata/${DATE}.json`;

/** An errata file for the dataset under test, with one issue and one regeneration, changed by `fn`. */
function errataFor(fn = () => {}) {
  const errata = {
    schemaVersion: 2,
    kind: 'censusErrata',
    dataset: DATE,
    doi: '10.5281/zenodo.0000000',
    issuedAt: '2026-10-01',
    issues: [{ ...knownIssue(), affects: ['byEcosystem.npm.anyManifestMatch.raw.weak.count'], issuedAt: '2026-10-01' }],
    regenerations: [{
      issuedAt: '2026-10-01',
      namedRun: RUN_URL,
      runOutputSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      writtenBy: [{ repository: 'example/census', pullRequest: 1, commit: COMMIT }],
      beforeSteps: { fields: ['coverage.scanned'], ecosystems: ['npm', 'hex'] },
      summary: 'The raw files were written again after the run.',
    }],
  };
  fn(errata);
  return `${JSON.stringify(errata, null, 2)}\n`;
}

const withErrata = (fn, change = {}) => validateOne(change, (dir) => {
  mkdirSync(join(dir, 'errata'));
  writeFileSync(join(dir, ERRATA), errataFor(fn));
});

test('an errata file for a version 2 dataset is read against the files its manifest lists, and passes', async () => {
  const result = await withErrata();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`1 errata file\\(s\\) validated: ${DATE}\\.json`));
});

for (const [what, fn, problem] of [
  ['an errata issue naming a figure the version 2 aggregate does not have',
    (e) => { e.issues[0].affects = ['byEcosystem.npm.weakExposed']; },
    /issue 1 \(example-issue\) affects byEcosystem\.npm\.weakExposed, which is not a field of the 2026-09-30 aggregate/],
  ['a regeneration naming a field a version 2 raw file does not have',
    (e) => { e.regenerations[0].beforeSteps.fields = ['summary.noCrypto']; },
    /regeneration 1 names summary\.noCrypto, which scan-results-npm\.json does not have/],
  ['a regeneration naming a run other than the version 2 manifest\'s',
    (e) => { e.regenerations[0].namedRun = runUrl('2'); },
    /regeneration 1 names the run https:\/\/github\.com\/opena2a-org\/crypto-census\/actions\/runs\/2, and datasets\/2026-09-30\/MANIFEST\.json names "https:\/\/github\.com\/opena2a-org\/crypto-census\/actions\/runs\/1"/],
]) {
  test(`${what} is refused`, async () => {
    const result = await withErrata(fn);
    assert.equal(result.code, 1, result.stdout);
    assert.match(firstProblem(result.stderr, ERRATA), problem, result.stderr);
  });
}

test('an errata file whose dataset lists no aggregate cannot be checked against it, and says so', async () => {
  const result = await withErrata(undefined, manifestOf((m) => { m.files = m.files.filter((f) => f.role !== 'corpus'); }));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, ERRATA), /cannot be checked against datasets\/2026-09-30: its aggregate could not be read/, result.stderr);
});

test('an errata file whose dataset manifest is a link to a device is answered without reading it', { timeout: 30000 }, async () => {
  const result = await validateOne({}, (dir) => {
    mkdirSync(join(dir, 'errata'));
    writeFileSync(join(dir, ERRATA), errataFor());
    const path = join(datasetDir(dir), 'MANIFEST.json');
    unlinkSync(path);
    symlinkSync('/dev/zero', path);
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, ERRATA), /cannot be checked against datasets\/2026-09-30: its aggregate could not be read/, result.stderr);
});

test('past forty figures that differ from their recomputed values, the rest are counted, not listed', async () => {
  const result = await validateOne(corpusOf((c) => {
    for (const eco of ECOSYSTEMS) {
      for (const definition of DEFINITIONS) for (const unit of UNITS) c.byEcosystem[eco][definition][unit].matched.k += 1;
    }
  }));
  assert.equal(result.code, 1, result.stdout);
  const listed = result.stderr.split('\n').filter((line) => line.startsWith(`  ${DATE}: `));
  assert.match(listed[0], /byEcosystem\.npm\.anyManifestMatch\.raw\.matched is \{"count":4,"k":5,"nullReason":null\}; recomputed/, result.stderr);
  assert.equal(listed.filter((line) => /; recomputed /.test(line)).length, 40, result.stderr);
  assert.match(listed.at(-1), /corpus-2026-09-30\.json: 4 more figure\(s\) differ from their recomputed values/, result.stderr);
});

/** Make the copy of the validator throw where `at` begins, as a check that fails part way would. */
const throwAt = (at) => (dir) => {
  const path = join(dir, 'scripts', 'validate-dataset.mjs');
  const source = readText(path);
  if (source.split(at).length !== 2) throw new Error(`the validator no longer holds ${at}`);
  writeFileSync(path, source.replace(at, `${at}\n  throw new Error('stopped here');`));
};

test('a check that stops part way is reported, and the problems found before it are still listed', async () => {
  const result = await validateOne(scanOf('hex', (s) => { s.catalogCheck[0].status = 'ok'; }), throwAt('function checkCorpus(name, record, ctx, bad) {'));
  assert.equal(result.code, 1, result.stdout);
  const listed = result.stderr.split('\n').filter((line) => line.startsWith(`  ${DATE}: `));
  assert.match(listed[0], /catalogCheck\[0\]\.status is "ok"/, result.stderr);
  assert.match(listed.at(-1), /2026-09-30: could not be checked to the end: stopped here/, result.stderr);
});

test('an errata check that stops part way is reported for its file, and the run goes on', async () => {
  const result = await validateOne({}, (dir) => {
    throwAt('function validateRegenerations(label, date, list, manifest) {')(dir);
    mkdirSync(join(dir, 'errata'));
    writeFileSync(join(dir, ERRATA), errataFor());
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr, ERRATA), /could not be checked to the end: stopped here/, result.stderr);
  assert.match(result.stderr, /^1 problem\(s\) across 2 dataset\(s\) and 1 errata file\(s\):$/m, result.stderr);
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

// The nesting is counted on the text as JSON reads it: a quote after a backslash is inside its string, and a bracket
// inside a string opens or closes nothing. A deep list after a string holding an escaped quote, or after a string of
// closing brackets, is refused; a string of opening brackets nests nothing.
const manifestText = (text) => (dir) => writeFileSync(join(datasetDir(dir), 'MANIFEST.json'), text);
plant('a manifest nested 40 deep after a string holding an escaped quote', {}, /MANIFEST\.json nests values more than 32 deep/,
  manifestText(`{"schemaVersion":2,"a":"\\"","x":${deep(40)}}`));
plant('a manifest nested 40 deep after a string of twenty ]', {}, /MANIFEST\.json nests values more than 32 deep/,
  manifestText(`{"schemaVersion":2,"a":"${']'.repeat(20)}","x":${deep(40)}}`));
test('a flat manifest whose string holds forty [ is not refused for its nesting', async () => {
  const result = await validateOne({}, manifestText(`{"schemaVersion":2,"a":"${'['.repeat(40)}"}`));
  assert.equal(result.code, 1, result.stdout);
  assert.match(firstProblem(result.stderr), /MANIFEST\.json is not a version 2 manifest: it lacks dataset, /, result.stderr);
  assert.doesNotMatch(result.stderr, /nests values more than/, result.stderr);
});

// A file wide rather than deep: the largest scan file allowed, holding one list of empty objects, about thirty
// million values. The depth check walks it within the default heap, and the file is then refused as any other.
test('a listed file of 95,000,000 bytes holding thirty million values is refused with a problem list, within the default heap', { timeout: 180000 }, async () => {
  const result = await validateOne({}, (dir) => {
    const head = '{"schemaVersion":2,"kind":"censusScan","x":[';
    const tail = ']}\n';
    const count = Math.floor((95_000_000 - head.length - tail.length + 1) / 3);
    rehash('scan-results-hex.json', `${head}${'{},'.repeat(count - 1)}{}${tail}`)(dir);
  });
  assert.equal(result.code, 1, `exit ${result.code}, signal ${result.signal}:\n${result.stdout}${result.stderr.slice(-1500)}`);
  assert.match(firstProblem(result.stderr), /scan-results-hex\.json carries "x", which the schema version 2 contract does not define/, result.stderr);
  assert.doesNotMatch(result.stderr, /heap out of memory|could not be checked to the end/);
});

// The deepest manifest the size bound lets through: `{"schemaVersion":2,"x":`, 47,499,988 `[` and as many `]`, and
// `}`, 95,000,000 bytes in all. Its nesting is counted on its text before anything parses it, so it is refused at the
// 33rd `[`, with a problem list, within a heap of 2 GB; parsed, and parsed a second time, it exhausted the heap.
test('a manifest of 95,000,000 bytes nested 47,499,988 deep is refused with a problem list, within a heap of 2 GB', { timeout: 180000 }, async () => {
  const head = '{"schemaVersion":2,"x":';
  const depth = (95_000_000 - head.length - 1) / 2;
  assert.equal(depth, 47_499_988);
  const result = await validateOne({}, (dir) => writeFileSync(join(datasetDir(dir), 'MANIFEST.json'), `${head}${'['.repeat(depth)}${']'.repeat(depth)}}`),
    { env: { NODE_OPTIONS: '--max-old-space-size=2048' } });
  assert.equal(result.code, 1, `exit ${result.code}, signal ${result.signal}:\n${result.stdout}${result.stderr.slice(-1500)}`);
  assert.match(firstProblem(result.stderr), /MANIFEST\.json nests values more than 32 deep/, result.stderr);
  assert.doesNotMatch(result.stderr, /heap out of memory|could not be checked to the end/);
});

// A manifest as wide as the largest scan file, about thirty million empty objects: within the nesting bound, so it is
// parsed, once. The version 2 rules read the value validate() parsed. On one machine one parse ran out of a heap of
// 1,792 MB and fitted in 1,920 MB, and two parses ran out of 3,584 MB, so a bound of 2,816 MB sits between them.
test('a manifest of 95,000,000 bytes holding thirty million values is parsed once and refused with a problem list, within a heap of 2,816 MB', { timeout: 180000 }, async () => {
  const result = await validateOne({}, (dir) => {
    const head = '{"schemaVersion":2,"x":[';
    const tail = ']}';
    const count = Math.floor((95_000_000 - head.length - tail.length + 1) / 3);
    writeFileSync(join(datasetDir(dir), 'MANIFEST.json'), `${head}${'{},'.repeat(count - 1)}{}${tail}`);
  }, { env: { NODE_OPTIONS: '--max-old-space-size=2816' } });
  assert.equal(result.code, 1, `exit ${result.code}, signal ${result.signal}:\n${result.stdout}${result.stderr.slice(-1500)}`);
  assert.match(firstProblem(result.stderr), /MANIFEST\.json is not a version 2 manifest: it lacks dataset, /, result.stderr);
  assert.doesNotMatch(result.stderr, /heap out of memory|could not be checked to the end/);
});

// A ledger of a thousand million empty rows: a valid header, then 10^9 newlines, about a megabyte of gzip written
// as members of a million newlines each. It is refused at its sixth row, so the run ends in seconds; a run that
// read every row would take minutes and is killed by the timeout here, which leaves it no exit code.
test('a ledger of a thousand million empty rows is refused at its sixth row, within a minute', { timeout: 120000 }, async () => {
  const member = gzipSync(Buffer.alloc(1_000_000, 10));
  const result = await validateOne({ ledgers: (l) => { l.hex = Buffer.concat([gzipSync(`${l.hex[0]}\n`), ...Array(1000).fill(member)]); } },
    undefined, { timeout: 60_000 });
  assert.equal(result.code, 1, `exit ${result.code}, signal ${result.signal}:\n${result.stdout}${result.stderr.slice(-1500)}`);
  assert.match(firstProblem(result.stderr), /listing-hex\.tsv\.gz: row 2 has 1 columns/, result.stderr);
  assert.match(result.stderr, /listing-hex\.tsv\.gz: row 7 is the sixth malformed row, so the ledger is refused and the rows after it are not read/, result.stderr);
});

// One entry with a hundred thousand aliases, every alias checked by the scan's own registry check and every alias
// matched in one manifest. Each alias is looked up in the snapshot's alias map, so the run grows with the aliases,
// not with their square: it passes in seconds, and a run that compared each alias with every other is killed by the
// timeout here.
test('a hundred thousand aliases of one entry, each checked and each matched, pass within half a minute', { timeout: 120000 }, async () => {
  const result = await validateOne({ fixture: (f) => {
    const e = f.go.entries.find((x) => x.name === 'golang.org/x/crypto');
    const row = f.go.rows.find((x) => x.name === 'example.com/lib');
    for (let i = 0; i < 100_000; i += 1) {
      const name = `example.com/alias-${String(i).padStart(6, '0')}`;
      e.aliases.push(alias(name));
      // One entry matched through every alias in one manifest: records of one entry, which count once.
      row.matches.push(matchAs(name, e.name, 'alias', go(false)));
    }
  } }, undefined, { timeout: 30_000 });
  assert.equal(result.code, 0, `exit ${result.code}, signal ${result.signal}:\n${result.stderr.slice(-1500)}`);
});

// An alias that collides is refused once, by the snapshot's own rule. Every alias is still kept with every entry that
// gives it, so a check or a match by an alias its entry has is not refused a second time as one the entry lacks.
const aliasOfGo = (aliasName, owners) => ({ fixture: (f) => {
  for (const owner of owners) {
    const e = f.go.entries.find((x) => x.name === owner);
    e.aliases.push(alias(aliasName));
    e.aliases.sort((a, b) => byteOrder(a.name, b.name));
  }
  // A match by the alias, of the last entry that gives it, in a manifest that matches that entry already.
  f.go.rows.find((x) => x.name === 'example.com/lib').matches.push(matchAs(aliasName, owners.at(-1), 'alias', go(false)));
} });
for (const [what, change, refused] of [
  ['an alias that is also the name of an entry', aliasOfGo('github.com/cloudflare/circl', ['golang.org/x/crypto']),
    /go:golang\.org\/x\/crypto has the alias github\.com\/cloudflare\/circl, which is also the name of an entry/],
  ['an alias given to two entries', aliasOfGo('example.com/shared', ['github.com/square/go-jose', 'golang.org/x/crypto']),
    /the alias example\.com\/shared belongs to both github\.com\/square\/go-jose and golang\.org\/x\/crypto in go/],
]) {
  test(`${what} is refused once, and a check or a match by it is not refused again`, async () => {
    const result = await validateOne(change);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, refused, result.stderr);
    assert.doesNotMatch(result.stderr, /does not have in the catalogue snapshot|is not an alias of/, result.stderr);
  });
}

// A read source named `__proto__`: the ledger counts its rows as any other source's, and the count is read as the
// ledger's own, never from the prototype of an object.
test('a read source named __proto__ is counted from the ledger like any other', async () => {
  const result = await validateOne({ fixture: (f) => { f.hex.method.readFrom = ['__proto__']; } });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /scan-results-hex\.json: method\.readFrom is \["__proto__"\]/, result.stderr);
  assert.doesNotMatch(result.stderr, /\[object Object\]|scannedByReadFrom gives \d+ for "__proto__"/, result.stderr);
});

// --- The stop line ----------------------------------------------------------------
//
// The GitHub runner (actions/runner v2.338.0) reads a line of a step's stdout or stderr as a workflow command when the
// line, its leading whitespace trimmed, begins `::` and a registered command name and has a `::` after it
// (src/Runner.Common/ActionCommand.cs:62-90), or when it holds `##[` anywhere, a registered name and `]` after it
// (:132-157); it tries both forms on every line of both streams (src/Runner.Worker/ActionCommandManager.cs:70-71). From
// `::stop-commands::<token>` on, it acts on no command until a line is `::<token>::` (:86-103). The validator writes
// that line first on both streams and the token on no later line, so whatever a dataset puts into its output is read
// after the stop line, and nothing resumes commands. Indenting a line stops nothing, and these cells show the runner's
// grammar still occurs after it.

/** The names the runner registers by default: stop-commands and its command extensions but internal-set-repo-path (ActionCommandManager.cs:34-45). */
const RUNNER_COMMANDS = ['stop-commands', 'set-env', 'set-output', 'save-state', 'add-mask', 'add-path', 'add-matcher', 'remove-matcher',
  'debug', 'warning', 'error', 'notice', 'group', 'endgroup', 'echo'];

/** Whether the runner, acting on commands, would read a line as one: names compared without case, `##[` taken anywhere. */
const readsAsCommand = (line) => {
  if (line.includes('##[')) return true;
  const text = line.trimStart();
  if (!text.startsWith('::')) return false;
  const end = text.indexOf('::', 2);
  if (end < 0) return false;
  const info = text.slice(2, end);
  const space = info.indexOf(' ');
  return RUNNER_COMMANDS.includes((space < 0 ? info : info.slice(0, space)).toLowerCase());
};

/** One stream's stop line: its token, and every line after it. */
function stopLineOf(stream, what) {
  const lines = stream.split('\n');
  assert.equal(lines.pop(), '', `${what} ends with a line break:\n${stream}`);
  const stop = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0] ?? '');
  assert.ok(stop, `the first line of ${what} is ::stop-commands:: and one token:\n${stream}`);
  const [, token] = stop;
  const after = lines.slice(1);
  // Only the token resumes commands, in either of the runner's forms, and no later line holds it.
  assert.ok(!after.some((line) => line.includes(token)), `${what} holds its token on its first line alone:\n${stream}`);
  return { token, after };
}

/** Both streams of a run, each after its stop line, the same token on both. Returns the token and each stream's lines after it. */
function stopped(result) {
  const out = stopLineOf(result.stdout, 'stdout');
  const err = stopLineOf(result.stderr, 'stderr');
  assert.equal(err.token, out.token, 'one token on both streams');
  return { token: out.token, stdout: out.after, stderr: err.after };
}

/** A copy of the validator that calls process.exit(3) right after the line given. */
const exitAfter = (at) => (dir) => {
  const path = join(dir, 'scripts', 'validate-dataset.mjs');
  const source = readText(path);
  if (source.split(at).length !== 2) throw new Error(`the validator no longer holds ${at}`);
  writeFileSync(path, source.replace(at, `${at}\n    process.exit(3);`));
};

// Every way a run ends: passed, refused, nothing to read, a dataset asked for that is not there, nothing published,
// an error no check handles (datasets/ a file, so reading it as a directory throws), and a process.exit() put into a
// copy of the validator after it lists its problems.
const removeDatasets = (dir) => rmSync(join(dir, 'datasets'), { recursive: true, force: true });
for (const [what, change, prepare, args, code, said] of [
  ['a run that passes', {}, undefined, [], 0, /2 dataset\(s\) validated/],
  ['a run that refuses', scanOf('hex', (s) => { s.extra = 1; }), undefined, [], 1, /scan-results-hex\.json carries "extra"/],
  ['a run with no datasets/ directory', {}, removeDatasets, [], 2, /No datasets\/ directory/],
  ['a run asked for a dataset that is not there', {}, undefined, ['2099-01-01'], 2, /No dataset datasets\/2099-01-01/],
  ['a run with nothing published', {}, (dir) => { removeDatasets(dir); mkdirSync(join(dir, 'datasets')); }, [], 0, /No datasets published yet/],
  ['a run stopped by an error no check handles', {}, (dir) => { removeDatasets(dir); writeFileSync(join(dir, 'datasets'), 'x\n'); }, [], 1,
    /The checks stopped on an error they do not handle:\n\n {2}Error: ENOTDIR/],
  ['a run ended by a process.exit() after its problems', scanOf('hex', (s) => { s.extra = 1; }),
    exitAfter('for (const p of problems) process.stderr.write(indented(p));'), [], 3, /scan-results-hex\.json carries "extra"/],
]) {
  test(`${what} writes the stop line first on stdout and on stderr, and its token on no later line`, async () => {
    const result = await validateOne(change, prepare, { args });
    assert.equal(result.code, code, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, said);
    stopped(result);
  });
}

test('the token of the stop line is drawn afresh for each run', async () => {
  const [first, second] = await Promise.all([validateOne(), validateOne()]);
  assert.notEqual(stopped(first).token, stopped(second).token);
});

// Three shapes of text a dataset chooses that reach the output as the runner's grammar: a key of an errata file,
// printed as it is; a scan file the parser quotes, line break included; and a listed name that is not a file. Each
// fires the predicate on a line after the stop line, where the runner reads it as text.
for (const [what, change, prepare, fires] of [
  ['an errata key holding a line break and ::warning::', {}, (dir) => {
    mkdirSync(join(dir, 'errata'));
    writeFileSync(join(dir, 'errata', `${FIRST_SHAPE}.json`), `${JSON.stringify({ 'x\n::warning::y': 1 }, null, 2)}\n`);
  }, /^\s*::warning::y/],
  ['a scan file whose text holds a line break and ::error::', {}, (dir) => rehash('scan-results-hex.json', '{"x":\n::error::y::}')(dir),
    /^\s*::error::y::/],
  ['a listed name that is not a file, holding ##[error]', {}, (dir) => {
    const path = join(dir, 'datasets', FIRST_SHAPE, 'MANIFEST.json');
    const m = JSON.parse(readText(path));
    m.ecosystems = [{ ecosystem: 'npm', file: '##[error]y.json', sha256: '0'.repeat(64) }];
    writeFileSync(path, json(m));
    mkdirSync(join(dir, 'datasets', FIRST_SHAPE, '##[error]y.json'));
  }, /##\[error\]y\.json/],
]) {
  test(`${what} is read by the runner's grammar after the stop line`, async () => {
    const result = await validateOne(change, prepare);
    assert.equal(result.code, 1, result.stdout);
    const { stdout, stderr } = stopped(result);
    assert.ok([...stdout, ...stderr].some((line) => fires.test(line) && readsAsCommand(line)), `${result.stdout}${result.stderr}`);
  });
}

// A fourth, on a run that passes: a scan's run is checked as text alone, and a run other than the manifest's is
// listed in a note on stdout, so what a scan names there reaches stdout as the runner's grammar, after the stop line.
test('a scan whose run holds ##[error] passes, and its note is read by the runner\'s grammar on stdout, after the stop line', async () => {
  const result = await validateOne(scanOf('hex', (s) => { s.scanner.workflowRun = '##[error]y'; }));
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const { stdout } = stopped(result);
  assert.ok(stdout.some((line) => /scan-results-hex\.json was written by the run ##\[error\]y, not by /.test(line) && readsAsCommand(line)),
    result.stdout);
});

// A key, a file name and a manifest field with a line break and `::notice` in them. Each is printed through
// describe(), as JSON text, so the break is written as \n and the problem stays one line of the list.
const COMMAND = '\n::notice title=x::y';
for (const [what, change, prepare, shown] of [
  ['a key of a scan file', scanOf('hex', (s) => { s[`extra${COMMAND}`] = 1; }), undefined, /scan-results-hex\.json carries "extra\\n::notice title=x::y", which the schema version 2 contract does not define/],
  ['a key of the manifest', manifestOf((m) => { m[`extra${COMMAND}`] = 1; }), undefined, /MANIFEST\.json is not a version 2 manifest: it carries "extra\\n::notice title=x::y", which a version 2 manifest does not define/],
  ['the name of a stray file', {}, (dir) => writeFileSync(join(datasetDir(dir), `notes${COMMAND}.txt`), 'notes\n'), /present but not listed in MANIFEST\.json: "notes\\n::notice title=x::y\.txt"\. An unlisted file/],
  ['a stored share', scanOf('hex', (s) => { s.coverage[`rate${COMMAND}`] = 0.5; }), undefined, /coverage carries "rate\\n::notice title=x::y", a stored share/],
]) {
  test(`${what} holding a line break and a runner command is printed as JSON text, on one line, after the stop line`, async () => {
    const result = await validateOne(change, prepare);
    assert.equal(result.code, 1, result.stdout);
    assert.match(firstProblem(result.stderr), shown, result.stderr);
    stopped(result);
  });
}

// The first file shape prints a listed file's name and recorded hash the same way, and a file name with a control
// character in it is not the name of a file in the dataset at all. The published manifest copied beside every test
// dataset lists its corpus alone, so the name goes on an entry added to it and the hash on the corpus.
test('a first-shape manifest whose file name and hash hold a line break and a runner command prints them as JSON text, after the stop line', async () => {
  const result = await validate({}, (dir) => {
    const path = join(dir, 'datasets', FIRST_SHAPE, 'MANIFEST.json');
    const m = JSON.parse(readText(path));
    m.corpus.sha256 = `${m.corpus.sha256}${COMMAND}`;
    m.ecosystems = [{ ecosystem: 'npm', file: `scan-results-npm-clean${COMMAND}.json`, sha256: '0'.repeat(64) }];
    writeFileSync(path, json(m));
  });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /"corpus-2026-03-18\.json" does not match its recorded hash\n\s+recorded "[0-9a-f]{64}\\n::notice title=x::y"\n\s+actual\s+[0-9a-f]{64}/, result.stderr);
  assert.match(result.stderr, /a manifest entry names "scan-results-npm-clean\\n::notice title=x::y\.json", which is not the name of a file in the dataset's own directory/, result.stderr);
  stopped(result);
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
