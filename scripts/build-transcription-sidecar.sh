#!/usr/bin/env bash
# Build the self-contained native audio toolchain shipped by StashBase.
#
# The versions and source digests are deliberately pinned. FFmpeg is built
# without GPL/nonfree components and is checked again after linking so a
# developer's Homebrew/MSYS installation can never leak into a release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="$REPO_ROOT/native/transcription/build.nosync"
SIDECAR_ROOT="$REPO_ROOT/native/transcription/sidecar.nosync"
TOOLCHAIN_FILE="$REPO_ROOT/native/transcription/toolchain.json"

if ! command -v node >/dev/null 2>&1; then
  echo "missing build dependency: node" >&2
  exit 1
fi
if [[ ! -f "$TOOLCHAIN_FILE" ]]; then
  echo "missing transcription toolchain manifest: $TOOLCHAIN_FILE" >&2
  exit 1
fi

toolchain_value() {
  node -e 'const fs = require("fs"); const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const value = info[process.argv[2]]; if (value === undefined || value === null || value === "") throw new Error(`missing toolchain field ${process.argv[2]}`); process.stdout.write(String(value));' "$TOOLCHAIN_FILE" "$1"
}

cmake_boolean() {
  case "$1" in
    true) printf 'ON' ;;
    false) printf 'OFF' ;;
    *) echo "toolchain boolean must be true or false, received: $1" >&2; exit 1 ;;
  esac
}

PROVIDER_ID="$(toolchain_value providerId)"
WHISPER_VERSION="$(toolchain_value whisperCppVersion)"
WHISPER_COMMIT="$(toolchain_value whisperCppCommit)"
GGML_NATIVE="$(toolchain_value ggmlNative)"
GGML_BLAS="$(toolchain_value ggmlBlas)"
GGML_NATIVE_CMAKE="$(cmake_boolean "$GGML_NATIVE")"
GGML_BLAS_CMAKE="$(cmake_boolean "$GGML_BLAS")"
FFMPEG_VERSION="$(toolchain_value ffmpegVersion)"
FFMPEG_SHA256="$(toolchain_value ffmpegSha256)"
FFMPEG_LICENSE="$(toolchain_value ffmpegLicense)"
OPUS_VERSION="$(toolchain_value opusVersion)"
OPUS_SHA256="$(toolchain_value opusSha256)"
MACOS_DEPLOYMENT_TARGET="$(toolchain_value macosDeploymentTarget)"
LINUX_GLIBC_BASELINE="$(toolchain_value linuxGlibcBaseline)"
LINUX_GLIBCXX_BASELINE="$(toolchain_value linuxGlibcxxBaseline)"

case "$(uname -s)" in
  Darwin) HOST_PLATFORM="darwin" ;;
  Linux) HOST_PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_PLATFORM="win32" ;;
  *) echo "unsupported transcription build host: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|amd64) HOST_ARCH="x64" ;;
  *) echo "unsupported transcription build architecture: $(uname -m)" >&2; exit 1 ;;
esac

TARGET="${STASHBASE_TRANSCRIPTION_TARGET:-$HOST_PLATFORM-$HOST_ARCH}"
if [[ "$TARGET" != "$HOST_PLATFORM-$HOST_ARCH" ]]; then
  echo "cross-compiling the transcription sidecar is not supported; build $TARGET on that target" >&2
  exit 1
fi
if [[ "$TARGET" != "darwin-arm64" && "$TARGET" != "linux-x64" && "$TARGET" != "win32-x64" ]]; then
  echo "unsupported release target: $TARGET" >&2
  exit 1
fi
if [[ "$HOST_PLATFORM" == "darwin" ]]; then
  export MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
fi

for command in cmake git curl tar make; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing build dependency: $command" >&2
    exit 1
  fi
done
if [[ "$HOST_PLATFORM" == "linux" ]]; then
  for command in objdump ldd; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "missing Linux ABI verification dependency: $command" >&2
      exit 1
    fi
  done
