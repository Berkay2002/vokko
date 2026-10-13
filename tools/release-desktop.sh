#!/usr/bin/env bash
# Desktop release: bumps the version, builds signed Windows (here) and macOS (on buildhost) bundles, uploads them to
# https://vokko.example.com/downloads/ and publishes latest.json last, which is what installed apps poll (docs/desktop-release.md).
# Run from Git Bash on the Windows PC, on a clean main:  tools/release-desktop.sh 0.1.2 "What changed"
# Needs ~/.vokko/updater.key(.password) on both machines and `ssh buildhost` without a password.
set -euo pipefail
VERSION=${1:?usage: release-desktop.sh <version> [notes]}
NOTES=${2:-"Vokko $VERSION"}
API=https://vokko.example.com
MAC_REPO=/srv/vokko
DOWNLOADS=.local/share/vokko/downloads
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

[ "$(git branch --show-current)" = main ] || { echo "not on main"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "working tree not clean"; exit 1; }
git pull -q --ff-only

# The updater only installs a strictly newer version, so all four places move together.
sed -i "0,/^version = \".*\"/s//version = \"$VERSION\"/" Cargo.toml
sed -i "0,/\"version\": \".*\"/s//\"version\": \"$VERSION\"/" package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
cargo update -q -w
npm install -q --package-lock-only --no-audit --no-fund
git commit -qam "Desktop: release $VERSION"
git push -q origin main

export TAURI_SIGNING_PRIVATE_KEY="$HOME/.vokko/updater.key"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$HOME/.vokko/updater.key.password")
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD VITE_VOKKO_API=$API CARGO_TARGET_DIR=E:/cargo-target/vokko-release

echo "== macOS build (buildhost, background)"
ssh -o BatchMode=yes buildhost "export PATH=/opt/homebrew/bin:/usr/local/bin:\$HOME/.cargo/bin:\$PATH
  set -e; cd $MAC_REPO && git fetch -q origin && git checkout -q --detach origin/main && npm ci --no-audit --no-fund --loglevel=error
  export TAURI_SIGNING_PRIVATE_KEY=\$HOME/.vokko/updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\$(cat \$HOME/.vokko/updater.key.password) VITE_VOKKO_API=$API
  rm -rf target/release/bundle/macos target/release/bundle/dmg
  cd apps/desktop && npx tauri build --config release.production.json --bundles app,dmg > /tmp/vokko-macbuild.log 2>&1" &
MAC_PID=$!

echo "== Windows build"
npm ci --no-audit --no-fund --loglevel=error
(cd apps/desktop && npx tauri build --config release.production.json > "${TMPDIR:-/tmp}/vokko-winbuild.log" 2>&1) ||
  { tail -20 "${TMPDIR:-/tmp}/vokko-winbuild.log"; exit 1; }
WIN=$CARGO_TARGET_DIR/release/bundle/nsis/Vokko_${VERSION}_x64-setup.exe
test -f "$WIN.sig"

wait $MAC_PID || { ssh buildhost 'tail -20 /tmp/vokko-macbuild.log'; exit 1; }
MAC_SIG=$(ssh -o BatchMode=yes buildhost "cat $MAC_REPO/target/release/bundle/macos/Vokko.app.tar.gz.sig")

echo "== upload"
scp -q -o BatchMode=yes "$WIN" buildhost:$DOWNLOADS/
ssh -o BatchMode=yes buildhost "set -e; cd $DOWNLOADS
  cp $MAC_REPO/target/release/bundle/macos/Vokko.app.tar.gz Vokko_${VERSION}_aarch64.app.tar.gz
  cp $MAC_REPO/target/release/bundle/dmg/Vokko_${VERSION}_aarch64.dmg .Vokko-mac.dmg.new && mv -f .Vokko-mac.dmg.new Vokko-mac.dmg
  cp Vokko_${VERSION}_x64-setup.exe .Vokko-windows-setup.exe.new && mv -f .Vokko-windows-setup.exe.new Vokko-windows-setup.exe"
mkdir -p artifacts && cp "$WIN" artifacts/Vokko-windows-setup.exe

# Published last: an app that sees the new version can always download it.
node -e '
const [version, notes, winSig, macSig, base] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms: {
  "windows-x86_64": { signature: winSig, url: `${base}/Vokko_${version}_x64-setup.exe` },
  "darwin-aarch64": { signature: macSig, url: `${base}/Vokko_${version}_aarch64.app.tar.gz` },
} }, null, 2));' "$VERSION" "$NOTES" "$(cat "$WIN.sig")" "$MAC_SIG" "$API/downloads" |
  ssh -o BatchMode=yes buildhost "cat > $DOWNLOADS/.latest.json.new && mv -f $DOWNLOADS/.latest.json.new $DOWNLOADS/latest.json"
curl -fsS "$API/downloads/latest.json" | grep -q "\"version\": \"$VERSION\"" && echo "released $VERSION"
