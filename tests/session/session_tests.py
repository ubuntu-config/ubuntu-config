#!/usr/bin/env python3
"""Runs one test in a GNOME session of the user running it, in the container of run-session-tests.sh. See README.

Usage: session_tests.py TEST OUT_DIR

OUT_DIR receives the files the test writes, and result.json with its checks. The exit status is 0 when every check
passed.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

# Python runs with -I, which leaves this directory out of the search path.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from session import REPO_DIR, TEST_EXTENSION, Checks, Session, cgroup_of, processes, unit_of, wait_for  # noqa: E402

from gi.repository import Gio, GLib  # noqa: E402

TESTS = {}


def test(function):
    TESTS[function.__name__.replace("_", "-")] = function
    return function


def write_desktop_file(directory, app_id, name, command):
    """Writes a desktop file, whose command line is a shell's, with % escaped as the Exec key needs it."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{app_id}.desktop").write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={name}\n"
        f"Exec=sh -c '{command.replace('%', '%%')}'\n"
    )


def forking_command(tag):
    """Returns a command which starts two processes the moment it runs, as Chromium starts its zygotes, and then
    becomes a third, each a sleep whose argument is tag followed by its number, so that the test finds them."""
    return f"sleep {tag}1 & sleep {tag}2 & exec sleep {tag}3"


@test
def spawn_scopes(session, checks, out_dir):
    """Every way the session starts an application puts it into a scope of its own before it runs, so that the
    processes it starts at once are in that scope too, and logging out ends them. The application started at login
    by gnome-session, one started from the overview or the dash, and a command run with Alt+F2."""
    home = pathlib.Path.home()
    ways = {
        # tag: (how it is started, the application ID which names the scope)
        "6001": ("at login", "scope\\x2dautostart"),
        "6002": ("from the dash", "scope\\x2dtest"),
        "6003": ("with Alt+F2", "sh"),
    }
    write_desktop_file(home / ".config/autostart", "scope-autostart", "Scope autostart", forking_command("6001"))
    write_desktop_file(home / ".local/share/applications", "scope-test", "Scope test", forking_command("6002"))

    session.login()
    session.call("activateApp", "scope-test.desktop")
    session.call("spawnCommandLine", f"sh -c '{forking_command('6003')}'")

    shell_unit = "org.gnome.Shell@ubuntu.service"
    found = {}
    for tag, (how, name) in ways.items():
        pids = wait_for(lambda: (lambda p: p if len(p) == 3 else None)(processes(rf"^sleep {tag}[123]$")), 20) or []
        units = {pid: unit_of(cgroup_of(pid)) for pid in pids}
        found[tag] = units
        scope = re.compile(rf"^app-gnome-{re.escape(name)}-[0-9]+\.scope$")
        checks.check(f"started {how}", len(pids) == 3, f"{len(pids)} of 3 processes")
        if pids:
            same = len(set(units.values())) == 1
            checks.check(f"every process started {how} in its scope", same and all(scope.match(u or "") for u in units.values()),
                         str(units))
            checks.check(f"no process started {how} in GNOME Shell's unit", shell_unit not in units.values(), str(units))

    session.logout()
    left = processes(r"^sleep 600[123][123]$")
    checks.check("logging out ended every application", not left, f"left: {left}")
    return {"units": found}


TEXT_EDITOR = "org.gnome.TextEditor.desktop"
DRAFT_TEXT = "unsaved draft text"
LATE_TEXT = "typed right before logging out"


def find(windows, predicate):
    return next((w for w in windows if predicate(w)), None)


def shown_window(session, app, predicate, timeout=20):
    """Waits until the application has a window matching predicate which is shown, has a size and, as a new window
    should, the focus, and returns it, or the matching window as it is after timeout, or None."""
    shown = wait_for(lambda: find(session.windows(app), lambda w: predicate(w) and w["width"] > 0 and w["focused"]), timeout)
    return shown or find(session.windows(app), predicate)


def window_summary(window):
    return {k: window[k] for k in ("title", "workspace", "focused", "x", "y", "width", "height")} if window else None


@test
def text_editor(session, checks, out_dir):
    """Text Editor returns its windows to their workspaces after logging out and in again, with the text typed into a
    document never saved, also right before logging out, and without activating them, while every launch, from the
    dock or of a file opened from a terminal, opens a new window on the current workspace and focuses it. Its unsaved
    documents do not hold the logout."""
    home = pathlib.Path.home()
    document = home / "one.txt"
    document.write_text("first line\n")
    drafts = home / ".local/share/org.gnome.TextEditor/drafts"
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{TEXT_EDITOR}']")

    session.login()
    workspaces = session.call("workspaces")
    checks.check("the session has the 12 workspaces configured", workspaces["count"] == 12, str(workspaces))

    # Started from the dock on workspace 2, it opens a new document, into which text is typed and never saved.
    session.call("activateWorkspace", 1)
    session.call("clickDockIcon", TEXT_EDITOR)
    draft = shown_window(session, TEXT_EDITOR, lambda w: True)
    checks.check("started from the dock on the current workspace, focused",
                 draft and draft["workspace"] == 1 and draft["focused"], str(window_summary(draft)))
    if not draft:
        return {}
    # The document accepts text once it shows, a moment after the window gained the focus.
    time.sleep(1)
    session.type_text(DRAFT_TEXT)
    saved = wait_for(lambda: drafts.is_dir() and any(DRAFT_TEXT in p.read_text(errors="replace") for p in drafts.iterdir()), 20)
    checks.check("the typed text autosaved as a draft", saved,
                 str([p.read_text(errors="replace")[:80] for p in drafts.iterdir()]) if drafts.is_dir() else "no drafts")

    # A file opened from a terminal on workspace 5 opens in a new window there.
    session.call("activateWorkspace", 4)
    session.run_in_session("gio", "open", str(document))
    opened = shown_window(session, TEXT_EDITOR, lambda w: "one.txt" in (w["title"] or ""))
    checks.check("a file opened from a terminal opens in a new window on the current workspace, focused",
                 opened and opened["workspace"] == 4 and opened["focused"], str(window_summary(opened)))

    # Clicked in the dock on workspace 8, where it has no window, it opens a new window there.
    session.call("activateWorkspace", 7)
    known = {w["id"] for w in session.windows(TEXT_EDITOR)}
    session.call("clickDockIcon", TEXT_EDITOR)
    third = shown_window(session, TEXT_EDITOR, lambda w: w["id"] not in known)
    checks.check("clicked in the dock on a workspace without its window, it opens a new one there, focused",
                 third and third["workspace"] == 7 and third["focused"], str(window_summary(third)))
    after_launches = session.windows(TEXT_EDITOR)
    checks.check("launches left the earlier windows on their workspaces",
                 find(after_launches, lambda w: w["id"] == draft["id"] and w["workspace"] == 1)
                 and find(after_launches, lambda w: opened and w["id"] == opened["id"] and w["workspace"] == 4),
                 str([window_summary(w) for w in after_launches]))

    # The session is saved a few seconds after the last change, as auto-save-delay says.
    time.sleep(6)
    # Text typed less than auto-save-delay before logging out is saved only when Text Editor quits at the end of the
    # session.
    if third:
        session.type_text(LATE_TEXT)
        time.sleep(0.5)
    first = session.windows(TEXT_EDITOR)
    held = [i for i in session.inhibitors() if i["app"].startswith("org.gnome.TextEditor")]
    checks.check("Text Editor holds no logout for its unsaved documents", not held, str(held))
    dialogs = session.logout()
    listed = [d["applications"] for shown in dialogs for d in shown["dialogs"] if d["type"] == "EndSessionDialog"]
    checks.check("logging out shows no dialog listing Text Editor", not listed, str(dialogs))

    session.login()
    session.call("activateWorkspace", 10)
    session.call("clickDockIcon", TEXT_EDITOR)
    shown_window(session, TEXT_EDITOR, lambda w: w["workspace"] == 10)
    time.sleep(2)
    second = session.windows(TEXT_EDITOR)
    restored_draft = find(second, lambda w: w["workspace"] == 1)
    restored_file = find(second, lambda w: "one.txt" in (w["title"] or ""))
    new = find(second, lambda w: w["workspace"] == 10)
    checks.check("the document with the draft returns to its workspace, not focused",
                 restored_draft and not restored_draft["focused"], str(window_summary(restored_draft)))
    checks.check("the file returns to its workspace, not focused",
                 restored_file and restored_file["workspace"] == 4 and not restored_file["focused"], str(window_summary(restored_file)))
    checks.check("the launch after logging in opens a new window on the current workspace, focused",
                 new and new["focused"], str(window_summary(new)))
    checks.check("restoring switched no workspace", session.call("workspaces")["active"] == 10, str(session.call("workspaces")))
    # Restoring a session can ask mutter to activate a window without an event of the user behind the request,
    # which makes mutter mark the window as demanding attention.
    attention = [window_summary(w) for w in session.windows(TEXT_EDITOR) if w["demandsAttention"]]
    checks.check("no restored window demands attention", not attention, str(attention))

    # The draft has the text typed before logging out.
    if restored_draft:
        session.call("activateWindow", restored_draft["id"])
        wait_for(lambda: find(session.windows(TEXT_EDITOR), lambda w: w["id"] == restored_draft["id"] and w["focused"]), 10)
        session.press("a", "Control_L")
        session.press("c", "Control_L")
        text = wait_for(lambda: session.call("clipboardText"), 10)
        checks.check("the draft has the text typed before logging out", text and DRAFT_TEXT in text, repr(text))
    restored_late = find(second, lambda w: w["workspace"] == 7)
    checks.check("the document typed into right before logging out returns to its workspace",
                 restored_late, str([window_summary(w) for w in second]))
    if restored_late:
        session.call("activateWindow", restored_late["id"])
        wait_for(lambda: find(session.windows(TEXT_EDITOR), lambda w: w["id"] == restored_late["id"] and w["focused"]), 10)
        session.press("a", "Control_L")
        session.press("c", "Control_L")
        # The clipboard still has the text copied from the other draft until the copy here replaces it.
        copied = wait_for(lambda: LATE_TEXT in (session.call("clipboardText") or ""), 10)
        checks.check("it has the text typed right before logging out", copied, repr(session.call("clipboardText")))
    session.logout()
    return {"before": first, "after": second, "dialogs": dialogs}


@test
def workspace_attention(session, checks, out_dir):
    """A window which demands attention on another workspace does not move the user to it: when a window demands
    attention and after a workspace switch, Desktop Icons NG activates the topmost window of the active workspace,
    and mutter lists the windows of other workspaces which demand attention first."""
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{TEXT_EDITOR}']")
    session.login()

    # A window on workspace 2, and another one on workspace 5, where it is the topmost window.
    session.call("activateWorkspace", 1)
    session.call("clickDockIcon", TEXT_EDITOR)
    first = shown_window(session, TEXT_EDITOR, lambda w: True)
    session.call("activateWorkspace", 4)
    # The dock lists the windows of the active workspace a moment after a switch, and a click before that activates
    # the window of the previous workspace.
    time.sleep(1)
    session.call("clickDockIcon", TEXT_EDITOR)
    second = shown_window(session, TEXT_EDITOR, lambda w: not first or w["id"] != first["id"])
    checks.check("Text Editor has a window on workspace 2 and one on workspace 5",
                 first and second and first["workspace"] == 1 and second["workspace"] == 4,
                 str([window_summary(first), window_summary(second)]))
    if not first or not second:
        return {}

    session.call("activateWorkspace", 2)
    time.sleep(1)
    session.call("setDemandsAttention", first["id"])
    time.sleep(1)
    workspaces = session.call("workspaces")
    marked = find(session.windows(TEXT_EDITOR), lambda w: w["id"] == first["id"])
    checks.check("a window on another workspace demanding attention leaves the workspace as it is",
                 workspaces["active"] == 2 and marked and marked["demandsAttention"],
                 f"{workspaces} {window_summary(marked)} demands attention {marked and marked['demandsAttention']}")

    for target, what in ((3, "a workspace without windows"), (4, "a workspace with a window")):
        session.call("activateWorkspace", target)
        time.sleep(1)
        workspaces = session.call("workspaces")
        checks.check(f"switching to {what} stays there", workspaces["active"] == target, str(workspaces))
    focused = find(session.windows(TEXT_EDITOR), lambda w: w["focused"])
    checks.check("the topmost window of the workspace has the focus", focused and focused["id"] == second["id"],
                 str(window_summary(focused)))
    session.logout()
    return {}


