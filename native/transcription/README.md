# Audio transcription native toolchain

StashBase builds three native executables for each release target:
`whisper-cli`, `ffmpeg`, and `ffprobe`. Run:

```bash
pnpm build:transcription-sidecar
```

The build is host-native and supports `darwin-arm64`, `linux-x64`, and
`win32-x64` (the Windows build runs in an MSYS2 MINGW64 shell). Outputs live
under the gitignored `sidecar.nosync/<platform>-<arch>/` directory and are
copied into Electron resources at package time.

`toolchain.json` is the single machine-readable source for provider, source,
license, build-option, and platform-baseline versions. The build and packaging
gates both consume it.

The script pins and verifies source revisions, builds whisper.cpp without
shared project libraries or host-native CPU instructions, and builds FFmpeg
with statically linked libopus. macOS builds target 12.0 for every native
component and keep whisper.cpp's Metal/generic CPU backends while disabling its
newer-OS BLAS surface. Linux builds target the Ubuntu 22.04 ABI and reject
requirements newer than GLIBC 2.35 or GLIBCXX 3.4.30. FFmpeg GPL and nonfree
components are disabled. Packaging independently checks executable format,
platform baselines, every pinned manifest field, non-empty license notices,
and FFmpeg configure flags before accepting the tools.
