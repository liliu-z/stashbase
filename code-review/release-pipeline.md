# Release Runbook

> Review contract for source CI, tag gating, platform packaging, packaged
> native verification, and release handoff.

## Pipeline Shape

```text
version-bump commit on main → CI push run succeeds
→ Release workflow creates the matching vX.Y.Z tag
→ empty draft GitHub Release
→ independently versioned PDF/OCR component set is available
→ parallel macOS / Linux / Windows packages and smoke checks
→ complete immutable update set is verified
→ release becomes public → Homebrew cask points at the public DMG
```

Source validation and platform packaging are separate workflows. Source CI runs
for `main` pushes and pull requests. Release preparation does not create a second
release branch or repeat source CI for a version-only commit. A package may be
built only from a tag whose exact commit has a successful `ci.yml` push run.
The reusable gate resolves lightweight or annotated tags, waits for an active
matching run within its bound, and fails closed on missing, failed, cancelled,
or timed-out CI.
A successful `CI` completion on `main` starts the coordinator only when the
exact checked-out commit changes the version and is named `chore: bump to <version>`.
The tag is created through the GitHub API only after that CI succeeds. Other pushes,
PR runs, failed runs and foreign repositories cannot trigger publication. Manual
dispatch remains available for retrying an existing tag.

The coordinator is the publication Interface. It creates or validates an empty
draft, calls all platform Adapters, verifies the complete update set, and only
then makes the release public. A client must never observe a new latest version
before its metadata and payloads coexist.

## Source CI

Source jobs are bounded to 30 minutes, renderer behavior to 10 minutes, and the
native OpenCode smoke to five minutes. Release packaging jobs are bounded to
60 minutes. Workflow concurrency serializes publication without cancelling signing
or asset uploads; source runs on the same ref are also serialized.

- The macOS, Windows, and Linux matrix retains renderer behavior tests,
  host/Python suites, native OpenCode verification, platform builds, and real
  Electron lifecycle smoke. Linux runs the complete renderer gate; Windows and
  macOS run renderer behavior without repeating coverage or the Story sweep.
  Both Apple Silicon and Intel macOS runners run the source checks. Non-Linux
  renderer behavior runs use two workers: repeated Intel runs with default
  concurrency timed out in different otherwise-passing UI tests. Whole-test
  timeout is 15 seconds on native runners so lazy imports and multiple awaited
  assertions fit around their individual timeouts; the shell test itself has
  a five-second content assertion. The complete suite and all per-assertion
  wait limits remain unchanged. Two workers alone did not eliminate hosted
  Intel whole-test timeouts.
- `pnpm check:web` is the release-blocking renderer gate, run once on Linux:
  boundaries, size, conventions, unused exports, duplication, formatting, lint,
  coverage, structural Story accessibility, typecheck, production build, and
  catalog build. Every gate runs to completion and reports failures. Keep its
  commands in the runner, not duplicated as extra CI steps.
- After dependency setup succeeds, host checks continue after earlier test
  failures so one run reports the remaining boundaries. Every failed step still
  fails the source job. Electron smoke requires successful fresh service and
  Electron builds; cancellation stops subsequent work.
- Each platform builds the renderer and Electron boundary once, then reuses
  those outputs for `test:electron:smoke:built`. Host type checks and service
  builds do not repeat renderer work. Local `pnpm check` follows the same
  build-once rule; standalone smoke builds its own prerequisites.
- The native OpenCode smoke reports the active operation when interrupted.
  Its fixture aborts SSE readers and disposes the panel before stopping the
  broker/process, bounds graceful process termination, and closes gateway
  connections so a failed assertion cannot leave source CI waiting indefinitely.
- Source CI does not build installers or frozen sidecars. Windows package
  verification remains mandatory in `release-windows.yml` before
  upload. Packaging failures are therefore detected at the release stage;
  source CI alone does not prove packaged delivery.
- Linux source Electron may use `--no-sandbox` under hosted Xvfb. Packaged apps
  and non-Linux launches must not inherit that flag.

## Frontend Toolchain

The renderer is built by an exact pinned Vite+ release. The version is declared
in the root and `renderer` manifests, held by a workspace override so no
transitive resolution can drift, and recorded again in the source block of
`toolchain/vite-plus.json`.

- Vite+ supplies the bundler and the checkers. Vite and Rolldown are bundled
  into the pinned release; Vitest, Oxlint, and the formatter come with it as
  aligned dependencies. `toolchain/vite-plus.json` is the committed inventory
  of exactly which tool versions that release resolves to.
