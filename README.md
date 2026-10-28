# Screenshot Utils

Capture a selection, screen or window as a PNG in GNOME Shell 42-51 on Wayland.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshot-utils-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/screenshot-utils.png">
  <img alt="Screenshot Utils capture menu and preferences" src="assets/screenshot-utils.png">
</picture>

- Set a capture delay from 0 to 30 seconds in the menu.
- Toggle mouse cursor capture with the cursor icon beside the clock. The theme accent means on; dimmed means off.
- Choose the screenshot folder, filename template, clipboard, sound and notifications in Preferences. Screenshots save to Pictures by default. Muting the sound also mutes GNOME's own screenshots.

Release a selection or choose a window to capture. Escape or right-click cancels.

## Install

Install or manage Screenshot Utils with one command. Requires Bash, Python 3, curl and GNOME's extension tools. Installs for the current user without sudo.

```sh
curl -fsSL https://raw.githubusercontent.com/fhaefele/screenshot-utils/main/scripts/install.sh | bash
```

The menu offers install/update, enable/disable, reset and uninstall. It shows installed and target versions. Updates preserve preferences by default; reinstall, reset and uninstall require confirmation. Reset affects only Screenshot Utils preferences, requires `dconf`, and keeps GNOME custom shortcuts and screenshot files.

For unattended install/update and enable, use `bash scripts/install.sh --yes` after downloading the script. This never reinstalls, downgrades, resets settings or uninstalls.

Or download the matching ZIP from [Releases](https://github.com/fhaefele/screenshot-utils/releases/latest).

GNOME Shell 42-44:

```sh
gnome-extensions install --force screenshot-utils-gnome42-44.shell-extension.zip
```

GNOME Shell 45-51:

```sh
gnome-extensions install --force screenshot-utils-modern.shell-extension.zip
```

After installing or updating, log out and back in to load the new code. The installer offers to enable Screenshot Utils. For manual ZIP installs, enable it in Extensions.

Preferences shows the installed version and checks GitHub for updates when opened, at most once every 24 hours. A `latest: v<version>` link appears only for a newer compatible release and opens its GitHub page. Rerun the installer to update.

## Keyboard shortcuts

Shortcuts start off. In Preferences, turn on **Enable keyboard shortcuts**. Configure custom shortcuts under GNOME Keyboard settings → View and customize shortcuts → Custom shortcuts → Add. Copy the commands from Preferences.

**Ask for every request** starts on. When off, any local application can invoke the commands without confirmation. The choice persists across logins and restarts. Unrestricted programs running as you can change these settings, including turning confirmation off.

Turning shortcuts off cancels pending shortcut captures and keeps GNOME assignments. Print Screen stays unchanged.

Extension-managed shortcuts have been removed. Existing GNOME shortcuts and confirmation settings are preserved. Former extension-mode setups upgrade with shortcuts off and confirmation on; recreate their keys in GNOME Keyboard settings.

## Build and test

```sh
npm ci
npm run pack
npm test
npm run lint
npm run test:gnome  # GNOME Shell 45-51
npm run test:legacy # GNOME Shell 42-44
```

Packages are in `dist/legacy/` and `dist/modern/`. Shell tests use isolated settings. CI runs GNOME Shell 42, 46 and 50. Multiple monitors and fractional scaling still need manual testing.

## License

[GPL-3.0-or-later](LICENSE). GitHub mark from [Octicons](https://github.com/primer/octicons), MIT. Inspired by [Screenshot Tool](https://github.com/OttoAllmendinger/gnome-shell-screenshot) and [No Screenshot Box](https://github.com/abdallah-alkanani/no-screenshot-box).