PTYXIS = "org.gnome.Ptyxis.desktop"


def saved_screens(home):
    """Returns the text of each screen which Ptyxis saved with its session, or none before it saved any."""
    try:
        data = (home / ".local" / "state" / "org.gnome.Ptyxis" / "screens.gvariant").read_bytes()
    except FileNotFoundError:
        return []
    return list(GLib.Variant.new_from_bytes(GLib.VariantType("a{ss}"), GLib.Bytes.new(data), False).unpack().values())


def continued(earlier, later):
    """Whether each of the earlier screens continues in one of the later ones, followed by the output of a new shell,
    as a restore shows it."""
    return bool(earlier) and all(any(screen.startswith(old + "\n") for screen in later) for old in earlier)


def copy_terminal_text(session, window):
    """Activates a Ptyxis window and returns the text of its terminal, as selecting all and copying gives it."""
    session.call("activateWindow", window["id"])
    wait_for(lambda: find(session.windows(PTYXIS), lambda w: w["id"] == window["id"] and w["focused"]), 10)
    time.sleep(0.5)
    session.press("a", "Control_L", "Shift_L")
    session.press("c", "Control_L", "Shift_L")
    time.sleep(0.5)
    return session.call("clipboardText") or ""


@test
def ptyxis(session, checks, out_dir):
    """Ptyxis returns its windows to their workspaces, positions and sizes after logging out and in again, each with
    the screen it showed and a new shell in the directory the old one was in, without activating them, while every
    launch from the dock opens a new window on the current workspace and focuses it. The screens survive logging out
    and in once more without using the windows. Logging out while a program runs in it lists Ptyxis in GNOME's
    dialog."""
    # The shells run with Ubuntu's .bashrc, which the user's home received from /etc/skel.
    home = pathlib.Path.home()
    (home / "one").mkdir()
    (home / "two").mkdir()
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{PTYXIS}']")

    session.login()
    session.call("activateWorkspace", 1)
    session.call("clickDockIcon", PTYXIS)
    first = shown_window(session, PTYXIS, lambda w: True)
    checks.check("started from the dock on the current workspace, focused",
                 first and first["workspace"] == 1 and first["focused"], str(window_summary(first)))
    if not first:
        return {}
    time.sleep(1)
    session.type_text("cd one\necho first screen\n")
    # GNOME Shell can deliver the typed keys after type_text() returns, and switching the workspace moves the keyboard
    # focus away from the window, so the workspace is switched only once Ptyxis saved the screen with the command's
    # output.
    checks.check("the first window ran the typed command",
                 wait_for(lambda: any("\nfirst screen" in screen for screen in saved_screens(home)), 15))

    session.call("activateWorkspace", 4)
    session.call("clickDockIcon", PTYXIS)
    second = shown_window(session, PTYXIS, lambda w: w["id"] != first["id"])
    checks.check("clicked in the dock on a workspace without its window, it opens a new one there, focused",
                 second and second["workspace"] == 4 and second["focused"], str(window_summary(second)))
    if not second:
        return {}
    time.sleep(1)
    session.type_text("cd two\necho second screen\n")
    geometry = (100, 120, 1000, 600)
    session.call("moveResizeWindow", second["id"], *geometry)

    # Ptyxis saves its session a few seconds after a change, and a program running in a terminal holds the logout.
    time.sleep(5)
    session.type_text("sleep 600\n")
    time.sleep(1)
    before = session.windows(PTYXIS)
    dialogs = session.logout()
    listed = [d["applications"] for shown in dialogs for d in shown["dialogs"] if d["type"] == "EndSessionDialog"]
    checks.check("logging out while a program runs lists Ptyxis by name", listed == [["Terminal"]], str(dialogs))
    ended = {"first": saved_screens(home)}

    session.login()
    session.call("activateWorkspace", 10)
    session.call("clickDockIcon", PTYXIS)
    new = shown_window(session, PTYXIS, lambda w: w["workspace"] == 10, 30)
    time.sleep(2)
    after = session.windows(PTYXIS)
    restored_first = find(after, lambda w: w["workspace"] == 1)
    restored_second = find(after, lambda w: w["workspace"] == 4)
    checks.check("the first window returns to its workspace, not focused",
                 restored_first and not restored_first["focused"], str(window_summary(restored_first)))
    checks.check("the second window returns to its workspace, not focused",
                 restored_second and not restored_second["focused"], str(window_summary(restored_second)))
    if restored_second:
        placed = (restored_second["x"], restored_second["y"], restored_second["width"], restored_second["height"])
        checks.check("the second window returns to its position and size", placed == geometry, f"{placed}, was {geometry}")
    checks.check("the launch after logging in opens a new window on the current workspace, focused",
                 new and new["workspace"] == 10 and new["focused"], str(window_summary(new)))
    checks.check("restoring switched no workspace", session.call("workspaces")["active"] == 10, str(session.call("workspaces")))
    # Restoring a session can ask mutter to activate a window without an event of the user behind the request,
    # which makes mutter mark the window as demanding attention.
    attention = [window_summary(w) for w in session.windows(PTYXIS) if w["demandsAttention"]]
    checks.check("no restored window demands attention", not attention, str(attention))

    # The restored windows are left alone, and the session saves each of them again with its whole screen, followed by
    # the prompt of its new shell.
    checks.check("without using the restored windows, the session saves their whole screens again",
                 wait_for(lambda: continued(ended["first"], saved_screens(home)), 15),
                 repr({"before": ended["first"], "now": saved_screens(home)}))

    # Logging out and in again without using any window brings back each window of the session before, also the one
    # opened by the launch, with its whole screen, so that the screens survive any number of logins.
    session.logout()
    ended["second"] = saved_screens(home)
    session.login()
    session.call("activateWorkspace", 7)
    session.call("clickDockIcon", PTYXIS)
    again = shown_window(session, PTYXIS, lambda w: w["workspace"] == 7, 30)
    checks.check("the launch after logging in once more opens a new window on the current workspace, focused",
                 again and again["focused"], str(window_summary(again)))
    returned = wait_for(lambda: (lambda ws: ws if len(ws) == len(after) + 1 else None)(session.windows(PTYXIS)), 15)
    checks.check("logging out and in once more brings back every window",
                 returned and sorted(w["workspace"] for w in returned) == sorted([7] + [w["workspace"] for w in after]),
                 str([window_summary(w) for w in session.windows(PTYXIS)]))
    checks.check("logging out and in once more without using the windows keeps their whole screens",
                 wait_for(lambda: continued(ended["second"], saved_screens(home)), 15),
                 repr({"before": ended["second"], "now": saved_screens(home)}))
    restored_first = find(session.windows(PTYXIS), lambda w: w["workspace"] == 1)
    restored_second = find(session.windows(PTYXIS), lambda w: w["workspace"] == 4)

    texts = {}
    for name, window, directory in (("first", restored_first, "one"), ("second", restored_second, "two")):
        if not window:
            continue
        session.call("activateWindow", window["id"])
        time.sleep(1)
        session.type_text("pwd\n")
        text = copy_terminal_text(session, window)
        texts[name] = text
        checks.check(f"the {name} window shows its screen from before logging out", f"{name} screen" in text, repr(text[-300:]))
        checks.check(f"the {name} window's new shell is in the directory of the old one", f"{home}/{directory}\n" in text,
                     repr(text[-300:]))
    session.logout()
    return {"before": before, "after": after, "dialogs": dialogs, "screens": ended, "texts": texts}


# For each Ptyxis window, its workspace, whether a workspace thumbnail of the overview shows it, and the size of its actor,
# which the thumbnail clones. WorkspaceThumbnail keeps its workspace in metaWorkspace and its clones in _windows.
OVERVIEW_THUMBNAILS = """(() => {
  const thumbnails = [];
  const collect = actor => {
    if (actor.constructor.name === 'WorkspaceThumbnail')
      thumbnails.push(actor);
    actor.get_children().forEach(collect);
  };
  collect(Main.layoutManager.overviewGroup);
  return global.get_window_actors().filter(actor => actor.meta_window.get_wm_class() === 'org.gnome.Ptyxis').map(actor => {
    const window = actor.meta_window;
    const workspace = window.get_workspace()?.index() ?? null;
    return {
      id: window.get_id(),
      workspace,
      inThumbnail: thumbnails.some(t => t.metaWorkspace.index() === workspace && t._windows.some(c => c.metaWindow === window)),
      width: actor.width,
      height: actor.height,
    };
  });
})()"""


@test
def overview_thumbnails(session, checks, out_dir):
    """The overview's workspace thumbnails show the windows restored to workspaces not visited since logging in, which
    needs patches/mutter/hidden-window-updates.patch. Mutter otherwise keeps the actor of such a window at 0x0 until
    its workspace is activated."""
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{PTYXIS}']")
    session.login()
    created = []
    for workspace in (1, 4):
        session.call("activateWorkspace", workspace)
        # The dock lists the windows of the active workspace a moment after a switch, and a click before that activates
        # the window of the previous workspace.
        time.sleep(1)
        session.call("clickDockIcon", PTYXIS)
        created.append(shown_window(session, PTYXIS, lambda w, workspace=workspace: w["workspace"] == workspace))
    checks.check("Ptyxis has a window on workspace 2 and one on workspace 5",
                 all(created) and [w["workspace"] for w in created] == [1, 4], str([window_summary(w) for w in created]))
    if not all(created):
        return {}
    # Ptyxis saves its session a few seconds after a change.
    time.sleep(5)
    session.logout()

    session.login()
    session.call("activateWorkspace", 0)
    session.call("clickDockIcon", PTYXIS)
    restored = wait_for(lambda: (lambda ws: ws if {w["workspace"] for w in ws} >= {1, 4} else None)(session.windows(PTYXIS)), 30)
    checks.check("Ptyxis restores its windows to workspaces 2 and 5", restored,
                 str([window_summary(w) for w in session.windows(PTYXIS)]))
    # The restored windows draw their first content right after they are restored.
    time.sleep(3)
    session.eval("Main.overview.show(); true")
    wait_for(lambda: session.eval("Main.overview.visible && !Main.overview.animationInProgress"), 10)
    shown = session.eval(OVERVIEW_THUMBNAILS)
    session.eval("Main.overview.hide(); true")
    for workspace in (1, 4):
        window = find(shown, lambda w, workspace=workspace: w["workspace"] == workspace)
        checks.check(f"the window restored to workspace {workspace + 1}, not visited yet, shows in its thumbnail with its size",
                     window and window["inThumbnail"] and window["width"] > 0 and window["height"] > 0, str(window))
    session.logout()
    return {"overview": shown}


MONITORS = """[...Array(global.display.get_n_monitors()).keys()].map(i => {
  const rect = global.display.get_monitor_geometry(i);
  return [rect.x, rect.y, rect.width, rect.height];
})"""

# GNOME Shell of the test session with a second virtual monitor, right of the first one.
TWO_MONITORS = """[Service]
ExecStart=
ExecStart=/usr/bin/gnome-shell --headless --virtual-monitor 1920x1080 --virtual-monitor 1920x1080 --mode=%i
"""


