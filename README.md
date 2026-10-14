# Screenshot Utils

Native screenshots for GNOME Shell 42-51 on Wayland, including Ubuntu 22.04/24.04/26.04.

![Screenshot Utils capture menu and preferences](https://raw.githubusercontent.com/fhaefele/screenshot-utils/main/assets/screenshot-utils.png)

- Selection, Screen and Window capture. Release a selection or choose a window from the thumbnail dialog to capture after the chosen delay. Escape/right-click cancels; a selection click without dragging also cancels.
- Stepped delay: 0-30 seconds. Exact seconds, save folder, filenames, mouse pointer, clipboard, sound and notifications in Preferences. Sound mute also applies to GNOME's native screenshots.
- PNGs saved to Pictures by default. Absolute, `~/` and home-relative paths supported; missing folders created. For delayed selections, move the pointer inside the area before capture.

Filename tokens: `{date}` = YYYY-MM-DD, `{time}` = HH-MM-SS, `{type}`/`{N}` = area/screen/window; `{Y}` `{m}` `{d}` = year/month/day, `{H}` `{M}` `{S}` = hour/minute/second. Preview updates when the template changes.

## Install

Download the matching ZIP from [Releases](https://github.com/fhaefele/screenshot-utils/releases/latest).

Shell 42-44, including Ubuntu 22.04:

```sh
gnome-extensions install --force screenshot-utils-gnome42-44.shell-extension.zip
```

Shell 45-51:

```sh
gnome-extensions install --force screenshot-utils-modern.shell-extension.zip
```

After installing or updating, log out/in, then enable in Extensions. Build from source with `npm ci && npm run pack`; ZIPs written to `dist/legacy/` and `dist/modern/`. The legacy entry points are generated from the shared source.

## Keyboard shortcuts

Shortcuts are off by default. Turn on **Enable keyboard shortcuts**, then choose **GNOME Keyboard Settings** or **Extension**. Turning the switch off cancels pending shortcut captures and preserves the configuration. Panel buttons remain available.

**GNOME Keyboard Settings** preserves existing custom shortcuts. Add a name, command and key in View and Customize Shortcuts → Custom Shortcuts. Preferences provides copy buttons and opens Keyboard Settings. Commands also work in a terminal:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture selection
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture screen
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture window
```

**Command permission** defaults to **Ask for every request**. **Allow without asking** requires one Shell confirmation and permits any local application to request screenshots without further prompts. Approval persists across logins, Shell restarts and locking. Turning shortcut access off, changing the source/permission, explicitly disabling the extension, or uninstalling it revokes approval. Use **Approve command access** when approval is required; **Keep asking** restores individual confirmation. Saved permissions follow the normal desktop-settings trust model: unrestricted programs running as you can modify them. The installation record is removed on uninstall; reinstalling or replacing the installation directory requires approval again. Notifications can be off without suppressing confirmation.

**Extension** provides Selection, Screen and Window key recorders with Clear buttons. Keys start unassigned and activate immediately after assignment, without approval dialogs. They work again after login/restart while the master switch stays on. GNOME reserves the combinations globally; occupied combinations are rejected without replacing previous assignments or other system shortcuts. External screenshot commands are disabled in this mode. Switching modes preserves assignments; existing GNOME custom shortcuts remain untouched and may occupy combinations.

Captures use the extension's preferences and respect GNOME's disk-saving restrictions. Print Screen stays unchanged unless you explicitly reassign it in GNOME Keyboard Settings. Turning command access off cancels pending command captures.

## Test

```sh
npm test
npm run lint
npm run test:gnome  # Shell 45-51
npm run test:legacy # Shell 42-44
```

CI checks unit tests, syntax and schemas, builds both ZIPs, and runs the shared integration suite on Ubuntu 22.04 / Shell 42, Ubuntu 24.04 / Shell 46 and Ubuntu 26.04 / Shell 50. Other supported versions are validated locally with the same automated suite. Matching annotated version tags publish both packages using their tag notes. Shell tests run with isolated settings; `test:gnome` requires Shell 45-51, and `test:legacy` requires Shell 42-44.

For manual testing, install the matching ZIP above, then:

```sh
sudo apt install mutter-dev-bin
XDG_DATA_DIRS=/usr/local/share:/usr/share dbus-run-session -- gnome-shell --devkit --wayland
```

Inside the nested desktop: `gnome-extensions enable screenshot-utils@fxth.dev`. Check all capture modes, delay, cancellation, pointer, clipboard, sound, notifications and preferences. Test shortcut commands in its terminal; verify assigned keys in a normal GNOME session. Repack/reinstall and restart the nested Shell after changes. Shell 42-48 uses `--nested` instead of `--devkit`.

Manually tested only on Shell 50.1. All supported Shell versions, 42-51, passed automated integration tests. Multiple monitors and fractional scaling need live testing. Manual nested testing uses your normal folders and preferences. Print Screen still opens GNOME's own screenshot UI.

## License

GPL-3.0-or-later. Inspired by [Screenshot Tool](https://github.com/OttoAllmendinger/gnome-shell-screenshot) and [No Screenshot Box](https://github.com/abdallah-alkanani/no-screenshot-box). See [LICENSE](LICENSE).
