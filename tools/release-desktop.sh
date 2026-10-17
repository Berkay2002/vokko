#!/usr/bin/env bash
# Desktop release: bumps the version, builds signed Windows (here), Linux (WSL distro vokko-linux, tools/release-linux.sh) and
# macOS (on buildhost) bundles, uploads them to
# https://vokko.example.com/downloads/ and publishes latest.json last, which is what installed apps poll (docs/desktop-release.md).
# Run from Git Bash on the Windows PC, on a clean main:  tools/release-desktop.sh 0.1.2 "What changed"
# Dry run (builds all three at the current version; no bump, commit, push, upload or latest.json):  tools/release-desktop.sh --dry-run
# Needs ~/.vokko/updater.key(.password) on both machines and `ssh buildhost` without a password.
set -euo pipefail

# The body is a function called on the last line, so bash has parsed all of it before the `git pull` below can change this
# file; after the pull the script re-execs itself once so the pulled copy is what runs (0.1.8 ran a stale copy and skipped Linux).
main() {
  local args=("$@") DRY=
  [ "${1:-}" = --dry-run ] && { DRY=1; shift; }
  API=https://vokko.example.com
  MAC_REPO=/srv/vokko
  DOWNLOADS=.local/share/vokko/downloads
  ROOT=$(git rev-parse --show-toplevel)
  cd "$ROOT"

  [ "$(git branch --show-current)" = main ] || { echo "not on main"; exit 1; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "working tree not clean"; exit 1; }
  if [ -z "${VOKKO_RELEASE_PULLED:-}" ]; then
    git pull -q --ff-only
    VOKKO_RELEASE_PULLED=1 exec bash "$ROOT/tools/release-desktop.sh" "${args[@]}"
  fi

  if [ -n "$DRY" ]; then
    local current
    current=$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").version')
    VERSION=${1:-$current}
    [ "$VERSION" = "$current" ] || { echo "a dry run builds the current version $current, not $VERSION"; exit 1; }
    # buildhost builds origin/main, so it has to be what is checked out here.
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main and origin/main differ"; exit 1; }
  else
    VERSION=${1:?usage: release-desktop.sh <version> [notes] | --dry-run}
  fi
  NOTES=${2:-"Vokko $VERSION"}

  # The updater only installs a strictly newer version, so all four places move together. A rerun after a failed build skips this.
  if ! grep -q "\"version\": \"$VERSION\"" apps/desktop/src-tauri/tauri.conf.json; then
    sed -i "0,/^version = \".*\"/s//version = \"$VERSION\"/" Cargo.toml
    sed -i "0,/\"version\": \".*\"/s//\"version\": \"$VERSION\"/" package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
    cargo update -q -w
    npm install -q --package-lock-only --no-audit --no-fund
    git commit -qam "Desktop: release $VERSION"
    git push -q origin main
  fi

  export TAURI_SIGNING_PRIVATE_KEY="$HOME/.vokko/updater.key"
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$HOME/.vokko/updater.key.password")
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD VITE_VOKKO_API=$API CARGO_TARGET_DIR=${VOKKO_RELEASE_TARGET:-E:/cargo-target/vokko-release}

  echo "== macOS build (buildhost, background)"
  ssh -n -o BatchMode=yes buildhost "export PATH=/opt/homebrew/bin:/usr/local/bin:\$HOME/.cargo/bin:\$PATH
    set -e; cd $MAC_REPO && git fetch -q origin && git checkout -q --detach origin/main && npm ci --no-audit --no-fund --loglevel=error
    export TAURI_SIGNING_PRIVATE_KEY=\$HOME/.vokko/updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\$(cat \$HOME/.vokko/updater.key.password) VITE_VOKKO_API=$API
    rm -rf target/release/bundle/macos target/release/bundle/dmg
    cd apps/desktop && npx tauri build --config release.production.json --bundles app,dmg > /tmp/vokko-macbuild.log 2>&1" &
  local MAC_PID=$!

  echo "== Windows build"
  npm ci --no-audit --no-fund --loglevel=error
  (cd apps/desktop && npx tauri build --config release.production.json > "${TMPDIR:-/tmp}/vokko-winbuild.log" 2>&1) ||
    { tail -20 "${TMPDIR:-/tmp}/vokko-winbuild.log"; exit 1; }
  WIN=$CARGO_TARGET_DIR/release/bundle/nsis/Vokko_${VERSION}_x64-setup.exe
  test -f "$WIN.sig"

  echo "== Linux build (WSL)"
  LINUX=$CARGO_TARGET_DIR/linux
  tools/release-linux.sh "$VERSION" "$LINUX"
  APPIMAGE=Vokko_${VERSION}_amd64.AppImage DEB=Vokko_${VERSION}_amd64.deb

  wait $MAC_PID || { ssh -n buildhost 'tail -20 /tmp/vokko-macbuild.log'; exit 1; }
  MAC_SIG=$(ssh -n -o BatchMode=yes buildhost "test -f $MAC_REPO/target/release/bundle/dmg/Vokko_${VERSION}_aarch64.dmg &&
    cat $MAC_REPO/target/release/bundle/macos/Vokko.app.tar.gz.sig")

  local MANIFEST=$CARGO_TARGET_DIR/latest.json
  # shellcheck disable=SC2016 # JS template literals
  node -e '
const [version, notes, winSig, macSig, linuxSig, base] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms: {
  "windows-x86_64": { signature: winSig, url: `${base}/Vokko_${version}_x64-setup.exe` },
  "darwin-aarch64": { signature: macSig, url: `${base}/Vokko_${version}_aarch64.app.tar.gz` },
  "linux-x86_64": { signature: linuxSig, url: `${base}/Vokko_${version}_amd64.AppImage` },
} }, null, 2));' "$VERSION" "$NOTES" "$(cat "$WIN.sig")" "$MAC_SIG" "$(cat "$LINUX/$APPIMAGE.sig")" "$API/downloads" >"$MANIFEST"
  if [ -n "$DRY" ]; then
    check_manifest "$MANIFEST" offline
    echo "dry run of $VERSION done: $WIN, $LINUX, buildhost:$MAC_REPO/target/release/bundle, $MANIFEST"
    return
  fi

  echo "== upload"
  scp -q -o BatchMode=yes "$WIN" "$LINUX/$APPIMAGE" "$LINUX/$DEB" buildhost:$DOWNLOADS/
  ssh -n -o BatchMode=yes buildhost "set -e; cd $DOWNLOADS
    cp $MAC_REPO/target/release/bundle/macos/Vokko.app.tar.gz Vokko_${VERSION}_aarch64.app.tar.gz
    cp $MAC_REPO/target/release/bundle/dmg/Vokko_${VERSION}_aarch64.dmg .Vokko-mac.dmg.new && mv -f .Vokko-mac.dmg.new Vokko-mac.dmg
    cp Vokko_${VERSION}_x64-setup.exe .Vokko-windows-setup.exe.new && mv -f .Vokko-windows-setup.exe.new Vokko-windows-setup.exe
    cp $APPIMAGE .Vokko-linux.AppImage.new && mv -f .Vokko-linux.AppImage.new Vokko-linux.AppImage
    cp $DEB .Vokko-linux.deb.new && mv -f .Vokko-linux.deb.new Vokko-linux.deb"
  mkdir -p artifacts && cp "$WIN" artifacts/Vokko-windows-setup.exe

  # Published last, and only once every url it names answers: an app that sees the new version can always download it.
  check_manifest "$MANIFEST"
  ssh -o BatchMode=yes buildhost "cat > $DOWNLOADS/.latest.json.new && mv -f $DOWNLOADS/.latest.json.new $DOWNLOADS/latest.json" <"$MANIFEST"
  curl -fsS "$API/downloads/latest.json" >"$MANIFEST.served"
  check_manifest "$MANIFEST.served"
  echo "released $VERSION"
}

# check_manifest <latest.json> [offline]: all three platforms with $VERSION and a signature, and (unless offline) each url answers
# 200. Fails loudly otherwise.
check_manifest() {
  local urls url
  # shellcheck disable=SC2016 # JS template literals
  urls=$(node -e '
const [file, version] = process.argv.slice(1);
const m = JSON.parse(require("fs").readFileSync(file, "utf8"));
const bad = m.version === version ? [] : [`version is ${m.version}`];
for (const p of ["windows-x86_64", "darwin-aarch64", "linux-x86_64"]) {
  const e = (m.platforms || {})[p];
  if (e && e.signature && typeof e.url === "string" && e.url.includes(`_${version}_`)) console.log(e.url);
  else bad.push(`${p} missing or incomplete`);
}
if (bad.length) { console.error(`${file} (want ${version}): ${bad.join("; ")}`); process.exit(1); }' "$1" "$VERSION")
  [ "${2:-}" = offline ] && return
  for url in $urls; do
    curl -fsI -o /dev/null "$url" || { echo "$url does not answer 200" >&2; exit 1; }
  done
}

main "$@"
exit