SHOWN_WINDOWS = """global.get_window_actors().filter(actor => actor.meta_window.get_wm_class() === 'org.gnome.Ptyxis').map(actor => {
  const window = actor.meta_window;
  const buffer = window.get_buffer_rect();
  return {
    id: window.get_id(),
    workspace: window.get_workspace()?.index() ?? null,
    hidden: window.is_hidden(),
    mapped: actor.mapped,
    followsBuffer: actor.x === buffer.x && actor.y === buffer.y && actor.width === buffer.width && actor.height === buffer.height,
  };
})"""


def placement(window):
    return {k: window[k] for k in ("workspace", "monitor", "maximized", "x", "y", "width", "height")} if window else None


@test
def restore_monitors(session, checks, out_dir):
    """With two monitors, Ptyxis windows maximized and tiled on either of them return to their monitors, workspaces,
    states and geometries after logging in again, also on workspaces not visited yet, the overview's workspace
    thumbnails show them, and visiting their workspaces shows them unchanged. The maximized window on the second
    monitor needs restore-target-monitor.patch and
    restore-maximized-client-monitor.patch of patches/mutter/, the thumbnails of maximized and tiled windows need
    hidden-window-updates.patch. The windows are tiled with mutter's keybindings, with tiling-assistant disabled as
    configure-gnome-desktop.sh disables it: tiling-assistant leaves a tiled window floating."""
    dropin = pathlib.Path.home() / ".config/systemd/user/org.gnome.Shell@ubuntu.service.d"
    dropin.mkdir(parents=True, exist_ok=True)
    (dropin / "95-two-monitors.conf").write_text(TWO_MONITORS)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{PTYXIS}']")
    session.gsettings("org.gnome.shell", "disabled-extensions", "['tiling-assistant@ubuntu.com']")
    session.gsettings("org.gnome.mutter.keybindings", "toggle-tiled-left", "['<Super>Left']")
    session.gsettings("org.gnome.mutter.keybindings", "toggle-tiled-right", "['<Super>Right']")
    session.login()
    monitors = session.eval(MONITORS)
    checks.check("GNOME Shell has two monitors side by side", monitors and len(monitors) == 2 and monitors[1][0] == monitors[0][2],
                 str(monitors))
    if not monitors or len(monitors) != 2:
        session.logout()
        return {}
    # workspace, monitor, state
    layout = [(1, 1, "maximized"), (4, 1, "tiled left"), (6, 0, "tiled right")]
    arranged = []
    for workspace, monitor, state in layout:
        session.call("activateWorkspace", workspace)
        # The dock lists the windows of the active workspace a moment after a switch, and a click before that activates
        # the window of the previous workspace.
        time.sleep(1)
        session.call("clickDockIcon", PTYXIS)
        window = shown_window(session, PTYXIS, lambda w, workspace=workspace: w["workspace"] == workspace)
        if not window:
            break
        session.call("moveResizeWindow", window["id"], monitors[monitor][0] + 100, monitors[monitor][1] + 100, 800, 600)
        time.sleep(0.5)
        if state == "maximized":
            session.call("maximizeWindow", window["id"])
        else:
            session.press("Left" if state == "tiled left" else "Right", "Super_L")
        time.sleep(1)
        arranged.append(find(session.windows(PTYXIS), lambda w, id=window["id"]: w["id"] == id))
    expected = [(workspace, monitor, state == "maximized") for workspace, monitor, state in layout]
    checks.check("Ptyxis has a window maximized on the second monitor on workspace 2, one tiled left on the second "
                 "monitor on workspace 5 and one tiled right on the first monitor on workspace 7",
                 len(arranged) == 3 and all(arranged) and
                 [(w["workspace"], w["monitor"], w["maximized"]) for w in arranged] == expected and
                 all(w["width"] < monitors[w["monitor"]][2] for w in arranged[1:]),
                 str([placement(w) for w in arranged]))
    if len(arranged) != 3 or not all(arranged):
        session.logout()
        return {}
    # Ptyxis saves its session a few seconds after a change.
    time.sleep(5)
    session.logout()

    session.login()
    session.call("activateWorkspace", 0)
    session.call("clickDockIcon", PTYXIS)
    wait_for(lambda: (lambda ws: ws if {w["workspace"] for w in ws} >= {1, 4, 6} else None)(session.windows(PTYXIS)), 30)
    # The restored windows draw their first content right after they are restored.
    time.sleep(3)
    restored = []
    for before, (workspace, monitor, state) in zip(arranged, layout):
        after = find(session.windows(PTYXIS), lambda w, workspace=workspace: w["workspace"] == workspace)
        restored.append(after)
        checks.check(f"the window {state} on monitor {monitor + 1} returns to workspace {workspace + 1}, not visited yet, "
                     "on its monitor with its state and geometry", placement(after) == placement(before),
                     f"before {placement(before)}, after {placement(after)}")
    session.eval("Main.overview.show(); true")
    wait_for(lambda: session.eval("Main.overview.visible && !Main.overview.animationInProgress"), 10)
    shown = session.eval(OVERVIEW_THUMBNAILS)
    session.eval("Main.overview.hide(); true")
    for workspace, monitor, state in layout:
        window = find(shown, lambda w, workspace=workspace: w["workspace"] == workspace)
        checks.check(f"the window {state} on workspace {workspace + 1}, not visited yet, shows in its thumbnail with its size",
                     window and window["inThumbnail"] and window["width"] > 0 and window["height"] > 0, str(window))
    # The first time a restored window is shown is when its workspace is visited, after it was hidden with its actor
    # following its geometry and content.
    visited = []
    for before, (workspace, monitor, state) in zip(arranged, layout):
        session.call("activateWorkspace", workspace)
        actor = wait_for(lambda workspace=workspace: find(session.eval(SHOWN_WINDOWS),
                                                          lambda w: w["workspace"] == workspace and not w["hidden"] and w["mapped"]), 10)
        # The map animation of the window ends a moment after the switch.
        time.sleep(1)
        actor = find(session.eval(SHOWN_WINDOWS), lambda w, workspace=workspace: w["workspace"] == workspace)
        after = find(session.windows(PTYXIS), lambda w, workspace=workspace: w["workspace"] == workspace)
        visited.append({"actor": actor, "window": after})
        checks.check(f"visiting workspace {workspace + 1} shows the window {state} there unchanged, with its actor following it",
                     actor and not actor["hidden"] and actor["mapped"] and actor["followsBuffer"] and
                     placement(after) == placement(before), f"before {placement(before)}, after {placement(after)}, actor {actor}")
    session.logout()
    return {"monitors": monitors, "arranged": arranged, "restored": restored, "overview": shown, "visited": visited}


FIREFOX = "firefox.desktop"
WEB_PORT = 8000


def write_pages(directory, names):
    """Writes a page for each name, whose title is the name, which Firefox shows in its window's title."""
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        (directory / f"{name}.html").write_text(f"<!DOCTYPE html><title>{name}</title><p>{name}</p>\n")