- `pnpm-lock.yaml` remains the package-management authority. Vite+ installs
  nothing, and the workflows give its setup action no installation or Node
  ownership.
- Stable repository scripts delegate to pinned `renderer` tasks rather than
  invoking a tool directly, so the pinned release is the only path to the
  renderer's build, test, lint, and format behavior.
- Vite+ task-result caching is disabled repository-wide in the root
  `vite.config.ts` and again through the setup action's inputs. A green run
  must come from work that actually ran.
- Frontend builds retain only pnpm's content-addressed dependency store cache.
  No workflow caches frontend build outputs or test results. Native component
  reuse is separate and follows the input rules below.
- The setup action is pinned by commit, requests the exact Vite+ version, and
  declines Node management and dependency installation. The Node and package
  manager runtimes are provisioned by their own earlier steps.
- CI verifies the resolved-tool inventory before the renderer gate runs.
  `scripts/check-vite-plus-toolchain.mjs` asks the pinned release for its
  resolved toolchain and requires a deep match against
  `toolchain/vite-plus.json`, so a silent tool substitution fails the build.

**Known gap — a second Oxlint.** The root manifest pins an Oxlint older than
the one the pinned Vite+ release delivers, and both resolve in the lockfile.
The renderer lints with the release's copy, so the root pin is an unused second
toolchain rather than the linter any gate runs.

## Native Packaging

- The independently downloaded PDF/OCR extractor keeps its console-enabled stderr channel for
  progress and failure reporting, while its Windows bootloader hides consoles
  owned by both the entry process and frozen multiprocessing workers.
