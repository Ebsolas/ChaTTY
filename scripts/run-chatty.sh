#!/usr/bin/env bash
# Launch Chatty with a graphical session (Wayland/X11).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/chatty"

if [[ ! -x "$BIN" ]]; then
  echo "Binary not found: $BIN" >&2
  echo "Build first:  cd $ROOT && npm run tauri build" >&2
  exit 1
fi

# Prefer existing session env; fall back to common defaults on this machine.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -z "${WAYLAND_DISPLAY:-}" && -z "${DISPLAY:-}" ]]; then
  if [[ -S "$XDG_RUNTIME_DIR/wayland-1" ]]; then
    export WAYLAND_DISPLAY=wayland-1
  elif [[ -S "$XDG_RUNTIME_DIR/wayland-0" ]]; then
    export WAYLAND_DISPLAY=wayland-0
  elif [[ -n "${DISPLAY:-}" ]]; then
    :
  else
    echo "No graphical display found (WAYLAND_DISPLAY/DISPLAY unset)." >&2
    echo "Run this from a terminal inside your desktop session (niri/wayland)." >&2
    exit 1
  fi
fi

# Prefer Wayland for webkit/gtk when available
if [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
  export GDK_BACKEND="${GDK_BACKEND:-wayland}"
fi

exec "$BIN" "$@"