def serve(directory):
    """Serves the files in directory over HTTP on localhost, as the links which a terminal opens point to a web server."""
    return subprocess.Popen([sys.executable, "-I", "-m", "http.server", "--bind", "127.0.0.1", "--directory", str(directory),
                             str(WEB_PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def firefox_session_saved():
    """Whether a Firefox profile of the user has the session file Firefox writes only when it quits cleanly, and
    moves away when it starts."""
    home = pathlib.Path.home()
    return any(home.glob(".config/mozilla/firefox/*/sessionstore.jsonlz4")) or \
        any(home.glob(".mozilla/firefox/*/sessionstore.jsonlz4"))


def ended_before_shell(session, since, pid):
    """Returns whether the scope of the application launched as process pid ended before GNOME Shell began to shut
    down, according to the journal since a time in seconds since the epoch, and the two lines which tell."""
    lines = session.journal(since)
    ended = next((line for line in lines if f"-{pid}.scope" in line and
                  any(word in line for word in ("Deactivated", "Consumed", "Stopped "))), None)
    shell = next((line for line in lines if "Shutting down GNOME Shell" in line), None)
    return ended is not None and shell is not None and lines.index(ended) < lines.index(shell), [ended, shell]


def titled(name):
    return lambda w: (w["title"] or "").startswith(name)


@test
def firefox(session, checks, out_dir):
    """Firefox returns its windows to their workspaces, positions and sizes after logging out and in again, each with
    its page, without activating them, while every launch from the dock and every link opened from a terminal opens a
    new window on the current workspace and focuses it."""
    home = pathlib.Path.home()
    pages = home / "pages"
    write_pages(pages, ["page-one", "page-two", "page-three", "page-four"])
    server = serve(pages)
    # Links open in Firefox, as in the user's session, where Firefox is the default browser.
    (home / ".config").mkdir(exist_ok=True)
    (home / ".config/mimeapps.list").write_text(
        "[Default Applications]\nx-scheme-handler/http=firefox.desktop\nx-scheme-handler/https=firefox.desktop\ntext/html=firefox.desktop\n")
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{FIREFOX}']")
    url = f"localhost:{WEB_PORT}"

    def load(page):
        session.press("l", "Control_L")
        time.sleep(0.5)
        session.type_text(f"{url}/{page}.html\n")

    try:
        session.login()
        session.call("activateWorkspace", 1)
        session.call("clickDockIcon", FIREFOX)
        first = shown_window(session, FIREFOX, lambda w: True, 60)
        checks.check("started from the dock on the current workspace, focused",
                     first and first["workspace"] == 1 and first["focused"], str(window_summary(first)))
        if not first:
            return {}
        time.sleep(2)
        load("page-one")
        first = wait_for(lambda: find(session.windows(FIREFOX), titled("page-one")), 30)
        checks.check("the first window shows its page", first, str([window_summary(w) for w in session.windows(FIREFOX)]))

        # A link opened from a terminal on workspace 5 opens in a new window there.
        session.call("activateWorkspace", 4)
        session.run_in_session("xdg-open", f"http://{url}/page-two.html")
        second = shown_window(session, FIREFOX, titled("page-two"), 30)
        checks.check("a link opened from a terminal opens in a new window on the current workspace, focused",
                     second and second["workspace"] == 4 and second["focused"], str(window_summary(second)))
        geometry = (100, 120, 1000, 600)
        if second:
            session.call("moveResizeWindow", second["id"], *geometry)

        # Clicked in the dock on workspace 8, where it has no window, it opens a new window there.
        session.call("activateWorkspace", 7)
        known = {w["id"] for w in session.windows(FIREFOX)}
        session.call("clickDockIcon", FIREFOX)
        third = shown_window(session, FIREFOX, lambda w: w["id"] not in known, 30)
        checks.check("clicked in the dock on a workspace without its window, it opens a new one there, focused",
                     third and third["workspace"] == 7 and third["focused"], str(window_summary(third)))
        if third:
            time.sleep(2)
            load("page-three")
            wait_for(lambda: find(session.windows(FIREFOX), titled("page-three")), 30)

        # Firefox saves its session every second.
        time.sleep(4)
        before = session.windows(FIREFOX)
        logout_started = time.time()
        dialogs = session.logout()
        checks.check("logging out asks nothing", not dialogs, str(dialogs))
        # Without a clean quit, the next start is a recovery from a crash, which restores the windows as they were.
        checks.check("logging out ends Firefox cleanly, with its session saved", firefox_session_saved())
        # Firefox quits when the session ends, and GNOME Shell and the processes of Firefox have to be there until it
        # has quit.
        ended, lines = ended_before_shell(session, logout_started, before[0]["pid"])
        checks.check("logging out lets Firefox quit before GNOME Shell shuts down", ended, str(lines))

        session.login()
        session.call("activateWorkspace", 10)
        session.call("clickDockIcon", FIREFOX)
        new = shown_window(session, FIREFOX, lambda w: w["workspace"] == 10, 60)
        wait_for(lambda: len(session.windows(FIREFOX)) >= 4, 30)
        time.sleep(3)
        after = session.windows(FIREFOX)
        for name, workspace in (("page-one", 1), ("page-two", 4), ("page-three", 7)):
            window = find(after, titled(name))
            checks.check(f"the window with {name} returns to its workspace, not focused",
                         window and window["workspace"] == workspace and not window["focused"], str(window_summary(window)))
        restored_second = find(after, titled("page-two"))
        if restored_second:
            placed = (restored_second["x"], restored_second["y"], restored_second["width"], restored_second["height"])
            checks.check("the window with page-two returns to its position and size", placed == geometry, f"{placed}, was {geometry}")
        checks.check("the launch after logging in opens a new window on the current workspace, focused",
                     new and new["focused"], str(window_summary(new)))
        checks.check("restoring switched no workspace", session.call("workspaces")["active"] == 10, str(session.call("workspaces")))
        # Restoring a session can ask mutter to activate a window without an event of the user behind the request,
        # which makes mutter mark the window as demanding attention.
        attention = [window_summary(w) for w in session.windows(FIREFOX) if w["demandsAttention"]]
        checks.check("no restored window demands attention", not attention, str(attention))

        # A link opened from a terminal while it runs opens in a new window on the current workspace too.
        session.call("activateWorkspace", 11)
        session.run_in_session("xdg-open", f"http://{url}/page-four.html")
        fourth = shown_window(session, FIREFOX, titled("page-four"), 30)
        checks.check("a link opened from a terminal after restoring opens in a new window on the current workspace, focused",
                     fourth and fourth["workspace"] == 11 and fourth["focused"], str(window_summary(fourth)))
        # The session monitor of Firefox ends with the portal's process, so Firefox creates a new one when the portal
        # starts again.
        subprocess.run(["systemctl", "--user", "restart", "xdg-desktop-portal.service"], check=True)
        monitor = wait_for(lambda: "firefox_session_monitor" in subprocess.run(
            ["busctl", "--user", "tree", "--list", "org.freedesktop.portal.Desktop"], capture_output=True, text=True).stdout, 30)
        checks.check("after a restart of the portal, Firefox monitors the session again", monitor)
        pid = session.windows(FIREFOX)[0]["pid"]
        logout_started = time.time()
        session.logout()
        checks.check("logging out again ends Firefox cleanly, with its session saved", firefox_session_saved())
        ended, lines = ended_before_shell(session, logout_started, pid)
        checks.check("logging out again lets Firefox quit before GNOME Shell shuts down", ended, str(lines))
        # xdg-desktop-portal-gtk logs each inhibit session still open when it stops waiting for them at the end of the
        # session, such as one which the portal created before it restarted.
        still_open = [line for line in session.journal(logout_started) if "still open" in line]
        checks.check("logging out again waits for no inhibit session from before the portal restarted", not still_open,
                     str(still_open))
        return {"before": before, "after": after, "dialogs": dialogs}
    finally:
        server.terminate()


CHROMIUM = "chromium.desktop"


def chromium_units():
    """Returns the units Chromium's processes are in, with how many processes each."""
    units = {}
    for pid in processes(r"^/usr/lib/chromium/chromium( |$)"):
        unit = unit_of(cgroup_of(pid))
        units[unit] = units.get(unit, 0) + 1
    return units


@test
def chromium(session, checks, out_dir):
    """Chromium ends cleanly when the user logs out, with its helpers stopped only after the browser process
    exited, and returns its windows to their workspaces, positions and sizes after logging in again, without activating
    them. Its helpers start in the scope its launch put it into, while the browser process moves into a scope of its
    own."""
    home = pathlib.Path.home()
    pages = home / "pages"
    write_pages(pages, ["page-one", "page-two"])
    server = serve(pages)
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{CHROMIUM}']")
    url = f"localhost:{WEB_PORT}"

    def load(page):
        session.press("l", "Control_L")
        time.sleep(0.5)
        session.type_text(f"{url}/{page}.html\n")

    try:
        session.login()
        session.call("activateWorkspace", 1)
        session.call("clickDockIcon", CHROMIUM)
        first = shown_window(session, CHROMIUM, lambda w: True, 60)
        checks.check("started from the dock on the current workspace, focused",
                     first and first["workspace"] == 1 and first["focused"], str(window_summary(first)))
        if not first:
            return {}
        time.sleep(2)
        load("page-one")
        wait_for(lambda: find(session.windows(CHROMIUM), titled("page-one")), 30)

        session.call("activateWorkspace", 4)
        known = {w["id"] for w in session.windows(CHROMIUM)}
        session.call("clickDockIcon", CHROMIUM)
        second = shown_window(session, CHROMIUM, lambda w: w["id"] not in known, 30)
        checks.check("clicked in the dock on a workspace without its window, it opens a new one there, focused",
                     second and second["workspace"] == 4 and second["focused"], str(window_summary(second)))
        geometry = (100, 120, 1000, 600)
        if second:
            time.sleep(2)
            load("page-two")
            wait_for(lambda: find(session.windows(CHROMIUM), titled("page-two")), 30)
            session.call("moveResizeWindow", second["id"], *geometry)

        units = chromium_units()
        checks.check("Chromium's helpers are in the scope its launch put it into, the browser process in one of its own",
                     len(units) == 2 and any(re.match(r"^app-gnome-chromium-[0-9]+\.scope$", u or "") for u in units),
                     str(units))
        time.sleep(3)
        before = session.windows(CHROMIUM)
        logout_started = time.time()
        dialogs = session.logout()
        checks.check("logging out asks nothing", not dialogs, str(dialogs))
        crashes = [line for line in session.journal(logout_started)
                   if "GPU process isn't usable" in line or re.search(r"chromium.*(SIGTRAP|core dumped|Crashpad)", line)]
        checks.check("Chromium did not crash at logout", not crashes, str(crashes[:5]))
        preferences = json.loads((home / ".config/chromium/Default/Preferences").read_text())
        exit_type = preferences.get("profile", {}).get("exit_type")
        checks.check("Chromium recorded that the session ended", exit_type == "SessionEnded", str(exit_type))

        session.login()
        session.call("activateWorkspace", 10)
        session.call("clickDockIcon", CHROMIUM)
        wait_for(lambda: find(session.windows(CHROMIUM), titled("page-two")), 60)
        time.sleep(3)
        after = session.windows(CHROMIUM)
        for name, workspace in (("page-one", 1), ("page-two", 4)):
            window = find(after, titled(name))
            checks.check(f"the window with {name} returns to its workspace, not focused",
                         window and window["workspace"] == workspace and not window["focused"], str(window_summary(window)))
        restored_second = find(after, titled("page-two"))
        if restored_second:
            placed = (restored_second["x"], restored_second["y"], restored_second["width"], restored_second["height"])
            checks.check("the window with page-two returns to its position and size", placed == geometry, f"{placed}, was {geometry}")
        checks.check("restoring switched no workspace", session.call("workspaces")["active"] == 10, str(session.call("workspaces")))
        # TODO: Check that no restored window demands attention once Chromium no longer asks to activate them.
        #       Chromium asks mutter to activate every window it restores, without an event of the user behind the
        #       request, so mutter marks each of them as demanding attention. Until a fix in Chromium, the test only
        #       records these windows in result.json.
        #       See: https://issues.chromium.org/issues/582928432
        attention = [window_summary(w) for w in session.windows(CHROMIUM) if w["demandsAttention"]]
        session.logout()
        return {"before": before, "after": after, "units": units, "dialogs": dialogs, "demanding_attention": attention}
    finally:
        server.terminate()


SHUTDOWN_INHIBITOR = "Stop application scopes before shutdown"


def browser_process():
    """Returns the ID of Chromium's browser process, the one in the scope Chromium created for itself, or None."""
    for pid in processes(r"^/usr/lib/chromium/chromium( |$)"):
        if re.match(r"^app-org\.chromium\.Chromium-[0-9]+\.scope$", unit_of(cgroup_of(pid)) or ""):
            return pid
    return None


@test
def shutdown(session, checks, out_dir):
    """When logind announces a shutdown, Chromium exits before the shutdown starts, as a service of the user holds
    logind's delay inhibitor until Chromium's browser process exited, and Chromium neither crashes nor loses its
    session. Without it, logind starts the shutdown while the browser process still runs, and its helpers can die first."""
    home = pathlib.Path.home()
    pages = home / "pages"
    write_pages(pages, ["page-one"])
    server = serve(pages)
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{CHROMIUM}']")
    try:
        session.login()
        own = lambda: [i for i in session.logind()["inhibitors"]
                       if i["who"] == SHUTDOWN_INHIBITOR and i["uid"] == os.getuid() and i["released"] is None]
        held = wait_for(own, 20)
        checks.check("the service holds a delay inhibitor for shutdowns",
                     held and held[0]["mode"] == "delay" and held[0]["what"] == "shutdown", str(held))

        session.call("clickDockIcon", CHROMIUM)
        shown_window(session, CHROMIUM, lambda w: True, 60)
        time.sleep(2)
        session.press("l", "Control_L")
        time.sleep(0.5)
        session.type_text(f"localhost:{WEB_PORT}/page-one.html\n")
        wait_for(lambda: find(session.windows(CHROMIUM), titled("page-one")), 30)
        browser = browser_process()
        checks.check("Chromium's browser process runs in a scope of its own", browser, str(chromium_units()))
        time.sleep(3)

        announced = time.time()
        exited = None

        # Polled often, so that when the browser process exited is known closely enough to compare it with when the
        # inhibitor was released.
        def released():
            nonlocal exited
            if exited is None and browser and not pathlib.Path(f"/proc/{browser}").exists():
                exited = time.time()
            inhibitor = next((i for i in session.logind()["inhibitors"] if held and i["taken"] == held[0]["taken"]), None)
            return inhibitor if inhibitor and inhibitor["released"] else None

        session.prepare_for_shutdown(True)
        inhibitor = wait_for(released, 30, 0.01)
        checks.check("the inhibitor is released once logind announced the shutdown", inhibitor,
                     f"{inhibitor['released'] - announced:.3f} s after the announcement" if inhibitor else "not released")
        if inhibitor:
            # The poll which saw the release may have been the first to see the process gone too.
            exited = exited or time.time()
            checks.check("Chromium's browser process exited before the inhibitor was released",
                         exited - announced <= inhibitor["released"] - announced + 0.02,
                         f"exited {exited - announced:.3f} s, released {inhibitor['released'] - announced:.3f} s after the announcement")
        crashes = [line for line in session.journal(announced)
                   if "GPU process isn't usable" in line or re.search(r"chromium.*(SIGTRAP|core dumped|Crashpad)", line)]
        checks.check("Chromium did not crash", not crashes, str(crashes[:5]))
        preferences = json.loads((home / ".config/chromium/Default/Preferences").read_text())
        exit_type = preferences.get("profile", {}).get("exit_type")
        checks.check("Chromium recorded that the session ended", exit_type == "SessionEnded", str(exit_type))
        session.logout()
        return {"logind": session.logind()}
    finally:
        server.terminate()


@test
def chromium_quit(session, checks, out_dir):
    """Ctrl+Q quits Chromium, through the extension and native messaging host of this repository, as a logout does: the
    browser process exits on SIGTERM and records that the session ended, so that the next start restores every window,
    each on its workspace, and nothing crashes."""
    home = pathlib.Path.home()
    pages = home / "pages"
    write_pages(pages, ["page-one", "page-two"])
    server = serve(pages)
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{CHROMIUM}']")
    url = f"localhost:{WEB_PORT}"

    def load(page):
        session.press("l", "Control_L")
        time.sleep(0.5)
        session.type_text(f"{url}/{page}.html\n")

    try:
        session.login()
        for workspace, page in ((1, "page-one"), (4, "page-two")):
            session.call("activateWorkspace", workspace)
            known = {w["id"] for w in session.windows(CHROMIUM)}
            session.call("clickDockIcon", CHROMIUM)
            if not shown_window(session, CHROMIUM, lambda w: w["id"] not in known, 60):
                checks.check(f"Chromium opened a window on workspace {workspace + 1}", False)
                return {}
            time.sleep(2)
            load(page)
            wait_for(lambda: find(session.windows(CHROMIUM), titled(page)), 30)
        browser = browser_process()
        time.sleep(3)

        pressed = time.time()
        session.press("q", "Control_L")
        gone = wait_for(lambda: not session.windows(CHROMIUM) and not processes(r"^/usr/lib/chromium/chromium( |$)"), 20)
        checks.check("Ctrl+Q quits Chromium with all its windows and processes", gone,
                     str([window_summary(w) for w in session.windows(CHROMIUM)]))
        crashes = [line for line in session.journal(pressed)
                   if "GPU process isn't usable" in line or re.search(r"chromium.*(SIGTRAP|core dumped|Crashpad)", line)]
        checks.check("Chromium did not crash", not crashes, str(crashes[:5]))
        preferences = json.loads((home / ".config/chromium/Default/Preferences").read_text())
        exit_type = preferences.get("profile", {}).get("exit_type")
        checks.check("Chromium recorded that the session ended, as at a logout", exit_type == "SessionEnded", str(exit_type))

        session.call("activateWorkspace", 10)
        session.call("clickDockIcon", CHROMIUM)
        wait_for(lambda: find(session.windows(CHROMIUM), titled("page-two")), 60)
        time.sleep(3)
        after = session.windows(CHROMIUM)
        for name, workspace in (("page-one", 1), ("page-two", 4)):
            window = find(after, titled(name))
            checks.check(f"the next start restores the window with {name} to its workspace, not focused",
                         window and window["workspace"] == workspace and not window["focused"], str(window_summary(window)))
        session.logout()
        return {"browser": browser, "after": after}
    finally:
        server.terminate()


RESERVE_SPACE = "reserve-space@mitar.tnode.com"


def sizes_while(session, window_id, seconds):
    """Returns the distinct sizes a window had while sampled for seconds."""
    sizes = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        window = find(session.windows(), lambda w: w["id"] == window_id)
        if window:
            size = (window["width"], window["height"])
            if size not in sizes:
                sizes.append(size)
        time.sleep(0.1)
    return sizes


@test
def lock_screen(session, checks, out_dir):
    """Locking the screen leaves a maximized window its size with reserve-space@mitar.tnode.com, although GNOME Shell
    disables the dock meanwhile, whose space a window would otherwise fill, as it does without the extension. The locked
    screen offers no screenshots: quick settings have no screenshot button, and Print and Shift+Print do nothing."""
    home = pathlib.Path.home()
    extensions = home / ".local/share/gnome-shell/extensions"
    extensions.mkdir(parents=True, exist_ok=True)
    shutil.copytree(REPO_DIR / "gnome-extensions" / RESERVE_SPACE, extensions / RESERVE_SPACE)
    screenshots = home / "Pictures/Screenshots"
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{TEXT_EDITOR}']")

    def maximized_window():
        known = {w["id"] for w in session.windows(TEXT_EDITOR)}
        session.call("clickDockIcon", TEXT_EDITOR)
        window = shown_window(session, TEXT_EDITOR, lambda w: w["id"] not in known, 30)
        if not window:
            return None, None
        session.call("maximizeWindow", window["id"])
        time.sleep(2)
        window = find(session.windows(), lambda w: w["id"] == window["id"])
        return window, (window["width"], window["height"])

    # Without the extension, the window fills the dock's space while the screen is locked.
    session.login()
    window, size = maximized_window()
    if not window:
        checks.check("Text Editor started", False)
        return {}
    checks.check("the maximized window leaves the dock its space", window["maximized"] and window["width"] < 1920, str(window_summary(window)))
    session.call("lock")
    without = sizes_while(session, window["id"], 3)
    checks.check("without reserve-space, locking resizes the maximized window", without != [size], f"{without}, was {size}")
    session.call("unlock")
    session.logout()

    # The extension is enabled at login, as configure-gnome-desktop.sh enables it. GNOME Shell then enables it before
    # the dock, which it would otherwise disable and enable again when it disables the dock for the lock screen.
    session.enable_extensions(RESERVE_SPACE)
    session.login()
    checks.check("reserve-space is enabled", session.call("extensionState", RESERVE_SPACE), str(session.call("extensionState", RESERVE_SPACE)))
    window, size = maximized_window()
    if not window:
        checks.check("Text Editor started again", False)
        return {}
    # The extension follows the space the dock reserves a few seconds after it settled.
    time.sleep(7)
    chrome_unlocked = session.call("trackedChrome")
    session.call("lock")
    checks.check("the screen is locked", wait_for(lambda: session.call("locked"), 5))
    while_locked = sizes_while(session, window["id"], 3)
    chrome_locked = session.call("trackedChrome")
    checks.check("with reserve-space, locking leaves the maximized window its size", while_locked == [size], f"{while_locked}, was {size}")

    state = session.call("screenshotState")
    checks.check("the locked screen's quick settings have no screenshot button", state["button"] is False, str(state))
    before = sorted(screenshots.iterdir()) if screenshots.is_dir() else []
    session.press("Print")
    time.sleep(1)
    checks.check("Print opens no screenshot UI on the locked screen", not session.call("screenshotState")["open"],
                 str(session.call("screenshotState")))
    session.press("Print", "Shift_L")
    time.sleep(2)
    after = sorted(screenshots.iterdir()) if screenshots.is_dir() else []
    checks.check("Shift+Print saves no screenshot on the locked screen", after == before, str(after))

    session.call("unlock")
    after_unlock = sizes_while(session, window["id"], 7)
    checks.check("with reserve-space, unlocking leaves the maximized window its size", after_unlock == [size], f"{after_unlock}, was {size}")
    checks.check("unlocked, quick settings have the screenshot button again", session.call("screenshotState")["button"] is True,
                 str(session.call("screenshotState")))
    session.logout()
    return {"size": size, "without": without, "while_locked": while_locked, "after_unlock": after_unlock,
            "chrome_unlocked": chrome_unlocked, "chrome_locked": chrome_locked}


@test
def portal_inhibit(session, checks, out_dir):
    """An application which inhibits logging out through the Inhibit portal and uninhibits right after, as GTK does, leaves
    no inhibitor of gnome-session behind."""
    session.login()
    result_file = out_dir / "portal-inhibit.json"
    session.run_in_session("python3", "-I", str(REPO_DIR / "tests/session/portal_inhibit.py"), "200", str(result_file))
    result = json.loads(result_file.read_text())
    checks.check("closing each request right after inhibiting succeeds", result["close_error_count"] == 0, str(result))
    checks.check("no inhibitor is left after closing every request", result["left"] == 0, str(result))
    session.logout()
    return result


@test
def restart_bus(session, checks, out_dir):
    """Logging out restarts the session bus also while the start of a service which needs it waits in a queued job, as
    the start of xdg-desktop-portal does when Desktop Icons NG starts its process again while GNOME Shell shuts down."""
    units = pathlib.Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    (units / "session-test-slow.service").write_text("[Service]\nType=oneshot\nExecStart=/bin/sleep 120\n")
    (units / "session-test-needs-bus.service").write_text(
        "[Unit]\nRequires=dbus.service\nWants=session-test-slow.service\nAfter=dbus.service session-test-slow.service\n\n"
        "[Service]\nExecStart=/bin/true\n")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)

    session.login()
    # The service waits for the slow one to finish, so its start job is still queued when the session ends.
    subprocess.run(["systemctl", "--user", "start", "--no-block", "session-test-needs-bus.service"], check=True)

    def queued():
        jobs = subprocess.run(["systemctl", "--user", "list-jobs", "--no-legend", "--plain"], capture_output=True, text=True)
        return "session-test-needs-bus.service" in jobs.stdout

    checks.check("the start of a service which needs the session bus is queued", wait_for(queued, 5))
    try:
        session.logout()
        restarted, detail = True, ""
    except RuntimeError as error:
        restarted, detail = False, str(error)
    checks.check("logging out restarts the session bus", restarted, detail)
    # The slow service is stopped before it finished starting, which systemd records as a failure of the test's own.
    names = ["session-test-needs-bus.service", "session-test-slow.service"]
    subprocess.run(["systemctl", "--user", "stop", *names], check=False)
    subprocess.run(["systemctl", "--user", "reset-failed", *names], check=False)
    return {}


GLOBAL_MENU = "global-menu@mitar.tnode.com"
SIGNAL = "signal-desktop"


def menu_registrations(session):
    """Returns the registrations global-menu-registrar holds, as (sender, process ID, window ID, object path), or None
    when it does not answer."""
    try:
        reply = session.bus.call_sync("local.GlobalMenuRegistrar", "/local/GlobalMenuRegistrar", "local.GlobalMenuRegistrar",
                                      "ListRegistrations", None, GLib.VariantType("(a(suuo))"), Gio.DBusCallFlags.NONE, 5000,
                                      None)
    except GLib.Error:
        return None
    return reply.unpack()[0]


def menu_titles(session, sender, path):
    """Returns the labels of the top-level items of a com.canonical.dbusmenu menu, or the error as a string."""
    try:
        reply = session.bus.call_sync(sender, path, "com.canonical.dbusmenu", "GetLayout", GLib.Variant("(iias)", (0, 1, [])),
                                      GLib.VariantType("(u(ia{sv}av))"), Gio.DBusCallFlags.NONE, 5000, None)
    except GLib.Error as error:
        return str(error)
    _revision, (_id, _properties, children) = reply.unpack()
    return [properties.get("label") for _child_id, properties, _children in children]


def processes_of(name):
    """Returns the IDs of the processes of the user whose executable has the given file name."""
    pids = set()
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if pathlib.Path(os.readlink(entry / "exe")).name == name:
                pids.add(int(entry.name))
        except OSError:
            pass
    return pids


@test
def global_menu_login(session, checks, out_dir):
    """An Electron application started at login exports its menu. Electron registers its menu with
    com.canonical.AppMenu.Registrar only when the name has an owner at the moment it sets the menu, and GNOME Shell enables
    extensions only after the applications started at login run, so global-menu-registrar.service owns the name from
    before they start, for a user who enabled global-menu@mitar.tnode.com. Signal is the Electron application, natively on
    Wayland, as GNOME starts it."""
    home = pathlib.Path.home()
    write_desktop_file(home / ".config/autostart", "signal-autostart", "Signal", f"exec {SIGNAL} --ozone-platform=wayland")
    session.enable_extensions(GLOBAL_MENU)

    session.login()
    registrations = wait_for(lambda: [r for r in menu_registrations(session) or [] if r[1] in processes_of(SIGNAL)], 60)
    checks.check("Signal started at login registered its menu", bool(registrations), str(menu_registrations(session)))
    titles = menu_titles(session, registrations[0][0], registrations[0][3]) if registrations else None
    checks.check("Signal exports its menu", isinstance(titles, list) and "File" in titles, str(titles))
    session.logout()
    return {"registrations": registrations, "titles": titles}


APPS_DIR = REPO_DIR / "tests/session/apps"


def install_global_menu(session):
    """Installs global-menu@mitar.tnode.com for the test user and enables it at the next login."""
    extensions = pathlib.Path.home() / ".local/share/gnome-shell/extensions"
    extensions.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(extensions / GLOBAL_MENU, ignore_errors=True)
    shutil.copytree(REPO_DIR / "gnome-extensions" / GLOBAL_MENU, extensions / GLOBAL_MENU)
    session.enable_extensions(GLOBAL_MENU)
    # The virtual pointer's first move into the top bar would otherwise open the overview through the hot corner.
    session.gsettings("org.gnome.desktop.interface", "enable-hot-corners", "false")


def menu_state(session):
    return session.call("globalMenu")


def wait_menu(session, predicate, timeout=10):
    """Waits until the state of the global menu satisfies predicate, and returns that state, or the last one."""
    return wait_for(lambda: (lambda state: state if predicate(state) else None)(menu_state(session)), timeout) \
        or menu_state(session)


def item_label(item):
    """Returns the label of an item as globalMenu() describes it, without its marks."""
    if isinstance(item, dict):
        return item["label"]
    return item.removeprefix("[x] ").removesuffix(" (disabled)")


def read_events(path):
    """Returns the events a test application logged, see apps/menuapp.py."""
    try:
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    except FileNotFoundError:
        return []


def submenu_open(items, label):
    """Returns whether the submenu with the given label is open among items as globalMenu() describes them, also
    inside open submenus."""
    for item in items or []:
        if isinstance(item, dict):
            if item["label"] == label and item["open"]:
                return True
            if item["open"] and submenu_open(item["items"], label):
                return True
    return False


# The label of the overflow button of the global menu, which has the menus which do not fit into the top bar.
OVERFLOW = "\u00bb"


def menu_open(state, title):
    """Returns whether the menu with the given title is open, also as a submenu of the overflow button."""
    return state["open"] == title or (state["open"] == OVERFLOW and submenu_open(state["items"], title))


def click_path(session, path):
    """Clicks the titles and items of the global menu along path, such as ("View", "Zoom", "Zoom In"), waiting after each
    click until the menu or submenu it opens is open. A title or submenu which did not open is clicked once more: an
    application can change its menu while it is open, as Visual Studio Code does, which the test cannot wait for. The
    title is clicked once the top bar shows it, as the menu of a new window comes a moment after the window."""
    wait_menu(session, lambda state: path[0] in state["titles"], 30)
    for attempt in range(2):
        session.call("clickGlobalMenu", path[0])
        if menu_open(wait_menu(session, lambda state: menu_open(state, path[0]), 5), path[0]):
            break
        if attempt:
            raise RuntimeError(f"{path[0]} did not open: {global_menu_internals(session)}")
    for i, label in enumerate(path[1:], start=1):
        last = i == len(path) - 1
        for _ in range(2):
            session.call("clickGlobalMenuItem", label)
            if last or submenu_open(wait_menu(session, lambda state: submenu_open(state["items"], label), 5)["items"],
                                    label):
                break
        time.sleep(0.5)


def check_menu_titles(session, checks, name, titles, timeout=30):
    """Checks that the global menu shows the application's name followed by the given titles, or by File and at least
    one more menu when titles is None, and returns the titles of the menus."""
    expected = (lambda found: found == titles) if titles else (lambda found: len(found) >= 2 and found[0] == "File")
    state = wait_menu(session, lambda s: expected(s["titles"][1:]), timeout)
    checks.check(f"{name}: the top bar shows the application's name followed by its menus {titles or 'File, ...'}",
                 state["shown"] and expected(state["titles"][1:]) and state["titles"][0] != "", str(state))
    return state["titles"][1:]


def global_menu_internals(session):
    """Returns what the global menu extension holds, for the details of a failed check: its grabbed keys, GNOME Shell's
    action mode, the focused window, and the items of the first menu."""
    return session.eval(f"""(() => {{
        const extension = Main.extensionManager.lookup('{GLOBAL_MENU}')?.stateObj;
        const bar = extension?._menuBar;
        const first = bar?._buttons[0];
        return {{
            grabs: extension
                ? [...extension._keyboard._grabs.keys()].map(a => imports.gi.Meta.external_binding_name_for_action(a))
                : null,
            actionMode: Main.actionMode,
            focusWindow: global.display.focus_window?.title ?? null,
            firstItems: first?.menu._getMenuItems().length ?? null,
            focusOnOpen: bar?._focusOnOpen?.label.text ?? null,
            menus: bar?._buttons.map(b => [b.label.text, b.menu._getMenuItems().length, b.menu.isOpen]) ?? null,
            model: bar?._model?._topLevel?.().map(node => node.children?.length ?? null) ?? null,
        }};
    }})()""")


def check_menu_keys(session, checks, name, titles, mnemonic):
    """Checks the keys of the global menu. F10 and a tap of the left Alt open the menu of the application's name with
    the keyboard focus on its first item, and Right moves from it to the first menu. Alt with the mnemonic of the first
    menu opens that menu with the keyboard focus on its first item. Right and Left move to the next menu and back, and
    Escape closes the menu. An application which exports no mnemonics, as Firefox, has mnemonic None, and the keys are
    checked from the menu of the application's name."""
    first, second = titles[0], titles[1]
    app = menu_state(session)["titles"][0]

    def first_item(state):
        return next((item_label(i) for i in state["items"] or [] if i != "---"), None)

    for how, key in (("F10", "F10"), ("a tap of the left Alt", "Alt_L")):
        session.press(key)
        state = wait_menu(session, lambda s: s["open"] == app)
        checks.check(f"{name}: {how} opens the menu of the application's name with the keyboard focus on its first item",
                     state["open"] == app and state["focus"] == first_item(state),
                     str(state) if state["open"] == app else f"{state}, {global_menu_internals(session)}")
        session.press("Escape")
        wait_menu(session, lambda s: s["open"] is None)

    session.press("Alt_L")
    wait_menu(session, lambda s: s["open"] == app)
    session.press("Right")
    state = wait_menu(session, lambda s: s["open"] == first)
    checks.check(f"{name}: Right moves from the menu of the application's name to {first}", state["open"] == first,
                 str(state) if state["open"] == first else f"{state}, {global_menu_internals(session)}")
    if mnemonic:
        session.press("Escape")
        wait_menu(session, lambda s: s["open"] is None)
        session.press(mnemonic, "Alt_L")
        state = wait_menu(session, lambda s: s["open"] == first)
        checks.check(f"{name}: Alt+{mnemonic.upper()} opens {first} with the keyboard focus on its first item",
                     state["open"] == first and state["focus"] == first_item(state), str(state))
        # Right on a submenu, as LibreOffice's first item New is, opens the submenu, so the focus moves on to an item.
        submenus = {i["label"] for i in state["items"] or [] if isinstance(i, dict)}
        for _ in range(5):
            if state["focus"] not in submenus:
                break
            session.press("Down")
            state = wait_menu(session, lambda s, focus=state["focus"]: s["focus"] != focus, 2)
    session.press("Right")
    state = wait_menu(session, lambda s: s["open"] == second)
    checks.check(f"{name}: Right moves to {second}", state["open"] == second, str(state))
    session.press("Left")
    state = wait_menu(session, lambda s: s["open"] == first)
    checks.check(f"{name}: Left moves back to {first}", state["open"] == first, str(state))
    session.press("Escape")
    state = wait_menu(session, lambda s: s["open"] is None)
    checks.check(f"{name}: Escape closes the menu", state["open"] is None, str(state))

def menu_app(session, checks, out_dir, toolkit):
    """The test application apps/menuapp.py, whose menu bar the global menu shows instead of the window: the keys open
    its menus, its items act when clicked or chosen with the keyboard, also in a submenu, a checked item shows its mark,
    an item shows its icon, the labels of a menu with a check mark or an icon line up, and the window keeps its keyboard
    focus throughout."""
    install_global_menu(session)
    log = out_dir / f"menuapp-{toolkit}.log"
    session.login()
    session.call("spawnCommandLine", f"env QT_QPA_PLATFORM=wayland python3 {APPS_DIR}/menuapp.py {toolkit} {log}")
    title = f"menu-test-{toolkit}"
    window = shown_window(session, None, lambda w: w["title"] == title, 30)
    checks.check(f"{toolkit}: the window opened", bool(window), str(window_summary(window)))

    titles = ["File", "Edit", "View"]
    check_menu_titles(session, checks, toolkit, titles)
    hidden = wait_for(lambda: [e["value"] for e in read_events(log) if e["event"] == "menubar-hidden"], 10)
    checks.check(f"{toolkit}: the window hides its own menu bar", bool(hidden) and all(hidden), str(hidden))

    # Mutter reports the left Alt held on its own, with patches/mutter/watched-modifiers.patch.
    session.call("setKey", "Alt_L", True)
    held = wait_menu(session, lambda s: s["underlinedTitles"] == titles)
    session.call("setKey", "Shift_L", True)
    combined = wait_menu(session, lambda s: not s["underlinedTitles"])
    session.call("setKey", "Shift_L", False)
    session.call("setKey", "Alt_L", False)
    time.sleep(0.5)
    after = menu_state(session)
    checks.check(f"{toolkit}: while the left Alt is held, the titles underline the letters of their mnemonics",
                 held["underlinedTitles"] == titles and held["open"] is None, str(held))
    checks.check(f"{toolkit}: another key pressed with Alt hides the underlines, and its release opens no menu",
                 not combined["underlinedTitles"] and after["open"] is None and not after["underlinedTitles"],
                 str([combined, after]))
    check_menu_keys(session, checks, toolkit, titles, "f")

    def activated():
        return [e["value"] for e in read_events(log) if e["event"] == "activate"]

    session.press("f", "Alt_L")
    state = wait_menu(session, lambda s: s["open"] == "File" and s["layout"] and all(i["underlined"] for i in s["layout"]))
    checks.check(f"{toolkit}: a menu opened with Alt+F underlines the letters of the mnemonics, in the titles too",
                 all(i["underlined"] for i in state["layout"] or []) and state["underlinedTitles"] == titles, str(state))
    session.press("Return")
    checks.check(f"{toolkit}: Return activates the item with the keyboard focus, New",
                 wait_for(lambda: "_New" in activated(), 5), str(activated()))
    session.call("clickGlobalMenu", "Edit")
    state = wait_menu(session, lambda s: s["open"] == "Edit" and s["layout"])
    checks.check(f"{toolkit}: a menu opened with a click underlines no letters",
                 not any(i["underlined"] for i in state["layout"] or []) and not state["underlinedTitles"], str(state))
    session.press("Escape")
    wait_menu(session, lambda s: s["open"] is None)
    click_path(session, ["Edit", "Paste"])
    checks.check(f"{toolkit}: clicking Edit, Paste activates Paste", wait_for(lambda: "_Paste" in activated(), 5),
                 str(activated()))
    # A menu which opens under the pointer gives the item there the keyboard focus.
    session.call("movePointerAway")
    session.press("e", "Alt_L")
    wait_menu(session, lambda s: s["open"] == "Edit")
    time.sleep(0.5)
    before = menu_state(session)["focus"]
    session.press("p")
    first = wait_menu(session, lambda s: s["focus"] != before)["focus"]
    session.press("p")
    second = wait_menu(session, lambda s: s["focus"] != first)["focus"]
    checks.check(f"{toolkit}: in Edit, P moves the keyboard focus between Paste and Preferences, which share it",
                 {first, second} == {"Paste", "Preferences"} and "_Preferences" not in activated(),
                 str((before, first, second)))
    session.press("Escape")
    wait_menu(session, lambda s: s["open"] is None)
    session.press("v", "Alt_L")
    wait_menu(session, lambda s: s["open"] == "View")
    session.press("z")
    state = wait_menu(session, lambda s: submenu_open(s["items"], "Zoom") and s["focus"] == "Zoom In")
    checks.check(f"{toolkit}: in View, Z opens the submenu Zoom with the keyboard focus on Zoom In",
                 submenu_open(state["items"], "Zoom") and state["focus"] == "Zoom In", str(state))
    session.press("o")
    checks.check(f"{toolkit}: then O activates Zoom Out", wait_for(lambda: "Zoom _Out" in activated(), 5),
                 str(activated()))
    click_path(session, ["View", "Zoom", "Zoom In"])
    checks.check(f"{toolkit}: clicking View, Zoom, Zoom In activates the item of the submenu",
                 wait_for(lambda: "Zoom _In" in activated(), 5), str(activated()))
    click_path(session, ["View", "Show Toolbar"])
    checks.check(f"{toolkit}: clicking View, Show Toolbar activates it", wait_for(lambda: "Show _Toolbar" in activated(), 5),
                 str(activated()))
    session.call("clickGlobalMenu", "View")
    state = wait_menu(session, lambda s: s["open"] == "View" and "[x] Show Toolbar" in (s["items"] or []) and
                      all(item["x"] is not None for item in s["layout"] or []))
    checks.check(f"{toolkit}: Show Toolbar shows its check mark", "[x] Show Toolbar" in (state["items"] or []), str(state))
    starts = {item["x"] for item in state["layout"] or []}
    checks.check(f"{toolkit}: in View, Zoom has the space of a check mark too, so the labels line up",
                 len(state["layout"] or []) == 2 and len(starts) == 1, str(state["layout"]))
    session.press("Escape")
    wait_menu(session, lambda s: s["open"] is None)
    session.call("clickGlobalMenu", "File")
    state = wait_menu(session, lambda s: s["open"] == "File" and s["layout"] and
                      all(item["x"] is not None for item in s["layout"]))
    layout = {item["label"]: item for item in state["layout"] or []}
    checks.check(f"{toolkit}: Open shows its icon, and New has the space of an icon, so the labels line up",
                 layout.get("Open", {}).get("icon") is True and layout.get("New", {}).get("icon") is False and
                 len({item["x"] for item in layout.values()}) == 1, str(state["layout"]))
    # A shortcut of the window, with patches/mutter/forward-key-event.patch, acts as if the menu were not open.
    news = activated().count("_New")
    session.press("n", "Control_L")
    state = wait_menu(session, lambda s: s["open"] is None)
    checks.check(f"{toolkit}: Ctrl+N, the shortcut of New, closes the open menu and activates New in the window",
                 state["open"] is None and wait_for(lambda: activated().count("_New") > news, 5),
                 str([state, activated()]))
    session.call("clickGlobalMenu", "Edit")
    wait_menu(session, lambda s: s["open"] == "Edit")
    pastes = activated().count("_Paste")
    session.press("Insert", "Shift_L")
    state = wait_menu(session, lambda s: s["open"] is None)

    # Qt gives Shift+Insert to the focused text field, as its own paste, and not to the shortcut of Paste.
    def pasted():
        if toolkit == "qt":
            return any(e["event"] == "key" and e["value"] == "Shift+Insert" for e in read_events(log))
        return activated().count("_Paste") > pastes

    checks.check(f"{toolkit}: Shift+Insert closes the open menu and reaches the window, "
                 f"{'its text field' if toolkit == 'qt' else 'which activates Paste'}",
                 state["open"] is None and wait_for(pasted, 5), str([state, read_events(log)[-5:]]))

    events = read_events(log)
    lost = [e for e in events if e["event"] in ("active", "focus") and e["value"] is False]
    checks.check(f"{toolkit}: the window never lost its active state or its keyboard focus", not lost, str(events))
    session.logout()
    return {"events": events}


@test
def global_menu_gtk3(session, checks, out_dir):
    """The global menu with a GTK 3 window, which GTK exports through gtk_shell1, see menu_app()."""
    return menu_app(session, checks, out_dir, "gtk3")


@test
def global_menu_gtk4(session, checks, out_dir):
    """The global menu with a GTK 4 window, which GTK exports through gtk_shell1, see menu_app()."""
    return menu_app(session, checks, out_dir, "gtk4")


@test
def global_menu_qt(session, checks, out_dir):
    """The global menu with a Qt 6 window, which Qt exports over com.canonical.dbusmenu and names with
    org_kde_kwin_appmenu, see menu_app()."""
    return menu_app(session, checks, out_dir, "qt")


@test
def global_menu_app_name(session, checks, out_dir):
    """An application without menus, Ptyxis, has the menu of its name: the items of its desktop file, the items of the
    window, and Quit, and Minimize there minimizes the window."""
    install_global_menu(session)
    session.login()
    session.call("activateApp", PTYXIS)
    window = shown_window(session, PTYXIS, lambda w: True, 30)
    checks.check("Ptyxis opened a window", bool(window), str(window_summary(window)))
    # The focus of a window at its start is the subject of the test ptyxis, and a window which did not receive it in a
    # slow session is activated here.
    if window and not window["focused"]:
        session.call("activateWindow", window["id"])
        window = shown_window(session, PTYXIS, lambda w: w["id"] == window["id"], 10)
    state = wait_menu(session, lambda s: len(s["titles"]) == 1 and s["titles"][0] != "", 10)
    checks.check("the top bar shows only the name of Ptyxis", len(state["titles"]) == 1 and state["titles"][0] != "",
                 str(state))
    name = state["titles"][0]
    session.press("Alt_L")
    state = wait_menu(session, lambda s: s["open"] == name)
    checks.check("a tap of the left Alt opens the menu of the application's name", state["open"] == name, str(state))
    labels = [item_label(i) for i in state["items"] or []]
    checks.check("the menu has New Window, the window's items and Quit",
                 "New Window" in labels and "Minimize" in labels and "Close" in labels and labels[-1] == "Quit", str(labels))
    session.call("clickGlobalMenuItem", "Minimize")
    minimized = wait_for(lambda: next((w["minimized"] for w in session.windows(PTYXIS) if w["id"] == window["id"]), None), 5)
    checks.check("Minimize minimizes the window", bool(minimized), str(session.windows(PTYXIS)))
    session.logout()
    return {"labels": labels}


def electron_or_browser(session, checks, name, command, title, titles, mnemonic, effects, timeout=60):
    """Starts an application with a menu, whose window has title in its title, checks the titles and keys of the global
    menu, then performs each of effects, (action, description, check) with action a path of the global menu to click or
    a function to call with the window, and checks the effect with check(window), which returns a truthy value when it
    happened."""
    install_global_menu(session)
    session.login()
    session.call("spawnCommandLine", command)
    window = shown_window(session, None, lambda w: title in (w["title"] or ""), timeout)
    checks.check(f"{name}: the window opened, focused", bool(window and window["focused"]), str(window_summary(window)))
    if not window:
        return {}
    titles = check_menu_titles(session, checks, name, titles, timeout)
    if len(titles) >= 2:
        check_menu_keys(session, checks, name, titles, mnemonic)
    for action, description, check in effects:
        if callable(action):
            action(window)
        else:
            click_path(session, action)
            description = f"clicking {', '.join(action)} {description}"
        checks.check(f"{name}: {description}", wait_for(lambda: check(window), 30), str(session.windows()))
    result = {"menu": menu_state(session), "windows": session.windows()}
    session.logout()
    return result


def fullscreen(session):
    return lambda window: next((w["fullscreen"] for w in session.windows() if w["id"] == window["id"]), False)


def focused(session):
    return lambda window: next((w["focused"] for w in session.windows() if w["id"] == window["id"]), False)


def more_windows(session, count=1):
    return lambda window: len(session.windows(window["app"])) > count


def newest_focused(session, count):
    """Returns a check whether the application of the window has more than count windows, the newest of them focused, as
    a new window receives the focus a moment after it opens."""
    return lambda window: (lambda windows: len(windows) > count and max(windows, key=lambda w: w["id"])["focused"])(
        session.windows(window["app"]))


@test
def global_menu_signal(session, checks, out_dir):
    """Signal, an Electron application, registers its menu with global-menu-registrar, and its window is found by its
    process. Toggle Full Screen in its View menu acts on the window only when Electron has a focused window, which the
    window keeps while the menu is open only with patches/mutter/keep-keyboard-focus.patch."""
    return electron_or_browser(session, checks, "Signal", f"{SIGNAL} --ozone-platform=wayland", "Signal",
                               ["File", "Edit", "View", "Window", "Help"], "f",
                               [(["View", "Toggle Full Screen"], "makes the window fullscreen", fullscreen(session))])


@test
def global_menu_vscode(session, checks, out_dir):
    """Visual Studio Code, with the native title bar configure-gnome-desktop.sh sets, registers its menu as Electron
    does. New Window in its File menu opens a window, and so does Ctrl+Shift+N, which the global menu leaves to the
    window, also while the menu of the application's name is open after a tap of Alt. Full Screen in its View menu acts
    only when Electron has a focused window. It comes last, as a fullscreen window hides the top bar, with the first
    window focused again, so that the click reaches the focused one of four windows, which Electron registers each with
    a menu of its own. Visual Studio Code sets its whole menu again whenever one of its menus opens, which must not
    replace the items under the pointer."""
    settings = pathlib.Path.home() / ".config/Code/User/settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text('{"window.titleBarStyle": "native", "workbench.startupEditor": "none", '
                        '"security.workspace.trust.enabled": false}\n')

    def shortcut_in_open_menu(window):
        session.press("Alt_L")
        wait_menu(session, lambda s: s["open"] == "Visual Studio Code")
        session.press("n", "Control_L", "Shift_L")

    return electron_or_browser(session, checks, "VS Code", "code --ozone-platform=wayland --new-window", "Visual Studio Code",
                               ["File", "Edit", "Selection", "View", "Go", "Run", "Terminal", "Help"], "f",
                               [(["File", "New Window"], "opens a second window, which has the focus",
                                 newest_focused(session, 1)),
                                (lambda window: session.press("n", "Control_L", "Shift_L"),
                                 "Ctrl+Shift+N opens a third window, which has the focus", newest_focused(session, 2)),
                                (shortcut_in_open_menu, "Ctrl+Shift+N with the menu of the application's name open, "
                                 "after a tap of Alt, closes the menu and opens a fourth window, which has the focus",
                                 lambda window: newest_focused(session, 3)(window) and not menu_state(session)["open"]),
                                (lambda window: session.call("activateWindow", window["id"]),
                                 "activating the first window focuses it", focused(session)),
                                (["View", "Appearance", "Full Screen"], "makes the first window fullscreen",
                                 fullscreen(session))])


@test
def global_menu_chromium(session, checks, out_dir):
    """Chromium names its menu with org_kde_kwin_appmenu, and New Window in its File menu opens a window."""
    return electron_or_browser(session, checks, "Chromium", "chromium --ozone-platform=wayland about:blank", "Chromium",
                               None, "f", [(["File", "New window"], "opens a second window", more_windows(session))])


@test
def global_menu_firefox(session, checks, out_dir):
    """Firefox names its menu with org_kde_kwin_appmenu with the preferences of firefox/policies.json, and New Window in
    its File menu opens a window. Firefox exports its menus without mnemonics, so Alt with a letter stays with
    Firefox."""
    return electron_or_browser(session, checks, "Firefox", "firefox about:blank", "Firefox", None, None,
                               [(["File", "New Window"], "opens a second window", more_windows(session))])


@test
def global_menu_libreoffice(session, checks, out_dir):
    """LibreOffice Writer exports its menu bar through gtk_shell1 with a GMenuModel, and New Window in its Window menu
    opens a window."""
    # The dialogs of a first start would take the focus from the document's window, as a new profile has them.
    version = re.search(r"LibreOffice (\d+\.\d+)", subprocess.run(["soffice", "--version"], capture_output=True,
                                                                  text=True).stdout)
    profile = pathlib.Path.home() / ".config/libreoffice/4/user"
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "registrymodifications.xcu").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        '<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse">'
        '<value>false</value></prop></item>\n'
        '<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse">'
        '<value>false</value></prop></item>\n'
        '<item oor:path="/org.openoffice.Setup/Product"><prop oor:name="ooSetupLastVersion" oor:op="fuse">'
        f'<value>{version.group(1) if version else ""}</value></prop></item>\n'
        '</oor:items>\n')
    # The splash screen, which comes first, has the title "LibreOffice" with the version.
    return electron_or_browser(session, checks, "LibreOffice", "env SAL_USE_VCLPLUGIN=gtk3 soffice --writer --norestore",
                               "LibreOffice Writer", None, "f", [(["Window", "New Window"], "opens a second window",
                                                                  more_windows(session))])


