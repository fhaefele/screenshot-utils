#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
target=${1:?Specify legacy or modern}
major=$(gnome-shell --version | awk '{split($3, version, "."); print version[1]}')
case "$target:$major" in
    legacy:42|legacy:43|legacy:44|modern:45|modern:46|modern:47|modern:48|modern:49|modern:50|modern:51) ;;
    *) echo "Unsupported test target $target on Shell $major" >&2; exit 1 ;;
esac
export SCREENSHOT_UTILS_TEST_TARGET="$target"
printf "GNOME %s: preparing %s test session\n" "$major" "$target"
test_root=$(mktemp -d)
cleanup() {
    result=$?
    if mountpoint -q "$test_root/runtime/doc" && command -v fusermount3 >/dev/null; then
        fusermount3 -u "$test_root/runtime/doc" || true
    fi
    rm -rf "$test_root" || true
    exit "$result"
}
trap cleanup EXIT HUP INT TERM
export XDG_DATA_HOME="$test_root/data"
export XDG_CONFIG_HOME="$test_root/config"
export XDG_CACHE_HOME="$test_root/cache"
export XDG_RUNTIME_DIR="$test_root/runtime"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_DATA_DIRS=/usr/local/share:/usr/share
# Shell and preferences write concurrently; dconf preserves unrelated updates.
export GSETTINGS_BACKEND=dconf
if test "$target" = legacy; then
    export GJS_PATH="$PWD/dist/tests"
    export SHELL_PERF_MODULE=screenshotUtils
    export SCREENSHOT_UTILS_LEGACY_TESTS="$PWD/dist/tests/preferences-legacy.js"
fi
export MUTTER_WM_CLASS_FILTER=Gnome-shell-perf-helper,org.gnome.Shell.Extensions
export LIBGL_ALWAYS_SOFTWARE=1
export GIO_USE_VFS=local
unset DBUS_SESSION_BUS_ADDRESS DISPLAY DCONF_PROFILE
# Keep the entire desktop, its settings and its D-Bus activation isolated.
dbus-run-session -- sh -eu -c '
    export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
    printf "Installing %s test package\n" "$SCREENSHOT_UTILS_TEST_TARGET"
    gnome-extensions install --force "dist/$SCREENSHOT_UTILS_TEST_TARGET/screenshot-utils@fxth.dev.shell-extension.zip"
    gsettings set org.gnome.shell enabled-extensions "[\"screenshot-utils@fxth.dev\"]"
    if test "${SCREENSHOT_UTILS_TEST_SHELL_MODE:-user}" = ubuntu; then
        # Exercise Yaru without unrelated bundled extensions racing our lifecycle tests.
        disabled=$(node --input-type=module -e "
            import {readFileSync} from \"node:fs\";
            const mode = JSON.parse(readFileSync(\"/usr/share/gnome-shell/modes/ubuntu.json\", \"utf8\"));
            process.stdout.write(JSON.stringify(mode.enabledExtensions ?? []));
        ")
        gsettings set org.gnome.shell disabled-extensions "$disabled"
    fi
    gsettings set org.gnome.desktop.interface cursor-theme DMZ-White
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "99"
    printf "Starting %s Shell integration suite\n" "$SCREENSHOT_UTILS_TEST_TARGET"
    if test "$SCREENSHOT_UTILS_TEST_TARGET" = modern; then
        set -- --automation-script "$PWD/tests/shell.js" --force-animations
    else
        set --
    fi
    if test "$SCREENSHOT_UTILS_TEST_TARGET" = legacy; then
        xvfb-run -a -s "-screen 0 1280x800x24" gnome-shell --nested --wayland --no-x11 --mode="${SCREENSHOT_UTILS_TEST_SHELL_MODE:-user}" "$@"
    else
        gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --mode="${SCREENSHOT_UTILS_TEST_SHELL_MODE:-user}" "$@"
    fi
'
