#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

main() (
    set -euo pipefail
    uuid=screenshot-utils@fxth.dev
    installed_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
    automatic=false

    fail() { printf 'Screenshot Utils: %s\n' "$*" >&2; exit 1; }
    require() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }
    usage() {
        printf '%s\n' 'Manage Screenshot Utils for the current user.' \
            'Usage: bash scripts/install.sh [--yes]' \
            'Without options: interactive install/update, enable/disable, reset or uninstall.' \
            '--yes: install/update and enable without prompts; never reinstall, downgrade, reset or uninstall.'
    }
    case "${1:-}" in
        --help|-h) [[ $# -eq 1 ]] || fail 'Unexpected arguments.'; usage; exit 0 ;;
        --yes) [[ $# -eq 1 ]] || fail 'Unexpected arguments.'; automatic=true ;;
        '') [[ $# -eq 0 ]] || fail 'Unexpected arguments.' ;;
        *) usage >&2; exit 1 ;;
    esac

    # stdin may contain this script from curl | bash. Answers must come from the terminal.
    if ! "$automatic"; then
        if ! { exec 3<>/dev/tty; } 2>/dev/null; then
            fail 'No interactive terminal. Use --yes to install/update and enable without prompts.'
        fi
    fi
    confirm() {
        local question=$1 default=$2 answer choices=y/N
        [[ $default != Y ]] || choices=Y/n
        if "$automatic"; then [[ $default == Y ]]; return; fi
        while true; do
            printf '%s [%s] ' "$question" "$choices" >&3
            if ! IFS= read -r answer <&3; then printf '\n' >&3; exit 0; fi
            case "$answer" in
                '') [[ $default == Y ]]; return ;;
                y|Y|yes|YES) return 0 ;;
                n|N|no|NO) return 1 ;;
                *) printf 'Enter y or n.\n' >&3 ;;
            esac
        done
    }

    # JSON/ZIP handling and string-array settings share one strict parser.
    helper() {
        python3 - "$uuid" "$@" <<'PY'
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

uuid, action, *args = sys.argv[1:]

def parts(version):
    if not isinstance(version, str) or len(version) > 16 or not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", version):
        raise ValueError("Invalid release version")
    return tuple(map(int, (version.split(".") + ["0"])[:3]))

def setting(key):
    return subprocess.check_output(["gsettings", "get", "org.gnome.shell", key], text=True).strip()

def array(key):
    value = setting(key)
    result = ast.literal_eval(value.removeprefix("@as "))
    if not isinstance(result, list) or not all(isinstance(item, str) for item in result):
        raise ValueError("Invalid GNOME extension settings")
    return result

try:
    if action in ("version", "archive"):
        if action == "archive":
            with zipfile.ZipFile(args[0]) as archive:
                info = archive.getinfo("metadata.json")
                if info.file_size > 65536:
                    raise ValueError("Release metadata is too large")
                metadata = json.loads(archive.read(info))
            if args[1] not in metadata.get("shell-version", []):
                raise ValueError("Release does not support this GNOME version")
        else:
            metadata = json.loads(Path(args[0]).read_text())
        if metadata.get("uuid") != uuid:
            raise ValueError("Extension UUID does not match")
        version = metadata.get("version-name")
        parts(version)
        print(version)
    elif action == "compare":
        old, new = map(parts, args)
        print("update" if new > old else "reinstall" if new == old else "newer")
    else:
        enabled, disabled = array("enabled-extensions"), array("disabled-extensions")
        if action == "status":
            print("Enabled" if uuid in enabled and uuid not in disabled else "Disabled")
        elif action in ("enable", "disable", "remove", "uninstall"):
            if action == "uninstall":
                directory = Path(args[0])
                expected = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "gnome-shell/extensions" / uuid
                if directory != expected:
                    raise ValueError("Refusing to remove an unexpected directory")
            enabled = [item for item in enabled if item != uuid]
            disabled = [item for item in disabled if item != uuid]
            if action == "enable":
                enabled.append(uuid)
            if action == "disable":
                disabled.append(uuid)
            for key, values in [("disabled-extensions", disabled), ("enabled-extensions", enabled)]:
                subprocess.run(["gsettings", "set", "org.gnome.shell", key, json.dumps(values)], check=True)
                if array(key) != values:
                    raise ValueError("GNOME did not save extension settings")
            if action == "uninstall":
                # rmtree does not follow nested symlinks; unlink a top-level symlink itself.
                if directory.is_symlink():
                    directory.unlink()
                elif directory.exists():
                    shutil.rmtree(directory)
            if action == "enable" and setting("disable-user-extensions") == "true":
                print("GNOME has all user extensions turned off. Turn them on in Extensions to use Screenshot Utils.")
        else:
            raise ValueError("Unknown operation")
except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
    print(f"Screenshot Utils: {error}", file=sys.stderr)
    sys.exit(1)
PY
    }

    for dependency in python3 gsettings gnome-extensions; do require "$dependency"; done
    exists=false
    installed_version=unknown
    state=Disabled
    if [[ -e $installed_dir || -L $installed_dir ]]; then
        exists=true
        installed_version=$(helper version "$installed_dir/metadata.json" 2>/dev/null) || installed_version=unknown
        state=$(helper status) || fail 'Could not read GNOME extension settings. Nothing changed.'
        printf 'Installed: Screenshot Utils v%s\nStartup: %s\n' "$installed_version" "$state"
    else
        printf 'Screenshot Utils is not installed.\n'
    fi

    reset_settings() {
        if confirm 'Reset Screenshot Utils preferences and extension-managed shortcuts?' N; then
            require dconf
            dconf reset -f /org/gnome/shell/extensions/screenshot-utils/ || fail 'Could not reset preferences.'
            printf 'Preferences and extension-managed shortcuts reset.\n'
        else
            printf 'Preferences and shortcuts kept.\n'
        fi
    }
    offer_enable() {
        local current
        current=$(helper status) || fail 'Could not read GNOME extension settings.'
        if [[ $current == Enabled ]]; then
            printf 'Screenshot Utils remains enabled in GNOME settings.\n'
        elif confirm 'Enable Screenshot Utils?' Y; then
            helper enable || fail 'Could not enable Screenshot Utils.'
            printf 'Screenshot Utils enabled for your next login.\n'
        else
            printf 'Screenshot Utils remains disabled. Enable it later in Extensions.\n'
        fi
    }

    action=1
    if ! "$automatic"; then
        if "$exists"; then
            printf '\n1) Install/update\n2) Enable/disable\n3) Reset settings\n4) Uninstall\nq) Quit\n' >&3
        else
            printf '\n1) Install\nq) Quit\n' >&3
        fi
        printf 'Choose an action [1]: ' >&3
        IFS= read -r action <&3 || exit 0
        action=${action:-1}
    fi
    case "$action" in
        q|Q) exit 0 ;;
        2|3|4) "$exists" || fail 'Screenshot Utils is not installed.' ;;
        1) ;;
        *) fail 'Unknown action. Nothing changed.' ;;
    esac
    case "$action" in
        2)
            if [[ $state == Enabled ]]; then
                if confirm 'Disable Screenshot Utils?' N; then
                    helper disable || fail 'Could not disable Screenshot Utils.'
                    printf 'Screenshot Utils disabled.\n'
                fi
            else
                offer_enable
            fi
            exit 0 ;;
        3) reset_settings; exit 0 ;;
        4)
            if ! confirm 'Uninstall Screenshot Utils? Saved screenshots will be kept.' N; then
                printf 'Uninstall cancelled. Nothing changed.\n'; exit 0
            fi
            if gnome-extensions uninstall "$uuid"; then
                helper remove || fail 'Files removed, but GNOME startup settings could not be cleared.'
            else
                printf 'GNOME could not uninstall it directly. Removing the installed extension files for this user.\n'
                helper uninstall "$installed_dir" || fail 'Could not finish uninstalling. The extension may remain disabled with files still present.'
            fi
            printf 'Screenshot Utils uninstalled. GNOME custom shortcuts and saved screenshots kept.\n'
            reset_settings
            printf 'Log out and back in if Screenshot Utils is still running.\n'
            exit 0 ;;
    esac

    for dependency in curl gnome-shell mktemp rm; do require "$dependency"; done
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
    printf 'GNOME Shell: %s\nChecking latest compatible release…\n' "$major"
    download_dir=$(mktemp -d "${TMPDIR:-/tmp}/screenshot-utils-install.XXXXXXXX") || fail 'Could not create a temporary directory.'
    trap 'rm -rf -- "$download_dir"' EXIT
    archive="$download_dir/$asset"
    url="https://github.com/fhaefele/screenshot-utils/releases/latest/download/$asset"
    if ! curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
        --retry 2 --connect-timeout 15 --max-time 120 --output "$archive" "$url"; then
        fail 'Download failed. Nothing was installed.'
    fi
    target_version=$(helper archive "$archive" "$major") || fail 'Invalid release package. Nothing was installed.'
    printf 'Latest compatible release: v%s\n' "$target_version"
    operation=install
    if "$exists"; then
        operation=reinstall
        if [[ $installed_version != unknown ]]; then
            operation=$(helper compare "$installed_version" "$target_version")
        fi
    fi
    case "$operation" in
        install) question="Install Screenshot Utils v$target_version?"; default=Y ;;
        update) question="Update v$installed_version to v$target_version?"; default=Y ;;
        reinstall)
            printf 'Reinstall replaces files; it does not reset preferences.\n'
            question="Reinstall v$target_version?"; default=N ;;
        newer)
            printf 'Installed version is newer. No downgrade performed.\n'
            offer_enable; exit 0 ;;
    esac
    if ! confirm "$question" "$default"; then
        printf 'Installation skipped.\n'
        if "$exists"; then offer_enable; fi
        exit 0
    fi
    gnome-extensions install --force "$archive" || fail 'Installation failed. Check the GNOME Extensions error above.'
    case "$operation" in
        install) printf 'Installed Screenshot Utils v%s.\n' "$target_version" ;;
        update) printf 'Updated Screenshot Utils v%s to v%s.\n' "$installed_version" "$target_version" ;;
        reinstall) printf 'Reinstalled Screenshot Utils v%s.\n' "$target_version" ;;
    esac
    if "$exists"; then reset_settings; fi
    offer_enable
    printf 'Log out and back in to load Screenshot Utils v%s.\n' "$target_version"
)

main "$@"
