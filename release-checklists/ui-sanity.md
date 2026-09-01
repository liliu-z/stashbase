# Packaged UI Release Sanity

Run this short pass against release-candidate packages after source CI and the
platform packaging workflows succeed. It covers native, packaged, credentialed,
and media seams that the required Playwright suite intentionally does not fake.
It is not a second copy of the automated smoke suite.

`Jxx` labels refer to the stable product flows in
[`design-docs/user-journeys.md`](../design-docs/user-journeys.md). They show
which journey owns a residual check without duplicating the automated
coverage matrix.

Record one result per package/platform:

- Tag and commit SHA:
- CI run URL (successful for the exact commit):
- Coordinated Release workflow URL:
- Package/asset name and source:
- Platform and OS version:
- Tester and date:
- Start/end time (target: 10–15 minutes):
- Result: pass / fail / not applicable
- Evidence or issue links:
- Notes and every not-applicable reason:

For a release that changes retrieval ranking, chunking, an embedding model, or
provider integration, also record one complete `pnpm eval:semantic-retrieval`
report for each supported BYOK provider configured by the reviewer. Store the
reports with the release evidence and link them above. Reports must contain no
credentials. An `ACTIVE` failure blocks publication; a `CALIBRATION` report is
retained to establish the provider baseline and is not a passing gate.

Use a disposable folder and non-sensitive test documents. Do not paste tokens,
credentials, personal documents, or private Agent output into screenshots or
issue reports. Check an item only after observing the result; record a concise
reason when a platform cannot exercise it.

## Residual checks

- [ ] **J05** — When the retrieval-quality trigger above applies, select OpenAI
  in Settings, run `pnpm eval:semantic-retrieval --out <path>`, retain the
  complete report, then repeat with OpenRouter. While the dataset is in calibration, collect its
  declared minimum of three runs per provider; after activation, one run per
  provider is sufficient for an applicable release. Confirm each report names
  the commit evidence, dataset, provider, model, gate state, Recall@3, and MRR.
  Record a precise not-applicable reason only when the release did not cross a
  retrieval-quality trigger. A `CALIBRATION` gate state is expected until the
  baselines are complete and is not a failure; a report that names a dirty
  working tree, or a provider/model pair the dataset has no baseline for, is
  not usable evidence.

- [ ] **J01** — Install or unpack the release asset and launch it through the platform's
  normal path. Confirm one window appears and quits cleanly. On macOS, confirm
  Gatekeeper accepts the downloaded Developer ID-signed, notarized app without
  a security override; preserve the automated `codesign`, `spctl`, and stapler
  results with the release evidence.
- [ ] **J01** — On each platform, start from the previous published version N,
  point it at the ordinary stable release channel, and update to this candidate
  N+1. Leave a harmless edit open, click **Update** once, and confirm download,
  save-barrier handling, installation, automatic relaunch, the N+1 version, and
  exactly one running instance. Exercise macOS from the installed DMG app,
  Windows from NSIS, and Linux from AppImage; also exercise deb when it is a
  supported distribution path and record the expected administrator prompt.
  A unit-test updater double or a release-asset inventory is not evidence for
  this item. Record the observed N and N+1 versions plus the installed asset
  name; do not call the update path verified until every supported platform has
  a real result.
- [ ] **J02** — Use the real native folder picker: cancel once without changing the
  library, then add a disposable folder and confirm it opens.
- [ ] **J02 / J06** — Drag a real OS file or folder onto each supported drop target and confirm
  the intended import/attachment behavior and rejection feedback.
- [ ] **J01 / J03** — Exercise native menus and the platform shortcuts for Quick Open, Command
  Palette, search, Settings, window close, and quit. Confirm focus returns to a
  sensible control after dismissing an overlay, and confirm View exposes no
  Reload or Force Reload bypass.
- [ ] **J06** — With tester-owned credentials and an installed supported CLI, send one
  harmless Agent turn. Confirm streaming/activity, one permission or stop
  interaction when available, completion, and a clean close. Never use a real
  user workspace or capture credentials in evidence.
- [ ] **J05 / J07 / J10** — In a disposable project with one non-sensitive source and
  one Markdown Canvas, confirm Similarity Search returns the source, ask the real
  Agent to use that evidence and write an accepted result into the Canvas,
  approve the write, review and edit the file, then close and reopen it. Confirm
  Exact Search can find the new durable content. This is a packaged integration
  check, not the semantic-quality threshold owned by the J05 Eval.
- [ ] **J11** — From a Library-scoped Chat, explicitly ask the real Agent to create a
  disposable project. Decline the first `create_project` approval and confirm no
  folder or membership appears. Ask again and approve: confirm the ordinary
  folder is created under the configured owned root, the same Chat transcript
  remains selected and changes to the new project scope, the originating window
  enters the folder, and a harmless next turn stays in that scope. Remove its
  membership in StashBase after the check, then delete the disposable source
  folder through the external test setup rather than treating membership
  removal as filesystem deletion.
- [ ] **J06** — Paste one non-sensitive clipboard image into the Agent composer. Confirm
  the attachment preview appears, accompanying text remains, and the competing
  clipboard library-import offer does not appear.
- [ ] **J04** — With clipboard screenshot capture disabled in General Settings,
  copy one non-sensitive screenshot and confirm StashBase does not offer it.
  Enable capture, copy a new screenshot, explicitly add it, and confirm the
  visible image enters the chosen folder while its OCR becomes searchable.
  Disable capture again and confirm a later image creates no offer.
- [ ] **J09** — Open **Report a Bug…** from the native Help menu. Review the bounded
  screenshot/log previews, exclude one available artifact, prepare the report,
  and use Download. Confirm only the selected files appear in one new Downloads
  folder and nothing is submitted automatically. When browser access is safe,
  also confirm **Open GitHub** opens the prefilled issue without placing logs or
  local paths in the URL.
- [ ] **J03 / J04** — Open representative real PDF, DOCX, image, and audio fixtures in the
  packaged app on platforms where those formats ship. The automated journey
  uses synthetic/minimal fixtures; here confirm production rendering and, for
  audio, that play/pause and seeking produce sound and preserve control state.
- [ ] **J01 / J02 / J03** — Open a second window, switch folders, close both windows, relaunch, and
  confirm no orphan process/port, duplicate unexpected window, or lost save.

If a check fails, keep the candidate unpublished or stop the rollout, attach
sanitized evidence, and file the smallest reproducible issue. Re-run the failed
item and any adjacent native boundary after a replacement package is built.