def quit_from_global_menu(session, checks, app, name, process, saved, count=7):
    """Opens count windows of a browser, each on a workspace of its own and with a page, chooses Quit in the menu of
    the application's name, and checks that the next start restores every window to its workspace. process is a
    regular expression for the command line of the browser's processes, and saved() returns whether the browser saved
    its session for the next start. The default count is more than the 5 windows which Firefox restores of those
    closed one by one until it quits."""
    home = pathlib.Path.home()
    pages = home / "pages"
    opened = [(i + 1, f"page-{i + 1}") for i in range(count)]
    write_pages(pages, [page for _, page in opened])
    server = serve(pages)
    session.gsettings("org.gnome.shell", "favorite-apps", f"['{app}']")
    install_global_menu(session)
    url = f"localhost:{WEB_PORT}"
    try:
        session.login()
        for workspace, page in opened:
            session.call("activateWorkspace", workspace)
            known = {w["id"] for w in session.windows(app)}
            session.call("clickDockIcon", app)
            if not shown_window(session, app, lambda w: w["id"] not in known, 60):
                checks.check(f"{name}: a window opened on workspace {workspace + 1}", False)
                return {}
            time.sleep(2)
            session.press("l", "Control_L")
            time.sleep(0.5)
            session.type_text(f"{url}/{page}.html\n")
            wait_for(lambda: find(session.windows(app), titled(page)), 30)
        # Both browsers save their sessions within a few seconds of a change.
        time.sleep(5)
        before = session.windows(app)
        title = menu_state(session)["titles"][0]
        started = time.time()
        click_path(session, [title, f"Quit {count} Windows"])
        gone = wait_for(lambda: not session.windows(app) and not processes(process), 30)
        checks.check(f"{name}: Quit {count} Windows in the menu of the application's name quits it", gone,
                     str([window_summary(w) for w in session.windows(app)]))
        checks.check(f"{name}: the session is saved for the next start", saved())
        crashes = [line for line in session.journal(started) if re.search(r"(SIGTRAP|SIGSEGV|core dumped|Crashpad)", line)]
        checks.check(f"{name}: nothing crashed", not crashes, str(crashes[:5]))

        session.call("activateWorkspace", count + 2)
        session.call("clickDockIcon", app)
        wait_for(lambda: session.windows(app), 60)
        time.sleep(8)
        after = session.windows(app)
        for workspace, page in opened:
            window = find(after, titled(page))
            checks.check(f"{name}: the next start restores the window with {page} to its workspace",
                         window and window["workspace"] == workspace, str([window_summary(w) for w in after]))
        session.logout()
        return {"before": before, "after": after}
    finally:
        server.terminate()


