# Ubuntu desktop configuration

Scripts which turn an Ubuntu desktop installation into a
[malleable computer](https://world.hey.com/dhh/the-malleable-computer-7c187a9b): a system whose behavior is
changed to fit its user, not only its settings. On Linux the whole system is open source, so when a setting is
not enough, the program itself can be changed. With AI assistance, doing so has become practical even for parts
of the system one has never looked into, like the terminal or the window manager.

The configuration here is highly opinionated: it is how I like my computer. But the code is free to reuse. Use
whatever helps and adapt it to your own liking.

It targets Ubuntu 26.04 with GNOME 50 on a Framework Laptop 13 Pro.

## Contents

- [How it works](#how-it-works): scripts which show their changes before applying them, and Ubuntu packages patched,
  tested and rebuilt daily.
- [Preferences](#preferences): the desktop changed to my liking, where others may prefer GNOME's defaults.
  - [Keyboard like on macOS](#keyboard-like-on-macos): Control under the thumb in every application, the terminal
    included.
  - [One key for Claude Quick Entry](#one-key-for-claude-quick-entry): a tap of the right Super opens Claude
    Desktop's Quick Entry.
  - [Terminal shortcuts and palettes](#terminal-shortcuts-and-palettes): Ctrl+G for the next search match, copying as
    HTML, and selection colours in palettes.
  - [Chromium quits with Ctrl+Q](#chromium-quits-with-ctrlq): a small extension binds the key, and Chromium keeps its
    whole session.
  - [A launch opens a new window](#a-launch-opens-a-new-window): Firefox, Text Editor and the terminal open pages,
    files and shells in a new window on the current workspace.
  - [Text Editor keeps unsaved documents without warnings](#text-editor-keeps-unsaved-documents-without-warnings): no
    entry in the logout dialog and no banner for them.
  - [Text Editor closes a window with its last tab](#text-editor-closes-a-window-with-its-last-tab): Ctrl+W on the
    last tab closes the window, and in the last window quits Text Editor. A closed window does not come back, while
    Ctrl+Q keeps every window.
  - [No screenshots on the lock screen](#no-screenshots-on-the-lock-screen): the button and the keys do nothing while
    the screen is locked.
  - [Power and lid sounds follow the System Sounds switch](#power-and-lid-sounds-follow-the-system-sounds-switch): no
    sound for the power cable, the lid and a low battery.
  - [Battery charge thresholds on Framework laptops](#battery-charge-thresholds-on-framework-laptops): Preserve
    Battery Health keeps the battery between 40% and 60%.
  - [Hardware tweaks](#hardware-tweaks): the touchscreen and the power button light off, keys repeating only after a
    second, and disk writes recorded for every unit.
- [Additions](#additions): tools and features which Ubuntu does not have.
  - [Third-party APT repositories pinned to their packages](#third-party-apt-repositories-pinned-to-their-packages): a
    vendor repository can install and upgrade only the packages in use from it.
  - [Packages without an APT repository kept up to date](#packages-without-an-apt-repository-kept-up-to-date):
    vendors' `.deb` files downloaded daily, verified, and upgraded like any other package.
  - [Daily mail of failures and errors](#daily-mail-of-failures-and-errors): failed units, errors and crash reports
    from the journals of the system and of every user.
  - [Processor throttling](#processor-throttling): a top bar indicator naming the limit which holds the processor
    back, and a warning when the fan stops following the heat.
  - [Cooling, performance and battery tracked over time](#cooling-performance-and-battery-tracked-over-time): a
    measurement at night, to follow dust in the fan, slowdowns from updates and the battery's ageing over the years.
  - [FastFlowLM reads a shared history once](#fastflowlm-reads-a-shared-history-once): language models on the NPU
    continue prompts which share all but their last message from a saved state.
- [Fixes](#fixes): bugs fixed here, most of them reported or proposed upstream too.
  - [Applications quit cleanly and return as they were](#applications-quit-cleanly-and-return-as-they-were): every
    application runs in its own scope and quits before the session ends, and windows, documents and terminal tabs
    return also after a crash.
    - [Applications start inside their own scope](#applications-start-inside-their-own-scope): every process of an
      application starts in its scope, and none is stopped with the service which launched it.
    - [Applications finish quitting before the session ends](#applications-finish-quitting-before-the-session-ends):
      Firefox, Chromium and applications built on Electron do not crash at logout and shutdown.
    - [Applications which withdraw an inhibition leave none behind](#applications-which-withdraw-an-inhibition-leave-none-behind):
      the logout dialog lists only applications which still hold the logout.
    - [Windows return to their places](#windows-return-to-their-places): Firefox, Chromium, Text Editor, the terminal,
      Signal and Slack return to their workspaces, monitors, positions and sizes.
    - [Switching workspaces stays on the chosen workspace](#switching-workspaces-stays-on-the-chosen-workspace):
      the desktop icons extension does not move to a window which demands attention, and Firefox's restored windows
      demand none.
    - [Documents and terminal tabs return also after a crash](#documents-and-terminal-tabs-return-also-after-a-crash):
      Text Editor and the terminal save their state a few seconds after every change.
  - [Firefox runs with its whole sandbox](#firefox-runs-with-its-whole-sandbox): WebAssembly sandboxed libraries,
    Ubuntu's AppArmor profile, and user namespaces for its content processes.
  - [Container tabs open in the window of their page](#container-tabs-open-in-the-window-of-their-page): Firefox
    Multi-Account Containers reopens a page in its container in the same window, also at Firefox's start.
  - [Windows keep their size when the screen locks](#windows-keep-their-size-when-the-screen-locks): snapped and
    maximized windows keep the space the dock leaves them.
  - [Claude Desktop and Slack show their tray icon after every login](#claude-desktop-and-slack-show-their-tray-icon-after-every-login):
    they start at login only once the top bar can show their icons.
  - [Terminal fixes](#terminal-fixes): the visual bell without animations, the terminal in the logout dialog, and the
    directory of new tabs.
  - [Text Editor reads standard input without errors](#text-editor-reads-standard-input-without-errors): no GLib
    criticals when it loads text from a stream.
  - [Magnet links open in a running Transmission](#magnet-links-open-in-a-running-transmission): AppArmor rules for
    passing the link to the running Transmission.
  - [The document portal's filesystem is mounted and unmounted](#the-document-portals-filesystem-is-mounted-and-unmounted):
    AppArmor rules which fusermount3 needs with libfuse 3.17.
  - [File indexing does not crash on vanished downloads](#file-indexing-does-not-crash-on-vanished-downloads):
    localsearch's extractor handles a file deleted before it could read it.
  - [A command's crash is not reported as a crash of timeout](#a-commands-crash-is-not-reported-as-a-crash-of-timeout):
    timeout turns off its own core dumps before it passes on the signal which killed the command.
  - [Only the working internal microphone is offered](#only-the-working-internal-microphone-is-offered): the audio
    coprocessor's microphone input, which has no microphones wired to it, is left out.
  - [snapd's desktop helper starts with the desktop](#snapds-desktop-helper-starts-with-the-desktop): it starts and
    stops with the graphical session.
  - [Media players stay connected to Bluetooth devices after a logout](#media-players-stay-connected-to-bluetooth-devices-after-a-logout):
    mpris-proxy starts again together with the user's D-Bus.
  - [The accessibility bus does not fail when a session ends](#the-accessibility-bus-does-not-fail-when-a-session-ends):
    systemd sends SIGTERM to the bus launcher alone.
  - [GDM does not fail at shutdown](#gdm-does-not-fail-at-shutdown): GDM is stopped before accounts-daemon.
  - [The encrypted disk is not closed while in use at shutdown](#the-encrypted-disk-is-not-closed-while-in-use-at-shutdown):
    the root filesystem's encrypted device is closed in the final phase of the shutdown.
- [Requirements](#requirements): the Ubuntu release, the hardware and the packages the scripts assume.
- [Applying everything](#applying-everything): the order in which to run the scripts.
- [GitHub mirror](#github-mirror): a read-only mirror, for forking the project on GitHub.
- [License](#license): Apache 2.0.

## How it works

Most of the configuration is done by scripts which write settings (mostly through gsettings and dconf, and a few
system files through sudo). Every script by default only shows what it would change, and changes things only
when run with `--apply`. They are idempotent, so they can be rerun at any time to bring the system back to the
configuration or to see how it has drifted from it.

Where a setting is not enough, Ubuntu's own packages are patched. `patches/<source-package>/` contains patches which are
applied on top of Ubuntu's source package, for Firefox the Mozilla Team PPA's, and for FastFlowLM, which publishes no
source package, its newest release in its git repository, together with tests for the patched behavior which run during
the build where the package has a test suite to add them to. The PPA publishes the source to rebuild Firefox with,
unlike Mozilla's own repository (requested in [Mozilla bug
2087959](https://bugzilla.mozilla.org/show_bug.cgi?id=2087959)).

`rebuild-patched-packages.sh` rebuilds a package whenever Ubuntu (or FastFlowLM) publishes a new version of it or its
patches change, and publishes the result to a local APT repository. That repository is pinned above the Ubuntu archive,
so the next ordinary `apt upgrade` installs the patched build. unattended-upgrades installs it only when it would
install the original version by itself, one from Ubuntu's release or security pockets or from the PPAs of Firefox and
Chromium. A generated `Package-Blacklist` keeps it from the other packages of the local repository, such as rebuilds of
Ubuntu's other updates, and from any `.deb` placed there by hand, which `sudo rebuild-patched-packages --refresh`
publishes. A daily cron job keeps patched packages current, running root-owned copies of the script and patches,
installed with `install-rebuild-patched-packages.sh` (`cron.daily/`). The daily run also mails when a Firefox add-on
patched here has a new release (see [Container tabs open in the window of their
page](#container-tabs-open-in-the-window-of-their-page)). The daily cron jobs start at 05:00, after the daily
measurement of cooling and performance at 04:00 and usually early enough for unattended-upgrades, which runs between
06:00 and 07:00, to install a rebuilt package the same morning (`systemd/anacron.timer.d/`). Packages are built the way
Ubuntu builds its own packages, with sbuild in a throwaway chroot without network access, except for FastFlowLM, whose
build downloads its dependencies, with build dependencies installed only inside it. Its unshare mode needs no root even
to set up the chroot, so everything runs as an unprivileged system user, and a package's build scripts and test suite
cannot change the system. Builds run in `/tmp`, whose limit on the number of files is raised, since a Firefox build
holds more files there than systemd's default allows (`systemd/tmp.mount.d/`). GitLab CI builds the patched packages too
and runs the tests in `tests/<source-package>/` against them (`.gitlab-ci.yml`).

Tests which require a whole desktop, such as windows returning to their workspaces after logging out and in, or the
logout dialog, run in a GNOME session in a container (`tests/session/`): the real gnome-session and GNOME Shell,
headless, with the patched packages, the settings of `configure-gnome-desktop.sh` and this repository's session units,
driven through a test extension. GitLab CI runs these tests too.

Packages whose vendors publish a `.deb` but no APT repository are published to the same local repository:
`fetch-vendor-debs.py` downloads the newest version of each daily and verifies it, and the next `apt upgrade` upgrades
it where it is installed (see
[Packages without an APT repository kept up to date](#packages-without-an-apt-repository-kept-up-to-date)).

GNOME Shell extensions are installed from extensions.gnome.org and configured by `configure-gnome-desktop.sh`, with
their settings in `gnome-extensions/`. Custom extensions are installed from the repository.

## Preferences

These sections change the desktop's behavior to my liking. Others may well prefer GNOME's defaults.

### Keyboard like on macOS

The key next to the space bar, pressed with the thumb, acts as Control, where macOS has Command. Copy, paste, and
other common shortcuts are all pressed with the thumb, in every application. The Ctrl key in the corner, pressed
with the pinky, acts as Super. The right side of the space bar mirrors the left: Control, then Super.

This makes the terminal behave like every other application. The pinky key sends control characters (Ctrl+C
interrupts, Ctrl+R searches history), while the thumb key copies and pastes with the same shortcuts as everywhere
else, without the usual Ctrl+Shift+C and Ctrl+Shift+V.

Requirements:

- The keys rotated with XKB options, and GNOME's shortcuts moved to match (`configure-gnome-keys.sh`).
- Super treated as Control inside the terminal, so that the pinky key sends control characters there
  (`patches/vte2.91/`).
- The terminal's own shortcuts on the thumb key, like in other applications (`configure-ptyxis.sh`).
- The console keeping Control under the Ctrl keycaps, with the US layout only (`configure-gnome-keys.sh`).

![The bottom row of the keyboard: the keycaps as they come, the keycaps rearranged as on a Mac, and what each key
sends in GNOME](docs/keyboard-bottom-row.svg)

Note: Framework supports swapping left Ctrl with Fn in BIOS so if you really want complete macOS layout
with Fn key in the left bottom corner position, you can switch additionally those two keys there.

### One key for Claude Quick Entry

Tapping the right Super on its own opens Claude Desktop's Quick Entry, and tapping the left Super on its own opens
the overview. Held together with other keys, both stay an ordinary Super, so Ctrl+Super+L, both right of the
space bar, locks the screen.

Requirements:

- A third key tapped on its own, next to GNOME's overview and locate-pointer keys, which sends a configured key
  combination (`patches/mutter/`). The right Super sends XF86Launch9, which no physical key sends
  (`configure-gnome-keys.sh`).
- Claude Desktop's Quick Entry shortcut set to that key, in the application.

Framework's BIOS can turn the key right of the right Alt into a Copilot key, but do not switch it and leave it as
Right Ctrl, the default. This configuration supersedes a Copilot key: the key stays a full Super, and a tap of it
opens Claude's Quick Entry. As a Copilot key, it would send a fixed key combination instead and could not act as
Super.

### Terminal shortcuts and palettes

Ptyxis, Ubuntu's terminal, is patched and configured (`patches/ptyxis/`, `configure-ptyxis.sh`):

- Ctrl+G moves to the next search match, and Ctrl+Shift+G to the previous one.
- A keyboard shortcut for copying as HTML.
- Palettes can set the selection highlight colours.

Its windows return with their tabs and the last screen of each, also after a crash (see
[Documents and terminal tabs return also after a crash](#documents-and-terminal-tabs-return-also-after-a-crash)), and
a launch opens a new window (see [A launch opens a new window](#a-launch-opens-a-new-window)).

### Chromium quits with Ctrl+Q

Chromium binds no key to Exit on Linux. A small extension binds Ctrl+Q, which the thumb key sends where macOS has
Command+Q (`chromium-extensions/quit-shortcut/`), and starts a native messaging host
(`chromium-native-messaging-hosts/`), a script which ends Chromium with SIGTERM (`chromium-quit.sh`). Chromium handles
that like the end of the desktop session and keeps its whole session, so all its windows return at the next start.
`configure-gnome-desktop.sh` installs all three, and the shortcut can be changed in `chrome://extensions/shortcuts`.

### A launch opens a new window

Firefox, Text Editor and the terminal return the windows of their previous session to their places when they start
(see [Windows return to their places](#windows-return-to-their-places)). A launch then behaves as it does while the
application runs: the restored windows stay where they are, without being activated, and the page, the files or the
shell of the launch appear in a new window on the current workspace, which has the focus.

For Firefox, that is the start page for a launch from the dock, and the link for a link opened from another
application, like a terminal, when the profile opens external links in new windows
(`browser.link.open_newwindow.override.external` set to 2 in `about:config`). Firefox itself restores the first window
of the previous session into the window it opens for the launch, so a link would become a tab of that window, on its
workspace (`patches/firefox/session-restore-launch-window.patch`). A start after a crash opens the new window as well,
while a restart by Firefox itself, such as after an update, restores the windows as they were, without a new one. A
link to a site which Firefox Multi-Account Containers assigns to a container opens in a tab of that container in the
same new window (see [Container tabs open in the window of their
page](#container-tabs-open-in-the-window-of-their-page)).

For Text Editor, started from the dock or for a file opened from the terminal or the file manager, the new window
holds an empty document or the files. A file opened while Text Editor runs opens in a new window as well, unless it is
open already, when its window is shown (`patches/gnome-text-editor/launch-opens-new-window.patch`).

For the terminal, started from the dock or with a directory from the file manager, the new window holds a new shell
(`patches/ptyxis/launch-opens-new-window.patch`).

A link clicked in the terminal reaches the browser with an activation token from the terminal's window, so that GNOME
focuses the browser's window for the click, but not when the user has clicked or typed elsewhere since. The terminal
opens links through libportal, which is patched to request the token for a GTK 4 window (`patches/libportal/`).

### Text Editor keeps unsaved documents without warnings

Text Editor keeps unsaved documents and returns them at its next start, also after logging out, but it still asked
GNOME to hold the logout while a window had one, so GNOME Shell's logout dialog listed it as having unsaved work.
When the session ends, GTK quits Text Editor without the save it runs when it quits otherwise, so without that dialog
the next start would miss the text typed in the few seconds before logging out. Text Editor is patched to hold no
logout while it restores its session, and to save its session when GTK quits it
(`patches/gnome-text-editor/restored-documents-hold-no-logout.patch`). With restore-session off, it still holds the
logout for unsaved documents.

Text Editor also shows no banner above restored documents, since keeping a document unsaved is a normal way to use
it, and a banner would mark every such window as needing attention. The window title still shows whether a document is
unsaved or modified (`patches/gnome-text-editor/hide-restored-banners.patch`).

### Text Editor closes a window with its last tab

Closing the last tab of a Text Editor window, with Ctrl+W, closes the window as well, and so does moving its last tab
to a new window with Ctrl+Shift+N. In the last window, Text Editor quits, and since the document was closed, the next
start restores no window for it and opens a new window with an empty document
(`patches/gnome-text-editor/last-tab-closes-window.patch`).

A window you close does not come back at the next start, the last one neither, so after you close every Text Editor
window one after the other, the next start opens just a new window with an empty document. Unpatched, Text Editor
brings back the window closed last. Quitting with Ctrl+Q brings every window back, and so do logging out, SIGTERM and
a crash (`patches/gnome-text-editor/last-window-leaves-session.patch`). Before a window with unsaved changes closes,
Text Editor still asks whether to save or discard them.

### No screenshots on the lock screen

GNOME Shell offers screenshots on the lock screen, from a button in quick settings and with Print and Shift+Print, so
anyone at the locked machine could save screenshots into the Pictures folder and replace the clipboard's contents.
GNOME Shell is patched so that the button is hidden and both keys do nothing while the screen is locked
(`patches/gnome-shell/`).

### Power and lid sounds follow the System Sounds switch

System Sounds are switched off in Settings (`configure-gnome-desktop.sh`), and gnome-settings-daemon is patched so
that the switch also silences the sounds of its power plugin, which plays them whatever the switch says otherwise:
those for the power cable going in and out, for the lid opening and closing, and for a low battery
(`patches/gnome-settings-daemon/`). Docking and undocking an external monitor which delivers power over USB-C counts
as the cable going in and out. The low battery notification still appears, without its sound, and the warnings of a
critically low battery still sound.

### Battery charge thresholds on Framework laptops

GNOME's Preserve Battery Health keeps the battery between 40% and 60% while the laptop is docked most of the time,
and a quick settings toggle switches back to charging to 100% before traveling.

Requirements:

- The kernel's charge control enabled, which it keeps disabled on Framework laptops by default
  (`modprobe.d/cros-charge-control.conf`).
- The thresholds for UPower, which applies them for Preserve Battery Health (`udev/90-battery-charge-limit.rules`).
- The Preserve Battery Health extension for the quick settings toggle (`configure-gnome-desktop.sh`).
- The estimated time until the battery is empty or full, shown under the battery percentage in quick settings
  (`gnome-extensions/quick-settings-battery-time@mitar.tnode.com/`).
- The firmware's own charge limit at 99%[^charge-limit] and Battery Extender disabled, in the BIOS.

### Hardware tweaks

The touchscreen is disabled, the power button light is off, and a held key starts repeating only after a second, in
the console as well as in GNOME (`udev/`, `systemd/`). A program in the session may lock as much memory as it needs,
as FastFlowLM does to run a model on the NPU (`systemd/user@.service.d/`). systemd records how much every unit reads
from and writes to the disk, system services and the units of the session alike, so that the writes to the SSD can be
traced to the units which cause them (`systemd/system.conf.d/`, `systemd/user.conf.d/`, `systemd/user@.service.d/`).
Its totals count every write three times, once for each layer it passes: the LVM volume, the LUKS device and the NVMe
drive.

## Additions

Tools and features which Ubuntu does not have.

### Third-party APT repositories pinned to their packages

Every third-party repository is configured from this repository (`sources.list.d/`), each with its signing key
embedded in its source, so that APT trusts the key for that repository only. Keys which vendors had put where APT
trusts them for every repository, as Slack's daily cron job does, are removed and kept from coming back. VS Code's
package replaces its source with Microsoft's own on every upgrade unless its debconf answer says not to manage the
repository, which the script sets. ProtonVPN's repository is the exception: Proton's own package configures it, and
the script installs that package when missing.

Third-party repositories are pinned by hostname, with an allowlist of the packages actually in use and a default
deny for everything else from them, so a vendor repository cannot replace an Ubuntu package by publishing a higher
version under the same name (`lockdown-apt-sources.sh`). Unattended upgrades are likewise tied to Ubuntu's own
hosts, so a vendor repository cannot have its packages installed unattended by claiming to be Ubuntu's security
pocket. The only third-party repositories unattended-upgrades installs from are the PPAs of Firefox and Chromium,
since most releases of both browsers are security fixes, each matched by the origin Launchpad names after it.

A vendor's new signing key does not arrive with its packages: `apt update` fails for that repository until the key
in its file in `sources.list.d/` is replaced and the script is applied again.

### Packages without an APT repository kept up to date

For packages whose vendors publish a `.deb` but no APT repository, a daily cron job downloads the newest version of
each into the local APT repository of the patched packages (`fetch-vendor-debs.py`, `install-fetch-vendor-debs.sh`,
`cron.daily/`), from which the next `apt upgrade` upgrades the installed ones, while unattended-upgrades is kept from
them. One which is not installed is only downloaded, ready for `apt install`. The script configures the packages to
fetch, each from one of two kinds of sources: a fixed URL which redirects to the newest `.deb`, signed by the vendor
and verified against the vendor's key kept in `vendor-debs/`, or a GitHub release asset, verified against the SHA256
GitHub publishes for it. A version lower than the one already in the repository is never published, since the
repository's pin would make APT downgrade to it, and a download has to carry the package name it is fetched as, so
that a vendor cannot replace another package through it. When a vendor changes its signing key, the daily fetch
fails, naming the new key, until the key in `vendor-debs/` is replaced and installed again.

### Daily mail of failures and errors

Once a day, a mail lists the units which failed and the errors logged since the previous mail, and no mail is sent
when there were none (`journal-digest.py`, `install-journal-digest.sh`, `cron.daily/`). It reads the systemd
journal of the system and of every user. A failed unit is listed with the last lines its failed run logged, which
usually say why, and errors are grouped by what logged them and their text with the numbers in it left out, so that
one which repeats is listed once with how often and when. New crash reports in `/var/crash` are listed too, since
apport writes them without logging the crash as an error. Known noise can be left out with patterns in
`journal-digest.ignore`. `journal-digest --since -7d` can be used to gather a week's load of messages to determine
patterns from. With `--ignore journal-digest.ignore`, patterns are tried out from the repository before they are
installed.

### Processor throttling

An indicator appears in the top bar while the processor is being held below the speed it would otherwise run
at, and names the limit which holds it there. Its menu breaks that down into the share of the last interval each
limit accounted for, alongside the fan speed, the package power and the temperatures. It is always the first of the
indicators on the right of the top bar, so the icons of applications, which the AppIndicators extension shows there,
follow it whichever started first.

The interfaces the usual tools read for this are Intel's and AMD publishes no equivalent, so the indicator
reads the APU's own metrics table at `/sys/class/drm/card*/device/gpu_metrics` instead. That table counts the
time spent limited by each reason: the sustained power limit, the fast and slow package power limits, a
temperature limit for the cores, for the graphics and for the SoC, and the platform's PROCHOT. It needs an APU
publishing the table in the `gpu_metrics_v3_0` layout, which Strix Point in the Ryzen AI 300 series does.

The menu also shows the fan's speed and the target speed the embedded controller (EC) is bringing it to, both as the
EC reports them through `cros_ec`'s hwmon device. The target is 0 while the fan is off. While
`framework_tool --fansetduty` holds the fan at a fixed duty cycle, the EC does not update the target, which then
keeps the last one its automatic control set. Both are given as a share of 6200 RPM, the top of the EC's fan table,
which the EC does not report. It comes from the EC's source code, where Framework sets the fan's `rpm_max` in
`zephyr/program/framework/azalea/fan.dtsi` of
[EmbeddedController](https://github.com/FrameworkComputer/EmbeddedController) (the EC of this laptop is built as its
`lilac` variant), and it is the fastest the EC's automatic control runs the fan. With `framework_tool --fansetduty`
the fan can spin faster, up to about 7600 RPM at a full duty cycle, which shows as more than 100%. The firmware's
ACPI fan declares 6100 RPM as its full speed in its `_FPS` table instead, and only on or off as its control state,
so it says less than the EC does.

Linux has no say in the fan, the EC runs it by itself from its own temperature sensors. According to the EC's source
code, which the EC's `EC_CMD_THERMAL_GET_THRESHOLD` host command confirms, the fan follows only the three F75303
sensors on the board. Each of them keeps the fan off up to 50 C and above that asks for a speed which grows from
2100 RPM to the top of the fan table at 70 C (69 C for the one next to the APU, and 46 C to 60 C for the one next to
the memory), and the EC runs the fan at the fastest speed any of them asks for. The fourth sensor, the APU's own
temperature which the EC reads over SB-TSI and which shows as `cpu@4c`, asks for the fan only from 103 C, and the EC
uses it to throttle and to shut down the APU when it overheats.

The indicator also turns red and shows THM, and its menu a warning, when the EC's fan control stops following the
processor's heat. After days of uptime the EC has been seen to stop updating its sensors. The three F75303 readings
come from one chip, which shares an I2C bus with the APU's SB-TSI, and the EC's driver for it keeps reporting the
last temperature it read when it cannot read the chip any more. The readings then stay at the values they had, and
the fan stays at the speed those values ask for, which is off when they stopped below 50 C. A suspend and resume
makes the EC read them again. The indicator tells that the fan does not follow the heat from either of two signs.
One is that no fan has spun for 30 seconds in a row while the hottest core was at 70 C or more: the board warms up
after the cores do, but starting from a cool board with the fan off, a working EC starts the fan at most about 10
seconds after the hottest core reaches 70 C, and under lighter loads before the cores reach it. The other is that
none of the board readings has changed for 2 minutes while the hottest core has been at 70 C or more for the last 30
seconds in a row: the readings are in whole degrees and can all stay the same for minutes while the processor idles,
but once it heats up, at least one of them changes within seconds, until a steady load settles the board. This sign
is not judged while the EC's fan target is at 95% or more of the top of its fan table. A build on all threads held
at the sustained power limit, with the fan at full speed, settled the board so that all of its readings stayed the
same for minutes, and a reading which stopped changing there leaves the fan close to the fastest a fresh one could
ask for anyway. The warning stays until the sign which raised it is gone, so until a fan spins again or a board
reading changes.

### Cooling, performance and battery tracked over time

Every day at 04:00, if the laptop is on AC power, its screen is locked and its load is low, a measurement records
how well it cools itself, how fast its processor is and how its battery ages, so that all three can be followed over
months and years
(`health-benchmark.py`, `install-health-benchmark.sh`, `systemd/health-benchmark.*`). Dust builds up in the fan and
in the fins it blows through, and firmware, microcode and kernel updates, with the mitigations they bring, can make
the processor slower without anything else showing it. A day on which the laptop is suspended, in use or busy at
04:00 is skipped, and the measurement made the next day.

A measurement holds the fan at a full duty cycle and the power profile at performance for about 25 minutes. With
the fan at full speed at rest, it records the temperatures and the power, and the fan's speed shows the fan's
state: it falls as the fan wears, and rises as dust clogs the fins, because a blocked fan has less air to push.
Then come 7-Zip's benchmark on all threads and on one, and perf's context switch and system call benchmarks, where
kernel mitigations cost the most. A steady load follows until the heatsink has warmed up. Compared with
the idle phase, it gives the thermal resistance of the cooling: how many degrees the APU warms per watt more it
draws. The room's temperature cancels out of that difference, so no sensor for it is needed. The
cooldown after it gives the time constant with which the temperature falls. Both grow as dust accumulates. The
fan runs at full speed throughout, so that dust shows in these two and not in the scores. Nothing is recorded when
other processes used more than 1% of the CPU time during any of the phases, since that would have cost the scores
about as much, nor when anything powered the NPU, which heats the same package and shares its power budget, nor when
the screen is unlocked, AC power is disconnected or the laptop suspends during the measurement. Such a day is
skipped, while a measurement which fails, for example because the EC stopped reading its sensors (see
[Processor throttling](#processor-throttling)), leaves `health-benchmark.service` failed, which the
[daily mail](#daily-mail-of-failures-and-errors) then reports.

For the battery, each measurement records the values the battery's fuel gauge reports: the full capacity it
estimates, the design capacity and the charge cycles. The gauge recalculates the full capacity only after the battery
has discharged far enough between two rests, which a battery kept between 40% and 60% rarely does, so the estimate
can stay the same for weeks and then jump. The measurement also determines the battery's internal resistance, which
grows steadily as the battery ages. For the first 90 seconds of the idle phase and of the steady load, the battery
powers the laptop although AC power is connected (`charge_behaviour` set to `force-discharge`), and the resistance is
the drop of the battery's voltage from idle to load divided by the rise of its current. The battery reports its
current averaged over tens of seconds, which is why each hold lasts 90 seconds and only its last 15 seconds count.
Both holds together draw about 1.4 Wh, about 2% of the battery. The resistance also rises when the battery is cold,
and the battery reports no temperature, so it is best compared between measurements made in similar rooms. The
battery returns to automatic charging after each hold, and if a crash interrupts a measurement,
`health-benchmark-restore.service` returns it at the next boot, because the EC can keep the battery discharging
across a reboot.

7-Zip is a static build of a pinned release, verified by its checksum, so that its scores stay comparable across
years and only the hardware, firmware, microcode and kernel can move them. Each measurement records those as well, in
`/var/lib/health-benchmark/results.csv`, which everyone can read, and keeps the samples it read every second in
`traces/` next to it. Each measurement also records the connected external displays, whether a wired network link is
up, and the USB-C power source, which together tell a dock from a plain charger. The cooling depends on where the
laptop stands, and away from its desk it may stand where less air reaches it, which can make the cooling measure a
quarter worse. The report therefore uses only docked measurements, those with an external display connected and a
wired network link up, for its best values, and marks the undocked ones.

`health-benchmark` without arguments reports the latest measurement as a share of the best one for each value, and
lists what changed since the measurement with the best performance. `sudo health-benchmark --run --note "..."`
measures right away, which marks a reference point, for example before and after cleaning the fan.

### FastFlowLM reads a shared history once

FastFlowLM runs language models on the NPU of the Ryzen AI processor. Its server saves the state of a model while it
reads a prompt, so that a later prompt which starts the same way continues from there instead of reading everything
again, but only at the end of a system prompt of at least 512 tokens and at the end of each prompt. Prompts which share
everything but their last message, like the same few-shot examples followed by different inputs, therefore read the
shared part again every time. FastFlowLM is patched to save the state at the start of the last user message too, once a
prompt shares everything before it with the prompt before (`patches/fastflowlm/`). With 3,500 tokens of examples, from
the third prompt on Qwen3.6-35B-A3B reads a prompt in about 5 seconds instead of 18, and Qwen3.8-27B in 4.5 seconds
instead of 33. A chat, whose turns only continue each other, saves no such state and is as fast as without the patch.

FastFlowLM publishes its releases as `.deb` files on GitHub, but no source package, so `rebuild-patched-packages.sh`
builds it from the newest release in its git repository, instead of `fetch-vendor-debs.py` downloading its `.deb`. Its
build downloads the Rust crates and codec sources it needs, so it is the one package built with network access.

## Fixes

Bugs fixed here, most of them reported or proposed upstream too, with the local fix kept until Ubuntu ships one.

### Applications quit cleanly and return as they were

Applications run in a systemd scope of their own, quit cleanly when the session ends, and return as they were at
their next start, after a logout as well as after a crash or a reset of the machine:

- Every application which GNOME launches, or which another application launches through GLib, as GTK and GIO
  applications do, starts with all its processes in a scope of its own.
- The session ends only once the applications have quit. GTK 4 applications quit when the portal announces the end
  of the session, and Firefox is patched to do the same. Chromium and applications built on Electron, like Signal,
  Slack and Claude Desktop, are ended by a user service, so that they shut down their helper processes themselves.
- Firefox, Chromium, Text Editor and the terminal return their windows to their workspaces, monitors, positions and
  sizes, without switching the workspace, and extensions place the windows of Signal and Slack.
- Text Editor and the terminal save their unsaved documents and the screens of their tabs a few seconds after every
  change, and return them also after a crash.

#### Applications start inside their own scope

GNOME Shell, gnome-session and gnome-settings-daemon ask systemd to put each application they launch into a scope of its
own, `app-gnome-<application>-<pid>.scope`. They asked only once GLib had started the application, and systemd moves
only the process it is given, so the processes the application started in the meantime stayed in the cgroup of the
service which launched it, and were stopped with that service, before the application. Signal's zygotes and GPU process
stayed in gnome-session's cgroup, and Thunderbird's crash helper in GNOME Shell's. GLib is patched so that
gio-launch-desktop, through which GLib starts every application, asks systemd for the scope itself and waits until it is
in the scope before it executes the application, so that every process of the application starts there. GNOME Shell,
gnome-session and gnome-settings-daemon are patched to leave the scope to GLib (`patches/glib2.0/`,
`patches/gnome-shell/`, `patches/gnome-session/`, `patches/gnome-settings-daemon/`). Other processes which launch
applications through GLib, such as xdg-desktop-portal for links opened in other applications, or xdg-open in a terminal,
which exits right after launching, put them into a scope of their own too. An application starts about 25 ms later for
it. GNOME Shell's commands, run with Alt+F2, and gnome-settings-daemon's fallback Orca are launched the same way.

Firefox runs an executable chosen as the handler of a link or a file type, for example with "Use other..." in its
Applications settings, without GLib, so the handler stays in Firefox's cgroup and ends together with Firefox when
systemd-oomd kills Firefox's scope or systemd stops it. Firefox is patched to launch such a handler through GLib,
which starts it in a scope of its own and, on Wayland, passes it an activation token
(`patches/firefox/local-handler-through-gio.patch`).

GLib's developers are preparing GLib to create these scopes itself, in
[merge request 5350](https://gitlab.gnome.org/GNOME/glib/-/merge_requests/5350) and a follow-up announced there, and the
patches can be dropped once a GLib which does is in Ubuntu.

#### Applications finish quitting before the session ends

Before a session ends, GNOME tells applications through the Inhibit portal that it ends, and GTK 4 applications quit
then. The portal answered GNOME at once, though, so the session ended about 30 ms later, and systemd stopped the
applications and GNOME Shell while they were still quitting. The portal is patched to let the session end only once
every application which monitors the session through it has quit, or after 8 seconds (`patches/xdg-desktop-portal-gtk/`).

Firefox did not monitor the session through the portal, and was killed by the SIGTERM systemd sends at the end of a
session: Firefox 122 added a handler which quits cleanly on SIGTERM, but installs it too early for it to work
([Mozilla bug 2086801](https://bugzilla.mozilla.org/show_bug.cgi?id=2086801)). Every logout and shutdown therefore
counted as a crash, after which Firefox restores its windows as they were, without the new window for the launch, and
loses the changes since it last saved its session. Firefox is patched to install the handler, and to monitor the
session through the portal and quit cleanly when it ends (`patches/firefox/sigterm-handler-after-app-shell.patch` and
`quit-at-session-end.patch`).

Signal, Slack, Claude Desktop and other applications built on Electron crashed at every logout and shutdown with
"GPU process isn't usable. Goodbye.", and Chromium itself does the same. Chromium moves its browser process into a
systemd scope of its own, so that xdg-desktop-portal can identify it, but leaves its zygotes, GPU process and other
helpers in the scope GNOME launched it in. Only GNOME's scopes are tied to the session, so at logout systemd stops
the helpers while the browser process keeps running, fails to start its GPU process again, and crashes. A drop-in
for the user service manager ties every application scope to the session, so that the application's own scope is
stopped at logout too. At logout a user service sends SIGTERM to the browser process alone, which Chromium names its
scope after, and waits for it to exit, and every application scope is ordered to stop only after that service. The
browser process then shuts down while its helpers still run, and ends them itself (`stop-application-scopes.sh`,
`systemd/user/`, installed by `configure-gnome-desktop.sh`).

At a shutdown or a reboot that ordering is not enough. logind starts the shutdown as soon as gnome-session released
its delay inhibitor, which it does right before it exits, and the helpers then sometimes died before the user's
service manager even started to stop the graphical session. So a second user service holds a delay inhibitor of its
own. When logind announces a shutdown or a reboot, the service stops the first one, which lets the browser processes
exit, and releases its inhibitor only after that, so that logind starts the shutdown once the applications exited
(`stop-application-scopes-before-shutdown.py`). logind waits for an inhibitor for at most `InhibitDelayMaxSec=`, 5
seconds by default, which unattended-upgrades raises to 30 seconds. GNOME asks logind for the shutdown only once it is
confirmed, so cancelling its confirmation dialog leaves the applications running.

GNOME Shell is not ordered relative to the application scopes either, so at logout and at shutdown systemd stopped it
while the applications were still quitting. GTK, which Chromium loads, ends a process whose Wayland connection breaks
at once, with exit status 1, and Claude Desktop was cut off in the middle of its shutdown. A drop-in orders the Shell
to stop only after the service which lets the browser processes exit, too, so that the Shell is still there while
they quit (`systemd/user/org.gnome.Shell@.service.d/`).

The cause is [Chromium issue 580525223](https://issues.chromium.org/issues/580525223), fixed for Chromium 159,
which moves all its processes into its own scope. Chromium 159 also learns about a logout from the portal through
which GNOME announces it, and exits before anything is stopped
([Chromium issue 580443832](https://issues.chromium.org/issues/580443832)). Electron does not
([Electron issue 55551](https://github.com/electron/electron/issues/55551)). Once Chromium and the Electron
applications in use are based on Chromium 159 or later, test whether the drop-ins and the services can go: stopping
all processes of an application at once, as stopping its single scope does, still crashed Signal once.

#### Applications which withdraw an inhibition leave none behind

Applications ask GNOME through the Inhibit portal to hold a logout or a suspend, and withdraw the inhibition once it is
no longer needed. The portal answered the application at once and asked GNOME for the inhibition only afterwards, so a
withdrawal which arrived in between failed, and the inhibition stayed until the application quit. Text Editor, when it
does not restore its session, holds the logout for each window with unsaved documents, and inhibits and withdraws right
away while it loads a file, so GNOME Shell's logout dialog then listed it once more as having unsaved work.
[gnome-session issue 174](https://gitlab.gnome.org/GNOME/gnome-session/-/work_items/174) reports the same symptom with
Nautilus, whose inhibitions while it moves files then keep the computer from suspending. xdg-desktop-portal is patched
to answer the application only once GNOME's side has the inhibition (`patches/xdg-desktop-portal/`, [xdg-desktop-portal
issue 854](https://github.com/flatpak/xdg-desktop-portal/issues/854)).

#### Windows return to their places

Firefox, Chromium, Text Editor and the terminal name their windows to GNOME through the Wayland session management
protocol, and GNOME remembers the workspace, monitor, position and size of each window under its name, so that the
windows return there when the application restores them. Mutter 50 offers the protocol only under its draft name,
behind a debug switch, and is patched with a backport from mutter 51 (`patches/mutter/`).

The backport offers the protocol to every application, while mutter does not implement its request to store a
window's place under a new name, so an application which sent that request would end GNOME Shell and the session
with it. Mutter is therefore also patched to implement the request
(`patches/mutter/xdg-toplevel-session-rename.patch`), reported as
[mutter issue 5177](https://gitlab.gnome.org/GNOME/mutter/-/work_items/5177).

Mutter stores the places of the windows named through the session management protocol whenever a window moves,
changes its size or state, or moves to another workspace, and writes them to disk a few seconds later. Unpatched,
mutter stores a window's place only when the window closes, so after a crash or a reset of the machine windows would
return to where they were when they last closed, or open unplaced (`patches/mutter/save-toplevels-on-change.patch`,
reported as [mutter issue 5181](https://gitlab.gnome.org/GNOME/mutter/-/work_items/5181) and proposed upstream as
[mutter merge request 5455](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5455)).

Firefox restores its windows to the workspace, monitor, position and size they had when it quit. Besides mutter,
three things stand in the way on Ubuntu 26.04, each patched until the fix ships:

- GTK 3 lacks the signal Firefox needs to name a window before it is shown (`patches/gtk+3.0/`, a backport from
  GTK's 3.24 branch).
- Firefox turns the protocol off on GNOME, because of a bug of its own which makes it crash when a session is
  restored from the History menu, and a second one which leaves windows hidden on the first start
  (`patches/firefox/`).
- Firefox treats a saved name which begins with eight decimal digits, as about one in 43 do, as a workspace number
  saved on X11 and gives that window a new name, so it opens on the current workspace
  (`patches/firefox/wayland-session-restore-uuid-ids.patch`).

When Chromium restores its last session, its windows return to the workspace, monitor, position and size they had.
Chromium speaks only the protocol's draft, which mutter 51 and the backport no longer have, so mutter is also patched
to offer the draft next to the final protocol (`patches/mutter/xx-session-management.patch`). Chromium uses it only
with its WaylandSessionManagement feature, which `configure-gnome-desktop.sh` enables for every user (`chromium.d/`),
the same as `chrome://flags/#wayland-session-management`.

When Text Editor or the terminal restores its windows at start, they return to the workspace, monitor, position and
size they had. GTK 4 can name an application's windows to GNOME through the draft of the same protocol, but GTK 4.22
hides the API an application turns that on with, and binds the protocol only behind a debug switch. GTK is patched to
bring both back (`patches/gtk4/`), and Text Editor and the terminal to use them (`patches/gnome-text-editor/`,
`patches/ptyxis/`). Mutter is also patched to remember the places of the windows an application still has open when
it quits (`patches/mutter/save-toplevels-on-session-destroy.patch`), which GTK applications do without closing their
windows first, proposed upstream as
[mutter merge request 5453](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5453). GTK keeps the names in its
own state file and reads it whenever the application starts. It does not register the application with gnome-session,
which would otherwise start the application again at the next login and then skip that login's autostart
applications. Upstream GTK hid the API again for 4.24, because the asynchronous API meant to replace it was not ready.

Signal and Slack start at login on their own workspace and in their own place on the screen. On Wayland a window
cannot tell GNOME where it should be, and Electron does not use the session management protocol through which GNOME
could remember that for it, so GNOME places their windows anew at every start. The Auto Move Windows extension moves
them to their workspace, and the Smart Auto Move extension then restores their monitor, position and size, recorded
in its settings (`gnome-extensions/smart-auto-move.dconf`). Positions are kept per monitor, by the name of its
connector, and are recorded for the laptop's own screen, where the windows also open while an external monitor is
connected.

#### Switching workspaces stays on the chosen workspace

Ubuntu's Desktop Icons extension moved to the workspace of a window which demands attention whenever the workspace
changed: it activates the first window of mutter's list for the new workspace, and that list starts with the windows
of other workspaces which demand attention. It is patched with Ubuntu's own fix, which Ubuntu has not released for
26.04 yet (`patches/gnome-shell-ubuntu-extensions/`,
[Launchpad bug 2169475](https://bugs.launchpad.net/ubuntu/+source/gnome-shell-ubuntu-extensions/+bug/2169475)).

Firefox also asked mutter to activate every window it restores at startup, without an event of the user behind the
request, so mutter marked these windows as demanding attention: GNOME Shell showed a notification for each, and listed
them first when switching windows. Firefox is patched to ask for no activation of a restored window while it restores
its session (`patches/firefox/wayland-session-restore-no-activation.patch`). The restored window which Firefox shows
first also received the activation token of the launch, which made mutter mark it as demanding attention in the
session tests, and Firefox is patched to give the token to the window it opens for the launch
(`patches/firefox/wayland-launch-activation-token.patch`). Chromium still asks to activate the windows it restores, so
mutter marks them as demanding attention ([Chromium issue 582928432](https://issues.chromium.org/issues/582928432)).

#### Documents and terminal tabs return also after a crash

Text Editor saves its unsaved documents a few seconds after every change, so that a crash or a reset of the machine
loses only the last seconds of typing. Text Editor 50 stops doing so when its session changes before it enables
saving, which the restored windows do at every start, as does an auto-save delay other than the default, and it then
saves only when it quits. It is patched to save in that case and after the delay changes, and to run its saves one at a
time, so that a save of a large document cannot replace newer saved state with older (`patches/gnome-text-editor/`).
It is also patched to save when the cursor moves, a window is resized or maximized, a tab is selected or moved, or the
language or encoding of a document changes, so that a crash restores all of them as they were a few seconds before.

When the terminal starts after a crash, SIGTERM, a reset of the machine or a logout with terminal windows open, its
windows return to their workspaces and places, each tab in the directory it had, with the last screen it showed dimmed
above the prompt of a new shell, as Terminal on macOS does. Ptyxis saves its tabs only when its last window is closed,
so it would bring back the tabs of the last time that happened
([Ptyxis issue 603](https://gitlab.gnome.org/chergert/ptyxis/-/work_items/603)). It is patched to save its session a
few seconds after every change, including the screens, which are kept in a file readable only by you
(`patches/ptyxis/`). A window you close is not brought back, the last one neither, so after you close every terminal
window the next start opens just a new one.

### Firefox runs with its whole sandbox

Firefox's build from the Mozilla Team PPA is brought closer to Mozilla's in two ways. The libraries Mozilla runs in a
WebAssembly sandbox, for fonts, spell checking, XML and audio, are sandboxed here too, where the PPA's build leaves
them out. Also, like Mozilla's package, it installs no AppArmor profile of its own, so that Firefox runs under the one
Ubuntu's apparmor package has for it. The PPA's package installs in its place an enforcing profile written for Ubuntu
14.10, under which Firefox crashes at startup
([Launchpad bug 2172775](https://bugs.launchpad.net/ubuntu/+source/firefox/+bug/2172775)).

Firefox isolates its content processes in user namespaces of their own. Ubuntu allows unprivileged user namespaces
only to programs with an AppArmor profile which grants them, and the apparmor package has one for Firefox. Ubuntu's
7.0 kernel never applies it: the parser compiles the profile's pattern for Firefox's path into a matcher with a
differentially encoded state, which the kernel's matcher for attaching profiles mishandles, so Firefox runs
unconfined, is denied the namespaces, and its content processes are isolated by seccomp alone. This happens with
Mozilla's own package too. `configure-gnome-desktop.sh` adds `Optimize=no-diff-encode` to
`/etc/apparmor/parser.conf`, so the parser does not use that encoding, and compiles the profile again. The kernel bug
is [Ubuntu bug 2172229](https://bugs.launchpad.net/bugs/2172229), fixed in mainline by commit
[e667fc72f7f4](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e667fc72f7f4a54674962c324048ca2cc58bc703).
Once the running kernel has it, the line in `parser.conf` and its call in the script can go.

### Container tabs open in the window of their page

Firefox Multi-Account Containers reopens a page assigned to a container in a new tab of that container and closes the
tab the page opened in. Its release creates the new tab in the window which had the focus last, so a link from another
application, which Firefox opens in a new window, becomes a tab of another window when that window had the focus last,
as at a start of Firefox which restores the session, and the link's own window closes ([issue
2000](https://github.com/mozilla/multi-account-containers/issues/2000)). The add-on is patched to create the new tab
in the window of the tab it replaces (`firefox-addons/multi-account-containers/`), as proposed upstream in [pull
request 2957](https://github.com/mozilla/multi-account-containers/pull/2957).

`configure-gnome-desktop.sh` builds the add-on from its release on addons.mozilla.org with the patch applied and
installs it into `/usr/lib/firefox-addons/extensions`, from which Ubuntu's Firefox loads add-ons without a signature
and never updates them, so a new release of the add-on needs a new pin in this repository. The daily run of
`rebuild-patched-packages.sh` mails when addons.mozilla.org offers a newer release, and whether the patch applies to
it. A copy of the add-on installed from addons.mozilla.org into the profile takes precedence, and the script reports
it. Deleting its file from the profile's `extensions` directory while Firefox is not running keeps the add-on's data,
such as which sites open in which container, while removing the add-on in Firefox's add-on manager deletes it.

### Windows keep their size when the screen locks

GNOME Shell disables most extensions while the screen is locked, the dock among them, and enables them again after
unlocking. The dock reserves its part of the screen only while it is enabled, so windows snapped to a side or
maximized would grow while the screen is locked and shrink back a moment after unlocking. A terminal resizes its
contents with the window, which garbles the screen of programs like Claude Code running in it. The Reserve Space
extension stays enabled on the lock screen and keeps an invisible copy of every part of the screen reserved by the
dock, the top bar or another panel, so the space left for windows does not change. The copies follow the reserved
space a few seconds after it changes, for example when the dock is moved to another side of the screen. The extension
does so only from the next login after it is enabled. At login, GNOME Shell enables the extensions which stay enabled
on the lock screen before the others, so the extension comes before the dock. One enabled later comes after the dock,
and when the screen locks, GNOME Shell disables it together with the dock and enables it again without the dock, so it
then finds no reserved space to copy.

### Claude Desktop and Slack show their tray icon after every login

Claude Desktop and Slack often started at login without their icon in the top bar, while they kept running. The icon
is shown through the StatusNotifierItem protocol, for which the Ubuntu AppIndicators extension owns the name
`org.kde.StatusNotifierWatcher` on the session bus. Chromium, on which both are built, checks whether that name has an
owner only when the application creates its tray icon, and without one uses a GTK status icon, which is not shown
under Wayland, and does not check again. GNOME Shell enables the AppIndicators extension only after every extension in
the user's own directory, one after another, while gnome-session starts the applications at login as soon as the Shell
reports it is ready, which it does before it has enabled its extensions. So an application which created its tray
icon a fraction of a second too early had no icon until it was restarted, or until its tray icon was turned off and on
in its settings, which creates the icon again. Their entries in `~/.config/autostart` start them only once the name
has an owner (`wait-for-status-notifier-watcher.sh`, `autostart/`, installed by `configure-gnome-desktop.sh`). An entry
is installed only in place of one the application wrote itself, when its setting to start at login is on, and the
application writes its own entry again when that setting is turned off and on, until the script runs again.

The cause is reported to Chromium as [issue 580998950](https://issues.chromium.org/issues/580998950), which Chromium
160 fixes by waiting for the name to have an owner, as libayatana-appindicator does. Electron implements the
application's side of the tray icon itself, so the entries and the script can go once Claude Desktop and Slack are
built on an Electron release with that fix which also switches its tray icon over when the name appears, or once
GNOME Shell enables its extensions before it reports that it is ready. Because the Shell enables extensions only after
it started up, they also cannot change its startup animation any more
([GNOME Shell issue 8917](https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8917)). Claude Desktop is asked to wait
for the name itself in [claude-code issue 106844](https://github.com/anthropics/claude-code/issues/106844), and its
entry can go once it does.

### Terminal fixes

Ptyxis, Ubuntu's terminal, is patched for a few bugs (`patches/ptyxis/`):

- The visual bell shows even with animations disabled.
- The dialog shown before logging out or shutting down lists the terminal while a program runs in it
  ([Ptyxis issue 573](https://gitlab.gnome.org/chergert/ptyxis/-/work_items/573)).
- A new tab or window opens in the directory of the current tab also after a terminal reset, which keeps the
  directory the shell reported (`patches/vte2.91/`), and when the shell reports none, in the directory of the
  program running in the tab.

### Text Editor reads standard input without errors

Text Editor opens the text it reads from standard input (`gnome-text-editor -`) as an unsaved document, which
GtkSourceView loads from a stream. GtkSourceView 5.18 logs two GLib criticals for every load from a stream, from a
profiler mark naming the file loaded, which Ubuntu's build with Sysprof support evaluates also when no profiler runs.
GtkSourceView is patched with the upstream fix from 5.21.0 and a test for it (`patches/gtksourceview5/`), and the
patches can be dropped once Ubuntu ships that version.

### Magnet links open in a running Transmission

Opening a magnet link or a torrent file while Transmission already runs starts a second Transmission, which passes
the link over the session bus to the one already running and exits. Ubuntu confines Transmission with an AppArmor
profile which allows it to own its name on the session bus, but not these calls between two of its instances, so
without rules added to the profile (`apparmor.d/local/transmission-gtk`) the link is lost and nothing happens. The
missing rules are reported in [Ubuntu bug 2169433](https://bugs.launchpad.net/ubuntu/+source/transmission/+bug/2169433).

### The document portal's filesystem is mounted and unmounted

The document portal, through which sandboxed applications open the files they are given, mounts a FUSE filesystem
at `/run/user/<uid>/doc` with the setuid helper fusermount3, and keeps a fusermount3 running to unmount it when the
portal exits. Ubuntu confines fusermount3 with an AppArmor profile which does not allow libfuse 3.17 and later to
check that the filesystem is still mounted before unmounting it, so the filesystem stayed mounted after the
portal exited, together with helpers which the user's service manager cannot end. The profile also denies two
capabilities, without which the helper can hang at the start of a session without mounting the filesystem at all.
Rules added to the profile allow both (`apparmor.d/local/fusermount3`). They are reported in
[Ubuntu bug 2165030](https://bugs.launchpad.net/ubuntu/+source/apparmor/+bug/2165030) and in
[AppArmor issue 652](https://gitlab.com/apparmor/apparmor/-/issues/652).

### File indexing does not crash on vanished downloads

GNOME's file indexer, localsearch, extracts metadata from new files in the background. Its extractor crashed on a
temporary file of a download which was deleted before the extractor could read it: the file was handled as an
extraction without metadata, recording it failed, and preparing the error report freed memory it did not own.
Ubuntu's localsearch and tinysparql are patched to handle such a file as a failed extraction and to report the
error without crashing (`patches/localsearch/`, `patches/tinysparql/`). The fixes are proposed upstream in
[localsearch merge request 707](https://gitlab.gnome.org/GNOME/localsearch/-/merge_requests/707) and
[tinysparql merge request 819](https://gitlab.gnome.org/GNOME/tinysparql/-/merge_requests/819), and the patches can be
dropped once Ubuntu ships versions which include them.

### A command's crash is not reported as a crash of timeout

When a command which timeout runs is killed by a signal, timeout kills itself with the same signal, so that its exit
status shows the signal. Ubuntu's timeout, from the Rust coreutils, dumped core when the signal was one like SIGSEGV or
SIGABRT, and apport reported a crash of timeout besides the crash of the command. GNU timeout turns off its own core
dumps first. The Rust coreutils are patched with the upstream fix (`patches/rust-coreutils/`), from
[uutils pull request 15157](https://github.com/uutils/coreutils/pull/15157), which is not in a release yet, and the
patch can be dropped once Ubuntu ships a release which includes it.

### Only the working internal microphone is offered

The audio coprocessor of the APU exposes a digital microphone which has no microphones wired to it on this laptop,
and which the sound server otherwise offers as a second internal microphone beside the working one. Its card is kept
unregistered (`modprobe.d/snd-acp-legacy-mach.conf`). Without that card the Realtek codec is no longer configured
through ALSA UCM, so Sound settings offer one configuration whose ports follow the jacks in place of four
combinations of speakers, headphones and microphones which differ in which of them they leave out.

### snapd's desktop helper starts with the desktop

snapd generates the user service of snapd-desktop-integration, which installs theme snaps and shows notifications
about snap updates, to start with the user's service manager instead of with the graphical session. It started before
there was a display, failed with "Failed to open display" until its restarts reached the session, and failed again at
every logout when the display went away. A drop-in and a link in `graphical-session.target.wants` start it with the
session instead, skip its start without a display, and stop it with the session while the display is still there
(`systemd/user/snap.snapd-desktop-integration.snapd-desktop-integration.service.d/`, installed by
`configure-gnome-desktop.sh`). The snap's launcher also exits with status 2 whenever it wants to be started again,
including when the session ends and when systemd stops it, so the drop-in counts that status as success and still
restarts it after it. snapd is changing its user services this way in
[snapd pull request 16687](https://github.com/canonical/snapd/pull/16687), which needs pull requests 16685 and 16686.
Once a snapd with it is installed, the generated unit has `Requisite=` and `PartOf=graphical-session.target`, and the
drop-in's `[Unit]` section, the link and their lines in `configure-gnome-desktop.sh` can go. The pull request does not
change the launcher's exit status, so the `[Service]` section stays until snapd-desktop-integration does, as asked in
[snapd-desktop-integration issue 174](https://github.com/canonical/snapd-desktop-integration/issues/174).

### Media players stay connected to Bluetooth devices after a logout

bluez's mpris-proxy registers the media players of the session with BlueZ, so that a Bluetooth headset or car kit
can show what is playing. When a GNOME session ends, GNOME stops the user's D-Bus, which starts again once something
connects to it, and mpris-proxy failed with exit status 1, because libdbus ends a program whose bus connection
closes. Nothing started it again while the user's service manager kept running, as it does when one logs in again
within ten seconds, and the login screen's session made it fail at every login too. A drop-in ties mpris-proxy to
the user's D-Bus, so that it is stopped before the bus, and a link in `dbus.service.wants` starts it again together
with the bus (`systemd/user/mpris-proxy.service.d/`, installed by `configure-gnome-desktop.sh`). The same change to
bluez's own unit is proposed in
[a patch to the linux-bluetooth list](https://lore.kernel.org/linux-bluetooth/20261103151724.598627-1-mitar.git@tnode.com/T/),
and the drop-in, the link and their lines in `configure-gnome-desktop.sh` can go once Ubuntu ships a bluez with it.

### The accessibility bus does not fail when a session ends

When a session ended, systemd sent SIGTERM at the same time to at-spi-bus-launcher and to the accessibility bus it
started. When the launcher noticed its bus exiting before it handled its own SIGTERM, it logged "Failed to launch bus:
Bus exited with code 0" and exited with status 1, which left `at-spi-dbus-bus.service` failed. The launcher ends its
bus itself when it receives SIGTERM, so a drop-in has systemd send SIGTERM to the launcher alone
(`systemd/user/at-spi-dbus-bus.service.d/`, installed by `configure-gnome-desktop.sh`). The same setting is proposed
for at-spi2-core's own unit in
[at-spi2-core merge request 239](https://gitlab.gnome.org/GNOME/at-spi2-core/-/merge_requests/239), and the drop-in
can go once Ubuntu ships an at-spi2-core which includes it.

### GDM does not fail at shutdown

GDM lists the users for the login screen through accountsservice, but its unit is not ordered relative to
accounts-daemon, so at shutdown systemd stopped both at once. When accounts-daemon was gone first, GDM logged "Failed
to list cached users" and exited with status 1, which left `gdm.service` failed at almost every shutdown. A drop-in
orders GDM after accounts-daemon, so that it is stopped first (`systemd/gdm.service.d/`, installed by
`configure-gnome-desktop.sh`). The same ordering is proposed for GDM's own unit in
[GDM merge request 418](https://gitlab.gnome.org/GNOME/gdm/-/merge_requests/418), and the drop-in can go once Ubuntu
ships a GDM which includes it.

### The encrypted disk is not closed while in use at shutdown

The installer writes the crypttab entry of the encrypted device holding the root filesystem without the option
`x-initrd.attach`, so at every shutdown systemd tried to close the device while the root filesystem on it was still
mounted, and `systemd-cryptsetup` failed with "Device or resource busy". The device is closed anyway in the final
phase of the shutdown, after the root filesystem is unmounted, and with the option systemd leaves it to that phase,
as systemd's crypttab(5) recommends for this device. `configure-gnome-desktop.sh` adds the option to the entry of
each encrypted device below `/`, keeps the previous file as `/etc/crypttab.bak`, and rebuilds the initramfs, which
keeps a copy of crypttab. The problem is reported as
[Launchpad bug 2152224](https://bugs.launchpad.net/ubuntu/+source/systemd/+bug/2152224). Fedora fixed it in its
installer with [anaconda pull request 6785](https://github.com/rhinstaller/anaconda/pull/6785).

## Requirements

- Ubuntu 26.04 desktop, with GNOME 50 on Wayland. The hardware parts (battery thresholds, touchscreen, power
  button light, and the BIOS settings below) assume a Framework Laptop 13 Pro.
- A few packages, installed before running the scripts:

  ```sh
  sudo apt install git devscripts sbuild mmdebstrap uidmap zstd
  ```

  Everything else the scripts use comes with Ubuntu's desktop installation, and the scripts install the packages the
  configuration itself needs, such as GNOME Shell extensions.

- Optionally a mail transport, such as `nullmailer`, which relays through your mail provider and queues mail
  while offline, with `MAILTO` set in `/etc/anacrontab`, so that the daily rebuild, the daily download of packages
  without an APT repository and the daily digest of failures and errors can mail their reports. Without one, their
  output is logged to syslog only.

## Applying everything

Run each script first without `--apply` to see what it would change. The general order is:

1. In the BIOS, set the battery charge limit to 99%[^charge-limit] and disable Battery Extender.
2. Configure and lock down the third-party APT repositories, including the Mozilla Team PPA with its source, from
   which Firefox is rebuilt:

   ```sh
   sudo ./lockdown-apt-sources.sh --apply
   ```

3. Build and install patched packages, then log out and back in. Between the previous step and the end of the build,
   do not run `apt upgrade`, which would install the PPA's unpatched Firefox until the rebuild replaces it. The first
   build takes about an hour, most of it Firefox:

   ```sh
   ./install-rebuild-patched-packages.sh --apply
   sudo rebuild-patched-packages --build
   sudo apt upgrade
   ```

4. Download the packages which have no APT repository into the local repository. The installed ones are then upgraded
   by the next `apt upgrade`, and the others can be installed with `apt install`:

   ```sh
   ./install-fetch-vendor-debs.sh --apply
   sudo fetch-vendor-debs --fetch
   ```

5. Configure the desktop, the keyboard, and the terminal, in this order:

   ```sh
   ./configure-gnome-desktop.sh --apply
   ./configure-gnome-keys.sh --apply
   ./configure-ptyxis.sh --apply
   ```

6. Install the daily measurement of cooling and performance, and the daily mail of failures and errors:

   ```sh
   ./install-health-benchmark.sh --apply
   ./install-journal-digest.sh --apply
   ```

`./all.sh` runs steps 2 to 6 in this order, showing what each script would change, and `./all.sh --apply`
applies them all, leaving logging out and back in for the end. Run it as your own user, without sudo: it calls
sudo itself for the steps which need root, and asks for the password then.

The scripts shown without sudo run as your own user and call sudo themselves for the parts which need root.
`all.sh` and the configure scripts also refuse to run as root, since as root they have no session bus and
cannot reach your settings. The ones shown with sudo write only system files and refuse to run without it,
although their dry run works as your own user.
Each script's header documents what it does and why in more detail.

## GitHub mirror

There is also a [read-only GitHub mirror available](https://github.com/ubuntu-config/ubuntu-config),
if you need to fork the project there.

## License

This project is open source software released under the [Apache 2.0 license](./LICENSE).

[^charge-limit]:
    At 100% the firmware's own charge limit is switched off, and while it is off the firmware clears the battery
    charge sustainer every second, which also removes the thresholds set from Linux. Below 100% it sets its own
    range, from 5% below the limit up to the limit, only when the limit changes or the embedded controller starts,
    so the thresholds set from Linux stay in effect. See `modprobe.d/cros-charge-control.conf`.
