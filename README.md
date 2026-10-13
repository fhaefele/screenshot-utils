# Screenshot Utils

Native screenshots for GNOME Shell 42-51 on Wayland, including Ubuntu 22.04/24.04/26.04.

![Screenshot Utils capture menu and preferences](https://raw.githubusercontent.com/fhaefele/screenshot-utils/main/assets/screenshot-utils.png)

- Selection, Screen and Window capture. Release a selection or click a window to capture after the chosen delay. Escape/right-click cancels; a selection click without dragging also cancels.
- Stepped delay: 0-30 seconds. Exact seconds, save folder, filenames, mouse pointer, clipboard, sound and notifications in Preferences. Sound mute also applies to GNOME's native screenshots.
- PNGs saved to Pictures by default. Absolute, `~/` and home-relative paths supported; missing folders created. For delayed selections, move the pointer inside the area before capture.

Filename tokens: `{date}` = YYYY-MM-DD, `{time}` = HH-MM-SS, `{type}`/`{N}` = area/screen/window; `{Y}` `{m}` `{d}` = year/month/day, `{H}` `{M}` `{S}` = hour/minute/second. Preview updates when the template changes.

## Install

Download the ZIP from [Releases](https://github.com/fhaefele/screenshot-utils/releases/latest). Use `screenshot-utils-gnome42-44.shell-extension.zip` for Shell 42-44, including Ubuntu 22.04, or `screenshot-utils-modern.shell-extension.zip` for Shell 45-51. Both packages use the same extension UUID, settings and capture logic:

```sh
gnome-extensions install --force screenshot-utils-modern.shell-extension.zip
```

After first install, log out/in, then enable in Extensions. Build from source with `npm ci && npm run pack`; ZIPs written to `dist/legacy/` and `dist/modern/`. The legacy entry points are generated from the shared source.

## Keyboard shortcuts

Preferences → Keyboard Shortcuts shows commands with copy icons and opens Keyboard Settings. In View and Customize Shortcuts → Custom Shortcuts, add a name, paste the command and choose a key. Commands also work in a terminal:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture selection
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture screen
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture window
```

GNOME stores the shortcuts across logins and handles conflicts. Commands require this extension enabled and use its capture preferences; local session-bus clients can call them. Captures respect GNOME's disk-saving restrictions. Print Screen stays unchanged unless you explicitly reassign it.

## Test

```sh
npm test
npm run test:gnome  # Shell 45-51
npm run test:legacy # Shell 42-44
```

CI checks unit tests, syntax and schemas, builds both ZIPs, and runs the shared integration suite on Ubuntu 22.04 / Shell 42 and Ubuntu 24.04 / Shell 46. Matching annotated version tags publish both packages using their tag notes. Shell tests run with isolated settings; `test:gnome` requires Shell 45-51, and `test:legacy` requires Shell 42-44.

For manual testing, install the ZIP above, then:

```sh
sudo apt install mutter-dev-bin
XDG_DATA_DIRS=/usr/local/share:/usr/share dbus-run-session -- gnome-shell --devkit --wayland
```

Inside the nested desktop: `gnome-extensions enable screenshot-utils@fxth.dev`. Check all capture modes, delay, cancellation, pointer, clipboard, sound, notifications and preferences. Test shortcut commands in its terminal; verify assigned keys in a normal GNOME session. Repack/reinstall and restart the nested Shell after changes. Shell 42-48 uses `--nested` instead of `--devkit`.

Manually tested only on Shell 50.1. All supported Shell versions, 42-51, passed automated integration tests. Multiple monitors and fractional scaling need live testing. Manual nested testing uses your normal folders and preferences. Print Screen still opens GNOME's own screenshot UI.

## License

GPL-3.0-or-later. Inspired by [Screenshot Tool](https://github.com/OttoAllmendinger/gnome-shell-screenshot) and [No Screenshot Box](https://github.com/abdallah-alkanani/no-screenshot-box). See [LICENSE](LICENSE).