@test
def global_menu_quit_chromium(session, checks, out_dir):
    """Quit in the menu of Chromium's name ends Chromium so that its next start restores all its windows: GNOME Shell
    sends SIGTERM to Chromium, with patches/gnome-shell/quit-with-sigterm.patch, which Chromium handles as the end of the
    session. Closing the windows one by one makes Chromium restore only the window closed last."""
    def saved():
        preferences = json.loads((pathlib.Path.home() / ".config/chromium/Default/Preferences").read_text())
        return preferences.get("profile", {}).get("exit_type") in ("SessionEnded", "Normal")
    return quit_from_global_menu(session, checks, CHROMIUM, "Chromium", r"^/usr/lib/chromium/chromium( |$)", saved)


@test
def global_menu_quit_firefox(session, checks, out_dir):
    """Quit in the menu of Firefox's name ends Firefox so that its next start restores all its windows: GNOME Shell
    sends SIGTERM to Firefox, with patches/gnome-shell/quit-with-sigterm.patch, which Firefox handles with
    patches/firefox/sigterm-handler-after-app-shell.patch. Closing the windows one by one makes Firefox restore at most
    browser.sessionstore.max_windows_undo of them, 5 by default."""
    return quit_from_global_menu(session, checks, FIREFOX, "Firefox", r"^/usr/lib/firefox/firefox( |$)",
                                 firefox_session_saved)


