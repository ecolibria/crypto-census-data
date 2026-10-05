# CryptoServe Census — open data

Raw output from the CryptoServe Cryptographic Census: how many packages in each
public registry depend on a catalogued cryptographic library, and how those
dependencies split across weak, modern and post-quantum tiers.

Published under CC-BY-4.0. Every dataset is dated, hashed, and immutable once
published.

```console
$ git clone https://github.com/ecolibria/crypto-census-data
$ node scripts/validate-dataset.mjs
2 dataset(s) validated: 2026-03-18, 2026-08-03
```

Every file is verified against the SHA-256 recorded in its `MANIFEST.json`, so a
dataset that was altered in transit or after publication fails rather than
reading as valid.

## What is published

| Dataset | Kind | Packages listed | Matched a catalogued library | Ecosystems | Known issues |
|---|---|---|---|---|---|
| [`2026-08-03`](datasets/2026-08-03) | raw+aggregate | 2,170,994 | 65,686 | 11 | [`errata/2026-08-03.json`](errata/2026-08-03.json) |
| [`2026-03-18`](datasets/2026-03-18) | aggregate-only | 2,809,479 | 108,145 | 11 | two rows annotated in place (below) |
| _The instrument changed between these two runs. The rows are not comparable._ | | | | | |

The August dataset is the first published with its raw per-package output, one file per ecosystem, so a reader
can recount the packages behind each match count. The raw files list matched packages only; packages with no
match appear as totals.

**The two datasets are not comparable, and no change over time can be read from them.** The instrument changed
between the March and August runs, and the March raw output no longer exists, so its figures cannot be
recomputed under the August method. A difference between a March figure and an August figure is not a
measurement of change. That holds for the totals, for the share of packages matching weak-classed libraries and
for the share matching post-quantum libraries.

**The March 2026 dataset is the aggregate alone.** Its raw per-package output
does not exist: it was written to a path matching a line in `.gitignore`, was
never committed, and was searched for across local disk, all connected GitHub
organisations and GitHub code search on 2026-07-27 without result. The aggregate
survived because it was committed, in two independent places that agree exactly.
`datasets/2026-03-18/MANIFEST.json` records this in `provenanceNote`.

That loss is why the scan pipeline now persists raw output as a build artifact
and fails the run when it produces nothing.

## Known issues in the 2026-08-03 dataset

Defects measured in this dataset after it was published are recorded in
[`errata/2026-08-03.json`](errata/2026-08-03.json). The dataset directory is not edited. Its files, their hashes
and the DOI stay as deposited, and its `MANIFEST.json` lists no known issue because none had been measured when
it was written. Read the errata before quoting a figure.

Each entry names the defect, the fields it affects, the direction of the error, its size where that has been
measured, and how to check it.

| Where | Defect | Direction |
|---|---|---|
| Maven | The scanner read the first `<dependencies>` element in a POM wherever it sat. | Both ways |
| Maven, Packagist, npm | Entries are counted only through libraries that are being taken out of the count. | Overstates |
| Go | Catalogue names were matched by path prefix. | Overstates |
| Maven, CocoaPods | The catalogue's post-quantum entries name packages the registry does not have, so zero is not a measurement. | Not measurable |
| Go | `// indirect` requirements were counted as direct. | Overstates |
| Go | Each module was read at its first indexed version; the published entries that could be located were first indexed between 2019-04-10 and 2020-07-30. | Not current |
| Go | A go.mod that holds only a module line was counted as using no cryptography. | Understates |
| crates.io | A dependency was counted however it is declared, including optional, development, build and platform-specific ones. | Overstates |
| PyPI | Requirements behind an extra or an environment marker were counted. | Overstates |
| npm, PyPI, Go, Maven, Packagist, NuGet, CocoaPods | A package that could not be read was counted as scanned and as using no cryptography. | `packagesScanned` overstates; match counts understate |
| Every ecosystem but Hex and pub.dev | The weak tier mixes libraries that implement broken algorithms with libraries that are deprecated or unmaintained, and holds entries the corrected classes do not class as weak. | Overstates |
| Totals and shares | They sum or divide the counts above. | Not established |
| `topExposedProjects`, `topPqcProjects` | The two lists name packages through entries not classed weak, or through optional declarations. | Overstates |

Not known: the effect of the unread packages on any count, the cause of the NuGet read failures, whether the
RubyGems, Hex and pub.dev scanners, which report no unread package, count every failure, and why some of the
published Go entries could not be located when the Go scan was reconstructed.

One correction has been made to a scanner, for Maven, and no scan has been published with it. The others are
planned. Corrected figures can only come from a new scan, published as a new dated dataset. No date is set.

## Two rows in the March dataset are known to be wrong

They are annotated in place rather than corrected, because a published corpus is
dated evidence and editing a figure after the fact silently moves every total
derived from it. Each carries a `knownIssue` naming the defect, the fields it
makes unreliable, and **which way** the error runs:

