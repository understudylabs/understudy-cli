#!/bin/sh

set -eu

caller_path=${PATH:-}
install_dir=""
repository="github.com/understudylabs/understudy-cli-releases"
release_tag="__UNDERSTUDY_RELEASE_TAG__"
expected_team_id="__UNDERSTUDY_DEVELOPER_TEAM_ID__"
release_dir=""
asset="understudy-darwin-arm64"
download_directory=""
candidate_directory=""
candidate=""

usage() {
  cat <<'EOF'
Download and install the Understudy CLI release matching this installer.

Usage: install.sh [--install-dir <directory>] [--release-dir <directory>]

The release is downloaded anonymously from Understudy's public binary mirror.
To update, rerun the installation command that fetches the newest installer.

--release-dir is reserved for explicit local release testing and trusts every
file in the supplied directory.
EOF
}

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$candidate" ]; then
    rm -f "$candidate"
  fi
  if [ -n "$candidate_directory" ]; then
    rmdir "$candidate_directory" 2>/dev/null || true
  fi
  if [ -n "$download_directory" ]; then
    rm -f \
      "$download_directory/$asset" \
      "$download_directory/SHA256SUMS"
    rmdir "$download_directory" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a directory"
      install_dir="$2"
      shift 2
      ;;
    --release-dir)
      [ "$#" -ge 2 ] || fail "--release-dir requires a directory"
      release_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [ -z "$install_dir" ]; then
  if [ -n "${UNDERSTUDY_INSTALL_DIR:-}" ]; then
    install_dir="$UNDERSTUDY_INSTALL_DIR"
  elif [ -n "${HOME:-}" ]; then
    install_dir="$HOME/.local/bin"
  else
    fail "HOME is not set; pass --install-dir"
  fi
fi

case "$install_dir" in
  /*) ;;
  *) fail "the install directory must be an absolute path" ;;
esac

if [ -z "$release_dir" ]; then
  case "$release_tag" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) fail "download this installer from a versioned Understudy release" ;;
  esac
  curl_bin=/usr/bin/curl
  [ -x "$curl_bin" ] || fail "the macOS system curl is required"
else
  case "$release_dir" in
    /*) ;;
    *) fail "--release-dir must be an absolute path" ;;
  esac
fi

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

[ "$(uname -s)" = "Darwin" ] || fail "this release supports macOS only"
machine=$(uname -m)
if [ "$machine" != "arm64" ]; then
  arm64_capable=$(sysctl -in hw.optional.arm64 2>/dev/null || true)
  [ "$arm64_capable" = "1" ] || fail "this release supports Apple Silicon only"
fi

if [ -z "$release_dir" ]; then
  download_directory=$(mktemp -d "${TMPDIR:-/tmp}/understudy-download.XXXXXX")
  release_url="https://$repository/releases/download/$release_tag"
  if ! "$curl_bin" \
    --fail \
    --location \
    --silent \
    --show-error \
    --proto '=https' \
    --retry 3 \
    --output "$download_directory/$asset" \
    "$release_url/$asset"; then
    fail "could not download $asset from the $release_tag release"
  fi
  if ! "$curl_bin" \
    --fail \
    --location \
    --silent \
    --show-error \
    --proto '=https' \
    --retry 3 \
    --output "$download_directory/SHA256SUMS" \
    "$release_url/SHA256SUMS"; then
    fail "could not download SHA256SUMS from the $release_tag release"
  fi
  release_dir="$download_directory"
fi

source_binary="$release_dir/$asset"
source_checksums="$release_dir/SHA256SUMS"
[ -f "$source_binary" ] || fail "the release binary is missing"
[ -f "$source_checksums" ] || fail "the release checksum manifest is missing"

checksum_entry=$(
  awk -v name="$asset" '
    $2 == name {
      if (found) exit 2
      print
      found = 1
    }
    END { if (!found) exit 1 }
  ' "$source_checksums"
) || fail "the release checksum manifest is invalid"

if ! (
  cd "$release_dir"
  printf '%s\n' "$checksum_entry" | shasum -a 256 -c -
) >/dev/null 2>&1; then
  fail "the release binary failed checksum verification"
fi

mkdir -p "$install_dir"
target="$install_dir/understudy"
[ ! -d "$target" ] || fail "$target is a directory"

candidate_directory=$(mktemp -d "$install_dir/.understudy-install.XXXXXX")
candidate="$candidate_directory/understudy"
cp "$source_binary" "$candidate"
chmod 0755 "$candidate"

allow_preview_team_id=false
case "$expected_team_id" in
  _*)
    [ -n "${UNDERSTUDY_INSTALLER_TEST_TEAM_ID:-}" ] || \
      fail "this installer was not prepared for a signed release"
    expected_team_id="$UNDERSTUDY_INSTALLER_TEST_TEAM_ID"
    allow_preview_team_id=true
    ;;
esac
if [ "$allow_preview_team_id" = false ] && \
  ! printf '%s' "$expected_team_id" | grep -Eq '^[A-Z0-9]{10}$'; then
  fail "the release signing identity is invalid"
fi
if ! /usr/bin/codesign --verify --strict "$candidate" >/dev/null 2>&1; then
  fail "the release binary has an invalid code signature"
fi
signature_details=$(
  /usr/bin/codesign --display --verbose=2 "$candidate" 2>&1
) || fail "the release binary signature could not be inspected"
team_id=$(printf '%s\n' "$signature_details" | sed -n 's/^TeamIdentifier=//p')
[ "$team_id" = "$expected_team_id" ] || \
  fail "the release binary was not signed by the expected team"

if ! version=$(env \
  -u BUN_OPTIONS \
  -u BUN_BE_BUN \
  -u UNDERSTUDY_INSTALLER_TEST_TEAM_ID \
  "$candidate" --version); then
  fail "the release binary could not run on this Mac"
fi

mv -f "$candidate" "$target"
candidate=""
rmdir "$candidate_directory"
candidate_directory=""

printf 'Installed Understudy CLI %s at %s\n' "$version" "$target"
case ":$caller_path:" in
  *:"$install_dir":*) ;;
  *) printf 'Add %s to PATH, then run: understudy --help\n' "$install_dir" ;;
esac

# Inspect command precedence without executing another installation.
first_command=$(PATH="$caller_path" command -v understudy 2>/dev/null || true)
if [ -n "$first_command" ] && [ "$first_command" != "$target" ]; then
  printf 'Another understudy command takes precedence: %s\n' "$first_command"
  printf 'Put %s first in PATH, then restart your shell.\n' "$install_dir"
  printf 'Before removing an older installation, check which agent skills or plugins still depend on it.\n'
fi
printf 'The binary installer preserves existing agent plugins, skills, credentials, and migration data.\n'
printf 'Next, choose the skill-install command for your coding agent:\n'
printf '  understudy skills install --harness codex --json\n'
printf '  understudy skills install --harness claude --json\n'
printf '  understudy skills install --harness cursor --json\n'
printf '  understudy skills install --harness opencode --json\n'
printf 'Read the returned setup-understudy entrypoint in this session, or start a new agent session to load it.\n'
printf 'Then ask: "Use setup-understudy to connect this application to Understudy. Ask me to approve the proposed workload names and setup plan before proceeding."\n'

cleanup
trap - EXIT HUP INT TERM
