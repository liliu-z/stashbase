# Release Pipeline

> Review contract for source CI, tag gating, platform packaging, packaged
> native verification, and release handoff.

## Pipeline Shape

```text
source commit → CI push run succeeds
→ matching vX.Y.Z tag
→ empty draft GitHub Release
→ parallel macOS / Linux / Windows packages and smoke checks
→ complete immutable update set is verified
→ release becomes public → Homebrew cask points at the public DMG
```

Source validation and platform packaging are separate workflows. Source CI runs
for `main` and `release/**` pushes. A package may be built only from a tag whose
exact commit has a successful `ci.yml` push run.
The reusable gate resolves lightweight or annotated tags, waits for an active
matching run within its bound, and fails closed on missing, failed, cancelled,
or timed-out CI.
The coordinator is the publication Interface. It creates or validates an empty
draft, calls all platform Adapters, verifies the complete update set, and only
then makes the release public. A client must never observe a new latest version
before its metadata and payloads coexist.

## Source CI

- The macOS, Windows, and Linux source matrix covers type/build gates plus
  release/update/signing contracts, config/account, scheduler, cancellation,
  retrieval, renderer, server, MCP, Python, and real Electron lifecycle
  behavior.
- Ubuntu Playwright adds smoke, deterministic functional journeys, and reviewed
  visual baselines without replacing the three-platform source matrix.
- Linux source Electron may use `--no-sandbox` under hosted Xvfb. Packaged apps
  and non-Linux launches must not inherit that flag.

## Native Packaging

- Each platform builds the pinned transcription sidecar for its target. Native
  archives may use declared mirrors only when the accepted bytes match the
  pinned digest.
- Packaging rejects missing/empty binaries, licenses, or notices; wrong binary
  formats; version/build-option drift; unacceptable FFmpeg licensing/features;
  and target ABI or minimum-OS drift.
- Every unbundled local dependency loaded by the Electron main process must be
  included in the electron-builder input. The package-input test scans relative
  CommonJS dependencies that cross out of `electron/` so a source-only smoke
  cannot hide a packaged startup failure.
- Electron packages use electron-builder's official zip download and extraction
  path. Do not point `electronDist` at the unpacked npm installation: that path
  can flatten macOS framework symlinks before Developer ID signing.
- Each platform publishes electron-updater metadata beside its artifacts:
  the platform-specific latest-mac.yml, latest.yml, or latest-linux.yml plus generated
  differential-download sidecars. Metadata and artifacts come from the same
  tagged build; clients never infer versions by scraping release tags.
- Artifact upload gates fail closed unless macOS has DMG, ZIP, and metadata;
  Windows has NSIS EXE, ZIP, blockmap, and metadata; and Linux has deb,
  AppImage, and latest metadata carrying its embedded blockmap size.
- Versioned release assets are immutable. Platform Adapters upload only to a
  draft and never overwrite an existing name. If a coordinated run leaves an
  incomplete draft, delete that draft and rerun from the same tag rather than
  replacing individual bytes under the version.
- Draft lookup resolves the tag through GitHub GraphQL, then reads and uploads
  through the numeric REST release id. The REST tag endpoint does not expose an
  unpublished draft and must not be used as the draft-existence check.
- Windows provisions the manifest-reading Node runtime and compiler tools inside
  MINGW64. Linux preserves the documented glibc/glibc++ baseline. macOS targets
  12.0 and retains the generic CPU fallback alongside supported acceleration.
- Packaged smoke starts the server, exercises PDF/OCR/DOCX helpers, explicitly
  loads the Electron main-process dependency graph from app.asar, downloads and
  verifies the Tiny speech model, transcodes media, runs local inference,
  validates transcript output, and serves the compatible preview before
  upload.

## macOS Developer ID Distribution

Published macOS apps use a Developer ID Application identity, Hardened Runtime,
secure timestamps, Apple notarization, and a stapled ticket. Release packaging
fails closed when signing or notarization credentials are missing, incomplete,
or ambiguous. The `afterPack` adapter validates versioned framework symlinks
before signing. It preserves the original bundle in clean CI workspaces and
uses a metadata-free clone only for local File Provider workspaces; no package,
Homebrew, or recovery step may mutate or ad-hoc re-sign the app afterward. The
mounted release DMG must pass `codesign`, Gatekeeper `spctl`, and stapler
validation before upload.

## Windows Distribution and Optional Authenticode

