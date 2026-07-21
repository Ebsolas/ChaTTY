#!/usr/bin/env bash
# Build chatty-host and stage it for Tauri externalBin packaging.
# Tauri expects: src-tauri/binaries/chatty-host-<target-triple>
#
# Note: tauri-build fails the whole crate if the sidecar path is missing, so we
# bootstrap a stub file before the first real cargo build, then overwrite it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/src-tauri"

TRIPLE="${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
if [[ -z "$TRIPLE" ]]; then
  echo "stage-host-bin: could not determine target triple" >&2
  exit 1
fi

mkdir -p binaries
DEST="binaries/chatty-host-${TRIPLE}"
if [[ "$TRIPLE" == *windows* || "$TRIPLE" == *msvc* || "$TRIPLE" == *pc-windows* ]]; then
  DEST="${DEST}.exe"
fi

# Bootstrap so `cargo build` / tauri-build can resolve externalBin.
if [[ ! -f "$DEST" ]]; then
  echo "stage-host-bin: creating bootstrap stub at $DEST"
  if [[ "$DEST" == *.exe ]]; then
    # Minimal placeholder; replaced after cargo build.
    : > "$DEST"
  else
    printf '#!/bin/sh\necho "chatty-host bootstrap — rebuild with scripts/stage-host-bin.sh" >&2\nexit 1\n' > "$DEST"
    chmod +x "$DEST"
  fi
fi

echo "stage-host-bin: building chatty-host ($TRIPLE)…"
if [[ -n "${CARGO_BUILD_TARGET:-}" ]]; then
  cargo build --release --bin chatty-host --target "$CARGO_BUILD_TARGET"
  SRC="target/${CARGO_BUILD_TARGET}/release/chatty-host"
else
  cargo build --release --bin chatty-host
  SRC="target/release/chatty-host"
fi

if [[ ! -f "$SRC" && -f "${SRC}.exe" ]]; then
  SRC="${SRC}.exe"
fi
if [[ ! -f "$SRC" ]]; then
  echo "stage-host-bin: missing built binary at $SRC" >&2
  exit 1
fi

cp -f "$SRC" "$DEST"
chmod +x "$DEST" 2>/dev/null || true
echo "stage-host-bin: staged $DEST ($(wc -c < "$DEST") bytes)"