@test
def global_menu_quit_window_backed(session, checks, out_dir):
    """Quit in the menu of the name of a window-backed application, one which GNOME Shell matched to no desktop file,
    closes its window and sends its process no SIGTERM, with patches/gnome-shell/quit-with-sigterm.patch, as the
    process of such a window can be a proxy, such as ssh for windows forwarded with ssh -X. The GTK 3 test window has no
    desktop file and exports no quit action."""
    install_global_menu(session)
    log = out_dir / "menuapp-gtk3.log"
    session.login()
    session.call("spawnCommandLine", f"python3 {APPS_DIR}/menuapp.py gtk3 {log}")
    window = shown_window(session, None, lambda w: w["title"] == "menu-test-gtk3", 30)
    checks.check("the window opened, of a window-backed application", bool(window) and window["app"].startswith("window:"),
                 str(window))
    if not window:
        return {}
    process = r"menuapp\.py gtk3"
    title = wait_menu(session, lambda s: s["shown"] and s["titles"][1:] == ["File", "Edit", "View"], 30)["titles"][0]
    click_path(session, [title, "Quit"])
    gone = wait_for(lambda: not find(session.windows(), lambda w: w["id"] == window["id"]) and not processes(process), 15)
    events = [e for e in read_events(log) if e["event"] in ("close", "signal")]
    checks.check("Quit ends the application", gone, str(events))
    checks.check("Quit closes the window and sends no SIGTERM", events == [{"event": "close", "value": True}], str(events))
    session.logout()
    return {"events": events}


