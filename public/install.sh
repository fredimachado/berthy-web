#!/bin/sh
# Installs the Berthy CLI on Linux and macOS. It downloads the release binary for this machine,
# checks it against the release's checksums.txt and puts it on your PATH as `berthy`.
#
#   curl -fsSL https://berthy.pages.dev/install.sh | sh
#
# Settings are environment variables. Put them on the `sh` side of the pipe:
#
#   curl -fsSL https://berthy.pages.dev/install.sh | BERTHY_VERSION=v0.8.0 sh
#
#   BERTHY_VERSION      A release tag, for example v0.8.0. Default: the latest release.
#   BERTHY_INSTALL_DIR  Where the binary goes. Default: /usr/local/bin, with sudo when needed.
#   BERTHY_RELEASE_URL  A mirror of the releases, laid out as <url>/<version>/<file>, the same
#                       variable `berthy setup` reads. Needs BERTHY_VERSION.
#
# On Windows, use PowerShell: irm https://berthy.pages.dev/install.ps1 | iex
set -eu

RELEASES='https://github.com/fredimachado/berthy/releases'

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# fetch <url> <file>
fetch() {
  if has curl; then
    curl -fsSL -o "$2" "$1"
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    fail 'curl or wget is needed to download Berthy.'
  fi
}

# sha256 <file>: prints the hash in lower case hex.
sha256() {
  if has sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif has openssl; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    fail 'sha256sum, shasum or openssl is needed to check the download.'
  fi
}

# Everything runs from main, called on the last line, so a download that is cut short does nothing.
main() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*)
      fail 'on Windows, run this in PowerShell: irm https://berthy.pages.dev/install.ps1 | iex'
      ;;
    *) fail "there is no Berthy build for $(uname -s). Builds exist for Linux, macOS and Windows." ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "there is no Berthy build for $(uname -m). Builds exist for amd64 and arm64." ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = darwin ] && [ "$arch" = amd64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi

  version=${BERTHY_VERSION:-}
  case "$version" in
    [0-9]*) version="v$version" ;;
  esac
  if [ -n "${BERTHY_RELEASE_URL:-}" ]; then
    [ -n "$version" ] || fail 'BERTHY_RELEASE_URL needs BERTHY_VERSION.'
    base="${BERTHY_RELEASE_URL%/}/$version"
  elif [ -n "$version" ]; then
    base="$RELEASES/download/$version"
  else
    base="$RELEASES/latest/download"
  fi

  dir=${BERTHY_INSTALL_DIR:-/usr/local/bin}
  sudo=
  if ! { mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; }; then
    if [ "$(id -u)" -eq 0 ] || ! has sudo; then
      fail "cannot write to $dir. Set BERTHY_INSTALL_DIR to a directory you own, for example \$HOME/.local/bin."
    fi
    sudo=sudo
  fi

  asset="berthy-$os-$arch"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading $asset (${version:-latest release})"
  fetch "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset"
  fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "could not download $base/checksums.txt"

  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/checksums.txt")
  [ -n "$expected" ] || fail "checksums.txt has no line for $asset."
  actual=$(sha256 "$tmp/$asset")
  if [ "$actual" != "$expected" ]; then
    fail "the checksum of $asset does not match checksums.txt. Nothing was installed.
  expected $expected
  got      $actual"
  fi
  say 'Checksum matches checksums.txt'

  if [ -n "$sudo" ]; then
    say "Writing to $dir needs sudo."
  fi
  $sudo mkdir -p "$dir"
  $sudo install -m 0755 "$tmp/$asset" "$dir/berthy"
  say "Installed $dir/berthy"

  "$dir/berthy" version || say "Note: $dir/berthy did not run on this machine."

  case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "Note: $dir is not on your PATH. Add it, or run $dir/berthy." ;;
  esac
  say 'Next: https://berthy.pages.dev/#quick-start'
}

main "$@"
