#!/bin/sh
set -eu

APP="termagent"
VERSION="${TERMAGENT_VERSION:-}"
REPO="${TERMAGENT_REPO:-}"
BASE_URL="${TERMAGENT_RELEASE_BASE_URL:-}"
PREFIX="${PREFIX:-}"
FORCE_SOURCE="${TERMAGENT_FORCE_SOURCE:-0}"
TMP_ROOT="${TMPDIR:-${PREFIX:-/tmp}}"
WORK="$TMP_ROOT/termagent-install-$$"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }
fatal() { printf 'TermAgent installer: %s\n' "$*" >&2; exit 1; }

is_termux=0
case "${TERMUX_VERSION:-}" in '') ;; *) is_termux=1 ;; esac
if [ -z "$PREFIX" ]; then
  if [ "$is_termux" -eq 1 ]; then PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"; else PREFIX="/usr/local"; fi
fi

if [ "$is_termux" -eq 1 ]; then
  case "$(uname -m)" in
    armv7l|armv8l|arm) TARGET="android-armv7" ;;
    aarch64) TARGET="android-arm64" ;;
    x86_64) TARGET="android-x64" ;;
    i686|i386) TARGET="android-x86" ;;
    *) TARGET="" ;;
  esac
else
  case "$(uname -s):$(uname -m)" in
    Linux:arm|Linux:armv7l|Linux:armv8l) TARGET="linux-armv7" ;;
    Linux:x86_64) TARGET="linux-x64" ;;
    *) TARGET="" ;;
  esac
fi
[ -n "${TERMAGENT_TARGET:-}" ] && TARGET="$TERMAGENT_TARGET"

command -v node >/dev/null 2>&1 || fatal "Node.js >=22 is required. Install Node in Termux first."
node -e 'const [major]=process.versions.node.split(".").map(Number); if(major<22) process.exit(1)' || fatal "Node.js >=22 is required (found $(node --version))."

if [ -z "$VERSION" ]; then
  [ -n "$BASE_URL" ] || [ -n "$REPO" ] || fatal "Set TERMAGENT_REPO or TERMAGENT_RELEASE_BASE_URL (and optionally TERMAGENT_VERSION)."
  if [ -n "$BASE_URL" ]; then
    [ -n "${TERMAGENT_VERSION:-}" ] || fatal "TERMAGENT_VERSION is required when TERMAGENT_RELEASE_BASE_URL is set"
    VERSION="$TERMAGENT_VERSION"
  else
    command -v curl >/dev/null 2>&1 || fatal "curl is required to resolve the latest release."
    VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$VERSION" ] || fatal "could not resolve the latest release tag"
  fi
fi

if [ -n "$BASE_URL" ]; then
  case "$BASE_URL" in */) ;; *) BASE_URL="$BASE_URL/" ;; esac
elif [ -n "$REPO" ]; then
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION/"
else
  BASE_URL=""
fi

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    node -e 'const fs=require("node:fs");const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$file"
  fi
}

install_bundle() {
  archive="$1"
  expected_target="$2"
  target_root="$PREFIX/lib/$APP"
  bin_dir="$PREFIX/bin"
  rm -rf "$target_root.new"
  mkdir -p "$target_root.new" "$bin_dir"
  tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$target_root.new" 2>/dev/null || tar -xzf "$archive" -C "$target_root.new"
  [ -f "$target_root.new/dist/index.js" ] || fatal "release archive is missing dist/index.js"
  [ -f "$target_root.new/TARGET-INFO.json" ] || fatal "release archive is missing TARGET-INFO.json"
  actual_target="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.target?.id||"")' "$target_root.new/TARGET-INFO.json")"
  [ "$actual_target" = "$expected_target" ] || fatal "release target mismatch: expected $expected_target, archive declares ${actual_target:-unknown}"
  rm -rf "$target_root"
  mv "$target_root.new" "$target_root"
  cat > "$bin_dir/$APP" <<EOF2
#!/bin/sh
exec node "$target_root/dist/index.js" "\$@"
EOF2
  cat > "$bin_dir/${APP}-device-smoke" <<EOF3
#!/bin/sh
exec node "$target_root/scripts/device-smoke.mjs" "\$@"
EOF3
  chmod 755 "$bin_dir/$APP" "$bin_dir/${APP}-device-smoke"
  "$bin_dir/$APP" --version
}

try_prebuilt() {
  [ "$FORCE_SOURCE" = "1" ] && return 1
  [ -n "$BASE_URL" ] || return 1
  [ -n "$TARGET" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  mkdir -p "$WORK"
  name="termagent-${VERSION}-${TARGET}.tar.gz"
  say "==> trying prebuilt bundle: $name"
  curl -fL --connect-timeout 15 -o "$WORK/$name" "$BASE_URL$name" || return 1
  curl -fsSL --connect-timeout 15 -o "$WORK/SHA256SUMS" "$BASE_URL"SHA256SUMS || return 1
  expected="$(grep "  $name\$" "$WORK/SHA256SUMS" | awk '{print $1}' | head -n1)"
  [ -n "$expected" ] || return 1
  actual="$(sha256_file "$WORK/$name")"
  [ "$expected" = "$actual" ] || fatal "checksum mismatch for $name"
  say "==> checksum verified"
  install_bundle "$WORK/$name" "$TARGET"
}

build_source() {
  command -v curl >/dev/null 2>&1 || fatal "curl is required for source fallback."
  command -v tar >/dev/null 2>&1 || fatal "tar is required for source fallback."
  [ -n "$REPO" ] || fatal "source fallback requires TERMAGENT_REPO"
  mkdir -p "$WORK"
  archive="$WORK/source.tar.gz"
  say "==> no compatible prebuilt bundle; downloading source $VERSION"
  curl -fL --connect-timeout 15 -o "$archive" "https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz"
  tar -tzf "$archive" >/dev/null || fatal "downloaded source archive is invalid"
  tar -xzf "$archive" -C "$WORK"
  src="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$src" ] || fatal "source archive layout is invalid"
  cd "$src"
  if command -v tsc >/dev/null 2>&1; then
    tsc -p tsconfig.json
  else
    npm exec --yes --package "typescript@5.8.3" -- tsc -p tsconfig.json
  fi
  rm -rf "$PREFIX/lib/$APP"
  mkdir -p "$PREFIX/lib/$APP" "$PREFIX/bin"
  cp -a dist README.md LICENSE CHANGELOG.md package.json scripts/device-smoke.mjs "$PREFIX/lib/$APP/"
  mkdir -p "$PREFIX/lib/$APP/scripts"
  cp -a scripts/device-smoke.mjs "$PREFIX/lib/$APP/scripts/device-smoke.mjs"
  cat > "$PREFIX/bin/$APP" <<EOF2
#!/bin/sh
exec node "$PREFIX/lib/$APP/dist/index.js" "\$@"
EOF2
  cat > "$PREFIX/bin/${APP}-device-smoke" <<EOF3
#!/bin/sh
exec node "$PREFIX/lib/$APP/scripts/device-smoke.mjs" "\$@"
EOF3
  chmod 755 "$PREFIX/bin/$APP" "$PREFIX/bin/${APP}-device-smoke"
  "$PREFIX/bin/$APP" --version
}

if try_prebuilt; then
  say "==> prebuilt installation complete ($TARGET)"
else
  build_source
fi
