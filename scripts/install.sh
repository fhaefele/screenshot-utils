#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

main() (
    set -euo pipefail

    fail() {
        printf 'Screenshot Utils: %s\n' "$*" >&2
        exit 1
    }

    if [[ $# -gt 0 ]]; then
        if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then
            printf 'Install the latest Screenshot Utils release for the current user.\nUsage: bash scripts/install.sh\n'
            exit 0
        fi
        fail 'Usage: bash scripts/install.sh'
    fi

    for dependency in curl gnome-shell gnome-extensions mktemp rm; do
        command -v "$dependency" >/dev/null 2>&1 || fail "Required command not found: $dependency"
    done

    shell_version=$(LC_ALL=C gnome-shell --version) || fail 'Could not detect the GNOME Shell version.'
    if [[ $shell_version =~ ^GNOME[[:space:]]Shell[[:space:]]([0-9]+)(\.|[[:space:]]|$) ]]; then
        major=${BASH_REMATCH[1]}
    else
        fail "Unrecognized GNOME Shell version: $shell_version"
    fi

    case "$major" in
        42|43|44) asset=screenshot-utils-gnome42-44.shell-extension.zip ;;
        45|46|47|48|49|50|51) asset=screenshot-utils-modern.shell-extension.zip ;;
        *) fail "GNOME Shell $major is unsupported. Supported versions: 42–51." ;;
    esac

    download_dir=$(mktemp -d "${TMPDIR:-/tmp}/screenshot-utils-install.XXXXXXXX") || fail 'Could not create a temporary directory.'
    trap 'rm -rf -- "$download_dir"' EXIT
    archive="$download_dir/$asset"
    url="https://github.com/fhaefele/screenshot-utils/releases/latest/download/$asset"

    printf 'Downloading Screenshot Utils for GNOME Shell %s…\n' "$major"
    if ! curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
        --retry 2 --connect-timeout 15 --max-time 120 --output "$archive" "$url"; then
        fail 'Download failed. Nothing was installed.'
    fi
    if ! gnome-extensions install --force "$archive"; then
        fail 'Installation failed. Check the GNOME Extensions error above.'
    fi

    printf 'Installed Screenshot Utils for the current user.\nLog out and back in, then enable Screenshot Utils in Extensions.\n'
)

main "$@"