- Base installers contain only the Python index daemon and an embedded
  extractor manifest. `scripts/build-extractor-component.mjs` publishes an
  independent tar.gz and matching JSON manifest per component version/platform;
  packaging verifies their hash, size, and target before embedding the manifest.
  macOS signs every native component binary/framework with Developer ID and
  requires accepted notarization before hashing the archive. Its temporary
  signing keychain joins the user search list for codesign identity resolution;
  the original list is restored on success and failure. Windows/Linux
  use the exact archive digest carried by the installed app. Component runtime
  installation is owned by [Data Lifecycle](architecture.md#optional-local-components).
- Python packaging rejects inference/OCR modules in the index daemon. App
  packaging excludes source maps and SQLite development sources while retaining
  its native binary and runtime loaders. Duplicate PDF.js JS builds and bundled
  OpenCode SDK/TOML parser copies are excluded; PDF CMaps/fonts/WASM and DOCX
  worker dependencies remain available. The packaged smoke fetches each kind of
  PDF runtime resource and performs DOCX conversion. PyArrow/OpenCV and the independent
  Python environments are preserved.
- Packaging validates Python daemon and extractor inputs before assembling the app.
- Every unbundled local dependency loaded by the Electron main process must be
  included in the electron-builder input. The package-input test scans relative
  CommonJS dependencies that cross out of `electron/` so a source-only smoke
  cannot hide a packaged startup failure.
- The exact OpenCode runtime and SDK versions are lockfile inputs. Its native
  postinstall target must be copied to a stable resource outside asar rather
  than entrusted to dependency collection, must never be replaced by a PATH
  binary. Source CI starts that exact target and completes an SDK turn against
  a fake local model gateway. Packaged smoke repeats both the version check and
  model turn against the final signed resource, asserting that the process
  remains alive; no real account or model credential is used. Windows also stages
  a pinned ripgrep executable beside OpenCode, puts its directory on the private
  runtime PATH for native skill reads, and probes that executable in packaged
  smoke. The binary must be present before packaging rather than downloaded by
  OpenCode at runtime.
- Electron packages use electron-builder's official zip download and extraction
  path. Do not point `electronDist` at the unpacked npm installation: that path
  can flatten macOS framework symlinks before Developer ID signing.
- Each platform publishes electron-updater metadata beside its artifacts:
  the platform-specific latest-mac.yml, latest.yml, or latest-linux.yml plus generated
  differential-download sidecars. Metadata and artifacts come from the same
  tagged build; clients never infer versions by scraping release tags.
- Artifact upload gates fail closed unless macOS has DMG, ZIP, and metadata;
  Windows has NSIS EXE, blockmap, and metadata; and Linux has deb,
  AppImage, and latest metadata carrying its embedded blockmap size.
  All four platform/architecture extractor archives and manifests must exist on
  their separate immutable component prerelease before application packaging starts.
  Component prereleases never become the latest desktop release.
- Versioned release assets are immutable. Platform Adapters upload only to a
  draft and never overwrite an existing name. If a coordinated run leaves an
  incomplete draft, delete that draft and rerun from the same tag rather than
  replacing individual bytes under the version.
- Draft lookup resolves the tag through GitHub GraphQL, then reads and uploads
  through the numeric REST release id. The REST tag endpoint does not expose an
  unpublished draft and must not be used as the draft-existence check.
- Windows provisions the manifest-reading Node runtime and compiler tools inside
  MINGW64. Linux preserves the documented glibc/glibc++ baseline. macOS targets
  12.0 for the desktop application. Intel native search/extraction bundles use
  macOS 15 dependencies; older Intel systems retain project entry and editing,
  while those components report unavailable without blocking application startup.
  Intel OCR uses the last selected ONNX Runtime/OpenCV releases with x64 wheels;
  other platforms keep their existing dependency resolution. Intel OpenCode uses
  the baseline executable so build-runner AVX2 support cannot narrow customer CPUs.
- Packaged smoke checks that the extractor is absent from the base installer,
  installs the release archive through the production download/verification
  owner using a local HTTP transport, exercises real PDF/OCR, and checks offline
  reuse. It also starts the server, exercises DOCX, and explicitly loads the
  Electron main-process dependency graph from app.asar before upload. Media
  playback uses the source file; no speech model or transcoder is packaged.
- The application icon is generated, never hand-edited. `build/icon.svg` is
  the only source; `pnpm build:icons` renders it through Electron's own
  Chromium into `build/icon.png`, the `build/icons/` set, `build/icon.ico`,
  and `build/icon.icns`, drawing the 16, 32, and 48 px rasters with heavier
  strokes so the mark survives those sizes. Regenerate after any change to the
  SVG and commit the rasters with it; the packagers read the rasters, not the
  SVG.

### Native Component Reuse

`extractor-components.yml` is the single publication owner for PDF/OCR. The
component version is `0.0.0-extractor.<input-sha256>`, independent of the app
version. The digest covers extractor sources, Python constraints, build/signing
recipes and their workflow, the manifest schema, and the resolved archive/schema
Node dependencies. App version bumps and renderer-only lockfile changes do not
invalidate it. Published components retain their original build environment;
runner image rotation alone does not rebuild already published binaries. Change
the component recipe when deliberately refreshing the interpreter/build image.

On a miss, the component workflow builds four native targets, signs/notarizes
macOS, uploads only to a draft, verifies every archive against its manifest and
publishes a non-latest prerelease. On a hit, it requires a complete public set.
Incomplete drafts fail closed and must be deleted before retrying. Platform app
jobs download the selected component, verify its identity/size/hash, embed its
manifest, and run the existing real PDF/OCR plus offline-reuse packaged smoke.
They do not sign, rebuild or re-upload an unchanged extractor. The runtime keeps
using the same installed component across app updates that pin the same manifest.

`native-components.yml` prepares unsigned Python bundles on
each push to `main`, independently of source CI. It produces no installer and
uses no signing credentials. The shared `prepare-native-components` action is
also used by all three release Adapters. GitHub release tags can restore the
default branch's caches; a cache written only under one tag is not shared with
the next tag. Only complete daemon-plus-extractor builds on `main` save these
component caches. App packaging restores the same complete cache when available,
but a miss builds only the daemon and never saves an incomplete cache.

Keys include OS, architecture, hosted image version, component inputs, and the
shared build recipe; Python also includes the interpreter patch version and
the full dependency constraints. They exclude the application version and use
no fallback keys. Changed inputs, image rotation, eviction, or an unfinished
warm-up result in an ordinary cold build. UI-only releases can reuse unchanged
components. Cache hit status is recorded in the Actions job summary.

Source Python validation and packaged smoke share the daemon RPC probe in
`scripts/packaging/smoke-daemon.mjs`: bind an empty folder, list its documents,
close the store, and require clean process exit. The source probe catches
protocol drift early; only the release probe establishes frozen execution.

Python runtime and isolated build dependencies use `python/constraints.txt`,
generated with `pnpm lock:python` (requires `uv`). The input digest check rejects
requirements edits without a refreshed resolution. Review dependency updates
in the generated file; the resolver retains existing pins where compatible.
The build reconciles its environment before freezing instead of accepting any
already-installed PyInstaller version. Source setup uses the same constraints.
After regenerating constraints, validate a clean resolution with Python 3.13's
`pip install --dry-run --ignore-installed -c python/constraints.txt -r python/requirements-extract.txt -r python/build-requirements.txt`.
Universal uv resolution and an existing environment can miss index-level Python
compatibility restrictions. RapidOCR stays on 1.2.3 because later releases
declare Python <3.13; the hosted cold component builds verify actual installation.

Save Python bundles before macOS signing mutates the extractor. Unsigned caches
only accelerate a new component build. Every application release validates its
selected published component and runs the packaged smoke. Reuse is not evidence
that the newly assembled application passed. Hosted cold/warm component
publication and measured end-to-end savings remain to be verified after this
pipeline change is deployed.

The compression policy remains electron-builder's default `normal`. Compare
cold and warm release jobs and archive size/upload time before changing it;
lower compression can trade build time for larger downloads. Actual Windows
and Linux cache restoration, frozen Python execution, macOS signing after
restoration, and end-to-end time savings require hosted release evidence.

Local validation of the packaging filters against the extracted 2.15.10 arm64
payload removed 13,181,805 bytes. Current built services over that filtered
resource tree passed Electron main-dependency loading, PDF resource requests,
DOCX worker loading/conversion and project file flows. The source-built real
Electron lifecycle smoke also passed. This was an isolated resource harness,
not a newly signed installer; compressed download size and all-platform hosted
publication remain unmeasured for this change.

## macOS Developer ID Distribution

The macOS Adapter builds arm64 on `macos-15` and x64 on `macos-15-intel`.
Each runner verifies its native daemon, signed application, and independent
extractor. Artifacts are staged separately, then `scripts/merge-macos-artifacts.mjs`
checks both application versions, architectures, and payload hashes
before creating one latest-mac.yml containing both ZIP/DMG pairs. Only the
combined set is uploaded to the draft; parallel jobs must never upload competing
metadata under the same name. Homebrew selects the DMG and checksum by CPU.
The v2.9.11 source commit passed [CI on all four native targets](https://github.com/liliu-z/stashbase/actions/runs/35709192270)
after its Ubuntu and Windows jobs were rerun once: the first attempt failed the
renderer coverage gate on a Milkdown timer firing after the revision test
environment was torn down, with every renderer test passing, and the Windows
project-file suite on temp-folder cleanup while the index daemon was still
exiting; the same source had passed on `main` at the same time, and the
v2.9.10 `main` push had hit the same coverage error. Its first
[coordinated run](https://github.com/liliu-z/stashbase/actions/runs/35711691238)
passed both macOS architectures' signing, notarization, and mounted-DMG checks,
the Windows and Linux packaged runtime checks, the complete update-set
verification, publication, and the Homebrew cask update. The v2.9.8 release
needed a [second run](https://github.com/liliu-z/stashbase/actions/runs/35362942755)
from the same tag after its Intel signing job received no timestamp for one
nested Python binary; the incomplete draft was deleted first. Every platform
asset, all three latest metadata files with their blockmaps, and the four
extractor archives with manifests are on the public release; the Windows set is
the NSIS installer, its blockmap, and latest.yml, which lists the installer
alone. Local checks of the downloaded arm64 DMG matched the cask's checksum,
reported 2.9.11, and passed strict/deep codesign, Gatekeeper's notarized
Developer ID assessment, and stapler validation; that package was not launched
from the release session. Real Intel macOS 12–14 entry/editing,
representative OCR quality, live release-component delivery, the packaged
in-app runtime update, a packaged Windows installer launch, and N→N+1 updates
remain release checks.
Artifact tests exercise checksum rejection and the installed electron-updater's
architecture selection; the generated Homebrew cask passes Ruby syntax validation.

Published macOS apps use a Developer ID Application identity, Hardened Runtime,
secure timestamps, Apple notarization, and a stapled ticket. The after-sign
notarization hook retries only CloudKit ticket connection losses after an
accepted submission; the mounted-DMG verifier applies the same bounded retry
to ticket validation. Other signing and notarization failures stop the release.
Release packaging fails closed when signing or notarization credentials are missing, incomplete,
or ambiguous. The `afterPack` adapter validates versioned framework symlinks
before signing. It preserves the original bundle in clean CI workspaces and
uses a metadata-free clone only for local File Provider workspaces; no package,
Homebrew, or recovery step may mutate or ad-hoc re-sign the app afterward.
After that adapter runs, still before signing, electron-builder's built-in
`electronFuses` config (`build.electronFuses` in `package.json`) disables the
`runAsNode`, `enableNodeOptionsEnvironmentVariable`, and
`enableNodeCliInspectArguments` Electron fuses on every platform's packaged
binary, closing the packaged-build hardening gap reported in
[#228](https://github.com/liliu-z/stashbase/issues/228). The remaining fuses
stay at Electron's defaults; widening that set is a separate decision, not a
side effect of this one. The
bundled OpenCode/Bun executable is declared as an additional nested signing
target and alone receives the unsigned-executable-memory entitlement it needs
under Hardened Runtime; the main app and ordinary helpers must not inherit that
exception. Its per-file signing adapter must stay synchronous because the
pinned signing library consumes that callback without awaiting a Promise. The
mounted release DMG must pass `codesign`, Gatekeeper `spctl`, and stapler
validation before upload.

## Windows Distribution and Optional Authenticode

Windows releases do not require a signing certificate. Without both
`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, the workflow publishes an unsigned
NSIS installer so packaging and the stable updater channel remain usable;
initial installation can therefore show Windows' unknown-publisher warning.
The updater still verifies the installer hash declared by the release-generated
**latest.yml**. Windows publishes the NSIS installer with its blockmap and
metadata only; there is no zip or portable build, because the updater consumes
the installer and an extracted archive runs without an uninstall entry and
fails outright when launched from inside the archive. Never replace an artifact
or metadata file under a published version.

Signing remains an optional fail-closed upgrade. If either signing secret is
present, both are required; when both are present electron-builder forces
signing, the workflow checks every NSIS executable with
`Get-AuthenticodeSignature`, and the packaged updater records its publisher
verification contract. A build installed from that signed channel must not be
downgraded to unsigned replacement updates.

## Release Asset Upload

Every platform Adapter uploads through `scripts/upload-release-assets.mjs`, so
one Module owns the upload rules for macOS, Linux, and Windows. The draft
lookup in `scripts/github-release-api.mjs` is the only place that decides a
release may receive assets, and it accepts a draft alone.

- Assets upload one at a time. An attempt that stalls is aborted after fifteen
  minutes so it cannot hold a job open until the run is cancelled.
- GitHub answers a large upload with `500 Error saving asset` intermittently,
  and a save that fails that way can leave a placeholder asset record behind.
  Each attempt therefore discards any record for that name that never reached
  `uploaded`, then retries the same asset with a bounded backoff that tolerates
  roughly twenty minutes of refusals before failing the job. A fault that
  outlasts the budget is a GitHub outage, and the job fails rather than
  publishing a partial update set.
- An asset already stored at the size this build produced is kept, so a rerun
  does not have to rebuild the draft. A stored asset of a different size stops
  the release, because versioned assets are immutable.
- A rejection GitHub will not reconsider is not retried.

Assertions live in `scripts/github-release-api.test.mjs` behind
`pnpm test:updates`.

## Maintainer Handoff

Version choice and pushing the explicit standalone version-bump commit remain
maintainer-controlled. Successful exact-commit source CI automatically starts
tagging and coordinated publication. Public application publication occurs only
after all platform jobs and asset checks pass.
Do not commit packaged artifacts; outputs belong under `release.nosync/`.

After workflows finish, verify the release assets and tap update, then run the
residual [Packaged UI Release Sanity](../release-checklists/ui-sanity.md) on
applicable platforms. That checklist covers native, packaged, credentialed,
clipboard, real-media, and N→N+1 updater seams; it does not repeat automated
journeys.

When a release changes retrieval ranking, chunking, embedding models, or
provider integration, run `pnpm eval:semantic-retrieval --out <path>` for every
configured supported BYOK provider before publication. Retain each complete
text report with the release evidence; it must identify the commit, dataset,
provider, and model, and must not be marked as produced from a dirty working
tree. A report marked `ACTIVE` must meet both thresholds. A
report marked `CALIBRATION` contributes only baseline evidence and cannot be
described as a passing semantic-quality gate. Required source CI remains
credential-free and does not run this probabilistic check.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Source CI | `.github/workflows/ci.yml` |
| Renderer gate runner | `scripts/renderer/check-web.mjs` behind `pnpm check:web` |
| Frontend toolchain Interface | the pinned Vite+ version in `package.json`, `renderer/package.json`, and `pnpm-workspace.yaml`, against the resolved inventory in `toolchain/vite-plus.json` |
| Toolchain verifier | `scripts/check-vite-plus-toolchain.mjs`, with the workflow contract in `scripts/vite-plus-ci.test.mjs` |
| Tag gate Interface | `.github/workflows/release-ci-gate.yml` and `scripts/require-green-ci.mjs` |
| Publication coordinator | `.github/workflows/release.yml`, `scripts/select-release-tag.mjs` |
| Independent PDF/OCR publication | `.github/workflows/extractor-components.yml`, `scripts/prepare-extractor-release.mjs`, `scripts/packaging/extractor-release.mjs` |
| Platform Adapters | `.github/workflows/release-macos.yml`, `release-linux.yml`, `release-windows.yml` |
| Release asset upload Module | `scripts/upload-release-assets.mjs` over the draft lookup and upload rules in `scripts/github-release-api.mjs` |
| Native build reuse | `.github/workflows/native-components.yml`, `.github/actions/prepare-native-components/action.yml`, `python/constraints.txt`, `scripts/lock-python.mjs`; contracts in `scripts/packaging/native-cache.test.mjs` |
| Packaging Module | `scripts/package-desktop.mjs`, signing contracts, `scripts/sign-macos-app.cjs`, `scripts/update-artifact-contract.mjs`, `scripts/build-python-sidecar.mjs`, `scripts/after-pack-macos.cjs`, the `build.electronFuses` contract in `package.json` |
| Application icon | `scripts/icons/build.mjs` behind `pnpm build:icons`, rendering `build/icon.svg` in `scripts/icons/render.mjs` with the size table and containers in `scripts/icons/encode.mjs` |
| Packaged verification | `scripts/smoke-packaged-server.mjs` (including the explicit OpenCode resource version probe) and platform release verifiers |
| Focused evidence | `scripts/packaging/inputs.test.mjs`, `scripts/icons/encode.test.mjs`, `server/__tests__/opencode-native-smoke.test.ts`, `scripts/require-green-ci.test.mjs`, signing contract tests, `scripts/update-release-contract.test.mjs`, `electron/update-install-strategy.test.cjs`, the platform workflows, applicable retained semantic retrieval reports, and the N→N+1 release check |

## Release Runbook

When asked to release, run this sequence unattended after the one version
choice:

1. Inspect `git status` and `git log --oneline -10`; group pending work into
   focused commits on `main`. Complete the applicable pre-commit gates.
2. Ask whether the `package.json` version bump is patch, minor, or major.
3. Commit only the bump as `chore: bump to <version>`, as the final commit in
   the push. Do not create a release branch or push the same source first.
4. If retrieval ranking, chunking, an embedding model, or provider integration
   changed, collect the required J05 reports before pushing the release trigger.
   `ACTIVE` threshold failures stop release; `CALIBRATION` reports are baseline
   evidence only. The probabilistic gate remains maintainer-operated.
5. Push `main` once. The `CI` workflow validates that exact final commit; on
   success, the Release workflow creates its immutable tag, prepares the draft,
   publishes or reuses the independent component set, packages all platforms,
   verifies the update set, publishes the app, and updates Homebrew. Do not
   manually publish a draft. `HOMEBREW_TAP_TOKEN` needs tap push access.
6. If CI fails without requiring source changes, rerun the failed jobs. If fixes
   must follow the bump, wait for their exact `main` commit to pass CI, create
   the version tag at that successful commit, and manually dispatch `release.yml`.
   For a packaging/upload failure, delete the incomplete application draft and dispatch `release.yml` with the
   same tag. Delete an incomplete component draft as well if component publication
   failed; retain already public components. Never clobber versioned assets.
7. After Actions finish, verify the public app assets, all three update metadata
   files and generated sidecars, the separate four-platform component set pinned
   by the application, and the tap update. Perform residual packaged UI sanity,
   including N→N+1 updates before calling the update path verified.

Release notes identify separate arm64/x64 installers, the older Intel component
limitations, Developer ID signing, and notarization. The macOS workflow requires the signing certificate secrets
`MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` plus the App Store Connect Team API
key secrets `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
Windows signing is optional; configure both `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` together when it is introduced.

### macOS signing credential setup

Create a Developer ID Application identity, install its certificate with the
matching private key, and export a password-protected `.p12` for
`MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`. A certificate without its private key
cannot sign a build. The separate App Store Connect Team API `.p8` key supplies
notarization authentication via the three `APPLE_API_*` secrets above.
The workflow decodes the key into a protected temporary file and supplies its
absolute path as `APPLE_API_KEY`; it does not pass base64 key text as that path.
See Apple's [certificate setup](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
and [API-key setup](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
when provisioning credentials. Never print or commit private keys.

`build/entitlements.mac.plist` and its inherited/native-runtime variants own
actual entitlements, including `com.apple.security.cs.disable-library-validation`.
Narrowing this exception requires packaged native compatibility evidence.
Current OpenCode executable-memory exceptions are described above; do not
apply older general entitlement advice over the per-file signing contract.

### Python index dependency readiness

`python/requirements.txt` owns the exact MFS revision. Before release, verify
that revision's upstream status and frozen process shutdown on each platform;
source-runtime checks do not establish packaged readiness.

No retained real-provider baseline establishes retrieval parity. Verify ranking
across the dependency's flush boundary with J05's quality dataset, and measure
fresh-install daemon cold starts on each platform. Cached source startup and
historical bundle measurements do not establish a released startup budget.

Local macOS package and cask preview only; it never uploads or publishes:

```bash
pnpm dist:brew --dry-run
```

On a fresh machine, install and authenticate `gh`. Never commit a DMG or other
package; `release.nosync/` is the only output root.

Known macOS failures:

- `SecKeychainUnlock: The user name or passphrase you entered is not correct`
  from `security set-key-partition-list` while electron-builder imports the
  identity into its temporary keychain means the hosted image's keychain
  services refuse a pre-session unlock; the macOS 26.6 image does, where
  26.5 did not. The macOS Adapter therefore runs on the pinned `macos-15`
  image rather than `macos-latest`. A retry on the refusing image does not
  help; lift the pin only after a dispatched run on the newer image signs
  and notarizes.
- `bundle format is ambiguous` means a framework no longer has Apple's required
  versioned-bundle layout. The pre-sign structure check must identify a
  flattened top-level link before `codesign`; ensure packaging uses the official
  Electron zip extraction path rather than copying `node_modules/electron/dist`.
- `resource fork / Finder information detritus` means iCloud/File Provider
  metadata reached the bundle. Keep both defenses: `.nosync` output and the
  local-only `afterPack` `ditto --noextattr` clone before signing. CI must retain
  electron-builder's original bundle because it does not have File Provider
  metadata. `xattr -cr` alone is not sufficient in a local File Provider
  workspace because the provider can reapply tags.
- `Unable to find next certificate in the chain` means the Developer ID G2
  intermediate certificate is absent from the signing keychain. Install the
  Apple-published intermediate before exporting or using the identity.
- `A timestamp was expected but was not found` from `codesign --timestamp` on
  one nested binary means Apple's timestamp service did not answer that
  request from the runner; nothing in the bundle or the identity is wrong.
  Delete the incomplete draft and dispatch the coordinator again from the same
  tag rather than signing without a timestamp, which notarization would reject.
- `NSURLErrorDomain Code=-1005` from `api.apple-cloudkit.com` during stapling or
  ticket validation is a lost connection to Apple's ticket service. The macOS
  hook and mounted-DMG verifier retry only that error with bounded delays; if
  it persists, keep the release draft unpublished and retry the coordinated
  release after removing the incomplete application draft.
- A rejected notarization must stop publication. Retrieve the notary log,
  repair every unsigned nested Mach-O or invalid entitlement, and rebuild from
  source; never patch an already signed bundle.

## Validation for Pipeline Changes

Run:

```bash
pnpm test:release-gate
pnpm test:toolchain
pnpm test:package-inputs
pnpm test:macos-signing
pnpm test:windows-signing
pnpm test:updates
pnpm typecheck
```

Exercise the reusable tag/CI gate against matching, missing, active, failed,
and annotated-tag cases. Exercise missing, partial, conflicting, and complete
macOS credentials plus absent, partial, and complete optional Windows signing
credentials through focused contract tests. Any native manifest or packaging
change must pass the platform verifier and `pnpm smoke:packaged-server` before
publication. A change to the pinned frontend toolchain, the setup action, or the
renderer gate set regenerates `toolchain/vite-plus.json` from the release itself
rather than by hand.
