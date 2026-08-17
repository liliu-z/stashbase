# macOS Developer ID Signing and Notarization

Research date: 2026-08-17

## Conclusion

The Gatekeeper dialog was expected from the pre-implementation release pipeline: StashBase explicitly set `mac.identity` to `null`, disabled Hardened Runtime and certificate discovery, and applied only an ad-hoc (`codesign --sign -`) signature. An ad-hoc signature has no Apple Team ID, while direct distribution requires a real **Developer ID Application** identity and notarization. The implemented pipeline now enables those controls in [`package.json`](../package.json), prepares the bundle before its final signature in [`scripts/after-pack-macos.cjs`](../scripts/after-pack-macos.cjs), and enforces release credentials through [`scripts/macos-release-contract.mjs`](../scripts/macos-release-contract.mjs). [electron-builder: Code Signing for macOS](https://www.electron.build/docs/features/code-signing/code-signing-mac/)

An Apple Developer Program account is necessary but does not by itself change the artifact. The release build must complete four distinct operations: sign every executable in the app with Developer ID, enable Hardened Runtime with the required entitlements and secure timestamps, submit the signed app to Apple's notary service, then staple the accepted ticket before publishing. Apple requires Developer ID signing, Hardened Runtime, secure timestamps, valid signatures on all executables, and no true `com.apple.security.get-task-allow` entitlement for new software submitted to notarization. [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## One-time Apple account setup

1. The team's Account Holder creates a **Developer ID Application** certificate in Certificates, Identifiers & Profiles. Apple currently restricts creation of manually managed Developer ID certificates to the Account Holder; the certificate is specifically the type used to sign a Mac app distributed outside the Mac App Store. A **Developer ID Installer** certificate is only for a signed Mac Installer Package, so StashBase does not need one while it ships DMG and ZIP rather than PKG. [Apple: Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
2. Create the CSR on the Mac that will hold the signing private key, download the resulting `.cer`, and install it in Keychain Access. Apple's CSR flow creates the local key pair, and the downloaded certificate appears in Keychain Access after installation. [Apple: Create a certificate signing request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request), [Apple: Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
3. In Keychain Access, export the Developer ID Application identity together with its private key as a password-protected `.p12`. The `.cer` alone is insufficient for CI signing because the signer also needs the private key. Apple documents exporting certificates and keys and protecting the exported item with a password; electron-builder uses the exported `.p12` for CI. [Apple: Import and export keychain items](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac), [electron-builder: GitHub Actions macOS signing setup](https://www.electron.build/docs/features/github-actions/#macos-code-signing-setup)
4. Enable App Store Connect API access if the team has not already done so. The Account Holder requests initial API access; after approval, an Account Holder or Admin can create a Team API key. Apple says a Team key applies across all apps and its private `.p8` key can be downloaded only once, so use a dedicated CI key, store it securely, and revoke it if it is lost or exposed. [Apple: App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api), [Apple: Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
5. For the dependency currently resolved in this repository (`@electron/notarize` 2.5.0 through electron-builder), create a **Team Key**, not an Individual Key, with App Manager access. The pinned integration requires the `.p8` file path, Key ID, and Issuer ID. Apple also documents `notarytool` authentication with an App Store Connect API key using `--key`, `--key-id`, and `--issuer`. [@electron/notarize 2.5.0: API-key authentication](https://github.com/electron/notarize/blob/v2.5.0/README.md#usage-with-app-store-connect-api-key), [Apple TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)

## Recommended CI credentials

Use two independent credentials. The Developer ID `.p12` performs code signing; the App Store Connect `.p8` authenticates the notarization upload. Neither replaces the other. electron-builder recommends API-key authentication for CI and supports automatic signing, notarization, and stapling when the credentials and macOS configuration are present. [electron-builder: macOS Notarization](https://www.electron.build/docs/notarization/), [electron-builder: macOS configuration](https://www.electron.build/mac/)

Store these as GitHub Actions secrets:

| Secret | Purpose | Runtime value |
|---|---|---|
| `MAC_CSC_LINK` | Developer ID signing identity | Base64-encoded password-protected `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Decrypts the `.p12` | The `.p12` export password |
| `APPLE_API_KEY_P8` | Notary-service private key | Base64-encoded contents of `AuthKey_<KEY_ID>.p8` |
| `APPLE_API_KEY_ID` | Identifies the API key | The 10-character Key ID |
| `APPLE_API_ISSUER` | Identifies the App Store Connect issuer | The Issuer UUID |

electron-builder can consume the base64 `.p12` directly as `CSC_LINK` and creates a temporary keychain on CI. Set `forceCodeSigning: true` for release builds so a missing or invalid certificate fails closed instead of silently emitting an unsigned artifact. [electron-builder: GitHub Actions macOS signing setup](https://www.electron.build/docs/features/github-actions/#macos-code-signing-setup), [electron-builder: `forceCodeSigning`](https://www.electron.build/docs/configuration/#forcecodesigning)

For the currently pinned integration, `APPLE_API_KEY` must be an **absolute file path**, not the base64 text itself. Decode `APPLE_API_KEY_P8` into a file under `$RUNNER_TEMP`, set `APPLE_API_KEY` to that path, and pass `APPLE_API_KEY_ID` plus `APPLE_API_ISSUER` to the packaging process. The current online electron-builder notarization page shows base64 text assigned directly to `APPLE_API_KEY`, but `@electron/notarize` 2.5.0—the version resolved here—explicitly requires a file path, so the pinned dependency's contract should control the implementation. [@electron/notarize 2.5.0: API-key authentication](https://github.com/electron/notarize/blob/v2.5.0/README.md#usage-with-app-store-connect-api-key), [electron-builder: notarization environment variables](https://www.electron.build/mac/#notarize)

An indicative preparation step is:

```yaml
- name: Prepare Apple notarization key
  shell: bash
  env:
    APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}
    APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
  run: |
    key_path="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
    printf '%s' "$APPLE_API_KEY_P8" | base64 -D > "$key_path"
    chmod 600 "$key_path"
    echo "APPLE_API_KEY=$key_path" >> "$GITHUB_ENV"
```

The release build then receives `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Do not commit either private key or print it in logs. Apple treats API private keys as credentials and directs teams to revoke a compromised key immediately. [Apple: Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)

## Applied repository changes

The implementation applies the research as follows:

1. Release builds no longer force the unsigned path. They enable identity discovery, pass `forceCodeSigning: true`, validate one complete notarization credential set, and preserve extended-attribute cleanup only before signing. electron-builder automatically selects a valid Developer ID Application identity from `CSC_LINK` and signs nested frameworks and helpers. [electron-builder: Code Signing for macOS](https://www.electron.build/docs/features/code-signing/code-signing-mac/)
2. `mac.hardenedRuntime`, `mac.notarize`, and explicit main/inherited entitlements are enabled. Apple requires Hardened Runtime for the app and command-line targets submitted to notarization. [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [electron-builder: macOS Notarization](https://www.electron.build/docs/notarization/)
3. The entitlement set retains `com.apple.security.cs.allow-jit`, removes `com.apple.security.cs.allow-unsigned-executable-memory`, and never enables `com.apple.security.get-task-allow`. `com.apple.security.cs.disable-library-validation` remains while packaged native runtime compatibility is verified. [@electron/notarize 2.5.0 prerequisites](https://github.com/electron/notarize/blob/v2.5.0/README.md#prerequisites), [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
4. The release verifier checks the mounted final DMG app with `codesign`, `spctl`, and stapler, covering Electron helpers, native modules, Python sidecars, transcription tools, FFmpeg, and other nested Mach-O files through the final signature graph. [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [electron-builder: macOS Notarization troubleshooting](https://www.electron.build/docs/notarization/#troubleshooting)
5. `dmg.sign: false` remains because the application inside the DMG carries the Developer ID signature and notarization ticket; a Developer ID Installer certificate is relevant to PKG rather than DMG distribution. [electron-builder: DMG `sign`](https://www.electron.build/configuration/dmg/#sign), [Apple: Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
6. The unsigned-only `Fix.sh`, hidden ad-hoc signer, Homebrew re-signing hook, and unsigned release text are retired so no post-signing step can invalidate the Developer ID identity or notarization ticket.

## Release order and acceptance gates

The release job should run on macOS with current Xcode command-line tools, then perform:

```text
package all app contents
→ Developer ID sign every executable with Hardened Runtime and secure timestamp
→ verify the signed app
→ submit with notarytool and wait for Accepted
→ staple the ticket to the app
→ create DMG/ZIP from the signed, stapled app
→ smoke-test the packaged app
→ publish artifacts
```

Apple no longer accepts notarization uploads from `altool`; use `notarytool`. Apple recommends waiting for the submission result, checking the notarization log even when the request succeeds, and stapling the ticket so Gatekeeper can verify the software while offline. [Apple: Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [Apple TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)

Before upload, the extracted app from the final DMG should pass:

```sh
codesign --verify --deep --strict --verbose=2 "/path/to/StashBase.app"
spctl --assess --verbose --type exec "/path/to/StashBase.app"
xcrun stapler validate "/path/to/StashBase.app"
```

The expected Gatekeeper source is `Notarized Developer ID`. These checks respectively validate the signature graph, Gatekeeper's launch assessment, and the stapled ticket. electron-builder lists these commands as the post-build verification path. [electron-builder: Testing Notarization](https://www.electron.build/docs/notarization/#testing-notarization)

Finally, test the downloaded release artifact on a clean macOS user or clean VM. Apple's notary process is automated malware and code-signing analysis rather than App Review, so a successful submission does not replace launch and feature testing. [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