fi
if [[ "$HOST_PLATFORM" == "win32" && "${MSYSTEM:-}" != "MINGW64" ]]; then
  echo "Windows transcription builds must run in an MSYS2 MINGW64 shell" >&2
  exit 1
fi

JOBS="${STASHBASE_TRANSCRIPTION_BUILD_JOBS:-4}"
OUT="$SIDECAR_ROOT/$TARGET"
DOWNLOADS="$BUILD_ROOT/downloads"
SRC="$BUILD_ROOT/src"
PREFIX="$BUILD_ROOT/prefix/$TARGET"
BUILD="$BUILD_ROOT/work/$TARGET"
cmake -E remove_directory "$OUT"
cmake -E remove_directory "$PREFIX"
mkdir -p "$OUT" "$DOWNLOADS" "$SRC" "$PREFIX" "$BUILD"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

download_checked() {
  local url="$1"
  local destination="$2"
  local expected="$3"
  if [[ -f "$destination" && "$(sha256_file "$destination")" == "$expected" ]]; then
    return
  fi
  local partial="${destination}.part"
  curl --fail --location --retry 4 --retry-all-errors --continue-at - --output "$partial" "$url"
  local actual
  actual="$(sha256_file "$partial")"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$partial"
    echo "checksum mismatch for $url: $actual" >&2
    exit 1
  fi
  mv "$partial" "$destination"
}

WHISPER_SRC="$SRC/whisper.cpp"
if [[ ! -d "$WHISPER_SRC/.git" ]]; then
  cmake -E remove_directory "$WHISPER_SRC"
  git clone --filter=blob:none --no-checkout https://github.com/ggml-org/whisper.cpp.git "$WHISPER_SRC"
fi
if ! git -C "$WHISPER_SRC" cat-file -e "$WHISPER_COMMIT^{commit}" 2>/dev/null; then
  git -C "$WHISPER_SRC" fetch --depth 1 origin "$WHISPER_COMMIT"
fi
git -C "$WHISPER_SRC" checkout --detach --force "$WHISPER_COMMIT"
if [[ "$(git -C "$WHISPER_SRC" rev-parse HEAD)" != "$WHISPER_COMMIT" ]]; then
  echo "whisper.cpp source verification failed" >&2
  exit 1
fi

WHISPER_BUILD="$BUILD/whisper"
CMAKE_GENERATOR_NAME="Unix Makefiles"
if command -v ninja >/dev/null 2>&1; then CMAKE_GENERATOR_NAME="Ninja"; fi
WHISPER_CMAKE_ARGS=(
  -G "$CMAKE_GENERATOR_NAME"
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  "-DGGML_NATIVE=$GGML_NATIVE_CMAKE"
  "-DGGML_BLAS=$GGML_BLAS_CMAKE"
  -DGGML_OPENMP=OFF
  -DGGML_METAL_EMBED_LIBRARY=ON
)
if [[ "$HOST_PLATFORM" == "darwin" ]]; then
  WHISPER_CMAKE_ARGS+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$MACOS_DEPLOYMENT_TARGET")
fi
if [[ "$HOST_PLATFORM" == "win32" ]]; then
  WHISPER_CMAKE_ARGS+=(
    "-DCMAKE_C_FLAGS=-static-libgcc"
    "-DCMAKE_CXX_FLAGS=-static-libgcc -static-libstdc++"
    "-DCMAKE_EXE_LINKER_FLAGS=-static"
  )
fi
cmake -S "$WHISPER_SRC" -B "$WHISPER_BUILD" "${WHISPER_CMAKE_ARGS[@]}"
for setting in "GGML_NATIVE:BOOL=$GGML_NATIVE_CMAKE" "GGML_BLAS:BOOL=$GGML_BLAS_CMAKE"; do
  if ! grep -Fx "$setting" "$WHISPER_BUILD/CMakeCache.txt" >/dev/null; then
    echo "whisper.cpp CMake cache did not retain required setting $setting" >&2
    exit 1
  fi
