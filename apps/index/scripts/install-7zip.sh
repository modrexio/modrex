#!/usr/bin/env bash
# Ubuntu's packaged 7-Zip 23.01 (what p7zip-full/p7zip-rar resolve to) segfaults
# decompressing valid RAR4 archives; RAR5, ZIP and 7z are unaffected. This pins upstream
# 7-Zip 26.02, which decodes the same archives correctly, instead of the distro package.
set -euo pipefail

version="26.02"
url="https://github.com/ip7z/7zip/releases/download/${version}/7z2602-linux-x64.tar.xz"
sha256="41aaba7b1235304ab5aa0624530c67ae829496cd29e875925271efdccc28c03e"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

archive="$work_dir/7zip.tar.xz"
curl -fsSL -o "$archive" "$url"
echo "${sha256}  ${archive}" | sha256sum -c -

extract_dir="$work_dir/extracted"
mkdir -p "$extract_dir"
tar -xJf "$archive" -C "$extract_dir"

# Its own directory, outside work_dir: it must survive past this script's exit, since
# later steps in the job reach it through PATH, not through anything captured here.
install_dir="$(mktemp -d)"
cp "$extract_dir/7zz" "$install_dir/7z"
chmod +x "$install_dir/7z"

# Resolve against install_dir explicitly rather than trusting PATH order at this point in
# the step, so a stale entry ahead of it cannot silently mask the pinned binary.
resolved_version="$("$install_dir/7z" --help 2>&1 || true)"
case "$resolved_version" in
    *"${version}"*) ;;
    *)
        echo "expected 7-Zip ${version}, got: ${resolved_version}" >&2
        exit 1
        ;;
esac

echo "$install_dir" >> "$GITHUB_PATH"