| Ecosystem | Defect | Direction |
|---|---|---|
| `hex` | The scanner read `requirements` from the release entries in `/api/packages/<name>`, which do not carry that field — it lives on the release resource. All 15,000 Hex packages were classified as using no cryptography. | Understates |
| `pub` | Enumeration paginated `/api/search` with an empty query, which pub.dev caps at ten pages of ten. 100 packages of roughly 86,000 were scanned. | Understates |

Both scanners were fixed on 2026-07-28. Corrected figures arrive with the next
published dataset; they are not backfilled into this one.

The issues recorded for the 2026-08-03 dataset may apply to this one as well. On 2026-03-18 the Go, crates.io,
PyPI, Packagist and NuGet scanners in the source repository were identical to the ones that produced the August
dataset, and the catalogue held the same post-quantum entries that Maven Central and CocoaPods do not have.
Which commit the March run used was not recorded, and its raw output no longer exists, so this cannot be
established or sized.

## Citing

Cite the dated dataset, not the repository:

> CryptoServe Census, corpus layer, 2026-08-03. https://doi.org/10.5281/zenodo.21791658

Each published dataset is deposited to Zenodo from the tag that pins it, so a
citation resolves to fixed bytes rather than to a moving branch.

| Dataset | DOI |
|---|---|
| [`2026-08-03`](datasets/2026-08-03) | [10.5281/zenodo.21791658](https://doi.org/10.5281/zenodo.21791658) |
| [`2026-03-18`](datasets/2026-03-18) | none — predates the deposit workflow |

`10.5281/zenodo.21791657` is the concept DOI. It resolves to whichever dataset
was deposited most recently, which is the one thing a citation must not do:
quote the dated DOI above, so a reader gets the bytes you actually read.

## Schema

Each dataset is a directory named for its collection date:

```
datasets/<YYYY-MM-DD>/
  MANIFEST.json                       describes and hashes everything below
  corpus-<date>.json                  the aggregate: per-ecosystem and total counts
  scan-results-<ecosystem>-clean.json per-package output, one file per ecosystem
```

`MANIFEST.json` carries:

| Field | Meaning |
|---|---|
| `kind` | `raw+aggregate` or `aggregate-only`. An unrecognised value fails validation rather than passing unchecked. |
| `provenance` | Source repository, commit and workflow run that produced the dataset. Required for `raw+aggregate`. |
| `provenanceNote` | Why provenance is absent. Required when it is. |
| `corpus` | The aggregate file, its counts, size and SHA-256. |
| `ecosystems[]` | One entry per raw file: packages scanned, packages with crypto, size and SHA-256. |
| `knownIssues[]` | Ecosystems whose figures carried a recorded defect when the dataset was published. Defects measured later are in `errata/<date>.json`. |

`totalScanned` counts packages the scanner **listed**, including packages whose metadata it could not read
(`fetchErrors` at the head of each raw file). It does not count packages using cryptography, and the two differ
by more than an order of magnitude. Every published share is over `packagesWithCrypto`. Read the denominator
before quoting a percentage.

## How a dataset gets here

The census scan runs daily in
[`opena2a-org/crypto-census`](https://github.com/opena2a-org/crypto-census) as a
canary: it scans all eleven ecosystems, aggregates, uploads artifacts, and
publishes nothing. A broken scanner is therefore found the day it breaks rather
than the day someone needs the data.

Publication is deliberate. A maintainer triggers the workflow with
`publish=true`, which opens a pull request here carrying the aggregate, the raw
per-ecosystem files and a generated `MANIFEST.json`. The scan refuses to publish
a run in which any ecosystem enumerated implausibly little, or enumerated
normally and matched nothing at all — both of which have happened, and neither
of which looks like a failure in the totals.

Scan limits are what they are. They are never tuned to reproduce a previously
published figure.

## Immutability

A published dataset is never rewritten. CI rejects any change that modifies or
deletes a file under an existing `datasets/<date>/`. A correction is published as
a new dated dataset that supersedes the old one and says so.

A defect measured after publication is recorded in `errata/<date>.json`, outside the dataset directory, so the
deposited bytes do not change. Entries are added to an errata file and existing entries are not edited; the
repository history records each addition.

This is the property a DOI depends on: a citation points at bytes that must not
move underneath it.

## Validating

```bash
node scripts/validate-dataset.mjs             # every dataset
node scripts/validate-dataset.mjs 2026-03-18  # one dataset
```

The validator checks that every listed file exists and matches its hash, that no
unlisted file is present, that the aggregate and the raw files describe the same
run, that the aggregate's per-ecosystem counts sum to its own total, and that any
`knownIssue` is complete and states a direction.

The two datasets above were published before a manifest carried a
`schemaVersion`. The validator accepts a manifest without one for those two
directories only. A dataset under a new date has to declare its version, and the
validator refuses a declared version until it has rules for it.

## Licence

[CC-BY-4.0](LICENSE). Attribution as above.