done
cmake --build "$WHISPER_BUILD" --config Release --target whisper-cli --parallel "$JOBS"

OPUS_ARCHIVE="$DOWNLOADS/opus-$OPUS_VERSION.tar.gz"
OPUS_SRC="$SRC/opus-$OPUS_VERSION"
download_checked \
  "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" \
  "$OPUS_ARCHIVE" \
  "$OPUS_SHA256"
cmake -E remove_directory "$OPUS_SRC"
tar -xzf "$OPUS_ARCHIVE" -C "$SRC"
OPUS_BUILD="$BUILD/opus"
cmake -E remove_directory "$OPUS_BUILD"
OPUS_CMAKE_ARGS=(
  -G "$CMAKE_GENERATOR_NAME"
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DBUILD_SHARED_LIBS=OFF
  -DOPUS_BUILD_PROGRAMS=OFF
  -DOPUS_BUILD_TESTING=OFF
  -DOPUS_INSTALL_PKG_CONFIG_MODULE=ON
)
if [[ "$HOST_PLATFORM" == "darwin" ]]; then
  OPUS_CMAKE_ARGS+=("-DCMAKE_OSX_DEPLOYMENT_TARGET=$MACOS_DEPLOYMENT_TARGET")
fi
cmake -S "$OPUS_SRC" -B "$OPUS_BUILD" "${OPUS_CMAKE_ARGS[@]}"
cmake --build "$OPUS_BUILD" --config Release --parallel "$JOBS"
cmake --install "$OPUS_BUILD" --config Release

FFMPEG_ARCHIVE="$DOWNLOADS/ffmpeg-$FFMPEG_VERSION.tar.xz"
FFMPEG_SRC="$SRC/ffmpeg-$FFMPEG_VERSION"
download_checked \
  "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
  "$FFMPEG_ARCHIVE" \
  "$FFMPEG_SHA256"
cmake -E remove_directory "$FFMPEG_SRC"
tar -xJf "$FFMPEG_ARCHIVE" -C "$SRC"
FFMPEG_BUILD="$BUILD/ffmpeg"
cmake -E remove_directory "$FFMPEG_BUILD"
mkdir -p "$FFMPEG_BUILD"

FFMPEG_EXTRA_LDFLAGS="-L$PREFIX/lib"
FFMPEG_EXTRA_CFLAGS="-I$PREFIX/include"
if [[ "$HOST_PLATFORM" == "win32" ]]; then
  FFMPEG_EXTRA_LDFLAGS="$FFMPEG_EXTRA_LDFLAGS -static"
elif [[ "$HOST_PLATFORM" == "darwin" ]]; then
  FFMPEG_EXTRA_CFLAGS="$FFMPEG_EXTRA_CFLAGS -mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET"
  FFMPEG_EXTRA_LDFLAGS="$FFMPEG_EXTRA_LDFLAGS -mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET"
fi
(
  cd "$FFMPEG_BUILD"
  PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" "$FFMPEG_SRC/configure" \
    --prefix="$PREFIX/ffmpeg" \
    --pkg-config-flags=--static \
    --extra-cflags="$FFMPEG_EXTRA_CFLAGS" \
    --extra-ldflags="$FFMPEG_EXTRA_LDFLAGS" \
    --enable-static \
    --disable-shared \
    --disable-doc \
    --disable-debug \
    --disable-network \
    --disable-autodetect \
    --disable-gpl \
    --disable-nonfree \
    --disable-ffplay \
    --enable-libopus \
    --disable-everything \
    --enable-ffmpeg \
    --enable-ffprobe \
    --enable-protocol=file,pipe \
    --enable-demuxer=aac,aiff,flac,matroska,mov,mp3,ogg,wav \
    --enable-decoder=aac,aac_fixed,alac,flac,libopus,mp3,mp3float,opus,vorbis,pcm_alaw,pcm_mulaw,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_s8,pcm_u8,pcm_u16be,pcm_u16le,pcm_u24be,pcm_u24le,pcm_u32be,pcm_u32le \
    --enable-encoder=libopus,pcm_s16le \
    --enable-parser=aac,aac_latm,flac,mpegaudio,opus,vorbis \
    --enable-muxer=wav,webm \
    --enable-filter=abuffer,abuffersink,aformat,anull,aresample
  make -j"$JOBS"
)

