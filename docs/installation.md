# Installation

Download installers from the official
[StashBase Releases](https://github.com/liliu-z/stashbase/releases/latest) page.

## macOS

Macs running macOS 12 or later can open StashBase. Starting with v2.9.5,
separate Apple Silicon and Intel installers are available; arm64 installers
cannot run on Intel Macs. Homebrew selects the matching architecture:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

Or download `StashBase-*-mac-arm64.dmg` for Apple Silicon, or
`StashBase-*-mac-x64.dmg` for Intel, drag the app to **Applications**, and
open it there. Published macOS artifacts are signed with Apple Developer ID
and notarized by Apple.

On Intel Macs running macOS 12–14, project browsing and file editing remain
available, while local search and PDF/image text extraction are unavailable.
Those native components require macOS 15 or later. An unavailable component
does not block app startup or saving a document. Agent providers have their own
runtime requirements and may be unavailable on older systems.

## Windows

On Windows 10 or later (x64), download `StashBase-*-win-x64.exe`, run it, and
follow the installer prompts.

If SmartScreen appears, verify that the installer came from the official
Releases page. **More info → Run anyway** lets you continue if you choose to
trust that installer. A verified download source alone does not establish that
an antivirus detection is a false positive; report persistent blocks rather
than disabling antivirus protection.

## Linux

Linux is community-supported. On x86_64 Debian 12+ or Ubuntu 22.04+, download
`StashBase-*-linux-amd64.deb` and install with `apt` so required system packages
are resolved:

```bash
sudo apt install ./StashBase-*-linux-amd64.deb
```

For a portable build, download `StashBase-*-linux-*.AppImage`, make that file
executable with `chmod +x`, and run it directly.

## Updating and Uninstalling

Quit StashBase before updating. For Homebrew installations, run
`brew upgrade --cask stashbase`. Otherwise, run the newer installer over the
existing installation; on Linux, repeat the `apt install` command with the new
package. Your Projects and settings are preserved.

To uninstall:

- **macOS:** remove StashBase from Applications, or use
  `brew uninstall --cask stashbase` for a Homebrew installation.
- **Windows:** open **Settings → Apps**, then find StashBase under
  **Installed apps** (Windows 11) or **Apps & features** (Windows 10).
- **Linux:** run `sudo apt remove stashbase`, or delete the portable AppImage.

Uninstalling the app does not delete your source files.

## Troubleshooting

### Windows installer will not start

Check that you downloaded the `.exe` installer. Download a fresh copy from the
official Releases page if it is incomplete. If installation still fails, report
the error and Windows version in the
[Discord community](https://discord.gg/zsRZH4PTq9).

### macOS blocks or rejects the app

For “not supported on this Mac,” check **Apple menu → About This Mac** and
download the DMG matching the chip: Intel needs x64; M-series chips need arm64.
The Electron application itself requires macOS 12 or later.

Delete that copy and download the current DMG again from the official Releases
page. Do not bypass Gatekeeper for an artifact that still reports a signing or
malware-verification problem; report the StashBase and macOS versions.

### App will not launch

Try restarting your computer, then reinstalling the latest version. Include
any error message and your platform when asking the community for help.

### Cannot find the installed app

- **Windows:** press the Windows key and search for StashBase.
- **macOS:** open Finder → Applications.
- **Linux:** run `stashbase` in a terminal or find it in the applications menu.
  A portable AppImage is launched from its downloaded location.

### Disk space is running low

Prepared text, downloaded PDF/OCR components, and search indexes need local
disk space. Removing a folder from the project registry clears its
StashBase-owned index and derived data without deleting the source files.

Continue with [Start Writing](../README.md#start-a-project).
