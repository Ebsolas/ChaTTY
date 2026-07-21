#!/usr/bin/env bash
# Build Chatty for Linux and produce AppImage (+ deb when possible).
# On some hosts (e.g. Arch aarch64) Tauri's linuxdeploy gtk plugin fails path
# assumptions; we fall back to packing the prepared AppDir with appimagetool.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"
export CI="${CI:-true}"

echo "==> Staging chatty-host sidecar"
npm run stage:host

echo "==> Tauri release build (appimage + deb)"
set +e
npm run tauri build
TAURI_RC=$?
set -e

BUNDLE="$ROOT/src-tauri/target/release/bundle"
APPIMAGE_DIR="$BUNDLE/appimage"
APPDIR="$APPIMAGE_DIR/Chatty.AppDir"

shopt -s nullglob
EXISTING=( "$APPIMAGE_DIR"/Chatty_*.AppImage )
if ((${#EXISTING[@]} > 0)); then
  echo "==> AppImage ready:"
  ls -lah "${EXISTING[@]}"
  exit 0
fi

if [[ ! -d "$APPDIR/usr/bin" ]]; then
  echo "package-linux: tauri build failed (exit $TAURI_RC) and no AppDir to recover" >&2
  exit "${TAURI_RC:-1}"
fi

echo "==> Tauri linuxdeploy failed; packing AppDir with appimagetool fallback"

# Ensure chatty-host is present (externalBin should have copied it).
if [[ ! -x "$APPDIR/usr/bin/chatty-host" ]]; then
  TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  STAGED="$ROOT/src-tauri/binaries/chatty-host-${TRIPLE}"
  if [[ -f "$STAGED" ]]; then
    cp -f "$STAGED" "$APPDIR/usr/bin/chatty-host"
    chmod +x "$APPDIR/usr/bin/chatty-host"
  else
    echo "package-linux: chatty-host missing from AppDir and binaries/" >&2
    exit 1
  fi
fi

# Desktop + icon (appimagetool is picky about names / absolute symlinks).
VERSION="$(
  node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "0.1.0"
)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_LABEL=amd64 ;;
  aarch64|arm64) ARCH_LABEL=aarch64 ;;
  *) ARCH_LABEL="$ARCH" ;;
esac

DESKTOP_BODY="[Desktop Entry]
Categories=Utility;System;TerminalEmulator;
Comment=Conversational terminal — Discord-style chat over shell sessions
Exec=chatty
StartupWMClass=chatty
Icon=chatty
Name=Chatty
Terminal=false
Type=Application
"
# Break absolute symlinks Tauri sometimes leaves for the desktop entry.
rm -f "$APPDIR/Chatty.desktop" "$APPDIR/usr/share/applications/Chatty.desktop"
mkdir -p "$APPDIR/usr/share/applications"
printf '%s\n' "$DESKTOP_BODY" > "$APPDIR/Chatty.desktop"
printf '%s\n' "$DESKTOP_BODY" > "$APPDIR/usr/share/applications/Chatty.desktop"

if [[ -f "$APPDIR/Chatty.png" ]]; then
  cp -f "$APPDIR/Chatty.png" "$APPDIR/chatty.png"
elif [[ -f "$ROOT/src-tauri/icons/128x128.png" ]]; then
  cp -f "$ROOT/src-tauri/icons/128x128.png" "$APPDIR/chatty.png"
fi
ln -sfn chatty.png "$APPDIR/.DirIcon" 2>/dev/null || true

PLUGIN="${HOME}/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"
if [[ ! -x "$PLUGIN" ]]; then
  echo "package-linux: missing $PLUGIN (run a tauri appimage build once to download tools)" >&2
  exit 1
fi

OUT_NAME="Chatty_${VERSION}_${ARCH_LABEL}.AppImage"
export ARCH
export LDAI_OUTPUT="$OUT_NAME"
export OUTPUT="$OUT_NAME"
(
  cd "$APPIMAGE_DIR"
  "$PLUGIN" --appdir=Chatty.AppDir
)

FINAL="$APPIMAGE_DIR/$OUT_NAME"
if [[ ! -f "$FINAL" ]]; then
  # Plugin may write a differently cased name
  FOUND=( "$APPIMAGE_DIR"/Chatty_*.AppImage )
  if ((${#FOUND[@]} > 0)); then
    FINAL="${FOUND[0]}"
  else
    echo "package-linux: appimagetool did not produce an AppImage" >&2
    exit 1
  fi
fi

chmod +x "$FINAL"
echo "==> AppImage (fallback pack):"
ls -lah "$FINAL"