EXE_SUFFIX=""
if [[ "$HOST_PLATFORM" == "win32" ]]; then EXE_SUFFIX=".exe"; fi
WHISPER_BIN="$WHISPER_BUILD/bin/whisper-cli$EXE_SUFFIX"
FFMPEG_BIN="$FFMPEG_BUILD/ffmpeg$EXE_SUFFIX"
FFPROBE_BIN="$FFMPEG_BUILD/ffprobe$EXE_SUFFIX"
for binary in "$WHISPER_BIN" "$FFMPEG_BIN" "$FFPROBE_BIN"; do
  if [[ ! -x "$binary" ]]; then
    echo "expected native tool was not built: $binary" >&2
    exit 1
  fi
done

cp "$WHISPER_BIN" "$OUT/whisper-cli$EXE_SUFFIX"
cp "$FFMPEG_BIN" "$OUT/ffmpeg$EXE_SUFFIX"
cp "$FFPROBE_BIN" "$OUT/ffprobe$EXE_SUFFIX"
cp "$WHISPER_SRC/LICENSE" "$OUT/LICENSE.whisper.cpp"
cp "$FFMPEG_SRC/COPYING.LGPLv2.1" "$OUT/COPYING.FFmpeg.LGPLv2.1"
cp "$FFMPEG_SRC/COPYING.LGPLv3" "$OUT/COPYING.FFmpeg.LGPLv3"
cp "$OPUS_SRC/COPYING" "$OUT/LICENSE.Opus"

cat > "$OUT/THIRD_PARTY_NOTICES.txt" <<EOF
StashBase audio transcription native components

whisper.cpp $WHISPER_VERSION ($WHISPER_COMMIT)
License: MIT — see LICENSE.whisper.cpp
Source: https://github.com/ggml-org/whisper.cpp

FFmpeg $FFMPEG_VERSION
License: LGPL-2.1-or-later — see COPYING.FFmpeg.LGPLv2.1 and COPYING.FFmpeg.LGPLv3
Configuration: static libraries, libopus enabled, GPL/nonfree components disabled
Source: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz

libopus $OPUS_VERSION
License: BSD-3-Clause — see LICENSE.Opus
Source: https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz
EOF

cat > "$OUT/build-info.json" <<EOF
{
  "target": "$TARGET",
  "providerId": "$PROVIDER_ID",
  "whisperCppVersion": "$WHISPER_VERSION",
  "whisperCppCommit": "$WHISPER_COMMIT",
  "ggmlNative": $GGML_NATIVE,
  "ggmlBlas": $GGML_BLAS,
  "ffmpegVersion": "$FFMPEG_VERSION",
  "ffmpegLicense": "$FFMPEG_LICENSE",
  "opusVersion": "$OPUS_VERSION",
  "macosDeploymentTarget": $([[ "$HOST_PLATFORM" == "darwin" ]] && printf '"%s"' "$MACOS_DEPLOYMENT_TARGET" || printf 'null'),
  "linuxGlibcBaseline": $([[ "$HOST_PLATFORM" == "linux" ]] && printf '"%s"' "$LINUX_GLIBC_BASELINE" || printf 'null'),
  "linuxGlibcxxBaseline": $([[ "$HOST_PLATFORM" == "linux" ]] && printf '"%s"' "$LINUX_GLIBCXX_BASELINE" || printf 'null')
}
EOF

