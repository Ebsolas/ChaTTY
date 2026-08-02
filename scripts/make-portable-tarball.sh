#!/usr/bin/env bash
# Build a FUSE-free portable tarball from the Tauri AppDir (for SteamOS, etc.).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DIST="${1:-dist-release}"
mkdir -p "$DIST"

APPDIR="$(find src-tauri/target/release/bundle/appimage -maxdepth 1 -type d -name '*.AppDir' 2>/dev/null | head -1 || true)"
if [[ -z "${APPDIR}" || ! -d "${APPDIR}/usr/bin" ]]; then
  echo "make-portable-tarball: no AppDir under bundle/appimage — skip" >&2
  exit 0
fi

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
if [[ -n "${PORTABLE_ARCH_LABEL:-}" ]]; then
  ARCH_LABEL="$PORTABLE_ARCH_LABEL"
else
  case "$(uname -m)" in
    x86_64|amd64) ARCH_LABEL=linux_x86_64 ;;
    aarch64|arm64) ARCH_LABEL=linux_aarch64 ;;
    *) ARCH_LABEL="linux_$(uname -m)" ;;
  esac
fi
NAME="Chatty_${VERSION}_${ARCH_LABEL}_portable"
OUT_DIR="${DIST}/${NAME}"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
cp -a "${APPDIR}/." "${OUT_DIR}/"

cat > "${OUT_DIR}/run-chatty.sh" <<'EOF'
#!/usr/bin/env bash
# Portable launcher — no AppImage mount / FUSE required (SteamOS-friendly).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export APPDIR="${HERE}"
export PATH="${HERE}/usr/bin:${PATH}"
# Steam Deck / some GPUs: WebKit can hard-crash without this.
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
if [[ -x "${HERE}/AppRun" ]]; then
  exec "${HERE}/AppRun" "$@"
fi
exec "${HERE}/usr/bin/chatty" "$@"
EOF
chmod +x "${OUT_DIR}/run-chatty.sh"
chmod +x "${OUT_DIR}/usr/bin/chatty" "${OUT_DIR}/usr/bin/chatty-host" 2>/dev/null || true
if [[ -x "${OUT_DIR}/AppRun" ]]; then
  chmod +x "${OUT_DIR}/AppRun"
fi

tar -C "${DIST}" -czf "${DIST}/${NAME}.tar.gz" "${NAME}"
rm -rf "${OUT_DIR}"
echo "make-portable-tarball: ${DIST}/${NAME}.tar.gz"
ls -lah "${DIST}/${NAME}.tar.gz"
