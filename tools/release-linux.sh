#!/usr/bin/env bash
# Linux half of tools/release-desktop.sh: builds the AppImage (the updater artifact, signed) and the .deb in the WSL 2 distro
# vokko-linux from this checkout's HEAD and copies them to <out dir>. Uploads nothing, so it doubles as a dry run:
#   tools/release-linux.sh 0.1.8 E:/cargo-target/vokko-release/linux
# Setup of the distro (Ubuntu 22.04, user toolchains, ~/vokko clone): docs/desktop-release.md "Linux".
set -euo pipefail
VERSION=${1:?usage: release-linux.sh <version> <out dir>}
OUT=${2:?usage: release-linux.sh <version> <out dir>}
DISTRO=vokko-linux
cd "$(git rev-parse --show-toplevel)"
mkdir -p "$OUT"
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite the /paths inside the WSL command line
# wsl reads stdin, so every call gets </dev/null: a caller piping a script into bash (over ssh, say) would lose the rest of it.
OUT_WSL=$(wsl -d "$DISTRO" -- wslpath -a "$(cygpath -m "$OUT")" </dev/null | tr -d '\r')

# The distro has no credentials for origin, so the commit travels as a bundle.
git bundle create -q "$OUT/vokko.bundle" HEAD

# The key goes in through the environment (WSLENV), never on a command line or into a file inside the distro.
TAURI_SIGNING_PRIVATE_KEY=$(cat "$HOME/.vokko/updater.key")
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$HOME/.vokko/updater.key.password")
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD VITE_VOKKO_API=${VITE_VOKKO_API:-https://vokko.example.com}
export WSLENV=TAURI_SIGNING_PRIVATE_KEY:TAURI_SIGNING_PRIVATE_KEY_PASSWORD:VITE_VOKKO_API

# -e skips the default shell, which would re-parse this script. APPIMAGE_EXTRACT_AND_RUN: WSL has no FUSE for the linuxdeploy AppImage. NO_STRIP: its bundled strip can't read current binaries.
wsl -d "$DISTRO" --cd "~" -e bash -c "set -euo pipefail; export PATH=\$HOME/node/bin:\$HOME/.cargo/bin:\$PATH APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1
  [ -d vokko ] || git clone -q '$OUT_WSL/vokko.bundle' vokko
  cd vokko && git fetch -q '$OUT_WSL/vokko.bundle' HEAD && git checkout -q --detach FETCH_HEAD
  npm ci --no-audit --no-fund --loglevel=error
  rm -rf target/release/bundle/appimage target/release/bundle/deb
  (cd apps/desktop && npx tauri build --config release.production.json --bundles appimage,deb > /tmp/vokko-linuxbuild.log 2>&1) ||
    { tail -20 /tmp/vokko-linuxbuild.log; exit 1; }
  cp target/release/bundle/appimage/Vokko_${VERSION}_amd64.AppImage target/release/bundle/appimage/Vokko_${VERSION}_amd64.AppImage.sig \
    target/release/bundle/deb/Vokko_${VERSION}_amd64.deb '$OUT_WSL/'" </dev/null
rm -f "$OUT/vokko.bundle"
test -f "$OUT/Vokko_${VERSION}_amd64.AppImage.sig"