def registrar_owner(session):
    """Returns the owner of com.canonical.AppMenu.Registrar, or None."""
    try:
        reply = session.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
                                      GLib.Variant("(s)", ("com.canonical.AppMenu.Registrar",)), GLib.VariantType("(s)"),
                                      Gio.DBusCallFlags.NONE, 5000, None)
    except GLib.Error:
        return None
    return reply.unpack()[0]


@test
def global_menu_lock(session, checks, out_dir):
    """Locking the screen hides the global menu, and GTK windows keep their menu bars hidden meanwhile, since the
    extension stays enabled on the lock screen, so that the windows do not change their layouts twice. Disabling the
    extension gives the menu bars back to GTK windows, and global-menu-registrar gives up its name."""
    install_global_menu(session)
    log = out_dir / "menuapp-gtk4.log"
    session.login()
    session.call("spawnCommandLine", f"python3 {APPS_DIR}/menuapp.py gtk4 {log}")
    shown_window(session, None, lambda w: w["title"] == "menu-test-gtk4", 30)
    check_menu_titles(session, checks, "gtk4", ["File", "Edit", "View"])

    def hidden_events():
        return [e["value"] for e in read_events(log) if e["event"] == "menubar-hidden"]

    session.call("lock")
    checks.check("the screen is locked", wait_for(lambda: session.call("locked"), 5))
    state = wait_menu(session, lambda s: not s["shown"])
    checks.check("the global menu is hidden while the screen is locked", not state["shown"], str(state))
    session.call("unlock")
    state = wait_menu(session, lambda s: s["shown"] and s["titles"][1:] == ["File", "Edit", "View"])
    checks.check("the global menu returns after unlocking", state["shown"] and state["titles"][1:] == ["File", "Edit", "View"],
                 str(state))
    checks.check("the window kept its menu bar hidden through the lock",
                 bool(hidden_events()) and all(hidden_events()), str(hidden_events()))

    session.gsettings("org.gnome.shell", "enabled-extensions", f"['{TEST_EXTENSION}']")
    checks.check("disabling the extension shows the window's menu bar again",
                 wait_for(lambda: hidden_events()[-1:] == [False], 10), str(hidden_events()))
    checks.check("disabling the extension makes global-menu-registrar give up its name",
                 wait_for(lambda: registrar_owner(session) is None, 10), str(registrar_owner(session)))
    session.logout()
    return {"menubar_hidden": hidden_events()}


EXTRA_MENUS = [f"Extra {letter}" for letter in "GHIJKLMNOPQRSU"]


@test
def global_menu_overflow(session, checks, out_dir):
    """A window with more menus than fit into the top bar, the test window of apps/menuapp.py with 14 further menus.
    The menus which fit keep their full width, and the others are submenus of the overflow button. Alt with the mnemonic
    of such a menu opens its submenu there, and its item acts when clicked. When the top bar has less space, as with an
    actor of 300 pixels added before the menus, more menus move into the overflow button, and back when it is gone."""
    install_global_menu(session)
    log = out_dir / "menuapp-gtk4.log"
    session.login()
    session.call("spawnCommandLine", f"env MENUAPP_EXTRA_MENUS={len(EXTRA_MENUS)} python3 {APPS_DIR}/menuapp.py gtk4 {log}")
    window = shown_window(session, None, lambda w: w["title"] == "menu-test-gtk4", 30)
    checks.check("the window opened", bool(window), str(window_summary(window)))

    titles = ["File", "Edit", "View", *EXTRA_MENUS]
    # Right after the buttons are created, the menus which fit are counted only at the next layout of the top bar.
    state = wait_menu(session, lambda s: s["titles"][1:] == titles and 0 < len(s["overflowed"]) < len(titles), 30)
    overflowed = state["overflowed"]
    checks.check("the menus which do not fit are the last ones, in the overflow button",
                 bool(overflowed) and len(overflowed) < len(titles) and overflowed == titles[len(titles) - len(overflowed):],
                 str(state))
    check_menu_keys(session, checks, "overflow", titles, "f")

    last = overflowed[-1]
    letter = last[-1]
    session.press(letter.lower(), "Alt_L")
    state = wait_menu(session, lambda s: menu_open(s, last) and s["focus"] == f"Item {letter}")
    checks.check(f"Alt+{letter} opens {last} in the overflow button with the keyboard focus on its item",
                 menu_open(state, last) and state["focus"] == f"Item {letter}", str(state))
    session.press("Escape")
    wait_menu(session, lambda s: s["open"] is None)

    def activated():
        return [e["value"] for e in read_events(log) if e["event"] == "activate"]

    click_path(session, [last, f"Item {letter}"])
    checks.check(f"clicking {last}, Item {letter} in the overflow button activates the item",
                 wait_for(lambda: f"Item _{letter}" in activated(), 5), str(activated()))

    session.eval("(() => { global._spacer = new imports.gi.St.Widget({width: 300}); "
                 "Main.panel._leftBox.insert_child_at_index(global._spacer, 0); return 1; })()")
    narrower = wait_menu(session, lambda s: len(s["overflowed"]) > len(overflowed))
    checks.check("with less space in the top bar, more menus move into the overflow button",
                 len(narrower["overflowed"]) > len(overflowed), f"{narrower['overflowed']}, was {overflowed}")
    session.eval("(() => { global._spacer.destroy(); return 1; })()")
    wider = wait_menu(session, lambda s: s["overflowed"] == overflowed)
    checks.check("with the space back, the same menus fit again", wider["overflowed"] == overflowed,
                 f"{wider['overflowed']}, was {overflowed}")
    session.logout()
    return {"overflowed": overflowed, "narrower": narrower["overflowed"]}


def main():
    name, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
    if name not in TESTS:
        print(f"unknown test {name}, known are {', '.join(TESTS)}", file=sys.stderr)
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)
    checks = Checks(name, out_dir)
    session = Session(out_dir)
    skipped = session.apply_desktop_settings()
    (out_dir / "settings-skipped.txt").write_text("".join(f"{key}\n" for key in skipped))
    session.enable_extensions(TEST_EXTENSION)
    extra = {}
    try:
        extra = TESTS[name](session, checks, out_dir) or {}
    except Exception as error:  # noqa: BLE001 - any failure of the test is reported as one
        checks.check("test ran to its end", False, f"{type(error).__name__}: {error}")
    # Neither the session nor logging out of it may leave a unit failed, as at-spi-dbus-bus.service did at a logout.
    failed = session.failed_units()
    checks.check("no unit of the user's service manager failed", not failed, str(failed))
    return checks.finish(**extra)


sys.exit(main())