FFMPEG_VERSION_OUTPUT="$("$OUT/ffmpeg$EXE_SUFFIX" -version 2>&1)"
if [[ "$FFMPEG_VERSION_OUTPUT" == *"--enable-gpl"* || "$FFMPEG_VERSION_OUTPUT" == *"--enable-nonfree"* ]]; then
  echo "refusing to stage a GPL/nonfree FFmpeg build" >&2
  exit 1
fi
for required_flag in --disable-gpl --disable-nonfree --enable-libopus; do
  if [[ "$FFMPEG_VERSION_OUTPUT" != *"$required_flag"* ]]; then
    echo "staged FFmpeg is missing required configuration flag: $required_flag" >&2
    exit 1
  fi
done
"$OUT/ffprobe$EXE_SUFFIX" -version >/dev/null
"$OUT/whisper-cli$EXE_SUFFIX" --help >/dev/null 2>&1

if [[ "$HOST_PLATFORM" == "darwin" ]]; then
  for binary in "$OUT/whisper-cli" "$OUT/ffmpeg" "$OUT/ffprobe"; do
    MIN_OS="$(otool -l "$binary" | awk '$1 == "minos" { print $2; exit }')"
    if [[ "$MIN_OS" != "$MACOS_DEPLOYMENT_TARGET" && "$MIN_OS" != "$MACOS_DEPLOYMENT_TARGET.0" ]]; then
      echo "native tool $(basename "$binary") targets macOS $MIN_OS, expected $MACOS_DEPLOYMENT_TARGET" >&2
      exit 1
    fi
  done
  if otool -L "$OUT/whisper-cli" "$OUT/ffmpeg" "$OUT/ffprobe" | grep -F "$BUILD_ROOT"; then
    echo "native tools retain a dependency on the build directory" >&2
    exit 1
  fi
elif [[ "$HOST_PLATFORM" == "linux" ]]; then
  if ldd "$OUT/whisper-cli" "$OUT/ffmpeg" "$OUT/ffprobe" 2>&1 | grep -F "not found"; then
    echo "native tools have unresolved shared-library dependencies" >&2
    exit 1
  fi
  version_is_above() {
    local actual="$1"
    local baseline="$2"
    [[ -n "$actual" && "$actual" != "$baseline" && "$(printf '%s\n%s\n' "$baseline" "$actual" | sort -V | tail -n 1)" == "$actual" ]]
  }
  maximum_required_symbol() {
    local binary="$1"
    local family="$2"
    { objdump -T "$binary" 2>/dev/null \
      | grep -oE "${family}_[0-9]+(\\.[0-9]+)+" \
      | sed "s/^${family}_//" \
      | sort -V \
      | tail -n 1; } || true
  }
  for binary in "$OUT/whisper-cli" "$OUT/ffmpeg" "$OUT/ffprobe"; do
    REQUIRED_GLIBC="$(maximum_required_symbol "$binary" GLIBC)"
    REQUIRED_GLIBCXX="$(maximum_required_symbol "$binary" GLIBCXX)"
    if version_is_above "$REQUIRED_GLIBC" "$LINUX_GLIBC_BASELINE"; then
      echo "$(basename "$binary") requires GLIBC_$REQUIRED_GLIBC, above baseline $LINUX_GLIBC_BASELINE" >&2
      exit 1
    fi
    if version_is_above "$REQUIRED_GLIBCXX" "$LINUX_GLIBCXX_BASELINE"; then
      echo "$(basename "$binary") requires GLIBCXX_$REQUIRED_GLIBCXX, above baseline $LINUX_GLIBCXX_BASELINE" >&2
      exit 1
    fi
  done
elif command -v objdump >/dev/null 2>&1; then
  if objdump -p "$OUT/whisper-cli.exe" "$OUT/ffmpeg.exe" "$OUT/ffprobe.exe" \
    | grep -Ei 'DLL Name: (libgcc|libstdc\+\+|libwinpthread)'; then
    echo "Windows native tools retain a MinGW runtime DLL dependency" >&2
    exit 1
  fi
fi

echo "[build:transcription-sidecar] verified $TARGET -> $OUT"