Windows releases do not require a signing certificate. Without both
`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, the workflow publishes an unsigned
NSIS installer so packaging and the stable updater channel remain usable;
initial installation can therefore show Windows' unknown-publisher warning.
The updater still verifies the installer hash declared by the release-generated
**latest.yml**. Never replace an artifact or metadata file under a published
version.

Signing remains an optional fail-closed upgrade. If either signing secret is
present, both are required; when both are present electron-builder forces
signing, the workflow checks every NSIS executable with
`Get-AuthenticodeSignature`, and the packaged updater records its publisher
verification contract. A build installed from that signed channel must not be
downgraded to unsigned replacement updates.

## Maintainer Handoff

Version choice, the standalone version-bump commit, tag creation, and dispatch
of the coordinated Release workflow remain maintainer-controlled. Public
publication is automated only after all platform jobs and asset checks pass.
Do not commit packaged artifacts; outputs belong under `release.nosync/`.

After workflows finish, verify the release assets and tap update, then run the
residual [Packaged UI Release Sanity](../release-checklists/ui-sanity.md) on
applicable platforms. That checklist covers native, packaged, credentialed,
clipboard, real-media, and N→N+1 updater seams; it does not repeat automated
journeys.

## Implementation Map

| Role | Stable entry points |
|---|---|
| Source CI | `.github/workflows/ci.yml` |
| Tag gate Interface | `.github/workflows/release-ci-gate.yml` and `scripts/require-green-ci.mjs` |
| Publication coordinator | `.github/workflows/release.yml` |
| Platform Adapters | `.github/workflows/release-macos.yml`, `release-linux.yml`, `release-windows.yml` |
| Packaging Module | `scripts/package-desktop.mjs`, signing contracts, `scripts/update-artifact-contract.mjs`, `scripts/build-python-sidecar.mjs`, `scripts/build-transcription-sidecar.sh`, `scripts/after-pack-macos.cjs` |
| Packaged verification | `scripts/smoke-packaged-server.mjs` and platform release verifiers |
| Focused evidence | `scripts/package-inputs.test.mjs`, `scripts/require-green-ci.test.mjs`, signing contract tests, `scripts/update-release-contract.test.mjs`, `electron/update-install-strategy.test.cjs`, the platform workflows, and the N→N+1 release check |

## Release Runbook

When asked to release, run this sequence unattended after the one version
choice:

1. Inspect `git status` and `git log --oneline -10`; group a dirty tree into
   focused commits. Push `main`, then create `release/v<version>` from that
   ready commit.
2. Ask whether the `package.json` version bump is patch, minor, or major.
3. Commit only the bump as `chore: bump to <version>`.
4. Push the release branch; wait for the `CI` workflow to succeed for that
   exact commit. Then create and push `v<version>` from the release branch.
5. Dispatch `.github/workflows/release.yml` with the tag. It creates an empty
   draft, runs all three platform workflows, verifies the complete update set,
   publishes the release, and then updates Homebrew. Do not manually publish
   the draft. `HOMEBREW_TAP_TOKEN` requires push access to
   `liliu-z/homebrew-stashbase`.
6. If a platform upload fails after writing assets, delete the incomplete draft
   and dispatch the coordinator again. Never use clobber or replace a versioned
   asset in place.
7. After Actions finish, run `gh release view v<version>`. Verify macOS DMG/zip,
   Linux deb/AppImage, Windows exe/zip, all three latest YAML update metadata
   files and generated sidecars, and the tap update, then perform the
   residual packaged UI sanity checks, including a real N→N+1 update on every
   platform before calling the update path verified.

Release notes state that macOS is arm64-only, Developer ID-signed, and
notarized. The macOS workflow requires the signing certificate secrets
`MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` plus the App Store Connect Team API
key secrets `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
Windows signing is optional; configure both `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` together when it is introduced.

Local macOS package and cask preview only; it never uploads or publishes:

```bash
pnpm dist:brew --dry-run
```

On a fresh machine, install and authenticate `gh`. Never commit a DMG or other
package; `release.nosync/` is the only output root.

Known macOS failures:

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
- A rejected notarization must stop publication. Retrieve the notary log,
  repair every unsigned nested Mach-O or invalid entitlement, and rebuild from
  source; never patch an already signed bundle.

## Validation for Pipeline Changes

Run:

```bash
pnpm test:release-gate
pnpm test:package-inputs
pnpm test:macos-signing
pnpm test:windows-signing
pnpm test:updates
pnpm typecheck
```

Exercise the reusable tag/CI gate against matching, missing, active, failed,
and annotated-tag cases. Exercise missing, partial, conflicting, and complete
macOS credentials plus absent, partial, and complete optional Windows signing
credentials through focused contract tests. Any native
manifest or packaging change must pass the platform verifier and
`pnpm smoke:packaged-server` before publication.
